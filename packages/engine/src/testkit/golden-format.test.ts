// GF-2 T1 — corpus FORMAT 2 and the REFORMAT_GOLDEN write mode (design §2, §3 last bullet).
//
// REFORMAT is the one write mode that is NOT a re-baseline: it adds the two format-2 fields to every stream and proves, as it
// goes, that nothing the corpus already holds would move. Everything below states a rule of that and then tries to break it.
// No committed corpus is written by any test here; reformatted corpora are built in memory.
import { beforeAll, describe, expect, it } from "vitest";
import { resolvePositions } from "../sport/catalog.ts";
import type { AnySportModule } from "../sport/module.ts";
import { builtinModules } from "../sports/index.ts";
import { forEachSport } from "./for-each-sport.ts";
import {
  FLOOR_SEED_STRIDE,
  extendFloor,
} from "./golden-floor-streams.ts";
import {
  GUARDED_WRITE_MODES,
  buildCorpus,
  REFORMAT_GOLDEN,
  corpusFormat,
  corpusStateDiff,
  extendCorpus,
  formatCorpusStateDiff,
  guardedWriteModes,
  overlayMismatch,
  readCorpus,
  rebaselineCorpus,
  recomputeStream,
  storedFields,
  verifyStream,
  type GoldenCorpus,
  type GoldenEvent,
  type GoldenStream,
} from "./golden.ts";
import { reformatCorpus } from "./golden-reformat.ts";
import { defaultLineupPair } from "./helpers.ts";

const sport = (key: string): AnySportModule => builtinModules.find((m) => m.key === key)!;
const ev = (type: string, payload: unknown = {}): GoldenEvent => ({ type, payload });
const bytesOf = (corpus: GoldenCorpus): string => `${JSON.stringify(corpus, null, 0)}\n`;

// ------------------------------------------------------------------------------------------------ the format marker

