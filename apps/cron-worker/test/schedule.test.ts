import { describe, expect, it } from "vitest";
import { JOBS, TRIGGER_CRON, dueJobs, triggersOf, type Job } from "../src/schedule";

// Expected values come from the spec's table (§4) and the 2026-10-01 rulings
// (§13), never from JOBS itself.
const at = (iso: string) => new Date(iso);
const ids = (d: Date, cron = TRIGGER_CRON, jobs: readonly Job[] = JOBS) => dueJobs(d, cron, jobs).map((j) => j.id);
const HOURLY = ["registrations", "billing-events", "funnel-remind"];
const FAST = "*/5 * * * *";
// R4 fixture: the shape capture-QR v2's stream-tick will add. One row, its own trigger.
const TICK: Job = {
  id: "stream-tick",
  path: "/api/cron/stream-tick",
  trigger: FAST,
  due: { kind: "every" },
  retry: false,
  manual: true,
};

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
    expect(ids(at("2026-09-28T08:05:00Z"), FAST)).toEqual([]);
    expect(ids(at("2026-09-28T08:17:00Z"), "")).toEqual([]);
  });

  it("a second trigger runs ONLY its own rows: never news-digest or an hourly row, even at Monday 08:05", () => {
    const withTick = [...JOBS, TICK];
    expect(ids(at("2026-09-28T08:05:00Z"), FAST, withTick)).toEqual(["stream-tick"]);
    expect(ids(at("2026-09-28T08:17:00Z"), TRIGGER_CRON, withTick)).toEqual([...HOURLY, "news-digest"]);
  });

  it("triggersOf lists each distinct trigger once; today only the hourly one (spec §3)", () => {
    expect(triggersOf()).toEqual(["17 * * * *"]);
    expect(triggersOf([...JOBS, TICK])).toEqual(["17 * * * *", FAST]);
  });
});

describe("JOBS table", () => {
  it("has unique ids and paths", () => {
    expect(new Set(JOBS.map((j) => j.id)).size).toBe(JOBS.length);
    expect(new Set(JOBS.map((j) => j.path)).size).toBe(JOBS.length);
  });

  it("retry is off for exactly news-digest (P3/D7) and relay-sweep (R1); every job may be run by hand (R1, R2)", () => {
    expect(JOBS.filter((j) => !j.retry).map((j) => j.id)).toEqual(["relay-sweep", "news-digest"]);
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
    });
  });
});
