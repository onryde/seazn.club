// Football's curated match-rule fields. Client-safe: no "use client", no JSX,
// no `@/components` or `@/server` import.
import type { RuleField } from "./types.ts";

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
export function shootoutPointsPatch(values: Record<string, string>): Record<string, unknown> {
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

export const FOOTBALL_RULES: RuleField[] = [
  {
    key: "halfMinutes",
    edits: ["halfMinutes"],
    label: "Half length (minutes)",
    kind: "number",
    min: 5,
    max: 60,
    build: (v) => ({ halfMinutes: Number(v) }),
  },
  {
    key: "extraTime",
    edits: ["extraTime"],
    label: "Extra time",
    help: "Knockout fixtures only.",
    kind: "bool",
    build: (v) => ({ extraTime: { enabled: v === "on", halfMinutes: 15 } }),
  },
  {
    key: "shootout",
    edits: ["shootout"],
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
    edits: ["points"],
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
    edits: ["points"],
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
    edits: ["teamSize"],
    label: "Team size (players per side)",
    kind: "number",
    min: 5,
    max: 11,
    build: (v) => ({ teamSize: Number(v) }),
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
  },
  {
    key: "sinBinMinutes",
    edits: ["sinBinMinutes"],
    label: "Sin-bin length (minutes)",
    kind: "number",
    min: 1,
    max: 15,
    build: (v) => ({ sinBinMinutes: Number(v) }),
  },
];
