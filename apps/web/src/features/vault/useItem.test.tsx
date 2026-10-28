import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ItemDetailView } from "../../crypto-worker/vault-protocol.ts";
import { cryptoCall } from "../../test/fake-crypto.ts";
import { ITEM_1, ITEM_2, itemView, loginContent } from "../../test/vault-fixtures.ts";
import { useItem } from "./hooks.ts";
import { VAULT_STATE_KEY, type VaultState } from "./sync.ts";

vi.mock("../../crypto-worker/client.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../crypto-worker/client.ts")>();
  const { fakeCryptoClient } = await import("../../test/fake-crypto.ts");
  return { ...actual, cryptoClient: fakeCryptoClient() };
});

function state(items: ReturnType<typeof itemView>[]): VaultState {
  return { vaults: [], items, members: [], itemShares: [], serverTime: Date.now() };
}

function detail(name: string, revision: number): ItemDetailView {
  const item = itemView({ name, revision });
  return {
    item,
    content: loginContent({ name }),
    itemKeyVersion: 1,
    vaultKeyVersion: 1,
  };
}

function setup(initial: VaultState) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(VAULT_STATE_KEY, initial);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { queryClient, wrapper };
}

beforeEach(() => {
  cryptoCall.mockReset();
});

describe("useItem", () => {
  it("keeps the previous content on screen while a new revision of the same item loads", async () => {
    // Found by the Playwright suite: revoking an item share rotates the item key (new revision),
    // the detail pane swapped to a spinner and unmounted the open share dialog with its notice.
    const { queryClient, wrapper } = setup(state([itemView({ id: ITEM_1, revision: 1 })]));
    cryptoCall.mockImplementation(async () => detail("GitHub", 1));
    const { result } = renderHook(() => useItem(ITEM_1), { wrapper });
    await waitFor(() => expect(result.current.detail?.item.revision).toBe(1));
    expect(result.current.isLoading).toBe(false);

    let release: (value: ItemDetailView) => void = () => {};
    cryptoCall.mockImplementation(() => new Promise((resolve) => (release = resolve)));
    act(() => {
      queryClient.setQueryData(VAULT_STATE_KEY, state([itemView({ id: ITEM_1, revision: 2 })]));
    });

    // The refetch is pending, yet the old content is still there and nothing reports "loading".
    await waitFor(() => expect(cryptoCall).toHaveBeenCalledTimes(2));
    expect(result.current.isLoading).toBe(false);
    expect(result.current.detail?.item.revision).toBe(1);

    await act(async () => release(detail("GitHub", 2)));
    await waitFor(() => expect(result.current.detail?.item.revision).toBe(2));
  });

  it("never shows another item's content while a different item loads", async () => {
    const { queryClient, wrapper } = setup(
      state([itemView({ id: ITEM_1, name: "First" }), itemView({ id: ITEM_2, name: "Second" })]),
    );
    cryptoCall.mockImplementation(async () => detail("First", 1));
    const { result, rerender } = renderHook(({ id }) => useItem(id), {
      wrapper,
      initialProps: { id: ITEM_1 },
    });
    await waitFor(() => expect(result.current.detail?.content?.name).toBe("First"));

    cryptoCall.mockImplementation(() => new Promise(() => {}));
    rerender({ id: ITEM_2 });
    expect(result.current.detail).toBeUndefined();
    expect(result.current.isLoading).toBe(true);
    queryClient.clear();
  });
});
