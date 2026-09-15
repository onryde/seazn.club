// The /present kiosk's org layout (K-1, 2026-09-15). A venue TV board must span
// the screen, so the two /present pages live in this `(kiosk)` route group
// instead of under `[orgSlug]/layout.tsx`, whose sticky header, `max-w-5xl`
// main and footer boxed the board in the middle of a TV. The group is not in
// the URL: the boards keep `/shared/{org}/{comp}/present` and
// `/shared/{org}/{comp}/{div}/present`.
//
// What the kiosk still needs from the org tree, and gets here:
// - the org door: reserved slug / missing org 404, renamed org redirect
//   (`publicOrgOr404`, the same function the chrome layout calls);
// - the scoreboard display face, mounted as `--ps-font-display` (the same
//   weights as the chrome layout, as `app/embed/layout.tsx` also does);
// - the org's brand palette on the root, so a board without its own branding
//   still wears the org's.
// And nothing else: no header, no <main>, no footer.
import { Barlow_Condensed } from "next/font/google";
import { publicThemeStyle } from "@/lib/public-theme";
import { publicOrgOr404 } from "@/server/public-site/org-guard";

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
  const { org } = await publicOrgOr404(orgSlug);
  return (
    <div
      data-testid="kiosk-org-root"
      style={publicThemeStyle(org.branding)}
      className={`${displayFont.variable} min-h-screen bg-canvas text-ink`}
    >
      {children}
    </div>
  );
}
