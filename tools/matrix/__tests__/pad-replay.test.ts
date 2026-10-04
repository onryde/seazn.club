// The replay (W1c Task 7): one generated event → the adapter's taps → the
// ledger rows those taps wrote, compared with the event. Browser-free: a fake
// page records every tap, and a fake ledger releases the next queued row(s)
// when the replay releases the event's hold (its `pad-send-now` presence
// check — the one boundary the replay always crosses after an event's taps).
//
// Expected values come from the bench's contract (scorer.ts: exact in both
// directions, a tolerated key only as a plausible id) and the budget module's
// own constants, never from replay.ts.
import { describe, expect, it } from "vitest";
import { SEND_NOW_TESTID, TAP_WAIT_TIMEOUT_MS, selectorForTapStep, type PadLocator, type PadPage, type TapAdapterContext, type TapStep } from "../../../scripts/bench/lib/drivers/scorer.ts";
import type { LedgerRow } from "../../../scripts/bench/lib/ledger.ts";
import { FLOOR_MS, SLACK_MS, TAP_PACE_MS, budgetMs } from "../lib/browser/budget.ts";
import { compareRow, replayEvents, type ReplayDeps } from "../lib/pads/replay.ts";
import type { MatrixPadAdapter } from "../lib/pads/types.ts";
import type { StreamEvent } from "../lib/streams/types.ts";

const CTX: TapAdapterContext = { cfg: null, entrants: { home: "H", away: "A" } };
const SEND_NOW = `[data-testid="${SEND_NOW_TESTID}"]`;

interface FakePage extends PadPage { taps: string[] }
/** A page whose every control is there at once. A presence check of
 *  `pad-send-now` (releaseHold) commits the event just tapped to `deps`. */
function fakePage(deps: { commit(): void } | null = null): FakePage {
  const taps: string[] = [];
  const page: FakePage = {
    taps,
    locator(selector: string): PadLocator {
      return {
        click: async () => { taps.push(`click ${selector}`); },
        fill: async (v: string) => { taps.push(`fill ${selector} ${v}`); },
        waitFor: async () => undefined,
        count: async () => {
          if (selector === SEND_NOW) deps?.commit();
          return 0;
        },
      };
    },
    goto: async () => undefined,
    setViewportSize: async () => undefined,
  };
  return page;
}

type RowIn = { type: string; payload: unknown };
interface FakeDeps extends ReplayDeps { sleeps: number[]; polls: number; commit(): void; tips: number }
/** `rows` are released in `groups` (default: one row per committed event), at
 *  seqs after the server tip `tip`. */
function fakeDeps(rows: readonly RowIn[], o: { holdMs?: number; groups?: readonly number[]; tip?: number } = {}): FakeDeps {
  const ledgerRows: LedgerRow[] = [];
  const tip0 = o.tip ?? 1;
  let seq = tip0;
  let released = 0;
  let group = 0;
  const d: FakeDeps = {
    holdMs: o.holdMs ?? 3000,
    sleeps: [],
    polls: 0,
    tips: 0,
    tip: async () => { d.tips++; return tip0; },
    ledger: async (since: number) => { d.polls++; return ledgerRows.filter((r) => r.seq > since); },
    sleep: async (ms: number) => { d.sleeps.push(ms); },
    commit: () => {
      const n = o.groups?.[group++] ?? 1;
      for (let k = 0; k < n && released < rows.length; k++, released++) {
        seq++;
        ledgerRows.push({ id: `r${seq}`, seq, type: rows[released]!.type, payload: rows[released]!.payload });
      }
    },
  };
  return d;
}

