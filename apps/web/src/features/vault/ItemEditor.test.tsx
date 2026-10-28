import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cryptoCall } from "../../test/fake-crypto.ts";
import { ENVELOPE, makeUser } from "../../test/fixtures.ts";
import { apiError, mockApi } from "../../test/mock-api.ts";
import { renderApp } from "../../test/render-app.tsx";
import {
  emptySyncResponse,
  ITEM_1,
  itemView,
  itemWire,
  loginContent,
  mockVaultWorld,
  VAULT_A,
  VAULT_B,
  vaultView,
} from "../../test/vault-fixtures.ts";
import { buildContent, emptyForm, formFromContent } from "./ItemEditor.tsx";

vi.mock("../../crypto-worker/client.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../crypto-worker/client.ts")>();
  const { fakeCryptoClient } = await import("../../test/fake-crypto.ts");
  return { ...actual, cryptoClient: fakeCryptoClient() };
});

beforeEach(() => cryptoCall.mockReset());
afterEach(() => vi.unstubAllGlobals());

const baseRoutes = {
  "GET /api/me": () => ({ user: makeUser() }),
  "GET /api/sync": () => emptySyncResponse(),
  "GET /api/shares/pending": () => ({ shares: [] }),
};

const createBody = {
  id: ITEM_1,
  vaultId: VAULT_A,
  itemKeyVersion: 1,
  wrappedKey: ENVELOPE,
  vaultKeyVersion: 1,
  encryptedData: ENVELOPE,
};

describe("buildContent", () => {
  it("requires a name and trims the lists", () => {
    const result = buildContent(emptyForm(VAULT_A));
    expect(result).toEqual({ ok: false, errors: { name: "Give the item a name." } });
    const ok = buildContent({
      ...emptyForm(VAULT_A),
      name: "  Site ",
      urls: [" https://a.test ", "", "  "],
      customFields: [
        { label: " ", value: "", hidden: false },
        { label: "Pin", value: "1", hidden: true },
      ],
    });
    expect(ok).toEqual({
      ok: true,
      content: {
        type: "login",
        name: "Site",
        urls: ["https://a.test"],
        customFields: [{ label: "Pin", value: "1", hidden: true }],
      },
    });
  });

  it("normalises a bare TOTP secret and rejects invalid ones with a message", () => {
    const good = buildContent({ ...emptyForm(VAULT_A), name: "x", totp: "jbsw y3dp ehpk 3pxp" });
    expect(good.ok && good.content.type === "login" ? good.content.totp : undefined).toMatch(
      /^otpauth:\/\/totp\/\?secret=JBSWY3DPEHPK3PXP&algorithm=SHA1&digits=6&period=30$/,
    );
    const bad = buildContent({ ...emptyForm(VAULT_A), name: "x", totp: "not base32 !!" });
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.errors.totp).toMatch(/isn't valid/);
    const hotp = buildContent({
      ...emptyForm(VAULT_A),
      name: "x",
      totp: "otpauth://hotp/x?secret=JBSWY3DPEHPK3PXP&counter=1",
    });
    expect(!hotp.ok && hotp.errors.totp).toMatch(/HOTP/);
  });

  it("builds notes and round-trips an existing item", () => {
    const note = buildContent({ ...emptyForm(VAULT_A, "note"), name: "N", notes: "text" });
    expect(note).toEqual({ ok: true, content: { type: "note", name: "N", notes: "text" } });
    const form = formFromContent(loginContent({ notes: "n" }), VAULT_A);
    expect(form).toMatchObject({
      type: "login",
      name: "GitHub",
      password: "s3cret-pass",
      notes: "n",
    });
  });

  it("reports content that is too large", () => {
    const result = buildContent({
      ...emptyForm(VAULT_A, "note"),
      name: "N",
      notes: "x".repeat(50_001),
    });
    expect(result.ok).toBe(false);
  });
});

