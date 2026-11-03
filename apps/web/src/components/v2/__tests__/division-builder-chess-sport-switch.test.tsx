// Chess is individual-only (owner ruling 2026-10-26; follow-up to #1027), the builder's SECOND path to the defect:
// an organiser picks Americano on a sport that offers it, then switches Sport to Chess. The card leaves the grid
// (templatesForSport), but a pick left behind it would still POST an americano stage on Create and meet the server's
// 422 CHESS_INDIVIDUAL_ONLY after the division was made. `selectSport` drops a pick the new sport is not offered, so the
// builder opens on the new sport's opening format (C9 review 2, n1: model.ts pickAfterChange; it used to land on a picked
// League, which the suggester never opens on). This drives that wiring through the real handlers — the template radio's
// and the sport tile's onChange — not the pure function (review fix round 1, I1).
//
// Harness: renderIsland, as division-builder-prototype-sport.test.tsx drives the sport select. Cards are keyed by
// template key (`<label key={t.key}>`), so a radio is found by its card's key. Expected values come from the ruling
// (chess loses americano and mexicano), never from templatesForSport; the format a dropped pick lands on is the one a
// FRESH builder opens on for that sport - the same component reached by its other path, never openingTemplate.
import type { ReactElement, ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { propsOf, renderIsland, walk } from "@/components/__tests__/_hook-harness";
import { DivisionBuilder, type SportOption } from "@/components/v2/division-builder";
import { STAGE_TEMPLATES } from "@/lib/format-templates";
import { engineEntrantChoice } from "@/lib/__tests__/_engine-entrant-kinds";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/o/org/c/comp/d/new",
}));
vi.mock("@/components/i18n/dict-provider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/i18n/dict-provider")>()),
  useLocale: () => "en" as const,
}));

const BADMINTON: SportOption = { key: "badminton", name: "Badminton", variants: [{ key: "bwf", name: "BWF", system: true }], entrants: engineEntrantChoice("badminton") };
const CHESS: SportOption = { key: "boardgame", name: "Chess", variants: [{ key: "blitz", name: "Blitz", system: true }], entrants: engineEntrantChoice("boardgame") };
const FOOTBALL: SportOption = { key: "football", name: "Football", variants: [{ key: "score", name: "Score", system: true }], entrants: engineEntrantChoice("football") };
const GENERIC: SportOption = { key: "generic", name: "Generic", variants: [{ key: "score", name: "Score", system: true }], entrants: engineEntrantChoice("generic") };
const REFUSED_FOR_CHESS = ["americano", "mexicano"];
// Retired from every sport's offer (owner ruling 2026-11-01, Match Day D1): triple-rr-retired.test.tsx sweeps it.
const OFFERED_KEYS = STAGE_TEMPLATES.map((t) => t.key).filter((k) => k !== "triple_rr");

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
/** A tap on the `to` sport's tile (C9 R2: the Sport step is a radio tile per sport), after checking `from` is the one
 *  picked. */
function selectSport(h: H, from: string, to: string): void {
  const radios = h.tree().filter((e) => e.type === "input" && propsOf(e).type === "radio" && propsOf(e).name === "division-sport");
  const picked = radios.filter((e) => propsOf(e).checked === true).map((e) => propsOf(e).value);
  if (picked.length !== 1 || picked[0] !== from) throw new Error(`no sport tile picked at ${from} (picked: ${picked.join(",")})`);
  const tile = radios.find((e) => propsOf(e).value === to);
  if (!tile) throw new Error(`no sport tile for ${to}`);
  (propsOf(tile).onChange as () => void)();
}

/** The card a builder opened on `sport` checks before anything is picked: where a dropped pick must land. */
function freshOpening(sport: SportOption): string {
  const c = checked(mount([sport]));
  if (c.length !== 1) throw new Error(`a fresh ${sport.key} builder checks ${c.length} cards`);
  return c[0]!;
}

