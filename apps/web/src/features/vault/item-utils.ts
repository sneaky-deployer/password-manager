/** Only http(s) links are ever opened (no `javascript:`, `data:` ...). Returns the normalised URL. */
export function safeHttpUrl(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`;
  try {
    const url = new URL(candidate);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

/** Host for display, or the raw text. */
export function displayHost(raw: string): string {
  const safe = safeHttpUrl(raw);
  if (!safe) return raw;
  return new URL(safe).host;
}

const AVATAR_COLORS = [
  "bg-rose-500",
  "bg-orange-500",
  "bg-amber-600",
  "bg-emerald-600",
  "bg-teal-600",
  "bg-sky-600",
  "bg-indigo-500",
  "bg-violet-600",
  "bg-fuchsia-600",
  "bg-slate-600",
];

/** A stable colour for a name (no network, no favicons). */
export function avatarColor(name: string): string {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length] ?? "bg-slate-600";
}

export function avatarLetter(name: string): string {
  const first = [...name.trim()][0];
  return first ? first.toUpperCase() : "?";
}

/** Vault colours as stored in the encrypted metadata. Full class names so Tailwind sees them. */
export const VAULT_COLORS: Record<string, string> = {
  slate: "bg-slate-500",
  red: "bg-red-500",
  orange: "bg-orange-500",
  amber: "bg-amber-500",
  green: "bg-emerald-500",
  teal: "bg-teal-500",
  sky: "bg-sky-500",
  violet: "bg-violet-500",
  pink: "bg-pink-500",
};
export const VAULT_COLOR_NAMES = Object.keys(VAULT_COLORS);

export function vaultDotClass(color: string | undefined): string {
  return (color && VAULT_COLORS[color]) || "bg-slate-400";
}

export const ROLE_LABELS = {
  viewer: "Viewer",
  editor: "Editor",
  manager: "Manager",
  owner: "Owner",
} as const;
