import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

// Owner 2026-11-13 ("ok add the test"). The marketing home (`/`, `/<lang>`) and `/<lang>/play` render THIS visitor's own
// quick-match links (the recent strip and the Continue card, read from the visitor cookie), and `/q/<token>` is a private
// match home. They are safe behind Cloudflare only because the origin answers a per-request render with
// `Cache-Control: private, no-cache, no-store` (verified on stg 2026-11-13; the zone has no rule caching these paths). A
// route that turned ISR/static (a `revalidate` export, `dynamic = "force-static"`, a `"use cache"` directive, or losing
// its per-request read) would let a CDN hand one visitor's links to the next.
//
// This is the cheap tripwire, read as source text (vitest here is `environment: "node"` and cannot build a route): no
// cache-enabling segment config on the page OR on any layout above it (a layout's `revalidate`/`dynamic` applies to the
// segments under it), and a per-request read on every page. The authority is the header itself, probed against a
// production build by e2e/quick-match-private-cache.spec.ts; this file catches the intent before a build does.
//
// `/` has no file of its own: proxy.ts rewrites it to `/<locale>` (MARKETING_UNPREFIXED), i.e. the [lang] home below.
const APP = join(process.cwd(), "src/app");
const SRC = join(process.cwd(), "src");

const PRIVATE_PAGES = [
  { serves: "/ and /<lang> (the recent strip)", file: "[lang]/(marketing)/page.tsx" },
  { serves: "/<lang>/play (the Continue card and the recent strip)", file: "[lang]/(marketing)/play/page.tsx" },
  { serves: "/q/<token> (the private match home)", file: "q/[token]/page.tsx" },
] as const;

/**
 * Functions a page may call that read the request (and so make the render per-request), with the module that defines
 * each. The module must itself import the reader from `next/headers` and call it, or the entry is a claim, not a read.
 */
const PER_REQUEST_READERS = [
  { call: "readRecentQuickMatches", module: "server/usecases/quick-match-recent.ts", reads: "cookies" },
] as const;

/**
 * Segment config / directives that make a route's HTML cacheable. Anchored at a line start so a comment that quotes
 * one (`//  export const revalidate = 30`) is not a hit. `revalidate = 0` is the one allowed value: it means dynamic.
 */
