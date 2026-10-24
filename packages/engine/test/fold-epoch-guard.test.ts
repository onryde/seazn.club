// Engine-split Task 1e-2 (D15, D26): the fold-epoch guard's RULE, tested as the pure function it is. The CLI around it (git, the temp import of
// the baseline's table, exit codes) is spawned against real git history in fold-epoch-guard-cli.test.ts, which imports nothing under src/ so
// that a Stryker related-mode run of a sport file never runs its spawns.
//
// Fixtures are built on the real GoldenCorpus/GoldenStream interfaces, and every sweep over the sports takes the list from the registry and
// reports how many it visited (TEST-STRATEGY rule 2): zero visited is a failure, never a pass.
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { epochViolations, compareSides, foldOptionsProblem, foldSourceTouched, GuardRefusal, guardVerdicts, parseStatsFoldVersion, sideStatsVersion, STATS_REQUIRED, statsVersionRow, type Side } from "../scripts/fold-epoch-guard.ts";
import { builtinModules } from "../src/sports/index.ts";
import { STATS_FOLD_VERSION } from "../src/stats/stats.ts";
import { forEachSport } from "../src/testkit/for-each-sport.ts";
import { readCorpus, type GoldenCorpus, type GoldenStream } from "../src/testkit/golden.ts";
import { floorBatches, isFloorStream } from "../src/testkit/golden-floor-streams.ts";
import { treeBudget } from "./tree-budget.ts";

const stream = (config: string, seed: number, over: Partial<GoldenStream> = {}): GoldenStream =>
  ({ config, seed, events: [{ seq: 1 }], states: ["s1"], outcome: "A", summary: "{}", deltas: "[]", ...over }) as unknown as GoldenStream;
/** A corpus whose `configs` holds one (empty) raw config object per config name its streams use, unless `configs` says otherwise. */
const corpus = (streams: GoldenStream[], key = "badminton", configs: Record<string, unknown> = Object.fromEntries(streams.map((s) => [s.config, {}]))): GoldenCorpus =>
  ({ key, version: "1.0.0", configs, streams, recordedBy: "test", params: {} }) as unknown as GoldenCorpus;
const side = (epoch: number, streams: GoldenStream[]): Side => ({ epochs: { badminton: epoch }, corpora: { badminton: corpus(streams) } });
const sports = (v: ReturnType<typeof epochViolations>) => v.map((x) => x.sport);

