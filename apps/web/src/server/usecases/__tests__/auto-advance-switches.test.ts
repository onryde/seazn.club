// Swiss auto-advance, plan Task 4 — the two per-stage switches on Postgres (spec docs/superpowers/specs/2026-11-08-swiss-
// auto-advance-design.md §4.1), and the division's read of its auto actions (§4.6).
//
// `setStageAutoAdvance` writes `stages.config.autoPair` (a Swiss stage's) and `stages.config.autoConfirmHandoff` (the TARGET
// stage's: the one whose `progression.timing` is "setup"). Expected values are the spec's and the brief's, typed here, never
// read off the code under test: both switches OFF by default (§2 "Both switches are off by default"); an ON where the switch
// can never act is refused by name, AUTO_PAIR_NOT_SWISS / AUTO_CONFIRM_NO_HANDOFF, 422; an OFF is never refused; a value
// that MOVES writes one `stage_auto_advance_switched { stage_id, key, on }` division event naming the person, and the same
// value again writes nothing.
//
// The switch write must merge into the stored config server-side (scoring.ts's `config || jsonb`), never write back a
// spread of a read: a concurrent writer's key (rank_overrides here) survives.
//
// Sports: the switch is a config key and reads no sport, so the edit itself is swept over generic, badminton and chess
// (boardgame), the plan's Swiss rows; the rest run on generic, the cheapest Swiss, for the reason just given.
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { AUTO_ADVANCE_DONE_VISIBLE_MS } from "@/lib/auto-advance";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { startDivision } from "../schedule";
import { scoreEvent } from "../scoring";
import { createStages, generateStageFixtures, replaceStages } from "../stages";
import { patchSwissStage } from "../swiss-rounds-admin";
import { listDivisionAutoActions, setStageAutoAdvance } from "../auto-advance";
import { GENERIC_CONFIG, seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

/** The event type and the refusals, as the brief names them. */
const SWITCHED = "stage_auto_advance_switched";
const REFUSED = {
  AUTO_PAIR_NOT_SWISS: { status: 422, code: "AUTO_PAIR_NOT_SWISS" },
  AUTO_CONFIRM_NO_HANDOFF: { status: 422, code: "AUTO_CONFIRM_NO_HANDOFF" },
} as const;

type Sport = { sport: string; variant: string };
const GENERIC: Sport = { sport: "generic", variant: "score" };
const SWISS_SPORTS: readonly Sport[] = [GENERIC, { sport: "badminton", variant: "bwf" }, { sport: "boardgame", variant: "classical" }];

interface Rig {
  auth: AuthCtx;
  divisionId: string;
  /** Seq 1: a Swiss of three rounds. */
  swissId: string;
  /** Seq 2: a knockout fed the Swiss's top four, at the given timing. */
  koId: string;
}

function progression(timing: "setup" | "on_complete") {
  return { sources: [{ stage: "previous" as const, take: [{ kind: "rankRange" as const, from: 1, to: 4 }] }], placement: "rank_order" as const, timing };
}

/** A Swiss feeding a knockout, four individual entrants, nothing generated. */
async function rig(sport: Sport = GENERIC, timing: "setup" | "on_complete" = "setup", auth?: AuthCtx): Promise<Rig> {
  const owner = auth ?? (await seedOrg("pro")).auth;
  const tag = randomUUID().slice(0, 6);
  const comp = await createCompetition(owner, { ends_on: "2030-12-31", name: `Auto switches ${tag}`, visibility: "private", branding: {} });
  const division = await createDivision(owner, comp.id, {
    name: "Open",
    slug: `open-${tag}`,
    sport_key: sport.sport,
    variant_key: sport.variant,
    config: sport.sport === "generic" ? GENERIC_CONFIG : {},
  });
  await createEntrants(
    owner,
    division.id,
    Array.from({ length: 4 }, (_, i) => ({
      kind: "individual" as const,
      display_name: `P${i + 1}`,
      seed: i + 1,
      members: [{ new_person: { full_name: `P${i + 1} ${tag}` }, is_captain: false, roles: [] }],
    })),
  );
  const [swiss, ko] = await createStages(owner, division.id, [
    { seq: 1, kind: "swiss", name: "Swiss", config: { rounds: 3 }, progression: null },
    { seq: 2, kind: "knockout", name: "Cup", config: {}, progression: progression(timing) },
  ]);
  return { auth: owner, divisionId: division.id, swissId: swiss!.id, koId: ko!.id };
}

async function configOf(stageId: string): Promise<Record<string, unknown>> {
  const [s] = await sql<{ config: Record<string, unknown> }[]>`select config from stages where id = ${stageId}`;
  return s!.config;
}

async function switchEvents(divisionId: string) {
  return sql<{ seq: number; payload: Record<string, unknown>; actor_id: string | null }[]>`
    select seq, payload, actor_id from division_events where division_id = ${divisionId} and type = ${SWITCHED} order by seq`;
}

/** Everything a refused or a no-op write must leave alone: the stage configs, the ledger and the division's token. */
async function snapshot(r: Rig) {
  const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from division_events where division_id = ${r.divisionId}`;
  const [d] = await sql<{ seq: string | number }[]>`select seq from divisions where id = ${r.divisionId}`;
  return { swiss: await configOf(r.swissId), ko: await configOf(r.koId), events: n, seq: Number(d!.seq) };
}

async function refusal(p: Promise<unknown>): Promise<{ status?: number; code?: string } | undefined> {
  return p.then(
    () => undefined,
    (e: { status?: number; code?: string }) => ({ status: e.status, code: e.code }),
  );
}

describe.skipIf(!HAS_DB)("Swiss auto-advance switches (plan Task 4)", () => {
  it("defaults are off: a fresh Swiss stores neither switch, reads off, and has no rows", async () => {
    const r = await rig();
    // The empty case first. Nothing stored: absent is OFF (spec §2).
    expect(await configOf(r.swissId)).not.toHaveProperty("autoPair");
    expect(await configOf(r.koId)).not.toHaveProperty("autoConfirmHandoff");
    expect(await listDivisionAutoActions(r.auth, r.divisionId)).toEqual([]);
    // Turning a switch that is already off OFF: the answer reads both off, and nothing is written (not even a `false`).
    const before = await snapshot(r);
    expect(await setStageAutoAdvance(r.auth, r.swissId, { autoPair: false })).toEqual({ autoPair: false, autoConfirmHandoff: false, actions: [] });
    expect(await snapshot(r)).toEqual(before);
    expect(await switchEvents(r.divisionId)).toEqual([]);
  });

  it("turning autoPair on stores it and logs one switched event with the person (generic, badminton, chess)", async () => {
    let checked = 0;
    for (const sport of SWISS_SPORTS) {
      const r = await rig(sport);
      const seq0 = (await snapshot(r)).seq;
      const on = await setStageAutoAdvance(r.auth, r.swissId, { autoPair: true });
      expect(on, sport.sport).toEqual({ autoPair: true, autoConfirmHandoff: false, actions: [] });
      expect((await configOf(r.swissId)).autoPair, sport.sport).toBe(true);
      const events = await switchEvents(r.divisionId);
      expect(events.map((e) => [e.payload, e.actor_id]), sport.sport).toEqual([[{ stage_id: r.swissId, key: "autoPair", on: true }, r.auth.userId]]);
      // Plan D7: a history marker, not a change to the board: the division's token does not move.
      expect((await snapshot(r)).seq, `${sport.sport}: divisions.seq`).toBe(seq0);
      // And back off: the value moves again, so a second event, `on: false`, and the stored switch is off.
      const off = await setStageAutoAdvance(r.auth, r.swissId, { autoPair: false });
      expect(off, sport.sport).toEqual({ autoPair: false, autoConfirmHandoff: false, actions: [] });
      expect((await configOf(r.swissId)).autoPair, sport.sport).toBe(false);
      expect((await switchEvents(r.divisionId)).map((e) => e.payload), sport.sport).toEqual([
        { stage_id: r.swissId, key: "autoPair", on: true },
        { stage_id: r.swissId, key: "autoPair", on: false },
      ]);
      checked++;
    }
    expect(checked).toBe(SWISS_SPORTS.length);
  });

  it("same value twice logs once (the second call writes nothing)", async () => {
    const r = await rig();
    await setStageAutoAdvance(r.auth, r.swissId, { autoPair: true });
    const after = await snapshot(r);
    expect(await setStageAutoAdvance(r.auth, r.swissId, { autoPair: true })).toEqual({ autoPair: true, autoConfirmHandoff: false, actions: [] });
    expect(await snapshot(r), "the second call wrote nothing").toEqual(after);
    expect(await switchEvents(r.divisionId)).toHaveLength(1);
    // Both keys in one body, one of them moving: one event, for the key that moved.
    await setStageAutoAdvance(r.auth, r.koId, { autoConfirmHandoff: true });
    const both = await setStageAutoAdvance(r.auth, r.koId, { autoPair: false, autoConfirmHandoff: false });
    expect(both).toEqual({ autoPair: false, autoConfirmHandoff: false, actions: [] });
    expect((await switchEvents(r.divisionId)).map((e) => e.payload)).toEqual([
      { stage_id: r.swissId, key: "autoPair", on: true },
      { stage_id: r.koId, key: "autoConfirmHandoff", on: true },
      { stage_id: r.koId, key: "autoConfirmHandoff", on: false },
    ]);
  });

  it("autoPair on a knockout is refused by name, and on the Swiss it passes (the positive pair)", async () => {
    const r = await rig();
    const before = await snapshot(r);
    expect(await refusal(setStageAutoAdvance(r.auth, r.koId, { autoPair: true }))).toEqual(REFUSED.AUTO_PAIR_NOT_SWISS);
    // Refused whole: a body whose other key is legal writes nothing either.
    expect(await refusal(setStageAutoAdvance(r.auth, r.koId, { autoPair: true, autoConfirmHandoff: true }))).toEqual(REFUSED.AUTO_PAIR_NOT_SWISS);
    expect(await snapshot(r), "a refused write wrote nothing").toEqual(before);
    // Turning it OFF is never refused, on any stage.
    expect(await setStageAutoAdvance(r.auth, r.koId, { autoPair: false })).toMatchObject({ autoPair: false });
    expect(await setStageAutoAdvance(r.auth, r.swissId, { autoPair: true })).toMatchObject({ autoPair: true });
  });

  it("autoConfirmHandoff on a stage with no setup progression is refused, and on a setup target it passes", async () => {
    const r = await rig(GENERIC, "setup");
    const late = await rig(GENERIC, "on_complete");
    const before = await snapshot(r);
    // The Swiss (no progression) and a knockout fed on_complete never get a seed proposal (spec §4.1).
    expect(await refusal(setStageAutoAdvance(r.auth, r.swissId, { autoConfirmHandoff: true }))).toEqual(REFUSED.AUTO_CONFIRM_NO_HANDOFF);
    expect(await refusal(setStageAutoAdvance(late.auth, late.koId, { autoConfirmHandoff: true }))).toEqual(REFUSED.AUTO_CONFIRM_NO_HANDOFF);
    expect(await snapshot(r)).toEqual(before);
    expect(await setStageAutoAdvance(r.auth, r.swissId, { autoConfirmHandoff: false })).toMatchObject({ autoConfirmHandoff: false });
    // The positive pair: the setup target takes it, and it is stored on the TARGET, never on the Swiss that feeds it.
    expect(await setStageAutoAdvance(r.auth, r.koId, { autoConfirmHandoff: true })).toEqual({ autoPair: false, autoConfirmHandoff: true, actions: [] });
    expect((await configOf(r.koId)).autoConfirmHandoff).toBe(true);
    expect(await configOf(r.swissId)).not.toHaveProperty("autoConfirmHandoff");
    expect((await switchEvents(r.divisionId)).map((e) => [e.payload, e.actor_id])).toEqual([
      [{ stage_id: r.koId, key: "autoConfirmHandoff", on: true }, r.auth.userId],
    ]);
  });

  it("the switches flip after the stage has started, where PATCH /stages/{id} refuses", async () => {
    // Plan P1: the switches must flip mid-event, which is why they have their own door.
    const r = await rig();
    await startDivision(r.auth, r.divisionId);
    await generateStageFixtures(r.auth, r.swissId);
    const [board] = await sql<{ id: string }[]>`
      select id from fixtures where stage_id = ${r.swissId} and round_no = 1
        and home_entrant_id is not null and away_entrant_id is not null order by seq_in_round limit 1`;
    expect(board, "premise: round 1 has a seated board").toBeDefined();
    await scoreEvent(r.auth, board!.id, { expected_seq: 0, type: "core.start", payload: {} });
    expect(await refusal(patchSwissStage(r.auth, r.swissId, { chess: true })), "premise: the stage has started").toMatchObject({ code: "SWISS_CHESS_LOCKED" });
    expect(await setStageAutoAdvance(r.auth, r.swissId, { autoPair: true })).toMatchObject({ autoPair: true });
    expect(await setStageAutoAdvance(r.auth, r.swissId, { autoPair: false })).toMatchObject({ autoPair: false });
    expect(await switchEvents(r.divisionId)).toHaveLength(2);
  });

  it("switch write does not revert another config key written between its read and its write", async () => {
    const r = await rig();
    const OVERRIDES = [{ entrant_id: randomUUID(), rank: 1 }];
    // A second transaction holds the Swiss's row and merges rank_overrides into it. The switch write reads the config
    // (without the overrides: not committed yet), takes the division lock, and parks on the row. Then the other commits.
    let parked!: () => void;
    const go = new Promise<void>((resolve) => (parked = resolve));
    let holderPid = 0;
    let held!: () => void;
    const isHeld = new Promise<void>((resolve) => (held = resolve));
    const holder = sql.begin(async (t) => {
      const [{ pid }] = await t<{ pid: number }[]>`select pg_backend_pid() as pid`;
      holderPid = pid;
      await t`select id from stages where id = ${r.swissId} for update`;
      await t`update stages set config = config || ${t.json({ rank_overrides: OVERRIDES } as never)} where id = ${r.swissId}`;
      held();
      await go;
    });
    await isHeld;
    // Settled into a value either way, so a failure below never leaves the holder's transaction (and the pool) open.
    const write = setStageAutoAdvance(r.auth, r.swissId, { autoPair: true }).then(
      (v) => ({ ok: true as const, v }),
      (e: unknown) => ({ ok: false as const, e }),
    );
    let waited = false;
    try {
      for (let i = 0; i < 200 && !waited; i++) {
        const [{ n }] = await sql<{ n: number }[]>`
          select count(*)::int as n from pg_stat_activity where ${holderPid} = any(pg_blocking_pids(pid))`;
        waited = n > 0;
        if (!waited) await new Promise((res) => setTimeout(res, 25));
      }
    } finally {
      parked();
      await holder;
    }
    expect(waited, "the switch write parked behind the other writer (otherwise this test proves nothing)").toBe(true);
    const done = await write;
    if (!done.ok) throw done.e;
    expect(done.v).toMatchObject({ autoPair: true });
    const config = await configOf(r.swissId);
    expect(config.autoPair).toBe(true);
    expect(config.rank_overrides, "the other writer's key survived").toEqual(OVERRIDES);
  });

  it("a Format Save (replaceStages) keeps both switches on their slots", async () => {
    // The Format tool's Save deletes and recreates the stage graph (runReplaceStages). A matched slot (same seq, same kind)
    // keeps what the organiser chose for it; without the carry the switches would silently fall back to off.
    const r = await rig();
    await setStageAutoAdvance(r.auth, r.swissId, { autoPair: true });
    await setStageAutoAdvance(r.auth, r.koId, { autoConfirmHandoff: true });
    const body = [
      { seq: 1, kind: "swiss" as const, name: "Swiss", config: { rounds: 3 }, progression: null },
      { seq: 2, kind: "knockout" as const, name: "Cup", config: {}, progression: progression("setup") },
    ];
    const saved = await replaceStages(r.auth, r.divisionId, body);
    const swiss = saved.find((s) => s.seq === 1)!;
    const ko = saved.find((s) => s.seq === 2)!;
    expect(swiss.id, "premise: the Save recreated the stage").not.toBe(r.swissId);
    expect((await configOf(swiss.id)).autoPair, "the Swiss slot keeps auto-pair").toBe(true);
    expect((await configOf(ko.id)).autoConfirmHandoff, "the target slot keeps auto-confirm").toBe(true);
    // A body that sends its own value wins over the carry (as with every carried key): an explicit off is off.
    const again = await replaceStages(r.auth, r.divisionId, [{ ...body[0]!, config: { rounds: 3, autoPair: false } }, body[1]!]);
    expect((await configOf(again.find((s) => s.seq === 1)!.id)).autoPair).toBe(false);
    expect((await configOf(again.find((s) => s.seq === 2)!.id)).autoConfirmHandoff).toBe(true);
    // A slot whose kind changed starts clean: a league at seq 1 is not dressed in the Swiss's switch.
    await setStageAutoAdvance(r.auth, again.find((s) => s.seq === 1)!.id, { autoPair: true });
    const reshaped = await replaceStages(r.auth, r.divisionId, [{ seq: 1, kind: "league", name: "League", config: { legs: 1 }, progression: null }, body[1]!]);
    expect(await configOf(reshaped.find((s) => s.seq === 1)!.id)).not.toHaveProperty("autoPair");
    expect((await configOf(reshaped.find((s) => s.seq === 2)!.id)).autoConfirmHandoff, "premise: still a setup target").toBe(true);
    // A target re-fed on_complete gets no seed proposal, so a carried ON would be one the PUT door refuses: not carried.
    const late = await replaceStages(r.auth, r.divisionId, [
      { seq: 1, kind: "league", name: "League", config: { legs: 1 }, progression: null },
      { ...body[1]!, progression: progression("on_complete") },
    ]);
    expect(await configOf(late.find((s) => s.seq === 2)!.id)).not.toHaveProperty("autoConfirmHandoff");
  });
});

describe.skipIf(!HAS_DB)("listDivisionAutoActions (plan Task 4)", () => {
  // No writer arms a row before Task 5, so the rows here are written by SQL in V497's shape.
  async function insertRow(r: Rig, row: {
    stageId: string;
    kind: "pair_round" | "complete_stage" | "confirm_handoff";
    state: string;
    targetRound?: number | null;
    proposalId?: string | null;
    dueAt?: string | null;
    blockedCode?: string | null;
    detail?: unknown;
    doneAgoMs?: number | null;
    result?: unknown;
    updatedAgoMs?: number;
  }): Promise<string> {
    const [{ org_id }] = await sql<{ org_id: string }[]>`select org_id from divisions where id = ${r.divisionId}`;
    const [made] = await sql<{ id: string }[]>`
      insert into stage_auto_actions (org_id, division_id, stage_id, kind, target_round, target_proposal_id, state, due_at,
                                      blocked_code, detail, done_at, result, updated_at)
      values (${org_id}, ${r.divisionId}, ${row.stageId}, ${row.kind}, ${row.targetRound ?? null}, ${row.proposalId ?? null},
              ${row.state}, ${row.dueAt ?? null}, ${row.blockedCode ?? null},
              ${row.detail === undefined ? null : sql.json(row.detail as never)},
              ${row.doneAgoMs === undefined || row.doneAgoMs === null ? null : sql`now() - make_interval(secs => ${row.doneAgoMs / 1000}::float8)`},
              ${row.result === undefined ? null : sql.json(row.result as never)},
              now() - make_interval(secs => ${(row.updatedAgoMs ?? 0) / 1000}::float8))
      returning id`;
    return made!.id;
  }

  it("empty case first: a division with no rows lists none", async () => {
    const r = await rig();
    expect(await listDivisionAutoActions(r.auth, r.divisionId)).toEqual([]);
  });

  it("lists every live row and a done row inside the window, newest first, in the API's shape", async () => {
    const r = await rig();
    const other = await rig(GENERIC, "setup", r.auth);
    const [{ org_id }] = await sql<{ org_id: string }[]>`select org_id from divisions where id = ${r.divisionId}`;
    const [proposal] = await sql<{ id: string }[]>`
      insert into stage_seed_proposals (org_id, stage_id, computed, status)
      values (${org_id}, ${r.koId}, ${sql.json({ qualifiers: [], ties: [] })}, 'draft') returning id`;
    const due = new Date(Date.now() + 45_000);
    const waiting = await insertRow(r, { stageId: r.swissId, kind: "pair_round", state: "waiting", targetRound: 2, detail: { openBoards: [{ round: 1, board: 2 }] }, updatedAgoMs: 4_000 });
    const pausedId = await insertRow(r, { stageId: r.koId, kind: "confirm_handoff", state: "paused", proposalId: proposal!.id, dueAt: due.toISOString(), updatedAgoMs: 3_000 });
    // V497's window, typed from the constant's declaration (spec §4.6, 10 minutes): one minute inside it and one outside.
    const recent = await insertRow(r, { stageId: r.swissId, kind: "complete_stage", state: "done", targetRound: 3, doneAgoMs: AUTO_ADVANCE_DONE_VISIBLE_MS - 60_000, result: { by: "person" }, updatedAgoMs: 2_000 });
    await insertRow(r, { stageId: r.swissId, kind: "complete_stage", state: "done", targetRound: 2, doneAgoMs: AUTO_ADVANCE_DONE_VISIBLE_MS + 60_000, result: { by: "person" }, updatedAgoMs: 1_000 });
    // Finished but not done: a cancelled row is history, never on the banner, however recent.
    await insertRow(r, { stageId: r.swissId, kind: "pair_round", state: "cancelled", targetRound: 1, result: { reason: "skip" }, updatedAgoMs: 0 });
    // Another division's live row stays out.
    await insertRow(other, { stageId: other.swissId, kind: "pair_round", state: "pending", targetRound: 2, dueAt: due.toISOString() });

    const listed = await listDivisionAutoActions(r.auth, r.divisionId);
    expect(listed.map((a) => a.id), "newest first: the recent done row, the paused one, the waiting one").toEqual([recent, pausedId, waiting]);
    const paused = listed.find((a) => a.id === pausedId)!;
    expect(paused).toEqual({
      id: pausedId,
      stageId: r.koId,
      kind: "confirm_handoff",
      state: "paused",
      targetRound: null,
      proposalId: proposal!.id,
      dueAt: due.toISOString(),
      doneAt: null,
      blockedCode: null,
      detail: null,
      result: null,
      updatedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/),
    });
    expect(listed.find((a) => a.id === waiting)).toMatchObject({ targetRound: 2, proposalId: null, dueAt: null, detail: { openBoards: [{ round: 1, board: 2 }] } });
    expect(listed.find((a) => a.id === recent)).toMatchObject({ state: "done", doneAt: expect.any(String), result: { by: "person" } });

    // Each live state is listed (one row moved through all four, counted), and the PUT's answer carries the stage's own rows.
    let checked = 0;
    for (const state of ["waiting", "pending", "paused", "blocked"] as const) {
      await sql`update stage_auto_actions set state = ${state}, due_at = now() + interval '1 minute',
                  blocked_code = ${state === "blocked" ? "STAGE_NOT_READY" : null}, updated_at = now() where id = ${waiting}`;
      expect((await listDivisionAutoActions(r.auth, r.divisionId)).find((a) => a.id === waiting)?.state, state).toBe(state);
      checked++;
    }
    expect(checked).toBe(4);
    const answer = await setStageAutoAdvance(r.auth, r.swissId, { autoPair: true });
    expect(answer.actions.map((a) => a.id).sort(), "the Swiss's rows only").toEqual([waiting, recent].sort());
  });
});
