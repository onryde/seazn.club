// Every tools/matrix module must LOAD under `node --experimental-strip-types`.
//
// Copied from the bench's own gate (tools/bench/lib/__tests__/strip-types-
// loadable.test.ts), which exists because the bench shipped a whole wave
// unrunnable. The harness runs as `node --experimental-strip-types`, and
// strip-only mode can DELETE type annotations but cannot SYNTHESISE code. So a
// construct that needs a transform — a TS `enum`, a `namespace`, a constructor
// parameter property — is refused outright:
//
//     SyntaxError [ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX]:
//     TypeScript parameter property is not supported in strip-only mode
//
// The bench's `schedule.ts` carried `constructor(private readonly divisionRef:
// string) {}` through 1150 passing tests, a clean `tsc -p
// tsconfig.scripts.json`, a clean eslint, two implementer rounds and three
// reviewer passes. Every one of those gates is blind to it, because vitest
// transpiles with esbuild and tsc only typechecks. The FIRST live run died on
// the import, before a single HTTP call.
//
// Why a spawned import rather than something cheaper: `node
// --experimental-strip-types --check <file>` exits 0 on the broken file. It is
// a syntax check and never reaches the stripping transform, so it cannot see
// this class at all. Only actually loading the module does — and loading it
// also proves every relative import carries its `.ts` and every bare import
// resolves (ERR_MODULE_NOT_FOUND), which vitest's resolver would forgive.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const MATRIX = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Every `.ts` the harness SHIPS — the modules a real run loads. Test files
 *  are excluded on purpose: vitest loads those, and vitest transpiles, so they
 *  are never subject to strip-only mode. */
function shipped(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "__tests__" && e.name !== "node_modules") shipped(full, out); continue; }
    if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

const MODULES = shipped(MATRIX).sort();

