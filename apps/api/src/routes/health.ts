import { Hono } from "hono";
import type { AppEnv } from "../env.ts";

export const health = new Hono<AppEnv>().get("/", (c) => c.json({ ok: true as const }));
