// Spectator surface W1, Task 6 — `buildMatchCentre`: the server-side view
// model that turns a fixture + its event ledger + consent-resolved lineups
// into the `MatchCentreDocT` the public match centre renders (design doc
// "Web view model and transport"). Pure: no DB, no clock other than
// `input.now`. Cricket gets the rich Scorecard/Commentary treatment via the
// engine's own `deriveCricketScorecard` fold (R5 — never re-implement a
// cricket rule: every number here is read off that fold or off the fixture's
// own stored `summary`/`outcome`, never recomputed). Every other sport goes
// through `buildTimeline`/`buildSets` (Task 7) instead.
//
// ---------------------------------------------------------------------------
// Corrected false premises (brief vs. what the engine actually declares)
// ---------------------------------------------------------------------------
//
// 1. THE BRIEF'S `summary.detail.margin` SHAPE DOES NOT EXIST. `cricket.ts`'s
//    `CricketState.margin` (line 528) is a plain `string | null` — English
//    prose the reducer already composed ("by 12 runs", "Super Over", "on
//    boundary count"). There is no `{kind,value}` object anywhere in the
//    engine. `parseMargin` below reads the NUMBER back out of that string —
//    not re-deriving the cricket rule that decided it, only extracting the
//    figure so the result can be a localizable `Msg` instead of the engine's
//    raw English text reaching a spectator unchanged.
// 2. "dls" IS NOT A MARGIN KIND. The brief's sketch listed `"dls"` alongside
//    `"runs"`/`"wickets"`/`"tie"`/`"superover"` as a `kind`, but `dls` is a
//    WIN METHOD (`cricket.ts:883,1112,1118` — `methodSuffix`), and a
//    DLS-decided win still phrases its margin as "by N runs" or "by N
//    wickets", identically to a regulation win. `RESULT_KINDS` below has no
//    "dls" member; a DLS win reaches "runs" or "wickets" like any other.
// 3. THE PINNED LINE RANGE "cricket.ts:3300-3325" IS `apply()`'s event
//    switch, not result construction. The real call sites are `decideWin`
//    (847-864) and its callers in `decideAfterClose` (879-940), the DLS
//    branch (1085-1120) and the super-over settlement (1740-1767) — cited
//    individually below.
//
// ---------------------------------------------------------------------------
// A documented gap `BallGlyph`/`OverLog` impose (scorecard-types.ts:39-53)
// ---------------------------------------------------------------------------
//
// The brief asks every ball-by-ball commentary line to carry a `{batter}`
// param. Neither `BallGlyph` (`{kind,runs}` or `{kind:"wicket",dismissal}`)
// nor `OverLog` (`{number,bowler,balls,runs,wickets,scoreAfter}`) records WHO
// was on strike for a given ball — only `onBall`'s internal accumulator ever
// knew that, and it is not carried into the card. Recovering it here would
// mean re-deriving crease occupancy ball by ball, which is exactly the "one
// authority" rule this module exists to respect. `batter` is therefore always
// `""` in a ball line's params — the same "empty string when absent"
// convention the dismissal `Msg` contract already establishes — and this is
// flagged for whoever owns the scorecard fold (Tasks 1-4/17) as a possible
// follow-up if per-ball striker identity is ever needed.
import type { EventEnvelope, LineupPair, Lineup, ScoreSummary } from "@seazn/engine/core";
import {
  deriveCricketScorecard,
  cricket,
  CricketWicket,
  type BallGlyph,
  type BattingLine,
  type BowlingLine,
  type CricketInningsCard,
  type CricketLive,
  type CricketScorecard,
  type OverLog,
} from "@seazn/engine/sports/cricket";
import { resolveLatestModule } from "@/server/engine-db/registry";
import type { PublicFixture } from "./data";
import type { PublicPerson } from "./public-lineups";
import { buildSets, buildTimeline } from "./timeline";
import type {
  CricketViewT,
  InfoViewT,
  MatchCentreDocT,
  MatchCentreHeaderT,
  MatchCentreTabIdT,
  MsgT,
  PersonT,
  SetsViewT,
  SideT,
  TimelineLineT,
} from "./match-centre-schema";

