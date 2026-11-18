// X-BD-3: the "Super groups" card and its detail sheet. The sheet asks an any-sport template for a sport, a variant, an
// entrant kind and a field size, and says what the size builds ("4 pools of 4"). No jsdom here: the sheet is rendered with
// renderToStaticMarkup (its first state is the whole story a static render can tell); the state transitions are
// lib/__tests__/template-choice.test.ts, the resolver is server/templates/__tests__/resolve.test.ts.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { builtinModules } from "@seazn/engine/sports";
import { effectiveEntrantModel } from "@seazn/engine/sport";
import { TemplateCard, TemplateDetailSheet } from "../template-gallery";
import { DictProvider } from "@/components/i18n/dict-provider";
import enUi from "@/dictionaries/en/ui.json";
import esUi from "@/dictionaries/es/ui.json";
import frUi from "@/dictionaries/fr/ui.json";
import nlUi from "@/dictionaries/nl/ui.json";
import { t as tRuntime } from "@/lib/i18n-runtime";
import type { Dict, Locale } from "@/lib/i18n-constants";
import { sportOptionsFrom } from "@/lib/sport-options";
import { getTemplate } from "@/server/templates/catalog";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

const SPORTS = sportOptionsFrom(
  builtinModules.map((m) => ({ key: m.key, name: m.key })),
  builtinModules.flatMap((m) => Object.keys(m.variants).map((key) => ({ sport_key: m.key, key, name: key, is_system: true, config: null }))),
  (key) => {
    const m = builtinModules.find((x) => x.key === key)!;
    const e = effectiveEntrantModel((m as { entrantModel?: never }).entrantModel ?? null, null);
    return { kinds: e.kinds, defaultKind: e.defaultKind };
  },
);
const SUPER = getTemplate("super-groups")!;
const T20 = getTemplate("t20-super8")!;
const LOCALES: [Locale, Dict][] = [["en", enUi as Dict], ["es", esUi as Dict], ["fr", frUi as Dict], ["nl", nlUi as Dict]];

const sheet = (template = SUPER, sports = SPORTS, dict: Dict = enUi as Dict, locale: Locale = "en") =>
  renderToStaticMarkup(
    <DictProvider dict={dict} locale={locale}>
      <TemplateDetailSheet orgSlug="acme" template={template} sports={sports} onClose={() => {}} publicDashboardUpgrade={null} viewerPlan="community" />
    </DictProvider>,
  );
const card = (template = SUPER, dict: Dict = enUi as Dict) =>
  renderToStaticMarkup(<TemplateCard template={template} msg={(k, v) => tRuntime(dict, k, v)} onSelect={() => {}} />);

describe("super-groups sheet (X-BD-3)", () => {
  it("asks for a sport, a variant, an entrant kind and a field size", () => {
    const html = sheet();
    for (const id of ["template-choice", "template-choice-sport", "template-choice-variant", "template-choice-kind", "template-choice-count"]) {
      expect(html, id).toContain(`data-testid="${id}"`);
    }
  });

  it("offers every sport of the registry, and every offered field size with what it builds", () => {
    const html = sheet();
    let sports = 0;
    for (const m of builtinModules) {
      expect(html, m.key).toContain(`<option value="${m.key}"`);
      sports++;
    }
    expect(sports).toBe(builtinModules.length);
    expect(sports).toBeGreaterThan(0);
    // The rule: pools of 4 -> n/4 pools. Typed from the rule, per offered size.
    let sizes = 0;
    for (const [n, pools] of [[8, 2], [12, 3], [16, 4], [24, 6], [32, 8]] as const) {
      expect(html, String(n)).toContain(`<option value="${n}"`);
      expect(html, String(n)).toContain(`${n} entrants · ${pools} pools of 4`);
      sizes++;
    }
    expect(sizes).toBe(5);
  });

  it("describes the default 16: Group Stage 4 pools of 4, Super groups 2 pools of 4, a knockout of 4", () => {
    const html = sheet();
    expect(html).toContain('data-testid="template-detail-stages"');
    expect(html).toMatch(/Group Stage<\/span> · 4 pools of 4/);
    expect(html).toMatch(/Super groups<\/span> · 2 pools of 4/);
    expect(html).toMatch(/Knockout<\/span> · 4 entrants/);
    expect(html).toContain("Group Stage: Top 2 per group → Super groups");
  });

  it("no sport to build on: the create is disabled, never a default sport", () => {
    const html = sheet(SUPER, []);
    expect(html).not.toContain('data-testid="template-choice"');
    expect(html).toMatch(/data-testid="template-detail-submit"[^>]*disabled|disabled=""[^>]*data-testid="template-detail-submit"/);
  });

  it("a fixed template's sheet is what it was: no choice block, its own entrant count line", () => {
    const html = sheet(T20);
    expect(html).not.toContain("template-choice");
    expect(html).not.toContain('data-testid="template-detail-stages"');
    expect(html).toContain("16 entrants");
  });

  it("every locale renders the card and the sheet in words, never a dictionary key", () => {
    let checked = 0;
    for (const [locale, dict] of LOCALES) {
      for (const html of [sheet(SUPER, SPORTS, dict, locale), card(SUPER, dict)]) {
        expect(html, locale).not.toMatch(/templates\.(superGroups|stage|detail)\./);
        expect(html, locale).not.toContain("divBuilder.entrants");
        expect(html, locale).not.toContain("divset.variant");
      }
      expect(card(SUPER, dict), locale).toContain(tRuntime(dict, "templates.superGroups.name"));
      checked++;
    }
    expect(checked).toBe(4);
  });
});

describe("super-groups card (X-BD-3)", () => {
  it("states its structure and no entrant total (the sheet asks for the field)", () => {
    const html = card();
    expect(html).toContain('data-testid="template-card-super-groups"');
    expect(html).toContain("Group Stage → Super groups → Knockout");
    expect(html).not.toContain("entrants");
  });

  it("a fixed card still states its entrants", () => {
    expect(card(T20)).toContain("16 entrants");
  });
});
