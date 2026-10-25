// Every CI / e2e / bench server runs instrumentation.ts's register(), as production does.
//
// The standalone tree (`.next/standalone/apps/web`) has NO compiled `.next/server/instrumentation.js`: Turbopack's file
// tracing drops it, and Next silently skips register() when the compiled file is missing. Production puts it back — the
// Dockerfile overlays the whole compiled `.next/server` over the standalone tree — but a CI step that only stages
// `.next/static` and `public/` (which every one of them did) boots a server on which register() NEVER ran: no Sentry init,
// no relayDriverMode() boot refusal, no outbox readiness report, and no installPublicErrorNoStore (so a CI public 404 went
// out with the ISR page's `s-maxage=30`, where production sends `private, no-cache, no-store`). CI was proving a server
// production does not run.
//
// Swept by BEHAVIOUR, not by file or step name (AGENTS.md class 16): EVERY workflow is read, every job that starts the
// standalone server (`node …/standalone/apps/web/server.js`) is found, and the overlay — `cp -R apps/web/.next/server/.
// apps/web/.next/standalone/apps/web/.next/server/`, the merge form of the Dockerfile's COPY — must come on an EARLIER line
// of the SAME job. Per job, not per step: one overlay covers every server a job starts from the same tree (ci.yml's smoke
// job starts two). Neither a comment nor a later line nor another job's overlay counts.
//
// Enabling register() makes a Sentry DSN consequential — `sentry.server.config.ts` is `enabled` the moment one is set — so
// the same workflows are also swept for a DSN: CI must never send an event to the real project.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../../../../..");
const WORKFLOWS = resolve(ROOT, ".github/workflows");

/** Workflows that start the standalone server but are not covered, each with its reason. The exemption is itself
 *  checked (it must still start one), so it cannot outlive its boot. */
const EXEMPT: Readonly<Record<string, string>> = {
  "matrix-truth.yml":
    "its server starts in a different job from the one that packs the build (web.tgz carries only `standalone/`), so the overlay would have to ride in the artifact; not wired yet",
};

/** A line that starts the standalone server: `node …standalone/apps/web/server.js` (matrix-truth's tarball form included). */
const START = /\bnode\b[^\n]*\bstandalone\/apps\/web\/server\.js\b/;
/** The overlay, in the merge form: `/.` on the source, so an existing destination is merged INTO rather than nested under
 *  (`cp -R a/server b/server` with `b/server` present makes `b/server/server`). */
const OVERLAY =
  /^\s*cp\s+-[A-Za-z]*[Rr][A-Za-z]*\s+(?:\S*\/)?apps\/web\/\.next\/server\/\.\s+(?:\S*\/)?apps\/web\/\.next\/standalone\/apps\/web\/\.next\/server\/?\s*$/;
const isComment = (l: string): boolean => /^\s*#/.test(l);
const indentOf = (l: string): number => l.length - l.trimStart().length;

type Job = { id: string; lines: string[]; firstLine: number };

