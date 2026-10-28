import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Badge, Button, Spinner } from "../../components/ui/index.ts";
import { cn } from "../../lib/cn.ts";
import { usePendingShares, useVaults } from "./hooks.ts";
import { ROLE_LABELS, vaultDotClass } from "./item-utils.ts";
import { useVaultState } from "./sync.ts";
import { VaultFormDialog } from "./VaultFormDialog.tsx";

const base =
  "flex items-center gap-2 rounded-lg px-3 py-2 text-slate-700 hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-brand-600 dark:text-slate-300 dark:hover:bg-slate-800";
const active = "bg-brand-50 font-medium text-brand-800 dark:bg-brand-900/40 dark:text-brand-200";

function Count({ value }: { value: number }) {
  return <span className="ml-auto text-xs text-slate-500 tabular-nums">{value}</span>;
}

/**
 * Sidebar of the app shell: All items, each vault, Shared with me, Trash, invitations and "New
 * vault". Mounting it also starts the vault sync (full on unlock, then on focus and every 60 s).
 */
export function VaultSidebar() {
  const { vaults, isLoading, isError } = useVaults();
  const state = useVaultState();
  const pending = usePendingShares();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);

  const items = state.data?.items ?? [];
  const count = (predicate: (item: (typeof items)[number]) => boolean) =>
    items.filter(predicate).length;
  const invitations = pending.data?.shares.length ?? 0;

  return (
    <nav aria-label="Vaults" className="flex flex-col gap-1 p-3 text-sm">
      <Link
        to="/vault"
        search={{}}
        activeOptions={{ exact: true, includeSearch: false }}
        className={base}
        activeProps={{ className: active, "aria-current": "page" }}
      >
        All items
        <Count value={count((item) => !item.trashed)} />
      </Link>

      <p className="px-3 pt-4 text-xs font-semibold uppercase tracking-wide text-slate-500">
        Vaults
      </p>
      {isLoading ? (
        <div className="px-3 py-2">
          <Spinner label="Loading vaults" />
        </div>
      ) : null}
      {isError && !state.data ? (
        <p className="px-3 py-2 text-xs text-red-700 dark:text-red-400">
          Could not load your vaults.{" "}
          <button type="button" className="underline" onClick={() => void state.refetch()}>
            Retry
          </button>
        </p>
      ) : null}
      {vaults.map((vault) => {
        const shared = !vault.isOwner || vault.memberCount + vault.pendingMemberCount > 1;
        return (
          <Link
            key={vault.id}
            to="/vault/v/$vaultId"
            params={{ vaultId: vault.id }}
            search={{}}
            activeOptions={{ includeSearch: false }}
            className={base}
            activeProps={{ className: active, "aria-current": "page" }}
          >
            <span
              aria-hidden="true"
              className={cn("size-2.5 shrink-0 rounded-full", vaultDotClass(vault.color))}
            />
            <span className="min-w-0 flex-1 truncate">{vault.name}</span>
            {shared ? (
              <span title="Shared" className="text-xs text-slate-500">
                <svg
                  aria-hidden="true"
                  viewBox="0 0 24 24"
                  className="size-3.5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                >
                  <circle cx="9" cy="8" r="3" />
                  <path d="M3 20a6 6 0 0 1 12 0M16 11a3 3 0 1 0 0-6M21 20a6 6 0 0 0-4-5.6" />
                </svg>
                <span className="sr-only">Shared</span>
              </span>
            ) : null}
            {!vault.isOwner ? <Badge>{ROLE_LABELS[vault.myRole]}</Badge> : null}
            {vault.rotationPending ? <Badge tone="warning">Paused</Badge> : null}
          </Link>
        );
      })}

      <Link
        to="/vault/shared"
        search={{}}
        activeOptions={{ includeSearch: false }}
        className={cn(base, "mt-2")}
        activeProps={{ className: active, "aria-current": "page" }}
      >
        Shared with me
        <Count value={count((item) => item.sharedWithMe && !item.trashed)} />
      </Link>
      <Link
        to="/vault/trash"
        search={{}}
        activeOptions={{ includeSearch: false }}
        className={base}
        activeProps={{ className: active, "aria-current": "page" }}
      >
        Trash
        <Count value={count((item) => item.trashed)} />
      </Link>
      <Link
        to="/vault/invitations"
        activeOptions={{ includeSearch: false }}
        className={base}
        activeProps={{ className: active, "aria-current": "page" }}
      >
        Invitations
        {invitations > 0 ? (
          <span className="ml-auto">
            <Badge tone="brand">
              {invitations}
              <span className="sr-only"> pending</span>
            </Badge>
          </span>
        ) : null}
      </Link>

      <div className="pt-3">
        <Button variant="secondary" fullWidth onClick={() => setCreating(true)}>
          + New vault
        </Button>
      </div>
      <VaultFormDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(vaultId) =>
          void navigate({ to: "/vault/v/$vaultId", params: { vaultId }, search: {} })
        }
      />
    </nav>
  );
}
