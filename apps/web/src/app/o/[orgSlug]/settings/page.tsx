export const dynamic = "force-dynamic";
import Link from "@/components/ui/console-link";
import {
  Building2, Users,
  Pencil, Image as ImageIcon, Palette,
  User, Mail, Download, ShieldOff, Compass, BookOpen, Cookie, Handshake, KeyRound, Banknote,
  Clock, Newspaper, SlidersHorizontal, Languages, Coins, CalendarClock,
  type LucideIcon,
} from "lucide-react";
import { getUserOrgs } from "@/lib/auth";
import { requireOrgPage } from "@/server/page-auth";
import { routes } from "@/lib/routes";
import { sql } from "@/lib/db";
import { hasFeature, hasFeatureOnAnyPass } from "@/lib/entitlements";
import { type OrgMember } from "@/lib/types";
import { OrgTeam } from "@/components/org-team";
import { OrgSwitcher } from "@/components/org-switcher";
import { OrgRename } from "@/components/org-rename";
import { OrgLogo } from "@/components/org-logo";
import { OrgBrandColor } from "@/components/org-brand-color";
import { OrgAbout } from "@/components/org-about";
import { OrgTimezone } from "@/components/org-timezone";
import { OrgSponsors } from "@/components/org-sponsors";
import { SponsorPackages } from "@/components/sponsor-packages";
import { listSponsorRows } from "@/server/usecases/sponsors";
import { listPosts, type OrgPost } from "@/server/usecases/org-posts";
import { NewsTab } from "@/components/news/news-tab";
import { resolveLocale } from "@/lib/resolve-locale";
import { getDictionary, t, type Dict } from "@/lib/i18n";
import {
  DisplayNameForm,
  ChangeEmailForm,
  LeaveOrgButton,
  TransferOwnerForm,
  DeleteAccountButton,
} from "@/components/account-actions";
import { ApiKeysPanel } from "@/components/api-keys";
import { TimezonePreference } from "@/components/timezone-preference";
import { LocalePreference } from "@/components/locale-preference";
import { CookieSettingsButton } from "@/components/cookie-settings-button";
import { Tip } from "@/components/ui/tip";
import type { TipId } from "@/config/tips";
import { TourReplayButton } from "@/components/tour-replay";
import { PlanBadge } from "@/components/plan-badge";
import { CurrencySwitcher } from "@/components/currency-switcher";
import { preferredCurrency } from "@/lib/currency-server";
import { SettingsNav, SETTINGS_TABS, type SettingsTab } from "./_components/settings-nav";

function SectionHeader({ icon: Icon, children, action }: {
  icon: LucideIcon;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="mb-5 flex items-center justify-between gap-3">
      <div className="flex items-center gap-2">
        <Icon className="h-4 w-4 text-purple-500" strokeWidth={1.75} />
        <h2 className="text-sm font-semibold text-slate-800">{children}</h2>
      </div>
      {action}
    </div>
  );
}

function SubSection({
  icon: Icon,
  label,
  tip,
}: {
  icon: LucideIcon;
  label: string;
  /** Optional contextual chip beside the heading (config/tips.ts). */
  tip?: TipId;
}) {
  return (
    <div className="mb-2 flex items-center gap-1.5">
      <Icon className="h-3.5 w-3.5 text-slate-500" strokeWidth={1.75} />
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</p>
      {tip && <Tip id={tip} small className="ml-0.5" />}
    </div>
  );
}

const ROLE_BADGE: Record<string, string> = {
  owner: "bg-amber-100 text-amber-700",
  admin: "bg-purple-100 text-purple-700",
  viewer: "bg-slate-100 text-slate-600",
};

/** Localized role badge text (owner/admin/viewer/scorer). */
function roleLabel(dict: Dict, role: string): string {
  return t(dict, `role.${role}`);
}

// The tab list, the four route-owning entries beside it, and the sidebar
// markup all live in ./_components/settings-nav — this page is one of five
// surfaces that render it, not its owner.
type Tab = SettingsTab;

