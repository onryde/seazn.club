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
// through the real requireStaff. Stand-ins: the mail sender (captured, never
// sent), the limiter, and `next/headers`.
//
// /admin is desktop-only staff tooling; this is a server route, with no UI here.
// Sport: not applicable.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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

const mail = vi.hoisted(() => ({ sent: [] as { to: string; link: string }[] }));
vi.mock("@/lib/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email")>()),
  sendVerificationEmail: vi.fn(async (to: string, link: string) => {
    mail.sent.push({ to, link });
    return true;
  }),
}));

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

/** Staff press "resend" for `targetId`. Returns the status and what was mailed. */
async function pressResend(staffId: string, targetId: string) {
  mail.sent = [];
  jar.values.clear();
  await createSession(staffId);
  const res = await resend(
    new Request(`${ORIGIN}/api/admin/users/${targetId}/resend-verification`, { method: "POST" }),
    { params: Promise.resolve({ id: targetId }) },
  );
  jar.values.clear(); // the staff member's session never rides into the link
  const body = (await res.json()) as { ok: boolean; error?: string };
  return { status: res.status, body, mailed: [...mail.sent] };
}

async function emailVerified(userId: string): Promise<boolean> {
  const [row] = await sql<{ v: boolean }[]>`select email_verified as v from users where id = ${userId}`;
  return row.v;
}

beforeAll(async () => {
  if (HAS_DB) await warmDefaultLanding();
});

beforeEach(() => {
  jar.values.clear();
  router.push.mockClear();
  router.refresh.mockClear();
});

afterAll(async () => {
  if (!HAS_DB || made.length === 0) return;
  await sql`delete from organizations where created_by = any(${made})`;
  await sql`delete from subscriptions where owner_user_id = any(${made})`;
  await sql`delete from staff_audit_log where actor_id = any(${made})`;
  await sql`delete from users where id = any(${made})`;
});

describe.skipIf(!HAS_DB)("POST /api/admin/users/[id]/resend-verification — the link opens the verify page", () => {
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

  it("a second resend kills the first link, the second link verifies, and a third press is refused", async () => {
    const staff = await user("staff", { staff: true });
    const target = await user("target");

    const first = await pressResend(staff.id, target.id);
    const second = await pressResend(staff.id, target.id);
    expect([first.status, second.status]).toEqual([200, 200]);
    const firstLink = first.mailed[0]!.link;
    const secondLink = second.mailed[0]!.link;
    expect(secondLink).not.toBe(firstLink);

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
  });
});
