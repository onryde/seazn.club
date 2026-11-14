import "server-only";
// The getting-started read (/start "Sent stepper" wave, owner-approved 2026-11-14): how far an organiser has got with one
// competition's first steps — named their organisation, filled the field, generated the fixtures, put one on the schedule. A
// pure read; the stepper (T2) words it. A competition built by a funnel claim (lib/funnel.ts createFromDraft, which stamps the
// draft with it — V518) also reads its draft: the field size the organiser chose is the entrants' target, and the name and
// language the claim gave the new organisation are what "renamed" is measured against.
import { sql, withTenant } from "@/lib/db";
import { getLimit } from "@/lib/entitlements";
import { HttpError } from "@/lib/errors";
import { getDictionary, t } from "@/lib/i18n";
import { DEFAULT_LOCALE, LOCALES, hasLocale, type Locale } from "@/lib/i18n-constants";
import type { AuthCtx } from "@/server/api-v1/auth";

/** The plan row a division's field is capped by — the cap the claim held the chosen size to (lib/funnel.ts ENTRANT_CAP_KEY). */
const ENTRANT_CAP_KEY = "entrants.per_division.max";

export interface GettingStarted {
  /** The organisation no longer carries the name the claim gave it (`funnel.claim.orgName` of the event's name, in the draft's
   *  language). True for an organisation the claim did not create (it never carried that name). For a competition no funnel
   *  draft built, measured against that name in every shipped language, of the competition's current name. */
  orgRenamed: boolean;
  /** `count`: the competition's entrants still in the field (registered or confirmed; withdrawn and disqualified ones are out),
   *  over its live divisions. `target`: the field size the organiser chose on /start, held to the plan's per-division cap as the
   *  claim held it (read live: an upgrade lifts it back toward the choice); null when no funnel draft built this competition. */
  entrants: { count: number; target: number | null };
  /** Any fixture exists in a live division of the competition (Generate has run). */
  fixturesGenerated: boolean;
  /** Any fixture in a live division has a time. */
  fixtureScheduled: boolean;
}

/** The name the claim gives a new organisation: `funnel.claim.orgName` of the event's name, in `locale`. */
async function claimedOrgName(locale: Locale, eventName: string): Promise<string> {
  return t(await getDictionary(locale, "ui"), "funnel.claim.orgName", { name: eventName });
}

type ProgressRow = { name: string; org_name: string; entrants: number; generated: boolean; scheduled: boolean };
type ClaimedDraft = { entrants: number | null; name: string | null; locale: string | null };

/** The competition's own state, read in the caller's organisation: a competition another organisation holds (or none) is a
 *  404, as `getCompetition` answers. */
async function progressRow(auth: AuthCtx, competitionId: string): Promise<ProgressRow> {
  const row = await withTenant(auth.orgId, async (tx) => {
    const [found] = await tx<ProgressRow[]>`
      select c.name, o.name as org_name,
             (select count(*)::int from entrants e join divisions d on d.id = e.division_id
               where d.competition_id = c.id and d.archived_at is null and e.status in ('registered', 'confirmed')) as entrants,
             exists (select 1 from fixtures f join divisions d on d.id = f.division_id
                      where d.competition_id = c.id and d.archived_at is null) as generated,
             exists (select 1 from fixtures f join divisions d on d.id = f.division_id
                      where d.competition_id = c.id and d.archived_at is null and f.scheduled_at is not null) as scheduled
        from competitions c join organizations o on o.id = c.org_id
       where c.id = ${competitionId}`;
    return found;
  });
  if (!row) throw new HttpError(404, "competition not found");
  return row;
}

/** The /start draft that built `competitionId`, if one did (V518 stamps it; `funnel_drafts_competition_idx`). funnel_drafts is
 *  org-less (pre-auth) and outside RLS, so it is read on the pool, and nothing of it is answered unless the tenant read proves
 *  the competition is the caller's. The payload was parsed strictly when it was claimed (consumeFunnelDraft), so `entrants` is
 *  an integer there. */
async function claimedDraft(competitionId: string): Promise<ClaimedDraft | undefined> {
  const [draft] = await sql<ClaimedDraft[]>`
    select case when jsonb_typeof(payload->'entrants') = 'number' then (payload->>'entrants')::int end as entrants,
           payload->>'name' as name, locale
      from funnel_drafts where competition_id = ${competitionId}
     order by used_at desc nulls last, created_at desc limit 1`;
  return draft;
}

async function progressOf(auth: AuthCtx, competitionId: string, row: ProgressRow, draft: ClaimedDraft | undefined): Promise<GettingStarted> {
  const defaults = draft?.name
    ? [await claimedOrgName(draft.locale !== null && hasLocale(draft.locale) ? draft.locale : DEFAULT_LOCALE, draft.name)]
    : await Promise.all(LOCALES.map((l) => claimedOrgName(l, row.name)));

  let target: number | null = null;
  if (draft?.entrants != null) {
    const cap = await getLimit(auth.orgId, ENTRANT_CAP_KEY, competitionId);
    target = cap === null ? draft.entrants : Math.min(draft.entrants, cap);
  }

  return {
    orgRenamed: !defaults.includes(row.org_name),
    entrants: { count: row.entrants, target },
    fixturesGenerated: row.generated,
    fixtureScheduled: row.scheduled,
  };
}

/** The getting-started state of `competitionId`, read in the caller's organisation: a competition another organisation holds (or
 *  none) is a 404, as `getCompetition` answers. */
export async function gettingStarted(auth: AuthCtx, competitionId: string): Promise<GettingStarted> {
  const row = await progressRow(auth, competitionId);
  return progressOf(auth, competitionId, row, await claimedDraft(competitionId));
}

/** The landing's read (the division page's getting-started panel, on every editor's view of every division): the draft first,
 *  on its index, and null — with no tenant read, no plan read and no dictionary work — when no /start draft with a field size
 *  built the competition, which is the stepper's own rule for showing nothing (lib/getting-started-steps.ts landingSteps: no
 *  target). Otherwise the full read: a /start competition another organisation holds is still a 404. A null answers the same
 *  for a competition the caller cannot see, so it tells nothing of one (review I2). */
export async function funnelGettingStarted(auth: AuthCtx, competitionId: string): Promise<GettingStarted | null> {
  const draft = await claimedDraft(competitionId);
  if (draft?.entrants == null) return null;
  return progressOf(auth, competitionId, await progressRow(auth, competitionId), draft);
}
