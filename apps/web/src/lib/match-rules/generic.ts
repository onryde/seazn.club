// The generic (sport-agnostic) curated match-rule fields. Client-safe: no "use
// client", no JSX, no `@/components` or `@/server` import.
import { generic } from "@seazn/engine/sports/generic";
import { abandonOptions, readBool, readText } from "./shared.ts";
import type { RuleField } from "./types.ts";

export const GENERIC_RULES: RuleField[] = [
  {
    key: "resultMode",
    edits: ["resultMode"],
    label: "How results are recorded",
    kind: "select",
    options: [
      { value: "win_loss", label: "Declare a winner" },
      { value: "score", label: "Two-number score" },
    ],
    build: (v) => ({ resultMode: v }),
    read: readText("resultMode"),
  },
  {
    key: "allowDraws",
    edits: ["allowDraws"],
    label: "Allow draws",
    help: "Ignored in knockout, double-elim and stepladder stages.",
    kind: "bool",
    build: (v) => ({ allowDraws: v === "on" }),
    read: readBool("allowDraws"),
  },
  {
    key: "abandon",
    edits: ["abandonPolicy"],
    label: "If a match is abandoned",
    kind: "select",
    options: abandonOptions(generic),
    build: (v) => ({ abandonPolicy: v }),
    read: readText("abandonPolicy"),
  },
];
