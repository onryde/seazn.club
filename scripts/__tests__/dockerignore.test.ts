// Ruling 56 (2026-10-04): the Fly image's build context leaves out tools/ (the
// dev-only harnesses) and the format-matrix truth-run evidence. Docker is not
// run here, so the context is judged the way BuildKit judges it: .dockerignore
// compiled by moby/patternmatcher's rules — `**` spans any number of
// directories (zero included), `*` and `?` stay inside one segment, a pattern
// that matches a parent directory excludes everything below it, `!` re-includes,
// and the LAST matching line wins. The matcher's own cases come first, from
// Docker's documented semantics, so the tree checks below rest on a matcher
// that is itself pinned.
// Single-sport reason: no sport is involved — this is the image's build context.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TRUTH_RUNS_LINE = "docs/superpowers/specs/**/truth-runs/";

interface Rule { re: RegExp; exclude: boolean; line: string }

/** One .dockerignore pattern -> moby/patternmatcher's anchored regex. */
function compile(pattern: string): RegExp {
  let re = "^";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        i++;
        if (pattern[i + 1] === "/") i++; // `**/` is `**`
        re += i + 1 >= pattern.length ? ".*" : "(?:.*/)?";
      } else re += "[^/]*";
    } else if (ch === "?") re += "[^/]";
    else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`${re}$`);
}

/** .dockerignore's lines as BuildKit reads them: trimmed, comments and blanks
 *  dropped, cleaned of a leading and trailing `/`. */
function rules(text: string): Rule[] {
  return text.split("\n").map((l) => l.trim()).filter((l) => l !== "" && !l.startsWith("#")).map((line) => {
    const exclude = !line.startsWith("!");
    const p = (exclude ? line : line.slice(1)).replace(/^\/+/, "").replace(/\/+$/, "");
    return { re: compile(p), exclude, line };
  });
}

/** Is `path` (repo-relative) left out of the context? The path or any parent
 *  directory may match; the last matching rule decides. */
function excluded(rs: readonly Rule[], path: string): boolean {
  const parts = path.split("/");
  const candidates = parts.map((_, i) => parts.slice(0, i + 1).join("/"));
  let out = false;
  for (const r of rs) if (candidates.some((c) => r.re.test(c))) out = r.exclude;
  return out;
}

const live = rules(readFileSync(resolve(REPO, ".dockerignore"), "utf8"));
const tracked = (dir: string): string[] =>
  execFileSync("git", ["ls-files", "-z", "--", dir], { cwd: REPO, encoding: "utf8" }).split("\0").filter((f) => f !== "");

describe(".dockerignore (ruling 56): the image's build context", () => {
  it("the matcher follows Docker's documented semantics — root-anchored `*`, `**` at any depth (zero included), parent matches, `!` and last-match-wins", () => {
    const rs = rules(["*.md", "!README.md", "**/node_modules", "apps/cron-worker", "/tools/", "docs/**/runs/", "a?c"].join("\n"));
    const cases: [string, boolean][] = [
      ["NOTES.md", true], // `*.md` is the context root only…
      ["docs/a.md", false], // …never a nested file (unlike .gitignore)
      ["README.md", false], // re-included by the later `!` line
      ["node_modules/x/y.js", true], ["apps/web/node_modules/z/i.js", true], // `**/` spans zero or more dirs
      ["apps/cron-worker/src/index.ts", true], ["apps/cron-workers/x.ts", false], // a dir match excludes its contents, by segment
      ["tools/matrix/run.ts", true], ["scripts/tools/x.ts", false], // leading `/` and trailing `/` are cleaned; still anchored
      ["docs/runs/a.json", true], ["docs/x/y/runs/a.json", true], ["docs/x/runsx/a.json", false],
      ["abc", true], ["a/c", false], // `?` stays inside one segment
    ];
    for (const [p, want] of cases) expect(excluded(rs, p), p).toBe(want);
    expect(cases.length).toBe(14);
  });

  it("both ruling-56 lines are in .dockerignore, as exclusions", () => {
    const lines = live.map((r) => `${r.exclude ? "" : "!"}${r.line}`);
    expect(lines).toContain("tools/");
    expect(lines).toContain(TRUTH_RUNS_LINE);
    // Nothing re-includes either of them afterwards.
    expect(live.filter((r) => !r.exclude && (r.line.includes("tools") || r.line.includes("truth-runs")))).toEqual([]);
  });

  it("every tracked file under tools/ and under the truth runs is out of the context — and the truth-runs line is what does it for the evidence", () => {
    const toolsFiles = tracked("tools");
    const evidence = tracked("docs/superpowers/specs").filter((f) => f.includes("/truth-runs/"));
    console.info(`dockerignore: ${toolsFiles.length} tools/ files, ${evidence.length} truth-run files judged`);
    expect(toolsFiles.length).toBeGreaterThan(100);
    expect(evidence.length).toBeGreaterThan(100);
    expect(toolsFiles.filter((f) => !excluded(live, f))).toEqual([]);
    expect(evidence.filter((f) => !excluded(live, f))).toEqual([]);
    // Not redundant: without the line, the JSON evidence (the ~12 MB of it) would ship.
    const without = live.filter((r) => r.line !== TRUTH_RUNS_LINE);
    expect(without.length).toBe(live.length - 1);
    const shipped = evidence.filter((f) => !excluded(without, f));
    expect(shipped.length).toBeGreaterThan(0);
    expect(shipped.some((f) => f.endsWith("results.json"))).toBe(true);
  });

  it("neither line reaches what the image builds from: every Dockerfile COPY source, the workspaces it installs, and the scripts its typecheck reads stay in", () => {
    const docker = readFileSync(resolve(REPO, "Dockerfile"), "utf8").split("\n");
    const sources = docker
      .map((l) => /^COPY\s+(?!--from)(.+)\s+\S+$/.exec(l.trim())?.[1])
      .filter((s): s is string => s !== undefined)
      .flatMap((s) => s.split(/\s+/))
      .filter((s) => s !== ".");
    expect(sources).toEqual(expect.arrayContaining(["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "apps/web/package.json"]));
    const kept = [
      ...sources,
      "packages/engine/src/competition/index.ts", "packages/reference/src/index.ts",
      "apps/web/src/lib/format-templates.ts", "apps/web/src/server/api-v1/schemas.ts",
      // apps/web's `typecheck` runs tsconfig.scripts.json over scripts/ inside the image.
      "tsconfig.scripts.json", "scripts/lib/main-module.ts", "scripts/lib/tools-import-guard.mjs", "scripts/reference-boundary.ts",
      "docs/superpowers/specs/2026-09-27-format-matrix-prompts/_INDEX.md",
    ];
    let judged = 0;
    for (const f of kept) {
      expect(excluded(live, f), f).toBe(false);
      judged++;
    }
    expect(judged).toBeGreaterThan(sources.length);
  });
});
