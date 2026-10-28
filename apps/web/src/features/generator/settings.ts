import {
  DEFAULT_PASSPHRASE_OPTIONS,
  DEFAULT_PASSWORD_OPTIONS,
  PASSPHRASE_SEPARATORS,
  type PassphraseOptions,
  type PasswordOptions,
} from "@pm/generator";

/** localStorage key for the remembered generator options (non-sensitive: no generated values). */
export const GENERATOR_STORAGE_KEY = "pm.generator.options.v1";

export type GeneratorMode = "password" | "passphrase";

export type GeneratorSettings = {
  mode: GeneratorMode;
  password: PasswordOptions;
  passphrase: PassphraseOptions;
};

export function defaultGeneratorSettings(): GeneratorSettings {
  return {
    mode: "password",
    password: { ...DEFAULT_PASSWORD_OPTIONS },
    passphrase: { ...DEFAULT_PASSPHRASE_OPTIONS },
  };
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function int(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Validates untrusted stored data field by field; anything unusable falls back to the default. */
export function sanitizeGeneratorSettings(raw: unknown): GeneratorSettings {
  const defaults = defaultGeneratorSettings();
  if (!isRecord(raw)) return defaults;
  const pw = isRecord(raw.password) ? raw.password : {};
  const pp = isRecord(raw.passphrase) ? raw.passphrase : {};
  const separator = PASSPHRASE_SEPARATORS.find((s) => s === pp.separator);
  return {
    mode: raw.mode === "passphrase" ? "passphrase" : "password",
    password: {
      length: int(pw.length, defaults.password.length),
      lowercase: bool(pw.lowercase, defaults.password.lowercase),
      uppercase: bool(pw.uppercase, defaults.password.uppercase),
      digits: bool(pw.digits, defaults.password.digits),
      symbols: bool(pw.symbols, defaults.password.symbols),
      avoidAmbiguous: bool(pw.avoidAmbiguous, defaults.password.avoidAmbiguous),
    },
    passphrase: {
      words: int(pp.words, defaults.passphrase.words),
      separator: separator ?? defaults.passphrase.separator,
      capitalize: bool(pp.capitalize, defaults.passphrase.capitalize),
      includeNumber: bool(pp.includeNumber, defaults.passphrase.includeNumber),
    },
  };
}

/** Reads the remembered options. Never throws: blocked or corrupt storage yields the defaults. */
export function loadGeneratorSettings(): GeneratorSettings {
  try {
    const text = window.localStorage.getItem(GENERATOR_STORAGE_KEY);
    if (!text) return defaultGeneratorSettings();
    return sanitizeGeneratorSettings(JSON.parse(text));
  } catch {
    return defaultGeneratorSettings();
  }
}

/** Remembers the options. Never throws (private windows, quota, blocked storage). */
export function saveGeneratorSettings(settings: GeneratorSettings): void {
  try {
    window.localStorage.setItem(GENERATOR_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Remembering is a convenience only.
  }
}
