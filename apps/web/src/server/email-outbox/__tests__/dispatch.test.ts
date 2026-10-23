// enqueueEmail + dispatchNow + attemptClaimed against a real Postgres, with the one network seam
// (@/server/email-outbox/transport) replaced by a vi.fn. Spec: docs/superpowers/specs/2026-10-19-email-outbox-design.md
// ("Sending", "Credentials at rest", "replaced", the 409 split), rulings R1, R5, R8 and the plan's Task 3.
//
// What each group pins:
//  - enqueue: committed <=> queued; the body is sealed; a box that can send mail but cannot seal fails LOUD inside the
//    caller's transaction, while a box that cannot send anyway (no Resend key) may queue a bodiless row;
//  - the first attempt: every result of the spec's table lands on the row the spec says, `last_error` carries only
//    `http <status> <name>` / `network <cause>` (never Resend's raw detail), the key and tags are the row's id;
//  - the sequences the house rules owe: retry then success, replaced then attempt, expiry, a second dispatch on a sent
//    row, an overlapping attempt (one provider message however many attempts), exhaustion after MAX_ATTEMPTS;
//  - the clock: production judges expiry on the REAL time, the injected `now` is only the test seam.
//
// `deliver` never reaches the network. The "provider" below keys its messages by Idempotency-Key, the way Resend does,
// so "one email" is something the test counts rather than assumes.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { randomUUID } from "node:crypto";
import { sql, statementCount, withTenant, type Tx } from "@/lib/db";
import { suppress } from "@/lib/email";

const logMock = vi.hoisted(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }));
vi.mock("@/server/logger", () => ({ log: logMock }));

const deliverMock = vi.hoisted(() => vi.fn());
vi.mock("@/server/email-outbox/transport", () => ({ deliver: deliverMock }));

import { attemptClaimed, dispatchNow, endedRowFor, toClaimedRow, type AttemptOutcome, type ClaimedRecord, type ClaimedRow } from "../attempt";
import {
  ENDED_BADLY_STATUSES,
  LEASE_MS,
  MAX_ATTEMPTS,
  OUTBOX_KINDS,
  RETRY_DELAYS_MS,
  idempotencyKey,
  type OutboxKind,
} from "../constants";
import { enqueueEmail, type OutboxMessage } from "../enqueue";
import { KIND_HOOKS, type EndedRow } from "../hooks";
import { OutboxKeyUnavailableError, openBody } from "../seal";
import type { DeliverResult } from "@/lib/email";

const HAS_DB = !!process.env.DATABASE_URL;
const RUN = `t3-${randomUUID().slice(0, 8)}`;
const KEK = "ab".repeat(32);
const OTHER_KEK = "cd".repeat(32);
const API_KEY = "re_test";
/** A provider id unique to this run: provider_id is unique across the table. */
const pid = (s: string): string => `re_${s}_${RUN}`;
const MIN = 60_000;
const SECRET = `SECRET-TOKEN-${randomUUID()}`;
const LINK = `https://seazn.club/api/auth/magic-link/verify?token=${SECRET}`;

type Row = {
  id: string;
  kind: OutboxKind;
  ref_type: string;
  ref_id: string;
  org_id: string | null;
  meta: Record<string, string>;
  recipient: string;
  subject: string;
  body_sealed: Buffer | null;
  transactional: boolean;
  status: string;
  attempts: number;
  next_attempt_at: Date;
  lease_until: Date | null;
  expires_at: Date;
  last_error: string | null;
  provider_id: string | null;
  sent_at: Date | null;
  status_at: Date;
};

const http = (status: number, errorName: string | null, detail = `RAW-PROVIDER-DETAIL-${status}`): DeliverResult => ({
  ok: false,
  reason: "http",
  status,
  errorName,
  detail,
});

/** The fake provider: one message per Idempotency-Key, however many requests carry it. */
function makeProvider() {
  const messages = new Map<string, string>(); // key -> provider id
  const requests: string[] = []; // every key seen, in order
  return {
    messages,
    requests,
    accept: (key: string): DeliverResult => {
      requests.push(key);
      if (!messages.has(key)) messages.set(key, pid(randomUUID()));
      return { ok: true, providerId: messages.get(key)! };
    },
  };
}

const idOf = (m: { tags: Record<string, string> }): string => m.tags.outbox!;

function msg(over: Partial<OutboxMessage> = {}): OutboxMessage {
  return {
    kind: "magic_link",
    refType: "login",
    refId: `${RUN}-${randomUUID()}`,
    orgId: null,
    to: `${randomUUID()}@x.test`,
    subject: "Your sign-in link",
    html: `<a href="${LINK}">Sign in</a>`,
    text: `Sign in: ${LINK}`,
    transactional: true,
    expiresAt: new Date(Date.now() + 15 * MIN),
    ...over,
  };
}

describe("dispatchNow with nothing to do", () => {
  it("dispatchNow([]) returns an empty map and issues no statement", async () => {
    const before = statementCount();
    const out = await dispatchNow([]);
    expect(out.size).toBe(0);
    expect(out).toBeInstanceOf(Map);
    expect(statementCount() - before).toBe(0);
  });
});