const CACHE_ENABLERS = [
  { what: "a revalidate export other than 0", re: /^\s*export\s+const\s+revalidate\s*=(?!\s*0\s*;?\s*$)/m },
  { what: 'dynamic = "force-static" or "error" (both render once and serve it to everyone)', re: /^\s*export\s+const\s+dynamic\s*=\s*["'](?:force-static|error)["']/m },
  { what: 'a "use cache" directive', re: /^\s*["']use cache(?::[^"']*)?["']/m },
] as const;

const FORCE_DYNAMIC = /^\s*export\s+const\s+dynamic\s*=\s*["']force-dynamic["']/m;

const read = (abs: string) => readFileSync(abs, "utf8");

/** The page's own file, then every layout from its folder up to src/app (the segments whose config applies to it). */
function routeChain(pageRel: string): string[] {
  const chain = [join(APP, pageRel)];
  for (let dir = dirname(join(APP, pageRel)); ; dir = dirname(dir)) {
    for (const name of ["layout.tsx", "layout.ts"]) {
      const layout = join(dir, name);
      if (existsSync(layout)) chain.push(layout);
    }
    if (dir === APP) break;
  }
  return chain;
}

describe("private quick-match pages stay per-request (never ISR/static, so never CDN-shareable)", () => {
  it("each cache-enabling rule matches its own witness line and not a commented quote of it (the rules are not vacuous)", () => {
    const witnesses: Record<(typeof CACHE_ENABLERS)[number]["what"], { hit: string; miss: string[] }> = {
      "a revalidate export other than 0": {
        hit: "export const revalidate = 30;",
        miss: ["export const revalidate = 0;", "// export const revalidate = 30;", " * export const revalidate = 30"],
      },
      'dynamic = "force-static" or "error" (both render once and serve it to everyone)': {
        hit: 'export const dynamic = "force-static";',
        miss: ['export const dynamic = "force-dynamic";', '// export const dynamic = "force-static";'],
      },
      'a "use cache" directive': { hit: '"use cache";', miss: ['// "use cache";', '"use client";'] },
    };
    let checked = 0;
    for (const rule of CACHE_ENABLERS) {
      const w = witnesses[rule.what];
      expect(rule.re.test(`import x from "y";\n${w.hit}\n`), `${rule.what}: hits its witness`).toBe(true);
      for (const miss of w.miss) expect(rule.re.test(`import x from "y";\n${miss}\n`), `${rule.what}: not "${miss}"`).toBe(false);
      checked += 1;
    }
    // `export const dynamic = "error"` is the second spelling the dynamic rule exists for.
    expect(CACHE_ENABLERS[1].re.test('export const dynamic = "error";')).toBe(true);
    expect(checked, "anti-vacuity: rules self-checked").toBe(CACHE_ENABLERS.length);
    expect(checked).toBeGreaterThan(0);
  });

  it("no page, and no layout above it, carries a revalidate export, force-static/error or a \"use cache\" directive", () => {
    const scanned = new Set<string>();
    let pages = 0;
    for (const page of PRIVATE_PAGES) {
      const chain = routeChain(page.file);
      // The page file itself plus at least the root layout: a chain of one means the walk lost its way.
      expect(chain.length, `${page.serves}: page + layouts found`).toBeGreaterThanOrEqual(2);
      for (const file of chain) {
        const src = read(file);
        for (const rule of CACHE_ENABLERS) {
          expect(rule.re.test(src), `${relative(SRC, file)} (on the route of ${page.serves}) has ${rule.what}`).toBe(false);
        }
        scanned.add(file);
      }
      pages += 1;
    }
    expect(pages, "anti-vacuity: private pages checked").toBe(PRIVATE_PAGES.length);
    expect(pages).toBeGreaterThan(0);
    // 3 pages + the [lang]/(marketing) layout + the root layout, each read once however many pages share it.
    expect(scanned.size, `files scanned: ${[...scanned].map((f) => relative(SRC, f)).join(", ")}`).toBe(5);
  });

  it("every page reads the request: force-dynamic, or a call to a reader whose module reads next/headers", () => {
    // A reader is only a witness if its module really imports and calls the request API it is listed for.
    let readersProven = 0;
    for (const reader of PER_REQUEST_READERS) {
      const src = read(join(SRC, reader.module));
      expect(src, `${reader.module} defines ${reader.call}`).toMatch(new RegExp(`export\\s+(?:async\\s+)?function\\s+${reader.call}\\b`));
      expect(src, `${reader.module} imports ${reader.reads} from next/headers`).toMatch(
        new RegExp(`import\\s*\\{[^}]*\\b${reader.reads}\\b[^}]*\\}\\s*from\\s*["']next/headers["']`),
      );
      expect(src, `${reader.module} calls ${reader.reads}()`).toMatch(new RegExp(`\\b${reader.reads}\\(\\)`));
      readersProven += 1;
    }
    expect(readersProven, "anti-vacuity: per-request readers proven").toBe(PER_REQUEST_READERS.length);

    const witnessed: string[] = [];
    for (const page of PRIVATE_PAGES) {
      const src = read(join(APP, page.file));
      const signals = [
        ...(FORCE_DYNAMIC.test(src) ? ['dynamic = "force-dynamic"'] : []),
        ...PER_REQUEST_READERS.filter(
          (r) =>
            new RegExp(`import\\s*\\{[^}]*\\b${r.call}\\b[^}]*\\}\\s*from\\s*["']@/${r.module.replace(/\.ts$/, "")}["']`).test(src) &&
            new RegExp(`\\b${r.call}\\(`).test(src),
        ).map((r) => `${r.call}() (${r.reads})`),
      ];
      expect(signals.length, `${page.serves}: no per-request read, so the route can prerender once for everyone`).toBeGreaterThan(0);
      witnessed.push(`${page.serves}: ${signals.join(" + ")}`);
    }
    expect(witnessed.length, `anti-vacuity: pages with a per-request read\n${witnessed.join("\n")}`).toBe(PRIVATE_PAGES.length);
  });
});
