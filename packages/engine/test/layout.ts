// Where the engine sits inside its git checkout: "packages/engine/" in the monorepo, "" in its own repo (2b).
// A test that reads anything outside the engine package (the workflow, the git ignore file, a sibling package) resolves it from here, so it
// passes with the engine at the repo root OR at packages/engine. Engine-split D23, batch 1d.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
export const ENGINE_DIR = fileURLToPath(new URL("..", import.meta.url));
const git = (...a: string[]) => execFileSync("git", a, { cwd: ENGINE_DIR, encoding: "utf8" }).trim();
export const GIT_TOPLEVEL = git("rev-parse", "--show-toplevel");
export const ENGINE_PREFIX = git("rev-parse", "--show-prefix"); // "packages/engine/" or ""
