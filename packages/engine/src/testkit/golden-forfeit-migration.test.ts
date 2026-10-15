// W2b Task 5 (ruling 102 Q1; plan PF-3) — the golden corpora's recorded `core.forfeit` payloads carry pre-W2b reasons
// ("no-show", or "walkover" after the start), which the closed W2b vocabulary and the D3 phase guard refuse. The
// migration rewrites ONLY the reason, by the ruled rule as ruling 113 amends it ("nothing played means not started,
// for every forfeit reason"): a forfeit with nothing played before it — no unvoided sport event after an unvoided
// `core.start` — is a `walkover`, one after play is `retired` — in every sport, chess included (PF-3: no boardgame
// exception). Expected values here are that rule, written out; nothing is read back from the function under test.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { goldenPath, readCorpus, SPORT_DIRS } from "./golden.ts";
import { migrateGoldenForfeits, type MigratableEvent } from "./golden-forfeit-migration.ts";
import { FORFEIT_REASONS } from "../core/types.ts";

const stream = (...events: MigratableEvent[]) => ({ config: "default", seed: 1, events, states: ["{}"], outcome: "null" });
const forfeit = (by: string, reason: string): MigratableEvent => ({ type: "core.forfeit", payload: { by, reason } });
const START: MigratableEvent = { type: "core.start", payload: {} };
const reasonsOf = (events: readonly MigratableEvent[]) =>
  events.filter((e) => e.type === "core.forfeit").map((e) => (e.payload as { reason: string }).reason);

