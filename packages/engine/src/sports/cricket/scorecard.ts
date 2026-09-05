// Spectator match centre — cricket scorecard fold (spectator-surface design,
// "The shared model"; standing rule R5 — "never re-implement a cricket
// rule"). `deriveCricketScorecard` is a pure fold that replays `cricket.init`
// + `cricket.apply` event by event and reads every total off the reducer's
// own state; it never re-derives a cricket rule of its own. Task 1 wires the
// fold, the fidelity band and the totals/extras; the batting/bowling lines,
// fall of wickets, partnerships, overs log and live block are left as the
// correct EMPTY value the type declares, for later tasks to fill in without
// reshaping this file.
import type { CoreEv, EventEnvelope, FoldContext } from "../../core/events.ts";
import type { LineupPair } from "../../core/types.ts";
import type { FidelityBand } from "../../sport/module.ts";
import { cricket, padSpec, type CricketCfg, type CricketEv, type CricketState } from "./cricket.ts";
import type { CricketInningsCard, CricketLive, CricketScorecard } from "./scorecard-types.ts";

export interface ScorecardInput {
  events: readonly EventEnvelope[];
  cfg: CricketCfg;
  lineups: LineupPair;
}

// The read-path context: an already-validated ledger being replayed, not a
// candidate being appended. This is exactly what `apps/web/src/server/
// engine-db/fold.ts`'s `foldMatch` passes to every event on a read — no
// `strictFromSeq` option ⇒ `strict` is `false` for the whole stream (see
// `foldMatchWithStoppage` in `core/events.ts`). There is no `strictFold` key
// on the real `FoldContext` (`{ strict: boolean; squads?: SquadState }`); the
// brief's illustrative `{ strictFold: false }` does not match the actual type.
const READ_CTX: FoldContext = { strict: false };

interface ExtrasTally {
  wides: number;
  noBalls: number;
  byes: number;
  legByes: number;
  penalties: number;
}

function emptyExtras(): ExtrasTally {
  return { wides: 0, noBalls: 0, byes: 0, legByes: 0, penalties: 0 };
}

// "3.2" — three overs and two legal balls into the next. Same derivation the
// reducer enforces for `over`/`ballInOver` (cricket.ts's `applyDelivery`), so
// display and validation can never disagree.
function fmtOvers(legalBalls: number, ballsPerOver: number): string {
  return `${Math.floor(legalBalls / ballsPerOver)}.${legalBalls % ballsPerOver}`;
}

interface CricketBallLikePayload {
  runs: { bat: number; extras?: { kind: "wide" | "noball" | "bye" | "legbye" | "penalty"; runs: number } };
}

function isCricketBallPayload(payload: unknown): payload is CricketBallLikePayload {
  return typeof payload === "object" && payload !== null && "runs" in payload && typeof payload.runs === "object";
}

/**
 * Per-innings running tallies built from ball payloads and state diffs as the
 * ledger replays. Every field `CricketInningsCard` declares is present from
 * `cards()`'s first call — the skeleton this task promises later tasks — but
 * only `total` and `extras` are populated with real logic here; the rest are
 * the type's correct empty value (Tasks 2-3 add fours/sixes, dismissals,
 * fall of wickets, partnerships and the overs log without reshaping this
 * class).
 */
class InningsAccumulator {
  private extrasByIndex: ExtrasTally[] = [];
  private hasBallEventByIndex: boolean[] = [];

  private ensure(index: number): void {
    while (this.extrasByIndex.length <= index) {
      this.extrasByIndex.push(emptyExtras());
      this.hasBallEventByIndex.push(false);
    }
  }

  /** `after.innings.length - 1` is always the innings this ball just touched
   *  — a ball can only ever create or extend the currently open innings
   *  (`cricket.ts`'s `apply()` for `cricket.ball`), so there is no separate
   *  index to track by hand. */
  onBall(after: CricketState, ev: EventEnvelope): void {
    const index = after.innings.length - 1;
    if (index < 0) return;
    this.ensure(index);
    this.hasBallEventByIndex[index] = true;
    if (!isCricketBallPayload(ev.payload)) return;
    const extras = ev.payload.runs.extras;
    if (extras === undefined) return;
    const tally = this.extrasByIndex[index];
    if (tally === undefined) return;
    switch (extras.kind) {
      case "wide":
        tally.wides += extras.runs;
        break;
      case "noball":
        tally.noBalls += extras.runs;
        break;
      case "bye":
        tally.byes += extras.runs;
        break;
      case "legbye":
        tally.legByes += extras.runs;
        break;
      case "penalty":
        tally.penalties += extras.runs;
        break;
    }
  }

  cards(state: CricketState): CricketInningsCard[] {
    const bpo = state.cfg.ballsPerOver;
    return state.innings.map((innings, index) => {
      this.ensure(index);
      const tally = this.extrasByIndex[index] ?? emptyExtras();
      const total = tally.wides + tally.noBalls + tally.byes + tally.legByes + tally.penalties;
      return {
        number: index + 1,
        side: state.entrants[innings.battingSide],
        isSuperOver: false,
        declared: innings.declared,
        closed: innings.closed,
        total: {
          runs: innings.runs,
          wickets: innings.wickets,
          legalBalls: innings.legalBalls,
          overs: fmtOvers(innings.legalBalls, bpo),
          runRate: innings.legalBalls > 0 ? (innings.runs * bpo) / innings.legalBalls : null,
        },
        extras: this.hasBallEventByIndex[index] === true ? { ...tally, total } : null,
        batting: [],
        didNotBat: [],
        bowling: [],
        fallOfWickets: [],
        partnerships: [],
        overs: [],
      };
    });
  }

  // Task 2/3 — filled once the batting/bowling lines and ball log exist.
  live(_state: CricketState): CricketLive | null {
    return null;
  }
}

export function deriveCricketScorecard({ events, cfg, lineups }: ScorecardInput): CricketScorecard {
  const bands = padSpec(cfg).fidelity;
  let band: FidelityBand = 0;
  let state = cricket.init(cfg, lineups);
  const acc = new InningsAccumulator();
  let toss: CricketScorecard["toss"] = null;

  for (const ev of events) {
    state = cricket.apply(state, ev as EventEnvelope<CricketEv | CoreEv>, READ_CTX);

    const eventBand = bands[ev.type];
    if (eventBand !== undefined && eventBand > band) band = eventBand;

    if (ev.type === "cricket.toss") {
      const payload = ev.payload as { wonBy: string; elected: "bat" | "bowl" };
      toss = { wonBy: payload.wonBy, elected: payload.elected };
    }
    if (ev.type === "cricket.ball" || ev.type === "cricket.superover.ball") {
      acc.onBall(state, ev);
    }
  }

  const summary = cricket.summary(state);
  const outcome = cricket.outcome(state);
  const winner = outcome !== null && (outcome.kind === "win" || outcome.kind === "award") ? outcome.winner : null;

  return {
    band,
    toss,
    innings: acc.cards(state),
    live: acc.live(state),
    result:
      outcome === null
        ? null
        : {
            headline: summary.headline,
            margin: (summary.detail as { margin?: unknown } | undefined)?.margin ?? null,
            winner,
          },
  };
}
