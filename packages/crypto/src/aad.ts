/**
 * Associated-data strings, defined once. Exact format is part of the on-disk contract
 * (PLAN.md 9.4). Never change a `v1` string; add a `v2` function and keep the old one.
 */

function part(name: string, value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes(":")) {
    throw new TypeError(`Invalid AAD component ${name}`);
  }
  return value;
}

function version(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`Invalid AAD component ${name}`);
  }
  return value;
}

export const aad = {
  /** Account key wrapped with the password-derived wrapKey. */
  akPw: (userId: string): string => `pm:v1:ak:pw:${part("userId", userId)}`,
  /** Account key wrapped with the recovery-phrase-derived wrapKey. */
  akRec: (userId: string): string => `pm:v1:ak:rec:${part("userId", userId)}`,
  /** Identity private key encrypted with the account key. */
  privateKey: (userId: string): string => `pm:v1:privkey:${part("userId", userId)}`,
  /** Vault metadata encrypted with the vault key. */
  vaultMeta: (vaultId: string, keyVersion: number): string =>
    `pm:v1:vaultmeta:${part("vaultId", vaultId)}:${version("keyVersion", keyVersion)}`,
  /** Item key wrapped with the vault key. */
  itemKey: (vaultId: string, itemId: string, vaultKeyVersion: number): string =>
    `pm:v1:itemkey:${part("vaultId", vaultId)}:${part("itemId", itemId)}:${version("vaultKeyVersion", vaultKeyVersion)}`,
  /** Item content encrypted with the item key. */
  item: (itemId: string, itemKeyVersion: number): string =>
    `pm:v1:item:${part("itemId", itemId)}:${version("itemKeyVersion", itemKeyVersion)}`,
} as const;
