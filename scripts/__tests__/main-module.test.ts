// isMainModule (T8 fix round 1, M-2): the entry-script check the matrix CLIs
// and the repo gates share (scripts/lib/main-module.ts). The old idiom
// compared import.meta.url — node resolves the main module's symlinks — with
// argv[1], which it does not, so a CLI started through a symlinked path (or a
// path with a symlinked ancestor, as macOS's /var → /private/var) loaded, did
// nothing and exited 0: a fail-open --check.
// State transitions and the empty case first: no argv[1]; the file itself;
// the file through a symlink; another file; a path that does not exist. (Final
// batch FB-10, the engine boundary gate started through a symlink, left with
// the gate at engine split 2b.)
// The module and this test sit together in scripts/ (CL-R4, review m-3). The
// matrix CLIs started through a symlink are the harness's own test
// (tools/matrix/__tests__/cli-main-module.test.ts): nothing here may reach
// the dev-only tools/ (ruling 56; scripts/__tests__/tools-import-guard.test.ts).
// Single-sport reason: no sport is involved — this is a path check.
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { isMainModule } from "../lib/main-module.ts";

const dir = mkdtempSync(join(tmpdir(), "scripts-main-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

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
  // Final batch FB-10 (the engine boundary gate started through a symlinked path) moved with the gate (engine split 2b E1): it is
  // onryde/seazn.club.engine's test/main-module.test.ts.
});

// engine-split 1d-2 kept a byte-identity pin on the engine's copy of this helper (packages/engine/scripts/lib/main-module.ts), marked
// "remove at 2b": the copy left with the engine, so there is no twin here to be identical to (reverse inventory row 15, D).
