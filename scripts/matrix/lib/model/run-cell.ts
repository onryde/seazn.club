// One cell's model run: fc.check over fc.commands, each property run on a
// fresh division. Seeded (the caller derives the seed from the run id and the
// cell), path-replayable, time-boxed. A shrunk failure reports its check,
// seed, path, replayPath and the commands that RAN (R-PF9); it is KNOWN when
// an open committed regression names the same cell and check (R29) and, when
// the case carries one, its `match` is in the product's own answer (`said`,
// never the harness's lines — T15 fix rounds 2 and 3: regressionFor).
// Anti-vacuity per cell, across runs (R25, vacuityOf): every command kind ran,
// a Score was accepted, each step check its stage kind owes and fold parity
// judged more than zero items, and at least one step was informative.
//
// Two rules fast-check does not give on its own:
//  - The shrink is LOCKED by rank (shrinkTarget): fast-check keeps any
//    failing candidate while it shrinks, so a new bug could otherwise shrink
//    into a KNOWN one and read as known. A failure is its check AND the case
//    that names it (FailureKey, T15 fix round 2), so a NEW failure on a known
//    case's check is another failure. Ranks: an unexpected refusal (T14
//    amendment: a NEW failure, never merely counted) > anything else, and
//    within each, NEW (no open case names it) > KNOWN. A candidate failing a higher rank
//    moves the shrink to it; one failing an equal or lower rank is passed
//    over and counted in `masked`. A NEW check passed over (under a target
//    that outranks it) is kept in `maskedNew`, with the commands it ran: the
//    cell is still a new failure (fix round 1, I-1). So is a NEW target a
//    higher rank takes over from, with the commands of the last run that
//    failed on it — its most shrunk (fix round 2, RR-1). A backstop after
//    the check reports an unexpected refusal even if the lock were bypassed,
//    and keeps a NEW failure it displaces the same way.
//  - The time box is checked before each property run STARTS (fc.pre), never
//    raced against one in flight: fast-check's interruptAfterTimeLimit races
//    an async run (SkipAfterProperty: Promise.race with a timer) and abandons
//    it still writing to the product and to this report after runCell has
//    returned. The clock is injectable (`now`); the seed never touches it. It
//    is a start gate, not a cap: a run in flight finishes. A hung live request
//    is bounded by HttpDriver's per-request timeout (REQUEST_TIMEOUT_MS).
//  - A request that timed out (RequestTimedOut) is environmental, not a
//    failure (fix round 2, RR-2): it is never a check, never a shrink target
//    and never a model-error. The run it hung in is skipped, no further run
//    starts, and the cell reports `timeout`; the CLI aborts it.
import fc from "fast-check";
import type { RowKey } from "../catalogue.ts";
import { RefusedCall, RequestTimedOut, type OrganiserDriver } from "../driver/types.ts";
import { STEP_INVARIANTS } from "../invariants.ts";
import { MATCH_REQUIRED_CHECKS, type RegressionCase } from "../scenario-catalogue.ts";
import { COMMAND_KINDS, ModelViolation, modelCommands } from "./commands.ts";
import { ORIENTATION_CHECK, ORIENTATION_STAGE_KINDS, UNEXPECTED_REFUSAL, VACUITY_CHECK, informativeSteps, type CommandCounts, type CommandKind, type ModelState, type UnknownLedger } from "./state.ts";

export interface RunCellInput {
  cell: string;
  row: RowKey;
  sport: string;
  variant: string;
  newDriverState: (n: number) => Promise<{ model: ModelState; real: OrganiserDriver }>;
  runs: number;
  maxCommands: number;
  seed: number;
  path?: string;
  replayPath?: string;
  fences: boolean;
  timeLimitMs: number;
  regressions: readonly RegressionCase[];
  /** The time box's clock, in ms (default Date.now). Injectable so a test can run out of time on cue. */
  now?: () => number;
}

export interface CellFailure {
  check: string;
  seed: number;
  path: string;
  replayPath: string | null;
  /** Only the commands that RAN (CommandWrapper.hasRan, R-PF9), in order. */
  commands: string[];
  evidence: string[];
  /** The product's own answer when the failure is its refusal (ModelViolation.said,
   *  or an escaped RefusedCall's message); null when the harness judged it alone. */
  said: string | null;
  known: string | null;
}

type UnknownCause = UnknownLedger["cause"];

