// B07a Task 10 fix round 2 — R64: a pack claim describes the STREAM's end state.
//
// A special's `state` claim was read off `GET /fixtures/{id}/state`, which is
// `match_states` at the LAST row. On a tapped fixture that last row is the
// `core.finalize` the tap path appends as the organiser's sign-off — not a pack
// event — and generic's finalize moves `phase` "done" -> "final"
// (`packages/engine/src/sports/generic/generic.ts` finalize branch). The pack's
// `{on: "state", path: "phase", equals: "done"}` then redded on a correct match
// (live run 2, F3).
//
// So for a fixture the tap path signed off, the state a claim is judged against
// is folded from the PRODUCT's own ledger rows through the last pack event —
// every row except the trailing sign-off — with the product's own saved team
// sheets, by the same engine `foldMatch` the product's read path calls
// (`engine-db/fold.ts#foldFrom`, no fold options). Phase equality stays exact.
// The state route has no "as of seq" read, so folding is the only way to see
// the state at that row; the finalized oracle proves the sign-off separately.
import { foldMatch, type EventEnvelope, type Lineup, type LineupPair, type LineupSlot } from "@seazn/engine/core";
import type { AnySportModule } from "@seazn/engine/sport";
import type { Session } from "./http.ts";
import type { LedgerRow } from "./ledger.ts";
import { defaultOracleTransport, fetchFixtureLineup, type OracleTransport } from "./oracle.ts";
import { OFFLINE_RECORDED_AT } from "./validate-pack.ts";

/** Rows the tap path appends AFTER a stream: the organiser's sign-off. */
export const BENCH_SIGN_OFF_TYPES: ReadonlySet<string> = new Set(["core.finalize"]);

/** One stored slot as `usecases/fixtures.ts#readLineup` serves it. */
export interface StoredSheetSlot {
  readonly person_id: string;
  readonly slot?: string;
  readonly order_no?: number | null;
  readonly position_key?: string | null;
  readonly roles?: readonly string[] | null;
  readonly role?: string | null;
  readonly squad_number?: number | null;
}

/** A ledger row carrying what the product's fold envelope reads. */
export interface FoldRow extends LedgerRow {
  readonly recordedAt?: string;
  readonly recordedBy?: string | null;
  readonly voids?: string;
}

/** The rows a pack claim describes: everything but a trailing run of sign-off
 *  rows. A pack that itself declares a sign-off keeps every row. The cut is by
 *  row TYPE at the tail, never by pack length, so a lost or extra pack event
 *  cannot move it onto a scoring row. */
export function rowsThroughPackEvents<R extends LedgerRow>(
  rows: readonly R[],
  packEventTypes: readonly string[],
): { readonly rows: readonly R[]; readonly signOffRows: number } {
  if (packEventTypes.some((type) => BENCH_SIGN_OFF_TYPES.has(type))) return { rows, signOffRows: 0 };
  let end = rows.length;
  while (end > 0 && BENCH_SIGN_OFF_TYPES.has(rows[end - 1].type)) end -= 1;
  return { rows: rows.slice(0, end), signOffRows: rows.length - end };
}

/** `engine-db/lineups.ts#buildLineup`, mirrored field for field. */
function lineupOf(entrantId: string, slots: readonly StoredSheetSlot[]): Lineup {
  return {
    entrantId,
    slots: slots.map((r, i) => ({
      personId: r.person_id,
      slot: (r.slot ?? "starting") as LineupSlot["slot"],
      orderNo: r.order_no ?? i + 1,
      ...(r.position_key ? { positionKey: r.position_key } : {}),
      ...(r.roles && r.roles.length > 0 ? { roles: [...r.roles] } : {}),
      ...(r.role != null && r.role !== "player" ? { role: r.role as NonNullable<LineupSlot["role"]> } : {}),
      ...(r.squad_number != null ? { squadNumber: r.squad_number } : {}),
    })),
  };
}

