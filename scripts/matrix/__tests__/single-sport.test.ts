// R26: the single-sport ratchet. The scanner's grammar (what a pin is, where a
// `// single-sport:` reason counts), its scope, and the CLI's exit codes. Every
// claim about what the CLI does is checked by RUNNING it (pre-flight ruling
// R-h); only the crash mapping is driven in-process, through an injected scan.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { builtinModules } from "@seazn/engine/sports";
import { afterEach, describe, expect, it } from "vitest";
import {
  BASELINE_PATH,
  checkRatchet,
  EmptySportList,
  loadBaseline,
  main,
  NAME_ROOTS,
  pinsIn,
  scanSingleSport,
  SCOPE_DIRS,
  SCOPE_NAME,
  type Pin,
} from "../single-sport.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const CLI = resolve(REPO, "scripts/matrix/single-sport.ts");
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

function cli(args: string[], script = CLI) {
  const r = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", script, ...args], { cwd: REPO, encoding: "utf8", timeout: 25_000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

const baselineOf = (root: string): string => readFileSync(join(root, BASELINE_PATH), "utf8");
const at = (pins: Pin[]) => pins.map((p) => [p.line, p.sport, p.reasoned]);

describe("single-sport scanner (R26)", () => {
  it("premise: the sport keys these fixtures use are registry keys, and the negatives are not", () => {
    expect(REGISTRY.length).toBeGreaterThan(0);
    for (const k of ["generic", "badminton", "tennis", "football", "cricket"]) expect(REGISTRY).toContain(k);
    for (const k of ["padel", "chess"]) expect(REGISTRY).not.toContain(k);
  });

  it("empty case first: a tree with nothing in scope scans zero files — and the CLI, run for real, refuses it with exit 2", () => {
    const root = tree({ "README.md": "x" });
    const r = scanSingleSport(root);
    expect(r.scanned).toBe(0);
    expect(r.pins).toEqual([]);
    expect(Object.values(r.perRoot)).toEqual([...SCOPE_DIRS, ...NAME_ROOTS].map(() => 0));
    for (const args of [["--check"], [], ["--write"], ["--init"]]) {
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
    // and the full tree is accepted (the refusal above is about the dropped root)
    expect(cli(["--root", tree(FULL)]).status).toBe(0);
  });

  it("finds a quoted registry key in each in-scope file, in any quote; out-of-scope files and non-keys are not pins", () => {
    const root = tree({
      "packages/engine/src/scheduling/a.test.ts": `const x = "badminton";\nconst y = 'generic';\nconst z = \`tennis\`;\nconst n = "padel";\nconst m = "generic';\n`,
      "packages/engine/src/competition/__tests__/deep.test.ts": `f("cricket");\n`,
      "packages/engine/src/competition/helper.ts": `f("cricket");\n`, // not a test file
      "packages/engine/src/stats/tiebreak-order.test.ts": `f("football");\n`, // named in, outside the scope dirs
      "packages/engine/src/stats/other.test.ts": `f("football");\n`, // neither
      "apps/web/src/server/usecases/__tests__/stage-progression.test.ts": "sportKey: `tennis`\n",
      "apps/web/src/server/usecases/__tests__/other.test.ts": `const z = "football";\n`,
      "apps/web/src/standings/inner.test.ts": `const z = "football";\n`, // the NAME is the file's, not a directory's
      "apps/web/src/components/standings-table.test.tsx": `const z = "football";\n`, // .test.ts only
      "apps/web/src/node_modules/x/progression.test.ts": `const z = "football";\n`,
      "scripts/standings.test.ts": `const z = "football";\n`, // outside both name roots
    });
    const r = scanSingleSport(root);
    expect(r.scanned).toBe(4);
    expect(r.pins.map((p) => [p.file, p.line, p.sport, p.reasoned])).toEqual([
      ["apps/web/src/server/usecases/__tests__/stage-progression.test.ts", 1, "tennis", false],
      ["packages/engine/src/competition/__tests__/deep.test.ts", 1, "cricket", false],
      ["packages/engine/src/scheduling/a.test.ts", 1, "badminton", false],
      ["packages/engine/src/scheduling/a.test.ts", 2, "generic", false],
      ["packages/engine/src/scheduling/a.test.ts", 3, "tennis", false],
      ["packages/engine/src/stats/tiebreak-order.test.ts", 1, "football", false],
    ]);
    expect(r.perRoot).toEqual({ "packages/engine/src/scheduling": 1, "packages/engine/src/competition": 1, "packages/engine/src": 1, "apps/web/src": 1 });
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

    it("on its own line — the house convention is the test body's first line: the rest of that block, and nothing after it closes", () => {
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

    it("the line directly above a statement (the brief's shape) — and a pin BEFORE the reason stays unreasoned", () => {
      const text = `const x = "badminton";\n// single-sport: bracket shape is sport-free\nconst y = 'generic';\n`;
      expect(at(pinsIn(text, "t.test.ts"))).toEqual([[1, "badminton", false], [3, "generic", true]]);
    });

    it("directly above a test call: that call only — it.each tables included — and the next sibling is unreasoned", () => {
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

    it("an empty reason, a missing colon or a block comment is not a reason", () => {
      const text = [
        `// single-sport:`,
        `f("generic");`,
        `// single-sport:   `,
        `f("generic");`,
        `// single-sport the bracket`,
        `f("generic");`,
        `/* single-sport: block comments do not count */`,
        `f("generic");`,
      ].join("\n");
      expect(at(pinsIn(text, "t.test.ts"))).toEqual([[2, "generic", false], [4, "generic", false], [6, "generic", false], [8, "generic", false]]);
    });

    it("accepts the repo's own `// single-sport:` comments as written (Task 7 M-2 and earlier): every pin in the block they head is reasoned", () => {
      // The block is found here independently of the scanner: the header is the
      // nearest line above the comment indented shallower, and the block ends at
      // the first later line indented no deeper than that header.
      const dir = resolve(REPO, "scripts/matrix/__tests__");
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

  it("a quoted key inside a full-line comment is not a pin", () => {
    expect(pinsIn(`// was "generic" before the sweep\n  // and 'tennis'\nf(1);\n`, "t.test.ts")).toEqual([]);
  });

  it("a file whose code sweeps (forEachSport / sportCases / SPORT_KEYS / builtinModules) is not a pin; one that only NAMES a sweep in a comment still is", () => {
    for (const word of ["forEachSport", "sportCases", "SPORT_KEYS", "builtinModules"]) {
      const root = tree({ "packages/engine/src/competition/b.test.ts": `${word}.length;\nconst k = "generic";\n` });
      expect({ word, pins: scanSingleSport(root).pins }).toEqual({ word, pins: [] });
    }
    const root = tree({ "packages/engine/src/competition/b.test.ts": `// TODO: sweep with forEachSport\nconst k = "generic";\n` });
    expect(scanSingleSport(root).pins.map((p) => p.sport)).toEqual(["generic"]);
  });

  it("the sport list is the registry's (every registry key is found, one file each)", () => {
    const root = tree(Object.fromEntries(REGISTRY.map((s, i) => [`packages/engine/src/scheduling/s${i}.test.ts`, `const k = "${s}";\n`])));
    const r = scanSingleSport(root);
    expect(r.scanned).toBe(REGISTRY.length);
    expect(r.pins.map((p) => p.sport).sort()).toEqual([...REGISTRY].sort());
  });

  it("an empty sport list is refused by name — a pattern over no keys would match every empty string", () => {
    expect(() => pinsIn(`f("");\n`, "t.test.ts", [])).toThrow(EmptySportList);
  });

  it("the ratchet: a new unreasoned pin and a stale baseline entry both fail; an identical set passes; a line move is no change", () => {
    const pin: Pin = { file: "a.test.ts", line: 3, sport: "generic", reasoned: false };
    expect(checkRatchet([pin], [])).toEqual({ added: ["a.test.ts:generic"], stale: [] });
    expect(checkRatchet([], ["a.test.ts:generic"])).toEqual({ added: [], stale: ["a.test.ts:generic"] });
    expect(checkRatchet([pin], ["a.test.ts:generic"])).toEqual({ added: [], stale: [] });
    expect(checkRatchet([{ ...pin, reasoned: true }], [])).toEqual({ added: [], stale: [] });
    expect(checkRatchet([{ ...pin, line: 90 }, { ...pin, line: 91 }], ["a.test.ts:generic"])).toEqual({ added: [], stale: [] });
    // a reasoned pin does not keep a baseline entry alive
    expect(checkRatchet([{ ...pin, reasoned: true }], ["a.test.ts:generic"])).toEqual({ added: [], stale: ["a.test.ts:generic"] });
  });

  it("the ratchet, run for real: --init, a green --check, a new pin fails, --write refuses to add it, a reason clears it, a removed pin is stale, --write removes it", () => {
    const pinned = "packages/engine/src/scheduling/sched.test.ts";
    const root = tree({ ...FULL, [pinned]: `f("generic");\n` });
    const run = (...args: string[]) => cli([...args, "--root", root]);

    // --init writes the first baseline; --check agrees with it; twice is the same answer.
    expect(run("--init").status).toBe(0);
    expect(JSON.parse(baselineOf(root))).toEqual({ schemaVersion: 1, generatedBy: "scripts/matrix/single-sport.ts", unreasoned: [`${pinned}:generic`] });
    expect(run("--check").status).toBe(0);
    const second = run("--check");
    expect(second.status).toBe(0);
    expect(second.stdout).toMatch(/check passed/);

    // A new unreasoned pin: --check exits 1 naming it; --write refuses (2) and leaves the file alone.
    writeFileSync(join(root, pinned), `f("generic");\nf("tennis");\n`);
    const before = baselineOf(root);
    const bad = run("--check");
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain(`new unreasoned single-sport pin ${pinned}:tennis`);
    const refused = run("--write");
    expect(refused.status).toBe(2);
    expect(refused.stderr).toContain(`${pinned}:tennis`);
    expect(baselineOf(root)).toBe(before);

    // A swap keeps the COUNT but still adds a pin: refused too.
    writeFileSync(join(root, pinned), `f("tennis");\n`);
    expect(run("--write").status).toBe(2);
    expect(baselineOf(root)).toBe(before);

    // Adding REASONED single-sport tests is fine: --check green, --write leaves the set alone.
    writeFileSync(join(root, pinned), `f("generic");\n// single-sport: tennis is the pinned example\nf("tennis");\n`);
    expect(run("--check").status).toBe(0);
    expect(run("--write").status).toBe(0);
    expect(baselineOf(root)).toBe(before);

    // The pin goes away: its entry is stale (1), and --write removes it (the ratchet turns down).
    writeFileSync(join(root, pinned), `f(1);\n`);
    const stale = run("--check");
    expect(stale.status).toBe(1);
    expect(stale.stderr).toContain(`stale single-sport baseline entry ${pinned}:generic`);
    expect(run("--write").status).toBe(0);
    expect(JSON.parse(baselineOf(root)).unreasoned).toEqual([]);
    expect(run("--check").status).toBe(0);
  });

  it("--init refuses over an existing baseline; --check and --write refuse a missing or malformed one (the CLI, run for real)", () => {
    const pinned = "packages/engine/src/scheduling/sched.test.ts";
    const root = tree({ ...FULL, [pinned]: `f("tennis");\nf("generic");\n` });
    const run = (...args: string[]) => cli([...args, "--root", root]);
    for (const mode of ["--check", "--write"]) {
      const c = run(mode);
      expect({ mode, status: c.status }).toEqual({ mode, status: 2 });
      expect(c.stderr).toContain(BASELINE_PATH);
    }
    expect(existsSync(join(root, BASELINE_PATH))).toBe(false);
    expect(run("--init").status).toBe(0);
    const first = baselineOf(root);
    // sorted, not in the order the pins were met (tennis came first in the file)
    expect(JSON.parse(first).unreasoned).toEqual([`${pinned}:generic`, `${pinned}:tennis`]);
    const again = run("--init");
    expect(again.status).toBe(2);
    expect(again.stderr).toMatch(/already exists/);
    expect(baselineOf(root)).toBe(first);
    for (const body of ["not json", "{}", `{"schemaVersion":2,"unreasoned":[]}`, `{"schemaVersion":1,"unreasoned":[1]}`]) {
      writeFileSync(join(root, BASELINE_PATH), body);
      for (const mode of ["--check", "--write"]) {
        const c = run(mode);
        expect({ body, mode, status: c.status }).toEqual({ body, mode, status: 2 });
      }
      expect(readFileSync(join(root, BASELINE_PATH), "utf8")).toBe(body);
    }
  });

  it("bad arguments are refused with exit 2; pnpm's pass-through `--` is tolerated (the CLI, run for real)", () => {
    const root = tree(FULL);
    for (const args of [["--bogus"], ["--check", "--write"], ["--write", "--init"], ["--check", "--init"], ["stray"], ["--root"]]) {
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

  it("the committed baseline equals today's repo: every scope root scanned files, --check (run for real) exits 0, and a second scan is identical", () => {
    const r = scanSingleSport(REPO);
    for (const d of [...SCOPE_DIRS, ...NAME_ROOTS]) expect({ d, n: (r.perRoot[d] ?? 0) > 0 }).toEqual({ d, n: true });
    expect(r.scanned).toBeGreaterThan(0);
    expect(checkRatchet(r.pins, loadBaseline(REPO))).toEqual({ added: [], stale: [] });
    expect(scanSingleSport(REPO)).toEqual(r);
    const c = cli(["--check"]);
    expect(c.status).toBe(0);
    expect(c.stdout).toMatch(/check passed/);
    console.info(`single-sport: ${r.scanned} files, ${r.pins.length} pins, ${r.pins.filter((p) => !p.reasoned).length} unreasoned, ${loadBaseline(REPO).length} baseline entries`);
  });

  it("constants: the baseline path, and the name filter reads the file name only", () => {
    expect(BASELINE_PATH).toBe("scripts/matrix/catalogue/single-sport-baseline.json");
    expect(SCOPE_NAME.test("apps/web/src/x/stage-progression.test.ts")).toBe(true);
    expect(SCOPE_NAME.test("apps/web/src/standings/inner.test.ts")).toBe(false);
    expect(SCOPE_NAME.test("apps/web/src/x/standings.test.tsx")).toBe(false);
  });
});
