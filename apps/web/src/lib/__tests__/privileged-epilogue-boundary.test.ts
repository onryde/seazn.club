// withTenant's privilegedEpilogue (lib/db.ts; MD-1 batch 2 fix round 2, N1, the controller's ruling) resets the role to the
// pool's for the rest of the transaction, so a write it makes bypasses every RLS policy. One caller is allowed: the Match
// Day code's open, which logs each link it hands out in the sealed `match_day_code_uses` in the link's own transaction
// (capture S4 design §3). Claims, as enc-boundary.test.ts does for the sealed columns:
//  1. outside __tests__ and lib/db.ts (which defines it), the open's file is the ONLY file naming `privilegedEpilogue`;
//  2. and it does (the positive half: an allowed owner that stopped using it leaves this list stale, which an empty
//     scan cannot see).
// A new caller is a security decision: add it here, with its reason, in the same review.
// Pure (no DB); runs in every CI job. Same glob discipline as enc-boundary.test.ts.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const SRC = resolve(import.meta.dirname, "../.."); // apps/web/src

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "node_modules" || name === ".next") continue;
      walk(full, out);
    } else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

const DEFINER = "lib/db.ts";
/** The allow-list: each file allowed to use the epilogue, and why. */
const ALLOWED: Record<string, string> = {
  "server/usecases/match-day-code-open.ts": "the open's match_day_code_uses row, in the link's own transaction (spec §3)",
};

describe("privilegedEpilogue is used only by its allow-listed callers", () => {
  const files = walk(SRC)
    .map((f) => relative(SRC, f).split("\\").join("/"))
    .filter((f) => !f.split("/").includes("__tests__"));

  it("premise: the scan sees the source tree, the definer included", () => {
    expect(files.length).toBeGreaterThan(500);
    expect(files).toContain(DEFINER);
    expect(readFileSync(join(SRC, DEFINER), "utf8")).toContain("privilegedEpilogue");
  });

  it("no file outside the allow-list names privilegedEpilogue", () => {
    const naming = files.filter((f) => f !== DEFINER && readFileSync(join(SRC, f), "utf8").includes("privilegedEpilogue"));
    expect(naming.sort()).toEqual(Object.keys(ALLOWED).sort());
  });
});
