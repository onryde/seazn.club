import { describe, expect, it } from "vitest";
import { buildGrid, MAX_SLOTS } from "./build-grid.ts";
import { gridStepMinutes } from "./grid-step.ts";
import type { Assignment, SlotConfig } from "./calendar.ts";

const MIN = 60_000;
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 7, 8, 8, 0); // Sat 08 Aug 2026, 08:00Z

const cfg = (over: Partial<SlotConfig> = {}): SlotConfig & { courts: string[] } => ({
  startAt: T0,
  matchMinutes: 30,
  gapMinutes: 10,
  courts: ["C1", "C2"],
  perEntrantMinRest: 0,
  window: { from: T0, to: T0 + 4 * 60 * MIN },
  ...over,
});

describe("gridStepMinutes", () => {
  it("is the gcd of match and gap length", () => {
    expect(gridStepMinutes(60, 15)).toBe(15);
    expect(gridStepMinutes(45, 10)).toBe(5);
  });

  it("degenerates to the match length when there is no gap", () => {
    expect(gridStepMinutes(45, 0)).toBe(45);
  });

  it("never goes below the repair grid", () => {
    expect(gridStepMinutes(7, 3)).toBe(5);
  });
});

describe("buildGrid — the pack window bounds the lattice (P9.5)", () => {
  // P9.5's prompt asserted that `admits` omits the competition pack window the
  // verifier enforces (`calendar.ts` `outside_competition_window`), so the
  // lattice could offer slots `/validate` rejects. That premise is FALSE:
  // `repairUniverse` (repair-domain.ts:292-294) hard-returns `config.window`
  // before `existing` can widen it, so no slot outside the pack window is ever
  // minted and `admits` has nothing left to re-check.
  //
  // These pin the property rather than the implementation, because the moment
  // that hard return grows a branch, the asymmetry the prompt described becomes
  // real. Neither test passes if the universe is derived from the board.
  it("mints no slot outside the pack window even when an existing fixture sits far outside it", () => {
    const outside: Assignment[] = [
      {
        fixtureId: "f-far",
        court: "C1",
        startAt: T0 + 30 * DAY,
        endAt: T0 + 30 * DAY + 30 * MIN,
        entrants: ["e1", "e2"],
        people: [],
      },
    ];

    const g = buildGrid({ config: cfg(), existing: outside });

    const packWindow = cfg().window!;
    for (const slot of g.slots) {
      expect(slot.startAt).toBeGreaterThanOrEqual(packWindow.from);
      expect(slot.startAt + 30 * MIN).toBeLessThanOrEqual(packWindow.to);
    }
    expect(g.slots.length).toBeGreaterThan(0);
  });

  it("agrees with the verifier when no pack window is declared: neither side bounds anything", () => {
    // Symmetry in the other direction — `validateAssignments` guards its pack
    // check on `window !== undefined`, so an absent window must not make the
    // lattice narrower than the verifier either.
    const board: Assignment[] = [
      {
        fixtureId: "f-1",
        court: "C1",
        startAt: T0 + 2 * DAY,
        endAt: T0 + 2 * DAY + 30 * MIN,
        entrants: ["e1", "e2"],
        people: [],
      },
    ];

    const g = buildGrid({ config: cfg({ window: undefined }), existing: board });

    expect(g.slots.some((s) => s.startAt > T0 + DAY)).toBe(true);
  });
});

describe("buildGrid — config.startAt is deliberately NOT the lattice's floor", () => {
  // Pinned, not fixed. P9.5 first read "the solver places before config.startAt
  // while greedy does not" as a defect and floored the lattice at `startAt`.
  // That is WRONG, and `build-day-gate.test.ts`'s `dayOpenConfig` says so in as
  // many words: "config.startAt IS NOT THE SOLVER'S FLOOR, and that is the
  // whole fixture." The grid opens at `window.from`; greedy's cursor opens at
  // max(startAt, notBefore). The two producers legitimately see different first
  // ticks, and the solver's earlier board WINS on `dayStartOffsetMinutes` — a
  // rung `isStrictlyBetter` ranks and greedy cannot reach (measured on the real
  // service: 0 against 540).
  //
  // Flooring the lattice reds four engine tests, two of them that gate exactly
  // this. This guard exists so the next session to notice the asymmetry finds
  // the ruling instead of re-deriving the same wrong fix.
  it("opens at window.from even when startAt is nine hours later", () => {
    const midnight = Date.UTC(2026, 7, 8, 0, 0);
    const nine = midnight + 9 * 60 * MIN;

    const g = buildGrid({
      config: cfg({ startAt: nine, window: { from: midnight, to: midnight + DAY } }),
    });

    expect(g.slots.some((s) => s.startAt < nine)).toBe(true);
    expect(g.slots[0]!.startAt).toBe(midnight);
  });
});

