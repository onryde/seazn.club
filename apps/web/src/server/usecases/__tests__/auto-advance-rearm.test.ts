// Swiss auto-advance, plan Task 5 — arming on Postgres (spec docs/superpowers/specs/2026-11-08-swiss-auto-advance-design.md
// §4.2-§4.4): `rearmAutoActions` re-derives a stage's live `stage_auto_actions` row from the facts in the DB, and every path
// that changes those facts calls it — a decide, void or correction (`onDecided`), an abandon, a seed-proposal draft
// (`computeSeedProposal`), a switch (`setStageAutoAdvance`) and an unfreeze (`setDivisionLocks`).
//
// Every rig is seeded through the usecases and every board decided through `scoreEvent`, as a scorer would. SQL writes the
// table only where no writer exists before a later task, each one named where it happens: the clock (Task 8: a lease, a
// fire's SCHEDULE_LOCKED block) and the sticky skip (Task 6). Moving `due_at` back is the clock's only stand-in.
//
// Expected values come from the spec and the declarations, never from the code under test: the window is
// `resolveSettleMs()` (60 s with no e2e override, spec §4.2) and the brief's ±2 s; the decided set is the server's DECIDED;
// the codes are the spec's (§4.4: STAGE_NOT_READY, SEEDING_TIE_UNRESOLVED, SCHEDULE_LOCKED); D1's retirement reasons
// (done by a person / cancelled superseded) and D2's lease rule are the plan's.
//
// Sports: arming reads no sport (a fixture is decided or it is not), so the sequences run on generic, the cheapest Swiss;
// the last describe runs the same arm on the plan's Swiss rows — generic, badminton and chess (boardgame) — with the count
// asserted, deciding each board through that sport's own scoring events.
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { LIVE_AUTO_ACTION_STATES } from "@/lib/auto-advance";
import { sql, withTenant, type Tx } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { resolveSettleMs } from "@/server/auto-advance/settle";
import { log } from "@/server/logger";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants, patchEntrant } from "../entrants";
import { setDivisionLocks } from "../history";
import { startDivision } from "../schedule";
import { scoreEvent } from "../scoring";
import { completeStage, computeSeedProposal, confirmSeedProposal, createStages, generateStageFixtures } from "../stages";
import { publishAutoActionAlarms, rearmAfterCommit, rearmAutoActions, setStageAutoAdvance } from "../auto-advance";
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
  blocked_code: string | null;
  detail: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  lease_until: Date | null;
  done_at: Date | null;
}

interface Rig {
  auth: AuthCtx;
  sport: Sport;
  divisionId: string;
  swissId: string;
  entrantIds: string[];
}

async function competitionDivision(auth: AuthCtx, sport: Sport, entrants: number) {
  const tag = randomUUID().slice(0, 6);
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: `Auto rearm ${tag}`, visibility: "private", branding: {} });
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

/** A Swiss of `rounds` rounds over `entrants` individuals, nothing generated; `autoPair` turned on through the PUT's usecase. */
async function swissRig(opts: { sport?: Sport; entrants?: number; rounds?: number; autoPair?: boolean } = {}): Promise<Rig> {
  const sport = opts.sport ?? GENERIC;
  const { auth } = await seedOrg("pro");
  const { divisionId, entrantIds } = await competitionDivision(auth, sport, opts.entrants ?? 4);
  const [swiss] = await createStages(auth, divisionId, [{ seq: 1, kind: "swiss", name: "Swiss", config: { rounds: opts.rounds ?? 3 }, progression: null }]);
  const r: Rig = { auth, sport, divisionId, swissId: swiss!.id, entrantIds };
  if (opts.autoPair ?? true) await setStageAutoAdvance(auth, r.swissId, { autoPair: true });
  return r;
}

/** Start mints the Swiss's empty shells; the next Generate pairs round 1 (and each one after it, the next round). */
const start = (r: Rig) => startDivision(r.auth, r.divisionId);
const pair = (r: Rig) => generateStageFixtures(r.auth, r.swissId);

async function fixturesOf(stageId: string): Promise<Board[]> {
  return sql<Board[]>`
    select id, round_no, seq_in_round, home_entrant_id, away_entrant_id, status
      from fixtures where stage_id = ${stageId} order by round_no, seq_in_round`;
}

/** The round's seated two-sided boards, in board order (a bye is seated decided and is nobody's to play). */
async function boards(stageId: string, round: number): Promise<Board[]> {
  const rows = (await fixturesOf(stageId)).filter((f) => f.round_no === round && f.home_entrant_id !== null && f.away_entrant_id !== null);
  expect(rows.length, `rig: round ${round} has seated boards`).toBeGreaterThan(0);
  return rows;
}

async function tip(fixtureId: string): Promise<number> {
  const [{ n }] = await sql<{ n: number }[]>`select coalesce(max(seq), 0)::int as n from score_events where fixture_id = ${fixtureId}`;
  return n;
}

async function post(auth: AuthCtx, fixtureId: string, type: string, payload: Record<string, unknown> = {}) {
  return scoreEvent(auth, fixtureId, { expected_seq: await tip(fixtureId), type, payload });
}

/** A played result through the sport's own scoring events; `home` wins unless told otherwise. Answers the id of the event
 *  that decided it (the one a correction voids). */
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

const undo = (r: Rig, fixtureId: string, eventId: string) => post(r.auth, fixtureId, "core.void", { event_id: eventId });

async function statusOf(fixtureId: string): Promise<string> {
  const [f] = await sql<{ status: string }[]>`select status from fixtures where id = ${fixtureId}`;
  return f!.status;
}

async function rowsOf(stageId: string): Promise<ActionRow[]> {
  return sql<ActionRow[]>`
    select id, kind, state, target_round, target_proposal_id, due_at, blocked_code, detail, result, lease_until, done_at
      from stage_auto_actions where stage_id = ${stageId} order by created_at, id`;
}