/** A stub adapter: every event is `steps` taps on one tile. */
function stubAdapter(o: Partial<MatrixPadAdapter> & { steps?: number } = {}): MatrixPadAdapter {
  const n = o.steps ?? 1;
  return {
    sport: "stub", emits: [], fallbacks: [],
    stepsFor: () => Array.from({ length: n }, (_x, i): TapStep => ({ kind: "tile", tileId: `t${i}` })),
    ...o,
  };
}
const SUMMARY_TYPE = "stub.game.summary";
const SUMMARY = (home: number, away: number): StreamEvent => ({ type: SUMMARY_TYPE, payload: { home, away } });
/** The shape of a set-score sheet: a tile, then two number steps each with its confirm. */
const sheetAdapter = stubAdapter({
  stepsFor: (e) => {
    const p = e.payload as { home: number; away: number };
    return [{ kind: "tile", tileId: "setScore" }, { kind: "number", value: p.home }, { kind: "confirm" }, { kind: "number", value: p.away }, { kind: "confirm" }];
  },
});
const ROW = (type: string, payload: unknown = {}): RowIn => ({ type, payload });
/** A judge that accepts whatever rows it is shown — for the tests about row
 *  counts, not about judging (fix round 1, I-1: every fallback is judged). */
const ACCEPT = () => ({ ok: true, note: null });
const HALF = (side: "home" | "away"): StreamEvent => ({ type: "stub.point", payload: { side } });
const halfTapAdapter = stubAdapter({ stepsFor: (e) => [{ kind: "half", side: (e.payload as { side: "home" | "away" }).side }] });

async function run(adapter: MatrixPadAdapter, events: readonly StreamEvent[], deps: FakeDeps, page?: FakePage) {
  return replayEvents(page ?? fakePage(deps), adapter, events, CTX, deps);
}

