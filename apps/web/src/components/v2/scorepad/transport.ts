// Real ScoringTransport over fetch (S10/#419 W8, network-wiring pass). The
// two auth modes differ ONLY in headers: session rides the browser's own
// cookie (no header — same as fixture-console.tsx's own apiV1() calls),
// device-link sends `Authorization: Bearer dl_...` exactly as
// device-score-pad.tsx does today (device-score-pad.tsx:90-97) — the token
// string itself already carries the `dl_` prefix (server/api-v1/auth.ts's
// DEVICE_LINK_PREFIX), so `Bearer ${token}` reproduces it verbatim.
//
// No retry loop here — deliberately. queue.ts/pipeline.ts already own
// ordering and retry (that is the entire point of the offline queue); a
// transport that also retried would race the queue's own bookkeeping.
//
// Deviation from pipeline.ts's `ScoringTransport`: this file adds a FOURTH
// read, `fetchState`, via `PadTransport extends ScoringTransport` rather
// than editing that interface. Reason: `AppendSuccess.state_summary` (the
// POST ack's own field — pipeline.ts/types.ts) is `SportModule.summary
// (state)` — a separate, smaller DISPLAY projection
// (packages/engine/src/sport/module.ts) — not the raw fold `State`
// (`match_states.state`, server/usecases/fixtures.ts's `FixtureStateOut`).
// use-pad-pipeline.ts's reconciliation step ("optimistic state against the
// server `state`") needs the real thing, which only `GET .../state` carries.
// Additive: pipeline.ts and its already-shipped tests need no changes.
import { z } from "zod";
import type { AppendCallResult, AppendEventBody, ScoringTransport } from "./pipeline";
import type { AppendSuccess, LedgerSlotEvent } from "./types";
import { NEXT_MATCH_STARTED_CODE, nextMatchRefOf } from "../../../lib/next-match-started";

// Review finding 1: listEventsSince previously cast the ledger JSON straight
// to LedgerSlotEvent[] with no runtime validation, so an OMITTED
// recorded_by/device_link_id key came back `undefined` at runtime despite
// the type saying `string | null` — a strict `===` in pipeline.ts's
// resolveConflict would then read an already-applied own event as FOREIGN
// and resend a real duplicate. `.nullish()` accepts either an absent key OR
// an explicit `null` and the `.transform` collapses both to a real `null`,
// so this boundary hands resolveConflict exactly the type it already
// declares, and any OTHER shape change (a renamed/mistyped field) surfaces
// as a thrown parse error here instead of a silent mis-compare downstream.
//
// S12/#421: `id`/`recorded_at` joined the two identity fields above —
// use-pad-pipeline.ts needs both to widen a polled/realtime ledger row into
// a foldable `EventEnvelope` (its own `ledgerSlotToEnvelope`). Unlike
// recorded_by/device_link_id, score_events.id/.recorded_at are NOT NULL
// columns (db/migration/v2-engine/tables/V216__score_events.sql) — the real
// server response never omits or nulls either — so these get the SAME
// rigor applied to `seq`/`type` below (a required, non-nullish
// `z.string()`): a row missing one is a genuine wire-contract violation and
// should hard-fail here, not silently degrade. (LedgerSlotEvent's own TYPE
// still marks both optional, for a DIFFERENT, TS-compile-time reason — see
// its JSDoc in types.ts.)
//
// R5 — `voids_event_id` is now KEPT, not validated-then-dropped. Dropping it
// here was the wire half of a real defect: the server has always sent the
// field (`EventOut`, server/usecases/fixtures.ts; `ScoreEvent`,
// server/api-v1/schemas.ts), but every void this pad learned about through a
// POLL rather than through its own submission arrived with no target at all,
// so use-pad-pipeline.ts's `ledgerSlotToEnvelope` widened it into a
// `core.void` naming nothing and the engine's `resolveVoids` rejected the
// fold from that point on — a second referee's undo, or the fixture
// console's, froze this device's pad behind a rejection banner. Nullable on
// the wire (only a core.void ever carries one), and `.nullish()` for the same
// absent-key-vs-explicit-null reason as the two identity fields below.
const ledgerSlotEventSchema = z.object({
  id: z.string(),
  seq: z.number(),
  type: z.string(),
  payload: z.unknown(),
  recorded_at: z.string(),
  recorded_by: z
    .string()
    .nullish()
    .transform((v) => v ?? null),
  device_link_id: z
    .string()
    .nullish()
    .transform((v) => v ?? null),
  voids_event_id: z
    .string()
    .nullish()
    .transform((v) => v ?? null),
});
const ledgerSlotEventsSchema = z.array(ledgerSlotEventSchema);

