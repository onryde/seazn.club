// Daily play hours ⇄ session windows (PROMPT-33 follow-up): the settings
// panel offers "we play 09:00–18:00"; the engine wants absolute intervals.
//
// Both directions resolve on the VENUE clock (`settings.orgTz`, #448), which
// the caller passes in. They used to resolve through the browser's, so an
// organiser in another zone expanded "09:00" into their own 09:00 and the
// solver was handed windows that did not match the hours on screen.
//
// EVERY CASE BELOW USES A ZONE THE TEST PROCESS IS NOT IN. `Pacific/Auckland`
// is UTC+12/+13, so its calendar day differs from the fixtures' UTC instants —
// a browser-zone expansion lands on different DAYS, not just different hours.
import { describe, expect, it } from "vitest";
import { dailyHoursToWindows, windowsToDailyHours } from "@/lib/schedule-board";
import { zonedDateInput, zonedTimeInput } from "@/lib/zoned-datetime";

/** The venue zone in every case below. */
const AKL = "Pacific/Auckland";
const PROCESS_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Wall-clock "HH:MM" on the venue clock. */
const at = (iso: string) => zonedTimeInput(iso, AKL);
/** Calendar day on the venue clock. */
const day = (iso: string) => zonedDateInput(iso, AKL);

describe("dailyHoursToWindows", () => {
  it("expands one window per day across the start→end span, inclusive", () => {
    const windows = dailyHoursToWindows(
      "09:00",
      "18:00",
      "2026-09-15T12:00:00.000Z",
      "2026-09-17T12:00:00.000Z",
      AKL,
    );
    expect(windows).not.toBeNull();
    expect(windows!.length).toBe(3);
    for (const w of windows!) {
      expect(at(w.from)).toBe("09:00");
      expect(at(w.to)).toBe("18:00");
      expect(new Date(w.to).getTime()).toBeGreaterThan(new Date(w.from).getTime());
    }
    // Pin the DAYS too, on the venue calendar. Both fixtures are noon UTC, which
    // is already the NEXT day in Auckland — so a browser-zone expansion produces
    // 15/16/17 here, and a bare "three windows, 09:00 each" assertion could not
    // tell the two apart.
    expect(windows!.map((w) => day(w.from))).toEqual([
      "2026-09-16",
      "2026-09-17",
      "2026-09-18",
    ]);
    expect(windows![0]!.from).toBe("2026-09-15T21:00:00.000Z");
    expect(windows![0]!.to).toBe("2026-09-16T06:00:00.000Z");
  });

  it("caps at two weeks when the schedule has no end date", () => {
    const windows = dailyHoursToWindows("10:00", "20:00", "2026-09-15T09:00:00.000Z", null, AKL);
    expect(windows!.length).toBe(14);
    expect(windows!.map((w) => day(w.from))).toEqual(
      Array.from({ length: 14 }, (_, i) => `2026-09-${String(15 + i).padStart(2, "0")}`),
    );
  });

  it("holds the venue wall clock across a DST boundary", () => {
    // Auckland springs forward on 27 Sep 2026 (a 23-hour day). Adding a fixed
    // 86_400_000 ms per day — which is what a UTC-stepped expansion does — walks
    // the window to 10:00 on the far side of it, and the organiser never typed
    // that. Nothing but consecutive days around the transition can see this.
    const windows = dailyHoursToWindows(
      "09:00",
      "18:00",
      "2026-09-26T00:00:00.000Z",
      "2026-09-28T00:00:00.000Z",
      AKL,
    )!;
    expect(windows.map((w) => day(w.from))).toEqual([
      "2026-09-26",
      "2026-09-27",
      "2026-09-28",
    ]);
    for (const w of windows) {
      expect(at(w.from), w.from).toBe("09:00");
      expect(at(w.to), w.to).toBe("18:00");
    }
    // The gaps are the proof in raw milliseconds: 23 hours over the transition,
    // 24 after it.
    const gaps = windows
      .slice(1)
      .map((w, i) => (Date.parse(w.from) - Date.parse(windows[i]!.from)) / 3_600_000);
    expect(gaps).toEqual([23, 24]);
  });

  it("rejects inverted, equal and malformed hours", () => {
    expect(dailyHoursToWindows("18:00", "09:00", "2026-09-15T09:00:00.000Z", null, AKL)).toBeNull();
    expect(dailyHoursToWindows("09:00", "09:00", "2026-09-15T09:00:00.000Z", null, AKL)).toBeNull();
    expect(dailyHoursToWindows("9am", "6pm", "2026-09-15T09:00:00.000Z", null, AKL)).toBeNull();
    expect(dailyHoursToWindows("09:00", "18:00", "not-a-date", null, AKL)).toBeNull();
  });

  it("ignores an unparseable end date rather than refusing the whole expansion", () => {
    // The panel can hand over a blank-ish end; falling back to the two-week cap
    // keeps the auto pass working instead of silently clearing play hours.
    const windows = dailyHoursToWindows("09:00", "18:00", "2026-09-15T09:00:00.000Z", "nope", AKL);
    expect(windows!.length).toBe(14);
  });
});

