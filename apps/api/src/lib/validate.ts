import { zValidator } from "@hono/zod-validator";
import type { ValidationTargets } from "hono";
import type { ZodType } from "zod";
import { validationError } from "./errors.ts";

/**
 * `zValidator` that fails with the API's standard 400 `validation_error` (flattened zod details)
 * instead of zod-validator's default response. Use it for every request body, query and param:
 * `app.post("/x", validate("json", schema), (c) => c.req.valid("json"))`.
 */
export function validate<Target extends keyof ValidationTargets, Schema extends ZodType>(
  target: Target,
  schema: Schema,
) {
  return zValidator(target, schema, (result) => {
    if (!result.success) throw validationError(result.error);
  });
}
