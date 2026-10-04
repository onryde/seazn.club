// R26: the single-sport ratchet. The scanner's grammar (what a pin is, what a
// sweep is, where a `// single-sport:` reason counts), its scope, the counted
// ratchet (and --against, --move), and the CLI's exit codes. Every claim about
// what the CLI does is checked by RUNNING it (pre-flight ruling R-h); only the
// crash mapping is driven in-process, through an injected scan.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { builtinModules } from "@seazn/engine/sports";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BASELINE_PATH,
  checkRatchet,
  ceilingIn,
  countsOf,
  EmptySportList,
  loadBaseline,
  main,
  NAME_ROOTS,
  parseBaseline,
  pinsIn,
  raisedAbove,
  RATCHET_SCRIPT,
  Refusal,
  SCANNER_PATH,
  scanSingleSport,
  SCOPE_DIRS,
  SCOPE_NAME,
  type Pin,
} from "../single-sport.ts";
import { SPAWN_MS, SpawnMeter } from "./spawn-budget.ts";
import { spellingsOf } from "../lib/harness-path.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const CLI = resolve(REPO, "tools/matrix/single-sport.ts");
// The expected sport list comes from the engine's registry, not from the
// scanner or the harness catalogue that feeds it.
const REGISTRY = builtinModules.map((m) => m.key);

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

function tree(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "w1b-ss-")));
  roots.push(root);
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), text);
  }
  return root;
}

// One sweep-free file under every scope root, so the CLI has nothing to refuse
// on scope grounds. `competition/standings.test.ts` also counts for the engine
// name root; `stage-progression.test.ts` is the apps/web name root's.
const FULL: Record<string, string> = {
  "packages/engine/src/scheduling/sched.test.ts": "const a = 1;\n",
  "packages/engine/src/competition/standings.test.ts": "const b = 2;\n",
  "apps/web/src/server/usecases/__tests__/stage-progression.test.ts": "const c = 3;\n",
};

