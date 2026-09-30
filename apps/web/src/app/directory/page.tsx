export const dynamic = "force-dynamic";
// Org directory (People + Clubs merged into one nav item). People = the
// person register (DOB/consent, doc 07); Clubs = parent clubs that group teams
// across divisions (Jul3/01). Both are org-wide entities, so they live behind
// one "Directory" menu with a tab each.
import Link from "@/components/ui/console-link";
import { BackLink } from "@/components/back-link";
import { Nav } from "@/components/nav";
import { requirePageAuth } from "@/server/page-auth";
import { viewerPlanFrom } from "@/lib/viewer-plan";
import { listPersons } from "@/server/usecases/persons";
import { listClubsWithMeta } from "@/server/usecases/clubs";
import { listTeams } from "@/server/usecases/teams";
import { listOfficialsForConsole } from "@/server/usecases/officials";
import { hasFeature, orgPlanKey } from "@/lib/entitlements";
import { PersonsPanel } from "@/components/v2/persons-panel";
import { DuplicatesPanel, type DupPerson } from "@/components/v2/duplicates-panel";
import { listDuplicateCandidates } from "@/server/usecases/person-duplicates";
import { ClubsTeamsList } from "@/components/v2/clubs-teams-list";
import { OfficialsDirectoryPanel } from "@/components/v2/officials-directory-panel";
import { Tip } from "@/components/ui/tip";
import { resolveLocale } from "@/lib/resolve-locale";
import { getDictionary, t, type Dict } from "@/lib/i18n";
import { DictProvider } from "@/components/i18n/dict-provider";
import { ScrollActiveTabIntoView } from "@/components/ui/scroll-active-tab-into-view";
import { listVenues } from "@/server/usecases/venues";
import { VenuesPanel } from "@/components/v2/venues-panel";
import { listStreamTargets } from "@/server/usecases/stream-targets";
import { StreamDestinationsPanel } from "@/components/v2/stream-destinations-panel";

const TABS = ["players", "clubs", "officials", "venues", "streaming"] as const;
type Tab = (typeof TABS)[number];

export default async function DirectoryPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const { tab: rawTab } = await searchParams;
  const tab: Tab = (TABS as readonly string[]).includes(rawTab ?? "") ? (rawTab as Tab) : "players";
  await requirePageAuth();
  const locale = await resolveLocale();
  const ui = await getDictionary(locale, "ui");

  return (
    <DictProvider dict={ui} locale={locale}>
      <Nav />
      <main className="mx-auto max-w-4xl px-4 py-8">
        <BackLink href="/dashboard" label={t(ui, "common.dashboard")} />
        <div className="mb-6">
          <p className="app-eyebrow mb-1">{t(ui, "directory.eyebrow")}</p>
          <h1 className="page-title">{t(ui, "directory.title")}</h1>
          <p className="mt-1 text-sm text-slate-500">
            {t(ui, "directory.desc")}
          </p>
        </div>

        <ScrollActiveTabIntoView>
          <nav
            aria-label={t(ui, "directory.sections")}
            className="scroll-x scroll-x-fade mb-6 flex gap-1 whitespace-nowrap border-b border-slate-200"
          >
            {TABS.map((tabKey) => (
              <Link
                key={tabKey}
                href={`/directory?tab=${tabKey}`}
                aria-current={tab === tabKey ? "page" : undefined}
                // m5 (B4 review): each tab is a 44-px tap target (the mockup's `min-h-11`), the new Streaming tab included.
                className={`flex min-h-11 items-center border-b-2 px-4 py-2 text-sm font-medium transition ${
                  tab === tabKey
                    ? "border-purple-600 text-purple-700"
                    : "border-transparent text-slate-500 hover:text-slate-800"
                }`}
              >
                {t(ui, `directory.tab.${tabKey}`)}
              </Link>
            ))}
          </nav>
        </ScrollActiveTabIntoView>

        {tab === "players" && <PlayersTab ui={ui} />}
        {tab === "clubs" && <ClubsTab ui={ui} />}
        {tab === "officials" && <OfficialsTab ui={ui} />}
        {tab === "venues" && <VenuesTab ui={ui} />}
        {tab === "streaming" && <StreamingTab ui={ui} locale={locale} />}
      </main>
    </DictProvider>
  );
}

// #404 §7 — the duplicate queue is computed live on every read, so it is
// fetched beside the roster rather than materialised. Both reads are org-scoped
// and independent, so they go in parallel.
const toDupPerson = (p: {
  id: string;
  full_name: string;
  dob: string | null;
  gender: string | null;
  consent: unknown;
  external_ref: string | null;
  photo_path: string | null;
  user_id: string | null;
}): DupPerson => ({
  id: p.id,
  full_name: p.full_name,
  dob: p.dob,
  gender: p.gender,
  consent: (p.consent ?? {}) as Record<string, unknown>,
  external_ref: p.external_ref,
  photo_path: p.photo_path,
  user_id: p.user_id,
});

