// W1d Task 7 (R27, D13): the PR's matrix declaration. A PR that touches packages/engine or stages.ts
// declares `Matrix rows: <rows>` in its body; ci/pr-rows.ts reads it (live, from the body file the job
// fetched) beside the changed files and prints `rows=<csv|all|none>` for $GITHUB_OUTPUT.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ROW_KEYS } from "../lib/catalogue.ts";
import { UnknownRow } from "../lib/pr-sample.ts";
import { DECLARING, decide, main, rowsFromBody, stripComments, stripFences } from "../ci/pr-rows.ts";
import { REPO } from "./committed-plans.ts";
import { SPAWN_MS, SpawnMeter } from "./spawn-budget.ts";

const ENGINE = "packages/engine/src/competition/standings.ts";
const STAGES = "apps/web/src/server/usecases/stages.ts";

describe("rowsFromBody (R27)", () => {
  it.each([
    ["Matrix rows: league, swiss", ["league", "swiss"]],
    ["matrix rows:all", "all"],
    ["Matrix rows: none — copy only", []],
  ] as const)("%j", (t, want) => expect(rowsFromBody(t)).toEqual(want));

  it("an unknown row is refused by name, listing the catalogue", () => {
    expect(() => rowsFromBody("Matrix rows: leage")).toThrow(/leage.*league/s);
    expect(() => rowsFromBody("Matrix rows: leage")).toThrow(UnknownRow);
  });

  it("the empty body declares nothing (null), which is not 'none'", () => expect(rowsFromBody("")).toBeNull());

  it("only the first Matrix rows: line counts; a quoted one inside a code fence is ignored", () => {
    expect(rowsFromBody("```\nMatrix rows: all\n```\nMatrix rows: swiss")).toEqual(["swiss"]);
  });

  it("a body with prose around the line, and a later duplicate: the first line counts, the rest of the body is not read", () => {
    expect(rowsFromBody("## Summary\nfixes a tie-break\n\nMatrix rows: knockout\n\nMatrix rows: all\nthanks")).toEqual(["knockout"]);
  });

  it("the label is case-insensitive, and the value is read whole to the end of its line", () => {
    expect(rowsFromBody("MATRIX ROWS: swiss")).toEqual(["swiss"]);
    expect(rowsFromBody("Matrix Rows:    swiss  ")).toEqual(["swiss"]);
  });

  it("a GitHub body is CRLF: the carriage return is no part of the value", () => {
    expect(rowsFromBody("Fixes a bug\r\n\r\nMatrix rows: league, swiss\r\nMore text\r\n")).toEqual(["league", "swiss"]);
    expect(rowsFromBody("Matrix rows: all\r\n")).toEqual("all");
    expect(rowsFromBody("Matrix rows: none — copy only\r\n")).toEqual([]);
  });

  it("a label with nothing after it declares nothing, and does not borrow the NEXT line as its value", () => {
    expect(rowsFromBody("Matrix rows:")).toBeNull();
    expect(rowsFromBody("Matrix rows:   ")).toBeNull();
    expect(rowsFromBody("Matrix rows:\nswiss")).toBeNull();
    expect(rowsFromBody("Matrix rows:\r\nswiss")).toBeNull();
    // …and an empty first label does not hide a real second one: the regex finds the first line that HAS a value.
    expect(rowsFromBody("Matrix rows:\nMatrix rows: swiss")).toEqual(["swiss"]);
  });

  it("the label must start its line (a mention in prose is not a declaration)", () => {
    expect(rowsFromBody("see Matrix rows: all")).toBeNull();
    expect(rowsFromBody("see the Matrix rows: line")).toBeNull();
  });

  it("an unterminated fence swallows the rest of the body, as markdown does; a ~~~ fence is a fence", () => {
    expect(rowsFromBody("```\nMatrix rows: all")).toBeNull();
    expect(rowsFromBody("~~~\nMatrix rows: all\n~~~\nMatrix rows: league")).toEqual(["league"]);
    expect(rowsFromBody("Matrix rows: swiss\n```\ncode\n```")).toEqual(["swiss"]);
  });

  it("a fence closes only on its own kind and at least its own length (a ``` block holds a ~~~ line)", () => {
    expect(rowsFromBody("```\n~~~\nMatrix rows: all\n```\nMatrix rows: league")).toEqual(["league"]);
    expect(rowsFromBody("````\n```\nMatrix rows: all\n````\nMatrix rows: league")).toEqual(["league"]);
  });

  it("a CRLF body's fences are fences: a quoted template inside one is not the declaration (the split must take the CR)", () => {
    expect(rowsFromBody("```\r\nMatrix rows: all\r\n```\r\nMatrix rows: league\r\n")).toEqual(["league"]);
    expect(rowsFromBody("~~~\r\nMatrix rows: all\r\n~~~\r\n")).toBeNull();
    expect(stripFences("a\r\n```\r\nb\r\n```\r\nc")).toBe("a\nc");
  });

  it("an info string opens a fence, except a backtick one holding a backtick (that is inline code, never a fence)", () => {
    expect(rowsFromBody("``` js\nMatrix rows: all\n```\nMatrix rows: league")).toEqual(["league"]);
    expect(rowsFromBody("~~~ a`b\nMatrix rows: all\n~~~\nMatrix rows: league")).toEqual(["league"]);
    // Inline code at the start of a line opens nothing: the declaration after it is still read.
    expect(rowsFromBody("```x``` is a snippet\nMatrix rows: league")).toEqual(["league"]);
    expect(stripFences("```x``` is a snippet\nb")).toBe("```x``` is a snippet\nb");
  });

  it("an unknown row in the declaration is refused even when a later, valid line exists (the first line counts)", () => {
    expect(() => rowsFromBody("Matrix rows: leage\nMatrix rows: league")).toThrow(UnknownRow);
  });

  it("every catalogue row is declarable, one per body (anti-vacuity: 21 rows)", () => {
    let checked = 0;
    for (const row of ROW_KEYS) {
      expect(rowsFromBody(`Matrix rows: ${row}`), row).toEqual([row]);
      checked++;
    }
    expect(checked).toBe(ROW_KEYS.length);
    expect(checked).toBeGreaterThan(0);
  });
});

