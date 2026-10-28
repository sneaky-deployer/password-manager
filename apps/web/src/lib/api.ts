import { createClockOffsetTracker } from "@pm/otp";
import { apiErrorSchema, type ErrorCode } from "@pm/shared";

/** Anything with a `parse` that throws on bad input (every zod schema qualifies). */
export interface ResponseSchema<T> {
  parse(data: unknown): T;
}

export type ApiErrorCode = ErrorCode | "network_error" | "invalid_response";

/** A failed API call: non-2xx with `{ error: { code, message, details? } }`, or a transport problem. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly details: unknown;

  constructor(status: number, code: ApiErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function isApiError(error: unknown, code?: ApiErrorCode): error is ApiError {
  return error instanceof ApiError && (code === undefined || error.code === code);
}

/**
 * Median clock offset between this device and the server, fed by the `Date` header of every
 * API response. The TOTP UI uses `clockTracker.now()` instead of `Date.now()` (PLAN.md 14.3).
 */
export const clockTracker = createClockOffsetTracker();

type UnauthorizedHandler = () => void;
let unauthorizedHandler: UnauthorizedHandler | null = null;

/** Called once when an authed request answers 401 `unauthorized` (the session is gone). */
export function setUnauthorizedHandler(handler: UnauthorizedHandler | null): void {
  unauthorizedHandler = handler;
}

export interface RequestOptions<T> {
  /** Response validation. Required: every response is parsed with its `@pm/shared` schema. */
  schema: ResponseSchema<T>;
  /** JSON request body. */
  body?: unknown;
  /** Query string parameters; `undefined` values are skipped. */
  query?: Record<string, string | number | boolean | undefined>;
  signal?: AbortSignal;
  /**
   * Set to `false` for calls where a 401 `unauthorized` is an expected answer (the session
   * probe `GET /me`). Default: a 401 `unauthorized` clears the session and routes to /login.
   */
  handleUnauthorized?: boolean;
}

type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

function buildUrl(path: string, query: RequestOptions<unknown>["query"]): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `${path}?${text}` : path;
}

async function readErrorBody(response: Response): Promise<ApiError> {
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    return new ApiError(
      response.status,
      "invalid_response",
      `Unexpected response (${response.status})`,
    );
  }
  const parsed = apiErrorSchema.safeParse(json);
  if (!parsed.success) {
    return new ApiError(
      response.status,
      "invalid_response",
      `Unexpected response (${response.status})`,
    );
  }
  const { code, message, details } = parsed.data.error;
  return new ApiError(response.status, code, message, details);
}

async function request<T>(method: Method, path: string, options: RequestOptions<T>): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  const init: RequestInit = { method, credentials: "include", headers };
  if (options.signal) init.signal = options.signal;
  if (method !== "GET" && method !== "DELETE" && options.body === undefined) {
    // Endpoints without a body still expect a JSON object (PLAN.md 13, `emptyRequestSchema`).
    headers["Content-Type"] = "application/json";
    init.body = "{}";
  } else if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(options.body);
  }

  const startedAt = Date.now();
  let response: Response;
  try {
    response = await fetch(buildUrl(path, options.query), init);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new ApiError(0, "network_error", "Cannot reach the server. Check your connection.");
  }
  clockTracker.addSample(response.headers.get("Date"), startedAt, Date.now());

  if (!response.ok) {
    const error = await readErrorBody(response);
    if (
      response.status === 401 &&
      error.code === "unauthorized" &&
      options.handleUnauthorized !== false
    ) {
      unauthorizedHandler?.();
    }
    throw error;
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new ApiError(
      response.status,
      "invalid_response",
      "The server sent an unreadable response",
    );
  }
  try {
    return options.schema.parse(json);
  } catch {
    throw new ApiError(
      response.status,
      "invalid_response",
      "The server sent an unexpected response",
    );
  }
}

export const api = {
  get: <T>(path: string, options: RequestOptions<T>) => request("GET", path, options),
  post: <T>(path: string, options: RequestOptions<T>) => request("POST", path, options),
  patch: <T>(path: string, options: RequestOptions<T>) => request("PATCH", path, options),
  put: <T>(path: string, options: RequestOptions<T>) => request("PUT", path, options),
  delete: <T>(path: string, options: RequestOptions<T>) => request("DELETE", path, options),
};
