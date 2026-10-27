// Task 8 fix round 1 (I1): the 90-day purge is wired into the PRODUCTION tick, proven by the real thing.
//
// Every other worker test scopes its tick with `onlyIds` (the seam that keeps parallel files off each other's rows), so the branch
// the cron route takes - `runOutboxTick()` with NO scope - never ran in a test: a "make the scope safe" edit that defaulted it to
// `[]` made the retention a permanent no-op and left every test green. This file runs that branch for real: `runOutboxTick` with no
// options but the clock, against rows older than RETENTION_DAYS, and requires them gone. The recipient scrub (step 7a) has the same
// unscoped branch, so it is driven here too.
//
// An unscoped tick claims, expires and purges ANY row in its table, which in the shared test database would reach into other files'
// rows. So this file gives its own pool its own schema: DB_SCHEMA is set before `@/lib/db` creates the pool (the pool's search_path
// comes from it, once), and `email_outbox` there is a copy of the real table (`like ... including all`: columns, defaults, CHECKs and
// indexes; no trigger, no RLS, no foreign key). Nothing but this file's rows can be in it, so the counts below are exact.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";

const HAS_DB = !!process.env.DATABASE_URL;
const iso = vi.hoisted(() => {
  const real = process.env.DB_SCHEMA ?? "seazn_club";
  const schema = `t8iso_${Math.random().toString(16).slice(2, 14)}`;
  // Only with a database: without one the pool is never created and the suite skips.
  if (process.env.DATABASE_URL) process.env.DB_SCHEMA = schema;
  return { real, schema };
});

const logMock = vi.hoisted(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }));
vi.mock("@/server/logger", () => ({ log: logMock }));
const deliverMock = vi.hoisted(() => vi.fn());
vi.mock("@/server/email-outbox/transport", () => ({ deliver: deliverMock }));

import { connectionOptions, sql } from "@/lib/db";
import { PURGE_BATCH, RETENTION_DAYS } from "../constants";
import { KIND_HOOKS } from "../hooks";
import { runOutboxTick } from "../worker";

const DAY = 24 * 3_600_000;
const RUN = `t8w-${randomUUID().slice(0, 8)}`;

