// Cloudflare Turnstile — the names the browser and the server must agree on, and nothing else. Safe to import from a client
// component AND from a route handler: no `server-only`, no React, no env read (the server half is `server/turnstile.ts`, the
// browser half `lib/turnstile-client.ts` and `components/turnstile-widget.tsx`).

/** The request header the browser sends the widget's token in. A header and not a body field because the seven guarded routes
 *  have different bodies, several of them `.strict()` (a stray key is a 400): the gate runs BEFORE any body is read, so the
 *  handler's own parsing is untouched and no request schema (or the OpenAPI document built from them) has to grow a field.
 *  The name is the one Cloudflare's own form integration uses for the same value. */
export const TURNSTILE_HEADER = "cf-turnstile-response";

/** The `code` of the 403 a refused request answers with: `{ ok:false, error, code }` on the legacy envelope (`lib/http.ts`),
 *  `error.code` on `/api/v1`'s. A fixed string, so a client can show its own translated sentence for exactly this refusal
 *  instead of printing the server's English. */
export const TURNSTILE_ERROR_CODE = "TURNSTILE_FAILED";

/** The guarded actions. Each is the `data-action` the widget is rendered with, and the server only accepts a token whose
 *  action is the one the route expects, so a token minted on the login form cannot be spent on a registration. Cloudflare
 *  allows `[A-Za-z0-9_-]`, 32 characters at most. */
export const TURNSTILE_ACTIONS = ["login", "start", "register", "resend", "join", "withdraw"] as const;
export type TurnstileAction = (typeof TURNSTILE_ACTIONS)[number];

/** Cloudflare's own bound on a token (siteverify docs: "Maximum length: 2048 characters"). */
export const TURNSTILE_TOKEN_MAX_LENGTH = 2048;

/** Is this thrown value the Turnstile refusal? Duck-typed on purpose: `ApiError` (`lib/client.ts`) and `ApiV1Error`
 *  (`lib/client-v1.ts`) both carry `status` and `code`, and this module must not import either (one is a client module, and
 *  the server imports this file). Status AND code, so a 5xx or a 409 that happens to carry the string is not it. */
export function isTurnstileRefusal(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const e = err as Error & { status?: unknown; code?: unknown };
  return e.status === 403 && e.code === TURNSTILE_ERROR_CODE;
}
