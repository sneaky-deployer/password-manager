import {
  createExecutionContext,
  createScheduledController,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  auditEvents,
  authChallenges,
  deletions,
  emailCodes,
  invites,
  itemShares,
  items,
  rateLimits,
  sessions,
  users,
} from "../src/db/schema.ts";
import worker from "../src/index.ts";
import { runCleanup } from "../src/jobs/cleanup.ts";
import { newId } from "../src/lib/crypto.ts";
import { SESSION_IDLE_MS } from "../src/lib/sessions.ts";
import {
  createItem,
  createTestSession,
  createUser,
  createVaultWithOwner,
  db,
  resetDb,
} from "./helpers.ts";

const DAY = 86_400_000;

async function seed(now: number) {
  const owner = await createUser();
  const recipient = await createUser();
  const { vault } = await createVaultWithOwner(owner);

  const oldTrashed = await createItem(vault, owner, { trashedAt: now - 31 * DAY });
  const recentTrashed = await createItem(vault, owner, { trashedAt: now - 29 * DAY });
  const live = await createItem(vault, owner, {
    createdAt: now - 400 * DAY,
    updatedAt: now - 400 * DAY,
  });
  const share = {
    id: newId(),
    itemId: oldTrashed.id,
    userId: recipient.id,
    role: "viewer" as const,
    keyVersion: 1,
    sealedKey: "sealed",
    status: "active" as const,
    createdAt: now,
    updatedAt: now,
  };
  const keptShare = { ...share, id: newId(), itemId: live.id };
  await db.insert(itemShares).values([share, keptShare]);

  // Sessions: expired, idle too long, valid.
  const expired = await createTestSession(owner, {
    createdAt: now - 100 * DAY,
    expiresAt: now - 10 * DAY,
    lastSeenAt: now - 95 * DAY,
  });
  const idle = await createTestSession(owner, {
    createdAt: now - 60 * DAY,
    lastSeenAt: now - SESSION_IDLE_MS - DAY,
  });
  const valid = await createTestSession(owner, { createdAt: now - 5 * DAY, lastSeenAt: now - DAY });

  const code = (expiresAt: number) => ({
    id: newId(),
    email: "x@example.test",
    purpose: "recovery" as const,
    codeHash: "h",
    expiresAt,
    createdAt: expiresAt - 600_000,
  });
  const oldCode = code(now - 31 * DAY);
  const freshCode = code(now - 29 * DAY);
  await db.insert(emailCodes).values([oldCode, freshCode]);

  const challenge = (expiresAt: number) => ({
    id: newId(),
    userId: owner.id,
    kind: "2fa" as const,
    tokenHash: newId(),
    expiresAt,
  });
  const oldChallenge = challenge(now - 31 * DAY);
  const freshChallenge = challenge(now - 29 * DAY);
  await db.insert(authChallenges).values([oldChallenge, freshChallenge]);

  const invite = (expiresAt: number) => ({
    id: newId(),
    email: "i@example.test",
    role: "user" as const,
    tokenHash: newId(),
    expiresAt,
    createdAt: expiresAt - 72 * 3_600_000,
  });
  const oldInvite = invite(now - 31 * DAY);
  const freshInvite = invite(now - 29 * DAY);
  await db.insert(invites).values([oldInvite, freshInvite]);

  const audit = (createdAt: number) => ({
    id: newId(),
    userId: owner.id,
    event: "login",
    createdAt,
  });
  const oldAudit = audit(now - 91 * DAY);
  const freshAudit = audit(now - 89 * DAY);
  await db.insert(auditEvents).values([oldAudit, freshAudit]);

  const tombstone = (deletedAt: number) => ({
    id: newId(),
    entity: "item" as const,
    entityId: newId(),
    vaultId: vault.id,
    deletedAt,
  });
  const oldTombstone = tombstone(now - 91 * DAY);
  const freshTombstone = tombstone(now - 89 * DAY);
  await db.insert(deletions).values([oldTombstone, freshTombstone]);

  await db.insert(rateLimits).values([
    { key: "old", windowStart: now - 2 * DAY, count: 5 },
    { key: "new", windowStart: now - 1000, count: 1 },
  ]);

  return {
    owner,
    recipient,
    vault,
    oldTrashed,
    recentTrashed,
    live,
    share,
    keptShare,
    expired,
    idle,
    valid,
    oldCode,
    freshCode,
    oldChallenge,
    freshChallenge,
    oldInvite,
    freshInvite,
    oldAudit,
    freshAudit,
    oldTombstone,
    freshTombstone,
  };
}

