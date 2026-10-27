// The match-credit pack price-drift guard's staff alert, driven to a ROW (phase 3 wave 5, kind
// `staff_stream_pack_price_drift`, P-W5-5). The real `createRelayCheckout` meets a live price that charges something other
// than the table, refuses the checkout, and its `alertStreamPackPriceDrift` queues the alert through the real
// `queueStaffAlert` to this suite's own STAFF_ALERT_EMAIL, once per price per UTC day: `<price>:<lookup key>:<yyyy-mm-dd>`.
//
// relay-checkout.test.ts (no database) proves the refusal, the call's shape and the in-process `Set` that bounds the error
// report; this suite proves the row the call writes. A test that clears that `Set` (`forgetStreamPackDriftAlertsForTests`)
// witnesses the once-key alone. Only Stripe (the price list; no Session may be created) and the outbox's transport are
// doubled. The builder and Sentry's capture are call-through spies, so what the alert says is read where it enters the mail and
// a test can assert the writer dropped nothing (I2).
//
// Real Postgres required; skipped without DATABASE_URL. Sport: not applicable (a Stripe price, no sport).
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

const stripeMock = vi.hoisted(() => ({ pricesList: vi.fn(), sessionsCreate: vi.fn() }));
vi.mock("@/lib/stripe", () => ({
  getStripe: () => ({
    prices: { list: stripeMock.pricesList },
    checkout: { sessions: { create: stripeMock.sessionsCreate } },
  }),
}));
vi.mock("@/lib/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email")>();
  return { ...actual, streamPackPriceDriftAlertEmail: vi.fn(actual.streamPackPriceDriftAlertEmail) };
});
vi.mock("@/lib/sentry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sentry")>();
  return { ...actual, captureError: vi.fn(actual.captureError) };
});
vi.mock("@/server/email-outbox/transport", () => ({ deliver: vi.fn() }));

import { sql } from "@/lib/db";
import { streamPackPriceDriftAlertEmail } from "@/lib/email";
import { captureError } from "@/lib/sentry";
import { log } from "@/server/logger";
import { streamPack, streamPackPriceAmounts } from "../stream-credit-packs";
import { createRelayCheckout, forgetStreamPackDriftAlertsForTests } from "../relay-checkout";
import { staffAlertDrops, staffRows } from "@/server/usecases/__tests__/_money-fixtures";

const HAS_DB = !!process.env.DATABASE_URL;
const KIND = "staff_stream_pack_price_drift";
const RUN = `rcd-${randomUUID().slice(0, 8)}`;
const PACK = streamPack(5)!;
const driftAlert = vi.mocked(streamPackPriceDriftAlertEmail);
let staff = "";
let errors: ReturnType<typeof vi.spyOn>;
/** What the writer's never-throws catch left (I2): an alert that was queued or deduplicated left nothing. */
const drops = () => staffAlertDrops(errors, vi.mocked(captureError));
const utcDay = (d: Date): string => d.toISOString().slice(0, 10);
/** One queued drift alert to this test's staff address. The subject is the builder's inline English, typed from its source. */
const driftRow = (priceId: string, day: string) => ({
  ref_id: `${priceId}:${PACK.lookupKey}:${day}`,
  dedupe_key: `${priceId}:${PACK.lookupKey}:${day}`,
  status: "queued",
  recipient: staff,
  subject: `Match-credit pack price differs from the table: ${PACK.lookupKey}`,
});
/** A live price for the pack whose EUR option charges 1 minor unit instead of the table's amount: drift. A run-unique id. */
function driftedPrice(tag: string) {
  const want = streamPackPriceAmounts(PACK);
  return {
    id: `price_${RUN}_${tag}_${randomUUID().slice(0, 8)}`,
    currency: want.currency,
    unit_amount: want.unit_amount,
    currency_options: { [want.currency]: { unit_amount: want.unit_amount }, ...want.currency_options, eur: { unit_amount: 1 } },
  };
}
/** A buyer's checkout for the pack, refused by the drift guard (never a Session). */
async function refusedCheckout(price: { id: string }): Promise<void> {
  stripeMock.pricesList.mockResolvedValueOnce({ data: [price] });
  await expect(
    createRelayCheckout({ orgId: randomUUID(), size: 5, returnUrl: "https://a.test/?x", currency: "eur" }),
  ).rejects.toMatchObject({ status: 502, code: "checkout_unavailable" });
}
/** Pin the clock (Date only: the database and its timers keep real time) so a test cannot straddle UTC midnight. */
const pinClock = (at: Date): Date => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(at);
  return at;
};

beforeEach(() => {
  stripeMock.pricesList.mockReset();
  stripeMock.sessionsCreate.mockReset();
  driftAlert.mockClear();
  vi.mocked(captureError).mockClear();
  errors = vi.spyOn(log, "error");
  // This test's own staff address: CI sets none, and the database is shared.
  staff = `staff-${RUN}-${randomUUID().slice(0, 8)}@x.test`;
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

describe.skipIf(!HAS_DB)("the match-credit pack price-drift alert, queued on the outbox", () => {
  it("a drifted price refuses the checkout and pages once", async () => {
    const day = utcDay(pinClock(new Date()));
    const price = driftedPrice("once");

    await refusedCheckout(price);

    expect(stripeMock.sessionsCreate, "a drifted price is never charged").not.toHaveBeenCalled();
    expect(await staffRows(KIND, "stripe_price", price.id)).toEqual([driftRow(price.id, day)]);
    expect(driftAlert, "what the alert says").toHaveBeenCalledWith({
      lookupKey: PACK.lookupKey,
      priceId: price.id,
      drift: expect.stringContaining(`eur: live 1, table ${streamPackPriceAmounts(PACK).currency_options.eur!.unit_amount}`),
    });
    expect(drops(), "the alert was queued, not dropped").toEqual({ logged: 0, issues: 0 });
  });

  it("a second refused checkout the same day pages nothing more", async () => {
    const day = utcDay(pinClock(new Date()));
    const price = driftedPrice("sameday");

    await refusedCheckout(price);
    // The in-process Set would stop the second refusal before the alert; forgetting it (a deploy, a second instance) leaves
    // the once-key alone to hold the page to one.
    forgetStreamPackDriftAlertsForTests();
    await refusedCheckout(price);

    expect(driftAlert, "premise: both refusals reached the alert").toHaveBeenCalledTimes(2);
    expect(await staffRows(KIND, "stripe_price", price.id)).toEqual([driftRow(price.id, day)]);
    expect(drops(), "deduplicated, not dropped").toEqual({ logged: 0, issues: 0 });
  });

  it("the next UTC day's refused checkout pages again, with the same process still running", async () => {
    // P-W5-5 (Q2's rule): while the drift lasts every checkout for the pack is refused, so staff are nagged once a day. The
    // in-process Set is NOT forgotten here: a long-lived server must re-page tomorrow, so the Set's key carries the day too.
    const today = pinClock(new Date());
    const price = driftedPrice("nextday");

    await refusedCheckout(price);
    const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000);
    vi.setSystemTime(tomorrow);
    await refusedCheckout(price);

    expect(utcDay(tomorrow), "premise: the second refusal is on another UTC day").not.toBe(utcDay(today));
    expect(await staffRows(KIND, "stripe_price", price.id)).toEqual([
      driftRow(price.id, utcDay(today)),
      driftRow(price.id, utcDay(tomorrow)),
    ]);
    expect(drops(), "both queued, nothing dropped").toEqual({ logged: 0, issues: 0 });
  });
});
