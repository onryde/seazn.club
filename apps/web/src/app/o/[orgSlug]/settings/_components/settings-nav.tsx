import Link from "@/components/ui/console-link";
import {
  Building2, Users, CreditCard, UserCircle, KeyRound, Banknote,
  Handshake, Newspaper, Sparkles, PackagePlus, SlidersHorizontal,
  type LucideIcon,
} from "lucide-react";
import { routes } from "@/lib/routes";
import { t, type Dict } from "@/lib/i18n";
import { ScrollActiveTabIntoView } from "@/components/ui/scroll-active-tab-into-view";
import { orgPlanKey } from "@/lib/entitlements";
import { planLabel } from "@/lib/plan-label";
import { balance, walletIdFor } from "@/lib/credits";

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

/**
 * Eleven items is past the point where a flat list is scanned rather than
 * read. The groups are by STAKE, not by implementation: what the club is and
 * publishes, what it is charged and charges, and what belongs to the person
 * signed in. Nothing moves route — this is purely how the rail reads.
 *
 * Desktop only. A horizontal strip has no room for headers, and a phone user
 * scrolling a single row does not need them; the strip stays flat and scrolls
 * its active chip into view instead.
 */
type Group = "organisation" | "money" | "you";

type Item = {
  key: SettingsNavKey;
  labelKey: string;
  icon: LucideIcon;
  group: Group;
  href: (orgSlug: string) => string;
};

const GROUPS: readonly { group: Group; labelKey: string }[] = [
  { group: "organisation", labelKey: "settings.nav.group.organisation" },
  { group: "money",        labelKey: "settings.nav.group.money" },
  { group: "you",          labelKey: "settings.nav.group.you" },
] as const;

