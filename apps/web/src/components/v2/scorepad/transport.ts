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

async function parseEnvelope<T>(res: Response): Promise<V1Envelope<T>> {
  try {
    return (await res.json()) as V1Envelope<T>;
  } catch {
    return { ok: false, error: { code: "UNKNOWN", message: `request failed (${res.status})` } };
  }
}

/** Shared by every GET this file makes: throws on any failure (a thrown
 *  fetch OR a non-2xx/`ok:false` response) rather than returning a sentinel
 *  — matching `ScoringTransport.listEventsSince`/`getLastSeq`'s own
 *  documented contract ("May reject; sendOne treats a rejection the same as
 *  ... unavailable", pipeline.ts). */
export async function readV1Envelope<T>(res: Response): Promise<T> {
  const body = await parseEnvelope<T>(res);
  if (!res.ok || body.ok === false || body.data === undefined) {
    throw new Error(body.error?.message ?? `request failed (${res.status})`);
  }
  return body.data;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : "network request failed";
}

/**
 * The two 4xx statuses that genuinely invite the SAME request again — 408 is
 * "you took too long, try again" and 429 is "slow down and try again". Both
 * are transient by the server's own definition, which is exactly what the
 * offline queue exists to ride out.
 */
const RETRYABLE_CLIENT_STATUS: ReadonlySet<number> = new Set([408, 429]);

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
      const envelope = await parseEnvelope<AppendSuccess>(res);
      if (res.ok && envelope.ok && envelope.data !== undefined) {
        return { kind: "ok", data: envelope.data };
      }
      const message = envelope.error?.message ?? `request failed (${res.status})`;
      // 409 is the one RENEGOTIABLE outcome the pipeline's replay ruling
      // distinguishes: the write is fine, its expected_seq is stale.
      if (res.status === 409) {
        const currentSeq = typeof envelope.error?.current_seq === "number" ? envelope.error.current_seq : null;
        return { kind: "conflict", currentSeq, message };
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
