import "server-only";
// /api/v1 HTTP kernel (doc 08 §1) — the handler() pattern of src/lib/http.ts,
// extended for the versioned API: every response carries the
// { ok, data | error, requestId } envelope, EngineError codes map to HTTP in
// exactly one place, and list endpoints share opaque base64 cursor pagination.
import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { ZodError, type ZodType } from "zod";
import * as Sentry from "@sentry/nextjs";
import { EngineError, type EngineErrorCode } from "@seazn/engine/core";
import { isLevelResultReason } from "@/lib/level-result-reason";
import { isSettleRefusalReason } from "@/lib/settle-refusal-reason";
import { AuthError, HttpError, PaymentRequiredError } from "@/lib/errors";
import { featureReason } from "@/lib/feature-copy";
import { log } from "@/server/logger";
import { runRequestContext } from "@/server/request-context";
import { rateLimitHeaders, runV1Context } from "./context";

// EngineError.code → HTTP status (doc 08 §1, spec 03 §7). Central map — the
// only place engine codes meet HTTP. SEQ_CONFLICT is the optimistic-concurrency
// signal (409); everything the engine rejects as semantically invalid is 422.
export const ENGINE_HTTP: Record<EngineErrorCode, number> = {
  SEQ_CONFLICT: 409,
  SCHEDULE_CONFLICT: 409,
  INVALID_EVENT: 422,
  WRONG_PHASE: 422,
  ALREADY_DECIDED: 422,
  LINEUP_INVALID: 422,
  CONFIG_INVALID: 422,
  STAGE_NOT_READY: 422,
  DRAW_NOT_ALLOWED: 422,
  QUALIFICATION_INVALID: 422,
  ELIGIBILITY: 422,
  MODULE_NOT_FOUND: 422,
  MODULE_DUPLICATE: 500,
  // W4a (#425) §7 — the core time model. All four are things the scorer typed
  // and can retype: a stamp that went backwards, a 13-return expedite rally
  // credited to the wrong side, a substitution past the window allowance, and a
  // period this sport does not have. UNKNOWN_PHASE was briefly a captured 500
  // on the reasoning that a phase order is a module-side invariant no client
  // can reach — it is not. `at.period` is a free `z.string().min(1)` on the
  // payload, so any pad posting an unrecognised period reached it, and a 500
  // answered a typo by paging the on-call with nothing the scorer could act on.
  // The write gate now rejects a client's unknown period as INVALID_EVENT
  // before this code can be raised (engine core/events.ts); what remains is a
  // module whose declared phase order and whose `apply()` order disagree —
  // still one rejected event, still not worth a page.
  NON_MONOTONIC_TIME: 422,
  EXPEDITE_WRONG_WINNER: 422,
  SUB_WINDOW_EXCEEDED: 422,
  UNKNOWN_PHASE: 422,
  // S5 (#431) — a `tennis.game.award` posted mid-tie-break: the scorer typed
  // something that isn't valid right now and can retype it once the breaker
  // ends.
  GAME_AWARD_DURING_TIEBREAK: 422,
  // F2 (unified progression field) — placeDescriptors/
  // validateProgressionAgainstShapes moved from this usecase layer's
  // stage-seeding.ts into the engine; same four codes, same 422, same
  // wire-visible strings (see apps/web/src/lib/seeding-error.ts and the
  // errors.json dictionaries, unchanged by this move).
  SEEDING_RULES_MISSING: 422,
  SEEDING_MAP_SLOT_INVALID: 422,
  SEEDING_MAP_SOURCE_INVALID: 422,
  SEEDING_BESTNTH_UNEQUAL_POOLS: 422,
  // F3 Task 3 (P6) — a seeded_map source ambiguous across >1 progression
  // source (placeDescriptors, progression.ts). It IS in seeding-error.ts's
  // SEEDING_ERROR_CODES allowlist now (F3 round-3 review, 2026-08-18; same
  // file, ~:48) with real copy in all four errors.json locales — an
  // organiser sees translated seeding copy here, not a raw engine message
  // the way STAGE_NOT_READY's own unwired fallback still does. The status is
  // what matters independent of that: 422, never the 500 an unmapped code
  // would otherwise risk.
  SEEDING_MAP_SOURCE_AMBIGUOUS: 422,
  // W2a (spec §7) — brackets always finish.
  SETTLE_NOT_APPLICABLE: 409,
  TIEBREAK_NOT_APPLICABLE: 409,
  LEVEL_RESULT_IN_BRACKET: 409,
  // An assertion (X-BR-1): reaching it is a server bug, so it surfaces as one.
  LEVEL_RESULT_SEATED: 500,
};

