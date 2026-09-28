// isMainModule (T8 fix round 1, M-2): the entry-script check the three matrix
// CLIs share (gen-catalogue.ts, render.ts, run.ts). The old idiom compared
// import.meta.url — node resolves the main module's symlinks — with argv[1],
// which it does not, so a CLI started through a symlinked path (or a path
// with a symlinked ancestor, as macOS's /var → /private/var) loaded, did
// nothing and exited 0: a fail-open --check.
// State transitions and the empty case first: no argv[1]; the file itself;
// the file through a symlink; another file; a path that does not exist; and
// each real CLI started through a symlink.
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { isMainModule } from "../lib/main-module.ts";
import { REGRESSIONS_PATH } from "../lib/scenario-catalogue.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const dir = mkdtempSync(join(tmpdir(), "w1b-main-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("isMainModule — the entry-script check the matrix CLIs share", () => {
  const real = join(dir, "real.mjs");
  const other = join(dir, "other.mjs");
  const link = join(dir, "link.mjs");
  writeFileSync(real, "");
  writeFileSync(other, "");
  symlinkSync(real, link);
  // What node reports as the main module's import.meta.url: its realpath.
  const metaUrl = pathToFileURL(realpathSync(real)).href;

  it("empty case first: with no argv[1] nothing is the main module", () => {
    expect(isMainModule(metaUrl, undefined)).toBe(false);
  });

  it("the file itself — by its realpath, by a path with a symlinked ancestor, and through a symlink — is the main module", () => {
    expect(isMainModule(metaUrl, realpathSync(real))).toBe(true);
    expect(isMainModule(metaUrl, real)).toBe(true); // tmpdir may itself sit under a symlink (/var → /private/var)
    expect(isMainModule(metaUrl, link)).toBe(true);
  });

  it("another file, and a path that does not exist, are not", () => {
    expect(isMainModule(metaUrl, other)).toBe(false);
    expect(isMainModule(metaUrl, join(dir, "missing.mjs"))).toBe(false);
  });

  // Each CLI through a symlink, with an input it must refuse: before the fix
  // each loaded, ran nothing and exited 0 with empty stderr.
  const empty = join(dir, "empty-root");
  mkdirSync(join(empty, "scripts/matrix/catalogue"), { recursive: true });
  cpSync(resolve(REPO, REGRESSIONS_PATH), join(empty, REGRESSIONS_PATH));
  const CLIS: readonly (readonly [string, string, readonly string[], number])[] = [
    ["gen-catalogue.ts", "--check on an empty catalogue: drift", ["--check", "--root", empty], 1],
    ["render.ts", "no results file: usage", [], 2],
    ["run.ts", "--bogus: usage, refused before any DB or HTTP", ["--bogus"], 2],
  ];
  it.each(CLIS)("%s (%s) started through a symlinked path runs its main and exits %i — never a silent 0", (name, _why, args, code) => {
    const via = join(dir, `link-${name}`);
    symlinkSync(resolve(REPO, "scripts/matrix", name), via);
    const r = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", via, ...args], { cwd: REPO, encoding: "utf8", timeout: 60_000, env: { PATH: process.env.PATH ?? "" } });
    expect(r.stderr.trim(), `${name}: nothing on stderr — main never ran`).not.toBe("");
    expect(r.status, r.stderr).toBe(code);
  });
});
