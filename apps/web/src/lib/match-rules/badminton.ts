// Badminton's curated match-rule fields. Client-safe: no "use client", no JSX,
// no `@/components` or `@/server` import.
import { readNumber, WIN_BY } from "./shared.ts";
import type { RuleField } from "./types.ts";

export const BADMINTON_RULES: RuleField[] = [
  {
    key: "bestOf",
    label: "Best of (sets)",
    kind: "select",
    // 5 added by owner ruling 2026-09-20. `{"bestOf": 5}` was already real
    // stored data (the walkthrough Finals stage), and the organiser read
    // "Best of 5" on the summary line above a picker that could not offer it.
    // The engine runs it: badminton's module parses bestOf 5 without clamping
    // and awards at three games won over five, so widening the picker is the
    // fix rather than correcting the data.
    options: [1, 3, 5].map((n) => ({ value: String(n), label: `Best of ${n}` })),
    build: (v) => ({ bestOf: Number(v) }),
    read: readNumber("bestOf"),
  },
  {
    key: "setTo",
    label: "Points to win a set",
    kind: "number",
    min: 11,
    max: 30,
    build: (v) => ({ setTo: Number(v) }),
    read: readNumber("setTo"),
  },
  {
    key: "finalSetTo",
    label: "Points in the deciding set",
    kind: "number",
    min: 11,
    max: 30,
    build: (v) => ({ finalSetTo: Number(v) }),
    read: readNumber("finalSetTo"),
  },
  {
    key: "cap",
    label: "Hard cap (deciding point)",
    help: "Must be at least the points needed to win a set. Blank inherits the variant default.",
    kind: "number",
    min: 15,
    max: 35,
    build: (v) => ({ cap: Number(v) }),
    read: readNumber("cap"),
  },
  WIN_BY,
];