const ITEMS: readonly Item[] = [
  { key: "organization", labelKey: "settings.nav.organization", icon: Building2,        group: "organisation", href: (o) => routes.orgSettings(o, "organization") },
  { key: "news",         labelKey: "news.tab",                  icon: Newspaper,        group: "organisation", href: (o) => routes.orgSettings(o, "news") },
  { key: "sponsors",     labelKey: "sponsors.title",            icon: Handshake,        group: "organisation", href: (o) => routes.orgSettings(o, "sponsors") },
  { key: "team",         labelKey: "settings.nav.team",         icon: Users,            group: "organisation", href: (o) => routes.orgSettings(o, "team") },
  { key: "api",          labelKey: "settings.nav.api",          icon: KeyRound,         group: "organisation", href: (o) => routes.orgSettings(o, "api") },
  { key: "preferences",  labelKey: "settings.nav.preferences",  icon: SlidersHorizontal, group: "you", href: (o) => routes.orgSettings(o, "preferences") },
  { key: "account",      labelKey: "settings.nav.account",      icon: UserCircle,       group: "you", href: (o) => routes.orgSettings(o, "account") },
  { key: "connect",      labelKey: "payments.title",            icon: Banknote,         group: "money", href: (o) => routes.connect(o) },
  { key: "billing",      labelKey: "payments.planBilling",      icon: CreditCard,       group: "money", href: (o) => routes.billing(o) },
  { key: "credits",      labelKey: "settings.nav.credits",      icon: Sparkles,         group: "money", href: (o) => routes.credits(o) },
  { key: "add-ons",      labelKey: "settings.nav.addOns",       icon: PackagePlus,      group: "money", href: (o) => routes.addOns(o) },
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
function NavLink({
  item,
  orgSlug,
  active,
  dict,
}: {
  item: Item;
  orgSlug: string;
  active: SettingsNavKey;
  dict: Dict;
}) {
  const isActive = active === item.key;
  const Icon = item.icon;
  return (
    <Link
      href={item.href(orgSlug)}
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
      {t(dict, item.labelKey)}
    </Link>
  );
}

/**
 * The Settings sidebar — one component for the tabbed index AND the four
 * route-owning pages, so the menu is present on every Settings surface.
 *
 * TWO renderings of the same eleven links, because the two form factors want
 * genuinely different things and faking one from the other reads badly at both:
 *
 *   desktop  a vertical rail, grouped under three headers (eleven flat rows is
 *            a list you scan, not one you read), plus the org's plan and credit
 *            balance at the top so an owner sees them from every Settings page
 *            rather than only from Billing and Credits.
 *   phones   one sticky horizontal strip pinned below the gantry header (which
 *            is also sticky at top:0 — pinning both to 0 makes them compete and
 *            this row loses, scrolling out of view entirely). Headers have
 *            nowhere to go in a single row, so the strip stays flat.
 *
 * `ScrollActiveTabIntoView` is not decoration: eleven items never fit a 320px
 * strip, so without it you land on Billing and cannot see which item is
 * selected. A no-horizontal-scroll gate cannot catch that — the strip is meant
 * to scroll. `className="contents"` keeps its wrapper out of the box tree, so
 * the sticky strip still resolves its containing block against `<aside>`;
 * a real wrapper div would be exactly strip-height and leave sticky nowhere to
 * travel.
 */
export interface NavContext {
  /** Already localized through `planLabel` — the rail does no plan logic. */
  plan: string;
  credits: number;
}

/**
 * The rail's plan + credit balance, resolved by the PAGE and passed in.
 *
 * Deliberately not fetched inside `SettingsNav`: an async component nested in
 * the tree would make the rail unrenderable by the synchronous static
 * prerender every settings test uses, for two numbers the page can just as
 * easily hand it.
 *
 * Best-effort by design — the rail is navigation. A credits or entitlement
 * read that fails must not take the whole Settings page down with it, so this
 * returns null and the header simply does not appear.
 */
export async function navContext(orgId: string): Promise<NavContext | null> {
  try {
    const [plan, walletId] = await Promise.all([orgPlanKey(orgId), walletIdFor(orgId)]);
    return { plan: planLabel(plan), credits: await balance(walletId) };
  } catch {
    return null;
  }
}

export function SettingsNav({
  orgSlug,
  active,
  dict,
  context = null,
}: {
  orgSlug: string;
  active: SettingsNavKey;
  dict: Dict;
  /** From `navContext(orgId)`. Omit and the plan/credits header is skipped. */
  context?: NavContext | null;
}) {
  return (
    <aside className="w-full md:w-44 md:shrink-0">
      <p className="mb-3 hidden px-3 text-[11px] font-semibold uppercase tracking-wider text-slate-500 md:block">
        {t(dict, "settings.nav.title")}
      </p>

      {/* Plan + credits, desktop only — the phone strip is one row and has no
          room for it. Both were previously visible only from the page that
          owns them, which is exactly where an owner is NOT looking when they
          run out mid-schedule. */}
      {context && (
        <div className="mb-4 hidden rounded-lg border border-purple-100 bg-purple-50/40 px-3 py-2 md:block">
          <p className="text-sm font-semibold text-slate-800">{context.plan}</p>
          <Link
            href={routes.credits(orgSlug)}
            className="text-xs text-purple-700 underline-offset-2 hover:underline"
          >
            {t(dict, "settings.nav.creditsLeft", { count: context.credits })}
          </Link>
        </div>
      )}

      {/* ONE set of links, two shapes.
          Phones: the group wrappers collapse to `display: contents`, so every
          chip joins the strip's own flex row and the headers hide — a second
          rendering for mobile would put `aria-current` in the document twice,
          which is a screen reader hearing two current pages.
          Desktop: the wrappers become blocks again and the headers appear. */}
      <ScrollActiveTabIntoView className="contents">
        <nav className="scroll-x scroll-x-fade sticky top-[var(--app-header-h)] z-30 -mx-4 flex gap-1 whitespace-nowrap bg-[var(--background)]/90 px-4 py-2 backdrop-blur md:static md:z-auto md:mx-0 md:block md:bg-transparent md:p-0 md:backdrop-blur-none">
          {GROUPS.map(({ group, labelKey }) => (
            <div key={group} className="contents md:mb-4 md:block md:last:mb-0">
              <p className="hidden px-3 text-[10px] font-semibold uppercase tracking-wider text-slate-400 md:mb-1 md:block">
                {t(dict, labelKey)}
              </p>
              <div className="contents md:block md:space-y-0.5">
                {ITEMS.filter((i) => i.group === group).map((item) => (
                  <NavLink key={item.key} item={item} orgSlug={orgSlug} active={active} dict={dict} />
                ))}
              </div>
            </div>
          ))}
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
  context = null,
  showNav = true,
  children,
}: {
  orgSlug: string;
  active: SettingsNavKey;
  dict: Dict;
  /** From `navContext(orgId)`. Omit and the plan/credits header is skipped. */
  context?: NavContext | null;
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
        <SettingsNav orgSlug={orgSlug} active={active} dict={dict} context={context} />
        <main className="min-w-0 flex-1">{children}</main>
      </div>
    </div>
  );
}
