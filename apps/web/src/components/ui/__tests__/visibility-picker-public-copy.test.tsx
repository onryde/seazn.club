// The Public card's consequence sentence must be TRUE in both states the
// picker is shown in. Owner decision 2026-09-27: a draft is unlisted until it
// is published — and the picker cannot tell (the wizard shows it before the
// competition exists, always a draft; settings show it for any status). The
// old sentence, "Anyone can find it — Google, and the Seazn discover page.",
// was false for every draft, and false for every public competition without
// the Showcase opt-in, which owns the Discover claim (`showcase.label`).
//
// So the sentence carries its own condition ("once it's published") rather
// than branching on a status the picker does not have, and names only what
// publishing a public competition does: the org page (`listOrgHomeCompetitions`)
// and search engines (`linkOnlyRobots`). Read from the REAL catalogs.
import { describe, expect, it } from "vitest";
import { renderIsland } from "@/components/__tests__/_hook-harness";
import { VisibilitySegmented } from "../visibility-segmented";
import { t } from "@/lib/i18n-runtime";
import type { Dict } from "@/lib/i18n-constants";
import uiEn from "@/dictionaries/en/ui.json";
import uiEs from "@/dictionaries/es/ui.json";
import uiFr from "@/dictionaries/fr/ui.json";
import uiNl from "@/dictionaries/nl/ui.json";

const KEY = "visibility.public.consequence";
const OLD_EN = "Anyone can find it — Google, and the Seazn discover page.";
const copy = (d: unknown) => t(d as Dict, KEY);
const EN = copy(uiEn);

describe("Visibility — the Public consequence tells the truth for a draft and a published competition", () => {
  it("premise: the key resolves in English (t() returns the key on a miss)", () => {
    expect(EN).not.toBe(KEY);
  });

  it("carries its own condition: listed once PUBLISHED, and names the org page and search engines", () => {
    expect(EN).not.toBe(OLD_EN);
    expect(EN).toMatch(/once it's published/);
    expect(EN).toMatch(/organisation's page/);
    expect(EN).toMatch(/search engines/);
  });

  it("claims nothing about Discover — that needs the separate Showcase opt-in", () => {
    expect(EN).not.toMatch(/discover|anyone can find/i);
  });

  it("every locale has its own sentence, not English and not the old claim", () => {
    for (const [locale, dict] of [
      ["es", uiEs],
      ["fr", uiFr],
      ["nl", uiNl],
    ] as const) {
      const s = copy(dict);
      expect(s, locale).not.toBe(KEY);
      expect(s, locale).not.toBe(EN);
      expect(s, `${locale} still names Discover`).not.toMatch(/discover|descubr|découv|ontdek/i);
    }
  });

  it("is the sentence the segmented control renders under Public", () => {
    // Settings C8 (owner 2026-11-11): the radio-card picker was retired; competition settings and the New competition
    // form both render the segmented control, which prints the selected option's consequence under it.
    const island = renderIsland(VisibilitySegmented, { value: "public", onChange: () => {}, capped: false });
    expect(island.text()).toContain(EN);
    // The positive pair: another option prints its own sentence, not this one.
    expect(renderIsland(VisibilitySegmented, { value: "unlisted", onChange: () => {}, capped: false }).text()).not.toContain(EN);
  });
});

// The settings page's "Who can see a division" tip said the same false thing:
// "Public is findable on Google and our discover page" — for a draft, neither.
describe("the division visibility tip carries the same publish condition", () => {
  const TIP = "tips.division.visibility.body";
  const OLD_TIP_EN =
    "A division follows its competition: Private is team-only, Link only means anyone with the link, Public is findable on Google and our discover page.";

  it("English: Public is listed and searchable once the competition is PUBLISHED, and names no Discover", () => {
    const tip = t(uiEn as unknown as Dict, TIP);
    expect(tip).not.toBe(TIP);
    expect(tip).not.toBe(OLD_TIP_EN);
    expect(tip).toMatch(/once the competition is published/);
    expect(tip).not.toMatch(/discover/i);
  });

  it("every locale has its own sentence without the Discover claim", () => {
    const en = t(uiEn as unknown as Dict, TIP);
    for (const [locale, dict] of [
      ["es", uiEs],
      ["fr", uiFr],
      ["nl", uiNl],
    ] as const) {
      const tip = t(dict as unknown as Dict, TIP);
      expect(tip, locale).not.toBe(TIP);
      expect(tip, locale).not.toBe(en);
      expect(tip, `${locale} still names Discover`).not.toMatch(/discover|descubr|découv|ontdek/i);
    }
  });
});
