// RS003 W5d — real two-actor concurrency coverage for registration paths
// that take a row lock (or a savepoint+retry, or a compare-and-swap) and had
// no interleaved test before this file:
//   1. promoteOldestWaitlisted's `for update skip locked` (registrations.ts:793)
//   2. confirmPaidRegistration's `for update`             (registrations.ts:1536)
//   3. sweepRegistrations' overdue `for update`            (registrations.ts:2525),
//      whose comment at :2454-2456 claims a specific ordering-dependent
//      outcome — verified below in BOTH orders, not just read.
//   4. submitRegistrationGroup's ref_code savepoint+retry (registration-submit.ts:485-508)
//   5. createRegistrationCheckout's checkout_session_id compare-and-swap
//      (registrations.ts, the stamp inside createRegistrationCheckout) — see
//      its own section below for why this one is staged differently from 1-4.
//   6. joinTeamEntry's claim CAS + roster-cap insert (registration-submit.ts,
//      RS007) — closes two windows a reading pass found: the entry's
//      status/free_agent was never re-checked at write time (a concurrent
//      withdraw could land a claim on a dead entry), and the roster-cap
//      check was a plain SELECT-count ahead of an unguarded INSERT.
//
// Real Postgres required; every describe below is skipped without
// DATABASE_URL, matching every other suite in this directory.
//
// Interleaving technique — read before editing. Prior art
// (registration-submit.test.ts's "capacity race" describe,
// registration-user-link.test.ts:339's "two concurrent confirmations") proves
// genuine two-actor races work in this environment. Races 1, 2 and 4 below
// use fully real production code on BOTH sides, staged with the SAME
// held/staged pattern registration-submit.test.ts uses (an external holder
// transaction locks a row and parks on a promise the test controls;
// `waitForBlockedLocks` polls `pg_locks` for a REAL blocked waiter instead of
// sleeping a guessed duration).
//
// Race 3 (sweep vs webhook) is the one exception, and it is exceptional for a
// specific, checked reason: confirmPaidRegistration and sweepRegistrations
// each manage their OWN `sql.begin` internally (unlike promoteOldestWaitlisted,
// neither accepts an external `tx`), and each function's FIRST statement IS
// the contested row's own `for update` — there is no earlier shared lock to
// stage two real calls behind, deterministically, in a chosen order. Nor is
// there a cross-module hook to pause either mid-transaction: the calls each
// makes between acquiring the lock and committing (materialise, audit) are
// SAME-MODULE calls inside registrations.ts, so a `vi.mock` of that module
// from this file would be inert for registrations.ts's own internal calls to
// its own exports (the well-known ESM same-module-call gotcha — confirmed
// against this exact file's imports below, not assumed). So each of the two
// sweep-vs-webhook orderings uses ONE real function (the one whose locking
// behaviour that ordering is actually proving) plus a minimal, explicitly
// labelled holder transaction that performs ONLY the single-column status
// write the OTHER real function's commit would have produced — never
// business logic reimplemented, just the one observable fact ("the other
// side already landed X") needed to force genuine, provable contention on
// the exact same row. Both real functions still get fully exercised for
// real, just not simultaneously-both-real in the same test — order A drives
// sweepRegistrations for real, order B drives confirmPaidRegistration for
// real.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

const stripeMock = vi.hoisted(() => {
  const checkoutCreate = vi.fn();
  const checkoutRetrieve = vi.fn();
  const checkoutExpire = vi.fn().mockResolvedValue({ id: "expired" });
  const refundCreate = vi.fn().mockResolvedValue({ id: "re_test_fixed" });
  return {
    checkoutCreate,
    checkoutRetrieve,
    checkoutExpire,
    refundCreate,
    stripe: {
      checkout: {
        sessions: { create: checkoutCreate, retrieve: checkoutRetrieve, expire: checkoutExpire },
      },
      refunds: { create: refundCreate },
    },
  };
});
vi.mock("@/lib/stripe", () => ({ getStripe: () => stripeMock.stripe }));