/**
 * The ack as the pipeline may trust it. Every field rides through untouched
 * (no stricter than before), except `event_id`: the ack's stamp becomes the
 * pad's ledger id for the row, so anything that is not a non-empty string is
 * DROPPED rather than passed on — an entry under a junk id is exactly as
 * unresolvable to a later void as one under the pad's own minted key, and a
 * missing id falls back to that key honestly (`AppendSuccess.event_id`).
 */
function appendSuccessOf(data: AppendSuccess): AppendSuccess {
  const { event_id: eventId, ...rest } = data as Omit<AppendSuccess, "event_id"> & { event_id?: unknown };
  return typeof eventId === "string" && eventId.length > 0 ? { ...rest, event_id: eventId } : rest;
}

/** Session vs device-link — the one fact that changes the outgoing request. */
export type PadAuthMode = { kind: "session" } | { kind: "device_link"; token: string };

export function authHeadersFor(auth: PadAuthMode): Record<string, string> {
  return auth.kind === "device_link" ? { Authorization: `Bearer ${auth.token}` } : {};
}

export interface TransportInit {
  /** Injectable fetch — defaults to the global. Every transport.test.ts case
   *  injects a double; no server is ever contacted from this suite. */
  fetchFn?: typeof fetch;
}

/** `GET /api/v1/fixtures/{id}/state`, narrowed to what use-pad-pipeline.ts's
 *  reconciliation needs — mirrors server/usecases/fixtures.ts's
 *  `FixtureStateOut` shape without importing it (that module is
 *  `@/server/**`, banned from this bundle by the purity gate below). */
export interface FixtureStateResult {
  status: string;
  last_seq: number;
  state: unknown;
  summary: unknown;
  outcome: unknown;
}

/** `ScoringTransport` plus the one read pipeline.ts's own append/replay
 *  protocol never needed. See the file header for why this extends rather
 *  than edits that interface. */
export interface PadTransport extends ScoringTransport {
  fetchState(fixtureId: string): Promise<FixtureStateResult>;
}

interface V1Envelope<T> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string; [k: string]: unknown };
  requestId?: string;
}

/**
 * Did this body actually come from OUR API?
 *
 * `ok` is the v1 envelope's one unconditional field (`http.ts` writes it on
 * every response, success or failure), so a boolean `ok` on an object is the
 * cheapest complete test. An HTML challenge page fails at `res.json()`; a
 * JSON error page from some intermediary parses but has no `ok`.
 *
 * Deliberately NOT a `cf-mitigated` header sniff: that couples the pad's
 * transport to one vendor's header name, and rots the day it is renamed or
 * another proxy sits in front. The envelope is OUR contract, so it is the
 * thing we are entitled to test for.
 */
function isV1Envelope(raw: unknown): raw is V1Envelope<unknown> {
  return typeof raw === "object" && raw !== null && typeof (raw as { ok?: unknown }).ok === "boolean";
}

interface ParsedResponse<T> {
  body: V1Envelope<T>;
  /** False when the body was unparseable OR parsed into something that is not
   *  our envelope — i.e. this response was written by something that is not
   *  our API. `appendEvent` uses it to tell an intermediary's 403 from ours. */
  fromOurApi: boolean;
}

async function parseEnvelope<T>(res: Response): Promise<ParsedResponse<T>> {
  const fallback: V1Envelope<T> = {
    ok: false,
    error: { code: "UNKNOWN", message: `request failed (${res.status})` },
  };
  try {
    const raw: unknown = await res.json();
    return isV1Envelope(raw) ? { body: raw as V1Envelope<T>, fromOurApi: true } : { body: fallback, fromOurApi: false };
  } catch {
    return { body: fallback, fromOurApi: false };
  }
}

