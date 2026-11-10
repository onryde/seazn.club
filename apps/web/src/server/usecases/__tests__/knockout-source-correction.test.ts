// W4 app-A Task 14 (FX-G16, FX-G18; rule X-QM-4; rulebook RB4-Q5, signed S3): a correction inside a COMPLETED knockout
// source. Before the destination starts, the proposal goes stale — draft or confirmed — the seats it filled go back to TBD
// with their labels, and a re-proposal seats the new qualifier. After it starts, the bracket stands and the desk warns.
//
// Driven through the real doors on a real database: the catalogue's own templates, the scorer (`scoreEvent`, whose
// `onDecided` hook is the seam under test), Complete, propose and confirm. A decided line whose next match was played refuses
// a void (409 NEXT_MATCH_STARTED, owner ruling 2026-09-23), so a corrected quarter-final is what an organiser really does:
// unwind from the final backwards, re-record the quarter-final the other way, then play forward.
//
// Expected values: the rulebook's bracket read by hand off the results (a semi-final loser ranks by seed, RB4-Q1 / S7). The
// labels the un-fill restores: the row as the generator wrote it, read BEFORE the confirm. Never the code under test.
//
// Sports: the corrected-qualifier sequence sweeps badminton singles and chess; the rest run on badminton singles — they read
// seats and proposals, which no sport field reaches.
import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { builtinModules } from "@seazn/engine/sports";
import { cricket } from "@seazn/engine/sports/cricket";
import { sql, withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { buildTemplateStages } from "@/lib/format-templates";
import type { AuthCtx } from "@/server/api-v1/auth";
import { CreateStage } from "@/server/api-v1/schemas";
import { scriptLedger, type Delivery } from "@/server/public-site/__tests__/cricket-ledger";
import { appendEvent } from "@/server/engine-db";
import { refreshCompletedBracketPlacement } from "@/server/engine-db/competition";
import { unfillProposalSeats } from "@/server/engine-db/fed-seats";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { getKnockoutCutDrift } from "../knockout-cut-drift";
import { callFixtureToCourt } from "../match-day-call";
import { startDivision } from "../schedule";
import { onDecided, scoreEvent } from "../scoring";
import {
  completeStage,
  computeSeedProposal,
  confirmSeedProposal,
  createStages,
  generateStageFixtures,
  getSeedProposal,
} from "../stages";
import { createCourt, createVenue } from "../venues";
import { withdrawEntrantCascade } from "../withdrawal";
import { confirmResolvingTies } from "./_confirm-with-ties";
import { seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

interface SportPick {
  key: string;
  variant: string;
  kind: "individual" | "pair";
}
function sport(key: string): SportPick {
  const m = builtinModules.find((x) => x.key === key);
  if (m === undefined) throw new Error(`no engine module ${key}`);
  const variant = Object.keys(m.variants)[0];
  if (variant === undefined) throw new Error(`${key} declares no variant`);
  return { key, variant, kind: "individual" };
}
const SINGLES = sport("badminton");
const CHESS = sport("boardgame");

interface Row {
  id: string;
  round_no: number;
  seq_in_round: number;
  is_final: boolean;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  home_slot_label: unknown;
  away_slot_label: unknown;
  status: string;
  outcome: { kind?: string; reason?: string; winner?: string } | null;
}

interface Rig {
  auth: AuthCtx;
  sport: SportPick;
  divisionId: string;
  /** [source, destination]. */
  stageIds: [string, string];
  nameOf: Map<string, string>;
  idOf: Map<string, string>;
  /** The destination as the generator wrote it, before any confirm: the labels an un-fill must restore. */
  dayOne: Row[];
}

const rowsOf = (stageId: string) =>
  sql<Row[]>`
    select id, round_no, seq_in_round, is_final, home_entrant_id, away_entrant_id, home_slot_label, away_slot_label, status, outcome
      from fixtures where stage_id = ${stageId} order by round_no, seq_in_round, id`;

async function post(auth: AuthCtx, fixtureId: string, type: string, payload: Record<string, unknown> = {}): Promise<void> {
  const [{ n }] = await sql<{ n: number }[]>`select coalesce(max(seq), 0)::int as n from score_events where fixture_id = ${fixtureId}`;
  await scoreEvent(auth, fixtureId, { expected_seq: n, type, payload });
}

/** A played win for `winner` on `f`, by the scorer's own events (each sport's vocabulary), `from` a start. */
async function playWin(r: Rig, f: Row, winner: string, scores: readonly [number, number] = [21, 10]): Promise<void> {
  await post(r.auth, f.id, "core.start");
  if (r.sport.key === "boardgame") {
    await post(r.auth, f.id, "boardgame.result", { winner, method: "resign" });
    return;
  }
  const home = winner === f.home_entrant_id;
  for (let g = 0; g < 2; g++) {
    await post(r.auth, f.id, "badminton.game.summary", home ? { home: scores[0], away: scores[1] } : { home: scores[1], away: scores[0] });
  }
}

/** Take a line's decision back: every live event, newest first, as a scorer's Undo does. */
async function undecide(r: Rig, fixtureId: string): Promise<void> {
  const live = await sql<{ id: string }[]>`
    select e.id from score_events e
     where e.fixture_id = ${fixtureId} and e.type <> 'core.void'
       and not exists (select 1 from score_events v where v.fixture_id = e.fixture_id and v.voids_event_id = e.id)
     order by e.seq desc`;
  expect(live.length, "premise: the line holds live events to take back").toBeGreaterThan(0);
  for (const e of live) await post(r.auth, fixtureId, "core.void", { event_id: e.id });
}

async function rig(opts: { template: "qualifying_main" | "ko_plate" | "league_ko"; n?: number; q?: number; sport?: SportPick; storedCut?: number }): Promise<Rig> {
  const s = opts.sport ?? SINGLES;
  const n = opts.n ?? 8;
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "W4 T14 " + randomUUID().slice(0, 6), visibility: "private", branding: {} });
  const division = await createDivision(auth, comp.id, {
    name: "Open",
    slug: "open-" + randomUUID().slice(0, 6),
    sport_key: s.key,
    variant_key: s.variant,
    config: {},
  });
  const made = await createEntrants(
    auth,
    division.id,
    Array.from({ length: n }, (_, i) => ({ kind: s.kind, display_name: `E${i + 1}`, seed: i + 1, members: [] })),
  );
  const drafts = buildTemplateStages(opts.template, { swissRounds: 5, poolCount: 2, legs: 1, qualified: opts.q ?? 4 });
  expect(drafts[1]?.progression?.timing, "rig: the second stage is seeded by a confirm").toBe("setup");
  const ids: string[] = [];
  for (const [i, d] of drafts.entries()) {
    const [stage] = await createStages(
      auth,
      division.id,
      CreateStage.parse({ seq: i + 1, kind: d.kind, name: d.name, config: d.config, progression: d.progression }),
    );
    ids.push(stage!.id);
  }
  // A cut stored before X-QM-2 (T15): the save door refuses it now, the rows that hold one keep running.
  if (opts.storedCut !== undefined) {
    const stored = buildTemplateStages(opts.template, { swissRounds: 5, poolCount: 2, legs: 1, qualified: opts.storedCut })[1]!.progression!;
    await sql`update stages set progression = ${sql.json(stored as never)} where id = ${ids[1]!}`;
  }
  await startDivision(auth, division.id);
  await generateStageFixtures(auth, ids[1]!);
  return {
    auth,
    sport: s,
    divisionId: division.id,
    stageIds: [ids[0]!, ids[1]!],
    nameOf: new Map(made.map((e) => [e.id, e.display_name])),
    idOf: new Map(made.map((e) => [e.display_name, e.id])),
    dayOne: [...(await rowsOf(ids[1]!))],
  };
}

