// Two findings from driving the live product, both on this one table.
//
// F2 (2026-09-20): a withdrawn entrant sat in the standings at rank 4 with 2
// points, in the console AND on the public endpoint, with nothing whatever to
// tell her apart — row classes identical to the people still competing. Her
// played result STANDS by design (the withdrawal settles the rest through the
// ledger), so the row is carried; carrying it unmarked is the defect.
// `StandingsRow` has no status field, so the marking arrives beside the rows.
//
// F9 (2026-09-21): with the tie-break popover open, the rank chip of the NEXT
// row punched through its left edge and the row after that covered its
// bottom-left corner. Measured with `elementFromPoint` on every row, before and
// after. Every sticky rank cell is `z-10` and the popover is `z-10` inside one
// of them, so the tie was decided on DOM order and the later row won. The fix
// raises the CELL that contains an open `<details>`.
//
// This suite is `renderToStaticMarkup`, so it can see the class and the chip
// but NOT the cascade — class present is not class in effect. The behavioural
// proof for F9 is the browser measurement recorded in the findings doc; this
// file is what reds if someone deletes the utility.
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { StandingsRow } from "@seazn/engine/competition";
import { StandingsTable } from "../standings-table";
import en from "@/dictionaries/en/public.json";
import es from "@/dictionaries/es/public.json";
import fr from "@/dictionaries/fr/public.json";
import nl from "@/dictionaries/nl/public.json";

const row = (entrantId: string, over: Partial<StandingsRow>): StandingsRow => ({
  entrantId,
  played: 1,
  won: 1,
  drawn: 0,
  lost: 0,
  points: 2,
  metrics: { gf: 3, ga: 1, gd: 2 },
  ...over,
});

const GOALS = [
  { key: "gf", label: "GF" },
  { key: "ga", label: "GA" },
  { key: "gd", label: "GD" },
];

function table(over: Record<string, unknown> = {}, dict: Record<string, string> = en) {
  return renderToStaticMarkup(
    createElement(StandingsTable, {
      rows: [
        row("ada", { rank: 4, points: 2 }),
        row("bo", { rank: 1, points: 9, tieBreak: { key: "diff", with: ["cy"] } }),
        row("cy", { rank: 2, points: 9 }),
      ],
      metricSpecs: GOALS,
      cascade: ["points", "gd"],
      entrantNames: { ada: "Ada Lovelace", bo: "Bo Peep", cy: "Cy Young" },
      dict,
      ...over,
    }),
  );
}

/** The one `<th>` holding an entrant's name, with everything inside it. */
const nameCell = (html: string, name: string) => {
  const cells = [...html.matchAll(/<th scope="row"[\s\S]*?<\/th>/g)].map((m) => m[0]);
  const hit = cells.find((c) => c.includes(name));
  expect(hit, `no row cell for ${name}`).toBeDefined();
  return hit!;
};

describe("StandingsTable — a withdrawn entrant is marked as withdrawn", () => {
  it("marks ONLY the entrants named, and marks them in their own row", () => {
    const html = table({ withdrawnEntrantIds: ["ada"] });
    expect(nameCell(html, "Ada Lovelace")).toContain('data-testid="standings-withdrawn"');
    // The discriminating half: a chip rendered for every row would satisfy a
    // bare `toContain` on the whole table.
    expect(nameCell(html, "Bo Peep")).not.toContain("standings-withdrawn");
    expect(nameCell(html, "Cy Young")).not.toContain("standings-withdrawn");
    expect([...html.matchAll(/standings-withdrawn/g)]).toHaveLength(1);
  });

  it("marks nobody when the prop is omitted or empty — the positive pair", () => {
    // Every other caller of this table passes nothing. A chip that appeared by
    // default would brand a whole live league as withdrawn.
    expect(table()).not.toContain("standings-withdrawn");
    expect(table({ withdrawnEntrantIds: [] })).not.toContain("standings-withdrawn");
  });

  it("keeps the row, its rank and its points — the result is marked, not voided", () => {
    // The owner's call was to carry the row (spectators who watched the match
    // should still see what happened), so this pins the thing a "void it"
    // implementation would break. Values derived from the row above, not typed.
    const html = table({ withdrawnEntrantIds: ["ada"] });
    const bodyRows = [...html.matchAll(/<tr[\s\S]*?<\/tr>/g)]
      .map((m) => m[0])
      .filter((r) => r.includes('scope="row"'));
    expect(bodyRows).toHaveLength(3);
    const adaRow = bodyRows.find((r) => r.includes("Ada Lovelace"))!;
    expect(adaRow, "the withdrawn entrant's row was dropped").toBeDefined();
    expect(adaRow).toContain("standings-withdrawn");
    // Her rank chip and her points are still printed: 4 in the rank cell, 2 in
    // the points column. A void-it implementation loses both.
    expect(adaRow).toMatch(/<span class="inline-flex h-5 w-5[^"]*">4<\/span>/);
    expect(adaRow).toMatch(/>2</);
  });

  it("prints the word from the page's dictionary, in all four locales", () => {
    for (const dict of [en, es, fr, nl]) {
      const word = (dict as Record<string, string>)["table.withdrawn"];
      expect(word, "a locale is missing table.withdrawn").toBeTruthy();
      expect(table({ withdrawnEntrantIds: ["ada"] }, dict)).toContain(`>${word}</span>`);
    }
    // Distinct per locale, or one of them was left in English.
    const values = [en, es, fr, nl].map((d) => (d as Record<string, string>)["table.withdrawn"]);
    expect(new Set(values).size).toBe(4);
  });
});

