import { useState } from "react";
import { Alert, Button, CopyButton, Dialog } from "../../components/ui/index.ts";
import { downloadTextFile } from "../auth/recovery-kit.ts";

interface Props {
  /** The codes to show, or null when closed. They exist only in this component's props. */
  codes: string[] | null;
  email: string;
  onClose: () => void;
}

/** Shows backup codes exactly once; the dialog can only be closed after "I saved them". */
export function BackupCodesDialog({ codes, email, onClose }: Props) {
  const [saved, setSaved] = useState(false);
  const text = codes
    ? [
        "PASSWORD MANAGER BACKUP CODES",
        `Account: ${email}`,
        `Created: ${new Date().toISOString().slice(0, 10)}`,
        "",
        "Each code works once. Use one if you lose access to your authenticator app or passkey.",
        "",
        ...codes,
        "",
      ].join("\n")
    : "";
  return (
    <Dialog
      open={codes !== null}
      onClose={() => {
        if (saved) {
          setSaved(false);
          onClose();
        }
      }}
      dismissible={false}
      title="Your backup codes"
      description="Each code works once. They are shown only now."
      footer={
        <Button
          onClick={() => {
            setSaved(false);
            onClose();
          }}
          disabled={!saved}
        >
          Done
        </Button>
      }
    >
      <Alert variant="warning">
        Save these somewhere safe. Generating new codes invalidates these.
      </Alert>
      <ul className="grid grid-cols-2 gap-2 rounded-lg bg-slate-50 p-3 font-mono text-sm dark:bg-slate-950">
        {codes?.map((code) => (
          <li key={code}>{code}</li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            downloadTextFile("backup-codes.txt", text);
            setSaved(true);
          }}
        >
          Download
        </Button>
        <CopyButton value={() => (codes ?? []).join("\n")} label="Copy all" />
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={saved}
          onChange={(event) => setSaved(event.target.checked)}
          className="size-4 accent-brand-600"
        />
        I saved these codes
      </label>
    </Dialog>
  );
}
