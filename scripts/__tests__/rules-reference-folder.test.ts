// The folder adapter of the rules reference checker (scripts/lib/rules-reference.ts `modulesAt`, `readModulesAt`).
//
// The engine's rule table names app files in `enforcedAt` as the engine saw them: `apps/web/src/server/usecases/stages.ts`,
// `schedule.ts`, `registrations.ts`. This repo split each into a folder (src/server/MODULARIZATION.md), and the table is another
// repo's to edit. The adapter lets an `X.ts` that is gone resolve to the folder `X/` that replaced it. These tests pin its edges on
// scratch trees (so they hold whatever the real tree looks like), then pin the three real pre-split names it exists for.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { REPO, fileExists, modulesAt, readModulesAt, readRepoFile } from "../lib/rules-reference.ts";

const roots: string[] = [];
/** A scratch repo root holding exactly `files` (repo-relative path -> text). An empty-string key ending in `/` makes an empty folder. */
function tree(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `rules-reference-folder-${process.pid}-`)));
  roots.push(root);
  for (const [p, text] of Object.entries(files)) {
    if (p.endsWith("/")) mkdirSync(join(root, p), { recursive: true });
    else {
      mkdirSync(dirname(join(root, p)), { recursive: true });
      writeFileSync(join(root, p), text);
    }
  }
  return root;
}
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

describe("a path that became a folder resolves to the folder's modules", () => {
  it("X.ts gone, X/ with an index.ts: the modules, sorted, are what the path stands for (anti-vacuity: how many)", () => {
    const root = tree({
      "src/stages/index.ts": "export * from './b';\n",
      "src/stages/b.ts": "export const inB = 1;\n",
      "src/stages/a.ts": "export const inA = 1;\n",
      "src/stages/Z.ts": "export const inZ = 1;\n",
    });
    const modules = modulesAt(root, "src/stages.ts");
    expect(modules, "the folder was not resolved").toBeDefined();
    // sorted by code unit, not by locale: an upper-case name sorts before every lower-case one
    expect(modules).toEqual(["src/stages/Z.ts", "src/stages/a.ts", "src/stages/b.ts", "src/stages/index.ts"]);
    expect(modules!.length, "modules the path resolved to").toBe(4);
  });

  it("reading concatenates exactly those modules in that order, so a symbol is found in whichever module holds it", () => {
    const root = tree({
      "src/stages/index.ts": "// barrel\n",
      "src/stages/b.ts": "export const inB = 1;\n",
      "src/stages/a.ts": "export const inA = 1;\n",
    });
    const modules = modulesAt(root, "src/stages.ts")!;
    const text = readModulesAt(root, "src/stages.ts");
    // one segment per module, in the module order: the read made exactly the reads the resolution counted
    expect(text).toBe("export const inA = 1;\n\nexport const inB = 1;\n\n// barrel\n");
    expect(text!.split("\n\n").length, "modules read").toBe(modules.length);
    expect(text).toContain("inA");
    expect(text).toContain("inB");
  });

  it("only the folder's own .ts files: a sub-folder, a .tsx and a .md are not modules", () => {
    const root = tree({
      "src/stages/index.ts": "i",
      "src/stages/real.ts": "r",
      "src/stages/view.tsx": "v",
      "src/stages/NOTES.md": "n",
      "src/stages/deep/inner.ts": "d",
    });
    expect(modulesAt(root, "src/stages.ts")).toEqual(["src/stages/index.ts", "src/stages/real.ts"]);
  });
});

