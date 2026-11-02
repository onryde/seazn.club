// Match Day E2 item 3 — a court's closure today, read off the scheduler's usable windows (lib/match-day/closure.ts).
//
// The rules, from the brief and the engine's declared window semantics (court-windows.ts: a window is [from, to); a court with no
// hours at all is open all day; a court WITH hours and none today has no window), never from the code under test:
//  - the card says "Closed 14:00–15:00" when a break is still to come today, "Closed until 15:00" / "Closed for the rest of today"
//    when the court is closed now;
//  - a court that merely closes for the night has NO closure to show (that is `past_day_end`'s warning);
//  - the call preview WARNS (never refuses) when the match's expected span crosses a closed window, and when the court is already
//    closed at the call.
// Anti-vacuity: the minute sweep reports how many minutes it checked; zero fails.
import { describe, expect, it } from "vitest";
import { closedNow, closureOf, closureWarning, type UsableWindow } from "../closure";

const MIN = 60_000;
/** A day's clock as epoch ms: 2026-11-07 00:00Z + hh:mm (a UTC day, the zone is irrelevant to the pure reader). */
const DAY0 = Date.parse("2026-11-07T00:00:00.000Z");
const at = (hh: number, mm = 0): number => DAY0 + (hh * 60 + mm) * MIN;
const iso = (hh: number, mm = 0): string => new Date(at(hh, mm)).toISOString();
const win = (from: [number, number?], to: [number, number?]): UsableWindow => ({ from: at(...from), to: at(...to) });

/** Open 09:00–14:00 and 15:00–22:00: an hour's break at 14:00. */
const BREAK: UsableWindow[] = [win([9], [14]), win([15], [22])];
/** Open all day, as a court with no calendar is. */
const ALL_DAY: UsableWindow[] = [{ from: DAY0, to: DAY0 + 24 * 60 * MIN }];

describe("closureOf — what the card says", () => {
  it("empty case first: no window at all is a court closed for the whole day", () => {
    expect(closureOf([], at(10))).toEqual({ kind: "now", until: null });
  });

  it("a court open all day has nothing to say", () => {
    expect(closureOf(ALL_DAY, at(0))).toBeNull();
    expect(closureOf(ALL_DAY, at(23, 59))).toBeNull();
  });

  it("open now with a break still to come: the break, from its start to its end", () => {
    expect(closureOf(BREAK, at(10))).toEqual({ kind: "later", from: iso(14), until: iso(15) });
    expect(closureOf(BREAK, at(9))).toEqual({ kind: "later", from: iso(14), until: iso(15) });
    expect(closureOf(BREAK, at(13, 59))).toEqual({ kind: "later", from: iso(14), until: iso(15) });
  });

  it("closed now, inside the break: until it reopens", () => {
    expect(closureOf(BREAK, at(14))).toEqual({ kind: "now", until: iso(15) });
    expect(closureOf(BREAK, at(14, 30))).toEqual({ kind: "now", until: iso(15) });
    expect(closureOf(BREAK, at(14, 59))).toEqual({ kind: "now", until: iso(15) });
  });

  it("the break is over: open, and nothing more to come", () => {
    expect(closureOf(BREAK, at(15))).toBeNull();
    expect(closureOf(BREAK, at(21, 59))).toBeNull();
  });

  it("a court that only closes for the night shows no closure while open — that is past_day_end's warning", () => {
    expect(closureOf([win([9], [22])], at(10))).toBeNull();
  });

  it("not open yet: closed until it opens", () => {
    expect(closureOf(BREAK, at(7, 30))).toEqual({ kind: "now", until: iso(9) });
    expect(closureOf(BREAK, at(0))).toEqual({ kind: "now", until: iso(9) });
  });

  it("closed for the night: not again today", () => {
    expect(closureOf(BREAK, at(22))).toEqual({ kind: "now", until: null });
    expect(closureOf(BREAK, at(23, 30))).toEqual({ kind: "now", until: null });
  });

  it("several breaks: the NEXT one only", () => {
    const two = [win([8], [10]), win([11], [13]), win([14], [18])];
    expect(closureOf(two, at(9))).toEqual({ kind: "later", from: iso(10), until: iso(11) });
    expect(closureOf(two, at(12))).toEqual({ kind: "later", from: iso(13), until: iso(14) });
    expect(closureOf(two, at(15))).toBeNull();
  });

  it("closedNow is true for exactly the 'now' closures", () => {
    expect(closedNow({ closure: null })).toBe(false);
    expect(closedNow({ closure: closureOf(BREAK, at(10)) })).toBe(false); // a break to come is not a stop
    expect(closedNow({ closure: closureOf(BREAK, at(14, 30)) })).toBe(true);
    expect(closedNow({ closure: closureOf([], at(10)) })).toBe(true);
  });
});

