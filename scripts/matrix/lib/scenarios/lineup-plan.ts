// One lineup rule for the scenario harness (common.ts ensureLineups) and the
// reference model (lib/model/state.ts ensureModelLineups) — W1-driving Task 14
// fix round 1 (T14-R3). Which sides of a fixture are owed a lineup, the gate
// that stops a PUT once a fixture is past scheduled, the refusals of a side
// with no roster, the PUT order, how a warning is judged and the items the
// lineup check counts all live here once; each caller hands in its division,
// the ledger it records PUTs in, and its sinks (a note or a finding; a
// LineupWarned or a ModelViolation). A rule changed here reaches both.
import type { EntrantMember, OrganiserDriver } from "../driver/types.ts";
import { SIDE_SIZE_FOUND, SIDE_SIZE_KIND, SIDE_SIZE_ROUTE, lineupFor, lineupWarningKind } from "./rosters.ts";

/** Where a caller records the lineups it PUT: the Recorder and the
 *  ModelState both carry these two fields, under these names. Keyed on
 *  fixture AND side (T45-R2): confirm seats a later stage's TBD row, and a
 *  take-back re-fills a fed seat, under the same fixture id. */
export interface LineupLedger {
  readonly lineupSides: Map<string, Set<string>>;
  lineupsPut: number;
}

/** The division a fixture's lineups are planned for. */
export interface LineupDivision {
  readonly sport: string;
  readonly variant: string;
  readonly cfg: unknown;
  readonly kind: string;
  /** A rosterless setup (PADPROOF, D3) scores team fixtures with no lineup. */
  readonly rosterless: boolean;
  /** The division's own entrants: a side outside them was minted by a stage. */
  readonly entrantIds: ReadonlySet<string>;
  /** Each division entrant's roster as the product read it back. */
  readonly rosters: ReadonlyMap<string, readonly EntrantMember[]>;
  /** The kind of the stage a fixture sits on; undefined for a stage the caller never built. */
  stageKindOf(stageId: string): string | undefined;
}

/** A fixture as the planner reads it; `status` is the one the caller last read. */
export interface LineupFixture {
  readonly id: string;
  readonly stageId: string;
  readonly home: string | null;
  readonly away: string | null;
  readonly status: string;
}

/** A warning the planner could not excuse, for the caller to turn into its own error. */
export interface LineupWarning { readonly row: string; readonly fixtureId: string; readonly entrantId: string; readonly kind: string | null; readonly warning: string }

/** Each caller's sinks. The planner builds every line; a sink decides only
 *  what a line becomes (a note, a finding) and which error a warning is. */
export interface LineupSink {
  /** The refusals' prefix ("scenario", "model"). */
  readonly prefix: string;
  /** Who came to the fixture, in the locked line ("harness", "model"). */
  readonly actor: string;
  /** The fixture was past scheduled: no PUT. */
  locked(line: string): void;
  /** An americano stage's product-minted pair entrant: no PUT. */
  pairSideSkipped(line: string): void;
  /** The known side-size warning on its own row. */
  knownWarning(line: string): void;
  /** Any other warning: the error the planner throws. */
  warned(w: LineupWarning): Error;
}

/** T3-R1's words for a warning that is not the known side-size finding. */
export function lineupWarningLine(row: string, fixtureId: string, entrantId: string, kind: string | null, warning: string): string {
  return `the product warned on the ${row} lineup for entrant ${entrantId} on fixture ${fixtureId} — [${kind ?? "unclassified"}] ${warning}; only a ${SIDE_SIZE_KIND} warning on a known side-size row (${SIDE_SIZE_FOUND.join(", ")}) is expected`;
}

/** T3-R1: the known side-size warning on its own row goes to the sink's
 *  knownWarning; any other warning is thrown, as the sink's own error. */
