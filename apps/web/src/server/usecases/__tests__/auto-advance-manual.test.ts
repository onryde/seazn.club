// Swiss auto-advance, plan Task 6 — a person's hand on the clock, on Postgres (spec
// docs/superpowers/specs/2026-11-08-swiss-auto-advance-design.md §4.2, §4.6, §5.4, §5.13, §5.18; D22):
//
//   - a manual Pair, Complete or Confirm retires the live row whose target it reached, as `done {by: "person"}`, IN ITS OWN
//     TRANSACTION, and then asks for the after-commit arming (`rearmAfterCommit`) so the NEXT target arms;
//   - Skip (`skipAutoAction`) closes a live pair_round / complete_stage row as `cancelled {reason: "skip"}`, and only a skip
//     is sticky; confirm is never skippable (stopped by pausing or the switch);
//   - an Unpair of a round, or an Undo of its Pair from History, records the same sticky skip (`by: "unpair"` / `"undo"`), so
//     the clock never re-pairs a round the organiser deliberately pulled back.
//
// Every rig is seeded through the usecases, every board decided through `scoreEvent`, every manual action through its own
// usecase (the one its route calls). To see the in-transaction retire apart from the after-commit arming, this file wraps
// `rearmAfterCommit` (the real one, by default) so a test can switch the after-commit half off for ONE call and watch what
// the action's own transaction did; it also records each call, so the wiring is asserted, not assumed. SQL writes the table
// only for the clock (Task 8's lease), named where it happens.
//
// Expected values are the spec's and the plan's, never the code's: D1's `done {by: "person"}`, the reasons `skip` /
// `superseded`, the codes AUTO_ADVANCE_NOTHING_TO_SKIP (409) and AUTO_ADVANCE_CONFIRM_NOT_SKIPPABLE (422), the window
// `resolveSettleMs()` ± the brief's 2 s.
//
// Sports: the sequences read no sport (a board is seated, decided, or not), so they run on generic, the cheapest Swiss; the
// skip path also runs on the plan's Swiss rows — generic, badminton and chess (boardgame) — with the count asserted.
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";

const after = vi.hoisted(() => ({ suppress: false, calls: [] as { orgId: string; stageId: string }[] }));
vi.mock("../auto-advance", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../auto-advance")>();
  return {
    ...actual,
    rearmAfterCommit: async (orgId: string, stageId: string, opts?: { restartPending?: boolean }) => {
      after.calls.push({ orgId, stageId });
      if (after.suppress) return;
      return actual.rearmAfterCommit(orgId, stageId, opts);
    },
  };
});

import { LIVE_AUTO_ACTION_STATES } from "@/lib/auto-advance";
import { HttpError } from "@/lib/errors";
import { sql, withTenant } from "@/lib/db";
import { systemAuth, type AuthCtx } from "@/server/api-v1/auth";
import { resolveSettleMs } from "@/server/auto-advance/settle";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { redoDivision, undoDivision } from "../history";
import { startDivision } from "../schedule";
import { scoreEvent } from "../scoring";
import { completeStage, confirmSeedProposal, createStages, generateStageFixtures, unpairSwissRound } from "../stages";
import { addSwissRound, finishSwissNow } from "../swiss-rounds-admin";
import { rearmAutoActions, recordAutoSkip, setStageAutoAdvance, skipAutoAction } from "../auto-advance";
import { GENERIC_CONFIG, seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

type Sport = { sport: string; variant: string };
const GENERIC: Sport = { sport: "generic", variant: "score" };
const SWISS_SPORTS: readonly Sport[] = [GENERIC, { sport: "badminton", variant: "bwf" }, { sport: "boardgame", variant: "classical" }];
const LIVE = new Set<string>(LIVE_AUTO_ACTION_STATES);
/** The brief's tolerance around `now + settle`. */
const WINDOW_MS = 2_000;
/** D1: a row whose target a person reached. */
const BY_PERSON = { by: "person" };

interface Board {
  id: string;
  round_no: number;
  seq_in_round: number;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  status: string;
}

interface ActionRow {
  id: string;
  kind: string;
  state: string;
  target_round: number | null;
  target_proposal_id: string | null;
  due_at: Date | null;
  result: Record<string, unknown> | null;
  lease_until: Date | null;
  done_at: Date | null;
}

interface Rig {
  auth: AuthCtx;
  sport: Sport;
  divisionId: string;
  swissId: string;
}

async function competitionDivision(auth: AuthCtx, sport: Sport, entrants: number) {
  const tag = randomUUID().slice(0, 6);
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: `Auto manual ${tag}`, visibility: "private", branding: {} });
  const division = await createDivision(auth, comp.id, {
    name: "Open",
    slug: `open-${tag}`,
    sport_key: sport.sport,
    variant_key: sport.variant,
    config: sport.sport === "generic" ? GENERIC_CONFIG : {},
  });
  const made = await createEntrants(
    auth,
    division.id,
    Array.from({ length: entrants }, (_, i) => ({
      kind: "individual" as const,
      display_name: `P${i + 1}`,
      seed: i + 1,
      members: [{ new_person: { full_name: `P${i + 1} ${tag}` }, is_captain: false, roles: [] }],
    })),
  );
  return { divisionId: division.id, entrantIds: made.map((e) => e.id) };
}

