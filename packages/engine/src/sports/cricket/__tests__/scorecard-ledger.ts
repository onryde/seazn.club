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
  | { bat: 0 | 1 | 2 | 3 | 4 | 6 }
  | { extra: "wide" | "noball" | "bye" | "legbye" | "penalty"; runs: number; bat?: number }
  | {
      out: "bowled" | "caught" | "lbw" | "runout" | "stumped" | "hitwicket" | "obstructed" | "timedout" | "hitballtwice";
      fielder?: string;
      assist?: string;
      bat?: number;
    }
  | { retire: true };

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

function buildBallPayload(
  delivery: Exclude<Delivery, { retire: true }>,
  base: { over: number; ballInOver: number; striker: string; nonStriker: string; bowler: string },
): CricketBallEv {
  if ("extra" in delivery) {
    return {
      ...base,
      runs: { bat: delivery.bat ?? 0, extras: { kind: delivery.extra, runs: delivery.runs } },
    };
  }
  if ("out" in delivery) {
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
    };
  }
  // Plain bat delivery.
  const boundary = delivery.bat === 4 || delivery.bat === 6 ? delivery.bat : undefined;
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

  function record(type: string, payload: unknown): void {
    const env = makeEnvelope(seq, { type, payload });
    seq += 1;
    events.push(env);
    state = cricket.apply(state, env as EventEnvelope<CricketEv | CoreEv>, WRITE_CTX);
  }

  // Toss BEFORE start — see the file header.
  record("cricket.toss", { wonBy: script.tossWonBy, elected: script.elected });
  record("core.start", {});

  for (const inningsSpec of script.innings) {
    const at = state.innings.length;
    const battingOrder = inningsSpec.batting === "home" ? script.home : script.away;
    const bpo = cfg.ballsPerOver;

    for (const delivery of inningsSpec.deliveries) {
      // `legalBalls` lives on `InningsState`; the crease (striker/non-striker,
      // current bowler) lives one level down on `InningsState.fine`.
      const innings = state.innings[at];
      const fine = innings?.fine;
      if ("retire" in delivery) {
        const striker = fine?.striker ?? battingOrder[0];
        if (striker === undefined) throw new Error("scriptLedger: no striker to retire");
        record("cricket.retire", { person: striker, reason: "hurt" });
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
      const bowler = inningsSpec.bowlers[over % inningsSpec.bowlers.length];
      if (bowler === undefined) throw new Error("scriptLedger: no bowlers given");
      const payload = buildBallPayload(delivery, { over, ballInOver, striker, nonStriker, bowler });
      record("cricket.ball", payload);
    }

    // Close explicitly unless the reducer's own auto-close rules (all-out,
    // balls exhausted, target passed — `autoClose` in cricket.ts) already
    // closed it. Re-closing an already-closed innings throws ("no innings in
    // progress"), so this is checked from state, never assumed from the script.
    const stillOpen = state.innings[at] !== undefined && !state.innings[at].closed;
    if (stillOpen) {
      record("cricket.innings.close", inningsSpec.close === undefined ? {} : { reason: inningsSpec.close });
    }
  }

  return { events, state, cfg, lineups };
}
