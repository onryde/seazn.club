// Task 8: `extendEmailExpiry`, the half of "expiry follows a check-in extension" that lives in the outbox. The caller (checkin-extend.ts,
// proved end to end in usecases/__tests__/external-play-checkin-extend.test.ts) hands it the seats' refs and the board's new deadline;
// it moves the `expires_at` of the invites that can still be sent, so a retry between the old and the new deadline is delivered
// instead of expired. Controller rulings: T8-R1 (it runs on the caller's PRIVILEGED transaction: V470 gives `app_user` INSERT only, so
// a tenant caller is refused, loudly, and V470 needs no amendment) and T8-R2 (an extension never pushes a row past what Resend's 24 h
// idempotency key covers: `created_at + MAX_EXPIRY_MS`).
//
// Pinned here:
//  - it moves the rows that are still retryable (`queued`, `sending`) and nothing else: not a `sent`, `delivered` or any other
//    terminal row (swept over the whole status vocabulary), not another kind, ref type or ref;
//  - it never shortens: an earlier or equal deadline leaves the row as it was (and a row already past the cap is not pulled back);
//  - it clamps to the cap, to the millisecond, with the cap derived from MAX_EXPIRY_MS and the row's own `created_at`;
//  - a second extension moves again, a repeat of the same one changes nothing, an empty id list issues no statement, an Invalid Date
//    is refused before it moves anything, and a tenant (app_user) transaction is refused with 42501.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { MAX_EXPIRY_MS, OUTBOX_STATUSES, RESEND_IDEMPOTENCY_TTL_MS, RETRYABLE_STATUSES, type OutboxKind, type OutboxStatus } from "../constants";
import { extendEmailExpiry } from "../enqueue";

const HAS_DB = !!process.env.DATABASE_URL;
const RUN = `t8e-${randomUUID().slice(0, 8)}`;
const MIN = 60_000;
const REF_TYPE = "fixture_seat";
/** Whole seconds: a Date survives the round trip through timestamptz exactly. */
const NOW = Math.floor(Date.now() / 1000) * 1000;
const at = (offsetMs: number): Date => new Date(NOW + offsetMs);

// No database: an empty id list is answered without a statement (a recording stub proves it in both modes of the suite).
describe("extendEmailExpiry with nothing to extend", () => {
  it("empty refIds moves nothing and issues no statement", async () => {
    const calls: unknown[][] = [];
    const db = Object.assign(async (...args: unknown[]) => (calls.push(args), []), { json: (v: unknown) => v });
    expect(await extendEmailExpiry(db as never, REF_TYPE, [], at(MIN))).toBe(0);
    expect(calls).toHaveLength(0);
  });
});

