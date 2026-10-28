import { type ReactNode, useState } from "react";
import { Alert, Button, Dialog } from "../../components/ui/index.ts";
import { describeVaultError } from "./errors.ts";

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description?: ReactNode;
  confirmLabel: string;
  /** Red button for destructive actions. */
  danger?: boolean;
  /** Runs when confirmed; the dialog closes when it resolves and shows the error when it throws. */
  onConfirm: () => Promise<void> | void;
  onClose: () => void;
}

/** "Are you sure?" with a busy state and an inline error. */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  danger = false,
  onConfirm,
  onClose,
}: ConfirmDialogProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function close() {
    setError(null);
    onClose();
  }

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      close();
    } catch (err) {
      setError(describeVaultError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={busy ? () => undefined : close}
      title={title}
      description={description}
      footer={
        <>
          <Button variant="secondary" onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant={danger ? "danger" : "primary"}
            loading={busy}
            onClick={() => void confirm()}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {error ? <Alert variant="error">{error}</Alert> : null}
    </Dialog>
  );
}
