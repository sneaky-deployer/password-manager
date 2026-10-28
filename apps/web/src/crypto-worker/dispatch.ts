import { CryptoError } from "@pm/crypto";
import {
  CRYPTO_ERROR,
  type SerializedError,
  type WorkerRequest,
  type WorkerResponse,
} from "./protocol.ts";
import type { AllHandlers } from "./registry.ts";

/** Map any thrown value to something structured-cloneable. `@pm/crypto` errors keep their code. */
export function serializeError(error: unknown): SerializedError {
  if (error instanceof CryptoError) {
    return { name: error.name, code: error.code, message: error.message };
  }
  if (error instanceof Error) {
    return { name: error.name, code: CRYPTO_ERROR.workerError, message: error.message };
  }
  return { name: "Error", code: CRYPTO_ERROR.workerError, message: "Unknown worker error" };
}

type AnyHandler = (args: unknown) => Promise<unknown>;

/**
 * Turns handlers into a request -> response function. It is pure (no `self`), so tests call it
 * directly and `worker.ts` just wires it to `postMessage`.
 */
export function createDispatcher(handlers: AllHandlers) {
  return async function dispatch(request: WorkerRequest): Promise<WorkerResponse> {
    const { id, op, args } = request;
    if (!Object.hasOwn(handlers, op)) {
      return {
        id,
        ok: false,
        error: {
          name: "Error",
          code: CRYPTO_ERROR.unknownOp,
          message: `Unknown crypto operation "${op}"`,
        },
      };
    }
    try {
      const handler = (handlers as unknown as Record<string, AnyHandler>)[op] as AnyHandler;
      return { id, ok: true, result: await handler(args) };
    } catch (error) {
      return { id, ok: false, error: serializeError(error) };
    }
  };
}