export interface MatchCentreInput {
  fixture: PublicFixture;
  sportKey: string;
  cfg: unknown;
  events: readonly EventEnvelope[];
  lineups: Record<string, PublicPerson[]>;
  sides: [SideT, SideT];
  venueTz: string;
  locale: string;
  now: Date;
  hrefs: { division: string; competition: string; calendar: string | null };
  stage: { name: string; roundLabel: string | null } | null;
}

// --------------------------------------------------------------- constants

// Pinned from the engine's own declaration: `CricketWicket.shape.kind` is the
// zod enum backing every wicket the reducer accepts (10 members,
// `cricket.ts:151-163`), plus the two shapes `scorecard-types.ts:22-24`
// reserves for a dismissal the fold cannot fully describe: `not_out` (never
// dismissed) and `out_unknown` (a band-2 line said "out", nothing more).
export const DISMISSAL_KINDS = [...CricketWicket.shape.kind.options, "not_out", "out_unknown"] as const;

// Hand-pinned: no zod enum backs this axis (see the header note on the
// brief's false premise). "runs"/"wickets"/"innings"/"superover"/
// "boundarycount" are the shapes `parseMargin` recognises in `state.margin`
// (`cricket.ts`: chase/defend wins 891-896 & 899-905, two-innings wins
// 918-925, innings victories 929-936, DLS wins 1108-1118 — same phrasing as
// regulation, a decided super over 1746-1753 — literal "Super Over", and a
// still-tied super over settled on boundary count 1758-1764 — literal "on
// boundary count"). "forfeit" is `core.forfeit`'s `{kind:"award"}` outcome
// (`cricket.ts:3361-3371`). "tie"/"draw"/"no_result" are three of
// `MatchOutcome`'s five kinds (`core/types.ts:115-132`) — cricket never
// reaches the generic "win" fallback on its own (a cricket win always
// carries a margin string `parseMargin` understands), but a non-cricket
// sport's win carries no margin at all, so "win" stays as the one generic key
// for that case and for any future engine phrasing this module does not yet
// recognise.
export const RESULT_KINDS = [
  "win",
  "runs",
  "wickets",
  "innings",
  "superover",
  "boundarycount",
  "forfeit",
  "tie",
  "draw",
  "no_result",
] as const;

// Hand-pinned from `BallGlyph`'s own declaration (`scorecard-types.ts:39-44`)
// — a plain TS union, not a zod schema, so there is no `.options` to read
// (unlike `DISMISSAL_KINDS` above).
export const BALL_GLYPH_KINDS = ["runs", "wide", "noball", "bye", "legbye", "penalty", "wicket"] as const;

// ------------------------------------------------------------- formatting

/** `strikeRate`/`economy` arrive from the fold already rounded to one
 *  decimal (`scorecard.ts`'s own `Math.round(x*10)/10`); this only pins the
 *  DISPLAY shape ("150.0", never "150"). */
export function fmt1(n: number): string {
  return n.toFixed(1);
}

/** `crr`/`rrr` arrive UNROUNDED (contract notes) — two decimals, always. */
export function fmt2(n: number): string {
  return n.toFixed(2);
}

// ------------------------------------------------------------------ persons

type PersonOf = (id: string) => PersonT;

/** Looks a person up on EITHER side's consent-resolved lineup; a person the
 *  lineup export never named (a stale ledger reference, a lineup gap) falls
 *  back to a masked placeholder row — never a blank one (contract notes). */
function makePersonOf(lineups: Record<string, PublicPerson[]>): PersonOf {
  const byId = new Map<string, PublicPerson>();
  for (const list of Object.values(lineups)) {
    for (const person of list) byId.set(person.personId, person);
  }
  return (id: string): PersonT => byId.get(id) ?? { personId: id, name: "?", masked: true };
}

