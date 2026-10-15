// ESLint zero-warnings programme (L4, owner ruling 2026-10-14): the three
// React-Compiler-era rules `eslint.config.mjs` lists —
// `react-hooks/set-state-in-effect`, `react-hooks/purity`,
// `react-hooks/static-components` — were cleared FOR REAL: no suppression
// comment, no loosened config. `--max-warnings 0` (the `lint` scripts) keeps a
// new violation from merging, but it cannot tell a violation from a violation
// somebody silenced. This is the other half, and it has two halves of its own:
//   1. no COMMENT silences them: a disable directive that names one of the
//      rules (own-line OR trailing `code(); // eslint-disable-line …`, line or
//      block, anywhere on the line), a bare `eslint-disable` that silences all
//      of them, or an inline config `/* eslint react-hooks/purity: "off" */`.
//      Comments are found by the TypeScript parser, not by a regex over lines,
//      so a directive-shaped string, regex or JSX text is not one and a
//      mid-line comment is;
//   2. no CONFIG silences them: the effective config (`eslint --print-config`
//      on a real file, i.e. after every spread and override) holds each rule at
//      warn or error — a `"off"` in eslint.config.mjs, or an override block
//      added after it, reds here.
//
// If this is red: fix the code (derive in render, a render-phase reset keyed on
// the input, or land the state from the async callback) — see the commits
// "…without setting state from an effect" for each pattern. Do not widen the
// exemption list below; it is deliberately empty.
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { readdirSync, readFileSync } from "node:fs";
import type * as TS from "typescript";

// `typescript` through require, not import: vite's import analysis chokes on the 10 MB CJS bundle
// (pass-scoping-guard.test.ts). The type side is a type-only import, erased before vite sees it.
const ts: typeof TS = createRequire(import.meta.url)("typescript");

const APP = new URL("../../../", import.meta.url).pathname; // apps/web, from apps/web/src/lib/__tests__

/** The rules this ratchet owns. The config sets them to "warn"; the lint
 *  scripts' `--max-warnings 0` turns that into a gate. */
const RULES = ["set-state-in-effect", "purity", "static-components"] as const;

/** Every comment in `text`, as the parser sees the file. The comments are the trivia between two consecutive tokens, so
 *  what is scanned for `//` and a block opener is pure whitespace-and-comments — never a string, a regex or JSX text. */
function commentsOf(path: string, text: string): string[] {
  const kind = path.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, false, kind);
  const leaves: TS.Node[] = [];
  const walk = (n: TS.Node) => {
    // JSDoc nodes are children of the tree but their text is trivia: leave them to the region scan.
    if (n.kind >= ts.SyntaxKind.FirstJSDocNode && n.kind <= ts.SyntaxKind.LastJSDocNode) return;
    const kids = n.getChildren(sf);
    if (kids.length === 0) leaves.push(n);
    else kids.forEach(walk);
  };
  walk(sf);
  const out: string[] = [];
  let from = 0;
  for (const leaf of leaves) {
    const start = leaf.getStart(sf);
    if (start >= from) collect(text.slice(from, start), out);
    from = Math.max(from, leaf.getEnd());
  }
  return out;
}

/** The comments in a run of trivia (whitespace, `//…` to end of line, and block comments). */
function collect(trivia: string, out: string[]): void {
  let i = 0;
  while (i < trivia.length) {
    if (trivia.startsWith("//", i)) {
      const eol = trivia.indexOf("\n", i);
      const end = eol === -1 ? trivia.length : eol;
      out.push(trivia.slice(i, end));
      i = end;
    } else if (trivia.startsWith("/*", i)) {
      const close = trivia.indexOf("*/", i + 2);
      const end = close === -1 ? trivia.length : close + 2;
      out.push(trivia.slice(i, end));
      i = end;
    } else i++;
  }
}

/** Why a comment silences one of the rules, or null. ESLint reads a directive from the comment's trimmed text:
 *  `eslint-disable[-next-line|-line] <rules> -- <why>` and `eslint <rule>: <setting>`. */
