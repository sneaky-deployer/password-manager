import { describe, expect, it } from "vitest";
import {
  DecryptionError,
  ENVELOPE_VERSION,
  fromBase64Url,
  generateKey,
  NONCE_BYTES,
  open,
  seal,
  TAG_BYTES,
  toBase64Url,
  UnsupportedVersionError,
  utf8Decode,
  utf8Encode,
} from "../src/index.ts";
import { flipBit } from "./helpers.ts";

describe("envelope", () => {
  it("round-trips and has the documented layout", async () => {
    const key = await generateKey();
    const env = await seal(key, utf8Encode("hello"), "aad");
    const raw = fromBase64Url(env);
    expect(raw[0]).toBe(ENVELOPE_VERSION);
    expect(raw.length).toBe(1 + NONCE_BYTES + 5 + TAG_BYTES);
    expect(utf8Decode(await open(key, env, "aad"))).toBe("hello");
  });

  it("round-trips empty plaintext", async () => {
    const key = await generateKey();
    expect((await open(key, await seal(key, new Uint8Array(0), "a"), "a")).length).toBe(0);
  });

  it("uses a fresh nonce every time", async () => {
    const key = await generateKey();
    const a = await seal(key, utf8Encode("x"), "a");
    const b = await seal(key, utf8Encode("x"), "a");
    expect(a).not.toBe(b);
  });

  it("fails on tampered nonce, ciphertext and tag", async () => {
    const key = await generateKey();
    const env = await seal(key, utf8Encode("secret data"), "aad");
    const last = fromBase64Url(env).length - 1;
    for (const index of [1, 1 + NONCE_BYTES, last]) {
      await expect(open(key, flipBit(env, index), "aad"), `byte ${index}`).rejects.toBeInstanceOf(
        DecryptionError,
      );
    }
  });

  it("fails with the wrong key", async () => {
    const env = await seal(await generateKey(), utf8Encode("x"), "aad");
    await expect(open(await generateKey(), env, "aad")).rejects.toBeInstanceOf(DecryptionError);
  });

  it("fails with the wrong AAD", async () => {
    const key = await generateKey();
    const env = await seal(key, utf8Encode("x"), "aad-1");
    await expect(open(key, env, "aad-2")).rejects.toBeInstanceOf(DecryptionError);
  });

  it("rejects an unknown version byte", async () => {
    const key = await generateKey();
    const raw = fromBase64Url(await seal(key, utf8Encode("x"), "aad"));
    raw[0] = 0x02;
    await expect(open(key, toBase64Url(raw), "aad")).rejects.toBeInstanceOf(
      UnsupportedVersionError,
    );
  });

  it("rejects truncated and malformed input", async () => {
    const key = await generateKey();
    for (const bad of [
      "",
      "AQ",
      toBase64Url(new Uint8Array(1 + NONCE_BYTES + TAG_BYTES - 1).fill(1)),
      "!!!",
    ]) {
      await expect(open(key, bad, "aad"), bad).rejects.toBeInstanceOf(DecryptionError);
    }
  });

  it("rejects keys of the wrong length", async () => {
    await expect(seal(new Uint8Array(16), utf8Encode("x"), "aad")).rejects.toThrow(TypeError);
  });
});
