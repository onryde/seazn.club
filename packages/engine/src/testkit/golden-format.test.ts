// GF-2 T1 — corpus FORMAT 2 and the REFORMAT_GOLDEN write mode (design §2, §3 last bullet).
//
// REFORMAT is the one write mode that is NOT a re-baseline: it adds the two format-2 fields to every stream and proves, as it
// goes, that nothing the corpus already holds would move. Everything below states a rule of that and then tries to break it.
// No committed corpus is written by any test here; reformatted corpora are built in memory.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { resolvePositions } from "../sport/catalog.ts";
import type { AnySportModule } from "../sport/module.ts";
import { builtinModules } from "../sports/index.ts";
import { forEachSport } from "./for-each-sport.ts";
import { sweepBudget } from "./golden-budget.ts";
import {
  FLOOR_SEED_STRIDE,
  extendFloor,
} from "./golden-floor-streams.ts";
import {
  CURRENT_FORMAT,
  GUARDED_WRITE_MODES,
  buildCorpus,
  REFORMAT_GOLDEN,
  corpusWriteRefusal,
  corpusWriteVerdict,
  corpusFormat,
  corpusStateDiff,
  extendCorpus,
  formatCorpusStateDiff,
  guardedWriteModes,
  overlayMismatch,
  readCorpus,
  rebaselineCorpus,
  recomputeKernel,
  recomputeStats,
  recomputeStream,
  storedFields,
  verifyStream,
  writeRefusal,
  type CorpusFormat,
  type GoldenCorpus,
  type WriteGateProbes,
  type GoldenEvent,
  type GoldenStream,
} from "./golden.ts";
import { BRANCH_STORIES } from "./golden-branches.ts";
import { asFormatOne, reformatAll, reformatCorpus } from "./golden-reformat.ts";
import { defaultLineupPair } from "./helpers.ts";

const sport = (key: string): AnySportModule => builtinModules.find((m) => m.key === key)!;
const ev = (type: string, payload: unknown = {}): GoldenEvent => ({ type, payload });
const bytesOf = (corpus: GoldenCorpus): string => `${JSON.stringify(corpus, null, 0)}\n`;

/** The committed corpus as FORMAT 1: the same bytes whether the file on disk is still format 1 or already format 2. Everything
 *  below that reasons about "what a reformat does to a format-1 corpus" starts here, so these tests do not change meaning the
 *  day the corpora are reformatted. */
const formatOneOf = (key: string): GoldenCorpus => asFormatOne(readCorpus(key));

/** The streams a FORMAT-1 recording reproduces. Format 1 records the module's own outcome, and a settle is laid over it by the kernel
 *  (the effective outcome is a win, the module's is a draw or nothing): since GF-2 T3 the committed corpora hold such a stream in every
 *  sport, and `formatOneOf` keeps its effective outcome, which no format-1 recorder would write. W2c's award+expunge branch streams are
 *  the other such shape (the module answers the award, the expunge makes the effective outcome none). A rebaseline of "a format-1 corpus"
 *  is about the corpora a format-1 recorder could have written, so the streams it could not are set aside, by what they are (the
 *  recorder disagrees with the stored outcome), never by a seed or a name. */
const formatOneRecordable = (key: string): { corpus: GoldenCorpus; setAside: GoldenStream[] } => {
  const module = sport(key);
  const one = formatOneOf(key);
  const reproduces = (s: GoldenStream): boolean => recomputeStream(module, one.configs[s.config], s.events, s.lineups, 1).outcome === s.outcome;
  return { corpus: { ...one, streams: one.streams.filter(reproduces) }, setAside: one.streams.filter((s) => !reproduces(s)) };
};

// ------------------------------------------------------------------------------------------------ the format marker

describe("corpusFormat", () => {
  it("absent is 1, 1, 2 and 3 are themselves, anything else is refused (a typo cannot read as format 1)", () => {
    expect(corpusFormat({})).toBe(1);
    expect(corpusFormat({ format: 1 })).toBe(1);
    expect(corpusFormat({ format: 2 })).toBe(2);
    expect(corpusFormat({ format: 3 })).toBe(3);
    for (const bad of [0, 4, "2", null, true]) {
      expect(() => corpusFormat({ format: bad as never }), JSON.stringify(bad)).toThrow(/unknown golden corpus format/);
    }
  });

  it("every committed corpus declares a valid format and carries exactly the fields that format owns (counted)", () => {
    let checked = 0;
    let streams = 0;
    const formats = new Set<number>();
    forEachSport(({ key }) => {
      const corpus = readCorpus(key);
      const format = corpusFormat(corpus);
      formats.add(format);
      expect("format" in corpus, key).toBe(format >= 2);
      for (const stream of corpus.streams) {
        const label = `${key} ${stream.config}#${stream.seed}`;
        expect("summaries" in stream, label).toBe(format >= 2);
        expect("overlay" in stream, label).toBe(format >= 2);
        expect("playerStats" in stream, label).toBe(format === 3);
        streams++;
      }
      checked++;
    });
    expect(checked).toBe(builtinModules.length);
    expect(streams).toBeGreaterThan(0);
    // one format per tree: a half-reformatted tree is not a state anyone reviews (REFORMAT is all sports or none)
    expect(formats.size, `committed corpora mix formats: ${[...formats].join(",")}`).toBe(1);
  });

  it("recomputeStream has no default format: five required parameters (a silent default 1 once let a caller record the wrong format)", () => {
    // `Function.length` stops at the first defaulted parameter, so a restored `format = 1` reads 4 here
    expect(recomputeStream.length).toBe(5);
  });

  it("formatOneOf is a format-1 corpus whichever format is committed, and drops nothing else", () => {
    let checked = 0;
    forEachSport(({ key }) => {
      const committed = readCorpus(key);
      const one = formatOneOf(key);
      expect(corpusFormat(one), key).toBe(1);
      expect("format" in one, key).toBe(false);
      expect(one.streams.length, key).toBe(committed.streams.length);
      one.streams.forEach((was, i) => {
        const now = committed.streams[i]!;
        expect(Object.keys(was), `${key} #${i}`).toEqual(Object.keys(now).filter((k) => k !== "summaries" && k !== "overlay" && k !== "playerStats"));
        expect(JSON.stringify(was.states), `${key} #${i}`).toBe(JSON.stringify(now.states));
      });
      checked++;
    });
    expect(checked).toBe(builtinModules.length);
  });
});

