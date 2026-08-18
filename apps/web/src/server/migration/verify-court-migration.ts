// V374 (P9 pass 1) post-migration verification — READ ONLY, writes nothing.
// This is NOT a second migration mechanism (the write lives solely in
// db/migration/deltas/V374__court_entities_cutover.sql, run once by Flyway);
// it re-derives the same counts the migration's own dry-run RAISE NOTICE
// printed and logs them via pino so they survive past the migration's
// terminal output, and doubles as an ongoing health check.
//
// P9 review: the courts[]-shape check below is real but GUARANTEED by
// construction — V374's own step 5 rewrite either resolves every stored
// `courts[]` element to a uuid or drops it, so no code path this migration
// ships can ever leave a non-uuid element behind. It can never actually
// fail, so it caught nothing a regression could trip. `assessCourtMigrationHealth`
// is the assertion that CAN fail: it checks the per-row IMPLICATION the
// backfill promises (`court_label is not null` -> `court_id is not null`,
// and the `venue`/`venue_id` sibling), not merely comparing the two totals
// (which a coincidental cancellation could pass while individual rows are
// still missing their backfill) — a fixture created AFTER the cutover can
// legitimately carry `court_id` with no `court_label` at all (P9 stopped
// writing it), so `with_id >= with_label` alone is neither necessary nor
// sufficient; "no label-carrying row is missing its id" is the actual
// invariant the migration exists to hold.
//
// pino lives only in apps/web/package.json (absent from the repo root, and
// scripts/backfill-pass-credit-redemptions.ts's own header notes root
// scripts/ "cannot import from apps/web/src/lib" server-only code) — so
// unlike scripts/check-rls.ts (which is deliberately console-based, root
// precedent for a read-only DB verification script), this one lives inside
// apps/web where pino resolves. Self-contained (relative/bare imports only,
// no `@/` alias — same reason as apps/web/src/lib/i18n-dict-utils.ts) so it
// runs standalone under plain `node --experimental-strip-types`, same as the
// root scripts.
//
//   cd apps/web && node --env-file-if-exists=.env.local \
//     --experimental-strip-types src/server/migration/verify-court-migration.ts
//   npm run db:verify-court-migration   # same thing, from apps/web
import postgres from "postgres";
import pino from "pino";

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

const log = pino({ name: "db.court-migration-verify", level: process.env.LOG_LEVEL ?? "info" });

const url = process.env.DATABASE_URL;
if (!url) {
  log.error("DATABASE_URL is not set.");
  process.exit(1);
}

const SCHEMA = process.env.DB_SCHEMA ?? "seazn_club";
const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
const sql = postgres(url, {
  connection: { search_path: SCHEMA },
  ssl: process.env.DATABASE_SSL === "disable" ? false : isLocal ? false : "require",
  prepare: !url.includes(":6543"),
  max: 1,
});

try {
  const [venues] = await sql<{ n: number }[]>`select count(*)::int as n from venues`;
  const [courts] = await sql<{ n: number }[]>`select count(*)::int as n from courts`;
  const [fixturesCourt] = await sql<{ with_label: number; with_id: number; label_without_id: number }[]>`
    select count(*) filter (where court_label is not null)::int as with_label,
           count(*) filter (where court_id is not null)::int    as with_id,
           count(*) filter (where court_label is not null and court_id is null)::int as label_without_id
      from fixtures`;
  const [fixturesVenue] = await sql<{ with_text: number; with_id: number; text_without_id: number }[]>`
    select count(*) filter (where venue is not null)::int    as with_text,
           count(*) filter (where venue_id is not null)::int as with_id,
           count(*) filter (where venue is not null and venue_id is null)::int as text_without_id
      from fixtures`;
  // A stored courts[] entry that is not uuid-shaped means some row never
  // went through the migration's rewrite — see the header on why this
  // specific check can never actually fire.
  const [unmigrated] = await sql<{ n: number }[]>`
    select count(*)::int as n
      from schedule_settings ss
     where jsonb_typeof(ss.config -> 'courts') = 'array'
       and exists (
         select 1 from jsonb_array_elements_text(ss.config -> 'courts') as elem
          where elem !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       )`;

  const counts: CourtMigrationCounts = {
    venuesTotal: venues!.n,
    courtsTotal: courts!.n,
    fixturesCourtLabelPopulated: fixturesCourt!.with_label,
    fixturesCourtIdPopulated: fixturesCourt!.with_id,
    fixturesCourtLabelWithoutId: fixturesCourt!.label_without_id,
    fixturesVenuePopulated: fixturesVenue!.with_text,
    fixturesVenueIdPopulated: fixturesVenue!.with_id,
    fixturesVenueTextWithoutId: fixturesVenue!.text_without_id,
    scheduleSettingsWithUnmigratedCourts: unmigrated!.n,
  };

  log.info({ event: "court_migration_verified", ...counts }, "V374 court migration verification");

  const health = assessCourtMigrationHealth(counts);
  if (!health.ok) {
    log.warn({ reasons: health.reasons, ...counts }, "V374 court migration verification found an incomplete backfill");
    process.exitCode = 1;
  }
} catch (err) {
  log.error({ err }, "court migration verification failed");
  process.exitCode = 1;
} finally {
  await sql.end();
}
