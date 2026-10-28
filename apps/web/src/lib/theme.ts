import type { Theme } from "@pm/shared";

/** Only a non-sensitive UI preference lives in localStorage (PLAN.md 15). */
const STORAGE_KEY = "pm.theme";

export function readStoredTheme(): Theme {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    if (value === "light" || value === "dark" || value === "system") return value;
  } catch {
    // Storage can be blocked (private window); fall through to the default.
  }
  return "system";
}

export function storeTheme(theme: Theme): void {
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Not critical.
  }
}

let media: MediaQueryList | null = null;
let mediaListener: (() => void) | null = null;

function setDarkClass(dark: boolean): void {
  document.documentElement.classList.toggle("dark", dark);
}

/** Applies the theme by toggling the `dark` class on `<html>`; "system" follows the OS live. */
export function applyTheme(theme: Theme): void {
  if (media && mediaListener) media.removeEventListener("change", mediaListener);
  media = null;
  mediaListener = null;
  if (theme === "system") {
    if (typeof window.matchMedia === "function") {
      media = window.matchMedia("(prefers-color-scheme: dark)");
      const current = media;
      mediaListener = () => setDarkClass(current.matches);
      media.addEventListener("change", mediaListener);
      setDarkClass(media.matches);
    } else {
      setDarkClass(false);
    }
    return;
  }
  setDarkClass(theme === "dark");
}
