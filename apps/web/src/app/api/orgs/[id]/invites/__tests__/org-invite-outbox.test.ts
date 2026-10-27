// POST /api/orgs/{id}/invites queues an EMAIL invite on the email outbox (phase 3 wave 3, kind `org_invite`). The invite and the row that
// carries its link are one transaction on the pool, the row's ref is the invite (each invite is its own document, P-W3-2), the language
// is the organisation's default (the invitee has no account the org may follow), and the first attempt is made in the request after
// commit: the organiser reads `email_sent` from the answer. A link invite (no address) is unchanged and queues nothing.
//
// Driven through the REAL route and the real session (the org owner's session in the cookie jar, through the real requireOrgRole).
// Stand-ins: the outbox's transport (the one network seam: captured, never sent) and `next/headers`. Expected values come from the
// dictionary on disk (`dictionarySubject`) and from the invite's own row (`org_invites`), never from the route's answer.
//
// Sport: not applicable (a team invite does not vary by sport).
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

const jar = vi.hoisted(() => ({ values: new Map<string, string>() }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": "203.0.113.61" }),
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
import { seedOrg } from "@/server/usecases/__tests__/_registration-fixtures";
import { stubOutboxEnv } from "@/server/usecases/__tests__/_invite-mail";
import { dictionarySubject } from "@/server/email-outbox/__tests__/_kind-harness";
import { runOutboxTick } from "@/server/email-outbox/worker";
import { POST as createInvite } from "../route";

const HAS_DB = !!process.env.DATABASE_URL;
const RUN = `oi-${randomUUID().slice(0, 8)}`;
const ORIGIN = "https://team.test";
const orgs: string[] = [];

type Delivered = { to: string; subject: string; html: string; text: string; idempotencyKey: string };
type InviteRow = {
  id: string; kind: string; ref_type: string; ref_id: string; org_id: string | null; recipient: string;
  recipient_user_id: string | null; transactional: boolean; subject: string; status: string; attempts: number;
};
type Answer = { status: number; data: Record<string, unknown> & { id: string } };

const address = (): string => `${RUN}-${randomUUID().slice(0, 8)}@x.test`;

/** An organisation whose public default language is `locale`, and its owner. */
async function org(locale: string): Promise<{ orgId: string; ownerId: string; name: string }> {
  const { orgId, ownerId } = await seedOrg("community");
  orgs.push(orgId);
  const [o] = await sql<{ name: string }[]>`update organizations set default_locale = ${locale} where id = ${orgId} returning name`;
  return { orgId, ownerId, name: o!.name };
}

/** The owner creates an invite through the real route, signed in through the real session. */
async function invite(orgId: string, ownerId: string, body: Record<string, unknown>): Promise<Answer> {
  jar.values.clear();
  await createSession(ownerId);
  const res = await createInvite(
    new Request(`${ORIGIN}/api/orgs/${orgId}/invites`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: orgId }) },
  );
  jar.values.clear();
  const json = (await res.json()) as { data: Answer["data"] };
  return { status: res.status, data: json.data };
}

/** The org's invite rows, oldest first. */
const rowsOf = (orgId: string) =>
  sql<InviteRow[]>`
    select id, kind, ref_type, ref_id, org_id, recipient, recipient_user_id, transactional, subject, status, attempts
      from email_outbox where kind = 'org_invite' and org_id = ${orgId}
     order by created_at, id`;
/** The invite's own token, from its row. */
const tokenOf = async (inviteId: string): Promise<string> =>
  (await sql<{ token: string }[]>`select token from org_invites where id = ${inviteId}`)[0]!.token;
/** What the transport was handed under this row's own key. */
const callsFor = (rowId: string): Delivered[] =>
  transport.deliver.mock.calls.map((c) => c[0] as Delivered).filter((m) => m.idempotencyKey === `email-outbox/${rowId}`);

const ok = async () => ({ ok: true, providerId: `re_${RUN}_${randomUUID()}` });
/** The provider is briefly down: the attempt is a retryable failure, so the row stays queued for the worker. */
const unavailable = async () => ({ ok: false, reason: "http", status: 503, errorName: "service_unavailable", detail: "later" });

