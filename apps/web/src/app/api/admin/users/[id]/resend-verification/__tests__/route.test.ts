// POST /api/admin/users/[id]/resend-verification: staff re-send a user's
// verification email. The link must open the /verify-email PAGE, the page that
// mounts the `VerifyEmail` island.
//
// It used to link to `/api/auth/verify-email?token=…`, the verify API route.
// That route exports only POST, so a person clicking the emailed link sent a
// GET and got a 405, with no screen and no verification. Support's "resend"
// button mailed a dead link every time it was pressed.
//
// This route is now the only producer of a verify link (the password sign-up
// and login that also minted them were removed 2026-10-19). An unverified
// account still exists without a password: the first magic-link request or an
// email invite creates one, unverified until its link is opened.
//
// The expected page is DERIVED, not typed: the link's path must be a page FILE
// whose source mounts `VerifyEmail`. Opening the link goes through the real
// verify page and route (`openVerifyLink`), which also requires a page file.
// Staff auth is real: a seeded support user's session in the cookie jar,
// through the real requireStaff. Stand-ins: the outbox's transport (the one
// network seam: captured, never sent), the limiter, and `next/headers`.
//
// The email goes through the outbox (phase 3 wave 3, kind `email_verification`):
// the token and the row that carries it are one transaction on the pool, the row
// has no organisation, and the first attempt is deferred (a staff action: nobody
// reads the outcome), so each press waits for its row to leave `queued`. What
// was mailed is read back from the transport's calls, and the token it must
// carry from `email_verifications`, never from the route.
//
// /admin is desktop-only staff tooling; this is a server route, with no UI here.
// Sport: not applicable.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import fs from "node:fs";

vi.mock("@/lib/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rate-limit")>()),
  rateLimit: vi.fn(async () => {}),
}));

const jar = vi.hoisted(() => ({ values: new Map<string, string>() }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": "203.0.113.11" }),
  cookies: async () => ({
    get: (name: string) => (jar.values.has(name) ? { name, value: jar.values.get(name)! } : undefined),
    set: (name: string, value: string) => void jar.values.set(name, value),
    delete: (name: string) => void jar.values.delete(name),
  }),
}));

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

// The REAL minter runs, with every argument the route gave it (the transaction handle too, so the token is minted inside the
// route's transaction); this only records what it was asked and what it returned, so the test can prove the route goes through
// `createVerificationToken` (the minter the telemetry scrub tests also drive) and mails ITS token.
const minted = vi.hoisted(() => ({ calls: [] as { userId: string; token: string }[] }));
vi.mock("@/lib/verification", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/verification")>();
  return {
    ...real,
    createVerificationToken: vi.fn(async (...args: Parameters<typeof real.createVerificationToken>) => {
      const token = await real.createVerificationToken(...args);
      minted.calls.push({ userId: args[0], token });
      return token;
    }),
  };
});

// The outbox's one network seam. The rows, the claim and the render are the real ones.
const transport = vi.hoisted(() => ({ deliver: vi.fn() }));
vi.mock("@/server/email-outbox/transport", () => ({ deliver: transport.deliver }));

import { sql } from "@/lib/db";
import { createSession } from "@/lib/auth";
import * as verifyEmailApi from "@/app/api/auth/verify-email/route";
import {
  FIRST_RUN_WIZARD,
  ORIGIN,
  openVerifyLink,
  pageFileFor,
  warmDefaultLanding,
} from "@/app/api/auth/__tests__/_verify-link";
import { makeUser } from "@/server/usecases/__tests__/_registration-fixtures";
import { stubOutboxEnv } from "@/server/usecases/__tests__/_invite-mail";
import { dictionarySubject } from "@/server/email-outbox/__tests__/_kind-harness";
import { POST as resend } from "../route";

const HAS_DB = !!process.env.DATABASE_URL;
const made: string[] = [];
const emailOf = (tag: string) => `resend-${tag}-${randomUUID()}@example.test`;