async function liveOf(stageId: string, kind: string): Promise<ActionRow | undefined> {
  const live = (await rowsOf(stageId)).filter((a) => a.kind === kind && LIVE.has(a.state));
  expect(live.length, `at most one live ${kind} row`).toBeLessThanOrEqual(1);
  return live[0];
}

async function divisionRowCount(divisionId: string): Promise<number> {
  const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from stage_auto_actions where division_id = ${divisionId}`;
  return n;
}

/** How far `due_at` is from now, in ms (the DB's clock on both sides). */
async function dueInMs(rowId: string): Promise<number> {
  const [{ ms }] = await sql<{ ms: number }[]>`
    select (extract(epoch from (due_at - clock_timestamp())) * 1000)::float8 as ms from stage_auto_actions where id = ${rowId}`;
  return ms;
}

/** Armed `now + settle`: pending, timed, nothing blocking it. */
async function expectArmed(row: ActionRow | undefined, label: string): Promise<ActionRow> {
  expect(row, `${label}: a live row`).toBeDefined();
  expect(row!.state, label).toBe("pending");
  expect(row!.blocked_code, label).toBeNull();
  const ms = await dueInMs(row!.id);
  const settle = resolveSettleMs();
  expect(ms, `${label}: due in about the settle window (${settle} ms)`).toBeGreaterThanOrEqual(settle - WINDOW_MS);
  expect(ms, `${label}: due in about the settle window (${settle} ms)`).toBeLessThanOrEqual(settle + WINDOW_MS);
  return row!;
}

/** The clock's stand-in: the row was armed `seconds` ago. */
async function ageDue(rowId: string, seconds: number): Promise<void> {
  await sql`update stage_auto_actions set due_at = due_at - make_interval(secs => ${seconds}::float8) where id = ${rowId}`;
}

const rearm = (r: { auth: AuthCtx }, stageId: string, opts?: { restartPending?: boolean }) =>
  withTenant(r.auth.orgId, (tx) => rearmAutoActions(tx, stageId, opts));

/** `rearm`, counting the SQL statements it sends: a tagged-template call on the transaction is one statement (a
 *  `tx(list)` helper or a `tx.json` value is not). */
async function countedRearm(r: { auth: AuthCtx }, stageId: string) {
  let statements = 0;
  const alarms = await withTenant(r.auth.orgId, (tx) => {
    const counted = new Proxy(tx, {
      apply(target, thisArg, args: unknown[]) {
        if (Array.isArray(args[0]) && "raw" in args[0]) statements++;
        return Reflect.apply(target as unknown as (...a: unknown[]) => unknown, thisArg, args);
      },
    }) as Tx;
    return rearmAutoActions(counted, stageId);
  });
  return { alarms, statements };
}

/** Polls (another connection) until some backend is blocked behind `pid`: on a lock, or on its uncommitted row. */
async function waitBlockedBy(pid: number, ms = 15_000): Promise<number> {
  const deadline = Date.now() + ms;
  for (;;) {
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from pg_stat_activity where ${pid}::int = any(pg_blocking_pids(pid))`;
    if (n > 0) return n;
    if (Date.now() > deadline) throw new Error(`waitBlockedBy: nothing blocked behind backend ${pid} after ${ms} ms`);
    await new Promise((res) => setTimeout(res, 25));
  }
}

const ref = (f: Board) => ({ fixtureId: f.id, round: f.round_no, board: f.seq_in_round });

/** A Swiss whose round 1 is decided: the pending pair of round 2 armed by the last decide. */
async function roundOneDecided(opts: { sport?: Sport; rounds?: number } = {}) {
  const r = await swissRig(opts);
  await start(r);
  await pair(r);
  const r1 = await boards(r.swissId, 1);
  const decisive = new Map<string, string>();
  for (const f of r1) decisive.set(f.id, await win(r, f));
  return { r, r1, decisive };
}

