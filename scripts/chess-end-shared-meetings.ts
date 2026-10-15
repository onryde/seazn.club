// One-off deploy step for V448 (db/migration/deltas/V448__video_meeting_per_player.sql; chess in-page board and camera
// design, docs/superpowers/specs/2026-10-09-chess-in-page-board-and-camera-design.md §5.6.7).
//
// Before D16 a board had ONE RealtimeKit meeting shared by both players. V448 gives every player a meeting of their own
// and DROPS the shared rows. A shared meeting whose row has `ended_at is null` is still ACTIVE at the vendor and its
// tokens stay valid until they expire: dropping the row would orphan it and nothing would ever end it. So V448's first
// two statements are a table lock and a guard that RAISES while any such row exists, and this script is what clears
// them: it ends every row with `ended_at is null` at the vendor (kick everyone, then INACTIVE - the two calls
// `endMeeting` makes, realtimekit.ts), one row at a time, each in its own try, and stamps the row ended.
//
// Run it against the environment BEFORE migrating it, until it reports zero failed and the delta then applies:
//
//   node --env-file-if-exists=apps/web/.env.local --experimental-strip-types \
//     scripts/chess-end-shared-meetings.ts --dry-run          # lists what it would end, calls nothing
//   node --env-file-if-exists=apps/web/.env.local --experimental-strip-types \
//     scripts/chess-end-shared-meetings.ts                    # ends them
//
// It needs DATABASE_URL and that environment's RealtimeKit credentials (CLOUDFLARE_ACCOUNT_ID, REALTIMEKIT_API_TOKEN,
// REALTIMEKIT_APP_ID; REALTIMEKIT_BASE_URL only for a fixture). It prints how many it found, ended and failed, and
// exits 1 if any failed (so a deploy script stops), 2 if it could not start. It is safe to run twice: a row it has
// stamped is not found again, and a row that failed stays unended and is retried.
//
// Why this is not `endMeeting`: the script runs against the schema BEFORE V448, and `endMeeting` stamps its rows through
// the per-player columns (`side`) that do not exist yet - it would end the room at the vendor and then fail to record
// it, leaving the guard to raise for ever. The two vendor calls are the same (scripts and the adapter are held to it by
// the script's test, which drives both against the RealtimeKit fixture and compares); the stamp is schema-neutral.
//
// It REFUSES to run once V448 is applied. After the delta a row is one player's live room, and ending "every unended
// row" would end rooms people are playing in. A vendor meeting that no longer exists (RealtimeKit's documented 404 on
// the INACTIVE call) is already ended: the row is stamped and counted as gone, because the guard would otherwise
// refuse the deploy for ever over a room nobody can join.
//
// It makes two vendor calls per row, one row at a time, and does NOT spend the platform's call budget (budget.ts: that
// bucket belongs to the app serving traffic, not to a one-off). A vendor 429 is a failure like any other: the row stays
// unended and the next run takes it. With hundreds of rows, run it in more than one go.
//
// NEVER against a production database from a branch that has not shipped V448's code, and never without the owner's
// word: it is a one-off for the environment the controller names (stg). No secret is printed: failures carry the
// vendor's status and path, never a token or a response body.
import type postgres from "postgres";
import { isMainModule } from "./lib/main-module.ts";

type Sql = postgres.Sql;

/** The vendor, as this script needs it: end one meeting. Resolves with `gone` when the vendor has no such meeting. */
export type Vendor = { endMeeting(meetingId: string): Promise<{ gone: boolean }> };

export type Failure = { meetingId: string; fixtureId: string; message: string };

export type Report = {
  /** Rows with `ended_at is null` when the run began. */
  found: number;
  ended: number;
  /** Of `ended`: the vendor had already lost the meeting (404 on INACTIVE). */
  gone: number;
  failed: number;
  failures: Failure[];
  /** V448 is already applied: nothing was touched. */
  refused: boolean;
  dryRun: boolean;
};

const EMPTY: Report = { found: 0, ended: 0, gone: 0, failed: 0, failures: [], refused: false, dryRun: false };

/** Process exit code for a report: 0 clean, 1 a row failed or the script refused (a deploy must stop on either). */
export function exitCodeOf(r: Report): number {
  return r.failed > 0 || r.refused ? 1 : 0;
}

/** RealtimeKit's documented not-found body: `{ success: false, error: { code: 404 } }`. Anything else that is a 404 (a
 *  gateway "no route", an HTML page, a wrong base URL) is an answer the script cannot read - not "already gone". */
function isRealtimeKitNotFound(body: unknown): boolean {
  if (typeof body !== "object" || body === null) return false;
  const b = body as { success?: unknown; error?: { code?: unknown } | null };
  return b.success === false && typeof b.error === "object" && b.error !== null && Number(b.error.code) === 404;
}

const TIMEOUT_MS = 15_000;
const CF_BASE = "https://api.cloudflare.com/client/v4";