/** The consent-resolved `Record<entrantId, PublicPerson[]>` this module
 *  receives has no batting-order information beyond array position, so the
 *  array's OWN order becomes `orderNo` — exactly the order
 *  `readPublicLineups`'s SQL already sorts by (`order_no nulls last`). */
function toLineupPair(lineups: Record<string, PublicPerson[]>, sides: readonly [SideT, SideT]): LineupPair {
  const toLineup = (side: SideT): Lineup => ({
    entrantId: side.entrantId,
    slots: (lineups[side.entrantId] ?? []).map((person, i) => ({
      personId: person.personId,
      slot: "starting" as const,
      orderNo: i + 1,
    })),
  });
  return { home: toLineup(sides[0]), away: toLineup(sides[1]) };
}

function sideByEntrantId(entrantId: string, sides: readonly [SideT, SideT]): SideT {
  return sides.find((s) => s.entrantId === entrantId) ?? sides[0];
}

function sideNameOf(sides: readonly [SideT, SideT], entrantId: string): string {
  return sides.find((s) => s.entrantId === entrantId)?.name ?? "";
}

// --------------------------------------------------------------- dismissal

type DismissalDetail = BattingLine["dismissal"];

/**
 * A dismissal detail -> a localizable `Msg`. Every branch supplies ALL of
 * `bowler`/`fielder`/`assist` (empty string when absent) — contract notes'
 * ruling, mirrored by `scorecard-tab.tsx`'s own fallback-on-unresolved-brace
 * behaviour. The run-out template takes ONE `{fielder}`
 * (`scorecard-tab.tsx`'s own contract note), so a thrower/breaker pair is
 * composed into it here, the way a scorebook prints "run out (Jones/Smith)".
 */
export function dismissalMsg(d: DismissalDetail, personOf: PersonOf): MsgT {
  // `not_out`/`out_unknown` carry no bowler/fielder/assist AT ALL on their
  // own type (`scorecard-types.ts:22-24`), and their templates have no
  // placeholders ("not out", "out") — so, unlike the ten real dismissal
  // kinds below, these two stay bare `{key}` with no `params`. Required
  // test: `dismissal).toEqual({ key: "matchCentre.dismissal.out_unknown" })`
  // — a `params` object here would fail that `toEqual`.
  if (d.kind === "not_out") return { key: "matchCentre.dismissal.not_out" };
  if (d.kind === "out_unknown") return { key: "matchCentre.dismissal.out_unknown" };
  const bowlerName = d.bowler !== null ? personOf(d.bowler).name : "";
  const fielderName = d.fielder !== null ? personOf(d.fielder).name : "";
  const assistName = d.fielderAssist !== null ? personOf(d.fielderAssist).name : "";
  const fielder =
    d.kind === "runout" ? [fielderName, assistName].filter((s) => s !== "").join("/") : fielderName;
  return {
    key: `matchCentre.dismissal.${d.kind}`,
    params: { bowler: bowlerName, fielder, assist: assistName },
  };
}

// ------------------------------------------------------------------ glyphs

/** Ball glyph -> compact chip string, matching `glyphs.tsx`'s own documented
 *  shapes ("1","4","W","wd","nb+2","·"). Byes/leg-byes/penalties have no
 *  fixed baseline the way a wide/no-ball's mandatory penalty run does, so
 *  they always show their full count (`b1`, `lb4`, `pen1`, …); a wide/no-ball
 *  shows the bare letters at their minimum (1 run) and `+N` beyond it. */
