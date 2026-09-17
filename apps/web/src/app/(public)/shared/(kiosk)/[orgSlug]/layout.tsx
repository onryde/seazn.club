// The /present kiosk's org layout (K-1, 2026-09-15). A venue TV board must span
// the screen, so the two /present pages live in this `(kiosk)` route group
// instead of under `[orgSlug]/layout.tsx`, whose sticky header, `max-w-5xl`
// main and footer boxed the board in the middle of a TV. The group is not in
// the URL: the boards keep `/shared/{org}/{comp}/present` and
// `/shared/{org}/{comp}/{div}/present`.
//
// What the kiosk still needs from the org tree, and gets here:
// - the org door, minus its verdict on an absent org: a reserved slug still
//   404s here (`publicOrgOrNull`), but a missing-or-renamed org is left to the
//   board page. See `org-guard.ts` for why — in one line, a layout holds only
//   `orgSlug`, so any redirect it issues drops `/{comp}/present` and lands a TV
//   on the org hub (K fix round, F2, measured);
// - the scoreboard display face, mounted as `--ps-font-display` (the same
//   weights as the chrome layout, as `app/embed/layout.tsx` also does);
// - the org's brand palette on the root, so a board without its own branding
//   still wears the org's;
// - `<html lang>` in the org's language, as the chrome layout sets it (a TV
//   board has no visitor cookie to correct it from).
// And nothing else: no header, no <main>, no footer.
import { Barlow_Condensed } from "next/font/google";
import { HtmlLang } from "@/components/i18n/html-lang";
import { toLocale } from "@/lib/i18n-constants";
import { publicThemeStyle } from "@/lib/public-theme";
import { publicOrgOrNull } from "@/server/public-site/org-guard";

const displayFont = Barlow_Condensed({
  weight: ["500", "600", "700"],
  subsets: ["latin"],
  variable: "--ps-font-display",
});

export const revalidate = 30;

export default async function KioskOrgLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  // `data` is null for an org that is renamed, deleted, or was never there, and
  // this layout deliberately does not tell those apart: the board page below
  // does, with the full path in hand, and a page's thrown redirect/notFound
  // wins the response — so the unthemed wrapper returned in that state is never
  // actually served. `publicThemeStyle(undefined)` yields no style attribute,
  // which keeps that the SAME branch rather than a second phantom shell.
  const data = await publicOrgOrNull(orgSlug);
  return (
    <div
      data-testid="kiosk-org-root"
      style={publicThemeStyle(data?.org.branding)}
      className={`${displayFont.variable} min-h-screen bg-canvas text-ink`}
    >
      {data ? <HtmlLang lang={toLocale(data.org.default_locale)} /> : null}
      {children}
    </div>
  );
}
