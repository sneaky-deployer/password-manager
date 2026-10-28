// Shared test helpers. Tests run in real workerd against a local D1 whose schema comes from
// ./migrations (see vitest.config.ts and test/setup.ts).
//
// Typical route test:
//   beforeEach(resetDb);
//   const { client, user } = await signedInClient({ role: "admin" });
//   const res = await client.post("/api/admin/invites", { email: "a@example.test" });
//   expect(res.status).toBe(201);
//   expect(getDevOutbox()).toHaveLength(1);
import { env, exports } from "cloudflare:workers";
import { getTableName, is } from "drizzle-orm";
import { SQLiteTable } from "drizzle-orm/sqlite-core";
import { getDb } from "../src/db/client.ts";
import * as schema from "../src/db/schema.ts";
import {
  type Item,
  items,
  type NewItem,
  type NewUser,
  type NewVault,
  type Session,
  sessions,
  type User,
  users,
  type Vault,
  type VaultMember,
  vaultMembers,
  vaults,
} from "../src/db/schema.ts";
import { getConfig } from "../src/env.ts";
import { newId, randomToken, sha256Hex } from "../src/lib/crypto.ts";
import { clearDevOutbox } from "../src/lib/email.ts";
import { SESSION_ABSOLUTE_MS, sessionCookieName } from "../src/lib/sessions.ts";

export const db = getDb(env);

/** The configured `APP_ORIGIN` (what a legitimate browser sends as `Origin`). */
export const TEST_ORIGIN = env.APP_ORIGIN;

// ---------------------------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------------------------

/** Minimal cookie jar: remembers cookies from `Set-Cookie` and replays them as `Cookie`. */
export class CookieJar {
  private readonly cookies = new Map<string, string>();

  get(name: string): string | undefined {
    return this.cookies.get(name);
  }

  set(name: string, value: string): void {
    this.cookies.set(name, value);
  }

  delete(name: string): void {
    this.cookies.delete(name);
  }

  clear(): void {
    this.cookies.clear();
  }

