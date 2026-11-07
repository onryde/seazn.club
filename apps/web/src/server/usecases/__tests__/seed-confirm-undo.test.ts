// W4 app-A Task 5 (gap K1): Undo cannot cross a seed confirm. A `timing: "setup"` bracket is drawn before anyone
// qualifies, and the seed confirm (`confirmSeedProposal`) fills its seats through `fillSlot` — a write the division ledger
// never recorded. History knew nothing of it, so an Undo after the confirm inverted the step BEFORE it: the bracket's own
// day-one generation, deleting the seeded draw (and a checkpoint restore, a loop of Undos, did the same). The confirm now
// appends a `seed_confirmed` ledger row — an undo barrier like an organiser's late entry (history.ts `UNDO_BARRIER_TYPES`)
// — and Undo, Redo and Restore refuse to step across it by name: SEED_CONFIRM_NOT_UNDOABLE, 409, "This draw is confirmed
// and can't be undone." (plan Task 5's code and status; the sentence is B1b fix round 1 I1's, since no product path re-opens a confirmed draw).
//
// Every expected seat is read BEFORE the step under test, never from the code under test; every refusal is asserted
// whole, with the rows and the ledger it must leave untouched.
//
// single-sport: badminton — the barrier is a ledger row and the step reads ledger rows only; no sport field is read. The
// second FORMAT (groups_ko) is the sequence's "another shape": a group table feeding a knockout instead of a knockout
// feeding a plate.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { buildTemplateStages } from "@/lib/format-templates";
import type { AuthCtx } from "@/server/api-v1/auth";
import { CreateStage } from "@/server/api-v1/schemas";
import { playBadminton } from "@/server/engine-db/__tests__/helpers/w2b-rig";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import type { LedgerEvent } from "@seazn/engine/history";
import {
  UNDO_BARRIER_TYPES,
  createCheckpoint,
  divisionHistory,
  redoDivision,
  restoreCheckpoint,
  undoBarrierRefusal,
  undoDivision,
} from "../history";
import { moveFixture, putScheduleSettings, startDivision } from "../schedule";
import { completeStage, confirmSeedProposal, createStages, generateStageFixtures } from "../stages";
import { createCourt, createVenue } from "../venues";
import { seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

/** The plan's refusal (Task 5): the code and the status, typed here — never read back from the refusal table. */
const SEED_CONFIRM_REFUSAL = { status: 409, code: "SEED_CONFIRM_NOT_UNDOABLE" } as const;

const SETTINGS = (courts: string[]) => ({
  config: {
    startAt: "2030-08-01T09:00:00.000Z",
    matchMinutes: 30,
    gapMinutes: 0,
    courts,
    perEntrantMinRest: 0,
    blackouts: [],
    sessionWindows: [],
  },
  tz: "UTC",
});
const AT = (h: number) => `2030-08-02T${String(h).padStart(2, "0")}:00:00.000Z`;

interface Row {
  id: string;
  round_no: number;
  seq_in_round: number;
  status: string;
  outcome: unknown;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  scheduled_at: Date | null;
  court_id: string | null;
}
const rowsOf = (stageId: string) =>
  sql<Row[]>`
    select id, round_no, seq_in_round, status, outcome, home_entrant_id, away_entrant_id, scheduled_at, court_id
    from fixtures where stage_id = ${stageId} order by round_no, seq_in_round, id`;
const ledgerOf = (divisionId: string) =>
  sql<{ seq: number; type: string; payload: Record<string, unknown> }[]>`
    select seq::int as seq, type, payload from division_events where division_id = ${divisionId} order by seq`;
const divisionState = async (divisionId: string) =>
  (await sql<{ seq: number; edit_watermark: number | null }[]>`
    select seq, edit_watermark from divisions where id = ${divisionId}`)[0]!;

interface Rig {
  auth: AuthCtx;
  divisionId: string;
  courts: string[];
  /** [source stage, the setup-timing bracket it seeds]. */
  stageIds: [string, string];
  nameOf: Map<string, string>;
  /** A save point taken after Start and BEFORE the bracket's day-one generation: a restore to it walks back across that
   *  generation. */
  checkpointId: string;
}

/** `template` from the REAL catalogue (`buildTemplateStages`), eight seeded entrants (E1 strongest), its schedule saved, the
 *  division Started (which generates the first stage) and the second stage's day-one bracket drawn. Nothing confirmed. */
async function rig(template: "ko_plate" | "groups_ko"): Promise<Rig> {
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: `K1 ${template} ${randomUUID().slice(0, 6)}`,
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
  const venue = await createVenue(auth, { name: "Hall", sort: 0 });
  const courts = [
    (await createCourt(auth, venue.id, { name: "Court 1", sort: 0, tags: [] })).id,
    (await createCourt(auth, venue.id, { name: "Court 2", sort: 1, tags: [] })).id,
  ];
  const entrants = await createEntrants(
    auth,
    division.id,
    Array.from({ length: 8 }, (_, i) => ({ kind: "individual" as const, display_name: `E${i + 1}`, seed: i + 1, members: [] })),
  );
  const drafts = buildTemplateStages(template, { swissRounds: 5, poolCount: 2, legs: 1, qualified: 4 });
  expect(drafts.length, `rig: ${template} is two stages`).toBe(2);
  expect(drafts[1]!.progression?.timing, `rig: ${template}'s second stage is drawn at setup and seeded by a confirm`).toBe("setup");
  const ids: string[] = [];
  for (const [i, d] of drafts.entries()) {
    const [stage] = await createStages(
      auth,
      division.id,
      CreateStage.parse({ seq: i + 1, kind: d.kind, name: d.name, config: d.config, progression: d.progression }),
    );
    ids.push(stage!.id);
  }
  await putScheduleSettings(auth, division.id, SETTINGS(courts));
  await startDivision(auth, division.id);
  expect((await rowsOf(ids[0]!)).length, "rig: Start generated the first stage").toBeGreaterThan(0);
  const checkpoint = await createCheckpoint(auth, division.id, "Before the draw");
  await generateStageFixtures(auth, ids[1]!); // the day-one bracket: every seat TBD
  const bracket = await rowsOf(ids[1]!);
  expect(bracket.length, "rig: the day-one bracket exists").toBeGreaterThan(0);
  expect(bracket.every((r) => r.home_entrant_id === null && r.away_entrant_id === null), "rig: nobody seated before the confirm").toBe(true);
  return {
    auth,
    divisionId: division.id,
    courts,
    stageIds: [ids[0]!, ids[1]!],
    nameOf: new Map(entrants.map((e) => [e.id, e.display_name])),
    checkpointId: checkpoint.id,
  };
}

/** Play the first stage out — the lower-numbered entrant always wins two games to love — and complete it. A knockout's
 *  later rounds fill as their feeders decide, so the loop runs until nothing seated is left to play. */
async function playOutAndComplete(r: Rig): Promise<{ id: string }> {
  const seedNo = (id: string) => Number(r.nameOf.get(id)!.slice(1));
  for (let guard = 0; guard < 10; guard++) {
    const open = (await rowsOf(r.stageIds[0])).filter(
      (f) => f.home_entrant_id !== null && f.away_entrant_id !== null && f.status === "scheduled",
    );
    if (open.length === 0) break;
    for (const f of open) await playBadminton(r.auth, f.id, seedNo(f.home_entrant_id!) < seedNo(f.away_entrant_id!));
  }
  const done = await completeStage(r.auth, r.stageIds[0]);
  expect(done.completed, "rig: the first stage completed").toBe(true);
  expect(done.seed_proposal, "rig: a draft seed proposal for the bracket").toBeTruthy();
  return done.seed_proposal!;
}

/** Confirm the draft, keeping the table's order at any flagged tie (a pick per tie, by seed). */
async function confirm(r: Rig, proposalId: string): Promise<void> {
  const [p] = await sql<{ computed: { ties: { slots: string[]; entrantIds: string[] }[] } }[]>`
    select computed from stage_seed_proposals where id = ${proposalId}`;
  const seedNo = (id: string) => Number(r.nameOf.get(id)!.slice(1));
  const tiePicks = p!.computed.ties.map((t) => ({ slots: t.slots, order: [...t.entrantIds].sort((a, b) => seedNo(a) - seedNo(b)) }));
  await confirmSeedProposal(r.auth, r.stageIds[1], { proposalId, ...(tiePicks.length > 0 ? { tiePicks } : {}) });
  const seated = (await rowsOf(r.stageIds[1])).filter((f) => f.home_entrant_id !== null || f.away_entrant_id !== null);
  expect(seated.length, "premise: the confirm seated the bracket").toBeGreaterThan(0);
}

/** The bracket's first round, seated: who plays whom, by name — the assertion's own record, read before any step. */
async function firstRoundNames(r: Rig): Promise<string[]> {
  const all = await rowsOf(r.stageIds[1]);
  const rows = all.filter((f) => f.round_no === Math.min(...all.map((x) => x.round_no)));
  return rows.map((f) => `${r.nameOf.get(f.home_entrant_id ?? "") ?? "-"} v ${r.nameOf.get(f.away_entrant_id ?? "") ?? "-"}`);
}

describe("W4 T5 K1 undoBarrierRefusal — a seed confirm on a literal ledger (no DB)", () => {
  const ev = (seq: number, type: string, payload: Record<string, unknown> = {}): LedgerEvent => ({ seq, type, payload });
  const gen = (seq: number) => ev(seq, "fixtures_generated", { stage_id: "s", fixture_ids: ["f"] });
  const confirmed = (seq: number) => ev(seq, "seed_confirmed", { stage_id: "s", proposal_id: "p", source: "organiser" });

  it("the plan's barrier table names the seed confirm's code", () => {
    expect(UNDO_BARRIER_TYPES.seed_confirmed).toBe(SEED_CONFIRM_REFUSAL.code);
  });

  it("a confirm after the target is a barrier; at or before it, history the step does not cross", () => {
    expect(undoBarrierRefusal([], 0), "the empty ledger: no barrier").toBeNull();
    const cases: [LedgerEvent[], number, string | null, string][] = [
      [[gen(1), confirmed(2)], 1, SEED_CONFIRM_REFUSAL.code, "the confirm is newer than the generation it would cross"],
      [[gen(1), confirmed(2)], 2, null, "a target AT the confirm's seq crosses nothing"],
      [[confirmed(1), gen(2)], 2, null, "a step newer than the confirm crosses nothing"],
      [[gen(1), confirmed(2), ev(3, "schedule_edited", {})], 3, null, "the edit after the confirm undoes"],
      [[gen(1), confirmed(2), ev(3, "schedule_edited", {})], 1, SEED_CONFIRM_REFUSAL.code, "the step past that edit refuses"],
    ];
    let checked = 0;
    for (const [ledger, target, expected, why] of cases) {
      expect(undoBarrierRefusal(ledger, target), why).toBe(expected);
      checked++;
    }
    expect(checked, "anti-vacuity: every case judged").toBe(5);
  });

  it("names the NEWEST barrier past the target, across the two families, in whatever order the ledger arrives", () => {
    const late = ev(2, "swiss_late_entry", { stage_id: "s", entrant_id: "e", case: "c", round: 2, source: "organiser" });
    const a = [gen(1), late, confirmed(3)];
    expect(undoBarrierRefusal(a, 1)).toBe(SEED_CONFIRM_REFUSAL.code);
    expect(undoBarrierRefusal([...a].reverse(), 1)).toBe(SEED_CONFIRM_REFUSAL.code);
    expect(undoBarrierRefusal([gen(1), confirmed(2), { ...late, seq: 3 }], 1)).toBe("SWISS_LATE_ENTRY_NOT_UNDOABLE");
  });
});

describe.runIf(HAS_DB)("W4 T5 K1 Undo cannot cross a seed confirm", () => {
  it("K1 Undo after a plate confirm: refused SEED_CONFIRM_NOT_UNDOABLE, and the plate's seats and fixtures stand", async () => {
    const r = await rig("ko_plate");
    const proposal = await playOutAndComplete(r);
    await confirm(r, proposal.id);
    const plate = await rowsOf(r.stageIds[1]);
    const main = await rowsOf(r.stageIds[0]);
    // The plate's first round as the confirm drew it: the four first-round losers of the Main draw (E5..E8, each beaten
    // by the seed it met), seated in a 4-line Plate — read here, before the step under test.
    const r1 = await firstRoundNames(r);
    expect(r1.length, "premise: the Plate of four has two first-round lines").toBe(2);
    expect(r1.join(" ").match(/E\d/g)!.sort(), "premise: the Plate seats the Main draw's four first-round losers").toEqual(["E5", "E6", "E7", "E8"]);
    const ledger = await ledgerOf(r.divisionId);
    const state = await divisionState(r.divisionId);

    await expect(undoDivision(r.auth, r.divisionId), "the Undo inverts nothing across the confirm").rejects.toMatchObject(SEED_CONFIRM_REFUSAL);

    expect(await rowsOf(r.stageIds[1]), "the plate keeps every fixture and every seat").toEqual(plate);
    expect(await rowsOf(r.stageIds[0]), "the Main draw is untouched").toEqual(main);
    expect(await ledgerOf(r.divisionId), "a refused step appends nothing").toEqual(ledger);
    expect(await divisionState(r.divisionId), "nor moves the division's token or watermark").toEqual(state);
  }, 300_000);

  it("K1 the confirm appends ONE seed_confirmed row, listed in History as not undoable; a second confirm is refused and appends none", async () => {
    const r = await rig("ko_plate");
    const proposal = await playOutAndComplete(r);
    const before = await divisionState(r.divisionId);
    await confirm(r, proposal.id);
    const rows = (await ledgerOf(r.divisionId)).filter((e) => e.type === "seed_confirmed");
    expect(rows.length, "one barrier row per confirm").toBe(1);
    expect(rows[0]!.payload, "it names the stage and the proposal").toMatchObject({ stage_id: r.stageIds[1], proposal_id: proposal.id });
    const after = await divisionState(r.divisionId);
    expect(after.seq, "the division's token moves with the row").toBe(rows[0]!.seq);
    expect(after.edit_watermark, "the watermark is not touched (a reset would turn a Redo's refusal into NOTHING_TO_REDO)").toBe(before.edit_watermark);
    const listed = (await divisionHistory(r.auth, r.divisionId)).events.find((e) => e.type === "seed_confirmed");
    expect(listed, "History lists the confirm").toMatchObject({ seq: rows[0]!.seq, undoable: false, undone: false });

    // The second call: the proposal is confirmed already — refused, and no second barrier.
    await expect(confirmSeedProposal(r.auth, r.stageIds[1], { proposalId: proposal.id })).rejects.toMatchObject({
      code: "SEEDING_ALREADY_CONFIRMED",
    });
    expect((await ledgerOf(r.divisionId)).filter((e) => e.type === "seed_confirmed").length, "still one barrier").toBe(1);
  }, 300_000);

  it("K1 a schedule edit made AFTER the confirm is still undone and redone; the Undo past it refuses by name", async () => {
    const r = await rig("ko_plate");
    const proposal = await playOutAndComplete(r);
    await confirm(r, proposal.id);
    const seated = await rowsOf(r.stageIds[1]);
    const line = seated.find((f) => f.round_no === Math.min(...seated.map((x) => x.round_no)))!;
    await moveFixture(r.auth, line.id, { scheduled_at: AT(10), court_id: r.courts[0]! });
    const moved = (await rowsOf(r.stageIds[1])).find((f) => f.id === line.id)!;
    expect([moved.scheduled_at?.toISOString(), moved.court_id], "premise: the move placed the line").toEqual([AT(10), r.courts[0]]);

    // The barrier blocks only stepping ACROSS it: the move is newer than the confirm.
    await expect(undoDivision(r.auth, r.divisionId), "the post-confirm move undoes").resolves.toBeDefined();
    const undone = await rowsOf(r.stageIds[1]);
    expect(undone.find((f) => f.id === line.id)!.court_id, "the move is taken back").toBeNull();
    expect(undone.map((f) => [f.id, f.home_entrant_id, f.away_entrant_id]), "the seats stand").toEqual(
      seated.map((f) => [f.id, f.home_entrant_id, f.away_entrant_id]),
    );
    // ...and redoes (its target is newer than the barrier too) — the positive pair for Redo.
    await expect(redoDivision(r.auth, r.divisionId), "the post-confirm move redoes").resolves.toBeDefined();
    expect((await rowsOf(r.stageIds[1])).find((f) => f.id === line.id)!.court_id, "the move is back").toBe(r.courts[0]);

    // Back past the move once more, then the next Undo would cross the confirm.
    await undoDivision(r.auth, r.divisionId);
    const standing = await rowsOf(r.stageIds[1]);
    const ledger = await ledgerOf(r.divisionId);
    await expect(undoDivision(r.auth, r.divisionId), "the Undo past the move crosses the confirm").rejects.toMatchObject(SEED_CONFIRM_REFUSAL);
    await expect(undoDivision(r.auth, r.divisionId), "and again: a refusal changes nothing").rejects.toMatchObject(SEED_CONFIRM_REFUSAL);
    expect(await rowsOf(r.stageIds[1])).toEqual(standing);
    expect(await ledgerOf(r.divisionId)).toEqual(ledger);
  }, 300_000);

  it("K1 Redo across a confirm refuses the same code: an edit undone BEFORE the confirm stays undone", async () => {
    const r = await rig("ko_plate");
    const proposal = await playOutAndComplete(r);
    // Before the confirm: place a TBD plate line, then take the placement back — a Redo is now owed.
    const line = (await rowsOf(r.stageIds[1]))[0]!;
    await moveFixture(r.auth, line.id, { scheduled_at: AT(11), court_id: r.courts[1]! });
    await undoDivision(r.auth, r.divisionId);
    expect((await rowsOf(r.stageIds[1])).find((f) => f.id === line.id)!.court_id, "premise: the placement was undone").toBeNull();
    await confirm(r, proposal.id);
    const plate = await rowsOf(r.stageIds[1]);
    const ledger = await ledgerOf(r.divisionId);

    await expect(redoDivision(r.auth, r.divisionId), "the Redo would replay a step older than the confirm").rejects.toMatchObject(SEED_CONFIRM_REFUSAL);
    expect(await rowsOf(r.stageIds[1]), "the placement stays undone; every seat stands").toEqual(plate);
    expect(await ledgerOf(r.divisionId)).toEqual(ledger);
  }, 300_000);

  it("K1 a restore to a save point taken before the draw refuses by name, and the seeded bracket stands", async () => {
    const r = await rig("ko_plate");
    const proposal = await playOutAndComplete(r);
    await confirm(r, proposal.id);
    const plate = await rowsOf(r.stageIds[1]);
    const ledger = await ledgerOf(r.divisionId);
    // A restore is a loop of Undos back to the save point; its first step inverts the bracket's day-one generation.
    await expect(restoreCheckpoint(r.auth, r.divisionId, r.checkpointId, true)).rejects.toMatchObject(SEED_CONFIRM_REFUSAL);
    expect(await rowsOf(r.stageIds[1])).toEqual(plate);
    expect(await ledgerOf(r.divisionId)).toEqual(ledger);
  }, 300_000);

  it("K1 groups_ko: Undo after the knockout's confirm refuses the same code, and the knockout keeps its seats (a second format)", async () => {
    const r = await rig("groups_ko");
    const proposal = await playOutAndComplete(r);
    await confirm(r, proposal.id);
    const ko = await rowsOf(r.stageIds[1]);
    // Each pool's winner meets the other pool's runner-up (rank_order over wave-major pots, format-templates.ts): the
    // seats are read here, before the step.
    expect(ko.filter((f) => f.home_entrant_id !== null && f.away_entrant_id !== null).length, "premise: both semi-finals seated").toBe(2);
    const ledger = await ledgerOf(r.divisionId);
    await expect(undoDivision(r.auth, r.divisionId)).rejects.toMatchObject(SEED_CONFIRM_REFUSAL);
    expect(await rowsOf(r.stageIds[1])).toEqual(ko);
    expect(await ledgerOf(r.divisionId)).toEqual(ledger);
  }, 300_000);

  it("K1 the empty case: with nothing confirmed, Undo inverts the bracket's day-one generation exactly as before (no barrier)", async () => {
    const r = await rig("ko_plate");
    // No play, no confirm: the newest Undo step is the Plate's own generation, and nothing stands in its way.
    const out = await undoDivision(r.auth, r.divisionId);
    expect(out.applied.type, "the generation is inverted").toBe("fixtures_cleared");
    expect(await rowsOf(r.stageIds[1]), "the day-one Plate is gone").toEqual([]);
    expect((await ledgerOf(r.divisionId)).some((e) => e.type === "seed_confirmed"), "no barrier was ever written").toBe(false);
  }, 300_000);
});