// A thin wrapper around the REAL generateRefCode, touched only by the
// ref_code collision test (race 4) — every other test gets byte-identical
// behaviour to the unmocked module. Same technique as
// registration-submit.test.ts's `refCodeMock`, trimmed to just the one knob
// this file needs (no `failOnCall` — that atomicity proof already exists
// there and is out of this file's scope). Declared here, not imported: mocks
// are hoisted per-module and do not travel through imports.
const refCodeMock = vi.hoisted(() => ({ fixedNextCalls: [] as string[] }));
vi.mock("@/lib/ref-code", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ref-code")>();
  return {
    ...actual,
    generateRefCode: (): string => {
      if (refCodeMock.fixedNextCalls.length > 0) return refCodeMock.fixedNextCalls.shift()!;
      return actual.generateRefCode();
    },
  };
});

import { sql } from "@/lib/db";
import {
  promoteOldestWaitlisted,
  handleRegistrationCheckoutCompleted,
  sweepRegistrations,
  putRegistrationSettings,
  resumeRegistrationCheckout,
} from "../registrations";
import { submitRegistrationGroup, joinTeamEntry, type SubmitGroupContact } from "../registration-submit";
import {
  seedOrg,
  asOwner,
  rig,
  loadWithGroup,
  seedRegistration,
  fakeSession,
  stripeRig,
  SETTINGS_BASE,
} from "./_registration-fixtures";

const HAS_DB = !!process.env.DATABASE_URL;

/**
 * Poll `pg_locks` for genuinely blocked waiters instead of a fixed sleep —
 * identical technique to registration-submit.test.ts's `waitForBlockedLocks`
 * (itself generalised from slug-race.test.ts's `waitForBlockedInsert`).
 * Copied rather than imported: it is a local test helper there too, not an
 * exported fixture, and this file owns its own copy per the dispatch note
 * that mocks/helpers do not travel through imports here.
 */
