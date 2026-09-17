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
// 2. THE PINNED LINE RANGE "cricket.ts:3300-3325" IS `apply()`'s event
//    switch, not result construction. The real call sites are `decideWin`
//    (847-864) and its callers in `decideAfterClose` (879-940), the DLS
//    branch (1085-1120) and the super-over settlement (1740-1767) — cited
//    individually below.
//
// ---------------------------------------------------------------------------
// Fix round 1 (coordinator ruling, post Task-8-review) — result keying
// ---------------------------------------------------------------------------
//
// The first cut of this file keyed the decided-header message by REGEXING
// the engine's own English margin prose ("by 24 runs" -> "runs"). The
// coordinator's ruling — binding, already applied to Task 8 — is to key by
// `outcome.method` directly (it already states the same fact by name:
// `regulation | dls | innings | super_over | boundary_count`, `core/
// types.ts:120-122`, populated at every `decideWin` call site) and pass the
// margin STRING through verbatim as a param, never parsed into a number.
// `parseMargin` is gone; see `resultMsg` below.
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
import type { AnySportModule, FidelityBand } from "@seazn/engine/sport";
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
import { resolveLatestModule, resolveModule } from "@/server/engine-db/registry";
import { log } from "@/server/logger";
// The ONE reader of `summary.detail.shootout`, shared with `live-score.tsx`'s
// decided sentence — a second parse of the same jsonb is a second chance to
// disagree about the same match.
import { SHOOTOUT_IS_SKATED, shootoutScoreFromDetail } from "@/lib/scoring-vocab";
// The SAME readers `live-score.tsx` uses for the pair the match centre had
// dropped — one authority per fact, never a second parse of the same jsonb.
import { matchPhase, matchStrength } from "@/lib/public-site";
import { intlLocaleFor } from "@/lib/public-date-locale";
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
  /** Fix round 1 (Important #2) — the DIVISION's own pinned module version
   *  (`data.ts:190`'s `module_version`, threaded through by Task 9). A single
   *  division's read must always resolve its OWN pinned version
   *  (`engine-db/registry.ts:31-36`'s own doc comment says so in as many
   *  words) — `resolveLatestModule` is for cross-division rollups only.
   *  `null` falls back to `resolveLatestModule` ONLY for a caller that
   *  genuinely has no version to pin (a hand-built test fixture, or a future
   *  non-division context) — every production call (Task 9's
   *  `loadMatchCentre`) has a real division row in hand and must pass its
   *  `module_version` here, never `null`. */
  moduleVersion: string | null;
  /** Fix round 1 (Important #3) — the Info tab's "format" row (owner ruling,
   *  `info-tab.tsx:8-13`'s documented row order: toss · format · venue ·
   *  start · stage · scored-as). Nothing this module already receives names
   *  a division's variant/format, so the caller supplies the pre-resolved
   *  label text directly; Task 9 fills it from the division's variant/
   *  format. `null` omits the row entirely — never a blank one. */
  formatLabel: string | null;
}

// --------------------------------------------------------------- constants

// Pinned from the engine's own declaration: `CricketWicket.shape.kind` is the
// zod enum backing every wicket the reducer accepts (10 members,
// `cricket.ts:151-163`), plus the two shapes `scorecard-types.ts:22-24`
// reserves for a dismissal the fold cannot fully describe: `not_out` (never
// dismissed) and `out_unknown` (a band-2 line said "out", nothing more).
export const DISMISSAL_KINDS = [...CricketWicket.shape.kind.options, "not_out", "out_unknown"] as const;

