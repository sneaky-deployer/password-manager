import { apiPaths } from "@pm/shared";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CryptoWorkerError } from "../../crypto-worker/client.ts";
import { cryptoCall } from "../../test/fake-crypto.ts";
import {
  ENVELOPE,
  KEY32,
  makeKeyBundle,
  makeUser,
  OTHER_ID,
  PHRASE_24,
  SALT16,
} from "../../test/fixtures.ts";
import { apiError, mockApi } from "../../test/mock-api.ts";
import { renderApp } from "../../test/render-app.tsx";

vi.mock("../../crypto-worker/client.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../crypto-worker/client.ts")>();
  const { fakeCryptoClient } = await import("../../test/fake-crypto.ts");
  return { ...actual, cryptoClient: fakeCryptoClient() };
});

const material = {
  newSalt: SALT16,
  newKdf: { alg: "argon2id13", mem: 67108864, ops: 3 },
  newAuthKey: KEY32,
  newWrappedAk: ENVELOPE,
};
const STRONG = "orange giraffe parachute lantern";

beforeEach(() => {
  cryptoCall.mockReset();
  cryptoCall.mockImplementation(async () => undefined);
});
afterEach(() => vi.unstubAllGlobals());

const meRoute = (user = makeUser()) => ({ "GET /api/me": () => ({ user }) });

