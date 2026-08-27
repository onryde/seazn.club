// Volleyball — set-based preset (spec 04 §3 + engine/sports/volleyball.md).
// Indoor {5,25,15,2,null} + beach {3,21,15,2,null}; FIVB match-points convention
// (3-0/3-1 → 3:0, 3-2 → 2:1) via pointsMap; S/OH/MB/OPP/L catalog with a libero
// role (validation only — positions never touch scoring). The kernel owns all
// set logic; this file is configuration.
import type { PositionCatalog } from "../../sport/catalog.ts";
import { makeSetBasedModule, type SetBasedParams } from "./kernel.ts";

// spec 04 §3.4 — FIVB league convention. "*" (clean 3-0/3-1) → 3:0; the 3-2
// split is the only exception → 2:1. Total is 3 either way (declaredPointsSets).
const FIVB_POINTS: SetBasedParams["pointsMap"] = { "3-2": [2, 1], "*": [3, 0] };

// engine/sports/volleyball.md §5 — S (setter) / OH (outside) / MB (middle) /
// OPP (opposite) / L (libero); 6 on court, libero as a role tracked for lineups
// only (rotation is Pro-stat metadata, referees enforce it, not us).
const positions: PositionCatalog = {
  groups: [
    { key: "S", name: "Setter" },
    { key: "OH", name: "Outside hitter" },
    { key: "MB", name: "Middle blocker" },
    { key: "OPP", name: "Opposite" },
    { key: "L", name: "Libero" },
  ],
  roles: [{ key: "libero", name: "Libero" }], // up to 2 per team → not unique
  lineup: { size: 6, benchMax: 8 },
};

export const volleyball = makeSetBasedModule({
  key: "volleyball",
  version: "1.0.0",
  // Default = indoor (spec 04 §3.1).
  defaults: {
    bestOf: 5,
    setTo: 25,
    finalSetTo: 15,
    winBy: 2,
    cap: null,
    pointsMap: FIVB_POINTS,
    // W4 (#407) — the FIVB scoresheet carries all three: team + technical
    // timeouts, the substitution boxes (in/out numbers, six a set indoor) and
    // the sanction ladder (warning / penalty / expulsion / disqualification).
    records: { timeouts: true, sanctions: true, substitutions: true, expedite: false },
  },
  variants: {
    indoor: {},
    // Beach: pairs, best-of-3 to 21, deciding set to 15; simple 2-0 win points.
    // S6/#416 (W5) regression fix — beach has NO substitutions (FIVB Beach
    // Volleyball rules, §7: a 2-player pair has no bench to substitute from),
    // but `records` used to be a whole-module constant read once at
    // `makeSetBasedModule` call time, so beach silently inherited indoor's
    // `substitutions: true` and `apply()` wrongly accepted `volleyball.sub`
    // for a beach fixture. `records` now lives in cfg (SetBasedRecordFlags,
    // setbased/kernel.ts) precisely so a variant CAN disagree; every field is
    // restated (the kernel's nested-cfg-default convention — see the nested
    // kernel's `set`/`game`/`tiebreak`), preserving `timeouts`/`sanctions`
    // and flipping only `substitutions`.
    beach: {
      bestOf: 3,
      setTo: 21,
      finalSetTo: 15,
      pointsMap: { "*": [2, 0] },
      records: { timeouts: true, sanctions: true, substitutions: false, expedite: false },
    },
  },
  positions,
  // S3/W4b (#426) ruling 2 — FIVB 15.6, the two conditions on a re-entry, and
  // 19.3, the libero replacement that is not a substitution.
  //
  //  * `reentry: "once"` — a player who has left may come back once, and once
  //    only, in the same set.
  //  * `reentryPositionLock: true` — and only to the position they left. This
  //    is the half a generic "may they come back?" knob cannot express, and it
  //    is why `SquadMember.lastPositionKey` is recorded at the moment of
  //    leaving rather than derived afterwards.
  //  * `exemptions: { libero }`, UNCAPPED — a libero replacement is explicitly
  //    not a substitution (19.3.2.1), so it is charged here rather than to
  //    `maxSubs` and the six-a-set allowance is untouched by it.
  //
  // `maxSubs` is deliberately ABSENT, not six: the dossier's "timeout /
  // substitution allowances" row is a standing product decision that refusing
  // the seventh substitution would make a legitimate late correction
  // unrecordable. Nothing here changes that; charging the count is what makes
  // capping it a one-line change if the decision goes the other way.
  //
  // `allowSquadGrowth: false` — FIVB benches are named on the sheet.
  lineupPolicy: () => ({
    reentry: "once",
    reentryPositionLock: true,
    allowSquadGrowth: false,
    exemptions: { libero: {} },
  }),
  unitLabel: { one: "Set", many: "Sets" },
  // spec 04 §3.4 — points → matches won → set ratio → point ratio → h2h.
  defaultTiebreakers: ["points", "wins", "set_ratio", "point_ratio", "h2h_points"],
  officialLabel: { scorer: "Referee" }, // doc 13 §1
  coarseEventType: "set.summary",
  rallyEntitlement: "scoring.rally_by_rally", // doc 10 / volleyball.md §3
  // S7/#427 — the FIVB ladder verbatim; the kernel enum IS volleyball's own
  // vocabulary (DOMAIN.volleyball.md:38), so all four steps are on the pad.
  sanctionLevels: ["warning", "penalty", "expulsion", "disqualification"],
  // R5-1 — FIVB service.
  //  * 12.2.2: the team winning a rally serves the next one (side-out).
  //  * 7.1: sets 2-4 alternate the first service, and THE DECIDING SET IS
  //    TOSSED AFRESH — the one place the alternation stops. The reader reports
  //    `deciding-set-toss` at 0-0 of set five and recovers the moment the
  //    first rally of it is recorded, because side-out then answers for itself.
  //  * Beach 13.2 / 12.2: a pair keeps its service order through the set, so
  //    the declared `pairOrder` names the server for beach. Indoor sheets
  //    declare no pair order (and a six-long one is not a pair), so indoor
  //    names nobody: FIVB 7.6's court rotation is not folded here.
  //  * 19.3.2.4: a libero may not serve, so a libero is never NAMED even where
  //    the order would otherwise reach them. The side is still reported — the
  //    side is not in doubt.
  //  * 7.6.2: six positions, rotated one place each time the team takes the
  //    serve back. Reported only for a side with six players on court.
  serve: {
    within: "rally-winner",
    setStart: "alternate",
    decidingSetTossed: true,
    serverFromPairOrder: true,
    nonServingRoles: ["libero"],
    rotationCycle: 6,
  },
  // Entrant shapes are declared per sport, not per variant: indoor is 6v6 teams
  // (the default), `beach` is 2v2 pairs. Both kinds stay open at the sport level
  // and a division narrows them via config.entrants when the organiser wants.
  entrantModel: {
    kinds: ["team", "pair"],
    defaultKind: "team",
    team: { squadNumbers: true, captain: true },
  },
  // Jul3/07 §3 — unlocked by the rally's optional `server`/`scorer`. The
  // FIVB point-by-point grid records the serving player's number, so `serves`
  // is a scoresheet fact; `scorer` credits the terminating action.
  playerStats: {
    metrics: [
      { key: "points", label: "Points", from: "volleyball.rally", field: "scorer", agg: "count" },
      { key: "serves", label: "Serves", from: "volleyball.rally", field: "server", agg: "count" },
      {
        key: "sanctions",
        label: "Sanctions",
        from: "volleyball.sanction",
        field: "person",
        agg: "count",
      },
    ],
  },
});

