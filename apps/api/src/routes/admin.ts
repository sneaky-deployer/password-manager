import { Hono } from "hono";
import type { AppEnv } from "../env.ts";

// Routes are added here (the router is already mounted in app.ts).
export const admin = new Hono<AppEnv>();
