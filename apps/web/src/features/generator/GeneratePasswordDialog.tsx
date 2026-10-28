import { Dialog } from "../../components/ui/index.ts";
import { PasswordGeneratorPanel } from "./PasswordGeneratorPanel.tsx";

export interface GeneratePasswordDialogProps {
  open: boolean;
  onClose: () => void;
  /** Called with the chosen value; the dialog then closes itself via `onClose`. */
  onUse: (value: string) => void;
}

/** The generator in a modal, for the item editor's "Generate" button. A fresh value is made each time it opens. */
export function GeneratePasswordDialog({ open, onClose, onUse }: GeneratePasswordDialogProps) {
  return (
    <Dialog open={open} onClose={onClose} title="Generate a password">
      <PasswordGeneratorPanel
        compact
        onUse={(value) => {
          onUse(value);
          onClose();
        }}
      />
    </Dialog>
  );
}
