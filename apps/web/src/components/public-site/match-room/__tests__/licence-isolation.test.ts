import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const WEB = join(__dirname, "..", "..", "..", "..", ".."); // apps/web
const SRC = join(WEB, "src");
const LOADER = "src/components/public-site/match-room/board-loader.ts";

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((e) => {
    const full = join(dir, e);
    return statSync(full).isDirectory() ? walk(full) : /\.(ts|tsx)$/.test(e) ? [full] : [];
  });
}

describe("chessground stays isolated and unmodified (spec §9)", () => {
  it("is an exact pinned dependency at the GPL-3.0 version we accepted", () => {
    const pkg = JSON.parse(readFileSync(join(WEB, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    expect(pkg.dependencies.chessground).toBe("9.2.1");
    expect(pkg.dependencies["chess.js"]).toBe("1.4.0");
  });

  it("exactly ONE source file imports chessground, and it is the loader", () => {
    const files = walk(SRC);
    expect(files.length, "anti-vacuity: source files scanned").toBeGreaterThan(500);
    const importers = files
      // This file names the pattern it hunts for; it is the only exemption.
      .filter((f) => f !== __filename)
      .filter((f) => /from "chessground|require\("chessground|import\("chessground|import "chessground/.test(readFileSync(f, "utf8")))
      .map((f) => f.slice(WEB.length + 1).split("\\").join("/"));
    expect(importers).toEqual([LOADER]);
  });

  it("no chessground source is vendored into the repo", () => {
    const vendored = walk(SRC).filter((f) => /chessground/i.test(f));
    expect(vendored, "chessground must be a dependency, never a copy").toEqual([]);
  });

  it("the loader states the licence reason, and loads chessground as its OWN async chunk", () => {
    const src = readFileSync(join(WEB, LOADER), "utf8");
    expect(src).toContain("GPL-3.0");
    expect(src).toContain("unmodified");
    expect(src).toMatch(/await import\("chessground"\)/);
    // A static import would fold it into the route's first-load bundle.
    expect(src).not.toMatch(/^import [^(]*from "chessground"/m);
  });
});
