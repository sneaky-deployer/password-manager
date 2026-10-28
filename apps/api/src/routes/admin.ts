import {
  type AdminUserWire,
  createInviteRequestSchema,
  idParamsSchema,
  updateUserRequestSchema,
} from "@pm/shared";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { getDb } from "../db/client.ts";
import { invites, sessions, users } from "../db/schema.ts";
import type { AppEnv } from "../env.ts";
import { deleteUserStatements } from "../lib/account/account-deletion.ts";
import { runBatch, sendTemplate } from "../lib/account/common.ts";
import {
  buildInvite,
  findLiveInviteForEmail,
  inviteLink,
  toInviteWire,
} from "../lib/account/invites.ts";
import { auditStatement } from "../lib/audit.ts";
import { randomToken, sha256Hex } from "../lib/crypto.ts";
import { inviteEmail } from "../lib/email-templates.ts";
import { AppError } from "../lib/errors.ts";
import { validate } from "../lib/validate.ts";
import { getAuth, requireAdmin } from "../middleware/session.ts";

/** Columns shown to admins: metadata only, never verifiers, keys or the TOTP secret. */
const adminUserColumns = {
  id: users.id,
  email: users.email,
  role: users.role,
  status: users.status,
  invitedBy: users.invitedBy,
  lastLoginAt: users.lastLoginAt,
  createdAt: users.createdAt,
  totp: sql<number>`(${users.totpSecretEnc} IS NOT NULL)`,
  passkeys: sql<number>`(SELECT count(*) FROM webauthn_credentials w WHERE w.user_id = ${users.id})`,
};

function toAdminUserWire(row: {
  id: string;
  email: string;
  role: "admin" | "user";
  status: "active" | "disabled";
  invitedBy: string | null;
  lastLoginAt: number | null;
  createdAt: number;
  totp: number;
  passkeys: number;
}): AdminUserWire {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    status: row.status,
    invitedBy: row.invitedBy,
    twoFactorEnabled: Boolean(row.totp) || row.passkeys > 0,
    lastLoginAt: row.lastLoginAt,
    createdAt: row.createdAt,
  };
}

async function loadAdminUser(c: Context<AppEnv>, id: string): Promise<AdminUserWire | null> {
  const row = await getDb(c.env).select(adminUserColumns).from(users).where(eq(users.id, id)).get();
  return row ? toAdminUserWire(row) : null;
}

