// The kind sweep (phase 3 wave 1, T7): every kind in OUTBOX_KINDS is driven through its REAL producer, and the rows it leaves behind are
// judged against the SPEC's table of what each kind is, not against the code's own declaration (`OUTBOX_KIND_FACTS` is checked against
// the same table by enqueue-once.test.ts; this file is the producer-level half). The harness is `_kind-harness.ts`; this file holds the
// scenarios (one per kind that has moved to the outbox), the spec's lists, and the harness's own tests.
//
//   - magic_link: the route POST of app/api/auth/magic-link/route.ts (the real token minter, the real enqueue, the real `dispatchNow`).
//   - chess_invite: the real `openRound` on a `seedOnlineChessRound` whose player's account is `es` (the real invite renderer, the
//     real account-kind enqueue, the real dispatch). Only `transport.deliver` is replaced: it is the network.
//
// Each kind task (T8-T12) adds its scenario and deletes its entry from NOT_YET_MOVED (in _kind-senders.ts, with its `send*` in
// SENDER_ALLOWLIST and its KIND_DIRECT_SENDER entry); T12 deletes the list. A kind that is neither moved nor listed fails by name, and so
// does a kind that is listed while it has a scenario (a stale entry would skip the sweep), and so do the three lists when they disagree.
//
// Sport: not applicable. These emails do not vary by sport (spec, Test strategy 4).
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { sql } from "@/lib/db";

vi.mock("@/lib/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rate-limit")>()),
  rateLimit: vi.fn(async () => {}),
}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": "203.0.113.78" }),
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
}));
// The one network seam. The harness reads this same mock back (it imports `deliver` from the same module).
const deliverMock = vi.hoisted(() => vi.fn());
vi.mock("@/server/email-outbox/transport", () => ({ deliver: deliverMock }));

import { POST as magicLinkPost } from "@/app/api/auth/magic-link/route";
import { openRound } from "@/server/usecases/external-play/open-round";
import { seedOnlineChessRound } from "@/server/usecases/__tests__/_external-play-seed";
import { DISPATCH_NOW_BUDGET_MS, DISPATCH_NOW_MARGIN_MS, OUTBOX_KINDS, idempotencyKey, type OutboxKind } from "../constants";
import { dispatchNow } from "../attempt";
import { enqueueEmail, type OutboxMessage } from "../enqueue";
import { REQUEST_ATTEMPT_WAIT_MS, assertNothingMoreToSend, dictionarySubject, forEachOutboxKind, type KindFacts, type KindScenario } from "./_kind-harness";
import { allowlistLengthFor, KIND_DIRECT_SENDER, NOT_YET_MOVED, SENDER_ALLOWLIST } from "./_kind-senders";

const HAS_DB = !!process.env.DATABASE_URL;
const RUN = `ks-${randomUUID().slice(0, 8)}`;
const KEK = "ab".repeat(32);
const MIN = 60_000;

// ---------------------------------------------------------------------------------------------------------------------------------
// Typed from the SPEC (docs/superpowers/specs/2026-10-25-email-outbox-phase3-design.md, the kind table and its legend), never read
// from constants.ts.
// ---------------------------------------------------------------------------------------------------------------------------------

const SPEC_KINDS = [
  "magic_link",
  "chess_invite",
  "registration_confirmation",
  "payment_reminder",
  "registration_promoted",
  "refund_issued",
  "solo_signup_assigned",
] as const satisfies readonly OutboxKind[];

/** The legend: [to, transactional]. A = an account, resolved at send; L = a literal address; S = the staff address. T = transactional. */
const SPEC_FACTS: KindFacts = {
  magic_link: ["literal", true],
  chess_invite: ["account", true],
  registration_confirmation: ["literal", false],
  payment_reminder: ["literal", false],
  registration_promoted: ["literal", false],
  refund_issued: ["literal", false],
  solo_signup_assigned: ["literal", false],
};

/** What the real producers create beyond the rows the hand-made scenarios name: the seeded round's people and organisation. (The
 *  addresses this run mails all start with RUN, so the accounts the magic-link route makes and the ones `accountAt` makes are found
 *  by address; a seeded player's address is not ours, so those are tracked by id.) */
const made = { userIds: [] as string[], orgIds: [] as string[] };

