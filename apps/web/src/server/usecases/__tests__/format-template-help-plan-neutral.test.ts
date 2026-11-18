// The builder's template help lines must not name a plan.
//
// `format.template.<key>.help` is static copy shown on every format card, for every org. Three of them ended "(Pro)"
// (americano, mexicano, ladder): imprecise for an org on the Event Pass, which has `formats.advanced` too, and a
// plan name printed on a card the org's own plan may already unlock. Whether a card is locked - and for which feature -
// is answered live from the org's entitlements (`templateLocksFor`, rendered as the `divBuilder.card.pro` badge), so the
// help line says what the format IS and nothing about who may use it.
//
// The set of templates to check is DERIVED from the gates (`templateLocksFor` with everything denied), never typed out:
// a template that gains a gated kind is checked the day it does.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { STAGE_TEMPLATES } from "@/lib/format-templates";
import { templateLocksFor } from "../format-gates";

const DICT_ROOT = "src/dictionaries";
const LOCALES = readdirSync(DICT_ROOT)
  .filter((entry) => statSync(join(DICT_ROOT, entry)).isDirectory())
  .sort();
const dict = (locale: string) => JSON.parse(readFileSync(join(DICT_ROOT, locale, "ui.json"), "utf8")) as Record<string, string | undefined>;

// Plan names as they appear in any locale's copy: the paid tier, the free tier, the one-off pass.
const PLAN_WORD = /\b(Pro|Community|Event Pass|Business|Enterprise)\b|\bpaid plans?\b/i;

describe("format template help lines are plan-neutral", () => {
  const gated = Object.keys(templateLocksFor({ doubleElim: false, advanced: false }));

  it("derives a non-empty gated set that holds the three formats that carried the badge (anti-vacuity)", () => {
    expect(gated.length).toBeGreaterThanOrEqual(3);
    for (const key of ["americano", "mexicano", "ladder"]) expect(gated, `${key} is gated for an org with neither feature`).toContain(key);
    expect(LOCALES.length).toBeGreaterThan(3);
  });

  it("the gate agrees with itself: with both features allowed nothing is gated", () => {
    expect(Object.keys(templateLocksFor({ doubleElim: true, advanced: true }))).toEqual([]);
  });

  it("a Community-style org (double elimination allowed, advanced not) is locked out of exactly the advanced kinds", () => {
    const locks = templateLocksFor({ doubleElim: true, advanced: false });
    expect(Object.keys(locks).length).toBeGreaterThan(0);
    for (const feature of Object.values(locks)) expect(feature).toBe("formats.advanced");
  });

  for (const locale of LOCALES) {
    it(`${locale}: no gated template's help line names a plan`, () => {
      const d = dict(locale);
      let checked = 0;
      const offenders: string[] = [];
      for (const key of gated) {
        const help = d[`format.template.${key}.help`];
        expect(help, `${locale} has format.template.${key}.help`).toBeTruthy();
        checked++;
        if (PLAN_WORD.test(help!)) offenders.push(`${key}: ${help}`);
      }
      expect(checked, "anti-vacuity: every gated template was read").toBe(gated.length);
      expect(offenders, offenders.join("\n")).toEqual([]);
    });
  }

  it("every template, gated or not, is plan-neutral in every locale (the badge is the only place a plan is named)", () => {
    let checked = 0;
    const offenders: string[] = [];
    for (const locale of LOCALES) {
      const d = dict(locale);
      for (const t of STAGE_TEMPLATES) {
        const help = d[`format.template.${t.key}.help`] ?? "";
        checked++;
        if (PLAN_WORD.test(help)) offenders.push(`${locale}/${t.key}: ${help}`);
      }
    }
    expect(checked).toBe(LOCALES.length * STAGE_TEMPLATES.length);
    expect(offenders, offenders.join("\n")).toEqual([]);
  });
});