/** A Swiss of `rounds` rounds (4 by default) over six individuals (four rounds need more than four players: a field of n
 *  pairs at most n − 1 rounds), nothing generated; `autoPair` turned on through the PUT's usecase. */
async function swissRig(opts: { sport?: Sport; rounds?: number; autoPair?: boolean } = {}): Promise<Rig> {
  const sport = opts.sport ?? GENERIC;
  const { auth } = await seedOrg("pro");
  const { divisionId } = await competitionDivision(auth, sport, 6);
  const [swiss] = await createStages(auth, divisionId, [{ seq: 1, kind: "swiss", name: "Swiss", config: { rounds: opts.rounds ?? 4 }, progression: null }]);
  const r: Rig = { auth, sport, divisionId, swissId: swiss!.id };
  if (opts.autoPair ?? true) await setStageAutoAdvance(auth, r.swissId, { autoPair: true });
  return r;
}

const start = (r: Rig) => startDivision(r.auth, r.divisionId);
/** The organiser's Pair (the route's usecase): round 1, then each next round. */
const pair = (r: Rig) => generateStageFixtures(r.auth, r.swissId);

async function fixturesOf(stageId: string): Promise<Board[]> {
  return sql<Board[]>`
    select id, round_no, seq_in_round, home_entrant_id, away_entrant_id, status
      from fixtures where stage_id = ${stageId} order by round_no, seq_in_round`;
}

/** The round's seated two-sided boards, in board order. */
async function boards(stageId: string, round: number): Promise<Board[]> {
  const rows = (await fixturesOf(stageId)).filter((f) => f.round_no === round && f.home_entrant_id !== null && f.away_entrant_id !== null);
  expect(rows.length, `rig: round ${round} has seated boards`).toBeGreaterThan(0);
  return rows;
}

async function seatedIn(stageId: string, round: number): Promise<number> {
  return (await fixturesOf(stageId)).filter((f) => f.round_no === round && (f.home_entrant_id !== null || f.away_entrant_id !== null)).length;
}

async function tip(fixtureId: string): Promise<number> {
  const [{ n }] = await sql<{ n: number }[]>`select coalesce(max(seq), 0)::int as n from score_events where fixture_id = ${fixtureId}`;
  return n;
}

async function post(auth: AuthCtx, fixtureId: string, type: string, payload: Record<string, unknown> = {}) {
  return scoreEvent(auth, fixtureId, { expected_seq: await tip(fixtureId), type, payload });
}

/** A played result through the sport's own scoring events; `home` wins unless told otherwise. Answers the deciding event. */
async function win(r: Rig, f: Board, home = true): Promise<string> {
  if ((await tip(f.id)) === 0) await post(r.auth, f.id, "core.start");
  if (r.sport.sport === "boardgame") {
    return (await post(r.auth, f.id, "boardgame.result", { winner: home ? f.home_entrant_id : f.away_entrant_id, method: "resign" })).event_id;
  }
  if (r.sport.sport === "badminton") {
    const game = home ? { home: 21, away: 10 } : { home: 10, away: 21 };
    await post(r.auth, f.id, "badminton.game.summary", game);
    return (await post(r.auth, f.id, "badminton.game.summary", game)).event_id;
  }
  return (await post(r.auth, f.id, "generic.result", home ? { p1Score: 2, p2Score: 0 } : { p1Score: 0, p2Score: 2 })).event_id;
}

