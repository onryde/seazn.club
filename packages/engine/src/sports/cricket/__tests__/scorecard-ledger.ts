// Builds a cricket ledger by REPLAYING the reducer one event at a time — the
// pad-shaped write path (spec 04 §2, W4a #425 §3.3: `strict: true` for every
// event, matching `cricket.test.ts`'s own `STRICT_ALL` convention). Ball
// numbering (`over`/`ballInOver`) and the striker/non-striker pair are never
// tracked locally: both are read back from the reducer's own state after each
// apply, so this file can never drift from what `applyDelivery` itself
// enforces.
//
// Toss ordering (pinned from the reducer, cricket.ts's `apply()`): `core.start`
// requires `state.phase === "pre"` ("already started" otherwise), and
// `cricket.toss` ALSO requires `state.phase === "pre"` ("toss must precede
// core.start" otherwise) — applying `core.start` first flips phase to "live",
// which then makes `cricket.toss` throw WRONG_PHASE. So the only legal order
// is TOSS THEN START, and that is what this builder does.
import type { CoreEv, EventEnvelope, FoldContext } from "../../../core/events.ts";
import type { Lineup, LineupPair } from "../../../core/types.ts";
import { makeEnvelope } from "../../../testkit/helpers.ts";
import { cricket, type CricketBallEv, type CricketCfg, type CricketEv, type CricketState } from "../cricket.ts";

// The two lineups every builder and fixture in this suite shares. ONE
// authority (Task 4): `scorecard.test.ts` used to keep its own copy while the
// summary-only builder kept a second, so a name added to one silently
// disagreed with every `didNotBat` assertion written against the other.
export const HOME = ["h1", "h2", "h3", "h4", "h5", "h6", "h7", "h8"];
export const AWAY = ["a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8"];

export type Delivery =
  // `allRun` (fix round 1, finding 7): runs completed by RUNNING never carry
  // a `boundary` flag even at 4 — the engine's own player-stats fold keys
  // fours/sixes off `boundary` alone (cricket.ts:2448), so this is the
  // NEGATIVE case that flag needs: a stroke run to 4 without the ball
  // crossing the rope.
  // `bowler` (Task 3 fix round 1, addendum): names a bowler OTHER than the one
  // whose over this is. `applyDelivery` refuses that on a strict append
  // ("over in progress belongs to …" — one of cricket.ts's §3.3 strict-only
  // seams, since where an over ENDS is cfg-derived and can move under a
  // recorded ledger), so this one delivery is recorded with `strict: false`,
  // which is exactly what the READ path passes. On replay the reducer keeps
  // the over's own bowler and charges the runs to them — so a card that
  // reported the payload's name instead would be crediting a bowler the
  // reducer did not.
  | { bat: 0 | 1 | 2 | 3 | 4 | 6; allRun?: boolean; bowler?: string }
  | { extra: "wide" | "noball" | "bye" | "legbye" | "penalty"; runs: number; bat?: number }
  | {
      out: "bowled" | "caught" | "lbw" | "runout" | "stumped" | "hitwicket" | "obstructed" | "timedout" | "hitballtwice";
      fielder?: string;
      assist?: string;
      bat?: number;
    }
  // `reason` (fix round 1, finding 4): defaults to "hurt" (retired NOT out —
  // the previous, only behaviour) so every existing caller is unaffected;
  // "out" is Law 25.4.3's retired-out, a genuine dismissal credited to no
  // bowler.
  | { retire: true; reason?: "hurt" | "out" | "other" }
  // NOT deliveries — match events placed IN SEQUENCE among them, the same
  // posture `retire` already had (Task 3 fix round 1, findings 2 and 6).
  // `revise` is spec §2.5's umpire-confirmed rain revision: `oversPerSide`
  // moves the OPEN innings' `ballsLimit`, `target` sets `revisedTarget`,
  // which is what `chaseTarget` then answers with. `matchClose` is
  // `cricket.match.close`, the two-innings time-expiry draw — the one
  // decision that leaves its innings OPEN, which is exactly why the live
  // block needs it.
  | { revise: { oversPerSide?: number; target?: number } }
  | { matchClose: true }
  // `core.abandon` (Task 4). The ONE match event that is legal inside a
  // super-over entry as well, and the reason it exists here: `applyAbandon`
  // in phase `super_over` settles the match as a tie — `{ phase: "done",
  // outcome: { kind: "tie" } }` — WITHOUT closing the super-over innings it
  // interrupted, which is the one state in which a `closed`-only live gate
  // still reports a scoreboard for a finished match.
  | { abandon: true };