  /** `Cookie` header value, or undefined when the jar is empty. */
  header(): string | undefined {
    if (this.cookies.size === 0) return undefined;
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  /** Applies every `Set-Cookie` of a response (empty value or `Max-Age=0` removes the cookie). */
  absorb(res: Response): void {
    for (const raw of res.headers.getSetCookie()) {
      const [pair = "", ...attributes] = raw.split(";").map((part) => part.trim());
      const separator = pair.indexOf("=");
      if (separator < 1) continue;
      const name = pair.slice(0, separator);
      const value = pair.slice(separator + 1);
      const expired = attributes.some((attribute) => /^max-age=0$/i.test(attribute));
      if (value === "" || expired) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }
}

export interface RequestOptions {
  /** JSON body (sets `Content-Type: application/json`). */
  json?: unknown;
  /** Raw body, for malformed-JSON and similar tests. */
  body?: BodyInit;
  headers?: Record<string, string>;
  /**
   * `Origin` header. Defaults to `TEST_ORIGIN` on non-GET/HEAD requests and none on GET.
   * Pass `null` to send no Origin, or a string to send another one.
   */
  origin?: string | null;
  jar?: CookieJar;
}

/** Sends a request through the real Worker entrypoint (`exports.default.fetch`). */
export async function request(
  method: string,
  path: string,
  options: RequestOptions = {},
): Promise<Response> {
  const headers = new Headers(options.headers);
  const safe = method === "GET" || method === "HEAD" || method === "OPTIONS";
  const origin = options.origin === undefined ? (safe ? null : TEST_ORIGIN) : options.origin;
  if (origin !== null) headers.set("Origin", origin);
  if (options.json !== undefined) headers.set("Content-Type", "application/json");
  const cookie = options.jar?.header();
  if (cookie) headers.set("Cookie", cookie);

  const res = await exports.default.fetch(
    new Request(new URL(path, TEST_ORIGIN), {
      method,
      headers,
      body: options.json !== undefined ? JSON.stringify(options.json) : options.body,
    }),
  );
  options.jar?.absorb(res);
  return res;
}

/** Parses a JSON response body with a type you assert. */
export async function readJson<T = unknown>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

type BodylessOptions = Omit<RequestOptions, "json" | "body">;

/** A browser stand-in: one cookie jar, JSON in, `Response` out. */
export function createClient(jar = new CookieJar()) {
  const send = (method: string, path: string, options: RequestOptions = {}) =>
    request(method, path, { jar, ...options });
  return {
    jar,
    request: send,
    get: (path: string, options?: BodylessOptions) => send("GET", path, options),
    delete: (path: string, options?: BodylessOptions) => send("DELETE", path, options),
    post: (path: string, json?: unknown, options?: BodylessOptions) =>
      send("POST", path, { ...options, json }),
    put: (path: string, json?: unknown, options?: BodylessOptions) =>
      send("PUT", path, { ...options, json }),
    patch: (path: string, json?: unknown, options?: BodylessOptions) =>
      send("PATCH", path, { ...options, json }),
  };
}

export type TestClient = ReturnType<typeof createClient>;

// ---------------------------------------------------------------------------------------------
// Database isolation
// ---------------------------------------------------------------------------------------------

/**
 * Deletes every row of every table (all tables exported from the schema, so new ones are covered
 * automatically) and empties the dev email outbox. Call it in `beforeEach`.
 */
export async function resetDb(): Promise<void> {
  const tables = Object.values(schema).filter((value) => is(value, SQLiteTable));
  // `users` last: most other tables reference it.
  const names = tables
    .map((table) => getTableName(table))
    .sort((a, b) => Number(a === "users") - Number(b === "users"));
  await env.DB.batch(names.map((name) => env.DB.prepare(`DELETE FROM "${name}"`)));
  clearDevOutbox();
}

// ---------------------------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------------------------

/** Plausible random base64url blob standing in for keys, envelopes and verifiers. */
export function fakeBlob(bytes = 32): string {
  return randomToken(bytes);
}

let userCounter = 0;

/** Inserts a user with random (meaningless) key material. Override anything via `overrides`. */
export async function createUser(overrides: Partial<NewUser> = {}): Promise<User> {
  const now = Date.now();
  const id = overrides.id ?? newId();
  userCounter += 1;
  const row: NewUser = {
    id,
    email: `user${userCounter}-${id.slice(0, 8)}@example.test`,
    emailVerifiedAt: now,
    role: "user",
    status: "active",
    kdfAlg: "argon2id13",
    kdfMem: 67108864,
    kdfOps: 3,
    kdfSalt: fakeBlob(16),
    authVerifier: fakeBlob(32),
    wrappedAkPw: fakeBlob(72),
    wrappedAkRec: fakeBlob(72),
    recoveryVerifier: fakeBlob(32),
    publicKey: fakeBlob(32),
    encryptedPrivateKey: fakeBlob(72),
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
  const [user] = await db.insert(users).values(row).returning();
  if (!user) throw new Error("createUser failed");
  return user;
}

export interface TestSessionOptions {
  userAgent?: string;
  createdAt?: number;
  lastSeenAt?: number;
  expiresAt?: number;
  /** Defaults to the user's current `securityStamp`. Pass another value to make the session stale. */
  securityStamp?: number;
}

export interface TestSession {
  session: Session;
  token: string;
  /** `name=token`, ready for a `Cookie` request header. */
  cookie: string;
  cookieName: string;
}

/** Inserts a session for `user` (with controllable timestamps) and returns its cookie. */
export async function createTestSession(
  user: Pick<User, "id" | "securityStamp">,
  options: TestSessionOptions = {},
): Promise<TestSession> {
  const token = randomToken(32);
  const now = Date.now();
  const createdAt = options.createdAt ?? now;
  const [session] = await db
    .insert(sessions)
    .values({
      id: newId(),
      userId: user.id,
      tokenHash: await sha256Hex(token),
      securityStamp: options.securityStamp ?? user.securityStamp,
      userAgent: options.userAgent ?? "vitest",
      createdAt,
      lastSeenAt: options.lastSeenAt ?? createdAt,
      expiresAt: options.expiresAt ?? createdAt + SESSION_ABSOLUTE_MS,
    })
    .returning();
  if (!session) throw new Error("createTestSession failed");
  const cookieName = sessionCookieName(getConfig(env));
  return { session, token, cookie: `${cookieName}=${token}`, cookieName };
}

/** A user plus a client that is already signed in as them. */
export async function signedInClient(overrides: Partial<NewUser> = {}) {
  const user = await createUser(overrides);
  const { session, token, cookieName } = await createTestSession(user);
  const client = createClient();
  client.jar.set(cookieName, token);
  return { user, session, client };
}

/** Inserts a vault and the owner's membership row (role `owner`, active). */
export async function createVaultWithOwner(
  owner: Pick<User, "id">,
  overrides: Partial<NewVault> = {},
): Promise<{ vault: Vault; membership: VaultMember }> {
  const now = Date.now();
  const [vault] = await db
    .insert(vaults)
    .values({
      id: newId(),
      ownerId: owner.id,
      encryptedMeta: fakeBlob(48),
      createdAt: now,
      updatedAt: now,
      ...overrides,
    })
    .returning();
  if (!vault) throw new Error("createVaultWithOwner failed");
  const [membership] = await db
    .insert(vaultMembers)
    .values({
      id: newId(),
      vaultId: vault.id,
      userId: owner.id,
      role: "owner",
      keyVersion: vault.keyVersion,
      sealedKey: fakeBlob(80),
      status: "active",
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  if (!membership) throw new Error("createVaultWithOwner failed");
  return { vault, membership };
}

/** Inserts an item with random ciphertext into `vault`. */
export async function createItem(
  vault: Pick<Vault, "id" | "keyVersion">,
  author: Pick<User, "id">,
  overrides: Partial<NewItem> = {},
): Promise<Item> {
  const now = Date.now();
  const [item] = await db
    .insert(items)
    .values({
      id: newId(),
      vaultId: vault.id,
      itemKeyVersion: 1,
      wrappedKey: fakeBlob(72),
      vaultKeyVersion: vault.keyVersion,
      encryptedData: fakeBlob(256),
      createdBy: author.id,
      updatedBy: author.id,
      createdAt: now,
      updatedAt: now,
      ...overrides,
    })
    .returning();
  if (!item) throw new Error("createItem failed");
  return item;
}