const ids = <T extends { id: string }>(rows: T[]) => rows.map((r) => r.id).sort();

describe("cleanup job", () => {
  beforeEach(resetDb);

  it("deletes exactly what has expired and keeps everything else", async () => {
    const now = Date.now();
    const s = await seed(now);

    const result = await runCleanup(db, now);

    expect(result).toEqual({
      purgedItems: 1,
      sessions: 2,
      emailCodes: 1,
      authChallenges: 1,
      invites: 1,
      auditEvents: 1,
      tombstones: 1,
      rateLimits: 1,
    });

    expect(ids(await db.select().from(items))).toEqual(ids([s.recentTrashed, s.live]));
    // The share of the purged item cascades away; the other share stays.
    expect(ids(await db.select().from(itemShares))).toEqual([s.keptShare.id]);
    expect(ids(await db.select().from(sessions))).toEqual([s.valid.session.id]);
    expect(ids(await db.select().from(emailCodes))).toEqual([s.freshCode.id]);
    expect(ids(await db.select().from(authChallenges))).toEqual([s.freshChallenge.id]);
    expect(ids(await db.select().from(invites))).toEqual([s.freshInvite.id]);
    expect(ids(await db.select().from(auditEvents))).toEqual([s.freshAudit.id]);
    expect((await db.select().from(rateLimits)).map((r) => r.key)).toEqual(["new"]);
    expect(await db.select().from(users)).toHaveLength(2);
  });

  it("records tombstones for purged items and their shares before deleting them", async () => {
    const now = Date.now();
    const s = await seed(now);
    await runCleanup(db, now);

    const tombstones = await db.select().from(deletions);
    // 2 pre-existing (one older than 90 days is gone) + item + item_share
    expect(ids(tombstones)).toContain(s.freshTombstone.id);
    expect(ids(tombstones)).not.toContain(s.oldTombstone.id);

    const itemTombstone = tombstones.find(
      (t) => t.entity === "item" && t.entityId === s.oldTrashed.id,
    );
    expect(itemTombstone).toMatchObject({ vaultId: s.vault.id, userId: null, deletedAt: now });
    const shareTombstone = tombstones.find((t) => t.entity === "item_share");
    expect(shareTombstone).toMatchObject({
      entityId: s.share.id,
      vaultId: s.vault.id,
      userId: s.recipient.id,
      deletedAt: now,
    });
    expect(tombstones).toHaveLength(3);
  });

  it("is idempotent", async () => {
    const now = Date.now();
    await seed(now);
    await runCleanup(db, now);
    const again = await runCleanup(db, now);
    expect(again).toEqual({
      purgedItems: 0,
      sessions: 0,
      emailCodes: 0,
      authChallenges: 0,
      invites: 0,
      auditEvents: 0,
      tombstones: 0,
      rateLimits: 0,
    });
    expect(await db.select().from(deletions)).toHaveLength(3);
  });

  it("does nothing to an empty database", async () => {
    await expect(runCleanup(db)).resolves.toMatchObject({ purgedItems: 0 });
  });

  it("runs from the scheduled handler", async () => {
    const now = Date.now();
    const owner = await createUser();
    const { vault } = await createVaultWithOwner(owner);
    const old = await createItem(vault, owner, { trashedAt: now - 40 * DAY });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ cron: "23 2 * * *" }), env, ctx);
    await waitOnExecutionContext(ctx);

    expect((await db.select().from(items)).map((i) => i.id)).not.toContain(old.id);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("cleanup done"));
    log.mockRestore();
  });
});
