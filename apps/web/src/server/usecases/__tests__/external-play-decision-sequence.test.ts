// T16 — the organiser's decisions on an online board are ORDERED actions
// (TEST-STRATEGY: a transitions test and a sequence property). The actions:
//   raise   — a producer opens a fair-play flag (a stand-in row: reconcile's
//             and the sweep's producers are driven in their own suites);
//   look    — the organiser loads the arbiter panel: what they now SEE;
//   close   — "Let the game go on" for what they last saw (ruling A), by one
//             of two organisers;
//   resolve — "Settle the result" with one of the four buttons;
//   hold    — a producer's mid-game diagnosis (holdForOrganiser) arriving
//             late;
//   race    — two organisers settle at the SAME moment (T16 fix round 1,
//             M10): both read the board, both park at the fixture's write
//             lock (append-event.ts's advisory lock), then go. One decision is
//             recorded; the other is told the board changed — never told its
//             own different decision was taken.
// And a SEATED actor (M10): an organiser who plays on the board is refused
// settle and flag-close (ARBITER_PLAYS_THIS_BOARD) at every point, and their
// refusal changes nothing.
// A reference model, typed from the rulings (never from the code), predicts
// every answer and the board after each step: the flags (open, and who
// closed each), what the panel shows, what the queue lists, and that a
// settled board's outcome never moves again.
import { randomUUID } from "node:crypto";
import fc from "fast-check";
import { afterAll, describe, expect, it } from "vitest";
import { EngineError } from "@seazn/engine/core";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { ENGINE_HTTP } from "@/server/api-v1/http";
import type { AuthCtx } from "@/server/api-v1/auth";
import { loadArbiterRound } from "../external-play/arbiter";
import { closeExternalPlayFlags } from "../external-play/flags";
import { listNeedsOrganiserExternalPlay } from "../external-play/queue";
import { RESOLVE_KINDS, resolveExternalPlay, type ResolveKind } from "../external-play/resolve";
import { holdForOrganiser } from "../external-play/result";
import { scoreEvent } from "../scoring";
import { makeUser } from "./_seed";
import { seedOnlineChessRound } from "./_external-play-seed";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (HAS_DB) await sql.end({ timeout: 2 }).catch(() => undefined);
});

type Op =
  | { kind: "raise" }
  | { kind: "look" }
  | { kind: "close"; by: 0 | 1 | 2 }
  | { kind: "resolve"; as: ResolveKind; by?: 0 | 2 }
  /** `ordered`: `a` reaches the board's write lock first (both have read the board) — the race is staged in that
   *  order, so the case names its loser instead of accepting either. */
  | { kind: "race"; a: ResolveKind; b: ResolveKind; ordered?: true }
  | { kind: "hold" };

/** `live`: the game has begun on the ledger (core.start) — a settle then writes the result at once, with no start. */
type Board = { kind: "league" | "knockout" | "swiss"; live?: boolean };
/** The actors: 0 and 1 are organisers who play nowhere; 2 is an organiser SEATED on the board (its home player). */
const SEATED = 2;
const SEATED_REFUSAL: Answer = { refused: [403, "ARBITER_PLAYS_THIS_BOARD"] };
/** A race's loser: the board changed between its read and its write (T16 fix round 2, N2 ruling) — its own code, never
 *  ALREADY_RESOLVED ("already has its result"), which is wrong when the winner's draw left a knockout tie-break owed. */
const STALE: Answer = { refused: [409, "BOARD_CHANGED"] };
/** I-3 (controller ruling, fix round 2): No result is VOID (an abandon) in a league, and in ANY knockout it is refused —
 *  "a knockout game needs a winner" — before anything is written, whether or not play is recorded. The board stays
 *  held. (This suite's knockout board feeds no next match; the ruling does not ask, resolve-test sweeps both lines.) */
const KNOCKOUT: Answer = { refused: [409, "KNOCKOUT_NEEDS_WINNER"] };
/** I-3, fix round 3 (controller ruling): in a Swiss, No result is refused too — a Swiss round needs every game decided
 *  before the next is paired — before anything is written, whether or not play is recorded. A draw is a result there. */
