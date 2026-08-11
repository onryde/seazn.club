import Link from "@/components/ui/console-link";
import { CircleUserRound, LayoutDashboard, Settings, Users } from "lucide-react";
import { HelpMenu } from "@/components/help-menu";
import { getActiveOrgId, getCurrentUser, getUserOrgs } from "@/lib/auth";
import { pickActiveOrg } from "@/lib/active-org";
import { hasClaimedProfile } from "@/server/usecases/me";
import { routes } from "@/lib/routes";
import { needsTourAfterOnboarding } from "@/lib/activation";
import { EDITOR_ROLES } from "@/lib/types";
import { LogoutButton } from "@/components/logout-button";
import { ProductTour } from "@/components/product-tour";
import { hasAnyCompetitions } from "@/server/usecases/competitions";
import { resolveLocale } from "@/lib/resolve-locale";
import { getDictionary, t, type Dict } from "@/lib/i18n";

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
  if (user) {
    const orgs = await getUserOrgs(user.id);
    if (orgs.length > 0) {
      const activeId = await getActiveOrgId();
      activeOrg = pickActiveOrg(orgs, { pathSlug: orgSlug, cookieOrgId: activeId });
    }
  }
  const logoUrl = activeOrg ? orgLogoUrl(activeOrg) : null;
  const isPlayer = !!user && (await hasClaimedProfile(user.id));
  // #516: the 4-link dual-role nav (below) doesn't fit this row's #349
  // budget at 640-1023px with every label shown — the display-name span was
  // already the sole shrink target and was already fully collapsed, so the
  // 4th link just pushed "Sign out" past the viewport instead of wrapping or
  // shrinking. isPlayer is the only thing that adds a 4th link, so it's the
  // only case that needs the later reveal; the common 3-link header is
  // unchanged (still `sm:inline`, confirmed to hold at every matrix width).
  // Applied uniformly to all four labels — icons-together or labels-together,
  // never a mismatched partial collapse.
  const navLabelClass = isPlayer ? "hidden lg:inline" : "hidden sm:inline";
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
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo-wide-night.png" alt="Seazn Club" className="h-7 w-auto" />
        </Link>
        {user && activeOrg && (
          <span
            data-tour="org-chip"
            className="hidden shrink-0 items-center gap-1.5 rounded-full border border-cream/15 bg-cream/[0.07] px-3 py-1 text-xs font-medium text-cream/85 sm:flex"
          >
            <span className="h-1.5 w-1.5 rounded-full bg-lime-400" />
            {activeOrg.name}
          </span>
        )}

        {/* Spacer */}
        <div className="flex-1" />

        {/* Right: primary nav + user */}
        {user ? (
          // min-w-0 (#349): without it, this row reports its own UNSHRUNK
          // content width as its automatic minimum size to the header's
          // outer flex row above — the outer row then never asks it to give
          // up any space at all, and the display_name span below never gets
          // a chance to shrink no matter what class it carries.
          <div className="flex min-w-0 items-center gap-1">
            {/* shrink-0 (#349, fix round 2): this row's default CSS makes
                EVERY child shrinkable once the row itself has `min-w-0` —
                not just the display_name span below. English labels
                ("Dashboard"/"Directory"/"Settings") happen to be single
                unbreakable words, so this never visibly wrapped in the
                English-only e2e matrix, but `nav.dashboard` is "Tableau de
                bord" in fr and `nav.playerHome` is "Player home" / "Accueil
                joueur" / "Inicio del jugador" — multi-word labels with real
                wrap points that would hit the exact "Sign out" failure fix
                round 1 found, invisibly to every automated check here. */}
            <nav className="flex shrink-0 items-center gap-0.5">
              {/* Labels collapse to icons under `sm` (navLabelClass: `lg` for
                  the 4-link dual-role case, #516 above) — aria-label keeps
                  the accessible name either way (axe link-name, v3/11 gap 11). */}
              <Link
                href={activeOrg ? routes.orgHome(activeOrg.slug) : "/orgs/new"}
                aria-label={t(dict, "nav.dashboard")}
                className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm font-medium text-cream/85 transition-colors hover:bg-cream/10 hover:text-cream sm:px-3"
              >
                <LayoutDashboard className="h-4 w-4" strokeWidth={1.75} />
                <span className={navLabelClass}>{t(dict, "nav.dashboard")}</span>
              </Link>
              <Link
                href="/directory"
                aria-label={t(dict, "nav.directory")}
                className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm font-medium text-cream/85 transition-colors hover:bg-cream/10 hover:text-cream sm:px-3"
              >
                <Users className="h-4 w-4" strokeWidth={1.75} />
                <span className={navLabelClass}>{t(dict, "nav.directory")}</span>
              </Link>
              <Link
                href={activeOrg ? routes.orgSettings(activeOrg.slug) : "/orgs/new"}
                aria-label={t(dict, "nav.settings")}
                className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm font-medium text-cream/85 transition-colors hover:bg-cream/10 hover:text-cream sm:px-3"
              >
                <Settings className="h-4 w-4" strokeWidth={1.75} />
                <span className={navLabelClass}>{t(dict, "nav.settings")}</span>
              </Link>
              {/* Dual-role seam (PROMPT-53): an organiser who is ALSO a
                  claimed player keeps a door to their own player home.
                  #516: a 4th icon is ~32px more than Dashboard/Directory/
                  Settings alone (proven to hold at every matrix width on
                  their own) — below 350px even icon-only four don't fit
                  (measured: 8px overflow at 330px, 0 at 340px; 350px keeps
                  clear of both that seam and the 320/360 matrix widths on
                  either side). `hidden min-[350px]:flex` is scoped to THIS
                  link only — Dashboard/Directory/Settings are unaffected at
                  every width, and this link still degrades icons-only up to
                  `lg` same as the rest (navLabelClass above). */}
              {isPlayer && (
                <Link
                  href={routes.me()}
                  aria-label={t(dict, "nav.playerHome")}
                  className="hidden min-[350px]:flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm font-medium text-cream/85 transition-colors hover:bg-cream/10 hover:text-cream sm:px-3"
                >
                  <CircleUserRound className="h-4 w-4" strokeWidth={1.75} />
                  <span className={navLabelClass}>{t(dict, "nav.playerHome")}</span>
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
            {/* #349: at 640-1023px (labels visible, `lg:` grid not yet on)
                the gantry's right-hand group has no slack left — an
                unclamped display_name forces the whole row past the
                viewport (measured: needs ~775px of the ~768px tablet-768
                has). `min-w-0` lets this flex child give up its automatic
                content-based minimum size — it renders at full width
                whenever there's room, and `truncate` only engages once the
                row runs out of space, self-scoping to exactly the width
                band that's tight instead of a hardcoded cap.
                This is the ONLY child here meant to give up space: the org
                chip above, the `<nav>` links wrapper, and the LogoutButton
                below all carry an explicit `shrink-0` for exactly that
                reason (HelpMenu is icon-only, no text, incidentally safe
                either way) — the guard set is what makes this span
                architecturally the sole shrink target, not an accident of
                which labels happen to be short enough today. Plain nested
                flex-shrink does not automatically concentrate 100% of a
                squeeze onto the one item with `min-w-0` — any OTHER text
                that can still wrap at a word boundary (no `shrink-0` of its
                own) gets dragged into the same squeeze and wraps too,
                which is worse than the overflow this fix exists to close.
                Confirmed by measurement: with `min-w-0` on this span alone,
                "Sign out" and "My organization" both wrapped to two lines
                at 768px before those `shrink-0`s were added — and without
                one on `<nav>`, the same failure was reachable in any
                locale whose labels aren't single unbreakable words (fr:
                "Tableau de bord"), just never exercised by this
                English-only e2e matrix. */}
            <span className="mx-1 hidden min-w-0 truncate text-sm font-medium text-cream/85 sm:block">
              {user.display_name}
            </span>
            <LogoutButton label={t(dict, "nav.signOut")} />
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
