// ESLint zero-warnings programme (L4, owner ruling 2026-10-14): the three
// React-Compiler-era rules `eslint.config.mjs` lists —
// `react-hooks/set-state-in-effect`, `react-hooks/purity`,
// `react-hooks/static-components` — were cleared FOR REAL: no suppression
// comment, no loosened config. `--max-warnings 0` (the `lint` scripts) keeps a
// new violation from merging, but it cannot tell a violation from a violation
// somebody silenced with one comment. This is the other half: a directive that
// names one of these rules, or a bare `eslint-disable` that silences them all,
// is a red here, in the same place a reviewer would look.
//
// If this is red: fix the code (derive in render, a render-phase reset keyed on
// the input, or land the state from the async callback) — see the commits
// "…without setting state from an effect" for each pattern. Do not widen the
// exemption list below; it is deliberately empty.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";

/** The rules this ratchet owns. The config sets them to "warn"; the lint
 *  scripts' `--max-warnings 0` turns that into a gate. */
const RULES = ["set-state-in-effect", "purity", "static-components"] as const;

// A directive COMMENT — line, block, or the JSX braces form — opening the line,
// that either names one of the rules or names none (a bare `eslint-disable`
// silences every rule). Anchored at the line start so prose that merely MENTIONS
// a directive (a test comment saying what a component used to carry) is not one.
const DIRECTIVE = new RegExp(
  String.raw`^[ \t]*(?:\{[ \t]*)?(?:\/\/|\/\*)[ \t]*eslint-disable(?:-next-line|-line)?\b([^\n]*)$`,
  "gm",
);

function offences(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(DIRECTIVE)) {
    // Drop the `-- reason` and any closing `*/ }` before reading the rule list.
    const body = m[1]!.split("--")[0]!.replace(/\*\/\s*\}?\s*$/, "").trim();
    const bare = body === "";
    const named = RULES.some((r) => body.includes(`react-hooks/${r}`));
    if (bare || named) out.push(m[0].trim());
  }
  return out;
}

function files(): string[] {
  const roots = ["src", "e2e"];
  return roots
    .flatMap((root) =>
      readdirSync(root, { recursive: true, encoding: "utf8" }).map((f) => `${root}/${f}`),
    )
    .filter((f) => /\.(?:ts|tsx|mts|js|mjs)$/.test(f))
    .sort();
}

describe("the React-Compiler rules stay cleared, not silenced", () => {
  it("scans a real tree — the premise every assertion below rests on", () => {
    const all = files();
    expect(all.length, "a walk that finds nothing reports clean forever").toBeGreaterThan(1500);
    expect(all).toContain("src/components/v2/fixture-stream-panel.tsx");
    expect(all).toContain("src/components/public-site/register/register-stepper.tsx");
    expect(all.some((f) => f.startsWith("e2e/"))).toBe(true);
  });

  it("the matcher fires on every directive shape that silences them, and on nothing else", () => {
    const fires = [
      "// eslint-disable-next-line react-hooks/set-state-in-effect",
      "    // eslint-disable-next-line react-hooks/purity -- reason",
      "{/* eslint-disable-next-line react-hooks/static-components */}",
      "  {/* eslint-disable-next-line react-hooks/set-state-in-effect -- reason */}",
      "/* eslint-disable react-hooks/set-state-in-effect */",
      "// eslint-disable-line react-hooks/purity",
      "// eslint-disable-next-line react-hooks/exhaustive-deps, react-hooks/set-state-in-effect",
      "/* eslint-disable */",
      "// eslint-disable",
    ];
    for (const line of fires) expect(offences(line), line).toHaveLength(1);

    const quiet = [
      "// eslint-disable-next-line react-hooks/exhaustive-deps",
      "// eslint-disable-next-line react-hooks/exhaustive-deps -- set-state-in-effect is not this",
      "{/* eslint-disable-next-line @next/next/no-img-element */}",
      "// eslint-disable-next-line @typescript-eslint/no-explicit-any",
      "// Each of these used to carry an `eslint-disable react-hooks/set-state-in-effect`.",
      "const s = '// eslint-disable-next-line react-hooks/purity';",
      "// the set-state-in-effect rule is on",
    ];
    for (const line of quiet) expect(offences(line), line).toEqual([]);
  });

  it("no file in src/ or e2e/ carries a directive that silences them", () => {
    const hits: string[] = [];
    let checked = 0;
    for (const f of files()) {
      checked++;
      for (const o of offences(readFileSync(f, "utf8"))) hits.push(`${f}: ${o}`);
    }
    expect(checked, "anti-vacuity: files actually read").toBeGreaterThan(1500);
    expect(hits).toEqual([]);
  });
});