describe("golden forfeit migration (ruling 102 Q1, PF-3; ruling 113)", () => {
  it("empty case first: an empty corpus maps to an empty corpus, nothing examined", () => {
    expect(migrateGoldenForfeits([])).toEqual({ streams: [], examined: 0, rewritten: 0 });
  });

  it("a stream with no core.forfeit is byte-identical, and so is the rest of a stream that has one", () => {
    const plain = [stream(START, { type: "football.goal", payload: { by: "H" } }), stream()];
    const out = migrateGoldenForfeits(plain);
    expect(JSON.stringify(out.streams)).toBe(JSON.stringify(plain));
    expect([out.examined, out.rewritten]).toEqual([0, 0]);
    // Only the forfeit's reason moves: config, seed, states, outcome and every other event stay as recorded.
    const mixed = stream({ type: "boardgame.pairing", payload: { white: "H" } }, START, forfeit("A", "no-show"));
    const [migrated] = migrateGoldenForfeits([mixed]).streams;
    expect({ ...migrated, events: migrated!.events.slice(0, 2) }).toEqual({ ...mixed, events: mixed.events.slice(0, 2) });
  });

  it("a forfeit before core.start becomes a walkover; one already a walkover is examined, not rewritten", () => {
    const out = migrateGoldenForfeits([stream(forfeit("A", "no-show")), stream(forfeit("H", "walkover"))]);
    expect(out.streams.map((s) => reasonsOf(s.events))).toEqual([["walkover"], ["walkover"]]);
    expect([out.examined, out.rewritten]).toEqual([2, 1]);
  });

  it("ruling 113: a forfeit after core.start AND the sport's own play becomes retired; after a bare start (nothing played) a walkover — every sport, chess too (PF-3: no boardgame exception)", () => {
    const GOAL: MigratableEvent = { type: "football.goal", payload: { by: "H" } };
    const out = migrateGoldenForfeits([
      stream(START, GOAL, forfeit("A", "walkover")),
      stream(START, forfeit("H", "no-show")),
      // chess: a pairing card before the start is no play, and nothing is played after it
      stream({ type: "boardgame.pairing", payload: { white: "H" } }, START, forfeit("A", "walkover")),
      stream(START, GOAL, forfeit("H", "no-show")),
      // ruling 113's own row: Task 5 migrated this one to retired; with nothing played it is a walkover
      stream(START, forfeit("A", "retired")),
    ]);
    expect(out.streams.map((s) => reasonsOf(s.events))).toEqual([["retired"], ["walkover"], ["walkover"], ["retired"], ["walkover"]]);
    expect([out.examined, out.rewritten]).toEqual([5, 4]);
  });

  it("a voided core.start counts as not started, a voided play as nothing played; a void AFTER the forfeit does not reach back", () => {
    const GOAL: MigratableEvent = { type: "football.goal", payload: { by: "H" } };
    const voidedFirst = stream({ ...START }, GOAL, { type: "core.void", payload: {}, voids: "e-0" }, forfeit("A", "no-show"));
    const voidedPlay = stream({ ...START }, GOAL, { type: "core.void", payload: {}, voids: "e-1" }, forfeit("A", "no-show"));
    const voidedAfter = stream({ ...START }, GOAL, forfeit("A", "no-show"), { type: "core.void", payload: {}, voids: "e-1" });
    const out = migrateGoldenForfeits([voidedFirst, voidedPlay, voidedAfter]);
    expect(out.streams.map((s) => reasonsOf(s.events))).toEqual([["walkover"], ["walkover"], ["retired"]]);
    expect([out.examined, out.rewritten]).toEqual([3, 3]);
  });

  it("GF-1: a closed-vocabulary reason the ruling never yields (disqualified, withdrew) is a deliberate record, not pre-W2b free text — kept after play and after a bare start alike; free text beside it is still rewritten", () => {
    const GOAL: MigratableEvent = { type: "football.goal", payload: { by: "H" } };
    const kept = ["disqualified", "withdrew"] as const;
    // the guard on the list: both really are words of the closed vocabulary, so this is not a typed-in pair that rots
    for (const reason of kept) expect(FORFEIT_REASONS as readonly string[]).toContain(reason);
    const input = kept.flatMap((reason) => [stream(START, GOAL, forfeit("A", reason)), stream(START, forfeit("H", reason))]);
    const out = migrateGoldenForfeits([...input, stream(START, GOAL, forfeit("A", "no-show"))]);
    expect(out.streams.slice(0, 4).map((s) => reasonsOf(s.events))).toEqual([["disqualified"], ["disqualified"], ["withdrew"], ["withdrew"]]);
    expect(JSON.stringify(out.streams.slice(0, 4))).toBe(JSON.stringify(input));
    expect(reasonsOf(out.streams[4]!.events)).toEqual(["retired"]);
    expect([out.examined, out.rewritten]).toEqual([5, 1]);
  });

  it("`by` is never rewritten and `both` is never introduced — every forfeit of a mixed set", () => {
    const input = [
      stream(forfeit("A", "no-show")),
      stream(START, forfeit("H", "walkover")),
      stream(START, forfeit("A", "retired")),
      stream(forfeit("both", "walkover")),
    ];
    const out = migrateGoldenForfeits(input);
    let checked = 0;
    input.forEach((s, i) => {
      s.events.forEach((e, j) => {
        if (e.type !== "core.forfeit") return;
        const was = e.payload as { by: string };
        const now = out.streams[i]!.events[j]!.payload as { by: string };
        expect(now.by, `${i}/${j}`).toBe(was.by);
        checked++;
      });
    });
    expect(checked).toBe(4);
    expect(out.examined).toBe(4);
    expect(out.streams.flatMap((s) => s.events).filter((e) => (e.payload as { by?: string }).by === "both")).toHaveLength(1);
  });

  it("assumptions are guards: a double walkover after the start, or a payload with no side, is refused by name", () => {
    expect(() => migrateGoldenForfeits([stream(START, { type: "football.goal", payload: { by: "H" } }, forfeit("both", "walkover"))])).toThrow(/double walkover after play/);
    // its pair: after a bare start nothing is played, so a double walkover is still a walkover (ruling 112)
    expect(reasonsOf(migrateGoldenForfeits([stream(START, forfeit("both", "walkover"))]).streams[0]!.events)).toEqual(["walkover"]);
    expect(() => migrateGoldenForfeits([stream({ type: "core.forfeit", payload: { reason: "no-show" } })])).toThrow(/names no side/);
    expect(() => migrateGoldenForfeits([stream({ type: "core.forfeit", payload: null })])).toThrow(/names no side/);
  });

  it("the committed corpora are migrated: every recorded forfeit examined, none left to rewrite", () => {
    let examined = 0;
    let recorded = 0;
    for (const key of Object.keys(SPORT_DIRS)) {
      const corpus = readCorpus(key);
      const out = migrateGoldenForfeits(corpus.streams);
      expect(out.rewritten, `${key}: forfeits still carry a pre-W2b reason`).toBe(0);
      examined += out.examined;
      // an independent count, straight off the committed bytes
      recorded += readFileSync(goldenPath(key), "utf8").split('"type":"core.forfeit"').length - 1;
    }
    expect(examined).toBe(recorded);
    expect(examined).toBeGreaterThan(0);
  });
});
