// Per-stage match rules — the public FORMAT LINE of a fixture or a stage whose
// rules differ from its division's (brief 2026-09-24; design 2026-09-17 §D3/T7).
//
// THE DEFECT. A Swiss stage played Best-of-1 to 15 (cap 21) inside a "Short
// (11 points)" division, and the public match page said "Short (11 points)":
// both loaders labelled the fixture with `variantLabel(division.variant_key)`,
// which never sees the stage overlay, while scoring (correctly) used it. The
// hub's `formatLine` had the same blindness one level up.
//
// PURE, like its sibling `describe-format.ts`: no `sql`, no `server-only`, no
// dictionary. A line is a list of `Msg` CLAUSES (dictionary key + params),
// because the hub carries the line as data and resolves it client-side against
// the PUBLIC dictionary, and the match-centre loader resolves the SAME clauses
// in the org's locale — one describer, so the two surfaces can never word one
// format two ways. Every surface joins the resolved clauses with `rulesLineText`
// (`lib/rules-line.ts`). The keys live in `public.json`, beside
// `format.sets.bestOf`, which the set kernel reuses for its "Best of N" head
// (tennis heads with its own `format.rules.tennis.bestOfSets`, "Best of N sets").
//
// THE MODULE IS PASSED IN, for `describe-format.ts`'s reason: a division pins
// its module version, and every read path honours that pin.
//
// EVERY SPORT (W2c Task 16, spec item 15). The line used to answer for four sports
// (`STAGE_RULES_SPORTS`) and null for the rest, so seven sports' public pages kept a preset
// name that is false for a stage that changed anything. Now there is one describer per RULE
// FAMILY, picked from the keys the module DECLARES (`ruleKeys`) - never from its sport key -
// so a twelfth sport that reuses a family is described the day it lands, and one that fits
// none answers null (its caller keeps the preset name) rather than a guess. A line is the
// format (the family's describer), then how a tied match ENDS (`describeDeciders`), then an
// abandon policy the stage changed (`describeAbandon`).
import { forbidsLevelResult, type StageKind } from "@seazn/engine/core";
import { deciderKeysFor, stageKeysFor, type AnySportModule } from "@seazn/engine/sport";
import { effectiveRungs, type TiebreakRung } from "@seazn/engine/sports/boardgame";
import { configKeysFor } from "@/lib/match-rules";
import { GAME_UNIT_SPORTS } from "@/lib/public-site";
import type { MsgT } from "./match-centre-schema";

/** A format line: one or more clauses, resolved and joined with ", ". */
export type RulesLineT = MsgT[];

/** A positive, finite number — or nothing. `Number("")` is `0` in this
 *  codebase and "0 points" is a confident lie, so zero, NaN, Infinity and every
 *  non-number read as ABSENT rather than as a value. */
function positive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** A plain object, or nothing. */
function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * The one-unit noun per sport family, keyed by the SAME authority the match
 * centre's per-set scoreboard uses (`GAME_UNIT_SPORTS`): badminton and table
 * tennis play games, volleyball plays sets. Each shape is one whole sentence
 * key, never fragments joined here, so a locale can order its words.
 */
const ONE_UNIT = {
  game: {
    bare: "format.rules.oneGame",
    points: "format.rules.oneGamePoints",
    pointsCap: "format.rules.oneGamePointsCap",
  },
  set: {
    bare: "format.rules.oneSet",
    points: "format.rules.oneSetPoints",
    pointsCap: "format.rules.oneSetPointsCap",
  },
} as const;

