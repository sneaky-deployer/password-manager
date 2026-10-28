import { useQueryClient } from "@tanstack/react-query";
import { Link, useSearch } from "@tanstack/react-router";
import { useState } from "react";
import { Alert, Button, EmptyState, Input, Select, Spinner } from "../../components/ui/index.ts";
import { cn } from "../../lib/cn.ts";
import { RotationBanner } from "../sharing/ShareVaultDialog.tsx";
import { emptyTrashAction } from "./actions.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { describeVaultError } from "./errors.ts";
import type { ItemScope, ItemSort, TypeFilter } from "./filters.ts";
import { useItems, useVaults } from "./hooks.ts";
import { ItemDetail } from "./ItemDetail.tsx";
import { ItemEditor } from "./ItemEditor.tsx";
import { ItemList } from "./ItemList.tsx";
import { useVaultState } from "./sync.ts";
import { VaultHeader } from "./VaultHeader.tsx";
import { useWorkspaceNavigate, validateWorkspaceSearch, WorkspaceLink } from "./workspace-nav.tsx";

const TITLES: Record<string, string> = {
  all: "All items",
  shared: "Shared with me",
  trash: "Trash",
};

const EMPTY_TEXT: Record<string, string> = {
  all: "Create your first login or secure note.",
  vault: "This vault has no items yet.",
  shared:
    "Items other people share with you individually appear here. Vaults shared with you are listed in the sidebar.",
  trash: "Deleted items stay here for 30 days and can be restored.",
};

