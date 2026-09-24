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
// `format.sets.bestOf`, which this file reuses for the "Best of N" head.
//
// THE MODULE IS PASSED IN, for `describe-format.ts`'s reason: a division pins
// its module version, and every read path honours that pin.
import type { AnySportModule } from "@seazn/engine/sport";
import { configKeysFor, STAGE_RULES_SPORTS } from "@/lib/match-rules";
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
 * `Best of 3, sets to 6` (tour), `Best of 3, sets to 4, no-ad` (Fast4),
 * `Best of 3, sets to 6, deciding match tie-break to 10, no-ad` (doubles),
 * `Best of 5, sets to 6, final-set tie-break to 10` (grand slam).
 *
 *  - the set shape: games per set, and ADVANTAGE sets when `tiebreakAt` is null
 *    (no tie-break at all). A best-of-1 folds it into its head ("1 set to 6");
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
  const finalSet = record(c.finalSet);
  const matchTiebreak = positive(finalSet?.matchTiebreakTo);
  const finalTiebreak = positive(finalSet?.tiebreakTo);

  if (bestOf === 1 && matchTiebreak !== undefined) {
    return [{ key: "format.rules.tennis.oneMatchTiebreak", params: { n: matchTiebreak } }];
  }
  const out: RulesLineT = [];
  if (bestOf === 1) {
    if (games === undefined) out.push({ key: "format.rules.oneSet" });
    else
      out.push({
        key: advantage ? "format.rules.tennis.oneAdvantageSetTo" : "format.rules.tennis.oneSetTo",
        params: { games },
      });
  } else {
    out.push({ key: "format.sets.bestOf", params: { n: bestOf } });
    if (games !== undefined) {
      out.push({
        key: advantage ? "format.rules.tennis.advantageSetsTo" : "format.rules.tennis.setsTo",
        params: { games },
      });
    }
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

/**
 * The EFFECTIVE match rules as a line of clauses (option A, brief 2026-09-24).
 *
 * Its clauses join with COMMAS, never " · ": the match header joins its own
 * facts with " · " (`match-centre.ts`'s metaLine), and a line using the same
 * joiner read as several separate facts ("1 game · 15 points · Court 2").
 *
 * Says only what the parsed config declares — no positive `bestOf` → null
 * (nothing honest to say), and a missing or non-positive number says nothing
 * about itself. The config's SHAPE picks the kernel: a nested `set` object is
 * tennis's; otherwise the set kernel's flat `setTo`/`finalSetTo`/`cap`.
 *
 * Limited to the four stage-rules sports (`STAGE_RULES_SPORTS`): they are the
 * only ones whose stages can override format (design D2a), and the only ones
 * whose unit noun is known. Every other sport answers null and its caller keeps
 * the preset name.
 */
export function describeMatchRules(
  sportKey: string,
  module_: AnySportModule | null | undefined,
  cfg: unknown,
): RulesLineT | null {
  if (!STAGE_RULES_SPORTS.has(sportKey) || !module_) return null;
  const parsed = module_.configSchema.safeParse(cfg);
  if (!parsed.success) return null;
  const c = parsed.data as Record<string, unknown>;

  const bestOf = positive(c.bestOf);
  if (bestOf === undefined) return null;
  if (record(c.set) !== undefined) return describeNested(c, bestOf);
  return [describeSetKernel(sportKey, c, bestOf)];
}

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

/**
 * Does this effective config play a different FORMAT from the division's?
 *
 * Compared on the sport's rule keys only (`configKeysFor` — the CONFIG keys its
 * rule fields write, the same set the per-stage endpoint allows), so standings
 * points or a decider key moving is not a format change.
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
  for (const key of configKeysFor(sportKey)) {
    if (canonical(ra[key]) !== canonical(rb[key])) return true;
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
 * Null also when the effective rules cannot be described at all (no module, a
 * refused config, a sport without per-stage rules): there is nothing true to
 * put in the preset's place.
 */
export function effectiveRulesLine(
  sportKey: string,
  module_: AnySportModule | null | undefined,
  effectiveCfg: unknown,
  divisionCfg: unknown,
): RulesLineT | null {
  if (!rulesDifferFromDivision(sportKey, module_, effectiveCfg, divisionCfg)) return null;
  return describeMatchRules(sportKey, module_, effectiveCfg);
}
