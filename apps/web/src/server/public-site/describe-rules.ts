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
import { configKeysFor, STAGE_RULES_SPORTS } from "@/lib/match-rules";
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
 * `1 game · 15 points (cap 21)`, `Best of 3 · 11 points (cap 15)`.
 *
 * Says only what the parsed config declares:
 *  - no positive `bestOf` → null (nothing honest to say);
 *  - `setTo` is stated only when present and positive — tennis counts GAMES in
 *    `set.gamesTo` and has no `setTo`, so it gets the best-of alone;
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
  const points = positive(c.setTo);
  const capRaw = positive(c.cap);
  const cap = points !== undefined && capRaw !== undefined && capRaw > points ? capRaw : undefined;

  if (bestOf === 1) {
    const keys = ONE_UNIT[GAME_UNIT_SPORTS.has(sportKey) ? "game" : "set"];
    if (points === undefined) return { key: keys.bare };
    if (cap === undefined) return { key: keys.points, params: { points } };
    return { key: keys.pointsCap, params: { points, cap } };
  }
  if (points === undefined) return { key: "format.sets.bestOf", params: { n: bestOf } };
  if (cap === undefined) return { key: "format.rules.bestOfPoints", params: { n: bestOf, points } };
  return { key: "format.rules.bestOfPointsCap", params: { n: bestOf, points, cap } };
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
 * null when it should keep that name: the rules are the division's own, or
 * they differ in a way this file cannot describe honestly.
 */
export function effectiveRulesLine(
  sportKey: string,
  module_: AnySportModule | null | undefined,
  effectiveCfg: unknown,
  divisionCfg: unknown,
): MsgT | null {
  if (!rulesDifferFromDivision(sportKey, module_, effectiveCfg, divisionCfg)) return null;
  return describeMatchRules(sportKey, module_, effectiveCfg);
}
