// The presence SHADOW REPORT (check-in capacity plan 1, T9): proves that webhook presence agrees with the seat's own vendor reads.
// It is what the staging gate (plan 1, Task 12 step 5) runs; `closedByEnded` and the strict exit code are read there.
//
//   node --experimental-strip-types scripts/presence-shadow-report.ts --since <iso-with-Z-or-offset> --fixture <uuid> [--fixture <uuid> ...] [--strict]
//   node --experimental-strip-types scripts/presence-shadow-report.ts --since-hours 6 --fixture <uuid>     (default 24 h; --since wins)
//
// It needs DATABASE_URL (and DB_SCHEMA, default seazn_club; DATABASE_SSL=disable|require). Read-only: it only selects, in ONE
// `repeatable read` transaction set `read only` with a 30 s statement timeout, so the three selects see one snapshot and cannot hang a
// production table. `--since` must carry a timezone (Z or an offset): a bare timestamp would be read as the operator's LOCAL time.
//
// WHAT IT COMPARES. Every PLAYER seat in scope whose camera the seat's own read found on (`fixture_video_participants.last_publisher_seen_at
// >= since`) against the webhook rows: `covered` is a seat for which a `source='webhook'` row was OPEN at the seat's stamp (arrived no later than
// SHADOW_ARRIVAL_TOLERANCE_MS after it; `left_at` null or after it). A row is the seat's when it names the seat's participant, or names
// none and carries the seat's person id as its custom id on the seat's side (the readers' rule, presence.ts `currentPresence`). `missing` are
// the seats no such row covers; `open` the presence rows still open at report time; `closedByEnded` the rows closed only by meeting.ended
// (a participantLeft that never arrived, or a reload's old peer the vendor never reported leaving): measured and printed, never gated by
// the exit code. It is split by kind: `endedWhileNewest` (the row was its participant's newest peer: still in the room when the meeting
// ended) and `endedSuperseded` (a newer row of the same participant exists in the meeting: a reload's old peer the vendor never reported
// leaving, the R4 risk). `joinLatencyMs` ({p50, p95, n}: received_at - joined_at over the scope's webhook rows, nearest-rank) and `noEcho` (webhook
// rows stored with no participant: our customParticipantId did not echo back) are spec §6.8 step 3's numbers for owner ruling R4; printed,
// never gated. ANY closed-by-end row (`closedByEnded` > 0, either kind) prints `blocksProofFlag: true` and a note: it blocks turning
// EXTERNAL_PLAY_PRESENCE_PROOF on until every counted row is explained and recorded (owner ruling 2026-11-17, plan 1 Task 12 step 5), which
// is a separate decision from this script's exit code. The split is information: the note names how many rows of each kind there are.
//
// --strict needs at least one --fixture (exit 2 without: the gate reads a named round, never every fixture in the window), and exits 1 when `verified === 0` (an empty run is a failure, never a pass), or `missing` or `open` is non-empty. It is meant for a
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
  /** of closedByEnded: rows that were their participant's newest peer in the meeting (still in the room at the end) */
  endedWhileNewest: number;
  /** of closedByEnded: rows a newer row of the same participant (custom id) in the same meeting superseded (a reload's old peer) */
  endedSuperseded: number;
  /** join -> webhook latency over the scope's webhook rows (received_at - joined_at, ms, nearest-rank); null percentiles when n is 0 */
  joinLatencyMs: { p50: number | null; p95: number | null; n: number };
  /** webhook rows in scope stored with no participant (the vendor did not echo our customParticipantId) */
  noEcho: number;
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

  // One pass over the scope's rows: the end count, and the spec §6.8 step 3 numbers (join latency on OUR receipt clock against the
  // vendor's joinedAt, nearest-rank percentiles; and how many webhook rows stored no participant, i.e. their customParticipantId did not
  // echo back to a participant on file).
  // An ended row is SUPERSEDED when a newer row (the presence order: joined_at, received_at, seq) of the same participant (its custom
  // id) exists in the same meeting: a reload's old peer the vendor never reported leaving, the R4 risk. Otherwise it was its
  // participant's newest peer, still in the room when the meeting ended. A row with no joined_at compares as no newer and is newest.
  const [agg] = await db<{ ended: number; ended_superseded: number; no_echo: number; lat_n: number; lat_p50: number | null; lat_p95: number | null }[]>`
    select count(*) filter (where left_by = 'ended')::int as ended,
           count(*) filter (where left_by = 'ended' and exists (
             select 1 from fixture_video_presence n
              where n.meeting_id = x.meeting_id
                and n.custom_participant_id = x.custom_participant_id
                and (n.joined_at, n.received_at, n.seq) > (x.joined_at, x.received_at, x.seq)))::int as ended_superseded,
           count(*) filter (where source = 'webhook' and participant_id is null)::int as no_echo,
           count(*) filter (where source = 'webhook' and joined_at is not null)::int as lat_n,
           (percentile_disc(0.5) within group (order by round(extract(epoch from (received_at - joined_at)) * 1000))
             filter (where source = 'webhook' and joined_at is not null))::int as lat_p50,
           (percentile_disc(0.95) within group (order by round(extract(epoch from (received_at - joined_at)) * 1000))
             filter (where source = 'webhook' and joined_at is not null))::int as lat_p95
      from fixture_video_presence x
     where x.received_at >= ${scope.since}
       and (${ids}::uuid[] is null or x.fixture_id = any(${ids}::uuid[]))`;

  return {
    verified: seats.length,
    covered: seats.filter((s) => s.covered).length,
    missing: seats.filter((s) => !s.covered).map((s) => ({ fixtureId: s.fixture_id, side: s.side, participantId: s.participant_id, seenAt: s.seen_at })),
    open: open.map((o) => ({ meetingId: o.meeting_id, peerId: o.peer_id, participantId: o.participant_id, source: o.source, receivedAt: o.received_at })),
    closedByEnded: agg.ended,
    endedWhileNewest: agg.ended - agg.ended_superseded,
    endedSuperseded: agg.ended_superseded,
    joinLatencyMs: { p50: agg.lat_p50, p95: agg.lat_p95, n: agg.lat_n },
    noEcho: agg.no_echo,
  };
}

