import "server-only";
// Cloudflare Turnstile, server half: the ONE place a token is judged. Seven public POSTs call `requireTurnstile` (login, start,
// register, resend, join, and withdraw, which two routes share); nothing else in the app knows what a siteverify response looks like.
//
// Two questions, kept apart so each can be tested alone:
//   * `turnstileMode`  — must THIS process check at all? (one small predicate, below; it also honours the `TURNSTILE=off` break-glass)
//   * `verifyTurnstile` — is THIS token good for THIS action on THIS host? (strict; it never skips)
import { clientIp } from "@/lib/client-ip";
import { HttpError } from "@/lib/errors";
import { log } from "@/server/logger";
import { FAKE_DRIVER_ENV_NAMES } from "@/server/relay/config";
import {
  TURNSTILE_ERROR_CODE,
  TURNSTILE_HEADER,
  TURNSTILE_TOKEN_MAX_LENGTH,
  type TurnstileAction,
} from "@/lib/turnstile";

export const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
/** How long a request waits on Cloudflare before it is refused. Cloudflare's own example uses 10 s. */
export const SITEVERIFY_TIMEOUT_MS = 10_000;

type Env = Record<string, string | undefined>;

export type TurnstileMode = "skip" | "enforce";

/**
 * The break-glass: `TURNSTILE=off` turns the bot check off on a RUNNING deployment, for the day Cloudflare or the widget is down
 * or a mis-set site key locks every club out of sign-in and registration. Modelled on `REALTIME_PUBLISH=off` (lib/realtime.ts):
 * a server-side variable read at CALL time, so a Fly secret set on a live machine takes effect with no rebuild.
 *
 * Exactly "off", compared case-insensitively after trimming. Every other value, the empty string and an unset variable leave the
 * check ON, so a typo ("false", "0", "no") can never open the door by accident. It lives in the environment and nowhere in the
 * repo: turnstile-ci-wiring.test.ts fails a fly*.toml, Dockerfile or workflow that sets it.
 */
export function turnstileSwitchedOff(env: Env = process.env): boolean {
  return env.TURNSTILE?.trim().toLowerCase() === "off";
}

/** A developer's machine, vitest or a harness server (`ENV_NAME` local or ci): the processes that never check. */
function isHarness(env: Env): boolean {
  const envName = env.ENV_NAME?.trim();
  return env.NODE_ENV !== "production" || (!!envName && FAKE_DRIVER_ENV_NAMES.includes(envName));
}

/**
 * Must this process check the token?
 *
 *   * `skip`    — the `TURNSTILE=off` break-glass (above), then dev, vitest, and a harness server (`ENV_NAME` local or ci, the SAME list that licenses the relay's fake
 *                 drivers: `FAKE_DRIVER_ENV_NAMES`). Skipped even when a secret is set, on purpose: a developer's
 *                 `.env.local` carries the live secret, and every local server started from it (seazn-env, the e2e target)
 *                 would otherwise demand a token from a widget that is not allowed on `localhost`.
 *   * `enforce` — everything else: production, any other ENV_NAME, or none. With NO secret this does not open the door: the
 *                 verifier fails closed (`secret_unset`), so a deploy that lost its secret answers 403 to every guarded POST
 *                 and logs an error, until the secret is set. A loud outage, never a silent bypass.
 *
 * An unnamed production server is a deployment that lost its `ENV_NAME` (relay/config.ts says the same), so it is NOT a
 * harness: only an explicit `local` / `ci` is.
 */
export function turnstileMode(env: Env = process.env): TurnstileMode {
  return turnstileSwitchedOff(env) || isHarness(env) ? "skip" : "enforce";
}

/** One loud line per process (module state: a new process is a new module) while the break-glass is what lets requests through. */
let switchWarned = false;
function warnSwitchedOff(env: Env): void {
  if (switchWarned) return;
  switchWarned = true;
  log.warn(
    { env_name: env.ENV_NAME?.trim() || null },
    "turnstile: TURNSTILE=off — the bot check is DISABLED on this process: every guarded POST is accepted without a token. Unset the TURNSTILE secret to turn it back on.",
  );
}

export type TurnstileRefusalReason =
  | "no_token"
  | "bad_token"
  | "secret_unset"
  | "hostnames_unset"
  | "unreachable"
  | "bad_response"
  | "rejected"
  | "wrong_action"
  | "wrong_hostname";

export type TurnstileVerdict = { ok: true } | { ok: false; reason: TurnstileRefusalReason; errorCodes?: string[] };

