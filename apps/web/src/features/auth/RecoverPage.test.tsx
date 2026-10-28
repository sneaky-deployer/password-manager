import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cryptoCall } from "../../test/fake-crypto.ts";
import {
  ENVELOPE,
  KEY32,
  makeKeyBundle,
  makeUser,
  PHRASE_24,
  SALT16,
  TOKEN32,
  USER_ID,
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

beforeEach(() => {
  cryptoCall.mockReset();
  cryptoCall.mockImplementation(async (op) => {
    if (op === "startRecovery") return { recoveryAuthKey: KEY32 };
    if (op === "completeRecovery") return { material };
    if (op === "completeLogin") return { userId: USER_ID, kdfUpgrade: null };
    if (op === "buildRecoveryKit") {
      return {
        recoveryPhrase: PHRASE_24,
        material: { wrappedAkRec: ENVELOPE, recoveryAuthKey: KEY32 },
      };
    }
    return undefined;
  });
});
afterEach(() => vi.unstubAllGlobals());

async function goToProof(user: ReturnType<typeof userEvent.setup>) {
  await user.type(await screen.findByLabelText("Email"), "alice@example.com");
  await user.click(screen.getByRole("button", { name: "Email me a code" }));
  await screen.findByRole("heading", { name: "Verify it is you" });
  await user.type(screen.getByLabelText("Email code"), "123456");
  await user.type(screen.getByLabelText("Recovery phrase"), PHRASE_24);
}

describe("Recover page", () => {
  it("recovers with the phrase, signs in and offers a new recovery kit", async () => {
    const api = mockApi({
      "POST /api/auth/email/start": () => ({ ok: true }),
      "POST /api/auth/recovery/start": () => ({
        userId: USER_ID,
        wrappedAkRec: ENVELOPE,
        recoveryToken: TOKEN32,
      }),
      "POST /api/auth/recovery/complete": () => ({
        status: "ok",
        user: makeUser(),
        keys: makeKeyBundle(),
      }),
    });
    const user = userEvent.setup();
    renderApp("/recover");
    await goToProof(user);
    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(
      await screen.findByRole("heading", { name: "Choose a new master password" }),
    ).toBeInTheDocument();
    expect(api.called("POST", "/api/auth/email/start")[0]?.body).toEqual({
      email: "alice@example.com",
      purpose: "recovery",
    });
    expect(api.called("POST", "/api/auth/recovery/start")[0]?.body).toEqual({
      email: "alice@example.com",
      emailCode: "123456",
      recoveryAuthKey: KEY32,
    });

    await user.type(screen.getByLabelText("Master password"), "orange giraffe parachute lantern");
    await user.type(screen.getByLabelText("Confirm password"), "orange giraffe parachute lantern");
    await user.click(screen.getByRole("button", { name: "Set password and sign in" }));

    expect(await screen.findByRole("heading", { name: "Password changed" })).toBeInTheDocument();
    expect(cryptoCall).toHaveBeenCalledWith("completeRecovery", {
      phrase: PHRASE_24,
      userId: USER_ID,
      wrappedAkRec: ENVELOPE,
      newPassword: "orange giraffe parachute lantern",
    });
    expect(api.called("POST", "/api/auth/recovery/complete")[0]?.body).toEqual({
      recoveryToken: TOKEN32,
      ...material,
    });
    expect(cryptoCall).toHaveBeenCalledWith("completeLogin", makeKeyBundle());

    await user.click(screen.getByRole("button", { name: "Create a new recovery kit" }));
    expect(
      await screen.findByRole("heading", { name: "Save your new recovery kit" }),
    ).toBeInTheDocument();
  });

  it("asks for a second factor when the server requires one", async () => {
    const api = mockApi({
      "POST /api/auth/email/start": () => ({ ok: true }),
      "POST /api/auth/recovery/start": (call) => {
        const body = call.body as { twoFactor?: unknown };
        return body.twoFactor
          ? { userId: USER_ID, wrappedAkRec: ENVELOPE, recoveryToken: TOKEN32 }
          : apiError(401, "two_factor_required", "2FA", {
              methods: ["totp", "webauthn", "backup_code"],
            });
      },
    });
    const user = userEvent.setup();
    renderApp("/recover");
    await goToProof(user);
    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(await screen.findByText("Two-step verification")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Authenticator app" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Backup code" })).toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: /passkey/i })).not.toBeInTheDocument();

    await user.type(screen.getByLabelText("6-digit code"), "654321");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByRole("heading", { name: "Choose a new master password" });
    expect(api.called("POST", "/api/auth/recovery/start")[1]?.body).toMatchObject({
      twoFactor: { method: "totp", code: "654321" },
    });
  });

  it("shows a clear error for a wrong recovery phrase", async () => {
    mockApi({ "POST /api/auth/email/start": () => ({ ok: true }) });
    cryptoCall.mockRejectedValue(
      Object.assign(new Error("bad"), {
        name: "CryptoWorkerError",
        code: "invalid_recovery_phrase",
      }),
    );
    const user = userEvent.setup();
    renderApp("/recover");
    await goToProof(user);
    await user.click(screen.getByRole("button", { name: "Continue" }));
    // A plain Error is not a CryptoWorkerError, so the generic message is shown.
    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });

  it("requires strong confirmation before resetting the account", async () => {
    const api = mockApi({
      "POST /api/auth/email/start": () => ({ ok: true }),
      "POST /api/auth/reset-account": () => ({ user: makeUser() }),
    });
    cryptoCall.mockImplementation(async (op) => {
      if (op === "createAccount")
        return { creation: { user: { id: USER_ID }, vault: {} }, recoveryPhrase: PHRASE_24 };
      return undefined;
    });
    const user = userEvent.setup();
    renderApp("/recover");
    await user.type(await screen.findByLabelText("Email"), "alice@example.com");
    await user.click(screen.getByRole("button", { name: /Reset account/ }));
    expect(
      await screen.findByText("All your items will be permanently deleted"),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Email me a confirmation code" }));
    expect(api.called("POST", "/api/auth/email/start")[0]?.body).toEqual({
      email: "alice@example.com",
      purpose: "reset_account",
    });
    await user.type(await screen.findByLabelText("Email code"), "123456");
    await user.type(
      screen.getByLabelText("New master password"),
      "orange giraffe parachute lantern",
    );
    await user.type(screen.getByLabelText("Confirm password"), "orange giraffe parachute lantern");

    // Without the typed phrase nothing happens.
    await user.click(screen.getByRole("button", { name: "Delete my data and reset account" }));
    expect(await screen.findByText("Type DELETE MY DATA to confirm.")).toBeInTheDocument();
    expect(cryptoCall).not.toHaveBeenCalledWith("createAccount", expect.anything());

    await user.type(screen.getByLabelText("Type DELETE MY DATA to confirm"), "DELETE MY DATA");
    await user.click(screen.getByRole("button", { name: "Delete my data and reset account" }));
    await waitFor(() => expect(api.called("POST", "/api/auth/reset-account")).toHaveLength(1));
    expect(api.called("POST", "/api/auth/reset-account")[0]?.body).toMatchObject({
      email: "alice@example.com",
      emailCode: "123456",
    });
    expect(
      await screen.findByRole("heading", { name: "Save your recovery kit" }),
    ).toBeInTheDocument();
  });
});
