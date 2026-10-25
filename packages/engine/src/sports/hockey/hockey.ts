// Field hockey — period-kernel preset (v6/00 §3/§4 + v6/01 §3, FIH Rules of
// Hockey 2026 + General Tournament Regulations App 12). Key `hockey` (matches
// the existing match-length/venue placeholders — v6/00 §6.3). 4×15 quarters,
// draws first-class (3/1/0), goal kinds FG / penalty corner / stroke, cards
// green 2' / yellow 5' / red permanent — the team plays short on ALL of them
// — and the App 12 shoot-out (5 one-on-ones, 8 s, sudden death) where a
// competition demands a winner.
import { BRACKET_KINDS } from "../../core/types.ts";
import type { PositionCatalog } from "../../sport/catalog.ts";
import type { PlayerStatsModel } from "../../stats/stats.ts";
import { makePeriodModule, PERIOD_RULE_KEYS, periodKeeperStatsFold, type PeriodSuspensionReason } from "../period/kernel.ts";
import { HOCKEY_SUSPENSIONS, HOCKEY_YOUTH_SUSPENSIONS } from "../period/suspensions.ts";

// S4 (#428) — FIH's own subset of the shared `PeriodSuspensionReason` union:
// the physical-infraction core common to both codes on this kernel
// (tripping/hooking/obstruction/dangerous_play) plus FIH-specific
// (dissent/time_wasting) plus other. Deliberately SMALLER than icehockey's
// set and excludes every icehockey-only member (fighting, boarding,
// cross_checking, …) — an FIH card never offers those. Declared here, not
// enforced by the (shared) event schema — see kernel.ts's comment on
// PeriodSuspensionReason for why. Secondary-source sourced; see DOMAIN.md.
export const HOCKEY_SUSPENSION_REASONS: readonly PeriodSuspensionReason[] = [
  "tripping",
  "hooking",
  "obstruction",
  "dangerous_play",
  "dissent",
  "time_wasting",
  "other",
];

const positions: PositionCatalog = {
  groups: [
    { key: "GK", name: "Goalkeeper", min: 1, max: 1 },
    { key: "DF", name: "Defender" },
    { key: "MF", name: "Midfielder" },
    { key: "FW", name: "Forward" },
  ],
  roles: [{ key: "captain", name: "Captain", unique: true }],
  lineup: { size: 11, benchMax: 7 },
};

