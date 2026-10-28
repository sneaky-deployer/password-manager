import { z } from "zod";
import { MAX_ITEM_PLAINTEXT_BYTES } from "./constants.ts";
import { bytes32Schema, timestampSchema, uuidSchema, versionSchema } from "./primitives.ts";

/** PLAN.md 14.1: plaintext item content before encryption. */

export const customFieldSchema = z.strictObject({
  label: z.string().max(200),
  value: z.string().max(10_000),
  hidden: z.boolean(),
});
export type CustomField = z.infer<typeof customFieldSchema>;

export const loginItemContentSchema = z.strictObject({
  type: z.literal("login"),
  name: z.string().min(1).max(200),
  username: z.string().max(1000).optional(),
  password: z.string().max(4096).optional(),
  urls: z.array(z.string().max(2048)).max(20).default([]),
  /** Full `otpauth://` URI (normalised by `packages/otp`). */
  totp: z.string().max(2048).optional(),
  notes: z.string().max(10_000).optional(),
  customFields: z.array(customFieldSchema).max(50).default([]),
  passwordUpdatedAt: timestampSchema.optional(),
});
export type LoginItemContent = z.infer<typeof loginItemContentSchema>;

export const noteItemContentSchema = z.strictObject({
  type: z.literal("note"),
  name: z.string().min(1).max(200),
  notes: z.string().max(50_000),
});
export type NoteItemContent = z.infer<typeof noteItemContentSchema>;

/** UTF-8 size of the serialized content, the quantity capped by `MAX_ITEM_PLAINTEXT_BYTES`. */
export function itemContentByteLength(content: unknown): number {
  return new TextEncoder().encode(JSON.stringify(content)).length;
}

/**
 * Discriminated union on `type`. Unknown keys are rejected (not silently dropped) so an older
 * client never re-saves an item and loses fields written by a newer one. The serialized content
 * must fit in 64 KiB.
 */
export const itemContentSchema = z
  .discriminatedUnion("type", [loginItemContentSchema, noteItemContentSchema])
  .refine((content) => itemContentByteLength(content) <= MAX_ITEM_PLAINTEXT_BYTES, {
    message: `Item is larger than ${MAX_ITEM_PLAINTEXT_BYTES} bytes`,
  });
/** Parsed content (defaults applied). */
export type ItemContent = z.infer<typeof itemContentSchema>;
/** Content as a form/editor may produce it (`urls` and `customFields` optional). */
export type ItemContentInput = z.input<typeof itemContentSchema>;

/** Vault metadata plaintext, encrypted with the vault key. */
export const vaultMetaSchema = z.strictObject({
  name: z.string().trim().min(1).max(100),
  icon: z.string().max(64).optional(),
  color: z.string().max(32).optional(),
});
export type VaultMeta = z.infer<typeof vaultMetaSchema>;

/** Plaintext inside a sealed box that carries a vault key or item key (PLAN.md 9.3). */
export const sealedKeyPayloadSchema = z.strictObject({
  v: z.literal(1),
  type: z.enum(["vault", "item"]),
  id: uuidSchema,
  keyVersion: versionSchema,
  key: bytes32Schema,
});
export type SealedKeyPayload = z.infer<typeof sealedKeyPayloadSchema>;