describe.skipIf(!HAS_DB)("the email outbox core (DB)", () => {
  const created: string[] = [];
  const suppressed: string[] = [];
  let orgId = "";
  let warn: MockInstance<typeof console.warn>;
  const savedHooks = {} as Record<OutboxKind, (typeof KIND_HOOKS)[OutboxKind]>;
  const hookSpy = vi.fn<(row: EndedRow) => Promise<void>>(async () => {});

  /** Insert via the pooled privileged client (no caller transaction), remembering the id for cleanup. */
  async function queue(over: Partial<OutboxMessage> = {}): Promise<string> {
    const id = await enqueueEmail(sql, msg(over));
    created.push(id);
    return id;
  }
  const get = async (id: string): Promise<Row> => {
    const [r] = await sql<Row[]>`select * from email_outbox where id = ${id}`;
    if (!r) throw new Error(`no outbox row ${id}`);
    return r;
  };
  const statusOf = async (id: string): Promise<string> => (await get(id)).status;
  const callsTo = () => deliverMock.mock.calls.map((c) => c[0] as { to: string; idempotencyKey: string; tags: Record<string, string>; html: string; text: string });

  /** What the worker's claim does for a retry (Task 4 owns the real one): sending, attempts + 1, a lease. */
  async function claimForRetry(id: string): Promise<ClaimedRow> {
    const [rec] = await sql<ClaimedRecord[]>`
      update email_outbox
         set status = 'sending', attempts = attempts + 1, lease_until = now() + interval '2 minutes', status_at = now()
       where id = ${id} and status = 'queued'
      returning id, kind, ref_type, ref_id, org_id, meta, recipient, subject, body_sealed, transactional,
                attempts, expires_at, lease_until`;
    if (!rec) throw new Error(`could not claim ${id} for a retry (not queued)`);
    return toClaimedRow(rec);
  }

  beforeAll(async () => {
    const [o] = await sql<{ id: string }[]>`
      insert into organizations (name, slug) values (${`Outbox core ${RUN}`}, ${`outbox-core-${RUN}`}) returning id`;
    orgId = o!.id;
  });

  afterAll(async () => {
    await sql`delete from email_outbox where ref_id like ${`${RUN}-%`}`;
    await sql`delete from organizations where id = ${orgId}`;
    if (suppressed.length > 0) await sql`delete from email_suppressions where email in ${sql(suppressed)}`;
    await sql.end({ timeout: 2 }).catch(() => undefined);
  });

  beforeEach(() => {
    vi.stubEnv("LICHESS_TOKEN_KEK", KEK);
    vi.stubEnv("RESEND_API_KEY", API_KEY);
    logMock.error.mockClear();
    logMock.warn.mockClear();
    deliverMock.mockReset();
    deliverMock.mockImplementation(async (m: { tags: Record<string, string> }) => ({ ok: true, providerId: pid(idOf(m)) }));
    hookSpy.mockClear();
    for (const k of OUTBOX_KINDS) savedHooks[k] = KIND_HOOKS[k];
    for (const k of OUTBOX_KINDS) KIND_HOOKS[k] = { onEndedBadly: hookSpy };
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    for (const k of OUTBOX_KINDS) KIND_HOOKS[k] = savedHooks[k];
  });

  // ---- enqueue -----------------------------------------------------------------------------------------------

  describe("enqueueEmail", () => {
    it("committed <=> queued: a transaction that rolls back leaves no row, one that commits leaves one", async () => {
      let rolledBack = "";
      await expect(
        sql.begin(async (tx) => {
          rolledBack = await enqueueEmail(tx, msg());
          throw new Error("caller failed after enqueue");
        }),
      ).rejects.toThrow("caller failed after enqueue");
      expect(rolledBack).toMatch(/^[0-9a-f-]{36}$/);
      expect((await sql`select 1 from email_outbox where id = ${rolledBack}`).length).toBe(0);

      const committed = (await sql.begin((tx) => enqueueEmail(tx, msg()))) as unknown as string;
      created.push(committed);
      expect(await statusOf(committed)).toBe("queued");
      expect(committed).not.toBe(rolledBack);
    });

    it("stores a sealed body (no plaintext link), status queued, attempts 0, the given expires_at, meta and columns", async () => {
      const expiresAt = new Date(Date.now() + 7 * MIN);
      const m = msg({ kind: "chess_invite", refType: "fixture_seat", orgId, expiresAt, meta: { fixtureId: "f1", colour: "white" }, transactional: false });
      const id = await queue(m);
      const r = await get(id);
      expect(r.status).toBe("queued");
      expect(r.attempts).toBe(0);
      expect(r.kind).toBe("chess_invite");
      expect([r.ref_type, r.ref_id, r.org_id, r.recipient, r.subject, r.transactional]).toEqual([
        "fixture_seat", m.refId, orgId, m.to, m.subject, false,
      ]);
      expect(r.expires_at.getTime()).toBe(expiresAt.getTime());
      expect(r.meta).toEqual({ fixtureId: "f1", colour: "white" });
      expect(r.last_error).toBeNull();
      expect(r.provider_id).toBeNull();
      // The body is an envelope, not text.
      expect(r.body_sealed).not.toBeNull();
      expect(r.body_sealed!.includes(Buffer.from(SECRET))).toBe(false);
      expect(r.body_sealed!.includes(Buffer.from("Sign in"))).toBe(false);
      expect(openBody(r.body_sealed!)).toEqual({ html: m.html, text: m.text });
      // The control for the probe above: the plaintext does contain it.
      expect(m.html).toContain(SECRET);
    });

    it("meta defaults to an empty object", async () => {
      const id = await queue();
      expect((await get(id)).meta).toEqual({});
    });

    it("every kind enqueues (checked: both kinds)", async () => {
      let checked = 0;
      for (const kind of OUTBOX_KINDS) {
        const id = await queue({ kind });
        expect((await get(id)).kind).toBe(kind);
        checked++;
      }
      expect(checked).toBe(OUTBOX_KINDS.length);
    });

    it("works on a withTenant handle as app_user (INSERT-only role) and returns the client-made id", async () => {
      const m = msg({ kind: "chess_invite", refType: "fixture_seat", orgId });
      const id = await withTenant(orgId, (tx: Tx) => enqueueEmail(tx, m));
      created.push(id);
      const r = await get(id);
      expect([r.org_id, r.status, r.recipient]).toEqual([orgId, "queued", m.to]);
    });

    it("an unusable KEK with a Resend key set REFUSES, the caller sees the error, and its transaction leaves nothing", async () => {
      vi.stubEnv("LICHESS_TOKEN_KEK", "");
      const m = msg();
      let seen: unknown;
      await sql
        .begin(async (tx) => {
          await enqueueEmail(tx, m);
        })
        .catch((e: unknown) => {
          seen = e;
        });
      expect(seen).toBeInstanceOf(OutboxKeyUnavailableError);
      expect((seen as OutboxKeyUnavailableError).code).toBe("EMAIL_OUTBOX_KEK_MISSING");
      expect((await sql`select 1 from email_outbox where ref_id = ${m.refId}`).length).toBe(0);
    });

    it("an unusable KEK with NO Resend key queues a bodiless row (dev/CI), which later dies 'no_api_key'", async () => {
      vi.stubEnv("LICHESS_TOKEN_KEK", undefined);
      vi.stubEnv("RESEND_API_KEY", undefined);
      const id = await queue();
      expect((await get(id)).body_sealed).toBeNull();
      expect((await dispatchNow([id])).get(id)).toBe("dead");
      const r = await get(id);
      expect([r.status, r.last_error]).toEqual(["dead", "no_api_key"]);
      expect(deliverMock).not.toHaveBeenCalled();
    });
  });

  // ---- the first attempt: the spec's result table --------------------------------------------------------------

  describe("dispatchNow: one attempt per result", () => {
    it("2xx -> sent: provider_id, sent_at, body null, lease null, attempts 1; deliver got the row's key, tags and plaintext", async () => {
      const m = msg();
      const id = await queue(m);
      deliverMock.mockResolvedValueOnce({ ok: true, providerId: pid("abc123") });
      const out = await dispatchNow([id]);
      expect(out.get(id)).toBe("sent");
      const r = await get(id);
      expect(r.status).toBe("sent");
      expect(r.provider_id).toBe(pid("abc123"));
      expect(r.sent_at).not.toBeNull();
      expect(r.body_sealed).toBeNull();
      expect(r.lease_until).toBeNull();
      expect(r.attempts).toBe(1);
      expect(r.last_error).toBeNull();

      expect(deliverMock).toHaveBeenCalledTimes(1);
      const [sent, apiKey] = deliverMock.mock.calls[0]!;
      expect(sent).toEqual({
        to: m.to,
        subject: m.subject,
        html: m.html,
        text: m.text,
        transactional: true,
        idempotencyKey: idempotencyKey(id),
        tags: { outbox: id },
      });
      expect(apiKey).toBe(API_KEY); // the gate's key reached the transport, as an argument and not inside the message
      expect(JSON.stringify(sent)).not.toContain(API_KEY);
    });

    it("the row's own transactional flag reaches the transport, both ways (a false stays false)", async () => {
      let checked = 0;
      for (const transactional of [true, false]) {
        const id = await queue({ transactional, to: `${randomUUID()}@clean.test` });
        await dispatchNow([id]);
        const sent = callsTo().find((c) => c.tags.outbox === id) as unknown as { transactional: boolean };
        expect(sent.transactional, String(transactional)).toBe(transactional);
        checked++;
      }
      expect(checked).toBe(2);
    });

    it("a 2xx with no provider id is still sent (R8: the webhook then matches it by the outbox tag)", async () => {
      const id = await queue();
      deliverMock.mockResolvedValueOnce({ ok: true, providerId: null });
      expect((await dispatchNow([id])).get(id)).toBe("sent");
      const r = await get(id);
      expect([r.status, r.provider_id, r.body_sealed]).toEqual(["sent", null, null]);
    });

    it("while the attempt is in flight the row is 'sending' with a lease of LEASE_MS and attempts 1, body still held", async () => {
      const id = await queue();
      let inFlight: Row | undefined;
      deliverMock.mockImplementationOnce(async () => {
        inFlight = await get(id);
        return { ok: true, providerId: pid("inflight") };
      });
      const t0 = Date.now();
      await dispatchNow([id]);
      expect(inFlight!.status).toBe("sending");
      expect(inFlight!.attempts).toBe(1);
      expect(inFlight!.body_sealed).not.toBeNull();
      const lease = inFlight!.lease_until!.getTime();
      expect(Math.abs(lease - (t0 + LEASE_MS))).toBeLessThan(5_000);
    });

    it("500 -> retrying: queued again, attempts 1, next_attempt_at = status_at + the first delay, body kept, last_error has the status and name only", async () => {
      const id = await queue();
      deliverMock.mockResolvedValueOnce(http(500, "internal_server_error", `RAW-PROVIDER-DETAIL ${SECRET} ${API_KEY}`));
      expect((await dispatchNow([id])).get(id)).toBe("retrying");
      const r = await get(id);
      expect([r.status, r.attempts]).toEqual(["queued", 1]);
      expect(Math.abs(r.next_attempt_at.getTime() - (r.status_at.getTime() + RETRY_DELAYS_MS[0]!))).toBeLessThan(2_000);
      expect(r.body_sealed).not.toBeNull();
      expect(openBody(r.body_sealed!).text).toContain(SECRET);
      expect(r.lease_until).toBeNull();
      expect(r.sent_at).toBeNull();
      expect(r.last_error).toBe("http 500 internal_server_error");
      expect(r.last_error).not.toContain("RAW-PROVIDER-DETAIL");
      expect(hookSpy).not.toHaveBeenCalled(); // a retry has not ended
    });

    it("an http failure with no error name still records its status and a placeholder", async () => {
      const id = await queue();
      deliverMock.mockResolvedValueOnce(http(503, null));
      await dispatchNow([id]);
      expect((await get(id)).last_error).toBe("http 503 unknown");
    });

    it("a provider-supplied error name is sanitised to a token and the whole last_error is capped at 200", async () => {
      const id = await queue();
      deliverMock.mockResolvedValueOnce(http(503, `bad\nname with spaces ${"x".repeat(400)}`));
      await dispatchNow([id]);
      const last = (await get(id)).last_error!;
      expect(last.startsWith("http 503 bad?name?with?spaces?")).toBe(true);
      expect(last).toMatch(/^http 503 [A-Za-z0-9_.?-]+$/);
      expect(last.length).toBeLessThanOrEqual(200);
    });

    it("a network failure -> retrying with 'network <cause>', capped at 200 and printable ASCII only", async () => {
      const id = await queue();
      deliverMock.mockResolvedValueOnce({ ok: false, reason: "network", detail: `fetch failed\n(ECONNRESET)\u0007 caf\u00e9 ${"y".repeat(500)}` });
      expect((await dispatchNow([id])).get(id)).toBe("retrying");
      const r = await get(id);
      expect(r.status).toBe("queued");
      expect(r.last_error!.startsWith("network fetch failed?(ECONNRESET)? caf? ")).toBe(true);
      expect(r.last_error!.length).toBeLessThanOrEqual(200);
      expect(r.last_error).toMatch(/^[\x20-\x7e]+$/);
    });

    it("a deliver that throws -> retrying 'network ...', and the thrown text is neither stored nor logged", async () => {
      const id = await queue();
      deliverMock.mockRejectedValueOnce(new Error(`kaboom ${SECRET}`));
      expect((await dispatchNow([id])).get(id)).toBe("retrying");
      const r = await get(id);
      expect(r.status).toBe("queued");
      expect(r.last_error).toMatch(/^network /);
      expect(r.last_error).not.toContain(SECRET);
      expect(JSON.stringify(logMock.error.mock.calls)).not.toContain(SECRET);
    });

    it("422 -> dead at once: body null, lease null, afterEndedBadly runs once with that row", async () => {
      const m = msg({ kind: "chess_invite", refType: "fixture_seat", orgId, meta: { fixtureId: "f9" } });
      const id = await queue(m);
      deliverMock.mockResolvedValueOnce(http(422, "validation_error"));
      expect((await dispatchNow([id])).get(id)).toBe("dead");
      const r = await get(id);
      expect([r.status, r.body_sealed, r.lease_until, r.last_error]).toEqual(["dead", null, null, "http 422 validation_error"]);
      expect(hookSpy).toHaveBeenCalledTimes(1);
      expect(hookSpy).toHaveBeenCalledWith({
        id, kind: "chess_invite", refType: "fixture_seat", refId: m.refId, status: "dead", meta: { fixtureId: "f9" },
      });
    });

    it("400 and 403 die the same way (spec: dead at once, retrying cannot help)", async () => {
      let checked = 0;
      for (const status of [400, 403, 401]) {
        const id = await queue();
        deliverMock.mockResolvedValueOnce(http(status, "validation_error"));
        expect((await dispatchNow([id])).get(id), String(status)).toBe("dead");
        expect(await statusOf(id)).toBe("dead");
        checked++;
      }
      expect(checked).toBe(3);
      expect(hookSpy).toHaveBeenCalledTimes(3);
    });

    it("409 invalid_idempotent_request -> dead and logged as an error (it means a bug); the log carries ids, not text", async () => {
      const id = await queue();
      deliverMock.mockResolvedValueOnce(http(409, "invalid_idempotent_request", `RAW ${SECRET}`));
      expect((await dispatchNow([id])).get(id)).toBe("dead");
      expect(logMock.error).toHaveBeenCalledTimes(1);
      const logged = JSON.stringify(logMock.error.mock.calls);
      expect(logged).toContain(id);
      expect(logged).not.toContain(SECRET);
      expect(logged).not.toContain(API_KEY);
      expect((await get(id)).last_error).toBe("http 409 invalid_idempotent_request");
    });

    it("409 concurrent_idempotent_requests -> retrying, with no error log (it is an ordinary overlap)", async () => {
      const id = await queue();
      deliverMock.mockResolvedValueOnce(http(409, "concurrent_idempotent_requests"));
      expect((await dispatchNow([id])).get(id)).toBe("retrying");
      expect(await statusOf(id)).toBe("queued");
      expect(logMock.error).not.toHaveBeenCalled();
    });

    it("429 -> retrying and the call reports it as rate limited via the stop (see the 429 test below)", async () => {
      const id = await queue();
      deliverMock.mockResolvedValueOnce(http(429, "rate_limit_exceeded"));
      expect((await dispatchNow([id])).get(id)).toBe("retrying");
      expect(await statusOf(id)).toBe("queued");
    });

    it("a non-transactional message to a suppressed address -> suppressed, deliver never called, hook runs", async () => {
      const to = `${randomUUID()}@suppressed.test`;
      suppressed.push(to);
      await suppress(to, "manual");
      const id = await queue({ to, transactional: false });
      expect((await dispatchNow([id])).get(id)).toBe("suppressed");
      const r = await get(id);
      expect([r.status, r.body_sealed, r.lease_until, r.last_error]).toEqual(["suppressed", null, null, "suppressed"]);
      expect(deliverMock).not.toHaveBeenCalled();
      expect(hookSpy).toHaveBeenCalledTimes(1);
      expect(hookSpy.mock.calls[0]![0].status).toBe("suppressed");
    });

    it("suppression applies to non-transactional mail only: the same address as a transactional message is delivered, and an unlisted non-transactional address too", async () => {
      const to = `${randomUUID()}@suppressed.test`;
      suppressed.push(to);
      await suppress(to, "bounce");
      const tx = await queue({ to, transactional: true });
      const clean = await queue({ to: `${randomUUID()}@clean.test`, transactional: false });
      const out = await dispatchNow([tx, clean]);
      expect([out.get(tx), out.get(clean)]).toEqual(["sent", "sent"]);
      expect(deliverMock).toHaveBeenCalledTimes(2);
    });

    it("no RESEND_API_KEY -> dead 'no_api_key', deliver never called, today's would-send warning kept, body nulled", async () => {
      vi.stubEnv("RESEND_API_KEY", undefined);
      const m = msg();
      const id = await queue(m);
      expect((await get(id)).body_sealed).not.toBeNull(); // sealed: the KEK is set here
      expect((await dispatchNow([id])).get(id)).toBe("dead");
      const r = await get(id);
      expect([r.status, r.last_error, r.body_sealed, r.lease_until, r.attempts]).toEqual(["dead", "no_api_key", null, null, 1]);
      expect(deliverMock).not.toHaveBeenCalled();
      const warned = warn.mock.calls.map((c) => String(c[0]));
      expect(warned.some((w) => w.includes("RESEND_API_KEY not set") && w.includes(m.subject) && w.includes(m.to))).toBe(true);
      expect(hookSpy).toHaveBeenCalledTimes(1);
    });

    it("a body that is missing while a key is set -> dead 'body_missing'; deliver never called", async () => {
      vi.stubEnv("LICHESS_TOKEN_KEK", undefined);
      vi.stubEnv("RESEND_API_KEY", undefined);
      const id = await queue(); // bodiless: the box could neither seal nor send
      vi.stubEnv("LICHESS_TOKEN_KEK", KEK);
      vi.stubEnv("RESEND_API_KEY", API_KEY);
      expect((await get(id)).body_sealed).toBeNull();
      expect((await dispatchNow([id])).get(id)).toBe("dead");
      expect((await get(id)).last_error).toBe("body_missing");
      expect(deliverMock).not.toHaveBeenCalled();
      expect(hookSpy).toHaveBeenCalledTimes(1);
    });

    it("a body that will not open -> dead 'body_unreadable'; deliver never called (swept: damaged bytes, a rotated KEK)", async () => {
      const damaged = await queue();
      await sql`update email_outbox set body_sealed = ${Buffer.from("not an envelope at all, but long enough to pass a length check ".repeat(3))} where id = ${damaged}`;
      const rotated = await queue();
      // Seal under the current KEK (done), then open under another.
      vi.stubEnv("LICHESS_TOKEN_KEK", OTHER_KEK);
      const out = await dispatchNow([damaged, rotated]);
      expect([out.get(damaged), out.get(rotated)]).toEqual(["dead", "dead"]);
      for (const id of [damaged, rotated]) {
        const r = await get(id);
        expect([r.status, r.last_error, r.body_sealed], id).toEqual(["dead", "body_unreadable", null]);
      }
      expect(deliverMock).not.toHaveBeenCalled();
      expect(hookSpy).toHaveBeenCalledTimes(2);
    });

    it("the gate runs BEFORE the body is opened: with no key and an unreadable body the reason is 'no_api_key'", async () => {
      const id = await queue();
      await sql`update email_outbox set body_sealed = ${Buffer.from("garbage".repeat(30))} where id = ${id}`;
      vi.stubEnv("RESEND_API_KEY", undefined);
      await dispatchNow([id]);
      expect((await get(id)).last_error).toBe("no_api_key");
    });
  });

  // ---- sequences -----------------------------------------------------------------------------------------------

  describe("sequences", () => {
    it("retry then success: 500, then the worker's second attempt succeeds with the SAME key; one provider message", async () => {
      const provider = makeProvider();
      const id = await queue();
      deliverMock.mockResolvedValueOnce(http(500, "internal_server_error"));
      deliverMock.mockImplementation(async (m: { idempotencyKey: string }) => provider.accept(m.idempotencyKey));

      expect((await dispatchNow([id])).get(id)).toBe("retrying");
      const r1 = await claimForRetry(id);
      expect(r1.attempts).toBe(2);
      const second = await attemptClaimed(r1);
      expect(second).toEqual({ outcome: "sent", verdict: "sent", rateLimited: false });

      const r = await get(id);
      expect([r.status, r.attempts, r.body_sealed, r.lease_until]).toEqual(["sent", 2, null, null]);
      expect(r.provider_id).toBe(provider.messages.get(idempotencyKey(id)));
      const keys = callsTo().map((c) => c.idempotencyKey);
      expect(keys).toEqual([idempotencyKey(id), idempotencyKey(id)]);
      expect(provider.messages.size).toBe(1);
    });

    it("an overlapping attempt: the same key twice gives ONE provider message (409 concurrent -> retry -> the original)", async () => {
      const provider = makeProvider();
      const id = await queue();
      let inFlight = true; // the first request is still being processed by the provider
      deliverMock.mockImplementation(async (m: { idempotencyKey: string }) => {
        if (provider.messages.has(m.idempotencyKey) && inFlight) {
          provider.requests.push(m.idempotencyKey);
          return http(409, "concurrent_idempotent_requests");
        }
        return provider.accept(m.idempotencyKey);
      });
      // Attempt 1 times out on our side (the provider accepted it: the message exists, our request saw nothing).
      deliverMock.mockImplementationOnce(async (m: { idempotencyKey: string }) => {
        provider.accept(m.idempotencyKey);
        return { ok: false, reason: "network", detail: "timeout" } as DeliverResult;
      });

      expect((await dispatchNow([id])).get(id)).toBe("retrying");
      // The retry lands while the provider still holds the first request: 409 concurrent, and the row retries again.
      expect((await attemptClaimed(await claimForRetry(id))).outcome).toBe("retrying");
      expect((await get(id)).last_error).toBe("http 409 concurrent_idempotent_requests");
      // Later the provider is done: the same key returns the original response.
      inFlight = false;
      expect((await attemptClaimed(await claimForRetry(id))).outcome).toBe("sent");

      expect(new Set(provider.requests)).toEqual(new Set([idempotencyKey(id)]));
      expect(provider.requests.length).toBe(3);
      expect(provider.messages.size).toBe(1); // one email
      expect((await get(id)).provider_id).toBe(provider.messages.get(idempotencyKey(id)));
      expect((await get(id)).attempts).toBe(3);
    });

    it("exhaustion: MAX_ATTEMPTS retryable failures end dead, deliver is called exactly MAX_ATTEMPTS times, and the last attempt has no next date", async () => {
      const id = await queue();
      deliverMock.mockResolvedValue(http(503, "service_unavailable"));
      expect((await dispatchNow([id])).get(id)).toBe("retrying");
      let outcome: AttemptOutcome = "retrying";
      let ended: EndedRow | null = null;
      let n = 1;
      while (outcome === "retrying") {
        const claimed = await claimForRetry(id);
        n = claimed.attempts;
        const res = await attemptClaimed(claimed);
        outcome = res.outcome;
        ended = endedRowFor(claimed, res.outcome);
        expect(n).toBeLessThanOrEqual(MAX_ATTEMPTS);
      }
      expect(n).toBe(MAX_ATTEMPTS);
      expect(outcome).toBe("dead");
      expect(deliverMock).toHaveBeenCalledTimes(MAX_ATTEMPTS);
      const r = await get(id);
      expect([r.status, r.attempts, r.body_sealed, r.lease_until, r.last_error]).toEqual([
        "dead", MAX_ATTEMPTS, null, null, "http 503 service_unavailable",
      ]);
      expect(ended).toMatchObject({ id, status: "dead" });
    });

    it("each retry waits RETRY_DELAYS_MS[n-1] after attempt n (swept over every retry the schedule allows)", async () => {
      const id = await queue();
      deliverMock.mockResolvedValue(http(500, "internal_server_error"));
      await dispatchNow([id]);
      let checked = 0;
      for (let n = 1; n < MAX_ATTEMPTS; n++) {
        const r = await get(id);
        expect(r.status, `after attempt ${n}`).toBe("queued");
        expect(r.attempts).toBe(n);
        expect(Math.abs(r.next_attempt_at.getTime() - (r.status_at.getTime() + RETRY_DELAYS_MS[n - 1]!)), `delay ${n}`).toBeLessThan(2_000);
        checked++;
        await attemptClaimed(await claimForRetry(id));
      }
      expect(checked).toBe(MAX_ATTEMPTS - 1);
      expect(await statusOf(id)).toBe("dead");
    });

    it("a second dispatchNow on a sent row -> deferred; deliver is called once in total", async () => {
      const id = await queue();
      expect((await dispatchNow([id])).get(id)).toBe("sent");
      expect((await dispatchNow([id])).get(id)).toBe("deferred");
      expect(deliverMock).toHaveBeenCalledTimes(1);
      expect((await get(id)).attempts).toBe(1);
    });

    it("a second dispatchNow on a retrying row -> deferred too (first attempts only; the worker owns the rest)", async () => {
      const id = await queue();
      deliverMock.mockResolvedValueOnce(http(500, null));
      expect((await dispatchNow([id])).get(id)).toBe("retrying");
      // Even with its date already due, dispatchNow never reads next_attempt_at.
      await sql`update email_outbox set next_attempt_at = now() - interval '1 hour' where id = ${id}`;
      expect((await dispatchNow([id])).get(id)).toBe("deferred");
      expect(deliverMock).toHaveBeenCalledTimes(1);
      expect(await statusOf(id)).toBe("queued");
    });

    it("success then a late call: a sent row whose expires_at has since passed is never 'expired' by dispatchNow; it stays sent", async () => {
      const id = await queue();
      expect((await dispatchNow([id])).get(id)).toBe("sent");
      await sql`update email_outbox set expires_at = now() - interval '1 hour' where id = ${id}`;
      expect((await dispatchNow([id])).get(id)).toBe("deferred");
      expect(await statusOf(id)).toBe("sent");
      expect(hookSpy).not.toHaveBeenCalled();
      expect(deliverMock).toHaveBeenCalledTimes(1);
    });

    it("retry then expiry: a retrying row that has passed expires_at is expired by the next dispatchNow, never re-sent late", async () => {
      const id = await queue();
      deliverMock.mockResolvedValueOnce(http(503, null));
      expect((await dispatchNow([id])).get(id)).toBe("retrying");
      await sql`update email_outbox set expires_at = now() - interval '1 second' where id = ${id}`;
      expect((await dispatchNow([id])).get(id)).toBe("expired");
      const r = await get(id);
      expect([r.status, r.body_sealed, r.attempts]).toEqual(["expired", null, 1]);
      expect(deliverMock).toHaveBeenCalledTimes(1);
      expect(hookSpy).toHaveBeenCalledTimes(1);
    });

    it("a repeated id in one call is attempted once", async () => {
      const id = await queue();
      const out = await dispatchNow([id, id, id]);
      expect(out.size).toBe(1);
      expect(out.get(id)).toBe("sent");
      expect(deliverMock).toHaveBeenCalledTimes(1);
    });

    it("an id with no row is deferred, not an error, and others in the call still go out", async () => {
      const ghost = randomUUID();
      const real = await queue();
      const out = await dispatchNow([ghost, real]);
      expect([out.get(ghost), out.get(real)]).toEqual(["deferred", "sent"]);
    });

    it("a malformed id is deferred and logged without touching the database, and the rest of the call still goes out", async () => {
      const real = await queue();
      const out = await dispatchNow(["not-a-uuid", real]);
      expect(out.get("not-a-uuid")).toBe("deferred");
      expect(out.get(real)).toBe("sent");
      expect(logMock.error).toHaveBeenCalledTimes(1);
    });

    it("a call of only malformed ids issues no statement and defers each (the empty set must not reach the database)", async () => {
      const before = statementCount();
      const out = await dispatchNow(["nope", "also-nope"]);
      expect([...out.entries()]).toEqual([["nope", "deferred"], ["also-nope", "deferred"]]);
      expect(statementCount() - before).toBe(0);
    });

    it("never throws after the caller's commit: a failure in the call itself defers every id and is logged (the rows stay queued)", async () => {
      // An Invalid Date cannot be sent to the database, so the very first statement of the call fails.
      const ids = [await queue(), await queue()];
      const out = await dispatchNow(ids, { now: new Date(Number.NaN) });
      expect([...out.entries()]).toEqual(ids.map((i) => [i, "deferred"]));
      expect(logMock.error).toHaveBeenCalledTimes(1);
      expect(deliverMock).not.toHaveBeenCalled();
      for (const id of ids) expect(await statusOf(id)).toBe("queued");
    });

    it("a failure AFTER the send is contained to its row: deferred and logged, the row is left 'sending' with its lease for the worker, the other ids still go out", async () => {
      const taken = await queue();
      deliverMock.mockResolvedValueOnce({ ok: true, providerId: pid("dup") });
      await dispatchNow([taken]);
      deliverMock.mockClear();
      const clash = await queue();
      const fine = await queue();
      deliverMock.mockImplementation(async (m: { tags: Record<string, string> }) => ({
        ok: true,
        // The provider id is unique across the table, so recording a duplicate one cannot succeed.
        providerId: idOf(m) === clash ? pid("dup") : pid(idOf(m)),
      }));
      const out = await dispatchNow([clash, fine]);
      expect([out.get(clash), out.get(fine)]).toEqual(["deferred", "sent"]);
      const r = await get(clash);
      expect([r.status, r.attempts]).toEqual(["sending", 1]);
      expect(r.lease_until).not.toBeNull();
      expect(logMock.error).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(logMock.error.mock.calls)).toContain(clash);
    });

    it("replaced then attempt: row A retrying, row B enqueued for the same ref + recipient -> dispatchNow([A]) is deferred and A stays replaced", async () => {
      const refId = `${RUN}-${randomUUID()}`;
      const to = `${randomUUID()}@x.test`;
      const a = await queue({ refId, to });
      deliverMock.mockResolvedValueOnce(http(500, null));
      expect((await dispatchNow([a])).get(a)).toBe("retrying");
      const b = await queue({ refId, to: to.toUpperCase() }); // case differs: the replace is case-insensitive
      expect(await statusOf(a)).toBe("replaced");
      deliverMock.mockClear();
      expect((await dispatchNow([a])).get(a)).toBe("deferred");
      expect(deliverMock).not.toHaveBeenCalled();
      const r = await get(a);
      expect([r.status, r.body_sealed, r.attempts]).toEqual(["replaced", null, 1]);
      expect(await statusOf(b)).toBe("queued");
    });

    it("replaced before its first attempt: dispatchNow([A, B]) sends B only", async () => {
      const refId = `${RUN}-${randomUUID()}`;
      const to = `${randomUUID()}@x.test`;
      const a = await queue({ refId, to });
      const b = await queue({ refId, to });
      expect(await statusOf(a)).toBe("replaced");
      const out = await dispatchNow([a, b]);
      expect([out.get(a), out.get(b)]).toEqual(["deferred", "sent"]);
      expect(callsTo().map((c) => c.tags.outbox)).toEqual([b]);
      expect((await get(a)).attempts).toBe(0);
    });

    it("a row replaced while its attempt is in flight stays replaced whatever the attempt returns (2xx, retry, dead)", async () => {
      const results: Array<[string, DeliverResult]> = [
        ["2xx", { ok: true, providerId: pid("late") }],
        ["500", http(500, "internal_server_error")],
        ["422", http(422, "validation_error")],
      ];
      let checked = 0;
      for (const [label, result] of results) {
        const refId = `${RUN}-${randomUUID()}`;
        const to = `${randomUUID()}@x.test`;
        const a = await queue({ refId, to });
        let b = "";
        deliverMock.mockImplementationOnce(async () => {
          b = await queue({ refId, to }); // a newer row for the same ref + recipient, written mid-attempt
          return result;
        });
        const out = await dispatchNow([a]);
        const r = await get(a);
        expect([r.status, r.body_sealed, r.lease_until, r.provider_id, r.sent_at], label).toEqual(["replaced", null, null, null, null]);
        expect(out.get(a), label).toBe("deferred");
        expect(await statusOf(b), label).toBe("queued");
        // A replaced row has not "ended badly": no hook runs for it, even for the 422.
        checked++;
      }
      expect(checked).toBe(3);
      expect(hookSpy).not.toHaveBeenCalled();
    });

    it("a stale write after a re-claim changes nothing: the lease lapsed and the worker took the row (attempts + 1), so attempt 1's result is dropped (2xx, 500, 422)", async () => {
      const results: Array<[string, DeliverResult]> = [
        ["2xx", { ok: true, providerId: pid("stale") }],
        ["500", http(500, "internal_server_error")],
        ["422", http(422, "validation_error")],
      ];
      let checked = 0;
      for (const [label, result] of results) {
        const id = await queue();
        deliverMock.mockImplementationOnce(async () => {
          // Still 'sending', but it is attempt 2's now: a fresh claim bumps attempts and renews the lease.
          await sql`update email_outbox set attempts = attempts + 1, lease_until = now() + interval '2 minutes'
                     where id = ${id} and status = 'sending'`;
          return result;
        });
        const out = await dispatchNow([id]);
        const r = await get(id);
        expect([r.status, r.attempts, r.provider_id, r.sent_at, r.last_error], label).toEqual(["sending", 2, null, null, null]);
        expect(r.body_sealed, label).not.toBeNull();
        expect(r.lease_until, label).not.toBeNull();
        expect(out.get(id), label).toBe("deferred");
        checked++;
      }
      expect(checked).toBe(3);
      expect(hookSpy).not.toHaveBeenCalled();
    });

    it("expired before the first attempt -> expired, body nulled, deliver never called, the hook runs once with status expired", async () => {
      const m = msg({ expiresAt: new Date(Date.now() - 1_000), kind: "chess_invite", refType: "fixture_seat", orgId });
      const id = await queue(m);
      expect((await dispatchNow([id])).get(id)).toBe("expired");
      const r = await get(id);
      expect([r.status, r.body_sealed, r.lease_until, r.attempts]).toEqual(["expired", null, null, 0]);
      expect(deliverMock).not.toHaveBeenCalled();
      expect(hookSpy).toHaveBeenCalledTimes(1);
      expect(hookSpy.mock.calls[0]![0]).toMatchObject({ id, status: "expired", kind: "chess_invite" });
    });

    it("a mixed call: expired + dead + sent + deferred -> the hook runs for the two that ended badly and for no other", async () => {
      const expired = await queue({ expiresAt: new Date(Date.now() - MIN) });
      const dead = await queue();
      const ok = await queue();
      const taken = await queue();
      await dispatchNow([taken]);
      hookSpy.mockClear();
      deliverMock.mockClear();
      deliverMock.mockImplementation(async (m: { tags: Record<string, string> }) =>
        idOf(m) === dead ? http(422, "validation_error") : { ok: true, providerId: pid(idOf(m)) });
      const out = await dispatchNow([expired, dead, ok, taken]);
      expect([out.get(expired), out.get(dead), out.get(ok), out.get(taken)]).toEqual(["expired", "dead", "sent", "deferred"]);
      expect(hookSpy.mock.calls.map((c) => [c[0].id, c[0].status]).sort()).toEqual(
        [[expired, "expired"], [dead, "dead"]].sort(),
      );
      expect(ENDED_BADLY_STATUSES).toContain("expired");
    });

    it("the first 429 stops the call: 3 ids, deliver called once, the other two deferred and untouched (queued, attempts 0, no lease)", async () => {
      const ids = [await queue(), await queue(), await queue()];
      deliverMock.mockResolvedValueOnce(http(429, "rate_limit_exceeded"));
      const out = await dispatchNow(ids);
      expect(deliverMock).toHaveBeenCalledTimes(1);
      expect(out.get(ids[0]!)).toBe("retrying");
      expect(out.get(ids[1]!)).toBe("deferred");
      expect(out.get(ids[2]!)).toBe("deferred");
      for (const id of ids.slice(1)) {
        const r = await get(id);
        expect([r.status, r.attempts, r.lease_until, r.last_error], id).toEqual(["queued", 0, null, null]);
        expect(r.body_sealed).not.toBeNull();
      }
      // The stop is per call: a later call attempts the untouched rows normally.
      const again = await dispatchNow(ids.slice(1));
      expect([...again.values()]).toEqual(["sent", "sent"]);
    });

    it("a 429 in the middle: the ids before it were attempted, the ones after were not", async () => {
      const ids = [await queue(), await queue(), await queue(), await queue()];
      deliverMock.mockImplementation(async (m: { tags: Record<string, string> }) =>
        idOf(m) === ids[1] ? http(429, "rate_limit_exceeded") : { ok: true, providerId: pid(idOf(m)) });
      const out = await dispatchNow(ids);
      expect(ids.map((i) => out.get(i))).toEqual(["sent", "retrying", "deferred", "deferred"]);
      expect(deliverMock).toHaveBeenCalledTimes(2);
    });
  });

  // ---- the clock ------------------------------------------------------------------------------------------------

  describe("the expiry clock", () => {
    it("in production a past injected clock is overridden: expires_at between the stale now and the real now -> expired, deliver never called, one log.error", async () => {
      vi.stubEnv("NODE_ENV", "production");
      const id = await queue({ expiresAt: new Date(Date.now() - 5 * MIN) });
      const stale = new Date(Date.now() - 30 * MIN);
      expect((await dispatchNow([id], { now: stale })).get(id)).toBe("expired");
      expect(deliverMock).not.toHaveBeenCalled();
      expect(logMock.error).toHaveBeenCalledTimes(1);
      expect(hookSpy).toHaveBeenCalledTimes(1);
    });

    it("the test seam still works outside production: the same row and the same stale now -> delivered", async () => {
      vi.stubEnv("NODE_ENV", "test");
      const id = await queue({ expiresAt: new Date(Date.now() - 5 * MIN) });
      const stale = new Date(Date.now() - 30 * MIN);
      expect((await dispatchNow([id], { now: stale })).get(id)).toBe("sent");
      expect(deliverMock).toHaveBeenCalledTimes(1);
      expect(logMock.error).not.toHaveBeenCalled();
    });

    it("in production a clock AHEAD of real time still applies (it can only expire a row early): expired, no log", async () => {
      vi.stubEnv("NODE_ENV", "production");
      const id = await queue({ expiresAt: new Date(Date.now() + 5 * MIN) });
      expect((await dispatchNow([id], { now: new Date(Date.now() + 10 * MIN) })).get(id)).toBe("expired");
      expect(deliverMock).not.toHaveBeenCalled();
      expect(logMock.error).not.toHaveBeenCalled();
    });

    it("in production with no injected clock the real time is used, silently", async () => {
      vi.stubEnv("NODE_ENV", "production");
      const live = await queue({ expiresAt: new Date(Date.now() + 5 * MIN) });
      const dead = await queue({ expiresAt: new Date(Date.now() - 5 * MIN) });
      const out = await dispatchNow([live, dead]);
      expect([out.get(live), out.get(dead)]).toEqual(["sent", "expired"]);
      expect(logMock.error).not.toHaveBeenCalled();
    });

    it("never late, mid-call: the real clock moves while an earlier row is attempted, and a later row that has since expired is not sent, is ended expired, and was never claimed", async () => {
      vi.stubEnv("NODE_ENV", "production");
      const T0 = new Date("2026-10-23T12:00:00.000Z");
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(T0);
      const a = await queue({ expiresAt: new Date(T0.getTime() + 10 * MIN), kind: "chess_invite", refType: "fixture_seat", orgId });
      const b = await queue({ expiresAt: new Date(T0.getTime() + 5 * MIN), kind: "chess_invite", refType: "fixture_seat", orgId });
      deliverMock.mockImplementationOnce(async () => {
        vi.setSystemTime(new Date(T0.getTime() + 6 * MIN)); // sending A took six minutes; B's window closed at five
        return { ok: true, providerId: pid("a-slow") };
      });
      const out = await dispatchNow([a, b]);
      expect([out.get(a), out.get(b)]).toEqual(["sent", "expired"]);
      expect(deliverMock).toHaveBeenCalledTimes(1);
      expect(callsTo().map((c) => c.tags.outbox)).toEqual([a]);
      const rb = await get(b);
      // attempts 0 is the claim predicate's witness: with it dropped B is claimed first (attempts 1) and only then expired.
      expect([rb.status, rb.attempts, rb.body_sealed, rb.lease_until]).toEqual(["expired", 0, null, null]);
      expect(hookSpy.mock.calls.map((c) => [c[0].id, c[0].status])).toEqual([[b, "expired"]]);
    });

    it("the same mid-call advance with an injected clock in production: the injected time never rescues a late row", async () => {
      vi.stubEnv("NODE_ENV", "production");
      const T0 = new Date("2026-10-23T12:00:00.000Z");
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(T0);
      const a = await queue({ expiresAt: new Date(T0.getTime() + 10 * MIN) });
      const b = await queue({ expiresAt: new Date(T0.getTime() + 5 * MIN) });
      deliverMock.mockImplementationOnce(async () => {
        vi.setSystemTime(new Date(T0.getTime() + 6 * MIN));
        return { ok: true, providerId: pid("a-slow-2") };
      });
      const out = await dispatchNow([a, b], { now: T0 }); // the caller's clock is frozen at the start of the call
      expect([out.get(a), out.get(b)]).toEqual(["sent", "expired"]);
      expect(deliverMock).toHaveBeenCalledTimes(1);
    });

    it("attemptClaimed judges expiry itself (the worker's path): a claimed row past expires_at is ended expired, deliver never called", async () => {
      vi.stubEnv("NODE_ENV", "production");
      const T0 = new Date("2026-10-23T12:00:00.000Z");
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(T0);
      const late = await queue({ expiresAt: new Date(T0.getTime() + 2 * MIN) });
      const fine = await queue({ expiresAt: new Date(T0.getTime() + 20 * MIN) });
      const claimedLate = await claimForRetry(late);
      const claimedFine = await claimForRetry(fine);
      vi.setSystemTime(new Date(T0.getTime() + 3 * MIN)); // the claim was at T0; the attempt starts three minutes later
      const l = await attemptClaimed(claimedLate);
      expect(l).toEqual({ outcome: "expired", verdict: null, rateLimited: false });
      expect(deliverMock).not.toHaveBeenCalled();
      const rl = await get(late);
      expect([rl.status, rl.attempts, rl.body_sealed, rl.lease_until]).toEqual(["expired", 1, null, null]);
      expect(endedRowFor(claimedLate, l.outcome)).toMatchObject({ id: late, status: "expired" });
      // The control: the other row, same clock, is sent (so the check is not "everything expires").
      expect((await attemptClaimed(claimedFine)).outcome).toBe("sent");
    });

    it("attemptClaimed takes an injected clock too (the test seam): ahead of real time it expires a row early", async () => {
      const id = await queue({ expiresAt: new Date(Date.now() + MIN) });
      const claimed = await claimForRetry(id);
      expect((await attemptClaimed(claimed, { now: new Date(Date.now() + 2 * MIN) })).outcome).toBe("expired");
      expect(deliverMock).not.toHaveBeenCalled();
    });

    it("attemptClaimed in production also ignores a stale injected clock: a row past expiry in real time is expired though the injected time says it is fine", async () => {
      vi.stubEnv("NODE_ENV", "production");
      const id = await queue({ expiresAt: new Date(Date.now() - 5 * MIN) });
      const claimed = await claimForRetry(id);
      const out = await attemptClaimed(claimed, { now: new Date(Date.now() - 30 * MIN) });
      expect(out.outcome).toBe("expired");
      expect(deliverMock).not.toHaveBeenCalled();
    });

    it("attemptClaimed expires a row at exactly expires_at, like the SQL statements do (<=, not <)", async () => {
      const id = await queue({ expiresAt: new Date(Date.now() + 10 * MIN) });
      const claimed = await claimForRetry(id);
      const edge = await attemptClaimed(claimed, { now: claimed.expiresAt });
      expect(edge.outcome).toBe("expired");
      // One millisecond earlier it is still sendable (so the boundary is the line, not a wide margin).
      const id2 = await queue({ expiresAt: new Date(Date.now() + 10 * MIN) });
      const claimed2 = await claimForRetry(id2);
      expect((await attemptClaimed(claimed2, { now: new Date(claimed2.expiresAt.getTime() - 1) })).outcome).toBe("sent");
    });

    it("an expiry found as an attempt begins is fenced like every other write: after a re-claim the stale attempt changes nothing", async () => {
      const id = await queue({ expiresAt: new Date(Date.now() + MIN) });
      const stale = await claimForRetry(id); // attempt 1
      await sql`update email_outbox set attempts = attempts + 1, lease_until = now() + interval '2 minutes' where id = ${id}`; // re-claimed: attempt 2
      const out = await attemptClaimed(stale, { now: new Date(Date.now() + 5 * MIN) });
      expect(out.outcome).toBe("deferred");
      const r = await get(id);
      expect([r.status, r.attempts]).toEqual(["sending", 2]);
      expect(r.body_sealed).not.toBeNull();
    });

    it("the 60 s tolerance, pinned on a frozen Date: exactly 60 s behind is silent, 60.001 s behind logs once", async () => {
      vi.stubEnv("NODE_ENV", "production");
      const T0 = new Date("2026-10-23T12:00:00.000Z");
      const row = (): Promise<string> => queue({ expiresAt: new Date(T0.getTime() + 10 * MIN) });
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(T0);
      const a = await row();
      expect((await dispatchNow([a], { now: new Date(T0.getTime() - 60_000) })).get(a)).toBe("sent");
      expect(logMock.error).not.toHaveBeenCalled();
      const b = await row();
      expect((await dispatchNow([b], { now: new Date(T0.getTime() - 60_001) })).get(b)).toBe("sent");
      expect(logMock.error).toHaveBeenCalledTimes(1);
    });
  });

  // ---- what never leaves the row -------------------------------------------------------------------------------

  describe("secrets", () => {
    it("neither the API key, the sealed text nor the provider's raw detail reaches a row column or a log line (swept over every outcome)", async () => {
      const refId = `${RUN}-${randomUUID()}`;
      const results: DeliverResult[] = [
        { ok: true, providerId: pid("ok") },
        http(500, "internal_server_error", `echo ${API_KEY} ${SECRET}`),
        http(422, "validation_error", `echo ${API_KEY} ${SECRET}`),
        http(409, "invalid_idempotent_request", `echo ${API_KEY} ${SECRET}`),
        { ok: false, reason: "network", detail: "fetch failed (ECONNRESET)" },
      ];
      const ids: string[] = [];
      for (const r of results) {
        const id = await queue({ refId: `${refId}-${ids.length}` });
        ids.push(id);
        deliverMock.mockResolvedValueOnce(r);
      }
      await dispatchNow(ids);
      expect(ids.length).toBe(results.length);
      const dump = (await sql<{ j: string }[]>`select to_jsonb(e)::text as j from email_outbox e where id in ${sql(ids)}`)
        .map((r) => r.j)
        .join("\n");
      // Rows that are queued/sending keep a sealed body, which is bytea: the jsonb text is hex of an envelope.
      for (const needle of [API_KEY, SECRET, "RAW-PROVIDER", "echo "]) expect(dump, needle).not.toContain(needle);
      const logged = JSON.stringify([logMock.error.mock.calls, logMock.warn.mock.calls, warn.mock.calls]);
      for (const needle of [API_KEY, SECRET, "echo "]) expect(logged, needle).not.toContain(needle);
    });
  });
});

// A type-level guard that the ClaimedRow the worker will build is the one attemptClaimed takes.
const _claimed = null as unknown as ClaimedRow;
void _claimed;