describe("fold-epoch guard: the rule", () => {
  it("demands a bump when an existing stream's outcome changes", () => {
    expect(sports(epochViolations(side(1, [stream("std", 1)]), side(1, [stream("std", 1, { outcome: "B" })])))).toEqual(["badminton"]);
  });
  it("demands a bump when only a mid-match state changes (what a phone renders)", () => {
    expect(sports(epochViolations(side(1, [stream("std", 1)]), side(1, [stream("std", 1, { states: ["s1-new"] })])))).toEqual(["badminton"]);
  });
  it("demands a bump when a stream now folds to more states, or fewer, with every state it shares unchanged", () => {
    const base = side(1, [stream("std", 1, { states: ["s1", "s2"] })]);
    expect(sports(epochViolations(base, side(1, [stream("std", 1, { states: ["s1", "s2", "s3"] })])))).toEqual(["badminton"]);
    expect(sports(epochViolations(base, side(1, [stream("std", 1, { states: ["s1"] })])))).toEqual(["badminton"]);
  });
  it("demands a bump when only the summary, or only the standings deltas, change", () => {
    expect(sports(epochViolations(side(1, [stream("std", 1)]), side(1, [stream("std", 1, { summary: '{"x":1}' })])))).toEqual(["badminton"]);
    expect(sports(epochViolations(side(1, [stream("std", 1)]), side(1, [stream("std", 1, { deltas: "[1]" })])))).toEqual(["badminton"]);
  });
  it("is satisfied by the bump", () => {
    expect(epochViolations(side(1, [stream("std", 1)]), side(2, [stream("std", 1, { outcome: "B" })]))).toEqual([]);
  });
  it("is satisfied only by a RISE: the same number after a change is still red, and so is any number below", () => {
    const changed = [stream("std", 1, { outcome: "B" })];
    expect(sports(epochViolations(side(3, [stream("std", 1)]), side(3, changed)))).toEqual(["badminton"]);
    expect(sports(epochViolations(side(3, [stream("std", 1)]), side(2, changed)))).toEqual(["badminton"]);
    expect(epochViolations(side(3, [stream("std", 1)]), side(4, changed))).toEqual([]);
  });
  it("does not demand a bump for an added stream (EXTEND_GOLDEN)", () => {
    expect(epochViolations(side(1, [stream("std", 1)]), side(1, [stream("std", 1), stream("std", 2)]))).toEqual([]);
  });
  it("does not demand a bump when streams are only reordered", () => {
    expect(epochViolations(side(1, [stream("std", 1), stream("std", 2)]), side(1, [stream("std", 2), stream("std", 1)]))).toEqual([]);
  });
  it("does not demand a bump for the same events written with their keys in another order", () => {
    const a = stream("std", 1, { events: [{ type: "point", payload: { side: "home", n: 1 } }] as never });
    const b = stream("std", 1, { events: [{ payload: { n: 1, side: "home" }, type: "point" }] as never });
    expect(epochViolations(side(1, [a]), side(1, [b]))).toEqual([]);
  });
  it("treats a re-recorded stream (events differ) as removed, which demands a bump", () => {
    expect(sports(epochViolations(side(1, [stream("std", 1)]), side(1, [stream("std", 1, { events: [{ seq: 9 }] as never })])))).toEqual(["badminton"]);
  });
  it("treats a stream recorded against other lineups as re-recorded too, even when its events and results are the same", () => {
    const lineups = { home: [], away: [] } as never;
    expect(sports(epochViolations(side(1, [stream("std", 1)]), side(1, [stream("std", 1, { lineups })])))).toEqual(["badminton"]);
  });
  it("fails closed when a config is renamed and nothing matches", () => {
    const v = epochViolations(side(1, [stream("std", 1)]), side(1, [stream("standard", 1)]));
    expect(sports(v)).toEqual(["badminton"]);
    expect(v[0]!.reason).toMatch(/no baseline stream matched, 1 stream\(s\) removed or re-recorded/);
  });
  it("fails closed when every stream is removed", () => {
    expect(sports(epochViolations(side(1, [stream("std", 1)]), side(1, [])))).toEqual(["badminton"]);
  });
  it("demands a bump when ONE of several streams is removed, and says how many", () => {
    const v = epochViolations(side(1, [stream("std", 1), stream("std", 2), stream("std", 3)]), side(1, [stream("std", 1), stream("std", 2)]));
    expect(v.map((x) => ({ sport: x.sport, matched: x.matched, changed: x.changed, removed: x.removed, added: x.added }))).toEqual([{ sport: "badminton", matched: 2, changed: 0, removed: 1, added: 0 }]);
  });
  it("is satisfied by the bump when streams are removed", () => {
    expect(epochViolations(side(1, [stream("std", 1), stream("std", 2)]), side(2, [stream("std", 1)]))).toEqual([]);
  });
  it("treats a missing baseline as nothing to compare, not as a pass by crash", () => {
    expect(epochViolations(null, side(1, [stream("std", 1)]))).toEqual([]);
    expect(compareSides(null, side(1, [stream("std", 1)]))).toEqual([]);
  });
  it("refuses an epoch that went down", () => {
    expect(sports(epochViolations(side(2, [stream("std", 1)]), side(1, [stream("std", 1)])))).toEqual(["badminton"]);
  });
  it("refuses an epoch that went down even when no stream changed", () => {
    const v = epochViolations(side(2, [stream("std", 1)]), side(1, [stream("std", 1)]));
    expect(v[0]).toMatchObject({ matched: 1, changed: 0, removed: 0, added: 0, before: 2, after: 1 });
    expect(v[0]!.reason).toMatch(/went down/);
  });
  it("lets an epoch rise on its own: a bump with nothing changed is not a violation", () => {
    expect(epochViolations(side(1, [stream("std", 1)]), side(2, [stream("std", 1)]))).toEqual([]);
  });
  it("names the sport and its counts in the violation", () => {
    const before = side(1, [stream("std", 1), stream("std", 2), stream("std", 3)]);
    const after = side(1, [stream("std", 1), stream("std", 2, { outcome: "B" }), stream("std", 4)]);
    expect(epochViolations(before, after)).toEqual([
      { sport: "badminton", matched: 2, changed: 1, deltasOnly: 0, statsOnly: 0, removed: 1, added: 1, recorded: 0, before: 1, after: 1, beforeMinor: 0, afterMinor: 0, owes: "major", reason: expect.stringMatching(/1 stream\(s\) fold differently.*1 stream\(s\) removed or re-recorded.*did not rise \(1 -> 1\)/) },
    ]);
  });
  describe("a stream's input is its raw config object as well as its events and lineups", () => {
    const streams = [stream("std", 1), stream("std", 2), stream("other", 1)];
    const withConfigs = (epoch: number, configs: Record<string, unknown>, s = streams): Side => ({ epochs: { badminton: epoch }, corpora: { badminton: corpus(s, "badminton", configs) } });
    const base = { std: { setTo: 21 }, other: { setTo: 11 } };
    it("a default written out explicitly in a config the results do not show is a re-record of every stream replayed against it: removed and added, a bump owed", () => {
      // the rule change a module makes to a default (cap 30 -> 31), with the old value written into the recorded configs so every replay still
      // folds to the same result: nothing in events, states, outcome, summary or deltas moved
      const v = epochViolations(withConfigs(1, base), withConfigs(1, { ...base, std: { setTo: 21, cap: 30 } }));
      expect(v).toHaveLength(1);
      const std = streams.filter((x) => x.config === "std").length;
      expect(v[0]).toMatchObject({ sport: "badminton", matched: streams.length - std, changed: 0, removed: std, added: std });
      expect(v[0]!.reason).toMatch(new RegExp(`${std} stream\\(s\\) removed or re-recorded`));
      expect(epochViolations(withConfigs(1, base), withConfigs(2, { ...base, std: { setTo: 21, cap: 30 } }))).toEqual([]);
    });
    it("a config value that changed is the same, and so is one that was removed", () => {
      for (const after of [{ ...base, std: { setTo: 25 } }, { ...base, std: {} }]) {
        expect(epochViolations(withConfigs(1, base), withConfigs(1, after)).map((x) => [x.sport, x.removed, x.added])).toEqual([["badminton", 2, 2]]);
      }
    });
    it("only the streams that name the changed config are re-recorded: the others still match", () => {
      const [row] = compareSides(withConfigs(1, base), withConfigs(1, { ...base, other: { setTo: 15 } }));
      expect(row).toMatchObject({ matched: 2, removed: 1, added: 1 });
    });
    it("a config written with its keys in another order is the same config", () => {
      const nested = { std: { setTo: 21, pointsMap: { "*": [2, 0], x: [1, 1] } }, other: base.other };
      const shuffled = { other: base.other, std: { pointsMap: { x: [1, 1], "*": [2, 0] }, setTo: 21 } };
      expect(epochViolations(withConfigs(1, nested), withConfigs(1, shuffled))).toEqual([]);
    });
    it("a config no stream is replayed against may change freely (nothing folds through it)", () => {
      const spare = { ...base, unused: { cap: 1 } };
      expect(epochViolations(withConfigs(1, spare), withConfigs(1, { ...spare, unused: { cap: 2 } }))).toEqual([]);
    });
  });
  it("tells the author what to do: which entry in which file, and the number to set (one above the baseline's, not just 'bump it')", () => {
    const v = epochViolations(side(3, [stream("std", 1)]), side(3, [stream("std", 1, { outcome: "B" })]));
    expect(v).toHaveLength(1);
    expect(v[0]!.reason).toContain("raise FOLD_EPOCH.badminton to 4 in src/sport/fold-epoch.ts");
    const down = epochViolations(side(3, [stream("std", 1)]), side(2, [stream("std", 1)]));
    expect(down).toHaveLength(1);
    expect(down[0]!.reason).toContain("set FOLD_EPOCH.badminton back to at least 3 in src/sport/fold-epoch.ts");
    // lowered AND changed: the number to raise to is one above the BASELINE's (4), not one above the lowered value (3)
    const both = epochViolations(side(3, [stream("std", 1)]), side(2, [stream("std", 1, { outcome: "B" })]));
    expect(both).toHaveLength(1);
    expect(both[0]!.reason).toContain("raise FOLD_EPOCH.badminton to 4 in src/sport/fold-epoch.ts");
    expect(both[0]!.reason).toContain("set FOLD_EPOCH.badminton back to at least 3");
  });
  it("accounts every stream exactly once: matched + removed = baseline streams, matched + added = streams now", () => {
    const before = [stream("a", 1), stream("a", 2), stream("b", 1), stream("b", 2, { outcome: "X" })];
    const after = [stream("a", 1), stream("a", 2, { events: [{ seq: 5 }] as never }), stream("b", 2, { outcome: "Y" }), stream("c", 1)];
    const [row] = compareSides(side(1, before), side(1, after));
    expect(row).toMatchObject({ sport: "badminton", matched: 2, changed: 1, removed: 2, added: 2 });
    expect(row!.matched + row!.removed).toBe(before.length);
    expect(row!.matched + row!.added).toBe(after.length);
  });
  it("refuses two streams with the same identity in one corpus instead of comparing the wrong pair", () => {
    expect(() => epochViolations(side(1, [stream("std", 1), stream("std", 1, { outcome: "B" })]), side(1, [stream("std", 1)]))).toThrow(GuardRefusal);
    expect(() => epochViolations(side(1, [stream("std", 1)]), side(1, [stream("std", 1), stream("std", 1)]))).toThrow(/duplicate stream identity "std#1"/);
  });

  describe("the pair (major, minor): a change only the server computes owes a MINOR, a change a phone computes owes a MAJOR", () => {
    /** A side holding badminton at (major, minor). */
    const at = (major: number, minor: number, streams: GoldenStream[]): Side => ({ epochs: { badminton: major }, minors: { badminton: minor }, corpora: { badminton: corpus(streams) } });
    const base = [stream("std", 1), stream("std", 2)];
    const deltasMoved = [stream("std", 1), stream("std", 2, { deltas: "[1]" })];
    /** The three recorded results a phone computes, each moved on its own. */
    const PHONE: ReadonlyArray<readonly [string, Partial<GoldenStream>]> = [["states", { states: ["s1-new"] }], ["outcome", { outcome: "B" }], ["summary", { summary: '{"x":1}' }]];
    const owes = (v: ReturnType<typeof epochViolations>) => v.map((x) => [x.sport, x.owes]);

    it("a deltas-only change (states, outcome and summary the same) owes a MINOR: red unbumped, counted as deltas-only and not as a changed fold, and the reason names FOLD_MINOR and the number", () => {
      const v = epochViolations(at(1, 0, base), at(1, 0, deltasMoved));
      expect(v).toHaveLength(1);
      expect(v[0]).toMatchObject({ sport: "badminton", matched: 2, changed: 0, deltasOnly: 1, removed: 0, added: 0, owes: "minor", before: 1, after: 1, beforeMinor: 0, afterMinor: 0 });
      expect(v[0]!.reason).toContain("minor owed");
      expect(v[0]!.reason).toContain("raise FOLD_MINOR.badminton to 1 in src/sport/fold-epoch.ts");
      expect(v[0]!.reason, "the major is not what is owed").not.toContain("raise FOLD_EPOCH");
      // one above the BASELINE's minor, whatever it is (a constant 1 would pass the case above)
      const later = epochViolations(at(2, 4, base), at(2, 4, deltasMoved));
      expect(later[0]!.reason).toContain("raise FOLD_MINOR.badminton to 5 in src/sport/fold-epoch.ts");
    });

    it("is settled by a minor bump, by any rise of it, or by a major bump with the minor unchanged or reset to 0", () => {
      expect(epochViolations(at(1, 0, base), at(1, 1, deltasMoved))).toEqual([]);
      expect(epochViolations(at(1, 4, base), at(1, 9, deltasMoved))).toEqual([]);
      expect(epochViolations(at(1, 4, base), at(2, 4, deltasMoved))).toEqual([]);
      expect(epochViolations(at(1, 4, base), at(2, 0, deltasMoved))).toEqual([]);
      expect(epochViolations(at(1, 4, base), at(3, 0, deltasMoved))).toEqual([]);
    });

    it("a change a phone computes (a state, the outcome or the summary) owes a MAJOR: a minor bump, however large, does not settle it, and says so", () => {
      let checked = 0;
      for (const [field, over] of PHONE) {
        const moved = [stream("std", 1), stream("std", 2, over)];
        expect(owes(epochViolations(at(1, 0, base), at(1, 0, moved))), `${field}: nothing bumped`).toEqual([["badminton", "major"]]);
        const minorOnly = epochViolations(at(1, 0, base), at(1, 7, moved));
        expect(owes(minorOnly), `${field}: only the minor bumped`).toEqual([["badminton", "major"]]);
        expect(minorOnly[0]).toMatchObject({ changed: 1, deltasOnly: 0, beforeMinor: 0, afterMinor: 7 });
        expect(minorOnly[0]!.reason, field).toContain("raise FOLD_EPOCH.badminton to 2 in src/sport/fold-epoch.ts");
        expect(minorOnly[0]!.reason, field).toMatch(/FOLD_MINOR 0 -> 7 does not stand in for it/);
        expect(epochViolations(at(1, 0, base), at(2, 0, moved)), `${field}: major bumped`).toEqual([]);
        expect(epochViolations(at(1, 3, base), at(2, 0, moved)), `${field}: major bumped, minor reset`).toEqual([]);
        expect(epochViolations(at(1, 3, base), at(2, 9, moved)), `${field}: major bumped, minor raised`).toEqual([]);
        checked++;
      }
      expect(checked).toBe(PHONE.length);
    });

    it("a stream that differs in its standings deltas AND in a state, outcome or summary is one changed fold, not also a deltas-only one", () => {
      const both = [stream("std", 1), stream("std", 2, { outcome: "B", deltas: "[1]" })];
      const [row] = compareSides(at(1, 0, base), at(1, 0, both));
      expect(row).toMatchObject({ matched: 2, changed: 1, deltasOnly: 0, owes: "major" });
    });

    it("both kinds in one sport owe the MAJOR: the minor bump that would settle the deltas does not settle the other stream, the major bump settles both", () => {
      const mixed = [stream("std", 1, { deltas: "[1]" }), stream("std", 2, { outcome: "B" })];
      const v = epochViolations(at(1, 0, base), at(1, 1, mixed));
      expect(v).toHaveLength(1);
      expect(v[0]).toMatchObject({ matched: 2, changed: 1, deltasOnly: 1, owes: "major" });
      expect(v[0]!.reason).toContain("raise FOLD_EPOCH.badminton to 2");
      expect(epochViolations(at(1, 0, base), at(2, 0, mixed))).toEqual([]);
    });

    it("accounts every matched stream exactly once: unchanged + changed + deltas-only", () => {
      const before = [stream("a", 1), stream("a", 2), stream("a", 3), stream("a", 4)];
      const after = [stream("a", 1), stream("a", 2, { deltas: "[2]" }), stream("a", 3, { summary: "{}x" }), stream("a", 4, { deltas: "[3]", outcome: "Z" })];
      const [row] = compareSides(at(1, 0, before), at(1, 0, after));
      expect(row).toMatchObject({ matched: 4, changed: 2, deltasOnly: 1 });
      expect(row!.matched - row!.changed - row!.deltasOnly, "the unchanged one").toBe(1);
    });

    it("a stream removed, re-recorded or recorded against a changed config object owes the MAJOR whatever the minor does (the laundering route stays closed)", () => {
      const withConfig = (major: number, minor: number, cfg: unknown, streams = base): Side => ({ epochs: { badminton: major }, minors: { badminton: minor }, corpora: { badminton: corpus(streams, "badminton", { std: cfg }) } });
      // removed
      expect(owes(epochViolations(at(1, 0, base), at(1, 5, [stream("std", 1)])))).toEqual([["badminton", "major"]]);
      expect(epochViolations(at(1, 0, base), at(2, 0, [stream("std", 1)]))).toEqual([]);
      // re-recorded (its events differ)
      expect(owes(epochViolations(at(1, 0, base), at(1, 5, [stream("std", 1), stream("std", 2, { events: [{ seq: 9 }] as never })])))).toEqual([["badminton", "major"]]);
      // the config object changed and every result is byte for byte the same
      const launder = epochViolations(withConfig(1, 0, { setTo: 21 }), withConfig(1, 5, { setTo: 21, cap: 30 }));
      expect(launder).toHaveLength(1);
      expect(launder[0]).toMatchObject({ changed: 0, deltasOnly: 0, removed: 2, added: 2, owes: "major", beforeMinor: 0, afterMinor: 5 });
      expect(epochViolations(withConfig(1, 0, { setTo: 21 }), withConfig(2, 0, { setTo: 21, cap: 30 }))).toEqual([]);
      // and the same laundering with a deltas-only move beside it is still a major
      const both = epochViolations(withConfig(1, 0, { setTo: 21 }), withConfig(1, 5, { setTo: 21, cap: 30 }, deltasMoved));
      expect(owes(both)).toEqual([["badminton", "major"]]);
    });

    it("a minor on its own, with nothing changed, is not a violation; a minor that fell is, whatever the streams did", () => {
      expect(epochViolations(at(1, 0, base), at(1, 1, base))).toEqual([]);
      const down = epochViolations(at(1, 3, base), at(1, 2, base));
      expect(down).toHaveLength(1);
      expect(down[0]).toMatchObject({ owes: null, matched: 2, changed: 0, deltasOnly: 0, beforeMinor: 3, afterMinor: 2 });
      expect(down[0]!.reason).toMatch(/FOLD_MINOR went down \(3 -> 2\)/);
      expect(down[0]!.reason).toContain("set FOLD_MINOR.badminton back to at least 3 in src/sport/fold-epoch.ts");
      expect(epochViolations(at(1, 3, base), at(1, 3, base))).toEqual([]);
    });

    it("the pair only goes up lexicographically: a major that fell is red even when the minor rose, and a major that rose may reset the minor to 0", () => {
      const lower = epochViolations(at(2, 1, base), at(1, 5, base));
      expect(lower).toHaveLength(1);
      expect(lower[0]!.reason).toMatch(/FOLD_EPOCH went down \(2 -> 1\)/);
      expect(lower[0]!.reason).toContain("set FOLD_EPOCH.badminton back to at least 2 in src/sport/fold-epoch.ts");
      expect(epochViolations(at(1, 3, base), at(2, 0, base))).toEqual([]);
      expect(epochViolations(at(1, 3, base), at(2, 1, base))).toEqual([]);
      expect(epochViolations(at(1, 3, base), at(2, 9, base))).toEqual([]);
    });

    it("a minor that fell while deltas moved is red twice over: it went down, and a rise is still owed (one above the baseline's)", () => {
      const v = epochViolations(at(1, 3, base), at(1, 2, deltasMoved));
      expect(v).toHaveLength(1);
      expect(v[0]!.reason).toContain("set FOLD_MINOR.badminton back to at least 3");
      expect(v[0]!.reason).toContain("raise FOLD_MINOR.badminton to 4");
    });

    it("a baseline whose table has no FOLD_MINOR is minor 0 for every sport: the introducing change owes nothing unless it moves a delta", () => {
      const old = (streams: GoldenStream[]): Side => ({ epochs: { badminton: 1 }, corpora: { badminton: corpus(streams) } });
      expect(epochViolations(old(base), at(1, 0, base))).toEqual([]);
      expect(epochViolations(old(base), at(1, 4, base))).toEqual([]);
      const unbumped = epochViolations(old(base), at(1, 0, deltasMoved));
      expect(owes(unbumped)).toEqual([["badminton", "minor"]]);
      expect(unbumped[0]).toMatchObject({ beforeMinor: 0, afterMinor: 0 });
      expect(unbumped[0]!.reason).toContain("raise FOLD_MINOR.badminton to 1");
      expect(epochViolations(old(base), at(1, 1, deltasMoved))).toEqual([]);
      expect(owes(epochViolations(old(base), at(1, 3, [stream("std", 1), stream("std", 2, { outcome: "B" })])))).toEqual([["badminton", "major"]]);
    });

    it("a sport a side's FOLD_MINOR does not name reads as minor 0, like a side with no FOLD_MINOR at all (the CLI refuses such a table before this is asked)", () => {
      const unnamed = (minors: Record<string, number>, streams: GoldenStream[]): Side => ({ epochs: { badminton: 1 }, minors, corpora: { badminton: corpus(streams) } });
      // baseline names nothing (minor 0): a minor of 1 pays a deltas-only move, and a minor of 0 does not
      expect(epochViolations(unnamed({}, base), unnamed({ badminton: 1 }, deltasMoved))).toEqual([]);
      const unpaid = epochViolations(unnamed({}, base), unnamed({}, deltasMoved));
      expect(unpaid).toHaveLength(1);
      expect(unpaid[0]).toMatchObject({ beforeMinor: 0, afterMinor: 0, owes: "minor" });
      expect(unpaid[0]!.reason).toContain("raise FOLD_MINOR.badminton to 1");
      // and the tree's table naming nothing after a baseline at 2 is a minor that fell
      expect(epochViolations(unnamed({ badminton: 2 }, base), unnamed({}, base))[0]!.reason).toMatch(/FOLD_MINOR went down \(2 -> 0\)/);
    });

    it("two sports, one owing a minor and one a major: each is judged by its own pair, and a bump in the other sport settles neither", () => {
      const two = (b: [[number, number], [number, number]], a: [[number, number], [number, number]]): [Side, Side] => [
        { epochs: { badminton: b[0][0], tennis: b[1][0] }, minors: { badminton: b[0][1], tennis: b[1][1] }, corpora: { badminton: corpus([stream("std", 1)], "badminton"), tennis: corpus([stream("std", 1)], "tennis") } },
        { epochs: { badminton: a[0][0], tennis: a[1][0] }, minors: { badminton: a[0][1], tennis: a[1][1] }, corpora: { badminton: corpus([stream("std", 1, { deltas: "[1]" })], "badminton"), tennis: corpus([stream("std", 1, { outcome: "B" })], "tennis") } },
      ];
      const zero: [number, number] = [1, 0];
      expect(owes(epochViolations(...two([zero, zero], [zero, zero])))).toEqual([["badminton", "minor"], ["tennis", "major"]]);
      expect(epochViolations(...two([zero, zero], [[1, 1], [2, 0]]))).toEqual([]);
      // tennis (a phone-computed change) given only a minor, badminton given the right one: tennis alone is red
      expect(owes(epochViolations(...two([zero, zero], [[1, 1], [1, 1]])))).toEqual([["tennis", "major"]]);
      // badminton given a major instead of a minor is fine; tennis given nothing is red
      expect(owes(epochViolations(...two([zero, zero], [[2, 0], zero])))).toEqual([["tennis", "major"]]);
      // badminton's deltas moved and only TENNIS's minor bumped: badminton is still owed its own
      expect(owes(epochViolations(...two([zero, zero], [zero, [2, 1]])))).toEqual([["badminton", "minor"]]);
    });
  });

  describe("across sports", () => {
    const two = (b: [number, number], a: [number, number], aOutcomes: [string, string] = ["A", "A"]): [Side, Side] => [
      { epochs: { badminton: b[0], tennis: b[1] }, corpora: { badminton: corpus([stream("std", 1)], "badminton"), tennis: corpus([stream("std", 1)], "tennis") } },
      { epochs: { badminton: a[0], tennis: a[1] }, corpora: { badminton: corpus([stream("std", 1, { outcome: aOutcomes[0] })], "badminton"), tennis: corpus([stream("std", 1, { outcome: aOutcomes[1] })], "tennis") } },
    ];
    it("two sports changed, one bumped: red for the other only", () => {
      expect(sports(epochViolations(...two([1, 1], [2, 1], ["B", "B"])))).toEqual(["tennis"]);
      expect(sports(epochViolations(...two([1, 1], [1, 2], ["B", "B"])))).toEqual(["badminton"]);
    });
    it("two sports changed, both bumped: green; neither bumped: red for both", () => {
      expect(epochViolations(...two([1, 1], [2, 2], ["B", "B"]))).toEqual([]);
      expect(sports(epochViolations(...two([1, 1], [1, 1], ["B", "B"]))).sort()).toEqual(["badminton", "tennis"]);
    });
    it("one sport changed leaves the unchanged sport out of the violations", () => {
      expect(sports(epochViolations(...two([1, 1], [1, 1], ["B", "A"])))).toEqual(["badminton"]);
    });
    it("a sport that is new (no epoch and no corpus in the baseline) needs no bump, and the sports beside it are still judged", () => {
      const before: Side = { epochs: { badminton: 1 }, corpora: { badminton: corpus([stream("std", 1)]) } };
      const after: Side = { epochs: { badminton: 1, tennis: 1 }, corpora: { badminton: corpus([stream("std", 1)]), tennis: corpus([stream("std", 1), stream("std", 2)], "tennis") } };
      expect(epochViolations(before, after)).toEqual([]);
      const rows = compareSides(before, after);
      expect(rows.map((r) => [r.sport, r.matched, r.added])).toEqual([["badminton", 1, 0], ["tennis", 0, 2]]);
      const changed: Side = { ...after, corpora: { ...after.corpora, badminton: corpus([stream("std", 1, { outcome: "B" })]) } };
      expect(sports(epochViolations(before, changed))).toEqual(["badminton"]);
    });
    it("reports the sports alphabetically, whatever order the two sides list them in", () => {
      const b: Side = { epochs: { tennis: 1, badminton: 1 }, corpora: { tennis: corpus([stream("std", 1)], "tennis"), badminton: corpus([stream("std", 1)]) } };
      const a: Side = { epochs: { hockey: 1, tennis: 1, badminton: 1 }, corpora: { hockey: corpus([stream("std", 1)], "hockey"), tennis: corpus([stream("std", 1)], "tennis"), badminton: corpus([stream("std", 1)]) } };
      expect(compareSides(b, a).map((r) => r.sport)).toEqual(["badminton", "hockey", "tennis"]);
    });
    it("a sport named like an Object.prototype member is a new sport like any other, never a baseline it inherited", () => {
      for (const name of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
        const before: Side = { epochs: { badminton: 1 }, corpora: { badminton: corpus([stream("std", 1)]) } };
        const after: Side = { epochs: { badminton: 1, [name]: 1 }, corpora: { badminton: corpus([stream("std", 1)]), [name]: corpus([stream("std", 1)], name) } };
        // JSON.parse (what the CLI reads the corpora with) makes "__proto__" an own key; an object literal does not
        Object.defineProperty(after.epochs, name, { value: 1, enumerable: true });
        Object.defineProperty(after.corpora, name, { value: corpus([stream("std", 1)], name), enumerable: true });
        const row = compareSides(before, after).find((r) => r.sport === name);
        expect(row, name).toMatchObject({ baseline: false, before: null, after: 1, matched: 0, added: 1, reason: null });
        expect(epochViolations(before, after), name).toEqual([]);
      }
    });
    it("a sport has a baseline when the baseline holds its epoch OR its corpus, and has none only when it holds neither (the 'N sports checked' count)", () => {
      const now = side(1, [stream("std", 1)]);
      const epochOnly: Side = { epochs: { badminton: 1 }, corpora: {} };
      const corpusOnly: Side = { epochs: {}, corpora: { badminton: corpus([stream("std", 1)]) } };
      const neither: Side = { epochs: { tennis: 1 }, corpora: { tennis: corpus([stream("std", 1)], "tennis") } };
      const badminton = (before: Side) => compareSides(before, now).find((r) => r.sport === "badminton");
      expect(badminton(epochOnly)).toMatchObject({ baseline: true, before: 1, matched: 0 });
      expect(badminton(corpusOnly)).toMatchObject({ baseline: true, before: null, matched: 1 });
      expect(badminton(neither)).toMatchObject({ baseline: false, before: null, matched: 0, added: 1 });
    });
    it("a changed stream of a sport whose baseline has a corpus but no epoch entry has nothing to bump from: not a violation", () => {
      const before: Side = { epochs: {}, corpora: { badminton: corpus([stream("std", 1)]) } };
      expect(epochViolations(before, side(1, [stream("std", 1, { outcome: "B" })]))).toEqual([]);
    });
    it("a sport that vanished (epoch and corpus both gone) is a violation: retiring a sport is a decision, not a quiet deletion", () => {
      const before: Side = { epochs: { badminton: 1, tennis: 1 }, corpora: { badminton: corpus([stream("std", 1)]), tennis: corpus([stream("std", 1)], "tennis") } };
      const after: Side = { epochs: { badminton: 1 }, corpora: { badminton: corpus([stream("std", 1)]) } };
      const v = epochViolations(before, after);
      expect(sports(v)).toEqual(["tennis"]);
      expect(v[0]).toMatchObject({ removed: 1, before: 1, after: null });
      expect(v[0]!.reason).toMatch(/gone/);
      expect(v[0]!.reason, "a vanished sport is not also told its epoch 'did not rise (1 -> undefined)'").not.toMatch(/did not rise|undefined/);
    });
    it("a corpus with no epoch entry is a violation, and so is an epoch entry with no corpus (nothing would ever compare it)", () => {
      const noEpoch: Side = { epochs: {}, corpora: { badminton: corpus([stream("std", 1)]) } };
      expect(epochViolations(side(1, [stream("std", 1)]), noEpoch)[0]!.reason).toMatch(/golden corpus but no FOLD_EPOCH entry/);
      const noCorpus: Side = { epochs: { badminton: 1 }, corpora: {} };
      expect(epochViolations(null, noCorpus)).toEqual([]);
      const base: Side = { epochs: { tennis: 1 }, corpora: { tennis: corpus([stream("std", 1)], "tennis") } };
      expect(epochViolations(base, { epochs: { tennis: 1, badminton: 1 }, corpora: { tennis: corpus([stream("std", 1)], "tennis") } }).map((v) => v.reason)).toEqual([expect.stringMatching(/FOLD_EPOCH entry but no golden corpus/)]);
    });
  });
});

