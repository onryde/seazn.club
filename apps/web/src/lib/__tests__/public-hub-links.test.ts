// LIVE1 (owner ruling 2026-11-03): the public spectator tree moved from `/shared/…` to `/live/…`, with a permanent
// 308 from the old root kept forever. Every spectator URL is now built by ONE builder — `routes.*` in lib/routes.ts,
// over the root in lib/public-hub-root.mjs — and this is the guard that keeps it that way.
//
// Why it matters beyond tidiness: a producer that still writes `/shared/…` keeps WORKING (the redirect catches it),
// so nothing else goes red. But every such link costs a visitor a 308 round trip, sends Next's client-side `?_rsc`
// navigation through a redirect, and prints the dead root onto a new QR code or email. And a producer that writes
// `/live/…` by hand is the next rename's missed site. So: no string in the app may spell either root, except the one
// module that declares them.
//
// What is scanned: every non-test source file under src/ (.ts .tsx .js .mjs), plus next.config.js (the redirect and
// the match room's header rule live there). What is read in each: the STRINGS the TypeScript parser sees — string
// and template literals, JSX text, regex literals — never comments (prose about the old path is history, not a
// producer) and never module specifiers (`@/app/(public)/live/…` is a file path, not a URL).
//
// What counts as a spectator path:
//   - `/shared` as a path segment, anywhere in a string (`"/shared/x"`, `${origin}/shared/`, `"/shared"`);
//   - `/live/` — the root followed by more path. A bare `"/live"` is the MARKETING page (option A) and is allowed.
// A regex literal is flagged when it spells `\/` and either root's word (proxy.ts's cacheable-tree regex was one).
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { readdirSync, readFileSync } from "node:fs";
import type * as TS from "typescript";

// `typescript` through require, not import: vite's import analysis chokes on the 10 MB CJS bundle
// (pass-scoping-guard.test.ts). The type side is a type-only import, erased before vite sees it.
const ts: typeof TS = createRequire(import.meta.url)("typescript");

const APP = new URL("../../../", import.meta.url).pathname; // apps/web, from apps/web/src/lib/__tests__

/** The one file allowed to spell the roots. Everything else goes through it. */
const ROOT_MODULE = "src/lib/public-hub-root.mjs";

/** Strings that spell `/live/` and are NOT our spectator tree, each pinned to its file and exact text so the
 *  exemption cannot grow by accident — and each must still be found, or the entry is stale and reds. Both are the
 *  RTMP(S) application path a stream key follows (`rtmps://live.cloudflare.com:443/live/<key>`). */
const NOT_THE_HUB: { file: string; text: string }[] = [
  { file: "src/server/relay/sanitise.ts", text: "/live/" },
  { file: "src/server/relay/fakes.ts", text: "rtmps://fake.ingest.invalid:443/live/" },
];

const SHARED_SEGMENT = /\/shared(?![\w-])/;
const LIVE_DEEP = /\/live\//;
const REGEX_ROOT = /\\\/.*\b(shared|live)\b/;

type Offence = { file: string; line: number; text: string };

function isModuleSpecifier(node: TS.Node): boolean {
  const p = node.parent;
  if (!p) return false;
  if ((ts.isImportDeclaration(p) || ts.isExportDeclaration(p)) && p.moduleSpecifier === node) return true;
  if (ts.isExternalModuleReference(p)) return true;
  if (ts.isLiteralTypeNode(p) && p.parent && ts.isImportTypeNode(p.parent)) return true;
  if (ts.isCallExpression(p) && p.arguments[0] === node) {
    if (p.expression.kind === ts.SyntaxKind.ImportKeyword) return true;
    if (ts.isIdentifier(p.expression) && p.expression.text === "require") return true;
  }
  return false;
}

