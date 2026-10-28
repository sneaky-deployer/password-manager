import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QrScannerDialog } from "./QrScannerDialog.tsx";
import { decodeImageBlob } from "./qr-decode.ts";
import { stubTracks } from "./test-helpers.ts";

vi.mock("./qr-decode.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./qr-decode.ts")>();
  return { ...actual, decodeImageBlob: vi.fn() };
});
const decode = vi.mocked(decodeImageBlob);

const URI = "otpauth://totp/Example:me?secret=JBSWY3DPEHPK3PXP&issuer=Example";
const png = () => new File(["fake"], "qr.png", { type: "image/png" });

function setup(open = true) {
  const onClose = vi.fn();
  const onResult = vi.fn();
  const view = render(<QrScannerDialog open={open} onClose={onClose} onResult={onResult} />);
  return { onClose, onResult, ...view };
}

beforeEach(() => {
  decode.mockReset();
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(navigator, "mediaDevices");
});

function stubCamera(impl: () => Promise<MediaStream>) {
  const getUserMedia = vi.fn(impl);
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia },
  });
  return getUserMedia;
}

describe("QrScannerDialog: image upload", () => {
  it("passes an accepted result to onResult and closes", async () => {
    decode.mockResolvedValue(URI);
    const user = userEvent.setup();
    const { onResult, onClose } = setup();
    await user.upload(screen.getByLabelText("Upload an image"), png());
    await waitFor(() => expect(onResult).toHaveBeenCalledWith(URI));
    expect(onClose).toHaveBeenCalled();
    expect(decode).toHaveBeenCalledWith(expect.objectContaining({ name: "qr.png" }));
  });

  it("accepts a bare Base32 secret", async () => {
    decode.mockResolvedValue("JBSWY3DPEHPK3PXP");
    const user = userEvent.setup();
    const { onResult } = setup();
    await user.upload(screen.getByLabelText("Upload an image"), png());
    await waitFor(() => expect(onResult).toHaveBeenCalledWith("JBSWY3DPEHPK3PXP"));
  });

  it("rejects QR codes that are not authenticator codes", async () => {
    decode.mockResolvedValue("https://example.com/");
    const user = userEvent.setup();
    const { onResult, onClose } = setup();
    await user.upload(screen.getByLabelText("Upload an image"), png());
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This QR code isn't an authenticator code",
    );
    expect(onResult).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("says so when no QR code is found", async () => {
    decode.mockResolvedValue(null);
    const user = userEvent.setup();
    const { onResult } = setup();
    await user.upload(screen.getByLabelText("Upload an image"), png());
    expect(await screen.findByRole("alert")).toHaveTextContent(/No QR code was found/);
    expect(onResult).not.toHaveBeenCalled();
  });

  it("says so when the file is not a readable image", async () => {
    decode.mockRejectedValue(new Error("bad image"));
    const user = userEvent.setup();
    setup();
    await user.upload(screen.getByLabelText("Upload an image"), png());
    expect(await screen.findByRole("alert")).toHaveTextContent(/couldn't be read as an image/);
  });
});

describe("QrScannerDialog: paste", () => {
  it("decodes an image pasted from the clipboard", async () => {
    decode.mockResolvedValue(URI);
    const { onResult } = setup();
    const file = png();
    fireEvent.paste(document, { clipboardData: { files: [file], items: [] } });
    await waitFor(() => expect(onResult).toHaveBeenCalledWith(URI));
    expect(decode).toHaveBeenCalledWith(file);
  });

  it("ignores pasted text", () => {
    const { onResult } = setup();
    fireEvent.paste(document, { clipboardData: { files: [], items: [] } });
    expect(decode).not.toHaveBeenCalled();
    expect(onResult).not.toHaveBeenCalled();
  });

  it("stops listening once closed", () => {
    const { rerender, onClose, onResult } = setup();
    rerender(<QrScannerDialog open={false} onClose={onClose} onResult={onResult} />);
    fireEvent.paste(document, { clipboardData: { files: [png()], items: [] } });
    expect(decode).not.toHaveBeenCalled();
  });
});

describe("QrScannerDialog: camera", () => {
  it("stops every media track when the dialog closes", async () => {
    const { tracks, stream } = stubTracks();
    const getUserMedia = stubCamera(async () => stream);
    const user = userEvent.setup();
    const { rerender, onClose, onResult } = setup();

    await user.click(screen.getByRole("button", { name: "Use camera" }));
    await waitFor(() => expect(getUserMedia).toHaveBeenCalled());
    expect(getUserMedia).toHaveBeenCalledWith({
      video: { facingMode: { ideal: "environment" } },
      audio: false,
    });
    await screen.findByLabelText("Camera preview");
    for (const track of tracks) expect(track.stop).not.toHaveBeenCalled();

    rerender(<QrScannerDialog open={false} onClose={onClose} onResult={onResult} />);
    for (const track of tracks) expect(track.stop).toHaveBeenCalledTimes(1);
  });

  it("stops the tracks on unmount and on 'Stop camera'", async () => {
    const first = stubTracks();
    stubCamera(async () => first.stream);
    const user = userEvent.setup();
    const { unmount } = setup();
    await user.click(screen.getByRole("button", { name: "Use camera" }));
    await screen.findByLabelText("Camera preview");
    await act(async () => {});
    unmount();
    for (const track of first.tracks) expect(track.stop).toHaveBeenCalled();

    const second = stubTracks();
    stubCamera(async () => second.stream);
    setup();
    await user.click(screen.getByRole("button", { name: "Use camera" }));
    await act(async () => {});
    await user.click(screen.getByRole("button", { name: "Stop camera" }));
    for (const track of second.tracks) expect(track.stop).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Use camera" })).toBeInTheDocument();
  });

  it("stops tracks that arrive after the dialog was already closed", async () => {
    const { tracks, stream } = stubTracks();
    let resolve: (s: MediaStream) => void = () => {};
    stubCamera(() => new Promise<MediaStream>((r) => (resolve = r)));
    const user = userEvent.setup();
    const { rerender, onClose, onResult } = setup();
    await user.click(screen.getByRole("button", { name: "Use camera" }));
    rerender(<QrScannerDialog open={false} onClose={onClose} onResult={onResult} />);
    await act(async () => resolve(stream));
    for (const track of tracks) expect(track.stop).toHaveBeenCalled();
  });

  it("delivers a code detected in a camera frame", async () => {
    const { tracks, stream } = stubTracks();
    stubCamera(async () => stream);
    vi.spyOn(HTMLMediaElement.prototype, "readyState", "get").mockReturnValue(4);
    vi.stubGlobal(
      "BarcodeDetector",
      class {
        detect = vi.fn().mockResolvedValue([{ rawValue: URI }]);
      },
    );
    try {
      const user = userEvent.setup();
      const { onResult, onClose } = setup();
      await user.click(screen.getByRole("button", { name: "Use camera" }));
      await waitFor(() => expect(onResult).toHaveBeenCalledWith(URI));
      expect(onClose).toHaveBeenCalled();
      expect(tracks.length).toBeGreaterThan(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("shows a clear message when permission is denied", async () => {
    stubCamera(async () => {
      throw new DOMException("Permission denied", "NotAllowedError");
    });
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole("button", { name: "Use camera" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Camera access was denied/);
    // The other two ways are still available.
    expect(screen.getByLabelText("Upload an image")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use camera" })).toBeInTheDocument();
  });

  it("explains when the browser has no camera API", async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole("button", { name: "Use camera" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/camera could not be started/);
  });
});