describe("every shipped tools/matrix module loads under --experimental-strip-types", () => {
  // The discovery guard, FIRST. A walker that returned `[]` would make every
  // `it.each` row below disappear and the file would report green having
  // checked nothing — an empty set satisfies a for-all vacuously.
  it("discovery guard: at least the catalogue is found", () => {
    expect(MODULES.some((f) => f.endsWith("lib/catalogue.ts"))).toBe(true);
  });

  // W1c Task 4's modules, named: the walker finds them today, and a move or a
  // rename that dropped one out of the walk would otherwise shrink the list
  // below silently. The browser ones load playwright (a bare import) and the
  // bench's tap helpers, so their load also proves those resolve.
  const W1C_T4 = [
    "lib/widths.ts", "lib/driver/envelope.ts", "lib/pads/execute.ts",
    "lib/browser/budget.ts", "lib/browser/viewports.ts", "lib/browser/selectors.ts",
    "lib/browser/session.ts", "lib/browser/respond.ts", "lib/browser/evidence.ts",
  ];
  it("W1c Task 4's modules are all in the walk", () => {
    const missing = W1C_T4.filter((rel) => !MODULES.includes(join(MATRIX, rel)));
    expect(W1C_T4.length).toBe(9);
    expect(missing).toEqual([]);
  });

  // W1c Task 5's page objects, named for the same reason. Their loads also
  // prove the bench's scorer.ts and execute.ts resolve from lib/browser/pages,
  // and that the functions evaluateAll serialises (standingsCellsOf,
  // championFrom) survive strip-only mode as plain JS.
  const W1C_T5 = [
    "lib/browser/pages/ctx.ts", "lib/browser/pages/paths.ts", "lib/browser/pages/competition.ts",
    "lib/browser/pages/division-builder.ts", "lib/browser/pages/entrants.ts", "lib/browser/pages/launch.ts",
    "lib/browser/pages/stage-rail.ts", "lib/browser/pages/run-sheet.ts", "lib/browser/pages/fixture-console.ts",
    "lib/browser/pages/standings.ts", "lib/browser/pages/public-division.ts",
  ];
  it("W1c Task 5's page objects are all in the walk", () => {
    const missing = W1C_T5.filter((rel) => !MODULES.includes(join(MATRIX, rel)));
    expect(W1C_T5.length).toBe(11);
    expect(missing).toEqual([]);
  });

  // W1c Task 6's modules, named for the same reason. browser-run.ts is what
  // run.ts loads lazily (a dynamic import the module load never follows), so
  // its own row below is the only strip-types load it gets before a live run.
  const W1C_T6 = ["lib/driver/mixed.ts", "lib/driver/browser-driver.ts", "lib/browser/browser-run.ts"];
  it("W1c Task 6's modules are all in the walk", () => {
    const missing = W1C_T6.filter((rel) => !MODULES.includes(join(MATRIX, rel)));
    expect(W1C_T6.length).toBe(3);
    expect(missing).toEqual([]);
  });

  // W1c Task 7's modules, named for the same reason. The adapters import the
  // bench's generic adapter and tap vocabulary (ruling 38), so their load
  // proves those resolve under strip-only mode too.
  const W1C_T7 = [
    "lib/pads/types.ts", "lib/pads/replay.ts", "lib/pads/generic.ts", "lib/pads/badminton.ts", "lib/pads/index.ts",
    "lib/pads/padpage-assignability.ts", "lib/pad-sports.ts", "lib/pad-proof-set.ts", "lib/scenarios/pad-proof.ts",
  ];
  it("W1c Task 7's modules are all in the walk", () => {
    const missing = W1C_T7.filter((rel) => !MODULES.includes(join(MATRIX, rel)));
    expect(W1C_T7.length).toBe(9);
    expect(missing).toEqual([]);
  });

  // W1c Tasks 9–11: the other nine sports' pad adapters, each loaded on its own.
  const W1C_T9_11 = [
    "lib/pads/volleyball.ts", "lib/pads/tabletennis.ts", "lib/pads/tennis.ts",
    "lib/pads/football.ts", "lib/pads/period.ts", "lib/pads/icehockey.ts", "lib/pads/hockey.ts",
    "lib/pads/cricket.ts", "lib/pads/boardgame.ts", "lib/pads/carrom.ts",
    "lib/pads/judge.ts", // fix round 1 (I-1): every fallback's judge
  ];
  it("W1c Tasks 9–11's modules are all in the walk", () => {
    const missing = W1C_T9_11.filter((rel) => !MODULES.includes(join(MATRIX, rel)));
    expect(W1C_T9_11.length).toBe(11);
    expect(missing).toEqual([]);
  });

  // W1c Task 8 (carry M-6): the served-hold preflight browser-run.ts calls
  // before any case — its own row below is its only load before a live run.
  const W1C_T8 = ["lib/browser/served-hold.ts"];
  it("W1c Task 8's modules are all in the walk", () => {
    const missing = W1C_T8.filter((rel) => !MODULES.includes(join(MATRIX, rel)));
    expect(W1C_T8.length).toBe(1);
    expect(missing).toEqual([]);
  });

  // W1c Task 12: the layer planners and the D7 wave map (a leaf, so the
  // planners reach it without the browser layer).
  const W1C_T12 = ["lib/layers.ts", "lib/api-only-ui.ts"];
  it("W1c Task 12's modules are all in the walk", () => {
    const missing = W1C_T12.filter((rel) => !MODULES.includes(join(MATRIX, rel)));
    expect(W1C_T12.length).toBe(2);
    expect(missing).toEqual([]);
  });

  // W1c Task 13: the parity CLI and its library (its package script's run is
  // the only other load before Task 14's live parity).
  const W1C_T13 = ["parity.ts", "lib/parity.ts"];
  it("W1c Task 13's modules are all in the walk", () => {
    const missing = W1C_T13.filter((rel) => !MODULES.includes(join(MATRIX, rel)));
    expect(W1C_T13.length).toBe(2);
    expect(missing).toEqual([]);
  });

  // W1-driving Task 1: the one routing construct (D7), a leaf every routing
  // module reaches at load — cricket's stream, the model, the catalogue.
  const W1DRV_T1 = ["lib/routing.ts"];
  it("W1-driving Task 1's modules are all in the walk", () => {
    const missing = W1DRV_T1.filter((rel) => !MODULES.includes(join(MATRIX, rel)));
    expect(W1DRV_T1.length).toBe(1);
    expect(missing).toEqual([]);
  });

  // W1-driving Task 2: the per-format field size every scripted scenario asks.
  const W1DRV_T2 = ["lib/field-size.ts"];
  it("W1-driving Task 2's modules are all in the walk", () => {
    const missing = W1DRV_T2.filter((rel) => !MODULES.includes(join(MATRIX, rel)));
    expect(W1DRV_T2.length).toBe(1);
    expect(missing).toEqual([]);
  });

  // W1-driving Task 3: the roster and lineup builders (D2), which reach the
  // engine's catalog through a bare import at load.
  const W1DRV_T3 = ["lib/scenarios/rosters.ts"];
  it("W1-driving Task 3's modules are all in the walk", () => {
    const missing = W1DRV_T3.filter((rel) => !MODULES.includes(join(MATRIX, rel)));
    expect(W1DRV_T3.length).toBe(1);
    expect(missing).toEqual([]);
  });

  // W1-driving Task 6: the seed advance (D1) — confirm, the tie pick, and
  // the take vocabulary — which common.ts value-imports at load.
  const W1DRV_T6 = ["lib/scenarios/advance.ts"];
  it("W1-driving Task 6's modules are all in the walk", () => {
    const missing = W1DRV_T6.filter((rel) => !MODULES.includes(join(MATRIX, rel)));
    expect(W1DRV_T6.length).toBe(1);
    expect(missing).toEqual([]);
  });
  const W1DRV_T7 = ["lib/scenarios/ladder-loop.ts"];
  it("W1-driving Task 7's modules are all in the walk", () => {
    const missing = W1DRV_T7.filter((rel) => !MODULES.includes(join(MATRIX, rel)));
    expect(W1DRV_T7.length).toBe(1);
    expect(missing).toEqual([]);
  });

  // W1-driving Task 8: the americano and mexicano round loops (D9).
  const W1DRV_T8 = ["lib/scenarios/americano-loop.ts"];
  it("W1-driving Task 8's modules are all in the walk", () => {
    const missing = W1DRV_T8.filter((rel) => !MODULES.includes(join(MATRIX, rel)));
    expect(W1DRV_T8.length).toBe(1);
    expect(missing).toEqual([]);
  });

  // W1-driving Task 9: the engine-derived terminal final keys I2 reads (ruling 45).
  const W1DRV_T9 = ["lib/scenarios/terminal-finals.ts"];
  it("W1-driving Task 9's modules are all in the walk", () => {
    const missing = W1DRV_T9.filter((rel) => !MODULES.includes(join(MATRIX, rel)));
    expect(W1DRV_T9.length).toBe(1);
    expect(missing).toEqual([]);
  });

  // W1-driving Task 11: the in-process worker queue (ruling 46).
  const W1DRV_T11 = ["lib/workers.ts"];
  it("W1-driving Task 11's modules are all in the walk", () => {
    const missing = W1DRV_T11.filter((rel) => !MODULES.includes(join(MATRIX, rel)));
    expect(W1DRV_T11.length).toBe(1);
    expect(missing).toEqual([]);
  });

  // W1-driving Task 12: the w1-driving planner set.
  const W1DRV_T12 = ["lib/w1-driving-set.ts"];
  it("W1-driving Task 12's modules are all in the walk", () => {
    const missing = W1DRV_T12.filter((rel) => !MODULES.includes(join(MATRIX, rel)));
    expect(W1DRV_T12.length).toBe(1);
    expect(missing).toEqual([]);
  });

  // W1-driving Task 13: the catalog templates the browser drives through their cards (D11).
  const W1DRV_T13 = ["lib/templates.ts"];
  it("W1-driving Task 13's modules are all in the walk", () => {
    const missing = W1DRV_T13.filter((rel) => !MODULES.includes(join(MATRIX, rel)));
    expect(W1DRV_T13.length).toBe(1);
    expect(missing).toEqual([]);
  });

  // W1-driving Task 14 fix round 1 (T14-R3): the lineup planner the harness and the model share.
  const W1DRV_T14 = ["lib/scenarios/lineup-plan.ts"];
  it("W1-driving Task 14's modules are all in the walk", () => {
    const missing = W1DRV_T14.filter((rel) => !MODULES.includes(join(MATRIX, rel)));
    expect(W1DRV_T14.length).toBe(1);
    expect(missing).toEqual([]);
  });

  // W1-driving Task 16 fix round 1 (T16-R4 m-6): the findings-table CLI that
  // generates _INDEX's per-case product-red table.
  const W1DRV_T16 = ["findings-table.ts"];
  it("W1-driving Task 16's modules are all in the walk", () => {
    const missing = W1DRV_T16.filter((rel) => !MODULES.includes(join(MATRIX, rel)));
    expect(W1DRV_T16.length).toBe(1);
    expect(missing).toEqual([]);
  });

  // W1d Task 1 (item 1, D10): the lock append-only gate, which CI runs as a
  // bare `node --experimental-strip-types` through its package script.
  const W1D_T1 = ["lib/lock-diff.ts", "lock-append-only.ts"];
  it("W1d Task 1's modules are all in the walk", () => {
    const missing = W1D_T1.filter((rel) => !MODULES.includes(join(MATRIX, rel)));
    expect(W1D_T1.length).toBe(2);
    expect(missing).toEqual([]);
  });

  // W1d Task 2: the filler-name leaf results.ts and driver/mixed.ts both read.
  const W1D_T2 = ["lib/fillers.ts"];
  it("W1d Task 2's modules are all in the walk", () => {
    const missing = W1D_T2.filter((rel) => !MODULES.includes(join(MATRIX, rel)));
    expect(W1D_T2.length).toBe(1);
    expect(missing).toEqual([]);
  });

  // W1d Task 4: the stripe, the shard merge and its CLI, and the run-id slug they share.
  const W1D_T4 = ["lib/shard.ts", "lib/merge.ts", "lib/run-id.ts", "merge-shards.ts"];
  it("W1d Task 4's modules are all in the walk", () => {
    const missing = W1D_T4.filter((rel) => !MODULES.includes(join(MATRIX, rel)));
    expect(W1D_T4.length).toBe(4);
    expect(missing).toEqual([]);
  });

  // W1d Task 6: the judge, its CLI, and the one exit-code table every CLI header is held to.
  const W1D_T6 = ["lib/judge.ts", "judge.ts", "lib/exit-codes.ts"];
  it("W1d Task 6's modules are all in the walk", () => {
    const missing = W1D_T6.filter((rel) => !MODULES.includes(join(MATRIX, rel)));
    expect(W1D_T6.length).toBe(3);
    expect(missing).toEqual([]);
  });

  // W1d Task 7 (named here by Task 8, ruling T7->T8 a): the per-PR sample's planner, the plan-string map the judge and
  // the sample both read (hoisted out of __tests__ so shipped code never reaches a test module), and the R27 reader CLI.
  const W1D_T7 = ["lib/pr-sample.ts", "lib/expected-plan.ts", "ci/pr-rows.ts"];
  it("W1d Task 7's modules are all in the walk", () => {
    const missing = W1D_T7.filter((rel) => !MODULES.includes(join(MATRIX, rel)));
    expect(W1D_T7.length).toBe(3);
    expect(missing).toEqual([]);
  });

  // W1d Task 8: the CI helpers — the job matrix and its derived timeouts, the run summary, the staleness signal, and the
  // thin gh wrapper they share. All four load as the package scripts run them, under strip-only mode.
  const W1D_T8 = ["ci/shard-matrix.ts", "ci/summary.ts", "ci/staleness.ts", "ci/gh.ts"];
  it("W1d Task 8's modules are all in the walk", () => {
    const missing = W1D_T8.filter((rel) => !MODULES.includes(join(MATRIX, rel)));
    expect(W1D_T8.length).toBe(4);
    expect(missing).toEqual([]);
  });

  // W1d Task 9: the per-PR sample's driver, which imports run-id, pr-sample, redact and variants and is spawned by its package script.
  const W1D_T9 = ["ci/run-sample.ts"];
  it("W1d Task 9's module is in the walk", () => {
    const missing = W1D_T9.filter((rel) => !MODULES.includes(join(MATRIX, rel)));
    expect(W1D_T9.length).toBe(1);
    expect(missing).toEqual([]);
  });

  // W1d Task 12 fix round 1 (T12-I1): the pad-innings set run.ts and the plan reader value-import.
  const W1D_T12 = ["lib/pad-innings-set.ts"];
  it("W1d Task 12's new module is in the walk", () => {
    const missing = W1D_T12.filter((rel) => !MODULES.includes(join(MATRIX, rel)));
    expect(W1D_T12.length).toBe(1);
    expect(missing).toEqual([]);
  });

  // W1d Task 14 (items 15c-15f): the two set modules run.ts and the plan reader value-import, and the VOIDPROOF
  // scenario the registry value-imports.
  const W1D_T14 = ["lib/match-day-set.ts", "lib/carry-1280-set.ts", "lib/scenarios/void-proof.ts"];
  it("W1d Task 14's new modules are in the walk", () => {
    const missing = W1D_T14.filter((rel) => !MODULES.includes(join(MATRIX, rel)));
    expect(W1D_T14.length).toBe(3);
    expect(missing).toEqual([]);
  });

  // Playwright's evaluateAll sends a function's SOURCE TEXT to the page. Under
  // strip-only mode that text is the stripped source, so it must compile as
  // plain JS on its own, outside its module — rebuilt here from toString().
  // It must also RUN there: a module constant referenced inside a loop body
  // compiles fine and is a ReferenceError in the browser only once the loop
  // has a row to visit. So the rebuilt functions are fed a real table and a
  // real banner (a plain-JS twin of page-objects.test.ts's fake DOM), and each
  // answer must equal the in-module function's on the same input.
  const FAKE_DOM = String.raw`
    function el(tag, attrs = {}, kids = []) {
      const children = kids.filter((k) => typeof k !== "string");
      const node = {
        tagName: tag.toUpperCase(), children, nextElementSibling: null,
        get textContent() { return kids.map((k) => (typeof k === "string" ? k : k.textContent ?? "")).join(""); },
        getAttribute: (n) => (n in attrs ? attrs[n] : null),
        matches(s) {
          const m = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(s);
          if (m === null) throw new Error("fake DOM: unsupported selector " + s);
          return m[2] === undefined ? m[1] in attrs : attrs[m[1]] === m[2];
        },
        querySelector(s) {
          for (const c of children) { if (c.matches(s)) return c; const deep = c.querySelector(s); if (deep !== null) return deep; }
          return null;
        },
      };
      children.forEach((c, i) => { c.nextElementSibling = children[i + 1] ?? null; });
      return node;
    }`;
  it("the functions evaluateAll ships to the page compile and run from their own source, outside their module, on a real table and banner", () => {
    const mod = (rel: string) => JSON.stringify(pathToFileURL(join(MATRIX, rel)).href);
    const code = [
      `const s = await import(${mod("lib/browser/pages/standings.ts")});`,
      `const p = await import(${mod("lib/browser/pages/public-division.ts")});`,
      `const { NAME } = await import(${mod("lib/browser/selectors.ts")});`,
      FAKE_DOM,
      "const rebuilt = (f) => new Function(\"return (\" + f.toString() + \")\")();",
      "const row = (rank, name) => el('tr', {}, [el('td', {}, [rank]), el('th', { scope: 'row' }, [el('span', {}, [el('span', { title: name }, [name.slice(0, 6)])])]), el('td', {}, ['3'])]);",
      "const table = el('table', {}, [el('caption', {}, ['Pool A']), el('thead', {}, [el('tr', {}, [el('th', { scope: 'col', title: 'Points' }, ['Pts'])])]), el('tbody', {}, [row('1', 'Matrix Player 1'), el('tr', {}, [el('td', { colspan: '3' }, ['Qualify'])]), row('2', 'Matrix Player 2')])]);",
      "const label = NAME.championLabel.text;",
      "const banner = el('div', {}, [el('p', {}, ['Intro']), el('p', {}, [label]), el('p', {}, [' Matrix Player 1 '])]);",
      "const out = (cellsOf, championFrom) => ({ cells: cellsOf([table], s.CELL_SELECTORS), empty: cellsOf([], s.CELL_SELECTORS), champion: championFrom(banner.children, label), none: championFrom([], label) });",
      "console.log(JSON.stringify({ rebuilt: out(rebuilt(s.standingsCellsOf), rebuilt(p.championFrom)), inModule: out(s.standingsCellsOf, p.championFrom) }));",
    ].join("\n");
    const r = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", code], { cwd: resolve(MATRIX, "..", ".."), encoding: "utf8", timeout: 25_000 });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    const got = JSON.parse(r.stdout.trim()) as { rebuilt: { cells: string[][][] }; inModule: unknown };
    expect(got.rebuilt).toEqual({ cells: [[["1", "Matrix Player 1"], ["2", "Matrix Player 2"]]], empty: [], champion: "Matrix Player 1", none: null });
    expect(got.rebuilt).toEqual(got.inModule);
    // The loop bodies ran: two rows were read, not zero.
    expect(got.rebuilt.cells.flat().length).toBe(2);
  });

  // W1c Task 8 review I-1 (fix round 1): waitForFunction sends the hydration
  // probe's SOURCE to the page as well, so it too must compile and run from
  // its stripped source alone — fed hydrated, bare, replaced and zero elements.
  it("the hydration probe waitForFunction ships to the page compiles and runs from its own source, outside its module", () => {
    const code = [
      `const c = await import(${JSON.stringify(pathToFileURL(join(MATRIX, "lib/browser/pages/ctx.ts")).href)});`,
      "const rebuilt = new Function(\"return (\" + c.hydrationState.toString() + \")\")();",
      "const key = c.REACT_PROPS_KEY + 'r4nd0m';",
      "const el = (hydrated, connected = true) => Object.assign({ isConnected: connected }, hydrated ? { [key]: {} } : {});",
      "const cases = [[el(true)], [el(true), el(false)], [el(false)], [el(true), el(true, false)], []];",
      "const run = (f) => cases.map((els) => f({ els, prefix: c.REACT_PROPS_KEY }));",
      "console.log(JSON.stringify({ rebuilt: run(rebuilt), inModule: run(c.hydrationState) }));",
    ].join("\n");
    const r = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", code], { cwd: resolve(MATRIX, "..", ".."), encoding: "utf8", timeout: 25_000 });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    const got = JSON.parse(r.stdout.trim()) as { rebuilt: unknown[]; inModule: unknown[] };
    expect(got.rebuilt).toEqual(["hydrated", false, false, "replaced", "replaced"]);
    expect(got.rebuilt).toEqual(got.inModule);
  });

  it.each(MODULES)("%s", (file) => {
    const r = spawnSync(
      process.execPath,
      ["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", `await import(${JSON.stringify(pathToFileURL(file).href)});`],
      { cwd: resolve(MATRIX, "..", ".."), encoding: "utf8", timeout: 25_000 },
    );
    expect(r.stderr, file).not.toMatch(/ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX|SyntaxError|ERR_MODULE_NOT_FOUND/);
    expect(r.status, `${file}\n${r.stderr}`).toBe(0);
  });
});