/** Shared by every GET this file makes: throws on any failure (a thrown
 *  fetch OR a non-2xx/`ok:false` response) rather than returning a sentinel
 *  — matching `ScoringTransport.listEventsSince`/`getLastSeq`'s own
 *  documented contract ("May reject; sendOne treats a rejection the same as
 *  ... unavailable", pipeline.ts). */
export async function readV1Envelope<T>(res: Response): Promise<T> {
  const { body } = await parseEnvelope<T>(res);
  if (!res.ok || body.ok === false || body.data === undefined) {
    throw new Error(body.error?.message ?? `request failed (${res.status})`);
  }
  return body.data;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : "network request failed";
}

/**
 * `Retry-After`, in milliseconds, or null when the server did not send a
 * usable one.
 *
 * The anchored digits test is load-bearing and is the same one
 * `server/relay/fly-client.ts` applies to Fly's 429s: `Retry-After` is legally
 * EITHER delta-seconds OR an HTTP-date, and `Number("Wed, 21 Oct 2026 …")` is
 * NaN. A NaN delay compares false against every `<` and `>`, so the entry
 * carrying it would either never wait or never send, depending on which side
 * of the comparison saw it. Unparseable means absent, never guessed.
 *
 * Nothing under `src/server/api-v1` sets this header today (checked
 * 2026-09-21), so in practice the pad's own derived backoff is what paces a
 * retry. This exists so that a server which later starts sending one is
 * obeyed rather than second-guessed.
 */
export function retryAfterMsOf(res: Response): number | null {
  const raw = res.headers.get("retry-after");
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  return Number(trimmed) * 1000;
}

/**
 * The two 4xx statuses that genuinely invite the SAME request again — 408 is
 * "you took too long, try again" and 429 is "slow down and try again". Both
 * are transient by the server's own definition, which is exactly what the
 * offline queue exists to ride out.
 */
const RETRYABLE_CLIENT_STATUS: ReadonlySet<number> = new Set([408, 429]);

/**
 * The 409s no `expected_seq` can ever satisfy.
 *
 * A 409 normally means "your write is fine, its expected_seq is stale" and the
 * pipeline's replay protocol renegotiates it. These four do not mean that. The
 * server is refusing the UNDO ITSELF — the target is missing, already struck,
 * or is a void that cannot be voided (`server/usecases/scoring.ts`'s undo
 * path).
 *
 * Renegotiating them resends a request that fails identically, which
 * `pipeline.ts` answers with `stayed-queued`/`conflict-again`, which
 * `drainQueue` answers by leaving the event at the HEAD — blocking every write
 * behind it, permanently and silently (`use-pad-pipeline.ts` only raises the
 * offline chip for `network`). Measured on staging 2026-09-21: 10 queued
 * actions behind one already-undone void, while the pad went on showing a
 * score that had stopped being true.
 *
 * NEXT_MATCH_STARTED (owner ruling 2026-09-23, `server/engine-db/fed-seats.ts`)
 * is the fifth: a void that would erase a knockout result whose next match has
 * already started. Only voiding that next match first changes the answer — a
 * resend never does.
 *
 * An UNRECOGNISED code stays renegotiable on purpose: an un-migrated server
 * sends a bare `CONFLICT`, and a new client must not wedge against it.
 *
 * Exported for its paired test only — nothing else imports it. That test pins
 * this set against the terminal 409s the server actually throws, so a new one
 * cannot arrive server-side without an entry here.
 */
export const TERMINAL_CONFLICT_CODES: ReadonlySet<string> = new Set([
  "UNDO_NOOP",
  "UNDO_TARGET_MISSING",
  "UNDO_ALREADY_VOIDED",
  "UNDO_NOT_UNDOABLE",
  NEXT_MATCH_STARTED_CODE,
]);

/**
 * Scorer sheets §4.5 — refusals that end what THIS SURFACE may do on the
 * fixture, not only this one write. The transport already classifies them as
 * `rejected` with their code (a 403 carrying our envelope, below); the
 * pipeline drops the write like any rejection. What these add is a signal to
 * the CHROME around the pad (`onTerminalRefusal`), which must change screens.
 * Each member is pinned against the server source that sends it.
 *
 * A string literal, not an import: `@/server/**` is banned from this bundle
 * (`__tests__/server-boundary.test.ts`), so `transport.test.ts` pins each
 * member against `usecases/carried-forward.ts` read as text.
 */