describe("corpusFormat", () => {
  it("absent is 1, 1 and 2 are themselves, anything else is refused (a typo cannot read as format 1)", () => {
    expect(corpusFormat({})).toBe(1);
    expect(corpusFormat({ format: 1 })).toBe(1);
    expect(corpusFormat({ format: 2 })).toBe(2);
    for (const bad of [0, 3, "2", null, true]) {
      expect(() => corpusFormat({ format: bad as never }), JSON.stringify(bad)).toThrow(/unknown golden corpus format/);
    }
  });

  it("every committed corpus is format 1 today (T1 writes no corpus byte)", () => {
    let checked = 0;
    forEachSport(({ key }) => {
      const corpus = readCorpus(key);
      expect(corpusFormat(corpus), key).toBe(1);
      expect("format" in corpus, key).toBe(false);
      for (const stream of corpus.streams) {
        expect("summaries" in stream || "overlay" in stream, `${key} ${stream.config}#${stream.seed}`).toBe(false);
      }
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

// ----------------------------------------------------------------------------------------------------- REFORMAT

/** One reformatted corpus per sport, built once: the registry sweep below and the tamper tests both read it. */
const reformatted = new Map<string, GoldenCorpus>();
const reformattedOf = (key: string): GoldenCorpus => {
  let corpus = reformatted.get(key);
  if (corpus === undefined) {
    corpus = reformatCorpus(sport(key), readCorpus(key));
    reformatted.set(key, corpus);
  }
  return corpus;
};

describe("reformatCorpus — adds the format-2 fields and moves nothing the corpus already holds", () => {
  let streamsSeen = 0;
  let stepsSeen = 0;
  for (const module of builtinModules) {
    it(`${module.key}: every pre-existing field byte-identical, the new fields last, format before streams, a second run a no-op`, () => {
      const before = readCorpus(module.key);
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
      const again = reformatCorpus(module, after);
      expect(bytesOf(again)).toBe(bytesOf(after));
      // the written file is the committed one plus the new fields: strictly longer, and every old byte is still there
      expect(bytesOf(after).length).toBeGreaterThan(bytesOf(before).length);
    }, 120_000);
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

describe("reformatCorpus — it is NEVER a re-baseline: it refuses when anything already recorded would change", () => {
  const module = sport("generic");
  const corpus1 = readCorpus("generic");
  const cfgName = Object.keys(corpus1.configs)[0]!;
  const raw = corpus1.configs[cfgName];
  const withStream = (stream: GoldenStream): GoldenCorpus => ({ ...corpus1, streams: [...corpus1.streams, stream] });
  const tamperFirst = (patch: Partial<GoldenStream>): GoldenCorpus => ({ ...corpus1, streams: [{ ...corpus1.streams[0]!, ...patch }, ...corpus1.streams.slice(1)] });

  it("a stream recorded under format 1 whose EFFECTIVE outcome differs from the module's (a settle): the stored outcome would move", () => {
    const { home } = defaultLineupPair(resolvePositions(module, module.configSchema.parse(raw)));
    const events = [ev("core.start"), ev("core.abandon", { reason: "rain" }), ev("core.settle", { winner: home.entrantId, method: "organiser" })];
    const legacy: GoldenStream = { config: cfgName, seed: 99_999, events, ...storedFields(recomputeStream(module, raw, events)) };
    expect(legacy.outcome, "precondition: format 1 recorded the module's bare outcome").toBe("null");
    expect(() => reformatCorpus(module, withStream(legacy))).toThrow(/generic config=\w+ seed=99999 outcome: recorded null, replayed .*settled_organiser/s);
    expect(() => reformatCorpus(module, withStream(legacy))).toThrow(/re-baseline/);
  });

  it("a stored state, outcome, summary or deltas that no longer replays: refused, naming the field", () => {
    expect(() => reformatCorpus(module, tamperFirst({ outcome: `{"kind":"draw"}` }))).toThrow(/outcome: recorded/);
    expect(() => reformatCorpus(module, tamperFirst({ summary: `{"x":1}` }))).toThrow(/summary: recorded/);
    expect(() => reformatCorpus(module, tamperFirst({ deltas: `{"league":[9,9],"knockout":null}` }))).toThrow(/deltas: recorded/);
    const states = [...corpus1.streams[0]!.states];
    states[states.length - 1] = `{"tampered":true}`;
    expect(() => reformatCorpus(module, tamperFirst({ states }))).toThrow(/state after event/);
  });

  it("a format-1 corpus that already carries a format-2 field is a hybrid: refused (absence can only mean format 1)", () => {
    expect(() => reformatCorpus(module, tamperFirst({ summaries: [] }))).toThrow(/format-1 stream carries summaries\/overlay/);
    expect(() => reformatCorpus(module, tamperFirst({ overlay: "{}" }))).toThrow(/format-1 stream carries summaries\/overlay/);
  });

  it("a format-2 corpus whose recorded summaries or overlay are stale is NOT a no-op: refused, never repaired", () => {
    const good = reformattedOf("generic");
    const first = good.streams[0]!;
    const stale = (patch: Partial<GoldenStream>): GoldenCorpus => ({ ...good, streams: [{ ...first, ...patch }, ...good.streams.slice(1)] });
    const flipped = [...first.summaries!];
    flipped[0] = "#0000000000000000";
    expect(() => reformatCorpus(module, stale({ summaries: flipped }))).toThrow(/summary after event 0/);
    expect(() => reformatCorpus(module, stale({ overlay: `{"stoppage":[[0,{"eventId":"e-0"}]]}` }))).toThrow(/overlay/);
    const { summaries: _dropped, ...withoutSummaries } = first;
    expect(() => reformatCorpus(module, { ...good, streams: [withoutSummaries as GoldenStream, ...good.streams.slice(1)] })).toThrow(/must record both summaries and overlay/);
  });

  it("an emptied corpus (no streams) is refused: a reformat of nothing proves nothing", () => {
    expect(() => reformatCorpus(module, { ...corpus1, streams: [] })).toThrow(/no streams/);
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
    expect(verify({}, four).join("\n")).toMatch(/the replay produced no summaries\/overlay/);
    // a replay that produced the fields but the wrong number of digests (reachable only by injection: both derive from the events)
    const short = { ...four, summaries: [] as string[], overlay: "{}" };
    expect(verify({}, short).join("\n")).toMatch(/summaries: recorded \d+ digests, the replay produced 0/);
  });

  it("a format-1 corpus stream that holds a format-2 field is refused", () => {
    const committed = readCorpus("carrom");
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
  it("generic: a format-2 corpus, format before streams, every stream verified, no dense overlay stored", () => {
    // single sport: generation costs seconds per module and this checks the wiring, which is sport-independent
    const module = sport("generic");
    const corpus = buildCorpus(module);
    expect(corpusFormat(corpus)).toBe(2);
    expect(Object.keys(corpus).slice(-2)).toEqual(["format", "streams"]);
    expect(corpus.streams.length).toBeGreaterThan(0);
    for (const stream of corpus.streams) {
      expect(Object.keys(stream), `${stream.config}#${stream.seed}`).toEqual(expect.arrayContaining(["summaries", "overlay"]));
      expect(Object.keys(stream)).not.toContain("dense");
      expect(verifyStream(module, corpus, stream), `${stream.config}#${stream.seed}`).toEqual([]);
    }
  }, 60_000);
});

// ----------------------------------------------------- the other writers keep the corpus's format (rebaseline, extend)

describe("rebaselineCorpus keeps the corpus's format", () => {
  it("format 1 stays format 1 (no field appears), format 2 stays format 2 and re-records both fields", () => {
    const module = sport("generic");
    const one = readCorpus("generic");
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
    for (const base of [readCorpus(key), reformattedOf(key)]) {
      const dropped = walks(base).at(-1)!;
      const trimmed: GoldenCorpus = { ...base, streams: base.streams.filter((s) => s !== dropped) };
      const { corpus, appended } = extendCorpus(module, trimmed);
      expect(appended.length, `${key} format ${corpusFormat(base)}: nothing appended, so this proves nothing`).toBeGreaterThan(0);
      const fresh = corpus.streams.slice(trimmed.streams.length);
      for (const stream of fresh) {
        expect("summaries" in stream && "overlay" in stream, `format ${corpusFormat(base)}`).toBe(corpusFormat(base) === 2);
        expect(Object.keys(stream).includes("dense"), "the dense overlay is never stored").toBe(false);
        expect(verifyStream(module, corpus, stream), `${stream.config}#${stream.seed}`).toEqual([]);
      }
      expect(corpus.streams.slice(0, trimmed.streams.length)).toEqual(trimmed.streams);
      appendedTotal += fresh.length;
    }
    expect(appendedTotal).toBeGreaterThanOrEqual(2);
  }, 60_000);

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
  }, 60_000);
});

// ------------------------------------------------------------------------------------------- the reviewed state diff

describe("corpusStateDiff — the new fields are part of the reviewed diff", () => {
  const module = sport("generic");
  const before1 = readCorpus("generic");
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
    expect(formatCorpusStateDiff(diff)).toContain("FORMAT-2 FIELDS DROPPED");
  });
});
