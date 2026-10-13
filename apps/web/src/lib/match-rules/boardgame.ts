// Board games' (chess family) curated match-rule fields. Client-safe: no "use
// client", no JSX, no `@/components` or `@/server` import.
import type { RuleField } from "./types.ts";

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
  },
  // W2c BG-KO-3 (D8): which tie-break games a knockout stage plays, in the order they are played. The first ordered-list
  // ("sequence") field. Bracket stages only; the engine decides what a drawn game does when the list is empty.
  {
    key: "tiebreakRungs",
    edits: ["tiebreakRungs"],
    label: "Tie-break games, in order",
    help: "Played in this order after a drawn knockout game. Leave blank to play all three.",
    kind: "sequence",
    options: [
      { value: "rapid", label: "Rapid game" },
      { value: "blitz", label: "Blitz game" },
      { value: "armageddon", label: "Armageddon" },
    ],
    build: (v) => ({ tiebreakRungs: v === "" ? [] : v.split(",") }),
    // Report only what the config carries, so a stage's saved order reopens as itself: a stage's PUT is a fragment where a
    // blank means "inherit", and a blank over a saved list would drop it on the next save. An empty list has no value of
    // its own here (blank is "the engine's own order"); the sequence control that renders this field owns that case.
    read: (config) => (Array.isArray(config.tiebreakRungs) && config.tiebreakRungs.length > 0 ? config.tiebreakRungs.join(",") : undefined),
  },
];
