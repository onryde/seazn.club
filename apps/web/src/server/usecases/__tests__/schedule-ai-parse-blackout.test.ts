// A mid-day break, per docs/superpowers/specs/2026-08-16-parser-blackout-design.md.
//
// The engine has had `Blackout {court?, from, to}` all along — build-grid removes
// those slots, the verifier reports violations, and schedule-ai already ships
// config.blackouts into the pack. Only the parser lacked the word, which is why
// the bench caught the shipped model compiling "lunch break 12PM to 1PM" into
// not_before 12:00 + not_after 13:00 and confining a whole tournament to the
// lunch hour.
//
// resolveParsed keeps the break SYMBOLIC. It cannot expand it: with no date
// range stated it has no idea which days the run covers — only the pack does.
import { describe, expect, it } from "vitest";
import { makeClock } from "@seazn/engine/scheduling";

import { expandDailyBreaks, PARSER_PROMPT, RawParsed, resolveParsed } from "../schedule-ai-parse";

const TZ = "Europe/London";
const CLOCK = makeClock(Date.parse("2026-08-03T09:00:00Z"), TZ);
const COMPETITION = { kind: "competition" } as const;
const DIVISION = { kind: "division", divisionId: "d1" } as const;
const COURTS = ["Court 1", "Court 2"];

const resolve = (hard: unknown[], hints: { courts?: string[] } = { courts: COURTS }) =>
  resolveParsed(RawParsed.parse({ hard, soft: [], unparsed: [] }), CLOCK, TZ, hints);

const lunch = (over: Record<string, unknown> = {}) => ({
  type: "no_play_between",
  from: "12:00",
  to: "13:00",
  scope: COMPETITION,
  ...over,
});

describe("a mid-day break compiles instead of becoming a whole-day bound", () => {
  it("carries a global break through as a symbolic daily break", () => {
    const out = resolve([lunch()]);

    expect(out.dailyBreaks).toEqual([{ from: "12:00", to: "13:00" }]);
    // It must NOT masquerade as a hard rule: the engine models this as a
    // Blackout on the config, not as a HardConstraint the referee checks.
    expect(out.hard).toEqual([]);
    expect(out.unparsed).toEqual([]);
  });

  it("says in its assumptions that the break applies to every day", () => {
    const out = resolve([lunch()]);

    expect(out.assumptions.join(" ")).toContain("every day");
  });

  it("keeps a court the organiser was actually shown", () => {
    const out = resolve([lunch({ court: "Court 2" })]);

    expect(out.dailyBreaks).toEqual([{ from: "12:00", to: "13:00", court: "Court 2" }]);
  });

  it("resolves a break alongside an ordinary window", () => {
    const out = resolve([
      lunch(),
      {
        type: "window",
        start: { kind: "tomorrow" },
        end: { kind: "weekday", weekday: "FRI" },
        scope: COMPETITION,
      },
    ]);

    expect(out.dailyBreaks.length).toBe(1);
    expect(out.windowMs).not.toBeNull();
  });
});

