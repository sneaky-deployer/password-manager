// UI-facing entry for the crypto worker. Import the client and types from here; never import
// `@pm/crypto` in code that runs on the UI thread (it would pull libsodium into the main bundle).
export {
  type CryptoClient,
  CryptoWorkerError,
  createCryptoClient,
  cryptoClient,
  isCryptoError,
} from "./client.ts";
export * from "./protocol.ts";
