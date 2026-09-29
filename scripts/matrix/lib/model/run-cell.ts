// One cell's model run: fc.check over fc.commands, each property run on a
// fresh division. Seeded (the caller derives the seed from the run id and the
// cell), path-replayable, time-boxed. A shrunk failure reports its check,
// seed, path, replayPath and the commands that RAN (R-PF9); it is KNOWN when
// an open committed regression names the same cell and check (R29).
// Anti-vacuity per cell, across runs (R25, vacuityOf): every command kind ran,
// a Score was accepted, each step check its stage kind owes and fold parity
// judged more than zero items, and at least one step was informative.
//
// Two rules fast-check does not give on its own:
//  - The shrink is LOCKED by rank (shrinkTarget): fast-check keeps any
//    failing candidate while it shrinks, so a new bug could otherwise shrink
//    into a KNOWN one and read as known. Ranks: an unexpected refusal (T14
//    amendment: a NEW failure, never merely counted) > a NEW check (no open
//    regression on the cell) > a KNOWN one. A candidate failing a higher rank
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
import { RequestTimedOut, type OrganiserDriver } from "../driver/types.ts";
import { STEP_INVARIANTS } from "../invariants.ts";
import type { RegressionCase } from "../scenario-catalogue.ts";
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

/** An unexpected refusal, then a NEW check, then a KNOWN one (fix round 1, I-1). */
const rankOf = (check: string, isKnown: (check: string) => boolean): number => (check === UNEXPECTED_REFUSAL ? 2 : isKnown(check) ? 0 : 1);

/** The shrink lock: given the check the shrink follows (null before any
 *  failure) and the check a run just failed on, the check it follows now — or
 *  null when this failure is passed over. A check of a higher rank takes over. */
export function shrinkTarget(current: string | null, thrown: string, isKnown: (check: string) => boolean): string | null {
  if (current === null || thrown === current || rankOf(thrown, isKnown) > rankOf(current, isKnown)) return thrown;
  return null;
}

/** The fast-check failure a run reports when fast-check gave up on skips. */
const MODEL_ERROR = "model-error";
const checkOf = (e: unknown): string => (e instanceof ModelViolation ? e.check : MODEL_ERROR);
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
  const knownFor = (check: string): string | null =>
    input.regressions.find((r) => r.status === "open" && r.cell === input.cell && r.check === check)?.id ?? null;
  const isKnown = (check: string): boolean => knownFor(check) !== null;
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
  let target: string | null = null;
  /** The commands of the last run that failed on `target`: shrinking only
   *  continues from a failing candidate, so this is its most shrunk. */
  let targetHistory: string[] = [];
  /** A NEW check set aside for a higher rank is still a new failure: keep it, with the commands given, once. */
  const keepNew = (check: string, commands: string[]): void => {
    if (!isKnown(check) && maskedNew[check] === undefined) maskedNew[check] = commands;
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
      const next = shrinkTarget(target, check, isKnown);
      if (next === null) {
        masked[check] = (masked[check] ?? 0) + 1;
        keepNew(check, [...(model?.history ?? [])]);
        return;
      }
      // A higher rank displacing the target: the displaced check is set aside, not lost (RR-1).
      if (target !== null && next !== target) keepNew(target, targetHistory);
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
    failure = {
      check: MODEL_ERROR, seed: details.seed, path: "", replayPath: null, commands: [],
      evidence: [`fast-check gave up after ${details.numSkips} skipped run(s) (${details.numRuns} ran) — only the time box may skip a run`],
      known: knownFor(MODEL_ERROR),
    };
  }
  if (details.failed && shrunk !== undefined) {
    const err: unknown = details.errorInstance;
    const check = checkOf(err);
    failure = {
      check, seed: details.seed, path: details.counterexamplePath ?? "", replayPath: replayPathOf(shrunk),
      // Only the commands that ran: the shrunk iterable also holds generated
      // commands the failing run never reached (R-PF9).
      commands: shrunk.commands.filter((c) => c.hasRan).map((c) => c.toString()),
      evidence: evidenceOf(err), known: knownFor(check),
    };
  }
  // Backstop (T14 amendment): an unexpected refusal is a NEW failure, not a
  // count. The lock makes the shrunk failure one whenever one was thrown; if
  // it ever is not, this still reports it — with no path, since none replays
  // it — and keeps what it displaced as evidence.
  const unexpected = COMMAND_KINDS.reduce((s, k) => s + counts[k].unexpected, 0);
  if (unexpected > 0 && failure?.check !== UNEXPECTED_REFUSAL) {
    if (failure !== null) keepNew(failure.check, failure.commands);
    failure = {
      check: UNEXPECTED_REFUSAL, seed: input.seed, path: "", replayPath: null, commands: [],
      evidence: [
        `${unexpected} unexpected refusal(s) counted over the cell, yet the shrunk failure is ${failure === null ? "none" : failure.check} — an unexpected refusal outranks every other check`,
        ...(failure === null ? [] : [`displaced ${failure.check} (path ${failure.path}): ${failure.commands.join(" → ")} — ${failure.evidence.join("; ")}`]),
      ],
      known: knownFor(UNEXPECTED_REFUSAL),
    };
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
