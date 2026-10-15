// GF-2 T4 — corpus FORMAT 3: the final player-stats rows of a stream (owner ruling Q2, 2026-10-15: a MINOR).
//
// Format 3 is format 2 plus ONE required stream field, `playerStats`: the canonical text of the rows the server's stats fold gives
// for the fixture (golden-stats.ts). Everything below states a rule of the recorder and tries to break it; the guard that makes the
// field a minor lives in test/fold-epoch-guard*.test.ts. No committed corpus is written by any test here; format-3 corpora are
// built in memory from the committed ones, whichever of format 2 or 3 the files are in.
import { beforeAll, describe, expect, it } from "vitest";
import { makeEnvelope } from "./helpers.ts";
import { resolvePositions } from "../sport/catalog.ts";
import type { AnySportModule } from "../sport/module.ts";
import { builtinModules } from "../sports/index.ts";
import { aggregatePlayerStats, type PlayerStatRow } from "../stats/stats.ts";
import { forEachSport } from "./for-each-sport.ts";
import { sweepBudget } from "./golden-budget.ts";
import { FLOOR_SEED_STRIDE, extendFloor } from "./golden-floor-streams.ts";
import { asFormatOne, asFormatTwo, reformatAll, reformatCorpus } from "./golden-reformat.ts";
import { canonicalStatRows, movedStatKeys, readStatRows, recordPlayerStats, statsCtxOf, statsMismatch } from "./golden-stats.ts";
import {
  CURRENT_FORMAT,
  buildCorpus,
  corpusFormat,
  corpusStateDiff,
  extendCorpus,
  formatCorpusStateDiff,
  readCorpus,
  rebaselineCorpus,
  recomputeStream,
  storedFields,
  verifyStream,
  type GoldenCorpus,
  type GoldenEvent,
  type GoldenStream,
} from "./golden.ts";
import { defaultLineupPair } from "./helpers.ts";

const sport = (key: string): AnySportModule => builtinModules.find((m) => m.key === key)!;
const bytesOf = (corpus: GoldenCorpus): string => `${JSON.stringify(corpus, null, 0)}\n`;
const ev = (type: string, payload: unknown = {}, voids?: string): GoldenEvent => ({ type, payload, ...(voids === undefined ? {} : { voids }) });

/** The committed corpus as FORMAT 2 (summaries and overlay, no playerStats): the same bytes whether the files are in format 2 or 3. */
const formatTwoOf = (key: string): GoldenCorpus => asFormatTwo(readCorpus(key));
/** The committed corpus brought to format 3 by the real reformat, once per sport. */
const three = new Map<string, GoldenCorpus>();
const formatThreeOf = (key: string): GoldenCorpus => {
  let corpus = three.get(key);
  if (corpus === undefined) {
    corpus = reformatCorpus(sport(key), formatTwoOf(key), 3);
    three.set(key, corpus);
  }
  return corpus;
};

const rawOf = (module: AnySportModule): unknown => ({ ...(Object.values(readCorpus(module.key).configs)[0] as object) });

// ------------------------------------------------------------------------------------------------ the canonical text

describe("canonicalStatRows — one text for one set of rows", () => {
  const rows: PlayerStatRow[] = [
    { personId: "b", stats: { y: 1, x: 2 } },
    { personId: "a", stats: { z: 3 } },
  ];

  it("rows are ordered by personId and keys by name, so the order the fold happened to emit them in moves no byte", () => {
    const expected = '[{"personId":"a","stats":{"z":3}},{"personId":"b","stats":{"x":2,"y":1}}]';
    expect(canonicalStatRows(rows)).toBe(expected);
    expect(canonicalStatRows([...rows].reverse()), "rows reversed").toBe(expected);
    expect(canonicalStatRows(rows.map((r) => ({ ...r, stats: Object.fromEntries(Object.entries(r.stats).reverse()) }))), "keys reversed").toBe(expected);
  });

  it("the order is by code unit, never by locale: 'B' sorts before 'a' (the fold's own localeCompare would put 'a' first)", () => {
    expect(["a", "B"].sort((x, y) => x.localeCompare(y)), "precondition: the two orders differ here").toEqual(["a", "B"]);
    expect(canonicalStatRows([{ personId: "a", stats: { k: 1 } }, { personId: "B", stats: { K: 1, a: 2, B: 3 } }])).toBe('[{"personId":"B","stats":{"B":3,"K":1,"a":2}},{"personId":"a","stats":{"k":1}}]');
  });

  it("no rows is '[]' (the empty case), and a row with no stats keeps its person", () => {
    expect(canonicalStatRows([])).toBe("[]");
    expect(canonicalStatRows([{ personId: "p", stats: {} }])).toBe('[{"personId":"p","stats":{}}]');
  });

  it("a value that is not a finite number is refused by name, never written as null", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, "3" as unknown as number, null as unknown as number]) {
      expect(() => canonicalStatRows([{ personId: "p", stats: { saves: bad } }]), String(bad)).toThrow(/player stats: p\.saves is .*not a finite number/);
    }
    expect(canonicalStatRows([{ personId: "p", stats: { saves: 0, ratio: -0.5 } }])).toBe('[{"personId":"p","stats":{"ratio":-0.5,"saves":0}}]');
  });

  it("a person with two rows is refused: the fold cannot produce it, and sorting would hide it", () => {
    expect(() => canonicalStatRows([{ personId: "p", stats: { a: 1 } }, { personId: "p", stats: { a: 2 } }])).toThrow(/person "p" has two rows/);
  });

  it("readStatRows reads the canonical text back, and answers null for anything that is not rows", () => {
    expect(readStatRows(canonicalStatRows(rows))).toEqual([rows[1], rows[0]]);
    expect(readStatRows("[]")).toEqual([]);
    for (const bad of ["not json", "{}", "null", '[1]', '[null]', '[{"personId":1,"stats":{}}]', '[{"personId":"p"}]', '[{"personId":"p","stats":[]}]', '[{"personId":"p","stats":null}]']) {
      expect(readStatRows(bad), bad).toBeNull();
    }
  });
});

