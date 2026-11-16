// W5 app PR A, Task 3 (X-BD-6; owner R24 pick 6 option A): the inline Add match form's Round select. The latest round where neither side plays
// is the default; a round where a side already plays is LISTED with its reason and cannot be picked; a long run of them folds into one range.
// The expected rounds are derived from a hand-drawn four-team table (the circle method on paper), never from the code under test.
//   round 1: a-b, c-d     round 2: a-c, b-d     round 3: a-d, b-c
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DictProvider } from "@/components/i18n/dict-provider";
import { AddMatchRoundSelect } from "@/components/v2/add-match-round-select";
import type { AdhocRoundRow } from "@/lib/adhoc-round";
import type { Dict, Locale } from "@/lib/i18n-constants";
import { msgFor } from "@/lib/messages-i18n";
import enUi from "@/dictionaries/en/ui.json";
import esUi from "@/dictionaries/es/ui.json";
import frUi from "@/dictionaries/fr/ui.json";
import nlUi from "@/dictionaries/nl/ui.json";

const NAMES = { a: "Ana", b: "Bo", c: "Cy", d: "Di" };
const row = (round_no: number, home: string, away: string, seats = true): AdhocRoundRow => ({ round_no, home, away, seats });
const FOUR = [row(1, "a", "b"), row(1, "c", "d"), row(2, "a", "c"), row(2, "b", "d"), row(3, "a", "d"), row(3, "b", "c")];
const withVoid = (r1: boolean): AdhocRoundRow[] => FOUR.map((r) => (r1 && r.round_no === 1 && r.home === "a" ? { ...r, seats: false } : r));
const DICTS: Record<Locale, Dict> = { en: enUi as unknown as Dict, es: esUi as unknown as Dict, fr: frUi as unknown as Dict, nl: nlUi as unknown as Dict };

function render(o: { rows?: AdhocRoundRow[]; home?: string; away?: string; pick?: number | null; locale?: Locale }): string {
  const locale = o.locale ?? "en";
  return renderToStaticMarkup(
    <DictProvider dict={DICTS[locale]} locale={locale}>
      <AddMatchRoundSelect
        msg={(k, v) => msgFor(locale, k, v)}
        rows={o.rows ?? FOUR}
        home={o.home ?? "a"}
        away={o.away ?? "b"}
        entrantNames={NAMES}
        pick={o.pick ?? null}
        onPick={() => {}}
      />
    </DictProvider>,
  );
}
const optionsOf = (html: string) =>
  [...html.matchAll(/<option value="(\d*)"([^>]*)>([^<]*)<\/option>/g)].map((m) => ({ value: m[1]!, disabled: / disabled/.test(m[2]!), selected: / selected/.test(m[2]!), text: m[3]! }));

describe("AddMatchRoundSelect (X-BD-6)", () => {
  it("the empty case first: until both sides are chosen the select is there, disabled, and offers no round", () => {
    for (const [home, away] of [["", ""], ["a", ""], ["", "b"]] as const) {
      const html = render({ home, away });
      expect(html).toMatch(/data-testid="add-match-round"[^>]*disabled/);
      expect(optionsOf(html).filter((o) => o.value !== "")).toEqual([]);
    }
  });

  it("a full table: only the new round is open, defaulted; every other round is listed with who plays whom", () => {
    const opts = optionsOf(render({}));
    expect(opts).toEqual([
      { value: "4", disabled: false, selected: true, text: "Round 4 · new round (suggested)" },
      { value: "3", disabled: true, selected: false, text: "Round 3 · Ana plays Di" },
      { value: "2", disabled: true, selected: false, text: "Round 2 · Ana plays Cy" },
      // run of 3 is listed in full (a run folds only when more than two would be hidden)
      { value: "1", disabled: true, selected: false, text: "Round 1 · Ana plays Bo" },
    ]);
  });

  it("a voided Ana-Bo line frees round 1: it is the default (differential: main always said round 4), the new round stays open, the others cannot be picked", () => {
    const opts = optionsOf(render({ rows: withVoid(true) }));
    expect(opts.map((o) => [o.value, o.disabled, o.selected])).toEqual([
      ["4", false, false],
      ["3", true, false],
      ["2", true, false],
      ["1", false, true],
    ]);
    expect(opts.find((o) => o.value === "1")!.text).toBe("Round 1 · both free (suggested)");
    expect(opts.find((o) => o.value === "4")!.text).toBe("Round 4 · new round");
  });

  it("a pick the pair may go in is the selected line; one it may not falls back to the suggestion", () => {
    expect(optionsOf(render({ rows: withVoid(true), pick: 4 })).find((o) => o.selected)!.value).toBe("4");
    expect(optionsOf(render({ rows: withVoid(true), pick: 3 })).find((o) => o.selected)!.value).toBe("1");
  });

  it("a long run folds into one disabled range line, as the R24 mock draws it", () => {
    const rows = Array.from({ length: 6 }, (_, i) => row(i + 1, "a", `x${i + 1}`));
    const opts = optionsOf(render({ rows }));
    expect(opts.map((o) => o.text)).toEqual([
      "Round 7 · new round (suggested)",
      expect.stringMatching(/^Round 6 · Ana plays /),
      expect.stringMatching(/^Round 5 · Ana plays /),
      "Rounds 1 to 4 · a side already plays",
    ]);
    expect(opts[3]!.disabled).toBe(true);
  });

  it("every line is in the viewer's words in all four locales, never a key", () => {
    let checked = 0;
    for (const loc of ["en", "es", "fr", "nl"] as const) {
      const html = render({ rows: withVoid(true), locale: loc });
      for (const o of optionsOf(html).filter((x) => x.value !== "")) {
        expect(o.text, loc).not.toContain("stage.addMatch");
        expect(o.text, loc).toMatch(/\d/);
        if (loc !== "en") expect(o.text, `${loc} is translated`).not.toMatch(/^Round/);
        checked += 1;
      }
    }
    expect(checked).toBe(16);
  });
});
