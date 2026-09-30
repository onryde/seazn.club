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
import { SEND_NOW_TESTID, TAP_WAIT_TIMEOUT_MS, selectorForTapStep, type PadLocator, type PadPage, type TapAdapterContext, type TapStep } from "../../bench/lib/drivers/scorer.ts";
import type { LedgerRow } from "../../bench/lib/ledger.ts";
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
    expect(r.stored).toEqual([{ type: SUMMARY_TYPE, payload: { home: 21, away: 13 } }]);
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
    expect(r.stored).toEqual([SUMMARY(21, 13), SUMMARY(21, 16)]);
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
    expect(r.stored).toEqual([SUMMARY(21, 12)]);
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
    const pad = stubAdapter({ fallbacks: [{ eventType: "cricket.innings.summary", why: "cricket.tsx:2579", rowsFor: () => 3 }] });
    const deps = fakeDeps([ROW("cricket.innings.summary"), ROW("cricket.innings.summary"), ROW("cricket.innings.close"), ROW("x")], { groups: [3, 1] });
    const r = await run(pad, [{ type: "cricket.innings.summary", payload: {} }, { type: "x", payload: {} }], deps);
    expect(r.rows[0]).toMatchObject({ verdict: "fallback", note: "cricket.tsx:2579" });
    expect(r.rows[0]!.stored).toHaveLength(3);
    // The next event reads after the fallback's LAST row.
    expect(r.rows[1]).toMatchObject({ verdict: "equal" });
    expect(r.rows[1]!.stored.map((s) => s.seq)).toEqual([5]);
    expect(r.stored.map((s) => s.type)).toEqual(["cricket.innings.summary", "cricket.innings.summary", "cricket.innings.close", "x"]);
  });

  it("a fallback short of its rows is `missing`, naming how many of how many", async () => {
    const pad = stubAdapter({ fallbacks: [{ eventType: "f", why: "f.tsx:1", rowsFor: () => 3 }] });
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