/** Every seated board of the round decided; answers each board's deciding event. */
async function decideRound(r: Rig, round: number): Promise<Map<string, string>> {
  const decisive = new Map<string, string>();
  for (const f of await boards(r.swissId, round)) decisive.set(f.id, await win(r, f));
  return decisive;
}

/** A correction: the deciding event voided, then the board decided the other way. */
async function correct(r: Rig, f: Board, eventId: string): Promise<void> {
  await post(r.auth, f.id, "core.void", { event_id: eventId });
  await win(r, f, false);
}

async function rowsOf(stageId: string): Promise<ActionRow[]> {
  return sql<ActionRow[]>`
    select id, kind, state, target_round, target_proposal_id, due_at, result, lease_until, done_at
      from stage_auto_actions where stage_id = ${stageId} order by created_at, id`;
}

async function rowById(stageId: string, id: string): Promise<ActionRow> {
  const row = (await rowsOf(stageId)).find((a) => a.id === id);
  expect(row, `row ${id} exists`).toBeDefined();
  return row!;
}

async function liveOf(stageId: string, kind: string): Promise<ActionRow | undefined> {
  const live = (await rowsOf(stageId)).filter((a) => a.kind === kind && LIVE.has(a.state));
  expect(live.length, `at most one live ${kind} row`).toBeLessThanOrEqual(1);
  return live[0];
}

async function expectArmed(row: ActionRow | undefined, label: string): Promise<ActionRow> {
  expect(row, `${label}: a live row`).toBeDefined();
  expect(row!.state, label).toBe("pending");
  const [{ ms }] = await sql<{ ms: number }[]>`
    select (extract(epoch from (due_at - clock_timestamp())) * 1000)::float8 as ms from stage_auto_actions where id = ${row!.id}`;
  const settle = resolveSettleMs();
  expect(ms, `${label}: due in about the settle window (${settle} ms)`).toBeGreaterThanOrEqual(settle - WINDOW_MS);
  expect(ms, `${label}: due in about the settle window (${settle} ms)`).toBeLessThanOrEqual(settle + WINDOW_MS);
  return row!;
}

/** Runs `fn` with the after-commit arming switched off, and answers the stages it asked to arm. */
async function withoutAfterCommit<T>(fn: () => Promise<T>): Promise<{ value: T; asked: string[] }> {
  after.suppress = true;
  after.calls.length = 0;
  try {
    const value = await fn();
    return { value, asked: after.calls.map((c) => c.stageId) };
  } finally {
    after.suppress = false;
  }
}

/** Expects `p` to reject with an HttpError of this status and code. */
async function refusedBy(p: Promise<unknown>, status: number, code: string): Promise<void> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err, `refused ${status} ${code}`).toBeInstanceOf(HttpError);
  expect([(err as HttpError).status, (err as HttpError).code]).toEqual([status, code]);
}

/** A Swiss whose rounds 1 and 2 are decided by hand-paired rounds: pair_round 3 counts down. */
async function roundTwoDecided(opts: { sport?: Sport; rounds?: number; autoPair?: boolean } = {}) {
  const r = await swissRig(opts);
  await start(r);
  await pair(r);
  await decideRound(r, 1);
  await pair(r);
  const r2 = await decideRound(r, 2);
  return { r, r2 };
}

