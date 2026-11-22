// Which help pages a blog post names, read from the posts' own front-matter (content/blog/*.md `help:`), so an e2e spec
// never hard-codes "this page has a post" or "this page has none": both go stale the day a batch adds a post.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { expect } from "@playwright/test";

const BLOG = join(process.cwd(), "content", "blog");

/** The `help:` key of every post on disk. */
export function postHelpKeys(): string[] {
  return readdirSync(BLOG)
    .filter((f) => f.endsWith(".md"))
    .map((f) => /^help:\s*(\S+)\s*$/m.exec(readFileSync(join(BLOG, f), "utf8"))?.[1])
    .filter((k): k is string => !!k);
}

/** A help article some post names (so it carries "Read how it works"). Format pages are left to the unit suite. */
export function helpPageWithPosts(): string {
  const key = postHelpKeys().find((k) => !k.startsWith("formats/"));
  expect(key, "anti-vacuity: at least one post names a help article").toBeTruthy();
  return `/help/${key}`;
}

/** A real, long-standing help article no post names (so it carries no such list). */
export function helpPageWithoutPosts(): string {
  const named = new Set(postHelpKeys());
  const candidates = ["registration/waitlist", "scoring/basics", "registration/card-payments", "entrants/withdrawals"];
  const key = candidates.find((c) => !named.has(c));
  expect(key, "anti-vacuity: one candidate page is named by no post").toBeTruthy();
  return `/help/${key}`;
}
