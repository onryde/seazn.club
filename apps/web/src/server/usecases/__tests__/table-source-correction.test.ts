// W5 app-A Task 11 (X-CUT-4 <- RB5-K6, signed OWNER S5 2026-11-06; FX-G16's TABLE half, the sibling of W4 T14's knockout half in
// knockout-source-correction.test.ts): a correction, or a departure, inside a COMPLETED league or group source. Before the
// destination starts, the proposal goes stale - a confirmed one too - the seats it filled go back to TBD, and a re-proposal names
// the new cut. After it starts, the bracket stands and the desk warns (`getTableCutDrift`, the knockout read's sibling).
//
// differential: today (00578f5a0d) `scoring.ts` stales only DRAFT proposals for a table source
// (`markDependentSeedProposalsStale(auth, stageId)`, no `includeConfirmed`), and the withdrawal cascade stales nothing at all:
// the confirmed proposal keeps naming the corrected-out or departed qualifier and her seat is a walkover.
//
// Driven through the real doors on a real database: the catalogue's own templates (`STAGE_TEMPLATES`), the scorer
// (`scoreEvent`, whose post-commit hook is the seam under test), Complete, propose and confirm, and every door the withdrawal
// cascade has (`patchEntrant`'s withdrawn and disqualified, the route's `withdrawEntrantCascade`, the registrant's authority).
//
// Expected values: the rulebook's table read by hand off the results. The higher seed wins every match unless a case flips one,
// and a win is 3 points, so a table is the seed order and a flipped match swaps two neighbours: E4 v E5 flipped in a league of
// six puts E5 (6 points) above E4 (3). Never read from the cut under test.
//
// Sports: the corrected-qualifier case sweeps the generic scoreboard and badminton singles; the rest read seats and proposals,
// which no sport field reaches, and run on the generic scoreboard.
import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { builtinModules } from "@seazn/engine/sports";
import { sql } from "@/lib/db";
import { STAGE_TEMPLATES } from "@/lib/format-templates";
import type { AuthCtx } from "@/server/api-v1/auth";
import { appendEvent } from "@/server/engine-db";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants, patchEntrant } from "../entrants";
import { startDivision } from "../schedule";
import { scoreEvent } from "../scoring";
import { completeStage, createStages, generateStageFixtures, getSeedProposal, overrideStandings, refoldStageTable } from "../stages";
import { getTableCutDrift } from "../table-cut-drift";
import { cascadeAuthFor, withdrawEntrantCascade } from "../withdrawal";
import { confirmResolvingTies } from "./_confirm-with-ties";
import { GENERIC_CONFIG, seedOrg } from "./_seed";

// B3 fix wave (m-2): `failDeparture` makes the withdrawal cascade's own final status write throw once - a cascade cut off AFTER
// it staled the confirmed proposal and BEFORE its re-proposal. Every other call is the real code (patchEntrant writes in-module).
const cut = vi.hoisted(() => ({ failDeparture: false }));
vi.mock("../entrants", async (io) => {
  const real = await io<typeof import("../entrants")>();
  return {
    ...real,
    writeEntrantPatch: async (...args: Parameters<typeof real.writeEntrantPatch>) => {
      if (cut.failDeparture && real.DEPARTED_STATUSES.has(args[2].status ?? "")) {
        cut.failDeparture = false;
        throw new Error("simulated: the cascade was cut off before its status write");
      }
      return real.writeEntrantPatch(...args);
    },
  };
});

vi.mock("next/cache", () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown) => fn,
  revalidateTag: vi.fn(),
}));

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
  config: Record<string, unknown>;
}
const GENERIC: SportPick = { key: "generic", variant: "score", config: GENERIC_CONFIG };
const BADMINTON: SportPick = (() => {
  const m = builtinModules.find((x) => x.key === "badminton");
  if (m === undefined) throw new Error("no engine module badminton");
  const variant = Object.keys(m.variants)[0];
  if (variant === undefined) throw new Error("badminton declares no variant");
  return { key: "badminton", variant, config: {} };
})();

interface RowSpec {
  key: "league_ko" | "groups_ko" | "group_playoffs" | "group_stepladder";
  entrants: number;
  qualified: number;
}
/** E1..E6, the top four go through. */
const LEAGUE: RowSpec = { key: "league_ko", entrants: 6, qualified: 4 };
/** Two pools of four (snake: E1,E4,E5,E8 and E2,E3,E6,E7), the top two of each go through: no best-Nth, so no tie to read. */
const GROUPS4: RowSpec = { key: "groups_ko", entrants: 8, qualified: 4 };
/** Two pools of three (E1,E4,E5 and E2,E3,E6), q = 5: top two of each plus the best third - the shape where a departed pool winner
 *  would take the best-third seat on the record she earned (`departedLoseBestNth`, Task 9). */
const GROUPS6: RowSpec = { key: "groups_ko", entrants: 6, qualified: 5 };
/** Final stages with a FIXED shape (RB4-S1/S2): four seats, so a short cut cannot be drawn. The field is the take (`EXHAUSTED`)
 *  or one more (`BACKFILL`). */
const finalsRow = (key: "group_playoffs" | "group_stepladder", entrants: number): RowSpec => ({ key, entrants, qualified: 4 });
/** The same pools with q = 5: top two of each plus the best third. Thirds are E5 and E6 on 3 points each (a tie the confirm
 *  resolves) until a departure leaves one pool with a different third. */
const GROUPS5: RowSpec = { key: "groups_ko", entrants: 8, qualified: 5 };

interface Fx {
  id: string;
  round_no: number;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  pool_id: string | null;
  status: string;
  outcome: unknown;
}

interface Rig {
  auth: AuthCtx;
  sport: SportPick;
  divisionId: string;
  srcId: string;
  koId: string;
  idOf: Map<number, string>;
  seedOf: Map<string, number>;
  /** The destination as the generator wrote it, before any confirm. */
  dayOne: Fx[];
  /** The confirmed proposal's id. */
  confirmedId: string;
}

const nameFor = (seed: number) => `E${seed}`;

const rowsOf = (stageId: string) =>
  sql<Fx[]>`
    select id, round_no, home_entrant_id, away_entrant_id, pool_id, status, outcome
      from fixtures where stage_id = ${stageId} order by round_no, seq_in_round, id`;

