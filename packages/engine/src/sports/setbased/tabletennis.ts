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
import { makeSetBasedModule } from "./kernel.ts";

// table-tennis.md §6 — no positions; singles/doubles/mixed = entrant kind (same
// as badminton). One nominated unit per side.
const positions: PositionCatalog = {
  groups: [],
  lineup: { size: 1, benchMax: 1 },
};

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
    pointsMap: { "*": [2, 0] }, // league convention 2/0; configurable
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
  // spec 04 §5 / table-tennis.md §5 — matches → h2h → game ratio → point ratio.
  defaultTiebreakers: ["points", "wins", "set_ratio", "point_ratio", "h2h_points"],
  officialLabel: { scorer: "Umpire" }, // doc 13 §1
  coarseEventType: "game.summary",
  rallyEntitlement: "scoring.rally_by_rally", // doc 10 / table-tennis.md §3
  // S7/#427 — the ITTF umpire has exactly two cards, yellow and red, and no
  // third: "only `warning` and `penalty` correspond to the ITTF yellow and
  // red cards; a pad should probably surface just those two"
  // (DOMAIN.tabletennis.md:75-77). `expulsion`/`disqualification` are the
  // REFEREE removing a player — not a card an umpire shows, and not a control
  // that belongs on the umpire's pad. Still accepted by `eventSchema`, so a
  // removal that was recorded (or a golden corpus payload) parses unchanged.
  sanctionLevels: ["warning", "penalty"],
  entrantModel: { kinds: ["individual", "pair"], defaultKind: "individual" },
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
});
