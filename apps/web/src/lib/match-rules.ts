// Match rules — curated per-sport fields that build the config override
// object (previously a raw-JSON textarea). Blank = keep the variant default;
// the pinned module's configSchema still validates server-side. Shared by
// the division builder and the division Settings tab (v8) so the two format
// editors can't drift. Field labels/options are sport-rules vocabulary, kept
// canonical/English like sport + format names; only the picker chrome
// (Default / On / Off) localizes — and that chrome lives in the client
// component `@/components/v2/match-rules`, which re-exports everything here.
//
// NO "use client", NO JSX, NO `@/components` import, on purpose (design
// 2026-09-17 §T0): the server derives the per-stage rules allowlist from this
// table, and a `"use client"` module hands a server importer client
// REFERENCES rather than values. A vitest unit test of the derivation passes
// either way (node env, no RSC boundary), so a server-graph importer is the
// only thing that proves the extraction.

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
   * What to emit when THIS field's own raw value is BLANK. Most fields have
   * no opinion when blank — a blank `halfMinutes` leaves whatever's already
   * saved untouched (no `buildOnBlank`, nothing merged, exactly the
   * pre-R3.5-review behaviour). A field whose blank state must ACTIVELY
   * delete a previously-saved key (R3.5 review F5: shootoutWin/shootoutLoss)
   * implements this instead. Return `undefined` for a key here — never just
   * omit it — to signal "delete": division-settings.tsx's applyFormat
   * merges this return value on top of the division's existing saved
   * `points`, so omitting a key would leave that stale value in place, not
   * remove it. applyFormat resolves the `undefined` markers into a real
   * deletion before the PATCH goes out.
   */
  buildOnBlank?: (values: Record<string, string>) => Record<string, unknown>;
  /**
   * Inverse of `build`: given a saved config, return this field's current raw
   * value (what the input should show on reopen), or `undefined` if there is
   * nothing to show. Optional — a field with no `read` always reopens blank,
   * same as every field did before R3.5/Task Q.
   *
   * Report ONLY what the config actually carries; NEVER fall back to a
   * default. `hydrateRuleValues` is also fed a stage's rules FRAGMENT, where a
   * key's absence is meaningful — it means "inherit the division" — so a
   * defaulting `read` would make every field look overridden and the
   * organiser's first save would pin the whole division format onto the stage.
   *
   * Implemented for the two fields the original bug was reported against
   * (shootoutWin/shootoutLoss) and for the nine sets-based keys the per-stage
   * override covers (bestOf, setTo, finalSetTo, cap, winBy, and tennis's
   * setType/finalSet/noAd/tiebreakWinBy). The rest stay unimplemented, and
   * that is not a regression: a `build` that writes a DIFFERENT key than
   * `field.key`, derives a scaled number, or picks among several literal
   * shapes needs an inverse as bespoke as itself, field by field.
   */
  read?: (config: Record<string, unknown>) => string | undefined;
}

/**
 * The inverse of the `build: (v) => ({ <key>: Number(v) })` shape that thirteen
 * of the sets-based fields share. Deliberately reports ONLY what the config it
 * is handed actually carries: `hydrateRuleValues` is fed a stage's rules
 * FRAGMENT, and a `read` that fell back to a default would make every field
 * look overridden and turn the organiser's first save into a pin of the whole
 * division format. A value of the wrong type reads as blank rather than as a
 * confident wrong number.
 */
const readNumber =
  (key: string) =>
  (config: Record<string, unknown>): string | undefined =>
    typeof config[key] === "number" ? String(config[key]) : undefined;

/**
 * Tennis's `setType` and `finalSet` are the only fields whose `build` emits a
 * different nested object per option, so they are the only ones whose inverse
 * could drift away from it. Both directions read these tables, so there is one
 * source of truth rather than a hand-written inverse that silently stops
 * matching the day an option's shape is edited.
 *
 * Nested config objects must be COMPLETE — a partial `set` fails the pinned
 * module schema (v8 gotcha) — so each entry carries every key.
 */
const TENNIS_SET_SHAPES: Record<string, Record<string, unknown>> = {
  tb6: { gamesTo: 6, winBy: 2, tiebreakAt: 6, tiebreakTo: 7 },
  fast4: { gamesTo: 4, winBy: 2, tiebreakAt: 3, tiebreakTo: 5 },
  advantage: { gamesTo: 6, winBy: 2, tiebreakAt: null, tiebreakTo: 7 },
};

/** `"same"` is a bare string here, not an object — the engine's own encoding. */
const TENNIS_FINAL_SET_SHAPES: Record<string, unknown> = {
  same: "same",
  mtb10: { matchTiebreakTo: 10 },
  mtb7: { matchTiebreakTo: 7 },
  tb10: { tiebreakTo: 10 },
};