describe("create item", () => {
  async function openNew() {
    const api = mockApi({
      ...baseRoutes,
      "POST /api/items": () => ({ item: itemWire() }),
    });
    mockVaultWorld({
      vaults: [
        vaultView(),
        vaultView({ id: VAULT_B, name: "Reader", myRole: "viewer", isOwner: false }),
      ],
      items: [],
      ops: { createItem: () => ({ body: createBody }) },
    });
    const user = userEvent.setup();
    renderApp("/vault?mode=new", { locked: false });
    await screen.findByRole("heading", { name: "New item" });
    return { user, api };
  }

  it("validates the name and an invalid TOTP before anything is encrypted", async () => {
    const { user, api } = await openNew();
    await user.click(screen.getByRole("button", { name: "Create item" }));
    expect(await screen.findByText("Give the item a name.")).toBeInTheDocument();

    await user.type(screen.getByLabelText(/^Name/), "Site");
    await user.type(screen.getByLabelText("Authenticator key"), "this is !!! not a key");
    await user.click(screen.getByRole("button", { name: "Create item" }));
    expect(await screen.findByText(/secret key isn't valid/)).toBeInTheDocument();
    expect(cryptoCall.mock.calls.map((c) => c[0])).not.toContain("createItem");
    expect(api.called("POST", "/api/items")).toHaveLength(0);
  });

  it("offers only vaults where I can write", async () => {
    await openNew();
    const select = screen.getByLabelText("Vault");
    expect(
      within(select)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["Personal"]);
  });

  it("encrypts in the worker, posts the body and syncs", async () => {
    const { user, api } = await openNew();
    await user.type(screen.getByLabelText(/^Name/), "My site");
    await user.type(screen.getByLabelText("Username or email"), "me@site.test");
    await user.type(screen.getByLabelText("Password"), "pw123");
    await user.type(screen.getByLabelText("Website 1"), "https://site.test");
    await user.click(screen.getByRole("button", { name: "Add website" }));
    await user.type(screen.getByLabelText("Website 2"), "https://other.test");
    await user.click(screen.getByRole("button", { name: "Remove website 2" }));
    await user.click(screen.getByRole("button", { name: "Add custom field" }));
    await user.type(screen.getByLabelText("Custom field 1 label"), "Pin");
    await user.type(screen.getByLabelText("Custom field 1 value"), "42");
    await user.click(screen.getByRole("checkbox", { name: "Hide value" }));
    await user.click(screen.getByRole("button", { name: "Create item" }));

    await waitFor(() => expect(api.called("POST", "/api/items")).toHaveLength(1));
    expect(api.called("POST", "/api/items")[0]?.body).toEqual(createBody);
    const call = cryptoCall.mock.calls.find((c) => c[0] === "createItem");
    expect(call?.[1]).toEqual({
      vaultId: VAULT_A,
      content: {
        type: "login",
        name: "My site",
        username: "me@site.test",
        password: "pw123",
        urls: ["https://site.test"],
        customFields: [{ label: "Pin", value: "42", hidden: true }],
      },
    });
    // Sync after the write: the initial sync plus one more.
    await waitFor(() => expect(api.called("GET", "/api/sync").length).toBeGreaterThanOrEqual(2));
  });

  it("fills the password from the generator dialog", async () => {
    const { user } = await openNew();
    await user.click(screen.getByRole("button", { name: "Generate" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Use this password" }));
    await waitFor(() =>
      expect((screen.getByLabelText("Password") as HTMLInputElement).value.length).toBeGreaterThan(
        7,
      ),
    );
  });

  it("creates a secure note", async () => {
    const { user, api } = await openNew();
    await user.click(screen.getByRole("radio", { name: "Secure note" }));
    expect(screen.queryByLabelText("Username or email")).not.toBeInTheDocument();
    await user.type(screen.getByLabelText(/^Name/), "Wifi");
    await user.type(screen.getByLabelText("Notes"), "pw is hunter2");
    await user.click(screen.getByRole("button", { name: "Create item" }));
    await waitFor(() => expect(api.called("POST", "/api/items")).toHaveLength(1));
    const call = cryptoCall.mock.calls.find((c) => c[0] === "createItem");
    expect((call?.[1] as { content: unknown } | undefined)?.content).toEqual({
      type: "note",
      name: "Wifi",
      notes: "pw is hunter2",
    });
  });
});

describe("edit item", () => {
  function setup(putResponses: Array<() => unknown>) {
    const world = {
      vaults: [vaultView()],
      items: [itemView({ id: ITEM_1, revision: 1 })],
      contents: { [ITEM_1]: loginContent() },
      ops: {
        updateItem: (args: unknown) => ({
          body: { ...createBody, revision: (args as { revision: number }).revision },
        }),
      } as Record<string, (args: unknown) => unknown>,
    };
    const puts = [...putResponses];
    const api = mockApi({
      ...baseRoutes,
      [`PUT /api/items/${ITEM_1}`]: () => (puts.shift() ?? (() => ({ item: itemWire() })))(),
    });
    mockVaultWorld(world);
    return { world, api };
  }

  it("loads the decrypted item into the form and sends the revision it was based on", async () => {
    const { api } = setup([() => ({ item: itemWire({ revision: 2 }) })]);
    const user = userEvent.setup();
    renderApp(`/vault?item=${ITEM_1}&mode=edit`, { locked: false });
    const name = await screen.findByLabelText(/^Name/);
    expect(name).toHaveValue("GitHub");
    expect(screen.getByLabelText("Username or email")).toHaveValue("alice@example.com");
    await user.clear(name);
    await user.type(name, "GitHub (work)");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(api.called("PUT", `/api/items/${ITEM_1}`)).toHaveLength(1));
    const call = cryptoCall.mock.calls.find((c) => c[0] === "updateItem");
    expect(call?.[1]).toMatchObject({ id: ITEM_1, revision: 1 });
    expect((call?.[1] as { content: { name: string } } | undefined)?.content.name).toBe(
      "GitHub (work)",
    );
  });

  it("handles a revision conflict: reloads, keeps the edits and saves on top of the latest", async () => {
    const { api, world } = setup([
      () => apiError(409, "revision_conflict", "stale", { currentRevision: 2 }),
      () => ({ item: itemWire({ revision: 3 }) }),
    ]);
    const user = userEvent.setup();
    renderApp(`/vault?item=${ITEM_1}&mode=edit`, { locked: false });
    const name = await screen.findByLabelText(/^Name/);
    await user.clear(name);
    await user.type(name, "My edit");

    // Somebody else saved revision 2 meanwhile; the next sync brings it.
    world.items = [itemView({ id: ITEM_1, revision: 2, name: "Their edit" })];
    world.contents = { [ITEM_1]: loginContent({ name: "Their edit" }) };

    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText("This item changed while you were editing")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
    expect(screen.getByLabelText(/^Name/)).toHaveValue("My edit");

    await user.click(screen.getByRole("button", { name: "Keep my edits" }));
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(api.called("PUT", `/api/items/${ITEM_1}`)).toHaveLength(2));
    const updates = cryptoCall.mock.calls.filter((c) => c[0] === "updateItem");
    expect(updates.map((c) => (c[1] as { revision: number }).revision)).toEqual([1, 2]);
    expect(api.called("PUT", `/api/items/${ITEM_1}`)[1]?.body).toMatchObject({ revision: 2 });
  });

  it("can discard the edits and load the latest version after a conflict", async () => {
    const { world } = setup([
      () => apiError(409, "revision_conflict", "stale", { currentRevision: 2 }),
    ]);
    const user = userEvent.setup();
    renderApp(`/vault?item=${ITEM_1}&mode=edit`, { locked: false });
    const name = await screen.findByLabelText(/^Name/);
    await user.clear(name);
    await user.type(name, "My edit");
    world.items = [itemView({ id: ITEM_1, revision: 2, name: "Their edit" })];
    world.contents = { [ITEM_1]: loginContent({ name: "Their edit" }) };
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await user.click(await screen.findByRole("button", { name: "Load latest version" }));
    expect(screen.getByLabelText(/^Name/)).toHaveValue("Their edit");
    expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();
  });

  it("explains a rotation_pending rejection and refreshes", async () => {
    const { api } = setup([() => apiError(409, "rotation_pending", "pending")]);
    const user = userEvent.setup();
    renderApp(`/vault?item=${ITEM_1}&mode=edit`, { locked: false });
    await screen.findByLabelText(/^Name/);
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText(/waiting for its key to be rotated/)).toBeInTheDocument();
    await waitFor(() => expect(api.called("GET", "/api/sync").length).toBeGreaterThanOrEqual(2));
  });

  it("does not offer the editor for an item I can only read", async () => {
    mockApi(baseRoutes);
    mockVaultWorld({
      vaults: [vaultView({ myRole: "viewer", isOwner: false })],
      items: [itemView({ canEdit: false })],
      contents: { [ITEM_1]: loginContent() },
    });
    renderApp(`/vault?item=${ITEM_1}&mode=edit`, { locked: false });
    expect(await screen.findByText("You can only read this item.")).toBeInTheDocument();
  });
});
