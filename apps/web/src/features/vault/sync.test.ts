import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cryptoCall } from "../../test/fake-crypto.ts";
import { mockApi } from "../../test/mock-api.ts";
import { emptySyncResponse, itemView, vaultView } from "../../test/vault-fixtures.ts";
import { runSync, syncNow, VAULT_STATE_KEY, type VaultState } from "./sync.ts";

vi.mock("../../crypto-worker/client.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../crypto-worker/client.ts")>();
  const { fakeCryptoClient } = await import("../../test/fake-crypto.ts");
  return { ...actual, cryptoClient: fakeCryptoClient() };
});

beforeEach(() => {
  cryptoCall.mockReset();
  cryptoCall.mockImplementation(async (op: string) =>
    op === "applySync"
      ? { vaults: [vaultView()], items: [itemView()], members: [], itemShares: [] }
      : undefined,
  );
});

describe("vault sync", () => {
  it("does a full sync first, then sends the server time as `since`", async () => {
    let time = 1000;
    const api = mockApi({
      "GET /api/sync": () => {
        time += 500;
        return emptySyncResponse(time);
      },
    });
    const qc = new QueryClient();
    const first = await runSync(qc);
    expect(api.calls[0]?.query).toEqual({});
    expect(first.serverTime).toBe(1500);
    expect(first.items).toHaveLength(1);
    expect(qc.getQueryData<VaultState>(VAULT_STATE_KEY)?.serverTime).toBe(1500);

    await runSync(qc);
    expect(api.calls[1]?.query).toEqual({ since: "1500" });
    expect(cryptoCall.mock.calls.filter((c) => c[0] === "applySync")).toHaveLength(2);
  });

  it("starts over with a full sync after the cache was dropped (lock)", async () => {
    const api = mockApi({ "GET /api/sync": () => emptySyncResponse(5000) });
    const qc = new QueryClient();
    await runSync(qc);
    qc.removeQueries({ queryKey: VAULT_STATE_KEY });
    await runSync(qc);
    expect(api.calls[1]?.query).toEqual({});
  });

  it("joins a running sync, and queues exactly one more for a sync after a write", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let n = 0;
    const api = mockApi({
      "GET /api/sync": async () => {
        n += 1;
        if (n === 1) await gate;
        return emptySyncResponse(1000 + n);
      },
    });
    const qc = new QueryClient();
    const a = runSync(qc);
    const b = runSync(qc); // joins a
    const c = syncNow(qc); // must start after the write that came after a started
    const d = syncNow(qc); // shares c
    await Promise.resolve();
    expect(api.calls).toHaveLength(1);
    release();
    const [ra, rb, rc, rd] = await Promise.all([a, b, c, d]);
    expect(ra).toBe(rb);
    expect(rc).toBe(rd);
    expect(api.calls).toHaveLength(2);
    expect(api.calls[1]?.query).toEqual({ since: "1001" });
  });

  it("surfaces a failed sync and recovers on the next one", async () => {
    let fail = true;
    mockApi({
      "GET /api/sync": () =>
        fail
          ? Response.json({ error: { code: "internal_error", message: "x" } }, { status: 500 })
          : emptySyncResponse(),
    });
    const qc = new QueryClient();
    await expect(runSync(qc)).rejects.toMatchObject({ status: 500 });
    fail = false;
    await expect(runSync(qc)).resolves.toMatchObject({ serverTime: 1000 });
  });
});
