// Two findings from driving the live product, both on this one table.
//
// F2 (2026-09-20): a withdrawn entrant sat in the standings at rank 4 with 2
// points, in the console AND on the public endpoint, with nothing whatever to
// tell her apart — row classes identical to the people still competing. Her
// played result STANDS by design (the withdrawal settles the rest through the
// ledger), so the row is carried; carrying it unmarked is the defect.
// `StandingsRow` has no status field, so the marking arrives beside the rows.
//
// C1 (2026-09-21): the first fix marked only `withdrawn`. `disqualified` is the
// OTHER way out of a field — `EntrantStatus` accepts it and `patchEntrant`
// writes it — so a disqualified entrant was still ranked among the competing
// with nothing to tell her apart: F2, unfixed, for half the vocabulary. The
// repair is not one chip for both: `entrants-panel.tsx` already gives the two
// statuses different colours, and calling a disqualified entrant "Withdrawn" is
// simply false. So the table takes the entrant's OWN status and looks the chip
// up — which is why the last row below derives the departed set from the
// product's vocabulary instead of naming today's two.
//
// F9 (2026-09-21): with the tie-break popover open, the rank chip of the NEXT
// row punched through its left edge and the row after that covered its
// bottom-left corner. Measured with `elementFromPoint` on every row, before and
// after. Every sticky rank cell is `z-10` and the popover is `z-10` inside one
// of them, so the tie was decided on DOM order and the later row won. The fix
// raises the CELL that contains an open popover. (It was an open `<details>`
// then; since the shared `StandingsPopover` replaced it, the open mark is the
// popover root's `data-open`, and the raise is `has-[[data-open]]:z-20`: above
// the z-10 neighbours, which is all it is for, and below the z-30 tab rail, so
// an open row scrolled under the rail no longer paints over it.)
//
// This suite is `renderToStaticMarkup`, so it can see the class and the chip
// but NOT the cascade — class present is not class in effect. The behavioural
// proof for F9 is the browser measurement recorded in the findings doc; this
// file is what reds if someone deletes the utility.
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { StandingsRow } from "@seazn/engine/competition";
import { StandingsTable, DEPARTED_STATUS_CHIPS } from "../standings-table";
import { FIELD_ENTRANT_STATUSES } from "@/lib/entrant-field";
import { EntrantStatus } from "@/server/api-v1/schemas";
import en from "@/dictionaries/en/public.json";
import es from "@/dictionaries/es/public.json";
import fr from "@/dictionaries/fr/public.json";
import nl from "@/dictionaries/nl/public.json";

const LOCALES = { en, es, fr, nl } as Record<string, Record<string, string>>;

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

/** Every `data-testid="standings-…"` chip in the markup, in document order. */
const chipIds = (html: string) =>
  [...html.matchAll(/data-testid="(standings-[a-z]+)"/g)].map((m) => m[1]);

