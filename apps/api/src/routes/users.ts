import { userLookupQuerySchema } from "@pm/shared";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { getDb } from "../db/client.ts";
import { users as usersTable } from "../db/schema.ts";
import type { AppEnv } from "../env.ts";
import { AppError } from "../lib/errors.ts";
import { validate } from "../lib/validate.ts";
import { rateLimit } from "../middleware/rate-limit.ts";
import { getAuth, requireAuth } from "../middleware/session.ts";

export const users = new Hono<AppEnv>();

users.use(requireAuth);

/**
 * `GET /users/lookup?email=`: the public key of an active user, to share with them (PLAN.md 11.2).
 * 30 lookups per 15 minutes per signed-in user, counted before the email is even validated.
 * Unknown, disabled and malformed-but-valid-looking emails all give the same 404 `not_found`; the
 * response never contains more than id, email and public key.
 */
users.get(
  "/lookup",
  rateLimit({
    key: (c) => `lookup:user:${getAuth(c).user.id}`,
    limit: 30,
    windowSeconds: 15 * 60,
  }),
  validate("query", userLookupQuerySchema),
  async (c) => {
    const db = getDb(c.env);
    const { email } = c.req.valid("query");
    const row = await db
      .select({ userId: usersTable.id, email: usersTable.email, publicKey: usersTable.publicKey })
      .from(usersTable)
      .where(and(eq(usersTable.email, email), eq(usersTable.status, "active")))
      .get();
    if (!row) throw new AppError("not_found", 404);
    return c.json(row);
  },
);
