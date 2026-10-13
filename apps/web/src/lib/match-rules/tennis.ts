// Tennis's curated match-rule fields. Client-safe: no "use client", no JSX,
// no `@/components` or `@/server` import.
import { ownOr, readNumber, readShape } from "./shared.ts";
import type { RuleField } from "./types.ts";

/**
 * Tennis's `setType` and `finalSet` are the only fields whose `build` emits a
 * different nested object per option, so they are the only ones whose inverse
 * could drift away from it. Both directions read these tables, so there is one
 * source of truth rather than a hand-written inverse that silently stops
 * matching the day an option's shape is edited.
 *
 * Nested config objects must be COMPLETE — a partial `set` fails the pinned
 * module schema (v8 gotcha) — so each entry carries every key.
 */
export const TENNIS_SET_SHAPES: Record<string, Record<string, unknown>> = {
  tb6: { gamesTo: 6, winBy: 2, tiebreakAt: 6, tiebreakTo: 7 },
  fast4: { gamesTo: 4, winBy: 2, tiebreakAt: 3, tiebreakTo: 5 },
  advantage: { gamesTo: 6, winBy: 2, tiebreakAt: null, tiebreakTo: 7 },
};

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
    kind: "select",
    options: [1, 3, 5].map((n) => ({ value: String(n), label: `Best of ${n}` })),
    build: (v) => ({ bestOf: Number(v) }),
    read: readNumber("bestOf"),
  },
  {
    key: "setType",
    edits: ["set"],
    label: "Set type",
    kind: "select",
    options: [
      { value: "tb6", label: "Tie-break sets (to 6)" },
      { value: "fast4", label: "Fast4 (to 4, TB at 3–3)" },
      { value: "advantage", label: "Advantage sets" },
    ],
    // Unknown values keep falling through to `tb6`, as the chained ternary
    // this replaced did — `ownOr`, not `??`, so an INHERITED key is unknown
    // too. Copied, not shared by reference: the result is spread into a
    // config the caller owns.
    build: (v) => ({ set: { ...ownOr(TENNIS_SET_SHAPES, v, TENNIS_SET_SHAPES.tb6!) } }),
    // Reads `set`, NOT `setType` — the field key and the config key differ
    // for three of tennis's five fields (see `configKeysFor`).
    read: (config) => readShape(TENNIS_SET_SHAPES, config.set),
  },
  {
    key: "finalSet",
    edits: ["finalSet"],
    label: "Deciding set",
    kind: "select",
    options: [
      { value: "same", label: "Same as other sets" },
      { value: "mtb10", label: "Match tie-break to 10" },
      { value: "mtb7", label: "Match tie-break to 7" },
      { value: "tb10", label: "Set with tie-break to 10" },
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
    help: "A single deciding point at deuce.",
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
    label: "Tiebreak win margin",
    kind: "select",
    options: [
      { value: "2", label: "Win by two (standard)" },
      { value: "1", label: "Sudden death (first to target wins)" },
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
