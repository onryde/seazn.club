// Match Day Phase C, Task C1 (spec 2026-10-31-match-day-design.md §12, Phase C items 5-8) - the stage card's pure summaries.
// What the Points panel says in one line, which tie-break steps the Tie-breaks panel numbers, the sport's own word for a
// "set", and which buttons the card offers for the stage's state. The editors (C2) and the card layout (C3) render what
// these answer and decide none of it themselves.
//
// CLIENT-SAFE: no "use client", no JSX, no `@/server` import. It reads the engine's `/competition` and `/sports` subpaths
// the way `lib/rule-scope.ts` and `lib/match-rules/set-target-floor.ts` already do in client code, and takes only the
// message-key TYPE from `lib/messages` (erased), so the en catalog stays out of the bundle.
import { RATIO_LEDGERS } from "@seazn/engine/competition";
import type { TiebreakerKey } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
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
// Stage actions (item 8): the buttons follow the stage's state.
// ---------------------------------------------------------------------------------------------------------------------

export type StageAction = "generate" | "complete" | "add_match";

/** The stage as the buttons see it. `played` counts finished matches, `inPlay` matches being scored, `unplayed` matches not
 *  begun; `hasFixtures` is whether the stage holds any. `adhoc` is whether the stage's KIND takes a loose match (league,
 *  group, swiss - `ADHOC_STAGE_KINDS`; a bracket has no slot for one): a required field, not a default, so a caller cannot
 *  omit it and silently lose (or wrongly gain) Add match. */
export interface StageActionInput {
  readonly status: string;
  readonly played: number;
  readonly inPlay: number;
  readonly unplayed: number;
  readonly hasFixtures: boolean;
  readonly adhoc: boolean;
}

/** The stage's lifecycle (`stages.status`: pending -> active when its fixtures are generated -> complete). */
const STAGE_STATUSES: ReadonlySet<string> = new Set(["pending", "active", "complete"]);

const isCount = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0;

/**
 * Which buttons a stage offers: one lead (`primary`, or none) and the rest (`secondary`, the stage-actions menu).
 *
 * - **Generate** leads a stage that has not started and is offered on no other: once the stage has started - it left
 *   `pending`, or a match is already played or being scored (contradictory input counts as started, so Generate, which
 *   builds fixtures, is never offered over a result) - it is gone.
 * - **Complete** leads only when the stage has fixtures and none is open (`inPlay + unplayed === 0`). While any match is
 *   open it is never the lead, but stays in `secondary`: it is the organiser's call to end a stage early, which the server
 *   still accepts (the card shows what it is waiting on).
 * - **Add match** is secondary, for a stage kind that takes one, once the stage has fixtures.
 * - A complete stage offers nothing; a started stage with no fixtures has nothing to complete or add to.
 *
 * A status the stage lifecycle does not have, and a count that is not a whole number, are refused by name: a card that
 * quietly offered nothing - or a button on a guess - would look right and be wrong.
 */
export function stageActions(s: StageActionInput): { primary: StageAction | null; secondary: StageAction[] } {
  if (!STAGE_STATUSES.has(s.status)) throw new Error(`stageActions: unknown stage status "${s.status}"`);
  for (const [name, n] of [["played", s.played], ["inPlay", s.inPlay], ["unplayed", s.unplayed]] as const) {
    if (!isCount(n)) throw new Error(`stageActions: ${name} is not a count (${String(n)})`);
  }
  if (s.status === "complete") return { primary: null, secondary: [] };
  const started = s.status !== "pending" || s.played + s.inPlay > 0;
  const open = s.inPlay + s.unplayed;
  const addMatch: StageAction[] = s.adhoc && s.hasFixtures ? ["add_match"] : [];
  if (!started) return { primary: "generate", secondary: addMatch };
  if (!s.hasFixtures) return { primary: null, secondary: [] };
  if (open === 0) return { primary: "complete", secondary: addMatch };
  return { primary: null, secondary: [...addMatch, "complete"] };
}