describe("stripFences", () => {
  it("removes fenced blocks (and their fence lines), keeps everything else, line for line", () => {
    expect(stripFences("a\n```\nb\n```\nc")).toBe("a\nc");
    expect(stripFences("a\nb")).toBe("a\nb");
    expect(stripFences("")).toBe("");
    expect(stripFences("```\nonly a fence\n```")).toBe("");
  });
});

// W1d T7 -> T8 ruling (c): a PR body is markdown, and GitHub does not render an HTML comment. A declaration inside one is
// invisible to the author and the reviewer, so reading it would be a fail-open: the job would sample rows nobody can see
// declared. (A PR template that carries the usage hint as a comment is the common way to get one into a body.)
describe("HTML comments are not declarations (T7 -> T8 c)", () => {
  it("a declaration inside a comment is ignored — on one line, or across several", () => {
    expect(rowsFromBody("<!-- Matrix rows: league -->")).toBeNull();
    expect(rowsFromBody("<!--\nMatrix rows: all\n-->")).toBeNull();
    expect(rowsFromBody("intro\n<!-- a hint\nMatrix rows: swiss\nmore hint -->\nthanks")).toBeNull();
    expect(rowsFromBody("<!--Matrix rows: all-->")).toBeNull();
  });

  it("the visible declaration after a comment is the one read: a template hint above the author's own line", () => {
    expect(rowsFromBody("<!-- Matrix rows: league, swiss | all | none — <reason> -->\nMatrix rows: knockout")).toEqual(["knockout"]);
    expect(rowsFromBody("<!--\nMatrix rows: all\n-->\n\nMatrix rows: none — copy only")).toEqual([]);
  });

  it("a comment after the value on its own line is no part of the value", () => {
    expect(rowsFromBody("Matrix rows: league <!-- the rows this PR touches -->")).toEqual(["league"]);
    expect(rowsFromBody("Matrix rows: league, swiss<!-- x -->")).toEqual(["league", "swiss"]);
  });

  it("an unterminated comment hides the rest of the body, as the rendering does (a declaration after it is not read)", () => {
    expect(rowsFromBody("fixes a tie-break\n<!-- never closed\nMatrix rows: all")).toBeNull();
    // …but what is BEFORE it is still read.
    expect(rowsFromBody("Matrix rows: swiss\n<!-- never closed")).toEqual(["swiss"]);
  });

  it("two comments are two comments (the first --> ends the first, never the last)", () => {
    expect(rowsFromBody("<!-- one -->\nMatrix rows: league\n<!-- two -->")).toEqual(["league"]);
    expect(rowsFromBody("<!-- one --> <!-- Matrix rows: all -->")).toBeNull();
    // Every comment is removed, not the first alone: a LATER one hides a declaration, and a later one trails a value.
    expect(rowsFromBody("<!-- one -->\n<!--\nMatrix rows: all\n-->")).toBeNull();
    expect(rowsFromBody("<!-- one -->\nMatrix rows: league <!-- two -->")).toEqual(["league"]);
  });

  it("a comment joining no lines: text glued to a comment keeps its own line start (the label must still START its line)", () => {
    expect(rowsFromBody("see <!-- x -->Matrix rows: all")).toBeNull();
    expect(rowsFromBody("<!-- x -->Matrix rows: league")).toEqual(["league"]);
  });

  it("a CRLF body's comments are comments", () => {
    expect(rowsFromBody("<!--\r\nMatrix rows: all\r\n-->\r\nMatrix rows: league\r\n")).toEqual(["league"]);
    expect(rowsFromBody("<!-- Matrix rows: all -->\r\n")).toBeNull();
  });

  it("a comment opener inside a code fence is quoted text, so it hides nothing after the fence (fences first, then comments)", () => {
    expect(rowsFromBody("```\n<!-- Matrix rows: all\n```\nMatrix rows: league")).toEqual(["league"]);
    // …and a quoted comment holding a declaration inside a fence is still not a declaration.
    expect(rowsFromBody("```\n<!-- x -->\nMatrix rows: all\n```")).toBeNull();
  });

  it("an unknown row inside a comment is not refused (it is not read), and one outside still is", () => {
    expect(rowsFromBody("<!-- Matrix rows: leage -->")).toBeNull();
    expect(() => rowsFromBody("<!-- fine -->\nMatrix rows: leage")).toThrow(UnknownRow);
  });

  it("stripComments: removes comments only, leaves everything else line for line", () => {
    expect(stripComments("a\nb")).toBe("a\nb");
    expect(stripComments("")).toBe("");
    expect(stripComments("a <!-- x --> b")).toBe("a  b");
    expect(stripComments("a\n<!--\nx\n-->\nb")).toBe("a\n\nb");
    expect(stripComments("a<!-- open")).toBe("a");
    // Not a comment: no `--` after `<!`, or the opener is cut short.
    expect(stripComments("<! not a comment -->")).toBe("<! not a comment -->");
    expect(stripComments("<!- not -->")).toBe("<!- not -->");
  });

  it("the decision: a PR touching a declaring path whose only declaration is commented out is exit 1 (R27 undeclared), never the rows it hides", () => {
    for (const body of ["<!-- Matrix rows: league -->", "<!--\nMatrix rows: all\n-->", "text <!-- Matrix rows: swiss"]) {
      const d = decide({ body, changed: [ENGINE] });
      expect(d.exit, body).toBe(1);
    }
    // The same body with the comment markers removed IS a declaration: the markers are what matter, not the words.
    expect(decide({ body: "Matrix rows: league", changed: [ENGINE] })).toEqual({ exit: 0, rows: ["league"] });
  });
});

