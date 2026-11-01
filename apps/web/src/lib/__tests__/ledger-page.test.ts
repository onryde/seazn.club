import { describe, expect, it } from "vitest";
import { DIVISION_PHASES } from "@/lib/division-phase";
import { ledgerHref, ledgerQueryOf, pageLedger, LEDGER_PER_PAGE } from "@/lib/ledger-page";

// Match Day B2 (spec 2026-10-31 §9, owner request): the competition page's divisions list shows 5 at a time and hides finished
// divisions until asked. Every expected value below is read off the input (counts of rows built here) or the engine's own
// declared phase list (`DIVISION_PHASES`) - never off pageLedger's output.

interface Row {
  id: string;
  phase: string;
  attention: readonly unknown[];
}
const row = (id: string, phase = "scheduled", attention: readonly unknown[] = []): Row => ({ id, phase, attention });
const many = (n: number, phase = "scheduled", from = 1): Row[] => Array.from({ length: n }, (_, i) => row(`r${from + i}`, phase));
const ids = (rows: readonly Row[]) => rows.map((r) => r.id);
const RED = [{ kind: "needs_draw" }];

describe("pageLedger", () => {
  // The empty case first (TEST-STRATEGY): no rows is one empty page, never zero pages and never a negative offset.
  it("no rows is one empty page, shown or hidden", () => {
    for (const showFinished of [false, true]) {
      expect(pageLedger<Row>([], { page: 1, showFinished })).toEqual({ rows: [], page: 1, pages: 1, finishedCount: 0 });
      // ...and a page asked for past the end of nothing is still page 1.
      expect(pageLedger<Row>([], { page: 99, showFinished })).toEqual({ rows: [], page: 1, pages: 1, finishedCount: 0 });
    }
  });

  it("shows five at a time: 16 rows are 4 pages of 5, 5, 5, 1", () => {
    const all = many(16);
    expect(LEDGER_PER_PAGE).toBe(5);
    const sizes = [1, 2, 3, 4].map((page) => pageLedger(all, { page, showFinished: false }));
    expect(sizes.map((p) => p.rows.length)).toEqual([5, 5, 5, 1]);
    expect(sizes.every((p) => p.pages === 4)).toBe(true);
    // The pages tile the list: in order, nothing dropped and nothing repeated.
    expect(sizes.flatMap((p) => ids(p.rows))).toEqual(ids(all));
  });

  it("an exact multiple of five does not grow an empty last page", () => {
    const p = pageLedger(many(10), { page: 2, showFinished: false });
    expect(p.pages).toBe(2);
    expect(ids(p.rows)).toEqual(["r6", "r7", "r8", "r9", "r10"]);
  });

  it("hides finished rows by default and counts them", () => {
    const rows = [...many(3, "scheduled"), ...many(4, "finished", 4)];
    const hidden = pageLedger(rows, { page: 1, showFinished: false });
    expect(ids(hidden.rows)).toEqual(["r1", "r2", "r3"]);
    expect(hidden.finishedCount).toBe(4);
    const shown = pageLedger(rows, { page: 1, showFinished: true });
    expect(ids(shown.rows)).toEqual(["r1", "r2", "r3", "r4", "r5"]);
    // The count is the toggle's label ("Show finished (4)", "Hide finished (4)"): the same number on both sides.
    expect(shown.finishedCount).toBe(4);
  });

  it("pages after filtering, never before: the hidden rows leave no gaps and no extra pages", () => {
    const rows = [...many(7, "scheduled"), ...many(4, "finished", 8)];
    expect(pageLedger(rows, { page: 1, showFinished: false }).pages).toBe(2);
    expect(pageLedger(rows, { page: 1, showFinished: true }).pages).toBe(3);
    expect(ids(pageLedger(rows, { page: 2, showFinished: false }).rows)).toEqual(["r6", "r7"]);
  });

  it("a finished row with attention is never filtered", () => {
    const rows = [row("a", "scheduled"), row("b", "finished", RED), row("c", "finished")];
    const p = pageLedger(rows, { page: 1, showFinished: false });
    expect(ids(p.rows)).toEqual(["a", "b"]);
    // ...and it is not counted as a hidden finished division either: nothing about it is hidden.
    expect(p.finishedCount).toBe(1);
  });

  it("every phase but finished stays visible; finished alone is hideable", () => {
    // Sweep the engine's own phase list; zero checked would be a vacuous pass.
    expect(DIVISION_PHASES.length).toBeGreaterThan(0);
    let checked = 0;
    for (const phase of DIVISION_PHASES) {
      const p = pageLedger([row("x", phase)], { page: 1, showFinished: false });
      expect(p.rows.length, phase).toBe(phase === "finished" ? 0 : 1);
      expect(p.finishedCount, phase).toBe(phase === "finished" ? 1 : 0);
      checked += 1;
    }
    expect(checked).toBe(DIVISION_PHASES.length);
  });

  it("a division whose desk failed to load (phase unknown) is never hidden", () => {
    const p = pageLedger([row("x", "unknown")], { page: 1, showFinished: false });
    expect(ids(p.rows)).toEqual(["x"]);
    expect(p.finishedCount).toBe(0);
  });

  it("all finished and hidden is one empty page that still counts what it hides", () => {
    const p = pageLedger(many(8, "finished"), { page: 3, showFinished: false });
    expect(p).toEqual({ rows: [], page: 1, pages: 1, finishedCount: 8 });
  });

  it("clamps an out-of-range page to the last page, and a nonsense one to the first", () => {
    const all = many(16);
    const last = pageLedger(all, { page: 99, showFinished: false });
    expect(last.page).toBe(4);
    expect(ids(last.rows)).toEqual(["r16"]);
    for (const page of [0, -3, Number.NaN, 2.5, Number.POSITIVE_INFINITY * -1]) {
      expect(pageLedger(all, { page, showFinished: false }).page, String(page)).toBe(1);
    }
  });

  it("takes perPage, and refuses one that is not a positive whole number", () => {
    const p = pageLedger(many(7), { page: 2, showFinished: false, perPage: 3 });
    expect(p.pages).toBe(3);
    expect(ids(p.rows)).toEqual(["r4", "r5", "r6"]);
    for (const perPage of [0, -1, 1.5, Number.NaN]) {
      expect(() => pageLedger(many(2), { page: 1, showFinished: false, perPage }), String(perPage)).toThrow(RangeError);
    }
  });

  it("does not mutate its input", () => {
    const rows = [...many(6), ...many(2, "finished", 7)];
    const before = ids(rows);
    pageLedger(rows, { page: 2, showFinished: false });
    expect(ids(rows)).toEqual(before);
  });
});