describe("closureOf — a sweep over a whole day against the windows themselves", () => {
  it("every minute: closed now iff no window holds it; a break is announced iff a later window follows the holding one", () => {
    const rigs: [string, UsableWindow[]][] = [
      ["one break", BREAK],
      ["two breaks", [win([8], [10]), win([11], [13]), win([14], [18])]],
      ["a single window", [win([9], [17])]],
      ["a one-minute window", [win([12], [12, 1])]],
      ["none", []],
      ["all day", ALL_DAY],
    ];
    let checked = 0;
    for (const [name, windows] of rigs) {
      for (let m = 0; m < 24 * 60; m++) {
        const now = DAY0 + m * MIN;
        // The oracle: straight from the windows' declared [from, to).
        const holding = windows.findIndex((w) => w.from <= now && now < w.to);
        const result = closureOf(windows, now);
        if (holding < 0) {
          const next = windows.find((w) => w.from > now);
          expect(result, `${name} @${m}`).toEqual({ kind: "now", until: next === undefined ? null : new Date(next.from).toISOString() });
        } else if (windows[holding + 1] === undefined) {
          expect(result, `${name} @${m}`).toBeNull();
        } else {
          expect(result, `${name} @${m}`).toEqual({
            kind: "later",
            from: new Date(windows[holding]!.to).toISOString(),
            until: new Date(windows[holding + 1]!.from).toISOString(),
          });
        }
        checked++;
      }
    }
    expect(checked).toBe(rigs.length * 24 * 60);
  });

  it("the SEQUENCE through a day: open, a break announced, closed, reopened, closed for the night", () => {
    const kinds = [at(10), at(13, 59), at(14), at(14, 59), at(15), at(22)].map((t) => closureOf(BREAK, t)?.kind ?? "open");
    expect(kinds).toEqual(["later", "later", "now", "now", "open", "now"]);
  });
});

describe("closureWarning — the call preview (a warning, never a refusal)", () => {
  const span = (startH: number, startM: number, minutes: number): [number, number] => [at(startH, startM), at(startH, startM) + minutes * MIN];

  it("a match that would run into the break warns, naming the break", () => {
    const [start, end] = span(13, 30, 45); // 13:30–14:15, the break starts 14:00
    expect(closureWarning(BREAK, "Court 3", start, end)).toEqual({ kind: "crosses_closure", court_name: "Court 3", from: iso(14), until: iso(15) });
  });

  it("a match that ends exactly as the break begins does not cross it", () => {
    const [start, end] = span(13, 30, 30); // 13:30–14:00
    expect(closureWarning(BREAK, "Court 3", start, end)).toBeNull();
  });

  it("a match that ends a minute into the break does", () => {
    const [start, end] = span(13, 30, 31);
    expect(closureWarning(BREAK, "Court 3", start, end)?.kind).toBe("crosses_closure");
  });

  it("a match that fits before the break, or wholly after it, warns of nothing", () => {
    expect(closureWarning(BREAK, "Court 3", ...span(10, 0, 45))).toBeNull();
    expect(closureWarning(BREAK, "Court 3", ...span(15, 0, 45))).toBeNull();
  });

  it("a match running past the night's close is past_day_end's, not this warning's", () => {
    expect(closureWarning(BREAK, "Court 3", ...span(21, 30, 60))).toBeNull();
  });

  it("the court is already closed at the call: court_closed, until it reopens", () => {
    // `since`: when the hours last ended before the call — the morning window's end inside the break, nothing before the opening.
    expect(closureWarning(BREAK, "Court 3", ...span(14, 10, 30))).toEqual({ kind: "court_closed", court_name: "Court 3", until: iso(15), since: iso(14) });
    expect(closureWarning(BREAK, "Court 3", ...span(7, 0, 30))).toEqual({ kind: "court_closed", court_name: "Court 3", until: iso(9), since: null });
  });

  it("closed for the rest of today: until is null; a court closed all day likewise", () => {
    // After the night's close two windows are over; `since` is the LATER end (22:00), not the break's (14:00).
    expect(closureWarning(BREAK, "Court 3", ...span(22, 30, 30))).toEqual({ kind: "court_closed", court_name: "Court 3", until: null, since: iso(22) });
    expect(closureWarning([], "Court 3", ...span(10, 0, 30))).toEqual({ kind: "court_closed", court_name: "Court 3", until: null, since: null });
  });

  it("no calendar: nothing to warn about", () => {
    expect(closureWarning(ALL_DAY, "Court 3", ...span(10, 0, 30))).toBeNull();
  });

  it("the SEQUENCE: a closure that ends mid-preview — the same call a minute apart — warns, then does not", () => {
    // The organiser opens the sheet at 14:30 (closed until 15:00) and confirms at 15:00 (reopened): a fresh preview of the same call.
    const [s1, e1] = span(14, 30, 30);
    const [s2, e2] = span(15, 0, 30);
    expect(closureWarning(BREAK, "Court 3", s1, e1)?.kind).toBe("court_closed");
    expect(closureWarning(BREAK, "Court 3", s2, e2)).toBeNull();
  });

  it("sweep: every start minute of the day, a 30-minute match — the warning kind matches the windows' declared holes", () => {
    let checked = 0;
    let warned = 0;
    for (let m = 0; m < 24 * 60; m++) {
      const start = DAY0 + m * MIN;
      const end = start + 30 * MIN;
      const w = closureWarning(BREAK, "C", start, end);
      const startsClosed = !BREAK.some((x) => x.from <= start && start < x.to);
      const endsInBreak = !startsClosed && start < at(14) && end > at(14); // opens before the break, runs into it
      const expected = startsClosed ? "court_closed" : endsInBreak ? "crosses_closure" : null;
      expect(w?.kind ?? null, `@${m}`).toBe(expected);
      checked++;
      if (w !== null) warned++;
    }
    expect(checked).toBe(24 * 60);
    expect(warned, "the sweep reaches both warning kinds").toBeGreaterThan(0);
  });
});