describe("movedStatKeys and statsMismatch — what a diff says about two recorded texts", () => {
  const a = canonicalStatRows([{ personId: "p", stats: { goals: 1, assists: 2 } }, { personId: "q", stats: { goals: 4 } }]);

  it("equal texts moved nothing; a changed value names its key, an added or dropped row every key it holds", () => {
    expect(movedStatKeys(a, a)).toEqual([]);
    expect(movedStatKeys(a, canonicalStatRows([{ personId: "p", stats: { goals: 2, assists: 2 } }, { personId: "q", stats: { goals: 4 } }]))).toEqual(["goals"]);
    expect(movedStatKeys(a, canonicalStatRows([{ personId: "p", stats: { goals: 1, assists: 2 } }]))).toEqual(["goals"]);
    expect(movedStatKeys(canonicalStatRows([]), a)).toEqual(["assists", "goals"]);
    expect(movedStatKeys(a, canonicalStatRows([{ personId: "p", stats: { goals: 1 } }, { personId: "q", stats: { goals: 4 } }]))).toEqual(["assists"]);
  });

  it("text that differs with no value moved is a key-order change, and text that is not rows is reported rather than skipped", () => {
    const reordered = '[{"personId":"q","stats":{"goals":4}},{"personId":"p","stats":{"assists":2,"goals":1}}]';
    expect(reordered).not.toBe(a);
    expect(movedStatKeys(a, reordered)).toEqual(["(key order)"]);
    expect(movedStatKeys(a, "nope")).toEqual(["(playerStats is not a list of rows)"]);
    expect(movedStatKeys("nope", a)).toEqual(["(playerStats is not a list of rows)"]);
  });

  it("statsMismatch names the person, the stat and both values; a row only one side holds is named as such", () => {
    const b = canonicalStatRows([{ personId: "p", stats: { goals: 3, assists: 2 } }, { personId: "r", stats: { goals: 1 } }]);
    const text = statsMismatch(a, b);
    expect(text).toContain("p goals: recorded 1, replayed 3");
    expect(text).toContain('q has no row in the replay (recorded {"goals":4})');
    expect(text).toContain('r is a new row in the replay ({"goals":1})');
    expect(text).not.toContain("assists");
    expect(statsMismatch(a, canonicalStatRows([{ personId: "p", stats: { goals: 1 } }, { personId: "q", stats: { goals: 4 } }]))).toContain("p assists: recorded 2, replayed none");
    expect(statsMismatch(a, "nope")).toBe(`recorded ${a}, replayed nope`);
    expect(statsMismatch(a, '[{"personId":"q","stats":{"goals":4}},{"personId":"p","stats":{"assists":2,"goals":1}}]')).toMatch(/no value did \(a key-order change\)/);
  });
});

// ----------------------------------------------------------------------------------------- the ctx and the hand-built ledger

