import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cryptoCall } from "../../test/fake-crypto.ts";
import { makeUser } from "../../test/fixtures.ts";
import { apiError, mockApi } from "../../test/mock-api.ts";
import { renderApp } from "../../test/render-app.tsx";
import {
  emptySyncResponse,
  ITEM_1,
  ITEM_2,
  ITEM_3,
  ITEM_4,
  itemView,
  loginContent,
  mockVaultWorld,
  VAULT_B,
  vaultView,
} from "../../test/vault-fixtures.ts";

vi.mock("../../crypto-worker/client.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../crypto-worker/client.ts")>();
  const { fakeCryptoClient } = await import("../../test/fake-crypto.ts");
  return { ...actual, cryptoClient: fakeCryptoClient() };
});

beforeEach(() => {
  cryptoCall.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

const baseRoutes = {
  "GET /api/me": () => ({ user: makeUser() }),
  "GET /api/sync": () => emptySyncResponse(),
  "GET /api/shares/pending": () => ({ shares: [] }),
};

const items = [
  itemView({
    id: ITEM_1,
    name: "GitHub",
    username: "alice@example.com",
    urls: ["https://github.com"],
    updatedAt: 100,
    hasTotp: true,
  }),
  itemView({
    id: ITEM_2,
    name: "bank",
    username: "bob",
    urls: ["https://MyBank.example/login"],
    updatedAt: 300,
  }),
  itemView({
    id: ITEM_3,
    type: "note",
    name: "Wifi",
    username: undefined,
    urls: [],
    hasPassword: false,
    updatedAt: 200,
  }),
  itemView({ id: ITEM_4, name: "Old", trashed: true, trashedAt: 5 }),
];
const contents = {
  [ITEM_1]: loginContent({
    totp: "otpauth://totp/GitHub:alice?secret=JBSWY3DPEHPK3PXP&issuer=GitHub",
  }),
  [ITEM_2]: loginContent({
    name: "bank",
    username: "bob",
    password: "bank-pass",
    urls: ["https://MyBank.example/login", "javascript:alert(1)"],
    notes: "pin 1234",
    customFields: [
      { label: "Memorable", value: "blue-whale", hidden: true },
      { label: "Branch", value: "Main St", hidden: false },
    ],
  }),
  [ITEM_3]: { type: "note", name: "Wifi", notes: "router password" } as const,
};

function world(
  extra: Parameters<typeof mockVaultWorld>[0] extends infer W ? Partial<W> : never = {},
) {
  mockVaultWorld({
    vaults: [
      vaultView(),
      vaultView({
        id: VAULT_B,
        name: "Work",
        color: "teal",
        isOwner: false,
        myRole: "editor",
        memberCount: 3,
      }),
    ],
    items,
    contents,
    ...extra,
  });
}

async function openVault(url = "/vault") {
  mockApi(baseRoutes);
  world();
  const user = userEvent.setup();
  const writeText = vi.spyOn(navigator.clipboard, "writeText");
  const view = renderApp(url, { locked: false });
  await screen.findByRole("heading", { name: "All items" });
  return { user, writeText, ...view };
}

function rowNames() {
  return within(screen.getByRole("list", { name: "Items" }))
    .getAllByRole("link")
    .map((row) => row.textContent ?? "");
}

describe("sidebar", () => {
  it("lists all items, vaults with role and colour, shared, trash and a new-vault button", async () => {
    await openVault();
    const nav = screen.getByRole("navigation", { name: "Vaults" });
    expect(within(nav).getByRole("link", { name: /All items/ })).toHaveTextContent("3");
    expect(within(nav).getByRole("link", { name: /Personal/ })).toBeInTheDocument();
    const work = within(nav).getByRole("link", { name: /Work/ });
    expect(work).toHaveTextContent("Editor");
    expect(within(nav).getByRole("link", { name: /Trash/ })).toHaveTextContent("1");
    expect(within(nav).getByRole("link", { name: /Shared with me/ })).toBeInTheDocument();
    expect(within(nav).getByRole("button", { name: "+ New vault" })).toBeInTheDocument();
  });

  it("shows the number of pending invitations", async () => {
    mockApi({
      ...baseRoutes,
      "GET /api/shares/pending": () => ({
        shares: [
          {
            kind: "item",
            id: ITEM_1,
            itemId: ITEM_2,
            vaultId: VAULT_B,
            role: "viewer",
            keyVersion: 1,
            sealedKey: "A".repeat(64),
            invitedBy: ITEM_3,
            invitedByEmail: "bob@example.com",
            createdAt: 1,
          },
        ],
      }),
    });
    world();
    renderApp("/vault", { locked: false });
    const link = await screen.findByRole("link", { name: /Invitations/ });
    await waitFor(() => expect(link).toHaveTextContent("1"));
  });
});

describe("item list", () => {
  it("shows items without trash, sorted by name, and filters by search, type and sort", async () => {
    const { user } = await openVault();
    expect(rowNames().map((t) => t.split(/alice|bob/)[0])).toEqual([
      expect.stringContaining("bank"),
      expect.stringContaining("GitHub"),
      expect.stringContaining("Wifi"),
    ]);
    expect(screen.queryByText("Old")).not.toBeInTheDocument();

    const search = screen.getByRole("searchbox", { name: "Search items" });
    await user.type(search, "GITHUB");
    expect(rowNames()).toHaveLength(1);
    await user.clear(search);
    await user.type(search, "mybank.EXAMPLE");
    expect(rowNames()).toHaveLength(1);
    expect(rowNames()[0]).toContain("bank");
    await user.clear(search);
    await user.type(search, "BOB");
    expect(rowNames()).toHaveLength(1);
    await user.clear(search);
    await user.type(search, "zzz");
    expect(screen.getByText("No matches")).toBeInTheDocument();
    await user.clear(search);

    await user.selectOptions(screen.getByLabelText("Filter by type"), "note");
    expect(rowNames()).toHaveLength(1);
    await user.selectOptions(screen.getByLabelText("Filter by type"), "all");

    await user.selectOptions(screen.getByLabelText("Sort by"), "updated");
    expect(rowNames()[0]).toContain("bank");
    expect(rowNames()[2]).toContain("GitHub");
  });

  it("marks items that have a one-time code", async () => {
    await openVault();
    const github = screen.getByRole("link", { name: /GitHub/ });
    expect(github).toHaveTextContent("TOTP");
  });

  it("moves focus with the arrow keys and opens an item with Enter", async () => {
    const { user, router } = await openVault();
    const rows = within(screen.getByRole("list", { name: "Items" })).getAllByRole("link");
    rows[0]?.focus();
    await user.keyboard("{ArrowDown}");
    expect(rows[1]).toHaveFocus();
    await user.keyboard("{ArrowDown}{ArrowDown}");
    expect(rows[2]).toHaveFocus();
    await user.keyboard("{ArrowUp}");
    expect(rows[1]).toHaveFocus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(router.state.location.search).toMatchObject({ item: ITEM_1 }));
    expect(await screen.findByRole("heading", { name: "GitHub", level: 2 })).toBeInTheDocument();
  });

  it("shows an empty state for an empty vault", async () => {
    mockApi(baseRoutes);
    mockVaultWorld({ vaults: [vaultView()], items: [] });
    renderApp("/vault", { locked: false });
    expect(await screen.findByText("No items yet")).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: /Create an item|New item/ }).length).toBeGreaterThan(
      0,
    );
  });

  it("shows an error state with a retry when the first sync fails", async () => {
    mockApi({ ...baseRoutes, "GET /api/sync": () => apiError(500, "internal_error", "boom") });
    world();
    renderApp("/vault", { locked: false });
    expect(await screen.findByText("Could not load your vault")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("limits the vault view to its own items", async () => {
    mockApi(baseRoutes);
    mockVaultWorld({
      vaults: [
        vaultView(),
        vaultView({ id: VAULT_B, name: "Work", myRole: "editor", isOwner: false }),
      ],
      items: [
        itemView({ id: ITEM_1, name: "InPersonal" }),
        itemView({ id: ITEM_2, name: "InWork", vaultId: VAULT_B }),
      ],
    });
    renderApp(`/vault/v/${VAULT_B}`, { locked: false });
    expect(await screen.findByRole("heading", { name: "Work" })).toBeInTheDocument();
    expect(screen.getByText("InWork")).toBeInTheDocument();
    expect(screen.queryByText("InPersonal")).not.toBeInTheDocument();
  });
});

describe("item detail", () => {
  it("copies fields, reveals the password and opens only http(s) links safely", async () => {
    const { user, writeText } = await openVault(`/vault?item=${ITEM_2}`);
    expect(await screen.findByRole("heading", { name: "bank", level: 2 })).toBeInTheDocument();

    expect(screen.getByTestId("secret-Password")).toHaveTextContent("••••");
    expect(screen.queryByText("bank-pass")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Reveal password" }));
    expect(screen.getByTestId("secret-Password")).toHaveTextContent("bank-pass");
    await user.click(screen.getByRole("button", { name: "Hide password" }));
    expect(screen.getByTestId("secret-Password")).toHaveTextContent("••••");

    await user.click(screen.getByRole("button", { name: "Copy password" }));
    expect(writeText).toHaveBeenCalledWith("bank-pass");
    await user.click(screen.getByRole("button", { name: "Copy username" }));
    expect(writeText).toHaveBeenCalledWith("bob");

    const link = screen.getByRole("link", { name: /mybank\.example/i });
    expect(link).toHaveAttribute("href", "https://mybank.example/login");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(link).toHaveAttribute("target", "_blank");
    // The javascript: URL is shown as plain text, never as a link.
    expect(screen.getByText("javascript:alert(1)")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /javascript/ })).not.toBeInTheDocument();

    expect(screen.getByText("pin 1234")).toBeInTheDocument();
    expect(screen.getByText("Main St")).toBeInTheDocument();
    expect(screen.queryByText("blue-whale")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Reveal memorable" }));
    expect(screen.getByText("blue-whale")).toBeInTheDocument();
    expect(screen.getByText("Created")).toBeInTheDocument();
  });

  it("renders the one-time code component for items with a TOTP", async () => {
    await openVault(`/vault?item=${ITEM_1}`);
    expect(await screen.findByText(/GitHub/, { selector: "h2" })).toBeInTheDocument();
    // The TOTP component shows a grouped 6-digit code.
    expect(await screen.findByText(/^\d{3}\s?\d{3}$/)).toBeInTheDocument();
  });

  it("explains an unreadable item and still allows trashing it", async () => {
    mockApi(baseRoutes);
    mockVaultWorld({
      vaults: [vaultView()],
      items: [
        itemView({
          id: ITEM_1,
          name: "Unreadable item",
          readable: false,
          type: "unknown",
          urls: [],
        }),
      ],
    });
    renderApp(`/vault?item=${ITEM_1}`, { locked: false });
    expect(await screen.findByText("This item cannot be read")).toBeInTheDocument();
    expect(screen.getByText(ITEM_1)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Move to trash" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Edit" })).not.toBeInTheDocument();
  });

  it("hides write actions for a viewer", async () => {
    mockApi(baseRoutes);
    mockVaultWorld({
      vaults: [vaultView({ myRole: "viewer", isOwner: false })],
      items: [itemView({ canEdit: false, canManage: false, canShare: false })],
      contents,
    });
    renderApp(`/vault?item=${ITEM_1}`, { locked: false });
    await screen.findByRole("heading", { name: "GitHub", level: 2 });
    expect(screen.queryByRole("link", { name: "Edit" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Move to trash" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Share" })).not.toBeInTheDocument();
  });

  it("moves an item to the trash", async () => {
    const api = mockApi({
      ...baseRoutes,
      "POST /api/items/10000000-0000-4000-8000-000000000002/trash": () => ({ item: {} }),
    });
    world();
    const user = userEvent.setup();
    renderApp(`/vault?item=${ITEM_2}`, { locked: false });
    // The mocked response is not a real item; only the call matters.
    await user.click(await screen.findByRole("button", { name: "Move to trash" }));
    await waitFor(() => expect(api.called("POST", `/api/items/${ITEM_2}/trash`)).toHaveLength(1));
  });
});

