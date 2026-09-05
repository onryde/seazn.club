// Spectator surface W1, task 7 — the Timeline and the Sets / Periods table for
// every sport that is NOT cricket. Design:
// docs/superpowers/specs/2026-09-04-spectator-surface-design.md §W1
// ("Every other sport in W1").
//
// The coverage test at the bottom derives its event-type set from the ENGINE'S
// OWN GOLDEN CORPORA (`packages/engine/src/sports/**/<key>.golden.json`, the
// eleven files GOLDEN-POLICY.md calls "the engine's only back-compat tripwire"),
// never from a list typed in here — a new recorded event type therefore cannot
// ship unlocalised, which is the property the design asks for.
//
// ---------------------------------------------------------------------------
// Mutants killed (Task 7)
// ---------------------------------------------------------------------------
// Applied by hand to `../timeline.ts`, run, observed red, restored from a `cp`
// backup (never `git checkout`, which would have restored the index over the
// uncommitted implementation).
//
//  (i) DROP THE NEUTRAL FALLBACK — pass 1 of `buildTimeline` became
//      `active.filter((e) => TIMELINE_KEY_FOR[e.type] !== undefined).map(…)`,
//      so a type with no template renders nothing at all.
//      → RED (2): "an event type with no template renders the neutral line,
//        never nothing" and "EVERY recorded event produces exactly one line".
//
//  (j) SORT ASCENDING — `lines.sort((a, b) => b.ordinal - a.ordinal)` became
//      `lines.sort((a, b) => a.ordinal - b.ordinal)`.
//      → RED (2): "newest first: seq descending" and "a derived line sorts
//        ABOVE the event that caused it".
//
// Two more, because a guard nothing kills is not tested and these are the two
// places a wrong answer would look plausible:
//
//  (k) `closedMask: sets.map((s) => s.closed)` became `sets.map(() => true)`.
//      → RED: "tennis: kind sets, one column per set, closed mask from
//        detail.sets[].closed" — which is why that test insists on a golden
//        stream with a MIXED mask rather than any stream with sets.
//
//  (m) `const winner: 0 | 1 = set.home >= set.away ? 0 : 1;` became
//      `const winner: 0 | 1 = 0;`.
//      → RED: "racket sports: a set transition line is derived…" — which is why
//        the tennis ledger closes one set for EACH side rather than two for one.
//
//  (n) RE-STATE THE NAMESPACE — `const FOOTBALL = "timeline.football."` became
//      `"public.timeline.football."`, the convention slip this file's own
//      "keys are BARE" test exists for.
//      → RED (7), that test among them. It matters that it is in the list: a
//        key spelled `public.timeline.…` still RESOLVES, because `lookup()`
//        tries the literal flat key first, so nothing about rendering would
//        have caught it.
//
// All five compile and collect (`numTotalTests` unchanged in every run — 21
// before the convention test was added, 22 after), so none is the
// collection-break shape that reads as a survivor.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EngineError, type EventEnvelope, type ScoreSummary } from "@seazn/engine/core";
import { registry, resolvePositions, type AnySportModule } from "@seazn/engine/sport";
import { registerBuiltins } from "@seazn/engine/sports";
import { defaultLineupPair } from "@seazn/engine/testkit";
import { SetsView, TimelineLine, type PersonT, type SideT } from "../match-centre-schema";
import { TIMELINE_KEY_FOR, buildSets, buildTimeline, type TimelineArgs } from "../timeline";

// --------------------------------------------------------------------- setup

try {
  registerBuiltins(registry);
} catch (err) {
  // Another suite in this worker already booted the shared default registry.
  if (!EngineError.is(err, "MODULE_DUPLICATE")) throw err;
}

const HERE = dirname(fileURLToPath(import.meta.url));
// __tests__ -> public-site -> server -> src -> web -> apps -> repo root.
const ENGINE_SPORTS = join(HERE, "../../../../../../packages/engine/src/sports");
const DICT_DIR = join(HERE, "../../../dictionaries");
const LOCALES = ["en", "es", "fr", "nl"] as const;

