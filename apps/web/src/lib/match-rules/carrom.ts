// Carrom's curated match-rule fields. Client-safe: no "use client", no JSX, no
// `@/components` or `@/server` import.
import { carrom } from "@seazn/engine/sports/carrom";
import { abandonOptions, readBool, readNumber, readText } from "./shared.ts";
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
    read: readNumber("gameTo"),
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
    read: readNumber("maxBoards"),
  },
  {
    key: "bestOf",
    edits: ["bestOf"],
    label: "Best of (games)",
    kind: "select",
    options: [1, 3, 5].map((n) => ({ value: String(n), label: `Best of ${n}` })),
    build: (v) => ({ bestOf: Number(v) }),
    read: readNumber("bestOf"),
  },
  // W2e Task 28 (owner D5, ruling 157) - what each coin left on the board is worth to the board winner (Law 52(b)(ii)). A
  // stage key the engine has always read (default 1); the editor never offered it. The engine gives it no maximum, so the
  // five here is the web's own bound: nine coins at five points stay inside the game target's own range.
  {
    key: "pointsPerCoin",
    edits: ["pointsPerCoin"],
    label: "Points per coin left on the board",
    labelKey: "rules.field.pointsPerCoin.label",
    help: "The board winner scores this for each coin the other side still has on the board. ICF: 1.",
    helpKey: "rules.field.pointsPerCoin.help",
    kind: "number",
    min: 1,
    max: 5,
    build: (v) => ({ pointsPerCoin: Number(v) }),
    read: readNumber("pointsPerCoin"),
  },
  {
    key: "queenPoints",
    edits: ["queenPoints"],
    label: "Queen bonus (points)",
    kind: "number",
    min: 0,
    max: 10,
    build: (v) => ({ queenPoints: Number(v) }),
    read: readNumber("queenPoints"),
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
    read: readNumber("queenCapAt"),
  },
  {
    key: "queenFollowsBoard",
    edits: ["queenFollowsBoard"],
    label: "Queen always follows board winner",
    help: "House rule — skips tracking who covered the queen (ICF requires it).",
    kind: "bool",
    build: (v) => ({ queenFollowsBoard: v === "on" }),
    read: readBool("queenFollowsBoard"),
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
    read: readText("tieBoard"),
  },
  {
    key: "abandon",
    edits: ["abandonPolicy"],
    label: "If a match is abandoned",
    kind: "select",
    options: abandonOptions(carrom),
    build: (v) => ({ abandonPolicy: v }),
    read: readText("abandonPolicy"),
  },
];
