// Phase 3 wave 1, Task 8: the registration confirmation goes through the email outbox (kind `registration_confirmation`, ref
// `registration_group/<group id>`, no once-key). Producers under test, each driven through its REAL entry point:
//   - the public register route (`notifySubmitted` after the cart commits, dispatched after the response),
//   - the organiser's resend (`resendRegistrationConfirmation`, its enqueue and audit in ONE tenant transaction),
//   - the registrant's own resend (`resendRegistrationConfirmationPublic`, the same pair in one `sql.begin`).
// Only the network seam (`@/server/email-outbox/transport`) is replaced. The rows, the claim, the retry and the supersede rule are
// the real ones. `recipientLocale` (D4) has its first production caller here, so it is driven through the real route and both
// resends, not only through its own unit tests.
//
// Sport: not applicable. The confirmation does not vary by sport (spec, Test strategy 4); the locale is the axis that varies, and it
// is swept over every shipped locale below.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

vi.mock("@/lib/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rate-limit")>()),
  rateLimit: vi.fn(async () => {}),
}));

const authState = vi.hoisted(() => ({ userId: null as string | null }));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, getCurrentUser: async () => (authState.userId ? { id: authState.userId } : null) };
});

// The one network seam. The kind harness reads this same mock back (it imports `deliver` from the same module).
const deliverMock = vi.hoisted(() => vi.fn());
vi.mock("@/server/email-outbox/transport", () => ({ deliver: deliverMock }));

// Test 7: the organiser's audit write fails once, armed immediately before the call under test.
const auditGate = vi.hoisted(() => ({ failOnce: false }));
vi.mock("@/server/usecases/audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/usecases/audit")>();
  return {
    ...actual,
    audit: async (...args: Parameters<typeof actual.audit>) => {
      if (auditGate.failOnce) {
        auditGate.failOnce = false;
        throw new Error("audit is down");
      }
      return actual.audit(...args);
    },
  };
});

// Test 9: the outbox refuses the enqueue once (after the submit committed), armed immediately before the call under test.
const enqueueGate = vi.hoisted(() => ({ failOnce: false, calls: 0 }));
vi.mock("@/server/email-outbox", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/email-outbox")>();
  return {
    ...actual,
    enqueueEmail: async (...args: Parameters<typeof actual.enqueueEmail>) => {
      enqueueGate.calls += 1;
      if (enqueueGate.failOnce) {
        enqueueGate.failOnce = false;
        throw new Error("the outbox refused the row");
      }
      return actual.enqueueEmail(...args);
    },
  };
});

import { sql } from "@/lib/db";
import { log } from "@/server/logger";
import { LOCALES, type Locale } from "@/lib/i18n-constants";
import { HttpError } from "@/lib/errors";
import { POST as registerRoute } from "@/app/api/v1/public/orgs/[orgSlug]/competitions/[slug]/register/route";
import {
  markRegistrationPaidOffline,
  notifySubmitted,
  putRegistrationSettings,
  resendRegistrationConfirmation,
  resendRegistrationConfirmationPublic,
  withdrawRegistrationOrganiser,
} from "../registrations";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { forgetOnlineChessFlagCache } from "../external-play/online-chess-flag";
import { idempotencyKey } from "@/server/email-outbox/constants";
import { openBody } from "@/server/email-outbox/seal";
import { runOutboxTick } from "@/server/email-outbox/worker";
import { assertNothingMoreToSend, dictionarySubject } from "@/server/email-outbox/__tests__/_kind-harness";
import { stubOutboxEnv } from "./_invite-mail";
import { seedOwner } from "./_external-play-seed";
import {
  SETTINGS_BASE,
  asOwner,
  makeUser,
  rig,
  seedOrg,
  seedRegistration,
  seedSecondEntry,
} from "./_registration-fixtures";

const HAS_DB = !!process.env.DATABASE_URL;
const ORIGIN = "https://test.local";
const KIND = "registration_confirmation" as const;
const PAY_INSTRUCTIONS = "Pay at the front desk";

const made = { orgIds: [] as string[], userIds: [] as string[] };

async function cleanUp(): Promise<void> {
  await sql`delete from email_outbox where org_id = any(${made.orgIds}::uuid[])`;
  if (made.orgIds.length > 0) await sql`delete from organizations where id = any(${made.orgIds}::uuid[])`;
  await sql`delete from subscriptions where owner_user_id = any(${made.userIds}::uuid[])`;
  await sql`delete from users where id = any(${made.userIds}::uuid[])`;
}

afterAll(async () => {
  if (HAS_DB) {
    await cleanUp();
    await sql.end({ timeout: 2 }).catch(() => undefined);
  }
});

const ok = async () => ({ ok: true, providerId: `re_t8_${randomUUID()}` });
const later = async () => ({ ok: false, reason: "http", status: 503, errorName: "service_unavailable", detail: "later" });

