// @vitest-environment node
import jsQR from "jsqr";
import { describe, expect, it } from "vitest";
import { encodeQr, QR_MAX_BYTES } from "./qr.ts";

/** Rasterise with a 4-module quiet zone, as a camera would see it, then decode with jsqr. */
function decode(matrix: boolean[][], scale = 4): string | null {
  const quiet = 4;
  const size = (matrix.length + quiet * 2) * scale;
  const pixels = new Uint8ClampedArray(size * size * 4).fill(255);
  for (const [y, row] of matrix.entries()) {
    for (const [x, dark] of row.entries()) {
      if (!dark) continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const i = (((y + quiet) * scale + dy) * size + (x + quiet) * scale + dx) * 4;
          pixels[i] = pixels[i + 1] = pixels[i + 2] = 0;
        }
      }
    }
  }
  return jsQR(pixels, size, size)?.data ?? null;
}

describe("encodeQr", () => {
  it("round-trips short and typical otpauth strings through a real QR decoder", () => {
    const samples = [
      "a",
      "hello world",
      "otpauth://totp/Password%20Manager:alice%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=Password%20Manager",
      "otpauth://totp/Example:alice@google.com?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Example&algorithm=SHA1&digits=6&period=30",
      "https://example.com/ü?q=é€",
    ];
    for (const text of samples) {
      const matrix = encodeQr(text);
      expect(matrix, text).not.toBeNull();
      expect(decode(matrix as boolean[][]), text).toBe(text);
    }
  });

  it("round-trips every version from 1 to 10 at its maximum capacity", () => {
    // Capacities of level M: 14, 26, 42, 62, 84, 106, 122, 152, 180, 213 bytes.
    for (const length of [14, 26, 42, 62, 84, 106, 122, 152, 180, 213]) {
      const text = Array.from({ length }, (_, i) => String.fromCharCode(97 + ((i * 7) % 26))).join(
        "",
      );
      const matrix = encodeQr(text) as boolean[][];
      expect(matrix, `length ${length}`).not.toBeNull();
      expect(decode(matrix), `length ${length}`).toBe(text);
    }
  });

  it("picks the smallest version that fits", () => {
    expect((encodeQr("x".repeat(14)) as boolean[][]).length).toBe(21);
    expect((encodeQr("x".repeat(15)) as boolean[][]).length).toBe(25);
    expect((encodeQr("x".repeat(QR_MAX_BYTES)) as boolean[][]).length).toBe(57);
  });

  it("returns null when the text does not fit", () => {
    expect(encodeQr("x".repeat(QR_MAX_BYTES + 1))).toBeNull();
  });
});
