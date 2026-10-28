import { z } from "zod";
import {
  emptyRequestSchema,
  envelopeSchema,
  okResponseSchema,
  sealedBoxSchema,
  smallEnvelopeSchema,
  timestampSchema,
  uuidSchema,
  versionSchema,
} from "./primitives.ts";

/** Item as stored and served (contract.md). The server never sees plaintext. */
export const itemWireSchema = z.strictObject({
  id: uuidSchema,
  vaultId: uuidSchema,
  itemKeyVersion: versionSchema,
  /** Item key (IK) under the vault key, AAD `pm:v1:itemkey:{vaultId}:{itemId}:{vaultKeyVersion}`. */
  wrappedKey: smallEnvelopeSchema,
  vaultKeyVersion: versionSchema,
  /** Item content under IK, AAD `pm:v1:item:{itemId}:{itemKeyVersion}`. */
  encryptedData: envelopeSchema,
  /** Optimistic concurrency counter, starts at 1 and increments on every content change. */
  revision: versionSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  trashedAt: timestampSchema.nullable(),
  createdBy: uuidSchema,
  updatedBy: uuidSchema,
});
export type ItemWire = z.infer<typeof itemWireSchema>;

/** The ciphertext fields shared by create, update and rotation entries. */
export const itemCipherFieldsSchema = z.strictObject({
  itemKeyVersion: versionSchema,
  wrappedKey: smallEnvelopeSchema,
  vaultKeyVersion: versionSchema,
  encryptedData: envelopeSchema,
});
export type ItemCipherFields = z.infer<typeof itemCipherFieldsSchema>;

/** `POST /items` */
export const createItemRequestSchema = z.strictObject({
  id: uuidSchema,
  vaultId: uuidSchema,
  ...itemCipherFieldsSchema.shape,
});
export type CreateItemRequest = z.infer<typeof createItemRequestSchema>;
export const createItemResponseSchema = z.strictObject({ item: itemWireSchema });
export type CreateItemResponse = z.infer<typeof createItemResponseSchema>;

/**
 * `PUT /items/:id`. `revision` is the revision the client last saw; a stale value gives
 * `409 revision_conflict`. Recipients of a single-item share cannot wrap under the vault key:
 * they resend `wrappedKey`/`vaultKeyVersion` exactly as received and only change `encryptedData`.
 *
 * `shareKeys` is only for item key rotation after an item share was revoked (PLAN.md 11.4): with
 * a new `itemKeyVersion` the client re-seals the new item key for every remaining share, in the
 * same atomic update. (Added to the plan's API; there was no other place to upload them.)
 */
export const updateItemRequestSchema = z.strictObject({
  ...itemCipherFieldsSchema.shape,
  revision: versionSchema,
  shareKeys: z
    .array(z.strictObject({ shareId: uuidSchema, sealedKey: sealedBoxSchema }))
    .max(100)
    .optional(),
});
export type UpdateItemRequest = z.infer<typeof updateItemRequestSchema>;
export const updateItemResponseSchema = z.strictObject({ item: itemWireSchema });
export type UpdateItemResponse = z.infer<typeof updateItemResponseSchema>;

/** `POST /items/:id/trash` */
export const trashItemRequestSchema = emptyRequestSchema;
export type TrashItemRequest = z.infer<typeof trashItemRequestSchema>;
export const trashItemResponseSchema = z.strictObject({ item: itemWireSchema });
export type TrashItemResponse = z.infer<typeof trashItemResponseSchema>;

/** `POST /items/:id/restore` */
export const restoreItemRequestSchema = emptyRequestSchema;
export type RestoreItemRequest = z.infer<typeof restoreItemRequestSchema>;
export const restoreItemResponseSchema = z.strictObject({ item: itemWireSchema });
export type RestoreItemResponse = z.infer<typeof restoreItemResponseSchema>;

/** `DELETE /items/:id`: permanent delete, only for items already in the trash. */
export const deleteItemResponseSchema = okResponseSchema;
export type DeleteItemResponse = z.infer<typeof deleteItemResponseSchema>;

/**
 * `POST /items/:id/move`: the item key is unchanged (so `encryptedData` and `itemKeyVersion`
 * stay as they are); the client re-wraps it under the target vault key, which changes the AAD
 * (`vaultId`) and `vaultKeyVersion`.
 */
export const moveItemRequestSchema = z.strictObject({
  targetVaultId: uuidSchema,
  wrappedKey: smallEnvelopeSchema,
  vaultKeyVersion: versionSchema,
  revision: versionSchema,
});
export type MoveItemRequest = z.infer<typeof moveItemRequestSchema>;
export const moveItemResponseSchema = z.strictObject({ item: itemWireSchema });
export type MoveItemResponse = z.infer<typeof moveItemResponseSchema>;
