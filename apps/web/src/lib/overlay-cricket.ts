// The overlay bar's SECOND BAND for cricket (stream overlay W2 Task 3): who is
// at the crease with their figures, and the bowler's analysis with this over.
//
// PURE and CLIENT-SAFE — no `@/server/**` import, which in this app is a build
// failure rather than a warning. The server projects `OverlayCricketLive` onto
// the payload; this file is the ONE place it becomes text.
//
// NO CRICKET ARITHMETIC LIVES HERE, deliberately. Overs, maidens, strike rates
// and the ball-by-ball glyphs all come from `deriveCricketScorecard`, the
// engine's own public spectator seam. An overlay that computed `0.3` from a
// ball count would be a second implementation of over arithmetic, and the two
// would disagree the first time a competition declared eight-ball overs.
//
// WHAT IS COPY AND WHAT IS NOTATION. Only two strings here are translated: the
// striker's marker and the words "this over". `2.3-0-14-1`, `4`, `wd`, `nb+2`
// and `W` are cricket NOTATION — they are the same on a Dutch broadcast as on
// an English one, which is why they are not dictionary keys.
import type { BallGlyph, CricketScorecard } from "@seazn/engine/sports/cricket";
import type { OverlayMsg } from "@/lib/overlay-model";

export interface OverlayCricketBatter {
  /** Consent-resolved, and ABSENT for a person the line-up never named. A
   *  nameless batter is dropped from the LINE rather than rendered as a
   *  placeholder — but it still rides on the wire, because "two batters are in"
   *  is a fact and only the rendering is a choice. */
  name?: string;
  runs: number;
  balls: number;
  /**
   * Carried EXPLICITLY rather than implied by array position.
   *
   * Position alone was wrong and was caught by a test that had aimed at
   * something else: with the striker unnamed and dropped from the line, the
   * NON-striker became element zero and was marked as on strike. The marker
   * says who is facing; it cannot be a function of who happens to be
   * renderable.
   */
  onStrike: boolean;
}

export interface OverlayCricketBowler {
  name?: string;
  /** The engine's own string — "0.3", never re-derived from a ball count. */
  overs: string;
  /** `null` at fidelity band 2, where the ledger cannot state it. */
  maidens: number | null;
  runs: number;
  wickets: number;
}

export interface OverlayCricketLive {
  /** STRIKER FIRST. Empty between innings and before the first ball. */
  batters: OverlayCricketBatter[];
  bowler?: OverlayCricketBowler;
  /** This over's deliveries, as the engine's structured glyphs. Rendering them
   *  is this file's job; carrying pre-rendered strings on the wire would put
   *  the notation in two places. */
  thisOver: BallGlyph[];
}

/**
 * The engine's scorecard → the overlay's own live block, with names resolved.
 *
 * `nameOf` is the caller's CONSENT-RESOLVED lookup and may answer `undefined`
 * for a person the line-up never named — a stale ledger reference, or a lineup
 * gap. That person is dropped rather than given a placeholder: "—* 34 (21)" on
 * a broadcast graphic is worse than one fewer batter on the line.
 */
export function liveFromScorecard(
  scorecard: CricketScorecard,
  nameOf: (personId: string) => string | undefined,
): OverlayCricketLive | null {
  const live = scorecard.live;
  if (!live) return null;
  const innings = scorecard.innings.at(-1);
  if (!innings) return null;

  const batterOf = (personId: string | null): OverlayCricketBatter | null => {
    if (personId === null) return null;
    const line = innings.batting.find((b) => b.person === personId);
    if (!line) return null;
    const name = nameOf(personId);
    return {
      ...(name === undefined ? {} : { name }),
      runs: line.runs,
      balls: line.balls,
      onStrike: personId === live.striker,
    };
  };
  // Striker first, AND flagged. The order is the reading order; the flag is the
  // fact — see `OverlayCricketBatter.onStrike`.
  const batters = [batterOf(live.striker), batterOf(live.nonStriker)].filter(
    (b): b is OverlayCricketBatter => b !== null,
  );

  const bowlLine = live.bowler === null ? undefined : innings.bowling.find((b) => b.person === live.bowler);
  const bowlerName = live.bowler === null ? undefined : nameOf(live.bowler);
  const bowler: OverlayCricketBowler | undefined =
    bowlLine === undefined || bowlerName === undefined
      ? undefined
      : {
          name: bowlerName,
          overs: bowlLine.overs,
          maidens: bowlLine.maidens,
          runs: bowlLine.runs,
          wickets: bowlLine.wickets,
        };

  return { batters, ...(bowler === undefined ? {} : { bowler }), thisOver: live.thisOver };
}

export type OverlayCricketToss = {
  wonBySide: 0 | 1;
  elected: "bat" | "bowl";
};

export type OverlayClosedOver = {
  /** 1-based over number. */
  over: number;
  runs: number;
  wickets: number;
  /** Team total after the over, e.g. `142/6`. */
  score: string;
  glyphs: BallGlyph[];
  bowler?: OverlayCricketBowler;
  batters: OverlayCricketBatter[];
};

/**
 * Scorecard toss → overlay side index. `sides` is `[homeEntrantId, awayEntrantId]`.
 * Null when no toss, or when `wonBy` is not one of the two sides.
 */
