import { and, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { getDb } from "../db/client.ts";
import { invites, users } from "../db/schema.ts";
import type { AppEnv } from "../env.ts";
import { hitOrThrow, requireEmptyBody, sendTemplate } from "../lib/account/common.ts";
import { buildInvite, inviteLink } from "../lib/account/invites.ts";
import { adminSetupEmail } from "../lib/email-templates.ts";
import { AppError } from "../lib/errors.ts";

/** PLAN.md 10.0: bootstrapping the super admin without a known password. */
export const setup = new Hono<AppEnv>()
  .get("/status", async (c) => {
    const admin = await getDb(c.env)
      .select({ id: users.id })
      .from(users)
      .where(eq(users.role, "admin"))
      .limit(1)
      .get();
    return c.json({ needsSetup: !admin });
  })
  .post("/start", async (c) => {
    await requireEmptyBody(c);
    const db = getDb(c.env);
    const config = c.var.config;

    const admin = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.role, "admin"))
      .limit(1)
      .get();
    if (admin) throw new AppError("setup_not_available", 404);

    // One global bucket: this endpoint only ever emails ADMIN_EMAIL, so it protects that inbox.
    await hitOrThrow(c, db, "setup:start", 3, 60 * 60);

    // Replace any earlier unused setup invite so only the newest link works.
    const { token, row } = await buildInvite(config, {
      email: config.adminEmail,
      role: "admin",
      kind: "new_account",
      invitedBy: null,
    });
    await db.batch([
      db
        .delete(invites)
        .where(and(eq(invites.email, config.adminEmail), isNull(invites.acceptedAt))),
      db.insert(invites).values(row),
    ]);
    await sendTemplate(
      c,
      config.adminEmail,
      adminSetupEmail({ link: inviteLink(config, token), expiresHours: config.inviteTtlHours }),
    );
    return c.json({ ok: true as const });
  });
