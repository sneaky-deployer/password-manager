import { isApiError } from "../../lib/api.ts";
import { describeError } from "../../lib/errors.ts";

/** Error text for vault and item writes, covering the vault-specific API codes. */
export function describeVaultError(error: unknown, fallback?: string): string {
  if (isApiError(error)) {
    switch (error.code) {
      case "rotation_pending":
        return "This vault is waiting for its key to be rotated after a member was removed. Finish the rotation first.";
      case "key_version_mismatch":
        return "The vault keys changed in the meantime. Your list was refreshed; try again.";
      case "revision_conflict":
        return "This item was changed somewhere else.";
      case "item_too_large":
        return "This item is too large to save.";
      case "not_found":
        return "That no longer exists, or you no longer have access to it.";
      case "forbidden":
        return "Your role does not allow that.";
    }
  }
  return describeError(error, fallback);
}

/** Codes after which a fresh sync is the right first reaction. */
export function shouldResync(error: unknown): boolean {
  return (
    isApiError(error) &&
    (error.code === "rotation_pending" ||
      error.code === "key_version_mismatch" ||
      error.code === "not_found")
  );
}
