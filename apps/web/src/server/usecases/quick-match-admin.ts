import "server-only";
// /admin/quick-matches (owner 2026-11-12: "do we have admin panel to match created, used or not?" / "yes build the admin
// page"): the staff view of Quick Match usage. Two reads, each asking for staff ITSELF: a Next layout does not gate the
// segments under it (node_modules/next/dist/docs/01-app/02-guides/authentication.md; review fix 3 of PR #943), so the admin
// layout's requireStaff is not a door these reads may lean on.
//
// What the page may show, and what it never shows. A guest's home link IS the key to their match, so neither read selects
// the home token (its hash or its sealed envelope), a device link, the visitor key's hash, the address typed on the setup
// form, or who saved a match: only whether one did. Side names are guest-typed text and are returned as text; the page
// renders them through React, which escapes them.
//
// The states, one definition each:
//   - played: at least one score event on any of the match's fixtures. A point and a result are both score events (the pad
//     appends both); a bye's award is written onto its fixture with none (bracket-seats.ts), so a knockout's day-one bye never
//     reads as played. Nothing else can settle a quick match's real match (it has no organizer to settle or withdraw a side),
//     and that premise is a guard: a row whose matches are decided with no event is logged by id (`brokenPremise`).
//   - decided "x of y": the guest's own "{played} of {count}" (`playedOf`, quick-match-home.ts: non-bye fixtures, and the
//     settled ones among them), so staff and the guest never read two numbers for one match.
//   - finished: every one of its matches decided (and it has at least one).
//   - saved: `saved_by_user_id` is set.
//   - expired, awaiting the sweep: unsaved and past `expires_at`. The hourly sweep (quick-match-sweep.ts) then HARD-deletes it
//     with its competition and its outbox rows, and records the deletion nowhere durable (its report goes to the cron Worker;
//     PostHog's `quick_match_created` is the only lasting trace of a create). So a swept match is in no count: every count is
//     of the matches still on record, and the page says so.
//
// The counts are a cohort: of the matches CREATED in the window (`created_at >= now - window`, inclusive), how many are in
// each state now. Set-based: one read of the cohort (30 days, the widest window) and one of all its fixtures; the state of a
// match is computed in memory from those rows, never with a query per match. The list is the same shape: one read of the
// newest rows under the filter, one of their sides, one of their fixtures.
//
// PRIVILEGED: the pooled role (quick_matches is FORCE RLS, and staff read across the one system org), as the sweep reads it.
// Every statement names the system org, found as the quick match code finds it (QUICK_MATCH_SYSTEM_ORG_ID).
import { requireStaff } from "@/lib/admin";
import { sql } from "@/lib/db";
import { QUICK_MATCH_SYSTEM_ORG_ID } from "@/lib/quick-match-constants";
import type { MatchLineRow } from "@/lib/run-sheet-groups";
import { log } from "@/server/logger";
import { playedOf } from "./quick-match-home";

const SYSTEM_ORG = QUICK_MATCH_SYSTEM_ORG_ID;
const HOUR_MS = 3600 * 1000;

/** The count windows, newest first: exact durations (never calendar days, which a DST change would stretch). */
export const QUICK_MATCH_ADMIN_WINDOWS = [
  { key: "24h", ms: 24 * HOUR_MS },
  { key: "7d", ms: 7 * 24 * HOUR_MS },
  { key: "30d", ms: 30 * 24 * HOUR_MS },
] as const;
export type QuickMatchAdminWindow = (typeof QUICK_MATCH_ADMIN_WINDOWS)[number]["key"];

/** The recent table's filters. `never`: never played. */
export const QUICK_MATCH_ADMIN_FILTERS = ["all", "played", "never", "saved"] as const;
export type QuickMatchAdminFilter = (typeof QUICK_MATCH_ADMIN_FILTERS)[number];

/** The recent table's cap: the newest this many rows under the filter. */
export const QUICK_MATCH_ADMIN_LIST_LIMIT = 100;

/** A query value as a filter; anything else (absent, unknown, repeated) is `all`. */
export function parseQuickMatchAdminFilter(raw: unknown): QuickMatchAdminFilter {
  return (QUICK_MATCH_ADMIN_FILTERS as readonly unknown[]).includes(raw) ? (raw as QuickMatchAdminFilter) : "all";
}

