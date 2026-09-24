// CHARACTERISATION PROBE (2026-09-24) — one player walks over in a 2-round
// Swiss that feeds a knockout of 4. Mirrors a real production division from
// Saturday. It records what the product DOES; it fixes nothing. Every
// expectation below was observed by running this file against a fresh
// database, then written down. Where the product does something we would not
// recommend, the assertion pins the OBSERVED behaviour and says so, so a later
// fix turns this file red on purpose rather than silently.
//
// The division, as production has it:
//   badminton / bwf, 6 individual entrants seeded 1–6 (S1…S6 here);
//   stage 1 swiss   config {"rounds":2,"pairing":"rank_adjacent"}
//   stage 2 knockout config {"rules":{"bestOf":3}}  (written through the real
//     PUT /stages/{id}/rules path — `createStages` refuses a `rules` key);
//   the knockout's progression is the swiss_knockout TEMPLATE's (Top 4,
//     rankRange 1–4, rank_order, timing "setup") — production's own
//     progression row was not available to this probe.
//   Shells minted, the TBD bracket drawn, every swiss shell laid on a court
//   and a time through the board's own drag path (`moveFixture`), published.
//
// "H" is the no-show: seed 6. "A" is whoever round 1 pairs against H. Round 1
// is a FOLD (1v4, 2v5, 3v6) even though the stored mode is rank_adjacent —
// `effectiveSwissPairing` overrides round 1 — so A is S3.
//
// Only the usecases the buttons call are driven: Generate / "Pair next round"
// (`generateStageFixtures`), Unpair (`unpairSwissRound`), Forfeit and the
// quick result (`scoreEvent`: `core.forfeit` / `core.start` +
// `badminton.game.summary`), Withdraw (`withdrawEntrantCascade`), Start,
// Publish, Complete stage and Confirm seeding. No fixture row is written by
// hand.
//
// What the four scenarios found (details at each assertion):
//   S1 forfeit → decide → withdraw → pair next: works as recommended. A keeps
//      the walkover, policy "walkover" with nothing to do, R2 is 2 boards + a
//      bye (to S5), H is absent, H does not qualify. H is still ranked 6th in
//      the swiss table. Confirm seeding refuses a flagged S1/A tie until the
//      organiser picks the order.
//   S2 withdraw BEFORE the forfeit: A-v-H is expunged to `abandoned` with no
//      winner (A loses the point), and the division is then STUCK — Pair next
//      refuses ("current swiss round has undecided fixtures": the pair gate's
//      DECIDED set has no `abandoned`), Unpair refuses ("played results"), and
//      the Forfeit button refuses the abandoned board too (WRONG_PHASE,
//      "match already over").
//   S3 never withdraw: Pair next re-pairs A against H in round 2 — a rematch.
//      Read, not run: the pairer credits a two-sided walkover like a bye
//      (`o.kind === "award"` → winner into `byes`, pair never added to
//      `played`), and the implicit-bye pass then credits H a point for a round
//      H never played, which lifts H into A's score group.
//   S4 pre-start pair → withdraw → unpair → pair: works. Both rounds reshape to
//      2 boards + bye; surviving boards keep id, time and court; the removed
//      board's slot is gone and the new bye rows carry no time or court.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { EngineError } from "@seazn/engine/core";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import type { AuthCtx } from "@/server/api-v1/auth";
import { CreateStage } from "@/server/api-v1/schemas";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { getFixtureState } from "../fixtures";
import { moveFixture, publishSchedule, startDivision } from "../schedule";
import { scoreEvent } from "../scoring";
import { putStageRules } from "../stage-rules";
import {
  completeStage,
  confirmSeedProposal,
  createStages,
  generateStageFixtures,
  getSeedProposal,
  getStandings,
  unpairSwissRound,
} from "../stages";
import { createCourt, createVenue } from "../venues";
import { withdrawEntrantCascade } from "../withdrawal";
import { seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

/** Everything observed, written to $PROBE_OUT when set — the raw record the
 *  probe's report is built from. Never read by an assertion. */
const OBS: Record<string, unknown> = {};

afterAll(async () => {
  if (process.env.PROBE_OUT) fs.writeFileSync(process.env.PROBE_OUT, JSON.stringify(OBS, null, 2));
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

interface FixtureRow {
  id: string;
  ext_key: string | null;
  round_no: number;
  seq_in_round: number;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  status: string;
  outcome: { kind?: string; winner?: string; method?: string } | null;
  scheduled_at: Date | string | null;
  court_id: string | null;
}

async function fixturesOf(stageId: string): Promise<FixtureRow[]> {
  return sql<FixtureRow[]>`
    select id, ext_key, round_no, seq_in_round, home_entrant_id, away_entrant_id,
           status, outcome, scheduled_at, court_id
    from fixtures where stage_id = ${stageId}
    order by round_no, seq_in_round`;
}

const inRound = (rows: FixtureRow[], r: number) => rows.filter((f) => f.round_no === r);
const iso = (v: Date | string | null) => (v === null ? null : v instanceof Date ? v.toISOString() : v);

interface Rig {
  auth: AuthCtx;
  divisionId: string;
  swissId: string;
  koId: string;
  courts: string[];
  /** "S1".."S6" → entrant id. */
  idOf: (name: string) => string;
  /** Entrant id → "A" / "H" once labelled, else "S1".."S6"; null → "-". */
  who: (id: string | null | undefined) => string;
  label: (name: string, role: string) => void;
}

async function seedRig(): Promise<Rig> {
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Saturday " + randomUUID().slice(0, 6),
    visibility: "private",
    branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name: "Open singles",
    slug: "open-" + randomUUID().slice(0, 6),
    sport_key: "badminton",
    variant_key: "bwf",
    config: {},
  });
  const entrants = await createEntrants(
    auth,
    division.id,
    Array.from({ length: 6 }, (_, i) => ({
      kind: "individual" as const,
      display_name: `S${i + 1}`,
      seed: i + 1,
      members: [],
    })),
  );
  const [swiss] = await createStages(
    auth,
    division.id,
    CreateStage.parse({
      seq: 1,
      kind: "swiss",
      name: "Swiss",
      config: { rounds: 2, pairing: "rank_adjacent" },
      progression: null,
    }),
  );
  const [ko] = await createStages(
    auth,
    division.id,
    CreateStage.parse({
      seq: 2,
      kind: "knockout",
      name: "Knockout",
      config: {},
      progression: {
        sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 4 }] }],
        placement: "rank_order",
        timing: "setup",
      },
    }),
  );
  await putStageRules(auth, ko!.id, { rules: { bestOf: 3 } });

  const venue = await createVenue(auth, { name: "Hall", sort: 0 });
  const courts: string[] = [];
  for (let i = 0; i < 3; i++) {
    courts.push((await createCourt(auth, venue.id, { name: `Court ${i + 1}`, sort: i, tags: [] })).id);
  }

  const nameById = new Map(entrants.map((e) => [e.id, e.display_name]));
  const idByName = new Map(entrants.map((e) => [e.display_name, e.id]));
  const roles = new Map<string, string>();
  return {
    auth,
    divisionId: division.id,
    swissId: swiss!.id,
    koId: ko!.id,
    courts,
    idOf: (name) => idByName.get(name)!,
    who: (id) => {
      if (!id) return "-";
      const n = nameById.get(id) ?? id;
      return roles.get(n) ?? n;
    },
    label: (name, role) => roles.set(name, role),
  };
}

