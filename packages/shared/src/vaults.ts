import { z } from "zod";
import {
  MAX_ROTATION_CHUNK_ITEMS,
  SHARE_STATUSES,
  VAULT_INVITE_ROLES,
  VAULT_ROLES,
} from "./constants.ts";
import { itemCipherFieldsSchema } from "./items.ts";
import {
  bytes32Schema,
  emailSchema,
  emptyRequestSchema,
  metaEnvelopeSchema,
  okResponseSchema,
  sealedBoxSchema,
  timestampSchema,
  uuidSchema,
  versionSchema,
} from "./primitives.ts";

/** Vault as served to a member. `encryptedMeta` is `{ name, icon?, color? }` under the vault key. */
export const vaultWireSchema = z.strictObject({
  id: uuidSchema,
  ownerId: uuidSchema,
  keyVersion: versionSchema,
  encryptedMeta: metaEnvelopeSchema,
  /** True after a member was removed and the new key version has not been finalised yet. */
  rotationPending: z.boolean(),
  /** The requesting user's role in this vault. */
  myRole: z.enum(VAULT_ROLES),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type VaultWire = z.infer<typeof vaultWireSchema>;

/**
 * A membership row. `email` and `publicKey` are included so that a manager can seal a new vault
 * key for every member during rotation. `sealedKey` is only present on the requesting user's
 * own membership (the vault key sealed to them); other members are listed without it.
 */
export const vaultMemberWireSchema = z.strictObject({
  id: uuidSchema,
  vaultId: uuidSchema,
  userId: uuidSchema,
  email: emailSchema,
  publicKey: bytes32Schema,
  role: z.enum(VAULT_ROLES),
  status: z.enum(SHARE_STATUSES),
  keyVersion: versionSchema,
  invitedBy: uuidSchema.nullable(),
  sealedKey: sealedBoxSchema.optional(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type VaultMemberWire = z.infer<typeof vaultMemberWireSchema>;

/** `POST /vaults`: create a vault; the server adds the owner membership. */
export const createVaultRequestSchema = z.strictObject({
  id: uuidSchema,
  keyVersion: z.literal(1),
  encryptedMeta: metaEnvelopeSchema,
  /** Vault key sealed to the creator's own public key. */
  sealedKey: sealedBoxSchema,
});
export type CreateVaultRequest = z.infer<typeof createVaultRequestSchema>;
export const createVaultResponseSchema = z.strictObject({
  vault: vaultWireSchema,
  member: vaultMemberWireSchema,
});
export type CreateVaultResponse = z.infer<typeof createVaultResponseSchema>;

/**
 * `PATCH /vaults/:id`: replace the encrypted metadata. `keyVersion` is the version the client
 * encrypted with; the server rejects a mismatch (`key_version_mismatch`) so metadata encrypted
 * under an old key cannot land after a rotation.
 */
export const updateVaultRequestSchema = z.strictObject({
  keyVersion: versionSchema,
  encryptedMeta: metaEnvelopeSchema,
});
export type UpdateVaultRequest = z.infer<typeof updateVaultRequestSchema>;
export const updateVaultResponseSchema = z.strictObject({ vault: vaultWireSchema });
export type UpdateVaultResponse = z.infer<typeof updateVaultResponseSchema>;

/** `DELETE /vaults/:id` (owner only) */
export const deleteVaultResponseSchema = okResponseSchema;
export type DeleteVaultResponse = z.infer<typeof deleteVaultResponseSchema>;

/**
 * `POST /vaults/:id/members`: invite a user (membership starts as `pending`). `keyVersion` is
 * the vault key version that was sealed; it must equal the vault's current version.
 */
export const inviteMemberRequestSchema = z.strictObject({
  userId: uuidSchema,
  role: z.enum(VAULT_INVITE_ROLES),
  keyVersion: versionSchema,
  sealedKey: sealedBoxSchema,
});
export type InviteMemberRequest = z.infer<typeof inviteMemberRequestSchema>;
export const inviteMemberResponseSchema = z.strictObject({ member: vaultMemberWireSchema });
export type InviteMemberResponse = z.infer<typeof inviteMemberResponseSchema>;

/** `PATCH /vaults/:id/members/:memberId` */
export const updateMemberRequestSchema = z.strictObject({ role: z.enum(VAULT_INVITE_ROLES) });
export type UpdateMemberRequest = z.infer<typeof updateMemberRequestSchema>;
export const updateMemberResponseSchema = z.strictObject({ member: vaultMemberWireSchema });
export type UpdateMemberResponse = z.infer<typeof updateMemberResponseSchema>;

/**
 * `DELETE /vaults/:id/members/:memberId`. When `rotationPending` is true the vault now needs a
 * key rotation (see `rotateVaultRequestSchema`) and the remover's client should start it.
 */
export const removeMemberResponseSchema = z.strictObject({
  ok: z.literal(true),
  rotationPending: z.boolean(),
});
export type RemoveMemberResponse = z.infer<typeof removeMemberResponseSchema>;

/** `POST /vaults/:id/leave`: no rotation needed. */
export const leaveVaultRequestSchema = emptyRequestSchema;
export type LeaveVaultRequest = z.infer<typeof leaveVaultRequestSchema>;
export const leaveVaultResponseSchema = okResponseSchema;
export type LeaveVaultResponse = z.infer<typeof leaveVaultResponseSchema>;

// --- Vault key rotation (PLAN.md 11.4) -----------------------------------------------------------

/**
 * Key rotation flow, after a member was removed (`rotationPending: true`):
 *
 * 1. The client of a manager/owner generates a new vault key `VK'` (`newKeyVersion` =
 *    current + 1) and, for every item in the vault (including trashed ones), a new item key
 *    `IK'`. It re-encrypts each item's content under `IK'`, wraps `IK'` under `VK'`, and
 *    re-encrypts the vault metadata under `VK'`.
 * 2. It uploads the items in chunks of at most {@link MAX_ROTATION_CHUNK_ITEMS} with
 *    `{ step: "chunk", newKeyVersion, items }`. Each entry carries the `revision` the client
 *    read; chunks are staged by the server and do not change live data yet, so the other
 *    members keep working with the old key until the switch.
 * 3. It finishes with ONE `{ step: "finalize", newKeyVersion, encryptedMeta, memberKeys,
 *    itemShareKeys }` request: `VK'` sealed for every remaining member (the owner included) and
 *    the new item keys sealed for every single-item share inside the vault. The server checks
 *    that every item was staged and no revision moved (otherwise `409 revision_conflict` and the
 *    client restarts the rotation), then applies everything in a single `batch()`: it sets the
 *    vault's `key_version`, swaps in the staged items, stores the new sealed keys and clears
 *    `rotation_pending`.
 *
 * If the client dies half way, `rotationPending` stays true and any manager/owner client can
 * restart from step 1.
 */
export const rotatedItemSchema = z.strictObject({
  id: uuidSchema,
  /** Revision the client read before re-encrypting this item. */
  revision: versionSchema,
  ...itemCipherFieldsSchema.shape,
});
export type RotatedItem = z.infer<typeof rotatedItemSchema>;

/** One chunk of re-encrypted items. */
export const rotateVaultChunkRequestSchema = z.strictObject({
  step: z.literal("chunk"),
  newKeyVersion: versionSchema,
  items: z.array(rotatedItemSchema).min(1).max(MAX_ROTATION_CHUNK_ITEMS),
});
export type RotateVaultChunkRequest = z.infer<typeof rotateVaultChunkRequestSchema>;

/** The closing request that switches the vault to the new key version. */
export const rotateVaultFinalizeRequestSchema = z.strictObject({
  step: z.literal("finalize"),
  newKeyVersion: versionSchema,
  encryptedMeta: metaEnvelopeSchema,
  memberKeys: z
    .array(z.strictObject({ memberId: uuidSchema, sealedKey: sealedBoxSchema }))
    .min(1)
    .max(200),
  itemShareKeys: z
    .array(z.strictObject({ shareId: uuidSchema, sealedKey: sealedBoxSchema }))
    .max(1000),
});
export type RotateVaultFinalizeRequest = z.infer<typeof rotateVaultFinalizeRequestSchema>;

/** `POST /vaults/:id/rotate`: discriminated on `step`. */
export const rotateVaultRequestSchema = z.discriminatedUnion("step", [
  rotateVaultChunkRequestSchema,
  rotateVaultFinalizeRequestSchema,
]);
export type RotateVaultRequest = z.infer<typeof rotateVaultRequestSchema>;

export const rotateVaultResponseSchema = z.discriminatedUnion("step", [
  z.strictObject({ step: z.literal("chunk"), accepted: z.int().nonnegative() }),
  z.strictObject({ step: z.literal("finalize"), vault: vaultWireSchema }),
]);
export type RotateVaultResponse = z.infer<typeof rotateVaultResponseSchema>;

// --- Path params -------------------------------------------------------------------------------

/** `/vaults/:id/members/:memberId` */
export const vaultMemberParamsSchema = z.strictObject({ id: uuidSchema, memberId: uuidSchema });
export type VaultMemberParams = z.infer<typeof vaultMemberParamsSchema>;
