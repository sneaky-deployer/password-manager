const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const dateOnly = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

export function formatDateTime(ms: number): string {
  return dateTime.format(new Date(ms));
}

export function formatDate(ms: number): string {
  return dateOnly.format(new Date(ms));
}

const units: [Intl.RelativeTimeFormatUnit, number][] = [
  ["day", 86_400_000],
  ["hour", 3_600_000],
  ["minute", 60_000],
];
const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

/** "3 hours ago" / "in 2 days". */
export function formatRelative(ms: number, now = Date.now()): string {
  const diff = ms - now;
  for (const [unit, size] of units) {
    if (Math.abs(diff) >= size) return relative.format(Math.round(diff / size), unit);
  }
  return relative.format(0, "minute");
}

/** Groups of four for base32 secrets: "ABCD EFGH ...". */
export function groupSecret(secret: string, size = 4): string {
  return secret
    .replace(/\s+/g, "")
    .replace(new RegExp(`(.{${size}})`, "g"), "$1 ")
    .trim();
}

/** Short, human description of a User-Agent string ("Chrome on Windows"). */
export function describeUserAgent(userAgent: string | null): string {
  if (!userAgent) return "Unknown device";
  const browser = /Edg\//.test(userAgent)
    ? "Edge"
    : /OPR\/|Opera/.test(userAgent)
      ? "Opera"
      : /Firefox\//.test(userAgent)
        ? "Firefox"
        : /Chrome\//.test(userAgent)
          ? "Chrome"
          : /Safari\//.test(userAgent)
            ? "Safari"
            : "Browser";
  const os = /Windows/.test(userAgent)
    ? "Windows"
    : /Android/.test(userAgent)
      ? "Android"
      : /iPhone|iPad|iOS/.test(userAgent)
        ? "iOS"
        : /Mac OS X|Macintosh/.test(userAgent)
          ? "macOS"
          : /Linux/.test(userAgent)
            ? "Linux"
            : null;
  return os ? `${browser} on ${os}` : browser;
}
