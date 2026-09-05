// Spectator match centre — cricket scorecard fold (spectator-surface design,
// "The shared model"; standing rule R5 — "never re-implement a cricket
// rule"). `deriveCricketScorecard` is a pure fold that replays `cricket.init`
// + `cricket.apply` event by event and reads every total off the reducer's
// own state; it never re-derives a cricket rule of its own. Task 1 wired the
// fold, the fidelity band and the totals/extras; Task 2 the batting and
// bowling lines; Task 3 the fall of wickets, partnerships, over log and live
// block (including the chase maths, whose target comes from the reducer's own
// exported `chaseTarget` and never from a second copy of the rule); Task 4
// the two COARSER bands (`cricket.player.line` at band 2, and a ledger of
// `cricket.innings.summary` alone at band 0) and the super over as cards.
import type { CoreEv, EventEnvelope, FoldContext } from "../../core/events.ts";
import type { LineupPair } from "../../core/types.ts";
import type { FidelityBand } from "../../sport/module.ts";
import {
  activeInnings,
  chaseTarget,
  cricket,
  padSpec,
  type CricketCfg,
  type CricketEv,
  type CricketState,
  type InningsState,
} from "./cricket.ts";
import type {
  BallGlyph,
  BattingLine,
  BowlingLine,
  CricketInningsCard,
  CricketLive,
  CricketScorecard,
  DismissalKind,
  FallOfWicket,
  OverLog,
  Partnership,
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
 * One delivery as the ball-by-ball strip shows it. A wicket ball is a wicket
 * glyph whatever else happened on it (that is what a scorebook prints, and
 * `BallGlyph` has no combined variant); an extra carries the WHOLE delivery's
 * runs — a no-ball hit for two reads "3", which is what came off the ball —
 * while the over's own `runs` total is diffed off state, so the two can never
 * disagree about the innings.
 */
function glyphOf(payload: CricketBallLikePayload): BallGlyph {
  if (payload.wicket !== undefined) return { kind: "wicket", dismissal: payload.wicket.kind };
  const extras = payload.runs.extras;
  if (extras === undefined) return { kind: "runs", runs: payload.runs.bat };
  const runs = extras.runs + payload.runs.bat;
  switch (extras.kind) {
    case "wide":
      return { kind: "wide", runs };
    case "noball":
      return { kind: "noball", runs };
    default:
      return { kind: extras.kind, runs };
  }
}

/** A partnership still at the crease: the pair, and the innings' running
 *  totals at the moment it opened. Runs and balls are read out as DIFFS
 *  against state (`innings.runs - runsAt`), never tallied here — which is
 *  what makes the partnerships of an innings sum to its total exactly,
 *  extras and all, with no second copy of "what counts as a team run". */
interface OpenPartnership {
  batters: [string, string];
  runsAt: number;
  ballsAt: number;
}

/**
 * Per-innings running tallies built from ball payloads and state diffs as the
 * ledger replays. Every field `CricketInningsCard` and `CricketLive` declare
 * is populated from here.
 *
 * Task 4 closed the gap this doc used to record: `cards()` now renders the
 * super over's own innings too, from `state.superOver.innings`, at the SAME
 * match-wide slots `onBall` files their balls into — so a super over's over
 * log, extras and lines are read from the container they were bowled in.
 *
 * Discipline (R5 — never re-derive a cricket rule): runs and balls per
 * batter, and balls/runs/WICKETS per bowler, come from `FineInnings` itself
 * (`batterRuns`/`batterBalls`/`bowlerBalls`/`bowlerWickets` — read in
 * `cards()`, never re-tallied here). `BowlingLine.runs` ALSO reads
 * `fine.bowlerRuns[person]` directly (fix round 1, finding 1) — this class
 * used to keep its own `chargedRuns` tally keyed by `payload.bowler` and
 * report THAT, which is a second authority: on the non-strict read path
 * `finishDelivery` credits whichever bowler STATE says is current, which
 * can disagree with a stale/replayed `payload.bowler`, so a row's `runs`
 * could disagree with its own `balls`/`wickets` (both state-sourced). What
 * THIS class tracks from the ball payload is only what `FineInnings` does
 * not carry at all: who was at the crease for a given ball (batting/bowling
 * ORDER), fours/sixes, the dismissal's kind/bowler/fielder/assist,
 * wides/no-balls split by bowler, and a running "runs charged to the
 * CURRENT over" total — used ONLY to decide maidens, since `FineInnings`
 * has no per-over breakdown at all — mirroring `finishDelivery`'s own
 * `bowlerCharged` rule (bat runs plus wide/no-ball extras; byes, leg-byes
 * and penalties are never the bowler's).
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

  // Runs charged to the bowler bowling the CURRENT over — reset at every
  // over close, read only to decide a maiden (`BowlingLine.runs` itself
  // reads `fine.bowlerRuns` directly; see the class doc above, fix round 1
  // finding 1).
  private overRunsByIndex: number[] = [];

  // The innings' own totals BEFORE the ball being folded — the other half of
  // every diff this class takes (`innings.runs - prevRuns` is the runs off
  // this delivery, extras and all, without a second copy of the scoring
  // rules). Kept per innings index, so a new innings starts from 0.
  private prevLegalBallsByIndex: number[] = [];
  private prevRunsByIndex: number[] = [];
  private prevWicketsByIndex: number[] = [];

  // Task 4 — band 2. A `cricket.player.line` is the ONLY record of who did
  // what in an innings recorded as totals: there is no delivery to read and
  // `InningsState.fine` is null, so `FineInnings` cannot be asked. Read off
  // the event's own payload as the fold replays it, exactly the way `onBall`
  // reads a delivery's. (`state.playerLines` holds the same records, but
  // reading the payload keeps every accumulator input one shape.)
  private battingLinesByIndex: Array<Array<{ person: string; runs: number; balls: number; out: boolean }>> = [];
  private bowlingLinesByIndex: Array<
    Array<{ person: string; legalBalls: number; runs: number; wickets: number }>
  > = [];

  // Task 3 — fall of wickets, partnerships and the over log.
  private fowByIndex: FallOfWicket[][] = [];
  private partnershipsByIndex: Partnership[][] = [];
  private openPartnershipByIndex: Array<OpenPartnership | null> = [];
  private oversByIndex: OverLog[][] = [];

  private ensure(index: number): void {
    while (this.extrasByIndex.length <= index) {
      this.extrasByIndex.push(emptyExtras());
      this.hasBallEventByIndex.push(false);
    }
  }

  /**
   * A ball can only ever create or extend the currently open innings of the
   * container the reducer routes it to, so the innings it touched is always
   * the LAST one in that container. Which container that is comes from the
   * EVENT TYPE, mirroring `cricket.ts`'s own `apply()` dispatch: a
   * `cricket.ball` goes through `applyDelivery` into `state.innings`, a
   * `cricket.superover.ball` through `applySuperOverBall` into
   * `state.superOver.innings`.
   *
   * The index this class keys everything by is the MATCH-WIDE innings number
   * — `state.innings.length` offsets the super over, exactly as
   * `activeInnings` does, because THE SUPER OVER CONTINUES THE INNINGS COUNT.
   * Without the offset a super over's balls land in the last main innings'
   * slot and its over log, fall of wickets and partnerships are appended to
   * an innings that was already over. (`cards()` still maps `state.innings`
   * alone, so those higher slots are read only by `live()` — the scorecard
   * does not yet render super-over innings as cards; see the file header.)
   *
   * Reading `activeInnings(after)` instead would be wrong here for one case:
   * a tie creates an EMPTY `superOver` container, which is immediately the
   * active list, so the very ball that tied the match would be filed against
   * a container it never entered.
   */
  onBall(after: CricketState, ev: EventEnvelope): void {
    const inSuperOver = ev.type === "cricket.superover.ball";
    const list: readonly InningsState[] = inSuperOver ? (after.superOver?.innings ?? []) : after.innings;
    const local = list.length - 1;
    const innings = list[local];
    if (innings === undefined) return;
    const index = (inSuperOver ? after.innings.length : 0) + local;
    this.ensure(index);
    this.hasBallEventByIndex[index] = true;
    if (!isCricketBallPayload(ev.payload)) return;
    const payload = ev.payload;
    const extras = payload.runs.extras;
    const bpo = after.cfg.ballsPerOver;

    // The innings as it stood BEFORE this delivery. Every "what happened on
    // this ball" figure below is a diff against these three.
    const prevRuns = this.prevRunsByIndex[index] ?? 0;
    const prevWickets = this.prevWicketsByIndex[index] ?? 0;
    const prevLegalBalls = this.prevLegalBallsByIndex[index] ?? 0;

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

    // Runs charged to the bowler THIS OVER — the SAME rule `finishDelivery`
    // uses to build `fine.bowlerRuns` (cricket.ts): bat runs, plus a wide or
    // no-ball's extra runs; byes, leg-byes and penalties are the team's,
    // never the bowler's. Scoped to one over and used ONLY by the maiden
    // check right below — `BowlingLine.runs` itself reads `fine.bowlerRuns`
    // in `cards()` (fix round 1, finding 1: a second, hand-rolled
    // whole-innings tally here could disagree with state on WHO gets a
    // given ball's runs; this one only ever answers "was this over a
    // maiden", never "how many runs does this row show").
    const charged = payload.runs.bat + (extras?.kind === "wide" || extras?.kind === "noball" ? extras.runs : 0);
    this.overRunsByIndex[index] = (this.overRunsByIndex[index] ?? 0) + charged;

    // Over log. Which over a delivery belongs to is decided by the legal
    // balls BEFORE it, so a wide or a no-ball joins the over in progress
    // rather than opening a new one, and an over that ends on its sixth
    // legal ball closes with every extra bowled inside it. `runs` is the
    // team's own runs off the ball (state diff, so byes and penalties are in
    // it and the over totals sum to the innings total); `scoreAfter` is the
    // reducer's score once the ball is folded.
    const overs = this.oversByIndex[index] ?? (this.oversByIndex[index] = []);
    const overIndex = Math.floor(prevLegalBalls / bpo);
    const scoreAfter = { runs: innings.runs, wickets: innings.wickets };
    let over = overs[overIndex];
    if (over === undefined) {
      over = { number: overIndex + 1, bowler: payload.bowler, balls: [], runs: 0, wickets: 0, scoreAfter };
      overs[overIndex] = over;
    }
    over.balls.push(glyphOf(payload));
    over.runs += innings.runs - prevRuns;
    over.wickets += innings.wickets - prevWickets;
    over.scoreAfter = scoreAfter;

    // Partnerships. The first one of an innings opens on its first ball with
    // the pair the LEDGER recorded at the crease for that ball — the same
    // field the batting order is built from, and the reducer's own answer to
    // "who was in before this delivery".
    if ((this.openPartnershipByIndex[index] ?? null) === null) {
      this.openPartnershipByIndex[index] = {
        batters: [payload.striker, payload.nonStriker],
        runsAt: prevRuns,
        ballsAt: prevLegalBalls,
      };
    }

    if (payload.wicket !== undefined) {
      // Fall of wicket — every figure is the reducer's own state AFTER the
      // ball: its wicket NUMBER, the team score at the fall, and the over in
      // the same notation `total.overs` uses. The batter is the one the
      // ledger says was dismissed.
      const fow = this.fowByIndex[index] ?? (this.fowByIndex[index] = []);
      fow.push({
        wicket: innings.wickets,
        runs: innings.runs,
        over: fmtOvers(innings.legalBalls, bpo),
        batter: payload.wicket.out,
      });

      // The stand ends here and keeps this wicket's number; runs and balls
      // are diffs, so the runs off the wicket ball itself belong to the
      // partnership it broke.
      const ending = this.openPartnershipByIndex[index];
      if (ending != null) {
        const partnerships = this.partnershipsByIndex[index] ?? (this.partnershipsByIndex[index] = []);
        partnerships.push({
          batters: ending.batters,
          runs: innings.runs - ending.runsAt,
          balls: innings.legalBalls - ending.ballsAt,
          wicket: innings.wickets,
        });
      }

      // The next stand opens with the pair `cricket.apply` itself leaves at
      // the crease — never a guess at who walks in, and never the ball's own
      // striker/non-striker (one of them just got out). Nothing opens if that
      // wicket ended the innings (all out, or a close the reducer ran on this
      // ball), or if an end is still awaiting a replacement.
      const fine = innings.fine;
      const striker = fine?.striker ?? null;
      const nonStriker = fine?.nonStriker ?? null;
      this.openPartnershipByIndex[index] =
        !innings.closed && striker !== null && nonStriker !== null
          ? { batters: [striker, nonStriker], runsAt: innings.runs, ballsAt: innings.legalBalls }
          : null;
    }

    // Maidens: an over just closed exactly when `legalBalls` crosses a NEW
    // multiple of `ballsPerOver` — the identical boundary `finishDelivery`
    // uses to swap ends and hand the ball to a new bowler. `prevOverBowler`
    // (state, set by that same boundary) names who just bowled it, so the
    // credit is read off state rather than assumed from `payload.bowler`.
    const legalBallsNow = innings.legalBalls;
    if (legalBallsNow !== prevLegalBalls && legalBallsNow % bpo === 0) {
      const overBowler = innings.fine?.prevOverBowler ?? null;
      if (overBowler !== null && this.overRunsByIndex[index] === 0) {
        const maidens = this.maidensByIndex[index] ?? (this.maidensByIndex[index] = {});
        maidens[overBowler] = (maidens[overBowler] ?? 0) + 1;
      }
      this.overRunsByIndex[index] = 0;
    }
    this.prevLegalBallsByIndex[index] = legalBallsNow;
    this.prevRunsByIndex[index] = innings.runs;
    this.prevWicketsByIndex[index] = innings.wickets;
  }

  /**
   * `cricket.retire` (fix round 1, finding 4) — the ONE dismissal-adjacent
   * event that carries no ball at all, so `onBall` never sees it.
   * `applyRetire` (cricket.ts) adds the person to `fine.dismissed` only
   * when `reason === "out"` (Law 25.4.3: retired out, credited to no
   * bowler); any other reason leaves them not out, in
   * `fine.retiredNotOut` instead — which is already `BattingLine.dismissal`'s
   * default (`{ kind: "not_out" }`), so nothing needs recording for that
   * case. The reason is read off THIS event's own payload — pinned, never
   * inferred from a state diff — because `fine.dismissed` alone can't say
   * which of two possible causes added a name to it.
   *
   * Retirement also moves the open partnership's pair: who is at the crease
   * changes exactly the way a wicket changes it, but `onBall` has no ball to
   * see it happen on.
   *
   * A retired-OUT is the ONE wicket in this sport that falls with no ball
   * attached (Task 3 fix round 1, finding 1). `applyRetire` increments
   * `innings.wickets` and runs `autoClose` just as `applyDelivery` does, so
   * without this branch: no fall-of-wickets row exists for it, every LATER
   * row's number skips past it, `fallOfWickets.length === total.wickets`
   * stops holding, an innings all out on a retired-out never closes its last
   * stand (it stays `"unbroken"` when a wicket ended it), and — worst,
   * because it is silent — the previous-wickets marker goes stale, so the
   * NEXT ball's over log absorbs this wicket as if it had fallen there. So a
   * retired-out closes the stand and files the row exactly as `onBall` does,
   * off the same state fields, then re-opens with the pair the reducer left
   * at the crease.
   *
   * A retired-NOT-OUT costs no wicket (Law 25: hurt/ill/other; the batter may
   * resume) and continues the SAME stand with a substitute at one end — so
   * only the pair moves, `runsAt`/`ballsAt` stay put. Left untouched when the
   * retirement leaves no one to replace the retiree (state has already nulled
   * that end); an all-out autoClose settles the innings anyway.
   *
   * `state.innings` is the only container to look in: `applyRetire` goes
   * through `requireOpenInnings`, which reads `state.innings`, so a
   * retirement can never land in a super over.
   */
  onRetire(after: CricketState, ev: EventEnvelope): void {
    const index = after.innings.length - 1;
    const innings = after.innings[index];
    if (innings === undefined) return;
    const payload = ev.payload as { person: string; reason: "hurt" | "out" | "other" };
    const fine = innings.fine;
    const striker = fine?.striker ?? null;
    const nonStriker = fine?.nonStriker ?? null;

    if (payload.reason === "out") {
      const dismissals = this.dismissalByIndex[index] ?? (this.dismissalByIndex[index] = {});
      dismissals[payload.person] = { kind: "retired", bowler: null, fielder: null, fielderAssist: null };

      const fow = this.fowByIndex[index] ?? (this.fowByIndex[index] = []);
      fow.push({
        wicket: innings.wickets,
        runs: innings.runs,
        over: fmtOvers(innings.legalBalls, after.cfg.ballsPerOver),
        batter: payload.person,
      });

      const ending = this.openPartnershipByIndex[index] ?? null;
      if (ending !== null) {
        const partnerships = this.partnershipsByIndex[index] ?? (this.partnershipsByIndex[index] = []);
        partnerships.push({
          batters: ending.batters,
          runs: innings.runs - ending.runsAt,
          balls: innings.legalBalls - ending.ballsAt,
          wicket: innings.wickets,
        });
      }
      this.openPartnershipByIndex[index] =
        !innings.closed && striker !== null && nonStriker !== null
          ? { batters: [striker, nonStriker], runsAt: innings.runs, ballsAt: innings.legalBalls }
          : null;

      // The marker `onBall` diffs the next delivery against. Without this the
      // next ball's over log reports this wicket as its own.
      this.prevWicketsByIndex[index] = innings.wickets;
      return;
    }

    const open = this.openPartnershipByIndex[index] ?? null;
    if (open !== null && striker !== null && nonStriker !== null) {
      this.openPartnershipByIndex[index] = { ...open, batters: [striker, nonStriker] };
    }
  }

  /**
   * `cricket.player.line` (band 2) — the middle fidelity, between an innings
   * recorded as bare totals and one recorded ball by ball. A line says what
   * one person did across a whole innings: runs and balls faced, or balls
   * bowled, runs conceded and wickets taken. Nothing else. There is no
   * delivery behind it, so the fold has no boundary flag, no dismissal
   * detail, no over boundary and no extras split to read — which is why
   * every one of those fields comes back `null` rather than `0` on a line's
   * card (see `lineBatting`/`lineBowling`).
   *
   * `payload.innings` is 1-based and addresses `state.innings` — that is
   * literally what `applyPlayerLine` indexes (`state.innings[payload.innings
   * - 1]`), and it also REFUSES an innings that is not closed. So a line can
   * never belong to a super over, and `payload.innings - 1` is the same
   * match-wide slot `cards()` keys a main innings by.
   */
  onLine(ev: EventEnvelope): void {
    const payload = ev.payload as {
      innings: number;
      person: string;
      batting?: { runs: number; balls: number; out?: boolean };
      bowling?: { legalBalls: number; runs: number; wickets: number };
    };
    const index = payload.innings - 1;
    if (index < 0) return;
    const batting = payload.batting;
    if (batting !== undefined) {
      const lines = this.battingLinesByIndex[index] ?? (this.battingLinesByIndex[index] = []);
      lines.push({ person: payload.person, runs: batting.runs, balls: batting.balls, out: batting.out === true });
    }
    const bowling = payload.bowling;
    if (bowling !== undefined) {
      const lines = this.bowlingLinesByIndex[index] ?? (this.bowlingLinesByIndex[index] = []);
      lines.push({
        person: payload.person,
        legalBalls: bowling.legalBalls,
        runs: bowling.runs,
        wickets: bowling.wickets,
      });
    }
  }

  /** Batting lines at band 2. `order` is the order the lines were FILED —
   *  the only ordering a line ledger carries; a batting position it never
   *  recorded would be an invention. `fours`/`sixes` are `null` because no
   *  delivery exists to have carried a boundary flag, and the dismissal is
   *  `out_unknown` — the shape `scorecard-types.ts` reserves for "the line
   *  said out, nothing more" — never a kind, bowler or fielder this ledger
   *  cannot name. */
  private lineBatting(index: number): BattingLine[] {
    return (this.battingLinesByIndex[index] ?? []).map((line, i) => ({
      order: i + 1,
      person: line.person,
      runs: line.runs,
      balls: line.balls,
      fours: null,
      sixes: null,
      strikeRate: line.balls > 0 ? Math.round(((line.runs * 100) / line.balls) * 10) / 10 : null,
      dismissal: line.out ? { kind: "out_unknown" } : { kind: "not_out" },
    }));
  }

  /** Bowling lines at band 2. `maidens`/`wides`/`noBalls` are `null` for the
   *  same reason: a maiden is a property of an OVER and wides/no-balls of a
   *  DELIVERY, and a line ledger holds neither. `overs` and `economy` are
   *  derived from the line's own legal balls with the same notation and the
   *  same rounding a ball-fidelity card uses, so the two bands print alike. */
  private lineBowling(index: number, bpo: number): BowlingLine[] {
    return (this.bowlingLinesByIndex[index] ?? []).map((line) => ({
      person: line.person,
      legalBalls: line.legalBalls,
      overs: fmtOvers(line.legalBalls, bpo),
      maidens: null,
      runs: line.runs,
      wickets: line.wickets,
      economy: line.legalBalls > 0 ? Math.round(((line.runs * bpo) / line.legalBalls) * 10) / 10 : null,
      wides: null,
      noBalls: null,
    }));
  }

  /** The stands of an innings, with the one still at the crease (if any)
   *  appended as `"unbroken"`. That one rule covers all three cases the
   *  scorebook has: an innings in progress, an innings closed on overs, a
   *  target or a declaration — both unbroken — and an innings that ended on
   *  a wicket, where the last stand was already pushed with that wicket's
   *  number and nothing re-opened behind it. */
  private partnershipsFor(index: number, innings: InningsState): Partnership[] {
    const closed = this.partnershipsByIndex[index] ?? [];
    const open = this.openPartnershipByIndex[index] ?? null;
    if (open === null) return [...closed];
    return [
      ...closed,
      {
        batters: open.batters,
        runs: innings.runs - open.runsAt,
        balls: innings.legalBalls - open.ballsAt,
        wicket: "unbroken",
      },
    ];
  }

  /**
   * Every innings of the match, in the order it was played: the main innings
   * first, then the super over's (Task 4).
   *
   * The super over's cards are addressed at `state.innings.length + i` — the
   * SAME match-wide slot `onBall` files their balls into, and the same
   * offset `activeInnings` uses, because THE SUPER OVER CONTINUES THE
   * INNINGS COUNT. Reading them at their own container-local index instead
   * would hand a super-over card the extras, over log and fall of wickets of
   * a main innings that had already finished.
   */
  cards(state: CricketState): CricketInningsCard[] {
    const main = state.innings.map((innings, index) => this.card(state, innings, index, false));
    const superOver = (state.superOver?.innings ?? []).map((innings, i) =>
      this.card(state, innings, state.innings.length + i, true),
    );
    return [...main, ...superOver];
  }

  private card(
    state: CricketState,
    innings: InningsState,
    index: number,
    isSuperOver: boolean,
  ): CricketInningsCard {
    const bpo = state.cfg.ballsPerOver;
    this.ensure(index);
    const tally = this.extrasByIndex[index] ?? emptyExtras();
    const total = tally.wides + tally.noBalls + tally.byes + tally.legByes + tally.penalties;
    const fine = innings.fine;

    // Fix round 1, finding 5: a batter seated by the LAST ball's wicket
    // (the reducer resolves a replacement synchronously with that ball —
    // `applyDelivery`'s `resolveIncoming`), with no FOLLOWING ball to name
    // them, never appears in any payload's striker/nonStriker field, so
    // `onBall` alone can never see them. State — `fine.striker`/
    // `fine.nonStriker` — is the authority for who is AT the crease right
    // now; append either name if `onBall` hasn't already recorded it,
    // rather than mutate the stored array (this copy is rebuilt fresh
    // every `cards()` call).
    const order = [...(this.orderByIndex[index] ?? [])];
    for (const person of [fine?.striker, fine?.nonStriker]) {
      if (person != null && !order.includes(person)) order.push(person);
    }
    const bowlerOrder = this.bowlerOrderByIndex[index] ?? [];
    const fours = this.foursByIndex[index] ?? {};
    const sixes = this.sixesByIndex[index] ?? {};
    const dismissals = this.dismissalByIndex[index] ?? {};
    const wides = this.widesByIndex[index] ?? {};
    const noBalls = this.noBallsByIndex[index] ?? {};
    const maidens = this.maidensByIndex[index] ?? {};

    // `fine === null` is the innings recorded WITHOUT deliveries. At band 0
    // there is nothing further to say and both lists stay empty; at band 2
    // the player lines are the whole record (Task 4). A fine innings never
    // reads the lines even when it carries some: `applyPlayerLine` makes a
    // line over a fine innings agree with `FineInnings` EXACTLY, so the
    // ball-derived rows say everything the lines do and more.
    const batting: BattingLine[] =
      fine === null
        ? this.lineBatting(index)
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
        ? this.lineBowling(index, bpo)
        : bowlerOrder.map((person) => {
            const legalBalls = fine.bowlerBalls[person] ?? 0;
            // Fix round 1, finding 1: read straight off `fine.bowlerRuns`
            // — see the class doc above for why a second, hand-rolled
            // tally here was a bug, not just a duplication.
            const runs = fine.bowlerRuns[person] ?? 0;
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

    // Fix round 1, finding 3: `fine === null` (summary/coarse fidelity)
    // means no ball ever named a crease occupant — `order` is empty, so
    // an unguarded filter here would report the WHOLE lineup as
    // did-not-bat, which is a wrong, overconfident claim at a fidelity
    // that cannot say who batted at all. `[]` matches `batting`/`bowling`.
    // At band 2 the same holds for a different reason: a player line exists
    // for whoever someone chose to file one for, so a MISSING line is not
    // evidence that a person did not bat.
    //
    // A SUPER OVER is the third case (Task 4). Each side nominates three
    // batters and the ledger records no nomination anywhere, so the team's
    // batting order is not the list of people who were available — reporting
    // the other eight as "did not bat" would be the same overconfident claim.
    const battingOrderFull = state.orders[innings.battingSide];
    const atCrease = new Set(order);
    const didNotBat =
      fine === null || isSuperOver ? [] : battingOrderFull.filter((person) => !atCrease.has(person));

    return {
      number: index + 1,
      side: state.entrants[innings.battingSide],
      isSuperOver,
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
      fallOfWickets: [...(this.fowByIndex[index] ?? [])],
      partnerships: this.partnershipsFor(index, innings),
      overs: [...(this.oversByIndex[index] ?? [])],
    };
  }

  /**
   * The live block — everything a scoreboard shows while a ball is still to
   * be bowled, and `null` the moment none is.
   *
   * WHICH innings is in progress is `activeInnings`'s question, not
   * `state.innings`': a super over continues the innings count in its own
   * container, and its own doc records the live bug that reading
   * `state.innings` there caused (the pad told a mid-super-over fixture the
   * match was over). Between a tie and the first super-over ball the
   * container is empty and no innings is open, which is `null` by the same
   * rule.
   *
   * A closed innings is not the only way a match ends, though (fix round 1,
   * finding 2): `cricket.match.close` — the two-innings time-expiry draw —
   * sets `phase: "done"` and an `outcome`, and leaves the innings it
   * interrupted OPEN. So a decided match is live-less whether or not its
   * innings closed, and `state.outcome !== null` is that gate, unqualified.
   *
   * IT IS NOT QUALIFIED BY `!inSuperOver`, and that is a correction (Task 4,
   * on Task 3's re-review). The half that used to be there rested on "a tie
   * sets `outcome` BEFORE the super over is bowled", which is false:
   * `decideTie` (cricket.ts) returns `{ phase: "super_over", superOver: … }`
   * with `outcome` UNTOUCHED whenever `cfg.superOver` is on — only the
   * non-super-over branch settles `{ kind: "tie" }`. So a super over in
   * progress is never blanked by the unqualified gate; the fold's own
   * "super over in progress" test proves that, and it stayed green when the
   * half came out. What the half DID do was let `live` survive a super over
   * that had been ABANDONED: `applyAbandon` in phase `super_over` sets
   * `{ phase: "done", outcome: { kind: "tie" } }` and leaves the innings it
   * interrupted OPEN, exactly as `cricket.match.close` does — so the
   * `closed` check cannot see it either, and the scoreboard kept a live
   * block for a match that was over.
   *
   * Every number here is the reducer's: the target from `chaseTarget` (the
   * one authority — DLS revisions and two-innings aggregates included), the
   * balls remaining from the innings' OWN `ballsLimit`, the rates from
   * `cfg.ballsPerOver` rather than a hard six.
   */
  live(state: CricketState): CricketLive | null {
    const { list, offset, inSuperOver } = activeInnings<InningsState>(state);
    const local = list.length - 1;
    const innings = list[local];
    if (innings === undefined || innings.closed) return null;
    if (state.outcome !== null) return null;
    const index = offset + local;
    const bpo = state.cfg.ballsPerOver;
    const fine = innings.fine;

    const overs = this.oversByIndex[index] ?? [];
    const open = this.openPartnershipByIndex[index] ?? null;
    const falls = this.fowByIndex[index] ?? [];
    const lastFall = falls[falls.length - 1];

    // `chaseTarget` answers for the innings that CHASES — the last one the
    // format allows (`isChaseIndex`, cricket.ts: `inningsPerSide * 2 - 1`,
    // mirrored here because it is private). The brief's "two innings have
    // been played" gate is the same thing in a one-innings-a-side match and
    // only there: in a Test's THIRD innings it would put the fourth innings'
    // target on screen, which is a wrong number, not a missing one.
    //
    // A super over is out for the same reason from the other direction: its
    // target is its own first innings' score, not the match chase, and
    // nothing in this fold models super overs yet (see `cards()`).
    const isChase = !inSuperOver && index === state.cfg.inningsPerSide * 2 - 1;
    const target = isChase ? chaseTarget(state) : null;
    const needRuns = target === null ? null : target - innings.runs;
    // `innings.ballsLimit`, NOT `cfg.ballsPerInnings`: the innings' own quota
    // is initialised from `state.quota` (which is `cfg.ballsPerInnings`) and
    // is what `cricket.revise` moves when rain shortens the game — reading
    // the config instead would keep counting down to a length nobody is
    // playing to. It is also already the super over's one over (`bpo`), set
    // by `applySuperOverBall`. Identical to the config absent a revise.
    const ballsLeft = innings.ballsLimit === null ? null : innings.ballsLimit - innings.legalBalls;

    return {
      battingSide: state.entrants[innings.battingSide],
      striker: fine?.striker ?? null,
      nonStriker: fine?.nonStriker ?? null,
      // `null` between overs — `finishDelivery` clears the bowler at every
      // over boundary and the next ball names the replacement.
      bowler: fine?.currentBowler ?? null,
      // The OPEN over's glyphs, addressed the same way `onBall` files them:
      // by the over the current `legalBalls` sits in. Between overs that is
      // an over with no balls in it yet, so `[]` — the completed over is in
      // the log and does not linger here (fix round 1, finding 5). Addressing
      // it this way rather than "the last entry unless the count divides"
      // also keeps a wide bowled as the first ball of a new over in `thisOver`
      // where it belongs: it makes an entry without advancing `legalBalls`.
      thisOver: [...(overs[Math.floor(innings.legalBalls / bpo)]?.balls ?? [])],
      partnership:
        open === null ? null : { runs: innings.runs - open.runsAt, balls: innings.legalBalls - open.ballsAt },
      lastWicket:
        lastFall === undefined
          ? null
          : {
              batter: lastFall.batter,
              runs: fine?.batterRuns[lastFall.batter] ?? 0,
              balls: fine?.batterBalls[lastFall.batter] ?? 0,
              scoreAt: `${lastFall.runs}/${lastFall.wicket}`,
            },
      crr: innings.legalBalls > 0 ? (innings.runs * bpo) / innings.legalBalls : null,
      target,
      rrr: needRuns !== null && ballsLeft !== null && ballsLeft > 0 ? (needRuns * bpo) / ballsLeft : null,
      needRuns,
      ballsLeft,
      // "On this run rate, what does the innings finish on" — the current
      // rate carried out to the innings' full quota, rounded to whole runs.
      // Only the match's FIRST innings (`state.innings.length === 1`): a
      // side batting later is chasing a number, and the projection a
      // scoreboard shows then is the required rate, not this. Needs a quota
      // to project onto and a ball already bowled to have a rate at all.
      projected:
        !inSuperOver && state.innings.length === 1 && innings.ballsLimit !== null && innings.legalBalls > 0
          ? Math.round((innings.runs * innings.ballsLimit) / innings.legalBalls)
          : null,
    };
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
    if (ev.type === "cricket.retire") {
      acc.onRetire(state, ev);
    }
    if (ev.type === "cricket.player.line") {
      acc.onLine(ev);
    }
    // `cricket.innings.summary` (band 0) deliberately has NO accumulator
    // hook. Everything a summary carries that a card shows — runs, wickets,
    // legal balls, `declared`, and whether the innings is closed — is on
    // `state.innings` the moment `applySummary` has folded it, and `cards()`
    // already reads all five from there. A hook would be a second copy of
    // numbers the reducer already holds, which is exactly what this fold
    // exists not to do. What band 0 needed was a LEDGER that could express
    // it (`summaryOnlyLedger`, in the test builder) and the coverage to
    // prove the coarse path answers — including the target, which comes from
    // the reducer's own `chaseTarget` (see `live()`); the `innings[0].runs +
    // 1` fallback the brief offered is never taken, because `chaseTarget`
    // answers exactly that for a one-innings-a-side match and owns the DLS
    // and two-innings cases besides.
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