describe.skipIf(!HAS_DB)("rearmAutoActions: the source stage (plan Task 5)", () => {
  it("empty stage arms nothing; round-1 shells arm nothing (§5.12, the empty case first)", async () => {
    const r = await swissRig({ autoPair: true });
    expect(await fixturesOf(r.swissId), "premise: nothing generated").toEqual([]);
    expect(await rearm(r, r.swissId), "no fixtures").toEqual([]);
    expect(await rowsOf(r.swissId)).toEqual([]);
    // Start mints the shells and seats nobody: round 1 is always paired by hand (§4.1).
    await start(r);
    const shells = await fixturesOf(r.swissId);
    expect(shells.length, "premise: the shells exist").toBeGreaterThan(0);
    expect(shells.every((f) => f.home_entrant_id === null && f.away_entrant_id === null), "premise: nobody seated").toBe(true);
    expect(await rearm(r, r.swissId), "round-1 shells").toEqual([]);
    expect((await setStageAutoAdvance(r.auth, r.swissId, { autoPair: true })).actions, "the switch's own arming").toEqual([]);
    expect(await rowsOf(r.swissId)).toEqual([]);
    // The positive pair: once round 1 is paired, the same call arms (round 2 waits on round 1's boards).
    await pair(r);
    await rearm(r, r.swissId);
    const waiting = await liveOf(r.swissId, "pair_round");
    expect([waiting?.state, waiting?.target_round]).toEqual(["waiting", 2]);
  });

  it("switch on arms a complete round (§5.8)", async () => {
    const r = await swissRig({ autoPair: false });
    await start(r);
    await pair(r);
    for (const f of await boards(r.swissId, 1)) await win(r, f);
    expect(await rowsOf(r.swissId), "switch off: deciding the round armed nothing").toEqual([]);
    const on = await setStageAutoAdvance(r.auth, r.swissId, { autoPair: true });
    const row = await expectArmed(await liveOf(r.swissId, "pair_round"), "armed by the switch");
    expect(row.target_round).toBe(2);
    // The switch's answer carries the row it armed.
    expect(on.actions.map((a) => [a.id, a.state, a.targetRound])).toEqual([[row.id, "pending", 2]]);
  });

  it("one board open → waiting naming it; last undecided board decided → pending", async () => {
    const r = await swissRig();
    await start(r);
    await pair(r);
    const [b1, b2] = await boards(r.swissId, 1);
    expect(b2, "rig: two boards in round 1").toBeDefined();
    await win(r, b1!);
    const waiting = await liveOf(r.swissId, "pair_round");
    expect(waiting).toMatchObject({ state: "waiting", target_round: 2, due_at: null, blocked_code: null, detail: { openBoards: [ref(b2!)] } });
    await win(r, b2!);
    const pending = await expectArmed(await liveOf(r.swissId, "pair_round"), "the last board decided");
    expect(pending.id, "the same row moved on").toBe(waiting!.id);
    expect([pending.target_round, pending.detail]).toEqual([2, null]);
    expect(await rowsOf(r.swissId), "one row in all").toHaveLength(1);
  });

  it("correction restarts due_at (§5.2), inside the round's scope and outside it", async () => {
    const { r, r1, decisive } = await roundOneDecided();
    const two = (await liveOf(r.swissId, "pair_round"))!;
    await pair(r);
    const r2 = await boards(r.swissId, 2);
    const r2Decisive = new Map<string, string>();
    for (const f of r2) r2Decisive.set(f.id, await win(r, f));
    // D1: round 2 was paired by hand, so its row retired as done by a person; round 3 now counts down.
    const retired = (await rowsOf(r.swissId)).find((a) => a.id === two.id)!;
    expect([retired.state, retired.result, retired.done_at !== null]).toEqual(["done", { by: "person" }, true]);
    const three = await expectArmed(await liveOf(r.swissId, "pair_round"), "round 2 decided");
    expect(three.target_round).toBe(3);

    // 30 s into the window, a round-2 result is corrected (voided, then decided the other way).
    await ageDue(three.id, 30);
    const corrected = r2[0]!;
    await undo(r, corrected.id, r2Decisive.get(corrected.id)!);
    expect(await liveOf(r.swissId, "pair_round"), "the void reopened the round").toMatchObject({ id: three.id, state: "waiting", due_at: null, detail: { openBoards: [ref(corrected)] } });
    await win(r, corrected, false);
    await expectArmed(await liveOf(r.swissId, "pair_round"), "the clock restarted from the correction");

    // A round-1 correction is outside round 3's scope (round 2 is still complete), so the row never leaves pending:
    // only the restart rule moves its clock. This is the case a "restart only when not already pending" bug passes.
    await ageDue(three.id, 30);
    const old = r1[0]!;
    await undo(r, old.id, decisive.get(old.id)!);
    expect(await statusOf(old.id), "premise: the round-1 board is undecided again").not.toMatch(/^(decided|forfeited|finalized)$/);
    const still = await expectArmed(await liveOf(r.swissId, "pair_round"), "a void outside the scope restarts the clock");
    expect(still.id).toBe(three.id);
    await ageDue(three.id, 30);
    await win(r, old, false);
    await expectArmed(await liveOf(r.swissId, "pair_round"), "the re-decide restarts it again");
  });

  it("void returns the row to waiting; re-decide re-arms (§5.3)", async () => {
    const { r, r1, decisive } = await roundOneDecided();
    const armed = await expectArmed(await liveOf(r.swissId, "pair_round"), "round 1 decided");
    const voided = r1[1]!;
    await undo(r, voided.id, decisive.get(voided.id)!);
    expect(await liveOf(r.swissId, "pair_round")).toMatchObject({ id: armed.id, state: "waiting", due_at: null, detail: { openBoards: [ref(voided)] } });
    await win(r, voided);
    expect((await expectArmed(await liveOf(r.swissId, "pair_round"), "re-decided")).id).toBe(armed.id);
  });

  it("abandoned board blocks, deciding re-arms (§5.6)", async () => {
    const r = await swissRig();
    await start(r);
    await pair(r);
    const [b1, b2] = await boards(r.swissId, 1);
    await win(r, b1!);
    await post(r.auth, b2!.id, "core.start");
    await post(r.auth, b2!.id, "core.abandon", { reason: "rain" });
    expect(await statusOf(b2!.id), "premise: the board is abandoned, nobody decided").toBe("abandoned");
    expect(await liveOf(r.swissId, "pair_round")).toMatchObject({
      state: "blocked",
      target_round: 2,
      due_at: null,
      blocked_code: "STAGE_NOT_READY",
      detail: { boards: [ref(b2!)] },
    });
    // The organiser decides it (a settle names the winner of an abandoned match): the round is complete, the clock arms.
    await post(r.auth, b2!.id, "core.settle", { winner: b2!.home_entrant_id, method: "organiser" });
    expect(await statusOf(b2!.id)).toBe("decided");
    await expectArmed(await liveOf(r.swissId, "pair_round"), "the abandoned board decided");
  });

  it("switch off cancels (§5.9); switched back on, the same round re-arms (switch_off is not sticky)", async () => {
    const { r, r1, decisive } = await roundOneDecided();
    const armed = await expectArmed(await liveOf(r.swissId, "pair_round"), "round 1 decided");
    const off = await setStageAutoAdvance(r.auth, r.swissId, { autoPair: false });
    expect(off.actions, "nothing live after the switch-off").toEqual([]);
    const cancelled = (await rowsOf(r.swissId)).find((a) => a.id === armed.id)!;
    expect([cancelled.state, cancelled.result]).toEqual(["cancelled", { reason: "switch_off" }]);
    // While off, a correction arms nothing.
    const f = r1[0]!;
    await undo(r, f.id, decisive.get(f.id)!);
    await win(r, f, false);
    expect(await liveOf(r.swissId, "pair_round"), "the switch is off").toBeUndefined();
    // Back on: round 2 arms again, a fresh row beside the cancelled one.
    await setStageAutoAdvance(r.auth, r.swissId, { autoPair: true });
    const again = await expectArmed(await liveOf(r.swissId, "pair_round"), "switched back on");
    expect([again.id !== armed.id, again.target_round]).toEqual([true, 2]);
  });

  it("only a skip is sticky: a switch_off or superseded cancel of the same round re-arms it", async () => {
    const { r, r1, decisive } = await roundOneDecided();
    let rearmed = 0;
    for (const reason of ["switch_off", "superseded"] as const) {
      const live = await expectArmed(await liveOf(r.swissId, "pair_round"), `before ${reason}`);
      await sql`update stage_auto_actions set state = 'cancelled', result = ${sql.json({ reason })}, updated_at = now() where id = ${live.id}`;
      await rearm(r, r.swissId);
      const again = await expectArmed(await liveOf(r.swissId, "pair_round"), `after a ${reason} cancel`);
      expect([again.id !== live.id, again.target_round], reason).toEqual([true, 2]);
      rearmed++;
    }
    expect(rearmed).toBe(2);
    // The positive pair: a skip (Task 6 writes it; SQL stands in here) IS sticky, through a re-arm and a correction alike.
    const live = (await liveOf(r.swissId, "pair_round"))!;
    await sql`update stage_auto_actions set state = 'cancelled', result = ${sql.json({ reason: "skip", by: "person" })}, updated_at = now() where id = ${live.id}`;
    expect(await rearm(r, r.swissId)).toEqual([]);
    const f = r1[1]!;
    await undo(r, f.id, decisive.get(f.id)!);
    await win(r, f, false);
    expect(await liveOf(r.swissId, "pair_round"), "a skipped round never re-arms").toBeUndefined();
  });

  it("a leased row is left alone (D2)", async () => {
    const { r, r1, decisive } = await roundOneDecided();
    const armed = await expectArmed(await liveOf(r.swissId, "pair_round"), "round 1 decided");
    // A firer holds the row (Task 8's claim; SQL stands in), and the row is 30 s into its window.
    await ageDue(armed.id, 30);
    await sql`update stage_auto_actions set lease_until = now() + interval '2 minutes' where id = ${armed.id}`;
    const before = (await rowsOf(r.swissId)).find((a) => a.id === armed.id)!;
    const f = r1[0]!;
    await undo(r, f.id, decisive.get(f.id)!);
    expect(await rearm(r, r.swissId), "nothing armed under the lease").toEqual([]);
    expect(await rowsOf(r.swissId), "the leased row is untouched, and no second row was made").toEqual([before]);
    // The positive pair: once the lease lapses, the next change re-derives it.
    await sql`update stage_auto_actions set lease_until = now() - interval '1 second' where id = ${armed.id}`;
    await win(r, f, false);
    const after = await expectArmed(await liveOf(r.swissId, "pair_round"), "the lease lapsed");
    expect(after.id).toBe(armed.id);
  });

  it("second rearm with restartPending false keeps due_at; the default restarts it", async () => {
    const { r } = await roundOneDecided();
    const armed = await expectArmed(await liveOf(r.swissId, "pair_round"), "round 1 decided");
    await ageDue(armed.id, 30);
    const [{ due }] = await sql<{ due: Date }[]>`select due_at as due from stage_auto_actions where id = ${armed.id}`;
    expect(await rearm(r, r.swissId, { restartPending: false }), "no alarm: nothing re-armed").toEqual([]);
    const kept = (await liveOf(r.swissId, "pair_round"))!;
    expect([kept.id, kept.state, kept.due_at?.getTime()]).toEqual([armed.id, "pending", due.getTime()]);
    // The default restarts the clock and hands back the alarm for the row it re-armed.
    const alarms = await rearm(r, r.swissId);
    const restarted = await expectArmed(await liveOf(r.swissId, "pair_round"), "the default restarts");
    expect(alarms).toEqual([{ rowId: armed.id, stageId: r.swissId, dueAt: restarted.due_at }]);
  });

  it("last round settled arms complete_stage; a manual Complete retires it as done by a person (D1)", async () => {
    const { r } = await roundOneDecided({ rounds: 2 });
    await pair(r);
    for (const f of await boards(r.swissId, 2)) await win(r, f);
    const complete = await expectArmed(await liveOf(r.swissId, "complete_stage"), "the last round decided");
    expect(complete.target_round, "the stage's last round").toBe(2);
    expect(await liveOf(r.swissId, "pair_round"), "the pair row retired").toBeUndefined();
    const res = await completeStage(r.auth, r.swissId);
    expect(res.completed).toBe(true);
    await rearm(r, r.swissId);
    const done = (await rowsOf(r.swissId)).find((a) => a.id === complete.id)!;
    expect([done.state, done.result]).toEqual(["done", { by: "person" }]);
    expect(await liveOf(r.swissId, "complete_stage")).toBeUndefined();
  });
});

