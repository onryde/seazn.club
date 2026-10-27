// Chess is individual-only (owner ruling 2026-10-26; follow-up to #1027): the division builder's format picker no
// longer OFFERS americano or mexicano for chess — both rotate players into pair entrants, and the server refuses the
// stage (422 CHESS_INDIVIDUAL_ONLY). The picker renders the sport's offer (format-templates.ts templatesForSport).
//
// Same plain-SSR harness as division-builder-format-picker-i18n.test.tsx: the Format tab is CSS-hidden, not
// JS-conditional, so its cards are in a renderToStaticMarkup pass. The builder starts on `sports[0]`, so each render
// names the sport it is about first. Expected cards come from the ruling (chess loses americano and mexicano) and the
// en dictionary, never from templatesForSport.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DivisionBuilder, type SportOption } from "@/components/v2/division-builder";
import { STAGE_TEMPLATES } from "@/lib/format-templates";
import { DictProvider } from "@/components/i18n/dict-provider";
import enUi from "@/dictionaries/en/ui.json";
import type { Dict } from "@/lib/i18n-constants";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/o/org/c/comp/d/new",
}));

const en = enUi as Record<string, string>;
const CHESS: SportOption = { key: "boardgame", name: "Chess", variants: [{ key: "blitz", name: "Blitz", system: true }] };
const BADMINTON: SportOption = { key: "badminton", name: "Badminton", variants: [{ key: "bwf", name: "BWF", system: true }] };
const REFUSED_FOR_CHESS = ["americano", "mexicano"];

function picker(first: SportOption): string {
  const html = renderToStaticMarkup(
    <DictProvider dict={enUi as Dict} locale="en">
      <DivisionBuilder competitionId="c1" orgSlug="org" compSlug="comp" sports={[first, first === CHESS ? BADMINTON : CHESS]} viewerPlan="community" />
    </DictProvider>,
  );
  // The picker's own card grid, bounded as division-builder-format-picker-i18n.test.tsx bounds it.
  const start = html.indexOf('class="grid gap-2 sm:grid-cols-3"');
  const end = html.indexOf('class="grid gap-4 sm:grid-cols-3"', start);
  if (start === -1 || end === -1) throw new Error("could not locate the format picker's card grid");
  return html.slice(start, end);
}

const cards = (grid: string): number => grid.split('name="template"').length - 1;
const label = (key: string): string => en[`format.template.${key}.label`]!;

describe("the division builder offers chess no americano or mexicano (follow-up to #1027)", () => {
  it("chess: every card but americano and mexicano renders, and the two are absent (counts)", () => {
    const grid = picker(CHESS);
    expect(cards(grid)).toBe(STAGE_TEMPLATES.length - REFUSED_FOR_CHESS.length);
    for (const k of REFUSED_FOR_CHESS) expect(grid, k).not.toContain(label(k));
    let shown = 0;
    for (const t of STAGE_TEMPLATES.filter((x) => !REFUSED_FOR_CHESS.includes(x.key))) {
      expect(grid, t.key).toContain(label(t.key));
      shown++;
    }
    expect(shown).toBeGreaterThanOrEqual(14);
  });

  it("the positive pair: badminton still renders every card, americano and mexicano among them", () => {
    const grid = picker(BADMINTON);
    expect(cards(grid)).toBe(STAGE_TEMPLATES.length);
    for (const k of REFUSED_FOR_CHESS) expect(grid, k).toContain(label(k));
  });

  it("the labels the test reads are distinct, so an absent card cannot hide behind another card's text", () => {
    const labels = STAGE_TEMPLATES.map((t) => label(t.key));
    for (const k of REFUSED_FOR_CHESS) {
      expect(labels.filter((l) => l.includes(label(k))), k).toEqual([label(k)]);
    }
  });
});
