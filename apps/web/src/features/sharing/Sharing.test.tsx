import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cryptoCall } from "../../test/fake-crypto.ts";
import { ENVELOPE, KEY32, makeUser, OTHER_ID, USER_ID } from "../../test/fixtures.ts";
import { apiError, mockApi } from "../../test/mock-api.ts";
import { renderApp } from "../../test/render-app.tsx";
import {
  emptySyncResponse,
  ITEM_1,
  itemView,
  itemWire,
  loginContent,
  memberView,
  memberWire,
  mockVaultWorld,
  SEALED,
  VAULT_A,
  vaultView,
  vaultWire,
} from "../../test/vault-fixtures.ts";

vi.mock("../../crypto-worker/client.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../crypto-worker/client.ts")>();
  const { fakeCryptoClient } = await import("../../test/fake-crypto.ts");
  return { ...actual, cryptoClient: fakeCryptoClient() };
});

beforeEach(() => cryptoCall.mockReset());
afterEach(() => vi.unstubAllGlobals());

const BOB_ID = "44444444-4444-4444-8444-444444444444";
const MEMBER_BOB = "20000000-0000-4000-8000-0000000000bb";
const SHARE_ID = "30000000-0000-4000-8000-000000000001";

const bob = memberView({
  id: MEMBER_BOB,
  userId: BOB_ID,
  email: "bob@example.com",
  role: "editor",
  isMe: false,
});
const me = memberView();

const lookupCarol = {
  userId: OTHER_ID,
  email: "carol@example.com",
  publicKey: KEY32,
};

/** Records API calls and worker ops in one ordered log. */
function eventLog() {
  const events: string[] = [];
  return {
    events,
    /** Log an API call and return its response. */
    api: <T,>(label: string, response?: T): T => {
      events.push(`api ${label}`);
      return response as T;
    },
    /** Log a worker op and return its result. */
    op: <T,>(name: string, result?: T): T => {
      events.push(`op ${name}`);
      return result as T;
    },
  };
}

const rotationBody = {
  vaultId: VAULT_A,
  newKeyVersion: 2,
  chunks: [{ step: "chunk", newKeyVersion: 2, items: [{ id: ITEM_1, revision: 1 }] }],
  finalize: {
    step: "finalize",
    newKeyVersion: 2,
    encryptedMeta: ENVELOPE,
    memberKeys: [],
    itemShareKeys: [],
  },
};

function openVaultMenu(user: ReturnType<typeof userEvent.setup>) {
  return user
    .click(screen.getByRole("button", { name: "Vault menu" }))
    .then(() => user.click(screen.getByRole("menuitem", { name: /Share and members|Members/ })));
}