async function user(tag: string, opts: { staff?: boolean } = {}): Promise<{ id: string; email: string }> {
  const email = emailOf(tag);
  const [u] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified, is_staff, staff_role)
    values (${email}, 'Resend', ${opts.staff === true}, ${opts.staff === true},
            ${opts.staff ? "support" : null})
    returning id`;
  made.push(u.id);
  return { id: u.id, email };
}

type Delivered = { to: string; subject: string; text: string; idempotencyKey: string };
type VerificationRow = {
  id: string; kind: string; ref_type: string; ref_id: string; org_id: string | null; recipient: string;
  recipient_user_id: string | null; transactional: boolean; subject: string; status: string; cleared: boolean;
};

/** The verification rows queued for `userId`, oldest first. */
const verificationRows = (userId: string) =>
  sql<VerificationRow[]>`
    select id, kind, ref_type, ref_id, org_id, recipient, recipient_user_id, transactional, subject, status,
           body_sealed is null as cleared
      from email_outbox where kind = 'email_verification' and ref_type = 'user' and ref_id = ${userId}
     order by created_at, id`;

/** Every message the transport was handed since the last clear. */
const delivered = (): Delivered[] => transport.deliver.mock.calls.map((c) => c[0] as Delivered);
/** The link a person clicks: the URL in the plain-text body. */
const linkIn = (text: string): string => /(https?:\/\/\S+)/.exec(text)![1]!;

/** Staff press "resend" for `targetId`. Returns the status and what was mailed. The first attempt is deferred (a staff action:
 *  nobody reads the outcome), so a press that queued a row waits for that row to leave `queued`/`sending` before reading the mail. */
async function pressResend(staffId: string, targetId: string) {
  transport.deliver.mockClear();
  jar.values.clear();
  await createSession(staffId);
  const res = await resend(
    new Request(`${ORIGIN}/api/admin/users/${targetId}/resend-verification`, { method: "POST" }),
    { params: Promise.resolve({ id: targetId }) },
  );
  jar.values.clear(); // the staff member's session never rides into the link
  const body = (await res.json()) as { ok: boolean; error?: string };
  await vi.waitFor(
    async () => {
      const open = (await verificationRows(targetId)).filter((r) => r.status === "queued" || r.status === "sending");
      if (open.length > 0) throw new Error(`${open.length} verification row(s) still queued or sending`);
    },
    { timeout: 10_000, interval: 50 },
  );
  return { status: res.status, body, mailed: delivered().map((m) => ({ to: m.to, link: linkIn(m.text) })) };
}

async function emailVerified(userId: string): Promise<boolean> {
  const [row] = await sql<{ v: boolean }[]>`select email_verified as v from users where id = ${userId}`;
  return row.v;
}

beforeAll(async () => {
  if (HAS_DB) await warmDefaultLanding();
});

beforeEach(() => {
  minted.calls = [];
  jar.values.clear();
  router.push.mockClear();
  router.refresh.mockClear();
  transport.deliver.mockReset().mockImplementation(async () => ({ ok: true, providerId: `re_rv_${randomUUID()}` }));
  stubOutboxEnv();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

afterAll(async () => {
  if (!HAS_DB || made.length === 0) return;
  await sql`delete from email_outbox where kind = 'email_verification' and ref_type = 'user' and ref_id = any(${made}::text[])`;
  await sql`delete from organizations where created_by = any(${made})`;
  await sql`delete from subscriptions where owner_user_id = any(${made})`;
  await sql`delete from staff_audit_log where actor_id = any(${made})`;
  await sql`delete from users where id = any(${made})`;
});

describe.skipIf(!HAS_DB)("POST /api/admin/users/[id]/resend-verification — the link opens the verify page", () => {
  it("a staff resend queues one verification in the account's language and sends it", async () => {
    const staff = await user("staff", { staff: true });
    const targetId = await makeUser("verify-fr");
    made.push(targetId);
    const [target] = await sql<{ email: string }[]>`
      update users set locale = 'fr', email_verified = false where id = ${targetId} returning email`;
    // The French subject is not the English one, so a route that dropped the account's language would be seen.
    expect(dictionarySubject("fr", "verification.subject", {})).not.toBe(dictionarySubject("en", "verification.subject", {}));

    const pressed = await pressResend(staff.id, targetId);

    expect(pressed.status, JSON.stringify(pressed.body)).toBe(200);
    const rows = await verificationRows(targetId);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row).toMatchObject({
      kind: "email_verification",
      ref_type: "user",
      ref_id: targetId,
      org_id: null,
      recipient: target!.email,
      recipient_user_id: null,
      transactional: true,
      status: "sent",
      cleared: true,
    });
    expect(row.subject).toBe(dictionarySubject("fr", "verification.subject", {}));
    const calls = delivered().filter((m) => m.idempotencyKey === `email-outbox/${row.id}`);
    expect(calls, "one transport call, under the row's own key").toHaveLength(1);
    expect(calls[0]!.to).toBe(target!.email);
    expect(calls[0]!.subject).toBe(dictionarySubject("fr", "verification.subject", {}));
    const tokens = await sql<{ token: string }[]>`select token from email_verifications where user_id = ${targetId}`;
    expect(tokens, "one live verification token").toHaveLength(1);
    expect(calls[0]!.text, "the mail carries that token, on the verify page").toContain(`/verify-email?token=${tokens[0]!.token}`);
  });

  it("mails a link to the /verify-email page, and opening it verifies the account", async () => {
    // The hazard, proven: the API path is not something a browser can open.
    // It has no page file, and its route module exports no GET handler.
    expect(pageFileFor("/api/auth/verify-email")).toBeNull();
    expect(Object.keys(verifyEmailApi)).not.toContain("GET");

    const staff = await user("staff", { staff: true });
    const target = await user("target");

    const pressed = await pressResend(staff.id, target.id);

    expect(pressed.status, JSON.stringify(pressed.body)).toBe(200);
    expect(pressed.mailed.map((m) => m.to)).toEqual([target.email]);
    const link = new URL(pressed.mailed[0]!.link);
    expect(link.origin, "the link points at this deployment").toBe(ORIGIN);
    const pageFile = pageFileFor(link.pathname);
    expect(pageFile, `${link.pathname} is a page a browser can open`).not.toBeNull();
    expect(fs.readFileSync(pageFile!, "utf8"), "and that page mounts the VerifyEmail island").toContain("<VerifyEmail");

    const opened = await openVerifyLink(link.href, router.push);

    expect(opened.landed).toBe(FIRST_RUN_WIZARD);
    expect(await emailVerified(target.id)).toBe(true);
  });

  it("a second resend supersedes the first, and only the newest link works (a third press is refused)", async () => {
    const staff = await user("staff", { staff: true });
    const target = await user("target");

    const first = await pressResend(staff.id, target.id);
    const second = await pressResend(staff.id, target.id);
    expect([first.status, second.status]).toEqual([200, 200]);
    const firstLink = first.mailed[0]!.link;
    const secondLink = second.mailed[0]!.link;
    expect(secondLink).not.toBe(firstLink);

    // One document (the account's verification), restated: the newer row supersedes the older through the replace rule.
    const rows = await verificationRows(target.id);
    expect(rows.map((r) => r.status), "the older row replaced, the newer sent").toEqual(["replaced", "sent"]);
    const tokens = await sql<{ token: string }[]>`select token from email_verifications where user_id = ${target.id}`;
    expect(tokens, "exactly one live token").toHaveLength(1);
    expect(new URL(secondLink).searchParams.get("token"), "and it is the one the newer mail carries").toBe(tokens[0]!.token);

    // The route deletes earlier tokens before minting one, so the first email
    // is dead on arrival and verifies nobody.
    const dead = await openVerifyLink(firstLink, router.push);
    expect(dead.landed, "the superseded link lands nowhere").toBeNull();
    expect(await emailVerified(target.id)).toBe(false);

    router.push.mockClear();
    jar.values.clear();
    const live = await openVerifyLink(secondLink, router.push);
    expect(live.landed).toBe(FIRST_RUN_WIZARD);
    expect(await emailVerified(target.id)).toBe(true);

    const third = await pressResend(staff.id, target.id);
    expect(third.status).toBe(400);
    expect(third.body.error).toBe("Email already verified");
    expect(third.mailed, "nothing mailed once verified").toEqual([]);
    expect(await verificationRows(target.id), "and nothing more queued").toHaveLength(2);
  });

  it("mints through createVerificationToken: stale tokens are gone, one 24h row exists, and the mailed link carries that token", async () => {
    const staff = await user("staff", { staff: true });
    const target = await user("target");
    // Two stale tokens from earlier presses: the route must clear them, not add a third beside them.
    const stale = [`stale-${randomUUID()}`, `stale-${randomUUID()}`];
    for (const token of stale) {
      await sql`insert into email_verifications (user_id, token, expires_at) values (${target.id}, ${token}, now() + interval '1 hour')`;
    }

    const before = Date.now();
    const pressed = await pressResend(staff.id, target.id);
    const after = Date.now();

    expect(pressed.status, JSON.stringify(pressed.body)).toBe(200);
    expect(minted.calls, "one mint, for the target user").toHaveLength(1);
    expect(minted.calls[0]!.userId).toBe(target.id);
    const rows = await sql<{ token: string; expires_at: string }[]>`
      select token, expires_at from email_verifications where user_id = ${target.id}`;
    expect(rows.map((r) => r.token), "the stale tokens are gone; only the minted one remains").toEqual([minted.calls[0]!.token]);
    // The 24-hour life of a verification link (kept from the inline minting this replaced).
    const lifeMs = new Date(rows[0]!.expires_at).getTime();
    expect(lifeMs).toBeGreaterThanOrEqual(before + 24 * 3600_000 - 1000);
    expect(lifeMs).toBeLessThanOrEqual(after + 24 * 3600_000 + 1000);
    expect(new URL(pressed.mailed[0]!.link).searchParams.get("token"), "the mailed link carries the minted token").toBe(
      minted.calls[0]!.token,
    );
    for (const token of stale) {
      expect((await openVerifyLink(`${ORIGIN}/verify-email?token=${token}`, router.push)).landed, "a stale token verifies nobody").toBeNull();
    }
    expect(await emailVerified(target.id)).toBe(false);
  });

  it("empty: an already-verified account or an unknown id queues nothing (and a deleted account is unknown)", async () => {
    const staff = await user("staff", { staff: true });
    const verified = await user("verified", { staff: true }); // staff rows are seeded verified
    const gone = await user("gone");
    await sql`update users set deleted_at = now() where id = ${gone.id}`;

    const cases = [
      { id: randomUUID(), status: 404 },
      { id: gone.id, status: 404 },
      { id: verified.id, status: 400 },
    ];
    let driven = 0;
    for (const c of cases) {
      driven += 1;
      const pressed = await pressResend(staff.id, c.id);
      expect(pressed.status, `target ${c.id}`).toBe(c.status);
      expect(pressed.mailed, "nothing mailed").toEqual([]);
      expect(await verificationRows(c.id), `target ${c.id}: no row queued`).toEqual([]);
    }
    expect(minted.calls, "nothing minted").toEqual([]);
    expect(driven, "anti-vacuity: every refusal was driven").toBe(3);
  });
});
