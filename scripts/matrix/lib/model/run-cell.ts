// One cell's model run: fc.check over fc.commands, each property run on a
// fresh division. Seeded (the caller derives the seed from the run id and the
// cell), path-replayable, time-boxed. A shrunk failure reports its check,
// seed, path, replayPath and the commands that RAN (R-PF9); it is KNOWN when
// an open committed regression names the same cell and check (R29).
// Anti-vacuity per cell, across runs (R25): every command kind ran, a Score
// was accepted, each applicable step invariant and fold parity judged more
// than zero items, and at least one step was informative.
//
// Two rules fast-check does not give on its own:
//  - The shrink is LOCKED to the first failure's check (shrinkTarget):
//    fast-check keeps any failing candidate while it shrinks, so a new bug
//    could otherwise shrink into a KNOWN one and read as known. A candidate
//    that fails on another check is passed over and counted in `masked`. An
//    unexpected refusal outranks every other check (T14 amendment: it is a
//    NEW failure, never merely counted), and a backstop after the check holds
//    to that even if the lock were bypassed.
//  - The time box is checked before each property run STARTS (fc.pre), never
//    raced against one in flight: fast-check's interruptAfterTimeLimit races
//    an async run (SkipAfterProperty: Promise.race with a timer) and abandons
//    it still writing to the product and to this report after runCell has
//    returned. The clock is injectable (`now`); the seed never touches it.
import fc from "fast-check";
import type { RowKey } from "../catalogue.ts";
import type { OrganiserDriver } from "../driver/types.ts";
import { STEP_INVARIANTS } from "../invariants.ts";
import type { RegressionCase } from "../scenario-catalogue.ts";
import { COMMAND_KINDS, ModelViolation, modelCommands } from "./commands.ts";
import { UNEXPECTED_REFUSAL, VACUITY_CHECK, informativeSteps, type CommandCounts, type CommandKind, type ModelState, type UnknownLedger } from "./state.ts";

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
  vacuous: string[];
  failure: CellFailure | null;
}

/** The shrink lock: given the check the shrink follows (null before any
 *  failure) and the check a run just failed on, the check it follows now — or
 *  null when this failure is passed over. An unexpected refusal outranks. */
export function shrinkTarget(current: string | null, thrown: string): string | null {
  if (current === null || thrown === current || thrown === UNEXPECTED_REFUSAL) return thrown;
  return null;
}

const checkOf = (e: unknown): string => (e instanceof ModelViolation ? e.check : "model-error");
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

export async function runCell(input: RunCellInput): Promise<CellReport> {
  const counts = Object.fromEntries(COMMAND_KINDS.map((k) => [k, zeroCounts()])) as Record<CommandKind, CommandCounts>;
  const stepChecks: Record<string, number> = {};
  const fenced: Record<string, number> = {};
  const unknowns = zeroUnknowns();
  const findings: Record<string, { count: number; evidence: string[] }> = {};
  const masked: Record<string, number> = {};
  const seen = { stageKind: null as string | null, foldParity: 0, informative: 0, executions: 0, timeBoxed: false };
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
  const constraints = { maxCommands: input.maxCommands, size: "max" as const, ...(input.replayPath === undefined ? {} : { replayPath: input.replayPath }) };
  const prop = fc.asyncProperty(fc.commands(modelCommands({ fences: input.fences }), constraints), async (cmds) => {
    if (now() >= deadline) {
      seen.timeBoxed = true;
      fc.pre(false);
    }
    let model: ModelState | null = null;
    try {
      const setup = await input.newDriverState(++seen.executions);
      model = setup.model;
      seen.stageKind = setup.model.stageKind;
      await fc.asyncModelRun(() => setup, cmds);
    } catch (e) {
      const check = checkOf(e);
      const next = shrinkTarget(target, check);
      if (next === null) {
        masked[check] = (masked[check] ?? 0) + 1;
        return;
      }
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

  const knownFor = (check: string): string | null =>
    input.regressions.find((r) => r.status === "open" && r.cell === input.cell && r.check === check)?.id ?? null;
  let failure: CellFailure | null = null;
  // A failed check with no counterexample is fast-check giving up on skips —
  // here only the time box skips a run — not a product failure.
  const shrunk = details.failed ? (details.counterexample?.[0] as RanCommands | undefined) : undefined;
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
    failure = {
      check: UNEXPECTED_REFUSAL, seed: input.seed, path: "", replayPath: null, commands: [],
      evidence: [
        `${unexpected} unexpected refusal(s) counted over the cell, yet the shrunk failure is ${failure === null ? "none" : failure.check} — an unexpected refusal outranks every other check`,
        ...(failure === null ? [] : [`displaced ${failure.check} (path ${failure.path}): ${failure.commands.join(" → ")} — ${failure.evidence.join("; ")}`]),
      ],
      known: knownFor(UNEXPECTED_REFUSAL),
    };
  }

  const vacuous: string[] = [];
  if (failure === null) {
    for (const k of COMMAND_KINDS) if (counts[k].ran === 0) vacuous.push(`command ${k} never ran`);
    if (counts.Score.accepted === 0) vacuous.push("no Score was accepted");
    // I6 is swiss-only: a league cell owes it no count; a swiss cell does.
    const kind = seen.stageKind;
    for (const s of STEP_INVARIANTS) {
      const applies = s.stageKinds === "any" || (kind !== null && s.stageKinds.includes(kind));
      if (applies && (stepChecks[s.id] ?? 0) === 0) vacuous.push(`step invariant ${s.id} checked zero items`);
    }
    if (seen.foldParity === 0) vacuous.push("fold parity compared zero fixtures");
    if (seen.informative === 0) vacuous.push(`no informative step (${VACUITY_CHECK})`);
  }
  return {
    cell: input.cell, variant: input.variant, seed: input.seed, runs: input.runs, maxCommands: input.maxCommands, fences: input.fences,
    numRuns: details.numRuns, executions: seen.executions, interrupted: seen.timeBoxed,
    counts, stepChecks, foldParity: seen.foldParity, fenced, unknowns, findings, informativeSteps: seen.informative, masked, vacuous, failure,
  };
}