export interface CellReport {
  cell: string;
  variant: string;
  seed: number;
  runs: number;
  maxCommands: number;
  fences: boolean;
  /** fast-check's count: runs that passed, or the run the first failure came from. */
  numRuns: number;
  /** Property runs executed, shrinking included — the denominator of every sum below. */
  executions: number;
  /** The time box stopped the cell early: runs not started, or a shrink cut short. */
  interrupted: boolean;
  counts: Record<CommandKind, CommandCounts>;
  stepChecks: Record<string, number>;
  foldParity: number;
  fenced: Record<string, number>;
  unknowns: Record<UnknownCause, number>;
  findings: Record<string, { count: number; evidence: string[] }>;
  informativeSteps: number;
  /** Failures on other checks passed over while shrinking toward `failure` (shrinkTarget). */
  masked: Record<string, number>;
  /** The masked checks no open regression names — NEW failures the shrink
   *  passed over — each with the commands its first candidate ran. */
  maskedNew: Record<string, string[]>;
  /** Empty when `timeout` is set: a cell cut short by the environment is not judged for coverage. */
  vacuous: string[];
  failure: CellFailure | null;
  /** The request that did not answer (RequestTimedOut) — environmental, never
   *  a failure. Set, the cell started no run after it and its counts are
   *  partial; `failure` is whatever was found before it. */
  timeout: string | null;
}

/** A failure's identity (T15 fix round 2): its check, and the open case that
 *  names it — null when none does (NEW). */
export interface FailureKey { readonly check: string; readonly known: string | null }
const sameFailure = (a: FailureKey, b: FailureKey): boolean => a.check === b.check && a.known === b.known;
/** An unexpected refusal, then anything else; NEW over KNOWN within each (fix round 1, I-1; T15 fix round 2). */
const rankOf = (k: FailureKey): number => (k.check === UNEXPECTED_REFUSAL ? 2 : 0) + (k.known === null ? 1 : 0);

/** The shrink lock: given the failure the shrink follows (null before any)
 *  and the failure a run just threw, the failure it follows now — or null
 *  when this one is passed over. A failure of a higher rank takes over. */
export function shrinkTarget(current: FailureKey | null, thrown: FailureKey): FailureKey | null {
  if (current === null || sameFailure(thrown, current) || rankOf(thrown) > rankOf(current)) return thrown;
  return null;
}

/** The open committed case that names a failure (R29; T15 fix rounds 2 and
 *  3): the same cell and check, and — when the case carries a `match` — that
 *  text in `said`, the product's own answer, never the harness's lines (a
 *  failure the harness judged alone has none, so only a null match names it).
 *  The most specific case wins: one whose match is in `said` outranks one with
 *  a null match, whatever the file order (M-2). A null match names every
 *  failure on its check, which the loader refuses on MATCH_REQUIRED_CHECKS; a
 *  case that bypassed the loader with none there names nothing. */
export function regressionFor(regressions: readonly RegressionCase[], cell: string, check: string, said: string | null): string | null {
  const open = regressions.filter((r) => r.status === "open" && r.cell === cell && r.check === check);
  const matching = open.find((r) => {
    const m: unknown = r.match;
    return typeof m === "string" && said !== null && said.includes(m);
  });
  if (matching !== undefined) return matching.id;
  if ((MATCH_REQUIRED_CHECKS as readonly string[]).includes(check)) return null;
  return open.find((r) => r.match === null)?.id ?? null;
}

/** The fast-check failure a run reports when fast-check gave up on skips. */
export const MODEL_ERROR = "model-error";
const checkOf = (e: unknown): string => (e instanceof ModelViolation ? e.check : MODEL_ERROR);
/** The product's own answer a failure carries: a violation's `said`, or the
 *  message of a refusal no command caught (a model-error). Anything else —
 *  a harness error, an invariant — carries none. */
const saidOf = (e: unknown): string | null => (e instanceof ModelViolation ? e.said : e instanceof RefusedCall ? e.message : null);
const evidenceOf = (e: unknown): string[] => (e instanceof ModelViolation ? [...e.evidence] : [e instanceof Error ? `${e.name}: ${e.message}` : String(e)]);

/** The shape fast-check 3.23 hands back as `counterexample[0]` for
 *  `fc.commands` (CommandsIterable; pinned in node_modules/fast-check/lib/types). */
interface RanCommands { readonly commands: readonly { hasRan: boolean; toString(): string }[]; metadataForReplay(): string }
/** `metadataForReplay()` is `replayPath="<json string>"`, or "" when the log is disabled. */
function replayPathOf(shrunk: RanCommands): string | null {
  const m = /^replayPath=(".*")$/.exec(shrunk.metadataForReplay());
  const raw = m?.[1];
  return raw === undefined ? null : (JSON.parse(raw) as string);
}

const zeroCounts = (): CommandCounts => ({ ran: 0, accepted: 0, refused: 0, expected: 0, unexpected: 0 });
/** Every cause, typed complete: a cause added to UnknownLedger fails tsc here. */
const zeroUnknowns = (): Record<UnknownCause, number> => ({ retried: 0, "tip-moved": 0, "next-match-unverified": 0 });
const EVIDENCE_KEPT = 3;