/** Round r's boards at 09:00 + (r−1)h on courts 1..3. */
const slotOf = (roundNo: number) => new Date(Date.UTC(2030, 5, 15, 8 + roundNo, 0)).toISOString();

/** Mint the swiss shells, draw the TBD bracket, lay every swiss shell onto the
 *  board through the drag path, publish. The division is then `scheduled`. */
async function prepareAndPublish(rig: Rig): Promise<void> {
  const mint = await generateStageFixtures(rig.auth, rig.swissId);
  expect(mint.created, "2 rounds × 3 boards of shells").toBe(6);
  const bracket = await generateStageFixtures(rig.auth, rig.koId);
  expect(bracket.created, "a TBD bracket of 4: two semis and a final").toBe(3);
  for (const f of await fixturesOf(rig.swissId)) {
    await moveFixture(rig.auth, f.id, {
      scheduled_at: slotOf(f.round_no),
      court_id: rig.courts[f.seq_in_round - 1]!,
    });
  }
  const pub = await publishSchedule(rig.auth, rig.divisionId, { acknowledge_warnings: true });
  expect(pub.status).toBe("scheduled");
}

/** Label H = S6 and A = H's round-1 opponent; returns the A-v-H board. */
function labelAH(rig: Rig, rows: FixtureRow[]): { H: string; A: string; ah: FixtureRow } {
  const H = rig.idOf("S6");
  const ah = inRound(rows, 1).find((f) => f.home_entrant_id === H || f.away_entrant_id === H)!;
  const A = ah.home_entrant_id === H ? ah.away_entrant_id! : ah.home_entrant_id!;
  expect(rig.who(A), "round 1 is a fold, so seed 6 meets seed 3").toBe("S3");
  rig.label("S6", "H");
  rig.label("S3", "A");
  return { H, A, ah };
}