describe("windowsToDailyHours", () => {
  it("round-trips a uniform daily pattern", () => {
    const windows = dailyHoursToWindows(
      "09:30",
      "17:45",
      "2026-09-15T00:00:00.000Z",
      "2026-09-18T00:00:00.000Z",
      AKL,
    )!;
    expect(windowsToDailyHours(windows, AKL)).toEqual({ from: "09:30", to: "17:45" });
  });

  it("reads the hours on the venue clock, not the reader's", () => {
    // The prefill has to agree with the expansion or the panel shows hours the
    // organiser never typed and re-saves them on the next submit.
    const windows = dailyHoursToWindows(
      "09:00",
      "18:00",
      "2026-09-15T00:00:00.000Z",
      "2026-09-16T00:00:00.000Z",
      AKL,
    )!;
    expect(windowsToDailyHours(windows, AKL)).toEqual({ from: "09:00", to: "18:00" });
    // Same windows read in a zone that is not the venue's: still uniform, but
    // NOT the hours anyone typed. Guards the pair above against a
    // zone-insensitive implementation that would return 09:00 either way.
    expect(windowsToDailyHours(windows, "America/Los_Angeles")).not.toEqual({
      from: "09:00",
      to: "18:00",
    });
  });

  it("keeps reading a uniform pattern across a DST boundary", () => {
    // The same 23-hour day as above: the three windows are 23h and 24h apart in
    // absolute terms but all read 09:00–18:00 locally, and the panel must show
    // the hours rather than falling back to "custom windows".
    const windows = dailyHoursToWindows(
      "09:00",
      "18:00",
      "2026-09-26T00:00:00.000Z",
      "2026-09-28T00:00:00.000Z",
      AKL,
    )!;
    expect(windowsToDailyHours(windows, AKL)).toEqual({ from: "09:00", to: "18:00" });
  });

  it("returns null for hand-built irregular windows (leave them alone)", () => {
    const windows = dailyHoursToWindows(
      "09:00",
      "18:00",
      "2026-09-15T00:00:00.000Z",
      "2026-09-16T00:00:00.000Z",
      AKL,
    )!;
    const irregular = [...windows, { from: "2026-09-17T13:00:00.000Z", to: "2026-09-17T15:00:00.000Z" }];
    expect(windowsToDailyHours(irregular, AKL)).toBeNull();
    expect(windowsToDailyHours([], AKL)).toBeNull();
  });
});

describe("guards — the premise these assertions rest on", () => {
  it("runs in a process zone that disagrees with the venue zone", () => {
    // Every expectation above would also hold for a browser-zone implementation
    // if the machine happened to be in Auckland. It is not; fail loudly if that
    // ever changes rather than reporting a vacuous green.
    expect(PROCESS_TZ).not.toBe(AKL);
    expect(zonedDateInput("2026-09-15T12:00:00.000Z", PROCESS_TZ)).not.toBe("2026-09-16");
  });
});