describe("StandingsTable — a departed entrant is marked with the status she holds", () => {
  it("marks ONLY the entrants who left, and marks them in their own row", () => {
    const html = table({ entrantStatuses: { ada: "withdrawn", bo: "confirmed", cy: "registered" } });
    expect(nameCell(html, "Ada Lovelace")).toContain('data-testid="standings-withdrawn"');
    // The discriminating half: a chip rendered for every row would satisfy a
    // bare `toContain` on the whole table.
    expect(nameCell(html, "Bo Peep")).not.toContain("data-testid=\"standings-");
    expect(nameCell(html, "Cy Young")).not.toContain("data-testid=\"standings-");
    expect(chipIds(html)).toEqual(["standings-withdrawn"]);
  });

  it("marks nobody when the prop is omitted, empty, or holds only competing statuses", () => {
    // Every other caller of this table passes nothing. A chip that appeared by
    // default would brand a whole live league as departed.
    expect(chipIds(table())).toEqual([]);
    expect(chipIds(table({ entrantStatuses: {} }))).toEqual([]);
    // And the shape that matters now the prop carries EVERY entrant rather than
    // a pre-filtered id list: a component that chipped on mere PRESENCE in the
    // map would mark the entire field. Derived from the vocabulary, not typed.
    const competing = Object.fromEntries(
      ["ada", "bo", "cy"].map((id, i) => [id, FIELD_ENTRANT_STATUSES[i % FIELD_ENTRANT_STATUSES.length]!]),
    );
    expect(chipIds(table({ entrantStatuses: competing }))).toEqual([]);
    // An unknown status is not a silent chip either.
    expect(chipIds(table({ entrantStatuses: { ada: "pending" } }))).toEqual([]);
  });

  it("keeps the row, its rank and its points — the result is marked, not voided", () => {
    // The owner's call was to carry the row (spectators who watched the match
    // should still see what happened), so this pins the thing a "void it"
    // implementation would break. Values derived from the row above, not typed.
    for (const status of Object.keys(DEPARTED_STATUS_CHIPS)) {
      const html = table({ entrantStatuses: { ada: status } });
      const bodyRows = [...html.matchAll(/<tr[\s\S]*?<\/tr>/g)]
        .map((m) => m[0])
        .filter((r) => r.includes('scope="row"'));
      expect(bodyRows, `${status} changed how many rows render`).toHaveLength(3);
      const adaRow = bodyRows.find((r) => r.includes("Ada Lovelace"));
      expect(adaRow, `the ${status} entrant's row was dropped`).toBeDefined();
      expect(adaRow).toContain(`data-testid="standings-${status}"`);
      // Her rank chip and her points are still printed: 4 in the rank cell, 2 in
      // the points column. A void-it implementation loses both.
      expect(adaRow).toMatch(/<span class="inline-flex h-5 w-5[^"]*">4<\/span>/);
      expect(adaRow).toMatch(/>2</);
    }
  });

  it("prints every departed word from the page's dictionary, in all four locales", () => {
    for (const [status, chip] of Object.entries(DEPARTED_STATUS_CHIPS)) {
      for (const [locale, dict] of Object.entries(LOCALES)) {
        const word = dict[chip.label];
        expect(word, `${locale} is missing ${chip.label}`).toBeTruthy();
        expect(
          table({ entrantStatuses: { ada: status } }, dict),
          `${locale} did not print ${chip.label}`,
        ).toContain(`>${word}</span>`);
      }
      // Distinct per locale, or one of them was left in English.
      const values = Object.values(LOCALES).map((d) => d[chip.label]);
      expect(new Set(values).size, `${chip.label} is not translated in all four locales`).toBe(4);
    }
  });

  it("gives a disqualified entrant her OWN label, never the withdrawn one", () => {
    // The C1 defect in one assertion. Both statuses in ONE table, because the
    // failure mode that shipped is not "no chip" but "the same chip for both":
    // a disqualification announced as a withdrawal is factually wrong, and a
    // test that rendered them in separate tables could not see it.
    for (const [locale, dict] of Object.entries(LOCALES)) {
      const html = table({ entrantStatuses: { ada: "withdrawn", bo: "disqualified" } }, dict);
      const withdrawnWord = dict[DEPARTED_STATUS_CHIPS.withdrawn.label]!;
      const disqualifiedWord = dict[DEPARTED_STATUS_CHIPS.disqualified.label]!;
      expect(
        withdrawnWord.toLowerCase(),
        `${locale} prints the same word for both departures`,
      ).not.toBe(disqualifiedWord.toLowerCase());
      expect(nameCell(html, "Ada Lovelace")).toContain(`>${withdrawnWord}</span>`);
      expect(nameCell(html, "Bo Peep")).toContain(`>${disqualifiedWord}</span>`);
      // …and neither cell carries the other's word.
      expect(
        nameCell(html, "Ada Lovelace"),
        `${locale}: the withdrawn row is labelled disqualified`,
      ).not.toContain(`>${disqualifiedWord}</span>`);
      expect(
        nameCell(html, "Bo Peep"),
        `${locale}: the disqualified row is labelled withdrawn`,
      ).not.toContain(`>${withdrawnWord}</span>`);
      expect(chipIds(html).sort()).toEqual(["standings-disqualified", "standings-withdrawn"]);
    }
  });

  it("prints the WORD that belongs to each status — key named here, never read out of the map", () => {
    // The row above takes its expected word OUT of the table under test
    // (`dict[DEPARTED_STATUS_CHIPS.withdrawn.label]`), so swapping the two
    // label keys swaps the expectation with them: the public board would print
    // "Disqualified" on a withdrawal and "Withdrawn" on a disqualification, in
    // all four locales, and every row in this file — and the e2e — stayed
    // green (independent mutation campaign, C5, 2026-09-21). An expectation
    // derived from the artefact it is testing asserts x === x. It still earns
    // its place (it pins that the two words DIFFER, whatever they are); what it
    // cannot do is say which word belongs to which status.
    //
    // So this row names the dictionary key per status as a literal, and the
    // English a spectator actually reads as a literal beside it. Neither can
    // move when the map does.
    const KEY = { withdrawn: "table.withdrawn", disqualified: "table.disqualified" } as const;
    const WORD_EN = { withdrawn: "Withdrawn", disqualified: "Disqualified" } as const;
    const WHO = { withdrawn: "Ada Lovelace", disqualified: "Bo Peep" } as const;
    const statuses = ["withdrawn", "disqualified"] as const;

    // 1. The map points each status at its OWN key.
    for (const status of statuses) expect(DEPARTED_STATUS_CHIPS[status].label).toBe(KEY[status]);

    // 2. And that key's word is what the entrant holding that status prints,
    //    in every locale — the other departure's word never lands in her cell.
    for (const [locale, dict] of Object.entries(LOCALES)) {
      const html = table({ entrantStatuses: { ada: "withdrawn", bo: "disqualified" } }, dict);
      for (const status of statuses) {
        const mine = dict[KEY[status]];
        const theirs = dict[KEY[status === "withdrawn" ? "disqualified" : "withdrawn"]];
        expect(mine, `${locale} has no ${KEY[status]}`).toBeTruthy();
        expect(
          nameCell(html, WHO[status]),
          `${locale}: the ${status} entrant does not print ${KEY[status]}`,
        ).toContain(`>${mine}</span>`);
        expect(
          nameCell(html, WHO[status]),
          `${locale}: the ${status} entrant is labelled with the OTHER departure's word`,
        ).not.toContain(`>${theirs}</span>`);
      }
    }

    // 3. The English words themselves, typed: a re-keying of the dictionary
    //    cannot quietly carry (1) and (2) along with it.
    const html = table({ entrantStatuses: { ada: "withdrawn", bo: "disqualified" } }, en);
    for (const status of statuses) {
      expect(
        nameCell(html, WHO[status]),
        `an entrant whose status is "${status}" must read "${WORD_EN[status]}"`,
      ).toContain(`>${WORD_EN[status]}</span>`);
    }
  });

  it("gives the two departures visibly different chips, as the roster editor does", () => {
    // `entrantStatusStyle` in `components/v2/entrants-panel.tsx` already paints
    // a disqualification red and a withdrawal grey. If the public table painted
    // them identically the word would be the only difference, which is exactly
    // the distinction a glance down a table cannot make.
    const classes = Object.values(DEPARTED_STATUS_CHIPS).map((c) => c.className);
    expect(new Set(classes).size, "the departed chips are styled identically").toBe(classes.length);
    const html = table({ entrantStatuses: { ada: "withdrawn", bo: "disqualified" } });
    expect(nameCell(html, "Ada Lovelace")).toContain(DEPARTED_STATUS_CHIPS.withdrawn.className);
    expect(nameCell(html, "Bo Peep")).toContain(DEPARTED_STATUS_CHIPS.disqualified.className);
  });

  it("premise: EVERY status that is not in the field has a chip", () => {
    // The row that makes the C1 defect unrepeatable. `withdrawnEntrantIds` was
    // a hand-filtered id list, so "which statuses count as departed" was spelled
    // out at each of three call sites and each got half the vocabulary. The
    // component now owns it once — and this derives the answer from the
    // product's own declarations (the API enum minus the competing set), so a
    // fifth status reds HERE instead of shipping an unmarked row.
    const departed = EntrantStatus.options.filter(
      (s) => !(FIELD_ENTRANT_STATUSES as readonly string[]).includes(s),
    );
    expect(departed.length, "no status in the vocabulary is a departure").toBeGreaterThanOrEqual(2);
    expect(Object.keys(DEPARTED_STATUS_CHIPS).sort()).toEqual([...departed].sort());
    // Positive pair: the competing statuses must NOT have acquired a chip —
    // an implementation that chipped everything would satisfy the row above
    // only if the sets were equal, but this says so outright.
    for (const s of FIELD_ENTRANT_STATUSES) {
      expect(DEPARTED_STATUS_CHIPS, `${s} is a competing status and must not be chipped`).not.toHaveProperty(s);
    }
    // And every chip's key really is a dictionary key that resolves.
    for (const chip of Object.values(DEPARTED_STATUS_CHIPS)) {
      expect(en as Record<string, string>, `${chip.label} is not in en/public.json`).toHaveProperty(chip.label);
    }
  });
});

