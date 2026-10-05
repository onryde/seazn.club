// W1d Task 4 (review C1): run.ts writes <report-dir>/<slugRunId(--run-id)>/, so
// any caller that later reads that directory must hand over an id that is
// already its own slug. slugRunId is run.ts's slug, moved verbatim into a leaf
// so merge-shards.ts, run-sample.ts and the workflow tests can name it without
// loading the runner.
import { describe, expect, it } from "vitest";
import { RUN_ID_MAX, slugRunId } from "../lib/run-id.ts";
import { RUN_ID_MAX as RUN_ID_MAX_FROM_RUN } from "../run.ts";

describe("slugRunId", () => {
  it("is the identity on an id that is already a slug (the shape CI's templates emit)", () => {
    for (const id of ["ci-12345678901-2-l3-s1", "w1a-lxyz12", "a", "m1", "ci-1-1-l2", "x".repeat(RUN_ID_MAX)]) expect(slugRunId(id), id).toBe(id);
  });
  it("lower-cases and replaces every run of non-slug characters with one dash — the C1 trap: `…-L3-s1` names `…-l3-s1`", () => {
    expect(slugRunId("ci-1-1-L3-s1")).toBe("ci-1-1-l3-s1");
    expect(slugRunId("a_b c")).toBe("a-b-c");
    expect(slugRunId("a!!!b")).toBe("a-b");
    expect(slugRunId("A.B")).toBe("a-b");
  });
  it("trims leading and trailing dashes", () => {
    expect(slugRunId("-a-")).toBe("a");
    expect(slugRunId("--a--b--")).toBe("a--b");
    expect(slugRunId("__a__")).toBe("a");
  });
  it("answers null for an id with nothing slug-safe in it, and for the empty string", () => {
    for (const id of ["", "!!!", "---", "___", "   "]) expect(slugRunId(id), JSON.stringify(id)).toBeNull();
  });
  it("answers null for an id longer than RUN_ID_MAX once slugged, and keeps exactly RUN_ID_MAX", () => {
    expect(slugRunId("a".repeat(RUN_ID_MAX))).toBe("a".repeat(RUN_ID_MAX));
    expect(slugRunId("a".repeat(RUN_ID_MAX + 1))).toBeNull();
    // The length is judged on the SLUGGED text before its edge dashes are trimmed (run.ts's rule, kept verbatim).
    expect(slugRunId(`${"a".repeat(RUN_ID_MAX)}-`)).toBeNull();
  });
  it("a second call on its own answer changes nothing (idempotent)", () => {
    for (const id of ["CI-1-1-L3-S1", "a_b", "-x-", "ok"]) {
      const once = slugRunId(id);
      expect(once, id).not.toBeNull();
      expect(slugRunId(once as string), id).toBe(once);
    }
  });
  it("RUN_ID_MAX is one constant: run.ts still exports it (model.ts imports it from there) and it is the leaf's", () => {
    expect(RUN_ID_MAX_FROM_RUN).toBe(RUN_ID_MAX);
    expect(RUN_ID_MAX).toBe(40);
  });
});
