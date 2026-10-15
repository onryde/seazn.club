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
const corpus = (streams: GoldenStream[], key = "badminton"): GoldenCorpus =>
  ({ key, version: "1.0.0", configs: {}, streams, recordedBy: "test", params: {} }) as unknown as GoldenCorpus;
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
      { sport: "badminton", matched: 2, changed: 1, removed: 1, added: 1, before: 1, after: 1, reason: expect.stringMatching(/1 stream\(s\) fold differently.*1 stream\(s\) removed or re-recorded.*did not rise \(1 -> 1\)/) },
    ]);
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
        expect(v[0], `${key}: ${field} moved`).toMatchObject({ matched: c.streams.length, changed: 1, removed: 0, added: 0 });
        expect(epochViolations(only(key, c), only(key, moved, 2)), `${key}: ${field} moved and bumped`).toEqual([]);
        checked++;
      }
    });
    expect(checked).toBe(builtinModules.length * FIELDS.length);
  }, budget(FIELDS.length * 2));

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
