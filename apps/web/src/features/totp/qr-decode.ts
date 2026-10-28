import { normalizeSecret } from "@pm/otp";
import jsQR from "jsqr";
import { describeOtpError } from "./otp-errors.ts";

/** Shown when a scanned QR code holds something other than an authenticator secret. */
export const NOT_AN_AUTHENTICATOR_QR = "This QR code isn't an authenticator code";

/** Bare Base32 secrets shorter than this are treated as ordinary text, not as a secret. */
const MIN_BARE_SECRET_LENGTH = 8;

export type QrClassification = { ok: true; text: string } | { ok: false; message: string };

/**
 * Decides whether decoded QR text may be offered as an authenticator source: it must start with
 * `otpauth://` or look like a Base32 secret. Google Authenticator export links get their own
 * explanation; anything else is rejected.
 */
export function classifyQrText(raw: string): QrClassification {
  const text = raw.trim();
  if (/^otpauth:\/\//i.test(text)) return { ok: true, text };
  if (/^otpauth-migration:\/\//i.test(text)) {
    return { ok: false, message: describeOtpError("migration_unsupported") };
  }
  const secret = normalizeSecret(text);
  if (secret !== null && secret.length >= MIN_BARE_SECRET_LENGTH) return { ok: true, text };
  return { ok: false, message: NOT_AN_AUTHENTICATOR_QR };
}

/** Large screenshots are scaled down to this many pixels on the longest side before decoding. */
const MAX_DECODE_DIMENSION = 2000;

type Inversion = "dontInvert" | "attemptBoth";

/** Draws a bitmap / image / video frame onto a canvas and runs jsqr over the pixels. */
export function decodeImageSource(
  source: CanvasImageSource,
  width: number,
  height: number,
  inversion: Inversion = "attemptBoth",
): string | null {
  if (!width || !height) return null;
  const scale = Math.min(1, MAX_DECODE_DIMENSION / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;
  context.drawImage(source, 0, 0, w, h);
  const pixels = context.getImageData(0, 0, w, h);
  return (
    jsQR(pixels.data, pixels.width, pixels.height, { inversionAttempts: inversion })?.data ?? null
  );
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("The file could not be read as an image."));
    image.src = url;
  });
}

/**
 * Decodes the QR code in an image file or pasted screenshot. Resolves to the text, or null when no
 * QR code was found. Rejects when the blob is not a readable image.
 */
export async function decodeImageBlob(blob: Blob): Promise<string | null> {
  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(blob).catch(() => null);
    if (bitmap) {
      try {
        return decodeImageSource(bitmap, bitmap.width, bitmap.height);
      } finally {
        bitmap.close?.();
      }
    }
  }
  // blob: URLs are allowed by the CSP (img-src 'self' data: blob:).
  const url = URL.createObjectURL(blob);
  try {
    const image = await loadImage(url);
    return decodeImageSource(image, image.naturalWidth, image.naturalHeight);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** The subset of the `BarcodeDetector` API we use (not in TypeScript's DOM lib). */
export interface BarcodeDetectorLike {
  detect(source: HTMLVideoElement): Promise<Array<{ rawValue: string }>>;
}
type BarcodeDetectorConstructor = new (options?: { formats?: string[] }) => BarcodeDetectorLike;

/** A native QR detector where the browser has one, else null (use jsqr). */
export function createBarcodeDetector(): BarcodeDetectorLike | null {
  const Ctor = (globalThis as unknown as { BarcodeDetector?: BarcodeDetectorConstructor })
    .BarcodeDetector;
  if (!Ctor) return null;
  try {
    return new Ctor({ formats: ["qr_code"] });
  } catch {
    return null;
  }
}

/** One camera frame: native detector if present (falling back to jsqr if it throws), else jsqr. */
export async function scanVideoFrame(
  video: HTMLVideoElement,
  detector: BarcodeDetectorLike | null,
): Promise<string | null> {
  if (detector) {
    try {
      const found = await detector.detect(video);
      return found[0]?.rawValue ?? null;
    } catch {
      // Fall through to jsqr.
    }
  }
  return decodeImageSource(video, video.videoWidth, video.videoHeight, "dontInvert");
}

/** Plain-language message for a failed `getUserMedia` call. */
export function describeCameraError(error: unknown): string {
  const name =
    typeof error === "object" && error !== null && "name" in error ? String(error.name) : "";
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
    case "PermissionDeniedError":
      return "Camera access was denied. Allow the camera for this site in your browser settings, or upload or paste an image instead.";
    case "NotFoundError":
    case "DevicesNotFoundError":
    case "OverconstrainedError":
      return "No camera was found on this device. Upload or paste an image instead.";
    case "NotReadableError":
    case "AbortError":
      return "The camera is being used by another app. Close it and try again, or upload an image instead.";
    default:
      return "The camera could not be started. Upload or paste an image instead.";
  }
}
