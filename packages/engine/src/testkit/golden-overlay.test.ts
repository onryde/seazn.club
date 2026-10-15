// GF-2 T1 — the recorder learns the KERNEL overlay (design: docs/superpowers/specs/engine-split/gf2-kernel-overlay-design.md).
//
// A phone computes more than the module: the kernel lays a settlement, an expunge and a withdrawal over a held level result
// on top of the module's answer (`outcomeOf` / `summaryOf`), and keeps a stoppage, the squads and a pending decider beside
// the module's state. Format 2 of the corpus records those, per step, as change points (`overlay`) and as one digest per
// step (`summaries`), and records the EFFECTIVE `outcome` / `summary` / `deltas` (owner ruling Q3, 2026-10-15).
//
// Expected values here come from the rulebook (X-ST-1 a settle is a `settled_<method>` win, X-WD-1 a withdrawal over a held
// level result is an award with reason `withdrew`, D5 an expunge has no outcome), from the kernel's own functions applied
// to an INDEPENDENT fold of the same ledger, and from FIPS 180-2's SHA-256 test vector — never from the recorder under test.
import { describe, expect, it } from "vitest";
import {
  deciderPending,
  foldMatchWithStoppage,
  outcomeOf,
  summaryOf,
  type EventEnvelope,
} from "../core/events.ts";
import { resolvePositions } from "../sport/catalog.ts";
import type { AnySportModule } from "../sport/module.ts";
import { builtinModules } from "../sports/index.ts";
import { forEachSport } from "./for-each-sport.ts";
import {
  readCorpus,
  recomputeKernel,
  recomputeStream,
  textDigest,
  verifyStream,
  type GoldenEvent,
  type GoldenStream,
} from "./golden.ts";
import {
  FOLD_OVERLAY_KEYS,
  OVERLAY_COLUMNS,
  compactOverlay,
  expandOverlay,
  type DenseOverlay,
  type OverlayColumn,
} from "./golden-overlay.ts";
import { defaultLineupPair, makeEnvelope } from "./helpers.ts";

const STRICT_ALL = { strictFromSeq: 0 } as const;
const ev = (type: string, payload: unknown = {}, voids?: string): GoldenEvent => ({ type, payload, ...(voids === undefined ? {} : { voids }) });
const envelopesOf = (events: readonly GoldenEvent[]): EventEnvelope[] => events.map((e, i) => makeEnvelope(i, e, e.voids));
const rawOf = (m: AnySportModule): unknown => Object.values(m.variants as Record<string, unknown>)[0] ?? {};
const linesOf = (m: AnySportModule, raw: unknown) => defaultLineupPair(resolvePositions(m, m.configSchema.parse(raw)));
const text = (v: unknown): string => JSON.stringify(v ?? null);
const jsonOf = (s: string): unknown => JSON.parse(s);

/** A dense overlay whose columns are all at the kernel default for `n` steps. */
const flat = (n: number): DenseOverlay => ({
  initial: { outcome: "null", stoppage: "null", settlement: "null", expunged: "false", levelWithdrawal: "null", decider: "false", squads: `"#aaaaaaaaaaaaaaaa"` },
  steps: Object.fromEntries(
    OVERLAY_COLUMNS.map((c) => [c, Array.from({ length: n }, () => (c === "expunged" ? "false" : c === "decider" ? "false" : c === "squads" ? `"#aaaaaaaaaaaaaaaa"` : "null"))]),
  ) as unknown as DenseOverlay["steps"],
});
const withColumn = (dense: DenseOverlay, column: OverlayColumn, values: string[]): DenseOverlay => ({ ...dense, steps: { ...dense.steps, [column]: values } });

describe("textDigest — the one digest shape every corpus field uses", () => {
  it("is '#' + the first 16 hex of SHA-256 (FIPS 180-2 test vector for 'abc')", () => {
    expect(textDigest("abc")).toBe("#ba7816bf8f01cfea");
    expect(textDigest("")).toBe("#e3b0c44298fc1c14");
  });
});

