// extendFloor (GF-1, batches GF-2 T3) — the append path of the golden floor. The committed floor streams are the expected values:
// the path must reproduce them byte for byte, one BATCH at a time (each maximal run of consecutive floor streams, from the streams
// preceding it and the configs those reference), touch nothing it did not add, do nothing when the floor is met (the empty case
// and the second call), and refuse an identity clash by name.
import { describe, expect, it } from "vitest";
import { builtinModules } from "../sports/index.ts";
import { forEachSport } from "./for-each-sport.ts";
import { readCorpus, recomputeStream, corpusFormat, slimStream, storedFields, type GoldenCorpus, type GoldenEvent, type GoldenStream } from "./golden.ts";
import { eventToken, floorHoles as holesOf, floorRequirement, outcomeTokenOf, overlayToken, undoToken, type FloorToken } from "./golden-floor.ts";
import {
  corpusBefore,
  expungeStrike,
  extendFloor,
  floorBatches,
  FLOOR_SEED_STRIDE,
  isFloorStream as isFloor,
  kernelStrikes,
  playsOnToTheSameResult,
  readsAs,
  reproduceFloorBatch,
  SCENARIOS,
  settleStoryHolds,
  SPLICED_KERNEL,
  strikeKernelEvent,
  type Built,
  type Ctx,
  type KernelStrike,
  type Scenario,
} from "./golden-floor-streams.ts";
import { EngineError } from "../core/errors.ts";
import { foldMatchWithStoppage, outcomeOf, playRecorded } from "../core/events.ts";
import { resolvePositions } from "../sport/catalog.ts";
import { buildWalk, defaultLineupPair, makeEnvelope } from "./helpers.ts";
import { UNDOABLE_KERNEL } from "./golden-floor.ts";

/** The corpus as it stood when its FIRST floor batch was generated: the streams before that batch, and the configs they reference. */
const beforeFloor = (c: GoldenCorpus): GoldenCorpus => {
  const first = floorBatches(c)[0];
  return first === undefined ? c : corpusBefore(c, first.start);
};
/** The same corpus up to (not including) the stream at `index`: what a floor stream was measured against. */
const upTo = (c: GoldenCorpus, index: number): GoldenCorpus => ({ ...c, streams: c.streams.slice(0, index) });