// ------------------------------------------------------------------------------------------------ the write modes

describe("guarded write modes — REFORMAT_GOLDEN shares REBASELINE's dirty-tree refusal", () => {
  it("UPDATE, REBASELINE and REFORMAT are guarded; EXTEND (append only), an unset or non-'1' value are not", () => {
    expect([...GUARDED_WRITE_MODES]).toEqual(["UPDATE_GOLDEN", "REBASELINE_GOLDEN", "REFORMAT_GOLDEN"]);
    let checked = 0;
    for (const mode of GUARDED_WRITE_MODES) {
      expect(guardedWriteModes({ [mode]: "1" }), mode).toEqual([mode]);
      expect(guardedWriteModes({ [mode]: "0" }), `${mode}=0`).toEqual([]);
      expect(guardedWriteModes({ [mode]: "true" }), `${mode}=true`).toEqual([]);
      checked++;
    }
    expect(checked).toBe(3);
    expect(guardedWriteModes({})).toEqual([]);
    expect(guardedWriteModes({ EXTEND_GOLDEN: "1" })).toEqual([]);
    expect(guardedWriteModes({ UPDATE_GOLDEN: "1", REFORMAT_GOLDEN: "1" })).toEqual(["UPDATE_GOLDEN", "REFORMAT_GOLDEN"]);
  });

  it("REFORMAT_GOLDEN is off in a normal run (this suite would otherwise be rewriting corpora)", () => {
    expect(REFORMAT_GOLDEN).toBe(false);
  });
});

describe("writeRefusal — the gate golden.test.ts runs before any guarded write mode (pure: env, porcelain, writable paths)", () => {
  const writable = ["packages/engine/src/sports/generic/generic.golden.json"];
  const dirty = [" M packages/engine/src/sports/generic/generic.ts"];
  const corpusOnly = [" M packages/engine/src/sports/generic/generic.golden.json"];

  it("the same dirty tree is refused by EVERY guarded mode, and by no run that asks for none (counted)", () => {
    // the control: this tree really is dirty, so a null below is the mode check speaking and not an accident of the fixture
    expect(corpusWriteVerdict(dirty, writable).ok).toBe(false);
    let refused = 0;
    for (const mode of GUARDED_WRITE_MODES) {
      const reason = writeRefusal({ [mode]: "1" }, dirty, writable);
      expect(reason, mode).toMatch(/refusing to rewrite the golden corpus/);
      expect(reason, mode).toContain("packages/engine/src/sports/generic/generic.ts");
      refused++;
    }
    expect(refused).toBe(GUARDED_WRITE_MODES.length);
    expect(refused).toBe(3);
    // REFORMAT is the mode a hand-copied `UPDATE || REBASELINE` pair would leave unguarded: it is named on its own
    expect(writeRefusal({ REFORMAT_GOLDEN: "1" }, dirty, writable)).not.toBeNull();
    // no guarded mode on: nothing to refuse, however dirty the tree (EXTEND only ever appends and is deliberately not guarded)
    for (const env of [{}, { EXTEND_GOLDEN: "1" }, { REFORMAT_GOLDEN: "0" }, { REBASELINE_GOLDEN: "true" }]) {
      expect(writeRefusal(env, dirty, writable), JSON.stringify(env)).toBeNull();
    }
  });

  it("a guarded mode runs from a tree holding only corpus changes or nothing, and fails closed outside a git checkout", () => {
    for (const mode of GUARDED_WRITE_MODES) {
      expect(writeRefusal({ [mode]: "1" }, corpusOnly, writable), `${mode} corpus-only tree`).toBeNull();
      expect(writeRefusal({ [mode]: "1" }, [], writable), `${mode} clean tree`).toBeNull();
      expect(writeRefusal({ [mode]: "1" }, null, []), `${mode} not a checkout`).toMatch(/not a git checkout/);
    }
    // not a checkout is only a problem when a mode asks to write
    expect(writeRefusal({}, null, [])).toBeNull();
  });

  it("the real-environment wrapper asks git only when a guarded mode is on (a plain run never shells out to git)", () => {
    const explode: WriteGateProbes = {
      repoRoot: () => { throw new Error("git was asked"); },
      porcelain: () => { throw new Error("git was asked"); },
      writablePaths: () => { throw new Error("git was asked"); },
    };
    for (const env of [{}, { EXTEND_GOLDEN: "1" }, { REFORMAT_GOLDEN: "0" }]) expect(corpusWriteRefusal(env, explode), JSON.stringify(env)).toBeNull();
    expect(corpusWriteRefusal({})).toBeNull();
  });

  it("the guarded branch of the wrapper: a dirty tree refuses every guarded mode, a clean or corpus-only tree lets it run, no checkout fails closed", () => {
    const calls = { root: 0, porcelain: 0, writable: 0 };
    const probesFor = (root: string | null, porcelain: string[] | null): WriteGateProbes => ({
      repoRoot: () => { calls.root++; return root; },
      porcelain: () => { calls.porcelain++; return porcelain; },
      writablePaths: () => { calls.writable++; return ["packages/engine/src/sports/generic/generic.golden.json"]; },
    });
    let refused = 0;
    for (const mode of GUARDED_WRITE_MODES) {
      const dirty = probesFor("/repo", [" M packages/engine/src/core/events.ts"]);
      const reason = corpusWriteRefusal({ [mode]: "1" }, dirty);
      expect(reason, `${mode}: a dirty tree`).toMatch(/refusing to rewrite the golden corpus/);
      expect(reason, mode).toContain("packages/engine/src/core/events.ts");
      refused++;
      expect(corpusWriteRefusal({ [mode]: "1" }, probesFor("/repo", [])), `${mode}: a clean tree`).toBeNull();
      expect(corpusWriteRefusal({ [mode]: "1" }, probesFor("/repo", [" M packages/engine/src/sports/generic/generic.golden.json"])), `${mode}: corpus files only`).toBeNull();
      expect(corpusWriteRefusal({ [mode]: "1" }, probesFor(null, null)), `${mode}: not a checkout`).toMatch(/not a git checkout/);
      expect(corpusWriteRefusal({ [mode]: "1" }, probesFor("/repo", null)), `${mode}: git could not say`).toMatch(/not a git checkout/);
    }
    expect(refused).toBe(GUARDED_WRITE_MODES.length);
    expect(calls.root, "the root was asked for on every guarded run").toBe(GUARDED_WRITE_MODES.length * 5);
    // the same dirty tree with the mode OFF: not asked, not refused
    const before = { ...calls };
    expect(corpusWriteRefusal({}, probesFor("/repo", [" M packages/engine/src/core/events.ts"]))).toBeNull();
    expect(calls).toEqual(before);
  });
});

