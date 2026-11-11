import Link from "@/components/ui/console-link";
import { Handshake, LayoutDashboard, Radio, Users } from "lucide-react";
import { HelpMenu } from "@/components/help-menu";
import { AccountMenu, type AccountMenuLabels } from "@/components/account-menu";
import { getActiveOrgId, getCurrentUser, getUserOrgs } from "@/lib/auth";
import { pickActiveOrg } from "@/lib/active-org";
import { hasClaimedProfile } from "@/server/usecases/me";
import { routes } from "@/lib/routes";
import { needsTourAfterOnboarding } from "@/lib/activation";
import { EDITOR_ROLES, ORG_ROLES, type OrgMembership } from "@/lib/types";
import { ProductTour } from "@/components/product-tour";
import { hasAnyCompetitions } from "@/server/usecases/competitions";
import { resolveLocale } from "@/lib/resolve-locale";
import { getDictionary, t, type Dict } from "@/lib/i18n";
import { STREAMING_PAGE_HREF } from "@/lib/youtube";
import { captureError } from "@/lib/sentry";
import { streamingPageAccess } from "@/server/stream-panel-context";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";

/** Plain tour-copy slice (keys `tour.*`) for the client ProductTour island —
 *  crosses the RSC boundary as serializable props. */
function tourDict(dict: Dict): Record<string, string> {
  return Object.fromEntries(
    Object.entries(dict)
      .filter(([k]) => k.startsWith("tour."))
      .map(([k, v]) => [k, String(v)]),
  );
}

function orgLogoUrl(org: { logo_storage_path: string | null; logo_url: string | null }): string | null {
  if (org.logo_storage_path && SUPABASE_URL)
    return `${SUPABASE_URL}/storage/v1/object/public/assets/${org.logo_storage_path}`;
  if (org.logo_url?.startsWith("https://")) return org.logo_url;
  return null;
}

/** `orgSlug` is the org the PATH is about (/o/[orgSlug] pages pass it). It wins
 *  over the seazn_org cookie, which lags a link-driven org switch by a render —
 *  see pickActiveOrg. Chrome outside the /o tree omits it and stays cookie-led. */
