import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cryptoCall } from "../../test/fake-crypto.ts";
import { makeUser, PHRASE_24, TOKEN32, USER_ID, VAULT_ID, WORDS_24 } from "../../test/fixtures.ts";
import { apiError, mockApi } from "../../test/mock-api.ts";
import { renderApp } from "../../test/render-app.tsx";
import { forgetInviteToken } from "./InvitePage.tsx";

vi.mock("../../crypto-worker/client.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../crypto-worker/client.ts")>();
  const { fakeCryptoClient } = await import("../../test/fake-crypto.ts");
  return { ...actual, cryptoClient: fakeCryptoClient() };
});

const STRONG = "orange giraffe parachute lantern";
const EMAIL = "carol@example.com";

function inspectOk(kind: "new_account" | "account_reset" = "new_account") {
  return () => ({
    email: EMAIL,
    invitedBy: "admin@example.com",
    kind,
    expiresAt: Date.now() + 1e6,
  });
}

beforeEach(() => {
  forgetInviteToken();
  cryptoCall.mockReset();
  cryptoCall.mockImplementation(async (op) => {
    if (op === "createAccount") {
      return {
        creation: { user: { id: USER_ID }, vault: { id: VAULT_ID } },
        recoveryPhrase: PHRASE_24,
      };
    }
    if (op === "commitAccountCreation") return { userId: USER_ID };
    return undefined;
  });
  window.history.replaceState(null, "", `/invite#t=${TOKEN32}`);
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

async function fillPasswords(user: ReturnType<typeof userEvent.setup>, a: string, b: string) {
  await user.type(await screen.findByLabelText("Master password"), a);
  await user.type(screen.getByLabelText("Confirm password"), b);
}

describe("Invite page", () => {
  it("strips the token from the address bar and inspects the invite", async () => {
    const api = mockApi({ "POST /api/invites/inspect": inspectOk() });
    renderApp("/invite");

    expect(await screen.findByDisplayValue(EMAIL)).toHaveAttribute("readonly");
    expect(window.location.hash).toBe("");
    expect(window.location.href).not.toContain(TOKEN32);
    expect(api.called("POST", "/api/invites/inspect")[0]?.body).toEqual({ token: TOKEN32 });
    expect(screen.getByText(/admin@example.com invited you/)).toBeInTheDocument();
    expect(screen.getByText(/Nobody can reset this password/)).toBeInTheDocument();
  });

  it("shows an invalid-invite page for a missing or rejected token", async () => {
    window.history.replaceState(null, "", "/invite");
    mockApi({});
    renderApp("/invite");
    expect(await screen.findByText("This invite link does not work")).toBeInTheDocument();
  });

  it("shows the same page when the server says the invite is invalid", async () => {
    mockApi({ "POST /api/invites/inspect": () => apiError(410, "invite_invalid") });
    renderApp("/invite");
    expect(await screen.findByText("This invite link does not work")).toBeInTheDocument();
  });

  it("uses reset wording for an account_reset invite", async () => {
    mockApi({ "POST /api/invites/inspect": inspectOk("account_reset") });
    renderApp("/invite");
    expect(await screen.findByText("Set a new master password")).toBeInTheDocument();
    expect(screen.getByText(/previous items were deleted/)).toBeInTheDocument();
  });

  it("enforces the password rules before touching the crypto worker", async () => {
    mockApi({ "POST /api/invites/inspect": inspectOk() });
    const user = userEvent.setup();
    renderApp("/invite");

    await fillPasswords(user, "short", "short");
    await user.click(screen.getByRole("button", { name: "Create account" }));
    expect(await screen.findByText("Use at least 12 characters.")).toBeInTheDocument();

    await user.clear(screen.getByLabelText("Master password"));
    await user.type(screen.getByLabelText("Master password"), "passwordpassword");
    await user.click(screen.getByRole("button", { name: "Create account" }));
    expect(await screen.findByText("That password is too easy to guess.")).toBeInTheDocument();

    await user.clear(screen.getByLabelText("Master password"));
    await user.type(screen.getByLabelText("Master password"), STRONG);
    await user.clear(screen.getByLabelText("Confirm password"));
    await user.type(screen.getByLabelText("Confirm password"), `${STRONG}x`);
    expect(await screen.findByText("The two passwords do not match.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Create account" }));
    expect(cryptoCall).not.toHaveBeenCalled();
  });

  it("creates the account, shows the recovery kit and requires the 3-word confirmation", async () => {
    const api = mockApi({
      "POST /api/invites/inspect": inspectOk(),
      "POST /api/auth/accept-invite": () => ({ user: makeUser({ email: EMAIL }) }),
    });
    const user = userEvent.setup();
    renderApp("/invite");

    await fillPasswords(user, STRONG, STRONG);
    await user.click(screen.getByRole("button", { name: "Create account" }));

    expect(
      await screen.findByRole("heading", { name: "Save your recovery kit" }),
    ).toBeInTheDocument();
    expect(cryptoCall).toHaveBeenCalledWith("createAccount", {
      password: STRONG,
      vaultName: "Personal",
    });
    const accept = api.called("POST", "/api/auth/accept-invite")[0]?.body as Record<
      string,
      unknown
    >;
    expect(accept.token).toBe(TOKEN32);
    expect(accept.user).toEqual({ id: USER_ID });

    const list = screen.getByRole("list", { name: "Recovery words" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(24);
    expect(within(list).getByText("abandon")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download recovery kit" })).toBeInTheDocument();

    // Nothing typed: cannot continue.
    await user.click(screen.getByRole("button", { name: /I saved it/ }));
    expect((await screen.findAllByText("Does not match")).length).toBe(3);
    expect(screen.getByRole("heading", { name: "Save your recovery kit" })).toBeInTheDocument();

    // Wrong words: still cannot continue.
    const inputs = screen.getAllByLabelText(/^Word \d+$/);
    expect(inputs).toHaveLength(3);
    for (const input of inputs) await user.type(input, "wrong");
    await user.click(screen.getByRole("button", { name: /I saved it/ }));
    expect(screen.getByRole("heading", { name: "Save your recovery kit" })).toBeInTheDocument();

    // Correct words: enters the app.
    const labels = screen.getAllByText(/^Word \d+$/);
    for (const [i, label] of labels.entries()) {
      const n = Number(/(\d+)/.exec(label.textContent ?? "")?.[1]);
      const input = inputs[i] as HTMLElement;
      await user.clear(input);
      await user.type(input, WORDS_24[n - 1] as string);
    }
    await user.click(screen.getByRole("button", { name: /I saved it/ }));
    await waitFor(() =>
      expect(screen.getByRole("link", { name: /All items/ })).toBeInTheDocument(),
    );
    expect(cryptoCall).toHaveBeenCalledWith("commitAccountCreation");
  });

  it("locks the worker and shows the error when the server rejects the account", async () => {
    mockApi({
      "POST /api/invites/inspect": inspectOk(),
      "POST /api/auth/accept-invite": () => apiError(410, "invite_invalid"),
    });
    const user = userEvent.setup();
    renderApp("/invite");
    await fillPasswords(user, STRONG, STRONG);
    await user.click(screen.getByRole("button", { name: "Create account" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("invalid or has expired");
    expect(cryptoCall).toHaveBeenCalledWith("lock");
    expect(cryptoCall).not.toHaveBeenCalledWith("commitAccountCreation");
  });
});
