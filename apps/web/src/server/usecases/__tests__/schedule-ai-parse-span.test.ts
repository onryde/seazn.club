// Two more refusal holes from the 2026-08-16 re-bench, both closed without
// touching the engine.
//
// 1. VACUOUS BOUNDS. haiku answered "everything after 2pm except the final"
//    with not_after "23:59" (and, before the prompt fix, not_before "00:00").
//    Both are no-ops: every fixture already satisfies them. The model reached
//    for a rule-shaped thing rather than deferring, and the organiser was shown
//    a constraint that constrains nothing.
//
// 2. RELATIVE DURATION. "run for 4 days from Monday" has no representation, so
//    haiku computed one — first a fabricated 2024 date, then (after the prompt
//    fix) an invented THU weekday. The fix is to give it a way to say the thing
//    while keeping the arithmetic on our side, exactly as rule 1 demands: the
//    model reports the number it read, `resolveParsed` counts the days.
import { describe, expect, it } from "vitest";
import { makeClock } from "@seazn/engine/scheduling";

import { PARSER_PROMPT, RawParsed, resolveParsed } from "../schedule-ai-parse";

const TZ = "Europe/London";
// 2026-08-03 is a Monday, so tomorrow is 2026-08-04 and the next MON is
// 2026-08-10 (makeClock's nextWeekday never returns today).
const CLOCK = makeClock(Date.parse("2026-08-03T09:00:00Z"), TZ);
const COMPETITION = { kind: "competition" } as const;

const resolve = (hard: unknown[]) =>
  resolveParsed(RawParsed.parse({ hard, soft: [], unparsed: [] }), CLOCK, TZ);
// Must resolve IN the target zone. Slicing the UTC ISO string reads midnight
// London under BST as 23:00Z the previous day, so a correct window looks a day
// early — a wrong assertion that would have "confirmed" a wrong implementation.
const fmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const dayKey = (ms: number) => fmt.format(new Date(ms));

describe("bounds that constrain nothing are refused", () => {
  it("refuses not_after 23:59", () => {
    const out = resolve([{ type: "not_after", time: "23:59", scope: COMPETITION }]);

    expect(out.hard).toEqual([]);
    expect(out.unparsed.length).toBe(1);
  });

  it("refuses not_before 00:00", () => {
    const out = resolve([{ type: "not_before", time: "00:00", scope: COMPETITION }]);

    expect(out.hard).toEqual([]);
    expect(out.unparsed.length).toBe(1);
  });

  it("keeps a bound that actually bounds something", () => {
    const out = resolve([{ type: "not_before", time: "09:00", scope: COMPETITION }]);

    expect(out.hard.length).toBe(1);
    expect(out.unparsed).toEqual([]);
  });

  it("keeps not_after 00:00, which is absurd but is not a no-op", () => {
    // It forbids everything, so the verifier will report it. That is a real
    // answer the organiser can see and correct — unlike a rule that silently
    // does nothing.
    const out = resolve([{ type: "not_after", time: "00:00", scope: COMPETITION }]);

    expect(out.hard.length).toBe(1);
  });
});

describe("a run length is stated, never computed by the model", () => {
  it("accepts a span end and resolves it to the last day of the run", () => {
    // "4 days from Monday" — the model copies the 4 it read; we count.
    // MON 2026-08-10 plus 3 more days = THU 2026-08-13.
    const out = resolve([
      {
        type: "window",
        start: { kind: "weekday", weekday: "MON" },
        end: { kind: "span", days: 4 },
        scope: COMPETITION,
      },
    ]);

    expect(out.windowMs).not.toBeNull();
    expect(dayKey(out.windowMs!.from)).toBe("2026-08-10");
    expect(dayKey(out.windowMs!.to)).toBe("2026-08-13");
  });

  it("treats a one-day span as a single day", () => {
    const out = resolve([
      {
        type: "window",
        start: { kind: "tomorrow" },
        end: { kind: "span", days: 1 },
        scope: COMPETITION,
      },
    ]);

    expect(dayKey(out.windowMs!.from)).toBe("2026-08-04");
    expect(dayKey(out.windowMs!.to)).toBe("2026-08-04");
  });

  it("says in its assumptions how the span was counted", () => {
    const out = resolve([
      {
        type: "window",
        start: { kind: "tomorrow" },
        end: { kind: "span", days: 4 },
        scope: COMPETITION,
      },
    ]);

    expect(out.assumptions.join(" ")).toContain("4 days");
  });

  it("rejects a zero or negative span at the schema", () => {
    const bad = RawParsed.safeParse({
      hard: [
        {
          type: "window",
          start: { kind: "today" },
          end: { kind: "span", days: 0 },
          scope: COMPETITION,
        },
      ],
      soft: [],
      unparsed: [],
    });

    expect(bad.success).toBe(false);
  });

  it("does not let a span masquerade as a fixture date", () => {
    // `span` answers "how long does the run last", which is meaningless for a
    // single fixture. Keeping it out of DateRef stops that being expressible.
    const bad = RawParsed.safeParse({
      hard: [
        {
          type: "fixture_on_date",
          selector: { kind: "terminal" },
          date: { kind: "span", days: 4 },
          scope: COMPETITION,
        },
      ],
      soft: [],
      unparsed: [],
    });

    expect(bad.success).toBe(false);
  });

  it("still resolves an ordinary DateRef end", () => {
    const out = resolve([
      {
        type: "window",
        start: { kind: "tomorrow" },
        end: { kind: "weekday", weekday: "FRI" },
        scope: COMPETITION,
      },
    ]);

    expect(dayKey(out.windowMs!.from)).toBe("2026-08-04");
    expect(dayKey(out.windowMs!.to)).toBe("2026-08-07");
  });

  it("documents the span in the prompt", () => {
    expect(PARSER_PROMPT).toContain('"kind":"span"');
  });
});
