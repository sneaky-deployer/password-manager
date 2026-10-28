import { Field, PasswordInput } from "../../components/ui/index.ts";
import { PasswordStrengthMeter } from "./PasswordStrengthMeter.tsx";
import { assessPassword } from "./password-policy.ts";

export interface NewPasswordValue {
  password: string;
  confirm: string;
}

export const EMPTY_NEW_PASSWORD: NewPasswordValue = { password: "", confirm: "" };

/** First problem with a new master password, or null. Shared by every form that sets one. */
export function validateNewPassword(
  value: NewPasswordValue,
  userInputs: string[] = [],
): string | null {
  const assessment = assessPassword(value.password, userInputs);
  if (!assessment.longEnough) return "Use at least 12 characters.";
  if (!assessment.strongEnough)
    return "That password is too easy to guess. Add more unrelated words.";
  if (value.password !== value.confirm) return "The two passwords do not match.";
  return null;
}

interface Props {
  value: NewPasswordValue;
  onChange: (value: NewPasswordValue) => void;
  /** Email and similar strings that must not appear in the password. */
  userInputs?: string[];
  /** Show validation errors (set after the first submit attempt). */
  showErrors?: boolean;
  disabled?: boolean;
  passwordLabel?: string;
}

export function NewPasswordFields({
  value,
  onChange,
  userInputs,
  showErrors = false,
  disabled,
  passwordLabel = "Master password",
}: Props) {
  const assessment = assessPassword(value.password, userInputs);
  const passwordError =
    showErrors && !assessment.ok
      ? assessment.longEnough
        ? "That password is too easy to guess."
        : "Use at least 12 characters."
      : null;
  const confirmError =
    (showErrors || value.confirm) && value.confirm !== value.password
      ? "The two passwords do not match."
      : null;
  return (
    <>
      <Field label={passwordLabel} error={passwordError} required>
        {(control) => (
          <PasswordInput
            {...control}
            name="new-password"
            autoComplete="new-password"
            value={value.password}
            disabled={disabled}
            onChange={(event) => onChange({ ...value, password: event.target.value })}
          />
        )}
      </Field>
      <PasswordStrengthMeter password={value.password} {...(userInputs ? { userInputs } : {})} />
      <Field label="Confirm password" error={confirmError} required>
        {(control) => (
          <PasswordInput
            {...control}
            name="confirm-password"
            autoComplete="new-password"
            value={value.confirm}
            disabled={disabled}
            onChange={(event) => onChange({ ...value, confirm: event.target.value })}
          />
        )}
      </Field>
    </>
  );
}
