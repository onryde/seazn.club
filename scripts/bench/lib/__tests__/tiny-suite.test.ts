// Unit coverage for the `_tiny` suite's PACK STAGE (lib/suites/tiny.ts) — the
// half of the bench's own smoke loop that runs before anything is created over
// HTTP.
//
// The HTTP half is deliberately NOT exercised here: it needs a live server and
// a database, and this file runs in CI's DB-free job. What IS exercised is the
// seam the controller named — the suite now reads its seed data from
// `packs/_tiny.json`, the same file the validator proves itself on, so runner
// and validator share ONE fixture.
//
// The two things this file pins, both of which would otherwise go inert:
//
//  * The run SUCCEEDS on a pack carrying warnings, and still surfaces them.
//    `_tiny` permanently carries two `*.not_derived` warnings by design. A
//    stage that gated on "any finding at all" would red forever and the honest
//    warning would be deleted to make it pass — which is the wrong repair.
//  * Every number the suite asserts against the live API is DERIVED from the
//    pack. The fixture count in particular: it was hardcoded `!== 1`, the pack
//    later declared `legs: 3`, and the assertion went on passing for a shape
//    the pack no longer had.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import pino from "pino";
import { loadPackValue } from "../pack-io.ts";
import { runTinySuite, TINY_PACK_PATH, tinyPackStage, tinyPlan } from "../suites/tiny.ts";
import type { Pack } from "../pack-schema.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../../..");
const TINY_TEXT = readFileSync(TINY_PACK_PATH, "utf8");

function tinyPack(): Pack {
  const load = loadPackValue(JSON.parse(TINY_TEXT) as unknown, TINY_PACK_PATH);
  if (!load.ok) throw new Error("the committed _tiny.json no longer loads");
  return load.pack;
}

describe("TINY_PACK_PATH", () => {
  it("points at the committed micro-pack, resolved from this module rather than from cwd", () => {
    expect(TINY_PACK_PATH).toBe(path.join(REPO_ROOT, "scripts/bench/packs/_tiny.json"));
  });
});

