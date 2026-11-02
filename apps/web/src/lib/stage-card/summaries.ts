// Match Day Phase C, Task C1 (spec 2026-10-31-match-day-design.md §12, Phase C items 5-8) - the stage card's pure summaries.
// What the Points panel says in one line, which tie-break steps the Tie-breaks panel numbers, the sport's own word for a
// "set", the stage's match counts, and which buttons the card offers for the stage's state (each with its enabled flag).
// The editors (C2) and the card layout (C3) render what these answer and decide none of it themselves.
//
// CLIENT-SAFE: no "use client", no JSX, no `@/server` import. It reads the engine's `/competition` and `/sports` subpaths
// the way `lib/rule-scope.ts` and `lib/match-rules/set-target-floor.ts` already do in client code, and takes only the
// message-key TYPE from `lib/messages` (erased), so the en catalog stays out of the bundle.
import { RATIO_LEDGERS } from "@seazn/engine/competition";
import type { TiebreakerKey } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
import type { FixtureStatusValue } from "@/lib/fixture-status";
import type { MessageKey } from "@/lib/messages";

// ---------------------------------------------------------------------------------------------------------------------
// Points (item 5): "Win 2 · Loss 0" when every score pays the same; a table only when the scores differ.
// ---------------------------------------------------------------------------------------------------------------------

/** What one set score pays: the winner's points, then the loser's. Whole points as the editor shows them (a half-point
 *  rule is shown in points by the caller, as `stage-points-model.ts` does). */
export interface ScorePayout {
  readonly score: string;
  readonly winner: number;
  readonly loser: number;
}

/** The pair a score the rows do not name pays (the rule's `"*"` entry), or null where the rule has none. */
export interface OtherPayout {
  readonly winner: number;
  readonly loser: number;
}

export type PointsSummary =
  | { kind: "uniform"; win: number; loss: number }
  | { kind: "table"; rows: readonly ScorePayout[]; other: OtherPayout | null };

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

/**
 * One line when every score pays the same, else the table.
 *
 * Uniform means every row pays one pair AND the fallback (if there is one) pays that same pair: a fallback that pays
 * differently is a payout "Win 2 · Loss 0" would hide, so it keeps the table. With no rows the fallback alone decides (it
 * pays every score); with neither there is nothing to say, and the answer is an EMPTY table - never a uniform one, which
 * `[].every(...)` would otherwise call true and read a pair off a row that is not there.
 *
 * A number that is no number is refused by name rather than compared: NaN never equals itself and would make every row
 * "differ", turning a one-line payout into a table of NaNs.
 */
export function summarisePoints(rows: readonly ScorePayout[], other: OtherPayout | null): PointsSummary {
  for (const r of rows) {
    if (!finite(r.winner) || !finite(r.loser)) throw new Error(`summarisePoints: score ${r.score} pays points that are no number`);
  }
  if (other !== null && (!finite(other.winner) || !finite(other.loser))) {
    throw new Error("summarisePoints: the fallback pays points that are no number");
  }
  const pairs: OtherPayout[] = rows.map((r) => ({ winner: r.winner, loser: r.loser }));
  if (other !== null) pairs.push(other);
  const first = pairs[0];
  if (first === undefined) return { kind: "table", rows: [], other: null };
  const same = pairs.every((p) => p.winner === first.winner && p.loser === first.loser);
  return same ? { kind: "uniform", win: first.winner, loss: first.loser } : { kind: "table", rows, other };
}

// ---------------------------------------------------------------------------------------------------------------------
// Tie-breaks (item 6): the repeated two-way head-to-head rung is ONE sentence, not numbered steps.
// ---------------------------------------------------------------------------------------------------------------------

/** The engine's two-way head-to-head rung: "if exactly two are still level, the match between them decides". It is the one
 *  rung an order may repeat (`cascade-rules.ts`: the `duplicate` refusal exempts exactly this key), which is why it reads as
 *  a rule about every step rather than as a step. Typed against the engine's key union, so a rename is a compile error. */
