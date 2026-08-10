// The two client-side date-order predicates behind the division builder's
// create seed and the registration window.
//
// Both surfaces previously had NO client comparison at all: the builder shipped
// only an advisory `min=` (a typed or pasted value walks straight past it, and
// the server's refusal arrives on a seed PUT the builder deliberately
// swallows), and the registration panel relied entirely on a 422 whose plain
// English message it rendered raw. These functions are what let the refusal be
// localized and to happen before the request.
//
// Pure by design: both call sites use `useLocale()` and cannot be mounted —
// apps/web is vitest `environment: "node"` with no jsdom.
import { describe, expect, it } from "vitest";
import { endDateIsBackwards, startDay, windowIsBackwards } from "../date-order";

describe("startDay", () => {
  it("is the day a datetime-local value falls on, and undefined when blank", () => {
    expect(startDay("2026-10-12T09:15")).toBe("2026-10-12");
    // `undefined`, never "": an always-present `min=""` makes every date
    // unselectable in some browsers, so absence has to stay absence.
    expect(startDay("")).toBeUndefined();
  });
});

describe("endDateIsBackwards", () => {
  it("flags an end date before the start's day", () => {
    expect(endDateIsBackwards("2026-10-12T09:00", "2026-10-11")).toBe(true);
  });

  it("allows same-day and later, including a start late in the day", () => {
    // The same-day case is the one most at risk from a careless `<=`: a
    // one-day division starts and ends on the same date and is completely
    // ordinary.
    expect(endDateIsBackwards("2026-10-12T09:00", "2026-10-12")).toBe(false);
    expect(endDateIsBackwards("2026-10-12T23:45", "2026-10-12")).toBe(false);
    expect(endDateIsBackwards("2026-10-12T09:00", "2026-10-13")).toBe(false);
  });

  it("treats a half-filled pair as unfinished, not backwards", () => {
    // Refusing here would put an error under a field the organiser has not
    // reached yet — the builder's dates are both optional.
    expect(endDateIsBackwards("", "2026-10-11")).toBe(false);
    expect(endDateIsBackwards("2026-10-12T09:00", "")).toBe(false);
    expect(endDateIsBackwards("", "")).toBe(false);
  });

  it("agrees with the min= advisory by construction", () => {
    // The guard and the input's `min` are one expression. If they ever forked,
    // the input would visually permit a value the save then refuses (or the
    // reverse, which is worse — an input that blocks a legal date).
    const start = "2026-10-12T09:00";
    const min = startDay(start)!;
    expect(endDateIsBackwards(start, min)).toBe(false);
    // One day under the advisory floor is exactly what the guard must catch.
    expect(endDateIsBackwards(start, "2026-10-11")).toBe(true);
  });
});

describe("windowIsBackwards", () => {
  it("flags a close at or before the open", () => {
    expect(windowIsBackwards("2026-10-12T10:00:00Z", "2026-10-12T09:00:00Z")).toBe(true);
    // Equal instants: a window that opens and closes together accepts nobody.
    // `>` instead of `>=` would let that through, and the control would look
    // set while doing nothing.
    expect(windowIsBackwards("2026-10-12T10:00:00Z", "2026-10-12T10:00:00Z")).toBe(true);
  });

  it("allows a real window", () => {
    expect(windowIsBackwards("2026-10-12T09:00:00Z", "2026-10-12T10:00:00Z")).toBe(false);
  });

  it("compares INSTANTS, so mixed offsets cannot fool it", () => {
    // THE case, and the reason this is not a string comparison. `IsoDateTime`
    // is `z.iso.datetime({ offset: true })` and accepts any offset, so
    // lexicographic order is chronological only within one offset. Each pair
    // below sorts the OPPOSITE way round to how it actually runs; a `<`/`>=`
    // on the raw strings passes all three and reproduces the exact bug the
    // #498 review caught in `checkInstantOrder`.
    const cases: [string, string, boolean][] = [
      // 06:00Z then 00:00Z — genuinely backwards, but sorts as ascending.
      ["2026-03-01T01:00:00-05:00", "2026-03-01T02:00:00+02:00", true],
      // 00:00Z then 06:00Z — genuinely fine, but sorts as descending.
      ["2026-03-01T02:00:00+02:00", "2026-03-01T01:00:00-05:00", false],
      // Same instant written two ways: zero-length, so refused.
      ["2026-03-01T12:00:00+00:00", "2026-03-01T14:00:00+02:00", true],
    ];
    for (const [open, close, expected] of cases) {
      expect(windowIsBackwards(open, close), `${open} → ${close}`).toBe(expected);
      // And the naive comparison disagrees on every one of them, which is what
      // makes these three load-bearing rather than decorative.
      expect(open >= close).not.toBe(expected);
    }
  });

  it("treats absent and unparseable values as not-backwards", () => {
    // Both fields are nullable, and a half-set window is unfinished. An
    // unparseable value is the schema's to reject: answering "backwards" would
    // show a message about ordering for a problem that is not about ordering.
    expect(windowIsBackwards(null, "2026-10-12T10:00:00Z")).toBe(false);
    expect(windowIsBackwards("2026-10-12T10:00:00Z", null)).toBe(false);
    expect(windowIsBackwards(undefined, undefined)).toBe(false);
    expect(windowIsBackwards("not-a-date", "2026-10-12T10:00:00Z")).toBe(false);
  });

  it("matches the server's own rule, so the two layers cannot disagree", () => {
    // registrations.ts: `new Date(opens_at) >= new Date(closes_at)` → 422.
    // Mirrored here rather than referenced, because the whole point of the
    // client guard is that the server's version is never reached.
    const server = (o: string, c: string) => new Date(o) >= new Date(c);
    for (const [o, c] of [
      ["2026-10-12T10:00:00Z", "2026-10-12T09:00:00Z"],
      ["2026-10-12T10:00:00Z", "2026-10-12T10:00:00Z"],
      ["2026-10-12T09:00:00Z", "2026-10-12T10:00:00Z"],
      ["2026-03-01T01:00:00-05:00", "2026-03-01T02:00:00+02:00"],
    ] as const) {
      expect(windowIsBackwards(o, c), `${o} → ${c}`).toBe(server(o, c));
    }
  });
});
