import type { ItemListView, VaultView } from "../../crypto-worker/vault-protocol.ts";

export type ItemScope =
  | { kind: "all" }
  | { kind: "vault"; vaultId: string }
  | { kind: "shared" }
  | { kind: "trash" };

export type ItemSort = "name" | "updated";
export type TypeFilter = "all" | "login" | "note";

export interface ItemFilter {
  scope: ItemScope;
  search?: string;
  type?: TypeFilter;
  sort?: ItemSort;
}

/** Case-insensitive match on name, username and URLs. */
export function matchesSearch(item: ItemListView, search: string): boolean {
  const query = search.trim().toLowerCase();
  if (!query) return true;
  if (item.name.toLowerCase().includes(query)) return true;
  if (item.username?.toLowerCase().includes(query)) return true;
  return item.urls.some((url) => url.toLowerCase().includes(query));
}

export function inScope(item: ItemListView, scope: ItemScope): boolean {
  switch (scope.kind) {
    case "trash":
      return item.trashed;
    case "all":
      return !item.trashed;
    case "shared":
      return !item.trashed && item.sharedWithMe;
    case "vault":
      return !item.trashed && !item.sharedWithMe && item.vaultId === scope.vaultId;
  }
}

/** Pure filter + sort used by `useItems`; instant, in memory. */
export function filterItems(items: ItemListView[], filter: ItemFilter): ItemListView[] {
  const { scope, search = "", type = "all", sort = "name" } = filter;
  const result = items.filter(
    (item) =>
      inScope(item, scope) && (type === "all" || item.type === type) && matchesSearch(item, search),
  );
  if (sort === "updated") return result.sort((a, b) => b.updatedAt - a.updatedAt);
  return result.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

export function writableVaults(vaults: VaultView[]): VaultView[] {
  return vaults.filter((vault) => vault.myRole !== "viewer" && !vault.rotationPending);
}
