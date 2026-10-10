// W2b loop F (Tasks 7–9) — the shared DB rig: read a stage's fixture rows, append at a fixture's own tip through
// `scoreEvent` (the console's write), and play a badminton line out to a real result. Real Postgres; callers skip
// without DATABASE_URL. The W2a probe file (`server/__tests__/w2b-repro.probe.test.ts`) uses the same shapes.
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { scoreEvent } from "@/server/usecases/scoring";

export interface FixtureRow {
  id: string;
  ext_key: string | null;
  round_no: number;
  seq_in_round: number;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  home_slot_label: { key?: string; params?: Record<string, unknown> } | null;
  away_slot_label: { key?: string; params?: Record<string, unknown> } | null;
  status: string;
  outcome: { kind?: string; winner?: string; loser?: string | null; reason?: string; method?: string } | null;
  winner_to_fixture: string | null;
  winner_to_slot: number | null;
  loser_to_fixture: string | null;
  loser_to_slot: number | null;
}

export const rowsOf = (stageId: string) =>
  sql<FixtureRow[]>`
    select id, ext_key, round_no, seq_in_round, home_entrant_id, away_entrant_id, home_slot_label, away_slot_label,
           status, outcome, winner_to_fixture, winner_to_slot, loser_to_fixture, loser_to_slot
      from fixtures where stage_id = ${stageId} order by round_no, seq_in_round`;

export async function fixtureRow(id: string): Promise<FixtureRow> {
  const [r] = await sql<FixtureRow[]>`
    select id, ext_key, round_no, seq_in_round, home_entrant_id, away_entrant_id, home_slot_label, away_slot_label,
           status, outcome, winner_to_fixture, winner_to_slot, loser_to_fixture, loser_to_slot
      from fixtures where id = ${id}`;
  if (!r) throw new Error(`no fixture ${id}`);
  return r;
}

export const tip = async (id: string) =>
  (await sql<{ s: number }[]>`select coalesce(max(seq), 0)::int as s from score_events where fixture_id = ${id}`)[0]!.s;

/** Append at the fixture's own tip — the console's write, through `scoreEvent`. */
export async function post(auth: AuthCtx, id: string, type: string, payload: unknown = {}) {
  return scoreEvent(auth, id, { expected_seq: await tip(id), type, payload } as never);
}

/** A feed edge names seat 1 or 2; anything else is a broken graph, not "no seat". */
export function seatOf(r: FixtureRow, slot: number | null): string | null {
  if (slot === 1) return r.home_entrant_id;
  if (slot === 2) return r.away_entrant_id;
  throw new Error(`fixture ${r.id}: a feed edge names slot ${slot}`);
}
export function labelOf(r: FixtureRow, slot: number | null): string | null {
  if (slot === 1) return r.home_slot_label?.key ?? null;
  if (slot === 2) return r.away_slot_label?.key ?? null;
  throw new Error(`fixture ${r.id}: a feed edge names slot ${slot}`);
}

/** A badminton line played to a straight-games win (bwf: best of three to 21). */
export async function playBadminton(auth: AuthCtx, id: string, homeWins: boolean): Promise<FixtureRow> {
  await post(auth, id, "core.start");
  for (let g = 0; g < 2; g++) await post(auth, id, "badminton.game.summary", homeWins ? { home: 21, away: 10 } : { home: 10, away: 21 });
  const r = await fixtureRow(id);
  if (r.status !== "decided") throw new Error(`rig: ${r.ext_key} did not decide (${r.status})`);
  return r;
}

/** Football 0-0 at full time: a play-produced level result, which a bracket HOLDS (needs_decision, X-BR-2). */
export async function heldFootball(auth: AuthCtx, id: string): Promise<FixtureRow> {
  await post(auth, id, "core.start");
  await post(auth, id, "football.period", { phase: "HT" });
  await post(auth, id, "football.period", { phase: "FT" });
  const r = await fixtureRow(id);
  if (r.status !== "needs_decision" || r.outcome?.kind !== "draw") throw new Error(`rig: ${r.ext_key} is not held (${r.status})`);
  return r;
}

/** The sibling of `src`: the other line feeding the same fixture through the same edge kind. */
export function siblingOf(rows: readonly FixtureRow[], src: FixtureRow): FixtureRow {
  const sib = rows.find((r) => r.id !== src.id && r.winner_to_fixture !== null && r.winner_to_fixture === src.winner_to_fixture);
  if (!sib) throw new Error(`rig: ${src.ext_key} has no sibling feeding ${src.winner_to_fixture}`);
  return sib;
}

export const nameOf = async (id: string | null | undefined) =>
  id == null ? null : ((await sql<{ n: string }[]>`select display_name as n from entrants where id = ${id}`)[0]?.n ?? id);

export const liveEvents = async (fixtureId: string) =>
  (
    await sql<{ n: number }[]>`
      select count(*)::int as n from score_events e
       where e.fixture_id = ${fixtureId} and e.type <> 'core.void'
         and not exists (select 1 from score_events v where v.fixture_id = e.fixture_id and v.voids_event_id = e.id)`
  )[0]!.n;
