// Engine-split Task 1e-2 (D15, D26): the fold-epoch guard's RULE, tested as the pure function it is. The CLI around it (git, the temp import of
// the baseline's table, exit codes) is spawned against real git history in fold-epoch-guard-cli.test.ts, which imports nothing under src/ so
// that a Stryker related-mode run of a sport file never runs its spawns.
//
// Fixtures are built on the real GoldenCorpus/GoldenStream interfaces, and every sweep over the sports takes the list from the registry and
// reports how many it visited (TEST-STRATEGY rule 2): zero visited is a failure, never a pass.
import { beforeAll, describe, expect, it } from "vitest";
import { epochViolations, compareSides, GuardRefusal, type Side } from "../scripts/fold-epoch-guard.ts";
import { builtinModules } from "../src/sports/index.ts";
import { forEachSport } from "../src/testkit/for-each-sport.ts";
import { readCorpus, type GoldenCorpus, type GoldenStream } from "../src/testkit/golden.ts";
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
      { sport: "badminton", matched: 2, changed: 1, deltasOnly: 0, removed: 1, added: 1, before: 1, after: 1, beforeMinor: 0, afterMinor: 0, owes: "major", reason: expect.stringMatching(/1 stream\(s\) fold differently.*1 stream\(s\) removed or re-recorded.*did not rise \(1 -> 1\)/) },
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