describe("compactOverlay / expandOverlay — change points, losslessly (pure)", () => {
  const WIN = `{"kind":"win"}`;
  const DRAW = `{"kind":"draw"}`;
  const STOP = `{"eventId":"e-1"}`;

  it("holds ONLY the steps where a value differs from the step before; a column that never leaves its default is omitted", () => {
    const dense = withColumn(withColumn(flat(6), "outcome", ["null", "null", WIN, WIN, "null", DRAW]), "stoppage", ["null", STOP, STOP, "null", "null", "null"]);
    // Written out by hand: outcome changes at 2, returns to the default at 4, changes again at 5; stoppage opens at 1, closes at 3.
    expect(compactOverlay(dense)).toBe(`{"outcome":[[2,${WIN}],[4,null],[5,${DRAW}]],"stoppage":[[1,${STOP}],[3,null]]}`);
    expect(Object.keys(JSON.parse(compactOverlay(dense)) as object), "settlement/expunged/levelWithdrawal/decider/squads never moved").toEqual(["outcome", "stoppage"]);
  });

  it("records a value RETURNING to the default (a void reopening a decided match) as a change point of its own", () => {
    const dense = withColumn(flat(4), "outcome", ["null", WIN, "null", "null"]);
    expect(compactOverlay(dense)).toBe(`{"outcome":[[1,${WIN}],[2,null]]}`);
    // A value that moves to a DIFFERENT non-default is recorded too, not folded into the first.
    expect(compactOverlay(withColumn(flat(3), "outcome", [WIN, DRAW, DRAW]))).toBe(`{"outcome":[[0,${WIN}],[1,${DRAW}]]}`);
  });

  it("step 0 differing from the kernel default (step -1) is a change point at step 0", () => {
    expect(compactOverlay(withColumn(flat(2), "expunged", ["true", "true"]))).toBe(`{"expunged":[[0,true]]}`);
  });

  it("an empty ledger is the empty overlay, and expands to empty columns", () => {
    expect(compactOverlay(flat(0))).toBe("{}");
    const expanded = expandOverlay("{}", 0, flat(0).initial);
    expect(Object.keys(expanded)).toEqual([...OVERLAY_COLUMNS]);
    for (const column of OVERLAY_COLUMNS) expect(expanded[column], column).toEqual([]);
  });

  it("round-trips: expanding the compact form carries every value forward to the dense per-step form", () => {
    let checked = 0;
    const cases: DenseOverlay[] = [
      flat(5),
      withColumn(flat(7), "outcome", ["null", WIN, "null", DRAW, DRAW, "null", WIN]),
      withColumn(withColumn(flat(5), "decider", ["false", "true", "true", "false", "false"]), "squads", [`"#aaaaaaaaaaaaaaaa"`, `"#bbbbbbbbbbbbbbbb"`, `"#bbbbbbbbbbbbbbbb"`, `"#aaaaaaaaaaaaaaaa"`, `"#cccccccccccccccc"`]),
    ];
    for (const dense of cases) {
      expect(expandOverlay(compactOverlay(dense), dense.steps.outcome.length, dense.initial)).toEqual(dense.steps);
      checked++;
    }
    expect(checked).toBe(3);
  });

  it("REFUSES a ragged dense overlay (columns of different lengths)", () => {
    const ragged = withColumn(flat(3), "decider", ["false", "false"]);
    expect(() => compactOverlay(ragged)).toThrow(/ragged/);
  });

  it("REFUSES a value whose text would not survive a JSON round trip (an integer-like key is reordered by JSON.parse)", () => {
    const hostile = withColumn(flat(2), "outcome", ["null", `{"2":1,"1":2}`]);
    expect(() => compactOverlay(hostile)).toThrow(/round-trip/);
  });

  it("expand REFUSES a malformed overlay: an unknown column, a step out of range, steps not ascending, a non-array column", () => {
    const initial = flat(3).initial;
    expect(() => expandOverlay(`{"bogus":[[1,null]]}`, 3, initial)).toThrow(/unknown column "bogus"/);
    expect(() => expandOverlay(`{"outcome":[[3,null]]}`, 3, initial)).toThrow(/step 3/);
    expect(() => expandOverlay(`{"outcome":[[-1,null]]}`, 3, initial)).toThrow(/step -1/);
    expect(() => expandOverlay(`{"outcome":[[2,null],[1,null]]}`, 3, initial)).toThrow(/ascending/);
    expect(() => expandOverlay(`{"outcome":{"1":null}}`, 3, initial)).toThrow(/array/);
    expect(() => expandOverlay(`[1]`, 3, initial)).toThrow(/object/);
    expect(() => expandOverlay(`{"outcome":[[1]]}`, 3, initial)).toThrow(/malformed pair/);
    expect(() => expandOverlay(`{"outcome":[["1",null]]}`, 3, initial)).toThrow(/step 1/);
  });
});

