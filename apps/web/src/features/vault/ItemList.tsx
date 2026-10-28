import type { KeyboardEvent } from "react";
import { Badge } from "../../components/ui/index.ts";
import type { ItemListView, VaultView } from "../../crypto-worker/vault-protocol.ts";
import { cn } from "../../lib/cn.ts";
import { Avatar } from "./Avatar.tsx";
import { displayHost, vaultDotClass } from "./item-utils.ts";
import { WorkspaceLink } from "./workspace-nav.tsx";

interface ItemListProps {
  items: ItemListView[];
  selectedId: string | undefined;
  vaults: VaultView[];
  /** Show the vault of each row (useful in "All items"). */
  showVault: boolean;
}

/** Rows are links; ↑/↓ move between them and Enter opens the focused one. */
export function ItemList({ items, selectedId, vaults, showVault }: ItemListProps) {
  function onKeyDown(event: KeyboardEvent<HTMLUListElement>) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const rows = [...event.currentTarget.querySelectorAll<HTMLElement>("[data-item-row]")];
    if (rows.length === 0) return;
    const index = rows.indexOf(document.activeElement as HTMLElement);
    const next =
      event.key === "ArrowDown"
        ? rows[index < 0 ? 0 : Math.min(index + 1, rows.length - 1)]
        : rows[index < 0 ? rows.length - 1 : Math.max(index - 1, 0)];
    event.preventDefault();
    next?.focus();
  }

  return (
    <ul
      aria-label="Items"
      onKeyDown={onKeyDown}
      className="divide-y divide-slate-200 dark:divide-slate-800"
    >
      {items.map((item) => {
        const vault = showVault ? vaults.find((v) => v.id === item.vaultId) : undefined;
        const subtitle = item.username ?? (item.urls[0] ? displayHost(item.urls[0]) : "");
        return (
          <li key={item.id}>
            <WorkspaceLink
              search={{ item: item.id }}
              data-item-row=""
              aria-current={item.id === selectedId ? "true" : undefined}
              className={cn(
                "flex items-center gap-3 px-3 py-2.5 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand-600",
                item.id === selectedId
                  ? "bg-brand-50 dark:bg-brand-900/30"
                  : "hover:bg-slate-100 dark:hover:bg-slate-800/60",
              )}
            >
              <Avatar name={item.name} readable={item.readable} />
              <span className="min-w-0 flex-1">
                <span
                  className={cn("block truncate text-sm font-medium", !item.readable && "italic")}
                >
                  {item.name}
                </span>
                {subtitle ? (
                  <span className="block truncate text-xs text-slate-600 dark:text-slate-400">
                    {subtitle}
                  </span>
                ) : null}
              </span>
              {item.hasTotp ? (
                <Badge tone="brand">
                  TOTP<span className="sr-only"> one-time codes</span>
                </Badge>
              ) : null}
              {item.sharedWithMe ? (
                <Badge>
                  Shared<span className="sr-only"> with you</span>
                </Badge>
              ) : null}
              {vault ? (
                <span
                  title={vault.name}
                  className={cn("size-2.5 shrink-0 rounded-full", vaultDotClass(vault.color))}
                >
                  <span className="sr-only">{vault.name}</span>
                </span>
              ) : null}
            </WorkspaceLink>
          </li>
        );
      })}
    </ul>
  );
}
