// Pure helpers for Swiss shell fixture minting and seating predicates.
//
// Client-safe on purpose: the stage generator, the stage rail, and unit tests
// must agree on board counts and seated/unseated rules without importing
// server-only modules.

import { isOneSidedAwardBye } from "@/lib/fixture-bye";

/** `HttpError.code` when a swiss stage is created (or a stage graph replaced)
 *  without a usable `config.rounds`. Lives HERE rather than in
 *  `server/usecases/stages.ts` because that module opens with
 *  `import "server-only"` — the organiser-facing panels that branch on this
 *  code are client components and could not import it from there. Same reason
 *  `lib/schedule-lock.ts` exists; see its header. */
export const SWISS_ROUNDS_REQUIRED_CODE = "STAGE_SWISS_ROUNDS_REQUIRED";

/** The English wire sentence. There is no server-side i18n in this repo
 *  (nothing under `src/server` reads Accept-Language, and the /api/v1 envelope
 *  carries no locale), so the server emits English for non-browser clients and
 *  the CODE above is what a panel translates — `stage.err.swissRoundsRequired`
 *  in the four ui.json dictionaries. */
export const SWISS_ROUNDS_REQUIRED_MESSAGE =
  "a swiss stage needs config.rounds — how many rounds it plays, a whole number of 1 or more";

export type SwissShellFixtureRef = {
  extKey: string;
  roundNo: number;
  seqInRound: number;
  /** true ⇒ bye shell (one side will become award on Pair) */
  bye: boolean;
};

export function swissBoardsForField(entrants: number): { boards: number; bye: boolean } {
  const n = Number.isFinite(entrants) ? Math.max(0, Math.trunc(entrants)) : 0;
  const boards = Math.floor(n / 2);
  const bye = n % 2 === 1;
  return { boards, bye };
}

export function planSwissShells(rounds: number, entrants: number): SwissShellFixtureRef[] {
  const { boards, bye } = swissBoardsForField(entrants);
  const plan: SwissShellFixtureRef[] = [];
  for (let roundNo = 1; roundNo <= rounds; roundNo++) {
    for (let b = 1; b <= boards; b++) {
      plan.push({
        extKey: `sw-r${roundNo}-b${b}`,
        roundNo,
        seqInRound: b,
        bye: false,
      });
    }
    if (bye) {
      plan.push({
        extKey: `sw-r${roundNo}-bye`,
        roundNo,
        seqInRound: boards + 1,
        bye: true,
      });
    }
  }
  return plan;
}

function isAwardOutcome(outcome: unknown): outcome is { kind: "award" } {
  return (
    typeof outcome === "object" &&
    outcome !== null &&
    "kind" in outcome &&
    (outcome as { kind: unknown }).kind === "award"
  );
}

export function isSwissBoardSeated(f: {
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  outcome: unknown;
}): boolean {
  if (isAwardOutcome(f.outcome)) return true;
  return f.home_entrant_id !== null && f.away_entrant_id !== null;
}

type SwissFixtureRow = {
  round_no: number;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  outcome: unknown;
  ext_key: string | null;
};

function roundIsFullySeated(
  fixtures: readonly SwissFixtureRow[],
  roundNo: number,
): boolean {
  const inRound = fixtures.filter((f) => f.round_no === roundNo);
  if (inRound.length === 0) return false;
  return inRound.every((f) =>
    isSwissBoardSeated({
      home_entrant_id: f.home_entrant_id,
      away_entrant_id: f.away_entrant_id,
      outcome: f.outcome,
    }),
  );
}

/** Lowest round that still has an unseated board; null if all seated. */
export function nextUnseatedSwissRound(fixtures: readonly SwissFixtureRow[]): number | null {
  const roundNos = [...new Set(fixtures.map((f) => f.round_no))].sort((a, b) => a - b);
  for (const roundNo of roundNos) {
    const inRound = fixtures.filter((f) => f.round_no === roundNo);
    const hasUnseated = inRound.some(
      (f) =>
        !isSwissBoardSeated({
          home_entrant_id: f.home_entrant_id,
          away_entrant_id: f.away_entrant_id,
          outcome: f.outcome,
        }),
    );
    if (hasUnseated) return roundNo;
  }
  return null;
}

/** Highest fully seated round; null if none seated. */
export function latestSeatedSwissRound(fixtures: readonly SwissFixtureRow[]): number | null {
  const roundNos = [...new Set(fixtures.map((f) => f.round_no))].sort((a, b) => a - b);
  let latest: number | null = null;
  for (const roundNo of roundNos) {
    if (roundIsFullySeated(fixtures, roundNo)) latest = roundNo;
  }
  return latest;
}

/**
 * Highest round holding AT LEAST ONE seated board — the round Unpair acts on
 * (2026-09-22).
 *
 * WHY this is not `latestSeatedSwissRound`. Deleting an entrant before Start
 * runs a bare `delete from entrants`; `fixtures.home_entrant_id` is
 * `on delete set null`, so the departed player's already-paired board survives
 * with ONE null slot beside neighbours that are still fully seated. That round
 * then answered every control with a refusal: reconcile refuses a partly
 * seated round, and Unpair — which asked for a WHOLLY seated round — did not
 * render at all. The organiser had no way forward from any button on the page.
 *
 * So the round Unpair TARGETS is the widest sensible one: anything holding a
 * seat can be cleared back onto its shells. Whether it MAY be cleared is a
 * separate question answered by `swissRoundHasPlayedResult` here and, on the
 * server, by the canonical `fixtureEvidenceSql` as well — two guards, neither
 * covering for the other. Widening the target deliberately does not widen the
 * permission.
 *
 * `latestSeatedSwissRound` survives because `swissGen`'s implicit-bye
 * inference needs the stricter question ("which rounds are COMPLETE"), and
 * answering that one with this one would walk the inference into a round that
 * was never finished.
 */