const num = (r: Rig, id: string) => Number(r.nameOf.get(id)!.slice(1));

/** Play every open line of the source, the lower number winning unless `winners` names the line's winner; complete it. */
async function playSource(r: Rig, winners: readonly string[] = []): Promise<void> {
  for (let guard = 0; guard < 40; guard++) {
    const open = (await rowsOf(r.stageIds[0])).filter((f) => f.home_entrant_id !== null && f.away_entrant_id !== null && f.status === "scheduled");
    if (open.length === 0) break;
    for (const f of open) {
      const [a, b] = [f.home_entrant_id!, f.away_entrant_id!];
      const named = [a, b].find((id) => winners.includes(r.nameOf.get(id)!));
      await playWin(r, f, named ?? (num(r, a) < num(r, b) ? a : b));
    }
  }
  const done = await completeStage(r.auth, r.stageIds[0]);
  expect(done.completed, "rig: the source completed").toBe(true);
}

async function confirmLatest(r: Rig): Promise<string> {
  const p = await getSeedProposal(r.auth, r.stageIds[1]);
  expect(p?.status, "rig: the newest proposal is a draft").toBe("draft");
  await confirmResolvingTies(r.auth, r.stageIds[1], p!.id);
  return p!.id;
}

/** The source's line in `round` that seats `name`. */
async function sourceLine(r: Rig, round: number, name: string): Promise<Row> {
  const id = r.idOf.get(name)!;
  const line = (await rowsOf(r.stageIds[0])).find((f) => f.round_no === round && (f.home_entrant_id === id || f.away_entrant_id === id));
  expect(line, `premise: ${name} is seated in round ${round} of the source`).toBeTruthy();
  return line!;
}

const finalOf = async (r: Rig) => {
  const final = (await rowsOf(r.stageIds[0])).find((f) => f.is_final);
  expect(final, "premise: the source has a final").toBeTruthy();
  return final!;
};

/** Each hook runs after that step's void, so a test can read the state an organiser sees mid-correction. */
interface UnwindHooks {
  afterFinal?: () => Promise<void>;
  afterSemi?: () => Promise<void>;
  afterQuarter?: () => Promise<void>;
}

/** Correct the eight-player source's quarter-final between `from` (who won it) and `to` (who should have): the final and
 *  `from`'s semi-final are unwound first, then replayed forward with the same favourite (the lower number) winning. */
async function correctQuarter(r: Rig, from: string, to: string, hooks: UnwindHooks = {}): Promise<void> {
  const final = await finalOf(r);
  const semi = await sourceLine(r, 2, from);
  const quarter = await sourceLine(r, 1, from);
  await undecide(r, final.id);
  await hooks.afterFinal?.();
  await undecide(r, semi.id);
  await hooks.afterSemi?.();
  await undecide(r, quarter.id);
  await hooks.afterQuarter?.();
  await replayForward(r, quarter.id, r.idOf.get(to)!, semi.id, final.id);
}

async function replayForward(r: Rig, quarterId: string, winner: string, semiId: string, finalId: string): Promise<void> {
  const reread = async (id: string) => (await rowsOf(r.stageIds[0])).find((f) => f.id === id)!;
  await playWin(r, await reread(quarterId), winner);
  for (const id of [semiId, finalId]) {
    const f = await reread(id);
    expect(f.home_entrant_id !== null && f.away_entrant_id !== null, "premise: the line is seated again").toBe(true);
    await playWin(r, f, num(r, f.home_entrant_id!) < num(r, f.away_entrant_id!) ? f.home_entrant_id! : f.away_entrant_id!);
  }
}

/** The destination's round 1, by name: "E1 v E4" (each line's names in number order), in line order. */
async function roundOne(r: Rig): Promise<string[]> {
  const name = (id: string | null) => (id === null ? "-" : r.nameOf.get(id)!);
  return (await rowsOf(r.stageIds[1]))
    .filter((f) => f.round_no === 1)
    .map((f) => [name(f.home_entrant_id), name(f.away_entrant_id)].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))).join(" v "));
}

const offered = async (r: Rig) => (await getSeedProposal(r.auth, r.stageIds[1]))!.computed.qualifiers.map((q) => r.nameOf.get(q.entrantId));

/** A proposal's own slate, by name, read from its row (a newer draft may be the one `offered` reads). */
const offeredOnSlate = async (proposalId: string, r: Rig) => {
  const [p] = await sql<{ computed: { qualifiers: { rank: number; entrantId: string }[] } }[]>`select computed from stage_seed_proposals where id = ${proposalId}`;
  return [...p!.computed.qualifiers].sort((a, b) => a.rank - b.rank).map((q) => r.nameOf.get(q.entrantId));
};

const statusOf = async (proposalId: string) => {
  const [p] = await sql<{ status: string }[]>`select status from stage_seed_proposals where id = ${proposalId}`;
  return p?.status;
};

/** The destination is back as the generator wrote it: every seat empty, every line scheduled, every label restored. */
async function expectDayOne(r: Rig): Promise<void> {
  const rows = await rowsOf(r.stageIds[1]);
  expect(rows.length, "anti-vacuity: the destination has lines").toBeGreaterThan(0);
  expect(rows.map((f) => [f.id, f.home_entrant_id, f.away_entrant_id, f.status, f.outcome, f.home_slot_label, f.away_slot_label]))
    .toEqual(r.dayOne.map((f) => [f.id, null, null, "scheduled", null, f.home_slot_label, f.away_slot_label]));
  const labelled = rows.flatMap((f) => [f.home_slot_label, f.away_slot_label]).filter((l) => l !== null);
  expect(labelled.length, "anti-vacuity: the draw's round 1 carries labels the un-fill has to restore").toBeGreaterThanOrEqual(4);
}

async function storedRanks(r: Rig): Promise<string[]> {
  const [snap] = await sql<{ rows: { entrantId: string; rank: number | null }[] }[]>`
    select rows from standings_snapshots where stage_id = ${r.stageIds[0]}`;
  return [...snap!.rows].sort((a, b) => a.rank! - b.rank!).map((row) => r.nameOf.get(row.entrantId)!);
}

async function refusal(p: Promise<unknown>): Promise<HttpError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err, "the call was expected to be refused").toBeInstanceOf(HttpError);
  return err as HttpError;
}

/** Start the destination's line that seats `name`: a Match Day call, the one start that writes no result. */
async function callLine(r: Rig, name: string): Promise<void> {
  const id = r.idOf.get(name)!;
  const line = (await rowsOf(r.stageIds[1])).find((f) => f.round_no === 1 && (f.home_entrant_id === id || f.away_entrant_id === id))!;
  const venue = await createVenue(r.auth, { name: "Hall " + randomUUID().slice(0, 4), sort: 0 });
  const court = (await createCourt(r.auth, venue.id, { name: "Court 1", sort: 0, tags: [] })).id;
  await sql`
    insert into schedule_settings (division_id, org_id, config)
    values (${r.divisionId}, ${r.auth.orgId}, ${sql.json({ courts: [court] } as never)})
    on conflict (division_id) do update set config = excluded.config`;
  await sql`update fixtures set scheduled_at = ${"2030-06-01T10:00:00.000Z"}, court_id = ${court}, venue_id = ${venue.id} where id = ${line.id}`;
  await callFixtureToCourt(r.auth, line.id, court);
}

