import { apiPaths, listSessionsResponseSchema, revokeSessionResponseSchema } from "@pm/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Badge, Button, Card, Spinner } from "../../components/ui/index.ts";
import { api } from "../../lib/api.ts";
import { describeError } from "../../lib/errors.ts";
import { describeUserAgent, formatDateTime, formatRelative } from "../../lib/format.ts";

const QUERY_KEY = ["settings", "sessions"] as const;

/** Signed-in devices (PLAN.md 10.2): list, revoke one, revoke all others. */
export function SessionsPage() {
  const queryClient = useQueryClient();
  const sessions = useQuery({
    queryKey: QUERY_KEY,
    queryFn: ({ signal }) =>
      api.get(apiPaths.me.sessions, { schema: listSessionsResponseSchema, signal }),
  });
  const revokeOne = useMutation({
    mutationFn: (id: string) =>
      api.delete(apiPaths.me.session(id), { schema: revokeSessionResponseSchema }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: QUERY_KEY }),
  });
  const revokeOthers = useMutation({
    mutationFn: () => api.delete(apiPaths.me.sessions, { schema: revokeSessionResponseSchema }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: QUERY_KEY }),
  });

  const list = sessions.data?.sessions ?? [];
  const others = list.filter((s) => !s.current);
  const error = revokeOne.error ?? revokeOthers.error ?? sessions.error;

  return (
    <Card
      title="Active sessions"
      description="Devices and browsers signed in to your account. Sign out any you do not recognise."
      actions={
        others.length > 0 ? (
          <Button
            variant="secondary"
            size="sm"
            loading={revokeOthers.isPending}
            onClick={() => revokeOthers.mutate()}
          >
            Sign out all others
          </Button>
        ) : null
      }
    >
      {error ? <Alert variant="error">{describeError(error)}</Alert> : null}
      {sessions.isPending ? (
        <Spinner label="Loading sessions" />
      ) : (
        <ul className="divide-y divide-slate-200 rounded-lg border border-slate-200 dark:divide-slate-800 dark:border-slate-800">
          {list.map((session) => (
            <li key={session.id} className="flex items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <p className="flex items-center gap-2 text-sm font-medium">
                  {describeUserAgent(session.userAgent)}
                  {session.current ? <Badge tone="brand">This device</Badge> : null}
                </p>
                <p className="text-xs text-slate-600 dark:text-slate-400">
                  Signed in {formatDateTime(session.createdAt)} · active{" "}
                  {formatRelative(session.lastSeenAt)}
                </p>
              </div>
              {session.current ? null : (
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Sign out ${describeUserAgent(session.userAgent)}`}
                  loading={revokeOne.isPending && revokeOne.variables === session.id}
                  onClick={() => revokeOne.mutate(session.id)}
                >
                  Sign out
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
