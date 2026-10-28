import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiError, mockApi } from "../../test/mock-api.ts";
import { renderApp } from "../../test/render-app.tsx";

vi.mock("../../crypto-worker/client.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../crypto-worker/client.ts")>();
  const { fakeCryptoClient } = await import("../../test/fake-crypto.ts");
  return { ...actual, cryptoClient: fakeCryptoClient() };
});

afterEach(() => vi.unstubAllGlobals());

describe("Setup page", () => {
  it("emails the setup link and tells the owner to check the inbox", async () => {
    const api = mockApi({
      "GET /api/setup/status": () => ({ needsSetup: true }),
      "POST /api/setup/start": () => ({ ok: true }),
    });
    const user = userEvent.setup();
    renderApp("/setup");
    await user.click(await screen.findByRole("button", { name: "Email me the setup link" }));
    expect(await screen.findByRole("heading", { name: "Check your inbox" })).toBeInTheDocument();
    expect(api.called("POST", "/api/setup/start")).toHaveLength(1);
  });

  it("redirects to /login when an admin already exists", async () => {
    mockApi({ "GET /api/setup/status": () => ({ needsSetup: false }) });
    const { router } = renderApp("/setup");
    await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
  });

  it("redirects to /login when the server says setup is not available", async () => {
    mockApi({
      "GET /api/setup/status": () => ({ needsSetup: true }),
      "POST /api/setup/start": () => apiError(404, "setup_not_available"),
    });
    const user = userEvent.setup();
    const { router } = renderApp("/setup");
    await user.click(await screen.findByRole("button", { name: "Email me the setup link" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
  });
});
