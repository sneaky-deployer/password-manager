import { vi } from "vitest";

/** Replaces the crypto worker client in UI tests. Set per-op behaviour with `cryptoCall.mockImplementation`. */
export const cryptoCall = vi.fn(
  async (_op: string, _args?: unknown): Promise<unknown> => undefined,
);

export function fakeCryptoClient() {
  return {
    call: cryptoCall,
    onCrash: () => () => {},
    terminate: () => {},
  };
}

/** The ops (names only) called so far, in order. */
export function calledOps(): string[] {
  return cryptoCall.mock.calls.map((call) => String(call[0]));
}