describe("pr-rows decision", () => {
  it("an engine change with no declaration is exit 1, naming the path", () => {
    expect(decide({ body: "fixes a bug", changed: ["packages/engine/src/competition/standings.ts"] })).toEqual({ exit: 1, why: expect.stringContaining("packages/engine/src/competition/standings.ts") });
  });

  it("stages.ts is a declaring path too", () => expect(decide({ body: "", changed: ["apps/web/src/server/usecases/stages.ts"] }).exit).toBe(1));

  it("a UI-only change needs no declaration and samples only the fixed sample", () => expect(decide({ body: "", changed: ["apps/web/src/components/x.tsx"] })).toEqual({ exit: 0, rows: [] }));

  it("the empty change list is refused (vacuous)", () => expect(decide({ body: "Matrix rows: all", changed: [] }).exit).toBe(2));

  it("a change list of blank lines only is the empty list too", () => {
    expect(decide({ body: "Matrix rows: all", changed: ["", "  ", "\r"] }).exit).toBe(2);
  });

  it("the exit-1 refusal names EVERY declaring path (not only the first), tells the author what to write, and says to edit the body and re-run the job", () => {
    const d = decide({ body: "no declaration", changed: [ENGINE, "packages/engine/src/x.ts", STAGES, "apps/web/src/components/x.tsx"] });
    expect(d.exit).toBe(1);
    const why = "why" in d ? d.why : "";
    for (const p of [ENGINE, "packages/engine/src/x.ts", STAGES]) expect(why, p).toContain(p);
    expect(why).not.toContain("components/x.tsx");
    expect(why).toMatch(/Matrix rows:/);
    expect(why).toMatch(/edit the PR body/i);
    expect(why).toMatch(/re-run/i);
    expect(why).toMatch(/R27/);
  });

  it("a declaring path with a declaration is decided: the declared rows, sorted and deduplicated", () => {
    expect(decide({ body: "Matrix rows: swiss, league, swiss", changed: [ENGINE] })).toEqual({ exit: 0, rows: ["league", "swiss"] });
    expect(decide({ body: "Matrix rows: all", changed: [STAGES] })).toEqual({ exit: 0, rows: "all" });
  });

  it("`none — <reason>` on a declaring path is allowed: the sample is the fixed one (R27 asks for a DECLARATION, not for rows)", () => {
    expect(decide({ body: "Matrix rows: none — comment-only change", changed: [ENGINE] })).toEqual({ exit: 0, rows: [] });
  });

  it("a declaration on a PR that touches no declaring path is still honoured (an author may ask for more)", () => {
    expect(decide({ body: "Matrix rows: league", changed: ["apps/web/src/components/x.tsx"] })).toEqual({ exit: 0, rows: ["league"] });
  });

  it("a declaration inside a code fence does not declare (an engine PR quoting the template is undeclared)", () => {
    expect(decide({ body: "```\nMatrix rows: all\n```", changed: [ENGINE] }).exit).toBe(1);
  });

  it("an unknown row is exit 2 (a refusal naming it), on a declaring and on a non-declaring PR alike", () => {
    for (const changed of [[ENGINE], ["apps/web/src/components/x.tsx"]]) {
      const d = decide({ body: "Matrix rows: leage", changed });
      expect(d.exit, changed[0]).toBe(2);
      expect("why" in d ? d.why : "", changed[0]).toMatch(/leage/);
    }
  });

  it("a body with CRLF line ends and a declaring path decides the same as one with LF", () => {
    expect(decide({ body: "Fix\r\nMatrix rows: league\r\n", changed: [ENGINE] })).toEqual(decide({ body: "Fix\nMatrix rows: league\n", changed: [ENGINE] }));
  });

  it("the changed list may carry CRLF endings and blank lines (a Windows runner's git diff): they decide as clean paths", () => {
    expect(decide({ body: "", changed: [`${ENGINE}\r`, "", "apps/web/src/components/x.tsx"] }).exit).toBe(1);
  });
});

