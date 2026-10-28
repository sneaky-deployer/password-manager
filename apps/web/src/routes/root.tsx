import { Outlet } from "@tanstack/react-router";

export function RootLayout() {
  return (
    <div className="min-h-screen bg-white text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <main className="mx-auto max-w-2xl px-4 py-12">
        <Outlet />
      </main>
    </div>
  );
}
