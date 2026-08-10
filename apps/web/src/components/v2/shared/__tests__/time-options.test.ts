// Pure rules for the clock control's option list. `time-options.ts` is where
// every decision about what a `<select>` offers lives — apps/web is vitest
// `environment: "node"` with no jsdom, so anything with a rule in it has to
// be testable without mounting a component, and this module is that split.
// No React here on purpose; markup coverage belongs to the component suites.
//
// See docs/superpowers/specs/2026-08-10-quarter-hour-time-select-design.md
// for why this module exists at all (Chrome's picker POPUP ignores `step`
// even though the validity engine honours it).
import { describe, expect, it } from "vitest";
import {
  boardSlotTimes,
  filterByMin,
  joinValue,
  MAX_OPTIONS,
  quarterHours,
  splitValue,
  steppedTimes,
  TIME_STEP_SECONDS,
  timeOptions,
} from "../time-options";

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

describe("steppedTimes / quarterHours", () => {
  it("quarterHours is the 96-entry quarter-hour grid, 00:00 through 23:45", () => {
    // 1440 minutes in a day / 15-minute step = 96 slots exactly — the whole
    // day with no remainder, and days do not wrap (hhmmOfMinutes clamps),
    // so the walk stops at 23:45 rather than looping back to 00:00.
    const times = quarterHours();
    expect(times).toHaveLength(96);
    expect(times[0]).toBe("00:00");
    expect(times.at(-1)).toBe("23:45");
    // Every entry is literal HH:MM, 24-hour — what the native controls
    // already display, matching the "adds zero dictionary strings" design.
    expect(times.every((t) => HHMM.test(t))).toBe(true);
  });

  it("quarterHours is steppedTimes at the module's own default step (900s)", () => {
    expect(TIME_STEP_SECONDS).toBe(900);
    expect(quarterHours()).toEqual(steppedTimes(TIME_STEP_SECONDS));
    expect(quarterHours()).toEqual(steppedTimes());
  });
});

describe("boardSlotTimes", () => {
  it("a 40/0 board anchored at 09:00 offers 09:00, 09:40, 10:20 — the case this module exists for", () => {
    // THE regression this design fixes: a quarter-hour list can express
    // 09:00 and 09:45 but never 09:40, which is exactly where the
    // auto-scheduler puts the second match on a 40-minute, no-gap division.
    const slots = boardSlotTimes({ anchor: "09:00", matchMinutes: 40, gapMinutes: 0 });
    expect(slots.slice(0, 3)).toEqual(["09:00", "09:40", "10:20"]);
    // None of these sit on the quarter-hour grid past the first slot.
    expect(slots[1]).not.toMatch(/:(00|15|30|45)$/);
  });

  it("honours playFrom/playTo — the last slot must still FINISH inside the window", () => {
    // Window is 09:00-10:30. Stride is 40 minutes: 09:00 (ends 09:40, fits),
    // 09:40 (ends 10:20, fits), 10:20 (ends 11:00, does NOT fit) — a match
    // starting at 10:20 would still be running 30 minutes past playTo, so it
    // must be excluded even though 10:20 itself is before playTo.
    const slots = boardSlotTimes({
      anchor: "09:00",
      matchMinutes: 40,
      gapMinutes: 0,
      playFrom: "09:00",
      playTo: "10:30",
    });
    expect(slots).toEqual(["09:00", "09:40"]);
    expect(slots).not.toContain("10:20");
  });

  it("plays hours win over the anchor, and the finish-inside-window boundary is inclusive", () => {
    // playFrom (09:15) is later than anchor (09:00) — the window governs,
    // per the "play hours win over the anchor" rule, since the anchor is
    // only where the board happened to start, not where play is allowed.
    // playTo (09:55) leaves room for exactly one 40-minute slot
    // (09:15 + 40 = 09:55, satisfying start + matchMinutes <= end at the
    // boundary itself — same "keep the boundary" shape as filterByMin).
    const slots = boardSlotTimes({
      anchor: "09:00",
      matchMinutes: 40,
      gapMinutes: 0,
      playFrom: "09:15",
      playTo: "09:55",
    });
    expect(slots).toEqual(["09:15"]);
  });

  it("returns [] for a non-positive or non-finite stride or matchMinutes — the caller's documented fallback trigger", () => {
    const base = { anchor: "09:00", gapMinutes: 0 };
    expect(boardSlotTimes({ ...base, matchMinutes: 0 })).toEqual([]);
    expect(boardSlotTimes({ ...base, matchMinutes: -10 })).toEqual([]);
    expect(boardSlotTimes({ ...base, matchMinutes: NaN })).toEqual([]);
    expect(boardSlotTimes({ ...base, matchMinutes: Infinity })).toEqual([]);
    // matchMinutes alone is positive and finite, but a large negative gap
    // drags the STRIDE to zero or below — that has to fail too, since a
    // non-positive stride would loop forever (or backwards) otherwise.
    expect(boardSlotTimes({ anchor: "09:00", matchMinutes: 10, gapMinutes: -15 })).toEqual([]);
  });

  it("MAX_OPTIONS caps a 1-minute board at 200 and does NOT fall back to quarter hours", () => {
    // matchMinutes: 1 with no play-hours bound would otherwise be a
    // 1,440-entry list for the whole day — the design's stated reason the
    // cap truncates instead of reverting to a grid the board isn't on.
    const slots = boardSlotTimes({ anchor: "00:00", matchMinutes: 1, gapMinutes: 0 });
    expect(slots).toHaveLength(MAX_OPTIONS);
    expect(MAX_OPTIONS).toBe(200);
    expect(slots[0]).toBe("00:00");
    // Minute-stepped, not quarter-stepped: 200 minutes in is 03:19, a time
    // no quarter-hour list could ever produce.
    expect(slots.at(-1)).toBe("03:19");
    expect(slots).not.toEqual(quarterHours());
  });
});