function offence(comment: string): string | null {
  const body = (comment.startsWith("//") ? comment.slice(2) : comment.slice(2, -2)).trim();
  const disable = /^eslint-disable(?:-next-line|-line)?(?=\s|$)/.exec(body);
  if (disable) {
    const rest = body.slice(disable[0].length).split(/\s-{2,}\s/)[0]!;
    const rules = rest.split(",").map((r) => r.trim()).filter(Boolean);
    if (rules.length === 0) return "a bare eslint-disable silences every rule, these included";
    const named = rules.find((r) => RULES.some((x) => r === `react-hooks/${x}`));
    return named === undefined ? null : `disables ${named}`;
  }
  if (/^eslint(?=\s)/.test(body)) {
    for (const x of RULES) {
      // `react-hooks/purity: "off"`, `react-hooks/purity: 0`, `"react-hooks/purity": ["off"]`
      if (new RegExp(String.raw`["']?react-hooks\/${x}["']?\s*:\s*(?:\[\s*)?["']?(?:off|0)["']?(?=[\s,\]}]|$)`).test(body)) return `inline config turns ${x} off`;
    }
  }
  return null;
}

function files(): string[] {
  return ["src", "e2e"]
    .flatMap((root) => readdirSync(`${APP}${root}`, { recursive: true, encoding: "utf8" }).map((f) => `${root}/${f}`))
    .filter((f) => /\.(?:ts|tsx|mts|js|mjs)$/.test(f))
    .sort();
}

describe("no comment silences the React-Compiler rules", () => {
  it("scans a real tree — the premise every assertion below rests on", () => {
    const all = files();
    expect(all.length, "a walk that finds nothing reports clean forever").toBeGreaterThan(1500);
    expect(all).toContain("src/components/v2/fixture-stream-panel.tsx");
    expect(all).toContain("src/components/public-site/register/register-stepper.tsx");
    expect(all.some((f) => f.startsWith("e2e/"))).toBe(true);
  });

  it("the comment reader finds every comment shape and only comments", () => {
    const src = [
      "const a = 1; // trailing line",
      "const b = /* mid-line block */ 2;",
      'const s = "// not a comment" + \'/* nor this */\';',
      "const re = /\\/\\/ nor this/;",
      "const t = `// nor this ${a /* but this is */}`;",
      "/** doc */ function f() {}",
      "// own line",
      "export const jsx = <p>{/* jsx comment */}// jsx text, not a comment</p>;",
      "// last, no newline",
    ].join("\n");
    expect(commentsOf("probe.tsx", src)).toEqual([
      "// trailing line",
      "/* mid-line block */",
      "/* but this is */",
      "/** doc */",
      "// own line",
      "/* jsx comment */",
      "// last, no newline",
    ]);
  });

  it("the matcher fires on every comment that silences them, wherever it sits on the line, and on nothing else", () => {
    const fires = [
      "// eslint-disable-next-line react-hooks/set-state-in-effect",
      "// eslint-disable-line react-hooks/purity",
      "/* eslint-disable react-hooks/static-components */",
      "/* eslint-disable-next-line react-hooks/purity -- reason */",
      "// eslint-disable-next-line react-hooks/exhaustive-deps, react-hooks/set-state-in-effect",
      "//eslint-disable-line react-hooks/purity",
      "/*eslint-disable react-hooks/purity*/",
      "/* eslint-disable */",
      "// eslint-disable",
      "// eslint-disable-next-line",
      '/* eslint react-hooks/purity: "off" */',
      "/* eslint react-hooks/set-state-in-effect: 0 */",
      '/* eslint "react-hooks/static-components": ["off"] */',
      '/* eslint no-console: "warn", react-hooks/purity: "off" */',
    ];
    for (const c of fires) expect(offence(c), c).not.toBeNull();
    const quiet = [
      "// eslint-disable-next-line react-hooks/exhaustive-deps",
      "// eslint-disable-next-line react-hooks/exhaustive-deps -- set-state-in-effect is not this",
      "/* eslint-disable-next-line @next/next/no-img-element */",
      "// eslint-disable-next-line @typescript-eslint/no-explicit-any",
      "// Each of these used to carry an `eslint-disable react-hooks/set-state-in-effect`.",
      "// the set-state-in-effect rule is on",
      '/* eslint react-hooks/purity: "warn" */',
      '/* eslint react-hooks/purity: "error" */',
      "/* eslint-enable react-hooks/purity */",
      "/** eslint-disable react-hooks/purity */",
    ];
    for (const c of quiet) expect(offence(c), c).toBeNull();
  });

  it("the reader and matcher together catch a trailing directive and an inline config in real source text", () => {
    const hit = (src: string) => commentsOf("probe.tsx", src).flatMap((c) => offence(c) ?? []);
    expect(hit("setX(1); // eslint-disable-line react-hooks/set-state-in-effect")).toHaveLength(1);
    expect(hit('/* eslint react-hooks/purity: "off" */\nconst n = Date.now();')).toHaveLength(1);
    expect(hit("const n = Date.now(); /* eslint-disable react-hooks/purity */")).toHaveLength(1);
    expect(hit('const s = "// eslint-disable-line react-hooks/purity";')).toEqual([]);
  });

  it("no file in src/ or e2e/ carries a comment that silences them", () => {
    const hits: string[] = [];
    let checked = 0;
    let comments = 0;
    for (const f of files()) {
      const text = readFileSync(`${APP}${f}`, "utf8");
      checked++;
      // A file with no "eslint" in it holds no directive: skip the parse, count the read.
      if (!text.includes("eslint")) continue;
      for (const c of commentsOf(f, text)) {
        comments++;
        const why = offence(c);
        if (why !== null) hits.push(`${f}: ${c.trim().slice(0, 100)} (${why})`);
      }
    }
    expect(checked, "anti-vacuity: files actually read").toBeGreaterThan(1500);
    expect(comments, "anti-vacuity: comments in files that mention eslint were parsed").toBeGreaterThan(100);
    expect(hits).toEqual([]);
  }, 60_000);
});

