// Match Day E1 item 3: where a stage's bracket tree is drawn. The expectations come from the ENGINE'S OWN generators and layout
// readers (`generateSingleElim` / `generateDoubleElim` / `generatePagePlayoff` / `generateStepladder`, then the same `twoSidedBracket`
// / `doubleElimBracket` / `pagePlayoffBracket` the panel draws with) - never a table of kinds typed here. A single-elimination shape
// is drawn in the stage's card; the two-lane double-elimination layout and the stepladder keep the page; no bracket yet draws nowhere.
import { describe, expect, it } from "vitest";
import {
  doubleElimBracket,
  pagePlayoffBracket,
  twoSidedBracket,
  type BracketFixtureRef,
} from "@seazn/engine/scheduling/bracket-layout";
import { generateDoubleElim, generatePagePlayoff, generateSingleElim, generateStepladder, type GeneratedBracket } from "@seazn/engine/scheduling";
import { StageKind } from "@seazn/engine/core";
import { bracketAccess, bracketPlacement } from "../bracket-view";
import { BRACKET_STAGE_KINDS } from "../run-sheet-groups";

const field = (n: number): string[] => Array.from({ length: n }, (_, i) => `T${i + 1}`);

/** The rows a persisted stage holds, built the way the stage writer numbers them: `round_no` from the generator's round (a double
 *  elimination's lanes are offset, exactly as `doc-bracket-geometry.test.ts` numbers them), `seq_in_round` counting per lane+round. */
function rowsOf(gen: GeneratedBracket, deLanes = false): BracketFixtureRef[] {
  const counters = new Map<string, number>();
  return gen.fixtures.map((f) => {
    const lane = f.bracket ?? "WB";
    const offset = !deLanes ? 0 : lane === "LB" ? gen.rounds : lane === "GF" ? 2 * gen.rounds : 0;
    const round_no = offset + f.round + 1;
    const key = `${lane}:${round_no}`;
    const seq = (counters.get(key) ?? 0) + 1;
    counters.set(key, seq);
    return { id: f.id, round_no, seq_in_round: seq };
  });
}

describe("bracketPlacement", () => {
  it("a single-elimination tree of any size is drawn in the stage's card (swept over field sizes, byes and a third-place match)", () => {
    let checked = 0;
    let refused = 0;
    for (const n of [3, 4, 5, 6, 7, 8, 12, 16]) {
      for (const thirdPlace of [false, true]) {
        if (thirdPlace && n < 4) {
          // Engine 5.0.0 (X-TP-5): fewer than two real semi-finals draws no third place - refused, never a silent drop.
          expect(() => generateSingleElim({ entrants: field(n), thirdPlace }), `${n} entrants with a third place`).toThrow(/two real semi-finals/);
          refused += 1;
          continue;
        }
        const rows = rowsOf(generateSingleElim({ entrants: field(n), thirdPlace }));
        // The premise, from the engine: the panel's own reader accepts it as a two-sided tree - otherwise "card" proves nothing.
        expect(twoSidedBracket(rows).ok, `premise: ${n} entrants / third=${thirdPlace} reads as a two-sided tree`).toBe(true);
        expect(bracketPlacement("knockout", rows), `${n} / third=${thirdPlace}`).toBe("card");
        checked += 1;
      }
    }
    expect(checked).toBe(15);
    expect(refused, "anti-vacuity: the field below four was reached").toBe(1);
  });

  it("a double-elimination tree keeps the page (it has no card button), with and without the bracket reset", () => {
    let checked = 0;
    for (const n of [4, 8, 16]) {
      for (const bracketReset of [false, true]) {
        const rows = rowsOf(generateDoubleElim({ entrants: field(n), bracketReset }), true);
        expect(twoSidedBracket(rows).ok, `premise: ${n} double-elim is not a two-sided tree`).toBe(false);
        expect(doubleElimBracket(rows).ok, `premise: ${n} double-elim reads as the two-lane layout`).toBe(true);
        expect(bracketPlacement("double_elim", rows), `${n} / reset=${bracketReset}`).toBe("page");
        checked += 1;
      }
    }
    expect(checked).toBe(6);
  });

  it("a stepladder keeps the page, a page playoff is a four-team tree drawn in the card", () => {
    const ladder = rowsOf(generateStepladder({ entrants: field(4) }));
    expect(ladder.length, "premise: the stepladder has rungs").toBeGreaterThan(0);
    expect(bracketPlacement("stepladder", ladder)).toBe("page");
    const pp = rowsOf(generatePagePlayoff({ entrants: field(4) }));
    expect(pagePlayoffBracket(pp).ok, "premise: the engine reads it as a page playoff").toBe(true);
    expect(bracketPlacement("page_playoff", pp)).toBe("card");
  });

  it("no bracket yet draws nowhere: every bracket kind with no fixtures is null (the empty case)", () => {
    let checked = 0;
    for (const kind of ["knockout", "double_elim", "stepladder", "page_playoff"]) {
      expect(bracketPlacement(kind, []), kind).toBeNull();
      checked += 1;
    }
    expect(checked).toBe(4);
  });

  it("only a bracket-kind stage draws a tree: tree-shaped rows under a league (or any non-bracket kind) are null", () => {
    const tree = rowsOf(generateSingleElim({ entrants: field(8) }));
    expect(twoSidedBracket(tree).ok, "premise: the rows are a tree").toBe(true);
    let checked = 0;
    for (const kind of ["league", "round_robin", "swiss", "groups", "ladder", "americano", "anything"]) {
      expect(bracketPlacement(kind, tree), kind).toBeNull();
      checked += 1;
    }
    expect(checked).toBe(7);
  });

  it("a placement is a promise the panel draws: whatever is 'card' or 'page' reads as a layout, whatever is null does not", () => {
    // Fixtures a knockout stage can hold that are not a bracket (a round-robin-shaped heap): nothing to draw, so no button.
    const heap: BracketFixtureRef[] = [
      { id: "a", round_no: 1, seq_in_round: 1 },
      { id: "b", round_no: 1, seq_in_round: 2 },
      { id: "c", round_no: 1, seq_in_round: 3 },
    ];
    expect(twoSidedBracket(heap).ok).toBe(false);
    expect(doubleElimBracket(heap).ok).toBe(false);
    expect(bracketPlacement("knockout", heap)).toBeNull();
  });
});