export default async function SettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<{ tab?: string; email_change?: string }>;
}) {
  const { orgSlug } = await params;
  const page = await requireOrgPage(orgSlug, { tail: "/settings" });
  const { user, org: active, canEdit, auth } = page;
  const orgs = await getUserOrgs(user.id);
  const locale = await resolveLocale();
  const dict = await getDictionary(locale, "ui");

  const { tab: rawTab, email_change } = await searchParams;
  const tab: Tab = (SETTINGS_TABS.includes(rawTab as SettingsTab) ? rawTab : "organization") as Tab;

  // Per-tab lazy data loading.
  //
  // TWO KEYS, NOT ONE (D23). They are different products and the resolver has
  // always treated them that way:
  //
  //   branding            org LOGO upload + display  → free on every plan (V310)
  //   dashboard.branding  org THEME COLOUR           → Pro / Pro Plus only
  //
  // One `canBrand` flag drove both gates. That was harmless while `branding`
  // was Pro-only, and became a real bug the moment V310 made it free: a
  // Community org was handed a working colour picker whose value is stripped on
  // the way out — server/public-site/data.ts wraps o.branding in
  // `case when org_has_feature(o.id, 'dashboard.branding') then … else '{}' end`.
  // Save a colour, see nothing change, anywhere, ever.
  const [canBrandLogo, canBrandColor] =
    tab === "organization"
      ? await Promise.all([
          hasFeature(active.id, "branding"),
          hasFeature(active.id, "dashboard.branding"),
        ])
      : [false, false];
  let orgAbout: string | null = null;
  if (tab === "organization") {
    const [row] = await sql<{ about: string | null }[]>`
      select about from organizations where id = ${active.id}`;
    orgAbout = row?.about ?? null;
  }

  // Sponsors tab (v10 PROMPT-56): table rows, not the branding blob. The
  // basic partner strip is free; tiers/per-competition scoping are Pro.
  //
  // ORG-LEVEL, so `hasFeatureOnAnyPass` and not `hasFeature` (Phase 2 sweep).
  // `sponsorCompetitions` below is the composer's PICKER, not this tab's scope
  // — there is no one competition to thread. Resolving org-wide made an Event
  // Pass invisible and left a paying org staring at the upsell for something it
  // owned; picking an arbitrary id off the list would have been a fabrication.
  // These two flags are AFFORDANCES only: usecases/sponsors.ts still resolves
  // the competition actually being written, so a pass on one competition opens
  // the UI without opening the org.
  let sponsorRows: Awaited<ReturnType<typeof listSponsorRows>> = [];
  let hasSponsorTiers = false;
  let hasSponsorMonetize = false;
  let sponsorCompetitions: { id: string; name: string }[] = [];
  if (tab === "sponsors") {
    sponsorRows = await listSponsorRows(active.id);
    hasSponsorTiers = await hasFeatureOnAnyPass(active.id, "sponsors.tiers");
    hasSponsorMonetize = await hasFeatureOnAnyPass(active.id, "sponsors.monetize");
    sponsorCompetitions = await sql<{ id: string; name: string }[]>`
      select id, name from competitions
      where org_id = ${active.id}
      order by created_at desc limit 100`;
  }

  // News tab (SPEC-2): the org's posts (drafts + published) + the competition
  // list for the composer's scope picker. Manual posts are free on every plan.
  // hasNewsAuto (P3/D7) also gates the "Generate digest" button — same
  // entitlement the system auto-drafts already check.
  let newsPosts: OrgPost[] = [];
  let newsCompetitions: { id: string; name: string }[] = [];
  let hasNewsAuto = false;
  if (tab === "news") {
    newsPosts = await listPosts(auth, active.id);
    newsCompetitions = await sql<{ id: string; name: string }[]>`
      select id, name from competitions
      where org_id = ${active.id}
      order by created_at desc limit 100`;
    hasNewsAuto = await hasFeature(active.id, "news.auto");
  }

  // Platform API tab: api.access = Pro. Scope choice (read/score/manage) is
  // the org's own call (v3/08 §2 — the above-Pro api.write rung is retired).
  let hasApiAccess = false;
  let pinnableCompetitions: { id: string; name: string }[] = [];
  if (tab === "api") {
    hasApiAccess = await hasFeature(active.id, "api.access");
    if (hasApiAccess) {
      pinnableCompetitions = await sql<{ id: string; name: string }[]>`
        select id, name from competitions
        where org_id = ${active.id}
        order by created_at desc limit 100`;
    }
  }

  // Account tab data
  const orgMembersMap = new Map<string, OrgMember[]>();
  if (tab === "account") {
    for (const org of orgs) {
      if (org.role === "owner") {
        const members = await sql<OrgMember[]>`
          select m.user_id, u.email, u.display_name, u.avatar_url, m.role, m.created_at
          from org_members m join users u on u.id = m.user_id
          where m.org_id = ${org.id}
          order by m.created_at asc`;
        orgMembersMap.set(org.id, members);
      }
    }
  }

  // Preferences tab — the DISPLAY currency, deliberately resolved with a null
  // org id. `preferredCurrency(orgId)` puts an existing subscription's currency
  // ABOVE the cookie (renewals must never switch currency), so passing the org
  // here would render a picker whose value ignores what the user just chose.
  // `subscriptionCurrency` is read separately, only to say so in words.
  let displayCurrency: Awaited<ReturnType<typeof preferredCurrency>> | null = null;
  let subscriptionCurrency: string | null = null;
  if (tab === "preferences") {
    displayCurrency = await preferredCurrency(null);
    const [row] = await sql<{ currency: string | null }[]>`
      select s.currency from subscriptions s
      join organizations o on o.subscription_id = s.id
      where o.id = ${active.id}`;
    subscriptionCurrency = row?.currency ?? null;
  }

  const emailChangeMessage =
    email_change &&
    ["success", "invalid", "expired", "taken", "error"].includes(email_change)
      ? t(dict, `settings.emailChange.${email_change}`)
      : null;

  return (
    <>
      <div className="mx-auto max-w-5xl px-4 py-4 md:py-8">
        <div className="flex flex-col gap-4 md:flex-row md:gap-8">

          <SettingsNav orgSlug={orgSlug} active={tab} dict={dict} />


          {/* ── Panel ── */}
          <main className="min-w-0 flex-1">

            {/* ── ORGANISATION ── */}
            {tab === "organization" && (
              <section className="card p-6">
                <SectionHeader icon={Building2}>{t(dict, "settings.nav.organization")}</SectionHeader>

                <div className="flex items-center gap-3">
                  <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-purple-500 to-fuchsia-500 text-lg font-bold text-white">
                    {active.name.charAt(0).toUpperCase()}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-slate-800">{active.name}</p>
                    <p className="truncate font-mono text-xs text-purple-600">{active.slug}</p>
                  </div>
                  <span className={`badge ${ROLE_BADGE[active.role]}`}>{roleLabel(dict, active.role)}</span>
                  <OrgSwitcher orgs={orgs} activeId={active.id} />
                </div>

                {canEdit && (
                  <div className="mt-5 border-t border-slate-100 pt-5" data-tour="org-rename">
                    <SubSection icon={Pencil} label={t(dict, "settings.org.rename")} />
                    <OrgRename orgId={active.id} initialName={active.name} />
                  </div>
                )}

                {canEdit && (
                  <div className="mt-5 border-t border-slate-100 pt-5">
                    <SubSection icon={ImageIcon} label={t(dict, "settings.org.logo")} />
                    {canBrandLogo ? (
                      <OrgLogo
                        orgId={active.id}
                        initialLogoUrl={
                          active.logo_storage_path
                            ? `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/assets/${active.logo_storage_path}`
                            : (active.logo_url ?? null)
                        }
                      />
                    ) : (
                      <p className="flex items-center gap-2 text-sm text-slate-500">
                        <PlanBadge feature="branding" />
                        {t(dict, "settings.upgrade.logo")}{" "}
                        <Link href={routes.billing(orgSlug)} className="text-purple-600 underline">
                          {t(dict, "settings.upgrade.link")}
                        </Link>
                      </p>
                    )}
                  </div>
                )}

                {canEdit && (
                  <div className="mt-5 border-t border-slate-100 pt-5">
                    {/* D23: the logo above is free, this control is Pro. The
                        chip explains the split so the neighbouring upsell
                        doesn't read as arbitrary. */}
                    <SubSection
                      icon={Palette}
                      label={t(dict, "settings.org.brandColor")}
                      tip="settings.brand-colour"
                    />
                    {canBrandColor ? (
                      <OrgBrandColor orgId={active.id} initialBranding={active.branding} />
                    ) : (
                      <p className="flex items-center gap-2 text-sm text-slate-500">
                        <PlanBadge feature="dashboard.branding" />
                        {t(dict, "settings.upgrade.brandColor")}{" "}
                        <Link href={routes.billing(orgSlug)} className="text-purple-600 underline">
                          {t(dict, "settings.upgrade.link")}
                        </Link>
                      </p>
                    )}
                  </div>
                )}

                {canEdit && (
                  <div className="mt-5 border-t border-slate-100 pt-5">
                    <SubSection icon={BookOpen} label={t(dict, "settings.org.about")} />
                    <OrgAbout orgId={active.id} initialValue={orgAbout} branding={active.branding} />
                  </div>
                )}


                {canEdit && (
                  <div className="mt-5 border-t border-slate-100 pt-5">
                    <SubSection icon={Compass} label={t(dict, "settings.org.tour")} />
                    <TourReplayButton />
                  </div>
                )}
              </section>
            )}

            {/* ── NEWS ── */}
            {tab === "news" && (
              <section className="card p-6">
                <SectionHeader icon={Newspaper}>{t(dict, "news.tab")}</SectionHeader>
                <NewsTab
                  orgId={active.id}
                  orgSlug={active.slug}
                  posts={newsPosts}
                  competitions={newsCompetitions}
                  canEdit={canEdit}
                  hasNewsAuto={hasNewsAuto}
                />
              </section>
            )}

            {/* ── SPONSORS ── */}
            {tab === "sponsors" && (
              <section className="card p-6">
                <SectionHeader icon={Handshake}>{t(dict, "sponsors.title")}</SectionHeader>
                <OrgSponsors
                  orgId={active.id}
                  initialSponsors={sponsorRows}
                  competitions={sponsorCompetitions}
                  hasTiers={hasSponsorTiers}
                  billingHref={routes.billing(orgSlug)}
                  canEdit={canEdit}
                />
                {canEdit && (
                  <div className="mt-6 border-t border-slate-100 pt-5">
                    <SubSection icon={Banknote} label={t(dict, "sponsors.sell.title")} />
                    <SponsorPackages
                      orgId={active.id}
                      competitions={sponsorCompetitions}
                      hasMonetize={hasSponsorMonetize}
                      billingHref={routes.billing(orgSlug)}
                    />
                  </div>
                )}
              </section>
            )}

            {tab === "team" && (
              <section className="card p-6">
                <SectionHeader icon={Users}>{t(dict, "settings.nav.team")}</SectionHeader>
                <OrgTeam orgId={active.id} role={active.role} currentUserId={user.id} />
              </section>
            )}

            {/* ── PLATFORM API ── */}
            {tab === "api" && (
              <section className="card p-6">
                <SectionHeader icon={KeyRound}>{t(dict, "settings.nav.api")}</SectionHeader>
                {!canEdit ? (
                  <p className="text-sm text-slate-500">
                    {t(dict, "settings.api.noAccess")}
                  </p>
                ) : hasApiAccess ? (
                  <ApiKeysPanel orgId={active.id} competitions={pinnableCompetitions} />
                ) : (
                  <p className="flex items-center gap-2 text-sm text-slate-500">
                    <PlanBadge feature="api.access" />
                    {t(dict, "settings.upgrade.api")}{" "}
                    <Link href={routes.billing(orgSlug)} className="text-purple-600 underline">
                      {t(dict, "settings.upgrade.link")}
                    </Link>
                  </p>
                )}
              </section>
            )}

            {/* ── PREFERENCES ──
                Everything that changes how the product READS rather than what
                it contains: your times, your language, the currency prices are
                shown in, and your analytics consent. Four of these five lived
                on the Account tab or the Organisation tab, where they sat
                beside irreversible actions (delete account, transfer owner) and
                org identity fields — different stakes, same page.

                My timezone vs the organisation's is the one pair that must not
                read as a duplicate: the personal one drives YOUR times, the org
                one is the VENUE lane every division inherits. Labelled and
                described separately for exactly that reason. */}
            {tab === "preferences" && (
              <div className="space-y-5">
                <section className="card p-5">
                  <SectionHeader icon={SlidersHorizontal}>{t(dict, "settings.nav.preferences")}</SectionHeader>
                  <p className="text-sm text-slate-500">{t(dict, "settings.prefs.desc")}</p>
                </section>

                {/* Personal — timezone (spec 2026-07-14). Drives every personal
                    time + the local-time hint beside venue times. */}
                <section className="card p-5">
                  <SectionHeader icon={Clock}>{t(dict, "settings.prefs.mine")}</SectionHeader>
                  <label className="mb-1 block text-sm text-slate-500">{t(dict, "settings.account.timezone")}</label>
                  <TimezonePreference current={user.timezone} />

                  <div className="mt-5 border-t border-slate-100 pt-5">
                    <SubSection icon={Languages} label={t(dict, "settings.account.language")} />
                    <LocalePreference current={user.locale} />
                  </div>

                  <div className="mt-5 border-t border-slate-100 pt-5">
                    <SubSection icon={Coins} label={t(dict, "settings.prefs.currency")} />
                    {displayCurrency && <CurrencySwitcher current={displayCurrency} showLabel={false} />}
                    <p className="mt-2 text-xs text-slate-500">
                      {t(dict, "settings.prefs.currencyHelp")}
                    </p>
                    {/* An existing subscription's currency outranks this cookie
                        in preferredCurrency() — renewals and upgrades never
                        switch currency. Saying so here is the difference
                        between a preference and a broken control. */}
                    {subscriptionCurrency && (
                      <p className="mt-1 text-xs text-slate-500">
                        {t(dict, "settings.prefs.currencyLocked", {
                          currency: subscriptionCurrency.toUpperCase(),
                        })}
                      </p>
                    )}
                  </div>
                </section>

                {/* Organisation — scheduling timezone (V305): the VENUE lane
                    every division inherits. Divisions no longer ask for a
                    timezone at all. */}
                {canEdit && (
                  <section className="card p-5">
                    <SectionHeader icon={CalendarClock}>{t(dict, "settings.prefs.org")}</SectionHeader>
                    <SubSection icon={Clock} label={t(dict, "settings.org.timezone")} />
                    <OrgTimezone orgId={active.id} initialTimezone={active.timezone} />
                  </section>
                )}

                {/* Privacy & cookies — analytics consent can be changed/withdrawn here. */}
                <section className="card p-5">
                  <SectionHeader
                    icon={Cookie}
                    action={
                      <CookieSettingsButton className="btn btn-ghost text-xs">
                        {t(dict, "settings.account.cookieSettings")}
                      </CookieSettingsButton>
                    }
                  >
                    {t(dict, "settings.account.privacy")}
                  </SectionHeader>
                  <p className="text-sm text-slate-500">
                    {t(dict, "settings.account.privacyDesc")}{" "}
                    <Link href="/legal/cookie-policy" className="text-purple-600 underline">
                      {t(dict, "settings.account.cookiePolicy")}
                    </Link>
                    .
                  </p>
                </section>
              </div>
            )}

            {/* ── ACCOUNT ── */}
            {tab === "account" && (
              <div className="space-y-5">
                {emailChangeMessage && (
                  <div
                    className={`rounded-lg px-4 py-3 text-sm ${
                      email_change === "success"
                        ? "bg-emerald-50 text-emerald-700"
                        : "bg-red-50 text-red-700"
                    }`}
                  >
                    {emailChangeMessage}
                  </div>
                )}

                {/* Profile */}
                <section className="card space-y-2 p-5">
                  <SectionHeader icon={User}>{t(dict, "settings.account.profile")}</SectionHeader>
                  <label className="block text-sm text-slate-500">{t(dict, "settings.account.displayName")}</label>
                  <DisplayNameForm currentName={user.display_name} />
                  <p className="text-sm text-slate-500">
                    {t(dict, "settings.account.emailLabel")}: <span className="font-medium text-slate-700">{user.email}</span>
                  </p>
                  <p className="text-sm text-slate-500">
                    {t(dict, "settings.account.accountId")}: <span className="font-mono text-xs text-purple-600">{user.id}</span>
                  </p>
                </section>

                {/* Change email */}
                <section className="card p-5">
                  <SectionHeader icon={Mail}>{t(dict, "settings.account.changeEmail")}</SectionHeader>
                  <ChangeEmailForm currentEmail={user.email} />
                </section>

                {/* Export */}
                <section className="card p-5">
                  <SectionHeader
                    icon={Download}
                    action={
                      <a href="/api/users/me/export" download className="btn btn-ghost text-xs">
                        {t(dict, "settings.account.downloadJson")}
                      </a>
                    }
                  >
                    {t(dict, "settings.account.export")}
                  </SectionHeader>
                  <p className="text-sm text-slate-500">
                    {t(dict, "settings.account.exportDesc")}
                  </p>
                </section>

                {/* Org actions */}
                {orgs.length > 0 && (
                  <section className="card p-5">
                    <SectionHeader icon={Building2}>{t(dict, "settings.account.organizations")}</SectionHeader>
                    <div className="space-y-6">
                      {orgs.map((org) => {
                        const members = orgMembersMap.get(org.id) ?? [];
                        return (
                          <div key={org.id} className="space-y-3">
                            <div className="flex items-center justify-between">
                              <div>
                                <p className="font-medium text-slate-800">{org.name}</p>
                                <p className="text-xs text-slate-500 font-mono">{org.slug}</p>
                              </div>
                              <span
                                className={`badge text-xs ${
                                  org.role === "owner"
                                    ? "bg-amber-100 text-amber-700"
                                    : org.role === "admin"
                                      ? "bg-purple-100 text-purple-700"
                                      : "bg-slate-100 text-slate-600"
                                }`}
                              >
                                {roleLabel(dict, org.role)}
                              </span>
                            </div>
                            {org.role === "owner" && members.length > 1 && (
                              <div className="pl-2 border-l-2 border-slate-100 space-y-1">
                                <p className="text-xs font-medium text-slate-500">{t(dict, "settings.account.transferOwnership")}</p>
                                <TransferOwnerForm orgId={org.id} members={members} />
                              </div>
                            )}
                            {org.role !== "owner" && (
                              <LeaveOrgButton orgId={org.id} orgName={org.name} />
                            )}
                            {org.role === "owner" && members.length === 1 && (
                              <p className="text-xs text-slate-500">
                                {t(dict, "settings.account.soleOwner")}
                              </p>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </section>
                )}

                {/* Danger zone */}
                <section className="card border-red-100 p-5">
                  <div className="mb-4 flex items-center gap-2">
                    <ShieldOff className="h-4 w-4 text-red-400" strokeWidth={1.75} />
                    <h2 className="text-sm font-semibold text-red-600">{t(dict, "settings.account.dangerZone")}</h2>
                  </div>
                  <p className="mb-4 text-sm text-slate-500">
                    {t(dict, "settings.account.deleteDesc")}
                  </p>
                  <DeleteAccountButton />
                </section>
              </div>
            )}

          </main>
        </div>
      </div>
    </>
  );
}
