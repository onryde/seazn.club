// Known product bugs the random walk must not rediscover on every run: fast-
// check stops at the first failure, so one known bug would dominate every
// shrink and hide the next one (Review Focus 3). A fence blocks one command
// while its condition holds; --no-fences lifts all of them, and each fenced
// bug is ALSO a committed regression case (R29), so it is still witnessed.
//
// A fence guards only the stage kinds its committed cases name (final batch
// F-1: the knockout fences applied to knockout alone), so the same bug on
// another kind is still reported NEW rather than fenced away. W1-driving
// (T15-R8 G-1, T16) widened the two bracket fences to the kinds MB-007,
// MB-008 and MB-009 witness, and T16-R3 narrowed the generate fence to the
// trigger branch each kind's case shows; the live re-run that followed found
// MB-010. Each list below is held to the committed cases' finding commands by
// model-core.test.ts, never typed there.
//
// Imports only types from state.ts, which strip-types erases: no cycle at load.
import { PENDING_STATUSES } from "../observed.ts";
import type { CommandKind, ModelState } from "./state.ts";

/** `subject` is the entrant the command would act on (Withdraw's), else null.
 *  `issue` is the GitHub issue, or null when none is filed — the committed
 *  case that names the fence (regressions.json `fence`) is its witness. */
export interface Fence { readonly id: string; readonly issue: string | null; readonly blocks: CommandKind; applies(m: ModelState, subject: string | null): boolean }

/** ko-withdraw-waiting-on-tbd's stage kinds: knockout (MB-002/003),
 *  stepladder (MB-008, w1drv-model-m6) and double elim (MB-009, found by the
 *  T16 run w1drv-t16-model-g1, whose double-elim cell no fence fired on). All
 *  three are stages.ts BRACKET_WALKOVER_KINDS, the list withdrawal.ts walks
 *  over. */
const WITHDRAW_ON_TBD_KINDS: readonly string[] = Object.freeze(["knockout", "stepladder", "double_elim"]);
/** ko-generate-after-roster-change's stage kinds, per trigger branch
 *  (T16-R3): after an ADDED entrant, knockout (MB-005) and double elim
 *  (MB-007, w1drv-model-m6); after a WITHDRAWAL, knockout (MB-004) and double
 *  elim (MB-010, found by w1drv-t16fr1-model-de once T16-R3 lifted this
 *  branch there). Both are generateStageFixtures' bye-award path, which reads
 *  the same BRACKET_WALKOVER_KINDS. Stepladder is in that list too, but no
 *  committed case shows it on either branch, so it still reports NEW. */
const GENERATE_AFTER_ADDED_KINDS: readonly string[] = Object.freeze(["knockout", "double_elim"]);
const GENERATE_AFTER_WITHDRAWN_KINDS: readonly string[] = Object.freeze(["knockout", "double_elim"]);

