// Ice hockey's curated match-rule fields. Client-safe: no "use client", no JSX,
// no `@/components` or `@/server` import.
import type { RuleField } from "./types.ts";

export const ICEHOCKEY_RULES: RuleField[] = [
  {
    key: "periodMinutes",
    label: "Period length (minutes)",
    kind: "number",
    min: 5,
    max: 30,
    build: (v) => ({ periods: { count: 3, minutes: Number(v) } }),
  },
  {
    key: "overtime",
    label: "Sudden-death overtime",
    help: "Only applies when set to On. IIHF default: 5 minutes, 3 skaters.",
    kind: "bool",
    build: (v, values) =>
      v === "on"
        ? {
            overtime: {
              kind: "sudden_death",
              minutes: Number(values.overtimeMinutes || 5),
              skaters: Number(values.overtimeSkaters || 3),
            },
          }
        : { overtime: null },
  },
  {
    key: "overtimeMinutes",
    label: "Overtime length (minutes)",
    help: "Only applies when sudden-death overtime above is On.",
    kind: "number",
    min: 3,
    max: 20,
    build: () => ({}),
  },
  {
    key: "overtimeSkaters",
    label: "Overtime skaters per side",
    help: "Only applies when sudden-death overtime above is On.",
    kind: "number",
    min: 3,
    max: 5,
    build: () => ({}),
  },
  {
    key: "shootout",
    label: "Shootout (GWS)",
    help: "Only applies when set to On.",
    kind: "bool",
    build: (v, values) =>
      v === "on"
        ? { shootout: { attempts: Number(values.shootoutAttempts || 5), suddenDeath: true } }
        : { shootout: null },
  },
  {
    key: "shootoutAttempts",
    label: "Shootout attempts",
    help: "Only applies when shootout above is On.",
    kind: "number",
    min: 3,
    max: 10,
    build: () => ({}),
  },
];