describe("the fold result's keys are all recorded (an inert-seam guard: a new kernel fact must be recorded or named)", () => {
  it("every key foldMatchWithStoppage returns besides `state` is a recorded fold fact, and the other way round", () => {
    let checked = 0;
    forEachSport(({ module }) => {
      const folded = foldMatchWithStoppage(module, module.configSchema.parse(rawOf(module)), linesOf(module, rawOf(module)), [], STRICT_ALL);
      const keys = Object.keys(folded).filter((k) => k !== "state").sort();
      expect(keys, `${module.key}: the kernel returns a fact the recorder does not read — record it (golden-overlay.ts) or argue it away`).toEqual([...FOLD_OVERLAY_KEYS].sort());
      checked++;
    });
    expect(checked).toBe(builtinModules.length);
    // And the columns the recorder writes are those facts plus the two it derives from them.
    expect([...OVERLAY_COLUMNS].sort()).toEqual([...FOLD_OVERLAY_KEYS, "outcome", "decider"].sort());
  });
});

// ------------------------------------------------------------------------------------- hand-built overlay ledgers

/** A rulebook row: what a ledger must record, in this sport, under this config. */
interface OverlayRow {
  readonly sport: string;
  readonly raw: unknown;
}
const rowsFor = (rows: readonly OverlayRow[]): { module: AnySportModule; raw: unknown }[] =>
  rows.map((r) => ({ module: builtinModules.find((m) => m.key === r.sport)!, raw: r.raw }));

describe("recomputeStream format 2 — a settle (X-ST-1), in every sport", () => {
  it("records the settled WIN as the outcome (the module's own answer is not it), the settlement beside it, and settle-aware deltas", () => {
    let checked = 0;
    let differs = 0;
    forEachSport(({ module }) => {
      const raw = rawOf(module);
      const cfg = module.configSchema.parse(raw);
      const { home, away } = linesOf(module, raw);
      const ledger = [ev("core.start"), ev("core.abandon", { reason: "rain" }), ev("core.settle", { winner: home.entrantId, method: "organiser" })];
      const effective = recomputeKernel(module, raw, ledger);
      const bare = recomputeStream(module, raw, ledger);
      const settled = { kind: "win", winner: home.entrantId, loser: away.entrantId, method: "settled_organiser" };
      expect(jsonOf(effective.outcome), module.key).toEqual(settled);
      if (effective.outcome !== bare.outcome) differs++;
      // the settlement lives beside module state: it is the overlay column, set at step 2 (the settle) and nowhere else
      const dense = effective.dense;
      const settlement = dense.steps.settlement.map((s) => jsonOf(s));
      expect(settlement, module.key).toEqual([null, null, { winner: home.entrantId, loser: away.entrantId, method: "organiser", eventId: "e-2" }]);
      expect(jsonOf(dense.steps.outcome[2]!), module.key).toEqual(settled);
      expect(JSON.parse(effective.overlay).settlement, module.key).toEqual([[2, { winner: home.entrantId, loser: away.entrantId, method: "organiser", eventId: "e-2" }]]);
      // deltas: the table is laid over the EFFECTIVE outcome, as the server does (it stores `outcomeOf`, then feeds it to standingsDelta)
      const finalState = foldMatchWithStoppage(module, cfg, linesOf(module, raw), envelopesOf(ledger), STRICT_ALL).state;
      const expectedDeltas = {
        league: module.standingsDelta(settled as never, cfg, { kind: "league" }, finalState),
        knockout: module.standingsDelta(settled as never, cfg, { kind: "knockout" }, finalState),
      };
      expect(jsonOf(effective.deltas), module.key).toEqual(expectedDeltas);
      expect(effective.deltas, `${module.key}: the module's bare outcome is not a win, so its deltas are not the settled table`).not.toBe(bare.deltas);
      // a settle is deliberately NOT overlaid on the summary (a settled level game shows the score that was played)
      expect(effective.summary, module.key).toBe(bare.summary);
      checked++;
    });
    expect(checked).toBe(builtinModules.length);
    expect(differs, "the effective outcome differs from the module's in every sport").toBe(builtinModules.length);
  });
});

