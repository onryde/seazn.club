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
import type {
  BattingLine,
  BowlingLine,
  CricketInningsCard,
  CricketLive,
  CricketScorecard,
  DismissalKind,
} from "./scorecard-types.ts";

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
  striker: string;
  nonStriker: string;
  bowler: string;
  runs: { bat: number; extras?: { kind: "wide" | "noball" | "bye" | "legbye" | "penalty"; runs: number } };
  wicket?: {
    kind: DismissalKind;
    out: string;
    fielder?: string;
    fielderAssist?: string;
    bowlerCredited: boolean;
  };
  boundary?: 4 | 6;
}

function isCricketBallPayload(payload: unknown): payload is CricketBallLikePayload {
  return typeof payload === "object" && payload !== null && "runs" in payload && typeof payload.runs === "object";
}

/**
 * Per-innings running tallies built from ball payloads and state diffs as the
 * ledger replays. Every field `CricketInningsCard` declares is present from
 * `cards()`'s first call — the skeleton this task promises later tasks — but
 * only `total`, `extras`, `batting`, `bowling` and `didNotBat` are populated
 * with real logic here; the rest are the type's correct empty value (Task 3
 * adds fall of wickets, partnerships and the overs log without reshaping
 * this class).
 *
 * Discipline (R5 — never re-derive a cricket rule): runs and balls per
 * batter, and balls/runs/wickets per bowler, come from `FineInnings` itself
 * (`batterRuns`/`batterBalls`/`bowlerBalls`/`bowlerWickets` — read in
 * `cards()`, never re-tallied here). What THIS class tracks from the ball
 * payload is only what `FineInnings` does not carry at all: who was at the
 * crease for a given ball (batting/bowling ORDER), fours/sixes, the
 * dismissal's kind/bowler/fielder/assist, wides/no-balls split by bowler,
 * and the running "runs charged to the current bowler" total the maiden
 * check needs (mirroring `finishDelivery`'s own `bowlerCharged` rule — bat
 * runs plus wide/no-ball extras; byes, leg-byes and penalties are never the
 * bowler's — because `FineInnings.bowlerRuns` has no per-over breakdown).
 */
class InningsAccumulator {
  private extrasByIndex: ExtrasTally[] = [];
  private hasBallEventByIndex: boolean[] = [];

  // Batting/bowling order — order of first appearance in a ball's payload.
  private orderByIndex: string[][] = [];
  private bowlerOrderByIndex: string[][] = [];

  // Only-on-the-payload facts state doesn't carry at all.
  private foursByIndex: Record<string, number>[] = [];
  private sixesByIndex: Record<string, number>[] = [];
  private dismissalByIndex: Record<string, BattingLine["dismissal"]>[] = [];
  private widesByIndex: Record<string, number>[] = [];
  private noBallsByIndex: Record<string, number>[] = [];
  private maidensByIndex: Record<string, number>[] = [];

  // Runs charged to the CURRENT bowler, per innings (whole-innings running
  // total, used as `BowlingLine.runs`) and per OVER (reset at every over
  // close, used only to decide a maiden) — the same `bowlerCharged` figure,
  // tracked at two granularities in one pass so they can never drift apart.
  private chargedRunsByIndex: Record<string, number>[] = [];
  private overRunsByIndex: number[] = [];
  private prevLegalBallsByIndex: number[] = [];

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
    const payload = ev.payload;
    const extras = payload.runs.extras;

