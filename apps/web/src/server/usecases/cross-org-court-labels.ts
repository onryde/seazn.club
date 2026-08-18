import "server-only";
// Venue-qualified court labels for a SUPERUSER, cross-org read (#14 — me.ts,
// scorers.ts, me-officiating.ts each read "my stuff across every org I
// belong to" on the pooled `sql` client, outside any `withTenant` RLS
// context, per their own header comments: a claimed player/scorer/official
// is usually not an org member, so the tenant door never opens for them).
//
// `courtNamesById` (schedule.ts) is the equivalent for a single-org
// `withTenant` transaction and cannot be reused as-is here: it needs a
// tenant `tx` (RLS pinned to ONE org) to run inside, and one cross-org call
// here spans however many different orgs the caller's own fixtures touch.
//
// This reuses the SAME `buildCourtDirectory` rule the board/picker/AI pack/
// `courtNamesById` all already share (see that function's own doc comment)
// — batched PER DISTINCT org_id, so a court name is judged ambiguous or not
// against that whole org's own courts (matching what that org's board would
// render for the same physical court), never lumped together across
// unrelated orgs — which would over-qualify a name that is not actually
// ambiguous within its own org, just because some other org happens to
// reuse it too.
//
// DELIBERATELY bypasses RLS (the plain pooled `sql` client, not `withTenant`)
// — there is no tenant door to open for a claimed player/scorer/official who
// isn't an org member. The org_id set this queries is derived entirely from
// `rows`, which the caller has ALREADY authorised (every existing caller
// built `rows` from ITS OWN superuser-scoped read, keyed on the userId it
// authenticated) — this function trusts that set and does not re-check it.
// Because RLS is not there as a backstop, the returned map is narrowed to
// exactly the `court_id`s present in `rows` before it goes back to the
// caller, even though the AMBIGUITY JUDGEMENT itself is computed over each
// org's WHOLE court directory (never narrow that part — an org's other
// courts are what make a name ambiguous or not). A caller that iterates the
// map instead of indexing it by an id it already holds must not be able to
// see a court it never asked about.
import { sql } from "@/lib/db";
import { buildCourtDirectory } from "@/lib/court-directory";

/**
 * `court_id` -> venue-qualified label, for every court referenced by the
 * given (org_id, court_id) rows — and ONLY those courts (see the module
 * header on why the returned map is narrowed even though the underlying
 * judgement is not). A row with a null `court_id` is ignored (nothing to
 * label). Safe to call with an empty list or an all-null one.
 */
export async function courtLabelsByOrg(
  rows: readonly { org_id: string; court_id: string | null }[],
): Promise<Map<string, string>> {
  const withCourt = rows.filter((r): r is { org_id: string; court_id: string } => r.court_id !== null);
  if (withCourt.length === 0) return new Map();
  const wantedCourtIds = new Set(withCourt.map((r) => r.court_id));
  const orgIds = [...new Set(withCourt.map((r) => r.org_id))];
  const courtRows = await sql<
    { id: string; name: string; venue_name: string; tags: string[]; org_id: string }[]
  >`
    select c.id, c.name, v.name as venue_name, c.tags, c.org_id
    from courts c
    join venues v on v.id = c.venue_id
    where c.org_id in ${sql(orgIds)}
    order by v.sort, v.name, c.sort, c.name, c.id`;
  type CourtRow = { id: string; name: string; venue_name: string; tags: string[]; org_id: string };
  const byOrg = new Map<string, CourtRow[]>();
  for (const r of courtRows) {
    const list = byOrg.get(r.org_id);
    if (list) list.push(r);
    else byOrg.set(r.org_id, [r]);
  }
  const labels = new Map<string, string>();
  for (const orgRows of byOrg.values()) {
    // The directory is built over the WHOLE org's courts (ambiguity is an
    // org-wide fact) — only the OUTPUT is narrowed, to what the caller
    // actually referenced.
    for (const [id, info] of buildCourtDirectory(orgRows)) {
      if (wantedCourtIds.has(id)) labels.set(id, info.label);
    }
  }
  return labels;
}
