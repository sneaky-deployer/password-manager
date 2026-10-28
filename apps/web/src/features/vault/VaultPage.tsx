import { EmptyState } from "../../components/ui/index.ts";
import { useSession } from "../../lib/session.ts";

/** Placeholder for `/vault`. The vault UI work replaces this with the item list and detail. */
export function VaultPage() {
  const { user } = useSession();
  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-2xl font-semibold">Vault</h1>
      <div className="mt-6">
        <EmptyState title="Your vault will appear here">
          You are signed in{user ? ` as ${user.email}` : ""} and unlocked. The vault, item and
          sharing screens are built on top of this shell.
        </EmptyState>
      </div>
    </div>
  );
}
