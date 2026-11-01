import Link from "@/components/ui/console-link";
import { CircleUserRound, Handshake, LayoutDashboard, Radio, Settings, Users } from "lucide-react";
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
  if (user) {
    const orgs = await getUserOrgs(user.id);
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
  // #516: the 4-link dual-role nav (below) doesn't fit this row's #349
  // budget at 640-1023px with every label shown — the display-name span was
  // already the sole shrink target and was already fully collapsed, so the
  // 4th link just pushed "Sign out" past the viewport instead of wrapping or
  // shrinking. isPlayer is the only thing that adds a 4th link, so it's the
  // only case that needs the later reveal; the common 3-link header was left
  // on `sm:inline`, "confirmed to hold at every matrix width" — a claim the
  // next paragraph corrects.
  // Applied uniformly to all four labels — icons-together or labels-together,
  // never a mismatched partial collapse.
  //
  // Competition desk W3 (review m4's own new 700px leg): the 3-link case did
  // NOT hold at every width — only at every MATRIX width. The seven projects
  // are 320/360/375/390/430/768/834, so nothing has ever loaded this header
  // between 640 and 767, which is exactly where `sm:inline` turns three
  // labels back on. Measured on the competition page at 700: the gantry needs
  // ~749px and "Sign out" is clipped 49px past the viewport — the identical
  // failure #516 fixed for the 4-link case, in the band its own fix did not
  // cover. Same remedy, one breakpoint later: labels return at `md` (768),
  // the first width anything actually verifies. No matrix width changes
  // behaviour (below 640 was already icons; 768 and up still shows labels),
  // so this closes a live clipping defect without moving any gate.
  //
  // Streaming (2026-10-27) made it five items, and the budget above stopped holding. Measured in a browser, every width x
  // locale, Sign out ran past the viewport: 18px at 320 and 3px at 335 (all four locales, the 4-link org nav), 22px at 350 and
  // 12px at 360 (a claimed player: five icons), fr 768-836 (74px at 768) and nl 768-780 (14px) where the labels are on. Owner,
  // 2026-10-28, "tighten": three levers and no more. (1) Below `sm` each link's side padding is 6px, not 8, and the links
  // touch (gap-0): 4px of width each and 6px of gap, 22px on the 4-link nav and 28px on the 5-link one, which is what 320 and
  // 350 needed; icons, type and link height are unchanged. (2) Sign out is its icon alone below `lg` (LogoutButton
  // `labelFrom="lg"`; aria-label and title keep its translated name), worth 70-109px in the 768-1023 band. (3) Nothing else
  // moves: tablets keep their labels (`md` for four links, `lg` for five), the display name and the org chip are as they were.
  // The new budget fits at 320, 335, 350, 360, 390, 640, 700, 768, 800, 836, 1023, 1024 and 1280 in en/es/fr/nl, for both the
  // org nav and the dual-role nav (the report's table); the tightest cell is 4px of slack at 320.
  //
  // B3 (CI e2e, nav-org-chip-overflow "the chip still SHOWS the club name at 768"): the fifth labelled item fitted the row but left the
  // org chip 37px of text at 768, against the 8 characters (64px) the chip exists to show. The row's only flexible item is that chip,
  // so what the labelled links cost it is what it loses. Where the labels are on (`md` to `lg`, the 4-link org nav only) the links'
  // side padding is 4px, not 12, and returns to 12 at `lg`. Measured with the 38-character club name: 8px and 6px each leave fr
  // at 768 short of 8 characters (40px and 56px visible of 60.7 needed; nl 60px at 8px); 4px clears every cell at 768/800/836/900/1023
  // in en/es/fr/nl (72px visible at the tightest, fr 768, and 114px in en). Nothing else moves: labels, type, link height, the display
  // name and Sign out are as they were. The dual-role nav is icon-only until `lg`, has the room, and keeps its 12px - a 4px pad on a
  // bare 16px icon would be a 24px target.
  //
  // R4 sponsors-on-stream S11 (OWNER RULING 2026-10-31, "a") added a Sponsors link, `hidden min-[350px]:flex` (the Player-home
  // precedent), and made the label rung follow the LINK COUNT instead of `isPlayer` alone - the owner's own rule from the
  // "tighten" ruling above, "md for four links, lg for five", applied to the count the bar now really has. At >= 350 a bar has
  // Dashboard, Directory, Sponsors and Settings, plus Streaming and Player home where they apply: 4, 5 or 6 links.
  // Measured (Geist metrics, every locale, the B3 formula that reproduced 113 and 72px at 768): a streaming org's FIVE labelled
  // links at `md` leave the chip 20/35/0/15px at 768 (en/es/fr/nl) against the 8 characters (61px) B3 exists to keep, and fr
  // overflows by 6px - so five wait for `lg`. Six labelled links at `lg` overflow 1024-1100 in es/fr/nl (fr by 93px at 1024), so
  // six wait for `xl` (1280: Sign out inside by 35px in fr, the tightest cell). Icons-together or labels-together, never a
  // mismatched partial collapse: all links of a bar take the same rung.
  //
  // Phones, same ruling: Sign out's right edge is at 28N + 204 for N icon links (the 4-link nav's 4px at 320 and the 5-link
  // nav's 6px at 350, as measured above), so the worst case - Streaming + a claimed player - needs 372px for six links and
  // overflows 350 (by 22px) and 360 (by 12px). Player home folds first: for a streaming org it is `hidden min-[390px]:flex`
  // (five of the six links are shown 350-389 with 6/16/31px to spare at 350/360/375, all six from 390 with 18px), and it keeps the 350 precedent for an
  // org without Streaming, whose five links already fit (6px at 350). 320 shows four whatever the org (Sponsors is hidden below
  // 350). That is the whole fold order: nothing else moves.
  const navLinkCount = 4 + (streamingOffered ? 1 : 0) + (isPlayer ? 1 : 0);
  const labelRung = navLinkCount <= 4 ? "md" : navLinkCount === 5 ? "lg" : "xl";
  // Written out in full: Tailwind only emits classes it can read as whole strings.
  const navLabelClass = { md: "hidden md:inline", lg: "hidden lg:inline", xl: "hidden xl:inline" }[labelRung];
  const navLinkLook = `items-center gap-1.5 rounded-md px-1.5 py-1.5 text-sm font-medium text-cream/85 transition-colors hover:bg-cream/10 hover:text-cream sm:px-3${labelRung === "md" ? " md:px-1 lg:px-3" : ""}`;
  const navLinkClass = `flex ${navLinkLook}`;
  // `hidden` + `min-[Npx]:flex` and never a bare `flex` beside them: two display utilities fight by CSS order.
  const sponsorsLinkClass = `hidden min-[350px]:flex ${navLinkLook}`;
  const playerHomeLinkClass = streamingOffered ? `hidden min-[390px]:flex ${navLinkLook}` : `hidden min-[350px]:flex ${navLinkLook}`;
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
          // a clipped "Sign out" costs the session. The right group keeps its
          // own `min-w-0` so `display_name` can still shrink INSIDE it once
          // this chip has run out, exactly as #349 intends.
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
            <nav className="flex shrink-0 items-center gap-0 sm:gap-0.5">
              {/* Labels collapse to icons under `md` (navLabelClass: `lg` for
                  the 4-link dual-role case, #516 above; `md` rather than the
                  original `sm` since W3 measured the 640-767 band no width
                  project covers) — aria-label keeps the accessible name
                  either way (axe link-name, v3/11 gap 11). */}
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
              {/* Sponsors (R4 S11, owner ruling 2026-10-31 "a"): the top-level hub, an icon under 350 hidden entirely - the org
                  Dashboard carries a Sponsors entry at every width. See the budget note above `navLinkCount`. Shown to every
                  role: the hub itself decides what a non-editor sees (read-only Overview and Sponsors, as Settings gave). */}
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
              <Link
                href={activeOrg ? routes.orgSettings(activeOrg.slug) : "/orgs/new"}
                aria-label={t(dict, "nav.settings")}
                className={navLinkClass}
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
                  its label rung same as the rest (navLabelClass above). */}
              {isPlayer && (
                <Link
                  href={routes.me()}
                  aria-label={t(dict, "nav.playerHome")}
                  className={playerHomeLinkClass}
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
            {/* `lg:block`, not `sm:block` (2026-09-21): at 768-1023 this span
                and the org chip are the only two flexible things in the
                gantry, and there is not enough room for both — at 768 the
                inner row is 736px against 80 (logo) + 48 (gaps) + 553
                (this group) + the chip, which left the chip 55px: a lime
                dot and a single letter. Measured, not reasoned.
                Which CLUB you are administering is the thing that changes
                between sessions and the thing a misclick gets wrong, and
                the chip is the only tenant indicator in the chrome; your
                OWN name is not news to you and was itself truncated to
                "Chip Own..." in this band anyway. So the 76px this span
                costs goes to the chip, which takes it from 55px to 143px —
                enough for the club name to actually be read. The avatar
                beside it keeps the account affordance at every width, and
                at 1024+ nothing changes: both render in full. */}
            <span className="mx-1 hidden min-w-0 truncate text-sm font-medium text-cream/85 lg:block">
              {user.display_name}
            </span>
            <LogoutButton label={t(dict, "nav.signOut")} labelFrom="lg" />
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