function ballGlyphString(g: BallGlyph): string {
  switch (g.kind) {
    case "wicket":
      return "W";
    case "runs":
      return g.runs === 0 ? "·" : String(g.runs);
    case "wide":
      return g.runs <= 1 ? "wd" : `wd+${g.runs - 1}`;
    case "noball":
      return g.runs <= 1 ? "nb" : `nb+${g.runs - 1}`;
    case "bye":
      return `b${g.runs}`;
    case "legbye":
      return `lb${g.runs}`;
    case "penalty":
      return `pen${g.runs}`;
  }
}

/** Per-ball commentary `Msg`s for one over. `over` is cricket's own
 *  over.ball notation — the completed-legal-ball count before this
 *  delivery, so a wide/no-ball reports the SAME notation as the legal ball
 *  it precedes (it has not advanced the count yet). `batter` is always ""
 *  — see the module header's documented gap. */
function ballLines(over: OverLog, personOf: PersonOf): MsgT[] {
  const bowlerName = over.bowler === null ? "" : personOf(over.bowler).name;
  let legalCount = 0;
  return over.balls.map((ball) => {
    const notation = `${over.number - 1}.${legalCount + 1}`;
    if (ball.kind !== "wide" && ball.kind !== "noball") legalCount += 1;
    const runs = ball.kind === "wicket" ? 0 : ball.runs;
    return {
      key: `matchCentre.ball.${ball.kind}`,
      params: { over: notation, bowler: bowlerName, batter: "", runs },
    };
  });
}

// ------------------------------------------------------------------- rows

function buildBattingRow(row: BattingLine, personOf: PersonOf): CricketViewT["innings"][number]["batting"][number] {
  return {
    person: personOf(row.person),
    runs: row.runs,
    balls: row.balls,
    fours: row.fours,
    sixes: row.sixes,
    strikeRate: row.strikeRate === null ? null : fmt1(row.strikeRate),
    dismissal: dismissalMsg(row.dismissal, personOf),
    notOut: row.dismissal.kind === "not_out",
  };
}

function buildBowlingRow(row: BowlingLine, personOf: PersonOf): CricketViewT["innings"][number]["bowling"][number] {
  return {
    person: personOf(row.person),
    overs: row.overs,
    maidens: row.maidens,
    runs: row.runs,
    wickets: row.wickets,
    economy: row.economy === null ? null : fmt1(row.economy),
    wides: row.wides,
    noBalls: row.noBalls,
  };
}

/** "12 (b 2, lb 3, w 6, nb 1)" — NUMBERS AND NOTATION ONLY (contract note on
 *  `scorecard-tab.tsx`): the letters are the same b/lb/w/nb/pen abbreviation
 *  set the column headers already use as notation, never a translated word.
 *  `null` at band ≤ 2, where no ball fidelity exists to total extras from
 *  (`CricketInningsCard.extras` is `null` there — scorecard-types.ts:76). */
function extrasLineOf(extras: CricketInningsCard["extras"]): string | null {
  if (extras === null) return null;
  const parts: string[] = [];
  if (extras.byes > 0) parts.push(`b ${extras.byes}`);
  if (extras.legByes > 0) parts.push(`lb ${extras.legByes}`);
  if (extras.wides > 0) parts.push(`w ${extras.wides}`);
  if (extras.noBalls > 0) parts.push(`nb ${extras.noBalls}`);
  if (extras.penalties > 0) parts.push(`pen ${extras.penalties}`);
  return parts.length === 0 ? `${extras.total}` : `${extras.total} (${parts.join(", ")})`;
}

function buildOverLogView(over: OverLog, personOf: PersonOf): CricketViewT["innings"][number]["overs"][number] {
  return {
    number: over.number,
    bowler: over.bowler === null ? null : personOf(over.bowler),
    glyphs: over.balls.map(ballGlyphString),
    runs: over.runs,
    wickets: over.wickets,
    scoreAfter: `${over.scoreAfter.runs}/${over.scoreAfter.wickets}`,
    lines: ballLines(over, personOf),
  };
}