async function PlayersTab({ ui }: { ui: Dict }) {
  const { auth, canEdit } = await requirePageAuth();
  const [{ items }, { items: duplicates }] = await Promise.all([
    listPersons(auth, { cursor: null, limit: 200 }),
    listDuplicateCandidates(auth, {}),
  ]);
  const storageBase = `${process.env.NEXT_PUBLIC_SUPABASE_URL ?? ""}/storage/v1/object/public/assets`;
  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-500">
        {t(ui, "directory.players.desc")} <strong>{t(ui, "directory.players.merge")}</strong>
        <Tip id="persons.merge" className="ml-0.5 align-middle" />
      </p>

      <DuplicatesPanel
        canEdit={canEdit}
        candidates={duplicates.map((c) => ({
          a: toDupPerson(c.a),
          b: toDupPerson(c.b),
          score: c.score,
          evidence: c.evidence,
        }))}
      />

      <hr className="border-purple-100" />
      <PersonsPanel
        persons={items.map((p) => ({
          id: p.id,
          full_name: p.full_name,
          dob: p.dob,
          gender: p.gender,
          consent: p.consent as { public_name?: boolean; public_photo?: boolean },
          external_ref: p.external_ref,
          photo_path: p.photo_path,
          user_id: p.user_id,
          claim_pending: p.claim_pending,
        }))}
        storageBase={storageBase}
        canEdit={canEdit}
      />
    </div>
  );
}

async function ClubsTab({ ui }: { ui: Dict }) {
  const { auth, canEdit } = await requirePageAuth();
  const viewerPlan = viewerPlanFrom(await orgPlanKey(auth.orgId));
  const [clubs, teams] = await Promise.all([listClubsWithMeta(auth), listTeams(auth)]);
  const storageBase = `${process.env.NEXT_PUBLIC_SUPABASE_URL ?? ""}/storage/v1/object/public/assets`;
  return (
    <div className="space-y-4">
      <p className="max-w-xl text-sm text-slate-500">{t(ui, "directory.clubs.desc")}</p>
      <ClubsTeamsList
        clubs={clubs.map((c) => ({
          id: c.id,
          name: c.name,
          short_name: c.short_name,
          logo_path: c.logo_path,
          slug: c.slug,
          team_count: c.team_count,
          primary_contact: c.primary_contact,
        }))}
        teams={teams.map((t) => ({
          id: t.id,
          name: t.name,
          club_id: t.club_id,
          logo_path: t.logo_path,
        }))}
        storageBase={storageBase}
        canEdit={canEdit}
        // The Directory is a cross-org surface (v18 W3-B rule C) — there is
        // no single organization this page's paywalls can be resolved
        // against, so "unknown" is the honest answer here.
        viewerPlan={viewerPlan}
      />
    </div>
  );
}

async function OfficialsTab({ ui }: { ui: Dict }) {
  const { auth, canEdit } = await requirePageAuth();
  const viewerPlan = viewerPlanFrom(await orgPlanKey(auth.orgId));
  const [officials, rolesMultiAllowed] = await Promise.all([
    listOfficialsForConsole(auth),
    hasFeature(auth.orgId, "officials.roles_multi"),
  ]);
  return (
    <div className="space-y-4">
      <p className="max-w-xl text-sm text-slate-500">{t(ui, "directory.officials.desc")}</p>
      <OfficialsDirectoryPanel
        officials={officials.map((o) => ({
          id: o.id,
          display_name: o.display_name,
          role_keys: o.role_keys,
          entrant_id: o.entrant_id,
          email: o.email,
          max_per_day: o.max_per_day,
          claimed: o.claimed,
          invite_pending: o.invite_pending,
        }))}
        canEdit={canEdit}
        rolesMultiAllowed={rolesMultiAllowed}
        viewerPlan={viewerPlan}
      />
    </div>
  );
}

// D5/P8: fetched here with includeArchived: true so the panel's "Show
// archived" toggle is a client-side filter, not a refetch — `listVenues`
// threads the same flag into BOTH the venues and the nested courts query
// (A5; see venues-panel.tsx's file header).
async function VenuesTab({ ui }: { ui: Dict }) {
  const { auth, canEdit } = await requirePageAuth();
  const venues = await listVenues(auth, { includeArchived: true });
  return (
    <div className="space-y-4">
      <p className="max-w-xl text-sm text-slate-500">{t(ui, "directory.venues.desc")}</p>
      <VenuesPanel
        venues={venues.map((v) => ({
          id: v.id,
          name: v.name,
          address: v.address,
          sort: v.sort,
          archived_at: v.archived_at,
          created_at: v.created_at,
          courts: v.courts.map((c) => ({
            id: c.id,
            venue_id: c.venue_id,
            name: c.name,
            sort: c.sort,
            tags: c.tags,
            archived_at: c.archived_at,
            created_at: c.created_at,
            hours: c.hours,
            exceptions: c.exceptions,
          })),
        }))}
        orgId={auth.orgId}
        canEdit={canEdit}
      />
    </div>
  );
}

// Spec 2026-09-30 §4 (D1) — the ONE place streaming destinations are managed. Every member sees the list; Add / Rename /
// Replace key / Remove render only for canEdit (owner or admin), matching the API's write gate. Read server-side
// through the same use-case the API serves (VenuesTab's shape), so the list, its key hints and its "in use" badges are
// the API's projection, never a second query.
async function StreamingTab({ ui, locale }: { ui: Dict; locale: string }) {
  const { auth, canEdit } = await requirePageAuth();
  const targets = await listStreamTargets(auth, auth.orgId);
  return (
    <div className="space-y-4">
      <p className="max-w-xl text-sm text-slate-500">{t(ui, "directory.streaming.desc")}</p>
      <StreamDestinationsPanel orgId={auth.orgId} canEdit={canEdit} targets={targets} locale={locale} />
    </div>
  );
}
