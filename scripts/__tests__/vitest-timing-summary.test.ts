// scripts/vitest-timing-summary.ts turns the DB jobs' vitest JSON into the job
// summary the next boundary move is made from. Report-only, so the cases are
// the ones that would make that summary lie or the step go red: the ranking
// and its cap, the per-letter table keyed the way the jobs split, and the
// missing / empty report a red run leaves behind.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SCRIPT = join(import.meta.dirname, "..", "vitest-timing-summary.ts");
let dir = "";

beforeAll(() => {
  // realpath: on macOS tmpdir() is /var/… while the child's cwd resolves to
  // /private/var/…, and the script reports names relative to its cwd.
  dir = realpathSync(mkdtempSync(join(tmpdir(), "vitest-timing-")));
});
afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** A vitest JSON report with one file per entry; span in ms. */
const report = (name: string, files: Array<[string, number]>) => {
  const path = join(dir, name);
  writeFileSync(
    path,
    JSON.stringify({
      testResults: files.map(([file, span], i) => ({
        name: join(dir, file),
        startTime: 1_000_000 + i,
        endTime: 1_000_000 + i + span,
        status: "passed",
        assertionResults: [{}, {}],
      })),
    }),
  );
  return path;
};
const summarise = (...paths: string[]) => {
  const summary = join(dir, `summary-${Math.random().toString(36).slice(2)}.md`);
  writeFileSync(summary, "");
  const r = spawnSync(process.execPath, ["--experimental-strip-types", SCRIPT, ...paths], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, GITHUB_STEP_SUMMARY: summary },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, summary: readFileSync(summary, "utf8") };
};
const rankedFiles = (md: string) => [...md.matchAll(/^\| (\d+) \| `([^`]+)` \|/gm)].map((m) => m[2]);

describe("vitest-timing-summary.ts", () => {
  it("ranks the 20 slowest files across every report, slowest first, and writes the job summary", () => {
    // 25 files over two reports; spans are distinct so the order is fixed.
    const files: Array<[string, number]> = Array.from({ length: 25 }, (_, i) => [`src/lib/f${String(i).padStart(2, "0")}.test.ts`, (i + 1) * 1000]);
    const a = report("a.json", files.slice(0, 12));
    const b = report("b.json", files.slice(12));
    const r = summarise(a, b);
    expect(r.status, r.stderr).toBe(0);
    expect(r.summary).toBe(r.stdout);

    const ranked = rankedFiles(r.summary);
    expect(ranked).toHaveLength(20);
    // Slowest is f24 (25s); the 20th is f05 (6s); f00..f04 fall off the end.
    expect(ranked[0]).toBe("src/lib/f24.test.ts");
    expect(ranked[19]).toBe("src/lib/f05.test.ts");
    expect(ranked).not.toContain("src/lib/f04.test.ts");
    expect(r.summary).toContain("25 files, 325.0s of test span");
  });

  it("tables usecases files by FIRST LETTER of the file name at any depth — the DB jobs' boundary key", () => {
    const r = summarise(
      report("uc.json", [
        ["src/server/usecases/__tests__/alpha.test.ts", 2000],
        ["src/server/usecases/__tests__/apple.test.ts", 3000],
        ["src/server/usecases/external-play/__tests__/open-round.test.ts", 4000],
        ["src/server/lib/__tests__/zeta.test.ts", 9000],
      ]),
    );
    expect(r.status, r.stderr).toBe(0);
    // `open-round` sits under external-play/ but files under `o`, not `e`; the
    // non-usecases file is in the ranking and not in the letter table.
    expect(r.summary).toMatch(/^\| a \| 2 \| 5\.0s \|$/m);
    expect(r.summary).toMatch(/^\| o \| 1 \| 4\.0s \|$/m);
    expect(r.summary).not.toMatch(/^\| [ez] \|/m);
    expect(rankedFiles(r.summary)[0]).toBe("src/server/lib/__tests__/zeta.test.ts");
  });

  it("exits 0 and says so when a report is missing, unreadable, or there is none at all", () => {
    const good = report("good.json", [["src/lib/one.test.ts", 1500]]);
    const broken = join(dir, "broken.json");
    writeFileSync(broken, "{ not json");
    const mixed = summarise(good, join(dir, "absent.json"), broken);
    expect(mixed.status, mixed.stderr).toBe(0);
    expect(rankedFiles(mixed.summary)).toEqual(["src/lib/one.test.ts"]);
    expect(mixed.summary).toContain("absent.json: not found");
    expect(mixed.summary).toContain("broken.json: unreadable");

    const none = summarise();
    expect(none.status, none.stderr).toBe(0);
    expect(none.summary).toContain("No per-file timings: 0 report path(s) given, 0 test files in them.");
  });
});
