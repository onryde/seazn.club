// A schedule window whose end precedes its start used to save cleanly, and the
// damage was invisible: `applyWindow` turns `startAt`/`endAt` into
// `SlotConfig.window`, and `calendar.ts` places a fixture only when
// `a.startAt >= w.from && a.endAt <= w.to`. With `from > to` NOTHING can satisfy
// that, so every fixture becomes unplaceable — an empty board and no error, not
// a validation message. The owner hit it with 22/08/2026 09:36 → 11/08/2026.
//
// The guard is on `PutScheduleSettings`, the write wrapper, and these tests pin
// WHY it is not on `ScheduleConfig` itself. `ScheduleConfig` is also the READ
// path — `schedule.ts:296` runs `.parse` over the stored `schedule_settings`
// jsonb and `.parse` throws, and `competition-schedule-ai.ts:2429` `safeParse`s
// the same rows. Refining it would take every division that ALREADY holds a
// reversed range and turn its schedule page into a 500. The last test here is
// the one that keeps that distinction from being "tidied away".
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  ENDS_BEFORE_STARTS,
  PutScheduleSettings,
  ScheduleConfig,
  WINDOW_ENDS_BEFORE_STARTS,
} from "@/server/api-v1/schemas";

// P9 pass 3b: `ScheduleConfig.courts` is `z.array(CourtId)` (real
// `courts.id` uuids). This suite is pure schema validation — no DB, no
// `HAS_DB` gate — so a random uuid satisfies the shape without a live
// courts row to seed against. NOTE: `blackouts[].court` (below) is a
// SEPARATE, free-text `z.string().max(100).optional()` field (schemas.ts)
// — it stays a plain label and is deliberately left untouched.
const COURT_1 = randomUUID();

const BASE = {
  matchMinutes: 30,
  gapMinutes: 0,
  courts: [COURT_1],
  perEntrantMinRest: 0,
  blackouts: [],
  sessionWindows: [],
};

const AUG_11 = "2026-08-11T22:59:00.000Z";
const AUG_22 = "2026-08-22T08:36:00.000Z";

/** Every issue's dotted path plus its message, so an assertion cannot pass on
 *  "something was rejected" while the refusal points at the wrong field. */
const issues = (input: unknown) => {
  const r = PutScheduleSettings.safeParse(input);
  return r.success ? [] : r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
};