/** The ledger events of a decisive result for the HOME side (or the away side), in the sport's own vocabulary. */
function resultEvents(sport: SportPick, homeWins: boolean): { type: string; payload: Record<string, unknown> }[] {
  if (sport.key === "badminton") {
    const game = homeWins ? { home: 21, away: 10 } : { home: 10, away: 21 };
    return [
      { type: "core.start", payload: {} },
      { type: "badminton.game.summary", payload: game },
      { type: "badminton.game.summary", payload: game },
    ];
  }
  return [
    { type: "core.start", payload: {} },
    { type: "generic.result", payload: homeWins ? { p1Score: 2, p2Score: 0 } : { p1Score: 0, p2Score: 2 } },
  ];
}

/** Record a whole match for the entrant with seed `winner`, straight on the ledger: scoring's auto-advance would complete the
 *  source before the case's own steps, and the hook under test is the CORRECTION's (`scoreEvent`), not the first result's. */
async function play(r: Rig, f: Fx, winnerSeed: number): Promise<void> {
  const homeWins = r.seedOf.get(f.home_entrant_id!) === winnerSeed;
  for (const [i, e] of resultEvents(r.sport, homeWins).entries()) await appendEvent(r.auth.orgId, f.id, i, { type: e.type, payload: e.payload });
}

const lineOf = async (r: Rig, stageId: string, a: number, b: number): Promise<Fx> => {
  const [x, y] = [r.idOf.get(a)!, r.idOf.get(b)!];
  const line = (await rowsOf(stageId)).find((f) => [f.home_entrant_id, f.away_entrant_id].sort().join() === [x, y].sort().join());
  expect(line, `premise: E${a} and E${b} meet in the stage`).toBeTruthy();
  return line!;
};

async function post(auth: AuthCtx, fixtureId: string, type: string, payload: Record<string, unknown> = {}): Promise<void> {
  const [{ n }] = await sql<{ n: number }[]>`select coalesce(max(seq), 0)::int as n from score_events where fixture_id = ${fixtureId}`;
  await scoreEvent(auth, fixtureId, { expected_seq: n, type, payload });
}

/** The scorer's own correction of a decided source line: take its live events back, newest first, and record the other side's
 *  win. Each `scoreEvent` runs the post-commit hook under test. */
async function correct(r: Rig, a: number, b: number, newWinner: number): Promise<void> {
  const f = await lineOf(r, r.srcId, a, b);
  const live = await sql<{ id: string }[]>`
    select e.id from score_events e
     where e.fixture_id = ${f.id} and e.type <> 'core.void'
       and not exists (select 1 from score_events v where v.fixture_id = e.fixture_id and v.voids_event_id = e.id)
     order by e.seq desc`;
  expect(live.length, "premise: the line holds live events to take back").toBeGreaterThan(0);
  for (const e of live) await post(r.auth, f.id, "core.void", { event_id: e.id });
  const homeWins = r.seedOf.get(f.home_entrant_id!) === newWinner;
  for (const e of resultEvents(r.sport, homeWins)) await post(r.auth, f.id, e.type, e.payload);
}

async function rig(row: RowSpec, sport: SportPick = GENERIC, opts: { confirm?: boolean; departBefore?: number[] } = {}): Promise<Rig> {
  const { auth } = await seedOrg("pro");
  const suffix = randomUUID().slice(0, 8);
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: `T11 ${suffix}`, visibility: "private", branding: {} });
  const div = await createDivision(auth, comp.id, {
    name: "Open",
    slug: `open-${suffix}`,
    sport_key: sport.key,
    variant_key: sport.variant,
    config: sport.config,
  } as never);
  const ents = await createEntrants(
    auth,
    div.id,
    Array.from({ length: row.entrants }, (_, i) => ({ kind: "individual" as const, display_name: nameFor(i + 1), seed: i + 1, members: [] })),
  );
  const idOf = new Map(ents.map((e) => [e.seed as number, e.id]));
  const seedOf = new Map(ents.map((e) => [e.id, e.seed as number]));
  const tpl = STAGE_TEMPLATES.find((t) => t.key === row.key);
  expect(tpl, `the template ${row.key} exists`).toBeDefined();
  const drafts = tpl!.build({ qualified: row.qualified, poolCount: 2, swissRounds: 3, legs: 1 });
  expect(drafts, `${row.key}: a source stage and a destination`).toHaveLength(2);
  expect(drafts[1]?.progression?.timing, `${row.key}: the destination is seeded by a confirm`).toBe("setup");
  const stages = await createStages(
    auth,
    div.id,
    drafts.map((d, i) => ({ seq: i + 1, kind: d.kind, name: d.name, config: d.config, progression: d.progression })) as never,
  );
  const src = stages.find((s) => s.seq === 1)!;
  const ko = stages.find((s) => s.seq === 2)!;
  await generateStageFixtures(auth, ko.id);
  await generateStageFixtures(auth, src.id);
  await startDivision(auth, div.id);
  const r: Rig = {
    auth,
    sport,
    divisionId: div.id,
    srcId: src.id,
    koId: ko.id,
    idOf,
    seedOf,
    dayOne: await rowsOf(ko.id),
    confirmedId: "",
  };
  const fx = await rowsOf(src.id);
  expect(fx.length, "the source's fixtures were generated").toBeGreaterThan(0);
  for (const f of fx) {
    const [a, b] = [seedOf.get(f.home_entrant_id!)!, seedOf.get(f.away_entrant_id!)!];
    await play(r, f, Math.min(a, b));
  }
  // A departure before the source completes (the bare status flip an organiser's PATCH is): the proposal is made without her.
  for (const seed of opts.departBefore ?? []) await patchEntrant(auth, idOf.get(seed)!, { status: "withdrawn" });
  await refoldStageTable(auth.orgId, { id: src.id, kind: src.kind }, "skip");
  const done = await completeStage(auth, src.id);
  expect(done.completed, "rig: the source completed").toBe(true);
  const proposal = await getSeedProposal(auth, ko.id);
  expect(proposal?.status, "rig: completion left a draft").toBe("draft");
  r.confirmedId = proposal!.id;
  if (opts.confirm !== false) await confirmResolvingTies(auth, ko.id, proposal!.id);
  return r;
}

const statusOf = async (proposalId: string) => {
  const [p] = await sql<{ status: string }[]>`select status from stage_seed_proposals where id = ${proposalId}`;
  return p?.status;
};

const slateOf = async (r: Rig, proposalId: string): Promise<number[]> => {
  const [p] = await sql<{ computed: { qualifiers: { rank: number; entrantId: string }[] } }[]>`select computed from stage_seed_proposals where id = ${proposalId}`;
  return [...p!.computed.qualifiers].sort((a, b) => a.rank - b.rank).map((q) => r.seedOf.get(q.entrantId)!);
};

