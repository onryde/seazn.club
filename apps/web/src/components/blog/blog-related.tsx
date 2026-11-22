// Related posts, in the order the front-matter names them. The caller passes only posts that RESOLVE (blogPost());
// a name in `related:` that is not a post yet (BLOG_PLANNED_SLUGS) never reaches here, and an empty list renders nothing.
import Link from "next/link";

export interface BlogRelatedPost {
  href: string;
  title: string;
  /** The topic's name, under the title. */
  topic: string;
}

export function BlogRelated({ title, posts, className = "" }: { title: string; posts: BlogRelatedPost[]; className?: string }) {
  if (posts.length === 0) return null;
  return (
    <section aria-labelledby="blog-related-h" className={className} data-testid="blog-related">
      <h2 id="blog-related-h" className="text-xl font-bold tracking-tight text-slate-900">
        {title}
      </h2>
      <ul className="mt-3 grid gap-3 sm:grid-cols-2">
        {posts.map((p) => (
          <li key={p.href}>
            <Link
              href={p.href}
              className="block h-full rounded-xl border border-slate-200 bg-white p-4 transition-colors hover:border-purple-300 hover:bg-purple-50/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-purple-500"
            >
              <span className="block font-medium leading-snug text-slate-900">{p.title}</span>
              <span className="mt-1.5 block text-xs text-slate-500">{p.topic}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