describe("StandingsTable — an open tie-break popover is not painted over by the rows below", () => {
  it("raises the sticky rank cell whose popover is open", () => {
    const html = table();
    const rankCells = [...html.matchAll(/<td class="sticky left-0[^"]*"/g)].map((m) => m[0]);
    expect(rankCells.length, "the sticky rank cells are no longer this shape").toBe(3);
    for (const cell of rankCells) {
      // Both halves: the base layer it sits on, and the raise that breaks the
      // tie against the next row's own sticky cell. Asserting only the second
      // would pass on a cell that had lost `z-10` and stopped being sticky at
      // all; asserting only the first is the state the defect shipped in.
      expect(cell).toContain("z-10");
      expect(cell, "the open-popover raise is gone — the popover will be covered again").toContain(
        "has-[[data-open]]:z-20",
      );
      // …and no higher: at z-30 the open cell tied the sticky tab rail and won
      // on DOM order, painting over the rail when scrolled under it.
      expect(cell, "the open-popover raise is above the tab rail's z-30").not.toMatch(/has-\[\[data-open\]\]:z-(?:[3-9]\d|\d{3,})\b/);
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
    const tip = (/<span id="[^"]*" role="note"[^>]*class="([^"]*)"/.exec(html)?.[1] ?? "").replace(/&amp;/g, "&");
    expect(tip, "the popover lost its last-row flip").toContain("[tr:last-child_&]:bottom-full");
    // Both halves of the flip: `bottom-full` alone leaves `top-0` winning, and
    // the margin has to move with it or the gap lands on the wrong side.
    expect(tip).toContain("[tr:last-child_&]:top-auto");
    expect(tip).toContain("[tr:last-child_&]:mt-0");
    expect(tip).toContain("[tr:last-child_&]:mb-1");
    // The default direction still holds for every other row: below the
    // trigger (`top-full`, now explicit — the `<details>` got it from flow).
    expect(tip).toMatch(/\bmt-1\b/);
    expect(tip).toMatch(/(^|\s)top-full(\s|$)/);
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

  it("premise: the popover really does live inside that cell, whose stacking context traps its z-index", () => {
    // If the popover moved out of the sticky cell the fix above would be
    // pointing at the wrong element, and this suite would keep passing.
    const html = table();
    const cell = /<td class="sticky left-0[\s\S]*?<\/td>/.exec(html)?.[0] ?? "";
    expect(cell, "the tie-break row is no longer the first rank cell rendered").toContain(
      'data-testid="standings-tie-bo"',
    );
    // The panel, inside that cell and positioned. Its own z-index (z-20) is
    // LOCAL to the cell's stacking context — a sticky `z-10` cell makes one —
    // so however high it is it cannot beat the next row's cell by itself;
    // that is why the CELL has to rise.
    expect(cell).toMatch(/<span id="[^"]*" role="note"[^>]*class="absolute top-full z-20 /);
    expect(cell).toMatch(/<td class="sticky left-0 z-10 /);
  });
});
