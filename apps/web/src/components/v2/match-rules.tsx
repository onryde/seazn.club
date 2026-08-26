"use client";

// Match rules — curated per-sport fields that build the config override
// object (previously a raw-JSON textarea). Blank = keep the variant default;
// the pinned module's configSchema still validates server-side. Shared by
// the division builder and the division Settings tab (v8) so the two format
// editors can't drift. Field labels/options are sport-rules vocabulary, kept
// canonical/English like sport + format names; only the picker chrome
// (Default / On / Off) localizes.
import { useMsg } from "@/components/i18n/dict-provider";

export interface RuleField {
  key: string;
  label: string;
  help?: string;
  /** number input, or a Default/On/Off select for booleans, or an option list. */
  kind: "number" | "bool" | "select";
  min?: number;
  max?: number;
  options?: { value: string; label: string }[];
  /**
   * Maps the entered value onto the override object (top-level key).
   * `values` is the full raw form snapshot for this sport — read a sibling
   * key from it when one field must assemble a nested object that several
   * rendered inputs jointly describe (e.g. a clock or an overtime block).
   * A field that only renders its own input and contributes nothing on its
   * own returns {} unconditionally.
   */
  build: (value: string, values: Record<string, string>) => Record<string, unknown>;
  /**
   * Inverse of `build`: given the division's saved config, return this
   * field's current raw value (what the input should show on reopen), or
   * `undefined` if there is nothing to show. Optional — a field with no
   * `read` always reopens blank, same as every field did before
   * R3.5/Task Q. Only implemented so far for the two fields that bug was
   * actually reported against (shootoutWin/shootoutLoss): every other
   * field's `build` above either writes a DIFFERENT key than `field.key`,
   * derives a scaled/computed number, or chooses among several literal
   * shapes — a correct generic inverse would have to be as bespoke as
   * `build` itself, field by field, which is a bigger lift than this task
   * scoped. Leaving it unimplemented is not a regression: those fields are
   * exactly as blank-on-reopen as they always were.
   */
  read?: (config: Record<string, unknown>) => string | undefined;
}

const WIN_BY: RuleField = {
  key: "winBy",
  label: "Win margin (points)",
  help: "How many clear points are needed to win a set.",
  kind: "number",
  min: 1,
  max: 2,
  build: (v) => ({ winBy: Number(v) }),
};

const VOLLEYBALL_RULES: RuleField[] = [
  {
    key: "bestOf",
    label: "Best of (sets)",
    kind: "select",
    options: [1, 3, 5, 7].map((n) => ({ value: String(n), label: `Best of ${n}` })),
    build: (v) => ({ bestOf: Number(v) }),
  },
  {
    key: "setTo",
    label: "Points to win a set",
    kind: "number",
    min: 1,
    max: 100,
    build: (v) => ({ setTo: Number(v) }),
  },
  {
    key: "finalSetTo",
    label: "Points in the deciding set",
    kind: "number",
    min: 1,
    max: 100,
    build: (v) => ({ finalSetTo: Number(v) }),
  },
  {
    key: "cap",
    label: "Hard cap (deciding point)",
    help: "Must be at least the points needed to win a set. Blank inherits the variant's own cap, if it has one.",
    kind: "number",
    min: 15,
    max: 35,
    build: (v) => ({ cap: Number(v) }),
  },
  WIN_BY,
];

const BADMINTON_RULES: RuleField[] = [
  {
    key: "bestOf",
    label: "Best of (sets)",
    kind: "select",
    options: [1, 3].map((n) => ({ value: String(n), label: `Best of ${n}` })),
    build: (v) => ({ bestOf: Number(v) }),
  },
  {
    key: "setTo",
    label: "Points to win a set",
    kind: "number",
    min: 11,
    max: 30,
    build: (v) => ({ setTo: Number(v) }),
  },
  {
    key: "finalSetTo",
    label: "Points in the deciding set",
    kind: "number",
    min: 11,
    max: 30,
    build: (v) => ({ finalSetTo: Number(v) }),
  },
  {
    key: "cap",
    label: "Hard cap (deciding point)",
    help: "Must be at least the points needed to win a set. Blank inherits the variant default.",
    kind: "number",
    min: 15,
    max: 35,
    build: (v) => ({ cap: Number(v) }),
  },
  WIN_BY,
];

