// Quick match plan 4, T4 review m6: the match list's phase switches are exhaustive for tsc (`unknownPhase(phase: never)`), but
// a phase from outside the union can still arrive at runtime (a producer that grew a phase this list was never taught). TEST-
// STRATEGY: "cannot happen" owes a named refusal and a test that reaches it. Every reader of a row's phase refuses it by the
// same name, the list's order included (it used to drop such a row silently, one row short and no error).
//
// The empty case first: an empty list orders to an empty list, and every KNOWN phase is placed (none dropped). The phases are
// typed here from the read model's union (`QuickMatchPhase`, quick-match-home.ts), not read back from the list's own table.
//
// Sport: not applicable (the list orders phases; it knows no sport).
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { QuickMatchPhase } from "@/server/usecases/quick-match-home";
import { listOrder, QuickMatchList, rowMenuItems, type MatchView } from "../match-list";

const seat = (name: string) => ({ name, label: name, winner: false });
const match = (id: string, n: number, phase: QuickMatchPhase): MatchView => ({
  id, n, phase, home: seat("Ines"), away: seat("Ravi"), score: null, result: null, next: false, editable: false,
  skippable: false, putBack: false, skipCopy: null,
});
/** A phase no producer makes today: the union grew, a branch was not written. */
const bogus = (id: string, n: number) => ({ ...match(id, n, "ready"), phase: "postponed" }) as unknown as MatchView;
const REFUSAL = /quick match list: no branch for the phase "postponed"/;
const KNOWN: readonly QuickMatchPhase[] = ["live", "ready", "waiting", "notPlayed", "settled"];

describe("the match list refuses a phase it does not know (T4 review m6)", () => {
  it("the empty case first: no match orders to none; every known phase is placed, none dropped", () => {
    expect(listOrder([])).toEqual([]);
    const all = KNOWN.map((phase, i) => match(`f-${i}`, i + 1, phase));
    const ordered = listOrder(all);
    expect(ordered, "every row placed once").toHaveLength(all.length);
    expect(new Set(ordered.map((m) => m.id)).size).toBe(all.length);
    let checked = 0;
    for (const m of all) {
      expect(() => rowMenuItems(m), m.phase).not.toThrow();
      checked++;
    }
    expect(checked, "phases checked").toBe(5);
  });

  it("a row's menu: an unknown phase throws by name, never an empty menu", () => {
    expect(() => rowMenuItems(bogus("f-x", 1))).toThrow(REFUSAL);
  });

  it("the list's order: an unknown phase throws by name, never a list one row short", () => {
    expect(() => listOrder([match("f-1", 1, "ready"), bogus("f-x", 2)])).toThrow(REFUSAL);
    // Alone, too: the guard is not a side effect of a known neighbour.
    expect(() => listOrder([bogus("f-x", 1)])).toThrow(REFUSAL);
  });

  it("the list as the page renders it refuses too (the order is read first)", () => {
    const render = (matches: MatchView[]) =>
      renderToStaticMarkup(
        <QuickMatchList title="All matches" matches={matches} versus="v" waits="Waits" liveLabel="Live" notPlayedLabel="Not played" />,
      );
    // The positive pair: the same list with the row in a known phase renders it.
    expect(render([match("f-1", 1, "ready"), match("f-2", 2, "waiting")])).toContain('data-fixture-id="f-2"');
    expect(() => render([match("f-1", 1, "ready"), bogus("f-x", 2)])).toThrow(REFUSAL);
  });
});
