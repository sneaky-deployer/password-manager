import { z } from "zod";
import { DELETION_ENTITIES } from "./constants.ts";
import { itemWireSchema } from "./items.ts";
import { timestampSchema, uuidSchema } from "./primitives.ts";
import { itemShareWireSchema } from "./shares.ts";
import { vaultMemberWireSchema, vaultWireSchema } from "./vaults.ts";

/** `GET /sync?since=<ms>`: omit `since` for a full sync. */
export const syncQuerySchema = z.strictObject({
  since: z.coerce.number().int().nonnegative().optional(),
});
export type SyncQuery = z.input<typeof syncQuerySchema>;

/** Tombstone for something removed since the last sync. */
export const deletionWireSchema = z.strictObject({
  entity: z.enum(DELETION_ENTITIES),
  id: uuidSchema,
  deletedAt: timestampSchema,
});
export type DeletionWire = z.infer<typeof deletionWireSchema>;

/**
 * Sync response. Store `serverTime` and send it as the next `since`.
 *
 * - `full: true` means this is a complete snapshot (no `since`, or `since` older than the
 *   tombstone retention): replace local state instead of merging, `deletions` is empty.
 * - `vaults`: vaults where I am an active member.
 * - `members`: memberships of those vaults. Only MY membership carries `sealedKey`.
 * - `items`: items in those vaults, plus items shared with me individually.
 * - `itemShares`: shares targeting me (with `sealedKey`) and the other shares on items of
 *   vaults I belong to (without `sealedKey`), needed to re-seal keys on rotation.
 * - `deletions`: tombstones since `since`.
 */
export const syncResponseSchema = z.strictObject({
  serverTime: timestampSchema,
  full: z.boolean(),
  vaults: z.array(vaultWireSchema),
  members: z.array(vaultMemberWireSchema),
  items: z.array(itemWireSchema),
  itemShares: z.array(itemShareWireSchema),
  deletions: z.array(deletionWireSchema),
});
export type SyncResponse = z.infer<typeof syncResponseSchema>;
