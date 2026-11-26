// The frame of a help article, the format gallery and a format page: the blog post's one centred column
// (components/reading/reading-column.ts), with the help search at its head and then the page. No section list and no
// "On this page" at any width (owner, 2026-11-26): a reader moves on through the breadcrumb (the help home lists every
// page; the section crumb lands on that section's card), previous and next, Related and the search. The help home does
// not use this frame (it has its own search and section cards).
// Server component: only HelpSearch ships to the browser.
import Link from "next/link";
import { HelpSearch } from "@/components/help/help-search";
import { READING_COLUMN } from "@/components/reading/reading-column";

export function HelpShell({ children }: { children: React.ReactNode }) {
  return (
    <div className={READING_COLUMN}>
      <HelpSearch variant="column" />
      <main className="mt-8 min-w-0">{children}</main>
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
