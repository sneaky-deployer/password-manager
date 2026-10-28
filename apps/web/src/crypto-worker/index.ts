// The Web Worker that owns libsodium and all keys arrives in Phase 2 (PLAN.md section 15).
// Importing from @pm/crypto here keeps the libsodium sumo build in the bundling path.
export { sodiumReady } from "@pm/crypto";
