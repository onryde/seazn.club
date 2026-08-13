// P6 fix round 1, finding #2 (CRITICAL, addition beyond the review's literal
// 4-file list): this fixture detail PAGE has the exact same bug pattern as
// bracket.tsx/schedule.tsx/og-model.ts/slideshow-data.ts (a hardcoded-English
// msg() with no way to reach a real locale) and is explicitly named as an
// affected "fixture" surface in the finding's own text, even though the
// dispatch's file list cites og/model.ts (the OG card) for that word. Same
// bug, same fix: resolve via the org's own default_locale.
//
// generateMetadata is a plain async function (no render) — the cheapest,
// highest-confidence way to prove the fix, and it computes home/away with
// the exact same formula the default export's page body duplicates.
import { describe, expect, it, vi } from "vitest";

const getPublicFixture = vi.fn();
vi.mock("@/server/public-site/data", () => ({
  getPublicFixture: (...a: unknown[]) => getPublicFixture(...a),
}));

const baseData = (locale: string, fixtureOver: Record<string, unknown> = {}) => ({
  org: { id: "o1", name: "Test Org", slug: "test-org", branded: false, branding: {}, logo: null, about: null, default_locale: locale, card_payments: false },
  competition: { id: "c1", org_id: "o1", name: "Test Comp", slug: "test-comp", description: null, starts_on: null, ends_on: null, branding: {}, status: "active", visibility: "public" },
  division: { id: "d1", competition_id: "c1", name: "Open", slug: "open", description: null, sport_key: "generic", variant_key: "score", status: "active", module_version: "1.0.0", tiebreakers: null, sport_name: null, entrant_count: 2 },
  fixture: {
    id: "f1", division_id: "d1", stage_id: "s1", pool_id: null, round_no: 1, seq_in_round: 1,
    home_entrant_id: null, away_entrant_id: null, home_slot_label: null, away_slot_label: null,
    scheduled_at: null, venue: null, court_label: null, status: "scheduled", outcome: null, summary: null, last_seq: null,
    ...fixtureOver,
  },
  entrantNames: {},
  realtime: false,
});

const meta = async (locale: string, fixtureOver: Record<string, unknown> = {}) => {
  getPublicFixture.mockResolvedValue(baseData(locale, fixtureOver));
  const { generateMetadata } = await import("../page");
  return generateMetadata({
    params: Promise.resolve({ orgSlug: "test-org", competitionSlug: "test-comp", divisionSlug: "open", fixtureId: "f1" }),
  });
};

describe("FixturePage generateMetadata — org-locale slot labels (P6 finding #2)", () => {
  it("resolves both slots via the org's default_locale, not hardcoded English", async () => {
    const m = await meta("es", {
      home_slot_label: { key: "slot.winner_group", params: { g: "A" } },
      away_slot_label: { key: "slot.winner_group", params: { g: "B" } },
    });
    expect(m.title).toBe("Ganador del Grupo A vs Ganador del Grupo B — Open");
  });

  it("English org still reads exactly as before (back-compat)", async () => {
    const m = await meta("en", {
      home_slot_label: { key: "slot.winner_group", params: { g: "A" } },
      away_slot_label: { key: "slot.winner_group", params: { g: "B" } },
    });
    expect(m.title).toBe("Winner of Group A vs Winner of Group B — Open");
  });
});