export function latestSwissRoundWithAnySeat(
  fixtures: readonly SwissFixtureRow[],
): number | null {
  const roundNos = [...new Set(fixtures.map((f) => f.round_no))].sort((a, b) => a - b);
  let latest: number | null = null;
  for (const roundNo of roundNos) {
    const seated = fixtures.some(
      (f) =>
        f.round_no === roundNo &&
        isSwissBoardSeated({
          home_entrant_id: f.home_entrant_id,
          away_entrant_id: f.away_entrant_id,
          outcome: f.outcome,
        }),
    );
    if (seated) latest = roundNo;
  }
  return latest;
}

/**
 * An `award` outcome with NO seat left on EITHER side — the wreck the
 * `on delete set null` FK makes of a bye row when its recipient is deleted
 * (2026-09-22).
 *
 * A bye is written `home = winner, away = null, status = 'forfeited',
 * outcome = {award, winner}` (stages.ts's swiss seating). Delete the winner
 * and the award and the status both survive while the seat does not, so the
 * row reads as a two-sided played result to `swissRoundHasPlayedResult` and as
 * SEATED to `isSwissBoardSeated`. That combination is why deleting the bye
 * holder produced a different dead end from deleting a board player: Generate
 * walked past the round as complete and threw "current swiss round has
 * undecided fixtures", while Unpair refused it as played.
 *
 * Nothing legitimate has this shape. A real two-sided award (forfeit,
 * retirement) names BOTH its sides — that is `isOneSidedAwardBye`'s whole
 * subject — and a live bye names one. An award naming neither names a row that
 * no longer exists.
 *
 * This is a CLIENT-side relaxation only. If such a row somehow did carry real
 * recorded data, the server's `fixtureEvidenceSql` still refuses it
 * independently; that guard is not weakened here and is tested on its own.
 */
function isOrphanedAwardShell(f: {
  outcome: unknown;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
}): boolean {
  return isAwardOutcome(f.outcome) && f.home_entrant_id === null && f.away_entrant_id === null;
}

/**
 * Statuses that are evidence a fixture has been played. Mirrors the status
 * arm of this repo's canonical destructive guard (`rebuildStageFixtures` in
 * `server/usecases/stages.ts`), `abandoned` included — an abandoned match was
 * PLAYED and stopped, and match-reports.ts accepts a report on exactly that
 * status.
 *
 * `forfeited` is in the list UNCONDITIONALLY, unlike the rebuild guard's
 * "two-sided forfeited" clause, because the bye exemption is applied here by
 * `isOneSidedAwardBye` instead — same rule, expressed once.
 */
const SWISS_PLAYED_STATUSES = new Set([
  "in_play",
  "decided",
  "finalized",
  "forfeited",
  "abandoned",
]);

/**
 * True if ANY row in `roundNo` shows evidence of play — owner ruling 3
 * (2026-09-20): "Unpair only if no matches started or scored for that round."
 *
 * Taken literally that would make every odd-field round un-unpairable,
 * because a bye IS a result row, so exactly one thing is exempt: a genuine
 * system-generated bye (`isOneSidedAwardBye`). A TWO-SIDED award — a real
 * forfeit or retirement — is a played match and blocks. That distinction is
 * the whole of C1: the predicate this used to call declared any award a bye,
 * which disabled this guard AND the caller's `score_events` guard at once.
 *
 * Two deliberate properties:
 *  - It scans EVERY row in the round, not a "non-bye" subset. A subset scan
 *    on a destructive path is how C1 shipped.
 *  - It is monotonic in the outcome, not only in the status. `fixtures.status`
 *    moves BACKWARDS when a `core.start` is voided (`append-event.ts`
 *    `fixtureStatusFromFold`), so status may only ADD refusals and can never
 *    be the sole test — an award outcome on a two-sided row refuses whatever
 *    the status says.
 *
 * The SERVER guard is strictly wider than this: `unpairSwissRound` also
 * consults score_events, match_states, match_reports, official_marks,
 * suspensions and `config_snapshot`. This function is the part the client
 * can evaluate, and it gates the Unpair button in `stages-panel.tsx`.
 */
export function swissRoundHasPlayedResult(
  fixtures: readonly {
    round_no: number;
    status: string;
    outcome: unknown;
    ext_key: string | null;
    home_entrant_id: string | null;
    away_entrant_id: string | null;
  }[],
  roundNo: number,
): boolean {
  return fixtures
    .filter((f) => f.round_no === roundNo)
    .some((f) => {
      // BOTH exemptions come first and both are about byes: a live one
      // (`isOneSidedAwardBye`) and one whose recipient has been deleted
      // (`isOrphanedAwardShell`). The orphan must also skip the STATUS test
      // below, not only the award test — the bye row is written `forfeited`,
      // so checking the outcome alone would leave the status still blocking.
      if (isOrphanedAwardShell(f)) return false;
      if (isOneSidedAwardBye(f)) return false;
      if (isAwardOutcome(f.outcome)) return true;
      return SWISS_PLAYED_STATUSES.has(f.status);
    });
}
