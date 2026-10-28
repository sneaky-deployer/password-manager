import { useQueryClient } from "@tanstack/react-query";
import { Link, Outlet, useNavigate, useRouter, useRouterState } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { Button, Menu, Spinner } from "../../components/ui/index.ts";
import { lockNow, logout, useAutoLock, useLockState, useSession } from "../../lib/session.ts";
import { LogoMark } from "../auth/AuthLayout.tsx";
import { VaultSidebar } from "../vault/VaultSidebar.tsx";

/**
 * Layout of every signed-in, unlocked page: header (lock, user menu), sidebar slot and the
 * main outlet. The sidebar is a drawer below the `lg` breakpoint.
 */
export function AppShell() {
  const { user, isAdmin } = useSession();
  const lockState = useLockState();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const router = useRouter();
  const location = useRouterState({ select: (s) => s.location });
  const [drawerOpen, setDrawerOpen] = useState(false);

  useAutoLock(user?.settings.autoLockMinutes);

  const hereRef = useRef(location.pathname + location.searchStr);
  hereRef.current = location.pathname + location.searchStr;

  // Locked by auto-lock, the lock button or a worker crash: go to /unlock and come back here.
  // Only depends on the lock state: re-running on every router update would loop.
  useEffect(() => {
    if (lockState === "locked") {
      void router.navigate({ to: "/unlock", search: { next: hereRef.current }, replace: true });
    }
  }, [lockState, router]);

  // Close the drawer after navigating, and on Escape.
  // biome-ignore lint/correctness/useExhaustiveDependencies: close whenever the path changes
  useEffect(() => setDrawerOpen(false), [location.pathname]);
  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && setDrawerOpen(false);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [drawerOpen]);

  if (!user || lockState === "locked") {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner label="Loading" className="size-8" />
      </div>
    );
  }

  const menuItems = [
    { key: "settings", label: "Settings", onSelect: () => void navigate({ to: "/settings" }) },
    ...(isAdmin
      ? [{ key: "admin", label: "Admin", onSelect: () => void navigate({ to: "/admin" }) }]
      : []),
    {
      key: "logout",
      label: "Log out",
      tone: "danger" as const,
      onSelect: () =>
        void logout(queryClient, () => router.navigate({ to: "/login", replace: true })),
    },
  ];

  return (
    <div className="flex min-h-screen flex-col">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded-md focus:bg-white focus:px-3 focus:py-2 focus:text-sm focus:shadow dark:focus:bg-slate-900"
      >
        Skip to content
      </a>
      <header className="sticky top-0 z-20 flex h-14 items-center gap-2 border-b border-slate-200 bg-white/90 px-3 backdrop-blur sm:px-4 dark:border-slate-800 dark:bg-slate-900/90">
        <button
          type="button"
          aria-label="Open sidebar"
          aria-expanded={drawerOpen}
          aria-controls="app-sidebar"
          onClick={() => setDrawerOpen((v) => !v)}
          className="rounded-lg p-2 hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-brand-600 lg:hidden dark:hover:bg-slate-800"
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            className="size-5"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          >
            <path d="M4 7h16M4 12h16M4 17h16" />
          </svg>
        </button>
        <Link
          to="/vault"
          className="flex items-center gap-2 rounded-lg px-1 font-semibold text-brand-700 focus-visible:outline-2 focus-visible:outline-brand-600 dark:text-brand-300"
        >
          <LogoMark className="size-6" />
          <span className="hidden sm:inline">Password Manager</span>
        </Link>
        <div className="flex-1" />
        <Button variant="ghost" size="sm" onClick={() => void lockNow()}>
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            className="size-4"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x="5" y="11" width="14" height="9" rx="2" />
            <path d="M8 11V8a4 4 0 0 1 8 0v3" />
          </svg>
          Lock
        </Button>
        <Menu
          label="Account menu"
          items={menuItems}
          trigger={
            <>
              <span
                className="flex size-7 items-center justify-center rounded-full bg-brand-100 text-xs font-semibold uppercase text-brand-800 dark:bg-brand-900 dark:text-brand-200"
                aria-hidden="true"
              >
                {user.email.slice(0, 1)}
              </span>
              <span className="hidden max-w-48 truncate md:inline">{user.email}</span>
            </>
          }
        />
      </header>

      <div className="flex flex-1">
        {drawerOpen ? (
          <button
            type="button"
            aria-label="Close sidebar"
            className="fixed inset-0 z-30 bg-slate-950/50 lg:hidden"
            onClick={() => setDrawerOpen(false)}
          />
        ) : null}
        <aside
          id="app-sidebar"
          className={
            drawerOpen
              ? "fixed inset-y-0 left-0 z-40 w-72 overflow-y-auto border-r border-slate-200 bg-white shadow-xl dark:border-slate-800 dark:bg-slate-900"
              : "hidden w-64 shrink-0 overflow-y-auto border-r border-slate-200 bg-white lg:block dark:border-slate-800 dark:bg-slate-900"
          }
        >
          {drawerOpen ? (
            <div className="flex justify-end p-2 lg:hidden">
              <Button variant="ghost" size="sm" onClick={() => setDrawerOpen(false)}>
                Close
              </Button>
            </div>
          ) : null}
          <VaultSidebar />
        </aside>
        <main id="main" tabIndex={-1} className="min-w-0 flex-1 px-4 py-6 sm:px-6 lg:px-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
