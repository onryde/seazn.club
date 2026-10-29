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
    labelKey: "rules.field.resultMode.label",
    kind: "select",
    options: [
      { value: "win_loss", label: "Declare a winner", labelKey: "rules.field.resultMode.option.win_loss" },
      { value: "score", label: "Two-number score", labelKey: "rules.field.resultMode.option.score" },
    ],
    build: (v) => ({ resultMode: v }),
    read: readText("resultMode"),
  },
  {
    key: "allowDraws",
    edits: ["allowDraws"],
    label: "Allow draws",
    labelKey: "rules.field.allowDraws.label",
    help: "Ignored in knockout, double-elim and stepladder stages.",
    helpKey: "rules.field.allowDraws.help",
    kind: "bool",
    build: (v) => ({ allowDraws: v === "on" }),
    read: readBool("allowDraws"),
  },
  {
    key: "abandon",
    edits: ["abandonPolicy"],
    label: "If a match is abandoned",
    labelKey: "rules.field.abandon.label",
    kind: "select",
    options: abandonOptions(generic),
    build: (v) => ({ abandonPolicy: v }),
    read: readText("abandonPolicy"),
  },
];