describe("statsCtxOf — the fold ctx the server builds for one fixture", () => {
  it("every sport: the fixture's own two entrants, of the kind the sport DECLARES, whose persons are the team sheet's (counted)", () => {
    let checked = 0;
    forEachSport(({ module }) => {
      const cfg = module.configSchema.parse(rawOf(module));
      const lineups = defaultLineupPair(resolvePositions(module, cfg));
      const ctx = statsCtxOf(module, cfg, lineups);
      // the kind is read off the module's raw declaration, not through the helper under test
      const declared = module.entrantModel?.defaultKind ?? module.entrantModel?.kinds?.[0] ?? "individual";
      expect(ctx.entrants, module.key).toEqual([
        { id: lineups.home.entrantId, kind: declared },
        { id: lineups.away.entrantId, kind: declared },
      ]);
      expect(ctx.personsOf(lineups.home.entrantId), module.key).toEqual(lineups.home.slots.map((s) => s.personId));
      expect(ctx.personsOf(lineups.away.entrantId), module.key).toEqual(lineups.away.slots.map((s) => s.personId));
      expect(ctx.personsOf("nobody"), `${module.key}: an entrant the fixture does not have credits nobody`).toEqual([]);
      expect(ctx.cfg, module.key).toBe(cfg);
      expect(ctx.personsOf(lineups.home.entrantId).length, `${module.key}: a sheet with persons`).toBeGreaterThan(0);
      checked++;
    });
    expect(checked).toBe(builtinModules.length);
  });

  it("the sports do not all declare one kind (so the sweep above can tell a hard-coded kind from the declared one)", () => {
    const kinds = new Set(builtinModules.map((m) => m.entrantModel?.defaultKind ?? m.entrantModel?.kinds?.[0] ?? "individual"));
    expect(kinds.size).toBeGreaterThan(1);
  });
});

describe("recordPlayerStats — a hand-built ledger with rows written out by hand from the declared model", () => {
  // single module: the wiring of the recorder is sport-independent; the sweeps below cover every sport. A toy model so the
  // expected rows are arithmetic on the DECLARATION (a goal credits its scorer, a sum adds its payload, an award credits +1 under
  // `<key>_awards`, a derived stat is computed per row), not output copied from the fold.
  const football = sport("football");
  const toy = {
    ...football,
    playerStats: {
      metrics: [
        { key: "goals", label: "Goals", from: "toy.goal", field: "scorer", agg: "count" },
        { key: "saves", label: "Saves", from: "toy.save", field: "person", agg: "sum", sumField: "n" },
      ],
      derived: [{ key: "points", label: "Points", derive: (s: Record<string, number>) => (s.goals ?? 0) * 2 }],
      awards: [{ key: "mvp", label: "MVP" }],
    },
  } as unknown as AnySportModule;
  const cfg = football.configSchema.parse({});
  const lineups = defaultLineupPair(resolvePositions(football, cfg));
  const envelopes = (events: GoldenEvent[]) => events.map((e, i) => makeEnvelope(i, e, e.voids));
  const ledger: GoldenEvent[] = [
    ev("toy.goal", { scorer: "b" }), //                  e-0
    ev("toy.goal", { scorer: "a" }), //                  e-1
    ev("toy.goal", { scorer: "a" }), //                  e-2  (struck below)
    ev("core.void", {}, "e-2"), //                       e-3
    ev("toy.save", { person: "B", n: 3 }), //            e-4
    ev("core.award", { person: "a", key: "mvp" }), //    e-5  a declared award
    ev("core.award", { person: "zed", key: "nope" }), // e-6  a key the model does not declare credits nobody
  ];

  it("the rows are the arithmetic of the declaration: a struck goal takes its credit back, an award adds one under <key>_awards, an undeclared award credits nobody", () => {
    expect(recordPlayerStats(toy, cfg, lineups, envelopes(ledger))).toBe(
      '[{"personId":"B","stats":{"points":0,"saves":3}},{"personId":"a","stats":{"goals":1,"mvp_awards":1,"points":2}},{"personId":"b","stats":{"goals":1,"points":2}}]',
    );
  });

  it("the sequence matters: the same ledger WITHOUT the void gives a again its second goal (the control that the void is what moved it)", () => {
    const unstruck = ledger.filter((e) => e.voids === undefined);
    expect(recordPlayerStats(toy, cfg, lineups, envelopes(unstruck))).toContain('{"personId":"a","stats":{"goals":2,"mvp_awards":1,"points":4}}');
  });

  it("the empty case: no events, no rows; and a sport with no stat model records no rows however many events there are", () => {
    expect(recordPlayerStats(toy, cfg, lineups, [])).toBe("[]");
    const bare = { ...football, playerStats: undefined } as unknown as AnySportModule;
    expect(recordPlayerStats(bare, cfg, lineups, envelopes(ledger))).toBe("[]");
    expect(recordPlayerStats(toy, cfg, lineups, envelopes(ledger)), "control: the same ledger WITH a model has rows").not.toBe("[]");
  });

  it("every builtin sport declares a stat model, so the '[]' above is never what a real corpus records for want of one", () => {
    expect(builtinModules.filter((m) => m.playerStats === undefined).map((m) => m.key)).toEqual([]);
    expect(builtinModules.length).toBeGreaterThan(0);
  });
});

// ------------------------------------------------------------------------------------------------ recomputeStream formats

