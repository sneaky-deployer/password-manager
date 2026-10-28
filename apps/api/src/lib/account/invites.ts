// Invite helpers (PLAN.md 10.0, 10.1, 10.1a): token handling, the live-invite rule and the wire
// shape. The emailed token lives in the URL fragment and is stored only as SHA-256.
import type { InviteStatus, InviteWire } from "@pm/shared";
import { and, eq, gt, isNull } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import { type Invite, invites, type NewInvite, users } from "../../db/schema.ts";
import type { Config } from "../../env.ts";
import { newId, randomToken, sha256Hex } from "../crypto.ts";

/** Shared by `invites/inspect` and `auth/accept-invite`: 20 attempts per 15 minutes per IP. */
export const INVITE_LIMIT = { limit: 20, windowSeconds: 15 * 60 } as const;
export const inviteLimitKey = (ip: string) => `invite:ip:${ip}`;

export function inviteLink(config: Config, token: string): string {
  return `${config.appOrigin}/invite#t=${token}`;
}

export function inviteStatus(invite: Invite, now = Date.now()): InviteStatus {
  if (invite.acceptedAt !== null) return "accepted";
  if (invite.revokedAt !== null) return "revoked";
  if (invite.expiresAt <= now) return "expired";
  return "pending";
}

export function toInviteWire(invite: Invite, now = Date.now()): InviteWire {
  return {
    id: invite.id,
    email: invite.email,
    role: invite.role,
    kind: invite.kind,
    status: inviteStatus(invite, now),
    invitedBy: invite.invitedBy,
    expiresAt: invite.expiresAt,
    acceptedAt: invite.acceptedAt,
    revokedAt: invite.revokedAt,
    createdAt: invite.createdAt,
  };
}

/** A fresh token plus the row to insert (the DB sees only the token hash). */
export async function buildInvite(
  config: Config,
  input: Pick<NewInvite, "email" | "role" | "kind" | "invitedBy">,
  now = Date.now(),
): Promise<{ token: string; row: Invite }> {
  const token = randomToken(32);
  const row: Invite = {
    id: newId(),
    email: input.email,
    role: input.role ?? "user",
    kind: input.kind ?? "new_account",
    invitedBy: input.invitedBy ?? null,
    tokenHash: await sha256Hex(token),
    expiresAt: now + config.inviteTtlHours * 60 * 60 * 1000,
    acceptedAt: null,
    revokedAt: null,
    createdAt: now,
  };
  return { token, row };
}

/**
 * The invite for `token` if it can still be used: not accepted, not revoked, not expired.
 * Callers answer every other case with the same `410 invite_invalid`.
 */
export async function findLiveInvite(
  db: Db,
  token: string,
  now = Date.now(),
): Promise<Invite | null> {
  const row = await db
    .select()
    .from(invites)
    .where(eq(invites.tokenHash, await sha256Hex(token)))
    .get();
  if (!row || row.acceptedAt !== null || row.revokedAt !== null || row.expiresAt <= now) {
    return null;
  }
  return row;
}

/** Email of the inviting user, or null (bootstrap admin, or the inviter was deleted). */
export async function inviterEmail(db: Db, invitedBy: string | null): Promise<string | null> {
  if (!invitedBy) return null;
  const row = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, invitedBy))
    .get();
  return row?.email ?? null;
}

/** A pending (live) invite for `email`, if any. */
export async function findLiveInviteForEmail(
  db: Db,
  email: string,
  now = Date.now(),
): Promise<Invite | null> {
  const row = await db
    .select()
    .from(invites)
    .where(
      and(
        eq(invites.email, email),
        isNull(invites.acceptedAt),
        isNull(invites.revokedAt),
        gt(invites.expiresAt, now),
      ),
    )
    .get();
  return row ?? null;
}
