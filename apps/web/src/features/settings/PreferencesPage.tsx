import {
  AUTO_LOCK_MINUTES_MAX,
  AUTO_LOCK_MINUTES_MIN,
  apiPaths,
  THEMES,
  type Theme,
  updateSettingsResponseSchema,
} from "@pm/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Alert, Button, Card, Field, Input } from "../../components/ui/index.ts";
import { api } from "../../lib/api.ts";
import { describeError } from "../../lib/errors.ts";
import { ME_QUERY_KEY, useRequiredUser } from "../../lib/session.ts";
import { applyTheme } from "../../lib/theme.ts";

const THEME_LABELS: Record<Theme, string> = { system: "System", light: "Light", dark: "Dark" };

export function PreferencesPage() {
  const user = useRequiredUser();
  const queryClient = useQueryClient();
  const [minutes, setMinutes] = useState(String(user.settings.autoLockMinutes));
  const [theme, setTheme] = useState<Theme>(user.settings.theme);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [minutesError, setMinutesError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function save() {
    setSaved(false);
    setError(null);
    const value = Number(minutes);
    if (
      !Number.isInteger(value) ||
      value < AUTO_LOCK_MINUTES_MIN ||
      value > AUTO_LOCK_MINUTES_MAX
    ) {
      setMinutesError(
        `Enter a whole number from ${AUTO_LOCK_MINUTES_MIN} to ${AUTO_LOCK_MINUTES_MAX}.`,
      );
      return;
    }
    setMinutesError(null);
    setPending(true);
    try {
      const { settings } = await api.patch(apiPaths.me.settings, {
        body: { autoLockMinutes: value, theme },
        schema: updateSettingsResponseSchema,
      });
      queryClient.setQueryData(ME_QUERY_KEY, { user: { ...user, settings } });
      setSaved(true);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <Card title="Preferences" description="Stored on your account; they contain nothing secret.">
      <form
        className="space-y-5"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <Field
          label="Lock after (minutes of inactivity)"
          error={minutesError}
          hint="The vault also locks when you reload or close the page."
        >
          {(control) => (
            <Input
              {...control}
              type="number"
              inputMode="numeric"
              min={AUTO_LOCK_MINUTES_MIN}
              max={AUTO_LOCK_MINUTES_MAX}
              value={minutes}
              className="max-w-32"
              onChange={(event) => setMinutes(event.target.value)}
            />
          )}
        </Field>
        <fieldset>
          <legend className="text-sm font-medium">Theme</legend>
          <div className="mt-2 flex flex-wrap gap-4">
            {THEMES.map((value) => (
              <label key={value} className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="theme"
                  value={value}
                  checked={theme === value}
                  className="accent-brand-600"
                  onChange={() => {
                    setTheme(value);
                    applyTheme(value);
                  }}
                />
                {THEME_LABELS[value]}
              </label>
            ))}
          </div>
        </fieldset>
        {error ? <Alert variant="error">{error}</Alert> : null}
        {saved ? <Alert variant="success">Preferences saved.</Alert> : null}
        <Button type="submit" loading={pending}>
          Save preferences
        </Button>
      </form>
    </Card>
  );
}
