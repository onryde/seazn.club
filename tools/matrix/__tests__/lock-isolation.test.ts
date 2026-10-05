// W1d Task 15 (T15-LOCK, T15-FIX1 I2): the two `overrides` in pnpm-workspace.yaml that keep Stryker's dependency tree from
// leaking into apps/web are guarded by NOTHING else. pnpm's autoInstallPeers fills a missing peer from the highest version of
// that name anywhere in the lockfile, so once the engine brings @babel/core 8 (Stryker) and rxjs 7 into the lock, `next`,
// `@sentry/nextjs` and `styled-jsx` would be re-linked to @babel/core 8.0.6 and `posthog-node` to rxjs 7.8.2 — apps/web's
// production resolution changed by a devDependency of another package, with every test green. A selector that stops matching
// (the helper it names is bumped, or the override is deleted while "cleaning up") does that silently, and only the lock
// shows it. So this reads the lock the way pnpm wrote it and holds the isolation itself.
//
// The lock is parsed by lines (the repo root has no YAML dependency, and none is added). Sections are the top-level keys;
// an importer or a snapshot is a two-space key under `importers:` / `snapshots:`, and its body is what is indented beneath.
// Single-sport reason: no sport is involved — this is the workspace's dependency lock.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const LOCK = readFileSync(join(REPO, "pnpm-lock.yaml"), "utf8");
const WORKSPACE = readFileSync(join(REPO, "pnpm-workspace.yaml"), "utf8");

/** The one importer allowed to link @babel/core 8 and rxjs: Stryker is its devDependency. */
const ENGINE = "packages/engine";
/** apps/web's @babel/core 7 consumers: the packages whose peer pnpm fills from the lock. */
const BABEL_GUARDED = ["next", "@sentry/nextjs", "styled-jsx"];
/** The package whose optional rxjs peer pnpm would fill with the engine's rxjs 7. */
const RXJS_GUARDED = "posthog-node";

interface Entry { key: string; body: string[] }
interface Lock { importers: Entry[]; snapshots: Entry[]; overrides: string[] }

/** The lock's `importers:` and `snapshots:` as entries (key without quotes or a trailing `: {}`), and its `overrides:` lines. */
function parseLock(text: string): Lock {
  const out: Lock = { importers: [], snapshots: [], overrides: [] };
  let section = "";
  let cur: Entry | null = null;
  for (const line of text.split("\n")) {
    if (/^[a-zA-Z]/.test(line)) { section = line.replace(/:.*$/, ""); cur = null; continue; }
    if (section === "overrides" && line.startsWith("  ")) { out.overrides.push(line.trim()); continue; }
    if (section !== "importers" && section !== "snapshots") continue;
    const key = /^ {2}(\S.*?):(?: \{\})?$/.exec(line);
    if (key !== null) { cur = { key: key[1]!.replace(/^'(.*)'$/, "$1"), body: [] }; out[section].push(cur); continue; }
    if (cur !== null && line.trim() !== "") cur.body.push(line);
  }
  return out;
}

/** `next@16.3.6(@babel/core@7.29.7)(...)` -> `next`; `@sentry/nextjs@10.62.0(...)` -> `@sentry/nextjs`. */
const nameOf = (snapshotKey: string): string => /^(@?[^@]+)@/.exec(snapshotKey)?.[1] ?? snapshotKey;

interface Scan { violations: string[]; checked: { importers: number; guardedSnapshots: Record<string, number> }; premise: { babel8: boolean; rxjs7: boolean } }