export function judgeLineupWarnings(div: Pick<LineupDivision, "sport" | "variant">, fixtureId: string, entrantId: string, warnings: readonly string[], sink: LineupSink): void {
  const row = `${div.sport}/${div.variant}`;
  for (const w of warnings) {
    const kind = lineupWarningKind(w);
    if (kind !== SIDE_SIZE_KIND || !SIDE_SIZE_FOUND.includes(row)) throw sink.warned({ row, fixtureId, entrantId, kind, warning: w });
    sink.knownWarning(`${row} [${kind}] ${w} — the known side-size finding (rosters.ts SIDE_SIZE_ROUTE) → ${SIDE_SIZE_ROUTE.wave}`);
  }
}

/** Fold-in beneath ruling 49: on a team division, each side of `f` gets its
 *  lineup PUT once — keyed on fixture AND side (T45-R2), so a side met empty,
 *  or re-filled by another entrant, is owed once it is seated — while `f` is
 *  still scheduled, before the caller posts anything to it. Members alone
 *  never reach the engine, which reads per-fixture lineups only (engine-db
 *  loadLineupPair).
 *  - Past scheduled: no PUT (the product locks a lineup), the sink's `locked`.
 *  - A side that is not a division entrant: on an americano stage, a
 *    product-minted pair entrant (stages.ts pairEntrantsFor), skipped through
 *    the sink; on any other kind, refused by name (T45-R3) — nothing else
 *    mints entrants.
 *  - A division entrant with no recorded roster: refused by name.
 *  Sides are PUT home first, then away. */
export async function putOwedLineups(driver: Pick<OrganiserDriver, "putLineup">, div: LineupDivision, ledger: LineupLedger, f: LineupFixture, sink: LineupSink): Promise<void> {
  if (div.rosterless || div.kind !== "team") return;
  const done = ledger.lineupSides.get(f.id) ?? new Set<string>();
  const owed = [f.home, f.away].filter((side): side is string => side !== null && !done.has(side));
  if (owed.length === 0) return;
  if (f.status !== "scheduled") {
    sink.locked(`${f.id} was ${f.status} when the ${sink.actor} came to it — the product locks a lineup once a fixture is past scheduled; no lineup PUT`);
    return;
  }
  for (const side of owed) {
    if (!div.entrantIds.has(side)) {
      const kind = div.stageKindOf(f.stageId);
      if (kind !== "americano") throw new Error(`${sink.prefix}: fixture ${f.id} seats ${side}, which is not a division entrant, on ${kind === undefined ? `stage ${f.stageId}, which the setup never built` : `a ${kind} stage`} — only an americano stage mints its own (pair) entrants`);
      sink.pairSideSkipped(`stage ${f.stageId} seats a side that is not a division entrant (a product-minted pair entrant) — no lineup PUT for such a side`);
      continue;
    }
    const members = div.rosters.get(side);
    if (members === undefined) throw new Error(`${sink.prefix}: fixture ${f.id} seats division entrant ${side}, which has no recorded roster`);
    const check = await driver.putLineup(f.id, side, lineupFor(div.sport, div.cfg, members));
    ledger.lineupsPut++;
    done.add(side);
    ledger.lineupSides.set(f.id, done);
    judgeLineupWarnings(div, f.id, side, check.warnings, sink);
  }
}

/** The sides of a posted team fixture the lineup check holds to a PUT (final review m-4): its seated sides that are
 *  division entrants, home then away — a product-minted pair side owes none. ONE filter for the harness (common.ts
 *  decideFixture) and the model (commands.ts post); whether a division is team and not rosterless stays with each caller. */
export function postedTeamSides(home: string | null, away: string | null, isEntrant: (entrantId: string) => boolean): string[] {
  return [home, away].filter((e): e is string => e !== null && isEntrant(e));
}

/** The lineup check's items (assertions.ts lineupsPut, "life-lineups-put";
 *  the model's "model-lineups-put"): one per side of every team fixture the
 *  caller posted to, ok iff that side's lineup was PUT. */
export function lineupItems(teamPosts: ReadonlyMap<string, readonly string[]>, lineupSides: ReadonlyMap<string, ReadonlySet<string>>): { ok: boolean; note: string }[] {
  return [...teamPosts].flatMap(([fixtureId, sides]) => sides.map((side) => ({
    ok: lineupSides.get(fixtureId)?.has(side) === true,
    note: `${fixtureId}: scored with no lineup PUT for side ${side}`,
  })));
}
