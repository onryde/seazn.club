// Capture record upload (spec 2026-10-12 §10, P7/Q5): the staff read of the stored records, for /admin only. The admin
// layout's `requireStaff` is the door (as for admin-fixture-config.ts); these reads take no auth of their own and run on
// the non-tenant client — capture_records is RLS FORCEd with no policy (V437).
//
// What a record shows: its ref, time, slot and code id (never the tok — no tok is stored), its received / kept / dropped
// counts and how many of the dropped were bad lines (owner ruling RL), and its KEPT lines as rows of `at`, `kind`,
// `level`, `sid` and the other fields as `key=value`. A dropped line cannot be shown: none is stored.
import { sql } from "@/lib/db";
import { CAPTURE_RECORD_REF_RE } from "@/server/api-v1/capture-schemas";

export type AdminRecordLine = { at: string; kind: string; level: string | null; sid: string | null; fields: [key: string, value: string][] };
export type AdminCaptureRecord = {
  id: string; ref: string; createdAt: Date; expiresAt: Date; slot: number; codeId: string; fixtureId: string; orgId: string;
  received: number; kept: number; dropped: number;
  /** Owner ruling RL (2026-10-12): the BAD lines among the dropped (off the allow-list or its class, unreadable, or
   *  secret-shaped) — a count only, so staff can spot a scrub leak. */
  invalid: number; sessionIds: string[]; lines: AdminRecordLine[];
};
export type AdminFixtureRecords = {
  sessions: { id: string; state: string; createdAt: Date; records: AdminCaptureRecord[] }[];
  /** The fixture's records that name no session (§10), newest first. */
  unlinked: AdminCaptureRecord[];
};

/** A ref as staff type it (trimmed, any case), or null when it is not one (P9's pattern). */
export function normaliseRecordRef(raw: string): string | null {
  const ref = raw.trim().toUpperCase();
  return CAPTURE_RECORD_REF_RE.test(ref) ? ref : null;
}

const OWN_KEYS = new Set(["at", "kind", "level", "sid"]);
/** The stored kept lines (validated on the way in, joined by "\n"; '' when every line was dropped). */
function linesOf(recordId: string, text: string): AdminRecordLine[] {
  if (text === "") return [];
  return text.split("\n").map((raw, i) => {
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      // Every stored line passed the line shape before it was written: an unparsable one is a broken invariant.
      throw new RangeError(`capture record ${recordId}: stored line ${i + 1} is not JSON`);
    }
    return {
      at: String(o.at), kind: String(o.kind),
      level: typeof o.level === "string" ? o.level : null,
      sid: typeof o.sid === "string" ? o.sid : null,
      fields: Object.entries(o).filter(([k]) => !OWN_KEYS.has(k)).map(([k, v]): [string, string] => [k, typeof v === "string" ? v : JSON.stringify(v)]),
    };
  });
}

type Row = {
  id: string; ref: string; created_at: Date; expires_at: Date; slot: number; code_id: string; fixture_id: string; org_id: string;
  received_lines: number; kept_lines: number; dropped_lines: number; invalid_lines: number; lines: string; session_ids: string[];
};
const toRecord = (r: Row): AdminCaptureRecord => ({
  id: r.id, ref: r.ref, createdAt: r.created_at, expiresAt: r.expires_at, slot: r.slot, codeId: r.code_id, fixtureId: r.fixture_id,
  orgId: r.org_id, received: r.received_lines, kept: r.kept_lines, dropped: r.dropped_lines, invalid: r.invalid_lines,
  sessionIds: r.session_ids,
  lines: linesOf(r.id, r.lines),
});
const COLUMNS = sql`
  r.id, r.ref, r.created_at, r.expires_at, r.slot, r.code_id, r.fixture_id, r.org_id, r.received_lines, r.kept_lines,
  r.dropped_lines, r.invalid_lines, r.lines,
  coalesce((select array_agg(l.session_id::text order by l.session_id::text) from capture_record_sessions l where l.record_id = r.id), '{}') as session_ids`;

/** §10: `/admin/capture-records?ref=` — the support path (operator → organiser → staff). */
export async function captureRecordByRef(raw: string): Promise<AdminCaptureRecord | null> {
  const ref = normaliseRecordRef(raw);
  if (ref === null) return null;
  const [row] = await sql<Row[]>`select ${COLUMNS} from capture_records r where r.ref = ${ref}`;
  return row ? toRecord(row) : null;
}

/** §10: `/admin/fixtures?id=` — the records beside each of the fixture's sessions (newest first), then the records
 *  that name no session. A record naming two sessions is listed under both. */
export async function captureRecordsOfFixture(fixtureId: string): Promise<AdminFixtureRecords> {
  const rows = await sql<Row[]>`select ${COLUMNS} from capture_records r where r.fixture_id = ${fixtureId} order by r.created_at desc, r.ref`;
  const records = rows.map(toRecord);
  const sessionRows = await sql<{ id: string; state: string; created_at: Date }[]>`
    select id, state, created_at from fixture_stream_sessions where fixture_id = ${fixtureId} order by created_at desc`;
  const sessions = sessionRows.map((s) => ({ id: s.id, state: s.state, createdAt: s.created_at, records: records.filter((r) => r.sessionIds.includes(s.id)) }));
  // A1 links only sessions a pairing of the fixture's code joined, so each link names one of the sessions above; a
  // record shown under none of them still has to appear somewhere, so it joins the unlinked list rather than vanish.
  const shown = new Set(sessions.flatMap((s) => s.records.map((r) => r.id)));
  return { sessions, unlinked: records.filter((r) => !shown.has(r.id)) };
}