describe("share vault dialog", () => {
  function setup(extraRoutes: Record<string, () => unknown> = {}) {
    const log = eventLog();
    const api = mockApi({
      "GET /api/me": () => ({ user: makeUser() }),
      "GET /api/sync": () => emptySyncResponse(),
      "GET /api/shares/pending": () => ({ shares: [] }),
      "GET /api/users/lookup": () => lookupCarol,
      [`POST /api/vaults/${VAULT_A}/members`]: () => ({ member: memberWire() }),
      ...extraRoutes,
    });
    mockVaultWorld({
      vaults: [vaultView({ memberCount: 2 })],
      items: [itemView()],
      members: [me, bob],
      contents: { [ITEM_1]: loginContent() },
      ops: {
        sealVaultKeyFor: () => ({ keyVersion: 1, sealedKey: SEALED }),
      },
    });
    return { api, log };
  }

  it("looks a person up by email and invites them with a sealed key", async () => {
    const { api } = setup();
    const user = userEvent.setup();
    renderApp(`/vault/v/${VAULT_A}`, { locked: false });
    await screen.findByRole("heading", { name: "Personal" });
    await openVaultMenu(user);

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("bob@example.com")).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText("Email address"), "Carol@Example.com");
    await user.click(within(dialog).getByRole("button", { name: "Find person" }));
    expect(await within(dialog).findByText("carol@example.com")).toBeInTheDocument();
    expect(api.called("GET", "/api/users/lookup")[0]?.query).toEqual({
      email: "carol@example.com",
    });

    // The owner may hand out all three roles.
    const roles = within(within(dialog).getByLabelText("Role")).getAllByRole("option");
    expect(roles.map((o) => (o as HTMLOptionElement).value)).toEqual([
      "viewer",
      "editor",
      "manager",
    ]);
    await user.selectOptions(within(dialog).getByLabelText("Role"), "viewer");
    await user.click(within(dialog).getByRole("button", { name: "Send invitation" }));

    await waitFor(() =>
      expect(api.called("POST", `/api/vaults/${VAULT_A}/members`)).toHaveLength(1),
    );
    expect(cryptoCall).toHaveBeenCalledWith("sealVaultKeyFor", {
      vaultId: VAULT_A,
      publicKey: KEY32,
    });
    expect(api.called("POST", `/api/vaults/${VAULT_A}/members`)[0]?.body).toEqual({
      userId: OTHER_ID,
      role: "viewer",
      keyVersion: 1,
      sealedKey: SEALED,
    });
    expect(
      await within(dialog).findByText(/Invitation sent to carol@example.com/),
    ).toBeInTheDocument();
  });

  it("says so when nobody has that email", async () => {
    setup({ "GET /api/users/lookup": () => apiError(404, "not_found", "nope") as never });
    const user = userEvent.setup();
    renderApp(`/vault/v/${VAULT_A}`, { locked: false });
    await screen.findByRole("heading", { name: "Personal" });
    await openVaultMenu(user);
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("Email address"), "ghost@example.com");
    await user.click(within(dialog).getByRole("button", { name: "Find person" }));
    expect(
      await within(dialog).findByText("No active account uses that email address."),
    ).toBeInTheDocument();
    expect(
      within(dialog).queryByRole("button", { name: "Send invitation" }),
    ).not.toBeInTheDocument();
  });

  it("limits a manager to viewer and editor invitations", async () => {
    mockApi({
      "GET /api/me": () => ({ user: makeUser() }),
      "GET /api/sync": () => emptySyncResponse(),
      "GET /api/shares/pending": () => ({ shares: [] }),
      "GET /api/users/lookup": () => lookupCarol,
    });
    mockVaultWorld({
      vaults: [vaultView({ myRole: "manager", isOwner: false, memberCount: 3 })],
      items: [],
      members: [
        memberView({ role: "manager" }),
        memberView({
          id: "x1",
          userId: "u1",
          email: "owner@example.com",
          role: "owner",
          isMe: false,
        }),
        memberView({
          id: "x2",
          userId: "u2",
          email: "other-manager@example.com",
          role: "manager",
          isMe: false,
        }),
        bob,
      ],
    });
    const user = userEvent.setup();
    renderApp(`/vault/v/${VAULT_A}`, { locked: false });
    await screen.findByRole("heading", { name: "Personal" });
    await openVaultMenu(user);
    const dialog = await screen.findByRole("dialog");
    // Owner and other managers cannot be touched by a manager; viewers and editors can.
    expect(within(dialog).queryByLabelText("Role of owner@example.com")).not.toBeInTheDocument();
    expect(
      within(dialog).queryByLabelText("Role of other-manager@example.com"),
    ).not.toBeInTheDocument();
    expect(within(dialog).getByLabelText("Role of bob@example.com")).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText("Email address"), "carol@example.com");
    await user.click(within(dialog).getByRole("button", { name: "Find person" }));
    const roles = await within(dialog).findByLabelText("Role");
    expect(within(roles).getAllByRole("option")).toHaveLength(2);
  });

  it("changes a member's role", async () => {
    const { api } = setup({
      [`PATCH /api/vaults/${VAULT_A}/members/${MEMBER_BOB}`]: () => ({
        member: memberWire({ id: MEMBER_BOB, role: "viewer", status: "active" }),
      }),
    });
    const user = userEvent.setup();
    renderApp(`/vault/v/${VAULT_A}`, { locked: false });
    await screen.findByRole("heading", { name: "Personal" });
    await openVaultMenu(user);
    const dialog = await screen.findByRole("dialog");
    await user.selectOptions(within(dialog).getByLabelText("Role of bob@example.com"), "viewer");
    await waitFor(() =>
      expect(api.called("PATCH", `/api/vaults/${VAULT_A}/members/${MEMBER_BOB}`)).toHaveLength(1),
    );
    expect(api.called("PATCH", `/api/vaults/${VAULT_A}/members/${MEMBER_BOB}`)[0]?.body).toEqual({
      role: "viewer",
    });
  });
});