describe("recomputeStream format 2 — an expunge (D5), where the module still answers", () => {
  const rows = rowsFor([
    { sport: "cricket", raw: {} }, // an abandon is a `no_result` in the module's own state
    { sport: "football", raw: { abandonPolicy: "award" } }, // an awarded abandon decides the match (0-0 is a draw)
  ]);
  it("records NO outcome while the module's own outcome is non-null, and the expunge flag set at the abandon", () => {
    let differs = 0;
    for (const { module, raw } of rows) {
      const ledger = [ev("core.start"), ev("core.abandon", { reason: "x", expunge: true })];
      const effective = recomputeKernel(module, raw, ledger);
      const bare = recomputeStream(module, raw, ledger);
      expect(bare.outcome, `${module.key}: precondition — the module's bare outcome is an answer`).not.toBe("null");
      expect(effective.outcome, module.key).toBe("null");
      if (effective.outcome !== bare.outcome) differs++;
      expect(JSON.parse(effective.overlay), module.key).toEqual({ expunged: [[1, true]] });
      expect(effective.dense.steps.expunged, module.key).toEqual(["false", "true"]);
      // every delta is null for an outcome-less match (the table never sees an expunged match)
      expect(jsonOf(effective.deltas), module.key).toEqual({ league: null, knockout: null });
    }
    expect(differs, ">= 2 sports where the effective outcome differs from the module's").toBeGreaterThanOrEqual(2);
    expect(differs).toBe(rows.length);
  });
});

describe("recomputeStream format 2 — a withdrawal over a held level result (X-WD-1)", () => {
  // A level result per sport that can end level (the set sports and tennis never draw): forfeit-guard.test.ts's own rows.
  const LEVEL: Record<string, { raw: unknown; events: GoldenEvent[] }> = {
    football: { raw: {}, events: [ev("football.period", { phase: "HT" }), ev("football.period", { phase: "FT" })] },
    boardgame: { raw: {}, events: [ev("boardgame.result", { winner: null, method: "agreement" })] },
    generic: { raw: { resultMode: "score", allowDraws: true }, events: [ev("generic.result", { p1Score: 1, p2Score: 1 })] },
  };
  it("records the award (reason withdrew) as the outcome and the withdrawal beside it; the summary is the module's own, laid over the award", () => {
    let checked = 0;
    let summaryDiffers = 0;
    for (const [key, row] of Object.entries(LEVEL)) {
      const module = builtinModules.find((m) => m.key === key)!;
      const { home, away } = linesOf(module, row.raw);
      const level = [ev("core.start"), ...row.events];
      const wdIndex = level.length;
      const ledger = [...level, ev("core.forfeit", { by: away.entrantId, reason: "withdrew" })];
      const effective = recomputeKernel(module, row.raw, ledger);
      const bare = recomputeStream(module, row.raw, ledger);
      expect(["draw", "tie", "no_result"], `${key}: precondition — the held result is level`).toContain((jsonOf(bare.outcome) as { kind: string }).kind);
      const award = { kind: "award", winner: home.entrantId, loser: away.entrantId, reason: "withdrew" };
      expect(jsonOf(effective.outcome), key).toEqual(award);
      expect(JSON.parse(effective.overlay).levelWithdrawal, key).toEqual([[wdIndex, { winner: home.entrantId, loser: away.entrantId, eventId: `e-${wdIndex}` }]]);
      // the summary: the kernel's own `summaryOf` over an independent fold (the module never saw the withdrawal)
      const folded = foldMatchWithStoppage(module, module.configSchema.parse(row.raw), linesOf(module, row.raw), envelopesOf(ledger), STRICT_ALL);
      expect(effective.summary, key).toBe(text(summaryOf(module, folded)));
      if (effective.summary !== bare.summary) summaryDiffers++;
      // the digest per step moves exactly where the headline does
      expect(effective.summaries.length, key).toBe(ledger.length);
      expect(effective.summaries[wdIndex], key).toBe(textDigest(text(summaryOf(module, folded))));
      checked++;
    }
    expect(checked).toBe(3);
    expect(summaryDiffers, "the withdrawal changes the headline in at least two level sports").toBeGreaterThanOrEqual(2);
  });
});

describe("recomputeStream format 2 — a void REOPENS what it struck", () => {
  it("every sport: settle then void-the-settle returns the outcome to what it was before the settle, and both moves are change points", () => {
    let checked = 0;
    forEachSport(({ module }) => {
      const raw = rawOf(module);
      const { home } = linesOf(module, raw);
      const ledger = [ev("core.start"), ev("core.abandon", { reason: "rain" }), ev("core.settle", { winner: home.entrantId, method: "organiser" }), ev("core.void", {}, "e-2")];
      const rec = recomputeKernel(module, raw, ledger);
      const dense = rec.dense;
      const before = dense.steps.outcome[1]!;
      expect(dense.steps.outcome[2], `${module.key}: the settle decided it`).not.toBe(before);
      expect(dense.steps.outcome[3], `${module.key}: the void reopened it`).toBe(before);
      expect(dense.steps.settlement[3], module.key).toBe("null");
      const compact = JSON.parse(rec.overlay) as Record<string, [number, unknown][]>;
      expect(compact.settlement!.map(([step]) => step), module.key).toEqual([2, 3]);
      expect(compact.settlement![1]![1], module.key).toBeNull();
      expect(compact.outcome!.at(-1)![0], `${module.key}: the return to the earlier value is recorded at the void`).toBe(3);
      // the final effective outcome is the reopened one — what the stream records
      expect(rec.outcome, module.key).toBe(before);
      checked++;
    });
    expect(checked).toBe(builtinModules.length);
  });
});

