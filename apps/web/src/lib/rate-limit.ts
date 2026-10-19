import "server-only";
import { HttpError } from "@/lib/errors";
import { incrWindow, cacheEnabled, type WindowCount } from "@/lib/cache";

export interface RateLimitConfig {
  /** Max requests allowed within `windowSeconds`. */
  max: number;
  /** Window size in seconds. */
  windowSeconds: number;
  /**
   * Behaviour when Redis is *configured but unreachable* (an Upstash blip).
   * Redis is the sole backend — there is no Postgres fallback — so this decides
   * the tradeoff: `true` → deny with 429 (abuse-protection first),
   * `false`/omitted → allow (availability first). Default is fail-open.
   *
   * Only applies when a REDIS_URL is set. With no Redis configured at all (local
   * dev, e2e) the limiter is inert and always allows, regardless of this flag.
   */
  failClosed?: boolean;
}

const TOO_MANY = "Too many requests — slow down and try again.";

/**
 * Fixed-window rate limiter backed solely by Upstash (managed Redis).
 * Each `key` gets up to `max` requests per `windowSeconds`; excess requests get
 * a 429 HttpError thrown.
 *
 * Key format convention: `"route:identifier"` — e.g. `"login:1.2.3.4"`.
 *
 * There is deliberately no Postgres fallback: the old DB bucket serialised on a
 * single hot row under load. Upstash owns the counter (one atomic INCR+EXPIRE,
 * self-expiring keys). When Redis is momentarily unreachable `incrWindow`
 * returns null and we apply the `failClosed` policy.
 */
type CounterFn = (key: string, windowSeconds: number) => Promise<WindowCount | null>;

/** Test-only seam. Production always uses `incrWindow`; the suite injects a
 *  deterministic counter so limiter BEHAVIOUR is executed rather than skipped.
 *  Without this the limiter is inert wherever Redis is unconfigured, which is
 *  local dev and the entire e2e suite. */
let counterOverride: CounterFn | null = null;
export function __setRateLimitCounterForTests(fn: CounterFn | null): void {
  counterOverride = fn;
}

/**
 * Capture QR v2 §10.4 / §17.4 (R4): a 429's `Retry-After` is the window's TRUE remaining seconds, read from the counter
 * key's TTL in the same Lua script as the increment — an integer, rounded UP, so never 0 while any time remains (a 0
 * makes a client hammer). A key with no TTL to read (PTTL -1 / -2; the Lua sets one on the first hit, so this is a
 * guard) answers the full window.
 */
export function retryAfterSeconds(ttlMs: number, windowSeconds: number): number {
  return ttlMs > 0 ? Math.ceil(ttlMs / 1000) : windowSeconds;
}

const tooMany = (retryAfter: number): HttpError =>
  new HttpError(429, TOO_MANY, undefined, undefined, { "Retry-After": String(retryAfter) });

export async function rateLimit(
  key: string,
  { max, windowSeconds, failClosed = false }: RateLimitConfig,
): Promise<void> {
  const window = counterOverride
    ? await counterOverride(`rl:${key}`, windowSeconds)
    : await incrWindow(`rl:${key}`, windowSeconds);

  if (window === null) {
    // No count from Redis. Two distinct cases:
    //  - Redis not configured (local dev, e2e): limiter is inert → always allow,
    //    even for failClosed limits, so auth flows work without a Redis.
    //  - Redis configured but unreachable (a real outage): apply failClosed.
    //    There is no window to read, so Retry-After is the full window (R4).
    if (failClosed && cacheEnabled()) throw tooMany(windowSeconds);
    return;
  }

  if (window.count > max) {
    throw tooMany(retryAfterSeconds(window.ttlMs, windowSeconds));
  }
}

// ─── Pre-configured limits ────────────────────────────────────────────────────

/**
 * Auth endpoints: login, signup, forgot-password. Fail-closed — a limiter
 * outage must not open a credential-stuffing window.
 */
export const AUTH_LIMIT: RateLimitConfig = { max: 10, windowSeconds: 60, failClosed: true };

/**
 * Email-sending endpoints: verify, change-email, invite. Fail-closed — protects
 * against mail-bombing while Redis is down.
 */
export const EMAIL_LIMIT: RateLimitConfig = { max: 5, windowSeconds: 300, failClosed: true };

/** Webhook endpoints (Stripe, Resend) — generous since legitimate traffic is high volume. */
export const WEBHOOK_LIMIT: RateLimitConfig = { max: 500, windowSeconds: 60 };

/** General mutation endpoints: tournament result writes. */
export const MUTATION_LIMIT: RateLimitConfig = { max: 60, windowSeconds: 60 };

