/**
 * Vault, item and share operations of the crypto worker.
 *
 * The vault UI work adds entries here (argument and result types only), implements them in
 * `handlers/vault.ts`, and the UI calls them with `cryptoClient.call("opName", args)`.
 * Example:
 *
 *   import type { Op } from "./protocol.ts";
 *   export type VaultOpMap = {
 *     decryptItem: Op<{ item: StoredItemWire }, { content: ItemContent }>;
 *   };
 *
 * Rules: arguments and results must be structured-cloneable, and a result must never contain
 * a key (account key, private key, vault key, item key).
 */
export type VaultOpMap = Record<never, never>;