/** The item list plus the detail / editor pane for one scope (all items, a vault, shared, trash). */
export function Workspace({ scope }: { scope: ItemScope }) {
  const search = validateWorkspaceSearch(useSearch({ strict: false }) as Record<string, unknown>);
  const navigateSearch = useWorkspaceNavigate();
  const queryClient = useQueryClient();
  const state = useVaultState();
  const { vaults } = useVaults();

  const [query, setQuery] = useState("");
  const [type, setType] = useState<TypeFilter>("all");
  const [sort, setSort] = useState<ItemSort>("name");
  const [emptying, setEmptying] = useState(false);

  const { items, all } = useItems({ scope, search: query, type, sort });
  const vault = scope.kind === "vault" ? vaults.find((v) => v.id === scope.vaultId) : undefined;

  const detailOpen = Boolean(search.item) || search.mode === "new";
  const scopeEmpty = useItems({ scope }).items.length === 0;
  const trashedMine = all.filter((item) => item.trashed && item.canManage);

  if (state.isPending) {
    return (
      <div className="flex justify-center py-16">
        <Spinner label="Loading your vault" className="size-8" />
      </div>
    );
  }
  if (state.isError && !state.data) {
    return (
      <Alert variant="error" title="Could not load your vault">
        {describeVaultError(state.error)}
        <div className="mt-3">
          <Button variant="secondary" onClick={() => void state.refetch()}>
            Try again
          </Button>
        </div>
      </Alert>
    );
  }
  if (scope.kind === "vault" && !vault) {
    return (
      <EmptyState
        title="Vault not found"
        action={
          <Link
            to="/vault"
            search={{}}
            className="text-brand-700 hover:underline dark:text-brand-300"
          >
            Back to all items
          </Link>
        }
      >
        It was deleted, or you no longer have access to it.
      </EmptyState>
    );
  }

  const canCreate = scope.kind === "all" || (scope.kind === "vault" && vault?.myRole !== "viewer");

  return (
    <div className="space-y-4">
      {scope.kind === "vault" && vault ? (
        <VaultHeader vault={vault} />
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold">{TITLES[scope.kind]}</h1>
          {scope.kind === "trash" && trashedMine.length > 0 ? (
            <div className="ml-auto">
              <Button variant="danger" onClick={() => setEmptying(true)}>
                Empty trash
              </Button>
            </div>
          ) : null}
        </div>
      )}

      {state.isError ? (
        <Alert variant="warning">
          Could not refresh from the server. Showing what was synced last.{" "}
          <button type="button" className="underline" onClick={() => void state.refetch()}>
            Try again
          </button>
        </Alert>
      ) : null}
      {scope.kind === "vault" && vault ? <RotationBanner vault={vault} /> : null}
      {scope.kind === "all"
        ? vaults
            .filter((v) => v.rotationPending)
            .map((v) => <RotationBanner key={v.id} vault={v} />)
        : null}

      <div className="grid gap-4 lg:grid-cols-[minmax(18rem,26rem)_minmax(0,1fr)]">
        <section aria-label="Item list" className={cn("min-w-0", detailOpen && "hidden lg:block")}>
          <div className="space-y-2 pb-3">
            <div className="flex gap-2">
              <Input
                type="search"
                aria-label="Search items"
                placeholder="Search name, username or website"
                autoComplete="off"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              {canCreate ? (
                <WorkspaceLink
                  search={{ mode: "new" }}
                  className="inline-flex h-10 shrink-0 items-center rounded-lg bg-brand-600 px-4 text-sm font-medium text-white hover:bg-brand-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
                >
                  New item
                </WorkspaceLink>
              ) : null}
            </div>
            <div className="flex gap-2">
              <Select
                aria-label="Filter by type"
                value={type}
                onChange={(event) => setType(event.target.value as TypeFilter)}
              >
                <option value="all">All types</option>
                <option value="login">Logins</option>
                <option value="note">Secure notes</option>
              </Select>
              <Select
                aria-label="Sort by"
                value={sort}
                onChange={(event) => setSort(event.target.value as ItemSort)}
              >
                <option value="name">Name</option>
                <option value="updated">Recently updated</option>
              </Select>
            </div>
          </div>

          {items.length === 0 ? (
            scopeEmpty ? (
              <EmptyState
                title={scope.kind === "trash" ? "Trash is empty" : "No items yet"}
                action={
                  canCreate ? (
                    <WorkspaceLink
                      search={{ mode: "new" }}
                      className="inline-flex h-10 items-center rounded-lg bg-brand-600 px-4 text-sm font-medium text-white hover:bg-brand-700"
                    >
                      Create an item
                    </WorkspaceLink>
                  ) : undefined
                }
              >
                {EMPTY_TEXT[scope.kind]}
              </EmptyState>
            ) : (
              <EmptyState title="No matches">
                Nothing matches your search or filter. Try fewer words or clear the filter.
              </EmptyState>
            )
          ) : (
            <div className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
              <ItemList
                items={items}
                selectedId={search.item}
                vaults={vaults}
                showVault={scope.kind !== "vault" && vaults.length > 1}
              />
            </div>
          )}
        </section>

        <section
          aria-label="Item details"
          className={cn(
            "min-w-0 rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900",
            !detailOpen && "hidden lg:block",
          )}
        >
          {search.mode === "new" ? (
            <ItemEditor
              mode="create"
              defaultVaultId={scope.kind === "vault" ? scope.vaultId : undefined}
              onDone={(id) => void navigateSearch({ item: id })}
              onCancel={() => void navigateSearch({})}
            />
          ) : search.item && search.mode === "edit" ? (
            <ItemEditor
              mode="edit"
              itemId={search.item}
              onDone={(id) => void navigateSearch({ item: id })}
              onCancel={() => void navigateSearch({ item: search.item as string })}
            />
          ) : search.item ? (
            <ItemDetail itemId={search.item} onGone={() => void navigateSearch({})} />
          ) : (
            <EmptyState title="Select an item">
              Pick an item from the list to see its details, or create a new one.
            </EmptyState>
          )}
        </section>
      </div>

      <ConfirmDialog
        open={emptying}
        title="Empty the trash?"
        description={`${trashedMine.length} ${trashedMine.length === 1 ? "item is" : "items are"} deleted permanently. This cannot be undone.`}
        confirmLabel="Empty trash"
        danger
        onClose={() => setEmptying(false)}
        onConfirm={async () => {
          const failed = await emptyTrashAction(
            queryClient,
            trashedMine.map((item) => item.id),
          );
          if (failed > 0) throw new Error(`${failed} could not be deleted`);
        }}
      />
    </div>
  );
}