describe("recomputeStream — the three formats", () => {
  it("format 1 is the legacy four fields, format 2 adds summaries, overlay and the dense form, format 3 adds playerStats", () => {
    const module = sport("generic");
    const raw = rawOf(module);
    const events = [ev("core.start")];
    expect(Object.keys(recomputeStream(module, raw, events, undefined, 1))).toEqual(["states", "outcome", "summary", "deltas"]);
    expect(Object.keys(recomputeStream(module, raw, events, undefined, 2))).toEqual(["states", "outcome", "summary", "deltas", "summaries", "overlay", "dense"]);
    expect(Object.keys(recomputeStream(module, raw, events, undefined, 3))).toEqual(["states", "outcome", "summary", "deltas", "summaries", "overlay", "dense", "playerStats"]);
  });

  it("storedFields writes playerStats last and never the dense overlay; a format-2 recomputation stores none", () => {
    const module = sport("generic");
    const raw = rawOf(module);
    const events = [ev("core.start")];
    expect(Object.keys(storedFields(recomputeStream(module, raw, events, undefined, 3)))).toEqual(["states", "outcome", "summary", "deltas", "summaries", "overlay", "playerStats"]);
    expect(Object.keys(storedFields(recomputeStream(module, raw, events, undefined, 2)))).toEqual(["states", "outcome", "summary", "deltas", "summaries", "overlay"]);
    expect(Object.keys(storedFields(recomputeStream(module, raw, events, undefined, 1)))).toEqual(["states", "outcome", "summary", "deltas"]);
  });

  it("the four old fields and the kernel fields are the SAME bytes in format 3 as in format 2 (a reformat adds, it never rewrites)", () => {
    forEachSport(({ module }) => {
      const corpus = formatTwoOf(module.key);
      const stream = corpus.streams.at(-1)!;
      const raw = corpus.configs[stream.config];
      const f2 = recomputeStream(module, raw, stream.events, stream.lineups, 2);
      const f3 = recomputeStream(module, raw, stream.events, stream.lineups, 3);
      for (const key of ["states", "outcome", "summary", "deltas", "summaries", "overlay"] as const) expect(f3[key], `${module.key} ${key}`).toEqual(f2[key]);
    });
  }, sweepBudget("probe"));

  it("an empty ledger records the empty rows in format 3 and nothing in format 2", () => {
    const module = sport("generic");
    expect(recomputeStream(module, rawOf(module), [], undefined, 3).playerStats).toBe("[]");
    expect(recomputeStream(module, rawOf(module), [], undefined, 2).playerStats).toBeUndefined();
  });
});

// ----------------------------------------------------------------------------- every committed stream, swept and counted

/** The goals an independent reading of a football ledger gives each player: one per `football.goal` that names a scorer and is not
 *  an own goal, less the goals a later `core.void` strikes. The metric's declared meaning, counted with no call into the fold. */
function footballGoals(events: readonly GoldenEvent[]): Map<string, number> {
  const struck = new Set<number>();
  for (let i = events.length - 1; i >= 0; i--) {
    const target = events[i]!.voids;
    if (events[i]!.type === "core.void" && target !== undefined && !struck.has(i)) struck.add(Number(target.slice(2)));
  }
  const goals = new Map<string, number>();
  events.forEach((event, i) => {
    const p = event.payload as { scorer?: string; ownGoal?: boolean };
    if (event.type !== "football.goal" || struck.has(i) || p.scorer === undefined || p.ownGoal === true) return;
    goals.set(p.scorer, (goals.get(p.scorer) ?? 0) + 1);
  });
  return goals;
}

