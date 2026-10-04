import { describe, expect, it } from "vitest";
import { JOBS, STREAM_TICK_CRON, TRIGGER_CRON, dueJobs, firstSlotOfHour, triggersOf, type Job } from "../src/schedule";

// Expected values come from the spec's table (§4) and the 2026-10-01 rulings
// (§13), never from JOBS itself.
const at = (iso: string) => new Date(iso);
const ids = (d: Date, cron = TRIGGER_CRON, jobs: readonly Job[] = JOBS) => dueJobs(d, cron, jobs).map((j) => j.id);
const HOURLY = ["registrations", "billing-events", "funnel-remind"];
/** Capture QR v2 §6.11 (W22): the stream-tick trigger, every 5 minutes. Typed from the spec, never read from JOBS. */
const EVERY_5 = "*/5 * * * *";
/** A well-formed trigger no row names. */
const UNKNOWN = "*/7 * * * *";

describe("dueJobs on the hourly trigger", () => {
  it("runs only the every-firing jobs at an ordinary hour", () => {
    expect(ids(at("2026-09-29T14:17:00Z"))).toEqual(HOURLY); // Tuesday
  });

  it("adds each daily job at its own hour, in table order", () => {
    expect(ids(at("2026-09-29T03:17:00Z"))).toEqual([...HOURLY, "ai-previews"]);
    expect(ids(at("2026-09-29T04:17:00Z"))).toEqual([...HOURLY, "relay-sweep"]); // R1
    expect(ids(at("2026-09-29T06:17:00Z"))).toEqual([...HOURLY, "billing-quantity"]);
    expect(ids(at("2026-09-29T07:17:00Z"))).toEqual([...HOURLY, "billing-grant"]);
  });

  it("runs news-digest on Monday 08 UTC and on no other day at 08", () => {
    expect(ids(at("2026-09-28T08:17:00Z"))).toEqual([...HOURLY, "news-digest"]); // Monday
    for (const day of ["2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"]) {
      expect(ids(at(`${day}T08:17:00Z`))).toEqual(HOURLY);
    }
  });

  it("keys on the SCHEDULED hour: a late invocation still runs its own slot", () => {
    // Cloudflare hands a late invocation its slot's scheduledTime. Within the
    // hourly trigger, the minute is irrelevant.
    expect(ids(at("2026-09-28T08:59:59Z"))).toContain("news-digest");
    expect(ids(at("2026-09-28T09:00:00Z"))).not.toContain("news-digest");
  });

  it("over one full week: each every-firing job 168×, each daily 7×, the digest 1×", () => {
    const counts = new Map<string, number>();
    const start = Date.parse("2026-09-28T00:17:00Z"); // Monday
    for (let h = 0; h < 168; h++) {
      for (const id of ids(new Date(start + h * 3_600_000))) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    expect(Object.fromEntries(counts)).toEqual({
      registrations: 168,
      "billing-events": 168,
      "funnel-remind": 168,
      "ai-previews": 7,
      "relay-sweep": 7,
      "billing-quantity": 7,
      "billing-grant": 7,
      "news-digest": 1,
    });
  });
});

describe("dueJobs is keyed on the firing trigger (R4)", () => {
  it("a trigger no row names selects nothing", () => {
    expect(ids(at("2026-09-28T08:05:00Z"), UNKNOWN)).toEqual([]);
    expect(ids(at("2026-09-28T08:17:00Z"), "")).toEqual([]);
  });

  it("the stream-tick row is in the table exactly once, on the spec's */5 trigger (W22)", () => {
    expect(STREAM_TICK_CRON).toBe(EVERY_5);
    expect(JOBS.filter((j) => j.id === "stream-tick")).toEqual([
      { id: "stream-tick", path: "/api/cron/stream-tick", trigger: EVERY_5, due: { kind: "every" }, retry: false, manual: true, failureCounts: ["data.failed"] },
    ]);
  });

  it("a second trigger runs ONLY its own rows: never news-digest or an hourly row, even at Monday 08:05", () => {
    expect(ids(at("2026-09-28T08:05:00Z"), EVERY_5)).toEqual(["stream-tick"]);
    expect(ids(at("2026-09-28T08:17:00Z"), TRIGGER_CRON)).toEqual([...HOURLY, "news-digest"]);
  });

  it("triggersOf lists each distinct trigger once: the hourly one and stream-tick's (spec §6.11: 4 of the account's 5 once both envs deploy)", () => {
    expect(triggersOf()).toEqual(["17 * * * *", EVERY_5]);
  });
});

describe("JOBS table", () => {
  it("has unique ids and paths", () => {
    expect(new Set(JOBS.map((j) => j.id)).size).toBe(JOBS.length);
    expect(new Set(JOBS.map((j) => j.path)).size).toBe(JOBS.length);
  });

  it("retry is off for exactly news-digest (P3/D7), relay-sweep (R1) and stream-tick (its next firing is the retry); every job may be run by hand (R1, R2)", () => {
    expect(JOBS.filter((j) => !j.retry).map((j) => j.id)).toEqual(["relay-sweep", "news-digest", "stream-tick"]);
    expect(JOBS.filter((j) => !j.manual)).toEqual([]);
  });

  it("every daily or weekly row hangs off the hourly trigger (on a faster one its hour test would pass every tick)", () => {
    const timed = JOBS.filter((j) => j.due.kind !== "every");
    expect(timed.map((j) => j.id), "rows checked").toEqual([
      "ai-previews",
      "relay-sweep",
      "billing-quantity",
      "billing-grant",
      "news-digest",
    ]);
    expect(timed.filter((j) => j.trigger !== TRIGGER_CRON)).toEqual([]);
  });

  it("R3: the money jobs name the exact failure counters of their 200 body", () => {
    // From the routes' return types inside lib/http.ts handler's { ok, data }
    // envelope: billing-events → sweepStuckEvents; billing-quantity →
    // reconcileGroupQuantities + sweepOrphanGroups + sweepStaleOrgAddonPrices;
    // billing-grant → grantMonthlyForAllWallets.
    const withCounts = Object.fromEntries(JOBS.filter((j) => j.failureCounts).map((j) => [j.id, j.failureCounts]));
    expect(withCounts).toEqual({
      "billing-events": ["data.failed", "data.alerted"],
      "billing-quantity": ["data.failed", "data.orphanGroups.failed", "data.addonPrices.mismatched"],
      "billing-grant": ["data.failed"],
      // T7b: stream-tick's StreamTickResult.failed — `deferred` is NOT a failure (reached at the next firing).
      "stream-tick": ["data.failed"],
    });
  });
});

describe("firstSlotOfHour (R2 option S: one Sentry event per job per UTC hour)", () => {
  it("every trigger the table uses is one it can judge (anti-vacuity: at least the two triggers)", () => {
    let checked = 0;
    for (const t of triggersOf()) {
      expect(() => firstSlotOfHour(t, at("2026-09-28T08:00:00Z")), t).not.toThrow();
      checked++;
    }
    expect(checked).toBeGreaterThanOrEqual(2);
  });

  it("the hourly trigger fires once an hour, so every firing is its hour's first", () => {
    let checked = 0;
    for (let m = 0; m < 60; m++) {
      expect(firstSlotOfHour(TRIGGER_CRON, new Date(Date.UTC(2026, 8, 28, 8, m))), `:${m}`).toBe(true);
      checked++;
    }
    expect(checked).toBe(60);
  });

  it("*/5: only the :00 slot is the hour's first — minutes 0..4 true, 5..59 false, keyed on UTC", () => {
    const truths: number[] = [];
    for (let m = 0; m < 60; m++) if (firstSlotOfHour(EVERY_5, new Date(Date.UTC(2026, 8, 28, 8, m, 30)))) truths.push(m);
    expect(truths).toEqual([0, 1, 2, 3, 4]);
    // A late invocation of the :00 slot is handed :00 as its scheduledTime, so the slot, not the wall clock, decides.
    expect(firstSlotOfHour(EVERY_5, at("2026-09-28T08:05:00Z"))).toBe(false);
    expect(firstSlotOfHour(EVERY_5, at("2026-09-28T09:00:00Z"))).toBe(true);
  });

  it("any other trigger shape is refused by name — a guard, not a guess", () => {
    let refused = 0;
    for (const t of ["0 9 * * 1", "17 */2 * * *", "*/0 * * * *", "*/60 * * * *", "*/5 9 * * *", ""]) {
      expect(() => firstSlotOfHour(t, at("2026-09-28T08:00:00Z")), JSON.stringify(t)).toThrow(/firstSlotOfHour/);
      refused++;
    }
    expect(refused).toBe(6);
  });
});
