/// Module Web Worker: owns libsodium and every key. Created by `client.ts` with
/// `new Worker(new URL("./worker.ts", import.meta.url), { type: "module" })`.
import { createDispatcher } from "./dispatch.ts";
import type { WorkerRequest, WorkerResponse } from "./protocol.ts";
import { createHandlers } from "./registry.ts";
import { createWorkerState } from "./state.ts";

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: WorkerResponse): void;
};

const dispatch = createDispatcher(createHandlers(createWorkerState()));

scope.onmessage = (event) => {
  void dispatch(event.data).then((response) => scope.postMessage(response));
};
