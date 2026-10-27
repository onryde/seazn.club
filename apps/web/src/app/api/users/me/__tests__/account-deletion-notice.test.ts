// DELETE /api/users/me tells the person their account is gone (phase 3 wave 3, kind `account_deletion`): the notice is queued on the email
// outbox in the deletion's own transaction (a literal address, no organisation, in the account's language) and its first attempt is
// deferred until after the commit. The address it carries is the deleted person's, so once the row has ended (sent, or ended any other
// way) the worker replaces it with the deleted account's placeholder (P-W3-6, Review Focus 1); while the row may still be sent it keeps
// the address, or it could never be delivered.
//
// Driven through the REAL DELETE handler on a real Postgres, as account-deletion-sweep.test.ts drives it: only Stripe, the session half of
// auth, the rate limiter, `next/headers` and the outbox's transport (the one network seam: captured, never sent) are stand-ins. The
// expected subject is read from the dictionary on disk; the expected placeholder is the deleted user's own `users.email`, read from the
// database, so the scrub and the account's anonymisation are bound through the data and not through the function that builds either.
//
// Sport: not applicable. Account deletion is sport-agnostic.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

vi.mock("@/lib/stripe", () => ({ getStripe: () => ({ subscriptions: { cancel: vi.fn(async () => ({})) } }) }));
const authState = vi.hoisted(() => ({ user: null as { id: string; email: string; locale: string | null } | null }));
vi.mock("@/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth")>()),
  requireUser: vi.fn(async () => authState.user),
  destroySession: vi.fn(async () => {}),
  invalidateUser: vi.fn(async () => {}),
  invalidateUserOrgs: vi.fn(async () => {}),
}));
vi.mock("@/lib/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rate-limit")>()),
  rateLimit: vi.fn(async () => {}),
}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": "203.0.113.80" }),
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
}));
// The outbox's one network seam. The rows, the claim, the render and the tick are the real ones.
const transport = vi.hoisted(() => ({ deliver: vi.fn() }));
vi.mock("@/server/email-outbox/transport", () => ({ deliver: transport.deliver }));

import { sql } from "@/lib/db";
import { DELETE } from "@/app/api/users/me/route";
import { RETRYABLE_STATUSES, SCRUBBED_WHEN_ENDED, enqueueEmail, type OutboxKind } from "@/server/email-outbox";
import { runOutboxTick } from "@/server/email-outbox/worker";
import { scrubEndedStatement } from "@/server/email-outbox/status";
import { dictionarySubject } from "@/server/email-outbox/__tests__/_kind-harness";
import { stubOutboxEnv } from "@/server/usecases/__tests__/_invite-mail";

const HAS_DB = !!process.env.DATABASE_URL;
const RUN = `adn-${randomUUID().slice(0, 8)}`;
const MIN = 60_000;

type Delivered = { to: string; subject: string; idempotencyKey: string };
type NoticeRow = {
  id: string;
  kind: string;
  ref_type: string;
  ref_id: string;
  dedupe_key: string | null;
  org_id: string | null;
  recipient: string;
  recipient_user_id: string | null;
  transactional: boolean;
  subject: string;
  status: string;
  last_error: string | null;
  status_at: Date;
};

const made = { users: [] as string[], rows: [] as string[] };
const address = (tag: string): string => `${RUN}-${tag}-${randomUUID().slice(0, 6)}@del.test`;
const del = () =>
  DELETE(new Request("http://test.local/api/users/me", { method: "DELETE", body: JSON.stringify({ confirm: "DELETE" }) }));
const columns = () =>
  sql`id, kind, ref_type, ref_id, dedupe_key, org_id, recipient, recipient_user_id, transactional, subject, status, last_error, status_at`;
const noticesOf = (userId: string) =>
  sql<NoticeRow[]>`select ${columns()} from email_outbox where kind = 'account_deletion' and ref_type = 'user' and ref_id = ${userId} order by created_at, id`;
const rowOf = async (id: string): Promise<NoticeRow> => (await sql<NoticeRow[]>`select ${columns()} from email_outbox where id = ${id}`)[0]!;
const emailOf = async (userId: string): Promise<string> => (await sql<{ email: string }[]>`select email from users where id = ${userId}`)[0]!.email;
const callsFor = (rowId: string): Delivered[] =>
  transport.deliver.mock.calls.map((c) => c[0] as Delivered).filter((m) => m.idempotencyKey === `email-outbox/${rowId}`);
