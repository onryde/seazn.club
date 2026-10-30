// Engine-split 2b Task R1 — the recorded corpora and the bye-deltas fixture, handed to a consumer through @seazn/engine/testkit.
//
// Expected values here come from the disk (a fresh recursive listing of src/sports) and from the engine's own declarations
// (builtinModules, SPORT_DIRS), never from the module under test. The installed-tarball half (the same reader, from dist/) is
// pack-proof/node/corpora.mjs, run by `pnpm pack:proof --only node`.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { builtinModules } from "../sports/index.ts";
import * as barrel from "./index.ts";
import { byeDeltas, goldenCorpora, readGoldenCorpora } from "./corpora.ts";
import { SPORT_DIRS } from "./golden.ts";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SPORTS = join(SRC, "sports");
/** A fresh listing, written without the module under test: every `*.golden.json` under src/sports, by path. */
const onDisk = (): string[] =>
  (readdirSync(SPORTS, { recursive: true }) as string[]).filter((f) => f.endsWith(".golden.json")).sort();

describe("goldenCorpora", () => {
  it("returns every corpus on disk, in path order, each equal to its file", () => {
    const files = onDisk();
    const corpora = goldenCorpora();
    expect(files.length, "corpora on disk (anti-vacuity)").toBeGreaterThan(0);
    expect(corpora).toHaveLength(files.length);
    for (const [i, file] of files.entries()) {
      expect(corpora[i]!.corpus, file).toEqual(JSON.parse(readFileSync(join(SPORTS, file), "utf8")));
    }
  });

  it("names each corpus by its sports/ directory and its module key, and that key is the corpus's own", () => {
    const corpora = goldenCorpora();
    for (const c of corpora) {
      expect(`${c.sport}/${c.key}.golden.json`, c.key).toBe(onDisk()[corpora.indexOf(c)]);
      expect((c.corpus as { key: string }).key, `${c.key}: the file name and the corpus's own key agree`).toBe(c.key);
    }
    expect(corpora.length).toBeGreaterThan(0);
  });

  it("holds exactly one corpus per shipped module, in the directory the engine registers for it (every sport, none extra)", () => {
    const corpora = goldenCorpora();
    const shipped = builtinModules.map((m) => m.key).sort();
    expect(shipped.length, "shipped modules (anti-vacuity)").toBeGreaterThan(5);
    expect(corpora.map((c) => c.key).sort()).toEqual(shipped);
    for (const c of corpora) expect(c.sport, `${c.key}'s directory`).toBe(SPORT_DIRS[c.key]);
  });

  it("reads the disk on each call: a caller that edits what it got does not change the next call's", () => {
    const first = goldenCorpora();
    (first[0]!.corpus as { key: string }).key = "edited";
    expect((goldenCorpora()[0]!.corpus as { key: string }).key).not.toBe("edited");
  });
});

describe("byeDeltas", () => {
  it("equals the fixture file", () => {
    const fixture = JSON.parse(readFileSync(join(SRC, "sport/__fixtures__/bye-deltas.json"), "utf8")) as Record<string, unknown>;
    expect(Object.keys(fixture).length, "fixture sports (anti-vacuity)").toBeGreaterThan(0);
    expect(byeDeltas()).toEqual(fixture);
  });

  it("pins a bye delta for every shipped module", () => {
    const pinned = Object.keys(byeDeltas() as Record<string, unknown>).sort();
    expect(pinned).toEqual(builtinModules.map((m) => m.key).sort());
  });
});

describe("the testkit barrel", () => {
  it("hands a consumer exactly the two readers, not the directory walker behind them", () => {
    expect(barrel.goldenCorpora).toBe(goldenCorpora);
    expect(barrel.byeDeltas).toBe(byeDeltas);
    expect((barrel as Record<string, unknown>).readGoldenCorpora, "the internal walker stays internal").toBeUndefined();
    expect(goldenCorpora().length).toBeGreaterThan(0);
  });
});

describe("readGoldenCorpora (the walker, on scratch trees)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const tree = (files: Record<string, string>): string => {
    const dir = mkdtempSync(join(tmpdir(), "engine-corpora-"));
    dirs.push(dir);
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      writeFileSync(join(dir, rel), text);
    }
    return dir;
  };
  const corpus = (key: string) => JSON.stringify({ key, streams: [] });

  it("walks sub-directories, takes only *.golden.json, and orders by path whatever order the walk finds them in", () => {
    // The recursive listing is breadth-first (a/q, a/y, a/z, b/x, THEN a/deep/p), so a sort-less reader answers a/q, a/y, a/z, b/x, a/deep/p
    // on any filesystem; path order puts a/deep/p first. The sport of a/deep/p is its first directory, `a`, not the one it sits in.
    const dir = tree({
      "b/x.golden.json": corpus("x"),
      "a/z.golden.json": corpus("z"),
      "a/y.golden.json": corpus("y"),
      "a/q.golden.json": corpus("q"),
      "a/deep/p.golden.json": corpus("p"),
      "a/notes.json": "{}",
      "a/y.golden.json.bak": "{}",
      "a/DOMAIN.md": "# not a corpus",
    });
    const got = readGoldenCorpora(dir);
    expect(got.map((c) => `${c.sport}/${c.key}`)).toEqual(["a/p", "a/q", "a/y", "a/z", "b/x"]);
    expect(got.map((c) => (c.corpus as { key: string }).key)).toEqual(["p", "q", "y", "z", "x"]);
  });

  it("refuses a tree with no corpus: a sweep over nothing would pass for the wrong reason", () => {
    expect(() => readGoldenCorpora(tree({ "a/notes.json": "{}" }))).toThrow(/no \*\.golden\.json corpus under/);
    expect(() => readGoldenCorpora(tree({}))).toThrow(/no \*\.golden\.json corpus under/);
  });

  it("refuses a corpus whose own key is not its file name's", () => {
    expect(() => readGoldenCorpora(tree({ "a/y.golden.json": corpus("not-y") }))).toThrow(/a\/y\.golden\.json.*"not-y".*"y"/);
  });

  it("refuses a corpus that is not a JSON object with a key", () => {
    expect(() => readGoldenCorpora(tree({ "a/y.golden.json": "[]" }))).toThrow(/a\/y\.golden\.json/);
    expect(() => readGoldenCorpora(tree({ "a/y.golden.json": "null" }))).toThrow(/a\/y\.golden\.json/);
  });

  it("refuses a corpus file sitting directly under the sports directory (no sport to name it by)", () => {
    expect(() => readGoldenCorpora(tree({ "y.golden.json": corpus("y") }))).toThrow(/y\.golden\.json.*sport directory/);
  });
});