// Fix round 1 (coordinator ruling) — keyed by `outcome.method` directly, not
// by re-deriving the same fact from the engine's English margin prose. Hand-
// pinned: `MatchOutcome`'s "win" member types `method` as a plain
// `z.string().min(1).optional()` (`core/types.ts:120-122`), not an enum, so
// there is no runtime declaration to read `.options` off. The five method
// values are `decideWin`'s own call sites: regulation (`cricket.ts:891-896,
// 899-905, 918-925`), dls (`1108-1118`), innings (`929-936`), super_over
// (`1746-1753`), boundary_count (`1758-1764`). "tie"/"no_result"/"draw" are
// three of `MatchOutcome`'s five kinds (`core/types.ts:115-131`) that carry
// no method/margin at all. "forfeit" is an addition beyond the coordinator's
// literal enumeration: `core.forfeit`'s `{kind:"award"}` outcome
// (`cricket.ts:3361-3371`) is a real, reachable `MatchOutcome` kind with no
// `method` field to key by, and dropping it would leave `resultMsg` emitting
// a key (`matchCentre.result.forfeit`) that `RESULT_KINDS` does not cover —
// flagged in the fix-round report for the coordinator/Task 8 to confirm.
// Every method the header can NAME. The first five are cricket's; `shootout`
// is football's and ice hockey's, and its absence here was a live defect: an
// unlisted method fell through to `regulation` ("{winner} won {margin}") with
// `margin` read off the CRICKET card, which is null for those sports — so the
// court card printed "X won" with a blank margin and the words "on penalties"
// appeared nowhere on the page. `summary-tab.tsx` suppresses `LiveScoreBody`'s
// own decided sentence (R11/C7) on the stated premise that this line already
// carries it, and for a shootout that premise was false. 7 football and 1 ice
// hockey fixtures in one local database were in exactly that state.
const WIN_METHODS = ["regulation", "dls", "innings", "super_over", "boundary_count", "shootout"] as const;
export const RESULT_KINDS = [...WIN_METHODS, "tie", "no_result", "draw", "forfeit"] as const;

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
 *  back to a masked placeholder row — never a blank one (contract notes).
 *
 *  A MASKED PERSON'S REAL id NEVER REACHES THE DOCUMENT. It used to: `PersonT`
 *  carried the raw `persons.id` whatever the consent said, and the components
 *  put it straight into the markup as `data-testid="mc-bat-<uuid>"` and as
 *  React keys. Anonymous HTML therefore published a stable, cross-division
 *  identifier for exactly the people who had withheld their name — so the same
 *  uuid appearing on another division's page, where that person DID consent,
 *  re-joins the name to the row this page had masked. `data.ts:306` already
 *  states the opposite convention for the sibling surface in as many words
 *  ("`person_id: null` = no public-name consent, no player card"); this
 *  surface simply had not followed it.
 *
 *  A SURROGATE rather than `null`, because the id is load-bearing in the
 *  renderer: it is the React key that keeps a batting row's identity stable
 *  across live updates and the testid the e2e suite selects by. `m1`, `m2`, …
 *  are assigned in first-seen order and memoised, so one masked person is ONE
 *  surrogate everywhere in the document — the same row across Summary,
 *  Scorecard and Commentary — while carrying nothing that survives the page.
 *
 *  Unmasked people keep their real id: the player card links to it, and their
 *  consent is precisely what makes that safe.
 *
 *  `toLineupPair` below deliberately keeps REAL ids — it feeds the engine's
 *  own fold, which runs server-side and never reaches a viewer. */
