// W5 B4 (stress F8; owner 2026-11-21): choosing a format in the division builder shows the most entrants it can start - the
// max the server enforces at create and Start (FORMAT_TOO_MANY_ENTRANTS). The view carries it for the PICKED format at the knobs
// as they stand; the division page's Start (launch-actions-format-max.test.tsx) is where a real field past it is stopped.
//
// Expected max: `formatMaxEntrants`, itself pinned against the real generators Start runs, at max and max + 1, for every
// template (lib/__tests__/format-max-entrants.test.ts); this file proves the WIRING - the view and the picked card carry that
// number, and only the picked card - and pins that no planned field can pass it (so the builder owes no Next gate). Expected
// copy: the en dictionary's entry with the number put in.
// Sport: badminton opens the builder (the harness of division-builder-chess-formats.test.tsx); the max reads stage kinds only.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DivisionBuilder, type SportOption } from "@/components/v2/division-builder";
import { DictProvider } from "@/components/i18n/dict-provider";
import enUi from "@/dictionaries/en/ui.json";
import type { Dict } from "@/lib/i18n-constants";
import { engineEntrantChoice } from "@/lib/__tests__/_engine-entrant-kinds";
import { formatPickerView } from "@/lib/division-builder/format-choice";
import { OPENING_PLAN, openingKnobs, type PlanInput } from "@/lib/division-builder/model";
import { formatMaxEntrants } from "@/lib/format-max-entrants";
import { buildTemplateStages, STAGE_TEMPLATES, templatesForSport } from "@/lib/format-templates";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/o/org/c/comp/d/new",
}));

const en = enUi as Record<string, string>;
const BADMINTON: SportOption = { key: "badminton", name: "Badminton", variants: [{ key: "bwf", name: "BWF", system: true }], entrants: engineEntrantChoice("badminton") };
const OFFER = templatesForSport("badminton", ["individual"]).map((t) => t.key);
const plan = (entrants: number): PlanInput => ({ entrants, venues: 2, hours: 4, matchMinutes: 20 });
const viewOf = (template: string, entrants: number) =>
  formatPickerView({
    offer: OFFER,
    plan: plan(entrants),
    template,
    stages: buildTemplateStages(template, openingKnobs(entrants)),
    showAll: false,
    templateLocks: {},
    carryAllowed: true,
    standingsCarry: "none",
  });

describe("the builder's view carries the picked format's max entrants (W5 B4, F8)", () => {
  it("every offered template: the picked max is its first stage's at the knobs as they stand", () => {
    let withMax = 0;
    let checked = 0;
    for (const key of OFFER) {
      for (const entrants of [2, 16, 64]) {
        const want = formatMaxEntrants(buildTemplateStages(key, openingKnobs(entrants))[0]!);
        expect(viewOf(key, entrants).pickedMax, `${key} at ${entrants}`).toBe(want);
        if (want !== null) withMax++;
        checked++;
      }
    }
    expect(checked, "anti-vacuity: template x field pairs read").toBe(OFFER.length * 3);
    expect(withMax, "most formats have a max").toBeGreaterThan(checked / 2);
  });

  it("no picked drafts (the empty case): no max", () => {
    expect(formatPickerView({ ...viewInput("league", 16), stages: [] }).pickedMax).toBeNull();
  });

  it("GUARD: no field the plan box takes is past any offered format's max, so the builder owes no Next gate", () => {
    // The plan box's ceiling, read off the rendered input (the builder's own bound). The day it, the budget or a template
    // moves so a planned field can pass its format's max, this reds: give Next a FORMAT_TOO_MANY_ENTRANTS gate then.
    const box = /<input[^>]*max="(\d+)"[^>]*data-testid="division-builder-plan-entrants"/.exec(builderHtml());
    expect(box, "the plan box renders, with a max").not.toBeNull();
    const ceiling = Number(box![1]);
    expect(ceiling, "the plan box renders a max").toBeGreaterThan(2);
    let checked = 0;
    for (const key of OFFER) {
      for (let entrants = 2; entrants <= ceiling; entrants++) {
        const max = formatMaxEntrants(buildTemplateStages(key, openingKnobs(entrants))[0]!);
        if (max !== null) expect(entrants, `${key}: a plan of ${entrants} against its max ${max}`).toBeLessThanOrEqual(max);
        checked++;
      }
    }
    expect(checked, "anti-vacuity").toBe(OFFER.length * (ceiling - 1));
  });
});

function viewInput(template: string, entrants: number) {
  return {
    offer: OFFER,
    plan: plan(entrants),
    template,
    stages: buildTemplateStages(template, openingKnobs(entrants)),
    showAll: false,
    templateLocks: {},
    carryAllowed: true,
    standingsCarry: "none" as const,
  };
}

let html: string | null = null;
function builderHtml(): string {
  html ??= renderToStaticMarkup(
    <DictProvider dict={enUi as Dict} locale="en">
      <DivisionBuilder competitionId="c1" orgSlug="org" compSlug="comp" sports={[BADMINTON]} recentSports={["badminton"]} viewerPlan="community" />
    </DictProvider>,
  );
  return html;
}

describe("the picked card says the max (W5 B4, F8)", () => {
  it("exactly one card - the picked one - shows 'Up to {max} entrants' with that format's max", () => {
    const page = builderHtml();
    const start = page.indexOf('data-testid="division-builder-templates"');
    const end = page.indexOf("</fieldset>", start);
    expect(start, "the card grid renders").toBeGreaterThan(-1);
    const grid = page.slice(start, end);
    // Each card is a <label data-template="key"> around its radio: the picked card is the one whose radio is checked.
    const cards = grid.split("<label").slice(1);
    const pickedCards = cards.filter((c) => /<input[^>]*name="template"[^>]*\schecked=""/.test(c));
    expect(pickedCards, "one card is picked").toHaveLength(1);
    const key = /data-template="([^"]+)"/.exec(pickedCards[0]!)![1]!;
    expect(STAGE_TEMPLATES.some((t) => t.key === key), `picked ${key} is a template`).toBe(true);
    expect(pickedCards[0], "the max line sits on the picked card").toContain('data-testid="division-builder-max-entrants"');
    // The builder opens on its opening plan, with the picked format's opening knobs for that field.
    const shown = [...grid.matchAll(/data-testid="division-builder-max-entrants"[^>]*>([^<]*)</g)].map((m) => m[1]!);
    expect(shown, "one max line, on the picked card").toHaveLength(1);
    const max = formatMaxEntrants(buildTemplateStages(key, openingKnobs(OPENING_PLAN.entrants))[0]!);
    expect(max, `${key} has a max`).not.toBeNull();
    // The number in the reader's own grouping (en: 4,096), as every other count the builder shows.
    expect(shown[0]).toBe(en["divBuilder.card.maxEntrants"]!.replace("{max}", new Intl.NumberFormat("en").format(max!)));
  });
});