/** Every spectator-path string in `text`, and how many strings were read (anti-vacuity). */
export function scanSource(file: string, text: string): { offences: Offence[]; strings: number } {
  const kind = file.endsWith("x") ? ts.ScriptKind.TSX : /\.m?js$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const offences: Offence[] = [];
  let strings = 0;
  const visit = (node: TS.Node) => {
    let value: string | null = null;
    let isRegex = false;
    switch (node.kind) {
      case ts.SyntaxKind.StringLiteral:
      case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
      case ts.SyntaxKind.TemplateHead:
      case ts.SyntaxKind.TemplateMiddle:
      case ts.SyntaxKind.TemplateTail:
        if (!isModuleSpecifier(node)) value = (node as TS.LiteralLikeNode).text;
        break;
      case ts.SyntaxKind.JsxText:
        value = (node as TS.JsxText).text;
        break;
      case ts.SyntaxKind.RegularExpressionLiteral:
        value = (node as TS.RegularExpressionLiteral).text;
        isRegex = true;
        break;
    }
    if (value !== null) {
      strings += 1;
      const hit = isRegex ? REGEX_ROOT.test(value) : SHARED_SEGMENT.test(value) || LIVE_DEEP.test(value);
      if (hit) {
        const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
        offences.push({ file, line, text: value.trim().slice(0, 120) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { offences, strings };
}

const isTest = (f: string) => f.split("/").includes("__tests__") || /\.test\.[cm]?[jt]sx?$/.test(f);

function sourceFiles(): string[] {
  const src = readdirSync(`${APP}src`, { recursive: true, encoding: "utf8" })
    .map((f) => `src/${f}`)
    .filter((f) => /\.(m?js|tsx?)$/.test(f) && !isTest(f));
  return [...src, "next.config.js"].sort();
}

describe("LIVE1: one builder for spectator URLs (routes.* over lib/public-hub-root.mjs)", () => {
  it("the detector flags hand-written spectator paths and leaves the marketing page, file paths and comments alone — counted", () => {
    const flagged = [
      `const a = "/shared/club/spring";`,
      "const b = `/shared/${org}/${comp}`;",
      "const c = `${origin}/shared/${org}`;",
      `const d = ["/shared", org].join("/");`,
      "const e = `/live/${org}`;",
      `const f = "https://seazn.club/live/club/spring";`,
      "const g = `${siteOrigin()}/live/${org}/${comp}/register`;",
      "const h = <a href={`/live/${org}`}>x</a>;",
      `const i = <code>/shared/&lt;org&gt;</code>;`,
      "const j = /^\\/(shared|embed)(\\/|$)/;",
      "const k = `x ${a} /live/${b}`;",
    ];
    const clean = [
      `const a = "/live";`,
      `const b = <a href="/live">wall</a>;`,
      "const c = `/${lang}/live`;",
      `import { x } from "@/app/(public)/live/[orgSlug]/page";`,
      `import { y } from "@/components/v2/shared/datetime-field";`,
      `export { z } from "../shared";`,
      `const m = await import("@/app/(public)/live/x");`,
      `type T = typeof import("@/app/(public)/live/x");`,
      `const d = "/live-score-data";`,
      `const e = "shared";`,
      `// a comment about /shared/<org> and /live/<org>`,
      `/** \`/live/<org>/<comp>\` in a JSDoc */ const f = 1;`,
      `const g = "/sharedx";`,
      `const h = "cpu: shared";`,
    ];
    let checked = 0;
    for (const snippet of flagged) {
      const file = snippet.includes("<") ? "probe.tsx" : "probe.ts";
      expect(scanSource(file, snippet).offences.length, `should flag: ${snippet}`).toBe(1);
      checked += 1;
    }
    for (const snippet of clean) {
      const file = snippet.includes("<a") || snippet.includes("<code") ? "probe.tsx" : "probe.ts";
      const { offences, strings } = scanSource(file, snippet);
      expect(offences, `should NOT flag: ${snippet}`).toEqual([]);
      // A literal clean case must still have been READ, or "not flagged" is vacuous. Comments and module specifiers
      // are the cases that are clean BECAUSE they are not read.
      const unread = /^(\/\/|\/\*\*|import |export |type |const m = await import)/.test(snippet);
      expect(strings > 0, `read: ${snippet}`).toBe(!unread);
      checked += 1;
    }
    expect(checked, "anti-vacuity: probes").toBe(flagged.length + clean.length);
  });

  it("no source file outside lib/public-hub-root.mjs spells /shared or /live/ — every file scanned, counted", () => {
    const files = sourceFiles();
    const offences: Offence[] = [];
    let strings = 0;
    const reached = new Set<string>();
    const usedExemptions = new Set<(typeof NOT_THE_HUB)[number]>();
    for (const file of files) {
      const r = scanSource(file, readFileSync(`${APP}${file}`, "utf8"));
      strings += r.strings;
      if (r.strings > 0) reached.add(file);
      if (file === ROOT_MODULE) continue;
      for (const o of r.offences) {
        const exempt = NOT_THE_HUB.find((x) => x.file === o.file && x.text === o.text);
        if (exempt) usedExemptions.add(exempt);
        else offences.push(o);
      }
    }
    console.info(`public-hub-links: scanned ${files.length} files, ${strings} strings, ${offences.length} offences`);
    expect(files.length, "anti-vacuity: files scanned").toBeGreaterThan(500);
    expect(strings, "anti-vacuity: strings read").toBeGreaterThan(10_000);
    // Reach: the files that matter most were actually read, not just listed.
    for (const must of ["src/lib/routes.ts", "src/proxy.ts", "next.config.js", ROOT_MODULE, "src/app/sitemap.ts", "src/app/robots.ts"]) {
      expect(reached.has(must), `reached ${must}`).toBe(true);
    }
    // The root module itself must still spell both roots — otherwise the allowlist exempts nothing and a moved root
    // would go unnoticed here.
    const root = scanSource(ROOT_MODULE, readFileSync(`${APP}${ROOT_MODULE}`, "utf8"));
    expect(root.offences.length, "the root module spells /shared (the redirect's source)").toBe(1);
    expect(
      NOT_THE_HUB.filter((x) => !usedExemptions.has(x)).map((x) => `${x.file}  ${x.text}`),
      "stale exemptions: each must still be found, or delete it",
    ).toEqual([]);
    expect(
      offences.map((o) => `${o.file}:${o.line}  ${o.text}`),
      "build these with routes.* from @/lib/routes (LIVE1) — never by hand",
    ).toEqual([]);
  });
});