/**
 * The set kernel (badminton, table tennis, volleyball) as ONE clause:
 * `1 game, 15 points (cap 21)`, `Best of 3, 11 points (cap 15)`,
 * `Best of 5, 25 points, decider 15`.
 *
 *  - a ONE-unit match is its own decider: the kernel plays set index bestOf−1
 *    to `finalSetTo` (`setTarget`, engine `setbased/kernel.ts`), so a best-of-1
 *    states `finalSetTo`, falling back to `setTo`;
 *  - a best-of-N states `setTo`, plus a decider clause when `finalSetTo` is
 *    present and plays to a DIFFERENT target (volleyball's 25 / 15);
 *  - the cap clause only when the cap is ABOVE the target — a null cap is
 *    uncapped, and a cap equal to the target extends nothing.
 *
 * `winBy` has no words: a stage that changes only it gets the same line as its
 * division would — true, if vague, and never the division's preset NAME.
 */
function describeSetKernel(sportKey: string, c: Record<string, unknown>, bestOf: number): MsgT {
  const setTo = positive(c.setTo);
  const finalSetTo = positive(c.finalSetTo);
  const capRaw = positive(c.cap);
  const capAbove = (target: number) => (capRaw !== undefined && capRaw > target ? capRaw : undefined);

  if (bestOf === 1) {
    const keys = ONE_UNIT[GAME_UNIT_SPORTS.has(sportKey) ? "game" : "set"];
    const points = finalSetTo ?? setTo;
    if (points === undefined) return { key: keys.bare };
    const cap = capAbove(points);
    if (cap === undefined) return { key: keys.points, params: { points } };
    return { key: keys.pointsCap, params: { points, cap } };
  }
  if (setTo === undefined) return { key: "format.sets.bestOf", params: { n: bestOf } };
  const points = setTo;
  const cap = capAbove(points);
  const decider = finalSetTo !== undefined && finalSetTo !== points ? finalSetTo : undefined;
  if (decider === undefined) {
    if (cap === undefined) return { key: "format.rules.bestOfPoints", params: { n: bestOf, points } };
    return { key: "format.rules.bestOfPointsCap", params: { n: bestOf, points, cap } };
  }
  if (cap === undefined) return { key: "format.rules.bestOfPointsDecider", params: { n: bestOf, points, decider } };
  return { key: "format.rules.bestOfPointsCapDecider", params: { n: bestOf, points, cap, decider } };
}

/**
 * The nested kernel (tennis) as clauses, every number read off the config —
 * the same fields the per-stage editor writes (`SPORT_RULES.tennis`: set type,
 * deciding set, no-ad, tie-break margin):
 * `Best of 3 sets, first to 6 games` (tour),
 * `Best of 3 sets, first to 4 games, no-ad scoring` (Fast4),
 * `Best of 3 sets, first to 6 games, deciding match tie-break to 10, no-ad
 * scoring` (doubles), `Best of 5 sets, first to 6 games, final-set tie-break to
 * 10` (grand slam). The head is tennis's OWN key (owner copy 2026-09-25): the
 * shared `format.sets.bestOf` also heads the set kernel and the hub division's
 * `formatLine`, where "sets" would be wrong.
 *
 *  - the set shape: games per set, and ADVANTAGE sets when `tiebreakAt` is null
 *    (no tie-break at all). A best-of-1 folds it into its head ("1 set, first
 *    to 6 games");
 *  - the deciding set, when it is not "same": a match tie-break REPLACES the
 *    set (so a best-of-1 with one is "1 match tie-break to 10"), a final-set
 *    tie-break extends it — only over tie-break sets, since advantage sets
 *    play none, decider included;
 *  - no-ad games and sudden-death tie-breaks only when ON — the standard
 *    (advantage games, win by two) goes unsaid — and sudden death only when
 *    some tie-break is actually played.
 */
