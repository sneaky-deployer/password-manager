import { apiPaths, type UserLookupResponse, userLookupResponseSchema } from "@pm/shared";
import { useState } from "react";
import { Alert, Button, Field, Input, Select } from "../../components/ui/index.ts";
import { api, isApiError } from "../../lib/api.ts";
import { describeVaultError } from "../vault/errors.ts";

interface InviteFormProps<R extends string> {
  roles: ReadonlyArray<{ value: R; label: string }>;
  submitLabel: string;
  /** Seal the key for the recipient and send the invitation. Throws to show an error. */
  onInvite: (recipient: UserLookupResponse, role: R) => Promise<void>;
}

/** Look a user up by email, pick a role, send the invitation. Shared by vault and item sharing. */
export function InviteForm<R extends string>({ roles, submitLabel, onInvite }: InviteFormProps<R>) {
  const [email, setEmail] = useState("");
  const [recipient, setRecipient] = useState<UserLookupResponse | null>(null);
  const [role, setRole] = useState<R | "">("");
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const [looking, setLooking] = useState(false);
  const [inviting, setInviting] = useState(false);

  const chosenRole = role || roles[0]?.value;

  async function lookup(event: React.FormEvent) {
    event.preventDefault();
    setLookupError(null);
    setInviteError(null);
    setSent(null);
    setRecipient(null);
    const wanted = email.trim().toLowerCase();
    if (!wanted) {
      setLookupError("Enter the email address of the person.");
      return;
    }
    setLooking(true);
    try {
      setRecipient(
        await api.get(apiPaths.users.lookup, {
          schema: userLookupResponseSchema,
          query: { email: wanted },
        }),
      );
    } catch (error) {
      setLookupError(
        isApiError(error, "not_found")
          ? "No active account uses that email address."
          : isApiError(error, "validation_error")
            ? "That does not look like an email address."
            : describeVaultError(error),
      );
    } finally {
      setLooking(false);
    }
  }

  async function invite() {
    if (!recipient || !chosenRole) return;
    setInviteError(null);
    setInviting(true);
    try {
      await onInvite(recipient, chosenRole);
      setSent(recipient.email);
      setRecipient(null);
      setEmail("");
    } catch (error) {
      setInviteError(describeVaultError(error));
    } finally {
      setInviting(false);
    }
  }

  return (
    <div className="space-y-3">
      <form onSubmit={(event) => void lookup(event)} className="flex items-end gap-2" noValidate>
        <Field label="Email address" error={lookupError} className="flex-1">
          {(control) => (
            <Input
              {...control}
              type="email"
              autoComplete="off"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          )}
        </Field>
        <Button type="submit" variant="secondary" loading={looking} className="mb-[1px]">
          Find person
        </Button>
      </form>

      {recipient ? (
        <div className="space-y-3 rounded-lg border border-slate-200 p-3 dark:border-slate-700">
          <p className="text-sm">
            Found <strong>{recipient.email}</strong>.
          </p>
          <Field label="Role">
            {(control) => (
              <Select
                {...control}
                value={chosenRole}
                onChange={(event) => setRole(event.target.value as R)}
              >
                {roles.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          {inviteError ? <Alert variant="error">{inviteError}</Alert> : null}
          <Button loading={inviting} onClick={() => void invite()}>
            {submitLabel}
          </Button>
        </div>
      ) : null}

      {sent ? (
        <Alert variant="success">
          Invitation sent to {sent}. They get access once they accept it.
        </Alert>
      ) : null}
    </div>
  );
}