/** The `Delivery` members that actually produce a `cricket.ball` — everything
 *  the four match-event variants above are not. */
type BallDelivery = Exclude<
  Delivery,
  { retire: true } | { revise: object } | { matchClose: true } | { abandon: true }
>;

export interface Script {
  cfg: Partial<CricketCfg>;
  home: readonly string[]; // person ids in batting order
  away: readonly string[];
  tossWonBy: "home" | "away";
  elected: "bat" | "bowl";
  innings: ReadonlyArray<{
    batting: "home" | "away";
    bowlers: readonly string[];
    deliveries: readonly Delivery[];
    close?: "all_out" | "overs_complete" | "target_reached" | "time" | "other";
    // Leave the innings OPEN — no `cricket.innings.close` after its
    // deliveries. Task 3: a live block, an unbroken partnership and chase
    // maths all only exist while an innings is in progress, and this builder
    // otherwise always closes what it opened (see the close block below), so
    // there was no way to script a match in play. Only meaningful on the LAST
    // innings of a script: the reducer opens the next innings on its first
    // ball, and a ball cannot reach an innings that is not the open one.
    leaveOpen?: boolean;
    // Fix round 1, finding 6: routes this WHOLE entry's deliveries through
    // `cricket.superover.ball` into `state.superOver.innings` instead of the
    // match's own `state.innings`. This builder does not (yet) express the
    // tie/phase-transition sequence that gets a match INTO a super over —
    // the entries before this one must already tie the match through the
    // ordinary path (`applySuperOverBall` requires `state.phase ===
    // "super_over"`, which only `decideTie` sets). `batting` still selects
    // which side's lineup feeds the striker/non-striker/bowler defaults —
    // pass whichever side the reducer's OWN `soBattingSideAt` (ICC
    // alternation) says bats first in this super over: `applySuperOverBall`
    // derives `battingSide` itself and refuses a payload whose striker
    // isn't in that side's order, so this can never be assumed wrong and
    // silently accepted. A minimal escape hatch for one regression test —
    // Task 4 may build a fuller super-over ledger surface later.
    superOver?: boolean;
  }>;
}

export interface ScriptLedger {
  events: EventEnvelope[];
  state: CricketState;
  cfg: CricketCfg;
  lineups: LineupPair;
}

// Dismissal kinds crediting the bowler in the scorebook (Law 8/36/38/39/40, as
// the reducer itself enforces via `BOWLER_CREDITED_KINDS` — mirrored here, not
// re-derived from anywhere else, because the reducer does not export its set).
const BOWLER_CREDITED_KINDS = new Set(["bowled", "caught", "lbw", "stumped", "hitwicket"]);

// Every event is applied as a fresh append (`strict: true`) — this builder IS
// the write path, not a read replay. `scorecard.ts`'s own fold uses the
// opposite (`strict: false`), matching what `foldFixture`'s read path passes.
const WRITE_CTX: FoldContext = { strict: true };

// …except for the one delivery kind that models a §3.3 strict-only refusal:
// see `Delivery`'s `bowler` field. This is what `scorecard.ts`'s fold — and
// `foldFixture`'s read path — pass for every event.
const READ_CTX: FoldContext = { strict: false };

function buildLineup(entrantId: string, personIds: readonly string[]): Lineup {
  return {
    entrantId,
    slots: personIds.map((personId, i) => ({
      personId,
      slot: "starting" as const,
      orderNo: i + 1,
    })),
  };
}

// A boundary is about the BAT RUNS on the ball, independent of whether the
// same ball also carried a no-ball/bye/legbye/penalty extra — a no-ball hit
// for four is still a four. Only `wide` can never carry one: the reducer
// itself rejects `runs.bat > 0` off a wide (cricket.ts's `applyDelivery`), so
// `bat` is always 0 there and this never fires for that kind.
function boundaryOf(bat: number | undefined): 4 | 6 | undefined {
  return bat === 4 || bat === 6 ? bat : undefined;
}

