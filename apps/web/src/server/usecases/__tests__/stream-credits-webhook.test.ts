// The purchase lands on the webhook SYNCHRONOUSLY: the route calls
// runEvent → processStripeEvent → handleCheckoutCompleted (P6).
//
// The replay claim is driven through runEvent, which is the REAL claim, and
// never through the cron (FT0-5). `sweepStuckEvents` selects only rows with
// `processed_at is null` older than ten minutes, so a purchase the webhook
// already processed is never selected: "drive the cron, the balance is
// unchanged" stays green with the dedupe DELETED and witnesses nothing.
// runEvent does: its insert conflicts on the already-processed row, claims
// nothing, returns false, and the handler is never reached. The LEDGER ROW
// COUNT is asserted directly rather than inferred from the balance, because a
// second row carrying a compensating delta would leave the balance unchanged.
import { describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import { sql } from "@/lib/db";
import { seedOrg } from "./_rig";
import { runEvent } from "../billing-events";
import { creditBalance } from "../stream-credits";
import { streamPack } from "@/lib/stream-credit-packs";

// The REAL writer for every test here but one. The branch's catch is scoped to
// the ONE terminal refusal (`stripe_event_org_mismatch`); a transient database
// fault must still reach the webhook's error path so Stripe redelivers. There
// is no natural way to make the real `recordPurchase` fail transiently — every
// other refusal it raises is unreachable from this branch — so exactly one
// session id is routed into a rejection and the rest delegate to the original.
vi.mock("../stream-credits", async (importOriginal) => {
  const real = await importOriginal<typeof import("../stream-credits")>();
  return {
    ...real,
    recordPurchase: (args: Parameters<typeof real.recordPurchase>[0]) =>
      args.stripeEventId.includes("_boom_")
        ? Promise.reject(new Error("connection terminated unexpectedly"))
        : real.recordPurchase(args),
  };
});

const HAS_DB = !!process.env.DATABASE_URL;

function completed(orgId: string, sessionId: string, credits: string): Stripe.Event {
  return {
    id: `evt_${sessionId}`,
    type: "checkout.session.completed",
    data: {
      object: {
        id: sessionId,
        object: "checkout.session",
        payment_status: "paid",
        currency: "gbp",
        // The pack-5 sandbox price in pence. The branch copies it to the ledger
        // row's amount_minor, so the fixture MUST carry it — a missing
        // amount_total would make the link assertion pass on null.
        amount_total: 2500,
        customer: null,
        payment_intent: `pi_${sessionId}`,
        metadata: { kind: "stream_credits", org_id: orgId, fixture_id: "00000000-0000-4000-8000-000000000000", pack: "5", credits },
      },
    },
  } as unknown as Stripe.Event;
}

describe.skipIf(!HAS_DB)("checkout.session.completed → stream credits", () => {
  it("writes ONE purchase row for the snapshotted credits, carrying the Stripe link; a redelivery claims nothing and writes none", async () => {
    const { auth } = await seedOrg();
    const sid = `cs_test_stream_${auth.orgId.slice(0, 8)}`;
    const ev = completed(auth.orgId, sid, "5");
    expect(await runEvent(ev)).toBe(true);
    expect(await creditBalance(sql, auth.orgId)).toBe(5);
    // The SAME event delivered again — the claim finds a processed row.
    expect(await runEvent(ev)).toBe(false);
    expect(await creditBalance(sql, auth.orgId)).toBe(5);
    const rows = await sql<
      { reason: string; delta: number; stripe_event_id: string; stripe_checkout_session_id: string | null; pack_key: string | null; amount_minor: number | null; currency: string | null }[]
    >`
      select reason, delta, stripe_event_id, stripe_checkout_session_id, pack_key, amount_minor, currency
      from org_stream_credits where org_id = ${auth.orgId}`;
    // Exactly one row, and the link on it — ids and amounts, never card data.
    // `pack_key` is read off the CATALOGUE rather than retyped (S10), so a
    // renamed lookup key moves the test with the source of truth.
    expect(rows).toEqual([
      {
        reason: "purchase", delta: 5, stripe_event_id: sid,
        stripe_checkout_session_id: sid, pack_key: streamPack(5)!.lookupKey,
        amount_minor: 2500, currency: "gbp",
      },
    ]);
  });

  it("an unpaid session is claimed and handled, and writes nothing", async () => {
    const { auth } = await seedOrg();
    const ev = completed(auth.orgId, `cs_test_unpaid_${auth.orgId.slice(0, 8)}`, "5");
    (ev.data.object as unknown as { payment_status: string }).payment_status = "unpaid";
    // true: the event IS claimed and dispatched. The refusal is the branch's
    // payment_status check, not a missing claim — asserting the claim here is
    // what keeps this from passing for the wrong reason.
    expect(await runEvent(ev)).toBe(true);
    expect(await creditBalance(sql, auth.orgId)).toBe(0);
  });

  // The test above cannot witness snapshot authority: its snapshot is "5" and
  // the pack-5 catalogue entry is ALSO 5, so a branch that ignored the snapshot
  // and re-derived from the catalogue would grant the same number and pass. The
  // whole reason the snapshot exists is that the two CAN disagree — a deploy
  // between "buyer opens checkout" and "buyer finishes paying" moves the
  // catalogue, and what was SOLD is what must be granted.
  it("grants the SNAPSHOT, not the live catalogue, when a deploy has moved the pack under an open session", async () => {
    const { auth } = await seedOrg();
    const sid = `cs_test_snap_${auth.orgId.slice(0, 8)}`;
    // Sold as 3 credits; the catalogue now says pack 5 is worth 5.
    expect(streamPack(5)!.credits).toBe(5);
    expect(await runEvent(completed(auth.orgId, sid, "3"))).toBe(true);
    expect(await creditBalance(sql, auth.orgId)).toBe(3);
    const rows = await sql<{ delta: number; pack_key: string | null }[]>`
      select delta, pack_key from org_stream_credits where org_id = ${auth.orgId}`;
    // The LINK still names the pack that was bought — only the granted amount
    // comes from the snapshot.
    expect(rows).toEqual([{ delta: 3, pack_key: streamPack(5)!.lookupKey }]);
  });

  // S8, empty input: `Number("")` is 0 and `Number(undefined)` is NaN, so a
  // session that never got a snapshot (or got an unusable one) must NOT grant
  // zero silently. It falls back to the catalogue by pack size, loudly.
  it.each([["", "an empty snapshot"], ["nope", "a non-numeric snapshot"], ["0", "a zero snapshot"], ["2.5", "a fractional snapshot"]])(
    "falls back to the catalogue when the session carries %s (%s)",
    async (credits) => {
      const { auth } = await seedOrg();
      const sid = `cs_test_fb_${auth.orgId.slice(0, 8)}`;
      expect(await runEvent(completed(auth.orgId, sid, credits))).toBe(true);
      expect(await creditBalance(sql, auth.orgId)).toBe(streamPack(5)!.credits);
    },
  );

  it("a paid session with neither a usable snapshot nor a resolvable pack is ACKed and grants NOTHING — never a zero-credit row", async () => {
    const { auth } = await seedOrg();
    const sid = `cs_test_nopack_${auth.orgId.slice(0, 8)}`;
    const ev = completed(auth.orgId, sid, "");
    (ev.data.object as unknown as { metadata: Record<string, string> }).metadata.pack = "7";
    // Claimed and dispatched — a retry cannot turn this into a grant, so the
    // event is acknowledged and a human grants it by hand (the staff panel).
    expect(await runEvent(ev)).toBe(true);
    const rows = await sql<{ n: string }[]>`
      select count(*)::text as n from org_stream_credits where org_id = ${auth.orgId}`;
    expect(rows[0]!.n).toBe("0");
  });

  // recordPurchase THROWS a 409 `stripe_event_org_mismatch` when the Checkout
  // Session id it is keyed on is already recorded against a DIFFERENT org
  // (the column is unique TABLE-wide). That refusal is TERMINAL: nothing about
  // retrying it can succeed, so it must be ACKed. Let it reach the webhook's
  // generic error path and Stripe redelivers the same event for days while the
  // ledger stays unchanged and nobody is paged by anything but the volume.
  it("a Checkout Session id already recorded for ANOTHER org is acknowledged, not retried, and writes nothing", async () => {
    const first = (await seedOrg()).auth;
    const second = (await seedOrg()).auth;
    const sid = `cs_test_crossorg_${first.orgId.slice(0, 8)}`;
    expect(await runEvent(completed(first.orgId, sid, "5"))).toBe(true);
    expect(await creditBalance(sql, first.orgId)).toBe(5);

    // A DIFFERENT Stripe event (so runEvent's own claim does not swallow it)
    // carrying the SAME session id but the second org's metadata.
    const collide = completed(second.orgId, sid, "5");
    (collide as unknown as { id: string }).id = `evt_crossorg_${second.orgId.slice(0, 8)}`;
    await expect(runEvent(collide)).resolves.toBe(true);
    expect(await creditBalance(sql, second.orgId)).toBe(0);
    expect(await creditBalance(sql, first.orgId)).toBe(5);
    // `processed_at` set is what tells Stripe to stop: runEvent stamps it only
    // after the handler returned without throwing.
    const [row] = await sql<{ processed_at: string | null }[]>`
      select processed_at from billing_events where id = ${`evt_crossorg_${second.orgId.slice(0, 8)}`}`;
    expect(row!.processed_at).not.toBeNull();
  });

  // The OTHER direction of the same guard, and the reason it is scoped to one
  // code rather than swallowing everything: a database blip is retryable, and
  // acknowledging it would lose a paid purchase with nothing left to replay.
  it("a transient writer failure is NOT acknowledged — it reaches the webhook's error path and leaves the event unprocessed", async () => {
    const { auth } = await seedOrg();
    const sid = `cs_test_boom_${auth.orgId.slice(0, 8)}`;
    await expect(runEvent(completed(auth.orgId, sid, "5"))).rejects.toThrow(/connection terminated/);
    expect(await creditBalance(sql, auth.orgId)).toBe(0);
    // processed_at still NULL: Stripe will redeliver, and the stuck-event sweep
    // can see it. A swallowed error would have stamped it and lost the sale.
    const [row] = await sql<{ processed_at: string | null }[]>`
      select processed_at from billing_events where id = ${`evt_${sid}`}`;
    expect(row!.processed_at).toBeNull();
  });
});