export interface QuickMatchAdminCounts {
  created: number;
  played: number;
  finished: number;
  saved: number;
  /** Unsaved and past its expiry, not yet deleted by the sweep. */
  expiredPending: number;
}

export interface QuickMatchAdminRow {
  /** The `quick_matches` row's id: a React key, never shown. */
  id: string;
  createdAt: Date;
  sportKey: string | null;
  format: string;
  /** The entrants' kinds (one, D2), in name order. */
  kinds: string[];
  /** Guest-typed, in the order typed (seed order). */
  sides: string[];
  decided: number;
  total: number;
  lastActivityAt: Date;
  saved: boolean;
  /** null: saved, so it never expires. */
  expiresAt: Date | null;
  locale: string;
}

export interface QuickMatchAdminList {
  rows: QuickMatchAdminRow[];
  /** More rows matched the filter than the limit: the table shows the newest `limit`. */
  capped: boolean;
}

interface ScopeOptions {
  /** TEST ONLY (never read from a request): restrict the read to these `quick_matches` ids. The system org is shared by every
   *  suite running against one database; an empty list scopes the read to nothing. */
  onlyIds?: readonly string[];
}

/** The scope fragment over `quick_matches q`: the system org, and a test's ids. */
function scopeSql(onlyIds: readonly string[] | undefined) {
  return onlyIds === undefined
    ? sql`q.org_id = ${SYSTEM_ORG}`
    : sql`q.org_id = ${SYSTEM_ORG} and q.id = any(${[...onlyIds]}::uuid[])`;
}

/** played (see the header): a score event on any fixture of the match `q`. */
function playedSql() {
  return sql`exists (
    select 1 from score_events se
      join fixtures f on f.id = se.fixture_id
      join divisions d on d.id = f.division_id
     where d.competition_id = q.competition_id)`;
}

/** finished (see the header): every match decided, and at least one. */
export function isFinished(m: { decided: number; total: number }): boolean {
  return m.total > 0 && m.decided === m.total;
}

/** Every fixture row of these competitions, by competition: ONE read, the columns `playedOf` reads. */
async function fixturesByCompetition(competitionIds: readonly string[]): Promise<Map<string, MatchLineRow[]>> {
  const out = new Map<string, MatchLineRow[]>();
  if (competitionIds.length === 0) return out;
  const rows = await sql<(MatchLineRow & { competition_id: string })[]>`
    select d.competition_id, f.status, f.outcome, f.home_entrant_id, f.away_entrant_id, f.home_slot_label, f.away_slot_label,
           f.ext_key
      from fixtures f
      join divisions d on d.id = f.division_id
     where d.org_id = ${SYSTEM_ORG} and d.competition_id = any(${[...competitionIds]}::uuid[])`;
  for (const { competition_id, ...f } of rows) out.set(competition_id, [...(out.get(competition_id) ?? []), f]);
  return out;
}

/** The guard on the played premise (see the header): rows whose matches are decided with no score event, logged by id. */
function brokenPremise(rows: readonly { id: string; played: boolean; decided: number }[]): void {
  const ids = rows.filter((r) => !r.played && r.decided > 0).map((r) => r.id);
  if (ids.length > 0) {
    log.error(
      { quickMatchIds: ids },
      "quick match admin: a match is decided with no score event; the played count's premise (every result is an event) is broken",
    );
  }
}

