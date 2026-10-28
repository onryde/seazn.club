// Field hockey's curated match-rule fields. Client-safe: no "use client", no
// JSX, no `@/components` or `@/server` import.
import { hockey } from "@seazn/engine/sports/hockey";
import { abandonOptions, readNestedNumber, readText, recordAt } from "./shared.ts";
import type { RuleField } from "./types.ts";

export const HOCKEY_RULES: RuleField[] = [
  {
    key: "quarterMinutes",
    edits: ["periods.minutes"],
    label: "Quarter length (minutes)",
    kind: "number",
    min: 5,
    max: 20,
    build: (v) => ({ periods: { count: 4, minutes: Number(v) } }),
    // Four quarters only: another count is not this field's shape, and reads blank rather than being rewritten to four.
    read: (config) => (recordAt(config, "periods")?.count === 4 ? readNestedNumber("periods", "minutes")(config) : undefined),
  },
  {
    key: "shootout",
    edits: ["shootout"],
    label: "Shoot-out on a draw",
    help: "Only applies when set to On. FIH default: 5 attempts, 8 seconds each.",
    kind: "bool",
    build: (v, values) =>
      v === "on"
        ? {
            // W2e (D4): no `suddenDeath`; it was declared and never read, and the engine no longer has it.
            shootout: {
              attempts: Number(values.shootoutAttempts || 5),
              clockSeconds: 8,
            },
          }
        : { shootout: null },
    // On when the config carries a shoot-out; off when it carries none (null, the engine's own off, or a stage's `false`).
    read: (config) => (recordAt(config, "shootout") !== undefined ? "on" : config.shootout === null || config.shootout === false ? "off" : undefined),
  },
  {
    key: "shootoutAttempts",
    edits: ["shootout.attempts"],
    label: "Shootout attempts",
    help: "Only applies when shoot-out above is On.",
    kind: "number",
    min: 3,
    max: 10,
    build: () => ({}),
    read: readNestedNumber("shootout", "attempts"),
  },
  {
    key: "abandon",
    edits: ["abandonPolicy"],
    label: "If a match is abandoned",
    kind: "select",
    options: abandonOptions(hockey),
    build: (v) => ({ abandonPolicy: v }),
    read: readText("abandonPolicy"),
  },
];