function buildBallPayload(
  delivery: BallDelivery,
  base: { over: number; ballInOver: number; striker: string; nonStriker: string; bowler: string },
): CricketBallEv {
  if ("extra" in delivery) {
    const boundary = boundaryOf(delivery.bat);
    return {
      ...base,
      runs: { bat: delivery.bat ?? 0, extras: { kind: delivery.extra, runs: delivery.runs } },
      ...(boundary !== undefined ? { boundary } : {}),
    };
  }
  if ("out" in delivery) {
    // Fix round 1, finding 8 (Task 1 re-review): a wicket ball can still
    // clear the boundary (e.g. hit wicket playing a shot for four) — this
    // branch had never called `boundaryOf` at all, so no wicket ball could
    // ever carry the flag regardless of `bat`.
    const boundary = boundaryOf(delivery.bat);
    return {
      ...base,
      runs: { bat: delivery.bat ?? 0 },
      wicket: {
        kind: delivery.out,
        out: base.striker,
        ...(delivery.fielder !== undefined ? { fielder: delivery.fielder } : {}),
        ...(delivery.assist !== undefined ? { fielderAssist: delivery.assist } : {}),
        bowlerCredited: BOWLER_CREDITED_KINDS.has(delivery.out),
      },
      ...(boundary !== undefined ? { boundary } : {}),
    };
  }
  // Plain bat delivery. `allRun` (finding 7's negative case) suppresses the
  // flag even at 4/6 — see `Delivery`'s own doc above.
  const boundary = delivery.allRun === true ? undefined : boundaryOf(delivery.bat);
  return {
    ...base,
    runs: { bat: delivery.bat },
    ...(boundary !== undefined ? { boundary } : {}),
  };
}

