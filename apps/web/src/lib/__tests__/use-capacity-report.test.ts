// The board's live capacity precheck (P10 §4/Task 6): useCapacityReport
// replaces settings-panel.tsx's/stages-panel.tsx's old client-side useMemo
// (capacityInputForFixtures + assessCapacity, no court calendars) with a
// debounced, abortable round trip to POST /divisions/{id}/schedule/capacity.
//
// Driven directly through the hook harness (renderIsland), not a full
// component render: this hook's own contract (debounce, abort-on-edit,
// held-report-while-stale, skip-when-unassessable) is the unit under test,
// mirroring use-fixture-stream.test.ts's approach for a hook whose effect
// fires a fetch — renderToStaticMarkup (this repo's client-component
// convention) never fires an effect at all, so there is no useful static
// story for a report that only ever arrives that way.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderIsland } from "@/components/__tests__/_hook-harness";
import {
  useCapacityReport,
  useCapacityReportsByStage,
  type UseCapacityReportResult,
  type CapacityReportConfig,
  type CapacityRequest,
} from "../use-capacity-report";
import {
  CAPACITY_PRECHECK_MAX_COURTS,
  CAPACITY_PRECHECK_MAX_FIXTURES,
  type CapacityFixtureInput,
} from "../capacity-input";
import type { CapacityReport } from "@seazn/engine/scheduling/capacity";

