import sodium from "libsodium-wrappers-sumo";

/** Resolves once libsodium's WASM is loaded. All crypto in this repo goes through this package. */
export async function sodiumReady(): Promise<typeof sodium> {
  await sodium.ready;
  return sodium;
}