describe.skipIf(!HAS_DB)("extendEmailExpiry (V470 email_outbox)", () => {
  let orgId = "";

  interface Seed {
    id?: string;
    kind?: OutboxKind;
    refType?: string;
    ref: string;
    status?: OutboxStatus;
    createdAt?: Date;
    expiresAt: Date;
  }
  async function insertRow(s: Seed): Promise<string> {
    const id = s.id ?? randomUUID();
    const status = s.status ?? "queued";
    await sql`
      insert into email_outbox
        (id, kind, ref_type, ref_id, org_id, recipient, subject, transactional, status, lease_until, expires_at, created_at, status_at)
      values
        (${id}, ${s.kind ?? "chess_invite"}, ${s.refType ?? REF_TYPE}, ${s.ref}, ${orgId}, ${`${randomUUID()}@x.test`}, 's', true,
         ${status}, ${status === "sending" ? at(5 * MIN) : null}, ${s.expiresAt}, ${s.createdAt ?? at(-MIN)}, ${s.createdAt ?? at(-MIN)})`;
    return id;
  }
  const expiryOf = async (id: string): Promise<Date> =>
    (await sql<{ e: Date }[]>`select expires_at as e from email_outbox where id = ${id}`)[0]!.e;
  const snapshot = async (ids: string[]): Promise<Array<Record<string, unknown>>> =>
    (await sql<{ j: Record<string, unknown> }[]>`select to_jsonb(e) as j from email_outbox e where id = any(${ids}::uuid[]) order by id`).map((r) => r.j);
  const newRef = (): string => `${RUN}-${randomUUID()}`;

  beforeAll(async () => {
    const [o] = await sql<{ id: string }[]>`
      insert into organizations (name, slug) values ('Extend expiry', ${`extend-expiry-${RUN}`}) returning id`;
    orgId = o!.id;
  });
  afterAll(async () => {
    await sql`delete from email_outbox where ref_id like ${`${RUN}-%`}`;
    await sql`delete from organizations where id = ${orgId}`;
    await sql.end({ timeout: 2 }).catch(() => undefined);
  });

  it("moves the expiry of every RETRYABLE invite to the new deadline, and says how many rows it matched", async () => {
    const ref = newRef();
    const ids: string[] = [];
    for (const status of RETRYABLE_STATUSES) ids.push(await insertRow({ ref, status, expiresAt: at(10 * MIN) }));
    expect(await extendEmailExpiry(sql, REF_TYPE, [ref], at(15 * MIN))).toBe(RETRYABLE_STATUSES.length);
    for (const id of ids) expect((await expiryOf(id)).getTime()).toBe(at(15 * MIN).getTime());
    expect(ids.length, "anti-vacuity: queued and sending were both moved").toBe(2);
  });

  it("never shortens: an earlier or an equal deadline leaves the row as it was, a later one moves it", async () => {
    const ref = newRef();
    const id = await insertRow({ ref, expiresAt: at(10 * MIN) });
    await extendEmailExpiry(sql, REF_TYPE, [ref], at(5 * MIN));
    expect((await expiryOf(id)).getTime(), "earlier").toBe(at(10 * MIN).getTime());
    await extendEmailExpiry(sql, REF_TYPE, [ref], at(10 * MIN));
    expect((await expiryOf(id)).getTime(), "equal").toBe(at(10 * MIN).getTime());
    await extendEmailExpiry(sql, REF_TYPE, [ref], at(10 * MIN + 1));
    expect((await expiryOf(id)).getTime(), "one ms later moves it (the positive pair)").toBe(at(10 * MIN + 1).getTime());
  });

  it("leaves every row that is not retryable alone - the whole status vocabulary swept, the row compared column for column", async () => {
    const ref = newRef();
    const ids: string[] = [];
    for (const status of OUTBOX_STATUSES) {
      if (RETRYABLE_STATUSES.includes(status)) continue;
      ids.push(await insertRow({ ref: `${ref}-${status}`, status, expiresAt: at(10 * MIN) }));
    }
    const before = await snapshot(ids);
    const refs = OUTBOX_STATUSES.filter((s) => !RETRYABLE_STATUSES.includes(s)).map((s) => `${ref}-${s}`);
    expect(await extendEmailExpiry(sql, REF_TYPE, refs, at(20 * MIN))).toBe(0);
    expect(await snapshot(ids)).toEqual(before);
    expect(ids.length, "anti-vacuity: every non-retryable status was judged").toBe(OUTBOX_STATUSES.length - RETRYABLE_STATUSES.length);
  });

  it("touches only kind chess_invite, only the ref type and the refs it is given", async () => {
    const ref = newRef();
    const other = newRef();
    const mine = await insertRow({ ref, expiresAt: at(10 * MIN) });
    const signIn = await insertRow({ ref, kind: "magic_link", expiresAt: at(10 * MIN) });
    const otherType = await insertRow({ ref, refType: "something_else", expiresAt: at(10 * MIN) });
    const otherRef = await insertRow({ ref: other, expiresAt: at(10 * MIN) });
    const before = await snapshot([signIn, otherType, otherRef]);
    expect(await extendEmailExpiry(sql, REF_TYPE, [ref], at(20 * MIN))).toBe(1);
    expect((await expiryOf(mine)).getTime()).toBe(at(20 * MIN).getTime());
    expect(await snapshot([signIn, otherType, otherRef]), "a sign-in link, another ref type and another ref are not moved").toEqual(before);
  });

  it("moves the rows of several refs in one call (a board's two seats)", async () => {
    const white = newRef();
    const black = newRef();
    const a = await insertRow({ ref: white, expiresAt: at(10 * MIN) });
    const b = await insertRow({ ref: black, expiresAt: at(10 * MIN) });
    expect(await extendEmailExpiry(sql, REF_TYPE, [white, black], at(15 * MIN))).toBe(2);
    expect([(await expiryOf(a)).getTime(), (await expiryOf(b)).getTime()]).toEqual([at(15 * MIN).getTime(), at(15 * MIN).getTime()]);
  });

  describe("T8-R2: the cap is what Resend's idempotency key still covers (created_at + MAX_EXPIRY_MS)", () => {
    const created = at(-30 * MIN);
    const cap = created.getTime() + MAX_EXPIRY_MS;

    it("the cap is a real clamp: inside the key's life, with its margin", () => {
      expect(MAX_EXPIRY_MS).toBeLessThan(RESEND_IDEMPOTENCY_TTL_MS);
      expect(cap).toBeLessThan(created.getTime() + RESEND_IDEMPOTENCY_TTL_MS);
    });

    it("an extension far past the cap clamps to created_at + MAX_EXPIRY_MS, exactly", async () => {
      const ref = newRef();
      const id = await insertRow({ ref, createdAt: created, expiresAt: at(10 * MIN) });
      await extendEmailExpiry(sql, REF_TYPE, [ref], new Date(created.getTime() + 10 * RESEND_IDEMPOTENCY_TTL_MS));
      expect((await expiryOf(id)).getTime()).toBe(cap);
    });

    it("one ms inside the cap moves exactly there, the cap itself moves there, and one ms past it stops at it", async () => {
      const ref = newRef();
      const id = await insertRow({ ref, createdAt: created, expiresAt: at(10 * MIN) });
      await extendEmailExpiry(sql, REF_TYPE, [ref], new Date(cap - 1));
      expect((await expiryOf(id)).getTime(), "one ms inside").toBe(cap - 1);
      await extendEmailExpiry(sql, REF_TYPE, [ref], new Date(cap));
      expect((await expiryOf(id)).getTime(), "at the cap").toBe(cap);
      await extendEmailExpiry(sql, REF_TYPE, [ref], new Date(cap + 1));
      expect((await expiryOf(id)).getTime(), "one ms past the cap").toBe(cap);
    });

    it("the cap runs from the row's own created_at, not from the clock: an older row is capped sooner", async () => {
      const ref = newRef();
      const olderCreated = at(-10 * 3_600_000);
      const id = await insertRow({ ref, createdAt: olderCreated, expiresAt: at(10 * MIN) });
      await extendEmailExpiry(sql, REF_TYPE, [ref], new Date(NOW + MAX_EXPIRY_MS));
      expect((await expiryOf(id)).getTime()).toBe(olderCreated.getTime() + MAX_EXPIRY_MS);
    });

    it("a row already past the cap (enqueue allows a few seconds of clock skew) is not pulled back by an extension, earlier or later", async () => {
      const ref = newRef();
      const past = new Date(cap + MIN);
      const id = await insertRow({ ref, createdAt: created, expiresAt: past });
      await extendEmailExpiry(sql, REF_TYPE, [ref], new Date(cap + 10 * MIN));
      expect((await expiryOf(id)).getTime(), "a later deadline does not push it further").toBe(past.getTime());
      await extendEmailExpiry(sql, REF_TYPE, [ref], at(5 * MIN));
      expect((await expiryOf(id)).getTime(), "an earlier deadline does not shorten it").toBe(past.getTime());
    });
  });

  it("sequence: a second extension moves the row again, and repeating one changes nothing", async () => {
    const ref = newRef();
    const id = await insertRow({ ref, expiresAt: at(10 * MIN) });
    await extendEmailExpiry(sql, REF_TYPE, [ref], at(15 * MIN));
    await extendEmailExpiry(sql, REF_TYPE, [ref], at(15 * MIN));
    expect((await expiryOf(id)).getTime()).toBe(at(15 * MIN).getTime());
    await extendEmailExpiry(sql, REF_TYPE, [ref], at(20 * MIN));
    expect((await expiryOf(id)).getTime()).toBe(at(20 * MIN).getTime());
  });

  it("an Invalid Date is refused and moves nothing", async () => {
    const ref = newRef();
    const id = await insertRow({ ref, expiresAt: at(10 * MIN) });
    await expect(extendEmailExpiry(sql, REF_TYPE, [ref], new Date(Number.NaN))).rejects.toThrow();
    expect((await expiryOf(id)).getTime()).toBe(at(10 * MIN).getTime());
  });

  it("T8-R1: a tenant (app_user) transaction is refused with 42501 and moves nothing - the extension needs the privileged connection", async () => {
    const ref = newRef();
    const id = await insertRow({ ref, expiresAt: at(10 * MIN) });
    const err = await sql
      .begin(async (tx) => {
        await tx`set local role app_user`;
        await extendEmailExpiry(tx, REF_TYPE, [ref], at(20 * MIN));
      })
      .then(() => null, (e: { code?: string; message?: string }) => e);
    expect(err, "the update was attempted and refused").not.toBeNull();
    expect(err!.code).toBe("42501");
    expect(err!.message).toMatch(/permission denied for table email_outbox/);
    expect((await expiryOf(id)).getTime()).toBe(at(10 * MIN).getTime());
  });
});
