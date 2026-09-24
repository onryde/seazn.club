// v3/__tests__/report-ledger-changes.test.ts — the pad reports a CHANGED
// ledger to its chrome, never the one it was seeded with.
//
// FOUND BY A FLAKE, NOT BY A SUITE. CI run 35969236588 ("walkthrough 1/3",
// `scorepad-v3-soft-commit-visual.spec.ts`) clicked the console's "Start
// match" and the ledger stayed `[]` for 20s. The trace's own DOM snapshot
// taken at the instant of the click shows the button carrying `disabled`:
// Playwright had judged it enabled ~80ms earlier, from the server-rendered
// markup, and in between the pad hydrated, its mount effect called
// `onEvents(seed)`, and `fixture-console.tsx`'s `handlePadEvents` raised
// `padSyncing` for a `/state` + `/events` round trip. A click on a disabled
// button is dropped by the browser, so nothing was ever sent.
//
// The seed is the SAME server bootstrap the chrome already rendered from, so
// that report told the chrome nothing: it only greyed the one filled button
// on the page (and Undo/Void/Forfeit with it) for a round trip after every
// load, for two requests whose answer was already on screen. Both chrome
// consumers document `onEvents` as "the pad's ledger CHANGED — a submit, an
// ack, a foreign-write merge"; a mount is none of those.
//
// The browser proof that PadHostV3 really routes through this hook (a unit
// test of the hook alone would pass against an inert seam) is the soft-commit
// walkthrough's own Start-match probe.
import { describe, expect, it, vi } from "vitest";
import type { EventEnvelope } from "@seazn/engine/core";
import { renderIsland } from "@/components/__tests__/_hook-harness";
import { useReportLedgerChanges } from "../pad-host";

type OnEvents = (events: readonly EventEnvelope[]) => void;
interface ProbeProps {
  events: readonly EventEnvelope[];
  onEvents: OnEvents | undefined;
}

function Probe({ events, onEvents }: ProbeProps): null {
  useReportLedgerChanges(events, onEvents);
  return null;
}

function envelope(seq: number): EventEnvelope {
  return { id: `e${seq}`, seq, type: "core.start", payload: {} } as unknown as EventEnvelope;
}

describe("useReportLedgerChanges", () => {
  it("does NOT report the seed ledger at mount — the chrome rendered from the same bootstrap", () => {
    const onEvents = vi.fn<OnEvents>();
    renderIsland(Probe, { events: [envelope(1)], onEvents });
    expect(onEvents).not.toHaveBeenCalled();
  });

  it("does not report an EMPTY seed either (a pre-start fixture — the flake's own shape)", () => {
    const onEvents = vi.fn<OnEvents>();
    renderIsland(Probe, { events: [], onEvents });
    expect(onEvents).not.toHaveBeenCalled();
  });

  it("reports a changed ledger exactly once, with the new list", () => {
    const onEvents = vi.fn<OnEvents>();
    const seed = [envelope(1)];
    const island = renderIsland(Probe, { events: seed, onEvents });
    const next = [...seed, envelope(2)];
    island.rerender({ events: next, onEvents });
    expect(onEvents).toHaveBeenCalledTimes(1);
    expect(onEvents.mock.calls[0]![0]).toBe(next);
  });

  it("reports every later change, not only the first", () => {
    const onEvents = vi.fn<OnEvents>();
    const island = renderIsland(Probe, { events: [envelope(1)], onEvents });
    const second = [envelope(1), envelope(2)];
    const third = [...second, envelope(3)];
    island.rerender({ events: second, onEvents });
    island.rerender({ events: third, onEvents });
    expect(onEvents.mock.calls.map(([events]) => events)).toEqual([second, third]);
  });

  it("a re-render with the SAME ledger reports nothing, even under a fresh callback identity", () => {
    const first = vi.fn<OnEvents>();
    const seed = [envelope(1)];
    const island = renderIsland(Probe, { events: seed, onEvents: first });
    const second = vi.fn<OnEvents>();
    island.rerender({ events: seed, onEvents: second });
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
  });

  it("a change delivered after a callback swap goes to the CURRENT callback", () => {
    const stale = vi.fn<OnEvents>();
    const seed = [envelope(1)];
    const island = renderIsland(Probe, { events: seed, onEvents: stale });
    const current = vi.fn<OnEvents>();
    const next = [...seed, envelope(2)];
    island.rerender({ events: next, onEvents: current });
    expect(stale).not.toHaveBeenCalled();
    expect(current).toHaveBeenCalledTimes(1);
  });

  it("no callback at all is not an error", () => {
    const island = renderIsland(Probe, { events: [envelope(1)], onEvents: undefined });
    expect(() => island.rerender({ events: [envelope(1), envelope(2)], onEvents: undefined })).not.toThrow();
  });
});