function buildInningsView(
  card: CricketInningsCard,
  sides: readonly [SideT, SideT],
  personOf: PersonOf,
): CricketViewT["innings"][number] {
  return {
    number: card.number,
    side: sideByEntrantId(card.side, sides),
    isSuperOver: card.isSuperOver,
    total: {
      runs: card.total.runs,
      wickets: card.total.wickets,
      overs: card.total.overs,
      runRate: card.total.runRate === null ? null : fmt2(card.total.runRate),
    },
    extrasLine: extrasLineOf(card.extras),
    batting: card.batting.map((row) => buildBattingRow(row, personOf)),
    didNotBat: card.didNotBat.map((id) => personOf(id)),
    bowling: card.bowling.map((row) => buildBowlingRow(row, personOf)),
    fallOfWickets: card.fallOfWickets.map((f) => ({
      wicket: f.wicket,
      runs: f.runs,
      over: f.over,
      batter: personOf(f.batter),
    })),
    partnerships: card.partnerships.map((p) => ({
      batters: [personOf(p.batters[0]), personOf(p.batters[1])],
      runs: p.runs,
      balls: p.balls,
      wicket: p.wicket,
    })),
    overs: card.overs.map((over) => buildOverLogView(over, personOf)),
  };
}

/** The live block: the crease pair's own rows (never the whole batting
 *  card) and the current bowler's own row (never every bowler used) — see
 *  the module header on why `CricketLive` gives only ids, not rows.
 *  `card.innings[last]` is always the OPEN innings by construction
 *  (`scorecard-tab.tsx` note 2 — a super over's own container follows the
 *  same rule, and `cards()` appends super-over cards after the main ones). */
function buildLiveView(card: CricketScorecard, personOf: PersonOf): CricketViewT["live"] {
  const live = card.live;
  if (live === null) return null;
  const activeCard = card.innings[card.innings.length - 1] ?? null;
  const battingRows = activeCard?.batting ?? [];
  const bowlingRows = activeCard?.bowling ?? [];

  const creaseIds = [live.striker, live.nonStriker].filter((id): id is string => id !== null);
  const batters = creaseIds
    .map((id) => battingRows.find((row) => row.person === id))
    .filter((row): row is BattingLine => row !== undefined)
    .map((row) => buildBattingRow(row, personOf));
  const bowling =
    live.bowler === null
      ? []
      : bowlingRows.filter((row) => row.person === live.bowler).map((row) => buildBowlingRow(row, personOf));

  return {
    striker: live.striker === null ? null : personOf(live.striker),
    nonStriker: live.nonStriker === null ? null : personOf(live.nonStriker),
    bowler: live.bowler === null ? null : personOf(live.bowler),
    batters,
    bowling,
    thisOver: live.thisOver.map(ballGlyphString),
    partnership: live.partnership === null ? null : `${live.partnership.runs} (${live.partnership.balls})`,
    lastWicket:
      live.lastWicket === null
        ? null
        : {
            key: "matchCentre.lastWicket.detail",
            params: {
              batter: personOf(live.lastWicket.batter).name,
              runs: live.lastWicket.runs,
              balls: live.lastWicket.balls,
              scoreAt: live.lastWicket.scoreAt,
            },
          },
  };
}

// ------------------------------------------------------------ top performers

function pickBest<T>(rows: readonly T[], better: (a: T, b: T) => number): T | null {
  if (rows.length === 0) return null;
  return rows.reduce((best, row) => (better(row, best) < 0 ? row : best));
}

/**
 * Best batter by runs then strike rate, best bowler by wickets then economy
 * — PER INNINGS (brief Step 3). "Best" ties break in the direction that
 * rewards efficiency (higher SR, lower economy), never array order — the
 * required order-differential test exists to prove exactly that a mutant
 * swapping the tie-break direction reds.
 */