function report(overrides: Partial<CapacityReport> = {}): CapacityReport {
  return {
    verdict: "ok",
    slotSupply: 6,
    slotDemand: 4,
    perDay: [],
    restBound: [],
    suggestions: [],
    ...overrides,
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify({ ok: true, data: body }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

const boundedConfig = (over: Partial<CapacityReportConfig> = {}): CapacityReportConfig => ({
  courts: ["c1"],
  matchMinutes: 30,
  gapMinutes: 0,
  perEntrantMinRest: 0,
  window: { from: 0, to: 86_400_000 },
  ...over,
});

interface Props {
  divisionId: string;
  fixtures: CapacityFixtureInput[];
  config: CapacityReportConfig;
}

function mount(props: Props) {
  let latest!: UseCapacityReportResult;
  function Probe(p: Props) {
    latest = useCapacityReport(p.divisionId, p.fixtures, p.config);
    return null;
  }
  const island = renderIsland(Probe, props);
  return {
    get current() {
      return latest;
    },
    rerender: (next: Props) => island.rerender(next),
    unmount: () => island.unmount(),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useCapacityReport", () => {
  it("fetches after the debounce window and returns the resolved report", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse(report()));
    vi.stubGlobal("fetch", fetchMock);
    const hook = mount({ divisionId: "d1", fixtures: [], config: boundedConfig() });
    expect(hook.current.report).toBeNull(); // still debouncing — no fetch yet
    expect(fetchMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(300);
    expect(hook.current.report).toEqual(report());
    expect(hook.current.stale).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("/api/v1/divisions/d1/schedule/capacity");
    expect(init?.method).toBe("POST");
    const body = JSON.parse(String(init?.body)) as { fixtures: unknown[]; config: unknown };
    expect(body).toEqual({ fixtures: [], config: boundedConfig() });
  });

  it("keeps the previous report visible and marks it stale the instant an edit lands, before any refetch resolves", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse(report({ slotDemand: 4 })));
    vi.stubGlobal("fetch", fetchMock);
    const hook = mount({ divisionId: "d1", fixtures: [], config: boundedConfig() });
    await vi.advanceTimersByTimeAsync(300);
    const before = hook.current.report;
    expect(before).not.toBeNull();
    expect(hook.current.stale).toBe(false);

    fetchMock.mockResolvedValueOnce(jsonResponse(report({ slotDemand: 9 })));
    hook.rerender({ divisionId: "d1", fixtures: [{ id: "f1" }], config: boundedConfig() });
    // Synchronous — stale is DERIVED at render time, not set from the effect,
    // so it flips before the new debounce timer even starts.
    expect(hook.current.report).toBe(before);
    expect(hook.current.stale).toBe(true);

    await vi.advanceTimersByTimeAsync(300);
    expect(hook.current.report).toEqual(report({ slotDemand: 9 }));
    expect(hook.current.stale).toBe(false);
  });

  it("debounces a burst of edits into exactly one request, carrying the LAST edit's inputs", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse(report()));
    vi.stubGlobal("fetch", fetchMock);
    const hook = mount({ divisionId: "d1", fixtures: [], config: boundedConfig() });
    for (let i = 1; i <= 5; i += 1) {
      hook.rerender({ divisionId: "d1", fixtures: [{ id: `f${i}` }], config: boundedConfig() });
    }
    await vi.advanceTimersByTimeAsync(300);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body)) as { fixtures: unknown[] };
    expect(body.fixtures).toEqual([{ id: "f5" }]);
  });

  it("aborts an in-flight request the instant a newer edit supersedes it", async () => {
    let capturedSignal: AbortSignal | undefined;
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      capturedSignal = init?.signal ?? undefined;
      return new Promise<Response>(() => {}); // never resolves on its own — simulates in-flight
    });
    vi.stubGlobal("fetch", fetchMock);
    const hook = mount({ divisionId: "d1", fixtures: [], config: boundedConfig() });
    await vi.advanceTimersByTimeAsync(300); // debounce fires — fetch #1 now in flight
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(capturedSignal?.aborted).toBe(false);

    hook.rerender({ divisionId: "d1", fixtures: [{ id: "f1" }], config: boundedConfig() });
    // The superseded effect's cleanup runs synchronously on rerender.
    expect(capturedSignal?.aborted).toBe(true);
  });

  it("skips the network call entirely when there is no bounded window (unset end date) — matches capacityInputForFixtures' own null contract", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const hook = mount({ divisionId: "d1", fixtures: [], config: boundedConfig({ window: undefined }) });
    await vi.advanceTimersByTimeAsync(1000);
    expect(hook.current.report).toBeNull();
    expect(hook.current.stale).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("skips the network call when the window has only ONE finite bound (from:-Infinity, the shipped-crash shape)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const hook = mount({
      divisionId: "d1",
      fixtures: [],
      config: boundedConfig({ window: { from: -Infinity, to: 86_400_000 } }),
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(hook.current.report).toBeNull();
    expect(hook.current.stale).toBe(false);
  });

  // Second-review finding 5: the "unconstrained courts" fallback in BOTH
  // panels (`flattenCourts(venues).map(c => c.id)`) is unbounded, while the
  // server schema this body is posted to caps `courts` at 50 and `fixtures`
  // at 2000. An org over either cap therefore produced a guaranteed 400 ->
  // one retry -> another 400, permanently, on every edit — the card stuck on
  // "check failed" with no way for the organiser to clear it. A request the
  // client can already prove the server will reject must never be sent.
  it("skips the network call when `courts` exceeds the server's own bound — never sends a body it can prove will 400", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const courts = Array.from({ length: CAPACITY_PRECHECK_MAX_COURTS + 1 }, (_, i) => `c${i}`);
    const hook = mount({ divisionId: "d1", fixtures: [], config: boundedConfig({ courts }) });
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(hook.current.report).toBeNull();
    expect(hook.current.stale).toBe(false);
    expect(hook.current.failed).toBe(false);
  });

  it("skips the network call when `fixtures` exceeds the server's own bound", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const fixtures = Array.from({ length: CAPACITY_PRECHECK_MAX_FIXTURES + 1 }, (_, i) => ({ id: `f${i}` }));
    const hook = mount({ divisionId: "d1", fixtures, config: boundedConfig() });
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(hook.current.report).toBeNull();
    expect(hook.current.stale).toBe(false);
    expect(hook.current.failed).toBe(false);
  });

  it("sends normally at EXACTLY the bound — the guard is a ceiling, not an off-by-one that silences legitimate checks", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse(report()));
    vi.stubGlobal("fetch", fetchMock);
    const courts = Array.from({ length: CAPACITY_PRECHECK_MAX_COURTS }, (_, i) => `c${i}`);
    const hook = mount({ divisionId: "d1", fixtures: [], config: boundedConfig({ courts }) });
    await vi.advanceTimersByTimeAsync(300);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(hook.current.report).not.toBeNull();
  });

  // Review fix (Finding 1): a superseded abort and a REAL failure used to be
  // swallowed identically — `onResolved` simply never fired for either, so
  // `stale` stayed true forever with no way to tell "catching up" from
  // "broken since ten minutes ago". These three tests pin the split.
  it("a superseded abort stays silent — never marked failed, report/stale left exactly as they were (routine, not an error)", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse(report()));
    vi.stubGlobal("fetch", fetchMock);
    const hook = mount({ divisionId: "d1", fixtures: [], config: boundedConfig() });
    await vi.advanceTimersByTimeAsync(300);
    const before = hook.current.report;

    const abortErr = new Error("aborted");
    abortErr.name = "AbortError";
    fetchMock.mockRejectedValueOnce(abortErr);
    hook.rerender({ divisionId: "d1", fixtures: [{ id: "f1" }], config: boundedConfig() });
    await vi.advanceTimersByTimeAsync(300); // debounce -> the (aborted-shaped) attempt
    await vi.advanceTimersByTimeAsync(600); // long past the one retry's backoff — must never fire
    expect(fetchMock).toHaveBeenCalledTimes(2); // no retry scheduled for an abort
    expect(hook.current.report).toBe(before);
    expect(hook.current.stale).toBe(true); // no fresh data ever arrived for this key
    expect(hook.current.failed).toBe(false); // an abort is never a failure
  });

  it("a REAL failure — after its one retry also fails — is marked `failed`, keeps the last known report, and stays stale; never reads as fresh and never as an indefinite in-flight state", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse(report()));
    vi.stubGlobal("fetch", fetchMock);
    const hook = mount({ divisionId: "d1", fixtures: [], config: boundedConfig() });
    await vi.advanceTimersByTimeAsync(300);
    const before = hook.current.report;
    expect(hook.current.failed).toBe(false);

    fetchMock.mockRejectedValue(new Error("network down")); // the attempt AND its retry both fail
    hook.rerender({ divisionId: "d1", fixtures: [{ id: "f1" }], config: boundedConfig() });
    expect(hook.current.stale).toBe(true);
    expect(hook.current.failed).toBe(false); // not yet — one retry is still owed

    await vi.advanceTimersByTimeAsync(300); // debounce -> attempt #1 -> fails -> schedules the retry
    expect(hook.current.failed).toBe(false); // retry still pending, not declared failed yet
    await vi.advanceTimersByTimeAsync(600); // retry backoff -> attempt #2 -> fails too
    expect(hook.current.report).toBe(before); // still the last GOOD report, never blanked
    expect(hook.current.stale).toBe(true);
    expect(hook.current.failed).toBe(true); // NOW it reads as a real, visible failure
  });

  it("a failure followed by a successful retry never sets `failed` — the blip stays invisible", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse(report()));
    vi.stubGlobal("fetch", fetchMock);
    const hook = mount({ divisionId: "d1", fixtures: [], config: boundedConfig() });
    await vi.advanceTimersByTimeAsync(300);

    fetchMock.mockRejectedValueOnce(new Error("blip"));
    fetchMock.mockResolvedValueOnce(jsonResponse(report({ slotDemand: 9 })));
    hook.rerender({ divisionId: "d1", fixtures: [{ id: "f1" }], config: boundedConfig() });
    await vi.advanceTimersByTimeAsync(300); // debounce -> attempt #1 -> fails -> schedules the retry
    await vi.advanceTimersByTimeAsync(600); // retry backoff -> attempt #2 -> succeeds
    expect(hook.current.report).toEqual(report({ slotDemand: 9 }));
    expect(hook.current.stale).toBe(false);
    expect(hook.current.failed).toBe(false);
  });

  it("re-fetches when only divisionId changes, same fixtures/config", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse(report()));
    vi.stubGlobal("fetch", fetchMock);
    const hook = mount({ divisionId: "d1", fixtures: [], config: boundedConfig() });
    await vi.advanceTimersByTimeAsync(300);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    hook.rerender({ divisionId: "d2", fixtures: [], config: boundedConfig() });
    expect(hook.current.stale).toBe(true);
    await vi.advanceTimersByTimeAsync(300);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]![0])).toBe("/api/v1/divisions/d2/schedule/capacity");
  });
});