const newestSlate = async (r: Rig): Promise<{ status: string; seeds: number[] }> => {
  const p = await getSeedProposal(r.auth, r.koId);
  return { status: p!.status, seeds: [...p!.computed.qualifiers].sort((a, b) => a.rank - b.rank).map((q) => r.seedOf.get(q.entrantId)!) };
};

/** The newest proposal's FULL slate as [rank, entrant seed] pairs, rank order: a seat nobody is offered (a departed qualifier's) is
 *  a rank missing from the list, so a closed-up gap and a dead seat read differently. */
const newestPairs = async (r: Rig): Promise<{ status: string; pairs: [number, number][] }> => {
  const p = await getSeedProposal(r.auth, r.koId);
  return { status: p!.status, pairs: [...p!.computed.qualifiers].sort((a, b) => a.rank - b.rank).map((q): [number, number] => [q.rank, r.seedOf.get(q.entrantId)!]) };
};

/** The destination's seats, by seed, in line order (null = empty). */
async function seats(r: Rig): Promise<(number | null)[][]> {
  return (await rowsOf(r.koId)).map((f) => [f.home_entrant_id, f.away_entrant_id].map((id) => (id === null ? null : r.seedOf.get(id)!)));
}

/** The destination is back as the generator wrote it: every seat empty, every line scheduled with no outcome. */
async function expectDayOne(r: Rig): Promise<void> {
  const rows = await rowsOf(r.koId);
  expect(rows.length, "anti-vacuity: the destination has lines").toBeGreaterThan(0);
  expect(rows.map((f) => [f.id, f.home_entrant_id, f.away_entrant_id, f.status, f.outcome])).toEqual(r.dayOne.map((f) => [f.id, null, null, "scheduled", null]));
}

/** Start the destination's first line: a score event on it - the start the un-fill refuses (`stageHasStarted`). */
async function startDestination(r: Rig): Promise<void> {
  const line = (await rowsOf(r.koId)).find((f) => f.round_no === 1 && f.home_entrant_id !== null && f.away_entrant_id !== null);
  expect(line, "premise: the destination holds a seated round-one line").toBeTruthy();
  await appendEvent(r.auth.orgId, line!.id, 0, { type: "core.start", payload: {} });
}

const names = (drift: { out: string[]; in: string[] } | null, r: Rig) =>
  drift === null ? null : { out: drift.out.map((id) => nameFor(r.seedOf.get(id)!)), in: drift.in.map((id) => nameFor(r.seedOf.get(id)!)) };

const tableWithdrawalRows = async (r: Rig) =>
  (await sql<{ n: number }[]>`select count(*)::int as n from division_events where division_id = ${r.divisionId} and type = 'table_withdrawal'`)[0]!.n;

