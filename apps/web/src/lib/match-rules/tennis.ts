// Tennis's curated match-rule fields. Client-safe: no "use client", no JSX,
// no `@/components` or `@/server` import.
import { tennis } from "@seazn/engine/sports/tennis";
import { bestOfOptions, ownOr, readNumber, readShape } from "./shared.ts";
import type { RuleField } from "./types.ts";

/** The margin a tie-break is won by when nothing names one: the engine's own default (`tiebreak.winBy`, two), read off the
 *  schema rather than typed here. */
const DEFAULT_TIEBREAK_WIN_BY = (tennis.configSchema.parse({}) as { tiebreak: { winBy: number } }).tiebreak.winBy;

/**
 * Tennis's `setType` and `finalSet` are the only fields whose `build` emits a
 * different nested object per option, so they are the only ones whose inverse
 * could drift away from it. Both directions read these tables, so there is one
 * source of truth rather than a hand-written inverse that silently stops
 * matching the day an option's shape is edited.
 *
 * Nested config objects must be COMPLETE — a partial `set` fails the pinned
 * module schema (v8 gotcha) — so each entry carries every key.
 *
 * W2e (TN-SS-2): a set may carry its own tie-break margin (`tiebreakWinBy`; absent = the match's `tiebreak.winBy`), and EVERY
 * shape names one. A stage's rules merge per leaf, so a shape that left it out would keep the margin of whatever set it
 * replaced (a short set's one on a standard set), and the match-tie-break field below would reach set tie-breaks it is not about.
 * `short4` and `fast4` are ITF App VI's formats (a deciding point at 4-4, a margin of one); the standard sets play to two.
 */
export const TENNIS_SET_SHAPES: Record<string, Record<string, unknown>> = {
  tb6: { gamesTo: 6, winBy: 2, tiebreakAt: 6, tiebreakTo: 7, tiebreakWinBy: 2 },
  fast4: { gamesTo: 4, winBy: 2, tiebreakAt: 3, tiebreakTo: 5, tiebreakWinBy: 1 },
  short4: { gamesTo: 4, winBy: 2, tiebreakAt: 4, tiebreakTo: 5, tiebreakWinBy: 1 },
  advantage: { gamesTo: 6, winBy: 2, tiebreakAt: null, tiebreakTo: 7, tiebreakWinBy: 2 },
  // Not offered: Fast4 as every division saved before W2e plays it (the set carried no margin, the match's two applied). The
  // organiser's saved value is shown as itself and written back as it was, never silently moved to the new Fast4's one.
  fast4Margin2: { gamesTo: 4, winBy: 2, tiebreakAt: 3, tiebreakTo: 5, tiebreakWinBy: 2 },
};

const positiveInt = (v: unknown): number | undefined => (typeof v === "number" && Number.isInteger(v) && v > 0 ? v : undefined);
const matchMargin = (cfg: Record<string, unknown> | undefined): number | undefined => {
  const tiebreak = cfg?.tiebreak;
  return typeof tiebreak === "object" && tiebreak !== null ? positiveInt((tiebreak as { winBy?: unknown }).winBy) : undefined;
};

/**
 * The saved `set` as the shapes table can compare it: with the margin it is PLAYED by written in. A set saved before W2e names
 * none, and plays by the match's (`tiebreak.winBy`, else the division's when this is a stage's fragment, else the default); a set
 * without a tie-break (advantage) has no margin to disagree about. Everything else is left exactly as saved, so a set no shape names
 * - an extra key, another games target, a margin of one on a standard set - still reads blank and is never rewritten.
 */
function setWithPlayedMargin(config: Record<string, unknown>, inherited: Record<string, unknown> | undefined): unknown {
  const set = config.set;
  if (typeof set !== "object" || set === null || Array.isArray(set)) return set;
  const own = set as Record<string, unknown>;
  if (own.tiebreakAt === null) return { ...own, tiebreakWinBy: TENNIS_SET_SHAPES.advantage!.tiebreakWinBy };
  return { ...own, tiebreakWinBy: own.tiebreakWinBy ?? matchMargin(config) ?? matchMargin(inherited) ?? DEFAULT_TIEBREAK_WIN_BY };
}

/** `"same"` is a bare string here, not an object — the engine's own encoding. */
const TENNIS_FINAL_SET_SHAPES: Record<string, unknown> = {
  same: "same",
  mtb10: { matchTiebreakTo: 10 },
  mtb7: { matchTiebreakTo: 7 },
  tb10: { tiebreakTo: 10 },
};

