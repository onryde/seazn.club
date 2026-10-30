// Table tennis — set-based preset (spec 04 §5 + engine/sports/table-tennis.md).
// {5|7,11,11,2,null}: games to 11, win by 2, no cap (deuce runs 12-10, 15-13…),
// matches best of 5 (groups) or 7 (KO/finals).
//
// NOTE — team ties (Swaythling / modern ITTF club format: a "match" = 4–5
// individual matches, first to 3) are a *stage-level* feature: the competition
// engine aggregates child fixtures via Fixture.parent_fixture_id (schema
// reserves the column). That is NOT this module's concern — this module scores a
// single singles/doubles fixture only (table-tennis.md §4).
import type { PositionCatalog } from "../../sport/catalog.ts";
import { makeSetBasedModule, samePointsMap, SET_RULE_KEYS, type SetBasedParams, type SetBasedSanctionLevel } from "./kernel.ts";

// League convention 2/0 for the cfg's own map (`standingsDelta` reads it; configurable).
const TT_POINTS: SetBasedParams["pointsMap"] = { "*": [2, 0] };

// table-tennis.md §6 — no positions; singles/doubles/mixed = entrant kind (same
// as badminton). One nominated unit per side.
const positions: PositionCatalog = {
  groups: [],
  lineup: { size: 1, benchMax: 1 },
};

/** S7/#427 — the ITTF umpire has exactly two cards, yellow and red, and no third: "only `warning` and `penalty` correspond
 *  to the ITTF yellow and red cards; a pad should probably surface just those two" (DOMAIN.tabletennis.md:75-77).
 *  `expulsion`/`disqualification` are the REFEREE removing a player — not a card an umpire shows. The preset's
 *  `sanctionLevels`; exported for `@seazn/engine/pad` (pad wave P3.1), so the pad offers this very array. */
export const TABLETENNIS_SANCTION_LEVELS: readonly SetBasedSanctionLevel[] = ["warning", "penalty"];

