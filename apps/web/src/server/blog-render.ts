import "server-only";
// A post to its parts: fact tokens resolve first (against the GOLDEN, never against build()), then the body is cut
// at each `{{example:<id>}}` and `{{art:<id>}}` line, and every Markdown segment goes through P1's help renderer
// (pictures, callouts and heading ids included). The example parts carry the golden's result, and the art parts the
// registry's picture, for a blog-owned component to draw.
import { ART_LINE, ART_ONLY_TOPIC, blogArt, type BlogArt } from "@/blog/art";
import { BLOG_GOLDENS } from "@/blog/examples/goldens";
import type { ExampleResult } from "@/blog/examples/types";
import type { BlogTopic } from "@/lib/blog";
import type { HelpHeading } from "@/server/help-heading-ids";
import { renderHelpArticle } from "@/server/help-content";

export type BlogPart =
  | { kind: "html"; html: string }
  | { kind: "example"; id: string; result: ExampleResult }
  | { kind: "art"; id: string; art: BlogArt };

export interface RenderedBlogPost {
  parts: BlogPart[];
  headings: HelpHeading[];
}

/** The slice of a post the renderer reads; a test passes a hand-built one. */
export interface RenderablePost {
  slug: string;
  topic: BlogTopic;
  markdown: string;
  examples: readonly string[];
}

const FACT = /\{\{fact:([a-z0-9-]+)\.([A-Za-z0-9_]+)\}\}/g;
const EXAMPLE_LINE = /^\{\{example:([a-z0-9-]+)\}\}$/;

/** A post carries no plan token, so a matrix is never loaded for one: asking for it is a refusal. */
const noMatrix = (): never => {
  throw new Error("a blog post carries no {{plan:...}} token, so it never loads the plan matrix");
};

function resolveFacts(post: RenderablePost, goldens: Record<string, ExampleResult>): string {
  return post.markdown.replace(FACT, (token, id: string, key: string) => {
    const golden = goldens[id];
    if (golden === undefined) throw new Error(`${post.slug}: ${token}: there is no example '${id}'`);
    if (!post.examples.includes(id)) throw new Error(`${post.slug}: ${token}: the post's 'examples' does not list '${id}'`);
    const value = golden.facts[key];
    if (value === undefined || String(value).length === 0) {
      throw new Error(`${post.slug}: ${token}: example '${id}' has no fact '${key}' (it has ${Object.keys(golden.facts).join(", ") || "none"})`);
    }
    return String(value);
  });
}

export async function renderBlogPost(post: RenderablePost, goldens: Record<string, ExampleResult> = BLOG_GOLDENS): Promise<RenderedBlogPost> {
  const resolved = resolveFacts(post, goldens);
  const segments: (string[] | { example: string } | { art: string })[] = [[]];
  for (const [i, raw] of resolved.split("\n").entries()) {
    const m = EXAMPLE_LINE.exec(raw.trim());
    const picture = ART_LINE.exec(raw.trim());
    if (m) {
      segments.push({ example: m[1]! }, []);
    } else if (picture) {
      segments.push({ art: picture[1]! }, []);
    } else if (raw.includes("{{example:")) {
      throw new Error(`${post.slug}: line ${i + 1}: an example token must stand alone on its own line`);
    } else if (raw.includes("{{art:")) {
      throw new Error(`${post.slug}: line ${i + 1}: an art token must stand alone on its own line`);
    } else {
      (segments[segments.length - 1] as string[]).push(raw);
    }
  }

  const placed = segments.flatMap((s) => ("example" in s ? [s.example] : []));
  const pictures = segments.flatMap((s) => ("art" in s ? [s.art] : []));
  if (placed.length === 0 && !(post.topic === ART_ONLY_TOPIC && pictures.length > 0)) {
    throw new Error(`${post.slug}: the post places no example; every post carries one (only a '${ART_ONLY_TOPIC}' post may place art instead)`);
  }
  for (const id of pictures) {
    if (blogArt(id) === undefined) throw new Error(`${post.slug}: there is no art '${id}'`);
    if (pictures.filter((p) => p === id).length > 1) throw new Error(`${post.slug}: art '${id}' is placed more than once`);
  }
  for (const id of new Set(placed)) {
    if (placed.filter((p) => p === id).length > 1) throw new Error(`${post.slug}: example '${id}' is placed more than once`);
    if (!post.examples.includes(id)) throw new Error(`${post.slug}: the body places example '${id}', which the post does not list`);
    if (goldens[id] === undefined) throw new Error(`${post.slug}: example '${id}' has no golden`);
  }
  for (const id of post.examples) if (!placed.includes(id)) throw new Error(`${post.slug}: example '${id}' is listed but the body never places it`);

  const parts: BlogPart[] = [];
  const headings: HelpHeading[] = [];
  const seen = new Set<string>();
  for (const seg of segments) {
    if (!Array.isArray(seg)) {
      parts.push(
        "example" in seg
          ? { kind: "example", id: seg.example, result: goldens[seg.example]! }
          : { kind: "art", id: seg.art, art: blogArt(seg.art)! },
      );
      continue;
    }
    const markdown = seg.join("\n");
    if (markdown.trim().length === 0) continue;
    // Every token has been resolved or refused by now: a brace pair that is still here would print as text.
    const stray = markdown.indexOf("{{");
    if (stray !== -1) throw new Error(`${post.slug}: '${markdown.slice(stray, stray + 40)}' is left unresolved after the fact tokens ran`);
    const { html, headings: found } = await renderHelpArticle({ markdown }, noMatrix);
    for (const h of found) {
      if (seen.has(h.id)) throw new Error(`${post.slug}: duplicate heading id '${h.id}' (the same heading text in two segments); reword one`);
      seen.add(h.id);
      headings.push(h);
    }
    parts.push({ kind: "html", html });
  }
  return { parts, headings };
}
