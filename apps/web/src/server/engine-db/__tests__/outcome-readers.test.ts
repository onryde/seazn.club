import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Finding 1 (W2a): a settle lives beside module state, so a fold's outcome is
// `outcomeOf(module, folded)`. A bare `<module>.outcome(state)` on a FOLD
// result silently drops a settle (class 1, the inert seam). Each remaining bare
// call is listed with why it is not a fold result.
const REPO = resolve(__dirname, "../../../../../..");
const ROOTS = ["apps/web/src", "packages/engine/src", "tools/matrix/lib"];
const BARE = /\b[A-Za-z]+\.outcome\((state|next|folded)\b/g;
const ALLOWED: Readonly<Record<string, string>> = {
  "packages/engine/src/core/events.ts": "the kernel itself (decided flag, settle precondition, outcomeOf)",
  "apps/web/src/server/overlay/recent.ts": "a point-state PROBE over a stored module state (:321, :355), not a fold result; a settlement is never part of module state, so outcomeOf cannot apply (preflight C8)",
  "packages/engine/src/testkit/stoppages.ts": "testkit: module-level conformance, no settle in its streams",
  "packages/engine/src/testkit/conformance.ts": "testkit: module-level conformance, no settle in its streams",
  "packages/engine/src/testkit/simulation.ts": "testkit: simulation folds without settle",
  "packages/engine/src/testkit/scenarios.ts": "testkit: scenario builder folds without settle",
};
function walk(dir: string, out: string[]): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) { if (e !== "node_modules" && e !== "__tests__") walk(p, out); }
    else if (/\.(ts|tsx)$/.test(e) && !/\.test\.tsx?$/.test(e)) out.push(p);
  }
  return out;
}

describe("finding 1: every fold-outcome reader goes through outcomeOf", () => {
  it("no bare <module>.outcome(state) outside the allowed list, and outcomeOf's readers are exactly the eight moved fold readers", () => {
    const files = ROOTS.flatMap((r) => walk(join(REPO, r), []));
    expect(files.length).toBeGreaterThan(100);
    const bare: string[] = [];
    const readers: string[] = [];
    for (const f of files) {
      const rel = relative(REPO, f);
      const text = readFileSync(f, "utf8");
      if (/\boutcomeOf\(/.test(text) && rel !== "packages/engine/src/core/events.ts") readers.push(rel);
      if (ALLOWED[rel] !== undefined) continue;
      for (const m of text.matchAll(BARE)) bare.push(`${rel}: ${m[0]}`);
    }
    expect(bare).toEqual([]);
    // Exactly the six fold readers Step 8 moves (preflight C8), plus the two module player-stat folds
    // (ruling D-C3). A later task that adds a reader adds it here by name.
    expect(readers.sort()).toEqual([
      "apps/web/src/server/engine-db/append-event.ts",
      "apps/web/src/server/engine-db/fold.ts",
      "apps/web/src/server/usecases/event-import.ts",
      "packages/engine/src/sports/carrom/carrom.ts",
      "packages/engine/src/sports/cricket/scorecard.ts",
      "packages/engine/src/sports/generic/generic.ts",
      "tools/matrix/lib/fold.ts",
      "tools/matrix/lib/model/ledger-fold.ts",
    ]);
  });
  it("ruling D-C3: no fold result's outcome is read as a PROPERTY (`x.outcome`, `x.state.outcome`) — that drops a settle too", () => {
    // The second shape of the same defect: `const s = foldMatch(...); s.outcome` reads the module's own outcome
    // field and never sees a settlement (carrom's and generic's player-stat folds did exactly this). A name bound
    // to a fold call is tracked per file; a direct `foldMatch(...).outcome` / `.state.outcome` is caught too.
    const FOLD_BIND = /\b(?:const|let)\s+(\w+)(?:\s*:[^=;\n]+)?\s*=\s*(?:await\s+)?foldMatch(?:WithStoppage)?\(/g;
    const FOLD_CALL = /\bfoldMatch(?:WithStoppage)?\(/g;
    const DIRECT = /\bfoldMatch(?:WithStoppage)?\([^;]*?\)(?:\.state)?\.outcome\b(?!\s*\()/g;
    const files = ROOTS.flatMap((r) => walk(join(REPO, r), []));
    let foldSites = 0;
    let boundNames = 0;
    const property: string[] = [];
    for (const f of files) {
      const rel = relative(REPO, f);
      if (rel === "packages/engine/src/core/events.ts") continue; // the kernel defines the fold
      const text = readFileSync(f, "utf8").replace(/^\s*(\/\/|\*|\/\*).*$/gm, ""); // comments name the shape
      foldSites += [...text.matchAll(FOLD_CALL)].length;
      for (const m of text.matchAll(DIRECT)) property.push(`${rel}: ${m[0].slice(-40)}`);
      for (const bind of text.matchAll(FOLD_BIND)) {
        const name = bind[1]!;
        boundNames++;
        // The binding's reach: up to the next declaration of the same name (another function's `folded`).
        const after = bind.index + bind[0].length;
        const next = new RegExp(`\\b(?:const|let)\\s+${name}\\b`, "g");
        next.lastIndex = after;
        const end = next.exec(text)?.index ?? text.length;
        const read = new RegExp(`\\b${name}(?:\\.state)?\\.outcome\\b(?!\\s*\\()`, "g");
        for (const m of text.slice(after, end).matchAll(read)) property.push(`${rel}: ${m[0]}`);
      }
    }
    // Anti-vacuity: the scan saw the fold call sites it exists for (the eight readers above fold, and more).
    expect(foldSites).toBeGreaterThanOrEqual(8);
    expect(boundNames).toBeGreaterThanOrEqual(5);
    expect(property, `${foldSites} fold call sites, ${boundNames} fold bindings scanned`).toEqual([]);
  });
  it("every allowed file still exists and still holds a bare call (a stale entry is a failure)", () => {
    for (const rel of Object.keys(ALLOWED)) expect(readFileSync(join(REPO, rel), "utf8"), rel).toMatch(BARE);
  });
});
