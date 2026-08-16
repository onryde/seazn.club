// The bench's scorer, tested on its own before any model is called.
//
// The measurement this file protects: a bench that only counted "matched"
// rules would score a model that compiles EXTRA constraints as perfect. An
// invented rule is the worst outcome the parser has — schedule-ai-parse.ts's
// rule 2 says wording nobody can compile goes to `unparsed`, because a rule
// presented as enforced while nothing enforces it is worse than no rule. So
// `invented` is a first-class output here, not a footnote.
import { describe, expect, it } from "vitest";

import { scoreCase, type BenchCase } from "../parse-bench-score";
import type { RawHardConstraint } from "../schedule-ai-parse";

const COMPETITION = { kind: "competition" } as const;

const CAP_2: RawHardConstraint = {
  type: "max_fixtures_per_day",
  count: 2,
  scope: COMPETITION,
};
const REST_45: RawHardConstraint = {
  type: "min_rest_minutes",
  minutes: 45,
  rest_scope: "both",
  scope: COMPETITION,
};

const caseOf = (hard: RawHardConstraint[], unparsed = false): BenchCase => ({
  id: "t1",
  text: "irrelevant to scoring",
  expect: { hard, unparsed },
});

describe("scoreCase", () => {
  it("passes when the compiled rules are exactly the expected ones", () => {
    const score = scoreCase(caseOf([CAP_2, REST_45]), {
      hard: [CAP_2, REST_45],
      soft: [],
      unparsed: [],
    });

    expect(score.missing).toEqual([]);
    expect(score.invented).toEqual([]);
    expect(score.matched).toBe(2);
    expect(score.pass).toBe(true);
  });

  it("ignores the order the model listed the rules in", () => {
    const score = scoreCase(caseOf([CAP_2, REST_45]), {
      hard: [REST_45, CAP_2],
      soft: [],
      unparsed: [],
    });

    expect(score.pass).toBe(true);
  });

  it("ignores key order inside a single rule", () => {
    // z.object gives no ordering guarantee across providers, and a differently
    // keyed but identical rule is the SAME rule.
    const reordered = { scope: COMPETITION, count: 2, type: "max_fixtures_per_day" } as RawHardConstraint;
    const score = scoreCase(caseOf([CAP_2]), { hard: [reordered], soft: [], unparsed: [] });

    expect(score.pass).toBe(true);
  });

  it("reports a rule the model invented", () => {
    const score = scoreCase(caseOf([CAP_2]), {
      hard: [CAP_2, REST_45],
      soft: [],
      unparsed: [],
    });

    expect(score.invented).toEqual([REST_45]);
    expect(score.missing).toEqual([]);
    expect(score.pass).toBe(false);
  });

  it("reports an expected rule the model never compiled", () => {
    const score = scoreCase(caseOf([CAP_2, REST_45]), {
      hard: [CAP_2],
      soft: [],
      unparsed: [],
    });

    expect(score.missing).toEqual([REST_45]);
    expect(score.matched).toBe(1);
    expect(score.pass).toBe(false);
  });

  it("fails a per-player cap that was compiled instead of deferred to unparsed", () => {
    // PARSER_PROMPT rule 8. "no player plays more than 2 matches a day" is NOT
    // max_fixtures_per_day (which counts the whole scope's fixtures), and
    // compiling it tells the organiser a rule is enforced when nothing checks it.
    const score = scoreCase(caseOf([], true), {
      hard: [CAP_2],
      soft: [],
      unparsed: [],
    });

    expect(score.invented).toEqual([CAP_2]);
    expect(score.unparsedOk).toBe(false);
    expect(score.pass).toBe(false);
  });

  it("passes a per-player cap that was deferred verbatim to unparsed", () => {
    const score = scoreCase(caseOf([], true), {
      hard: [],
      soft: [],
      unparsed: ["no player plays more than 2 matches a day"],
    });

    expect(score.unparsedOk).toBe(true);
    expect(score.pass).toBe(true);
  });

  it("fails a case that expected no unparsed text but produced some", () => {
    const score = scoreCase(caseOf([CAP_2]), {
      hard: [CAP_2],
      soft: [],
      unparsed: ["something the model gave up on"],
    });

    expect(score.unparsedOk).toBe(false);
    expect(score.pass).toBe(false);
  });

  it("treats a failed parse as every expected rule missing, not as a pass", () => {
    // parseInstruction returns raw:null on transport failure, refusal, or a
    // twice-missed schema. An endpoint that cannot do json_schema at all lands
    // here — it must never be indistinguishable from a clean empty answer.
    const score = scoreCase(caseOf([CAP_2, REST_45]), null);

    expect(score.failed).toBe(true);
    expect(score.missing).toEqual([CAP_2, REST_45]);
    expect(score.matched).toBe(0);
    expect(score.pass).toBe(false);
  });

  it("does not pass an empty-expectation case on a failed parse", () => {
    // The degenerate trap: a case expecting nothing would otherwise be
    // "satisfied" by a model that answered nothing at all.
    const score = scoreCase(caseOf([], true), null);

    expect(score.failed).toBe(true);
    expect(score.pass).toBe(false);
  });

  it("counts a duplicate emission as invented rather than silently deduping", () => {
    const score = scoreCase(caseOf([CAP_2]), {
      hard: [CAP_2, CAP_2],
      soft: [],
      unparsed: [],
    });

    expect(score.invented).toEqual([CAP_2]);
    expect(score.pass).toBe(false);
  });
});
