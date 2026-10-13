// Cricket's curated match-rule fields. Client-safe: no "use client", no JSX,
// no `@/components` or `@/server` import.
import type { RuleField } from "./types.ts";

export const CRICKET_RULES: RuleField[] = [
  {
    key: "overs",
    edits: ["ballsPerInnings"],
    label: "Overs per innings",
    kind: "number",
    min: 1,
    max: 100,
    build: (v) => ({ ballsPerInnings: Number(v) * 6 }),
  },
  {
    key: "maxOversPerBowler",
    edits: ["maxOversPerBowler"],
    label: "Max overs per bowler",
    kind: "number",
    min: 1,
    max: 50,
    build: (v) => ({ maxOversPerBowler: Number(v) }),
  },
  {
    key: "superOver",
    edits: ["superOver"],
    label: "Super over on a tie",
    help: "Knockout fixtures only.",
    kind: "bool",
    build: (v) => ({ superOver: v === "on" }),
  },
  {
    key: "dls",
    edits: ["dls"],
    label: "DLS revised targets",
    help: "Pro feature — a manual umpire target works on every plan.",
    kind: "bool",
    build: (v) => ({ dls: { enabled: v === "on", edition: "standard" } }),
  },
  {
    key: "playersPerSide",
    edits: ["playersPerSide"],
    label: "Players per side",
    kind: "number",
    min: 3,
    max: 11,
    build: (v) => ({ playersPerSide: Number(v) }),
  },
];
