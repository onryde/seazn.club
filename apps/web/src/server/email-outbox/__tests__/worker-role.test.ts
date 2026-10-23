// The worker when the database role cannot write the outbox (see role-check.test.ts). R9/R10: the worker asks the role
// check on EVERY tick, and when the answer is no it logs an error and skips the tick - it must not claim, send, expire or
// end anything, because a role that cannot UPDATE would "claim" zero rows and look like an empty queue, quietly, for ever.
// The report says so (`failed: 1`), so the cron Worker's failure counter and Sentry hear about it.
//
// The role check is replaced here so the pooled connection (a superuser locally and in CI) can play a role that is not.
// Most of this file needs no database at all: a tick that is skipped issues no statement.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { sql, statementCount } from "@/lib/db";

const logMock = vi.hoisted(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }));
vi.mock("@/server/logger", () => ({ log: logMock }));
const deliverMock = vi.hoisted(() => vi.fn());
vi.mock("@/server/email-outbox/transport", () => ({ deliver: deliverMock }));
const roleMock = vi.hoisted(() => ({ ok: vi.fn<() => Promise<boolean>>() }));
vi.mock("@/server/email-outbox/role-check", () => ({ outboxRoleOk: roleMock.ok, resetOutboxRoleCheck: () => {} }));

import { KIND_HOOKS } from "../hooks";
import { enqueueEmail } from "../enqueue";
import { runOutboxTick, type OutboxTickReport } from "../worker";

const HAS_DB = !!process.env.DATABASE_URL;
const RUN = `t4role-${randomUUID().slice(0, 8)}`;
const ZERO: OutboxTickReport = { claimed: 0, sent: 0, retried: 0, dead: 0, suppressed: 0, expired: 0, failed: 0, deferred: 0 };
const sleep = vi.fn(async () => {});

describe("a tick when the role cannot write the outbox", () => {
  const finder = vi.fn(async () => []);
  const saved = { ...KIND_HOOKS };
  beforeEach(() => {
    logMock.error.mockClear();
    deliverMock.mockReset();
    roleMock.ok.mockReset();
    sleep.mockClear();
    finder.mockClear();
    KIND_HOOKS.chess_invite = { onEndedBadly: async () => {}, findUnapplied: finder };
  });
  afterEach(() => {
    Object.assign(KIND_HOOKS, saved);
  });

  it("is skipped whole: no statement, no send, no wait, no re-drive, an error logged naming the role, and the report says failed 1", async () => {
    roleMock.ok.mockResolvedValue(false);
    const before = statementCount();
    const report = await runOutboxTick({ sleep });
    expect(report).toEqual({ ...ZERO, failed: 1 });
    expect(statementCount() - before, "statements issued").toBe(0);
    expect(deliverMock).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
    expect(finder, "the re-drive is part of the tick, so it is skipped too").not.toHaveBeenCalled();
    expect(logMock.error).toHaveBeenCalledTimes(1);
    expect(String(logMock.error.mock.calls[0]![1])).toMatch(/role/i);
  });

  it("asks the role check on EVERY tick and logs on every skipped one (a remembered answer would hide a fixable outage)", async () => {
    roleMock.ok.mockResolvedValue(false);
    for (let call = 1; call <= 3; call++) {
      expect(await runOutboxTick({ sleep }), `call ${call}`).toEqual({ ...ZERO, failed: 1 });
      expect(roleMock.ok).toHaveBeenCalledTimes(call);
      expect(logMock.error).toHaveBeenCalledTimes(call);
    }
  });

  it("a probe that fails is not swallowed into a healthy-looking report: the tick rejects and nothing else runs", async () => {
    roleMock.ok.mockRejectedValue(new Error("catalogue unreachable"));
    const before = statementCount();
    await expect(runOutboxTick({ sleep })).rejects.toThrow("catalogue unreachable");
    expect(statementCount() - before).toBe(0);
    expect(deliverMock).not.toHaveBeenCalled();
  });
});

describe.skipIf(!HAS_DB)("a tick that follows a role fix (DB)", () => {
  async function queue(over: { expiresAt?: Date } = {}): Promise<string> {
    return enqueueEmail(sql, {
      kind: "magic_link", refType: "login", refId: `${RUN}-${randomUUID()}`, orgId: null,
      to: `${randomUUID()}@x.test`, subject: "s", html: "<p>h</p>", text: "t", transactional: true,
      expiresAt: new Date(Date.now() + 15 * 60_000), ...over,
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
    sleep.mockClear();
  });
  afterEach(() => vi.unstubAllEnvs());

  it("while the role cannot write, due and expired rows are left exactly as they were; the first tick after the fix takes them (no restart)", async () => {
    const due = await queue();
    const late = await queue();
    await sql`update email_outbox set expires_at = now() - interval '1 minute' where id = ${late}`;

    roleMock.ok.mockResolvedValue(false);
    expect(await runOutboxTick({ onlyIds: [due, late], sleep })).toEqual({ ...ZERO, failed: 1 });
    const stillDue = await row(due);
    const stillLate = await row(late);
    expect([stillDue.status, stillDue.attempts, stillDue.lease_until]).toEqual(["queued", 0, null]);
    expect(stillDue.body_sealed).not.toBeNull();
    expect([stillLate.status, stillLate.attempts], "an expired row is not even expired by a tick that may not write").toEqual(["queued", 0]);
    expect(deliverMock).not.toHaveBeenCalled();

    roleMock.ok.mockResolvedValue(true);
    expect(await runOutboxTick({ onlyIds: [due, late], sleep })).toEqual({ ...ZERO, claimed: 1, sent: 1, expired: 1 });
    expect((await row(due)).status).toBe("sent");
    expect((await row(late)).status).toBe("expired");
    expect(roleMock.ok).toHaveBeenCalledTimes(2);
  });

  it("the control: with the role fine on three ticks in a row, the check is still asked three times and the tick runs each time", async () => {
    roleMock.ok.mockResolvedValue(true);
    for (let call = 1; call <= 3; call++) {
      const id = await queue();
      expect(await runOutboxTick({ onlyIds: [id], sleep }), `call ${call}`).toEqual({ ...ZERO, claimed: 1, sent: 1 });
      expect(roleMock.ok).toHaveBeenCalledTimes(call);
    }
    expect(logMock.error).not.toHaveBeenCalled();
  });
});
