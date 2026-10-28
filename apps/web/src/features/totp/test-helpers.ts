import { vi } from "vitest";

/** RFC 6238 Appendix B SHA1 seed ("12345678901234567890") as Base32. */
export const RFC_SHA1_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
export const RFC_URI = `otpauth://totp/Example:alice@example.com?secret=${RFC_SHA1_SECRET}&issuer=Example&algorithm=SHA1&digits=8&period=30`;

/** Lets a test flip `document.hidden` and fire `visibilitychange`. */
export function stubDocumentHidden() {
  let hidden = false;
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  return {
    set(next: boolean) {
      hidden = next;
      document.dispatchEvent(new Event("visibilitychange"));
    },
    restore() {
      delete (document as unknown as { hidden?: boolean }).hidden;
    },
  };
}

export function stubTracks() {
  const tracks = [{ stop: vi.fn() }, { stop: vi.fn() }];
  return { tracks, stream: { getTracks: () => tracks } as unknown as MediaStream };
}
