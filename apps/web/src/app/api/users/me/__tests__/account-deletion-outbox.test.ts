// Final review M3: deleting an account must take the address out of the email outbox. `users.email` is anonymised and the account is
// purged after 30 days, but `email_outbox` has no foreign key to users: the sign-in emails (`magic_link`, ref `user/<id>`, recipient the
// real address) would stay for the outbox's 90-day retention, three times as long as the account itself.
//
// Driven end to end against a real Postgres: the REAL magic-link route writes the account's outbox row (the producer), the REAL
// DELETE /api/users/me removes it (the consumer). Only the session half of auth, the account-deletion email, the rate limiter and
// `next/headers` are stand-ins, and global `fetch` (the Resend call) via the shared outbox harness.
//
// Which role runs the deletion: the handler's `sql` is the pooled PRIVILEGED client (no `withTenant`, no `app_user`): `app_user` holds
// INSERT only on `email_outbox` (V470), so a tenant transaction could not delete, and this one can. The "rows are gone" tests below are
// the proof: a deletion that ran as `app_user` would be refused (42501) and the account would not be deleted.
//
// Which rows are the account's (N-B): `users.email` is unique but CASE-SENSITIVE (`Ann@x.io` and `ann@x.io` are two live accounts), and
// the outbox stores a recipient exactly as the producer was given it (the sign-in route resolves the account by `email = $1`, so the
// address it queues IS the account's address, byte for byte). So the match is by the account's ref and by the address EXACTLY: a
// case-folded match deleted the queued sign-in email of a separate live account whose address differs only in case.
//
// The `chess_invite` rows addressed to the account are not deleted here: they are anonymised, and that has its own file
// (account-deletion-chess-invite.test.ts).
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
vi.mock("@/lib/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email")>()),
  sendAccountDeletionEmail: vi.fn(async () => {}),
}));
vi.mock("@/lib/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rate-limit")>()),
  rateLimit: vi.fn(async () => {}),
}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": "203.0.113.78" }),
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
}));

import { sql } from "@/lib/db";
import { DELETE } from "@/app/api/users/me/route";
import { POST as MAGIC_LINK } from "@/app/api/auth/magic-link/route";
import { enqueueEmail, type OutboxMessage } from "@/server/email-outbox/enqueue";
import { stubOutboxEnv } from "@/server/usecases/__tests__/_invite-mail";

const HAS_DB = !!process.env.DATABASE_URL;
const RUN = `adel-${randomUUID().slice(0, 8)}`;
const MIN = 60_000;

const del = () =>
  DELETE(new Request("http://test.local/api/users/me", { method: "DELETE", body: JSON.stringify({ confirm: "DELETE" }) }));
const signIn = (email: string) =>
  MAGIC_LINK(
    new Request("https://signin.test/api/auth/magic-link", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    }),
  );

const address = (tag: string): string => `${RUN}-${tag}-${randomUUID().slice(0, 6)}@del.test`;
const userIdOf = async (email: string): Promise<string> => (await sql<{ id: string }[]>`select id from users where email = ${email}`)[0]!.id;
const outboxIds = async (ids: string[]): Promise<Set<string>> =>
  new Set((await sql<{ id: string }[]>`select id from email_outbox where id = any(${ids}::uuid[])`).map((r) => r.id));
const accountOf = async (id: string) =>
  (await sql<{ email: string; deleted_at: Date | null }[]>`select email, deleted_at from users where id = ${id}`)[0]!;