/** A generic league of four (seq 1) feeding a knockout of its top two at setup (seq 2), the knockout's confirm switch on. */
async function confirmRig() {
  const { auth } = await seedOrg("pro");
  const { divisionId, entrantIds } = await competitionDivision(auth, GENERIC, 4);
  const [league] = await createStages(auth, divisionId, [{ seq: 1, kind: "league", name: "L1", config: { legs: 1 }, progression: null }]);
  const [ko] = await createStages(auth, divisionId, [
    {
      seq: 2,
      kind: "knockout",
      name: "Cup",
      config: {},
      progression: { sources: [{ stage: { stageId: league!.id }, take: [{ kind: "rankRange", from: 1, to: 2 }] }], placement: "rank_order", timing: "setup" },
    },
  ]);
  await setStageAutoAdvance(auth, ko!.id, { autoConfirmHandoff: true });
  await generateStageFixtures(auth, ko!.id);
  await startDivision(auth, divisionId);
  const r = { auth, sport: GENERIC, divisionId, swissId: league!.id } as Rig;
  // The entrant earlier in the list wins every board: the table is that order, with no tie at the cut.
  const fixtures = (await fixturesOf(league!.id)).filter((f) => f.home_entrant_id !== null && f.away_entrant_id !== null);
  expect(fixtures.length, "rig: the league is drawn").toBeGreaterThan(0);
  for (const f of fixtures) {
    await post(auth, f.id, "core.start");
    const homeFirst = entrantIds.indexOf(f.home_entrant_id!) < entrantIds.indexOf(f.away_entrant_id!);
    await post(auth, f.id, "generic.result", homeFirst ? { p1Score: 2, p2Score: 0 } : { p1Score: 0, p2Score: 2 });
  }
  const done = await completeStage(auth, league!.id);
  expect(done.seed_proposal, "rig: completing the league drafted the proposal").toBeDefined();
  const armed = await expectArmed(await liveOf(ko!.id, "confirm_handoff"), "rig: the draft counts down");
  expect(armed.target_proposal_id).toBe(done.seed_proposal!.id);
  return { r, auth, koId: ko!.id, leagueId: league!.id, proposalId: done.seed_proposal!.id, armed };
}

