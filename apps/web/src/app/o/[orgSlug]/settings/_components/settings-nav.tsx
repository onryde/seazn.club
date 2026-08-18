import Link from "@/components/ui/console-link";
import {
  Building2, Users, CreditCard, UserCircle, KeyRound, Banknote,
  Handshake, Newspaper, Sparkles, PackagePlus, SlidersHorizontal,
  type LucideIcon,
} from "lucide-react";
import { routes } from "@/lib/routes";
import { t, type Dict } from "@/lib/i18n";
import { ScrollActiveTabIntoView } from "@/components/ui/scroll-active-tab-into-view";

/** Panels the tabbed Settings index renders inline (`?tab=`). */
export type SettingsTab =
  | "organization"
  | "news"
  | "sponsors"
  | "team"
  | "api"
  | "preferences"
  | "account";

export const SETTINGS_TABS: readonly SettingsTab[] = [
  "organization", "news", "sponsors", "team", "api", "preferences", "account",
] as const;

/**
 * Everything the sidebar can mark active. The four route-owning pages
 * (each owns a Stripe reconcile-on-return round trip, or its own gate) are
 * not `?tab=` panels, but they ARE Settings — before this component they
 * rendered with no sidebar at all, so landing on Billing dropped you out of
 * the navigation you arrived through.
 */
export type SettingsNavKey = SettingsTab | "connect" | "billing" | "credits" | "add-ons";

type Item = {
  key: SettingsNavKey;
  labelKey: string;
  icon: LucideIcon;
  href: (orgSlug: string) => string;
};

const ITEMS: readonly Item[] = [
  { key: "organization", labelKey: "settings.nav.organization", icon: Building2,        href: (o) => routes.orgSettings(o, "organization") },
  { key: "news",         labelKey: "news.tab",                  icon: Newspaper,        href: (o) => routes.orgSettings(o, "news") },
  { key: "sponsors",     labelKey: "sponsors.title",            icon: Handshake,        href: (o) => routes.orgSettings(o, "sponsors") },
  { key: "team",         labelKey: "settings.nav.team",         icon: Users,            href: (o) => routes.orgSettings(o, "team") },
  { key: "api",          labelKey: "settings.nav.api",          icon: KeyRound,         href: (o) => routes.orgSettings(o, "api") },
  { key: "preferences",  labelKey: "settings.nav.preferences",  icon: SlidersHorizontal, href: (o) => routes.orgSettings(o, "preferences") },
  { key: "account",      labelKey: "settings.nav.account",      icon: UserCircle,       href: (o) => routes.orgSettings(o, "account") },
  { key: "connect",      labelKey: "payments.title",            icon: Banknote,         href: (o) => routes.connect(o) },
  { key: "billing",      labelKey: "payments.planBilling",      icon: CreditCard,       href: (o) => routes.billing(o) },
  { key: "credits",      labelKey: "settings.nav.credits",      icon: Sparkles,         href: (o) => routes.credits(o) },
  { key: "add-ons",      labelKey: "settings.nav.addOns",       icon: PackagePlus,      href: (o) => routes.addOns(o) },
] as const;

/**
 * The Settings sidebar — one component for the tabbed index AND the four
 * route-owning pages, so the menu is present on every Settings surface.
 *
 * Desktop: a static left rail. Phones: a sticky horizontal strip pinned below
 * the gantry header (which is also sticky at top:0 — pinning both to 0 makes
 * them compete and this row loses, scrolling out of view entirely).
 *
 * `ScrollActiveTabIntoView` is not decoration: eleven items never fit a 320px
 * strip, so without it you land on Billing and cannot see which item is
 * selected. A no-horizontal-scroll gate cannot catch that — the strip is meant
 * to scroll. `className="contents"` keeps its wrapper out of the box tree, so
 * the sticky `<nav>` still resolves its containing block against `<aside>`;
 * a real wrapper div would be exactly nav-height and leave sticky nowhere to
 * travel.
 */
export function SettingsNav({
  orgSlug,
  active,
  dict,
}: {
  orgSlug: string;
  active: SettingsNavKey;
  dict: Dict;
}) {
  return (
    <aside className="w-full md:w-44 md:shrink-0">
      <p className="mb-3 hidden px-3 text-[11px] font-semibold uppercase tracking-wider text-slate-500 md:block">
        {t(dict, "settings.nav.title")}
      </p>
      <ScrollActiveTabIntoView className="contents">
        <nav className="scroll-x scroll-x-fade sticky top-[var(--app-header-h)] z-30 -mx-4 flex gap-1 whitespace-nowrap bg-[var(--background)]/90 px-4 py-2 backdrop-blur md:static md:z-auto md:mx-0 md:block md:space-y-0.5 md:bg-transparent md:p-0 md:backdrop-blur-none">
          {ITEMS.map(({ key, labelKey, icon: Icon, href }) => {
            const isActive = active === key;
            return (
              <Link
                key={key}
                href={href(orgSlug)}
                aria-current={isActive ? "page" : undefined}
                className={`flex shrink-0 items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition ${
                  isActive
                    ? "bg-purple-100 font-medium text-purple-800"
                    : "text-slate-600 hover:bg-purple-50 hover:text-purple-700"
                }`}
              >
                <Icon
                  className={`h-4 w-4 shrink-0 ${isActive ? "text-purple-600" : "text-slate-500"}`}
                  strokeWidth={1.75}
                />
                {t(dict, labelKey)}
              </Link>
            );
          })}
        </nav>
      </ScrollActiveTabIntoView>
      <div className="my-4 hidden border-t border-purple-100 md:block" />
      <Link
        href={routes.orgHome(orgSlug)}
        className="hidden rounded-lg px-3 py-2 text-sm text-slate-500 transition hover:bg-slate-50 hover:text-slate-600 md:block"
      >
        ← {t(dict, "settings.nav.backToCompetitions")}
      </Link>
    </aside>
  );
}

/**
 * The two-column shell the tabbed index has always used. The four
 * route-owning pages adopt it so the sidebar sits in the same place on every
 * Settings surface rather than each page inventing its own container.
 */
export function SettingsShell({
  orgSlug,
  active,
  dict,
  showNav = true,
  children,
}: {
  orgSlug: string;
  active: SettingsNavKey;
  dict: Dict;
  /**
   * `false` for a PAYER who is not a member of this org (v17 gap #333).
   * Billing, Credits and Add-ons are reachable through the bill; every link in
   * this sidebar points at a member-gated route, so showing it to a payer
   * would be a menu of eleven 404s. They fall back to the standalone column
   * these pages have always used.
   */
  showNav?: boolean;
  children: React.ReactNode;
}) {
  if (!showNav) return <main className="mx-auto max-w-3xl px-4 py-8">{children}</main>;
  return (
    <div className="mx-auto max-w-5xl px-4 py-4 md:py-8">
      <div className="flex flex-col gap-4 md:flex-row md:gap-8">
        <SettingsNav orgSlug={orgSlug} active={active} dict={dict} />
        <main className="min-w-0 flex-1">{children}</main>
      </div>
    </div>
  );
}
