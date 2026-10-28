import { parseOtpInput, toOtpauthUri } from "@pm/otp";
import { type ItemContent, type ItemContentInput, itemContentSchema } from "@pm/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  Alert,
  Button,
  Checkbox,
  Field,
  Input,
  PasswordInput,
  Select,
  Spinner,
} from "../../components/ui/index.ts";
import { cryptoClient } from "../../crypto-worker/client.ts";
import type { ItemDetailView, VaultView } from "../../crypto-worker/vault-protocol.ts";
import { isApiError } from "../../lib/api.ts";
import { cn } from "../../lib/cn.ts";
import { GeneratePasswordDialog } from "../generator/index.ts";
import { describeOtpError, TotpInput } from "../totp/index.ts";
import { createItemAction, updateItemAction } from "./actions.ts";
import { describeVaultError, shouldResync } from "./errors.ts";
import { writableVaults } from "./filters.ts";
import { useItem, useVaults } from "./hooks.ts";
import { syncNow } from "./sync.ts";

interface CustomFieldForm {
  label: string;
  value: string;
  hidden: boolean;
}

export interface ItemForm {
  type: "login" | "note";
  vaultId: string;
  name: string;
  username: string;
  password: string;
  urls: string[];
  totp: string;
  notes: string;
  customFields: CustomFieldForm[];
}

export function emptyForm(vaultId: string, type: "login" | "note" = "login"): ItemForm {
  return {
    type,
    vaultId,
    name: "",
    username: "",
    password: "",
    urls: [""],
    totp: "",
    notes: "",
    customFields: [],
  };
}

export function formFromContent(content: ItemContent, vaultId: string): ItemForm {
  if (content.type === "note") {
    return { ...emptyForm(vaultId, "note"), name: content.name, notes: content.notes };
  }
  return {
    type: "login",
    vaultId,
    name: content.name,
    username: content.username ?? "",
    password: content.password ?? "",
    urls: content.urls.length > 0 ? content.urls : [""],
    totp: content.totp ?? "",
    notes: content.notes ?? "",
    customFields: content.customFields.map((field) => ({ ...field })),
  };
}

export interface FormErrors {
  name?: string;
  totp?: string;
  form?: string;
}

/** Validate the form and build the content to encrypt. Pure, so it is easy to test. */
export function buildContent(
  form: ItemForm,
): { ok: true; content: ItemContentInput } | { ok: false; errors: FormErrors } {
  const errors: FormErrors = {};
  const name = form.name.trim();
  if (!name) errors.name = "Give the item a name.";

  let content: ItemContentInput;
  if (form.type === "note") {
    content = { type: "note", name, notes: form.notes };
  } else {
    let totp: string | undefined;
    if (form.totp.trim()) {
      const parsed = parseOtpInput(form.totp);
      if (parsed.ok) totp = toOtpauthUri(parsed.config);
      else errors.totp = describeOtpError(parsed.error);
    }
    const urls = form.urls.map((url) => url.trim()).filter(Boolean);
    const customFields = form.customFields.filter((field) => field.label.trim() || field.value);
    content = {
      type: "login",
      name,
      urls,
      customFields: customFields.map((field) => ({ ...field, label: field.label.trim() })),
      ...(form.username ? { username: form.username } : {}),
      ...(form.password ? { password: form.password } : {}),
      ...(totp ? { totp } : {}),
      ...(form.notes ? { notes: form.notes } : {}),
    };
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const parsed = itemContentSchema.safeParse(content);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      ok: false,
      errors: {
        form: issue ? `${issue.message} (${issue.path.join(".") || "item"})` : "Invalid item.",
      },
    };
  }
  return { ok: true, content };
}

interface ItemEditorProps {
  mode: "create" | "edit";
  itemId?: string | undefined;
  defaultVaultId?: string | undefined;
  onDone: (itemId: string) => void;
  onCancel: () => void;
}

/** Create or edit an item. Edit mode waits for the decrypted item, then shows the form. */
export function ItemEditor({ mode, itemId, defaultVaultId, onDone, onCancel }: ItemEditorProps) {
  const { vaults } = useVaults();
  const { summary, detail, isLoading, notFound } = useItem(mode === "edit" ? itemId : undefined);
  const [frozen, setFrozen] = useState<{
    initial: ItemForm;
    revision: number;
    vaultId: string;
    sharedWithMe: boolean;
  } | null>(null);

  if (mode === "create") {
    const choices = writableVaults(vaults);
    const first = choices.find((v) => v.id === defaultVaultId) ?? choices[0];
    if (!first) {
      return (
        <Alert variant="warning" title="No vault to save into">
          You need a vault where you are an editor, and one that is not waiting for a key rotation.
          <div className="mt-3">
            <Button variant="secondary" onClick={onCancel}>
              Back
            </Button>
          </div>
        </Alert>
      );
    }
    return (
      <EditorForm
        key="new"
        mode="create"
        initial={emptyForm(first.id)}
        vaults={choices}
        onDone={onDone}
        onCancel={onCancel}
      />
    );
  }

  // The form starts from the first loaded version and is never rebuilt by later syncs, so a
  // background refresh cannot wipe what the user is typing. A newer version is found on save.
  if (!frozen && summary && detail?.content && summary.canEdit) {
    setFrozen({
      initial: formFromContent(detail.content, summary.vaultId),
      revision: summary.revision,
      vaultId: summary.vaultId,
      sharedWithMe: summary.sharedWithMe,
    });
  }
  if (frozen) {
    return (
      <EditorForm
        key={itemId}
        mode="edit"
        itemId={itemId}
        initial={frozen.initial}
        baseRevision={frozen.revision}
        vaults={vaults.filter((v) => v.id === frozen.vaultId)}
        sharedWithMe={frozen.sharedWithMe}
        onDone={onDone}
        onCancel={onCancel}
      />
    );
  }
  if (isLoading) return <Spinner label="Loading item" className="size-6" />;
  if (notFound || !summary || !detail) {
    return <Alert variant="warning">This item is no longer available.</Alert>;
  }
  if (!detail.content) {
    return <Alert variant="error">This item could not be decrypted, so it cannot be edited.</Alert>;
  }
  return <Alert variant="warning">You can only read this item.</Alert>;
}

