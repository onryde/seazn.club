import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Finding 1 (W2a): a settle lives beside module state, so a fold's outcome is
// `outcomeOf(module, folded)`. A bare `<module>.outcome(state)` on a FOLD
// result silently drops a settle (class 1, the inert seam). Each remaining bare
// call is listed with why it is not a fold result.
const REPO = resolve(__dirname, "../../../../../..");
const ROOTS = ["apps/web/src", "packages/engine/src", "tools/matrix/lib"];
// Any argument name (review Minor 2): `module.outcome(finalState)` drops a settle
// exactly like `module.outcome(state)` does. Comments are stripped before
// counting (they name the shape), and every allowed file declares HOW MANY bare
// calls it holds, so a new one in an allowed file is caught too.
const BARE = /\b[A-Za-z_$][\w$]*\.outcome\(/g;
const ALLOWED: Readonly<Record<string, { calls: number; reason: string }>> = {
  "packages/engine/src/core/events.ts": { calls: 3, reason: "the kernel itself: the decided flag, outcomeOf, and kernelOwnsEvent's settled-finalize test" },
  "apps/web/src/server/overlay/recent.ts": { calls: 2, reason: "a point-state PROBE over a stored module state, not a fold result; a settlement is never part of module state, so outcomeOf cannot apply (preflight C8)" },
  "packages/engine/src/testkit/stoppages.ts": { calls: 1, reason: "testkit: module-level conformance, no settle in its streams" },
  "packages/engine/src/testkit/conformance.ts": { calls: 5, reason: "testkit: module-level conformance, no settle in its streams" },
  "packages/engine/src/testkit/simulation.ts": { calls: 3, reason: "testkit: simulation folds without settle" },
  "packages/engine/src/testkit/scenarios.ts": { calls: 6, reason: "testkit: scenario builder; `played.state` comes from decidedStream, which drives module.apply with the module's own generated events — never a kernel-owned type" },
  "packages/engine/src/testkit/golden.ts": { calls: 1, reason: "the frozen corpus records the MODULE's outcome (GOLDEN-POLICY: the per-sport back-compat tripwire); no corpus stream carries core.settle — guarded below, not assumed" },
};
const stripComments = (text: string): string => text.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
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
    const allowedSeen: Record<string, number> = {};
    let scanned = 0;
    for (const f of files) {
      const rel = relative(REPO, f);
      const text = stripComments(readFileSync(f, "utf8"));
      if (/\boutcomeOf\(/.test(text) && rel !== "packages/engine/src/core/events.ts") readers.push(rel);
      const calls = [...text.matchAll(BARE)].map((m) => text.slice(m.index, text.indexOf(")", m.index) + 1));
      scanned += calls.length;
      if (ALLOWED[rel] !== undefined) allowedSeen[rel] = calls.length;
      else for (const c of calls) bare.push(`${rel}: ${c}`);
    }
    expect(bare, `${scanned} bare .outcome( calls scanned`).toEqual([]);
    // Each allowed file holds exactly the calls it declares — a new one there is a new reader, and must be argued.
    expect(allowedSeen).toEqual(Object.fromEntries(Object.entries(ALLOWED).map(([rel, { calls }]) => [rel, calls])));
    expect(scanned).toBeGreaterThan(0);
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
    for (const rel of Object.keys(ALLOWED)) expect(stripComments(readFileSync(join(REPO, rel), "utf8")), rel).toMatch(BARE);
  });
  it("golden.ts's allowance holds: no golden corpus stream carries core.settle (the reason is a guard, not a comment)", () => {
    const SPORTS = join(REPO, "packages/engine/src/sports");
    let streams = 0;
    const settled: string[] = [];
    for (const dir of readdirSync(SPORTS)) {
      if (!statSync(join(SPORTS, dir)).isDirectory()) continue;
      for (const file of readdirSync(join(SPORTS, dir)).filter((n) => n.endsWith(".golden.json"))) {
        const corpus = JSON.parse(readFileSync(join(SPORTS, dir, file), "utf8")) as { streams: { events: { type: string }[] }[] };
        corpus.streams.forEach((stream, i) => {
          streams++;
          if (stream.events.some((e) => e.type === "core.settle")) settled.push(`${file}#${i}`);
        });
      }
    }
    expect(streams).toBeGreaterThan(200);
    expect(settled).toEqual([]);
  });
});

// W2a review I-1: two hand-rolled replay loops (the match-centre timeline, the
// overlay's recent window) handed core.settle to module.apply — every sport
// throws INVALID_EVENT on it, so every settled fixture lost its derived lines and
// logged a warning on every render. The engine's own fold dispatches on
// `kernelOwnsEvent`; every OTHER loop that calls `<module>.apply(` must skip on the
// same predicate, or be listed here with why it is not a replay of a stored ledger.
describe("review I-1: every module.apply replay loop skips what the kernel owns", () => {
  const APPLY = /\b\w*[Mm]odule\.apply\(/g;
  const NOT_A_LEDGER_REPLAY: readonly { file: string; call?: string; reason: string }[] = [
    { file: "apps/web/src/server/overlay/recent.ts", call: "next = module.apply(", reason: "the point-state PROBE: one synthetic module event applied to a stored state, never a ledger event" },
    { file: "packages/engine/src/testkit/helpers.ts", reason: "testkit: buildStream drives apply with a module's own events" },
    { file: "packages/engine/src/testkit/conformance.ts", reason: "testkit: conformance drives apply with a module's own generated events" },
    { file: "packages/engine/src/testkit/conformance-pad.ts", reason: "testkit: the registry/dispatch drift probe (one call, one message naming it)" },
    { file: "packages/engine/src/testkit/simulation.ts", reason: "testkit: simulation drives apply with a module's own generated events" },
    { file: "packages/engine/src/testkit/scenarios.ts", reason: "testkit: scenario builder drives apply with a module's own generated events" },
  ];
  it("each module.apply call either sits in a loop that consults kernelOwnsEvent before it, or is listed with its reason", () => {
    const files = ROOTS.flatMap((r) => walk(join(REPO, r), []));
    let sites = 0;
    let guarded = 0;
    const unguarded: string[] = [];
    const listedSeen = new Set<string>();
    for (const f of files) {
      const rel = relative(REPO, f);
      const text = stripComments(readFileSync(f, "utf8"));
      for (const m of text.matchAll(APPLY)) {
        sites++;
        const line = text.slice(text.lastIndexOf("\n", m.index) + 1, text.indexOf("\n", m.index));
        const listed = NOT_A_LEDGER_REPLAY.find((x) => x.file === rel && (x.call === undefined || line.includes(x.call)));
        if (listed !== undefined) { listedSeen.add(`${listed.file}|${listed.call ?? ""}`); continue; }
        // The loop it sits in: from the nearest `for (` before it. The skip must come between the two.
        const loop = text.lastIndexOf("for (", m.index);
        if (loop !== -1 && text.slice(loop, m.index).includes("kernelOwnsEvent(")) guarded++;
        else unguarded.push(`${rel}: ${line.trim()}`);
      }
    }
    expect(unguarded, `${sites} module.apply call sites scanned`).toEqual([]);
    // The kernel's own fold, the timeline and the overlay's recent replay — and every listed entry is still real.
    expect(guarded).toBeGreaterThanOrEqual(3);
    expect([...listedSeen].sort()).toEqual(NOT_A_LEDGER_REPLAY.map((x) => `${x.file}|${x.call ?? ""}`).sort());
  });
});
