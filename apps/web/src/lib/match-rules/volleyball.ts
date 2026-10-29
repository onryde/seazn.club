// Volleyball's curated match-rule fields. Client-safe: no "use client", no JSX,
// no `@/components` or `@/server` import.
import { readNumber, WIN_BY } from "./shared.ts";
import { setTargetFloorOf } from "./set-target-floor.ts";
import type { RuleField } from "./types.ts";

/** The fewest points a set may be played to: the engine's write door refuses a lower `setTo` or `finalSetTo` (W2e ruling 31), so the
 *  inputs offer nothing below it. */
const SET_TARGET_FLOOR = setTargetFloorOf("volleyball");

export const VOLLEYBALL_RULES: RuleField[] = [
  {
    key: "bestOf",
    edits: ["bestOf"],
    label: "Best of (sets)",
    kind: "select",
    options: [1, 3, 5, 7].map((n) => ({ value: String(n), label: `Best of ${n}` })),
    build: (v) => ({ bestOf: Number(v) }),
    read: readNumber("bestOf"),
  },
  {
    key: "setTo",
    edits: ["setTo"],
    label: "Points to win a set",
    kind: "number",
    min: SET_TARGET_FLOOR,
    max: 100,
    build: (v) => ({ setTo: Number(v) }),
    read: readNumber("setTo"),
  },
  {
    key: "finalSetTo",
    edits: ["finalSetTo"],
    label: "Points in the deciding set",
    kind: "number",
    min: SET_TARGET_FLOOR,
    max: 100,
    build: (v) => ({ finalSetTo: Number(v) }),
    read: readNumber("finalSetTo"),
  },
  {
    key: "cap",
    edits: ["cap"],
    label: "Hard cap (deciding point)",
    help: "Must be at least the points needed to win a set. Blank inherits the variant's own cap, if it has one.",
    kind: "number",
    min: 15,
    max: 35,
    build: (v) => ({ cap: Number(v) }),
    read: readNumber("cap"),
  },
  WIN_BY,
];
