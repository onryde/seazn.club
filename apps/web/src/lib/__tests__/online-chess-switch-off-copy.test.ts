// Online Chess credits, Task 11 fix round 1: the copy the switch-off confirm, the refund line and the two size-write races say, in all four
// locales. Expected slots come from what each sentence must carry (the amount and the size in the confirm; the count in each refund
// clause), never from the strip's own output; the strip's tests drive the real sentences in English, this proves every locale has them,
// that none is an English leftover, and that a plural pair is a pair (both forms carry the same slots).
import { describe, expect, it } from "vitest";
import { LOCALES, type Dict } from "@/lib/i18n-constants";
import en from "@/dictionaries/en/ui.json";
import es from "@/dictionaries/es/ui.json";
import fr from "@/dictionaries/fr/ui.json";
import nl from "@/dictionaries/nl/ui.json";

const DICTS: Record<(typeof LOCALES)[number], Dict> = { en: en as Dict, es: es as Dict, fr: fr as Dict, nl: nl as Dict };

/** key -> the `{slots}` every form of it must carry. */
const COPY: Record<string, readonly string[]> = {
  "onlineChess.switchOff.title": [],
  "onlineChess.switchOff.body.one": ["count", "size"],
  "onlineChess.switchOff.body.other": ["count", "size"],
  "onlineChess.switchOff.confirm": [],
  "onlineChess.refund.off": [],
  "onlineChess.refund.returned.one": ["count"],
  "onlineChess.refund.returned.other": ["count"],
  "onlineChess.refund.forfeited.one": ["count"],
  "onlineChess.refund.forfeited.other": ["count"],
  "onlineChess.err.sizePaid": [],
  "onlineChess.err.sizeFrozen": [],
};
const slotsOf = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();

describe("the switch-off confirm, the refund line and the size-write races: every locale", () => {
  it("each key exists in every locale, carries exactly its slots, and is not English in a non-English locale", () => {
    let checked = 0;
    for (const locale of LOCALES) {
      for (const [key, slots] of Object.entries(COPY)) {
        const text = DICTS[locale][key];
        expect(typeof text, `${locale} ${key}`).toBe("string");
        expect(slotsOf(text as string), `${locale} ${key}: slots`).toEqual([...slots].sort());
        if (locale !== "en") expect(text, `${locale} ${key}: an English leftover`).not.toBe(DICTS.en[key]);
        checked += 1;
      }
    }
    expect(checked, "anti-vacuity: locales x keys").toBe(LOCALES.length * Object.keys(COPY).length);
  });

  it("the confirm's body says what may not come back, in every locale (the English witness: 'earlier month')", () => {
    expect(DICTS.en["onlineChess.switchOff.body.other"]).toMatch(/earlier month may not come back/);
    for (const locale of LOCALES) {
      for (const form of ["one", "other"]) {
        const body = DICTS[locale][`onlineChess.switchOff.body.${form}`] as string;
        // The warning is the body's last sentence: a body that stopped before it would still pass the slots check above.
        expect(body.split(/(?<=[.])\s+/).length, `${locale} ${form}: refund, what returns, what may not`).toBeGreaterThanOrEqual(4);
      }
    }
  });
});
