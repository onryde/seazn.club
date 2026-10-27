// Chess is individual-only (owner ruling 2026-10-26; follow-up to #1027), the builder's SECOND path to the defect:
// an organiser picks Americano on a sport that offers it, then switches Sport to Chess. The card leaves the grid
// (templatesForSport), but a pick left behind it would still POST an americano stage on Create and meet the server's
// 422 CHESS_INDIVIDUAL_ONLY after the division was made. `selectSport` resets a pick the new sport is not offered to
// league (format-templates.ts templateAfterSportChange). This drives that wiring through the real handlers — the
// template radio's and the sport select's onChange — not the pure function (review fix round 1, I1).
//
// Harness: renderIsland, as division-builder-prototype-sport.test.tsx drives the sport select. Cards are keyed by
// template key (`<label key={t.key}>`), so a radio is found by its card's key. Expected values come from the ruling
// (chess loses americano and mexicano), never from templatesForSport.
import type { ReactElement, ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { propsOf, renderIsland, walk } from "@/components/__tests__/_hook-harness";
import { DivisionBuilder, type SportOption } from "@/components/v2/division-builder";
import { STAGE_TEMPLATES } from "@/lib/format-templates";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/o/org/c/comp/d/new",
}));
vi.mock("@/components/i18n/dict-provider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/i18n/dict-provider")>()),
  useLocale: () => "en" as const,
}));

const BADMINTON: SportOption = { key: "badminton", name: "Badminton", variants: [{ key: "bwf", name: "BWF", system: true }] };
const CHESS: SportOption = { key: "boardgame", name: "Chess", variants: [{ key: "blitz", name: "Blitz", system: true }] };
const FOOTBALL: SportOption = { key: "football", name: "Football", variants: [{ key: "score", name: "Score", system: true }] };
const REFUSED_FOR_CHESS = ["americano", "mexicano"];

/** The builder, opening on `sports[0]`. */
function mount(sports: SportOption[]) {
  return renderIsland(DivisionBuilder, {
    competitionId: "c1",
    orgSlug: "org",
    compSlug: "comp",
    sports,
    constraintsAllowed: true,
    archivedSlotsExplainRefusal: false,
    viewerPlan: "community",
  });
}
type H = ReturnType<typeof mount>;

/** Every format card on screen: its template key and its radio. */
function cards(h: H): { key: string; radio: ReactElement }[] {
  const out: { key: string; radio: ReactElement }[] = [];
  for (const label of h.tree().filter((e) => e.type === "label" && typeof e.key === "string")) {
    const radio = walk((propsOf(label).children as ReactNode) ?? null).find((e) => e.type === "input" && propsOf(e).type === "radio" && propsOf(e).name === "template");
    if (radio) out.push({ key: label.key!, radio });
  }
  return out;
}
/** The keys of the cards whose radio is checked — exactly one when a pick is shown. */
const checked = (h: H): string[] => cards(h).filter((c) => propsOf(c.radio).checked === true).map((c) => c.key);

function pickTemplate(h: H, key: string): void {
  const card = cards(h).find((c) => c.key === key);
  if (!card) throw new Error(`no ${key} card on screen`);
  (propsOf(card.radio).onChange as () => void)();
}
function selectSport(h: H, from: string, to: string): void {
  const select = h.tree().find((e) => e.type === "select" && propsOf(e).value === from);
  if (!select) throw new Error(`no sport select showing ${from}`);
  (propsOf(select).onChange as (e: { target: { value: string } }) => void)({ target: { value: to } });
}

describe("the division builder: switching Sport to Chess drops an americano/mexicano pick (follow-up to #1027)", () => {
  it("harness guard: badminton renders every card, and a picked americano/mexicano is the one checked card", () => {
    for (const k of REFUSED_FOR_CHESS) {
      const h = mount([BADMINTON, CHESS]);
      expect(cards(h).map((c) => c.key)).toEqual(STAGE_TEMPLATES.map((t) => t.key));
      expect(checked(h), "the builder opens at league").toEqual(["league"]);
      pickTemplate(h, k);
      expect(checked(h), k).toEqual([k]);
    }
  });

  it("americano or mexicano picked on badminton, then Sport → Chess: the pick resets to league and the card is gone", () => {
    let checkedCases = 0;
    for (const k of REFUSED_FOR_CHESS) {
      const h = mount([BADMINTON, CHESS]);
      pickTemplate(h, k);
      selectSport(h, "badminton", "boardgame");
      const keys = cards(h).map((c) => c.key);
      for (const r of REFUSED_FOR_CHESS) expect(keys, `${k}: ${r} card`).not.toContain(r);
      expect(keys).toHaveLength(STAGE_TEMPLATES.length - REFUSED_FOR_CHESS.length);
      // Not "nothing checked behind a missing card": league is the pick, the one checked radio.
      expect(checked(h), k).toEqual(["league"]);
      checkedCases++;
    }
    expect(checkedCases).toBe(2);
  });

  it("a second switch, back to badminton, does not resurrect the dropped pick: league stays, americano/mexicano return as cards", () => {
    const h = mount([BADMINTON, CHESS]);
    pickTemplate(h, "americano");
    selectSport(h, "badminton", "boardgame");
    selectSport(h, "boardgame", "badminton");
    expect(checked(h)).toEqual(["league"]);
    for (const r of REFUSED_FOR_CHESS) expect(cards(h).map((c) => c.key)).toContain(r);
  });

  it("the positive pair: a pick the new sport IS offered survives the switch (americano, badminton → football; swiss, badminton → chess)", () => {
    const a = mount([BADMINTON, FOOTBALL]);
    pickTemplate(a, "americano");
    selectSport(a, "badminton", "football");
    expect(checked(a)).toEqual(["americano"]);
    const s = mount([BADMINTON, CHESS]);
    pickTemplate(s, "swiss");
    selectSport(s, "badminton", "boardgame");
    expect(checked(s)).toEqual(["swiss"]);
  });
});
