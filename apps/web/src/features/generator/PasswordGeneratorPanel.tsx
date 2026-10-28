import {
  GeneratorOptionsError,
  generatePassphrase,
  generatePassword,
  PASSPHRASE_WORDS_MAX,
  PASSPHRASE_WORDS_MIN,
  PASSWORD_LENGTH_MAX,
  PASSWORD_LENGTH_MIN,
  type PassphraseOptions,
  type PassphraseSeparator,
  type PasswordOptions,
  passphraseEntropyBits,
  passwordEntropyBits,
  type Strength,
  strengthFromBits,
} from "@pm/generator";
import { useState } from "react";
import { Alert, Button, Checkbox, CopyButton, Field, Select } from "../../components/ui/index.ts";
import { cn } from "../../lib/cn.ts";
import { ColoredValue } from "./ColoredValue.tsx";
import { RangeControl } from "./RangeControl.tsx";
import { StrengthMeter } from "./StrengthMeter.tsx";
import {
  type GeneratorMode,
  type GeneratorSettings,
  loadGeneratorSettings,
  saveGeneratorSettings,
} from "./settings.ts";

export interface PasswordGeneratorPanelProps {
  /**
   * When given, a "Use this password" button appears and calls this with the generated value.
   * The panel never stores the value; the caller decides what to do with it.
   */
  onUse?: (value: string) => void;
  /** Tighter spacing and smaller type, for dialogs and the item editor. */
  compact?: boolean;
}

type Generated =
  | { ok: true; value: string; bits: number; strength: Strength }
  | { ok: false; message: string };

function generate(settings: GeneratorSettings): Generated {
  try {
    if (settings.mode === "password") {
      const value = generatePassword(settings.password);
      const bits = passwordEntropyBits(settings.password);
      return { ok: true, value, bits, strength: strengthFromBits(bits) };
    }
    const value = generatePassphrase(settings.passphrase);
    const bits = passphraseEntropyBits(settings.passphrase);
    return { ok: true, value, bits, strength: strengthFromBits(bits) };
  } catch (error) {
    if (error instanceof GeneratorOptionsError) return { ok: false, message: error.message };
    return { ok: false, message: "Something went wrong while generating. Try again." };
  }
}

const SEPARATOR_LABELS: Record<PassphraseSeparator, string> = {
  "-": "Hyphen (-)",
  " ": "Space",
  ".": "Period (.)",
  _: "Underscore (_)",
  digit: "Random digit",
};

const MODES: { value: GeneratorMode; label: string }[] = [
  { value: "password", label: "Password" },
  { value: "passphrase", label: "Passphrase" },
];

/**
 * Self-contained password / passphrase generator (PLAN.md 14.2): options, a live coloured result,
 * entropy and strength, copy (30 s clipboard auto-clear) and an optional "Use this password".
 * The last options are remembered in localStorage (no generated values are stored).
 */
