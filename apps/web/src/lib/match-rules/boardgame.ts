// Board games' (chess family) curated match-rule fields. Client-safe: no "use
// client", no JSX, no `@/components` or `@/server` import.
import { readNestedNumber, readText } from "./shared.ts";
import type { RuleField } from "./types.ts";

/** The value of the tie-break rungs field that stands for the EMPTY list — a blank is "unset", so "no tie-break games"
 *  needs a token of its own (round-trips through `build` and `read`). */
export const NO_TIEBREAK_GAMES = "none";

export const BOARDGAME_RULES: RuleField[] = [
  {
    key: "variant",
    edits: ["variant"],
    label: "Clock family",
    kind: "select",
    options: [
      { value: "classical", label: "Classical" },
      { value: "rapid", label: "Rapid" },
      { value: "blitz", label: "Blitz" },
    ],
    build: (v) => ({ variant: v }),
    read: readText("variant"),
  },
  {
    key: "clockBaseMinutes",
    edits: ["clock"],
    label: "Time per side (minutes)",
    help: "Leave blank to skip a clock override entirely.",
    kind: "number",
    min: 1,
    max: 180,
    build: (v, values) => {
      const clock: Record<string, number> = { base: Number(v) * 60 };
      if (values.clockIncrementSeconds) clock.increment = Number(values.clockIncrementSeconds);
      if (values.clockDelaySeconds) clock.delay = Number(values.clockDelaySeconds);
      return { clock };
    },
    // Seconds on the clock, shown as minutes; a base that is not a whole number of minutes is not this field's shape.
    read: (config) => {
      const base = (config.clock as { base?: unknown } | undefined)?.base;
      return typeof base === "number" && base > 0 && base % 60 === 0 ? String(base / 60) : undefined;
    },
  },
  {
    key: "clockIncrementSeconds",
    edits: ["clock"],
    label: "Increment per move (seconds, Fischer)",
    help: "Only applies when time per side above is set.",
    kind: "number",
    min: 0,
    max: 60,
    build: () => ({}),
    read: readNestedNumber("clock", "increment"),
  },
  {
    key: "clockDelaySeconds",
    edits: ["clock"],
    label: "Move delay (seconds, Bronstein/US delay)",
    help: "Only applies when time per side above is set.",
    kind: "number",
    min: 0,
    max: 60,
    build: () => ({}),
    read: readNestedNumber("clock", "delay"),
  },
  // W2c BG-KO-3 (D8): which tie-break games a knockout stage plays, in the order they are played. The first ordered-list
  // ("sequence") field. Bracket stages only; the engine decides what a drawn game does when the list is empty.
  {
    key: "tiebreakRungs",
    edits: ["tiebreakRungs"],
    label: "Tie-break games, in order",
    help: "Played in this order after a drawn knockout game. Leave blank to play all three.",
    kind: "sequence",
    emptyValue: NO_TIEBREAK_GAMES,
    options: [
      { value: "rapid", label: "Rapid game" },
      { value: "blitz", label: "Blitz game" },
      { value: "armageddon", label: "Armageddon" },
    ],
    // A BLANK value means "unset" everywhere in the editor (`buildRuleOverride` skips it), so an EMPTY list ("no tie-break
    // games"; a drawn game is held for the organiser, BG-KO-1) needs a value of its own: NO_TIEBREAK_GAMES. `build("")` is
    // kept as the empty list for a caller that hands it a blank directly.
    build: (v) => ({ tiebreakRungs: v === "" || v === NO_TIEBREAK_GAMES ? [] : v.split(",") }),
    // Report only what the config carries, so a stage's saved order reopens as itself: a stage's PUT is a fragment where a
    // blank means "inherit", and a blank over a saved list would drop it on the next save. The empty list reopens as
    // NO_TIEBREAK_GAMES, never as a blank (which would read as "unset" and lose it); an absent list reads as nothing.
    read: (config) =>
      Array.isArray(config.tiebreakRungs) ? (config.tiebreakRungs.length === 0 ? NO_TIEBREAK_GAMES : config.tiebreakRungs.join(",")) : undefined,
  },
];
