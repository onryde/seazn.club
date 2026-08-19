// The PURE half of V374's post-migration health check, in its own module with
// NO side effects.
//
// It used to live beside the executable script, which at module scope opens a
// Postgres connection, runs five queries, and calls `process.exit(1)` when
// DATABASE_URL is unset. Importing the helper therefore RAN the script: a
// vitest worker with no DATABASE_URL was killed mid-run, and against a
// database whose backfill was incomplete the import set `process.exitCode = 1`
// and turned a fully passing suite into a non-zero exit. A unit test importing
// a pure function must not be able to do either.

export interface CourtMigrationCounts {
  venuesTotal: number;
  courtsTotal: number;
  fixturesCourtLabelPopulated: number;
  fixturesCourtIdPopulated: number;
  fixturesCourtLabelWithoutId: number;
  fixturesVenuePopulated: number;
  fixturesVenueIdPopulated: number;
  fixturesVenueTextWithoutId: number;
  scheduleSettingsWithUnmigratedCourts: number;
}

export interface CourtMigrationHealth {
  ok: boolean;
  reasons: string[];
}

/**
 * Pure — no DB, no I/O — so it is unit-testable without a live Postgres
 * connection, unlike the script around it. Every reason here is a
 * FALSIFIABLE assertion the counts either satisfy or do not; `ok` is false
 * the moment any of them fails.
 */
export function assessCourtMigrationHealth(counts: CourtMigrationCounts): CourtMigrationHealth {
  const reasons: string[] = [];
  if (counts.fixturesCourtLabelWithoutId > 0) {
    reasons.push(
      `${counts.fixturesCourtLabelWithoutId} fixture(s) carry court_label but no court_id — the step-6 backfill missed them`,
    );
  }
  if (counts.fixturesVenueTextWithoutId > 0) {
    reasons.push(
      `${counts.fixturesVenueTextWithoutId} fixture(s) carry a free-text venue but no venue_id — the fixture-venue-migration backfill missed them`,
    );
  }
  if (counts.scheduleSettingsWithUnmigratedCourts > 0) {
    reasons.push(
      `${counts.scheduleSettingsWithUnmigratedCourts} schedule_settings row(s) still hold a pre-migration free-text name in courts[]`,
    );
  }
  return { ok: reasons.length === 0, reasons };
}