beforeEach(() => {
  stubOutboxEnv();
  authState.userId = null;
  auditGate.failOnce = false;
  enqueueGate.failOnce = false;
  enqueueGate.calls = 0;
  deliverMock.mockReset();
  deliverMock.mockImplementation(ok);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Fixtures and readers
// ---------------------------------------------------------------------------------------------------------------------------------

type World = Awaited<ReturnType<typeof world>>;

/** An organisation with one open division. `fee` > 0 makes an offline-paid division whose entries start `pending`. */
async function world(o: { fee?: number; defaultLocale?: Locale } = {}) {
  const { orgId, orgSlug, ownerId } = await seedOrg("pro");
  made.orgIds.push(orgId);
  made.userIds.push(ownerId);
  const owner = asOwner(orgId, ownerId);
  const { competition, division } = await rig(owner);
  const settings = await putRegistrationSettings(owner, division.id, {
    ...SETTINGS_BASE,
    fee_cents: o.fee ?? 0,
    payment_method: "offline",
    payment_instructions: PAY_INSTRUCTIONS,
  });
  if (o.defaultLocale) await sql`update organizations set default_locale = ${o.defaultLocale} where id = ${orgId}`;
  return { orgId, orgSlug, ownerId, owner, competition, division, settings };
}

const address = (tag: string): string => `t8-${tag}-${randomUUID().slice(0, 8)}@test.local`;

type Submitted = { status: number; body: { ok: boolean; data?: Record<string, unknown>; error?: { message: string; code?: string } }; email: string };

/** The real route POST. `cookie` is the registrant's locale pick (the footer switcher's cookie). */
async function submit(
  w: Pick<World, "orgSlug" | "competition" | "division">,
  over: { cookie?: string; email?: string; players?: string[]; entry?: Record<string, unknown> } = {},
): Promise<Submitted> {
  const email = over.email ?? address("sub");
  const res = await registerRoute(
    new Request(`${ORIGIN}/api/v1/public/orgs/${w.orgSlug}/competitions/${w.competition.slug}/register`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.8", ...(over.cookie ? { cookie: over.cookie } : {}) },
      body: JSON.stringify({
        contact: { name: "Alex Rep", email },
        privacy_consent: true,
        entries: (over.players ?? ["Solo Player"]).map((name) => ({
          division_id: w.division.id,
          entrant_kind: "individual",
          players: [{ full_name: name }],
          answers: {},
          ...over.entry,
        })),
      }),
    }),
    { params: Promise.resolve({ orgSlug: w.orgSlug, slug: w.competition.slug }) },
  );
  return { status: res.status, body: (await res.json()) as Submitted["body"], email };
}

type Row = {
  id: string;
  kind: string;
  ref_type: string;
  ref_id: string;
  org_id: string | null;
  recipient: string;
  subject: string;
  status: string;
  attempts: number;
  last_error: string | null;
  transactional: boolean;
  recipient_user_id: string | null;
  dedupe_key: string | null;
  sealed: boolean;
  body_sealed: Buffer | null;
};

/** The confirmation rows of one cart, oldest first. */
const rowsOf = (groupId: string) =>
  sql<Row[]>`
    select id, kind, ref_type, ref_id, org_id, recipient, subject, status, attempts, last_error, transactional,
           recipient_user_id, dedupe_key, body_sealed is not null as sealed, body_sealed
      from email_outbox
     where kind = ${KIND} and ref_type = 'registration_group' and ref_id = ${groupId}
     order by created_at, id`;

/** Every outbox row addressed to this address, of any kind (the proof that nothing was queued at all). */
const rowsTo = (email: string) => sql<{ id: string }[]>`select id from email_outbox where lower(recipient) = lower(${email})`;

type Sent = { to: string; subject: string; html: string; text: string; idempotencyKey: string };
const allCalls = (): Sent[] => deliverMock.mock.calls.map((c) => c[0] as Sent);
const callsFor = (id: string): Sent[] => allCalls().filter((c) => c.idempotencyKey === idempotencyKey(id));
const callsToAddress = (email: string): Sent[] => allCalls().filter((c) => c.to.toLowerCase() === email.toLowerCase());

/** Wait until the cart's rows have left `queued`/`sending` (the dispatch after the response runs on its own). */
async function settled(groupId: string, n: number): Promise<Row[]> {
  await vi.waitFor(
    async () => {
      const rows = await rowsOf(groupId);
      if (rows.length !== n) throw new Error(`${rows.length} row(s), waiting for ${n}`);
      const open = rows.filter((r) => r.status === "queued" || r.status === "sending");
      if (open.length > 0) throw new Error(`${open.length} row(s) still ${open[0]!.status}`);
    },
    { timeout: 10_000, interval: 50 },
  );
  return rowsOf(groupId);
}

/** Wait until the cart's newest row has made `attempts` attempts (the transport answered 503, so it stays queued). */
async function attempted(groupId: string, attempts: number): Promise<Row[]> {
  await vi.waitFor(
    async () => {
      const rows = await rowsOf(groupId);
      const last = rows.at(-1);
      if (!last || last.attempts < attempts || last.status === "sending") throw new Error(`newest row: ${last?.status} after ${last?.attempts ?? 0} attempt(s)`);
    },
    { timeout: 10_000, interval: 50 },
  );
  return rowsOf(groupId);
}

/** Make the retry due and run the worker over these rows, as the next tick would. */
async function tickNow(ids: string[]): Promise<void> {
  await sql`update email_outbox set next_attempt_at = now() - interval '1 second' where id = any(${ids}::uuid[])`;
  await runOutboxTick({ onlyIds: ids, sleep: async () => undefined });
}

const statusUrlOf = (w: Pick<World, "orgSlug" | "competition">, groupId: string, token: string): string =>
  `${ORIGIN}/shared/${w.orgSlug}/${w.competition.slug}/register/status?rid=${groupId}&token=${encodeURIComponent(token)}`;

// ---------------------------------------------------------------------------------------------------------------------------------
// 1. The submit
// ---------------------------------------------------------------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("the submit queues the confirmation on the outbox (DB)", () => {
  it("submit queues one confirmation in the registrant's locale and sends it", async () => {
    const w = await world();
    const out = await submit(w, { cookie: "seazn_locale=es" });
    expect(out.status).toBe(201);
    const groupId = String(out.body.data!.group_id);
    const token = String(out.body.data!.access_token);

    const rows = await settled(groupId, 1);
    const row = rows[0]!;
    expect(row).toMatchObject({
      kind: KIND,
      ref_type: "registration_group",
      ref_id: groupId,
      org_id: w.orgId,
      recipient: out.email,
      transactional: false,
      recipient_user_id: null,
      dedupe_key: null,
      status: "sent",
      sealed: false,
    });
    const subject = dictionarySubject("es", "registration.subject", { competitionName: w.competition.name });
    expect(subject, "the Spanish subject is not the English one").not.toBe(
      dictionarySubject("en", "registration.subject", { competitionName: w.competition.name }),
    );
    expect(row.subject).toBe(subject);

    const calls = callsFor(row.id);
    expect(calls, "one transport call under the row's key").toHaveLength(1);
    expect(calls[0]).toMatchObject({ to: out.email, subject });
    // The body is the Spanish one and links to this cart's status page.
    expect(calls[0]!.text).toContain(dictionarySubject("es", "registration.textView", { url: statusUrlOf(w, groupId, token) }));
    expect(callsToAddress(out.email), "and nothing else went to the registrant").toHaveLength(1);

    // The second call: the request path again and a worker tick over a row made to look due send nothing more.
    await assertNothingMoreToSend(KIND, [row.id]);
  });

  it("every shipped locale: the route writes the pick's subject and body (sweep)", async () => {
    const w = await world();
    let checked = 0;
    for (const locale of LOCALES) {
      const out = await submit(w, { cookie: `seazn_locale=${locale}` });
      expect(out.status, locale).toBe(201);
      const groupId = String(out.body.data!.group_id);
      const [row] = await settled(groupId, 1);
      expect(row!.status, locale).toBe("sent");
      const subject = dictionarySubject(locale, "registration.subject", { competitionName: w.competition.name });
      expect(row!.subject, locale).toBe(subject);
      const [call] = callsFor(row!.id);
      expect(call!.subject, locale).toBe(subject);
      expect(call!.text, locale).toContain(
        dictionarySubject(locale, "registration.textView", { url: statusUrlOf(w, groupId, String(out.body.data!.access_token)) }),
      );
      checked += 1;
    }
    expect(checked, "anti-vacuity: every locale was driven").toBe(LOCALES.length);
    expect(LOCALES.length).toBeGreaterThan(1);
  });

  it("a paid offline cart: the queued confirmation carries the fee and the payment instructions", async () => {
    const w = await world({ fee: 1500 });
    const out = await submit(w);
    expect(out.status).toBe(201);
    const [row] = await settled(String(out.body.data!.group_id), 1);
    const [call] = callsFor(row!.id);
    expect(call!.text).toContain(dictionarySubject("en", "registration.textFee", { amount: "£15.00" }));
    expect(call!.text).toContain(PAY_INSTRUCTIONS);
  });

  it("submit twice: two carts, each confirmed exactly once under its own key", async () => {
    const w = await world();
    const email = address("twice");
    const first = await submit(w, { email, players: ["Same Person"] });
    const second = await submit(w, { email, players: ["Same Person"] });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    const a = String(first.body.data!.group_id);
    const b = String(second.body.data!.group_id);
    expect(a, "premise: two submits made two carts").not.toBe(b);

    const [ra] = await settled(a, 1);
    const [rb] = await settled(b, 1);
    expect(ra!.id).not.toBe(rb!.id);
    expect(callsFor(ra!.id)).toHaveLength(1);
    expect(callsFor(rb!.id)).toHaveLength(1);
    expect(callsToAddress(email), "two carts, two mails: neither cart's mail was sent twice").toHaveLength(2);
    await assertNothingMoreToSend(KIND, [ra!.id, rb!.id]);
  });

  it("notifySubmitted twice for one cart while the first is still queued: the older never sends (one accepted mail)", async () => {
    const w = await world();
    deliverMock.mockReset().mockImplementation(later);
    const out = await submit(w);
    const groupId = String(out.body.data!.group_id);
    const token = String(out.body.data!.access_token);
    const [first] = await attempted(groupId, 1);
    expect(first).toMatchObject({ status: "queued", attempts: 1 });

    // The same cart is notified again (a re-fire of the producer) while the provider is back.
    deliverMock.mockReset().mockImplementation(ok);
    await notifySubmitted(groupId, ORIGIN, token, null);
    const rows = await settled(groupId, 2);
    expect(rows.map((r) => r.status), "the older row was replaced, the newer one sent").toEqual(["replaced", "sent"]);

    // The older row is out of the worker's reach: a tick over both sends nothing under its key.
    await tickNow(rows.map((r) => r.id));
    expect(callsFor(rows[0]!.id), "the replaced row never reached the transport again").toHaveLength(0);
    expect(callsFor(rows[1]!.id)).toHaveLength(1);
    expect(callsToAddress(out.email), "exactly one accepted mail for the cart").toHaveLength(1);
  });

  it("a refused submit (the Lichess link demand) queues no confirmation; the same registrant is confirmed once the demand is off", async () => {
    // The online-chess flag is forced on, the division plays on Lichess and the registrant is anonymous: the submit is refused with
    // 422 LICHESS_LINK_REQUIRED before any cart exists. #1020's refusal is left exactly as it is.
    const owner = await seedOwner();
    made.orgIds.push(owner.orgId);
    made.userIds.push(owner.userId!);
    const competition = await createCompetition(owner, {
      name: `Online Cup ${randomUUID().slice(0, 6)}`,
      visibility: "public",
      branding: {},
      starts_on: "2026-11-01",
      ends_on: "2026-11-02",
    });
    const division = await createDivision(owner, competition.id, {
      name: "Online",
      sport_key: "boardgame",
      variant_key: "classical",
      config: { variant: "classical", onlinePlay: "lichess", clock: { base: 600, increment: 5 } },
    });
    await sql`
      insert into registration_settings
        (division_id, enabled, entrant_kind, fee_cents, capacity, payment_method, approval, allow_free_agents, opens_at, closes_at, form_fields)
      values (${division.id}, true, 'individual', 0, null, 'offline', 'auto', false, null, null, ${sql.json([])})`;
    const [org] = await sql<{ slug: string }[]>`select slug from organizations where id = ${owner.orgId}`;
    const online = { orgSlug: org!.slug, competition, division };

    vi.stubEnv("ONLINE_CHESS_ALWAYS", "1");
    forgetOnlineChessFlagCache();
    const email = address("lichess");
    const refused = await submit(online, { email });
    expect(refused.status).toBe(422);
    expect(refused.body.error?.code).toBe("LICHESS_LINK_REQUIRED");
    expect(await sql`select 1 from registration_groups where contact_email = ${email}`, "no cart was committed").toHaveLength(0);
    expect(await rowsTo(email), "and nothing was queued").toHaveLength(0);
    expect(callsToAddress(email)).toHaveLength(0);

    // The positive pair: with the demand off, the very same registrant is accepted and confirmed (so the refusal above was the demand).
    vi.stubEnv("ONLINE_CHESS_ALWAYS", undefined);
    forgetOnlineChessFlagCache();
    const accepted = await submit(online, { email });
    expect(accepted.status).toBe(201);
    const [row] = await settled(String(accepted.body.data!.group_id), 1);
    expect(row).toMatchObject({ status: "sent", recipient: email });
    expect(callsToAddress(email)).toHaveLength(1);
    forgetOnlineChessFlagCache();
  });

  it("a key fault refuses the submit before any cart is committed", async () => {
    // Review Focus 4: the route cannot let the enqueue be the first to find out, because the submit has committed (and may have minted a
    // Checkout session) by then. With a Resend key set and the outbox KEK unusable the box can send mail it cannot protect.
    const w = await world();
    vi.stubEnv("EMAIL_OUTBOX_KEK", "");
    const email = address("keyfault");
    const out = await submit(w, { email });

    expect(out.status).toBeGreaterThanOrEqual(500);
    expect(JSON.stringify(out.body), "an anonymous caller is not told which variable is missing").not.toMatch(/KEK|EMAIL_OUTBOX/);
    expect(await sql`select 1 from registration_groups where contact_email = ${email}`, "no cart was committed").toHaveLength(0);
    expect(await rowsTo(email), "and no outbox row exists").toHaveLength(0);
    expect(callsToAddress(email)).toHaveLength(0);

    // The positive pair: the same request with a usable key commits the cart and queues its confirmation.
    vi.unstubAllEnvs();
    stubOutboxEnv();
    const fixed = await submit(w, { email });
    expect(fixed.status).toBe(201);
    expect((await sql`select 1 from registration_groups where contact_email = ${email}`).length).toBe(1);
    await settled(String(fixed.body.data!.group_id), 1);
  });

  it("a refused enqueue after the submit committed is logged, and the 201 stands", async () => {
    // P4: the cart is committed and holds its spot; a mail that cannot be queued must not turn that into an error the registrant would
    // read as "it did not work".
    const w = await world();
    const spy = vi.spyOn(log, "error").mockImplementation(() => undefined as never);
    enqueueGate.failOnce = true;
    const email = address("p4");
    const out = await submit(w, { email });

    expect(out.status).toBe(201);
    const groupId = String(out.body.data!.group_id);
    expect(enqueueGate.calls, "premise: the producer did reach the (refusing) enqueue").toBe(1);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ groupId }), expect.stringContaining("confirmation"));
    expect(await rowsOf(groupId), "nothing was queued").toHaveLength(0);
    const [reg] = await sql<{ status: string }[]>`select status from registrations where group_id = ${groupId}`;
    expect(reg!.status, "the cart still holds its spot").toBe("confirmed");

    // The refusal was once: the next submit is queued and sent as usual.
    const next = await submit(w, { email: address("p4b") });
    expect(next.status).toBe(201);
    await settled(String(next.body.data!.group_id), 1);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// 2. The organiser's resend
