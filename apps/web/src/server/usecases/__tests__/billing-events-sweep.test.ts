// Stuck-webhook auto-replay sweep (payments-hardening Task 11, P1-7): events
// that land in billing_events but never get processed (deploy crash / transient
// DB error mid-handler) sit `received` forever. sweepStuckEvents re-pulls each
// stuck row FRESH from Stripe (the trust anchor — never the stored payload) and
// replays it; handlers are replay-idempotent by contract, so this is safe. A
// row is retried up to 3 times, then parked (attempts capped at 4 so the sweep
// never re-selects it; the park moves it from 3 to 4 or not at all, so two
// overlapping passes park it once) and staff are alerted once.
//
// Real Postgres required; skipped without DATABASE_URL. Seeds are run-unique
// (randomUUID) and beforeEach clears the sweep's working set (old unprocessed
// rows) so the returned counts are exact; the 10-minute window means any
// concurrent FRESH row (received now) is left untouched.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

// The parked-event staff alert is queued on the email outbox (phase 3 wave 5,
// kind `staff_stuck_events`, once per event: `<event>:parked`) to this suite's
// own STAFF_ALERT_EMAIL, so the tests read its rows (`staffRows`). Its builder is
// a spy that calls through, so what the alert SAYS is read where it enters the
// mail, and Sentry's issue capture is observed (call-through) so a test can
// assert the writer dropped nothing. The worker never runs here: the transport
// is the one network seam and is stubbed.
vi.mock("@/lib/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email")>();
  return { ...actual, stuckEventsAlertEmail: vi.fn(actual.stuckEventsAlertEmail) };
});
vi.mock("@/lib/sentry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sentry")>();
  return { ...actual, captureError: vi.fn(actual.captureError) };
});
vi.mock("@/server/email-outbox/transport", () => ({ deliver: vi.fn() }));

// The sweep re-pulls each event via getStripe().events.retrieve (the trust
// anchor). Stub that seam — @/lib/stripe exports only getStripe.
const stripeMock = vi.hoisted(() => {
  const retrieve = vi.fn();
  return { retrieve, stripe: { events: { retrieve } } };
});
vi.mock("@/lib/stripe", () => ({ getStripe: () => stripeMock.stripe }));

import { sql } from "@/lib/db";
import { stuckEventsAlertEmail } from "@/lib/email";
import { captureError } from "@/lib/sentry";
import { log } from "@/server/logger";
import { sweepStuckEvents } from "../billing-events";
import { staffAlertDrops, staffRows } from "./_money-fixtures";
import { backendPid, pollWaitersBehind } from "../external-play/__tests__/_lock-waiters";

const HAS_DB = !!process.env.DATABASE_URL;
const evtId = (tag: string) => `evt_sweep_${tag}_${randomUUID().slice(0, 8)}`;
const KIND = "staff_stuck_events";
const RUN = `bes-${randomUUID().slice(0, 8)}`;
const stuckAlert = vi.mocked(stuckEventsAlertEmail);
let staff = "";
let errors: ReturnType<typeof vi.spyOn>;
/** What the writer's never-throws catch left (I2): an alert that was queued or deduplicated left nothing. */
const drops = () => staffAlertDrops(errors, vi.mocked(captureError));
/** One queued parked-event alert to this test's staff address, keyed `<event>:parked`. The subject is the builder's inline English,
 *  typed from its source. */
const parkedRow = (eventId: string) => ({
  ref_id: `${eventId}:parked`,
  dedupe_key: `${eventId}:parked`,
  status: "queued",
  recipient: staff,
  subject: `Stuck webhook event needs review: ${eventId}`,
});

/** A stuck ledger row: received `ageMin` ago, never processed, `attempts` tries. */
async function seedStuck(id: string, attempts = 0, ageMin = 20): Promise<void> {
  await sql`
    insert into billing_events (id, type, org_id, payload, received_at, replay_attempts)
    values (${id}, 'product.created', null, '{}',
            now() - (${ageMin} * interval '1 minute'), ${attempts})`;
}

/** The no-op event the retrieve stub returns: an unhandled type dispatches to a
 *  silent no-op, so runEvent just stamps processed_at. */
const fakeEvent = (id: string) => ({
  id,
  type: "product.created",
  created: 0,
  data: { object: { metadata: {} } },
});

