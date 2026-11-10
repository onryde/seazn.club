// scripts/ci-docs-only.sh decides whether a pull request may skip ci.yml's heavy
// jobs. A wrong "code" costs one CI run; a wrong "docs-only" merges a red that
// the NEXT pull request inherits. So the cases that matter most here are the
// pairs that differ in one fact: the same docs path answered `false` when no
// code names it and `true` when one does.
//
// Every fixture name carries a `zq` prefix: tracked code in the REAL repo is the
// search space when this runs in CI, so a realistic doc name in this file would
// turn that doc's real pull requests into "code".
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SCRIPT = join(import.meta.dirname, "..", "ci-docs-only.sh");

let repo = "";
const write = (rel: string, text: string) => {
  mkdirSync(dirname(join(repo, rel)), { recursive: true });
  writeFileSync(join(repo, rel), text);
};
const git = (...args: string[]) => {
  const r = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
};

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "ci-docs-only-"));
  git("init", "-q");
  // Code that reads one doc by file name and one by folder name — the two
  // shapes the repo's own tests use (contrast.test.ts, the lichess fixtures).
  write(
    "apps/web/src/__tests__/reader.test.ts",
    [
      `readFileSync(join(ROOT, "docs/specs/zq-read-by-name.md"));`,
      `const EVIDENCE = join(ROOT, "docs", "zq-evidence-folder");`,
      `// mentions the structural folders, which must not count: docs superpowers specs plans mockups .claude agents`,
    ].join("\n"),
  );
  // Prose that names a doc does not read it.
  write("docs/index.md", "See zq-prose-only.md and zq-new-plan.md.\n");
  write("apps/web/README.md", "readme\n");
  write("docs/specs/zq-read-by-name.md", "spec\n");
  git("add", "-A");
});
afterAll(() => {
  if (repo) rmSync(repo, { recursive: true, force: true });
});

const classify = (event: string, filesJson: string) => {
  const out = join(repo, "..", `${repo.split("/").pop()}-output`);
  writeFileSync(out, "");
  const r = spawnSync("bash", [SCRIPT], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, EVENT_NAME: event, CHANGED_FILES_JSON: filesJson, GITHUB_OUTPUT: out },
  });
  const lines = readFileSync(out, "utf8").split("\n").filter(Boolean);
  rmSync(out, { force: true });
  return { status: r.status, lines, stdout: r.stdout + r.stderr };
};
const answer = (event: string, files: unknown) => {
  const r = classify(event, typeof files === "string" ? files : JSON.stringify(files));
  // Exactly one answer, and exit 0: the answer drives CI, never the exit code.
  expect(r.status, r.stdout).toBe(0);
  expect(r.lines, r.stdout).toHaveLength(1);
  expect(r.lines[0], r.stdout).toMatch(/^code=(true|false)$/);
  return r.lines[0];
};

describe("ci-docs-only.sh", () => {
  it("answers docs-only for new docs, mockups, agent files and root notes that no code names", () => {
    expect(
      answer("pull_request", [
        "docs/superpowers/plans/zq-new-plan.md",
        "mockups/zq-mock/zq.html",
        ".claude/agents/zq-agent.md",
        "ZQNOTES.md",
        "zq-scratch.txt",
      ]),
    ).toBe("code=false");
    // A doc only PROSE names (docs/index.md) is still docs-only.
    expect(answer("pull_request", ["docs/superpowers/specs/zq-prose-only.md"])).toBe("code=false");
  });

  it("answers code for a doc that tracked code reads, by file name or by folder name", () => {
    // Same shape as the docs-only case above; the one difference is the reader.
    expect(answer("pull_request", ["docs/specs/zq-read-by-name.md"])).toBe("code=true");
    expect(answer("pull_request", ["docs/zq-evidence-folder/deep/zq-new.json"])).toBe("code=true");
    // A rename arrives as both names (dorny splits it); the OLD one is still read.
    expect(answer("pull_request", ["docs/specs/zq-renamed.md", "docs/specs/zq-read-by-name.md"])).toBe("code=true");
  });

  it("answers code for any path outside the docs set, an .md inside a code tree included", () => {
    expect(answer("pull_request", ["apps/web/src/zq.ts"])).toBe("code=true");
    expect(answer("pull_request", ["apps/web/README.md"])).toBe("code=true");
    expect(answer("pull_request", ["docs/superpowers/plans/zq-new-plan.md", "package.json"])).toBe("code=true");
  });

  it("answers code whenever nothing proves docs-only: another event, an empty, unparsable or capped list", () => {
    expect(answer("push", ["docs/superpowers/plans/zq-new-plan.md"])).toBe("code=true");
    expect(answer("workflow_dispatch", ["docs/superpowers/plans/zq-new-plan.md"])).toBe("code=true");
    expect(answer("pull_request", [])).toBe("code=true");
    expect(answer("pull_request", "")).toBe("code=true");
    expect(answer("pull_request", "not json")).toBe("code=true");
    expect(answer("pull_request", { files: ["docs/a.md"] })).toBe("code=true");
    expect(answer("pull_request", [1, 2])).toBe("code=true");
    const capped = Array.from({ length: 3000 }, (_, i) => `docs/superpowers/plans/zq-${i}.md`);
    expect(answer("pull_request", capped)).toBe("code=true");
  });
});
