// Football's curated match-rule fields. Client-safe: no "use client", no JSX,
// no `@/components` or `@/server` import.
import { football } from "@seazn/engine/sports/football";
import { abandonOptions, readBool, readNumber, readText, readShape } from "./shared.ts";
import type { RuleField } from "./types.ts";

/** Football's extra time as the field writes it: two extra halves of 15 minutes, on or off. `read` holds only that exact
 *  shape (a hand-edited 20-minute extra time hydrates blank rather than being rounded to "on" and rewritten). */
const EXTRA_TIME = { on: { enabled: true, halfMinutes: 15 }, off: { enabled: false, halfMinutes: 15 } } as const;

export const FOOTBALL_RULES: RuleField[] = [
  {
    key: "halfMinutes",
    edits: ["halfMinutes"],
    label: "Half length (minutes)",
    kind: "number",
    min: 5,
    max: 60,
    build: (v) => ({ halfMinutes: Number(v) }),
    read: readNumber("halfMinutes"),
  },
  {
    key: "extraTime",
    edits: ["extraTime"],
    label: "Extra time",
    help: "Knockout fixtures only.",
    kind: "bool",
    build: (v) => ({ extraTime: { ...EXTRA_TIME[v === "on" ? "on" : "off"] } }),
    read: (config) => readShape(EXTRA_TIME, config.extraTime),
  },
  {
    key: "shootout",
    edits: ["shootout"],
    label: "Penalty shootout",
    help: "Penalties decide a level knockout match.",
    kind: "bool",
    build: (v) => ({ shootout: v === "on" }),
    read: readBool("shootout"),
  },
  // W2c FB-SO-1 — the kicks each side takes before sudden death. A match-scope key the engine bounds 1–10. A blank box is
  // 5 (the engine's SHOOTOUT_ATTEMPTS_DEFAULT; the stage's own value, once Task 12 writes the knockout preset into a new
  // stage, is 5, or 3 in the youth formats), and one match may only shorten it (X-SR-2).
  {
    key: "shootoutAttempts",
    edits: ["shootoutAttempts"],
    label: "Shoot-out kicks each",
    help: "Kicks each side takes before sudden death. Blank = 5.",
    kind: "number",
    min: 1,
    max: 10,
    build: (v) => ({ shootoutAttempts: Number(v) }),
    read: readNumber("shootoutAttempts"),
  },
  // W2d (spec §5.3, B2; PS-1) — the shoot-out points pair (R3.5/Task I) is gone: a table shoot-out is a draw plus a
  // `points.soBonus` to its winner, which the stage's Points section edits (W2d Tasks 15-16), never this list.
  {
    key: "teamSize",
    edits: ["teamSize"],
    label: "Team size (players per side)",
    kind: "number",
    min: 5,
    max: 11,
    build: (v) => ({ teamSize: Number(v) }),
    read: readNumber("teamSize"),
  },
  {
    key: "maxSubs",
    edits: ["maxSubs"],
    label: "Substitutes allowed",
    help: "Ignored when the variant already uses rolling subs.",
    kind: "number",
    min: 0,
    max: 10,
    build: (v) => ({ maxSubs: Number(v) }),
    read: readNumber("maxSubs"),
  },
  // W2e Task 28 (owner D5, ruling 157) - the two substitution knobs the editor never offered. Rolling subs let a substituted
  // player return and lift the cap (the engine never applies `maxSubs` under it); the youth, small-sided and mini-soccer
  // variants set it, 11-a-side does not. Optional with no engine default, so a blank control stores nothing.
  {
    key: "rollingSubs",
    edits: ["rollingSubs"],
    label: "Rolling substitutions",
    labelKey: "rules.field.rollingSubs.label",
    help: "Substituted players may come back on and there is no cap on substitutions. On in the youth and small-sided variants; off in 11-a-side.",
    helpKey: "rules.field.rollingSubs.help",
    kind: "bool",
    build: (v) => ({ rollingSubs: v === "on" }),
    read: readBool("rollingSubs"),
  },
  {
    key: "subWindows",
    edits: ["subWindows"],
    label: "Substitution windows allowed",
    help: "Stoppages a side may use subs in — independent cap from Substitutes allowed. Blank = unlimited.",
    kind: "number",
    min: 0,
    max: 10,
    build: (v) => ({ subWindows: Number(v) }),
    read: readNumber("subWindows"),
  },
  // A COUNT of extra substitutes (IFAB concussion trial), held outside `maxSubs`. Absent means the trial is not in force
  // here, and the kernel then refuses a concussion substitute; 0 is a value of its own and is stored. The engine gives it
  // no maximum; the trial allows two, so five is the web's own generous bound.
  {
    key: "concussionSubs",
    edits: ["concussionSubs"],
    label: "Concussion substitutes",
    labelKey: "rules.field.concussionSubs.label",
    help: "Extra substitutes a side may use for a suspected concussion, on top of Substitutes allowed. Blank = none (the trial is not in force).",
    helpKey: "rules.field.concussionSubs.help",
    kind: "number",
    min: 0,
    max: 5,
    build: (v) => ({ concussionSubs: Number(v) }),
    read: readNumber("concussionSubs"),
  },
  {
    key: "sinBinMinutes",
    edits: ["sinBinMinutes"],
    label: "Sin-bin length (minutes)",
    kind: "number",
    min: 1,
    max: 15,
    build: (v) => ({ sinBinMinutes: Number(v) }),
    read: readNumber("sinBinMinutes"),
  },
  {
    key: "abandon",
    edits: ["abandonPolicy"],
    label: "If a match is abandoned",
    kind: "select",
    options: abandonOptions(football),
    build: (v) => ({ abandonPolicy: v }),
    read: readText("abandonPolicy"),
  },
];