describe("trash", () => {
  it("restores, deletes forever after confirming, and empties the trash", async () => {
    const api = mockApi({
      ...baseRoutes,
      [`POST /api/items/${ITEM_4}/restore`]: () => ({ item: {} }),
      [`DELETE /api/items/${ITEM_4}`]: () => ({ ok: true }),
    });
    world({ contents: { [ITEM_4]: loginContent({ name: "Old" }) } });
    const user = userEvent.setup();
    renderApp(`/vault/trash?item=${ITEM_4}`, { locked: false });
    await screen.findByRole("heading", { name: "Old", level: 2 });

    await user.click(screen.getByRole("button", { name: "Restore" }));
    await waitFor(() => expect(api.called("POST", `/api/items/${ITEM_4}/restore`)).toHaveLength(1));

    await user.click(screen.getByRole("button", { name: "Delete forever" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Delete this item forever?")).toBeInTheDocument();
    expect(api.called("DELETE", `/api/items/${ITEM_4}`)).toHaveLength(0);
    await user.click(within(dialog).getByRole("button", { name: "Delete forever" }));
    await waitFor(() => expect(api.called("DELETE", `/api/items/${ITEM_4}`)).toHaveLength(1));

    await user.click(screen.getByRole("button", { name: "Empty trash" }));
    const confirm = await screen.findByRole("dialog");
    await user.click(within(confirm).getByRole("button", { name: "Empty trash" }));
    await waitFor(() => expect(api.called("DELETE", `/api/items/${ITEM_4}`)).toHaveLength(2));
  });
});
