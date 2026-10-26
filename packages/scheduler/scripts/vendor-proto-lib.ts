// The vendoring logic behind `pnpm --filter @seazn/scheduler vendor:proto <placement checkout>` (engine-split phase 2a, W1).
//
// The placement service lives in its own repo; this package keeps a byte-for-byte copy of its `proto/scheduler.proto` plus a
// pin holding the image tag the web jobs pull. That `imageTag` is the placement commit the copy came from, so a vendoring run
// leaves the CI image no older than the proto the stubs were generated from. The pin is not checked against the placement
// repo afterwards: a contract change is handled by hand, by regenerating both repos.
//
// What this refuses, because each is a way to vendor the WRONG bytes without anything going red:
//   * a path that is not the root of a git checkout (a plain folder, a folder inside a checkout, a repo with no commit);
//   * a checkout with ANY uncommitted change, staged, unstaged or untracked: the pin names a commit, so the copy must be
//     exactly that commit's bytes;
//   * a checkout whose proto is not committed, is empty, or whose working copy is not HEAD's committed bytes even though
//     `status` is clean (assume-unchanged / skip-worktree, or a smudge filter);
//   * THIS repository (the one `pkgRoot` lives in): any of its commits is a monorepo commit, so the image tag would not exist
//     (and a pre-split checkout of it still commits a root proto/scheduler.proto that would otherwise be vendored);
//   * a relative path resolved against the wrong directory (`resolveCheckout`).
// Every refusal happens BEFORE the first write, so a refused run leaves the previous copy and pin exactly as they were.
//
// Runs under `node --experimental-strip-types`: type annotations only, no enums or parameter properties, `.ts` import suffixes.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PKG_ROOT } from "./proto-paths.ts";

export interface VendoredPin {
  imageTag: string;
}

/**
 * Resolve the checkout argument against the directory the developer typed it in. pnpm runs a package script with its cwd
 * set to the PACKAGE, so a bare `process.cwd()` would turn `../seazn.club.placement` into a path relative to
 * packages/scheduler; pnpm (like npm) sets `INIT_CWD` to where the command was actually run. An empty value counts as unset:
 * `path.resolve("", x)` would otherwise fall back to the process cwd, a third base.
 */
export function resolveCheckout(arg: string, initCwd: string | undefined, cwd: string): string {
  return path.resolve(initCwd ? initCwd : cwd, arg);
}

interface GitResult {
  ok: boolean;
  /** Trimmed stdout (empty when git failed). */
  out: string;
  /** Git's own words on one line, for an error message: stderr, or why git could not be run at all. */
  err: string;
}

/** The environment every git call runs in: the caller's, minus the variables that would aim git at some OTHER repository
 *  than the one named by `-C` (an inherited GIT_DIR from a hook or a wrapper), and with optional locks off. `status` would
 *  otherwise refresh (write) the checkout's index: this tool must not touch the clone it reads. */
function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"]) delete env[key];
  return env;
}

/** `git -C <dir> <args>`. `status.showUntrackedFiles=all` is pinned on the command line: a user's `status.showUntrackedFiles=no`
 *  would otherwise make an untracked file read as "clean". */
function git(dir: string, args: string[]): GitResult {
  const r = spawnSync("git", ["-c", "status.showUntrackedFiles=all", "-C", dir, ...args], { encoding: "utf8", env: gitEnv() });
  if (r.error || r.status !== 0) {
    const why = r.error ? r.error.message : r.stderr;
    return { ok: false, out: "", err: why.replace(/\s+/g, " ").trim() };
  }
  return { ok: true, out: r.stdout.trim(), err: "" };
}

/** Two paths name the same place. `.native` asks the OS for the real spelling, so a case variant on a case-insensitive
 *  filesystem (APFS) still compares equal to the path git reports. */
const samePlace = (a: string, b: string): boolean => realpathSync.native(a) === realpathSync.native(b);

/** The repository's common git dir (shared by all its worktrees), absolute; null when `dir` is not inside a repository (or
 *  does not exist yet, as a first import's package directory may not). git prints it relative to `dir` unless it is absolute. */
