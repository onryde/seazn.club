// The corpus is hand-labelled, so it gets checked like any other hand-written
// thing. A label that does not itself satisfy RawParsed is unreachable: no
// model could ever match it, and the arm would be marked wrong for being right.
import { describe, expect, it } from "vitest";

import corpus from "./fixtures/parse-corpus.json";
import { RawParsed } from "../schedule-ai-parse";
import { scoreCase, type BenchCase } from "../parse-bench-score";

const CASES = corpus.cases as unknown as (BenchCase & { tier: number })[];
const DIVISION_IDS = new Set(corpus.context.divisions.map((d) => d.id));

describe("parse corpus", () => {
  it("is not empty and every id is unique", () => {
    expect(CASES.length).toBeGreaterThan(20);
    expect(new Set(CASES.map((c) => c.id)).size).toBe(CASES.length);
  });

  it.each(CASES.map((c) => [c.id, c] as const))(
    "%s has an expectation that is itself a valid RawParsed",
    (_id, benchCase) => {
      const parsed = RawParsed.safeParse({
        hard: benchCase.expect.hard,
        soft: [],
        unparsed: [],
      });
      expect(parsed.error?.message ?? "ok").toBe("ok");
    },
  );

  it("only scopes to division ids the model is actually shown", () => {
    // A label naming an id absent from `context.divisions` would demand the
    // model invent it - the exact failure the narrow Scope exists to prevent.
    const referenced: string[] = [];
    for (const benchCase of CASES) {
      for (const rule of benchCase.expect.hard) {
        const scope = (rule as { scope?: { kind: string; divisionId?: string } }).scope;
        if (scope?.kind === "division" && scope.divisionId) referenced.push(scope.divisionId);
      }
    }
    expect(referenced.length).toBeGreaterThan(0);
    expect(referenced.filter((id) => !DIVISION_IDS.has(id))).toEqual([]);
  });

  it("covers every tier from plainest to mostly-unexpressible", () => {
    expect(new Set(CASES.map((c) => c.tier))).toEqual(new Set([1, 2, 3, 4, 5]));
  });

  it("keeps a real deferral cohort, so the invented-rule metric can bite", () => {
    // If nothing expects deferral, a model that compiles everything scores
    // perfectly and the whole rule-2 measurement is vacuous.
    const deferring = CASES.filter((c) => c.expect.unparsed);
    expect(deferring.length).toBeGreaterThanOrEqual(8);
  });

  it("scores a perfect replay of its own labels as all-pass", () => {
    // Closes the loop between corpus and scorer: feed each label back as if a
    // model had produced it. Anything less than 100% means a label the scorer
    // cannot match, i.e. an unwinnable row.
    for (const benchCase of CASES) {
      const score = scoreCase(benchCase, {
        hard: benchCase.expect.hard,
        soft: [],
        unparsed: benchCase.expect.unparsed ? ["deferred wording"] : [],
      });
      expect(`${benchCase.id}:${score.pass}`).toBe(`${benchCase.id}:true`);
    }
  });
});