function topPerformersOf(
  card: CricketScorecard,
  sides: readonly [SideT, SideT],
  personOf: PersonOf,
): CricketViewT["topPerformers"] {
  const out: CricketViewT["topPerformers"] = [];
  for (const innings of card.innings) {
    const battingSide = sideByEntrantId(innings.side, sides);
    const bowlingSide = sides.find((s) => s.entrantId !== innings.side) ?? sides[1];

    const bestBatter = pickBest(innings.batting, (a, b) => {
      if (a.runs !== b.runs) return b.runs - a.runs;
      return (b.strikeRate ?? -1) - (a.strikeRate ?? -1);
    });
    if (bestBatter !== null) {
      out.push({
        role: "batter",
        person: personOf(bestBatter.person),
        side: battingSide,
        line: `${bestBatter.runs} (${bestBatter.balls})`,
        detail: bestBatter.strikeRate === null ? null : `SR ${fmt1(bestBatter.strikeRate)}`,
      });
    }

    const bestBowler = pickBest(innings.bowling, (a, b) => {
      if (a.wickets !== b.wickets) return b.wickets - a.wickets;
      return (a.economy ?? Number.POSITIVE_INFINITY) - (b.economy ?? Number.POSITIVE_INFINITY);
    });
    if (bestBowler !== null) {
      out.push({
        role: "bowler",
        person: personOf(bestBowler.person),
        side: bowlingSide,
        line: `${bestBowler.wickets}/${bestBowler.runs}`,
        detail: bestBowler.economy === null ? null : `Econ ${fmt1(bestBowler.economy)}`,
      });
    }
  }
  return out;
}

function buildCricketView(card: CricketScorecard, sides: readonly [SideT, SideT], personOf: PersonOf): CricketViewT {
  return {
    band: card.band,
    toss:
      card.toss === null
        ? null
        : {
            key: "matchCentre.toss",
            params: { side: sideNameOf(sides, card.toss.wonBy), elected: card.toss.elected },
          },
    innings: card.innings.map((innings) => buildInningsView(innings, sides, personOf)),
    live: buildLiveView(card, personOf),
    topPerformers: topPerformersOf(card, sides, personOf),
  };
}

// -------------------------------------------------------------- the result

interface ParsedMargin {
  kind: "runs" | "wickets" | "innings" | "superover" | "boundarycount";
  value: number | null;
}

/**
 * Reads the NUMBER back out of the engine's own margin string — see the
 * module header on why this is extraction, not re-derivation, and the exact
 * `decideWin` call sites each pattern below is pinned against.
 */
function parseMargin(margin: string): ParsedMargin | null {
  let m = /^by (\d+) wickets?$/.exec(margin);
  if (m) return { kind: "wickets", value: Number(m[1]) };
  m = /^by an innings and (\d+) runs?$/.exec(margin);
  if (m) return { kind: "innings", value: Number(m[1]) };
  m = /^by (\d+) runs?$/.exec(margin);
  if (m) return { kind: "runs", value: Number(m[1]) };
  if (margin === "Super Over") return { kind: "superover", value: null };
  if (margin === "on boundary count") return { kind: "boundarycount", value: null };
  return null;
}

/**
 * The decided-header `Msg` — `matchCentre.result.<kind>` (ruling: bare keys,
 * never `public.`-prefixed). `outcome.kind` (from `fixture.outcome`, the
 * fixture's own stored `MatchOutcome`) is the axis for WHICH of win / draw /
 * tie / no_result / forfeit this is — `card.result` alone cannot tell a tie
 * from a draw from a no-result (all three carry `winner:null, margin:null`).
 * The WINNER, when there is one, prefers `card.result.winner` (contract
 * notes: "never recompute" — card.result is the cricket fold's own answer)
 * and falls back to `outcome.winner` only when there is no card (every
 * non-cricket sport).
 */
