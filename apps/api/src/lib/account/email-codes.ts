// Emailed one-time codes (PLAN.md 10.5, `email_codes`): `recovery`, `reset_account` (signed out)
// and `sensitive_action` (signed in). Only a hash is stored. A code is bound to its row id, expires
// after 15 minutes, allows 5 wrong guesses and works once.
import { EMAIL_CODE_LENGTH, EMAIL_CODE_MAX_ATTEMPTS, EMAIL_CODE_TTL_MINUTES } from "@pm/shared";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import { type EmailCodePurpose, emailCodes } from "../../db/schema.ts";
import { constantTimeEqual, newId, randomDigits, sha256Hex } from "../crypto.ts";

const TTL_MS = EMAIL_CODE_TTL_MINUTES * 60 * 1000;

function hashCode(id: string, code: string): Promise<string> {
  return sha256Hex(`${id}:${code}`);
}

/**
 * Creates a fresh code for (email, purpose), invalidating earlier unused ones, and returns the
 * plaintext code to email. The invalidation and the insert are one batch.
 */
export async function issueEmailCode(
  db: Db,
  email: string,
  purpose: EmailCodePurpose,
  now = Date.now(),
): Promise<string> {
  const code = randomDigits(EMAIL_CODE_LENGTH);
  const id = newId();
  await db.batch([
    db
      .update(emailCodes)
      .set({ consumedAt: now })
      .where(
        and(
          eq(emailCodes.email, email),
          eq(emailCodes.purpose, purpose),
          isNull(emailCodes.consumedAt),
        ),
      ),
    db.insert(emailCodes).values({
      id,
      email,
      purpose,
      codeHash: await hashCode(id, code),
      attempts: 0,
      expiresAt: now + TTL_MS,
      consumedAt: null,
      createdAt: now,
    }),
  ]);
  return code;
}

export interface EmailCodeCheck {
  ok: boolean;
  /** Present when ok: pass it to `consumeEmailCode` once the whole request succeeded. */
  rowId?: string;
}

/**
 * Checks `code` without using it up (a wrong guess still counts as an attempt). Use it when the
 * request may be retried with the same code, e.g. recovery start asking for a second factor.
 */
export async function checkEmailCode(
  db: Db,
  email: string,
  purpose: EmailCodePurpose,
  code: string,
  now = Date.now(),
): Promise<EmailCodeCheck> {
  const row = await db
    .select()
    .from(emailCodes)
    .where(
      and(
        eq(emailCodes.email, email),
        eq(emailCodes.purpose, purpose),
        isNull(emailCodes.consumedAt),
      ),
    )
    .orderBy(desc(emailCodes.createdAt))
    .limit(1)
    .get();
  if (!row || row.expiresAt <= now || row.attempts >= EMAIL_CODE_MAX_ATTEMPTS) {
    return { ok: false };
  }
  if (!constantTimeEqual(await hashCode(row.id, code), row.codeHash)) {
    await db
      .update(emailCodes)
      .set({ attempts: sql`${emailCodes.attempts} + 1` })
      .where(eq(emailCodes.id, row.id));
    return { ok: false };
  }
  return { ok: true, rowId: row.id };
}

/** Marks a checked code as used. Returns false if it was already consumed (concurrent request). */
export async function consumeEmailCodeRow(
  db: Db,
  rowId: string,
  now = Date.now(),
): Promise<boolean> {
  const rows = await db
    .update(emailCodes)
    .set({ consumedAt: now })
    .where(and(eq(emailCodes.id, rowId), isNull(emailCodes.consumedAt)))
    .returning({ id: emailCodes.id });
  return rows.length > 0;
}

/** Check and consume in one go. True only for a valid, unused, unexpired code. */
export async function verifyAndConsumeEmailCode(
  db: Db,
  email: string,
  purpose: EmailCodePurpose,
  code: string,
  now = Date.now(),
): Promise<boolean> {
  const check = await checkEmailCode(db, email, purpose, code, now);
  if (!check.ok || !check.rowId) return false;
  return consumeEmailCodeRow(db, check.rowId, now);
}
