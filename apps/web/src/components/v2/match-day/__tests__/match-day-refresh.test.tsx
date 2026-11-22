// The desk's "Updated N s ago · Refresh" line and the court tail countdown's refresh at 0 (web batch B, B2; owner 2026-11-17: "refresh
// button in match day and say countdown with refresh or click to refresh"). apps/web vitest is `environment: "node"`: the shell and
// the line run under the hook harness (components/__tests__/_hook-harness.tsx) with fake timers; the network is a promise the test
// settles by hand, so "in flight" is a state the test can hold. Copy is the English dictionary's own sentence, typed here.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { propsOf, renderIsland, textOf } from "@/components/__tests__/_hook-harness";

const net = vi.hoisted(() => ({
  calls: [] as string[],
  settle: null as null | { ok: (v: unknown) => void; fail: () => void },
}));
vi.mock("@/lib/client-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-v1")>();
  return {
    ...actual,
    apiV1: (url: string) => {
      net.calls.push(url);
      return new Promise((ok, fail) => { net.settle = { ok, fail: () => fail(new Error("down")) }; });
    },
  };
});
vi.mock("next/navigation", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/navigation")>()), useSearchParams: () => null }));
vi.mock("@/components/v2/desk/band-poll", () => ({ browserBandPollDeps: () => ({}), startBandPolling: () => () => {} }));

import en from "@/dictionaries/en/ui.json";
import es from "@/dictionaries/es/ui.json";
import fr from "@/dictionaries/fr/ui.json";
import nl from "@/dictionaries/nl/ui.json";
import publicEn from "@/dictionaries/en/public.json";
import type { Dict } from "@/lib/i18n-constants";
import type { MatchDayCourt, MatchDayView } from "@/lib/match-day/types";
import { NO_FROZEN_NAMES } from "@/lib/match-day/frozen-names";
import { secondsSince, updatedAgo } from "@/lib/match-day/refresh-age";
import { CourtList } from "../court-list";
import { CourtTailCountdown } from "../court-tail-countdown";
import { MatchDayShell } from "../match-day-shell";
import { RefreshLine } from "../refresh-line";

const dict = en as Dict;
const T0 = new Date("2026-11-17T10:00:00.000Z");

const court = (id: string): MatchDayCourt => ({
  court_id: id, court_name: `Court ${id}`, venue_id: "v", venue_name: "Hall", sport_noun: "court", state: "free", current: null,
  in_use_by: null, free_since: null, queue: [], closure: null, stream_link: null,
});
const view = (now: string): MatchDayView => ({
  competition_id: "comp-1", date: "2026-11-17", tz: "Europe/London", now, courts: [court("1")], playing_no_court: [], needs_you: [],
  results_owed: 0, fixtures_today: 0, venues_today: [], online_rounds: [], online_failed: false, boards_unread: [], frozen: false,
});
const shellProps = {
  competitionId: "comp-1", competitionName: "Westway Open", orgSlug: "acme", compSlug: "westway-open", locale: "en" as const, divisions: [],
  initial: view(T0.toISOString()), dict, scoreDict: publicEn as Dict, viewerPlan: "pro" as const, frozenNames: NO_FROZEN_NAMES,
};

const line = (tree: ReactElement[]) => propsOf(tree.find((e) => e.type === RefreshLine)!);
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

beforeEach(() => {
  net.calls = [];
  net.settle = null;
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(T0);
});
afterEach(() => vi.useRealTimers());

describe("the age line's words", () => {
  it("seconds under a minute, then whole minutes; a clock that stepped back reads 0", () => {
    expect(updatedAgo(dict, 0)).toBe("Updated 0 s ago");
    expect(updatedAgo(dict, 59)).toBe("Updated 59 s ago");
    expect(updatedAgo(dict, 60)).toBe("Updated 1 min ago");
    expect(updatedAgo(dict, 119)).toBe("Updated 1 min ago");
    expect(updatedAgo(dict, 120)).toBe("Updated 2 min ago");
    expect(secondsSince(10_000, 4_000)).toBe(0);
    expect(secondsSince(10_000, 14_999)).toBe(4);
  });

  it("every language carries the five keys, each with its placeholder where it needs one", () => {
    let checked = 0;
    for (const d of [en, es, fr, nl] as Record<string, string>[]) {
      expect(d["matchDay.refresh.updatedSeconds"]).toContain("{n}");
      expect(d["matchDay.refresh.updatedMinutes"]).toContain("{n}");
      for (const k of ["button", "refreshing", "failed"]) expect(d[`matchDay.refresh.${k}`]?.length ?? 0).toBeGreaterThan(0);
      checked++;
    }
    expect(checked).toBe(4);
  });
});

describe("<RefreshLine> — the label ticks each second", () => {
  type LineProps = Parameters<typeof RefreshLine>[0];
  const base = { dict, busy: false, failed: false, onRefresh: vi.fn() };

  it("counts from mount, then from the last successful read; minutes past 60 s", () => {
    const island = renderIsland<LineProps>(RefreshLine, { ...base, lastOkAt: null });
    expect(island.text()).toContain("Updated 0 s ago");
    vi.advanceTimersByTime(5000);
    expect(island.text()).toContain("Updated 5 s ago");
    vi.advanceTimersByTime(60_000);
    expect(island.text()).toContain("Updated 1 min ago");
    island.rerender({ ...base, lastOkAt: Date.now() });
    vi.advanceTimersByTime(3000);
    expect(island.text()).toContain("Updated 3 s ago");
    island.unmount();
  });

  it("the Refresh button calls onRefresh; while busy it reads Refreshing… and is disabled; failed says Couldn't refresh", () => {
    const onRefresh = vi.fn();
    const island = renderIsland<LineProps>(RefreshLine, { ...base, onRefresh, lastOkAt: null });
    const button = () => propsOf(island.tree().find((e) => propsOf(e)["data-testid"] === "md-refresh-button")!);
    expect(textOf(island.tree()[island.tree().length - 1])).toContain("Refresh");
    (button().onClick as () => void)();
    expect(onRefresh).toHaveBeenCalledTimes(1);
    island.rerender({ ...base, onRefresh, lastOkAt: null, busy: true });
    expect(island.text()).toContain("Refreshing…");
    expect(button().disabled).toBe(true);
    island.rerender({ ...base, onRefresh, lastOkAt: null, failed: true });
    expect(island.text()).toContain("Couldn't refresh");
    const status = island.tree().filter((e) => propsOf(e).role === "status");
    expect(status.map((e) => textOf(e))).toEqual(["Couldn't refresh"]);
    island.rerender({ ...base, onRefresh, lastOkAt: null });
    expect(island.tree().some((e) => propsOf(e).role === "status"), "the ticking age is never announced").toBe(false);
    island.rerender({ ...base, onRefresh, lastOkAt: null, failed: true });
    expect(island.text()).not.toContain("Updated");
    island.unmount();
  });
});

describe("the shell's one read of the day", () => {
  it("a double click is one request; the view lands, the line is Updated 0 s ago and the button is back", async () => {
    const island = renderIsland(MatchDayShell, shellProps);
    const onRefresh = () => (line(island.tree()).onRefresh as () => void)();
    onRefresh();
    onRefresh();
    expect(net.calls).toEqual(["/api/v1/competitions/comp-1/match-day"]);
    expect(line(island.tree()).busy).toBe(true);
    net.settle!.ok(view("2026-11-17T10:00:09.000Z"));
    await flush();
    expect(line(island.tree())).toMatchObject({ busy: false, failed: false });
    expect(line(island.tree()).lastOkAt).toBe(T0.getTime());
    onRefresh();
    expect(net.calls, "free again once the first settled").toHaveLength(2);
    island.unmount();
  });

  it("a refresh that fails keeps the last view and says Couldn't refresh; the next success clears it", async () => {
    const island = renderIsland(MatchDayShell, shellProps);
    const onRefresh = () => (line(island.tree()).onRefresh as () => void)();
    onRefresh();
    net.settle!.fail();
    await flush();
    expect(line(island.tree())).toMatchObject({ busy: false, failed: true, lastOkAt: null });
    expect(propsOf(island.tree().find((e) => e.type === CourtList)!).viewNow, "the old view stays").toBe(T0.toISOString());
    onRefresh();
    net.settle!.ok({ not: "a view" });
    await flush();
    expect(line(island.tree()).failed, "an answer that is not a view is a failure too").toBe(true);
    onRefresh();
    net.settle!.ok(view("2026-11-17T10:00:30.000Z"));
    await flush();
    expect(line(island.tree())).toMatchObject({ failed: false });
    expect(propsOf(island.tree().find((e) => e.type === CourtList)!).viewNow).toBe("2026-11-17T10:00:30.000Z");
    island.unmount();
  });

  it("a court's tail countdown reaching 0 asks the shell for one read (two countdowns at 0 together are still one)", async () => {
    const island = renderIsland(MatchDayShell, shellProps);
    const onTailEnd = propsOf(island.tree().find((e) => e.type === CourtList)!).onTailEnd as () => void;
    onTailEnd();
    expect(line(island.tree()).busy, "a countdown's read is quiet: no Refreshing…").toBe(false);
    onTailEnd();
    expect(net.calls).toHaveLength(1);
    net.settle!.ok(view("2026-11-17T10:00:31.000Z"));
    await flush();
    // Even once the first read has settled, a second countdown ending on the same tick is throttled (one read per second).
    onTailEnd();
    expect(net.calls, "same tick, after the first settled").toHaveLength(1);
    vi.advanceTimersByTime(1000);
    onTailEnd();
    expect(net.calls, "a second later it reads again").toHaveLength(2);
    net.settle!.fail();
    await flush();
    expect(line(island.tree()), "a failed quiet read still says so").toMatchObject({ busy: false, failed: true });
    island.unmount();
  });

  it("a manual tap while a quiet read is running shows Refreshing… on that read, with no second request", async () => {
    const island = renderIsland(MatchDayShell, shellProps);
    const list = () => propsOf(island.tree().find((e) => e.type === CourtList)!);
    (list().onTailEnd as () => void)();
    expect(line(island.tree()).busy).toBe(false);
    (line(island.tree()).onRefresh as () => void)();
    expect(line(island.tree()).busy).toBe(true);
    expect(net.calls).toHaveLength(1);
    net.settle!.ok(view("2026-11-17T10:00:09.000Z"));
    await flush();
    expect(line(island.tree())).toMatchObject({ busy: false, failed: false });
    expect(net.calls).toHaveLength(1);
    island.unmount();
  });

  it("a tail end reads now and once more 12 s later (one per tail end); unmounting before then cancels it", async () => {
    const island = renderIsland(MatchDayShell, shellProps);
    const onTailEnd = propsOf(island.tree().find((e) => e.type === CourtList)!).onTailEnd as () => void;
    onTailEnd();
    onTailEnd();
    net.settle!.ok(view("2026-11-17T10:00:01.000Z"));
    await flush();
    vi.advanceTimersByTime(11_999);
    expect(net.calls).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(net.calls, "the one follow-up read").toHaveLength(2);
    net.settle!.ok(view("2026-11-17T10:00:13.000Z"));
    await flush();
    vi.advanceTimersByTime(60_000);
    expect(net.calls).toHaveLength(2);
    vi.advanceTimersByTime(1000);
    onTailEnd();
    expect(net.calls).toHaveLength(3);
    island.unmount();
    vi.advanceTimersByTime(20_000);
    expect(net.calls, "unmounted: the pending recheck never fires").toHaveLength(3);
  });

  it("the poll's read is quiet too: no Refreshing…, and a failed one says Couldn't refresh", async () => {
    const island = renderIsland(MatchDayShell, shellProps);
    const list = () => propsOf(island.tree().find((e) => e.type === CourtList)!);
    (list().onTailEnd as () => void)();
    expect(line(island.tree()).busy).toBe(false);
    net.settle!.fail();
    await flush();
    expect(line(island.tree()).failed).toBe(true);
    island.unmount();
  });
});

describe("<CourtTailCountdown> — onEnd fires once when a running count reaches 0", () => {
  const props = (onEnd: () => void, tailEndsAt: string) => ({ dict, tailEndsAt, viewNow: T0.toISOString(), clock: Date.now, onEnd });

  it("counts 3, 2, 1 and calls onEnd once at 0, never again", () => {
    const onEnd = vi.fn();
    const island = renderIsland(CourtTailCountdown, props(onEnd, new Date(T0.getTime() + 3000).toISOString()));
    expect(island.text()).toContain("Video ends in 3 s");
    vi.advanceTimersByTime(2000);
    expect(onEnd).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(onEnd).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5000);
    expect(onEnd).toHaveBeenCalledTimes(1);
    island.unmount();
  });

  it("a count that was already at 0 when it appeared does not call onEnd", () => {
    const onEnd = vi.fn();
    const island = renderIsland(CourtTailCountdown, props(onEnd, new Date(T0.getTime() - 1000).toISOString()));
    vi.advanceTimersByTime(3000);
    expect(onEnd).not.toHaveBeenCalled();
    island.unmount();
  });
});