function resultMsg(
  outcome: PublicFixture["outcome"],
  marginText: string | null,
  cardWinner: string | null,
  sides: readonly [SideT, SideT],
): MsgT | null {
  if (outcome == null || outcome.kind === undefined) return null;
  const winnerName = (id: string | null | undefined): string => (id ? sideNameOf(sides, id) : "");
  switch (outcome.kind) {
    case "tie":
      return { key: "matchCentre.result.tie" };
    case "draw":
      return { key: "matchCentre.result.draw" };
    case "no_result":
      return { key: "matchCentre.result.no_result" };
    case "award":
      return { key: "matchCentre.result.forfeit", params: { side: winnerName(cardWinner ?? outcome.winner) } };
    case "win": {
      const side = winnerName(cardWinner ?? outcome.winner);
      const parsed = marginText === null ? null : parseMargin(marginText);
      if (parsed === null) return { key: "matchCentre.result.win", params: { side } };
      const params: Record<string, string | number> = { side };
      if (parsed.value !== null) params[parsed.kind === "wickets" ? "wickets" : "runs"] = parsed.value;
      return { key: `matchCentre.result.${parsed.kind}`, params };
    }
    default:
      return null;
  }
}

// -------------------------------------------------------------- the header

function statusOf(fixtureStatus: string): MatchCentreHeaderT["status"] {
  switch (fixtureStatus) {
    case "in_play":
      return "in_play";
    case "decided":
    case "finalized":
      return "decided";
    case "scheduled":
      return "scheduled";
    default:
      // abandoned / forfeited / cancelled, and forward-compatible with any
      // status value this module does not yet know.
      return "other";
  }
}

function rateLineOf(live: CricketLive): string | null {
  if (live.crr === null) return null;
  const crr = `CRR ${fmt2(live.crr)}`;
  return live.rrr === null ? crr : `${crr} · RRR ${fmt2(live.rrr)}`;
}