describe("the exact path wins, and nothing else resolves", () => {
  it("X.ts and X/ both exist: the file alone, and the folder is never read", () => {
    const root = tree({ "src/stages.ts": "FILE\n", "src/stages/index.ts": "FOLDER\n", "src/stages/a.ts": "FOLDER-A\n" });
    expect(modulesAt(root, "src/stages.ts")).toEqual(["src/stages.ts"]);
    expect(readModulesAt(root, "src/stages.ts")).toBe("FILE\n");
  });

  it("neither X.ts nor X/: undefined, for existence and for reading", () => {
    const root = tree({ "src/other.ts": "x" });
    expect(modulesAt(root, "src/stages.ts")).toBeUndefined();
    expect(readModulesAt(root, "src/stages.ts")).toBeUndefined();
  });

  it("an empty folder, a folder without an index.ts and a folder of non-.ts files are not a module folder", () => {
    const root = tree({ "src/empty/": "", "src/headless/a.ts": "a", "src/docs/index.md": "d" });
    expect(modulesAt(root, "src/empty.ts")).toBeUndefined();
    expect(modulesAt(root, "src/headless.ts")).toBeUndefined();
    expect(modulesAt(root, "src/docs.ts")).toBeUndefined();
    expect(readModulesAt(root, "src/headless.ts")).toBeUndefined();
  });

  it("a plain file where a folder would be (ENOTDIR) is undefined, not a crash", () => {
    const root = tree({ "src/stages": "i am a file" });
    expect(modulesAt(root, "src/stages.ts")).toBeUndefined();
  });

  it("only a .ts path is rewritten: a .tsx or .md path never falls back to a folder of that name", () => {
    const root = tree({ "src/panel/index.ts": "i", "src/guide/index.ts": "i" });
    expect(modulesAt(root, "src/panel.tsx")).toBeUndefined();
    expect(modulesAt(root, "src/guide.md")).toBeUndefined();
    // …and the .ts spelling of the same folders does resolve, so the two refusals above are the rule and not a broken fixture
    expect(modulesAt(root, "src/panel.ts")).toEqual(["src/panel/index.ts"]);
    expect(modulesAt(root, "src/guide.ts")).toEqual(["src/guide/index.ts"]);
  });

  it("a directory asked for by its own name still throws EISDIR on read, the default reader's contract", () => {
    const root = tree({ "rules/a.md": "a" });
    expect(modulesAt(root, "rules")).toEqual(["rules"]);
    expect(() => readModulesAt(root, "rules")).toThrow(/EISDIR/);
  });
});

describe("the three names the engine's table still carries, against the real tree", () => {
  // These are pinned literals, not read from the table: they are the pre-split files this repo no longer has, which is the whole
  // reason the adapter exists. If one is ever restored as a file, the first assertion says so and the pin moves.
  const PRE_SPLIT = [
    { path: "apps/web/src/server/usecases/stages.ts", symbol: "swissGen", other: "previewDivisionFixtures" },
    { path: "apps/web/src/server/usecases/schedule.ts", symbol: "moveFixture", other: "publishSchedule" },
    { path: "apps/web/src/server/usecases/registrations.ts", symbol: "effectiveFeePercentFor", other: "lockRate" },
  ] as const;

  it.each(PRE_SPLIT)("$path is a folder now: it exists through the adapter, and the reader finds symbols that live in different modules", ({ path, symbol, other }) => {
    expect(modulesAt(REPO, path)?.[0], `${path} exists as a file again; this pin is moot`).not.toBe(path);
    expect(fileExists(path)).toBe(true);
    const modules = modulesAt(REPO, path)!;
    expect(modules.length, "modules in the folder").toBeGreaterThan(3);
    expect(modules).toContain(`${path.slice(0, -3)}/index.ts`);
    const text = readRepoFile(path);
    expect(text, `${path} read as undefined`).toBeDefined();
    expect(text).toContain(symbol);
    expect(text).toContain(other);
  });

  // The positive pairs above cannot tell a working adapter from one that says yes to everything. These are the refusals: a name
  // that never existed as a file or a folder, and a real folder's .tsx spelling, are still missing.
  it("a name that never existed is still missing, for existence and for reading, so the adapter does not say yes to everything", () => {
    const never = ["apps/web/src/server/usecases/no-such-usecase.ts", "apps/web/src/server/usecases/stages.tsx", "apps/web/src/server/no-such-dir/stages.ts"];
    expect(never.length, "paths probed").toBe(3);
    for (const p of never) {
      expect(fileExists(p), p).toBe(false);
      expect(readRepoFile(p), p).toBeUndefined();
    }
  });
});
