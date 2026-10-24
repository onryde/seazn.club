// Cricket's curated match-rule fields. Client-safe: no "use client", no JSX,
// no `@/components` or `@/server` import.
import { readBool, readNumber, recordAt } from "./shared.ts";
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
    // Whole overs only: 30 balls is five overs, 31 is not a number of overs and reads blank.
    read: (config) => {
      const balls = config.ballsPerInnings;
      return typeof balls === "number" && balls > 0 && balls % 6 === 0 ? String(balls / 6) : undefined;
    },
  },
  {
    key: "maxOversPerBowler",
    edits: ["maxOversPerBowler"],
    label: "Max overs per bowler",
    kind: "number",
    min: 1,
    max: 50,
    build: (v) => ({ maxOversPerBowler: Number(v) }),
    read: readNumber("maxOversPerBowler"),
  },
  {
    key: "superOver",
    edits: ["superOver"],
    label: "Super over on a tie",
    help: "Plays a super over whenever a match ends tied — in any stage where it is On.",
    kind: "bool",
    build: (v) => ({ superOver: v === "on" }),
    read: readBool("superOver"),
  },
  {
    key: "dls",
    edits: ["dls"],
    label: "DLS revised targets",
    help: "Pro feature — a manual umpire target works on every plan.",
    kind: "bool",
    build: (v) => ({ dls: { enabled: v === "on", edition: "standard" } }),
    // The standard edition only: another edition is not this field's shape.
    read: (config) => {
      const dls = recordAt(config, "dls");
      return dls?.edition === "standard" && typeof dls.enabled === "boolean" ? (dls.enabled ? "on" : "off") : undefined;
    },
  },
  {
    key: "playersPerSide",
    edits: ["playersPerSide"],
    label: "Players per side",
    kind: "number",
    min: 3,
    max: 11,
    build: (v) => ({ playersPerSide: Number(v) }),
    read: readNumber("playersPerSide"),
  },
];
