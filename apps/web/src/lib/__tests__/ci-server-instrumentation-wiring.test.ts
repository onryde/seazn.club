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
// Swept by BEHAVIOUR, not by file or step name (AGENTS.md class 16): EVERY workflow is read, and
//   * every job that starts the standalone server (`node …/standalone/apps/web/server.js`) must have the overlay —
//     `cp -R apps/web/.next/server/. apps/web/.next/standalone/apps/web/.next/server/`, the merge form of the
//     Dockerfile's COPY — on an EARLIER line of the SAME job (one overlay covers every server a job starts from the same
//     tree: ci.yml's smoke job starts two); or, when the job EXTRACTS the tree from a tarball (matrix-truth's shards),
//     every job that PACKS one (`tar … standalone`) must have the overlay before the tar, because the overlay has to ride
//     in the artifact;
//   * every `node … server.js` line, and every `node …` line that backgrounds a process (`… &`, however its script is
//     spelled: `node "${srv}.js" &`), is counted apart from the standalone-path form, and the two counts must agree, so a
//     start spelled another way (`cd … && node server.js`) cannot slip past the detector unseen. What still slips, because
//     a text sweep cannot see it: a backgrounded wrapper (`bash start.sh &`, `npm run … &`), and a `node \` line
//     continuation whose script sits on the next line.
// Neither a comment nor a later line nor another job's overlay counts, nor one in a step that has an `if:` (it may not
// run), unless it is the start's own step.
// A tarball's pack must also strip the source maps (`find … -name '*.map' -delete`) between the last overlay before the
// tar and the tar itself (the overlay is what brings the maps in): ~220 MB nothing in a shard reads, in an artifact every
// shard downloads.
//
// Enabling register() makes a Sentry DSN consequential — `sentry.server.config.ts` is `enabled` the moment one is set — so
// every server-start step also holds both DSN variables blank in its own env (the empty string wins the `??`), and no
// such workflow assigns a real one.
//
// And the behavioural proof in ci.yml (a public 404 must go out no-store, from an ISR render) is not trusted by its text:
// its extracted body is EXECUTED against a stub `curl`, over a table of what curl could answer, and the step may not carry
// an `if:` or `continue-on-error:` (either would let it pass without ever running).
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../../../../..");
const WORKFLOWS = resolve(ROOT, ".github/workflows");

/** A line that starts the standalone server: `node …standalone/apps/web/server.js` (the tarball form `node
 *  standalone/apps/web/server.js` included). */
const START = /\bnode\b[^\n]*\bstandalone\/apps\/web\/server\.js\b/;
/** ANY `node … server.js` line, whatever path it takes, and ANY `node …` line that backgrounds its process (a trailing `&`,
 *  bare or inside a subshell), however the script is named: the independent count START is held to. Every backgrounded
 *  `node` in the workflows today is one of the standalone starts, so a new one that is not makes the counts disagree and
 *  goes red here, until START learns its shape. A trailing `&&` is a continuation, not a backgrounding. */
const BOOT = /\bnode\b[^\n]*\bserver\.js\b|\bnode\b[^\n]*(?<!&)&\s*\)?\s*$/;
/** A line that packs the standalone tree into a tarball. */
const PACK = /\btar\b[^\n]*\bstandalone\b/;
/** The source-map strip a pack owes before its tar. */
const STRIP = /^\s*find\s+(?:\S*\/)?apps\/web\/\.next\/standalone\s+-name\s+'\*\.map'\s+-delete\s*$/;
/** A line that extracts a tarball. */
const EXTRACT = /\btar\s+-\w*x\w*\s/;
/** The overlay, in the merge form: `/.` on the source, so an existing destination is merged INTO rather than nested under
 *  (`cp -R a/server b/server` with `b/server` present makes `b/server/server`). */
const OVERLAY =
  /^\s*cp\s+-[A-Za-z]*[Rr][A-Za-z]*\s+(?:\S*\/)?apps\/web\/\.next\/server\/\.\s+(?:\S*\/)?apps\/web\/\.next\/standalone\/apps\/web\/\.next\/server\/?\s*$/;
const isComment = (l: string): boolean => /^\s*#/.test(l);
const indentOf = (l: string): number => l.length - l.trimStart().length;
const skippable = (l: string): boolean => l.trim() === "" || isComment(l);
const live = (lines: string[], re: RegExp): number[] => lines.flatMap((l, i) => (!isComment(l) && re.test(l) ? [i] : []));

type Job = { id: string; lines: string[] };

