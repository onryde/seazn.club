// V368 (P9 pass 1) post-migration verification — READ ONLY, writes nothing.
// This is NOT a second migration mechanism (the write lives solely in
// db/migration/deltas/V368__court_entities_cutover.sql, run once by Flyway);
// it re-derives the same counts the migration's own dry-run RAISE NOTICE
// printed and logs them via pino so they survive past the migration's
// terminal output, and doubles as an ongoing health check (the last query
// below should always read zero — a non-zero means some stored
// schedule_settings.config.courts[] still holds a pre-migration free-text
// name, i.e. the read-path trap this migration exists to close has reopened).
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
  const [fixturesCourt] = await sql<{ with_label: number; with_id: number }[]>`
    select count(*) filter (where court_label is not null)::int as with_label,
           count(*) filter (where court_id is not null)::int    as with_id
      from fixtures`;
  const [fixturesVenue] = await sql<{ with_text: number; with_id: number }[]>`
    select count(*) filter (where venue is not null)::int    as with_text,
           count(*) filter (where venue_id is not null)::int as with_id
      from fixtures`;
  // Health check: a stored courts[] entry that is not uuid-shaped means some
  // row never went through the migration's rewrite — should always be 0.
  const [unmigrated] = await sql<{ n: number }[]>`
    select count(*)::int as n
      from schedule_settings ss
     where jsonb_typeof(ss.config -> 'courts') = 'array'
       and exists (
         select 1 from jsonb_array_elements_text(ss.config -> 'courts') as elem
          where elem !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       )`;

  log.info(
    {
      event: "court_migration_verified",
      venuesTotal: venues!.n,
      courtsTotal: courts!.n,
      fixturesCourtLabelPopulated: fixturesCourt!.with_label,
      fixturesCourtIdPopulated: fixturesCourt!.with_id,
      fixturesVenuePopulated: fixturesVenue!.with_text,
      fixturesVenueIdPopulated: fixturesVenue!.with_id,
      scheduleSettingsWithUnmigratedCourts: unmigrated!.n,
    },
    "V368 court migration verification",
  );

  if (unmigrated!.n > 0) {
    log.warn(
      { scheduleSettingsWithUnmigratedCourts: unmigrated!.n },
      "found schedule_settings rows whose courts[] still holds a pre-migration free-text name",
    );
    process.exitCode = 1;
  }
} catch (err) {
  log.error({ err }, "court migration verification failed");
  process.exitCode = 1;
} finally {
  await sql.end();
}
