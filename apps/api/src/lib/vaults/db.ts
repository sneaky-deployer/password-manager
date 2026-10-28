import { type AnyColumn, type SQL, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { Db } from "../../db/client.ts";

export type Stmt = BatchItem<"sqlite">;

/**
 * Runs statements as ONE atomic D1 batch (a single subrequest) and returns their raw results.
 *
 * D1 gotcha: drizzle maps batched SELECT results from objects keyed by column name, so two selected
 * columns with the same SQL name (e.g. `users.id` next to `vault_members.id`) collapse into one and
 * every later field is shifted. Alias duplicates with `sql\`${col}\`.as("other_name")` in any select
 * that goes through `runBatch`/`db.batch` (plain `await db.select()` is not affected).
 */
export async function runBatch(db: Db, statements: Stmt[]): Promise<unknown[]> {
  if (statements.length === 0) return [];
  return db.batch(statements as [Stmt, ...Stmt[]]);
}

/** Splits `values` into groups of at most `size` (D1 allows 100 bound parameters per statement). */
export function chunk<T>(values: readonly T[], size: number): T[][] {
  const groups: T[][] = [];
  for (let i = 0; i < values.length; i += size) groups.push(values.slice(i, i + size));
  return groups;
}

/**
 * `CASE column WHEN id THEN value ... END` for bulk-updating one text column of many rows with a
 * single statement. Costs 2 bound parameters per pair.
 */
export function caseExpression(
  column: AnyColumn,
  pairs: readonly { id: string; value: string }[],
): SQL {
  const parts: SQL[] = [sql`case ${column}`];
  for (const pair of pairs) parts.push(sql`when ${pair.id} then ${pair.value}`);
  parts.push(sql`end`);
  return sql.join(parts, sql` `);
}

/** Extracts the number of rows a batch statement returned (for statements with `.returning()`). */
export function returnedRows<T>(result: unknown): T[] {
  return Array.isArray(result) ? (result as T[]) : [];
}

/** A bound parameter as a named select column, for INSERT ... SELECT with literal values. */
export function sqlValue<T>(value: T, alias: string) {
  return sql<T>`${value}`.as(alias);
}