function makePersonOf(lineups: Record<string, PublicPerson[]>): PersonOf {
  const byId = new Map<string, PublicPerson>();
  for (const list of Object.values(lineups)) {
    for (const person of list) byId.set(person.personId, person);
  }
  const surrogates = new Map<string, string>();
  const surrogateFor = (realId: string): string => {
    const seen = surrogates.get(realId);
    if (seen !== undefined) return seen;
    const minted = `m${surrogates.size + 1}`;
    surrogates.set(realId, minted);
    return minted;
  };
  return (id: string): PersonT => {
    const person = byId.get(id);
    // Unknown to the lineup export: masked by construction, and its id is a
    // ledger reference we equally must not publish.
    if (person === undefined) return { personId: surrogateFor(id), name: "?", masked: true };
    if (!person.masked) return { personId: person.personId, name: person.name, masked: false };
    return { personId: surrogateFor(person.personId), name: person.name, masked: true };
  };
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
      // THE REAL SLOT, not "starting" for everyone. Stamping every member a
      // starter put the substitutes on the field before kick-off, so the
      // timeline replay hit "<name> is already on the field" at the first
      // `football.sub` and dropped every derived line after it — see
      // `PublicPerson`.
      //
      // SIBLING, stated because this pair feeds more than the timeline:
      // `deriveCricketScorecard` reads the same lineups and its batting order
      // is `slots.filter(s => s.slot === "starting")` (cricket.ts). So a
      // cricket fixture that names substitutes now excludes them from the
      // batting order — which is what a bench place MEANS, and what the pad
      // already does; it only ever looked otherwise here because this function
      // discarded the distinction.
      slot: person.slot,
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
/** The ball kinds whose line carries a run COUNT and therefore inflects.
 *  `wide`/`noball` read "+{runs}" (no noun), and `wicket` carries none. */
const PLURALISED_BALL_KINDS = new Set(["runs", "bye", "legbye", "penalty"]);

/** The plural category for a ball's run count, in the doc's own locale.
 *
 *  Only `one` and `other` are ever emitted, and that is a deliberate,
 *  test-enforced narrowing rather than an oversight: the extra CLDR
 *  categories the shipped locales define (`many` in fr and es) apply to
 *  magnitudes a single delivery cannot reach, so authoring them would mean
 *  four dictionary entries nothing can ever select. `ballLineKeysResolve`
 *  in `match-centre-dictionary.test.ts` enumerates every locale × kind ×
 *  0..6 runs and asserts the key this function names EXISTS — so if a fifth
 *  locale ever needs a third form, that test reds instead of a spectator
 *  seeing a raw dictionary key.
 *
 *  Selecting server-side is consistent with how this builder already works:
 *  the doc is locale-specific by construction (`buildHeader` and
 *  `buildInfoView` both format dates through `Intl.DateTimeFormat(locale)`),
 *  so the `Msg` a tab renders with a plain `t()` needs no locale of its own. */
function ballLineCategory(locale: string, count: number): "one" | "other" {
  return new Intl.PluralRules(locale).select(count) === "one" ? "one" : "other";
}

/** Every dictionary key `ballLines` below can emit, derived from the SAME two
 *  declarations it reads — so a kind added to `BALL_GLYPH_KINDS`, or moved in
 *  or out of `PLURALISED_BALL_KINDS`, moves the locale-parity expectation with
 *  it instead of leaving `match-centre-parity.test.ts` asserting yesterday's
 *  key list. */
export const BALL_LINE_KEYS: readonly string[] = BALL_GLYPH_KINDS.flatMap((kind) =>
  PLURALISED_BALL_KINDS.has(kind)
    ? [`matchCentre.ballLine.${kind}.one`, `matchCentre.ballLine.${kind}.other`]
    : [`matchCentre.ballLine.${kind}`],
);

function ballLines(over: OverLog, personOf: PersonOf, locale: string): MsgT[] {
  const bowlerName = over.bowler === null ? "" : personOf(over.bowler).name;
  let legalCount = 0;
  return over.balls.map((ball) => {
    const notation = `${over.number - 1}.${legalCount + 1}`;
    if (ball.kind !== "wide" && ball.kind !== "noball") legalCount += 1;
    const runs = ball.kind === "wicket" ? 0 : ball.runs;
    // `matchCentre.ballLine.*`, NOT `matchCentre.ball.*`. The latter prefix
    // belongs to the glyph-label family (`glyphs.tsx`: boundary/wicket/dot/
    // extras/run), and the two collided on `wicket` — a wicket delivery's
    // commentary line rendered the bare word "Wicket" with no over notation
    // and no bowler, beside neighbours reading "0.3 · Player A7 · Wide +1".
    // The dictionary coverage test could not see it: it asserts the key
    // EXISTS, and it did — as the glyph label.
    const base = `matchCentre.ballLine.${ball.kind}`;
    return {
      key: PLURALISED_BALL_KINDS.has(ball.kind) ? `${base}.${ballLineCategory(locale, runs)}` : base,
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

function buildOverLogView(over: OverLog, personOf: PersonOf, locale: string): CricketViewT["innings"][number]["overs"][number] {
  return {
    number: over.number,
    bowler: over.bowler === null ? null : personOf(over.bowler),
    glyphs: over.balls.map(ballGlyphString),
    runs: over.runs,
    wickets: over.wickets,
    scoreAfter: `${over.scoreAfter.runs}/${over.scoreAfter.wickets}`,
    lines: ballLines(over, personOf, locale),
  };
}

function buildInningsView(
  card: CricketInningsCard,
  sides: readonly [SideT, SideT],
  personOf: PersonOf,
  locale: string,
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
    overs: card.overs.map((over) => buildOverLogView(over, personOf, locale)),
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
        // Review round 1, Important #2 — THIS loop is the one place that
        // actually knows which innings (main or Super Over) `bestBatter` was
        // drawn from; carried straight off the engine's own
        // `CricketInningsCard.number`, never re-derived by identity search.
        innings: innings.number,
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
        innings: innings.number,
      });
    }
  }
  return out;
}

function buildCricketView(
  card: CricketScorecard,
  sides: readonly [SideT, SideT],
  personOf: PersonOf,
  locale: string,
): CricketViewT {
  return {
    band: card.band,
    toss:
      card.toss === null
        ? null
        : {
            key: "matchCentre.toss",
            params: { side: sideNameOf(sides, card.toss.wonBy), elected: card.toss.elected },
          },
    innings: card.innings.map((innings) => buildInningsView(innings, sides, personOf, locale)),
    live: buildLiveView(card, personOf),
    topPerformers: topPerformersOf(card, sides, personOf),
  };
}

// -------------------------------------------------------------- the result

/**
 * The decided-header `Msg` — `matchCentre.result.<kind>` (ruling: bare keys,
 * never `public.`-prefixed). `outcome.kind` (from `fixture.outcome`, the
 * fixture's own stored `MatchOutcome`) is the axis for WHICH of win / draw /
 * tie / no_result / forfeit this is — `card.result` alone cannot tell a tie
 * from a draw from a no-result (all three carry `winner:null, margin:null`).
 *
 * Fix round 1 (coordinator ruling): for a "win", the KEY comes from
 * `outcome.method` directly — never re-derived from the margin string — and
 * `margin` rides through as a param VERBATIM (never parsed into a number).
 * A method this mapper does not recognise (a future engine addition, or a
 * non-cricket sport's own method vocabulary) falls back to
 * `matchCentre.result.regulation` WITH the margin still attached — never a
 * silent drop of the figure the engine already gave a spectator.
 *
 * The WINNER prefers `card.result.winner` (contract notes: "never recompute"
 * — card.result is the cricket fold's own answer) and falls back to
 * `outcome.winner` only when there is no card (every non-cricket sport).
 */
/**
 * Sports that decide a shootout with SKATES/STICKS rather than penalty kicks.
 * "Won on penalties" is football's sentence; ice hockey and field hockey have a
 * shootout, and the engine already speaks that way (icehockey's own metrics are
 * "GWS goals" — game-winning shots). One shared, football-worded key was being
 * printed for every sport, which was invisible until the shootout sentence
 * started reaching the court card at all.
 */


function resultMsg(
  outcome: PublicFixture["outcome"],
  marginText: string | null,
  cardWinner: string | null,
  sides: readonly [SideT, SideT],
  sportKey: string,
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
      return { key: "matchCentre.result.forfeit", params: { winner: winnerName(cardWinner ?? outcome.winner) } };
    case "win": {
      const winner = winnerName(cardWinner ?? outcome.winner);
      const margin = marginText ?? "";
      const method = outcome.method;
      const kind: (typeof WIN_METHODS)[number] =
        method !== undefined && (WIN_METHODS as readonly string[]).includes(method)
          ? (method as (typeof WIN_METHODS)[number])
          : "regulation";
      // A shootout with no tally must NOT fall back to the generic win line:
      // "on penalties" is the one thing that distinguishes this method from
      // every other, and dropping it is the exact mistake `scoring-vocab.ts`'s
      // own `shootoutPlain` exists to prevent (F8, R3.5 review). Same rule,
      // second surface — a coarse or replayed summary carries no tally.
      if (kind === "shootout") {
        const skated = SHOOTOUT_IS_SKATED.has(sportKey);
        if (margin === "") {
          return {
            key: skated ? "matchCentre.result.shootoutHockeyPlain" : "matchCentre.result.shootoutPlain",
            params: { winner },
          };
        }
        return {
          key: skated ? "matchCentre.result.shootoutHockey" : "matchCentre.result.shootout",
          params: { winner, margin },
        };
      }
      return { key: `matchCentre.result.${kind}`, params: { winner, margin } };
    }
    default:
      return null;
  }
}