describe.skipIf(!HAS_DB)("rearmAutoActions: what never arms (plan Task 5)", () => {
  it("a non-swiss stage with no switches pays one read: no rows written, for a league fixture decide", async () => {
    const { auth } = await seedOrg("pro");
    const { divisionId } = await competitionDivision(auth, GENERIC, 4);
    const [league] = await createStages(auth, divisionId, [{ seq: 1, kind: "league", name: "League", config: { legs: 1 }, progression: null }]);
    await startDivision(auth, divisionId);
    const r = { auth, sport: GENERIC } as Rig;
    const fixtures = (await fixturesOf(league!.id)).filter((f) => f.home_entrant_id !== null && f.away_entrant_id !== null);
    expect(fixtures.length, "premise: the league is drawn").toBeGreaterThan(0);
    for (const f of fixtures) await win(r, f);
    // The cost every decided fixture of every stage pays: the stage's lock and ONE read, then out (no live-row read, no
    // fixture read). The positive pair: a Swiss with its switch on reads on.
    const cheap = await countedRearm(r, league!.id);
    expect(cheap).toEqual({ alarms: [], statements: 2 });
    expect(await divisionRowCount(divisionId)).toBe(0);
    const swiss = await swissRig();
    expect((await countedRearm(swiss, swiss.swissId)).statements, "a Swiss with its switch on reads past the stage").toBeGreaterThan(2);
  });

  it("a switch stored where it cannot act never arms (the arming gate): autoPair on a league, autoConfirmHandoff on an on_complete target", async () => {
    // The create door takes StageConfig whole, so both flags can be STORED here; only the PUT refuses them. The arming must
    // read where a switch can act (autoAdvanceSwitchesFor) as well as the flag.
    const { auth } = await seedOrg("pro");
    const { divisionId } = await competitionDivision(auth, GENERIC, 4);
    const [league, ko] = await createStages(auth, divisionId, [
      { seq: 1, kind: "league", name: "League", config: { legs: 1, autoPair: true }, progression: null },
      {
        seq: 2,
        kind: "knockout",
        name: "Cup",
        config: { autoConfirmHandoff: true },
        progression: { sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 2 }] }], placement: "rank_order", timing: "on_complete" },
      },
    ]);
    const [stored] = await sql<{ a: unknown; c: unknown }[]>`
      select (select config->'autoPair' from stages where id = ${league!.id}) as a, (select config->'autoConfirmHandoff' from stages where id = ${ko!.id}) as c`;
    expect([stored!.a, stored!.c], "premise: both flags are stored").toEqual([true, true]);
    await startDivision(auth, divisionId);
    const r = { auth, sport: GENERIC } as Rig;
    // Every league board decided through scoreEvent (each decide runs the arming): a Swiss-shaped read of these facts
    // would derive "complete the stage" — every round seated, every board decided.
    const played = (await fixturesOf(league!.id)).filter((x) => x.home_entrant_id !== null && x.away_entrant_id !== null);
    expect(played.length, "premise: the league is drawn").toBeGreaterThan(0);
    for (const f of played) await win(r, f);
    expect(await rearm(r, league!.id)).toEqual([]);
    // A draft on the on_complete target: a confirm-shaped read of it would arm. computeSeedProposal cannot draft one here
    // (an on_complete target holds no TBD slots before its source completes, and is drawn, not TBD, after), so SQL writes
    // the fact the gate must ignore.
    await sql`insert into stage_seed_proposals (org_id, stage_id, computed, status)
              values (${auth.orgId}, ${ko!.id}, ${sql.json({ qualifiers: [], ties: [] })}, 'draft')`;
    expect(await rearm(r, ko!.id)).toEqual([]);
    expect(await divisionRowCount(divisionId)).toBe(0);
  });
});