export const CHROME_TERMINAL_CODES: ReadonlySet<string> = new Set(["RESULT_CARRIED_FORWARD"]);

export function terminalRefusalOf(
  rejection: { code: string; message: string } | null,
): { code: string; message: string } | null {
  return rejection !== null && CHROME_TERMINAL_CODES.has(rejection.code) ? rejection : null;
}

/**
 * Is this status the server permanently refusing THIS write?
 *
 * R6 FIX PASS 3, GAP 1 — the ship-blocker this predicate exists to kill.
 * Before it, `appendEvent` recognised exactly two non-2xx statuses (409, 422)
 * and let every other one fall through to `{ kind: "network-error" }`. That
 * routing is not cosmetic: `pipeline.ts`'s `sendOne` turns a network error
 * into `stayed-queued`, and `use-pad-pipeline.ts` answers `stayed-queued` by
 * setting `offline` and KEEPING the optimistic envelope — by design, because
 * a scorer on bad courtside wifi must not lose taps.
 *
 * So a 402 from the entitlement gate was filed as flaky wifi. Measured on the
 * running product, 2026-08-30: a band-1 ice-hockey pad POSTed a penalty, got
 * `402 PAYMENT_REQUIRED`, and went on showing the ribbon "Penalty — Minor",
 * two rows in Activity, an "ON ICE 3V5" strength chip and a ticking 2:00
 * countdown, with the ledger holding only `core.start` and no banner
 * anywhere. In this sport the on-ice strength is match state, so the pad was
 * not merely optimistic — it was wrong about the game, and silently.
 *
 * The fix is a STATUS CLASS, not an entitlement branch. 402 was one instance;
 * a 403 (device link revoked mid-match), a 401 (session expired) and a 404
 * (fixture deleted under the pad) had the identical symptom and were equally
 * invisible.
 *
 * "Permanent" here means PERMANENT FOR THIS QUEUED WRITE, not permanent for
 * all time — a distinction this comment originally got wrong by claiming
 * every one of them "gets a byte-identical refusal forever". That is plainly
 * false for 401: the scorer signs in again and the very same request would
 * succeed. It is the reasoning that was wrong, not the classification, and
 * the real argument is the one this whole file exists for.
 *
 * Leaving 401 retryable would put the tap back in a DURABLE queue behind a
 * pad reporting "offline" — the network is fine, the session is not — and the
 * pad would go on showing the action as landed for as long as the scorer
 * stayed signed out. That is precisely the failure this fix was written to
 * kill, reintroduced through the door marked "kinder". One tap refused
 * VISIBLY beats an hour of taps claimed silently.
 *
 * What makes that trade honest is the copy, which is load-bearing and must
 * stay so: `refusal-copy.ts` maps UNAUTHENTICATED to
 * `scorepad.refusal.signedOut` — "Not recorded — your session has ended. Sign
 * in again, then retake it." It states the write did NOT happen, why, and the
 * two things to do about it. If that key is ever softened into something that
 * does not say "not recorded" and does not say "retake it", this
 * classification stops being defensible and 401 should move to
 * RETRYABLE_CLIENT_STATUS instead.
 *
 * The old comment here argued that guessing "permanent" for an unrecognised
 * status "risks silently losing a scorer's action". That reasoning survives
 * intact for everything it was really about — 5xx, a thrown fetch, a
 * malformed body, and the two retry-after statuses above all stay transient.
 * What it got wrong was the 4xx client-error class, where retrying forever
 * does not protect the action; it only hides the refusal behind a pad that
 * keeps claiming the action landed.
 */
export function isPermanentRefusal(status: number): boolean {
  if (status === 409) return false; // renegotiable — the conflict path owns it
  if (RETRYABLE_CLIENT_STATUS.has(status)) return false;
  return status >= 400 && status < 500;
}

