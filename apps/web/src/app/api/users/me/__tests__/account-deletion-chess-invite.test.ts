// Privacy follow-up to the sign-in half of account deletion (account-deletion-outbox.test.ts): deleting an account must not leave its
// address in the `chess_invite` rows of the email outbox, which keep the recipient for the 90-day retention (RETENTION_DAYS).
//
// WHERE A CHESS INVITE'S RECIPIENT COMES FROM (read from guard.ts `loadSide`, and driven here through the real open): the ACCOUNT. A seat's
// recipients are `users.email` of every user linked to a member person of the entrant (entrant_members -> persons.user_id -> users), copied
// into `email_outbox.recipient` byte for byte when the open queues the invite (invite.ts `queueFixtureInvite`). It is not a separate address
// on the entrant or the person record, so the account's own address is the key, and an account that no longer exists has no business
// being mailed.
//
// WHAT DELETION DOES TO A ROW ADDRESSED TO THE LEAVER (controller rulings, 2026-10-24):
//   - `queued` (never sent, or waiting on a retry): ended `expired`, body gone, `last_error = account_deleted`, so nothing is mailed to a
//     deleted person; its seat is released by the SAME chess hook that releases every badly-ended invite, if no other row holds the stamp;
//   - every other status (`sending`, `sent`, `delayed`, and every terminal one): the status is left exactly as it is, the recipient is
//     replaced. A `sending` row is left to finish: its attempt holds the address in memory and only ever writes status columns;
//   - the provider's later events find a row by its provider id (or the outbox tag), never by recipient, so they still land.
//
// Which rows are the account's: the address EXACTLY as `users.email` holds it (N-B). `users.email` is unique but case-sensitive, so
// `Ann@x.io` and `ann@x.io` are two live accounts and deleting one must leave the other's rows alone.
//
// Driven against a real Postgres. The REAL open writes the rows of the seat tests and the REAL attempt sends them (only the network, the
// invite renderer, the session half of auth and Stripe are stand-ins, the shared invite harness); the REAL DELETE
// /api/users/me anonymises them; the REAL chess hook and the REAL webhook handler follow.
//
// Sport: online chess is the only sport that sends an invite (supportsOnlinePlay is `boardgame` only), so there is no other sport to sweep.
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
const mail = vi.hoisted(() => ({
  sent: [] as import("@/server/usecases/__tests__/_invite-mail").SentInvite[],
  fail: new Set<string>(),
  retry: new Set<string>(),
  holdFirst: null as import("@/server/usecases/__tests__/_invite-mail").InviteMail["holdFirst"],
}));
vi.mock("@/lib/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email")>();
  const h = await import("@/server/usecases/__tests__/_invite-mail");
  return { ...actual, externalPlayInviteEmail: h.renderInviteForTest };
});
vi.mock("@/server/email-outbox/transport", async () => {
  const h = await import("@/server/usecases/__tests__/_invite-mail");
  return { deliver: (msg: import("@/server/email-outbox/transport").DeliverMessage) => h.deliverForTest(mail, msg) };
});

import { sql } from "@/lib/db";
import { destroySession, invalidateUser, invalidateUserOrgs } from "@/lib/auth";
import { DELETE } from "@/app/api/users/me/route";
import {
  OUTBOX_STATUSES,
  RETRYABLE_STATUSES,
  applyProviderEvent,
  dispatchNow,
  enqueueEmail,
  type OutboxStatus,
} from "@/server/email-outbox";
import { anonymiseAccountEmails } from "@/server/email-outbox/account-deletion";
import { KIND_HOOKS } from "@/server/email-outbox/hooks";
import { runOutboxTick } from "@/server/email-outbox/worker";
import { openRound } from "@/server/usecases/external-play/open-round";
import { resendExternalPlayNotice } from "@/server/usecases/external-play/invite";
import { CHESS_SEAT_REF_TYPE, chessSeatRef, type Colour } from "@/server/usecases/external-play/seat-stamp";
import { renderInviteForTest, stubOutboxEnv } from "@/server/usecases/__tests__/_invite-mail";
import { seedOnlineChessRound } from "@/server/usecases/__tests__/_external-play-seed";

const HAS_DB = !!process.env.DATABASE_URL;
const MIN = 60_000;
const RUN = `adci-${randomUUID().slice(0, 8)}`;

const del = () =>
  DELETE(new Request("http://test.local/api/users/me", { method: "DELETE", body: JSON.stringify({ confirm: "DELETE" }) }));
