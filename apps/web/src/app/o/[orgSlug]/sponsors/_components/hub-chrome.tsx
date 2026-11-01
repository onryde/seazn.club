// The Sponsors hub's chrome (R4 sponsors-on-stream S11): the tab bar and the panel card. Server components - no state.
//
// The tab bar is the same shape as the Registration hub's (`registration/page.tsx`: there is no shared TabStrip in
// this repo, so each hub inlines its own `<nav>`), with one difference: every tab is a 44px-tall target
// (`min-h-11`), because this bar is the way around the page on a phone. It scrolls inside its own `.scroll-x`
// container at 320 (four tabs do not fit one row there) and never widens the page.
import Link from "@/components/ui/console-link";
import type { LucideIcon } from "lucide-react";
import { t, type Dict } from "@/lib/i18n";
import { sponsorsHref, type SponsorsTab } from "@/lib/sponsors-hub";

/** The visible name of a tab, from the `ui` catalog (`sponsors.hub.tab.<tab>`). One home so the bar and the panel
 *  headings can never disagree about what a tab is called. */
export const tabLabel = (dict: Dict, tab: SponsorsTab): string => t(dict, `sponsors.hub.tab.${tab}`);

export function SponsorsHubTabs({
  orgSlug,
  tabs,
  active,
  dict,
}: {
  orgSlug: string;
  /** Only the tabs this reader is offered (`sponsorsTabsFor`). */
  tabs: readonly SponsorsTab[];
  active: SponsorsTab;
  dict: Dict;
}) {
  return (
    <nav
      aria-label={t(dict, "sponsors.hub.tabsLabel")}
      className="scroll-x scroll-x-fade mb-4 flex gap-1 whitespace-nowrap border-b border-slate-200 md:mb-6"
    >
      {tabs.map((tab) => (
        <Link
          key={tab}
          href={sponsorsHref(orgSlug, tab)}
          data-testid={`sponsors-tab-link-${tab}`}
          aria-current={tab === active ? "page" : undefined}
          className={`flex min-h-11 shrink-0 items-center border-b-2 px-4 text-sm font-medium transition ${
            tab === active
              ? "border-purple-600 text-purple-700"
              : "border-transparent text-slate-500 hover:text-slate-800"
          }`}
        >
          {tabLabel(dict, tab)}
        </Link>
      ))}
    </nav>
  );
}

/** A tab's panel: the house settings card with its icon + heading. `data-testid="sponsors-tab-<tab>"` is what the
 *  page test and the e2e specs read to learn WHICH tab opened. */
export function HubPanel({
  tab,
  icon: Icon,
  title,
  children,
}: {
  tab: SponsorsTab;
  icon: LucideIcon;
  title: string;
  children?: React.ReactNode;
}) {
  const headingId = `sponsors-tab-${tab}-heading`;
  return (
    <section className="card p-4 sm:p-6" data-testid={`sponsors-tab-${tab}`} aria-labelledby={headingId}>
      <div className="mb-5 flex min-w-0 items-center gap-2">
        <Icon className="h-4 w-4 shrink-0 text-purple-500" strokeWidth={1.75} />
        <h2 id={headingId} className="min-w-0 text-sm font-semibold text-slate-800">{title}</h2>
      </div>
      {children}
    </section>
  );
}
