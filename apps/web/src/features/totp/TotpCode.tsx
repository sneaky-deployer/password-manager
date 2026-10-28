import { Alert, Badge, CopyButton } from "../../components/ui/index.ts";
import { clockTracker } from "../../lib/api.ts";
import { cn } from "../../lib/cn.ts";
import { describeOtpError } from "./otp-errors.ts";
import { TotpRing } from "./TotpRing.tsx";
import { useTotp } from "./useTotp.ts";

export interface TotpCodeProps {
  /** Full `otpauth://` URI (or a bare Base32 secret). Read only; never logged or stored. */
  uri: string;
}

/**
 * Detail-view TOTP widget: big grouped code, copy button (copies the raw digits), countdown ring,
 * and, in the last 5 seconds, the next code. Invalid URIs render an error instead of crashing.
 */
export function TotpCode({ uri }: TotpCodeProps) {
  const totp = useTotp(uri);

  if (totp.status === "empty") {
    return <p className="text-sm text-slate-600 dark:text-slate-400">No authenticator code set.</p>;
  }
  if (totp.status === "invalid") {
    return (
      <Alert variant="error" title="Can't show this code">
        {describeOtpError(totp.error)}
      </Alert>
    );
  }

  const skewSeconds = clockTracker.shouldApply() ? Math.round(clockTracker.offsetMs() / 1000) : 0;
  const account = [totp.issuer, totp.label].filter(Boolean).join(" · ");

  return (
    <section aria-label="One-time code" className="space-y-2">
      <div className="flex items-center gap-4">
        <div className="min-w-0 flex-1">
          <p
            data-testid="totp-code"
            className={cn(
              "font-mono text-3xl font-semibold tabular-nums tracking-widest",
              totp.expiringSoon
                ? "text-amber-600 dark:text-amber-400"
                : "text-slate-900 dark:text-slate-100",
            )}
          >
            {totp.formatted}
          </p>
          <p
            data-testid="totp-next"
            className="min-h-5 text-sm font-medium text-amber-700 dark:text-amber-400"
          >
            {totp.expiringSoon ? `Next: ${totp.nextFormatted}` : null}
          </p>
        </div>
        <TotpRing
          progress={totp.progress}
          expiring={totp.expiringSoon}
          seconds={totp.secondsRemaining}
          className="size-12 text-sm"
        />
        <CopyButton value={() => totp.code} label="Copy code" />
      </div>
      {account ? (
        <p className="truncate text-sm text-slate-600 dark:text-slate-400">{account}</p>
      ) : null}
      {totp.weakSecret ? (
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="warning">Weak secret</Badge>
          <span className="text-xs text-slate-600 dark:text-slate-400">
            Shorter than the recommended 128 bits. It still works, but is less secure.
          </span>
        </div>
      ) : null}
      {skewSeconds !== 0 ? (
        <p className="text-xs text-slate-600 dark:text-slate-400">
          Your device clock is about {Math.abs(skewSeconds)} seconds{" "}
          {skewSeconds > 0 ? "behind" : "ahead"}. Codes use the server's time so they stay correct.
        </p>
      ) : null}
      {/* Changes only when the code changes, so screen readers announce once per period. */}
      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {`Authenticator code ${totp.formatted}`}
      </p>
    </section>
  );
}
