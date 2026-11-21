// T10 review M1 - the round panel's OWN clock (round-focus.tsx `RoundFocus` -> `useExtendClock`).
//
// The defect it pins (found by driving the product in Task 10): the panel took its `nowMs` from the shell, whose clock ticks once a minute
// (`CLOCK_TICK_MS`), so a check-in countdown froze at the instant of the last poll and the round's "+5 min" press arrived and left a poll late.
// The board panel already ran its own 500 ms clock while a window is watched; the round panel now does too. A pure-builder suite cannot see a
// wiring like that (the clock is a hook, the digits are what a person reads), so this reads the seam both ways: what the panel ASKS the clock
// for (active only while a window is watched, steady, the window's own edges) and what the digits do with the answer (they follow the hook,
// not the prop; a first client render, `null`, falls back to the prop).
//
// Where an expected value comes from: the face prints whole minutes and seconds to the deadline, so the numbers are arithmetic on the
// FIXTURE's window (`openWindow(8)` closes 8 minutes after NOW) and the clock's reading (3 minutes later), never read back from the panel.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DictProvider } from "@/components/i18n/dict-provider";
import enUi from "@/dictionaries/en/ui.json";
import type { Dict } from "@/lib/i18n-constants";
import type { Reader } from "@/lib/match-day/online";
import type { MatchDayOnlineRound } from "@/lib/match-day/types";

const clock = vi.hoisted(() => ({ reading: null as number | null, calls: [] as Array<{ active: boolean; edges: readonly number[]; steady: boolean | undefined }> }));
vi.mock("../../use-extend-clock", () => ({
  useExtendClock: (active: boolean, edges: readonly number[], steady?: boolean) => {
    clock.calls.push({ active, edges: [...edges], steady });
    return clock.reading;
  },
}));

import type { MatchDayCtx } from "../court-focus";
import { RoundFocus, type RoundFocusProps } from "../round-focus";
import { NOW, arbiterRound, board, live, openWindow, round } from "./_online-fixtures";

const MIN = 60_000;

const dict = enUi as unknown as Dict;
const ctx = { dict, locale: "en", orgSlug: "club", compSlug: "autumn", competitionId: "comp-1", tz: "Europe/London", readOnly: false, frozen: false, orgId: "org-1" } as unknown as MatchDayCtx;
const EDITOR: Reader = { editor: true, offered: true, frozen: false };

const props = (r: MatchDayOnlineRound): RoundFocusProps => ({
  ctx,
  round: r,
  next: null,
  reader: EDITOR,
  nowMs: NOW,
  backLabel: "All rounds",
  onBack: () => {},
  onChanged: () => {},
  onFrozen: () => {},
  onOpenBoard: () => {},
  onOpenRound: () => {},
});
const html = (r: MatchDayOnlineRound) =>
  renderToStaticMarkup(
    <DictProvider dict={dict} locale="en">
      <RoundFocus {...props(r)} />
    </DictProvider>,
  );
/** The face of the check-in clock (`role="timer"`), tags stripped. */
const face = (h: string): string | null => /<span[^>]*role="timer"[^>]*>([^<]*)</.exec(h)?.[1] ?? null;
const lastCall = () => clock.calls[clock.calls.length - 1]!;

/** A round in check-in, one board inside a window that closes 8 minutes after NOW. */
const checkinRound = () => round("stage-1:3", "checkin", arbiterRound([board({ checkin: openWindow(8) })]));

beforeEach(() => {
  clock.reading = null;
  clock.calls.length = 0;
});

describe("RoundFocus: the panel's own clock", () => {
  it("EMPTY CASE FIRST: a round with no window to watch asks for no timer at all", () => {
    html(round("stage-1:3", "playing", arbiterRound([live(), live(9)])));
    expect(clock.calls.length, "anti-vacuity: the panel asked the clock").toBeGreaterThan(0);
    expect(lastCall().active, "nothing is checking in: no timer runs").toBe(false);
    expect(lastCall().edges, "and no edge is watched").toEqual([]);
  });

  it("a window to watch turns it on: steady (the digits run between edges) and watching the window's own deadline", () => {
    html(checkinRound());
    expect(lastCall().active, "a board is inside its window: the clock runs").toBe(true);
    expect(lastCall().steady, "steady: the face counts every tick, not edge to edge").toBe(true);
    expect(lastCall().edges, "the window's deadline is an edge the panel changes AT").toContain(NOW + 8 * MIN);
  });

  it("the digits follow the CLOCK, not the shell's minute: three minutes later the face has moved three minutes", () => {
    clock.reading = null;
    expect(face(html(checkinRound())), "the first render (no reading yet) falls back to the shell's instant: 8 minutes to go").toBe("08:00");
    clock.reading = NOW + 3 * MIN;
    expect(face(html(checkinRound())), "the clock says three minutes later: 5 minutes to go").toBe("05:00");
    clock.reading = NOW + 8 * MIN - 1_000;
    expect(face(html(checkinRound())), "and a second before the deadline: one second").toBe("00:01");
  });
});