describe.skipIf(!HAS_DB)("a manual action retires the clock's row (§4.2, §5.4; plan Task 6)", () => {
  it("manual pair retires the row as done by a person (§5.4); the next round arms; nothing ever double-pairs", async () => {
    const r = await swissRig();
    await start(r);
    await pair(r);
    await decideRound(r, 1);
    const two = await expectArmed(await liveOf(r.swissId, "pair_round"), "round 1 decided");
    expect(two.target_round).toBe(2);

    // Round 2 paired by hand inside its countdown: its row is done by a person, and round 3 arms at once (waiting on
    // round 2's boards) — the whole path, after-commit arming included.
    await pair(r);
    const retired = await rowById(r.swissId, two.id);
    expect([retired.state, retired.result, retired.done_at !== null]).toEqual(["done", BY_PERSON, true]);
    const three = await liveOf(r.swissId, "pair_round");
    expect([three?.state, three?.target_round], "round 3 waits on round 2").toEqual(["waiting", 3]);
    // Nothing double-pairs: round 2 holds one pairing, no row targets it any more, and a sweep-shaped re-derive arms
    // nothing for it.
    const r2Seated = await seatedIn(r.swissId, 2);
    expect(r2Seated, "premise: round 2 seated").toBeGreaterThan(0);
    await withTenant(r.auth.orgId, (tx) => rearmAutoActions(tx, r.swissId, { restartPending: false }));
    expect((await rowsOf(r.swissId)).filter((a) => LIVE.has(a.state) && a.target_round === 2), "nothing live targets round 2").toEqual([]);
    expect(await seatedIn(r.swissId, 2), "one pairing of round 2").toBe(r2Seated);
    // A second press while round 2 plays (refused or a no-op; either way) seats nothing.
    await pair(r).catch(() => undefined);
    expect(await seatedIn(r.swissId, 3), "no second pairing").toBe(0);

    // Round 3 arms once round 2 settles.
    await decideRound(r, 2);
    const pending = await expectArmed(await liveOf(r.swissId, "pair_round"), "round 2 decided");
    expect([pending.id, pending.target_round]).toEqual([three!.id, 3]);

    // In the Pair's OWN transaction: with the after-commit arming off for this one call, the row is retired anyway.
    const { asked } = await withoutAfterCommit(() => pair(r));
    const done = await rowById(r.swissId, pending.id);
    expect([done.state, done.result, done.done_at !== null], "retired in the Pair's transaction").toEqual(["done", BY_PERSON, true]);
    expect(await liveOf(r.swissId, "pair_round"), "the next target is the after-commit arming's, here switched off").toBeUndefined();
    expect(asked, "the Pair asks for the after-commit arming of its stage").toContain(r.swissId);
  });

  it("a leased row is the firer's: a manual Pair leaves it alone (D2)", async () => {
    const { r } = await roundTwoDecided();
    const three = await expectArmed(await liveOf(r.swissId, "pair_round"), "round 2 decided");
    // A firer holds the row (Task 8's claim; SQL stands in).
    await sql`update stage_auto_actions set lease_until = now() + interval '2 minutes' where id = ${three.id}`;
    await pair(r);
    const held = await rowById(r.swissId, three.id);
    expect([held.state, held.result, held.lease_until !== null], "the leased row is untouched").toEqual(["pending", null, true]);
  });

  it("manual complete retires complete_stage, in the completion's own transaction", async () => {
    const { r } = await roundTwoDecided({ rounds: 2 });
    const complete = await expectArmed(await liveOf(r.swissId, "complete_stage"), "the last round decided");
    expect(complete.target_round, "the stage's last round").toBe(2);
    const { value, asked } = await withoutAfterCommit(() => completeStage(r.auth, r.swissId));
    expect(value.completed).toBe(true);
    const done = await rowById(r.swissId, complete.id);
    expect([done.state, done.result, done.done_at !== null]).toEqual(["done", BY_PERSON, true]);
    expect(asked, "the completion asks for the after-commit arming of its stage").toContain(r.swissId);
    expect((await rowsOf(r.swissId)).filter((a) => LIVE.has(a.state)), "nothing live on a complete stage").toEqual([]);
  });

  it("manual confirm retires a pending confirm, in the confirm's own transaction", async () => {
    const c = await confirmRig();
    const { asked } = await withoutAfterCommit(() => confirmSeedProposal(c.auth, c.koId, { proposalId: c.proposalId }));
    const done = await rowById(c.koId, c.armed.id);
    expect([done.state, done.result, done.done_at !== null]).toEqual(["done", BY_PERSON, true]);
    expect(asked, "the confirm asks for the after-commit arming of its stage").toContain(c.koId);
    expect(await liveOf(c.koId, "confirm_handoff")).toBeUndefined();
  });

  it("add a round during the completion countdown (§5.18): the stage stays open, the new round counts down", async () => {
    const { r } = await roundTwoDecided({ rounds: 2 });
    const complete = await expectArmed(await liveOf(r.swissId, "complete_stage"), "the last round decided");
    const added = await addSwissRound(r.auth, r.swissId);
    expect(added.rounds).toBe(3);
    const [stage] = await sql<{ status: string }[]>`select status from stages where id = ${r.swissId}`;
    expect(stage!.status, "the stage stays open").toBe("active");
    const superseded = await rowById(r.swissId, complete.id);
    expect([superseded.state, superseded.result]).toEqual(["cancelled", { reason: "superseded" }]);
    // Round 2 is complete, so the new round 3 counts down at once.
    const three = await expectArmed(await liveOf(r.swissId, "pair_round"), "the added round");
    expect(three.target_round).toBe(3);
  });

  it("finish now retires complete_stage as done by a person", async () => {
    const { r } = await roundTwoDecided({ rounds: 2 });
    const complete = await expectArmed(await liveOf(r.swissId, "complete_stage"), "the last round decided");
    const finished = await finishSwissNow(r.auth, r.swissId);
    expect([finished.completed, finished.finished_after]).toEqual([true, 2]);
    const done = await rowById(r.swissId, complete.id);
    expect([done.state, done.result]).toEqual(["done", BY_PERSON]);
    expect((await rowsOf(r.swissId)).filter((a) => LIVE.has(a.state))).toEqual([]);
  });
});

