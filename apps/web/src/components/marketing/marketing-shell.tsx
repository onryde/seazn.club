// Marketing display face: same Barlow Condensed config as the public tree
// (see src/app/slideshow/layout.tsx) but on its own --mk-font-display var so
// the --ps-* public theme layer stays untouched.
import { Barlow_Condensed } from "next/font/google";
import { MarketingNav } from "@/components/marketing-nav";
import { BackButton } from "@/components/marketing/back-button";
import { MarketingFooter } from "@/components/marketing-footer";
import { showBackButton } from "@/components/marketing/show-back-button";

const displayFont = Barlow_Condensed({
  weight: ["500", "600", "700"],
  subsets: ["latin"],
  variable: "--mk-font-display",
});

export function MarketingShell({
  variant = "light",
  lang = "en",
  hideBackButton = false,
  children,
}: {
  variant?: "night-scroll" | "light";
  /** Active locale for the shared nav + footer copy. Marketing [lang] pages
   *  pass their segment; English-canonical trees (help/developers/games/legal)
   *  keep the default. */
  lang?: string;
  /** Opt out of the shared BackButton (browser-history-back with a home
   *  fallback only when there's no history at all). Games listing (2026-08-27
   *  feedback): reaching /games via chess-quest's own "← Games" link is a
   *  forward navigation, so the shared button's browser-back lands back in
   *  chess-quest instead of anywhere useful — /games doesn't need "back" at
   *  all, it's a top-level page. Every other MarketingShell caller keeps the
   *  button (default false). */
  hideBackButton?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={`${displayFont.variable} flex min-h-screen flex-col`}>
      <MarketingNav variant={variant} lang={lang} />
      {showBackButton(variant, hideBackButton) ? (
        <div className="mx-auto w-full max-w-6xl px-4 pt-4">
          <BackButton />
        </div>
      ) : null}
      <div className="flex-1">{children}</div>
      <MarketingFooter lang={lang} />
    </div>
  );
}