const address = (tag: string): string => `${RUN}-${tag}-${randomUUID().slice(0, 6)}@del.test`;
const ORIGIN = "https://seazn.test";

/** The address a deleted account is left with, written out from the rule and NOT read back from the code under test: the `.invalid` TLD is
 *  reserved (RFC 6761) and can never resolve, so a row addressed to it can never reach anybody, and the account's id keeps two deleted
 *  accounts apart. Every assertion about "the placeholder" compares to THIS. */
const placeholderOf = (userId: string): string => `deleted-${userId}@deleted.invalid`;

/** What this file wrote, so afterAll removes it by id and ref and not only by the RUN prefix in an address (an anonymised row carries no
 *  prefix any more). */
const made = { rows: [] as string[], users: [] as string[], fixtures: [] as string[] };

beforeEach(() => {
  vi.clearAllMocks();
  mail.sent.length = 0;
  mail.fail.clear();
  mail.retry.clear();
  mail.holdFirst = null;
  stubOutboxEnv();
  // The Lichess revoke the account deletion sends for a linked player must not leave the machine: stubOutboxEnv passes every host but
  // Resend through to the real network.
  const wrapped = globalThis.fetch;
  vi.stubGlobal("fetch", (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return new URL(url, "http://localhost").hostname.endsWith("lichess.org")
      ? Promise.resolve(new Response(null, { status: 204 }))
      : wrapped(input, init);
  });
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
          or recipient = any(${made.users.map(placeholderOf)}::text[])
          or ref_id like any(${made.fixtures.map((f) => `${f}:%`)}::text[])`;
    await sql.end({ timeout: 2 }).catch(() => undefined);
  }
});

// ---------------------------------------------------------------------------
// Readers.

type Row = {
  id: string;
  kind: string;
  org_id: string | null;
  recipient: string;
  status: OutboxStatus;
  last_error: string | null;
  provider_id: string | null;
  has_body: boolean;
  has_lease: boolean;
  status_at: Date;
  meta: Record<string, string>;
};
const rowsByIds = (ids: readonly string[]) =>
  sql<Row[]>`
    select id, kind, org_id, recipient, status, last_error, provider_id, body_sealed is not null as has_body,
           lease_until is not null as has_lease, status_at, meta
      from email_outbox where id = any(${ids as string[]}::uuid[]) order by id`;
const rowOf = async (id: string): Promise<Row> => (await rowsByIds([id]))[0]!;
const accountOf = async (id: string) =>
  (await sql<{ email: string; deleted_at: Date | null }[]>`select email, deleted_at from users where id = ${id}`)[0]!;

// ---------------------------------------------------------------------------
// The row-level scene: chess_invite rows written by the real writer for hand-made accounts, put into every status the table allows.

async function seedUser(email: string, name: string): Promise<string> {
  const [{ id }] = await sql<{ id: string }[]>`insert into users (email, display_name, email_verified) values (${email}, ${name}, true) returning id`;
  made.users.push(id);
  return id;
}
async function seedOrg(tag: string): Promise<string> {
  const o = randomUUID().slice(0, 8);
  const [{ id }] = await sql<{ id: string }[]>`insert into organizations (name, slug) values (${`${tag} ${o}`}, ${`${RUN}-${tag}-${o}`}) returning id`;
  return id;
}

/** One chess invite for `to`, through the real writer, on a fresh seat ref (so the replace rule supersedes nothing). */
async function invite(to: string, orgId: string | null): Promise<string> {
  const fixtureId = randomUUID();
  const id = await enqueueEmail(sql, {
    kind: "chess_invite",
    refType: CHESS_SEAT_REF_TYPE,
    refId: chessSeatRef(fixtureId, "white"),
    orgId,
    to,
    ...(await renderInviteForTest(to, { fixtureUrl: "https://seazn.test/f", opponentName: "Opp", roundNo: 1, deadlineLabel: "later" })),
    transactional: true,
    expiresAt: new Date(Date.now() + 60 * MIN),
    meta: { fixtureId, colour: "white", stampedAt: new Date().toISOString() },
  });
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

/** What deleting the leaver's account does to a row addressed to them, by the status it is in - the rulings, typed once. A `Record` over
 *  every status, so a thirteenth status is a compile error here until someone decides what deletion does to it. */
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

describe.skipIf(!HAS_DB)("deleting an account anonymises its chess invites in the outbox", () => {
  it("every status: the leaver's rows lose the address (queued ones end expired), in every org; nobody else's row, and no case-variant account's, is touched", async () => {
    const email = `${RUN}-Leaver.Mixed-${randomUUID().slice(0, 6)}@Del.test`;
    expect(email, "premise: the address has capitals, so its lower-case form is another string").not.toBe(email.toLowerCase());
    const leaverId = await seedUser(email, "Leaver");
    const twinEmail = email.toLowerCase();
    const twinId = await seedUser(twinEmail, "Twin"); // N-B: a separate live account, the same letters in lower case
    const bystanderEmail = address("bystander");
    const bystanderId = await seedUser(bystanderEmail, "Bystander");
    const orgA = await seedOrg("a");
    const orgB = await seedOrg("b");
    authState.user = { id: leaverId, email, locale: null };

    const mine: { id: string; status: OutboxStatus; orgId: string }[] = [];
    const theirs: { id: string; why: string }[] = [];
    for (const status of OUTBOX_STATUSES) {
      for (const orgId of [orgA, orgB]) {
        const id = await invite(email, orgId);
        await put(id, status);
        mine.push({ id, status, orgId });
      }
      const twin = await invite(twinEmail, orgA);
      await put(twin, status);
      theirs.push({ id: twin, why: `the case-variant account's ${status} row` });
      const other = await invite(bystanderEmail, orgB);
      await put(other, status);
      theirs.push({ id: other, why: `another account's ${status} row in another org` });
    }
    expect(mine.length, "anti-vacuity: every status, in two orgs").toBe(OUTBOX_STATUSES.length * 2);
    expect(theirs.length, "anti-vacuity: both kinds of bystander, every status").toBe(OUTBOX_STATUSES.length * 2);

    const beforeMine = new Map((await rowsByIds(mine.map((m) => m.id))).map((r) => [r.id, r]));
    const beforeTheirs = new Map((await rowsByIds(theirs.map((t) => t.id))).map((r) => [r.id, r]));
    for (const m of mine) expect(beforeMine.get(m.id)!.status, "premise: the row is in the status under test").toBe(m.status);
    expect(
      [...beforeMine.values()].every((r) => r.recipient === email),
      "premise: every row of the leaver holds the real address",
    ).toBe(true);

    const res = await del();
    expect(res.status).toBe(200);
    const gone = await accountOf(leaverId);
    expect(gone.deleted_at, "premise: the account really was deleted").not.toBeNull();
    expect(gone.email, "premise: the account itself is left with the same reserved-TLD placeholder").toBe(placeholderOf(leaverId));

    let checked = 0;
    for (const r of await rowsByIds(mine.map((m) => m.id))) {
      const was = beforeMine.get(r.id)!;
      const label = `${was.status} row in org ${r.org_id === orgA ? "A" : "B"}`;
      expect(r.recipient, `${label}: the address is gone and the placeholder is the reserved-TLD one built from the account's id`).toBe(placeholderOf(leaverId));
      expect(r.recipient, `${label}: nothing of the address survives in it`).not.toContain("Leaver");
      expect(r.status, `${label}: its status after deletion`).toBe(STATUS_AFTER_DELETION[was.status]);
      expect(r.org_id, `${label}: still in its org`).toBe(was.org_id);
      if (was.status === "queued") {
        expect(r.has_body, `${label}: the unsent credential is gone with the send`).toBe(false);
        expect(r.last_error, `${label}: why it ended`).toBe("account_deleted");
        expect(r.has_lease).toBe(false);
        expect(r.status_at.getTime(), `${label}: the ending is stamped (the arbiter's status column and the hook order by it)`).toBeGreaterThan(was.status_at.getTime());
      } else {
        expect(r.has_body, `${label}: body untouched`).toBe(was.has_body);
        expect(r.has_lease, `${label}: lease untouched`).toBe(was.has_lease);
        expect(r.last_error, `${label}: last_error untouched`).toBe(was.last_error);
        expect(r.status_at.getTime(), `${label}: status_at untouched (only the address changed)`).toBe(was.status_at.getTime());
      }
      checked += 1;
    }
    expect(checked, "anti-vacuity: every one of the leaver's rows was read back").toBe(mine.length);

    let bystanders = 0;
    for (const r of await rowsByIds(theirs.map((t) => t.id))) {
      expect(r, theirs.find((t) => t.id === r.id)!.why).toEqual(beforeTheirs.get(r.id));
      bystanders += 1;
    }
    expect(bystanders, "anti-vacuity: every bystander row was read back").toBe(theirs.length);
    expect((await accountOf(twinId)).deleted_at, "the case-variant account is still live").toBeNull();
    expect((await accountOf(twinId)).email).toBe(twinEmail);
    expect((await accountOf(bystanderId)).deleted_at).toBeNull();
  });

  it("the sequence: a second deletion changes nothing and does not fail; an account with no chess invites deletes as before", async () => {
    const email = address("twice");
    const id = await seedUser(email, "Twice");
    authState.user = { id, email, locale: null };
    const row = await invite(email, null);
    expect((await del()).status).toBe(200);
    const once = await rowOf(row);
    expect((await del()).status, "a retried deletion").toBe(200);
    expect(await rowOf(row), "touches nothing a second time").toEqual(once);

    const bare = address("bare");
    const bareId = await seedUser(bare, "Bare");
    authState.user = { id: bareId, email: bare, locale: null };
    expect((await del()).status).toBe(200);
    expect((await accountOf(bareId)).deleted_at).not.toBeNull();
  });

  it("two deleted accounts are left with different placeholders, each the reserved `.invalid` address built from its own id", async () => {
    const people = [] as { id: string; email: string; row: string }[];
    for (const tag of ["first", "second"]) {
      const email = address(tag);
      const id = await seedUser(email, tag);
      people.push({ id, email, row: await invite(email, null) });
    }
    for (const p of people) {
      authState.user = { id: p.id, email: p.email, locale: null };
      expect((await del()).status).toBe(200);
    }
    const recipients = [] as string[];
    for (const p of people) {
      const r = await rowOf(p.row);
      expect(r.recipient).toBe(placeholderOf(p.id));
      expect(r.recipient, "an address that can never resolve (RFC 6761)").toMatch(/@deleted\.invalid$/);
      expect(r.recipient, "and nothing of the real one survives in it").not.toContain(p.email.split("@")[0]!);
      expect((await accountOf(p.id)).email, "the account holds the same one").toBe(r.recipient);
      recipients.push(r.recipient);
    }
    expect(recipients.length, "anti-vacuity: both accounts were read back").toBe(2);
    expect(new Set(recipients).size, "two people are never left with one shared placeholder").toBe(2);
  });

  it("the helper scrubs chess invites, deletes sign-in rows and touches nothing else: a registration email for the same address, in any status, is not its business", async () => {
    // The kind filter of the scrub is unobservable through the route, which gives the helper only the account's own address and rows:
    // drive the helper itself. (T5: the helper now also owns the sign-in delete, so a `magic_link` row at the address is GONE, and the
    // row that proves "nothing else" is a literal-address kind of the wave, `registration_confirmation`.)
    const email = address("kinds");
    const rows: { id: string; kind: string }[] = [];
    for (const status of OUTBOX_STATUSES) {
      const chess = await invite(email, null);
      await put(chess, status);
      const signIn = await enqueueEmail(sql, {
        kind: "magic_link", refType: "user", refId: randomUUID(), orgId: null, to: email,
        subject: "Your sign-in link", html: "<p>link</p>", text: "link", transactional: true, expiresAt: new Date(Date.now() + 15 * MIN),
      });
      made.rows.push(signIn);
      await put(signIn, status);
      const registration = await enqueueEmail(sql, {
        kind: "registration_confirmation", refType: "registration", refId: randomUUID(), orgId: null, to: email,
        subject: "Your registration", html: "<p>in</p>", text: "in", transactional: false, expiresAt: new Date(Date.now() + 15 * MIN),
      });
      made.rows.push(registration);
      await put(registration, status);
      rows.push({ id: chess, kind: "chess_invite" }, { id: signIn, kind: "magic_link" }, { id: registration, kind: "registration_confirmation" });
    }
    const before = new Map((await rowsByIds(rows.map((r) => r.id))).map((r) => [r.id, r]));
    const placeholder = `deleted-${randomUUID()}@deleted.invalid`;

    const ended = await sql.begin((tx) => anonymiseAccountEmails(tx, { userId: randomUUID(), email, placeholder }));
    expect(ended.map((e) => e.status), "only the queued chess invite was ended, and it is handed back for the hook").toEqual(["expired"]);

    let sawChess = 0;
    let sawRegistration = 0;
    const left = await rowsByIds(rows.map((x) => x.id));
    for (const r of left) {
      if (r.kind === "chess_invite") {
        expect(r.recipient).toBe(placeholder);
        sawChess += 1;
      } else {
        expect(r.kind, "only a registration row can still be there").toBe("registration_confirmation");
        expect(r, `a ${before.get(r.id)!.status} registration row is left exactly as it was`).toEqual(before.get(r.id));
        sawRegistration += 1;
      }
    }
    const signInsGone = rows.filter((r) => r.kind === "magic_link" && !left.some((l) => l.id === r.id)).length;
    expect(
      [sawChess, sawRegistration, signInsGone],
      "anti-vacuity: every status, all three kinds (scrubbed, untouched, deleted)",
    ).toEqual([OUTBOX_STATUSES.length, OUTBOX_STATUSES.length, OUTBOX_STATUSES.length]);
  });

  it("a REFUSED deletion keeps the address: the account is kept, so its invites are", async () => {
    const email = address("kept");
    const id = await seedUser(email, "Kept");
    authState.user = { id, email, locale: null };
    const row = await invite(email, null);
    const o = randomUUID().slice(0, 8);
    const [{ id: orgId }] = await sql<{ id: string }[]>`insert into organizations (name, slug, created_by) values (${"Keep " + o}, ${`${RUN}-keep-${o}`}, ${id}) returning id`;
    const memberId = await seedUser(address("member"), "Member");
    await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${id}, 'owner'), (${orgId}, ${memberId}, 'viewer')`;

    expect((await del()).status).toBe(409);
    expect((await rowOf(row)).recipient, "the sole-owner refusal comes before anything is erased").toBe(email);
    expect((await accountOf(id)).deleted_at).toBeNull();
  });

  it("one transaction with the anonymisation: a deletion that fails afterwards leaves the invite as it was, and the retry completes it", async () => {
    const email = address("atomic");
    const id = await seedUser(email, "Atomic");
    authState.user = { id, email, locale: null };
    const queued = await invite(email, null);
    const sent = await invite(email, null);
    await put(sent, "sent");
    // The account row is the LAST write of the transaction: refuse it, after the outbox statements have run.
    const fn = `adci_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
    await sql.unsafe(`create function ${fn}() returns trigger language plpgsql as $$ begin raise exception 'staged: users update refused'; end $$`);
    await sql.unsafe(`create trigger ${fn} before update on users for each row when (old.id = '${id}') execute function ${fn}()`);
    try {
      expect((await del()).status, "the deletion fails loudly").toBe(500);
      for (const rid of [queued, sent]) {
        const r = await rowOf(rid);
        expect(r.recipient, "the address is still there: the outbox write rolled back with the rest").toBe(email);
      }
      expect((await rowOf(queued)).status, "and the queued invite is still queued, not expired").toBe("queued");
      expect((await accountOf(id)).deleted_at).toBeNull();
    } finally {
      await sql.unsafe(`drop trigger if exists ${fn} on users`);
      await sql.unsafe(`drop function if exists ${fn}()`);
    }
    expect((await del()).status, "the retry completes the deletion").toBe(200);
    expect((await rowOf(queued)).status).toBe("expired");
    expect((await rowOf(sent)).recipient).toBe(placeholderOf(id));
  });

  it("a send in flight when the account is deleted is left to finish: it lands `sent`, with the address already gone from its row", async () => {
    const email = address("inflight");
    const id = await seedUser(email, "In flight");
    authState.user = { id, email, locale: null };
    const row = await invite(email, null);
    let release!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const hold = new Promise<void>((r) => (reached = r));
    mail.holdFirst = { to: email, gate, reached };

    const dispatch = dispatchNow([row]); // the real first attempt; the provider call waits on the gate
    await hold;
    expect((await rowOf(row)).status, "premise: the attempt is in flight").toBe("sending");

    expect((await del()).status).toBe(200);
    const mid = await rowOf(row);
    expect(mid.status, "deletion does not fight the attempt that owns the row").toBe("sending");
    expect(mid.has_lease, "its lease is intact").toBe(true);
    expect(mid.recipient, "but the address is already gone from it").toBe(placeholderOf(id));

    release();
    expect((await dispatch).get(row), "the attempt still owns the row, so its result is recorded").toBe("sent");
    const done = await rowOf(row);
    expect(done.status).toBe("sent");
    expect(done.provider_id, "and the provider's id is recorded for its later events").not.toBeNull();
    expect(done.has_body).toBe(false);
    expect(done.recipient, "and the address did not come back").toBe(placeholderOf(id));
    expect(mail.sent.map((m) => m.to), "the mail was already on its way; the placeholder was never mailed").toEqual([email]);
  });

  it("a provider event finds an anonymised row by its provider id, not by the address: delivered, then a late bounce", async () => {
    const email = address("webhook");
    const id = await seedUser(email, "Webhook");
    authState.user = { id, email, locale: null };
    const row = await invite(email, null);
    await dispatchNow([row]);
    const sent = await rowOf(row);
    expect(sent.status, "premise: the provider took it").toBe("sent");

    expect((await del()).status).toBe(200);
    const anon = placeholderOf(id);
    expect((await rowOf(row)).recipient).toBe(anon);

    // The payload carries no address at all: the match is the provider id.
    expect(await applyProviderEvent("email.delivered", { email_id: sent.provider_id })).toBe("moved");
    expect((await rowOf(row)).status).toBe("delivered");
    expect(await applyProviderEvent("email.bounced", { email_id: sent.provider_id })).toBe("moved");
    const bounced = await rowOf(row);
    expect([bounced.status, bounced.recipient], "the late bounce lands on the anonymised row").toEqual(["bounced", anon]);
  });
});