describe("DECLARING is R27's two paths, verbatim from _RULES.md", () => {
  const declares = (p: string): boolean => DECLARING.some((re) => re.test(p));

  it("packages/engine/** and apps/web/src/server/usecases/stages.ts declare; nothing near them does", () => {
    for (const p of [ENGINE, "packages/engine/package.json", "packages/engine/src/sport/module.ts", STAGES]) expect(declares(p), p).toBe(true);
    for (const p of [
      "packages/engine-extras/src/a.ts", "packages/engineering/a.ts", "packages/reference/src/a.ts", "apps/engine/src/a.ts", "tools/matrix/run.ts",
      "apps/web/src/server/usecases/stages-extra.ts", "apps/web/src/server/usecases/stages.ts.bak", "apps/web/src/server/usecases/other/stages.ts",
      "apps/web/src/server/stages.ts", "apps/web/src/components/x.tsx", "docs/superpowers/specs/x.md",
      // Anchored at the repo root: the same path inside another tree is no declaring path.
      "vendor/packages/engine/src/a.ts", "x/apps/web/src/server/usecases/stages.ts",
    ]) expect(declares(p), p).toBe(false);
  });

  it("each pattern is earned by a path of its own (so a pattern dropped from the list is seen)", () => {
    expect(DECLARING).toHaveLength(2);
    for (const re of DECLARING) {
      const earns = [ENGINE, STAGES].filter((p) => re.test(p));
      expect(earns, String(re)).toHaveLength(1);
    }
  });
});

// Engine split 2b, Task A2 (plan Review Focus 5): the engine is the registry package @onryde/seazn-engine now, so no PR touches
// packages/engine/** and an engine bump reaches this repo only as a version change in pnpm-lock.yaml. Such a lock diff is an
// engine change for R27 and owes a declaration; a lock diff that leaves the engine's version alone does not.
const LOCK = "pnpm-lock.yaml";
const LOCK_HEAD = "diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml\nindex 1111111..2222222 100644\n--- a/pnpm-lock.yaml\n+++ b/pnpm-lock.yaml\n";
/** `git diff -- pnpm-lock.yaml` for an engine bump `from` -> `to` within one caret range: an importer's version line, the
 *  package entry and its snapshot key move; the specifier is a context line. Shapes copied from the committed lock. */
