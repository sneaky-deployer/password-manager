import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema.ts";

/**
 * Drizzle instance over the D1 binding, with the full schema.
 *
 * D1 rules (PLAN.md sections 4 and 21):
 * - There are no interactive transactions. Use `db.batch([stmt1, stmt2, ...])` for any multi-
 *   statement write that must be atomic: D1 runs a batch as one transaction and rolls back all of
 *   it if one statement fails.
 * - Never query in a loop (50 queries per invocation on the free plan). Fetch with `inArray`/joins
 *   and write with `batch()`.
 * - Build statements without awaiting them (`db.insert(t).values(v)`), pass the builders to
 *   `db.batch`. Reads inside a batch cannot feed later statements; use SQL subqueries for that.
 */
export function getDb(env: { DB: D1Database }) {
  return drizzle(env.DB, { schema });
}

export type Db = ReturnType<typeof getDb>;
export { schema };
