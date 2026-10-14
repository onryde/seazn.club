// isMainModule (T8 fix round 1, M-2): the entry-script check the matrix CLIs
// and the repo gates share (scripts/lib/main-module.ts). The old idiom
// compared import.meta.url — node resolves the main module's symlinks — with
// argv[1], which it does not, so a CLI started through a symlinked path (or a
// path with a symlinked ancestor, as macOS's /var → /private/var) loaded, did
// nothing and exited 0: a fail-open --check.
// State transitions and the empty case first: no argv[1]; the file itself;
// the file through a symlink; another file; a path that does not exist; and
// (final batch FB-10) the engine boundary gate started through a symlink,
// which used the old idiom until then.
// The module and this test sit together in scripts/ (CL-R4, review m-3). The
// matrix CLIs started through a symlink are the harness's own test
// (tools/matrix/__tests__/cli-main-module.test.ts): nothing here may reach
// the dev-only tools/ (ruling 56; scripts/__tests__/tools-import-guard.test.ts).
// Single-sport reason: no sport is involved — this is a path check.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { isMainModule } from "../lib/main-module.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dir = mkdtempSync(join(tmpdir(), "scripts-main-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// One spawn's cap, and the budget derived from it (AGENTS.md class 20: a flat
// timeout beside a derived cost is a latent red). The harness keeps the same
// pair in tools/matrix/__tests__/spawn-budget.ts, which scripts/ may not import.
const SPAWN_MS = 25_000;
const SLACK_MS = 5_000;

describe("isMainModule — the entry-script check the matrix CLIs and the repo gates share", () => {
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

  it("final batch FB-10: the engine boundary gate (scripts/engine-boundary.ts) started through a symlinked path runs its scan — never a silent 0", () => {
    // It takes no input to refuse: on a clean engine it passes, so the witness
    // is its PASS line (the old idiom loaded, printed nothing and exited 0).
    const via = join(dir, "link-engine-boundary.ts");
    // The gate moved into the engine package (engine-split 1d-2): the title names it package-relative, which is still true there.
    symlinkSync(resolve(REPO, "packages/engine/scripts/engine-boundary.ts"), via);
    const r = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", via], { cwd: REPO, encoding: "utf8", timeout: SPAWN_MS, env: { PATH: process.env.PATH ?? "" } });
    expect(r.stdout, `engine-boundary: no PASS line — main never ran (stderr: ${r.stderr})`).toContain("PASS  engine boundary clean");
    expect(r.status, r.stderr).toBe(0);
  }, SPAWN_MS + SLACK_MS);
});

// engine-split 1d-2: the engine carries its own copy of the helper (packages/engine/scripts/lib/main-module.ts) so its boundary gate holds with
// the engine at a repo root. A copy drifts unless something holds it: this does. It reads an engine path, a reverse read for the 2b inventory;
// it goes at 2b, when the engine leaves this repo and the copy has no twin here to be identical to.
describe("the engine's copy of main-module.ts", () => {
  it("is byte-identical to the root's: a copy by design, so a fix to one must reach the other (remove at 2b)", () => {
    const root = readFileSync(resolve(REPO, "scripts/lib/main-module.ts"));
    const engine = readFileSync(resolve(REPO, "packages/engine/scripts/lib/main-module.ts"));
    // anti-vacuity: two empty files are identical, so the helper itself must be what was compared
    expect(root.length, "the root helper was read").toBeGreaterThan(200);
    expect(root.toString("utf8")).toContain("export function isMainModule");
    expect(engine.equals(root), "packages/engine/scripts/lib/main-module.ts differs from scripts/lib/main-module.ts: copy the root file over it, or the other way round").toBe(true);
  });
});