const TABLETENNIS_RULES: RuleField[] = [
  {
    key: "bestOf",
    label: "Best of (sets)",
    kind: "select",
    options: [1, 3, 5, 7].map((n) => ({ value: String(n), label: `Best of ${n}` })),
    build: (v) => ({ bestOf: Number(v) }),
  },
  {
    key: "setTo",
    label: "Points to win a set",
    kind: "number",
    min: 1,
    max: 100,
    build: (v) => ({ setTo: Number(v) }),
  },
  {
    key: "finalSetTo",
    label: "Points in the deciding set",
    kind: "number",
    min: 1,
    max: 100,
    build: (v) => ({ finalSetTo: Number(v) }),
  },
  WIN_BY,
];

export const SPORT_RULES: Record<string, RuleField[]> = {
  football: [
    {
      key: "halfMinutes",
      label: "Half length (minutes)",
      kind: "number",
      min: 5,
      max: 60,
      build: (v) => ({ halfMinutes: Number(v) }),
    },
    {
      key: "extraTime",
      label: "Extra time",
      help: "Knockout fixtures only.",
      kind: "bool",
      build: (v) => ({ extraTime: { enabled: v === "on", halfMinutes: 15 } }),
    },
    {
      key: "shootout",
      label: "Penalty shootout",
      help: "Knockout fixtures only.",
      kind: "bool",
      build: (v) => ({ shootout: v === "on" }),
    },
    // R3.5/Task I — cfg.points.shootoutWin/shootoutLoss have worked in the
    // engine since spec 04 (standingsDelta, football.ts) but had ZERO
    // references anywhere in apps/web, so no organiser could set them and
    // every group-stage fixture decided on kicks awarded flat win/loss.
    // NESTED inside `points`, not bare cfg keys — a UI writing a top-level
    // `shootoutWin` would parse, persist, and silently never fire.
    //
    // Both fields' build() reads BOTH raw values out of `values` (not just
    // its own) and re-emits whichever are actually set. buildRuleOverride's
    // outer loop does a bare `Object.assign` per field's return value, so if
    // each field only emitted its own key, the field processed LAST would
    // silently overwrite the other's contribution to `points` — there is no
    // other football field sharing a nested object today, so nothing else in
    // this array needs the same treatment yet.
    //
    // A blank field must emit NO key, not 0 — undefined is what turns the
    // split off (the engine gate reads `!== undefined`), and 0 is a legal
    // points value ("a shoot-out win is worth nothing"). The outer loop
    // already only calls build() when THIS field's own value is non-blank,
    // so leaving one field blank naturally emits just the other's key.
    //
    // Ruling (R3.5-6, recorded in _INDEX.md): the pairing requirement is
    // documented in both fields' help text rather than enforced by an
    // interactive validator — match-rules.tsx/MatchRuleFields has no
    // validation-error channel today, and the asymmetric case is already
    // safe (F21: the unset side just falls back to a normal win/loss, it
    // does not corrupt anything), so blocking the UI on it is not worth
    // being the first field in this file to need one.
    {
      key: "shootoutWin",
      label: "Points for a shoot-out win",
      help: "Group stages only, and only when Penalty shootout is on. Both this and the loss points below must be set for the split to apply — leave either blank to award a normal win/loss instead.",
      kind: "number",
      min: 0,
      max: 10,
      build: (v, values) => ({
        points: {
          shootoutWin: Number(v),
          ...(values.shootoutLoss !== undefined && values.shootoutLoss !== ""
            ? { shootoutLoss: Number(values.shootoutLoss) }
            : {}),
        },
      }),
      read: (config) => {
        const points = config.points as { shootoutWin?: number } | undefined;
        return points?.shootoutWin !== undefined ? String(points.shootoutWin) : undefined;
      },
    },
    {
      key: "shootoutLoss",
      label: "Points for a shoot-out loss",
      help: "Group stages only, and only when Penalty shootout is on. Both this and the win points above must be set for the split to apply — leave either blank to award a normal win/loss instead.",
      kind: "number",
      min: 0,
      max: 10,
      build: (v, values) => ({
        points: {
          shootoutLoss: Number(v),
          ...(values.shootoutWin !== undefined && values.shootoutWin !== ""
            ? { shootoutWin: Number(values.shootoutWin) }
            : {}),
        },
      }),
      read: (config) => {
        const points = config.points as { shootoutLoss?: number } | undefined;
        return points?.shootoutLoss !== undefined ? String(points.shootoutLoss) : undefined;
      },
    },
    {
      key: "teamSize",
      label: "Team size (players per side)",
      kind: "number",
      min: 5,
      max: 11,
      build: (v) => ({ teamSize: Number(v) }),
    },
    {
      key: "maxSubs",
      label: "Substitutes allowed",
      help: "Ignored when the variant already uses rolling subs.",
      kind: "number",
      min: 0,
      max: 10,
      build: (v) => ({ maxSubs: Number(v) }),
    },
    {
      key: "subWindows",
      label: "Substitution windows allowed",
      help: "Stoppages a side may use subs in — independent cap from Substitutes allowed. Blank = unlimited.",
      kind: "number",
      min: 0,
      max: 10,
      build: (v) => ({ subWindows: Number(v) }),
    },
    {
      key: "sinBinMinutes",
      label: "Sin-bin length (minutes)",
      kind: "number",
      min: 1,
      max: 15,
      build: (v) => ({ sinBinMinutes: Number(v) }),
    },
  ],
  cricket: [
    {
      key: "overs",
      label: "Overs per innings",
      kind: "number",
      min: 1,
      max: 100,
      build: (v) => ({ ballsPerInnings: Number(v) * 6 }),
    },
    {
      key: "maxOversPerBowler",
      label: "Max overs per bowler",
      kind: "number",
      min: 1,
      max: 50,
      build: (v) => ({ maxOversPerBowler: Number(v) }),
    },
    {
      key: "superOver",
      label: "Super over on a tie",
      help: "Knockout fixtures only.",
      kind: "bool",
      build: (v) => ({ superOver: v === "on" }),
    },
    {
      key: "dls",
      label: "DLS revised targets",
      help: "Pro feature — a manual umpire target works on every plan.",
      kind: "bool",
      build: (v) => ({ dls: { enabled: v === "on", edition: "standard" } }),
    },
    {
      key: "playersPerSide",
      label: "Players per side",
      kind: "number",
      min: 3,
      max: 11,
      build: (v) => ({ playersPerSide: Number(v) }),
    },
  ],
  volleyball: VOLLEYBALL_RULES,
  badminton: BADMINTON_RULES,
  tabletennis: TABLETENNIS_RULES,
  tennis: [
    {
      key: "bestOf",
      label: "Best of (sets)",
      kind: "select",
      options: [1, 3, 5].map((n) => ({ value: String(n), label: `Best of ${n}` })),
      build: (v) => ({ bestOf: Number(v) }),
    },
    {
      key: "setType",
      label: "Set type",
      kind: "select",
      options: [
        { value: "tb6", label: "Tie-break sets (to 6)" },
        { value: "fast4", label: "Fast4 (to 4, TB at 3–3)" },
        { value: "advantage", label: "Advantage sets" },
      ],
      // Nested config objects must be complete — a partial `set` fails the
      // pinned module schema (v8 gotcha).
      build: (v) => ({
        set:
          v === "fast4"
            ? { gamesTo: 4, winBy: 2, tiebreakAt: 3, tiebreakTo: 5 }
            : v === "advantage"
              ? { gamesTo: 6, winBy: 2, tiebreakAt: null, tiebreakTo: 7 }
              : { gamesTo: 6, winBy: 2, tiebreakAt: 6, tiebreakTo: 7 },
      }),
    },
    {
      key: "finalSet",
      label: "Deciding set",
      kind: "select",
      options: [
        { value: "same", label: "Same as other sets" },
        { value: "mtb10", label: "Match tie-break to 10" },
        { value: "mtb7", label: "Match tie-break to 7" },
        { value: "tb10", label: "Set with tie-break to 10" },
      ],
      build: (v) => ({
        finalSet:
          v === "mtb10"
            ? { matchTiebreakTo: 10 }
            : v === "mtb7"
              ? { matchTiebreakTo: 7 }
              : v === "tb10"
                ? { tiebreakTo: 10 }
                : "same",
      }),
    },
    {
      key: "noAd",
      label: "No-ad games",
      help: "A single deciding point at deuce.",
      kind: "bool",
      build: (v) => ({ game: { noAd: v === "on" } }),
    },
    {
      key: "tiebreakWinBy",
      label: "Tiebreak win margin",
      kind: "select",
      options: [
        { value: "2", label: "Win by two (standard)" },
        { value: "1", label: "Sudden death (first to target wins)" },
      ],
      build: (v) => ({ tiebreak: { winBy: Number(v) } }),
    },
  ],
  icehockey: [
    {
      key: "periodMinutes",
      label: "Period length (minutes)",
      kind: "number",
      min: 5,
      max: 30,
      build: (v) => ({ periods: { count: 3, minutes: Number(v) } }),
    },
    {
      key: "overtime",
      label: "Sudden-death overtime",
      help: "Only applies when set to On. IIHF default: 5 minutes, 3 skaters.",
      kind: "bool",
      build: (v, values) =>
        v === "on"
          ? {
              overtime: {
                kind: "sudden_death",
                minutes: Number(values.overtimeMinutes || 5),
                skaters: Number(values.overtimeSkaters || 3),
              },
            }
          : { overtime: null },
    },
    {
      key: "overtimeMinutes",
      label: "Overtime length (minutes)",
      help: "Only applies when sudden-death overtime above is On.",
      kind: "number",
      min: 3,
      max: 20,
      build: () => ({}),
    },
    {
      key: "overtimeSkaters",
      label: "Overtime skaters per side",
      help: "Only applies when sudden-death overtime above is On.",
      kind: "number",
      min: 3,
      max: 5,
      build: () => ({}),
    },
    {
      key: "shootout",
      label: "Shootout (GWS)",
      help: "Only applies when set to On.",
      kind: "bool",
      build: (v, values) =>
        v === "on"
          ? { shootout: { attempts: Number(values.shootoutAttempts || 5), suddenDeath: true } }
          : { shootout: null },
    },
    {
      key: "shootoutAttempts",
      label: "Shootout attempts",
      help: "Only applies when shootout above is On.",
      kind: "number",
      min: 3,
      max: 10,
      build: () => ({}),
    },
  ],
  hockey: [
    {
      key: "quarterMinutes",
      label: "Quarter length (minutes)",
      kind: "number",
      min: 5,
      max: 20,
      build: (v) => ({ periods: { count: 4, minutes: Number(v) } }),
    },
    {
      key: "shootout",
      label: "Shoot-out on a draw",
      help: "Only applies when set to On. FIH default: 5 attempts, 8 seconds each.",
      kind: "bool",
      build: (v, values) =>
        v === "on"
          ? {
              shootout: {
                attempts: Number(values.shootoutAttempts || 5),
                suddenDeath: true,
                clockSeconds: 8,
              },
            }
          : { shootout: null },
    },
    {
      key: "shootoutAttempts",
      label: "Shootout attempts",
      help: "Only applies when shoot-out above is On.",
      kind: "number",
      min: 3,
      max: 10,
      build: () => ({}),
    },
  ],
  boardgame: [
    {
      key: "variant",
      label: "Clock family",
      kind: "select",
      options: [
        { value: "classical", label: "Classical" },
        { value: "rapid", label: "Rapid" },
        { value: "blitz", label: "Blitz" },
      ],
      build: (v) => ({ variant: v }),
    },
    {
      key: "clockBaseMinutes",
      label: "Time per side (minutes)",
      help: "Leave blank to skip a clock override entirely.",
      kind: "number",
      min: 1,
      max: 180,
      build: (v, values) => {
        const clock: Record<string, number> = { base: Number(v) * 60 };
        if (values.clockIncrementSeconds) clock.increment = Number(values.clockIncrementSeconds);
        if (values.clockDelaySeconds) clock.delay = Number(values.clockDelaySeconds);
        return { clock };
      },
    },
    {
      key: "clockIncrementSeconds",
      label: "Increment per move (seconds, Fischer)",
      help: "Only applies when time per side above is set.",
      kind: "number",
      min: 0,
      max: 60,
      build: () => ({}),
    },
    {
      key: "clockDelaySeconds",
      label: "Move delay (seconds, Bronstein/US delay)",
      help: "Only applies when time per side above is set.",
      kind: "number",
      min: 0,
      max: 60,
      build: () => ({}),
    },
  ],
  carrom: [
    {
      key: "gameTo",
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
      label: "Max boards per game",
      help: "ICF: leader after 8 boards wins if untied.",
      kind: "number",
      min: 1,
      max: 20,
      build: (v) => ({ maxBoards: Number(v) }),
    },
    {
      key: "bestOf",
      label: "Best of (games)",
      kind: "select",
      options: [1, 3, 5].map((n) => ({ value: String(n), label: `Best of ${n}` })),
      build: (v) => ({ bestOf: Number(v) }),
    },
    {
      key: "queenPoints",
      label: "Queen bonus (points)",
      kind: "number",
      min: 0,
      max: 10,
      build: (v) => ({ queenPoints: Number(v) }),
    },
    {
      key: "queenCapAt",
      label: "Queen bonus cutoff (score)",
      help: "Must not exceed points to win a game.",
      kind: "number",
      min: 1,
      max: 50,
      build: (v) => ({ queenCapAt: Number(v) }),
    },
    {
      key: "queenFollowsBoard",
      label: "Queen always follows board winner",
      help: "House rule — skips tracking who covered the queen (ICF requires it).",
      kind: "bool",
      build: (v) => ({ queenFollowsBoard: v === "on" }),
    },
    {
      key: "tieBoard",
      label: "Game tied at max boards",
      kind: "select",
      options: [
        { value: "extra", label: "Sudden-death extra board (ICF)" },
        { value: "draw", label: "Drawn game (house rule; enables league draws)" },
      ],
      build: (v) => ({ tieBoard: v }),
    },
  ],
  generic: [
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
  ],
};