function buildHeader(
  fixture: PublicFixture,
  sides: [SideT, SideT],
  card: CricketScorecard | null,
  venueTz: string,
  locale: string,
  now: Date,
): MatchCentreHeaderT {
  const status = statusOf(fixture.status);

  const perSide = fixture.summary?.perSide ?? [];
  const scoreLines: [string | null, string | null] = [
    perSide.find((p) => p.entrantId === sides[0].entrantId)?.line ?? null,
    perSide.find((p) => p.entrantId === sides[1].entrantId)?.line ?? null,
  ];

  const battingIndex: 0 | 1 | null =
    card?.live == null
      ? null
      : sides[0].entrantId === card.live.battingSide
        ? 0
        : sides[1].entrantId === card.live.battingSide
          ? 1
          : null;

  let statusLine: MsgT | null = null;
  let rateLine: string | null = null;

  if (status === "scheduled") {
    if (fixture.scheduled_at !== null) {
      const when = new Intl.DateTimeFormat(locale, {
        timeZone: venueTz,
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(fixture.scheduled_at));
      statusLine = { key: "matchCentre.status.startsAt", params: { when } };
    }
  } else if (status === "decided") {
    const marginText = typeof card?.result?.margin === "string" ? card.result.margin : null;
    const cardWinner = card?.result?.winner ?? null;
    statusLine = resultMsg(fixture.outcome, marginText, cardWinner, sides);
  } else if (status === "other") {
    statusLine = { key: `matchCentre.status.${fixture.status}` };
  } else if (status === "in_play" && card?.live) {
    const live = card.live;
    if (live.target !== null && live.needRuns !== null && live.ballsLeft !== null) {
      statusLine = {
        key: "matchCentre.chase.need",
        params: { side: sideNameOf(sides, live.battingSide), runs: live.needRuns, balls: live.ballsLeft },
      };
    }
    rateLine = rateLineOf(live);
  }

  return {
    live: status === "in_play",
    status,
    sides,
    scoreLines,
    subLines: [null, null],
    battingIndex,
    statusLine,
    rateLine,
    updatedAt: now.toISOString(),
  };
}

// ---------------------------------------------------------------- the info

function buildInfoView(
  fixture: PublicFixture,
  stage: { name: string; roundLabel: string | null } | null,
  hrefs: { division: string; competition: string; calendar: string | null },
  venueTz: string,
  locale: string,
): InfoViewT {
  const rows: InfoViewT["rows"] = [];

  if (fixture.scheduled_at !== null) {
    const when = new Intl.DateTimeFormat(locale, {
      timeZone: venueTz,
      dateStyle: "full",
      timeStyle: "short",
    }).format(new Date(fixture.scheduled_at));
    rows.push({
      label: { key: "matchCentre.info.start" },
      value: { key: "matchCentre.info.startValue", params: { when } },
    });
  }

  const venueParts = [fixture.venue_name, fixture.court_name].filter((s): s is string => s !== null);
  if (venueParts.length > 0) {
    rows.push({
      label: { key: "matchCentre.info.venue" },
      value: { key: "matchCentre.info.venueValue", params: { venue: venueParts.join(" · ") } },
    });
  }

  if (stage !== null) {
    rows.push({
      label: { key: "matchCentre.info.stage" },
      value:
        stage.roundLabel === null
          ? { key: "matchCentre.info.stageValue", params: { stage: stage.name } }
          : { key: "matchCentre.info.stageRoundValue", params: { stage: stage.name, round: stage.roundLabel } },
    });
  }

  return {
    rows,
    calendarHref: hrefs.calendar,
    divisionHref: hrefs.division,
    competitionHref: hrefs.competition,
  };
}

// -------------------------------------------------------------- the builder

export function buildMatchCentre(input: MatchCentreInput): MatchCentreDocT {
  const { fixture, sportKey, cfg, events, lineups, sides, venueTz, locale, now, hrefs, stage } = input;
  const personOf = makePersonOf(lineups);
  const lineupPair = toLineupPair(lineups, sides);

  let cricketView: CricketViewT | null = null;
  let card: CricketScorecard | null = null;
  let timelineLines: TimelineLineT[] | null = null;
  let setsView: SetsViewT | null = null;
  let derivedComplete = true;
  const extraTabs: MatchCentreTabIdT[] = [];

  if (sportKey === "cricket") {
    const parsedCfg = cricket.configSchema.parse(cfg);
    card = deriveCricketScorecard({ events, cfg: parsedCfg, lineups: lineupPair });
    cricketView = buildCricketView(card, sides, personOf);
    if (card.innings.some((innings) => innings.batting.length > 0)) extraTabs.push("scorecard");
    if (card.innings.some((innings) => innings.overs.length > 0)) extraTabs.push("commentary");
    // Cricket's fold has no partial-failure mode to report — unlike
    // `buildTimeline` it never replays under a try/catch degrade, so
    // `derivedComplete` stays `true` unconditionally (contract notes: "true
    // for cricket unless the fold reports an inconsistency" — it has no
    // mechanism to).
  } else {
    const sportModule = resolveLatestModule(sportKey);
    const timelineResult = buildTimeline({ sportKey, events, module: sportModule, cfg, lineups: lineupPair, sides, personOf });
    timelineLines = timelineResult.lines;
    derivedComplete = timelineResult.derivedComplete;
    const summary: ScoreSummary = {
      headline: fixture.summary?.headline ?? "",
      perSide: fixture.summary?.perSide ?? [],
      detail: fixture.summary?.detail,
    };
    setsView = buildSets({ sportKey, summary, sides });
    if (timelineLines.length > 0) extraTabs.push("timeline");
    if (setsView !== null && setsView.columns.length > 0) extraTabs.push("sets");
  }

  const header = buildHeader(fixture, sides, card, venueTz, locale, now);
  const info = buildInfoView(fixture, stage, hrefs, venueTz, locale);

  return {
    fixtureId: fixture.id,
    sportKey,
    header,
    tabs: ["summary", ...extraTabs, "info"],
    cricket: cricketView,
    timeline: timelineLines,
    sets: setsView,
    info,
    derivedComplete,
  };
}