// HTTP status → stable machine code for non-engine errors.
function statusCode(status: number): string {
  switch (status) {
    case 400: return "VALIDATION";
    case 401: return "UNAUTHENTICATED";
    case 402: return "PAYMENT_REQUIRED";
    case 403: return "FORBIDDEN";
    case 404: return "NOT_FOUND";
    case 409: return "CONFLICT";
    case 429: return "RATE_LIMITED";
    default: return status >= 500 ? "INTERNAL" : "ERROR";
  }
}

/** Non-200 success or extra headers: return `reply(201, data)` from a handler. */
export class Reply<T> {
  constructor(
    readonly status: number,
    readonly data: T,
    readonly headers?: Record<string, string>,
  ) {}
}
export function reply<T>(status: number, data: T, headers?: Record<string, string>): Reply<T> {
  return new Reply(status, data, headers);
}

interface ErrorBody {
  ok: false;
  error: { code: string; message: string; [k: string]: unknown };
  requestId: string;
}

function errorResponse(
  requestId: string,
  status: number,
  code: string,
  message: string,
  extra?: Record<string, unknown>,
  headers?: Record<string, string>,
): NextResponse {
  const body: ErrorBody = { ok: false, error: { code, message, ...extra }, requestId };
  // A15 (capture QR v2 §17.4): the error's own headers (the limiter's Retry-After) are MERGED with this request's
  // X-RateLimit-* — neither replaces the other.
  return NextResponse.json(body, { status, headers: { ...rateLimitHeaders(), ...headers } });
}

/**
 * Wrap a /api/v1 route handler. Success → { ok: true, data, requestId } (200,
 * or Reply's status/headers). Errors → the envelope with a typed code:
 * EngineError via ENGINE_HTTP (SEQ_CONFLICT carries current_seq per doc 08 §4),
 * PaymentRequiredError → 402, AuthError → 401, HttpError → its status,
 * ZodError → 400 with issues.
 */
export async function v1<T>(fn: () => Promise<T | Reply<T>>): Promise<NextResponse> {
  const requestId = randomUUID();
  // ALS context so deep layers (API-key auth) can surface X-RateLimit-*
  // counters onto whatever response this request ends up with (v3/08 §2),
  // and so every log line for this request carries the same requestId
  // (server/request-context.ts, read by server/logger.ts's mixin).
  return runRequestContext(requestId, () => runV1Context(() => v1Inner(requestId, fn)));
}