describe("no config silences the React-Compiler rules", () => {
  /** The effective rules for a real file: after every spread, preset and override. */
  function effectiveRules(file: string): Record<string, unknown[]> {
    const out = execFileSync(`${APP}node_modules/.bin/eslint`, ["--print-config", file], { cwd: APP, encoding: "utf8", timeout: 60_000 });
    return (JSON.parse(out) as { rules: Record<string, unknown[]> }).rules;
  }
  const severity = (setting: unknown[] | undefined): number | null => {
    const s = setting?.[0];
    return s === 0 || s === 1 || s === 2 ? s : null;
  };

  it("each of the three is a warning or an error in the effective config, in src, in e2e and in a test file", () => {
    let checked = 0;
    for (const file of ["src/lib/db.ts", "src/components/v2/fixture-stream-panel.tsx", "e2e/helpers.ts", "src/lib/__tests__/compiler-rules-no-disables.test.ts"]) {
      const rules = effectiveRules(file);
      for (const x of RULES) {
        checked++;
        const s = severity(rules[`react-hooks/${x}`]);
        expect(s, `${file}: react-hooks/${x} must be warn (1) or error (2), not off (0) or unset`).toBeGreaterThanOrEqual(1);
      }
    }
    expect(checked, "anti-vacuity: rule/file pairs judged").toBe(12);
  }, 120_000);

  it("no react-hooks rule at all is switched off — the compiler family has more members than the three the config names", () => {
    const rules = effectiveRules("src/lib/db.ts");
    const hooks = Object.entries(rules).filter(([k]) => k.startsWith("react-hooks/"));
    expect(hooks.length, "anti-vacuity: the plugin's rules were reported").toBeGreaterThanOrEqual(14);
    const off = hooks.filter(([, v]) => severity(v) !== 1 && severity(v) !== 2).map(([k]) => k);
    expect(off, "an explicit allowlist would go here; it is deliberately empty").toEqual([]);
  }, 60_000);
});
