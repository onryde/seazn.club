// Source contract for task-8 (make the public tree actually ISR in
// production): every enumerated cacheable public/embed page must export
// BOTH `revalidate` (already present pre-task-8) AND `generateStaticParams`
// — in this Next version a dynamic-param route with no generateStaticParams
// never gets ISR treatment, regardless of `revalidate`
// (node_modules/next/dist/docs/01-app/03-api-reference/04-functions/
// generate-static-params.md: "You must return an empty array from
// generateStaticParams ... in order to revalidate (ISR) paths at runtime.").
// task-7-report.md audited this empirically (temporarily adding the export
// flipped the competition page from `ƒ` to ISR with a real curl showing
// `s-maxage=30`). No render harness exists here (see
// public-image-contract.test.ts) — this locks the source text instead.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC_ROOT = join(__dirname, "..", "..");

interface Case {
  name: string;
  file: string;
  revalidate: number;
}

const CASES: Case[] = [
  {
    name: "org landing",
    file: join(SRC_ROOT, "app/(public)/shared/[orgSlug]/page.tsx"),
    revalidate: 30,
  },
  {
    name: "competition home",
    file: join(SRC_ROOT, "app/(public)/shared/[orgSlug]/[competitionSlug]/page.tsx"),
    revalidate: 30,
  },
  {
    name: "division home",
    file: join(
      SRC_ROOT,
      "app/(public)/shared/[orgSlug]/[competitionSlug]/[divisionSlug]/page.tsx",
    ),
    revalidate: 30,
  },
  {
    name: "fixture page",
    file: join(
      SRC_ROOT,
      "app/(public)/shared/[orgSlug]/[competitionSlug]/[divisionSlug]/fixtures/[fixtureId]/page.tsx",
    ),
    revalidate: 30,
  },
  {
    name: "player card",
    file: join(SRC_ROOT, "app/(public)/shared/[orgSlug]/[competitionSlug]/players/[personId]/page.tsx"),
    revalidate: 300, // REVALIDATE_SLOW — keep the value, just add generateStaticParams
  },
  {
    name: "poster page",
    file: join(SRC_ROOT, "app/(public)/shared/[orgSlug]/[competitionSlug]/poster/page.tsx"),
    revalidate: 300,
  },
  {
    name: "embed widget page",
    file: join(SRC_ROOT, "app/embed/divisions/[id]/[widget]/page.tsx"),
    revalidate: 30,
  },
];

describe("public/embed ISR contract (task-8)", () => {
  it.each(CASES)("$name: still exports revalidate = $revalidate", ({ file, revalidate }) => {
    const source = readFileSync(file, "utf8");
    expect(source).toMatch(new RegExp(`export const revalidate = ${revalidate};`));
  });

  it.each(CASES)("$name: exports generateStaticParams returning an empty array", ({ file }) => {
    const source = readFileSync(file, "utf8");
    expect(source).toMatch(/export\s+async function\s+generateStaticParams\s*\(\s*\)\s*{/);
    expect(source).toMatch(/generateStaticParams[\s\S]*?return\s*\[\s*\]\s*;/);
  });

  it.each(CASES)(
    "$name: dynamicParams is not disabled (on-demand fill must stay on)",
    ({ file }) => {
      const source = readFileSync(file, "utf8");
      expect(source).not.toMatch(/dynamicParams\s*=\s*false/);
    },
  );

  // The three checks above are each satisfied by a page that is ALSO
  // `export const dynamic = "force-dynamic"` — and that page has no ISR at
  // all, because the route segment config wins over everything they assert.
  // This is not hypothetical: the fixture page shipped exactly that in task
  // 14d, to escape a `DYNAMIC_SERVER_USAGE` throw from reading `searchParams`,
  // and this file stayed green for the whole window (its own source comment,
  // `fixtures/[fixtureId]/page.tsx`, records the episode). A guard nothing
  // kills is not a guard.
  //
  // Anchored at statement position (`^\s*export`), NOT on the bare phrase:
  // that same page discusses `export const dynamic = "force-dynamic"` inside
  // a comment, and a substring match would fail on the prose while the real
  // export slipped past in a file that never mentioned it.
  it.each(CASES)("$name: exports no `dynamic` segment config at all", ({ file }) => {
    const source = readFileSync(file, "utf8");
    expect(source).not.toMatch(/^\s*export\s+const\s+dynamic\b/m);
  });
});
