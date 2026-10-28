import { apiPaths } from "@pm/shared";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeInvite, makeUser, OTHER_ID } from "../../test/fixtures.ts";
import { mockApi } from "../../test/mock-api.ts";
import { renderApp } from "../../test/render-app.tsx";

vi.mock("../../crypto-worker/client.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../crypto-worker/client.ts")>();
  const { fakeCryptoClient } = await import("../../test/fake-crypto.ts");
  return { ...actual, cryptoClient: fakeCryptoClient() };
});

afterEach(() => vi.unstubAllGlobals());

const pending = makeInvite({ id: OTHER_ID, email: "bob@example.com", status: "pending" });
const expired = makeInvite({
  id: "44444444-4444-4444-8444-444444444444",
  email: "carol@example.com",
  status: "expired",
  expiresAt: Date.now() - 1000,
});
const accepted = makeInvite({
  id: "55555555-5555-4555-8555-555555555555",
  email: "dan@example.com",
  status: "accepted",
  acceptedAt: Date.now(),
});
const revoked = makeInvite({
  id: "66666666-6666-4666-8666-666666666666",
  email: "erin@example.com",
  status: "revoked",
  revokedAt: Date.now(),
});

function adminRoutes(extra: Parameters<typeof mockApi>[0] = {}) {
  return {
    "GET /api/me": () => ({ user: makeUser({ role: "admin" }) }),
    "GET /api/admin/invites": () => ({ invites: [pending, expired, accepted, revoked] }),
    ...extra,
  };
}

describe("Admin invites tab", () => {
  it("lists invites with their status and the right actions", async () => {
    mockApi(adminRoutes());
    renderApp("/admin/invites", { locked: false });

    const table = await screen.findByRole("table", { name: "Invitations" });
    for (const email of [
      "bob@example.com",
      "carol@example.com",
      "dan@example.com",
      "erin@example.com",
    ]) {
      expect(within(table).getByText(email)).toBeInTheDocument();
    }
    expect(within(table).getByText("pending")).toBeInTheDocument();
    expect(within(table).getByText("accepted")).toBeInTheDocument();
    expect(within(table).getByText("expired")).toBeInTheDocument();
    expect(within(table).getByText("revoked")).toBeInTheDocument();

    expect(
      screen.getByRole("button", { name: "Resend invite to bob@example.com" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Resend invite to carol@example.com" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Revoke invite for bob@example.com" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Revoke invite for carol/ }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /dan@example.com/ })).not.toBeInTheDocument();
    expect(screen.getByText(/can never read anyone's vaults/)).toBeInTheDocument();
  });

  it("resends and revokes through the right endpoints", async () => {
    const api = mockApi(
      adminRoutes({
        [`POST ${apiPaths.admin.inviteResend(pending.id)}`]: () => ({ invite: pending }),
        [`POST ${apiPaths.admin.inviteRevoke(pending.id)}`]: () => ({
          invite: { ...pending, status: "revoked" },
        }),
      }),
    );
    const user = userEvent.setup();
    renderApp("/admin/invites", { locked: false });

    await user.click(
      await screen.findByRole("button", { name: "Resend invite to bob@example.com" }),
    );
    expect(await screen.findByText(/new link was sent to bob@example.com/)).toBeInTheDocument();
    expect(api.called("POST", apiPaths.admin.inviteResend(pending.id))).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "Revoke invite for bob@example.com" }));
    expect(await screen.findByText(/Invitation for bob@example.com revoked/)).toBeInTheDocument();
    expect(api.called("POST", apiPaths.admin.inviteRevoke(pending.id))).toHaveLength(1);
  });

  it("creates an invite for the typed email", async () => {
    const created = makeInvite({ email: "frank@example.com" });
    const api = mockApi(adminRoutes({ "POST /api/admin/invites": () => ({ invite: created }) }));
    const user = userEvent.setup();
    renderApp("/admin/invites", { locked: false });

    await user.type(await screen.findByLabelText("Email address"), "  Frank@Example.com ");
    await user.click(screen.getByRole("button", { name: "Send invite" }));
    expect(await screen.findByText("Invitation sent to frank@example.com.")).toBeInTheDocument();
    expect(api.called("POST", "/api/admin/invites")[0]?.body).toEqual({
      email: "frank@example.com",
    });
  });

  it("keeps non-admins out of /admin", async () => {
    mockApi({ "GET /api/me": () => ({ user: makeUser({ role: "user" }) }) });
    renderApp("/admin/invites", { locked: false });
    expect(await screen.findByText("Your vault will appear here")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Admin" })).not.toBeInTheDocument();
  });
});