/** The vendor from the environment, or the names of what is missing (never their values). */
export function vendorFromEnv(
  env: Record<string, string | undefined>,
  doFetch: typeof fetch = fetch,
): { vendor: Vendor } | { missing: string[] } {
  const missing = ["CLOUDFLARE_ACCOUNT_ID", "REALTIMEKIT_API_TOKEN", "REALTIMEKIT_APP_ID"].filter((k) => !env[k]);
  if (missing.length > 0) return { missing };
  const base = (env.REALTIMEKIT_BASE_URL ?? CF_BASE).replace(/\/$/, "");
  const prefix = `${base}/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/realtime/kit/${env.REALTIMEKIT_APP_ID}`;
  const call = async (method: string, path: string, body?: unknown) => {
    let res: Response;
    try {
      res = await doFetch(`${prefix}${path}`, {
        method,
        headers: { Authorization: `Bearer ${env.REALTIMEKIT_API_TOKEN}`, "Content-Type": "application/json", Accept: "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      // The transport error can quote the URL; the message names the call and nothing else.
      throw new Error(`RealtimeKit ${method} ${path} did not complete`);
    }
    return res;
  };
  return {
    vendor: {
      async endMeeting(meetingId) {
        const id = encodeURIComponent(meetingId);
        // Everyone out. A 404 is "nobody is in it" (or no such meeting) and is not a failure: the INACTIVE call below
        // is the one that decides whether the meeting exists.
        const kick = await call("POST", `/meetings/${id}/active-session/kick-all`);
        if (!kick.ok && kick.status !== 404) throw new Error(`RealtimeKit POST /meetings/${id}/active-session/kick-all failed with ${kick.status}`);
        const off = await call("PATCH", `/meetings/${id}`, { status: "INACTIVE" });
        if (off.ok) return { gone: false };
        if (off.status === 404 && (await off.json().then(isRealtimeKitNotFound, () => false))) return { gone: true };
        throw new Error(`RealtimeKit PATCH /meetings/${id} failed with ${off.status}`);
      },
    },
  };
}

/** Whether the schema is already per player (V448 applied): a meeting row then has a `side`. */
async function isPerPlayer(sql: Sql): Promise<boolean> {
  const [row] = await sql<{ n: number }[]>`
    select count(*)::int as n from information_schema.columns
     where table_schema = current_schema() and table_name = 'fixture_video_meetings' and column_name = 'side'`;
  return (row?.n ?? 0) > 0;
}

/** Ends every shared meeting that is still unended. `vendor` is called once per row, in order, each in its own try. */
export async function endSharedMeetings(
  sql: Sql,
  vendor: Vendor,
  opts: { dryRun?: boolean; log?: (line: string) => void } = {},
): Promise<Report> {
  const log = opts.log ?? (() => undefined);
  const dryRun = opts.dryRun === true;
  if (await isPerPlayer(sql)) {
    log("REFUSED: this database already has V448's per-player meetings. A row here is one player's live room; this script ends the SHARED rooms the delta refuses, and would end rooms people are playing in.");
    return { ...EMPTY, refused: true, dryRun };
  }
  const rows = await sql<{ fixtureId: string; meetingId: string }[]>`
    select fixture_id as "fixtureId", meeting_id as "meetingId"
      from fixture_video_meetings where ended_at is null order by created_at, fixture_id`;
  const report: Report = { ...EMPTY, found: rows.length, dryRun, failures: [] };
  for (const row of rows) {
    if (dryRun) {
      log(`WOULD END: fixture=${row.fixtureId} meeting=${row.meetingId}`);
      continue;
    }
    try {
      const { gone } = await vendor.endMeeting(row.meetingId);
      // The vendor has ended it (or never had it): record that, and the arbiters' watches of the room with it - one
      // transaction, schema-neutral (no per-player column). A row someone stamped meanwhile is left as it is.
      await sql.begin(async (tx) => {
        await tx`update fixture_video_meetings set ended_at = now() where meeting_id = ${row.meetingId} and ended_at is null`;
        await tx`
          update fixture_video_participants set removed_at = now()
           where fixture_id = ${row.fixtureId} and preset = 'arbiter' and removed_at is null`;
      });
      report.ended += 1;
      if (gone) report.gone += 1;
      log(`ENDED: fixture=${row.fixtureId} meeting=${row.meetingId}${gone ? " (already gone at the vendor)" : ""}`);
    } catch (err) {
      report.failed += 1;
      const message = err instanceof Error ? err.message : "unknown error";
      report.failures.push({ meetingId: row.meetingId, fixtureId: row.fixtureId, message });
      log(`FAILED: fixture=${row.fixtureId} meeting=${row.meetingId} - ${message}. The row stays unended; run the script again.`);
    }
  }
  return report;
}

async function main(): Promise<number> {
  const dryRun = process.argv.includes("--dry-run");
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set.");
    return 2;
  }
  const built = vendorFromEnv(process.env);
  if ("missing" in built && !dryRun) {
    console.error(`RealtimeKit is not configured: ${built.missing.join(", ")} must be set.`);
    return 2;
  }
  const vendor: Vendor =
    "vendor" in built
      ? built.vendor
      : {
          endMeeting() {
            throw new Error("unreachable in a dry run");
          },
        };
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
    console.log(dryRun ? "DRY RUN: nothing will be ended." : "Ending every shared video meeting that is still unended.");
    const r = await endSharedMeetings(sql, vendor, { dryRun, log: (l) => console.log(l) });
    console.log("\n--- summary ---");
    console.log(`Unended shared meetings found: ${r.found}`);
    if (!r.refused && !dryRun) console.log(`Ended: ${r.ended} (already gone at the vendor: ${r.gone})\nFailed: ${r.failed}`);
    if (r.failed > 0) console.error("\nSome meetings were not ended. V448 will refuse to apply while they exist; fix the cause and run again.");
    return exitCodeOf(r);
  } finally {
    await sql.end();
  }
}

if (isMainModule(import.meta.url)) {
  process.exitCode = await main();
}