/** "S1 v S4" for a board, "S5 bye" for a one-sided row. */
function pairOf(rig: Rig, f: FixtureRow): string {
  return f.away_entrant_id === null && f.ext_key?.endsWith("-bye")
    ? `${rig.who(f.home_entrant_id)} bye`
    : `${rig.who(f.home_entrant_id)} v ${rig.who(f.away_entrant_id)}`;
}

function roundShape(rig: Rig, rows: FixtureRow[], r: number) {
  return inRound(rows, r).map((f) => `${f.ext_key}: ${pairOf(rig, f)}`);
}

function record(rig: Rig, rows: FixtureRow[]) {
  return rows.map((f) => ({
    key: f.ext_key,
    pair: pairOf(rig, f),
    status: f.status,
    outcome: f.outcome ? { ...f.outcome, winner: rig.who(f.outcome.winner) } : null,
    at: iso(f.scheduled_at),
    court: f.court_id ? `C${rig.courts.indexOf(f.court_id) + 1}` : null,
  }));
}

async function seedOf(id: string): Promise<number> {
  const [r] = await sql<{ seed: number }[]>`select seed from entrants where id = ${id}`;
  return r!.seed;
}

/** The scorer's quick result: start, then two game summaries. The better
 *  (lower) seed wins 21-10, 21-10 — so every table below is predictable. */
async function decideBetterSeedWins(auth: AuthCtx, f: FixtureRow): Promise<void> {
  const homeWins = (await seedOf(f.home_entrant_id!)) < (await seedOf(f.away_entrant_id!));
  await scoreEvent(auth, f.id, { expected_seq: 0, type: "core.start", payload: {} });
  for (const seq of [1, 2]) {
    await scoreEvent(auth, f.id, {
      expected_seq: seq,
      type: "badminton.game.summary",
      payload: homeWins ? { home: 21, away: 10 } : { home: 10, away: 21 },
    });
  }
}

/** The Forfeit button: `by` is the side at fault. */
async function forfeitBy(auth: AuthCtx, fixtureId: string, by: string): Promise<void> {
  const state = await getFixtureState(auth, fixtureId);
  await scoreEvent(auth, fixtureId, {
    expected_seq: state.last_seq,
    type: "core.forfeit",
    payload: { by, reason: "walkover" },
  });
}

/** Decide every seated, still-scheduled board of a round except `skip`. */
async function decideRound(rig: Rig, r: number, skip: Set<string> = new Set()): Promise<void> {
  for (const f of inRound(await fixturesOf(rig.swissId), r)) {
    if (skip.has(f.id) || !f.home_entrant_id || !f.away_entrant_id || f.status !== "scheduled") continue;
    await decideBetterSeedWins(rig.auth, f);
  }
}

interface StandingRow {
  entrantId: string;
  rank: number;
  played: number;
  won: number;
  lost: number;
  points: number;
}

/** The swiss table as "rank who played-won-lost points". */
async function swissTable(rig: Rig): Promise<string[]> {
  const s = await getStandings(rig.auth, rig.swissId);
  return (s.rows as StandingRow[]).map(
    (r) => `${r.rank} ${rig.who(r.entrantId)} P${r.played} W${r.won} L${r.lost} ${r.points}pts`,
  );
}

function refusal(e: unknown) {
  return {
    engine: EngineError.is(e, "STAGE_NOT_READY") ? "STAGE_NOT_READY" : undefined,
    http: e instanceof HttpError ? e.status : undefined,
    code: (e as { code?: string }).code,
    message: String((e as Error).message),
  };
}

