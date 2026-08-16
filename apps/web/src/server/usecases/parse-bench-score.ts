// Scoring for the instruction-parse bench. Pure, synchronous, no network — so
// the measurement itself can be trusted before any model is called.
//
// Three outcomes are tracked separately on purpose, because they mean different
// things to an organiser:
//
//   missing   the model did not compile a rule the instruction plainly stated.
//             The organiser's brief is quietly under-enforced.
//   invented  the model compiled a rule nobody asked for. This is the one that
//             matters most: schedule-ai-parse.ts's rule 2 exists because a rule
//             presented as enforced while nothing enforces it is WORSE than no
//             rule. A scorer that only counted hits would rate an inventive
//             model perfect.
//   failed    parseInstruction returned raw:null — transport error, refusal, or
//             a twice-missed schema. An OpenRouter endpoint without
//             `structured_outputs` lands here for every case, so this must
//             never be confused with "answered, but badly".
//
// `soft` is deliberately NOT scored. Soft notes are free text with a weight;
// there is no ground truth to compare them against, and grading them would
// require a judge model — a second nondeterministic thing inside the
// measurement.
import type { RawHardConstraint, RawParsed } from "./schedule-ai-parse";

/** One labelled corpus row. `expect.unparsed` is a boolean, not the text: we
 *  assert that uncompilable wording was DEFERRED, never that the model echoed
 *  it back with particular punctuation. */
export interface BenchCase {
  id: string;
  text: string;
  expect: {
    hard: RawHardConstraint[];
    unparsed: boolean;
  };
  /** What this row is designed to catch, for the report. */
  trap?: string;
}

export interface CaseScore {
  id: string;
  /** Expected rules the model also produced. */
  matched: number;
  /** Expected but absent, in the corpus's order. */
  missing: RawHardConstraint[];
  /** Produced but not expected, in the model's order. */
  invented: RawHardConstraint[];
  /** Did uncompilable wording end up deferred exactly when it should have? */
  unparsedOk: boolean;
  /** The parse itself did not return an object. */
  failed: boolean;
  pass: boolean;
}

/** Stable identity for a rule. Key order is not meaningful — `z.object` gives
 *  no ordering guarantee and it varies by provider — so sort recursively before
 *  stringifying, or the same rule serialised two ways reads as two rules. */
function canonical(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

function tally(rules: readonly RawHardConstraint[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const rule of rules) {
    const key = canonical(rule);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/** Multiset difference, preserving the caller's order. A rule emitted twice
 *  when it was expected once is one INVENTED rule, not a silent dedupe — a
 *  duplicate is still a rule the organiser did not ask for. */
function surplus(
  from: readonly RawHardConstraint[],
  against: Map<string, number>,
): RawHardConstraint[] {
  const remaining = new Map(against);
  const out: RawHardConstraint[] = [];
  for (const rule of from) {
    const key = canonical(rule);
    const left = remaining.get(key) ?? 0;
    if (left > 0) remaining.set(key, left - 1);
    else out.push(rule);
  }
  return out;
}

export function scoreCase(benchCase: BenchCase, actual: RawParsed | null): CaseScore {
  const expected = benchCase.expect.hard;

  if (actual === null) {
    // Everything is missing and nothing was deferred. Note `pass` is false even
    // when the case expected no rules at all: a model that answered nothing
    // must not score a point for a row whose right answer was "defer this".
    return {
      id: benchCase.id,
      matched: 0,
      missing: [...expected],
      invented: [],
      unparsedOk: false,
      failed: true,
      pass: false,
    };
  }

  const missing = surplus(expected, tally(actual.hard));
  const invented = surplus(actual.hard, tally(expected));
  const unparsedOk = benchCase.expect.unparsed === actual.unparsed.length > 0;

  return {
    id: benchCase.id,
    matched: expected.length - missing.length,
    missing,
    invented,
    unparsedOk,
    failed: false,
    pass: missing.length === 0 && invented.length === 0 && unparsedOk,
  };
}

export interface ArmSummary {
  /** Rows where every expected rule was compiled, nothing extra, deferral right. */
  passed: number;
  total: number;
  /** Rows the parse never answered — the json_schema-incapacity signature. */
  failed: number;
  /** Total invented rules across the corpus. The headline risk number. */
  invented: number;
  /** Total expected-but-absent rules. */
  missing: number;
}

export function summarise(scores: readonly CaseScore[]): ArmSummary {
  return {
    passed: scores.filter((s) => s.pass).length,
    total: scores.length,
    failed: scores.filter((s) => s.failed).length,
    invented: scores.reduce((n, s) => n + s.invented.length, 0),
    missing: scores.reduce((n, s) => n + s.missing.length, 0),
  };
}
