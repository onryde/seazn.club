import "server-only";
// server/sponsors/report.ts — R4 sponsors on stream, S13: the Sponsors hub's Overview numbers and the shareable report
// link (spec 2026-10-27 §4, §5.1, §5.2, §7). S14 extends this file with the public report (`sponsorReport`), which reads the
// same rules.
//
// THE NUMBERS (the money-facing figures a club shows its sponsors; controller addenda 2026-11-01):
//   - Times shown  = how many airings started in the period, scene airings included. An OPEN airing (ended_at null, still on
//                    air or its session not closed yet) is a showing. "Skipped before start" never makes a row (S8).
//   - On screen    = Σ (ended_at − started_at) over CLOSED airings only. An open airing adds nothing: SQL's own null rule
//                    (the difference is null, and `greatest(null, 0)` is 0) — it is never measured to `now`. A row whose end is
//                    before its start (no writer makes one, but the table has no check) adds 0, never a negative.
//   - Link clicks  = count(*) of `sponsor_clicks` in the period, every source. `sponsors.click_count` is NOT read: it is an
//                    all-time counter that predates the click rows and cannot be cut to a period. Clicks are not people — the
//                    /s/ route drops automated previews and repeat taps inside 30 s (S10), nothing more.
//   - Viewer impressions / peak viewers = null until Y1 (YouTube Connect's viewer table) fills them.
//   - The PERIOD (lib/sponsor-report.ts): half-open UTC windows from `now` for "This year" / "Last 30 days"; "One competition"
//     is every airing and click whose FIXTURE is in it, with no time bound, so a click with no fixture is not counted there.
//   - A DELETED sponsor (R16, Review Focus 4): its airings survive with sponsor_id null and their `sponsor_name` snapshot, so it
//     keeps a row under that name with no sponsor id (no link can be made for it). Its clicks went with it (V483: sponsor_clicks
//     cascade), so its link clicks are UNKNOWN — null, shown as a dash — never a false zero.
//
// THE LINK (spec §4, §5.2): 32 random bytes, base64url, shown ONCE as `/r/sponsor/<token>`; only sha256(token) is stored. The raw
// token is returned from `createReportLink` and is in no row, no log line and no other answer. Create, revoke and the list are
// EDITOR-ONLY (R19: owner / admin); the Overview is read by every member.
//
// TENANCY: every call checks the caller's org is the path's (the routes' door checks membership of the PATH org, so this is the
// line that stops one org's credential naming another), then reads under `withTenant` (RLS) and filters org_id as well. The
// database checks no cross-org reference (V483 has no composite foreign keys), so the sponsor and competition a link names are
// checked to be this org's here.
import { createHash, randomBytes } from "node:crypto";
import type postgres from "postgres";
import { withTenant, type Tx } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { mayHoldBearerCredential } from "@/lib/types";
import { assertUuid, type AuthCtx } from "@/server/api-v1/auth";
import { ENDS_BEFORE_STARTS } from "@/server/api-v1/schemas";
import {
  isIsoDay,
  isoDay,
  periodWindow,
  reportLinkPath,
  timeWindow,
  windowDates,
  type ReportLinkDefaults,
  type ReportLinkSummary,
  type SponsorOverviewRow,
  type SponsorPeriod,
} from "@/lib/sponsor-report";

export type { ReportLinkDefaults, ReportLinkSummary, SponsorOverviewRow, SponsorPeriod };

/** sha256 over the token's UTF-8: what `sponsor_report_links.token_hash` holds, and what S14 looks a visitor's token up by. */
export function hashReportToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

/** Spec §4: "Token: 32 random bytes". base64url, so it sits in a path segment as is (43 characters). */
const TOKEN_BYTES = 32;

function assertOrg(auth: AuthCtx, orgId: string): void {
  if (auth.orgId !== orgId) throw new HttpError(404, "organization not found");
}

/** R19: only an editor (owner / admin) may create, revoke or list report links - a link is a bearer credential to a
 *  sponsor's numbers, so the house rule for who may hold one (`mayHoldBearerCredential`, lib/types.ts) decides. An API key
 *  resolves role null and is refused here too (the routes never admit one: NEVER_KEY_ROUTES). */
