// D5 (plan phase 3 wave 1, T5): deleting an account ends and scrubs the account's OWN rows in the email outbox, and only those.
//
// WHICH ROWS ARE THE ACCOUNT'S (spec D5, F3, FU2):
//   - a row that carries `recipient_user_id = <the account>`, whatever address it was queued to: the account may have changed its
//     address since (F3), so the old address is no way to find it;
//   - a `chess_invite` queued BEFORE wave 1, which carries no user id, addressed to the address EXACTLY as `users.email` stores it
//     (FU2: `users.email` is unique but case-sensitive, so `Ann@x.io` and `ann@x.io` are two accounts and a folded match would reach
//     the other one's rows);
//   - mail ABOUT the account (wave 3: its verification and its email change), found by its ref `user / <the account>`: a literal-address
//     kind that names no account, at whatever address (the confirmation goes to the NEW address);
//   - the account's `magic_link` rows (by ref, or by that exact address), which are deleted outright as before.
// NOT the account's, whatever address they hold: any other literal-address kind (`registration_confirmation`, an org's invite ...) queued
// to that address. It was written for an entry, a payment, a refund or an invite that belongs to an organiser's books, not to the account
// (D5).
//
// WHAT HAPPENS TO THE ACCOUNT'S ROWS: the ones still `queued` end `expired` / `account_deleted`, body and lease gone, and are handed
// back for the kind's hook; EVERY matching row, whatever its status, then has its recipient replaced by the account's placeholder.
//
// Driven end to end against a real Postgres through the REAL DELETE /api/users/me. Only Stripe, the session half of auth, the rate
// limiter and `next/headers` are stand-ins. The expected placeholder is typed here from the rule
// (`deleted-<id>@deleted.invalid`), never read back from the code under test.
//
// Sport: not applicable. Account deletion is sport-agnostic, and the only kind that is addressed to an account is the chess invite.
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
  headers: async () => new Headers({ "x-forwarded-for": "203.0.113.79" }),
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
}));
// What the route hands to the kind hooks after the commit: the real hook still runs, the spy only records which rows it was given.
const handed = vi.hoisted(() => ({ calls: [] as { id: string; kind: string; status: string }[][] }));
vi.mock("@/server/email-outbox", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/email-outbox")>();
  return {
    ...actual,
    afterEndedBadly: vi.fn(async (rows: Parameters<typeof actual.afterEndedBadly>[0]) => {
      handed.calls.push(rows.map((r) => ({ id: r.id, kind: r.kind, status: r.status })));
      return actual.afterEndedBadly(rows);
    }),
  };
});

import { sql, type Tx } from "@/lib/db";
import { DELETE } from "@/app/api/users/me/route";
import { OUTBOX_STATUSES, RETRYABLE_STATUSES, enqueueEmail, type OutboxKind, type OutboxStatus } from "@/server/email-outbox";
import { accountMail, anonymiseAccountEmails, legacyInviteAt, namesAccount } from "@/server/email-outbox/account-deletion";
import { CHESS_SEAT_REF_TYPE, chessSeatRef } from "@/server/usecases/external-play/seat-stamp";
import { stubOutboxEnv } from "@/server/usecases/__tests__/_invite-mail";

const HAS_DB = !!process.env.DATABASE_URL;
const RUN = `adsw-${randomUUID().slice(0, 8)}`;
const MIN = 60_000;

const del = () =>
  DELETE(new Request("http://test.local/api/users/me", { method: "DELETE", body: JSON.stringify({ confirm: "DELETE" }) }));
const address = (tag: string): string => `${RUN}-${tag}-${randomUUID().slice(0, 6)}@del.test`;
/** The address a deleted account is left with, typed from the rule (RFC 6761 reserved TLD; the id keeps two accounts apart). */
const placeholderOf = (userId: string): string => `deleted-${userId}@deleted.invalid`;

const made = { rows: [] as string[], users: [] as string[] };