describe("fold-epoch guard: over every registered sport's real golden corpus", () => {
  // The corpora are read once; each sweep below works on copies. The sport list is the registry's.
  const real = new Map<string, GoldenCorpus>();
  beforeAll(() => { forEachSport(({ key }) => { real.set(key, readCorpus(key)); }); }, treeBudget(builtinModules.length));
  const sideOf = (c: Map<string, GoldenCorpus>, epoch = 1): Side => ({ epochs: Object.fromEntries([...c.keys()].map((k) => [k, epoch])), corpora: Object.fromEntries(c) });
  // The per-sport sweeps judge one sport at a time (the whole tree against itself is the test after them): a side holding only `key`.
  const only = (key: string, c: GoldenCorpus, epoch = 1): Side => ({ epochs: { [key]: epoch }, corpora: { [key]: c } });
  const withFirst = (c: GoldenCorpus, over: Partial<GoldenStream>): GoldenCorpus => ({ ...c, streams: [{ ...c.streams[0]!, ...over }, ...c.streams.slice(1)] });
  // Each sweep derives the budget from the sports it walks (AGENTS class 20): the cost is one comparison of one corpus per step.
  const budget = (steps: number) => treeBudget(builtinModules.length, steps);

  it("has one corpus per registered sport and one unique config#seed per stream (counted)", () => {
    expect(real.size).toBe(builtinModules.length);
    let streams = 0;
    const swept = forEachSport(({ key }) => {
      const c = real.get(key)!;
      expect(new Set(c.streams.map((s) => `${s.config}#${s.seed}`)).size, `${key}: config#seed is not unique`).toBe(c.streams.length);
      streams += c.streams.length;
    });
    expect(swept).toBe(builtinModules.length);
    expect(streams).toBeGreaterThanOrEqual(swept);
  });

  it("compares the tree with itself: every stream of every sport matches, nothing changed, nothing to bump", () => {
    const rows = compareSides(sideOf(real), sideOf(real));
    expect(rows.map((r) => r.sport).sort()).toEqual([...real.keys()].sort());
    for (const r of rows) expect(r, r.sport).toMatchObject({ matched: real.get(r.sport)!.streams.length, changed: 0, removed: 0, added: 0, reason: null });
    expect(epochViolations(sideOf(real), sideOf(real))).toEqual([]);
    expect(rows.reduce((n, r) => n + r.matched, 0)).toBeGreaterThan(0);
  }, budget(3));

  const FIELDS = ["states", "outcome", "summary", "deltas"] as const;
  it("names exactly the sport whose fold moved, whichever of the four recorded results moved, and is satisfied by that sport's bump alone", () => {
    let checked = 0;
    forEachSport(({ key }) => {
      const c = real.get(key)!;
      for (const field of FIELDS) {
        const first = c.streams[0]!;
        const moved = withFirst(c, field === "states" ? { states: [...first.states.slice(0, -1), `${first.states.at(-1) ?? ""} `] } : { [field]: `${first[field]} ` });
        const v = epochViolations(only(key, c), only(key, moved));
        expect(v.map((x) => x.sport), `${key}: ${field} moved`).toEqual([key]);
        // a phone computes states, outcome and summary; only the server computes the standings deltas
        expect(v[0], `${key}: ${field} moved`).toMatchObject({ matched: c.streams.length, changed: field === "deltas" ? 0 : 1, deltasOnly: field === "deltas" ? 1 : 0, removed: 0, added: 0, owes: field === "deltas" ? "minor" : "major" });
        expect(epochViolations(only(key, c), only(key, moved, 2)), `${key}: ${field} moved and bumped`).toEqual([]);
        checked++;
      }
    });
    expect(checked).toBe(builtinModules.length * FIELDS.length);
  }, budget(FIELDS.length * 2));

  // GOLDEN-POLICY.md, "Re-recording a floor-batch stream in place": a floor stream whose recorded EVENT is rewritten, same
  // `config#seed`, same index, is counted removed AND added, so it owes the major whatever else is true. The doc says so; this is the guard saying it.
  it("a floor stream re-recorded in place (the GOLDEN-POLICY.md mode) is removed AND added, owes the major, and is settled by that sport's bump alone, for every sport", () => {
    let checked = 0;
    forEachSport(({ key }) => {
      const c = real.get(key)!;
      const batches = floorBatches(c);
      expect(batches.length, `${key}: a floor batch to re-record in`).toBeGreaterThan(0);
      const index = batches[0]!.start;
      const target = c.streams[index]!;
      expect(isFloorStream(target), `${key}: stream ${index} is a floor stream`).toBe(true);
      const recorded: GoldenStream = { ...target, events: target.events.map((e, i) => (i === 0 ? { ...e, payload: { rewritten: true, was: e.payload } } : e)) };
      const moved: GoldenCorpus = { ...c, streams: c.streams.map((s, i) => (i === index ? recorded : s)) };
      const identity = (s: GoldenStream) => `${s.config}#${s.seed}`;
      expect(moved.streams.map(identity), `${key}: in place, nothing renamed or shifted`).toEqual(c.streams.map(identity));
      const v = epochViolations(only(key, c), only(key, moved));
      expect(v, key).toHaveLength(1);
      expect(v[0], `${key}: ${identity(target)} re-recorded`).toMatchObject({ sport: key, matched: c.streams.length - 1, changed: 0, removed: 1, added: 1, owes: "major" });
      expect(epochViolations(only(key, c), only(key, moved, 2)), `${key}: re-recorded and bumped`).toEqual([]);
      checked++;
    });
    expect(checked).toBe(builtinModules.length);
  }, budget(2));

  // A side holding only `key`, with a FOLD_MINOR of its own: the pair (major, minor) is what the real-corpus sweeps below move.
  const pair = (key: string, c: GoldenCorpus, major: number, minor: number): Side => ({ epochs: { [key]: major }, minors: { [key]: minor }, corpora: { [key]: c } });
  it("for every sport and each recorded result: a minor bump alone settles a deltas-only move and NEVER a move a phone computes; a major bump settles both", () => {
    let checked = 0;
    forEachSport(({ key }) => {
      const c = real.get(key)!;
      const first = c.streams[0]!;
      for (const field of FIELDS) {
        const moved = withFirst(c, field === "states" ? { states: [...first.states.slice(0, -1), `${first.states.at(-1) ?? ""} `] } : { [field]: `${first[field]} ` });
        const minorOnly = epochViolations(pair(key, c, 1, 0), pair(key, moved, 1, 1));
        const majorOnly = epochViolations(pair(key, c, 1, 0), pair(key, moved, 2, 0));
        const majorAndReset = epochViolations(pair(key, c, 3, 5), pair(key, moved, 4, 0));
        expect(majorOnly, `${key}: ${field} moved, major bumped`).toEqual([]);
        expect(majorAndReset, `${key}: ${field} moved, major bumped and minor reset`).toEqual([]);
        if (field === "deltas") {
          expect(minorOnly, `${key}: only deltas moved, minor bumped`).toEqual([]);
        } else {
          expect(minorOnly.map((x) => [x.sport, x.owes]), `${key}: ${field} moved, only the minor bumped`).toEqual([[key, "major"]]);
          expect(minorOnly[0]!.reason, key).toContain(`raise FOLD_EPOCH.${key} to 2 in src/sport/fold-epoch.ts`);
        }
        const unbumped = epochViolations(pair(key, c, 1, 0), pair(key, moved, 1, 0));
        expect(unbumped.map((x) => [x.sport, x.owes]), `${key}: ${field} moved, nothing bumped`).toEqual([[key, field === "deltas" ? "minor" : "major"]]);
        checked++;
      }
    });
    expect(checked).toBe(builtinModules.length * FIELDS.length);
  }, budget(FIELDS.length * 4));

  it("names the sport whose recorded config changed, though not one event or result did, and is satisfied by that sport's bump alone", () => {
    let checked = 0;
    forEachSport(({ key }) => {
      const c = real.get(key)!;
      const name = c.streams[0]!.config;
      const used = c.streams.filter((s) => s.config === name).length;
      const edited: GoldenCorpus = { ...c, configs: { ...c.configs, [name]: { ...(c.configs[name] as object), launderedDefault: 30 } } };
      const v = epochViolations(only(key, c), only(key, edited));
      expect(v.map((x) => x.sport), `${key}: config "${name}" changed`).toEqual([key]);
      expect(v[0], key).toMatchObject({ matched: c.streams.length - used, changed: 0, removed: used, added: used });
      expect(epochViolations(only(key, c), only(key, edited, 2)), `${key}: config changed and bumped`).toEqual([]);
      checked++;
    });
    expect(checked).toBe(builtinModules.length);
  }, budget(2));

  it("names the sport whose stream was removed, and does not name it for an added stream", () => {
    let checked = 0;
    forEachSport(({ key }) => {
      const c = real.get(key)!;
      const removed = epochViolations(only(key, c), only(key, { ...c, streams: c.streams.slice(0, -1) }));
      expect(removed.map((x) => x.sport), `${key}: stream removed`).toEqual([key]);
      expect(removed[0], key).toMatchObject({ matched: c.streams.length - 1, changed: 0, removed: 1, added: 0 });
      const extended = epochViolations(only(key, c), only(key, { ...c, streams: [...c.streams, { ...c.streams[0]!, seed: 987654321 }] }));
      expect(extended, `${key}: stream added`).toEqual([]);
      checked++;
    });
    expect(checked).toBe(builtinModules.length);
  }, budget(2));
});

// ------------------------------------------------------------------------------------------------------------------------------------
// GF-2 T2: the corpus's second format. A format-2 stream also records the kernel's per-step summary digests and its overlay (the
// stoppage, the squads, a settlement, the effective outcome...): what a phone computes from the kernel, not from the module. The
// fold-affecting rule is the owner's (Q1, 2026-10-15), and the table of paths below is the ruling's own list, typed from it.

/** A stream recording the format-2 fields, with digests that differ per step so a single moved digest can be told from a moved length. */
const recorded = (s: GoldenStream, over: Partial<GoldenStream> = {}): GoldenStream =>
  ({ ...s, summaries: s.events.map((_, i) => `#d${i}`), overlay: "{}", ...over });
const fmt2 = (streams: GoldenStream[], key = "badminton"): GoldenCorpus => ({ ...corpus(streams, key), format: 2 });
const side2 = (epoch: number, streams: GoldenStream[]): Side => ({ epochs: { badminton: epoch }, corpora: { badminton: fmt2(streams) } });
/** The fold-affecting changed paths a CLI would hand the guard; `[]` is a change that touches no fold source. */
const frozen = () => [] as string[];
const KERNEL = "src/core/events.ts";

describe("fold-epoch guard: GF-2 - the kernel-overlay fields are phone outputs", () => {
  const base = (): GoldenStream[] => [stream("std", 1, { events: [{ seq: 1 }, { seq: 2 }] as never, states: ["s1", "s2"] }), stream("std", 2)];
  const rec = (over: Partial<GoldenStream> = {}, at = 0): GoldenStream[] => base().map((s, i) => (i === at ? recorded(s, over) : recorded(s)));

  it("a moved per-step summary digest, with every state, outcome and summary the same, is a MAJOR owed (and a minor does not stand in for it)", () => {
    const v = epochViolations(side2(1, rec()), side2(1, rec({ summaries: ["#d0", "#MOVED"] })));
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ sport: "badminton", matched: 2, changed: 1, deltasOnly: 0, recorded: 0, owes: "major" });
    expect(epochViolations(side2(1, rec()), side2(2, rec({ summaries: ["#d0", "#MOVED"] })))).toEqual([]);
    const minorOnly = (m: number, streams: GoldenStream[]): Side => ({ epochs: { badminton: 1 }, minors: { badminton: m }, corpora: { badminton: fmt2(streams) } });
    expect(epochViolations(minorOnly(0, rec()), minorOnly(1, rec({ summaries: ["#d0", "#MOVED"] }))).map((x) => x.owes)).toEqual(["major"]);
  });
  it("a summary list with another LENGTH is a move too, though every entry the two share is equal", () => {
    expect(epochViolations(side2(1, rec()), side2(1, rec({ summaries: ["#d0"] }))).map((x) => x.sport)).toEqual(["badminton"]);
    expect(epochViolations(side2(1, rec()), side2(1, rec({ summaries: ["#d0", "#d1", "#d2"] }))).map((x) => x.sport)).toEqual(["badminton"]);
  });
  it("a moved overlay is a MAJOR owed, whether one change point or the whole column moved", () => {
    for (const overlay of ['{"stoppage":[[0,"x"]]}', '{"squads":[[1,"#s"]]}', '{ }']) {
      const v = epochViolations(side2(1, rec()), side2(1, rec({ overlay })));
      expect(v.map((x) => [x.sport, x.owes, x.changed]), overlay).toEqual([["badminton", "major", 1]]);
      expect(epochViolations(side2(1, rec()), side2(2, rec({ overlay }))), `${overlay} bumped`).toEqual([]);
    }
  });
  it("equal summaries and an equal overlay are not a move (the control: the cases above are not red for another reason)", () => {
    expect(epochViolations(side2(1, rec()), side2(1, rec()))).toEqual([]);
    const [row] = compareSides(side2(1, rec()), side2(1, rec()));
    expect(row).toMatchObject({ matched: 2, changed: 0, recorded: 0, owes: null, reason: null });
  });

  describe("a stream that gains the fields for the first time (baseline format 1 -> format 2)", () => {
    const before = (): Side => side(1, base());
    const after = (over: Partial<GoldenStream> = {}, epoch = 1): Side => side2(epoch, rec(over));
    it("owes NOTHING when the change touches no fold source, and the row counts it as recorded (not changed, not added)", () => {
      expect(epochViolations(before(), after(), frozen)).toEqual([]);
      const [row] = compareSides(before(), after(), frozen);
      expect(row).toMatchObject({ matched: 2, changed: 0, deltasOnly: 0, removed: 0, added: 0, recorded: 2, owes: null, reason: null });
    });
    it("owes a MAJOR when the same change touches fold source, naming the paths and the way out", () => {
      const v = epochViolations(before(), after(), () => [KERNEL]);
      expect(v).toHaveLength(1);
      expect(v[0]).toMatchObject({ sport: "badminton", matched: 2, changed: 2, recorded: 2, owes: "major" });
      expect(v[0]!.reason).toContain("2 newly recorded stream(s)");
      expect(v[0]!.reason).toContain(KERNEL);
      expect(v[0]!.reason).toMatch(/land the format bump alone/);
      expect(v[0]!.reason).toContain("raise FOLD_EPOCH.badminton to 2 in src/sport/fold-epoch.ts");
      expect(epochViolations(before(), after({}, 2), () => [KERNEL]), "with the bump").toEqual([]);
    });
    it("lists at most a few of the touched paths, and says how many more", () => {
      const many = Array.from({ length: 9 }, (_, i) => `src/core/f${i}.ts`);
      const v = epochViolations(before(), after(), () => many);
      expect(v[0]!.reason).toContain("src/core/f0.ts");
      expect(v[0]!.reason).toMatch(/and 6 more/);
      expect(v[0]!.reason).not.toContain("src/core/f8.ts");
    });
    it("FAILS CLOSED when it is not told what changed: no change list is a touched fold source, never a frozen one", () => {
      const v = epochViolations(before(), after());
      expect(v.map((x) => [x.sport, x.owes, x.recorded])).toEqual([["badminton", "major", 2]]);
      expect(v[0]!.reason).toMatch(/no list of changed files/);
    });
    it("a minor bump does not settle it either: a phone computes this", () => {
      const m = (n: number, streams: GoldenStream[], f2: boolean): Side => ({ epochs: { badminton: 1 }, minors: { badminton: n }, corpora: { badminton: f2 ? fmt2(streams) : corpus(streams) } });
      expect(epochViolations(m(0, base(), false), m(1, rec(), true), () => [KERNEL]).map((x) => x.owes)).toEqual(["major"]);
    });
    it("a pre-existing field that ALSO moved is a change whatever the source did (Q6: a harness rewrite of an existing field is a major)", () => {
      for (const over of [{ outcome: "B" }, { summary: '{"x":1}' }, { states: ["s1-new", "s2"] }] as Partial<GoldenStream>[]) {
        const v = epochViolations(before(), after(over), frozen);
        expect(v.map((x) => [x.sport, x.owes, x.changed, x.recorded]), JSON.stringify(over)).toEqual([["badminton", "major", 1, 2]]);
      }
      // a deltas-only move beside the new fields stays the minor it always was, and the frozen source does not hide it
      const deltas = epochViolations(before(), after({ deltas: "[1]" }), frozen);
      expect(deltas.map((x) => [x.owes, x.deltasOnly, x.changed, x.recorded])).toEqual([["minor", 1, 0, 2]]);
    });
    it("a HALF-recorded stream (one of the two fields) is not recorded: the parser refuses it, and this function must not read it as gaining the fields", () => {
      const half = (over: Partial<GoldenStream>): Side => side(1, base().map((s) => ({ ...s, ...over })));
      for (const over of [{ summaries: ["#d0", "#d1"] }, { overlay: "{}" }] as Partial<GoldenStream>[]) {
        const [row] = compareSides(before(), half(over), () => [KERNEL]);
        expect(row, JSON.stringify(over)).toMatchObject({ recorded: 0, changed: 0, owes: null, reason: null });
      }
    });
    it("a stream re-recorded in the same change (events differ) is removed and added, never 'recorded'", () => {
      const v = epochViolations(before(), side2(1, [recorded(base()[0]!, { events: [{ seq: 9 }] as never }), recorded(base()[1]!)]), frozen);
      expect(v[0]).toMatchObject({ matched: 1, recorded: 1, removed: 1, added: 1, owes: "major" });
    });
    it("a stream ADDED already in format 2 owes nothing and is not counted as recorded (EXTEND_GOLDEN)", () => {
      const v = compareSides(side2(1, rec()), side2(1, [...rec(), recorded(stream("std", 3))]), frozen);
      expect(v[0]).toMatchObject({ matched: 2, added: 1, recorded: 0, reason: null });
    });
    it("a sport with no baseline is new: nothing to compare, nothing recorded", () => {
      expect(compareSides(null, after(), frozen)).toEqual([]);
    });
  });

  describe("the format never falls: a corpus that stops recording the kernel fields is a violation", () => {
    it("is red whatever else is bumped, because a bump does not restore a pin that was dropped", () => {
      for (const epoch of [1, 2, 9]) {
        const v = epochViolations(side2(1, rec()), side(epoch, base()), frozen);
        expect(v.map((x) => x.sport), `epoch 1 -> ${epoch}`).toEqual(["badminton"]);
        expect(v[0]!.reason, `epoch 1 -> ${epoch}`).toMatch(/format fell.*2 -> 1.*2 stream\(s\)/);
      }
    });
    it("names it even when nothing else moved, and counts the streams", () => {
      const [row] = compareSides(side2(1, rec()), side(1, base()), frozen);
      expect(row).toMatchObject({ matched: 2, changed: 0, recorded: 0 });
      expect(row!.reason).not.toBeNull();
    });
    it("a format-2 corpus kept as it is, or format 1 kept as it is, is not a fall", () => {
      expect(epochViolations(side2(1, rec()), side2(1, rec()), frozen)).toEqual([]);
      expect(epochViolations(side(1, base()), side(1, base()), frozen)).toEqual([]);
    });
  });
});

