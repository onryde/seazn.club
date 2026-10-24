// dispatchNow when the database role cannot write the outbox (see role-check.test.ts). The role check is replaced here so
// the pooled connection (a superuser locally and in CI) can play a role that is not. What must hold: the call FAILS CLOSED
// (nothing is claimed, nothing is sent, every id is `deferred` and the rows are untouched), and it is LOUD on every call,
// not once per process. A control with the check answering true proves the mock is not what stops the send.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { sql, statementCount } from "@/lib/db";

const logMock = vi.hoisted(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }));
vi.mock("@/server/logger", () => ({ log: logMock }));
const deliverMock = vi.hoisted(() => vi.fn());
vi.mock("@/server/email-outbox/transport", () => ({ deliver: deliverMock }));
const roleMock = vi.hoisted(() => ({ ok: vi.fn<() => Promise<boolean>>() }));
vi.mock("@/server/email-outbox/role-check", () => ({ outboxRoleOk: roleMock.ok, resetOutboxRoleCheck: () => {} }));

import { dispatchNow } from "../attempt";
import { enqueueEmail } from "../enqueue";

const HAS_DB = !!process.env.DATABASE_URL;
const RUN = `role-${randomUUID().slice(0, 8)}`;

describe.skipIf(!HAS_DB)("dispatchNow without outbox write access", () => {
  async function queue(): Promise<string> {
    return enqueueEmail(sql, {
      kind: "magic_link", refType: "login", refId: `${RUN}-${randomUUID()}`, orgId: null,
      to: `${randomUUID()}@x.test`, subject: "s", html: "<p>h</p>", text: "t", transactional: true,
      expiresAt: new Date(Date.now() + 15 * 60_000),
    });
  }
  const row = async (id: string) => (await sql<{ status: string; attempts: number; body_sealed: Buffer | null; lease_until: Date | null }[]>`
    select status, attempts, body_sealed, lease_until from email_outbox where id = ${id}`)[0]!;

  beforeAll(async () => {
    await sql`select 1`;
  });
  afterAll(async () => {
    await sql`delete from email_outbox where ref_id like ${`${RUN}-%`}`;
    await sql.end({ timeout: 2 }).catch(() => undefined);
  });
  beforeEach(() => {
    vi.stubEnv("EMAIL_OUTBOX_KEK", "ab".repeat(32));
    vi.stubEnv("RESEND_API_KEY", "re_test");
    logMock.error.mockClear();
    deliverMock.mockReset();
    deliverMock.mockImplementation(async (m: { tags: Record<string, string> }) => ({ ok: true, providerId: `re_${m.tags.outbox}_${RUN}` }));
    roleMock.ok.mockReset();
  });
  afterEach(() => vi.unstubAllEnvs());

  it("a role that cannot write: every id is deferred, nothing is claimed or sent, and EVERY call logs an error", async () => {
    roleMock.ok.mockResolvedValue(false);
    const ids = [await queue(), await queue()];
    for (let call = 1; call <= 3; call++) {
      const out = await dispatchNow(ids);
      expect([...out.entries()], `call ${call}`).toEqual(ids.map((i) => [i, "deferred"]));
      expect(logMock.error, `call ${call}`).toHaveBeenCalledTimes(call);
    }
    expect(deliverMock).not.toHaveBeenCalled();
    for (const id of ids) {
      const r = await row(id);
      expect([r.status, r.attempts, r.lease_until], id).toEqual(["queued", 0, null]);
      expect(r.body_sealed).not.toBeNull();
    }
    expect(String(logMock.error.mock.calls[0]![1])).toMatch(/role/i);
  });

  it("failing closed touches nothing: an already-expired row stays queued (not expired by us) and no statement is issued at all", async () => {
    roleMock.ok.mockResolvedValue(false);
    const late = await enqueueEmail(sql, {
      kind: "magic_link", refType: "login", refId: `${RUN}-${randomUUID()}`, orgId: null,
      to: `${randomUUID()}@x.test`, subject: "s", html: "<p>h</p>", text: "t", transactional: true,
      expiresAt: new Date(Date.now() - 60_000),
    });
    const before = statementCount();
    const out = await dispatchNow([late]);
    expect(statementCount() - before).toBe(0);
    expect(out.get(late)).toBe("deferred");
    expect((await row(late)).status).toBe("queued");
    // The control: once the role may write, the same row is ended expired by the next call.
    roleMock.ok.mockResolvedValue(true);
    expect((await dispatchNow([late])).get(late)).toBe("expired");
    expect((await row(late)).status).toBe("expired");
  });

  it("the control: with the check answering true the same rows are sent, so the mock is not what stops them", async () => {
    roleMock.ok.mockResolvedValue(true);
    const id = await queue();
    expect((await dispatchNow([id])).get(id)).toBe("sent");
    expect(deliverMock).toHaveBeenCalledTimes(1);
    expect(logMock.error).not.toHaveBeenCalled();
  });

  it("a role check that itself fails defers the ids and logs, and does not throw", async () => {
    roleMock.ok.mockRejectedValue(new Error("probe failed"));
    const id = await queue();
    const out = await dispatchNow([id]);
    expect(out.get(id)).toBe("deferred");
    expect(logMock.error).toHaveBeenCalledTimes(1);
    expect((await row(id)).status).toBe("queued");
  });

  it("an empty or all-malformed call does not ask the role at all (it must stay free of statements)", async () => {
    roleMock.ok.mockResolvedValue(true);
    await dispatchNow([]);
    await dispatchNow(["not-a-uuid"]);
    expect(roleMock.ok).not.toHaveBeenCalled();
  });
});
