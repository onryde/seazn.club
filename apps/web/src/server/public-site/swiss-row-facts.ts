// W3 app-B T3 (owner Q2, 2026-11-03) - the per-row facts a Swiss standings table marks: the round(s) an entrant sat out on a
// pairing bye, and the round a late entrant joined (the rounds before it count as unplayed, FIDE C.07 (2026) art. 16.2.3 /
// 16.3.2). Both are read off the stage's REAL fixture rows - the bye shells and Task 8's `swissAbsentRounds`, the very
// absent-rounds logic the engine's Buchholz reads - so the marker beside a name and the Buchholz beside it can never
// disagree about which rounds an entrant missed. No second derivation of either fact lives here.
//
// Pure on purpose: every page (the console division page, the public division page, the embed, the hub) hands over the
// fixtures it already holds. `standings-view.ts` turns a row's facts into words (`rowMarkers`); the two table components
// only render those words.
import { isSwissBoardExtKey, isSwissByeShellExtKey } from "@/lib/swiss-shell";
import { swissAbsentRounds, type AbsentRoundsFixture } from "@/server/engine-db/swiss-absent-rounds";

/** What a Swiss table row is marked for. Absent from the record = nothing to mark (the on-time, byeless majority). */
export interface SwissRowFacts {
  /** The Swiss rounds in which this entrant held the pairing bye, ascending. */
  readonly byeRounds: readonly number[];
  /** The first round this entrant played in, when it joined AFTER round 1 (rounds `1..joinedRound-1` are its absent rounds,
   *  unplayed); null for an entrant who was there from the start. */
  readonly joinedRound: number | null;
}

/** The columns of a fixture row this reads: `swissAbsentRounds`' own, plus the stage and the status (a voided bye is no bye). */
export interface RowFactsFixture extends AbsentRoundsFixture {
  stage_id: string;
  status?: string;
}

/**
 * The marked rows of one Swiss stage's table, keyed by entrant id. `fixtures` are the STAGE's rows (`swissRowFactsFor` filters
 * a division's); `tableEntrants` the entrants on the table - the engine's absent-rounds map is keyed by them alone.
 *
 * A bye is a Swiss bye SHELL (`isSwissByeShellExtKey`) whose seat Pair has filled and that was not voided: an unseated shell is
 * a round Pair has not reached, and a void row is excluded from every table.
 *
 * A late join is the unbroken run of absent rounds that STARTS AT ROUND 1 (an entrant who joined at round 3 missed 1 and 2).
 * An absence that begins later is a departure (a withdrawal or disqualification, which the row's own chip already says), and
 * an absence in the middle of a run of play is no join at all - neither is a late join. An entrant who never held a seat
 * at all (a withdrawn-before-round-1 row) missed EVERY round and joined none.
 */
export function swissRowFacts(fixtures: readonly RowFactsFixture[], tableEntrants: readonly string[]): Record<string, SwissRowFacts> {
  const table = new Set(tableEntrants);
  const byes = new Map<string, number[]>();
  // Who ever held a seat on a Swiss card (a board's home or away side, a bye's holder). An entrant with none was never in the
  // pairing, however many rounds it "missed", so there is no round it joined at.
  const seated = new Set<string>();
  for (const f of fixtures) {
    if (f.round_no !== null && (isSwissBoardExtKey(f.ext_key) || isSwissByeShellExtKey(f.ext_key))) {
      if (f.home_entrant_id !== null) seated.add(f.home_entrant_id);
      if (f.away_entrant_id !== null) seated.add(f.away_entrant_id);
    }
    if (f.round_no === null || !isSwissByeShellExtKey(f.ext_key) || f.status === "void") continue;
    const holder = f.home_entrant_id ?? f.away_entrant_id;
    if (holder === null || !table.has(holder)) continue;
    const rounds = byes.get(holder) ?? [];
    if (!rounds.includes(f.round_no)) rounds.push(f.round_no);
    byes.set(holder, rounds);
  }
  const absent = swissAbsentRounds(fixtures, tableEntrants);
  const out: Record<string, SwissRowFacts> = {};
  for (const id of table) {
    const missed = absent.get(id) ?? [];
    let joined = 1;
    while (missed.includes(joined)) joined++;
    const byeRounds = (byes.get(id) ?? []).sort((a, b) => a - b);
    const joinedRound = joined > 1 && seated.has(id) ? joined : null;
    if (byeRounds.length > 0 || joinedRound !== null) out[id] = { byeRounds, joinedRound };
  }
  return out;
}

/**
 * The facts of a table's rows for the stage it belongs to, or undefined for a stage that is not Swiss (a league, a group, a
 * knockout never has a bye shell to mark). `fixtures` is the whole division's: this reads the stage's own.
 */
export function swissRowFactsFor(
  stage: { id: string; kind: string },
  fixtures: readonly RowFactsFixture[],
  rows: readonly { entrantId: string }[],
): Record<string, SwissRowFacts> | undefined {
  if (stage.kind !== "swiss") return undefined;
  return swissRowFacts(
    fixtures.filter((f) => f.stage_id === stage.id),
    rows.map((r) => r.entrantId),
  );
}
