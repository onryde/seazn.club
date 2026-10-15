import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SETTLE_METHODS, settledMethod } from "@seazn/engine/core";

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
  "apps/web/src/server/public-site/public-player-matches.ts": { calls: 1, reason: "W2b PF-1 off STORED rows (no fold): whether the module's own stored state held the level result a stored withdrawal award was admitted over (storedLevelWithdrawal); a settled fixture's outcome is a win and returns before the read" },
  "packages/engine/src/testkit/stoppages.ts": { calls: 1, reason: "testkit: module-level conformance, no settle in its streams" },
  "packages/engine/src/testkit/conformance.ts": { calls: 5, reason: "testkit: module-level conformance, no settle in its streams" },
  "packages/engine/src/testkit/simulation.ts": { calls: 3, reason: "testkit: simulation folds without settle" },
  "packages/engine/src/testkit/scenarios.ts": { calls: 6, reason: "testkit: scenario builder; `played.state` comes from decidedStream, which drives module.apply with the module's own generated events — never a kernel-owned type" },
  "packages/engine/src/testkit/golden-floor.ts": { calls: 1, reason: "golden floor (GF-1): the module-level outcome of a generator walk, to learn which outcome kinds a module can produce; no walk carries core.settle" },
  "packages/engine/src/testkit/golden-floor-streams.ts": { calls: 1, reason: "golden floor (GF-1): the one bare read (`moduleOutcome`) of the module's outcome, to find a walk that is decided or a prefix that is still live; the settle story (GF-2 T3) reads the kernel's outcome through `effectiveToken`/`outcomeOf`, and the corpus scan below holds every settle stream to a settled win" },
  "packages/engine/src/testkit/golden.ts": { calls: 1, reason: "the format-1 recorder (`moduleRecorder`) records the MODULE's outcome; format 2 (every committed corpus since GF-2) records the effective outcome through outcomeOf in golden-overlay.ts. A stream carrying core.settle is guarded below, not assumed" },
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

