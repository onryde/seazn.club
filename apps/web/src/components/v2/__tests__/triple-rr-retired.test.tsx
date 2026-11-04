// Owner ruling 2026-11-01 (Match Day D1, legs Option A): the "Triple round robin" template is no longer offered — not by
// the division builder's picker for any sport, not by the Format dialog for a division that is not already one.
// The server keeps legs up to 8 (Jul3/08), and a division STORED as a triple round robin keeps showing what it is, picked,
// and a format save keeps its legs as they are: hidden from the offer, never clamped.
// FMT5 moved the second half with Settings › Format to the Division rules card's Format dialog: the offer is the page's
// (d/[divSlug]/__tests__/format-card-wiring.test.tsx) and the stored-and-kept case the dialog's
// (components/v2/rules/__tests__/division-format.test.tsx). This file keeps the builder's half.
//
// Expected values come from the ruling (the retired key is `triple_rr`; chess also loses americano and mexicano, owner
// ruling 2026-10-26) and the en dictionary, never from templatesForSport. Every registered sport is swept.
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { builtinModules } from "@seazn/engine/sports";
import { DictProvider } from "@/components/i18n/dict-provider";
import { DivisionBuilder, type SportOption } from "@/components/v2/division-builder";
import { STAGE_TEMPLATES } from "@/lib/format-templates";
import enUi from "@/dictionaries/en/ui.json";
import type { Dict } from "@/lib/i18n-constants";
import { engineEntrantChoice } from "@/lib/__tests__/_engine-entrant-kinds";

const { apiV1Mock } = vi.hoisted(() => ({ apiV1Mock: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/o/org/c/comp/d/new",
}));
vi.mock("@/lib/client-v1", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/client-v1")>()),
  apiV1: apiV1Mock,
}));

beforeEach(() => {
  apiV1Mock.mockReset();
  apiV1Mock.mockResolvedValue({});
});

const RETIRED = "triple_rr";
const CHESS = "boardgame";
const REFUSED_FOR_CHESS = ["americano", "mexicano"];
const en = enUi as Record<string, string>;
const RETIRED_LABEL = en[`format.template.${RETIRED}.label`]!;

/** The builder's format picker card grid, as division-builder-chess-formats.test.tsx bounds it. */
function builderGrid(sportKey: string): string {
  const sport: SportOption = { key: sportKey, name: sportKey, variants: [{ key: "v", name: "V", system: true }], entrants: engineEntrantChoice(sportKey) };
  const html = renderToStaticMarkup(
    <DictProvider dict={enUi as Dict} locale="en">
      <DivisionBuilder competitionId="c1" orgSlug="org" compSlug="comp" sports={[sport]} viewerPlan="community" />
    </DictProvider>,
  );
  const start = html.indexOf('data-testid="division-builder-templates"');
  const end = html.indexOf("</fieldset>", start);
  if (start === -1 || end === -1) throw new Error("could not locate the format picker's card grid");
  return html.slice(start, end);
}

describe("the division builder offers no Triple round robin, for any sport (owner ruling 2026-11-01)", () => {
  it("premise: the label the sweep looks for is the template's, and no other card's label contains it", () => {
    expect(RETIRED_LABEL).toBe("Triple round robin");
    const others = STAGE_TEMPLATES.filter((t) => t.key !== RETIRED).map((t) => en[`format.template.${t.key}.label`]!);
    expect(others.filter((l) => l.includes(RETIRED_LABEL))).toEqual([]);
  });

  it("every registered sport: the card is absent and every other card the sport is offered renders (counts)", () => {
    let swept = 0;
    let cardsSeen = 0;
    for (const m of builtinModules) {
      const grid = builderGrid(m.key);
      expect(grid, m.key).not.toContain(RETIRED_LABEL);
      // Chess (owner ruling 2026-10-26) and every sport whose ENGINE entrant model holds no individuals (C9 fix round 1,
      // I5; round 3's rule - the both-kinds check picks the same sports, by format-templates.test.ts's registry
      // invariant) are offered no pair format.
      const kinds = engineEntrantChoice(m.key).kinds as readonly string[];
      const refused = m.key === CHESS || !kinds.includes("individual") || !kinds.includes("pair") ? REFUSED_FOR_CHESS : [];
      const cards = grid.split('name="template"').length - 1;
      expect(cards, m.key).toBe(STAGE_TEMPLATES.length - 1 - refused.length);
      cardsSeen += cards;
      swept++;
    }
    expect(swept).toBe(builtinModules.length);
    expect(swept).toBeGreaterThanOrEqual(11);
    expect(cardsSeen).toBeGreaterThan(0);
  });
});