/** Everything the two overrides exist to prevent, as a list of the lock lines that show it, and how much was looked at. */
function scan(text: string): Scan {
  const lock = parseLock(text);
  const violations: string[] = [];
  const guardedSnapshots: Record<string, number> = Object.fromEntries([...BABEL_GUARDED, RXJS_GUARDED].map((n) => [n, 0]));
  const dependsOn = (line: string, names: string[]): boolean => names.some((n) => new RegExp(`^\\s+'?${n.replace(/[/@]/g, "\\$&")}'?: `).test(line));

  let importers = 0;
  for (const imp of lock.importers) {
    if (imp.key === ENGINE) continue;
    importers++;
    for (const l of imp.body) {
      if (l.includes("@babel/core@8")) violations.push(`importer ${imp.key} links @babel/core 8: ${l.trim().slice(0, 90)}`);
      if (/\brxjs\b/.test(l)) violations.push(`importer ${imp.key} links rxjs: ${l.trim().slice(0, 90)}`);
    }
  }
  for (const s of lock.snapshots) {
    const name = nameOf(s.key);
    if (name in guardedSnapshots) guardedSnapshots[name]!++;
    if (BABEL_GUARDED.includes(name)) {
      if (s.key.includes("@babel/core@8")) violations.push(`snapshot ${s.key.slice(0, 90)} links @babel/core 8`);
      for (const l of s.body) if (/^\s+'@babel\/core': 8/.test(l)) violations.push(`snapshot ${name} depends on @babel/core 8: ${l.trim()}`);
    }
    if (name === RXJS_GUARDED) {
      if (s.key.includes("rxjs")) violations.push(`snapshot ${s.key.slice(0, 90)} links rxjs`);
      for (const l of s.body) if (/^\s+rxjs: /.test(l)) violations.push(`snapshot ${name} depends on rxjs: ${l.trim()}`);
    }
    // a dependent's reference to a guarded package carries the peer it was linked with
    for (const l of s.body) {
      if (dependsOn(l, BABEL_GUARDED) && l.includes("@babel/core@8")) violations.push(`snapshot ${nameOf(s.key)} references ${l.trim().slice(0, 90)}`);
      if (dependsOn(l, [RXJS_GUARDED]) && l.includes("rxjs@")) violations.push(`snapshot ${nameOf(s.key)} references ${l.trim().slice(0, 90)}`);
    }
  }
  return {
    violations,
    checked: { importers, guardedSnapshots },
    premise: { babel8: lock.snapshots.some((s) => s.key.includes("@babel/core@8")), rxjs7: lock.snapshots.some((s) => s.key.startsWith("rxjs@7")) },
  };
}

describe("the lockfile keeps Stryker's @babel/core 8 and rxjs 7 out of apps/web (T15-LOCK; the overrides in pnpm-workspace.yaml)", () => {
  const real = scan(LOCK);

  it("no importer but packages/engine, and no next / @sentry/nextjs / styled-jsx / posthog-node snapshot, links @babel/core 8 or rxjs", () => {
    expect(real.violations).toEqual([]);
  });

  it("anti-vacuity: it looked at every other importer and at snapshots of each guarded package, and Stryker's @babel/core 8 and rxjs 7 are in the lock to be kept out", () => {
    const importers = parseLock(LOCK).importers.map((i) => i.key);
    expect(importers, "the workspace's projects, the engine among them").toEqual(expect.arrayContaining([ENGINE, "apps/web", "tools/matrix"]));
    expect(real.checked.importers, "every importer but the engine").toBe(importers.length - 1);
    for (const [name, n] of Object.entries(real.checked.guardedSnapshots)) expect(n, `${name} snapshots looked at`).toBeGreaterThan(0);
    // a lock without them makes both overrides dead weight, and this guard a no-op: the message says what to drop
    expect(real.premise.babel8, "Stryker's @babel/core 8 is no longer in the lock: drop the @babel/helper-module-transforms override and this test").toBe(true);
    expect(real.premise.rxjs7, "rxjs 7 is no longer in the lock: drop the posthog-node>rxjs override").toBe(true);
  });

  it("the two overrides are written in pnpm-workspace.yaml and in the lock (the selector names a RANGE, so a 7.x bump of the helper keeps matching)", () => {
    // `@7.29.7` stops matching when the helper moves (measured: a helper at 7.28.6 re-linked apps/web to @babel/core 8.0.6 under it, and
    // not under `@<8`); and no `@<8` at all would also pin Stryker's own @babel/helper-module-transforms 8 to @babel/core 7.29.7
    expect(WORKSPACE).toMatch(/^ {2}"@babel\/helper-module-transforms@<8>@babel\/core": "7\.29\.7"$/m);
    expect(WORKSPACE).toMatch(/^ {2}"posthog-node>rxjs": "-"$/m);
    expect(parseLock(LOCK).overrides).toEqual(expect.arrayContaining(["'@babel/helper-module-transforms@<8>@babel/core': 7.29.7", "posthog-node>rxjs: '-'"]));
    expect(WORKSPACE).not.toMatch(/@babel\/helper-module-transforms@7\.\d+\.\d+>/);
  });
});