const SWISS: Answer = { refused: [409, "SWISS_NEEDS_RESULT"] };
/** M-7, fix round 4 (review): the request names the outcome the organiser was shown — No result (the void) or the
 *  double walkover. This suite's board is held `not_started` (a player came), so a league offers the void, and a double
 *  walkover asked for there is a stale screen's: refused NO_RESULT_CHANGED — its own code, never a race loser's
 *  BOARD_CHANGED — nothing written, the board still held. */
const MISMATCH: Answer = { refused: [409, "NO_RESULT_CHANGED"] };

/** The model: what the rulings say the board is. */
type Model = {
  flags: { id: string; closedBy: number | null }[];
  seen: string[] | null;
  /** The queue's reason while the board waits for a decision. */
  heldFor: string | null;
  tiebreak: boolean;
  settled: boolean;
};

type Answer = { ok: unknown } | { refused: [number, string] };
async function answer(p: Promise<unknown>): Promise<Answer> {
  try {
    return { ok: await p };
  } catch (err) {
    if (err instanceof HttpError) return { refused: [err.status, err.code ?? ""] };
    // An engine refusal reaches the route as itself; v1 answers it with ENGINE_HTTP's status.
    if (err instanceof EngineError) return { refused: [ENGINE_HTTP[err.code], err.code] };
    throw err;
  }
}

/** Ruling-derived: what "Settle the result" answers, and the board after. */
function expectResolve(board: Board, m: Model, as: ResolveKind): Answer {
  if (m.settled) return { refused: [409, "ALREADY_RESOLVED"] };
  const win = as === "home_wins" || as === "away_wins";
  if (m.tiebreak) {
    if (!win) return { refused: [409, "TIEBREAK_NEEDS_WINNER"] };
    m.settled = true;
    m.heldFor = null;
    return { ok: { status: "finished" } };
  }
  // A knockout draw is never decided (spec §3.6): the tie-break is owed.
  if (board.kind === "knockout" && as === "draw") {
    m.tiebreak = true;
    m.heldFor = "tiebreak_owed";
    return { ok: { status: "tiebreak_owed" } };
  }
  // I-3: a knockout game needs a winner — No result is refused, whether or not play is recorded; nothing moves. The
  // stage's refusal comes first, whichever of the two empty-of-winner kinds is asked for.
  if (as === "no_result" || as === "double_walkover") {
    if (board.kind === "knockout") return KNOCKOUT;
    if (board.kind === "swiss") return SWISS;
    if (as === "double_walkover") return MISMATCH;
  }
  m.settled = true;
  m.heldFor = null;
  return { ok: { status: "finished" } };
}

type Counters = Record<
  | "lateStaysOpen" | "reclosedNoop" | "emptyCloseRefused" | "secondSettleRefused" | "tiebreakHeld" | "tiebreakNeedsWinner"
  | "holdAfterSettleNoop" | "seatedRefused" | "raceOneRecorded" | "raceSameOnce" | "raceToldChangedTiebreak" | "knockoutRefused" | "swissRefused" | "mismatchRefused" | "steps",
  number
>;
const zero = (): Counters => ({
  lateStaysOpen: 0, reclosedNoop: 0, emptyCloseRefused: 0, secondSettleRefused: 0, tiebreakHeld: 0,
  tiebreakNeedsWinner: 0, holdAfterSettleNoop: 0, seatedRefused: 0, raceOneRecorded: 0, raceSameOnce: 0,
  raceToldChangedTiebreak: 0, knockoutRefused: 0, swissRefused: 0, mismatchRefused: 0, steps: 0,
});
const total: Counters = zero();

const cloneModel = (m: Model): Model => ({ ...m, flags: m.flags.map((f) => ({ ...f })), seen: m.seen === null ? null : [...m.seen] });

/** What a race may answer, from the rulings: the two run one after the other (either order); or both read the board
 *  first, one decision is recorded and the other is told the board changed (STALE); or — the SAME decision pressed
 *  twice — it is recorded once and both are told so. Each with the model it leaves. */