export const FENCES: readonly Fence[] = Object.freeze([
  {
    id: "late-entry-then-generate",
    issue: "#879",
    blocks: "Generate",
    // Round-robin stages only (schedule.ts roundRobinStageIds). An entrant
    // added while the stage already has fixtures — before Start, since the
    // roster locks at Start — then Generate: the reconcile keys on POSITION
    // (rr-r{round}-c{court}), so it duplicates pairs and misses others (issue
    // #879; ruling C-1 supersedes R-PF8's post-Start add). Lifted once an
    // accepted Rebuild or Generate re-seats the grown field.
    applies: (m: ModelState) => m.lateEntry && (m.stageKind === "league" || m.stageKind === "group"),
  },
  {
    id: "ko-withdraw-waiting-on-tbd",
    issue: null,
    blocks: "Withdraw",
    // MB-002/003 (knockout), MB-008 (stepladder), MB-009 (double elim).
    // withdrawal.ts: a bracket withdrawal voids the entrant's pending fixture
    // when its opponent is TBD ("A TBD opponent can't receive a walkover"),
    // and that void rides core.abandon, which append-event.ts refuses on a
    // fixture with an unassigned entrant (422 WRONG_PHASE) — so the withdrawal
    // the model holds legal is refused. Only the entrant this Withdraw would
    // pick, only while it waits in a pending fixture (the product's
    // PENDING_STATUSES) on an empty seat. Every stepladder game after the
    // first seats its seed against a TBD line (the L3 triage's P5), so MB-008
    // tripped on Start → Withdraw.
    applies: (m: ModelState, subject: string | null) => WITHDRAW_ON_TBD_KINDS.includes(m.stageKind) && subject !== null &&
      [...m.fixtures.values()].some((f) => PENDING_STATUSES.includes(f.status) && ((f.home === subject && f.away === null) || (f.away === subject && f.home === null))),
  },
  {
    id: "ko-generate-after-roster-change",
    issue: null,
    blocks: "Generate",
    // MB-004/005 (knockout), MB-007/010 (double elim). stages.ts
    // generateStageFixtures: a Generate over a bracket whose fixtures exist,
    // after the roster changed — an entrant added (MB-005, MB-007, before
    // Start) or one withdrawn (MB-004, MB-010, after) — 500s: the bye-award bulk
    // UPDATE would strand home_slot_label. Each branch only on the kinds its
    // cases show. An added entrant is lifted once an accepted Rebuild or
    // Generate re-seats the field (lateEntry); a withdrawal is never undone.
    applies: (m: ModelState) => m.fixtures.size > 0 &&
      ((m.lateEntry && GENERATE_AFTER_ADDED_KINDS.includes(m.stageKind)) || (m.withdrawn.size > 0 && GENERATE_AFTER_WITHDRAWN_KINDS.includes(m.stageKind))),
  },
]);

/** The two roster changes a bracket's Generate 500s after (MB-004/005/007/010), by the name a regressions.json
 *  row's `trigger` carries: an entrant ADDED (AddEntrant), or one WITHDRAWN (Withdraw). The same two branches
 *  as GENERATE_AFTER_ADDED_KINDS and GENERATE_AFTER_WITHDRAWN_KINDS above (W1d item 26). */
export const ROSTER_TRIGGERS = ["added", "withdrawn"] as const;
export type RosterTrigger = (typeof ROSTER_TRIGGERS)[number];
const TRIGGER_OF_COMMAND: ReadonlyMap<string, RosterTrigger> = new Map([["AddEntrant", "added"], ["Withdraw", "withdrawn"]]);

/** The roster changes a failing run made BEFORE its failing command — the last one it ran — as distinct triggers,
 *  first seen first. `commands` are the ran commands' own text ("Generate(0,0)": CommandWrapper.toString, which
 *  is what a report's `commands` and ModelState.history both hold). One entry names the branch that tripped the
 *  failure; none means no roster change preceded it; two or more means the run made both, so which one tripped it
 *  cannot be told from the commands (regressionFor then refuses to name it). */
export function triggersOf(commands: readonly string[]): RosterTrigger[] {
  const seen: RosterTrigger[] = [];
  for (const c of commands.slice(0, -1)) {
    const kind = /^[A-Za-z]+/.exec(c)?.[0];
    const t = kind === undefined ? undefined : TRIGGER_OF_COMMAND.get(kind);
    if (t !== undefined && !seen.includes(t)) seen.push(t);
  }
  return seen;
}

/** The fence that withholds `kind` in this state, or null. `enabled: false`
 *  (--no-fences) lifts every fence. `subject`: the entrant the command would
 *  act on, when it picks one (Withdraw). */
export function fenceBlocking(m: ModelState, kind: CommandKind, enabled: boolean, subject: string | null = null): Fence | null {
  if (!enabled) return null;
  return FENCES.find((f) => f.blocks === kind && f.applies(m, subject)) ?? null;
}
