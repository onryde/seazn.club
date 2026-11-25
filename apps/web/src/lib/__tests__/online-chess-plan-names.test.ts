// Online Chess credits, Task 11 fix round 1 (review M2): the size select greys a size "not on {plan}", and the plan is a PRODUCT name. The
// product writes its plans untranslated in every locale (the fr dictionary says "Rétrograder vers Community ?", "la limite Community"), so
// the label must too: fr once read "Communauté", a name no other screen uses. The expected name is the English dictionary's, and the fr
// dictionary's own prose is the witness that fr keeps "Community".
import { describe, expect, it } from "vitest";
import { LOCALES, type Dict } from "@/lib/i18n-constants";
import en from "@/dictionaries/en/ui.json";
import es from "@/dictionaries/es/ui.json";
import fr from "@/dictionaries/fr/ui.json";
import nl from "@/dictionaries/nl/ui.json";

const DICTS: Record<(typeof LOCALES)[number], Dict> = { en: en as Dict, es: es as Dict, fr: fr as Dict, nl: nl as Dict };
const PLANS = ["community", "pro", "enterprise"] as const;

describe("the plan names in the size select's notes", () => {
  it("every locale writes each plan's product name, as English does", () => {
    let checked = 0;
    for (const locale of LOCALES) {
      for (const plan of PLANS) {
        const key = `onlineChess.size.plan.${plan}`;
        expect(DICTS[locale][key], `${locale} ${key}`).toBe(DICTS.en[key]);
        checked += 1;
      }
    }
    expect(checked, "anti-vacuity: locales x plans").toBe(LOCALES.length * PLANS.length);
    expect(DICTS.en["onlineChess.size.plan.community"], "premise: the English name is the product's").toBe("Community");
  });

  it("the premise holds in fr's own prose: it says Community, never a translation of it, when it names the plan", () => {
    const naming = Object.values(DICTS.fr).filter((v) => typeof v === "string" && /\bCommunity\b/.test(v));
    expect(naming.length, "fr names the plan 'Community' in its own sentences").toBeGreaterThan(3);
  });
});
