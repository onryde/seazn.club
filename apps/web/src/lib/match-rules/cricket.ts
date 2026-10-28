// Cricket's curated match-rule fields. Client-safe: no "use client", no JSX,
// no `@/components` or `@/server` import.
import { cricket } from "@seazn/engine/sports/cricket";
import { readBool, readNumber, readText, recordAt } from "./shared.ts";
import type { RuleField } from "./types.ts";

/** What a config that names no over length counts its overs in: the engine's own default (`ballsPerOver`, six), read off
 *  the schema rather than typed here. */
const DEFAULT_BALLS_PER_OVER = (cricket.configSchema.parse({}) as { ballsPerOver: number }).ballsPerOver;

const isOverLength = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n > 0;

/**
 * W2e Task 8c (owner D19; row CK-BO-2) - how many balls make one over where this value is built or read: the config's own
 * `ballsPerOver`, else the one it falls back to (`inherited`: the division's, which carries its variant's - The Hundred's
 * is five), else the engine's default. A value that is no positive whole number is no over length and is passed over.
 * One reader for both directions, so the field cannot write in one unit and read in another.
 */
function ballsPerOverIn(config: Record<string, unknown>, inherited: Record<string, unknown> | undefined): number {
  if (isOverLength(config.ballsPerOver)) return config.ballsPerOver;
  if (isOverLength(inherited?.ballsPerOver)) return inherited.ballsPerOver;
  return DEFAULT_BALLS_PER_OVER;
}

export const CRICKET_RULES: RuleField[] = [
  {
    key: "overs",
    edits: ["ballsPerInnings"],
    // The scale the count is converted by comes from the config it is built or read against (`ballsPerOverIn`).
    context: ["ballsPerOver"],
    label: "Overs per innings",
    kind: "number",
    min: 1,
    max: 100,
    build: (v, _values, inherited) => ({ ballsPerInnings: Number(v) * ballsPerOverIn({}, inherited) }),
    // Whole overs only: 30 balls is five overs of six, 31 is not a number of overs and reads blank.
    read: (config, inherited) => {
      const balls = config.ballsPerInnings;
      const perOver = ballsPerOverIn(config, inherited);
      return typeof balls === "number" && balls > 0 && balls % perOver === 0 ? String(balls / perOver) : undefined;
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
  // W2e Task 28 (owner D5, ruling 157) - the fewest overs the chasing side must have faced before DLS may decide an
  // abandoned match (CR-13). The number is OVERS, not balls: the engine multiplies by `ballsPerOver` itself, so no scale is
  // applied here. 0 is a legal value (the test match plays no limited innings). The engine's cross-refine (the floor must
  // fit the innings) is the contract's `crossField` pin.
  {
    key: "minOversForResult",
    edits: ["minOversForResult"],
    label: "Minimum overs for a result",
    labelKey: "rules.field.minOversForResult.label",
    help: "Fewest overs the chasing side must face before DLS can decide an abandoned match; fewer is a no result. Usual: 5 in T20, 20 in ODI.",
    helpKey: "rules.field.minOversForResult.help",
    kind: "number",
    min: 0,
    max: 100,
    build: (v) => ({ minOversForResult: Number(v) }),
    read: readNumber("minOversForResult"),
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
  // W2e Task 28 (owner D5, ruling 157) - what a TIED super over does. The engine holds it behind the super over
  // (`detailOf: "superOver"`, Task 7), so the stage row disables it while the super over is off, and offers it only on
  // the variants that can play one. `boundary_count` reads the innings' boundary totals, which only ball-by-ball scoring
  // produces: a summary innings carries none (the pad never sends the optional `boundaries`), so the help says so.
  {
    key: "superOverStillTied",
    edits: ["superOverStillTied"],
    label: "If the super over is tied",
    labelKey: "rules.field.superOverStillTied.label",
    help: "Most boundaries counts only boundaries scored ball by ball; an innings entered as a summary counts none. Only used while the super over is on.",
    helpKey: "rules.field.superOverStillTied.help",
    kind: "select",
    options: [
      { value: "repeat", label: "Another super over (ICC)", labelKey: "rules.field.superOverStillTied.option.repeat" },
      { value: "boundary_count", label: "Most boundaries wins", labelKey: "rules.field.superOverStillTied.option.boundary_count" },
      { value: "shared", label: "Leave it as a tie", labelKey: "rules.field.superOverStillTied.option.shared" },
    ],
    build: (v) => ({ superOverStillTied: v }),
    read: readText("superOverStillTied"),
  },
  {
    key: "dls",
    edits: ["dls"],
    label: "DLS revised targets",
    help: "A manual umpire target always works too.",
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
