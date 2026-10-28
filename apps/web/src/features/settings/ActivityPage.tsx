import { type AuditEvent, activityResponseSchema, apiPaths } from "@pm/shared";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Alert, Button, Card, EmptyState, Spinner } from "../../components/ui/index.ts";
import { api } from "../../lib/api.ts";
import { describeError } from "../../lib/errors.ts";
import { formatDateTime } from "../../lib/format.ts";

const PAGE_SIZE = 25;

const EVENT_LABELS: Record<string, string> = {
  login: "Signed in",
  logout: "Signed out",
  password_changed: "Master password changed",
  kdf_upgraded: "Key derivation strengthened",
  recovery_started: "Recovery kit used to start a password reset",
  recovery_used: "Password reset with recovery kit",
  recovery_kit_regenerated: "Recovery kit replaced",
  "2fa_enabled": "Authenticator app turned on",
  "2fa_disabled": "Authenticator app turned off",
  passkey_added: "Passkey added",
  passkey_removed: "Passkey removed",
  backup_codes_regenerated: "Backup codes regenerated",
  sessions_revoked: "Other sessions signed out",
  role_changed: "Account role changed",
  user_reset: "Account reset",
  share_created: "Vault or item shared",
  share_accepted: "Share accepted",
  share_declined: "Share declined",
  share_revoked: "Share revoked",
  vault_deleted: "Vault deleted",
  vault_left: "Left a shared vault",
  vault_rotated: "Vault key rotated",
};

function labelFor(event: AuditEvent): string {
  return EVENT_LABELS[event.event] ?? event.event.replace(/_/g, " ");
}

/** Short `key: value` summary of non-secret event metadata. */
function metaSummary(meta: AuditEvent["meta"]): string {
  if (!meta) return "";
  return Object.entries(meta)
    .filter(([, value]) => typeof value === "string" || typeof value === "number")
    .map(([key, value]) => `${key}: ${String(value)}`)
    .join(" · ");
}

/** Paged audit log (`GET /me/activity`, newest first, `before` = last timestamp). */
export function ActivityPage() {
  const activity = useInfiniteQuery({
    queryKey: ["settings", "activity"],
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam, signal }) =>
      api.get(apiPaths.me.activity, {
        schema: activityResponseSchema,
        query: { limit: PAGE_SIZE, before: pageParam },
        signal,
      }),
    getNextPageParam: (last) =>
      last.events.length === PAGE_SIZE ? last.events.at(-1)?.createdAt : undefined,
  });
  const events = activity.data?.pages.flatMap((page) => page.events) ?? [];

  return (
    <Card
      title="Recent activity"
      description="Security events on your account from the last 90 days."
    >
      {activity.isPending ? (
        <Spinner label="Loading activity" />
      ) : activity.isError ? (
        <Alert variant="error">{describeError(activity.error)}</Alert>
      ) : events.length === 0 ? (
        <EmptyState title="No activity yet" />
      ) : (
        <ul className="divide-y divide-slate-200 rounded-lg border border-slate-200 dark:divide-slate-800 dark:border-slate-800">
          {events.map((event) => (
            <li key={event.id} className="px-4 py-3">
              <p className="text-sm font-medium">{labelFor(event)}</p>
              <p className="text-xs text-slate-600 dark:text-slate-400">
                {formatDateTime(event.createdAt)}
                {metaSummary(event.meta) ? ` · ${metaSummary(event.meta)}` : ""}
              </p>
            </li>
          ))}
        </ul>
      )}
      {activity.hasNextPage ? (
        <Button
          variant="secondary"
          loading={activity.isFetchingNextPage}
          onClick={() => void activity.fetchNextPage()}
        >
          Load more
        </Button>
      ) : null}
    </Card>
  );
}