function raceOutcomes(board: Board, m: Model, a: ResolveKind, b: ResolveKind): { answers: [Answer, Answer]; model: Model; stale: boolean; same: boolean }[] {
  const out: { answers: [Answer, Answer]; model: Model; stale: boolean; same: boolean }[] = [];
  for (const [first, firstIsA] of [[a, true], [b, false]] as const) {
    const serial = cloneModel(m);
    const x = expectResolve(board, serial, first);
    const y = expectResolve(board, serial, firstIsA ? b : a);
    out.push({ answers: firstIsA ? [x, y] : [y, x], model: serial, stale: false, same: false });
    const raced = cloneModel(m);
    const w = expectResolve(board, raced, first);
    if ("ok" in w) {
      out.push({ answers: firstIsA ? [w, STALE] : [STALE, w], model: raced, stale: true, same: false });
      if (a === b) out.push({ answers: [w, w], model: raced, stale: false, same: true });
    }
  }
  return out;
}

/** Start every call, wait until each has either parked behind a held write lock on the fixture (transitively — the
 *  second parks behind the first) or already answered, then release the lock. Deterministic: both read the board
 *  before either writes (a bare Promise.all mostly serialises on its own). `ordered`: each call starts only once the
 *  one before it has parked, so the lock's wait queue (first come, first served) hands it out in the calls' order. */
