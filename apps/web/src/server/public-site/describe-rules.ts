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
// dictionary. It returns a `Msg` (dictionary key + params) because the hub
// carries the line as a `Msg` and resolves it client-side against the PUBLIC
// dictionary, and the match-centre loader resolves the SAME `Msg` in the org's
// locale — one describer, so the two surfaces can never word one format two
// ways. The keys therefore live in `public.json`, beside `format.sets.bestOf`,
// which this file reuses for the "Best of N" case.
//
// THE MODULE IS PASSED IN, for `describe-format.ts`'s reason: a division pins
// its module version, and every read path honours that pin.
import type { AnySportModule } from "@seazn/engine/sport";
import { STAGE_RULES_SPORTS } from "@/lib/match-rules";
import { GAME_UNIT_SPORTS } from "@/lib/public-site";
import type { MsgT } from "./match-centre-schema";

/** A positive, finite number — or nothing. `Number("")` is `0` in this
 *  codebase and "0 points" is a confident lie, so zero, NaN, Infinity and every
 *  non-number read as ABSENT rather than as a value. */
function positive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * The one-unit noun per sport family, keyed by the SAME authority the match
 * centre's per-set scoreboard uses (`GAME_UNIT_SPORTS`): badminton and table
 * tennis play games, volleyball and tennis play sets. Each shape is one whole
 * sentence key, never fragments joined here, so a locale can order its words.
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
 * The EFFECTIVE match rules as one line (option A, brief 2026-09-24):
 * `1 game, 15 points (cap 21)`, `Best of 3, 11 points (cap 15)`,
 * `Best of 5, 25 points, decider 15`.
 *
 * Its clauses join with COMMAS, never " · ": the match header joins its own
 * facts with " · " (`match-centre.ts`'s metaLine), and a line using the same
 * joiner read as several separate facts ("1 game · 15 points · Court 2").
 *
 * Says only what the parsed config declares:
 *  - no positive `bestOf` → null (nothing honest to say);
 *  - the points target only when present and positive — tennis counts GAMES in
 *    `set.gamesTo` and has neither `setTo` nor `finalSetTo`, so it gets the
 *    best-of alone;
 *  - a ONE-unit match is its own decider: the set kernel plays set index
 *    bestOf−1 to `finalSetTo` (`setTarget`, engine `setbased/kernel.ts`), so a
 *    best-of-1 states `finalSetTo`, falling back to `setTo`;
 *  - a best-of-N states `setTo`, plus a decider clause when `finalSetTo` is
 *    present and plays to a DIFFERENT target (volleyball's 25 / 15);
 *  - the cap clause only when the cap is ABOVE the target — a null cap is
 *    uncapped, and a cap equal to the target extends nothing.
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
): MsgT | null {
  if (!STAGE_RULES_SPORTS.has(sportKey) || !module_) return null;
  const parsed = module_.configSchema.safeParse(cfg);
  if (!parsed.success) return null;
  const c = parsed.data as Record<string, unknown>;

  const bestOf = positive(c.bestOf);
  if (bestOf === undefined) return null;
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
 * The line a fixture or stage shows INSTEAD of its division's preset name, or
 * null when it should keep that name.
 *
 * Decided on the WORDS, not on the config: the line replaces the preset only
 * when the effective rules describe differently from the division's own rules
 * through this same describer. So null when
 *  - the rules are the division's own (or merely restate them);
 *  - they differ only in a way this file cannot say — tennis's `finalSet` or
 *    `set` shape, badminton's `winBy` — because swapping the preset name for
 *    words identical to the division's would tell a spectator less, not more;
 *  - the effective rules cannot be described at all (no module, a refused
 *    config, a sport without per-stage rules).
 *
 * Both sides go through the module's schema inside `describeMatchRules`, so a
 * frozen snapshot (the RAW resolved cfg) and a division row that omits a key
 * its schema defaults read the same; and only rule fields reach the words, so
 * standings points or a decider key (`shootout`) moving is no format change.
 * Both lines come from one builder, so their key and param order agree and a
 * serialised comparison is exact.
 */
export function effectiveRulesLine(
  sportKey: string,
  module_: AnySportModule | null | undefined,
  effectiveCfg: unknown,
  divisionCfg: unknown,
): MsgT | null {
  const line = describeMatchRules(sportKey, module_, effectiveCfg);
  if (line === null) return null;
  const divisionLine = describeMatchRules(sportKey, module_, divisionCfg);
  return JSON.stringify(line) === JSON.stringify(divisionLine) ? null : line;
}