describe("removing a member rotates the vault key", () => {
  function setup(finalize: () => unknown) {
    const log = eventLog();
    const path = `/api/vaults/${VAULT_A}`;
    mockApi({
      "GET /api/me": () => ({ user: makeUser() }),
      "GET /api/sync": () => log.api("GET sync", emptySyncResponse()),
      "GET /api/shares/pending": () => ({ shares: [] }),
      [`DELETE ${path}/members/${MEMBER_BOB}`]: () =>
        log.api("DELETE member", { ok: true, rotationPending: true }),
      [`POST ${path}/rotate`]: (call) => {
        const step = (call.body as { step: string }).step;
        log.api(`POST rotate ${step}`);
        return step === "chunk" ? { step: "chunk", accepted: 1 } : finalize();
      },
    });
    mockVaultWorld({
      vaults: [vaultView({ memberCount: 2 })],
      items: [itemView()],
      members: [me, bob],
      ops: {
        applySync: () => {
          log.op("applySync");
          return {
            vaults: [vaultView({ memberCount: 2 })],
            items: [itemView()],
            members: [me, bob],
            itemShares: [],
          };
        },
        prepareRotation: () => log.op("prepareRotation", rotationBody),
        commitRotation: () => log.op("commitRotation"),
        discardRotation: () => log.op("discardRotation"),
      },
    });
    return log;
  }

  async function removeBob(user: ReturnType<typeof userEvent.setup>) {
    renderApp(`/vault/v/${VAULT_A}`, { locked: false });
    await screen.findByRole("heading", { name: "Personal" });
    await openVaultMenu(user);
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Remove bob@example.com" }));
    const confirm = (await screen.findAllByRole("dialog")).find((d) =>
      within(d).queryByText(/Remove bob@example.com\?/),
    ) as HTMLElement;
    await user.click(within(confirm).getByRole("button", { name: "Remove and rotate key" }));
  }

  it("runs delete, sync, prepare, chunks, finalize, commit and sync in that order", async () => {
    const log = setup(() => ({ step: "finalize", vault: vaultWire() }));
    const user = userEvent.setup();
    await removeBob(user);

    expect(await screen.findByText("Vault key rotated")).toBeInTheDocument();
    expect(screen.getByText(/They no longer have access/)).toBeInTheDocument();
    const start = log.events.indexOf("api DELETE member");
    expect(log.events.slice(start)).toEqual([
      "api DELETE member",
      "api GET sync",
      "op applySync",
      "op prepareRotation",
      "api POST rotate chunk",
      "api POST rotate finalize",
      "op commitRotation",
      "api GET sync",
      "op applySync",
    ]);
  });

  it("keeps the vault pending when the upload fails and finishes on retry", async () => {
    let attempts = 0;
    const log = setup(() => {
      attempts += 1;
      return attempts === 1
        ? apiError(500, "internal_error", "boom")
        : { step: "finalize", vault: vaultWire() };
    });
    const user = userEvent.setup();
    await removeBob(user);

    expect(await screen.findByText("The rotation did not finish")).toBeInTheDocument();
    expect(log.events).toContain("op discardRotation");
    expect(log.events).not.toContain("op commitRotation");

    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Vault key rotated")).toBeInTheDocument();
    expect(log.events.filter((e) => e === "op prepareRotation")).toHaveLength(2);
    expect(log.events.filter((e) => e === "op commitRotation")).toHaveLength(1);
  });

  it("restarts by itself when the server reports a concurrent change", async () => {
    let attempts = 0;
    const log = setup(() => {
      attempts += 1;
      return attempts === 1
        ? apiError(409, "revision_conflict", "moved", { currentRevision: 2 })
        : { step: "finalize", vault: vaultWire() };
    });
    const user = userEvent.setup();
    await removeBob(user);
    expect(await screen.findByText("Vault key rotated")).toBeInTheDocument();
    expect(log.events.filter((e) => e === "op prepareRotation")).toHaveLength(2);
  });
});

