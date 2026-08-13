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
// Deliberately narrower than the server's real EventOut (extra columns like
// `id`/`recorded_at`/`voids_event_id` are validated-then-dropped) — matching
// LedgerSlotEvent's own documented scope (types.ts).
const ledgerSlotEventSchema = z.object({
  seq: z.number(),
  type: z.string(),
  payload: z.unknown(),
  recorded_by: z
    .string()
    .nullish()
    .transform((v) => v ?? null),
  device_link_id: z
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
      // 409/422 are the two typed, PERMANENT-vs-RENEGOTIABLE outcomes the
      // pipeline's replay ruling distinguishes; every other status (5xx,
      // 429, a malformed body) is treated as transient by design — see
      // AppendCallResult's own JSDoc in pipeline.ts.
      if (res.status === 409) {
        const currentSeq = typeof envelope.error?.current_seq === "number" ? envelope.error.current_seq : null;
        return { kind: "conflict", currentSeq, message };
      }
      if (res.status === 422) {
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