describe("buildGrid — court calendars narrow the lattice (P9.5)", () => {
  // P8 shipped court_hours/court_exceptions (V367) and a calendar editor whose
  // data NOTHING in scheduling read: the scheduler would place at 09:00 on a
  // court that does not open until 15:00. This is the owner-raised edge matrix,
  // rows 1/2/10 — asserted here on the lattice, and in
  // court-windows-parity.test.ts through /validate on the same board.
  const SAT = Date.UTC(2026, 7, 8, 0, 0); // Sat 08 Aug 2026 00:00Z, weekday 6
  const SATURDAY = 6;
  const dayCfg = (over: Partial<SlotConfig> = {}): SlotConfig & { courts: string[] } =>
    cfg({
      tz: "UTC",
      startAt: SAT,
      window: { from: SAT, to: SAT + DAY },
      matchMinutes: 60,
      gapMinutes: 0,
      ...over,
    });

  it("offers no slot before a court opens, and leaves a court with no calendar alone", () => {
    const g = buildGrid({
      config: dayCfg({
        courtCalendars: [
          {
            courtId: "C1",
            hours: [{ weekday: SATURDAY, openMin: 15 * 60, closeMin: 20 * 60 }],
            exceptions: [],
          },
        ],
      }),
    });

    const c1 = g.byCourt.get("C1")!.map((i) => g.slots[i]!.startAt);
    expect(c1[0]).toBe(SAT + 15 * 60 * MIN);
    expect(c1[c1.length - 1]).toBe(SAT + 19 * 60 * MIN); // 19:00–20:00 fits; 20:00 does not
    // C2 declares no calendar, so it stays open all day — calendars SUBTRACT.
    const c2 = g.byCourt.get("C2")!.map((i) => g.slots[i]!.startAt);
    expect(c2[0]).toBe(SAT);
    expect(c2.length).toBe(24);
  });

  it("drops a court from the day entirely when its hours miss the session window", () => {
    // Edge matrix row 2: court 15:00–20:00 against a 09:00–13:00 session is an
    // EMPTY intersection, so that court must leave the day's candidate set
    // rather than silently accept fixtures.
    const g = buildGrid({
      config: dayCfg({
        sessionWindows: [{ from: SAT + 9 * 60 * MIN, to: SAT + 13 * 60 * MIN }],
        courtCalendars: [
          {
            courtId: "C1",
            hours: [{ weekday: SATURDAY, openMin: 15 * 60, closeMin: 20 * 60 }],
            exceptions: [],
          },
        ],
      }),
    });

    expect(g.byCourt.get("C1") ?? []).toEqual([]);
    expect((g.byCourt.get("C2") ?? []).length).toBeGreaterThan(0);
  });

  it("honours a closed exception on that date only", () => {
    const hours = [{ weekday: SATURDAY, openMin: 9 * 60, closeMin: 17 * 60 }];
    const open = buildGrid({
      config: dayCfg({ courtCalendars: [{ courtId: "C1", hours, exceptions: [] }] }),
    });
    const closed = buildGrid({
      config: dayCfg({
        courtCalendars: [
          { courtId: "C1", hours, exceptions: [{ date: "2026-08-08", closed: true }] },
        ],
      }),
    });

    expect((open.byCourt.get("C1") ?? []).length).toBeGreaterThan(0);
    expect(closed.byCourt.get("C1") ?? []).toEqual([]);
  });

  it("ignores court calendars when no tz is configured, matching the verifier", () => {
    // Court hours are DAY-shaped, and with no tz there is no local midnight to
    // resolve a weekday against. The verifier skips day-shaped rules rather
    // than bucketing them in UTC, so the lattice must skip these too or the two
    // sides disagree — the fork this session exists to close.
    const g = buildGrid({
      config: dayCfg({
        tz: undefined,
        courtCalendars: [
          {
            courtId: "C1",
            hours: [{ weekday: SATURDAY, openMin: 15 * 60, closeMin: 20 * 60 }],
            exceptions: [],
          },
        ],
      }),
    });

    expect((g.byCourt.get("C1") ?? []).length).toBe(24);
  });
});