export function tossFromScorecard(
  scorecard: CricketScorecard,
  sides: readonly [string, string],
): OverlayCricketToss | null {
  const toss = scorecard.toss;
  if (!toss) return null;
  const wonBySide = toss.wonBy === sides[0] ? 0 : toss.wonBy === sides[1] ? 1 : undefined;
  if (wonBySide === undefined) return null;
  return { wonBySide, elected: toss.elected };
}

/** True once any over log or live delivery exists — the first scoring fact. */
export function scoringStartedFromScorecard(scorecard: CricketScorecard): boolean {
  if (scorecard.live && scorecard.live.thisOver.length > 0) return true;
  return scorecard.innings.some((inn) => inn.overs.length > 0 || inn.total.legalBalls > 0);
}

/**
 * The most recently *completed* over in the latest innings.
 *
 * Mid-over (`thisOver.length > 0`), that is `overs.at(-2)` — the current over
 * is already in `overs` as the tip. Between overs (`thisOver` empty) the tip
 * itself is complete.
 */
export function lastClosedOverFromScorecard(
  scorecard: CricketScorecard,
  nameOf: (personId: string) => string | undefined,
): OverlayClosedOver | null {
  const innings = scorecard.innings.at(-1);
  if (!innings || innings.overs.length === 0) return null;
  const midOver = (scorecard.live?.thisOver.length ?? 0) > 0;
  const over = midOver ? innings.overs.at(-2) : innings.overs.at(-1);
  if (!over) return null;

  const bowlLine =
    over.bowler === null ? undefined : innings.bowling.find((b) => b.person === over.bowler);
  const bowlerName = over.bowler === null ? undefined : nameOf(over.bowler);
  const bowler: OverlayCricketBowler | undefined =
    bowlLine === undefined || bowlerName === undefined
      ? undefined
      : {
          name: bowlerName,
          overs: bowlLine.overs,
          maidens: bowlLine.maidens,
          runs: bowlLine.runs,
          wickets: bowlLine.wickets,
        };

  // Crease figures at projection time (best available for the full card).
  const liveBlock = liveFromScorecard(scorecard, nameOf);

  return {
    over: over.number,
    runs: over.runs,
    wickets: over.wickets,
    score: `${over.scoreAfter.runs}/${over.scoreAfter.wickets}`,
    glyphs: over.balls,
    ...(bowler === undefined ? {} : { bowler }),
    batters: liveBlock?.batters ?? [],
  };
}

/** One delivery, as a scorer would write it. Notation, never copy. */
export function ballGlyphText(g: BallGlyph): string {
  switch (g.kind) {
    case "runs":
      // A dot ball is a DOT. "0" on a broadcast graphic reads as a score.
      return g.runs === 0 ? "·" : String(g.runs);
    case "wide":
      // The wide itself is one run; anything beyond it was run.
      return g.runs > 1 ? `wd+${g.runs - 1}` : "wd";
    case "noball":
      return g.runs > 1 ? `nb+${g.runs - 1}` : "nb";
    case "bye":
      return `${g.runs}b`;
    case "legbye":
      return `${g.runs}lb`;
    case "penalty":
      return `${g.runs}p`;
    case "wicket":
      return "W";
  }
}

/** @deprecated Use `ballGlyphText` — kept so existing call sites stay stable. */
function glyph(g: BallGlyph): string {
  return ballGlyphText(g);
}

/**
 * The band's two lines. `[]` when nothing is at the crease — between innings,
 * before the first ball, or a fixture whose ledger cannot say. An empty band is
 * a designed state; an empty LINE is a gap on air.
 *
 * The second line survives an unnamed bowler: the glyphs are the OVER, not the
 * person, and dropping them with the name would lose the more useful half.
 *
 * Glyphs ride as structured chips (`glyphs`) so bar/bug can circle them —
 * never flattened into `text` (a string cannot carry pill geometry).
 */
export type CricketDetailLine = {
  text: string;
  glyphs?: readonly string[];
};

export function cricketDetail(
  live: OverlayCricketLive | null | undefined,
  msg: OverlayMsg,
): CricketDetailLine[] {
  // TWO guards, and they ask DIFFERENT questions: "there is no crease block at
  // all" (between innings, not cricket) versus "there is one, and nobody on it
  // can be named". The third — `batters.length === 0` — was the redundant one,
  // since the filter of an empty list is empty, and it is gone.
  if (!live) return [];
  const named = live.batters.filter((b) => b.name !== undefined);
  if (named.length === 0) return [];

  const mark = msg("overlay.cricket.strikerMark");
  const batters = named
    .map((b) => `${b.name}${b.onStrike ? mark : ""} ${b.runs} (${b.balls})`)
    .join(" · ");

  const glyphLabels =
    live.thisOver.length === 0 ? undefined : live.thisOver.map(ballGlyphText);
  const bowler =
    live.bowler === undefined
      ? undefined
      : `${live.bowler.name} ${[
          live.bowler.overs,
          ...(live.bowler.maidens === null ? [] : [String(live.bowler.maidens)]),
          String(live.bowler.runs),
          String(live.bowler.wickets),
        ].join("-")}`;

  // No "this over" label on the live band — the circular glyphs carry that
  // meaning. The end-of-over card keeps `overlay.cricket.thisOver` as its
  // column heading.
  const second: CricketDetailLine | undefined =
    bowler === undefined && glyphLabels === undefined
      ? undefined
      : {
          text: bowler ?? "",
          ...(glyphLabels === undefined ? {} : { glyphs: glyphLabels }),
        };

  return second === undefined ? [{ text: batters }] : [{ text: batters }, second];
}
