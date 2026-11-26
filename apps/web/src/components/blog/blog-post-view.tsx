// One post, drawn. Presentational: the page (app/blog/[slug]/page.tsx) loads and resolves everything, so what this
// draws is exactly its props and a test can hand it any shape.
//
// The reading layout (owner pick "A", 2026-11-25, replacing the side-rail layout): ONE centred 680px column at every
// width and no table of contents. Title, a grey subtitle (the answer), the byline between two hairlines, then the body.
// The header, prose, headings, examples, pictures, "How Seazn handles it" and Related all share that column. The body's
// serif is the page's (it loads the face) and globals.css `.blog-prose`'s (it asks for it); headings, tables, captions
// and everything else stay in the house sans. Help keeps its own frame and its "On this page".
// e2e/blog.spec.ts "the reading column" measures every part in a browser.
import Link from "next/link";
import { CompetitionProse } from "@/components/public-site/competition-prose";
import { BlogByline } from "@/components/blog/blog-byline";
import { BlogExample } from "@/components/blog/blog-example-table";
import { BlogHandlesIt } from "@/components/blog/blog-handles-it";
import { BlogRelated, type BlogRelatedPost } from "@/components/blog/blog-related";
import { BlogArtFigure } from "@/components/blog/blog-art";
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
  handles: { href: string | null; title: string; body: string; linkLabel: string };
  related: BlogRelatedPost[];
  labels: { blog: string; related: string; swipe: string };
}

export function BlogPostView(p: BlogPostViewProps) {
  return (
    <article className="mx-auto max-w-[42.5rem]" data-testid="blog-post">
      <header>
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
        <h1 className="mt-5 text-balance text-[31px] font-bold leading-[1.19] tracking-[-0.018em] text-[#242424] min-[600px]:text-[42px]">{p.title}</h1>
        <p className="mt-3 text-[18px] leading-[1.35] text-[#6b6b6b] min-[600px]:text-[22px]">{p.answer}</p>
        <BlogByline date={p.date} dateLabel={p.dateLabel} updated={p.updated} updatedLabel={p.updatedLabel} />
      </header>
      <div className="mt-8 min-w-0">
        {p.parts.map((part, i) =>
          part.kind === "html" ? (
            <CompetitionProse key={i} html={part.html} className="help-prose blog-prose" />
          ) : part.kind === "art" ? (
            <BlogArtFigure key={i} art={part.art} />
          ) : (
            <BlogExample key={i} id={part.id} result={part.result} swipeHint={p.labels.swipe} />
          ),
        )}
        <BlogHandlesIt className="mt-10" {...p.handles} />
      </div>
      <BlogRelated title={p.labels.related} posts={p.related} className="mt-12 min-w-0" />
    </article>
  );
}