async function refusalOf(p: Promise<unknown>): Promise<ReturnType<typeof refusal> | "no refusal"> {
  try {
    await p;
    return "no refusal";
  } catch (e) {
    return refusal(e);
  }
}

/**
 * Complete stage → seed proposal → Confirm seeding, as the desk does it. A
 * flagged tie must be picked by the organiser; the pick used here KEEPS the
 * proposal's own order (slot i ← the entrant the proposal put there), which is
 * what pressing Confirm with the tie picker untouched sends.
 */
async function seedKnockout(rig: Rig) {
  const done = await completeStage(rig.auth, rig.swissId);
  expect(done.completed, "the swiss completes once both rounds are settled").toBe(true);
  expect(done.seed_proposal?.status).toBe("draft");
  const proposal = (await getSeedProposal(rig.auth, rig.koId))!;
  const computed = proposal.computed as {
    ties: { slots: string[]; entrantIds: string[]; reason: string }[];
    qualifiers: { rank: number; entrantId: string; destinationSlot: string }[];
  };

  const bare = await refusalOf(confirmSeedProposal(rig.auth, rig.koId, { proposalId: proposal.id }));

  const at = new Map(computed.qualifiers.map((q) => [q.destinationSlot, q.entrantId]));
  const tiePicks = computed.ties.map((t) => ({ slots: t.slots, order: t.slots.map((s) => at.get(s)!) }));
  const confirmed = await confirmSeedProposal(rig.auth, rig.koId, { proposalId: proposal.id, tiePicks });

  const bracket = await fixturesOf(rig.koId);
  const firstRound = Math.min(...bracket.map((f) => f.round_no));
  return {
    proposalRanks: computed.qualifiers
      .slice()
      .sort((a, b) => a.rank - b.rank)
      .map((q) => `${q.rank} ${rig.who(q.entrantId)}`),
    ties: computed.ties.map((t) => ({ reason: t.reason, who: t.entrantIds.map((id) => rig.who(id)) })),
    bareConfirm: bare,
    filled: confirmed.filled,
    semis: inRound(bracket, firstRound).map((f) => pairOf(rig, f)),
  };
}

