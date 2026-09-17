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
//  (o) THE DERIVED PASS EMITS NOTHING — `derivedLines` returns `[]` before its
//      body runs, the exact shape a total failure of the replay would produce.
//      Added in fix round 1, because the sweep it replaces COULD NOT SEE THIS:
//      it asserted only `lines.length >= events.length`, schema validity and a
//      total count, every one of which holds with zero derived lines.
//      → RED (7), the golden sweep among them, now that the sweep counts
//        `timeline.set.won` against the closed sets in the engine's own frozen
//        `stream.summary` and `timeline.period.end` against its periods.
//
// All six compile and collect (`numTotalTests` unchanged in every run — 21
// before the bare-keys test, 22 after, 28 after fix round 1), so none is the
// collection-break shape that reads as a survivor.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Dict } from "@/lib/i18n-constants";
import { t } from "@/lib/i18n-runtime";
import enPublic from "@/dictionaries/en/public.json";
import { localiseParams } from "@/components/public-site/match-centre/timeline-tab";
import {
  CORE_EVENT_SCHEMAS,
  EngineError,
  LINEUP_EVENT_SCHEMAS,
  type EventEnvelope,
  type LineupPair,
  type ScoreSummary,
} from "@seazn/engine/core";
import { registry, resolvePositions, type AnySportModule } from "@seazn/engine/sport";
import { registerBuiltins } from "@seazn/engine/sports";
import { defaultLineupPair } from "@seazn/engine/testkit";
import {
  SetsView,
  TimelineLine,
  type PersonT,
  type SideT,
  type TimelineLineT,
} from "../match-centre-schema";
import {
  TIMELINE_GAME_BROKEN_KEY,
  TIMELINE_GAME_HELD_KEY,
  TIMELINE_KEY_FOR,
  TIMELINE_NEUTRAL_KEY,
  TIMELINE_OVERRIDE_KEYS,
  TIMELINE_PERIOD_END_KEY,
  TIMELINE_SET_WON_KEY,
  buildSets,
  buildTimeline,
  type TimelineArgs,
} from "../timeline";

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
  /** Present only on streams recorded against NON-default lineups (a football
   *  coverage stream needs a bench). Omitting it from this local type made
   *  every such stream replay against the wrong squads. */
  lineups?: LineupPair;
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

/** The lines alone. `buildTimeline` also reports whether the derived pass ran
 *  to completion; the tests that care about that read the whole result. */
const linesOf = (a: TimelineArgs): TimelineLineT[] => buildTimeline(a).lines;

const countKey = (lines: readonly TimelineLineT[], key: string): number =>
  lines.filter((l) => l.text.key === key).length;

/** Everything a ledger can carry: the sport types the corpora record PLUS the
 *  kernel's own registry. The corpora record only `core.start`/`forfeit`/
 *  `abandon`, so a set built from them alone silently excused the other nine
 *  kernel types and all five lineup types — including `core.note`, whose whole
 *  content is an official's free text. */
const RECORDED_TYPES = [
  ...new Set(CORPORA.flatMap((c) => c.streams.flatMap((s) => s.events.map((e) => e.type)))),
].sort();
// Deduplicated: `CORE_EVENT_SCHEMAS` already REGISTERS the five lineup types
// (its own comment says so — "this map is the registration"), so the two maps
// overlap and a bare concat counts them twice. 14 distinct, not 19.
const KERNEL_TYPES = [
  ...new Set([...Object.keys(CORE_EVENT_SCHEMAS), ...Object.keys(LINEUP_EVENT_SCHEMAS)]),
].sort();
const ALL_TYPES = [...new Set([...RECORDED_TYPES, ...KERNEL_TYPES])].sort();

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

/** Two games played POINT BY POINT, which `tennisSetLedger` cannot exercise —
 *  it jumps straight to per-set totals and no point ever happens.
 *
 *  Home serves first, so game 1 to home is a HOLD; serving then passes to away,
 *  so game 2 to home is a BREAK. One of each, from the engine's own serving
 *  rotation rather than a flag set by the test. */
const tennisPointLedger: EventEnvelope[] = [
  env(0, "core.start", {}),
  ...[1, 2, 3, 4].map((i) => env(i, "tennis.point", { by: "H" })),
  ...[5, 6, 7, 8].map((i) => env(i, "tennis.point", { by: "H" })),
];

