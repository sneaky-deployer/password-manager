/**
 * HTTP security headers from PLAN.md section 8. The API middleware applies them to Worker
 * responses; `apps/web/public/_headers` applies the same values to static assets. A web test
 * fails if the two drift apart.
 */
export const SECURITY_HEADERS = {
  "Content-Security-Policy": [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self'",
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ].join("; "),
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(self), clipboard-write=(self), geolocation=(), microphone=()",
  "Cross-Origin-Opener-Policy": "same-origin",
} as const;
