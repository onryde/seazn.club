// Which workflow jobs check out the FULL history, and why each must.
//
// A shallow checkout (the default, depth 1) is the cheaper one, and every job that does not need
// history should take it. Three jobs in ci.yml set `fetch-depth: 0`, and each was weighed against
// a shallower fetch when this was written (owner approval 2026-11-23/24). None can go shallower
// without changing what it proves, so each is pinned here WITH its reason and the evidence for it:
//
//   gates        `HEAD^1` is the base tip the single-sport ratchet and the plan lock are checked
//                against, and tools/matrix/__tests__/rebase-map.test.ts proves every SHA in the
//                W1 rebase map is an ancestor of HEAD and refuses a shallow clone by name.
//   security     gitleaks-action scans `<first PR commit>^..<last PR commit>` (its own
//                `--log-opts`, built from the PR commits API). A depth-1 checkout of the merge
//                commit holds none of those commits, and the step is `continue-on-error`, so a
//                too-shallow clone would degrade the scan SILENTLY rather than fail it.
//   matrix-rows  `git diff --name-only --no-renames BASE...HEAD` (three dots) is the diff from
//                the MERGE BASE, which sits wherever the branch forked: no fixed depth reaches
//                it, and a two-dot diff would list main's own commits as the PR's.
//
// So this file is the inventory: a fourth `fetch-depth: 0` has to arrive with its reason, and a
// site that stops needing it (or whose evidence is gone) fails here instead of staying full-depth
// by habit. A guard that scans and finds nothing proves nothing, so the count is asserted.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REPO = join(import.meta.dirname, "../..");
const WORKFLOWS = join(REPO, ".github/workflows");

interface Site {
  file: string;
  job: string;
  depth: number;
  /** The job's own lines, comments dropped. */
  jobText: string;
}
const sites = (): Site[] => {
  const out: Site[] = [];
  for (const file of readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f)).sort()) {
    const text = readFileSync(join(WORKFLOWS, file), "utf8");
    const body = text.includes("\njobs:") ? text.slice(text.indexOf("\njobs:")) : "";
    for (const block of body.split(/\n(?= {2}[A-Za-z][\w-]*:\s*\n)/).slice(1)) {
      const live = block.split("\n").filter((l) => !/^\s*#/.test(l));
      const job = /^ {2}([A-Za-z][\w-]*):/.exec(live[0]!)![1]!;
      for (const m of live.join("\n").matchAll(/^\s*fetch-depth:\s*(\d+)\s*$/gm)) {
        out.push({ file, job, depth: Number(m[1]), jobText: live.join("\n") });
      }
    }
  }
  return out;
};

/** The text of the one step that uses gitleaks-action, up to the next step. */
const gitleaksStep = (s: Site): string => {
  const at = s.jobText.indexOf("gitleaks/gitleaks-action");
  if (at < 0) return "";
  const rest = s.jobText.slice(at);
  const next = rest.indexOf("\n      - ");
  return next < 0 ? rest : rest.slice(0, next);
};

/** The three full-history sites and the evidence each one needs history, stated here and checked below. */
const FULL_HISTORY: Record<string, { evidence: (s: Site) => string[] }> = {
  "ci.yml gates": {
    evidence: (s) => [
      s.jobText.includes("--against HEAD^1") ? "" : "gates no longer reads HEAD^1",
      readFileSync(join(REPO, "tools/matrix/__tests__/rebase-map.test.ts"), "utf8").includes("this clone is shallow") ? "" : "rebase-map.test.ts no longer refuses a shallow clone",
      s.jobText.includes("matrix:single-sport") ? "" : "gates no longer runs the single-sport ratchet",
    ],
  },
  "ci.yml security": {
    evidence: (s) => [
      s.jobText.includes("gitleaks/gitleaks-action") ? "" : "security no longer runs gitleaks-action",
      // THE gitleaks step's own block (the job's dependency audit also says continue-on-error).
      gitleaksStep(s).includes("continue-on-error: true") ? "" : "the gitleaks step is no longer advisory, so a shallow clone would fail loudly: re-weigh the depth",
    ],
  },
  "ci.yml matrix-rows": {
    evidence: (s) => [
      /git diff --name-only --no-renames "\$BASE_SHA\.\.\.\$HEAD_SHA"/.test(s.jobText) ? "" : "matrix-rows no longer takes the three-dot diff from the merge base",
    ],
  },
};

describe("fetch-depth: 0 in .github/workflows", () => {
  it("is set by exactly the three jobs that need the whole history, and by no other job", () => {
    const all = sites();
    // Anti-vacuity: the scan reached the workflows' checkout steps.
    expect(all.length, "fetch-depth settings found in .github/workflows").toBeGreaterThan(0);
    const full = all.filter((s) => s.depth === 0).map((s) => `${s.file} ${s.job}`).sort();
    expect(full).toEqual(Object.keys(FULL_HISTORY).sort());
    // Everything else that sets a depth sets a shallow one.
    expect(all.filter((s) => s.depth !== 0 && s.depth !== 1).map((s) => `${s.file} ${s.job}: ${s.depth}`)).toEqual([]);
  });

  it("each full-history job still carries the thing that needs the history", () => {
    const full = sites().filter((s) => s.depth === 0);
    expect(full.length, "full-history sites judged").toBe(Object.keys(FULL_HISTORY).length);
    for (const s of full) {
      const key = `${s.file} ${s.job}`;
      expect(FULL_HISTORY[key], `${key} has a recorded reason`).toBeDefined();
      expect(FULL_HISTORY[key]!.evidence(s).filter((e) => e !== ""), key).toEqual([]);
    }
  });

  it("a one-line reason sits beside every full-history checkout", () => {
    // A bare `fetch-depth: 0` is how a full clone outlives its need. The comment names the reader of the history.
    let judged = 0;
    for (const file of readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f))) {
      const lines = readFileSync(join(WORKFLOWS, file), "utf8").split("\n");
      lines.forEach((line, i) => {
        if (!/^\s*fetch-depth:\s*0\s*$/.test(line)) return;
        judged++;
        // The comment sits within the five lines above the setting, or on the line itself.
        const near = lines.slice(Math.max(0, i - 6), i + 1).filter((l) => /^\s*#/.test(l) || /#/.test(l.split("fetch-depth")[0] ?? ""));
        expect(near.length, `${file}:${i + 1}: a comment naming why the checkout is full-depth`).toBeGreaterThan(0);
        expect(near.join(" "), `${file}:${i + 1}`).toMatch(/history|ancestor|merge.?base|HEAD\^1|commit range|three.dot|rebase/i);
      });
    }
    expect(judged, "fetch-depth: 0 lines judged").toBeGreaterThan(0);
  });
});
