import type { KdfParams } from "@pm/crypto";
import { createAccountHandlers } from "./handlers/account.ts";
import { createVaultHandlers } from "./handlers/vault.ts";
import type { Handlers, OpMap } from "./protocol.ts";
import type { WorkerState } from "./state.ts";

export interface HandlerOptions {
  /**
   * KDF parameters for new key material and the target of KDF upgrades. Defaults to the
   * `@pm/crypto` defaults (Argon2id 64 MiB, 3 passes). Tests inject the minimum parameters.
   */
  kdf?: KdfParams;
}

export type AllHandlers = Handlers<OpMap>;

/** All operations of the worker. New op groups are spread in here. */
export function createHandlers(state: WorkerState, options: HandlerOptions = {}): AllHandlers {
  return {
    ...createAccountHandlers(state, options),
    ...createVaultHandlers(state, options),
  };
}
