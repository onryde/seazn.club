// P9 review: verify-court-migration.ts's only failing assertion used to be
// the courts[]-shape check, which V374's own step 5 rewrite guarantees by
// construction (it either resolves an element to a uuid or drops it) — so it
// could never actually fail, and the with_label/with_id comparison that
// could reveal a genuinely incomplete backfill was log-only, no exitCode.
// `assessCourtMigrationHealth` is the fix: a pure function (no DB) so it is
// testable without a live Postgres connection, unlike the script around it.
import { describe, expect, it } from "vitest";
import { assessCourtMigrationHealth, type CourtMigrationCounts } from "../verify-court-migration";

const HEALTHY: CourtMigrationCounts = {
  venuesTotal: 3,
  courtsTotal: 7,
  fixturesCourtLabelPopulated: 40,
  fixturesCourtIdPopulated: 55, // post-cutover fixtures with no label at all
  fixturesCourtLabelWithoutId: 0,
  fixturesVenuePopulated: 12,
  fixturesVenueIdPopulated: 20,
  fixturesVenueTextWithoutId: 0,
  scheduleSettingsWithUnmigratedCourts: 0,
};

describe("assessCourtMigrationHealth", () => {
  it("is healthy when every legacy-labelled fixture also carries its backfilled id", () => {
    expect(assessCourtMigrationHealth(HEALTHY)).toEqual({ ok: true, reasons: [] });
  });

  // The falsifier for the naive count-comparison this replaces: with_id
  // (55) is already well above with_label (40) here, so a blunt
  // `with_id >= with_label` check would read this as healthy even though a
  // real row is missing its backfill — this is exactly why the check has to
  // be the per-row implication, not a total comparison.
  it("fails when a fixture carries court_label but no court_id, even though total court_id count is higher", () => {
    const counts: CourtMigrationCounts = { ...HEALTHY, fixturesCourtLabelWithoutId: 1 };
    const health = assessCourtMigrationHealth(counts);
    expect(health.ok).toBe(false);
    expect(health.reasons).toHaveLength(1);
    expect(health.reasons[0]).toMatch(/court_label but no court_id/);
  });

  it("fails when a fixture carries a free-text venue but no venue_id", () => {
    const counts: CourtMigrationCounts = { ...HEALTHY, fixturesVenueTextWithoutId: 2 };
    const health = assessCourtMigrationHealth(counts);
    expect(health.ok).toBe(false);
    expect(health.reasons[0]).toMatch(/2 fixture\(s\) carry a free-text venue/);
  });

  it("fails when a schedule_settings row still holds a pre-migration free-text court name", () => {
    const counts: CourtMigrationCounts = { ...HEALTHY, scheduleSettingsWithUnmigratedCourts: 1 };
    const health = assessCourtMigrationHealth(counts);
    expect(health.ok).toBe(false);
    expect(health.reasons[0]).toMatch(/still hold a pre-migration free-text name/);
  });

  it("collects every failing reason at once, not just the first", () => {
    const counts: CourtMigrationCounts = {
      ...HEALTHY,
      fixturesCourtLabelWithoutId: 1,
      fixturesVenueTextWithoutId: 1,
      scheduleSettingsWithUnmigratedCourts: 1,
    };
    expect(assessCourtMigrationHealth(counts).reasons).toHaveLength(3);
  });
});
