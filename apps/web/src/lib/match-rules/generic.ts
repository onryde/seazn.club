// The generic (sport-agnostic) curated match-rule fields. Client-safe: no "use
// client", no JSX, no `@/components` or `@/server` import.
import type { RuleField } from "./types.ts";

export const GENERIC_RULES: RuleField[] = [
  {
    key: "resultMode",
    label: "How results are recorded",
    kind: "select",
    options: [
      { value: "win_loss", label: "Declare a winner" },
      { value: "score", label: "Two-number score" },
    ],
    build: (v) => ({ resultMode: v }),
  },
  {
    key: "allowDraws",
    label: "Allow draws",
    help: "Ignored in knockout, double-elim and stepladder stages.",
    kind: "bool",
    build: (v) => ({ allowDraws: v === "on" }),
  },
];
