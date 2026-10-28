import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lockStore } from "../../lib/session.ts";
import { cryptoCall } from "../../test/fake-crypto.ts";
import { KEY32, makeKeyBundle, makeUser, SALT16, TOKEN32, USER_ID } from "../../test/fixtures.ts";
import { apiError, mockApi } from "../../test/mock-api.ts";
import { renderApp } from "../../test/render-app.tsx";

vi.mock("../../crypto-worker/client.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../crypto-worker/client.ts")>();
  const { fakeCryptoClient } = await import("../../test/fake-crypto.ts");
  return { ...actual, cryptoClient: fakeCryptoClient() };
});

const prelogin = () => ({
  kdf: { alg: "argon2id13", mem: 64 * 1024 * 1024, ops: 3 },
  salt: SALT16,
});

function baseRoutes() {
  return {
    "POST /api/auth/prelogin": prelogin,
    "GET /api/me": () => ({ user: makeUser() }),
  };
}

beforeEach(() => {
  cryptoCall.mockReset();
  cryptoCall.mockImplementation(async (op) => {
    if (op === "login") return { authKey: KEY32 };
    if (op === "completeLogin") return { userId: USER_ID, kdfUpgrade: null };
    return undefined;
  });
});

afterEach(() => vi.unstubAllGlobals());

async function submitCredentials(user: ReturnType<typeof userEvent.setup>) {
  await user.type(await screen.findByLabelText("Email"), "alice@example.com");
  await user.type(screen.getByLabelText("Master password"), "my master password");
  await user.click(screen.getByRole("button", { name: "Sign in" }));
}

