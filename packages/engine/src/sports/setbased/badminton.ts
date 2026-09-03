// Badminton — set-based preset (spec 04 §4 + engine/sports/badminton.md).
// {3,21,21,2,30}: rally to 21, win by 2, hard cap 30 (29-29 → golden point,
// 30-29 wins) — the cap is the differentiator vs volleyball's uncapped endgame.
// Disciplines (MS/WS/MD/WD/XD) are entrant-kind + eligibility combinations, NOT
// module variants — one module serves all five, so there are no positions.
import type { PositionCatalog } from "../../sport/catalog.ts";
import { makeSetBasedModule } from "./kernel.ts";

// badminton.md §7 — no positions; singles vs doubles is the entrant kind
// (doc 02 §2), which the module never inspects (scoring reads only wonBy). One
// nominated unit per side.
const positions: PositionCatalog = {
  groups: [],
  lineup: { size: 1, benchMax: 1 },
};

export const badminton = makeSetBasedModule({
  key: "badminton",
  version: "1.0.0",
  // spec 04 §4 — game to 21, deciding game also to 21, hard cap 30.
  defaults: {
    bestOf: 3,
    setTo: 21,
    finalSetTo: 21,
    winBy: 2,
    cap: 30,
    // Typical league: flat win points (2/0); configurable per competition.
    pointsMap: { "*": [2, 0] },
    // W4 (#407) — BWF play has NO timeouts (only the interval at 11 and the
    // break between games) and NO substitutions; the umpire's sheet does
    // carry the misconduct card ladder, which maps onto the kernel's four
    // levels: yellow warning → `warning`, red fault → `penalty`, black →
    // `disqualification` (`expulsion` stays available for referee removal
    // from a game). Same for every declared variant — badminton has no
    // per-variant split here (unlike volleyball's beach), so this lives only
    // in `defaults`.
    records: { timeouts: false, sanctions: true, substitutions: false, expedite: false },
  },
  variants: {
    bwf: {},
    // Junior/social short format: to 11, cap 15 (badminton.md §2).
    short: { setTo: 11, finalSetTo: 11, cap: 15 },
  },
  positions,
  // S3/W4b (#426) ruling 2 — BWF Law 16 has no substitution: a player who
  // cannot continue retires and the match is over. Stated for the same reason
  // as table tennis's.
  lineupPolicy: () => ({
    reentry: "none",
    reentryPositionLock: false,
    allowSquadGrowth: false,
  }),
  unitLabel: { one: "Game", many: "Games" },
  // spec 04 §4 — points → matches → game ratio → point ratio → h2h. game_ratio
  // is the set_ratio key (games are the kernel's sets).
  defaultTiebreakers: ["points", "wins", "set_ratio", "point_ratio", "h2h_points"],
  officialLabel: { scorer: "Umpire" }, // doc 13 §1
  coarseEventType: "game.summary",
  // S7/#427 — BWF has THREE umpire cards and the black one is the reason this
  // list is per sport at all: yellow = `warning`, red = `penalty`, BLACK =
  // `disqualification` (DOMAIN.badminton.md:35). `expulsion` is the referee
  // removing a player from the match, which a badminton umpire's sheet does
  // record, so all four stay reachable here.
  sanctionLevels: ["warning", "penalty", "expulsion", "disqualification"],
  // R5-1 — BWF service, declared rather than keyed on the sport name.
  //  * Law 10.3 (singles; Law 11 in doubles): the side winning a rally serves
  //    the next one. So the LEDGER
  //    answers "who serves next" by itself from the second rally of a game
  //    onwards; a declaration is needed only for the very first rally of the
  //    match, and `game.summary`-only scoring.
  //  * Law 7.6: the side that won a game serves first in the next one — no
  //    alternation, and no toss after the first game.
  //  * No `serverFromPairOrder`: BWF Law 11 picks the doubles server by the
  //    SERVICE COURT the players are standing in, which changes only when the
  //    serving side wins a rally and which this kernel does not fold. The
  //    declared pair order cannot answer it, so badminton names no person —
  //    an omitted fact over a confident wrong one (DOMAIN.badminton.md's own
  //    "service court" row is still deferred).
  serve: { within: "rally-winner", setStart: "set-winner" },
  entrantModel: { kinds: ["individual", "pair"], defaultKind: "individual" },
  playerStats: {
    metrics: [
      { key: "points", label: "Points", from: "badminton.rally", field: "scorer", agg: "count" },
      { key: "serves", label: "Serves", from: "badminton.rally", field: "server", agg: "count" },
      {
        key: "sanctions",
        label: "Cards",
        from: "badminton.sanction",
        field: "person",
        agg: "count",
      },
    ],
  },
});
