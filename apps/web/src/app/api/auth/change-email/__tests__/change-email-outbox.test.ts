// POST /api/auth/change-email queues the confirmation link to the NEW address on the email outbox (phase 3 wave 3, kind
// `email_change_confirmation`). The request's delete, its insert, the end of an older request's still-queued confirmation, and the new
// row are one transaction on the pool (account mail has no organisation). The row's ref is the account, the language is the account's,
// and the first attempt is made in the request after commit: the person is waiting for the link.
//
// Driven through the REAL route and the real session (a seeded account's session in the cookie jar, through the real requireUser).
// Stand-ins: the outbox's transport (the one network seam: captured, never sent) and `next/headers`. Expected values come from the
// dictionary on disk (`dictionarySubject`) and from the request's own row (`email_change_requests`), never from the route's answer.
//
// Sport: not applicable (account mail does not vary by sport).
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

const jar = vi.hoisted(() => ({ values: new Map<string, string>() }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": "203.0.113.52" }),
  cookies: async () => ({
    get: (name: string) => (jar.values.has(name) ? { name, value: jar.values.get(name)! } : undefined),
    set: (name: string, value: string) => void jar.values.set(name, value),
    delete: (name: string) => void jar.values.delete(name),
  }),
}));
// The outbox's one network seam. The rows, the claim and the render are the real ones.
const transport = vi.hoisted(() => ({ deliver: vi.fn() }));
vi.mock("@/server/email-outbox/transport", () => ({ deliver: transport.deliver }));

import { sql } from "@/lib/db";
import { createSession } from "@/lib/auth";
import { makeUser } from "@/server/usecases/__tests__/_registration-fixtures";
import { stubOutboxEnv } from "@/server/usecases/__tests__/_invite-mail";
import { dictionarySubject } from "@/server/email-outbox/__tests__/_kind-harness";
import { POST as changeEmail } from "../route";

const HAS_DB = !!process.env.DATABASE_URL;
const RUN = `ce-${randomUUID().slice(0, 8)}`;
const ORIGIN = "https://account.test";
const made: string[] = [];

type Delivered = { to: string; subject: string; html: string; text: string; idempotencyKey: string };
type MailRow = {
  id: string; kind: string; ref_type: string; ref_id: string; org_id: string | null; recipient: string;
  recipient_user_id: string | null; transactional: boolean; subject: string; status: string; attempts: number;
  last_error: string | null; cleared: boolean;
};

const address = (): string => `${RUN}-${randomUUID().slice(0, 8)}@x.test`;

/** An account (`makeUser`'s), in `locale`. */
async function account(locale: string | null): Promise<{ id: string; email: string }> {
  const id = await makeUser("change-email");
  made.push(id);
  const [u] = await sql<{ email: string }[]>`update users set locale = ${locale} where id = ${id} returning email`;
  return { id, email: u!.email };
}