describe("recomputeStream — the two formats", () => {
  it("format 1 (the default) is the legacy four fields and nothing else; format 2 adds summaries, overlay and the dense form", () => {
    const module = builtinModules[0]!;
    const raw = rawOf(module);
    const ledger = [ev("core.start")];
    expect(Object.keys(recomputeStream(module, raw, ledger))).toEqual(["states", "outcome", "summary", "deltas"]);
    expect(Object.keys(recomputeStream(module, raw, ledger, undefined, 1))).toEqual(["states", "outcome", "summary", "deltas"]);
    expect(Object.keys(recomputeStream(module, raw, ledger, undefined, 2))).toEqual(["states", "outcome", "summary", "deltas", "summaries", "overlay", "dense"]);
  });

  it("format 1 still records the module's BARE outcome for a settle (the golden floor's settle exemption reads exactly this)", () => {
    const module = builtinModules.find((m) => m.key === "generic")!;
    const raw = rawOf(module);
    const { home } = linesOf(module, raw);
    const ledger = [ev("core.start"), ev("core.abandon", { reason: "rain" }), ev("core.settle", { winner: home.entrantId, method: "organiser" })];
    expect(recomputeStream(module, raw, ledger).outcome).toBe("null");
    expect(jsonOf(recomputeStream(module, raw, ledger, undefined, 2).outcome)).toMatchObject({ kind: "win", method: "settled_organiser" });
  });

  it("an empty ledger records no steps, an empty overlay, and the kernel defaults at step -1 (the squads default is the team sheets)", () => {
    forEachSport(({ module }) => {
      const raw = rawOf(module);
      const rec = recomputeKernel(module, raw, []);
      expect(rec.states, module.key).toEqual([]);
      expect(rec.summaries, module.key).toEqual([]);
      expect(rec.overlay, module.key).toBe("{}");
      const folded = foldMatchWithStoppage(module, module.configSchema.parse(raw), linesOf(module, raw), [], STRICT_ALL);
      expect(rec.dense.initial.squads, module.key).toBe(text(textDigest(text(folded.squads))));
      expect(rec.dense.initial.outcome, module.key).toBe("null");
      expect(rec.dense.initial.expunged, module.key).toBe("false");
    });
  });
});

// ----------------------------------------------------------------------- every committed stream, swept and counted

/** What an independent fold of `stream` says, per step, for every overlay column and the summary digest. */
function independentSteps(module: AnySportModule, raw: unknown, stream: GoldenStream): { dense: Record<OverlayColumn, string[]>; summaries: string[] } {
  const cfg = module.configSchema.parse(raw);
  const lineups = stream.lineups ?? defaultLineupPair(resolvePositions(module, cfg));
  const envelopes = envelopesOf(stream.events);
  const dense = Object.fromEntries(OVERLAY_COLUMNS.map((c) => [c, [] as string[]])) as Record<OverlayColumn, string[]>;
  const summaries: string[] = [];
  for (let i = 0; i < envelopes.length; i++) {
    const f = foldMatchWithStoppage(module, cfg, lineups, envelopes.slice(0, i + 1), STRICT_ALL);
    dense.outcome.push(text(outcomeOf(module, f)));
    dense.stoppage.push(text(f.stoppage));
    dense.settlement.push(text(f.settlement));
    dense.expunged.push(text(f.expunged));
    dense.levelWithdrawal.push(text(f.levelWithdrawal));
    dense.decider.push(text(deciderPending(module, f)));
    dense.squads.push(text(textDigest(text(f.squads))));
    summaries.push(textDigest(text(summaryOf(module, f))));
  }
  return { dense, summaries };
}