describe("replayEvents — one event, its taps, the rows they wrote", () => {
  it("empty case first: no events → no taps, no rows, no findings", async () => {
    const deps = fakeDeps([]);
    const page = fakePage(deps);
    const r = await replayEvents(page, stubAdapter(), [], CTX, deps);
    expect(r).toEqual({ rows: [], stored: [], findings: [] });
    expect(page.taps).toEqual([]);
    expect(deps.polls).toBe(0);
  });

  it("one event → its steps, in order → one row compared exactly; the tip is the server's, read once", async () => {
    const deps = fakeDeps([ROW(SUMMARY_TYPE, { home: 21, away: 13 })], { tip: 4 });
    const page = fakePage(deps);
    const r = await run(sheetAdapter, [SUMMARY(21, 13)], deps, page);
    expect(r.rows.map((x) => x.verdict)).toEqual(["equal"]);
    // The rows as the product holds them: type, payload, and the seq and id the driver answers with.
    expect(r.stored.map(({ seq, type, payload }) => ({ seq, type, payload }))).toEqual([{ seq: 5, type: SUMMARY_TYPE, payload: { home: 21, away: 13 } }]);
    expect(r.stored[0]!.id).toEqual(expect.any(String));
    expect(r.rows[0]!.stored.map((s) => s.seq)).toEqual([5]);
    expect(r.findings).toEqual([]);
    expect(deps.tips).toBe(1);
    // The taps are the adapter's, then the hold released.
    expect(page.taps).toEqual([
      `click ${selectorForTapStep({ kind: "tile", tileId: "setScore" })}`,
      `fill ${selectorForTapStep({ kind: "number", value: 21 })} 21`, `click ${selectorForTapStep({ kind: "confirm" })}`,
      `fill ${selectorForTapStep({ kind: "number", value: 13 })} 13`, `click ${selectorForTapStep({ kind: "confirm" })}`,
    ]);
  });

  it("second event: its rows are read after the first event's last seq, never the first event's again", async () => {
    const deps = fakeDeps([ROW(SUMMARY_TYPE, { home: 21, away: 13 }), ROW(SUMMARY_TYPE, { home: 21, away: 16 })]);
    const r = await run(sheetAdapter, [SUMMARY(21, 13), SUMMARY(21, 16)], deps);
    expect(r.rows.map((x) => [x.verdict, x.stored.map((s) => s.seq)])).toEqual([["equal", [2]], ["equal", [3]]]);
    expect(r.stored.map(({ type, payload }) => ({ type, payload }))).toEqual([SUMMARY(21, 13), SUMMARY(21, 16)]);
    expect(r.stored.map((s) => s.seq)).toEqual([2, 3]);
  });

  it("a row whose payload differs is a mismatch naming the key, and replay stops there (the next tap would build on a wrong state)", async () => {
    const deps = fakeDeps([ROW(SUMMARY_TYPE, { home: 21, away: 12 })]);
    const page = fakePage(deps);
    const r = await run(sheetAdapter, [SUMMARY(21, 13), SUMMARY(21, 13)], deps, page);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ verdict: "mismatch", note: expect.stringContaining("away") });
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).toMatch(/stopped after event 1 of 2/);
    // What the product holds is still returned: the fold judges the stored stream.
    expect(r.stored.map(({ type, payload }) => ({ type, payload }))).toEqual([SUMMARY(21, 12)]);
    // The second event was never tapped.
    expect(page.taps.filter((t) => t.startsWith("click [data-tile-id"))).toHaveLength(1);
  });

  it("no row within the derived budget is `missing`, never a hang; the budget grows with HOLD_MS", async () => {
    const polls = async (holdMs: number) => {
      const deps = fakeDeps([], { holdMs });
      const r = await run(sheetAdapter, [SUMMARY(21, 13), SUMMARY(21, 13)], deps);
      expect(r.rows.map((x) => x.verdict)).toEqual(["missing"]);
      expect(r.rows[0]!.note).toMatch(/0 of 1 row\(s\) within \d+ms/);
      expect(r.findings[0]).toMatch(/stopped after event 1 of 2: row missing/);
      // Every poll after the first waited POLL_MS; the waits sum to the deadline, derived from the budget.
      const deadline = budgetMs({ taps: 5, holds: 1, holdMs });
      const waited = deps.sleeps.filter((ms) => ms !== TAP_PACE_MS).reduce((a, b) => a + b, 0);
      expect(waited).toBeGreaterThanOrEqual(deadline);
      return deps.polls;
    };
    const short = await polls(500);
    const long = await polls(3000);
    // The chosen holds put the 5-tap deadline on either side of the floor, so the counts differ.
    expect(budgetMs({ taps: 5, holds: 1, holdMs: 500 })).toBe(FLOOR_MS);
    expect(budgetMs({ taps: 5, holds: 1, holdMs: 3000 })).toBeGreaterThan(FLOOR_MS);
    expect(short).toBeLessThan(long);
  });

  it("a fallback event collects exactly its declared row count and is judged `fallback`, not per payload", async () => {
    const pad = stubAdapter({ fallbacks: [{ eventType: "cricket.innings.summary", writes: ["cricket.innings.summary", "cricket.innings.close"], why: "cricket.tsx:2579", rowsFor: () => 3, judge: ACCEPT }] });
    const deps = fakeDeps([ROW("cricket.innings.summary"), ROW("cricket.innings.summary"), ROW("cricket.innings.close"), ROW("x")], { groups: [3, 1] });
    const r = await run(pad, [{ type: "cricket.innings.summary", payload: {} }, { type: "x", payload: {} }], deps);
    expect(r.rows[0]).toMatchObject({ verdict: "fallback", note: "cricket.tsx:2579" });
    expect(r.rows[0]!.stored).toHaveLength(3);
    // The next event reads after the fallback's LAST row.
    expect(r.rows[1]).toMatchObject({ verdict: "equal" });
    expect(r.rows[1]!.stored.map((s) => s.seq)).toEqual([5]);
    expect(r.stored.map((s) => s.type)).toEqual(["cricket.innings.summary", "cricket.innings.summary", "cricket.innings.close", "x"]);
  });

  it("carry (d): a fallback whose rowsFor is not a whole number ≥ 1 (or throws) is refused by name BEFORE any tap — never a crash, never a pass on whatever rows came", async () => {
    // 0 and NaN used to crash at `mine.at(-1)!` (0 rows) or pass any rows (NaN
    // compares false both ways); a fallback writes at least one row by definition.
    let checked = 0;
    for (const [label, rowsFor] of [
      ["0", () => 0], ["NaN", () => Number.NaN], ["-1", () => -1], ["1.5", () => 1.5], ["Infinity", () => Number.POSITIVE_INFINITY],
      ["throws", () => { throw new Error("no count for this shape"); }],
    ] as const) {
      const pad = stubAdapter({ fallbacks: [{ eventType: "f", writes: ["f"], why: "f.tsx:1", rowsFor, judge: ACCEPT }] });
      const deps = fakeDeps([ROW("ok"), ROW("f")]);
      const page = fakePage(deps);
      const r = await run(pad, [{ type: "ok", payload: {} }, { type: "f", payload: {} }], deps, page);
      // The event before it replays normally; the fallback event taps nothing.
      expect(r.rows.map((x) => x.verdict), label).toEqual(["equal"]);
      expect(page.taps, label).toHaveLength(1);
      expect(r.findings, label).toHaveLength(1);
      expect(r.findings[0], label).toMatch(/^event 2 of 2 \(f\): FallbackRowsInvalid — rowsFor answered /);
      expect(r.findings[0], label).toContain(label === "throws" ? "no count for this shape" : `answered ${label}`);
      checked++;
    }
    expect(checked).toBe(6);
    // Its positive pair: a whole number ≥ 1 is accepted.
    const pad = stubAdapter({ fallbacks: [{ eventType: "f", writes: ["f"], why: "f.tsx:1", rowsFor: () => 1, judge: ACCEPT }] });
    const deps = fakeDeps([ROW("f")]);
    expect((await run(pad, [{ type: "f", payload: {} }], deps)).rows.map((x) => x.verdict)).toEqual(["fallback"]);
  });

  // Fix round 1 (I-1, controller ruling): a fallback is JUDGED, never waved
  // through. Its rows must be of a type it declares it writes, and its judge
  // must accept them against the generated event; otherwise the event is a
  // mismatch with a note, and the replay stops as it does for any mismatch.
  const N = (n: number): StreamEvent => ({ type: "f", payload: { n } });
  /** Accepts when the last row's n is the generated n; says why otherwise. */
  const lastN = (seen: unknown[]) => (ev: StreamEvent, rows: readonly LedgerRow[]) => {
    seen.push({ ev, rows: rows.map(({ type, payload }) => ({ type, payload })) });
    const got = (rows.at(-1)!.payload as { n: number }).n;
    const want = (ev.payload as { n: number }).n;
    return got === want ? { ok: true, note: null } : { ok: false, note: `n: stored ${got}, generated ${want}` };
  };

  it("I-1: a fallback's rows go to its judge with the generated event — accepted is `fallback` noting the why; refused is a `mismatch` noting the judge's reason, the rows kept, and the replay stops", async () => {
    const seen: unknown[] = [];
    const pad = stubAdapter({ fallbacks: [{ eventType: "f", writes: ["f.part"], why: "f.tsx:1", rowsFor: () => 2, judge: lastN(seen) }] });
    const right = await run(pad, [N(3)], fakeDeps([ROW("f.part", { n: 1 }), ROW("f.part", { n: 3 })], { groups: [2] }));
    expect(right.rows.map((x) => [x.verdict, x.note])).toEqual([["fallback", "f.tsx:1"]]);
    expect(right.findings).toEqual([]);
    expect(seen).toEqual([{ ev: N(3), rows: [ROW("f.part", { n: 1 }), ROW("f.part", { n: 3 })] }]);

    const deps = fakeDeps([ROW("f.part", { n: 1 }), ROW("f.part", { n: 2 }), ROW("x")], { groups: [2, 1] });
    const page = fakePage(deps);
    const wrong = await run(pad, [N(3), { type: "x", payload: {} }], deps, page);
    expect(wrong.rows).toHaveLength(1);
    expect(wrong.rows[0]).toMatchObject({ verdict: "mismatch", note: "FallbackMismatch — n: stored 2, generated 3" });
    expect(wrong.rows[0]!.stored.map((s) => s.payload)).toEqual([{ n: 1 }, { n: 2 }]);
    expect(wrong.stored.map((s) => s.payload)).toEqual([{ n: 1 }, { n: 2 }]);
    expect(wrong.findings).toEqual(["stopped after event 1 of 2: FallbackMismatch — n: stored 2, generated 3"]);
    // The next event was never tapped.
    expect(page.taps).toHaveLength(1);
  });

  it("I-1: a fallback row of a type the fallback does not declare it writes is a `mismatch` naming it, before the judge is asked; declared, the same rows are judged", async () => {
    const seen: unknown[] = [];
    const rows = [ROW("f.part", { n: 1 }), ROW("f.close", { n: 3 })];
    const undeclared = stubAdapter({ fallbacks: [{ eventType: "f", writes: ["f.part"], why: "f.tsx:1", rowsFor: () => 2, judge: lastN(seen) }] });
    const r = await run(undeclared, [N(3)], fakeDeps(rows, { groups: [2] }));
    expect(r.rows[0]).toMatchObject({ verdict: "mismatch", note: "FallbackRowType — stored f.close; the f fallback writes f.part" });
    expect(r.findings).toEqual(["stopped after event 1 of 1: FallbackRowType — stored f.close; the f fallback writes f.part"]);
    expect(seen).toEqual([]);
    // Its positive pair: the same rows, the type declared → judged, and accepted.
    const declared = stubAdapter({ fallbacks: [{ eventType: "f", writes: ["f.part", "f.close"], why: "f.tsx:1", rowsFor: () => 2, judge: lastN(seen) }] });
    expect((await run(declared, [N(3)], fakeDeps(rows, { groups: [2] }))).rows.map((x) => x.verdict)).toEqual(["fallback"]);
    expect(seen).toHaveLength(1);
  });

  it("I-1: a judge that throws, or a fallback with no judge (an adapter off the registry), is a `mismatch` naming it — never a crash, never a pass", async () => {
    const throws = stubAdapter({ fallbacks: [{ eventType: "f", writes: ["f"], why: "f.tsx:1", rowsFor: () => 1, judge: () => { throw new Error("no rule for this shape"); } }] });
    const a = await run(throws, [N(1)], fakeDeps([ROW("f", { n: 1 })]));
    expect(a.rows[0]).toMatchObject({ verdict: "mismatch", note: "FallbackMismatch — the f judge threw (Error: no rule for this shape)" });
    expect(a.findings).toHaveLength(1);
    const unjudged = stubAdapter({ fallbacks: [{ eventType: "f", writes: ["f"], why: "f.tsx:1", rowsFor: () => 1 }] });
    const b = await run(unjudged, [N(1)], fakeDeps([ROW("f", { n: 1 })]));
    expect(b.rows[0]).toMatchObject({ verdict: "mismatch", note: "FallbackUnjudged — the f fallback declares no judge; a fallback is judged, never waved through" });
    expect(b.findings).toHaveLength(1);
  });

  it("carry (e): a tap that fails is a named finding on its event's row — the rows already written are kept, the replay stops, and it never throws", async () => {
    const deps = fakeDeps([ROW(SUMMARY_TYPE, { home: 21, away: 13 })]);
    const page = fakePage(deps);
    // Event 2's away number step never attaches: Playwright's own error shape (name + multi-line call log).
    const locator = page.locator.bind(page);
    let numberFills = 0;
    page.locator = (selector: string) => {
      const l = locator(selector);
      if (selector !== selectorForTapStep({ kind: "number", value: 0 })) return l;
      return {
        ...l,
        waitFor: async () => {
          if (++numberFills === 4) {
            const e = new Error("locator.waitFor: Timeout 8000ms exceeded.\nCall log:\n  - waiting for locator('[data-testid=\"pad-sheet-number\"]')");
            e.name = "TimeoutError";
            throw e;
          }
        },
      };
    };
    const r = await run(sheetAdapter, [SUMMARY(21, 13), SUMMARY(21, 16), SUMMARY(21, 18)], deps, page);
    expect(r.rows.map((x) => x.verdict)).toEqual(["equal", "missing"]);
    expect(r.rows[1]!.note).toBe("tap 4 of 6 (number) failed: TimeoutError: locator.waitFor: Timeout 8000ms exceeded.");
    expect(r.rows[1]!.stored).toEqual([]);
    expect(r.findings).toEqual(["stopped after event 2 of 3: tap 4 of 6 (number) failed: TimeoutError: locator.waitFor: Timeout 8000ms exceeded."]);
    // What the product holds is still answered (the first event's row), and the third event was never tapped.
    expect(r.stored.map((s) => s.seq)).toEqual([2]);
    expect(page.taps.filter((t) => t.startsWith("click [data-tile-id"))).toHaveLength(2);
  });

  it("carry (e): a failed tap after the product wrote rows keeps those rows for the fold, and a non-Error throw is still named", async () => {
    // The hold release (the last act of an event) throws after the row landed.
    const deps = fakeDeps([ROW(SUMMARY_TYPE, { home: 21, away: 13 })]);
    const page = fakePage(deps);
    const locator = page.locator.bind(page);
    page.locator = (selector: string) => {
      const l = locator(selector);
      if (selector !== SEND_NOW) return l;
      return { ...l, count: async () => { await l.count(); return 1; }, click: async () => { throw "dock gone"; }, waitFor: async () => undefined };
    };
    const r = await run(sheetAdapter, [SUMMARY(21, 13)], deps, page);
    expect(r.rows.map((x) => x.verdict)).toEqual(["missing"]);
    expect(r.rows[0]!.note).toBe("tap 6 of 6 (releaseHold) failed: dock gone");
    expect(r.rows[0]!.stored.map((s) => s.seq)).toEqual([2]);
    expect(r.stored.map((s) => s.seq)).toEqual([2]);
    expect(r.findings).toEqual(["stopped after event 1 of 1: tap 6 of 6 (releaseHold) failed: dock gone"]);
  });

  it("a fallback short of its rows is `missing`, naming how many of how many", async () => {
    const pad = stubAdapter({ fallbacks: [{ eventType: "f", writes: ["f"], why: "f.tsx:1", rowsFor: () => 3, judge: ACCEPT }] });
    const r = await run(pad, [{ type: "f", payload: {} }], fakeDeps([ROW("f"), ROW("f")], { groups: [2], holdMs: 500 }));
    expect(r.rows[0]).toMatchObject({ verdict: "missing", note: expect.stringMatching(/^2 of 3 row\(s\)/) });
  });

  it("an event whose taps wrote MORE rows than its route declares is a mismatch naming the count, every row kept, and replay stops", async () => {
    const deps = fakeDeps([ROW(SUMMARY_TYPE, { home: 21, away: 13 }), ROW("stub.extra"), ROW(SUMMARY_TYPE, { home: 21, away: 16 })], { groups: [2, 1] });
    const r = await run(sheetAdapter, [SUMMARY(21, 13), SUMMARY(21, 16)], deps);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ verdict: "mismatch", note: "2 row(s) after seq 1, the route writes 1" });
    expect(r.stored.map((s) => s.type)).toEqual([SUMMARY_TYPE, "stub.extra"]);
    expect(r.findings).toEqual(["stopped after event 1 of 2: 2 row(s) after seq 1, the route writes 1"]);
  });

  it("a row that lands after the LAST event's is a finding, and is kept in what the product holds — never unread", async () => {
    const deps = fakeDeps([ROW(SUMMARY_TYPE, { home: 21, away: 13 }), ROW("stub.late")], { groups: [1] });
    const page = fakePage(deps);
    // The late row lands once the event's own rows were read: on the replay's closing read.
    let reads = 0;
    const ledger = deps.ledger;
    deps.ledger = async (since) => { if (++reads === 2) deps.commit(); return ledger(since); };
    const r = await run(sheetAdapter, [SUMMARY(21, 13)], deps, page);
    expect(r.rows.map((x) => x.verdict)).toEqual(["equal"]);
    expect(r.findings).toEqual(["1 row(s) after the last event's (seq 2): stub.late"]);
    expect(r.stored.map((s) => s.type)).toEqual([SUMMARY_TYPE, "stub.late"]);
  });

  it("an event the adapter has no route for is a finding naming it, and nothing is tapped for it", async () => {
    const pad = stubAdapter({ stepsFor: (e) => { if (e.type === "nope") throw new Error("no route for nope"); return [{ kind: "tile", tileId: "t" }]; } });
    const deps = fakeDeps([ROW("ok")]);
    const page = fakePage(deps);
    const r = await run(pad, [{ type: "ok", payload: {} }, { type: "nope", payload: {} }], deps, page);
    expect(r.rows.map((x) => x.verdict)).toEqual(["equal"]);
    expect(r.findings).toEqual(["event 2 of 2 (nope): no tap route — no route for nope"]);
    expect(page.taps).toHaveLength(1);
  });

  it("an adapter that answers NO steps for an event is a finding, never a silent pass on a row that was not tapped", async () => {
    const pad = stubAdapter({ stepsFor: () => [] });
    const deps = fakeDeps([ROW("x")]);
    const r = await run(pad, [{ type: "x", payload: {} }], deps);
    expect(r.rows).toEqual([]);
    expect(r.findings).toEqual(["event 1 of 1 (x): no tap route — the adapter answered no steps"]);
    expect(deps.polls).toBe(0);
  });

  it("paces every tap after the first by TAP_PACE_MS (the product drops a faster same-side repeat); the first tap is not paced", async () => {
    // n taps, n-1 paces: the first tap waits for nothing, every later one waits the pace.
    let checked = 0;
    for (const n of [1, 2, 3]) {
      const deps = fakeDeps(Array.from({ length: n }, () => ROW("stub.point", { side: "home" })));
      await run(halfTapAdapter, Array.from({ length: n }, () => HALF("home")), deps);
      expect(deps.sleeps.filter((ms) => ms === TAP_PACE_MS), `${n} taps`).toHaveLength(n - 1);
      checked++;
    }
    expect(checked).toBe(3);
  });

  it("every wait the replay hands the page is at least the bench's TAP_WAIT_TIMEOUT_MS and the step budget", () => {
    // replay.ts passes Math.max(TAP_WAIT_TIMEOUT_MS, budgetMs({ taps: 1, holds: 0, holdMs })) to executeStep.
    for (const holdMs of [500, 3000, 10_000]) expect(budgetMs({ taps: 1, holds: 0, holdMs })).toBeGreaterThanOrEqual(TAP_WAIT_TIMEOUT_MS);
    expect(FLOOR_MS).toBeGreaterThan(TAP_WAIT_TIMEOUT_MS);
    expect(SLACK_MS).toBeGreaterThan(0);
  });

  it("onTap: the hook sees every tap of every event, in order, with the event's index (the driver's mid-sheet shot rides it)", async () => {
    const deps = fakeDeps([ROW(SUMMARY_TYPE, { home: 21, away: 13 }), ROW(SUMMARY_TYPE, { home: 21, away: 16 })]);
    const seen: string[] = [];
    deps.onTap = async (i, s) => { seen.push(`${i}:${s.kind}`); };
    await run(sheetAdapter, [SUMMARY(21, 13), SUMMARY(21, 16)], deps);
    expect(seen).toEqual(["0:tile", "0:number", "0:confirm", "0:number", "0:confirm", "1:tile", "1:number", "1:confirm", "1:number", "1:confirm"]);
  });
});

