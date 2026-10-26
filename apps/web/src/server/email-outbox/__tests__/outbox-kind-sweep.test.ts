// The kind sweep (phase 3 wave 1, T7): every kind in OUTBOX_KINDS is driven through its REAL producer, and the rows it leaves behind are
// judged against the SPEC's table of what each kind is, not against the code's own declaration (`OUTBOX_KIND_FACTS` is checked against
// the same table by enqueue-once.test.ts; this file is the producer-level half). The harness is `_kind-harness.ts`; this file holds the
// scenarios (one per kind that has moved to the outbox), the spec's lists, and the harness's own tests.
//
//   - magic_link: the route POST of app/api/auth/magic-link/route.ts (the real token minter, the real enqueue, the real `dispatchNow`).
//   - chess_invite: the real `openRound` on a `seedOnlineChessRound` whose player's account is `es` (the real invite renderer, the
//     real account-kind enqueue, the real dispatch). Only `transport.deliver` is replaced: it is the network.
//
// Each kind task (T8-T12) adds its scenario and deletes its entry from NOT_YET_MOVED; T12 deletes the list. A kind that is neither
// moved nor listed fails by name, and so does a kind that is listed while it has a scenario (a stale entry would skip the sweep).
//
// Sport: not applicable. These emails do not vary by sport (spec, Test strategy 4).
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
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
import { OUTBOX_KINDS, idempotencyKey, type OutboxKind } from "../constants";
import { dispatchNow } from "../attempt";
import { enqueueEmail, type OutboxMessage } from "../enqueue";
import { dictionarySubject, forEachOutboxKind, type KindFacts, type KindScenario } from "./_kind-harness";

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

/** Kinds whose producer still mails through a `send*` (T8-T12 move them, one each, and delete their entry). */
const NOT_YET_MOVED: readonly OutboxKind[] = [
  "registration_confirmation",
  "payment_reminder",
  "registration_promoted",
  "refund_issued",
  "solo_signup_assigned",
];

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

afterAll(async () => {
  if (HAS_DB) {
    await sql`delete from email_outbox where ref_id like ${`${RUN}-%`}`;
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
    await sql`delete from email_outbox where ref_id like ${`${RUN}-%`}`;
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
    await expect(swept({ magic_link: twice })).rejects.toThrow(/magic_link[\s\S]*2 times|magic_link[\s\S]*exactly once/);
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