/** Seed a row through the real writer. Ref and recipient are the test's choice: they are what the deletion's match is about. */
function seedRow(over: Partial<OutboxMessage>): Promise<string> {
  return enqueueEmail(sql, {
    kind: "magic_link",
    refType: "user",
    refId: randomUUID(),
    orgId: null,
    to: address("x"),
    subject: "Your sign-in link",
    html: "<p>link</p>",
    text: "link",
    transactional: true,
    expiresAt: new Date(Date.now() + 15 * MIN),
    ...over,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  stubOutboxEnv();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
afterAll(async () => {
  if (HAS_DB) {
    await sql`delete from email_outbox where recipient like ${`${RUN}-%`} or ref_id like ${`${RUN}-%`}`;
    await sql.end({ timeout: 2 }).catch(() => undefined);
  }
});

type Scene = {
  userId: string;
  email: string;
  /** Rows that hold the leaver's address and must be gone, by why they match. */
  mustGo: { why: string; id: string }[];
  /** Rows that must stay, by why. */
  mustStay: { why: string; id: string }[];
};

/** An account with its outbox history, written by the real sign-in route and by the real writer. */
async function scene(): Promise<Scene> {
  const email = address("leaver");
  expect((await signIn(email)).status, "premise: the real route accepted the sign-in").toBe(200);
  const userId = await userIdOf(email);
  authState.user = { id: userId, email, locale: null };
  const [produced] = await sql<{ id: string }[]>`select id from email_outbox where kind = 'magic_link' and ref_id = ${userId}`;
  expect(produced, "premise: the real sign-in route wrote the account's outbox row").toBeDefined();

  const other = address("other");
  expect((await signIn(other)).status).toBe(200);
  const otherId = await userIdOf(other);
  const [otherProduced] = await sql<{ id: string }[]>`select id from email_outbox where kind = 'magic_link' and ref_id = ${otherId}`;

  // A SEPARATE live account whose address differs from the leaver's only in case, signed in through the real route (N-B).
  const shouted = email.toUpperCase();
  expect(shouted, "premise: a different string for the same mailbox").not.toBe(email);
  expect((await signIn(shouted)).status).toBe(200);
  const shoutedId = await userIdOf(shouted);
  expect(shoutedId, "premise: it is a different account, not the leaver's").not.toBe(userId);
  const [shoutedProduced] = await sql<{ id: string }[]>`select id from email_outbox where kind = 'magic_link' and ref_id = ${shoutedId}`;

  return {
    userId,
    email,
    mustGo: [
      { why: "the row the real sign-in route wrote (ref user/<id>, the account's address)", id: produced!.id },
      { why: "the address under another ref, exactly as stored (a previous owner of the address)", id: await seedRow({ refId: randomUUID(), to: email }) },
      { why: "the account's ref with an OLD address (the account changed its email since)", id: await seedRow({ refId: userId, to: address("old") }) },
    ],
    mustStay: [
      { why: "another account's sign-in row, written by the real route", id: otherProduced!.id },
      { why: "another account's row under a different ref and address", id: await seedRow({ refId: randomUUID(), to: address("else") }) },
      { why: "the sign-in row of a separate live account whose address differs only in case, written by the real route (N-B)", id: shoutedProduced!.id },
      { why: "the address in another case, under another ref (a mailbox the leaver's account does not own)", id: await seedRow({ refId: randomUUID(), to: shouted }) },
    ],
  };
}

describe.skipIf(!HAS_DB)("deleting an account removes its sign-in emails from the outbox (final review M3)", () => {
  it("every sign-in row that holds the leaver's address is gone; another account's rows and a case-variant account's rows stay", async () => {
    const s = await scene();
    const before = await outboxIds([...s.mustGo, ...s.mustStay].map((r) => r.id));
    expect(before.size, "premise: every seeded row exists").toBe(s.mustGo.length + s.mustStay.length);

    const res = await del();
    expect(res.status).toBe(200);
    expect((await accountOf(s.userId)).deleted_at, "premise: the account really was deleted").not.toBeNull();

    const after = await outboxIds([...s.mustGo, ...s.mustStay].map((r) => r.id));
    for (const r of s.mustGo) expect(after.has(r.id), `gone: ${r.why}`).toBe(false);
    for (const r of s.mustStay) expect(after.has(r.id), `stays: ${r.why}`).toBe(true);
    expect(s.mustGo.length, "anti-vacuity: three ways of matching were exercised").toBe(3);
    expect(s.mustStay.length, "anti-vacuity: four kinds of bystander were exercised").toBe(4);
  });

  it("an account whose stored address has capitals: only rows addressed to it EXACTLY go; the same letters in another case are another account's (N-B)", async () => {
    const mixed = `${RUN}-Mixed.Case-${randomUUID().slice(0, 6)}@Del.test`;
    expect(mixed, "premise: the address has capitals to fold").not.toBe(mixed.toLowerCase());
    const [{ id }] = await sql<{ id: string }[]>`insert into users (email, display_name, email_verified) values (${mixed}, 'Mixed', true) returning id`;
    authState.user = { id, email: mixed, locale: null };
    // Under other refs, so only the address can reach them.
    const exact = await seedRow({ refId: randomUUID(), to: mixed });
    const others = [
      await seedRow({ refId: randomUUID(), to: mixed.toLowerCase() }),
      await seedRow({ refId: randomUUID(), to: mixed.toUpperCase() }),
      await seedRow({ refId: randomUUID(), to: address("bystander") }),
    ];
    expect((await outboxIds([exact, ...others])).size, "premise: all seeded").toBe(1 + others.length);

    expect((await del()).status).toBe(200);
    const left = await outboxIds([exact, ...others]);
    expect(left.has(exact), "the row addressed to the account exactly as it is stored is gone").toBe(false);
    expect([...left].sort(), "and the rest are all still there").toEqual([...others].sort());
  });

  it("the sequence: a second deletion changes nothing and does not fail; an account with no sign-in rows deletes as before", async () => {
    const s = await scene();
    expect((await del()).status).toBe(200);
    const stay = await outboxIds(s.mustStay.map((r) => r.id));
    expect((await del()).status, "a retried deletion").toBe(200);
    expect(await outboxIds(s.mustStay.map((r) => r.id)), "and still touches nobody else").toEqual(stay);

    const bare = address("bare");
    const [{ id: bareId }] = await sql<{ id: string }[]>`insert into users (email, display_name, email_verified) values (${bare}, 'Bare', true) returning id`;
    authState.user = { id: bareId, email: bare, locale: null };
    expect((await del()).status).toBe(200);
    expect((await accountOf(bareId)).deleted_at).not.toBeNull();
  });

  it("a REFUSED deletion keeps the rows: the account is kept, so its sign-in history is", async () => {
    const s = await scene();
    // Sole owner of an organisation that has another member: the handler's own 409, before anything is erased.
    const o = randomUUID().slice(0, 8);
    const [{ id: orgId }] = await sql<{ id: string }[]>`insert into organizations (name, slug, created_by) values (${"Keep " + o}, ${"keep-" + o}, ${s.userId}) returning id`;
    const [{ id: memberId }] = await sql<{ id: string }[]>`insert into users (email, display_name, email_verified) values (${address("member")}, 'Member', true) returning id`;
    await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${s.userId}, 'owner'), (${orgId}, ${memberId}, 'viewer')`;

    expect((await del()).status).toBe(409);
    expect((await accountOf(s.userId)).deleted_at).toBeNull();
    const after = await outboxIds(s.mustGo.map((r) => r.id));
    expect(after.size, "every row is still there").toBe(s.mustGo.length);
  });

  it("the erasure and the anonymisation are one transaction: an outbox that refuses the delete leaves the account whole, and a retry completes it", async () => {
    const s = await scene();
    const fn = `adel_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
    await sql.unsafe(`create function ${fn}() returns trigger language plpgsql as $$ begin raise exception 'staged: outbox delete refused'; end $$`);
    await sql.unsafe(
      `create trigger ${fn} before delete on email_outbox for each row when (lower(old.recipient) = '${s.email.toLowerCase().replaceAll("'", "''")}') execute function ${fn}()`,
    );
    try {
      expect((await del()).status, "the deletion fails loudly rather than keep the address behind an anonymised account").toBe(500);
      const kept = await accountOf(s.userId);
      expect([kept.email, kept.deleted_at], "the account is exactly as it was").toEqual([s.email, null]);
      expect((await outboxIds(s.mustGo.map((r) => r.id))).size).toBe(s.mustGo.length);
    } finally {
      await sql.unsafe(`drop trigger if exists ${fn} on email_outbox`);
      await sql.unsafe(`drop function if exists ${fn}()`);
    }
    expect((await del()).status, "the retry completes the deletion").toBe(200);
    expect((await accountOf(s.userId)).deleted_at).not.toBeNull();
    expect((await outboxIds(s.mustGo.map((r) => r.id))).size).toBe(0);
  });
});