describe.skipIf(!HAS_DB)("Skip (§4.2: sticky for its target; §4.6; D22; plan Task 6)", () => {
  it("nothing live is nothing to skip (the empty case first); skip twice: the second is 409 by name", async () => {
    const r = await swissRig();
    // The empty case: the switch is on and nothing is generated, so no row exists.
    await refusedBy(skipAutoAction(r.auth, r.swissId, "pair_round"), 409, "AUTO_ADVANCE_NOTHING_TO_SKIP");
    expect(await rowsOf(r.swissId), "the refusal wrote nothing").toEqual([]);
    await start(r);
    await pair(r);
    await decideRound(r, 1);
    const two = await expectArmed(await liveOf(r.swissId, "pair_round"), "round 1 decided");
    // Another kind than the live one is nothing to skip either.
    await refusedBy(skipAutoAction(r.auth, r.swissId, "complete_stage"), 409, "AUTO_ADVANCE_NOTHING_TO_SKIP");
    const view = await skipAutoAction(r.auth, r.swissId, "pair_round");
    expect(view).toMatchObject({ id: two.id, kind: "pair_round", state: "cancelled", targetRound: 2, result: { reason: "skip", by: "person" } });
    const before = await rowsOf(r.swissId);
    await refusedBy(skipAutoAction(r.auth, r.swissId, "pair_round"), 409, "AUTO_ADVANCE_NOTHING_TO_SKIP");
    expect(await rowsOf(r.swissId), "the second skip wrote nothing").toEqual(before);
    expect(before.filter((a) => a.state === "cancelled"), "one skip row").toHaveLength(1);
  });

  it("skip is sticky for its round only (§5.13): a correction never re-arms it; the next round arms normally", async () => {
    const { r, r2 } = await roundTwoDecided();
    const three = await expectArmed(await liveOf(r.swissId, "pair_round"), "round 2 decided");
    await skipAutoAction(r.auth, r.swissId, "pair_round");
    expect(await liveOf(r.swissId, "pair_round"), "skipped").toBeUndefined();
    // A round-2 correction: round 3 stays unarmed.
    const [f] = await boards(r.swissId, 2);
    await correct(r, f!, r2.get(f!.id)!);
    expect(await liveOf(r.swissId, "pair_round"), "a correction never re-arms a skipped round").toBeUndefined();
    // Paired by hand: the skip row is history and stays a skip; round 4 waits on round 3.
    await pair(r);
    const skip = await rowById(r.swissId, three.id);
    expect([skip.state, skip.result]).toEqual(["cancelled", { reason: "skip", by: "person" }]);
    expect((await liveOf(r.swissId, "pair_round"))?.target_round).toBe(4);
    await decideRound(r, 3);
    const four = await expectArmed(await liveOf(r.swissId, "pair_round"), "round 3 decided");
    expect(four.target_round).toBe(4);
  });

  it("skip complete_stage is sticky too: a last-round correction never re-arms it, and Complete by hand still completes", async () => {
    const { r, r2 } = await roundTwoDecided({ rounds: 2 });
    const complete = await expectArmed(await liveOf(r.swissId, "complete_stage"), "the last round decided");
    const view = await skipAutoAction(r.auth, r.swissId, "complete_stage");
    expect(view).toMatchObject({ id: complete.id, kind: "complete_stage", state: "cancelled", result: { reason: "skip", by: "person" } });
    const [f] = await boards(r.swissId, 2);
    await correct(r, f!, r2.get(f!.id)!);
    expect(await liveOf(r.swissId, "complete_stage"), "a correction never re-arms a skipped completion").toBeUndefined();
    const [stage] = await sql<{ status: string }[]>`select status from stages where id = ${r.swissId}`;
    expect(stage!.status, "skipped, not completed").toBe("active");
    // The person completes it: the skip stays history, and nothing is live on a complete stage.
    expect((await completeStage(r.auth, r.swissId)).completed).toBe(true);
    const skip = await rowById(r.swissId, complete.id);
    expect([skip.state, skip.result]).toEqual(["cancelled", { reason: "skip", by: "person" }]);
    expect((await rowsOf(r.swissId)).filter((a) => LIVE.has(a.state))).toEqual([]);
  });

  it("switch off then on re-arms a switch-off cancel, never a skip", async () => {
    const { r } = await roundTwoDecided();
    await expectArmed(await liveOf(r.swissId, "pair_round"), "round 2 decided");
    await setStageAutoAdvance(r.auth, r.swissId, { autoPair: false });
    await setStageAutoAdvance(r.auth, r.swissId, { autoPair: true });
    const again = await expectArmed(await liveOf(r.swissId, "pair_round"), "a switch-off is not sticky");
    expect(again.target_round).toBe(3);
    await skipAutoAction(r.auth, r.swissId, "pair_round");
    await setStageAutoAdvance(r.auth, r.swissId, { autoPair: false });
    await setStageAutoAdvance(r.auth, r.swissId, { autoPair: true });
    expect(await liveOf(r.swissId, "pair_round"), "a skip is").toBeUndefined();
  });

  it("skip confirm is refused by name (D22): the confirm row keeps counting down", async () => {
    const c = await confirmRig();
    await refusedBy(skipAutoAction(c.auth, c.koId, "confirm_handoff"), 422, "AUTO_ADVANCE_CONFIRM_NOT_SKIPPABLE");
    const kept = await rowById(c.koId, c.armed.id);
    expect([kept.state, kept.due_at?.getTime()], "untouched").toEqual(["pending", c.armed.due_at?.getTime()]);
  });

  it("recordAutoSkip is idempotent: twice for a round with no live row writes one skip", async () => {
    const r = await swissRig();
    await withTenant(r.auth.orgId, async (tx) => {
      await recordAutoSkip(tx, r.swissId, "pair_round", 2, "unpair");
      await recordAutoSkip(tx, r.swissId, "pair_round", 2, "unpair");
    });
    const rows = await rowsOf(r.swissId);
    expect(rows.map((a) => [a.kind, a.state, a.target_round, a.result])).toEqual([["pair_round", "cancelled", 2, { reason: "skip", by: "unpair" }]]);
  });

  it("skip per sport: Swiss × generic, badminton and chess", async () => {
    let checked = 0;
    for (const sport of SWISS_SPORTS) {
      const r = await swissRig({ sport });
      await start(r);
      await pair(r);
      const r1 = await decideRound(r, 1);
      const two = await expectArmed(await liveOf(r.swissId, "pair_round"), sport.sport);
      const view = await skipAutoAction(r.auth, r.swissId, "pair_round");
      expect([view.id, view.state, view.result], sport.sport).toEqual([two.id, "cancelled", { reason: "skip", by: "person" }]);
      const [f] = await boards(r.swissId, 1);
      await correct(r, f!, r1.get(f!.id)!);
      expect(await liveOf(r.swissId, "pair_round"), `${sport.sport}: sticky through a correction`).toBeUndefined();
      checked++;
    }
    expect(checked).toBe(SWISS_SPORTS.length);
    expect(checked).toBe(3);
  });
});