// The multi-stage sibling (stages-panel.tsx's "Auto-schedule remaining"
// button, one subscription per stage). Called ONCE per render — never once
// per stage — specifically so the button it feeds stays a DIRECT part of
// StagesPanel's own render output: this repo's hook-harness walk() never
// invokes a nested component's render function, so a child-component-per-
// stage design (tried and reverted during this task) makes the button
// invisible to every existing walk()-based test that locates it by testid.
describe("useCapacityReportsByStage", () => {
  interface StageProps {
    divisionId: string;
    requests: Map<string, CapacityRequest>;
  }

  function mountStages(props: StageProps) {
    let latest!: ReadonlyMap<string, UseCapacityReportResult>;
    function Probe(p: StageProps) {
      latest = useCapacityReportsByStage(p.divisionId, p.requests);
      return null;
    }
    const island = renderIsland(Probe, props);
    return {
      get current() {
        return latest;
      },
      rerender: (next: StageProps) => island.rerender(next),
      unmount: () => island.unmount(),
    };
  }

  const req = (id: string): CapacityRequest => ({ fixtures: [{ id }], config: boundedConfig() });

  it("resolves each stage's own report independently", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse(report()));
    vi.stubGlobal("fetch", fetchMock);
    const requests = new Map([
      ["s1", req("f-s1")],
      ["s2", req("f-s2")],
    ]);
    const hook = mountStages({ divisionId: "d1", requests });
    await vi.advanceTimersByTimeAsync(300);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(hook.current.get("s1")?.report).not.toBeNull();
    expect(hook.current.get("s2")?.report).not.toBeNull();
    expect(hook.current.get("s1")?.stale).toBe(false);
    expect(hook.current.get("s2")?.stale).toBe(false);
  });

  it("a `null` request (settings not loaded) resolves to report:null, stale:false with NO network call for that stage", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse(report()));
    vi.stubGlobal("fetch", fetchMock);
    const requests = new Map<string, CapacityRequest>([
      ["s1", req("f-s1")],
      ["s2", null],
    ]);
    const hook = mountStages({ divisionId: "d1", requests });
    await vi.advanceTimersByTimeAsync(300);
    expect(fetchMock).toHaveBeenCalledTimes(1); // only s1
    expect(hook.current.get("s2")).toEqual({ report: null, stale: false, failed: false });
  });

  // Second-review finding 1: `useCapacityReport` skipped an unassessable
  // window (the two tests above in its own describe); this hook did NOT —
  // it only ever skipped a literally `null` request. `capacityRequestForStage`
  // (stages-panel.tsx) emits `from: -Infinity` / `to: Infinity` whenever only
  // ONE of startAt/endAt is set, which is a very ordinary division shape, and
  // `JSON.stringify(Infinity)` is `null` — so the body carried `to: null`
  // against a `z.number()`, i.e. a guaranteed 400 -> retry -> 400 per stage
  // per debounced edit. The two hooks must answer this identically; that they
  // did not is exactly the drift a shared predicate has to prevent.
  it("skips a stage whose window has only ONE finite bound — the same skip useCapacityReport already made", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse(report()));
    vi.stubGlobal("fetch", fetchMock);
    const requests = new Map<string, CapacityRequest>([
      ["s1", req("f-s1")],
      ["s2", { fixtures: [{ id: "f-s2" }], config: boundedConfig({ window: { from: 0, to: Infinity } }) }],
    ]);
    const hook = mountStages({ divisionId: "d1", requests });
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchMock).toHaveBeenCalledTimes(1); // only s1
    expect(hook.current.get("s2")).toEqual({ report: null, stale: false, failed: false });
  });

  it("skips a stage whose courts exceed the server's own bound, leaving its siblings unaffected", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse(report()));
    vi.stubGlobal("fetch", fetchMock);
    const courts = Array.from({ length: CAPACITY_PRECHECK_MAX_COURTS + 1 }, (_, i) => `c${i}`);
    const requests = new Map<string, CapacityRequest>([
      ["s1", req("f-s1")],
      ["s2", { fixtures: [{ id: "f-s2" }], config: boundedConfig({ courts }) }],
    ]);
    const hook = mountStages({ divisionId: "d1", requests });
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchMock).toHaveBeenCalledTimes(1); // only s1
    expect(hook.current.get("s2")).toEqual({ report: null, stale: false, failed: false });
    expect(hook.current.get("s1")?.report).not.toBeNull();
  });

  it("re-fetching ONE stage does not disturb a sibling stage's already-resolved report or reschedule its request", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse(report()));
    vi.stubGlobal("fetch", fetchMock);
    const requests = new Map([
      ["s1", req("f-s1")],
      ["s2", req("f-s2")],
    ]);
    const hook = mountStages({ divisionId: "d1", requests });
    await vi.advanceTimersByTimeAsync(300);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const s2Before = hook.current.get("s2")?.report;

    hook.rerender({ divisionId: "d1", requests: new Map([["s1", req("f-s1-edited")], ["s2", req("f-s2")]]) });
    expect(hook.current.get("s1")?.stale).toBe(true);
    expect(hook.current.get("s2")?.stale).toBe(false); // untouched — same request as before
    await vi.advanceTimersByTimeAsync(300);
    expect(fetchMock).toHaveBeenCalledTimes(3); // one more call for s1 only
    expect(hook.current.get("s2")?.report).toBe(s2Before);
  });

  it("aborts a stage's in-flight request when a newer edit for THAT stage supersedes it", async () => {
    const signals: AbortSignal[] = [];
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      if (init?.signal) signals.push(init.signal);
      return new Promise<Response>(() => {});
    });
    vi.stubGlobal("fetch", fetchMock);
    const requests = new Map([["s1", req("f-s1")]]);
    const hook = mountStages({ divisionId: "d1", requests });
    await vi.advanceTimersByTimeAsync(300);
    expect(signals).toHaveLength(1);
    expect(signals[0]!.aborted).toBe(false);

    hook.rerender({ divisionId: "d1", requests: new Map([["s1", req("f-s1-edited")]]) });
    expect(signals[0]!.aborted).toBe(true);
  });

  it("cancels and drops a stage removed from the map on a later render — no leaked timer", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse(report()));
    vi.stubGlobal("fetch", fetchMock);
    const hook = mountStages({ divisionId: "d1", requests: new Map([["s1", req("f-s1")]]) });
    hook.rerender({ divisionId: "d1", requests: new Map() }); // s1 removed before its debounce ever fires
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(hook.current.get("s1")).toBeUndefined();
  });

  // Review fix (Finding 2): stages-panel.tsx's Auto-schedule gate reads THIS
  // hook per stage — a stuck failure has to be visible per stage, and one
  // stage's failure must never bleed into a sibling's own state.
  it("marks a stage `failed` after its request and retry both fail, independent of a sibling that succeeds", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (String(init?.body ?? "").includes("f-s1")) throw new Error("down");
      return jsonResponse(report());
    });
    vi.stubGlobal("fetch", fetchMock);
    const requests = new Map([
      ["s1", req("f-s1")],
      ["s2", req("f-s2")],
    ]);
    const hook = mountStages({ divisionId: "d1", requests });
    await vi.advanceTimersByTimeAsync(300); // debounce -> attempt #1 for both; s1 fails, schedules its retry
    expect(hook.current.get("s1")?.failed).toBe(false); // retry still pending
    expect(hook.current.get("s2")?.report).not.toBeNull(); // unaffected sibling already resolved
    expect(hook.current.get("s2")?.failed).toBe(false);

    await vi.advanceTimersByTimeAsync(600); // s1's retry backoff -> attempt #2 -> fails too
    expect(hook.current.get("s1")?.failed).toBe(true);
    expect(hook.current.get("s1")?.report).toBeNull(); // s1 never got a report
    expect(hook.current.get("s2")?.failed).toBe(false); // sibling untouched
  });
});