/** Returns the envelopes AND the reducer's final state, so tests can assert parity. */
export function scriptLedger(script: Script): ScriptLedger {
  const cfg = cricket.configSchema.parse({ ...script.cfg });
  const lineups: LineupPair = {
    home: buildLineup("home", script.home),
    away: buildLineup("away", script.away),
  };

  const events: EventEnvelope[] = [];
  let state = cricket.init(cfg, lineups);
  let seq = 0;

  function record(type: string, payload: unknown, ctx: FoldContext = WRITE_CTX): void {
    const env = makeEnvelope(seq, { type, payload });
    seq += 1;
    events.push(env);
    state = cricket.apply(state, env as EventEnvelope<CricketEv | CoreEv>, ctx);
  }

  // Toss BEFORE start — see the file header.
  record("cricket.toss", { wonBy: script.tossWonBy, elected: script.elected });
  record("core.start", {});

  for (const inningsSpec of script.innings) {
    const bpo = cfg.ballsPerOver;

    // Fix round 1, finding 6 — a super-over entry, routed into
    // `state.superOver.innings` via `cricket.superover.ball` instead of the
    // ordinary path below. See `Script.innings`'s own doc on this field.
    if (inningsSpec.superOver === true) {
      const soBattingOrder = inningsSpec.batting === "home" ? script.home : script.away;
      const soAt = state.superOver?.innings.length ?? 0;
      for (const delivery of inningsSpec.deliveries) {
        // `core.abandon` is the one match event a super-over entry accepts —
        // see `Delivery`'s own doc for why this task needs it there.
        if ("abandon" in delivery) {
          record("core.abandon", { reason: "rain" });
          continue;
        }
        if ("retire" in delivery || "revise" in delivery || "matchClose" in delivery) {
          throw new Error("scriptLedger: only deliveries are supported in a super-over entry");
        }
        const soInnings = state.superOver?.innings[soAt];
        const soFine = soInnings?.fine;
        const soLegalBalls = soInnings?.legalBalls ?? 0;
        const striker = soFine?.striker ?? soBattingOrder[0];
        const nonStriker = soFine?.nonStriker ?? soBattingOrder[1];
        if (striker === undefined || nonStriker === undefined) {
          throw new Error("scriptLedger: super-over innings needs at least 2 batters");
        }
        const over = Math.floor(soLegalBalls / bpo);
        const ballInOver = (soLegalBalls % bpo) + 1;
        const bowler = inningsSpec.bowlers[over % inningsSpec.bowlers.length];
        if (bowler === undefined) throw new Error("scriptLedger: no bowlers given");
        const payload = buildBallPayload(delivery, { over, ballInOver, striker, nonStriker, bowler });
        record("cricket.superover.ball", payload);
      }
      continue;
    }

    const at = state.innings.length;
    const battingOrder = inningsSpec.batting === "home" ? script.home : script.away;

    for (const delivery of inningsSpec.deliveries) {
      // `legalBalls` lives on `InningsState`; the crease (striker/non-striker,
      // current bowler) lives one level down on `InningsState.fine`.
      const innings = state.innings[at];
      const fine = innings?.fine;
      if ("retire" in delivery) {
        const striker = fine?.striker ?? battingOrder[0];
        if (striker === undefined) throw new Error("scriptLedger: no striker to retire");
        record("cricket.retire", { person: striker, reason: delivery.reason ?? "hurt" });
        continue;
      }
      if ("revise" in delivery) {
        record("cricket.revise", delivery.revise);
        continue;
      }
      if ("matchClose" in delivery) {
        record("cricket.match.close", {});
        continue;
      }
      if ("abandon" in delivery) {
        record("core.abandon", { reason: "rain" });
        continue;
      }
      const legalBalls = innings?.legalBalls ?? 0;
      const striker = fine?.striker ?? battingOrder[0];
      const nonStriker = fine?.nonStriker ?? battingOrder[1];
      if (striker === undefined || nonStriker === undefined) {
        throw new Error("scriptLedger: innings needs at least 2 batters");
      }
      const over = Math.floor(legalBalls / bpo);
      const ballInOver = (legalBalls % bpo) + 1;
      const named = "bowler" in delivery ? delivery.bowler : undefined;
      const bowler = named ?? inningsSpec.bowlers[over % inningsSpec.bowlers.length];
      if (bowler === undefined) throw new Error("scriptLedger: no bowlers given");
      const payload = buildBallPayload(delivery, { over, ballInOver, striker, nonStriker, bowler });
      // A named bowler who does not own this over is a strict-only refusal —
      // see `Delivery`'s own doc. Record it the way the READ path folds it.
      record("cricket.ball", payload, named === undefined ? WRITE_CTX : READ_CTX);
    }

    // Close explicitly unless the reducer's own auto-close rules (all-out,
    // balls exhausted, target passed — `autoClose` in cricket.ts) already
    // closed it. Re-closing an already-closed innings throws ("no innings in
    // progress"), so this is checked from state, never assumed from the script.
    const stillOpen = state.innings[at] !== undefined && !state.innings[at].closed;
    if (stillOpen && inningsSpec.leaveOpen !== true) {
      record("cricket.innings.close", inningsSpec.close === undefined ? {} : { reason: inningsSpec.close });
    }
  }

  return { events, state, cfg, lineups };
}

// ---------------------------------------------------------------------------
// Coarser fidelities (Task 4) — the ledgers `Script`/`scriptLedger` cannot
// express at all, because that builder is ball-by-ball by construction.
// Same posture as `scriptLedger` itself: every event is REPLAYED through
// `cricket.apply` as it is recorded (`strict: true`, the write path), so an
// illegal sequence fails here rather than reaching a test as a silently
// wrong expectation.
// ---------------------------------------------------------------------------

/** One `cricket.innings.summary` payload (band 0 — cricket.ts's
 *  `CricketInningsSummary`). `partial: true` is what keeps the innings OPEN:
 *  `applySummary` ends in `closeOpenInnings` for every summary WITHOUT it, so
 *  a coarse ledger that omits it can never show a live block. With it, the
 *  reducer's ordinary `autoClose` predicates still apply — totals that reach
 *  the target, all-out or the balls quota close the innings anyway. */
export interface SummaryTotals {
  runs: number;
  wickets: number;
  legalBalls: number;
  declared?: boolean;
  boundaries?: number;
  partial?: boolean;
}

/** One `cricket.player.line` payload (band 2 — cricket.ts's
 *  `CricketPlayerLine`). `applyPlayerLine` REFUSES a line whose innings is
 *  not CLOSED, and cross-checks it against the innings totals (a coarse
 *  innings caps each aspect at its own total; a fine one demands exact
 *  agreement with `FineInnings`), so these numbers are never free.
 *
 *  Task 17/owner ruling 12 — `fours`/`sixes`/`dismissal` and
 *  `maidens`/`wides`/`noBalls` are OPTIONAL, mirroring `CricketPlayerLine`
 *  exactly: a test posting a line without them still exercises the same
 *  null-fallback path Task 4's band-2 test pins. */