async function waitForBlockedLocks(count: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const [row] = await sql<{ n: number }[]>`select count(*)::int as n from pg_locks where not granted`;
    if (row!.n >= count) return;
    if (Date.now() > deadline) {
      throw new Error(`only ${row!.n}/${count} blocked locks appeared — race not staged`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function auditCount(type: string, registrationId: string): Promise<number> {
  const [row] = await sql<{ n: string }[]>`
    select count(*)::text as n from competition_events
    where type = ${type} and payload->>'registration_id' = ${registrationId}`;
  return Number(row!.n);
}

function baseContact(over: Partial<SubmitGroupContact> = {}): SubmitGroupContact {
  return { name: "Race Rep", email: `race-${randomUUID().slice(0, 8)}@test.local`, ...over };
}

beforeEach(() => {
  refCodeMock.fixedNextCalls = [];
  stripeMock.refundCreate.mockClear();
  stripeMock.checkoutCreate.mockReset();
  stripeMock.checkoutExpire.mockClear();
});

// ---------------------------------------------------------------------------
// 1. promoteOldestWaitlisted — for update skip locked (registrations.ts:793)
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("promoteOldestWaitlisted — concurrent promotions (genuine concurrency)", () => {
  it("two concurrent promotions in the same division pick two DIFFERENT waitlisted entries, never the same one twice", async () => {
    const { orgId, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);
    const seedSettings = { fee_cents: 0, currency: "gbp", payment_method: "offline" as const };
    const r1 = await seedRegistration(competition.id, division.id, seedSettings, {
      contactEmail: `r1-${randomUUID().slice(0, 8)}@test.local`,
      status: "waitlisted",
    });
    const r2 = await seedRegistration(competition.id, division.id, seedSettings, {
      contactEmail: `r2-${randomUUID().slice(0, 8)}@test.local`,
      status: "waitlisted",
    });
    // Force r1 strictly OLDER than r2 by created_at (the query's own primary
    // sort key) — removes any dependency on the two seeds' real wall-clock
    // gap, however small, ever tying.
    await sql`update registrations set created_at = now() - interval '1 hour' where id = ${r1.registration.id}`;

    let releaseA!: () => void;
    const heldA = new Promise<void>((resolve) => (releaseA = resolve));
    let stagedA!: () => void;
    const isStagedA = new Promise<void>((resolve) => (stagedA = resolve));

    // Actor A: the REAL function, wrapped in a caller-controlled transaction.
    // Unlike races 2/3, promoteOldestWaitlisted takes `tx` as an explicit
    // parameter, so NO proxy is needed here — both actors below are 100%
    // real. A runs to completion (its own SELECT ... FOR UPDATE SKIP LOCKED
    // plus the promotion UPDATE) and then parks, uncommitted, so r1's lock
    // stays held.
    const aPromise = sql.begin(async (tx) => {
      const promoted = await promoteOldestWaitlisted(tx, division.id, null);
      stagedA();
      await heldA;
      return promoted;
    });
    await isStagedA;

    // Actor B: a SECOND, fully real concurrent call, issued while A's
    // transaction is still open (r1 still locked, uncommitted) — proving
    // this is genuine SKIP LOCKED contention, not two calls that merely ran
    // one after the other. B resolving at all BEFORE releaseA() is itself
    // part of the proof: SKIP LOCKED never blocks on a row someone else
    // holds, it just moves on to the next candidate.
    const promotedB = await sql.begin((tx) => promoteOldestWaitlisted(tx, division.id, null));
    releaseA();
    const promotedA = await aPromise;

    expect(promotedA).not.toBeNull();
    expect(promotedB).not.toBeNull();
    expect(promotedA?.id).toBe(r1.registration.id);
    expect(promotedB?.id).toBe(r2.registration.id);
    expect(promotedA?.id).not.toBe(promotedB?.id);

    const [rowA, rowB] = await Promise.all([
      loadWithGroup(r1.registration.id),
      loadWithGroup(r2.registration.id),
    ]);
    expect(rowA.status).toBe("pending");
    expect(rowB.status).toBe("pending");
  });
});

// ---------------------------------------------------------------------------
// 2. confirmPaidRegistration — for update (registrations.ts:1536)
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("confirmPaidRegistration — concurrent confirmations of the SAME registration (genuine concurrency)", () => {
  it("a webhook and a manual reconcile racing the SAME session confirm exactly once: one entrant, one first_paid grant, no refund", async () => {
    const { orgId, competition, division, settings } = await stripeRig({ feeCents: 1500 });
    const seeded = await seedRegistration(competition.id, division.id, settings);
    const regId = seeded.registration.id;
    const session = fakeSession(regId, settings.fee_cents);

    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let staged!: () => void;
    const isStaged = new Promise<void>((resolve) => (staged = resolve));
    // Holder locks the EXACT row both real calls contend on. Locking just
    // `registrations` is enough even though confirmPaidRegistration's own
    // query is a join with registration_groups — FOR UPDATE on a join needs
    // every referenced table's matching row, so a lock already held on
    // EITHER side blocks the whole statement.
    const holder = sql.begin(async (tx) => {
      await tx`select 1 from registrations where id = ${regId} for update`;
      staged();
      await held;
    });
    holder.catch(() => {});
    await isStaged;

    // Both racers are the REAL exported entry point.
    // `reconcileRegistration`/`reconcileRegistrationBySession` (the "manual
    // reconcile" the brief names) are thin Stripe-session-retrieval wrappers
    // that, once they confirm the session is paid, call this exact same
    // function — so racing it directly against itself IS racing "a webhook
    // and a manual reconcile arriving together" at the shared code path both
    // funnel into.
    const racing = Promise.all([
      handleRegistrationCheckoutCompleted(session),
      handleRegistrationCheckoutCompleted(session),
    ]);
    racing.catch(() => {});
    await waitForBlockedLocks(2);
    release();
    await holder;
    await racing;

    const row = await loadWithGroup(regId);
    expect(row.status).toBe("confirmed");
    expect(row.entrant_id).not.toBeNull();

    const [{ n: entrantCount }] = await sql<{ n: number }[]>`
      select count(*)::int as n from entrants where division_id = ${division.id}`;
    expect(entrantCount).toBe(1);

    expect(await auditCount("registration.confirmed", regId)).toBe(1);
    expect(await auditCount("registration.refunded", regId)).toBe(0);

    const [{ n: grantCount }] = await sql<{ n: string }[]>`
      select count(*)::text as n from ai_credit_ledger
      where idempotency_key = ${`earn:first_paid:${orgId}`}`;
    expect(Number(grantCount)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 3. sweepRegistrations vs confirmPaidRegistration — for update
//    (registrations.ts:2525 / :1536), verifying the comment at :2454-2456
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("sweepRegistrations vs a racing webhook — both orders of registrations.ts:2454-2456's claim", () => {
  it("webhook first: a payment that lands before sweep gets there is honoured — sweep sees it live and never expires the row", async () => {
    const { competition, division, settings } = await stripeRig({ feeCents: 800 });
    const seeded = await seedRegistration(competition.id, division.id, settings);
    const regId = seeded.registration.id;
    // Sorts first in sweepRegistrations' `order by g.expires_at` overdue
    // scan regardless of any other stray overdue row left by earlier runs in
    // this shared database — sweepRegistrations is a global, unscoped cron
    // (registrations.test.ts's own sweep test carries the identical caveat,
    // "left by earlier runs... asserting on those tallies made this test
    // fail"; this file pins identity/state, never the sweep's own tallies).
    await sql`update registration_groups set expires_at = now() - interval '365 days' where id = ${seeded.registration.group_id}`;

    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let staged!: () => void;
    const isStaged = new Promise<void>((resolve) => (staged = resolve));
    // Stand-in for "confirmPaidRegistration has already committed" — see the
    // file-header note: neither real function exposes a pause point
    // mid-transaction, so the actor NOT under test in this ordering
    // (webhook) is represented by the one column its own commit would have
    // written. sweepRegistrations — the actor THIS ordering actually proves
    // — is 100% real below.
    const holder = sql.begin(async (tx) => {
      await tx`select 1 from registrations where id = ${regId} for update`;
      staged();
      await held;
      await tx`update registrations set status = 'confirmed', updated_at = now() where id = ${regId}`;
    });
    holder.catch(() => {});
    await isStaged;

    const sweepPromise = sweepRegistrations("http://test.local");
    sweepPromise.catch(() => {});
    await waitForBlockedLocks(1);
    release();
    await holder;
    await sweepPromise;

    const row = await loadWithGroup(regId);
    expect(row.status).toBe("confirmed"); // never clobbered to 'expired'
    expect(row.refunded_cents).toBe(0);
    expect(await auditCount("registration.expired", regId)).toBe(0);
  });

  it("sweep first: a deadline that expires before the payment lands is honoured — the late payment auto-refunds exactly once", async () => {
    const { competition, division, settings } = await stripeRig({ feeCents: 800 });
    const seeded = await seedRegistration(competition.id, division.id, settings);
    const regId = seeded.registration.id;
    const session = fakeSession(regId, settings.fee_cents);

    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let staged!: () => void;
    const isStaged = new Promise<void>((resolve) => (staged = resolve));
    // Stand-in for "sweepRegistrations has already committed the expiry" —
    // same rationale as the previous test, mirrored. confirmPaidRegistration
    // (via handleRegistrationCheckoutCompleted) — the actor THIS ordering
    // proves — is 100% real below.
    const holder = sql.begin(async (tx) => {
      await tx`select 1 from registrations where id = ${regId} for update`;
      staged();
      await held;
      await tx`update registrations set status = 'expired', updated_at = now() where id = ${regId}`;
    });
    holder.catch(() => {});
    await isStaged;

    const webhookPromise = handleRegistrationCheckoutCompleted(session);
    webhookPromise.catch(() => {});
    await waitForBlockedLocks(1);
    release();
    await holder;
    await webhookPromise;

    const row = await loadWithGroup(regId);
    expect(row.status).toBe("expired"); // never resurrected to 'paid'/'confirmed'
    expect(row.refunded_cents).toBe(settings.fee_cents);
    expect(row.entrant_id).toBeNull(); // never materialised
    expect(await auditCount("registration.refunded", regId)).toBe(1);
    expect(await auditCount("registration.confirmed", regId)).toBe(0);
    expect(stripeMock.refundCreate).toHaveBeenCalledTimes(1);
    expect(stripeMock.refundCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        payment_intent: expect.stringContaining("pi_test_"),
        amount: settings.fee_cents,
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// 4. submitRegistrationGroup — ref_code savepoint+retry (registration-submit.ts:485-508)
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("submitRegistrationGroup — ref_code collision retry (real 23505, not a hoped-for one)", () => {
  it("a forced ref_code collision on the group insert retries under its savepoint and succeeds with a DIFFERENT ref", async () => {
    const { orgId, orgSlug, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);
    await putRegistrationSettings(owner, division.id, {
      ...SETTINGS_BASE,
      payment_method: "offline",
      fee_cents: 0,
    });

    const first = await submitRegistrationGroup(
      { orgSlug, compSlug: competition.slug },
      {
        contact: baseContact(),
        privacy_consent: true,
        entries: [
          { division_id: division.id, entrant_kind: "individual", players: [{ full_name: "First" }], answers: {} },
        ],
      },
    );
    const firstRef = first.ref_code;
    expect(firstRef).toEqual(expect.any(String));

    // Force the SECOND submission's very first generateRefCode() call (the
    // group's own ref_code, minted before any join_code — and this division
    // is "individual", so no join_code is minted at all here, making the
    // very first call unambiguous) to reproduce the FIRST group's
    // already-committed code — a real 23505 on
    // registration_groups_ref_code_key, not a hoped-for one. Same forced-
    // collision technique as registration-submit.test.ts's join_code test
    // (`refCodeMock.fixedNextCalls`), applied one call earlier in the retry
    // sequence.
    refCodeMock.fixedNextCalls = [firstRef as string];
    const second = await submitRegistrationGroup(
      { orgSlug, compSlug: competition.slug },
      {
        contact: baseContact(),
        privacy_consent: true,
        entries: [
          { division_id: division.id, entrant_kind: "individual", players: [{ full_name: "Second" }], answers: {} },
        ],
      },
    );
    const secondRef = second.ref_code;
    expect(secondRef).toEqual(expect.any(String));
    expect(secondRef).not.toBe(firstRef);

    const [{ n: firstCount }] = await sql<{ n: number }[]>`
      select count(*)::int as n from registration_groups where ref_code = ${firstRef}`;
    expect(firstCount).toBe(1); // the first group's row is untouched by the retry
    const [{ n: secondCount }] = await sql<{ n: number }[]>`
      select count(*)::int as n from registration_groups where ref_code = ${secondRef}`;
    expect(secondCount).toBe(1);
    // The savepoint rollback left no ghost row behind: exactly the two
    // groups above exist for this competition, never a third from the
    // failed attempt.
    const [{ n: totalCount }] = await sql<{ n: number }[]>`
      select count(*)::int as n from registration_groups where competition_id = ${competition.id}`;
    expect(totalCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 5. createRegistrationCheckout — checkout_session_id compare-and-swap
//    (registrations.ts, the conditional `update registration_groups set
//    checkout_session_id = ...` inside createRegistrationCheckout)
//
// Staged differently from races 1-4 above, for a specific reason: the fix
// here is explicitly NOT a row lock held across the Stripe network call
// (rejected in review as worse than the race it would close — see the doc
// comment at the call site). So there is no lock for a second actor to
// visibly block on the way waitForBlockedLocks proves for races 1-3. Instead
// two REAL concurrent createRegistrationCheckout calls (via the exported
// resumeRegistrationCheckout) are raced with Promise.all, and the mocked
// Stripe `checkout.sessions.create` is gated so NEITHER call's mint resolves
// until BOTH have started — deterministic overlap with no sleep-guessed
// timing — so both calls reach their own conditional UPDATE with the SAME
// stale (null) `checkout_session_id` they each read before minting. Real
// Postgres row-level write serialisation on that single UPDATE is what
// actually proves the guard: whichever statement lands first at the DB wins
// the CAS for real; the loser's `where checkout_session_id is not distinct
// from ...` clause re-evaluates against the winner's already-committed value
// and matches zero rows.
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_DB)(
  "createRegistrationCheckout — concurrent re-mint compare-and-swap (genuine concurrency)",
  () => {
    it("two concurrent mints for the same registration: exactly one wins; the loser's own session is expired, never returned", async () => {
      const { competition, division, settings } = await stripeRig();
      const seeded = await seedRegistration(competition.id, division.id, settings, { amountCents: 500 });
      const regId = seeded.registration.id;

      let started = 0;
      let releaseBoth!: () => void;
      const bothStarted = new Promise<void>((resolve) => (releaseBoth = resolve));
      stripeMock.checkoutCreate.mockImplementation(async () => {
        started++;
        const n = started;
        if (n === 2) releaseBoth();
        await bothStarted; // neither call's mint resolves until BOTH have started minting
        const id = `cs_test_race_${n}_${randomUUID().slice(0, 6)}`;
        return { id, url: `https://checkout.stripe.test/${id}` };
      });

      const results = await Promise.allSettled([
        resumeRegistrationCheckout(regId, seeded.access_token, "http://test.local"),
        resumeRegistrationCheckout(regId, seeded.access_token, "http://test.local"),
      ]);

      const fulfilled = results.filter(
        (r): r is PromiseFulfilledResult<{ checkout_url: string }> => r.status === "fulfilled",
      );
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      // Genuine overlap happened at all (not one call finishing before the
      // other even started) — both proceeded far enough to mint a real
      // Stripe session, and exactly one of the two lost the CAS.
      expect(started).toBe(2);
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]!.reason).toMatchObject({
        status: 409,
        code: "REGISTRATION_CHECKOUT_CONFLICT",
      });

      const row = await loadWithGroup(regId);
      const winnerSessionId = row.checkout_session_id!;
      expect(winnerSessionId).toMatch(/^cs_test_race_/);
      // The winner's OWN returned URL corresponds to the session actually
      // stamped on the group — not to some other in-flight session.
      expect(fulfilled[0]!.value.checkout_url).toBe(`https://checkout.stripe.test/${winnerSessionId}`);

      // The LOSER's session — never handed back to any caller — was expired
      // rather than left open on Stripe for ~24h.
      expect(stripeMock.checkoutExpire).toHaveBeenCalledTimes(1);
      const loserExpiredId = stripeMock.checkoutExpire.mock.calls[0]![0];
      expect(loserExpiredId).toMatch(/^cs_test_race_/);
      expect(loserExpiredId).not.toBe(winnerSessionId);
    });
  },
);

// ---------------------------------------------------------------------------
// 6. joinTeamEntry — claim CAS + roster-cap insert (registration-submit.ts,
//    RS007). Read the entry's status/free_agent ONCE, then did 3-4 more
//    round-trips before ever writing — no `sql.begin` anywhere in the
//    function. Two real windows:
//      (a) the claim UPDATE's WHERE names only registration_players columns,
//          so a concurrent withdraw (withdrawCore, registrations.ts — status
//          flips to 'withdrawn'; join_code is deliberately left alone) could
//          land a claim on a roster that no longer exists.
//      (b) the insert path's cap check (rosterAtCap) was a plain
//          SELECT-count ahead of an unguarded INSERT, so two joiners racing
//          the last open spot could both pass and both insert.
//
// withdrawCore is reached only through its own `sql.begin` (registrations.ts)
// with no external-tx hook to pause mid-flight — same situation the file
// header's race 3 describes — so (a)'s holder performs ONLY the single
// column withdrawCore's own commit would have written (status), never
// business logic reimplemented. (b) needs no such stand-in: both racers are
// the REAL joinTeamEntry, exactly like race 2's "two concurrent
// confirmations" above.
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("joinTeamEntry — closing two unguarded windows (genuine concurrency)", () => {
  /** A team entry with ONE captain-entered/pending player row — the "slot" a
   *  claim link targets — and a join_code stamped directly (seedRegistration
   *  has no join_code column; joinTeamEntry only cares that the code
   *  resolves, not how it was minted — same shortcut registration-submit.
   *  test.ts's own forced-collision test uses). */
  async function teamEntryWithPlayer(playerName: string): Promise<{
    regId: string;
    joinCode: string;
    playerId: string;
  }> {
    const { orgId, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);
    await putRegistrationSettings(owner, division.id, {
      ...SETTINGS_BASE,
      entrant_kind: "team",
      payment_method: "offline",
      fee_cents: 0,
    });
    const seeded = await seedRegistration(
      competition.id,
      division.id,
      { fee_cents: 0, currency: "gbp", payment_method: "offline" },
      { players: [{ name: playerName }] },
    );
    const regId = seeded.registration.id;
    const joinCode = "SZ-RACE-" + randomUUID().slice(0, 8);
    await sql`update registrations set join_code = ${joinCode} where id = ${regId}`;
    const [player] = await sql<{ id: string }[]>`
      select id from registration_players where registration_id = ${regId}`;
    return { regId, joinCode, playerId: player!.id };
  }

  it("a claim racing a withdraw must not produce a granted consent row on a withdrawn entry", async () => {
    const { regId, joinCode, playerId } = await teamEntryWithPlayer("Kid One");

    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let staged!: () => void;
    const isStaged = new Promise<void>((resolve) => (staged = resolve));
    // Stand-in for "withdrawCore committed" — see the section header above:
    // withdrawCore has no external-tx pause hook, so this holder performs
    // only the ONE column its commit would have written. withdrawCore
    // deliberately does NOT clear join_code (RS007 dispatch note); neither
    // does this holder.
    const holder = sql.begin(async (tx) => {
      await tx`select 1 from registrations where id = ${regId} for update`;
      staged();
      await held;
      await tx`update registrations set status = 'withdrawn', withdrawn_at = now(), updated_at = now() where id = ${regId}`;
    });
    holder.catch(() => {});
    await isStaged;

    // The REAL joinTeamEntry, issued while the holder's lock is still open —
    // it clears every non-locking pre-check (status is still live at THIS
    // read) and only blocks once its own tx reaches `for update` on the
    // same row.
    const joinPromise = joinTeamEntry(
      {},
      {
        join_code: joinCode,
        player_id: playerId,
        player: { full_name: "Kid One", dob: "1995-05-01" },
        // Consent is now gated server-side in joinTeamEntry (RS007 finding #4
        // follow-up). Without it this call 422s on the consent check BEFORE
        // reaching `for update`, so the lock race this test exists to observe
        // would never happen and `waitForBlockedLocks(1)` would hang.
        privacy_consent: true,
      },
    );
    joinPromise.catch(() => {});
    await waitForBlockedLocks(1);
    release();
    await holder;

    await expect(joinPromise).rejects.toMatchObject({
      status: 422,
      message: "This entry is no longer accepting players",
    });

    const [row] = await sql<{ consent_status: string; user_id: string | null; consent_at: Date | null }[]>`
      select consent_status, user_id, consent_at from registration_players where id = ${playerId}`;
    expect(row!.consent_status).toBe("pending"); // never flipped to granted
    expect(row!.user_id).toBeNull();
    expect(row!.consent_at).toBeNull();
  });

  it("two inserts racing at cap-1 must not overrun the cap", async () => {
    // seedOrg's 'generic' sport is { size: 1, benchMax: 0 } -> squad cap 1,
    // and this entry is seeded with ZERO captain-entered players, so
    // "cap-1" occupancy is 0 — the same cap registration-submit.test.ts's
    // sequential "full-roster rejection" test relies on.
    const { orgId, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);
    await putRegistrationSettings(owner, division.id, {
      ...SETTINGS_BASE,
      entrant_kind: "team",
      payment_method: "offline",
      fee_cents: 0,
    });
    const seeded = await seedRegistration(competition.id, division.id, {
      fee_cents: 0,
      currency: "gbp",
      payment_method: "offline",
    });
    const regId = seeded.registration.id;
    const joinCode = "SZ-RACE-" + randomUUID().slice(0, 8);
    await sql`update registrations set join_code = ${joinCode} where id = ${regId}`;

    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let staged!: () => void;
    const isStaged = new Promise<void>((resolve) => (staged = resolve));
    // A third lock holder forces both REAL joinTeamEntry calls below to
    // queue up simultaneously (same technique as race 2 above) — genuine
    // overlap, not one call finishing before the other even starts.
    const holder = sql.begin(async (tx) => {
      await tx`select 1 from registrations where id = ${regId} for update`;
      staged();
      await held;
    });
    holder.catch(() => {});
    await isStaged;

    const racing = Promise.allSettled([
      // `privacy_consent` is required by joinTeamEntry's consent gate; without
      // it both racers reject on consent instead of on the roster cap, and the
      // cap race this test exists to observe never runs.
      joinTeamEntry({}, { join_code: joinCode, player: { full_name: "Racer A" }, privacy_consent: true }),
      joinTeamEntry({}, { join_code: joinCode, player: { full_name: "Racer B" }, privacy_consent: true }),
    ]);
    await waitForBlockedLocks(2);
    release();
    await holder;
    const results = await racing;

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    // Genuine overlap happened (not one call finishing before the other
    // started) — both cleared the pre-tx checks and only one won the cap.
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toMatchObject({ status: 422, message: "This roster is already full" });

    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from registration_players where registration_id = ${regId}`;
    expect(n).toBe(1); // never overran the cap
  });
});
