// buildPublicDivisionSlides (PROMPT-64 public /present) — pure, no DB.
import { describe, expect, it } from "vitest";
import { buildPublicDivisionSlides } from "../slideshow-data";
import type { FixtureSlideItem } from "../slideshow-data";

const input = {
  division: { id: "d1", name: "Open" },
  stages: [
    { id: "sg", kind: "group", name: "Groups" },
    { id: "sk", kind: "knockout", name: "Knockout" },
  ],
  pools: [{ id: "pA", stage_id: "sg", name: "Pool A" }],
  fixtures: [
    { id: "k1", stage_id: "sk", round_no: 0, seq_in_round: 1, home_entrant_id: "e1", away_entrant_id: "e2", status: "in_play", summary: { headline: "1–0" } },
    { id: "k2", stage_id: "sk", round_no: 0, seq_in_round: 2, home_entrant_id: "e3", away_entrant_id: "e4", status: "scheduled", summary: null },
    { id: "kf", stage_id: "sk", round_no: 1, seq_in_round: 1, home_entrant_id: null, away_entrant_id: null, status: "scheduled", summary: null },
  ],
  standings: [
    { stage_id: "sg", pool_id: "pA", rows: [
      { entrantId: "e1", played: 3, won: 3, drawn: 0, lost: 0, points: 9, rank: 1 },
      { entrantId: "e2", played: 3, won: 0, drawn: 0, lost: 3, points: 0, rank: 2 },
    ] },
  ],
  entrants: [
    { id: "e1", display_name: "Mexico" }, { id: "e2", display_name: "Canada" },
    { id: "e3", display_name: "Japan" }, { id: "e4", display_name: "Ghana" },
  ],
};

describe("buildPublicDivisionSlides", () => {
  it("builds standings + pinned in-play + upcoming + bracket slides", () => {
    const slides = buildPublicDivisionSlides(input);
    const kinds = slides.map((s) => s.kind);
    expect(kinds).toEqual(["standings", "fixtures", "fixtures", "bracket"]);
    expect(slides[0]).toMatchObject({ caption: "Groups — Pool A" });
    expect(slides[1]).toMatchObject({ title: "In play", pinned: true });
    const bracket = slides[3] as { fixtures: { home: string | null }[] };
    expect(bracket.fixtures[0]).toMatchObject({ home: "Mexico", line: "1–0" });
  });

  it("skips the bracket slide when the knockout shape doesn't lay out", () => {
    const slides = buildPublicDivisionSlides({
      ...input,
      // three round-0 matches, nothing after: not a power-of-two field
      fixtures: [1, 2, 3].map((i) => ({
        id: `x${i}`, stage_id: "sk", round_no: 0, seq_in_round: i,
        home_entrant_id: "e1", away_entrant_id: "e2", status: "scheduled",
        summary: null,
      })),
    });
    expect(slides.some((s) => s.kind === "bracket")).toBe(false);
  });

  it("no live matches ⇒ no pinned slide", () => {
    const slides = buildPublicDivisionSlides({
      ...input,
      fixtures: input.fixtures.map((f) => ({ ...f, status: "scheduled", summary: null })),
    });
    expect(slides.every((s) => !("pinned" in s) || s.pinned !== true)).toBe(true);
  });
});

// P6 fix round 1, finding #2 (CRITICAL): this is the public /present
// slideshow — the ONLY thing standing between a visitor and English slot
// labels regardless of the org's own default_locale. Both slide KINDS that
// can show an unfilled slot (fixtures AND bracket) must resolve through it.
describe("buildPublicDivisionSlides — orgLocale (P6 finding #2)", () => {
  const withLabel = {
    ...input,
    fixtures: [
      ...input.fixtures.slice(0, 2),
      {
        id: "kf", stage_id: "sk", round_no: 1, seq_in_round: 1,
        home_entrant_id: null, away_entrant_id: null, status: "scheduled",
        summary: null,
        home_slot_label: { key: "slot.winner_group", params: { g: "A" } },
        away_slot_label: { key: "slot.winner_group", params: { g: "B" } },
      },
    ],
  };

  it("a fixtures-kind slide resolves an unfilled slot in the org's own locale, not English", () => {
    const slides = buildPublicDivisionSlides({ ...withLabel, orgLocale: "es" });
    const upcoming = slides.find((s) => s.kind === "fixtures" && s.title === "Coming up");
    expect(upcoming?.kind).toBe("fixtures");
    const items = (upcoming as { items: FixtureSlideItem[] }).items;
    const kf = items.find((i) => i.round === 1)!;
    expect(kf.home).toBe("Ganador del Grupo A");
    expect(kf.away).toBe("Ganador del Grupo B");
  });

  it("a bracket-kind slide ALSO resolves the unfilled slot (was left null for the client to guess at)", () => {
    const slides = buildPublicDivisionSlides({ ...withLabel, orgLocale: "es" });
    const bracket = slides.find((s) => s.kind === "bracket") as {
      fixtures: { id: string; home: string | null; away: string | null }[];
    };
    const kf = bracket.fixtures.find((f) => f.id === "kf")!;
    expect(kf.home).toBe("Ganador del Grupo A");
    expect(kf.away).toBe("Ganador del Grupo B");
  });

  it("omitting orgLocale defaults to English — back-compat with every existing caller", () => {
    const slides = buildPublicDivisionSlides(withLabel); // no orgLocale field at all
    const upcoming = slides.find((s) => s.kind === "fixtures" && s.title === "Coming up");
    const items = (upcoming as { items: FixtureSlideItem[] }).items;
    const kf = items.find((i) => i.round === 1)!;
    expect(kf.home).toBe("Winner of Group A");
  });
});