describe("player stats over every committed stream (swept, counted)", () => {
  const totals = { streams: 0, withRows: 0, rows: 0, compared: 0, footballGoalStreams: 0 };
  const perSport = new Map<string, { streams: number; withRows: number }>();

  for (const module of builtinModules) {
    it(`${module.key}: the recorded rows are the stats fold's own, for every stream, and a format-3 corpus holds exactly them`, () => {
      const committed = readCorpus(module.key);
      let withRows = 0;
      committed.streams.forEach((stream, index) => {
        const raw = committed.configs[stream.config];
        const cfg = module.configSchema.parse(raw);
        const lineups = stream.lineups ?? defaultLineupPair(resolvePositions(module, cfg));
        const label = `${module.key} ${stream.config}#${stream.seed}`;
        const recorded = recomputeStream(module, raw, stream.events, stream.lineups, 3).playerStats;
        expect(recorded, label).toBeDefined();
        // the fold, asked independently: the ctx is built here from the raw declaration, and the rows are sorted here
        const kind = module.entrantModel?.defaultKind ?? module.entrantModel?.kinds?.[0] ?? "individual";
        const rows = aggregatePlayerStats(
          stream.events.map((e, i) => makeEnvelope(i, e, e.voids)),
          module.playerStats!,
          lineups,
          {
            entrants: [lineups.home, lineups.away].map((s) => ({ id: s.entrantId, kind })),
            personsOf: (id) => [lineups.home, lineups.away].find((s) => s.entrantId === id)?.slots.map((slot) => slot.personId) ?? [],
            cfg,
          },
        );
        const sorted = [...rows].sort((a, b) => (a.personId < b.personId ? -1 : a.personId > b.personId ? 1 : 0));
        expect(JSON.parse(recorded!) as unknown, label).toEqual(sorted.map((r) => ({ personId: r.personId, stats: r.stats })));
        if (rows.length > 0) withRows++;
        totals.rows += rows.length;
        // a corpus already in format 3 holds exactly this, to the byte
        if (corpusFormat(committed) === 3) {
          expect(committed.streams[index]!.playerStats, `${label} (committed)`).toBe(recorded);
          totals.compared++;
        }
        // an independent count of the one stat whose meaning is a single declared line: football goals
        if (module.key === "football") {
          const expected = footballGoals(stream.events);
          const got = new Map((JSON.parse(recorded!) as PlayerStatRow[]).filter((r) => r.stats.goals !== undefined).map((r) => [r.personId, r.stats.goals!]));
          expect(Object.fromEntries(got), `${label}: goals`).toEqual(Object.fromEntries(expected));
          if (expected.size > 0) totals.footballGoalStreams++;
        }
        totals.streams++;
      });
      perSport.set(module.key, { streams: committed.streams.length, withRows });
      totals.withRows += withRows;
      expect(committed.streams.length).toBeGreaterThan(0);
      expect(withRows, `${module.key}: streams whose stat rows are non-empty (a recorder that always wrote [] would pin nothing)`).toBeGreaterThan(0);
    }, sweepBudget("probe", 3));
  }

  it("the sweep covered every sport, every stream and some rows; football's goals were counted independently on streams with goals", () => {
    expect(perSport.size).toBe(builtinModules.length);
    expect(totals.streams).toBe(builtinModules.reduce((n, m) => n + readCorpus(m.key).streams.length, 0));
    expect(totals.rows).toBeGreaterThan(totals.streams);
    expect(totals.footballGoalStreams, "football streams with at least one goal").toBeGreaterThan(0);
    const formats = new Set(builtinModules.map((m) => corpusFormat(readCorpus(m.key))));
    expect(formats.size, "one format per tree").toBe(1);
    expect(totals.compared === 0 || totals.compared === totals.streams, "committed rows are compared on all streams or on none").toBe(true);
  });
});

// ------------------------------------------------------------------------------------------------ verifyStream (format 3)

