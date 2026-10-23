// I1 (Task 4 review): a row may not outlive Resend's idempotency key.
//
// The worker re-sends an ambiguous row (a 2xx whose recording write failed, a lease that lapsed) under the SAME key and
// relies on Resend honouring that key for RESEND_IDEMPOTENCY_TTL_MS. A row is claimable until `expires_at`, so a row that
// can live longer than the key could be re-sent after the key died: two emails. `enqueueEmail` therefore refuses an
// `expiresAt` further out than the key life less a margin, BEFORE any statement (so the caller's transaction refuses as a
// whole, the way an unusable KEK does).
//
// No database: the only thing `enqueueEmail` asks of `db` is a tagged template and `.json`, so a recording stub proves both
// "accepted" (one statement) and "refused" (none) exactly, in both modes of the suite.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EXPIRY_MARGIN_MS,
  LEASE_MS,
  MAX_EXPIRY_MS,
  RESEND_IDEMPOTENCY_TTL_MS,
  STG_TICK_MS,
  type OutboxKind,
} from "../constants";
import { OutboxExpiryTooLongError, enqueueEmail, type OutboxMessage } from "../enqueue";
import { LOGIN_LINK_TTL_MS } from "@/lib/login-link";
import { CHECKIN_EXTEND_MAX, CHECKIN_EXTEND_STEP_MS } from "@/lib/checkin-extend";
import { CHECKIN_BATCH_SIZE, boardAnchor, windowFor } from "@/server/external-play/window";

const T0 = new Date("2026-10-23T12:00:00.000Z");

/** A `db` that records the statements it is handed. `enqueueEmail` uses it as a tagged template and as `db.json`. */
function stubDb() {
  const calls: unknown[][] = [];
  const db = Object.assign(
    async (...args: unknown[]) => {
      calls.push(args);
      return [];
    },
    { json: (v: unknown) => v },
  );
  return { db: db as never, calls };
}