const tick = (id: string) => runOutboxTick({ onlyIds: [id], sleep: async () => undefined });

async function seedUser(tag: string, locale: string | null): Promise<{ id: string; email: string }> {
  const email = address(tag);
  const [{ id }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified, locale) values (${email}, ${tag}, true, ${locale}) returning id`;
  made.users.push(id);
  return { id, email };
}

/** A row through the real writer on a transaction of the pool, as an account-mail producer writes it: no organisation, no account id. */
async function seedRow(kind: OutboxKind, userId: string, to: string): Promise<string> {
  const id = await sql.begin((tx) =>
    enqueueEmail(tx, {
      kind,
      refType: "user",
      refId: userId,
      orgId: null,
      to,
      subject: "A subject",
      html: "<p>x</p>",
      text: "x",
      transactional: true,
      expiresAt: new Date(Date.now() + 60 * MIN),
    }),
  );
  made.rows.push(id);
  return id;
}

/** The account (in `locale`) deletes itself through the real route; the notice's deferred first attempt is waited out. Returns the
 *  account, the address it had before the deletion, and the notice's row. */
async function deleteAndWaitForNotice(locale: string): Promise<{ userId: string; address: string; notice: NoticeRow }> {
  const { id: userId } = await seedUser("leaver", locale);
  // What the session hands the route: the account's row as it stands before the deletion.
  const [before] = await sql<{ id: string; email: string; locale: string | null }[]>`select id, email, locale from users where id = ${userId}`;
  authState.user = before!;
  const addressBefore = before!.email;

  expect((await del()).status).toBe(200);
  const rows = await noticesOf(userId);
  expect(rows, "one notice row for the account").toHaveLength(1);
  const id = rows[0]!.id;
  // The first attempt is deferred (outside a request scope it runs inline, fire-and-forget), so the test waits for it.
  await vi.waitFor(
    async () => {
      const r = await rowOf(id);
      if ((RETRYABLE_STATUSES as readonly string[]).includes(r.status)) throw new Error(`the notice is still ${r.status}`);
    },
    { timeout: 10_000, interval: 50 },
  );
  return { userId, address: addressBefore, notice: await rowOf(id) };
}

beforeEach(() => {
  vi.clearAllMocks();
  authState.user = null;
  stubOutboxEnv();
  transport.deliver.mockReset().mockImplementation(async () => ({ ok: true, providerId: `re_${RUN}_${randomUUID()}` }));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
afterAll(async () => {
  if (HAS_DB) {
    await sql`delete from email_outbox where id = any(${made.rows}::uuid[]) or (ref_type = 'user' and ref_id = any(${made.users}::text[]))`;
    await sql`delete from users where id = any(${made.users}::uuid[])`;
    await sql.end({ timeout: 2 }).catch(() => undefined);
  }
});

describe.skipIf(!HAS_DB)("deleting an account queues the deletion notice on the outbox, and scrubs its address once it has gone (DB)", () => {
  it("deleting an account queues one notice to its address, in its language, and sends it", async () => {
    // The Dutch subject is not the English one, so a route that dropped the account's language would be seen.
    const subject = dictionarySubject("nl", "accountDeletion.subject", {});
    expect(subject).not.toBe(dictionarySubject("en", "accountDeletion.subject", {}));

    const { userId, address: was, notice } = await deleteAndWaitForNotice("nl");

    expect(notice).toMatchObject({
      kind: "account_deletion",
      ref_type: "user",
      ref_id: userId,
      dedupe_key: userId,
      org_id: null,
      recipient_user_id: null,
      transactional: true,
      status: "sent",
      subject,
    });
    expect(notice.last_error, "the deletion's own sweep did not end it").toBeNull();
    const calls = callsFor(notice.id);
    expect(calls, "one transport call, under the row's own key").toHaveLength(1);
    expect(calls[0]!.to, "to the address the account had before the deletion").toBe(was);
    expect(calls[0]!.subject).toBe(subject);
  });

  it("once the notice's row ends, it keeps no address", async () => {
    const { userId, address: was, notice } = await deleteAndWaitForNotice("nl");
    expect(notice.status, "premise: the notice has gone").toBe("sent");
    expect(notice.recipient, "premise: until a tick, the row still holds the address it was sent to").toBe(was);

    const report = await tick(notice.id);
    const placeholder = await emailOf(userId);
    expect(placeholder, "premise: the account's own address was replaced by the deletion").not.toBe(was);
    const scrubbed = await rowOf(notice.id);
    expect(scrubbed.recipient, "the row holds the deleted account's placeholder, not the address").toBe(placeholder);
    expect(scrubbed.status, "and only the address changed").toBe("sent");
    expect(scrubbed.status_at.getTime()).toBe(notice.status_at.getTime());
    expect(report.scrubbed, "the tick reports the one row it scrubbed").toBe(1);

    const again = await tick(notice.id);
    expect(again.scrubbed, "the sequence: a second tick has nothing left to scrub").toBe(0);
    expect(await rowOf(notice.id), "and changes nothing").toEqual(scrubbed);
  });

  it("a notice still waiting to be sent keeps its address", async () => {
    const { id: userId, email } = await seedUser("waiting", null);
    const id = await seedRow("account_deletion", userId, email);
    await sql`update email_outbox set next_attempt_at = now() + interval '1 hour' where id = ${id}`;
    const before = await rowOf(id);
    expect(before.status, "premise: the notice is queued").toBe("queued");

    const report = await tick(id);
    expect(report.scrubbed).toBe(0);
    const after = await rowOf(id);
    expect(after.status, "premise: the tick did not send it").toBe("queued");
    expect(after.recipient, "a row that can still be sent keeps the address it must be sent to").toBe(email);
  });

  it("a scrub touches no other kind", async () => {
    const { id: userId, email } = await seedUser("other-kind", null);
    const id = await seedRow("email_verification", userId, email);
    await sql`update email_outbox set status = 'sent', body_sealed = null, attempts = 1 where id = ${id}`;
    expect((await rowOf(id)).ref_type, "premise: the same ref type as the notice").toBe("user");

    const report = await tick(id);
    expect(report.scrubbed).toBe(0);
    expect((await rowOf(id)).recipient, "an ended row of another kind keeps its address").toBe(email);
  });

  it("the scrub reads only the rows it may scrub, through their own index, never the whole table", async () => {
    // Step 7a runs every tick, so its cost must not grow with the table. The statement explained is the step's own, unscoped as the worker
    // runs it in production (`scrubEndedStatement`, so the pin cannot drift from it), in both plans it can get: with its values bound, as
    // postgres.js first sends it, and GENERIC, planned without any value, as a named prepared statement may run it after a few calls
    // (`explain (generic_plan)` on the very text postgres.js sends, read back with `describe`). Sequential scans are off so the answer does
    // not depend on how many rows the test table holds (account-deletion-sweep.test.ts's rule). That alone proves nothing here: without the
    // partial index the planner still finds an index (the ref index, over every sign-in row), so the pin names the partial index.
    type PlanRow = { "QUERY PLAN": string };
    const lines = (rows: readonly PlanRow[]) => rows.map((r) => r["QUERY PLAN"]).join("\n");
    const { bound, generic, predicate } = await sql.begin(async (tx) => {
      await tx`set local enable_seqscan = off`;
      const bound = lines(await tx<PlanRow[]>`explain ${scrubEndedStatement(tx)}`);
      const sent = await scrubEndedStatement(tx).describe();
      const generic = lines(await tx.unsafe<PlanRow[]>(`explain (generic_plan) ${sent.string}`));
      const [index] = await tx<{ predicate: string }[]>`
        select pg_get_expr(indpred, indrelid) as predicate from pg_index where indexrelid = to_regclass('email_outbox_scrub_idx')`;
      return { bound, generic, predicate: index?.predicate ?? "" };
    });
    for (const [name, plan] of [["bound", bound], ["generic", generic]] as const) {
      expect(plan, `${name}: the rows to scrub come from the scrub's own partial index`).toMatch(
        /Index Scan using email_outbox_scrub_idx|Bitmap Index Scan on email_outbox_scrub_idx/,
      );
      expect(plan, name).not.toMatch(/Seq Scan on email_outbox/);
    }
    // SCRUBBED_WHEN_ENDED stays the authority: the index's own WHERE (read back from the catalogue) names every kind of it.
    let kinds = 0;
    for (const kind of SCRUBBED_WHEN_ENDED) {
      expect(predicate, `the index covers ${kind}`).toContain(`'${kind}'::text`);
      kinds++;
    }
    expect(kinds, "anti-vacuity: the list named at least one kind").toBeGreaterThan(0);
  });
});
