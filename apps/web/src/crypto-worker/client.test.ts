import { describe, expect, it, vi } from "vitest";
import { CryptoWorkerError, createCryptoClient, type WorkerLike } from "./client.ts";
import type { WorkerRequest, WorkerResponse } from "./protocol.ts";

function fakeWorker() {
  const sent: WorkerRequest[] = [];
  const worker: WorkerLike = {
    postMessage: (message) => {
      sent.push(message);
    },
    terminate: vi.fn(),
    onmessage: null,
    onerror: null,
    onmessageerror: null,
  };
  const reply = (response: WorkerResponse) =>
    worker.onmessage?.({ data: response } as MessageEvent<WorkerResponse>);
  return { worker, sent, reply };
}

describe("crypto worker client", () => {
  it("sends requests with ids and resolves with the result", async () => {
    const { worker, sent, reply } = fakeWorker();
    const client = createCryptoClient(() => worker);
    const promise = client.call("startRecovery", { phrase: "words" });
    expect(sent).toEqual([{ id: 1, op: "startRecovery", args: { phrase: "words" } }]);
    reply({ id: 1, ok: true, result: { recoveryAuthKey: "k" } });
    await expect(promise).resolves.toEqual({ recoveryAuthKey: "k" });
  });

  it("rejects with a CryptoWorkerError carrying the code", async () => {
    const { worker, reply } = fakeWorker();
    const client = createCryptoClient(() => worker);
    const promise = client.call("buildRecoveryKit");
    reply({
      id: 1,
      ok: false,
      error: { name: "WrongPasswordError", code: "wrong_password", message: "Wrong password" },
    });
    const error = await promise.catch((e) => e);
    expect(error).toBeInstanceOf(CryptoWorkerError);
    expect(error).toMatchObject({ code: "wrong_password", name: "WrongPasswordError" });
  });

  it("matches concurrent responses by id", async () => {
    const { worker, reply } = fakeWorker();
    const client = createCryptoClient(() => worker);
    const first = client.call("buildRecoveryKit");
    const second = client.call("kdfNeedsUpgrade", { kdf: { alg: "argon2id13", mem: 1, ops: 1 } });
    reply({ id: 2, ok: true, result: { needsUpgrade: true } });
    reply({ id: 1, ok: true, result: { recoveryPhrase: "p", material: {} } });
    await expect(second).resolves.toEqual({ needsUpgrade: true });
    await expect(first).resolves.toEqual({ recoveryPhrase: "p", material: {} });
  });

  it("on a worker crash rejects pending calls, notifies listeners and starts a fresh worker next time", async () => {
    const workers = [fakeWorker(), fakeWorker()];
    let created = 0;
    const client = createCryptoClient(
      () => (workers[created++] as ReturnType<typeof fakeWorker>).worker,
    );
    const onCrash = vi.fn();
    client.onCrash(onCrash);

    const pending = client.call("buildRecoveryKit");
    workers[0]?.worker.onerror?.(new Event("error"));
    await expect(pending).rejects.toMatchObject({ code: "worker_crashed" });
    expect(onCrash).toHaveBeenCalledTimes(1);
    expect(workers[0]?.worker.terminate).toHaveBeenCalled();

    const next = client.call("buildRecoveryKit");
    expect(created).toBe(2);
    workers[1]?.reply({ id: 2, ok: true, result: { recoveryPhrase: "p", material: {} } });
    await expect(next).resolves.toEqual({ recoveryPhrase: "p", material: {} });
  });

  it("does not start a worker just to lock or ask if it is unlocked", async () => {
    const create = vi.fn(() => fakeWorker().worker);
    const client = createCryptoClient(create);
    await client.call("lock");
    await expect(client.call("isUnlocked")).resolves.toEqual({ unlocked: false, userId: null });
    expect(create).not.toHaveBeenCalled();
  });
});
