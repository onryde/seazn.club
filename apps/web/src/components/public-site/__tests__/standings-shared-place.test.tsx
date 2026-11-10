// X-TP-3 (R24 pick 2A): a bracket's SHARED place - two semi-final losers both 3rd - reads "3" on both rows with a small
// "Shared place" chip, the next row 5, from the stored RANK (C8). Medals follow the rank (two bronze); a joint 1st is two
// leaders; a vacant title (2, 2) has none. A league's level rank is NOT a shared place (positive/negative pair).
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import type { StandingsRow } from "@seazn/engine/competition";
import en from "@/dictionaries/en/public.json";
import es from "@/dictionaries/es/public.json";
import type { Dict } from "@/lib/i18n-constants";
import { StandingsTable } from "../standings-table";

const row = (entrantId: string, rank: number): StandingsRow => ({ entrantId, played: 0, won: 0, drawn: 0, lost: 0, points: 0, metrics: {}, rank });
const names = (ids: string[]) => Object.fromEntries(ids.map((id) => [id, `Entrant ${id}`]));
const render = (ranks: readonly number[], stageKind: string, dict: Dict = en as Dict) => {
  const rows = ranks.map((r, i) => row(String.fromCharCode(97 + i), r));
  return renderToStaticMarkup(
    createElement(StandingsTable, { rows, metricSpecs: [], cascade: [], entrantNames: names(rows.map((r) => r.entrantId)), dict, stageKind }),
  );
};
const chips = (html: string) => [...html.matchAll(/data-testid="standings-shared-place-([a-z])"/g)].map((m) => m[1]);
const BRONZE = "bg-orange-300 text-orange-950";
const GOLD = "bg-amber-300 text-amber-950";

describe("X-TP-3 the table of a bracket's places", () => {
  it("empty case: no rows renders no chip and does not throw", () => {
    expect(chips(render([], "knockout"))).toEqual([]);
  });

  it("strict places (1, 2, 3, 4): no chip", () => {
    expect(chips(render([1, 2, 3, 4], "knockout"))).toEqual([]);
  });

  it("a shared 3rd (1, 2, 3, 3, 5): the two 3rds wear the chip, both bronze, the 5th is plain 5 - differential: today no row said shared", () => {
    const html = render([1, 2, 3, 3, 5], "knockout");
    expect(chips(html)).toEqual(["c", "d"]);
    expect(html.split(BRONZE).length - 1, "two bronze chips").toBe(2);
    expect(html).toContain(">5</span>");
    expect(html).not.toContain(">4</span>");
    expect(html).toContain("Shared place");
  });

  it("the chip never shares the name's flex row below md (a 43-character name was squeezed to four letters at 320, seen in a browser)", () => {
    const html = render([1, 2, 3, 3], "knockout");
    const chip = html.match(/<span data-testid="standings-shared-place-c" class="([^"]*)"/)?.[1] ?? "";
    expect(chip, "the chip was rendered").not.toBe("");
    expect(chip).toContain("max-md:mt-1");
    expect(chip).toContain("whitespace-nowrap");
    expect(chip, "not a shrink-0 sibling of the name inside the flex row").not.toContain("shrink-0");
    // the chip follows the closing of the name's row, it is not inside it
    expect(html).toMatch(/<\/span><span data-testid="standings-shared-place-c"/);
  });

  it("a joint 1st (1, 1, 3, 3, 5): two gold leaders, four chips", () => {
    const html = render([1, 1, 3, 3, 5], "knockout");
    expect(chips(html)).toEqual(["a", "b", "c", "d"]);
    expect(html.split(GOLD).length - 1).toBe(2);
    expect(html.split("bg-amber-50/60").length - 1, "two leader rows").toBe(2);
  });

  it("a vacant title (2, 2, 3, 3): no gold row and no leader", () => {
    const html = render([2, 2, 3, 3], "double_elim");
    expect(html).not.toContain(GOLD);
    expect(html).not.toContain("bg-amber-50/60");
    expect(chips(html)).toEqual(["a", "b", "c", "d"]);
  });

  it("the chip is the locale's words", () => {
    const html = render([1, 2, 3, 3], "knockout", es as Dict);
    expect(html).toContain(es["table.tieBreak.shared_place"]);
    expect(html).not.toContain("Shared place");
  });

  it("negative pair: the same ranks on a league (an unbroken tie) carry no chip", () => {
    expect(chips(render([1, 2, 3, 3, 5], "league"))).toEqual([]);
  });
});