const playerStats: PlayerStatsModel = {
  metrics: [
    {
      key: "goals", label: "Goals", from: "hockey.goal", field: "person", agg: "count",
      when: (p) => p.kind !== "og",
    },
    {
      key: "green_cards", label: "Green cards", from: "hockey.suspension.start",
      field: "person", agg: "count", when: (p) => p.class === "green",
    },
    {
      key: "yellow_cards", label: "Yellow cards", from: "hockey.suspension.start",
      field: "person", agg: "count", when: (p) => p.class === "yellow",
    },
    {
      key: "red_cards", label: "Red cards", from: "hockey.suspension.start",
      field: "person", agg: "count", when: (p) => p.class === "red",
    },
    // W4 (#407) — the FIH match record splits goals by origin and names the
    // stroke taker and the shoot-out one-on-one pair.
    {
      key: "goals_pc", label: "PC goals", from: "hockey.goal", field: "person", agg: "count",
      when: (p) => p.kind === "pc",
    },
    {
      key: "goals_stroke", label: "Stroke goals", from: "hockey.goal", field: "person",
      agg: "count", when: (p) => p.kind === "stroke",
    },
    {
      key: "goals_en", label: "Empty-net goals", from: "hockey.goal", field: "person",
      agg: "count", when: (p) => p.emptyNet === true,
    },
    {
      key: "strokes_taken", label: "Strokes taken", from: "hockey.set_piece", field: "person",
      agg: "count", when: (p) => p.kind === "stroke",
    },
    {
      key: "pc_taken", label: "PCs taken", from: "hockey.set_piece", field: "person",
      agg: "count", when: (p) => p.kind === "pc",
    },
    { key: "so_attempts", label: "SO attempts", from: "hockey.shootout.attempt", field: "person", agg: "count" },
    {
      key: "so_goals", label: "SO goals", from: "hockey.shootout.attempt", field: "person",
      agg: "count", when: (p) => p.scored === true,
    },
    {
      key: "so_saves", label: "SO saves", from: "hockey.shootout.attempt", field: "goalkeeper",
      agg: "count", when: (p) => p.scored !== true,
    },
    {
      key: "cards_served", label: "Suspensions served", from: "hockey.suspension.start",
      field: "servedBy", agg: "count",
    },
    // S8/#417 W6 — the shooter's own tally from `hockey.shot`. `shots_faced`/
    // `saves`/`save_percentage` are the KEEPER side of this same event and
    // come from `periodKeeperStatsFold`'s `folded` escape hatch below (they
    // need the on-ice spell fold, which a declarative field+agg walk cannot
    // express); this shooter-side half is a plain metric because `person` is
    // an explicit payload field with no spell resolution needed.
    { key: "shots", label: "Shots", from: "hockey.shot", field: "person", agg: "count" },
    {
      key: "shots_on_target", label: "Shots on target", from: "hockey.shot", field: "person",
      agg: "count", when: (p) => p.outcome === "scored" || p.outcome === "saved",
    },
  ],
  awards: [{ key: "potm", label: "Player of the Match" }],
  // S8/#417 — `goals_conceded`, `clean_sheets`. "GK" matches this file's own
  // `positions` catalog above and the `keeperGroup` passed to
  // `makePeriodModule` below; see `periodKeeperStatsFold`'s own docstring for
  // the mechanism (reads the fold of `core.lineup.*`, never the kickoff
  // sheet) and the documented clean-sheet rule.
  // S8/#417 W6 — `saves`, `shots_faced`, `save_percentage` now ARE declared,
  // fed by `hockey.shot` (the 3rd argument, gated by this preset's own
  // `shotTracking: true` below). `so_saves` above is unaffected and still
  // covers only the shoot-out's per-attempt keeper credit — a different
  // event type this fold never matches, by construction.
  folded: periodKeeperStatsFold(() => hockey, "hockey.goal", "GK", "hockey.shot"),
};