/** A generic division of four, a knockout (seq 3, or 2 with one source) fed at setup, its switch on. */
async function confirmRig(sources: 1 | 2) {
  const { auth } = await seedOrg("pro");
  const { divisionId, entrantIds } = await competitionDivision(auth, GENERIC, 4);
  const leagues = await createStages(
    auth,
    divisionId,
    Array.from({ length: sources }, (_, i) => ({ seq: i + 1, kind: "league" as const, name: `L${i + 1}`, config: { legs: 1 }, progression: null })),
  );
  const take = sources === 1 ? [{ kind: "rankRange" as const, from: 1, to: 2 }] : [{ kind: "rankRange" as const, from: 1, to: 1 }];
  const [ko] = await createStages(auth, divisionId, [
    {
      seq: sources + 1,
      kind: "knockout",
      name: "Cup",
      config: {},
      progression: { sources: leagues.map((l) => ({ stage: { stageId: l.id }, take })), placement: "rank_order", timing: "setup" },
    },
  ]);
  await setStageAutoAdvance(auth, ko!.id, { autoConfirmHandoff: true });
  await generateStageFixtures(auth, ko!.id);
  for (const l of leagues.slice(1)) await generateStageFixtures(auth, l.id);
  await startDivision(auth, divisionId);
  const r = { auth, sport: GENERIC } as Rig;
  return { r, divisionId, entrantIds, leagueIds: leagues.map((l) => l.id), koId: ko!.id };
}

/** Every board of a league. A winner id: it beats everyone 2-0, every other board is a 1-1 draw. An order: the entrant
 *  earlier in it wins every board, so the table is that order with no tie. null: all draws. */
async function playLeague(r: Rig, stageId: string, winner: string | readonly string[] | null): Promise<Map<string, string>> {
  const decisive = new Map<string, string>();
  const fixtures = (await fixturesOf(stageId)).filter((f) => f.home_entrant_id !== null && f.away_entrant_id !== null);
  expect(fixtures.length, "rig: the league is drawn").toBeGreaterThan(0);
  const rank = (id: string | null) => (Array.isArray(winner) ? winner.indexOf(id) : -1);
  for (const f of fixtures) {
    await post(r.auth, f.id, "core.start");
    const score = Array.isArray(winner)
      ? rank(f.home_entrant_id) < rank(f.away_entrant_id)
        ? { p1Score: 2, p2Score: 0 }
        : { p1Score: 0, p2Score: 2 }
      : winner !== null && f.home_entrant_id === winner
        ? { p1Score: 2, p2Score: 0 }
        : winner !== null && f.away_entrant_id === winner
          ? { p1Score: 0, p2Score: 2 }
          : { p1Score: 1, p2Score: 1 };
    decisive.set(f.id, (await post(r.auth, f.id, "generic.result", score)).event_id);
  }
  return decisive;
}

async function latestProposal(stageId: string) {
  const [p] = await sql<{ id: string; status: string; computed: { ties: unknown[] } }[]>`
    select id, status, computed from stage_seed_proposals where stage_id = ${stageId} order by created_at desc, id desc limit 1`;
  return p;
}