export function lineupPairFromSheets(
  homeEntrantId: string,
  homeSlots: readonly StoredSheetSlot[],
  awayEntrantId: string,
  awaySlots: readonly StoredSheetSlot[],
): LineupPair {
  return { home: lineupOf(homeEntrantId, homeSlots), away: lineupOf(awayEntrantId, awaySlots) };
}

/** The product's read-path fold (`engine-db/fold.ts` envelope mapping). */
export function foldRows(
  module: AnySportModule,
  cfg: unknown,
  lineups: LineupPair,
  fixtureId: string,
  rows: readonly FoldRow[],
): unknown {
  const envelopes: EventEnvelope[] = rows.map((r) => ({
    id: r.id,
    fixtureId,
    seq: r.seq,
    type: r.type,
    payload: r.payload,
    recordedAt: r.recordedAt ?? OFFLINE_RECORDED_AT,
    recordedBy: r.recordedBy ?? null,
    ...(r.voids === undefined ? {} : { voids: r.voids }),
  }));
  return foldMatch(module, cfg, lineups, envelopes);
}

function foldRowsOf(data: unknown, path: string): FoldRow[] {
  if (!Array.isArray(data)) throw new Error(`special state: ${path} was not a list of rows (got ${typeof data})`);
  const rows: FoldRow[] = data.map((item: unknown) => {
    const r = (item ?? {}) as Record<string, unknown>;
    if (typeof r.id !== "string" || typeof r.seq !== "number" || typeof r.type !== "string") {
      throw new Error(`special state: ${path} carried a row without an id, seq and type`);
    }
    return {
      id: r.id,
      seq: r.seq,
      type: r.type,
      payload: r.payload,
      ...(typeof r.recorded_at === "string" ? { recordedAt: r.recorded_at } : {}),
      ...(typeof r.recorded_by === "string" ? { recordedBy: r.recorded_by } : {}),
      ...(typeof r.voids_event_id === "string" ? { voids: r.voids_event_id } : {}),
    };
  });
  return rows.sort((a, b) => a.seq - b.seq);
}

export interface SpecialStateInput {
  readonly base: string;
  readonly session: Session;
  readonly fixtureId: string;
  readonly homeEntrantId: string;
  readonly awayEntrantId: string;
  readonly packEventTypes: readonly string[];
  readonly module: AnySportModule;
  readonly cfg: unknown;
  readonly transport?: OracleTransport | undefined;
}

/** Throws on any refused read or failed fold — the caller reports it and the
 *  claims read `(absent)`. It never falls back to the post-sign-off state. */
export async function specialStateThroughPackEvents(
  input: SpecialStateInput,
): Promise<{ readonly state: unknown; readonly signOffRows: number }> {
  const t = input.transport ?? defaultOracleTransport;
  const path = `/api/v1/fixtures/${input.fixtureId}/events?since_seq=0`;
  const result = await t.raw(input.base, input.session, path, "GET");
  if (result.status !== 200) {
    throw new Error(`special state: the ledger read ${path} answered HTTP ${result.status}`);
  }
  const all = foldRowsOf((result.json as unknown as { data?: unknown } | null)?.data, path);
  const cut = rowsThroughPackEvents(all, input.packEventTypes);
  const [home, away] = await Promise.all([
    fetchFixtureLineup(input.base, input.session, input.fixtureId, input.homeEntrantId, t),
    fetchFixtureLineup(input.base, input.session, input.fixtureId, input.awayEntrantId, t),
  ]);
  // `LineupWire` types only `person_id`/`full_name`; the route serves the whole
  // stored slot (`readLineup`), and every other field the fold reads is
  // optional on `StoredSheetSlot`, so a thinner sheet still folds.
  const lineups = lineupPairFromSheets(input.homeEntrantId, home.slots, input.awayEntrantId, away.slots);
  return { state: foldRows(input.module, input.cfg, lineups, input.fixtureId, cut.rows), signOffRows: cut.signOffRows };
}
