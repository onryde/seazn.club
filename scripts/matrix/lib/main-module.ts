// Is this module the script node was started with? Shared by the matrix CLIs
// (gen-catalogue.ts, render.ts, run.ts, model.ts, single-sport.ts) and the
// repo gates (engine-boundary.ts, reference-boundary.ts). Node resolves
// symlinks in the main module's path before it sets import.meta.url, but
// process.argv[1] keeps the path as typed — so comparing the two as URLs
// misses a CLI started through a symlink or a symlinked ancestor (macOS's
// /var → /private/var), and the CLI loads, runs nothing and exits 0. Compare
// both as real paths instead.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function isMainModule(metaUrl: string, argv1: string | undefined = process.argv[1]): boolean {
  if (argv1 === undefined) return false;
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(argv1);
  } catch {
    return false; // argv[1] names no file (or metaUrl is not a file URL): not us
  }
}