async function parked(fixtureId: string, calls: (() => Promise<unknown>)[], ordered = false): Promise<Answer[]> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let holding!: (pid: number) => void;
  const held = new Promise<number>((resolve) => (holding = resolve));
  const holder = sql.begin(async (tx) => {
    const [{ pid }] = await tx<{ pid: number }[]>`select pg_backend_pid() as pid`;
    await tx`select pg_advisory_xact_lock(hashtext(${"fixture:" + fixtureId}))`;
    holding(pid);
    await gate;
  });
  const holderPid = await held;
  let answered = 0;
  const running: Promise<Answer>[] = [];
  const start = (c: () => Promise<unknown>) => running.push(answer(c()).finally(() => void (answered += 1)));
  const deadline = Date.now() + 15_000;
  const until = async (k: number) => {
    for (;;) {
      const [{ n }] = await sql<{ n: number }[]>`
        with recursive behind(pid) as (
          select pid from pg_stat_activity where ${holderPid}::int = any(pg_blocking_pids(pid))
          union
          select a.pid from pg_stat_activity a join behind b on b.pid = any(pg_blocking_pids(a.pid))
        ) select count(*)::int as n from behind`;
      if (n + answered >= k) return;
      if (Date.now() > deadline) {
        release();
        await holder;
        throw new Error(`race: only ${n} parked and ${answered} answered of ${k}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  if (ordered) {
    for (const c of calls) {
      start(c);
      await until(running.length);
    }
  } else {
    calls.forEach(start);
    await until(calls.length);
  }
  release();
  await holder;
  return Promise.all(running);
}

async function run(board: Board, ops: Op[]): Promise<void> {
  const r = await seedOnlineChessRound({ fixtures: 1, scheduledAt: new Date(Date.now() - 5 * 60_000) });
  if (board.kind !== "league") await sql`update stages set kind = ${board.kind} where id = ${r.stageId}`;
  await sql`insert into stage_round_opens (stage_id, org_id, round_no, opened_at, opened_by)
            values (${r.stageId}, ${r.orgId}, 1, now(), ${r.ownerUserId})`;
  const b = r.boards[0]!;
  await sql`insert into fixture_external_play (fixture_id, org_id, status, scheduled_at_basis)
            values (${b.fixtureId}, ${r.orgId}, 'pending', now())`;
  await holdForOrganiser({ fixtureId: b.fixtureId, reason: "not_started" });
  // The game begun on the ledger, through the real scoring write (the pad's producer).
  if (board.live) await scoreEvent(r.owner, b.fixtureId, { expected_seq: 0, type: "core.start", payload: {} });
  const second = await makeUser("seq-organiser");
  await sql`insert into org_members (org_id, user_id, role) values (${r.orgId}, ${second.id}, 'admin')`;
  // The seated organiser: the board's own home player, made an admin of the club.
  await sql`insert into org_members (org_id, user_id, role) values (${r.orgId}, ${b.home.userId}, 'admin')
            on conflict (org_id, user_id) do update set role = 'admin'`;
  const actors: AuthCtx[] = [
    r.owner,
    { ...r.owner, userId: second.id, role: "admin" } as AuthCtx,
    { ...r.owner, userId: b.home.userId, role: "admin" } as AuthCtx,
  ];

  let m: Model = { flags: [], seen: null, heldFor: "not_started", tiebreak: false, settled: false };
  let settledOutcome: unknown = undefined;
  const c: Counters = zero();

  for (const op of ops) {
    const label = `${board.kind} ${JSON.stringify(ops)} at ${JSON.stringify(op)}`;
    switch (op.kind) {
      case "raise": {
        const [row] = await sql<{ id: string }[]>`
          insert into fixture_play_flags (fixture_id, org_id, kind, note)
          values (${b.fixtureId}, ${r.orgId}, 'out_of_band_play', ${`plies 3-4 (e7e5 g1f3) ${randomUUID().slice(0, 4)}; camera not required (policy off)`})
          returning id`;
        m.flags.push({ id: row!.id, closedBy: null });
        break;
      }
      case "look": {
        const view = await loadArbiterRound(r.owner, r.divisionId);
        m.seen = view!.boards[0]!.flags.map((f) => f.id);
        break;
      }
      case "close": {
        const ids = m.seen ?? [];
        const got = await answer(closeExternalPlayFlags(actors[op.by]!, b.fixtureId, ids));
        if (ids.length === 0) {
          expect(got, label).toEqual({ refused: [422, "FLAG_IDS_INVALID"] });
          c.emptyCloseRefused++;
          break;
        }
        if (op.by === SEATED) {
          expect(got, label).toEqual(SEATED_REFUSAL);
          c.seatedRefused++;
          break;
        }
        let closed = 0;
        for (const f of m.flags) {
          if (ids.includes(f.id) && f.closedBy === null) {
            f.closedBy = op.by;
            closed++;
          }
        }
        const stillOpen = m.flags.filter((f) => f.closedBy === null).length;
        expect(got, label).toEqual({ ok: { closed, stillOpen } });
        if (closed === 0) c.reclosedNoop++;
        if (m.flags.some((f) => f.closedBy === null && !ids.includes(f.id))) c.lateStaysOpen++;
        break;
      }
      case "resolve": {
        if (op.by === SEATED) {
          expect(await answer(resolveExternalPlay(actors[SEATED]!, b.fixtureId, op.as)), label).toEqual(SEATED_REFUSAL);
          c.seatedRefused++;
          break;
        }
        const wasSettled = m.settled;
        const wasTiebreak = m.tiebreak;
        const expected = expectResolve(board, m, op.as);
        expect(await answer(resolveExternalPlay(r.owner, b.fixtureId, op.as)), label).toEqual(expected);
        if (wasSettled) c.secondSettleRefused++;
        if (!wasTiebreak && m.tiebreak) c.tiebreakHeld++;
        if ("refused" in expected && expected.refused[1] === "TIEBREAK_NEEDS_WINNER") c.tiebreakNeedsWinner++;
        if (expected === KNOCKOUT) c.knockoutRefused++;
        if (expected === SWISS) c.swissRefused++;
        if (expected === MISMATCH) c.mismatchRefused++;
        break;
      }
      case "race": {
        const got = await parked(
          b.fixtureId,
          [() => resolveExternalPlay(actors[0]!, b.fixtureId, op.a), () => resolveExternalPlay(actors[1]!, b.fixtureId, op.b)],
          op.ordered === true,
        );
        // Ordered: `a` writes first, so the only ruled answer is `a`'s decision recorded and `b` told the board changed.
        const options = raceOutcomes(board, m, op.a, op.b).filter((o) => !op.ordered || (o.stale && "ok" in o.answers[0]));
        const hit = options.find((o) => JSON.stringify(o.answers) === JSON.stringify(got));
        expect(hit, `${label}: ${JSON.stringify(got)} is one of ${JSON.stringify(options.map((o) => o.answers))}`).toBeDefined();
        m = hit!.model;
        // Two different decisions at once: exactly one is recorded, the other refused (a serial order and a parked
        // race answer alike when the first settles the board; the parked KO draw answers only as a race).
        if (op.a !== op.b && got.filter((g) => "ok" in g).length === 1) c.raceOneRecorded++;
        if (hit!.same) c.raceSameOnce++;
        // N2: the loser of a race whose winner left a knockout tie-break owed — told the board CHANGED.
        if (hit!.stale && m.tiebreak && !m.settled) c.raceToldChangedTiebreak++;
        break;
      }
      case "hold": {
        // A late mid-game diagnosis never replaces a reason on the row, and a
        // board with its result is never held (result.ts hold()).
        const got = await holdForOrganiser({ fixtureId: b.fixtureId, reason: "provider_error", detail: "late 502 (TEST)" });
        if (m.settled) {
          expect(got, label).toEqual({ wrote: "none" });
          c.holdAfterSettleNoop++;
        } else {
          expect(got, label).toEqual({ wrote: "needs_organiser", reason: m.heldFor });
        }
        break;
      }
    }
    c.steps++;

    // The board after the step, as the organiser's screens read it.
    const rows = await sql<{ id: string; closed_at: Date | null; resolved_by: string | null }[]>`
      select id, closed_at, resolved_by from fixture_play_flags where fixture_id = ${b.fixtureId} order by opened_at, id`;
    expect(
      rows.map((x) => [x.id, x.closed_at === null ? null : x.resolved_by]),
      `${label}: the flags and who closed each`,
    ).toEqual(m.flags.map((f) => [f.id, f.closedBy === null ? null : actors[f.closedBy]!.userId]));
    const panel = await loadArbiterRound(r.owner, r.divisionId);
    expect(panel!.boards[0]!.flags.map((f) => f.id), `${label}: the panel shows open flags`).toEqual(
      m.flags.filter((f) => f.closedBy === null).map((f) => f.id),
    );
    const queue = await listNeedsOrganiserExternalPlay(r.owner, r.divisionId);
    expect(queue.map((q) => q.reason), `${label}: the queue`).toEqual(m.heldFor === null ? [] : [m.heldFor]);
    const [fx] = await sql<{ outcome: unknown }[]>`select outcome from fixtures where id = ${b.fixtureId}`;
    if (m.settled) {
      if (settledOutcome === undefined) settledOutcome = fx!.outcome;
      expect(fx!.outcome, `${label}: a settled board's outcome never moves`).toEqual(settledOutcome);
    } else {
      expect(fx!.outcome, `${label}: nothing decided yet`).toBeNull();
    }
  }
  for (const k of Object.keys(total) as (keyof Counters)[]) total[k] += c[k];
}

const op: fc.Arbitrary<Op> = fc.oneof(
  { weight: 3, arbitrary: fc.constant<Op>({ kind: "raise" }) },
  { weight: 3, arbitrary: fc.constant<Op>({ kind: "look" }) },
  { weight: 3, arbitrary: fc.constantFrom<Op>({ kind: "close", by: 0 }, { kind: "close", by: 1 }) },
  { weight: 2, arbitrary: fc.constantFrom(...RESOLVE_KINDS).map((as): Op => ({ kind: "resolve", as })) },
  { weight: 1, arbitrary: fc.constant<Op>({ kind: "hold" }) },
  { weight: 1, arbitrary: fc.constantFrom<Op>({ kind: "close", by: SEATED }, ...RESOLVE_KINDS.map((as): Op => ({ kind: "resolve", as, by: SEATED }))) },
  {
    weight: 1,
    arbitrary: fc.tuple(fc.constantFrom(...RESOLVE_KINDS), fc.constantFrom(...RESOLVE_KINDS)).map(([a, b]): Op => ({ kind: "race", a, b })),
  },
);

/** Each prefix ENDS with the claim it exists for, and runs a fixed number of
 *  times — its counter is reached by construction, never by tail luck. */
const PREFIXES: { name: keyof Counters; board: Board; ops: Op[] }[] = [
  { name: "lateStaysOpen", board: { kind: "league" }, ops: [{ kind: "raise" }, { kind: "look" }, { kind: "raise" }, { kind: "close", by: 0 }] },
  { name: "reclosedNoop", board: { kind: "league" }, ops: [{ kind: "raise" }, { kind: "look" }, { kind: "close", by: 0 }, { kind: "close", by: 1 }] },
  { name: "emptyCloseRefused", board: { kind: "league" }, ops: [{ kind: "look" }, { kind: "close", by: 0 }] },
  { name: "secondSettleRefused", board: { kind: "league" }, ops: [{ kind: "resolve", as: "home_wins" }, { kind: "resolve", as: "draw" }] },
  { name: "tiebreakHeld", board: { kind: "knockout" }, ops: [{ kind: "resolve", as: "draw" }] },
  { name: "tiebreakNeedsWinner", board: { kind: "knockout" }, ops: [{ kind: "resolve", as: "draw" }, { kind: "resolve", as: "no_result" }] },
  { name: "holdAfterSettleNoop", board: { kind: "league" }, ops: [{ kind: "resolve", as: "away_wins" }, { kind: "hold" }] },
  // M10: the seated organiser, before and after a settle; the race, on a board not begun and on one being played.
  { name: "seatedRefused", board: { kind: "league" }, ops: [{ kind: "raise" }, { kind: "look" }, { kind: "close", by: SEATED }, { kind: "resolve", as: "home_wins", by: SEATED }] },
  { name: "raceOneRecorded", board: { kind: "league", live: true }, ops: [{ kind: "race", a: "home_wins", b: "away_wins" }] },
  { name: "raceOneRecorded", board: { kind: "knockout" }, ops: [{ kind: "race", a: "draw", b: "away_wins" }] },
  { name: "raceSameOnce", board: { kind: "league", live: true }, ops: [{ kind: "race", a: "draw", b: "draw" }] },
  // N2: the knockout race's loser, with the winner's draw first — staged in order, on a board not begun and on one
  // being played (no core.start to race on), so the loser meets the tie-break owed.
  { name: "raceToldChangedTiebreak", board: { kind: "knockout" }, ops: [{ kind: "race", a: "draw", b: "home_wins", ordered: true }] },
  { name: "raceToldChangedTiebreak", board: { kind: "knockout", live: true }, ops: [{ kind: "race", a: "draw", b: "away_wins", ordered: true }] },
  // RB1: No result on a final is W2b's refusal — before play and after it — and the board stays the organiser's.
  { name: "knockoutRefused", board: { kind: "knockout" }, ops: [{ kind: "resolve", as: "no_result" }] },
  { name: "knockoutRefused", board: { kind: "knockout", live: true }, ops: [{ kind: "resolve", as: "no_result" }] },
  // Fix round 3: No result in a Swiss is refused — before play and after it — and the board stays the organiser's.
  { name: "swissRefused", board: { kind: "swiss" }, ops: [{ kind: "resolve", as: "no_result" }] },
  { name: "swissRefused", board: { kind: "swiss", live: true }, ops: [{ kind: "resolve", as: "no_result" }] },
  // M-7, fix round 4: a double walkover asked of a board offering the void — before play and after it.
  { name: "mismatchRefused", board: { kind: "league" }, ops: [{ kind: "resolve", as: "double_walkover" }] },
  { name: "mismatchRefused", board: { kind: "league", live: true }, ops: [{ kind: "resolve", as: "double_walkover" }] },
];
const RUNS_PER_PREFIX = 6;

describe.runIf(HAS_DB)("the organiser's decisions — any order of raise, look, close, resolve and hold", () => {
  it(
    "every answer and every screen matches the ruling model; each claim's path is reached",
    async () => {
      let runs = 0;
      for (const p of PREFIXES) {
        await fc.assert(
          fc.asyncProperty(fc.array(op, { maxLength: 5 }), async (tail) => {
            await run(p.board, [...p.ops, ...tail]);
            runs++;
          }),
          { numRuns: RUNS_PER_PREFIX, seed: 0x7160 },
        );
      }
      expect(runs, "anti-vacuity: runs").toBe(PREFIXES.length * RUNS_PER_PREFIX);
      for (const p of PREFIXES) expect(total[p.name], `anti-vacuity: ${p.name}`).toBeGreaterThanOrEqual(RUNS_PER_PREFIX);
      expect(total.steps).toBeGreaterThan(PREFIXES.reduce((n, p) => n + p.ops.length, 0) * RUNS_PER_PREFIX - 1);
    },
    240_000,
  );
});

// The transitions, one row each (from the rulings), so a failure names the
// edge rather than a shrunk sequence.
describe.runIf(HAS_DB)("the organiser's decisions — transitions", () => {
  const T: { from: string; board: Board; ops: Op[] }[] = [
    { from: "held → settled", board: { kind: "league" }, ops: [{ kind: "resolve", as: "home_wins" }] },
    { from: "held → drawn (league) → settled", board: { kind: "league" }, ops: [{ kind: "resolve", as: "draw" }] },
    { from: "held → no result → settled (I-3: void, nothing played)", board: { kind: "league" }, ops: [{ kind: "resolve", as: "no_result" }] },
    { from: "game begun on the ledger → no result → settled (I-3: void, the Start stands)", board: { kind: "league", live: true }, ops: [{ kind: "resolve", as: "no_result" }] },
    { from: "held (KO) → tiebreak owed → settled by a winner", board: { kind: "knockout" }, ops: [{ kind: "resolve", as: "draw" }, { kind: "resolve", as: "home_wins" }] },
    { from: "held (KO) → no result ⇒ refused KNOCKOUT_NEEDS_WINNER, still held → a winner settles it", board: { kind: "knockout" }, ops: [{ kind: "resolve", as: "no_result" }, { kind: "resolve", as: "away_wins" }] },
    { from: "held (Swiss) → no result ⇒ refused SWISS_NEEDS_RESULT, still held → a draw settles it (fix round 3)", board: { kind: "swiss" }, ops: [{ kind: "resolve", as: "no_result" }, { kind: "resolve", as: "draw" }] },
    { from: "held (league, a player came) → double walkover ⇒ refused NO_RESULT_CHANGED, still held → No result voids it (M-7)", board: { kind: "league" }, ops: [{ kind: "resolve", as: "double_walkover" }, { kind: "resolve", as: "no_result" }] },
    { from: "settled → settle again ⇒ refused", board: { kind: "league" }, ops: [{ kind: "resolve", as: "draw" }, { kind: "resolve", as: "away_wins" }] },
    { from: "flag open → seen → closed", board: { kind: "league" }, ops: [{ kind: "raise" }, { kind: "look" }, { kind: "close", by: 1 }] },
    { from: "flag closed → closed again ⇒ no-op", board: { kind: "league" }, ops: [{ kind: "raise" }, { kind: "look" }, { kind: "close", by: 0 }, { kind: "close", by: 1 }] },
    { from: "flag raised after the look ⇒ stays open", board: { kind: "league" }, ops: [{ kind: "look" }, { kind: "raise" }, { kind: "raise" }, { kind: "look" }, { kind: "raise" }, { kind: "close", by: 0 }] },
    { from: "flags closed, THEN settled — and the reverse", board: { kind: "league" }, ops: [{ kind: "raise" }, { kind: "look" }, { kind: "close", by: 0 }, { kind: "resolve", as: "home_wins" }, { kind: "raise" }, { kind: "look" }, { kind: "close", by: 1 }] },
    // M10: two organisers at once — and the organiser who plays on the board.
    { from: "two organisers settle a game being played at once, differently ⇒ one recorded, the other told it changed", board: { kind: "league", live: true }, ops: [{ kind: "race", a: "home_wins", b: "away_wins" }] },
    { from: "two organisers press the same settle at once ⇒ recorded once", board: { kind: "league" }, ops: [{ kind: "race", a: "no_result", b: "no_result" }] },
    // N2: the knockout race's loser is told the board CHANGED (its tie-break now owed), never "already has its result";
    // the screens after the step read tiebreak_owed (run's per-step checks). Then the winner it was racing settles it.
    { from: "KO: a draw and a winner at once, the draw first ⇒ tie-break owed, the other told BOARD_CHANGED; then a winner settles it", board: { kind: "knockout", live: true }, ops: [{ kind: "race", a: "draw", b: "home_wins", ordered: true }, { kind: "resolve", as: "home_wins" }] },
    { from: "league: a winner and the other winner at once, in order ⇒ one recorded, the other told BOARD_CHANGED; a third told ALREADY_RESOLVED", board: { kind: "league", live: true }, ops: [{ kind: "race", a: "home_wins", b: "away_wins", ordered: true }, { kind: "resolve", as: "draw" }] },
    { from: "a seated organiser is refused, held and settled alike", board: { kind: "league" }, ops: [{ kind: "resolve", as: "draw", by: SEATED }, { kind: "resolve", as: "home_wins" }, { kind: "resolve", as: "away_wins", by: SEATED }] },
  ];
  it("each transition lands where the rulings say (counted)", async () => {
    let checked = 0;
    for (const t of T) {
      await run(t.board, t.ops);
      checked++;
    }
    expect(checked, "anti-vacuity: transitions").toBe(T.length);
  }, 120_000);
});
