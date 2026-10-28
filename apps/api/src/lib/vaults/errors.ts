import { AppError } from "../errors.ts";

export const notFound = () => new AppError("not_found", 404);

export const forbidden = (message?: string) => new AppError("forbidden", 403, message);

export const conflict = (message: string, details?: unknown) =>
  new AppError("conflict", 409, message, details);

export function revisionConflict(currentRevision: number, details: Record<string, unknown> = {}) {
  return new AppError("revision_conflict", 409, undefined, { currentRevision, ...details });
}

export function rotationPending() {
  return new AppError(
    "rotation_pending",
    409,
    "This vault is waiting for a key rotation. Finish the rotation and try again.",
  );
}

export function keyVersionMismatch(details: Record<string, unknown>) {
  return new AppError(
    "key_version_mismatch",
    409,
    "The key version is out of date. Sync and try again.",
    details,
  );
}