// ------------------------------------------------------------ buildTimeline

describe("buildTimeline", () => {
  it("EMPTY ledger → []", () => expect(linesOf(args({ events: [] }))).toEqual([]));

  it("football: goal, card, period and shoot-out kick each render their own key with side, minute and person", () => {
    const lines = linesOf(args({ sportKey: "football", events: footballLedger }));
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

  it("every recorded event produces AT LEAST one line — a type with no template is never dropped", () => {
    const ledger = [...footballLedger, env(5, "some.future.type", {})];
    const lines = linesOf(args({ sportKey: "football", events: ledger }));
    // Derived lines may add more, never fewer: every recorded seq is present.
    for (const e of ledger) {
      expect(lines.filter((l) => l.seq === e.seq).length).toBeGreaterThanOrEqual(1);
    }
    expect(lines.length).toBeGreaterThanOrEqual(ledger.length);
  });

  it("newest first: seq descending", () => {
    const lines = linesOf(args({ sportKey: "football", events: footballLedger }));
    expect(lines.length).toBeGreaterThan(1);
    expect(lines[0]!.seq).toBe(4);
    expect(lines[0]!.seq).toBeGreaterThan(lines[1]!.seq);
    const seqs = lines.map((l) => l.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => b - a));
  });

  it("an event type with no template renders the neutral line, never nothing", () => {
    const lines = linesOf(args({ events: [env(0, "some.future.type", {})] }));
    expect(lines).toHaveLength(1);
    expect(lines[0]!.text.key).toBe("timeline.generic.event");
  });

  it("racket sports: a set transition line is derived by replaying the module and diffing summary.detail.sets", () => {
    const lines = linesOf(args({ sportKey: "tennis", events: tennisSetLedger }));
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
    const lines = linesOf(args({ sportKey: "football", events: footballLedger }));
    const end = lines.filter((l) => l.text.key === "timeline.period.end");
    expect(end).toHaveLength(1);
    // H1 closed 1–0 at the half-time marker (seq 3).
    expect(end[0]!.text.params).toMatchObject({ phase: "H1", home: 1, away: 0 });
    expect(end[0]!.seq).toBe(3);
  });


  /**
   * The recorded period row reads as the PHASE, not as the event's own name.
   * It shipped as "Period marker — Half-time": the ledger's vocabulary, on a
   * spectator's timeline, directly beneath the derived row for the same
   * instant already reading "End of 1st half — 1–0". A row naming its own
   * event type is a developer's label, not a reader's.
   *
   * Resolved through the REAL dictionary rather than asserted on the key,
   * because the key was never wrong — only what it said. Both halves are
   * pinned: what the row must read, and the label it must no longer carry.
   */
  it("the recorded period row reads as the phase alone, never as the event's own name", () => {
    const lines = linesOf(args({ sportKey: "football", events: footballLedger }));
    const recorded = lines.find((l) => l.text.key === "timeline.football.period")!;
    expect(recorded, "the football ledger must still produce a recorded period row").toBeTruthy();
    const dict = enPublic as Dict;
    const text = t(dict, recorded.text.key, localiseParams(dict, recorded.text.params));
    // The recorded event at seq 3 is `football.period {phase:"HT"}`, which
    // resolves through `term.*` to the phase's own name — the row is that
    // name and nothing else. Derived from the dictionary, never the literal
    // "Half-time", so re-wording `term.HT` moves this with it.
    expect(recorded.text.params?.phase).toBe("HT");
    expect(text).toBe(t(dict, "term.HT"));
    expect(text).not.toMatch(/marker|marca|repère|markering/i);
    // The positive pair: the DERIVED sibling keeps its sentence, so this is a
    // change to one row's copy and not a timeline that lost its prose.
    const derived = lines.find((l) => l.text.key === "timeline.period.end")!;
    expect(t(dict, derived.text.key, localiseParams(dict, derived.text.params))).toContain("End of");
  });

  it("a derived line sorts ABOVE the event that caused it", () => {
    const lines = linesOf(args({ sportKey: "football", events: footballLedger }));
    const derived = lines.findIndex((l) => l.text.key === "timeline.period.end");
    const recorded = lines.findIndex((l) => l.text.key === "timeline.football.period");
    expect(derived).toBeGreaterThanOrEqual(0);
    expect(recorded).toBeGreaterThanOrEqual(0);
    expect(derived).toBeLessThan(recorded);
  });

  it("a ledger the module refuses still renders the line for the event it refused", () => {
    // `football.shootout.kick` in the first half is WRONG_PHASE — the derived
    // pass stops there and the recorded pass is unaffected.
    const lines = linesOf(args({ sportKey: "football", events: footballLedger }));
    expect(lines.filter((l) => l.text.key === "timeline.football.shootout.kick")).toHaveLength(1);
  });

  it("replays EVERY golden stream of every non-cricket sport, and the DERIVED lines match the engine's own frozen summary", () => {
    // The sweep this replaces asserted only `lines.length >= events.length`,
    // schema validity and a total count — all of which hold with ZERO derived
    // lines, so a total failure of the derived pass was invisible to it. These
    // two counts come from the engine's FROZEN summary (`stream.summary`),
    // never from a table typed here, so the assertion moves with the kernel.
    const keys = CORPORA.map((c) => c.key).filter((k) => k !== "cricket");
    expect(keys.length).toBeGreaterThanOrEqual(9);

    let validated = 0;
    let streamsWithSets = 0;
    let streamsWithPeriods = 0;
    let incomplete = 0;

    for (const key of keys) {
      const mod = moduleFor(key);
      const corpus = corpusFor(key);
      for (const stream of corpus.streams) {
        const cfg = mod.configSchema.parse(corpus.configs[stream.config]);
        const result = buildTimeline({
          sportKey: key,
          events: envelopesOf(stream),
          module: mod,
          cfg,
          lineups: stream.lineups ?? defaultLineupPair(resolvePositions(mod, cfg)),
          sides: SIDES,
          personOf,
        });
        const { lines } = result;
        // Every event owes at least one line — EXCEPT a tennis point, which is
        // deliberately not rendered (see `buildTimeline`): its game rungs are
        // derived instead, so a 40-point stream is 8 lines rather than 40+.
        // Subtracted rather than skipped, so the floor still holds tennis to
        // everything else it records.
        const suppressed =
          key === "tennis" ? stream.events.filter((e) => e.type === "tennis.point").length : 0;
        expect(lines.length, key).toBeGreaterThanOrEqual(stream.events.length - suppressed);
        for (const line of lines) {
          expect(TimelineLine.safeParse(line).success).toBe(true);
          validated++;
        }
        if (!result.derivedComplete) {
          incomplete++;
          continue; // a stopped replay owes no counts — but see the guard below
        }

        const detail = summaryOf(stream).detail as
          | { sets?: { closed?: boolean }[]; periods?: unknown[] }
          | undefined;

        const sets = detail?.sets;
        if (Array.isArray(sets) && sets.length > 0) {
          streamsWithSets++;
          const closed = sets.filter((s) => s.closed === true).length;
          expect(countKey(lines, TIMELINE_SET_WON_KEY), `${key} set.won`).toBe(closed);
        }

        const periods = detail?.periods;
        if (Array.isArray(periods) && periods.length > 0) {
          streamsWithPeriods++;
          // A period closes when the NEXT one opens, so a finished stream has
          // one fewer ending than it has periods.
          expect(countKey(lines, TIMELINE_PERIOD_END_KEY), `${key} period.end`).toBe(
            periods.length - 1,
          );
        }
      }
    }

    // The gate says what it looked at: a sweep that matched no stream with
    // sets, or none with periods, would pass every assertion above vacuously.
    expect(validated).toBeGreaterThan(200);
    expect(streamsWithSets).toBeGreaterThan(50);
    expect(streamsWithPeriods).toBeGreaterThan(50);
    // And no golden stream may need the degrade at all: these are the streams
    // the engine itself folds cleanly, so a single incomplete replay here is a
    // real defect in this builder, not a tolerated edge.
    expect(incomplete).toBe(0);
  });

  it("a refused ledger reports the degrade instead of hiding it", () => {
    // `football.shootout.kick` in the first half is WRONG_PHASE. The recorded
    // lines all survive; `derivedComplete` is how a caller finds out that the
    // derived ones stopped — the empty `catch` this replaces made a fixture
    // that lost every set-won line look exactly like one that had none.
    const refused = buildTimeline(args({ sportKey: "football", events: footballLedger }));
    expect(refused.derivedComplete).toBe(false);
    expect(refused.lines.length).toBe(footballLedger.length + 1); // + the period end

    // The positive pair, and the reason this is not a tautology: a ledger the
    // module accepts reports TRUE.
    const clean = buildTimeline(args({ sportKey: "tennis", events: tennisSetLedger }));
    expect(clean.derivedComplete).toBe(true);
  });

  it("emphasis is not decoration: a point line is `score`, a derived set line is `strong`", () => {
    const tennis = linesOf(args({ sportKey: "tennis", events: tennisSetLedger }));
    const setWon = tennis.find((l) => l.text.key === TIMELINE_SET_WON_KEY)!;
    expect(setWon.emphasis).toBe("strong");

    const football = linesOf(args({ sportKey: "football", events: footballLedger }));
    expect(football.find((l) => l.text.key === "timeline.football.goal")!.emphasis).toBe("score");
    expect(football.find((l) => l.text.key === "timeline.football.card")!.emphasis).toBe("strong");
    expect(football.find((l) => l.text.key === "timeline.core.start")!.emphasis).toBe("strong");
    // …and something really is plain, or "emphasis" would mean nothing.
    const neutral = linesOf(args({ events: [env(0, "some.future.type", {})] }));
    expect(neutral[0]!.emphasis).toBe("normal");
  });

  it("tennis: a GAME is a rung and a POINT is not — 8 points become 2 lines, not 8", () => {
    const lines = linesOf(args({ sportKey: "tennis", events: tennisPointLedger }));

    // The suppression, stated as a count rather than as an absence: eight
    // points are on the ledger and not one of them is a line.
    expect(countKey(lines, "timeline.tennis.point")).toBe(0);

    // …and something replaced them, or this test would pass on a build that
    // simply dropped the points and rendered nothing.
    const rungs = lines.filter(
      (l) => l.text.key === TIMELINE_GAME_HELD_KEY || l.text.key === TIMELINE_GAME_BROKEN_KEY,
    );
    expect(rungs.length).toBe(2);

    // NEWEST FIRST, so the break (game 2) is above the hold (game 1). Home
    // serves first: game 1 to home is a hold, game 2 to home is a break — and
    // asserting BOTH is the point, since a build that always said "holds" would
    // pass a test that only ever checked the first game.
    expect(rungs[0]!.text.key).toBe(TIMELINE_GAME_BROKEN_KEY);
    expect(rungs[0]!.text.params).toMatchObject({ home: 2, away: 0 });
    expect(rungs[1]!.text.key).toBe(TIMELINE_GAME_HELD_KEY);
    expect(rungs[1]!.text.params).toMatchObject({ home: 1, away: 0 });

    // The marker names the set the game belongs to.
    expect(rungs[0]!.marker).toBe("S1");
    // Both rungs are the winner's, and the winner here is home.
    expect(rungs.map((l) => l.sideIndex)).toEqual([0, 0]);
  });

  it("tennis game rungs are NOT emitted for the game that closes a set — the set line already says it", () => {
    // `tennis.set_summary` closes a set outright. If a set-closing moment also
    // emitted a game rung, this ledger would carry two rungs saying the same
    // thing in less detail.
    const lines = linesOf(args({ sportKey: "tennis", events: tennisSetLedger }));
    expect(countKey(lines, TIMELINE_GAME_HELD_KEY)).toBe(0);
    expect(countKey(lines, TIMELINE_GAME_BROKEN_KEY)).toBe(0);
    expect(countKey(lines, TIMELINE_SET_WON_KEY)).toBe(2);
  });

  it("a phase is named ONCE — in the sentence, not also in the marker", () => {
    const lines = linesOf(args({ sportKey: "football", events: footballLedger }));
    const marker = lines.find((l) => l.text.key === "timeline.football.period")!;
    expect(marker.text.params?.phase).toBe("HT");
    expect(marker.marker).toBeNull();
    const end = lines.find((l) => l.text.key === TIMELINE_PERIOD_END_KEY)!;
    expect(end.text.params?.phase).toBe("H1");
    expect(end.marker).toBeNull();
    // The positive pair: a minute-stamped event still HAS a marker.
    expect(lines.find((l) => l.text.key === "timeline.football.goal")!.marker).toBe("23'");
  });

  it("a period-advance line NAMES the phase in its sentence", () => {
    // The positive pair for "a phase is named ONCE": the marker is null now,
    // so the phase has to be in the params or the line says nothing at all.
    const lines = linesOf(
      args({
        sportKey: "icehockey",
        events: [env(0, "core.start", {}), env(1, "icehockey.period.advance", { to: "P2" })],
      }),
    );
    const advance = lines.find((l) => l.text.key === "timeline.periodsport.advance")!;
    expect(advance.text.params?.phase).toBe("P2");
    expect(advance.marker).toBeNull();
  });

  it("core.award carries the award key as a localisable token", () => {
    const lines = linesOf(
      args({ events: [env(0, "core.award", { person: "H-p1", key: "motm" })] }),
    );
    expect(lines[0]!.text.key).toBe("timeline.core.award");
    expect(lines[0]!.text.params).toMatchObject({ person: "Player H-p1", key: "motm" });
  });

  it("a winner naming NEITHER entrant takes the draw branch, never an empty {side}", () => {
    // A stale fixture, or an entrant deleted after scoring: `winner` is a
    // non-empty string that resolves to no side. Keying the override on the
    // RESOLVED index means this cannot reach the decisive template.
    const orphan = linesOf(
      args({
        sportKey: "boardgame",
        events: [env(0, "boardgame.result", { winner: "GONE", method: "resign" })],
      }),
    );
    expect(orphan[0]!.sideIndex).toBeNull();
    expect(orphan[0]!.text.key).toBe("timeline.boardgame.draw");
    expect(orphan[0]!.text.params?.side).toBeUndefined();
  });

  it("a lineup event whose side resolves to nothing takes its own sentence", () => {
    const orphan = linesOf(
      args({ events: [env(0, "core.lineup.entry", { side: "GONE", on: { personId: "x" } })] }),
    );
    // Not the side-naming template with an omitted param — a template that
    // names a side it cannot fill would render "Line-up change — " with a
    // dangling dash. A different sentence, which is what an override is for.
    expect(orphan[0]!.text.key).toBe("timeline.core.lineup.unknownSide");
    expect(orphan[0]!.text.params?.side).toBeUndefined();
    // Positive pair: a side that DOES resolve is named.
    const known = linesOf(
      args({ events: [env(0, "core.lineup.entry", { side: "H", on: { personId: "x" } })] }),
    );
    expect(known[0]!.text.params?.side).toBe(SIDES[0].name);
  });

  it("a drawn board game does not render an empty winner", () => {
    // `boardgame.result` says two different things: `{ winner, method }` is a
    // decisive result, `{ method }` alone is a draw. Through the decisive
    // template the draw read "Result (agreement) — " with a dangling dash.
    const drawn = linesOf(
      args({
        sportKey: "boardgame",
        events: [env(0, "boardgame.result", { method: "agreement" })],
      }),
    );
    expect(drawn[0]!.text.key).toBe("timeline.boardgame.draw");
    expect(drawn[0]!.text.params?.side).toBeUndefined();

    const decisive = linesOf(
      args({
        sportKey: "boardgame",
        events: [env(0, "boardgame.result", { winner: "H", method: "resign" })],
      }),
    );
    expect(decisive[0]!.text.key).toBe("timeline.boardgame.result");
    expect(decisive[0]!.text.params?.side).toBe(SIDES[0].name);
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

  it("badminton, volleyball and table tennis ride the same set shape", () => {
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

  it("football: kind periods, one ordinal column per recorded period", () => {
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
    expect(view.unit).toBe("period");
    // Ordinals, not the engine's phase labels (controller ruling): the RENDERER
    // labels them "Period {n}" in the viewer's own locale. The phase strings
    // are consequently no longer reachable from the column head — recorded as
    // a known loss for extra time / overtime.
    expect(view.columns).toEqual(periods.map((_, i) => String(i + 1)));
    expect(view.columns).not.toEqual(periods.map((p) => p.phase));
    expect(view.rows[0]).toEqual(periods.map((p) => String(p.home)));
    expect(view.rows[1]).toEqual(periods.map((p) => String(p.away)));
    expect(view.closedMask).toHaveLength(periods.length);
  });

  it("`unit` names what ONE column is in the sport's own vocabulary", () => {
    // Badminton and table tennis score GAMES inside a table whose `kind` is
    // still "sets" — which is exactly why `kind` cannot double as the label,
    // and why this asserts a sport where the two answers DIFFER.
    const gameSports = ["badminton", "tabletennis"] as const;
    for (const key of gameSports) {
      const stream = streamWhere(key, (s) => {
        const sets = (summaryOf(s).detail as { sets?: unknown[] } | undefined)?.sets;
        return Array.isArray(sets) && sets.length >= 2;
      });
      // THROUGH `SetsView.parse`, not on the raw builder return: zod STRIPS an
      // unknown key, so a field the schema does not declare would survive every
      // assertion on the object the builder handed back and vanish the moment
      // the document was parsed. Parsing is the only assertion that proves the
      // field reaches a consumer.
      const view = SetsView.parse(
        buildSets({ sportKey: key, summary: summaryOf(stream), sides: SIDES }),
      );
      expect(view.kind, key).toBe("sets");
      expect(view.unit, key).toBe("game");
      // A set has no name beyond its number.
      expect(view.columnLabels, key).toBeUndefined();
    }
    for (const key of ["tennis", "volleyball"] as const) {
      const stream = streamWhere(key, (s) => {
        const sets = (summaryOf(s).detail as { sets?: unknown[] } | undefined)?.sets;
        return Array.isArray(sets) && sets.length >= 2;
      });
      const view = SetsView.parse(
        buildSets({ sportKey: key, summary: summaryOf(stream), sides: SIDES }),
      );
      expect(view.unit, key).toBe("set");
      expect(view.columnLabels, key).toBeUndefined();
    }
    for (const key of ["football", "hockey", "icehockey"] as const) {
      const stream = streamWhere(key, (s) => {
        const periods = (summaryOf(s).detail as { periods?: unknown[] } | undefined)?.periods;
        return Array.isArray(periods) && periods.length >= 2;
      });
      const view = SetsView.parse(
        buildSets({ sportKey: key, summary: summaryOf(stream), sides: SIDES }),
      );
      expect(view.unit, key).toBe("period");
      // The engine's own phase tokens, one per column, so the renderer can say
      // "ET 2nd half" rather than "Period 4".
      const periods = (summaryOf(stream).detail as { periods: { phase: string }[] }).periods;
      expect(view.columnLabels, key).toEqual(periods.map((p) => p.phase));
    }
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

  it("football extra time keeps its own name — the ordinal is only a fallback", () => {
    // A stream that actually reached extra time, chosen by predicate.
    const stream = streamWhere("football", (s) => {
      const periods = (summaryOf(s).detail as { periods?: { phase: string }[] } | undefined)
        ?.periods;
      return Array.isArray(periods) && periods.some((p) => p.phase.startsWith("ET_"));
    });
    const view = SetsView.parse(
      buildSets({ sportKey: "football", summary: summaryOf(stream), sides: SIDES }),
    );
    expect(view.columnLabels).toContain("ET_H1");
    expect(view.columnLabels).toContain("ET_H2");
    // …and the ordinal columns are still there for the fallback path.
    expect(view.columns).toEqual(view.columnLabels!.map((_, i) => String(i + 1)));
    expect(view.columnLabels).not.toEqual(view.columns);
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
  it("sweeps all eleven golden corpora PLUS the kernel's own registry", () => {
    // Eleven is the count GOLDEN-POLICY.md states, and it is asserted because a
    // glob that silently matched nothing would make every claim below vacuous.
    expect(CORPORA).toHaveLength(11);
    expect(RECORDED_TYPES.length).toBeGreaterThanOrEqual(60);
    // …and the corpora are NOT the whole ledger vocabulary. They record three
    // kernel types; the kernel registers fourteen.
    expect(KERNEL_TYPES.length).toBe(14);
    for (const type of ["core.note", "core.finalize", "core.award", "core.lineup.entry"]) {
      expect(RECORDED_TYPES, type).not.toContain(type);
      expect(ALL_TYPES, type).toContain(type);
    }
    expect(ALL_TYPES.length).toBeGreaterThan(RECORDED_TYPES.length);
  });

  it("every type a ledger can carry — corpus-recorded AND kernel-registered — has a template key in all four locales", () => {
    const missing: string[] = [];
    for (const type of ALL_TYPES) {
      const key = TIMELINE_KEY_FOR[type] ?? TIMELINE_NEUTRAL_KEY;
      for (const locale of LOCALES) {
        if (typeof DICTS[locale][key] !== "string") missing.push(`${locale}:${type} -> ${key}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("a penalty and an own goal name themselves through their OWN sentence, never an English flag in the detail", () => {
    // Task 16 (zero-English sweep): the goal line appended "(pen)" / "(og)" to
    // `detail`, so a French reader got "But — Harbour Rovers Player H-p9 (pen)".
    // The builder has no dictionary, so the flag chooses the TEMPLATE instead,
    // through KEY_OVERRIDE, and every locale writes the whole sentence.
    const lines = linesOf(
      args({
        sportKey: "football",
        events: [
          env(0, "core.start", {}),
          env(1, "football.goal", { by: "H", scorer: "H-p9", penalty: true, minute: 23 }),
          env(2, "football.goal", { by: "A", scorer: "A-p4", ownGoal: true, minute: 40 }),
          env(3, "football.goal", { by: "H", scorer: "H-p7", minute: 55 }),
        ],
      }),
    );
    const bySeq = (seq: number) => lines.find((l) => l.seq === seq)!;
    expect(bySeq(1).text.key).toBe("timeline.football.penaltyGoal");
    expect(bySeq(2).text.key).toBe("timeline.football.ownGoal");
    // The positive pair: an open-play goal keeps its own sentence.
    expect(bySeq(3).text.key).toBe("timeline.football.goal");
    for (const seq of [1, 2, 3]) {
      const detail = String(bySeq(seq).text.params?.detail);
      expect(detail).not.toMatch(/\((pen|og)\)/);
      expect(detail, "the scorer is still named").toMatch(/Player [HA]-p\d/);
    }
    for (const locale of LOCALES) {
      for (const key of ["timeline.football.penaltyGoal", "timeline.football.ownGoal"]) {
        expect(typeof DICTS[locale][key], `${locale}:${key}`).toBe("string");
      }
    }
  });

  it("every KEY_OVERRIDE branch returns a key the gates know about", () => {
    // The override map is reachable at runtime and its keys are NOT in
    // `TIMELINE_KEY_FOR`, so nothing else in the suite would notice one that no
    // locale carries. Both branches of every override are invoked here, and the
    // non-null results must be a subset of the set the dictionary gates union
    // in — which is what keeps that union honest as overrides are added.
    const withSide = [
      env(0, "boardgame.result", { winner: "H", method: "resign" }),
      env(1, "core.lineup.entry", { side: "H", on: { personId: "x" } }),
    ];
    const withoutSide = [
      env(0, "boardgame.result", { method: "agreement" }),
      env(1, "core.lineup.entry", { side: "GONE", on: { personId: "x" } }),
    ];
    const emitted = new Set<string>();
    let overridden = 0;
    for (const events of [withSide, withoutSide]) {
      for (const line of linesOf(args({ sportKey: "boardgame", events }))) {
        emitted.add(line.text.key);
        if (TIMELINE_OVERRIDE_KEYS.includes(line.text.key)) overridden++;
      }
    }
    // Football's goal: open play, a penalty, an own goal.
    const goals = [
      env(0, "core.start", {}),
      env(1, "football.goal", { by: "H", scorer: "H-p9", minute: 10 }),
      env(2, "football.goal", { by: "H", scorer: "H-p9", penalty: true, minute: 20 }),
      env(3, "football.goal", { by: "A", scorer: "A-p4", ownGoal: true, minute: 30 }),
    ];
    for (const line of linesOf(args({ sportKey: "football", events: goals }))) {
      emitted.add(line.text.key);
      if (TIMELINE_OVERRIDE_KEYS.includes(line.text.key)) overridden++;
    }
    // The gate says what it saw: both no-side branches and both goal flags fired.
    expect(overridden).toBe(4);
    const overrides = [...emitted].filter((k) => !Object.values(TIMELINE_KEY_FOR).includes(k));
    expect(overrides.sort()).toEqual([...TIMELINE_OVERRIDE_KEYS].sort());
  });

  it("the client-safe key module imports nothing from the server", () => {
    // `timeline.ts` imports pino, and a client component importing `@/server/**`
    // is a BUILD FAILURE here — which is the whole reason the table was split
    // out. A stray import would only surface as a broken production build, so
    // it is asserted on the SOURCE.
    const src = readFileSync(join(HERE, "../../../lib/timeline-keys.ts"), "utf8");
    expect(src).not.toMatch(/from\s+"@\/server\//);
    expect(src).not.toMatch(/from\s+"pino"/);
    expect(src).not.toMatch(/require\(/);
    // …and it really is the module under test, not an empty read.
    expect(src).toContain("TIMELINE_KEY_FOR");
  });

  it("keys are BARE — nothing this module emits re-states the `public` namespace", () => {
    // The namespace is the FILE (`dictionaries/<locale>/public.json`). A key
    // spelled `public.timeline.…` still RESOLVES (lookup() tries the literal
    // flat key first), so nothing else in the suite can catch the slip.
    const emitted = [
      ...Object.values(TIMELINE_KEY_FOR),
      ...TIMELINE_OVERRIDE_KEYS,
      TIMELINE_NEUTRAL_KEY,
      TIMELINE_SET_WON_KEY,
      TIMELINE_PERIOD_END_KEY,
    ];
    expect(emitted.length).toBeGreaterThanOrEqual(20);
    expect(emitted.filter((k) => k.startsWith("public."))).toEqual([]);
    for (const key of emitted) expect(key).toMatch(/^timeline\./);

    // …and the same for what the builder actually puts on a line, not just the
    // table — a derived key could be spelled at its emission site.
    const lines = [
      ...linesOf(args({ sportKey: "football", events: footballLedger })),
      ...linesOf(args({ sportKey: "tennis", events: tennisSetLedger })),
      ...linesOf(args({ events: [env(0, "some.future.type", {})] })),
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
        // A key reachable at RUNTIME that no locale carries is the same defect
        // whether it comes from the table or from a per-payload override.
        ...TIMELINE_OVERRIDE_KEYS,
        TIMELINE_NEUTRAL_KEY,
        TIMELINE_SET_WON_KEY,
        TIMELINE_PERIOD_END_KEY,
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

  it("the kernel types a ledger can carry render their OWN sentence, not the neutral line", () => {
    // `core.note` is the case that matters: its payload is free text an
    // official typed, and the neutral line would throw it away.
    for (const type of [
      "core.note",
      "core.finalize",
      "core.award",
      "core.suspend",
      "core.resume",
      "core.lineup.substitution",
      "core.lineup.entry",
    ]) {
      expect(TIMELINE_KEY_FOR[type], type).toBeDefined();
      expect(TIMELINE_KEY_FOR[type], type).not.toBe(TIMELINE_NEUTRAL_KEY);
    }
    // The note's text actually reaches the line.
    const noted = linesOf(args({ events: [env(0, "core.note", { text: "Rain stopped play" })] }));
    expect(noted[0]!.text.key).toBe("timeline.core.note");
    expect(noted[0]!.text.params?.text).toBe("Rain stopped play");
    // A lineup change names its side, which is why `side` had to join the
    // entrant-field list — the kernel family spells it differently.
    const swapped = linesOf(
      args({ events: [env(0, "core.lineup.entry", { side: "H", on: { personId: "H-p9" } })] }),
    );
    expect(swapped[0]!.text.key).toBe("timeline.core.lineup");
    expect(swapped[0]!.text.params?.side).toBe(SIDES[0].name);
    expect(swapped[0]!.sideIndex).toBe(0);
    // …and `core.void` deliberately has none: it never survives resolveVoids.
    expect(TIMELINE_KEY_FOR["core.void"]).toBeUndefined();
  });

  it("no locale carries a timeline key the others lack", () => {
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
      for (const stream of corpus.streams) {
        const cfg = mod.configSchema.parse(corpus.configs[stream.config]);
        const lines = linesOf({
          sportKey: corpus.key,
          events: envelopesOf(stream),
          module: mod,
          cfg,
          // The stream's OWN lineups when it recorded any — a football coverage
          // stream needs a bench, and replaying it against the default squads
          // is replaying a different match.
          lineups: stream.lineups ?? defaultLineupPair(resolvePositions(mod, cfg)),
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