// ---------------------------------------------------------------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("the organiser's resend rides the outbox (DB)", () => {
  it("the organiser's resend reports sent:false while the outbox retries, and the worker sends it later", async () => {
    const w = await world();
    const { registration } = await seedRegistration(w.competition.id, w.division.id, w.settings, { contactEmail: address("org503") });
    const groupId = registration.group_id;
    deliverMock.mockReset().mockImplementation(later);

    const result = await resendRegistrationConfirmation(w.owner, registration.id, ORIGIN);
    expect(result).toEqual({ sent: false });
    const [row] = await rowsOf(groupId);
    expect(row).toMatchObject({ status: "queued", attempts: 1, org_id: w.orgId, recipient: registration.contact_email });
    expect(row!.last_error).toMatch(/503/);
    expect(row!.sealed, "the body waits sealed for the retry").toBe(true);
    expect(callsFor(row!.id)).toHaveLength(1);

    // The tick, with the retry due and the provider back.
    deliverMock.mockReset().mockImplementation(ok);
    await tickNow([row!.id]);
    const [after] = await rowsOf(groupId);
    expect(after).toMatchObject({ status: "sent", attempts: 2, sealed: false });
    const calls = callsFor(row!.id);
    expect(calls, "the retry sends under the SAME key").toHaveLength(1);
    expect(calls[0]!.subject).toBe(row!.subject);
  });

  it("two separate resends: two rows, the older replaced, the newer sent, two transport calls", async () => {
    // C13: spec section 5 governs. A resend is a deliberate act of the organiser; each one is a mail. What supersedes is the OLDER ROW's
    // standing, so a row that has not been delivered cannot be delivered after a newer one exists.
    const w = await world();
    const { registration } = await seedRegistration(w.competition.id, w.division.id, w.settings, { contactEmail: address("two") });
    const groupId = registration.group_id;

    expect(await resendRegistrationConfirmation(w.owner, registration.id, ORIGIN)).toEqual({ sent: true });
    expect(await resendRegistrationConfirmation(w.owner, registration.id, ORIGIN)).toEqual({ sent: true });

    const rows = await rowsOf(groupId);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.status)).toEqual(["replaced", "sent"]);
    expect(rows[0]!.id).not.toBe(rows[1]!.id);
    expect(callsToAddress(registration.contact_email), "each deliberate resend is one mail").toHaveLength(2);
    expect(callsFor(rows[0]!.id)).toHaveLength(1);
    expect(callsFor(rows[1]!.id)).toHaveLength(1);
    await assertNothingMoreToSend(KIND, rows.map((r) => r.id));
  });

  it("a resend while the first is still queued: the older never sends, one accepted mail", async () => {
    const w = await world();
    const { registration } = await seedRegistration(w.competition.id, w.division.id, w.settings, { contactEmail: address("queued2") });
    const groupId = registration.group_id;

    deliverMock.mockReset().mockImplementation(later);
    expect(await resendRegistrationConfirmation(w.owner, registration.id, ORIGIN)).toEqual({ sent: false });
    deliverMock.mockReset().mockImplementation(ok);
    expect(await resendRegistrationConfirmation(w.owner, registration.id, ORIGIN)).toEqual({ sent: true });

    const rows = await rowsOf(groupId);
    expect(rows.map((r) => r.status)).toEqual(["replaced", "sent"]);
    expect(rows[0]!.sealed, "a replaced row holds no body").toBe(false);
    await tickNow(rows.map((r) => r.id));
    expect(callsFor(rows[0]!.id), "the replaced row is not retried").toHaveLength(0);
    expect(callsToAddress(registration.contact_email), "one accepted mail, not two").toHaveLength(1);
  });

  it("empty input: no group gives no row and no throw", async () => {
    const w = await world();
    // A cart that does not exist.
    const missing = randomUUID();
    await expect(notifySubmitted(missing, ORIGIN, "tok_x", null)).resolves.toBeUndefined();
    expect(await rowsOf(missing)).toHaveLength(0);
    // A cart with no entries.
    const [{ id: empty }] = await sql<{ id: string }[]>`
      insert into registration_groups (competition_id, contact_name, contact_email, access_token_hash, amount_cents, currency)
      values (${w.competition.id}, 'Ghost', ${address("ghost")}, ${randomUUID()}, 0, 'gbp') returning id`;
    await expect(notifySubmitted(empty, ORIGIN, "tok_x", null)).resolves.toBeUndefined();
    expect(await rowsOf(empty)).toHaveLength(0);
    expect(enqueueGate.calls, "the producer never reached the writer").toBe(0);
    // The positive pair: a real cart under the same call is queued (the probe above can see a row).
    const { registration } = await seedRegistration(w.competition.id, w.division.id, w.settings, { contactEmail: address("real") });
    await notifySubmitted(registration.group_id, ORIGIN, "tok_x", null);
    expect(await settled(registration.group_id, 1)).toHaveLength(1);
  });

  it("after withdrawal: resend on a withdrawn entry is refused and queues nothing", async () => {
    const w = await world();
    const { registration } = await seedRegistration(w.competition.id, w.division.id, w.settings, { contactEmail: address("gone") });
    const groupId = registration.group_id;
    await withdrawRegistrationOrganiser(w.owner, registration.id);

    const err = await resendRegistrationConfirmation(w.owner, registration.id, ORIGIN).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(422);
    expect(await rowsOf(groupId), "nothing was queued").toHaveLength(0);
    expect(await rowsTo(registration.contact_email)).toHaveLength(0);
    expect(callsToAddress(registration.contact_email)).toHaveLength(0);

    // The positive pair: a live entry of the same org is resent and queued (so the zero above is the refusal).
    const live = await seedRegistration(w.competition.id, w.division.id, w.settings, { contactEmail: address("live") });
    await resendRegistrationConfirmation(w.owner, live.registration.id, ORIGIN);
    expect(await rowsOf(live.registration.group_id)).toHaveLength(1);
  });

  it("rollback: the organiser's resend whose audit fails queues nothing", async () => {
    const w = await world();
    const { registration } = await seedRegistration(w.competition.id, w.division.id, w.settings, { contactEmail: address("rb") });
    auditGate.failOnce = true;

    await expect(resendRegistrationConfirmation(w.owner, registration.id, ORIGIN)).rejects.toThrow(/audit is down/);
    expect(auditGate.failOnce, "premise: the audit write was reached and refused").toBe(false);
    expect(await rowsOf(registration.group_id), "the enqueue rolled back with the audit").toHaveLength(0);
    expect(callsToAddress(registration.contact_email)).toHaveLength(0);

    // The positive pair: the next resend (audit healthy) queues and sends.
    expect(await resendRegistrationConfirmation(w.owner, registration.id, ORIGIN)).toEqual({ sent: true });
    expect(await rowsOf(registration.group_id)).toHaveLength(1);
  });

  it("rollback, the other way: a resend the outbox refuses leaves no 'resent' entry in the activity log", async () => {
    // The row and the audit entry are one transaction in BOTH directions: an audit that fails queues no mail (above), and a mail that
    // cannot be queued must not leave the log saying it was resent.
    const w = await world();
    const { registration } = await seedRegistration(w.competition.id, w.division.id, w.settings, { contactEmail: address("rb2") });
    const resentEntries = () =>
      sql`select 1 from competition_events where type = 'registration.confirmation_resent' and org_id = ${w.orgId} and payload->>'registration_id' = ${registration.id}`;
    enqueueGate.failOnce = true;

    await expect(resendRegistrationConfirmation(w.owner, registration.id, ORIGIN)).rejects.toThrow(/the outbox refused the row/);
    expect(enqueueGate.calls, "premise: the producer reached the (refusing) writer").toBe(1);
    expect(await resentEntries(), "no audit entry for a mail that was never queued").toHaveLength(0);
    expect(await rowsOf(registration.group_id)).toHaveLength(0);

    // The positive pair: a healthy resend writes both.
    expect(await resendRegistrationConfirmation(w.owner, registration.id, ORIGIN)).toEqual({ sent: true });
    expect(await resentEntries()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// 3. The registrant's own resend
// ---------------------------------------------------------------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("the registrant's own resend rides the outbox (DB)", () => {
  it("reports sent:false while the outbox retries, then the worker sends it; the link is the full rid+token page", async () => {
    const w = await world();
    const { registration, access_token } = await seedRegistration(w.competition.id, w.division.id, w.settings, { contactEmail: address("pub503"), refCode: `SZ-T8${randomUUID().slice(0, 6).toUpperCase()}` });
    const groupId = registration.group_id;
    deliverMock.mockReset().mockImplementation(later);

    expect(await resendRegistrationConfirmationPublic(groupId, access_token, ORIGIN)).toEqual({ sent: false });
    const [row] = await rowsOf(groupId);
    expect(row).toMatchObject({ status: "queued", attempts: 1, org_id: w.orgId, recipient: registration.contact_email, kind: KIND });

    deliverMock.mockReset().mockImplementation(ok);
    await tickNow([row!.id]);
    const [after] = await rowsOf(groupId);
    expect(after).toMatchObject({ status: "sent", sealed: false });
    expect(callsFor(row!.id)[0]!.text).toContain(`rid=${groupId}&token=${access_token}`);
  });

  it("two separate resends: the older replaced, the newer sent, two transport calls; queued-then-resent sends once", async () => {
    const w = await world();
    const { registration, access_token } = await seedRegistration(w.competition.id, w.division.id, w.settings, { contactEmail: address("pub2") });
    const groupId = registration.group_id;

    expect(await resendRegistrationConfirmationPublic(groupId, access_token, ORIGIN)).toEqual({ sent: true });
    expect(await resendRegistrationConfirmationPublic(groupId, access_token, ORIGIN)).toEqual({ sent: true });
    let rows = await rowsOf(groupId);
    expect(rows.map((r) => r.status)).toEqual(["replaced", "sent"]);
    expect(callsToAddress(registration.contact_email)).toHaveLength(2);
    await assertNothingMoreToSend(KIND, rows.map((r) => r.id));

    // Now the first is still queued when the second arrives.
    await sql`delete from email_outbox where kind = ${KIND} and ref_id = ${groupId}`;
    deliverMock.mockClear();
    deliverMock.mockImplementation(later);
    expect(await resendRegistrationConfirmationPublic(groupId, access_token, ORIGIN)).toEqual({ sent: false });
    deliverMock.mockReset().mockImplementation(ok);
    expect(await resendRegistrationConfirmationPublic(groupId, access_token, ORIGIN)).toEqual({ sent: true });
    rows = await rowsOf(groupId);
    expect(rows.map((r) => r.status)).toEqual(["replaced", "sent"]);
    await tickNow(rows.map((r) => r.id));
    expect(callsFor(rows[0]!.id)).toHaveLength(0);
    expect(callsToAddress(registration.contact_email)).toHaveLength(1);
  });

  it("after withdrawal: a cart whose every entry is withdrawn is refused and queues nothing; a cart with one live entry is not", async () => {
    const w = await world();
    const { registration, access_token } = await seedRegistration(w.competition.id, w.division.id, w.settings, { contactEmail: address("pubgone"), status: "withdrawn" });
    const groupId = registration.group_id;

    await expect(resendRegistrationConfirmationPublic(groupId, access_token, ORIGIN)).rejects.toMatchObject({ status: 422 });
    expect(await rowsOf(groupId), "nothing was queued").toHaveLength(0);
    expect(await rowsTo(registration.contact_email)).toHaveLength(0);

    // The positive pair: one live entry in the same cart makes the resend legitimate again.
    await seedSecondEntry(groupId, w.division.id, 0, "Still In", "pending");
    expect(await resendRegistrationConfirmationPublic(groupId, access_token, ORIGIN)).toEqual({ sent: true });
    expect(await rowsOf(groupId)).toHaveLength(1);
  });

  it("a wrong token queues nothing", async () => {
    const w = await world();
    const { registration } = await seedRegistration(w.competition.id, w.division.id, w.settings, { contactEmail: address("pubtok") });
    await expect(resendRegistrationConfirmationPublic(registration.group_id, "rg_" + randomUUID(), ORIGIN)).rejects.toMatchObject({ status: 404 });
    expect(await rowsOf(registration.group_id)).toHaveLength(0);
  });

  it("rollback: the registrant's resend whose audit fails queues nothing", async () => {
    const w = await world();
    const { registration, access_token } = await seedRegistration(w.competition.id, w.division.id, w.settings, { contactEmail: address("pubrb") });
    auditGate.failOnce = true;

    await expect(resendRegistrationConfirmationPublic(registration.group_id, access_token, ORIGIN)).rejects.toThrow(/audit is down/);
    expect(auditGate.failOnce, "premise: the audit write was reached and refused").toBe(false);
    expect(await rowsOf(registration.group_id), "the enqueue rolled back with the audit").toHaveLength(0);
    expect(callsToAddress(registration.contact_email)).toHaveLength(0);

    expect(await resendRegistrationConfirmationPublic(registration.group_id, access_token, ORIGIN)).toEqual({ sent: true });
    expect(await rowsOf(registration.group_id)).toHaveLength(1);
  });

  it("rollback, the other way: a resend the outbox refuses leaves no 'resent' entry in the activity log", async () => {
    const w = await world();
    const { registration, access_token } = await seedRegistration(w.competition.id, w.division.id, w.settings, { contactEmail: address("pubrb2") });
    const resentEntries = () =>
      sql`select 1 from competition_events where type = 'registration.confirmation_resent' and org_id = ${w.orgId} and payload->>'group_id' = ${registration.group_id}`;
    enqueueGate.failOnce = true;

    await expect(resendRegistrationConfirmationPublic(registration.group_id, access_token, ORIGIN)).rejects.toThrow(/the outbox refused the row/);
    expect(enqueueGate.calls, "premise: the producer reached the (refusing) writer").toBe(1);
    expect(await resentEntries(), "no audit entry for a mail that was never queued").toHaveLength(0);

    expect(await resendRegistrationConfirmationPublic(registration.group_id, access_token, ORIGIN)).toEqual({ sent: true });
    expect(await resentEntries()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// 4. D4: the language the mail is written in
// ---------------------------------------------------------------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("D4: the confirmation's language, through the real producers (DB)", () => {
  it("D4: a cart with no locale and an nl org default is written in Dutch (route, organiser resend and registrant resend)", async () => {
    const w = await world({ defaultLocale: "nl" });
    const nl = dictionarySubject("nl", "registration.subject", { competitionName: w.competition.name });
    expect(nl).not.toBe(dictionarySubject("en", "registration.subject", { competitionName: w.competition.name }));

    // The route: no cookie, so no pick.
    const out = await submit(w);
    expect(out.status).toBe(201);
    const [viaRoute] = await settled(String(out.body.data!.group_id), 1);
    expect(viaRoute!.subject).toBe(nl);
    expect(callsFor(viaRoute!.id)[0]!.subject).toBe(nl);

    // Both resends of a cart that holds no locale of its own.
    const { registration, access_token } = await seedRegistration(w.competition.id, w.division.id, w.settings, { contactEmail: address("d4"), locale: null });
    await resendRegistrationConfirmation(w.owner, registration.id, ORIGIN);
    await resendRegistrationConfirmationPublic(registration.group_id, access_token, ORIGIN);
    const rows = await rowsOf(registration.group_id);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.subject)).toEqual([nl, nl]);
  });

  it("the cart's own pick beats the org default, and a cart with no pick falls through to it", async () => {
    const w = await world({ defaultLocale: "nl" });
    const fr = dictionarySubject("fr", "registration.subject", { competitionName: w.competition.name });
    const nl = dictionarySubject("nl", "registration.subject", { competitionName: w.competition.name });

    const picked = await seedRegistration(w.competition.id, w.division.id, w.settings, { contactEmail: address("pickfr"), locale: "fr" });
    await resendRegistrationConfirmation(w.owner, picked.registration.id, ORIGIN);
    expect((await rowsOf(picked.registration.group_id))[0]!.subject, "the pick wins over the org default").toBe(fr);

    // (A pick that is not a shipped locale cannot be stored: registration_groups_locale_valid refuses it, so the fall-through for an
    // unknown tag is recipientLocale's own unit-level concern, not a reachable state of this producer.)
    const none = await seedRegistration(w.competition.id, w.division.id, w.settings, { contactEmail: address("pickless"), locale: null });
    await resendRegistrationConfirmation(w.owner, none.registration.id, ORIGIN);
    expect((await rowsOf(none.registration.group_id))[0]!.subject, "no pick: the org default answers").toBe(nl);
    expect(nl, "premise: the two languages differ, so the assertion can tell them apart").not.toBe(fr);
  });

  it("the registrant's account locale answers when there is no pick (route, signed in) and the pick still wins over it", async () => {
    const w = await world({ defaultLocale: "nl" });
    const userId = await makeUser("fr-account");
    made.userIds.push(userId);
    await sql`update users set locale = 'fr' where id = ${userId}`;
    const fr = dictionarySubject("fr", "registration.subject", { competitionName: w.competition.name });
    const es = dictionarySubject("es", "registration.subject", { competitionName: w.competition.name });

    authState.userId = userId;
    const noPick = await submit(w);
    expect(noPick.status).toBe(201);
    const [a] = await settled(String(noPick.body.data!.group_id), 1);
    expect(a!.subject, "no pick: the account's French, not the org's Dutch").toBe(fr);
    const [g] = await sql<{ user_id: string | null }[]>`select user_id from registration_groups where id = ${String(noPick.body.data!.group_id)}`;
    expect(g!.user_id, "premise: the cart is linked to the account").toBe(userId);

    const withPick = await submit(w, { cookie: "seazn_locale=es" });
    const [b] = await settled(String(withPick.body.data!.group_id), 1);
    expect(b!.subject, "an explicit pick beats the account").toBe(es);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// 5. A queued row is a frozen snapshot (owner ruling 2026-10-26)
// ---------------------------------------------------------------------------------------------------------------------------------
//
// A confirmation can wait for its retries (1 min, 5 min, 15 min, 1 h, 6 h). What its body states is fixed when the row is written.
// The facts that can change while it waits are the entries' statuses and fees (a payment, a waive, an approval, a promotion, a
// withdrawal), so the cart's total, the pay link and its deadline, the payment instructions, and the organisation's and the
// competition's names. Only a RESEND refreshes it: the resend writes a new row, and the replace rule retires the stale one. Nothing
// refreshes or cancels it on its own, and no cancel reason in CANCELLED_REASONS (round_voided, board_settled, fixture_deleted) is
// about a registration, so a withdrawal does not cancel it (the second test documents that, as it stands).

describe.skipIf(!HAS_DB)("a queued confirmation is a frozen snapshot (DB)", () => {
  const paidLine = dictionarySubject("en", "registration.textFee", { amount: "£15.00" });

  it("a fact changed while the row waits: a resend retires the stale row and the NEW state is what sends", async () => {
    const w = await world({ fee: 1500 });
    deliverMock.mockReset().mockImplementation(later);
    const out = await submit(w);
    const groupId = String(out.body.data!.group_id);
    const regId = String((out.body.data!.entries as { registration_id: string }[])[0]!.registration_id);
    const [stale] = await attempted(groupId, 1);
    expect(stale).toMatchObject({ status: "queued", attempts: 1 });
    const staleText = openBody(stale!.body_sealed!).text;
    expect(staleText, "premise: the waiting row asks for the fee").toContain(paidLine);

    // The fact changes while the row waits: the organiser records the payment (the entry is now confirmed and owes nothing).
    await markRegistrationPaidOffline(w.owner, regId);
    const [still] = await rowsOf(groupId);
    expect(openBody(still!.body_sealed!).text, "the waiting row did NOT follow the change: it is a snapshot").toBe(staleText);

    // The resend writes the new state; the stale row is retired and the provider is back.
    deliverMock.mockReset().mockImplementation(ok);
    expect(await resendRegistrationConfirmation(w.owner, regId, ORIGIN)).toEqual({ sent: true });
    const rows = await rowsOf(groupId);
    expect(rows.map((r) => r.status)).toEqual(["replaced", "sent"]);
    await tickNow(rows.map((r) => r.id));

    const sent = callsToAddress(out.email);
    expect(sent, "exactly one mail was accepted, and it is the new one").toHaveLength(1);
    expect(sent[0]!.text, "the mail that arrived no longer asks for the fee").not.toContain(paidLine);
    expect(sent[0]!.text).not.toBe(staleText);
    expect(callsFor(rows[0]!.id), "the stale row was never sent again").toHaveLength(0);
  });

  it("CURRENT BEHAVIOUR: a withdrawal while the confirmation waits does not cancel it, the stale confirmation is what sends", async () => {
    // There is no cancel reason for a registration (the three in CANCELLED_REASONS are about online chess boards), and the owner's ruling
    // is not to invent one. This test pins what happens today so a change is a decision, not an accident: the registrant who has pulled
    // out still gets the mail that was queued before they did, and it states their old state.
    const w = await world({ fee: 1500 });
    deliverMock.mockReset().mockImplementation(later);
    const out = await submit(w);
    const groupId = String(out.body.data!.group_id);
    const regId = String((out.body.data!.entries as { registration_id: string }[])[0]!.registration_id);
    const [waiting] = await attempted(groupId, 1);
    const frozenText = openBody(waiting!.body_sealed!).text;

    await withdrawRegistrationOrganiser(w.owner, regId);
    const [reg] = await sql<{ status: string }[]>`select status from registrations where id = ${regId}`;
    expect(reg!.status, "premise: the entry is withdrawn").toBe("withdrawn");
    const [after] = await rowsOf(groupId);
    expect(after, "the withdrawal left the row queued and its body in place").toMatchObject({ status: "queued", sealed: true });

    deliverMock.mockReset().mockImplementation(ok);
    await tickNow([waiting!.id]);
    const [sentRow] = await rowsOf(groupId);
    expect(sentRow!.status).toBe("sent");
    const calls = callsFor(waiting!.id);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.text, "the mail is the stale one, word for word").toBe(frozenText);
    expect(calls[0]!.text).toContain(paidLine);
  });
});
