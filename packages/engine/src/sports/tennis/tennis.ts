// Tennis — nested-kernel preset (v6/00 §2/§4 + v6/01 §1, ITF Rules of Tennis
// 2026). The kernel owns every line of point/game/set logic; this file is
// configuration: the four shipped variants, the (empty) position catalog and
// the league conventions. Singles vs doubles is the entrant kind (like
// badminton) — the module never inspects it.
import type { PositionCatalog } from "../../sport/catalog.ts";
import { makeNestedModule } from "../nested/kernel.ts";

// No positions; one nominated unit (player or pair) per side.
const positions: PositionCatalog = {
  groups: [],
  lineup: { size: 1, benchMax: 1 },
};

const nestedTennis = makeNestedModule({
  key: "tennis",
  version: "1.0.0",
  // Default = tour play (ITF Rules 5–7): best of 3 tie-break sets, TB7 at 6–6.
  defaults: {
    bestOf: 3,
    set: { gamesTo: 6, winBy: 2, tiebreakAt: 6, tiebreakTo: 7 },
    finalSet: "same",
    game: { noAd: false },
    tiebreak: { winBy: 2 },
    points: { win: 2, loss: 0 }, // common tennis-league convention
  },
  variants: {
    tour: {},
    // Slam rule (v6/00 §2 as amended): bo5, deciding set plays its tie-break
    // to 10 at 6–6 (finalSet.tiebreakTo — the games-level form, matching the
    // real rule rather than an App VI match tie-break replacing the set).
    "grand-slam": { bestOf: 5, finalSet: { tiebreakTo: 10 } },
    // ITF App VI short sets: to 4 games, TB at 3–3 (§1's alternative) to 5
    // with a deciding point at 4–4 (§2's short-set tie-break, margin 1; W2e
    // RB2A-12, TN-SS-2), no-ad games. A Fast4 config stored before W2e carries
    // no `tiebreakWinBy`; Task 13b's migration writes it an explicit 2 (D18).
    fast4: {
      set: { gamesTo: 4, winBy: 2, tiebreakAt: 3, tiebreakTo: 5, tiebreakWinBy: 1 },
      game: { noAd: true },
    },
    // The ITF doubles norm: no-ad games + a 10-point match tie-break as the
    // deciding set (App VI — MTB replaces the set at one set all).
    "doubles-noad-mtb10": {
      game: { noAd: true },
      finalSet: { matchTiebreakTo: 10 },
    },
    // W2e RB2A-12 (TN-SS-2): ITF App VI §1 short sets in their main form —
    // first to 4 games by 2, a tie-break at 4–4 — with §2's short-set
    // tie-break, first to 5 with a deciding point at 4–4 (margin 1). Ad games:
    // No-Ad is App VI's separate "score in a game" alternative (A0.2).
    "short-sets": {
      set: { gamesTo: 4, winBy: 2, tiebreakAt: 4, tiebreakTo: 5, tiebreakWinBy: 1 },
    },
  },
  positions,
  // S3/W4b (#426) ruling 2 — ITF Rule 30: a player who retires does not
  // resume, and there is no substitute in tennis. Every knob at its most
  // restrictive; declared rather than defaulted so the answer is the sport's,
  // and so padel arriving on this kernel has to state its own.
  lineupPolicy: () => ({
    reentry: "none",
    reentryPositionLock: false,
    allowSquadGrowth: false,
  }),
  entrantModel: { kinds: ["individual", "pair"], defaultKind: "individual" },
  // W2e (spec 2026-10-28 §5.2; D3 (1), D13; TN-SE-1): a `default` (the last step of the ITF Code of Conduct's point
  // penalty schedule) ends the match against the defaulted player; it is followed by its ending, core.forfeit
  // {reason: "disqualified"}, with X-RT-1's credit (TN-RT-1). The other three levels are records. No tennis level only
  // prompts (D12 is volleyball's).
  sanctionEnding: { eventType: "tennis.sanction", endLevels: ["default"], promptLevels: [] },
  // W2d (SPEC §5.10, TN-TB-1): 4.01 C.3 — matches won, then matches played, then for each of set and game ratio the
  // two-way head-to-head first; then the seed, then lots (the product's own final step).
  defaultTiebreakers: ["wins", "matches_played", "h2h_two", "set_ratio", "h2h_two", "game_ratio", "h2h_two", "seed", "lots"],
  // OC1: a Swiss stage keeps its pre-W2d order.
  swissTiebreakers: ["points", "set_ratio", "game_ratio", "h2h_points", "seed"],
  primaryTableKey: "wins", // W2d (D11): ATP C.3-1 — the number of matches won comes first.
  officialLabel: { scorer: "Chair Umpire" }, // ITF App VII
  // Jul3/07 §3 — unlocked by W4's optional `server`/`winner` on the point.
  // Aces and double faults are SERVING statistics, so both credit the server:
  // a double fault is a point for the receiver but a fault by the server, which
  // is exactly how the chair's card scores it.
  playerStats: {
    metrics: [
      { key: "points", label: "Points won", from: "tennis.point", field: "scorer", agg: "count" },
      {
        key: "service_points",
        label: "Service points",
        from: "tennis.point",
        field: "server",
        agg: "count",
      },
      {
        key: "aces",
        label: "Aces",
        from: "tennis.point",
        field: "server",
        agg: "count",
        when: (p) => (p.meta as { kind?: string } | undefined)?.kind === "ace",
      },
      {
        key: "double_faults",
        label: "Double faults",
        from: "tennis.point",
        field: "server",
        agg: "count",
        when: (p) => (p.meta as { kind?: string } | undefined)?.kind === "double_fault",
      },
      {
        key: "violations",
        label: "Code violations",
        from: "tennis.sanction",
        field: "person",
        agg: "count",
      },
      // W4a (#425) §5.4 — the fifth of the five coordinated edits a new event
      // type owes, because `tennis.interruption` carries person credit. Only
      // MEDICAL breaks: a toilet break or a rain delay is not a statistic about
      // a player, and counting them under one key would make "interruptions"
      // mean nothing on a leaderboard.
      {
        key: "medical_timeouts",
        label: "Medical timeouts",
        from: "tennis.interruption",
        field: "person",
        agg: "count",
        when: (p) => p.kind === "medical",
      },
    ],
  },
}, () => tennis);

// W2c (spec §4.1 Q5; plan finding 3) — the whole match format may differ per match: best-of, the set shape (games,
// tie-break point and target), the final set, no-ad games and the tie-break margin. Table points are the stage's (D11).
// Declared here, over the module the nested kernel returns, because the kernel's preset has no rule-key field and
// tennis is still its only sport; the self thunk above hands the kernel THIS binding.
export const tennis: typeof nestedTennis = {
  ...nestedTennis,
  ruleKeys: {
    bestOf: { scope: "match" },
    set: { scope: "match" },
    finalSet: { scope: "match" },
    "game.noAd": { scope: "match" },
    "tiebreak.winBy": { scope: "match" },
    points: { scope: "points" },
  },
};
