// An account's address is resolved when the mail is SENT, not when it was queued (phase 3 spec §6; plan wave 1 T3).
//
// A `chess_invite` row carries `recipient_user_id`: the account it is for. Between the enqueue and the send the account may
// change its address (the mail must follow it) or be deleted (nothing may be mailed to a deleted person). The one thing that must
// NOT follow the account is a send that may already have reached Resend: Resend keeps ONE message per Idempotency-Key, and the same
// key with a different `to` is refused (`invalid_idempotent_request`) or, worse, delivered to a second inbox. So the new address is
// used only while the key is CLEAN: no request under it can have left (D2).
//
// The expected values are the spec's: the key-clean table is its table, the placeholder is `deleted-<id>@deleted.invalid`, the key is
// `email-outbox/<id>`. None is read back from the code under test.
//
// What is driven, and how. Only `transport.deliver` is replaced. Every resolution below runs through the REAL claim statement of
// `runOutboxTick` or of `dispatchNow` (an inert resolver that only a hand-built ClaimedRow reaches would pass a unit test and do
// nothing in production), and the one test that hands `attemptClaimed` a hand-claimed row says why.
//
// SHARED DATABASE: every tick is scoped with `onlyIds`.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { suppress, type DeliverResult } from "@/lib/email";
import { log } from "@/server/logger";

const deliverMock = vi.hoisted(() => vi.fn());
vi.mock("@/server/email-outbox/transport", () => ({ deliver: deliverMock }));

import { makeUser } from "@/server/usecases/__tests__/_registration-fixtures";
import { attemptClaimed, dispatchNow, toClaimedRow, type ClaimedRecord } from "../attempt";
import { FIRST_ATTEMPT_WINDOW_MS, OUTBOX_KINDS, type OutboxKind } from "../constants";
import { ACCOUNT_DELETED_REASON, deletedAccountPlaceholder } from "../account-deletion";
import { enqueueEmail, type OutboxMessage } from "../enqueue";
import { KIND_HOOKS, type EndedRow } from "../hooks";
import { isKeyClean } from "../recipient";
import { lockQueuedEmails } from "../status";
import { runOutboxTick, type OutboxTickReport } from "../worker";

const HAS_DB = !!process.env.DATABASE_URL;
const RUN = `t3-${randomUUID().slice(0, 8)}`;
const KEK = "ab".repeat(32);
const API_KEY = "re_test";
const MIN = 60_000;

const ZERO: OutboxTickReport = { claimed: 0, sent: 0, retried: 0, dead: 0, suppressed: 0, expired: 0, failed: 0, deferred: 0, purged: 0 };

const http = (status: number, errorName: string): DeliverResult => ({ ok: false, reason: "http", status, errorName, detail: `RAW-${status}` });

type Sent = { to: string; idempotencyKey: string; tags: Record<string, string> };
const sent = (): Sent[] => deliverMock.mock.calls.map((c) => c[0] as Sent);

type Row = {
  id: string;
  kind: OutboxKind;
  recipient: string;
  recipient_user_id: string | null;
  body_sealed: Buffer | null;
  status: string;
  attempts: number;
  lease_until: Date | null;
  last_error: string | null;
  status_at: Date;
};

describe("isKeyClean: when may a changed address still be used (no database)", () => {
  // The spec's table: (attempts on the claimed row, the last attempt's recorded error, whether the claim reclaimed a lapsed lease).
  // `attempts` counts THIS attempt. A request that left and was answered 503 (or never answered) may have created the message; a 429
  // is refused before it creates anything. Only the row's LAST error survives, so a 429 is trusted only when it is the whole history
  // (attempt 1 is the only earlier attempt), and a reclaimed lease means an earlier attempt's outcome was never recorded.
  const TABLE: ReadonlyArray<readonly [number, string | null, boolean, boolean]> = [
    [1, null, false, true],
    [2, "http 429 rate_limit_exceeded", false, true],
    [2, "http 503 x", false, false],
    [3, "http 429 x", false, false],
    [1, null, true, false],
    [2, "http 429 x", true, false],
  ];

  it("follows the spec's table", () => {
    let checked = 0;
    for (const [attempts, lastError, reclaimed, expected] of TABLE) {
      expect(isKeyClean({ attempts, lastError, reclaimed }), JSON.stringify({ attempts, lastError, reclaimed })).toBe(expected);
      checked++;
    }
    expect(checked, "anti-vacuity: every table row was judged").toBe(6);
    expect(TABLE.filter((r) => r[3]).length, "the table has both answers").toBe(2);
  });

  it("a network error, a thrown transport and a missing error are never trusted past the first attempt", () => {
    for (const lastError of ["network timeout", "network transport_threw", null, "", "http 4290 x"]) {
      expect(isKeyClean({ attempts: 2, lastError, reclaimed: false }), String(lastError)).toBe(false);
    }
  });

  it("an attempt number outside the table is never clean (fail closed)", () => {
    for (const attempts of [0, 4, 5, 6]) {
      expect(isKeyClean({ attempts, lastError: "http 429 rate_limit_exceeded", reclaimed: false }), String(attempts)).toBe(false);
    }
  });
});

