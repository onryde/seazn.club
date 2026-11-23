// Reads the Lighthouse JSON reports ci.yml's smoke-e2e job writes (one per page, `--output=json`) and decides the step.
//
//   * Accessibility, Best Practices and SEO must be 100 on EVERY page.
//   * Performance is REPORTED (the job summary) and never gates: a shared runner's CPU moves it by tens of points, and
//     Blog P2 Task 13 measured the same score on a help control page as on the blog (shared chrome, not blog files).
//   * A run that scored nothing must not pass. Fewer than DEFAULT_MIN_PAGES distinct pages, an empty directory, a missing
//     or score-less category, a Lighthouse runtime error and a non-mobile profile are all failures, so a Chrome that never
//     started, a typo'd output path or a lost `--form-factor` cannot read as green.
//
// Usage (the repo root, Node's type stripping; no dependency):
//   node --experimental-strip-types scripts/lighthouse-check.ts --dir <reports> [--min-pages 5]
// Exit 0 on a pass, 1 on a failure, 2 on bad usage. Appends a markdown table to $GITHUB_STEP_SUMMARY when it is set.
//
// Tested by scripts/__tests__/lighthouse-check.test.ts, over real Lighthouse 13.4.0 reports.
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Must score exactly MIN_SCORE on every page. */
export const GATED_CATEGORIES = ["accessibility", "best-practices", "seo"] as const;
/** Reported, never gating. */
export const REPORTED_CATEGORIES = ["performance"] as const;
/** Every report must carry all of these with a numeric score. */
export const REQUIRED_CATEGORIES = [...REPORTED_CATEGORIES, ...GATED_CATEGORIES] as const;
export type Category = (typeof REQUIRED_CATEGORIES)[number];

export const MIN_SCORE = 100;
export const DEFAULT_MIN_PAGES = 5;

const LABEL: Record<Category, string> = {
  performance: "Performance",
  accessibility: "Accessibility",
  "best-practices": "Best Practices",
  seo: "SEO",
};

/** One report file as read: its parsed JSON, or why it could not be parsed. */
export interface Report {
  file: string;
  json: unknown;
  parseError?: string;
}

export interface PageRow {
  file: string;
  url: string;
  /** 0..100, only for a category the report scored. */
  scores: Partial<Record<Category, number>>;
  benchmarkIndex: number | null;
  /** All four categories scored, no runtime error, mobile profile. */
  scored: boolean;
}