describe.skipIf(!HAS_DB)("the production tick (no scope) purges the retention, in a schema of its own", () => {
  let admin: ReturnType<typeof postgres>;
  const saved = { ...KIND_HOOKS };

  /** A finished row (`expired`, no body) created `ageMs` ago. */
  async function finished(ageMs: number): Promise<string> {
    const id = randomUUID();
    await sql`
      insert into email_outbox
        (id, kind, ref_type, ref_id, org_id, recipient, subject, transactional, status, expires_at, created_at, status_at)
      values
        (${id}, 'magic_link', 'login', ${`${RUN}-${id}`}, null, ${`${id}@x.test`}, 's', true, 'expired',
         now() + interval '1 hour', now() - make_interval(secs => ${ageMs / 1000}), now())`;
    return id;
  }
  const remaining = async (): Promise<string[]> =>
    (await sql<{ id: string }[]>`select id from email_outbox order by id`).map((r) => r.id);
  const tick = () => runOutboxTick({ sleep: async () => undefined, nowMs: () => 0 });

  beforeAll(async () => {
    const url = process.env.DATABASE_URL!;
    admin = postgres(url, { max: 1, ssl: connectionOptions(url).ssl, connection: { search_path: iso.real } });
    await admin.unsafe(`create schema "${iso.schema}"`);
    await admin.unsafe(`create table "${iso.schema}".email_outbox (like "${iso.real}".email_outbox including all)`);
  });
  afterAll(async () => {
    await sql.end({ timeout: 2 }).catch(() => undefined);
    await admin.unsafe(`drop schema if exists "${iso.schema}" cascade`).catch(() => undefined);
    await admin.end({ timeout: 2 }).catch(() => undefined);
  });
  beforeEach(() => {
    logMock.error.mockClear();
    logMock.info.mockClear();
    logMock.warn.mockClear();
    // The chess hook reads tables this schema does not have; nothing here ends badly, so no hook is wanted at all.
    for (const k of Object.keys(KIND_HOOKS) as Array<keyof typeof KIND_HOOKS>) KIND_HOOKS[k] = {};
  });
  afterEach(() => {
    Object.assign(KIND_HOOKS, saved);
  });

  it("premise: this file's pool resolves email_outbox to ITS copy, not the shared table", async () => {
    const [row] = await sql<{ s: string; same: boolean }[]>`
      select current_schema() as s,
             to_regclass('email_outbox') = to_regclass(${`"${iso.schema}".email_outbox`}) as same`;
    expect(row).toEqual({ s: iso.schema, same: true });
    expect(iso.schema).not.toBe(iso.real);
    expect(await remaining(), "and the copy starts empty").toEqual([]);
  });

  it("runOutboxTick() with NO options but the clock removes the rows older than RETENTION_DAYS, keeps the younger ones, and reports exactly them", async () => {
    const old = [await finished(RETENTION_DAYS * DAY + 3_600_000), await finished((RETENTION_DAYS + 30) * DAY)];
    const young = [await finished((RETENTION_DAYS - 1) * DAY), await finished(0)];
    expect(await remaining(), "premise: all four rows are there").toHaveLength(4);

    const report = await tick();
    expect(report.purged, "the tick reports what it purged").toBe(old.length);
    expect(report).toMatchObject({ claimed: 0, sent: 0, expired: 0, failed: 0 });
    expect(await remaining(), "exactly the young rows survive").toEqual([...young].sort());

    expect((await tick()).purged, "the empty case: the next tick has nothing left to purge").toBe(0);
    expect(await remaining()).toEqual([...young].sort());
  });

  it("is the same tick that does the rest: the production tick also expires a past-due row and then purges what is old", async () => {
    // A control that this table is a live tick's, not a dead one: a queued row past its expiry is ended by step 1, and a row old
    // enough is deleted by step 7, in one unscoped call.
    const id = randomUUID();
    await sql`
      insert into email_outbox (id, kind, ref_type, ref_id, org_id, recipient, subject, transactional, status, expires_at, created_at)
      values (${id}, 'magic_link', 'login', ${`${RUN}-${id}`}, null, ${`${id}@x.test`}, 's', true, 'queued',
              now() - interval '1 minute', now() - interval '10 minutes')`;
    const oldOne = await finished((RETENTION_DAYS + 1) * DAY);
    const report = await tick();
    expect(report).toMatchObject({ expired: 1, purged: 1 });
    const left = await sql<{ id: string; status: string }[]>`select id, status from email_outbox where id = any(${[id, oldOne]}::uuid[])`;
    expect(left).toEqual([{ id, status: "expired" }]);
  });

  it("the production tick also scrubs an ended deletion notice's address, and leaves a notice still waiting to be sent alone", async () => {
    // Step 7a on the unscoped branch: every other scrub test passes `onlyIds`, so a no-op unscoped scrub stayed green (Task 3 review I2).
    // The placeholder is typed from the rule (the deleted account's `deleted-<id>@deleted.invalid`), not from the statement.
    const [endedAccount, waitingAccount, ended, waiting] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    const waitingTo = `${RUN}-waiting@x.test`;
    await sql`
      insert into email_outbox
        (id, kind, ref_type, ref_id, org_id, recipient, subject, transactional, status, attempts, expires_at)
      values
        (${ended}, 'account_deletion', 'user', ${endedAccount}, null, ${`${RUN}-ended@x.test`}, 's', true, 'sent', 1, now() + interval '1 hour'),
        (${waiting}, 'account_deletion', 'user', ${waitingAccount}, null, ${waitingTo}, 's', true, 'queued', 0, now() + interval '1 hour')`;
    await sql`update email_outbox set next_attempt_at = now() + interval '1 hour' where id = ${waiting}`;

    const report = await tick();

    expect(report.scrubbed, "the tick reports the one ended notice it scrubbed").toBe(1);
    const rows = await sql<{ id: string; recipient: string; status: string }[]>`
      select id, recipient, status from email_outbox where id = any(${[ended, waiting]}::uuid[]) order by recipient`;
    expect(Object.fromEntries(rows.map((r) => [r.id, [r.status, r.recipient]]))).toEqual({
      [ended]: ["sent", `deleted-${endedAccount}@deleted.invalid`],
      [waiting]: ["queued", waitingTo],
    });
    expect((await tick()).scrubbed, "the empty case: the next tick has nothing left to scrub").toBe(0);
  });

  it("a backlog beyond PURGE_BATCH drains PURGE_BATCH a tick (the production tick is bounded too)", async () => {
    const before = await remaining();
    const total = PURGE_BATCH + 2;
    await sql`
      insert into email_outbox (id, kind, ref_type, ref_id, org_id, recipient, subject, transactional, status, expires_at, created_at, status_at)
      select gen_random_uuid(), 'magic_link', 'login', ${`${RUN}-b-`}::text || n, null, 'b' || n || '@x.test', 's', true, 'expired',
             now() + interval '1 hour', now() - make_interval(days => ${RETENTION_DAYS + 5}), now()
        from generate_series(1, ${total}::int) as n`;
    expect((await tick()).purged).toBe(PURGE_BATCH);
    expect((await tick()).purged).toBe(2);
    expect((await tick()).purged).toBe(0);
    expect(await remaining(), "the rows that were not old are untouched").toEqual(before);
  });
});