describe("fold-epoch guard: GF-2 - which changed paths touch fold source (the owner's Q1 list)", () => {
  const MONO = "packages/engine/";
  // [repo-relative path, touches fold source]. Typed from the ruling: nothing in the engine's src/ outside src/testkit/**,
  // *.test.ts, *.golden.json, *.schema.json and *.md; the engine's package.json; the root lockfile.
  const IN_ENGINE: ReadonlyArray<readonly [string, boolean]> = [
    ["src/core/events.ts", true],
    ["src/core/lineup.ts", true],
    ["src/sports/football/football.ts", true],
    ["src/sports/setbased/badminton.ts", true],
    ["src/sport/fold-epoch.ts", true], // the epoch table is source too: a bump there is a deliberate fold change
    ["src/sport/module.ts", true],
    ["src/index.ts", true],
    ["src/testkit/golden.ts", false],
    ["src/testkit/golden-floor.ts", false],
    ["src/testkit/GOLDEN-POLICY.md", false],
    ["src/testkit/deep/nested/helper.ts", false],
    ["src/core/events.test.ts", false],
    ["src/sports/football/football.time.test.ts", false],
    ["src/sports/setbased/badminton.golden.json", false],
    ["src/sports/football/football.schema.json", false],
    ["src/core/README.md", false],
    ["package.json", true],
    ["scripts/fold-epoch-guard.ts", false], // outside src/: the ruling does not list it
    ["test/fold-epoch-guard.test.ts", false],
    ["rules/rows.ts", false],
    ["tsconfig.json", false],
    ["src/core/events.ts.md", false], // a .md suffix is a doc whatever precedes it
    ["src/core/events.golden.json.ts", true], // ... and a suffix elsewhere in the name is not an exemption
    ["src/core/events.test.ts.ts", true], // ... for .test.ts either
    ["src/core/x.schema.json.ts", true], // ... or .schema.json
    ["src/core/events.md.ts", true], // ... or .md
    ["src/testkit-x/a.ts", true], // a directory that merely starts with "testkit" is not src/testkit/
    ["pack-proof/src/x.ts", false], // a src/ that is not the engine's src/: only a path that STARTS with src/ is fold source
    ["src/core/testkit/x.ts", true], // only src/testkit/ itself is exempt
  ];
  const ELSEWHERE: ReadonlyArray<readonly [string, boolean]> = [
    ["pnpm-lock.yaml", true], // the root lockfile
    ["package.json", false], // the ROOT package.json is not the engine's
    ["apps/web/src/server/x.ts", false],
    ["packages/scheduler/src/core.ts", false],
    ["packages/engine-other/src/core/events.ts", false], // a sibling directory that merely starts with "engine"
    ["packages/engine/../scheduler/pnpm-lock.yaml", false],
    ["packages/engine-src/core/events.ts", false], // 16 characters in, this path reads "src/core/events.ts": only the prefix check keeps it out
    ["apps/web/pnpm-lock.yaml", false], // a lockfile that is not the root's
    ["docs/superpowers/specs/engine-split/gf2-kernel-overlay-design.md", false],
  ];

  it("in the monorepo (engine at packages/engine/): every path is judged by the ruling's list", () => {
    let touched = 0;
    let free = 0;
    for (const [rel, fold] of IN_ENGINE) {
      expect(foldSourceTouched([`${MONO}${rel}`], MONO), rel).toEqual(fold ? [`${MONO}${rel}`] : []);
      if (fold) touched++;
      else free++;
    }
    for (const [path, fold] of ELSEWHERE) {
      expect(foldSourceTouched([path], MONO), path).toEqual(fold ? [path] : []);
      if (fold) touched++;
      else free++;
    }
    expect(touched).toBeGreaterThan(8);
    expect(free).toBeGreaterThan(14);
  });
  it("with the engine at a repository root (engine-split 2b): the same list, with no prefix, and the lockfile beside package.json", () => {
    for (const [rel, fold] of IN_ENGINE) expect(foldSourceTouched([rel], ""), rel).toEqual(fold ? [rel] : []);
    expect(foldSourceTouched(["pnpm-lock.yaml"], "")).toEqual(["pnpm-lock.yaml"]);
    expect(foldSourceTouched(["apps/web/x.ts", "docs/a.md"], "")).toEqual([]);
  });
  it("a change list is filtered, keeping the order and every offender, and an empty list touches nothing", () => {
    const changed = [`${MONO}src/testkit/golden.ts`, `${MONO}src/core/b.ts`, "README.md", `${MONO}src/core/a.ts`, "pnpm-lock.yaml"];
    expect(foldSourceTouched(changed, MONO)).toEqual([`${MONO}src/core/b.ts`, `${MONO}src/core/a.ts`, "pnpm-lock.yaml"]);
    expect(foldSourceTouched([], MONO)).toEqual([]);
  });
});

describe("fold-epoch guard: GF-2 - over every registered sport's real golden corpus", () => {
  const real = new Map<string, GoldenCorpus>();
  beforeAll(() => { forEachSport(({ key }) => { real.set(key, readCorpus(key)); }); }, treeBudget(builtinModules.length));
  const only = (key: string, c: GoldenCorpus, epoch = 1): Side => ({ epochs: { [key]: epoch }, corpora: { [key]: c } });
  /** The corpus as format 1 (whatever the tree holds), and as format 2 with placeholder digests: the guard compares strings and lengths. */
  const asFormat1 = (c: GoldenCorpus): GoldenCorpus => {
    const { format: _format, ...rest } = c;
    return { ...rest, streams: c.streams.map(({ summaries: _s, overlay: _o, playerStats: _p, ...plain }) => plain) };
  };
  const asFormat2 = (c: GoldenCorpus): GoldenCorpus => ({ ...asFormat1(c), format: 2, streams: asFormat1(c).streams.map((s) => recorded(s)) });
  const budget = (steps: number) => treeBudget(builtinModules.length, steps);

  it("a reformat that touches no fold source owes nothing in any sport, and records every stream it compared (counted)", () => {
    let sports = 0;
    let streams = 0;
    forEachSport(({ key }) => {
      const c = real.get(key)!;
      const [row] = compareSides(only(key, asFormat1(c)), only(key, asFormat2(c)), frozen);
      expect(row, key).toMatchObject({ matched: c.streams.length, changed: 0, removed: 0, added: 0, recorded: c.streams.length, owes: null, reason: null });
      expect(epochViolations(only(key, asFormat1(c)), only(key, asFormat2(c)), frozen), key).toEqual([]);
      sports++;
      streams += c.streams.length;
    });
    expect(sports).toBe(builtinModules.length);
    expect(streams).toBeGreaterThanOrEqual(sports);
  }, budget(4));

  it("the same reformat with ANY fold-source path owes a major in every sport, and that sport's bump alone settles it", () => {
    let checked = 0;
    forEachSport(({ key }) => {
      const c = real.get(key)!;
      for (const path of [KERNEL, `src/sports/${key}/${key}.ts`, "package.json"]) {
        const v = epochViolations(only(key, asFormat1(c)), only(key, asFormat2(c)), () => [path]);
        expect(v.map((x) => [x.sport, x.owes, x.changed, x.recorded]), `${key}: ${path}`).toEqual([[key, "major", c.streams.length, c.streams.length]]);
        expect(epochViolations(only(key, asFormat1(c)), only(key, asFormat2(c), 2), () => [path]), `${key}: ${path} bumped`).toEqual([]);
        checked++;
      }
    });
    expect(checked).toBe(builtinModules.length * 3);
  }, budget(6));

  const NEW_FIELDS = ["summaries (an entry)", "summaries (the length)", "overlay"] as const;
  it("on a format-2 base, a move in either new field names exactly that sport and owes a MAJOR, whichever sport it is (the sweep that teeth tests rely on)", () => {
    let checked = 0;
    forEachSport(({ key }) => {
      const c = asFormat2(real.get(key)!);
      const first = c.streams[0]!;
      for (const field of NEW_FIELDS) {
        const over: Partial<GoldenStream> =
          field === "overlay" ? { overlay: '{"stoppage":[[0,"x"]]}' }
          : field === "summaries (the length)" ? { summaries: first.summaries!.slice(0, -1) }
          : { summaries: [...first.summaries!.slice(0, -1), "#moved"] };
        const moved: GoldenCorpus = { ...c, streams: [{ ...first, ...over }, ...c.streams.slice(1)] };
        const v = epochViolations(only(key, c), only(key, moved), frozen);
        expect(v.map((x) => [x.sport, x.owes, x.changed, x.recorded]), `${key}: ${field}`).toEqual([[key, "major", 1, 0]]);
        expect(epochViolations(only(key, c), only(key, moved, 2), frozen), `${key}: ${field} bumped`).toEqual([]);
        checked++;
      }
    });
    expect(checked).toBe(builtinModules.length * NEW_FIELDS.length);
  }, budget(NEW_FIELDS.length * 2));

  it("the format falling is a violation in every sport, bumped or not", () => {
    let checked = 0;
    forEachSport(({ key }) => {
      const c = real.get(key)!;
      for (const epoch of [1, 2]) {
        const v = epochViolations(only(key, asFormat2(c)), only(key, asFormat1(c), epoch), frozen);
        expect(v.map((x) => x.sport), `${key}: epoch 1 -> ${epoch}`).toEqual([key]);
        expect(v[0]!.reason).toMatch(/format fell/);
        checked++;
      }
    });
    expect(checked).toBe(builtinModules.length * 2);
  }, budget(4));

  it("the fall is a fact about the CORPUS: format 1 with EVERY stream re-recorded (nothing matches) is a violation in every sport, whatever the bump", () => {
    // New seeds: no baseline identity survives, so a count of "matched streams that lost the fields" is zero and the major the re-record
    // owes is paid by the bump. Only the corpus-level clause sees the dropped summaries and overlay.
    const rerecorded = (corpus: GoldenCorpus): GoldenCorpus => ({ ...corpus, streams: corpus.streams.map((s) => ({ ...s, seed: s.seed + 1_000_003 })) });
    let checked = 0;
    let lost = 0;
    forEachSport(({ key }) => {
      const c = real.get(key)!;
      for (const epoch of [1, 2]) {
        const [row] = compareSides(only(key, asFormat2(c)), only(key, rerecorded(asFormat1(c)), epoch), frozen);
        expect(row, `${key}: precondition - nothing matched, so only the corpus-level clause can see the fall`).toMatchObject({ matched: 0, removed: c.streams.length, added: c.streams.length });
        const v = epochViolations(only(key, asFormat2(c)), only(key, rerecorded(asFormat1(c)), epoch), frozen);
        expect(v.map((x) => x.sport), `${key}: epoch 1 -> ${epoch}`).toEqual([key]);
        expect(v[0]!.reason, `${key}: epoch 1 -> ${epoch}`).toContain(`corpus format fell (2 -> 1): ${c.streams.length} stream(s) recorded their summaries and overlay`);
        lost += c.streams.length;
        checked++;
      }
      // the control: the same re-record that stays format 2 is settled by the bump, so the violation above IS the format
      expect(epochViolations(only(key, asFormat2(c)), only(key, rerecorded(asFormat2(c)), 2), frozen), `${key}: control`).toEqual([]);
    });
    expect(checked).toBe(builtinModules.length * 2);
    expect(lost).toBeGreaterThan(0);
  }, budget(5));

  it("a sport that has no corpus on the current side is not also called a format fall (its own reason says it)", () => {
    const c = asFormat2(real.get("badminton")!);
    const v = epochViolations({ epochs: { badminton: 1 }, corpora: { badminton: c } }, { epochs: { badminton: 1 }, corpora: {} }, frozen);
    expect(v.map((x) => x.reason)).toEqual([expect.stringContaining("no golden corpus")]);
    expect(v[0]!.reason).not.toContain("format fell");
  });
});

// ------------------------------------------------------------------------------------------------------------------------------------
// GF-2 T4: the corpus's third format. A format-3 stream also records `playerStats`, the final rows of the server's stats fold. A phone never
// computes them (the S2 contract), so a move in them is the MINOR (owner ruling Q2, 2026-10-15), and a stream that gains them follows the
// Q1 rule with the SAME classifier (`foldSourceTouched`, passed in as the change list; there is no second one).

/** A stream recording the format-3 fields (the kernel's and the stats), per-step digests differing so a moved one is tellable. */
const stats3 = (s: GoldenStream, over: Partial<GoldenStream> = {}): GoldenStream =>
  ({ ...recorded(s), playerStats: JSON.stringify([{ personId: "p", stats: { goals: s.events.length } }]), ...over });
const fmt3 = (streams: GoldenStream[], key = "badminton"): GoldenCorpus => ({ ...corpus(streams, key), format: 3 });
/** A side holding badminton at (major, minor) with the given corpus. */
const at3 = (major: number, minor: number, c: GoldenCorpus): Side => ({ epochs: { badminton: major }, minors: { badminton: minor }, corpora: { badminton: c } });

