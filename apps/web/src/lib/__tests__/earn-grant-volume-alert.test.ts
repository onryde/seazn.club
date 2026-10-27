// v17 gap #296 — daily earn_grant volume backstop. A farming attempt spreads
// across many throwaway orgs (each its own wallet), so this counts
// GLOBALLY across every wallet, not per-wallet — the point is to catch the
// PATTERN, not one org's total. shouldAlertOnEarnGrantVolume carries the
// threshold decision as a pure function (no DB, no flake risk from other
// suites concurrently writing earn_grant rows into the same shared schema);
// earnGrantVolumeToday and checkEarnGrantVolumeAlert are thin wiring on top,
// exercised in the "clearly over" direction only — see the file's own
// comments for why the "under threshold" direction is proven at the pure
// level instead of against a DB whose day-total this suite doesn't own.
// The alert's tests pin the clock to a UTC day of their own (`ownDay`): the
// alert's key is the day, and the kind sweep queues today's.
//
// Real Postgres for the DB describes; skipped without DATABASE_URL. Sport:
// not applicable (a platform-wide ledger count, no sport).
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

// The alert is queued on the email outbox (phase 3 wave 5, kind `staff_earn_grant_volume`, once per UTC day: the key is the day
// itself, P-W5-15) to this suite's own STAFF_ALERT_EMAIL, so the tests read its rows (`staffRows`). The builder is a spy that calls
// through, so what the alert SAYS is read where it enters the mail, and Sentry's issue capture is observed (call-through) so a test
// can assert the writer dropped nothing. The worker never runs here: the transport is the one network seam and is stubbed.
vi.mock("@/lib/email", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/email")>();
  return { ...actual, earnGrantVolumeAlertEmail: vi.fn(actual.earnGrantVolumeAlertEmail) };
});
vi.mock("@/lib/sentry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sentry")>();
  return { ...actual, captureError: vi.fn(actual.captureError) };
});
vi.mock("@/server/email-outbox/transport", () => ({ deliver: vi.fn() }));

import { sql, statementCount } from "@/lib/db";
import { earnGrantVolumeAlertEmail } from "@/lib/email";
import { captureError } from "@/lib/sentry";
import { log } from "@/server/logger";
import { staffAlertDrops, staffRows } from "@/server/usecases/__tests__/_money-fixtures";
import {
  EARN_GRANT_DAILY_ALERT_THRESHOLD,
  checkEarnGrantVolumeAlert,
  earnGrantVolumeToday,
  shouldAlertOnEarnGrantVolume,
  utcDayStart,
} from "../credits";

const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 8);
const KIND = "staff_earn_grant_volume";
const RUN = `egv-${uniq()}`;
const DAY_MS = 86_400_000;
const earnAlert = vi.mocked(earnGrantVolumeAlertEmail);
let staff = "";
let errors: ReturnType<typeof vi.spyOn>;
/** What the writer's never-throws catch left (I2): an alert that was queued or deduplicated left nothing. */
const drops = () => staffAlertDrops(errors, vi.mocked(captureError));
const utcDay = (d: Date): string => d.toISOString().slice(0, 10);

async function seedEarnGrantRow(createdAt: Date = new Date()): Promise<void> {
  await sql`
    insert into ai_credit_ledger (wallet_id, delta, source, bucket, balance_after, idempotency_key, created_at)
    values (${randomUUID()}, 10, 'earn_grant', 'pack', 10, ${`vol-${uniq()}`}, ${createdAt})`;
}

/**
 * Pin the clock (Date only: the database and its timers keep real time) to noon of a UTC day this test owns, and clear the outbox
 * rows of this kind already keyed to it. The key IS the day (P-W5-15), global by nature, and the kind sweep queues today's: a test
 * on the real today would race it for the one row the day may hold. A day from 2001-2020 is a day no other suite writes; the
 * delete is for a database that has run this file before. Returns the day.
 */
async function ownDay(): Promise<string> {
  const at = new Date(Date.UTC(2001, 0, 1, 12) + Math.floor(Math.random() * 7000) * DAY_MS);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(at);
  await sql`delete from email_outbox where kind = ${KIND} and dedupe_key in (${utcDay(at)}, ${utcDay(new Date(at.getTime() + DAY_MS))})`;
  return utcDay(at);
}

/** Enough earn grants on the pinned day to cross the threshold whatever else the shared schema holds. */
async function seedOverThreshold(): Promise<void> {
  for (let i = 0; i < EARN_GRANT_DAILY_ALERT_THRESHOLD; i++) await seedEarnGrantRow();
}

/** One queued volume alert to this test's staff address for `day`. `count` is what the producer handed the builder: the platform
 *  counts every earn grant since the day began, which neighbouring suites move, so the test bounds it and the subject carries it. */