// ---------------------------------------------------------------------------
// The seat: driven through the real open on a real board.

type Board = Awaited<ReturnType<typeof seedOnlineChessRound>>["boards"][number];

async function seatRows(fixtureId: string, colour: Colour): Promise<Row[]> {
  return sql<Row[]>`
    select id, kind, org_id, recipient, status, last_error, provider_id, body_sealed is not null as has_body,
           lease_until is not null as has_lease, status_at, meta
      from email_outbox where kind = 'chess_invite' and ref_id = ${chessSeatRef(fixtureId, colour)} order by created_at, id`;
}
const stampOf = async (fixtureId: string, colour: Colour): Promise<Date | null> => {
  const [b] = await sql<{ white: Date | null; black: Date | null }[]>`
    select white_emailed_at as white, black_emailed_at as black from fixture_external_play where fixture_id = ${fixtureId}`;
  return colour === "white" ? b!.white : b!.black;
};
/** The colour an address's seat is, from the rows the open wrote (the pairing decides the colours, not the test). */
async function colourOf(fixtureId: string, email: string): Promise<Colour> {
  const [row] = await sql<{ ref_id: string }[]>`
    select ref_id from email_outbox where kind = 'chess_invite' and ref_id like ${fixtureId + ":%"} and recipient = ${email}`;
  if (!row) throw new Error(`no outbox row for ${email} on ${fixtureId}`);
  return row.ref_id.endsWith(":white") ? "white" : "black";
}
const other = (c: Colour): Colour => (c === "white" ? "black" : "white");

