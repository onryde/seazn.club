// Ice hockey's curated match-rule fields. Client-safe: no "use client", no JSX,
// no `@/components` or `@/server` import.
import { icehockey } from "@seazn/engine/sports/icehockey";
import { abandonOptions, readNestedNumber, readText, recordAt } from "./shared.ts";
import type { RuleField } from "./types.ts";

export const ICEHOCKEY_RULES: RuleField[] = [
  {
    key: "periodMinutes",
    edits: ["periods.minutes"],
    label: "Period length (minutes)",
    kind: "number",
    min: 5,
    max: 30,
    build: (v) => ({ periods: { count: 3, minutes: Number(v) } }),
    // Three periods only: another count is not this field's shape, and reads blank rather than being rewritten to three.
    read: (config) => (recordAt(config, "periods")?.count === 3 ? readNestedNumber("periods", "minutes")(config) : undefined),
  },
  {
    key: "overtime",
    edits: ["overtime"],
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
    // On when the config carries an overtime; off when it carries none (null, the engine's own off, or a stage's `false`).
    read: (config) => (recordAt(config, "overtime") !== undefined ? "on" : config.overtime === null || config.overtime === false ? "off" : undefined),
  },
  {
    key: "overtimeMinutes",
    edits: ["overtime.minutes"],
    label: "Overtime length (minutes)",
    help: "Only applies when sudden-death overtime above is On.",
    kind: "number",
    min: 3,
    max: 20,
    build: () => ({}),
    read: readNestedNumber("overtime", "minutes"),
  },
  {
    key: "overtimeSkaters",
    edits: ["overtime"],
    label: "Overtime skaters per side",
    help: "Only applies when sudden-death overtime above is On.",
    kind: "number",
    min: 3,
    max: 5,
    build: () => ({}),
    read: readNestedNumber("overtime", "skaters"),
  },
  {
    key: "shootout",
    edits: ["shootout"],
    label: "Shootout (GWS)",
    help: "Only applies when set to On.",
    kind: "bool",
    build: (v, values) =>
      v === "on"
        ? { shootout: { attempts: Number(values.shootoutAttempts || 5), suddenDeath: true } }
        : { shootout: null },
    read: (config) => (recordAt(config, "shootout") !== undefined ? "on" : config.shootout === null || config.shootout === false ? "off" : undefined),
  },
  {
    key: "shootoutAttempts",
    edits: ["shootout.attempts"],
    label: "Shootout attempts",
    help: "Only applies when shootout above is On.",
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
    options: abandonOptions(icehockey),
    build: (v) => ({ abandonPolicy: v }),
    read: readText("abandonPolicy"),
  },
];