/** Merge every non-blank field into one override object. */
export function buildRuleOverride(
  sportKey: string,
  values: Record<string, string>,
): Record<string, unknown> {
  const override: Record<string, unknown> = {};
  for (const field of SPORT_RULES[sportKey] ?? []) {
    const value = values[field.key];
    if (value !== undefined && value !== "") Object.assign(override, field.build(value, values));
  }
  return override;
}

/**
 * Initial `ruleValues` for MatchRuleFields, derived from the division's
 * saved config through the SAME field list `buildRuleOverride` uses — so a
 * field whose `build` nests/renames/scales its value only has to teach its
 * own `read` the inverse, once, instead of a caller hand-listing keys per
 * sport (R3.5/Task Q: `ruleValues` used to never hydrate at all, so every
 * field showed blank on reopen no matter what was saved — most visibly
 * Task I's shootoutWin/shootoutLoss, since a blank pair reads as "unset"
 * and the engine gate requires both to be defined for the split to apply).
 */
export function hydrateRuleValues(sportKey: string, config: unknown): Record<string, string> {
  const cfg = (config ?? {}) as Record<string, unknown>;
  const values: Record<string, string> = {};
  for (const field of SPORT_RULES[sportKey] ?? []) {
    const value = field.read?.(cfg);
    if (value !== undefined) values[field.key] = value;
  }
  return values;
}