describe("StandingsTable — an open tie-break popover is not painted over by the rows below", () => {
  it("raises the sticky rank cell whose details is open", () => {
    const html = table();
    const rankCells = [...html.matchAll(/<td class="sticky left-0[^"]*"/g)].map((m) => m[0]);
    expect(rankCells.length, "the sticky rank cells are no longer this shape").toBe(3);
    for (const cell of rankCells) {
      // Both halves: the base layer it sits on, and the raise that breaks the
      // tie against the next row's own sticky cell. Asserting only the second
      // would pass on a cell that had lost `z-10` and stopped being sticky at
      // all; asserting only the first is the state the defect shipped in.
      expect(cell).toContain("z-10");
      expect(cell, "the open-details raise is gone — the popover will be covered again").toContain(
        "has-[details[open]]:z-30",
      );
    }
  });

  it("opens the LAST row's popover upward, where the scroll box cannot clip it", () => {
    // A second overlap, found on the live page after the raise above was in:
    // the table sits in `relative overflow-x-auto`, and an `overflow-x: auto`
    // computes `overflow-y: auto` too, so the final row's popover was CLIPPED
    // by the container (tooltip bottom 704 against container bottom 679 at
    // 1280 — three of its four lines gone). Clipping happens before stacking,
    // so no z-index can fix it; the popover has to open inside the box.
    const html = table();
    // React escapes `&` in an attribute value, so the rendered class reads
    // `[tr:last-child_&amp;]:bottom-full`. Decode before asserting, or this
    // passes only by accident of how the variant is spelled.
    const tip = (/<p role="tooltip" class="([^"]*)"/.exec(html)?.[1] ?? "").replace(/&amp;/g, "&");
    expect(tip, "the tooltip lost its last-row flip").toContain("[tr:last-child_&]:bottom-full");
    // Both halves of the flip: `bottom-full` alone leaves `top-0` winning, and
    // the margin has to move with it or the gap lands on the wrong side.
    expect(tip).toContain("[tr:last-child_&]:top-auto");
    expect(tip).toContain("[tr:last-child_&]:mt-0");
    expect(tip).toContain("[tr:last-child_&]:mb-1");
    // The default direction still holds for every other row.
    expect(tip).toMatch(/\bmt-1\b/);
  });

  it("premise: the container really is the clipping kind", () => {
    // If that wrapper ever stops clipping, the flip above is unnecessary
    // rather than wrong — but this is the fact it rests on, so it is pinned
    // rather than remembered.
    const html = table();
    // The box carries role/tabindex first (it is a focusable scroll region),
    // so anchor on the class list rather than on attribute order.
    expect(html).toMatch(/<div[^>]*class="relative overflow-x-auto/);
  });

  it("premise: the popover really does live inside that cell, and is itself z-10", () => {
    // If the tooltip moved out of the sticky cell the fix above would be
    // pointing at the wrong element, and this suite would keep passing.
    const html = table();
    const cell = /<td class="sticky left-0[\s\S]*?<\/td>/.exec(html)?.[0] ?? "";
    expect(cell, "the tie-break row is no longer the first rank cell rendered").toContain("<details");
    // The tooltip's own layer, inside that cell. If it were higher than the
    // next row's sticky cell on its own, the raise above would be unnecessary;
    // it is z-10, which is exactly the tie that lost.
    expect(cell).toMatch(/<p role="tooltip" class="absolute left-0 z-10 /);
  });
});