describe.skipIf(!HAS_DB)("rearmAutoActions: the confirm hand-off (plan Task 5)", () => {
  it("tie derives blocked (§5.7, D4): a draft with a tie blocks its confirm row at once", async () => {
    const c = await confirmRig(1);
    await playLeague(c.r, c.leagueIds[0]!, null);
    const done = await completeStage(c.r.auth, c.leagueIds[0]!);
    expect(done.seed_proposal, "premise: completing the league drafted the proposal").toBeDefined();
    const draft = (await latestProposal(c.koId))!;
    expect(draft.computed.ties.length, "premise: every board drawn, the cut is a tie").toBeGreaterThan(0);
    expect(await liveOf(c.koId, "confirm_handoff")).toMatchObject({
      state: "blocked",
      blocked_code: "SEEDING_TIE_UNRESOLVED",
      target_proposal_id: draft.id,
      target_round: null,
      due_at: null,
    });
  });

  it("two-source target arms only after the last source (§5.15); a new draft supersedes; a manual confirm retires it (D1)", async () => {
    const c = await confirmRig(2);
    const [a, b] = c.leagueIds as [string, string];
    await playLeague(c.r, a, c.entrantIds[0]!);
    const bResults = await playLeague(c.r, b, c.entrantIds[1]!);
    // The first source completes: its successor is the other league, so nothing is drafted and nothing arms.
    expect((await completeStage(c.r.auth, a)).completed).toBe(true);
    expect(await latestProposal(c.koId), "no draft yet").toBeUndefined();
    const early = await computeSeedProposal(c.r.auth, c.koId).catch((e: { code?: string }) => e);
    expect((early as { code?: string }).code, "a draft is refused while a source is open").toBe("SEEDING_SOURCE_INCOMPLETE");
    expect(await rowsOf(c.koId), "nothing armed after the first source").toEqual([]);
    // The last source completes: the draft, and its confirm row counting down, commit together.
    const done = await completeStage(c.r.auth, b);
    const first = await expectArmed(await liveOf(c.koId, "confirm_handoff"), "the last source completed");
    expect(first.target_proposal_id).toBe(done.seed_proposal!.id);

    // A correction in a source re-drafts (markDependentSeedProposalsStale): the old row is superseded, the new draft armed.
    const [fid, eid] = [...bResults].find(([id]) => id !== undefined)!;
    await undo(c.r, fid, eid);
    // The void already re-drafts (the source stays complete): the countdown moves to that draft at once.
    const afterVoid = (await latestProposal(c.koId))!;
    expect([afterVoid.status, afterVoid.id !== first.target_proposal_id]).toEqual(["draft", true]);
    expect((await liveOf(c.koId, "confirm_handoff"))?.target_proposal_id).toBe(afterVoid.id);
    await post(c.r.auth, fid, "generic.result", { p1Score: 1, p2Score: 1 });
    const draft = (await latestProposal(c.koId))!;
    expect([draft.status, draft.id !== first.target_proposal_id]).toEqual(["draft", true]);
    const fresh = await expectArmed(await liveOf(c.koId, "confirm_handoff"), "re-drafted");
    expect(fresh.target_proposal_id).toBe(draft.id);
    const old = (await rowsOf(c.koId)).find((x) => x.id === first.id)!;
    expect([old.state, old.result]).toEqual(["cancelled", { reason: "superseded" }]);

    // A confirm lands while a firer holds the row (Task 8's claim; SQL stands in, then lapses): a manual Confirm retires the
    // row in its own transaction (Task 6), but never a leased one (D2), so here the row outlives the confirm. The next
    // source correction cannot re-draft (SEEDING_ALREADY_CONFIRMED), and its failed recompute re-derives the target anyway:
    // the row retires as done by a person, not left counting down.
    await sql`update stage_auto_actions set lease_until = now() + interval '2 minutes' where id = ${fresh.id}`;
    await confirmSeedProposal(c.r.auth, c.koId, { proposalId: draft.id });
    expect((await liveOf(c.koId, "confirm_handoff"))?.id, "premise: the leased row outlived the confirm").toBe(fresh.id);
    await sql`update stage_auto_actions set lease_until = now() - interval '1 second' where id = ${fresh.id}`;
    const [lastId] = [...bResults.keys()].filter((id) => id !== fid);
    await undo(c.r, lastId!, bResults.get(lastId!)!);
    expect((await latestProposal(c.koId))!.status, "premise: no re-draft after a confirm").toBe("confirmed");
    const retired = (await rowsOf(c.koId)).find((x) => x.id === fresh.id)!;
    expect([retired.state, retired.result]).toEqual(["done", { by: "person" }]);
    expect(await liveOf(c.koId, "confirm_handoff")).toBeUndefined();
  });

  it("rearmAutoActions keeps paused across a re-draft by retargeting target_proposal_id (plan Task 11, D9)", async () => {
    const c = await confirmRig(1);
    // A strict table (no tie at the cut of two), so the draft counts down rather than blocking.
    const results = await playLeague(c.r, c.leagueIds[0]!, c.entrantIds);
    await completeStage(c.r.auth, c.leagueIds[0]!);
    const armed = await expectArmed(await liveOf(c.koId, "confirm_handoff"), "the source completed");
    // A person opened the proposal to review it (Task 11 writes the hold; SQL stands in): paused until the hold's release.
    await sql`update stage_auto_actions set state = 'paused', due_at = now() + interval '30 minutes', updated_at = now() where id = ${armed.id}`;
    const [{ due }] = await sql<{ due: Date }[]>`select due_at as due from stage_auto_actions where id = ${armed.id}`;
    // A source correction re-drafts: the hold follows the hand-off to the new draft, keeping its own release time. The
    // board voided is 3rd v 4th, below the cut of two, so the new draft has no tie to block on.
    const below = new Set([c.entrantIds[2], c.entrantIds[3]]);
    const board = (await fixturesOf(c.leagueIds[0]!)).find((f) => below.has(f.home_entrant_id!) && below.has(f.away_entrant_id!))!;
    expect(board, "rig: the 3rd v 4th board").toBeDefined();
    await undo(c.r, board.id, results.get(board.id)!);
    const draft = (await latestProposal(c.koId))!;
    expect([draft.status, draft.id !== armed.target_proposal_id], "premise: re-drafted").toEqual(["draft", true]);
    const held = (await liveOf(c.koId, "confirm_handoff"))!;
    expect([held.id, held.state, held.target_proposal_id, held.due_at?.getTime()]).toEqual([armed.id, "paused", draft.id, due.getTime()]);
    expect(await rowsOf(c.koId), "one row in all: nothing retired, nothing inserted").toHaveLength(1);
  });

  it("a proposal with no computed.ties is refused by name, not armed (it could hide an unresolved tie)", async () => {
    const c = await confirmRig(1);
    await sql`insert into stage_seed_proposals (org_id, stage_id, computed, status)
              values (${c.r.auth.orgId}, ${c.koId}, ${sql.json({ qualifiers: [] })}, 'draft')`;
    await expect(rearm(c.r, c.koId)).rejects.toThrow(/has no computed\.ties array/);
    expect(await rowsOf(c.koId)).toEqual([]);
  });
});