const volumeRow = (day: string, count: number) => ({
  ref_id: day,
  dedupe_key: day,
  status: "queued",
  recipient: staff,
  subject: `Earn-grant volume alert: ${count} today (threshold 20)`,
});

beforeEach(() => {
  earnAlert.mockReset(); // restores the call-through, and drops a once-implementation a failed test left behind
  vi.mocked(captureError).mockClear();
  errors = vi.spyOn(log, "error");
  // This test's own staff address: CI sets none, and the database is shared.
  staff = `staff-${RUN}-${uniq()}@x.test`;
  vi.stubEnv("STAFF_ALERT_EMAIL", staff);
});

afterEach(() => {
  vi.useRealTimers();
  errors.mockRestore();
  vi.unstubAllEnvs();
});

afterAll(async () => {
  if (!HAS_DB) return;
  await sql`delete from email_outbox where kind = ${KIND} and lower(recipient) like ${`staff-${RUN}-%`}`;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

describe("shouldAlertOnEarnGrantVolume (pure, v17 gap #296)", () => {
  it("false strictly below the threshold", () => {
    expect(shouldAlertOnEarnGrantVolume(EARN_GRANT_DAILY_ALERT_THRESHOLD - 1)).toBe(false);
  });
  it("true at or above the threshold", () => {
    expect(shouldAlertOnEarnGrantVolume(EARN_GRANT_DAILY_ALERT_THRESHOLD)).toBe(true);
    expect(shouldAlertOnEarnGrantVolume(EARN_GRANT_DAILY_ALERT_THRESHOLD + 5)).toBe(true);
  });
  it("respects a custom threshold", () => {
    expect(shouldAlertOnEarnGrantVolume(3, 5)).toBe(false);
    expect(shouldAlertOnEarnGrantVolume(5, 5)).toBe(true);
  });
});

describe("utcDayStart (pure, #292 discipline)", () => {
  // The SQL comparison itself (timestamptz column vs timestamptz PARAMETER)
  // is TZ-immune by construction — see utcMonthStart's docstring for the
  // proven session-TZ divergence that rules out SQL date_trunc. What needs
  // pinning here is that the JS truncation really is UTC, not local.
  it("truncates to 00:00 UTC of the same UTC day", () => {
    expect(utcDayStart(new Date("2026-07-27T23:59:59.999Z")).toISOString()).toBe(
      "2026-07-27T00:00:00.000Z",
    );
    expect(utcDayStart(new Date("2026-07-27T00:00:00.000Z")).toISOString()).toBe(
      "2026-07-27T00:00:00.000Z",
    );
  });
  it("a pre-UTC-midnight instant belongs to the PREVIOUS UTC day (the case a London session TZ gets wrong)", () => {
    // 2026-06-30 23:30 UTC is 2026-07-01 00:30 in Europe/London — a session-TZ
    // date_trunc('day', …) would file it under July 1; UTC truncation must not.
    expect(utcDayStart(new Date("2026-06-30T23:30:00.000Z")).toISOString()).toBe(
      "2026-06-30T00:00:00.000Z",
    );
  });
});

describe.skipIf(!HAS_DB)("earnGrantVolumeToday (v17 gap #296)", () => {
  it("counts exactly the rows at/after the passed anchor — deterministic via a future window no neighbor suite can touch", async () => {
    // Neighbor suites (credits-earn, publish-earn-gate, referral-grants, …)
    // insert earn_grant rows with created_at = now(), which can never land
    // at/after a FUTURE anchor — so the window's contents are fully
    // test-owned and the delta is exact, unlike a live-window `before + 2`
    // (which raced a parallel worker in review). Delta-based rather than
    // absolute so prior RUNS of this same file (persistent schema) can't
    // break it either.
    const anchor = utcDayStart(new Date(Date.now() + 2 * 86_400_000));
    const before = await earnGrantVolumeToday(anchor);
    await seedEarnGrantRow(new Date(anchor.getTime() - 1000)); // 1s BEFORE the boundary — excluded
    await seedEarnGrantRow(anchor); // exactly AT the boundary — included (>=)
    await seedEarnGrantRow(new Date(anchor.getTime() + 3_600_000)); // inside the day — included
    expect(await earnGrantVolumeToday(anchor)).toBe(before + 2);
  });

  it("live window sanity: seeding rows raises today's count (>= — the shared schema has concurrent writers)", async () => {
    // Anchor captured ONCE so even a UTC-midnight rollover mid-test cannot
    // shrink the window between the two reads.
    const dayStart = utcDayStart();
    const before = await earnGrantVolumeToday(dayStart);
    await seedEarnGrantRow();
    await seedEarnGrantRow();
    expect(await earnGrantVolumeToday(dayStart)).toBeGreaterThanOrEqual(before + 2);
  });
});

describe.skipIf(!HAS_DB)("checkEarnGrantVolumeAlert (v17 gap #296)", () => {
  it("a day over the threshold pages once", async () => {
    const day = await ownDay();
    await seedOverThreshold();

    const id = await checkEarnGrantVolumeAlert();

    expect(id, "the queued row's id").toEqual(expect.any(String));
    expect(earnAlert, "what the alert says").toHaveBeenCalledTimes(1);
    const { count, threshold } = earnAlert.mock.calls[0]![0];
    expect(threshold).toBe(20);
    expect(count, "every earn grant since the day began, the seeded ones among them").toBeGreaterThanOrEqual(20);
    expect(await staffRows(KIND, "utc_day", day)).toEqual([volumeRow(day, count)]);
    expect(drops(), "the alert was queued, not dropped").toEqual({ logged: 0, issues: 0 });
  });

  it("the cron's same-day retry pages nothing more", async () => {
    // The cron runs daily with `retry: true`: a second pass the same UTC day (a retry, a second scheduler) finds the day's key taken.
    const day = await ownDay();
    await seedOverThreshold();

    const first = await checkEarnGrantVolumeAlert();
    await seedEarnGrantRow(); // later grants the same day are not re-paged: that is the point of a daily key
    const second = await checkEarnGrantVolumeAlert();

    expect(first).toEqual(expect.any(String));
    expect(second, "the day's key is taken").toBeNull();
    expect(earnAlert, "premise: the second pass was over the threshold too, and reached the alert").toHaveBeenCalledTimes(2);
    const { count } = earnAlert.mock.calls[0]![0];
    expect(await staffRows(KIND, "utc_day", day)).toEqual([volumeRow(day, count)]);
    expect(drops(), "deduplicated, not dropped").toEqual({ logged: 0, issues: 0 });
  });

  it("the next UTC day over the threshold pages again", async () => {
    // The positive pair of the same-day retry: a persistent high volume repeats the alert once a day.
    const day = await ownDay();
    await seedOverThreshold();
    await checkEarnGrantVolumeAlert();

    const next = new Date(Date.now() + DAY_MS);
    vi.setSystemTime(next);
    await seedOverThreshold();
    const id = await checkEarnGrantVolumeAlert();

    expect(id, "a new day is a new key").toEqual(expect.any(String));
    const [a, b] = earnAlert.mock.calls.map((c) => c[0].count);
    expect(await staffRows(KIND, "utc_day", day)).toEqual([volumeRow(day, a!)]);
    expect(await staffRows(KIND, "utc_day", utcDay(next))).toEqual([volumeRow(utcDay(next), b!)]);
    expect(drops(), "both queued, nothing dropped").toEqual({ logged: 0, issues: 0 });
  });

  it("unset: today's volume is never counted", async () => {
    // Cheap guard first: with no address (the normal case outside production) no alert can go anywhere, so the cron pays for no
    // count. The positive pair is "a day over the threshold pages once".
    const day = await ownDay();
    await seedOverThreshold();
    vi.stubEnv("STAFF_ALERT_EMAIL", "");

    const before = statementCount();
    expect(await checkEarnGrantVolumeAlert()).toBeNull();

    expect(statementCount() - before, "no statement at all: neither the count nor an insert").toBe(0);
    expect(earnAlert).not.toHaveBeenCalled();
    expect(await staffRows(KIND, "utc_day", day)).toEqual([]);
  });

  it("never throws: an alert that cannot be queued is logged and dropped, and the cron is unaffected", async () => {
    const day = await ownDay();
    await seedOverThreshold();
    earnAlert.mockImplementationOnce(() => {
      throw new Error("render failed");
    });

    await expect(checkEarnGrantVolumeAlert()).resolves.toBeNull();

    expect(await staffRows(KIND, "utc_day", day)).toEqual([]);
    expect(drops(), "the drop is logged once and raised to Sentry once").toEqual({ logged: 1, issues: 1 });
  });
});

// The builder renders what the alert says; the tests above prove where it goes.
describe("earnGrantVolumeAlertEmail (the alert's copy, v17 gap #296)", () => {
  it("names the day's count and the threshold, and points at the margin panel", () => {
    const mail = earnGrantVolumeAlertEmail({ count: 37, threshold: 20 });
    expect(mail.subject).toBe("Earn-grant volume alert: 37 today (threshold 20)");
    for (const part of [mail.html, mail.text]) {
      expect(part).toContain("37 earn_grant credit rows have landed today");
      expect(part).toContain("/admin/revenue");
    }
    expect(mail.text).toContain("earn_grant rows today: 37 · threshold: 20");
  });
});
