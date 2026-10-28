import { QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQueryClient } from "../lib/query-client.ts";
import { createAppRouter } from "./router.ts";

function renderApp() {
  const router = createAppRouter(createMemoryHistory({ initialEntries: ["/"] }));
  render(
    <QueryClientProvider client={createQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe("Home route", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("shows the API health result", async () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    renderApp();

    expect(await screen.findByRole("heading", { name: "Password Manager" })).toBeInTheDocument();
    expect(await screen.findByText("API status: ok")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/health");
  });

  it("shows an error when the API is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 503 })),
    );

    renderApp();

    expect(await screen.findByText("API status: unreachable")).toBeInTheDocument();
  });
});