describe("pending rotation", () => {
  it("offers to finish an interrupted rotation", async () => {
    const log = eventLog();
    mockApi({
      "GET /api/me": () => ({ user: makeUser() }),
      "GET /api/sync": () => emptySyncResponse(),
      "GET /api/shares/pending": () => ({ shares: [] }),
      [`POST /api/vaults/${VAULT_A}/rotate`]: (call) =>
        (call.body as { step: string }).step === "chunk"
          ? { step: "chunk", accepted: 1 }
          : { step: "finalize", vault: vaultWire() },
    });
    mockVaultWorld({
      vaults: [vaultView({ rotationPending: true })],
      items: [itemView()],
      ops: {
        prepareRotation: () => log.op("prepareRotation", rotationBody),
        commitRotation: () => log.op("commitRotation"),
      },
    });
    const user = userEvent.setup();
    renderApp(`/vault/v/${VAULT_A}`, { locked: false });
    expect(await screen.findByText("This vault is waiting for a key rotation")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Finish rotation" }));
    expect(await screen.findByText("Vault key rotated")).toBeInTheDocument();
    expect(log.events).toEqual(["op prepareRotation", "op commitRotation"]);
  });

  it("tells non-managers to wait", async () => {
    mockApi({
      "GET /api/me": () => ({ user: makeUser() }),
      "GET /api/sync": () => emptySyncResponse(),
      "GET /api/shares/pending": () => ({ shares: [] }),
    });
    mockVaultWorld({
      vaults: [vaultView({ rotationPending: true, myRole: "editor", isOwner: false })],
      items: [],
    });
    renderApp(`/vault/v/${VAULT_A}`, { locked: false });
    expect(
      await screen.findByText(/A manager or the owner needs to finish it/),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Finish rotation" })).not.toBeInTheDocument();
  });
});

describe("share one item", () => {
  const share = {
    id: SHARE_ID,
    itemId: ITEM_1,
    vaultId: VAULT_A,
    userId: BOB_ID,
    email: "bob@example.com",
    role: "viewer" as const,
    status: "active" as const,
    isMe: false,
  };

  it("shares with a non-member and revokes with an item key rotation", async () => {
    const log = eventLog();
    const api = mockApi({
      "GET /api/me": () => ({ user: makeUser() }),
      "GET /api/sync": () => log.api("GET sync", emptySyncResponse()),
      "GET /api/shares/pending": () => ({ shares: [] }),
      "GET /api/users/lookup": () => lookupCarol,
      [`POST /api/items/${ITEM_1}/shares`]: () => ({
        share: {
          id: SHARE_ID,
          itemId: ITEM_1,
          vaultId: VAULT_A,
          userId: OTHER_ID,
          email: "carol@example.com",
          publicKey: KEY32,
          role: "editor",
          status: "pending",
          keyVersion: 1,
          invitedBy: USER_ID,
          createdAt: 1,
          updatedAt: 1,
        },
      }),
      [`DELETE /api/items/${ITEM_1}/shares/${SHARE_ID}`]: () =>
        log.api("DELETE share", { ok: true }),
      [`PUT /api/items/${ITEM_1}`]: () =>
        log.api("PUT item", { item: itemWire({ itemKeyVersion: 2 }) }),
    });
    mockVaultWorld({
      vaults: [vaultView()],
      items: [itemView({ shareCount: 1 })],
      itemShares: [share],
      contents: { [ITEM_1]: loginContent() },
      ops: {
        sealItemKeyFor: () => ({ keyVersion: 1, sealedKey: SEALED }),
        prepareItemKeyRotation: () =>
          log.op("prepareItemKeyRotation", {
            body: { ...itemWire(), itemKeyVersion: 2, revision: 1, shareKeys: [] },
          }),
      },
    });
    const user = userEvent.setup();
    renderApp(`/vault?item=${ITEM_1}`, { locked: false });
    await user.click(await screen.findByRole("button", { name: "Share" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("bob@example.com")).toBeInTheDocument();

    // Invite: only viewer / editor exist for item shares.
    await user.type(within(dialog).getByLabelText("Email address"), "carol@example.com");
    await user.click(within(dialog).getByRole("button", { name: "Find person" }));
    const role = await within(dialog).findByLabelText("Role");
    expect(within(role).getAllByRole("option")).toHaveLength(2);
    await user.selectOptions(role, "editor");
    await user.click(within(dialog).getByRole("button", { name: "Share item" }));
    await waitFor(() => expect(api.called("POST", `/api/items/${ITEM_1}/shares`)).toHaveLength(1));
    expect(cryptoCall).toHaveBeenCalledWith("sealItemKeyFor", { itemId: ITEM_1, publicKey: KEY32 });
    expect(api.called("POST", `/api/items/${ITEM_1}/shares`)[0]?.body).toEqual({
      userId: OTHER_ID,
      role: "editor",
      keyVersion: 1,
      sealedKey: SEALED,
    });

    // Revoke: delete the share, then rotate the item key with a PUT.
    log.events.length = 0;
    await user.click(
      within(dialog).getByRole("button", { name: "Revoke access of bob@example.com" }),
    );
    const confirm = (await screen.findAllByRole("dialog")).find((d) =>
      within(d).queryByText(/Revoke access of bob/),
    ) as HTMLElement;
    await user.click(within(confirm).getByRole("button", { name: "Revoke access" }));
    expect(
      await within(dialog).findByText(
        "They no longer have access. If they viewed these passwords, consider changing them.",
      ),
    ).toBeInTheDocument();
    expect(cryptoCall).toHaveBeenCalledWith("prepareItemKeyRotation", {
      itemId: ITEM_1,
      removedShareId: SHARE_ID,
    });
    expect(log.events.filter((e) => !e.startsWith("op applySync"))).toEqual([
      "api DELETE share",
      "api GET sync",
      "op prepareItemKeyRotation",
      "api PUT item",
      "api GET sync",
    ]);
  });

  it("offers a retry when the key rotation fails after the share was removed", async () => {
    let puts = 0;
    const api = mockApi({
      "GET /api/me": () => ({ user: makeUser() }),
      "GET /api/sync": () => emptySyncResponse(),
      "GET /api/shares/pending": () => ({ shares: [] }),
      [`DELETE /api/items/${ITEM_1}/shares/${SHARE_ID}`]: () => ({ ok: true }),
      [`PUT /api/items/${ITEM_1}`]: () =>
        ++puts === 1 ? apiError(500, "internal_error", "boom") : { item: itemWire() },
    });
    mockVaultWorld({
      vaults: [vaultView()],
      items: [itemView({ shareCount: 1 })],
      itemShares: [share],
      contents: { [ITEM_1]: loginContent() },
      ops: {
        prepareItemKeyRotation: () => ({
          body: { ...itemWire(), itemKeyVersion: 2, revision: 1, shareKeys: [] },
        }),
      },
    });
    const user = userEvent.setup();
    renderApp(`/vault?item=${ITEM_1}`, { locked: false });
    await user.click(await screen.findByRole("button", { name: "Share" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(
      within(dialog).getByRole("button", { name: "Revoke access of bob@example.com" }),
    );
    const confirm = (await screen.findAllByRole("dialog")).find((d) =>
      within(d).queryByText(/Revoke access of bob/),
    ) as HTMLElement;
    await user.click(within(confirm).getByRole("button", { name: "Revoke access" }));
    // The failure is shown in the confirm dialog; close it and retry from the share dialog.
    await user.click(await within(confirm).findByRole("button", { name: "Cancel" }));
    await user.click(await within(dialog).findByRole("button", { name: "Retry" }));
    expect(await within(dialog).findByText(/They no longer have access/)).toBeInTheDocument();
    expect(api.called("DELETE", `/api/items/${ITEM_1}/shares/${SHARE_ID}`)).toHaveLength(1);
    expect(api.called("PUT", `/api/items/${ITEM_1}`)).toHaveLength(2);
  });

  it("does not offer Share to editors", async () => {
    mockApi({
      "GET /api/me": () => ({ user: makeUser() }),
      "GET /api/sync": () => emptySyncResponse(),
      "GET /api/shares/pending": () => ({ shares: [] }),
    });
    mockVaultWorld({
      vaults: [vaultView({ myRole: "editor", isOwner: false })],
      items: [itemView({ canShare: false })],
      contents: { [ITEM_1]: loginContent() },
    });
    renderApp(`/vault?item=${ITEM_1}`, { locked: false });
    await screen.findByRole("heading", { name: "GitHub", level: 2 });
    expect(screen.queryByRole("button", { name: "Share" })).not.toBeInTheDocument();
  });
});

describe("invitations", () => {
  const vaultInvite = {
    kind: "vault",
    id: "50000000-0000-4000-8000-000000000001",
    vaultId: VAULT_A,
    role: "editor",
    keyVersion: 1,
    sealedKey: SEALED,
    encryptedMeta: ENVELOPE,
    invitedBy: OTHER_ID,
    invitedByEmail: "carol@example.com",
    createdAt: Date.now() - 3_600_000,
  };
  const itemInvite = {
    kind: "item",
    id: "50000000-0000-4000-8000-000000000002",
    itemId: ITEM_1,
    vaultId: VAULT_A,
    role: "viewer",
    keyVersion: 1,
    sealedKey: SEALED,
    invitedBy: OTHER_ID,
    invitedByEmail: "dave@example.com",
    createdAt: Date.now() - 7_200_000,
  };

  it("shows who invited me and the decrypted vault name, and accepts", async () => {
    let pending = [vaultInvite, itemInvite];
    const api = mockApi({
      "GET /api/me": () => ({ user: makeUser() }),
      "GET /api/sync": () => emptySyncResponse(),
      "GET /api/shares/pending": () => ({ shares: pending }),
      [`POST /api/shares/${vaultInvite.id}/accept`]: () => {
        pending = [itemInvite];
        return { ok: true };
      },
      [`POST /api/shares/${itemInvite.id}/decline`]: () => {
        pending = [];
        return { ok: true };
      },
    });
    mockVaultWorld({ vaults: [], items: [] });
    const user = userEvent.setup();
    renderApp("/vault/invitations", { locked: false });

    const card = (await screen.findByRole("heading", { name: "Family" })).closest(
      "section",
    ) as HTMLElement;
    expect(within(card).getByText("carol@example.com")).toBeInTheDocument();
    expect(within(card).getByText(/Editor/)).toBeInTheDocument();
    expect(cryptoCall).toHaveBeenCalledWith("openPendingShare", { pending: vaultInvite });

    const syncsBefore = api.called("GET", "/api/sync").length;
    await user.click(within(card).getByRole("button", { name: "Accept" }));
    await waitFor(() =>
      expect(api.called("POST", `/api/shares/${vaultInvite.id}/accept`)).toHaveLength(1),
    );
    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: "Family" })).not.toBeInTheDocument(),
    );
    expect(api.called("GET", "/api/sync").length).toBeGreaterThan(syncsBefore);

    const itemCard = screen
      .getByRole("heading", { name: "Shared item" })
      .closest("section") as HTMLElement;
    await user.click(within(itemCard).getByRole("button", { name: "Decline" }));
    await waitFor(() =>
      expect(api.called("POST", `/api/shares/${itemInvite.id}/decline`)).toHaveLength(1),
    );
    expect(await screen.findByText("No invitations")).toBeInTheDocument();
  });
});