describe("filterByMin", () => {
  it("drops same-day options below the bound and keeps the boundary value itself", () => {
    const times = ["09:00", "09:15", "09:30", "09:45"];
    // 09:15 is the floor: strictly-below (09:00) is dropped, AT the floor
    // (09:15) is kept — an inclusive bound, matching "End date >= start
    // date" and blackout "to >= from" being legal, not just ">".
    expect(filterByMin(times, "09:15")).toEqual(["09:15", "09:30", "09:45"]);
  });

  it("passes the list through unfiltered when min is null — a different day keeps everything", () => {
    const times = ["09:00", "09:15"];
    const result = filterByMin(times, null);
    expect(result).toEqual(times);
    // A copy, not the same array reference — callers must be free to treat
    // the result as fresh without mutating the caller's list.
    expect(result).not.toBe(times);
  });
});

describe("timeOptions", () => {
  it("dedupes, sorts by time-of-day, and appends extraOptions", () => {
    const result = timeOptions({
      value: "",
      options: ["10:20", "09:00", "09:00"],
      extraOptions: ["23:59"],
    });
    // Duplicate 09:00 collapses to one; 23:59 (a registration-deadline
    // extra, never on the quarter-hour grid) sorts to the end naturally
    // because sorting is by time-of-day, not list-append order.
    expect(result).toEqual(["09:00", "10:20", "23:59"]);
  });

  it("ALWAYS includes the current value even when it is off-grid — the regression that matters", () => {
    // A <select> whose value matches no <option> renders BLANK and then
    // saves empty. 09:40 is off the two offered slots (09:00, 10:20) the
    // same way it is off the quarter-hour grid — exactly the silent
    // data-loss path the design calls out (place at 09:40 on a 40/0 board,
    // shrink the match length, reopen).
    const result = timeOptions({
      value: "09:40",
      options: ["10:20", "09:00"],
      extraOptions: ["23:59"],
    });
    expect(result).toEqual(["09:00", "09:40", "10:20", "23:59"]);
  });

  it("does not duplicate the value when it is already among the options", () => {
    const result = timeOptions({ value: "09:00", options: ["09:00", "09:15"] });
    expect(result).toEqual(["09:00", "09:15"]);
  });

  it("injects nothing for a blank or unparseable value", () => {
    expect(timeOptions({ value: "", options: ["09:00"] })).toEqual(["09:00"]);
    // Garbage in `value` (never reachable through this module's own writers,
    // but defensive against stale stored config) must not corrupt the list
    // with a non-time entry.
    expect(timeOptions({ value: "not-a-time", options: ["09:00"] })).toEqual(["09:00"]);
  });

  it("falls back to the generated stepped list when no explicit options are given", () => {
    expect(timeOptions({ value: "" })).toEqual(quarterHours());
  });
});

describe("splitValue / joinValue", () => {
  it("round-trips a full datetime-local value", () => {
    const value = "2026-10-12T09:30";
    const halves = splitValue(value);
    expect(halves).toEqual({ date: "2026-10-12", time: "09:30" });
    expect(joinValue(halves.date, halves.time)).toBe(value);
  });

  it("splitValue tolerates a trailing :SS and strips it", () => {
    expect(splitValue("2026-10-12T09:30:45")).toEqual({ date: "2026-10-12", time: "09:30" });
  });

  it("splitValue on a bare date or unparseable string splits to blanks, never throws", () => {
    expect(splitValue("2026-10-12")).toEqual({ date: "2026-10-12", time: "" });
    expect(splitValue("")).toEqual({ date: "", time: "" });
    expect(splitValue("garbage")).toEqual({ date: "", time: "" });
  });

  it("joinValue on a half-filled pair emits \"\" — NEVER a partial string", () => {
    // The load-bearing case: "2026-10-12T" would parse as an Invalid Date
    // downstream and throw at .toISOString(), turning a half-typed field
    // into a white screen. Blank is the state every caller already handles.
    expect(joinValue("2026-10-12", "")).toBe("");
    expect(joinValue("2026-10-12", "--:--")).toBe("");
    expect(joinValue("", "09:30")).toBe("");
    expect(joinValue("", "")).toBe("");
    // Confirm neither half-filled result ever contains the literal "T" that
    // a naive template-join would still produce.
    expect(joinValue("2026-10-12", "")).not.toContain("T");
  });
});
