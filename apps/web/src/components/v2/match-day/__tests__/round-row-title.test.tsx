// Match Day online, Task 7 carry (controller, T6 list): at 768 the round row's title wrapped "Round / 1" because the 9rem right column left
// the title a narrow track. The round label stays on one line: the row draws the title as its lead (which may wrap, "Online Rapid" and a
// stage name are free text) and a no-wrap tail ("Round 1", "Ronda 1", "Ronde 1"). Pure markup: apps/web vitest has no layout, so the
// wrap itself is witnessed in the 768 capture; what is pinned here is that the tail exists, is the label and the number, and the two
// parts recompose the title the list, the focus frame and the aria labels already use.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import en from "@/dictionaries/en/ui.json";
import es from "@/dictionaries/es/ui.json";
import fr from "@/dictionaries/fr/ui.json";
import nl from "@/dictionaries/nl/ui.json";
import type { Dict, Locale } from "@/lib/i18n-constants";
import { onlineRoundTitle, onlineRoundTitleParts } from "@/lib/match-day/online-copy";
import { checkinRound } from "./_online-fixtures";
import { RoundRow } from "../round-row";

const DICTS: Record<Locale, Dict> = { en: en as Dict, es: es as Dict, fr: fr as Dict, nl: nl as Dict };
const WORDS: Record<Locale, string> = { en: "Round", es: "Ronda", fr: "Ronde", nl: "Ronde" };

describe("onlineRoundTitleParts - the round label is one unbreakable tail", () => {
  it("in every locale, with and without a stage: lead + tail is the title, the tail is the locale's word and the round number", () => {
    let checked = 0;
    for (const locale of Object.keys(DICTS) as Locale[]) {
      for (const multi_stage of [false, true]) {
        for (const round_no of [1, 12]) {
          const r = { division_name: "Online Rapid", stage_name: "Swiss", round_no, multi_stage };
          const { lead, tail } = onlineRoundTitleParts(DICTS[locale], r);
          const label = `${locale} multi_stage=${multi_stage} round ${round_no}`;
          expect(lead + tail, label).toBe(onlineRoundTitle(DICTS[locale], r));
          expect(tail, label).toBe(`${WORDS[locale]} ${round_no}`);
          expect(lead, `${label}: the division (and the stage) stay in the lead`).toContain("Online Rapid");
          expect(lead.includes("Swiss"), label).toBe(multi_stage);
          checked += 1;
        }
      }
    }
    expect(checked, "anti-vacuity: 4 locales x 2 x 2").toBe(16);
  });

  it("a title with no label to split (a division named like a number) keeps the whole title as its lead", () => {
    const parts = onlineRoundTitleParts({ "matchDay.online.round": "{division}" } as Dict, { division_name: "Open 2026", stage_name: "", round_no: 1, multi_stage: false });
    expect(parts).toEqual({ lead: "Open 2026", tail: "" });
  });
});

describe("RoundRow - 'Round N' never wraps inside the title", () => {
  it("draws the tail in a no-wrap span, after the lead, inside the title's own block", () => {
    const h = renderToStaticMarkup(<RoundRow round={checkinRound("stage-1:1")} selected={false} dict={DICTS.en} locale="en" nowMs={null} onOpen={() => {}} />);
    const m = /<span class="[^"]*">Online Rapid · ?<span data-md-round-tail="true" class="whitespace-nowrap">Round 1<\/span><\/span>/.exec(h);
    expect(m, h).not.toBeNull();
  });

  it("the tail carries the hook the browser witness reads (e2e/mobile/match-surfaces.spec.ts: the tail is ONE client rect at every width), in every locale", () => {
    let checked = 0;
    for (const locale of Object.keys(DICTS) as Locale[]) {
      const h = renderToStaticMarkup(<RoundRow round={checkinRound("stage-1:1")} selected={false} dict={DICTS[locale]} locale={locale} nowMs={null} onOpen={() => {}} />);
      const tail = /<span data-md-round-tail="true" class="([^"]*)">([^<]*)<\/span>/.exec(h);
      expect(tail, `${locale}: ${h}`).not.toBeNull();
      expect(tail![1], `${locale}: the tail does not wrap`).toContain("whitespace-nowrap");
      expect(tail![2], `${locale}: the tail is the label and the number`).toBe(`${WORDS[locale]} 1`);
      checked += 1;
    }
    expect(checked, "anti-vacuity: 4 locales").toBe(4);
  });
});