// ----------------------------------------------------------------------------------------------------- REFORMAT

/** One reformatted corpus per sport, built once: the registry sweep below and the tamper tests both read it. */
const reformatted = new Map<string, GoldenCorpus>();
const reformattedOf = (key: string): GoldenCorpus => {
  let corpus = reformatted.get(key);
  if (corpus === undefined) {
    corpus = reformatCorpus(sport(key), formatOneOf(key), 2);
    reformatted.set(key, corpus);
  }
  return corpus;
};

describe("reformatCorpus — adds the format-2 fields and moves nothing the corpus already holds", () => {
  let streamsSeen = 0;
  let stepsSeen = 0;
  for (const module of builtinModules) {
    it(`${module.key}: every pre-existing field byte-identical, the new fields last, format before streams, a second run a no-op`, () => {
      const before = formatOneOf(module.key);
      const after = reformattedOf(module.key);
      expect(corpusFormat(after)).toBe(2);
      // corpus level: the same keys in the same order with `format` slotted in just before `streams`, which stays LAST
      expect(Object.keys(after)).toEqual([...Object.keys(before).filter((k) => k !== "streams"), "format", "streams"]);
      for (const key of Object.keys(before).filter((k) => k !== "streams")) {
        expect(JSON.stringify((after as unknown as Record<string, unknown>)[key]), `${module.key} ${key}`).toBe(JSON.stringify((before as unknown as Record<string, unknown>)[key]));
      }
      // stream level: same count, same order, every old field byte-identical, the two new ones appended
      expect(after.streams.length).toBe(before.streams.length);
      before.streams.forEach((was, i) => {
        const now = after.streams[i]!;
        expect(Object.keys(now), `${module.key} #${i}`).toEqual([...Object.keys(was), "summaries", "overlay"]);
        for (const key of Object.keys(was) as (keyof GoldenStream)[]) {
          expect(JSON.stringify(now[key]), `${module.key} #${i} ${key}`).toBe(JSON.stringify(was[key]));
        }
        expect(now.summaries!.length, `${module.key} #${i}`).toBe(was.events.length);
        stepsSeen += was.events.length;
        streamsSeen++;
      });
      expect(after.streams.length).toBeGreaterThan(0);
      // idempotent: a second run reproduces the file byte for byte (and verifies the corpus on the way — see the refusals below)
      const again = reformatCorpus(module, after, 2);
      expect(bytesOf(again)).toBe(bytesOf(after));
      // the written file is the committed one plus the new fields: strictly longer, and every old byte is still there
      expect(bytesOf(after).length).toBeGreaterThan(bytesOf(before).length);
    }, sweepBudget("probe", 2)); // cricket, the heaviest, measured 2.5-2.9 s: one unit left it at a third of the budget
  }

  it("the sweep covered every sport and a non-trivial number of streams and steps", () => {
    expect(streamsSeen).toBe(builtinModules.reduce((n, m) => n + readCorpus(m.key).streams.length, 0));
    expect(stepsSeen).toBeGreaterThan(streamsSeen);
  });

  it("a reformatted stream replays green under the format-2 verifier (summaries, overlay and the four old fields)", () => {
    const module = sport("generic");
    const corpus = reformattedOf("generic");
    let verified = 0;
    for (const stream of corpus.streams) {
      expect(verifyStream(module, corpus, stream), `${stream.config}#${stream.seed}`).toEqual([]);
      verified++;
    }
    expect(verified).toBeGreaterThan(0);
  });
});

describe("reformatAll — all sports or none: one refusal writes nothing", () => {
  it("every sport reformats: one plan entry per module, each the same corpus reformatCorpus gives on its own", () => {
    const plan = reformatAll([sport("generic")], formatOneOf, 2);
    expect(plan.length).toBe(1);
    expect(plan[0]!.module.key).toBe("generic");
    expect(bytesOf(plan[0]!.after)).toBe(bytesOf(reformattedOf("generic")));
    expect(corpusFormat(plan[0]!.before)).toBe(1);
  }, sweepBudget("probe", 2));

  it("one sport refusing throws for the whole run and names it: the sports that DID reformat are never handed out to be written", () => {
    const tampered = (c: GoldenCorpus): GoldenCorpus => ({ ...c, streams: [{ ...c.streams[0]!, outcome: `{"kind":"draw"}` }, ...c.streams.slice(1)] });
    const read = (key: string): GoldenCorpus => (key === "carrom" ? tampered(formatOneOf(key)) : formatOneOf(key));
    let thrown: Error | undefined;
    try {
      reformatAll([sport("generic"), sport("carrom")], read, 2);
    } catch (error) {
      thrown = error as Error;
    }
    expect(thrown, "a refusal in the second sport must throw, not return the first").toBeDefined();
    expect(thrown!.message).toMatch(/wrote nothing: 1 of 2 sport\(s\) refused/);
    expect(thrown!.message).toContain("carrom config=");
    expect(thrown!.message).not.toContain("generic config=");
  }, sweepBudget("probe", 2));

  it("every refusing sport is named, not only the first", () => {
    const tampered = (c: GoldenCorpus): GoldenCorpus => ({ ...c, streams: [{ ...c.streams[0]!, outcome: `{"kind":"draw"}` }, ...c.streams.slice(1)] });
    expect(() => reformatAll([sport("carrom"), sport("volleyball")], (key) => tampered(formatOneOf(key)), 2)).toThrow(/2 of 2 sport\(s\) refused[\s\S]*carrom config=[\s\S]*volleyball config=/);
  }, sweepBudget("probe", 2));

  it("an empty module list is refused (a reformat of nothing proves nothing)", () => {
    expect(() => reformatAll([], formatOneOf, 2)).toThrow(/no sport to reformat/);
  });
});

