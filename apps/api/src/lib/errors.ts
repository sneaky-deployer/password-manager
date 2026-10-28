import type { ContentfulStatusCode } from "hono/utils/http-status";

/** Throw from a handler to produce `{ error: { code, message } }` with the given status. */
export class ApiError extends Error {
  readonly status: ContentfulStatusCode;
  readonly code: string;

  constructor(status: ContentfulStatusCode, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}
