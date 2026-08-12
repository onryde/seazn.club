// Field hockey — period-kernel preset (v6/00 §3/§4 + v6/01 §3, FIH Rules of
// Hockey 2026 + General Tournament Regulations App 12). Key `hockey` (matches
// the existing match-length/venue placeholders — v6/00 §6.3). 4×15 quarters,
// draws first-class (3/1/0), goal kinds FG / penalty corner / stroke, cards
// green 2' / yellow 5' / red permanent — the team plays short on ALL of them
// — and the App 12 shoot-out (5 one-on-ones, 8 s, sudden death) where a
// competition demands a winner.
import type { PositionCatalog } from "../../sport/catalog.ts";
import type { PlayerStatsModel } from "../../stats/stats.ts";
import { makePeriodModule, periodKeeperStatsFold, type PeriodSuspensionReason } from "../period/kernel.ts";
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
  ],
  awards: [{ key: "potm", label: "Player of the Match" }],
  // S8/#417 — `goals_conceded`, `clean_sheets`. "GK" matches this file's own
  // `positions` catalog above and the `keeperGroup` passed to
  // `makePeriodModule` below; see `periodKeeperStatsFold`'s own docstring for
  // the mechanism (reads the fold of `core.lineup.*`, never the kickoff
  // sheet) and the documented clean-sheet rule. `saves` is NOT declared here:
  // no save-shaped event exists on this kernel, and `so_saves` above already
  // covers the one place a defending keeper is named per-attempt (the
  // shoot-out) — see hockey/DOMAIN.md.
  folded: periodKeeperStatsFold("hockey.goal", "GK"),
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
    awardScore: { goals: 3 },
    abandonPolicy: "replay",
  },
  variants: {
    "fih-outdoor": {},
    // Pro-League style: a shoot-out settles drawn matches, SO win worth a
    // bonus point (App 12: 5 attempts, 8 s each, then sudden death).
    "fih-shootout": {
      shootout: { attempts: 5, suddenDeath: true, clockSeconds: 8 },
      points: { win: 3, draw: 1, loss: 0, shootoutWin: 2, shootoutLoss: 1 },
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
    // conversion (FIH is points → GD → GF → H2H), so nothing consults them for
    // ORDER today, and `display: false` keeps them out of the standings table.
    { key: "sp_pc_awarded", label: "PC awarded", direction: "desc", display: false },
    { key: "sp_pc_scored", label: "PC scored", direction: "desc", display: false },
    { key: "sp_pc_resolved", label: "PC resolved", direction: "desc", display: false },
    { key: "sp_stroke_awarded", label: "Strokes awarded", direction: "desc", display: false },
    { key: "sp_stroke_scored", label: "Strokes scored", direction: "desc", display: false },
    { key: "sp_stroke_resolved", label: "Strokes resolved", direction: "desc", display: false },
  ],
  // FIH standard: points → GD → GF → H2H (v6/00 §4).
  defaultTiebreakers: ["points", "diff", "for", "h2h_points", "seed"],
  officialLabel: { scorer: "Umpire" },
  suspensionReasons: HOCKEY_SUSPENSION_REASONS,
  shootoutLabel: "SO",
  timelineEntitlement: "scoring.match_timeline",
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
});
