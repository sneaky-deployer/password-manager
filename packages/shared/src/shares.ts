import { z } from "zod";
import { ITEM_SHARE_ROLES, SHARE_STATUSES, VAULT_INVITE_ROLES } from "./constants.ts";
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

/**
 * Single-item share. `sealedKey` (the item key sealed to the recipient) is only present on the
 * requesting user's own share; shares of other recipients are listed without it. `email` and
 * `publicKey` let a vault member re-seal a rotated item key for the remaining recipients.
 */
export const itemShareWireSchema = z.strictObject({
  id: uuidSchema,
  itemId: uuidSchema,
  vaultId: uuidSchema,
  userId: uuidSchema,
  email: emailSchema,
  publicKey: bytes32Schema,
  role: z.enum(ITEM_SHARE_ROLES),
  status: z.enum(SHARE_STATUSES),
  /** Item key version that `sealedKey` carries. */
  keyVersion: versionSchema,
  invitedBy: uuidSchema.nullable(),
  sealedKey: sealedBoxSchema.optional(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type ItemShareWire = z.infer<typeof itemShareWireSchema>;

/** `POST /items/:id/shares` (`keyVersion` is the item key version that was sealed). */
export const shareItemRequestSchema = z.strictObject({
  userId: uuidSchema,
  role: z.enum(ITEM_SHARE_ROLES),
  keyVersion: versionSchema,
  sealedKey: sealedBoxSchema,
});
export type ShareItemRequest = z.infer<typeof shareItemRequestSchema>;
export const shareItemResponseSchema = z.strictObject({ share: itemShareWireSchema });
export type ShareItemResponse = z.infer<typeof shareItemResponseSchema>;

/**
 * `DELETE /items/:id/shares/:shareId`. Afterwards the client rotates the item key by calling
 * `PUT /items/:id` with a new `itemKeyVersion` and `shareKeys` for the remaining shares.
 */
export const revokeItemShareResponseSchema = okResponseSchema;
export type RevokeItemShareResponse = z.infer<typeof revokeItemShareResponseSchema>;

/** `/items/:id/shares/:shareId` */
export const itemShareParamsSchema = z.strictObject({ id: uuidSchema, shareId: uuidSchema });
export type ItemShareParams = z.infer<typeof itemShareParamsSchema>;

// --- Pending invitations -----------------------------------------------------------------------

const pendingInviterSchema = {
  invitedBy: uuidSchema,
  invitedByEmail: emailSchema,
  createdAt: timestampSchema,
};

/** Invitation to a whole vault. `id` is the membership id used with accept/decline. */
export const pendingVaultShareSchema = z.strictObject({
  kind: z.literal("vault"),
  id: uuidSchema,
  vaultId: uuidSchema,
  role: z.enum(VAULT_INVITE_ROLES),
  keyVersion: versionSchema,
  /** Vault key sealed to me; opening it lets the UI show the vault name before accepting. */
  sealedKey: sealedBoxSchema,
  encryptedMeta: metaEnvelopeSchema,
  ...pendingInviterSchema,
});
export type PendingVaultShare = z.infer<typeof pendingVaultShareSchema>;

/** Invitation to a single item. `id` is the item share id used with accept/decline. */
export const pendingItemShareSchema = z.strictObject({
  kind: z.literal("item"),
  id: uuidSchema,
  itemId: uuidSchema,
  vaultId: uuidSchema,
  role: z.enum(ITEM_SHARE_ROLES),
  keyVersion: versionSchema,
  sealedKey: sealedBoxSchema,
  ...pendingInviterSchema,
});
export type PendingItemShare = z.infer<typeof pendingItemShareSchema>;

export const pendingShareSchema = z.discriminatedUnion("kind", [
  pendingVaultShareSchema,
  pendingItemShareSchema,
]);
export type PendingShare = z.infer<typeof pendingShareSchema>;

/** `GET /shares/pending` */
export const pendingSharesResponseSchema = z.strictObject({ shares: z.array(pendingShareSchema) });
export type PendingSharesResponse = z.infer<typeof pendingSharesResponseSchema>;

/**
 * `POST /shares/:id/accept` and `POST /shares/:id/decline`. `:id` is a vault membership id or an
 * item share id (both are server-generated UUIDs; the server looks the id up in both tables).
 */
export const acceptShareRequestSchema = emptyRequestSchema;
export type AcceptShareRequest = z.infer<typeof acceptShareRequestSchema>;
export const acceptShareResponseSchema = okResponseSchema;
export type AcceptShareResponse = z.infer<typeof acceptShareResponseSchema>;
export const declineShareRequestSchema = emptyRequestSchema;
export type DeclineShareRequest = z.infer<typeof declineShareRequestSchema>;
export const declineShareResponseSchema = okResponseSchema;
export type DeclineShareResponse = z.infer<typeof declineShareResponseSchema>;

// --- User lookup -------------------------------------------------------------------------------

/** `GET /users/lookup?email=` */
export const userLookupQuerySchema = z.strictObject({ email: emailSchema });
export type UserLookupQuery = z.infer<typeof userLookupQuerySchema>;
export const userLookupResponseSchema = z.strictObject({
  userId: uuidSchema,
  email: emailSchema,
  publicKey: bytes32Schema,
});
export type UserLookupResponse = z.infer<typeof userLookupResponseSchema>;