describe("compareRow — exact in both directions (the bench's R50(d))", () => {
  const row = (type: string, payload: unknown): LedgerRow => ({ id: "r", seq: 2, type, payload });
  const tolerant = stubAdapter({ tolerableExtraKeys: (t) => (t === "generic.score" ? ["person"] : []) });

  it("equal: same type, same keys, same values — nested objects compared by value, not key order", () => {
    expect(compareRow({ type: "a", payload: { x: 1, y: { p: 1, q: 2 } } }, row("a", { y: { q: 2, p: 1 }, x: 1 }), stubAdapter())).toEqual({ verdict: "equal", note: null });
  });

  it("a different type is a mismatch naming both", () => {
    expect(compareRow({ type: "a", payload: {} }, row("b", {}), stubAdapter())).toEqual({ verdict: "mismatch", note: "type b, expected a" });
  });

  it("a missing key is a mismatch naming it", () => {
    expect(compareRow({ type: "a", payload: { x: 1, y: 2 } }, row("a", { x: 1 }), stubAdapter())).toMatchObject({ verdict: "mismatch", note: expect.stringMatching(/^y: stored \(absent\), generated 2$/) });
  });

  it("a tolerated extra key passes and is kept as a note; an untolerated one fails", () => {
    const r = row("generic.score", { points: 1, person: "p1" });
    expect(compareRow({ type: "generic.score", payload: { points: 1 } }, r, tolerant)).toEqual({ verdict: "tolerated", note: 'tolerated person="p1"' });
    expect(compareRow({ type: "generic.score", payload: { points: 1 } }, row("generic.score", { points: 1, x: 1 }), tolerant)).toEqual({ verdict: "mismatch", note: "untolerated key(s) x" });
    // A tolerated NAME on another type is not tolerated there.
    expect(compareRow({ type: "generic.result", payload: {} }, row("generic.result", { person: "p1" }), tolerant).verdict).toBe("mismatch");
  });

  it("a tolerated key opens at one shape only — a non-empty string id, as the bench's own rule (class 19); any other value is a mismatch", () => {
    let checked = 0;
    for (const bad of [0, 7, "", null, { id: "p1" }, ["p1"]]) {
      expect(compareRow({ type: "generic.score", payload: { points: 1 } }, row("generic.score", { points: 1, person: bad }), tolerant).verdict, JSON.stringify(bad)).toBe("mismatch");
      checked++;
    }
    expect(checked).toBe(6);
  });

  it("nullAsAbsent: an expected null the pad omits is equal only for the declared key", () => {
    const pad = stubAdapter({ nullAsAbsentKeys: (t: string) => (t === "carrom.board.summary" ? ["queenTo"] : []) });
    const r = (p: object) => row("carrom.board.summary", p);
    expect(compareRow({ type: "carrom.board.summary", payload: { winner: "a", opponentCoinsLeft: 9, queenTo: null } }, r({ winner: "a", opponentCoinsLeft: 9 }), pad).verdict).toBe("equal");
    expect(compareRow({ type: "carrom.board.summary", payload: { winner: "a", opponentCoinsLeft: 9, queenTo: "b" } }, r({ winner: "a", opponentCoinsLeft: 9 }), pad).verdict).toBe("mismatch");
    // Another key's null is not excused, and the declared key on another type is not either.
    expect(compareRow({ type: "carrom.board.summary", payload: { winner: null, queenTo: null } }, r({ queenTo: null }), pad).verdict).toBe("mismatch");
    expect(compareRow({ type: "carrom.other", payload: { queenTo: null } }, row("carrom.other", {}), pad).verdict).toBe("mismatch");
    // A stored null where null was generated is plain equality.
    expect(compareRow({ type: "carrom.board.summary", payload: { queenTo: null } }, r({ queenTo: null }), pad).verdict).toBe("equal");
  });

  it("a payload that is no object on either side reads as no keys (the bench's normalisation), so an object stored against it still reds", () => {
    expect(compareRow({ type: "a", payload: null }, row("a", null), stubAdapter()).verdict).toBe("equal");
    expect(compareRow({ type: "a", payload: null }, row("a", { x: 1 }), stubAdapter()).verdict).toBe("mismatch");
  });
});