function engineBump(from: string, to: string): string {
  const peers = "(fast-check@3.23.2)(vitest@4.1.11)(zod@4.4.3)";
  return `${LOCK_HEAD}@@ -25,7 +25,7 @@ importers:\n       '@seazn/engine':\n         specifier: npm:@onryde/seazn-engine@^1.0.0\n`
    + `-        version: '@onryde/seazn-engine@${from}${peers}'\n+        version: '@onryde/seazn-engine@${to}${peers}'\n`
    + `@@ -1233,2 +1233,2 @@ packages:\n-  '@onryde/seazn-engine@${from}':\n-    resolution: {integrity: sha512-aaaa, tarball: https://npm.pkg.github.com/download/@onryde/seazn-engine/${from}/4bed0ef3}\n`
    + `+  '@onryde/seazn-engine@${to}':\n+    resolution: {integrity: sha512-bbbb, tarball: https://npm.pkg.github.com/download/@onryde/seazn-engine/${to}/9c1d2e3f}\n`
    + `@@ -6766,1 +6766,1 @@ snapshots:\n-  '@onryde/seazn-engine@${from}${peers}':\n+  '@onryde/seazn-engine@${to}${peers}':\n`;
}
/** A lock diff that moves zod alone, the engine's lines untouched (one is context). */
const ZOD_ONLY = `${LOCK_HEAD}@@ -5946,2 +5946,2 @@ packages:\n-  zod@4.4.3:\n-    resolution: {integrity: sha512-cccc}\n+  zod@4.4.4:\n+    resolution: {integrity: sha512-dddd}\n`
  + "@@ -6766,3 +6766,3 @@ snapshots:\n   '@onryde/seazn-engine@1.0.0(fast-check@3.23.2)(vitest@4.1.11)(zod@4.4.3)':\n     dependencies:\n-      zod: 4.4.3\n+      zod: 4.4.4\n";
/** The engine's version unchanged; a peer moved, so the lines naming the engine are rewritten with the same engine version. */
const PEER_ONLY = `${LOCK_HEAD}@@ -27,2 +27,2 @@ importers:\n`
  + "-        version: '@onryde/seazn-engine@1.0.0(fast-check@3.23.2)(vitest@4.1.11)(zod@4.4.3)'\n+        version: '@onryde/seazn-engine@1.0.0(fast-check@3.23.2)(vitest@4.1.12)(zod@4.4.3)'\n";
/** This PR's own lock diff: the workspace link leaves and the registry package arrives. */
const ARRIVAL = `${LOCK_HEAD}@@ -25,3 +25,3 @@ importers:\n       '@seazn/engine':\n-        specifier: workspace:*\n-        version: link:packages/engine\n`
  + "+        specifier: npm:@onryde/seazn-engine@^1.0.0\n+        version: '@onryde/seazn-engine@1.0.0(fast-check@3.23.2)(vitest@4.1.11)(zod@4.4.3)'\n";

