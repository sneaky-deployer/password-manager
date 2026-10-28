import type { Handlers } from "../protocol.ts";
import type { HandlerOptions } from "../registry.ts";
import type { WorkerState } from "../state.ts";
import type { VaultOpMap } from "../vault-protocol.ts";

// vault/item/share ops are added here by the vault UI work.
//
// Pattern: declare each op's types in `../vault-protocol.ts`, then implement it below. Read the
// keys from `state` (`state.requireUnlocked()` throws a `locked` error when locked, and
// `state.vaultKeys` maps vaultId -> key version -> vault key). Never return a key to the UI.
export function createVaultHandlers(
  _state: WorkerState,
  _options: HandlerOptions = {},
): Handlers<VaultOpMap> {
  return {};
}