describe("ledgerQueryOf", () => {
  it("no query is page 1, finished hidden, nothing to carry", () => {
    expect(ledgerQueryOf({})).toEqual({ page: 1, showFinished: false, rest: [] });
  });
  it("reads dpage and finished=1, and carries every other param through", () => {
    expect(ledgerQueryOf({ dpage: "3", finished: "1", tab: "x", z: ["a", "b"] })).toEqual({
      page: 3,
      showFinished: true,
      rest: [["tab", "x"], ["z", "a"], ["z", "b"]],
    });
  });
  it("a malformed page or flag falls back to the default, never throws", () => {
    for (const dpage of ["abc", "-2", "0", "1.5", "", "٣", undefined]) {
      expect(ledgerQueryOf({ dpage }).page, String(dpage)).toBe(1);
    }
    for (const finished of ["0", "true", "yes", "", undefined]) {
      expect(ledgerQueryOf({ finished }).showFinished, String(finished)).toBe(false);
    }
  });
});

describe("ledgerHref", () => {
  const base = "/o/org/c/comp";
  it("page 1 and finished hidden is the bare path", () => {
    expect(ledgerHref(base, [], { page: 1, showFinished: false })).toBe(base);
  });
  it("adds only what differs from the default", () => {
    expect(ledgerHref(base, [], { page: 2, showFinished: false })).toBe(`${base}?dpage=2`);
    expect(ledgerHref(base, [], { page: 1, showFinished: true })).toBe(`${base}?finished=1`);
    expect(ledgerHref(base, [], { page: 3, showFinished: true })).toBe(`${base}?dpage=3&finished=1`);
  });
  it("keeps the other query params, in order, and encodes them", () => {
    expect(ledgerHref(base, [["a", "1"], ["q", "x y&z"]], { page: 2, showFinished: true })).toBe(
      `${base}?a=1&q=x+y%26z&dpage=2&finished=1`,
    );
  });
  it("round-trips: what a link writes, the page reads back", () => {
    const cases = [
      { page: 1, showFinished: false },
      { page: 4, showFinished: false },
      { page: 1, showFinished: true },
      { page: 2, showFinished: true },
    ];
    for (const next of cases) {
      const href = ledgerHref(base, [["tab", "x"]], next);
      const sp = Object.fromEntries(new URL(href, "http://x").searchParams);
      expect(ledgerQueryOf(sp), href).toEqual({ ...next, rest: [["tab", "x"]] });
    }
  });
});