describe("pr-rows treats an @onryde/seazn-engine version change in pnpm-lock.yaml as engine-touching (engine split 2b, A2; Review Focus 5)", () => {
  const WEB = "apps/web/src/components/x.tsx";

  it("a lock diff moving @onryde/seazn-engine 1.0.0 → 1.1.0 requires declared rows: undeclared is exit 1, naming the lock and both versions", () => {
    const d = decide({ body: "bumps the engine", changed: [LOCK], lockDiff: engineBump("1.0.0", "1.1.0") });
    expect(d.exit).toBe(1);
    const why = "why" in d ? d.why : "";
    expect(why).toMatch(/R27/);
    expect(why).toContain(LOCK);
    expect(why).toContain("1.0.0");
    expect(why).toContain("1.1.0");
    expect(why).toMatch(/edit the PR body/i);
  });

  it("the same bump with a declaration is decided like any engine change (the declared rows, or none with a reason)", () => {
    const lockDiff = engineBump("1.0.0", "1.1.0");
    expect(decide({ body: "Matrix rows: swiss, league", changed: [LOCK, WEB], lockDiff })).toEqual({ exit: 0, rows: ["league", "swiss"] });
    expect(decide({ body: "Matrix rows: none — the bump carries no rule change", changed: [LOCK], lockDiff })).toEqual({ exit: 0, rows: [] });
  });

  it("a lock diff that does not touch the engine does not: a zod-only bump is the fixed sample, undeclared", () => {
    expect(decide({ body: "", changed: [LOCK, WEB], lockDiff: ZOD_ONLY })).toEqual({ exit: 0, rows: [] });
  });

  it("a peer-only re-resolution (the engine's version unchanged on every line that names it) is not an engine change", () => {
    expect(decide({ body: "", changed: [LOCK], lockDiff: PEER_ONLY })).toEqual({ exit: 0, rows: [] });
  });

  it("the engine arriving in the lock (this cutover: a workspace link replaced by the registry package) is engine-touching", () => {
    const d = decide({ body: "", changed: [LOCK], lockDiff: ARRIVAL });
    expect(d.exit).toBe(1);
    expect("why" in d ? d.why : "").toContain(LOCK);
  });

  it("a bump the other way (1.1.0 → 1.0.0, a revert) is an engine change too", () => {
    expect(decide({ body: "", changed: [LOCK], lockDiff: engineBump("1.1.0", "1.0.0") }).exit).toBe(1);
  });

  it("empty case first: an empty lock diff with no lock in the change list decides exactly as before (a web-only PR, a declaring-path PR)", () => {
    expect(decide({ body: "", changed: [WEB], lockDiff: "" })).toEqual({ exit: 0, rows: [] });
    expect(decide({ body: "", changed: [WEB], lockDiff: "" })).toEqual(decide({ body: "", changed: [WEB] }));
    expect(decide({ body: "", changed: [STAGES], lockDiff: "" }).exit).toBe(1);
  });

  it("the lock in the change list with no lock diff given is refused (exit 2): the job dropped --lock-diff-file, and an engine bump would pass undeclared", () => {
    const d = decide({ body: "", changed: [LOCK, WEB] });
    expect(d.exit).toBe(2);
    expect("why" in d ? d.why : "").toMatch(/lock diff/i);
    // a declaration does not paper over the wiring fault
    expect(decide({ body: "Matrix rows: all", changed: [LOCK] }).exit).toBe(2);
  });

  it("the two inputs must agree: lock lines changed but the lock not in the change list, or the lock listed but its diff empty, is refused (exit 2)", () => {
    let checked = 0;
    for (const [what, input] of [
      ["a lock diff, no lock in the list", { body: "", changed: [WEB], lockDiff: engineBump("1.0.0", "1.1.0") }],
      ["the lock in the list, an empty diff", { body: "", changed: [LOCK], lockDiff: "" }],
      ["the lock in the list, a diff of headers only", { body: "", changed: [LOCK], lockDiff: LOCK_HEAD }],
    ] as const) {
      const d = decide(input);
      expect(d.exit, what).toBe(2);
      expect("why" in d ? d.why : "", what).toMatch(/pnpm-lock\.yaml/);
      checked++;
    }
    expect(checked).toBe(3);
  });

  it("a second call decides afresh, and the lock rule is earned by the version change alone (a zod diff of the same file stays undeclared)", () => {
    expect(decide({ body: "", changed: [LOCK], lockDiff: engineBump("1.0.0", "1.1.0") }).exit).toBe(1);
    expect(decide({ body: "", changed: [LOCK], lockDiff: ZOD_ONLY }).exit).toBe(0);
    expect(decide({ body: "", changed: [LOCK], lockDiff: engineBump("1.0.0", "1.1.0") }).exit).toBe(1);
  });
});

// --- the CLI --------------------------------------------------------------------------------------------------

const out: string[] = [];
const err: string[] = [];
const said = (): string => `${out.join("")}${err.join("")}`;
beforeEach(() => {
  out.length = 0;
  err.length = 0;
  vi.spyOn(process.stdout, "write").mockImplementation((s: string | Uint8Array) => { out.push(String(s)); return true; });
  vi.spyOn(process.stderr, "write").mockImplementation((s: string | Uint8Array) => { err.push(String(s)); return true; });
});
afterEach(() => { vi.restoreAllMocks(); });

