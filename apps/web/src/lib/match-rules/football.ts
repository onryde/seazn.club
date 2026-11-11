// Football's curated match-rule fields. Client-safe: no "use client", no JSX,
// no `@/components` or `@/server` import.
import { football } from "@seazn/engine/sports/football";
import { abandonOptions, readBool, readNestedNumber, readNumber, readText, readShape } from "./shared.ts";
import type { RuleField } from "./types.ts";

/** Football's extra time as the field writes it: two extra halves of 15 minutes, on or off. `read` holds only that exact
 *  shape (a hand-edited 20-minute extra time hydrates blank rather than being rounded to "on" and rewritten). */
const EXTRA_TIME = { on: { enabled: true, halfMinutes: 15 }, off: { enabled: false, halfMinutes: 15 } } as const;

/** Law 3.2's extra-time allowance: one more substitution and one more opportunity. What a blank box beside a filled one means. */
const LAW_3_EXTRA = 1;

/** `extraTimeSubs` from the two boxes' raw values; a blank one is Law 3's one (the engine requires both leaves). */
function extraTimeSubsOf(subs: string | undefined, windows: string | undefined): Record<string, unknown> {
  const n = (raw: string | undefined) => (raw === undefined || raw === "" ? LAW_3_EXTRA : Number(raw));
  return { extraTimeSubs: { subs: n(subs), windows: n(windows) } };
}

export const FOOTBALL_RULES: RuleField[] = [
  {
    key: "halfMinutes",
    edits: ["halfMinutes"],
    label: "Half length (minutes)",
    labelKey: "rules.field.halfMinutes.label",
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
    labelKey: "rules.field.extraTime.label",
    help: "Knockout fixtures only.",
    helpKey: "rules.field.extraTime.help",
    kind: "bool",
    build: (v) => ({ extraTime: { ...EXTRA_TIME[v === "on" ? "on" : "off"] } }),
    read: (config) => readShape(EXTRA_TIME, config.extraTime),
  },
  {
    key: "shootout",
    edits: ["shootout"],
    label: "Penalty shootout",
    labelKey: "rules.field.football.shootout.label",
    help: "Penalties decide a level knockout match.",
    helpKey: "rules.field.football.shootout.help",
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
    labelKey: "rules.field.football.shootoutAttempts.label",
    help: "Kicks each side takes before sudden death. Blank = 5.",
    helpKey: "rules.field.football.shootoutAttempts.help",
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
    labelKey: "rules.field.teamSize.label",
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
    labelKey: "rules.field.maxSubs.label",
    help: "Ignored when the variant already uses rolling subs.",
    helpKey: "rules.field.maxSubs.help",
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
    help: "Substituted players may come back on and there is no cap on substitutions. On in the youth, small-sided and mini-soccer variants; off in 11-a-side.",
    helpKey: "rules.field.rollingSubs.help",
    kind: "bool",
    build: (v) => ({ rollingSubs: v === "on" }),
    read: readBool("rollingSubs"),
  },
  {
    key: "subWindows",
    edits: ["subWindows"],
    label: "Substitution windows allowed",
    labelKey: "rules.field.subWindows.label",
    help: "Stoppages a side may use subs in — independent cap from Substitutes allowed. Blank = unlimited.",
    helpKey: "rules.field.subWindows.help",
    kind: "number",
    min: 0,
    max: 10,
    build: (v) => ({ subWindows: Number(v) }),
    read: readNumber("subWindows"),
  },
  // Engine 7.0.0 (F-R3; IFAB Law 3.2) - the extra substitution and the extra substitution opportunity a competition that plays
  // extra time may allow in it. ONE engine key, `extraTimeSubs: { subs, windows }`, both leaves required, so two number boxes
  // that each build the whole object: its own value, and the other box's, or Law 3's one when that box is blank. Optional with
  // no engine default, so both blank stores nothing. Read only from extra time on (`effectiveSubCaps`); the form has no way to
  // hold them while extra time is off unless the engine declares the key a detail of `extraTime` (`detailOf`), which 7.0.0 does
  // not. The engine gives no maximum; three is the web's own bound (Law 3 allows one).
  {
    key: "extraTimeSubs",
    edits: ["extraTimeSubs"],
    label: "Extra subs in extra time",
    labelKey: "rules.field.extraTimeSubs.label",
    help: "Substitutions a side may add in extra time, on top of Substitutes allowed (Law 3 allows one). Extra time only. Blank = none, or 1 if extra windows are set.",
    helpKey: "rules.field.extraTimeSubs.help",
    kind: "number",
    min: 0,
    max: 3,
    build: (v, values) => extraTimeSubsOf(v, values.extraTimeWindows),
    read: readNestedNumber("extraTimeSubs", "subs"),
  },
  {
    key: "extraTimeWindows",
    edits: ["extraTimeSubs"],
    label: "Extra windows in extra time",
    labelKey: "rules.field.extraTimeWindows.label",
    help: "Stoppages a side may add for substitutions in extra time, on top of Substitution windows allowed (Law 3 allows one). Extra time only. Blank = none, or 1 if extra subs are set.",
    helpKey: "rules.field.extraTimeWindows.help",
    kind: "number",
    min: 0,
    max: 3,
    build: (v, values) => extraTimeSubsOf(values.extraTimeSubs, v),
    read: readNestedNumber("extraTimeSubs", "windows"),
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
    labelKey: "rules.field.sinBinMinutes.label",
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
    labelKey: "rules.field.abandon.label",
    kind: "select",
    options: abandonOptions(football),
    build: (v) => ({ abandonPolicy: v }),
    read: readText("abandonPolicy"),
  },
];