describe("fold-epoch guard: GF-2 T4 - player stats are a minor", () => {
  const base = (): GoldenStream[] => [stream("std", 1, { events: [{ seq: 1 }, { seq: 2 }] as never, states: ["s1", "s2"] }), stream("std", 2)];
  const rec3 = (over: Partial<GoldenStream> = {}, at = 0): GoldenStream[] => base().map((s, i) => (i === at ? stats3(s, over) : stats3(s)));
  const MOVED = JSON.stringify([{ personId: "p", stats: { goals: 99 } }]);
  const owes = (v: ReturnType<typeof epochViolations>) => v.map((x) => [x.sport, x.owes]);

  describe("a stream whose player stats moved while every phone output stayed (both sides format 3)", () => {
    it("owes a MINOR: red unbumped, counted as stats-only and not as a changed fold, the reason names FOLD_MINOR and the number", () => {
      const v = epochViolations(at3(1, 0, fmt3(rec3())), at3(1, 0, fmt3(rec3({ playerStats: MOVED }))), frozen);
      expect(v).toHaveLength(1);
      expect(v[0]).toMatchObject({ sport: "badminton", matched: 2, changed: 0, deltasOnly: 0, statsOnly: 1, removed: 0, added: 0, recorded: 0, owes: "minor" });
      expect(v[0]!.reason).toMatch(/^minor owed, only the server computes this: 1 stream\(s\) differ in their player stats/);
      expect(v[0]!.reason).toContain("raise FOLD_MINOR.badminton to 1 in src/sport/fold-epoch.ts");
      expect(v[0]!.reason).not.toMatch(/standings deltas/);
    });
    it("a minor bump settles it, so does a major bump, and an unrelated bump of nothing does not", () => {
      const was = at3(1, 0, fmt3(rec3()));
      const moved = fmt3(rec3({ playerStats: MOVED }));
      expect(epochViolations(was, at3(1, 1, moved), frozen), "minor 0 -> 1").toEqual([]);
      expect(epochViolations(was, at3(2, 0, moved), frozen), "major 1 -> 2").toEqual([]);
      expect(epochViolations(was, at3(1, 0, moved), frozen).map((x) => x.owes), "no bump").toEqual(["minor"]);
      expect(epochViolations(at3(1, 2, fmt3(rec3())), at3(1, 2, moved), frozen).map((x) => x.reason), "minor held at 2").toEqual([expect.stringContaining("raise FOLD_MINOR.badminton to 3")]);
    });
    it("equal stats are not a move (the control: the cases above are not red for another reason)", () => {
      const [row] = compareSides(at3(1, 0, fmt3(rec3())), at3(1, 0, fmt3(rec3())), frozen);
      expect(row).toMatchObject({ matched: 2, changed: 0, deltasOnly: 0, statsOnly: 0, recorded: 0, owes: null, reason: null });
    });
    it("text that differs only in key order is a move (the record is the canonical text, byte for byte)", () => {
      const a = '[{"personId":"p","stats":{"a":1,"b":2}}]';
      const b = '[{"personId":"p","stats":{"b":2,"a":1}}]';
      expect(epochViolations(at3(1, 0, fmt3(rec3({ playerStats: a }))), at3(1, 0, fmt3(rec3({ playerStats: b }))), frozen).map((x) => x.owes)).toEqual(["minor"]);
    });
    it("a minor bump does NOT settle a move a phone computes, stats beside it or not: the strongest class decides", () => {
      for (const [name, over] of [["state", { states: ["s1-new", "s2"] }], ["outcome", { outcome: "B" }], ["summary", { summary: '{"x":1}' }], ["summaries", { summaries: ["#d0", "#MOVED"] }], ["overlay", { overlay: '{"stoppage":[[0,"x"]]}' }]] as [string, Partial<GoldenStream>][]) {
        for (const withStats of [false, true]) {
          const next = fmt3(rec3(withStats ? { ...over, playerStats: MOVED } : over));
          const v = epochViolations(at3(1, 0, fmt3(rec3())), at3(1, 1, next), frozen);
          expect(owes(v), `${name} (stats beside it: ${withStats})`).toEqual([["badminton", "major"]]);
          expect(v[0], `${name} (stats beside it: ${withStats})`).toMatchObject({ changed: 1, statsOnly: 0 });
          expect(epochViolations(at3(1, 0, fmt3(rec3())), at3(2, 0, next), frozen), `${name} bumped`).toEqual([]);
        }
      }
    });
    it("a stream that moved its stats AND its standings deltas counts in both columns, and the reason names both", () => {
      const v = epochViolations(at3(1, 0, fmt3(rec3())), at3(1, 0, fmt3(rec3({ playerStats: MOVED, deltas: "[1]" }))), frozen);
      expect(v[0]).toMatchObject({ changed: 0, deltasOnly: 1, statsOnly: 1, owes: "minor" });
      expect(v[0]!.reason).toMatch(/1 stream\(s\) differ only in their standings deltas, 1 stream\(s\) differ in their player stats/);
      expect(epochViolations(at3(1, 0, fmt3(rec3())), at3(1, 1, fmt3(rec3({ playerStats: MOVED, deltas: "[1]" }))), frozen)).toEqual([]);
    });
    it("the deltas-only reading is unchanged by the new column: a deltas-only move beside format-3 stats that did not move is deltas-only", () => {
      const v = epochViolations(at3(1, 0, fmt3(rec3())), at3(1, 0, fmt3(rec3({ deltas: "[1]" }))), frozen);
      expect(v[0]).toMatchObject({ changed: 0, deltasOnly: 1, statsOnly: 0, owes: "minor" });
      expect(v[0]!.reason).not.toMatch(/player stats/);
    });
    it("counts every moved stream and accounts each exactly once (matched = unchanged + changed + the minor classes)", () => {
      const next = fmt3(base().map((s, i) => stats3(s, i === 0 ? { playerStats: MOVED } : { playerStats: MOVED })));
      const [row] = compareSides(at3(1, 0, fmt3(rec3())), at3(1, 0, next), frozen);
      expect(row).toMatchObject({ matched: 2, statsOnly: 2, changed: 0 });
    });
    it("a stream ADDED already in format 3 owes nothing and is not 'recorded' (EXTEND_GOLDEN)", () => {
      const [row] = compareSides(at3(1, 0, fmt3(rec3())), at3(1, 0, fmt3([...rec3(), stats3(stream("std", 3))])), frozen);
      expect(row).toMatchObject({ matched: 2, added: 1, recorded: 0, statsOnly: 0, reason: null });
    });
    it("a stream re-recorded with other events is removed and added (a major), never a stats move", () => {
      const v = epochViolations(at3(1, 0, fmt3(rec3())), at3(1, 1, fmt3([stats3(base()[0]!, { events: [{ seq: 9 }] as never, playerStats: MOVED }), stats3(base()[1]!)])), frozen);
      expect(v[0]).toMatchObject({ matched: 1, removed: 1, added: 1, statsOnly: 0, owes: "major" });
    });
  });

  describe("a stream that gains playerStats for the first time (baseline format 2 -> format 3), with the SAME classifier as Q1", () => {
    const before = (): Side => at3(1, 0, fmt2(base().map((s) => recorded(s))));
    const after = (over: Partial<GoldenStream> = {}, major = 1, minor = 0): Side => at3(major, minor, fmt3(rec3(over)));
    it("owes NOTHING when the change touches no fold source, and the row counts it as recorded", () => {
      expect(epochViolations(before(), after(), frozen)).toEqual([]);
      const [row] = compareSides(before(), after(), frozen);
      expect(row).toMatchObject({ matched: 2, changed: 0, deltasOnly: 0, statsOnly: 0, removed: 0, added: 0, recorded: 2, owes: null, reason: null });
    });
    it("owes a MINOR (not a major) when the same change touches fold source, naming the paths and the way out", () => {
      const v = epochViolations(before(), after(), () => [KERNEL]);
      expect(v).toHaveLength(1);
      expect(v[0]).toMatchObject({ sport: "badminton", matched: 2, changed: 0, recorded: 2, owes: "minor" });
      expect(v[0]!.reason).toContain("2 newly recorded stream(s) of player stats");
      expect(v[0]!.reason).toContain(KERNEL);
      expect(v[0]!.reason).toMatch(/land the stats field alone, or raise FOLD_MINOR/);
      expect(v[0]!.reason).toContain("raise FOLD_MINOR.badminton to 1 in src/sport/fold-epoch.ts");
    });
    it("a minor bump settles it, so does a major bump", () => {
      expect(epochViolations(before(), after({}, 1, 1), () => [KERNEL]), "minor 0 -> 1").toEqual([]);
      expect(epochViolations(before(), after({}, 2, 0), () => [KERNEL]), "major 1 -> 2").toEqual([]);
    });
    it("FAILS CLOSED when it is not told what changed: no change list is a touched fold source, never a frozen one", () => {
      const v = epochViolations(before(), after());
      expect(owes(v)).toEqual([["badminton", "minor"]]);
      expect(v[0]!.reason).toMatch(/no list of changed files/);
    });
    it("lists the touched paths the same way Q1 does (a few, then how many more)", () => {
      const many = Array.from({ length: 9 }, (_, i) => `src/stats/f${i}.ts`);
      const v = epochViolations(before(), after(), () => many);
      expect(v[0]!.reason).toContain("src/stats/f0.ts");
      expect(v[0]!.reason).toMatch(/and 6 more/);
    });
    it("the classifier is asked at most once per comparison, and only when a stream gained something", () => {
      let asked = 0;
      const ask = () => { asked++; return [KERNEL]; };
      compareSides(at3(1, 0, fmt3(rec3())), at3(1, 0, fmt3(rec3())), ask);
      expect(asked, "nothing gained: git is never asked").toBe(0);
      compareSides(before(), after(), ask);
      expect(asked, "two streams gained: asked once").toBe(1);
    });
    it("a pre-existing field that ALSO moved is judged as it always was (Q6): a phone output is a major, the deltas the minor", () => {
      for (const over of [{ outcome: "B" }, { summary: '{"x":1}' }, { states: ["s1-new", "s2"] }] as Partial<GoldenStream>[]) {
        const v = epochViolations(before(), after(over), frozen);
        expect(v.map((x) => [x.owes, x.changed, x.recorded]), JSON.stringify(over)).toEqual([["major", 1, 2]]);
      }
      expect(epochViolations(before(), after({ deltas: "[1]" }), frozen).map((x) => [x.owes, x.deltasOnly, x.changed])).toEqual([["minor", 1, 0]]);
    });
    it("gaining the kernel fields AND the stats in one change (format 1 -> 3) follows the kernel rule: frozen owes nothing, touched owes the MAJOR that settles the stats too", () => {
      const one = (): Side => at3(1, 0, corpus(base()));
      expect(epochViolations(one(), after(), frozen)).toEqual([]);
      const [row] = compareSides(one(), after(), frozen);
      expect(row).toMatchObject({ matched: 2, recorded: 2, changed: 0, owes: null });
      const touched = epochViolations(one(), after(), () => [KERNEL]);
      expect(touched[0]).toMatchObject({ changed: 2, recorded: 2, owes: "major" });
      expect(touched[0]!.reason).toMatch(/major owed/);
      expect(epochViolations(one(), after({}, 1, 1), () => [KERNEL]).map((x) => x.owes), "a minor bump does not stand in for the major").toEqual(["major"]);
      expect(epochViolations(one(), after({}, 2, 0), () => [KERNEL]), "the major bump settles both").toEqual([]);
    });
    it("a stream re-recorded in the same change (events differ) is removed and added, never 'recorded'", () => {
      const v = epochViolations(before(), at3(1, 0, fmt3([stats3(base()[0]!, { events: [{ seq: 9 }] as never }), stats3(base()[1]!)])), frozen);
      expect(v[0]).toMatchObject({ matched: 1, recorded: 1, removed: 1, added: 1, owes: "major" });
    });
    it("a sport with no baseline is new: nothing to compare", () => {
      expect(compareSides(null, after(), frozen)).toEqual([]);
    });
  });

  describe("the format never falls: a corpus that stops recording the stats (or the kernel fields) is a violation no bump settles", () => {
    it("3 -> 2 is red whatever else is bumped, and the reason says what was lost and how many streams", () => {
      for (const [major, minor] of [[1, 0], [1, 1], [2, 0], [9, 9]] as const) {
        const v = epochViolations(at3(1, 0, fmt3(rec3())), at3(major, minor, fmt2(base().map((s) => recorded(s)))), frozen);
        expect(v.map((x) => x.sport), `${major}.${minor}`).toEqual(["badminton"]);
        expect(v[0]!.reason, `${major}.${minor}`).toMatch(/^corpus format fell \(3 -> 2\): 2 stream\(s\) recorded their player stats at the baseline and no longer do; a corpus never goes back to format 2/);
      }
    });
    it("3 -> 1 names everything lost; 2 -> 1 keeps the words it always had", () => {
      const v31 = epochViolations(at3(1, 0, fmt3(rec3())), at3(2, 0, corpus(base())), frozen);
      expect(v31[0]!.reason).toMatch(/corpus format fell \(3 -> 1\): 2 stream\(s\) recorded their summaries, overlay and player stats at the baseline/);
      const v21 = epochViolations(at3(1, 0, fmt2(base().map((s) => recorded(s)))), at3(2, 0, corpus(base())), frozen);
      expect(v21[0]!.reason).toMatch(/corpus format fell \(2 -> 1\): 2 stream\(s\) recorded their summaries and overlay at the baseline/);
    });
    it("is a fact about the CORPUS: format 2 with EVERY stream re-recorded (nothing matches) still falls from 3, whatever the bump", () => {
      const rerecorded = base().map((s) => recorded({ ...s, seed: s.seed + 1_000_003 }));
      const [row] = compareSides(at3(1, 0, fmt3(rec3())), at3(2, 0, fmt2(rerecorded)), frozen);
      expect(row).toMatchObject({ matched: 0, removed: 2, added: 2 });
      expect(row!.reason).toMatch(/corpus format fell \(3 -> 2\): 2 stream\(s\)/);
      expect(epochViolations(at3(1, 0, fmt3(rec3())), at3(2, 0, fmt3(rerecorded.map((s) => stats3(s)))), frozen), "the control: re-recorded but still format 3").toEqual([]);
    });
    it("ONE stream that stops recording its stats while the others still do is a fall too (counted per matched stream; the CLI refuses such a hybrid, the pure function must still not wave it through)", () => {
      const [first, second] = rec3();
      const dropped = recorded(base()[1]!); // the kernel fields stay, the stats go
      expect(dropped.playerStats, "precondition: the stream records no stats").toBeUndefined();
      const v = epochViolations(at3(1, 0, fmt3([first!, second!])), at3(1, 0, fmt3([first!, dropped])), frozen);
      expect(v.map((x) => x.sport)).toEqual(["badminton"]);
      expect(v[0]!.reason).toMatch(/corpus format fell/);
      expect(v[0]!.reason).toMatch(/1 stream\(s\) recorded their player stats at the baseline and no longer do/);
      expect(epochViolations(at3(1, 0, fmt3([first!, second!])), at3(1, 1, fmt3([first!, dropped])), frozen), "no bump settles it").toHaveLength(1);
    });
    it("a corpus that drops its `format` marker while its streams keep every field has not fallen: the format is read from the evidence too", () => {
      const { format: _marker, ...unmarked } = fmt3(rec3());
      expect(epochViolations(at3(1, 0, fmt3(rec3())), at3(1, 0, unmarked as GoldenCorpus), frozen)).toEqual([]);
      const { format: _marker2, ...unmarked2 } = fmt2(base().map((s) => recorded(s)));
      expect(epochViolations(at3(1, 0, fmt2(base().map((s) => recorded(s)))), at3(1, 0, unmarked2 as GoldenCorpus), frozen), "and the same for the kernel fields").toEqual([]);
    });
    it("a format-3 corpus kept as it is is not a fall, and neither is a rise", () => {
      expect(epochViolations(at3(1, 0, fmt3(rec3())), at3(1, 0, fmt3(rec3())), frozen)).toEqual([]);
      expect(epochViolations(at3(1, 0, corpus(base())), at3(1, 0, fmt2(base().map((s) => recorded(s)))), frozen)).toEqual([]);
    });
  });

  describe("over every registered sport's real golden corpus", () => {
    const real = new Map<string, GoldenCorpus>();
    beforeAll(() => { forEachSport(({ key }) => { real.set(key, readCorpus(key)); }); }, treeBudget(builtinModules.length));
    const budget = (steps: number) => treeBudget(builtinModules.length, steps);
    /** The tree's corpus as format 3 with placeholder digests and per-stream stats: the guard compares strings, not folds. */
    const asFormat3 = (c: GoldenCorpus): GoldenCorpus => {
      const { format: _format, ...rest } = c;
      return { ...rest, format: 3, streams: c.streams.map(({ summaries: _s, overlay: _o, playerStats: _p, ...plain }) => stats3(plain as GoldenStream)) };
    };
    const asFormat2 = (c: GoldenCorpus): GoldenCorpus => ({ ...asFormat3(c), format: 2, streams: asFormat3(c).streams.map(({ playerStats: _p, ...kept }) => kept) });
    const only = (key: string, c: GoldenCorpus, major = 1, minor = 0): Side => ({ epochs: { [key]: major }, minors: { [key]: minor }, corpora: { [key]: c } });

    it("a stats move in one stream names exactly that sport and owes a MINOR in every sport; the minor bump settles it, and nothing else is flagged (counted)", () => {
      let checked = 0;
      forEachSport(({ key }) => {
        const c = asFormat3(real.get(key)!);
        const first = c.streams[0]!;
        const moved: GoldenCorpus = { ...c, streams: [{ ...first, playerStats: MOVED }, ...c.streams.slice(1)] };
        const v = epochViolations(only(key, c), only(key, moved), frozen);
        expect(v.map((x) => [x.sport, x.owes, x.changed, x.statsOnly, x.matched]), key).toEqual([[key, "minor", 0, 1, c.streams.length]]);
        expect(epochViolations(only(key, c), only(key, moved, 1, 1), frozen), `${key}: minor bumped`).toEqual([]);
        expect(epochViolations(only(key, c), only(key, moved, 2, 0), frozen), `${key}: major bumped`).toEqual([]);
        checked++;
      });
      expect(checked).toBe(builtinModules.length);
    }, budget(4));

    it("a 2 -> 3 reformat that touches no fold source owes nothing in any sport and records every stream; with a fold-source path it owes the MINOR, settled by the minor (counted)", () => {
      let checked = 0;
      let streams = 0;
      forEachSport(({ key }) => {
        const c = real.get(key)!;
        const [row] = compareSides(only(key, asFormat2(c)), only(key, asFormat3(c)), frozen);
        expect(row, key).toMatchObject({ matched: c.streams.length, changed: 0, removed: 0, added: 0, recorded: c.streams.length, owes: null, reason: null });
        for (const path of [KERNEL, `src/sports/${key}/${key}.ts`, "src/stats/stats.ts", "package.json"]) {
          const v = epochViolations(only(key, asFormat2(c)), only(key, asFormat3(c)), () => [path]);
          expect(v.map((x) => [x.sport, x.owes, x.changed, x.recorded]), `${key}: ${path}`).toEqual([[key, "minor", 0, c.streams.length]]);
          expect(epochViolations(only(key, asFormat2(c)), only(key, asFormat3(c), 1, 1), () => [path]), `${key}: ${path} minor bumped`).toEqual([]);
        }
        streams += c.streams.length;
        checked++;
      });
      expect(checked).toBe(builtinModules.length);
      expect(streams).toBeGreaterThanOrEqual(checked);
    }, budget(8));

    it("the format falling from 3 is a violation in every sport, bumped or not (counted)", () => {
      let checked = 0;
      forEachSport(({ key }) => {
        const c = real.get(key)!;
        for (const [major, minor] of [[1, 0], [1, 1], [2, 0]] as const) {
          const v = epochViolations(only(key, asFormat3(c)), only(key, asFormat2(c), major, minor), frozen);
          expect(v.map((x) => x.sport), `${key}: ${major}.${minor}`).toEqual([key]);
          expect(v[0]!.reason).toMatch(/corpus format fell \(3 -> 2\)/);
          checked++;
        }
      });
      expect(checked).toBe(builtinModules.length * 3);
    }, budget(6));
  });
});

// ------------------------------------------------------------------------------------------------------------------------------------
// GF-3 T1: STATS_FOLD_VERSION (src/stats/stats.ts) must RISE whenever the stats a corpus records move. apps/web stores each division's folded
// player-stat rows under an md5 that carries the number, so a stats-fold change without a bump leaves every stored snapshot served as it was
// folded. The version is ONE number for the engine, so the question is asked of the whole change, not per sport; it is independent of the
// epoch (a major that rose does not settle it) and of the minor.

/** A side that also carries the STATS_FOLD_VERSION its tree declared (`undefined` is a side with no stats module). */
const withVersion = (s: Side, statsVersion: number | undefined): Side => (statsVersion === undefined ? s : { ...s, statsVersion });
/** The whole verdict the CLI reaches for a pair of sides, through the one function the CLI composes it with (`guardVerdicts`): the sport rows,
 *  the stats row, the sport violations (as `epochViolations` reports them) and the count the exit code is decided on. */
const judge = (before: Side, after: Side, touched: () => readonly string[] = frozen) => {
  const v = guardVerdicts(before, after, touched);
  return { rows: v.rows, stats: v.stats, verdicts: v.verdicts, violations: epochViolations(before, after, touched) };
};