    if (extras !== undefined) {
      const tally = this.extrasByIndex[index];
      if (tally !== undefined) {
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
    }

    // Batting order: append striker then non-striker the first time either
    // is named on a ball. This is who the ledger recorded as at the crease
    // BEFORE this delivery (openers on ball 1, a replacement the first ball
    // after they take strike), so it can never be thrown off by this ball's
    // OWN strike rotation the way reading `after.fine.striker` would be.
    const order = this.orderByIndex[index] ?? (this.orderByIndex[index] = []);
    for (const person of [payload.striker, payload.nonStriker]) {
      if (!order.includes(person)) order.push(person);
    }

    // Bowling order: first ball of a bowler's first over.
    const bowlerOrder = this.bowlerOrderByIndex[index] ?? (this.bowlerOrderByIndex[index] = []);
    if (!bowlerOrder.includes(payload.bowler)) bowlerOrder.push(payload.bowler);

    // Fours/sixes — only the ball payload carries this; state only keeps
    // the batter's aggregate runs.
    if (payload.boundary === 4) {
      const fours = this.foursByIndex[index] ?? (this.foursByIndex[index] = {});
      fours[payload.striker] = (fours[payload.striker] ?? 0) + 1;
    } else if (payload.boundary === 6) {
      const sixes = this.sixesByIndex[index] ?? (this.sixesByIndex[index] = {});
      sixes[payload.striker] = (sixes[payload.striker] ?? 0) + 1;
    }

    // Dismissal detail — state's `fine.dismissed` is only a list of names;
    // the kind/bowler-credit/fielder/assist live only on the wicket ball's
    // own payload.
    if (payload.wicket !== undefined) {
      const wicket = payload.wicket;
      const dismissals = this.dismissalByIndex[index] ?? (this.dismissalByIndex[index] = {});
      dismissals[wicket.out] = {
        kind: wicket.kind,
        bowler: wicket.bowlerCredited ? payload.bowler : null,
        fielder: wicket.fielder ?? null,
        fielderAssist: wicket.fielderAssist ?? null,
      };
    }

    // Wides/no-balls split BY BOWLER — `FineInnings.extras` only has the
    // innings-wide total (Task 1's `ExtrasTally` above), with no per-bowler
    // breakdown.
    if (extras?.kind === "wide") {
      const wides = this.widesByIndex[index] ?? (this.widesByIndex[index] = {});
      wides[payload.bowler] = (wides[payload.bowler] ?? 0) + extras.runs;
    } else if (extras?.kind === "noball") {
      const noBalls = this.noBallsByIndex[index] ?? (this.noBallsByIndex[index] = {});
      noBalls[payload.bowler] = (noBalls[payload.bowler] ?? 0) + extras.runs;
    }

    // Runs charged to the bowler — the SAME rule `finishDelivery` uses to
    // build `fine.bowlerRuns` (cricket.ts): bat runs, plus a wide or
    // no-ball's extra runs; byes, leg-byes and penalties are the team's,
    // never the bowler's. Tracked here (not read off `fine.bowlerRuns` at
    // the end) because the maiden check right below needs this same figure
    // scoped to a single OVER, and computing both in one pass is what keeps
    // them from drifting apart.
    const charged = payload.runs.bat + (extras?.kind === "wide" || extras?.kind === "noball" ? extras.runs : 0);
    const chargedRuns = this.chargedRunsByIndex[index] ?? (this.chargedRunsByIndex[index] = {});
    chargedRuns[payload.bowler] = (chargedRuns[payload.bowler] ?? 0) + charged;
    this.overRunsByIndex[index] = (this.overRunsByIndex[index] ?? 0) + charged;

    // Maidens: an over just closed exactly when `legalBalls` crosses a NEW
    // multiple of `ballsPerOver` — the identical boundary `finishDelivery`
    // uses to swap ends and hand the ball to a new bowler. `prevOverBowler`
    // (state, set by that same boundary) names who just bowled it, so the
    // credit is read off state rather than assumed from `payload.bowler`.
    const innings = after.innings[index];
    const legalBallsNow = innings?.legalBalls ?? 0;
    const prevLegalBalls = this.prevLegalBallsByIndex[index] ?? 0;
    if (legalBallsNow !== prevLegalBalls && legalBallsNow % after.cfg.ballsPerOver === 0) {
      const overBowler = innings?.fine?.prevOverBowler ?? null;
      if (overBowler !== null && this.overRunsByIndex[index] === 0) {
        const maidens = this.maidensByIndex[index] ?? (this.maidensByIndex[index] = {});
        maidens[overBowler] = (maidens[overBowler] ?? 0) + 1;
      }
      this.overRunsByIndex[index] = 0;
    }
    this.prevLegalBallsByIndex[index] = legalBallsNow;
  }

  cards(state: CricketState): CricketInningsCard[] {
    const bpo = state.cfg.ballsPerOver;
    return state.innings.map((innings, index) => {
      this.ensure(index);
      const tally = this.extrasByIndex[index] ?? emptyExtras();
      const total = tally.wides + tally.noBalls + tally.byes + tally.legByes + tally.penalties;
      const fine = innings.fine;

      const order = this.orderByIndex[index] ?? [];
      const bowlerOrder = this.bowlerOrderByIndex[index] ?? [];
      const fours = this.foursByIndex[index] ?? {};
      const sixes = this.sixesByIndex[index] ?? {};
      const dismissals = this.dismissalByIndex[index] ?? {};
      const wides = this.widesByIndex[index] ?? {};
      const noBalls = this.noBallsByIndex[index] ?? {};
      const maidens = this.maidensByIndex[index] ?? {};
      const chargedRuns = this.chargedRunsByIndex[index] ?? {};

      const batting: BattingLine[] =
        fine === null
          ? []
          : order.map((person, i) => {
              const runs = fine.batterRuns[person] ?? 0;
              const balls = fine.batterBalls[person] ?? 0;
              return {
                order: i + 1,
                person,
                runs,
                balls,
                fours: fours[person] ?? 0,
                sixes: sixes[person] ?? 0,
                strikeRate: balls > 0 ? Math.round(((runs * 100) / balls) * 10) / 10 : null,
                dismissal: dismissals[person] ?? { kind: "not_out" },
              };
            });

      const bowling: BowlingLine[] =
        fine === null
          ? []
          : bowlerOrder.map((person) => {
              const legalBalls = fine.bowlerBalls[person] ?? 0;
              const runs = chargedRuns[person] ?? 0;
              return {
                person,
                legalBalls,
                overs: fmtOvers(legalBalls, bpo),
                maidens: maidens[person] ?? 0,
                runs,
                wickets: fine.bowlerWickets[person] ?? 0,
                economy: legalBalls > 0 ? Math.round(((runs * bpo) / legalBalls) * 10) / 10 : null,
                wides: wides[person] ?? 0,
                noBalls: noBalls[person] ?? 0,
              };
            });

      const battingOrderFull = state.orders[innings.battingSide];
      const atCrease = new Set(order);
      const didNotBat = battingOrderFull.filter((person) => !atCrease.has(person));

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
        batting,
        didNotBat,
        bowling,
        fallOfWickets: [],
        partnerships: [],
        overs: [],
      };
    });
  }

  // Task 3 — filled once the ball log exists.
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
