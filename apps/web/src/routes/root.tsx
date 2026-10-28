import type { QueryClient } from "@tanstack/react-query";
import { useQuery } from "@tanstack/react-query";
import { createRootRouteWithContext, Link, Outlet, useRouter } from "@tanstack/react-router";
import { useEffect } from "react";
import { Alert, Button } from "../components/ui/index.ts";
import { describeError } from "../lib/errors.ts";
import { meQueryOptions } from "../lib/session.ts";
import { applyTheme, storeTheme } from "../lib/theme.ts";

export interface RouterContext {
  queryClient: QueryClient;
}

/** Keeps the `dark` class in sync with the signed-in user's saved theme. */
function ThemeSync() {
  // `enabled: false` reads the cache without fetching /me on signed-out pages.
  const { data } = useQuery({ ...meQueryOptions(), enabled: false });
  const theme = data?.user.settings.theme;
  useEffect(() => {
    if (!theme) return;
    applyTheme(theme);
    storeTheme(theme);
  }, [theme]);
  return null;
}

function RootLayout() {
  return (
    <>
      <ThemeSync />
      <Outlet />
    </>
  );
}

function RootError({ error }: { error: unknown }) {
  const router = useRouter();
  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-4 px-4">
      <h1 className="text-xl font-semibold">Something went wrong</h1>
      <Alert variant="error">{describeError(error)}</Alert>
      <Button onClick={() => void router.invalidate()}>Try again</Button>
    </div>
  );
}

function NotFound() {
  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-4 px-4">
      <h1 className="text-xl font-semibold">Page not found</h1>
      <p className="text-sm text-slate-600 dark:text-slate-400">
        That page does not exist or was moved.
      </p>
      <Link to="/" className="text-brand-700 hover:underline dark:text-brand-300">
        Go to your vault
      </Link>
    </div>
  );
}

export const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: RootLayout,
  errorComponent: RootError,
  notFoundComponent: NotFound,
});