describe("fold-epoch guard: GF-3 T1 - STATS_FOLD_VERSION must rise when recorded player stats change", () => {
  const base = (): GoldenStream[] => [stream("std", 1, { events: [{ seq: 1 }, { seq: 2 }] as never, states: ["s1", "s2"] }), stream("std", 2)];
  const rec3 = (over: Partial<GoldenStream> = {}, at = 0): GoldenStream[] => base().map((s, i) => (i === at ? stats3(s, over) : stats3(s)));
  const MOVED = JSON.stringify([{ personId: "p", stats: { goals: 99 } }]);
  /** Badminton at (major, minor) holding `streams` as format 3, declaring STATS_FOLD_VERSION `version`. */
  const at = (major: number, minor: number, version: number | undefined, streams: GoldenStream[]): Side => withVersion(at3(major, minor, fmt3(streams)), version);
  const FILE = "src/stats/stats.ts";
  /** The baseline of a 2 -> 3 reformat: both streams recorded the kernel fields (format 2), none the player stats, declaring `version`. */
  const fromFormat2 = (version = 6): Side => withVersion(at3(1, 0, fmt2(base().map((s) => recorded(s)))), version);
  /** The tree of that reformat: the same streams, now recording their stats too, at (1, minor) declaring `version`. */
  const gained = (minor: number, version: number): Side => at(1, minor, version, rec3());

  describe("the rule", () => {
    it("a stats-only change with no stats bump is a violation: the reason names the constant, the file, both values and the number to set", () => {
      const { stats, rows, violations } = judge(at(1, 0, 6, rec3()), at(1, 0, 6, rec3({ playerStats: MOVED })));
      expect(rows[0]).toMatchObject({ statsOnly: 1, statsMoved: 1, owes: "minor" });
      expect(stats).toMatchObject({ before: 6, after: 6, moved: 1, sports: ["badminton"] });
      expect(stats.reason).toMatch(/^STATS_FOLD_VERSION must rise: /);
      expect(stats.reason).toContain("(6 -> 6)");
      expect(stats.reason).toContain(`raise STATS_FOLD_VERSION to 7 in ${FILE}`);
      expect(stats.reason).toContain("1 stream(s) (badminton)");
      expect(violations.map((v) => v.owes), "the sport's own minor is still owed beside it").toEqual(["minor"]);
    });
    it("is settled by a RISE: 6 -> 7 is green, and so is any larger step", () => {
      for (const next of [7, 8, 60]) {
        const { stats } = judge(at(1, 0, 6, rec3()), at(1, 1, next, rec3({ playerStats: MOVED })));
        expect(stats, `6 -> ${next}`).toMatchObject({ before: 6, after: next, moved: 1, reason: null });
      }
    });
    it("a stats bump does not settle the sport's own minor: both are owed, each is paid on its own", () => {
      const v = judge(at(1, 0, 6, rec3()), at(1, 0, 7, rec3({ playerStats: MOVED })));
      expect(v.stats.reason).toBeNull();
      expect(v.violations.map((x) => x.owes)).toEqual(["minor"]);
    });
    it("a stats change with a MAJOR bump but no stats bump is still a violation (snapshot invalidation is independent of the epoch)", () => {
      for (const [major, minor] of [[2, 0], [2, 1], [1, 1], [9, 9]] as const) {
        const { stats, violations } = judge(at(1, 0, 6, rec3()), at(major, minor, 6, rec3({ playerStats: MOVED })));
        expect(stats.reason, `${major}.${minor}`).toMatch(/^STATS_FOLD_VERSION must rise: .*\(6 -> 6\)/);
        if (major === 2 || minor === 1) expect(violations, `${major}.${minor}: the sport itself is paid`).toEqual([]);
      }
    });
    it("a stats change that a phone output moved beside (a MAJOR change) still counts: every matched stream, not only the stats-only ones", () => {
      const next = rec3({ playerStats: MOVED, outcome: "B" });
      const { rows, stats } = judge(at(1, 0, 6, rec3()), at(2, 0, 6, next));
      expect(rows[0]).toMatchObject({ changed: 1, statsOnly: 0, statsMoved: 1 });
      expect(stats).toMatchObject({ moved: 1, sports: ["badminton"] });
      expect(stats.reason).toMatch(/^STATS_FOLD_VERSION must rise/);
      expect(judge(at(1, 0, 6, rec3()), at(2, 0, 7, next)).stats.reason).toBeNull();
    });
    it("counts every moved stream of every sport once, and names the sports in alphabetical order", () => {
      const sideOf = (version: number, over: Partial<GoldenStream> | null): Side => ({
        epochs: { badminton: 1, tennis: 1, hockey: 1 },
        minors: { badminton: 0, tennis: 0, hockey: 0 },
        statsVersion: version,
        corpora: Object.fromEntries(["badminton", "tennis", "hockey"].map((k) => [k, fmt3(base().map((s, i) => stats3(s, over !== null && k !== "hockey" && i === 0 ? over : {})), k)])),
      });
      const { stats, rows } = judge(sideOf(6, null), sideOf(6, { playerStats: MOVED }));
      expect(rows.map((r) => [r.sport, r.statsMoved])).toEqual([["badminton", 1], ["hockey", 0], ["tennis", 1]]);
      expect(stats).toMatchObject({ moved: 2, sports: ["badminton", "tennis"] });
      expect(stats.reason).toContain("2 stream(s) (badminton, tennis)");
    });
    it("counts the STREAMS, not the sports: two moved streams of one sport are two", () => {
      const both = base().map((s) => stats3(s, { playerStats: MOVED }));
      const { rows, stats } = judge(at(1, 0, 6, rec3()), at(1, 0, 6, both));
      expect(rows[0]).toMatchObject({ matched: 2, statsMoved: 2 });
      expect(stats).toMatchObject({ moved: 2, sports: ["badminton"] });
      expect(stats.reason).toContain("2 stream(s) (badminton)");
    });
    it("names the sports alphabetically whatever order the rows come in", () => {
      const sideOf = (over: Partial<GoldenStream>): Side => ({
        epochs: { badminton: 1, tennis: 1, hockey: 1 },
        minors: { badminton: 0, tennis: 0, hockey: 0 },
        statsVersion: 6,
        corpora: Object.fromEntries(["badminton", "tennis", "hockey"].map((k) => [k, fmt3(base().map((s, i) => stats3(s, i === 0 ? over : {})), k)])),
      });
      const before = sideOf({});
      const after = sideOf({ playerStats: MOVED });
      const rows = compareSides(before, after, frozen);
      expect(rows.map((r) => r.sport), "precondition: the sport rows are in a known order").toEqual(["badminton", "hockey", "tennis"]);
      for (const order of [rows, [...rows].reverse(), [rows[1]!, rows[2]!, rows[0]!]]) {
        expect(statsVersionRow(before, after, order).sports, order.map((r) => r.sport).join(",")).toEqual(["badminton", "hockey", "tennis"]);
      }
    });
    it("names the sports of newly recorded streams alphabetically whatever order the rows come in", () => {
      const names = ["badminton", "tennis", "hockey"];
      const before: Side = { epochs: { badminton: 1, tennis: 1, hockey: 1 }, minors: { badminton: 0, tennis: 0, hockey: 0 }, statsVersion: 6, corpora: Object.fromEntries(names.map((k) => [k, fmt2(base().map((s) => recorded(s)), k)])) };
      const after: Side = { ...before, corpora: Object.fromEntries(names.map((k) => [k, fmt3(base().map((s) => stats3(s)), k)])) };
      const rows = compareSides(before, after, () => [KERNEL]);
      expect(rows.map((r) => r.sport), "precondition: the sport rows are in a known order").toEqual(["badminton", "hockey", "tennis"]);
      let checked = 0;
      for (const order of [rows, [...rows].reverse(), [rows[1]!, rows[2]!, rows[0]!]]) {
        expect(statsVersionRow(before, after, order, () => [KERNEL]).gainedSports, order.map((r) => r.sport).join(",")).toEqual(["badminton", "hockey", "tennis"]);
        checked++;
      }
      expect(checked).toBe(3);
    });
    it("the version never falls: 6 -> 5 is a violation with nothing else changed, and no minor or major bump settles it", () => {
      for (const [major, minor] of [[1, 0], [1, 1], [2, 0]] as const) {
        const { stats, violations } = judge(at(1, 0, 6, rec3()), at(major, minor, 5, rec3()));
        expect(stats, `${major}.${minor}`).toMatchObject({ before: 6, after: 5, moved: 0 });
        expect(stats.reason, `${major}.${minor}`).toBe(`STATS_FOLD_VERSION went down (6 -> 5); a version only rises: set STATS_FOLD_VERSION back to at least 6 in ${FILE}`);
        expect(violations, "no sport is owed anything").toEqual([]);
      }
    });
    it("a fall beside a stats change names both: it went down AND it must rise", () => {
      const { stats } = judge(at(1, 0, 6, rec3()), at(1, 1, 5, rec3({ playerStats: MOVED })));
      expect(stats.reason).toMatch(/went down \(6 -> 5\).*; STATS_FOLD_VERSION must rise: .*raise STATS_FOLD_VERSION to 7/);
    });
    it("a held version with no stats change is not a violation (the control: the cases above are not red for another reason)", () => {
      const { stats, rows } = judge(at(1, 0, 6, rec3()), at(1, 0, 6, rec3()));
      expect(rows[0]).toMatchObject({ statsMoved: 0, statsOnly: 0 });
      expect(stats).toMatchObject({ before: 6, after: 6, moved: 0, sports: [], reason: null });
    });
    it("a bump with no stats change is not a violation either (a version may rise on its own, as an epoch may)", () => {
      for (const next of [7, 8]) expect(judge(at(1, 0, 6, rec3()), at(1, 0, next, rec3())).stats, `6 -> ${next}`).toMatchObject({ moved: 0, reason: null });
    });
    it("a stream that GAINS its stats (a 2 -> 3 reformat) with fold source FROZEN owes no stats bump: the recorder ran the baseline's own code, so nothing stored was computed differently", () => {
      const { stats, rows, verdicts } = judge(fromFormat2(), gained(0, 6), frozen);
      expect(rows[0], "precondition: both streams are newly recorded").toMatchObject({ recorded: 2, statsMoved: 0, statsGainedUnfrozen: 0 });
      expect(stats).toMatchObject({ before: 6, after: 6, moved: 0, gained: 0, sports: [], gainedSports: [], reason: null });
      expect(verdicts).toBe(0);
    });
    it("... and with fold source TOUCHED in the same change it owes the rise, as the sport owes its minor: the new stats were folded by code this change may have moved", () => {
      for (const touched of [[KERNEL], ["src/stats/stats.ts"], ["src/sports/badminton/badminton.ts"], ["package.json"]]) {
        const { stats, rows, violations, verdicts } = judge(fromFormat2(), gained(1, 6), () => touched);
        expect(rows[0], `${touched[0]}: both streams are newly recorded under touched source`).toMatchObject({ recorded: 2, statsMoved: 0, statsGainedUnfrozen: 2 });
        expect(violations, "the sport's own minor is paid, so the stats row is the ONLY verdict").toEqual([]);
        expect(stats, touched[0]).toMatchObject({ before: 6, after: 6, moved: 0, gained: 2, sports: [], gainedSports: ["badminton"] });
        expect(stats.reason, touched[0]).toBe(
          `STATS_FOLD_VERSION must rise: 2 stream(s) (badminton) newly record player stats while the change touches fold source: ${touched[0]} (land the stats field alone, or raise STATS_FOLD_VERSION), and STATS_FOLD_VERSION did not rise (6 -> 6): raise STATS_FOLD_VERSION to 7 in ${FILE}, in this same change (apps/web serves every stored player-stat snapshot as the old fold computed it until the number moves, whatever FOLD_EPOCH or FOLD_MINOR did)`,
        );
        expect(verdicts, touched[0]).toBe(1);
        // paid by a rise, and only by a rise
        expect(judge(fromFormat2(), gained(1, 7), () => touched).stats, `${touched[0]}: 6 -> 7`).toMatchObject({ gained: 2, reason: null });
        expect(judge(fromFormat2(), gained(1, 7), () => touched).verdicts).toBe(0);
        expect(judge(fromFormat2(), gained(1, 5), () => touched).stats.reason, `${touched[0]}: a fall is a fall`).toMatch(/^STATS_FOLD_VERSION went down \(6 -> 5\).*; STATS_FOLD_VERSION must rise: /);
      }
    });
    it("the sport's own minor and the stats version are owed side by side when stats are newly recorded under touched source: neither pays the other", () => {
      const touched = () => [KERNEL];
      const bare = judge(fromFormat2(), gained(0, 6), touched);
      expect(bare.violations.map((v) => v.owes), "the Q1 minor").toEqual(["minor"]);
      expect(bare.stats.reason).toMatch(/^STATS_FOLD_VERSION must rise: 2 stream\(s\)/);
      expect(bare.verdicts).toBe(2);
      const minorOnly = judge(fromFormat2(), gained(1, 6), touched);
      expect(minorOnly.violations).toEqual([]);
      expect(minorOnly.stats.reason).not.toBeNull();
      expect(minorOnly.verdicts).toBe(1);
      const versionOnly = judge(fromFormat2(), gained(0, 7), touched);
      expect(versionOnly.violations.map((v) => v.owes)).toEqual(["minor"]);
      expect(versionOnly.stats.reason).toBeNull();
      expect(versionOnly.verdicts).toBe(1);
      expect(judge(fromFormat2(), gained(1, 7), touched).verdicts).toBe(0);
    });
    it("a MAJOR bump does not settle the newly recorded stats either (independent of the epoch), and a stream that gains the kernel fields beside them still counts", () => {
      const touched = () => [KERNEL];
      for (const [major, minor] of [[2, 0], [2, 1], [1, 1]] as const) {
        expect(judge(fromFormat2(), withVersion(at3(major, minor, fmt3(rec3())), 6), touched).stats.reason, `${major}.${minor}`).toMatch(/^STATS_FOLD_VERSION must rise: 2 stream\(s\) \(badminton\) newly record/);
      }
      // a format-1 baseline: the stream gains the kernel fields AND the stats at once (the sport owes its major for the first)
      const fromFormat1 = withVersion(at3(1, 0, corpus(base())), 6);
      const j = judge(fromFormat1, at(1, 0, 6, rec3()), touched);
      expect(j.rows[0], "precondition: the sport owes its major").toMatchObject({ recorded: 2, owes: "major", statsGainedUnfrozen: 2 });
      expect(j.stats).toMatchObject({ gained: 2, gainedSports: ["badminton"] });
      expect(j.stats.reason).toMatch(/^STATS_FOLD_VERSION must rise: 2 stream\(s\)/);
      expect(judge(fromFormat1, at(2, 0, 7, rec3()), touched).stats.reason).toBeNull();
    });
    it("only a stream that GAINED its stats counts as gaining: a matched format-3 stream whose stats are unchanged owes nothing under touched source (the control)", () => {
      const { rows, stats, verdicts } = judge(at(1, 0, 6, rec3()), at(1, 0, 6, rec3()), () => [KERNEL]);
      expect(rows[0]).toMatchObject({ matched: 2, recorded: 0, statsGainedUnfrozen: 0 });
      expect(stats).toMatchObject({ moved: 0, gained: 0, reason: null });
      expect(verdicts).toBe(0);
    });
    it("counts streams and names sports across sports: two newly recorded streams in each of two sports and one in a third are five, in alphabetical order", () => {
      const names = ["badminton", "tennis", "hockey"];
      const before: Side = { epochs: { badminton: 1, tennis: 1, hockey: 1 }, minors: { badminton: 0, tennis: 0, hockey: 0 }, statsVersion: 6, corpora: Object.fromEntries(names.map((k) => [k, fmt2(base().map((s) => recorded(s)), k)])) };
      // tennis: only its first stream gains the stats (its second stays format-2 on both sides)
      const after: Side = { ...before, corpora: Object.fromEntries(names.map((k) => [k, fmt3(base().map((s, i) => (k === "tennis" && i > 0 ? recorded(s) : stats3(s))), k)])) };
      const { rows, stats } = judge(before, after, () => [KERNEL]);
      expect(rows.map((r) => [r.sport, r.statsGainedUnfrozen])).toEqual([["badminton", 2], ["hockey", 2], ["tennis", 1]]);
      expect(stats).toMatchObject({ gained: 5, gainedSports: ["badminton", "hockey", "tennis"] });
      expect(stats.reason).toContain("5 stream(s) (badminton, hockey, tennis) newly record");
    });
    it("the list of changed files is asked at most once, and only when a stream gained its stats (a lazy question: it costs a git call in the CLI)", () => {
      let asked = 0;
      const spy = () => { asked++; return [KERNEL]; };
      guardVerdicts(at(1, 0, 6, rec3()), at(1, 0, 6, rec3({ playerStats: MOVED })), spy);
      expect(asked, "a stats move needs no list").toBe(0);
      guardVerdicts(fromFormat2(), gained(1, 6), spy);
      expect(asked, "the sport rows and the stats row share one answer").toBe(1);
    });
    it("no list of changed files given means source MAY have changed: newly recorded stats then owe the rise (the safe reading), saying so", () => {
      const v = guardVerdicts(fromFormat2(), gained(1, 6));
      expect(v.stats.gained).toBe(2);
      expect(v.stats.reason).toContain("no list of changed files was given");
      expect(guardVerdicts(fromFormat2(), gained(1, 7)).stats.reason).toBeNull();
    });
    it("lists at most three of the touched paths and counts the rest", () => {
      const many = ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts"];
      const { stats } = judge(fromFormat2(), gained(1, 6), () => many);
      expect(stats.reason).toContain("touches fold source: src/a.ts, src/b.ts, src/c.ts, and 2 more (");
    });
    it("streams that are REMOVED or re-recorded owe no stats bump: their input changed, so their stats are not comparable (the sport owes its major instead)", () => {
      const rerecorded = [stats3(base()[0]!, { events: [{ seq: 9 }] as never, playerStats: MOVED }), stats3(base()[1]!)];
      const { rows, stats, violations } = judge(at(1, 0, 6, rec3()), at(1, 0, 6, rerecorded));
      expect(rows[0]).toMatchObject({ matched: 1, removed: 1, added: 1, statsMoved: 0 });
      expect(stats).toMatchObject({ moved: 0, reason: null });
      expect(violations.map((v) => v.owes)).toEqual(["major"]);
      const removed = judge(at(1, 0, 6, rec3()), at(1, 0, 6, [stats3(base()[1]!)]));
      expect(removed.rows[0]).toMatchObject({ removed: 1, statsMoved: 0 });
      expect(removed.stats.reason).toBeNull();
      // ... and a format-2 stream re-recorded in format 3 under touched source did not GAIN its stats: it is a new stream (nothing to compare)
      const reRecordedAsNew = judge(fromFormat2(), at(1, 0, 6, [stats3(base()[0]!, { events: [{ seq: 9 }] as never }), stats3(base()[1]!, { events: [{ seq: 8 }] as never })]), () => [KERNEL]);
      expect(reRecordedAsNew.rows[0], "precondition: nothing matched").toMatchObject({ matched: 0, removed: 2, added: 2, statsGainedUnfrozen: 0 });
      expect(reRecordedAsNew.stats).toMatchObject({ gained: 0, moved: 0, reason: null });
    });
    it("a stream ADDED already in format 3 owes none (EXTEND_GOLDEN)", () => {
      const { rows, stats } = judge(at(1, 0, 6, rec3()), at(1, 0, 6, [...rec3(), stats3(stream("std", 3))]));
      expect(rows[0]).toMatchObject({ matched: 2, added: 1, statsMoved: 0 });
      expect(stats.reason).toBeNull();
    });
    it("stats are compared only when BOTH sides record them: a stream that lost its stats is the format falling, not a stats move", () => {
      const lost = base().map((s) => recorded(s)); // format 3 -> format 2
      const { rows, stats } = judge(at(1, 0, 6, rec3()), withVersion(at3(1, 0, fmt2(lost)), 6));
      expect(rows[0]).toMatchObject({ statsMoved: 0 });
      expect(rows[0]!.reason).toMatch(/corpus format fell/);
      expect(stats).toMatchObject({ moved: 0, reason: null });
    });
    it("the call is pure and the answer is the same the second time; a later change needs its OWN bump on top of the last", () => {
      const was = at(1, 0, 6, rec3());
      const now = at(1, 1, 7, rec3({ playerStats: MOVED }));
      const first = judge(was, now);
      const second = judge(was, now);
      expect(second.stats).toEqual(first.stats);
      expect(first.stats).toMatchObject({ before: 6, after: 7, moved: 1, reason: null });
      // the next change is judged against 7, not 6: the bump already spent does not pay for it
      const MOVED_AGAIN = JSON.stringify([{ personId: "p", stats: { goals: 100 } }]);
      const next = judge(now, at(1, 2, 7, rec3({ playerStats: MOVED_AGAIN })));
      expect(next.stats.reason).toMatch(/\(7 -> 7\).*raise STATS_FOLD_VERSION to 8/);
      expect(judge(now, at(1, 2, 8, rec3({ playerStats: MOVED_AGAIN }))).stats.reason).toBeNull();
      expect(judge(was, now).stats, "and the earlier verdict is unchanged by the later call").toEqual(first.stats);
    });
  });

  describe("fail closed: a side whose version was not given, or a baseline that cannot be compared", () => {
    it("a current side with no STATS_FOLD_VERSION is refused, even when no stream moved (a pass over a missing number proves nothing)", () => {
      const was = at(1, 0, 6, rec3());
      expect(() => statsVersionRow(was, at(1, 0, undefined, rec3()), compareSides(was, at(1, 0, undefined, rec3()), frozen))).toThrow(GuardRefusal);
      expect(() => statsVersionRow(was, at(1, 0, undefined, rec3()), compareSides(was, at(1, 0, undefined, rec3()), frozen))).toThrow(/current tree declares no STATS_FOLD_VERSION/);
    });
    it("a baseline with no stats module that already RECORDS player stats is refused: the module moved, and a change cannot be judged against nothing", () => {
      const was = at(1, 0, undefined, rec3());
      const now = at(1, 0, 6, rec3({ playerStats: MOVED }));
      expect(() => statsVersionRow(was, now, compareSides(was, now, frozen))).toThrow(GuardRefusal);
      expect(() => statsVersionRow(was, now, compareSides(was, now, frozen))).toThrow(/baseline records player stats .* declares no STATS_FOLD_VERSION/);
      // ... whether or not a stream moved
      expect(() => statsVersionRow(was, at(1, 0, 6, rec3()), compareSides(was, at(1, 0, 6, rec3()), frozen))).toThrow(GuardRefusal);
    });
    it("ONE corpus recording stats is enough to refuse (a baseline whose other sports are still format 2), and so is ONE stream within a corpus", () => {
      const onlyHockey = (hockey: GoldenCorpus): Side => ({
        epochs: { badminton: 1, hockey: 1 },
        minors: { badminton: 0, hockey: 0 },
        corpora: { badminton: fmt2(base().map((x) => recorded(x))), hockey },
      });
      const now: Side = { ...onlyHockey(fmt3(rec3(), "hockey")), statsVersion: 6 };
      const mixed = onlyHockey(fmt3(rec3(), "hockey"));
      expect(() => statsVersionRow(mixed, now, compareSides(mixed, now, frozen)), "one corpus of two").toThrow(/baseline records player stats/);
      // a corpus holding one stream that records stats beside one that does not (the CLI refuses such a hybrid; the pure rule must still see it)
      const [first, second] = rec3();
      const hybrid = onlyHockey({ ...fmt3([first!, recorded(base()[1]!)], "hockey"), streams: [first!, { ...second!, playerStats: undefined }] });
      expect(() => statsVersionRow(hybrid, now, compareSides(hybrid, now, frozen)), "one stream of two").toThrow(/baseline records player stats/);
      // the control: every corpus format 2 is the bootstrap
      const none = onlyHockey(fmt2(base().map((x) => recorded(x)), "hockey"));
      expect(statsVersionRow(none, now, compareSides(none, now, frozen)).reason).toBeNull();
    });
    it("a baseline with no stats module and no recorded stats is the bootstrap: nothing was stored under a version, so nothing is owed (the number is reported as none)", () => {
      for (const corpusOf of [(): GoldenCorpus => corpus(base()), (): GoldenCorpus => fmt2(base().map((s) => recorded(s)))]) {
        const was: Side = at3(1, 0, corpusOf());
        const now = at(1, 0, 6, rec3());
        for (const touched of [frozen, () => ["src/stats/stats.ts", KERNEL]]) {
          const { stats, verdicts, violations } = judge(was, now, touched);
          expect(stats, "no number at the baseline, so nothing was stored under one: the change that introduces the module owes no rise, touched source or not").toEqual({ before: null, after: 6, moved: 0, gained: 0, sports: [], gainedSports: [], reason: null });
          expect(verdicts, "the sport's own rows may be owed (touched source), the stats row never is").toBe(violations.length);
        }
      }
    });
    it("a baseline WITH a module and no recorded stats is compared as usual (a format-2 base cannot owe a stats move)", () => {
      const { stats } = judge(withVersion(at3(1, 0, fmt2(base().map((s) => recorded(s)))), 6), at(1, 0, 6, rec3()));
      expect(stats).toMatchObject({ before: 6, after: 6, moved: 0, reason: null });
      expect(judge(withVersion(at3(1, 0, fmt2(base().map((s) => recorded(s)))), 6), at(1, 0, 5, rec3())).stats.reason, "and a fall is a fall").toMatch(/went down/);
    });
  });

  describe("guardVerdicts composes the sport verdicts and the stats verdict into the one count the CLI exits on", () => {
    const moved = (minor: number, version: number): Side => at(1, minor, version, rec3({ playerStats: MOVED }));
    it("the stats row is a verdict beside the sport rows: neither pays the other, and each counts once (counted over all four combinations)", () => {
      const was = at(1, 0, 6, rec3());
      let checked = 0;
      for (const [minor, version, sportRows, statsRow] of [[1, 7, 0, 0], [1, 6, 0, 1], [0, 7, 1, 0], [0, 6, 1, 1]] as const) {
        const v = guardVerdicts(was, moved(minor, version), frozen);
        expect(v.violations.length, `minor ${minor}, version ${version}: sport rows`).toBe(sportRows);
        expect(v.stats.reason === null ? 0 : 1, `minor ${minor}, version ${version}: stats row`).toBe(statsRow);
        expect(v.verdicts, `minor ${minor}, version ${version}`).toBe(sportRows + statsRow);
        checked++;
      }
      expect(checked).toBe(4);
    });
    it("a stats row alone is a verdict (a fall with nothing moved: no sport owes anything), and a sport row alone is one", () => {
      const fell = guardVerdicts(at(1, 0, 6, rec3()), at(1, 0, 5, rec3()), frozen);
      expect(fell.violations).toEqual([]);
      expect(fell.verdicts).toBe(1);
      const sportOnly = guardVerdicts(at(1, 0, 6, rec3()), at(1, 0, 6, rec3({ outcome: "B" })), frozen);
      expect(sportOnly.stats.reason).toBeNull();
      expect(sportOnly.verdicts).toBe(1);
      expect(guardVerdicts(at(1, 0, 6, rec3()), at(1, 0, 6, rec3()), frozen).verdicts, "the control: nothing changed").toBe(0);
    });
    it("reports the rows of every sport, the sports that had a baseline, the streams compared and the violating rows, in sport order", () => {
      const before: Side = { epochs: { tennis: 1, badminton: 1 }, minors: { tennis: 0, badminton: 0 }, statsVersion: 6, corpora: { badminton: fmt3(rec3(), "badminton"), tennis: fmt3(rec3(), "tennis") } };
      const after: Side = {
        epochs: { tennis: 1, badminton: 1, hockey: 1 },
        minors: { tennis: 0, badminton: 0, hockey: 0 },
        statsVersion: 6,
        corpora: { badminton: fmt3(rec3(), "badminton"), tennis: fmt3(rec3({ outcome: "B" }), "tennis"), hockey: fmt3(rec3(), "hockey") },
      };
      const v = guardVerdicts(before, after, frozen);
      expect(v.rows.map((r) => r.sport)).toEqual(["badminton", "hockey", "tennis"]);
      expect(v.compared.map((r) => r.sport), "hockey is new in this change: nothing to compare it with").toEqual(["badminton", "tennis"]);
      expect(v.streams, "streams compared: the matched streams of the sports that had a baseline").toBe(4);
      expect(v.violations.map((r) => r.sport)).toEqual(["tennis"]);
      expect(v.violations[0]!.reason).toMatch(/^major owed/);
      expect(v.verdicts).toBe(1);
    });
    it("agrees with epochViolations and statsVersionRow, which it composes (a second caller cannot skip the stats rule)", () => {
      let checked = 0;
      for (const [minor, version] of [[0, 6], [1, 6], [0, 7], [1, 7]] as const) {
        const after = moved(minor, version);
        const was = at(1, 0, 6, rec3());
        const v = guardVerdicts(was, after, frozen);
        expect(v.violations.map((r) => r.sport)).toEqual(epochViolations(was, after, frozen).map((x) => x.sport));
        expect(v.stats).toEqual(statsVersionRow(was, after, compareSides(was, after, frozen)));
        checked++;
      }
      expect(checked).toBe(4);
    });
    it("refuses like its parts do: a tree with no number, and a baseline that records stats but has none", () => {
      expect(() => guardVerdicts(at(1, 0, 6, rec3()), at(1, 0, undefined, rec3()), frozen)).toThrow(/current tree declares no STATS_FOLD_VERSION/);
      expect(() => guardVerdicts(at(1, 0, undefined, rec3()), at(1, 0, 6, rec3()), frozen)).toThrow(/baseline records player stats/);
    });
  });

  describe("sideStatsVersion: the tree must have a stats module, a baseline need not, and a module that is there must parse", () => {
    const SRC = "export const STATS_FOLD_VERSION = 6;\n";
    it("the tree role: a missing module is refused (a deleted module must not read as no version), naming the file; a present one is read", () => {
      expect(() => sideStatsVersion(null, "", STATS_REQUIRED.tree)).toThrow(GuardRefusal);
      expect(() => sideStatsVersion(null, "", STATS_REQUIRED.tree)).toThrow(/src\/stats\/stats\.ts is missing: the guard cannot read STATS_FOLD_VERSION/);
      expect(sideStatsVersion(SRC, "", STATS_REQUIRED.tree)).toBe(6);
    });
    it("the baseline role: a missing module is the bootstrap (no number), a present one is read, and a present one that does not parse is refused naming the ref", () => {
      expect(sideStatsVersion(null, " at origin/main", STATS_REQUIRED.baseline)).toBeUndefined();
      expect(sideStatsVersion(SRC, " at origin/main", STATS_REQUIRED.baseline)).toBe(6);
      expect(() => sideStatsVersion("export const OTHER = 1;\n", " at origin/main", STATS_REQUIRED.baseline)).toThrow(/src\/stats\/stats\.ts at origin\/main declares no line/);
      expect(() => sideStatsVersion("", "", STATS_REQUIRED.tree)).toThrow(/declares no line/);
    });
    it("the requirement itself decides, whoever asks", () => {
      expect(sideStatsVersion(null, "", false)).toBeUndefined();
      expect(() => sideStatsVersion(null, "", true)).toThrow(GuardRefusal);
      expect(sideStatsVersion(SRC, "", false)).toBe(6);
      expect(sideStatsVersion(SRC, "", true)).toBe(6);
    });
  });

  describe("parseStatsFoldVersion reads the constant by its exact declaration and refuses everything else", () => {
    const LABEL = "src/stats/stats.ts at origin/main";
    const text = (line: string): string => `import { x } from "./y.ts";\n\n/** doc */\n${line}\n\nexport const OTHER = 1;\n`;
    it("reads the live constant out of the real file's text (derived from the engine's own declaration)", () => {
      const real = readFileSync(new URL("../src/stats/stats.ts", import.meta.url), "utf8");
      expect(Number.isInteger(STATS_FOLD_VERSION) && STATS_FOLD_VERSION >= 1).toBe(true);
      expect(parseStatsFoldVersion(real, LABEL)).toBe(STATS_FOLD_VERSION);
    });
    it("reads any positive integer, with the line ending or trailing blanks the file happens to have", () => {
      for (const [line, n] of [["export const STATS_FOLD_VERSION = 1;", 1], ["export const STATS_FOLD_VERSION = 6;", 6], ["export const STATS_FOLD_VERSION = 12;", 12], ["export const STATS_FOLD_VERSION = 6;  ", 6], ["export const STATS_FOLD_VERSION = 6;\t", 6], ["export const STATS_FOLD_VERSION = 6;\r", 6]] as const) {
        expect(parseStatsFoldVersion(text(line), LABEL), JSON.stringify(line)).toBe(n);
      }
      expect(parseStatsFoldVersion(`export const STATS_FOLD_VERSION = 4;`, LABEL), "a file that is only the line").toBe(4);
      expect(parseStatsFoldVersion(text("export const STATS_FOLD_VERSION = 6;").replace(/\n/g, "\r\n"), LABEL), "a CRLF file").toBe(6);
    });
    it("accepts a trailing line comment after the semicolon, whatever the comment says (and nothing else may follow it)", () => {
      let read = 0;
      for (const [line, n] of [
        ["export const STATS_FOLD_VERSION = 6; // bump when the stats fold changes", 6],
        ["export const STATS_FOLD_VERSION = 6;// no space", 6],
        ["export const STATS_FOLD_VERSION = 7;\t//\ttabs", 7],
        ["export const STATS_FOLD_VERSION = 8; //", 8],
        ["export const STATS_FOLD_VERSION = 9; // a // b", 9],
        ["export const STATS_FOLD_VERSION = 10; // export const STATS_FOLD_VERSION = 99;", 10],
        ["export const STATS_FOLD_VERSION = 11; // trailing blanks  ", 11],
      ] as const) {
        expect(parseStatsFoldVersion(text(line), LABEL), JSON.stringify(line)).toBe(n);
        expect(parseStatsFoldVersion(text(line).replace(/\n/g, "\r\n"), LABEL), `${JSON.stringify(line)} (CRLF)`).toBe(n);
        read++;
      }
      expect(read).toBe(7);
      // a commented line is still ONE declaration: a second, commented or not, is the refusal that says so
      expect(() => parseStatsFoldVersion(`export const STATS_FOLD_VERSION = 6; // a\nexport const STATS_FOLD_VERSION = 7; // b\n`, LABEL)).toThrow(/declares `STATS_FOLD_VERSION` 2 times/);
    });
    it("a declaration quoted inside a doc comment is not the declaration", () => {
      const doc = ["/**", " * export const STATS_FOLD_VERSION = 99;", " */", "// export const STATS_FOLD_VERSION = 98;", "export const STATS_FOLD_VERSION = 6;"].join("\n");
      expect(parseStatsFoldVersion(doc, LABEL)).toBe(6);
    });
    const BAD: ReadonlyArray<readonly [string, string, RegExp]> = [
      ["no declaration at all", text("export const SOMETHING = 6;"), /declares no line `export const STATS_FOLD_VERSION = <integer>;`/],
      ["an empty file", "", /declares no line/],
      ["a type annotation", text("export const STATS_FOLD_VERSION: number = 6;"), /declares no line/],
      ["a cast", text("export const STATS_FOLD_VERSION = 6 as number;"), /declares no line/],
      ["not exported", text("const STATS_FOLD_VERSION = 6;"), /declares no line/],
      ["a let", text("export let STATS_FOLD_VERSION = 6;"), /declares no line/],
      ["indented", text("  export const STATS_FOLD_VERSION = 6;"), /declares no line/],
      ["no semicolon", text("export const STATS_FOLD_VERSION = 6"), /declares no line/],
      ["code after it on the line", text("export const STATS_FOLD_VERSION = 6; export const B = 1;"), /declares no line/],
      ["a block comment after it", text("export const STATS_FOLD_VERSION = 6; /* x */"), /declares no line/],
      ["code, then a comment, after it", text("export const STATS_FOLD_VERSION = 6; export const B = 1; // x"), /declares no line/],
      ["a comment where the semicolon belongs", text("export const STATS_FOLD_VERSION = 6 // x"), /declares no line/],
      ["a block comment before the semicolon", text("export const STATS_FOLD_VERSION = 6 /* x */;"), /declares no line/],
      ["a slash that does not start a comment", text("export const STATS_FOLD_VERSION = 6; / x"), /declares no line/],
      ["a comment only", text("// export const STATS_FOLD_VERSION = 6; // x"), /declares no line/],
      ["an expression", text("export const STATS_FOLD_VERSION = 3 + 3;"), /declares no line/],
      ["a decimal", text("export const STATS_FOLD_VERSION = 6.5;"), /declares no line/],
      ["a negative number", text("export const STATS_FOLD_VERSION = -1;"), /declares no line/],
      ["a different name", text("export const STATS_FOLD_VERSION_X = 6;"), /declares no line/],
      ["declared twice", `${text("export const STATS_FOLD_VERSION = 6;")}export const STATS_FOLD_VERSION = 7;\n`, /declares `STATS_FOLD_VERSION` 2 times/],
      ["zero", text("export const STATS_FOLD_VERSION = 0;"), /STATS_FOLD_VERSION is 0, and a version is a positive integer/],
      ["a leading zero", text("export const STATS_FOLD_VERSION = 06;"), /STATS_FOLD_VERSION is 06, and a version is a positive integer/],
      ["beyond the safe integers", text("export const STATS_FOLD_VERSION = 9007199254740993;"), /STATS_FOLD_VERSION is 9007199254740993, and a version is a positive integer/],
    ];
    it("refuses a text that does not declare it exactly once as a positive safe integer, naming the file and the shape it wants", () => {
      let refused = 0;
      for (const [name, source, message] of BAD) {
        let error: unknown;
        try {
          parseStatsFoldVersion(source, LABEL);
        } catch (e) {
          error = e;
        }
        expect(error, name).toBeInstanceOf(GuardRefusal);
        expect((error as Error).message, name).toContain(LABEL);
        expect((error as Error).message, name).toMatch(message);
        refused++;
      }
      expect(refused).toBe(BAD.length);
      expect(BAD.length).toBeGreaterThan(15);
    });
  });

  describe("the policy text says what the guard does (GOLDEN-POLICY.md)", () => {
    const policy = readFileSync(new URL("../src/testkit/GOLDEN-POLICY.md", import.meta.url), "utf8");
    it("states the rule in the words the guard prints, and no longer calls the version a manual obligation the guard does not enforce", () => {
      const { stats } = judge(at(1, 0, 6, rec3()), at(1, 0, 6, rec3({ playerStats: MOVED })));
      const fall = judge(at(1, 0, 6, rec3()), at(1, 0, 5, rec3())).stats;
      // the leading words of each reason, as the guard really prints them
      const mustRise = /^STATS_FOLD_VERSION must rise/.exec(stats.reason ?? "")?.[0];
      const wentDown = /^STATS_FOLD_VERSION went down/.exec(fall.reason ?? "")?.[0];
      expect(mustRise, "the guard's own reason").toBeDefined();
      expect(wentDown, "the guard's own reason").toBeDefined();
      expect(policy).toContain(mustRise!);
      expect(policy).toContain(wentDown!);
      expect(policy).toContain("`STATS_FOLD_VERSION` is enforced (GF-3 T1)");
      expect(policy).not.toMatch(/separate, manual obligation this guard does not enforce/);
      expect(policy).not.toMatch(/nothing requires the number\s+to rise/);
      expect(policy).not.toContain("plus a manual obligation: raise `STATS_FOLD_VERSION`");
    });
    it("names the newly recorded stats rule in the words the guard prints, says the data-only reformat owes nothing, and lists the re-recorded blind spot", () => {
      const reason = judge(fromFormat2(), gained(1, 6), () => [KERNEL]).stats.reason ?? "";
      const phrase = /newly record player stats while the change touches fold source/.exec(reason)?.[0];
      expect(phrase, "the guard's own reason").toBeDefined();
      const flat = policy.replace(/\s+/g, " ");
      expect(flat).toContain(phrase!);
      expect(flat).toContain("land the stats field alone, or raise STATS_FOLD_VERSION");
      expect(flat).toContain("A data-only reformat of an untouched tree");
      expect(flat).not.toContain("with or without fold source touched");
      expect(flat).toContain("a stats-rule change whose every moved stream is ALSO re-recorded in the same PR");
      expect(flat).toContain("the `STATS_FOLD_VERSION` rise is owed by hand");
    });
    it("names the three edges the code has: the bootstrap, the moved module and the fail-closed read", () => {
      expect(policy).toMatch(/baseline with no `src\/stats\/stats\.ts`/);
      expect(policy).toContain("(none)");
      expect(policy).toMatch(/module was moved or renamed/);
      expect(policy).toMatch(/\*\*fails closed\*\*/);
    });
  });

  describe("over every registered sport's real golden corpus", () => {
    const real = new Map<string, GoldenCorpus>();
    beforeAll(() => { forEachSport(({ key }) => { real.set(key, readCorpus(key)); }); }, treeBudget(builtinModules.length));
    const budget = (steps: number) => treeBudget(builtinModules.length, steps);
    /** The tree's corpus as format 3 with per-stream placeholder stats: the guard compares text, not folds. */
    const asFormat3 = (c: GoldenCorpus): GoldenCorpus => {
      const { format: _format, ...rest } = c;
      return { ...rest, format: 3, streams: c.streams.map(({ summaries: _s, overlay: _o, playerStats: _p, ...plain }) => stats3(plain as GoldenStream)) };
    };
    const asFormat2 = (c: GoldenCorpus): GoldenCorpus => ({ ...asFormat3(c), format: 2, streams: asFormat3(c).streams.map(({ playerStats: _p, ...kept }) => kept) });
    const only = (key: string, c: GoldenCorpus, major: number, minor: number, version: number): Side => ({ epochs: { [key]: major }, minors: { [key]: minor }, statsVersion: version, corpora: { [key]: c } });

    it("a 2 -> 3 reformat of any sport owes the rise exactly when the change touches fold source, and a rise pays it (counted)", () => {
      let checked = 0;
      let streams = 0;
      forEachSport(({ key }) => {
        const c = real.get(key)!;
        const was = only(key, asFormat2(c), 1, 0, 6);
        const now = (minor: number, version: number): Side => only(key, asFormat3(c), 1, minor, version);
        const untouched = judge(was, now(0, 6));
        expect(untouched.rows[0], `${key}: precondition`).toMatchObject({ matched: c.streams.length, recorded: c.streams.length });
        expect(untouched.stats, `${key}: fold source frozen`).toMatchObject({ gained: 0, reason: null });
        expect(untouched.verdicts, `${key}: fold source frozen`).toBe(0);
        for (const path of [KERNEL, `src/sports/${key}/${key}.ts`, "src/stats/stats.ts", "package.json"]) {
          const j = judge(was, now(1, 6), () => [path]);
          expect(j.stats, `${key}: ${path}`).toMatchObject({ gained: c.streams.length, gainedSports: [key] });
          expect(j.stats.reason, `${key}: ${path}`).toMatch(/^STATS_FOLD_VERSION must rise: \d+ stream\(s\) /);
          expect(j.verdicts, `${key}: ${path}: the sport's minor is paid, the rise is not`).toBe(1);
          expect(judge(was, now(1, 7), () => [path]).verdicts, `${key}: ${path}: paid`).toBe(0);
        }
        streams += c.streams.length;
        checked++;
      });
      expect(checked).toBe(builtinModules.length);
      expect(streams).toBeGreaterThanOrEqual(checked);
    }, budget(8));

    it("a stats move in one stream of any sport names exactly that sport and needs the stats bump; the sport's own bumps do not pay it (counted)", () => {
      let checked = 0;
      forEachSport(({ key }) => {
        const c = asFormat3(real.get(key)!);
        const moved: GoldenCorpus = { ...c, streams: [{ ...c.streams[0]!, playerStats: MOVED }, ...c.streams.slice(1)] };
        const was = only(key, c, 1, 0, 6);
        for (const [major, minor] of [[1, 0], [1, 1], [2, 0]] as const) {
          const { stats } = judge(was, only(key, moved, major, minor, 6));
          expect(stats, `${key} ${major}.${minor}`).toMatchObject({ moved: 1, sports: [key] });
          expect(stats.reason, `${key} ${major}.${minor}`).toMatch(/^STATS_FOLD_VERSION must rise: /);
        }
        expect(judge(was, only(key, moved, 1, 1, 7)).stats.reason, `${key}: bumped`).toBeNull();
        expect(judge(was, only(key, c, 1, 0, 6)).stats, `${key}: nothing moved`).toMatchObject({ moved: 0, reason: null });
        checked++;
      });
      expect(checked).toBe(builtinModules.length);
    }, budget(6));
  });
});

