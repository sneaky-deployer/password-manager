import { QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { render } from "@testing-library/react";
import { createQueryClient } from "../lib/query-client.ts";
import { lockStore } from "../lib/session.ts";
import { createAppRouter } from "../routes/router.ts";

/** Renders the real router + guards at `url`. Network is whatever `mockApi` stubbed. */
export function renderApp(url: string, options: { locked?: boolean } = {}) {
  lockStore.set(options.locked === false ? "unlocked" : "locked");
  const queryClient = createQueryClient();
  const router = createAppRouter({
    queryClient,
    history: createMemoryHistory({ initialEntries: [url] }),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { ...view, router, queryClient };
}
