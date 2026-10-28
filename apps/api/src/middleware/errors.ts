import type { ErrorHandler, NotFoundHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AppBindings } from "../env.ts";
import { ApiError } from "../lib/errors.ts";

const STATUS_CODES: Record<number, string> = {
  400: "bad_request",
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  405: "method_not_allowed",
  409: "conflict",
  413: "payload_too_large",
  429: "rate_limited",
};

function errorBody(code: string, message: string) {
  return { error: { code, message } };
}

export const errorHandler: ErrorHandler<AppBindings> = (err, c) => {
  if (err instanceof ApiError) {
    return c.json(errorBody(err.code, err.message), err.status);
  }
  if (err instanceof HTTPException) {
    const status = err.status as ContentfulStatusCode;
    return c.json(errorBody(STATUS_CODES[status] ?? "http_error", err.message), status);
  }
  // Never log request data: only the error's name and message.
  console.error(`unhandled error: ${err.name}: ${err.message}`);
  return c.json(errorBody("internal_error", "Internal server error"), 500);
};

export const notFoundHandler: NotFoundHandler<AppBindings> = (c) =>
  c.json(errorBody("not_found", "Not found"), 404);