describe("verifyStream under format 3 — the rows are compared, and a missing field is a failure", () => {
  const module = sport("carrom"); // single sport: the message wiring is sport-independent; the sweeps above cover every sport
  let corpus!: GoldenCorpus;
  let stream!: GoldenStream;
  // built in beforeAll, not at collection: a broken reformat must red the NAMED tests below, not fail the whole file to collect
  beforeAll(() => {
    corpus = formatThreeOf("carrom");
    stream = corpus.streams.find((s) => (JSON.parse(s.playerStats!) as unknown[]).length > 1)!;
  });
  const verify = (patch: Partial<GoldenStream>, replayed?: Parameters<typeof verifyStream>[3]) => verifyStream(module, corpus, { ...stream, ...patch }, replayed);
  const rows = (): PlayerStatRow[] => readStatRows(stream.playerStats!)!;

  it("passes untouched (the control: the tamper cases below are not redded by something else)", () => {
    expect(stream, "a carrom stream with two rows or more").toBeDefined();
    expect(verify({})).toEqual([]);
  });

  it("a moved value names the person, the stat and both values", () => {
    const all = rows();
    const first = all[0]!;
    const key = Object.keys(first.stats)[0]!;
    const moved = [{ ...first, stats: { ...first.stats, [key]: first.stats[key]! + 1 } }, ...all.slice(1)];
    const out = verify({ playerStats: canonicalStatRows(moved) });
    expect(out).toHaveLength(1);
    expect(out[0]).toContain(`playerStats: the player stats moved: ${first.personId} ${key}: recorded ${first.stats[key]! + 1}, replayed ${first.stats[key]}`);
  });

  it("a dropped row and an invented one are both named", () => {
    const all = rows();
    expect(verify({ playerStats: canonicalStatRows(all.slice(1)) }).join("\n")).toContain(`${all[0]!.personId} is a new row in the replay`);
    expect(verify({ playerStats: canonicalStatRows([...all, { personId: "ghost", stats: { wins: 1 } }]) }).join("\n")).toContain("ghost has no row in the replay");
  });

  it("a text of the same rows in another key order is still a finding (the record is the canonical text, byte for byte)", () => {
    const text = stream.playerStats!;
    const reversed = JSON.stringify([...(JSON.parse(text) as unknown[])].reverse());
    expect(reversed).not.toBe(text);
    expect(verify({ playerStats: reversed }).join("\n")).toMatch(/no value did \(a key-order change\)/);
  });

  it("a missing field, and a replay that produced none, are failures, not 'nothing moved'", () => {
    const { playerStats: _dropped, ...without } = stream;
    expect(verifyStream(module, corpus, without as GoldenStream)[0]).toMatch(/a format-3 corpus stream must record playerStats/);
    const two = recomputeStream(module, corpus.configs[stream.config], stream.events, stream.lineups, 2);
    // a CALLER error (replayed in the wrong format), not a finding about the corpus: it throws instead of returning a message
    expect(() => verify({}, two)).toThrow(/the replay produced no playerStats, so a format-3 stream cannot be verified/);
  });

  it("a format-2 or format-1 corpus stream that holds playerStats is a hybrid: refused (absence can only mean an earlier format)", () => {
    const f2 = formatTwoOf("carrom");
    const hybrid2 = { ...f2.streams[0]!, playerStats: "[]" };
    expect(verifyStream(module, f2, hybrid2).join("\n")).toMatch(/format-2 stream carries playerStats/);
    const f1 = asFormatOne(readCorpus("carrom"));
    const hybrid1 = { ...f1.streams[0]!, playerStats: "[]" };
    expect(verifyStream(module, f1, hybrid1).join("\n")).toMatch(/format-1 stream carries playerStats/);
    // the control: the same streams without the field verify clean
    expect(verifyStream(module, f2, f2.streams[0]!)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------- the reformat

describe("reformatCorpus to format 3 — adds playerStats and moves nothing the corpus already holds", () => {
  let streamsSeen = 0;
  let withRows = 0;
  for (const module of builtinModules) {
    it(`${module.key}: every pre-existing field byte-identical, playerStats last, format 3 before streams, a second run a no-op`, () => {
      const before = formatTwoOf(module.key);
      const after = formatThreeOf(module.key);
      expect(corpusFormat(after)).toBe(3);
      expect(Object.keys(after)).toEqual([...Object.keys(before).filter((k) => k !== "streams" && k !== "format"), "format", "streams"]);
      expect(after.format).toBe(3);
      for (const key of Object.keys(before).filter((k) => k !== "streams" && k !== "format")) {
        expect(JSON.stringify((after as unknown as Record<string, unknown>)[key]), `${module.key} ${key}`).toBe(JSON.stringify((before as unknown as Record<string, unknown>)[key]));
      }
      expect(after.streams.length).toBe(before.streams.length);
      before.streams.forEach((was, i) => {
        const now = after.streams[i]!;
        expect(Object.keys(now), `${module.key} #${i}`).toEqual([...Object.keys(was), "playerStats"]);
        for (const key of Object.keys(was) as (keyof GoldenStream)[]) expect(JSON.stringify(now[key]), `${module.key} #${i} ${key}`).toBe(JSON.stringify(was[key]));
        expect(readStatRows(now.playerStats!), `${module.key} #${i}`).not.toBeNull();
        if (now.playerStats !== "[]") withRows++;
        streamsSeen++;
      });
      expect(after.streams.length).toBeGreaterThan(0);
      expect(bytesOf(reformatCorpus(module, after, 3))).toBe(bytesOf(after));
      expect(bytesOf(after).length).toBeGreaterThan(bytesOf(before).length);
    }, 120_000);
  }

  it("the sweep covered every sport, every stream, and some real rows", () => {
    expect(streamsSeen).toBe(builtinModules.reduce((n, m) => n + readCorpus(m.key).streams.length, 0));
    expect(withRows).toBeGreaterThan(builtinModules.length);
  });

  it("a format-1 corpus reaches format 3 in one step, to the same bytes as format 1 -> 2 -> 3 (the order the fields are added in is the format's)", () => {
    const module = sport("generic");
    const one = asFormatOne(readCorpus("generic"));
    const direct = reformatCorpus(module, one, 3);
    expect(bytesOf(direct)).toBe(bytesOf(formatThreeOf("generic")));
    expect(bytesOf(reformatCorpus(module, reformatCorpus(module, one, 2), 3))).toBe(bytesOf(direct));
    expect(Object.keys(direct.streams[0]!).slice(-3)).toEqual(["summaries", "overlay", "playerStats"]);
  }, 120_000);

  it("a corpus is never reformatted DOWN, and target 1 is not a reformat at all", () => {
    const module = sport("generic");
    expect(() => reformatCorpus(module, formatThreeOf("generic"), 2)).toThrow(/format 3.*format 2.*never goes back/s);
    expect(() => reformatCorpus(module, formatTwoOf("generic"), 1)).toThrow(/never goes back|nothing to reformat to/);
    expect(bytesOf(reformatCorpus(module, formatTwoOf("generic"), 2)), "same format: a no-op after verifying").toBe(bytesOf(formatTwoOf("generic")));
  });

  it("it is NEVER a re-baseline: a pre-existing field that would move, or a stale playerStats, refuses the run (and a stale record is never repaired)", () => {
    const module = sport("generic");
    const two = formatTwoOf("generic");
    const tampered = (patch: Partial<GoldenStream>): GoldenCorpus => ({ ...two, streams: [{ ...two.streams[0]!, ...patch }, ...two.streams.slice(1)] });
    expect(() => reformatCorpus(module, tampered({ outcome: '{"kind":"draw"}' }), 3)).toThrow(/that is a re-baseline, not a reformat[\s\S]*outcome: recorded/);
    expect(() => reformatCorpus(module, tampered({ summaries: two.streams[0]!.summaries!.map(() => "#0000000000000000") }), 3)).toThrow(/summary after event 0/);
    const good = formatThreeOf("generic");
    const stale: GoldenCorpus = { ...good, streams: [{ ...good.streams[0]!, playerStats: '[{"personId":"ghost","stats":{"wins":9}}]' }, ...good.streams.slice(1)] };
    expect(() => reformatCorpus(module, stale, 3)).toThrow(/playerStats: the player stats moved/);
    const { playerStats: _dropped, ...without } = good.streams[0]!;
    expect(() => reformatCorpus(module, { ...good, streams: [without as GoldenStream, ...good.streams.slice(1)] }, 3)).toThrow(/must record playerStats/);
    expect(() => reformatCorpus(module, { ...two, streams: [] }, 3)).toThrow(/no streams/);
  }, 120_000);
});

describe("reformatAll to format 3 — all sports or none", () => {
  it("every sport reformats: one plan entry per module, each the corpus reformatCorpus gives on its own, from format 2", () => {
    const plan = reformatAll([sport("generic")], formatTwoOf, 3);
    expect(plan).toHaveLength(1);
    expect(bytesOf(plan[0]!.after)).toBe(bytesOf(formatThreeOf("generic")));
    expect(corpusFormat(plan[0]!.before)).toBe(2);
  }, 120_000);

  it("one sport refusing throws for the whole run and names it", () => {
    const tampered = (c: GoldenCorpus): GoldenCorpus => ({ ...c, streams: [{ ...c.streams[0]!, outcome: '{"kind":"draw"}' }, ...c.streams.slice(1)] });
    const read = (key: string): GoldenCorpus => (key === "carrom" ? tampered(formatTwoOf(key)) : formatTwoOf(key));
    expect(() => reformatAll([sport("generic"), sport("carrom")], read, 3)).toThrow(/wrote nothing: 1 of 2 sport\(s\) refused[\s\S]*carrom config=/);
  }, 120_000);
});

// ------------------------------------------------------------------------------------------------ the reviewed state diff

describe("corpusStateDiff — the player stats are part of the reviewed diff", () => {
  const module = sport("generic");
  let two!: GoldenCorpus;
  let after!: GoldenCorpus;
  beforeAll(() => {
    two = formatTwoOf("generic");
    after = formatThreeOf("generic");
  });

  it("a 2 -> 3 reformat moves nothing and says how many streams were newly recorded", () => {
    const diff = corpusStateDiff(two, after, module);
    expect(diff.changedStreams).toBe(0);
    expect(diff.eventsMoved).toBe(false);
    expect(diff.streamsRecorded).toBe(two.streams.length);
    expect(diff.streamsRecorded).toBeGreaterThan(0);
    expect(diff.streamsDropped).toBe(0);
    expect(formatCorpusStateDiff(diff)).toMatch(/nothing moved/);
  });

  it("a moved stat is listed per stream by the key that moved, and a stream newly recorded in the same diff lists nothing", () => {
    const first = after.streams.find((s) => s.playerStats !== "[]")!;
    const index = after.streams.indexOf(first);
    const rows = readStatRows(first.playerStats!)!;
    const key = Object.keys(rows[0]!.stats)[0]!;
    const bumped = canonicalStatRows([{ ...rows[0]!, stats: { ...rows[0]!.stats, [key]: rows[0]!.stats[key]! + 1 } }, ...rows.slice(1)]);
    const moved: GoldenCorpus = { ...after, streams: after.streams.map((s, i) => (i === index ? { ...s, playerStats: bumped } : s)) };
    const diff = corpusStateDiff(after, moved, module);
    expect(diff.changedStreams).toBe(1);
    expect(diff.streams[0]!.statsKeysMoved).toEqual([key]);
    expect(diff.streams[0]!.index).toBe(index);
    expect(diff.streams[0]!.outcomeMoved || diff.streams[0]!.summaryMoved || diff.streams[0]!.deltasMoved).toBe(false);
    expect(formatCorpusStateDiff(diff)).toContain(`stats=[${key}]`);
    expect(diff.streamsRecorded).toBe(0);
    // a stream that gained the field in this very diff is "newly recorded", not "moved"
    const mixed = corpusStateDiff(two, moved, module);
    expect(mixed.changedStreams).toBe(0);
    expect(mixed.streamsRecorded).toBe(two.streams.length);
  });

  it("fields that VANISH (format 3 -> 2) are flagged, never reported as nothing moved", () => {
    const diff = corpusStateDiff(after, two, module);
    expect(diff.streamsDropped).toBe(after.streams.length);
    expect(formatCorpusStateDiff(diff)).toContain("RECORDED FIELDS DROPPED");
    expect(formatCorpusStateDiff(corpusStateDiff(after, asFormatOne(after), module))).toContain("RECORDED FIELDS DROPPED");
  });
});

// -------------------------------------------------------------------- the other writers keep the corpus's format (3)

describe("the other writers record playerStats when the corpus is format 3", () => {
  it("buildCorpus (UPDATE_GOLDEN, a corpus from nothing) writes the current format, and CURRENT_FORMAT is 3", () => {
    expect(CURRENT_FORMAT).toBe(3);
    const module = sport("generic"); // single sport: generation costs seconds per module and this checks wiring
    const corpus = buildCorpus(module);
    expect(corpusFormat(corpus)).toBe(CURRENT_FORMAT);
    expect(Object.keys(corpus).slice(-2)).toEqual(["format", "streams"]);
    expect(corpus.streams.length).toBeGreaterThan(0);
    for (const s of corpus.streams) {
      expect(Object.keys(s), `${s.config}#${s.seed}`).toEqual(expect.arrayContaining(["summaries", "overlay", "playerStats"]));
      expect(Object.keys(s)).not.toContain("dense");
      expect(verifyStream(module, corpus, s), `${s.config}#${s.seed}`).toEqual([]);
    }
  }, 60_000);

  it("rebaselineCorpus keeps format 3, re-records a stale playerStats, and the diff names the stat key", () => {
    const module = sport("generic");
    const good = formatThreeOf("generic");
    expect(bytesOf(rebaselineCorpus(module, good))).toBe(bytesOf(good));
    const index = good.streams.findIndex((s) => s.playerStats !== "[]");
    const rows = readStatRows(good.streams[index]!.playerStats!)!;
    const key = Object.keys(rows[0]!.stats)[0]!;
    const stale: GoldenCorpus = {
      ...good,
      streams: good.streams.map((s, i) => (i === index ? { ...s, playerStats: canonicalStatRows([{ ...rows[0]!, stats: { ...rows[0]!.stats, [key]: 99 } }, ...rows.slice(1)]) } : s)),
    };
    const fixed = rebaselineCorpus(module, stale);
    expect(fixed.streams[index]!.playerStats).toBe(good.streams[index]!.playerStats);
    expect(corpusFormat(fixed)).toBe(3);
    expect(corpusStateDiff(stale, fixed, module).streams[0]!.statsKeysMoved).toEqual([key]);
  }, 60_000);

  const key = "badminton"; // the sport golden-slim's extend test already uses: small, with a generator walk to drop
  const walks = (c: GoldenCorpus): GoldenStream[] => c.streams.filter((s) => s.seed < FLOOR_SEED_STRIDE);

  it("extendCorpus appends format-3 streams to a format-3 corpus and format-2 streams to a format-2 one, and each verifies", () => {
    const module = sport(key);
    let appendedTotal = 0;
    for (const base of [formatTwoOf(key), formatThreeOf(key)]) {
      const dropped = walks(base).at(-1)!;
      const trimmed: GoldenCorpus = { ...base, streams: base.streams.filter((s) => s !== dropped) };
      const { corpus, appended } = extendCorpus(module, trimmed);
      expect(appended.length, `format ${corpusFormat(base)}: nothing appended, so this proves nothing`).toBeGreaterThan(0);
      const fresh = corpus.streams.slice(trimmed.streams.length);
      for (const stream of fresh) {
        expect("playerStats" in stream, `format ${corpusFormat(base)}`).toBe(corpusFormat(base) === 3);
        expect(verifyStream(module, corpus, stream), `${stream.config}#${stream.seed}`).toEqual([]);
      }
      expect(corpus.streams.slice(0, trimmed.streams.length)).toEqual(trimmed.streams);
      appendedTotal += fresh.length;
    }
    expect(appendedTotal).toBeGreaterThanOrEqual(2);
  }, 60_000);

  it("extendFloor, from a format-3 corpus without its floor streams, reproduces the committed floor streams WITH playerStats", () => {
    const module = sport(key);
    const committed3 = formatThreeOf(key);
    const first = committed3.streams.findIndex((s) => s.seed >= FLOOR_SEED_STRIDE);
    expect(first, `${key} has floor streams`).toBeGreaterThan(0);
    const base: GoldenCorpus = { ...committed3, streams: committed3.streams.slice(0, first) };
    const result = extendFloor(module, base);
    const expected = committed3.streams.slice(first).filter((s) => s.seed >= FLOOR_SEED_STRIDE);
    expect(result.appended.length).toBe(expected.length);
    expect(result.appended.length).toBeGreaterThan(0);
    expect(result.corpus.streams.slice(first)).toEqual(expected);
    for (const stream of result.corpus.streams.slice(first)) expect(typeof stream.playerStats, `${stream.config}#${stream.seed}`).toBe("string");
  }, 60_000);
});