// Every test's CLI spawns are counted against the budget its suite declares,
// which derives from the spawn's cap (final batch FB-6, task 11 review M-4).
const meter = new SpawnMeter(11);
beforeEach(() => meter.reset());
function cli(args: string[], script = CLI) {
  meter.tick();
  const r = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", script, ...args], { cwd: REPO, encoding: "utf8", timeout: SPAWN_MS });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function git(root: string, ...args: string[]): void {
  const r = spawnSync("git", ["-C", root, "-c", "user.email=matrix@example.invalid", "-c", "user.name=Matrix", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}
/** Commit everything in `root` as one commit (a fresh repo on the first call). */
function commitAll(root: string, message: string): void {
  if (!existsSync(join(root, ".git"))) git(root, "init", "-q");
  git(root, "add", "-A");
  git(root, "commit", "-q", "--allow-empty", "-m", message);
}

const baselineOf = (root: string): string => readFileSync(join(root, BASELINE_PATH), "utf8");
const pinsOf = (root: string): Record<string, number> => (JSON.parse(baselineOf(root)) as { pins: Record<string, number> }).pins;
function writeBaseline(root: string, pins: Record<string, number>, moves: Record<string, string> = {}): void {
  mkdirSync(dirname(join(root, BASELINE_PATH)), { recursive: true });
  writeFileSync(join(root, BASELINE_PATH), `${JSON.stringify({ schemaVersion: 2, generatedBy: "test", pins, moves }, null, 2)}\n`);
}
const at = (pins: Pin[]) => pins.map((p) => [p.line, p.sport, p.reasoned]);
const live = (pins: Pin[]) => pins.filter((p) => !p.swept).map((p) => p.sport);

describe("single-sport scanner (R26)", { timeout: meter.budget }, () => {
  it("premise: the sport keys these fixtures use are registry keys, and the negatives are not", () => {
    expect(REGISTRY.length).toBeGreaterThan(0);
    for (const k of ["generic", "badminton", "tennis", "football", "cricket", "volleyball", "carrom", "hockey", "icehockey"]) expect(REGISTRY).toContain(k);
    for (const k of ["padel", "chess", "setbased", "index"]) expect(REGISTRY).not.toContain(k);
  });

  it("empty case first: a tree with nothing in scope scans zero files — and the CLI, run for real, refuses it with exit 2 in every mode", () => {
    const root = tree({ "README.md": "x" });
    const r = scanSingleSport(root);
    expect(r.scanned).toBe(0);
    expect(r.pins).toEqual([]);
    expect(Object.values(r.perRoot)).toEqual([...SCOPE_DIRS, ...NAME_ROOTS].map(() => 0));
    for (const args of [["--check"], [], ["--write"], ["--init"], ["--move", "a.test.ts", "b.test.ts"]]) {
      const c = cli([...args, "--root", root]);
      expect({ args, status: c.status }).toEqual({ args, status: 2 });
      expect(c.stderr).toMatch(/ZERO/);
    }
    expect(existsSync(join(root, BASELINE_PATH))).toBe(false);
  });

  it("the CLI refuses zero through a symlinked path too (the main-module check is symlink-safe, never a silent exit 0)", () => {
    const root = tree({ "README.md": "x" });
    const link = join(root, "linked-single-sport.ts");
    symlinkSync(CLI, link);
    const c = cli(["--check", "--root", root], link);
    expect(c.status).toBe(2);
    expect(c.stderr).toMatch(/ZERO/);
  });

  it("one scope root that finds nothing is refused by name even when the others find files (the CLI, run for real)", () => {
    for (const drop of Object.keys(FULL)) {
      const root = tree(Object.fromEntries(Object.entries(FULL).filter(([p]) => p !== drop)));
      const c = cli(["--root", root]);
      expect({ drop, status: c.status }).toEqual({ drop, status: 2 });
      expect(c.stderr).toMatch(/ZERO/);
    }
    expect(cli(["--root", tree(FULL)]).status).toBe(0);
  });

  it("scope: .test.ts AND .test.tsx under the scope dirs and the name roots; the name is the file's; out-of-scope files are not read", () => {
    const root = tree({
      "packages/engine/src/scheduling/a.test.ts": `const x = "badminton";\nconst y = 'generic';\nconst z = \`tennis\`;\nconst n = "padel";\nconst m = "generic';\n`,
      "packages/engine/src/scheduling/b.test.tsx": `const el = <Table sport="hockey" />;\n`,
      "packages/engine/src/competition/__tests__/deep.test.ts": `f("cricket");\n`,
      "packages/engine/src/competition/helper.ts": `f("cricket");\n`, // not a test file
      "packages/engine/src/stats/tiebreak-order.test.ts": `f("football");\n`, // named in, outside the scope dirs
      "packages/engine/src/stats/other.test.ts": `f("football");\n`, // neither
      "apps/web/src/server/usecases/__tests__/stage-progression.test.ts": "sportKey: `tennis`\n",
      "apps/web/src/server/usecases/__tests__/other.test.ts": `const z = "football";\n`,
      "apps/web/src/standings/inner.test.ts": `const z = "football";\n`, // the NAME is the file's, not a directory's
      "apps/web/src/components/standings-table.test.tsx": `const z = render(<T sport="volleyball" />);\n`, // .tsx is in (review I-1)
      "apps/web/src/node_modules/x/progression.test.ts": `const z = "football";\n`,
      "scripts/standings.test.ts": `const z = "football";\n`, // outside both name roots
    });
    const r = scanSingleSport(root);
    expect(r.scanned).toBe(6);
    expect(r.pins.map((p) => [p.file, p.line, p.sport, p.via])).toEqual([
      ["apps/web/src/components/standings-table.test.tsx", 1, "volleyball", "literal"],
      ["apps/web/src/server/usecases/__tests__/stage-progression.test.ts", 1, "tennis", "literal"],
      ["packages/engine/src/competition/__tests__/deep.test.ts", 1, "cricket", "literal"],
      ["packages/engine/src/scheduling/a.test.ts", 1, "badminton", "literal"],
      ["packages/engine/src/scheduling/a.test.ts", 2, "generic", "literal"],
      ["packages/engine/src/scheduling/a.test.ts", 3, "tennis", "literal"],
      ["packages/engine/src/scheduling/b.test.tsx", 1, "hockey", "literal"],
      ["packages/engine/src/stats/tiebreak-order.test.ts", 1, "football", "literal"],
    ]);
    expect(r.perRoot).toEqual({ "packages/engine/src/scheduling": 2, "packages/engine/src/competition": 1, "packages/engine/src": 1, "apps/web/src": 2 });
  });

  it("a key quoted INSIDE a string or template counts (the SQL seeding idiom); a key merely mentioned in one does not", () => {
    const text = [
      "await sql`",
      "  insert into sports (key, name) values ('generic', 'Generic')",
      "  on conflict (key) do nothing`;",
      "await sql`update divisions set sport_key = ${'tennis'} where x = 'cricket'`;",
      `const s = "a 'football' row";`,
      `const t = "payload A: badminton";`,
      "const u = `the ${kind} for volleyball`;",
    ].join("\n");
    expect(pinsIn(text, "t.test.ts").map((p) => [p.line, p.sport])).toEqual([[2, "generic"], [4, "tennis"], [4, "cricket"], [5, "football"]]);
  });

  it("an import of one sport's module is a pin of that sport (review I-3); the registry and other modules are not", () => {
    const text = [
      `import { generic, type GenericCfg } from "../sports/generic/generic.ts";`,
      `import { icehockey } from "../sports/icehockey/index.ts";`,
      `import { badminton } from "../sports/setbased/badminton.ts";`,
      `import type { CricketCfg } from "../../sports/cricket/cricket.ts";`,
      `import { tennis as t, builtinModules } from "@seazn/engine/sports";`,
      `import { football } from "@seazn/engine/sports/football";`,
      `import { registerBuiltins } from "../sports/index.ts";`,
      `import { setbasedShared } from "../sports/setbased/index.ts";`,
      `import type { AnySportModule } from "../sport/module.ts";`,
      `const hockey = await import("../sports/hockey/index.ts");`,
    ].join("\n");
    expect(pinsIn(text, "t.test.ts").map((p) => [p.line, p.sport, p.via])).toEqual([
      [1, "generic", "import"],
      [2, "icehockey", "import"],
      [3, "badminton", "import"],
      [4, "cricket", "import"],
      [5, "tennis", "import"],
      [6, "football", "import"],
      [10, "hockey", "import"],
    ]);
    // a reason directly above an import covers that import, and only it
    const reasoned = pinsIn(`// single-sport: cricket's award alias is the rule under test\nimport { cricket } from "../sports/cricket/cricket.ts";\nimport { tennis } from "../sports/tennis/index.ts";\n`, "t.test.ts");
    expect(at(reasoned)).toEqual([[2, "cricket", true], [3, "tennis", false]]);
  });

  describe("where a `// single-sport:` reason counts", () => {
    it("trailing a code line: that line only", () => {
      const text = [
        `it("a", () => {`,
        `  f("generic"); // single-sport: the bracket shape is sport-free`,
        `  f("badminton");`,
        `});`,
      ].join("\n");
      expect(at(pinsIn(text, "t.test.ts"))).toEqual([[2, "generic", true], [3, "badminton", false]]);
    });

    it("as the first line of a test body — the house convention: that body, and nothing after it closes", () => {
      const text = [
        `describe("d", () => {`,
        `  it("a", () => {`,
        `    // single-sport: badminton declares two kinds, so narrowing to one is observable.`,
        `    const own = kinds("badminton");`,
        ``,
        `    expect(narrow("badminton", {`,
        `      x: "tennis",`,
        `    })).toEqual(own);`,
        `  });`,
        `  it("b", () => {`,
        `    f("generic");`,
        `  });`,
        `});`,
        `f("cricket");`,
      ].join("\n");
      expect(at(pinsIn(text, "t.test.ts"))).toEqual([
        [4, "badminton", true],
        [6, "badminton", true],
        [7, "tennis", true],
        [11, "generic", false],
        [14, "cricket", false],
      ]);
    });

    it("at indent 0 (and on a file's first line): the NEXT statement only, never the rest of the file (review M-1)", () => {
      const brief = `const x = "badminton";\n// single-sport: bracket shape is sport-free\nconst y = 'generic';\n`;
      expect(at(pinsIn(brief, "t.test.ts"))).toEqual([[1, "badminton", false], [3, "generic", true]]);
      const text = [
        `// single-sport: fixture default`,
        `const SPORT = "generic";`,
        `it("a", () => f("badminton"));`,
        ``,
        `it("b", () => {`,
        `  f("cricket");`,
        `});`,
      ].join("\n");
      expect(at(pinsIn(text, "t.test.ts"))).toEqual([[2, "generic", true], [3, "badminton", false], [6, "cricket", false]]);
    });

    it("directly above a test call — even at the top of a describe body: that call only, it.each tables and the closing line included", () => {
      const text = [
        `describe("d", () => {`,
        `  // single-sport: the table is the point`,
        `  it.each([`,
        `    ["generic", 1],`,
        `  ])("row %s", (s, n) => {`,
        `    f("badminton", s, n);`,
        `  });`,
        `  it("next", () => {`,
        `    f("tennis");`,
        `  });`,
        `  // single-sport: one line`,
        `  it("one", () => f("football"));`,
        `  it("two", () => f("cricket"));`,
        `  // single-sport: the closing line belongs to the call`,
        `  it("three", () => {`,
        `    run();`,
        `  }, budgetFor("volleyball"));`,
        `  it("four", () => f("hockey"));`,
        `});`,
      ].join("\n");
      expect(at(pinsIn(text, "t.test.ts"))).toEqual([
        [4, "generic", true],
        [6, "badminton", true],
        [9, "tennis", false],
        [12, "football", true],
        [13, "cricket", false],
        [17, "volleyball", true],
        [18, "hockey", false],
      ]);
    });

    it("a blank line never widens a reason: after it, the reason still covers only the next call; before it, the reason no longer heads the body (review M-1 P2)", () => {
      const gap = [
        `describe("d", () => {`,
        `  it("x", () => {});`,
        `  // single-sport: only the next test`,
        ``,
        `  it("a", () => f("generic"));`,
        `  it("b", () => f("tennis"));`,
        `  it("c", () => f("cricket"));`,
        `});`,
      ].join("\n");
      expect(at(pinsIn(gap, "t.test.ts"))).toEqual([[5, "generic", true], [6, "tennis", false], [7, "cricket", false]]);
      const detached = [
        `it("a", () => {`,
        ``,
        `  // single-sport: not the body's first line any more`,
        `  f("generic");`,
        `  f("tennis");`,
        `});`,
      ].join("\n");
      expect(at(pinsIn(detached, "t.test.ts"))).toEqual([[4, "generic", true], [5, "tennis", false]]);
    });

    it("an empty reason, a missing colon, a block comment, or reason TEXT inside a string or template is not a reason (review M-1 P13)", () => {
      const text = [
        `// single-sport:`,
        `f("generic");`,
        `// single-sport:   `,
        `f("generic");`,
        `// single-sport the bracket`,
        `f("generic");`,
        `/* single-sport: block comments do not count */`,
        `f("generic");`,
        "const doc = `",
        "// single-sport: this is template text, not a comment",
        "`;",
        `f("generic");`,
        `const s = "// single-sport: a string";`,
        `f("generic");`,
      ].join("\n");
      expect(at(pinsIn(text, "t.test.ts"))).toEqual([[2, "generic", false], [4, "generic", false], [6, "generic", false], [8, "generic", false], [12, "generic", false], [14, "generic", false]]);
    });

    it("accepts the repo's own `// single-sport:` comments as written (Task 7 M-2 and earlier): every pin in the block they head is reasoned", () => {
      // The block is found here independently of the scanner: the header is the
      // nearest line above the comment indented shallower, and the block ends at
      // the first later line indented no deeper than that header.
      const dir = resolve(REPO, "tools/matrix/__tests__");
      const indent = (l: string) => l.length - l.trimStart().length;
      let comments = 0;
      let witnessed = 0;
      let checked = 0;
      for (const f of readdirSync(dir).filter((n) => n.endsWith(".test.ts") && n !== "single-sport.test.ts").sort()) {
        const text = readFileSync(join(dir, f), "utf8");
        const lines = text.split("\n");
        const pins = pinsIn(text, f);
        lines.forEach((l, i) => {
          if (!/^\s*\/\/ single-sport: \S/.test(l)) return;
          comments++;
          let h = i - 1;
          while (h >= 0 && (lines[h]!.trim() === "" || indent(lines[h]!) >= indent(l))) h--;
          expect(h, `${f}:${i + 1} has no enclosing block`).toBeGreaterThanOrEqual(0);
          let end = i + 1;
          while (end < lines.length && (lines[end]!.trim() === "" || indent(lines[end]!) > indent(lines[h]!))) end++;
          const inBlock = pins.filter((p) => p.line > i + 1 && p.line <= end);
          if (inBlock.length > 0) witnessed++;
          checked += inBlock.length;
          for (const p of inBlock) expect({ at: `${f}:${p.line}`, reasoned: p.reasoned }).toEqual({ at: `${f}:${p.line}`, reasoned: true });
        });
      }
      console.info(`single-sport grammar: ${comments} existing reasons, ${witnessed} heading pins, ${checked} pins checked`);
      expect(comments).toBeGreaterThan(0);
      expect(witnessed).toBeGreaterThan(0);
      expect(checked).toBeGreaterThan(0);
    });
  });

  it("a quoted key in a comment is not a pin — full-line, trailing, JSDoc or block", () => {
    const text = [`// was "generic" before the sweep`, `  // and 'tennis'`, `f(1); // not "cricket"`, `/** "football" */`, `/* 'hockey' */`, `f(2);`].join("\n");
    expect(pinsIn(text, "t.test.ts")).toEqual([]);
  });

  describe("a sweep is a call shape, scoped to its test block (review I-2)", () => {
    const inTest = (head: string, body = "") => [head, `it("t", () => {`, `  ${body}`, `  expect(render("generic")).toBe(1);`, `});`].join("\n");

    it("a mention is not a sweep: comments, JSDoc, a test title, an unused import, a .find pick, an index, .length — the pin stays", () => {
      const shapes: Array<[string, string, string]> = [
        ["a trailing comment", "", "f(1); // TODO: forEachSport"],
        ["JSDoc", "/** swept with forEachSport over builtinModules */", ""],
        ["a block comment", "", "/* sportCases() */"],
        ["an unused import", `import { forEachSport, sportCases } from "@seazn/engine/testkit";`, ""],
        ["a .find pick", `import { builtinModules } from "@seazn/engine/sports";`, `const m = builtinModules.find((x) => x.key === "x");`],
        ["an index pick", "", "const m = builtinModules[0];"],
        [".length", "", "expect(SPORT_KEYS.length).toBeGreaterThan(0);"],
      ];
      for (const [name, head, body] of shapes) expect({ name, live: live(pinsIn(inTest(head, body), "t.test.ts")) }).toEqual({ name, live: ["generic"] });
      // a test TITLE naming a sweep
      expect(live(pinsIn(`it("uses forEachSport and SPORT_KEYS.map", () => { f("generic"); });`, "t.test.ts"))).toEqual(["generic"]);
      console.info(`single-sport sweeps: ${shapes.length + 1} non-sweep shapes`);
    });

    it("a call or an iteration over the registry IS a sweep: the pins in that test block are exempt", () => {
      const shapes: Array<[string, string]> = [
        ["forEachSport(", "forEachSport((c) => { g(c); });"],
        ["forEachSportAsync(", "void forEachSportAsync(async (c) => { g(c); });"],
        ["for…of sportCases()", "for (const c of sportCases()) g(c);"],
        ["sportCases().map(", "const cs = sportCases().map((c) => c.key);"],
        ["for…of builtinModules", "for (const m of builtinModules) g(m);"],
        ["for…of SPORT_KEYS", "for (const k of SPORT_KEYS) g(k);"],
        ["builtinModules.map(", "const ks = builtinModules.map((m) => m.key);"],
        ["SPORT_KEYS.forEach(", "SPORT_KEYS.forEach(g);"],
        ["[...builtinModules].map(", "const d = [...builtinModules].map((m) => m.supportsDraws);"],
        ["x.SPORT_KEYS.flatMap(", "const f2 = catalogue.SPORT_KEYS.flatMap((k) => [k]);"],
      ];
      for (const [name, body] of shapes) expect({ name, live: live(pinsIn(inTest("", body), "t.test.ts")) }).toEqual({ name, live: [] });
      // it.each over the registry sweeps its own block (the table and the body)
      expect(live(pinsIn(`it.each(SPORT_KEYS)("%s", (k) => { expect(k === "generic").toBeDefined(); });`, "t.test.ts"))).toEqual([]);
      expect(live(pinsIn(`it.each(sportCases())("%s", (c) => { expect(c.key === "generic").toBeDefined(); });`, "t.test.ts"))).toEqual([]);
      console.info(`single-sport sweeps: ${shapes.length + 2} sweep shapes`);
    });

    it("a pick or a predicate over the registry is not a sweep — only a full iteration is (review RR-4): the pin, and every other pin in its test, stays", () => {
      // the review's N1 and N2, in shape: their own key is a pin too
      expect(live(pinsIn(`it("t", () => {\n  const m = builtinModules.filter((x) => x.key === "badminton")[0];\n  expect(f("generic")).toBe(1);\n});`, "t.test.ts"))).toEqual(["badminton", "generic"]);
      expect(live(pinsIn(`it("t", () => {\n  expect(builtinModules.some((m) => m.key === "cricket")).toBe(true);\n  expect(f("generic")).toBe(1);\n});`, "t.test.ts"))).toEqual(["cricket", "generic"]);
      const picks: Array<[string, string]> = [
        [".filter(", "const d = builtinModules.filter((m) => m.supportsDraws);"],
        [".some(", "const any = SPORT_KEYS.some((k) => k.length > 3);"],
        [".every(", "const all = builtinModules.every((m) => m.metrics);"],
        [".reduce(", "const n = SPORT_KEYS.reduce((a) => a + 1, 0);"],
        [".find(", "const m = builtinModules.find((x) => x.variants);"],
        ["a map over a filtered subset", "const k2 = builtinModules.filter((m) => m.variants).map((m) => m.key);"],
        ["for…of a filtered subset", "for (const k of SPORT_KEYS.filter((x) => x.length > 3)) g(k);"],
        ["sportCases() alone", "const cs = sportCases();"],
        ["sportCases().find(", "const c = sportCases().find((x) => x.index === 0);"],
      ];
      for (const [name, body] of picks) expect({ name, live: live(pinsIn(inTest("", body), "t.test.ts")) }).toEqual({ name, live: ["generic"] });
      console.info(`single-sport sweeps: ${picks.length + 2} picks and predicates`);
    });

    it("the exemption is the sweep's own test block: a sibling, a nested test under a sweeping describe, and module level all keep their pins; a pin INSIDE a sweep is exempt anywhere", () => {
      const text = [
        `describe("d", () => {`,
        `  const all = builtinModules.map((m) => m.key);`,
        `  it("sweeps", () => {`,
        `    for (const k of all) g(k);`,
        `    forEachSport((c) => g(c));`,
        `    expect(f("tennis")).toBe(1);`,
        `  });`,
        `  it("sibling", () => {`,
        `    expect(f("generic")).toBe(1);`,
        `  });`,
        `  it("under a describe that maps the registry", () => {`,
        `    expect(f("cricket")).toBe(1);`,
        `  });`,
        `});`,
        `const flags = SPORT_KEYS.map((k) => k !== "football");`,
        `const fixture = "badminton";`,
        // a map over sportCases() sweeps: the pin sits in the map's argument
        `const cased = sportCases().map((c) => c.key === "volleyball");`,
        // a pick is not a sweep, even at module level
        `const subset = SPORT_KEYS.filter((k) => k !== "hockey");`,
      ].join("\n");
      const pins = pinsIn(text, "t.test.ts");
      expect(pins.map((p) => [p.line, p.sport, p.swept])).toEqual([
        [6, "tennis", true],
        [9, "generic", false],
        [12, "cricket", false],
        [15, "football", true],
        [16, "badminton", false],
        [17, "volleyball", true],
        [18, "hockey", false],
      ]);
    });

    it("the real standings-table-locale shape: a describe helper that PICKS one module with .find is not a sweep — its tests' keys are pins", () => {
      const text = [
        `import { builtinModules } from "@seazn/engine/sports";`,
        `describe("every OTHER sport's metric headers", () => {`,
        `  const specsOf = (key: string) => builtinModules.find((m) => m.key === key)!.metrics;`,
        `  const render = (sport: string) => html(specsOf(sport));`,
        `  it("badminton: games won", () => {`,
        `    const out = render("badminton");`,
        `  });`,
        `  it("cricket: no-results", () => {`,
        `    const out = render("cricket");`,
        `  });`,
        `});`,
      ].join("\n");
      expect(pinsIn(text, "standings-table-locale.test.tsx").map((p) => [p.line, p.sport, p.swept])).toEqual([[6, "badminton", false], [9, "cricket", false]]);
    });
  });

  it("the sport list is the registry's (every registry key is found, one file each)", () => {
    const root = tree(Object.fromEntries(REGISTRY.map((s, i) => [`packages/engine/src/scheduling/s${i}.test.ts`, `const k = "${s}";\n`])));
    const r = scanSingleSport(root);
    expect(r.scanned).toBe(REGISTRY.length);
    expect(r.pins.map((p) => p.sport).sort()).toEqual([...REGISTRY].sort());
  });

  it("an empty sport list is refused by name — a scan over no keys would find nothing and pass", () => {
    expect(() => pinsIn(`f("");\n`, "t.test.ts", [])).toThrow(EmptySportList);
  });

  describe("the counted ratchet (review I-4)", () => {
    const pin = (line: number, sport = "generic", o: Partial<Pin> = {}): Pin => ({ file: "a.test.ts", line, sport, via: "literal", reasoned: false, swept: false, ...o });

    it("counts unreasoned pins per file:sport; a line move is no change; reasoned and swept pins do not count", () => {
      expect(countsOf([])).toEqual({});
      expect(countsOf([pin(3), pin(9), pin(4, "tennis"), pin(5, "tennis", { reasoned: true }), pin(6, "cricket", { swept: true })])).toEqual({ "a.test.ts:generic": 2, "a.test.ts:tennis": 1 });
      expect(countsOf([pin(90), pin(91)])).toEqual(countsOf([pin(3), pin(9)]));
    });

    it("checkRatchet: a new key and a risen count fail; a fall (to zero included) is reported, not failed; an identical set is clean", () => {
      expect(checkRatchet({}, {})).toEqual({ added: [], rose: [], lowered: [] });
      expect(checkRatchet({ k: 2 }, {})).toEqual({ added: [{ key: "k", was: 0, now: 2 }], rose: [], lowered: [] });
      expect(checkRatchet({ k: 3 }, { k: 2 })).toEqual({ added: [], rose: [{ key: "k", was: 2, now: 3 }], lowered: [] });
      expect(checkRatchet({ k: 1 }, { k: 2 })).toEqual({ added: [], rose: [], lowered: [{ key: "k", was: 2, now: 1 }] });
      expect(checkRatchet({}, { k: 2 })).toEqual({ added: [], rose: [], lowered: [{ key: "k", was: 2, now: 0 }] });
      expect(checkRatchet({ k: 2 }, { k: 2 })).toEqual({ added: [], rose: [], lowered: [] });
    });

    it("the ceiling at a base follows recorded moves back to the renamed file, and only as far as the base has it", () => {
      const base = { pins: { "old.test.ts:generic": 3, "keep.test.ts:tennis": 1 }, moves: {} };
      expect(ceilingIn(base, {}, "keep.test.ts:tennis")).toBe(1);
      expect(ceilingIn(base, {}, "new.test.ts:generic")).toBe(0);
      expect(ceilingIn(base, { "new.test.ts": "old.test.ts" }, "new.test.ts:generic")).toBe(3);
      expect(ceilingIn(base, { "c.test.ts": "b.test.ts", "b.test.ts": "old.test.ts" }, "c.test.ts:generic")).toBe(3);
      expect(ceilingIn(base, { "a.test.ts": "b.test.ts", "b.test.ts": "a.test.ts" }, "a.test.ts:generic")).toBe(0); // a cycle ends
      const own = { pins: { "new.test.ts:generic": 3, "keep.test.ts:tennis": 2, "fresh.test.ts:cricket": 1 }, moves: { "new.test.ts": "old.test.ts" } };
      expect(raisedAbove(own, base)).toEqual([{ key: "keep.test.ts:tennis", was: 1, now: 2 }, { key: "fresh.test.ts:cricket", was: 0, now: 1 }]);
    });

    it("a baseline that could double-count or mint a ceiling is refused by name", () => {
      const v = (o: object) => JSON.stringify({ schemaVersion: 2, pins: {}, moves: {}, ...o });
      expect(parseBaseline(v({ pins: { "a.test.ts:generic": 2 } }), "x")).toEqual({ pins: { "a.test.ts:generic": 2 }, moves: {} });
      for (const bad of [
        "not json",
        JSON.stringify({ schemaVersion: 1, unreasoned: [] }),
        v({ pins: [] }),
        v({ pins: { "a.test.ts:generic": 0 } }),
        v({ pins: { "a.test.ts:generic": 1.5 } }),
        v({ pins: { "a.test.ts": 1 } }),
        v({ moves: [] }),
        v({ moves: { "b.test.ts": 3 } }),
        v({ moves: { "b.test.ts": "a.test.ts", "c.test.ts": "a.test.ts" } }),
        v({ pins: { "a.test.ts:generic": 1 }, moves: { "b.test.ts": "a.test.ts" } }),
      ]) expect(() => parseBaseline(bad, "x"), bad).toThrow(Refusal);
    });
  });

  it("the ratchet, run for real: --init, a green --check; a risen count and a new sport fail, and --write refuses to record either", () => {
    const pinned = "packages/engine/src/scheduling/sched.test.ts";
    const root = tree({ ...FULL, [pinned]: `f("generic");\nf("generic");\n` });
    const run = (...args: string[]) => cli([...args, "--root", root]);

    expect(run("--init").status).toBe(0);
    expect(JSON.parse(baselineOf(root))).toEqual({ schemaVersion: 2, generatedBy: "tools/matrix/single-sport.ts", pins: { [`${pinned}:generic`]: 2 }, moves: {} });
    const green = run("--check");
    expect(green.status).toBe(0);
    expect(green.stdout).toMatch(/check passed/);

    // One more pin of a baselined sport: the count rose (review I-4a).
    writeFileSync(join(root, pinned), `f("generic");\nf("generic");\nf("generic");\n`);
    const before = baselineOf(root);
    const rose = run("--check");
    expect(rose.status).toBe(1);
    expect(rose.stderr).toContain(`rose ${pinned}:generic (2 → 3)`);
    const refused = run("--write");
    expect(refused.status).toBe(2);
    expect(baselineOf(root)).toBe(before);

    // A new sport, count otherwise equal: a new entry.
    writeFileSync(join(root, pinned), `f("generic");\nf("generic");\nf("tennis");\n`);
    const fresh = run("--check");
    expect(fresh.status).toBe(1);
    expect(fresh.stderr).toContain(`new unreasoned single-sport pin ${pinned}:tennis (0 → 1)`);
    expect(run("--write").status).toBe(2);
    expect(baselineOf(root)).toBe(before);

  });

  it("the ratchet, run for real: a reasoned new pin is fine; a fall FAILS --check until --write records it, down to zero (review RR-1)", () => {
    const pinned = "packages/engine/src/scheduling/sched.test.ts";
    const root = tree({ ...FULL, [pinned]: `f("generic");\nf("generic");\n` });
    const run = (...args: string[]) => cli([...args, "--root", root]);
    expect(run("--init").status).toBe(0);

    // Reasoned single-sport tests are fine.
    writeFileSync(join(root, pinned), `f("generic");\nf("generic");\n// single-sport: tennis is the pinned example\nf("tennis");\n`);
    expect(run("--check").status).toBe(0);

    // A fall fails until --write records it — slack left in the ceiling would
    // let the pins come back later; zero drops the entry.
    writeFileSync(join(root, pinned), `f("generic");\n`);
    const fell = run("--check");
    expect(fell.status).toBe(1);
    expect(fell.stderr).toContain(`${pinned}:generic (2 → 1) fell`);
    expect(fell.stderr).toContain("pnpm matrix:single-sport --write");
    expect(run("--write").status).toBe(0);
    expect(pinsOf(root)).toEqual({ [`${pinned}:generic`]: 1 });
    expect(run("--check").status).toBe(0);
    writeFileSync(join(root, pinned), `f(1);\n`);
    const gone = run("--check");
    expect(gone.status).toBe(1);
    expect(gone.stderr).toContain(`${pinned}:generic (1 → 0) fell`);
    expect(run("--write").status).toBe(0);
    expect(pinsOf(root)).toEqual({});
    expect(run("--check").status).toBe(0);
  });

  it("the review's two-PR probe goes red at PR1: lowering pins without --write fails; with --write the lowered ceiling then catches PR2's re-raise (the CLI, run for real)", () => {
    const pinned = "packages/engine/src/scheduling/sched.test.ts";
    const root = tree({ ...FULL, [pinned]: `f("generic");\nf("generic");\nf("generic");\nf("tennis");\n` });
    const run = (...args: string[]) => cli([...args, "--root", root]);
    expect(run("--init").status).toBe(0);
    commitAll(root, "base");
    // PR1 cuts generic 3 → 1 and drops the only tennis pin, and does not --write
    writeFileSync(join(root, pinned), `f("generic");\n`);
    const pr1 = run("--check", "--against", "HEAD");
    expect(pr1.status).toBe(1);
    expect(pr1.stderr).toContain(`${pinned}:generic (3 → 1) fell`);
    expect(pr1.stderr).toContain(`${pinned}:tennis (1 → 0) fell`);
    // PR1 as it must land: with --write
    expect(run("--write").status).toBe(0);
    expect(run("--check", "--against", "HEAD").status).toBe(0);
    commitAll(root, "PR1");
    // PR2 re-adds what PR1 removed
    writeFileSync(join(root, pinned), `f("generic");\nf("generic");\nf("generic");\nf("tennis");\n`);
    const pr2 = run("--check", "--against", "HEAD");
    expect(pr2.status).toBe(1);
    expect(pr2.stderr).toContain(`rose ${pinned}:generic (1 → 3)`);
    expect(pr2.stderr).toContain(`new unreasoned single-sport pin ${pinned}:tennis (0 → 1)`);
  });

  it("--move transfers a renamed file's entries, and refuses a move that is not a rename (the CLI, run for real)", () => {
    const old = "apps/web/src/server/usecases/__tests__/old-progression.test.ts";
    const moved = "apps/web/src/server/usecases/__tests__/new-progression.test.ts";
    const other = "packages/engine/src/scheduling/other.test.ts";
    const root = tree({ ...FULL, [old]: `f("generic");\nf("generic");\n`, [other]: `f("tennis");\n` });
    const run = (...args: string[]) => cli([...args, "--root", root]);
    expect(run("--init").status).toBe(0);

    // a copy is not a rename: NEW is in scope, but OLD still exists
    writeFileSync(join(root, moved), readFileSync(join(root, old), "utf8"));
    const copy = run("--move", old, moved);
    expect(copy.status).toBe(2);
    expect(copy.stderr).toMatch(/still exists/);
    // the rename completes
    rmSync(join(root, old));
    // the rename alone reads as a new entry
    expect(run("--check").status).toBe(1);
    for (const [from, to, why] of [
      [other.replace("other", "gone"), moved, /no baseline entries/],
      [old, other, /already has baseline entries/],
      [old, "apps/web/src/server/usecases/__tests__/nowhere.test.ts", /not an in-scope test file/],
    ] as const) {
      const c = run("--move", from, to);
      expect({ from, to, status: c.status }).toEqual({ from, to, status: 2 });
      expect(c.stderr).toMatch(why);
    }
    const ok = run("--move", old, moved);
    expect(ok.status).toBe(0);
    expect(JSON.parse(baselineOf(root))).toMatchObject({ pins: { [`${moved}:generic`]: 2, [`${other}:tennis`]: 1 }, moves: { [moved]: old } });
    expect(run("--check").status).toBe(0);
    // --write keeps a live move, so a later --against still maps NEW back to OLD
    expect(run("--write").status).toBe(0);
    expect(JSON.parse(baselineOf(root))).toMatchObject({ moves: { [moved]: old } });
    // moving a second time is refused: OLD has nothing left
    expect(run("--move", old, moved).status).toBe(2);
  });

  it("--against REF: the baseline may not rise above REF's — a hand raise and an rm + --init reset both fail; a fall and a recorded move pass (the CLI, run for real)", () => {
    const pinned = "packages/engine/src/scheduling/sched.test.ts";
    const root = tree({ ...FULL, [pinned]: `f("generic");\n` });
    const run = (...args: string[]) => cli([...args, "--root", root]);
    expect(run("--init").status).toBe(0);
    commitAll(root, "base");
    expect(run("--check", "--against", "HEAD").status).toBe(0);

    // A PR adds a pin AND hand-raises its own baseline to match: its own --check
    // is green, and only the comparison with the base catches it.
    writeFileSync(join(root, pinned), `f("generic");\nf("generic");\n`);
    writeBaseline(root, { [`${pinned}:generic`]: 2 });
    expect(run("--check").status).toBe(0);
    const raised = run("--check", "--against", "HEAD");
    expect(raised.status).toBe(1);
    expect(raised.stderr).toContain(`raises ${pinned}:generic above HEAD's (1 → 2)`);

    // The reset the review found: rm + --init absorbs new pins. Still caught.
    writeFileSync(join(root, pinned), `f("generic");\nf("cricket");\n`);
    rmSync(join(root, BASELINE_PATH));
    expect(run("--init").status).toBe(0);
    expect(run("--check").status).toBe(0);
    const reset = run("--check", "--against", "HEAD");
    expect(reset.status).toBe(1);
    expect(reset.stderr).toContain(`raises ${pinned}:cricket above HEAD's (0 → 1)`);

    // A fall passes against the base too.
    writeFileSync(join(root, pinned), `f(1);\n`);
    writeBaseline(root, {});
    expect(run("--check", "--against", "HEAD").status).toBe(0);
  });

  it("--against REF maps a recorded move back to the base's entry, and refuses an unknown ref, a malformed base, or a non-repo root (the CLI, run for real)", () => {
    const old = "packages/engine/src/scheduling/old.test.ts";
    const moved = "packages/engine/src/scheduling/new.test.ts";
    const root = tree({ ...FULL, [old]: `f("generic");\n` });
    const run = (...args: string[]) => cli([...args, "--root", root]);
    // not a git checkout
    expect(run("--init").status).toBe(0);
    const norepo = run("--check", "--against", "HEAD");
    expect(norepo.status).toBe(2);
    expect(norepo.stderr).toMatch(/git checkout/);
    commitAll(root, "base");

    renameSync(join(root, old), join(root, moved));
    expect(run("--move", old, moved).status).toBe(0);
    expect(run("--check", "--against", "HEAD").status).toBe(0);
    // a hand-made move onto a file the base already had is refused (review RR-2)
    writeBaseline(root, { [`${moved}:generic`]: 1, "packages/engine/src/scheduling/sched.test.ts:tennis": 1 }, { [moved]: old, "packages/engine/src/scheduling/sched.test.ts": "packages/engine/src/scheduling/ghost.test.ts" });
    writeFileSync(join(root, FULL_SCHED), `f("tennis");\n`);
    const handMade = run("--check", "--against", "HEAD");
    expect(handMade.status).toBe(2);
    expect(handMade.stderr).toContain("packages/engine/src/scheduling/sched.test.ts already exists at HEAD");

    for (const ref of ["no-such-ref", "-p", "HEAD~5"]) {
      const c = run("--check", ...(ref.startsWith("-") ? [`--against=${ref}`] : ["--against", ref]));
      expect({ ref, status: c.status }).toEqual({ ref, status: 2 });
    }
    // a base whose baseline is malformed
    writeFileSync(join(root, BASELINE_PATH), "not json");
    commitAll(root, "broken base");
    writeBaseline(root, { [`${moved}:generic`]: 1 }, { [moved]: old });
    writeFileSync(join(root, FULL_SCHED), FULL[FULL_SCHED]!);
    const broken = run("--check", "--against", "HEAD");
    expect(broken.status).toBe(2);
    expect(broken.stderr).toContain(`HEAD:${BASELINE_PATH} does not parse`);
  });

  it("a move --against REF must be a real rename since REF: the review's probes D and D2, each condition alone, an inherited move, and a changed one (the CLI, run for real; review RR-2)", () => {
    const OLD = "packages/engine/src/scheduling/old.test.ts";
    const B = "packages/engine/src/scheduling/b.test.ts";
    const N = "packages/engine/src/scheduling/n.test.ts";
    const R = "packages/engine/src/scheduling/renamed.test.ts";
    const GHOST = "packages/engine/src/scheduling/ghost.test.ts";
    const three = `f("generic");\nf("generic");\nf("generic");\n`;
    const root = tree({ ...FULL, [OLD]: three, [B]: "f(1);\n" });
    const run = (...args: string[]) => cli([...args, "--root", root]);
    const refused = (why: string) => {
      const c = run("--check", "--against", "HEAD");
      expect({ why, status: c.status }).toEqual({ why, status: 2 });
      expect(c.stderr).toContain(why);
    };
    expect(run("--init").status).toBe(0);
    commitAll(root, "base");

    // D: OLD is cleaned but stays; B (already at REF) gains 3 pins and borrows OLD's ceiling
    writeFileSync(join(root, OLD), "f(1);\n");
    writeFileSync(join(root, B), three);
    writeBaseline(root, { [`${B}:generic`]: 3 }, { [B]: OLD });
    refused(`${B} ← ${OLD}`);
    // D2: OLD deleted too — still not a rename, B existed at REF
    rmSync(join(root, OLD));
    refused(`${B} already exists at HEAD`);
    // only "OLD still exists here" fails: NEW is new, OLD was at REF, OLD kept (a copy)
    writeFileSync(join(root, OLD), "f(1);\n");
    writeFileSync(join(root, B), "f(1);\n");
    writeFileSync(join(root, N), three);
    writeBaseline(root, { [`${N}:generic`]: 3 }, { [N]: OLD });
    refused(`${OLD} still exists here`);
    // only "OLD was at REF" fails: a move from a file REF never had
    writeBaseline(root, { [`${N}:generic`]: 3 }, { [N]: GHOST });
    refused(`${GHOST} does not exist at HEAD`);

    // a real rename, committed: its move is then inherited and not re-validated
    rmSync(join(root, N));
    writeFileSync(join(root, OLD), three);
    writeBaseline(root, { [`${OLD}:generic`]: 3 });
    renameSync(join(root, OLD), join(root, R));
    expect(run("--move", OLD, R).status).toBe(0);
    expect(run("--check", "--against", "HEAD").status).toBe(0);
    commitAll(root, "rename");
    expect(run("--check", "--against", "HEAD").status).toBe(0);
    // changing an inherited move's OLD makes it a new move, validated again
    writeBaseline(root, { [`${R}:generic`]: 3 }, { [R]: GHOST });
    refused(`${R} already exists at HEAD`);
  });

  it("--against a base with the scanner but no baseline is refused — a PR cannot move or drop the baseline to take the introducing-PR notice (the CLI, run for real; review RR-3)", () => {
    const root = tree({ ...FULL, "packages/engine/src/scheduling/p.test.ts": `f("generic");\n`, "tools/matrix/single-sport.ts": "// the scanner\n", "tools/matrix/catalogue/old-baseline.json": "{}\n" });
    commitAll(root, "base with the scanner, baseline elsewhere");
    const run = (...args: string[]) => cli([...args, "--root", root]);
    expect(run("--init").status).toBe(0);
    const c = run("--check", "--against", "HEAD");
    expect(c.status).toBe(2);
    expect(c.stderr).toContain(`HEAD has tools/matrix/single-sport.ts but no ${BASELINE_PATH}`);
  });

  it("ruling 56: --against a base from before the move reads the baseline at its historical path — the ceiling still binds there, and a base with only the historical scanner is still refused (the CLI, run for real)", () => {
    // The base is spelled from lib/harness-path.ts's history, the live tree from today's constants:
    // exactly the first PR after the move, whose HEAD^1 still holds the harness at its old path.
    const [, oldBaseline] = spellingsOf(BASELINE_PATH);
    const [, oldScanner] = spellingsOf(SCANNER_PATH);
    expect(oldBaseline).toBeDefined();
    expect(oldBaseline).not.toBe(BASELINE_PATH);
    expect(oldScanner).not.toBe(SCANNER_PATH);
    const pinned = "packages/engine/src/scheduling/sched.test.ts";
    const base = { ...FULL, [pinned]: `f("generic");\n`, [oldScanner!]: "// the scanner, before the move\n", [oldBaseline!]: `${JSON.stringify({ schemaVersion: 2, generatedBy: oldScanner, pins: { [`${pinned}:generic`]: 1 }, moves: {} }, null, 2)}\n` };
    const root = tree(base);
    commitAll(root, "base: the harness at its historical path");
    // The PR moves the harness: the baseline now lives at today's path, same counts.
    const run = (...args: string[]) => cli([...args, "--root", root]);
    rmSync(join(root, oldBaseline!));
    rmSync(join(root, oldScanner!));
    writeBaseline(root, { [`${pinned}:generic`]: 1 });
    const same = run("--check", "--against", "HEAD");
    expect(same.status, same.stderr).toBe(0);
    expect(same.stdout).toContain(`check passed against ${BASELINE_PATH} and HEAD`);
    expect(same.stderr).not.toContain("has no");
    // The historical baseline is a real ceiling, not a pass-through: a raise above it reds.
    writeFileSync(join(root, pinned), `f("generic");\nf("generic");\n`);
    writeBaseline(root, { [`${pinned}:generic`]: 2 });
    expect(run("--check").status).toBe(0);
    const raised = run("--check", "--against", "HEAD");
    expect(raised.status).toBe(1);
    expect(raised.stderr).toContain(`raises ${pinned}:generic above HEAD's (1 → 2)`);

    // A base with the historical scanner and no baseline anywhere is the RR-3 refusal, naming what it found.
    const bare = tree({ ...FULL, [pinned]: `f("generic");\n`, [oldScanner!]: "// the scanner, before the move\n" });
    commitAll(bare, "base: historical scanner, no baseline");
    expect(cli(["--init", "--root", bare]).status).toBe(0);
    const c = cli(["--check", "--against", "HEAD", "--root", bare]);
    expect(c.status).toBe(2);
    expect(c.stderr).toContain(`HEAD has ${oldScanner} but no ${BASELINE_PATH}`);
  });

  it("final batch F-6: the R26 gate's load reaches no UI module — its runtime relative-import closure stays out of apps/ (it read SPORT_KEYS through lib/catalogue.ts, which value-imports a v2 component)", () => {
    /** Every file the module's runtime relative imports reach (`import type` / `export type` are erased). */
    const closure = (entry: string): string[] => {
      const seen = new Set<string>();
      const visit = (file: string): void => {
        if (seen.has(file)) return;
        seen.add(file);
        const text = readFileSync(file, "utf8");
        for (const m of text.matchAll(/^(import|export)(\s+type)?\b[^;]*?\bfrom\s+"(\.{1,2}\/[^"]+)"|^import\s+"(\.{1,2}\/[^"]+)"/gm)) {
          if (m[2] !== undefined) continue;
          visit(resolve(dirname(file), m[3] ?? m[4] ?? ""));
        }
      };
      visit(entry);
      return [...seen].map((f) => relative(REPO, f));
    };
    const gate = closure(CLI);
    expect(gate, "the walker saw the gate's own import").toContain("scripts/lib/main-module.ts");
    expect(gate.filter((f) => f.startsWith("apps/")), "the R26 gate loads a UI module").toEqual([]);
    // The pair: the same walker sees the UI edge where it exists.
    expect(closure(resolve(REPO, "tools/matrix/lib/catalogue.ts")).filter((f) => f.startsWith("apps/")).length).toBeGreaterThan(0);
  });

  it("final batch FB-8: the bootstrap keys on REF's package.json, not on the PR's own constants — a base that RUNS the ratchet (its package.json names the script) with the scanner renamed and the baseline moved is refused (task 11 review RR-3b, G1/G2)", () => {
    // The key is the product's: the real package.json runs the scanner under it.
    const realPkg = JSON.parse(readFileSync(resolve(REPO, "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(realPkg.scripts[RATCHET_SCRIPT]).toBe(`node --experimental-strip-types --import ./scripts/lib/crash-exit.ts ${SCANNER_PATH}`);
    const pkg = (scripts: Record<string, string>) => `${JSON.stringify({ name: "scratch", scripts }, null, 2)}\n`;
    let checked = 0;
    // G1: the scanner file renamed; G2: left in place under a typo'd constant — at REF neither sits at SCANNER_PATH.
    for (const scanner of ["tools/matrix/single-sport-v2.ts", "tools/matrix/single_sport.ts"]) {
      const root = tree({ ...FULL, "packages/engine/src/scheduling/p.test.ts": `f("generic");\n`, [scanner]: "// the scanner\n", "package.json": pkg({ [RATCHET_SCRIPT]: `node --experimental-strip-types ${scanner}` }), "tools/matrix/catalogue/old-baseline.json": "{}\n" });
      commitAll(root, "base that runs the ratchet, baseline elsewhere");
      const run = (...args: string[]) => cli([...args, "--root", root]);
      expect(run("--init").status).toBe(0);
      const c = run("--check", "--against", "HEAD");
      expect({ scanner, status: c.status }).toEqual({ scanner, status: 2 });
      expect(c.stderr, scanner).toContain(`HEAD's package.json runs "${RATCHET_SCRIPT}" but HEAD has no ${BASELINE_PATH}`);
      expect(c.stdout, scanner).not.toContain("::notice::");
      checked++;
    }
    expect(checked).toBe(2);
    // A REF package.json that cannot be read is refused by name, never taken for "no ratchet yet".
    const broken = tree({ ...FULL, "packages/engine/src/scheduling/p.test.ts": `f("generic");\n`, "package.json": "{ not json\n" });
    commitAll(broken, "base with a broken package.json");
    expect(cli(["--init", "--root", broken]).status).toBe(0);
    const b = cli(["--check", "--against", "HEAD", "--root", broken]);
    expect(b.status).toBe(2);
    expect(b.stderr).toContain("HEAD:package.json is not JSON");
    // The pair: a base whose package.json does NOT name the script is the introducing PR — a notice, exit 0.
    const before = tree({ ...FULL, "packages/engine/src/scheduling/p.test.ts": `f("generic");\n`, "package.json": pkg({ build: "tsc" }) });
    commitAll(before, "before the ratchet, with other scripts");
    expect(cli(["--init", "--root", before]).status).toBe(0);
    const intro = cli(["--check", "--against", "HEAD", "--root", before]);
    expect(intro.status, intro.stderr).toBe(0);
    expect(intro.stdout).toMatch(/::notice::.*has no .* yet/);
  });

  it("--against a base with no baseline yet (the introducing PR) passes with a notice; --against applies to --check only (the CLI, run for real)", () => {
    const root = tree({ ...FULL, "packages/engine/src/scheduling/p.test.ts": `f("generic");\n` });
    commitAll(root, "before the ratchet");
    const run = (...args: string[]) => cli([...args, "--root", root]);
    expect(run("--init").status).toBe(0);
    const first = run("--check", "--against", "HEAD");
    expect(first.status).toBe(0);
    expect(first.stdout).toMatch(/::notice::.*has no .* yet/);
    for (const mode of ["--write", "--init", ""]) {
      const c = run(...[mode, "--against", "HEAD"].filter((a) => a !== ""));
      expect({ mode, status: c.status }).toEqual({ mode, status: 2 });
      expect(c.stderr).toMatch(/--against applies to --check only/);
    }
  });

  const MOVE = ["--move", "packages/engine/src/scheduling/gone.test.ts", "packages/engine/src/scheduling/sched.test.ts"];

  it("--init writes sorted counts and refuses over an existing baseline; --check, --write and --move refuse a missing one (the CLI, run for real)", () => {
    const pinned = "packages/engine/src/scheduling/sched.test.ts";
    const root = tree({ ...FULL, [pinned]: `f("tennis");\nf("generic");\nf("tennis");\n` });
    const run = (...args: string[]) => cli([...args, "--root", root]);
    for (const mode of [["--check"], ["--write"], MOVE]) {
      const c = run(...mode);
      expect({ mode, status: c.status }).toEqual({ mode, status: 2 });
      expect(c.stderr).toContain(`no baseline at ${BASELINE_PATH}`);
    }
    expect(existsSync(join(root, BASELINE_PATH))).toBe(false);
    expect(run("--init").status).toBe(0);
    const first = baselineOf(root);
    // sorted keys, counted
    expect(Object.entries(JSON.parse(first).pins as Record<string, number>)).toEqual([[`${pinned}:generic`, 1], [`${pinned}:tennis`, 2]]);
    const again = run("--init");
    expect(again.status).toBe(2);
    expect(again.stderr).toMatch(/already exists/);
    expect(baselineOf(root)).toBe(first);
  });

  it("a malformed baseline is refused by --check, --write and --move, and left as it was (the CLI, run for real)", () => {
    const pinned = "packages/engine/src/scheduling/sched.test.ts";
    const root = tree({ ...FULL, [pinned]: `f("tennis");\n` });
    const run = (...args: string[]) => cli([...args, "--root", root]);
    const bodies = ["not json", "{}", JSON.stringify({ schemaVersion: 1, unreasoned: [] }), JSON.stringify({ schemaVersion: 2, pins: { [`${pinned}:tennis`]: 0 }, moves: {} })];
    for (const [i, body] of bodies.entries()) {
      mkdirSync(dirname(join(root, BASELINE_PATH)), { recursive: true });
      writeFileSync(join(root, BASELINE_PATH), body);
      // every mode on the first body; --check alone on the rest (spawns cost ~0.7 s)
      for (const mode of i === 0 ? [["--check"], ["--write"], MOVE] : [["--check"]]) {
        const c = run(...mode);
        expect({ body, mode, status: c.status }).toEqual({ body, mode, status: 2 });
      }
      expect(readFileSync(join(root, BASELINE_PATH), "utf8")).toBe(body);
    }
  });

  it("bad arguments are refused with exit 2; pnpm's pass-through `--` is tolerated (the CLI, run for real)", () => {
    const root = tree(FULL);
    for (const args of [["--bogus"], ["--check", "--write"], ["--write", "--init"], ["--check", "--move", "a", "b"], ["stray"], ["--move", "a"], ["--move", "a", "b", "c"], ["--root"], ["--check", "--against"]]) {
      const c = cli(args.includes("--root") ? args : [...args, "--root", root]);
      expect({ args, status: c.status }).toEqual({ args, status: 2 });
      expect(c.stderr).toMatch(/usage/);
    }
    expect(cli(["--", "--init", "--root", root]).status).toBe(0);
    expect(cli(["--", "--check", "--root", root]).status).toBe(0);
  });

  it("main maps a scanner crash to exit 3 — never 1, which would read as a ratchet verdict", () => {
    const code = main(["--check"], { scan: () => { throw new TypeError("scanner bug"); } });
    expect(code).toBe(3);
  });

  it("the real tree: the review's named pins are found (a .tsx pick, a .find pick, an engine module import, a SQL seed), and the committed baseline equals today's counts exactly", () => {
    const r = scanSingleSport(REPO);
    for (const d of [...SCOPE_DIRS, ...NAME_ROOTS]) expect({ d, n: (r.perRoot[d] ?? 0) > 0 }).toEqual({ d, n: true });
    const counts = countsOf(r.pins);
    // Witnesses read from the files by hand (review I-1..I-3), not from the scanner.
    for (const key of [
      "packages/engine/src/competition/tiebreak-rule-award-alias.test.ts:cricket",
      "packages/engine/src/competition/tie-what-if.test.ts:carrom",
      "apps/web/src/components/public-site/__tests__/standings-table-locale.test.tsx:badminton",
      "apps/web/src/components/public-site/__tests__/standings-table-view-headers.test.tsx:carrom",
      "apps/web/src/components/v2/__tests__/division-settings-standings-points.test.tsx:tennis",
      "apps/web/src/server/engine-db/__tests__/pooled-standings-null-snapshot.test.ts:generic",
    ]) expect({ key, counted: (counts[key] ?? 0) > 0 }).toEqual({ key, counted: true });
    const committed = loadBaseline(REPO);
    expect(checkRatchet(counts, committed.pins)).toEqual({ added: [], rose: [], lowered: [] });
    expect(scanSingleSport(REPO)).toEqual(r);
    const c = cli(["--check"]);
    expect(c.status).toBe(0);
    expect(c.stdout).toMatch(/check passed/);
    console.info(`single-sport: ${r.scanned} files, ${r.pins.length} pins, ${Object.keys(counts).length} entries`);
  });

  it("constants: the baseline path, and the name filter reads the file name only, .ts and .tsx", () => {
    expect(BASELINE_PATH).toBe("tools/matrix/catalogue/single-sport-baseline.json");
    expect(SCOPE_NAME.test("apps/web/src/x/stage-progression.test.ts")).toBe(true);
    expect(SCOPE_NAME.test("apps/web/src/x/standings.test.tsx")).toBe(true);
    expect(SCOPE_NAME.test("apps/web/src/standings/inner.test.ts")).toBe(false);
    expect(SCOPE_NAME.test("apps/web/src/x/standings.test.jsx")).toBe(false);
  });
});

const FULL_SCHED = "packages/engine/src/scheduling/sched.test.ts";
