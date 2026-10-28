// Helpers for the vault / item / sharing route tests. They build valid request bodies for the
// @pm/shared schemas (ciphertext is random: the server never looks inside) and seed rows directly.
import type { ZodType, z } from "zod";
import type { User, Vault, VaultMember } from "../src/db/schema.ts";
import { vaultMembers, vaults } from "../src/db/schema.ts";
import { newId } from "../src/lib/crypto.ts";
import { createVaultWithOwner, db, fakeBlob, signedInClient, type TestClient } from "./helpers.ts";

export const uuid = () => crypto.randomUUID();
/** Plausible sealed box (80 bytes -> 107 chars; schema minimum is 64 chars). */
export const sealed = () => fakeBlob(80);
/** Plausible envelope for item content. */
export const envelope = (bytes = 120) => fakeBlob(bytes);
/** Plausible wrapped item key. */
export const wrapped = () => fakeBlob(72);
/** Plausible encrypted vault metadata. */
export const meta = () => fakeBlob(60);

/** Parses `body` with a shared schema and returns the typed result; throws with zod's message. */
export function parseWith<S extends ZodType>(schema: S, body: unknown): z.infer<S> {
  return schema.parse(body);
}

export async function body<T = unknown>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

export function createItemBody(vaultId: string, keyVersion = 1, overrides: object = {}) {
  return {
    id: uuid(),
    vaultId,
    itemKeyVersion: 1,
    wrappedKey: wrapped(),
    vaultKeyVersion: keyVersion,
    encryptedData: envelope(),
    ...overrides,
  };
}

export function updateItemBody(
  item: {
    revision: number;
    itemKeyVersion: number;
    wrappedKey: string;
    vaultKeyVersion: number;
  },
  overrides: object = {},
) {
  return {
    itemKeyVersion: item.itemKeyVersion,
    wrappedKey: item.wrappedKey,
    vaultKeyVersion: item.vaultKeyVersion,
    encryptedData: envelope(),
    revision: item.revision,
    ...overrides,
  };
}

/** Seeds a membership row for `user` in `vault` (the owner row comes from `createVaultWithOwner`). */
export async function addMember(
  vault: Pick<Vault, "id" | "keyVersion">,
  user: Pick<User, "id">,
  role: VaultMember["role"],
  options: { status?: "pending" | "active"; invitedBy?: string; keyVersion?: number } = {},
): Promise<VaultMember> {
  const now = Date.now();
  const [row] = await db
    .insert(vaultMembers)
    .values({
      id: newId(),
      vaultId: vault.id,
      userId: user.id,
      role,
      keyVersion: options.keyVersion ?? vault.keyVersion,
      sealedKey: sealed(),
      status: options.status ?? "active",
      invitedBy: options.invitedBy ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  if (!row) throw new Error("addMember failed");
  return row;
}

export interface Actor {
  user: User;
  client: TestClient;
}

/** A vault with one signed-in user per role, plus an outsider and a pending invitee. */
export async function vaultWithRoles() {
  const owner = await signedInClient();
  const manager = await signedInClient();
  const editor = await signedInClient();
  const viewer = await signedInClient();
  const outsider = await signedInClient();
  const { vault, membership } = await createVaultWithOwner(owner.user);
  const managerMember = await addMember(vault, manager.user, "manager");
  const editorMember = await addMember(vault, editor.user, "editor");
  const viewerMember = await addMember(vault, viewer.user, "viewer");
  return {
    vault,
    owner: { ...owner, member: membership },
    manager: { ...manager, member: managerMember },
    editor: { ...editor, member: editorMember },
    viewer: { ...viewer, member: viewerMember },
    outsider,
  };
}

/** Makes everything in the database look like it was last changed at `timestamp`. */
export async function backdateAll(timestamp: number): Promise<void> {
  const { itemShares, items } = await import("../src/db/schema.ts");
  await db.update(vaults).set({ updatedAt: timestamp, createdAt: timestamp });
  await db.update(vaultMembers).set({ updatedAt: timestamp, createdAt: timestamp });
  await db.update(items).set({ updatedAt: timestamp, createdAt: timestamp });
  await db.update(itemShares).set({ updatedAt: timestamp, createdAt: timestamp });
}