describe.runIf(HAS_DB)("swiss walkover, Saturday — what the product does", () => {
  // ─── S1 — the recommended order ─────────────────────────────────────────
  it("S1 forfeit A-v-H, decide the rest, withdraw H, Pair next: A keeps the win, R2 is 2 boards + a bye, H never qualifies", async () => {
    const o: Record<string, unknown> = {};
    OBS.S1 = o;
    const rig = await seedRig();
    await prepareAndPublish(rig);
    const started = await startDivision(rig.auth, rig.divisionId);
    expect(started).toMatchObject({ status: "active", started: true, generated: 0 });

    await generateStageFixtures(rig.auth, rig.swissId); // Pair round 1
    const paired = await fixturesOf(rig.swissId);
    const { H, A, ah } = labelAH(rig, paired);
    expect(roundShape(rig, paired, 1)).toEqual(["sw-r1-b1: S1 v S4", "sw-r1-b2: S2 v S5", "sw-r1-b3: A v H"]);
    const r2Before = inRound(paired, 2);

    await forfeitBy(rig.auth, ah.id, H);
    await decideRound(rig, 1, new Set([ah.id]));

    const withdraw = await withdrawEntrantCascade(rig.auth, H);
    o.withdraw = withdraw;
    // Swiss is a TABLE stage: H has played 1 (the forfeit) and has 0 pending,
    // so the engine picks the ≥50% branch — results stand, nothing to award.
    expect(withdraw).toMatchObject({ status: "withdrawn", policy: "walkover", walkovers: 0, voided: 0, skipped_finalized: 0 });

    const afterWithdraw = await fixturesOf(rig.swissId);
    o.r1AfterWithdraw = record(rig, inRound(afterWithdraw, 1));
    // A's walkover survives the withdrawal untouched.
    const ahAfter = afterWithdraw.find((f) => f.id === ah.id)!;
    expect(ahAfter.status).toBe("forfeited");
    expect(ahAfter.outcome).toEqual({ kind: "award", method: "walkover", winner: A });

    const pairNext = await generateStageFixtures(rig.auth, rig.swissId);
    o.pairNext = { created: pairNext.created, reshaped: pairNext.reshaped };
    // Six-shaped round 2 reshaped for five: one board removed, one bye added.
    expect(pairNext.reshaped).toEqual({ matches_added: 0, matches_removed: 1, byes_added: 1, byes_removed: 0 });

    const r2 = await fixturesOf(rig.swissId);
    o.afterPairNext = record(rig, r2);
    expect(roundShape(rig, r2, 2)).toEqual(["sw-r2-b1: S1 v S2", "sw-r2-b2: A v S4", "sw-r2-bye: S5 bye"]);
    const seatedR2 = inRound(r2, 2).flatMap((f) => [f.home_entrant_id, f.away_entrant_id]);
    expect(seatedR2, "H is absent from round 2").not.toContain(H);
    const bye = inRound(r2, 2).find((f) => f.ext_key === "sw-r2-bye")!;
    expect(bye.status).toBe("forfeited");
    expect(bye.outcome).toEqual({ kind: "award", winner: rig.idOf("S5") });
    // The two surviving boards keep their id, time and court; the bye row is
    // new and nobody has scheduled it.
    for (const key of ["sw-r2-b1", "sw-r2-b2"]) {
      const was = r2Before.find((f) => f.ext_key === key)!;
      const now = inRound(r2, 2).find((f) => f.ext_key === key)!;
      expect({ id: now.id, at: iso(now.scheduled_at), court: now.court_id }).toEqual({
        id: was.id,
        at: iso(was.scheduled_at),
        court: was.court_id,
      });
    }
    expect({ at: bye.scheduled_at, court: bye.court_id }).toEqual({ at: null, court: null });
    // The removed board's pinned 10:00 / Court 3 slot went with it.
    expect(inRound(r2, 2).some((f) => f.ext_key === "sw-r2-b3")).toBe(false);

    await decideRound(rig, 2);
    const table = await swissTable(rig);
    o.standingsAfterR2 = table;
    // H is still IN the swiss table after withdrawing — ranked last, with the
    // forfeit counted as a played loss. S1 and A tie on 4 points and are split
    // only by seed (flagged `tieUnbroken`, which is what the seeding tie is).
    expect(table).toEqual([
      "1 S1 P2 W2 L0 4pts",
      "2 A P2 W2 L0 4pts",
      "3 S2 P2 W1 L1 2pts",
      "4 S5 P2 W1 L1 2pts",
      "5 S4 P2 W0 L2 0pts",
      "6 H P1 W0 L1 0pts",
    ]);

    const ko = await seedKnockout(rig);
    o.knockout = ko;
    expect(ko.proposalRanks).toEqual(["1 S1", "2 A", "3 S2", "4 S5"]);
    expect(ko.ties).toEqual([{ reason: "seed", who: ["S1", "A"] }]);
    // Confirm with no pick is refused: the organiser must resolve S1/A.
    expect(ko.bareConfirm).toMatchObject({ http: 422, code: "SEEDING_TIE_UNRESOLVED" });
    expect(ko.filled).toBe(4);
    expect(ko.semis).toEqual(["S1 v S5", "S2 v A"]);
    expect(ko.semis.join(" "), "H is not a qualifier").not.toContain("H");
  });

  // ─── S2 — withdraw first, while A-v-H is still scheduled ────────────────
  it("S2 withdraw H before the forfeit: A-v-H is expunged with no winner, and neither Pair next nor Unpair can move on", async () => {
    const o: Record<string, unknown> = {};
    OBS.S2 = o;
    const rig = await seedRig();
    await prepareAndPublish(rig);
    await startDivision(rig.auth, rig.divisionId);
    await generateStageFixtures(rig.auth, rig.swissId);
    const { H, ah } = labelAH(rig, await fixturesOf(rig.swissId));

    const withdraw = await withdrawEntrantCascade(rig.auth, H);
    o.withdraw = withdraw;
    // H has played 0 of 1 → the table policy's <50% branch: EXPUNGE.
    expect(withdraw).toMatchObject({ status: "withdrawn", policy: "expunge", walkovers: 0, voided: 1 });

    // OBSERVED DEFECT (for the organiser, not for the policy): A gets no win.
    // The board is abandoned with no outcome, so A has 0 points after R1.
    const ahAfter = (await fixturesOf(rig.swissId)).find((f) => f.id === ah.id)!;
    expect(ahAfter.status).toBe("abandoned");
    expect(ahAfter.outcome).toBeNull();

    await decideRound(rig, 1, new Set([ah.id]));
    o.r1 = record(rig, inRound(await fixturesOf(rig.swissId), 1));
    o.standings = await swissTable(rig);
    expect(o.standings).toEqual([
      "1 S1 P1 W1 L0 2pts",
      "2 S2 P1 W1 L0 2pts",
      "3 S4 P1 W0 L1 0pts",
      "4 S5 P1 W0 L1 0pts",
      "5 A P0 W0 L0 0pts",
      "6 H P0 W0 L0 0pts",
    ]);

    // OBSERVED DEFECT: stuck. The pair gate's DECIDED set is
    // decided/finalized/forfeited — `abandoned` is none of those.
    const pairNext = await refusalOf(generateStageFixtures(rig.auth, rig.swissId));
    o.pairNext = pairNext;
    expect(pairNext).toEqual({
      engine: "STAGE_NOT_READY",
      http: undefined,
      code: "STAGE_NOT_READY",
      message: "current swiss round has undecided fixtures",
    });

    const unpair = await refusalOf(unpairSwissRound(rig.auth, rig.swissId));
    o.unpair = unpair;
    expect(unpair).toEqual({
      engine: "STAGE_NOT_READY",
      http: undefined,
      code: "STAGE_NOT_READY",
      message: "swiss round has played results — unpair refused",
    });

    // Beyond the brief, recorded because it is the next thing an organiser
    // would press: Forfeit on the abandoned board is refused as well.
    const forfeit = await refusalOf(forfeitBy(rig.auth, ah.id, H));
    o.forfeitAbandoned = forfeit;
    expect(forfeit).toMatchObject({ code: "WRONG_PHASE", message: "match already over" });

    // Round 2 still sits untouched on its six-shaped shells.
    const rows = await fixturesOf(rig.swissId);
    o.after = record(rig, rows);
    expect(inRound(rows, 2).every((f) => f.home_entrant_id === null && f.away_entrant_id === null)).toBe(true);
    expect(inRound(rows, 2).map((f) => f.ext_key)).toEqual(["sw-r2-b1", "sw-r2-b2", "sw-r2-b3"]);
  });

  // ─── S3 — never withdraw ────────────────────────────────────────────────
  it("S3 forfeit A-v-H and never withdraw: Pair next re-pairs A against H in round 2", async () => {
    const o: Record<string, unknown> = {};
    OBS.S3 = o;
    const rig = await seedRig();
    await prepareAndPublish(rig);
    await startDivision(rig.auth, rig.divisionId);
    await generateStageFixtures(rig.auth, rig.swissId);
    const { H, A, ah } = labelAH(rig, await fixturesOf(rig.swissId));

    await forfeitBy(rig.auth, ah.id, H);
    await decideRound(rig, 1, new Set([ah.id]));

    const pairNext = await generateStageFixtures(rig.auth, rig.swissId);
    o.pairNext = { created: pairNext.created, reshaped: pairNext.reshaped ?? null };
    expect(pairNext.reshaped, "six active entrants — no reshape").toBeUndefined();
    const r2 = await fixturesOf(rig.swissId);
    o.afterPairNext = record(rig, r2);
    // OBSERVED DEFECT: a rematch. H (0 points in the table) is paired with the
    // round-1 winner A, and A meets H twice. Mechanism, from READING
    // `stages.ts` swissGen (not run): a two-sided walkover takes the
    // `kind === "award"` branch, so the pair is never added to `played` and A
    // is recorded as having had a BYE; the implicit-bye pass then finds H in no
    // round-1 row and credits H a pairing point too, lifting H into A's group.
    expect(roundShape(rig, r2, 2)).toEqual(["sw-r2-b1: S1 v S2", "sw-r2-b2: A v H", "sw-r2-b3: S4 v S5"]);
    const hBoard = inRound(r2, 2).find((f) => f.home_entrant_id === H || f.away_entrant_id === H)!;
    expect([hBoard.home_entrant_id, hBoard.away_entrant_id]).toContain(A);

    // H no-shows again.
    await forfeitBy(rig.auth, hBoard.id, H);
    await decideRound(rig, 2, new Set([hBoard.id]));
    const table = await swissTable(rig);
    o.standingsAfterR2 = table;
    expect(table).toEqual([
      "1 S1 P2 W2 L0 4pts",
      "2 A P2 W2 L0 4pts",
      "3 S2 P2 W1 L1 2pts",
      "4 S4 P2 W1 L1 2pts",
      "5 S5 P2 W0 L2 0pts",
      "6 H P2 W0 L2 0pts",
    ]);

    const ko = await seedKnockout(rig);
    o.knockout = ko;
    // A qualifies 2nd on two walkovers without striking a shuttle.
    expect(ko.proposalRanks).toEqual(["1 S1", "2 A", "3 S2", "4 S4"]);
    expect(ko.ties).toEqual([{ reason: "seed", who: ["S2", "S4"] }]);
    expect(ko.bareConfirm).toMatchObject({ http: 422, code: "SEEDING_TIE_UNRESOLVED" });
    expect(ko.semis).toEqual(["S1 v S4", "S2 v A"]);
    expect(ko.semis.join(" ")).not.toContain("H");
  });

  // ─── S4 — before Start ──────────────────────────────────────────────────
  it("S4 published, not started: pair R1, withdraw H, Unpair, Pair next — both rounds reshape and surviving boards keep their slots", async () => {
    const o: Record<string, unknown> = {};
    OBS.S4 = o;
    const rig = await seedRig();
    await prepareAndPublish(rig);
    const [d] = await sql<{ status: string }[]>`select status from divisions where id = ${rig.divisionId}`;
    expect(d!.status).toBe("scheduled");
    const shells = await fixturesOf(rig.swissId);

    await generateStageFixtures(rig.auth, rig.swissId); // Pair round 1
    const { H } = labelAH(rig, await fixturesOf(rig.swissId));

    const withdraw = await withdrawEntrantCascade(rig.auth, H);
    o.withdraw = withdraw;
    expect(withdraw).toMatchObject({ status: "withdrawn", policy: "none", walkovers: 0, voided: 0 });
    // A plain status flip: round 1 still seats H until Unpair.
    expect(roundShape(rig, await fixturesOf(rig.swissId), 1)).toEqual([
      "sw-r1-b1: S1 v S4",
      "sw-r1-b2: S2 v S5",
      "sw-r1-b3: A v H",
    ]);

    const unpair = await unpairSwissRound(rig.auth, rig.swissId);
    o.unpair = unpair;
    expect(unpair).toEqual({ cleared: 3, round: 1 });

    const pairNext = await generateStageFixtures(rig.auth, rig.swissId);
    o.pairNext = { created: pairNext.created, reshaped: pairNext.reshaped };
    // Before Start the reconcile is EAGER: both rounds lose a board and gain a bye.
    expect(pairNext.reshaped).toEqual({ matches_added: 0, matches_removed: 2, byes_added: 2, byes_removed: 0 });

    const rows = await fixturesOf(rig.swissId);
    o.afterPairNext = record(rig, rows);
    expect(roundShape(rig, rows, 1)).toEqual(["sw-r1-b1: S1 v A", "sw-r1-b2: S2 v S4", "sw-r1-bye: S5 bye"]);
    expect(inRound(rows, 2).map((f) => f.ext_key)).toEqual(["sw-r2-b1", "sw-r2-b2", "sw-r2-bye"]);
    expect(inRound(rows, 2).every((f) => f.home_entrant_id === null && f.away_entrant_id === null)).toBe(true);
    expect(rows.flatMap((f) => [f.home_entrant_id, f.away_entrant_id])).not.toContain(H);

    // scheduled_at survival: every surviving board is the same row at the
    // same time on the same court; b3 of each round is gone; the bye rows are
    // new and unscheduled.
    for (const f of rows) {
      const was = shells.find((s) => s.ext_key === f.ext_key);
      if (f.ext_key?.endsWith("-bye")) {
        expect(was).toBeUndefined();
        expect({ at: f.scheduled_at, court: f.court_id }).toEqual({ at: null, court: null });
        continue;
      }
      expect({ id: f.id, at: iso(f.scheduled_at), court: f.court_id }).toEqual({
        id: was!.id,
        at: slotOf(f.round_no),
        court: rig.courts[f.seq_in_round - 1],
      });
    }
    expect(rows.some((f) => f.ext_key === "sw-r1-b3" || f.ext_key === "sw-r2-b3")).toBe(false);
  });
});
