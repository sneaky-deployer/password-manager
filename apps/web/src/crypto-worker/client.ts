import {
  type CallArgs,
  CRYPTO_ERROR,
  type OpName,
  type OpResult,
  type SerializedError,
  type WorkerRequest,
  type WorkerResponse,
} from "./protocol.ts";

/** An error raised in the crypto worker. Compare `code` with `CRYPTO_ERROR`. */
export class CryptoWorkerError extends Error {
  readonly code: string;

  constructor(code: string, message: string, name = "CryptoWorkerError") {
    super(message);
    this.name = name;
    this.code = code;
  }
}

export function isCryptoError(error: unknown, code?: string): error is CryptoWorkerError {
  return error instanceof CryptoWorkerError && (code === undefined || error.code === code);
}

/** The slice of `Worker` the client uses (lets tests inject a fake). */
export interface WorkerLike {
  postMessage(message: WorkerRequest): void;
  terminate(): void;
  onmessage: ((event: MessageEvent<WorkerResponse>) => void) | null;
  onerror: ((event: Event) => void) | null;
  onmessageerror: ((event: Event) => void) | null;
}

export interface CryptoClient {
  /** Run an operation in the worker. Typed from `OpMap` in `protocol.ts`. */
  call<K extends OpName>(op: K, ...args: CallArgs<K>): Promise<OpResult<K>>;
  /**
   * Called when the worker dies (script error, unexpected termination). The keys are gone, so
   * the app must treat itself as locked. A later `call` starts a fresh, locked worker.
   */
  onCrash(listener: () => void): () => void;
  /** Kill the worker (everything in memory is dropped). */
  terminate(): void;
}

interface Pending {
  resolve(value: unknown): void;
  reject(reason: unknown): void;
}

function toError(error: SerializedError): CryptoWorkerError {
  return new CryptoWorkerError(error.code, error.message, error.name);
}

export function createCryptoClient(createWorker: () => WorkerLike): CryptoClient {
  let worker: WorkerLike | null = null;
  let nextId = 1;
  const pending = new Map<number, Pending>();
  const crashListeners = new Set<() => void>();

  function failAll(code: string, message: string): void {
    const error = new CryptoWorkerError(code, message);
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
  }

  function drop(notify: boolean): void {
    const dead = worker;
    worker = null;
    dead?.terminate();
    failAll(CRYPTO_ERROR.workerCrashed, "The crypto worker stopped");
    if (notify) for (const listener of [...crashListeners]) listener();
  }

  function ensureWorker(): WorkerLike {
    if (worker) return worker;
    const created = createWorker();
    created.onmessage = (event) => {
      const response = event.data;
      const entry = pending.get(response.id);
      if (!entry) return;
      pending.delete(response.id);
      if (response.ok) entry.resolve(response.result);
      else entry.reject(toError(response.error));
    };
    created.onerror = () => drop(true);
    created.onmessageerror = () => drop(true);
    worker = created;
    return created;
  }

  return {
    call(op, ...args) {
      // Locking a worker that was never started has nothing to wipe: do not spawn one.
      if (!worker && op === "lock") return Promise.resolve(undefined as OpResult<typeof op>);
      if (!worker && op === "isUnlocked") {
        return Promise.resolve({ unlocked: false, userId: null } as OpResult<typeof op>);
      }
      return new Promise<OpResult<typeof op>>((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
        try {
          ensureWorker().postMessage({ id, op, args: args[0] });
        } catch (error) {
          pending.delete(id);
          reject(
            new CryptoWorkerError(
              CRYPTO_ERROR.workerCrashed,
              error instanceof Error ? error.message : "Cannot reach the crypto worker",
            ),
          );
        }
      });
    },

    onCrash(listener) {
      crashListeners.add(listener);
      return () => crashListeners.delete(listener);
    },

    terminate() {
      drop(false);
    },
  };
}

/** The app-wide client. The worker starts on first use. */
export const cryptoClient: CryptoClient = createCryptoClient(
  () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }) as unknown as WorkerLike,
);
