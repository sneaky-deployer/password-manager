import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Alert, Button, Dialog, Field, Input } from "../../components/ui/index.ts";
import type { VaultView } from "../../crypto-worker/vault-protocol.ts";
import { cn } from "../../lib/cn.ts";
import { createVaultAction, renameVaultAction } from "./actions.ts";
import { describeVaultError } from "./errors.ts";
import { VAULT_COLOR_NAMES, VAULT_COLORS } from "./item-utils.ts";

interface VaultFormDialogProps {
  open: boolean;
  /** Present when renaming. */
  vault?: VaultView | undefined;
  onClose: () => void;
  onCreated?: (vaultId: string) => void;
}

/** Create a vault, or rename / recolour an existing one. */
export function VaultFormDialog({ open, vault, onClose, onCreated }: VaultFormDialogProps) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(vault?.name ?? "");
  const [color, setColor] = useState(vault?.color ?? "violet");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Give the vault a name.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (vault) {
        await renameVaultAction(queryClient, {
          vaultId: vault.id,
          meta: { name: trimmed, color, ...(vault.icon ? { icon: vault.icon } : {}) },
        });
        onClose();
      } else {
        const id = await createVaultAction(queryClient, { name: trimmed, color });
        setName("");
        onClose();
        onCreated?.(id);
      }
    } catch (err) {
      setError(describeVaultError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={vault ? "Rename vault" : "New vault"}
      description={
        vault
          ? undefined
          : "A vault groups items and can be shared with other people. Its name is encrypted too."
      }
    >
      <form onSubmit={(event) => void submit(event)} className="space-y-4" noValidate>
        <Field label="Name" required>
          {(control) => (
            <Input
              {...control}
              value={name}
              maxLength={100}
              autoComplete="off"
              onChange={(event) => setName(event.target.value)}
            />
          )}
        </Field>
        <fieldset>
          <legend className="mb-1.5 text-sm font-medium">Colour</legend>
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Colour">
            {VAULT_COLOR_NAMES.map((option) => (
              // biome-ignore lint/a11y/useSemanticElements: colour swatches styled as buttons, with radio semantics
              <button
                key={option}
                type="button"
                role="radio"
                aria-checked={color === option}
                aria-label={option}
                onClick={() => setColor(option)}
                className={cn(
                  "size-7 rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600",
                  VAULT_COLORS[option],
                  color === option && "ring-2 ring-slate-900 ring-offset-2 dark:ring-slate-100",
                )}
              />
            ))}
          </div>
        </fieldset>
        {error ? <Alert variant="error">{error}</Alert> : null}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" loading={busy}>
            {vault ? "Save" : "Create vault"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
