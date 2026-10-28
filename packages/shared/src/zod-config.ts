import { z } from "zod";

// Zod probes `new Function("")` once to decide whether it may compile parsers (JIT). Under our
// Content-Security-Policy (no 'unsafe-eval', PLAN.md section 8) the probe is blocked: the throw is
// caught, but browsers still report a `securitypolicyviolation` and a console error on every page
// load. `jitless` skips the probe. Workers (workerd) forbid eval anyway, so nothing changes there.
// This module must be evaluated before any schema is built, hence the first import in index.ts.
z.config({ jitless: true });