describe("tinyPackStage — warnings are reportable, never fatal", () => {
  it("SUCCEEDS on the committed pack and still surfaces its two warnings", async () => {
    const stage = await tinyPackStage(TINY_PACK_PATH);
    // The run proceeds…
    expect(stage.ok).toBe(true);
    if (!stage.ok) throw new Error(`refused: ${stage.errors.join(" | ")}`);
    // …and the warnings reach the report rather than being swallowed.
    expect(stage.warnings).toHaveLength(2);
    expect(stage.warnings.join(" | ")).toContain("leaderboards.not_derived");
    expect(stage.warnings.join(" | ")).toContain("champions.not_derived");
    // Each says what was NOT checked and who owes it, not merely that
    // something happened.
    expect(stage.warnings.join(" | ")).toContain("NOT checked offline");
  });

  it("REFUSES, with no plan, when the pack itself is wrong", async () => {
    const stage = await tinyPackStage(path.join(REPO_ROOT, "scripts/bench/packs/_absent.json"));
    expect(stage.ok).toBe(false);
    if (stage.ok) throw new Error("unreachable");
    expect(stage.errors.join(" | ")).toContain("pack.unreadable");
    expect(Object.prototype.hasOwnProperty.call(stage, "plan")).toBe(false);
  });

  it("REFUSES the SAME BYTES under another filename — the pack/filename check reaches the runner", async () => {
    // Addendum 2's proof, driven through the runner's own call site rather
    // than through the validator directly: `expectedSuite` is derived from the
    // path the bytes came from, so `_tiny`'s content under a different name is
    // refused. A call site that dropped the argument, or passed the pack's own
    // `suite`, or passed a constant `"_tiny"`, would load this green.
    const dir = mkdtempSync(path.join(tmpdir(), "bench-tiny-"));
    const misnamed = path.join(dir, "wimbledon-2019.json");
    writeFileSync(misnamed, TINY_TEXT, "utf8");
    const stage = await tinyPackStage(misnamed);
    expect(stage.ok).toBe(false);
    if (stage.ok) throw new Error("unreachable");
    const said = stage.errors.join(" | ");
    expect(said).toContain("pack.suite_mismatch");
    // BOTH values, never just the code: `undefined` vs `"_tiny"` also raises
    // `pack.suite_mismatch`, so a code-only assertion proves nothing.
    expect(said).toContain('pack declares suite "_tiny"');
    expect(said).toContain('the caller expected "wimbledon-2019"');
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("runTinySuite — what the SuiteReport carries", () => {
  // Two paths, both reachable with no server: the pack stage refusing before
  // anything is created, and the HTTP half failing after it. Neither is the
  // live run — that needs a database and is the owner's to drive — but both
  // are the report SHAPE, and the shape is where a warning goes missing.
  const silent = pino({ level: "silent" });

  it("refuses BEFORE the network when the pack is wrong, and says so in the report", async () => {
    const report = await runTinySuite({
      // A base that would fail loudly if anything reached it.
      base: "http://127.0.0.1:1",
      engine: "optimized",
      keep: true,
      log: silent,
      packPath: path.join(REPO_ROOT, "scripts/bench/packs/_absent.json"),
    });
    expect(report.gate).toBe("red");
    expect((report.errors ?? []).join(" | ")).toContain("pack.unreadable");
    // `requestedEngine` still records what the CLI asked for, even on the
    // path that never got as far as the solver.
    expect(report.solver?.requestedEngine).toBe("optimized");
  });

  it("carries the pack's warnings into the report even when the HTTP half fails", async () => {
    const report = await runTinySuite({
      base: "http://127.0.0.1:1",
      engine: "greedy",
      keep: false,
      log: silent,
      packPath: TINY_PACK_PATH,
    });
    // The network is unreachable, so the gate is red for THAT reason…
    expect(report.gate).toBe("red");
    expect(report.errors ?? []).not.toHaveLength(0);
    // …and the pack's two permanent warnings still reached the report rather
    // than being dropped on the way through the run.
    expect(report.warnings ?? []).toHaveLength(2);
    expect((report.warnings ?? []).join(" | ")).toContain("leaderboards.not_derived");
  });
});

describe("tinyPlan — every number the live run asserts comes from the pack", () => {
  it("derives the fixture count from the pack's entrants and legs, not from a constant", () => {
    // `_tiny` declares 2 entrants and `legs: 3`.
    expect(tinyPlan(tinyPack()).expectedFixtures).toBe(3);
  });

  it("MOVES when the pack's legs move", () => {
    const pack = tinyPack();
    const withLegs = (legs: number): Pack =>
      ({
        ...pack,
        divisions: [
          {
            ...pack.divisions[0],
            stages: [{ ...(pack.divisions[0]?.stages[0] as object), config: { legs } }],
          },
        ],
      }) as Pack;
    // FIVE, not one and not three — the two values a hardcoded bound would
    // plausibly be. A "moves" test whose expected value coincides with the
    // wrong constant cannot witness the regression it exists for; this one
    // was written with `1` and survived hardcoding `1`.
    expect(tinyPlan(withLegs(5)).expectedFixtures).toBe(5);
    expect(tinyPlan(withLegs(1)).expectedFixtures).toBe(1);
  });

  it("carries the pack's own competition, division, entrants and stage", () => {
    const plan = tinyPlan(tinyPack());
    expect(plan.competitionName).toBe("Bench Tiny Series");
    expect(plan.endsOn).toBe("2099-01-03");
    expect(plan.divisionName).toBe("Tiny");
    expect(plan.sportKey).toBe("generic");
    expect(plan.variantKey).toBe("score");
    // The division cfg is the pack's `cfgOverrides`, verbatim — the same
    // record stage 0 folded every one of its streams under.
    expect(plan.divisionConfig).toEqual({
      resultMode: "score",
      allowDraws: true,
      points: { w: 3, d: 1, l: 0 },
      progressScore: false,
    });
    expect(plan.entrants).toEqual([
      { kind: "individual", display_name: "Ana Alvarez", seed: 1 },
      { kind: "individual", display_name: "Bo Baptiste", seed: 2 },
    ]);
    expect(plan.stage).toEqual({
      seq: 1,
      kind: "league",
      name: "League",
      config: { legs: 3 },
    });
  });

  it("refuses a pack that is not the ONE-division, ONE-stage shape this suite drives", () => {
    const pack = tinyPack();
    const twoStages = {
      ...pack,
      divisions: [
        {
          ...pack.divisions[0],
          stages: [
            pack.divisions[0]?.stages[0],
            { ...(pack.divisions[0]?.stages[0] as object), ref: "s2", seq: 2 },
          ],
        },
      ],
    } as Pack;
    expect(() => tinyPlan(twoStages)).toThrow(/exactly one stage/);

    const twoDivisions = { ...pack, divisions: [pack.divisions[0], pack.divisions[0]] } as Pack;
    expect(() => tinyPlan(twoDivisions)).toThrow(/exactly one division/);
  });
});