async function openedBoard(): Promise<{ r: Awaited<ReturnType<typeof seedOnlineChessRound>>; b: Board }> {
  const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 1 });
  const b = r.boards[0]!;
  made.fixtures.push(b.fixtureId);
  made.users.push(b.home.userId, b.away.userId);
  return { r, b };
}
const open = (r: Awaited<ReturnType<typeof seedOnlineChessRound>>) =>
  openRound({ stageId: r.stageId, roundNo: 1, actorUserId: r.ownerUserId });
const asLeaver = (b: Board) => {
  authState.user = { id: b.home.userId, email: b.home.email, locale: "en" };
};

describe.skipIf(!HAS_DB)("the seat of a deleted account's invite (the chess hook after the deletion)", () => {
  it("an invite still queued behind a retry ends expired and RELEASES the seat; the opponent's invite and stamp are untouched", async () => {
    const { r, b } = await openedBoard();
    mail.retry.add(b.home.email); // the provider answers 503: the leaver's invite is queued for a retry
    expect(await open(r)).toEqual({ opened: true, invited: 1, retrying: 1, skipped: [] });
    const mine = await colourOf(b.fixtureId, b.home.email);
    const theirs = other(mine);
    const [queued] = await seatRows(b.fixtureId, mine);
    expect(queued!.status, "premise: the leaver's invite is waiting for a retry").toBe("queued");
    expect(await stampOf(b.fixtureId, mine), "premise: the seat is stamped").not.toBeNull();

    asLeaver(b);
    expect((await del()).status).toBe(200);
    const anon = placeholderOf(b.home.userId);

    const [ended] = await seatRows(b.fixtureId, mine);
    expect([ended!.status, ended!.last_error, ended!.has_body, ended!.recipient]).toEqual(["expired", "account_deleted", false, anon]);
    expect(await stampOf(b.fixtureId, mine), "no email for the stamp can still arrive, so the seat reads 'still to invite'").toBeNull();

    const [opp] = await seatRows(b.fixtureId, theirs);
    expect([opp!.status, opp!.recipient], "the opponent's delivered-to-provider invite is untouched").toEqual(["sent", b.away.email]);
    expect(await stampOf(b.fixtureId, theirs), "and so is their stamp").not.toBeNull();
  });

  it("a team seat with a live mate: the leaver's queued invite ends, the mate's invite and the stamp stay", async () => {
    const { r, b } = await openedBoard();
    const mate = `${RUN}-mate-${randomUUID().slice(0, 6)}@t.local`;
    const [mateUser] = await sql<{ id: string }[]>`insert into users (email, display_name, email_verified, locale) values (${mate}, 'Mate', true, 'en') returning id`;
    const [matePerson] = await sql<{ id: string }[]>`insert into persons (org_id, full_name, user_id) values (${r.orgId}, 'Mate', ${mateUser!.id}) returning id`;
    await sql`insert into entrant_members (entrant_id, person_id, org_id) values (${b.home.entrantId}, ${matePerson!.id}, ${r.orgId})`;
    mail.retry.add(b.home.email);
    await open(r);
    const mine = await colourOf(b.fixtureId, b.home.email);
    const seat = await seatRows(b.fixtureId, mine);
    expect(seat.map((x) => x.recipient).sort(), "premise: one row per member of the seat").toEqual([b.home.email, mate].sort());
    expect(seat.find((x) => x.recipient === mate)!.status, "premise: the mate's invite went out").toBe("sent");

    asLeaver(b);
    expect((await del()).status).toBe(200);
    const after = await seatRows(b.fixtureId, mine);
    const leaverRow = after.find((x) => x.id === seat.find((y) => y.recipient === b.home.email)!.id)!;
    const mateRow = after.find((x) => x.recipient === mate)!;
    expect(leaverRow.status).toBe("expired");
    expect(leaverRow.recipient).not.toBe(b.home.email);
    expect([mateRow.status, mateRow.recipient], "the mate's row is nobody's business but the mate's").toEqual(["sent", mate]);
    expect(await stampOf(b.fixtureId, mine), "a live email still holds the stamp").not.toBeNull();
  });

  it("an invite already `sent`: the address goes, the seat stays stamped; a bounce that arrives later still releases it", async () => {
    const { r, b } = await openedBoard();
    expect(await open(r)).toEqual({ opened: true, invited: 2, retrying: 0, skipped: [] });
    const mine = await colourOf(b.fixtureId, b.home.email);
    const [sent] = await seatRows(b.fixtureId, mine);
    expect(sent!.status).toBe("sent");

    asLeaver(b);
    expect((await del()).status).toBe(200);
    const anon = placeholderOf(b.home.userId);
    const [after] = await seatRows(b.fixtureId, mine);
    expect([after!.status, after!.recipient, after!.provider_id], "status and provider id untouched, address replaced").toEqual(["sent", anon, sent!.provider_id]);
    expect(await stampOf(b.fixtureId, mine), "the provider took the mail: the seat stays invited").not.toBeNull();

    expect(await applyProviderEvent("email.bounced", { email_id: sent!.provider_id })).toBe("moved");
    expect(await stampOf(b.fixtureId, mine), "the bounce found the row without the address, and the hook released the seat").toBeNull();
  });

  it("a hook that fails does not fail the deletion; the worker's re-drive releases the seat afterwards", async () => {
    const { r, b } = await openedBoard();
    mail.retry.add(b.home.email);
    await open(r);
    const mine = await colourOf(b.fixtureId, b.home.email);
    const realHook = KIND_HOOKS.chess_invite;
    KIND_HOOKS.chess_invite = { ...realHook, onEndedBadly: async () => { throw new Error("staged: hook exploded"); } };
    try {
      asLeaver(b);
      expect((await del()).status, "the account is deleted whatever the hook does").toBe(200);
    } finally {
      KIND_HOOKS.chess_invite = realHook;
    }
    expect((await accountOf(b.home.userId)).deleted_at).not.toBeNull();
    const [ended] = await seatRows(b.fixtureId, mine);
    expect(ended!.status).toBe("expired");
    expect(await stampOf(b.fixtureId, mine), "premise: the failed hook released nothing").not.toBeNull();

    await runOutboxTick({ onlyIds: [], sleep: async () => undefined }); // claims nothing; its last step re-drives unapplied endings
    expect(await stampOf(b.fixtureId, mine), "the re-drive applied the release").toBeNull();
  });

  it("the sign-out comes first: the session and the caches are cleared BEFORE the seat hook runs, so a hook waiting on a bridge lock cannot delay it", async () => {
    const { r, b } = await openedBoard();
    mail.retry.add(b.home.email);
    await open(r);
    const mine = await colourOf(b.fixtureId, b.home.email);
    const realHook = KIND_HOOKS.chess_invite;
    const atHook: { destroyed: number; invalidated: number; invalidatedOrgs: number }[] = [];
    KIND_HOOKS.chess_invite = {
      ...realHook,
      onEndedBadly: async (row) => {
        atHook.push({
          destroyed: vi.mocked(destroySession).mock.calls.length,
          invalidated: vi.mocked(invalidateUser).mock.calls.length,
          invalidatedOrgs: vi.mocked(invalidateUserOrgs).mock.calls.length,
        });
        await realHook.onEndedBadly!(row);
      },
    };
    try {
      asLeaver(b);
      expect((await del()).status).toBe(200);
    } finally {
      KIND_HOOKS.chess_invite = realHook;
    }
    expect(atHook, "anti-vacuity: the hook ran once, and each call had already happened when it did").toEqual([
      { destroyed: 1, invalidated: 1, invalidatedOrgs: 1 },
    ]);
    expect(await stampOf(b.fixtureId, mine), "and it still did its job").toBeNull();
  });
});

