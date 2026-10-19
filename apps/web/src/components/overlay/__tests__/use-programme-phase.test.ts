// R2005 change 6 — the phase channel's loop, through the REAL hook with `fetch` stubbed (the one substitution: the
// network hop to the compositor's loopback endpoint). The reducer's rules are A2's (overlay-compositor.test.ts); this
// file proves the loop drives them: no request without the host, the long poll's `after`, the fallback after exactly 3
// failures and NO fourth request (sticky), the abort timer, and the channel announcement.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderIsland } from "@/components/__tests__/_hook-harness";
import type { ProgrammePhaseWire } from "@/lib/relay-phase";
import { useProgrammePhase } from "../use-programme-phase";

const NOW = 1_700_000_000_000;
let lines: string[] = [];
let calls: string[] = [];
let replies: Array<() => Promise<Response>> = [];

const json = (body: unknown) => async () => new Response(JSON.stringify(body), { status: 200 });
const refused = () => async (): Promise<Response> => {
  throw new TypeError("Failed to fetch");
};

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
  lines = [];
  calls = [];
  replies = [];
  vi.spyOn(console, "info").mockImplementation((...a: unknown[]) => void lines.push(String(a[0])));
  vi.stubGlobal("fetch", (url: string, init: { signal: AbortSignal }) => {
    calls.push(url);
    const next = replies.shift();
    if (next) return next();
    // Nothing scripted: a long poll that never answers until aborted.
    return new Promise<Response>((_, reject) => init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

type Result = ReturnType<typeof useProgrammePhase>;
type Q = { enabled: boolean; webPhase: ProgrammePhaseWire | null };
type P = Q & { onReady: (r: Result) => void };
let latest: Result;
const report = (r: Result) => (latest = r);
function Probe(props: P) {
  props.onReady(useProgrammePhase(props));
  return null;
}
/** Mount, and re-render, with the reporter attached — the result is handed out by a prop, never assigned in render. */
function mount(q: Q) {
  const island = renderIsland<P>(Probe, { ...q, onReady: report });
  return { rerender: (next: Q) => island.rerender({ ...next, onReady: report }) };
}
const channelLines = () => lines.filter((l) => l.startsWith("seazn:phase-channel="));

describe("useProgrammePhase", () => {
  it("disabled (no host): null, and NO request — ever", async () => {
    mount({ enabled: false, webPhase: "reconnecting" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toEqual([]);
    expect(latest).toEqual({ phase: null, channel: null });
    expect(lines).toEqual([]);
  });

  it("loopback: asks after=0 first, adopts the reply, then long-polls after the adopted seq; announces loopback once", async () => {
    replies.push(json({ phase: "waiting", seq: 0 }), json({ phase: "live", seq: 1 }), json({ phase: "live", seq: 1 }));
    mount({ enabled: true, webPhase: null });
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.slice(0, 3)).toEqual([
      "http://127.0.0.1:7419/phase?after=0",
      "http://127.0.0.1:7419/phase?after=0",
      "http://127.0.0.1:7419/phase?after=1",
    ]);
    expect(latest).toEqual({ phase: "live", channel: "loopback" });
    expect(channelLines()).toEqual(["seazn:phase-channel=loopback"]);
  });

  it("3 consecutive failures → web after exactly 3 calls, and the count STAYS 3 (sticky); webPhase is then adopted", async () => {
    replies.push(refused(), refused(), refused(), json({ phase: "live", seq: 9 }));
    const island = mount({ enabled: true, webPhase: null });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls).toHaveLength(3);
    expect(channelLines()).toEqual(["seazn:phase-channel=web"]);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(calls, "no fourth request: web is sticky for the page's life").toHaveLength(3);
    expect(latest).toEqual({ phase: null, channel: "web" });
    island.rerender({ enabled: true, webPhase: "reconnecting" });
    await vi.advanceTimersByTimeAsync(0);
    expect(latest.phase).toBe("reconnecting");
    island.rerender({ enabled: true, webPhase: null });
    await vi.advanceTimersByTimeAsync(0);
    expect(latest.phase, "an absent programmePhase is no phase, never the last one").toBeNull();
  });

  it("an invalid reply and a non-200 count as failures; a valid one between them resets the count", async () => {
    replies.push(
      json({ phase: "paused", seq: 1 }),
      async () => new Response("", { status: 503 }),
      json({ phase: "reconnecting", seq: 2 }),
      json({ phase: "live", seq: -1 }),
      json({ phase: "live", seq: 3, x: 1 }),
    );
    mount({ enabled: true, webPhase: null });
    await vi.advanceTimersByTimeAsync(4_000);
    expect(latest).toEqual({ phase: "reconnecting", channel: "loopback" });
    expect(calls.length).toBeGreaterThanOrEqual(6);
  });

  // Review round 1, item 5: the status is the authority, never the body. The test above's 503 has an EMPTY body, which
  // the JSON parse would refuse anyway, so it could not tell a status check from a parse failure. A non-200 whose body
  // IS a valid reply (a proxy's error page passing one through, a server answering 503 with its last phase) must still
  // count as a failure: three of them fall back to web, and their phase is never adopted.
  it("a non-200 with a VALID {phase, seq} body is still a failure: never adopted, three fall back to web", async () => {
    const valid = (seq: number, status: number) => async () =>
      new Response(JSON.stringify({ phase: "reconnecting", seq }), { status });
    replies.push(valid(1, 503), valid(2, 500), valid(3, 404), json({ phase: "live", seq: 9 }));
    mount({ enabled: true, webPhase: null });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls, "three non-200 answers, then web: no fourth request").toHaveLength(3);
    expect(latest).toEqual({ phase: null, channel: "web" });
    expect(channelLines()).toEqual(["seazn:phase-channel=web"]);
  });

  it("a reply that never comes is aborted at the long poll's hold + 2 s and counts as a failure", async () => {
    mount({ enabled: true, webPhase: null });
    await vi.advanceTimersByTimeAsync(12_000 - 1);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    // aborted → failure → 1 s pause → the second request
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toHaveLength(2);
    expect(latest.channel, "one failure is not a fallback").toBeNull();
  });

  it("webPhase is ignored while loopback holds the channel", async () => {
    replies.push(json({ phase: "live", seq: 1 }));
    const island = mount({ enabled: true, webPhase: null });
    await vi.advanceTimersByTimeAsync(0);
    island.rerender({ enabled: true, webPhase: "final" });
    await vi.advanceTimersByTimeAsync(0);
    expect(latest).toEqual({ phase: "live", channel: "loopback" });
  });
});
