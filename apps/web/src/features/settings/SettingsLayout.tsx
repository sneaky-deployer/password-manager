import { Link, Outlet } from "@tanstack/react-router";

const TABS = [
  { to: "/settings/security", label: "Security" },
  { to: "/settings/sessions", label: "Sessions" },
  { to: "/settings/activity", label: "Activity" },
  { to: "/settings/preferences", label: "Preferences" },
  { to: "/settings/danger", label: "Danger zone" },
] as const;

export function SettingsLayout() {
  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-2xl font-semibold">Settings</h1>
      <nav
        aria-label="Settings sections"
        className="mt-4 flex gap-1 overflow-x-auto border-b border-slate-200 dark:border-slate-800"
      >
        {TABS.map((tab) => (
          <Link
            key={tab.to}
            to={tab.to}
            className="-mb-px whitespace-nowrap border-b-2 border-transparent px-3 py-2 text-sm font-medium text-slate-600 hover:text-slate-900 focus-visible:outline-2 focus-visible:outline-brand-600 dark:text-slate-400 dark:hover:text-slate-100"
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