export interface Verdict {
  ok: boolean;
  /** Distinct URLs with a fully scored report. */
  pagesScored: number;
  minPages: number;
  rows: PageRow[];
  problems: string[];
  lighthouseVersions: string[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function evaluate(reports: readonly Report[], opts: { minPages?: number } = {}): Verdict {
  const minPages = opts.minPages ?? DEFAULT_MIN_PAGES;
  // A floor of zero would let an empty run pass.
  if (!Number.isInteger(minPages) || minPages < 1) throw new Error(`minPages must be a positive integer, got ${String(minPages)}`);

  const problems: string[] = [];
  const rows: PageRow[] = [];
  const versions = new Set<string>();

  for (const r of reports) {
    if (r.parseError !== undefined || !isRecord(r.json)) {
      problems.push(`${r.file}: not a readable Lighthouse report (${r.parseError ?? "not a JSON object"})`);
      continue;
    }
    const j = r.json;
    const url = [j.finalDisplayedUrl, j.finalUrl, j.requestedUrl].find((u): u is string => typeof u === "string" && u !== "") ?? "";
    const where = url || r.file;
    if (url === "") problems.push(`${r.file}: the report names no URL`);
    if (typeof j.lighthouseVersion === "string") versions.add(j.lighthouseVersion);

    let scored = url !== "";
    if (isRecord(j.runtimeError)) {
      problems.push(`${where}: Lighthouse runtime error ${String(j.runtimeError.code)}: ${String(j.runtimeError.message)}`);
      scored = false;
    }
    const formFactor = isRecord(j.configSettings) ? j.configSettings.formFactor : undefined;
    if (formFactor !== "mobile") {
      problems.push(`${where}: the profile is ${String(formFactor)}, not mobile`);
      scored = false;
    }

    const scores: Partial<Record<Category, number>> = {};
    const cats = isRecord(j.categories) ? j.categories : {};
    for (const cat of REQUIRED_CATEGORIES) {
      const raw = isRecord(cats[cat]) ? cats[cat].score : undefined;
      if (typeof raw !== "number" || !Number.isFinite(raw)) {
        problems.push(`${where}: category ${cat} is missing or has no score`);
        scored = false;
        continue;
      }
      scores[cat] = Math.round(raw * 100);
    }
    for (const cat of GATED_CATEGORIES) {
      const s = scores[cat];
      if (s !== undefined && s < MIN_SCORE) problems.push(`${where}: ${cat} is ${s}, must be ${MIN_SCORE}`);
    }

    const bench = isRecord(j.environment) ? j.environment.benchmarkIndex : undefined;
    rows.push({ file: r.file, url: where, scores, benchmarkIndex: typeof bench === "number" ? bench : null, scored });
  }

  const pagesScored = new Set(rows.filter((r) => r.scored).map((r) => r.url)).size;
  if (reports.length === 0) problems.push("no Lighthouse reports found: nothing was scored");
  if (pagesScored < minPages) problems.push(`only ${pagesScored} distinct page(s) scored, at least ${minPages} required`);

  return { ok: problems.length === 0, pagesScored, minPages, rows, problems, lighthouseVersions: [...versions].sort() };
}

const pathOf = (url: string): string => {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}`;
  } catch {
    return url;
  }
};

/** The job-summary markdown: one row per report, Performance included, then the failures. */
export function summaryMarkdown(v: Verdict): string {
  const cell = (r: PageRow, cat: Category): string => {
    const s = r.scores[cat];
    if (s === undefined) return "missing";
    return (GATED_CATEGORIES as readonly string[]).includes(cat) && s < MIN_SCORE ? `${s} (FAIL)` : String(s);
  };
  const lines = [
    `### Lighthouse (mobile${v.lighthouseVersions.length ? `, ${v.lighthouseVersions.join("/")}` : ""})`,
    "",
    `Accessibility, Best Practices and SEO must be ${MIN_SCORE} on every page. Performance is reported, not gated (shared-runner CPU moves it).`,
    "",
    `| Page | ${REQUIRED_CATEGORIES.map((c) => LABEL[c]).join(" | ")} | benchmarkIndex |`,
    `| --- | ${REQUIRED_CATEGORIES.map(() => "---:").join(" | ")} | ---: |`,
    ...v.rows.map((r) => `| \`${pathOf(r.url)}\` | ${REQUIRED_CATEGORIES.map((c) => cell(r, c)).join(" | ")} | ${r.benchmarkIndex === null ? "n/a" : Math.round(r.benchmarkIndex)} |`),
    "",
    `${v.pagesScored} distinct page(s) scored (at least ${v.minPages} required).`,
  ];
  if (v.problems.length > 0) lines.push("", "**Failures**", "", ...v.problems.map((p) => `- ${p}`));
  return `${lines.join("\n")}\n`;
}

/** Every `*.json` in `dir`, sorted. A missing directory reads as no reports (a failure), never as an error to skip. */
export function readReports(dir: string): Report[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((file): Report => {
      try {
        return { file, json: JSON.parse(readFileSync(join(dir, file), "utf8")) as unknown };
      } catch (e) {
        return { file, json: undefined, parseError: (e as Error).message };
      }
    });
}

function main(argv: string[]): number {
  const arg = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i === -1 ? undefined : argv[i + 1];
  };
  const dir = arg("--dir");
  if (dir === undefined || dir === "") {
    console.error("usage: node --experimental-strip-types scripts/lighthouse-check.ts --dir <reports> [--min-pages 5]");
    return 2;
  }
  const rawMin = arg("--min-pages");
  const minPages = rawMin === undefined ? DEFAULT_MIN_PAGES : Number(rawMin);
  if (!Number.isInteger(minPages) || minPages < 1) {
    console.error(`--min-pages must be a positive integer, got '${String(rawMin)}'`);
    return 2;
  }

  const v = evaluate(readReports(dir), { minPages });
  for (const r of v.rows) {
    console.log(`${pathOf(r.url).padEnd(48)} ${REQUIRED_CATEGORIES.map((c) => `${c} ${r.scores[c] ?? "missing"}`).join("  ")}`);
  }
  console.log(`${v.pagesScored} distinct page(s) scored, at least ${v.minPages} required`);
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) appendFileSync(summary, summaryMarkdown(v));
  for (const p of v.problems) console.error(process.env.GITHUB_ACTIONS ? `::error title=Lighthouse::${p}` : `FAIL ${p}`);
  return v.ok ? 0 : 1;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(main(process.argv.slice(2)));