export interface PlayerLine {
  innings: number;
  person: string;
  batting?: {
    runs: number;
    balls: number;
    out?: boolean;
    fours?: number;
    sixes?: number;
    dismissal?: { kind: string; bowler?: string; fielder?: string };
  };
  bowling?: { legalBalls: number; runs: number; wickets: number; maidens?: number; wides?: number; noBalls?: number };
}

interface CoarseSpec {
  cfg: Partial<CricketCfg>;
  /** `cricket.toss` is band 1 in `padSpec(cfg).fidelity`, so a ledger
   *  carrying one can never read band 0 — which is exactly the band a
   *  summary-only ledger exists to exercise. Opt-in for that reason alone;
   *  the reducer itself is happy without a toss (`core.start` requires only
   *  `phase === "pre"`, and `battingFirst` defaults to home). */
  toss: boolean;
  innings: readonly SummaryTotals[];
  /** A `cricket.innings.close` after the last summary. Only meaningful with
   *  a `partial` summary — a non-partial one has already closed the innings
   *  and re-closing throws ("no innings in progress"). */
  close: boolean;
  lines: readonly PlayerLine[];
}

function coarseLedger(spec: CoarseSpec): ScriptLedger {
  const cfg = cricket.configSchema.parse({ ...spec.cfg });
  const lineups: LineupPair = { home: buildLineup("home", HOME), away: buildLineup("away", AWAY) };
  const events: EventEnvelope[] = [];
  let state = cricket.init(cfg, lineups);
  let seq = 0;

  function record(type: string, payload: unknown): void {
    const env = makeEnvelope(seq, { type, payload });
    seq += 1;
    events.push(env);
    state = cricket.apply(state, env as EventEnvelope<CricketEv | CoreEv>, WRITE_CTX);
  }

  // Toss BEFORE start — see the file header.
  if (spec.toss) record("cricket.toss", { wonBy: "home", elected: "bat" });
  record("core.start", {});
  for (const totals of spec.innings) record("cricket.innings.summary", totals);
  if (spec.close) record("cricket.innings.close", { reason: "other" });
  for (const line of spec.lines) record("cricket.player.line", line);

  return { events, state, cfg, lineups };
}

const COARSE_CFG: Partial<CricketCfg> = { ballsPerInnings: 12, playersPerSide: 8, minOversForResult: 2 };

// A completed first innings and a second still in progress. The second is
// what gives the fold both a live block and a CHASE to report a target for
// (`chaseTarget` answers `innings[0].runs + 1` for a one-innings-a-side
// match). Its totals sit under every `autoClose` predicate — runs below the
// target of 43, wickets below all-out (7), legal balls below the 12-ball
// quota — so `partial: true` genuinely leaves it open.
const DEFAULT_SUMMARY_INNINGS: readonly SummaryTotals[] = [
  { runs: 42, wickets: 3, legalBalls: 12 },
  { runs: 20, wickets: 1, legalBalls: 6, partial: true },
];

/** Band 0: `cricket.innings.summary` events and nothing else. No toss by
 *  default — see `CoarseSpec.toss`. */
export function summaryOnlyLedger(
  innings: readonly SummaryTotals[] = DEFAULT_SUMMARY_INNINGS,
  opts: { toss?: boolean; cfg?: Partial<CricketCfg> } = {},
): ScriptLedger {
  return coarseLedger({
    cfg: opts.cfg ?? COARSE_CFG,
    toss: opts.toss ?? false,
    innings,
    close: false,
    lines: [],
  });
}

// 48 legal balls needs a quota that holds them: `applySummary`'s strict
// `legalBalls > ballsLimit` check is measured against `cfg.ballsPerInnings`.
// 120 also keeps `autoClose` from closing the innings on balls exhausted,
// which is what leaves an explicit `cricket.innings.close` legal below.
const LINE_CFG: Partial<CricketCfg> = { ballsPerInnings: 120, playersPerSide: 8, minOversForResult: 2 };

const DEFAULT_LINE_TOTALS: SummaryTotals = { runs: 54, wickets: 4, legalBalls: 48, partial: true };