describe("Settings > Security", () => {
  it("changes the master password with the current password as proof", async () => {
    cryptoCall.mockImplementation(async (op) =>
      op === "buildPasswordChange" ? { currentAuthKey: KEY32, material } : undefined,
    );
    const api = mockApi({
      ...meRoute(),
      "GET /api/me/keys": () => makeKeyBundle(),
      "POST /api/me/password": () => ({ ok: true }),
      "GET /api/me/sessions": () => ({ sessions: [] }),
    });
    const user = userEvent.setup();
    renderApp("/settings/security", { locked: false });

    await user.type(await screen.findByLabelText("Current password"), "old password here");
    await user.type(screen.getByLabelText("New password"), STRONG);
    await user.type(screen.getByLabelText("Confirm password"), STRONG);
    await user.click(screen.getByRole("button", { name: "Change password" }));

    expect(await screen.findByText(/Master password changed/)).toBeInTheDocument();
    expect(cryptoCall).toHaveBeenCalledWith("buildPasswordChange", {
      currentPassword: "old password here",
      newPassword: STRONG,
      keyBundle: makeKeyBundle(),
    });
    expect(api.called("POST", "/api/me/password")[0]?.body).toEqual({
      currentAuthKey: KEY32,
      ...material,
    });
    expect(screen.getByLabelText("Current password")).toHaveValue("");
  });

  it("shows an error on the current password field when it is wrong", async () => {
    cryptoCall.mockRejectedValue(new CryptoWorkerError("wrong_password", "Wrong password"));
    const api = mockApi({ ...meRoute(), "GET /api/me/keys": () => makeKeyBundle() });
    const user = userEvent.setup();
    renderApp("/settings/security", { locked: false });
    await user.type(await screen.findByLabelText("Current password"), "wrong wrong wrong");
    await user.type(screen.getByLabelText("New password"), STRONG);
    await user.type(screen.getByLabelText("Confirm password"), STRONG);
    await user.click(screen.getByRole("button", { name: "Change password" }));
    expect(await screen.findByText("That is not your current password.")).toBeInTheDocument();
    expect(api.called("POST", "/api/me/password")).toHaveLength(0);
  });

  it("resets from an unlocked device with an email code instead of the old password", async () => {
    cryptoCall.mockImplementation(async (op) =>
      op === "buildPasswordReset" ? { material } : undefined,
    );
    const api = mockApi({
      ...meRoute(),
      "POST /api/me/email-code": () => ({ ok: true }),
      "POST /api/me/password/reset-from-unlocked": () => ({ ok: true }),
      "GET /api/me/sessions": () => ({ sessions: [] }),
    });
    const user = userEvent.setup();
    renderApp("/settings/security", { locked: false });
    await user.click(
      await screen.findByRole("button", { name: "I don't remember my current password" }),
    );
    await user.click(screen.getByRole("button", { name: "Email me a code" }));
    await user.type(await screen.findByLabelText("Email code"), "123456");
    await user.type(screen.getByLabelText("New password"), STRONG);
    await user.type(screen.getByLabelText("Confirm password"), STRONG);
    await user.click(screen.getByRole("button", { name: "Change password" }));
    expect(await screen.findByText(/Master password changed/)).toBeInTheDocument();
    expect(api.called("POST", "/api/me/password/reset-from-unlocked")[0]?.body).toEqual({
      emailCode: "123456",
      ...material,
    });
  });

  it("regenerates the recovery kit and only posts it after the 3-word confirmation", async () => {
    cryptoCall.mockImplementation(async (op) =>
      op === "buildRecoveryKit"
        ? {
            recoveryPhrase: PHRASE_24,
            material: { wrappedAkRec: ENVELOPE, recoveryAuthKey: KEY32 },
          }
        : undefined,
    );
    const api = mockApi({ ...meRoute(), "POST /api/me/recovery": () => ({ ok: true }) });
    const user = userEvent.setup();
    renderApp("/settings/security", { locked: false });

    await user.click(await screen.findByRole("button", { name: "Generate a new recovery kit" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Generate" }));
    expect(await screen.findByRole("heading", { name: "New recovery kit" })).toBeInTheDocument();
    expect(api.called("POST", "/api/me/recovery")).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: "Replace my recovery kit" }));
    expect(api.called("POST", "/api/me/recovery")).toHaveLength(0);

    const words = PHRASE_24.split(" ");
    const labels = screen.getAllByText(/^Word \d+$/);
    const inputs = screen.getAllByLabelText(/^Word \d+$/);
    for (const [i, label] of labels.entries()) {
      const n = Number(/(\d+)/.exec(label.textContent ?? "")?.[1]);
      await user.type(inputs[i] as HTMLElement, words[n - 1] as string);
    }
    await user.click(screen.getByRole("button", { name: "Replace my recovery kit" }));
    expect(await screen.findByText("Your new recovery kit is active.")).toBeInTheDocument();
    expect(api.called("POST", "/api/me/recovery")[0]?.body).toEqual({
      wrappedAkRec: ENVELOPE,
      recoveryAuthKey: KEY32,
    });
  });

  it("sets up the authenticator app and shows backup codes once", async () => {
    const api = mockApi({
      ...meRoute(),
      "POST /api/me/2fa/totp/setup": () => ({
        secret: "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP",
        otpauthUri: "otpauth://totp/PM:alice?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=PM",
      }),
      "POST /api/me/2fa/totp/enable": () => ({ backupCodes: ["abcd-1234", "efgh-5678"] }),
    });
    const user = userEvent.setup();
    renderApp("/settings/security", { locked: false });

    await user.click(await screen.findByRole("button", { name: "Set up authenticator app" }));
    expect(await screen.findByRole("img", { name: /QR code/ })).toBeInTheDocument();
    expect(await screen.findByTestId("totp-secret")).toHaveTextContent(
      "JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP",
    );
    expect(screen.getByRole("link", { name: "Open in authenticator app" })).toHaveAttribute(
      "href",
      expect.stringMatching(/^otpauth:\/\/totp\//),
    );
    await user.type(screen.getByLabelText("Verification code"), "123456");
    await user.click(screen.getByRole("button", { name: "Turn on" }));

    const dialog = await screen.findByRole("dialog", { name: "Your backup codes" });
    expect(within(dialog).getByText("abcd-1234")).toBeInTheDocument();
    expect(api.called("POST", "/api/me/2fa/totp/enable")[0]?.body).toEqual({ code: "123456" });
    // Cannot be dismissed until the user confirms they saved the codes.
    expect(within(dialog).getByRole("button", { name: "Done" })).toBeDisabled();
    await user.click(within(dialog).getByRole("checkbox", { name: "I saved these codes" }));
    expect(within(dialog).getByRole("button", { name: "Done" })).toBeEnabled();
  });

  it("turns the authenticator app off after confirmation", async () => {
    const api = mockApi({
      ...meRoute(makeUser({ twoFactor: { totp: true, webauthn: 0 } })),
      "POST /api/me/2fa/totp/disable": () => ({ ok: true }),
    });
    const user = userEvent.setup();
    renderApp("/settings/security", { locked: false });
    await user.click(await screen.findByRole("button", { name: "Turn off" }));
    const dialog = screen.getByRole("dialog");
    // A code is required as proof.
    await user.click(within(dialog).getByRole("button", { name: "Turn off" }));
    expect(
      await within(dialog).findByText("Enter a code to confirm it is you."),
    ).toBeInTheDocument();
    expect(api.called("POST", "/api/me/2fa/totp/disable")).toHaveLength(0);
    await user.type(within(dialog).getByLabelText("6-digit code"), "123456");
    await user.click(within(dialog).getByRole("button", { name: "Turn off" }));
    await waitFor(() => expect(api.called("POST", "/api/me/2fa/totp/disable")).toHaveLength(1));
    expect(api.called("POST", "/api/me/2fa/totp/disable")[0]?.body).toEqual({
      method: "totp",
      code: "123456",
    });
  });

  it("lists passkeys and removes one", async () => {
    const id = OTHER_ID;
    const api = mockApi({
      ...meRoute(makeUser({ twoFactor: { totp: false, webauthn: 1 } })),
      "GET /api/me/2fa/webauthn": () => ({
        credentials: [{ id, name: "Laptop", createdAt: Date.now(), lastUsedAt: null }],
      }),
      [`DELETE ${apiPaths.me.webauthnCredential(id)}`]: () => ({ ok: true }),
    });
    const user = userEvent.setup();
    renderApp("/settings/security", { locked: false });
    expect(await screen.findByText("Laptop")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Remove Laptop" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Remove" }));
    await waitFor(() =>
      expect(api.called("DELETE", apiPaths.me.webauthnCredential(id))).toHaveLength(1),
    );
  });
});