function assertEditor(auth: AuthCtx): void {
  if (!mayHoldBearerCredential(auth.role)) throw new HttpError(403, "Insufficient permissions");
}

async function assertCompetition(tx: Tx, orgId: string, competitionId: string): Promise<void> {
  assertUuid(competitionId, "competition");
  const [row] = await tx`select 1 from competitions where id = ${competitionId} and org_id = ${orgId}`;
  if (!row) throw new HttpError(404, "competition not found");
}

/**
 * One row per sponsor of the org (in a competition period: the org-wide sponsors and that competition's own), tier-ranked as
 * every sponsor list here is, then one row per DELETED sponsor that aired in the period, by name. Every member may read it
 * (R19: read-only for viewers). `now` places the time windows; nothing here reads the clock.
 */
export async function sponsorOverview(auth: AuthCtx, orgId: string, p: SponsorPeriod, now: Date): Promise<SponsorOverviewRow[]> {
  assertOrg(auth, orgId);
  const window = periodWindow(p, now);
  const competitionId = p.kind === "competition" ? p.competitionId : null;
  return withTenant(orgId, async (tx) => {
    if (competitionId !== null) await assertCompetition(tx, orgId, competitionId);
    // THE period predicate, once, for both tables: half-open [from, to) on the row's time, or the row's fixture in the
    // competition (a null fixture is never `in` it).
    const inPeriod = (time: postgres.Fragment, fixture: postgres.Fragment) =>
      window !== null
        ? tx`${time} >= ${window.from} and ${time} < ${window.to}`
        : tx`${fixture} in (select f.id from fixtures f join divisions d on d.id = f.division_id where d.competition_id = ${competitionId})`;
    const listed = competitionId === null ? tx`true` : tx`(s.competition_id is null or s.competition_id = ${competitionId})`;
    const rows = await tx<{ sponsor_id: string | null; name: string; shown: number; on_ms: number; clicks: number | null }[]>`
      with air as (
        select a.sponsor_id,
               case when a.sponsor_id is null then a.sponsor_name end as gone_name,
               count(*)::int as shown,
               (coalesce(sum(greatest(extract(epoch from (a.ended_at - a.started_at)), 0)), 0) * 1000)::float8 as on_ms
          from sponsor_airings a
         where a.org_id = ${orgId} and ${inPeriod(tx`a.started_at`, tx`a.fixture_id`)}
         group by 1, 2
      ), clk as (
        select c.sponsor_id, count(*)::int as clicks
          from sponsor_clicks c
         where c.org_id = ${orgId} and ${inPeriod(tx`c.at`, tx`c.fixture_id`)}
         group by 1
      )
      select sponsor_id, name, shown, on_ms, clicks from (
        select s.id as sponsor_id, s.name, coalesce(air.shown, 0)::int as shown, coalesce(air.on_ms, 0)::float8 as on_ms,
               coalesce(clk.clicks, 0)::int as clicks,
               0 as gone, array_position(array['title','gold','silver','partner'], s.tier) as rank, s.display_order,
               s.created_at
          from sponsors s
          left join air on air.sponsor_id = s.id
          left join clk on clk.sponsor_id = s.id
         where s.org_id = ${orgId} and ${listed}
        union all
        select null::uuid, air.gone_name, air.shown, air.on_ms, null::int, 1, null::int, null::int, null::timestamptz
          from air
         where air.sponsor_id is null
      ) t
      order by gone, rank, display_order, created_at, name, sponsor_id`;
    return rows.map((r) => ({
      sponsorId: r.sponsor_id,
      name: r.name,
      timesShown: r.shown,
      onScreenMs: Math.round(r.on_ms),
      viewerImpressions: null,
      peakViewers: null,
      linkClicks: r.clicks,
    }));
  });
}

/**
 * A new report link for one of the org's sponsors, over inclusive dates `from`..`to` (YYYY-MM-DD) and, when given, one of the
 * org's competitions. Editors only. Returns the url ONCE (`/r/sponsor/<token>`); the row holds only the token's hash.
 */