export const tabletennis = makeSetBasedModule({
  key: "tabletennis",
  version: "1.0.0",
  // spec 04 §5 — ITTF: games to 11, win by 2, no cap; best of 5 by default.
  defaults: {
    bestOf: 5,
    setTo: 11,
    finalSetTo: 11,
    winBy: 2,
    cap: null,
    pointsMap: TT_POINTS,
    // W4 (#407) — the ITTF match sheet carries one timeout per player per
    // match and the umpire's card ladder (yellow warning → `warning`, red
    // penalty → `penalty`, removal → `expulsion`/`disqualification`). No
    // substitutions. W4a (#425) §5.3 — and the expedite system (ITTF Law
    // 2.15), which is table tennis's alone. Same for every declared variant
    // (no per-variant split here), so this lives only in `defaults`.
    records: { timeouts: true, sanctions: true, substitutions: false, expedite: true },
  },
  variants: {
    bo5: {},
    bo7: { bestOf: 7 }, // KO / finals
    "hardbat-21": { setTo: 21, finalSetTo: 21 }, // legacy/social — kernel unchanged
  },
  ruleKeys: Object.fromEntries(Object.entries(SET_RULE_KEYS).filter(([k]) => k !== "cap")), // W2c M-3 — the set kernel's keys bar `cap`: ITTF has none (the preset's cap is null), so no match is offered one
  // W2e ruling 31 (row TT-CF-1; spec 2026-10-28 §5.5, E15): however short an organiser makes the format, a set is played
  // to at least 5 points. A write door refuses a lower `setTo` or `finalSetTo` (`setTargetBelowFloor`); a stored config
  // below it still loads and plays.
  minSetTo: 5,
  positions,
  // S3/W4b (#426) ruling 2 — ITTF has no substitute: the pair named on the
  // sheet plays the match. Every knob at its most restrictive, which is also
  // `DEFAULT_LINEUP_POLICY`; stated explicitly so the answer is the sport's
  // rather than a default nobody chose, and so the volleyball/table-tennis
  // divergence on one shared kernel is visible in both files.
  lineupPolicy: () => ({
    reentry: "none",
    reentryPositionLock: false,
    allowSquadGrowth: false,
  }),
  unitLabel: { one: "Game", many: "Games" },
  // W2d (SPEC §5.10, TT-TB-1): ITTF 3.7.5 — match points, then only the matches among the tied: their match points,
  // games ratio and points ratio (3.7.5.2); once some are placed, their matches drop and the rest recompute
  // (3.7.5.3); then lots (3.7.5.4).
  defaultTiebreakers: ["points", "h2h_points", "h2h_set_ratio", "h2h_point_ratio", "h2h_exclusion", "lots"],
  // OC1: a Swiss stage keeps its pre-W2d order.
  swissTiebreakers: ["points", "wins", "set_ratio", "point_ratio", "h2h_points"],
  primaryTableKey: "points", // W2d (D11): ITTF match points first (a played loss pays 1).
  officialLabel: { scorer: "Umpire" }, // doc 13 §1
  coarseEventType: "game.summary",
  // S7/#427 — see TABLETENNIS_SANCTION_LEVELS. `expulsion`/`disqualification` are still accepted by `eventSchema`, so a
  // removal that was recorded (or a golden corpus payload) parses unchanged.
  sanctionLevels: TABLETENNIS_SANCTION_LEVELS,
  // R5-1 — ITTF service.
  //  * 2.13.3: two points each, whoever wins them — so the serve is a pure
  //    function of the game's score once the game's first server is known,
  //    and a partial score summary costs the rotation nothing.
  //  * 2.13.3's own deuce clause: once both are one short of the target, one
  //    point each. Derived from `setTo`/`finalSetTo`, so `hardbat-21`
  //    accelerates at 20-all with nothing extra declared. Expedite (2.15.3) is
  //    the same mechanic on an earlier trigger and the kernel already folds
  //    `state.expedite`.
  //  * 2.13.6: the first server of a game received first in the one before, so
  //    the sides alternate the opening serve.
  //  * 2.13.4: in doubles the pair alternates its own service turns, which IS
  //    the team sheet's declared `pairOrder` — the DOMAIN.tabletennis.md row
  //    `expectedDoublesServer` was built for, finally with a caller.
  serve: {
    within: "fixed-turns",
    turnLength: 2,
    acceleratesAtDeuce: true,
    setStart: "alternate",
    serverFromPairOrder: true,
  },
  entrantModel: { kinds: ["individual", "pair"], defaultKind: "individual" },
  // W2d (D6, PS-7a; ruling 108 amended) — a match the loser did not play pays it 0, not the played loss 1.
  declaresUnplayedLoss: true,
  // W2d (spec §5.10, D6; TT-PT-1) — table tennis's table pays 2/1/0: a played loss 1, an unplayed loss 0, where the
  // shipped map paid every loss 0. For the shipped map only: an organiser's own map pays as written.
  tablePointsRule: (cfg, fromMap) =>
    samePointsMap(cfg.pointsMap, TT_POINTS)
      ? { win: { regulation: 2 }, loss: { regulation: 1, unplayed: 0 }, shootoutAs: "result", unit: "whole", bonuses: [] }
      : fromMap,
  // `tabletennis.expedite.start` records that the umpire introduced the
  // expedite system, and every later rally carrying `returns` + `serving` is
  // judged against the receiver's thirteenth good return (see `records`
  // above).
  playerStats: {
    metrics: [
      { key: "points", label: "Points", from: "tabletennis.rally", field: "scorer", agg: "count" },
      { key: "serves", label: "Serves", from: "tabletennis.rally", field: "server", agg: "count" },
      {
        key: "sanctions",
        label: "Cards",
        from: "tabletennis.sanction",
        field: "person",
        agg: "count",
      },
    ],
  },
}, () => tabletennis);
