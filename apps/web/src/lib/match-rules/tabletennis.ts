// Table tennis's curated match-rule fields. Client-safe: no "use client", no
// JSX, no `@/components` or `@/server` import.
import { readNumber, WIN_BY } from "./shared.ts";
import type { RuleField } from "./types.ts";

export const TABLETENNIS_RULES: RuleField[] = [
  {
    key: "bestOf",
    label: "Best of (sets)",
    kind: "select",
    options: [1, 3, 5, 7].map((n) => ({ value: String(n), label: `Best of ${n}` })),
    build: (v) => ({ bestOf: Number(v) }),
    read: readNumber("bestOf"),
  },
  {
    key: "setTo",
    label: "Points to win a set",
    kind: "number",
    min: 1,
    max: 100,
    build: (v) => ({ setTo: Number(v) }),
    read: readNumber("setTo"),
  },
  {
    key: "finalSetTo",
    label: "Points in the deciding set",
    kind: "number",
    min: 1,
    max: 100,
    build: (v) => ({ finalSetTo: Number(v) }),
    read: readNumber("finalSetTo"),
  },
  WIN_BY,
];
