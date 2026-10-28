import { env } from "cloudflare:workers";
import { ERROR_CODES as SHARED_ERROR_CODES } from "@pm/shared";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { users } from "../src/db/schema.ts";
import type { AppEnv } from "../src/env.ts";
import {
  AppError,
  ERROR_CODES,
  errorHandler,
  isQuotaError,
  isUniqueViolation,
  notFoundHandler,
} from "../src/lib/errors.ts";
import { validate } from "../src/lib/validate.ts";
import { createUser, db, resetDb } from "./helpers.ts";

const schema = z.object({ email: z.email(), age: z.number().int().min(0) });

const testApp = new Hono<AppEnv>()
  .post("/validated", validate("json", schema), (c) => c.json(c.req.valid("json")))
  .get("/app-error", () => {
    throw new AppError("revision_conflict", 409, undefined, { current: 7 });
  })
  .get("/custom", () => {
    throw new AppError("last_admin", 409, "Promote someone else first.");
  })
  .get("/http", () => {
    throw new HTTPException(403, { message: "nope" });
  })
  .get("/quota", () => {
    throw new Error("D1_ERROR: Exceeded the daily row read limit for the free tier");
  })
  .get("/wrapped-quota", () => {
    throw new Error("Failed query", { cause: new Error("D1 DB reached its storage quota") });
  })
  .get("/boom", () => {
    throw new Error("secret internal detail: SELECT * FROM users");
  })
  .onError(errorHandler)
  .notFound(notFoundHandler);

const post = (body: BodyInit, e = env) =>
  testApp.request(
    "/validated",
    { method: "POST", headers: { "Content-Type": "application/json" }, body },
    e,
  );

afterEach(() => vi.restoreAllMocks());

describe("error handler", () => {
  it("covers every documented error code", () => {
    expect([...ERROR_CODES].sort()).toEqual(Object.values(SHARED_ERROR_CODES).sort());
  });

  it("formats AppError with default message and details", async () => {
    const res = await testApp.request("/app-error", {}, env);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: {
        code: "revision_conflict",
        message: "This item was changed elsewhere. Reload it and try again.",
        details: { current: 7 },
      },
    });
  });

  it("uses a custom message and omits details when absent", async () => {
    const res = await testApp.request("/custom", {}, env);
    expect(await res.json()).toEqual({
      error: { code: "last_admin", message: "Promote someone else first." },
    });
  });

  it("maps HTTPException to the matching code", async () => {
    const res = await testApp.request("/http", {}, env);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: "forbidden" } });
  });

  it("answers unknown routes with a JSON 404", async () => {
    const res = await testApp.request("/missing", {}, env);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: "not_found", message: "Not found" } });
  });

  it("maps D1 daily-limit errors, even wrapped, to 503 quota_exceeded", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (const path of ["/quota", "/wrapped-quota"]) {
      const res = await testApp.request(path, {}, env);
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ error: { code: "quota_exceeded" } });
    }
    expect(isQuotaError(new Error("UNIQUE constraint failed: users.email"))).toBe(false);
  });

  it("never leaks internal messages in production", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await testApp.request("/boom", {}, { ...env, ENVIRONMENT: "production" });
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain("secret internal detail");
    expect(text).not.toContain("SELECT");
    expect(JSON.parse(text)).toEqual({
      error: { code: "internal_error", message: "Internal server error." },
    });
  });

  it("includes a hint outside production", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await testApp.request("/boom", {}, env);
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).toContain("secret internal detail");
  });
});

describe("validate()", () => {
  it("passes valid input through", async () => {
    const res = await post(JSON.stringify({ email: "a@example.test", age: 3 }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ email: "a@example.test", age: 3 });
  });

  it("answers 400 validation_error with flattened details", async () => {
    const res = await post(JSON.stringify({ email: "nope", age: -1 }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: {
        code: string;
        details: { fieldErrors: Record<string, string[]>; formErrors: string[] };
      };
    };
    expect(body.error.code).toBe("validation_error");
    expect(Object.keys(body.error.details.fieldErrors).sort()).toEqual(["age", "email"]);
    expect(body.error.details.formErrors).toEqual([]);
  });

  it("answers 400 validation_error for malformed JSON", async () => {
    const res = await post("{not json");
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: "validation_error" } });
  });
});

describe("isUniqueViolation", () => {
  it("recognises a real duplicate-email insert from D1 via drizzle", async () => {
    await resetDb();
    const user = await createUser();
    const error = await createUser({ email: user.email }).catch((e: unknown) => e);
    expect(isUniqueViolation(error)).toBe(true);
    expect(isUniqueViolation(new Error("something else"))).toBe(false);
    expect(await db.select().from(users)).toHaveLength(1);
  });
});