/** The jobs of a workflow: each 2-column key under the top-level `jobs:`, with its lines and its 1-based first line. */
function jobsOf(text: string): Job[] {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  if (at < 0) return [];
  const jobs: Job[] = [];
  for (let i = at + 1; i < lines.length; i++) {
    const l = lines[i]!;
    if (l.trim() !== "" && !isComment(l) && indentOf(l) === 0) break; // the jobs block ended
    const m = /^ {2}([A-Za-z0-9_-]+):\s*(?:#.*)?$/.exec(l);
    if (m) jobs.push({ id: m[1]!, lines: [], firstLine: i + 1 });
    jobs.at(-1)?.lines.push(l);
  }
  return jobs;
}

type Verdict = { job: string; starts: number; missing: number[] };

/** For each job that starts the standalone server: how many starts, and the 1-based job-relative lines of those with no
 *  overlay on an earlier non-comment line of the same job. */
function overlayVerdicts(text: string): Verdict[] {
  return jobsOf(text).flatMap((job) => {
    const startAt = job.lines.flatMap((l, i) => (!isComment(l) && START.test(l) ? [i] : []));
    if (startAt.length === 0) return [];
    const overlayAt = job.lines.flatMap((l, i) => (!isComment(l) && OVERLAY.test(l) ? [i] : []));
    const missing = startAt.filter((s) => !overlayAt.some((o) => o < s)).map((s) => s + 1);
    return [{ job: job.id, starts: startAt.length, missing }];
  });
}

/** Every start line in a workflow, found without the job parser (the independent count the parser is held to). */
const startLines = (text: string): number => text.split("\n").filter((l) => !isComment(l) && START.test(l)).length;

/** A non-comment `SENTRY_DSN` / `NEXT_PUBLIC_SENTRY_DSN` assignment that sets a real value (an empty string is the
 *  documented way to hold the variable blank). */
function dsnAssignments(text: string): string[] {
  return text.split("\n").filter((l) => {
    if (isComment(l)) return false;
    const m = /\b(?:NEXT_PUBLIC_)?SENTRY_DSN\b\s*[:=]\s*(.*?)\s*$/.exec(l);
    return m !== null && !/^(?:""|''|)$/.test(m[1]!.replace(/\s+#.*$/, "").trim());
  });
}

const workflowFiles = (): string[] => readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f)).sort();

describe("every job that starts the standalone Next server overlays the compiled .next/server first", () => {
  it("EVERY workflow: each job's server start has the overlay on an earlier line of the same job (matrix-truth.yml exempt by name)", () => {
    const files = workflowFiles();
    let jobsChecked = 0;
    let startsChecked = 0;
    let startsSeen = 0;
    let startsAttributed = 0;
    let exempted = 0;
    const checkedBy: Record<string, number> = {};
    for (const wf of files) {
      const text = readFileSync(resolve(WORKFLOWS, wf), "utf8");
      const seen = startLines(text);
      startsSeen += seen;
      const verdicts = overlayVerdicts(text);
      startsAttributed += verdicts.reduce((n, v) => n + v.starts, 0);
      if (wf in EXEMPT) {
        expect(seen, `${wf} is exempt (${EXEMPT[wf]}) but starts no standalone server — drop the exemption`).toBeGreaterThan(0);
        exempted += seen;
        continue;
      }
      for (const v of verdicts) {
        expect(v.missing, `${wf} job "${v.job}": server start(s) at job line(s) ${v.missing.join(", ")} have no \`cp -R apps/web/.next/server/. apps/web/.next/standalone/apps/web/.next/server/\` before them — register() would never run`).toEqual([]);
        jobsChecked++;
        startsChecked += v.starts;
        checkedBy[wf] = (checkedBy[wf] ?? 0) + 1;
      }
    }
    expect(files.length, "no workflow was read").toBeGreaterThan(0);
    // The job parser lost nothing: every start line found by a plain scan lies inside a job it judged.
    expect(startsAttributed, "a server start lies outside every job the parser found").toBe(startsSeen);
    expect(Object.keys(EXEMPT).every((f) => files.includes(f)), "an exemption names a workflow that no longer exists").toBe(true);
    expect(exempted, "the exempt workflow's start was seen and excused").toBeGreaterThan(0);
    // Anti-vacuity: zero jobs checked is a FAILURE. The brief's three workflows each contributed at least one.
    expect(jobsChecked, "no job that starts the standalone server was checked").toBeGreaterThan(0);
    expect(startsChecked).toBeGreaterThanOrEqual(jobsChecked);
    expect(startsChecked + exempted).toBe(startsSeen);
    for (const wf of ["ci.yml", "e2e.yml", "bench.yml"]) {
      expect(checkedBy[wf], `${wf} contributed no checked job — its start moved, or the detector lost it`).toBeGreaterThan(0);
    }
  });

  it("the detector is live: a missing, later, commented, wrong-form or other-job overlay is caught; an earlier one (same step or earlier step) is not", () => {
    const head = "name: x\njobs:\n  a:\n    steps:\n";
    const start = "          node apps/web/.next/standalone/apps/web/server.js > s.log 2>&1 &\n";
    const overlay = "          cp -R apps/web/.next/server/. apps/web/.next/standalone/apps/web/.next/server/\n";
    const caught: [string, string][] = [
      ["no overlay at all", `${head}      - name: Start\n        run: |\n${start}`],
      ["the overlay comes AFTER the start", `${head}      - name: Start\n        run: |\n${start}${overlay}`],
      ["the overlay is only a comment", `${head}      - name: Start\n        run: |\n          # cp -R apps/web/.next/server/. apps/web/.next/standalone/apps/web/.next/server/\n${start}`],
      ["the overlay lacks the merge form (/. on the source nests under an existing destination)", `${head}      - name: Start\n        run: |\n          cp -R apps/web/.next/server apps/web/.next/standalone/apps/web/.next/server\n${start}`],
      ["the overlay copies the wrong tree (static, not server)", `${head}      - name: Start\n        run: |\n          cp -R apps/web/.next/static/. apps/web/.next/standalone/apps/web/.next/server/\n${start}`],
      ["the overlay lands somewhere else", `${head}      - name: Start\n        run: |\n          cp -R apps/web/.next/server/. /tmp/elsewhere/\n${start}`],
      ["the overlay is in ANOTHER job", `${head}      - name: Prep\n        run: |\n${overlay}  b:\n    steps:\n      - name: Start\n        run: |\n${start}`],
      ["the second start has nothing before it (the first job had an overlay, this one does not)", `${head}      - name: Start\n        run: |\n${overlay}${start}  b:\n    steps:\n      - name: Start\n        run: |\n${start}`],
    ];
    let judged = 0;
    for (const [what, text] of caught) {
      const verdicts = overlayVerdicts(text);
      const missing = verdicts.flatMap((v) => v.missing);
      expect(missing.length, what).toBeGreaterThan(0);
      judged++;
    }
    expect(judged).toBe(caught.length);
    // The positive pair: the overlay in the start's own step before it, in an earlier step, and one covering two starts.
    const passes: [string, string, number][] = [
      ["overlay then start in one step", `${head}      - name: Start\n        run: |\n${overlay}${start}`, 1],
      ["overlay in an earlier step", `${head}      - name: Overlay\n        run: |\n${overlay}      - name: Start\n        run: |\n${start}`, 1],
      ["one overlay covers two starts of the same job", `${head}      - name: Start\n        run: |\n${overlay}${start}      - name: Second\n        run: |\n${start}`, 2],
      ["flag variant: -Rp, destination without a trailing slash", `${head}      - name: Start\n        run: |\n          cp -Rp apps/web/.next/server/. apps/web/.next/standalone/apps/web/.next/server\n${start}`, 1],
    ];
    let held = 0;
    for (const [what, text, starts] of passes) {
      const verdicts = overlayVerdicts(text);
      expect(verdicts, what).toHaveLength(1);
      expect(verdicts[0]!.starts, what).toBe(starts);
      expect(verdicts[0]!.missing, what).toEqual([]);
      held++;
    }
    expect(held).toBe(passes.length);
    // A comment that names the start, a job with no start, and a start in a comment are not starts.
    expect(overlayVerdicts(`${head}      - name: x\n        # node apps/web/.next/standalone/apps/web/server.js\n        run: true\n`)).toEqual([]);
    expect(startLines("      # node apps/web/.next/standalone/apps/web/server.js &\n")).toBe(0);
    // The tarball form matrix-truth uses is a start too (that is why it needs its exemption).
    expect(startLines("          node standalone/apps/web/server.js > \"$RUNNER_TEMP/server.log\" 2>&1 &\n")).toBe(1);
  });
});

/** What is wrong with the behavioural proof of register() in a workflow's first server-starting job: a step AFTER the one
 *  that starts the server and BEFORE the first smoke run, that requests a /shared URL, requires a 404 and `no-store`, and
 *  fails the job otherwise. Empty means sound. */
function proofProblems(text: string): string[] {
  const job = jobsOf(text).find((j) => j.lines.some((l) => !isComment(l) && START.test(l)));
  if (!job) return ["no job starts the standalone server"];
  // Steps are the 6-column `- ` items; comment lines never count toward what a step does.
  const steps: string[][] = [];
  for (const l of job.lines) {
    if (/^ {6}- /.test(l)) steps.push([]);
    if (!isComment(l)) steps.at(-1)?.push(l);
  }
  const text_ = steps.map((s) => s.join("\n"));
  const startAt = text_.findIndex((s) => s.split("\n").some((l) => START.test(l)));
  const smokeAt = text_.findIndex((s) => /\bnpm run test:smoke\s*$/m.test(s));
  const proofAt = text_.findIndex((s) => /\/shared\//.test(s) && /no-store/i.test(s));
  const problems: string[] = [];
  if (proofAt < 0) return ["no step requests a /shared URL and requires no-store"];
  const proof = text_[proofAt]!;
  if (proofAt <= startAt) problems.push("the proof does not come after the step that starts the server");
  if (smokeAt < 0) problems.push("the first smoke run was not found, so the proof cannot be ordered before it");
  else if (proofAt >= smokeAt) problems.push("the proof does not come before the first smoke run");
  if (!/\b404\b/.test(proof)) problems.push("the proof does not require the 404 status");
  if (!/\bexit 1\b/.test(proof)) problems.push("the proof does not fail the job");
  if (!/grep\s+-\w+\s+'no-store'/.test(proof)) problems.push("the proof does not test the header for no-store");
  return problems;
}

describe("the behavioural proof that register() ran", () => {
  it("ci.yml: a step between the server start and the first smoke run requests a public /shared 404 and fails the job unless it is no-store", () => {
    const text = readFileSync(resolve(WORKFLOWS, "ci.yml"), "utf8");
    expect(proofProblems(text)).toEqual([]);
  });

  it("the detector is live: each part of the proof, removed or misplaced, is caught", () => {
    const proofStep = [
      "      - name: Prove",
      "        run: |",
      "          code=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:3000/shared/x)",
      '          if [ "$code" = "404" ] && grep -qi \'no-store\' <<< "$cc"; then ok=1; fi',
      "          if [ -z \"$ok\" ]; then exit 1; fi",
    ];
    const start = ["      - name: Start", "        run: |", "          node apps/web/.next/standalone/apps/web/server.js &"];
    const smoke = ["      - name: Smoke", "        run: npm run test:smoke"];
    const job = (...steps: string[][]): string => `jobs:\n  smoke:\n    steps:\n${steps.flat().join("\n")}\n`;
    expect(proofProblems(job(start, proofStep, smoke)), "the sound shape").toEqual([]);
    const mutants: [string, string, RegExp][] = [
      ["no proof step", job(start, smoke), /no step requests/],
      ["the proof runs before the server starts", job(proofStep, start, smoke), /after the step that starts/],
      ["the proof runs after the smoke run", job(start, smoke, proofStep), /before the first smoke run/],
      ["the 404 requirement dropped", job(start, proofStep.map((l) => l.replace('"$code" = "404"', '"$code" = "200"')), smoke), /404 status/],
      ["the job is not failed", job(start, proofStep.map((l) => l.replace("exit 1", "true")), smoke), /fail the job/],
      ["the no-store test swapped for another header test (the word survives in a message)", job(start, [...proofStep.map((l) => l.replace("grep -qi 'no-store'", "grep -qi 'cache'")), '          echo "want no-store"'], smoke), /test the header for no-store/],
      ["the proof is only a comment", job(start, proofStep.map((l, i) => (i >= 2 ? `          # ${l.trim()}` : l)), smoke), /no step requests|404 status|fail the job/],
    ];
    let caught = 0;
    for (const [what, text, why] of mutants) {
      const found = proofProblems(text);
      expect(found.length, what).toBeGreaterThan(0);
      expect(found.join(" | "), what).toMatch(why);
      caught++;
    }
    expect(caught).toBe(mutants.length);
  });
});

describe("the servers' register() is not pointed at the real Sentry project", () => {
  it("no workflow that starts the standalone server sets a SENTRY_DSN / NEXT_PUBLIC_SENTRY_DSN value", () => {
    let scanned = 0;
    for (const wf of workflowFiles()) {
      const text = readFileSync(resolve(WORKFLOWS, wf), "utf8");
      if (startLines(text) === 0) continue;
      scanned++;
      expect(dsnAssignments(text), `${wf} carries a Sentry DSN — the booted server's register() would send CI events to the real project`).toEqual([]);
    }
    expect(scanned, "no server-starting workflow was scanned").toBeGreaterThan(0);
  });

  it("the detector is live: a value is caught, a blank, a comment and a look-alike are not", () => {
    let caught = 0;
    for (const l of ['          SENTRY_DSN: https://abc@o1.ingest.sentry.io/1', '          NEXT_PUBLIC_SENTRY_DSN: "https://abc@o1.ingest.sentry.io/1"', "          export SENTRY_DSN=https://abc@o1.ingest.sentry.io/1", "          SENTRY_DSN: ${{ secrets.SENTRY_DSN }}"]) {
      expect(dsnAssignments(`${l}\n`), l).toHaveLength(1);
      caught++;
    }
    expect(caught).toBe(4);
    expect(dsnAssignments('          SENTRY_DSN: ""\n          NEXT_PUBLIC_SENTRY_DSN: ""\n          SENTRY_DSN=\n'), "blank is the safe spelling").toEqual([]);
    expect(dsnAssignments("          # SENTRY_DSN: https://abc@o1.ingest.sentry.io/1\n"), "a comment").toEqual([]);
    expect(dsnAssignments("          SENTRY_AUTH_TOKEN: ${{ secrets.SENTRY_AUTH_TOKEN }}\n"), "a look-alike name").toEqual([]);
  });
});
