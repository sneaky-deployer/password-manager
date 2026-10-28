import { type ReactNode, useEffect, useState } from "react";
import { Alert, Button, Field, Input } from "../../components/ui/index.ts";
import { describeError } from "../../lib/errors.ts";
import {
  buildRecoveryKitText,
  CONFIRM_WORD_COUNT,
  downloadTextFile,
  pickConfirmationIndexes,
  splitPhrase,
  wordsMatch,
} from "./recovery-kit.ts";

interface Props {
  /** The 24-word phrase. Held only in component state; never stored. */
  phrase: string;
  email: string;
  /** Runs after the user typed the confirmation words. May be async; errors are shown. */
  onConfirmed: () => void | Promise<void>;
  confirmLabel?: string;
  intro?: ReactNode;
  /** When provided, a "Skip for now" button is offered (not for new accounts). */
  onSkip?: () => void;
  skipLabel?: string;
}

/**
 * The recovery kit screen (PLAN.md 10.1 step 6): numbered words, a download, and a typed
 * confirmation of three random words before the flow may continue.
 */
export function RecoveryKitScreen({
  phrase,
  email,
  onConfirmed,
  confirmLabel = "Continue",
  intro,
  onSkip,
  skipLabel = "Skip for now",
}: Props) {
  const words = splitPhrase(phrase);
  const [indexes] = useState(() => pickConfirmationIndexes(words.length, CONFIRM_WORD_COUNT));
  const [typed, setTyped] = useState<string[]>(() => indexes.map(() => ""));
  const [downloaded, setDownloaded] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A reload would lose the phrase: ask the browser to confirm.
  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, []);

  const allCorrect = indexes.every((wordIndex, i) =>
    wordsMatch(typed[i] ?? "", words[wordIndex] ?? ""),
  );

  function download() {
    downloadTextFile("recovery-kit.txt", buildRecoveryKitText({ words, email, date: new Date() }));
    setDownloaded(true);
  }

  async function confirm() {
    setSubmitted(true);
    setError(null);
    if (!allCorrect) return;
    setPending(true);
    try {
      await onConfirmed();
    } catch (err) {
      setError(describeError(err));
      setPending(false);
    }
  }

  return (
    <div className="space-y-5">
      {intro}
      <Alert variant="warning" title="This is the only way to recover your data">
        If you forget your master password, these 24 words (plus access to your email) are the only
        way back in. Nobody can reset it for you. Store them offline, not in this app.
      </Alert>

      <ol
        aria-label="Recovery words"
        className="grid grid-cols-2 gap-2 rounded-lg border border-slate-200 bg-slate-50 p-3 sm:grid-cols-3 dark:border-slate-700 dark:bg-slate-950"
      >
        {words.map((word, i) => (
          <li
            // biome-ignore lint/suspicious/noArrayIndexKey: positions are the identity of recovery words
            key={i}
            className="flex items-baseline gap-2 text-sm"
          >
            <span className="w-6 text-right text-xs text-slate-500 tabular-nums" aria-hidden="true">
              {i + 1}
            </span>
            <span className="font-mono font-medium">{word}</span>
          </li>
        ))}
      </ol>

      <div className="flex flex-wrap items-center gap-3">
        <Button variant="secondary" onClick={download}>
          Download recovery kit
        </Button>
        {downloaded ? (
          <span className="text-sm text-emerald-700 dark:text-emerald-400" role="status">
            Downloaded. Move it somewhere safe.
          </span>
        ) : null}
      </div>

      <form
        className="space-y-4 border-t border-slate-200 pt-5 dark:border-slate-800"
        onSubmit={(event) => {
          event.preventDefault();
          void confirm();
        }}
        noValidate
      >
        <div>
          <h2 className="text-sm font-semibold">Confirm you saved it</h2>
          <p className="text-sm text-slate-600 dark:text-slate-400">
            Type these {CONFIRM_WORD_COUNT} words from your kit.
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          {indexes.map((wordIndex, i) => (
            <Field
              key={wordIndex}
              label={`Word ${wordIndex + 1}`}
              error={
                submitted && !wordsMatch(typed[i] ?? "", words[wordIndex] ?? "")
                  ? "Does not match"
                  : null
              }
            >
              {(control) => (
                <Input
                  {...control}
                  value={typed[i] ?? ""}
                  autoComplete="off"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  onChange={(event) =>
                    setTyped((prev) => prev.map((v, j) => (j === i ? event.target.value : v)))
                  }
                />
              )}
            </Field>
          ))}
        </div>
        {error ? <Alert variant="error">{error}</Alert> : null}
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" loading={pending}>
            {confirmLabel}
          </Button>
          {onSkip ? (
            <Button variant="ghost" onClick={onSkip} disabled={pending}>
              {skipLabel}
            </Button>
          ) : null}
        </div>
      </form>
    </div>
  );
}