beforeEach(async () => {
  stuckAlert.mockClear();
  vi.mocked(captureError).mockClear();
  errors = vi.spyOn(log, "error");
  stripeMock.retrieve.mockReset();
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_sweep");
  // This test's own staff address: CI sets none, and the database is shared.
  staff = `staff-${RUN}-${randomUUID().slice(0, 8)}@x.test`;
  vi.stubEnv("STAFF_ALERT_EMAIL", staff);
  if (!HAS_DB) return;
  await sql`delete from billing_events
    where processed_at is null and received_at < now() - interval '10 minutes'`;
});
afterEach(() => {
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

describe.skipIf(!HAS_DB)("sweepStuckEvents (P1-7)", () => {
  it("replays a stuck received row: stamps processed_at, counts it replayed", async () => {
    const id = evtId("ok");
    await seedStuck(id, 0);
    stripeMock.retrieve.mockImplementation((eid: string) => Promise.resolve(fakeEvent(eid)));

    const res = await sweepStuckEvents();

    expect(res).toEqual({ replayed: 1, failed: 0, alerted: 0 });
    expect(stripeMock.retrieve).toHaveBeenCalledWith(id);
    const [row] = await sql<{ processed_at: Date | null; replay_attempts: number }[]>`
      select processed_at, replay_attempts from billing_events where id = ${id}`;
    expect(row.processed_at).not.toBeNull();
    expect(row.replay_attempts).toBe(0); // a clean replay never bumps the counter
  });

  it("a retrieve failure increments replay_attempts and leaves the row stuck", async () => {
    const id = evtId("fail");
    await seedStuck(id, 0);
    stripeMock.retrieve.mockRejectedValue(new Error("stripe unavailable"));

    const res = await sweepStuckEvents();

    expect(res).toEqual({ replayed: 0, failed: 1, alerted: 0 });
    const [row] = await sql<{ processed_at: Date | null; replay_attempts: number }[]>`
      select processed_at, replay_attempts from billing_events where id = ${id}`;
    expect(row.replay_attempts).toBe(1);
    expect(row.processed_at).toBeNull();
  });

  it("a third-attempt row is parked and pages once", async () => {
    const id = evtId("cap");
    await seedStuck(id, 3);
    stripeMock.retrieve.mockRejectedValue(new Error("must not be called on a capped row"));

    const res = await sweepStuckEvents();

    expect(res).toEqual({ replayed: 0, failed: 0, alerted: 1 });
    expect(stripeMock.retrieve).not.toHaveBeenCalled(); // capped row is never re-pulled
    const [row] = await sql<{ replay_attempts: number }[]>`
      select replay_attempts from billing_events where id = ${id}`;
    expect(row.replay_attempts).toBe(4); // 4 → filtered out of every future sweep
    expect(await staffRows(KIND, "stripe_event", id)).toEqual([parkedRow(id)]);
    expect(stuckAlert, "what the alert says").toHaveBeenCalledWith({ eventId: id, eventType: "product.created", attempts: 4 });
    expect(drops(), "the alert was queued, not dropped").toEqual({ logged: 0, issues: 0 });

    // Second pass: the parked row is out of the working set, so it is never parked or paged again.
    stuckAlert.mockClear();
    const res2 = await sweepStuckEvents();
    expect(res2.alerted).toBe(0);
    expect(stuckAlert).not.toHaveBeenCalled();
    expect(await staffRows(KIND, "stripe_event", id)).toEqual([parkedRow(id)]);
  });

  it("two overlapping sweeps park and page once", async () => {
    // Staged, never raced at t=0 (an unstaged Promise.all let one pass's park land before the other's select, and passed with the
    // park unconditional): a holder takes the row lock, both passes select the row on its third attempt (a plain select does not
    // wait) and queue their parks behind the holder, then it lets go. Only the park that moves the row from 3 to 4 may count and
    // page. The once-key alone would still hold the row count at one, so the `alerted` sum is what witnesses the conditional park.
    const id = evtId("race");
    await seedStuck(id, 3);
    stripeMock.retrieve.mockRejectedValue(new Error("must not be called on a capped row"));

    const holder = await sql.reserve();
    let a: Awaited<ReturnType<typeof sweepStuckEvents>>;
    let b: Awaited<ReturnType<typeof sweepStuckEvents>>;
    try {
      await holder`begin`;
      await holder`select 1 from billing_events where id = ${id} for update`;
      const holderPid = await backendPid(holder);
      let done = 0;
      const both = Promise.all([sweepStuckEvents(), sweepStuckEvents()].map((p) => p.finally(() => (done += 1))));
      expect(
        await pollWaitersBehind(holderPid, { atLeast: 2, queryLike: "%update billing_events set replay_attempts%", finished: () => done > 0 }),
        "premise: both passes selected the row and wait to park it",
      ).toBe(2);
      await holder`rollback`;
      [a, b] = await both;
    } finally {
      holder.release();
    }

    expect(a.alerted + b.alerted, "one park, one page").toBe(1);
    expect(stuckAlert, "only the pass that parked it rendered the alert").toHaveBeenCalledTimes(1);
    expect(stripeMock.retrieve).not.toHaveBeenCalled();
    const [row] = await sql<{ replay_attempts: number }[]>`
      select replay_attempts from billing_events where id = ${id}`;
    expect(row.replay_attempts).toBe(4);
    expect(await staffRows(KIND, "stripe_event", id)).toEqual([parkedRow(id)]);
    expect(drops(), "the alert was queued, not dropped").toEqual({ logged: 0, issues: 0 });
  });

  it("honours the limit param (only that many rows per pass)", async () => {
    const ids = [evtId("lim"), evtId("lim"), evtId("lim")];
    for (const id of ids) await seedStuck(id, 0);
    stripeMock.retrieve.mockImplementation((eid: string) => Promise.resolve(fakeEvent(eid)));

    const res = await sweepStuckEvents(2);

    expect(res.replayed).toBe(2);
    const done = await sql<{ id: string }[]>`
      select id from billing_events where id = any(${ids}) and processed_at is not null`;
    expect(done.length).toBe(2); // the third is left for the next pass
  });
});
