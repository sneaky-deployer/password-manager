import { describe, expect, it } from "vitest";
import { itemView, vaultView } from "../../test/vault-fixtures.ts";
import { filterItems, matchesSearch, writableVaults } from "./filters.ts";
import { avatarLetter, safeHttpUrl } from "./item-utils.ts";

const a = itemView({
  id: "a",
  name: "alpha",
  username: "Zed",
  urls: ["https://one.test"],
  updatedAt: 1,
});
const b = itemView({
  id: "b",
  name: "Beta",
  username: undefined,
  urls: ["https://TWO.test/x"],
  updatedAt: 3,
  type: "note",
});
const c = itemView({ id: "c", name: "gamma", trashed: true, updatedAt: 2 });
const d = itemView({ id: "d", name: "delta", vaultId: "other", sharedWithMe: true, updatedAt: 4 });

describe("filterItems", () => {
  it("scopes", () => {
    const all = [a, b, c, d];
    expect(filterItems(all, { scope: { kind: "all" } }).map((i) => i.id)).toEqual(["a", "b", "d"]);
    expect(filterItems(all, { scope: { kind: "trash" } }).map((i) => i.id)).toEqual(["c"]);
    expect(filterItems(all, { scope: { kind: "shared" } }).map((i) => i.id)).toEqual(["d"]);
    expect(filterItems(all, { scope: { kind: "vault", vaultId: "other" } })).toEqual([]);
  });

  it("matches name, username and urls case-insensitively", () => {
    expect(matchesSearch(a, "ALP")).toBe(true);
    expect(matchesSearch(a, "zed")).toBe(true);
    expect(matchesSearch(b, "two.TEST")).toBe(true);
    expect(matchesSearch(a, "nope")).toBe(false);
    expect(matchesSearch(a, "   ")).toBe(true);
  });

  it("filters by type and sorts", () => {
    const all = [a, b, d];
    expect(filterItems(all, { scope: { kind: "all" }, type: "note" }).map((i) => i.id)).toEqual([
      "b",
    ]);
    expect(filterItems(all, { scope: { kind: "all" }, sort: "name" }).map((i) => i.id)).toEqual([
      "a",
      "b",
      "d",
    ]);
    expect(filterItems(all, { scope: { kind: "all" }, sort: "updated" }).map((i) => i.id)).toEqual([
      "d",
      "b",
      "a",
    ]);
  });
});

describe("helpers", () => {
  it("only lets http and https URLs through", () => {
    expect(safeHttpUrl("https://a.test/x")).toBe("https://a.test/x");
    expect(safeHttpUrl("example.com")).toBe("https://example.com/");
    expect(safeHttpUrl("javascript:alert(1)")).toBeNull();
    expect(safeHttpUrl("data:text/html,<b>")).toBeNull();
    expect(safeHttpUrl("ftp://x.test")).toBeNull();
    expect(safeHttpUrl("   ")).toBeNull();
  });

  it("builds letter avatars", () => {
    expect(avatarLetter("  github")).toBe("G");
    expect(avatarLetter("")).toBe("?");
  });

  it("offers only writable vaults that are not waiting for rotation", () => {
    const vaults = [
      vaultView({ id: "1" }),
      vaultView({ id: "2", myRole: "viewer" }),
      vaultView({ id: "3", rotationPending: true }),
      vaultView({ id: "4", myRole: "editor" }),
    ];
    expect(writableVaults(vaults).map((v) => v.id)).toEqual(["1", "4"]);
  });
});
