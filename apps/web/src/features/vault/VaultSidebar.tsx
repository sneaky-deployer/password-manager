/**
 * Sidebar slot of the app shell. The vault UI work replaces this placeholder with the vault
 * list, "Shared with me", Generator and Trash links.
 */
export function VaultSidebar() {
  return (
    <nav aria-label="Vaults" className="p-4 text-sm text-slate-600 dark:text-slate-400">
      <p className="font-medium text-slate-900 dark:text-slate-100">Vaults</p>
      <p className="mt-1">The vault list appears here.</p>
    </nav>
  );
}
