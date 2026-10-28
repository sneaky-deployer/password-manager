import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CryptoWorkerError } from "../../crypto-worker/client.ts";
import { lockStore } from "../../lib/session.ts";
import { cryptoCall } from "../../test/fake-crypto.ts";
import { makeKeyBundle, makeUser, USER_ID } from "../../test/fixtures.ts";
import { apiError, mockApi } from "../../test/mock-api.ts";
import { renderApp } from "../../test/render-app.tsx";
import { resetUnlockBackoff } from "../auth/unlock-backoff.ts";

vi.mock("../../crypto-worker/client.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../crypto-worker/client.ts")>();
  const { fakeCryptoClient } = await import("../../test/fake-crypto.ts");
  return { ...actual, cryptoClient: fakeCryptoClient() };
});

beforeEach(() => {
  cryptoCall.mockReset();
  cryptoCall.mockImplementation(async () => undefined);
  resetUnlockBackoff();
});
afterEach(() => vi.unstubAllGlobals());

const me = (role: "user" | "admin" = "user") => ({
  "GET /api/me": () => ({ user: makeUser({ role }) }),
});

describe("route guards", () => {
  it("sends signed-out visitors to /login", async () => {
    mockApi({ "GET /api/me": () => apiError(401, "unauthorized") });
    const { router } = renderApp("/vault");
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/login");
  });

  it("sends a signed-in but locked visitor to /unlock and back after unlocking", async () => {
    mockApi({ ...me(), "GET /api/me/keys": () => makeKeyBundle() });
    cryptoCall.mockImplementation(async (op) =>
      op === "unlock" ? { userId: USER_ID, kdfUpgrade: null } : undefined,
    );
    const user = userEvent.setup();
    const { router } = renderApp("/settings/sessions", { locked: true });

    expect(await screen.findByRole("heading", { name: "Vault locked" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/unlock");
    await user.type(screen.getByLabelText("Master password"), "my master password");
    await user.click(screen.getByRole("button", { name: "Unlock" }));

    await waitFor(() => expect(router.state.location.pathname).toBe("/settings/sessions"));
    expect(cryptoCall).toHaveBeenCalledWith("unlock", {
      password: "my master password",
      keyBundle: makeKeyBundle(),
    });
    expect(lockStore.get()).toBe("unlocked");
  });

  it("does not let an unlocked user sit on /unlock", async () => {
    mockApi(me());
    const { router } = renderApp("/unlock", { locked: false });
    await waitFor(() => expect(router.state.location.pathname).toBe("/vault"));
  });
});

describe("unlock page", () => {
  async function renderUnlock() {
    mockApi({ ...me(), "GET /api/me/keys": () => makeKeyBundle() });
    const user = userEvent.setup();
    renderApp("/unlock");
    await screen.findByRole("heading", { name: "Vault locked" });
    return user;
  }

  it("shows a local wrong-password error and backs off after repeated failures", async () => {
    cryptoCall.mockRejectedValue(new CryptoWorkerError("wrong_password", "Wrong password"));
    const user = await renderUnlock();
    const input = screen.getByLabelText("Master password");
    const submit = screen.getByRole("button", { name: "Unlock" });

    for (let i = 0; i < 3; i++) {
      await user.type(input, "nope nope nope");
      await user.click(submit);
      await screen.findByText("Wrong password.");
      await user.clear(input);
    }
    expect(await screen.findByText(/Too many wrong passwords/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Unlock" })).toBeDisabled();
  });

  it("logs out from the lock screen", async () => {
    const api = mockApi({
      ...me(),
      "POST /api/auth/logout": () => ({ ok: true }),
    });
    const user = userEvent.setup();
    renderApp("/unlock");
    await user.click(await screen.findByRole("button", { name: "Log out" }));
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    expect(api.called("POST", "/api/auth/logout")).toHaveLength(1);
    expect(cryptoCall).toHaveBeenCalledWith("lock");
  });
});

describe("app shell", () => {
  it("shows the shell with the vault sidebar and a lock button", async () => {
    mockApi(me());
    const user = userEvent.setup();
    renderApp("/vault", { locked: false });

    expect(await screen.findByRole("link", { name: /All items/ })).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Vaults" })).toBeInTheDocument();
    expect(screen.getByRole("banner")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Lock/ }));
    expect(await screen.findByRole("heading", { name: "Vault locked" })).toBeInTheDocument();
    expect(cryptoCall).toHaveBeenCalledWith("lock");
  });

  it("locks the screen when the worker locks (auto-lock, crash)", async () => {
    mockApi(me());
    renderApp("/vault", { locked: false });
    await screen.findByRole("link", { name: /All items/ });
    act(() => lockStore.set("locked"));
    expect(await screen.findByRole("heading", { name: "Vault locked" })).toBeInTheDocument();
  });

  it("offers Admin only to admins", async () => {
    mockApi(me("admin"));
    const user = userEvent.setup();
    renderApp("/vault", { locked: false });
    await screen.findByRole("link", { name: /All items/ });
    await user.click(screen.getByRole("button", { name: "Account menu" }));
    const menu = screen.getByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: "Settings" })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: "Admin" })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: "Log out" })).toBeInTheDocument();
  });

  it("hides Admin for regular users and logs out through the menu", async () => {
    const api = mockApi({ ...me(), "POST /api/auth/logout": () => ({ ok: true }) });
    const user = userEvent.setup();
    renderApp("/vault", { locked: false });
    await screen.findByRole("link", { name: /All items/ });
    await user.click(screen.getByRole("button", { name: "Account menu" }));
    expect(screen.queryByRole("menuitem", { name: "Admin" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("menuitem", { name: "Log out" }));
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    expect(api.called("POST", "/api/auth/logout")).toHaveLength(1);
    expect(lockStore.get()).toBe("locked");
  });
});