const TWO_WAY_H2H = "h2h_two" satisfies TiebreakerKey;

/** The order's real criteria in their order, with every two-way head-to-head rung taken out; `twoWayH2h` says the order had
 *  one (the panel then prints the single explanatory line). Every other rung keeps its place - `h2h_points` and the other
 *  head-to-head rungs are criteria of their own and stay numbered. A fresh list; the input is not touched. */
export function foldTiebreaks(rungs: readonly string[]): { steps: string[]; twoWayH2h: boolean } {
  const steps = rungs.filter((r) => r !== TWO_WAY_H2H);
  return { steps, twoWayH2h: steps.length !== rungs.length };
}

// ---------------------------------------------------------------------------------------------------------------------
// The sport's unit (item 7): "game difference" in badminton, "set difference" in tennis.
// ---------------------------------------------------------------------------------------------------------------------

/** The rungs that count the set-based unit - the ledger `RATIO_LEDGERS.set_ratio` divides, which `set_diff` subtracts and
 *  `h2h_set_ratio` divides among the tied. The test holds this list to the engine's vocabulary (every rung naming a set is
 *  here, and nothing else is). Typed against the key union. */
const UNIT_RUNGS: ReadonlySet<string> = new Set(["set_ratio", "set_diff", "h2h_set_ratio"] satisfies TiebreakerKey[]);

/** The word the shared labels (`div.detail.tiebreak.rule.set_diff` = "set difference") speak. */
const SHARED_UNIT = "sets";

/** The ledger those rungs read: the engine's own declaration of the first half of the set ratio ("sets_won"). */
const UNIT_LEDGER = RATIO_LEDGERS.set_ratio[0];

/**
 * The plural unit a sport's set ledger counts, lowercased ("games", "sets"), or null for a sport that records none.
 *
 * Read off the engine's declaration, not a table kept here: a set sport's `metrics` carry the ledger as "<Unit> won" (its
 * preset's `unitLabel`, `setbased/kernel.ts` `makeMetrics`), the same word its own standings column prints. Own-property
 * lookup via `find` over the shipped modules, so a sport key like "constructor" answers null, never an inherited member.
 */
function unitOf(sportKey: string): string | null {
  const label = builtinModules.find((m) => m.key === sportKey)?.metrics.find((x) => x.key === UNIT_LEDGER)?.label;
  if (label === undefined) return null;
  const unit = label.replace(/\s+won$/i, "").trim().toLowerCase();
  return unit === "" ? null : unit;
}

/**
 * The dictionary key of a tie-break rung's name in the sport's own word.
 *
 * A rung that counts the set-based unit (`set_ratio`, `set_diff`, `h2h_set_ratio`) in a sport whose engine unit is not
 * "sets" resolves to `div.detail.tiebreak.rule.<rung>.<sportKey>` ("game difference" for badminton); every other rung, and
 * every sport that counts sets or records no set ledger, resolves to the shared `div.detail.tiebreak.rule.<rung>`.
 *
 * The key is chosen from the engine's declaration but not checked against the dictionary here - the dictionary is not
 * loaded in client code. The test sweeps every registry sport and rung against all four locales, so a sport that declares a
 * new unit without its labels fails there, not on a screen.
 */
export function unitLabelKey(rule: string, sportKey: string): MessageKey {
  const shared = `div.detail.tiebreak.rule.${rule}`;
  if (!UNIT_RUNGS.has(rule)) return shared as MessageKey;
  const unit = unitOf(sportKey);
  if (unit === null || unit === SHARED_UNIT) return shared as MessageKey;
  return `${shared}.${sportKey}` as MessageKey;
}

// ---------------------------------------------------------------------------------------------------------------------
// Stage counts: the one reading of fixtures.status the card's buttons and summary line share.
// ---------------------------------------------------------------------------------------------------------------------

/** What the stage card counts a match as: finished, under way, or still to come. */
type Bucket = "played" | "inPlay" | "unplayed";