// A deleted player's seat is not mailable (guard.ts loadSide drops a deleted account from the recipients): after the deletion the
// account's address is the unreachable placeholder, and a Resend or the next Open must not queue, stamp or send anything to it.
describe.skipIf(!HAS_DB)("a Resend after a player deleted their account", () => {
  it("the seat whose invite was ended and released is handled as a seat with no address: nothing queued, nothing mailed to the placeholder, the stamp released again", async () => {
    const { r, b } = await openedBoard();
    mail.retry.add(b.home.email);
    await open(r);
    const mine = await colourOf(b.fixtureId, b.home.email);
    asLeaver(b);
    expect((await del()).status).toBe(200);
    expect(await stampOf(b.fixtureId, mine), "premise: the deletion released the leaver's seat").toBeNull();
    mail.sent.length = 0;
    mail.retry.clear();

    const out = await resendExternalPlayNotice(r.owner, b.fixtureId, ORIGIN);

    expect(out, "only the opponent's seat has an address to invite").toEqual({ emailed: 1, retrying: 0 });
    expect(mail.sent.map((m) => m.to), "the one email of the Resend went to the opponent").toEqual([b.away.email]);
    const leaverSeat = await seatRows(b.fixtureId, mine);
    expect(leaverSeat.map((x) => [x.status, x.recipient]), "no row was written for the leaver's seat: the ended one is all there is").toEqual([
      ["expired", placeholderOf(b.home.userId)],
    ]);
    expect(await stampOf(b.fixtureId, mine), "the seat the Resend claimed has no address, so its stamp went again (the no-address path)").toBeNull();
    const toPlaceholder = await sql<{ id: string }[]>`select id from email_outbox where recipient = ${placeholderOf(b.home.userId)}`;
    expect(toPlaceholder.length, "and nothing anywhere is addressed to the placeholder but that ended row").toBe(1);
  });

  it("the seat whose invite had already been sent keeps its stamp and gets no second email", async () => {
    const { r, b } = await openedBoard();
    expect(await open(r)).toEqual({ opened: true, invited: 2, retrying: 0, skipped: [] });
    const mine = await colourOf(b.fixtureId, b.home.email);
    asLeaver(b);
    expect((await del()).status).toBe(200);
    const stampBefore = await stampOf(b.fixtureId, mine);
    expect(stampBefore, "premise: the sent mail still holds the stamp").not.toBeNull();
    mail.sent.length = 0;

    const out = await resendExternalPlayNotice(r.owner, b.fixtureId, ORIGIN);

    expect(out).toEqual({ emailed: 1, retrying: 0 });
    expect(mail.sent.map((m) => m.to)).toEqual([b.away.email]);
    expect((await seatRows(b.fixtureId, mine)).map((x) => [x.status, x.recipient]), "still the one sent row, with no address").toEqual([
      ["sent", placeholderOf(b.home.userId)],
    ]);
    expect((await stampOf(b.fixtureId, mine))?.getTime(), "and the stamp is exactly the one it was").toBe(stampBefore!.getTime());
  });
});