/** Everything this file wrote: outbox rows (the real producers write `ref_id` = a user id or a seat key, not RUN, so by recipient and
 *  by account too), the seeded organisation (cascades its competition, fixtures and seats), then the accounts (login links cascade). */
async function cleanUp(): Promise<void> {
  const like = `${RUN}-%`;
  await sql`
    delete from email_outbox
     where ref_id like ${like} or lower(recipient) like ${like} or recipient_user_id = any(${made.userIds}::uuid[])
        or recipient_user_id in (select id from users where email like ${like})`;
  if (made.orgIds.length > 0) await sql`delete from organizations where id = any(${made.orgIds}::uuid[])`;
  // The seeded owner is referenced without a cascade by the plan it was given and by the round's audit trail.
  await sql`delete from subscriptions where owner_user_id = any(${made.userIds}::uuid[])`;
  await sql`delete from online_chess_audit where actor_user_id = any(${made.userIds}::uuid[])`;
  await sql`delete from users where email like ${like} or id = any(${made.userIds}::uuid[])`;
}

afterAll(async () => {
  if (HAS_DB) {
    await cleanUp();
    await sql.end({ timeout: 2 }).catch(() => undefined);
  }
});

beforeEach(() => {
  vi.stubEnv("EMAIL_OUTBOX_KEK", KEK);
  vi.stubEnv("RESEND_API_KEY", "re_test_sweep");
  deliverMock.mockReset();
  deliverMock.mockImplementation(async () => ({ ok: true, providerId: `re_${RUN}_${randomUUID()}` }));
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the spec's lists (no database)", () => {
  it("the spec lists seven kinds and the code's registry is exactly them, in the spec's order", () => {
    expect([...OUTBOX_KINDS]).toEqual([...SPEC_KINDS]);
    expect(SPEC_KINDS).toHaveLength(7);
  });

  it("the legend has SIX literal kinds (magic_link and the five wave-1 mails) and one account kind (chess_invite) (R-T2a)", () => {
    const by = (to: string): string[] => SPEC_KINDS.filter((k) => SPEC_FACTS[k][0] === to);
    expect(by("literal")).toEqual(["magic_link", "registration_confirmation", "payment_reminder", "registration_promoted", "refund_issued", "solo_signup_assigned"]);
    expect(by("account")).toEqual(["chess_invite"]);
    expect(by("staff"), "wave 1 has no staff kind").toEqual([]);
    // The two phase-1 kinds are transactional, the five registration and refund mails are not.
    expect(SPEC_KINDS.filter((k) => SPEC_FACTS[k][1])).toEqual(["magic_link", "chess_invite"]);
  });

  it("the not-yet-moved list names only spec kinds, once each, and leaves at least one kind to sweep", () => {
    expect(new Set(NOT_YET_MOVED).size).toBe(NOT_YET_MOVED.length);
    for (const k of NOT_YET_MOVED) expect(SPEC_KINDS as readonly string[]).toContain(k);
    expect(SPEC_KINDS.length - NOT_YET_MOVED.length).toBeGreaterThan(0);
  });

  it("the three lists agree: a kind is unmoved exactly when its direct sender is still in the allowlist of lib/email's senders", () => {
    expect(Object.keys(KIND_DIRECT_SENDER).sort(), "the map names every kind, once").toEqual([...SPEC_KINDS].sort());
    let checked = 0;
    for (const k of SPEC_KINDS) {
      const sender = KIND_DIRECT_SENDER[k];
      const unmoved = NOT_YET_MOVED.includes(k);
      const stillExported = sender !== null && SENDER_ALLOWLIST.includes(sender);
      expect(
        unmoved,
        `${k}: ${unmoved ? "listed as not yet moved" : "not listed as unmoved"}, but its direct sender ${sender ?? "(none: moved)"} is ${stillExported ? "still" : "no longer"} in SENDER_ALLOWLIST`,
      ).toBe(stillExported);
      // The map says the same thing in its own words: a kind with a sender has not moved.
      expect(unmoved, `${k}: ${sender === null ? "no direct sender in the map, so it has moved" : `the map names ${sender}, so it has not moved`}`).toBe(sender !== null);
      checked += 1;
    }
    expect(checked, "anti-vacuity: every kind was judged").toBe(SPEC_KINDS.length);
    // Both sides of the equivalence are exercised: kinds that have moved and kinds that have not.
    expect(NOT_YET_MOVED.length).toBeGreaterThan(0);
    expect(SPEC_KINDS.length - NOT_YET_MOVED.length).toBeGreaterThan(0);
    const senders = Object.values(KIND_DIRECT_SENDER).filter((x): x is string => x !== null);
    expect(new Set(senders).size, "no two kinds share a direct sender").toBe(senders.length);
    // The map and NOT_YET_MOVED can be edited together and still leave the moved kind's `send*` in lib/email.ts and the allowlist: with
    // the entry nulled, no list names that sender any more. What catches it is the count, which the spec fixes: 49 senders at the start
    // of wave 1, one fewer for every kind that has moved. (The allowlist is held to lib/email.ts by name in no-second-path.test.ts.)
    expect(
      SENDER_ALLOWLIST.length,
      `${NOT_YET_MOVED.length} kinds are still unmoved, so the allowlist holds ${allowlistLengthFor(NOT_YET_MOVED.length)} senders: a moved kind's send* was left behind (or a sender was dropped for a kind that has not moved)`,
    ).toBe(allowlistLengthFor(NOT_YET_MOVED.length));
  });

  it("the harness waits for a request's own attempt longer than the longest a correct dispatchNow can still be working", () => {
    // dispatchNow's budget, plus the one request in flight and the write transaction before it (constants.ts); the harness's wait
    // must be strictly past that or a slow but correct producer is called broken. Derived from the declarations, not typed here.
    expect(REQUEST_ATTEMPT_WAIT_MS).toBeGreaterThan(DISPATCH_NOW_BUDGET_MS + DISPATCH_NOW_MARGIN_MS);
  });
});

