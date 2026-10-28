import jsQR from "jsqr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  classifyQrText,
  createBarcodeDetector,
  decodeImageBlob,
  decodeImageSource,
  describeCameraError,
  NOT_AN_AUTHENTICATOR_QR,
  scanVideoFrame,
} from "./qr-decode.ts";

vi.mock("jsqr", () => ({ default: vi.fn() }));
const jsqr = vi.mocked(jsQR);

const URI = "otpauth://totp/Example:me?secret=JBSWY3DPEHPK3PXP&issuer=Example";

function fakeCanvas() {
  const drawImage = vi.fn();
  const getImageData = vi.fn((_x: number, _y: number, w: number, h: number) => ({
    data: new Uint8ClampedArray(w * h * 4),
    width: w,
    height: h,
  }));
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage,
    getImageData,
  } as unknown as CanvasRenderingContext2D);
  return { drawImage, getImageData };
}

beforeEach(() => jsqr.mockReset());
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("classifyQrText", () => {
  it("accepts otpauth URIs", () => {
    expect(classifyQrText(` ${URI}\n`)).toEqual({ ok: true, text: URI });
    expect(classifyQrText("OTPAUTH://totp/x?secret=ABC")).toMatchObject({ ok: true });
  });

  it("accepts values that look like a Base32 secret", () => {
    expect(classifyQrText("JBSWY3DPEHPK3PXP")).toEqual({ ok: true, text: "JBSWY3DPEHPK3PXP" });
    expect(classifyQrText("jbsw y3dp ehpk 3pxp")).toMatchObject({ ok: true });
  });

  it.each([
    "https://example.com/login",
    "WIFI:T:WPA;S:home;P:secret;;",
    "hello 123",
    "ABC",
    "",
    "mailto:me@example.com",
  ])("rejects %j", (text) => {
    expect(classifyQrText(text)).toEqual({ ok: false, message: NOT_AN_AUTHENTICATOR_QR });
  });

  it("explains Google Authenticator export links", () => {
    const result = classifyQrText("otpauth-migration://offline?data=CjEK");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/Google Authenticator/);
  });
});

describe("decodeImageSource", () => {
  it("draws onto a canvas and decodes the pixels with jsqr", () => {
    const { drawImage, getImageData } = fakeCanvas();
    jsqr.mockReturnValue({ data: URI } as ReturnType<typeof jsQR>);
    const source = {} as CanvasImageSource;
    expect(decodeImageSource(source, 300, 200)).toBe(URI);
    expect(drawImage).toHaveBeenCalledWith(source, 0, 0, 300, 200);
    expect(getImageData).toHaveBeenCalledWith(0, 0, 300, 200);
    expect(jsqr).toHaveBeenCalledWith(expect.any(Uint8ClampedArray), 300, 200, {
      inversionAttempts: "attemptBoth",
    });
  });

  it("scales very large images down", () => {
    fakeCanvas();
    jsqr.mockReturnValue(null);
    expect(decodeImageSource({} as CanvasImageSource, 4000, 2000)).toBeNull();
    expect(jsqr).toHaveBeenCalledWith(expect.any(Uint8ClampedArray), 2000, 1000, expect.anything());
  });

  it("returns null for empty sources or a missing 2d context", () => {
    expect(decodeImageSource({} as CanvasImageSource, 0, 0)).toBeNull();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    expect(decodeImageSource({} as CanvasImageSource, 10, 10)).toBeNull();
    expect(jsqr).not.toHaveBeenCalled();
  });
});