const tmp = mkdtempSync(join(tmpdir(), "w1d-t7-prrows-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;
/** A body file and a changed-file list, as the job writes them. */
function files(body: string, changed: string): { body: string; changed: string } {
  const dir = join(tmp, `c${++n}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "body.txt"), body);
  writeFileSync(join(dir, "changed.txt"), changed);
  return { body: join(dir, "body.txt"), changed: join(dir, "changed.txt") };
}
const argv = (f: { body: string; changed: string }): string[] => ["--body-file", f.body, "--changed-file", f.changed];

describe("main: --body-file <path> --changed-file <path>", () => {
  it("prints exactly `rows=<csv>` on stdout, nothing on stderr, and exits 0 (the one line $GITHUB_OUTPUT takes)", () => {
    const code = main(argv(files("Matrix rows: swiss, league\n", `${ENGINE}\n`)));
    expect(code).toBe(0);
    expect(out.join("")).toBe("rows=league,swiss\n");
    expect(err.join("")).toBe("");
  });

  it("none, all and the sorted list are the three spellings", () => {
    expect([main(argv(files("", "apps/web/src/components/x.tsx\n"))), out.join("")]).toEqual([0, "rows=none\n"]);
    out.length = 0;
    expect([main(argv(files("Matrix rows: all", `${STAGES}\n`))), out.join("")]).toEqual([0, "rows=all\n"]);
    out.length = 0;
    expect([main(argv(files("Matrix rows: none — copy", `${ENGINE}\n`))), out.join("")]).toEqual([0, "rows=none\n"]);
  });

  it("an undeclared engine change exits 1: stdout is EMPTY (nothing reaches $GITHUB_OUTPUT), stderr names the path and says what to do", () => {
    const code = main(argv(files("fixes a bug", `${ENGINE}\napps/web/src/components/x.tsx\n`)));
    expect(code).toBe(1);
    expect(out.join("")).toBe("");
    expect(err.join("")).toContain(ENGINE);
    expect(err.join("")).toMatch(/edit the PR body/i);
    expect(err.join("")).toMatch(/re-run/i);
  });

  it("an empty body file is an empty body (the job writes `.body // \"\"`), and a PR with no declaring path decides from it", () => {
    expect(main(argv(files("", "docs/x.md\n")))).toBe(0);
    expect(out.join("")).toBe("rows=none\n");
  });

  it.each([
    ["an empty change list", () => files("Matrix rows: all", "")],
    ["a change list of blank lines", () => files("Matrix rows: all", "\n\n  \n")],
  ])("%s exits 2 and prints nothing on stdout (vacuous, never 'no rows')", (_what, make) => {
    expect(main(argv(make()))).toBe(2);
    expect(out.join("")).toBe("");
    expect(err.join("")).toMatch(/no changed file/i);
  });

  it("an unknown row exits 2 naming it and the catalogue, with the refusal's own name", () => {
    expect(main(argv(files("Matrix rows: leage", `${ENGINE}\n`)))).toBe(2);
    expect(out.join("")).toBe("");
    expect(err.join("")).toMatch(/UnknownRow: .*leage.*league/s);
  });

  it("an unreadable file exits 2 naming which one: a missing body, a missing change list, a directory", () => {
    const f = files("Matrix rows: all", `${ENGINE}\n`);
    expect(main(["--body-file", join(tmp, "nope.txt"), "--changed-file", f.changed])).toBe(2);
    expect(err.join("")).toMatch(/--body-file/);
    err.length = 0;
    expect(main(["--body-file", f.body, "--changed-file", join(tmp, "nope.txt")])).toBe(2);
    expect(err.join("")).toMatch(/--changed-file/);
    err.length = 0;
    expect(main(["--body-file", tmp, "--changed-file", f.changed])).toBe(2);
    expect(out.join("")).toBe("");
    expect(err.join("")).toMatch(/--body-file/);
  });

  it.each([
    ["no flags", []],
    ["only --body-file", ["--body-file", "x"]],
    ["only --changed-file", ["--changed-file", "x"]],
    ["an unknown flag", ["--bogus"]],
    ["a positional", ["x"]],
    ["a flag with no value", ["--body-file"]],
  ])("%s is a usage refusal (exit 2, stdout empty, the usage on stderr)", (_what, args) => {
    expect(main(args)).toBe(2);
    expect(out.join("")).toBe("");
    expect(err.join("")).toMatch(/usage: pr-rows\.ts --body-file <path> --changed-file <path>/);
  });

  it("a bare `--` (the one pnpm 10 forwards from `pnpm run <script> -- <flags>`) is dropped, never read as a value or a positional", () => {
    const f = files("Matrix rows: swiss", `${ENGINE}\n`);
    expect(main(["--", ...argv(f)])).toBe(0);
    expect(out.join("")).toBe("rows=swiss\n");
  });

  it("a second call decides afresh (no state carries from the first)", () => {
    expect(main(argv(files("Matrix rows: swiss", `${ENGINE}\n`)))).toBe(0);
    expect(main(argv(files("", `${ENGINE}\n`)))).toBe(1);
    out.length = 0;
    expect(main(argv(files("Matrix rows: league", `${ENGINE}\n`)))).toBe(0);
    expect(out.join("")).toBe("rows=league\n");
  });

  it("a secret-shaped string in a refused declaration is redacted in the log (R14a), never echoed", () => {
    const secret = ["sk", "live", "0123456789abcdefghijklmnop"].join("_");
    expect(main(argv(files(`Matrix rows: ${secret}`, `${ENGINE}\n`)))).toBe(2);
    expect(said()).not.toContain(secret);
    expect(said()).toMatch(/UnknownRow/);
  });
});