export const hockey = makePeriodModule({
  key: "hockey",
  version: "1.0.0",
  // Default = FIH outdoor league: 4×15, draws stand, 3/1/0.
  defaults: {
    periods: { count: 4, minutes: 15 },
    overtime: null,
    shootout: null,
    points: { win: 3, draw: 1, loss: 0 },
    suspensions: { classes: HOCKEY_SUSPENSIONS },
    strength: { base: 11, min: 7 }, // players on the pitch; cards reduce
    goalKinds: ["fg", "pc", "stroke", "og"],
    assists: false,
    // HK-WO-1 (W2b): FIH General Tournament Regulations 13 award a walkover 5-0 (3 before W2b). A cfg frozen with 3
    // keeps its 3 — the credit reads the stage's own cfg (X-WO-1).
    awardScore: { goals: 5 },
    abandonPolicy: "replay",
  },
  variants: {
    "fih-outdoor": {},
    // Pro-League style: a shoot-out settles drawn matches, SO win worth a
    // bonus point (App 12: 5 attempts, 8 s each, then sudden death).
    "fih-shootout": {
      shootout: { attempts: 5, suddenDeath: true, clockSeconds: 8 },
      // W2d (B2, HK-PT-2): the shoot-out is a draw on the table plus a bonus point to its winner (2/1, booked D).
      points: { win: 3, draw: 1, loss: 0, soBonus: 1 },
      // HK-AB-2 (W2c, H-15): the FIH tournament rule - an abandon replays until the 4th quarter has started, then the
      // result stands (ruling 117 where the cfg refuses a draw).
      abandonPolicy: "q4_stands",
    },
    // W5 (#416) — regression fix, hockey/DOMAIN.md's "Other youth
    // divergences" row: `periods` was already correctly shortened, but
    // `strength`/`suspensions` were left at the adult 11-a-side figures, so
    // a real 7-a-side youth fixture reported the wrong strength chip
    // (AGENTS.md names this exact defect). `strength.base: 7` is the
    // confirmed figure; `min: 4` scales the adult ratio (7 of 11, ~64%) onto
    // the smaller roster rather than reusing adult's absolute 4-card
    // allowance, so a card threshold means roughly the same fraction of the
    // side either way. `HOCKEY_YOUTH_SUSPENSIONS` (period/suspensions.ts)
    // scales durations by the same 2/3 ratio `periods` already uses.
    //
    // Golden-corpus mechanics checked, not assumed, before this landed:
    // `verifyStream`/`recomputeStream` (testkit/golden.ts) read
    // `corpus.configs["youth"]` — a snapshot frozen on disk — and never
    // re-read this live `variants.youth` object, so this edit cannot move a
    // single byte of the 5 already-recorded "youth" streams. No re-baseline.
    youth: {
      periods: { count: 4, minutes: 10 },
      strength: { base: 7, min: 4 },
      suspensions: { classes: HOCKEY_YOUTH_SUSPENSIONS },
    },
  },
  // W2c Q10 (D9) - "If a match is abandoned": replay, the result as it stood, or the FIH 4th-quarter rule (HK-AB-2).
  abandonOptions: ["replay", "award", "q4_stands"],
  // W2c (spec §4.1 Q5) — the period kernel's keys, narrowed: FIH hockey has no overtime, so neither the stage key nor
  // its match-length leaf is offered (the X-SR-1 sweep holds `overtime` UNSETTABLE for hockey).
  ruleKeys: (({ overtime: _noOvertime, "overtime.minutes": _noOvertimeMinutes, ...keys }) => keys)(PERIOD_RULE_KEYS),
  // W2c X-SR-6 (spec §4.2) — the preset a NEW bracket stage should start with: the FIH shoot-out (5 one-on-ones, 8 s,
  // then sudden death), read from the module's own `fih-shootout` preset through its own schema (a fresh object on every
  // call, so a caller that edits its copy never reaches the preset); a table stage starts with none. Hockey has no
  // overtime. Stage creation writes it into `stages.config.rules` (apps/web stage-defaults.ts, W2c Task 12).
  stageDefaults: (kind) =>
    BRACKET_KINDS.has(kind) ? { shootout: hockey.configSchema.parse(hockey.variants["fih-shootout"]).shootout } : {},
  positions,
  keeperGroup: "GK",
  // S3/W4b (#426) ruling 2 — FIH Rule 5.2: substitution is UNLIMITED and
  // rolling. A player goes off and comes back as often as the coach likes, so
  // `reentry: "unlimited"`; there is no cap to charge them against, which is
  // why `maxSubs` is absent rather than set to some large number.
  //
  // `allowSquadGrowth: false` — FIH substitutes come from a pre-named bench
  // (`positions.lineup.benchMax`), so a lineup event naming somebody who is on
  // no team sheet is a scorer's mistake, and refusing it on the write path is
  // the kindest thing the fold can do. Only cricket's concussion replacement
  // genuinely arrives from outside the sheet.
  //
  // Takes `cfg` and ignores it TODAY: the competition knob that would vary it
  // (a youth division running no-return substitution, say) is a config
  // addition, and adding one to this module would leave `uncoveredConfigFields`
  // demanding an EXTEND_GOLDEN pass. The shape is here so that knob is a
  // one-line change rather than a re-plumb.
  lineupPolicy: () => ({
    reentry: "unlimited",
    reentryPositionLock: false,
    allowSquadGrowth: false,
  }),
  entrantModel: { kinds: ["team"], defaultKind: "team", team: { squadNumbers: true, captain: true } },
  metrics: [
    { key: "gf", label: "GF", direction: "desc" },
    { key: "ga", label: "GA", direction: "asc" },
    { key: "gd", label: "GD", direction: "desc" },
    { key: "goals_pc", label: "PC goals", direction: "desc", display: false },
    { key: "goals_stroke", label: "Stroke goals", direction: "desc", display: false },
    { key: "cards_green", label: "Green cards", direction: "asc", display: false },
    { key: "cards_yellow", label: "Yellow cards", direction: "asc", display: false },
    { key: "cards_red", label: "Red cards", direction: "asc", display: false },
    // Set-piece conversion, DISPLAY ONLY. Declared so `validateCascade` can see
    // the ledgers a future ratio comparator would need; no federation ranks on
    // conversion (FIH App. 3 is points, wins, GD, GF, H2H, field goals), so nothing consults them for
    // ORDER today, and `display: false` keeps them out of the standings table.
    { key: "sp_pc_awarded", label: "PC awarded", direction: "desc", display: false },
    { key: "sp_pc_scored", label: "PC scored", direction: "desc", display: false },
    { key: "sp_pc_resolved", label: "PC resolved", direction: "desc", display: false },
    { key: "sp_stroke_awarded", label: "Strokes awarded", direction: "desc", display: false },
    { key: "sp_stroke_scored", label: "Strokes scored", direction: "desc", display: false },
    { key: "sp_stroke_resolved", label: "Strokes resolved", direction: "desc", display: false },
  ],
  // W2d (SPEC §5.10, HK-TB-1): FIH GTR App. 3 — points, matches won, goal difference, goals for, the head-to-head
  // block, field goals, then lots (in place of FIH's ranking shoot-out, App. 3 §2 g-k — RB2B-11).
  defaultTiebreakers: ["points", "wins", "diff", "for", "h2h_points", "h2h_wins", "h2h_diff", "h2h_for", "field_goals", "lots"],
  // OC1: a Swiss stage keeps its pre-W2d order.
  swissTiebreakers: ["points", "diff", "for", "h2h_points", "seed"],
  // W2d (HK-PT-2): the Pro League preset — the module's own `fih-shootout` points read through its own schema and
  // its own `tablePointsRule`, so the preset is the variant and never a second hand-typed copy.
  tablePresets: (kind) => ({
    points: [{ id: "pro_league", rule: hockey.tablePointsRule(hockey.configSchema.parse(hockey.variants["fih-shootout"]), kind) }],
    tiebreakers: [],
  }),
  primaryTableKey: "points", // W2d (D11): the table ranks on points first.
  officialLabel: { scorer: "Umpire" },
  suspensionReasons: HOCKEY_SUSPENSION_REASONS,
  shootoutLabel: "SO",
  // W2d (B2, X-PT-4) — an FIH table books a shoot-out as a draw plus a bonus point; HK-TB-1 — FIH "matches won"
  // counts regulation wins only.
  shootoutAs: "draw_plus_bonus",
  winsCount: "regulation",
  playerStats,
  // SPEC-1 — FIH card grades the discipline rules editor may accumulate/ban on.
  disciplineColors: [
    { key: "green", label: "Green card" },
    { key: "yellow", label: "Yellow card" },
    { key: "red", label: "Red card" },
  ],
  // W4 (#407) — FIH Rules 13/14: a penalty corner and a penalty stroke are
  // recorded when AWARDED; the goal kinds only ever show the converted ones.
  setPieceKinds: ["pc", "stroke"],
  // S8/#417 W6 — shots on goal + save percentage (S2/#430's parked row,
  // `icehockey/DOMAIN.md`'s "Shots on goal"/"Saves and save percentage"
  // rows). See `PeriodPreset.shotTracking`'s own comment for why this is a
  // preset flag and not a cfg knob.
  shotTracking: true,
});
