// Carrom's curated match-rule fields. Client-safe: no "use client", no JSX, no
// `@/components` or `@/server` import.
import { carrom } from "@seazn/engine/sports/carrom";
import { abandonOptions } from "./shared.ts";
import type { RuleField } from "./types.ts";

export const CARROM_RULES: RuleField[] = [
  {
    key: "gameTo",
    edits: ["gameTo"],
    label: "Points to win a game",
    help: "Also lowers the queen bonus cutoff below if that field is left blank.",
    kind: "number",
    min: 5,
    max: 50,
    // The pinned schema refines queenCapAt <= gameTo. queenCapAt's own
    // schema default (22) is only valid for gameTo >= 22 — a blank
    // queenCapAt below that would otherwise fail server-side the moment
    // gameTo is lowered for a shorter game, on a field the organizer never
    // touched. Carry a coherent fallback here since queenCapAt's own field
    // never runs at all while blank (buildRuleOverride skips blank fields
    // entirely, so it can't rescue itself).
    build: (v, values) => {
      const gameTo = Number(v);
      const override: Record<string, unknown> = { gameTo };
      // Only the actual conflict case (below the schema's own default)
      // needs the fallback — a gameTo at or above 22 leaves the default
      // valid, so leave queenCapAt untouched rather than writing a
      // redundant override.
      if (!values.queenCapAt && gameTo < 22) override.queenCapAt = gameTo;
      return override;
    },
  },
  {
    key: "maxBoards",
    edits: ["maxBoards"],
    label: "Max boards per game",
    help: "ICF: leader after 8 boards wins if untied.",
    kind: "number",
    min: 1,
    max: 20,
    build: (v) => ({ maxBoards: Number(v) }),
  },
  {
    key: "bestOf",
    edits: ["bestOf"],
    label: "Best of (games)",
    kind: "select",
    options: [1, 3, 5].map((n) => ({ value: String(n), label: `Best of ${n}` })),
    build: (v) => ({ bestOf: Number(v) }),
  },
  {
    key: "queenPoints",
    edits: ["queenPoints"],
    label: "Queen bonus (points)",
    kind: "number",
    min: 0,
    max: 10,
    build: (v) => ({ queenPoints: Number(v) }),
  },
  {
    key: "queenCapAt",
    edits: ["queenCapAt"],
    label: "Queen bonus cutoff (score)",
    help: "Must not exceed points to win a game.",
    kind: "number",
    min: 1,
    max: 50,
    build: (v) => ({ queenCapAt: Number(v) }),
  },
  {
    key: "queenFollowsBoard",
    edits: ["queenFollowsBoard"],
    label: "Queen always follows board winner",
    help: "House rule — skips tracking who covered the queen (ICF requires it).",
    kind: "bool",
    build: (v) => ({ queenFollowsBoard: v === "on" }),
  },
  {
    key: "tieBoard",
    edits: ["tieBoard"],
    label: "Game tied at max boards",
    kind: "select",
    options: [
      { value: "extra", label: "Sudden-death extra board (ICF)" },
      { value: "draw", label: "Drawn game (house rule; enables league draws)" },
    ],
    build: (v) => ({ tieBoard: v }),
  },
  {
    key: "abandon",
    edits: ["abandonPolicy"],
    label: "If a match is abandoned",
    kind: "select",
    options: abandonOptions(carrom),
    build: (v) => ({ abandonPolicy: v }),
  },
];