describe("main: --lock-diff-file <path> (engine split 2b, A2)", () => {
  /** The three files the job writes, the lock's own diff among them. */
  const withLock = (body: string, changed: string, lockDiff: string): string[] => {
    const f = files(body, changed);
    const lock = join(dirname(f.body), "lock.diff");
    writeFileSync(lock, lockDiff);
    return [...argv(f), "--lock-diff-file", lock];
  };

  it("an undeclared engine bump in the lock exits 1, stdout empty, stderr naming the lock; declared, it prints the rows", () => {
    expect(main(withLock("bumps the engine", `${LOCK}\n`, engineBump("1.0.0", "1.1.0")))).toBe(1);
    expect(out.join("")).toBe("");
    expect(err.join("")).toContain(LOCK);
    err.length = 0;
    expect(main(withLock("Matrix rows: knockout", `${LOCK}\n`, engineBump("1.0.0", "1.1.0")))).toBe(0);
    expect(out.join("")).toBe("rows=knockout\n");
  });

  it("an empty lock diff beside a change list without the lock decides as the two-file call does", () => {
    expect(main(withLock("", "apps/web/src/components/x.tsx\n", ""))).toBe(0);
    expect(out.join("")).toBe("rows=none\n");
  });

  it("the lock in the change list and no --lock-diff-file is exit 2, stdout empty (the wiring fault, never a pass)", () => {
    expect(main(argv(files("", `${LOCK}\n`)))).toBe(2);
    expect(out.join("")).toBe("");
    expect(err.join("")).toMatch(/lock diff/i);
  });

  it("an unreadable --lock-diff-file exits 2 naming the flag", () => {
    const f = files("Matrix rows: all", `${LOCK}\n`);
    expect(main([...argv(f), "--lock-diff-file", join(tmp, "nope.diff")])).toBe(2);
    expect(out.join("")).toBe("");
    // the read refusal, never the usage one (an unknown flag would name it too)
    expect(err.join("")).toMatch(/--lock-diff-file \S+ is unreadable/);
    expect(err.join("")).not.toMatch(/usage:/);
  });
});

describe("isMainModule: importing the CLI runs nothing", () => {
  it("a fresh import of ci/pr-rows.ts writes nothing and sets no exit code — only the file started as a program runs its main", async () => {
    vi.resetModules();
    const before = process.exitCode;
    try {
      const fresh = await import("../ci/pr-rows.ts");
      expect(typeof fresh.main).toBe("function");
      expect(said()).toBe("");
      expect(process.exitCode).toBe(before);
    } finally {
      process.exitCode = before;
    }
  });
});

// One spawn per test: the real program, started as the package script starts it (the crash-exit preload on).
const meter = new SpawnMeter(1);
describe("the real CLI, spawned as its package script runs it", { timeout: meter.budget }, () => {
  beforeEach(() => meter.reset());
  const spawn = (args: readonly string[]) => {
    meter.tick();
    return spawnSync(process.execPath, ["--experimental-strip-types", "--import", "./scripts/lib/crash-exit.ts", "tools/matrix/ci/pr-rows.ts", ...args], { cwd: REPO, encoding: "utf8", timeout: SPAWN_MS, env: { PATH: process.env.PATH ?? "" } });
  };

  it("a decided PR: `rows=…` is the whole of stdout, exit 0", () => {
    const f = files("Matrix rows: knockout, league", `${ENGINE}\n`);
    const r = spawn(argv(f));
    expect({ status: r.status, stdout: r.stdout }).toEqual({ status: 0, stdout: "rows=knockout,league\n" });
    expect(r.stderr).toBe("");
  });

  it("an undeclared engine PR: exit 1 through the preload (a verdict stays 1, never 3), stdout empty", () => {
    const r = spawn(argv(files("", `${ENGINE}\n`)));
    expect({ status: r.status, stdout: r.stdout }).toEqual({ status: 1, stdout: "" });
    expect(r.stderr).toContain(ENGINE);
    expect(r.stderr).not.toContain("crashed");
  });
});

describe("the body the CI job reads is the file the job writes", () => {
  it("reads the file as UTF-8 text, whole (a long body with a late declaration is still read)", () => {
    const long = `${"filler line of prose\n".repeat(5000)}Matrix rows: swiss\n`;
    const f = files(long, `${ENGINE}\n`);
    expect(readFileSync(f.body, "utf8").length).toBeGreaterThan(100_000);
    expect(main(argv(f))).toBe(0);
    expect(out.join("")).toBe("rows=swiss\n");
  });
});
