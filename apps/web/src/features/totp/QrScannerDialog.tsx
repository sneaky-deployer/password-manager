import { useEffect, useRef, useState } from "react";
import { Alert, Button, Dialog, Field } from "../../components/ui/index.ts";
import {
  classifyQrText,
  createBarcodeDetector,
  decodeImageBlob,
  describeCameraError,
  scanVideoFrame,
} from "./qr-decode.ts";

export interface QrScannerDialogProps {
  open: boolean;
  onClose: () => void;
  /**
   * Called with the decoded text once it passes the check (an `otpauth://` URI or a Base32
   * secret). The dialog then closes itself by calling `onClose`.
   */
  onResult: (text: string) => void;
}

const FRAME_INTERVAL_MS = 200;

/**
 * Scan an authenticator QR code three ways: live camera (native `BarcodeDetector` when available,
 * else frames decoded with jsqr), an uploaded image, or an image pasted from the clipboard.
 * The camera runs only while the dialog is open; every track is stopped on close or unmount.
 */
export function QrScannerDialog({ open, onClose, onResult }: QrScannerDialogProps) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Scan QR code"
      description="Use your camera, upload an image, or paste a screenshot of the QR code."
      footer={
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
      }
    >
      <ScannerBody onResult={onResult} onClose={onClose} />
    </Dialog>
  );
}

function ScannerBody({ onResult, onClose }: Pick<QrScannerDialogProps, "onResult" | "onClose">) {
  const [message, setMessage] = useState<string | null>(null);
  const [cameraOn, setCameraOn] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function handleText(raw: string) {
    const result = classifyQrText(raw);
    if (result.ok) {
      onResult(result.text);
      onClose();
    } else {
      setMessage(result.message);
    }
  }

  async function handleImage(blob: Blob) {
    setMessage(null);
    setBusy(true);
    try {
      const text = await decodeImageBlob(blob);
      if (text === null)
        setMessage("No QR code was found in that image. Try a sharper, closer picture.");
      else handleText(text);
    } catch {
      setMessage("That file couldn't be read as an image.");
    } finally {
      setBusy(false);
    }
  }

  // Pasted screenshots arrive as a paste event anywhere inside the (modal) dialog.
  const latest = useRef({ handleImage, handleText });
  latest.current = { handleImage, handleText };
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const data = event.clipboardData;
      if (!data) return;
      const files = [...Array.from(data.files)];
      for (const item of Array.from(data.items ?? [])) {
        const file = item.kind === "file" ? item.getAsFile() : null;
        if (file) files.push(file);
      }
      const image = files.find((file) => file.type.startsWith("image/"));
      if (!image) return;
      event.preventDefault();
      void latest.current.handleImage(image);
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, []);

  return (
    <div className="space-y-4">
      <section aria-label="Camera" className="space-y-2">
        {cameraOn ? (
          <>
            <CameraScanner
              onText={(text) => latest.current.handleText(text)}
              onError={(error) => {
                setCameraOn(false);
                setCameraError(error);
              }}
            />
            <Button variant="secondary" size="sm" onClick={() => setCameraOn(false)}>
              Stop camera
            </Button>
          </>
        ) : (
          <Button
            variant="secondary"
            onClick={() => {
              setCameraError(null);
              setMessage(null);
              setCameraOn(true);
            }}
          >
            Use camera
          </Button>
        )}
        {cameraError ? <Alert variant="error">{cameraError}</Alert> : null}
      </section>

      <Field label="Upload an image" hint="Or paste a screenshot with Ctrl+V (Cmd+V on a Mac).">
        {(control) => (
          <input
            {...control}
            type="file"
            accept="image/*"
            disabled={busy}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void handleImage(file);
            }}
            className="block w-full text-sm text-slate-700 file:mr-3 file:rounded-lg file:border file:border-slate-300 file:bg-white file:px-3 file:py-1.5 file:text-sm file:font-medium hover:file:bg-slate-50 dark:text-slate-300 dark:file:border-slate-600 dark:file:bg-slate-800 dark:hover:file:bg-slate-700"
          />
        )}
      </Field>

      {message ? <Alert variant="error">{message}</Alert> : null}
    </div>
  );
}

function CameraScanner({
  onText,
  onError,
}: {
  onText: (text: string) => void;
  onError: (message: string) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const callbacks = useRef({ onText, onError });
  callbacks.current = { onText, onError };

  useEffect(() => {
    const video = videoRef.current;
    let cancelled = false;
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const detector = createBarcodeDetector();

    async function loop() {
      if (cancelled) return;
      if (video && video.readyState >= 2) {
        const text = await scanVideoFrame(video, detector);
        if (cancelled) return;
        if (text) callbacks.current.onText(text);
      }
      if (!cancelled) timer = setTimeout(() => void loop(), FRAME_INTERVAL_MS);
    }

    async function start() {
      if (!video || !navigator.mediaDevices?.getUserMedia) {
        callbacks.current.onError(describeCameraError(null));
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" } },
          audio: false,
        });
      } catch (error) {
        if (!cancelled) callbacks.current.onError(describeCameraError(error));
        return;
      }
      if (cancelled) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      video.srcObject = stream;
      await Promise.resolve(video.play()).catch(() => undefined);
      void loop();
    }

    void start();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (stream) for (const track of stream.getTracks()) track.stop();
      if (video) video.srcObject = null;
    };
  }, []);

  return (
    <video
      ref={videoRef}
      aria-label="Camera preview"
      muted
      playsInline
      className="aspect-video w-full rounded-lg bg-slate-900 object-cover"
    />
  );
}
