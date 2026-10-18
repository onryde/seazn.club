// R2005 change 2 — the transport the compositor's score-stale signal reads.
//
// `SCORE_STALE_AFTER_MS` is 10 s (compositor spec §6). The hook's own intervals are 15 s open (POLL_MS), 60 s with a
// realtime channel up, 60 s settled, and NEVER locked — every one of them would read a healthy page as stale between
// two polls. So the compositor host asks for a STEADY interval, STREAM_POLL_MS (5 s, `lib/stream-session-view.ts` —
// reused, never a third constant), in every tier; and the hook reports what it last RECEIVED (`received`), when, so
// the stale rule measures the transport rather than the presentation (a delayed page presents late on purpose).
//
// Without `steadyPollMs` the hook is unchanged: the existing use-live-fixture.test.ts suite pins every tier.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderIsland } from "@/components/__tests__/_hook-harness";
import type { LiveFixtureData } from "../../live-score-data";
import { POLL_MS, useLiveFixture, type UseLiveFixtureOptions, type UseLiveFixtureResult } from "../use-live-fixture";
import { STREAM_POLL_MS } from "@/lib/stream-session-view";
import { LOCKED_FIXTURE_STATUSES, SETTLED_FIXTURE_STATUSES } from "@/lib/fixture-status";

vi.mock("@/lib/supabase-browser", () => ({ supabaseBrowser: () => { throw new Error("no realtime in this suite"); } }));

const NOW = 1_700_000_000_000;
beforeEach(() => vi.useFakeTimers({ now: NOW }));
afterEach(() => vi.useRealTimers());

const snap = (status: string, line = "0"): LiveFixtureData => ({
  status,
  summary: { perSide: [{ entrantId: "h", line }, { entrantId: "a", line: "0" }] },
  outcome: null,
});

function mount(initial: LiveFixtureData, options: UseLiveFixtureOptions<LiveFixtureData>) {
  let latest!: UseLiveFixtureResult;
  function Probe(props: { initial: LiveFixtureData; options: UseLiveFixtureOptions<LiveFixtureData> }) {
    latest = useLiveFixture("f1", props.initial, false, props.options);
    return null;
  }
  const island = renderIsland(Probe, { initial, options });
  return { get current() { return latest; }, island };
}

describe("steadyPollMs — one interval in every tier", () => {
  it("STREAM_POLL_MS is the stream panel's 5 s (the compositor host's interval) — below the 10 s stale rule", () => {
    expect(STREAM_POLL_MS).toBe(5_000);
    expect(POLL_MS, "the default open interval is the reason a steady one is owed").toBeGreaterThan(5_000);
  });

  const tiers: Array<[string, string]> = [
    ["open", "in_play"],
    ["settled", [...SETTLED_FIXTURE_STATUSES][0]!],
    ["locked", [...LOCKED_FIXTURE_STATUSES][0]!],
  ];
  for (const [tier, status] of tiers) {
    it(`${tier} (${status}): polls at exactly every STREAM_POLL_MS, from the first`, async () => {
      const fetcher = vi.fn(async () => snap(status));
      mount(snap(status), { fetcher, steadyPollMs: STREAM_POLL_MS });
      // The no-delay path fetches once on mount, as it always has.
      await vi.advanceTimersByTimeAsync(0);
      const atMount = fetcher.mock.calls.length;
      await vi.advanceTimersByTimeAsync(STREAM_POLL_MS - 1);
      expect(fetcher.mock.calls.length, "nothing before the interval").toBe(atMount);
      await vi.advanceTimersByTimeAsync(1);
      expect(fetcher.mock.calls.length).toBe(atMount + 1);
      await vi.advanceTimersByTimeAsync(4 * STREAM_POLL_MS);
      expect(fetcher.mock.calls.length).toBe(atMount + 5);
    });
  }

  it("the settled tier's listen window does not end a steady poll (it is past SETTLED_LISTEN_MS here)", async () => {
    const status = [...SETTLED_FIXTURE_STATUSES][0]!;
    const fetcher = vi.fn(async () => snap(status));
    mount(snap(status), { fetcher, steadyPollMs: STREAM_POLL_MS });
    await vi.advanceTimersByTimeAsync(16 * 60_000);
    const before = fetcher.mock.calls.length;
    await vi.advanceTimersByTimeAsync(STREAM_POLL_MS);
    expect(fetcher.mock.calls.length).toBe(before + 1);
  });

  it("without steadyPollMs a locked fixture still never polls (the unchanged default, its negative pair)", async () => {
    const status = [...LOCKED_FIXTURE_STATUSES][0]!;
    const fetcher = vi.fn(async () => snap(status));
    mount(snap(status), { fetcher });
    await vi.advanceTimersByTimeAsync(10 * STREAM_POLL_MS);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("received — the newest snapshot the transport took, and when", () => {
  it("starts at the server-rendered initial, stamped at mount", () => {
    const initial = snap("in_play", "0");
    const h = mount(initial, {});
    expect(h.current.received).toEqual({ at: NOW, snapshot: initial });
  });

  it("moves on every SUCCESSFUL fetch, and a failed one leaves it where it was", async () => {
    let fail = false;
    let n = 0;
    const fetcher = vi.fn(async () => {
      if (fail) throw new Error("down");
      n++;
      return snap("in_play", String(n));
    });
    const h = mount(snap("in_play"), { fetcher, steadyPollMs: STREAM_POLL_MS });
    await vi.advanceTimersByTimeAsync(STREAM_POLL_MS);
    const ok = h.current.received;
    expect(ok.at).toBe(NOW + STREAM_POLL_MS);
    expect(ok.snapshot.summary?.perSide?.[0]?.line).toBe(String(n));
    fail = true;
    await vi.advanceTimersByTimeAsync(3 * STREAM_POLL_MS);
    expect(h.current.received, "three failures move nothing").toEqual(ok);
    fail = false;
    await vi.advanceTimersByTimeAsync(STREAM_POLL_MS);
    expect(h.current.received.at).toBe(NOW + 5 * STREAM_POLL_MS);
  });

  it("is the newest RECEIVED snapshot even while a delay holds `data` back", async () => {
    let n = 0;
    const fetcher = vi.fn(async () => snap("in_play", String(++n)));
    const h = mount(snap("in_play", "0"), { fetcher, delayMs: 30_000, steadyPollMs: STREAM_POLL_MS });
    await vi.advanceTimersByTimeAsync(2 * STREAM_POLL_MS);
    expect(h.current.awaitingDelay, "the picture is 30 s behind").toBe(true);
    expect(h.current.received.snapshot.summary?.perSide?.[0]?.line, "the transport is not").toBe("2");
    expect(h.current.received.at).toBe(NOW + 2 * STREAM_POLL_MS);
  });
});