/**
 * Every value of fixtures.status (V214 + V432; `lib/fixture-status.ts`) and the bucket it counts in - a total map, so a new
 * status is a compile error here rather than a match the card silently does not count.
 *
 * - OPEN (a stage is not finished while one remains): `scheduled` -> unplayed; `in_play` -> inPlay; `needs_decision` -> inPlay.
 *   A held match was played (only the organiser's verdict waits), so it is not "still to come" - and Complete stays refused
 *   while one is held (W2b X-AB-5), which only an open bucket expresses.
 * - SETTLED (nothing left to play): `decided`, `finalized`, `forfeited`, `abandoned`, `cancelled` -> played. These are exactly
 *   `SETTLED_FIXTURE_STATUSES` plus `LOCKED_FIXTURE_STATUSES` (held to that by the test), the two declarations the rest of the
 *   app already reads, so "settled" has no second spelling.
 */
const BUCKET_OF: Record<FixtureStatusValue, Bucket> = {
  scheduled: "unplayed",
  in_play: "inPlay",
  needs_decision: "inPlay",
  decided: "played",
  finalized: "played",
  forfeited: "played",
  abandoned: "played",
  cancelled: "played",
};

/**
 * The counts `stageActions` takes, read off a stage's fixtures. `played` is every settled match (a walkover, an abandonment
 * and a cancellation are settled: the stage is waiting for none of them); `inPlay` and `unplayed` together are the OPEN
 * ones. A status the schema does not have is refused by name: counting it nowhere would let Complete lead over a match the
 * card cannot see, and counting it somewhere would be a guess. Own-key lookup, so "constructor" is refused like any other.
 *
 * `held` is the ids the division page lists as awaiting their settle (`listFixturesAwaitingSettle`): a recorded plain abandon
 * keeps `status = 'abandoned'` while the organiser's verdict is still owed, which the status map alone reads as settled - so
 * Complete would lead over a match the server still refuses it for. A held id is OPEN whatever its status says (it counts in
 * `inPlay`, like `needs_decision`); every fixture's status is still checked, held or not, so the sweep above stays honest.
 */
export function stageCounts(
  fixtures: readonly { id?: string; status: string }[],
  held: ReadonlySet<string> = NO_HELD,
): { played: number; inPlay: number; unplayed: number } {
  const counts: Record<Bucket, number> = { played: 0, inPlay: 0, unplayed: 0 };
  for (const f of fixtures) {
    if (!Object.hasOwn(BUCKET_OF, f.status)) throw new Error(`stageCounts: unknown fixture status "${f.status}"`);
    const bucket: Bucket = f.id !== undefined && held.has(f.id) ? "inPlay" : BUCKET_OF[f.status as FixtureStatusValue];
    counts[bucket]++;
  }
  return counts;
}

const NO_HELD: ReadonlySet<string> = new Set();

// ---------------------------------------------------------------------------------------------------------------------
// Stage actions (item 8): the buttons follow the stage's state.
// ---------------------------------------------------------------------------------------------------------------------

export type StageAction = "generate" | "pair_next" | "unpair" | "complete" | "add_match";

/** One button: the action, and whether it can be pressed now. Both slots (`primary`, `secondary`) hold this one shape, so
 *  the card renders them with one component and never re-derives a flag. */
export interface StageButton {
  readonly action: StageAction;
  readonly enabled: boolean;
}

/** The stage as the buttons see it. `played` / `inPlay` / `unplayed` are `stageCounts` of its fixtures; `hasFixtures` is
 *  whether it holds any. The three flags that depend on the stage's KIND are required, not defaulted, so a caller cannot
 *  omit one and silently lose (or wrongly gain) a button:
 *  - `adhoc`: the kind takes a loose match (league, group, swiss - `ADHOC_STAGE_KINDS`; a bracket has no slot for one).
 *  - `pairNext`: a Swiss stage with a round still waiting to be paired - the panel's `swissHasUnseated`
 *    (`nextUnseatedSwissRound(...) !== null`, already false for every other kind).
 *  - `canUnpair`: a Swiss stage whose latest round has a seat and no played result - the panel's `canUnpairSwiss`
 *    (the predicate the server's `unpairSwissRound` uses, already false for every other kind). */