/** Device-link mint AND reissue (a reissue IS a mint): one bucket, one number. */
export const DEVICE_LINK_MINT_LIMIT: RateLimitConfig = { max: 10, windowSeconds: 60 };

/**
 * Cookie-consent recording (POST /api/consent), per IP. A person clicks the
 * banner once; 20 a minute leaves room for a household or venue behind one
 * NAT while capping a bot writing rows into `cookie_consents`. Fail-open —
 * the banner calls it best-effort and a Redis blip must not refuse consent.
 */
export const CONSENT_LIMIT: RateLimitConfig = { max: 20, windowSeconds: 60 };

/**
 * Public registration checkout (re)open, per IP. Every call mints a Stripe
 * Checkout Session, so it gets a tighter bucket than the 60/min public read
 * budget. Fail-open — a Redis blip must not stop a registrant paying.
 */
export const CHECKOUT_LIMIT: RateLimitConfig = { max: 10, windowSeconds: 60 };

/**
 * Capture QR v2 §10.4 — the phone routes (`/api/v1/capture/codes/{code}…`). All three fail OPEN: a Redis blip must not
 * stop a broadcast's beats or the phone's start, and the tok (128 bits) is the real defence against guessing.
 *  - CAPTURE_CODE_LIMIT: per code, ONE budget across the three routes — a phone beats every 5–60 s;
 *  - CAPTURE_FAIL_LIMIT: FAILED 401s per client IP; a failure past it answers 429 — a valid tok is never refused;
 *  - CAPTURE_START_LIMIT: the phone's start, per code, on top of the code's budget.
 */
export const CAPTURE_CODE_LIMIT: RateLimitConfig = { max: 120, windowSeconds: 60 };
export const CAPTURE_FAIL_LIMIT: RateLimitConfig = { max: 30, windowSeconds: 60 };
export const CAPTURE_START_LIMIT: RateLimitConfig = { max: 6, windowSeconds: 60 };
/** Capture record upload (spec 2026-10-12 §8, P2): 10 records an hour per code, in a bucket of its OWN — the records
 *  route spends this INSTEAD of CAPTURE_CODE_LIMIT, so a Send never pushes a live phone's beats into 429. Fails open as
 *  the other capture budgets do. */
export const CAPTURE_RECORD_LIMIT: RateLimitConfig = { max: 10, windowSeconds: 3600 };

/**
 * The match room's camera-fault stamp (T14 fix round 6, M-2): the lobby PING a
 * changed stamp sends the opponent, per fixture and seat. Past it the stamp is
 * still written and the ping skipped — the opponent's next read catches up.
 * Fail-open: a Redis blip must not withhold the opponent's pill update.
 */
export const CAMERA_FAULT_PING_LIMIT: RateLimitConfig = { max: 10, windowSeconds: 60 };

/**
 * The match room's camera REPORT (D16, §5.6.3): a player's browser tells our server what its own camera is doing so the
 * opponent's pill can show it. Per fixture and person, across tabs. A tab sends about two a minute (every 30 s) and a
 * flapping camera a burst of changes; twelve a minute carries both. Past it the answer is a 429 - the client drops a
 * heartbeat (the next comes in 30 s) or sends a change again after its wait. Fail-open: a Redis blip must not blank the
 * pill. Its own bucket: CAMERA_FAULT_PING_LIMIT throttles the lobby PING only.
 */
export const CAMERA_REPORT_LIMIT: RateLimitConfig = { max: 12, windowSeconds: 60 };

/**
 * The arbiter panel's "Resync from Lichess" (T15 fix round 1, M3), per
 * fixture across every organiser: each one opens a Lichess stream with a
 * PLAYER's token, and Lichess's 429 stops every call the club makes for a
 * minute. Six a minute is more than any person presses; fail-open, so a Redis
 * blip never withholds a resync.
 */
export const ARBITER_RESYNC_LIMIT: RateLimitConfig = { max: 6, windowSeconds: 60 };

/**
 * The arbiter panel's join (D16, §5.6.4), per fixture and organiser. With a meeting per player the panel's white/black
 * switch joins on every press, and each join mints a participant row and spends vendor calls (the participant's add, and
 * its kick and delete on the way out). Twelve a minute is more than any person flips; a stuck loop stops at it, and past
 * it the answer is a 429 the panel shows as its generic error tile with a retry. Fail-open like its neighbours, so a Redis
 * blip never withholds a watch.
 */
export const ARBITER_JOIN_LIMIT: RateLimitConfig = { max: 12, windowSeconds: 60 };
