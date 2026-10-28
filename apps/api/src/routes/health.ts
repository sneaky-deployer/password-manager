import { Hono } from "hono";
import type { AppBindings } from "../env.ts";

export const health = new Hono<AppBindings>().get("/", (c) => c.json({ ok: true as const }));