function describeNested(c: Record<string, unknown>, bestOf: number): RulesLineT {
  const set = record(c.set);
  const games = positive(set?.gamesTo);
  const advantage = set !== undefined && set.tiebreakAt === null;
  const tiebreakAt = typeof set?.tiebreakAt === "number" ? set.tiebreakAt : undefined;
  // "First to N games" only where every set really ends on N (engine
  // `setWinner`: reach `gamesTo` with a `winBy` lead, or win the tie-break at
  // `tiebreakAt`-all). Fast4 (4 games, tie-break at 3-3) always ends 4-x; a
  // Tour set (6 games, tie-break at 6-6) can end 7-5 or 7-6, so it is named by
  // its shape instead — "first to 6" would be false.
  const winBy = positive(set?.winBy) ?? 2;
  const exact =
    games !== undefined &&
    (winBy === 1
      ? tiebreakAt === undefined || tiebreakAt >= games - 1
      : tiebreakAt === games - 1);
  const finalSet = record(c.finalSet);
  const matchTiebreak = positive(finalSet?.matchTiebreakTo);
  const finalTiebreak = positive(finalSet?.tiebreakTo);

  if (bestOf === 1 && matchTiebreak !== undefined) {
    return [{ key: "format.rules.tennis.oneMatchTiebreak", params: { n: matchTiebreak } }];
  }
  const out: RulesLineT = [];
  if (bestOf === 1) {
    if (games === undefined) out.push({ key: "format.rules.oneSet" });
    else if (exact) out.push({ key: "format.rules.tennis.oneSetTo", params: { games } });
    else if (tiebreakAt === undefined)
      out.push({ key: "format.rules.tennis.oneGameSetAdvantage", params: { games } });
    else out.push({ key: "format.rules.tennis.oneGameSetTiebreak", params: { games, at: tiebreakAt } });
  } else {
    out.push({ key: "format.rules.tennis.bestOfSets", params: { n: bestOf } });
    if (games === undefined) {
      // nothing more to say about the sets
    } else if (exact) out.push({ key: "format.rules.tennis.setsTo", params: { games } });
    else if (tiebreakAt === undefined)
      out.push({ key: "format.rules.tennis.gameSetsAdvantage", params: { games } });
    else out.push({ key: "format.rules.tennis.gameSetsTiebreak", params: { games, at: tiebreakAt } });
  }
  if (matchTiebreak !== undefined) {
    out.push({ key: "format.rules.tennis.matchTiebreak", params: { n: matchTiebreak } });
  } else if (finalTiebreak !== undefined && !advantage) {
    // Over advantage sets the decider keeps `tiebreakAt: null` (engine
    // `rulesFor`), so its tie-break target is never played — saying it would
    // be false.
    out.push({ key: "format.rules.tennis.finalSetTiebreak", params: { n: finalTiebreak } });
  }
  if (record(c.game)?.noAd === true) out.push({ key: "format.rules.tennis.noAd" });
  // The tie-break margin only means something when a tie-break is played: in
  // tie-break sets, or the match tie-break (which the kernel plays to it too).
  const playsTiebreak = !advantage || matchTiebreak !== undefined;
  if (record(c.tiebreak)?.winBy === 1 && playsTiebreak) {
    out.push({ key: "format.rules.tennis.suddenDeathTiebreaks" });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The other families (W2c Task 16, spec item 15). Each reads the PARSED config's own numbers and says only what it
// declares: a missing or non-positive number says nothing about itself (`positive`). A clause is written to sit
// anywhere in a line, so it begins lowercase; `rulesLineText` capitalises the sentence's first letter.
// ---------------------------------------------------------------------------

/** The period sports (football, ice hockey, hockey): how many periods and how long, from the declared count -
 *  football's `halves` x `halfMinutes`, the others' `periods.count` x `periods.minutes`. Two, three and four periods
 *  have their own word (halves, periods, quarters - the three the shipped variants play); any other count is "n × m min",
 *  never a wrong noun. */
function describePeriods(c: Record<string, unknown>): RulesLineT | null {
  const periods = record(c.periods);
  const count = positive(periods?.count) ?? positive(c.halves);
  const minutes = positive(periods?.minutes) ?? positive(c.halfMinutes);
  if (count === undefined || minutes === undefined) return null;
  if (count === 2) return [{ key: "format.rules.period.halves", params: { minutes } }];
  if (count === 3) return [{ key: "format.rules.period.thirds", params: { minutes } }];
  if (count === 4) return [{ key: "format.rules.period.quarters", params: { minutes } }];
  return [{ key: "format.rules.period.count", params: { count, minutes } }];
}

/** The over length a config plays when it says nothing about it: the module's own schema default (cricket's six balls),
 *  read by parsing the config WITHOUT its `ballsPerOver`. Never typed here: a sport that changes its standard over moves
 *  this with it. Undefined when the schema refuses the stripped config (then no over is called standard). */
function standardOverLength(module_: AnySportModule, c: Record<string, unknown>): number | undefined {
  const stripped = Object.fromEntries(Object.entries(c).filter(([key]) => key !== "ballsPerOver"));
  const parsed = module_.configSchema.safeParse(stripped);
  return parsed.success ? positive((parsed.data as Record<string, unknown>).ballsPerOver) : undefined;
}

/** Cricket: the overs a side bats (balls / balls per over), the innings a side where it is not one (a Test has no
 *  overs - its innings are the format), and a bowler's cap. "Overs" is said only where an over is the standard length:
 *  the Hundred's five-ball sets make 100 balls "20 overs", which reads as a T20, so a non-standard over (and a bowler's
 *  cap in it) is said in BALLS, as are balls that do not make whole overs - never "16.6666 overs". */
function describeInnings(module_: AnySportModule, c: Record<string, unknown>): RulesLineT | null {
  const balls = positive(c.ballsPerInnings);
  const perOver = positive(c.ballsPerOver);
  const innings = positive(c.inningsPerSide);
  const standardOver = perOver !== undefined && perOver === standardOverLength(module_, c);
  const out: RulesLineT = [];
  if (balls !== undefined) {
    if (standardOver && balls % perOver === 0) out.push({ key: "format.rules.cricket.oversASide", params: { overs: balls / perOver } });
    else out.push({ key: "format.rules.cricket.ballsASide", params: { balls } });
    if (innings !== undefined && innings > 1) out.push({ key: "format.rules.cricket.inningsASide", params: { n: innings } });
  } else if (innings !== undefined) {
    out.push({ key: "format.rules.cricket.inningsASide", params: { n: innings } });
  }
  const bowler = positive(c.maxOversPerBowler);
  if (bowler !== undefined) {
    if (perOver !== undefined && !standardOver) out.push({ key: "format.rules.cricket.maxBallsBowler", params: { balls: bowler * perOver } });
    else out.push({ key: "format.rules.cricket.maxOversBowler", params: { overs: bowler } });
  }
  return out.length > 0 ? out : null;
}

/** Carrom: best of N games, each to its points, at most so many boards - the three match-scoped keys, one clause each
 *  so a missing one is simply not said. A best-of-1 is "1 game" (the shared one-game key). */
function describeBoards(c: Record<string, unknown>): RulesLineT | null {
  const bestOf = positive(c.bestOf);
  const points = positive(c.gameTo);
  const boards = positive(c.maxBoards);
  const out: RulesLineT = [];
  if (bestOf === 1) out.push({ key: "format.rules.oneGame" });
  else if (bestOf !== undefined) out.push({ key: "format.rules.boards.bestOf", params: { n: bestOf } });
  if (points !== undefined) out.push({ key: "format.rules.boards.gameTo", params: { points } });
  if (boards !== undefined) out.push({ key: "format.rules.boards.maxBoards", params: { boards } });
  return out.length > 0 ? out : null;
}

/** A minutes figure for a clock the engine stores in SECONDS: 5400 s is "90", 90 s is "1.5", two decimals at most. */
const minutesOf = (seconds: number): number => Math.round((seconds / 60) * 100) / 100;

/** Chess: the time-control family (`variant`, one of the module's own variants), then the clock only when the stage sets
 *  one - "90 min + 30 s" with an increment, "10 min each" without, "5 s delay" for a delay. A zero increment or delay is
 *  none (`positive`): "+ 0 s" is not a time control. */
function describeBoardGame(module_: AnySportModule, c: Record<string, unknown>): RulesLineT | null {
  const out: RulesLineT = [];
  const variant = c.variant;
  if (typeof variant === "string" && Object.hasOwn(module_.variants, variant)) out.push({ key: `format.rules.board.${variant}` });
  const clock = record(c.clock);
  const base = positive(clock?.base);
  if (base !== undefined) {
    const increment = positive(clock?.increment);
    if (increment !== undefined) out.push({ key: "format.rules.board.clockIncrement", params: { minutes: minutesOf(base), increment } });
    else out.push({ key: "format.rules.board.clockEach", params: { minutes: minutesOf(base) } });
    const delay = positive(clock?.delay);
    if (delay !== undefined) out.push({ key: "format.rules.board.delay", params: { seconds: delay } });
  }
  return out.length > 0 ? out : null;
}

/** The result-entry sport (generic): what the scorer enters at the end, and whether the match may end level. */
function describeScore(c: Record<string, unknown>): RulesLineT | null {
  const head = c.resultMode === "win_loss" ? "format.rules.score.winLoss" : c.resultMode === "score" ? "format.rules.score.score" : null;
  if (head === null) return null;
  return c.allowDraws === true ? [{ key: head }, { key: "format.rules.score.draws" }] : [{ key: head }];
}

// ---------------------------------------------------------------------------
// The family table: which describer answers for which family (a strategy table, not an if/else per sport).
// ---------------------------------------------------------------------------

/** The seven rule families of the eleven shipped sports. */
export type RuleFamily = "setbased" | "nested" | "period" | "innings" | "boards" | "board" | "score";

/** The declared key that marks each family, first match wins: tennis nests its set (`set`), the set kernel declares its
 *  target (`setTo`), the period sports a period length (`halfMinutes` / `periods.minutes`), cricket its innings length,
 *  carrom its board cap, chess a clock, generic a result mode. Read from `ruleKeys`, which every module declares. */
const FAMILY_MARKERS: readonly (readonly [string, RuleFamily])[] = [
  ["set", "nested"],
  ["setTo", "setbased"],
  ["halfMinutes", "period"],
  ["periods.minutes", "period"],
  ["ballsPerInnings", "innings"],
  ["maxBoards", "boards"],
  ["clock", "board"],
  ["resultMode", "score"],
];

/** The family a module's declarations place it in, or null when they place it in none (including a module that
 *  declares no `ruleKeys` at all). Never read from the sport key: a renamed sport with football's keys is a period
 *  sport. */
export function ruleFamilyOf(module_: AnySportModule): RuleFamily | null {
  const declared = module_.ruleKeys;
  if (!declared) return null;
  for (const [key, family] of FAMILY_MARKERS) if (Object.hasOwn(declared, key)) return family;
  return null;
}

type Describer = (sportKey: string, module_: AnySportModule, c: Record<string, unknown>) => RulesLineT | null;

const DESCRIBERS: Record<RuleFamily, Describer> = {
  setbased: (sportKey, _m, c) => {
    const bestOf = positive(c.bestOf);
    return bestOf === undefined ? null : [describeSetKernel(sportKey, c, bestOf)];
  },
  nested: (_k, _m, c) => {
    const bestOf = positive(c.bestOf);
    return bestOf === undefined ? null : describeNested(c, bestOf);
  },
  period: (_k, _m, c) => describePeriods(c),
  innings: (_k, m, c) => describeInnings(m, c),
  boards: (_k, _m, c) => describeBoards(c),
  board: (_k, m, c) => describeBoardGame(m, c),
  score: (_k, _m, c) => describeScore(c),
};

/**
 * The EFFECTIVE match rules as a line of clauses (option A, brief 2026-09-24).
 *
 * Its clauses join with COMMAS, never " · ": the match header joins its own
 * facts with " · " (`match-centre.ts`'s metaLine), and a line using the same
 * joiner read as several separate facts ("1 game · 15 points · Court 2").
 *
 * Says only what the parsed config declares - a family whose key numbers are
 * missing answers null (nothing honest to say), and a missing or non-positive
 * number says nothing about itself. The family is the module's own
 * (`ruleFamilyOf`); a module that declares NO `ruleKeys` (a legacy pinned
 * version, a test double) falls back to the config's SHAPE, as before: a nested
 * `set` object is tennis's, otherwise the set kernel's flat
 * `setTo`/`finalSetTo`/`cap`. A module that declares keys no family reads
 * answers null and its caller keeps the preset name.
 */
export function describeMatchRules(
  sportKey: string,
  module_: AnySportModule | null | undefined,
  cfg: unknown,
): RulesLineT | null {
  if (!module_) return null;
  const parsed = module_.configSchema.safeParse(cfg);
  if (!parsed.success) return null;
  const c = parsed.data as Record<string, unknown>;
  const family = ruleFamilyOf(module_) ?? (module_.ruleKeys === undefined ? (record(c.set) !== undefined ? "nested" : "setbased") : null);
  if (family === null) return null;
  return DESCRIBERS[family](sportKey, module_, c);
}

// ---------------------------------------------------------------------------
// How a tied match ENDS (spec item 13): the deciders the stage plays.
// ---------------------------------------------------------------------------

/** One decider's words, read from the (bracket-resolved) config: null = the decider is OFF, a list = it is ON and
 *  these are its clauses (an ON decider whose numbers cannot be read says nothing, but is still ON - the line must not
 *  then claim "level matches wait for the organiser"). */
type DeciderDescriber = (c: Record<string, unknown>, module_: AnySportModule) => RulesLineT | null;

/** Whole `{enabled, halfMinutes}` / `{kind, minutes, ...}` / `{attempts, ...}` decider objects and the booleans, by the
 *  value shapes the engine's schemas declare. The keys are the engine's own decider keys (`deciderKeysFor`): the test
 *  that pins `DECIDER_DESCRIBED_KEYS` to them fails the day a sport declares one this table lacks. */
const DECIDERS: Record<string, DeciderDescriber> = {
  /** Football: two extra halves of the stage's length - `{enabled, halfMinutes}`. */
  extraTime: (c) => {
    const x = record(c.extraTime);
    if (x?.enabled !== true) return null;
    const n = positive(x.halfMinutes);
    return n === undefined ? [] : [{ key: "format.rules.decider.extraTime", params: { n } }];
  },
  /** Football's is a boolean with a kick count beside it (`shootoutAttempts`, or the engine's own declared default
   *  where the stage stores none); ice hockey's and hockey's is `{attempts, ...}` or null. */
  shootout: (c, m) => {
    if (c.shootout === true) {
      const n = positive(c.shootoutAttempts) ?? positive(m.ruleKeys?.shootoutAttempts?.whenAbsent);
      return n === undefined ? [] : [{ key: "format.rules.decider.penalties", params: { n } }];
    }
    const x = record(c.shootout);
    if (x === undefined) return null;
    const n = positive(x.attempts);
    return n === undefined ? [] : [{ key: "format.rules.decider.shootout", params: { n } }];
  },
  /** Ice hockey: an overtime of so many minutes, or null (off). */
  overtime: (c) => {
    const x = record(c.overtime);
    if (x === undefined) return null;
    const n = positive(x.minutes);
    return n === undefined ? [] : [{ key: "format.rules.decider.overtime", params: { n } }];
  },
  /** Cricket (limited overs): a super over. */
  superOver: (c) => (c.superOver === true ? [{ key: "format.rules.decider.superOver" }] : null),
  /** Chess: the rungs in the STAGE'S order; absent plays every rung in the engine's order and `[]` plays none (BG-KO-1,
   *  `effectiveRungs`). */
  tiebreakRungs: (c) => {
    const rungs = effectiveRungs({ tiebreakRungs: Array.isArray(c.tiebreakRungs) ? (c.tiebreakRungs as TiebreakRung[]) : undefined });
    return rungs.length === 0 ? null : rungs.map((rung) => ({ key: `format.rules.decider.${rung}` }));
  },
  /** Carrom: the extra board ('extra'), as against a drawn game ('draw'). */
  tieBoard: (c) => (c.tieBoard === "extra" ? [{ key: "format.rules.decider.extraBoard" }] : null),
};

/** Every decider key this table describes. */
export const DECIDER_DESCRIBED_KEYS: readonly string[] = Object.keys(DECIDERS);

/**
 * How a tied match ends in a stage of this `kind`, as clauses - from the engine's own declarations
 * (`deciderKeysFor`) and the parsed, BRACKET-RESOLVED config:
 *  - a decider that is ON is said, with its numbers (the stage's, never the division's);
 *  - in a BRACKET stage (`forbidsLevelResult`) where none is on, "level matches wait for the organiser" is said - that
 *    stage cannot end level, so the spectator is told what happens instead. A TABLE stage says nothing for a decider
 *    that is off: a drawn league match is a result, not a pending decision;
 *  - a bracket stage plays the sport's `bracketDeciders` on top (carrom's extra board, whatever the division's
 *    `tieBoard`): they are laid over the config here too, so the answer is the same whether or not the caller resolved
 *    them already, and a decider the overlay forces counts even where its key is declared for table stages only;
 *  - a sport that declares no decider says nothing; a refused config, nothing; no `kind` (the division level) never
 *    claims "none".
 */
export function describeDeciders(
  module_: AnySportModule,
  kind: string | null | undefined,
  cfg: unknown,
): RulesLineT {
  const declared = deciderKeysFor(module_, null, null);
  if (declared.length === 0) return [];
  const parsed = module_.configSchema.safeParse(cfg);
  if (!parsed.success) return [];
  const bracket = forbidsLevelResult(kind);
  const base = parsed.data as Record<string, unknown>;
  const forced = bracket && typeof module_.bracketDeciders === "function" ? (module_.bracketDeciders(base as never) as Record<string, unknown>) : {};
  const c = { ...base, ...forced };
  // A stage kind is a database string with no parse (`PublicStage.kind`, `FixtureStageSource.kind`): an unknown one
  // narrows nothing, exactly as `ruleKeyApplies` treats it.
  const applicable = new Set(deciderKeysFor(module_, (kind ?? null) as StageKind | null, null));
  const out: RulesLineT = [];
  let considered = 0;
  let on = false;
  for (const key of declared) {
    if (!applicable.has(key) && !Object.hasOwn(forced, key)) continue;
    considered++;
    // A decider no describer knows is never read as off: saying "none" over it would be a lie.
    if (!Object.hasOwn(DECIDERS, key)) {
      on = true;
      continue;
    }
    const said = DECIDERS[key]!(c, module_);
    if (said === null) continue;
    on = true;
    out.push(...said);
  }
  if (!on && bracket && considered > 0) return [{ key: "format.rules.decider.none" }];
  return out;
}

/** The abandon policy an unset `abandonPolicy` plays: a replay (CA-AB-1 carrom, GN-AB-1 generic; football's schema
 *  defaults to it). */
const ABANDON_ABSENT = "replay";

/**
 * The policy a stage plays for an abandoned match, as one clause, in the sport's own vocabulary
 * (`format.rules.abandon.<policy>`): only a policy the sport OFFERS (`abandonOptions`) is said - a sport that offers
 * none says nothing, and nor does a refused config or a policy the sport does not offer.
 */
export function describeAbandon(module_: AnySportModule, cfg: unknown): RulesLineT {
  const offered = module_.abandonOptions ?? [];
  if (offered.length === 0) return [];
  const parsed = module_.configSchema.safeParse(cfg);
  if (!parsed.success) return [];
  const policy = (parsed.data as Record<string, unknown>).abandonPolicy ?? ABANDON_ABSENT;
  return typeof policy === "string" && offered.includes(policy) ? [{ key: `format.rules.abandon.${policy}` }] : [];
}

// ---------------------------------------------------------------------------
// Does a stage play a different FORMAT from its division, and the line it shows instead of the preset name.
// ---------------------------------------------------------------------------

/** Structural equality for jsonb-shaped values, blind to object key ORDER
 *  (a frozen snapshot and a division row can serialise one nested object with
 *  its keys in different orders). */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

/** The value at a declared key's dotted path ("periods.minutes"); undefined once a step is not an object. */
function valueAt(cfg: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, step) => record(acc)?.[step], cfg);
}