// The scan on lock excerpts in the shapes pnpm 10.34.5 wrote when each override was deleted in a scratch copy of the workspace
// (`pnpm install --lockfile-only`): what is below is what the real lock would then hold, so a scan that misses one of them
// would let the same drift through.
describe("the lock scan itself, on the shapes a deleted or stale override writes", () => {
  const CORE7 = "(@babel/core@7.29.7)";
  const CORE8 = "(@babel/core@8.0.6)";
  const NEXT = (core: string) => `next@16.3.6${core}(@opentelemetry/api@1.9.1)(react-dom@19.2.4(react@19.2.4))(react@19.2.4)`;
  const lockOf = (o: { core?: string; rxjs?: boolean; engineCore8?: boolean }): string => {
    const core = o.core ?? CORE7;
    const posthog = o.rxjs === true ? "posthog-node@5.40.0(rxjs@7.8.2)" : "posthog-node@5.40.0";
    return [
      "lockfileVersion: '9.0'", "", "overrides:", "  posthog-node>rxjs: '-'", "", "importers:", "",
      "  apps/web:", "    dependencies:", "      next:", "        specifier: ^16.3.6", `        version: ${NEXT(core)}`,
      "      posthog-node:", "        specifier: ^5.40.0", `        version: ${o.rxjs === true ? "5.40.0(rxjs@7.8.2)" : "5.40.0"}`, "",
      "  packages/engine:", "    devDependencies:", "      '@stryker-mutator/core':", "        specifier: 10.0.0",
      `        version: 10.0.0${o.engineCore8 === false ? "" : "(@babel/core@8.0.6)"}`, "",
      "packages:", "", "  rxjs@7.8.2:", "    resolution: {integrity: sha512-x}", "", "snapshots:", "",
      `  ${NEXT(core)}:`, "    dependencies:", `      styled-jsx: 5.1.6${core}(react@19.2.4)`, "",
      `  styled-jsx@5.1.6${core}(react@19.2.4):`, "    dependencies:", `      '@babel/core': ${core === CORE8 ? "8.0.6" : "7.29.7"}`, "",
      `  '@sentry/nextjs@10.62.0(next@16.3.6${core}(react@19.2.4))(react@19.2.4)':`, "    dependencies:", `      next: 16.3.6${core}(react@19.2.4)`, "",
      `  ${posthog}:`, "    dependencies:", "      '@posthog/core': 1.40.0", ...(o.rxjs === true ? ["    optionalDependencies:", "      rxjs: 7.8.2"] : []), "",
      "  '@babel/core@8.0.6':", "    dependencies:", "      '@babel/types': 8.0.6", "", "  rxjs@7.8.2: {}", "",
    ].join("\n");
  };

  it("a clean lock passes with every guarded package looked at, and the engine's own @babel/core 8 link is not a violation", () => {
    const r = scan(lockOf({}));
    expect(r.violations).toEqual([]);
    expect(r.checked.importers).toBe(1);
    expect(r.checked.guardedSnapshots).toEqual({ next: 1, "@sentry/nextjs": 1, "styled-jsx": 1, "posthog-node": 1 });
    expect(r.premise).toEqual({ babel8: true, rxjs7: true });
  });

  it("override 1 gone (apps/web re-linked to @babel/core 8): the importer, the next / styled-jsx / @sentry/nextjs keys and every reference to them are named", () => {
    const v = scan(lockOf({ core: CORE8 })).violations;
    expect(v.filter((x) => x.startsWith("importer apps/web links @babel/core 8"))).toHaveLength(1);
    for (const name of ["next", "styled-jsx", "@sentry/nextjs"]) expect(v.filter((x) => x.startsWith(`snapshot ${name}@`)), name).not.toEqual([]);
    expect(v.some((x) => x.includes("depends on @babel/core 8"))).toBe(true);
    expect(v.some((x) => x.includes("references") && x.includes("styled-jsx: 5.1.6(@babel/core@8.0.6)"))).toBe(true);
  });

  it("override 2 gone (posthog-node given rxjs 7.8.2): the importer, the snapshot key and its optionalDependencies are named", () => {
    const v = scan(lockOf({ rxjs: true })).violations;
    expect(v.filter((x) => x.startsWith("importer apps/web links rxjs"))).toHaveLength(1);
    expect(v.filter((x) => x.startsWith("snapshot posthog-node@5.40.0(rxjs@7.8.2) links rxjs"))).toHaveLength(1);
    expect(v.filter((x) => x === "snapshot posthog-node depends on rxjs: rxjs: 7.8.2")).toHaveLength(1);
  });

  it("the empty case: an empty lock looks at nothing and says so (the real-lock test fails on zero looked at, not on a pass)", () => {
    const r = scan("");
    expect(r.violations).toEqual([]);
    expect(r.checked.importers).toBe(0);
    expect(Object.values(r.checked.guardedSnapshots)).toEqual([0, 0, 0, 0]);
    expect(r.premise).toEqual({ babel8: false, rxjs7: false });
  });
});
