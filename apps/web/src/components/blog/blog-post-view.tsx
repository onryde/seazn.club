// One post, drawn (owner pick, 2026-11-19: Post A, help's frame with a right-rail "On this page"). Presentational: the page
// (app/blog/[slug]/page.tsx) loads and resolves everything, so what this draws is exactly its props and a test can
// hand it any shape.
//
// Frame, as help's article page: from 1100px a reading column and the "On this page" rail beside it, sticky, spanning
// every row; below that, one column with the rail folded under the lede. Layout A (owner pick, 2026-11-25): the header,
// lede, prose, headings, examples, pictures, "How Seazn handles it" and Related are all ONE 44rem column (17px body, about
// 80 characters a line), centred below 1100. The post's type is `.blog-prose` (globals.css); help keeps its own.
// e2e/blog.spec.ts "layout A" measures every part's width in a browser.
import Link from "next/link";
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
  labels: { blog: string; related: string; swipe: string };
}

export function BlogPostView(p: BlogPostViewProps) {
  return (
    <article className="mx-auto max-w-[44rem] min-[1100px]:grid min-[1100px]:max-w-[68rem] min-[1100px]:grid-cols-[minmax(0,44rem)_12rem] min-[1100px]:justify-center min-[1100px]:gap-x-14" data-testid="blog-post">
      <header className="min-w-0 min-[1100px]:col-start-1 min-[1100px]:row-start-1">
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
        <h1 className="mt-3 text-balance text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl">{p.title}</h1>
        <p className="mt-3 text-[19px] leading-[1.6] text-slate-600">{p.answer}</p>
        <BlogByline date={p.date} dateLabel={p.dateLabel} updated={p.updated} updatedLabel={p.updatedLabel} />
      </header>
      {p.toc.length > 0 ? (
        <HelpToc
          entries={p.toc}
          className="mt-6 min-[1100px]:sticky min-[1100px]:top-24 min-[1100px]:col-start-2 min-[1100px]:row-span-3 min-[1100px]:row-start-1 min-[1100px]:mt-1 min-[1100px]:self-start"
        />
      ) : null}
      <div className="mt-8 min-w-0 min-[1100px]:col-start-1 min-[1100px]:row-start-2">
        {p.parts.map((part, i) =>
          part.kind === "html" ? (
            <CompetitionProse key={i} html={part.html} className="help-prose blog-prose" />
          ) : (
            <BlogExample key={i} id={part.id} result={part.result} swipeHint={p.labels.swipe} />
          ),
        )}
        <BlogHandlesIt className="mt-10" {...p.handles} />
      </div>
      <BlogRelated title={p.labels.related} posts={p.related} className="mt-12 min-w-0 min-[1100px]:col-start-1 min-[1100px]:row-start-3" />
    </article>
  );
}
