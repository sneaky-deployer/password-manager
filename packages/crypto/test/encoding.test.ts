import { describe, expect, it } from "vitest";
import {
  constantTimeEqual,
  fromBase64Url,
  InvalidEncodingError,
  memzero,
  toBase64Url,
  utf8Decode,
  utf8Encode,
  wipe,
} from "../src/index.ts";

describe("base64url", () => {
  it("matches RFC 4648 vectors without padding", () => {
    const enc = (s: string) => toBase64Url(utf8Encode(s));
    expect(enc("")).toBe("");
    expect(enc("f")).toBe("Zg");
    expect(enc("fo")).toBe("Zm8");
    expect(enc("foo")).toBe("Zm9v");
    expect(enc("foob")).toBe("Zm9vYg");
    expect(enc("fooba")).toBe("Zm9vYmE");
    expect(enc("foobar")).toBe("Zm9vYmFy");
  });

  it("uses the URL-safe alphabet", () => {
    expect(toBase64Url(Uint8Array.of(0xfb, 0xff, 0xfe))).toBe("-__-");
  });

  it("round-trips every length up to 70 and random data", () => {
    for (let n = 0; n <= 70; n++) {
      const bytes = new Uint8Array(n);
      crypto.getRandomValues(bytes);
      expect(fromBase64Url(toBase64Url(bytes))).toEqual(bytes);
    }
  });

  it("rejects non-canonical input", () => {
    for (const bad of ["Zg==", "Zm9v+A", "Zm9v/A", "Zm 9v", "Z", "Zh", "Zm9", "é"]) {
      expect(() => fromBase64Url(bad), bad).toThrow(InvalidEncodingError);
    }
  });
});

describe("utf8 and helpers", () => {
  it("round-trips unicode", () => {
    expect(utf8Decode(utf8Encode("pässwörd 🔐"))).toBe("pässwörd 🔐");
  });

  it("rejects invalid UTF-8", () => {
    expect(() => utf8Decode(Uint8Array.of(0xff, 0xfe))).toThrow();
  });

  it("compares in constant time semantics", () => {
    expect(constantTimeEqual(Uint8Array.of(1, 2), Uint8Array.of(1, 2))).toBe(true);
    expect(constantTimeEqual(Uint8Array.of(1, 2), Uint8Array.of(1, 3))).toBe(false);
    expect(constantTimeEqual(Uint8Array.of(1, 2), Uint8Array.of(1))).toBe(false);
  });

  it("memzero and wipe zero buffers and skip empties", () => {
    const a = Uint8Array.of(1, 2, 3);
    const b = Uint8Array.of(4, 5, 6);
    memzero(a);
    expect(a).toEqual(new Uint8Array(3));
    wipe(b, null, undefined);
    expect(b).toEqual(new Uint8Array(3));
  });
});