describe("recomputeStream format 2 over every committed stream (swept, counted)", () => {
  const totals = { streams: 0, steps: 0, changePoints: 0, interesting: 0 };
  const columnPoints: Record<OverlayColumn, number> = { outcome: 0, stoppage: 0, settlement: 0, expunged: 0, levelWithdrawal: 0, decider: 0, squads: 0 };
  const sports = builtinModules.map((m) => m.key);

  for (const module of builtinModules) {
    it(`${module.key}: effective outcome/summary/deltas replay byte-identical to the committed bytes, and the overlay is the lossless change-point form of an independent fold`, () => {
      const corpus = readCorpus(module.key);
      let streams = 0;
      let steps = 0;
      let points = 0;
      let interesting = 0;
      for (const stream of corpus.streams) {
        const raw = corpus.configs[stream.config];
        const rec = recomputeKernel(module, raw, stream.events, stream.lineups);
        // (1) Q3: the effective values are byte-identical to what the corpus holds today, on every existing stream
        expect(
          verifyStream(module, corpus, stream, { states: rec.states, outcome: rec.outcome, summary: rec.summary, deltas: rec.deltas }),
          `${module.key} ${stream.config}#${stream.seed}`,
        ).toEqual([]);
        // (2) summaries: one digest per step
        expect(rec.summaries.length).toBe(stream.events.length);
        for (const digest of rec.summaries) expect(digest).toMatch(/^#[0-9a-f]{16}$/);
        // (3) the overlay carries forward to the dense form, and the dense form has one entry per step
        const dense = rec.dense;
        const expanded = expandOverlay(rec.overlay, stream.events.length, dense.initial);
        expect(expanded, `${module.key} ${stream.config}#${stream.seed}`).toEqual(dense.steps);
        const parsed = JSON.parse(rec.overlay) as Partial<Record<OverlayColumn, unknown[]>>;
        for (const column of OVERLAY_COLUMNS) {
          expect(dense.steps[column].length, column).toBe(stream.events.length);
          const n = parsed[column]?.length ?? 0;
          columnPoints[column] += n;
          points += n;
        }
        // (4) the final overlay outcome is the stream's recorded outcome
        if (stream.events.length > 0) expect(dense.steps.outcome.at(-1)).toBe(rec.outcome);
        // (5) an INDEPENDENT fold (the kernel's own functions, not the recorder) agrees, step for step — on every stream whose
        //     overlay holds anything but the outcome's own move (a stoppage, a squad change, a decider), which is what is hard to get right
        const nonOutcome = OVERLAY_COLUMNS.some((c) => c !== "outcome" && parsed[c] !== undefined);
        if (nonOutcome) {
          interesting++;
          const independent = independentSteps(module, raw, stream);
          expect(dense.steps, `${module.key} ${stream.config}#${stream.seed}`).toEqual(independent.dense);
          expect(rec.summaries, `${module.key} ${stream.config}#${stream.seed}`).toEqual(independent.summaries);
        }
        streams++;
        steps += stream.events.length;
      }
      // anti-vacuity: this sport's sweep looked at something, and found overlay moves worth the name
      expect(streams, `${module.key} streams`).toBe(corpus.streams.length);
      expect(streams).toBeGreaterThan(0);
      expect(steps).toBeGreaterThan(0);
      expect(points, `${module.key} change points`).toBeGreaterThan(0);
      expect(interesting, `${module.key}: streams with a stoppage, a squad change or a decider`).toBeGreaterThan(0);
      totals.streams += streams;
      totals.steps += steps;
      totals.changePoints += points;
      totals.interesting += interesting;
    }, 120_000);
  }

  it("the sweep covered every sport, every stream, and every overlay column that any corpus moves", () => {
    expect(sports.length).toBe(11);
    expect(totals.streams).toBe(builtinModules.reduce((n, m) => n + readCorpus(m.key).streams.length, 0));
    expect(totals.steps).toBeGreaterThan(totals.streams);
    expect(totals.changePoints).toBeGreaterThan(0);
    // the committed corpora hold a stoppage, a squad change and a pending decider (the design's measured facts); a column that
    // never moves would let the sweep above pass over a column nobody wired
    expect(columnPoints.outcome, "outcome").toBeGreaterThan(0);
    expect(columnPoints.stoppage, "stoppage").toBeGreaterThan(0);
    expect(columnPoints.squads, "squads").toBeGreaterThan(0);
    expect(columnPoints.decider, "decider (boardgame only: single-sport by nature)").toBeGreaterThan(0);
    // (settlement, expunged and levelWithdrawal move in no committed stream today: the hand-built ledgers above are what pins
    // them until the floor appends streams that do)
  });
});
