import "./zod-config.ts";
import { z } from "zod";

export const PACKAGE_NAME = "@pm/shared";

export const healthResponseSchema = z.object({ ok: z.literal(true) });
export type HealthResponse = z.infer<typeof healthResponseSchema>;

export * from "./admin.ts";
export * from "./auth.ts";
export * from "./constants.ts";
export * from "./errors.ts";
export * from "./item.ts";
export * from "./items.ts";
export * from "./me.ts";
export * from "./paths.ts";
export * from "./primitives.ts";
export * from "./security-headers.ts";
export * from "./shares.ts";
export * from "./sync.ts";
export * from "./vaults.ts";