// ---- the flip: cricket's fold can change a winner without passing through undecided (knockout-void-unfill.test.ts's recipe).
const CRICKET_PARTIAL = { ballsPerInnings: 6, ballsPerOver: 6, playersPerSide: 3, minOversForResult: 1 };

/** Four cricket teams, qualifying_main at q = 2: E1 v E4 and E2 v E3, the final's two players go through. */
async function cricketRig(): Promise<Rig & { xiOf: Map<string, string[]> }> {
  const { auth } = await seedOrg("pro");
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('cricket', 'Cricket', ${cricket.version}, ${sql.json(cricket.positions as never)})
    on conflict (key) do nothing`;
  await sql`
    insert into sport_variants (sport_key, key, name, config, is_system)
    values ('cricket', 't20', 'T20', ${sql.json(cricket.variants.t20 as never)}, true)
    on conflict do nothing`;
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "W4 flip " + randomUUID().slice(0, 6), visibility: "private", branding: {} });
  const division = await createDivision(auth, comp.id, { name: "T20", slug: "t20-" + randomUUID().slice(0, 6), sport_key: "cricket", variant_key: "t20", config: {} } as never);
  await sql`update divisions set config = ${sql.json(cricket.configSchema.parse(CRICKET_PARTIAL) as never)} where id = ${division.id}`;
  const squads: string[][] = [];
  for (const name of ["E1", "E2", "E3", "E4"]) {
    const xi: string[] = [];
    for (let i = 1; i <= 3; i++) {
      const [{ id }] = await sql<{ id: string }[]>`insert into persons (org_id, full_name) values (${auth.orgId}, ${`${name} ${i}`}) returning id`;
      xi.push(id);
    }
    squads.push(xi);
  }
  const made = await createEntrants(
    auth,
    division.id,
    ["E1", "E2", "E3", "E4"].map((display_name, i) => ({
      kind: "team",
      display_name,
      seed: i + 1,
      members: squads[i]!.map((person_id) => ({ person_id, squad_number: null, default_position_key: null, is_captain: false, roles: [] as string[] })),
    })) as never,
  );
  const ids: string[] = [];
  for (const [i, d] of buildTemplateStages("qualifying_main", { swissRounds: 5, poolCount: 2, legs: 1, qualified: 2 }).entries()) {
    const [stage] = await createStages(auth, division.id, CreateStage.parse({ seq: i + 1, kind: d.kind, name: d.name, config: d.config, progression: d.progression }));
    ids.push(stage!.id);
  }
  await startDivision(auth, division.id);
  await generateStageFixtures(auth, ids[1]!);
  return {
    auth,
    sport: { key: "cricket", variant: "t20", kind: "individual" },
    divisionId: division.id,
    stageIds: [ids[0]!, ids[1]!],
    nameOf: new Map(made.map((e) => [e.id, e.display_name])),
    idOf: new Map(made.map((e) => [e.display_name, e.id])),
    dayOne: [...(await rowsOf(ids[1]!))],
    xiOf: new Map(made.map((e, i) => [e.id, squads[i]!])),
  };
}

/** Home makes 6 off six balls; away chases 7 with a no-ball hit for four and 2 off the last ball, and wins. Void the no-ball and
 *  the same six balls make 2: the innings ends on the same delivery and home wins. Returns the no-ball's event id. */
async function chaseWonOnANoBall(auth: AuthCtx, line: Row, xiOf: Map<string, string[]>): Promise<string> {
  const home = xiOf.get(line.home_entrant_id!)!;
  const away = xiOf.get(line.away_entrant_id!)!;
  for (const [entrantId, xi] of [[line.home_entrant_id!, home], [line.away_entrant_id!, away]] as const) {
    for (const [i, personId] of xi.entries()) {
      await sql`
        insert into lineups (fixture_id, entrant_id, person_id, slot, position_key, order_no, roles, role)
        values (${line.id}, ${entrantId}, ${personId}, 'starting', null, ${i + 1}, ${sql.json([])}, 'player')`;
    }
  }
  const dots: Delivery[] = [{ bat: 0 }, { bat: 0 }, { bat: 0 }, { bat: 0 }, { bat: 0 }];
  const ledger = scriptLedger({
    cfg: CRICKET_PARTIAL,
    home,
    away,
    tossWonBy: "home",
    elected: "bat",
    innings: [
      { batting: "home", bowlers: [away[0]!], deliveries: [1, 1, 1, 1, 1, 1].map((bat) => ({ bat }) as Delivery) },
      { batting: "away", bowlers: [home[0]!], deliveries: [{ extra: "noball", runs: 1, bat: 4 }, ...dots, { bat: 2 }] },
    ],
  });
  const entrantOf = { home: line.home_entrant_id!, away: line.away_entrant_id! } as const;
  const events = ledger.events.map((ev) =>
    ev.type === "cricket.toss"
      ? { type: ev.type, payload: { ...(ev.payload as object), wonBy: entrantOf[(ev.payload as { wonBy: "home" | "away" }).wonBy] } }
      : { type: ev.type, payload: ev.payload },
  );
  let noBall: string | null = null;
  for (const [i, ev] of events.slice(0, -1).entries()) {
    const out = await appendEvent(auth.orgId, line.id, i, { type: ev.type, payload: ev.payload, recordedBy: null });
    if ((ev.payload as { runs?: { extras?: { kind?: string } } }).runs?.extras?.kind === "noball") noBall = out.event.id;
  }
  const last = events.at(-1)!;
  const decided = await scoreEvent(auth, line.id, { expected_seq: events.length - 1, type: last.type, payload: last.payload });
  expect(decided.outcome, "premise: the chase was won on the last ball").toMatchObject({ winner: line.away_entrant_id });
  expect(noBall, "premise: the script recorded a no-ball").not.toBeNull();
  return noBall!;
}

const names = (r: Rig, drift: { out: string[]; in: string[] } | null) =>
  drift === null ? null : { out: drift.out.map((id) => r.nameOf.get(id)), in: drift.in.map((id) => r.nameOf.get(id)) };

describe.runIf(HAS_DB)("W4 T14 a correction inside a completed knockout source (FX-G16, FX-G18)", () => {
  // qualifying_main of eight at q = 4, the favourite winning every line: the quarter-finals seat 1v8, 4v5, 3v6, 2v7; the
  // semi-finals E1 v E4 and E2 v E3; the final E1 v E2. Qualifiers E1..E4; the main draw E1 v E4, E2 v E3.
  // The correction: E5 won the quarter-final E4 was given. Then the semi-final is E1 v E5 (E1), the qualifiers E1, E2, E3
  // and E5 (semi-final losers rank by seed, RB4-Q1), and the main draw E1 v E5, E2 v E3.
  let swept = 0;
  for (const s of [SINGLES, CHESS]) {
    it(`X-QM-4 a corrected quarter-final before the main draw starts: the confirmed proposal goes stale and its seats empty [${s.key}]`, async () => {
      const r = await rig({ template: "qualifying_main", sport: s });
      await playSource(r);
      const confirmedId = await confirmLatest(r);
      expect(await roundOne(r), "premise: the confirmed main draw").toEqual(["E1 v E4", "E2 v E3"]);

      await correctQuarter(r, "E4", "E5", {
        afterFinal: async () => {
          expect(await statusOf(confirmedId), "the final's void moves nobody across the cut").toBe("confirmed");
          expect(await roundOne(r)).toEqual(["E1 v E4", "E2 v E3"]);
        },
        afterSemi: async () => {
          expect(await statusOf(confirmedId), "E4 and E1 both won a quarter-final: still the same four").toBe("confirmed");
          expect(await roundOne(r)).toEqual(["E1 v E4", "E2 v E3"]);
        },
        afterQuarter: async () => {
          // FX-G18: the void of the line that put E4 through takes her seat back at once.
          expect(await statusOf(confirmedId), "E4's result is gone: the proposal is stale").toBe("stale");
          await expectDayOne(r);
          expect((await getSeedProposal(r.auth, r.stageIds[1]))?.status, "nothing to re-propose yet: the source is undecided").toBe("stale");
        },
      });

      expect(await storedRanks(r), "the source's stored ranks moved with the correction").toEqual(["E1", "E2", "E3", "E5", "E4", "E6", "E7", "E8"]);
      expect((await getSeedProposal(r.auth, r.stageIds[1]))?.status, "the re-decided source re-proposed").toBe("draft");
      expect(await offered(r)).toEqual(["E1", "E2", "E3", "E5"]);
      await confirmLatest(r);
      expect(await roundOne(r), "the re-confirm seats the new qualifier").toEqual(["E1 v E5", "E2 v E3"]);

      // A second correction, back the other way: the first one left nothing behind that stops it.
      await correctQuarter(r, "E5", "E4");
      expect(await offered(r)).toEqual(["E1", "E2", "E3", "E4"]);
      await confirmLatest(r);
      expect(await roundOne(r)).toEqual(["E1 v E4", "E2 v E3"]);
      swept++;
    }, 600_000);
  }
  it("anti-vacuity: the corrected-qualifier sequence ran on two sports", () => {
    expect(swept).toBe(2);
  });

  it("X-QM-4 a draft goes stale too, and the old draft refuses a confirm", async () => {
    const r = await rig({ template: "qualifying_main" });
    await playSource(r);
    const draft = (await getSeedProposal(r.auth, r.stageIds[1]))!;
    expect(draft.status).toBe("draft");

    await correctQuarter(r, "E4", "E5", {
      afterFinal: async () => {
        expect(await statusOf(draft.id), "the same four are still proven").toBe("draft");
        expect((await refusal(confirmSeedProposal(r.auth, r.stageIds[1], { proposalId: draft.id }))).code, "an undecided source refuses a confirm").toBe(
          "SEEDING_SOURCE_INCOMPLETE",
        );
      },
      afterQuarter: async () => {
        expect(await statusOf(draft.id), "E4's result is gone").toBe("stale");
        expect((await refusal(computeSeedProposal(r.auth, r.stageIds[1]))).code, "a recompute waits for the source").toBe("SEEDING_SOURCE_INCOMPLETE");
      },
    });

    const fresh = (await getSeedProposal(r.auth, r.stageIds[1]))!;
    expect({ status: fresh.status, newRow: fresh.id !== draft.id }).toEqual({ status: "draft", newRow: true });
    expect(await offered(r)).toEqual(["E1", "E2", "E3", "E5"]);
    expect((await refusal(confirmSeedProposal(r.auth, r.stageIds[1], { proposalId: draft.id }))).code).toBe("SEEDING_PROPOSAL_STALE");
    await confirmLatest(r);
    expect(await roundOne(r)).toEqual(["E1 v E5", "E2 v E3"]);
  }, 600_000);

  it("X-QM-4 a draft re-proposes on a final flipped (the same four, a new order): its hash moved, so it is not left to refuse", async () => {
    const r = await rig({ template: "qualifying_main" });
    await playSource(r);
    const draft = (await getSeedProposal(r.auth, r.stageIds[1]))!;
    const final = await finalOf(r);
    await undecide(r, final.id);
    await playWin(r, (await rowsOf(r.stageIds[0])).find((f) => f.id === final.id)!, r.idOf.get("E2")!);
    expect(await statusOf(draft.id)).toBe("stale");
    expect(await offered(r), "E2 is the first qualifier now").toEqual(["E2", "E1", "E3", "E4"]);
    await confirmLatest(r);
    expect(await roundOne(r), "and the confirm is not refused (rank 1 v rank 4, rank 2 v rank 3)").toEqual(["E2 v E4", "E1 v E3"]);
  }, 600_000);

  it("X-QM-4 after the main draw starts, the bracket stands and the desk warns (the drift names the player)", async () => {
    const r = await rig({ template: "qualifying_main" });
    await playSource(r);
    const confirmedId = await confirmLatest(r);
    expect(await getKnockoutCutDrift(r.auth, r.stageIds[0]), "not started, nothing moved: no warning").toBeNull();

    const line = (await rowsOf(r.stageIds[1])).find((f) => f.round_no === 1 && f.home_entrant_id === r.idOf.get("E2") || f.away_entrant_id === r.idOf.get("E2"))!;
    await playWin(r, line, r.idOf.get("E2")!);
    expect(await getKnockoutCutDrift(r.auth, r.stageIds[0]), "started, nothing moved: no warning").toBeNull();

    await correctQuarter(r, "E4", "E5", {
      afterQuarter: async () => {
        expect(await getKnockoutCutDrift(r.auth, r.stageIds[0]), "mid-correction today's cut is unknown: no warning yet").toBeNull();
      },
    });

    expect(await statusOf(confirmedId), "the bracket stands").toBe("confirmed");
    expect(await roundOne(r)).toEqual(["E1 v E4", "E2 v E3"]);
    expect(names(r, await getKnockoutCutDrift(r.auth, r.stageIds[0])), "the desk names who moved").toEqual({ out: ["E4"], in: ["E5"] });

    // Corrected back: the warning goes with it.
    await correctQuarter(r, "E5", "E4");
    expect(await getKnockoutCutDrift(r.auth, r.stageIds[0])).toBeNull();
  }, 600_000);

  it("X-QM-4 X-LE-9 a Match Day call is a start: the bracket stands with no result anywhere in it", async () => {
    const r = await rig({ template: "qualifying_main" });
    await playSource(r);
    const confirmedId = await confirmLatest(r);
    await callLine(r, "E2");
    await correctQuarter(r, "E4", "E5");
    expect(await statusOf(confirmedId)).toBe("confirmed");
    expect(await roundOne(r)).toEqual(["E1 v E4", "E2 v E3"]);
    expect(names(r, await getKnockoutCutDrift(r.auth, r.stageIds[0]))).toEqual({ out: ["E4"], in: ["E5"] });
  }, 600_000);

  // ko_plate of eight: the Plate takes the Main draw's round-1 losers. Corrected, E4 lost the quarter-final and E5 won it.
  it("X-QM-4 ko_plate: a corrected round-1 result changes a plate entrant, before the Plate starts and after", async () => {
    const r = await rig({ template: "ko_plate" });
    await playSource(r);
    expect((await offered(r))!.sort(), "premise: the quarter-final losers").toEqual(["E5", "E6", "E7", "E8"]);
    // The plate is drawn when it is proposed (T8): this is its day one, exactly as the un-fill has to give it back.
    const drawn = await rowsOf(r.stageIds[1]);
    expect(drawn.length, "anti-vacuity: the proposal drew a plate of four (3 lines)").toBe(3);
    const confirmedId = await confirmLatest(r);

    await correctQuarter(r, "E4", "E5", {
      afterFinal: async () => {
        expect(await statusOf(confirmedId), "round 1 still decided: the same four losers").toBe("confirmed");
      },
      afterQuarter: async () => {
        // W4 T8 (provenBy's firstLosses arm): a first loss depends on byes and forfeits across the WHOLE draw, so nobody is proven
        // while the source is undecided - the confirmed slate stands until the source is decided again, then is judged by its field.
        expect(await statusOf(confirmedId), "mid-correction nobody is proven or disproved: the confirmed plate stands").toBe("confirmed");
      },
    });

    // Decided again: E4 lost the quarter-final, so the field moved and the confirmed plate went stale, its seats back.
    expect(await statusOf(confirmedId), "the field moved: the confirmed plate is stale").toBe("stale");
    const unfilled = await rowsOf(r.stageIds[1]);
    expect(unfilled.length, "anti-vacuity: the plate keeps its lines").toBeGreaterThan(0);
    expect(unfilled.every((f) => f.home_entrant_id === null && f.away_entrant_id === null && f.status === "scheduled"), "its seats went back before it started").toBe(true);
    expect(unfilled.map((f) => [f.id, f.home_entrant_id, f.away_entrant_id, f.status, f.outcome, f.home_slot_label, f.away_slot_label]), "the plate is back as it was drawn: the same lines, every label restored")
      .toEqual(drawn.map((f) => [f.id, null, null, "scheduled", null, f.home_slot_label, f.away_slot_label]));
    expect(unfilled.flatMap((f) => [f.home_slot_label, f.away_slot_label]).filter((l) => l !== null).length, "and the labels came back (a plate of four: two round-one lines)").toBe(4);
    expect((await offered(r))!.sort(), "E4 lost it now").toEqual(["E4", "E6", "E7", "E8"]);
    const secondId = await confirmLatest(r);
    const held = (await rowsOf(r.stageIds[1])).find((f) => f.home_entrant_id !== null && f.away_entrant_id !== null)!;
    await playWin(r, held, held.home_entrant_id!);

    await correctQuarter(r, "E5", "E4");
    expect(await statusOf(secondId), "the Plate started: it stands").toBe("confirmed");
    expect(names(r, await getKnockoutCutDrift(r.auth, r.stageIds[0])), "the drift is the plate's").toEqual({ out: ["E4"], in: ["E5"] });
  }, 600_000);

  it("FX-G18 a cross-stage void un-fills the seat it fed, and the score write names the emptied lines for its publish", async () => {
    const r = await rig({ template: "qualifying_main" });
    await playSource(r);
    await confirmLatest(r);
    await undecide(r, (await finalOf(r)).id);
    await undecide(r, (await sourceLine(r, 2, "E4")).id);
    const quarter = await sourceLine(r, 1, "E4");
    // The quarter-final's void by the bare append, so `onDecided` is called here and its return read: what a score write
    // hands its DEL and push.
    const live = await sql<{ id: string }[]>`
      select e.id from score_events e
       where e.fixture_id = ${quarter.id} and e.type <> 'core.void'
         and not exists (select 1 from score_events v where v.fixture_id = e.fixture_id and v.voids_event_id = e.id)
       order by e.seq desc`;
    for (const e of live) {
      const [{ n }] = await sql<{ n: number }[]>`select coalesce(max(seq), 0)::int as n from score_events where fixture_id = ${quarter.id}`;
      await appendEvent(r.auth.orgId, quarter.id, n, { type: "core.void", payload: { event_id: e.id }, voids: e.id, recordedBy: null });
    }
    expect(await roundOne(r), "premise: the bare append leaves the seats to the hook").toEqual(["E1 v E4", "E2 v E3"]);

    const named = await onDecided(r.auth, quarter.id);

    await expectDayOne(r);
    const lines = (await rowsOf(r.stageIds[1])).filter((f) => f.round_no === 1).map((f) => f.id);
    expect(lines.length, "anti-vacuity: the main draw's round 1").toBe(2);
    for (const id of lines) expect(named, "the emptied main-draw line rides the publish").toContain(id);
  }, 600_000);

  describe("the empty case: a correction that changes no qualifier stales nothing", () => {
    it("a corrected score, the same winner: no proposal moves, a draft or a confirmed one", async () => {
      const draftRig = await rig({ template: "qualifying_main" });
      await playSource(draftRig);
      const draft = (await getSeedProposal(draftRig.auth, draftRig.stageIds[1]))!;
      const final = await finalOf(draftRig);
      const ranksBefore = await storedRanks(draftRig);
      await undecide(draftRig, final.id);
      await playWin(draftRig, (await rowsOf(draftRig.stageIds[0])).find((f) => f.id === final.id)!, final.outcome!.winner!, [21, 15]);
      const [row] = await sql<{ n: number }[]>`select count(*)::int as n from score_events where fixture_id = ${final.id} and type = 'core.void'`;
      expect(row!.n, "anti-vacuity: the final really was corrected").toBeGreaterThan(0);
      expect(await storedRanks(draftRig)).toEqual(ranksBefore);
      expect(await statusOf(draft.id), "the same draft row stands").toBe("draft");
      expect((await getSeedProposal(draftRig.auth, draftRig.stageIds[1]))?.id).toBe(draft.id);
      await confirmLatest(draftRig);
      expect(await roundOne(draftRig), "and it still confirms").toEqual(["E1 v E4", "E2 v E3"]);
    }, 600_000);

    it("a table source keeps its behaviour (W5 owns the table half): a confirmed proposal is untouched by a correction", async () => {
      const r = await rig({ template: "league_ko", n: 4, q: 2 });
      await playSource(r);
      const confirmedId = await confirmLatest(r);
      const line = (await rowsOf(r.stageIds[0]))[0]!;
      await undecide(r, line.id);
      await playWin(r, (await rowsOf(r.stageIds[0])).find((f) => f.id === line.id)!, line.outcome!.winner === line.home_entrant_id ? line.away_entrant_id! : line.home_entrant_id!);
      expect(await statusOf(confirmedId)).toBe("confirmed");
    }, 600_000);
  });

  // The owner's ruling, overturning T14's first reading (RB4-Q3 seeds by rank, RB4-Q5 "every" dependent proposal): before
  // the destination starts a re-seed costs nothing, and an organiser would otherwise play the wrong seeding. After it
  // starts the same four are still the same four: the bracket stands and nobody is named.
  describe("the final flipped: the same four, a new seeding order", () => {
    const flipFinal = async (r: Rig, winner: string) => {
      const final = await finalOf(r);
      await undecide(r, final.id);
      await playWin(r, (await rowsOf(r.stageIds[0])).find((f) => f.id === final.id)!, r.idOf.get(winner)!);
    };

    for (const s of [SINGLES, CHESS]) {
    it(`a confirmed draw that has not started goes stale, its seats go back, and the re-proposal seats the new order; a second flip does it again [${s.key}]`, async () => {
      const r = await rig({ template: "qualifying_main", sport: s });
      await playSource(r);
      const firstId = await confirmLatest(r);
      expect(await roundOne(r), "premise: rank 1 v rank 4, rank 2 v rank 3").toEqual(["E1 v E4", "E2 v E3"]);

      const final = await finalOf(r);
      await undecide(r, final.id);
      expect(await statusOf(firstId), "mid-correction the same four are proven: nothing moves yet").toBe("confirmed");
      expect(await roundOne(r)).toEqual(["E1 v E4", "E2 v E3"]);

      await playWin(r, (await rowsOf(r.stageIds[0])).find((f) => f.id === final.id)!, r.idOf.get("E2")!);
      expect(await storedRanks(r), "anti-vacuity: the correction reached the stored ranks").toEqual(["E2", "E1", "E3", "E4", "E5", "E6", "E7", "E8"]);
      expect(await statusOf(firstId), "the new winner takes rank 1: the confirmed order no longer stands").toBe("stale");
      await expectDayOne(r);
      expect(await offered(r), "re-proposed with nobody asking, in the new order").toEqual(["E2", "E1", "E3", "E4"]);

      const secondId = await confirmLatest(r);
      expect(await roundOne(r), "E2 now meets E4: rank 1 v rank 4").toEqual(["E2 v E4", "E1 v E3"]);

      await flipFinal(r, "E1");
      expect(await statusOf(secondId), "the second call: flipped back").toBe("stale");
      await expectDayOne(r);
      expect(await offered(r)).toEqual(["E1", "E2", "E3", "E4"]);
    }, 900_000);
    }

    it("the same result re-recorded leaves a confirmed draw alone: the order did not move", async () => {
      const r = await rig({ template: "qualifying_main" });
      await playSource(r);
      const confirmedId = await confirmLatest(r);
      await flipFinal(r, "E1");
      expect(await storedRanks(r), "premise: the same ranks").toEqual(["E1", "E2", "E3", "E4", "E5", "E6", "E7", "E8"]);
      expect(await statusOf(confirmedId)).toBe("confirmed");
      expect(await roundOne(r)).toEqual(["E1 v E4", "E2 v E3"]);

      // The second call, and the order it compares is the seeds', not the stored array's.
      await sql`
        update stage_seed_proposals set computed = jsonb_set(computed, '{qualifiers}',
          (select jsonb_agg(q order by ord desc) from jsonb_array_elements(computed -> 'qualifiers') with ordinality as t(q, ord)))
        where id = ${confirmedId}`;
      await flipFinal(r, "E1");
      expect(await statusOf(confirmedId)).toBe("confirmed");
    }, 600_000);

    it("a cut that is no whole round: nothing moves mid-correction, and once decided the seed who fell off the end stales it", async () => {
      const r = await rig({ template: "qualifying_main", storedCut: 3 });
      await playSource(r);
      const confirmedId = await confirmLatest(r);
      expect(await offeredOnSlate(confirmedId, r), "premise: rank order").toEqual(["E1", "E2", "E3"]);
      await correctQuarter(r, "E3", "E6", {
        afterQuarter: async () => {
          expect(await statusOf(confirmedId), "a cut of three cannot be proven line by line").toBe("confirmed");
        },
      });
      expect(await statusOf(confirmedId), "E3, the last seed, is gone; the two left keep their order").toBe("stale");
      expect(await offered(r), "and the re-proposal names who took the place").not.toContain("E3");
    }, 600_000);

    it("with a lucky loser in a departed qualifier's seat: the order moved, so the draw goes back and she is offered in that rank", async () => {
      const r = await rig({ template: "qualifying_main" });
      await playSource(r);
      const confirmedId = await confirmLatest(r);
      await withdrawEntrantCascade(r.auth, r.idOf.get("E4")!);
      expect(await roundOne(r), "premise: E5 took the seat").toEqual(["E1 v E5", "E2 v E3"]);
      await flipFinal(r, "E2");
      expect(await statusOf(confirmedId)).toBe("stale");
      await expectDayOne(r);
      expect(await offered(r)).toEqual(["E2", "E1", "E3", "E5"]);
    }, 600_000);

    it("after the destination starts: the bracket stands and nobody is named, since the same four are the same four", async () => {
      const r = await rig({ template: "qualifying_main" });
      await playSource(r);
      const confirmedId = await confirmLatest(r);
      const line = (await rowsOf(r.stageIds[1])).find((f) => f.home_entrant_id === r.idOf.get("E2") || f.away_entrant_id === r.idOf.get("E2"))!;
      await playWin(r, line, r.idOf.get("E2")!);
      await flipFinal(r, "E2");
      expect(await statusOf(confirmedId)).toBe("confirmed");
      expect(await roundOne(r)).toEqual(["E1 v E4", "E2 v E3"]);
      expect(await getKnockoutCutDrift(r.auth, r.stageIds[0])).toBeNull();
    }, 600_000);
  });

  describe("after a withdrawal", () => {
    it("a withdrawal is no correction (review #2): no warning whether their own line was played or a lucky loser took the seat, and a real correction still warns", async () => {
      const r = await rig({ template: "qualifying_main" });
      await playSource(r);
      await confirmLatest(r);
      // E4 plays her own main-draw line and loses it, then leaves: nobody takes a seat she already used.
      const e4Line = (await rowsOf(r.stageIds[1])).find((f) => f.home_entrant_id === r.idOf.get("E4") || f.away_entrant_id === r.idOf.get("E4"))!;
      await playWin(r, e4Line, r.idOf.get("E1")!);
      await withdrawEntrantCascade(r.auth, r.idOf.get("E4")!);
      expect(await roundOne(r), "premise: no lucky loser, the line was played").toEqual(["E1 v E4", "E2 v E3"]);
      expect(await getKnockoutCutDrift(r.auth, r.stageIds[0]), "E5 is not coming in: nobody moved").toBeNull();

      // The departure does not mute the warning a real correction is owed: E6 beats E3 this time.
      await correctQuarter(r, "E3", "E6");
      expect(names(r, await getKnockoutCutDrift(r.auth, r.stageIds[0]))).toEqual({ out: ["E3"], in: ["E6"] });
    }, 900_000);

    it("her own quarter-final corrected after she left: someone comes in where nobody is out, so there is no one to name", async () => {
      const r = await rig({ template: "qualifying_main" });
      await playSource(r);
      await confirmLatest(r);
      const e4Line = (await rowsOf(r.stageIds[1])).find((f) => f.home_entrant_id === r.idOf.get("E4") || f.away_entrant_id === r.idOf.get("E4"))!;
      await playWin(r, e4Line, r.idOf.get("E1")!);
      await withdrawEntrantCascade(r.auth, r.idOf.get("E4")!);
      await correctQuarter(r, "E4", "E5");
      expect(await storedRanks(r), "anti-vacuity: the correction moved E5 across the cut").not.toEqual(["E1", "E2", "E3", "E4", "E5", "E6", "E7", "E8"]);
      expect(await getKnockoutCutDrift(r.auth, r.stageIds[0])).toBeNull();
    }, 600_000);

    it("a qualifier leaves before their line and the lucky loser is seated: no warning", async () => {
      const r = await rig({ template: "qualifying_main" });
      await playSource(r);
      await confirmLatest(r);
      const other = (await rowsOf(r.stageIds[1])).find((f) => f.home_entrant_id === r.idOf.get("E2") || f.away_entrant_id === r.idOf.get("E2"))!;
      await playWin(r, other, r.idOf.get("E2")!);
      await withdrawEntrantCascade(r.auth, r.idOf.get("E4")!);
      expect(await roundOne(r), "premise: E5 took the seat").toEqual(["E1 v E5", "E2 v E3"]);
      expect(await getKnockoutCutDrift(r.auth, r.stageIds[0])).toBeNull();
    }, 600_000);

    const replayFinal = async (r: Rig, winner: string) => {
      const final = await finalOf(r);
      await undecide(r, final.id);
      await playWin(r, (await rowsOf(r.stageIds[0])).find((f) => f.id === final.id)!, r.idOf.get(winner)!);
    };

    it("a departed qualifier on the slate, the same result re-recorded: the order of those left did not move, so the lucky loser keeps the seat", async () => {
      const r = await rig({ template: "qualifying_main" });
      await playSource(r);
      const confirmedId = await confirmLatest(r);
      await withdrawEntrantCascade(r.auth, r.idOf.get("E4")!);
      await replayFinal(r, "E1");
      expect(await statusOf(confirmedId)).toBe("confirmed");
      expect(await roundOne(r)).toEqual(["E1 v E5", "E2 v E3"]);
    }, 600_000);

    it("a slate that names the lucky loser (confirmed after the withdrawal), the same result re-recorded: she is on today's cut, so it stands", async () => {
      const r = await rig({ template: "qualifying_main" });
      await playSource(r);
      await withdrawEntrantCascade(r.auth, r.idOf.get("E4")!);
      expect(await offered(r), "premise: the proposal offers her in that rank").toEqual(["E1", "E2", "E3", "E5"]);
      const confirmedId = await confirmLatest(r);
      const final = await finalOf(r);
      await undecide(r, final.id);
      expect(await statusOf(confirmedId), "mid-correction E4's seat is still proven, so E5's place is too").toBe("confirmed");
      await playWin(r, (await rowsOf(r.stageIds[0])).find((f) => f.id === final.id)!, r.idOf.get("E1")!);
      expect(await statusOf(confirmedId)).toBe("confirmed");
      expect(await roundOne(r)).toEqual(["E1 v E5", "E2 v E3"]);

      // Her own place does go at once: the quarter-final that made E4 a qualifier and E5 the loser is taken back.
      const semi = await sourceLine(r, 2, "E4");
      const quarter = await sourceLine(r, 1, "E4");
      await undecide(r, final.id);
      await undecide(r, semi.id);
      await undecide(r, quarter.id);
      expect(await statusOf(confirmedId), "nobody left to name for that place").toBe("stale");
    }, 900_000);

    it("a correction that makes a seated lucky loser a true qualifier does not name her as coming in: she is already there", async () => {
      const r = await rig({ template: "qualifying_main" });
      await playSource(r);
      await confirmLatest(r);
      await withdrawEntrantCascade(r.auth, r.idOf.get("E4")!);
      expect(await roundOne(r), "premise: E5 took the seat").toEqual(["E1 v E5", "E2 v E3"]);
      const other = (await rowsOf(r.stageIds[1])).find((f) => f.home_entrant_id === r.idOf.get("E2") || f.away_entrant_id === r.idOf.get("E2"))!;
      await playWin(r, other, r.idOf.get("E2")!);
      await correctQuarter(r, "E4", "E5");
      await correctQuarter(r, "E3", "E6");
      expect(names(r, await getKnockoutCutDrift(r.auth, r.stageIds[0]))).toEqual({ out: ["E3"], in: ["E6"] });
    }, 900_000);

    it("a confirm's own walkover goes with its seats, and the same result re-recorded re-proposes (the shortfall's bye)", async () => {
      const r = await rig({ template: "qualifying_main" });
      await playSource(r);
      // Every quarter-final loser leaves, then E4: nobody is left to take her seat, so the confirm walks E1 over.
      for (const name of ["E5", "E6", "E7", "E8", "E4"]) await withdrawEntrantCascade(r.auth, r.idOf.get(name)!);
      const firstId = await confirmLatest(r);
      const award = (await rowsOf(r.stageIds[1])).find((f) => f.outcome?.kind === "award");
      expect(award?.outcome?.winner, "premise: the confirm awarded E1 the walkover").toBe(r.idOf.get("E1"));
      expect(
        (await rowsOf(r.stageIds[1])).find((f) => f.is_final)?.home_entrant_id === r.idOf.get("E1") ||
          (await rowsOf(r.stageIds[1])).find((f) => f.is_final)?.away_entrant_id === r.idOf.get("E1"),
        "premise: and advanced her to the final",
      ).toBe(true);

      const final = await finalOf(r);
      const semi = await sourceLine(r, 2, "E3");
      const quarter = await sourceLine(r, 1, "E3");
      await undecide(r, final.id);
      await undecide(r, semi.id);
      await undecide(r, quarter.id);
      expect(await statusOf(firstId)).toBe("stale");
      await expectDayOne(r);

      // The same winner again: the stored ranks do not move, and the stale proposal must not be left stranded.
      const ranksBefore = await storedRanks(r);
      await replayForward(r, quarter.id, r.idOf.get("E3")!, semi.id, final.id);
      expect(await storedRanks(r)).toEqual(ranksBefore);
      expect((await getSeedProposal(r.auth, r.stageIds[1]))?.status, "re-proposed without a click").toBe("draft");
      await confirmLatest(r);
      expect((await rowsOf(r.stageIds[1])).find((f) => f.outcome?.kind === "award")?.outcome?.winner, "the walkover again").toBe(r.idOf.get("E1"));
    }, 600_000);
  });

  describe("refreshCompletedBracketPlacement", () => {
    it("a bracket not completed yet is not its to write, even with every line decided (Complete writes the first ranks)", async () => {
      const r = await rig({ template: "qualifying_main" });
      for (let guard = 0; guard < 8; guard++) {
        const open = (await rowsOf(r.stageIds[0])).filter((f) => f.home_entrant_id !== null && f.away_entrant_id !== null && f.status === "scheduled");
        if (open.length === 0) break;
        for (const f of open) await playWin(r, f, num(r, f.home_entrant_id!) < num(r, f.away_entrant_id!) ? f.home_entrant_id! : f.away_entrant_id!);
      }
      const [stage] = await sql<{ status: string }[]>`select status from stages where id = ${r.stageIds[0]}`;
      expect(stage!.status, "premise: every line decided and nobody pressed Complete").toBe("active");
      expect(await refreshCompletedBracketPlacement(r.auth.orgId, r.stageIds[0])).toBe(false);
      expect((await sql`select 1 from standings_snapshots where stage_id = ${r.stageIds[0]}`).length, "no ranks written").toBe(0);
    }, 300_000);

    it("the kinds W4 does not own stay frozen: a completed league is not re-ranked by this door", async () => {
      const r = await rig({ template: "league_ko", n: 4, q: 2 });
      await playSource(r);
      expect(await refreshCompletedBracketPlacement(r.auth.orgId, r.stageIds[0])).toBe(false);
    }, 300_000);
  });

  describe("a defeat proves a lucky loser only where a seat was vacated", () => {
    // Cricket only: it is the sport whose fold flips a winner without passing through undecided, so the old finalist is a loser
    // at the very moment the line changes hands (knockout-void-unfill.test.ts). Expected by hand: E4 beat E1 on the no-ball and
    // E3 beat E2, so the final is E3 v E4 and both go through. Void the no-ball and E1 won that line: E4 has no place left.
    let swept = 0;
    // The departed case: E2 lost her line, so she has left no seat in the cut's round (the final) and there is still no vacancy.
    for (const departs of [null, "E2"] as const) {
      it(`a flipped line with ${departs === null ? "nobody departed" : "only a beaten semi-finalist departed"}: the old finalist's seat goes at once, and a re-decided source seats the new one`, async () => {
        const r = await cricketRig();
        const source = await rowsOf(r.stageIds[0]);
        const flip = source.find((f) => f.round_no === 1 && f.away_entrant_id === r.idOf.get("E4"));
        const other = source.find((f) => f.round_no === 1 && f.id !== flip?.id);
        expect(flip?.home_entrant_id, "premise: E1 v E4, E4 the chasers").toBe(r.idOf.get("E1"));
        expect([other?.home_entrant_id, other?.away_entrant_id].sort(), "premise: E2 v E3").toEqual([r.idOf.get("E2"), r.idOf.get("E3")].sort());
        const noBall = await chaseWonOnANoBall(r.auth, flip!, r.xiOf);
        await post(r.auth, other!.id, "core.forfeit", { by: r.idOf.get("E2"), reason: "walkover" });
        const final = await finalOf(r);
        expect([final.home_entrant_id, final.away_entrant_id].sort(), "premise: the final is E4 v E3").toEqual([r.idOf.get("E3"), r.idOf.get("E4")].sort());
        await post(r.auth, final.id, "core.forfeit", { by: r.idOf.get("E3"), reason: "walkover" });
        expect((await completeStage(r.auth, r.stageIds[0])).completed, "rig: the source completed").toBe(true);
        const confirmedId = await confirmLatest(r);
        expect(await roundOne(r), "premise: the confirmed main draw").toEqual(["E3 v E4"]);
        if (departs !== null) await withdrawEntrantCascade(r.auth, r.idOf.get(departs)!);

        await undecide(r, final.id);
        expect(await statusOf(confirmedId), "the final's void moves nobody: its two seats are the cut").toBe("confirmed");
        expect(await roundOne(r)).toEqual(["E3 v E4"]);

        const [{ n }] = await sql<{ n: number }[]>`select coalesce(max(seq), 0)::int as n from score_events where fixture_id = ${flip!.id}`;
        const flipped = await scoreEvent(r.auth, flip!.id, { expected_seq: n, type: "core.void", payload: { event_id: noBall } });
        expect(flipped.outcome, "premise: the fold never passed through undecided").toMatchObject({ kind: "win", winner: r.idOf.get("E1") });
        const again = await finalOf(r);
        expect([again.home_entrant_id, again.away_entrant_id].sort(), "premise: E1 took the final's seat").toEqual([r.idOf.get("E1"), r.idOf.get("E3")].sort());

        expect(await statusOf(confirmedId), "E4 is a loser now, and no seat was vacated for a lucky loser to fill").toBe("stale");
        expect(await roundOne(r), "her seat is gone from the main draw").toEqual(["- v -"]);

        await post(r.auth, again.id, "core.forfeit", { by: r.idOf.get("E3"), reason: "walkover" });
        expect(await offered(r), "the re-decided source re-proposes: E1 won the final, E3 lost it").toEqual(["E1", "E3"]);
        await confirmLatest(r);
        expect(await roundOne(r)).toEqual(["E1 v E3"]);
        swept++;
      }, 300_000);
    }
    it("anti-vacuity: both flip cases ran", () => {
      expect(swept).toBe(2);
    });
  });

  describe("unfillProposalSeats", () => {
    it("a started destination gives nothing back: the started guard is the helper's own", async () => {
      const r = await rig({ template: "qualifying_main" });
      await playSource(r);
      const confirmedId = await confirmLatest(r);
      const line = (await rowsOf(r.stageIds[1]))[0]!;
      await playWin(r, line, line.home_entrant_id!);
      const before = await rowsOf(r.stageIds[1]);
      const out = await withTenant(r.auth.orgId, (tx) => unfillProposalSeats(tx, confirmedId));
      expect(out).toEqual([]);
      expect(await rowsOf(r.stageIds[1])).toEqual(before);
    }, 300_000);

    it("an unknown proposal is an error, not an empty list", async () => {
      const { auth } = await seedOrg("pro");
      await expect(withTenant(auth.orgId, (tx) => unfillProposalSeats(tx, randomUUID()))).rejects.toThrow(/no such proposal/);
    });
  });

  describe("getKnockoutCutDrift's nulls", () => {
    it("an unknown stage is a 404", async () => {
      const { auth } = await seedOrg("pro");
      expect((await refusal(getKnockoutCutDrift(auth, randomUUID()))).status).toBe(404);
    });

    it("a stage not complete, or not a knockout, or with no stage after it: no warning", async () => {
      const r = await rig({ template: "qualifying_main" });
      expect(await getKnockoutCutDrift(r.auth, r.stageIds[0]), "not complete").toBeNull();
      expect(await getKnockoutCutDrift(r.auth, r.stageIds[1]), "not complete, and nothing after it").toBeNull();
      const league = await rig({ template: "league_ko", n: 4, q: 2 });
      await playSource(league);
      expect(await getKnockoutCutDrift(league.auth, league.stageIds[0]), "a league's is W5's").toBeNull();
    }, 300_000);

    it("a destination that has not started is no breach, however it stands: no warning and nothing logged (a draft, then a re-proposal)", async () => {
      const r = await rig({ template: "qualifying_main" });
      await playSource(r);
      const { log } = await import("@/server/logger");
      const spy = vi.spyOn(log, "error");
      expect(await getKnockoutCutDrift(r.auth, r.stageIds[0]), "only a draft").toBeNull();
      await confirmLatest(r);
      await correctQuarter(r, "E4", "E5");
      expect(await getKnockoutCutDrift(r.auth, r.stageIds[0]), "un-filled and re-proposed").toBeNull();
      expect(spy.mock.calls.filter((c) => JSON.stringify(c).includes("knockout_cut_drift")), "no breach logged").toEqual([]);
      spy.mockRestore();
    }, 600_000);

    it("a started destination with no confirmed proposal on record: no warning and no 500 (the desk stays up), logged", async () => {
      const r = await rig({ template: "qualifying_main" });
      await playSource(r);
      await confirmLatest(r);
      const line = (await rowsOf(r.stageIds[1]))[0]!;
      await playWin(r, line, line.home_entrant_id!);
      await sql`update stage_seed_proposals set status = 'stale' where stage_id = ${r.stageIds[1]}`;
      const { log } = await import("@/server/logger");
      const spy = vi.spyOn(log, "error");
      expect(await getKnockoutCutDrift(r.auth, r.stageIds[0])).toBeNull();
      expect(spy.mock.calls.length, "the breach is logged by name").toBeGreaterThan(0);
      spy.mockRestore();
    }, 300_000);
  });
});