export interface StageActionInput {
  readonly status: string;
  readonly played: number;
  readonly inPlay: number;
  readonly unplayed: number;
  readonly hasFixtures: boolean;
  readonly adhoc: boolean;
  readonly pairNext: boolean;
  readonly canUnpair: boolean;
}

/** The stage's lifecycle (`stages.status`: pending -> active when its fixtures are generated -> complete). */
const STAGE_STATUSES: ReadonlySet<string> = new Set(["pending", "active", "complete"]);

const isCount = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0;

/**
 * Which buttons a stage offers: one lead (`primary`, or none) and the rest (`secondary`, the stage-actions menu), each with
 * its enabled flag. Gates mirror `desk/stage-rail.tsx`'s, except where the owner's Phase C rulings replace them.
 *
 * - **Pair next round** (`pair_next`) leads whenever a Swiss round waits to be paired and the stage has fixtures (the rail's
 *   label gate: `fixtureCount > 0 && swissHasUnseated`). It is the Swiss form of Generate, so Generate is not also offered;
 *   Complete is then never the lead (the rail's 2026-09-20 defect: Complete led over Pair next).
 * - **Generate** leads a stage that has not started and has no round to pair, and is offered on no other: once the stage has
 *   started - it left `pending`, or a match is already played or being scored (contradictory input counts as started, so
 *   Generate, which builds fixtures, is never offered over a result) - it is gone.
 * - **Complete** is offered once the stage has started and has fixtures, always in the menu or as the lead, and ENABLED only
 *   when no match is open (`inPlay + unplayed === 0`): "Complete stage unlocks when all N matches are played". It leads only
 *   then, and only when no round waits to be paired. While any match is open it is present but disabled, so the card shows
 *   what it is waiting on without re-deriving it.
 * - **Unpair** is offered whenever the panel says the latest Swiss round can be unpaired (the rail's gate, which does not ask
 *   whether the stage has started).
 * - **Add match** is secondary, for a stage kind that takes one, once the stage has fixtures.
 * - A complete stage offers nothing; a started stage with no fixtures has nothing to complete or add to.
 *
 * A status the stage lifecycle does not have, and a count that is not a whole number, are refused by name: a card that
 * quietly offered nothing - or a button on a guess - would look right and be wrong.
 */
export function stageActions(s: StageActionInput): { primary: StageButton | null; secondary: StageButton[] } {
  if (!STAGE_STATUSES.has(s.status)) throw new Error(`stageActions: unknown stage status "${s.status}"`);
  for (const [name, n] of [["played", s.played], ["inPlay", s.inPlay], ["unplayed", s.unplayed]] as const) {
    if (!isCount(n)) throw new Error(`stageActions: ${name} is not a count (${String(n)})`);
  }
  if (s.status === "complete") return { primary: null, secondary: [] };
  const started = s.status !== "pending" || s.played + s.inPlay > 0;
  const nothingOpen = s.inPlay + s.unplayed === 0;
  const pairing = s.pairNext && s.hasFixtures;
  const on = (action: StageAction): StageButton => ({ action, enabled: true });

  let primary: StageButton | null = null;
  if (pairing) primary = on("pair_next");
  else if (!started) primary = on("generate");
  else if (s.hasFixtures && nothingOpen) primary = on("complete");

  const secondary: StageButton[] = [];
  if (s.adhoc && s.hasFixtures) secondary.push(on("add_match"));
  if (s.canUnpair) secondary.push(on("unpair"));
  if (started && s.hasFixtures && primary?.action !== "complete") secondary.push({ action: "complete", enabled: nothingOpen });
  return { primary, secondary };
}
