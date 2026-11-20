// The blog's leak guard: P1's findLeaks (PR numbers, wave ids, spec marks, rulings, migration numbers,
// developer words) PLUS one rule of its own, `code-identifier`. A post can print an engine key by accident
// (an example label like `h2h_reapply`, a tie-break key like `buchholz_cut1`, an option like `topNPerGroup`),
// which P1's pages cannot, because their text is hand-written. copy-leaks.ts is composed, never edited.
//
// WHICH TEXT TO SCAN. Do NOT pass helpPlainText(markdown) here: it turns "_" into a space, so
// `h2h_reapply` reads "h2h reapply" and the snake_case rule is blind to it. Use blogLeakText(markdown),
// which keeps underscores and drops what is not prose (link targets, image paths, blog tokens).
import { findLeaks, type Leak, type LeakRule } from "@/lib/copy-leaks";

export type BlogLeakRule = LeakRule | "code-identifier";

export interface BlogLeak {
  rule: BlogLeakRule;
  match: string;
  index: number;
}

export interface BlogLeakAllow {
  /** The exact token (case-sensitive). */
  match: string;
  reason: string;
}

// snake_case: letters/digits joined by single underscores ("h2h_reapply", "buchholz_cut1", "FEWEST_PLAYED").
const SNAKE = /\b[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+\b/g;
// camelCase: a lowercase start (digits may follow), then at least one capital ("topNPerGroup", "anaPoints", "h2hReapply"). A capital start
// ("YouTube") is not matched, so brand and proper names are not caught.
const CAMEL = /\b[a-z][a-z0-9]*(?:[A-Z][a-z0-9]*)+\b/g;

/** A token that looks like an identifier and is real copy. Each entry is proved live by blog-leaks.test.ts. */
export const BLOG_LEAK_ALLOW: BlogLeakAllow[] = [
  { match: "iPhone", reason: "Apple's product name; a post may say where the scoring screen runs." },
  { match: "iPad", reason: "Apple's product name; a post may say where the scoring screen runs." },
  { match: "iOS", reason: "Apple's operating system name; a post may say where the scoring screen runs." },
];

function identifierLeaks(text: string): BlogLeak[] {
  const out: BlogLeak[] = [];
  for (const re of [SNAKE, CAMEL]) {
    for (const m of text.matchAll(re)) {
      // A plural ("iPads") is the same word.
      if (BLOG_LEAK_ALLOW.some((a) => a.match === m[0] || `${a.match}s` === m[0])) continue;
      out.push({ rule: "code-identifier", match: m[0], index: m.index! });
    }
  }
  return out;
}

/** Every leak in `text`, in order: P1's rules, then the blog's `code-identifier`. */
export function findBlogLeaks(text: string): BlogLeak[] {
  const base: Leak[] = findLeaks(text);
  return [...base, ...identifierLeaks(text)].sort((a, b) => a.index - b.index);
}

/**
 * The text of a post that a reader sees, for scanning: link targets, image paths and the blog's own
 * `{{fact:...}}` / `{{example:...}}` tokens are dropped (their ids are code-shaped on purpose and are
 * replaced before a reader sees anything), and Markdown marks are left alone. Underscores are kept.
 */
export function blogLeakText(markdown: string): string {
  return markdown
    .replace(/\{\{(?:fact|example):[^}]*\}\}/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
}
