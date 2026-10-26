// `vendorProto` is how the scheduler's copy of the placement service's proto gets into this repo, and the pin it writes is
// what the CI image reference and the stub drift gate hang off (engine-split phase 2a, Task W1). The failure it exists to
// prevent is VENDORING THE WRONG BYTES, silently: a placement checkout with an unpushed edit, a path that is not a checkout
// at all (or only a folder inside one), or a relative path that pnpm resolved against packages/scheduler instead of the
// directory the developer typed it in.
//
// Every case builds a REAL git repository in a temp dir and a temp `pkgRoot`, so nothing here touches the real
// packages/scheduler/proto or VENDORED.json (test/vendored-proto.test.ts reads those). Expected values come from git itself
// (`rev-parse HEAD`) and node:crypto, never from the code under test.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { resolveCheckout, sha256Of, vendorProto, type VendoredPin } from "../scripts/vendor-proto-lib.ts";

const PACKAGE = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const SCRATCH = mkdtempSync(join(tmpdir(), "vendor-proto-"));
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));
let counter = 0;
const fresh = (label: string): string => {
  const dir = join(SCRATCH, `${String(++counter)}-${label}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};

/** A git invocation in `cwd` with the user's global config out of the way (signing, autocrlf, hooks). */
function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", ...args],
    { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } },
  ).trim();
}
const head = (repo: string): string => git(repo, "rev-parse", "HEAD");
const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

/** The proto bytes: CRLF, a non-UTF-8 byte and no trailing newline, so a text round trip (utf8 decode/encode, newline
 *  normalisation, a trailing-newline fix) cannot reproduce them. */
const PROTO_V1 = Buffer.concat([Buffer.from('syntax = "proto3";\r\n// caf'), Buffer.from([0xe9, 0xff]), Buffer.from("\r\nmessage A {}")]);
const PROTO_V2 = Buffer.concat([PROTO_V1, Buffer.from("\r\nmessage B {}")]);

/** A committed "placement checkout": proto/scheduler.proto plus an unrelated tracked file. */
function placementRepo(proto: Buffer | null = PROTO_V1): string {
  const repo = fresh("placement");
  git(repo, "init", "-q");
  writeFileSync(join(repo, "README.md"), "placement\n");
  if (proto) {
    mkdirSync(join(repo, "proto"));
    writeFileSync(join(repo, "proto/scheduler.proto"), proto);
  }
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  return repo;
}
/** A throwaway `pkgRoot` (the package directory the copy and the pin are written into). */
const pkgRootDir = (): string => fresh("pkg");

const copyOf = (pkg: string): Buffer => readFileSync(join(pkg, "proto/scheduler.proto"));
const pinText = (pkg: string): string => readFileSync(join(pkg, "VENDORED.json"), "utf8");

describe("sha256Of", () => {
  it("is the lowercase hex sha256 of the file's bytes (NIST vector for 'abc', and a non-UTF-8 file)", () => {
    const dir = fresh("sha");
    writeFileSync(join(dir, "abc"), "abc");
    expect(sha256Of(join(dir, "abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    writeFileSync(join(dir, "raw"), PROTO_V1);
    expect(sha256Of(join(dir, "raw"))).toBe(sha256(PROTO_V1));
  });
});

describe("vendorProto", () => {
  it("writes the copy and the pin", () => {
    const repo = placementRepo();
    const pkg = pkgRootDir();
    const pin = vendorProto({ checkout: repo, pkgRoot: pkg });

    expect(copyOf(pkg).equals(PROTO_V1), "the copy is the source byte for byte").toBe(true);
    const want = { placementCommit: head(repo), sha256: sha256(PROTO_V1), imageTag: head(repo) };
    expect(pin).toEqual(want);
    const onDisk = JSON.parse(pinText(pkg)) as Record<string, string>;
    expect(onDisk).toEqual(want);
    expect(Object.keys(onDisk), "exactly these keys, in this order").toEqual(["placementCommit", "sha256", "imageTag"]);
    expect(head(repo)).toMatch(/^[0-9a-f]{40}$/);
    expect(pinText(pkg), "2-space JSON with a trailing newline").toBe(`${JSON.stringify(want, null, 2)}\n`);
  });

  it("writes nothing else into the package", () => {
    const pkg = pkgRootDir();
    vendorProto({ checkout: placementRepo(), pkgRoot: pkg });
    expect(readdirSync(pkg).sort()).toEqual(["VENDORED.json", "proto"]);
    expect(readdirSync(join(pkg, "proto"))).toEqual(["scheduler.proto"]);
  });

  it("is idempotent: a second call leaves both files byte-identical", () => {
    const repo = placementRepo();
    const pkg = pkgRootDir();
    const first = vendorProto({ checkout: repo, pkgRoot: pkg });
    const proto1 = copyOf(pkg);
    const pin1 = pinText(pkg);
    const second = vendorProto({ checkout: repo, pkgRoot: pkg });
    expect(second).toEqual(first);
    expect(copyOf(pkg).equals(proto1)).toBe(true);
    expect(pinText(pkg)).toBe(pin1);
  });

  it("follows a new commit: the copy, both commit fields and the sha all move", () => {
    const repo = placementRepo();
    const pkg = pkgRootDir();
    const before = vendorProto({ checkout: repo, pkgRoot: pkg });
    writeFileSync(join(repo, "proto/scheduler.proto"), PROTO_V2);
    git(repo, "commit", "-q", "-am", "additive change");
    const after = vendorProto({ checkout: repo, pkgRoot: pkg });

    expect(after.placementCommit).toBe(head(repo));
    expect(after.imageTag, "the image can never be older than the proto").toBe(head(repo));
    expect(after.placementCommit).not.toBe(before.placementCommit);
    expect(after.sha256).toBe(sha256(PROTO_V2));
    expect(after.sha256).not.toBe(before.sha256);
    expect(copyOf(pkg).equals(PROTO_V2)).toBe(true);
    expect(JSON.parse(pinText(pkg))).toEqual(after);
  });

  it("follows a commit that does not touch the proto: the commit fields move, the sha does not", () => {
    // The image tag is the placement COMMIT, not the proto's last change, so a Python-only commit still moves the pin.
    const repo = placementRepo();
    const pkg = pkgRootDir();
    const before = vendorProto({ checkout: repo, pkgRoot: pkg });
    writeFileSync(join(repo, "README.md"), "placement, edited\n");
    git(repo, "commit", "-q", "-am", "python only");
    const after = vendorProto({ checkout: repo, pkgRoot: pkg });
    expect(after.placementCommit).toBe(head(repo));
    expect(after.imageTag).toBe(head(repo));
    expect(after.placementCommit).not.toBe(before.placementCommit);
    expect(after.sha256).toBe(before.sha256);
  });

  describe("refuses a dirty checkout, and writes nothing (the old pin survives)", () => {
    const DIRTY: [label: string, dirty: (repo: string) => void][] = [
      ["an unstaged edit to an unrelated tracked file", (repo) => writeFileSync(join(repo, "README.md"), "edited\n")],
      ["an unstaged edit to the proto itself", (repo) => writeFileSync(join(repo, "proto/scheduler.proto"), PROTO_V2)],
      [
        "a staged but uncommitted edit to the proto",
        (repo) => {
          writeFileSync(join(repo, "proto/scheduler.proto"), PROTO_V2);
          git(repo, "add", "proto/scheduler.proto");
        },
      ],
      ["an untracked file", (repo) => writeFileSync(join(repo, "scratch.txt"), "x\n")],
    ];
    it.each(DIRTY)("%s", (_label, dirty) => {
      const repo = placementRepo();
      const pkg = pkgRootDir();
      vendorProto({ checkout: repo, pkgRoot: pkg });
      const proto = copyOf(pkg);
      const pin = pinText(pkg);

      dirty(repo);
      expect(git(repo, "status", "--porcelain"), "the fixture really is dirty").not.toBe("");
      expect(() => vendorProto({ checkout: repo, pkgRoot: pkg })).toThrow(/^has uncommitted changes: /);

      expect(copyOf(pkg).equals(proto), "the old copy survives").toBe(true);
      expect(pinText(pkg), "the old pin survives").toBe(pin);
    });

    it("on a first import there is no copy and no pin afterwards", () => {
      const repo = placementRepo();
      writeFileSync(join(repo, "README.md"), "edited\n");
      const pkg = pkgRootDir();
      expect(() => vendorProto({ checkout: repo, pkgRoot: pkg })).toThrow(/has uncommitted changes/);
      expect(readdirSync(pkg), "nothing was created").toEqual([]);
    });

    it("names the checkout it refused", () => {
      const repo = placementRepo();
      writeFileSync(join(repo, "README.md"), "edited\n");
      expect(() => vendorProto({ checkout: repo, pkgRoot: pkgRootDir() })).toThrow(repo);
    });
  });

  describe("refuses a path that is not a git checkout", () => {
    it("a plain directory (and the message carries git's own words, not a guess)", () => {
      const dir = fresh("plain");
      mkdirSync(join(dir, "proto"));
      writeFileSync(join(dir, "proto/scheduler.proto"), PROTO_V1);
      const pkg = pkgRootDir();
      expect(() => vendorProto({ checkout: dir, pkgRoot: pkg })).toThrow(/^not a git checkout: .*\(fatal: /);
      expect(readdirSync(pkg), "nothing was written").toEqual([]);
    });

    it("a path that does not exist (git says so, in the message)", () => {
      expect(() => vendorProto({ checkout: join(SCRATCH, "nope"), pkgRoot: pkgRootDir() })).toThrow(/^not a git checkout: .*\(fatal: .*nope/);
    });

    it("a folder INSIDE a checkout (git is happy there, but its HEAD is not the folder's)", () => {
      const repo = placementRepo();
      expect(() => vendorProto({ checkout: join(repo, "proto"), pkgRoot: pkgRootDir() })).toThrow(/^not a git checkout: /);
    });

    it("a repository with no commit", () => {
      const repo = fresh("empty-repo");
      git(repo, "init", "-q");
      expect(() => vendorProto({ checkout: repo, pkgRoot: pkgRootDir() })).toThrow(/^not a git checkout: .*the repository has no commit/);
    });

    it("a path that is a file", () => {
      const file = join(fresh("file"), "x");
      writeFileSync(file, "x");
      expect(() => vendorProto({ checkout: file, pkgRoot: pkgRootDir() })).toThrow(/^not a git checkout: /);
    });
  });

  it("refuses a checkout without the proto, and writes nothing", () => {
    const repo = placementRepo(null);
    const pkg = pkgRootDir();
    expect(() => vendorProto({ checkout: repo, pkgRoot: pkg })).toThrow(/^no proto\/scheduler\.proto in /);
    expect(readdirSync(pkg)).toEqual([]);
  });

  it("refuses a checkout whose proto is committed under a different name", () => {
    const repo = fresh("wrong-name");
    git(repo, "init", "-q");
    mkdirSync(join(repo, "proto"));
    writeFileSync(join(repo, "proto/other.proto"), PROTO_V1);
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "init");
    expect(() => vendorProto({ checkout: repo, pkgRoot: pkgRootDir() })).toThrow(/no proto\/scheduler\.proto/);
  });

  describe("refuses a clean-looking checkout whose proto is not HEAD's committed bytes", () => {
    it("a proto that exists on disk but is only gitignored (status is clean, HEAD does not have it)", () => {
      const repo = fresh("ignored-proto");
      git(repo, "init", "-q");
      writeFileSync(join(repo, ".gitignore"), "proto/\n");
      git(repo, "add", "-A");
      git(repo, "commit", "-q", "-m", "init");
      mkdirSync(join(repo, "proto"));
      writeFileSync(join(repo, "proto/scheduler.proto"), PROTO_V1);
      expect(git(repo, "status", "--porcelain"), "the fixture really looks clean").toBe("");
      const pkg = pkgRootDir();
      expect(() => vendorProto({ checkout: repo, pkgRoot: pkg })).toThrow(/^no proto\/scheduler\.proto in /);
      expect(readdirSync(pkg)).toEqual([]);
    });

    it("an edit hidden from status by assume-unchanged", () => {
      const repo = placementRepo();
      git(repo, "update-index", "--assume-unchanged", "proto/scheduler.proto");
      writeFileSync(join(repo, "proto/scheduler.proto"), PROTO_V2);
      expect(git(repo, "status", "--porcelain"), "the fixture really looks clean").toBe("");
      const pkg = pkgRootDir();
      expect(() => vendorProto({ checkout: repo, pkgRoot: pkg })).toThrow(/^proto\/scheduler\.proto is not HEAD's committed bytes in /);
      expect(readdirSync(pkg), "nothing was written").toEqual([]);
    });
  });

  describe("a clean-looking checkout where the working copy is not what HEAD committed (more ways status is blind)", () => {
    it("a proto deleted from disk behind assume-unchanged says it is missing, not 'not HEAD's bytes'", () => {
      const repo = placementRepo();
      git(repo, "update-index", "--assume-unchanged", "proto/scheduler.proto");
      rmSync(join(repo, "proto/scheduler.proto"));
      expect(git(repo, "status", "--porcelain"), "the fixture really looks clean").toBe("");
      expect(() => vendorProto({ checkout: repo, pkgRoot: pkgRootDir() })).toThrow(/^no proto\/scheduler\.proto in /);
    });

    it("a proto git checked out through an eol filter: status is clean, but the bytes are not the image's (Windows autocrlf)", () => {
      const repo = fresh("eol-filter");
      git(repo, "init", "-q");
      writeFileSync(join(repo, ".gitattributes"), "proto/scheduler.proto text eol=crlf\n");
      mkdirSync(join(repo, "proto"));
      writeFileSync(join(repo, "proto/scheduler.proto"), 'syntax = "proto3";\nmessage A {}\n');
      git(repo, "add", "-A");
      git(repo, "commit", "-q", "-m", "init");
      rmSync(join(repo, "proto/scheduler.proto"));
      git(repo, "checkout", "--", "proto/scheduler.proto");
      expect(readFileSync(join(repo, "proto/scheduler.proto"), "utf8"), "the fixture really smudged to CRLF").toContain("\r\n");
      expect(git(repo, "status", "--porcelain"), "the fixture really looks clean").toBe("");
      const pkg = pkgRootDir();
      expect(() => vendorProto({ checkout: repo, pkgRoot: pkg })).toThrow(/^proto\/scheduler\.proto is not HEAD's committed bytes in /);
      expect(readdirSync(pkg)).toEqual([]);
    });
  });

  it("does not touch the checkout it reads: .git/index is byte-identical afterwards, even when its stat cache is stale", () => {
    const repo = placementRepo();
    // Stale the cache: same content, new mtime, so a plain `git status` would refresh and REWRITE the index.
    const future = new Date(Date.now() + 3_600_000);
    utimesSync(join(repo, "README.md"), future, future);
    const before = readFileSync(join(repo, ".git/index"));
    vendorProto({ checkout: repo, pkgRoot: pkgRootDir() });
    expect(readFileSync(join(repo, ".git/index")).equals(before)).toBe(true);
    // Control: the same staleness DOES make an unprotected status rewrite it, or the assertion above could not fail.
    git(repo, "status", "--porcelain");
    expect(readFileSync(join(repo, ".git/index")).equals(before), "control: a plain `git status` rewrites a stale index").toBe(false);
  });

  it("a checkout whose status cannot be read (corrupt index) is refused by name, never read as clean", () => {
    const repo = placementRepo();
    writeFileSync(join(repo, ".git/index"), "not an index");
    expect(() => git(repo, "status", "--porcelain"), "the fixture really breaks git status").toThrow();
    const pkg = pkgRootDir();
    expect(() => vendorProto({ checkout: repo, pkgRoot: pkg })).toThrow(/^not a git checkout: .*git status failed/);
    expect(readdirSync(pkg)).toEqual([]);
  });

  describe("refuses THIS repository and its worktrees (the one that holds the package): it has no root proto any more, but older checkouts do and none of its commits is the placement's", () => {
    /** A package directory inside `repo`, like packages/scheduler inside the monorepo. */
    const pkgInside = (repo: string): string => {
      const pkg = join(repo, "packages/scheduler");
      mkdirSync(pkg, { recursive: true });
      return pkg;
    };

    it("the checkout IS the repository holding pkgRoot", () => {
      const repo = placementRepo();
      const pkg = pkgInside(repo);
      expect(() => vendorProto({ checkout: repo, pkgRoot: pkg })).toThrow(/^is this repository, not the placement checkout: /);
      expect(readdirSync(pkg), "nothing was written").toEqual([]);
    });

    it("the checkout is another WORKTREE of the repository holding pkgRoot (same common dir, different toplevel)", () => {
      const repo = placementRepo();
      const worktree = join(fresh("worktree"), "wt");
      git(repo, "worktree", "add", "-q", "--detach", worktree);
      expect(git(worktree, "rev-parse", "--show-toplevel"), "the fixture really is a second work tree").not.toBe(git(repo, "rev-parse", "--show-toplevel"));
      const pkg = pkgInside(worktree);
      expect(() => vendorProto({ checkout: repo, pkgRoot: pkg })).toThrow(/^is this repository, not the placement checkout: /);
      expect(() => vendorProto({ checkout: worktree, pkgRoot: pkgInside(repo) })).toThrow(/^is this repository, not the placement checkout: /);
    });

    it("control: a package inside a DIFFERENT repository is fine (the guard compares repositories, it does not ban packages in repos)", () => {
      const placement = placementRepo();
      const web = placementRepo(PROTO_V2);
      const pkg = pkgInside(web);
      let pin: VendoredPin | undefined;
      expect(() => {
        pin = vendorProto({ checkout: placement, pkgRoot: pkg });
      }, "a package inside another repository is not this repository").not.toThrow();
      expect(pin?.placementCommit).toBe(head(placement));
      expect(copyOf(pkg).equals(PROTO_V1)).toBe(true);
    });
  });

  it("refuses a zero-length committed proto (it would be vendored, hashed and reported OK)", () => {
    const repo = placementRepo(Buffer.alloc(0));
    expect(git(repo, "cat-file", "-s", "HEAD:proto/scheduler.proto"), "the fixture really committed an empty file").toBe("0");
    const pkg = pkgRootDir();
    expect(() => vendorProto({ checkout: repo, pkgRoot: pkg })).toThrow(/^proto\/scheduler\.proto is empty at HEAD in /);
    expect(readdirSync(pkg), "nothing was written").toEqual([]);
  });

  it("names an unreadable proto size instead of calling it empty (the blob id resolves from the tree, the blob is gone)", () => {
    const repo = placementRepo();
    const blob = git(repo, "rev-parse", "HEAD:proto/scheduler.proto");
    rmSync(join(repo, ".git/objects", blob.slice(0, 2), blob.slice(2)));
    expect(() => git(repo, "cat-file", "-s", blob), "the fixture really breaks cat-file").toThrow();
    expect(git(repo, "status", "--porcelain"), "and status still reads clean").toBe("");
    const pkg = pkgRootDir();
    expect(() => vendorProto({ checkout: repo, pkgRoot: pkg })).toThrow(/^could not read the size of proto\/scheduler\.proto at HEAD in .+: .*fatal:/);
    expect(readdirSync(pkg), "nothing was written").toEqual([]);
  });

  describe("ignores the caller's git config and environment", () => {
    /** Run `fn` with `env` overlaid on process.env (vendorProto reads the ambient environment), then put it back. */
    function withEnv<T>(env: Record<string, string>, fn: () => T): T {
      const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
      Object.assign(process.env, env);
      try {
        return fn();
      } finally {
        for (const [k, v] of Object.entries(saved)) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
      }
    }
    /** A plain git with `env` overlaid; a git that cannot work under it reports "ERR" (itself a way of being misdirected). */
    const rawGit = (repo: string, env: Record<string, string>, ...args: string[]): string => {
      try {
        return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, ...env } }).trim();
      } catch {
        return "ERR";
      }
    };

    it("a global status.showUntrackedFiles=no does not hide an untracked file", () => {
      const cfg = join(fresh("gitcfg"), "gitconfig");
      writeFileSync(cfg, "[status]\n\tshowUntrackedFiles = no\n");
      const repo = placementRepo();
      writeFileSync(join(repo, "scratch.txt"), "x\n");
      expect(rawGit(repo, { GIT_CONFIG_GLOBAL: cfg }, "status", "--porcelain"), "control: the config really hides it from a plain git status").toBe("");
      const pkg = pkgRootDir();
      withEnv({ GIT_CONFIG_GLOBAL: cfg }, () => {
        expect(() => vendorProto({ checkout: repo, pkgRoot: pkg })).toThrow(/^has uncommitted changes: .*scratch\.txt/s);
      });
      expect(readdirSync(pkg), "nothing was written").toEqual([]);
    });

    // Each variable aims git at a DIFFERENT repository (a decoy with other proto bytes and another commit). Set on its own, each
    // must change what a plain git sees (the control) and must not change what vendorProto vendors.
    const REDIRECTS: [name: string, value: (decoy: string) => string][] = [
      ["GIT_DIR", (decoy) => join(decoy, ".git")],
      ["GIT_WORK_TREE", (decoy) => decoy],
      ["GIT_INDEX_FILE", (decoy) => join(decoy, ".git/index")],
      ["GIT_COMMON_DIR", (decoy) => join(decoy, ".git")],
    ];
    it.each(REDIRECTS)("an inherited %s does not redirect it to another repository", (name, value) => {
      const repo = placementRepo();
      const decoy = placementRepo(PROTO_V2);
      const wantHead = head(repo);
      const env = { [name]: value(decoy) };
      const seen = `${rawGit(repo, env, "rev-parse", "HEAD")}|${rawGit(repo, env, "status", "--porcelain")}`;
      expect(seen, `control: a plain git in the checkout IS redirected by ${name}`).not.toBe(`${wantHead}|`);

      const pkg = pkgRootDir();
      let pin: VendoredPin | undefined;
      expect(() => {
        pin = withEnv(env, () => vendorProto({ checkout: repo, pkgRoot: pkg }));
      }, `vendoring must not be disturbed by an inherited ${name}`).not.toThrow();
      expect(pin?.placementCommit).toBe(wantHead);
      expect(copyOf(pkg).equals(PROTO_V1), "the copy is the checkout's bytes, not the decoy's").toBe(true);
    });
  });

  it("accepts a case variant of the checkout path where the filesystem is case-insensitive (APFS), and says why otherwise", () => {
    const repo = placementRepo();
    const variant = join(dirname(repo), basename(repo).toUpperCase());
    expect(variant, "the fixture really differs in case").not.toBe(repo);
    const pkg = pkgRootDir();
    if (existsSync(variant)) {
      // Case-insensitive volume: the same directory under another spelling. git reports the real spelling as its toplevel.
      let pin: VendoredPin | undefined;
      expect(() => {
        pin = vendorProto({ checkout: variant, pkgRoot: pkg });
      }, "the same directory under another spelling is the same checkout").not.toThrow();
      expect(pin?.placementCommit).toBe(head(repo));
    } else {
      // Case-sensitive volume (Linux CI): there is no such directory, and the refusal carries git's own words.
      expect(() => vendorProto({ checkout: variant, pkgRoot: pkg })).toThrow(/^not a git checkout: .*\(fatal: /);
    }
  });

  it("refuses a repository whose commit ids are not 40-hex (the image tag could not be one)", () => {
    const repo = fresh("sha256-repo");
    git(repo, "init", "-q", "--object-format=sha256");
    mkdirSync(join(repo, "proto"));
    writeFileSync(join(repo, "proto/scheduler.proto"), PROTO_V1);
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "init");
    expect(head(repo), "the fixture really has a 64-hex HEAD").toMatch(/^[0-9a-f]{64}$/);
    const pkg = pkgRootDir();
    expect(() => vendorProto({ checkout: repo, pkgRoot: pkg })).toThrow(/^not a git checkout: .*not a 40-hex sha1/);
    expect(readdirSync(pkg)).toEqual([]);
  });
});

describe("resolveCheckout", () => {
  it("resolves a relative path against INIT_CWD (where the developer typed it), not the script's cwd", () => {
    expect(resolveCheckout("../p", "/a/b", "/x/y")).toBe("/a/p");
  });
  it("falls back to cwd when INIT_CWD is unset", () => {
    expect(resolveCheckout("../p", undefined, "/x/y")).toBe("/x/p");
  });
  it("treats an empty INIT_CWD as unset (path.resolve('') would silently use the process cwd, a third base)", () => {
    expect(resolveCheckout("../p", "", "/x/y")).toBe("/x/p");
  });
  it("keeps an absolute path as it is, whatever the bases are", () => {
    expect(resolveCheckout("/abs/p", "/a/b", "/x/y")).toBe("/abs/p");
    expect(resolveCheckout("/abs/p", undefined, "/x/y")).toBe("/abs/p");
  });
});

// The CLI is the one place `resolveCheckout` is wired to INIT_CWD, `pkgRoot` defaults to the package, and the exit code is
// decided; a green library under a CLI that ignores any of those is an inert seam. So these run the REAL script, from a COPY
// of scripts/ placed in a temp package: proto-paths.ts derives the package root from its own location, so the copy writes
// into the temp package and the real packages/scheduler/proto and VENDORED.json are never touched.
describe("scripts/vendor-proto.ts (the CLI)", () => {
  const SCRIPTS = ["proto-paths.ts", "vendor-proto-lib.ts", "vendor-proto.ts"];
  /** A temp package holding a copy of the three scripts. */
  function tempPackage(): string {
    const pkg = fresh("cli-pkg");
    mkdirSync(join(pkg, "scripts"));
    for (const file of SCRIPTS) copyFileSync(join(PACKAGE, "scripts", file), join(pkg, "scripts", file));
    return pkg;
  }
  const cli = (pkg: string, args: string[], env: Record<string, string> = {}) => {
    const r = spawnSync("node", ["--experimental-strip-types", "--no-warnings", "scripts/vendor-proto.ts", ...args], {
      cwd: pkg,
      encoding: "utf8",
      env: { ...process.env, INIT_CWD: "", ...env },
    });
    expect(r.error, "node must be runnable").toBeUndefined();
    return { code: r.status, out: r.stdout, err: r.stderr };
  };

  it("vendors into ITS package (the default pkgRoot), resolving a relative path against INIT_CWD, and says what to run next", () => {
    const repo = placementRepo();
    const pkg = tempPackage();
    // The process cwd is the package; the developer was in dirname(repo) and typed a relative path.
    const out = cli(pkg, [basename(repo)], { INIT_CWD: dirname(repo) });
    expect(out.code, out.err).toBe(0);

    expect(existsSync(join(pkg, "proto/scheduler.proto")), "the copy landed in the script's own package").toBe(true);
    expect(existsSync(join(pkg, "VENDORED.json")), "and so did the pin").toBe(true);
    expect(copyOf(pkg).equals(PROTO_V1), "the copy is the source byte for byte").toBe(true);
    const want = { placementCommit: head(repo), sha256: sha256(PROTO_V1), imageTag: head(repo) };
    expect(JSON.parse(pinText(pkg))).toEqual(want);
    expect(out.out, "the pin is printed").toContain(`"placementCommit": "${head(repo)}"`);
    expect(out.out, "and the next command is named").toContain("pnpm --filter @seazn/scheduler gen:proto");
    expect(readdirSync(pkg).sort(), "nothing but the copy, the pin and the scripts").toEqual(["VENDORED.json", "proto", "scripts"]);
  });

  it("exits 1 with the library's message and writes nothing on a dirty checkout", () => {
    const repo = placementRepo();
    writeFileSync(join(repo, "README.md"), "edited\n");
    const pkg = tempPackage();
    const out = cli(pkg, [basename(repo)], { INIT_CWD: dirname(repo) });
    expect(out.code, out.err).toBe(1);
    expect(out.err).toContain(`has uncommitted changes: ${repo}`);
    expect(out.out, "no pin is printed on a refusal").not.toContain("placementCommit");
    expect(readdirSync(pkg), "nothing was written").toEqual(["scripts"]);
  });

  it("the refusal names the path resolved against INIT_CWD, not against the script's cwd", () => {
    const out = cli(tempPackage(), ["definitely-not-a-checkout"], { INIT_CWD: SCRATCH });
    expect(out.code).toBe(1);
    expect(out.err).toContain(`not a git checkout: ${join(SCRATCH, "definitely-not-a-checkout")}`);
  });

  it("without INIT_CWD a relative path is taken from the process cwd", () => {
    const pkg = tempPackage();
    const out = cli(pkg, ["definitely-not-a-checkout"]);
    expect(out.code).toBe(1);
    // process.cwd() is the REAL path (macOS tmpdir is a symlink), so compare against the real path of the package.
    expect(out.err).toContain(`not a git checkout: ${join(realpathSync(pkg), "definitely-not-a-checkout")}`);
  });

  it("exits 1 with a usage line when no path is given", () => {
    const pkg = tempPackage();
    const out = cli(pkg, []);
    expect(out.code).toBe(1);
    expect(out.err).toMatch(/usage:.*vendor:proto <path-to-placement-checkout>/);
    expect(readdirSync(pkg)).toEqual(["scripts"]);
  });
});
