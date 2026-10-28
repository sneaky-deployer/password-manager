import type { Db } from "../db/client.ts";
import { auditEvents } from "../db/schema.ts";
import { newId } from "./crypto.ts";

/** Flat, primitive-only metadata. Keep it small and non-sensitive (event context, never secrets). */
export type AuditMeta = Record<string, string | number | boolean | null>;

// Key names that suggest a secret slipped into the metadata. Programmer-error guard, not a filter.
const FORBIDDEN_KEY =
  /pass(word|phrase)|secret|token|verifier|auth_?key|recovery_?key|private|phrase|^code$|otp/i;
const MAX_META_BYTES = 1024;

function serializeMeta(meta: AuditMeta): string {
  for (const key of Object.keys(meta)) {
    if (FORBIDDEN_KEY.test(key)) throw new TypeError(`Audit meta must not contain "${key}"`);
  }
  const json = JSON.stringify(meta);
  if (json.length > MAX_META_BYTES) throw new TypeError("Audit meta is too large");
  return json;
}

/**
 * Un-awaited audit insert for `db.batch([...])`, so the audit row commits atomically with the
 * action. Events: `login`, `password_changed`, `recovery_used`, `share_created`, ... Rows are
 * shown to the user under Settings > Activity and purged after 90 days. `meta` must never contain
 * secrets, keys, tokens, codes or verifiers (key names are checked, values are your job).
 */
export function auditStatement(
  db: Db,
  userId: string,
  event: string,
  meta: AuditMeta = {},
  now = Date.now(),
) {
  return db.insert(auditEvents).values({
    id: newId(),
    userId,
    event,
    meta: serializeMeta(meta),
    createdAt: now,
  });
}

export async function audit(
  db: Db,
  userId: string,
  event: string,
  meta: AuditMeta = {},
  now = Date.now(),
): Promise<void> {
  await auditStatement(db, userId, event, meta, now);
}