/**
 * Exact match on a whole nested object, extra keys included. A config carrying
 * a shape no option declares (hand-edited, or written by another path) must
 * hydrate blank rather than be rounded to the nearest option and then silently
 * rewritten to it on the next save.
 */
function sameShape(shape: Record<string, unknown>, value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  const keys = Object.keys(shape);
  return keys.length === Object.keys(v).length && keys.every((k) => v[k] === shape[k]);
}

/** The option whose declared shape the config carries, or `undefined`. */
function readShape(
  shapes: Record<string, unknown>,
  value: unknown,
): string | undefined {
  if (value === undefined) return undefined;
  for (const [option, shape] of Object.entries(shapes)) {
    if (typeof shape === "object" && shape !== null) {
      if (sameShape(shape as Record<string, unknown>, value)) return option;
    } else if (shape === value) return option;
  }
  return undefined;
}

const WIN_BY: RuleField = {
  key: "winBy",
  label: "Win margin (points)",
  help: "How many clear points are needed to win a set.",
  kind: "number",
  min: 1,
  max: 2,
  build: (v) => ({ winBy: Number(v) }),
  read: readNumber("winBy"),
};

const VOLLEYBALL_RULES: RuleField[] = [
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
  {
    key: "cap",
    label: "Hard cap (deciding point)",
    help: "Must be at least the points needed to win a set. Blank inherits the variant's own cap, if it has one.",
    kind: "number",
    min: 15,
    max: 35,
    build: (v) => ({ cap: Number(v) }),
    read: readNumber("cap"),
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

const TABLETENNIS_RULES: RuleField[] = [
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

/** R3.5 review F5 — the shoot-out points pair's shared "what should be
 *  persisted" computation (see the shootoutWin/shootoutLoss fields below for
 *  why this has to be one function called from both `build` and
 *  `buildOnBlank`, not two independent ones). `undefined` is the explicit
 *  delete signal `RuleField.buildOnBlank` documents — the engine's split
 *  gate needs both `points.shootoutWin`/`shootoutLoss` defined
 *  (football.ts:2602-2603), so "one set, one blank" has no meaning: either
 *  both are set, or neither key is persisted.
 *
 *  The early `{}` return when BOTH raw values are absent (not merely blank)
 *  matters: `buildOnBlank` now fires for this field on every save where the
 *  organiser never touched shoot-out points at all (a fresh division, or an
 *  unrelated field like maxSubs), and `values` simply has no
 *  shootoutWin/shootoutLoss keys in that case. Without this guard the pair
 *  would emit a delete-marker on EVERY football save regardless of subject —
 *  harmless once division-settings.tsx's applyFormat strips it against a
 *  `points` object that never had the keys either, but it turns
 *  `buildRuleOverride`'s own return value into a poor pin of "what did this
 *  save actually touch" (see match-rules.test.ts's "football's two
 *  independent substitution caps" — that suite has nothing to do with
 *  shoot-out points and must see a clean, minimal object). A key present as
 *  `""` (hydrated then explicitly cleared, or the sibling never saved but
 *  THIS field just got typed into) still means "the organiser touched this
 *  pair" and must still resolve to real values or a delete. */
function shootoutPointsPatch(values: Record<string, string>): Record<string, unknown> {
  const win = values.shootoutWin;
  const loss = values.shootoutLoss;
  if (win === undefined && loss === undefined) return {};
  const bothSet = win !== undefined && win !== "" && loss !== undefined && loss !== "";
  return {
    points: bothSet
      ? { shootoutWin: Number(win), shootoutLoss: Number(loss) }
      : { shootoutWin: undefined, shootoutLoss: undefined },
  };
}

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
    // R3.5 review finding F5 (BLOCKER, fixed): the pairing requirement is
    // documented in both fields' help text ("leave either blank to award a
    // normal win/loss instead") but that promise wasn't true — a blank field
    // emitted NO key at all, and division-settings.tsx's `applyFormat` seeds
    // its override from `{...division.config}`, so a stale saved value just
    // rode along unchanged. Clearing a box did nothing; the old pair kept
    // paying out forever.
    //
    // Owner ruling: blank in EITHER box deletes BOTH keys — that is what the
    // help text already promises (and content/help/scoring/
    // knockout-deciders.md), and it makes "turn this off" one action rather
    // than an error the organiser has to decode. `shootoutPointsPatch` below
    // is the ONE place that decides the pair's fate, called from BOTH
    // fields' `build` (own value non-blank) and `buildOnBlank` (own value
    // blank) so the result is identical no matter which field is filled,
    // which is blank, or which one buildRuleOverride's loop processes last —
    // the same "reconstruct the full nested object from every raw value,
    // every time" discipline the pre-fix version used, just extended to the
    // blank case too. Returning `undefined` (not omitting the key) is what
    // tells applyFormat's merge to actually delete it — see RuleField.
    {
      key: "shootoutWin",
      label: "Points for a shoot-out win",
      help: "Group stages only, and only when Penalty shootout is on. Both this and the loss points below must be set for the split to apply — leave either blank to award a normal win/loss instead.",
      kind: "number",
      min: 0,
      max: 10,
      build: (_v, values) => shootoutPointsPatch(values),
      buildOnBlank: (values) => shootoutPointsPatch(values),
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
      build: (_v, values) => shootoutPointsPatch(values),
      buildOnBlank: (values) => shootoutPointsPatch(values),
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
      read: readNumber("bestOf"),
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
      // Unknown values keep falling through to `tb6`, as the chained ternary
      // this replaced did. Copied, not shared by reference: the result is
      // spread into a config the caller owns.
      build: (v) => ({ set: { ...(TENNIS_SET_SHAPES[v] ?? TENNIS_SET_SHAPES.tb6!) } }),
      // Reads `set`, NOT `setType` — the field key and the config key differ
      // for three of tennis's five fields (see `configKeysFor`).
      read: (config) => readShape(TENNIS_SET_SHAPES, config.set),
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
      build: (v) => {
        const shape = TENNIS_FINAL_SET_SHAPES[v] ?? "same";
        return { finalSet: typeof shape === "object" && shape !== null ? { ...shape } : shape };
      },
      read: (config) => readShape(TENNIS_FINAL_SET_SHAPES, config.finalSet),
    },
    {
      key: "noAd",
      label: "No-ad games",
      help: "A single deciding point at deuce.",
      kind: "bool",
      build: (v) => ({ game: { noAd: v === "on" } }),
      // Reads `game`. A non-boolean `noAd` hydrates blank rather than
      // coercing a truthy string into a checked box.
      read: (config) => {
        const game = config.game;
        if (typeof game !== "object" || game === null) return undefined;
        const noAd = (game as { noAd?: unknown }).noAd;
        return typeof noAd === "boolean" ? (noAd ? "on" : "off") : undefined;
      },
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
      // Reads `tiebreak`, not `tiebreakWinBy`.
      read: (config) => {
        const tiebreak = config.tiebreak;
        if (typeof tiebreak !== "object" || tiebreak === null) return undefined;
        const winBy = (tiebreak as { winBy?: unknown }).winBy;
        return typeof winBy === "number" ? String(winBy) : undefined;
      },
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
    if (value !== undefined && value !== "") {
      Object.assign(override, field.build(value, values));
    } else if (field.buildOnBlank) {
      Object.assign(override, field.buildOnBlank(values));
    }
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

/** The four sports whose stages may override match format (design D2a). */
export const STAGE_RULES_SPORTS: ReadonlySet<string> = new Set([
  "tennis",
  "badminton",
  "tabletennis",
  "volleyball",
]);

/** Every value a field can produce, so a build() that BRANCHES on its value
 *  cannot hide a config key behind an option we never probed. */
function probeValuesFor(field: RuleField): string[] {
  if (field.kind === "select") return (field.options ?? []).map((o) => o.value);
  if (field.kind === "bool") return ["on", "off"];
  return [String(field.min ?? 1)];
}

/** The CONFIG keys an arbitrary field list can write. Exported separately from
 *  `configKeysFor` so a synthetic field — one whose `build` actually BRANCHES
 *  its key set on the value — can be passed in: no field of any in-scope sport
 *  does that today (carrom's `gameTo` is the only one in the whole table), so
 *  without such a test the probe loop above is an unwitnessed guard. */
export function keysEmittedBy(fields: RuleField[]): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const field of fields) {
    for (const probe of probeValuesFor(field))
      for (const k of Object.keys(field.build(probe, {}))) keys.add(k);
    if (field.buildOnBlank) for (const k of Object.keys(field.buildOnBlank({}))) keys.add(k);
  }
  return keys;
}

/** The CONFIG keys a sport's rule fields can write — NOT their field keys.
 *  `division-settings.tsx:273` maps `f.key`; copying that here would 400 four
 *  of tennis's five overrides, because `build` renames three of them. */
export function configKeysFor(sportKey: string): ReadonlySet<string> {
  return keysEmittedBy(SPORT_RULES[sportKey] ?? []);
}
