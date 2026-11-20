// MD-R29's sweep, by SHAPE and across every test file (not by directory, not by filename): a `vi.mock("@/lib/db")` that stubs `withTenant` as
// `(orgId, fn) => fn(tx)` (the page suites' scaffold) drops `opts.privilegedPrelude`, so any page it renders that reaches `withRoundOpensToday` throws
// ("the sealed read of the round opens did not run before the role dropped") - 76 reds in the division page's suite, missed twice because
// the scoped runs were chosen by filename. The stand-in to use is `tenantRunningPrelude` (_with-tenant-mock.ts).
//
// Anti-vacuity: the scan reports how many test files it read and how many stubs it saw in each shape; zero files, or no stub on the shared
// stand-in, is a failure of the sweep itself. The scan cannot be fooled by the helper's own text: it skips this file and the helper.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = resolve(__dirname, "../..");
const SELF = resolve(__dirname, "with-tenant-mock-sweep.test.ts");
const HELPER_TEST = resolve(__dirname, "with-tenant-mock.test.ts");

function testFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) testFiles(p, out);
    else if (/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

/** Every line that stubs `withTenant` in the page suites' scaffold: `withTenant: (_orgId: string, fn: (t: unknown) => unknown ...`. Other, bespoke stubs
 *  (an async `cb`, a spy over the real one) are not this family and are not read here: a page that reaches `withRoundOpensToday` through one of
 *  them still fails, loudly and by name, on the guard at usecases/match-day.ts. */
const STUB_LINE = /withTenant:\s*\(_orgId: string, fn: \(t: unknown\) => unknown/;

describe("every `withTenant` stub in a `vi.mock(\"@/lib/db\")` runs the privileged prelude", () => {
  const files = testFiles(SRC).filter((f) => f !== SELF && f !== HELPER_TEST);
  const stubs: { file: string; line: string; runsPrelude: boolean }[] = [];
  for (const file of files) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (STUB_LINE.test(line)) stubs.push({ file, line: line.trim(), runsPrelude: /opts|privilegedPrelude/.test(line) });
    }
  }

  it("anti-vacuity: the scan read the repository's test files and found stubs in the shape it is about", () => {
    expect(files.length, "test files read").toBeGreaterThan(3000);
    expect(stubs.length, "stubs of the scaffold family seen").toBeGreaterThanOrEqual(26);
    expect(stubs.filter((s) => s.runsPrelude).length, "of them, the ones that pass `opts` on").toBeGreaterThanOrEqual(26);
  });

  it("none drops `opts` (a stub that ignores the prelude breaks every page that reads the sealed round opens in one)", () => {
    const dropping = stubs.filter((s) => !s.runsPrelude).map((s) => `${s.file.slice(SRC.length + 1)}: ${s.line}`);
    expect(dropping, "stubs that call fn(tx) without running opts.privilegedPrelude - use tenantRunningPrelude").toEqual([]);
  });

  it("the stubs that pass `opts` on do it through the shared stand-in, not a private copy", () => {
    const own = stubs.filter((s) => s.runsPrelude && !s.line.includes("tenantRunningPrelude(")).map((s) => `${s.file.slice(SRC.length + 1)}: ${s.line}`);
    expect(own, "a private prelude-running stub must be this helper's, or be allow-listed here with a reason").toEqual([]);
  });
});