/** The account asks to move to `newEmail`, signed in through the real session. */
async function requestChange(userId: string, newEmail: string): Promise<{ status: number; body: { ok: boolean; error?: string } }> {
  jar.values.clear();
  await createSession(userId);
  const res = await changeEmail(
    new Request(`${ORIGIN}/api/auth/change-email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ new_email: newEmail }),
    }),
  );
  jar.values.clear();
  return { status: res.status, body: (await res.json()) as { ok: boolean; error?: string } };
}

/** The account's rows of one kind, oldest first. */
const rowsOf = (kind: string, userId: string) =>
  sql<MailRow[]>`
    select id, kind, ref_type, ref_id, org_id, recipient, recipient_user_id, transactional, subject, status, attempts, last_error,
           body_sealed is null as cleared
      from email_outbox where kind = ${kind} and ref_type = 'user' and ref_id = ${userId}
     order by created_at, id`;
/** The account's pending change requests. */
const requestsOf = (userId: string) =>
  sql<{ id: string; new_email: string; token: string }[]>`
    select id, new_email, token from email_change_requests where user_id = ${userId} and not confirmed order by created_at, id`;
/** What the transport was handed under this row's own key. */
const callsFor = (rowId: string): Delivered[] =>
  transport.deliver.mock.calls.map((c) => c[0] as Delivered).filter((m) => m.idempotencyKey === `email-outbox/${rowId}`);

const ok = async () => ({ ok: true, providerId: `re_${RUN}_${randomUUID()}` });
/** The provider is briefly down: the attempt is a retryable failure, so the row stays queued for the worker. */
const unavailable = async () => ({ ok: false, reason: "http", status: 503, errorName: "service_unavailable", detail: "later" });

beforeEach(() => {
  jar.values.clear();
  transport.deliver.mockReset().mockImplementation(ok);
  stubOutboxEnv();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
afterAll(async () => {
  if (!HAS_DB || made.length === 0) return;
  await sql`delete from email_outbox where ref_type = 'user' and ref_id = any(${made}::text[])`;
  await sql`delete from users where id = any(${made})`; // email_change_requests cascade
});

describe.skipIf(!HAS_DB)("POST /api/auth/change-email queues the confirmation on the outbox (DB)", () => {
  it("a change request queues one confirmation to the new address, in the account's language, and sends it", async () => {
    const user = await account("es");
    const newEmail = address();
    // The Spanish subject is not the English one, so a route that dropped the account's language would be seen.
    expect(dictionarySubject("es", "emailChangeConfirm.subject", {})).not.toBe(dictionarySubject("en", "emailChangeConfirm.subject", {}));

    const res = await requestChange(user.id, newEmail);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const rows = await rowsOf("email_change_confirmation", user.id);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row).toMatchObject({
      kind: "email_change_confirmation",
      ref_type: "user",
      ref_id: user.id,
      org_id: null,
      recipient: newEmail,
      recipient_user_id: null,
      transactional: true,
      status: "sent",
      cleared: true,
    });
    expect(row.subject).toBe(dictionarySubject("es", "emailChangeConfirm.subject", {}));
    const calls = callsFor(row.id);
    expect(calls, "one transport call, under the row's own key").toHaveLength(1);
    expect(calls[0]!.to).toBe(newEmail);
    const requests = await requestsOf(user.id);
    expect(requests, "one pending request").toHaveLength(1);
    expect(calls[0]!.text, "the mail carries the request's own token").toContain(`change-email/confirm?token=${requests[0]!.token}`);
  });

  it("a second request to another address ends the first address's queued confirmation", async () => {
    const user = await account("es");
    const first = address();
    const second = address();

    // The provider is down for the first request: its confirmation is attempted once and waits, queued, for the retry worker.
    transport.deliver.mockImplementation(unavailable);
    expect((await requestChange(user.id, first)).status).toBe(200);
    expect(await rowsOf("email_change_confirmation", user.id), "premise: the first confirmation waits for a retry").toMatchObject([
      { recipient: first, status: "queued", attempts: 1 },
    ]);

    transport.deliver.mockImplementation(ok);
    expect((await requestChange(user.id, second)).status).toBe(200);

    const [older, newer, ...rest] = await rowsOf("email_change_confirmation", user.id);
    expect(rest, "two confirmations, no more").toEqual([]);
    // The older one would reach an address the person moved on from, with a token that no longer exists: it is ended, unsent.
    expect(older).toMatchObject({ recipient: first, status: "expired", last_error: "email_change_superseded", cleared: true });
    expect(newer).toMatchObject({ recipient: second, status: "sent" });
    expect(callsFor(older!.id), "the older confirmation reached the provider only on its failed attempt").toHaveLength(1);
    const requests = await requestsOf(user.id);
    expect(requests.map((r) => r.new_email), "one pending request: the second").toEqual([second]);
    expect(callsFor(newer!.id)[0]!.text).toContain(`change-email/confirm?token=${requests[0]!.token}`);
  });

  it("empty: the same address or a taken one queues nothing", async () => {
    const user = await account("es");
    const other = await account(null);

    const same = await requestChange(user.id, user.email.toUpperCase());
    const taken = await requestChange(user.id, other.email);

    expect([same.status, taken.status]).toEqual([400, 409]);
    const [rows] = await sql<{ n: number }[]>`
      select count(*)::int as n from email_outbox
       where kind in ('email_change_confirmation', 'email_change_notice') and ref_type = 'user' and ref_id = ${user.id}`;
    expect(rows!.n, "no row").toBe(0);
    expect(await requestsOf(user.id), "no request").toEqual([]);
    expect(transport.deliver, "nothing sent").not.toHaveBeenCalled();
  });
});