/**
 * Does this effective config play a different FORMAT from the division's?
 *
 * Compared on the keys the module DECLARES a stage or a match may set
 * (`stageKeysFor(m, null, null)`: every stage and match scope key of every kind
 * and variant), each by its dotted path - so `periods.minutes` moving is a
 * difference and a sibling leaf the sport does not let a stage change
 * (`periods.count`), standings points or a cosmetic key moving is not. A module
 * that declares no `ruleKeys` (a legacy pinned version) falls back to the
 * web's `configKeysFor`, as before.
 *
 * Both sides are compared AFTER the module's schema fills its defaults: a
 * fixture's frozen snapshot is the raw resolved cfg, and a division row may
 * omit a key its schema defaults, so a raw comparison would call a defaulted
 * `cap` an override. When either side is refused (or there is no module) the
 * RAW values are compared instead — a difference is still a difference.
 */
export function rulesDifferFromDivision(
  sportKey: string,
  module_: AnySportModule | null | undefined,
  effectiveCfg: unknown,
  divisionCfg: unknown,
): boolean {
  const parse = (cfg: unknown): unknown => {
    if (!module_) return undefined;
    const r = module_.configSchema.safeParse(cfg);
    return r.success ? r.data : undefined;
  };
  let a = parse(effectiveCfg);
  let b = parse(divisionCfg);
  if (a === undefined || b === undefined) {
    a = effectiveCfg;
    b = divisionCfg;
  }
  const ra = (a ?? {}) as Record<string, unknown>;
  const rb = (b ?? {}) as Record<string, unknown>;
  const keys = module_?.ruleKeys !== undefined ? stageKeysFor(module_, null, null) : configKeysFor(sportKey);
  for (const key of keys) {
    if (canonical(valueAt(ra, key)) !== canonical(valueAt(rb, key))) return true;
  }
  return false;
}