export const admin = new Hono<AppEnv>()
  .use(requireAdmin)

  // --- Invites (PLAN.md 10.1) ------------------------------------------------------------------
  .get("/invites", async (c) => {
    const rows = await getDb(c.env).select().from(invites).orderBy(desc(invites.createdAt));
    const now = Date.now();
    return c.json({ invites: rows.map((row) => toInviteWire(row, now)) });
  })
  .post("/invites", validate("json", createInviteRequestSchema), async (c) => {
    const { user: inviter } = getAuth(c);
    const config = c.var.config;
    const db = getDb(c.env);
    const { email } = c.req.valid("json");

    const existing = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email))
      .get();
    if (existing || (await findLiveInviteForEmail(db, email))) {
      throw new AppError("email_taken", 409);
    }
    const { token, row } = await buildInvite(config, {
      email,
      role: "user",
      kind: "new_account",
      invitedBy: inviter.id,
    });
    await runBatch(db, [
      db.insert(invites).values(row),
      auditStatement(db, inviter.id, "invite_sent", { inviteId: row.id }),
    ]);
    await sendTemplate(
      c,
      email,
      inviteEmail({
        inviterEmail: inviter.email,
        link: inviteLink(config, token),
        expiresHours: config.inviteTtlHours,
        kind: "new_account",
      }),
    );
    return c.json({ invite: toInviteWire(row) }, 201);
  })
  .post("/invites/:id/resend", validate("param", idParamsSchema), async (c) => {
    const { user: inviter } = getAuth(c);
    const config = c.var.config;
    const db = getDb(c.env);
    const { id } = c.req.valid("param");
    const invite = await db.select().from(invites).where(eq(invites.id, id)).get();
    if (!invite) throw new AppError("not_found", 404);
    if (invite.acceptedAt !== null) {
      throw new AppError("conflict", 409, "This invitation was already accepted.");
    }
    if (invite.revokedAt !== null) {
      throw new AppError("conflict", 409, "This invitation was revoked. Create a new one.");
    }
    if (invite.kind === "new_account") {
      const taken = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, invite.email))
        .get();
      if (taken) throw new AppError("email_taken", 409);
    }

    // A new token replaces the old hash, so the previously emailed link stops working.
    const token = randomToken(32);
    const now = Date.now();
    const updated = {
      ...invite,
      tokenHash: await sha256Hex(token),
      expiresAt: now + config.inviteTtlHours * 60 * 60 * 1000,
    };
    await runBatch(db, [
      db
        .update(invites)
        .set({ tokenHash: updated.tokenHash, expiresAt: updated.expiresAt })
        .where(eq(invites.id, id)),
      auditStatement(db, inviter.id, "invite_resent", { inviteId: id }, now),
    ]);
    await sendTemplate(
      c,
      invite.email,
      inviteEmail({
        inviterEmail: inviter.email,
        link: inviteLink(config, token),
        expiresHours: config.inviteTtlHours,
        kind: invite.kind,
      }),
    );
    return c.json({ invite: toInviteWire(updated, now) });
  })
  .post("/invites/:id/revoke", validate("param", idParamsSchema), async (c) => {
    const { user: inviter } = getAuth(c);
    const db = getDb(c.env);
    const { id } = c.req.valid("param");
    const invite = await db.select().from(invites).where(eq(invites.id, id)).get();
    if (!invite) throw new AppError("not_found", 404);
    if (invite.acceptedAt !== null) {
      throw new AppError("conflict", 409, "This invitation was already accepted.");
    }
    if (invite.revokedAt !== null) return c.json({ invite: toInviteWire(invite) });

    const now = Date.now();
    await runBatch(db, [
      db
        .update(invites)
        .set({ revokedAt: now })
        .where(and(eq(invites.id, id), isNull(invites.acceptedAt))),
      auditStatement(db, inviter.id, "invite_revoked", { inviteId: id }, now),
    ]);
    return c.json({ invite: toInviteWire({ ...invite, revokedAt: now }, now) });
  })

  // --- Users (PLAN.md 10.1a) -----------------------------------------------------------------------
  .get("/users", async (c) => {
    const rows = await getDb(c.env).select(adminUserColumns).from(users).orderBy(users.createdAt);
    return c.json({ users: rows.map(toAdminUserWire) });
  })
  .patch(
    "/users/:id",
    validate("param", idParamsSchema),
    validate("json", updateUserRequestSchema),
    async (c) => {
      const db = getDb(c.env);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const target = await db.select().from(users).where(eq(users.id, id)).get();
      if (!target) throw new AppError("not_found", 404);

      const role = body.role ?? target.role;
      const status = body.status ?? target.status;
      const losesAdminPower =
        target.role === "admin" &&
        target.status === "active" &&
        (role !== "admin" || status !== "active");
      const disabling = target.status === "active" && status === "disabled";
      const now = Date.now();

      // "Another active admin exists" is part of the UPDATE's WHERE, so two admins demoting each
      // other at the same moment cannot both succeed and leave the system without an admin.
      const updated = await db
        .update(users)
        .set({
          role,
          status,
          updatedAt: now,
          ...(disabling ? { securityStamp: sql`${users.securityStamp} + 1` } : {}),
        })
        .where(
          and(
            eq(users.id, id),
            losesAdminPower
              ? sql`EXISTS (SELECT 1 FROM users u2 WHERE u2.role = 'admin' AND u2.status = 'active' AND u2.id != ${id})`
              : undefined,
          ),
        )
        .returning({ id: users.id });
      if (updated.length === 0) {
        throw losesAdminPower ? new AppError("last_admin", 409) : new AppError("not_found", 404);
      }

      const { user: actor } = getAuth(c);
      const events: ReturnType<typeof auditStatement>[] = [];
      if (role !== target.role)
        events.push(auditStatement(db, id, "role_changed", { role, by: actor.id }, now));
      if (status !== target.status) {
        events.push(
          auditStatement(
            db,
            id,
            status === "disabled" ? "account_disabled" : "account_enabled",
            { by: actor.id },
            now,
          ),
        );
      }
      await runBatch(db, [
        // The stamp bump already invalidated them; deleting the rows tidies the session list.
        ...(disabling ? [db.delete(sessions).where(eq(sessions.userId, id))] : []),
        ...events,
      ]);
      const wire = await loadAdminUser(c, id);
      if (!wire) throw new AppError("not_found", 404);
      return c.json({ user: wire });
    },
  )
  .post("/users/:id/reset", validate("param", idParamsSchema), async (c) => {
    const { user: actor } = getAuth(c);
    const config = c.var.config;
    const db = getDb(c.env);
    const { id } = c.req.valid("param");
    const target = await db.select().from(users).where(eq(users.id, id)).get();
    if (!target) throw new AppError("not_found", 404);
    if (target.id === actor.id) {
      throw new AppError("conflict", 409, "Reset your own account from your account settings.");
    }

    const now = Date.now();
    const { token, row } = await buildInvite(
      config,
      { email: target.email, role: target.role, kind: "account_reset", invitedBy: actor.id },
      now,
    );
    await runBatch(db, [
      // Wipes the data and removes the account; the invite below recreates it with new keys.
      ...deleteUserStatements(db, target.id, now),
      db
        .update(invites)
        .set({ revokedAt: now })
        .where(
          and(
            eq(invites.email, target.email),
            isNull(invites.acceptedAt),
            isNull(invites.revokedAt),
          ),
        ),
      db.insert(invites).values(row),
      auditStatement(db, actor.id, "user_reset", { target: target.id }, now),
    ]);
    await sendTemplate(
      c,
      target.email,
      inviteEmail({
        inviterEmail: actor.email,
        link: inviteLink(config, token),
        expiresHours: config.inviteTtlHours,
        kind: "account_reset",
      }),
    );
    return c.json({ invite: toInviteWire(row, now) }, 201);
  })
  .delete("/users/:id", validate("param", idParamsSchema), async (c) => {
    const { user: actor } = getAuth(c);
    const db = getDb(c.env);
    const { id } = c.req.valid("param");
    const target = await db.select({ id: users.id }).from(users).where(eq(users.id, id)).get();
    if (!target) throw new AppError("not_found", 404);
    if (target.id === actor.id) {
      throw new AppError("conflict", 409, "Delete your own account from your account settings.");
    }
    const now = Date.now();
    await runBatch(db, [
      ...deleteUserStatements(db, id, now),
      auditStatement(db, actor.id, "user_deleted", { target: id }, now),
    ]);
    return c.json({ ok: true as const });
  });
