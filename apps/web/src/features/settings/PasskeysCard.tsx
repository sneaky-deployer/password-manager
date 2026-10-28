import {
  apiPaths,
  listPasskeysResponseSchema,
  type PasskeyInfo,
  webauthnRegisterOptionsResponseSchema,
  webauthnRegisterVerifyResponseSchema,
  webauthnRemoveResponseSchema,
} from "@pm/shared";
import { browserSupportsWebAuthn, startRegistration } from "@simplewebauthn/browser";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  Alert,
  Button,
  Card,
  Dialog,
  EmptyState,
  Field,
  Input,
  Spinner,
} from "../../components/ui/index.ts";
import { api } from "../../lib/api.ts";
import { describeError } from "../../lib/errors.ts";
import { formatDate, formatRelative } from "../../lib/format.ts";
import { refreshSession, useRequiredUser } from "../../lib/session.ts";
import { BackupCodesDialog } from "./BackupCodesDialog.tsx";

const QUERY_KEY = ["settings", "passkeys"] as const;

/** Passkeys / security keys as a second factor (PLAN.md 10.6). */
export function PasskeysCard() {
  const user = useRequiredUser();
  const queryClient = useQueryClient();
  const supported = browserSupportsWebAuthn();
  const passkeys = useQuery({
    queryKey: QUERY_KEY,
    queryFn: ({ signal }) =>
      api.get(apiPaths.me.webauthn, { schema: listPasskeysResponseSchema, signal }),
  });
  const [name, setName] = useState("");
  const [adding, setAdding] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<PasskeyInfo | null>(null);
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null);

  async function register() {
    const label = name.trim();
    if (!label) {
      setError("Give the passkey a name, for example “Laptop”.");
      return;
    }
    setPending(true);
    setError(null);
    try {
      const { options } = await api.post(apiPaths.me.webauthnRegisterOptions, {
        schema: webauthnRegisterOptionsResponseSchema,
      });
      const credential = await startRegistration({
        optionsJSON: options as unknown as Parameters<typeof startRegistration>[0]["optionsJSON"],
      });
      const result = await api.post(apiPaths.me.webauthnRegisterVerify, {
        body: { name: label, credential },
        schema: webauthnRegisterVerifyResponseSchema,
      });
      setAdding(false);
      setName("");
      if (result.backupCodes) setBackupCodes(result.backupCodes);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: QUERY_KEY }),
        refreshSession(queryClient),
      ]);
    } catch (err) {
      setError(
        err instanceof Error && err.name === "NotAllowedError"
          ? "Passkey registration was cancelled or timed out."
          : describeError(err, "Could not register the passkey."),
      );
    } finally {
      setPending(false);
    }
  }

  async function remove(passkey: PasskeyInfo) {
    setPending(true);
    setError(null);
    try {
      await api.delete(apiPaths.me.webauthnCredential(passkey.id), {
        schema: webauthnRemoveResponseSchema,
      });
      setRemoving(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: QUERY_KEY }),
        refreshSession(queryClient),
      ]);
    } catch (err) {
      setError(describeError(err));
      setRemoving(null);
    } finally {
      setPending(false);
    }
  }

  const list = passkeys.data?.credentials ?? [];

  return (
    <Card
      title="Passkeys"
      description="Use a device passkey or a security key as a second step when you sign in."
      actions={
        supported && !adding ? (
          <Button variant="secondary" size="sm" onClick={() => setAdding(true)}>
            Add passkey
          </Button>
        ) : null
      }
    >
      {!supported ? <Alert variant="info">This browser does not support passkeys.</Alert> : null}
      {error ? <Alert variant="error">{error}</Alert> : null}

      {adding ? (
        <form
          className="flex flex-wrap items-end gap-3"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void register();
          }}
        >
          <Field label="Passkey name" className="min-w-48 flex-1">
            {(control) => (
              <Input
                {...control}
                value={name}
                maxLength={100}
                onChange={(event) => setName(event.target.value)}
              />
            )}
          </Field>
          <Button type="submit" loading={pending}>
            Continue
          </Button>
          <Button variant="ghost" disabled={pending} onClick={() => setAdding(false)}>
            Cancel
          </Button>
        </form>
      ) : null}

      {passkeys.isPending ? (
        <Spinner label="Loading passkeys" />
      ) : passkeys.isError ? (
        <Alert variant="error">{describeError(passkeys.error)}</Alert>
      ) : list.length === 0 ? (
        <EmptyState title="No passkeys yet">Add one to use it as a sign-in second step.</EmptyState>
      ) : (
        <ul className="divide-y divide-slate-200 rounded-lg border border-slate-200 dark:divide-slate-800 dark:border-slate-800">
          {list.map((passkey) => (
            <li key={passkey.id} className="flex items-center justify-between gap-3 px-4 py-3">
              <div>
                <p className="text-sm font-medium">{passkey.name}</p>
                <p className="text-xs text-slate-600 dark:text-slate-400">
                  Added {formatDate(passkey.createdAt)}
                  {passkey.lastUsedAt
                    ? ` · last used ${formatRelative(passkey.lastUsedAt)}`
                    : " · never used"}
                </p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                aria-label={`Remove ${passkey.name}`}
                onClick={() => setRemoving(passkey)}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}

      <Dialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        title={`Remove “${removing?.name ?? ""}”?`}
        description="You will no longer be able to use it to sign in."
        footer={
          <>
            <Button variant="ghost" onClick={() => setRemoving(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={pending}
              onClick={() => removing && void remove(removing)}
            >
              Remove
            </Button>
          </>
        }
      />
      <BackupCodesDialog
        codes={backupCodes}
        email={user.email}
        onClose={() => setBackupCodes(null)}
      />
    </Card>
  );
}