/**
 * The line a fixture or stage shows INSTEAD of its division's preset name, or
 * null when it keeps that name.
 *
 * The preset name is kept ONLY when the effective rule keys equal the
 * division's (`rulesDifferFromDivision`). Rule keys that differ ALWAYS get the
 * described line, even when the describer's words for it happen to match what
 * it would say of the division (badminton `winBy` alone): a true-but-vague
 * line beats a preset name that is false for this stage — a Fast4 stage inside
 * a "Tour" division must never read "Tour" (review round 2).
 *
 * The line is the format, then how a tied match ends (`describeDeciders`, for
 * this `kind` - omit it at the division level, where "none" is never claimed),
 * then the abandon policy when the stage CHANGED it from its division's (every
 * line carrying the same policy would be noise).
 *
 * Null also when the effective rules cannot be described at all (no module, a
 * refused config, a shape no family claims): there is nothing true to put in
 * the preset's place.
 */
export function effectiveRulesLine(
  sportKey: string,
  module_: AnySportModule | null | undefined,
  effectiveCfg: unknown,
  divisionCfg: unknown,
  kind?: string | null,
): RulesLineT | null {
  if (!module_ || !rulesDifferFromDivision(sportKey, module_, effectiveCfg, divisionCfg)) return null;
  const format = describeMatchRules(sportKey, module_, effectiveCfg);
  if (format === null) return null;
  const abandon = describeAbandon(module_, effectiveCfg);
  const changed = canonical(abandon) !== canonical(describeAbandon(module_, divisionCfg));
  return [...format, ...describeDeciders(module_, kind, effectiveCfg), ...(changed ? abandon : [])];
}
