import { describe, expect, it } from "vitest";
import {
  aesGcmDecrypt,
  aesGcmDecryptToString,
  aesGcmEncrypt,
  base64urlDecode,
  base64urlEncode,
  constantTimeEqual,
  fakeSalt,
  hexEncode,
  hmacSha256Hex,
  newId,
  randomDigits,
  randomToken,
  sha256Hex,
  verifyHmac,
} from "../src/lib/crypto.ts";

const utf8 = (s: string) => new TextEncoder().encode(s);

describe("hmac and sha256", () => {
  // RFC 4231 test case 2.
  const key = utf8("Jefe");
  const data = "what do ya want for nothing?";
  const expected = "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843";

  it("matches the RFC 4231 HMAC-SHA256 vector", async () => {
    expect(await hmacSha256Hex(key, data)).toBe(expected);
    expect(await hmacSha256Hex(key, utf8(data))).toBe(expected);
  });

  it("verifyHmac accepts the right MAC and rejects everything else", async () => {
    expect(await verifyHmac(key, data, expected)).toBe(true);
    expect(await verifyHmac(key, data, expected.toUpperCase())).toBe(true);
    expect(await verifyHmac(key, `${data}!`, expected)).toBe(false);
    expect(await verifyHmac(utf8("other"), data, expected)).toBe(false);
    expect(await verifyHmac(key, data, `${expected.slice(0, -1)}0`)).toBe(false);
    expect(await verifyHmac(key, data, expected.slice(2))).toBe(false); // wrong length
    expect(await verifyHmac(key, data, "not hex")).toBe(false);
    expect(await verifyHmac(key, data, "")).toBe(false);
  });

  it("matches the SHA-256 vector for 'abc'", async () => {
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("constantTimeEqual compares by value", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
    expect(constantTimeEqual("", "")).toBe(true);
  });
});

describe("base64url", () => {
  it("round-trips arbitrary bytes without padding", () => {
    for (const length of [0, 1, 2, 3, 4, 31, 32, 33, 1000]) {
      const bytes = crypto.getRandomValues(new Uint8Array(length));
      const encoded = base64urlEncode(bytes);
      expect(encoded).toMatch(/^[A-Za-z0-9_-]*$/);
      expect(base64urlDecode(encoded)).toEqual(bytes);
    }
  });

  it("encodes known values", () => {
    expect(base64urlEncode("")).toBe("");
    expect(base64urlEncode("f")).toBe("Zg");
    expect(base64urlEncode(new Uint8Array([0xfb, 0xff]))).toBe("-_8");
  });

  it("handles large inputs", () => {
    const big = new Uint8Array(200_000).map((_, i) => i % 251);
    expect(base64urlDecode(base64urlEncode(big))).toEqual(big);
  });

  it("rejects invalid input", () => {
    expect(() => base64urlDecode("Zg==")).toThrow();
    expect(() => base64urlDecode("a+b/")).toThrow();
    expect(() => base64urlDecode("A")).toThrow();
  });
});

describe("randomness", () => {
  it("randomToken is 32 bytes by default and unique", () => {
    const a = randomToken();
    expect(base64urlDecode(a)).toHaveLength(32);
    expect(a).not.toBe(randomToken());
    expect(base64urlDecode(randomToken(16))).toHaveLength(16);
  });

  it("newId is a UUID v4", () => {
    expect(newId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("randomDigits returns zero-padded digits", () => {
    for (let i = 0; i < 50; i++) expect(randomDigits(6)).toMatch(/^\d{6}$/);
  });
});

describe("AES-256-GCM", () => {
  const key = crypto.getRandomValues(new Uint8Array(32));

  it("round-trips and uses a fresh IV each time", async () => {
    const a = await aesGcmEncrypt(key, "JBSWY3DPEHPK3PXP");
    const b = await aesGcmEncrypt(key, "JBSWY3DPEHPK3PXP");
    expect(a).not.toBe(b);
    expect(await aesGcmDecryptToString(key, a)).toBe("JBSWY3DPEHPK3PXP");
    // format: base64url(iv(12) || ciphertext || tag(16))
    expect(base64urlDecode(a)).toHaveLength(12 + 16 + 16);
  });

  it("round-trips bytes", async () => {
    const plain = crypto.getRandomValues(new Uint8Array(100));
    expect(await aesGcmDecrypt(key, await aesGcmEncrypt(key, plain))).toEqual(plain);
  });

  it("fails with the wrong key, wrong AAD or tampered data", async () => {
    const sealed = await aesGcmEncrypt(key, "secret", "user-1");
    expect(await aesGcmDecryptToString(key, sealed, "user-1")).toBe("secret");
    await expect(aesGcmDecrypt(key, sealed, "user-2")).rejects.toThrow();
    await expect(aesGcmDecrypt(key, sealed)).rejects.toThrow();
    await expect(
      aesGcmDecrypt(crypto.getRandomValues(new Uint8Array(32)), sealed, "user-1"),
    ).rejects.toThrow();
    const bytes = base64urlDecode(sealed);
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1;
    await expect(aesGcmDecrypt(key, base64urlEncode(bytes), "user-1")).rejects.toThrow();
    await expect(aesGcmDecrypt(key, "AAAA", "user-1")).rejects.toThrow();
  });

  it("requires a 32-byte key", async () => {
    await expect(aesGcmEncrypt(new Uint8Array(16), "x")).rejects.toThrow();
  });
});

describe("fakeSalt", () => {
  const fakeKey = utf8("0123456789abcdef0123456789abcdef");

  it("is deterministic, 16 bytes and normalises the email", async () => {
    const salt = await fakeSalt(fakeKey, "alice@example.test");
    expect(salt).toBe(await fakeSalt(fakeKey, "alice@example.test"));
    expect(salt).toBe(await fakeSalt(fakeKey, "  Alice@Example.TEST "));
    expect(base64urlDecode(salt)).toHaveLength(16);
  });

  it("is the first 16 bytes of HMAC-SHA256(key, email)", async () => {
    const mac = await hmacSha256Hex(fakeKey, "alice@example.test");
    expect(hexEncode(base64urlDecode(await fakeSalt(fakeKey, "alice@example.test")))).toBe(
      mac.slice(0, 32),
    );
  });

  it("differs per email and per key", async () => {
    const a = await fakeSalt(fakeKey, "alice@example.test");
    expect(a).not.toBe(await fakeSalt(fakeKey, "bob@example.test"));
    expect(a).not.toBe(
      await fakeSalt(utf8("another-32-byte-key-another-32-by"), "alice@example.test"),
    );
  });
});
