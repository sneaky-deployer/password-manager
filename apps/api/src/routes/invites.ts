import { inspectInviteRequestSchema } from "@pm/shared";
import { Hono } from "hono";
import { getDb } from "../db/client.ts";
import type { AppEnv } from "../env.ts";
import { clientIp, hitOrThrow } from "../lib/account/common.ts";
import {
  findLiveInvite,
  INVITE_LIMIT,
  inviteLimitKey,
  inviterEmail,
} from "../lib/account/invites.ts";
import { AppError } from "../lib/errors.ts";
import { validate } from "../lib/validate.ts";

export const invites = new Hono<AppEnv>().post(
  "/inspect",
  validate("json", inspectInviteRequestSchema),
  async (c) => {
    const db = getDb(c.env);
    await hitOrThrow(
      c,
      db,
      inviteLimitKey(clientIp(c)),
      INVITE_LIMIT.limit,
      INVITE_LIMIT.windowSeconds,
    );
    const { token } = c.req.valid("json");
    const invite = await findLiveInvite(db, token);
    if (!invite) throw new AppError("invite_invalid", 410);
    return c.json({
      email: invite.email,
      invitedBy: await inviterEmail(db, invite.invitedBy),
      kind: invite.kind,
      expiresAt: invite.expiresAt,
    });
  },
);