export function PasswordGeneratorPanel({ onUse, compact = false }: PasswordGeneratorPanelProps) {
  const [state, setState] = useState(() => {
    const settings = loadGeneratorSettings();
    return { settings, result: generate(settings) };
  });
  const { settings, result } = state;

  function update(next: GeneratorSettings) {
    const result = generate(next);
    // Only remember combinations that work, so a half-edited form never becomes the default.
    if (result.ok) saveGeneratorSettings(next);
    setState({ settings: next, result });
  }

  const setMode = (mode: GeneratorMode) => update({ ...settings, mode });
  const setPassword = (patch: Partial<PasswordOptions>) =>
    update({ ...settings, password: { ...settings.password, ...patch } });
  const setPassphrase = (patch: Partial<PassphraseOptions>) =>
    update({ ...settings, passphrase: { ...settings.passphrase, ...patch } });
  const regenerate = () => setState((s) => ({ ...s, result: generate(s.settings) }));

  const noun = settings.mode === "password" ? "password" : "passphrase";
  const pw = settings.password;
  const pp = settings.passphrase;

  return (
    <div className={cn(compact ? "space-y-3" : "space-y-5")}>
      <fieldset className="grid grid-cols-2 gap-1 rounded-lg bg-slate-100 p-1 dark:bg-slate-800">
        <legend className="sr-only">Generator type</legend>
        {MODES.map((mode) => (
          <label key={mode.value} className="cursor-pointer">
            <input
              type="radio"
              name="generator-mode"
              value={mode.value}
              checked={settings.mode === mode.value}
              onChange={() => setMode(mode.value)}
              className="peer sr-only"
            />
            <span className="block rounded-md px-3 py-1.5 text-center text-sm font-medium text-slate-700 peer-checked:bg-white peer-checked:text-brand-700 peer-checked:shadow-sm peer-focus-visible:outline-2 peer-focus-visible:outline-brand-600 dark:text-slate-300 dark:peer-checked:bg-slate-900 dark:peer-checked:text-brand-300">
              {mode.label}
            </span>
          </label>
        ))}
      </fieldset>

      <div className="space-y-3">
        {result.ok ? (
          <ColoredValue
            value={result.value}
            label={`Generated ${noun}`}
            className={compact ? "text-base" : "text-lg"}
          />
        ) : (
          <Alert variant="error" title="Can't generate">
            {result.message}
          </Alert>
        )}
        {result.ok ? <StrengthMeter strength={result.strength} bits={result.bits} /> : null}
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" onClick={regenerate}>
            Regenerate
          </Button>
          <CopyButton
            value={() => (result.ok ? result.value : "")}
            label="Copy"
            disabled={!result.ok}
          />
          {onUse ? (
            <Button
              size="sm"
              disabled={!result.ok}
              onClick={() => {
                if (result.ok) onUse(result.value);
              }}
            >
              Use this password
            </Button>
          ) : null}
        </div>
      </div>

      <div
        className={cn(
          "grid gap-4 border-t border-slate-200 pt-4 dark:border-slate-800",
          !compact && "sm:grid-cols-2",
        )}
      >
        {settings.mode === "password" ? (
          <>
            <RangeControl
              label="Length"
              value={pw.length}
              min={PASSWORD_LENGTH_MIN}
              max={PASSWORD_LENGTH_MAX}
              onChange={(length) => setPassword({ length })}
            />
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Characters</legend>
              <Checkbox
                label="Lowercase letters (a-z)"
                checked={pw.lowercase}
                onChange={(e) => setPassword({ lowercase: e.target.checked })}
              />
              <Checkbox
                label="Uppercase letters (A-Z)"
                checked={pw.uppercase}
                onChange={(e) => setPassword({ uppercase: e.target.checked })}
              />
              <Checkbox
                label="Digits (0-9)"
                checked={pw.digits}
                onChange={(e) => setPassword({ digits: e.target.checked })}
              />
              <Checkbox
                label="Symbols (!@#$%^&*)"
                checked={pw.symbols}
                onChange={(e) => setPassword({ symbols: e.target.checked })}
              />
            </fieldset>
            <Checkbox
              label="Avoid ambiguous characters"
              description="Leaves out 0 O o 1 l I |"
              checked={pw.avoidAmbiguous}
              onChange={(e) => setPassword({ avoidAmbiguous: e.target.checked })}
            />
          </>
        ) : (
          <>
            <RangeControl
              label="Words"
              value={pp.words}
              min={PASSPHRASE_WORDS_MIN}
              max={PASSPHRASE_WORDS_MAX}
              onChange={(words) => setPassphrase({ words })}
            />
            <Field label="Separator">
              {(control) => (
                <Select
                  {...control}
                  value={pp.separator}
                  onChange={(e) =>
                    setPassphrase({ separator: e.target.value as PassphraseSeparator })
                  }
                >
                  {(Object.keys(SEPARATOR_LABELS) as PassphraseSeparator[]).map((value) => (
                    <option key={value} value={value}>
                      {SEPARATOR_LABELS[value]}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <fieldset className="space-y-2">
              <legend className="sr-only">Passphrase options</legend>
              <Checkbox
                label="Capitalize each word"
                checked={pp.capitalize}
                onChange={(e) => setPassphrase({ capitalize: e.target.checked })}
              />
              <Checkbox
                label="Include a number"
                checked={pp.includeNumber}
                onChange={(e) => setPassphrase({ includeNumber: e.target.checked })}
              />
            </fieldset>
          </>
        )}
      </div>
    </div>
  );
}
