import { execFileSync } from "node:child_process";

import { describe, expect, it } from "vitest";

/**
 * C8 — z3 retirement, stage E. The solver is gone; this is the proof.
 *
 * Deliberately a DEPENDENCY-GRAPH assertion rather than a prose grep. A file
 * may legitimately discuss z3 while importing nothing from it — C6 found four
 * such sites, and `repair-decompose-cpsat.ts` is one: it reasons about
 * CP-SAT's encoding against z3's, which stays useful after the solver is gone.
 * A guard that cannot tell "z3 did this" from "z3 does this" is a nuisance, so
 * this one asserts on imports and manifests, which is what "unreferenced"
 * actually means. `scripts/__tests__/z3-retirement-drift.test.ts` owns the
 * prose side.
 *
 * `git grep` exits 1 with no output when there are no matches, which is the
 * green case here — hence the try/catch rather than a status check.
 */
/**
 * `git -C <root>`, never a bare `git grep`. Vitest runs this file with the cwd
 * at `packages/engine`, and `git grep` scopes to the cwd: a bare call searches
 * the engine workspace alone, so every `apps/web` pathspec matches nothing and
 * the assertion passes while proving nothing. Caught by writing the failing
 * test first — two of the six cases below went green against a tree that still
 * declared the dependency in both manifests.
 */
const REPO_ROOT = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf8",
}).trim();

function gitGrep(args: readonly string[]): string {
  try {
    return execFileSync("git", ["-C", REPO_ROOT, "grep", "-a", "-n", ...args], {
      encoding: "utf8",
    }).trim();
  } catch {
    return "";
  }
}

describe("the z3 dependency is unreferenced", () => {
  it("no file imports the z3-solver package", () => {
    expect(gitGrep(["-E", String.raw`from ["']z3-solver["']|require\(["']z3-solver["']\)`])).toBe(
      "",
    );
  });

  it("no file imports the WASM loader module", () => {
    expect(gitGrep(["-E", String.raw`from ["'][^"']*z3-load(\.ts)?["']`])).toBe("");
  });

  it("no file imports the z3 repair encoder", () => {
    expect(gitGrep(["-E", String.raw`from ["']\.{1,2}/repair(\.ts)?["']`])).toBe("");
  });

  it("neither workspace manifest declares the dependency", () => {
    expect(
      gitGrep(["z3-solver", "--", "apps/web/package.json", "packages/engine/package.json"]),
    ).toBe("");
  });

  it("next.config carries no z3 WASM plumbing", () => {
    // Both halves of the pair go together: `serverExternalPackages` AND the
    // `outputFileTracingIncludes` entry were needed to make the WASM work in
    // standalone, so removing one leaves config that does nothing.
    expect(gitGrep(["-i", "z3", "--", "apps/web/next.config.js"])).toBe("");
  });

  /**
   * The graph C9's CP-SAT driver reuses must survive the deletion.
   *
   * `repair-decompose.ts` held two things: the z3 driver (`repairDecomposed`)
   * and the solver-agnostic component graph beneath it. Deleting the file
   * wholesale — which C8's own file set, read literally, invites — would take
   * `repair-decompose-cpsat.ts`, the production driver, down with it.
   */
  it("C9's component graph survives, and the z3 driver above it does not", async () => {
    const decompose = await import("./repair-decompose.ts");
    expect(typeof decompose.repairComponents).toBe("function");
    expect(typeof decompose.dayCapGuard).toBe("function");
    expect("repairDecomposed" in decompose).toBe(false);

    const minimality = await import("./repair-minimality.ts");
    expect(typeof minimality.disjointConflictBound).toBe("function");

    const cpsat = await import("./repair-decompose-cpsat.ts");
    expect(typeof cpsat.repairDecomposedCpsat).toBe("function");
  });
});
