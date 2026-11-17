// The presence SHADOW REPORT (check-in capacity plan 1, T9): proves that webhook presence agrees with the seat's own vendor reads.
// It is what the staging gate (plan 1, Task 12 step 5) runs; `closedByEnded` and the strict exit code are read there.
//
//   node --experimental-strip-types scripts/presence-shadow-report.ts --since <iso> --fixture <uuid> [--fixture <uuid> ...] [--strict]
//   node --experimental-strip-types scripts/presence-shadow-report.ts --since-hours 6 --fixture <uuid>     (default 24 h; --since wins)
//
// It needs DATABASE_URL (and DB_SCHEMA, default seazn_club; DATABASE_SSL=disable|require). Read-only: it only selects.
//
// WHAT IT COMPARES. Every PLAYER seat in scope whose camera the seat's own read found on (`fixture_video_participants.last_publisher_seen_at
// >= since`) against the webhook rows: `covered` is a seat for which a `source='webhook'` row was OPEN at the seat's stamp (arrived no later than
// SHADOW_ARRIVAL_TOLERANCE_MS after it; `left_at` null or after it). A row is the seat's when it names the seat's participant, or names
// none and carries the seat's person id as its custom id on the seat's side (the readers' rule, presence.ts `currentPresence`). `missing` are
// the seats no such row covers; `open` the presence rows still open at report time; `closedByEnded` the rows closed only by meeting.ended
// (a participantLeft that never arrived, or a reload's old peer the vendor never reported leaving): measured and printed, never gated.
//
// --strict exits 1 when `verified === 0` (an empty run is a failure, never a pass), or `missing` or `open` is non-empty. It is meant for a
// QUIESCENT scope (every meeting in it ended); run mid-round, `open` lists the live peers and the operator reads it rather than gating on it.
// Exit codes: 0 done (or strict and clean), 1 strict and not clean, 2 usage or configuration.
//
// THE COPY. A root script runs under nodenext and cannot import apps/web/src (`@/` does not resolve; scripts/stripe-connect-fixture.ts's
// header), so `shadowReportSql` is a COPY of apps/web/src/server/external-play/video/presence.ts `presenceShadowReport`. The two cannot drift
// unnoticed: apps/web/src/server/usecases/external-play/__tests__/presence-shadow.test.ts runs both against one seed that exercises every
// arm and compares the whole report. Change one, change the other. The load harness (Task 10c) imports `shadowReportSql` by relative path.
// Relative or bare imports only, never `@/`; `main` runs only under isMainModule.
import type postgres from "postgres";
import { isMainModule } from "./lib/main-module.ts";

type AnySql = postgres.Sql | postgres.TransactionSql;
type Side = "home" | "away";

/** Copy of presence.ts SHADOW_ARRIVAL_TOLERANCE_MS (the test pins the two equal): a webhook landing this long after the seat's stamp
 *  still counts, as plan 2's presence path would have seated the player before its fallback fired (spec §6.3). */
export const SHADOW_ARRIVAL_TOLERANCE_MS = 10_000;

export type ShadowScope = { since: Date; fixtureIds?: readonly string[] };
export type ShadowReport = {
  verified: number;
  covered: number;
  missing: { fixtureId: string; side: Side; participantId: string; seenAt: Date }[];
  open: { meetingId: string; peerId: string; participantId: string | null; source: "webhook" | "read"; receivedAt: Date }[];
  closedByEnded: number;
};

/** The report's SQL, a copy of presence.ts `presenceShadowReport` (see the header). */
export async function shadowReportSql(db: AnySql, scope: ShadowScope): Promise<ShadowReport> {
  // null = no fixture filter; an empty list is an empty scope (`= any('{}')` matches nothing), never "everything".
  const ids = scope.fixtureIds === undefined ? null : [...scope.fixtureIds];

  const seats = await db<{ fixture_id: string; side: Side; participant_id: string; seen_at: Date; covered: boolean }[]>`
    select p.fixture_id, p.side, p.participant_id, p.last_publisher_seen_at as seen_at,
           exists (
             select 1 from fixture_video_presence w
              where w.fixture_id = p.fixture_id
                and (w.participant_id = p.participant_id
                  or (w.participant_id is null and w.side = p.side and w.custom_participant_id = p.person_id::text))
                and w.source = 'webhook'
                and w.received_at <= p.last_publisher_seen_at + (${SHADOW_ARRIVAL_TOLERANCE_MS}::int * interval '1 millisecond')
                and (w.left_at is null or w.left_at > p.last_publisher_seen_at)
           ) as covered
      from fixture_video_participants p
     where p.preset = 'player'
       and p.last_publisher_seen_at >= ${scope.since}
       and (${ids}::uuid[] is null or p.fixture_id = any(${ids}::uuid[]))
     order by p.last_publisher_seen_at, p.participant_id`;

  const open = await db<{ meeting_id: string; peer_id: string; participant_id: string | null; source: "webhook" | "read"; received_at: Date }[]>`
    select meeting_id, peer_id, participant_id, source, received_at
      from fixture_video_presence
     where left_at is null
       and received_at >= ${scope.since}
       and (${ids}::uuid[] is null or fixture_id = any(${ids}::uuid[]))
     order by received_at, seq`;

  const [ended] = await db<{ n: number }[]>`
    select count(*)::int as n
      from fixture_video_presence
     where left_by = 'ended'
       and received_at >= ${scope.since}
       and (${ids}::uuid[] is null or fixture_id = any(${ids}::uuid[]))`;

  return {
    verified: seats.length,
    covered: seats.filter((s) => s.covered).length,
    missing: seats.filter((s) => !s.covered).map((s) => ({ fixtureId: s.fixture_id, side: s.side, participantId: s.participant_id, seenAt: s.seen_at })),
    open: open.map((o) => ({ meetingId: o.meeting_id, peerId: o.peer_id, participantId: o.participant_id, source: o.source, receivedAt: o.received_at })),
    closedByEnded: ended.n,
  };
}

