// extendFloor (GF-1) — the append path of the golden floor. The committed floor streams are the expected values: the
// path must reproduce them byte for byte from a corpus that lacks them (deterministic), touch nothing it did not add,
// do nothing when the floor is met (the empty case and the second call), and refuse an identity clash by name.
import { describe, expect, it } from "vitest";
import { builtinModules } from "../sports/index.ts";
import { forEachSport } from "./for-each-sport.ts";
import { readCorpus, type GoldenCorpus } from "./golden.ts";
import { eventToken, floorHoles as holesOf } from "./golden-floor.ts";
import { extendFloor, FLOOR_SEED_STRIDE, SCENARIOS, type Built, type Ctx, type Scenario } from "./golden-floor-streams.ts";
import { playRecorded } from "../core/events.ts";
import { makeEnvelope } from "./helpers.ts";

const isFloor = (s: { seed: number }): boolean => s.seed >= FLOOR_SEED_STRIDE;
const withoutFloor = (c: GoldenCorpus): GoldenCorpus => ({ ...c, streams: c.streams.filter((s) => !isFloor(s)) });

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
      const base = withoutFloor(committed);
      expect(base.streams.length, `${key}: the generator's walks are still there`).toBeGreaterThan(0);
      const holesBefore = holesOf(module, base);
      expect(holesBefore.length, `${key}: without its floor streams the floor has holes`).toBeGreaterThan(0);
      const result = extendFloor(module, base);
      // nothing the floor did not add is touched
      expect(result.corpus.configs, key).toEqual(base.configs);
      expect(result.corpus.streams.slice(0, base.streams.length), key).toEqual(base.streams);
      // and what it added is exactly what is committed
      const added = result.corpus.streams.slice(base.streams.length);
      const expected = committed.streams.filter(isFloor);
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

  it("every committed floor stream, taken in order, closes a hole the streams before it left open (no noise kept)", () => {
    // The keep-rule: a scenario's stream is appended only when it reduces the holes.
    let kept = 0;
    forEachSport(({ module, key }) => {
      const committed = readCorpus(key);
      let corpus = withoutFloor(committed);
      for (const stream of committed.streams.filter(isFloor)) {
        const before = holesOf(module, corpus);
        corpus = { ...corpus, streams: [...corpus.streams, stream] };
        const after = holesOf(module, corpus);
        expect(after.length, `${key} ${stream.config}#${stream.seed} closes a hole`).toBeLessThan(before.length);
        kept++;
      }
    });
    expect(kept).toBeGreaterThan(builtinModules.length * 4);
  });

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
    const base = withoutFloor(committed);
    // a decoy wearing the identity the first floor scenario will want, holding none of what the floor needs
    const donor = base.streams[0]!;
    const decoy = { ...donor, config: floor[0]!.config, seed: floor[0]!.seed };
    expect(() => extendFloor(module, { ...base, streams: [...base.streams, decoy] })).toThrow(/already has a stream .*#\d+; the epoch guard keys streams by that identity/);
  });

  it("keeps a scenario's stream only when it closes a hole: a scenario that serves a hole but builds a stream recording nothing new is dropped, the next still runs", () => {
    const module = builtinModules.find((m) => m.key === "badminton")!;
    const committed = readCorpus("badminton");
    const base = withoutFloor(committed);
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
    const holes = new Set(holesOf(module, withoutFloor(corpus)));
    const fed = retired.build({ module, corpus, cfgNames, holes });
    expect(fed, "with the corpus's own pairing event to borrow, a retirement is built").not.toBeNull();
    const events = fed!.events.map((e, i) => makeEnvelope(i, e, e.voids));
    expect(playRecorded(events.slice(0, -1), {}), "and the play before it is real, as the one-off migration reads it").toBe(true);
    const starved = retired.build({ module, corpus: { ...corpus, streams: [] }, cfgNames, holes });
    expect(starved, "a retirement after a bare Start is a walkover wearing the wrong word, not a retirement").toBeNull();
  });
});
