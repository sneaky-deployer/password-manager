import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cryptoCall } from "../../test/fake-crypto.ts";
import { ENVELOPE, makeUser } from "../../test/fixtures.ts";
import { mockApi } from "../../test/mock-api.ts";
import { renderApp } from "../../test/render-app.tsx";
import {
  emptySyncResponse,
  ITEM_1,
  itemView,
  itemWire,
  loginContent,
  memberWire,
  mockVaultWorld,
  VAULT_A,
  VAULT_B,
  vaultView,
  vaultWire,
} from "../../test/vault-fixtures.ts";

vi.mock("../../crypto-worker/client.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../crypto-worker/client.ts")>();
  const { fakeCryptoClient } = await import("../../test/fake-crypto.ts");
  return { ...actual, cryptoClient: fakeCryptoClient() };
});

beforeEach(() => cryptoCall.mockReset());
afterEach(() => vi.unstubAllGlobals());

const base = {
  "GET /api/me": () => ({ user: makeUser() }),
  "GET /api/sync": () => emptySyncResponse(),
  "GET /api/shares/pending": () => ({ shares: [] }),
};

describe("vault management", () => {
  it("creates a vault from the sidebar with an encrypted body", async () => {
    const newId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const api = mockApi({
      ...base,
      "POST /api/vaults": () => ({
        vault: vaultWire({ id: newId }),
        member: memberWire({ role: "owner" }),
      }),
    });
    mockVaultWorld({
      vaults: [vaultView()],
      items: [],
      ops: {
        createVault: () => ({
          vaultId: newId,
          body: { id: newId, keyVersion: 1, encryptedMeta: ENVELOPE, sealedKey: "S".repeat(100) },
        }),
      },
    });
    const user = userEvent.setup();
    const { router } = renderApp("/vault", { locked: false });
    await user.click(await screen.findByRole("button", { name: "+ New vault" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Create vault" }));
    expect(await within(dialog).findByText("Give the vault a name.")).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText(/^Name/), "Family");
    await user.click(within(dialog).getByRole("radio", { name: "teal" }));
    await user.click(within(dialog).getByRole("button", { name: "Create vault" }));

    await waitFor(() => expect(api.called("POST", "/api/vaults")).toHaveLength(1));
    expect(cryptoCall).toHaveBeenCalledWith("createVault", {
      meta: { name: "Family", color: "teal" },
    });
    expect(api.called("POST", "/api/vaults")[0]?.body).toMatchObject({ id: newId, keyVersion: 1 });
    await waitFor(() => expect(router.state.location.pathname).toBe(`/vault/v/${newId}`));
  });

  it("renames a vault as owner and hides rename and delete from editors", async () => {
    const api = mockApi({
      ...base,
      [`PATCH /api/vaults/${VAULT_A}`]: () => ({ vault: vaultWire() }),
    });
    mockVaultWorld({
      vaults: [vaultView()],
      items: [],
      ops: { updateVaultMeta: () => ({ body: { keyVersion: 1, encryptedMeta: ENVELOPE } }) },
    });
    const user = userEvent.setup();
    renderApp(`/vault/v/${VAULT_A}`, { locked: false });
    await screen.findByRole("heading", { name: "Personal" });
    await user.click(screen.getByRole("button", { name: "Vault menu" }));
    await user.click(screen.getByRole("menuitem", { name: "Rename…" }));
    const dialog = await screen.findByRole("dialog");
    const name = within(dialog).getByLabelText(/^Name/);
    await user.clear(name);
    await user.type(name, "Home");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.called("PATCH", `/api/vaults/${VAULT_A}`)).toHaveLength(1));
    expect(cryptoCall).toHaveBeenCalledWith("updateVaultMeta", {
      vaultId: VAULT_A,
      meta: { name: "Home", color: "violet" },
    });
  });

  it("deletes a vault only after confirming", async () => {
    const api = mockApi({ ...base, [`DELETE /api/vaults/${VAULT_A}`]: () => ({ ok: true }) });
    mockVaultWorld({ vaults: [vaultView({ memberCount: 3 })], items: [] });
    const user = userEvent.setup();
    const { router } = renderApp(`/vault/v/${VAULT_A}`, { locked: false });
    await screen.findByRole("heading", { name: "Personal" });
    await user.click(screen.getByRole("button", { name: "Vault menu" }));
    await user.click(screen.getByRole("menuitem", { name: "Delete vault…" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/deleted for every member/)).toBeInTheDocument();
    expect(api.called("DELETE", `/api/vaults/${VAULT_A}`)).toHaveLength(0);
    await user.click(within(dialog).getByRole("button", { name: "Delete vault" }));
    await waitFor(() => expect(api.called("DELETE", `/api/vaults/${VAULT_A}`)).toHaveLength(1));
    await waitFor(() => expect(router.state.location.pathname).toBe("/vault"));
  });

  it("lets a non-owner leave but not rename or delete", async () => {
    const api = mockApi({ ...base, [`POST /api/vaults/${VAULT_B}/leave`]: () => ({ ok: true }) });
    mockVaultWorld({
      vaults: [
        vaultView({ id: VAULT_B, name: "Work", myRole: "editor", isOwner: false, memberCount: 2 }),
      ],
      items: [],
    });
    const user = userEvent.setup();
    renderApp(`/vault/v/${VAULT_B}`, { locked: false });
    await screen.findByRole("heading", { name: "Work" });
    await user.click(screen.getByRole("button", { name: "Vault menu" }));
    expect(screen.queryByRole("menuitem", { name: "Rename…" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Delete vault…" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("menuitem", { name: "Leave vault…" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Leave vault" }));
    await waitFor(() => expect(api.called("POST", `/api/vaults/${VAULT_B}/leave`)).toHaveLength(1));
  });

  it("moves an item to another vault", async () => {
    const api = mockApi({
      ...base,
      [`POST /api/items/${ITEM_1}/move`]: () => ({ item: itemWire({ vaultId: VAULT_B }) }),
    });
    mockVaultWorld({
      vaults: [
        vaultView(),
        vaultView({ id: VAULT_B, name: "Work", myRole: "editor", isOwner: false }),
      ],
      items: [itemView()],
      contents: { [ITEM_1]: loginContent() },
      ops: {
        moveItem: () => ({
          body: { targetVaultId: VAULT_B, wrappedKey: ENVELOPE, vaultKeyVersion: 1, revision: 1 },
        }),
      },
    });
    const user = userEvent.setup();
    renderApp(`/vault?item=${ITEM_1}`, { locked: false });
    await user.click(await screen.findByRole("button", { name: "Move" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("option", { name: /Work/ })).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Move" }));
    await waitFor(() => expect(api.called("POST", `/api/items/${ITEM_1}/move`)).toHaveLength(1));
    expect(cryptoCall).toHaveBeenCalledWith("moveItem", { id: ITEM_1, targetVaultId: VAULT_B });
  });

  it("does not offer Move for an item that is shared with people", async () => {
    mockApi(base);
    mockVaultWorld({
      vaults: [vaultView(), vaultView({ id: VAULT_B, name: "Work" })],
      items: [itemView({ shareCount: 1 })],
      contents: { [ITEM_1]: loginContent() },
    });
    renderApp(`/vault?item=${ITEM_1}`, { locked: false });
    expect(await screen.findByRole("button", { name: "Move" })).toBeDisabled();
  });
});