// h1 bats for home (innings 1's batting side, home having won the toss and
// elected to bat); a7 bowls for away. `applyPlayerLine` checks both against
// `state.orders`, so a name from the wrong side is refused when this builder
// runs, not when a test reads the card.
const DEFAULT_LINES: readonly PlayerLine[] = [
  { innings: 1, person: "h1", batting: { runs: 30, balls: 20, out: true } },
  { innings: 1, person: "a7", bowling: { legalBalls: 12, runs: 20, wickets: 2 } },
];

/**
 * Band 2: an innings recorded as totals, then per-player lines over it.
 *
 * ORDERING IS FORCED BY THE REDUCER, and it is not the order Task 4's brief
 * sketched (`summary`, lines, `innings.close`). `applyPlayerLine` opens with
 * `if (innings === undefined || !innings.closed) invalid(...)` — a line is
 * only legal against a CLOSED innings — so the close has to come BEFORE the
 * lines, not after them. The summary carries `partial: true` for exactly
 * that reason: a non-partial summary ends in `closeOpenInnings` itself, and
 * a `cricket.innings.close` behind it would throw "no innings in progress".
 */
export function lineLedger(
  totals: SummaryTotals = DEFAULT_LINE_TOTALS,
  lines: readonly PlayerLine[] = DEFAULT_LINES,
): ScriptLedger {
  return coarseLedger({ cfg: LINE_CFG, toss: true, innings: [totals], close: true, lines });
}

// ---------------------------------------------------------------------------
// A match tied in regulation — with and without a super over configured.
// Both share the SAME regulation innings, so "one match, decided two
// different ways by one cfg flag" is structural rather than asserted.
// ---------------------------------------------------------------------------

// Home 2, away 2. `chaseTarget` is 3, away finish on `target - 1`, which is
// `decideAfterClose`'s tie branch.
const TIE_IN_REGULATION: Script["innings"] = [
  { batting: "home", bowlers: ["a7"], deliveries: [{ bat: 1 }, { bat: 1 }], close: "other" },
  { batting: "away", bowlers: ["h7"], deliveries: [{ bat: 1 }, { bat: 1 }], close: "other" },
];

/** A tie that STANDS: `decideTie` only opens a super over when
 *  `cfg.superOver` is on; otherwise it settles `{ kind: "tie" }` there and
 *  then. */
export const TIE_NO_SUPER_OVER: Script = {
  cfg: { ballsPerInnings: 12, playersPerSide: 8, minOversForResult: 2 },
  home: HOME,
  away: AWAY,
  tossWonBy: "home",
  elected: "bat",
  innings: TIE_IN_REGULATION,
};

/**
 * The same tie, with a super over configured and BOTH of its innings bowled
 * — so the fold has two super-over innings to render as cards.
 *
 * Batting sides are the reducer's, not a guess: `soBattingSideAt` puts the
 * side that batted SECOND in the match in first in the super over (ICC), so
 * away opens and home reply. Each innings ends on `applySuperOverBall`'s own
 * close conditions — six legal balls, two wickets, or the reply passing its
 * target — never on an explicit close event, of which a super-over innings
 * has none.
 *
 * Away make 7 (a four, a wide, a two, then four dots); home reply with six
 * singles for 6 and fall one short, which decides the match. The wide is
 * deliberate: no main innings here bowls one, so a wide on a MAIN card can
 * only have come from a misfiled super-over ball.
 */
export const SUPER_OVER_SCRIPT: Script = {
  ...TIE_NO_SUPER_OVER,
  cfg: { ballsPerInnings: 12, playersPerSide: 8, minOversForResult: 2, superOver: true },
  innings: [
    ...TIE_IN_REGULATION,
    {
      batting: "away",
      bowlers: ["h7"],
      deliveries: [
        { bat: 4 },
        { extra: "wide", runs: 1 },
        { bat: 2 },
        { bat: 0 },
        { bat: 0 },
        { bat: 0 },
        { bat: 0 },
      ],
      superOver: true,
    },
    {
      batting: "home",
      bowlers: ["a7"],
      deliveries: [{ bat: 1 }, { bat: 1 }, { bat: 1 }, { bat: 1 }, { bat: 1 }, { bat: 1 }],
      superOver: true,
    },
  ],
};
