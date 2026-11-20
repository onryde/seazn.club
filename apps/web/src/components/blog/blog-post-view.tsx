// One post, drawn (owner pick, 2026-11-19: Post A, help's frame with a right-rail "On this page"). Presentational: the page
// (app/blog/[slug]/page.tsx) loads and resolves everything, so what this draws is exactly its props and a test can
// hand it any shape.
//
// Frame, as help's article page: from 1100px a reading column and the "On this page" rail beside it, sticky, spanning
// every row; below that, one column with the rail folded under the lede. The reading column is capped at 34rem
// (about 70 characters a line of the 15px body text), the example breaks out to the full phone width.
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { CompetitionProse } from "@/components/public-site/competition-prose";
import { HelpToc } from "@/components/help/help-toc";
import { BlogByline } from "@/components/blog/blog-byline";
import { BlogExample } from "@/components/blog/blog-example-table";
import { BlogHandlesIt } from "@/components/blog/blog-handles-it";
import { BlogRelated, type BlogRelatedPost } from "@/components/blog/blog-related";
import type { HelpTocEntry } from "@/lib/help-toc";
import type { BlogPart } from "@/server/blog-render";

export interface BlogPostViewProps {
  title: string;
  /** The first paragraph: the answer, also the meta description. */
  answer: string;
  date: string;
  dateLabel: string;
  updated?: string;
  updatedLabel?: string;
  topicLabel: string;
  parts: BlogPart[];
  toc: HelpTocEntry[];
  handles: { href: string | null; title: string; body: string; linkLabel: string };
  related: BlogRelatedPost[];
  labels: { blog: string; back: string; related: string; swipe: string };
}

export function BlogPostView(p: BlogPostViewProps) {
  return (
    <article className="mx-auto min-[1100px]:grid min-[1100px]:max-w-[60rem] min-[1100px]:grid-cols-[minmax(0,34rem)_12rem] min-[1100px]:justify-center min-[1100px]:gap-x-14" data-testid="blog-post">
      <header className="min-w-0 max-w-[34rem] min-[1100px]:col-start-1 min-[1100px]:row-start-1">
        <div className="flex items-center gap-3">
          <Link
            href="/blog"
            aria-label={p.labels.back}
            className="grid h-11 w-11 shrink-0 place-items-center rounded-full border border-purple-200 text-purple-700 transition-colors hover:bg-purple-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-purple-500"
          >
            <ArrowLeft aria-hidden className="h-4 w-4" strokeWidth={2} />
          </Link>
          <nav aria-label="Breadcrumb">
            <ol className="flex flex-wrap items-center gap-x-1.5 text-sm text-slate-500">
              <li>
                <Link href="/blog" className="hover:text-purple-700 hover:underline">
                  {p.labels.blog}
                </Link>
              </li>
              <li aria-hidden>/</li>
              <li className="font-medium text-slate-700">{p.topicLabel}</li>
            </ol>
          </nav>
        </div>
        <h1 className="mt-4 text-balance text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl">{p.title}</h1>
        <p className="mt-3 text-lg leading-relaxed text-slate-600">{p.answer}</p>
        <BlogByline date={p.date} dateLabel={p.dateLabel} updated={p.updated} updatedLabel={p.updatedLabel} />
      </header>
      {p.toc.length > 0 ? (
        <HelpToc
          entries={p.toc}
          className="mt-6 min-[1100px]:sticky min-[1100px]:top-24 min-[1100px]:col-start-2 min-[1100px]:row-span-3 min-[1100px]:row-start-1 min-[1100px]:mt-1 min-[1100px]:self-start"
        />
      ) : null}
      <div className="mt-8 min-w-0 max-w-[34rem] min-[1100px]:col-start-1 min-[1100px]:row-start-2">
        {p.parts.map((part, i) =>
          part.kind === "html" ? (
            <CompetitionProse key={i} html={part.html} className="help-prose" />
          ) : (
            <BlogExample key={i} id={part.id} result={part.result} swipeHint={p.labels.swipe} />
          ),
        )}
        <BlogHandlesIt className="mt-10" {...p.handles} />
      </div>
      <BlogRelated title={p.labels.related} posts={p.related} className="mt-12 min-w-0 max-w-[34rem] min-[1100px]:col-start-1 min-[1100px]:row-start-3" />
    </article>
  );
}