describe.skipIf(!HAS_DB)("rearm triggers beyond a result (plan Task 5)", () => {
  it("unfreeze re-arms a SCHEDULE_LOCKED block (§4.4); a freeze, a scope edit or a second unfreeze does not", async () => {
    const { r } = await roundOneDecided();
    const armed = await expectArmed(await liveOf(r.swissId, "pair_round"), "round 1 decided");
    await setDivisionLocks(r.auth, r.divisionId, { schedule_locked: true });
    // The fire's refusal on a frozen division (Task 8 writes it; SQL stands in).
    await sql`update stage_auto_actions set state = 'blocked', blocked_code = 'SCHEDULE_LOCKED', detail = null, due_at = null,
                updated_at = now() where id = ${armed.id}`;
    const blocked = async (label: string) =>
      expect(await liveOf(r.swissId, "pair_round"), label).toMatchObject({ id: armed.id, state: "blocked", blocked_code: "SCHEDULE_LOCKED" });
    // A re-derive that restarts nothing (the sweep's) leaves a fire's block alone.
    await rearm(r, r.swissId, { restartPending: false });
    await blocked("a sweep-shaped re-derive");
    await setDivisionLocks(r.auth, r.divisionId, { schedule_locked: true });
    await blocked("frozen again: nothing moved");
    await setDivisionLocks(r.auth, r.divisionId, { locked_scopes: [] });
    await blocked("a scope edit is not an unfreeze");
    await setDivisionLocks(r.auth, r.divisionId, { schedule_locked: false });
    const unblocked = await expectArmed(await liveOf(r.swissId, "pair_round"), "unfrozen");
    expect([unblocked.id, unblocked.detail]).toEqual([armed.id, null]);
    // Already unfrozen: a second unfreeze moves nothing, so it restarts nothing.
    await ageDue(armed.id, 30);
    const [{ due }] = await sql<{ due: Date }[]>`select due_at as due from stage_auto_actions where id = ${armed.id}`;
    await setDivisionLocks(r.auth, r.divisionId, { schedule_locked: false });
    expect((await liveOf(r.swissId, "pair_round"))!.due_at?.getTime()).toBe(due.getTime());
  });

  it("rearmAfterCommit never throws: a failure is logged as auto_advance_rearm_failed", async () => {
    const { auth } = await seedOrg("pro");
    const spy = vi.spyOn(log, "error");
    try {
      await expect(rearmAfterCommit(auth.orgId, "not-a-uuid")).resolves.toBeUndefined();
      const logged = spy.mock.calls.filter((c) => JSON.stringify(c).includes("auto_advance_rearm_failed"));
      expect(logged.length, "the failure is logged once").toBe(1);
    } finally {
      spy.mockRestore();
    }
  });
});

describe.skipIf(!HAS_DB)("arming per sport (plan Task 5; Swiss × generic, badminton, chess)", () => {
  it("badminton and chess Swiss arm the same way as generic", async () => {
    let checked = 0;
    for (const sport of SWISS_SPORTS) {
      const r = await swissRig({ sport });
      await start(r);
      await pair(r);
      const [b1, b2] = await boards(r.swissId, 1);
      await win(r, b1!);
      expect(await liveOf(r.swissId, "pair_round"), sport.sport).toMatchObject({ state: "waiting", target_round: 2, detail: { openBoards: [ref(b2!)] } });
      await win(r, b2!);
      expect(await statusOf(b2!.id), `${sport.sport}: premise, decided through its own events`).toBe("decided");
      const row = await expectArmed(await liveOf(r.swissId, "pair_round"), sport.sport);
      expect(row.target_round, sport.sport).toBe(2);
      checked++;
    }
    expect(checked).toBe(SWISS_SPORTS.length);
    expect(checked).toBe(3);
  });
});