describe.runIf(HAS_DB)("W5 T11 a correction inside a completed league or group source (X-CUT-4, FX-G16 table half)", () => {
  // league_ko of six at q = 4, the favourite winning every line: the table is E1..E6 (15, 12, 9, 6, 3, 0 points), the cut E1..E4,
  // the destination's round one E1 v E4 and E2 v E3.
  // The correction: E5 won the match E4 was given. Then E5 has 6 points (beat E4 and E6) and E4 has 3, the table is E1, E2, E3,
  // E5, E4, E6 and the cut E1, E2, E3, E5.
  let swept = 0;
  for (const s of [GENERIC, BADMINTON]) {
    it(`X-CUT-4 a correction in a complete league before the knockout starts stales the confirmed proposal and its seats go back [${s.key}]`, async () => {
      // differential: today only drafts stale, scoring.ts:1211 - the confirmed proposal stays 'confirmed' and E4 keeps the seat.
      const r = await rig(LEAGUE, s);
      expect(await statusOf(r.confirmedId), "premise: the proposal is confirmed").toBe("confirmed");
      expect(await slateOf(r, r.confirmedId), "premise: the confirmed cut is the table's top four").toEqual([1, 2, 3, 4]);
      expect((await seats(r)).slice(0, 2).map((p) => [...p].sort()), "premise: the confirm seated E1 v E4 and E2 v E3").toEqual([[1, 4], [2, 3]]);
      await correct(r, 4, 5, 5);
      expect(await statusOf(r.confirmedId), "the confirmed proposal went stale").toBe("stale");
      await expectDayOne(r);
      const now = await newestSlate(r);
      expect(now, "a re-proposal names the corrected cut, ready to confirm").toEqual({ status: "draft", seeds: [1, 2, 3, 5] });
      swept++;
    });
  }

  it("X-CUT-4 a correction that moves nobody across the cut leaves the confirmed proposal and its seats alone", async () => {
    const r = await rig(LEAGUE);
    const before = await seats(r);
    await correct(r, 5, 6, 6); // E6 beats E5: they swap fifth and sixth, below the cut
    expect(await statusOf(r.confirmedId), "still confirmed").toBe("confirmed");
    expect(await seats(r), "no seat moved").toEqual(before);
    expect((await newestSlate(r)).status, "and nothing was re-proposed").toBe("confirmed");
  });

  it("X-CUT-4 a correction that re-orders the cut (a flipped final's analogue) stales it: the bracket seeds by rank", async () => {
    const r = await rig(LEAGUE);
    await correct(r, 1, 2, 2); // E2 beats E1: the same four, E2 first
    expect(await statusOf(r.confirmedId)).toBe("stale");
    await expectDayOne(r);
    expect(await newestSlate(r)).toEqual({ status: "draft", seeds: [2, 1, 3, 4] });
  });

  it("X-CUT-4 a withdrawal of a confirmed qualifier before the knockout starts stales it; the next eligible entrant takes her place", async () => {
    // differential: today nothing stales - E3 keeps the seat, the cascade walks E2 over to the final.
    const r = await rig(LEAGUE);
    expect(await slateOf(r, r.confirmedId)).toEqual([1, 2, 3, 4]);
    await patchEntrant(r.auth, r.idOf.get(3)!, { status: "withdrawn" });
    expect(await statusOf(r.confirmedId), "the confirmed proposal went stale").toBe("stale");
    await expectDayOne(r); // nobody was walked over, no seat holds her
    expect(await newestSlate(r), "RB5-K2: E5 takes the vacated place, the gap closes").toEqual({ status: "draft", seeds: [1, 2, 4, 5] });
    const [src] = await sql<{ status: string }[]>`select status from stages where id = ${r.srcId}`;
    expect(src!.status, "RB5-L8: the completed table stays as it finished").toBe("complete");
    expect(await tableWithdrawalRows(r), "and takes no table withdrawal row").toBe(0);
  });

  // Every door the cascade has reaches the one hook: the organiser's PATCH, the route's POST, a disqualification, and the
  // registrant's own authority (no staff user). A departure that is nobody's qualifier is the other direction of each.
  const doors: [string, (r: Rig, seed: number) => Promise<unknown>][] = [
    ["organiser PATCH withdrawn", (r, seed) => patchEntrant(r.auth, r.idOf.get(seed)!, { status: "withdrawn" })],
    ["organiser PATCH disqualified", (r, seed) => patchEntrant(r.auth, r.idOf.get(seed)!, { status: "disqualified" })],
    ["route POST /entrants/{id}/withdraw", (r, seed) => withdrawEntrantCascade(r.auth, r.idOf.get(seed)!)],
    [
      "the registrant's own authority (no staff user)",
      (r, seed) => withdrawEntrantCascade(cascadeAuthFor(r.auth.orgId, null), r.idOf.get(seed)!, { actor: { kind: "registrant", registration_id: randomUUID() } }),
    ],
  ];
  let doorChecks = 0;
  for (const [door, depart] of doors) {
    it(`X-CUT-4 door: ${door} - a qualifier stales the confirmed proposal, a non-qualifier does not`, async () => {
      const r = await rig(LEAGUE);
      const before = await seats(r);
      await depart(r, 6); // E6 finished last: on nobody's slate
      expect(await statusOf(r.confirmedId), "a departure outside the cut leaves it confirmed").toBe("confirmed");
      expect(await seats(r), "and every seat").toEqual(before);
      await depart(r, 2);
      expect(await statusOf(r.confirmedId), "a departure inside the cut stales it").toBe("stale");
      await expectDayOne(r);
      expect((await newestSlate(r)).seeds, "E5 backfills E2's place; E6 has left too").toEqual([1, 3, 4, 5]);
      doorChecks++;
    });
  }

  it("X-CUT-4 after the knockout started the bracket stands and the drift names the difference", async () => {
    const r = await rig(LEAGUE);
    expect(await getTableCutDrift(r.auth, r.srcId), "empty case: nothing corrected, nothing to name").toBeNull();
    await startDestination(r);
    const before = await seats(r);
    await correct(r, 4, 5, 5);
    expect(await statusOf(r.confirmedId), "the bracket stands: still confirmed").toBe("confirmed");
    expect(await seats(r), "no seat moved").toEqual(before);
    expect(names(await getTableCutDrift(r.auth, r.srcId), r), "the desk names who today's table would cut").toEqual({ out: ["E4"], in: ["E5"] });
    await correct(r, 4, 5, 4); // put it back
    expect(await getTableCutDrift(r.auth, r.srcId), "drift is null with no difference: the same cut again").toBeNull();
  });

  it("X-CUT-4 after the knockout started a withdrawal is RB4-V3's walkover, not drift", async () => {
    const r = await rig(LEAGUE);
    await startDestination(r);
    await withdrawEntrantCascade(r.auth, r.idOf.get(3)!);
    expect(await statusOf(r.confirmedId), "still confirmed: the bracket stands").toBe("confirmed");
    // The negative pair: the seat is the opponent's walkover, not a backfill (RB4-V3).
    const line = (await rowsOf(r.koId)).find((f) => [f.home_entrant_id, f.away_entrant_id].includes(r.idOf.get(3)!));
    expect(line, "premise: she still holds her seat").toBeTruthy();
    expect(line!.outcome, "E2 is walked over to the final").toMatchObject({ kind: "award", winner: r.idOf.get(2)! });
    expect(await getTableCutDrift(r.auth, r.srcId), "a departed qualifier is no correction: no one to name as coming in").toBeNull();
  });

  it("X-CUT-4 sequence: the re-proposal confirms, and a second departure stales it again", async () => {
    const r = await rig(LEAGUE);
    await withdrawEntrantCascade(r.auth, r.idOf.get(3)!);
    const second = await getSeedProposal(r.auth, r.koId);
    expect(second!.status, "premise: the first departure re-proposed").toBe("draft");
    await confirmResolvingTies(r.auth, r.koId, second!.id);
    expect(await slateOf(r, second!.id), "premise: E5 took E3's place").toEqual([1, 2, 4, 5]);
    await withdrawEntrantCascade(r.auth, r.idOf.get(5)!);
    expect(await statusOf(second!.id), "the second confirmation went stale too").toBe("stale");
    await expectDayOne(r);
    expect(await newestSlate(r), "E6 is the next eligible").toEqual({ status: "draft", seeds: [1, 2, 4, 6] });
  });

  it("X-CUT-4 a drift is a source's own: a league nothing draws from, and a source still open, answer null", async () => {
    const r = await rig(LEAGUE);
    expect(await getTableCutDrift(r.auth, r.koId), "the destination is no league or group").toBeNull();
    await expect(getTableCutDrift(r.auth, randomUUID()), "an unknown stage is a 404").rejects.toMatchObject({ status: 404 });
  });

  // A confirmed slate that no longer matches the table cannot arise through the doors (they re-propose before the start), so it is
  // forged: the E4 seat of the confirmed cut is rewritten to E5. The read is for the desk after the start only; before it, a stale
  // read would warn about a bracket that has not started and can still be redrawn.
  const forgeConfirmedCut = (r: Rig) => sql`
    update stage_seed_proposals
       set computed = jsonb_set(computed, '{qualifiers}', (
         select jsonb_agg(case when q->>'entrantId' = ${r.idOf.get(4)!} then jsonb_set(q, '{entrantId}', to_jsonb(${r.idOf.get(5)!}::text)) else q end)
           from jsonb_array_elements(computed->'qualifiers') q))
     where id = ${r.confirmedId}`;

  it("X-CUT-4 the drift is read only once the destination has started: a mismatched confirmed cut before the start says nothing", async () => {
    const r = await rig(LEAGUE);
    await forgeConfirmedCut(r);
    expect(await slateOf(r, r.confirmedId), "premise: the confirmed cut now names E5 where the table has E4").toEqual([1, 2, 3, 5]);
    expect(await getTableCutDrift(r.auth, r.srcId), "before the start the desk has nothing to say: the bracket can still be redrawn").toBeNull();
    await startDestination(r);
    expect(names(await getTableCutDrift(r.auth, r.srcId), r), "the same mismatch after the start is named").toEqual({ out: ["E5"], in: ["E4"] });
  });

  it("X-CUT-4 only a league or a group carries the drift: the same started, mismatched source read as another kind is null", async () => {
    const r = await rig(LEAGUE);
    await forgeConfirmedCut(r);
    await startDestination(r);
    expect(names(await getTableCutDrift(r.auth, r.srcId), r), "premise: as a league it names the difference").toEqual({ out: ["E5"], in: ["E4"] });
    // The knockout's drift is a different read (getKnockoutCutDrift); this one never answers for it.
    await sql`update stages set kind = 'swiss' where id = ${r.srcId}`;
    expect(await getTableCutDrift(r.auth, r.srcId), "a complete stage of another kind: no table drift").toBeNull();
  });

  it("X-CUT-4 groups_ko: a correction in a complete group stage re-proposes before the knockout starts, names the drift after", async () => {
    const r = await rig(GROUPS4);
    const poolOf = (seed: number) => rowsOf(r.srcId).then((rows) => rows.find((f) => [f.home_entrant_id, f.away_entrant_id].includes(r.idOf.get(seed)!))!.pool_id);
    expect(await poolOf(4), "premise: E4 and E5 share a pool").toBe(await poolOf(5));
    // premise: top two of each pool, wave-major (A1, B1, A2, B2). The two winners are level across the pools, so their order is the
    // knockout's stored draw seed's (ruling 281, W5 app PR B T5): each wave is compared as a set.
    const slate = await slateOf(r, r.confirmedId);
    expect([new Set(slate.slice(0, 2)), new Set(slate.slice(2))], "premise: top two of each pool, wave-major (A1, B1 | A2, B2)").toEqual([new Set([1, 2]), new Set([4, 3])]);
    await correct(r, 4, 5, 5); // pool A: E1 9, E5 6, E4 3, E8 0: E5 goes through instead of E4
    expect(await statusOf(r.confirmedId)).toBe("stale");
    await expectDayOne(r);
    expect((await newestSlate(r)).seeds.slice().sort((a, b) => a - b)).toEqual([1, 2, 3, 5]);
    // after: a fresh rig, confirmed, started, then corrected
    const started = await rig(GROUPS4);
    await startDestination(started);
    await correct(started, 4, 5, 5);
    expect(await statusOf(started.confirmedId), "after the start the confirmed proposal stands").toBe("confirmed");
    expect(names(await getTableCutDrift(started.auth, started.srcId), started)).toEqual({ out: ["E4"], in: ["E5"] });
  });

  it("X-CUT-4 groups_ko best-Nth: the pool winner leaves a confirmed cut - the recompute is over the eligible thirds, and a stale proposal re-proposes", async () => {
    // q = 5 over pools of four: top two of each plus the best third. Thirds E5 and E6 tie on 3 points; the confirm resolved it.
    const r = await rig(GROUPS5);
    const before = await slateOf(r, r.confirmedId);
    expect(before, "premise: she was in the confirmed cut").toContain(2);
    expect(before.length).toBe(5);
    await patchEntrant(r.auth, r.idOf.get(2)!, { status: "withdrawn" });
    expect(await statusOf(r.confirmedId)).toBe("stale");
    await expectDayOne(r);
    // Pool B without her: E3 and E6 are its top two, E7 its third (0 points); pool A's third E5 (3 points) takes the best-Nth seat.
    const now = await newestSlate(r);
    expect(now.status).toBe("draft");
    expect(now.seeds.slice().sort((a, b) => a - b), "RB5-K2: the cut recomputed without her").toEqual([1, 3, 4, 5, 6]);
  });

  it("X-CUT-4 after the start, a departure AND a correction together: only the moved result is named, as the results make the table", async () => {
    const r = await rig(LEAGUE);
    await startDestination(r);
    await withdrawEntrantCascade(r.auth, r.idOf.get(3)!); // her seat is a walkover (RB4-V3)
    expect(await getTableCutDrift(r.auth, r.srcId), "premise: the departure alone is no drift").toBeNull();
    await correct(r, 4, 5, 5); // E5 would go through instead of E4 on the results
    // The table as the results make it, E3 keeping the place she earned: E1, E2, E3, E5. Less the departed on both sides: E4 out, E5 in.
    // A read that closed her gap (E4 takes her place) would see E4 still through, and name nobody.
    expect(names(await getTableCutDrift(r.auth, r.srcId), r)).toEqual({ out: ["E4"], in: ["E5"] });
  });

  it("X-CUT-4 groups_ko best-Nth: a correction that moves nobody leaves a cut made WITHOUT a departed pool winner standing (her record cannot take the seat)", async () => {
    // E2 (pool B's winner) left before the source completed: the proposal's cut is E1, E4, E3, E6 and pool A's third, E5.
    const r = await rig(GROUPS6, GENERIC, { departBefore: [2] });
    expect((await slateOf(r, r.confirmedId)).slice().sort((a, b) => a - b), "premise: the cut was made without her").toEqual([1, 3, 4, 5, 6]);
    // E3 beats her instead of the other way round: E3 6 points, E6 0, E2 3 on that record - level with nobody, above pool A's third (E5, 0).
    // The eligible order is unchanged (E3, E6) so the cut cannot move, yet a read that let her record compete for the best-third seat
    // would put her there and stale a proposal that still stands.
    await correct(r, 2, 3, 3);
    expect(await statusOf(r.confirmedId), "still confirmed").toBe("confirmed");
  });

  it("X-CUT-4 groups_ko best-Nth: a correction that DOES move the cut stales it even with a departed pool winner (her record must not read as an exhausted field)", async () => {
    // As above, E2 left before the source completed: the cut is E1, E4 (pool A), E3, E6 (pool B), and pool A's third, E5.
    const r = await rig(GROUPS6, GENERIC, { departBefore: [2] });
    expect((await slateOf(r, r.confirmedId)).slice().sort((a, b) => a - b), "premise").toEqual([1, 3, 4, 5, 6]);
    // E5 beats E4 in pool A: E1, E5, E4 - E5 now takes E4's seat in the draw (A2) and E4 drops to the best-third place.
    await correct(r, 4, 5, 5);
    expect(await statusOf(r.confirmedId), "the cut's seats moved: stale").toBe("stale");
    await expectDayOne(r);
    const now = await newestSlate(r);
    expect(now.status).toBe("draft");
    expect(now.seeds.slice().sort((a, b) => a - b), "the same five people, E2 still out").toEqual([1, 3, 4, 5, 6]);
    expect(now.seeds, "in a new draw order").not.toEqual(await slateOf(r, r.confirmedId));
  });

  it("X-CUT-4 a rank override on a complete league is a correction too: it stales the confirmed proposal", async () => {
    const r = await rig(LEAGUE);
    await overrideStandings(r.auth, r.srcId, {
      rows: [{ entrant_id: r.idOf.get(5)!, rank: 1, reason: "placement game" }],
    });
    expect(await statusOf(r.confirmedId), "E5 pinned first: the cut moved").toBe("stale");
    await expectDayOne(r);
  });

  // Review I-1 (RB4-E7, R6 "else walkover"): a fixed-shape final cannot be drawn short. When nobody is left to take a departed
  // qualifier's place the confirmed proposal STANDS and her seat is the cascade's walkover; when someone is, it is re-proposed.
  // Expected from the rulebook: RB4-S1 stepladder k=4 plays R1 = seed 4 v seed 3 first; RB4-S2 page playoff plays Q1 = seed 1 v
  // seed 2 and E = seed 3 v seed 4 first. The qualifier who leaves is the one on a day-one line, so a walkover is visible at once.
  const FINALS = [
    { key: "group_stepladder", leaves: 3, opponent: 4, first: "R1 (seed 4 v seed 3, RB4-S1)" },
    { key: "group_playoffs", leaves: 2, opponent: 1, first: "Q1 (seed 1 v seed 2, RB4-S2)" },
  ] as const;
  let finalsChecked = 0;
  for (const f of FINALS) {
    it(`X-CUT-4 ${f.key} EXHAUSTED (field = take): the confirmed proposal stands and the departure is a walkover, never a short cut [route, bare PATCH]`, async () => {
      for (const door of ["cascade", "patch"] as const) {
        const r = await rig(finalsRow(f.key, 4));
        const slate = await slateOf(r, r.confirmedId);
        expect(slate.slice().sort(), "premise: all four take the four seats").toEqual([1, 2, 3, 4]);
        const idAtSeed = async (seed: number) => {
          const [p] = await sql<{ computed: { qualifiers: { rank: number; entrantId: string }[] } }[]>`select computed from stage_seed_proposals where id = ${r.confirmedId}`;
          return p!.computed.qualifiers.find((q) => q.rank === seed)!.entrantId;
        };
        const leaving = await idAtSeed(f.leaves);
        const opponent = await idAtSeed(f.opponent);
        const before = (await sql<{ n: number }[]>`select count(*)::int as n from stage_seed_proposals where stage_id = ${r.koId}`)[0]!.n;
        if (door === "cascade") await withdrawEntrantCascade(r.auth, leaving);
        else await patchEntrant(r.auth, leaving, { status: "withdrawn" });
        expect(await statusOf(r.confirmedId), `${door}: nobody to take her place - the proposal stands`).toBe("confirmed");
        expect(
          (await sql<{ n: number }[]>`select count(*)::int as n from stage_seed_proposals where stage_id = ${r.koId}`)[0]!.n,
          `${door}: no short re-proposal was made`,
        ).toBe(before);
        const held = (await rowsOf(r.koId)).filter((x) => [x.home_entrant_id, x.away_entrant_id].includes(leaving));
        expect(held.length, `${door}: her seat is still on a line of ${f.first}`).toBeGreaterThan(0);
        if (door === "cascade") {
          expect(held.some((x) => (x.outcome as { winner?: string } | null)?.winner === opponent), "the cascade walked the line over to her opponent").toBe(true);
        } else {
          expect(held.every((x) => x.outcome === null), "a bare status flip settles no line").toBe(true);
        }
        finalsChecked++;
      }
    }, 120_000);

    it(`X-CUT-4 ${f.key} BACKFILL (field = take + 1): the departure stales it, the seats go back and the next eligible takes her place`, async () => {
      const r = await rig(finalsRow(f.key, 5));
      const [p] = await sql<{ computed: { qualifiers: { rank: number; entrantId: string }[] } }[]>`select computed from stage_seed_proposals where id = ${r.confirmedId}`;
      const named = p!.computed.qualifiers.map((q) => q.entrantId);
      expect(named.length, "premise: four seats").toBe(4);
      const extra = [...r.seedOf.keys()].filter((id) => !named.includes(id));
      expect(extra.length, "premise: exactly one entrant is left out of the take").toBe(1);
      const leaving = p!.computed.qualifiers.find((q) => q.rank === f.leaves)!.entrantId;
      await withdrawEntrantCascade(r.auth, leaving);
      expect(await statusOf(r.confirmedId), "someone can take her place: stale").toBe("stale");
      await expectDayOne(r);
      const now = await getSeedProposal(r.auth, r.koId);
      expect(now!.status, "a fresh draft waits on the desk").toBe("draft");
      expect(new Set(now!.computed.qualifiers.map((q) => q.entrantId)), "the one left out is in; she is out").toEqual(new Set([...named.filter((id) => id !== leaving), extra[0]!]));
      finalsChecked++;
    }, 120_000);
  }

  // Review I-2: Reinstate after a re-confirm. A confirmed proposal made while she was out names the entrant who stood in; once she
  // is back the cut is hers again, and nothing but this write can say so.
  it("X-CUT-4 sequence: withdraw, re-confirm, Reinstate - the confirmed proposal goes stale and is re-proposed WITH her", async () => {
    const r = await rig(LEAGUE);
    await withdrawEntrantCascade(r.auth, r.idOf.get(3)!);
    const second = await getSeedProposal(r.auth, r.koId);
    await confirmResolvingTies(r.auth, r.koId, second!.id);
    expect(await slateOf(r, second!.id), "premise: E5 stands in for E3").toEqual([1, 2, 4, 5]);
    await patchEntrant(r.auth, r.idOf.get(3)!, { status: "confirmed" });
    expect(await statusOf(second!.id), "she is back: the confirmed cut is stale").toBe("stale");
    await expectDayOne(r);
    expect(await newestSlate(r), "re-proposed with her").toEqual({ status: "draft", seeds: [1, 2, 3, 4] });
    // The other side: a Reinstate that changes nothing about the cut leaves a confirmed proposal alone.
    const q = await rig(LEAGUE);
    await patchEntrant(q.auth, q.idOf.get(6)!, { status: "withdrawn" });
    expect(await statusOf(q.confirmedId), "premise: a non-qualifier's departure moved nothing").toBe("confirmed");
    await patchEntrant(q.auth, q.idOf.get(6)!, { status: "confirmed" });
    expect(await statusOf(q.confirmedId), "nor does her return").toBe("confirmed");
    // And after the finals started the bracket stands: she is back, no seat moves, the desk names the difference truthfully.
    const t = await rig(LEAGUE);
    await withdrawEntrantCascade(t.auth, t.idOf.get(3)!);
    const third = await getSeedProposal(t.auth, t.koId);
    await confirmResolvingTies(t.auth, t.koId, third!.id);
    await startDestination(t);
    const seated = await seats(t);
    await patchEntrant(t.auth, t.idOf.get(3)!, { status: "confirmed" });
    expect(await statusOf(third!.id), "started: the bracket stands").toBe("confirmed");
    expect(await seats(t), "no seat moved").toEqual(seated);
  });

  // Review round 2: the exhausted rule is for a DEPARTURE only. League of four, all four qualify (the cut IS the field), so a
  // departure leaves nobody to backfill; a correction that re-orders the cut still changes the seeding, which drives the bracket.
  // Table by hand (3 points a win, the higher seed winning everything): E1 9, E2 6, E3 3, E4 0. E2 beating E1 makes it E2 9, E1 6.
  const FULL: RowSpec = { key: "league_ko", entrants: 4, qualified: 4 };
  it("X-CUT-4 exhausted cut: a correction that re-orders it stales the proposal and re-seeds from the corrected table (a departed qualifier in it changes nothing)", async () => {
    const r = await rig(FULL);
    expect(await slateOf(r, r.confirmedId), "premise: the cut is the whole field, in table order").toEqual([1, 2, 3, 4]);
    await patchEntrant(r.auth, r.idOf.get(4)!, { status: "withdrawn" }); // nobody to backfill: it stands (the departure rule)
    expect(await statusOf(r.confirmedId), "premise: the exhausted departure left it standing").toBe("confirmed");
    await correct(r, 1, 2, 2);
    expect(await statusOf(r.confirmedId), "the order moved: the seeding is stale").toBe("stale");
    await expectDayOne(r);
    const now = await newestSlate(r);
    expect(now.status).toBe("draft");
    expect((await newestPairs(r)).pairs, "re-seeded from the corrected table: E2, E1, E3 at seeds 1-3, seed 4 the departed E4's").toEqual([[1, 2], [2, 1], [3, 3]]);
    // The same correction with nobody departed (the plain full cut) stales it too.
    const plain = await rig(FULL);
    await correct(plain, 1, 2, 2);
    expect(await statusOf(plain.confirmedId)).toBe("stale");
    expect((await newestSlate(plain)).seeds).toEqual([2, 1, 3, 4]);
  });

  it("X-CUT-4 exhausted cut: a departure alone stands and the cascade walks her seat over (RB4-E7)", async () => {
    const r = await rig(FULL);
    await withdrawEntrantCascade(r.auth, r.idOf.get(4)!);
    expect(await statusOf(r.confirmedId)).toBe("confirmed");
    const held = (await rowsOf(r.koId)).find((f) => [f.home_entrant_id, f.away_entrant_id].includes(r.idOf.get(4)!))!;
    expect(held.outcome, "E4 v E1 on day one (seed 4 v seed 1): E1 is awarded the line").toMatchObject({ winner: r.idOf.get(1)! });
  });

  it("X-CUT-4 exhausted cut, a correction AND a departure: whichever comes first, the seeding follows the corrected table and the departure is a walkover", async () => {
    // Basis: RB5-K6 (a correction before the start re-seeds, the bracket seeds by rank, RB4-Q3) and RB4-E7/R6 (a departure with no
    // backfill stands and is a walkover). Order 1: the correction first - stale, re-proposed, re-confirmed E2, E1, E3, E4 - then E4
    // leaves: the confirmed re-seeding stands, E4's seat (seed 4 v seed 1 = E2) is awarded to E2.
    const a = await rig(FULL);
    await correct(a, 1, 2, 2);
    expect(await statusOf(a.confirmedId)).toBe("stale");
    const fresh = await getSeedProposal(a.auth, a.koId);
    await confirmResolvingTies(a.auth, a.koId, fresh!.id);
    expect(await slateOf(a, fresh!.id), "premise: the corrected order is confirmed").toEqual([2, 1, 3, 4]);
    await withdrawEntrantCascade(a.auth, a.idOf.get(4)!);
    expect(await statusOf(fresh!.id), "the exhausted departure leaves the corrected seeding standing").toBe("confirmed");
    const awarded = (await rowsOf(a.koId)).find((f) => [f.home_entrant_id, f.away_entrant_id].includes(a.idOf.get(4)!))!;
    expect(awarded.outcome, "seed 4 v seed 1 (E2): E2 is awarded the line").toMatchObject({ winner: a.idOf.get(2)! });
    // Order 2: the departure first (the bare flip settles nothing: it stands), then the correction: the seeding is stale and is
    // re-seeded from the corrected table, E4 (out of the field) last.
    const b = await rig(FULL);
    await patchEntrant(b.auth, b.idOf.get(4)!, { status: "withdrawn" });
    await correct(b, 1, 2, 2);
    expect(await statusOf(b.confirmedId)).toBe("stale");
    expect((await newestPairs(b)).pairs, "E2, E1, E3 at seeds 1-3, seed 4 the departed E4's").toEqual([[1, 2], [2, 1], [3, 3]]);
  });

  // Review round 3 (I-A): the same rule inside a MIDDLE seat. A departed qualifier of an exhausted cut keeps the seat her results
  // EARNED (RB5-K6 + RB4-E7/R6): the proposal offers nobody at it and the confirm walks it over - it is not closed up and her
  // place never moves to the bottom, which would draw a short cut (a bye on a page playoff, RB4-S2) and shift every seed below her.
  // Table by hand, the favourite winning every line: E1 9, E2 6, E3 3, E4 0.
  //   page playoff: E2 leaves, then E4 beats E3 -> E1 9, E2 6 (out), E4 3, E3 0: seeds 1 E1, 2 E2 (dead), 3 E4, 4 E3.
  //     Q1 = seed 1 v seed 2 is E1's walkover; E = seed 3 v seed 4 is E4 v E3 (RB4-S2).
  //   stepladder: E3 leaves, then E2 beats E1 -> E2 9, E1 6, E3 3 (out), E4 0: seeds 1 E2, 2 E1, 3 E3 (dead), 4 E4.
  //     R1 = seed 4 v seed 3 is E4's walkover over the dead seat (RB4-S1).
  const MIDDLE = [
    { key: "group_playoffs", leaves: 2, fix: [4, 3, 4], pairs: [[1, 1], [3, 4], [4, 3]], walkover: { winner: 1 } },
    { key: "group_stepladder", leaves: 3, fix: [1, 2, 2], pairs: [[1, 2], [2, 1], [4, 4]], walkover: { winner: 4 } },
    // The survivors keep their ORDER (E1, E3, E4) and only the dead seat moves: E3 beats E2 -> E1 9, E3 6, E2 3 (out), E4 0, so E3
    // and E4 sit one seat higher and lower than before. Seats 1 E1, 2 E3, 3 E2 (dead), 4 E4: Q1 = E1 v E3, E = dead v E4 (E4's walkover).
    { key: "group_playoffs", leaves: 2, fix: [3, 2, 3], pairs: [[1, 1], [2, 3], [4, 4]], walkover: { winner: 4 } },
  ] as const;
  let middleChecked = 0;
  for (const m of MIDDLE) {
    it(`X-CUT-4 ${m.key} exhausted (E${m.fix[2]} wins E${m.fix[0]} v E${m.fix[1]}): a departed MIDDLE seat then a correction re-proposes the earned seats, the dead one empty, and the confirm walks it over`, async () => {
      // The cascade door walks her line over on the spot, which STARTS the finals: a correction after it is the desk's warning, not
      // a re-proposal (RB5-K6 after the start). The bare PATCH settles nothing, so the correction is still before the start.
      const started = await rig(finalsRow(m.key, 4));
      await withdrawEntrantCascade(started.auth, started.idOf.get(m.leaves)!);
      await correct(started, m.fix[0], m.fix[1], m.fix[2]);
      expect(await statusOf(started.confirmedId), "after the cascade's walkover the finals have started: the bracket stands").toBe("confirmed");
      middleChecked++;
      {
        const door = "patch";
        const r = await rig(finalsRow(m.key, 4));
        expect((await newestPairs(r)).pairs, "premise: the four seats").toEqual([[1, 1], [2, 2], [3, 3], [4, 4]]);
        await patchEntrant(r.auth, r.idOf.get(m.leaves)!, { status: "withdrawn" });
        expect(await statusOf(r.confirmedId), `${door}: nobody to take her place, it stands`).toBe("confirmed");
        await correct(r, m.fix[0], m.fix[1], m.fix[2]);
        expect(await statusOf(r.confirmedId), `${door}: the correction moved the seeding`).toBe("stale");
        await expectDayOne(r);
        const now = await newestPairs(r);
        expect(now.status).toBe("draft");
        expect(now.pairs, `${door}: the corrected table's seats, her earned seat offered to nobody`).toEqual(m.pairs);
        const fresh = await getSeedProposal(r.auth, r.koId);
        await confirmResolvingTies(r.auth, r.koId, fresh!.id);
        const win = r.idOf.get(m.walkover.winner)!;
        const line = (await rowsOf(r.koId)).find((x) => [x.home_entrant_id, x.away_entrant_id].includes(win) && x.round_no === 1);
        expect(line, `${door}: E${m.walkover.winner} holds a day-one line`).toBeTruthy();
        expect(line!.outcome, `${door}: the dead seat is a walkover for E${m.walkover.winner}`).toMatchObject({ winner: win });
        middleChecked++;
      }
    }, 180_000);
  }

  // B3 fix wave (m-2): a cascade cut off after it staled the confirmed proposal (its seats back) but before its re-proposal left
  // the destination with NO live proposal, and its retry found nothing confirmed to stale - so nothing ever re-proposed.
  // differential: today (01888347fa) the newest proposal stays `stale` after the retry. Expected: RB5-K2, E5 takes E3's place.
  it("X-CUT-4 a cascade cut off after staling the confirmed proposal: its retry re-proposes the draw it staled", async () => {
    const r = await rig(LEAGUE);
    cut.failDeparture = true;
    await expect(withdrawEntrantCascade(r.auth, r.idOf.get(3)!)).rejects.toThrow(/cut off/);
    expect(cut.failDeparture, "rig: the cut-off was reached").toBe(false);
    expect(await statusOf(r.confirmedId), "the first run staled it").toBe("stale");
    expect((await newestSlate(r)).status, "rig: and nothing live is left").toBe("stale");
    await withdrawEntrantCascade(r.auth, r.idOf.get(3)!); // the retry (the organiser's Withdraw again)
    expect(await newestSlate(r), "RB5-K2: E5 takes the vacated place").toEqual({ status: "draft", seeds: [1, 2, 4, 5] });
    await expectDayOne(r);
    // Sequence: a second departure re-proposes again from the live draft - one draft at a time.
    await withdrawEntrantCascade(r.auth, r.idOf.get(1)!);
    expect(await newestSlate(r)).toEqual({ status: "draft", seeds: [2, 4, 5, 6] });
    const [{ drafts }] = await sql<{ drafts: number }[]>`select count(*)::int as drafts from stage_seed_proposals where stage_id = ${r.koId} and status = 'draft'`;
    expect(drafts).toBe(1);
  });

  // B3 fix wave (m-6): a correction is several score writes (each live event taken back, then the new result recorded), and each
  // one re-proposes; a recompute that reads the SAME cut as the draft it would replace kept the draft as it was only by staling it
  // and inserting an identical row. differential: today (01888347fa) the dependent holds two identical rows per such recompute.
  it("X-CUT-4 a correction re-proposes without duplicate rows: no two re-proposals of the destination carry the same slate", async () => {
    let checked = 0;
    for (const sport of [GENERIC, BADMINTON]) {
      const r = await rig(LEAGUE, sport);
      await correct(r, 1, 2, 2); // E2 beats E1: the cut re-orders, the draw is re-proposed
      expect(await newestSlate(r)).toEqual({ status: "draft", seeds: [2, 1, 3, 4] });
      // The re-proposals: every row after the confirmed one the rig made (it went stale; a re-proposal may read its cut again).
      const rows = await sql<{ status: string; computed: unknown }[]>`
        select status, computed from stage_seed_proposals where stage_id = ${r.koId} and id <> ${r.confirmedId} order by created_at, id`;
      // The slate the organiser confirms: who sits where AND the ties to resolve (a mid-correction level pair is a different
      // slate); the standings hash is not part of it. Both read back from jsonb, so one key order.
      const cuts = rows.map((p) => {
        return JSON.stringify({ ...(p.computed as object), standingsHash: undefined });
      });
      expect(rows.length, "anti-vacuity: re-proposals were written").toBeGreaterThan(0);
      expect(new Set(cuts).size, `${sport.key}: ${rows.map((p) => p.status).join(",")}`).toBe(cuts.length);
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("X-CUT-4 the sweep ran every sport and every door", () => {
    expect(swept, "anti-vacuity: both sports ran the correction").toBe(2);
    expect(doorChecks, "anti-vacuity: every door ran").toBe(doors.length);
    expect(finalsChecked, "anti-vacuity: two finals kinds x (two exhausted doors + one backfill)").toBe(FINALS.length * 3);
    expect(middleChecked, "anti-vacuity: two finals kinds x two doors").toBe(MIDDLE.length * 2);
  });
});