function makeTransport(auth: PadAuthMode, init: TransportInit = {}): PadTransport {
  const doFetch = init.fetchFn ?? fetch;
  const headers = { "Content-Type": "application/json", ...authHeadersFor(auth) };

  return {
    async appendEvent(fixtureId: string, body: AppendEventBody): Promise<AppendCallResult> {
      let res: Response;
      try {
        res = await doFetch(`/api/v1/fixtures/${fixtureId}/events`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        });
      } catch (err) {
        return { kind: "network-error", message: messageOf(err) };
      }
      const { body: envelope, fromOurApi } = await parseEnvelope<AppendSuccess>(res);
      if (res.ok && envelope.ok && envelope.data !== undefined) {
        return { kind: "ok", data: appendSuccessOf(envelope.data) };
      }
      const message = envelope.error?.message ?? `request failed (${res.status})`;
      // 409 splits two ways, on its CODE rather than its status. A stale
      // expected_seq is RENEGOTIABLE and belongs to the pipeline's replay
      // ruling. A terminal undo refusal is not — see TERMINAL_CONFLICT_CODES.
      if (res.status === 409) {
        const code = envelope.error?.code;
        if (code !== undefined && TERMINAL_CONFLICT_CODES.has(code)) {
          // The next-match refusal names the match to void first; carried only
          // when well-formed, so the copy never renders a sentence with a hole.
          const nextMatch = nextMatchRefOf(envelope.error);
          return nextMatch ? { kind: "rejected", code, message, nextMatch } : { kind: "rejected", code, message };
        }
        const currentSeq = typeof envelope.error?.current_seq === "number" ? envelope.error.current_seq : null;
        return { kind: "conflict", currentSeq, message };
      }
      // 429 stays RETRYABLE (the queue keeps the tap — `isPermanentRefusal`
      // is unchanged and still answers false for it), but it is reported for
      // what it is. Filed as `network-error` it reached the pad as "Offline",
      // which is a lie the scorer cannot act on.
      // W1 (2026-09-22) — a 403 whose body is NOT our envelope did not come
      // from our server at all. It is an edge challenge: verified live on the
      // `seazn.club` zone (`security_level: "medium"`, `browser_check: "on"`,
      // and NO WAF custom ruleset, so nothing skips `/api/`). Cloudflare's own
      // docs: a challenge "interrupts the request flow by returning a full
      // HTML page … This mechanism fails when the browser expects a non-HTML
      // response, such as an AJAX or XHR (fetch) request." A venue behind
      // carrier-grade NAT with a poor IP reputation is the realistic trigger.
      //
      // This does NOT contradict `isPermanentRefusal`'s argument below; it
      // falls outside it. That comment reasons about OUR refusals — "one tap
      // refused VISIBLY beats an hour of taps claimed silently" — and stays
      // true for every one of them, which is why a 403 that DOES carry our
      // envelope still lands in the permanent class one line down. An
      // intermediary's challenge is not a refusal by our server; the write was
      // never seen, and discarding the scorer's tap over it is the same class
      // of silent loss the rest of this file exists to stop.
      //
      // Narrow ON PURPOSE — 403 only. See the file's test suite: 401 and 402
      // with the identical unparseable body stay permanent.
      if (res.status === 403 && !fromOurApi) {
        return { kind: "network-error", message };
      }
      if (res.status === 429) {
        return { kind: "throttled", message, retryAfterMs: retryAfterMsOf(res) };
      }
      if (isPermanentRefusal(res.status)) {
        return { kind: "rejected", code: envelope.error?.code ?? "UNKNOWN", message };
      }
      return { kind: "network-error", message };
    },

    async listEventsSince(fixtureId: string, sinceSeq: number): Promise<LedgerSlotEvent[]> {
      const res = await doFetch(`/api/v1/fixtures/${fixtureId}/events?since_seq=${sinceSeq}`, { headers });
      const data = await readV1Envelope<unknown>(res);
      return ledgerSlotEventsSchema.parse(data);
    },

    async getLastSeq(fixtureId: string): Promise<number> {
      const res = await doFetch(`/api/v1/fixtures/${fixtureId}/state`, { headers });
      const state = await readV1Envelope<FixtureStateResult>(res);
      return state.last_seq;
    },

    async fetchState(fixtureId: string): Promise<FixtureStateResult> {
      const res = await doFetch(`/api/v1/fixtures/${fixtureId}/state`, { headers });
      return readV1Envelope<FixtureStateResult>(res);
    },
  };
}

export function sessionTransport(init?: TransportInit): PadTransport {
  return makeTransport({ kind: "session" }, init);
}

export function deviceLinkTransport(token: string, init?: TransportInit): PadTransport {
  return makeTransport({ kind: "device_link", token }, init);
}