describe("breaks that cannot be honoured are deferred, never approximated", () => {
  it("refuses a break whose end is not after its start", () => {
    const out = resolve([lunch({ from: "13:00", to: "12:00" })]);

    expect(out.dailyBreaks).toEqual([]);
    expect(out.unparsed.length).toBe(1);
  });

  it("refuses a zero-length break", () => {
    const out = resolve([lunch({ from: "12:00", to: "12:00" })]);

    expect(out.dailyBreaks).toEqual([]);
    expect(out.unparsed.length).toBe(1);
  });

  it("refuses a break that spans midnight", () => {
    // 22:00 -> 02:00 is two blackouts on two different days, not one. Reading
    // it as a same-day window would silently invert the organiser's meaning.
    const out = resolve([lunch({ from: "22:00", to: "02:00" })]);

    expect(out.dailyBreaks).toEqual([]);
    expect(out.unparsed.length).toBe(1);
  });

  it("defers the WHOLE break when the court was never shown", () => {
    // Dropping just the court would turn "court 2 is closed at lunch" into
    // "everything stops at lunch" — a bigger constraint than was stated, which
    // is the same harm as the original bug by another route.
    const out = resolve([lunch({ court: "Centre Court" })]);

    expect(out.dailyBreaks).toEqual([]);
    expect(out.unparsed.length).toBe(1);
    expect(out.unparsed[0]).toContain("Centre Court");
  });

  it("defers a court-scoped break when no court list was supplied", () => {
    // Fail safe: unverifiable is not the same as fine.
    const out = resolve([lunch({ court: "Court 2" })], {});

    expect(out.dailyBreaks).toEqual([]);
    expect(out.unparsed.length).toBe(1);
  });

  it("still allows a GLOBAL break when no court list was supplied", () => {
    // Nothing to verify, so nothing to fail.
    const out = resolve([lunch()], {});

    expect(out.dailyBreaks.length).toBe(1);
  });

  it("refuses a division-scoped break, as a division-scoped window already is", () => {
    // Engine Blackout has no division concept, so scoping one to a division
    // would quietly apply it to everybody.
    const out = resolve([lunch({ scope: DIVISION })]);

    expect(out.dailyBreaks).toEqual([]);
    expect(out.unparsed.length).toBe(1);
  });
});

describe("expandDailyBreaks turns one symbolic break into one blackout per day", () => {
  const at = (ms: number) =>
    new Intl.DateTimeFormat("en-GB", {
      timeZone: TZ,
      dateStyle: "short",
      timeStyle: "short",
      hour12: false,
    }).format(new Date(ms));

  it("emits one blackout for each day of the run", () => {
    const out = expandDailyBreaks([{ from: "12:00", to: "13:00" }], "2026-08-10", "2026-08-12", TZ);

    expect(out.length).toBe(3);
    expect(out.map((b) => at(b.from))).toEqual(["10/08/2026, 12:00", "11/08/2026, 12:00", "12/08/2026, 12:00"]);
    expect(out.map((b) => at(b.to))).toEqual(["10/08/2026, 13:00", "11/08/2026, 13:00", "12/08/2026, 13:00"]);
  });

  it("keeps local noon across a DST boundary", () => {
    // 2026-03-29 is the BST transition: that day is 23 hours long. Stepping by
    // 86_400_000 from the 28th lands at 13:00 local on the 29th — an hour of
    // play silently deleted, and an hour of lunch silently kept.
    const out = expandDailyBreaks([{ from: "12:00", to: "13:00" }], "2026-03-28", "2026-03-30", TZ);

    expect(out.map((b) => at(b.from))).toEqual([
      "28/03/2026, 12:00",
      "29/03/2026, 12:00",
      "30/03/2026, 12:00",
    ]);
  });

  it("carries the court label onto every day", () => {
    const out = expandDailyBreaks(
      [{ from: "12:00", to: "13:00", court: "Court 2" }],
      "2026-08-10",
      "2026-08-11",
      TZ,
    );

    expect(out.every((b) => b.court === "Court 2")).toBe(true);
  });

  it("emits nothing for an empty break list", () => {
    expect(expandDailyBreaks([], "2026-08-10", "2026-08-12", TZ)).toEqual([]);
  });

  it("emits one day when the run is a single day", () => {
    expect(expandDailyBreaks([{ from: "12:00", to: "13:00" }], "2026-08-10", "2026-08-10", TZ).length).toBe(1);
  });
});

describe("the prompt teaches the new word", () => {
  it("documents no_play_between", () => {
    expect(PARSER_PROMPT).toContain("no_play_between");
  });

  it("no longer tells the model a mid-day break is unexpressible", () => {
    expect(PARSER_PROMPT).not.toContain("there is no way to say a break in the middle of a day");
  });
});
