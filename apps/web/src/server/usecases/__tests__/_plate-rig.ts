// W4 app PR B, Task 8: the rig the plate suites share (plate-first-loss.test.ts, plate-first-loss-sweep.test.ts). A Knockout + Plate
// division of `n` entrants, started, and the scorer's own events to play a main-draw line to a win. Football (a team sport whose
// win is two events and a period close) - one sport per file with this reason: the plate's field reads the main stage's lines,
// never a sport field; the sweep file carries the second sport (badminton) through `playBadminton`.
import { randomUUID } from "node:crypto";
import { builtinModules } from "@seazn/engine/sports";
import { entrantKindCap } from "@seazn/engine/sport";
import { sql } from "@/lib/db";
import { buildTemplateStages } from "@/lib/format-templates";
import type { AuthCtx } from "@/server/api-v1/auth";
import { CreateStage, type EntrantKind } from "@/server/api-v1/schemas";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { scoreEvent } from "../scoring";
import { startDivision } from "../schedule";
import { createStages } from "../stages";
import { seedOrg } from "./_seed";

const cricketModule = builtinModules.find((m) => m.key === "cricket")!;

type Kind = (typeof EntrantKind.options)[number];

export const KNOBS = { qualified: 4, swissRounds: 3, poolCount: 2, legs: 1 };

export interface PlateRig {
  auth: AuthCtx;
  competitionId: string;
  divisionId: string;
  mainId: string;
  plateId: string;
  sport: { key: string; variant: string };
  kind: Kind;
  /** Entrant ids by creation order (P1..Pn); `seedOf` is each one's `entrants.seed`. */
  entrants: string[];
  seedOf: Map<string, number | null>;
}

export interface LineRow {
  id: string;
  stage_id: string;
  round_no: number;
  seq_in_round: number;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  status: string;
  outcome: { kind?: string; reason?: string; winner?: string } | null;
}

const seatsOf = (kind: Kind): number => Math.min(2, entrantKindCap(kind));

export function entrantInput(kind: Kind, name: string, seed?: number) {
  return {
    kind,
    display_name: name,
    ...(seed !== undefined ? { seed } : {}),
    members: Array.from({ length: seatsOf(kind) }, (_, i) => ({
      new_person: { full_name: `${name} m${i + 1} ${randomUUID().slice(0, 4)}` },
      is_captain: false,
      roles: [],
    })),
  };
}

/** A sport this rig can score, with the entrant kind its engine module DECLARES as its natural one (`entrantModel.defaultKind`). */
function sportPick(key: string): { sport: { key: string; variant: string }; kind: Kind } {
  const m = builtinModules.find((x) => x.key === key);
  if (m === undefined) throw new Error(`no sport module ${key}`);
  return { sport: { key, variant: Object.keys(m.variants)[0]! }, kind: (m.entrantModel?.defaultKind ?? "individual") as Kind };
}
export const FOOTBALL_PICK = sportPick("football");
export const BADMINTON_PICK = sportPick("badminton");
export const CRICKET_PICK = sportPick("cricket");
export const FOOTBALL = FOOTBALL_PICK.sport;
export const FOOTBALL_KIND: Kind = FOOTBALL_PICK.kind;

/** A division running `ko_plate`, started. `seeded`: how many of the `n` entrants carry a seed (the first `seeded`, 1..); the rest are
 *  unseeded, so the main draw shuffles them (RB4-D3). `autoProgress` is the division's flag, set explicitly - never the default. */
export async function plateRig(n: number, opts: { seeded?: number; autoProgress?: boolean; sport?: { key: string; variant: string }; kind?: Kind; template?: string } = {}): Promise<PlateRig> {
  const sport = opts.sport ?? FOOTBALL;
  const kind = opts.kind ?? FOOTBALL_KIND;
  const seeded = opts.seeded ?? n;
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "Plate " + randomUUID().slice(0, 6), visibility: "private", branding: {} });
  const division = await createDivision(auth, comp.id, {
    name: "Open",
    slug: "open-" + randomUUID().slice(0, 6),
    sport_key: sport.key,
    variant_key: sport.variant,
    config: {},
  });
  const made = await createEntrants(
    auth,
    division.id,
    Array.from({ length: n }, (_, i) => entrantInput(kind, `P${i + 1}`, i < seeded ? i + 1 : undefined)),
  );
  const ids: string[] = [];
  for (const [i, d] of buildTemplateStages(opts.template ?? "ko_plate", KNOBS).entries()) {
    const [stage] = await createStages(auth, division.id, CreateStage.parse({ seq: i + 1, kind: d.kind, name: d.name, config: d.config, progression: d.progression }));
    ids.push(stage!.id);
  }
  await sql`update divisions set auto_progress = ${opts.autoProgress === true} where id = ${division.id}`;
  await startDivision(auth, division.id);
  const rows = await sql<{ id: string; seed: number | null }[]>`select id, seed from entrants where division_id = ${division.id}`;
  return {
    auth,
    competitionId: comp.id,
    divisionId: division.id,
    mainId: ids[0]!,
    plateId: ids[1]!,
    sport,
    kind,
    entrants: made.map((e) => e.id),
    seedOf: new Map(rows.map((r) => [r.id, r.seed] as const)),
  };
}