describe("deletedAccountPlaceholder (no database)", () => {
  it("is deleted-<id>@deleted.invalid, the address the deletion route gives the account (spec §6)", () => {
    const id = "3f1c2a40-5b6d-4e7f-8a9b-0c1d2e3f4a5b";
    expect(deletedAccountPlaceholder(id)).toBe("deleted-3f1c2a40-5b6d-4e7f-8a9b-0c1d2e3f4a5b@deleted.invalid");
  });
});

describe.skipIf(!HAS_DB)("an account's recipient is resolved at send time (DB)", () => {
  const created: string[] = [];
  const users: string[] = [];
  const suppressed: string[] = [];
  const savedHooks = {} as Record<OutboxKind, (typeof KIND_HOOKS)[OutboxKind]>;
  const hookSpy = vi.fn<(row: EndedRow) => Promise<void>>(async () => {});
  let errorSpy: MockInstance<typeof log.error>;

  const tick = (id: string): Promise<OutboxTickReport> => runOutboxTick({ onlyIds: [id], sleep: async () => {}, nowMs: () => 0 });

  async function account(name: string): Promise<{ id: string; email: string }> {
    const id = await makeUser(name);
    users.push(id);
    const [u] = await sql<{ email: string }[]>`select email from users where id = ${id}`;
    return { id, email: u!.email };
  }
  const changeEmail = async (userId: string): Promise<string> => {
    const next = `changed-${randomUUID().slice(0, 8)}@test.local`;
    await sql`update users set email = ${next} where id = ${userId}`;
    return next;
  };

  /** Born a while ago, so the worker may attempt it (the first-attempt window is the request's own); `fresh` leaves it as written. */
  async function queue(over: Partial<OutboxMessage> = {}, opts: { fresh?: boolean } = {}): Promise<string> {
    const id = await enqueueEmail(sql, {
      kind: "chess_invite",
      refType: "fixture_seat",
      refId: `${RUN}-${randomUUID()}`,
      orgId: null,
      to: `${randomUUID()}@x.test`,
      subject: "Your game is ready",
      html: "<p>Play</p>",
      text: "Play",
      transactional: true,
      expiresAt: new Date(Date.now() + 15 * MIN),
      ...over,
    });
    created.push(id);
    if (!opts.fresh) await sql`update email_outbox set created_at = now() - make_interval(secs => ${FIRST_ATTEMPT_WINDOW_MS / 1000 + 60}) where id = ${id}`;
    return id;
  }
  const queueFor = (acct: { id: string; email: string }, opts: { fresh?: boolean } = {}): Promise<string> =>
    queue({ to: acct.email, recipientUserId: acct.id }, opts);

  const get = async (id: string): Promise<Row> => {
    const [r] = await sql<Row[]>`select * from email_outbox where id = ${id}`;
    if (!r) throw new Error(`no outbox row ${id}`);
    return r;
  };
  const makeDue = async (id: string): Promise<void> => {
    await sql`update email_outbox set next_attempt_at = now() - interval '1 second' where id = ${id}`;
  };
  const lapse = async (id: string): Promise<void> => {
    await sql`update email_outbox set lease_until = now() - interval '1 second' where id = ${id} and status = 'sending'`;
  };

  beforeAll(async () => {
    await sql`select 1`;
  });
  afterAll(async () => {
    await sql`delete from email_outbox where ref_id like ${`${RUN}-%`} or id = any(${created}::uuid[])`;
    if (users.length > 0) await sql`delete from users where id = any(${users}::uuid[])`;
    if (suppressed.length > 0) await sql`delete from email_suppressions where email in ${sql(suppressed)}`;
    await sql.end({ timeout: 2 }).catch(() => undefined);
  });
  beforeEach(() => {
    vi.stubEnv("EMAIL_OUTBOX_KEK", KEK);
    vi.stubEnv("RESEND_API_KEY", API_KEY);
    deliverMock.mockReset();
    deliverMock.mockImplementation(async (m: Sent) => ({ ok: true, providerId: `re_${RUN}_${m.tags.outbox}` }));
    hookSpy.mockClear();
    for (const k of OUTBOX_KINDS) savedHooks[k] = KIND_HOOKS[k];
    for (const k of OUTBOX_KINDS) KIND_HOOKS[k] = { onEndedBadly: hookSpy };
    errorSpy = vi.spyOn(log, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    errorSpy.mockRestore();
    for (const k of OUTBOX_KINDS) KIND_HOOKS[k] = savedHooks[k];
  });

  // ---- an address that did not change ------------------------------------------------------------------------------------------

  describe("an address that did not change", () => {
    it("same address: sent to it, and the row still carries the account it is for", async () => {
      const acct = await account("same");
      const id = await queueFor(acct);
      expect((await get(id)).recipient_user_id, "the row really is an account's, so resolution had something to do").toBe(acct.id);

      expect(await tick(id)).toEqual({ ...ZERO, claimed: 1, sent: 1 });
      expect(sent().map((m) => m.to)).toEqual([acct.email]);
      const row = await get(id);
      expect([row.status, row.recipient]).toEqual(["sent", acct.email]);
    });

    it("the same address in another case is the same address: the row keeps its own spelling and nothing is rewritten", async () => {
      const acct = await account("case");
      const id = await queueFor(acct);
      const shouted = acct.email.toUpperCase();
      await sql`update users set email = ${shouted} where id = ${acct.id}`;
      expect(shouted, "the case really differs").not.toBe(acct.email);

      expect(await tick(id)).toEqual({ ...ZERO, claimed: 1, sent: 1 });
      expect(sent().map((m) => m.to)).toEqual([acct.email]);
      expect((await get(id)).recipient).toBe(acct.email);
    });
  });

  // ---- an address that changed -------------------------------------------------------------------------------------------------

  describe("an address that changed between the enqueue and the send", () => {
    it("key-clean (the first attempt): the row's recipient is rewritten and the new address is mailed under the same key", async () => {
      const acct = await account("moved");
      const id = await queueFor(acct);
      const next = await changeEmail(acct.id);
      expect(next).not.toBe(acct.email);

      expect(await tick(id)).toEqual({ ...ZERO, claimed: 1, sent: 1 });
      const calls = sent();
      expect(calls).toHaveLength(1);
      expect(calls[0]!.to).toBe(next);
      expect(calls[0]!.idempotencyKey).toBe(`email-outbox/${id}`);
      const row = await get(id);
      expect([row.status, row.recipient, row.recipient_user_id]).toEqual(["sent", next, acct.id]);

      // The sequence: a second tick finds a finished row and sends nothing.
      expect(await tick(id)).toEqual(ZERO);
      expect(sent()).toHaveLength(1);
    });

    it("not key-clean (a 503 attempt first): the FIRST address is kept, under the same key (D2)", async () => {
      const acct = await account("d2");
      const id = await queueFor(acct);
      deliverMock.mockImplementationOnce(async () => http(503, "service_unavailable"));

      expect(await tick(id)).toEqual({ ...ZERO, claimed: 1, retried: 1 });
      const retrying = await get(id);
      expect([retrying.status, retrying.attempts, retrying.last_error]).toEqual(["queued", 1, "http 503 service_unavailable"]);

      const next = await changeEmail(acct.id);
      await makeDue(id);
      expect(await tick(id)).toEqual({ ...ZERO, claimed: 1, sent: 1 });

      const calls = sent();
      expect(calls.map((m) => m.to), "both requests went to the address the first one may have reached").toEqual([acct.email, acct.email]);
      expect(calls.map((m) => m.idempotencyKey)).toEqual([`email-outbox/${id}`, `email-outbox/${id}`]);
      expect(next).not.toBe(acct.email);
      const row = await get(id);
      expect([row.status, row.recipient], "the row is not rewritten either").toEqual(["sent", acct.email]);
    });

    it("after ONE 429 (refused before any message was made): key-clean, the new address, and the same key", async () => {
      const acct = await account("rate1");
      const id = await queueFor(acct);
      deliverMock.mockImplementationOnce(async () => http(429, "rate_limit_exceeded"));

      expect(await tick(id)).toEqual({ ...ZERO, claimed: 1, retried: 1 });
      expect((await get(id)).last_error).toBe("http 429 rate_limit_exceeded");

      const next = await changeEmail(acct.id);
      await makeDue(id);
      expect(await tick(id)).toEqual({ ...ZERO, claimed: 1, sent: 1 });

      const calls = sent();
      expect(calls.map((m) => m.to)).toEqual([acct.email, next]);
      expect(calls.map((m) => m.idempotencyKey), "one key for both: the 429 created no message under it").toEqual([`email-outbox/${id}`, `email-outbox/${id}`]);
      expect((await get(id)).recipient).toBe(next);
    });

    it("after TWO 429s the first address is kept: only the last error survives, so the table does not vouch for the earlier attempt", async () => {
      const acct = await account("rate2");
      const id = await queueFor(acct);
      deliverMock.mockImplementationOnce(async () => http(429, "rate_limit_exceeded"));
      deliverMock.mockImplementationOnce(async () => http(429, "rate_limit_exceeded"));

      expect(await tick(id)).toEqual({ ...ZERO, claimed: 1, retried: 1 });
      await makeDue(id);
      expect(await tick(id)).toEqual({ ...ZERO, claimed: 1, retried: 1 });
      expect((await get(id)).attempts).toBe(2);

      await changeEmail(acct.id);
      await makeDue(id);
      expect(await tick(id)).toEqual({ ...ZERO, claimed: 1, sent: 1 });
      expect(sent().map((m) => m.to)).toEqual([acct.email, acct.email, acct.email]);
    });

    it("after a lapsed lease the first address is kept: a worker took the row, the provider answered, the write failed, and a later tick reclaims it", async () => {
      const acct = await account("lapse");
      const id = await queueFor(acct);
      // The write of the provider id collides with another row's (the column is unique), so the attempt throws AFTER the provider
      // accepted the message: the row stays `sending`, exactly what a worker that died mid-attempt leaves.
      const P = `re_${RUN}_collide`;
      const holder = await queue();
      await sql`update email_outbox set provider_id = ${P} where id = ${holder}`;
      deliverMock.mockImplementationOnce(async () => ({ ok: true, providerId: P }));

      expect(await tick(id)).toEqual({ ...ZERO, claimed: 1, failed: 1 });
      const stuck = await get(id);
      expect([stuck.status, stuck.attempts]).toEqual(["sending", 1]);

      await sql`update email_outbox set provider_id = null where id = ${holder}`;
      const next = await changeEmail(acct.id);
      await lapse(id); // the privileged update that ages the lease
      expect(await tick(id)).toEqual({ ...ZERO, claimed: 1, sent: 1 });

      expect(sent().map((m) => m.to), "the reclaim re-sends under the same key to the address the first request used").toEqual([acct.email, acct.email]);
      expect(next).not.toBe(acct.email);
      expect((await get(id)).recipient).toBe(acct.email);
    });

    it("a reclaim alone is enough to keep the first address, whatever the recorded error says", async () => {
      // Defence in depth, and the only test that isolates the `reclaimed` flag: the real flows that reclaim a row also fail the table
      // on `last_error` or `attempts`, so this row is forged (sending, one attempt, a 429 on record, the lease lapsed). Without the
      // flag, attempt 2 + a recorded 429 would read as clean and the new address would be mailed.
      const acct = await account("forged");
      const id = await queueFor(acct);
      await sql`
        update email_outbox
           set status = 'sending', attempts = 1, last_error = 'http 429 rate_limit_exceeded',
               lease_until = now() - interval '1 second', status_at = now()
         where id = ${id}`;
      await changeEmail(acct.id);

      expect(await tick(id)).toEqual({ ...ZERO, claimed: 1, sent: 1 });
      expect(sent().map((m) => m.to)).toEqual([acct.email]);
      const row = await get(id);
      expect([row.attempts, row.recipient]).toEqual([2, acct.email]);
    });

    it("the suppression gate is asked about the address the mail goes to: the NEW address is suppressed, the old one is not", async () => {
      // Only a non-transactional row consults the suppression list, and no account kind is one by default, so the row is written
      // `transactional: false` (as the phase-1 call sites do on a T kind to reach the gate).
      const acct = await account("gate");
      const id = await queue({ to: acct.email, recipientUserId: acct.id, transactional: false });
      const next = await changeEmail(acct.id);
      await suppress(next, "manual");
      suppressed.push(next);

      expect(await tick(id)).toEqual({ ...ZERO, claimed: 1, suppressed: 1 });
      expect(deliverMock, "the gate refused before any request").not.toHaveBeenCalled();
      expect((await get(id)).status).toBe("suppressed");
    });

    it("the gate does not hold an account to its OLD address once the mail has moved: only the old address is suppressed, the new one is mailed", async () => {
      const acct = await account("gate2");
      const id = await queue({ to: acct.email, recipientUserId: acct.id, transactional: false });
      await suppress(acct.email, "manual");
      suppressed.push(acct.email);
      const next = await changeEmail(acct.id);

      expect(await tick(id)).toEqual({ ...ZERO, claimed: 1, sent: 1 });
      expect(sent().map((m) => m.to)).toEqual([next]);
    });

    it("dispatchNow's claim is key-clean: the first attempt in a request after an email change mails the new address", async () => {
      const acct = await account("dispatch");
      const id = await queueFor(acct, { fresh: true });
      const next = await changeEmail(acct.id);

      expect((await dispatchNow([id])).get(id)).toBe("sent");
      expect(sent().map((m) => m.to)).toEqual([next]);
      expect(sent()[0]!.idempotencyKey).toBe(`email-outbox/${id}`);
      const row = await get(id);
      expect([row.status, row.recipient, row.attempts]).toEqual(["sent", next, 1]);
    });

    it("a row that is no longer ours when the address is rewritten sends nothing (the rewrite is fenced on the claim)", async () => {
      // attemptClaimed is handed a hand-claimed row on purpose: the interleaving (a supersede between the claim and the resolution) cannot
      // be made to land there through a tick. The claim statement is the production one, copied.
      const acct = await account("fence");
      const id = await queueFor(acct);
      const [rec] = await sql<ClaimedRecord[]>`
        update email_outbox
           set status = 'sending', attempts = attempts + 1, lease_until = now() + interval '2 minutes', status_at = now()
         where id = ${id} and status = 'queued'
        returning id, kind, ref_type, ref_id, org_id, meta, recipient, subject, body_sealed, transactional,
                  attempts, expires_at, lease_until, recipient_user_id, last_error, false as reclaimed`;
      const claimed = toClaimedRow(rec!);
      expect([claimed.recipientUserId, claimed.lastError, claimed.reclaimed]).toEqual([acct.id, null, false]);
      await changeEmail(acct.id);
      await sql`update email_outbox set status = 'replaced', body_sealed = null, lease_until = null where id = ${id}`;

      const res = await attemptClaimed(claimed);
      expect([res.outcome, res.requestMade]).toEqual(["deferred", false]);
      expect(deliverMock).not.toHaveBeenCalled();
      const row = await get(id);
      expect([row.status, row.recipient], "the superseded row is not touched").toEqual(["replaced", acct.email]);
    });
  });

  // ---- an account that was deleted ---------------------------------------------------------------------------------------------

  describe("an account deleted between the enqueue and the send", () => {
    it("is never mailed: the row ends expired, account_deleted, with the placeholder in place of the address and no body", async () => {
      const acct = await account("gone");
      const id = await queueFor(acct);
      await sql`update users set deleted_at = now() where id = ${acct.id}`;

      expect(await tick(id)).toEqual({ ...ZERO, claimed: 1, expired: 1 });
      expect(deliverMock, "not one request for a deleted person").not.toHaveBeenCalled();
      const row = await get(id);
      expect(row.status).toBe("expired");
      expect(row.last_error).toBe(ACCOUNT_DELETED_REASON);
      expect(row.last_error).toBe("account_deleted");
      expect(row.recipient).toBe(`deleted-${acct.id}@deleted.invalid`);
      expect(row.body_sealed).toBeNull();
      expect(row.lease_until).toBeNull();
      expect(Date.now() - row.status_at.getTime()).toBeLessThan(60_000);
      expect(JSON.stringify(row), "the old address is nowhere on the row").not.toContain(acct.email);

      // A badly-ended row reaches its kind's hook (the chess hook releases the seat's stamp), once, as expired.
      expect(hookSpy).toHaveBeenCalledTimes(1);
      expect(hookSpy.mock.calls[0]![0]).toMatchObject({ id, kind: "chess_invite", status: "expired" });

      // The sequence: a second tick finds a terminal row.
      expect(await tick(id)).toEqual(ZERO);
      expect(deliverMock).not.toHaveBeenCalled();
    });

    it("also through dispatchNow, and with the address already anonymised the way the deletion route leaves it", async () => {
      const acct = await account("gone2");
      const id = await queueFor(acct, { fresh: true });
      await sql`update users set deleted_at = now(), email = ${deletedAccountPlaceholder(acct.id)} where id = ${acct.id}`;

      expect((await dispatchNow([id])).get(id)).toBe("expired");
      expect(deliverMock).not.toHaveBeenCalled();
      const row = await get(id);
      expect([row.status, row.last_error, row.recipient]).toEqual(["expired", "account_deleted", `deleted-${acct.id}@deleted.invalid`]);
      expect(hookSpy).toHaveBeenCalledTimes(1);
    });

    it("even after a 503 attempt (a send that may have reached Resend): nothing further is mailed to a deleted person", async () => {
      const acct = await account("gone3");
      const id = await queueFor(acct);
      deliverMock.mockImplementationOnce(async () => http(503, "service_unavailable"));
      expect(await tick(id)).toEqual({ ...ZERO, claimed: 1, retried: 1 });

      await sql`update users set deleted_at = now() where id = ${acct.id}`;
      await makeDue(id);
      expect(await tick(id)).toEqual({ ...ZERO, claimed: 1, expired: 1 });
      expect(deliverMock, "the 503 request was the only one").toHaveBeenCalledTimes(1);
      const row = await get(id);
      expect([row.status, row.last_error, row.recipient]).toEqual(["expired", "account_deleted", `deleted-${acct.id}@deleted.invalid`]);
    });
  });

  // ---- the fences and the read error (T3 review M1, M2) -----------------------------------------------------------------------

  describe("the claim's fences and the resolution's read error", () => {
    /** The production claim statement, copied: attemptClaimed is handed what a claim returned, so the interleavings below (another
     *  worker acting between the claim and the resolution) can be staged exactly. */
    async function handClaim(id: string): Promise<ReturnType<typeof toClaimedRow>> {
      const [rec] = await sql<ClaimedRecord[]>`
        update email_outbox
           set status = 'sending', attempts = attempts + 1, lease_until = now() + interval '2 minutes', status_at = now()
         where id = ${id} and status = 'queued'
        returning id, kind, ref_type, ref_id, org_id, meta, recipient, subject, body_sealed, transactional,
                  attempts, expires_at, lease_until, recipient_user_id, last_error, false as reclaimed`;
      return toClaimedRow(rec!);
    }

    it("M1: a recipient id the database cannot read (22P02) rejects, sends nothing, and leaves the row `sending` for the worker to reclaim", async () => {
      const acct = await account("badid");
      const id = await queueFor(acct);
      const claimed = { ...(await handClaim(id)), recipientUserId: "not-a-uuid" };

      const err = (await attemptClaimed(claimed).catch((e: unknown) => e)) as { code?: string };
      expect(err, "a read failure propagates, it is not swallowed into a send").toBeInstanceOf(Error);
      expect(err.code, "invalid_text_representation").toBe("22P02");
      expect(deliverMock, "nothing was requested under a recipient nobody could resolve").not.toHaveBeenCalled();
      const row = await get(id);
      expect([row.status, row.attempts, row.recipient], "the row is left exactly as the claim made it").toEqual(["sending", 1, acct.email]);
      expect(row.lease_until, "... with its lease, which is how the worker finds it").not.toBeNull();

      // The sequence: once the lease lapses the worker reclaims it, and it is a RECLAIM (not key-clean), so a changed address is not followed.
      await sql`update email_outbox set lease_until = now() - interval '1 second' where id = ${id}`;
      await changeEmail(acct.id);
      expect(await tick(id)).toEqual({ ...ZERO, claimed: 1, sent: 1 });
      expect(sent().map((m) => m.to)).toEqual([acct.email]);
    });

    it("M2: a row another worker re-claimed (attempts bumped) between the claim and the rewrite is `lost`: nothing is sent and the row is not rewritten", async () => {
      const acct = await account("fence2");
      const id = await queueFor(acct);
      const claimed = await handClaim(id);
      expect([claimed.attempts, claimed.reclaimed], "premise: a clean first attempt, which would follow the account").toEqual([1, false]);
      const next = await changeEmail(acct.id);
      expect(next).not.toBe(acct.email);
      // Another worker took the row over after its lease lapsed and claimed it again: still `sending`, but it is attempt 2 now.
      await sql`update email_outbox set attempts = 2 where id = ${id}`;

      const res = await attemptClaimed(claimed);
      expect([res.outcome, res.requestMade]).toEqual(["deferred", false]);
      expect(deliverMock).not.toHaveBeenCalled();
      const row = await get(id);
      expect([row.status, row.attempts, row.recipient], "the other attempt's row is untouched").toEqual(["sending", 2, acct.email]);
    });

    it("M2: the same row, un-fenced (attempts unchanged), IS rewritten and sent (the positive pair: the fence is what stopped the one above)", async () => {
      const acct = await account("fence2b");
      const id = await queueFor(acct);
      const claimed = await handClaim(id);
      const next = await changeEmail(acct.id);

      const res = await attemptClaimed(claimed);
      expect([res.outcome, res.requestMade]).toEqual(["sent", true]);
      expect(sent().map((m) => m.to)).toEqual([next]);
      expect((await get(id)).recipient).toBe(next);
    });

    it("M2: a deleted account's row that another worker re-claimed is not ended by this attempt (markAccountDeleted is fenced on the attempt)", async () => {
      const acct = await account("fence3");
      const id = await queueFor(acct);
      const claimed = await handClaim(id);
      await sql`update users set deleted_at = now() where id = ${acct.id}`;
      await sql`update email_outbox set attempts = 2 where id = ${id}`;

      const res = await attemptClaimed(claimed);
      expect([res.outcome, res.requestMade]).toEqual(["deferred", false]);
      expect(deliverMock).not.toHaveBeenCalled();
      const row = await get(id);
      expect([row.status, row.attempts, row.last_error], "not expired by a stale attempt").toEqual(["sending", 2, null]);
      expect(row.recipient, "the address is not scrubbed by a stale attempt either").toBe(acct.email);
      expect(row.body_sealed, "the body is still there for the attempt that owns the row").not.toBeNull();
    });

    it("M2: a deleted account's row superseded between the claim and the end is not touched (the status fence)", async () => {
      const acct = await account("fence4");
      const id = await queueFor(acct);
      const claimed = await handClaim(id);
      await sql`update users set deleted_at = now() where id = ${acct.id}`;
      await sql`update email_outbox set status = 'replaced', body_sealed = null, lease_until = null where id = ${id}`;

      const res = await attemptClaimed(claimed);
      expect([res.outcome, res.requestMade]).toEqual(["deferred", false]);
      const row = await get(id);
      expect([row.status, row.last_error, row.recipient]).toEqual(["replaced", null, acct.email]);
    });
  });

  // ---- the key-clean rule is written twice (T3 review M3) ----------------------------------------------------------------------

  describe("the key-clean rule, in TypeScript and in SQL", () => {
    // `isKeyClean` (recipient.ts) judges a CLAIMED row: its `attempts` already counts this attempt. `lockQueuedEmails` (status.ts,
    // the check-in extension's "may this queued row be re-rendered?") judges the same row BEFORE a claim: its `attempts` does not.
    // They are one rule over two moments, so a pre-claim row with n attempts must be eligible exactly when the claim of it (n + 1
    // attempts, nothing reclaimed) would be key-clean. If the two ever drift, the extension re-renders (new key, new body) a row
    // whose send the resolution still treats as possibly delivered, or the reverse.
    const ATTEMPTS = [0, 1, 2, 3, 4, 5, 6];
    // Every shape `lastErrorOf` writes (`http <status> <name>`, `network <detail>`), the bare statuses it cannot, and nothing.
    const LAST_ERRORS: Array<string | null> = [
      null,
      "http 429 rate_limit_exceeded",
      "http 429 unknown",
      "http 503 service_unavailable",
      "http 500 internal_server_error",
      "http 409 concurrent_idempotent_requests",
      "network timeout",
      "http 4290 x",
      "http 429",
      "",
    ];

    it("agree on every (attempts, last_error): a queued row is re-render-eligible exactly when its claim would be key-clean", async () => {
      let checked = 0;
      let eligibleSeen = 0;
      let ineligibleSeen = 0;
      for (const attempts of ATTEMPTS) {
        for (const lastError of LAST_ERRORS) {
          const refId = `${RUN}-${randomUUID()}`;
          const id = await queue({ refId, orgId: null }, { fresh: true });
          await sql`update email_outbox set attempts = ${attempts}, last_error = ${lastError} where id = ${id}`;
          const eligible = (
            await sql.begin((tx) => lockQueuedEmails(tx, "chess_invite", "fixture_seat", [refId]))
          ).some((r) => r.id === id);
          const clean = isKeyClean({ attempts: attempts + 1, lastError, reclaimed: false });
          expect(eligible, JSON.stringify({ attempts, lastError, sqlEligible: eligible, tsClean: clean })).toBe(clean);
          if (eligible) eligibleSeen++;
          else ineligibleSeen++;
          checked++;
        }
      }
      expect(checked, "anti-vacuity: the whole grid was judged by both").toBe(ATTEMPTS.length * LAST_ERRORS.length);
      expect(eligibleSeen, "the grid has both answers").toBeGreaterThan(0);
      expect(ineligibleSeen).toBeGreaterThan(0);
      // The rule's two accepting corners, spelled out so a grid that drifted together would still be caught: a never-attempted row, and
      // a row whose only attempt was a 429.
      expect(eligibleSeen, "10 last_errors at 0 attempts, plus the 429 shapes at 1 attempt").toBe(LAST_ERRORS.length + 2);
    });
  });

  // ---- rows that are not an account's ------------------------------------------------------------------------------------------

  describe("rows that carry no account", () => {
    it("an L kind is never resolved: a registration_confirmation to a user's OLD address is mailed at the row's address", async () => {
      const acct = await account("literal");
      const oldAddress = acct.email;
      const id = await queue({ kind: "registration_confirmation", transactional: false, to: oldAddress, refType: "registration" });
      expect((await get(id)).recipient_user_id, "a literal kind carries no account").toBeNull();
      const next = await changeEmail(acct.id);
      expect(next, "the account really did move").not.toBe(oldAddress);

      expect(await tick(id)).toEqual({ ...ZERO, claimed: 1, sent: 1 });
      expect(sent().map((m) => m.to)).toEqual([oldAddress]);
      expect((await get(id)).recipient).toBe(oldAddress);
      expect(errorSpy.mock.calls.filter((c) => (c[0] as { outboxId?: string }).outboxId === id), "no account was looked up, so none was missing").toHaveLength(0);
    });

    it("a chess_invite with no account id (the shape phase-1 call sites write) is mailed at its own address, whatever the address's owner did since", async () => {
      const acct = await account("noid");
      const id = await queue({ to: acct.email }); // recipientUserId omitted
      expect((await get(id)).recipient_user_id).toBeNull();
      const next = await changeEmail(acct.id);
      expect(next).not.toBe(acct.email);

      expect(await tick(id)).toEqual({ ...ZERO, claimed: 1, sent: 1 });
      expect(sent().map((m) => m.to)).toEqual([acct.email]);
      expect((await get(id)).recipient).toBe(acct.email);
      expect(errorSpy.mock.calls.filter((c) => (c[0] as { outboxId?: string }).outboxId === id), "no account was looked up, so none was missing").toHaveLength(0);
    });

    it("a recipient user id with no users row is sent literally and logged", async () => {
      // The foreign key (on delete set null) makes this impossible, so the row is written with the key checks off (replica role).
      const ghost = randomUUID();
      const address = `${randomUUID()}@x.test`;
      const id = await sql.begin(async (tx) => {
        await tx`set local session_replication_role = replica`;
        return enqueueEmail(tx, {
          kind: "chess_invite",
          refType: "fixture_seat",
          refId: `${RUN}-${randomUUID()}`,
          orgId: null,
          to: address,
          subject: "Your game is ready",
          html: "<p>Play</p>",
          text: "Play",
          transactional: true,
          expiresAt: new Date(Date.now() + 15 * MIN),
          recipientUserId: ghost,
        });
      });
      created.push(id);
      await sql`update email_outbox set created_at = now() - make_interval(secs => ${FIRST_ATTEMPT_WINDOW_MS / 1000 + 60}) where id = ${id}`;
      const [users1] = await sql<{ n: number }[]>`select count(*)::int as n from users where id = ${ghost}`;
      expect(users1!.n, "the id really names nobody").toBe(0);
      errorSpy.mockClear();

      expect(await tick(id)).toEqual({ ...ZERO, claimed: 1, sent: 1 });
      expect(sent().map((m) => m.to)).toEqual([address]);
      const logged = errorSpy.mock.calls.filter((c) => (c[0] as { outboxId?: string }).outboxId === id);
      expect(logged, "one error line, naming the row").toHaveLength(1);
      expect(JSON.stringify(errorSpy.mock.calls), "ids only: no address in the log").not.toContain(address);
    });
  });
});