async function v1Inner<T>(
  requestId: string,
  fn: () => Promise<T | Reply<T>>,
): Promise<NextResponse> {
  try {
    const result = await fn();
    const rate = rateLimitHeaders();
    if (result instanceof Reply) {
      // 204 carries no body by definition (v3/09 §4 — DELETE division).
      if (result.status === 204) {
        return new NextResponse(null, { status: 204, headers: { ...rate, ...result.headers } });
      }
      return NextResponse.json(
        { ok: true, data: result.data, requestId },
        { status: result.status, headers: { ...rate, ...result.headers } },
      );
    }
    return NextResponse.json({ ok: true, data: result, requestId }, { headers: rate });
  } catch (err: unknown) {
    if (err instanceof ZodError) {
      return errorResponse(requestId, 400, "VALIDATION", "Invalid input", {
        issues: err.issues,
      });
    }
    if (EngineError.is(err)) {
      const status = ENGINE_HTTP[err.code] ?? 422;
      if (status >= 500) {
        Sentry.captureException(err);
        log.error({ err, code: err.code, status }, "v1: unmapped EngineError reached 500");
      }
      // 409 contract (doc 08 §4): the client resyncs from current_seq.
      let extra: Record<string, unknown> | undefined;
      if (
        err.code === "SEQ_CONFLICT" &&
        typeof (err.data as { actualSeq?: unknown } | undefined)?.actualSeq === "number"
      ) {
        extra = { current_seq: (err.data as { actualSeq: number }).actualSeq };
      }
      // Blocking schedule conflicts (doc 12 §2): the client renders them as
      // badges on the offending cards, so the 409 carries the list.
      if (
        err.code === "SCHEDULE_CONFLICT" &&
        Array.isArray((err.data as { conflicts?: unknown } | undefined)?.conflicts)
      ) {
        extra = { conflicts: (err.data as { conflicts: unknown[] }).conflicts };
      }
      // "Générer les matchs" precondition failure (design/fix-ui/03 §"misleading
      // success message"): a group stage that can't pair its entrants into the
      // configured groups throws STAGE_NOT_READY with reason
      // "group_too_few_entrants" — forward it so the client can render an
      // actionable reason instead of the generic "up to date" success copy.
      if (
        err.code === "STAGE_NOT_READY" &&
        (err.data as { reason?: unknown } | undefined)?.reason === "group_too_few_entrants"
      ) {
        const d = err.data as { groups: number; entrants: number; required: number };
        extra = { reason: "group_too_few_entrants", groups: d.groups, entrants: d.entrants, required: d.required };
      }
      // F2a (P7 follow-up): the SEEDED-path analogue of the block above — a
      // `.seeding` group stage whose placed seeds can't fill its configured
      // pools throws STAGE_NOT_READY with reason
      // "seeded_pool_too_few_qualifiers" (stages.ts
      // generateSeededStageFixtures). Forward it the same way so the client
      // can render an actionable message instead of the dead-end
      // SEEDING_RULES_MISSING loop this guard exists to prevent from ever
      // being committed.
      if (
        err.code === "STAGE_NOT_READY" &&
        (err.data as { reason?: unknown } | undefined)?.reason === "seeded_pool_too_few_qualifiers"
      ) {
        const d = err.data as { groups: number; qualifiers: number; required: number; stranded: number };
        extra = {
          reason: "seeded_pool_too_few_qualifiers",
          groups: d.groups,
          qualifiers: d.qualifiers,
          required: d.required,
          stranded: d.stranded,
        };
      }
      // An `on_complete` progression stage whose source stage has not
      // finished (stages.ts generateStageFixtures' pre-flight). The desk names
      // both stages in an amber notice instead of showing this English
      // `message` in a red banner, so it needs both ids on the wire.
      if (
        err.code === "STAGE_NOT_READY" &&
        (err.data as { reason?: unknown } | undefined)?.reason === "previous_stage_incomplete"
      ) {
        const d = err.data as { stageId: string; previousStageId: string };
        extra = { reason: "previous_stage_incomplete", stageId: d.stageId, previousStageId: d.previousStageId };
      }
      // W2a fix round 1 (review M-1): LEVEL_RESULT_IN_BRACKET has two emitters asking for different things (enter
      // the winner; settle before finalizing), so the copy branches on the reason — forwarded only when named.
      if (err.code === "LEVEL_RESULT_IN_BRACKET") {
        const reason = (err.data as { reason?: unknown } | undefined)?.reason;
        if (isLevelResultReason(reason)) extra = { reason };
      }
      // W2a ruling D-R8: SETTLE_NOT_APPLICABLE for a withdrawn winner (C17, D-R7) has its own copy; every other
      // SETTLE_NOT_APPLICABLE keeps the code's — so only a reason this codebase names is forwarded.
      if (err.code === "SETTLE_NOT_APPLICABLE") {
        const reason = (err.data as { reason?: unknown } | undefined)?.reason;
        if (isSettleRefusalReason(reason)) extra = { reason };
      }
      return errorResponse(requestId, status, err.code, err.message, extra);
    }
    if (err instanceof PaymentRequiredError) {
      // Upgrade-moment contract (doc 10 §3): feature_key drives the contextual
      // paywall (<UpgradeGate>), reason is the human sentence. `feature` kept
      // for pre-PROMPT-13 clients. `extra` carries machine-readable hints on
      // top — e.g. { offer: "extra_org" } (v17 gap #293) — matching what
      // lib/http.ts's 402 branch forwards, so a refusal does not lose its way
      // out purely by which envelope happened to serialise it.
      return errorResponse(requestId, 402, "PAYMENT_REQUIRED", err.message, {
        feature: err.featureKey,
        feature_key: err.featureKey,
        reason: featureReason(err.featureKey),
        ...err.extra,
      });
    }
    if (err instanceof AuthError) {
      return errorResponse(requestId, 401, "UNAUTHENTICATED", err.message);
    }
    if (err instanceof HttpError) {
      if (err.status >= 500) {
        Sentry.captureException(err);
        log.error({ err, status: err.status, code: err.code }, "v1: HttpError reached 500");
      }
      return errorResponse(
        requestId,
        err.status,
        err.code ?? statusCode(err.status),
        err.message,
        err.extra,
        err.headers,
      );
    }
    Sentry.captureException(err);
    const message = err instanceof Error ? err.message : "Server error";
    log.error({ err }, "v1: unhandled error");
    return errorResponse(requestId, 500, "INTERNAL", message);
  }
}

