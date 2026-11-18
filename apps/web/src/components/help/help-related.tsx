// The foot of a help article (layout A): Related (cards for the help pages the article's front-matter
// `related:` names, resolved and checked in server/help-related.ts), then previous/next within the section.
// No `related:` written: no Related block — nothing is invented to fill it.
import Link from "next/link";
import { ArrowLeft, ArrowRight } from "lucide-react";

export interface HelpPageLink {
  href: string;
  title: string;
}

export function HelpRelated({
  related,
  prev,
  next,
  className = "",
}: {
  related: (HelpPageLink & { section: string })[];
  prev: HelpPageLink | null;
  next: HelpPageLink | null;
  className?: string;
}) {
  if (related.length === 0 && !prev && !next) return null;
  return (
    <footer className={`mt-12 space-y-8 ${className}`}>
      {related.length > 0 ? (
        <section aria-label="Related">
          <h2 className="text-base font-semibold text-slate-900">Related</h2>
          <ul className="mt-3 grid gap-3 sm:grid-cols-2">
            {related.map((r) => (
              <li key={r.href}>
                <Link
                  href={r.href}
                  className="block h-full rounded-xl border border-slate-200 bg-white p-4 transition-colors hover:border-purple-300 hover:bg-purple-50/40"
                >
                  <span className="block font-medium text-slate-900">{r.title}</span>
                  <span className="mt-1 block text-xs text-slate-500">{r.section}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {prev || next ? (
        <nav aria-label="Previous and next" className="grid gap-3 border-t border-slate-200 pt-6 sm:grid-cols-2">
          {prev ? (
            <Link href={prev.href} className="group block rounded-xl p-3 transition-colors hover:bg-slate-50">
              <span className="flex items-center gap-1 text-xs text-slate-500">
                <ArrowLeft aria-hidden className="h-3.5 w-3.5" strokeWidth={2} /> Previous
              </span>
              <span className="mt-1 block font-medium text-slate-800 group-hover:text-purple-800">{prev.title}</span>
            </Link>
          ) : (
            <span className="max-sm:hidden" />
          )}
          {next ? (
            <Link href={next.href} className="group block rounded-xl p-3 transition-colors hover:bg-slate-50 sm:text-right">
              <span className="flex items-center gap-1 text-xs text-slate-500 sm:justify-end">
                Next <ArrowRight aria-hidden className="h-3.5 w-3.5" strokeWidth={2} />
              </span>
              <span className="mt-1 block font-medium text-slate-800 group-hover:text-purple-800">{next.title}</span>
            </Link>
          ) : null}
        </nav>
      ) : null}
    </footer>
  );
}