describe("Login page", () => {
  it("shows the generic error for invalid credentials and wipes the worker", async () => {
    const api = mockApi({
      ...baseRoutes(),
      "POST /api/auth/login": () =>
        apiError(401, "invalid_credentials", "Invalid email or password"),
    });
    const user = userEvent.setup();
    renderApp("/login");
    await submitCredentials(user);

    expect(await screen.findByRole("alert")).toHaveTextContent("Incorrect email or password.");
    expect(cryptoCall).toHaveBeenCalledWith("lock");
    expect(api.called("POST", "/api/auth/prelogin")[0]?.body).toEqual({
      email: "alice@example.com",
    });
    // The password field was cleared once the keys were derived.
    expect(screen.getByLabelText("Master password")).toHaveValue("");
  });

  it("sends only the derived authKey, never the password", async () => {
    const api = mockApi({
      ...baseRoutes(),
      "POST /api/auth/login": () => apiError(401, "invalid_credentials"),
    });
    const user = userEvent.setup();
    renderApp("/login");
    await submitCredentials(user);
    await screen.findByRole("alert");
    expect(cryptoCall).toHaveBeenCalledWith("login", {
      password: "my master password",
      salt: SALT16,
      kdf: { alg: "argon2id13", mem: 64 * 1024 * 1024, ops: 3 },
    });
    expect(api.called("POST", "/api/auth/login")[0]?.body).toEqual({
      email: "alice@example.com",
      authKey: KEY32,
    });
    expect(JSON.stringify(api.calls)).not.toContain("my master password");
  });

  it("rejects a malformed email without calling the server", async () => {
    const api = mockApi(baseRoutes());
    const user = userEvent.setup();
    renderApp("/login");
    await user.type(await screen.findByLabelText("Email"), "not-an-email");
    await user.type(screen.getByLabelText("Master password"), "x");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText("Enter a valid email address.")).toBeInTheDocument();
    expect(api.calls).toHaveLength(0);
  });

  it("signs in and unlocks when 2FA is off", async () => {
    mockApi({
      ...baseRoutes(),
      "POST /api/auth/login": () => ({ status: "ok", user: makeUser(), keys: makeKeyBundle() }),
    });
    const user = userEvent.setup();
    renderApp("/login");
    await submitCredentials(user);
    await waitFor(() =>
      expect(screen.getByRole("link", { name: /All items/ })).toBeInTheDocument(),
    );
    expect(cryptoCall).toHaveBeenCalledWith("completeLogin", makeKeyBundle());
    expect(lockStore.get()).toBe("unlocked");
  });

  it("asks for the second factor when the server requires it, then finishes the login", async () => {
    const api = mockApi({
      ...baseRoutes(),
      "POST /api/auth/login": () => ({
        status: "two_factor_required",
        challengeToken: TOKEN32,
        methods: ["totp", "backup_code"],
      }),
      "POST /api/auth/2fa/verify": () => ({
        status: "ok",
        user: makeUser(),
        keys: makeKeyBundle(),
      }),
    });
    const user = userEvent.setup();
    renderApp("/login");
    await submitCredentials(user);

    expect(
      await screen.findByRole("heading", { name: "Two-step verification" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Authenticator app" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("tab", { name: "Backup code" })).toBeInTheDocument();
    expect(cryptoCall).not.toHaveBeenCalledWith("completeLogin", expect.anything());

    await user.type(screen.getByLabelText("6-digit code"), "123456");
    await user.click(screen.getByRole("button", { name: "Verify" }));
    await waitFor(() =>
      expect(screen.getByRole("link", { name: /All items/ })).toBeInTheDocument(),
    );
    expect(api.called("POST", "/api/auth/2fa/verify")[0]?.body).toEqual({
      challengeToken: TOKEN32,
      method: "totp",
      code: "123456",
    });
  });

  it("supports backup codes and shows a wrong-code error", async () => {
    const api = mockApi({
      ...baseRoutes(),
      "POST /api/auth/login": () => ({
        status: "two_factor_required",
        challengeToken: TOKEN32,
        methods: ["totp", "backup_code"],
      }),
      "POST /api/auth/2fa/verify": () => apiError(401, "invalid_two_factor"),
    });
    const user = userEvent.setup();
    renderApp("/login");
    await submitCredentials(user);
    await user.click(await screen.findByRole("tab", { name: "Backup code" }));
    await user.type(screen.getByLabelText("Backup code", { selector: "input" }), "abcd-1234");
    await user.click(screen.getByRole("button", { name: "Verify" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("That verification code is wrong.");
    expect(api.called("POST", "/api/auth/2fa/verify")[0]?.body).toMatchObject({
      method: "backup_code",
      code: "abcd-1234",
    });
  });

  it("goes back to the credentials form when the challenge expired", async () => {
    mockApi({
      ...baseRoutes(),
      "POST /api/auth/login": () => ({
        status: "two_factor_required",
        challengeToken: TOKEN32,
        methods: ["totp"],
      }),
      "POST /api/auth/2fa/verify": () => apiError(400, "challenge_invalid"),
    });
    const user = userEvent.setup();
    renderApp("/login");
    await submitCredentials(user);
    await user.type(await screen.findByLabelText("6-digit code"), "123456");
    await user.click(screen.getByRole("button", { name: "Verify" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("expired");
    expect(screen.getByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    expect(cryptoCall).toHaveBeenCalledWith("lock");
  });

  it("silently posts the KDF upgrade after unlocking", async () => {
    const upgrade = {
      currentAuthKey: KEY32,
      newSalt: SALT16,
      newKdf: { alg: "argon2id13", mem: 67108864, ops: 3 },
      newAuthKey: KEY32,
      newWrappedAk: "W".repeat(60),
    };
    cryptoCall.mockImplementation(async (op) => {
      if (op === "login") return { authKey: KEY32 };
      if (op === "completeLogin") return { userId: USER_ID, kdfUpgrade: upgrade };
      return undefined;
    });
    const api = mockApi({
      ...baseRoutes(),
      "POST /api/auth/login": () => ({ status: "ok", user: makeUser(), keys: makeKeyBundle() }),
      "POST /api/me/kdf-upgrade": () => ({ ok: true }),
    });
    const user = userEvent.setup();
    renderApp("/login");
    await submitCredentials(user);
    await waitFor(() =>
      expect(screen.getByRole("link", { name: /All items/ })).toBeInTheDocument(),
    );
    expect(api.called("POST", "/api/me/kdf-upgrade")[0]?.body).toEqual(upgrade);
  });

  it("links to password recovery", async () => {
    mockApi(baseRoutes());
    renderApp("/login");
    expect(await screen.findByRole("link", { name: "Forgot password?" })).toHaveAttribute(
      "href",
      "/recover",
    );
  });
});
