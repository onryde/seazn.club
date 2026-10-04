// B06a Task 1 — the suite registry. Until this file existed, `bench.ts`
// carried the known-suite list as a literal AND the dispatch as an
// `if (key === "_tiny")`, so adding a pack meant editing two places that could
// disagree: a key listed but not dispatched threw the "only _tiny exists"
// error AFTER pre-flight, and a key dispatched but not listed was rejected by
// argument validation before it ever ran. One table now answers both.
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { SUITE_REGISTRY, lookupSuite, suiteKeys } from "../registry.ts";

describe("suite registry", () => {
  it("lists _tiny and every entry's key matches the key it is filed under", () => {
    expect(suiteKeys()).toContain("_tiny");
    for (const [key, def] of SUITE_REGISTRY) expect(def.key).toBe(key);
  });

  it("returns undefined for an unknown key rather than throwing", () => {
    expect(lookupSuite("does-not-exist")).toBeUndefined();
  });

  it("gives every suite an absolute pack path", () => {
    // A cwd-relative pack path reads a different file (or none) depending on
    // whether the bench was started from the repo root or a worktree root —
    // the reason `TINY_PACK_PATH` resolves from its own module URL.
    for (const def of SUITE_REGISTRY.values()) {
      expect(def.packPath.startsWith("/")).toBe(true);
    }
  });

  it("exposes a runner per suite", () => {
    for (const def of SUITE_REGISTRY.values()) {
      expect(typeof def.run).toBe("function");
    }
  });

  it("every registered pack file exists on disk", () => {
    // The registry is the only thing between `--suite <key>` and a pack, so a
    // path that resolves to nothing fails deep inside pre-flight rather than
    // at argument validation.
    for (const def of SUITE_REGISTRY.values()) {
      expect(existsSync(def.packPath), `${def.key} -> ${def.packPath}`).toBe(true);
    }
  });

  it("every pack declares the suite key it is filed under", () => {
    // B06a finding 3, one layer out: the runner used to default a missing
    // `packPath` to `_tiny`'s, so a suite folded the proof pack while
    // reporting under its own name. The inverse is just as silent — a registry
    // row pointing at the wrong pack — and this is what catches it.
    for (const [key, def] of SUITE_REGISTRY) {
      const pack = JSON.parse(readFileSync(def.packPath, "utf8")) as { suite: string };
      expect(pack.suite, `${key} -> ${def.packPath}`).toBe(key);
    }
  });

  it("registers suite 11 in programme order, after _tiny", () => {
    // Insertion order, not alphabetical: `suiteKeys()` drives `--help` and the
    // unknown-suite error text, and those read best in the order the programme
    // built them.
    expect(suiteKeys()).toEqual(["_tiny", "suite11"]);
    expect(lookupSuite("suite11")?.title).toBe("PDC Worlds (darts)");
  });
});