function msg(over: Partial<OutboxMessage> = {}): OutboxMessage {
  return {
    kind: "magic_link",
    refType: "login",
    refId: "ref-1",
    orgId: null,
    to: "someone-private@x.test",
    subject: "Your sign-in link",
    html: "<a href='https://seazn.club/v?token=SECRET-TOKEN'>Sign in</a>",
    text: "Sign in: https://seazn.club/v?token=SECRET-TOKEN",
    transactional: true,
    expiresAt: new Date(T0.getTime() + 15 * 60_000),
    ...over,
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  vi.stubEnv("RESEND_API_KEY", "");
  vi.stubEnv("LICHESS_TOKEN_KEK", "");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("the bound is derived, not typed", () => {
  it("MAX_EXPIRY_MS is the key life less a margin of at least one lease, and the margin covers the slowest cadence too", () => {
    expect(MAX_EXPIRY_MS).toBe(RESEND_IDEMPOTENCY_TTL_MS - EXPIRY_MARGIN_MS);
    expect(EXPIRY_MARGIN_MS).toBeGreaterThanOrEqual(LEASE_MS);
    // A lease that lapses just before the last allowed moment is noticed by the slowest tick: that wait is inside the margin.
    expect(EXPIRY_MARGIN_MS).toBeGreaterThanOrEqual(LEASE_MS + STG_TICK_MS);
    expect(MAX_EXPIRY_MS).toBeGreaterThan(0);
    expect(MAX_EXPIRY_MS).toBeLessThan(RESEND_IDEMPOTENCY_TTL_MS);
  });
});

describe("enqueueEmail and the key life", () => {
  it("accepts an expiry exactly MAX_EXPIRY_MS out and refuses one millisecond more, before any statement", async () => {
    const ok = stubDb();
    const id = await enqueueEmail(ok.db, msg({ expiresAt: new Date(T0.getTime() + MAX_EXPIRY_MS) }));
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(ok.calls, "the boundary row is inserted").toHaveLength(1);

    const over = stubDb();
    const err = await enqueueEmail(over.db, msg({ expiresAt: new Date(T0.getTime() + MAX_EXPIRY_MS + 1) })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OutboxExpiryTooLongError);
    expect(over.calls, "a refusal issues no statement").toHaveLength(0);
  });

  it("the refusal names the kind, the ref type and the bound, and carries neither the address nor the body", async () => {
    const { db } = stubDb();
    const err = (await enqueueEmail(db, msg({ kind: "chess_invite", refType: "fixture_seat", expiresAt: new Date(T0.getTime() + RESEND_IDEMPOTENCY_TTL_MS) })).catch((e: unknown) => e)) as OutboxExpiryTooLongError;
    expect(err).toBeInstanceOf(OutboxExpiryTooLongError);
    expect(err.name).toBe("OutboxExpiryTooLongError");
    expect(err.code).toBe("EMAIL_OUTBOX_EXPIRY_TOO_LONG");
    expect(err.maxMs).toBe(MAX_EXPIRY_MS);
    expect(err.message).toContain("chess_invite");
    expect(err.message).toContain("fixture_seat");
    for (const secret of ["someone-private@x.test", "SECRET-TOKEN"]) expect(err.message, secret).not.toContain(secret);
  });

  it("a refusal is not sticky: the next, valid enqueue on the same handle goes through (sequence)", async () => {
    const { db, calls } = stubDb();
    await expect(enqueueEmail(db, msg({ expiresAt: new Date(T0.getTime() + MAX_EXPIRY_MS + 1) }))).rejects.toBeInstanceOf(OutboxExpiryTooLongError);
    await expect(enqueueEmail(db, msg())).resolves.toMatch(/^[0-9a-f-]{36}$/);
    expect(calls).toHaveLength(1);
  });

  it("an expiry in the past is accepted (the row simply ends expired, unsent), and an Invalid Date is refused by name", async () => {
    const past = stubDb();
    await expect(enqueueEmail(past.db, msg({ expiresAt: new Date(T0.getTime() - 60_000) }))).resolves.toBeTruthy();
    expect(past.calls).toHaveLength(1);

    const bad = stubDb();
    await expect(enqueueEmail(bad.db, msg({ expiresAt: new Date("not a date") }))).rejects.toBeInstanceOf(OutboxExpiryTooLongError);
    expect(bad.calls).toHaveLength(0);
  });

  it("the check runs on the real clock at call time: the same absolute expiry is refused later in the day and accepted earlier", async () => {
    const expiresAt = new Date(T0.getTime() + MAX_EXPIRY_MS);
    vi.setSystemTime(new Date(T0.getTime() - 1)); // one ms EARLIER: the same expiry is now 1 ms too far out
    await expect(enqueueEmail(stubDb().db, msg({ expiresAt }))).rejects.toBeInstanceOf(OutboxExpiryTooLongError);
    vi.setSystemTime(new Date(T0.getTime() + 1)); // one ms LATER: it is inside the bound
    await expect(enqueueEmail(stubDb().db, msg({ expiresAt }))).resolves.toBeTruthy();
  });
});

describe("the real expiries of the two kinds sit inside the bound", () => {
  it("sign-in link: the login link's own TTL is accepted, with room to spare", async () => {
    const { db, calls } = stubDb();
    const expiresAt = new Date(T0.getTime() + LOGIN_LINK_TTL_MS);
    await expect(enqueueEmail(db, msg({ kind: "magic_link", expiresAt }))).resolves.toBeTruthy();
    expect(calls).toHaveLength(1);
    expect(LOGIN_LINK_TTL_MS).toBeGreaterThan(0);
    expect(LOGIN_LINK_TTL_MS).toBeLessThan(MAX_EXPIRY_MS);
  });

  it("chess invite: a board's check-in deadline, with every extension used, is accepted for a round of a thousand boards, and the first refused batch is derived from the engine", async () => {
    const kind: OutboxKind = "chess_invite";
    const maxExtraMs = CHECKIN_EXTEND_MAX * CHECKIN_EXTEND_STEP_MS;
    // The deadline the row would carry for a board of `rank`, in a round pressed Open now, staggered, fully extended.
    const deadlineOf = (rank: number): Date => windowFor(boardAnchor(T0, rank, true, maxExtraMs)).deadline;

    let admitted = 0;
    let firstRefusedRank: number | null = null;
    for (let batch = 0; batch < 5_000; batch++) {
      const rank = batch * CHECKIN_BATCH_SIZE;
      const deadline = deadlineOf(rank);
      const { db, calls } = stubDb();
      const result = await enqueueEmail(db, msg({ kind, refType: "fixture_seat", expiresAt: deadline })).then(
        () => "accepted" as const,
        (e: unknown) => (e instanceof OutboxExpiryTooLongError ? ("refused" as const) : Promise.reject(e)),
      );
      // The engine's own deadline decides which side of the bound the board is on; the guard must agree with it.
      expect(result, `rank ${rank}`).toBe(deadline.getTime() - T0.getTime() <= MAX_EXPIRY_MS ? "accepted" : "refused");
      expect(calls.length, `rank ${rank} statements`).toBe(result === "accepted" ? 1 : 0);
      if (result === "refused") {
        firstRefusedRank = rank;
        break;
      }
      admitted++;
    }
    // Anti-vacuity: the sweep checked many batches, found the edge, and the edge is far past any real round.
    expect(admitted).toBeGreaterThan(0);
    expect(firstRefusedRank, "the sweep reached a refused batch").not.toBeNull();
    // Floor, not derived: no division in the product runs a single round of a thousand boards. A change to the batch gap
    // or size that drops the admitted round below it must be a decision, not a side effect.
    expect(firstRefusedRank!).toBeGreaterThanOrEqual(1_000);
  });
});
