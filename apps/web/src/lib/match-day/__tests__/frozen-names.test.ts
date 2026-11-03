// Match Day PB3 item 7 - `frozenNamesFor`: how the org's frozen competitions are cut down for the Match Day banner.
// Up to FROZEN_NAMES_SHOWN names, the competition on screen first, and the rest as a count. The cap is read from the module's own
// constant, never typed here, and every case reports how many it checked.
import { describe, expect, it } from "vitest";
import { FROZEN_NAMES_SHOWN, NO_FROZEN_NAMES, frozenNamesFor, type FrozenCompetitionRef } from "../frozen-names";

const mk = (n: number): FrozenCompetitionRef[] => Array.from({ length: n }, (_, i) => ({ id: `c${i + 1}`, name: `Comp ${i + 1}`, slug: `comp-${i + 1}` }));

describe("frozenNamesFor", () => {
  it("EMPTY CASE FIRST: nothing frozen names nothing and counts nothing", () => {
    expect(frozenNamesFor([], "c1")).toEqual({ shown: [], more: 0 });
    expect(NO_FROZEN_NAMES).toEqual({ shown: [], more: 0 });
  });

  it("every size from 1 to cap+3: at most the cap are named, the rest are counted, and nothing is lost or invented", () => {
    let checked = 0;
    for (let n = 1; n <= FROZEN_NAMES_SHOWN + 3; n++) {
      const out = frozenNamesFor(mk(n), "c1");
      expect(out.shown.length, `n=${n}`).toBe(Math.min(n, FROZEN_NAMES_SHOWN));
      expect(out.more, `n=${n}`).toBe(Math.max(0, n - FROZEN_NAMES_SHOWN));
      expect(out.shown.length + out.more, `n=${n}: the sum is the whole set`).toBe(n);
      checked++;
    }
    expect(checked).toBe(FROZEN_NAMES_SHOWN + 3);
  });

  it("the competition on screen is named FIRST even when the server order puts it last (it never hides behind '+N more')", () => {
    const rows = mk(FROZEN_NAMES_SHOWN + 2);
    const last = rows[rows.length - 1]!;
    const out = frozenNamesFor(rows, last.id);
    expect(out.shown[0]).toEqual(last);
    // The positive pair: the others keep the server's order behind it.
    expect(out.shown.slice(1).map((r) => r.id)).toEqual(rows.slice(0, FROZEN_NAMES_SHOWN - 1).map((r) => r.id));
    expect(out.more).toBe(2);
    // And a current id that is not in the set changes nothing about the order.
    expect(frozenNamesFor(rows, "not-there").shown.map((r) => r.id)).toEqual(rows.slice(0, FROZEN_NAMES_SHOWN).map((r) => r.id));
  });

  it("does not mutate its input", () => {
    const rows = mk(5);
    const copy = JSON.stringify(rows);
    frozenNamesFor(rows, "c5");
    expect(JSON.stringify(rows)).toBe(copy);
  });
});
