// The foot of a help article (layout A): Related (cards for the help pages the article's front-matter
// `related:` names, resolved and checked in server/help-related.ts), then previous/next within the section.
// No `related:` written: no Related block — nothing is invented to fill it.
import Link from "next/link";
import { ArrowLeft, ArrowRight, BookOpen } from "lucide-react";

export interface HelpPageLink {
  href: string;
  title: string;
}

/** The blog posts that explain this page's rules (server/blog-help-links.ts). A second list, beside Related. */
export interface HelpBlogLinks {
  title: string;
  posts: { href: string; title: string; meta: string }[];
}

export function HelpRelated({
  related,
  prev,
  next,
  blogLinks,
  className = "",
}: {
  related: (HelpPageLink & { section: string })[];
  prev: HelpPageLink | null;
  next: HelpPageLink | null;
  blogLinks?: HelpBlogLinks | null;
  className?: string;
}) {
  const blog = blogLinks && blogLinks.posts.length > 0 ? blogLinks : null;
  if (related.length === 0 && !blog && !prev && !next) return null;
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
      {blog ? (
        <section aria-labelledby="help-blog-links-h" data-testid="help-blog-links">
          <h2 id="help-blog-links-h" className="text-base font-semibold text-slate-900">{blog.title}</h2>
          <ul className="mt-3 grid gap-3 sm:grid-cols-2">
            {blog.posts.map((p) => (
              <li key={p.href}>
                <Link
                  href={p.href}
                  className="flex h-full items-start gap-3 rounded-xl border border-slate-200 bg-white p-4 transition-colors hover:border-purple-300 hover:bg-purple-50/40"
                >
                  <BookOpen aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-purple-600" strokeWidth={2} />
                  <span className="min-w-0">
                    <span className="block font-medium leading-snug text-slate-900">{p.title}</span>
                    <span className="mt-1 block text-xs text-slate-500">{p.meta}</span>
                  </span>
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