// ------------------------------------------------------------------------------------------------------------------------------------
// GF-3 T2: a stream's `foldOptions` (the server-only fold input `forfeitAward`) is part of its INPUT, beside its raw config, events and
// lineups. A stream whose award changed asks for another fold, so it is a different input - removed and added, a major owed - and never
// one stream whose output moved (which would read as an ordinary state change, or, with the output equal, as nothing at all).
describe("fold-epoch guard: GF-3 T2 - a stream's foldOptions are part of its input", () => {
  const AWARD = { forfeitAward: [5, 1] } as never;
  const base = (): GoldenStream[] => [stream("std", 1), stream("std", 2, { foldOptions: AWARD })];
  const withAward = (award: unknown): GoldenStream[] => [stream("std", 1), stream("std", 2, { foldOptions: award as never })];
  const row = (v: ReturnType<typeof compareSides>) => v.map((r) => ({ matched: r.matched, changed: r.changed, removed: r.removed, added: r.added, owes: r.owes }));

  it("the empty case first: streams that carry no foldOptions on either side are matched, as ever", () => {
    expect(row(compareSides(side(1, [stream("std", 1), stream("std", 2)]), side(1, [stream("std", 1), stream("std", 2)])))).toEqual([{ matched: 2, changed: 0, removed: 0, added: 0, owes: null }]);
  });
  it("the same award on both sides is the same input: matched, owes nothing", () => {
    expect(row(compareSides(side(1, base()), side(1, base())))).toEqual([{ matched: 2, changed: 0, removed: 0, added: 0, owes: null }]);
    expect(epochViolations(side(1, base()), side(1, base()))).toEqual([]);
  });
  it("a different award is a re-recorded stream (removed AND added, not changed), which owes a MAJOR even when every recorded output is byte for byte the same", () => {
    const v = epochViolations(side(1, base()), side(1, withAward([4, 1])));
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ sport: "badminton", matched: 1, changed: 0, removed: 1, added: 1, owes: "major" });
    expect(v[0]!.reason).toMatch(/1 stream\(s\) removed or re-recorded/);
    expect(epochViolations(side(1, base()), side(2, withAward([4, 1])))).toEqual([]);
  });
  it("each number of the pair matters on its own (winner first, so a swapped award is another input)", () => {
    for (const award of [[6, 1], [5, 2], [1, 5]]) {
      expect(row(compareSides(side(1, base()), side(1, withAward({ forfeitAward: award })))), JSON.stringify(award)).toEqual([{ matched: 1, changed: 0, removed: 1, added: 1, owes: "major" }]);
    }
  });
  it("gaining an award is a re-record, and so is losing one: the stream's fold changed either way", () => {
    expect(row(compareSides(side(1, [stream("std", 1), stream("std", 2)]), side(1, base())))).toEqual([{ matched: 1, changed: 0, removed: 1, added: 1, owes: "major" }]);
    expect(row(compareSides(side(1, base()), side(1, [stream("std", 1), stream("std", 2)])))).toEqual([{ matched: 1, changed: 0, removed: 1, added: 1, owes: "major" }]);
  });
  it("an award written with its keys in another order is the same input (the order-insensitive form is asked only when the text differs)", () => {
    const wide = { forfeitAward: [5, 1], note: "x" } as never;
    const shuffled = { note: "x", forfeitAward: [5, 1] } as never;
    expect(row(compareSides(side(1, [stream("std", 2, { foldOptions: wide })]), side(1, [stream("std", 2, { foldOptions: shuffled })])))).toEqual([{ matched: 1, changed: 0, removed: 0, added: 0, owes: null }]);
  });
  it("a foldOptions that is only an empty object is not 'no foldOptions' to the input (parseCorpus refuses it; the pure rule does not guess)", () => {
    expect(row(compareSides(side(1, [stream("std", 2)]), side(1, [stream("std", 2, { foldOptions: {} as never })])))).toEqual([{ matched: 0, changed: 0, removed: 1, added: 1, owes: "major" }]);
  });

  describe("foldOptionsProblem: the shape parseCorpus accepts (two non-negative finite integers, no other key)", () => {
    const GOOD: ReadonlyArray<readonly [string, unknown]> = [
      ["an award", { forfeitAward: [5, 1] }],
      ["a 0-0 award (a score like any other)", { forfeitAward: [0, 0] }],
      ["a lopsided award", { forfeitAward: [20, 0] }],
    ];
    const BAD: ReadonlyArray<readonly [string, unknown, RegExp]> = [
      ["null", null, /not an object/],
      ["an array", [], /not an object/],
      ["a string", "forfeitAward", /not an object/],
      ["a number", 3, /not an object/],
      ["an empty object", {}, /holds no forfeitAward/],
      ["another key beside the award", { forfeitAward: [5, 1], other: 1 }, /only forfeitAward is allowed.*"other"/],
      ["another key INSTEAD of the award", { strictFromSeq: 0 }, /only forfeitAward is allowed.*"strictFromSeq"/],
      ["an undefined award", { forfeitAward: undefined }, /holds no forfeitAward/],
      ["an award that is not an array", { forfeitAward: "5-1" }, /pair/],
      ["an award that is an object with index keys", { forfeitAward: { 0: 5, 1: 1, length: 2 } }, /pair/],
      ["a one-number award", { forfeitAward: [5] }, /pair/],
      ["a three-number award", { forfeitAward: [5, 1, 0] }, /pair/],
      ["a negative number", { forfeitAward: [-1, 2] }, /non-negative/],
      ["a fraction", { forfeitAward: [1.5, 2] }, /integer/],
      ["a number that parses to Infinity", JSON.parse('{"forfeitAward":[1e999,0]}') as unknown, /integer/],
      ["a numeric string", { forfeitAward: ["5", 1] }, /integer/],
      ["a null", { forfeitAward: [null, 1] }, /integer/],
      ["NaN", { forfeitAward: [Number.NaN, 1] }, /integer/],
    ];
    /** The rule's answer, or "accepted"; a rule that THROWS on a shape reads as "threw ...", so a crash is a wrong answer and an assertion failure. */
    const verdict = (value: unknown): string => {
      try {
        return foldOptionsProblem(value) ?? "accepted";
      } catch (error) {
        return `threw ${String(error)}`;
      }
    };
    it("accepts the shapes the recorder writes", () => {
      for (const [label, value] of GOOD) expect(verdict(value), label).toBe("accepted");
      expect(GOOD.length).toBeGreaterThan(0);
    });
    it("refuses everything else, naming what is wrong", () => {
      for (const [label, value, why] of BAD) expect(verdict(value), label).toMatch(why);
      expect(BAD.length).toBeGreaterThanOrEqual(15);
    });
  });

  describe("over every registered sport's real golden corpus", () => {
    const real = new Map<string, GoldenCorpus>();
    beforeAll(() => { forEachSport(({ key }) => { real.set(key, readCorpus(key)); }); }, treeBudget(builtinModules.length));
    const only = (key: string, c: GoldenCorpus, epoch = 1): Side => ({ epochs: { [key]: epoch }, corpora: { [key]: c } });
    const budget = (steps: number) => treeBudget(builtinModules.length, steps);
    /** The sports whose corpus records an award: the engine's own declaration says which should (they read it), the corpus says which do. */
    const awardStreams = (c: GoldenCorpus): GoldenStream[] => c.streams.filter((s) => s.foldOptions !== undefined);
    const swap = (c: GoldenCorpus, i: number, over: Partial<GoldenStream>): GoldenCorpus => ({ ...c, streams: c.streams.map((s, at) => (at === i ? { ...s, ...over } : s)) });

    it("every recorded foldOptions passes the guard's own shape check, and exactly the sports that declare awardScoreKeys record any (counted)", () => {
      let sports = 0;
      let withOptions = 0;
      let readers = 0;
      forEachSport(({ module, key }) => {
        const found = awardStreams(real.get(key)!);
        for (const s of found) expect(foldOptionsProblem(s.foldOptions), `${key} ${s.config}#${s.seed}`).toBeNull();
        if (module.awardScoreKeys === undefined) expect(found, `${key} reads no award, so no stream offers it one`).toEqual([]);
        else {
          expect(found.length, `${key} reads the award, so its corpus offers it`).toBeGreaterThanOrEqual(3);
          readers++;
        }
        withOptions += found.length;
        sports++;
      });
      expect(sports).toBe(builtinModules.length);
      expect(readers, "the reading sports exist").toBeGreaterThanOrEqual(4);
      expect(withOptions, "and between them record award streams").toBeGreaterThanOrEqual(readers * 3);
    }, budget(2));

    it("changing, losing or swapping the award of any real award stream names exactly that sport and owes its major; the sport's own bump alone pays it (counted)", () => {
      let checked = 0;
      let variants = 0;
      forEachSport(({ key }) => {
        const c = real.get(key)!;
        const at = c.streams.findIndex((s) => s.foldOptions !== undefined);
        if (at === -1) return;
        const [winner, loser] = c.streams[at]!.foldOptions!.forfeitAward;
        const changes: Array<readonly [string, Partial<GoldenStream>]> = [
          ["winner's number moved", { foldOptions: { forfeitAward: [winner + 1, loser] } }],
          ["loser's number moved", { foldOptions: { forfeitAward: [winner, loser + 1] } }],
          ["the pair swapped", { foldOptions: { forfeitAward: [loser, winner] } }],
          ["the award dropped", { foldOptions: undefined }],
        ];
        for (const [what, over] of changes) {
          const edited = swap(c, at, over);
          const v = epochViolations(only(key, c), only(key, edited));
          expect(v.map((x) => x.sport), `${key}: ${what}`).toEqual([key]);
          expect(v[0], `${key}: ${what}`).toMatchObject({ matched: c.streams.length - 1, changed: 0, removed: 1, added: 1, owes: "major" });
          expect(epochViolations(only(key, c), only(key, edited, 2)), `${key}: ${what}, bumped`).toEqual([]);
          variants++;
        }
        // the control: an unchanged award is the same input
        expect(epochViolations(only(key, c), only(key, swap(c, at, { foldOptions: { forfeitAward: [winner, loser] } }))), `${key}: unchanged`).toEqual([]);
        checked++;
      });
      expect(checked, "every reading sport was edited").toBeGreaterThanOrEqual(4);
      expect(variants).toBe(checked * 4);
    }, budget(10));

    it("adding an award stream owes nothing (an appended stream is not a re-record), and the corpus without its award streams is the baseline of that add (counted)", () => {
      let checked = 0;
      forEachSport(({ key }) => {
        const c = real.get(key)!;
        const found = awardStreams(c);
        if (found.length === 0) return;
        const baseline: GoldenCorpus = { ...c, streams: c.streams.filter((s) => s.foldOptions === undefined) };
        expect(baseline.streams.length, `${key}: the award streams are the appended ones`).toBe(c.streams.length - found.length);
        expect(epochViolations(only(key, baseline), only(key, c)), `${key}: added streams owe nothing`).toEqual([]);
        expect(compareSides(only(key, baseline), only(key, c))[0], key).toMatchObject({ added: found.length, removed: 0, changed: 0 });
        checked++;
      });
      expect(checked).toBeGreaterThanOrEqual(4);
    }, budget(4));
  });
});
