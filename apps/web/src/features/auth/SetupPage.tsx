import { apiPaths, setupStartResponseSchema, setupStatusResponseSchema } from "@pm/shared";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { Alert, Button, Spinner } from "../../components/ui/index.ts";
import { api, isApiError } from "../../lib/api.ts";
import { describeError } from "../../lib/errors.ts";
import { AuthLayout } from "./AuthLayout.tsx";

/** PLAN.md 10.0: first-run admin bootstrap. */
export function SetupPage() {
  const navigate = useNavigate();
  const status = useQuery({
    queryKey: ["setup", "status"],
    queryFn: ({ signal }) =>
      api.get(apiPaths.setup.status, { schema: setupStatusResponseSchema, signal }),
    retry: false,
  });
  const start = useMutation({
    mutationFn: () => api.post(apiPaths.setup.start, { schema: setupStartResponseSchema }),
  });

  const noSetupNeeded =
    (status.data && !status.data.needsSetup) ||
    isApiError(status.error, "setup_not_available") ||
    isApiError(start.error, "setup_not_available");

  useEffect(() => {
    if (noSetupNeeded) void navigate({ to: "/login", replace: true });
  }, [noSetupNeeded, navigate]);

  if (status.isPending || noSetupNeeded) {
    return (
      <AuthLayout title="Setup">
        <div className="flex justify-center py-6">
          <Spinner label="Checking setup status" />
        </div>
      </AuthLayout>
    );
  }

  if (status.isError) {
    return (
      <AuthLayout title="Setup">
        <Alert variant="error">{describeError(status.error)}</Alert>
        <Button onClick={() => void status.refetch()}>Try again</Button>
      </AuthLayout>
    );
  }

  if (start.isSuccess) {
    return (
      <AuthLayout title="Check your inbox">
        <p className="text-sm">
          We sent a setup link to the administrator email address configured for this server. Open
          it to choose your master password and finish creating the admin account.
        </p>
        <p className="text-sm text-slate-600 dark:text-slate-400">
          The link works for 72 hours. You can close this page.
        </p>
        <Button variant="ghost" onClick={() => start.reset()}>
          Send it again
        </Button>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Set up your password manager"
      subtitle="No administrator exists yet. We will email a one-time setup link to the address configured on the server."
    >
      {start.isError ? <Alert variant="error">{describeError(start.error)}</Alert> : null}
      <Button fullWidth loading={start.isPending} onClick={() => start.mutate()}>
        Email me the setup link
      </Button>
      <p className="text-xs text-slate-600 dark:text-slate-400">
        You choose your own master password when you open the link. Nobody else ever knows it.
      </p>
    </AuthLayout>
  );
}