// SCF fix round 1 (owner 2026-11-03): every bracket-kind stage card has a Bracket button; what it DOES is decided here. The kind set is the
// one `bracketPlacement` itself tests against (`BRACKET_STAGE_KINDS`), and the rows are the engine's own generator output.
describe("bracketAccess: what the Bracket button on a stage card does", () => {
  const generated: { kind: string; rows: BracketFixtureRef[]; access: "toggle" | "link" }[] = [
    { kind: "knockout", rows: rowsOf(generateSingleElim({ entrants: field(8) })), access: "toggle" },
    { kind: "page_playoff", rows: rowsOf(generatePagePlayoff({ entrants: field(4) })), access: "toggle" },
    { kind: "double_elim", rows: rowsOf(generateDoubleElim({ entrants: field(8) }), true), access: "link" },
    { kind: "stepladder", rows: rowsOf(generateStepladder({ entrants: field(4) })), access: "link" },
  ];

  it("the sweep covers exactly the bracket kinds the placement predicate knows (no kind added there goes unswept here)", () => {
    expect(generated.map((g) => g.kind).sort()).toEqual([...BRACKET_STAGE_KINDS].sort());
    expect(BRACKET_STAGE_KINDS.size, "anti-vacuity: the set is not empty").toBeGreaterThanOrEqual(4);
  });

  it("with its fixtures generated, a card-placed tree toggles in the card and a page-placed one links to the page (every bracket kind)", () => {
    let checked = 0;
    for (const g of generated) {
      expect(g.rows.length, `premise: ${g.kind} generated rows`).toBeGreaterThan(0);
      const placement = bracketPlacement(g.kind, g.rows);
      expect(placement, `premise: ${g.kind} is placed`).not.toBeNull();
      expect(bracketAccess(g.kind, g.rows), g.kind).toBe(g.access);
      // The two views agree: a card placement is a toggle, a page placement a link - never the other way round.
      expect(bracketAccess(g.kind, g.rows) === "toggle", `${g.kind}: toggle iff card`).toBe(placement === "card");
      expect(bracketAccess(g.kind, g.rows) === "link", `${g.kind}: link iff page`).toBe(placement === "page");
      checked += 1;
    }
    expect(checked, "anti-vacuity: every bracket kind checked").toBe(BRACKET_STAGE_KINDS.size);
  });

  it("before Generate (no fixtures) every bracket kind has the button, greyed: 'generate' (the empty case)", () => {
    let checked = 0;
    for (const kind of BRACKET_STAGE_KINDS) {
      expect(bracketPlacement(kind, []), `premise: ${kind} draws nothing yet`).toBeNull();
      expect(bracketAccess(kind, []), kind).toBe("generate");
      checked += 1;
    }
    expect(checked).toBe(BRACKET_STAGE_KINDS.size);
  });

  it("a bracket kind WITH fixtures no view can draw is greyed with its own state, never 'generate' and never a button that opens nothing", () => {
    const heap: BracketFixtureRef[] = [
      { id: "a", round_no: 1, seq_in_round: 1 },
      { id: "b", round_no: 1, seq_in_round: 2 },
      { id: "c", round_no: 1, seq_in_round: 3 },
    ];
    // Premise from the engine's own readers: none of the three layouts reads this heap.
    expect(twoSidedBracket(heap).ok).toBe(false);
    expect(doubleElimBracket(heap).ok).toBe(false);
    expect(pagePlayoffBracket(heap).ok).toBe(false);
    let checked = 0;
    // A stepladder with any rung draws its list, so it is not in this set; the three tree kinds are.
    for (const kind of ["knockout", "double_elim", "page_playoff"]) {
      expect(bracketPlacement(kind, heap), `premise: ${kind} placement is null`).toBeNull();
      expect(bracketAccess(kind, heap), kind).toBe("unavailable");
      checked += 1;
    }
    expect(checked).toBe(3);
  });

  it("a stage kind that is not a bracket gets no button, whatever rows it holds, with or without fixtures (every kind swept)", () => {
    const tree = rowsOf(generateSingleElim({ entrants: field(8) }));
    expect(twoSidedBracket(tree).ok, "premise: the rows are a tree").toBe(true);
    let checked = 0;
    for (const kind of StageKind.options.filter((k) => !BRACKET_STAGE_KINDS.has(k))) {
      expect(bracketAccess(kind, tree), `${kind} with a tree`).toBeNull();
      expect(bracketAccess(kind, []), `${kind} empty`).toBeNull();
      checked += 1;
    }
    expect(checked, "anti-vacuity: non-bracket kinds swept").toBeGreaterThan(2);
  });
});