describe("Settings > other tabs", () => {
  it("lists sessions and revokes one or all others", async () => {
    const other = {
      id: OTHER_ID,
      userAgent: "Mozilla/5.0 (Windows NT 10.0) Chrome/120 Safari/537",
      createdAt: Date.now() - 1e6,
      lastSeenAt: Date.now() - 5e4,
      expiresAt: Date.now() + 1e9,
      current: false,
    };
    const mine = {
      ...other,
      id: "77777777-7777-4777-8777-777777777777",
      userAgent: "Mozilla/5.0 (X11; Linux x86_64) Firefox/120",
      current: true,
    };
    const api = mockApi({
      ...meRoute(),
      "GET /api/me/sessions": () => ({ sessions: [mine, other] }),
      [`DELETE ${apiPaths.me.session(OTHER_ID)}`]: () => ({ ok: true }),
      "DELETE /api/me/sessions": () => ({ ok: true }),
    });
    const user = userEvent.setup();
    renderApp("/settings/sessions", { locked: false });
    expect(await screen.findByText("Firefox on Linux")).toBeInTheDocument();
    expect(screen.getByText("This device")).toBeInTheDocument();
    expect(screen.getByText("Chrome on Windows")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Sign out Firefox on Linux" }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Sign out Chrome on Windows" }));
    await waitFor(() =>
      expect(api.called("DELETE", apiPaths.me.session(OTHER_ID))).toHaveLength(1),
    );
    await user.click(screen.getByRole("button", { name: "Sign out all others" }));
    await waitFor(() => expect(api.called("DELETE", "/api/me/sessions")).toHaveLength(1));
  });

  it("pages through activity with the `before` cursor", async () => {
    const event = (n: number, name: string) => ({
      id: `88888888-8888-4888-8888-${String(n).padStart(12, "0")}`,
      event: name,
      meta: null,
      createdAt: 2_000_000 - n,
    });
    const firstPage = Array.from({ length: 25 }, (_, i) =>
      event(i, i === 0 ? "login" : "password_changed"),
    );
    const api = mockApi({
      ...meRoute(),
      "GET /api/me/activity": (call) =>
        call.query.before ? { events: [event(99, "passkey_added")] } : { events: firstPage },
    });
    const user = userEvent.setup();
    renderApp("/settings/activity", { locked: false });
    expect(await screen.findByText("Signed in")).toBeInTheDocument();
    expect(api.called("GET", "/api/me/activity")[0]?.query).toEqual({ limit: "25" });

    await user.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByText("Passkey added")).toBeInTheDocument();
    expect(api.called("GET", "/api/me/activity")[1]?.query.before).toBe(String(2_000_000 - 24));
    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
  });

  it("saves preferences and applies the theme", async () => {
    const api = mockApi({
      ...meRoute(),
      "PATCH /api/me/settings": (call) => ({ settings: call.body }),
    });
    const user = userEvent.setup();
    renderApp("/settings/preferences", { locked: false });
    const minutes = await screen.findByLabelText(/Lock after/);
    await user.clear(minutes);
    await user.type(minutes, "5");
    await user.click(screen.getByRole("radio", { name: "Dark" }));
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    await user.click(screen.getByRole("button", { name: "Save preferences" }));
    expect(await screen.findByText("Preferences saved.")).toBeInTheDocument();
    expect(api.called("PATCH", "/api/me/settings")[0]?.body).toEqual({
      autoLockMinutes: 5,
      theme: "dark",
    });
    document.documentElement.classList.remove("dark");
  });

  it("validates the auto-lock minutes", async () => {
    const api = mockApi(meRoute());
    const user = userEvent.setup();
    renderApp("/settings/preferences", { locked: false });
    const minutes = await screen.findByLabelText(/Lock after/);
    await user.clear(minutes);
    await user.type(minutes, "0");
    await user.click(screen.getByRole("button", { name: "Save preferences" }));
    expect(await screen.findByText(/Enter a whole number from 1/)).toBeInTheDocument();
    expect(api.called("PATCH", "/api/me/settings")).toHaveLength(0);
  });

  it("deletes the account with email code, password proof and typed confirmation", async () => {
    cryptoCall.mockImplementation(async (op) =>
      op === "deriveAuthKey" ? { authKey: KEY32 } : undefined,
    );
    const api = mockApi({
      ...meRoute(),
      "POST /api/me/email-code": () => ({ ok: true }),
      "GET /api/me/keys": () => makeKeyBundle(),
      "DELETE /api/me": () => ({ ok: true }),
    });
    const user = userEvent.setup();
    renderApp("/settings/danger", { locked: false });
    await user.click(await screen.findByRole("button", { name: "Delete my account…" }));
    const dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Email me a code" }));
    await user.type(await within(dialog).findByLabelText("Email code"), "123456");
    await user.type(within(dialog).getByLabelText("Master password"), "my master password");
    await user.click(within(dialog).getByRole("button", { name: "Delete account" }));
    expect(await within(dialog).findByText("Type DELETE to confirm.")).toBeInTheDocument();
    expect(api.called("DELETE", "/api/me")).toHaveLength(0);
    await user.type(within(dialog).getByLabelText("Type DELETE to confirm"), "DELETE");
    await user.click(within(dialog).getByRole("button", { name: "Delete account" }));
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    expect(api.called("DELETE", "/api/me")[0]?.body).toEqual({
      currentAuthKey: KEY32,
      emailCode: "123456",
    });
    expect(cryptoCall).toHaveBeenCalledWith("lock");
  });

  it("shows an error when the email code is wrong", async () => {
    mockApi({
      ...meRoute(),
      "POST /api/me/email-code": () =>
        apiError(429, "rate_limited", "x", { retryAfterSeconds: 120 }),
    });
    const user = userEvent.setup();
    renderApp("/settings/danger", { locked: false });
    await user.click(await screen.findByRole("button", { name: "Delete my account…" }));
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Email me a code" }),
    );
    expect(
      await screen.findByText(/Too many attempts. Try again in 2 minutes./),
    ).toBeInTheDocument();
  });
});