// Jul3/06 §3 — the 12-Jun scoresheet: point-by-point columns per set,
// signature lines, final result, two matches per A4 (columnsHint: 2).
import type { ScoresheetInput } from "../../sport/module.ts";
import type { DocSection } from "../../exports/types.ts";

function pointTally(to: number): string {
  return Array.from({ length: to }, (_, i) => String(i + 1)).join(" ");
}

volleyball.exportTemplates = {
  scoresheet(input: ScoresheetInput, cfg): DocSection[] {
    const c = cfg as { bestOf?: number; setTo?: number; finalSetTo?: number };
    const bestOf = c.bestOf ?? 5;
    const setTo = c.setTo ?? 25;
    const finalTo = c.finalSetTo ?? 15;
    const rows: (string | number)[][] = [];
    for (let set = 1; set <= bestOf; set++) {
      const to = set === bestOf ? finalTo : setTo;
      rows.push([`Set ${set}`, input.home, pointTally(to)]);
      rows.push(["", input.away, pointTally(to)]);
    }
    return [
      {
        heading: `${input.home} vs ${input.away}`,
        subheading: [input.at, input.court, input.stageName]
          .filter((x): x is string => x !== undefined)
          .join(" · "),
        ...(input.homeColor !== undefined || input.awayColor !== undefined
          ? {
              swatches: [
                ...(input.homeColor !== undefined
                  ? [{ label: input.home, color: input.homeColor }]
                  : []),
                ...(input.awayColor !== undefined
                  ? [{ label: input.away, color: input.awayColor }]
                  : []),
              ],
            }
          : {}),
        table: { columns: ["Set", "Team", "Points"], rows },
        formLines: ["Final result: ________________", "Winner: ________________"],
        signatures: ["1st referee", "Scorer", `Captain — ${input.home}`, `Captain — ${input.away}`],
        columnsHint: 2,
      },
    ];
  },
};