/** Parse + Zod-validate a JSON request body (malformed JSON → 400). */
export async function parseBody<T>(req: Request, schema: ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new HttpError(400, "Request body must be valid JSON");
  }
  return schema.parse(raw);
}

/**
 * Assert a query param is a member of its declared enum, 400ing when it is not.
 *
 * The alternative — the shape this replaced on two routes — is
 *
 *     const status = raw && STATUSES.has(raw) ? (raw as Status) : undefined;
 *
 * which answers `?status=publish` (a typo for "published") with an UNFILTERED
 * list. That is the worst of the three possible behaviours: the caller asked
 * for published posts, believes the filter was applied, and is handed drafts.
 * A 400 naming the accepted values is the only answer that cannot be
 * misread. `listQuery` above already 400s an unparseable `?limit=`, and
 * `/public/discovery` and `/divisions/{id}/registrations` already 400 their
 * own status enums — this is that rule with one home instead of four copies.
 *
 * `null` (absent) means no filter and is always allowed. An EMPTY value
 * (`?status=`) is a member check like any other and therefore 400s, matching
 * what the registration list has always done.
 *
 * Pass the zod schema's own `.options` rather than a hand-written list, so a
 * new member flows here without an edit. The assertion signature is what lets
 * the caller drop the `as Status` cast — that cast is how an unvalidated
 * string reached a typed parameter in the first place.
 */
export function assertOneOf<T extends string>(
  value: string | null,
  options: readonly T[],
  field: string,
): asserts value is T | null {
  if (value !== null && !(options as readonly string[]).includes(value)) {
    throw new HttpError(400, `${field} must be one of ${options.join(", ")}`);
  }
}

// ---------------------------------------------------------------------------
// Cursor pagination (doc 08 §1): ?cursor=&limit=, opaque base64url cursor over
// the keyset (created_at, id). No X-Total-Count by design (expensive).
// ---------------------------------------------------------------------------

export interface ListQuery {
  cursor: { createdAt: string; id: string } | null;
  limit: number;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export function encodeCursor(createdAt: string, id: string): string {
  return Buffer.from(JSON.stringify({ v: createdAt, id }), "utf8").toString("base64url");
}

export function decodeCursor(raw: string): { createdAt: string; id: string } {
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as {
      v?: unknown;
      id?: unknown;
    };
    if (typeof parsed.v !== "string" || typeof parsed.id !== "string") throw new Error("shape");
    return { createdAt: parsed.v, id: parsed.id };
  } catch {
    throw new HttpError(400, "Invalid cursor");
  }
}

/** Read ?cursor=&limit= off a request URL. */
export function listQuery(req: Request): ListQuery {
  const url = new URL(req.url);
  const rawLimit = url.searchParams.get("limit");
  const parsed = rawLimit === null ? DEFAULT_LIMIT : Number(rawLimit);
  if (!Number.isInteger(parsed) || parsed < 1) throw new HttpError(400, "Invalid limit");
  const limit = Math.min(parsed, MAX_LIMIT);
  const rawCursor = url.searchParams.get("cursor");
  return { cursor: rawCursor ? decodeCursor(rawCursor) : null, limit };
}

/**
 * Build a Page from limit+1 keyset rows: callers over-fetch by one row to
 * detect a next page, then this trims and mints the cursor from the last kept
 * row's (created_at, id).
 */
export function page<T extends { id: string; created_at: string | Date }>(
  rows: T[],
  limit: number,
): Page<T> {
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  const nextCursor =
    rows.length > limit && last
      ? encodeCursor(new Date(last.created_at).toISOString(), last.id)
      : null;
  return { items, nextCursor };
}
