import { Link, Outlet } from "@tanstack/react-router";
import { Alert } from "../../components/ui/index.ts";

const TABS = [
  { to: "/admin/invites", label: "Invites" },
  { to: "/admin/users", label: "Users" },
] as const;

export function AdminLayout() {
  return (
    <div className="mx-auto max-w-4xl">
      <h1 className="text-2xl font-semibold">Admin</h1>
      <Alert variant="info" className="mt-4">
        Admins manage invites and accounts, but can never read anyone's vaults, items, vault names
        or recovery phrases. Everything is encrypted in each user's browser.
      </Alert>
      <nav
        aria-label="Admin sections"
        className="mt-4 flex gap-1 border-b border-slate-200 dark:border-slate-800"
      >
        {TABS.map((tab) => (
          <Link
            key={tab.to}
            to={tab.to}
            className="-mb-px border-b-2 border-transparent px-3 py-2 text-sm font-medium text-slate-600 hover:text-slate-900 focus-visible:outline-2 focus-visible:outline-brand-600 dark:text-slate-400 dark:hover:text-slate-100"
            activeProps={{
              className:
                "border-brand-600 text-brand-700 dark:border-brand-400 dark:text-brand-300",
              "aria-current": "page",
            }}
          >
            {tab.label}
          </Link>
        ))}
      </nav>
      <div className="mt-6 space-y-6">
        <Outlet />
      </div>
    </div>
  );
}