describe.skipIf(!HAS_DB)("an Unpair, or an Undo of the Pair, is a sticky skip (Review Focus 1; plan Task 6)", () => {
  it("unpair records a sticky skip; pairing the round again by hand retires nothing and arms the next as waiting", async () => {
    const { r, r2 } = await roundTwoDecided();
    await expectArmed(await liveOf(r.swissId, "pair_round"), "round 2 decided");
    await pair(r);
    expect((await liveOf(r.swissId, "pair_round"))?.target_round, "premise: round 3 paired, round 4 waits").toBe(4);
    const unpaired = await unpairSwissRound(r.auth, r.swissId);
    expect(unpaired.round).toBe(3);
    const skips = (await rowsOf(r.swissId)).filter((a) => a.state === "cancelled" && a.result?.reason === "skip");
    expect(skips.map((a) => [a.kind, a.target_round, a.result])).toEqual([["pair_round", 3, { reason: "skip", by: "unpair" }]]);
    expect(await liveOf(r.swissId, "pair_round"), "no pending row for round 3, and nothing else live").toBeUndefined();
    // Sticky: a round-2 correction does not re-arm round 3, so nothing re-pairs it 60 s later.
    const [f] = await boards(r.swissId, 2);
    await correct(r, f!, r2.get(f!.id)!);
    expect(await liveOf(r.swissId, "pair_round"), "a correction never re-arms the unpaired round").toBeUndefined();

    // The positive pair: Pair round 3 again by hand retires nothing and arms round 4 as waiting.
    const doneBefore = (await rowsOf(r.swissId)).filter((a) => a.state === "done").length;
    await pair(r);
    expect((await rowsOf(r.swissId)).filter((a) => a.state === "done").length, "nothing retired").toBe(doneBefore);
    const four = await liveOf(r.swissId, "pair_round");
    expect([four?.state, four?.target_round]).toEqual(["waiting", 4]);
  });

  it("an unpair after a switch-off cancel of the same round still records its skip (only a skip counts as skipped already)", async () => {
    const { r, r2 } = await roundTwoDecided();
    const first = await expectArmed(await liveOf(r.swissId, "pair_round"), "round 2 decided");
    await setStageAutoAdvance(r.auth, r.swissId, { autoPair: false });
    expect((await rowById(r.swissId, first.id)).result, "premise: a switch-off cancel of round 3").toEqual({ reason: "switch_off" });
    await setStageAutoAdvance(r.auth, r.swissId, { autoPair: true });
    await pair(r);
    await unpairSwissRound(r.auth, r.swissId);
    const skips = (await rowsOf(r.swissId)).filter((a) => a.target_round === 3 && a.result?.reason === "skip");
    expect(skips.map((a) => [a.state, a.result]), "the unpair's own skip, beside the switch-off cancel").toEqual([["cancelled", { reason: "skip", by: "unpair" }]]);
    const [f] = await boards(r.swissId, 2);
    await correct(r, f!, r2.get(f!.id)!);
    expect(await liveOf(r.swissId, "pair_round"), "sticky").toBeUndefined();
  });

  it("unpair with the switch off records nothing; turned on, the complete round arms (§5.8)", async () => {
    const { r } = await roundTwoDecided({ autoPair: false });
    await pair(r);
    await unpairSwissRound(r.auth, r.swissId);
    expect(await rowsOf(r.swissId), "no auto-pair, no skip").toEqual([]);
    await setStageAutoAdvance(r.auth, r.swissId, { autoPair: true });
    const three = await expectArmed(await liveOf(r.swissId, "pair_round"), "switched on");
    expect(three.target_round).toBe(3);
  });

  it("undo of a hand Pair records the skip too, and takes the next round's waiting row with it", async () => {
    const { r } = await roundTwoDecided();
    await pair(r);
    const four = await liveOf(r.swissId, "pair_round");
    expect([four?.state, four?.target_round], "premise: round 3 paired by hand, round 4 waits").toEqual(["waiting", 4]);
    await undoDivision(r.auth, r.divisionId);
    expect(await seatedIn(r.swissId, 3), "premise: the Undo put round 3 back on its shells").toBe(0);
    const skips = (await rowsOf(r.swissId)).filter((a) => a.result?.reason === "skip");
    expect(skips.map((a) => [a.state, a.target_round, a.result])).toEqual([["cancelled", 3, { reason: "skip", by: "undo" }]]);
    expect(await liveOf(r.swissId, "pair_round"), "round 4's row went with round 3's boards; round 3 does not arm").toBeUndefined();
  });

  it("undo of an auto pair records a sticky skip (through history.ts's Undo)", async () => {
    const { r, r2 } = await roundTwoDecided();
    const three = await expectArmed(await liveOf(r.swissId, "pair_round"), "round 2 decided");
    // The clock pairs round 3: it holds the row (Task 8's claim; SQL stands in) and calls the Pair as the system actor.
    await sql`update stage_auto_actions set lease_until = now() + interval '2 minutes' where id = ${three.id}`;
    await generateStageFixtures(systemAuth(r.auth.orgId), r.swissId);
    expect(await seatedIn(r.swissId, 3), "premise: the clock paired round 3").toBeGreaterThan(0);

    await undoDivision(r.auth, r.divisionId);
    expect(await seatedIn(r.swissId, 3), "premise: the Undo put round 3 back on its shells").toBe(0);
    const closed = await rowById(r.swissId, three.id);
    expect([closed.state, closed.result, closed.lease_until]).toEqual(["cancelled", { reason: "skip", by: "undo" }, null]);
    expect(await liveOf(r.swissId, "pair_round"), "no pending row for round 3").toBeUndefined();
    const [f] = await boards(r.swissId, 2);
    await correct(r, f!, r2.get(f!.id)!);
    expect(await liveOf(r.swissId, "pair_round"), "a correction never re-arms the undone round").toBeUndefined();

    // The positive pair: Redo puts the Pair back; round 4 waits on round 3, the skip stays history.
    await redoDivision(r.auth, r.divisionId);
    expect(await seatedIn(r.swissId, 3), "premise: Redo re-paired round 3").toBeGreaterThan(0);
    expect((await rowById(r.swissId, three.id)).result).toEqual({ reason: "skip", by: "undo" });
    const four = await liveOf(r.swissId, "pair_round");
    expect([four?.state, four?.target_round]).toEqual(["waiting", 4]);
  });
});