describe("extendFloor — the golden floor's append path", () => {
  it("empty case first: a corpus whose floor is met gets nothing appended, and a second call is the same", () => {
    let sports = 0;
    forEachSport(({ module, key }) => {
      const corpus = readCorpus(key);
      expect(holesOf(module, corpus), `${key} holes`).toEqual([]);
      const first = extendFloor(module, corpus);
      expect(first.appended, key).toEqual([]);
      expect(first.stillMissing, key).toEqual([]);
      expect(first.corpus.streams, key).toEqual(corpus.streams);
      const second = extendFloor(module, first.corpus);
      expect(second.appended, key).toEqual([]);
      sports++;
    });
    expect(sports).toBe(builtinModules.length);
  });

  it("reproduces each committed floor BATCH byte for byte from the streams preceding it, in order, touching nothing else (batches counted, none is a pass)", () => {
    let batches = 0;
    let floorStreams = 0;
    forEachSport(({ module, key }) => {
      const committed = readCorpus(key);
      const sportBatches = floorBatches(committed);
      expect(sportBatches.length, `${key}: the corpus holds at least one floor batch`).toBeGreaterThan(0);
      sportBatches.forEach((batch, n) => {
        const base = corpusBefore(committed, batch.start);
        expect(base.streams.length, `${key} batch ${n}: the generator's walks are still there`).toBeGreaterThan(0);
        expect(holesOf(module, base).length, `${key} batch ${n}: without its streams the floor has holes`).toBeGreaterThan(0);
        const result = extendFloor(module, base);
        // nothing the floor did not add is touched
        expect(result.corpus.configs, `${key} batch ${n}`).toEqual(base.configs);
        expect(result.corpus.streams.slice(0, base.streams.length), `${key} batch ${n}`).toEqual(base.streams);
        // and the first of what it added is exactly the batch that is committed (a later batch exists because the floor grew after this one)
        const added = result.corpus.streams.slice(base.streams.length);
        expect(added.length, `${key} batch ${n}: at least the committed streams`).toBeGreaterThanOrEqual(batch.streams.length);
        expect(JSON.stringify(added.slice(0, batch.streams.length)), `${key} batch ${n}`).toBe(JSON.stringify(batch.streams));
        expect(JSON.stringify(reproduceFloorBatch(module, committed, batch).slice(0, batch.streams.length)), `${key} batch ${n}: reproduceFloorBatch says the same`).toBe(JSON.stringify(batch.streams));
        if (n === sportBatches.length - 1) {
          // the LAST batch left the floor met: nothing more would be appended, and nothing is missing
          expect(added.length, `${key}: the last batch is everything the floor appends`).toBe(batch.streams.length);
          expect(result.stillMissing, key).toEqual([]);
          expect(holesOf(module, result.corpus), key).toEqual([]);
        }
        batches++;
        floorStreams += batch.streams.length;
      });
    });
    expect(batches, "one batch per sport at least").toBeGreaterThanOrEqual(builtinModules.length);
    expect(floorStreams).toBeGreaterThan(builtinModules.length * 4);
    // Every sport's scenarios, including cricket's search for a tied match (a few hundred seeds): 1.1 s plain, 4.7 s under
    // the CI coverage run, so it carries an explicit budget rather than the 5 s default.
  }, 120_000);

  it("every committed floor stream closes a hole the streams PRECEDING it in the corpus left open (no noise kept)", () => {
    // The keep-rule: a scenario's stream is appended only when it reduces the holes. Measured against what came before it
    // in the corpus — not against every non-floor stream, which a later EXTEND may have appended AFTER the floor.
    let kept = 0;
    forEachSport(({ module, key }) => {
      const committed = readCorpus(key);
      committed.streams.forEach((stream, index) => {
        if (!isFloor(stream)) return;
        const before = holesOf(module, upTo(committed, index));
        const after = holesOf(module, upTo(committed, index + 1));
        expect(after.length, `${key} ${stream.config}#${stream.seed} closes a hole`).toBeLessThan(before.length);
        kept++;
      });
    });
    expect(kept).toBeGreaterThan(builtinModules.length * 4);
  });

  it("a generator stream appended AFTER the floor streams (a later EXTEND) changes neither the reproduction nor the keep-rule", () => {
    let sports = 0;
    forEachSport(({ module, key }) => {
      const committed = readCorpus(key);
      const first = committed.streams.findIndex(isFloor);
      expect(first, `${key}: the corpus has floor streams`).toBeGreaterThan(0);
      // a later EXTEND's walk: a generator stream (seed below the stride, a seed no stream has) after the floor
      const donor = committed.streams[0]!;
      const usedSeeds = new Set(committed.streams.filter((s) => s.config === donor.config).map((s) => s.seed));
      let seed = 90_000;
      while (usedSeeds.has(seed)) seed++;
      const later: GoldenCorpus = { ...committed, streams: [...committed.streams, { ...donor, seed }] };
      expect(isFloor(later.streams[later.streams.length - 1]!)).toBe(false);
      // the base is unchanged by the appended walk
      expect(beforeFloor(later).streams, key).toEqual(beforeFloor(committed).streams);
      // the reproduction still yields the committed floor streams
      const result = extendFloor(module, beforeFloor(later));
      expect(JSON.stringify(result.corpus.streams.slice(first)), key).toBe(JSON.stringify(committed.streams.slice(first).filter(isFloor)));
      expect(result.stillMissing, key).toEqual([]);
      // the keep-rule still holds for every floor stream, and the appended walk leaves the floor met
      later.streams.forEach((stream, index) => {
        if (!isFloor(stream)) return;
        expect(holesOf(module, upTo(later, index + 1)).length, `${key} ${stream.config}#${stream.seed}`).toBeLessThan(holesOf(module, upTo(later, index)).length);
      });
      expect(holesOf(module, later), key).toEqual([]);
      sports++;
    });
    expect(sports).toBe(builtinModules.length);
  }, 30_000);

  it("floor seeds are unique per config inside a corpus (the epoch guard keys a stream by config#seed) and clear of the generator's", () => {
    let identities = 0;
    forEachSport(({ key }) => {
      const corpus = readCorpus(key);
      const seen = new Set<string>();
      for (const s of corpus.streams) {
        const id = `${s.config}#${s.seed}`;
        expect(seen.has(id), `${key} ${id} appears twice`).toBe(false);
        seen.add(id);
        identities++;
      }
      const generatorMax = Math.max(...corpus.streams.filter((s) => !isFloor(s)).map((s) => s.seed));
      expect(generatorMax, key).toBeLessThan(FLOOR_SEED_STRIDE);
    });
    expect(identities).toBeGreaterThan(300);
  });

  it("refuses by name when a floor stream's identity is already taken by another stream", () => {
    const module = builtinModules.find((m) => m.key === "tennis")!;
    const committed = readCorpus("tennis");
    const floor = committed.streams.filter(isFloor);
    expect(floor.length).toBeGreaterThan(0);
    const base = beforeFloor(committed);
    // a decoy wearing the identity the first floor scenario will want, holding none of what the floor needs
    const donor = base.streams[0]!;
    const decoy = { ...donor, config: floor[0]!.config, seed: floor[0]!.seed };
    expect(() => extendFloor(module, { ...base, streams: [...base.streams, decoy] })).toThrow(/already has a stream .*#\d+; the epoch guard keys streams by that identity/);
  });

  it("keeps a scenario's stream only when it closes a hole: a scenario that serves a hole but builds a stream recording nothing new is dropped, the next still runs", () => {
    const module = builtinModules.find((m) => m.key === "badminton")!;
    const committed = readCorpus("badminton");
    const base = beforeFloor(committed);
    const holes = holesOf(module, base);
    expect(holes).toContain(eventToken("core.void"));
    // a noise scenario: claims the void hole, builds a plain generator walk (records no core.void)
    const noise: Scenario = {
      id: "noise",
      serves: () => [eventToken("core.void")],
      build: (ctx: Ctx): Built => {
        const donor = ctx.corpus.streams[0]!;
        return { config: donor.config, seed: FLOOR_SEED_STRIDE + 7, events: donor.events };
      },
    };
    const undo = SCENARIOS.find((s) => s.id === "undo")!;
    const result = extendFloor(module, base, [noise, undo]);
    expect(result.appended.length, "only the scenario that closed a hole was kept").toBe(1);
    expect(result.appended[0]).toMatch(/^undo /);
    expect(result.corpus.streams.some((s) => s.seed === FLOOR_SEED_STRIDE + 7), "the noise stream is not in the corpus").toBe(false);
    // and a scenario that cannot build (null) is skipped, leaving the corpus as it was
    const cannot: Scenario = { id: "cannot", serves: () => [eventToken("core.void")], build: () => null };
    const none = extendFloor(module, base, [cannot]);
    expect(none.appended).toEqual([]);
    expect(none.corpus.streams).toEqual(base.streams);
    expect(none.stillMissing.length).toBe(holes.length);
  });

  it("a retirement story needs recorded play before it: with nothing in the corpus to borrow an event from and a generator that only decides, boardgame builds none; with its corpus it does", () => {
    const module = builtinModules.find((m) => m.key === "boardgame")!;
    const corpus = readCorpus("boardgame");
    const retired = SCENARIOS.find((s) => s.id === "retired")!;
    // the plain config: its generator only ever draws the deciding result at the start state (the tiebreak config's draws a
    // drawn result first, which is play), so the pairing card in the corpus is the only live event there is to borrow
    const cfgNames = ["default"];
    expect(Object.keys(corpus.configs)).toContain("default");
    const holes = new Set(holesOf(module, beforeFloor(corpus)));
    const fed = retired.build({ module, corpus, cfgNames, holes });
    expect(fed, "with the corpus's own pairing event to borrow, a retirement is built").not.toBeNull();
    const events = fed!.events.map((e, i) => makeEnvelope(i, e, e.voids));
    expect(playRecorded(events.slice(0, -1), {}), "and the play before it is real, as the one-off migration reads it").toBe(true);
    const starved = retired.build({ module, corpus: { ...corpus, streams: [] }, cfgNames, holes });
    expect(starved, "a retirement after a bare Start is a walkover wearing the wrong word, not a retirement").toBeNull();
  });
});

describe("the undo stream strikes the KERNEL events that decide or end a match, and play carries on (review 2)", () => {
  type Events = readonly { type: string; payload: unknown; voids?: string }[];
  const setup = (key: string, stream: { config: string; lineups?: unknown }) => {
    const module = builtinModules.find((m) => m.key === key)!;
    const corpus = readCorpus(key);
    const cfg = module.configSchema.parse(corpus.configs[stream.config]) as unknown;
    const lineups = (stream.lineups as never) ?? defaultLineupPair(resolvePositions(module, cfg));
    const fold = (events: Events) => foldMatchWithStoppage(module as never, cfg as never, lineups, events.map((e, i) => makeEnvelope(i, e, e.voids)), { strictFromSeq: 0 });
    /** The effective outcome after the first `count` events — the kernel's reading (forfeit, settle), not the module's. */
    const effective = (events: Events, count: number) => outcomeOf(module as never, fold(events.slice(0, count)) as never);
    /** Whether an abandon is in force: the kernel refuses a forfeit with its own code while one is (events.ts, X-AB-4). */
    const abandonInForce = (events: Events, count: number): boolean => {
      const probe = { type: "core.forfeit", payload: { by: (lineups as { home: { entrantId: string } }).home.entrantId, reason: "retired" } };
      try {
        fold([...events.slice(0, count), probe]);
        return false;
      } catch (error) {
        return error instanceof EngineError && error.code === "ABANDONED_SETTLE_OR_VOID";
      }
    };
    return { effective, abandonInForce };
  };

  it("in every sport, the undo stream's void strikes each of core.forfeit and core.abandon: it took effect, the void clears it, and play resumes to a result", () => {
    let proofs = 0;
    const seen = new Map<string, Set<string>>();
    forEachSport(({ key }) => {
      // (the undo scenario's own stream: the settle and expunge stories strike things too, and are held to their own readings below)
      for (const stream of readCorpus(key).streams.filter((s) => isFloor(s) && s.seed < 2 * FLOOR_SEED_STRIDE)) {
        const { effective, abandonInForce } = setup(key, stream);
        stream.events.forEach((event, v) => {
          if (event.type !== "core.void") return;
          const t = Number(event.voids!.slice(2));
          const target = stream.events[t]!;
          if (!SPLICED_KERNEL.includes(target.type)) return;
          const inForce = (count: number): boolean => (target.type === "core.forfeit" ? effective(stream.events, count) !== null : abandonInForce(stream.events, count));
          expect(effective(stream.events, t), `${key} ${target.type}: live before it`).toBeNull();
          expect(inForce(t + 1), `${key} ${target.type}: it takes effect`).toBe(true);
          expect(inForce(v + 1), `${key} ${target.type}: the void clears it`).toBe(false);
          expect(stream.events.length, `${key} ${target.type}: play resumes after the void`).toBeGreaterThan(v + 1);
          // (the stream's last event is a LATE CORRECTION of a sport event, which may legitimately reopen a decided match: the
          // play that resumed after the kernel strike must have reached its result just before it)
          const last = stream.events[stream.events.length - 1]!;
          const lateCorrection = last.type === "core.void" && !stream.events[Number(last.voids!.slice(2))]!.type.startsWith("core.");
          expect(lateCorrection, `${key}: the stream ends on a late correction`).toBe(true);
          expect(effective(stream.events, stream.events.length - 1), `${key} ${target.type}: play resumed to a result`).not.toBeNull();
          seen.set(key, (seen.get(key) ?? new Set()).add(target.type));
          proofs++;
        });
      }
    });
    for (const m of builtinModules) {
      for (const type of SPLICED_KERNEL) expect(seen.get(m.key)?.has(type), `${m.key} ${type}`).toBe(true);
    }
    expect(proofs).toBeGreaterThanOrEqual(builtinModules.length * SPLICED_KERNEL.length);
  });

  it("every undoable kernel event has a scenario that strikes it: the undo scenario the spliced ones, the settle scenario the rest (derived from UNDOABLE_KERNEL)", () => {
    const served = (id: string): string[] => {
      const ctx: Ctx = { module: builtinModules[0]!, corpus: readCorpus(builtinModules[0]!.key), cfgNames: [], holes: new Set() };
      return SCENARIOS.find((x) => x.id === id)!.serves(ctx);
    };
    const spliced = SPLICED_KERNEL.map(undoToken);
    expect(UNDOABLE_KERNEL.length).toBeGreaterThan(SPLICED_KERNEL.length);
    expect(served("undo")).toEqual(expect.arrayContaining(spliced));
    expect(served("undo"), "the undo scenario cannot strike a settle: it cannot be spliced into a live match").not.toContain(undoToken("core.settle"));
    const rest = UNDOABLE_KERNEL.filter((t) => !SPLICED_KERNEL.includes(t)).map(undoToken);
    expect(rest).toEqual([undoToken("core.settle")]);
    expect(served("settle")).toEqual(expect.arrayContaining(rest));
    // every undo token of the floor is served by exactly one scenario
    for (const t of UNDOABLE_KERNEL.map(undoToken)) expect(SCENARIOS.filter((x) => served(x.id).includes(t)).map((x) => x.id), t).toHaveLength(1);
  });

  it("each sport's undo stream holds a LATE correction: a sport event struck after later play, so the void is not next to its target (review finding 4)", () => {
    let late = 0;
    forEachSport(({ key }) => {
      const undo = readCorpus(key).streams.filter((s) => isFloor(s) && s.seed < 2 * FLOOR_SEED_STRIDE);
      expect(undo.length, `${key}: one undo stream`).toBe(1);
      const events = undo[0]!.events;
      const gaps = events.flatMap((e, v) => {
        if (e.type !== "core.void") return [];
        const t = Number(e.voids!.slice(2));
        return events[t]!.type.startsWith("core.") ? [] : [v - t];
      });
      expect(gaps.length, `${key}: voids of sport events`).toBeGreaterThanOrEqual(2);
      expect(Math.max(...gaps), `${key}: some correction is not immediate`).toBeGreaterThan(1);
      late++;
    });
    expect(late).toBe(builtinModules.length);
  });

  it("the standing abandon streams of the floor are real: an abandon no void strikes, in force at the end", () => {
    let standing = 0;
    forEachSport(({ key }) => {
      const corpus = readCorpus(key);
      for (const stream of corpus.streams) {
        // (a settled abandon is the settle story's: the match it ended has an outcome by the organiser's word, and a forfeit is
        // refused for that reason, not this one)
        if (stream.events.some((e) => e.type === "core.settle" || (e.type === "core.abandon" && (e.payload as { expunge?: boolean }).expunge === true))) continue;
        const i = stream.events.findIndex((e, k) => e.type === "core.abandon" && !stream.events.some((x) => x.voids === `e-${k}`));
        if (i < 0) continue;
        expect(setup(key, stream).abandonInForce(stream.events, stream.events.length), `${key} ${stream.config}#${stream.seed}`).toBe(true);
        standing++;
      }
    });
    expect(standing).toBeGreaterThanOrEqual(builtinModules.length);
  });
});

describe("strikeKernelEvent — every guard of the splice is reached (a guard nothing kills is not tested)", () => {
  const module = builtinModules.find((m) => m.key === "football")!;
  const corpus = readCorpus("football");
  const cfg = module.configSchema.parse(corpus.configs.default) as unknown;
  const lineups = defaultLineupPair(resolvePositions(module, cfg));
  const ctx: Ctx = { module, corpus, cfgNames: ["default"], holes: new Set() };
  const START = { type: "core.start", payload: {} };
  // a decided football ledger from the generator's own walks: the longest non-floor stream that ends decided
  const walk = corpus.streams
    .filter((s) => !isFloor(s) && s.events.every((e) => e.voids === undefined && e.type !== "core.forfeit" && e.type !== "core.abandon" && !e.type.startsWith("core.lineup")))
    .sort((a, b) => b.events.length - a.events.length)[0]!;
  const ledger = walk.events;
  const [forfeit, abandon] = kernelStrikes(lineups);

  it("the real strikes splice a pair into the ledger, and removing the pair gives the ledger back exactly", () => {
    expect(ledger.length).toBeGreaterThan(6);
    for (const strike of [forfeit!, abandon!]) {
      const spliced = strikeKernelEvent(ctx, cfg, lineups, ledger, strike, 2);
      expect(spliced, strike.type).not.toBeNull();
      expect(spliced!.length, strike.type).toBe(ledger.length + 2);
      const q = spliced!.findIndex((e) => e.type === strike.type);
      expect(q, strike.type).toBeGreaterThanOrEqual(2);
      expect(spliced![q + 1], strike.type).toEqual({ type: "core.void", payload: {}, voids: `e-${q}` });
      expect([...spliced!.slice(0, q), ...spliced!.slice(q + 2)], strike.type).toEqual(ledger);
    }
  });

  it("an event that never takes effect, or one the void does not clear, is not spliced", () => {
    const never: KernelStrike = { ...forfeit!, inForce: () => false };
    const stuck: KernelStrike = { ...forfeit!, inForce: () => true };
    expect(strikeKernelEvent(ctx, cfg, lineups, ledger, never, 2), "takes no effect").toBeNull();
    expect(strikeKernelEvent(ctx, cfg, lineups, ledger, stuck, 2), "the void does not clear it").toBeNull();
  });

  it("a retirement-shaped strike that needs play is not spliced where nothing has been played, though the fold would admit it", () => {
    // a disqualification is admitted after a bare Start (R4), so only the strike's own `needsPlay` stops it here
    const dq: KernelStrike = { ...forfeit!, event: { type: "core.forfeit", payload: { by: lineups.home.entrantId, reason: "disqualified" } }, needsPlay: true };
    const bareStart = [START, ledger.find((e) => !e.type.startsWith("core."))!];
    expect(strikeKernelEvent(ctx, cfg, lineups, bareStart, { ...dq, needsPlay: false }, 1), "without the play rule the fold admits it").not.toBeNull();
    expect(strikeKernelEvent(ctx, cfg, lineups, bareStart, dq, 1), "with it, nothing has been played before the splice point").toBeNull();
  });

  it("an abandon is 'in force' only on the kernel's own refusal: struck right after a bare Start, where a forfeit is refused for ANOTHER reason, it still splices", () => {
    const play = ledger.find((e) => !e.type.startsWith("core."))!;
    // [Start, play]: the splice point 1 has a bare Start before it, so the probe forfeit is refused by the phase guard
    // (nothing played) once the abandon is voided - a refusal that is NOT ABANDONED_SETTLE_OR_VOID, and so not "in force"
    const spliced = strikeKernelEvent(ctx, cfg, lineups, [START, play], abandon!, 1);
    expect(spliced, "the void clears the abandon; the refusal that remains is a different one").not.toBeNull();
    expect(spliced!.map((e) => e.type)).toEqual(["core.start", "core.abandon", "core.void", play.type]);
  });

  it("a void that leaves the module in a different state than before is not spliced (a module whose fold is not a function of the ledger)", () => {
    let tick = 0;
    const impure = {
      ...module,
      apply: (state: object, event: never, ...rest: never[]) => ({ ...(module.apply as (...a: unknown[]) => object)(state, event, ...rest), tick: ++tick }),
    } as unknown as typeof module;
    const impureCtx: Ctx = { ...ctx, module: impure };
    expect(strikeKernelEvent(impureCtx, cfg, lineups, ledger, forfeit!, 2), "the same ledger folded twice differs").toBeNull();
    // and the pure module splices the very same ledger: it is the state check that refused
    expect(strikeKernelEvent(ctx, cfg, lineups, ledger, forfeit!, 2)).not.toBeNull();
  });

  it("a ledger whose remaining events hold a void is not spliced (the splice does not rewrite ids)", () => {
    const g = ledger.find((e) => !e.type.startsWith("core.") && e.type === "football.goal") ?? ledger.find((e) => !e.type.startsWith("core."))!;
    const voided = [START, g, g, { type: "core.void", payload: {}, voids: "e-1" }];
    const dq: KernelStrike = { ...forfeit!, event: { type: "core.forfeit", payload: { by: lineups.home.entrantId, reason: "disqualified" } }, needsPlay: false };
    expect(strikeKernelEvent(ctx, cfg, lineups, voided, dq, 1), "every point has the void in its tail").toBeNull();
  });
});

describe("floor batches — a floor is reproduced one maximal run at a time (GF-2 T3)", () => {
  const donor = (seed: number): GoldenStream => ({ ...readCorpus("badminton").streams[0]!, seed });
  const withSeeds = (seeds: number[]): GoldenCorpus => ({ ...readCorpus("badminton"), streams: seeds.map(donor) });

  it("empty case first: a corpus with no stream, or no floor stream, has no batch", () => {
    expect(floorBatches({ ...readCorpus("badminton"), streams: [] })).toEqual([]);
    expect(floorBatches(withSeeds([1, 2, 3]))).toEqual([]);
  });

  it("a batch is a MAXIMAL run of consecutive floor streams: a generator walk between two runs splits them, two extends with nothing between are one", () => {
    const S = FLOOR_SEED_STRIDE;
    const batches = floorBatches(withSeeds([1, 2, S + 1, 2 * S + 1, 3, S + 2, 3 * S + 1, 3 * S + 2]));
    expect(batches.map((b) => [b.start, b.streams.map((x) => x.seed)])).toEqual([
      [2, [S + 1, 2 * S + 1]],
      [5, [S + 2, 3 * S + 1, 3 * S + 2]],
    ]);
    // a floor stream first, and last
    expect(floorBatches(withSeeds([S + 1, 1, S + 2])).map((b) => b.start)).toEqual([0, 2]);
    // the seed that starts the floor is the stride itself, and one below is a walk
    expect(floorBatches(withSeeds([S - 1, S])).map((b) => b.start)).toEqual([1]);
  });

  it("corpusBefore keeps the streams before the index and ONLY the configs they reference, in the corpus's own order, without touching the corpus it was given", () => {
    let multi = 0;
    forEachSport(({ key }) => {
      const corpus = readCorpus(key);
      const frozen = JSON.stringify(corpus);
      const names = Object.keys(corpus.configs);
      const none = corpusBefore(corpus, 0);
      expect(none.streams, `${key}: nothing precedes the first stream`).toEqual([]);
      expect(none.configs, `${key}: and no config is referenced`).toEqual({});
      const all = corpusBefore(corpus, corpus.streams.length);
      expect(all.streams, key).toEqual(corpus.streams);
      expect(Object.keys(all.configs), `${key}: every committed config is referenced by some stream`).toEqual(names);
      if (names.length > 1) {
        multi++;
        // the first stream that uses a config other than the first stream's: before it, that config is not there
        const second = corpus.streams.findIndex((x) => x.config !== corpus.streams[0]!.config);
        expect(second, `${key}: a stream of another config`).toBeGreaterThan(0);
        const before = corpusBefore(corpus, second);
        expect(Object.keys(before.configs), key).toEqual([corpus.streams[0]!.config]);
        expect(Object.keys(before.configs).length).toBeLessThan(names.length);
      }
      expect({ ...none, configs: corpus.configs, streams: corpus.streams }, `${key}: every other field of the corpus is carried`).toEqual(corpus);
      expect(JSON.stringify(corpus), `${key}: the input is untouched`).toBe(frozen);
    });
    expect(multi, "sports with more than one config were checked").toBeGreaterThan(3);
  });

  it("a config added AFTER the floor changes what the floor derives under the old rule (every config the corpus holds) and not under the new one — carrom, where a draw-house config widens the requirement", () => {
    const module = builtinModules.find((m) => m.key === "carrom")!;
    const committed = readCorpus("carrom");
    const batch = floorBatches(committed)[0]!;
    // what a later wave does: a new config (draws allowed on the tie board) and a generator walk of it, after the floor
    const raw = { ...(committed.configs.default as object), tieBoard: "draw" };
    const cfg = module.configSchema.parse(raw) as unknown;
    expect((module.supportsDraws as (c: unknown, s: string) => boolean)(cfg, "league"), "the new config can end level (the sport's own declaration)").toBe(true);
    const lineups = defaultLineupPair(resolvePositions(module, cfg));
    const events = buildWalk(module, cfg, lineups, 1, 120).events.map((e) => ({ type: e.type, payload: e.payload }));
    const walk: GoldenStream = { config: "drawHouse", seed: 1, events, ...storedFields(recomputeStream(module, raw, events, undefined, corpusFormat(committed))) };
    const grown: GoldenCorpus = { ...committed, configs: { ...committed.configs, drawHouse: raw }, streams: [...committed.streams, slimStream(module, committed, walk)] };
    expect(floorBatches(grown).map((b) => b.start), "the walk sits after the batch, which is untouched").toEqual([batch.start]);
    // the new config moves the requirement: carrom had no reason to want a level outcome before it
    const level = ["outcome:draw", "outcome:tie", "outcome:no_result"] as const;
    const wanted = (c: GoldenCorpus): string[] => level.filter((t) => floorRequirement(module, c).required.has(t));
    expect(wanted(committed), "before the config: no level outcome is required of carrom").toEqual([]);
    expect(wanted(grown).length, "after it: one is").toBeGreaterThan(0);

    const same = (streams: readonly GoldenStream[]): boolean => JSON.stringify(streams.slice(0, batch.streams.length)) === JSON.stringify(batch.streams);
    // OLD rule: the corpus before the first floor stream, with every config the corpus holds now
    const oldBase: GoldenCorpus = { ...grown, streams: grown.streams.slice(0, batch.start) };
    expect(Object.keys(oldBase.configs)).toContain("drawHouse");
    let oldReproduces: boolean;
    try {
      oldReproduces = same(extendFloor(module, oldBase).corpus.streams.slice(oldBase.streams.length));
    } catch {
      oldReproduces = false;
    }
    expect(oldReproduces, "the old rule derives a different floor from the same streams").toBe(false);
    // NEW rule: the configs the preceding streams reference
    expect(Object.keys(corpusBefore(grown, batch.start).configs)).not.toContain("drawHouse");
    expect(same(reproduceFloorBatch(module, grown, floorBatches(grown)[0]!)), "the new rule reproduces the batch").toBe(true);
  }, 60_000);

  it("a floor that GREW after its first batch is two batches, and each reproduces from the streams preceding it (the older one as the first of what today's rules append)", () => {
    const module = builtinModules.find((m) => m.key === "badminton")!;
    const committed = readCorpus("badminton");
    const GF1 = SCENARIOS.filter((x) => x.id !== "settle" && x.id !== "expunge");
    expect(GF1.length, "the rules as GF-1 shipped them").toBe(SCENARIOS.length - 2);
    // the floor as GF-1 left it, a later wave's walk, then the floor as it is today
    const first = extendFloor(module, beforeFloor(committed), GF1).corpus;
    const walkStream = slimStream(module, first, { ...committed.streams[0]!, seed: 99_001 });
    const later: GoldenCorpus = { ...first, streams: [...first.streams, walkStream] };
    const grown = extendFloor(module, later, SCENARIOS);
    expect(grown.appended.length, "the grown floor appended streams").toBeGreaterThan(0);
    const batches = floorBatches(grown.corpus);
    expect(batches.length, "the walk splits the floor into two runs").toBe(2);
    expect(batches[1]!.start, "the second run starts right after the walk").toBe(later.streams.length);
    batches.forEach((batch, n) => {
      const reproduced = reproduceFloorBatch(module, grown.corpus, batch);
      expect(JSON.stringify(reproduced.slice(0, batch.streams.length)), `batch ${n}`).toBe(JSON.stringify(batch.streams));
    });
    // the older batch is only the FIRST of what today's rules append there (the settle story is theirs too): a whole-run comparison would be wrong
    expect(reproduceFloorBatch(module, grown.corpus, batches[0]!).length).toBeGreaterThan(batches[0]!.streams.length);
    // the newer batch was derived with the walk and the older batch in front of it
    expect(corpusBefore(grown.corpus, batches[1]!.start).streams.length).toBe(batches[1]!.start);
  }, 60_000);
});

describe("the settle and expunge stories (GF-2 T3) — each step is the kernel's own reading", () => {
  const stories = (key: string, scenarioIndex: number) => readCorpus(key).streams.filter((s) => s.seed >= scenarioIndex * FLOOR_SEED_STRIDE && s.seed < (scenarioIndex + 1) * FLOOR_SEED_STRIDE);
  const readingOf = (key: string, stream: GoldenStream) => {
    const module = builtinModules.find((m) => m.key === key)!;
    const corpus = readCorpus(key);
    const cfg = module.configSchema.parse(corpus.configs[stream.config]) as unknown;
    const lineups = (stream.lineups as never) ?? defaultLineupPair(resolvePositions(module, cfg));
    const folded = (count: number) => foldMatchWithStoppage(module as never, cfg as never, lineups, stream.events.slice(0, count).map((e, i) => makeEnvelope(i, e, e.voids)), { strictFromSeq: 0 });
    return { module, lineups: lineups as { home: { entrantId: string }; away: { entrantId: string } }, folded, effective: (count: number) => outcomeOf(module as never, folded(count) as never) };
  };

  it("the scenario order is the order a floor is reproduced in: settle and expunge are APPENDED after the GF-1 stories", () => {
    expect(SCENARIOS.map((x) => x.id)).toEqual(["undo", "stoppage", "abandon", "walkover", "double_walkover", "retired", "disqualified", "withdrew", "settle", "expunge"]);
  });

  it("every sport has one settle stream; where the floor wants a withdrawal over a level result it is the level route, elsewhere the abandon route, and the kernel reads each step as the story says", () => {
    let level = 0;
    let abandoned = 0;
    forEachSport(({ key, module }) => {
      const found = stories(key, 9);
      expect(found.length, `${key}: one settle stream`).toBe(1);
      const stream = found[0]!;
      const { lineups, folded, effective } = readingOf(key, stream);
      const requirement = floorRequirement(module, readCorpus(key)).required;
      const levelSport = requirement.has(overlayToken("levelWithdrawal", "set"));
      const types = stream.events.map((e) => e.type);
      const n = stream.events.findIndex((e) => e.type === "core.forfeit" || e.type === "core.abandon");
      expect(n, `${key}: the story's first kernel event`).toBeGreaterThan(0);
      if (levelSport) {
        // [walk to a level result] withdrew, void, settle, void, settle
        expect(types.slice(n), key).toEqual(["core.forfeit", "core.void", "core.settle", "core.void", "core.settle"]);
        expect(stream.events[n]!.payload, key).toEqual({ by: lineups.home.entrantId, reason: "withdrew" });
        const held = effective(n);
        expect(held && ["draw", "tie", "no_result"].includes(held.kind), `${key}: the walk ended level (${JSON.stringify(held)})`).toBe(true);
        expect(folded(n).levelWithdrawal, key).toBeNull();
        expect(folded(n + 1).levelWithdrawal, `${key}: the withdrawal is laid over the level result`).not.toBeNull();
        expect(effective(n + 1), `${key}`).toMatchObject({ kind: "award", reason: "withdrew" });
        expect(folded(n + 2).levelWithdrawal, `${key}: the void takes it away`).toBeNull();
        expect(effective(n + 2), `${key}: and the level result is back`).toEqual(held);
        expect(effective(n + 3), `${key}: the settle decides it`).toMatchObject({ kind: "win", method: "settled_organiser", winner: lineups.home.entrantId });
        expect(effective(n + 4), `${key}: its void takes the win away`).toEqual(held);
        level++;
      } else {
        expect(types.slice(n), key).toEqual(["core.abandon", "core.settle", "core.void", "core.settle"]);
        expect(effective(n + 1), `${key}: an abandoned match decides nothing`).toBeNull();
        expect(effective(n + 2), `${key}: the settle decides it`).toMatchObject({ kind: "win", method: "settled_organiser", winner: lineups.home.entrantId });
        expect(effective(n + 3), `${key}: its void takes the win away`).toBeNull();
        abandoned++;
      }
      expect(effective(stream.events.length), `${key}: said again by lot, for the other side`).toMatchObject({ kind: "win", method: "settled_lot", winner: lineups.away.entrantId });
      expect(folded(stream.events.length).settlement, key).not.toBeNull();
    });
    expect(level, "the level-capable sports: football, cricket, boardgame, generic, icehockey, hockey").toBeGreaterThanOrEqual(5);
    expect(abandoned, "and the rest").toBeGreaterThanOrEqual(5);
    expect(level + abandoned).toBe(builtinModules.length);
  }, 60_000);

  it("every sport has one expunge stream: the abandon takes the match off the table, its void puts it back, and play carries on to the result it had", () => {
    let proofs = 0;
    forEachSport(({ key }) => {
      const found = stories(key, 10);
      expect(found.length, `${key}: one expunge stream`).toBe(1);
      const stream = found[0]!;
      const { folded, effective } = readingOf(key, stream);
      const at = stream.events.findIndex((e) => e.type === "core.abandon");
      expect(at, `${key}: an abandon`).toBeGreaterThan(0);
      expect(stream.events[at]!.payload, key).toMatchObject({ expunge: true });
      expect(stream.events[at + 1], `${key}: struck at once`).toEqual({ type: "core.void", payload: {}, voids: `e-${at}` });
      expect(folded(at).expunged, `${key}: live before it`).toBe(false);
      expect(folded(at + 1).expunged, `${key}: the abandon expunges the match`).toBe(true);
      expect(effective(at + 1), `${key}: and an expunged match has no outcome`).toBeNull();
      expect(folded(at + 2).expunged, `${key}: the void puts it back`).toBe(false);
      expect(stream.events.length, `${key}: play resumes`).toBeGreaterThan(at + 2);
      expect(effective(stream.events.length), `${key}: to a result`).not.toBeNull();
      proofs++;
    });
    expect(proofs).toBe(builtinModules.length);
  }, 60_000);

  it("expungeStrike is the abandon the withdrawal cascade writes (expunge flagged) and is in force exactly while the kernel says expunged", () => {
    const module = builtinModules.find((m) => m.key === "football")!;
    const corpus = readCorpus("football");
    const cfg = module.configSchema.parse(corpus.configs.default) as unknown;
    const lineups = defaultLineupPair(resolvePositions(module, cfg));
    const ctx: Ctx = { module, corpus, cfgNames: ["default"], holes: new Set() };
    const strike = expungeStrike();
    expect(strike.type).toBe("core.abandon");
    expect(strike.event.payload).toMatchObject({ expunge: true });
    const start = { type: "core.start", payload: {} };
    expect(strike.inForce(ctx, cfg, lineups, [start])).toBe(false);
    expect(strike.inForce(ctx, cfg, lineups, [start, strike.event])).toBe(true);
    expect(strike.inForce(ctx, cfg, lineups, [start, strike.event, { type: "core.void", payload: {}, voids: "e-1" }])).toBe(false);
    // a PLAIN abandon (no flag) is not an expunge
    expect(strike.inForce(ctx, cfg, lineups, [start, { type: "core.abandon", payload: { reason: "rain" } }])).toBe(false);
  });
});

describe("readsAs — a story step is kept only when the kernel's own fold says it took effect", () => {
  const module = builtinModules.find((m) => m.key === "football")!;
  const corpus = readCorpus("football");
  // the committed level-route settle stream: [walk to a level result] withdrew, void, settle, void, settle
  const stream = corpus.streams.find((s) => s.seed >= 9 * FLOOR_SEED_STRIDE && s.seed < 10 * FLOOR_SEED_STRIDE)!;
  const cfg = module.configSchema.parse(corpus.configs[stream.config]) as unknown;
  const lineups = defaultLineupPair(resolvePositions(module, cfg));
  const ctx: Ctx = { module, corpus, cfgNames: [stream.config], holes: new Set() };
  const n = stream.events.findIndex((e) => e.type === "core.forfeit");
  const at = (count: number) => stream.events.slice(0, count);
  const START = { type: "core.start", payload: {} };

  it("precondition: the stream is the level route (a withdrawal at n, its void, a settle, its void, a settle)", () => {
    expect(n).toBeGreaterThan(0);
    expect(stream.events.slice(n).map((e) => e.type)).toEqual(["core.forfeit", "core.void", "core.settle", "core.void", "core.settle"]);
  });

  it("settled: true only while a settle stands, false before it and after its void", () => {
    expect(readsAs(ctx, cfg, lineups, at(n + 3), { settled: true })).toBe(true);
    expect(readsAs(ctx, cfg, lineups, at(n + 3), { settled: false })).toBe(false);
    expect(readsAs(ctx, cfg, lineups, at(n + 2), { settled: false })).toBe(true);
    expect(readsAs(ctx, cfg, lineups, at(n + 2), { settled: true })).toBe(false);
    expect(readsAs(ctx, cfg, lineups, at(n + 4), { settled: false })).toBe(true);
  });

  it("withdrawn: true only while the withdrawal laid over the level result stands", () => {
    expect(readsAs(ctx, cfg, lineups, at(n + 1), { withdrawn: true })).toBe(true);
    expect(readsAs(ctx, cfg, lineups, at(n + 1), { withdrawn: false })).toBe(false);
    expect(readsAs(ctx, cfg, lineups, at(n), { withdrawn: false })).toBe(true);
    expect(readsAs(ctx, cfg, lineups, at(n), { withdrawn: true })).toBe(false);
    expect(readsAs(ctx, cfg, lineups, at(n + 2), { withdrawn: false })).toBe(true);
  });

  it("expunged: true only while an expunging abandon stands, and a PLAIN abandon is not one", () => {
    const expunge = [START, expungeStrike().event];
    expect(readsAs(ctx, cfg, lineups, expunge, { expunged: true })).toBe(true);
    expect(readsAs(ctx, cfg, lineups, expunge, { expunged: false })).toBe(false);
    const plain = [START, { type: "core.abandon", payload: { reason: "rain" } }];
    expect(readsAs(ctx, cfg, lineups, plain, { expunged: false })).toBe(true);
    expect(readsAs(ctx, cfg, lineups, plain, { expunged: true })).toBe(false);
    expect(readsAs(ctx, cfg, lineups, [...expunge, { type: "core.void", payload: {}, voids: "e-1" }], { expunged: false })).toBe(true);
  });

  it("every fact asked must hold (one wrong fact among right ones fails), and a fact not asked is not judged", () => {
    expect(readsAs(ctx, cfg, lineups, at(n + 3), { settled: true, withdrawn: false, expunged: false })).toBe(true);
    expect(readsAs(ctx, cfg, lineups, at(n + 3), { settled: true, withdrawn: true })).toBe(false);
    expect(readsAs(ctx, cfg, lineups, at(n + 3), { settled: true, expunged: true })).toBe(false);
    expect(readsAs(ctx, cfg, lineups, at(n + 3), { settled: false, withdrawn: false, expunged: false })).toBe(false);
    expect(readsAs(ctx, cfg, lineups, at(n + 3), {})).toBe(true);
  });

  it("a ledger the fold REFUSES reads as nothing at all, whatever was asked (a settle over a match still live)", () => {
    const refused = [START, { type: "core.settle", payload: { winner: lineups.home.entrantId, method: "organiser" } }];
    expect(readsAs(ctx, cfg, lineups, refused, {})).toBe(false);
    expect(readsAs(ctx, cfg, lineups, refused, { settled: true })).toBe(false);
  });
});

describe("settleStoryHolds and playsOnToTheSameResult — a story is kept only when EVERY step took effect (each step is defeated alone)", () => {
  const rig = (key: string, scenarioIndex: number) => {
    const module = builtinModules.find((m) => m.key === key)!;
    const corpus = readCorpus(key);
    const stream = corpus.streams.find((s) => s.seed >= scenarioIndex * FLOOR_SEED_STRIDE && s.seed < (scenarioIndex + 1) * FLOOR_SEED_STRIDE)!;
    const cfg = module.configSchema.parse(corpus.configs[stream.config]) as unknown;
    const lineups = defaultLineupPair(resolvePositions(module, cfg));
    const ctx: Ctx = { module, corpus, cfgNames: [stream.config], holes: new Set() };
    return { ctx, cfg, lineups, stream };
  };
  /** The same ledger with one event replaced by a note: it still folds, the step simply does not happen. */
  const defeated = (events: readonly GoldenEvent[], index: number): GoldenEvent[] => events.map((e, i) => (i === index ? { type: "core.note", payload: { text: "this step did not happen" } } : e));

  it("level route (football): the committed story holds, and defeating any ONE of its five kernel steps refuses it", () => {
    const { ctx, cfg, lineups, stream } = rig("football", 9);
    const n = stream.events.findIndex((e) => e.type === "core.forfeit");
    expect(stream.events.slice(n).map((e) => e.type), "precondition: the level route").toEqual(["core.forfeit", "core.void", "core.settle", "core.void", "core.settle"]);
    expect(settleStoryHolds(ctx, cfg, lineups, stream.events, n, "level"), "control").toBe(true);
    let refused = 0;
    for (let step = 0; step < 5; step++) {
      expect(settleStoryHolds(ctx, cfg, lineups, defeated(stream.events, n + step), n, "level"), `step ${step} (${stream.events[n + step]!.type}) defeated`).toBe(false);
      refused++;
    }
    expect(refused, "anti-vacuity: all five steps were defeated").toBe(5);
  });

  it("abandon route (badminton): the committed story holds, and defeating any ONE of its four kernel steps refuses it", () => {
    const { ctx, cfg, lineups, stream } = rig("badminton", 9);
    const n = stream.events.findIndex((e) => e.type === "core.abandon");
    expect(stream.events.slice(n).map((e) => e.type), "precondition: the abandon route").toEqual(["core.abandon", "core.settle", "core.void", "core.settle"]);
    expect(settleStoryHolds(ctx, cfg, lineups, stream.events, n, "abandon"), "control").toBe(true);
    let refused = 0;
    for (let step = 0; step < 4; step++) {
      expect(settleStoryHolds(ctx, cfg, lineups, defeated(stream.events, n + step), n, "abandon"), `step ${step} (${stream.events[n + step]!.type}) defeated`).toBe(false);
      refused++;
    }
    expect(refused, "anti-vacuity: all four steps were defeated").toBe(4);
  });

  it("a route is not interchangeable: the level story read as the abandon story (or the reverse) is refused", () => {
    const level = rig("football", 9);
    const nl = level.stream.events.findIndex((e) => e.type === "core.forfeit");
    expect(settleStoryHolds(level.ctx, level.cfg, level.lineups, level.stream.events, nl, "abandon")).toBe(false);
    const abandon = rig("badminton", 9);
    const na = abandon.stream.events.findIndex((e) => e.type === "core.abandon");
    expect(settleStoryHolds(abandon.ctx, abandon.cfg, abandon.lineups, abandon.stream.events, na, "level")).toBe(false);
  });

  it("expunge tail (swept, counted): the committed story plays on to the result of its bare walk; a standing expunge, a different result and a refused ledger do not", () => {
    let checked = 0;
    forEachSport(({ key }) => {
      const { ctx, cfg, lineups, stream } = rig(key, 10);
      const at = stream.events.findIndex((e) => e.type === "core.abandon");
      expect(at, `${key}: the expunging abandon`).toBeGreaterThan(0);
      // the bare walk is the story with the abandon and its void taken out; ITS result is the token the tail must reach
      const bare = stream.events.filter((_, i) => i !== at && i !== at + 1);
      const result = outcomeOf(ctx.module as never, foldMatchWithStoppage(ctx.module as never, cfg as never, lineups, bare.map((e, i) => makeEnvelope(i, e, e.voids)), { strictFromSeq: 0 }) as never);
      expect(result, `${key}: the bare walk is decided`).not.toBeNull();
      const token = outcomeTokenOf(JSON.stringify(result));
      expect(token, `${key}: and has a token`).not.toBeNull();
      expect(playsOnToTheSameResult(ctx, cfg, lineups, stream.events, token!), `${key}: control`).toBe(true);
      expect(playsOnToTheSameResult(ctx, cfg, lineups, stream.events, `${token}-not`), `${key}: a different result`).toBe(false);
      // the expunge left standing (the void taken out): an expunged match has no outcome, so it plays on to nothing
      const standing = stream.events.filter((_, i) => i !== at + 1);
      expect(playsOnToTheSameResult(ctx, cfg, lineups, standing, token!), `${key}: expunge left standing`).toBe(false);
      // a ledger the strict fold refuses: a void of an event that is not there
      expect(playsOnToTheSameResult(ctx, cfg, lineups, [...stream.events, { type: "core.void", payload: {}, voids: "e-9999" }], token!), `${key}: refused`).toBe(false);
      checked++;
    });
    expect(checked).toBe(builtinModules.length);
  }, 60_000);
});

describe("every overlay, undo and settle token the floor can require is SERVED by some scenario (a token no scenario serves can never be extended)", () => {
  it("swept per sport: the required overlay:*, undo:* and event:core.settle tokens", () => {
    let checked = 0;
    forEachSport(({ module, key }) => {
      const corpus = readCorpus(key);
      const required = [...floorRequirement(module, corpus).required.keys()].filter((t) => t.startsWith("overlay:") || t.startsWith("undo:") || t === eventToken("core.settle"));
      const ctx: Ctx = { module, corpus, cfgNames: Object.keys(corpus.configs), holes: new Set(required) };
      const served = new Set(SCENARIOS.flatMap((x) => x.serves(ctx)));
      for (const token of required) {
        expect(served.has(token), `${key}: ${token}`).toBe(true);
        checked++;
      }
    });
    // five overlay facts + undo tokens + settle, per sport (squads and stoppage are served by the older stories)
    expect(checked).toBeGreaterThan(builtinModules.length * 8);
  });
});

describe("the withdrawal story carries lineup changes whenever the squads still owe a move (GF-2 T3)", () => {
  it("with overlay:squads:set the only hole, the story is built WITH lineup changes; with no hole it is not", () => {
    let withLineup = 0;
    forEachSport(({ module, key }) => {
      const corpus = readCorpus(key);
      const withdrew = SCENARIOS.find((x) => x.id === "withdrew")!;
      const ctxFor = (holes: Set<FloorToken>): Ctx => ({ module, corpus, cfgNames: Object.keys(corpus.configs), holes });
      const owed = withdrew.build(ctxFor(new Set([overlayToken("squads", "set")])));
      const none = withdrew.build(ctxFor(new Set([])));
      expect(none, `${key}: the story is built`).not.toBeNull();
      expect(owed, `${key}: and with a squads hole`).not.toBeNull();
      const lineupEvents = (b: Built | null): number => (b?.events ?? []).filter((e) => e.type.startsWith("core.lineup.")).length;
      expect(lineupEvents(none), `${key}: nothing owes a lineup change, so none is spliced`).toBe(0);
      expect(lineupEvents(owed), `${key}: squads owed, so the story carries them`).toBeGreaterThan(0);
      withLineup++;
    });
    expect(withLineup).toBe(builtinModules.length);
  }, 60_000);

  it("the withdrawal story serves overlay:squads:set and the stoppage story serves both stoppage tokens", () => {
    const ctx: Ctx = { module: builtinModules[0]!, corpus: readCorpus(builtinModules[0]!.key), cfgNames: [], holes: new Set() };
    expect(SCENARIOS.find((x) => x.id === "withdrew")!.serves(ctx)).toContain(overlayToken("squads", "set"));
    expect(SCENARIOS.find((x) => x.id === "stoppage")!.serves(ctx)).toEqual(expect.arrayContaining([overlayToken("stoppage", "set"), overlayToken("stoppage", "cleared")]));
  });
});