describe("W2b PF-1 (loop D carry-in): every summary reader in apps/web goes through summaryOf", () => {
  // The headline twin of finding 1: a withdrawal admitted over a held level result lives beside module state
  // (`levelWithdrawal`), so a bare `<module>.summary(state)` keeps showing the draw the table no longer credits.
  // apps/web only — the engine's own summaryOf is the one place that may call it.
  const BARE_SUMMARY = /\b[A-Za-z_$][\w$]*\.summary\(/g;
  it("no bare <module>.summary( in apps/web/src, and summaryOf's web readers are exactly these", () => {
    const files = walk(join(REPO, "apps/web/src"), []);
    expect(files.length).toBeGreaterThan(100);
    const bare: string[] = [];
    const readers: string[] = [];
    for (const f of files) {
      const rel = relative(REPO, f);
      const text = stripComments(readFileSync(f, "utf8"));
      for (const m of text.matchAll(BARE_SUMMARY)) bare.push(`${rel}: ${text.slice(m.index, text.indexOf(")", m.index) + 1)}`);
      if (/\bsummaryOf\(/.test(text)) readers.push(rel);
    }
    expect(bare, `${files.length} files scanned`).toEqual([]);
    expect(readers.sort()).toEqual([
      "apps/web/src/components/v2/scorepad/use-pad-pipeline.ts",
      "apps/web/src/server/engine-db/append-event.ts",
      // R116-2: the module's own summary of an award no event recorded (ruling 116's walkover) — the fold of an empty
      // ledger holding the award, so a bare module.summary( is never needed.
      "apps/web/src/server/engine-db/awarded-state.ts",
      "apps/web/src/server/engine-db/fold.ts",
      "apps/web/src/server/overlay/recent.ts",
      "apps/web/src/server/public-site/public-player-matches.ts",
      "apps/web/src/server/public-site/timeline.ts",
    ]);
  });
});

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
    // (ruling D-C3). A later task that adds a reader adds it here by name. W2b ruling 112: the testkit's
    // `onePlayEvent` refuses a drawn event that decides the match, through outcomeOf (settle-aware like every reader).
    // R116-2: `awardedMatchState` refuses a walkover whose fold decides other than the stored award. Ruling 120: the
    // testkit's `afterStartEvents` keeps only a sport event that leaves the match undecided after a Start, through
    // outcomeOf (shared by the ruling-114 and ruling-120 sweeps).
    expect(readers.sort()).toEqual([
      "apps/web/src/server/engine-db/append-event.ts",
      "apps/web/src/server/engine-db/awarded-state.ts",
      "apps/web/src/server/engine-db/fold.ts",
      "apps/web/src/server/usecases/event-import.ts",
      "packages/engine/src/sports/carrom/carrom.ts",
      "packages/engine/src/sports/cricket/scorecard.ts",
      "packages/engine/src/sports/generic/generic.ts",
      "packages/engine/src/testkit/after-start-events.ts",
      // GF-1 review fix 2: the floor's undo stream asks the EFFECTIVE outcome whether a mis-tapped forfeit decided the match
      // and the void reopened it (`effectiveToken`) — the module's own outcome never sees a kernel forfeit.
      "packages/engine/src/testkit/golden-floor-streams.ts",
      // GF-1: the golden floor's `settleProbe` folds a settled ledger and reads its EFFECTIVE outcome through outcomeOf,
      // to prove the settle exemption is still needed (the harness records the module's bare outcome instead).
      "packages/engine/src/testkit/golden-floor.ts",
      // GF-2 T1: the golden recorder's format 2 records the EFFECTIVE outcome of every prefix fold (`effectiveFacts`,
      // `denseOverlay`), so a corpus pins what the server stores and the phone shows, not the module's bare answer.
      "packages/engine/src/testkit/golden-overlay.ts",
      "packages/engine/src/testkit/play-event.ts",
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
  it("golden.ts's allowance holds: every corpus stream that carries core.settle is recorded by the format-2 recorder, and ends on a settled win (the reason is a guard, not a comment)", () => {
    const SPORTS = join(REPO, "packages/engine/src/sports");
    const settledMethods = SETTLE_METHODS.map(settledMethod);
    let streams = 0;
    let settleStreams = 0;
    let checked = 0; // streams whose standing settle was read against the recorded outcome
    let struck = 0; // settles a later void strikes (the "said again" half of every settle story)
    const wrong: string[] = [];
    const sports = new Set<string>();
    for (const dir of readdirSync(SPORTS)) {
      if (!statSync(join(SPORTS, dir)).isDirectory()) continue;
      for (const file of readdirSync(join(SPORTS, dir)).filter((n) => n.endsWith(".golden.json"))) {
        const corpus = JSON.parse(readFileSync(join(SPORTS, dir, file), "utf8")) as {
          format?: number;
          streams: { config: string; seed: number; outcome: string; events: { type: string; voids?: string }[] }[];
        };
        corpus.streams.forEach((stream, i) => {
          streams++;
          const settles = stream.events.map((e, k) => (e.type === "core.settle" ? k : -1)).filter((k) => k >= 0);
          if (settles.length === 0) return;
          settleStreams++;
          sports.add(file);
          const label = `${file}#${i} (${stream.config}#${stream.seed})`;
          // a settle only ever reaches a format-2 corpus: the format-1 recorder would have written the module's answer
          if (corpus.format !== 2) wrong.push(`${label}: carries core.settle in a format-${corpus.format ?? 1} corpus`);
          // the settle in force at the end (no later void strikes it) decides the match: the recorded outcome is a settled win
          const standing = settles.filter((k) => !stream.events.some((e) => e.voids === `e-${k}`));
          struck += settles.length - standing.length;
          if (standing.length === 0) return;
          checked++;
          const outcome = JSON.parse(stream.outcome) as { kind?: string; method?: string } | null;
          if (outcome === null || outcome.kind !== "win" || !settledMethods.includes(outcome.method as never)) wrong.push(`${label}: ends on ${stream.outcome}, not a settled win`);
        });
      }
    }
    expect(streams).toBeGreaterThan(200);
    expect(settleStreams, "a settle stream in every sport's corpus").toBeGreaterThanOrEqual(sports.size);
    expect(sports.size, "every sport records a settle").toBeGreaterThanOrEqual(11);
    // Anti-vacuity: a stream whose settle is struck and never said again is skipped, so a scan that skipped EVERY stream would
    // read as clean. Every sport's settle story ends on a standing settle and strikes one on the way.
    expect(checked, "a standing settle was actually checked in every sport").toBeGreaterThanOrEqual(sports.size);
    expect(struck, "a struck settle in every sport").toBeGreaterThanOrEqual(sports.size);
    expect(wrong).toEqual([]);
  });
});

// W2a review I-1: two hand-rolled replay loops (the match-centre timeline, the
// overlay's recent window) handed core.settle to module.apply — every sport
// throws INVALID_EVENT on it, so every settled fixture lost its derived lines and
// logged a warning on every render. The engine's own fold dispatches on
// `kernelOwnsEvent`; every OTHER loop that calls `.apply(` must skip on the
// same predicate, or be listed here with why it is not a replay of a stored ledger.
// ANY receiver (review N2): a loop over `sport.apply(` or `m?.apply(` drops a settle
// exactly like one over `module.apply(` does, so the scan names no receiver at all.
describe("review I-1: every module.apply replay loop skips what the kernel owns", () => {
  const APPLY = /\.apply\(/g;
  const NOT_A_LEDGER_REPLAY: readonly { file: string; call?: string; reason: string }[] = [
    { file: "apps/web/src/server/overlay/recent.ts", call: "next = module.apply(", reason: "the point-state PROBE: one synthetic module event applied to a stored state, never a ledger event" },
    { file: "packages/engine/src/history/history.ts", call: "REVERSIBLE[e.type]?.apply(", reason: "the DIVISION history ledger (schedule_applied, fixtures_generated, …): `REVERSIBLE[type].apply` folds schedule ops, never a match event — no sport module, no core.* type" },
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
    expect(unguarded, `${sites} .apply( call sites scanned`).toEqual([]);
    expect(sites).toBeGreaterThanOrEqual(guarded + NOT_A_LEDGER_REPLAY.length);
    // The kernel's own fold, the timeline and the overlay's recent replay — and every listed entry is still real.
    expect(guarded).toBeGreaterThanOrEqual(3);
    expect([...listedSeen].sort()).toEqual(NOT_A_LEDGER_REPLAY.map((x) => `${x.file}|${x.call ?? ""}`).sort());
  });
});