describe("PutScheduleSettings — a reversed range is refused on the way in", () => {
  it("refuses an end that precedes the start, naming config.endAt", () => {
    expect(issues({ config: { ...BASE, startAt: AUG_22, endAt: AUG_11 } })).toEqual([
      `config.endAt: ${ENDS_BEFORE_STARTS}`,
    ]);
  });

  it("accepts the same two instants the right way round", () => {
    expect(issues({ config: { ...BASE, startAt: AUG_11, endAt: AUG_22 } })).toEqual([]);
  });

  // A zero-length window is empty, not incoherent, and an organiser cannot act
  // on a validation error for it — the unschedulable board is the clearer
  // signal. Pinned so "reversed" is not quietly widened to "not strictly
  // increasing", which would start refusing saves that work today.
  it("accepts an identical start and end rather than treating equal as reversed", () => {
    expect(issues({ config: { ...BASE, startAt: AUG_22, endAt: AUG_22 } })).toEqual([]);
  });

  // The bug this suite originally MISSED. `IsoDateTime` is
  // `z.iso.datetime({ offset: true })` and accepts any offset, so a string
  // comparison is chronological only by accident. These two are genuinely
  // reversed — 06:00 UTC then 00:00 UTC — but sort the right way round as
  // strings, so the first version of the guard accepted them silently. The
  // whole suite used `.000Z` literals and could not see it.
  it("refuses a range that is only reversed once offsets are resolved", () => {
    const startAt = "2026-03-01T01:00:00-05:00"; // 06:00 UTC
    const endAt = "2026-03-01T02:00:00+02:00"; // 00:00 UTC — earlier
    expect(endAt > startAt, "the string order must disagree, or this proves nothing").toBe(true);
    expect(Date.parse(endAt) < Date.parse(startAt), "and the instants must be reversed").toBe(true);
    expect(issues({ config: { ...BASE, startAt, endAt } })).toEqual([
      `config.endAt: ${ENDS_BEFORE_STARTS}`,
    ]);
  });

  it("accepts a mixed-offset range that is correctly ordered as instants", () => {
    // The mirror of the case above: string order says reversed, the instants
    // say fine. A guard that merely flipped the comparison would fail here.
    const startAt = "2026-03-01T02:00:00+02:00"; // 00:00 UTC
    const endAt = "2026-03-01T01:00:00-05:00"; // 06:00 UTC — later
    expect(endAt < startAt, "the string order must disagree, or this proves nothing").toBe(true);
    expect(issues({ config: { ...BASE, startAt, endAt } })).toEqual([]);
  });

  it("resolves offsets for blackout rows too, not just the top-level pair", () => {
    expect(
      issues({
        config: {
          ...BASE,
          blackouts: [{ from: "2026-03-01T01:00:00-05:00", to: "2026-03-01T02:00:00+02:00" }],
        },
      }),
    ).toEqual([`config.blackouts.0.to: ${WINDOW_ENDS_BEFORE_STARTS}`]);
  });

  it("ignores the pair when either end is absent", () => {
    expect(issues({ config: { ...BASE, startAt: AUG_22, endAt: null } })).toEqual([]);
    expect(issues({ config: { ...BASE, startAt: null, endAt: AUG_11 } })).toEqual([]);
  });

  it("refuses a reversed blackout row and names its index", () => {
    expect(
      issues({
        config: {
          ...BASE,
          blackouts: [
            { from: AUG_11, to: AUG_22 },
            { court: "Court 1", from: AUG_22, to: AUG_11 },
          ],
        },
      }),
    ).toEqual([`config.blackouts.1.to: ${WINDOW_ENDS_BEFORE_STARTS}`]);
  });

  it("refuses a reversed session window and names its index", () => {
    expect(
      issues({ config: { ...BASE, sessionWindows: [{ from: AUG_22, to: AUG_11 }] } }),
    ).toEqual([`config.sessionWindows.0.to: ${WINDOW_ENDS_BEFORE_STARTS}`]);
  });

  it("reports every reversed pair at once, not just the first", () => {
    const found = issues({
      config: {
        ...BASE,
        startAt: AUG_22,
        endAt: AUG_11,
        blackouts: [{ from: AUG_22, to: AUG_11 }],
        sessionWindows: [{ from: AUG_22, to: AUG_11 }],
      },
    });
    expect(found).toHaveLength(3);
    expect(found).toContain(`config.endAt: ${ENDS_BEFORE_STARTS}`);
    expect(found).toContain(`config.blackouts.0.to: ${WINDOW_ENDS_BEFORE_STARTS}`);
    expect(found).toContain(`config.sessionWindows.0.to: ${WINDOW_ENDS_BEFORE_STARTS}`);
  });
});

describe("ScheduleConfig itself stays permissive — it is the READ path", () => {
  // Load-bearing. If someone moves the refine onto `ScheduleConfig` to "cover
  // more callers", every division already holding a reversed range stops
  // loading: `schedule.ts:296` parses the stored jsonb with `.parse`, which
  // throws. This test is the tripwire for that specific well-intentioned edit.
  it("still parses a stored config whose range is reversed", () => {
    const parsed = ScheduleConfig.safeParse({ ...BASE, startAt: AUG_22, endAt: AUG_11 });
    expect(parsed.success, "a legacy reversed row must remain READABLE").toBe(true);
  });

  it("still parses stored blackouts and session windows that are reversed", () => {
    const parsed = ScheduleConfig.safeParse({
      ...BASE,
      blackouts: [{ from: AUG_22, to: AUG_11 }],
      sessionWindows: [{ from: AUG_22, to: AUG_11 }],
    });
    expect(parsed.success).toBe(true);
  });
});
