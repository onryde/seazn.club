// The help page shell (layout A, owner 2026-11-18), rendered by each help page rather than the help
// layout: a page knows which page it is on the server, so the section list marks it in the prerendered
// HTML and no client hook has to read the URL. The help home does not use it (it has its own search
// and section cards).
//
// Widths (one DOM, branched by CSS):
//  - below `md` (768): one column — search, then the section list folded behind one toggle, then the page;
//  - from `md`: the section list (with the search above it) is a left column beside the page;
//  - from 1100px the article page adds its "On this page" rail on the right (the article grid, in
//    app/help/[...slug]/page.tsx: three columns need about 1,100px, so below that the rail folds).
// Server component: only HelpSearch and HelpSectionNav (and the article's HelpToc) ship to the browser.
import Link from "next/link";
import { helpSectionList } from "@/server/help-content";
import { HelpSearch } from "@/components/help/help-search";
import { HelpSectionNav } from "@/components/help/help-section-nav";

export function HelpShell({ currentHref, children }: { currentHref: string; children: React.ReactNode }) {
  return (
    <div className="md:grid md:grid-cols-[13rem_minmax(0,1fr)] md:gap-8 lg:gap-12">
      <div className="min-w-0 space-y-3 md:space-y-6">
        <HelpSearch variant="rail" />
        <HelpSectionNav sections={helpSectionList()} currentHref={currentHref} />
      </div>
      <main className="mt-8 min-w-0 md:mt-0">{children}</main>
    </div>
  );
}

/** Help / Section (the section links to its card on the help home). */
export function HelpBreadcrumb({ trail }: { trail: { href: string; label: string }[] }) {
  return (
    <nav aria-label="Breadcrumb">
      <ol className="flex flex-wrap items-center gap-x-1.5 text-sm text-slate-500">
        <li>
          <Link href="/help" className="hover:text-purple-700 hover:underline">
            Help
          </Link>
        </li>
        {trail.map((t) => (
          <li key={t.href} className="flex items-center gap-x-1.5">
            <span aria-hidden>/</span>
            <Link href={t.href} className="font-medium text-slate-700 hover:text-purple-700 hover:underline">
              {t.label}
            </Link>
          </li>
        ))}
      </ol>
    </nav>
  );
}