const USAGE =
  "Usage: --since <iso> | --since-hours <n> (default 24; --since wins)  [--fixture <uuid> ...]  [--strict]";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_HOURS = 24;

type Parsed = { since: Date | null; hours: number; fixtureIds: string[]; strict: boolean } | { error: string };

function parseArgs(argv: readonly string[]): Parsed {
  let since: Date | null = null;
  let hours = DEFAULT_HOURS;
  const fixtureIds: string[] = [];
  let strict = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--strict") {
      strict = true;
    } else if (a === "--since" || a === "--since-hours" || a === "--fixture") {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) return { error: `${a} needs a value.` };
      if (a === "--since") {
        const d = new Date(v);
        if (Number.isNaN(d.getTime())) return { error: "--since is not a date." };
        since = d;
      } else if (a === "--since-hours") {
        const n = Number(v);
        if (!Number.isFinite(n) || n <= 0) return { error: "--since-hours must be a positive number." };
        hours = n;
      } else {
        if (!UUID.test(v)) return { error: "--fixture must be a uuid." };
        fixtureIds.push(v.toLowerCase());
      }
    } else {
      return { error: `Unknown argument ${a}.` };
    }
  }
  return { since, hours, fixtureIds, strict };
}

/** The CLI body, exported for the test. Prints the report as JSON in ONE `out` call; returns the exit code. */
export async function run(
  argv: readonly string[],
  deps: { sql: AnySql; out?: (line: string) => void; now?: () => Date },
): Promise<number> {
  const out = deps.out ?? ((l: string) => console.log(l));
  const args = parseArgs(argv);
  if ("error" in args) {
    out(`${args.error} ${USAGE}`);
    return 2;
  }
  const now = (deps.now ?? (() => new Date()))();
  const since = args.since ?? new Date(now.getTime() - args.hours * 3_600_000);
  // No --fixture is an unscoped run (every fixture), which is what the operator wants mid-investigation; an explicit list is the gate's.
  const fixtureIds = args.fixtureIds.length > 0 ? args.fixtureIds : undefined;
  const report = await shadowReportSql(deps.sql, { since, fixtureIds });

  const reasons: string[] = [];
  if (report.verified === 0) reasons.push("verified 0: no seat in scope read a camera on, so there is nothing to compare (an empty run is a failure)");
  if (report.missing.length > 0) reasons.push(`${report.missing.length} verified seat(s) had no open webhook row at their stamp`);
  if (report.open.length > 0) reasons.push(`${report.open.length} presence row(s) still open`);
  out(
    JSON.stringify(
      {
        since: since.toISOString(),
        fixtureIds: fixtureIds ?? null,
        ...report,
        ...(args.strict ? { strict: { pass: reasons.length === 0, reasons } } : {}),
      },
      null,
      2,
    ),
  );
  return args.strict && reasons.length > 0 ? 1 : 0;
}

async function main(): Promise<number> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error(`DATABASE_URL is not set. ${USAGE}`);
    return 2;
  }
  const { default: pg } = await import("postgres");
  const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  const sslEnv = process.env.DATABASE_SSL;
  const sql = pg(url, {
    connection: { search_path: process.env.DB_SCHEMA ?? "seazn_club" },
    ssl: sslEnv === "disable" ? false : sslEnv === "require" ? "require" : isLocal ? false : "require",
    prepare: !url.includes(":6543"),
    max: 1,
  });
  try {
    return await run(process.argv.slice(2), { sql });
  } finally {
    await sql.end();
  }
}

if (isMainModule(import.meta.url)) {
  process.exitCode = await main();
}