describe("decodeImageBlob", () => {
  it("decodes through createImageBitmap and releases the bitmap", async () => {
    fakeCanvas();
    jsqr.mockReturnValue({ data: URI } as ReturnType<typeof jsQR>);
    const close = vi.fn();
    vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue({ width: 64, height: 64, close }));
    await expect(decodeImageBlob(new Blob(["x"], { type: "image/png" }))).resolves.toBe(URI);
    expect(close).toHaveBeenCalled();
  });

  it("returns null when the image has no QR code", async () => {
    fakeCanvas();
    jsqr.mockReturnValue(null);
    vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue({ width: 64, height: 64 }));
    await expect(decodeImageBlob(new Blob(["x"]))).resolves.toBeNull();
  });

  it("falls back to an <img> element when createImageBitmap fails", async () => {
    fakeCanvas();
    jsqr.mockReturnValue({ data: URI } as ReturnType<typeof jsQR>);
    vi.stubGlobal("createImageBitmap", vi.fn().mockRejectedValue(new Error("nope")));
    class FakeImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      naturalWidth = 40;
      naturalHeight = 40;
      set src(_value: string) {
        queueMicrotask(() => this.onload?.());
      }
    }
    vi.stubGlobal("Image", FakeImage);
    const createObjectURL = vi.fn(() => "blob:fake");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL, revokeObjectURL }));
    await expect(decodeImageBlob(new Blob(["x"]))).resolves.toBe(URI);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:fake");
  });

  it("rejects when the file is not a readable image", async () => {
    vi.stubGlobal("createImageBitmap", vi.fn().mockRejectedValue(new Error("bad")));
    class BrokenImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_value: string) {
        queueMicrotask(() => this.onerror?.());
      }
    }
    vi.stubGlobal("Image", BrokenImage);
    vi.stubGlobal(
      "URL",
      Object.assign(URL, { createObjectURL: () => "blob:x", revokeObjectURL: () => {} }),
    );
    await expect(decodeImageBlob(new Blob(["not an image"]))).rejects.toThrow();
  });
});

describe("scanVideoFrame / createBarcodeDetector", () => {
  const video = { videoWidth: 10, videoHeight: 10 } as HTMLVideoElement;

  it("prefers the native detector", async () => {
    const detector = { detect: vi.fn().mockResolvedValue([{ rawValue: URI }]) };
    await expect(scanVideoFrame(video, detector)).resolves.toBe(URI);
    expect(jsqr).not.toHaveBeenCalled();
  });

  it("falls back to jsqr without a detector or when the detector throws", async () => {
    fakeCanvas();
    jsqr.mockReturnValue({ data: URI } as ReturnType<typeof jsQR>);
    await expect(scanVideoFrame(video, null)).resolves.toBe(URI);
    const broken = { detect: vi.fn().mockRejectedValue(new Error("unsupported")) };
    await expect(scanVideoFrame(video, broken)).resolves.toBe(URI);
    expect(jsqr).toHaveBeenCalledWith(expect.any(Uint8ClampedArray), 10, 10, {
      inversionAttempts: "dontInvert",
    });
  });

  it("returns null when the native detector sees nothing", async () => {
    const detector = { detect: vi.fn().mockResolvedValue([]) };
    await expect(scanVideoFrame(video, detector)).resolves.toBeNull();
  });

  it("creates a detector only where BarcodeDetector exists", () => {
    expect(createBarcodeDetector()).toBeNull();
    const ctor = vi.fn(function (this: object) {
      Object.assign(this, { detect: vi.fn() });
    });
    vi.stubGlobal("BarcodeDetector", ctor);
    expect(createBarcodeDetector()).not.toBeNull();
    expect(ctor).toHaveBeenCalledWith({ formats: ["qr_code"] });
  });
});

describe("describeCameraError", () => {
  it("maps getUserMedia failures to plain language", () => {
    expect(describeCameraError(new DOMException("x", "NotAllowedError"))).toMatch(/denied/i);
    expect(describeCameraError(new DOMException("x", "NotFoundError"))).toMatch(/No camera/);
    expect(describeCameraError(new DOMException("x", "NotReadableError"))).toMatch(/another app/);
    expect(describeCameraError(null)).toMatch(/could not be started/);
  });
});
