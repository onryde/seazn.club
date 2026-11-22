// "How Seazn handles it": rendered from the post's front-matter `help:` key, not from the body. The link is the
// registry's answer for that key (`helpUrl`), so a key the registry does not know renders NO section rather than a dead link.
import Link from "next/link";
import { ArrowRight } from "lucide-react";

export function BlogHandlesIt({
  href,
  title,
  body,
  linkLabel,
  className = "",
}: {
  /** From `blogHelpHref(post.help)`: null when the help page is not registered. */
  href: string | null;
  title: string;
  body: string;
  linkLabel: string;
  className?: string;
}) {
  if (!href) return null;
  return (
    <section id="how-seazn-handles-it" aria-labelledby="how-seazn-handles-it-h" className={`scroll-mt-24 rounded-2xl border border-purple-100 bg-purple-50/60 p-5 ${className}`} data-testid="blog-handles-it">
      <h2 id="how-seazn-handles-it-h" className="text-xl font-bold tracking-tight text-slate-900">
        {title}
      </h2>
      <p className="mt-2 text-[15px] leading-relaxed text-slate-700">{body}</p>
      <Link
        href={href}
        className="mt-4 inline-flex min-h-11 items-center gap-2 rounded-lg border border-purple-200 bg-white px-4 text-sm font-semibold text-purple-800 transition-colors hover:bg-purple-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-purple-500"
      >
        {linkLabel}
        <ArrowRight aria-hidden className="h-4 w-4" strokeWidth={2} />
      </Link>
    </section>
  );
}
