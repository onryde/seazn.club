// `.claude/skills/docs-follow-product/SKILL.md` is the procedure AGENTS.md points to for keeping help and blog in step with
// the product. A procedure that names a path or a test that has since moved sends the next agent to a place that is not
// there, and nothing else would notice: no build reads a skill. This test is that reader.
//
// What it holds the skill to, each COUNTED (zero found is a failure, never a clean pass):
//   - the file exists, its `name` is its folder, and its description still carries every trigger branch;
//   - every repo path the skill names exists on disk;
//   - every `vitest run` command's filters match at least one real test file (vitest filters are substrings of the path,
//     taken from `apps/web`);
//   - every UPPER_CASE constant or env var the skill names is still spelled somewhere in the tree;
//   - AGENTS.md and the PR template point at the skill / carry the checkbox, so the three parts cannot drift apart.
// The checkers are pure functions over text, and the last describe feeds them a bad path, a bad filter and a missing
// constant to prove each one fires.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REPO = join(import.meta.dirname, "..", "..");
const SKILL_PATH = ".claude/skills/docs-follow-product/SKILL.md";
const WEB = join(REPO, "apps", "web");

/** A repo path as the skill writes it: rooted at a top-level folder this repo has, ending before punctuation or a space. */
const REPO_PATH = /(?:^|[\s`("'])((?:apps|docs|scripts|packages|\.github|\.claude)\/[A-Za-z0-9_.\-/[\]]*[A-Za-z0-9_\]/-])/g;
/** An UPPER_CASE constant or env var, six characters or more, written in backticks or in front of a command. */
const CONSTANT = /(?:`|\s)([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)(?=[`=\s,.)])/g;

function pathsNamed(text: string): string[] {
  return [...new Set([...text.matchAll(REPO_PATH)].map((m) => m[1]!))];
}

/** The positional filters of every `vitest run` line in the text: tokens after `run` that are not flags. */
function vitestFilters(text: string): { line: string; filters: string[] }[] {
  const out: { line: string; filters: string[] }[] = [];
  for (const line of text.split("\n")) {
    const at = line.indexOf("vitest run");
    if (at === -1) continue;
    const filters = line
      .slice(at + "vitest run".length)
      .split(/\s+/)
      .filter((t) => t.length > 0 && !t.startsWith("--"));
    out.push({ line, filters });
  }
  return out;
}

function constantsNamed(text: string): string[] {
  return [...new Set([...text.matchAll(CONSTANT)].map((m) => m[1]!).filter((c) => c.length >= 6))];
}

const walkTests = (dir: string, base = dir, acc: string[] = []): string[] => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".next") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkTests(full, base, acc);
    else if (/\.test\.(ts|tsx)$/.test(entry.name)) acc.push(full.slice(base.length + 1));
  }
  return acc;
};

/** Paths relative to `apps/web`, the cwd the skill's commands run in. */
const WEB_TESTS = walkTests(join(WEB, "src"), WEB);

/** True when `git grep` finds the literal in a tracked file under apps/ or scripts/. This file is excluded: it spells the
 *  constants itself, and would make every one of them findable. */
const spelledInTree = (needle: string): boolean => {
  const r = spawnSync(
    "git",
    ["grep", "-a", "-l", "-F", "-e", needle, "--", "apps", "scripts", ":!scripts/__tests__/docs-follow-product-skill.test.ts"],
    { cwd: REPO, encoding: "utf8" },
  );
  return r.status === 0 && r.stdout.trim().length > 0;
};

const missingPaths = (text: string): string[] => pathsNamed(text).filter((p) => !existsSync(join(REPO, p)));
const deadFilters = (text: string): string[] =>
  vitestFilters(text).flatMap(({ filters }) => filters.filter((f) => !WEB_TESTS.some((t) => t.includes(f))));
const unspelled = (text: string): string[] => constantsNamed(text).filter((c) => !spelledInTree(c));

describe("the docs-follow-product skill", () => {
  it("exists, and is not empty", () => {
    expect(existsSync(join(REPO, SKILL_PATH)), `${SKILL_PATH} is missing`).toBe(true);
    expect(readFileSync(join(REPO, SKILL_PATH), "utf8").trim().length).toBeGreaterThan(500);
  });

  const text = existsSync(join(REPO, SKILL_PATH)) ? readFileSync(join(REPO, SKILL_PATH), "utf8") : "";
  const front = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? "";

  it("has a name that is its folder, and a description that carries every trigger branch", () => {
    expect(front, "no frontmatter").not.toBe("");
    expect(front).toMatch(/^name: docs-follow-product$/m);
    const description = /^description: (.+)$/m.exec(front)?.[1] ?? "";
    expect(description.length, "description").toBeGreaterThan(40);
    for (const branch of [/engine/i, /scoring|pairing/i, /UI copy/i, /label/i, /route/i, /limit/i]) {
      expect(description, `description lost a trigger: ${branch}`).toMatch(branch);
    }
  });

  it("names repo paths, and every one of them exists", () => {
    const named = pathsNamed(text);
    expect(named.length, "paths the skill names (anti-vacuity)").toBeGreaterThanOrEqual(10);
    expect(missingPaths(text)).toEqual([]);
  });

  it("gives vitest commands, and every filter matches a real test file", () => {
    const commands = vitestFilters(text);
    expect(commands.length, "vitest commands in the skill (anti-vacuity)").toBeGreaterThanOrEqual(3);
    const filters = commands.flatMap((c) => c.filters);
    expect(filters.length, "filters checked (anti-vacuity)").toBeGreaterThanOrEqual(8);
    expect(WEB_TESTS.length, "test files walked under apps/web/src (anti-vacuity)").toBeGreaterThan(500);
    expect(deadFilters(text)).toEqual([]);
    for (const { line } of commands) expect(line, "a command must run from apps/web").toContain("cd apps/web");
  });

  it("names constants and env vars that are still spelled in the tree", () => {
    const named = constantsNamed(text);
    expect(named, "the constants the skill relies on").toEqual(expect.arrayContaining(["UPDATE_BLOG_EXAMPLES", "HELP_REDIRECTS", "DATABASE_URL"]));
    expect(unspelled(text)).toEqual([]);
  });

  it("is pointed at by AGENTS.md, and the PR template carries its checkbox", () => {
    expect(readFileSync(join(REPO, "AGENTS.md"), "utf8")).toContain(SKILL_PATH);
    expect(readFileSync(join(REPO, ".github", "pull_request_template.md"), "utf8")).toContain(
      "- [ ] Help/blog updated for this change, or not affected (say why)",
    );
  });
});

describe("the checkers have teeth", () => {
  const GOOD = "Read `apps/web/content/help` and run:\n\n    cd apps/web && npx vitest run --reporter=json src/lib/__tests__/help-\n\nWith `UPDATE_BLOG_EXAMPLES=1` set.\n";

  it("passes the real shapes it is meant to accept", () => {
    expect(pathsNamed(GOOD)).toEqual(["apps/web/content/help", "apps/web"]);
    expect(missingPaths(GOOD)).toEqual([]);
    expect(deadFilters(GOOD)).toEqual([]);
    expect(unspelled(GOOD)).toEqual([]);
  });

  it("flags a path that does not exist", () => {
    expect(missingPaths(GOOD.replace("apps/web/content/help", "apps/web/content/hepl"))).toEqual(["apps/web/content/hepl"]);
  });

  it("flags a vitest filter that matches no test file", () => {
    expect(deadFilters(GOOD.replace("src/lib/__tests__/help-", "src/lib/__tests__/no-such-suite-"))).toEqual(["src/lib/__tests__/no-such-suite-"]);
  });

  it("flags a constant spelled nowhere in the tree", () => {
    expect(unspelled(GOOD.replace("UPDATE_BLOG_EXAMPLES", "UPDATE_NO_SUCH_THING"))).toEqual(["UPDATE_NO_SUCH_THING"]);
  });
});