describe("buildGrid", () => {
  it("covers every court across the window at the step", () => {
    const g = buildGrid({ config: cfg() });
    expect(g.stepMinutes).toBe(10);
    // A 30-minute match must FIT: last legal start is window.to - 30 min.
    const c1 = g.byCourt.get("C1")!;
    expect(g.slots[c1[0]!]!.startAt).toBe(T0);
    expect(g.slots[c1[c1.length - 1]!]!.startAt).toBe(T0 + (4 * 60 - 30) * MIN);
    expect(g.byCourt.get("C2")!.length).toBe(c1.length);
    expect(g.overCap).toBe(false);
  });

  it("drops starts whose occupancy overlaps a global blackout", () => {
    const g = buildGrid({ config: cfg({ blackouts: [{ from: T0 + 60 * MIN, to: T0 + 90 * MIN }] }) });
    const starts = g.byCourt.get("C1")!.map((i) => g.slots[i]!.startAt);
    expect(starts).not.toContain(T0 + 60 * MIN);
    expect(starts).not.toContain(T0 + 40 * MIN); // 40..70 overlaps
    expect(starts).toContain(T0 + 30 * MIN); // 30..60 touches, does not overlap
    expect(starts).toContain(T0 + 90 * MIN);
  });

  it("scopes a court-scoped blackout to that court only", () => {
    const g = buildGrid({ config: cfg({ blackouts: [{ court: "C1", from: T0, to: T0 + 60 * MIN }] }) });
    expect(g.byCourt.get("C1")!.map((i) => g.slots[i]!.startAt)).not.toContain(T0);
    expect(g.byCourt.get("C2")!.map((i) => g.slots[i]!.startAt)).toContain(T0);
  });

  it("admits only starts fully inside a session window", () => {
    const g = buildGrid({
      config: cfg({ sessionWindows: [{ from: T0 + 60 * MIN, to: T0 + 150 * MIN }] }),
    });
    const starts = g.byCourt.get("C1")!.map((i) => g.slots[i]!.startAt);
    expect(starts[0]).toBe(T0 + 60 * MIN);
    expect(starts[starts.length - 1]).toBe(T0 + 120 * MIN); // 120..150 fits
  });

  it("removes court-time an existing booking occupies, including the gap", () => {
    const existing: Assignment[] = [{
      fixtureId: "x", court: "C1",
      startAt: T0 + 60 * MIN, endAt: T0 + 90 * MIN,
      entrants: [], people: [],
    }];
    const g = buildGrid({ config: cfg(), existing });
    const starts = g.byCourt.get("C1")!.map((i) => g.slots[i]!.startAt);
    expect(starts).not.toContain(T0 + 60 * MIN);
    expect(starts).not.toContain(T0 + 50 * MIN); // needs the 10-minute gap
    expect(starts).toContain(T0 + 100 * MIN); // 90 + 10 gap
    expect(g.byCourt.get("C2")!.map((i) => g.slots[i]!.startAt)).toContain(T0 + 60 * MIN);
  });

  it("admits an off-grid pinned start so a locked card stays representable", () => {
    const pinnedAt = T0 + 7 * MIN; // not a multiple of the 10-minute step
    const g = buildGrid({ config: cfg(), pinned: [{ court: "C1", startAt: pinnedAt }] });
    expect(g.byCourt.get("C1")!.map((i) => g.slots[i]!.startAt)).toContain(pinnedAt);
  });

  it("keeps a start whose match runs past midnight into the next day", () => {
    // step = gcd(90, 30) = 30, so a start can sit 30 minutes short of midnight
    // and legally run past it. A day bucket must gate which starts BELONG to it
    // — that is what makes the DST anchoring below correct — but it must not
    // bound the occupancy, or this slot is deleted from the lattice outright:
    // the next bucket cannot recover it, because that bucket opens AT midnight.
    //
    // Needs `stepMinutes < matchMinutes` to show up at all, i.e. any non-zero
    // gap. Every other test here either stays inside one day or sets
    // matchMinutes === gapMinutes, where gcd(a, a) = a makes step === duration
    // and the bug cannot manifest.
    const from = Date.UTC(2026, 7, 8, 0, 0);
    const g = buildGrid({
      config: cfg({ tz: "UTC", window: { from, to: from + 3 * DAY }, matchMinutes: 90, gapMinutes: 30 }),
    });
    expect(g.stepMinutes).toBe(30);
    const starts = g.byCourt.get("C1")!.map((i) => g.slots[i]!.startAt);
    expect(starts).toContain(from + 1380 * MIN); // 23:00 day 0, ends 00:30 day 1
    expect(starts).toContain(from + 1410 * MIN); // 23:30 day 0, ends 01:00 day 1
    expect(starts).toContain(from + DAY + 1380 * MIN); // and again across day 1 -> day 2
    // The universe end is still the real bound: nothing may run past it, so the
    // final day's 23:00 start is correctly absent.
    for (const s of g.slots) expect(s.startAt + 90 * MIN).toBeLessThanOrEqual(from + 3 * DAY);
    expect(starts).not.toContain(from + 2 * DAY + 1380 * MIN);
  });

  it("anchors each day at local midnight so a DST day does not drift", () => {
    // Europe/London springs forward 29 Mar 2026 at 01:00 local, making that a
    // 23-hour day.
    //
    // The step MUST NOT divide that 23-hour day, or this test proves nothing.
    // Every Europe/London local midnight falls on a whole UTC hour, so with a
    // 60-minute step the day-anchored lattice and a lattice stepped straight
    // through in UTC are the SAME SET — no assertion can tell them apart. At 45
    // minutes they diverge: local midnight on 30 Mar is 2820 minutes after the
    // window start, which is not a multiple of 45, so UTC stepping opens that
    // day at 00:15 local instead of 00:00.
    const from = Date.UTC(2026, 2, 28, 0, 0);
    const g = buildGrid({
      config: cfg({ tz: "Europe/London", window: { from, to: from + 4 * DAY }, matchMinutes: 45, gapMinutes: 45 }),
    });
    const fmt = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/London",
      hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit",
    });
    const local = (ms: number) => {
      const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
      return { day: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
    };
    // `slots` is sorted by (court, startAt), so the first start seen for a local
    // day is that day's earliest.
    const firstByDay = new Map<string, string>();
    for (const s of g.slots) {
      const { day, time } = local(s.startAt);
      if (!firstByDay.has(day)) firstByDay.set(day, time);
    }
    // Spans the transition with days either side of it, so the assertion below
    // is not satisfied by an empty or single-day lattice.
    expect([...firstByDay.keys()]).toEqual(["2026-03-28", "2026-03-29", "2026-03-30", "2026-03-31", "2026-04-01"]);
    // Every local day opens at local midnight, on BOTH sides of the transition.
    expect([...firstByDay.values()]).toEqual(["00:00", "00:00", "00:00", "00:00", "00:00"]);
  });

  it("flags overCap and returns no slots when the lattice is too large", () => {
    const g = buildGrid({
      config: cfg({ window: { from: T0, to: T0 + 400 * DAY }, courts: ["C1", "C2", "C3", "C4"] }),
    });
    expect(g.overCap).toBe(true);
    expect(g.slots.length).toBe(0);
  });

  it("is deterministic", () => {
    expect(buildGrid({ config: cfg() })).toEqual(buildGrid({ config: cfg() }));
  });

  it("exposes the cap", () => {
    expect(MAX_SLOTS).toBe(20_000);
  });
});