export interface VacuityInput {
  counts: Record<CommandKind, CommandCounts>;
  stepChecks: Record<string, number>;
  foldParity: number;
  informative: number;
  /** The stage kind the cell built; null when no run started. */
  stageKind: string | null;
}

/** R25 for one cell, summed across its runs: every line is a zero count the
 *  cell owed. A step check is owed only on the stage kinds it declares
 *  (STEP_INVARIANTS' stageKinds; ORIENTATION_STAGE_KINDS): I6 on a swiss, I7
 *  and the orientation check on a round robin, I8 on any. With no stage kind
 *  known, only the any-stage ones are owed. */
export function vacuityOf(v: VacuityInput): string[] {
  const out: string[] = [];
  for (const k of COMMAND_KINDS) if (v.counts[k].ran === 0) out.push(`command ${k} never ran`);
  if (v.counts.Score.accepted === 0) out.push("no Score was accepted");
  const kind = v.stageKind;
  for (const s of STEP_INVARIANTS) {
    const applies = s.stageKinds === "any" || (kind !== null && s.stageKinds.includes(kind));
    if (applies && (v.stepChecks[s.id] ?? 0) === 0) out.push(`step invariant ${s.id} checked zero items`);
  }
  if (kind !== null && ORIENTATION_STAGE_KINDS.includes(kind) && (v.stepChecks[ORIENTATION_CHECK] ?? 0) === 0) out.push(`step check ${ORIENTATION_CHECK} checked zero items`);
  if (v.foldParity === 0) out.push("fold parity compared zero fixtures");
  if (v.informative === 0) out.push(`no informative step (${VACUITY_CHECK})`);
  return out;
}