/** The builder's field grid, extracted verbatim so both editors share it. */
export function MatchRuleFields({
  sportKey,
  values,
  onChange,
  disabled = false,
}: {
  sportKey: string;
  values: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
  disabled?: boolean;
}) {
  const msg = useMsg();
  const fields = SPORT_RULES[sportKey] ?? [];
  if (fields.length === 0) return null;
  return (
    <div className="grid gap-4 sm:grid-cols-3">
      {fields.map((field) => (
        <label key={field.key} className="block">
          <span className="label">{field.label}</span>
          {field.kind === "number" ? (
            <input
              type="number"
              min={field.min}
              max={field.max}
              disabled={disabled}
              value={values[field.key] ?? ""}
              onChange={(e) => onChange({ ...values, [field.key]: e.target.value })}
              placeholder={msg("rules.default")}
              className="input"
            />
          ) : (
            <select
              disabled={disabled}
              value={values[field.key] ?? ""}
              onChange={(e) => onChange({ ...values, [field.key]: e.target.value })}
              className="select"
            >
              <option value="">{msg("rules.default")}</option>
              {field.kind === "bool" ? (
                <>
                  <option value="on">{msg("rules.on")}</option>
                  <option value="off">{msg("rules.off")}</option>
                </>
              ) : (
                (field.options ?? []).map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))
              )}
            </select>
          )}
          {field.help && (
            <span className="mt-0.5 block text-[11px] text-slate-400">{field.help}</span>
          )}
        </label>
      ))}
    </div>
  );
}