const USAGE =
  "Usage: --since <iso, ending in Z or an offset> | --since-hours <n> (default 24; --since wins)  [--fixture <uuid> ...]  [--strict]";
/** A full ISO timestamp WITH a zone. `new Date("2026-11-17T08:30:00")` is the operator's local time and `new Date("2026-11-17")` is UTC:
 *  the gate's window must never depend on which machine ran it, so neither is accepted. */
const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/i;
/** Printed with `blocksProofFlag: true`; never changes the exit code. The split says WHICH kind of closed-by-end row it is; it does not
 *  change whether the flag is set (any such row does). */
const proofFlagNote = (r: { closedByEnded: number; endedWhileNewest: number; endedSuperseded: number }): string =>
  `closedByEnded > 0 (${r.closedByEnded}: endedWhileNewest ${r.endedWhileNewest}, endedSuperseded ${r.endedSuperseded}): any row closed only by meeting.ended blocks turning EXTERNAL_PLAY_PRESENCE_PROOF on until every counted row is explained and recorded beside the baseline (plan 1 Task 12 step 5; owner ruling 2026-11-17). The split says which kind: endedWhileNewest is a peer still in the room when the meeting ended (a participantLeft that never arrived), endedSuperseded is a reload's old peer the vendor did not report leaving (owner ruling R4's risk). Not a failure of this run: the exit code is unchanged.`;
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
        if (!ISO_WITH_ZONE.test(v)) return { error: "--since needs a full ISO timestamp ending in Z or an offset (such as 2026-11-17T08:30:00Z); a bare timestamp is local time." };
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
  // The gate reads a NAMED round: an unscoped --strict would pass or fail on every fixture in the window (another round, a test's).
  if (strict && fixtureIds.length === 0) return { error: "--strict needs at least one --fixture <uuid> (the gate reads a named round)." };
  return { since, hours, fixtureIds, strict };
}

/** The CLI body, exported for the test. Prints the report as JSON in ONE `out` call; returns the exit code. */
export async function run(
  argv: readonly string[],
  deps: { sql: postgres.Sql; out?: (line: string) => void; now?: () => Date },
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
  let report: ShadowReport;
  try {
    // ONE snapshot, read only, bounded: a failure to connect, a refused read-only write or a timeout all land in the catch below.
    report = await deps.sql.begin("isolation level repeatable read", async (tx) => {
      await tx`set transaction read only`;
      await tx`set local statement_timeout = '30s'`;
      return shadowReportSql(tx, { since, fixtureIds });
    });
  } catch (e) {
    out(`Could not read presence: ${oneLine(e, [])}`);
    return 2;
  }
  const blocksProofFlag = report.closedByEnded > 0;
  const note = blocksProofFlag ? proofFlagNote(report) : null;

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
        blocksProofFlag,
        ...(note !== null ? { note } : {}),
        ...(args.strict ? { strict: { pass: reasons.length === 0, reasons } } : {}),
      },
      null,
      2,
    ),
  );
  return args.strict && reasons.length > 0 ? 1 : 0;
}

/** One line, no stack, no secret: the first line of the error's message prefixed by its code, with any `secrets` (the connection URL) blanked. */
function oneLine(e: unknown, secrets: readonly string[]): string {
  const err = e as { code?: unknown; message?: unknown; name?: unknown } | null;
  let msg = String(err?.message ?? e).split("\n")[0].trim();
  for (const s of secrets) if (s) msg = msg.split(s).join("<DATABASE_URL>");
  const code = typeof err?.code === "string" ? err.code : typeof err?.name === "string" ? err.name : "";
  return code && !msg.includes(code) ? `${code}: ${msg}` : msg;
}

async function main(): Promise<number> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error(`DATABASE_URL is not set. ${USAGE}`);
    return 2;
  }
  try {
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
      await sql.end({ timeout: 5 });
    }
  } catch (e) {
    // a malformed DATABASE_URL throws at construction; its message can echo the URL (and its password): never print it
    console.error(`Could not read presence: ${oneLine(e, [url])}`);
    return 2;
  }
}

if (isMainModule(import.meta.url)) {
  process.exitCode = await main();
}