interface EditorFormProps {
  mode: "create" | "edit";
  itemId?: string;
  initial: ItemForm;
  baseRevision?: number;
  vaults: VaultView[];
  sharedWithMe?: boolean;
  onDone: (itemId: string) => void;
  onCancel: () => void;
}

interface Conflict {
  latest: ItemDetailView;
}

function EditorForm({
  mode,
  itemId,
  initial,
  baseRevision = 0,
  vaults,
  sharedWithMe = false,
  onDone,
  onCancel,
}: EditorFormProps) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<ItemForm>(initial);
  const [revision, setRevision] = useState(baseRevision);
  const [errors, setErrors] = useState<FormErrors>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [busy, setBusy] = useState(false);
  const [generating, setGenerating] = useState(false);

  const set = <K extends keyof ItemForm>(key: K, value: ItemForm[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setServerError(null);
    const built = buildContent(form);
    if (!built.ok) {
      setErrors(built.errors);
      return;
    }
    setErrors({});
    setBusy(true);
    try {
      if (mode === "create") {
        const id = await createItemAction(queryClient, {
          vaultId: form.vaultId,
          content: built.content,
        });
        onDone(id);
      } else if (itemId) {
        await updateItemAction(queryClient, { id: itemId, content: built.content, revision });
        onDone(itemId);
      }
    } catch (error) {
      if (isApiError(error, "revision_conflict") && itemId) {
        await loadConflict(itemId);
      } else {
        const text = describeVaultError(error);
        setServerError(shouldResync(error) ? `${text} The vault was refreshed.` : text);
      }
    } finally {
      setBusy(false);
    }
  }

  async function loadConflict(id: string) {
    try {
      await syncNow(queryClient);
      const latest = await cryptoClient.call("getItem", { id });
      setConflict({ latest });
    } catch (error) {
      setServerError(describeVaultError(error));
    }
  }

  function takeLatest() {
    if (!conflict) return;
    const { latest } = conflict;
    if (latest.content) setForm(formFromContent(latest.content, latest.item.vaultId));
    setRevision(latest.item.revision);
    setConflict(null);
  }

  function keepMine() {
    if (!conflict) return;
    setRevision(conflict.latest.item.revision);
    setConflict(null);
  }

  const heading = mode === "create" ? "New item" : "Edit item";
  const isLogin = form.type === "login";

  return (
    <form onSubmit={(event) => void submit(event)} noValidate className="space-y-5">
      <h2 className="text-lg font-semibold">{heading}</h2>

      {conflict ? (
        <Alert variant="warning" title="This item changed while you were editing">
          <p>
            Someone else (or another device of yours) saved a newer version. Your edits are still
            here. Load the latest version to start over from it, or keep your edits and save over
            it.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" onClick={takeLatest}>
              Load latest version
            </Button>
            <Button size="sm" onClick={keepMine}>
              Keep my edits
            </Button>
          </div>
        </Alert>
      ) : null}

      {mode === "create" ? (
        <div className="flex gap-2" role="radiogroup" aria-label="Item type">
          {(["login", "note"] as const).map((type) => (
            // biome-ignore lint/a11y/useSemanticElements: segmented control styled as buttons, with radio semantics
            <button
              key={type}
              type="button"
              role="radio"
              aria-checked={form.type === type}
              onClick={() => set("type", type)}
              className={cn(
                "rounded-lg border px-4 py-2 text-sm font-medium focus-visible:outline-2 focus-visible:outline-brand-600",
                form.type === type
                  ? "border-brand-600 bg-brand-50 text-brand-800 dark:bg-brand-900/40 dark:text-brand-200"
                  : "border-slate-300 dark:border-slate-600",
              )}
            >
              {type === "login" ? "Login" : "Secure note"}
            </button>
          ))}
        </div>
      ) : null}

      <Field label="Name" required error={errors.name}>
        {(control) => (
          <Input
            {...control}
            value={form.name}
            autoComplete="off"
            maxLength={200}
            onChange={(event) => set("name", event.target.value)}
          />
        )}
      </Field>

      {isLogin ? (
        <>
          <Field label="Username or email">
            {(control) => (
              <Input
                {...control}
                value={form.username}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                onChange={(event) => set("username", event.target.value)}
              />
            )}
          </Field>

          <Field label="Password">
            {(control) => (
              <div className="flex gap-2">
                <div className="min-w-0 flex-1">
                  <PasswordInput
                    {...control}
                    value={form.password}
                    autoComplete="new-password"
                    onChange={(event) => set("password", event.target.value)}
                  />
                </div>
                <Button variant="secondary" onClick={() => setGenerating(true)}>
                  Generate
                </Button>
              </div>
            )}
          </Field>
          <GeneratePasswordDialog
            open={generating}
            onClose={() => setGenerating(false)}
            onUse={(value) => set("password", value)}
          />

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Websites</legend>
            {form.urls.map((url, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: rows have no stable id and are edited in place
              <div key={index} className="flex gap-2">
                <Input
                  aria-label={`Website ${index + 1}`}
                  value={url}
                  inputMode="url"
                  autoCapitalize="none"
                  spellCheck={false}
                  placeholder="https://example.com"
                  onChange={(event) =>
                    set(
                      "urls",
                      form.urls.map((u, i) => (i === index ? event.target.value : u)),
                    )
                  }
                />
                <Button
                  variant="ghost"
                  aria-label={`Remove website ${index + 1}`}
                  onClick={() =>
                    set(
                      "urls",
                      form.urls.length > 1 ? form.urls.filter((_, i) => i !== index) : [""],
                    )
                  }
                >
                  Remove
                </Button>
              </div>
            ))}
            <Button
              variant="ghost"
              size="sm"
              disabled={form.urls.length >= 20}
              onClick={() => set("urls", [...form.urls, ""])}
            >
              Add website
            </Button>
          </fieldset>

          <TotpInput
            value={form.totp}
            onChange={(value) => set("totp", value)}
            error={errors.totp}
          />
        </>
      ) : null}

      <Field label="Notes">
        {(control) => (
          <textarea
            {...control}
            value={form.notes}
            rows={isLogin ? 4 : 10}
            maxLength={isLogin ? 10_000 : 50_000}
            onChange={(event) => set("notes", event.target.value)}
            className="block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-brand-600 focus:outline-2 focus:outline-brand-600/30 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
          />
        )}
      </Field>

      {isLogin ? (
        <fieldset className="space-y-3">
          <legend className="text-sm font-medium">Custom fields</legend>
          {form.customFields.map((field, index) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: rows have no stable id and are edited in place
              key={index}
              className="space-y-2 rounded-lg border border-slate-200 p-3 dark:border-slate-700"
            >
              <Input
                aria-label={`Custom field ${index + 1} label`}
                placeholder="Label"
                value={field.label}
                onChange={(event) =>
                  set(
                    "customFields",
                    form.customFields.map((f, i) =>
                      i === index ? { ...f, label: event.target.value } : f,
                    ),
                  )
                }
              />
              <Input
                aria-label={`Custom field ${index + 1} value`}
                placeholder="Value"
                type={field.hidden ? "password" : "text"}
                autoComplete="off"
                value={field.value}
                onChange={(event) =>
                  set(
                    "customFields",
                    form.customFields.map((f, i) =>
                      i === index ? { ...f, value: event.target.value } : f,
                    ),
                  )
                }
              />
              <div className="flex items-center justify-between">
                <Checkbox
                  label="Hide value"
                  checked={field.hidden}
                  onChange={(event) =>
                    set(
                      "customFields",
                      form.customFields.map((f, i) =>
                        i === index ? { ...f, hidden: event.target.checked } : f,
                      ),
                    )
                  }
                />
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Remove custom field ${index + 1}`}
                  onClick={() =>
                    set(
                      "customFields",
                      form.customFields.filter((_, i) => i !== index),
                    )
                  }
                >
                  Remove
                </Button>
              </div>
            </div>
          ))}
          <Button
            variant="ghost"
            size="sm"
            disabled={form.customFields.length >= 50}
            onClick={() =>
              set("customFields", [...form.customFields, { label: "", value: "", hidden: false }])
            }
          >
            Add custom field
          </Button>
        </fieldset>
      ) : null}

      {mode === "create" ? (
        <Field label="Vault">
          {(control) => (
            <Select
              {...control}
              value={form.vaultId}
              onChange={(event) => set("vaultId", event.target.value)}
            >
              {vaults.map((vault) => (
                <option key={vault.id} value={vault.id}>
                  {vault.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
      ) : sharedWithMe ? (
        <p className="text-xs text-slate-600 dark:text-slate-400">
          This item was shared with you; you can change its content but not move or trash it.
        </p>
      ) : null}

      {errors.form ? <Alert variant="error">{errors.form}</Alert> : null}
      {serverError ? <Alert variant="error">{serverError}</Alert> : null}

      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="secondary" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" loading={busy} disabled={conflict !== null}>
          {mode === "create" ? "Create item" : "Save changes"}
        </Button>
      </div>
    </form>
  );
}