/** The golden corpora, keyed by sport. GOLDEN-POLICY.md: "The eleven
 *  `sports/**\/<key>.golden.json` files". Found by walking the tree rather than
 *  by a pinned list, so a twelfth module's corpus is picked up automatically. */
interface GoldenStream {
  config: string;
  events: { type: string; payload: unknown }[];
  summary: string;
}
interface GoldenCorpus {
  key: string;
  configs: Record<string, unknown>;
  streams: GoldenStream[];
}

function readCorpora(): GoldenCorpus[] {
  const out: GoldenCorpus[] = [];
  for (const dir of readdirSync(ENGINE_SPORTS, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    for (const file of readdirSync(join(ENGINE_SPORTS, dir.name))) {
      if (!file.endsWith(".golden.json")) continue;
      out.push(JSON.parse(readFileSync(join(ENGINE_SPORTS, dir.name, file), "utf8")));
    }
  }
  return out;
}

const CORPORA = readCorpora();
const corpusFor = (key: string): GoldenCorpus => {
  const found = CORPORA.find((c) => c.key === key);
  if (!found) throw new Error(`no golden corpus for "${key}"`);
  return found;
};
/** The recorded summary of a corpus stream — the engine's own frozen truth,
 *  so `buildSets` is tested against what the kernel really produces. */
const summaryOf = (stream: GoldenStream): ScoreSummary =>
  JSON.parse(stream.summary) as ScoreSummary;

const dictOf = (locale: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(DICT_DIR, locale, "public.json"), "utf8"));
const DICTS = Object.fromEntries(LOCALES.map((l) => [l, dictOf(l)])) as Record<
  (typeof LOCALES)[number],
  Record<string, unknown>
>;

// Golden streams record entrants as "H" / "A" and persons as "H-p1".
const SIDES: [SideT, SideT] = [
  { entrantId: "H", name: "Harbour Rovers", short: "HAR", colour: null, badgeUrl: null },
  { entrantId: "A", name: "Avenue Athletic", short: "AVE", colour: null, badgeUrl: null },
];
const personOf = (personId: string): PersonT => ({
  personId,
  name: `Player ${personId}`,
  masked: false,
});

const moduleFor = (key: string): AnySportModule => registry.latest(key);

/** The RAW config the corpus recorded under "default", parsed by the module —
 *  `configSchema.parse({})` is not a substitute: generic's schema has no
 *  defaults for `resultMode` / `allowDraws` and rejects an empty object. */
function defaultCfgFor(key: string): unknown {
  const mod = moduleFor(key);
  const configs = corpusFor(key).configs;
  const raw = "default" in configs ? configs.default : Object.values(configs)[0];
  return mod.configSchema.parse(raw);
}

function env(seq: number, type: string, payload: unknown): EventEnvelope {
  return {
    id: `e-${seq}`,
    fixtureId: "fx-timeline",
    seq,
    type,
    payload,
    recordedAt: `2026-09-04T12:${String(seq).padStart(2, "0")}:00.000Z`,
    recordedBy: null,
  };
}

/** Envelopes for a whole golden stream, in recorded order. */
function envelopesOf(stream: GoldenStream): EventEnvelope[] {
  return stream.events.map((e, i) => env(i, e.type, e.payload));
}

function args(over: Partial<TimelineArgs> & { sportKey?: string }): TimelineArgs {
  const sportKey = over.sportKey ?? "generic";
  const mod = over.module ?? moduleFor(sportKey);
  const cfg = over.cfg ?? defaultCfgFor(sportKey);
  return {
    sportKey,
    events: over.events ?? [],
    module: mod,
    cfg,
    lineups: over.lineups ?? defaultLineupPair(resolvePositions(mod, cfg)),
    sides: over.sides ?? SIDES,
    personOf: over.personOf ?? personOf,
  };
}

/** A golden stream chosen by what it CONTAINS, never by a pinned index — the
 *  corpus grows by sanctioned EXTEND_GOLDEN passes and indices move. */
function streamWhere(key: string, pred: (s: GoldenStream) => boolean): GoldenStream {
  const found = corpusFor(key).streams.find(pred);
  if (!found) throw new Error(`no "${key}" golden stream matching the predicate`);
  return found;
}