describe("reformatCorpus — it is NEVER a re-baseline: it refuses when anything already recorded would change", () => {
  const module = sport("generic");
  const corpus1 = formatOneOf("generic");
  const cfgName = Object.keys(corpus1.configs)[0]!;
  const raw = corpus1.configs[cfgName];
  const withStream = (stream: GoldenStream): GoldenCorpus => ({ ...corpus1, streams: [...corpus1.streams, stream] });
  const tamperFirst = (patch: Partial<GoldenStream>): GoldenCorpus => ({ ...corpus1, streams: [{ ...corpus1.streams[0]!, ...patch }, ...corpus1.streams.slice(1)] });

  /** The message of a refusal, or a failure of the test if there was none. */
  const refusalOf = (run: () => unknown): string => {
    try {
      run();
    } catch (error) {
      return (error as Error).message;
    }
    throw new Error("expected a refusal, and the reformat went through");
  };

  it("a stream recorded under format 1 whose EFFECTIVE outcome differs from the module's (a settle): refused, naming the route that works, not a re-baseline that would record the module's answer again", () => {
    const { home } = defaultLineupPair(resolvePositions(module, module.configSchema.parse(raw)));
    const events = [ev("core.start"), ev("core.abandon", { reason: "rain" }), ev("core.settle", { winner: home.entrantId, method: "organiser" })];
    const legacy: GoldenStream = { config: cfgName, seed: 99_999, events, ...storedFields(recomputeStream(module, raw, events, undefined, 1)) };
    expect(legacy.outcome, "precondition: format 1 recorded the module's bare outcome").toBe("null");
    // the stream is a good FORMAT-1 stream: every byte of it replays under format 1, so a format-1 re-baseline would write the same bytes
    expect(verifyStream(module, withStream(legacy), legacy), "precondition: a format-1 re-baseline leaves this stream as it is").toEqual([]);
    const refusal = refusalOf(() => reformatCorpus(module, withStream(legacy), 2));
    expect(refusal).toMatch(/generic config=\w+ seed=99999 outcome: recorded null, replayed .*settled_organiser/s);
    expect(refusal).toMatch(/cannot be reformatted/);
    expect(refusal).toMatch(/A re-baseline cannot help/);
    expect(refusal).toMatch(/format-3 corpus on main/);
    expect(refusal).toContain("EXTEND_GOLDEN=1");
    expect(refusal, "the advice that cannot work is not given").not.toMatch(/that is a re-baseline, not a reformat/);
  });

  describe("the reformat dead end (GF-2 batch review I-1): every class of stream the kernel lays an answer over", () => {
    interface Row { name: string; sport: string; raw: unknown; events: (lines: { home: { entrantId: string }; away: { entrantId: string } }) => GoldenEvent[] }
    const ROWS: readonly Row[] = [
      { name: "a settle", sport: "generic", raw: { resultMode: "score", allowDraws: true }, events: ({ home }) => [ev("core.start"), ev("core.abandon", { reason: "rain" }), ev("core.settle", { winner: home.entrantId, method: "organiser" })] },
      { name: "an expunge where the module still answers", sport: "football", raw: { abandonPolicy: "award" }, events: () => [ev("core.start"), ev("core.abandon", { reason: "x", expunge: true })] },
      { name: "a withdrawal over a held level result", sport: "generic", raw: { resultMode: "score", allowDraws: true }, events: ({ away }) => [ev("core.start"), ev("generic.result", { p1Score: 1, p2Score: 1 }), ev("core.forfeit", { by: away.entrantId, reason: "withdrew" })] },
    ];
    const synthetic = (row: Row, seed: number): { m: AnySportModule; corpus: GoldenCorpus; stream: GoldenStream } => {
      const m = sport(row.sport);
      const base = formatOneOf(row.sport);
      const lines = defaultLineupPair(resolvePositions(m, m.configSchema.parse(row.raw)));
      const events = row.events(lines);
      const stream: GoldenStream = { config: "synthetic", seed, events, ...storedFields(recomputeStream(m, row.raw, events, undefined, 1)) };
      return { m, corpus: { ...base, configs: { ...base.configs, synthetic: row.raw }, streams: [...base.streams, stream] }, stream };
    };

    it("each is a valid format-1 stream whose effective answer differs, and each reformat is refused with the route, never the re-baseline advice (counted, three classes)", () => {
      let checked = 0;
      ROWS.forEach((row, i) => {
        const { m, corpus, stream } = synthetic(row, 99_900 + i);
        // the class: format 1 stores the module's answer, the kernel's effective answer differs, and format 1 replays clean
        expect(verifyStream(m, corpus, stream), `${row.name}: a valid format-1 stream`).toEqual([]);
        const effective = recomputeStream(m, corpus.configs.synthetic, stream.events, undefined, 2);
        expect(effective.outcome !== stream.outcome || effective.summary !== stream.summary || effective.deltas !== stream.deltas, `${row.name}: the effective answer differs from the module's`).toBe(true);
        const refusal = refusalOf(() => reformatCorpus(m, corpus, 2));
        expect(refusal, row.name).toContain(`${row.sport} config=synthetic seed=${99_900 + i}`);
        expect(refusal, row.name).toMatch(/cannot be reformatted/);
        expect(refusal, row.name).toMatch(/: 1 stream\(s\) record the module's own outcome/);
        expect(refusal, row.name).toContain("EXTEND_GOLDEN=1");
        expect(refusal, row.name).not.toMatch(/that is a re-baseline, not a reformat/);
        // and target 3 reads the same format-1 corpus the same way
        expect(refusalOf(() => reformatCorpus(m, corpus, 3)), `${row.name} -> 3`).toContain("EXTEND_GOLDEN=1");
        checked++;
      });
      expect(checked).toBe(3);
    });

    it("the refusal's pointer lands: GOLDEN-POLICY.md holds the paragraph the message cites, and it names the route", () => {
      const row = ROWS[0]!;
      const { m, corpus } = synthetic(row, 99_900);
      const cited = /GOLDEN-POLICY\.md, "([^"]+)"/.exec(refusalOf(() => reformatCorpus(m, corpus, 2)))?.[1];
      expect(cited, "the refusal cites a policy section").toBeDefined();
      const policy = readFileSync(join(import.meta.dirname, "GOLDEN-POLICY.md"), "utf8");
      const at = policy.indexOf(`**${cited}.**`);
      expect(at, `the policy has a paragraph called "${cited}"`).toBeGreaterThanOrEqual(0);
      const paragraph = policy.slice(at, policy.indexOf("\n\n", at));
      expect(paragraph).toContain("format-3 corpus on main");
      expect(paragraph).toContain("EXTEND_GOLDEN=1");
    });

    it("reformatAll carries the route through: the run writes nothing and the message still names it", () => {
      const row = ROWS[0]!;
      const { corpus } = synthetic(row, 99_900);
      const thrown = refusalOf(() => reformatAll([sport(row.sport)], () => corpus, 2));
      expect(thrown).toMatch(/wrote nothing: 1 of 1 sport\(s\) refused/);
      expect(thrown).toContain("EXTEND_GOLDEN=1");
    });

    it("a STALE format-1 field (the module's answer moved) is still a re-baseline, with no route advice: the two refusals are told apart", () => {
      const stale = refusalOf(() => reformatCorpus(module, tamperFirst({ outcome: `{"kind":"draw"}` }), 2));
      expect(stale).toMatch(/that is a re-baseline, not a reformat/);
      expect(stale).toMatch(/outcome: recorded/);
      expect(stale).not.toMatch(/cannot be reformatted/);
      expect(stale).not.toContain("EXTEND_GOLDEN");
    });

    it("both in one corpus: the stale stream is told to re-baseline, the effective-answer stream to start from main, each under its own advice", () => {
      const row = ROWS[0]!;
      const { m, corpus, stream } = synthetic(row, 99_900);
      const first = corpus.streams[0]!;
      const both: GoldenCorpus = { ...corpus, streams: [{ ...first, outcome: `{"kind":"draw"}` }, ...corpus.streams.slice(1)] };
      const refusal = refusalOf(() => reformatCorpus(m, both, 2));
      const rebaseline = refusal.indexOf("that is a re-baseline, not a reformat");
      const route = refusal.indexOf("cannot be reformatted");
      expect(rebaseline, "the re-baseline advice is given").toBeGreaterThanOrEqual(0);
      expect(route, "the route is given").toBeGreaterThanOrEqual(0);
      const staleLabel = refusal.indexOf(`generic config=${first.config} seed=${first.seed} outcome: recorded`);
      const deadLabel = refusal.indexOf(`generic config=synthetic seed=${stream.seed}`);
      expect(staleLabel, "the stale stream is named, under the re-baseline advice").toBeGreaterThan(rebaseline);
      expect(staleLabel, "... and not under the route").toBeLessThan(route);
      expect(deadLabel, "the effective-answer stream is named, under the route").toBeGreaterThan(route);
    });
  });

  it("a stored state, outcome, summary or deltas that no longer replays: refused, naming the field", () => {
    expect(() => reformatCorpus(module, tamperFirst({ outcome: `{"kind":"draw"}` }), 2)).toThrow(/outcome: recorded/);
    expect(() => reformatCorpus(module, tamperFirst({ summary: `{"x":1}` }), 2)).toThrow(/summary: recorded/);
    expect(() => reformatCorpus(module, tamperFirst({ deltas: `{"league":[9,9],"knockout":null}` }), 2)).toThrow(/deltas: recorded/);
    const states = [...corpus1.streams[0]!.states];
    states[states.length - 1] = `{"tampered":true}`;
    expect(() => reformatCorpus(module, tamperFirst({ states }), 2)).toThrow(/state after event/);
  });

  it("a format-1 corpus that already carries a format-2 field is a hybrid: refused (absence can only mean format 1)", () => {
    expect(() => reformatCorpus(module, tamperFirst({ summaries: [] }), 2)).toThrow(/format-1 stream carries summaries\/overlay/);
    expect(() => reformatCorpus(module, tamperFirst({ overlay: "{}" }), 2)).toThrow(/format-1 stream carries summaries\/overlay/);
  });

  it("a format-2 corpus whose recorded summaries or overlay are stale is NOT a no-op: refused, never repaired", () => {
    const good = reformattedOf("generic");
    const first = good.streams[0]!;
    const stale = (patch: Partial<GoldenStream>): GoldenCorpus => ({ ...good, streams: [{ ...first, ...patch }, ...good.streams.slice(1)] });
    const flipped = [...first.summaries!];
    flipped[0] = "#0000000000000000";
    expect(() => reformatCorpus(module, stale({ summaries: flipped }), 2)).toThrow(/summary after event 0/);
    expect(() => reformatCorpus(module, stale({ overlay: `{"stoppage":[[0,{"eventId":"e-0"}]]}` }), 2)).toThrow(/overlay/);
    const { summaries: _dropped, ...withoutSummaries } = first;
    expect(() => reformatCorpus(module, { ...good, streams: [withoutSummaries as GoldenStream, ...good.streams.slice(1)] }, 2)).toThrow(/must record both summaries and overlay/);
  });

  it("an emptied corpus (no streams) is refused: a reformat of nothing proves nothing", () => {
    expect(() => reformatCorpus(module, { ...corpus1, streams: [] }, 2)).toThrow(/no streams/);
  });
});

