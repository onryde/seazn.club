// A green vitest run is only evidence about the files it actually COLLECTED,
// and collection has been observed to differ between runs with identical
// arguments — 511 files once, 158 three times, all exit 0 (#339). This
// reconciles the two things that must agree: the files `vitest list` selects
// for a set of paths, and the files the run that just happened actually
// executed. A mismatch fails the job, because the alternative is a suite
// silently leaving coverage while the summary still reads green.
//
// Deliberately does NOT execute the suite itself. `vitest list` is a
// collection-only pass (cheap); the executed set is read from the JSON reporter
// output of the run that already happened, so the guard costs one extra
// collection rather than a second full run.
//
// Usage:
//   node --experimental-strip-types scripts/check-vitest-collection.ts \
//     --results apps/web/vitest-results.json -- src/server src/lib
//
// `--exclude <glob>` (repeatable) is forwarded verbatim to `vitest list`, and
// exists because ci.yml splits src/server+src/lib across two jobs by excluding
// complementary halves of src/server/usecases/__tests__. The listing must be
// narrowed by the SAME glob the run was narrowed by, or every file the other
// job owns is reported here as "listed but not run".
//
// Why exclude-globs and not `--shard`, which would need no globs at all: in
// vitest 4.1.9 `vitest run --shard=1/2` genuinely partitions (verified 7 + 7
// files, zero overlap) but `vitest list --shard=1/2` SILENTLY IGNORES the flag
// — 247 files for 1/2, for 2/2, and for no shard at all. There is therefore no
// oracle for what a shard should have contained, and this reconciliation could
// not be expressed per-job at all. `--exclude` IS honoured by both (verified:
// 4 files -> 3 on both `list` and `run`), which is the whole reason the split
// is cut this way. Do not "simplify" it to --shard.
//
// CLI `--exclude` ADDS to vitest.config.ts's `exclude` rather than replacing it
// (verified: 819 files with and without a no-op --exclude, and zero e2e/ entries
// either way). That matters — a replacing flag would re-admit `e2e/**` and
// `**/.next/**`, and globbing the .next copies has segfaulted a run before.
//
// The paths after `--` must be EXACTLY the paths the run was given. Note what
// that means for the caller: `npm test --workspace apps/web -- run src/foo`
// passes THREE filename filters, because the workspace script is already
// `vitest run` — the stray `run` matched src/components/**/run-*.test.tsx and
// dragged two component suites into a Postgres-only job. That is what this
// script exists to make visible.
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const argv = process.argv.slice(2);
const sep = argv.indexOf("--");
const flags = sep === -1 ? argv : argv.slice(0, sep);
const paths = sep === -1 ? [] : argv.slice(sep + 1);

const resultsIdx = flags.indexOf("--results");
const resultsPath = resultsIdx === -1 ? null : flags[resultsIdx + 1];

// Every occurrence, so a caller may narrow with more than one glob. An empty
// string is dropped rather than forwarded: an unset shell variable would
// otherwise reach vitest as `--exclude ''`, which matches nothing and would
// silently widen the listing back to the full set while looking configured.
const excludes: string[] = [];
for (let i = 0; i < flags.length; i++) {
  if (flags[i] === "--exclude" && flags[i + 1]) {
    if (flags[i + 1].trim() !== "") excludes.push(flags[i + 1]);
    i++;
  }
}

if (!resultsPath || paths.length === 0) {
  console.error(
    "usage: check-vitest-collection --results <vitest json output> [--exclude <glob>…] -- <path…>",
  );
  process.exit(2);
}

if (!existsSync(resultsPath)) {
  console.error(
    `[collection] no results file at ${resultsPath}. The test step must write one:\n` +
      `  npm test --workspace apps/web -- --reporter=default --reporter=json --outputFile=${resultsPath} <paths>`,
  );
  process.exit(1);
}

/** Every distinct test-file path anywhere in a vitest JSON payload. */
const filesFrom = (json: string): Set<string> => {
  const out = new Set<string>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node && typeof node === "object") {
      const rec = node as Record<string, unknown>;
      for (const key of ["file", "filepath", "name"]) {
        const value = rec[key];
        // `name` is a test title on most nodes and a path on file-level ones —
        // the extension test is what separates them, and it is why this reads
        // three keys rather than trusting one shape across vitest versions.
        if (typeof value === "string" && /\.(test|spec)\.[cm]?[jt]sx?$/.test(value)) {
          out.add(value);
        }
      }
      Object.values(rec).forEach(walk);
    }
  };
  walk(JSON.parse(json) as unknown);
  return out;
};

// `--filesOnly` is load-bearing. Without it, `vitest list` emits TEST CASES, so
// a file whose whole describe is `skipIf`'d off (every DB-backed suite when
// DATABASE_URL is unset) contributes nothing and vanishes from the listing —
// measured here as 185 listed against 345 executed for the same two paths. A
// file-level question needs a file-level oracle.
const listJson = join(mkdtempSync(join(tmpdir(), "vitest-collect-")), "list.json");
const excludeArgs = excludes.flatMap((g) => ["--exclude", g]);
execFileSync("npx", ["vitest", "list", "--filesOnly", `--json=${listJson}`, ...excludeArgs, ...paths], {
  cwd: "apps/web",
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
  stdio: ["ignore", "ignore", "inherit"],
});

// Compare by path SUFFIX: `vitest list` emits absolute paths and the run
// reporter emits repo-relative ones, and normalising both to the shortest
// common tail is more robust than guessing a root that differs between a
// workspace invocation and a CI checkout.
const tail = (p: string): string => p.replace(/^.*?(apps\/web\/)?src\//, "src/");
const listed = new Set([...filesFrom(readFileSync(listJson, "utf8"))].map(tail));
const executed = new Set([...filesFrom(readFileSync(resultsPath, "utf8"))].map(tail));

const missing = [...listed].filter((f) => !executed.has(f)).sort();
const extra = [...executed].filter((f) => !listed.has(f)).sort();

console.log(
  `[collection] listed=${listed.size} executed=${executed.size} for: ${paths.join(" ")}` +
    (excludes.length ? ` (excluding ${excludes.join(", ")})` : ""),
);

if (missing.length || extra.length) {
  if (missing.length) {
    console.error(`[collection] LISTED BUT NOT RUN (${missing.length}):\n  ${missing.join("\n  ")}`);
  }
  if (extra.length) {
    console.error(`[collection] RAN BUT NOT LISTED (${extra.length}):\n  ${extra.join("\n  ")}`);
  }
  process.exit(1);
}

console.log("[collection] OK — every listed file ran, and nothing else did.");