export async function Nav({ orgSlug }: { orgSlug?: string } = {}) {
  // Console chrome locale (v5 i18n cycle 46): cookie → user → header → en. Nav
  // already reads cookies via getCurrentUser(), so it is dynamic regardless.
  const locale = await resolveLocale();
  const dict = await getDictionary(locale, "console");
  const user = await getCurrentUser();
  let activeOrg: {
    id: string;
    name: string;
    slug: string;
    role: string;
    logo_storage_path: string | null;
    logo_url: string | null;
  } | null = null;
  let orgs: OrgMembership[] = [];
  if (user) {
    orgs = await getUserOrgs(user.id);
    if (orgs.length > 0) {
      const activeId = await getActiveOrgId();
      activeOrg = pickActiveOrg(orgs, { pathSlug: orgSlug, cookieOrgId: activeId });
    }
  }
  const logoUrl = activeOrg ? orgLogoUrl(activeOrg) : null;
  // The Streaming item (owner, 2026-10-27) is shown to exactly the orgs the Streaming page exists for — the page's own predicate
  // (`streamingPageAccess`: the whole page, or the disconnect-only page an editor of an org that cannot go live still gets while it holds
  // a YouTube connection), asked for the org the chrome is showing, never guessed client-side. A failed read hides the item (and is reported): the chrome
  // must not take a page down, and a missing link is the honest fail-closed answer for a page that would 404.
  let streamingOffered = false;
  if (activeOrg) {
    try {
      streamingOffered = (await streamingPageAccess(activeOrg.id, (EDITOR_ROLES as readonly string[]).includes(activeOrg.role))) !== "none";
    } catch (err) {
      captureError(err, { orgId: activeOrg.id, route: "nav.streaming_offered" });
    }
  }
  const isPlayer = !!user && (await hasClaimedProfile(user.id));
  // The bar's width budget. History: #349/#516/W3/B3 and the R4 rulings (2026-10-28 "tighten", 2026-11-01 Settings and Sign out
  // as icons) - git log carries the measurements. The account menu (owner, Option A, 2026-11-11) took the Settings icon, the
  // display name, Sign out and Player home out of the bar: they live in the menu now, and the bar ends in ONE trigger - the
  // avatar, and from `lg` the name beside it - so a claimed player's bar is the same bar as everyone else's, and the old
  // dual-role label rung (labels from `lg`) went with Player home.
  //   - Labels collapse to icons below `md` (nothing verifies 640-767; W3) and come on at `md`, for every bar.
  //   - Phones: every link is a 28px icon (6px a side, `px-1.5`) and the links touch (`gap-0`). Sponsors keeps its fold - `hidden
  //     min-[350px]:flex`, `min-[390px]` for an org with a logo, whose crest puts 38px more in the row - and the org's
  //     Competitions home carries a Sponsors entry at every width. Below 360 a logo org's wordmark gives its place to the crest
  //     (`max-[360px]:sr-only`: out of the row, still the home link's name). Both folds are the 2026-11-01 bar's, unchanged:
  //     the one trigger is narrower than the gear and the door it replaced.
  //   - From `md`, on a bar WITH an org, the labelled links give room back to the org chip's club name (the row's one flexible
  //     item): `md:px-1 md:gap-1` in the md band, main's 12px and 6px gap from `lg`, the links touching (`md:gap-0`). A bar
  //     without an org keeps B3's `md:px-1 lg:px-3`.
  //   - Every gantry control is one 32px box (`min-h-8`), icon or labelled, so nothing in this `items-center` row sits 2px low.
  const navLabelClass = "hidden md:inline";
  const hasOrg = !!activeOrg;
  const navLinkBase = "min-h-8 items-center gap-1.5 rounded-md px-1.5 py-1.5 text-sm font-medium text-cream/85 transition-colors hover:bg-cream/10 hover:text-cream sm:px-3";
  const navLinkLook = `${navLinkBase}${hasOrg ? " md:gap-1 md:px-1 lg:gap-1.5 lg:px-3" : " md:px-1 lg:px-3"}`;
  const navLinkClass = `flex ${navLinkLook}`;
  // `hidden` + a min-width `flex` breakpoint and never a bare `flex` beside them: two display utilities fight by CSS order.
  // Literal strings, every one: Tailwind only builds the classes it can read in the source.
  const hasLogo = !!logoUrl;
  const sponsorsLinkClass = `${hasLogo ? "hidden min-[390px]:flex" : "hidden min-[350px]:flex"} ${navLinkLook}`;
  // The account menu's copy and its org list. Role names, the Account tab's name, the "Organisation" caption and "Switching..."
  // are the `ui` catalog's own words (the settings rail and its org switcher say the same things); the menu's own strings are
  // `console` keys.
  const ui = user ? await getDictionary(locale, "ui") : null;
  const accountLabels: AccountMenuLabels | null = ui
    ? {
        menu: t(dict, "nav.account.menu"),
        organisation: t(ui, "settings.nav.group.organisation"),
        newOrg: t(dict, "nav.account.newOrg"),
        orgSettings: t(dict, "nav.account.orgSettings"),
        profile: t(ui, "settings.nav.account"),
        playerHome: t(dict, "nav.playerHome"),
        signOut: t(dict, "nav.signOut"),
        switching: t(ui, "settings.org.switch.busy"),
        roles: Object.fromEntries(
          ORG_ROLES.filter((r) => !(EDITOR_ROLES as readonly string[]).includes(r)).map((r) => [r, t(ui, `role.${r}`)]),
        ),
      }
    : null;
  const menuOrgs = orgs.map((o) => ({ id: o.id, name: o.name, slug: o.slug, role: o.role, logoUrl: orgLogoUrl(o) }));
  // Tour targets editor flows (rename org, create competition) — viewers skip it.
  const canTour =
    !!user && !!activeOrg && (EDITOR_ROLES as readonly string[]).includes(activeOrg.role);
  // Sequence: the tour only auto-starts once onboarding is complete.
  const tourPending = canTour && (await needsTourAfterOnboarding(user!.id));
  // The tour's first step is a centered "welcome" card with no target — on a
  // brand-new org (zero competitions) it lands directly on top of the
  // org-home empty-state CTA it's meant to explain. That CTA already does the
  // tour's job there, so skip the auto-open until there's a competition to
  // walk through; the tour stays reachable manually (Settings ▸ Product tour).
  const tourReady =
    tourPending && activeOrg
      ? await hasAnyCompetitions({
          orgId: activeOrg.id,
          userId: user!.id,
          // Only orgId drives the tenant-scoped query below — role is unused.
          role: null,
          via: "session",
          keyId: null,
        })
      : false;

  return (
    // The gantry (floodlit-console spec §4): night chrome closed by the
    // sticky lime hairline — the one place the chrome touches the pitch.
    <header className="app-gantry sticky top-0 z-20">
      <div className="mx-auto flex max-w-6xl items-center gap-4 px-4 h-14">

        {/* Left: wordmark + org scorebug. logo-wide-night.png is the cream
            wordmark with the pitch line + ball — legible on night chrome. */}
        <Link href="/" className="flex shrink-0 items-center gap-2.5">
          {logoUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={logoUrl} alt={t(dict, "nav.orgLogoAlt")} className="h-7 w-7 rounded-md object-cover ring-1 ring-cream/20" />
          )}
          {/* Below 360 an org with a logo shows its crest alone: the wordmark leaves the row (`sr-only`, never `hidden`, so the
              home link is still named "Seazn Club") - the fold paragraph above `navLabelClass`. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo-wide-night.png" alt="Seazn Club" className={hasLogo ? "h-7 w-auto max-[360px]:sr-only" : "h-7 w-auto"} />
        </Link>
        {user && activeOrg && (
          // `min-w-0 shrink` rather than `shrink-0`: this chip's width WAS the
          // org name's width, so a club with an ordinary full name ("North-
          // amptonshire Badminton Association", 38 chars) pushed the entire
          // right-hand group off the viewport — 126px of horizontal page
          // scroll at 768, 247px at 61 chars, on every signed-in surface.
          // Nothing caught it because every fixture org here is named in 2-17
          // characters, and at 17 the overflow is exactly 0.
          //
          // This is the same `min-w-0` rule the right-hand group already
          // documents at #349 below, applied to the one child on this side
          // that opted out of it: a flex item's automatic minimum size is its
          // CONTENT width, so `shrink` alone does nothing without `min-w-0`,
          // and `truncate` on the text needs an ancestor chain that can
          // actually reach zero. The lime status dot keeps `shrink-0` — it is
          // 6px and squashing it would cost the one thing the chip signals at
          // a glance.
          //
          // The name TRUNCATES rather than the chip dropping: which org you
          // are in is the whole point of the chip, and the full string stays
          // in the DOM for the product tour and screen readers.
          //
          // `shrink-[999]`, not a plain `shrink`, and the number is doing real
          // work. Flex distributes a deficit in proportion to each item's
          // BASE size, so an ordinary `shrink` had this chip surrender only
          // ~30% of it and handed the other ~70% to the right-hand group —
          // which cannot comply, because #349 below deliberately makes its nav
          // links `shrink-0`. The group was shrunk on paper to 386px while its
          // contents still needed 477px, and the Sign out button simply
          // rendered 75px outside the viewport. Measured, not reasoned: the
          // fix took the overflow from 126px to 58px and no further until the
          // ratio changed. A large factor makes this chip absorb essentially
          // the whole deficit before anything on the right gives up a pixel,
          // which is the correct priority — a clipped club name costs nothing,
          // a clipped account menu costs Settings and Sign out. The right group
          // keeps its own `min-w-0` so the trigger's display name can still
          // shrink INSIDE it once this chip has run out, exactly as #349 intends.
          <span
            data-tour="org-chip"
            className="hidden min-w-0 shrink-[999] items-center gap-1.5 rounded-full border border-cream/15 bg-cream/[0.07] px-3 py-1 text-xs font-medium text-cream/85 sm:flex"
          >
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-lime-400" />
            <span className="truncate">{activeOrg.name}</span>
          </span>
        )}

        {/* Spacer */}
        <div className="flex-1" />

        {/* Right: primary nav + user */}
        {user ? (
          // min-w-0 (#349): without it, this row reports its own UNSHRUNK
          // content width as its automatic minimum size to the header's
          // outer flex row above — the outer row then never asks it to give
          // up any space at all, and the trigger's display name never gets a
          // chance to shrink no matter what class it carries.
          <div className="flex min-w-0 items-center gap-1">
            {/* shrink-0 (#349): once this row has `min-w-0` every child is
                shrinkable, and a multi-word label ("Tableau de bord") would
                wrap to two lines rather than give way. The account trigger's
                display name is the ONE thing here meant to give up space. */}
            <nav className={`flex shrink-0 items-center gap-0 sm:gap-0.5${hasOrg ? " md:gap-0" : ""}`}>
              {/* Labels collapse to icons under `md` — aria-label keeps the
                  accessible name either way (axe link-name, v3/11 gap 11). */}
              <Link
                href={activeOrg ? routes.orgHome(activeOrg.slug) : "/orgs/new"}
                aria-label={t(dict, "nav.dashboard")}
                className={navLinkClass}
              >
                <LayoutDashboard className="h-4 w-4" strokeWidth={1.75} />
                <span className={navLabelClass}>{t(dict, "nav.dashboard")}</span>
              </Link>
              <Link
                href="/directory"
                aria-label={t(dict, "nav.directory")}
                className={navLinkClass}
              >
                <Users className="h-4 w-4" strokeWidth={1.75} />
                <span className={navLabelClass}>{t(dict, "nav.directory")}</span>
              </Link>
              {streamingOffered && (
                <Link
                  href={STREAMING_PAGE_HREF}
                  aria-label={t(dict, "nav.streaming")}
                  data-testid="nav-streaming"
                  className={navLinkClass}
                >
                  <Radio className="h-4 w-4" strokeWidth={1.75} />
                  <span className={navLabelClass}>{t(dict, "nav.streaming")}</span>
                </Link>
              )}
              {/* Sponsors (R4, owner ruling 2026-11-01): the top-level hub, a labelled link like its siblings, hidden entirely under
                  350 (390 for an org with a logo) - the org's Competitions home carries a Sponsors entry at every width. Shown
                  to every role: the hub itself decides what a non-editor sees. */}
              {activeOrg && (
                <Link
                  href={routes.orgSponsors(activeOrg.slug)}
                  aria-label={t(dict, "nav.sponsors")}
                  data-testid="nav-sponsors"
                  className={sponsorsLinkClass}
                >
                  <Handshake className="h-4 w-4" strokeWidth={1.75} />
                  <span className={navLabelClass}>{t(dict, "nav.sponsors")}</span>
                </Link>
              )}
            </nav>
            {/* The console "?" menu (v3/06 §3): closes on outside click/Esc. */}
            <HelpMenu
              labels={{
                menu: t(dict, "help.menu"),
                centre: t(dict, "help.centre"),
                developerDocs: t(dict, "help.developerDocs"),
                contactSupport: t(dict, "help.contactSupport"),
              }}
            />
            {/* The account menu (owner, Option A, 2026-11-11): who you are, which organisation (switch, or a new one),
                Organisation settings / Account / Player home, then Sign out. Last in the bar. */}
            {accountLabels && (
              <AccountMenu
                user={{ displayName: user.display_name, email: user.email || null }}
                orgs={menuOrgs}
                activeOrgId={activeOrg?.id ?? null}
                isPlayer={isPlayer}
                labels={accountLabels}
              />
            )}
          </div>
        ) : (
          <Link
            href="/login"
            className="btn bg-lime-400 font-semibold text-night hover:bg-lime-300"
          >
            {t(dict, "nav.signIn")}
          </Link>
        )}
      </div>
      {canTour && activeOrg && (
        <ProductTour autoStart={tourReady} orgSlug={activeOrg.slug} dict={tourDict(dict)} />
      )}
    </header>
  );
}
