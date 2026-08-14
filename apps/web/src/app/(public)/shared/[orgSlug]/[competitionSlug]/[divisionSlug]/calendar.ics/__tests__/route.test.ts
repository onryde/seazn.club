// P6/D4b fix round 1, finding #1 (CRITICAL, owner ruling: ICS is IN scope,
// against the prompt's blanket export exemption — "a subscribed calendar
// showing 'TBD vs TBD' for the final is the exact product value TBD
// fixtures exist to deliver"). Regression: a TBD fixture (no entrant, a real
// V360/V362 slot label) that IS scheduled — pre-booking a court/time for a
// final before the semis decide who plays it is the whole point — must
// resolve its label through the org's own default_locale, not print the
// raw, hardcoded, always-English "TBD vs TBD" the route shipped with.
import { describe, expect, it, vi } from "vitest";
import type { PublicFixture, PublicEntrant } from "@/server/public-site/data";

const getPublicDivision = vi.fn();
vi.mock("@/server/public-site/data", () => ({
  getPublicDivision: (...a: unknown[]) => getPublicDivision(...a),
}));

const F = (over: Partial<PublicFixture>): PublicFixture => ({
  id: "f1",
  division_id: "d1",
  stage_id: "s1",
  pool_id: null,
  round_no: 1,
  seq_in_round: 1,
  home_entrant_id: null,
  away_entrant_id: null,
  home_slot_label: null,
  away_slot_label: null,
  scheduled_at: "2026-09-25T09:00:00.000Z",
  venue: null,
  court_label: null,
  status: "scheduled",
  outcome: null,
  summary: null,
  last_seq: null,
  ...over,
});

const ENTRANTS: PublicEntrant[] = [
  { id: "e1", division_id: "d1", kind: "individual", display_name: "Real Team", seed: 1, status: "active", members: [], team_display: null, badge_url: null },
];

const baseData = (locale: string, fixtures: PublicFixture[]) => ({
  org: { id: "o1", name: "Test Org", slug: "test-org", branded: false, branding: {}, logo: null, about: null, default_locale: locale, card_payments: false },
  competition: { id: "c1", org_id: "o1", name: "Test Comp", slug: "test-comp", description: null, starts_on: null, ends_on: null, branding: {}, status: "active", visibility: "public" as const },
  division: { id: "d1", competition_id: "c1", name: "Open", slug: "open", description: null, sport_key: "generic", variant_key: "score", status: "active", module_version: "1.0.0", tiebreakers: null, sport_name: null, entrant_count: 1 },
  stages: [],
  pools: [],
  fixtures,
  standings: [],
  entrants: ENTRANTS,
  tz: "UTC",
});

const get = async (org = "test-org", comp = "test-comp", div = "open") => {
  const { GET } = await import("../route");
  const res = await GET(new Request(`http://t/shared/${org}/${comp}/${div}/calendar.ics`), {
    params: Promise.resolve({ orgSlug: org, competitionSlug: comp, divisionSlug: div }),
  });
  return { status: res.status, text: await res.text() };
};

describe("GET .../calendar.ics — slot-label resolution (P6 finding #1)", () => {
  it("a fully-TBD but SCHEDULED fixture (pre-booked final) resolves both slot labels via the org's default_locale, not raw TBD", async () => {
    getPublicDivision.mockResolvedValue(
      baseData("en", [
        F({
          id: "final",
          home_slot_label: { key: "slot.winner_group", params: { g: "A" } },
          away_slot_label: { key: "slot.winner_group", params: { g: "B" } },
        }),
      ]),
    );
    const { status, text } = await get();
    expect(status).toBe(200);
    expect(text).toMatch(/SUMMARY:Winner of Group A vs Winner of Group B/);
    expect(text).not.toMatch(/TBD vs TBD/);
  });

  it("resolves in the ORG's own locale (es), not hardcoded English — the pattern data.ts:502-503 already uses", async () => {
    getPublicDivision.mockResolvedValue(
      baseData("es", [
        F({
          id: "final",
          home_slot_label: { key: "slot.winner_group", params: { g: "A" } },
          away_slot_label: { key: "slot.winner_group", params: { g: "B" } },
        }),
      ]),
    );
    const { text } = await get();
    expect(text).toMatch(/SUMMARY:Ganador del Grupo A vs Ganador del Grupo B/);
    expect(text).not.toMatch(/Winner of Group/);
  });

  it("a MIX of a real entrant and a TBD slot label renders both correctly in the same event", async () => {
    getPublicDivision.mockResolvedValue(
      baseData("en", [
        F({
          id: "semi-winner-vs-tbd",
          home_entrant_id: "e1",
          away_entrant_id: null,
          away_slot_label: { key: "slot.runner_up_group", params: { g: "C" } },
        }),
      ]),
    );
    const { text } = await get();
    expect(text).toMatch(/SUMMARY:Real Team vs Runner-up of Group C/);
  });

  it("no slot label at all (null) still falls back to a real localized string, never a raw literal \"TBD\" the route built itself", async () => {
    getPublicDivision.mockResolvedValue(baseData("fr", [F({ id: "mystery" })]));
    const { text } = await get();
    // fr's schedule.tbd is "À déterminer", NOT "TBD" — English's own
    // schedule.tbd happens to BE the literal string "TBD", so only a
    // non-English locale can tell the resolver's fallback apart from the
    // route's old hardcoded one. Proves the fallback goes through
    // resolveSlotLabel + the org's locale, not a hand-written "TBD" string.
    expect(text).toMatch(/SUMMARY:À déterminer vs À déterminer/);
    expect(text).not.toMatch(/SUMMARY:TBD vs TBD/);
  });
});