/** `TURNSTILE_HOSTNAMES`: a comma list, matched case-insensitively and exactly (no wildcard, no suffix match). */
function allowedHostnames(env: Env): string[] {
  return (env.TURNSTILE_HOSTNAMES ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h !== "");
}

/** The error codes Cloudflare answered a refusal with, as short strings only: they are logged, never trusted. */
function errorCodesOf(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((c): c is string => typeof c === "string").slice(0, 8).map((c) => c.slice(0, 64))
    : [];
}

/**
 * Judge one token with Cloudflare's siteverify. Fails CLOSED on everything that is not a clean `success: true`: no secret,
 * no hostnames to compare against, a network error or timeout, a non-2xx, a body that is not JSON, a refusal, a token minted
 * for another action, a token minted on another host. A token is single-use on Cloudflare's side, so a replayed one comes
 * back `success: false` (`timeout-or-duplicate`) and this function does not remember anything of its own.
 *
 * `ip` is the visitor's, passed along as `remoteip` when known (Cloudflare treats it as optional); `requireTurnstile` reads it with
 * the shared `lib/client-ip.ts`, so behind Cloudflare it is the visitor and not the shared edge Fly saw. "unknown" sends none.
 */
export async function verifyTurnstile(input: {
  token: unknown;
  action: TurnstileAction;
  ip?: string | null;
  env?: Env;
}): Promise<TurnstileVerdict> {
  const env = input.env ?? process.env;
  const { token } = input;
  if (token === null || token === undefined || token === "") return { ok: false, reason: "no_token" };
  if (typeof token !== "string" || token.length > TURNSTILE_TOKEN_MAX_LENGTH) return { ok: false, reason: "bad_token" };

  const secret = env.TURNSTILE_SECRET?.trim();
  if (!secret) return { ok: false, reason: "secret_unset" };
  const hostnames = allowedHostnames(env);
  if (hostnames.length === 0) return { ok: false, reason: "hostnames_unset" };

  const form = new URLSearchParams({ secret, response: token });
  if (input.ip && input.ip !== "unknown") form.set("remoteip", input.ip);

  let res: Response;
  try {
    res = await fetch(SITEVERIFY_URL, { method: "POST", body: form, signal: AbortSignal.timeout(SITEVERIFY_TIMEOUT_MS) });
  } catch {
    return { ok: false, reason: "unreachable" };
  }
  if (!res.ok) return { ok: false, reason: "unreachable" };

  let result: unknown;
  try {
    result = await res.json();
  } catch {
    return { ok: false, reason: "bad_response" };
  }
  if (typeof result !== "object" || result === null) return { ok: false, reason: "bad_response" };
  const r = result as { success?: unknown; action?: unknown; hostname?: unknown; "error-codes"?: unknown };

  if (r.success !== true) return { ok: false, reason: "rejected", errorCodes: errorCodesOf(r["error-codes"]) };
  if (r.action !== input.action) return { ok: false, reason: "wrong_action" };
  if (typeof r.hostname !== "string" || !hostnames.includes(r.hostname.trim().toLowerCase())) {
    return { ok: false, reason: "wrong_hostname" };
  }
  return { ok: true };
}

const REFUSAL_MESSAGE = "Verification failed. Reload the page and try again.";

/**
 * The gate a guarded route calls FIRST (straight after its first rate limit): resolves when the request may proceed, throws
 * the 403 `{ code: TURNSTILE_FAILED }` otherwise, before the route has read its body or done any work. The caller learns only
 * "verification failed"; the reason (and, for a misconfiguration, which variable) goes to the log.
 */
export async function requireTurnstile(req: Request, action: TurnstileAction): Promise<void> {
  if (turnstileMode() === "skip") {
    // Only the break-glass earns a warning: a harness or a dev process skips by design and would drown the line in noise.
    if (turnstileSwitchedOff(process.env) && !isHarness(process.env)) warnSwitchedOff(process.env);
    return;
  }
  const verdict = await verifyTurnstile({ token: req.headers.get(TURNSTILE_HEADER), action, ip: clientIp(req.headers) });
  if (verdict.ok) return;
  const misconfigured = verdict.reason === "secret_unset" || verdict.reason === "hostnames_unset";
  (misconfigured ? log.error : log.warn).call(
    log,
    { action, reason: verdict.reason, ...(verdict.errorCodes ? { error_codes: verdict.errorCodes } : {}) },
    "turnstile: request refused",
  );
  throw new HttpError(403, REFUSAL_MESSAGE, TURNSTILE_ERROR_CODE);
}