// A football ledger written by hand: the corpus records coarse goals with no
// `minute`, and the marker is exactly what this asserts.
const footballLedger: EventEnvelope[] = [
  env(0, "core.start", {}),
  env(1, "football.goal", { by: "H", scorer: "H-p9", assist: "H-p7", minute: 23 }),
  env(2, "football.card", { by: "A", person: "A-p4", color: "yellow", minute: 31 }),
  env(3, "football.period", { phase: "HT" }),
  env(4, "football.shootout.kick", { by: "H", person: "H-p9", scored: true }),
];

const tennisSetLedger: EventEnvelope[] = [
  env(0, "core.start", {}),
  env(1, "tennis.set_summary", { home: 6, away: 4 }),
  env(2, "tennis.set_summary", { home: 4, away: 6 }),
];

// ------------------------------------------------------------ buildTimeline

describe("buildTimeline", () => {
  it("EMPTY ledger → []", () => expect(buildTimeline(args({ events: [] }))).toEqual([]));

  it("football: goal, card, period and shoot-out kick each render their own key with side, minute and person", () => {
    const lines = buildTimeline(args({ sportKey: "football", events: footballLedger }));
    expect(lines.map((l) => l.text.key)).toEqual(
      expect.arrayContaining([
        "timeline.football.goal",
        "timeline.football.card",
        "timeline.football.period",
        "timeline.football.shootout.kick",
      ]),
    );
    const goal = lines.find((l) => l.text.key === "timeline.football.goal")!;
    expect(goal.sideIndex).toBe(0);
    expect(goal.marker).toBe("23'");
    // The side NAME rides in the params, not an entrant id and not an English
    // word — the line is rendered by t() client-side.
    expect(goal.text.params?.side).toBe("Harbour Rovers");
    expect(String(goal.text.params?.detail)).toContain("Player H-p9");

    const card = lines.find((l) => l.text.key === "timeline.football.card")!;
    expect(card.sideIndex).toBe(1);
    expect(card.marker).toBe("31'");
    expect(card.text.params?.colour).toBe("yellow");
  });

  it("EVERY recorded event produces exactly one line — a type with no template is never dropped", () => {
    const ledger = [...footballLedger, env(5, "some.future.type", {})];
    const lines = buildTimeline(args({ sportKey: "football", events: ledger }));
    // Derived lines may add more, never fewer: every recorded seq is present.
    for (const e of ledger) {
      expect(lines.filter((l) => l.seq === e.seq).length).toBeGreaterThanOrEqual(1);
    }
    expect(lines.length).toBeGreaterThanOrEqual(ledger.length);
  });

  it("newest first: seq descending", () => {
    const lines = buildTimeline(args({ sportKey: "football", events: footballLedger }));
    expect(lines.length).toBeGreaterThan(1);
    expect(lines[0]!.seq).toBe(4);
    expect(lines[0]!.seq).toBeGreaterThan(lines[1]!.seq);
    const seqs = lines.map((l) => l.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => b - a));
  });

  it("an event type with no template renders the neutral line, never nothing", () => {
    const lines = buildTimeline(args({ events: [env(0, "some.future.type", {})] }));
    expect(lines).toHaveLength(1);
    expect(lines[0]!.text.key).toBe("timeline.generic.event");
  });

  it("racket sports: a set transition line is derived by replaying the module and diffing summary.detail.sets", () => {
    const lines = buildTimeline(args({ sportKey: "tennis", events: tennisSetLedger }));
    expect(lines.some((l) => l.text.key === "timeline.set.won")).toBe(true);
    const won = lines.filter((l) => l.text.key === "timeline.set.won");
    // One per closed set, and the params carry NUMBERS and a SIDE NAME.
    expect(won).toHaveLength(2);
    const first = won.find((l) => l.text.params?.set === 1)!;
    expect(first.text.params).toMatchObject({
      set: 1,
      home: 6,
      away: 4,
      winner: "Harbour Rovers",
    });
    expect(first.sideIndex).toBe(0);
    const second = won.find((l) => l.text.params?.set === 2)!;
    expect(second.text.params?.winner).toBe("Avenue Athletic");
    expect(second.sideIndex).toBe(1);
  });

  it("period sports: a period-end line is derived when summary.detail.periods grows", () => {
    const lines = buildTimeline(args({ sportKey: "football", events: footballLedger }));
    const end = lines.filter((l) => l.text.key === "timeline.period.end");
    expect(end).toHaveLength(1);
    // H1 closed 1–0 at the half-time marker (seq 3).
    expect(end[0]!.text.params).toMatchObject({ phase: "H1", home: 1, away: 0 });
    expect(end[0]!.seq).toBe(3);
  });

  it("a derived line sorts ABOVE the event that caused it", () => {
    const lines = buildTimeline(args({ sportKey: "football", events: footballLedger }));
    const derived = lines.findIndex((l) => l.text.key === "timeline.period.end");
    const recorded = lines.findIndex((l) => l.text.key === "timeline.football.period");
    expect(derived).toBeGreaterThanOrEqual(0);
    expect(recorded).toBeGreaterThanOrEqual(0);
    expect(derived).toBeLessThan(recorded);
  });

  it("a ledger the module refuses still renders every recorded line (the replay degrades, it does not throw)", () => {
    // `football.shootout.kick` in the first half is WRONG_PHASE — the derived
    // pass stops there and the recorded pass is unaffected.
    const lines = buildTimeline(args({ sportKey: "football", events: footballLedger }));
    expect(lines.filter((l) => l.text.key === "timeline.football.shootout.kick")).toHaveLength(1);
  });

  it("replays a real golden stream of every non-cricket sport, one line per recorded event, every line schema-valid", () => {
    const keys = CORPORA.map((c) => c.key).filter((k) => k !== "cricket");
    expect(keys.length).toBeGreaterThanOrEqual(9);
    let validated = 0;
    for (const key of keys) {
      const mod = moduleFor(key);
      for (const stream of corpusFor(key).streams.slice(0, 3)) {
        const cfg = mod.configSchema.parse(corpusFor(key).configs[stream.config]);
        const lines = buildTimeline({
          sportKey: key,
          events: envelopesOf(stream),
          module: mod,
          cfg,
          lineups: defaultLineupPair(resolvePositions(mod, cfg)),
          sides: SIDES,
          personOf,
        });
        expect(lines.length).toBeGreaterThanOrEqual(stream.events.length);
        // The zod schema is the contract Task 6 consumes — parse, don't assume.
        for (const line of lines) {
          expect(TimelineLine.safeParse(line).success).toBe(true);
          validated++;
        }
      }
    }
    expect(validated).toBeGreaterThan(200);
  });
});

