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

// RS008 review fix #2 — the anonymous public kiosk (/shared/{org}/{comp}/
// present) had NO masking at all, not even by youth: buildDivisionSlides
// (the AUTHED /slideshow/competitions/[id] twin) already masked by both
// youth and consent, but this "pure public twin" never did. Standings slides
// are the simplest surface to prove the `names` map on (see
// buildDivisionSlides — consent masking, slideshow-data-locale.test.ts, for
// the DB-backed sibling of this same fix on the authed builder).
describe("buildPublicDivisionSlides — consent masking (RS008 review fix #2)", () => {
  it("masks a non-team entrant's name when opted_out is true, even on a non-youth division", () => {
    const slides = buildPublicDivisionSlides({
      ...input,
      entrants: [
        { id: "e1", display_name: "Arun Kumar", kind: "individual", opted_out: true },
        { id: "e2", display_name: "Dev Patel", kind: "individual", opted_out: false },
        { id: "e3", display_name: "Japan", kind: "individual" },
        { id: "e4", display_name: "Ghana", kind: "individual" },
      ],
    });
    const standings = slides.find((s) => s.kind === "standings") as { rows: { name: string }[] };
    // Per-entrant, not blanket: e2 (not opted out) stays full.
    expect(standings.rows.map((r) => r.name)).toEqual(["Arun K.", "Dev Patel"]);
  });

  it("never masks a TEAM's own name, even when opted_out is (incorrectly) true", () => {
    const slides = buildPublicDivisionSlides({
      ...input,
      entrants: [
        { id: "e1", display_name: "Thunder Strikers", kind: "team", opted_out: true },
        { id: "e2", display_name: "Dev Patel", kind: "individual" },
        { id: "e3", display_name: "Japan", kind: "individual" },
        { id: "e4", display_name: "Ghana", kind: "individual" },
      ],
    });
    const standings = slides.find((s) => s.kind === "standings") as { rows: { name: string }[] };
    expect(standings.rows.map((r) => r.name)).toContain("Thunder Strikers");
  });

  it("masks by division youth policy alone, with no explicit opt-out", () => {
    const slides = buildPublicDivisionSlides({
      ...input,
      division: { ...input.division, youth: true },
      entrants: [
        { id: "e1", display_name: "Arun Kumar", kind: "individual" },
        { id: "e2", display_name: "Dev Patel", kind: "individual" },
        { id: "e3", display_name: "Japan", kind: "individual" },
        { id: "e4", display_name: "Ghana", kind: "individual" },
      ],
    });
    const standings = slides.find((s) => s.kind === "standings") as { rows: { name: string }[] };
    expect(standings.rows.map((r) => r.name)).toEqual(["Arun K.", "Dev P."]);
  });

  it("omitting kind/opted_out/youth entirely never masks — back-compat with every existing caller/test", () => {
    // The base `input` fixture (top of file) predates this fix and sets none
    // of kind/opted_out/youth/player_name_display anywhere.
    const slides = buildPublicDivisionSlides(input);
    const standings = slides.find((s) => s.kind === "standings") as { rows: { name: string }[] };
    expect(standings.rows.map((r) => r.name)).toEqual(["Mexico", "Canada"]);
  });
});