// ------------------------------------------------------------------------------------------ verifyStream (format 2)

describe("verifyStream under format 2 — each recorded field is compared, and a missing one is a failure", () => {
  const module = sport("carrom"); // single sport: the message wiring is sport-independent; the registry sweep above covers every sport
  let corpus!: GoldenCorpus;
  let stream!: GoldenStream;
  // built in beforeAll, not at collection: a broken reformat must red the NAMED tests below, not fail the whole file to collect
  beforeAll(() => {
    corpus = reformattedOf("carrom");
    // a stream that has a non-trivial overlay (a stoppage or a squad change) so the overlay tamper below moves something real
    stream = corpus.streams.find((s) => s.overlay !== "{}" && Object.keys(JSON.parse(s.overlay!) as object).some((k) => k !== "outcome"))!;
  });
  const verify = (patch: Partial<GoldenStream>, replayed?: Parameters<typeof verifyStream>[3]) => verifyStream(module, corpus, { ...stream, ...patch }, replayed);

  it("passes untouched (the control: the tamper cases below are not redded by something else)", () => {
    expect(stream, "a carrom stream with a stoppage or squad change").toBeDefined();
    expect(verify({})).toEqual([]);
  });

  it("a moved summary digest names the step and the event type", () => {
    const summaries = [...stream.summaries!];
    const k = Math.floor(summaries.length / 2);
    summaries[k] = "#ffffffffffffffff";
    const out = verify({ summaries });
    expect(out.length).toBe(1);
    expect(out[0]).toMatch(new RegExp(`summary after event ${k} \\(${stream.events[k]!.type.replace(".", "\\.")}\\): recorded digest #f{16}`));
  });

  it("a moved overlay names the column and the first differing change point", () => {
    const overlay = JSON.parse(stream.overlay!) as Record<string, unknown[]>;
    const column = Object.keys(overlay).find((k) => k !== "outcome")!;
    const { [column]: _removed, ...rest } = overlay;
    const out = verify({ overlay: JSON.stringify(rest) });
    expect(out.length).toBe(1);
    expect(out[0]).toContain(`the kernel overlay moved in ${column} (first differing change point at step ${(overlay[column]![0] as [number, unknown])[0]}`);
  });

  it("missing fields, a wrong summary count, and a replay that produced none are failures, not 'nothing moved'", () => {
    const { summaries: _s, ...noSummaries } = stream;
    expect(verifyStream(module, corpus, noSummaries as GoldenStream)[0]).toMatch(/must record both summaries and overlay \(has no summaries, overlay\)/);
    const { overlay: _o, ...noOverlay } = stream;
    expect(verifyStream(module, corpus, noOverlay as GoldenStream)[0]).toMatch(/\(has summaries, no overlay\)/);
    expect(verify({ summaries: stream.summaries!.slice(1) }).join("\n")).toMatch(/summary digests recorded for \d+ events/);
    const four = recomputeStream(module, corpus.configs[stream.config], stream.events, stream.lineups, 1);
    // a CALLER error (replayed in the wrong format), not a finding about the corpus: it throws instead of returning a message a
    // suite that collects messages could read as clean
    expect(() => verify({}, four)).toThrow(/the replay produced no summaries\/overlay/);
    // a replay that produced the fields but the wrong number of digests (reachable only by injection: both derive from the events)
    const short = { ...four, summaries: [] as string[], overlay: "{}" };
    expect(verify({}, short).join("\n")).toMatch(/summaries: recorded \d+ digests, the replay produced 0/);
  });

  it("a format-1 corpus stream that holds a format-2 field is refused", () => {
    const committed = formatOneOf("carrom");
    const hybrid = { ...committed.streams[0]!, summaries: [] };
    expect(verifyStream(module, committed, hybrid).join("\n")).toMatch(/format-1 stream carries summaries\/overlay/);
  });

  it("overlayMismatch tells a key-order change from a moved column, and survives text that is not JSON", () => {
    expect(overlayMismatch(`{"a":[[1,2]],"b":[[1,2]]}`, `{"b":[[1,2]],"a":[[1,2]]}`)).toMatch(/no column did \(a key-order change\)/);
    expect(overlayMismatch(`{"outcome":[[1,null]]}`, `{"outcome":[[2,null]]}`)).toMatch(/outcome \(first differing change point at step 1/);
    expect(overlayMismatch("not json", "{}")).toBe("recorded not json, replayed {}");
  });
});

describe("buildCorpus (UPDATE_GOLDEN, a corpus from nothing) writes the current format", () => {
  it("generic: a current-format corpus (CURRENT_FORMAT), format before streams, every stream verified, no dense overlay stored", () => {
    // single sport: generation costs seconds per module and this checks the wiring, which is sport-independent
    const module = sport("generic");
    const corpus = buildCorpus(module);
    expect(corpusFormat(corpus)).toBe(CURRENT_FORMAT);
    expect(Object.keys(corpus).slice(-2)).toEqual(["format", "streams"]);
    expect(corpus.streams.length).toBeGreaterThan(0);
    for (const stream of corpus.streams) {
      expect(Object.keys(stream), `${stream.config}#${stream.seed}`).toEqual(expect.arrayContaining(["summaries", "overlay", ...(CURRENT_FORMAT === 3 ? ["playerStats"] : [])]));
      expect(Object.keys(stream)).not.toContain("dense");
      expect(verifyStream(module, corpus, stream), `${stream.config}#${stream.seed}`).toEqual([]);
    }
  }, sweepBudget("build", 1));
});

// ----------------------------------------------------- the other writers keep the corpus's format (rebaseline, extend)

describe("rebaselineCorpus keeps the corpus's format", () => {
  it("the streams a format-1 recording cannot reproduce are exactly those whose kernel overlay re-decides the module's outcome: the settle stories, in every sport (the settlement laid over the module's outcome), and the award+expunge branch streams (the expunge erases the award the module answered)", () => {
    let aside = 0;
    let settles = 0;
    let expunges = 0;
    forEachSport(({ key }) => {
      const module = sport(key);
      const configs = readCorpus(key).configs;
      const { corpus, setAside } = formatOneRecordable(key);
      expect(corpus.streams.length, `${key}: the rest of the corpus is a format-1 corpus`).toBeGreaterThan(0);
      const settled = setAside.filter((s) => s.events.some((e) => e.type === "core.settle"));
      expect(settled.length, `${key}: a settle story the module alone cannot record`).toBeGreaterThan(0);
      for (const s of setAside.filter((x) => !settled.includes(x))) {
        const label = `${key} ${s.config}#${s.seed}`;
        // the one other shape: a withdrawal's expunge that stands, over the result an `award` abandon policy made the module answer
        const last = s.events[s.events.length - 1]!;
        expect(last.type, label).toBe("core.abandon");
        expect((last.payload as { expunge?: unknown }).expunge, label).toBe(true);
        expect((module.configSchema.parse(configs[s.config]) as { abandonPolicy?: unknown }).abandonPolicy, label).toBe("award");
        expect(recomputeStream(module, configs[s.config], s.events, s.lineups, 1).outcome, `${label}: the module answers the award`).not.toBe("null");
        expect(s.outcome, `${label}: the recorded (effective) outcome is none`).toBe("null");
        expunges++;
      }
      settles += settled.length;
      aside += setAside.length;
    });
    // carrom has two settle stories, one per floor batch (W2c's draw-house config opened the second)
    expect(settles, "a settle story per sport at least").toBeGreaterThanOrEqual(builtinModules.length);
    expect(expunges, "one per award+expunge story in the branch table").toBe(BRANCH_STORIES.filter((story) => story.id.endsWith(".award_expunge")).length);
    expect(expunges).toBeGreaterThan(0);
    expect(aside).toBe(settles + expunges);
  }, sweepBudget("probe"));

  it("format 1 stays format 1 (no field appears), format 2 stays format 2 and re-records both fields", () => {
    const module = sport("generic");
    const one = formatOneRecordable("generic").corpus;
    const rebased1 = rebaselineCorpus(module, one);
    expect(bytesOf(rebased1)).toBe(bytesOf(one));
    expect("format" in rebased1).toBe(false);
    expect(rebased1.streams.every((s) => !("summaries" in s) && !("overlay" in s))).toBe(true);

    const two = reformattedOf("generic");
    const rebased2 = rebaselineCorpus(module, two);
    expect(bytesOf(rebased2)).toBe(bytesOf(two));
    expect(corpusFormat(rebased2)).toBe(2);
    // and it repairs: a stale digest in a format-2 corpus is re-recorded by a re-baseline (the diff then names it)
    const stale: GoldenCorpus = { ...two, streams: [{ ...two.streams[0]!, summaries: two.streams[0]!.summaries!.map(() => "#0000000000000000") }, ...two.streams.slice(1)] };
    const fixed = rebaselineCorpus(module, stale);
    expect(fixed.streams[0]!.summaries).toEqual(two.streams[0]!.summaries);
    const diff = corpusStateDiff(stale, fixed, module);
    expect(diff.streams[0]!.summaryStepsMoved.length).toBe(two.streams[0]!.events.length);
  });
});

describe("extendCorpus and extendFloor append in the corpus's format", () => {
  const key = "badminton"; // the sport golden-slim's extend test already uses: small, with a generator walk to drop
  const module = sport(key);
  const walks = (c: GoldenCorpus): GoldenStream[] => c.streams.filter((s) => s.seed < FLOOR_SEED_STRIDE);

  it("extendCorpus: a format-2 corpus gets format-2 streams, a format-1 corpus gets format-1 streams, and each verifies", () => {
    let appendedTotal = 0;
    for (const base of [formatOneOf(key), reformattedOf(key)]) {
      const dropped = walks(base).at(-1)!;
      const trimmed: GoldenCorpus = { ...base, streams: base.streams.filter((s) => s !== dropped) };
      const { corpus, appended } = extendCorpus(module, trimmed);
      expect(appended.length, `${key} format ${corpusFormat(base)}: nothing appended, so this proves nothing`).toBeGreaterThan(0);
      const fresh = corpus.streams.slice(trimmed.streams.length);
      for (const stream of fresh) {
        expect("summaries" in stream && "overlay" in stream, `format ${corpusFormat(base)}`).toBe(corpusFormat(base) >= 2);
        expect(Object.keys(stream).includes("dense"), "the dense overlay is never stored").toBe(false);
        expect(verifyStream(module, corpus, stream), `${stream.config}#${stream.seed}`).toEqual([]);
      }
      expect(corpus.streams.slice(0, trimmed.streams.length)).toEqual(trimmed.streams);
      appendedTotal += fresh.length;
    }
    expect(appendedTotal).toBeGreaterThanOrEqual(2);
  // two bases, each a generator walk; the pair measured 8-12 s isolated, so 5 units of build work keep the budget at 3x or more of that
  }, sweepBudget("build", 5));

  it("extendFloor: from a format-2 corpus without its floor streams, it reproduces the committed floor streams WITH the new fields", () => {
    const committed2 = reformattedOf(key);
    const first = committed2.streams.findIndex((s) => s.seed >= FLOOR_SEED_STRIDE);
    expect(first, `${key} has floor streams`).toBeGreaterThan(0);
    const base: GoldenCorpus = { ...committed2, streams: committed2.streams.slice(0, first) };
    const result = extendFloor(module, base);
    const expected = committed2.streams.slice(first).filter((s) => s.seed >= FLOOR_SEED_STRIDE);
    expect(result.appended.length).toBe(expected.length);
    expect(result.appended.length).toBeGreaterThan(0);
    expect(result.corpus.streams.slice(first)).toEqual(expected);
    for (const stream of result.corpus.streams.slice(first)) expect(typeof stream.overlay, `${stream.config}#${stream.seed}`).toBe("string");
  }, sweepBudget("build", 1));
});

// ------------------------------------------------------------------------------------------- the reviewed state diff

describe("corpusStateDiff — the new fields are part of the reviewed diff", () => {
  const module = sport("generic");
  const before1 = formatOneOf("generic");
  let after2!: GoldenCorpus;
  beforeAll(() => {
    after2 = reformattedOf("generic");
  });

  it("a reformat moves nothing and says how many streams were newly recorded", () => {
    const diff = corpusStateDiff(before1, after2, module);
    expect(diff.changedStreams).toBe(0);
    expect(diff.eventsMoved).toBe(false);
    expect(diff.streamsRecorded).toBe(before1.streams.length);
    expect(diff.streamsRecorded).toBeGreaterThan(0);
    expect(diff.streamsDropped).toBe(0);
    expect(formatCorpusStateDiff(diff)).toMatch(/nothing moved/);
    expect(formatCorpusStateDiff(diff)).toContain(`${before1.streams.length} stream(s) newly recorded`);
  });

  it("a moved summary digest and a moved overlay column are listed per stream, by step and by column", () => {
    const first = after2.streams[0]!;
    const summaries = [...first.summaries!];
    summaries[1] = "#1111111111111111";
    const withBadOverlay = (overlay: string): GoldenCorpus => ({ ...after2, streams: [{ ...first, summaries, overlay }, ...after2.streams.slice(1)] });
    const diff = corpusStateDiff(after2, withBadOverlay(`{"stoppage":[[0,null]]}`), module);
    expect(diff.changedStreams).toBe(1);
    expect(diff.streams[0]!.summaryStepsMoved).toEqual([1]);
    expect(diff.streams[0]!.overlayKeysMoved.sort()).toEqual([...new Set(["stoppage", ...Object.keys(JSON.parse(first.overlay!) as object)])].sort());
    const text = formatCorpusStateDiff(diff);
    expect(text).toContain("summaries=[1]");
    expect(text).toMatch(/overlay=\[/);
    expect(diff.streamsRecorded).toBe(0);
  });

  it("an overlay whose text moved but no column did (a key-order change inside a value) is still a move, named as such", () => {
    const first = after2.streams[0]!;
    const reordered = (overlay: string): string => JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(overlay) as object).reverse()));
    // needs two columns to reorder: the first generic stream holds an outcome and a squad/stoppage move, or we build one
    const base: GoldenCorpus = { ...after2, streams: [{ ...first, overlay: `{"outcome":[[0,null]],"stoppage":[[0,null]]}` }, ...after2.streams.slice(1)] };
    const swapped: GoldenCorpus = { ...base, streams: [{ ...base.streams[0]!, overlay: reordered(base.streams[0]!.overlay!) }, ...base.streams.slice(1)] };
    expect(swapped.streams[0]!.overlay).not.toBe(base.streams[0]!.overlay);
    expect(corpusStateDiff(base, swapped, module).streams[0]!.overlayKeysMoved).toEqual(["(key order)"]);
  });

  it("fields that VANISH (format 2 -> 1) are flagged, never reported as nothing moved", () => {
    const dropped: GoldenCorpus = { ...before1 };
    const diff = corpusStateDiff(after2, dropped, module);
    expect(diff.streamsDropped).toBe(after2.streams.length);
    expect(formatCorpusStateDiff(diff)).toContain("RECORDED FIELDS DROPPED");
  });
});