// ---------------------------------------------------------------- buildSets

describe("buildSets", () => {
  it("tennis: kind sets, one column per set, closed mask from detail.sets[].closed", () => {
    // A stream with a MIXED mask, so an "always closed" mutant cannot pass.
    const stream = streamWhere("tennis", (s) => {
      const sets = (summaryOf(s).detail as { sets?: { closed?: boolean }[] } | undefined)?.sets;
      return Array.isArray(sets) && sets.length >= 2 && sets.some((x) => x.closed !== true);
    });
    const summary = summaryOf(stream);
    const sets = (summary.detail as { sets: { home: number; away: number; closed: boolean }[] })
      .sets;

    const view = buildSets({ sportKey: "tennis", summary, sides: SIDES })!;
    expect(view.kind).toBe("sets");
    expect(view.columns).toEqual(sets.map((_, i) => String(i + 1)));
    expect(view.rows[0]).toEqual(sets.map((s) => String(s.home)));
    expect(view.rows[1]).toEqual(sets.map((s) => String(s.away)));
    expect(view.closedMask).toEqual(sets.map((s) => s.closed === true));
    expect(view.closedMask).toContain(false); // the differential case
    expect(view.closedMask).toContain(true);
  });

  it("badminton and volleyball ride the same set shape", () => {
    for (const key of ["badminton", "volleyball", "tabletennis"]) {
      const stream = streamWhere(key, (s) => {
        const sets = (summaryOf(s).detail as { sets?: unknown[] } | undefined)?.sets;
        return Array.isArray(sets) && sets.length >= 2;
      });
      const view = buildSets({ sportKey: key, summary: summaryOf(stream), sides: SIDES })!;
      expect(SetsView.safeParse(view).success).toBe(true);
      expect(view.kind).toBe("sets");
      expect(view.columns.length).toBeGreaterThanOrEqual(2);
      expect(view.rows[0]).toHaveLength(view.columns.length);
      expect(view.rows[1]).toHaveLength(view.columns.length);
      expect(view.closedMask).toHaveLength(view.columns.length);
    }
  });

  it("football: kind periods, columns from detail.periods[].phase", () => {
    const stream = streamWhere("football", (s) => {
      const periods = (summaryOf(s).detail as { periods?: unknown[] } | undefined)?.periods;
      return Array.isArray(periods) && periods.length >= 2;
    });
    const summary = summaryOf(stream);
    const periods = (
      summary.detail as { periods: { phase: string; home: number; away: number }[] }
    ).periods;

    const view = buildSets({ sportKey: "football", summary, sides: SIDES })!;
    expect(view.kind).toBe("periods");
    expect(view.columns).toEqual(periods.map((p) => p.phase));
    expect(view.rows[0]).toEqual(periods.map((p) => String(p.home)));
    expect(view.rows[1]).toEqual(periods.map((p) => String(p.away)));
    expect(view.closedMask).toHaveLength(periods.length);
  });

  it("ice hockey: the period kernel's own detail.phase says which column is still open", () => {
    // `detail.phase` names the phase in play; every earlier period is closed,
    // and once the phase has left the periods list they all are.
    const openView = buildSets({
      sportKey: "icehockey",
      summary: {
        headline: "1 — 0",
        perSide: [],
        detail: {
          periods: [
            { phase: "P1", home: 1, away: 0 },
            { phase: "P2", home: 0, away: 0 },
          ],
          phase: "P2",
        },
      },
      sides: SIDES,
    })!;
    expect(openView.closedMask).toEqual([true, false]);

    const shootoutView = buildSets({
      sportKey: "icehockey",
      summary: {
        headline: "1 — 1",
        perSide: [],
        detail: {
          periods: [
            { phase: "P1", home: 1, away: 1 },
            { phase: "OT", home: 0, away: 0 },
          ],
          phase: "SHOOTOUT",
        },
      },
      sides: SIDES,
    })!;
    expect(shootoutView.closedMask).toEqual([true, true]);
  });

  it("cricket and generic: null", () => {
    const cricket = summaryOf(corpusFor("cricket").streams[0]!);
    expect(buildSets({ sportKey: "cricket", summary: cricket, sides: SIDES })).toBeNull();

    const generic = summaryOf(corpusFor("generic").streams[0]!);
    expect(buildSets({ sportKey: "generic", summary: generic, sides: SIDES })).toBeNull();

    // Board games and carrom carry neither shape either.
    for (const key of ["boardgame", "carrom"]) {
      const summary = summaryOf(corpusFor(key).streams[0]!);
      expect(buildSets({ sportKey: key, summary, sides: SIDES })).toBeNull();
    }
  });

  it("a summary with no detail at all is null, not a crash", () => {
    expect(
      buildSets({ sportKey: "generic", summary: { headline: "", perSide: [] }, sides: SIDES }),
    ).toBeNull();
  });
});

