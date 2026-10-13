// Board games' (chess family) curated match-rule fields. Client-safe: no "use
// client", no JSX, no `@/components` or `@/server` import.
import type { RuleField } from "./types.ts";

export const BOARDGAME_RULES: RuleField[] = [
  {
    key: "variant",
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
    label: "Increment per move (seconds, Fischer)",
    help: "Only applies when time per side above is set.",
    kind: "number",
    min: 0,
    max: 60,
    build: () => ({}),
  },
  {
    key: "clockDelaySeconds",
    label: "Move delay (seconds, Bronstein/US delay)",
    help: "Only applies when time per side above is set.",
    kind: "number",
    min: 0,
    max: 60,
    build: () => ({}),
  },
];
