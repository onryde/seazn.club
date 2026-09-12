// Source contract for the four public-surface `<img>` → `next/image`
// conversions (task-4-report.md §3, review finding 1). The repo deliberately
// has no component-render test machinery (no jsdom/RTL) — so this can't
// render the JSX and check what actually paints. Instead it locks the source
// text of each converted call site: still imports Image from "next/image",
// still carries the exact width/height pair it was converted with (dimension
// drift silently reintroduces CLS — next/image's whole point), and hasn't
// quietly reverted to a plain <img> for the same value. e2e owns visual
// verification; this test only guards against silent regression in source.
//
// Assertions are deliberately narrow per file (matched on the specific `src`
// identifier actually used at each converted site), not a file-wide `<img`
// ban — apps/web/src/app/(public)/shared/[orgSlug]/[competitionSlug]/page.tsx
// still has two *deliberate* `<img>` (competition branding.banner/logo,
// skipped as ambiguous-source per the report §4) that must keep working.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC_ROOT = join(__dirname, "..", "..");

interface Case {
  name: string;
  file: string;
  /** The exact `src={...}` expression at the converted call site. */
  srcExpr: string;
  /** Literal pixel pair, or the source expression both dimensions share. */
  width: number | string;
  height: number | string;
}

const CASES: Case[] = [
  // register-form.tsx (org logo) and the register/page.tsx sponsor-logo call
  // site were removed by the RS001 registration demolition: the old
  // form is deleted outright, and the register page is now a minimal
  // closed-state shell with no sponsor masthead. RS006 owns the rebuilt
  // public stepper and reintroduces whatever image contracts it needs.
  {
    // W2 Task 12 LIFTED the perimeter board out of
    // `[competitionSlug]/page.tsx` into its own component, so the page can
    // hand it to the landing root as a slot. Same markup, same tier map, new
    // file — and the helper it reads is `panel(s)` rather than the page's old
    // one-letter `c(s)`. The page itself keeps its two deliberate `<img>`
    // (competition branding.banner/logo) and no longer converts anything, so
    // it has no case of its own here any more.
    name: "sponsors-board.tsx sponsor logo",
    file: join(SRC_ROOT, "components/public-site/sponsors-board.tsx"),
    srcExpr: "sponsor.logo",
    // The sponsor placement redesign (2026-09-12) gave the board and the hero
    // ONE logo site, `logoChip(sponsor, px, cls)`, so the dimension arrives as
    // a parameter rather than a per-call tier lookup. That is a STRONGER lock
    // than the pair it replaced, not a weaker one: width and height are the
    // same identifier, so they cannot drift apart at all — the CLS failure this
    // contract exists for. What the callers pass (40 in the hero, 32/24/20 per
    // board tier) is pinned by `sponsors-board.test.tsx`, which can see values.
    width: "px",
    height: "px",
  },
  {
    name: "[orgSlug]/layout.tsx org logo",
    file: join(SRC_ROOT, "app/(public)/shared/[orgSlug]/layout.tsx"),
    srcExpr: "org.logo",
    width: 32,
    height: 32,
  },
];

describe("public next/image conversions (source contract)", () => {
  it.each(CASES)("$name: imports Image from next/image", ({ file }) => {
    const source = readFileSync(file, "utf8");
    expect(source).toMatch(/import\s+Image\s+from\s+["']next\/image["']/);
  });

  it.each(CASES)("$name: converted element keeps its width/height pair", ({ file, srcExpr, width, height }) => {
    const source = readFileSync(file, "utf8");
    const tagMatch = source.match(/<Image\b[\s\S]*?\/>/);
    expect(tagMatch, `expected an <Image ... /> element in ${file}`).not.toBeNull();
    const tag = (tagMatch as RegExpMatchArray)[0];
    expect(tag).toContain(`src={${srcExpr}}`);
    expect(tag).toContain(`width={${width}}`);
    expect(tag).toContain(`height={${height}}`);
  });

  it.each(CASES)("$name: has not reverted to a plain <img> for the same source", ({ file, srcExpr }) => {
    const source = readFileSync(file, "utf8");
    const imgTags = source.match(/<img\b[\s\S]*?\/>/g) ?? [];
    for (const tag of imgTags) {
      expect(tag).not.toContain(`src={${srcExpr}}`);
    }
  });
});