beforeEach(() => {
  vi.clearAllMocks();
  handed.calls.length = 0;
  stubOutboxEnv();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
afterAll(async () => {
  if (HAS_DB) {
    await sql`
      delete from email_outbox
       where recipient like ${`${RUN}-%`} or recipient like ${`${RUN.toUpperCase()}-%`}
          or id = any(${made.rows}::uuid[])
          or recipient = any(${made.users.map(placeholderOf)}::text[])`;
    await sql.end({ timeout: 2 }).catch(() => undefined);
  }
});

type Row = {
  id: string;
  kind: string;
  recipient: string;
  recipient_user_id: string | null;
  status: OutboxStatus;
  last_error: string | null;
  has_body: boolean;
  has_lease: boolean;
  status_at: Date;
};
const rowsByIds = (ids: readonly string[]) =>
  sql<Row[]>`
    select id, kind, recipient, recipient_user_id, status, last_error, body_sealed is not null as has_body,
           lease_until is not null as has_lease, status_at
      from email_outbox where id = any(${ids as string[]}::uuid[]) order by id`;
const rowOf = async (id: string): Promise<Row> => (await rowsByIds([id]))[0]!;
const accountOf = async (id: string) =>
  (await sql<{ email: string; deleted_at: Date | null }[]>`select email, deleted_at from users where id = ${id}`)[0]!;

async function seedUser(email: string, name: string): Promise<string> {
  const [{ id }] = await sql<{ id: string }[]>`insert into users (email, display_name, email_verified) values (${email}, ${name}, true) returning id`;
  made.users.push(id);
  return id;
}

/** One chess invite for `to` on a fresh seat ref (so the replace rule supersedes nothing), through the real writer. `userId` is the
 *  account it is for; leave it out to write what phase 1 wrote, a row with an address and no account. */
async function chess(to: string, userId?: string): Promise<string> {
  const fixtureId = randomUUID();
  const id = await enqueueEmail(sql, {
    kind: "chess_invite",
    refType: CHESS_SEAT_REF_TYPE,
    refId: chessSeatRef(fixtureId, "white"),
    orgId: null,
    to,
    subject: "Your chess game",
    html: "<p>play</p>",
    text: "play",
    transactional: true,
    expiresAt: new Date(Date.now() + 60 * MIN),
    meta: { fixtureId, colour: "white", stampedAt: new Date().toISOString() },
    ...(userId ? { recipientUserId: userId } : {}),
  });
  made.rows.push(id);
  return id;
}

/** A row of a LITERAL-address kind (never carries an account id), through the real writer. */
async function literal(kind: Exclude<OutboxKind, "chess_invite">, to: string, refId: string = randomUUID()): Promise<string> {
  const id = await enqueueEmail(sql, {
    kind,
    refType: kind === "magic_link" ? "user" : "registration",
    refId,
    orgId: null,
    to,
    subject: "A subject",
    html: "<p>x</p>",
    text: "x",
    transactional: kind === "magic_link",
    expiresAt: new Date(Date.now() + 15 * MIN),
  });
  made.rows.push(id);
  return id;
}

/** A row of a wave-3 literal kind (account mail, or an org's invite), through the real writer on a transaction of the pool, as its producer
 *  writes it: no organisation, no account id. */
async function accountMailRow(kind: OutboxKind, refType: string, refId: string, to: string): Promise<string> {
  const id = await sql.begin((tx) =>
    enqueueEmail(tx, {
      kind,
      refType,
      refId,
      orgId: null,
      to,
      subject: "A subject",
      html: "<p>x</p>",
      text: "x",
      transactional: kind !== "org_invite",
      expiresAt: new Date(Date.now() + 60 * MIN),
    }),
  );
  made.rows.push(id);
  return id;
}

/** Move a freshly written (queued) row to `status`, keeping every V470 CHECK true: a body only while retryable, a lease exactly while sending. */
async function put(id: string, status: OutboxStatus): Promise<void> {
  if (status === "queued") return;
  await sql`
    update email_outbox
       set status = ${status}::text,
           body_sealed = case when ${status}::text = any(${RETRYABLE_STATUSES as string[]}::text[]) then body_sealed else null end,
           lease_until = case when ${status}::text = 'sending' then now() + interval '2 minutes' end,
           attempts = 1
     where id = ${id}`;
}

/** What deleting the account does to a row of its own, by the status it is in. A `Record` over every status, so a thirteenth status is
 *  a compile error here until someone decides what deletion does to it. */
const STATUS_AFTER_DELETION: Record<OutboxStatus, OutboxStatus> = {
  queued: "expired",
  sending: "sending",
  sent: "sent",
  delayed: "delayed",
  delivered: "delivered",
  bounced: "bounced",
  complained: "complained",
  failed: "failed",
  suppressed: "suppressed",
  expired: "expired",
  dead: "dead",
  replaced: "replaced",
};

describe.skipIf(!HAS_DB)("deleting an account ends and scrubs the account's own outbox rows (D5)", () => {
  it("the account's rows end and lose the address; a literal-kind row, a case-variant legacy row and another account's row are left alone", async () => {
    const email = `${RUN}-Leaver.Mixed-${randomUUID().slice(0, 6)}@Del.test`;
    expect(email, "premise: the address has capitals, so its upper-case form is another string").not.toBe(email.toUpperCase());
    const leaverId = await seedUser(email, "Leaver");
    const otherEmail = address("other");
    const otherId = await seedUser(otherEmail, "Other");
    authState.user = { id: leaverId, email, locale: null };

    // 1. queued, for the account, at an address the account no longer has (F3: it changed its address after the invite was queued).
    const r1 = await chess(address("old"), leaverId);
    // 2. already sent, for the account, also at an address it no longer has.
    const r2 = await chess(address("old"), leaverId);
    await put(r2, "sent");
    // 3. a pre-wave-1 invite (no account id) at the account's address exactly.
    const r3 = await chess(email);
    // 4. a pre-wave-1 invite at the same letters in another case: a mailbox the account does not own (FU2).
    const r4 = await chess(email.toUpperCase());
    // 5. a registration confirmation queued to the account's address: the entry belongs to the organiser's books (D5).
    const r5 = await literal("registration_confirmation", email);
    // 6. the account's sign-in link, by ref.
    const r6 = await literal("magic_link", email, leaverId);
    // 7. another account's queued invite.
    const r7 = await chess(otherEmail, otherId);
    const all = [r1, r2, r3, r4, r5, r6, r7];
    const before = new Map((await rowsByIds(all)).map((r) => [r.id, r]));
    expect(before.size, "premise: all seven rows exist").toBe(7);
    expect(before.get(r1)!.status, "premise: row 1 is queued").toBe("queued");
    expect(before.get(r1)!.recipient_user_id, "premise: row 1 carries the account").toBe(leaverId);
    expect(before.get(r1)!.recipient, "premise: row 1 does NOT hold the account's current address").not.toBe(email);
    expect(before.get(r2)!.status, "premise: row 2 is sent").toBe("sent");
    expect(before.get(r3)!.recipient_user_id, "premise: row 3 is a legacy row, no account id").toBeNull();

    const res = await del();
    expect(res.status).toBe(200);
    const gone = await accountOf(leaverId);
    expect(gone.deleted_at, "premise: the account really was deleted").not.toBeNull();
    expect(gone.email, "premise: the account holds the same placeholder").toBe(placeholderOf(leaverId));

    const after = new Map((await rowsByIds(all)).map((r) => [r.id, r]));
    let checked = 0;

    const a1 = after.get(r1)!;
    expect(a1.status, "row 1 (queued, the account's, an old address) ends").toBe("expired");
    expect(a1.last_error).toBe("account_deleted");
    expect([a1.has_body, a1.has_lease], "the unsent body and the lease are gone with the send").toEqual([false, false]);
    expect(a1.recipient, "and the old address is gone from it").toBe(placeholderOf(leaverId));
    expect(a1.status_at.getTime(), "the ending is stamped").toBeGreaterThan(before.get(r1)!.status_at.getTime());
    checked += 1;

    const a2 = after.get(r2)!;
    expect(a2.status, "row 2 (sent) keeps its status").toBe("sent");
    expect(a2.recipient, "and loses the address").toBe(placeholderOf(leaverId));
    expect(a2.last_error).toBe(before.get(r2)!.last_error);
    expect(a2.status_at.getTime(), "only the address changed").toBe(before.get(r2)!.status_at.getTime());
    checked += 1;

    const a3 = after.get(r3)!;
    expect(a3.status, "row 3 (a legacy row at the account's exact address) ends").toBe("expired");
    expect(a3.last_error).toBe("account_deleted");
    expect(a3.recipient).toBe(placeholderOf(leaverId));
    checked += 1;

    expect(after.get(r4), "row 4 (the same letters in another case) is untouched (FU2)").toEqual(before.get(r4));
    checked += 1;
    expect(after.get(r5), "row 5 (a registration confirmation to that address) is untouched, still queued, still its own address (D5)").toEqual(before.get(r5));
    expect(after.get(r5)!.status).toBe("queued");
    expect(after.get(r5)!.recipient).toBe(email);
    checked += 1;
    expect(after.has(r6), "row 6 (the account's sign-in link) is gone").toBe(false);
    checked += 1;
    expect(after.get(r7), "row 7 (another account's queued invite) is untouched").toEqual(before.get(r7));
    checked += 1;
    expect(checked, "anti-vacuity: all seven rows were read back").toBe(7);

    expect(handed.calls.length, "the route handed the ended rows to the hooks once, after the commit").toBe(1);
    expect(handed.calls[0]!.map((e) => e.id).sort(), "the ended count is 2: rows 1 and 3, and no others").toEqual([r1, r3].sort());
    expect(handed.calls[0]!.every((e) => e.kind === "chess_invite" && e.status === "expired")).toBe(true);
  });

  it("every status of an account's own row is scrubbed, and only a queued one ends; another account's row of the same status is untouched", async () => {
    const email = address("statuses");
    const leaverId = await seedUser(email, "Statuses");
    const bystanderEmail = address("bystander");
    const bystanderId = await seedUser(bystanderEmail, "Bystander");
    authState.user = { id: leaverId, email, locale: null };

    // The account's rows sit at an address it no longer has, so only the account id can reach them.
    const mine: { id: string; status: OutboxStatus }[] = [];
    const theirs: string[] = [];
    for (const status of OUTBOX_STATUSES) {
      const id = await chess(address("old"), leaverId);
      await put(id, status);
      mine.push({ id, status });
      const other = await chess(bystanderEmail, bystanderId);
      await put(other, status);
      theirs.push(other);
    }
    expect(mine.length, "anti-vacuity: every status was seeded").toBe(OUTBOX_STATUSES.length);
    const beforeMine = new Map((await rowsByIds(mine.map((m) => m.id))).map((r) => [r.id, r]));
    const beforeTheirs = new Map((await rowsByIds(theirs)).map((r) => [r.id, r]));
    for (const m of mine) expect(beforeMine.get(m.id)!.status, "premise: the row is in the status under test").toBe(m.status);

    expect((await del()).status).toBe(200);

    let checked = 0;
    for (const r of await rowsByIds(mine.map((m) => m.id))) {
      const was = beforeMine.get(r.id)!;
      expect(r.recipient, `${was.status}: the address is replaced`).toBe(placeholderOf(leaverId));
      expect(r.status, `${was.status}: its status after deletion`).toBe(STATUS_AFTER_DELETION[was.status]);
      if (was.status !== "queued") {
        expect(r.last_error, `${was.status}: last_error untouched`).toBe(was.last_error);
        expect(r.status_at.getTime(), `${was.status}: status_at untouched`).toBe(was.status_at.getTime());
      }
      checked += 1;
    }
    expect(checked, "anti-vacuity: every one of the account's rows was read back").toBe(OUTBOX_STATUSES.length);
    let bystanders = 0;
    for (const r of await rowsByIds(theirs)) {
      expect(r, "another account's row is untouched").toEqual(beforeTheirs.get(r.id));
      bystanders += 1;
    }
    expect(bystanders, "anti-vacuity: every bystander row was read back").toBe(OUTBOX_STATUSES.length);
    expect(handed.calls.flat().length, "only the queued row was ended and handed to the hooks").toBe(1);
  });

  it("a legacy row is matched only while it has no account: another account's row that holds this address is not this account's", async () => {
    // Account V once used the address that account U now holds. V's old invite still carries V's id and that address. Deleting U must
    // not end it: the address alone says nothing about a row that names a different account.
    const uEmail = address("holder");
    const uId = await seedUser(uEmail, "Holder");
    const vEmail = address("mover");
    const vId = await seedUser(vEmail, "Mover");
    authState.user = { id: uId, email: uEmail, locale: null };
    const vsRow = await chess(uEmail, vId); // V's row, at U's exact address
    const legacyRow = await chess(uEmail); // a true legacy row at U's exact address
    const vsBefore = await rowOf(vsRow);

    expect((await del()).status).toBe(200);
    expect(await rowOf(vsRow), "V's row names V, so U's deletion does not touch it").toEqual(vsBefore);
    expect((await rowOf(legacyRow)).status, "the legacy row at the address is U's and ends").toBe("expired");
    expect((await rowOf(legacyRow)).recipient).toBe(placeholderOf(uId));
    expect((await accountOf(vId)).deleted_at, "V is still live").toBeNull();
  });

  it("the account's own verification and email-change mail is ended and scrubbed; an org's invite to the same address is not", async () => {
    // Wave 3's account mail is addressed to a literal address and names no account (`recipient_user_id` is null), so neither arm above
    // reaches it. It is ABOUT the account, though: its ref is `user / <the account>`. An org's invite to the same address is the org's.
    const email = address("own-mail");
    const userId = await seedUser(email, "Own Mail");
    const otherEmail = address("own-mail-other");
    const otherId = await seedUser(otherEmail, "Own Mail Other");
    authState.user = { id: userId, email, locale: null };

    const r1 = await accountMailRow("email_verification", "user", userId, email);
    const r2 = await accountMailRow("email_change_confirmation", "user", userId, address("new"));
    const r3 = await accountMailRow("email_change_notice", "user", userId, email);
    await put(r3, "sent");
    const r4 = await accountMailRow("org_invite", "org_invite", randomUUID(), email);
    const r5 = await accountMailRow("email_verification", "user", otherId, otherEmail);
    const all = [r1, r2, r3, r4, r5];
    const before = new Map((await rowsByIds(all)).map((r) => [r.id, r]));
    expect(before.size, "premise: all five rows exist").toBe(5);
    expect([r1, r2, r4, r5].map((id) => before.get(id)!.status), "premise: rows 1, 2, 4 and 5 are queued").toEqual(["queued", "queued", "queued", "queued"]);
    expect(before.get(r3)!.status, "premise: row 3 is sent").toBe("sent");
    expect(all.map((id) => before.get(id)!.recipient_user_id), "premise: every one is a literal-address row, naming no account").toEqual([null, null, null, null, null]);

    expect((await del()).status).toBe(200);
    const gone = await accountOf(userId);
    expect(gone.deleted_at, "premise: the account really was deleted").not.toBeNull();
    expect(gone.email, "premise: the account's address was replaced").not.toBe(email);

    const after = new Map((await rowsByIds(all)).map((r) => [r.id, r]));
    let checked = 0;
    for (const [id, what] of [[r1, "row 1 (its queued verification)"], [r2, "row 2 (its queued email-change confirmation, to the new address)"]] as const) {
      const a = after.get(id)!;
      expect(a.status, `${what} ends`).toBe("expired");
      expect(a.last_error).toBe("account_deleted");
      expect(a.has_body, `${what}: the unsent body is gone`).toBe(false);
      expect(a.recipient, `${what}: the address is the deleted account's own`).toBe(gone.email);
      checked += 1;
    }
    const a3 = after.get(r3)!;
    expect(a3.status, "row 3 (its sent email-change notice) keeps its status").toBe("sent");
    expect(a3.recipient, "and loses the address").toBe(gone.email);
    checked += 1;
    expect(after.get(r4), "row 4 (an org's invite to the same address) is untouched (D5)").toEqual(before.get(r4));
    checked += 1;
    expect(after.get(r5), "row 5 (another account's queued verification) is untouched").toEqual(before.get(r5));
    checked += 1;
    expect(checked, "anti-vacuity: all five rows were read back").toBe(5);
  });

  it("the sequence: a second deletion changes nothing and does not fail; an account with no outbox rows deletes as before", async () => {
    const email = address("twice");
    const id = await seedUser(email, "Twice");
    authState.user = { id, email, locale: null };
    const queued = await chess(address("old"), id);
    const legacy = await chess(email);
    expect((await del()).status).toBe(200);
    const once = await rowsByIds([queued, legacy]);
    expect(once.map((r) => r.status), "premise: the first deletion ended both").toEqual(["expired", "expired"]);
    handed.calls.length = 0;

    // The retry: the rows hold the placeholder now, so nothing matches by address, and the ones the id names are already ended.
    expect((await del()).status, "a retried deletion").toBe(200);
    expect(await rowsByIds([queued, legacy]), "touches nothing a second time").toEqual(once);
    expect(handed.calls.flat().length, "and ends nothing, so hands the hooks nothing").toBe(0);

    const bare = address("bare");
    const bareId = await seedUser(bare, "Bare");
    authState.user = { id: bareId, email: bare, locale: null };
    expect((await del()).status, "an account with no rows at all").toBe(200);
    expect((await accountOf(bareId)).deleted_at).not.toBeNull();
    expect(handed.calls.flat().length).toBe(0);
  });

  it("the helper on its own: it ends only queued rows and returns them with their kind and ref; the empty case returns nothing", async () => {
    const email = address("helper");
    const userId = await seedUser(email, "Helper");
    const placeholder = placeholderOf(userId);

    const empty = await sql.begin((tx) => anonymiseAccountEmails(tx, { userId, email, placeholder }));
    expect(empty, "an account with no rows ends none").toEqual([]);

    const mine = await chess(address("old"), userId);
    const legacy = await chess(email);
    const sent = await chess(email, userId);
    await put(sent, "sent");
    // The five wave-1 kinds are addressed to a literal address, and are not the account's even at its exact address and in any status.
    const literalKinds = ["registration_confirmation", "payment_reminder", "registration_promoted", "refund_issued", "solo_signup_assigned"] as const;
    const bystanders: string[] = [];
    for (const kind of literalKinds) bystanders.push(await literal(kind, email));
    const bystanderBefore = await rowsByIds(bystanders);
    expect(bystanderBefore.map((r) => r.kind).sort(), "premise: five distinct literal kinds").toEqual([...literalKinds].sort());

    const ended = await sql.begin((tx) => anonymiseAccountEmails(tx, { userId, email, placeholder }));
    expect(
      ended.map((e) => ({ id: e.id, kind: e.kind, status: e.status })).sort((a, b) => a.id.localeCompare(b.id)),
      "the queued rows of the account are returned, both arms, and the sent row is not",
    ).toEqual(
      [
        { id: mine, kind: "chess_invite", status: "expired" },
        { id: legacy, kind: "chess_invite", status: "expired" },
      ].sort((a, b) => a.id.localeCompare(b.id)),
    );
    for (const e of ended) {
      expect(e.refType, "the hook is told which seat").toBe(CHESS_SEAT_REF_TYPE);
      expect(e.refId).toMatch(/^[0-9a-f-]{36}:white$/);
      expect(e.meta.colour).toBe("white");
    }
    expect(await rowsByIds(bystanders), "five literal kinds at the exact address, untouched").toEqual(bystanderBefore);
    expect((await rowOf(sent)).recipient).toBe(placeholder);

    const again = await sql.begin((tx) => anonymiseAccountEmails(tx, { userId, email, placeholder }));
    expect(again, "a second run ends nothing").toEqual([]);
  });

  it("each exported predicate is one self-contained condition: under `not` it selects exactly the complement of what it selects bare", async () => {
    // The fragments are composed as `where ${p} and status = 'queued'` today, and a later edit may compose them under `or` or `not`. An
    // unparenthesised `a and b and c` under `not` negates only `a`, so it would select a different set than its own complement. One query,
    // one snapshot: what the predicate selects, what its negation selects and what it cannot decide (NULL) must add up to the table.
    const email = address("compose");
    const userId = await seedUser(email, "Compose");
    await chess(email); // in the legacy predicate
    await chess(address("elsewhere"), userId); // in the account predicate; NOT in the legacy one
    await literal("registration_confirmation", email); // no account, this address, but not a chess invite: the decoy a loose negation would count
    await accountMailRow("email_verification", "user", userId, email); // in the account-mail predicate
    const counts = async (name: string, frag: (tx: Tx) => ReturnType<typeof namesAccount>) => {
      const [r] = await sql.begin(
        (tx) => tx<{ total: string; inside: string; outside: string; unknown: string }[]>`
          select count(*) as total,
                 count(*) filter (where ${frag(tx)}) as inside,
                 count(*) filter (where not ${frag(tx)}) as outside,
                 count(*) filter (where (${frag(tx)}) is null) as unknown
            from email_outbox`,
      );
      const n = { total: Number(r!.total), inside: Number(r!.inside), outside: Number(r!.outside), unknown: Number(r!.unknown) };
      expect(n.inside, `${name}: anti-vacuity: it selects the row seeded for it`).toBeGreaterThanOrEqual(1);
      expect(n.outside, `${name}: anti-vacuity: and its negation selects rows too`).toBeGreaterThanOrEqual(1);
      expect(n.inside + n.outside + n.unknown, `${name}: inside, outside and undecided are the whole table`).toBe(n.total);
    };
    await counts("legacy arm", (tx) => legacyInviteAt(tx, email));
    await counts("account arm", (tx) => namesAccount(tx, userId));
    await counts("account-mail arm", (tx) => accountMail(tx, userId));
  });

  it("each arm's predicate can use an index: with sequential scans off, the planner picks its index and not the table", async () => {
    // The two arms are separate statements so each can ride an index (account-deletion.ts header). This pins that the predicates the
    // sweep REALLY uses (the exported fragments, so the test cannot drift from them) are ones an index serves. Sequential scans are
    // turned off so the answer does not depend on how many rows the table holds; without a usable index the plan is a Seq Scan anyway.
    const plans = await sql.begin(async (tx) => {
      await tx`set local enable_seqscan = off`;
      const explain = async (where: ReturnType<typeof namesAccount>): Promise<string> =>
        (await tx<{ "QUERY PLAN": string }[]>`explain update email_outbox set recipient = ${"x"} where ${where}`).map((r) => r["QUERY PLAN"]).join("\n");
      return {
        account: await explain(namesAccount(tx, randomUUID())),
        legacy: await explain(legacyInviteAt(tx, address("plan"))),
        accountMail: await explain(accountMail(tx, randomUUID())),
      };
    });
    // The index is named AND the column is an `Index Cond`: a partial index whose predicate the statement implies can be read end to end
    // with the column as a mere `Filter` (a case-folded statement does exactly that), which names the index and is no lookup at all.
    expect(plans.account, "the account arm").toMatch(/Index Scan using email_outbox_recipient_user_idx|Bitmap Index Scan on email_outbox_recipient_user_idx/);
    expect(plans.account, "looked up by the account id").toMatch(/Index Cond: \(recipient_user_id = /);
    expect(plans.account).not.toMatch(/Seq Scan/);
    expect(plans.legacy, "the legacy arm").toMatch(/Index Scan using email_outbox_legacy_invite_idx|Bitmap Index Scan on email_outbox_legacy_invite_idx/);
    expect(plans.legacy, "looked up by the address exactly").toMatch(/Index Cond: \(recipient = /);
    expect(plans.legacy).not.toMatch(/Seq Scan/);
    // The account-mail arm (wave 3) is found by its ref, which the arbiter's ref index (V470, not partial) leads on; the kind is a Filter.
    expect(plans.accountMail, "the account-mail arm").toMatch(/Index Scan using email_outbox_ref_idx|Bitmap Index Scan on email_outbox_ref_idx/);
    expect(plans.accountMail, "looked up by the account's ref").toMatch(/Index Cond: \(\(ref_type = 'user'::text\) AND \(ref_id = /);
    expect(plans.accountMail).not.toMatch(/Seq Scan/);
  });
});
