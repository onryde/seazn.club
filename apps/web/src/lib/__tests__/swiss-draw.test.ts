// W3 Task 8 — the pure half of a Swiss round 1 (spec 2026-10-31-format-matrix-w3-swiss-design.md §12):
//   X-SW-22 (SW-L6, REC RB3-16): an unseeded round 1 is a seeded random draw, recorded so it can be replayed — never
//           registration order;
//   BG-SW-1 (SW-H3, REC RB3-10): chess colours are on by default for a boardgame Swiss, and the round-1 colour is by
//           lot: the upper player on board 1 takes the lot's colour and the boards alternate (FIDE C.04.3 A3 5.1).
// Expected values come from those rules, never from the functions under test.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { forEachSport } from "@seazn/engine/testkit";
import {
  applyRoundOneColourLot,
  defaultSwissChess,
  mulberry32,
  swissColourLot,
  swissDrawSeed,
  swissDrawnFieldOrder,
  swissRoundOneOrder,
} from "@/lib/swiss-draw";

/** A field registered in a known order: e1 first, eN last. */
const registered = (n: number, seedOf: (i: number) => number | null = () => null) =>
  Array.from({ length: n }, (_, i) => ({ id: `e${i + 1}`, seed: seedOf(i) }));
const STAGE = "8f0c5f8e-3c1a-4b8e-9a51-6a2c0d7e4b19";
/** Deterministic stage ids for the sweeps (the product's stage ids are UUIDs; any string hashes). */
const STAGES = Array.from({ length: 200 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);

describe("X-SW-22 an unseeded round 1 is a seeded random draw", () => {
  // Empty case FIRST: nothing to draw.
  it("X-SW-22 an empty field draws nobody; a single entrant draws itself", () => {
    expect(swissRoundOneOrder(swissDrawSeed(STAGE), [])).toEqual([]);
    expect(swissRoundOneOrder(swissDrawSeed(STAGE), [{ id: "solo", seed: null }])).toEqual(["solo"]);
  });

  it("X-SW-22 an unseeded round 1 does not follow registration order", () => {
    const field = registered(8);
    const drawn = swissRoundOneOrder(swissDrawSeed(STAGE), field);
    // A draw, not a loss: every entrant once.
    expect([...drawn].sort()).toEqual(field.map((e) => e.id).sort());
    expect(drawn, "the stage's draw is not the registration order").not.toEqual(field.map((e) => e.id));

    // Over many stages: the draw is a shuffle, not a rotation or a fixed reordering — every entrant heads some draw, and
    // (8! = 40320 orders) no stage of the 200 draws the registration order.
    const firsts = new Set<string>();
    let identity = 0;
    for (const stageId of STAGES) {
      const d = swissRoundOneOrder(swissDrawSeed(stageId), field);
      firsts.add(d[0]!);
      if (d.join() === field.map((e) => e.id).join()) identity++;
    }
    console.info(`X-SW-22: ${STAGES.length} stage draws of 8, ${firsts.size} distinct heads, ${identity} in registration order`);
    expect(STAGES.length, "anti-vacuity").toBeGreaterThan(0);
    expect(firsts.size, "every one of the 8 heads some stage's draw").toBe(8);
    expect(identity).toBe(0);
  });

  it("X-SW-22 the draw is identical for the same seed and the same field (the replay)", () => {
    const field = registered(8);
    const seed = swissDrawSeed(STAGE);
    expect(swissDrawSeed(STAGE), "the seed is the stage's own, every time").toBe(seed);
    expect(Number.isInteger(seed) && seed >= 0 && seed < 2 ** 32, `a 32-bit seed (${seed})`).toBe(true);
    // A fresh copy of the field: the replay reads nothing but the seed and the field.
    expect(swissRoundOneOrder(seed, registered(8))).toEqual(swissRoundOneOrder(seed, field));
    // …and another stage draws its own (the seed is the stage's, not a constant).
    const seeds = new Set(STAGES.map(swissDrawSeed));
    expect(seeds.size, `${STAGES.length} stages, ${seeds.size} seeds`).toBe(STAGES.length);
    const orders = new Set(STAGES.map((s) => swissRoundOneOrder(swissDrawSeed(s), field).join()));
    expect(orders.size, "stages draw different orders").toBeGreaterThan(1);
  });

  it("X-SW-22 seeded entrants keep their seed order ahead of the draw", () => {
    // Registered out of seed order, unseeded players interleaved: seeds 3, -, 1, -, 2, -, -, -.
    const seeds = [3, null, 1, null, 2, null, null, null];
    const field = registered(8, (i) => seeds[i]!);
    const unseeded = field.filter((e) => e.seed === null).map((e) => e.id);
    let checked = 0;
    for (const stageId of STAGES) {
      const drawn = swissRoundOneOrder(swissDrawSeed(stageId), field);
      // Seed 1 (e3), seed 2 (e5), seed 3 (e1), in that order, at the head — whatever the draw.
      expect(drawn.slice(0, 3), stageId).toEqual(["e3", "e5", "e1"]);
      expect([...drawn.slice(3)].sort(), stageId).toEqual([...unseeded].sort());
      checked++;
    }
    expect(checked, "anti-vacuity").toBe(STAGES.length);
    // A wholly seeded field is not drawn at all: seed order, for every stage.
    const allSeeded = registered(6, (i) => 6 - i);
    for (const stageId of STAGES.slice(0, 20)) {
      expect(swissRoundOneOrder(swissDrawSeed(stageId), allSeeded)).toEqual(["e6", "e5", "e4", "e3", "e2", "e1"]);
    }
  });
});

describe("BG-SW-1 the round-1 colour lot", () => {
  /** FIDE C.04.3 A3 5.1, as the rulebook states it: the upper player on board 1 takes the lot's colour; on every later
   *  board the upper player takes the colour opposite the board above. Home is White. */
  const upperColour = (board: number, lot: "white" | "black"): "white" | "black" =>
    board === 1 ? lot : upperColour(board - 1, lot) === "white" ? "black" : "white";

  it("BG-SW-1 the colour lot alternates by board", () => {
    const pairings = [1, 2, 3, 4].map((b) => ({ home: `U${b}`, away: `L${b}` })); // pairRound's round 1: upper at home
    let rows = 0;
    for (const lot of ["white", "black"] as const) {
      const out = applyRoundOneColourLot(pairings, lot);
      expect(out).toHaveLength(4);
      for (const [i, p] of out.entries()) {
        const board = i + 1;
        const white = upperColour(board, lot) === "white" ? `U${board}` : `L${board}`;
        expect(p, `lot ${lot}, board ${board}`).toEqual({ home: white, away: white === `U${board}` ? `L${board}` : `U${board}` });
        rows++;
      }
    }
    console.info(`BG-SW-1: ${rows} (lot, board) rows`);
    expect(rows).toBe(8);
    // The input is not mutated (swissGen seats from the returned list).
    expect(pairings[1]).toEqual({ home: "U2", away: "L2" });
    // Empty case: no boards, nothing to colour.
    expect(applyRoundOneColourLot([], "white")).toEqual([]);
  });

  it("BG-SW-1 the lot is the stage's own: replayable, and both colours occur", () => {
    const tally = { white: 0, black: 0 };
    for (const stageId of STAGES) {
      const lot = swissColourLot(swissDrawSeed(stageId));
      expect(swissColourLot(swissDrawSeed(stageId)), "replay").toBe(lot);
      tally[lot]++;
    }
    console.info(`BG-SW-1: ${STAGES.length} stage lots, ${tally.white} white / ${tally.black} black`);
    expect(tally.white + tally.black).toBe(STAGES.length);
    expect(tally.white, "some stage draws white").toBeGreaterThan(0);
    expect(tally.black, "some stage draws black").toBeGreaterThan(0);
  });

  it("BG-SW-1 defaultSwissChess is on for boardgame and off for every other sport", () => {
    // RB3-10: on by default for a boardgame (chess) Swiss, off otherwise — the rulebook's literal sport key.
    let on = 0;
    const visited = forEachSport(({ key }) => {
      const expected = key === "boardgame";
      expect(defaultSwissChess(key), key).toBe(expected);
      if (expected) on++;
    });
    console.info(`BG-SW-1: defaultSwissChess over ${visited} sports, on for ${on}`);
    expect(visited, "anti-vacuity").toBeGreaterThan(0);
    expect(on, "the registry carries boardgame").toBe(1);
    expect(visited - on, "and some sport that is not chess").toBeGreaterThan(0);
  });
});

// Review m3 — fixed vectors. Every test above pins a PROPERTY; the DB suites compute their expectation with these same
// functions. So a refactor of the FNV constants, the shuffle loop or LOT_SALT would stay green everywhere while
// silently re-drawing every stage. These two pins are what goes red instead.
describe("the replay contract: fixed vectors", () => {
  it("swissDrawSeed is the published FNV-1a 32-bit hash (the FNV spec's own test vectors)", () => {
    // From the FNV specification's test vectors (offset basis for the empty string), not from this code.
    expect(swissDrawSeed("")).toBe(0x811c9dc5);
    expect(swissDrawSeed("a")).toBe(0xe40c292c);
  });

  // THE REPLAY CONTRACT. Captured once from this implementation (W3 T8, 2026-11-01) and frozen: the draw seed, round-1
  // order and colour lot of one fixed stage id over an 8-entrant unseeded field. Every stage re-derives its draw from its
  // id on each Pair — a re-Pair of round 1 (Unpair then Pair, Undo then Redo) and every later round's pairing-number
  // tie-break. CHANGING THIS LITERAL CHANGES EVERY EXISTING STAGE'S RE-PAIR: never update it to make a refactor pass.
  const REPLAY_CONTRACT = {
    stageId: "8f0c5f8e-3c1a-4b8e-9a51-6a2c0d7e4b19",
    drawSeed: 0x02eb8bf5,
    order: ["e3", "e4", "e2", "e6", "e8", "e7", "e5", "e1"],
    lot: "black",
  } as const;

  it("one stage's seed, drawn order and lot are the frozen contract", () => {
    const seed = swissDrawSeed(REPLAY_CONTRACT.stageId);
    expect(seed).toBe(REPLAY_CONTRACT.drawSeed);
    expect(swissRoundOneOrder(seed, registered(8))).toEqual(REPLAY_CONTRACT.order);
    expect(swissColourLot(seed)).toBe(REPLAY_CONTRACT.lot);
  });
});

// Review m7 (ruling: persist the drawn order) — the draw is the stage's pairing numbers for every round, not round 1's
// alone: a later round's field is ranked by it, and a latecomer (T6, first round > 1) was never drawn, so it follows.
describe("swissDrawnFieldOrder — a later round's field in pairing-number order", () => {
  const ids = (xs: readonly { id: string }[]) => xs.map((x) => x.id);

  it("the empty case: no field is no order; an empty draw keeps the field as given", () => {
    expect(swissDrawnFieldOrder(["a", "b"], [])).toEqual([]);
    const field = registered(3);
    expect(ids(swissDrawnFieldOrder([], field))).toEqual(["e1", "e2", "e3"]);
  });

  it("the drawn entrants take the draw's order, whatever order the field arrives in", () => {
    const field = registered(4); // e1..e4, registration order
    expect(ids(swissDrawnFieldOrder(["e3", "e1", "e4", "e2"], field))).toEqual(["e3", "e1", "e4", "e2"]);
  });

  it("a latecomer the draw never saw follows the drawn field, latecomers in arrival (field) order", () => {
    // e5 and e6 arrived after round 1 was drawn; the field lists them in arrival order, e6 before e5 here on purpose.
    const field = [...registered(4), { id: "e6", seed: null }, { id: "e5", seed: null }];
    expect(ids(swissDrawnFieldOrder(["e2", "e4", "e1", "e3"], field))).toEqual(["e2", "e4", "e1", "e3", "e6", "e5"]);
    // ...even when a latecomer arrives in the middle of the field.
    const mixed = [{ id: "e9", seed: null }, ...registered(2)];
    expect(ids(swissDrawnFieldOrder(["e2", "e1"], mixed))).toEqual(["e2", "e1", "e9"]);
  });

  it("an entrant the draw saw but who has left (withdrew since round 1) leaves no gap and moves no one", () => {
    const field = registered(4).filter((e) => e.id !== "e4");
    expect(ids(swissDrawnFieldOrder(["e4", "e2", "e3", "e1"], field))).toEqual(["e2", "e3", "e1"]);
  });

  it("hands back the field's own entrant objects (same references), and leaves the input's order alone", () => {
    const field = registered(3);
    const out = swissDrawnFieldOrder(["e3", "e2", "e1"], field);
    expect(out[0]).toBe(field[2]);
    expect(field.map((e) => e.id), "the input is not reordered in place").toEqual(["e1", "e2", "e3"]);
  });
});

describe("mulberry32 moved here from lib/marketing/club-names.ts, unchanged", () => {
  it("is the published mulberry32: seed 1's stream opens 0.6270739405881613", () => {
    const rand = mulberry32(1);
    expect(rand()).toBe(0.6270739405881613);
    expect(rand()).toBe(0.002735721180215478);
  });

  it("club-names imports it back rather than keeping a copy", () => {
    const src = readFileSync(new URL("../marketing/club-names.ts", import.meta.url), "utf8");
    expect(src).toMatch(/import\s*\{[^}]*\bmulberry32\b[^}]*\}\s*from\s*"\.\.\/swiss-draw(\.ts)?"/);
    expect(src).not.toMatch(/function\s+mulberry32\b/);
  });
});

describe("swiss-draw is client-safe", () => {
  it("imports only the import-free chess predicate (the desk and the smoke runner both load it)", () => {
    const src = readFileSync(new URL("../swiss-draw.ts", import.meta.url), "utf8");
    const specifiers = [...src.matchAll(/^\s*import[^"']*["']([^"']+)["']/gm)].map((m) => m[1]);
    expect(specifiers).toEqual(["./chess-individual-only-rule.ts"]);
  });
});