export async function runCell(input: RunCellInput): Promise<CellReport> {
  const counts = Object.fromEntries(COMMAND_KINDS.map((k) => [k, zeroCounts()])) as Record<CommandKind, CommandCounts>;
  const stepChecks: Record<string, number> = {};
  const fenced: Record<string, number> = {};
  const unknowns = zeroUnknowns();
  const findings: Record<string, { count: number; evidence: string[] }> = {};
  const masked: Record<string, number> = {};
  const maskedNew: Record<string, string[]> = {};
  const knownFor = (check: string, said: string | null): string | null => regressionFor(input.regressions, input.cell, check, said);
  const seen = { stageKind: null as string | null, foldParity: 0, informative: 0, executions: 0, timeBoxed: false, timeout: null as string | null };
  const absorb = (m: ModelState): void => {
    for (const k of COMMAND_KINDS) {
      const into = counts[k];
      const from = m.counts[k];
      for (const f of Object.keys(into) as (keyof CommandCounts)[]) into[f] += from[f];
    }
    for (const [id, c] of m.stepChecks) stepChecks[id] = (stepChecks[id] ?? 0) + c;
    for (const [id, c] of m.fenced) fenced[id] = (fenced[id] ?? 0) + c;
    for (const u of m.unknowns) unknowns[u.cause] = (unknowns[u.cause] ?? 0) + 1;
    for (const [id, f] of m.findings) {
      const into = findings[id] ?? { count: 0, evidence: [] };
      into.count += f.count;
      into.evidence = [...into.evidence, ...f.evidence].slice(0, EVIDENCE_KEPT);
      findings[id] = into;
    }
    seen.foldParity += m.foldParity;
    seen.informative += informativeSteps(m).checked;
  };

  const now = input.now ?? Date.now;
  const deadline = now() + input.timeLimitMs;
  let target: FailureKey | null = null;
  /** The commands of the last run that failed on `target`: shrinking only
   *  continues from a failing candidate, so this is its most shrunk. */
  let targetHistory: string[] = [];
  /** A NEW failure set aside for a higher rank is still a new failure: keep it, with the commands given, once per check. */
  const keepNew = (k: FailureKey, commands: string[]): void => {
    if (k.known === null && maskedNew[k.check] === undefined) maskedNew[k.check] = commands;
  };
  const constraints = { maxCommands: input.maxCommands, size: "max" as const, ...(input.replayPath === undefined ? {} : { replayPath: input.replayPath }) };
  const prop = fc.asyncProperty(fc.commands(modelCommands({ fences: input.fences }), constraints), async (cmds) => {
    if (now() >= deadline) {
      seen.timeBoxed = true;
      fc.pre(false);
    }
    if (seen.timeout !== null) fc.pre(false);
    let model: ModelState | null = null;
    try {
      const setup = await input.newDriverState(++seen.executions);
      model = setup.model;
      seen.stageKind = setup.model.stageKind;
      await fc.asyncModelRun(() => setup, cmds);
    } catch (e) {
      // A skip (fc.pre) is fast-check's, never a failure: it must not become the target.
      if (fc.PreconditionFailure.isFailure(e)) throw e;
      // The product did not answer: skip this run, like the time box — never a check (RR-2).
      if (e instanceof RequestTimedOut) {
        seen.timeout = e.message;
        fc.pre(false);
      }
      const check = checkOf(e);
      const thrown: FailureKey = { check, known: knownFor(check, saidOf(e)) };
      const next = shrinkTarget(target, thrown);
      if (next === null) {
        masked[check] = (masked[check] ?? 0) + 1;
        keepNew(thrown, [...(model?.history ?? [])]);
        return;
      }
      // A higher rank displacing the target: the displaced failure is set aside, not lost (RR-1).
      if (target !== null && !sameFailure(next, target)) keepNew(target, targetHistory);
      targetHistory = [...(model?.history ?? [])];
      target = next;
      throw e;
    } finally {
      if (model !== null) absorb(model);
    }
  });
  const details = await fc.check(prop, {
    seed: input.seed, numRuns: input.runs,
    ...(input.path === undefined ? {} : { path: input.path }),
  });

  let failure: CellFailure | null = null;
  const shrunk = details.failed ? (details.counterexample?.[0] as RanCommands | undefined) : undefined;
  // A failed check with no counterexample is fast-check giving up on skips.
  // The time box is the one skip that is not a failure; any other (a future
  // fc.pre in a command) would otherwise read as a clean cell (fix round 1, M-7).
  // A timeout skips runs the same way, and is reported as itself (RR-2).
  if (details.failed && shrunk === undefined && !seen.timeBoxed && seen.timeout === null) {
    const evidence = [`fast-check gave up after ${details.numSkips} skipped run(s) (${details.numRuns} ran) — only the time box may skip a run`];
    failure = { check: MODEL_ERROR, seed: details.seed, path: "", replayPath: null, commands: [], evidence, said: null, known: knownFor(MODEL_ERROR, null) };
  }
  if (details.failed && shrunk !== undefined) {
    const err: unknown = details.errorInstance;
    const check = checkOf(err);
    const evidence = evidenceOf(err);
    const said = saidOf(err);
    failure = {
      check, seed: details.seed, path: details.counterexamplePath ?? "", replayPath: replayPathOf(shrunk),
      // Only the commands that ran: the shrunk iterable also holds generated
      // commands the failing run never reached (R-PF9).
      commands: shrunk.commands.filter((c) => c.hasRan).map((c) => c.toString()),
      evidence, said, known: knownFor(check, said),
    };
  }
  // Backstop (T14 amendment): an unexpected refusal is a NEW failure, not a
  // count. The lock makes the shrunk failure one whenever one was thrown; if
  // it ever is not, this still reports it — with no path, since none replays
  // it — and keeps what it displaced as evidence.
  const unexpected = COMMAND_KINDS.reduce((s, k) => s + counts[k].unexpected, 0);
  if (unexpected > 0 && failure?.check !== UNEXPECTED_REFUSAL) {
    if (failure !== null) keepNew(failure, failure.commands);
    const evidence = [
      `${unexpected} unexpected refusal(s) counted over the cell, yet the shrunk failure is ${failure === null ? "none" : failure.check} — an unexpected refusal outranks every other check`,
      ...(failure === null ? [] : [`displaced ${failure.check} (path ${failure.path}): ${failure.commands.join(" → ")} — ${failure.evidence.join("; ")}`]),
    ];
    // The backstop's evidence is the harness's own sentence (and whatever it
    // displaced): no product answer, so no committed case can name it — a
    // bypassed lock is a harness defect, reported NEW (T15 fix round 3, M-3/M-5).
    failure = { check: UNEXPECTED_REFUSAL, seed: input.seed, path: "", replayPath: null, commands: [], evidence, said: null, known: knownFor(UNEXPECTED_REFUSAL, null) };
  }

  const vacuous = failure === null && seen.timeout === null
    ? vacuityOf({ counts, stepChecks, foldParity: seen.foldParity, informative: seen.informative, stageKind: seen.stageKind })
    : [];
  return {
    cell: input.cell, variant: input.variant, seed: input.seed, runs: input.runs, maxCommands: input.maxCommands, fences: input.fences,
    numRuns: details.numRuns, executions: seen.executions, interrupted: seen.timeBoxed,
    counts, stepChecks, foldParity: seen.foldParity, fenced, unknowns, findings, informativeSteps: seen.informative, masked, maskedNew, vacuous, failure, timeout: seen.timeout,
  };
}
