// Per-file timing out of vitest JSON reports, for a CI job summary.
//
// ci.yml splits the DB suites across four jobs by the first letter of each
// src/server/usecases test file name. The letters were first picked from file
// COUNTS, because no run had kept its vitest JSON and the default reporter
// prints no per-file durations. Every DB job now uploads its reports and runs
// this, so the next boundary move can be made from real numbers: the slowest
// files, and a per-first-letter table of the usecases files the job ran.
//
// Usage (bash, with `shopt -s nullglob` so an absent report is no argument):
//   node --experimental-strip-types scripts/vitest-timing-summary.ts apps/web/vitest-results-*.json
//
// The span per file is what vitest's JSON reporter records: the first test's
// start to the last test's end. It EXCLUDES module import and beforeAll, which
// on the DB jobs is a large share (run 42858008888: 580s import against 1809s
// tests, summed over workers, in one usecases step). Read it as a ranking and a
// relative weight, not as a file's whole cost.
//
// Report-only: it always exits 0. It runs under `if: always()`, after a red step
// as often as after a green one, and failing here would only add a second red
// on top of the one that matters.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { basename, relative } from "node:path";

const TOP = 20;

interface Row {
  file: string;
  ms: number;
  tests: number;
  status: string;
  report: string;
}

const reports = process.argv.slice(2);
const rows: Row[] = [];
const notes: string[] = [];

for (const path of reports) {
  if (!existsSync(path)) {
    notes.push(`${path}: not found`);
    continue;
  }
  let parsed: { testResults?: unknown };
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as { testResults?: unknown };
  } catch (e) {
    notes.push(`${path}: unreadable (${(e as Error).message})`);
    continue;
  }
  const results = Array.isArray(parsed.testResults) ? parsed.testResults : [];
  for (const raw of results) {
    const t = raw as { name?: unknown; startTime?: unknown; endTime?: unknown; status?: unknown; assertionResults?: unknown };
    if (typeof t.name !== "string") continue;
    const start = typeof t.startTime === "number" ? t.startTime : 0;
    const end = typeof t.endTime === "number" ? t.endTime : start;
    rows.push({
      file: relative(process.cwd(), t.name),
      ms: Math.max(0, end - start),
      tests: Array.isArray(t.assertionResults) ? t.assertionResults.length : 0,
      status: typeof t.status === "string" ? t.status : "?",
      report: basename(path),
    });
  }
}

const secs = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;
const lines: string[] = [];

if (rows.length === 0) {
  lines.push(`### Vitest per-file timing`, ``, `No per-file timings: ${reports.length} report path(s) given, 0 test files in them.`);
} else {
  const total = rows.reduce((s, r) => s + r.ms, 0);
  const slowest = [...rows].sort((a, b) => b.ms - a.ms || a.file.localeCompare(b.file)).slice(0, TOP);
  lines.push(
    `### Vitest per-file timing — ${rows.length} files, ${secs(total)} of test span`,
    ``,
    `Span = first test start to last test end per file (vitest JSON). It excludes import and beforeAll, so rank by it; do not sum it into wall clock.`,
    ``,
    `| # | file | span | tests | status | report |`,
    `|---|---|---|---|---|---|`,
    ...slowest.map((r, i) => `| ${i + 1} | \`${r.file}\` | ${secs(r.ms)} | ${r.tests} | ${r.status} | ${r.report} |`),
  );

  // The boundaries are first letters of usecases test FILE names, at any depth.
  const byLetter = new Map<string, { files: number; ms: number }>();
  for (const r of rows) {
    if (!/(^|\/)server\/usecases\//.test(r.file)) continue;
    const letter = basename(r.file).charAt(0);
    const acc = byLetter.get(letter) ?? { files: 0, ms: 0 };
    acc.files += 1;
    acc.ms += r.ms;
    byLetter.set(letter, acc);
  }
  if (byLetter.size > 0) {
    lines.push(
      ``,
      `#### src/server/usecases by first letter (the DB jobs' boundary key)`,
      ``,
      `| letter | files | span |`,
      `|---|---|---|`,
      ...[...byLetter.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([letter, acc]) => `| ${letter} | ${acc.files} | ${secs(acc.ms)} |`),
    );
  }
}
if (notes.length > 0) lines.push(``, ...notes.map((n) => `- ${n}`));

const text = `${lines.join("\n")}\n`;
process.stdout.write(text);
const summary = process.env.GITHUB_STEP_SUMMARY;
if (summary) {
  try {
    appendFileSync(summary, text);
  } catch (e) {
    process.stdout.write(`could not append to the job summary: ${(e as Error).message}\n`);
  }
}