describe("dictionarySubject reads the dictionary on disk (no database)", () => {
  it("fills the tokens from the dictionary of the locale it is given, and the locales differ", () => {
    const vars = { roundNo: "3", opponentName: "Ana Opponent" };
    const en = dictionarySubject("en", "externalPlayInvite.subject", vars);
    const es = dictionarySubject("es", "externalPlayInvite.subject", vars);
    for (const subject of [en, es]) {
      expect(subject).toContain("Ana Opponent");
      expect(subject).toContain("3");
      expect(subject, "no token left").not.toMatch(/\{\w+\}/);
    }
    expect(es, "a Spanish subject is not the English one").not.toBe(en);
    expect(dictionarySubject("en", "magicLink.subject", {}), "a subject with no tokens needs none").toBe(JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../dictionaries/en/emails.json"), "utf8"))["magicLink.subject"]);
  });

  it("refuses an unknown key and a token nobody gave a value for (a sentence must not go out with a brace in it)", () => {
    expect(() => dictionarySubject("en", "externalPlayInvite.noSuchKey", {})).toThrow(/no key/);
    expect(() => dictionarySubject("en", "externalPlayInvite.subject", { roundNo: "3" })).toThrow(/still has \{opponentName\}/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// The scenarios: one per moved kind, each through its real producer.
// ---------------------------------------------------------------------------------------------------------------------------------

const address = (): string => `${RUN}-${randomUUID().slice(0, 8)}@x.test`;

function magicLinkScenario(): KindScenario {
  const recipient = address();
  return {
    // The route passes no locale to `magicLinkEmail` (route.ts:84): account email is rendered in `en` until wave 3.
    locale: "en",
    subjectKey: "magicLink.subject",
    subjectVars: {},
    recipient,
    firstAttempt: "request",
    run: async () => {
      const res = await magicLinkPost(
        new Request("https://sweep.test/api/auth/magic-link", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: recipient }),
        }),
      );
      expect(res.status, "premise: the real route answered 200").toBe(200);
    },
  };
}

/** The real open of a one-board online round whose WHITE-or-BLACK player (the seed's `home`) has an `es` account. The other player is
 *  mailed too, but this scenario judges only `home`'s rows (the scenario names one recipient). */
async function chessInviteScenario(): Promise<KindScenario> {
  const r = await seedOnlineChessRound({ fixtures: 1 });
  const board = r.boards[0]!;
  made.orgIds.push(r.orgId);
  made.userIds.push(r.ownerUserId, board.home.userId, board.away.userId);
  await sql`update users set locale = 'es' where id = ${board.home.userId}`;
  // The opponent's name as the seed made it: the person row, read back (not the invite's own view of it).
  const [opponent] = await sql<{ full_name: string }[]>`select full_name from persons where id = ${board.away.personId}`;
  return {
    locale: "es",
    subjectKey: "externalPlayInvite.subject",
    subjectVars: { roundNo: String(r.roundNo), opponentName: opponent!.full_name },
    recipient: board.home.email,
    firstAttempt: "request",
    run: async () => {
      const out = await openRound({ stageId: r.stageId, roundNo: r.roundNo, actorUserId: r.ownerUserId });
      expect(out, "premise: the real open stamped the round and invited it").toMatchObject({ opened: true });
    },
  };
}

describe.skipIf(!HAS_DB)("every outbox kind is swept through its real producer (DB)", () => {
  it("every outbox kind is swept through its real producer", async () => {
    // The Spanish subject differs from the English one, so a producer that dropped the locale would be seen (the right answer is not
    // the wrong one's constant).
    const chess = await chessInviteScenario();
    expect(dictionarySubject("es", chess.subjectKey, chess.subjectVars)).not.toBe(dictionarySubject("en", chess.subjectKey, chess.subjectVars));

    const out = await forEachOutboxKind({ magic_link: magicLinkScenario(), chess_invite: chess }, { notYetMoved: NOT_YET_MOVED, specFacts: SPEC_FACTS });

    expect(out.checked, "anti-vacuity: the kinds that have moved were all swept").toBe(SPEC_KINDS.length - NOT_YET_MOVED.length);
    expect(out.checked).toBeGreaterThan(0);
    expect(out.kinds, "and they are exactly the spec's kinds that are not listed as unmoved").toEqual(SPEC_KINDS.filter((k) => !NOT_YET_MOVED.includes(k)));
  }, 60_000);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// The harness's own tests: every guard in it has a case that reaches it. A scenario here is hand-made on purpose (it is the harness
// that is under test, not a producer); `notYetMoved` is everything else so only the kind under test is judged.
// ---------------------------------------------------------------------------------------------------------------------------------

const except = (...kept: OutboxKind[]): OutboxKind[] => OUTBOX_KINDS.filter((k) => !kept.includes(k));

function row(over: Partial<OutboxMessage> & { to: string }): OutboxMessage {
  return {
    kind: "magic_link",
    refType: "login",
    refId: `${RUN}-${randomUUID()}`,
    orgId: null,
    subject: dictionarySubject("en", "magicLink.subject", {}),
    html: "<p>hi</p>",
    text: "hi",
    transactional: true,
    expiresAt: new Date(Date.now() + 15 * MIN),
    ...over,
  };
}

/** A magic_link scenario whose `run` is the given producer; everything else is the right answer. */
function handMade(over: Omit<Partial<KindScenario>, "run"> & { run: (to: string) => Promise<void> }): KindScenario {
  const recipient = over.recipient ?? address();
  const { run, ...rest } = over;
  return { locale: "en", subjectKey: "magicLink.subject", subjectVars: {}, recipient, firstAttempt: "request", ...rest, run: () => run(recipient) };
}

/** An account at exactly this address (an account kind's row is addressed to its account at send, so they must agree). Returns its id. */
async function accountAt(email: string): Promise<string> {
  const [u] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified) values (${email}, 'Sweep probe', true) returning id`;
  return u!.id;
}

/** A producer that writes the row and sends it in the request, as the real routes do. */
const sendsInRequest =
  (over: Partial<OutboxMessage> = {}) =>
  async (to: string): Promise<void> => {
    const id = await enqueueEmail(sql, row({ ...over, to }));
    await dispatchNow([id]);
  };

const swept = (scenarios: Partial<Record<OutboxKind, KindScenario>>, facts: KindFacts = SPEC_FACTS, notYetMoved?: readonly OutboxKind[]) =>
  forEachOutboxKind(scenarios, { notYetMoved: notYetMoved ?? except(...(Object.keys(scenarios) as OutboxKind[])), specFacts: facts });

describe.skipIf(!HAS_DB)("the harness judges what it says it judges (DB)", () => {
  afterEach(async () => {
    await cleanUp();
  });

  it("a kind with no scenario fails by name", async () => {
    await expect(forEachOutboxKind({}, { notYetMoved: [], specFacts: SPEC_FACTS })).rejects.toThrow(/no scenario for outbox kind magic_link/);
    // The name is the FIRST kind without one: give it a scenario and the next kind is named.
    await expect(forEachOutboxKind({ magic_link: handMade({ run: sendsInRequest() }) }, { notYetMoved: [], specFacts: SPEC_FACTS })).rejects.toThrow(
      /no scenario for outbox kind chess_invite/,
    );
  });

  it("a row whose transactional flag disagrees with the spec fails", async () => {
    const wrong = handMade({ run: sendsInRequest({ transactional: false }) });
    await expect(swept({ magic_link: wrong })).rejects.toThrow(/magic_link[\s\S]*transactional/);
    // The other direction: a kind the spec calls NOT transactional, written as transactional.
    const facts: KindFacts = { ...SPEC_FACTS, magic_link: ["literal", false] };
    await expect(swept({ magic_link: handMade({ run: sendsInRequest({ transactional: true }) }) }, facts)).rejects.toThrow(/magic_link[\s\S]*transactional/);
  });

  it("an account kind whose row names no account fails, and a literal kind whose row names one fails (both directions)", async () => {
    const chess = { kind: "chess_invite", refType: "fixture_seat" } as const;
    // Account kind, no id (the phase-1 shape the writer's own guard lets through on purpose).
    await expect(swept({ chess_invite: handMade({ run: sendsInRequest(chess) }) })).rejects.toThrow(/chess_invite[\s\S]*recipient_user_id/);
    // Literal in the spec's table, but the producer wrote an account id (the writer allows that for an account kind).
    const a = address();
    const withId = handMade({ recipient: a, run: sendsInRequest({ ...chess, recipientUserId: await accountAt(a) }) });
    await expect(swept({ chess_invite: withId }, { ...SPEC_FACTS, chess_invite: ["literal", true] })).rejects.toThrow(/chess_invite[\s\S]*recipient_user_id/);
    // The positive pair: the account kind WITH an id, the spec's own table, passes.
    const b = address();
    const good = handMade({ recipient: b, run: sendsInRequest({ ...chess, recipientUserId: await accountAt(b) }) });
    await expect(swept({ chess_invite: good })).resolves.toMatchObject({ checked: 1, kinds: ["chess_invite"] });
  });

  it("a staff kind is judged like a literal one: no account id (T2 m1; the first real staff kind arrives with wave 5)", async () => {
    const staff: KindFacts = { ...SPEC_FACTS, magic_link: ["staff", true], chess_invite: ["staff", true] };
    await expect(swept({ magic_link: handMade({ run: sendsInRequest() }) }, staff)).resolves.toMatchObject({ checked: 1 });
    const a = address();
    const named = handMade({ recipient: a, run: sendsInRequest({ kind: "chess_invite", refType: "fixture_seat", recipientUserId: await accountAt(a) }) });
    await expect(swept({ chess_invite: named }, staff)).rejects.toThrow(/chess_invite[\s\S]*recipient_user_id/);
  });

  it("a scenario that writes no row fails (at least one row is required)", async () => {
    await expect(swept({ magic_link: handMade({ run: async () => undefined }) })).rejects.toThrow(/magic_link[\s\S]*no outbox row/);
  });

  it("the recipient is matched case-insensitively (an address is the same mailbox in any case)", async () => {
    // The scenario names the lower-case address; the row is written to the upper-case one.
    const scenario = handMade({ recipient: address(), run: (to) => sendsInRequest()(to.toUpperCase()) });
    await expect(swept({ magic_link: scenario })).resolves.toMatchObject({ checked: 1 });
  });

  it("the subject must be the dictionary's, in the scenario's locale", async () => {
    const wrongKey = handMade({ subjectKey: "magicLink.title", run: sendsInRequest() });
    await expect(swept({ magic_link: wrongKey })).rejects.toThrow(/magic_link[\s\S]*subject/);
    // The right key in the wrong locale: the English row is not the Spanish dictionary's.
    const wrongLocale = handMade({ locale: "es", run: sendsInRequest() });
    await expect(swept({ magic_link: wrongLocale })).rejects.toThrow(/magic_link[\s\S]*subject/);
  });

  it("the mail is addressed to the scenario's recipient: an account that moved after the write and before the send is seen", async () => {
    const recipient = address();
    const userId = await accountAt(recipient);
    const moved = handMade({
      firstAttempt: "worker",
      recipient,
      run: async (to) => {
        await enqueueEmail(sql, row({ kind: "chess_invite", refType: "fixture_seat", recipientUserId: userId, to }));
        // The account's address changes before the worker sends: an account kind follows it (phase-3 spec section 6).
        await sql`update users set email = ${address()} where id = ${userId}`;
      },
    });
    await expect(swept({ chess_invite: moved })).rejects.toThrow(/chess_invite[\s\S]*another address/);
  });

  it("the stored subject and the sent subject are each judged (a producer that edits one after the other is seen both ways)", async () => {
    const right = dictionarySubject("en", "magicLink.subject", {});
    // The row says one thing and the mail said another: the row is rewritten after the send.
    const storedWrong = handMade({
      run: async (to) => {
        const id = await enqueueEmail(sql, row({ to }));
        await dispatchNow([id]);
        await sql`update email_outbox set subject = 'rewritten after the send' where id = ${id}`;
      },
    });
    await expect(swept({ magic_link: storedWrong })).rejects.toThrow(/magic_link[\s\S]*queued with subject/);
    // The mail said one thing and the row says another: the row is edited for the send and restored after it.
    const sentWrong = handMade({
      run: async (to) => {
        const id = await enqueueEmail(sql, row({ to }));
        await sql`update email_outbox set subject = 'edited for the send' where id = ${id}`;
        await dispatchNow([id]);
        await sql`update email_outbox set subject = ${right} where id = ${id}`;
      },
    });
    await expect(swept({ magic_link: sentWrong })).rejects.toThrow(/magic_link[\s\S]*was sent with subject/);
  });

  it("the transport is called exactly once per row: a second send of one row (a second path) fails", async () => {
    const twice = handMade({
      run: async (to) => {
        const id = await enqueueEmail(sql, row({ to }));
        await dispatchNow([id]);
        // The bypass shape: something else mails the same row's key again.
        await (await import("@/server/email-outbox/transport")).deliver(
          { to, subject: "again", html: "<p>x</p>", text: "x", transactional: true, idempotencyKey: idempotencyKey(id), tags: { outbox: id } },
          "re_x",
        );
      },
    });
    // Two calls, not "not exactly one": a row that never reached the transport says "0 times" in the same sentence.
    await expect(swept({ magic_link: twice })).rejects.toThrow(/outbox kind magic_link: row \S+ reached the transport 2 times, expected exactly once/);
  });

  it("a request-path kind is waited for: a producer that does not await its own dispatch still passes once the row is sent", async () => {
    deliverMock.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 400));
      return { ok: true, providerId: `re_${RUN}_${randomUUID()}` };
    });
    const background = handMade({
      run: async (to) => {
        const id = await enqueueEmail(sql, row({ to }));
        void dispatchNow([id]); // the request returned; the send is still in flight
      },
    });
    const t0 = Date.now();
    await expect(swept({ magic_link: background })).resolves.toMatchObject({ checked: 1 });
    expect(Date.now() - t0, "premise: the producer really returned before the send finished").toBeGreaterThanOrEqual(300);
    expect(deliverMock).toHaveBeenCalledTimes(1);
  });

  it("a worker-path kind: the row waits queued with no attempt, then one tick sends it", async () => {
    const worker = handMade({
      firstAttempt: "worker",
      run: async (to) => {
        await enqueueEmail(sql, row({ to }));
      },
    });
    await expect(swept({ magic_link: worker })).resolves.toMatchObject({ checked: 1 });
    expect(deliverMock).toHaveBeenCalledTimes(1);
  });

  it("a worker-path kind whose producer already sent the row fails (it said the worker sends first)", async () => {
    const eager = handMade({ firstAttempt: "worker", run: sendsInRequest() });
    await expect(swept({ magic_link: eager })).rejects.toThrow(/magic_link[\s\S]*queued/);
  });

  it("a worker-path kind whose row already had an attempt fails, even if the worker would take it (a first attempt is the worker's, once)", async () => {
    const retried = handMade({
      firstAttempt: "worker",
      run: async (to) => {
        const id = await enqueueEmail(sql, row({ to }));
        // The shape of a request that tried and was told 503: one attempt, due again now. The worker WOULD send it.
        await sql`update email_outbox set attempts = 1, next_attempt_at = now() - interval '1 second' where id = ${id}`;
      },
    });
    await expect(swept({ magic_link: retried })).rejects.toThrow(/magic_link[\s\S]*1 attempt/);
  });

  it("a request-path kind whose row is never attempted fails once the wait is up, naming the request's own attempt", async () => {
    // The producer wrote the row and returned; nothing ever sends it in the request (and the worker is not run for a request kind).
    const neverSent = handMade({ run: async (to) => void (await enqueueEmail(sql, row({ to }))) });
    const t0 = Date.now();
    await expect(
      forEachOutboxKind({ magic_link: neverSent }, { notYetMoved: except("magic_link"), specFacts: SPEC_FACTS, requestWaitMs: 400 }),
    ).rejects.toThrow(/outbox kind magic_link: the request's own attempt did not finish: 1 row\(s\) still queued or sending/);
    expect(Date.now() - t0, "it waited the wait it was given, not forever").toBeLessThan(10_000);
    expect(deliverMock, "and nothing was sent").not.toHaveBeenCalled();
  });

  it("the second call: a sent row stays untouched by dispatchNow again and by a tick that finds it due; a row that IS sendable is seen", async () => {
    const id = await enqueueEmail(sql, row({ to: address() }));
    await dispatchNow([id]);
    const [sent] = await sql<{ status: string }[]>`select status from email_outbox where id = ${id}`;
    expect(sent!.status, "premise: the first attempt sent it").toBe("sent");
    await expect(assertNothingMoreToSend("magic_link", [id])).resolves.toBeUndefined();
    expect(deliverMock, "the first send is the only one").toHaveBeenCalledTimes(1);

    // The same check over a row that has not been sent: the second call IS its first, and the check says so.
    const queued = await enqueueEmail(sql, row({ to: address() }));
    await expect(assertNothingMoreToSend("magic_link", [queued])).rejects.toThrow(/outbox kind magic_link: a second call sent 1 more time/);

    // A second call that sends nothing but ends a row (it expired between the calls) still changed it.
    const expiring = await enqueueEmail(sql, row({ to: address() }));
    await sql`update email_outbox set expires_at = now() - interval '1 minute' where id = ${expiring}`;
    await expect(assertNothingMoreToSend("magic_link", [expiring])).rejects.toThrow(/outbox kind magic_link: a second call changed the rows/);
  });

  it("a row that ended dead fails, though the transport was called once with the right subject (the provider's refusal is not a send)", async () => {
    deliverMock.mockImplementation(async () => ({ ok: false, reason: "http", status: 422, errorName: "validation_error", detail: "refused" }));
    await expect(swept({ magic_link: handMade({ run: sendsInRequest() }) })).rejects.toThrow(/magic_link[\s\S]*ended dead/);
  });

  it("a scenario given for something that is not a kind fails by name (a typo would otherwise be a sweep that never ran)", async () => {
    const typo = { magic_link: handMade({ run: sendsInRequest() }), "magic-link": handMade({ run: sendsInRequest() }) } as unknown as Partial<Record<OutboxKind, KindScenario>>;
    await expect(forEachOutboxKind(typo, { notYetMoved: except("magic_link"), specFacts: SPEC_FACTS })).rejects.toThrow(/magic-link/);
  });

  it("a scenario for a kind that is also listed as not yet moved fails (a stale entry would skip the sweep)", async () => {
    await expect(
      forEachOutboxKind({ magic_link: handMade({ run: sendsInRequest() }) }, { notYetMoved: OUTBOX_KINDS, specFacts: SPEC_FACTS }),
    ).rejects.toThrow(/magic_link[\s\S]*notYetMoved/);
  });

  it("a not-yet-moved entry that is not a kind fails, and so does a legend that omits a kind", async () => {
    await expect(forEachOutboxKind({}, { notYetMoved: ["magic-link" as OutboxKind, ...OUTBOX_KINDS], specFacts: SPEC_FACTS })).rejects.toThrow(/magic-link/);
    const { magic_link: _dropped, ...rest } = SPEC_FACTS;
    void _dropped;
    await expect(
      forEachOutboxKind({ magic_link: handMade({ run: sendsInRequest() }) }, { notYetMoved: except("magic_link"), specFacts: rest as unknown as KindFacts }),
    ).rejects.toThrow(/no spec fact for outbox kind magic_link/);
  });

  it("with every kind unmoved nothing is swept, and the count says so (zero is the caller's failure to refuse)", async () => {
    await expect(forEachOutboxKind({}, { notYetMoved: OUTBOX_KINDS, specFacts: SPEC_FACTS })).resolves.toEqual({ checked: 0, kinds: [] });
  });
});