export async function createReportLink(
  auth: AuthCtx,
  orgId: string,
  a: { sponsorId: string; competitionId: string | null; from: string; to: string },
): Promise<{ id: string; url: string }> {
  assertOrg(auth, orgId);
  assertEditor(auth);
  if (!isIsoDay(a.from) || !isIsoDay(a.to)) throw new HttpError(400, "from and to must be dates, YYYY-MM-DD");
  // ISO dates sort as strings. The table checks it too (sponsor_report_links_period_check), but as a 500.
  if (a.to < a.from) throw new HttpError(400, ENDS_BEFORE_STARTS);
  assertUuid(a.sponsorId, "sponsor");
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  const id = await withTenant(orgId, async (tx) => {
    const [sponsor] = await tx`select 1 from sponsors where id = ${a.sponsorId} and org_id = ${orgId}`;
    if (!sponsor) throw new HttpError(404, "sponsor not found");
    if (a.competitionId !== null) await assertCompetition(tx, orgId, a.competitionId);
    const [row] = await tx<{ id: string }[]>`
      insert into sponsor_report_links (org_id, sponsor_id, competition_id, from_date, to_date, token_hash, created_by)
      values (${orgId}, ${a.sponsorId}, ${a.competitionId}, ${a.from}::date, ${a.to}::date, ${hashReportToken(token)}, ${auth.userId})
      returning id`;
    return row!.id;
  });
  return { id, url: reportLinkPath(token) };
}

/**
 * Revoke one of the org's live links (sets `revoked_at`; the row and its hash stay, so S14's lookup still finds it and answers
 * its opaque 404). Editors only. A link already revoked, unknown, or another org's is a 404 that changes nothing.
 */
export async function revokeReportLink(auth: AuthCtx, orgId: string, linkId: string): Promise<void> {
  assertOrg(auth, orgId);
  assertEditor(auth);
  assertUuid(linkId, "report link");
  await withTenant(orgId, async (tx) => {
    const [row] = await tx`
      update sponsor_report_links set revoked_at = now()
       where id = ${linkId} and org_id = ${orgId} and revoked_at is null
      returning id`;
    if (!row) throw new HttpError(404, "report link not found");
  });
}

/** The org's live (unrevoked) links, newest first, for the Share report panel. Editors only. Never a token. */
export async function listReportLinks(auth: AuthCtx, orgId: string): Promise<ReportLinkSummary[]> {
  assertOrg(auth, orgId);
  assertEditor(auth);
  const rows = await withTenant(orgId, (tx) => tx<{
    id: string; sponsor_id: string; competition_id: string | null; competition_name: string | null; from_date: string; to_date: string;
    created_at: Date;
  }[]>`
    select l.id, l.sponsor_id, l.competition_id, c.name as competition_name, l.from_date::text as from_date,
           l.to_date::text as to_date, l.created_at
      from sponsor_report_links l
      left join competitions c on c.id = l.competition_id
     where l.org_id = ${orgId} and l.revoked_at is null
     order by l.created_at desc, l.id`);
  return rows.map((r) => ({
    id: r.id,
    sponsorId: r.sponsor_id,
    competitionId: r.competition_id,
    competitionName: r.competition_name,
    from: r.from_date,
    to: r.to_date,
    createdAt: r.created_at.toISOString(),
  }));
}

/**
 * What the Share report form opens at for the period on screen: a time period's own whole days (so the sponsor sees the
 * period the club saw), or, for one competition, from its start (or its creation, when that is earlier or it has no start
 * date — no airing can predate it) to its end date or today, whichever is later (late fixtures still count). Editable.
 */
export async function reportLinkDefaults(
  auth: AuthCtx,
  orgId: string,
  p: SponsorPeriod,
  now: Date,
): Promise<ReportLinkDefaults> {
  assertOrg(auth, orgId);
  if (p.kind !== "competition") return { ...windowDates(timeWindow(p, now)), competitionId: null };
  const { competitionId } = p;
  return withTenant(orgId, async (tx) => {
    await assertCompetition(tx, orgId, competitionId);
    const [row] = await tx<{ from_date: string; to_date: string }[]>`
      select least(starts_on, (created_at at time zone 'UTC')::date)::text as from_date,
             greatest(ends_on, ${isoDay(now)}::date)::text as to_date
        from competitions where id = ${competitionId} and org_id = ${orgId}`;
    return { from: row!.from_date, to: row!.to_date, competitionId };
  });
}
