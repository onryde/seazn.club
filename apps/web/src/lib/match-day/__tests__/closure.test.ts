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
import { closedNow, closureAtClock, closureOf, closureWarning, type UsableWindow } from "../closure";
import type { CourtClosure } from "../types";

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

describe("closureOf — a sweep over a whole day against a table written from the DECLARED hours", () => {
  // The oracle is a hand-written table of minute segments per rig, read off the hours each rig declares (court_hours rows: open and
  // close minutes of the day) - NOT a second loop over the windows with the same [from, to) rule the reader itself applies. Each
  // table is checked to tile the whole day (no gap, no overlap, 0..1440) before it is believed, and the sweep counts every minute.
  type Seg = { from: number; to: number; closure: "open" | { kind: "now"; until: number | null } | { kind: "later"; from: number; until: number } };
  const H = (h: number, m = 0) => h * 60 + m;
  const iso = (min: number) => new Date(DAY0 + min * MIN).toISOString();
  const expected = (c: Seg["closure"]) =>
    c === "open" ? null : c.kind === "now" ? { kind: "now", until: c.until === null ? null : iso(c.until) } : { kind: "later", from: iso(c.from), until: iso(c.until) };

  const RIGS: { name: string; windows: UsableWindow[]; table: Seg[] }[] = [
    {
      // Declared hours: 09:00-14:00 and 15:00-22:00.
      name: "one break",
      windows: BREAK,
      table: [
        { from: 0, to: H(9), closure: { kind: "now", until: H(9) } },
        { from: H(9), to: H(14), closure: { kind: "later", from: H(14), until: H(15) } },
        { from: H(14), to: H(15), closure: { kind: "now", until: H(15) } },
        { from: H(15), to: H(22), closure: "open" },
        { from: H(22), to: 1440, closure: { kind: "now", until: null } },
      ],
    },
    {
      // Declared hours: 08:00-10:00, 11:00-13:00 and 14:00-18:00.
      name: "two breaks",
      windows: [win([8], [10]), win([11], [13]), win([14], [18])],
      table: [
        { from: 0, to: H(8), closure: { kind: "now", until: H(8) } },
        { from: H(8), to: H(10), closure: { kind: "later", from: H(10), until: H(11) } },
        { from: H(10), to: H(11), closure: { kind: "now", until: H(11) } },
        { from: H(11), to: H(13), closure: { kind: "later", from: H(13), until: H(14) } },
        { from: H(13), to: H(14), closure: { kind: "now", until: H(14) } },
        { from: H(14), to: H(18), closure: "open" },
        { from: H(18), to: 1440, closure: { kind: "now", until: null } },
      ],
    },
    {
      // Declared hours: 09:00-17:00.
      name: "a single window",
      windows: [win([9], [17])],
      table: [
        { from: 0, to: H(9), closure: { kind: "now", until: H(9) } },
        { from: H(9), to: H(17), closure: "open" },
        { from: H(17), to: 1440, closure: { kind: "now", until: null } },
      ],
    },
    {
      // Declared hours: 12:00-12:01 - one minute.
      name: "a one-minute window",
      windows: [win([12], [12, 1])],
      table: [
        { from: 0, to: H(12), closure: { kind: "now", until: H(12) } },
        { from: H(12), to: H(12, 1), closure: "open" },
        { from: H(12, 1), to: 1440, closure: { kind: "now", until: null } },
      ],
    },
    // Declared: no hours on this date at all (an exception that closes it) - shut all day, never reopening.
    { name: "none", windows: [], table: [{ from: 0, to: 1440, closure: { kind: "now", until: null } }] },
    // Declared hours: 00:00-24:00.
    { name: "all day", windows: ALL_DAY, table: [{ from: 0, to: 1440, closure: "open" }] },
  ];

  it("every table tiles the day exactly: contiguous from 00:00 to 24:00, no gap and no overlap (the oracle is itself checked)", () => {
    let checked = 0;
    for (const rig of RIGS) {
      let cursor = 0;
      for (const seg of rig.table) {
        expect(seg.from, `${rig.name}: starts where the last ended`).toBe(cursor);
        expect(seg.to, `${rig.name}: a segment has length`).toBeGreaterThan(seg.from);
        cursor = seg.to;
        checked++;
      }
      expect(cursor, `${rig.name}: ends at midnight`).toBe(1440);
    }
    expect(checked).toBe(RIGS.reduce((n, r) => n + r.table.length, 0));
    expect(checked).toBeGreaterThan(0);
  });

  it("every minute of every rig: the reader answers what the declared hours' table says", () => {
    let checked = 0;
    for (const rig of RIGS) {
      for (const seg of rig.table) {
        for (let m = seg.from; m < seg.to; m++) {
          expect(closureOf(rig.windows, DAY0 + m * MIN), `${rig.name} @${m}`).toEqual(expected(seg.closure));
          checked++;
        }
      }
    }
    expect(checked).toBe(RIGS.length * 24 * 60);
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

// ---- Fix round 1, m1: the closure follows the CLIENT clock between polls ---------------------------------------------------
// A poll's closure is true at the server's `now`; the page polls every 90 seconds (or slower on a quiet day), so a break that begins
// or ends in between would show the wrong card. `closureAtClock` re-reads the snapshot against the clock: it needs only the
// snapshot itself (the server sends the NEXT closure, not the whole day), so what it cannot know — a break after the one it holds —
// waits for the next poll. The expected values below are the declared hours' (BREAK: open 09:00-14:00 and 15:00-22:00), written out,
// and the sweep checks the snapshot against the server's own reader (`closureOf`) at every later minute.
describe("closureAtClock — a poll's closure, read again against the clock", () => {
  const SEG = (from: number, to: number, expected: CourtClosure | null, name: string) => ({ from, to, expected, name });
  // The snapshot at 10:00 was "break 14:00-15:00 to come". Minutes are of the day.
  const FROM_10: CourtClosure = { kind: "later", from: iso(14), until: iso(15) };
  const FROM_10_TABLE = [
    SEG(10 * 60, 14 * 60, FROM_10, "before the break"),
    SEG(14 * 60, 15 * 60, { kind: "now", until: iso(15) }, "inside the break: it has begun"),
    SEG(15 * 60, 24 * 60, null, "after the break: reopened (a later break is unknown until the next poll)"),
  ];

  it("a break to come: still to come until it begins, closed (until it ends) inside it, gone after", () => {
    let checked = 0;
    for (const seg of FROM_10_TABLE) {
      for (let m = seg.from; m < seg.to; m++) {
        expect(closureAtClock(FROM_10, at(0) + m * MIN), `${seg.name} @${m}`).toEqual(seg.expected);
        checked++;
      }
    }
    expect(checked).toBe(14 * 60);
  });

  it("closed now until 15:00 (snapshot at 14:30): closed until the minute it ends, open from then on", () => {
    const snap: CourtClosure = { kind: "now", until: iso(15) };
    let checked = 0;
    for (let m = 14 * 60 + 30; m < 24 * 60; m++) {
      expect(closureAtClock(snap, at(0) + m * MIN), `@${m}`).toEqual(m < 15 * 60 ? snap : null);
      checked++;
    }
    expect(checked).toBe(9 * 60 + 30);
  });

  it("closed for the rest of today never reopens by the clock; an open court with no break stays open", () => {
    const rest: CourtClosure = { kind: "now", until: null };
    for (const m of [0, 22 * 60, 23 * 60 + 59]) expect(closureAtClock(rest, at(0) + m * MIN)).toEqual(rest);
    for (const m of [0, 12 * 60, 23 * 60 + 59]) expect(closureAtClock(null, at(0) + m * MIN)).toBeNull();
  });

  it("the boundary minutes themselves: the break starts AT 14:00 and ends AT 15:00 (windows are [from, to))", () => {
    expect(closureAtClock(FROM_10, at(13, 59))?.kind).toBe("later");
    expect(closureAtClock(FROM_10, at(14))?.kind).toBe("now");
    expect(closureAtClock(FROM_10, at(14, 59))?.kind).toBe("now");
    expect(closureAtClock(FROM_10, at(15))).toBeNull();
  });

  it("the SEQUENCE a quiet page lives through, one minute tick at a time: later -> now -> open, and `closedNow` follows", () => {
    const ticks = [at(13, 58), at(13, 59), at(14), at(14, 1), at(14, 59), at(15), at(15, 1)];
    const states = ticks.map((t) => {
      const c = closureAtClock(FROM_10, t);
      return c === null ? "open" : closedNow({ closure: c }) ? "closed" : "break-to-come";
    });
    expect(states).toEqual(["break-to-come", "break-to-come", "closed", "closed", "closed", "open", "open"]);
  });

  it("sweep: from every snapshot minute, every later minute agrees with the server's own reader — except what only a poll can know (counted)", () => {
    const TWO_BREAKS: UsableWindow[] = [win([9], [11]), win([12], [14]), win([15], [22])];
    const rigs: [string, UsableWindow[]][] = [
      ["one break", BREAK],
      ["two breaks", TWO_BREAKS],
      ["a single window", [win([9], [17])]],
      ["none", []],
      ["all day", ALL_DAY],
    ];
    let checked = 0;
    let unknowable = 0;
    for (const [name, windows] of rigs) {
      for (let snap = 0; snap < 24 * 60; snap += 7) {
        const snapshot = closureOf(windows, DAY0 + snap * MIN);
        // When the snapshot's own closure is over, the server may already know a further one (a second break, or a break after the
        // window it reopened into) that the snapshot never held. Only a poll can know it: the client says "open, no break known".
        // A snapshot of "open, no break known" holds no end at all, so the whole rest of the day is the poll's to know.
        const horizon = snapshot === null ? -Infinity : snapshot.until === null ? Infinity : Date.parse(snapshot.until);
        for (let m = snap; m < 24 * 60; m += 5) {
          const now = DAY0 + m * MIN;
          const server = closureOf(windows, now);
          const client = closureAtClock(snapshot, now);
          if (now >= horizon) {
            expect(client, `${name} snapshot@${snap} now@${m}`).toBeNull();
            if (server !== null) unknowable++;
          } else {
            expect(client, `${name} snapshot@${snap} now@${m}`).toEqual(server);
          }
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(1500);
    // The exception is REACHED (a sweep that never meets it proves nothing about it) and is the minority.
    expect(unknowable).toBeGreaterThan(0);
    expect(unknowable).toBeLessThan(checked / 2);
  });
});