// ------------------------------------------------------ dictionary coverage

describe("timeline dictionary coverage (derived from the engine's own golden corpora)", () => {
  it("reads all eleven golden corpora and a non-trivial set of recorded event types", () => {
    expect(CORPORA).toHaveLength(11);
    const types = new Set(CORPORA.flatMap((c) => c.streams.flatMap((s) => s.events.map((e) => e.type))));
    expect(types.size).toBeGreaterThanOrEqual(60);
  });

  it("every event type recorded in any sport's golden corpus has a template key in all four locales", () => {
    const types = [
      ...new Set(CORPORA.flatMap((c) => c.streams.flatMap((s) => s.events.map((e) => e.type)))),
    ].sort();
    const missing: string[] = [];
    for (const type of types) {
      const key = TIMELINE_KEY_FOR[type] ?? "timeline.generic.event";
      for (const locale of LOCALES) {
        if (typeof DICTS[locale][key] !== "string") missing.push(`${locale}:${type} -> ${key}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("keys are BARE — nothing this module emits re-states the `public` namespace", () => {
    // The namespace is the FILE (`dictionaries/<locale>/public.json`). A key
    // spelled `public.timeline.…` still RESOLVES (lookup() tries the literal
    // flat key first), so nothing else in the suite can catch the slip.
    const emitted = [
      ...Object.values(TIMELINE_KEY_FOR),
      "timeline.generic.event",
      "timeline.set.won",
      "timeline.period.end",
    ];
    expect(emitted.length).toBeGreaterThanOrEqual(20);
    expect(emitted.filter((k) => k.startsWith("public."))).toEqual([]);
    for (const key of emitted) expect(key).toMatch(/^timeline\./);

    // …and the same for what the builder actually puts on a line, not just the
    // table — a derived key could be spelled at its emission site.
    const lines = [
      ...buildTimeline(args({ sportKey: "football", events: footballLedger })),
      ...buildTimeline(args({ sportKey: "tennis", events: tennisSetLedger })),
      ...buildTimeline(args({ events: [env(0, "some.future.type", {})] })),
    ];
    expect(lines.length).toBeGreaterThan(8);
    expect(lines.map((l) => l.text.key).filter((k) => k.startsWith("public."))).toEqual([]);

    // …and the dictionaries themselves.
    for (const locale of LOCALES) {
      expect(Object.keys(DICTS[locale]).filter((k) => k.startsWith("public."))).toEqual([]);
    }
  });

  it("every key the module can emit — templates plus the three derived/neutral keys — exists in all four locales", () => {
    const keys = [
      ...new Set([
        ...Object.values(TIMELINE_KEY_FOR),
        "timeline.generic.event",
        "timeline.set.won",
        "timeline.period.end",
      ]),
    ].sort();
    expect(keys.length).toBeGreaterThanOrEqual(20);
    const missing: string[] = [];
    for (const key of keys) {
      for (const locale of LOCALES) {
        if (typeof DICTS[locale][key] !== "string") missing.push(`${locale}:${key}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("no locale carries a public.timeline key the others lack", () => {
    const timelineKeys = (locale: (typeof LOCALES)[number]) =>
      Object.keys(DICTS[locale]).filter((k) => k.startsWith("timeline.")).sort();
    const en = timelineKeys("en");
    expect(en.length).toBeGreaterThanOrEqual(20);
    for (const locale of LOCALES) expect(timelineKeys(locale)).toEqual(en);
  });

  it("every {param} a template names is supplied by the builder for the events that emit it", () => {
    // A template naming a param the builder never sets renders a literal
    // "{person}" to a spectator. Drive every non-cricket golden stream through
    // the builder and check each emitted line against its own en template.
    const en = DICTS.en as Record<string, string>;
    const unsupplied: string[] = [];
    let checkedLines = 0;
    let checkedParams = 0;
    for (const corpus of CORPORA) {
      if (corpus.key === "cricket") continue;
      const mod = moduleFor(corpus.key);
      for (const stream of corpus.streams.slice(0, 4)) {
        const cfg = mod.configSchema.parse(corpus.configs[stream.config]);
        const lines = buildTimeline({
          sportKey: corpus.key,
          events: envelopesOf(stream),
          module: mod,
          cfg,
          lineups: defaultLineupPair(resolvePositions(mod, cfg)),
          sides: SIDES,
          personOf,
        });
        for (const line of lines) {
          const template = en[line.text.key];
          expect(typeof template).toBe("string");
          checkedLines++;
          for (const [, name] of template!.matchAll(/\{(\w+)\}/g)) {
            checkedParams++;
            if (line.text.params === undefined || !(name in line.text.params)) {
              unsupplied.push(`${corpus.key} ${line.text.key} {${name}}`);
            }
          }
        }
      }
    }
    // The gate says what it actually looked at: a vacuous sweep passes too.
    expect(checkedLines).toBeGreaterThan(200);
    expect(checkedParams).toBeGreaterThan(200);
    expect([...new Set(unsupplied)]).toEqual([]);
  });
});
