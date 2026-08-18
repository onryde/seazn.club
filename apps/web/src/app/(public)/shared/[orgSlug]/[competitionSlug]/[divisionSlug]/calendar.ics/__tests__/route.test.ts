// P6/D4b fix round 1, finding #1 (CRITICAL, owner ruling: ICS is IN scope,
// against the prompt's blanket export exemption — "a subscribed calendar
// showing 'TBD vs TBD' for the final is the exact product value TBD
// fixtures exist to deliver"). Regression: a TBD fixture (no entrant, a real
// V360/V362 slot label) that IS scheduled — pre-booking a court/time for a
// final before the semis decide who plays it is the whole point — must
// resolve its label through the org's own default_locale, not print the
// raw, hardcoded, always-English "TBD vs TBD" the route shipped with.
import { describe, expect, it, vi } from "vitest";
import type { PublicFixture, PublicEntrant, PublicCompetition } from "@/server/public-site/data";

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

const E = (over: Partial<PublicEntrant>): PublicEntrant => ({
  id: "e1",
  division_id: "d1",
  kind: "individual",
  display_name: "Entrant",
  seed: 1,
  status: "active",
  members: [],
  team_display: null,
  badge_url: null,
  ...over,
});

const baseData = (
  locale: string,
  fixtures: PublicFixture[],
  // F4 wave B: day-one fixture tests anchor the tentative all-day event to
  // the competition's dates, so the helper needs to override them per test.
  competitionOverrides: Partial<Pick<PublicCompetition, "starts_on" | "ends_on">> = {},
  entrants: PublicEntrant[] = ENTRANTS,
) => ({
  org: { id: "o1", name: "Test Org", slug: "test-org", branded: false, branding: {}, logo: null, about: null, default_locale: locale, card_payments: false },
  competition: { id: "c1", org_id: "o1", name: "Test Comp", slug: "test-comp", description: null, starts_on: null, ends_on: null, branding: {}, status: "active", visibility: "public" as const, ...competitionOverrides },
  division: { id: "d1", competition_id: "c1", name: "Open", slug: "open", description: null, sport_key: "generic", variant_key: "score", status: "active", module_version: "1.0.0", tiebreakers: null, sport_name: null, entrant_count: 1 },
  stages: [],
  pools: [],
  fixtures,
  standings: [],
  entrants,
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

describe("GET .../calendar.ics — day-one fixtures (F4 wave B)", () => {
  // Same shape as P6's pre-booked-final fixture above: no entrant on either
  // side, a real V360/V362 slot label, and now also unscheduled — the case
  // the route used to filter out entirely.
  const unscheduledFinal = (over: Partial<PublicFixture> = {}): PublicFixture =>
    F({
      id: "fix-final",
      scheduled_at: null,
      home_entrant_id: null,
      away_entrant_id: null,
      home_slot_label: { key: "slot.winner_group", params: { g: "A" } },
      away_slot_label: { key: "slot.runner_up_group", params: { g: "B" } },
      venue: null,
      court_label: null,
      ...over,
    });

  it("an unscheduled fixture becomes a tentative all-day event on the competition's last day", async () => {
    getPublicDivision.mockResolvedValue(
      baseData("en", [unscheduledFinal()], { starts_on: "2026-09-01", ends_on: "2026-09-13" }),
    );
    const { text } = await get();
    expect(text).toContain("DTSTART;VALUE=DATE:20260913");
    expect(text).toContain("STATUS:TENTATIVE");
    expect(text).toContain("Winner of Group A vs Runner-up of Group B");
  });

  it("falls back to starts_on when the competition has no end date", async () => {
    getPublicDivision.mockResolvedValue(
      baseData("en", [unscheduledFinal()], { starts_on: "2026-09-01", ends_on: null }),
    );
    const { text } = await get();
    expect(text).toContain("DTSTART;VALUE=DATE:20260901");
  });

  it("skips an unscheduled fixture when the competition has no dates at all", async () => {
    getPublicDivision.mockResolvedValue(
      baseData("en", [unscheduledFinal()], { starts_on: null, ends_on: null }),
    );
    const { text } = await get();
    // No anchor date exists, so no defensible DTSTART exists either. Emitting
    // a VEVENT with a guessed date is worse than omitting it.
    expect(text).not.toContain("BEGIN:VEVENT");
  });

  it("REGRESSION: the UID is byte-identical before and after the fixture resolves", async () => {
    const uidOf = (s: string) => s.split("\r\n").find((l) => l.startsWith("UID:"));

    getPublicDivision.mockResolvedValue(
      baseData("en", [unscheduledFinal()], { starts_on: "2026-09-01", ends_on: "2026-09-13" }),
    );
    const before = (await get()).text;

    // Same fixture id, now drawn and scheduled.
    getPublicDivision.mockResolvedValue(
      baseData(
        "en",
        [
          F({
            id: "fix-final",
            scheduled_at: "2026-09-13T14:00:00.000Z",
            home_entrant_id: "e1",
            away_entrant_id: "e2",
            home_slot_label: null,
            away_slot_label: null,
            venue: null,
            court_label: null,
          }),
        ],
        { starts_on: "2026-09-01", ends_on: "2026-09-13" },
        [E({ id: "e1", display_name: "Lions" }), E({ id: "e2", display_name: "Tigers", seed: 2 })],
      ),
    );
    const after = (await get()).text;

    // A subscribed calendar is the one surface where getting this wrong is
    // not recoverable by a redeploy: a changed UID arrives as a SECOND event
    // beside a stale copy, in calendars we no longer control.
    expect(uidOf(before)).toBe("UID:fix-final@seazn.club");
    expect(uidOf(after)).toBe(uidOf(before));
    expect(after).toContain("DTSTART:20260913T140000Z");
    expect(after).toContain("Lions vs Tigers");
  });

  // Owner ruling (F4 wave B, not in the task brief): STATUS:TENTATIVE is
  // invisible in several major calendar clients, so a bare all-day event
  // would otherwise read as "on that whole day" rather than "date not fixed
  // yet". The description is prefixed with a localized string to say so.
  it("the tentative event's DESCRIPTION carries the localized time-to-be-confirmed copy (en)", async () => {
    getPublicDivision.mockResolvedValue(
      baseData("en", [unscheduledFinal()], { starts_on: "2026-09-01", ends_on: "2026-09-13" }),
    );
    const { text } = await get();
    expect(text).toContain("Time to be confirmed");
  });

  it("resolves the time-to-be-confirmed copy in the ORG's locale (fr), not hardcoded English", async () => {
    getPublicDivision.mockResolvedValue(
      baseData("fr", [unscheduledFinal()], { starts_on: "2026-09-01", ends_on: "2026-09-13" }),
    );
    const { text } = await get();
    expect(text).toContain("Heure à confirmer");
    expect(text).not.toContain("Time to be confirmed");
  });
});