/** The jobs of a workflow: each 2-column key under the top-level `jobs:`, with its lines. */
function jobsOf(text: string): Job[] {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  if (at < 0) return [];
  const jobs: Job[] = [];
  for (let i = at + 1; i < lines.length; i++) {
    const l = lines[i]!;
    if (!skippable(l) && indentOf(l) === 0) break; // the jobs block ended
    const m = /^ {2}([A-Za-z0-9_-]+):\s*(?:#.*)?$/.exec(l);
    if (m) jobs.push({ id: m[1]!, lines: [] });
    jobs.at(-1)?.lines.push(l);
  }
  return jobs;
}

type Verdict = { job: string; starts: number; missing: number[]; packs: number; packMissing: number[]; packUnstripped: number[] };

/** Whether a step carries its own `if:`, or `continue-on-error:`: at the step's key column, or on the `- ` header line. */
const STEP_IF = /^ {6}- if:|^ {8}if:/;
const STEP_SILENCE = /^ {6}- (?:if|continue-on-error):|^ {8}(?:if|continue-on-error):/;

/** For each job that starts the standalone server or packs it: how many of each, and the 1-based job-relative lines of
 *  those with no overlay in front of them. An overlay counts only from a step with no `if:` of its own, or from the
 *  start's own step; a start is also covered when its job extracts a tarball and EVERY pack in the workflow overlays first
 *  (and there is at least one). A pack must also strip the source maps first. */
function overlayVerdicts(text: string): Verdict[] {
  const per = jobsOf(text).map((job) => {
    const startAt = live(job.lines, START);
    const packAt = live(job.lines, PACK).filter((i) => !EXTRACT.test(job.lines[i]!));
    const overlayAt = live(job.lines, OVERLAY);
    const extractAt = live(job.lines, EXTRACT);
    const stripAt = live(job.lines, STRIP);
    const lastOverlayBefore = (i: number): number => Math.max(-1, ...overlayAt.filter((o) => o < i));
    // Which step each line belongs to, and which steps are conditional.
    const stepOf: number[] = [];
    let step = -1;
    for (const l of job.lines) {
      if (/^ {6}- /.test(l)) step++;
      stepOf.push(step);
    }
    const conditional = new Set(live(job.lines, STEP_IF).map((i) => stepOf[i]!));
    const covers = (i: number): boolean => overlayAt.some((o) => o < i && (stepOf[o] === stepOf[i] || !conditional.has(stepOf[o]!)));
    return { job, startAt, packAt, extractAt, covers, packMissing: packAt.filter((p) => !covers(p)), packUnstripped: packAt.filter((p) => !stripAt.some((o) => o < p && o > lastOverlayBefore(p))) };
  });
  const packsSound = per.some((p) => p.packAt.length > 0) && per.every((p) => p.packMissing.length === 0);
  return per
    .filter((p) => p.startAt.length > 0 || p.packAt.length > 0)
    .map((p) => ({
      job: p.job.id,
      starts: p.startAt.length,
      missing: p.startAt.filter((s) => !p.covers(s) && !(packsSound && p.extractAt.some((x) => x < s))).map((s) => s + 1),
      packs: p.packAt.length,
      packMissing: p.packMissing.map((i) => i + 1),
      packUnstripped: p.packUnstripped.map((i) => i + 1),
    }));
}

/** Plain-scan counts over the whole text (no job parser): what the parser is held to. */
const countLines = (text: string, re: RegExp): number => text.split("\n").filter((l) => !isComment(l) && re.test(l)).length;
const startLines = (text: string): number => countLines(text, START);
const bootLines = (text: string): number => countLines(text, BOOT);
const packLines = (text: string): number => text.split("\n").filter((l) => !isComment(l) && PACK.test(l) && !EXTRACT.test(l)).length;

/** The `env:` map of the step that owns line `i` — read from THAT step's own `env:` key (a neighbouring step's, or another
 *  key's children, never count). */
function stepEnvAt(lines: string[], i: number): Record<string, string> {
  let start = i;
  while (start >= 0 && !/^ {6}- /.test(lines[start]!)) start--;
  if (start < 0) return {};
  const body = [lines[start]!.replace(/^( {6})- /, "$1  ")];
  for (let j = start + 1; j < lines.length && (skippable(lines[j]!) || indentOf(lines[j]!) >= 8); j++) body.push(lines[j]!);
  const at = body.findIndex((b) => indentOf(b) === 8 && /^\s*env:\s*$/.test(b));
  const env: Record<string, string> = {};
  if (at < 0) return env;
  let childIndent: number | null = null;
  for (const b of body.slice(at + 1)) {
    if (skippable(b)) continue;
    if (indentOf(b) <= 8) break;
    childIndent ??= indentOf(b);
    const m = indentOf(b) === childIndent ? /^\s*([A-Za-z_][A-Za-z0-9_]*):\s*(.*?)\s*$/.exec(b) : null;
    if (m) env[m[1]!] = m[2]!.replace(/^(["'])(.*)\1$/, "$2");
  }
  return env;
}

/** For each standalone-server start: the line, and its OWN step's env. */
function startEnvs(text: string): { line: number; env: Record<string, string> }[] {
  const lines = text.split("\n");
  return live(lines, START).map((i) => ({ line: i + 1, env: stepEnvAt(lines, i) }));
}

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
  it("EVERY workflow: each server start has the overlay on an earlier line of its job (or rides in the tarball its job extracts), and every pack overlays before the tar", () => {
    const files = workflowFiles();
    let jobsChecked = 0;
    let startsChecked = 0;
    let packsChecked = 0;
    let startsSeen = 0;
    let bootsSeen = 0;
    let packsSeen = 0;
    let startsAttributed = 0;
    let packsAttributed = 0;
    const checkedBy: Record<string, number> = {};
    const packedBy: Record<string, number> = {};
    for (const wf of files) {
      const text = readFileSync(resolve(WORKFLOWS, wf), "utf8");
      startsSeen += startLines(text);
      bootsSeen += bootLines(text);
      packsSeen += packLines(text);
      const verdicts = overlayVerdicts(text);
      startsAttributed += verdicts.reduce((n, v) => n + v.starts, 0);
      packsAttributed += verdicts.reduce((n, v) => n + v.packs, 0);
      for (const v of verdicts) {
        expect(v.missing, `${wf} job "${v.job}": server start(s) at job line(s) ${v.missing.join(", ")} have no \`cp -R apps/web/.next/server/. apps/web/.next/standalone/apps/web/.next/server/\` before them, in a step without an \`if:\` (nor a tarball packed with it) — register() would never run`).toEqual([]);
        expect(v.packMissing, `${wf} job "${v.job}": tar of the standalone tree at job line(s) ${v.packMissing.join(", ")} has no overlay before it (in a step without an \`if:\`) — the servers that extract it would never run register()`).toEqual([]);
        expect(v.packUnstripped, `${wf} job "${v.job}": tar of the standalone tree at job line(s) ${v.packUnstripped.join(", ")} has no \`find apps/web/.next/standalone -name '*.map' -delete\` before it — ~220 MB of source maps in the artifact`).toEqual([]);
        if (v.starts > 0) {
          jobsChecked++;
          startsChecked += v.starts;
          checkedBy[wf] = (checkedBy[wf] ?? 0) + 1;
        }
        if (v.packs > 0) {
          packsChecked += v.packs;
          packedBy[wf] = (packedBy[wf] ?? 0) + v.packs;
        }
      }
    }
    expect(files.length, "no workflow was read").toBeGreaterThan(0);
    // The job parser lost nothing: every start and pack line found by a plain scan lies inside a job it judged.
    expect(startsAttributed, "a server start lies outside every job the parser found").toBe(startsSeen);
    expect(packsAttributed, "a pack line lies outside every job the parser found").toBe(packsSeen);
    // No start is spelled a way the detector cannot see: every `node … server.js` line is a standalone-path start.
    expect(bootsSeen, "a `node … server.js` line is not a recognised standalone start (a cd-form or variable-named start would slip past the overlay check)").toBe(startsSeen);
    // Anti-vacuity: zero jobs checked is a FAILURE. Each workflow that boots a server today contributed at least one.
    expect(jobsChecked, "no job that starts the standalone server was checked").toBeGreaterThan(0);
    expect(startsChecked, "a start was seen but not judged").toBe(startsSeen);
    expect(packsChecked, "no pack of the standalone tree was checked").toBeGreaterThan(0);
    for (const wf of ["ci.yml", "e2e.yml", "bench.yml", "matrix-truth.yml"]) {
      expect(checkedBy[wf], `${wf} contributed no checked job — its start moved, or the detector lost it`).toBeGreaterThan(0);
    }
    expect(packedBy["matrix-truth.yml"], "matrix-truth.yml's pack was not found").toBeGreaterThan(0);
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
      ["the overlay sits in an earlier step that has an `if:` (it may not run)", `${head}      - name: Overlay\n        if: always()\n        run: |\n${overlay}      - name: Start\n        run: |\n${start}`],
      ["the overlay sits in an earlier step whose HEADER line is the `if:`", `${head}      - if: false\n        run: |\n${overlay}      - name: Start\n        run: |\n${start}`],
      ["the second start has nothing before it (the first job had an overlay, this one does not)", `${head}      - name: Start\n        run: |\n${overlay}${start}  b:\n    steps:\n      - name: Start\n        run: |\n${start}`],
    ];
    let judged = 0;
    for (const [what, text] of caught) {
      expect(overlayVerdicts(text).flatMap((v) => v.missing).length, what).toBeGreaterThan(0);
      judged++;
    }
    expect(judged).toBe(caught.length);
    // The positive pair: the overlay in the start's own step before it, in an earlier step, and one covering two starts.
    const passes: [string, string, number][] = [
      ["overlay then start in one step", `${head}      - name: Start\n        run: |\n${overlay}${start}`, 1],
      ["overlay in an earlier step", `${head}      - name: Overlay\n        run: |\n${overlay}      - name: Start\n        run: |\n${start}`, 1],
      ["one overlay covers two starts of the same job", `${head}      - name: Start\n        run: |\n${overlay}${start}      - name: Second\n        run: |\n${start}`, 2],
      ["a conditional overlay in the start's OWN step still counts (both run or neither does)", `${head}      - name: Start\n        if: always()\n        run: |\n${overlay}${start}`, 1],
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
  });

  it("the detector is live for a tarball: a pack without the overlay is caught, a tarball-fed start is only covered by a sound pack, an extract is not a pack", () => {
    const head = "name: x\njobs:\n  build:\n    steps:\n";
    const overlay = "          cp -R apps/web/.next/server/. apps/web/.next/standalone/apps/web/.next/server/\n";
    const pack = "          tar -czf web.tgz -C apps/web/.next standalone\n";
    const shard = "  shard:\n    steps:\n      - name: Start\n        run: |\n          tar -xzf web.tgz\n          node standalone/apps/web/server.js &\n";
    const packStep = (...lines: string[]): string => `      - name: Pack\n        run: |\n${lines.join("")}`;
    const strip = "          find apps/web/.next/standalone -name '*.map' -delete\n";
    const rows: [string, string, { packMissing: number; startMissing: number; unstripped: number }][] = [
      ["a pack with no overlay", `${head}${packStep(strip, pack)}${shard}`, { packMissing: 1, startMissing: 1, unstripped: 0 }],
      ["the overlay comes after the tar", `${head}${packStep(strip, pack, overlay)}${shard}`, { packMissing: 1, startMissing: 1, unstripped: 0 }],
      ["no pack anywhere (an extracted tree nobody overlaid)", `name: x\njobs:\n${shard}`, { packMissing: 0, startMissing: 1, unstripped: 0 }],
      ["a sound pack covers the extracting shard", `${head}${packStep(overlay, strip, pack)}${shard}`, { packMissing: 0, startMissing: 0, unstripped: 0 }],
      ["a pack that overlays but keeps the source maps", `${head}${packStep(overlay, pack)}${shard}`, { packMissing: 0, startMissing: 0, unstripped: 1 }],
      ["the map strip comes BEFORE the overlay (the overlay then brings the maps back)", `${head}${packStep(strip, overlay, pack)}${shard}`, { packMissing: 0, startMissing: 0, unstripped: 1 }],
      ["the map strip comes after the tar", `${head}${packStep(overlay, pack, strip)}${shard}`, { packMissing: 0, startMissing: 0, unstripped: 1 }],
      ["the strip names the wrong pattern", `${head}${packStep(overlay, "          find apps/web/.next/standalone -name '*.js' -delete\n", pack)}${shard}`, { packMissing: 0, startMissing: 0, unstripped: 1 }],
    ];
    let judged = 0;
    for (const [what, text, want] of rows) {
      const verdicts = overlayVerdicts(text);
      expect(verdicts.flatMap((v) => v.packMissing).length, `${what}: packs`).toBe(want.packMissing);
      expect(verdicts.flatMap((v) => v.missing).length, `${what}: starts`).toBe(want.startMissing);
      expect(verdicts.flatMap((v) => v.packUnstripped).length, `${what}: maps`).toBe(want.unstripped);
      judged++;
    }
    expect(judged).toBe(rows.length);
    // `tar -xzf` extracts; it packs nothing. And a job that does NOT extract is not covered by somebody else's pack.
    expect(packLines("          tar -xzf web.tgz\n")).toBe(0);
    expect(packLines(pack)).toBe(1);
    const unrelated = `${head}${packStep(overlay, strip, pack)}  other:\n    steps:\n      - name: Start\n        run: |\n          node standalone/apps/web/server.js &\n`;
    expect(overlayVerdicts(unrelated).flatMap((v) => v.missing).length, "no extract in the job, no overlay: not covered").toBe(1);
  });

  it("the detector is live for the spelling count: a cd-form or variable-named start is a boot the standalone-path scan does not see", () => {
    const cdForm = "          (cd apps/web/.next/standalone/apps/web && node server.js > s.log 2>&1 &)\n";
    expect(bootLines(cdForm)).toBe(1);
    expect(startLines(cdForm), "the cd-form is invisible to START — that is why the counts are compared").toBe(0);
    const standalone = "          node apps/web/.next/standalone/apps/web/server.js > s.log 2>&1 &\n";
    expect(bootLines(standalone)).toBe(startLines(standalone));
    // Spelled with a variable and no `server.js` at all: only its backgrounding gives it away.
    for (const l of ['          node "${srv}.js" > s.log 2>&1 &', '          (cd "$dir" && node "$entry" &)', "          nohup node ./dist/main.mjs > s.log 2>&1 &"]) {
      expect(bootLines(`${l}\n`), l).toBe(1);
      expect(startLines(`${l}\n`), l).toBe(0);
    }
    // A trailing `&&` is a continuation; `2>&1 &` still backgrounds.
    expect(bootLines("          node ./dist/main.mjs &&\n"), "&& is not backgrounding").toBe(0);
    expect(bootLines("          node ./dist/main.mjs > s.log 2>&1 &\n"), "2>&1 & is").toBe(1);
    // And a foreground `node` that is not a server is not a boot.
    expect(bootLines("          node scripts/gen-keys.mjs\n")).toBe(0);
    expect(bootLines("          node --input-type=module -e \"console.log(1)\"\n")).toBe(0);
    expect(bootLines("          # node server.js\n")).toBe(0);
    expect(bootLines("          node tools/other/server-check.ts\n"), "server-check.ts is not server.js").toBe(0);
  });
});

/** The `run:` body of the step whose name starts with `prefix`, dedented. Null when there is no such step or no `run: |`. */
function runBodyOf(text: string, prefix: string): string | null {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => /^\s*- name:/.test(l) && l.replace(/^\s*- name:\s*/, "").startsWith(prefix));
  if (at < 0) return null;
  const keyIndent = indentOf(lines[at]!) + 2;
  let run = -1;
  for (let i = at + 1; i < lines.length; i++) {
    const l = lines[i]!;
    if (!skippable(l) && indentOf(l) < keyIndent) break;
    if (indentOf(l) === keyIndent && /^\s*run:\s*\|\s*$/.test(l)) { run = i; break; }
  }
  if (run < 0) return null;
  const body: string[] = [];
  for (let i = run + 1; i < lines.length; i++) {
    const l = lines[i]!;
    if (l.trim() !== "" && indentOf(l) <= keyIndent) break;
    body.push(l.slice(Math.min(keyIndent + 2, indentOf(l))));
  }
  return body.join("\n");
}

/** What is wrong with the placement of the behavioural proof in a workflow's first server-starting job: a step AFTER the one
 *  that starts the server and BEFORE the first smoke run, that cannot be silenced (no `if:` or `continue-on-error:` on the
 *  step, none making the job non-blocking: either would let it "pass" without ever running). What the step DOES is judged by
 *  running it, below. */
function proofProblems(text: string): string[] {
  const job = jobsOf(text).find((j) => j.lines.some((l) => !isComment(l) && START.test(l)));
  if (!job) return ["no job starts the standalone server"];
  const steps: string[][] = [];
  for (const l of job.lines) {
    if (/^ {6}- /.test(l)) steps.push([]);
    if (!isComment(l)) steps.at(-1)?.push(l);
  }
  const stepText = steps.map((s) => s.join("\n"));
  const startAt = stepText.findIndex((s) => s.split("\n").some((l) => START.test(l)));
  const smokeAt = stepText.findIndex((s) => /\bnpm run test:smoke\s*$/m.test(s));
  const proofAt = stepText.findIndex((s) => /\/shared\//.test(s) && /no-store/i.test(s));
  if (proofAt < 0) return ["no step requests a /shared URL and requires no-store"];
  const problems: string[] = [];
  if (proofAt <= startAt) problems.push("the proof does not come after the step that starts the server");
  if (smokeAt < 0) problems.push("the first smoke run was not found, so the proof cannot be ordered before it");
  else if (proofAt >= smokeAt) problems.push("the proof does not come before the first smoke run");
  if (steps[proofAt]!.some((l) => STEP_SILENCE.test(l))) problems.push("the proof step carries an `if:` or `continue-on-error:` and can be skipped or ignored");
  if (job.lines.some((l) => !isComment(l) && /^ {4}continue-on-error:/.test(l))) problems.push("the job is continue-on-error, so a red proof blocks nothing");
  return problems;
}

type Answer = { code: string; cacheControl: string | null; isr?: false | "MISS" | "HIT" | "STALE" };
type Ran = { exit: number | null; out: string; urls: string[]; maxTimes: string[] };

/** Run a step's `run:` body the way Actions does (`bash -e`), with `curl` and `sleep` stubbed on PATH: curl answers `answer`
 *  to every request and logs its arguments; sleep returns at once. The body's other tools (seq, tr, grep, cat) are real.
 *  `isr` (default "MISS") is the value of the `x-nextjs-cache` header a response rendered through Next's incremental cache
 *  carries; false sends none. */
function runStep(body: string, answer: Answer): Ran {
  const dir = mkdtempSync(join(tmpdir(), "register-proof-"));
  try {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const log = join(dir, "curl-calls.log");
    writeFileSync(
      join(bin, "curl"),
      [
        "#!/bin/bash",
        'printf "%s\\n" "$*" >> "$STUB_LOG"',
        'hdrs=""',
        'while [ $# -gt 0 ]; do case "$1" in -D) hdrs="$2"; shift 2;; *) shift;; esac; done',
        'if [ "$STUB_CODE" = "000" ]; then printf 000; exit 7; fi',
        '{ printf "HTTP/1.1 %s X\\r\\n" "$STUB_CODE"; if [ -n "$STUB_CC" ]; then printf "Cache-Control: %s\\r\\n" "$STUB_CC"; fi; if [ -n "$STUB_ISR" ]; then printf "x-nextjs-cache: %s\\r\\nx-nextjs-prerender: 1\\r\\n" "$STUB_ISR"; fi; printf "\\r\\n"; } > "$hdrs"',
        'printf "%s" "$STUB_CODE"',
        "",
      ].join("\n"),
    );
    writeFileSync(join(bin, "sleep"), "#!/bin/bash\nexit 0\n");
    chmodSync(join(bin, "curl"), 0o755);
    chmodSync(join(bin, "sleep"), 0o755);
    writeFileSync(join(dir, "dev-server.log"), "(server log)\n");
    writeFileSync(join(dir, "step.sh"), body);
    const r = spawnSync("bash", ["-e", join(dir, "step.sh")], {
      cwd: dir,
      encoding: "utf8",
      timeout: 60_000,
      env: {
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        HOME: dir,
        NODE_ENV: "test",
        RUNNER_TEMP: dir,
        GITHUB_RUN_ID: "424242",
        STUB_LOG: log,
        STUB_CODE: answer.code,
        STUB_CC: answer.cacheControl ?? "",
        STUB_ISR: answer.isr === false ? "" : (answer.isr ?? "MISS"),
      },
    });
    let calls: string[] = [];
    try { calls = readFileSync(log, "utf8").split("\n").filter(Boolean); } catch { /* no curl call was made */ }
    return {
      exit: r.status,
      out: `${r.stdout}${r.stderr}`,
      urls: calls.map((c) => /(http\S+)\s*$/.exec(c)?.[1] ?? ""),
      maxTimes: calls.map((c) => /--max-time\s+(\d+)/.exec(c)?.[1] ?? ""),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const S_MAXAGE = "s-maxage=30, stale-while-revalidate=270";
const NO_STORE = "private, no-cache, no-store, max-age=0, must-revalidate";
/** What the proof must do for each thing curl could answer — from the rule (a public 404 that went through Next's ISR cache
 *  goes out no-store; anything else fails the job), not from the step's own text. */
const TABLE: { what: string; answer: Answer; exit: number }[] = [
  { what: "404 with the ISR window's s-maxage (register() never ran)", answer: { code: "404", cacheControl: S_MAXAGE }, exit: 1 },
  { what: "404 no-store from an ISR render (register() ran)", answer: { code: "404", cacheControl: NO_STORE }, exit: 0 },
  { what: "200 no-store (a found page is not the proof)", answer: { code: "200", cacheControl: NO_STORE }, exit: 1 },
  { what: "no answer at all (000, no header)", answer: { code: "000", cacheControl: null }, exit: 1 },
  { what: "404 with no Cache-Control header", answer: { code: "404", cacheControl: null }, exit: 1 },
  { what: "404 no-store WITHOUT the ISR marker (a dynamic render sends no-store by itself: proves nothing)", answer: { code: "404", cacheControl: NO_STORE, isr: false }, exit: 1 },
  { what: "404 no-store with x-nextjs-cache: HIT (a fresh slug is always a MISS: this was replayed from a cache)", answer: { code: "404", cacheControl: NO_STORE, isr: "HIT" }, exit: 1 },
];

/** What a TABLE row's run did, judged against the row: a wrong exit, or the right exit for the wrong reason. Null if right. */
function judgeRow(row: (typeof TABLE)[number], ran: Ran): string | null {
  if (ran.exit !== row.exit) return `${row.what}: exit ${String(ran.exit)}, wanted ${row.exit}`;
  if (row.exit === 0 && !(ran.urls.length === 1 && /register\(\) ran/.test(ran.out))) return `${row.what}: passed without saying so, or after ${ran.urls.length} requests`;
  if (row.exit === 1 && !(ran.urls.length === 15 && new Set(ran.urls).size === 15 && /did not go out no-store/.test(ran.out))) return `${row.what}: failed without the bound (${ran.urls.length} requests, ${new Set(ran.urls).size} distinct) or its message`;
  return null;
}

/** Run TABLE against a body: each row's run and verdict (all rows, or stopping at the first wrong one when only "is it wrong
 *  at all" is asked, which spares a mutant check the rows it does not need). */
function runTable(body: string, stopAtFirst = false): { wrong: string[]; ran: Ran[] } {
  const wrong: string[] = [];
  const ran: Ran[] = [];
  for (const row of TABLE) {
    if (stopAtFirst && wrong.length > 0) break;
    const r = runStep(body, row.answer);
    ran.push(r);
    const verdict = judgeRow(row, r);
    if (verdict) wrong.push(verdict);
  }
  return { wrong, ran };
}

/** Mutations of the proof step's text, each of which the table must catch. */
const MUTANTS: [string, string, string][] = [
  ["404 accepted as 200", '"$code" = "404"', '"$code" = "200"'],
  ["the status AND no-store test turned into an OR", '[ "$code" = "404" ] && grep', '[ "$code" = "404" ] || grep'],
  ["the header test swapped for a look-alike", "grep -qi 'no-store'", "grep -qi 'cache'"],
  ["the ISR premise dropped", ' && [ -n "$isr" ]', ""],
  ["the ISR header test swapped for a look-alike", "^x-nextjs-cache:", "^x-powered-by:"],
  ["the MISS requirement relaxed to any x-nextjs-cache value", "[[:space:]]*MISS", ""],
  ["the failure no longer fails the job", "cat dev-server.log; exit 1", "cat dev-server.log; exit 0"],
];
/** The time one row's run is allowed under load, in ms: the tests' timeouts are derived from it and the row count, so a row
 *  added to TABLE or MUTANTS moves them. (A measured run took ~7 s a row at load 376.) */
const ROW_BUDGET_MS = 30_000;

describe("the behavioural proof that register() ran", () => {
  const ci = readFileSync(resolve(WORKFLOWS, "ci.yml"), "utf8");
  const body = runBodyOf(ci, "Prove the server ran register()");

  it("ci.yml: the proof step sits between the server start and the first smoke run, and cannot be silenced", () => {
    expect(proofProblems(ci)).toEqual([]);
    expect(body, "the proof step's run: body was not found").not.toBeNull();
  });

  it(
    "the extracted step, run against a stub curl, passes only for a 404 from an ISR render that is no-store — and asks fresh /shared URLs, bounded to 10 s each",
    { timeout: TABLE.length * ROW_BUDGET_MS },
    () => {
      const { wrong, ran } = runTable(body!);
      expect(wrong).toEqual([]);
      expect(ran.length, "every row ran").toBe(TABLE.length);
      // Every request (row 0's, reused: it already made all 15) is a /shared/ URL on the job's server port, with the short bound.
      const first = ran[0]!;
      expect(first.urls.length).toBe(15);
      for (const u of first.urls) expect(u, "the proof asks a public /shared URL").toMatch(/^http:\/\/localhost:3000\/shared\/[\w-]+$/);
      expect(first.maxTimes, "a hung server must not cost 30 s a try").toEqual(Array(15).fill("10"));
    },
  );

  it(
    "the detector is live: a mutated step body is caught by the table, and the ordering and silencing checks catch a misplaced or muted step",
    { timeout: MUTANTS.length * TABLE.length * ROW_BUDGET_MS },
    () => {
      let caught = 0;
      for (const [what, from, to] of MUTANTS) {
        expect(body!.split(from).length - 1, `${what}: the mutation target occurs once`).toBe(1);
        expect(runTable(body!.replace(from, to), true).wrong.length, what).toBeGreaterThan(0);
        caught++;
      }
      expect(caught).toBe(MUTANTS.length);
      const head = "jobs:\n  smoke:\n    steps:\n";
      const start = ["      - name: Start", "        run: |", "          node apps/web/.next/standalone/apps/web/server.js &"];
      const proof = ["      - name: Prove", "        run: |", "          curl http://localhost:3000/shared/x | grep -qi 'no-store'"];
      const smoke = ["      - name: Smoke", "        run: npm run test:smoke"];
      const job = (...steps: string[][]): string => `${head}${steps.flat().join("\n")}\n`;
      const muted = (key: string): string[] => ["      - name: Prove", `        ${key}`, ...proof.slice(1)];
      expect(proofProblems(job(start, proof, smoke)), "the sound order").toEqual([]);
      expect(proofProblems(job(start, smoke)).join("|")).toMatch(/no step requests/);
      expect(proofProblems(job(proof, start, smoke)).join("|")).toMatch(/after the step that starts/);
      expect(proofProblems(job(start, smoke, proof)).join("|")).toMatch(/before the first smoke run/);
      // Muting: the proof can pass without running if it is skippable or its failure is ignored.
      expect(proofProblems(job(start, muted("continue-on-error: true"), smoke)).join("|"), "continue-on-error").toMatch(/can be skipped or ignored/);
      expect(proofProblems(job(start, muted("if: false"), smoke)).join("|"), "if: false").toMatch(/can be skipped or ignored/);
      expect(proofProblems(job(start, ["      - if: false", ...proof.slice(1)], smoke)).join("|"), "an if: on the header line, no name").toMatch(/can be skipped or ignored/);
      expect(proofProblems(`jobs:\n  smoke:\n    continue-on-error: true\n    steps:\n${[start, proof, smoke].flat().join("\n")}\n`).join("|"), "a non-blocking job").toMatch(/continue-on-error, so a red proof/);
      // The positive pair: a `name:` and a commented-out `# if:` do not mute it.
      expect(proofProblems(job(start, ["      - name: Prove", "        # if: false", ...proof.slice(1)], smoke)), "a comment is not an if").toEqual([]);
    },
  );

  it("runBodyOf reads a step's run block, dedented, and nothing past it", () => {
    const text = "jobs:\n  a:\n    steps:\n      - name: One\n        run: |\n          echo one\n          echo two\n\n      - name: Two\n        run: echo no\n";
    expect(runBodyOf(text, "One")).toBe("echo one\necho two\n");
    expect(runBodyOf(text, "Two"), "a one-line run is not a block").toBeNull();
    expect(runBodyOf(text, "Missing")).toBeNull();
  });
});

describe("text sweep: no server-starting workflow assigns a non-empty Sentry DSN, and each server-start step blanks both variables in its own env", () => {
  it("every standalone-server start's OWN step env holds SENTRY_DSN and NEXT_PUBLIC_SENTRY_DSN blank, and no such workflow assigns a real value", () => {
    let scanned = 0;
    let blanked = 0;
    let starts = 0;
    for (const wf of workflowFiles()) {
      const text = readFileSync(resolve(WORKFLOWS, wf), "utf8");
      const found = startEnvs(text);
      if (found.length === 0) continue;
      scanned++;
      starts += startLines(text);
      expect(dsnAssignments(text), `${wf} assigns a Sentry DSN value — the booted server's register() would send CI events to the real project`).toEqual([]);
      for (const { line, env } of found) {
        expect(env.SENTRY_DSN, `${wf}:${line} must hold SENTRY_DSN blank-but-defined in its own env`).toBe("");
        expect(env.NEXT_PUBLIC_SENTRY_DSN, `${wf}:${line} must hold NEXT_PUBLIC_SENTRY_DSN blank-but-defined in its own env`).toBe("");
        blanked++;
      }
    }
    expect(scanned, "no server-starting workflow was scanned").toBeGreaterThan(0);
    expect(blanked, "a start was seen but its env was not judged").toBe(starts);
  });

  it("the detectors are live: a value is caught, a blank, a comment and a look-alike are not, and each start is judged by its OWN step's env", () => {
    let caught = 0;
    for (const l of ['          SENTRY_DSN: https://abc@o1.ingest.sentry.io/1', '          NEXT_PUBLIC_SENTRY_DSN: "https://abc@o1.ingest.sentry.io/1"', "          export SENTRY_DSN=https://abc@o1.ingest.sentry.io/1", "          SENTRY_DSN: ${{ secrets.SENTRY_DSN }}"]) {
      expect(dsnAssignments(`${l}\n`), l).toHaveLength(1);
      caught++;
    }
    expect(caught).toBe(4);
    expect(dsnAssignments('          SENTRY_DSN: ""\n          NEXT_PUBLIC_SENTRY_DSN: ""\n          SENTRY_DSN=\n'), "blank is the safe spelling").toEqual([]);
    expect(dsnAssignments("          # SENTRY_DSN: https://abc@o1.ingest.sentry.io/1\n"), "a comment").toEqual([]);
    expect(dsnAssignments("          SENTRY_AUTH_TOKEN: ${{ secrets.SENTRY_AUTH_TOKEN }}\n"), "a look-alike name").toEqual([]);
    const run = "        run: |\n          node apps/web/.next/standalone/apps/web/server.js &\n";
    const own = `jobs:\n  a:\n    steps:\n      - name: Start\n        env:\n          # why\n          SENTRY_DSN: ""\n          NEXT_PUBLIC_SENTRY_DSN: ''\n${run}`;
    expect(startEnvs(own)[0]!.env).toEqual({ SENTRY_DSN: "", NEXT_PUBLIC_SENTRY_DSN: "" });
    // Attribution: a neighbouring step's blanks, and an env with neither key, are not this step's blanks.
    const neighbour = `jobs:\n  a:\n    steps:\n      - name: Other\n        env:\n          SENTRY_DSN: ""\n          NEXT_PUBLIC_SENTRY_DSN: ""\n        run: echo ok\n      - name: Start\n${run}`;
    expect(startEnvs(neighbour)[0]!.env.SENTRY_DSN, "the neighbour's env").toBeUndefined();
    const without = `jobs:\n  a:\n    steps:\n      - name: Start\n        env:\n          PORT: "3000"\n${run}`;
    expect(startEnvs(without)[0]!.env).toEqual({ PORT: "3000" });
    expect(startEnvs(without)[0]!.env.SENTRY_DSN).toBeUndefined();
  });
});