export const TENNIS_RULES: RuleField[] = [
  {
    key: "bestOf",
    edits: ["bestOf"],
    label: "Best of (sets)",
    labelKey: "rules.field.bestOf.label",
    kind: "select",
    options: bestOfOptions([1, 3, 5]),
    build: (v) => ({ bestOf: Number(v) }),
    read: readNumber("bestOf"),
  },
  {
    key: "setType",
    edits: ["set"],
    label: "Set type",
    labelKey: "rules.field.setType.label",
    kind: "select",
    options: [
      { value: "tb6", label: "Tie-break sets (to 6)", labelKey: "rules.field.setType.option.tb6" },
      { value: "fast4", label: "Fast4 (to 4, TB at 3–3)", labelKey: "rules.field.setType.option.fast4" },
      { value: "short4", label: "Short sets (to 4, TB at 4–4)", labelKey: "rules.field.setType.option.short4" },
      { value: "advantage", label: "Advantage sets", labelKey: "rules.field.setType.option.advantage" },
    ],
    // Saved values the picker shows as themselves but does not offer (`RuleField.legacyOptions`).
    legacyOptions: [{ value: "fast4Margin2", label: "Fast4 (to 4, TB at 3–3, win by two)", labelKey: "rules.field.setType.option.fast4Margin2" }],
    // Unknown values keep falling through to `tb6`, as the chained ternary
    // this replaced did — `ownOr`, not `??`, so an INHERITED key is unknown
    // too. Copied, not shared by reference: the result is spread into a
    // config the caller owns.
    build: (v) => ({ set: { ...ownOr(TENNIS_SET_SHAPES, v, TENNIS_SET_SHAPES.tb6!) } }),
    // Reads `set`, NOT `setType` — the field key and the config key differ
    // for three of tennis's five fields (see `configKeysFor`). Through `setWithPlayedMargin`: a set saved before W2e names no margin.
    read: (config, inherited) => readShape(TENNIS_SET_SHAPES, setWithPlayedMargin(config, inherited)),
  },
  {
    key: "finalSet",
    edits: ["finalSet"],
    label: "Deciding set",
    labelKey: "rules.field.finalSet.label",
    kind: "select",
    options: [
      { value: "same", label: "Same as other sets", labelKey: "rules.field.finalSet.option.same" },
      { value: "mtb10", label: "Match tie-break to 10", labelKey: "rules.field.finalSet.option.mtb10" },
      { value: "mtb7", label: "Match tie-break to 7", labelKey: "rules.field.finalSet.option.mtb7" },
      { value: "tb10", label: "Set with tie-break to 10", labelKey: "rules.field.finalSet.option.tb10" },
    ],
    build: (v) => {
      const shape = ownOr<unknown>(TENNIS_FINAL_SET_SHAPES, v, "same");
      return { finalSet: typeof shape === "object" && shape !== null ? { ...shape } : shape };
    },
    read: (config) => readShape(TENNIS_FINAL_SET_SHAPES, config.finalSet),
  },
  {
    key: "noAd",
    edits: ["game.noAd"],
    label: "No-ad games",
    labelKey: "rules.field.noAd.label",
    help: "A single deciding point at deuce.",
    helpKey: "rules.field.noAd.help",
    kind: "bool",
    build: (v) => ({ game: { noAd: v === "on" } }),
    // Reads `game`. A non-boolean `noAd` hydrates blank rather than
    // coercing a truthy string into a checked box.
    read: (config) => {
      const game = config.game;
      if (typeof game !== "object" || game === null) return undefined;
      const noAd = (game as { noAd?: unknown }).noAd;
      return typeof noAd === "boolean" ? (noAd ? "on" : "off") : undefined;
    },
  },
  {
    key: "tiebreakWinBy",
    edits: ["tiebreak.winBy"],
    // The MATCH tie-break's margin (and a deciding-set tie-break's): a set plays by its own (`TENNIS_SET_SHAPES`), so the
    // old "Tiebreak win margin" no longer said which tie-break it was about.
    label: "Match tie-break win margin",
    labelKey: "rules.field.tiebreakWinBy.label",
    help: "Applies to the match tie-break and to a deciding-set tie-break. The set type decides the margin of ordinary set tie-breaks.",
    helpKey: "rules.field.tiebreakWinBy.help",
    kind: "select",
    options: [
      { value: "2", label: "Win by two (standard)", labelKey: "rules.field.tiebreakWinBy.option.2" },
      { value: "1", label: "Sudden death (first to target wins)", labelKey: "rules.field.tiebreakWinBy.option.1" },
    ],
    build: (v) => ({ tiebreak: { winBy: Number(v) } }),
    // Reads `tiebreak`, not `tiebreakWinBy`.
    read: (config) => {
      const tiebreak = config.tiebreak;
      if (typeof tiebreak !== "object" || tiebreak === null) return undefined;
      const winBy = (tiebreak as { winBy?: unknown }).winBy;
      return typeof winBy === "number" ? String(winBy) : undefined;
    },
  },
];
