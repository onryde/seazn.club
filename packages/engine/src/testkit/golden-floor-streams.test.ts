// extendFloor (GF-1) — the append path of the golden floor. The committed floor streams are the expected values: the
// path must reproduce them byte for byte from a corpus that lacks them (deterministic), touch nothing it did not add,
// do nothing when the floor is met (the empty case and the second call), and refuse an identity clash by name.
import { describe, expect, it } from "vitest";
import { builtinModules } from "../sports/index.ts";
import { forEachSport } from "./for-each-sport.ts";
import { readCorpus, type GoldenCorpus } from "./golden.ts";
import { eventToken, floorHoles as holesOf } from "./golden-floor.ts";
import { extendFloor, FLOOR_SEED_STRIDE, kernelStrikes, SCENARIOS, strikeKernelEvent, type Built, type Ctx, type KernelStrike, type Scenario } from "./golden-floor-streams.ts";
import { EngineError } from "../core/errors.ts";
import { foldMatchWithStoppage, outcomeOf, playRecorded } from "../core/events.ts";
import { resolvePositions } from "../sport/catalog.ts";
import { defaultLineupPair, makeEnvelope } from "./helpers.ts";
import { UNDOABLE_KERNEL } from "./golden-floor.ts";

const isFloor = (s: { seed: number }): boolean => s.seed >= FLOOR_SEED_STRIDE;
/** The corpus as it stood when the floor streams were generated: every stream BEFORE the first floor stream, and none of
 *  what was appended after (a later `EXTEND_GOLDEN` appends generator walks at the END; the floor was never measured
 *  against them). */
const beforeFloor = (c: GoldenCorpus): GoldenCorpus => {
  const first = c.streams.findIndex(isFloor);
  return { ...c, streams: first < 0 ? c.streams : c.streams.slice(0, first) };
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

  it("reproduces the committed floor streams byte for byte from a corpus that lacks them, in order, touching nothing else", () => {
    let floorStreams = 0;
    forEachSport(({ module, key }) => {
      const committed = readCorpus(key);
      const base = beforeFloor(committed);
      expect(base.streams.length, `${key}: the generator's walks are still there`).toBeGreaterThan(0);
      const holesBefore = holesOf(module, base);
      expect(holesBefore.length, `${key}: without its floor streams the floor has holes`).toBeGreaterThan(0);
      const result = extendFloor(module, base);
      // nothing the floor did not add is touched
      expect(result.corpus.configs, key).toEqual(base.configs);
      expect(result.corpus.streams.slice(0, base.streams.length), key).toEqual(base.streams);
      // and what it added is exactly what is committed
      const added = result.corpus.streams.slice(base.streams.length);
      const expected = committed.streams.slice(base.streams.length).filter(isFloor);
      expect(committed.streams.filter(isFloor).length, `${key}: every floor stream sits after the base`).toBe(expected.length);
      expect(added.length, key).toBe(expected.length);
      expect(JSON.stringify(added), key).toBe(JSON.stringify(expected));
      expect(result.appended.length, key).toBe(expected.length);
      expect(result.stillMissing, key).toEqual([]);
      expect(holesOf(module, result.corpus), key).toEqual([]);
      floorStreams += added.length;
    });
    expect(floorStreams).toBeGreaterThan(builtinModules.length * 4);
    // Every sport's scenarios, including cricket's search for a tied match (a few hundred seeds): 1.1 s plain, 4.7 s under
    // the CI coverage run, so it carries an explicit budget rather than the 5 s default.
  }, 30_000);

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
  }, 60_000);

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

  it("in every sport, a recorded void strikes each of core.forfeit and core.abandon: it took effect, the void clears it, and play resumes to a result", () => {
    let proofs = 0;
    const seen = new Map<string, Set<string>>();
    forEachSport(({ key }) => {
      for (const stream of readCorpus(key).streams.filter(isFloor)) {
        const { effective, abandonInForce } = setup(key, stream);
        stream.events.forEach((event, v) => {
          if (event.type !== "core.void") return;
          const t = Number(event.voids!.slice(2));
          const target = stream.events[t]!;
          if (!UNDOABLE_KERNEL.includes(target.type)) return;
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
      for (const type of UNDOABLE_KERNEL) expect(seen.get(m.key)?.has(type), `${m.key} ${type}`).toBe(true);
    }
    expect(proofs).toBeGreaterThanOrEqual(builtinModules.length * UNDOABLE_KERNEL.length);
  });

  it("the standing abandon streams of the floor are real: an abandon no void strikes, in force at the end", () => {
    let standing = 0;
    forEachSport(({ key }) => {
      const corpus = readCorpus(key);
      for (const stream of corpus.streams) {
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

  it("a ledger whose remaining events hold a void is not spliced (the splice does not rewrite ids)", () => {
    const g = ledger.find((e) => !e.type.startsWith("core.") && e.type === "football.goal") ?? ledger.find((e) => !e.type.startsWith("core."))!;
    const voided = [START, g, g, { type: "core.void", payload: {}, voids: "e-1" }];
    const dq: KernelStrike = { ...forfeit!, event: { type: "core.forfeit", payload: { by: lineups.home.entrantId, reason: "disqualified" } }, needsPlay: false };
    expect(strikeKernelEvent(ctx, cfg, lineups, voided, dq, 1), "every point has the void in its tail").toBeNull();
  });
});