export const linesOf = (stageId: string) =>
  sql<LineRow[]>`
    select id, stage_id, round_no, seq_in_round, home_entrant_id, away_entrant_id, status, outcome
      from fixtures where stage_id = ${stageId} order by round_no, seq_in_round, id`;

async function post(auth: AuthCtx, fixtureId: string, type: string, payload: Record<string, unknown> = {}): Promise<void> {
  const [{ n }] = await sql<{ n: number }[]>`select coalesce(max(seq), 0)::int as n from score_events where fixture_id = ${fixtureId}`;
  await scoreEvent(auth, fixtureId, { expected_seq: n, type, payload });
}

/** A PLAYED win for `winner` on `f`, through the scorer's own events - each sport's vocabulary (football: Start, a goal by the winner,
 *  then HT and FT; badminton: Start, then two game summaries the winner's side takes). */
export async function win(rig: Pick<PlateRig, "auth" | "sport">, f: Pick<LineRow, "id" | "home_entrant_id">, winner: string): Promise<void> {
  await post(rig.auth, f.id, "core.start");
  if (rig.sport.key === "badminton") {
    const home = winner === f.home_entrant_id;
    for (let g = 0; g < 2; g++) await post(rig.auth, f.id, "badminton.game.summary", home ? { home: 21, away: 10 } : { home: 10, away: 21 });
    return;
  }
  if (rig.sport.key === "cricket") {
    // T20: the home side bats first. A full quota each; the side with more runs wins (see below).
    const balls = (cricketModule.configSchema.parse(cricketModule.variants[rig.sport.variant]) as { ballsPerInnings: number }).ballsPerInnings;
    const home = winner === f.home_entrant_id;
    // Home wins: 150 then a chase of 100 falls short. Away wins: 100 then a chase that ends at the winning run (101) inside its quota.
    await post(rig.auth, f.id, "cricket.innings.summary", { runs: home ? 150 : 100, wickets: 5, legalBalls: balls });
    await post(rig.auth, f.id, "cricket.innings.summary", home ? { runs: 100, wickets: 6, legalBalls: balls } : { runs: 101, wickets: 3, legalBalls: balls - 6 });
    return;
  }
  if (rig.sport.key !== "football") throw new Error(`the plate rig scores football, badminton and cricket, not ${rig.sport.key}`);
  await post(rig.auth, f.id, "football.goal", { by: winner });
  await post(rig.auth, f.id, "football.period", { phase: "HT" });
  await post(rig.auth, f.id, "football.period", { phase: "FT" });
}

/** Take a line's decision back: every live event, newest first, as a scorer's Undo does. */
export async function undecide(rig: Pick<PlateRig, "auth">, fixtureId: string): Promise<void> {
  const live = await sql<{ id: string }[]>`
    select e.id from score_events e
     where e.fixture_id = ${fixtureId} and e.type <> 'core.void'
       and not exists (select 1 from score_events v where v.fixture_id = e.fixture_id and v.voids_event_id = e.id)
     order by e.seq desc`;
  if (live.length === 0) throw new Error("undecide: the line holds no live event to take back");
  for (const e of live) await post(rig.auth, fixtureId, "core.void", { event_id: e.id });
}

/** Every PLAYABLE line of `round` of the main stage (both seats named, no outcome yet) won by `pick(home, away)` - the better seed
 *  by default (a lower `seed` wins; an unseeded entrant loses to a seeded one, two unseeded: home). Answers the lines played. */
export async function playRound(rig: PlateRig, round: number, pick?: (home: string, away: string) => string, stageId: string = rig.mainId): Promise<LineRow[]> {
  const rows = (await linesOf(stageId)).filter((r) => r.round_no === round && r.home_entrant_id !== null && r.away_entrant_id !== null && r.outcome === null);
  const seed = (id: string) => rig.seedOf.get(id) ?? Number.POSITIVE_INFINITY;
  const better = (h: string, a: string) => (seed(a) < seed(h) ? a : h);
  for (const f of rows) await win(rig, f, (pick ?? better)(f.home_entrant_id!, f.away_entrant_id!));
  return rows;
}

/** The entrants any plate line seats. */
export async function plateSeats(rig: Pick<PlateRig, "plateId">): Promise<string[]> {
  const rows = await linesOf(rig.plateId);
  return [...new Set(rows.flatMap((r) => [r.home_entrant_id, r.away_entrant_id].filter((x): x is string => x !== null)))].sort();
}
