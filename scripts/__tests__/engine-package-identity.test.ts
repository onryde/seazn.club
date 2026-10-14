// D19: published as @onryde/seazn-engine, consumed as @seazn/engine. Pins both halves so nobody "fixes" one.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "../..");
const read = (p: string) => JSON.parse(readFileSync(path.join(ROOT, p), "utf8"));
// Derived, never typed: every workspace manifest (pnpm-workspace.yaml globs apps/*, packages/*, tools/*) plus the root.
const manifests = ["package.json", ...["apps", "packages", "tools"].flatMap((d) =>
  readdirSync(path.join(ROOT, d)).map((n) => `${d}/${n}/package.json`).filter((p) => existsSync(path.join(ROOT, p))))];

describe("engine package identity", () => {
  it("is published under the GitHub owner's scope", () => {
    expect(read("packages/engine/package.json").name).toBe("@onryde/seazn-engine");
  });

  it("every workspace that depends on the engine imports it as @seazn/engine through the alias", () => {
    const consumers = manifests.filter((p) => p !== "packages/engine/package.json").filter((p) => {
      const m = read(p);
      return Object.keys({ ...m.dependencies, ...m.devDependencies }).some((k) => k === "@seazn/engine" || k === "@onryde/seazn-engine");
    });
    // 6 at 1b-1: root, apps/web, packages/reference (dev), packages/scheduler, tools/matrix, tools/bench.
    expect(consumers.length, `found ${consumers.length} engine consumers (${consumers.join(", ")}) — fewer than 6 means the scan is vacuous or a consumer was dropped`).toBeGreaterThanOrEqual(6);
    for (const p of consumers) {
      const m = read(p);
      expect(m.dependencies?.["@onryde/seazn-engine"] ?? m.devDependencies?.["@onryde/seazn-engine"], `${p} must not import the scoped name`).toBeUndefined();
      expect(m.dependencies?.["@seazn/engine"] ?? m.devDependencies?.["@seazn/engine"], p).toBe("workspace:@onryde/seazn-engine@*");
    }
  });
});