describe("the division builder: switching Sport to Chess drops an americano/mexicano pick (follow-up to #1027)", () => {
  it("harness guard: badminton renders every card, and a picked americano/mexicano is the one checked card", () => {
    for (const k of REFUSED_FOR_CHESS) {
      const h = mount([BADMINTON, CHESS]);
      // Every offered card, in the order the Format step ranks them for the plan (Match Day C9), so compared as a set.
      expect(cards(h).map((c) => c.key).sort()).toEqual([...OFFERED_KEYS].sort());
      // Exactly one card checked at open (owner Q5: the top suggestion), then each pick moves it.
      expect(checked(h), "one card is checked at open").toHaveLength(1);
      pickTemplate(h, "league");
      expect(checked(h)).toEqual(["league"]);
      pickTemplate(h, k);
      expect(checked(h), k).toEqual([k]);
    }
  });

  it("americano or mexicano picked on badminton, then Sport → Chess: the pick is dropped to chess's opening format (n1) and the card is gone", () => {
    const opening = freshOpening(CHESS);
    // The witness: the old fallback (a picked League) differs from where the builder opens for chess.
    expect(opening, "premise: chess does not open on League").not.toBe("league");
    let checkedCases = 0;
    for (const k of REFUSED_FOR_CHESS) {
      const h = mount([BADMINTON, CHESS]);
      pickTemplate(h, k);
      selectSport(h, "badminton", "boardgame");
      const keys = cards(h).map((c) => c.key);
      for (const r of REFUSED_FOR_CHESS) expect(keys, `${k}: ${r} card`).not.toContain(r);
      expect(keys).toHaveLength(OFFERED_KEYS.length - REFUSED_FOR_CHESS.length);
      // Not "nothing checked behind a missing card": chess's opening is the one checked radio.
      expect(checked(h), k).toEqual([opening]);
      checkedCases++;
    }
    expect(checkedCases).toBe(2);
  });

  it("a second switch, back to badminton: the dropped pick stays dropped - each sport opens on its own opening format", () => {
    const h = mount([BADMINTON, CHESS]);
    pickTemplate(h, "americano");
    selectSport(h, "badminton", "boardgame");
    expect(checked(h)).toEqual([freshOpening(CHESS)]);
    // A pick never made again follows the sport (Q5), as an untouched builder does.
    selectSport(h, "boardgame", "badminton");
    expect(checked(h)).toEqual([freshOpening(BADMINTON)]);
    for (const r of REFUSED_FOR_CHESS) expect(cards(h).map((c) => c.key)).toContain(r);
  });

  it("the positive pair: a pick the new sport IS offered survives the switch (americano, badminton → generic; swiss, badminton → chess)", () => {
    // generic's engine model holds individuals and pairs, so it is offered americano (C9 fix round 1, I5); its untouched
    // kind is its default, individual players, which americano plays (N1).
    expect(GENERIC.entrants!.kinds).toEqual(expect.arrayContaining(["individual", "pair"]));
    expect(GENERIC.entrants!.defaultKind).toBe("individual");
    const a = mount([BADMINTON, GENERIC]);
    pickTemplate(a, "americano");
    selectSport(a, "badminton", "generic");
    expect(checked(a)).toEqual(["americano"]);
    const s = mount([BADMINTON, CHESS]);
    pickTemplate(s, "swiss");
    selectSport(s, "badminton", "boardgame");
    expect(checked(s)).toEqual(["swiss"]);
  });

  it("C9 fix round 1 (I5): a team sport drops the pick too - americano on badminton, then Sport → Football, lands on football's opening and football renders no pair format", () => {
    // The engine holds football as teams only: an americano stage has no individual players to rotate.
    expect(FOOTBALL.entrants!.kinds).not.toContain("individual");
    const opening = freshOpening(FOOTBALL);
    expect(opening, "premise: football does not open on League").not.toBe("league");
    const h = mount([BADMINTON, FOOTBALL]);
    pickTemplate(h, "americano");
    selectSport(h, "badminton", "football");
    expect(checked(h)).toEqual([opening]);
    for (const r of REFUSED_FOR_CHESS) expect(cards(h).map((c) => c.key), r).not.toContain(r);
  });
});