beforeEach(() => {
  transport.deliver.mockReset().mockImplementation(ok);
  stubOutboxEnv();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
afterAll(async () => {
  if (!HAS_DB) return;
  await sql`delete from email_outbox where kind = 'org_invite' and org_id = any(${orgs}::uuid[])`;
  await sql`delete from organizations where id = any(${orgs}::uuid[])`; // org_invites cascade
});

describe.skipIf(!HAS_DB)("POST /api/orgs/{id}/invites queues the email invite on the outbox (DB)", () => {
  it("an email invite queues one invite in the org's language and reports email_sent", async () => {
    const o = await org("fr");
    const email = address();

    const res = await invite(o.orgId, o.ownerId, { role: "viewer", email });

    expect(res.status).toBe(200);
    expect(res.data.email_sent, "the request's own attempt went out").toBe(true);
    const rows = await rowsOf(o.orgId);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row).toMatchObject({
      kind: "org_invite",
      ref_type: "org_invite",
      ref_id: res.data.id,
      org_id: o.orgId,
      recipient: email,
      recipient_user_id: null,
      transactional: false,
      status: "sent",
    });
    expect(row.subject).toBe(dictionarySubject("fr", "invite.subject", { orgName: o.name }));
    const calls = callsFor(row.id);
    expect(calls, "one transport call, under the row's own key").toHaveLength(1);
    expect(calls[0]!.text, "the mail carries the invite's own join link").toContain(`/join/${await tokenOf(res.data.id)}`);
    // The French case can tell the org's language from English only while the dictionaries differ.
    expect(dictionarySubject("fr", "invite.subject", { orgName: o.name })).not.toBe(dictionarySubject("en", "invite.subject", { orgName: o.name }));
  });

  it("email_sent is false while the outbox retries, and the worker sends it later", async () => {
    // The state the reworded notice (`settings.team.inviteEmail.notSent`) describes: not gone yet, and not given up on.
    const o = await org("fr");
    transport.deliver.mockImplementationOnce(unavailable);

    const res = await invite(o.orgId, o.ownerId, { role: "admin", email: address() });

    expect(res.status).toBe(200);
    expect(res.data.email_sent).toBe(false);
    const [row] = await rowsOf(o.orgId);
    expect(row, "the row waits for the worker").toMatchObject({ status: "queued", attempts: 1 });

    await sql`update email_outbox set next_attempt_at = now() - interval '1 second' where id = ${row!.id}`;
    await runOutboxTick({ onlyIds: [row!.id], sleep: async () => undefined });

    const [after] = await rowsOf(o.orgId);
    expect(after).toMatchObject({ id: row!.id, status: "sent", attempts: 2 });
    expect(callsFor(row!.id), "the request's attempt and the worker's").toHaveLength(2);
  });

  it("two email invites to one address are two invites and two emails", async () => {
    // Each email invite is its own single-use invite, and both links work (P-W3-2): the ref is the invite, so the replace rule leaves
    // both rows alone.
    const o = await org("fr");
    const email = address();

    const first = await invite(o.orgId, o.ownerId, { role: "viewer", email });
    const second = await invite(o.orgId, o.ownerId, { role: "viewer", email });

    expect(first.data.id).not.toBe(second.data.id);
    const rows = await rowsOf(o.orgId);
    expect(rows.map((r) => [r.ref_id, r.status])).toEqual([
      [first.data.id, "sent"],
      [second.data.id, "sent"],
    ]);
  });

  it("empty: a link invite queues nothing", async () => {
    const o = await org("fr");

    const res = await invite(o.orgId, o.ownerId, { role: "viewer", max_uses: 5 });

    expect(res.status).toBe(200);
    expect(res.data.email, "premise: a shareable link, no address").toBeNull();
    expect(res.data).not.toHaveProperty("email_sent");
    expect(await rowsOf(o.orgId), "no row").toEqual([]);
    expect(transport.deliver, "nothing sent").not.toHaveBeenCalled();
  });
});
