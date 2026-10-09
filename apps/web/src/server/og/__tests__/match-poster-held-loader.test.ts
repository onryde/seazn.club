// W2a Task 13 (addendum 6) — the poster loader says `held` from the RAW fixture status. The match-centre document folds
// `needs_decision` into "other" beside abandoned/cancelled, so the model cannot tell a held, played match from one that
// never happened; this pins the seam from the loader's own read (class 1: the model test alone would prove a fixture).
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MatchCentreDocT } from "@/server/public-site/match-centre-schema";
import publicEn from "@/dictionaries/en/public.json";

const getPublicFixture = vi.fn();
vi.mock("@/server/public-site/data", () => ({ getPublicFixture: (...a: unknown[]) => getPublicFixture(...a) }));
vi.mock("../poster-image", () => ({ posterImageDataUrl: async () => null }));

const side = (entrantId: string, name: string) => ({ entrantId, name, short: name.slice(0, 3).toUpperCase(), colour: null, badgeUrl: null });

function data(status: string, folded: MatchCentreDocT["header"]["status"]) {
  return {
    org: { name: "Org", logo: null, branding: {}, default_locale: "en" },
    competition: { name: "Cup", branding: {} },
    division: { name: "Open" },
    stageName: "Final",
    fixture: { status, summary: null },
    matchCentre: {
      header: {
        live: false, status: folded, sides: [side("H", "Anand"), side("A", "Bela")], scoreLines: ["½", "½"], subLines: [null, null],
        battingIndex: null, statusLine: { key: `matchCentre.status.${status}` }, rateLine: null, phase: null, strength: null,
        pillNote: null, metaLine: null, updatedAt: "2026-10-09T10:00:00.000Z",
      },
      sets: null,
      cricket: null,
    },
  };
}

describe("loadMatchPosterModel — held comes from the raw status (W2a)", () => {
  beforeEach(() => getPublicFixture.mockReset());

  it("a needs_decision fixture is the held poster, with the level board and the held line", async () => {
    getPublicFixture.mockResolvedValue(data("needs_decision", "other"));
    const { loadMatchPosterModel } = await import("../match-poster-data");
    const m = (await loadMatchPosterModel("o", "c", "d", "f"))!;
    expect(m.variant).toBe("held");
    expect([m.sides[0].score, m.sides[1].score]).toEqual(["½", "½"]);
    // The public held line (ruling D-H3, read from the dictionary the poster ships with — never typed here).
    expect(m.hero).toBe((publicEn as Record<string, string>)["matchCentre.status.needs_decision"]);
    expect(m.hero, "D-H3's spectator wording, not the organiser's").not.toBe("Needs a decision");
  });

  it("the positive pair: an abandoned fixture on the same folded header stays the upcoming poster", async () => {
    getPublicFixture.mockResolvedValue(data("abandoned", "other"));
    const { loadMatchPosterModel } = await import("../match-poster-data");
    const m = (await loadMatchPosterModel("o", "c", "d", "f"))!;
    expect(m.variant).toBe("upcoming");
  });
});