function commonDirOf(dir: string): string | null {
  const r = git(dir, ["rev-parse", "--git-common-dir"]);
  return r.ok ? path.resolve(dir, r.out) : null;
}

const PROTO_IN_CHECKOUT = "proto/scheduler.proto";

export function vendorProto(opts: { checkout: string; pkgRoot?: string }): VendoredPin {
  const { checkout } = opts;
  const pkgRoot = opts.pkgRoot ?? PKG_ROOT;

  // 1. The path is the ROOT of a work tree (git also answers inside a subfolder, whose HEAD says nothing about that folder).
  const top = git(checkout, ["rev-parse", "--show-toplevel"]);
  if (!top.ok) throw new Error(`not a git checkout: ${checkout} (${top.err})`);
  if (!samePlace(top.out, checkout)) {
    throw new Error(`not a git checkout: ${checkout} (expected the root of a git work tree; git says the root is ${top.out})`);
  }

  // 1b. Not THIS repository. Any monorepo commit is the wrong pin, and a pre-split checkout of it still commits a root
  //     proto/scheduler.proto, so without this a mistaken argument vendors that copy. Worktrees of one repository share a
  //     common dir, so compare that, not the toplevel.
  const common = commonDirOf(checkout);
  const own = commonDirOf(pkgRoot);
  if (common !== null && own !== null && samePlace(common, own)) {
    throw new Error(`is this repository, not the placement checkout: ${checkout} (it holds ${pkgRoot}; pass a checkout of the placement repo)`);
  }

  const head = git(checkout, ["rev-parse", "--verify", "HEAD"]);
  if (!head.ok) throw new Error(`not a git checkout: ${checkout} (the repository has no commit: ${head.err})`);
  if (!/^[0-9a-f]{40}$/.test(head.out)) {
    throw new Error(`not a git checkout: ${checkout} (HEAD is "${head.out}", not a 40-hex sha1 commit id; the image tag needs one)`);
  }

  // 2. Nothing uncommitted, staged or untracked. Gitignored files (the placement venv) are not listed and do not matter.
  const dirty = git(checkout, ["status", "--porcelain"]);
  if (!dirty.ok) throw new Error(`not a git checkout: ${checkout} (git status failed: ${dirty.err})`);
  if (dirty.out !== "") throw new Error(`has uncommitted changes: ${checkout}\n${dirty.out}`);

  // 3. The proto is committed at HEAD, is not empty, and the working copy is exactly those bytes.
  const source = path.join(checkout, PROTO_IN_CHECKOUT);
  const committed = git(checkout, ["rev-parse", "--verify", `HEAD:${PROTO_IN_CHECKOUT}`]);
  if (!committed.ok || !existsSync(source)) throw new Error(`no ${PROTO_IN_CHECKOUT} in ${checkout}`);
  const size = git(checkout, ["cat-file", "-s", committed.out]);
  if (!size.ok) throw new Error(`could not read the size of ${PROTO_IN_CHECKOUT} at HEAD in ${checkout}: ${size.err}`);
  if (size.out === "0") throw new Error(`${PROTO_IN_CHECKOUT} is empty at HEAD in ${checkout}`);
  const onDisk = git(checkout, ["hash-object", "--no-filters", "--", source]);
  if (onDisk.out !== committed.out) {
    throw new Error(`${PROTO_IN_CHECKOUT} is not HEAD's committed bytes in ${checkout} (working copy ${onDisk.out || onDisk.err}, HEAD ${committed.out})`);
  }

  // 4. Only now write, copy first, so a failed run above never leaves half a vendoring behind.
  const destDir = path.join(pkgRoot, "proto");
  const dest = path.join(destDir, "scheduler.proto");
  mkdirSync(destDir, { recursive: true });
  writeFileSync(dest, readFileSync(source));
  const pin: VendoredPin = { imageTag: head.out };
  writeFileSync(path.join(pkgRoot, "VENDORED.json"), `${JSON.stringify(pin, null, 2)}\n`);
  return pin;
}
