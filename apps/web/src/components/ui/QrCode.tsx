import { useMemo } from "react";
import { cn } from "../../lib/cn.ts";
import { encodeQr } from "../../lib/qr.ts";

const QUIET_ZONE = 4;

interface QrCodeProps {
  /** Text to encode (up to 213 bytes). Renders nothing when it does not fit. */
  value: string;
  label: string;
  className?: string;
}

/** Black-on-white QR code as an inline SVG (always high contrast, in light and dark themes). */
export function QrCode({ value, label, className }: QrCodeProps) {
  const matrix = useMemo(() => encodeQr(value), [value]);
  if (!matrix) return null;
  const size = matrix.length + QUIET_ZONE * 2;
  // One path: a horizontal run of dark modules per segment.
  let path = "";
  matrix.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      if (!row[x]) {
        x++;
        continue;
      }
      const start = x;
      while (x < row.length && row[x]) x++;
      path += `M${start + QUIET_ZONE} ${y + QUIET_ZONE}h${x - start}v1h-${x - start}z`;
    }
  });
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${size} ${size}`}
      shapeRendering="crispEdges"
      className={cn("size-48 rounded-lg bg-white", className)}
    >
      <rect width={size} height={size} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}