// ------------------------------------------------------------------------------------------- stored fields only (GF-2 batch review M-1)
//
// `dense` is the recorder's probe-only form of the overlay. A spread of a recomputation (`{ ...recomputeStream(...) }`) skips TypeScript's
// excess-property check, so a recomputation that carried `dense` could write 1.8 KB of it into a corpus stream with every test green. The
// expected sets below are the format definitions in `GoldenStream`'s own documentation (golden.ts), not read from the code under test.

/** What a stream stores beyond its input (`config`, `seed`, `events`, and `lineups` where it has them), by corpus format. */
const STORED: Record<CorpusFormat, readonly string[]> = {
  1: ["states", "outcome", "summary", "deltas"],
  2: ["states", "outcome", "summary", "deltas", "summaries", "overlay"],
  3: ["states", "outcome", "summary", "deltas", "summaries", "overlay", "playerStats"],
};
const INPUT = ["config", "seed", "events"] as const;

describe("a recomputation hands out only the fields a stream stores; the probe-only dense overlay stays on the recorder that needs it", () => {
  it("recomputeStream returns exactly the format's stored fields, for every sport and every format, so a spread of it cannot carry dense", () => {
    let checked = 0;
    forEachSport(({ module }) => {
      const corpus = readCorpus(module.key);
      const stream = corpus.streams[0]!;
      for (const format of [1, 2, 3] as const) {
        const recomputed = recomputeStream(module, corpus.configs[stream.config], stream.events, stream.lineups, format);
        expect(Object.keys(recomputed).sort(), `${module.key} format ${format}`).toEqual([...STORED[format]].sort());
        expect(Object.keys({ ...recomputed }), `${module.key} format ${format}: a spread`).not.toContain("dense");
        checked++;
      }
    });
    expect(checked, "every sport in every format").toBe(builtinModules.length * 3);
  });

  it("the recorders the ablation probe uses still carry the dense overlay: dropping it from recomputeStream did not drop it from them", () => {
    let checked = 0;
    forEachSport(({ module }) => {
      const corpus = readCorpus(module.key);
      const stream = corpus.streams[0]!;
      const raw = corpus.configs[stream.config];
      for (const recomputed of [recomputeKernel(module, raw, stream.events, stream.lineups), recomputeStats(module, raw, stream.events, stream.lineups)]) {
        expect(recomputed.dense, module.key).toBeDefined();
        expect(recomputed.dense.steps.outcome.length, `${module.key}: one outcome per event`).toBe(stream.events.length);
        checked++;
      }
    });
    expect(checked).toBe(builtinModules.length * 2);
  });

  it("every stream in every committed corpus stores exactly its corpus format's fields and no other key (swept, counted)", () => {
    let streams = 0;
    let withLineups = 0;
    forEachSport(({ module }) => {
      const corpus = readCorpus(module.key);
      const format = corpusFormat(corpus);
      expect(format, `${module.key}: the committed corpora are format ${CURRENT_FORMAT}`).toBe(CURRENT_FORMAT);
      corpus.streams.forEach((stream, i) => {
        const lineups = stream.lineups === undefined ? [] : ["lineups"];
        expect(Object.keys(stream).sort(), `${module.key} stream #${i} (${stream.config}#${stream.seed})`).toEqual([...INPUT, ...lineups, ...STORED[format]].sort());
        streams++;
        if (lineups.length > 0) withLineups++;
      });
    });
    expect(streams, "the sweep reached the streams of every sport").toBeGreaterThan(builtinModules.length);
    expect(withLineups, "some committed stream carries lineups, so the optional key was exercised").toBeGreaterThan(0);
  });
});
