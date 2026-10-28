import { emptyRequestSchema } from "@pm/shared";
import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../../env.ts";
import { AppError, validationError } from "../errors.ts";

/**
 * Body check for POST endpoints that take none (`emptyRequestSchema`): a missing or empty body is
 * `{}`; anything else must parse to exactly `{}`. Does not use `c.req.valid`.
 */
export const emptyBody = createMiddleware<AppEnv>(async (c, next) => {
  const text = await c.req.text();
  if (text.trim() !== "") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new AppError("validation_error", 400, "Malformed JSON in request body");
    }
    const result = emptyRequestSchema.safeParse(parsed);
    if (!result.success) throw validationError(result.error);
  }
  await next();
});

/** 413 `item_too_large` for oversized bodies that announce their length (zod's max catches the rest). */
export function maxBodyBytes(limit: number) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const length = Number(c.req.header("Content-Length") ?? 0);
    if (Number.isFinite(length) && length > limit) throw new AppError("item_too_large", 413);
    await next();
  });
}