describe.skipIf(!HAS_DB)("rearmAutoActions under concurrency, and what it never writes (plan Task 5, fix round 1)", () => {
  it("two arms of one stage serialise on its lock: one live row, the later arm's clock, no failure", async () => {
    // A complete round with no row: decided while the switch was off, then the switch stored on without its own arming
    // (SQL stands in for the create door's StageConfig, which stores a flag and arms nothing).
    const r = await swissRig({ autoPair: false });
    await start(r);
    await pair(r);
    for (const f of await boards(r.swissId, 1)) await win(r, f);
    await sql`update stages set config = config || ${sql.json({ autoPair: true })} where id = ${r.swissId}`;
    expect(await rowsOf(r.swissId), "premise: a complete round, no row").toEqual([]);

    const spy = vi.spyOn(log, "error");
    try {
      // A arms inside its open transaction and holds it; B (a result's rearmAfterCommit) starts while A is uncommitted.
      let release!: () => void;
      const gate = new Promise<void>((res) => (release = res));
      let armedInA!: (pid: number) => void;
      const aArmed = new Promise<number>((res) => (armedInA = res));
      const a = withTenant(r.auth.orgId, async (tx) => {
        const alarms = await rearmAutoActions(tx, r.swissId);
        const [{ pid }] = await tx<{ pid: number }[]>`select pg_backend_pid() as pid`;
        armedInA(pid);
        await gate;
        return alarms;
      });
      const pidA = await aArmed;
      const b = rearmAfterCommit(r.auth.orgId, r.swissId);
      // Deterministic, not a sleep: B is blocked behind A (on the stage's lock; without it, on A's uncommitted row in the
      // one-live-row index) before A commits.
      expect(await waitBlockedBy(pidA), "B waits behind A").toBe(1);
      release();
      const aAlarms = await a;
      await b;
      expect(aAlarms, "A armed the row").toHaveLength(1);

      const live = (await rowsOf(r.swissId)).filter((x) => LIVE.has(x.state));
      expect(live, "exactly one live row").toHaveLength(1);
      expect([live[0]!.id, live[0]!.state]).toEqual([aAlarms[0]!.rowId, "pending"]);
      expect(live[0]!.due_at!.getTime(), "B re-armed A's row after A committed: its clock, not A's").toBeGreaterThan(aAlarms[0]!.dueAt.getTime());
      expect(spy.mock.calls.filter((c) => JSON.stringify(c).includes("auto_advance_rearm_failed")), "B did not fail").toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it("a re-derive that moves nothing writes nothing: a waiting row, and a derived block, keep their updated_at", async () => {
    const r = await swissRig();
    await start(r);
    await pair(r);
    const [b1, b2] = await boards(r.swissId, 1);
    await win(r, b1!);
    const stamp = async () => {
      const [row] = await sql<{ id: string; state: string; updated_at: Date }[]>`
        select id, state, updated_at from stage_auto_actions where stage_id = ${r.swissId} and state in ${sql([...LIVE])}`;
      return row!;
    };
    let checked = 0;
    for (const expected of ["waiting", "blocked"] as const) {
      if (expected === "blocked") {
        await post(r.auth, b2!.id, "core.start");
        await post(r.auth, b2!.id, "core.abandon", { reason: "rain" });
      }
      const before = await stamp();
      expect(before.state, "premise").toBe(expected);
      await rearm(r, r.swissId);
      await rearm(r, r.swissId, { restartPending: false });
      const after = await stamp();
      expect([after.id, after.state, after.updated_at.getTime()], expected).toEqual([before.id, expected, before.updated_at.getTime()]);
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("a lease is judged at the arming's own clock, not its transaction's start", async () => {
    const { r } = await roundOneDecided();
    const armed = await expectArmed(await liveOf(r.swissId, "pair_round"), "round 1 decided");
    await ageDue(armed.id, 30);
    const [{ due }] = await sql<{ due: Date }[]>`select due_at as due from stage_auto_actions where id = ${armed.id}`;
    await withTenant(r.auth.orgId, async (tx) => {
      // The lease runs out 200 ms after this transaction began; the arming reads the clock 400 ms in, so it has lapsed.
      await tx`update stage_auto_actions set lease_until = now() + interval '200 milliseconds' where id = ${armed.id}`;
      await tx`select pg_sleep(0.4)`;
      return rearmAutoActions(tx, r.swissId);
    });
    const after = (await liveOf(r.swissId, "pair_round"))!;
    expect(after.id).toBe(armed.id);
    expect(after.due_at!.getTime(), "the lapsed lease did not hold off the restart").toBeGreaterThan(due.getTime());
  });

  it("a field change whose recompute fails takes the stale draft's confirm row with it (markFieldChangeSeedProposalsStale)", async () => {
    const c = await confirmRig(1);
    await playLeague(c.r, c.leagueIds[0]!, c.entrantIds);
    await completeStage(c.r.auth, c.leagueIds[0]!);
    const armed = await expectArmed(await liveOf(c.koId, "confirm_handoff"), "the source completed");
    // The target's slots are gone (SQL stands in for any change that leaves the knockout ungenerated), so the recompute
    // after the withdrawal refuses SEEDING_RULES_MISSING. The withdrawal is the real producer.
    await sql`delete from fixtures where stage_id = ${c.koId}`;
    await patchEntrant(c.r.auth, c.entrantIds[3]!, { status: "withdrawn" });
    expect((await latestProposal(c.koId))!.status, "premise: the draft went stale and nothing replaced it").toBe("stale");
    expect(await liveOf(c.koId, "confirm_handoff"), "nothing counts down on a stale draft").toBeUndefined();
    const retired = (await rowsOf(c.koId)).find((x) => x.id === armed.id)!;
    expect([retired.state, retired.result]).toEqual(["cancelled", { reason: "superseded" }]);
  });
});

describe("publishAutoActionAlarms never throws (plan Task 5, fix round 1)", () => {
  it("a failing transport is logged, never thrown, so a committed draft or switch cannot become a 500; nothing armed sends nothing", async () => {
    const alarm = { rowId: randomUUID(), stageId: randomUUID(), dueAt: new Date(0) };
    const spy = vi.spyOn(log, "error");
    try {
      await expect(
        publishAutoActionAlarms([alarm], async () => {
          throw new Error("transport down");
        }),
      ).resolves.toBeUndefined();
      expect(spy.mock.calls.filter((c) => JSON.stringify(c).includes("auto_advance_alarm_publish_failed")), "logged once").toHaveLength(1);
      let sent = 0;
      await publishAutoActionAlarms([], async (a) => {
        sent += a.length + 1;
      });
      expect(sent, "the empty case: the transport is not called").toBe(0);
      await publishAutoActionAlarms([alarm], async (a) => {
        sent += a.length;
      });
      expect(sent, "one alarm handed to the transport").toBe(1);
    } finally {
      spy.mockRestore();
    }
  });
});