// -------------------------------------------------------------- the header

/** The wire status → header state ladder. EXPORTED (W2 Task 4) because the
 *  competition hub builds a header for every fixture in a competition and must
 *  not re-derive this — a second ladder is a second answer to "is this match in
 *  play", and the hub already carries two more views of the same fact
 *  (`HubMatch.bucket` and `header.live`). `competition-hub.ts`'s `hubLiveness`
 *  is the one place all three are computed, and it computes this one by calling
 *  here. Unchanged otherwise. */
export function statusOf(fixtureStatus: string): MatchCentreHeaderT["status"] {
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

/**
 * R11 fix round, C10 — the tennis court card carried the sets score
 * ("0 / 0") but dropped the LIVE games score of the set in progress; that
 * "0-0" showed up only in the Summary tab's per-set breakdown table below.
 * `subLines` is the schema's OWN pre-existing "beside the score" slot
 * (`match-centre-schema.ts`: `subLines: … // "(8.0)" | null`), never wired
 * up by `buildHeader` before this — populated here from the SAME
 * `setsView` the Summary tab's `SetScoreboard` already reads (`buildSets`,
 * `./timeline.ts`), never recomputed. Scoped to `kind: "sets"` (tennis,
 * volleyball, badminton, …) — a `"periods"` breakdown (football, hockey)
 * has no single "current set" to carry, and cricket's `detail` has no
 * `sets` array at all, so `setsView` is `null` for it and this returns
 * `[null, null]` unconditionally, same as before this fix. The open set is
 * the FIRST `closedMask` entry that is `false` — the engine's own record of
 * which column is in progress, never inferred from "the last one" (the same
 * reasoning `sets-tab.tsx`'s own note 3 already states for the Sets tab, and
 * the same scan its per-column loop runs). Re-review of this round caught the
 * first draft asserting that reasoning in the comment while reading
 * `closedMask[length - 1]` in the code: today the two coincide, because a set
 * must close before the next one opens, but that is a sport rule this
 * function had no business assuming on the engine's behalf.
 */
function liveSubLines(setsView: SetsViewT | null): [string | null, string | null] {
  if (setsView === null || setsView.kind !== "sets") return [null, null];
  const open = setsView.closedMask.findIndex((closed) => closed === false);
  if (open < 0) return [null, null];
  const home = setsView.rows[0][open];
  const away = setsView.rows[1][open];
  return [home === null || home === undefined ? null : `(${home})`, away === null || away === undefined ? null : `(${away})`];
}

/**
 * M1 k2 — the one place a fixture's start time becomes text. Both the court
 * card's "Starts {time}" sentence and `header.startTime` (the fixture page's
 * subheading) read this, so a spectator can never be shown two different
 * clocks for one kick-off.
 *
 * `timeZone: venueTz` is not optional: a start time means the time AT THE
 * VENUE, and the fixture page's own `new Date(iso).toLocaleString(locale, …)`
 * had no zone, so it printed whatever zone the rendering server happened to be
 * in. `dateStyle: "medium"` + `timeStyle: "short"` is the court card's
 * existing format, kept as the one the page now adopts rather than the other
 * way round — the card is the surface that already updates live.
 *
 * And `en` is written `en-GB`. Bare "en" is a US format to `Intl`, so an
 * English org's card read "Jul 20, 2026, 2:30 PM" on a public site whose every
 * other date is "20 Jul 2026, 14:30" — `lib/format.ts:10` pins `en-GB` as THE
 * display locale for this repo, and `intlLocaleFor` (`lib/public-date-locale.ts`,
 * shared with `schedule.tsx` and the org home) and
 * `ai-instruction-describe.ts`'s `DEFAULT_LOCALE` apply exactly this
 * `"en" → "en-GB"` rule for the same reason. Every other locale tag is used as
 * given; only bare "en" is ambiguous.
 */
export function startTimeText(
  scheduledAt: string | null,
  locale: string,
  venueTz: string,
): string | null {
  if (scheduledAt === null) return null;
  return new Intl.DateTimeFormat(intlLocaleFor(locale), {
    timeZone: venueTz,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(scheduledAt));
}

function buildHeader(
  fixture: PublicFixture,
  sides: [SideT, SideT],
  card: CricketScorecard | null,
  setsView: SetsViewT | null,
  venueTz: string,
  locale: string,
  now: Date,
  // Only the shootout sentence needs it: the word for a shootout is the
  // SPORT's, not one shared football phrase (see `SHOOTOUT_IS_SKATED`).
  sportKey: string,
  // The meta line's two non-fixture parts. Both already reach this module for
  // the Info tab's rows (`MatchCentreInput.formatLabel`, `.stage`) — the header
  // simply never carried them, so the board's
  // "8-over match · Round 1 · Garon Park" had no source.
  formatLabel: string | null,
  stage: { name: string; roundLabel: string | null } | null,
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

  // M1 k2 — ONE formatted start time per document, computed once here and used
  // BOTH for the court card's "Starts …" sentence below and for
  // `header.startTime`, which is what the page's subheading line now renders.
  // Two call sites with the same options would have been two things to keep in
  // step; the live read found them already out of step (the page formatted
  // with no `timeZone` at all, so it printed the server's zone, and with a
  // different date/time style).
  const startTime = startTimeText(fixture.scheduled_at, locale, venueTz);

  let statusLine: MsgT | null = null;
  let rateLine: string | null = null;

  if (status === "scheduled") {
    if (startTime !== null) {
      const when = startTime;
      // `time`, not `when`: the param name is the DICTIONARY's placeholder
      // name. All four locales write "Starts {time}" / "Begint {time}", and
      // `t()` prints an unsupplied brace verbatim (`lib/i18n-runtime.ts:24`) —
      // so `{ when }` shipped the literal text "Starts {time}" to every
      // spectator looking at an upcoming match, on main since 544697031 (W1).
      // `match-centre-msg-params.test.ts` now walks every Msg this builder can
      // emit and renders it against all four dictionaries, which is the only
      // comparison that can see this (the existing dictionary gate compares
      // locales with each other, and they agreed).
      statusLine = { key: "matchCentre.status.startsAt", params: { time: when } };
    }
  } else if (status === "decided") {
    // The margin has TWO sources, because the two win vocabularies do. Cricket's
    // comes off its own scorecard (`card.result.margin`, "by 23 runs"); a
    // shootout's tally is not on any card — it is in the kernel summary's
    // `detail.shootout`, which is where `LiveScoreBody` already reads it via
    // the SAME shared `shootoutScoreFromDetail`, and the en dash is that
    // function's own house style ("3–0"), matched here so one match cannot
    // read two ways on two surfaces.
    // Selected BY METHOD, not by whichever source happens to be non-null. A
    // first cut asked the cricket card first and fell back to the tally, which
    // reads fine until both exist: a cricket ledger's "by 24 runs" then masks
    // the shootout score for a fixture decided on penalties. The two margins
    // belong to two different win vocabularies, so the method picks the source.
    const shootout = shootoutScoreFromDetail(fixture.summary?.detail);
    const marginText =
      fixture.outcome?.method === "shootout"
        ? shootout !== null
          ? `${shootout.home}–${shootout.away}`
          : null
        : typeof card?.result?.margin === "string"
          ? card.result.margin
          : null;
    const cardWinner = card?.result?.winner ?? null;
    statusLine = resultMsg(fixture.outcome, marginText, cardWinner, sides, sportKey);
  } else if (status === "other") {
    statusLine = { key: `matchCentre.status.${fixture.status}` };
  } else if (status === "in_play" && card?.live) {
    const live = card.live;
    if (live.target !== null && live.needRuns !== null && live.ballsLeft !== null) {
      // `needFrom`, not `need` — the SECOND mismatch M1's class guard found.
      // This branch only runs with `ballsLeft` known, and it has always passed
      // that number as a param; `matchCentre.chase.need` is "{side} need
      // {runs} to win" in all four locales and simply drops it, so the balls
      // remaining never reached a reader. `matchCentre.chase.needFrom` is the
      // translated sibling that names `{balls}` ("{side} need {runs} from
      // {balls} balls"), it is the sentence `match-centre-schema.ts:21`'s own
      // doc comment documents ("Queens need 34 from 21"), and it is the same
      // pair the overlay already chooses between correctly
      // (`lib/overlay-model.ts:703-704`, `overlay.chase.need` vs
      // `overlay.chase.needBalls`).
      statusLine = {
        key: "matchCentre.chase.needFrom",
        params: { side: sideNameOf(sides, live.battingSide), runs: live.needRuns, balls: live.ballsLeft },
      };
    }
    rateLine = rateLineOf(live);
  }

  // Both read through the SHARED readers in `lib/public-site.ts` — the same
  // ones `live-score.tsx` uses — rather than reaching into `summary.detail`
  // again here. Gated on in_play: a decided match has no current phase and
  // nobody is short-handed, and the engine leaves both stale in `detail`
  // after the final whistle (`live-score.tsx:122` gates `matchStrength` the
  // same way, for the same reason).
  const inPlay = status === "in_play";
  const phase = inPlay ? matchPhase(fixture.summary) : null;
  const strength = inPlay ? matchStrength(fixture.summary) : null;

  // Cricket's "where are we": the live over, for the pill. Read off the SAME
  // `card.live` the chase sentence and the rate line above already use, so the
  // pill cannot disagree with the sentence beneath it. Gated on in_play with
  // everything else on this row — a finished match is not anywhere.
  // The over comes off the CURRENT innings card, not `card.live` (which has no
  // overs field of its own) — the last innings is the one being played, super
  // over included. Same value the score line already shows, so the pill cannot
  // disagree with the score beneath it.
  const liveOvers = inPlay ? (card?.innings.at(-1)?.total.overs ?? null) : null;

  // Every other sport's "where are we" is the division of play still OPEN, and
  // `setsView` already knows which one that is — `closedMask` is the same field
  // the Sets/Periods tab highlights the live column with, so the pill and that
  // tab cannot disagree. Deriving it from the VIEW rather than from the sport
  // means football, tennis, badminton and volleyball are all one rule instead
  // of four branches, and the labels already exist: `columnLabels` carries the
  // engine's phase token ("H2" → `term.H2` → "2nd half") and, where a sport has
  // no phase token, the unit and the ordinal do it ("Set 3").
  //
  // Measured before this: a LIVE football match centre's pill said "LIVE" and
  // nothing else, on the one sport where the question has a clock answer.
  const openColumn = setsView === null ? -1 : setsView.closedMask.findIndex((closed) => !closed);
  const phaseNote: MsgT | null = (() => {
    if (!inPlay || setsView === null || openColumn < 0) return null;
    const label = setsView.columnLabels?.[openColumn];
    if (label !== undefined && label !== "") return { key: `term.${label}` };
    if (setsView.unit !== undefined) {
      return { key: `matchCentre.col.${setsView.unit}`, params: { n: openColumn + 1 } };
    }
    return null;
  })();

  const pillNote: MsgT | null =
    liveOvers !== null
      ? { key: "matchCentre.oversShort", params: { overs: liveOvers } }
      : phaseNote;

  // The match's one-line identity. Every part is an already-resolved string —
  // the format label arrives pre-resolved from the caller, the round label from
  // the stage, and a venue is a proper noun — so this joins rather than
  // translates. `venueParts` mirrors `buildInfoView`'s venue row exactly
  // (`venue_name` then `court_name`) rather than re-deciding what a venue is.
  const venueParts = [fixture.venue_name, fixture.court_name].filter(
    (v): v is string => v !== null,
  );
  const metaParts = [
    formatLabel,
    stage?.roundLabel ?? null,
    venueParts.length > 0 ? venueParts.join(" · ") : null,
  ].filter((v): v is string => v !== null && v !== "");
  // Null, never a string of bare separators: a fixture with none of the three
  // gets no line at all rather than an empty one.
  const metaLine = metaParts.length > 0 ? metaParts.join(" · ") : null;

  return {
    live: status === "in_play",
    status,
    sides,
    scoreLines,
    subLines: liveSubLines(setsView),
    battingIndex,
    statusLine,
    rateLine,
    phase,
    strength,
    pillNote,
    metaLine,
    updatedAt: now.toISOString(),
  };
}

// ---------------------------------------------------------- fidelity band

/**
 * Fix round 2 (coordinator ruling, re-review of fix round 1) — the fidelity
 * band is a UNIVERSAL `SportModule` concept, not a cricket one: every module
 * declares `padSpec(cfg).fidelity` (e.g. `football.ts:2375`), and the owner
 * ruling names the band line as one of the six standard Info-tab rows for
 * EVERY sport. This is the ONE code path (round 1 had cricket reading
 * `card.band` — the cricket fold's own copy of the identical computation —
 * while no equivalent existed for any other sport; the ruling asked for one
 * shared derivation, not two that happen to agree for cricket).
 *
 * `null` ONLY for a genuinely empty ledger (nothing was scored — the row is
 * omitted, never a blank one). A "kernel-only" ledger (events exist, but
 * none of their types appear in the module's own fidelity map — e.g. only
 * `core.start`) still returns `0`, which IS a real answer (the coarsest
 * band), not an absence — `band` starts at `0` and only ever rises, so a
 * ledger with no recognised event types simply never rises off it.
 */
function effectiveBand(
  events: readonly EventEnvelope[],
  sportModule: AnySportModule,
  cfg: unknown,
): FidelityBand | null {
  if (events.length === 0) return null;
  const bands = sportModule.padSpec?.(cfg)?.fidelity ?? {};
  let band: FidelityBand = 0;
  for (const event of events) {
    const eventBand = bands[event.type];
    if (eventBand !== undefined && eventBand > band) band = eventBand;
  }
  return band;
}

// ---------------------------------------------------------------- the info

/**
 * Fix round 1 (Important #3) — row order and set FIXED by `info-tab.tsx:8-13`'s
 * own "not derivable from reading this file" documented contract: toss ·
 * format · venue · start · stage · scored-as. Each row is OMITTED (never
 * rendered blank) when its own fact is absent — toss only exists for cricket
 * (`card !== null`); format only when the caller supplies one; scored-as
 * (fix round 2) only when `effectiveBand` found a non-empty ledger, for
 * every sport.
 */
function buildInfoView(
  fixture: PublicFixture,
  card: CricketScorecard | null,
  sides: readonly [SideT, SideT],
  formatLabel: string | null,
  stage: { name: string; roundLabel: string | null } | null,
  hrefs: { division: string; competition: string; calendar: string | null },
  venueTz: string,
  locale: string,
  band: FidelityBand | null,
): InfoViewT {
  const rows: InfoViewT["rows"] = [];

  // 1. Toss — cricket only, from `card.toss` (never re-derived; the same
  //    fact `CricketView.toss` already carries, just under its own Info-row
  //    key pair so the two rows can be labelled independently).
  if (card?.toss) {
    rows.push({
      label: { key: "matchCentre.info.toss" },
      value: {
        key: "matchCentre.info.tossValue",
        params: { side: sideNameOf(sides, card.toss.wonBy), elected: card.toss.elected },
      },
    });
  }

  // 2. Format — the caller's own pre-resolved label (this module names no
  //    division variant/format of its own); omitted when the caller has none.
  if (formatLabel !== null) {
    rows.push({
      label: { key: "matchCentre.info.format" },
      value: { key: "matchCentre.info.formatValue", params: { format: formatLabel } },
    });
  }

  // 3. Venue.
  const venueParts = [fixture.venue_name, fixture.court_name].filter((s): s is string => s !== null);
  if (venueParts.length > 0) {
    rows.push({
      label: { key: "matchCentre.info.venue" },
      value: { key: "matchCentre.info.venueValue", params: { venue: venueParts.join(" · ") } },
    });
  }

  // 4. Start. `intlLocaleFor`, like `startTimeText` above: English public dates
  // are day-month (owner ruling 2026-09-16), and bare "en" is US to `Intl`.
  if (fixture.scheduled_at !== null) {
    const when = new Intl.DateTimeFormat(intlLocaleFor(locale), {
      timeZone: venueTz,
      dateStyle: "full",
      timeStyle: "short",
    }).format(new Date(fixture.scheduled_at));
    rows.push({
      label: { key: "matchCentre.info.start" },
      value: { key: "matchCentre.info.startValue", params: { when } },
    });
  }

  // 5. Stage.
  if (stage !== null) {
    rows.push({
      label: { key: "matchCentre.info.stage" },
      value:
        stage.roundLabel === null
          ? { key: "matchCentre.info.stageValue", params: { stage: stage.name } }
          : { key: "matchCentre.info.stageRoundValue", params: { stage: stage.name, round: stage.roundLabel } },
    });
  }

  // 6. Scored as — universal (fix round 2 ruling), from `effectiveBand`
  //    above. Omitted only when the ledger is genuinely empty. Closed 0-3
  //    scale (standing rule) — four possible keys.
  if (band !== null) {
    rows.push({
      label: { key: "matchCentre.info.scoredAs" },
      value: { key: `matchCentre.band.${band}` },
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
  const { fixture, sportKey, cfg, events, lineups, sides, venueTz, locale, now, hrefs, stage, moduleVersion, formatLabel } =
    input;
  const personOf = makePersonOf(lineups);
  const lineupPair = toLineupPair(lineups, sides);

  let cricketView: CricketViewT | null = null;
  let card: CricketScorecard | null = null;
  let timelineLines: TimelineLineT[] | null = null;
  let setsView: SetsViewT | null = null;
  let derivedComplete = true;
  let band: FidelityBand | null = null;
  const extraTabs: MatchCentreTabIdT[] = [];

  if (sportKey === "cricket") {
    // ONE guard, not two. The first cut of this fix had a `safeParse` AND a
    // try/catch, and a mutant proved the pair worthless: replacing the
    // safeParse with "accept anything" killed ZERO tests, because a rejected
    // config and a thrown fold produce byte-identical output — each guard hid
    // the other's removal, so neither was actually tested. One `try` around
    // the whole derivation is the honest shape, and a mutant that removes it
    // reds immediately.
    //
    // Three throw sites live in here, and all three were 500s on an ANONYMOUS
    // page before this:
    //   - `configSchema.parse` on a config the schema rejects. The safeParse
    //     one frame upstream (`match-centre-load.ts`) falls back to the RAW
    //     value, so this line re-threw on exactly what that fallback produced.
    //   - `deriveCricketScorecard`, whose reducer's `invalid()`/`wrongPhase()`
    //     throw regardless of the read path's `strict: false`. One unfoldable
    //     event took the whole response down for cricket, where every other
    //     sport degrades and reports it.
    //   - `effectiveBand` -> `cricket.padSpec(cfg)`, which reaches into the
    //     config and throws on the same bad input. Found by the degrade test
    //     itself after the first two were fixed — the same 500, one line
    //     further down.
    //
    // Degrading matches `buildTimeline` exactly: keep the header, the sides
    // and every info row that does not depend on the fold; drop the derived
    // tabs; and SAY so through `derivedComplete`, so a fixture that LOST its
    // scorecard is distinguishable from one that never had one. A rejected
    // config leaves the band `null` — unknown, which omits the "scored as" row
    // rather than guessing a number.
    try {
      const parsedCfg = cricket.configSchema.parse(cfg);
      card = deriveCricketScorecard({ events, cfg: parsedCfg, lineups: lineupPair });
      cricketView = buildCricketView(card, sides, personOf, locale);
      // Fix round 2 — the SAME shared `effectiveBand`, never `card.band` (the
      // fold's own copy of the identical computation): one code path.
      //
      // The MODULE is resolved the same way the non-cricket branch resolves
      // its own, honouring the division's pinned `moduleVersion`. This branch
      // used the imported `cricket` SINGLETON, so a division pinned to an
      // older module was read with the latest fold's fidelity map — a silent
      // disagreement between what the organiser's pad offered and what the
      // spectator page said the match was scored at.
      //
      // `deriveCricketScorecard` above still takes the singleton: it is the
      // cricket fold itself, not a versioned capability, which is exactly the
      // asymmetry the findings doc records as the case for lifting the fold
      // onto `SportModule`.
      const bandModule = moduleVersion !== null ? resolveModule(sportKey, moduleVersion) : resolveLatestModule(sportKey);
      band = effectiveBand(events, bandModule, parsedCfg);
    } catch (err) {
      card = null;
      cricketView = null;
      band = null;
      derivedComplete = false;
      log.warn(
        { sportKey, fixtureId: fixture.id, err: err instanceof Error ? err.message : String(err) },
        "match-centre: cricket config or fold refused; scorecard, commentary and the scored-as row are absent",
      );
    }
    if (card !== null && card.innings.some((innings) => innings.batting.length > 0)) extraTabs.push("scorecard");
    if (card !== null && card.innings.some((innings) => innings.overs.length > 0)) extraTabs.push("commentary");
  } else {
    // Fix round 1 (Important #2) — a single division's own read resolves its
    // PINNED module version, never the latest (`engine-db/registry.ts:31-36`'s
    // own doc comment). `null` is the one exception: a caller with no version
    // to pin at all (see `MatchCentreInput.moduleVersion`'s own doc).
    const sportModule =
      moduleVersion !== null ? resolveModule(sportKey, moduleVersion) : resolveLatestModule(sportKey);
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
    band = effectiveBand(events, sportModule, cfg);
  }

  const header = buildHeader(
    fixture,
    sides,
    card,
    setsView,
    venueTz,
    locale,
    now,
    sportKey,
    input.formatLabel,
    input.stage,
  );
  const info = buildInfoView(fixture, card, sides, formatLabel, stage, hrefs, venueTz, locale, band);

  return {
    fixtureId: fixture.id,
    sportKey,
    header,
    // M1 k2 — the fixture page's subheading line, carried on the live document
    // so it moves with a reschedule instead of freezing at page load. The same
    // `startTimeText` fills the court card's "Starts …" sentence, so the two
    // cannot read differently; `venue_name`/`court_name` are the derived
    // join-backed names, never the frozen `venue`/`court_label` columns.
    startTime: startTimeText(fixture.scheduled_at, locale, venueTz),
    venueName: fixture.venue_name,
    courtName: fixture.court_name,
    tabs: ["summary", ...extraTabs, "info"],
    cricket: cricketView,
    timeline: timelineLines,
    sets: setsView,
    info,
    derivedComplete,
  };
}