/** The counts per window (see the header), of the matches created in it and still on record. */
export async function quickMatchAdminCounts(
  opts: ScopeOptions & { now?: Date } = {},
): Promise<Record<QuickMatchAdminWindow, QuickMatchAdminCounts>> {
  await requireStaff();
  const now = opts.now ?? new Date();
  const widest = Math.max(...QUICK_MATCH_ADMIN_WINDOWS.map((w) => w.ms));
  const cohort = await sql<{ id: string; competition_id: string; created_at: Date; saved: boolean; expired: boolean; played: boolean }[]>`
    select q.id, q.competition_id, q.created_at,
           q.saved_by_user_id is not null as saved,
           (q.saved_by_user_id is null and q.expires_at < ${now}) as expired,
           ${playedSql()} as played
      from quick_matches q
     where ${scopeSql(opts.onlyIds)} and q.created_at >= ${new Date(now.getTime() - widest)}`;
  const fixtures = await fixturesByCompetition(cohort.map((c) => c.competition_id));
  const judged = cohort.map((c) => {
    const { played: decided, total } = playedOf(fixtures.get(c.competition_id) ?? []);
    return { ...c, decided, total, finished: isFinished({ decided, total }) };
  });
  brokenPremise(judged);

  const counts = {} as Record<QuickMatchAdminWindow, QuickMatchAdminCounts>;
  for (const w of QUICK_MATCH_ADMIN_WINDOWS) {
    const since = now.getTime() - w.ms;
    const inside = judged.filter((m) => m.created_at.getTime() >= since);
    counts[w.key] = {
      created: inside.length,
      played: inside.filter((m) => m.played).length,
      finished: inside.filter((m) => m.finished).length,
      saved: inside.filter((m) => m.saved).length,
      expiredPending: inside.filter((m) => m.expired).length,
    };
  }
  return counts;
}

/** The newest quick matches under `filter`, at most `limit` (see the header). */
export async function listQuickMatchesForAdmin(
  opts: ScopeOptions & {
    filter?: QuickMatchAdminFilter;
    /** TEST ONLY: the cap. Production passes none (QUICK_MATCH_ADMIN_LIST_LIMIT). */
    limit?: number;
  } = {},
): Promise<QuickMatchAdminList> {
  await requireStaff();
  const filter = opts.filter ?? "all";
  const limit = opts.limit ?? QUICK_MATCH_ADMIN_LIST_LIMIT;
  const filterSql =
    filter === "played"
      ? sql`and ${playedSql()}`
      : filter === "never"
        ? sql`and not ${playedSql()}`
        : filter === "saved"
          ? sql`and q.saved_by_user_id is not null`
          : sql``;
  const found = await sql<{
    id: string; competition_id: string; created_at: Date; format: string; last_activity_at: Date; expires_at: Date | null;
    locale: string; saved: boolean; played: boolean; sport_key: string | null;
  }[]>`
    select q.id, q.competition_id, q.created_at, q.format, q.last_activity_at, q.expires_at, q.locale,
           q.saved_by_user_id is not null as saved,
           ${playedSql()} as played,
           (select d.sport_key from divisions d where d.competition_id = q.competition_id order by d.id limit 1) as sport_key
      from quick_matches q
     where ${scopeSql(opts.onlyIds)} ${filterSql}
     order by q.created_at desc, q.id desc
     limit ${limit + 1}`;
  const capped = found.length > limit;
  const page = found.slice(0, limit);
  if (page.length === 0) return { rows: [], capped };

  const competitionIds = page.map((m) => m.competition_id);
  const entrants = await sql<{ competition_id: string; display_name: string; kind: string }[]>`
    select d.competition_id, e.display_name, e.kind
      from entrants e
      join divisions d on d.id = e.division_id
     where d.org_id = ${SYSTEM_ORG} and d.competition_id = any(${competitionIds}::uuid[])
     order by d.competition_id, e.seed nulls last, e.created_at, e.id`;
  const sidesOf = new Map<string, { display_name: string; kind: string }[]>();
  for (const e of entrants) sidesOf.set(e.competition_id, [...(sidesOf.get(e.competition_id) ?? []), e]);
  const fixtures = await fixturesByCompetition(competitionIds);

  const rows = page.map((m): QuickMatchAdminRow => {
    const sides = sidesOf.get(m.competition_id) ?? [];
    const { played: decided, total } = playedOf(fixtures.get(m.competition_id) ?? []);
    return {
      id: m.id,
      createdAt: m.created_at,
      sportKey: m.sport_key,
      format: m.format,
      kinds: [...new Set(sides.map((s) => s.kind))].sort(),
      sides: sides.map((s) => s.display_name),
      decided,
      total,
      lastActivityAt: m.last_activity_at,
      saved: m.saved,
      expiresAt: m.expires_at,
      locale: m.locale,
    };
  });
  brokenPremise(rows.map((r, i) => ({ id: r.id, played: page[i]!.played, decided: r.decided })));
  return { rows, capped };
}
