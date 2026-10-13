// Field hockey's curated match-rule fields. Client-safe: no "use client", no
// JSX, no `@/components` or `@/server` import.
import type { RuleField } from "./types.ts";

export const HOCKEY_RULES: RuleField[] = [
  {
    key: "quarterMinutes",
    label: "Quarter length (minutes)",
    kind: "number",
    min: 5,
    max: 20,
    build: (v) => ({ periods: { count: 4, minutes: Number(v) } }),
  },
  {
    key: "shootout",
    label: "Shoot-out on a draw",
    help: "Only applies when set to On. FIH default: 5 attempts, 8 seconds each.",
    kind: "bool",
    build: (v, values) =>
      v === "on"
        ? {
            shootout: {
              attempts: Number(values.shootoutAttempts || 5),
              suddenDeath: true,
              clockSeconds: 8,
            },
          }
        : { shootout: null },
  },
  {
    key: "shootoutAttempts",
    label: "Shootout attempts",
    help: "Only applies when shoot-out above is On.",
    kind: "number",
    min: 3,
    max: 10,
    build: () => ({}),
  },
];
