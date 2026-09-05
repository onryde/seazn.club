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
  | { matchClose: true };

/** The `Delivery` members that actually produce a `cricket.ball` — everything
 *  the three match-event variants above are not. */
type BallDelivery = Exclude<Delivery, { retire: true } | { revise: object } | { matchClose: true }>;

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
