// Task 7 - the chess round invite on the email outbox. The invite is no longer a send whose boolean decides the seat's stamp: it
// is a ROW per recipient, written in the open's own transaction beside the stamp, sent after commit, retried by the worker and
// followed by the provider's verdict. The seat stays stamped while any row for that stamp can still deliver, and is released when
// every row for it has ended badly. These tests drive that through the real producers and consumers: openRound and
// resendExternalPlayNotice write the rows, dispatchNow and runOutboxTick send them, the REAL Resend webhook route moves them, and
// the REAL chess hook (KIND_HOOKS.chess_invite) releases the seat. Only the network (the transport's `deliver`) and the
// invite's renderer are replaced, by the harness every migrated test shares (../../__tests__/_invite-mail.ts).
//
// Single-sport by construction: online play exists only for `boardgame` (supportsOnlinePlay), so there is no other sport to sweep.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { sql } from "@/lib/db";
import {
  CHECKIN_BATCH_GAP_MS,
  CHECKIN_BATCH_SIZE,
  DEADLINE_AFTER_MS,
  boardAnchor,
  windowFor,
} from "@/server/external-play/window";
import { boardOpenFor } from "@/server/external-play/round-open";
import {
  ENDED_BADLY_STATUSES,
  LIVE_STATUSES,
  DISPATCH_NOW_BUDGET_MS,
  MAX_ATTEMPTS,
  MIN_SEND_INTERVAL_MS,
  OUTBOX_STATUSES,
  RETRY_DELAYS_MS,
  RETRYABLE_STATUSES,
  type OutboxStatus,
} from "@/server/email-outbox/constants";
import { KIND_HOOKS, findUnappliedEndings, type EndedRow } from "@/server/email-outbox/hooks";
import { runOutboxTick } from "@/server/email-outbox/worker";
import type { DeliverMessage } from "@/server/email-outbox/transport";
import { POST as webhookPost } from "@/app/api/webhooks/resend/route";
import type { InviteMail, SentInvite } from "../../__tests__/_invite-mail";
import { stubOutboxEnv } from "../../__tests__/_invite-mail";

const mail = vi.hoisted(() => ({
  sent: [] as SentInvite[],
  fail: new Set<string>(),
  throws: new Set<string>(),
  retry: new Set<string>(),
  rateLimit: new Set<string>(),
  // Addresses whose invite fails to RENDER (inside the seat's savepoint, after an earlier recipient's row was written).
  renderThrows: new Set<string>(),
  // Addresses of ONE seat: the second of them to be rendered throws, after the first one's row was already written.
  renderThrowsOnSecond: new Set<string>(),
  renderedOfSet: 0,
  holdFirst: null as InviteMail["holdFirst"],
  // Runs inside the transport after the provider answered and before the answer reaches the attempt (the R11 race).
  afterDeliver: null as null | ((msg: DeliverMessage) => Promise<void>),
}));
vi.mock("@/lib/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email")>();
  const h = await import("../../__tests__/_invite-mail");
  return {
    ...actual,
    externalPlayInviteEmail: async (to: string, args: Parameters<typeof h.renderInviteForTest>[1], locale?: string) => {
      if (mail.renderThrows.has(to)) throw new Error("render exploded");
      if (mail.renderThrowsOnSecond.has(to)) {
        mail.renderedOfSet += 1;
        if (mail.renderedOfSet === 2) throw new Error("render exploded on the second recipient");
      }
      return h.renderInviteForTest(to, args, locale);
    },
  };
});
vi.mock("@/server/email-outbox/transport", async () => {
  const h = await import("../../__tests__/_invite-mail");
  return {
    deliver: async (msg: DeliverMessage) => {
      const result = await h.deliverForTest(mail, msg);
      if (mail.afterDeliver) await mail.afterDeliver(msg);
      return result;
    },
  };
});

// dispatchNow's pacing clock and sleep, handed through the REAL open and resend (the routes pass neither): a test that sets
// them runs the whole round on a fake clock, with no waiting.
const pacing = vi.hoisted(() => ({
  nowMs: null as null | (() => number),
  sleep: null as null | ((ms: number) => Promise<void>),
}));
vi.mock("@/server/email-outbox/attempt", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/email-outbox/attempt")>();
  return {
    ...actual,
    dispatchNow: (ids: readonly string[], opts: Parameters<typeof actual.dispatchNow>[1] = {}) =>
      actual.dispatchNow(ids, {
        ...opts,
        ...(pacing.nowMs ? { nowMs: pacing.nowMs } : {}),
        ...(pacing.sleep ? { sleep: pacing.sleep } : {}),
      }),
  };
});

// A seat the test makes neither claim nor hold a stamp (the resend's loud guard).
const race = vi.hoisted(() => ({ claimFalseFor: new Set<string>() }));
vi.mock("../seat-stamp", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../seat-stamp")>();
  return {
    ...actual,
    claimSeat: async (...args: Parameters<typeof actual.claimSeat>) =>
      race.claimFalseFor.has(`${args[1]}|${args[2]}`) ? false : actual.claimSeat(...args),
  };
});

import { openRound } from "../open-round";
import { latestStatuses, resendExternalPlayNotice, seatOutcome } from "../invite";
import { CHESS_SEAT_REF_TYPE, STAMP_COLUMN, chessSeatRef } from "../seat-stamp";
import {
  seedOnlineChessRound,
  seedOnlineChessRoundWithRankedBoard,
  type SeedOnlineChessRoundResult,
} from "../../__tests__/_external-play-seed";

const HAS_DB = !!process.env.DATABASE_URL;
const MIN = 60_000;
const ORIGIN = "https://seazn.test";
const RUN = `t7-${randomUUID().slice(0, 8)}`;
const OPENED = new Date("2026-10-01T12:00:30.000Z");

const WEBHOOK_KEY = randomBytes(24);
const WEBHOOK_SECRET = `whsec_${WEBHOOK_KEY.toString("base64")}`;
const suppressedEmails: string[] = [];

beforeEach(() => {
  mail.sent.length = 0;
  for (const set of [mail.fail, mail.throws, mail.retry, mail.rateLimit, mail.renderThrows, mail.renderThrowsOnSecond, race.claimFalseFor]) set.clear();
  mail.renderedOfSet = 0;
  mail.holdFirst = null;
  mail.afterDeliver = null;
  pacing.nowMs = null;
  pacing.sleep = null;
  stubOutboxEnv();
  vi.stubEnv("RESEND_WEBHOOK_SECRET", WEBHOOK_SECRET);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
afterAll(async () => {
  if (HAS_DB) {
    if (suppressedEmails.length > 0) await sql`delete from email_suppressions where email in ${sql(suppressedEmails)}`;
    await sql.end({ timeout: 2 }).catch(() => undefined);
  }
});

// ---------------------------------------------------------------------------
// Readers.

type OutboxRow = {
  id: string;
  kind: string;
  ref_type: string;
  ref_id: string;
  org_id: string | null;
  recipient: string;
  status: OutboxStatus;
  attempts: number;
  transactional: boolean;
  last_error: string | null;
  provider_id: string | null;
  has_body: boolean;
  meta: Record<string, string>;
  expires_at: Date;
  next_attempt_at: Date;
};
/** Every chess-invite row of a board, oldest first (the order they were written in). */
const rowsOf = (fixtureId: string) =>
  sql<OutboxRow[]>`
    select id, kind, ref_type, ref_id, org_id, recipient, status, attempts, transactional, last_error, provider_id,
           body_sealed is not null as has_body, meta, expires_at, next_attempt_at
      from email_outbox
     where kind = 'chess_invite' and ref_id like ${fixtureId + ":%"}
     order by created_at, ref_id, recipient, id`;
const rowsForSeat = async (fixtureId: string, colour: "white" | "black") =>
  (await rowsOf(fixtureId)).filter((r) => r.ref_id === chessSeatRef(fixtureId, colour));
const statusOf = async (id: string): Promise<OutboxStatus> =>
  (await sql<{ status: OutboxStatus }[]>`select status from email_outbox where id = ${id}`)[0]!.status;

type Bridge = {
  round_open_id: string | null;
  white_emailed_at: Date | null;
  black_emailed_at: Date | null;
  status: string;
  challenge_id: string | null;
};
const bridgeOf = async (fixtureId: string): Promise<Bridge> =>
  (
    await sql<Bridge[]>`
      select round_open_id, white_emailed_at, black_emailed_at, status, challenge_id
        from fixture_external_play where fixture_id = ${fixtureId}`
  )[0]!;
/** A chess board has a white seat and a black seat (the stamp columns are the declaration), whatever its entrants. */
const SEATS_PER_BOARD = Object.keys(STAMP_COLUMN).length;
const stampOf = (b: Bridge, colour: "white" | "black"): Date | null => (colour === "white" ? b.white_emailed_at : b.black_emailed_at);

const open = (r: SeedOnlineChessRoundResult, now?: Date) =>
  openRound({ stageId: r.stageId, roundNo: 1, actorUserId: r.ownerUserId }, now ? { now } : {});
const resend = (r: SeedOnlineChessRoundResult, fixtureId: string, now?: Date) =>
  resendExternalPlayNotice(r.owner, fixtureId, ORIGIN, now ? { now } : {});
const stageRows = (stageId: string) => sql<{ id: string }[]>`select id from stage_round_opens where stage_id = ${stageId}`;
const auditPayloads = async (competitionId: string) =>
  (
    await sql<{ type: string; payload: Record<string, unknown> }[]>`
      select type, payload from competition_events
       where competition_id = ${competitionId} and type like 'external_play.round_%' order by created_at, id`
  ).map((e) => ({ type: e.type, ...e.payload }));

/** The colour a recipient's seat is, read from the rows the open wrote (the pairing decides the colours, not the test). */
async function colourOf(fixtureId: string, email: string): Promise<"white" | "black"> {
  const row = (await rowsOf(fixtureId)).find((r) => r.recipient.toLowerCase() === email.toLowerCase());
  if (!row) throw new Error(`no outbox row for ${email} on ${fixtureId}`);
  return row.ref_id.endsWith(":white") ? "white" : "black";
}

// ---------------------------------------------------------------------------
// The Resend webhook, signed from the vendor's rule (not with the route's helper), and posted to the REAL route handler.

function signed(type: string, data: Record<string, unknown>) {
  const body = JSON.stringify({ type, created_at: new Date().toISOString(), data });
  const id = `msg_${randomUUID()}`;
  const ts = Math.floor(Date.now() / 1000);
  const sig = `v1,${createHmac("sha256", WEBHOOK_KEY).update(`${id}.${ts}.${body}`).digest("base64")}`;
  return { body, headers: { "svix-id": id, "svix-timestamp": String(ts), "svix-signature": sig } };
}
async function webhook(type: string, data: Record<string, unknown>): Promise<number> {
  const s = signed(type, data);
  const res = await webhookPost(new NextRequest("http://localhost/api/webhooks/resend", { method: "POST", headers: s.headers, body: s.body }));
  return res.status;
}
/** Deliver a provider event for an outbox row that has been sent (it carries the provider's message id). */
async function providerEvent(row: OutboxRow, type: string): Promise<void> {
  expect(row.provider_id, `premise: row ${row.id} was sent, so it carries the provider's id`).not.toBeNull();
  suppressedEmails.push(row.recipient);
  expect(await webhook(type, { email_id: row.provider_id, to: [row.recipient] })).toBe(200);
}
const freshRow = async (id: string): Promise<OutboxRow> => (await rowsByIds([id]))[0]!;
const rowsByIds = (ids: string[]) =>
  sql<OutboxRow[]>`
    select id, kind, ref_type, ref_id, org_id, recipient, status, attempts, transactional, last_error, provider_id,
           body_sealed is not null as has_body, meta, expires_at, next_attempt_at
      from email_outbox where id = any(${ids}::uuid[]) order by created_at, id`;

/** A second (and third) member of an entrant: their linked addresses become recipients of that seat. */
async function addMember(r: SeedOnlineChessRoundResult, entrantId: string, email: string): Promise<void> {
  const [u] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified, locale) values (${email}, 'Team mate', true, 'en') returning id`;
  const [p] = await sql<{ id: string }[]>`
    insert into persons (org_id, full_name, user_id) values (${r.orgId}, 'Team mate', ${u!.id}) returning id`;
  await sql`insert into entrant_members (entrant_id, person_id, org_id) values (${entrantId}, ${p!.id}, ${r.orgId})`;
}

/** Drive the retry worker over exactly these rows (the test seam), with no real waiting. */
const tick = (ids: string[]) => runOutboxTick({ onlyIds: ids, sleep: async () => undefined });
/** Make a queued row due now with only its LAST attempt left, so the tick's attempt is the one that ends it. */
const makeLastAttempt = (id: string) =>
  sql`update email_outbox set attempts = ${MAX_ATTEMPTS - 1}, next_attempt_at = now() - interval '1 second' where id = ${id}`;

/** The hook as it is registered, saved so a test can wrap it and put it back. */
const realChessHook = KIND_HOOKS.chess_invite;
afterEach(() => {
  KIND_HOOKS.chess_invite = realChessHook;
});

// ===========================================================================
// seatOutcome: what a seat reports, from the status of the rows that carry it.
// ===========================================================================

describe("seatOutcome - the seat's answer, read from row STATUS (R6, R11)", () => {
  // The expected class of each status comes from the status vocabularies the outbox declares, not from a table typed here:
  //  - a row that is still being tried (queued, sending) = the seat is retrying;
  //  - a row the provider took (live, but not retryable: sent, delayed, delivered) = invited, and so is a complaint (the mail
  //    ARRIVED, and the hook never releases the seat for it);
  //  - every other ended-badly status = failed (the seat is released).
  const expected = (s: OutboxStatus): "invited" | "retrying" | "failed" | "ignored" => {
    if (s === "replaced") return "ignored";
    if (RETRYABLE_STATUSES.includes(s)) return "retrying";
    if (LIVE_STATUSES.includes(s) || s === "complained") return "invited";
    expect(ENDED_BADLY_STATUSES, `${s} is a badly-ended status`).toContain(s);
    return "failed";
  };

  it("every status on its own: the class the vocabularies give it; a replaced row counts for nothing (no information = failed)", () => {
    let checked = 0;
    const seen = new Set<string>();
    for (const s of OUTBOX_STATUSES) {
      const want = expected(s);
      expect(seatOutcome([s]), `[${s}]`).toBe(want === "ignored" ? "failed" : want);
      seen.add(want);
      checked += 1;
    }
    expect(checked, "anti-vacuity: every status of the vocabulary").toBe(OUTBOX_STATUSES.length);
    expect([...seen].sort(), "all four classes were exercised").toEqual(["failed", "ignored", "invited", "retrying"]);
  });

  it("a person with no row at all is a failed seat; an invited person outranks a retrying one, which outranks a failed one, in any order", () => {
    expect(seatOutcome([])).toBe("failed");
    const orders: OutboxStatus[][] = [
      ["dead", "queued", "delivered"],
      ["delivered", "queued", "dead"],
      ["queued", "delivered", "dead"],
      ["dead", "delivered", "queued"],
    ];
    for (const o of orders) expect(seatOutcome(o), o.join()).toBe("invited");
    for (const o of [["dead", "queued"], ["queued", "dead"], ["bounced", "sending", "expired"]] as OutboxStatus[][]) {
      expect(seatOutcome(o), o.join()).toBe("retrying");
    }
    for (const o of [["dead", "bounced"], ["failed", "suppressed", "expired"]] as OutboxStatus[][]) {
      expect(seatOutcome(o), o.join()).toBe("failed");
    }
  });

  it("a replaced twin is ignored: [replaced, sent] is invited and [replaced, dead] is failed - never retrying (R6)", () => {
    expect(seatOutcome(["replaced", "sent"])).toBe("invited");
    expect(seatOutcome(["replaced", "dead"])).toBe("failed");
    expect(seatOutcome(["replaced", "queued"])).toBe("retrying"); // the live twin is the row that counts
    expect(seatOutcome(["replaced", "replaced"])).toBe("failed");
  });
});

// ===========================================================================
// openRound writes the rows.
// ===========================================================================

describe.skipIf(!HAS_DB)("openRound writes the invite rows beside the stamps", () => {
  it("one chess_invite row per recipient per claimed seat: ref fixture_seat/<id>:<colour>, the board's own deadline, the stamp in meta", async () => {
    const r = await seedOnlineChessRoundWithRankedBoard({ roundNo: 1, cameraPolicy: "required" }, 2 * CHECKIN_BATCH_SIZE);
    expect(await open(r, OPENED)).toEqual({ opened: true, invited: 4, retrying: 0, skipped: [] });

    let checked = 0;
    for (const [b, rank] of [[r.boards[0]!, 0], [r.ranked, 2 * CHECKIN_BATCH_SIZE]] as const) {
      const rows = await rowsOf(b.fixtureId);
      expect(rows.map((x) => x.ref_id).sort(), "one row per seat").toEqual(
        [chessSeatRef(b.fixtureId, "black"), chessSeatRef(b.fixtureId, "white")].sort(),
      );
      expect(rows.map((x) => x.recipient).sort(), "to the board's two players").toEqual([b.home.email, b.away.email].sort());
      const stamp = (await bridgeOf(b.fixtureId))!;
      for (const row of rows) {
        const colour = row.ref_id.endsWith(":white") ? "white" : "black";
        expect(row.kind).toBe("chess_invite");
        expect(row.ref_type).toBe("fixture_seat"); // the contract the arbiter's status read (phase 2) keys on
        expect(row.ref_type).toBe(CHESS_SEAT_REF_TYPE);
        expect(row.org_id).toBe(r.orgId);
        expect(row.transactional, "an invite starts a clock against the player: the suppression list must not swallow it").toBe(true);
        expect(row.meta).toEqual({ fixtureId: b.fixtureId, colour, stampedAt: OPENED.toISOString() });
        expect(stampOf(stamp, colour)!.getTime(), "the row's stamp IS the seat's stamp").toBe(OPENED.getTime());
        // The board's OWN deadline, written from the window rules (window.ts), not from the code under test.
        expect(row.expires_at.getTime(), `rank ${rank}`).toBe(windowFor(boardAnchor(OPENED, rank, true)).deadline.getTime());
        expect(row.status).toBe("sent");
        expect(row.has_body, "a finished row keeps no credential").toBe(false);
        checked += 1;
      }
    }
    expect(checked, "anti-vacuity: four rows read").toBe(4);
    const a = (await rowsOf(r.boards[0]!.fixtureId))[0]!.expires_at.getTime();
    const z = (await rowsOf(r.ranked.fixtureId))[0]!.expires_at.getTime();
    expect(z - a, "premise: the two boards' deadlines differ by their batch gap").toBe(2 * CHECKIN_BATCH_GAP_MS);
  });

  it("the row's expiry is the window the open itself stored: opened + the check-in window", async () => {
    const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 1 });
    const now = new Date(Date.now() - 5 * MIN);
    await open(r, now);
    const b = r.boards[0]!;
    const stored = (await boardOpenFor(sql, b.fixtureId))!;
    for (const row of await rowsOf(b.fixtureId)) {
      expect(row.expires_at.getTime()).toBe(windowFor(stored.anchor).deadline.getTime());
      expect(row.expires_at.getTime() - now.getTime(), "opened + the check-in window").toBe(DEADLINE_AFTER_MS);
    }
  });

  it("a team seat: one row per member address, and the status is per person", async () => {
    const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 1 });
    const b = r.boards[0]!;
    const mate = `${RUN}-mate-${randomUUID().slice(0, 6)}@t.local`;
    await addMember(r, b.home.entrantId, mate);
    mail.fail.add(mate); // the second member's address is refused for good

    expect(await open(r, OPENED)).toEqual({ opened: true, invited: 2, retrying: 0, skipped: [] });
    const homeColour = await colourOf(b.fixtureId, b.home.email);
    const seat = await rowsForSeat(b.fixtureId, homeColour);
    expect(seat.map((x) => x.recipient).sort(), "both members of the seat have a row").toEqual([b.home.email, mate].sort());
    expect(seat.find((x) => x.recipient === b.home.email)!.status).toBe("sent");
    const refused = seat.find((x) => x.recipient === mate)!;
    expect(refused.status, "the refused member's own row ended").toBe("dead");
    expect(refused.last_error).toMatch(/^http 422 /);
    expect(mail.sent.map((m) => m.to).sort(), "the other member and the opponent were mailed").toEqual([b.home.email, b.away.email].sort());
    // One member's mail went out, so the seat is still invited and stamped: a dead row beside a live one releases nothing.
    expect(stampOf(await bridgeOf(b.fixtureId), homeColour), "a live sibling keeps the stamp").not.toBeNull();
  });

  it("two members sharing one address (or differing only in case) get ONE email, and the seat is invited (Review Focus 5)", async () => {
    const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 1 });
    const b = r.boards[0]!;
    const shouted = b.home.email.toUpperCase();
    expect(shouted, "premise: a different string for the same mailbox").not.toBe(b.home.email);
    await addMember(r, b.home.entrantId, shouted);

    expect(await open(r, OPENED)).toEqual({ opened: true, invited: 2, retrying: 0, skipped: [] });
    const homeColour = await colourOf(b.fixtureId, b.home.email);
    const seat = await rowsForSeat(b.fixtureId, homeColour);
    expect(seat, "one row for the mailbox, not two").toHaveLength(1);
    expect(mail.sent.filter((m) => m.to.toLowerCase() === b.home.email.toLowerCase()), "one email delivered to it").toHaveLength(1);
    expect((await rowsOf(b.fixtureId)).filter((x) => x.status === "replaced"), "and no row was written only to be replaced").toHaveLength(0);
  });

  it("two members who are the SAME user (an identical address twice) also get ONE email", async () => {
    const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 1 });
    const b = r.boards[0]!;
    // The same login as a second person of the entrant (another lane: one player person per user and org): the same string twice.
    const [u] = await sql<{ id: string }[]>`select id from users where email = ${b.home.email}`;
    const [p] = await sql<{ id: string }[]>`
      insert into persons (org_id, full_name, user_id, lane) values (${r.orgId}, 'Same login', ${u!.id}, 'official') returning id`;
    await sql`insert into entrant_members (entrant_id, person_id, org_id) values (${b.home.entrantId}, ${p!.id}, ${r.orgId})`;

    expect(await open(r, OPENED)).toEqual({ opened: true, invited: 2, retrying: 0, skipped: [] });
    const homeColour = await colourOf(b.fixtureId, b.home.email);
    expect(await rowsForSeat(b.fixtureId, homeColour), "one row for the address, not two").toHaveLength(1);
    expect(mail.sent.filter((m) => m.to === b.home.email), "one email delivered to it").toHaveLength(1);
  });

  it("a seat with no address at all: no row, reported send_failed, and the seat is released at once", async () => {
    const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 1 });
    const b = r.boards[0]!;
    await sql`update persons set user_id = null where id = ${b.home.personId}`; // nobody to mail for the home seat
    expect(await open(r, OPENED)).toEqual({
      opened: true,
      invited: 1,
      retrying: 0,
      skipped: [{ fixtureId: b.fixtureId, reason: "send_failed" }],
    });
    const rows = await rowsOf(b.fixtureId);
    expect(rows.map((x) => x.recipient), "the away seat only").toEqual([b.away.email]);
    const awayColour = await colourOf(b.fixtureId, b.away.email);
    const homeColour = awayColour === "white" ? "black" : "white";
    const bridge = await bridgeOf(b.fixtureId);
    expect(stampOf(bridge, homeColour), "the seat nobody could be mailed is not stamped").toBeNull();
    expect(stampOf(bridge, awayColour)).not.toBeNull();
  });

  it("opens that mail nobody at all (no Resend key: dev, CI, e2e): every row dead 'no_api_key' with no body, invited 0, every seat released", async () => {
    const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 2 });
    for (const keyless of ["with the outbox key", "without it"]) {
      vi.stubEnv("RESEND_API_KEY", undefined);
      if (keyless === "without it") vi.stubEnv("EMAIL_OUTBOX_KEK", undefined);
      const t0 = new Date(Date.now() - 30 * MIN);
      const res = await open(r, t0);
      const byId = (a: { fixtureId: string }, z: { fixtureId: string }) => (a.fixtureId < z.fixtureId ? -1 : 1);
      expect(res.opened && { ...res, skipped: [...res.skipped].sort(byId) }, keyless).toEqual({
        opened: true,
        invited: 0,
        retrying: 0,
        skipped: r.boards.map((b) => ({ fixtureId: b.fixtureId, reason: "send_failed" })).sort(byId),
      });
      let checked = 0;
      for (const b of r.boards) {
        const rows = (await rowsOf(b.fixtureId)).filter((x) => x.expires_at.getTime() === windowFor(boardAnchor(t0, 0, false)).deadline.getTime());
        expect(rows.length, `${keyless}: both seats of a board have a row`).toBeGreaterThanOrEqual(2);
        for (const row of rows) {
          expect(row.status).toBe("dead");
          expect(row.last_error).toBe("no_api_key");
          expect(row.has_body).toBe(false);
          checked += 1;
        }
        const bridge = await bridgeOf(b.fixtureId);
        expect([bridge.white_emailed_at, bridge.black_emailed_at], `${keyless}: both seats released`).toEqual([null, null]);
        expect(bridge.round_open_id, `${keyless}: nobody was reached, so the board is unbound again`).toBeNull();
      }
      expect(checked, "anti-vacuity").toBeGreaterThanOrEqual(4);
      expect(mail.sent).toHaveLength(0);
    }
  });
});

// ===========================================================================
// The first attempt decides invited / retrying / failed.
// ===========================================================================

describe.skipIf(!HAS_DB)("the first attempt: accepted, retried later, or refused for good", () => {
  it("2xx = invited; 503 = retrying with the stamp KEPT and a retry dated by the schedule; 422 = send_failed with the stamp released", async () => {
    const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 3 });
    const [ok, later, refused] = r.boards as [(typeof r.boards)[0], (typeof r.boards)[0], (typeof r.boards)[0]];
    mail.retry.add(later.home.email);
    mail.fail.add(refused.home.email);
    const before = Date.now();
    const res = await open(r, new Date(Date.now() - 5 * MIN));
    const after = Date.now();
    const seats = r.boards.length * SEATS_PER_BOARD;
    expect(res, "every seat but the one retrying and the one refused was taken").toEqual({
      opened: true,
      invited: seats - 1 - 1,
      retrying: 1,
      skipped: [{ fixtureId: refused.fixtureId, reason: "send_failed" }],
    });

    // the untouched board is the positive control: one sent row per seat, both seats stamped.
    expect((await rowsOf(ok.fixtureId)).map((x) => x.status)).toEqual(Array.from({ length: SEATS_PER_BOARD }, () => "sent"));
    const okBridge = await bridgeOf(ok.fixtureId);
    expect([okBridge.white_emailed_at, okBridge.black_emailed_at].every((x) => x !== null)).toBe(true);

    // retrying: queued again, the first attempt spent, due after the schedule's first delay; the seat is still stamped.
    const laterColour = await colourOf(later.fixtureId, later.home.email);
    const [queued] = (await rowsForSeat(later.fixtureId, laterColour));
    expect(queued!.status).toBe("queued");
    expect(queued!.attempts).toBe(1);
    expect(queued!.next_attempt_at.getTime()).toBeGreaterThanOrEqual(before + RETRY_DELAYS_MS[0]!);
    expect(queued!.next_attempt_at.getTime()).toBeLessThanOrEqual(after + RETRY_DELAYS_MS[0]!);
    expect(queued!.has_body, "a row that can still be retried keeps its (sealed) body").toBe(true);
    expect(stampOf(await bridgeOf(later.fixtureId), laterColour), "a retrying seat stays stamped").not.toBeNull();

    // failed: dead on the first attempt, the seat's stamp released so the board reads "still to invite".
    const refusedColour = await colourOf(refused.fixtureId, refused.home.email);
    const [dead] = await rowsForSeat(refused.fixtureId, refusedColour);
    expect(dead!.status).toBe("dead");
    expect(dead!.has_body).toBe(false);
    const refusedBridge = await bridgeOf(refused.fixtureId);
    expect(stampOf(refusedBridge, refusedColour), "the refused seat is released").toBeNull();
    const otherColour = refusedColour === "white" ? "black" : "white";
    expect(stampOf(refusedBridge, otherColour), "the other seat of that board is untouched").not.toBeNull();
    expect(refusedBridge.round_open_id, "a seat still reached keeps the board bound").not.toBeNull();
  });

  it("a provider that throws out of the transport is a RETRY, not a failure: the seat stays stamped (it was send_failed before the outbox)", async () => {
    const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 1 });
    const b = r.boards[0]!;
    mail.throws.add(b.away.email);
    expect(await open(r, OPENED)).toEqual({ opened: true, invited: 1, retrying: 1, skipped: [] });
    const colour = await colourOf(b.fixtureId, b.away.email);
    expect((await rowsForSeat(b.fixtureId, colour))[0]!.status).toBe("queued");
    expect(stampOf(await bridgeOf(b.fixtureId), colour)).not.toBeNull();
  });

  it("a 429 stops the dispatch: the seats after it are never tried, stay queued, and are retrying - not failed", async () => {
    const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 2 });
    const all = r.boards.flatMap((b) => [b.home.email, b.away.email]);
    for (const e of all) mail.rateLimit.add(e); // the provider slows down at the very first request
    const res = await open(r, OPENED);
    expect(res, "four seats, none sent, none lost").toEqual({ opened: true, invited: 0, retrying: 4, skipped: [] });
    const rows = (await Promise.all(r.boards.map((b) => rowsOf(b.fixtureId)))).flat();
    expect(rows).toHaveLength(4);
    expect(rows.every((x) => x.status === "queued")).toBe(true);
    expect(rows.filter((x) => x.attempts === 1), "only the first request was made").toHaveLength(1);
    expect(rows.filter((x) => x.attempts === 0), "the rest were never claimed").toHaveLength(3);
    for (const b of r.boards) {
      const bridge = await bridgeOf(b.fixtureId);
      expect([bridge.white_emailed_at, bridge.black_emailed_at].every((s) => s !== null), "every seat stays stamped").toBe(true);
    }
  });

  it("a round larger than the dispatch budget: the seats the dispatch never reached read retrying, stay stamped and queued, and the worker sends them", async () => {
    const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 4 });
    const seats = r.boards.length * SEATS_PER_BOARD;
    // The test config runs unpaced; this test switches the pacing on and runs it on a fake clock (no real waiting).
    vi.stubEnv("EMAIL_OUTBOX_DISPATCH_UNPACED", "");
    let t = 0;
    const sleeps: number[] = [];
    pacing.nowMs = () => t;
    pacing.sleep = async (ms) => {
      sleeps.push(ms);
      t += ms;
    };
    // The provider is slow on its THIRD answer: that one request takes the whole budget.
    const SLOW_SEND = 3;
    let sends = 0;
    mail.afterDeliver = async () => {
      sends += 1;
      if (sends === SLOW_SEND) t += DISPATCH_NOW_BUDGET_MS;
    };
    // The real clock: the worker below judges expiry on the database's time, so the window must still be running.
    const res = await open(r);
    expect(res, "the seats reached are invited, the rest are retrying - and none is called failed").toEqual({
      opened: true,
      invited: SLOW_SEND,
      retrying: seats - SLOW_SEND,
      skipped: [],
    });
    expect(sleeps, "one interval before each attempt but the first, and none after the budget was spent").toEqual(
      Array.from({ length: SLOW_SEND - 1 }, () => MIN_SEND_INTERVAL_MS),
    );
    const rows = (await Promise.all(r.boards.map((b) => rowsOf(b.fixtureId)))).flat();
    expect(rows).toHaveLength(seats);
    const unreached = rows.filter((x) => x.status === "queued");
    expect(rows.filter((x) => x.status === "sent")).toHaveLength(SLOW_SEND);
    expect(unreached, "anti-vacuity: some rows were beyond the budget").toHaveLength(seats - SLOW_SEND);
    expect(unreached.every((x) => x.attempts === 0), "never claimed: attempts untouched").toBe(true);
    for (const b of r.boards) {
      const bridge = await bridgeOf(b.fixtureId);
      expect([bridge.white_emailed_at, bridge.black_emailed_at].every((x) => x !== null), "every seat stays stamped").toBe(true);
    }
    // They are due now (a first attempt is immediate), so the worker sends them; a re-open has nobody left to invite.
    mail.afterDeliver = null;
    expect(await tick(unreached.map((x) => x.id))).toMatchObject({ sent: unreached.length });
    expect((await Promise.all(r.boards.map((b) => rowsOf(b.fixtureId)))).flat().every((x) => x.status === "sent")).toBe(true);
    expect(await open(r)).toEqual({ opened: false, reason: "already_open", skipped: [] });
  });

  it("the same budget bounds a resend: the seat it never reached reads retrying, not failed", async () => {
    const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 1 });
    const b = r.boards[0]!;
    await open(r);
    vi.stubEnv("EMAIL_OUTBOX_DISPATCH_UNPACED", "");
    let t = 0;
    pacing.nowMs = () => t;
    pacing.sleep = async (ms) => {
      t += ms;
    };
    let sends = 0;
    mail.afterDeliver = async () => {
      sends += 1;
      if (sends === 1) t += DISPATCH_NOW_BUDGET_MS; // the first send spends the budget: the second seat is never claimed
    };
    expect(await resend(r, b.fixtureId)).toEqual({ emailed: 1, retrying: SEATS_PER_BOARD - 1 });
  });

  it("R11: a webhook that marks the row delivered BEFORE the dispatch returns still counts the seat as invited, not retrying", async () => {
    const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 1 });
    mail.afterDeliver = async (msg) => {
      const id = msg.tags.outbox!;
      // Resend's `delivered` event for a message whose send response has not reached us yet: found by the outbox tag.
      expect(await webhook("email.delivered", { email_id: `re_${RUN}_${id}`, to: [msg.to], tags: { outbox: id } })).toBe(200);
    };
    const res = await open(r, OPENED);
    mail.afterDeliver = null;
    const rows = await rowsOf(r.boards[0]!.fixtureId);
    expect(rows.map((x) => x.status), "premise: the webhook won the race, so the attempt could not record 'sent'").toEqual(["delivered", "delivered"]);
    expect(res).toEqual({ opened: true, invited: 2, retrying: 0, skipped: [] });
  });

  it("a second open after a retrying seat re-mails nobody (its stamp stands); after the hook released a dead seat, the next open invites it afresh", async () => {
    const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 1 });
    const b = r.boards[0]!;
    mail.retry.add(b.home.email);
    mail.fail.add(b.away.email);
    expect(await open(r, OPENED)).toEqual({
      opened: true,
      invited: 0,
      retrying: 1,
      skipped: [{ fixtureId: b.fixtureId, reason: "send_failed" }],
    });
    const rowsBefore = (await rowsOf(b.fixtureId)).length;
    mail.fail.clear();
    mail.retry.clear();
    mail.sent.length = 0;
    // Only the dead seat is owed: the retrying one is still stamped, and its queued row is the worker's.
    expect(await open(r, OPENED)).toEqual({ opened: true, invited: 1, retrying: 0, skipped: [] });
    expect(mail.sent.map((m) => m.to), "exactly one email, to the released seat").toEqual([b.away.email]);
    expect((await rowsOf(b.fixtureId)).length, "one new row, for the released seat only").toBe(rowsBefore + 1);
    expect(await open(r, OPENED)).toEqual({ opened: false, reason: "already_open", skipped: [] });
  });
});

// ===========================================================================
// One seat's trouble stays that seat's.
// ===========================================================================

describe.skipIf(!HAS_DB)("rollback: nothing is queued that the open did not commit", () => {
  it("an open that fails at COMMIT leaves no outbox rows, no stamp, no round stamp - and mails nobody", async () => {
    const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 1 });
    const b = r.boards[0]!;
    // A constraint trigger that fails at COMMIT, after the open wrote its stamps and rows (the Task 6 pattern). It is keyed to THIS
    // board's stamp update on the bridge row, so it is inert for every parallel test file. It makes "rows written on the open's own
    // transaction" observable: rows written on the pool would already be committed and would survive the failed open.
    const fn = `t7_commit_fails_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
    await sql.unsafe(`create function ${fn}() returns trigger language plpgsql as $$ begin raise exception 'staged: the open fails at commit'; end $$`);
    await sql.unsafe(
      `create constraint trigger ${fn} after update on fixture_external_play deferrable initially deferred for each row
         when (new.fixture_id = '${b.fixtureId}' and new.white_emailed_at is not null) execute function ${fn}()`,
    );
    try {
      await expect(open(r, OPENED)).rejects.toThrow(/staged: the open fails at commit/);
    } finally {
      await sql.unsafe(`drop trigger if exists ${fn} on fixture_external_play`);
      await sql.unsafe(`drop function if exists ${fn}()`);
    }
    expect(await rowsOf(b.fixtureId), "no outbox row survived the rolled-back open").toHaveLength(0);
    const bridge = (await bridgeOf(b.fixtureId)) as Bridge | undefined; // the row is minted inside the open, so it may not exist at all
    expect(bridge === undefined || (bridge.white_emailed_at === null && bridge.black_emailed_at === null), "no stamp").toBe(true);
    expect(await stageRows(r.stageId), "the round was not stamped as opened").toHaveLength(0);
    expect(mail.sent, "and dispatch never ran").toHaveLength(0);
    // Positive pair: with the trigger gone the same open succeeds and queues the rows.
    expect(await open(r, OPENED)).toEqual({ opened: true, invited: SEATS_PER_BOARD, retrying: 0, skipped: [] });
    expect(await rowsOf(b.fixtureId)).toHaveLength(SEATS_PER_BOARD);
  });

  it("a throw inside one seat's savepoint rolls back that seat's stamp AND the rows it had already written; the other seat is unaffected", async () => {
    const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 1 });
    const b = r.boards[0]!;
    const mate = `${RUN}-mate-${randomUUID().slice(0, 6)}@t.local`;
    await addMember(r, b.home.entrantId, mate);
    // The home seat has two recipients, in an order the pairing's person ids decide: the SECOND one rendered throws, so one row has
    // been written when the seat's savepoint fails.
    mail.renderThrowsOnSecond.add(b.home.email).add(mate);
    const res = await open(r, OPENED);
    expect(res).toEqual({ opened: true, invited: 1, retrying: 0, skipped: [{ fixtureId: b.fixtureId, reason: "send_failed" }] });
    const rows = await rowsOf(b.fixtureId);
    expect(rows.map((x) => x.recipient), "no row of the failed seat survived, not even the one written before the throw").toEqual([b.away.email]);
    expect(mail.renderedOfSet, "premise: both recipients of the seat were reached, so one row was written before the throw").toBe(2);
    const awayColour = await colourOf(b.fixtureId, b.away.email);
    const homeColour = awayColour === "white" ? "black" : "white";
    const bridge = await bridgeOf(b.fixtureId);
    expect(stampOf(bridge, homeColour), "the failed seat's stamp rolled back with it").toBeNull();
    expect(stampOf(bridge, awayColour), "the other seat committed").not.toBeNull();
    // The failure is that seat's alone: the next open invites exactly it.
    mail.renderThrowsOnSecond.clear();
    mail.sent.length = 0;
    expect(await open(r, OPENED)).toEqual({ opened: true, invited: 1, retrying: 0, skipped: [] });
    expect(mail.sent.map((m) => m.to).sort()).toEqual([b.home.email, mate].sort());
  });

  it("when EVERY seat of a round fails to queue, the round holds no invited seat, so the re-open starts a fresh window (the binding is undone too)", async () => {
    const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 1 });
    const b = r.boards[0]!;
    mail.renderThrows.add(b.home.email).add(b.away.email);
    const t0 = new Date(Date.now() - 30 * MIN);
    expect(await open(r, t0)).toEqual({
      opened: true,
      invited: 0,
      retrying: 0,
      skipped: [{ fixtureId: b.fixtureId, reason: "send_failed" }],
    });
    expect((await bridgeOf(b.fixtureId)).round_open_id, "nobody was reached: the board is unbound").toBeNull();
    expect(await rowsOf(b.fixtureId)).toHaveLength(0);
    mail.renderThrows.clear();
    const t1 = new Date();
    expect(await open(r, t1)).toEqual({ opened: true, invited: 2, retrying: 0, skipped: [] });
    const [stamp] = await sql<{ opened_at: Date }[]>`select opened_at from stage_round_opens where stage_id = ${r.stageId}`;
    expect(stamp!.opened_at.getTime(), "a fresh window, not the failed open's").toBe(t1.getTime());
  });
});

// ===========================================================================
// The hook: a seat is released only when every row for its stamp ended badly.
// ===========================================================================

describe.skipIf(!HAS_DB)("the chess hook releases a seat only when every row for its stamp ended badly", () => {
  it("a retrying seat whose rows later die is released by the worker's hook; one live row keeps it stamped", async () => {
    const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 1 });
    const b = r.boards[0]!;
    const mate = `${RUN}-mate-${randomUUID().slice(0, 6)}@t.local`;
    await addMember(r, b.home.entrantId, mate);
    mail.retry.add(b.home.email).add(mate);
    // The real clock: the worker judges a row's expiry on the database's own time, so the open's window must still be running.
    expect(await open(r)).toEqual({ opened: true, invited: 1, retrying: 1, skipped: [] });
    const colour = await colourOf(b.fixtureId, b.home.email);
    const [first, second] = await rowsForSeat(b.fixtureId, colour);
    expect([first!.status, second!.status]).toEqual(["queued", "queued"]);

    // First row spends its last attempt and dies; the second is not due, so it can still deliver: the seat stays stamped.
    await makeLastAttempt(first!.id);
    expect(await tick([first!.id, second!.id])).toMatchObject({ dead: 1 });
    expect(await statusOf(first!.id)).toBe("dead");
    expect(await statusOf(second!.id)).toBe("queued");
    expect(stampOf(await bridgeOf(b.fixtureId), colour), "one live row keeps the seat stamped").not.toBeNull();

    // The second row dies too: now every row for the stamp has ended badly, and the hook releases the seat.
    await makeLastAttempt(second!.id);
    expect(await tick([first!.id, second!.id])).toMatchObject({ dead: 1 });
    expect(stampOf(await bridgeOf(b.fixtureId), colour), "every row ended badly: released").toBeNull();
    // The other seat was never involved.
    const otherColour = colour === "white" ? "black" : "white";
    expect(stampOf(await bridgeOf(b.fixtureId), otherColour)).not.toBeNull();
  });

  it("a retrying seat whose rows EXPIRE (the check-in deadline passed) is released too", async () => {
    const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 1 });
    const b = r.boards[0]!;
    mail.retry.add(b.home.email);
    await open(r, OPENED);
    const colour = await colourOf(b.fixtureId, b.home.email);
    const [row] = await rowsForSeat(b.fixtureId, colour);
    await sql`update email_outbox set expires_at = now() - interval '1 second' where id = ${row!.id}`;
    expect(await tick([row!.id])).toMatchObject({ expired: 1 });
    expect(await statusOf(row!.id)).toBe("expired");
    expect(stampOf(await bridgeOf(b.fixtureId), colour), "an invite that can no longer be sent does not leave the seat 'invited'").toBeNull();
  });

  // R12, each status through the REAL webhook route and the REAL hook. `bounced` releases even after `delivered` (a late bounce
  // means the inbox refused the mail); `complained` NEVER releases (the mail arrived and the player marked it spam); `failed` and
  // `suppressed` release. The expectation per event is the rulebook's (R12), not read from the hook.
  const R12: { event: string; becomes: OutboxStatus; releases: boolean; afterDelivered: boolean }[] = [
    { event: "email.bounced", becomes: "bounced", releases: true, afterDelivered: false },
    { event: "email.bounced", becomes: "bounced", releases: true, afterDelivered: true },
    { event: "email.failed", becomes: "failed", releases: true, afterDelivered: false },
    { event: "email.suppressed", becomes: "suppressed", releases: true, afterDelivered: false },
    { event: "email.complained", becomes: "complained", releases: false, afterDelivered: false },
    { event: "email.complained", becomes: "complained", releases: false, afterDelivered: true },
  ];
  it.each(R12)(
    "the webhook's $event ($becomes, after delivered: $afterDelivered) %#: the last live row's seat is released = $releases",
    async ({ event, becomes, releases, afterDelivered }) => {
      const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 1 });
      const b = r.boards[0]!;
      await open(r, OPENED);
      const colour = await colourOf(b.fixtureId, b.home.email);
      const otherColour = colour === "white" ? "black" : "white";
      const [row] = await rowsForSeat(b.fixtureId, colour);
      expect(row!.status, "premise: the mail went out").toBe("sent");
      if (afterDelivered) {
        await providerEvent(row!, "email.delivered");
        expect(await statusOf(row!.id)).toBe("delivered");
        expect(stampOf(await bridgeOf(b.fixtureId), colour), "delivered releases nothing").not.toBeNull();
      }
      await providerEvent(row!, event);
      expect(await statusOf(row!.id)).toBe(becomes);
      const bridge = await bridgeOf(b.fixtureId);
      if (releases) expect(stampOf(bridge, colour), `${becomes} releases the seat`).toBeNull();
      else expect(stampOf(bridge, colour), `${becomes} NEVER releases the seat`).not.toBeNull();
      expect(stampOf(bridge, otherColour), "the other seat of the board is untouched").not.toBeNull();
    },
  );

  it("R12: the sweep covered every event the webhook maps to a badly-ended status (anti-vacuity)", () => {
    const covered = new Set(R12.map((c) => c.becomes));
    for (const s of ENDED_BADLY_STATUSES.filter((x) => !["dead", "expired"].includes(x))) {
      expect(covered.has(s), `${s} is driven through the webhook above`).toBe(true);
    }
    expect(R12.length).toBeGreaterThanOrEqual(6);
  });

  it("a team seat: a bounce on the first row keeps the seat (a sibling is live); a bounce on the last releases it; a complaint on either never does", async () => {
    const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 2 });
    const [t1, t2] = r.boards as [(typeof r.boards)[0], (typeof r.boards)[0]];
    const mate1 = `${RUN}-mate-${randomUUID().slice(0, 6)}@t.local`;
    const mate2 = `${RUN}-mate-${randomUUID().slice(0, 6)}@t.local`;
    await addMember(r, t1.home.entrantId, mate1);
    await addMember(r, t2.home.entrantId, mate2);
    await open(r, OPENED);

    const c1 = await colourOf(t1.fixtureId, t1.home.email);
    const [a1, a2] = await rowsForSeat(t1.fixtureId, c1);
    await providerEvent(a1!, "email.bounced");
    expect(stampOf(await bridgeOf(t1.fixtureId), c1), "one row bounced, the other can still deliver").not.toBeNull();
    await providerEvent(a2!, "email.bounced");
    expect(stampOf(await bridgeOf(t1.fixtureId), c1), "every row for the stamp ended badly").toBeNull();

    const c2 = await colourOf(t2.fixtureId, t2.home.email);
    const [b1, b2] = await rowsForSeat(t2.fixtureId, c2);
    await providerEvent(b1!, "email.complained");
    await providerEvent(b2!, "email.bounced");
    expect(stampOf(await bridgeOf(t2.fixtureId), c2), "a complaint on one row holds the seat although the other bounced").not.toBeNull();
  });

  it("on a board with a game on file, a bounce releases nothing (Review Focus 3); the same bounce on a board without one does", async () => {
    const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 2 });
    const [withGame, without] = r.boards as [(typeof r.boards)[0], (typeof r.boards)[0]];
    await open(r, OPENED);
    await sql`update fixture_external_play set challenge_id = ${`gm-${randomUUID().slice(0, 12)}`} where fixture_id = ${withGame.fixtureId}`;
    const gameBefore = await bridgeOf(withGame.fixtureId);

    const [gameRow] = await rowsForSeat(withGame.fixtureId, await colourOf(withGame.fixtureId, withGame.home.email));
    await providerEvent(gameRow!, "email.bounced");
    expect(await statusOf(gameRow!.id), "premise: the row did end badly").toBe("bounced");
    expect(await bridgeOf(withGame.fixtureId), "the bridge row, game and all, is exactly as it was").toEqual(gameBefore);

    const [freeRow] = await rowsForSeat(without.fixtureId, await colourOf(without.fixtureId, without.home.email));
    await providerEvent(freeRow!, "email.bounced");
    expect(stampOf(await bridgeOf(without.fixtureId), await colourOf(without.fixtureId, without.home.email))).toBeNull();
  });

  it("a held board (the organiser's decision) is left alone too; a finished one likewise", async () => {
    const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 2 });
    const [held, finished] = r.boards as [(typeof r.boards)[0], (typeof r.boards)[0]];
    await open(r, OPENED);
    await sql`update fixture_external_play set status = 'needs_organiser', needs_reason = 'provider_error' where fixture_id = ${held.fixtureId}`;
    await sql`update fixture_external_play set status = 'finished' where fixture_id = ${finished.fixtureId}`;
    for (const b of [held, finished]) {
      const before = await bridgeOf(b.fixtureId);
      const [row] = await rowsForSeat(b.fixtureId, await colourOf(b.fixtureId, b.home.email));
      await providerEvent(row!, "email.bounced");
      expect(await bridgeOf(b.fixtureId), b.fixtureId).toEqual(before);
    }
  });

  it("a release after a re-open never clears the newer stamp: the old stamp's row dying leaves the seat's current stamp alone", async () => {
    const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 1 });
    const b = r.boards[0]!;
    mail.retry.add(b.home.email);
    const opened = new Date(); // the real clock: the tick below judges expiry on the database's own time
    await open(r, opened);
    const colour = await colourOf(b.fixtureId, b.home.email);
    const [old] = await rowsForSeat(b.fixtureId, colour);
    expect(old!.meta.stampedAt).toBe(opened.toISOString());
    // The seat is cleared and claimed again under a NEWER stamp (what a reschedule's reset plus a re-open does); this row still
    // carries the old one. SQL stands in for that reset, which is not this task's subject.
    const newer = new Date(opened.getTime() + MIN);
    const col = colour === "white" ? "white_emailed_at" : "black_emailed_at";
    await sql`update fixture_external_play set ${sql(col)} = ${newer} where fixture_id = ${b.fixtureId}`;
    await makeLastAttempt(old!.id);
    expect(await tick([old!.id])).toMatchObject({ dead: 1 });
    expect(await statusOf(old!.id)).toBe("dead");
    expect(stampOf(await bridgeOf(b.fixtureId), colour)!.getTime(), "the newer stamp survives the old row's death").toBe(newer.getTime());
  });

  it("rows of an OLDER stamp, even a delivered one, do not hold a newer stamp: it is released when its own rows ended badly", async () => {
    const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 1 });
    const b = r.boards[0]!;
    await open(r, OPENED);
    const colour = await colourOf(b.fixtureId, b.home.email);
    const [first] = await rowsForSeat(b.fixtureId, colour);
    await providerEvent(first!, "email.delivered"); // the old stamp's mail arrived
    const newer = new Date(OPENED.getTime() + MIN);
    const col = colour === "white" ? "white_emailed_at" : "black_emailed_at";
    await sql`update fixture_external_play set ${sql(col)} = ${newer} where fixture_id = ${b.fixtureId}`;
    mail.fail.add(b.home.email);
    // A resend writes under the stamp the seat holds NOW (the newer one); its row is refused for good.
    expect(await resend(r, b.fixtureId, new Date(OPENED.getTime() + 2 * MIN))).toEqual({ emailed: 1, retrying: 0 });
    const rows = await rowsForSeat(b.fixtureId, colour);
    const fresh = rows.find((x) => x.id !== first!.id)!;
    expect(fresh.meta.stampedAt, "the resend rides on the stamp already there").toBe(newer.toISOString());
    expect(fresh.status).toBe("dead");
    expect((await freshRow(first!.id)).status, "the older stamp's delivered row is untouched").toBe("delivered");
    expect(stampOf(await bridgeOf(b.fixtureId), colour), "the old stamp's delivered mail is not this stamp's invite").toBeNull();
  });
});

// ===========================================================================
// Resend.
// ===========================================================================

describe.skipIf(!HAS_DB)("the organiser's Resend writes a fresh row each time", () => {
  it("a resend replaces the older non-terminal row, never the stamp; counts are { emailed, retrying }", async () => {
    const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 1 });
    const b = r.boards[0]!;
    await open(r, OPENED);
    const stampsBefore = await bridgeOf(b.fixtureId);
    mail.sent.length = 0;
    expect(await resend(r, b.fixtureId, new Date(OPENED.getTime() + MIN))).toEqual({ emailed: 2, retrying: 0 });
    let rows = await rowsOf(b.fixtureId);
    expect(rows).toHaveLength(4);
    expect(rows.filter((x) => x.status === "replaced"), "the two older rows were superseded").toHaveLength(2);
    expect(rows.filter((x) => x.status === "sent")).toHaveLength(2);
    expect(rows.filter((x) => x.status === "replaced").every((x) => !x.has_body)).toBe(true);
    for (const row of rows) expect(row.meta.stampedAt, "every row rides on the seat's one stamp").toBe(OPENED.toISOString());
    const stampsAfter = await bridgeOf(b.fixtureId);
    expect(stampsAfter.white_emailed_at).toEqual(stampsBefore.white_emailed_at);
    expect(stampsAfter.black_emailed_at).toEqual(stampsBefore.black_emailed_at);
    expect(mail.sent.map((m) => m.to).sort()).toEqual([b.home.email, b.away.email].sort());

    // A third send: again fresh rows, again exactly one non-replaced row per recipient.
    expect(await resend(r, b.fixtureId, new Date(OPENED.getTime() + 2 * MIN))).toEqual({ emailed: 2, retrying: 0 });
    rows = await rowsOf(b.fixtureId);
    expect(rows).toHaveLength(6);
    expect(rows.filter((x) => x.status === "sent")).toHaveLength(2);
    expect(rows.filter((x) => x.status === "replaced")).toHaveLength(4);
  });

  it("a delivered older row is NOT replaced and keeps the seat stamped when the new row dies", async () => {
    const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 1 });
    const b = r.boards[0]!;
    await open(r, OPENED);
    const colour = await colourOf(b.fixtureId, b.home.email);
    const [older] = await rowsForSeat(b.fixtureId, colour);
    await providerEvent(older!, "email.delivered");
    mail.fail.add(b.home.email);
    expect(await resend(r, b.fixtureId, new Date(OPENED.getTime() + MIN))).toEqual({ emailed: 1, retrying: 0 });
    const seat = await rowsForSeat(b.fixtureId, colour);
    expect(seat.map((x) => x.status).sort(), "the delivered row stands beside the dead one").toEqual(["dead", "delivered"]);
    expect(stampOf(await bridgeOf(b.fixtureId), colour), "a delivered row keeps the seat stamped").not.toBeNull();
  });

  it("a resend whose send is retried later counts as retrying; a seat it claimed afresh carries the resend's own stamp", async () => {
    const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 1 });
    const b = r.boards[0]!;
    mail.fail.add(b.home.email); // the open leaves home un-invited
    await open(r, OPENED);
    const colour = await colourOf(b.fixtureId, b.home.email).catch(async () => (await colourOf(b.fixtureId, b.away.email)) === "white" ? "black" : "white");
    expect(stampOf(await bridgeOf(b.fixtureId), colour), "premise: the refused seat is un-stamped").toBeNull();
    mail.fail.clear();
    mail.retry.add(b.home.email);
    const at = new Date(OPENED.getTime() + 3 * MIN);
    expect(await resend(r, b.fixtureId, at)).toEqual({ emailed: 1, retrying: 1 });
    const rows = (await rowsOf(b.fixtureId)).filter((x) => x.recipient === b.home.email && x.status !== "dead");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("queued");
    expect(rows[0]!.meta.stampedAt, "a seat the resend claimed rides on THIS call's stamp").toBe(at.toISOString());
    expect(stampOf(await bridgeOf(b.fixtureId), colour)!.getTime()).toBe(at.getTime());
  });

  it("a resend the provider refuses for good counts nothing and un-stamps the seat it claimed", async () => {
    const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 1 });
    const b = r.boards[0]!;
    mail.fail.add(b.home.email);
    await open(r, OPENED);
    expect(await resend(r, b.fixtureId, new Date(OPENED.getTime() + MIN))).toEqual({ emailed: 1, retrying: 0 });
    const bridge = await bridgeOf(b.fixtureId);
    expect([bridge.white_emailed_at, bridge.black_emailed_at].filter((s) => s !== null), "only the away seat is stamped").toHaveLength(1);
  });

  it("a seat that neither claims nor holds a stamp refuses the resend loudly and writes nothing", async () => {
    const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 1 });
    const b = r.boards[0]!;
    mail.fail.add(b.home.email);
    await open(r, OPENED); // home is left un-stamped
    mail.fail.clear();
    const colour = await colourOf(b.fixtureId, b.away.email);
    const homeColour = colour === "white" ? "black" : "white";
    const rowsBefore = (await rowsOf(b.fixtureId)).length;
    race.claimFalseFor.add(`${b.fixtureId}|${homeColour}`); // the claim "loses" for a seat that holds no stamp: cannot happen in a locked tx
    await expect(resend(r, b.fixtureId, new Date(OPENED.getTime() + MIN))).rejects.toThrow(/stamp/);
    expect(await rowsOf(b.fixtureId), "the refused resend queued nothing").toHaveLength(rowsBefore);
    expect(mail.sent.filter((m) => m.to === b.away.email), "and mailed nobody").toHaveLength(1); // only the open's mail
  });

  it("a resend whose queueing THROWS for a seat it claimed un-stamps that seat in the same transaction; a seat invited before keeps its stamp", async () => {
    const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 1 });
    const b = r.boards[0]!;
    mail.fail.add(b.home.email);
    await open(r, OPENED); // home is refused for good and released; away is invited and stamped
    mail.fail.clear();
    const awayColour = await colourOf(b.fixtureId, b.away.email);
    const homeColour = awayColour === "white" ? "black" : "white";
    const awayStamp = stampOf(await bridgeOf(b.fixtureId), awayColour)!;
    expect(awayStamp, "premise: the away seat is stamped").not.toBeNull();
    expect(stampOf(await bridgeOf(b.fixtureId), homeColour), "premise: the home seat was released").toBeNull();
    const rowsBefore = (await rowsOf(b.fixtureId)).length;

    // Both seats fail to queue (the render throws inside each seat's savepoint). Home was CLAIMED by this resend; away was not.
    mail.renderThrows.add(b.home.email).add(b.away.email);
    expect(await resend(r, b.fixtureId, new Date(OPENED.getTime() + MIN))).toEqual({ emailed: 0, retrying: 0 });
    const bridge = await bridgeOf(b.fixtureId);
    expect(stampOf(bridge, homeColour), "the seat the resend claimed is un-stamped with nothing queued for it").toBeNull();
    expect(stampOf(bridge, awayColour)?.getTime(), "the seat invited before keeps the stamp it had").toBe(awayStamp.getTime());
    expect(await rowsOf(b.fixtureId), "the savepoints took every row of the failed queueing back").toHaveLength(rowsBefore);

    // The failure is the call's, not the seat's: the next resend, with rendering back, claims home again and mails both.
    mail.renderThrows.clear();
    mail.sent.length = 0;
    expect(await resend(r, b.fixtureId, new Date(OPENED.getTime() + 2 * MIN))).toEqual({ emailed: 2, retrying: 0 });
    expect(mail.sent.map((m) => m.to).sort()).toEqual([b.home.email, b.away.email].sort());
    expect(stampOf(await bridgeOf(b.fixtureId), homeColour), "claimed afresh").not.toBeNull();
  });

  it("the status read answers with the newest NON-replaced row, even when a replaced row sorts newest (a transaction that began earlier commits later)", async () => {
    const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 1 });
    const b = r.boards[0]!;
    await open(r, OPENED);
    const colour = await colourOf(b.fixtureId, b.home.email);
    const [older] = await rowsForSeat(b.fixtureId, colour);
    expect(await resend(r, b.fixtureId, new Date(OPENED.getTime() + MIN))).toEqual({ emailed: 2, retrying: 0 });
    const seat = await rowsForSeat(b.fixtureId, colour);
    const newer = seat.find((x) => x.status !== "replaced")!;
    expect(seat, "premise: the resend wrote a second row for the seat").toHaveLength(2);
    expect(await statusOf(older!.id), "premise: the older row was superseded").toBe("replaced");
    expect(newer.status, "premise: the live row is the one the provider took").toBe("sent");

    // The replace trigger supersedes by key, not by clock: a request whose transaction BEGAN first but committed last writes a row
    // with the OLDER created_at that replaces the newer-stamped one. Reproduce exactly that ordering.
    await sql`update email_outbox set created_at = created_at + interval '1 hour' where id = ${older!.id}`;
    const answers = await latestStatuses([older!.id, newer.id]);
    expect(answers.get(older!.id), "the replaced row asks about its recipient: the live row answers").toBe(newer.status);
    expect(answers.get(newer.id)).toBe(newer.status);
    expect(seatOutcome([answers.get(newer.id)!]), "so the seat reads invited, not failed (a replaced row carries no information)").toBe("invited");
  });
});

// ===========================================================================
// R9: a process that dies between the terminal write and the hook.
// ===========================================================================

describe.skipIf(!HAS_DB)("R9 - a crash between the terminal write and the hook is finished by the next tick, once", () => {
  /** Wrap the real hook so a test can make it die, and count what it was asked for. */
  function wrapHook(dies: (row: EndedRow) => boolean) {
    const seen: string[] = [];
    KIND_HOOKS.chess_invite = {
      ...realChessHook,
      onEndedBadly: async (row: EndedRow) => {
        seen.push(row.id);
        if (dies(row)) throw new Error("staged: the process died before the hook finished");
        await realChessHook.onEndedBadly!(row);
      },
    };
    return seen;
  }

  it("webhook path: the bounce is committed, the hook dies, the seat stays stamped; the next tick's finder releases it exactly once", async () => {
    const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 1 });
    const b = r.boards[0]!;
    await open(r, OPENED);
    const colour = await colourOf(b.fixtureId, b.home.email);
    const [row] = await rowsForSeat(b.fixtureId, colour);
    let dying = true;
    const seen = wrapHook(() => dying);

    await providerEvent(row!, "email.bounced");
    expect(await statusOf(row!.id), "the terminal write was committed").toBe("bounced");
    expect(seen, "the hook ran and died").toEqual([row!.id]);
    expect(stampOf(await bridgeOf(b.fixtureId), colour), "the seat is still stamped: nothing released it").not.toBeNull();
    expect((await findUnappliedEndings(500)).map((x) => x.id), "the finder reports the unapplied ending").toContain(row!.id);

    dying = false;
    seen.length = 0;
    await tick([]); // nothing to claim; step 6 re-drives the unapplied endings
    expect(seen.filter((id) => id === row!.id), "the re-drive ran the hook for this row once").toEqual([row!.id]);
    expect(stampOf(await bridgeOf(b.fixtureId), colour), "and released the seat").toBeNull();

    seen.length = 0;
    await tick([]);
    expect(seen.filter((id) => id === row!.id), "a third tick finds nothing left to do for it").toEqual([]);
    expect((await findUnappliedEndings(500)).map((x) => x.id)).not.toContain(row!.id);
  });

  it("dispatch path: a first attempt refused for good ends the row, the hook dies, and the tick releases the seat", async () => {
    const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 1 });
    const b = r.boards[0]!;
    mail.fail.add(b.home.email);
    const seen = wrapHook(() => true);
    await open(r, OPENED);
    const colour = await colourOf(b.fixtureId, b.home.email);
    const [row] = await rowsForSeat(b.fixtureId, colour);
    expect(row!.status).toBe("dead");
    expect(seen).toEqual([row!.id]);
    expect(stampOf(await bridgeOf(b.fixtureId), colour), "released by nobody yet").not.toBeNull();

    KIND_HOOKS.chess_invite = realChessHook;
    await tick([]);
    expect(stampOf(await bridgeOf(b.fixtureId), colour)).toBeNull();
  });

  describe("the finder reports exactly the endings whose effect is not applied", () => {
    it("a seat with a live sibling, a complaint, a game on file, or a newer stamp is NOT reported; an applied (released) one is not either", async () => {
      const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 5 });
      const [liveSibling, complaint, game, newer, applied] = r.boards as [
        (typeof r.boards)[0], (typeof r.boards)[0], (typeof r.boards)[0], (typeof r.boards)[0], (typeof r.boards)[0],
      ];
      for (const b of [liveSibling, complaint, game, newer, applied]) await addMember(r, b.home.entrantId, `${RUN}-m-${randomUUID().slice(0, 6)}@t.local`);
      await open(r, OPENED);
      const home = async (b: (typeof r.boards)[0]) => rowsForSeat(b.fixtureId, await colourOf(b.fixtureId, b.home.email));

      // Make every home row end badly WITHOUT running the hook (a dead hook), then differ one fact per board.
      KIND_HOOKS.chess_invite = { ...realChessHook, onEndedBadly: async () => { throw new Error("staged: dead hook"); } };
      const [lsA, lsB] = await home(liveSibling);
      await providerEvent(lsA!, "email.bounced"); // the sibling stays sent (live)
      const [cA, cB] = await home(complaint);
      await providerEvent(cA!, "email.bounced");
      await providerEvent(cB!, "email.complained"); // a complaint holds the seat
      const [gA, gB] = await home(game);
      await providerEvent(gA!, "email.bounced");
      await providerEvent(gB!, "email.bounced");
      await sql`update fixture_external_play set challenge_id = ${`gm-${randomUUID().slice(0, 12)}`} where fixture_id = ${game.fixtureId}`;
      const [nA, nB] = await home(newer);
      await providerEvent(nA!, "email.bounced");
      await providerEvent(nB!, "email.bounced");
      const col = (await colourOf(newer.fixtureId, newer.home.email)) === "white" ? "white_emailed_at" : "black_emailed_at";
      await sql`update fixture_external_play set ${sql(col)} = ${new Date(OPENED.getTime() + MIN)} where fixture_id = ${newer.fixtureId}`;
      const [aA, aB] = await home(applied);
      await providerEvent(aA!, "email.bounced");
      await providerEvent(aB!, "email.bounced");
      KIND_HOOKS.chess_invite = realChessHook;
      await realChessHook.onEndedBadly!({ id: aB!.id, kind: "chess_invite", refType: aB!.ref_type, refId: aB!.ref_id, status: "bounced", meta: aB!.meta });
      expect(stampOf(await bridgeOf(applied.fixtureId), await colourOf(applied.fixtureId, applied.home.email)), "premise: applied").toBeNull();

      const ours = new Set([lsA, lsB, cA, cB, gA, gB, nA, nB, aA, aB].map((x) => x!.id));
      const reported = (await findUnappliedEndings(500)).filter((x) => ours.has(x.id));
      expect(reported, "none of these five seats has an unapplied ending").toEqual([]);

      // Positive pair: the SAME shape with the one fact that matters removed IS reported (so the finder is not just empty).
      const lone = await seedOnlineChessRound({ roundNo: 1, fixtures: 1 });
      await open(lone, OPENED);
      const loneRows = await rowsOf(lone.boards[0]!.fixtureId);
      KIND_HOOKS.chess_invite = { ...realChessHook, onEndedBadly: async () => { throw new Error("staged: dead hook"); } };
      await providerEvent(loneRows.find((x) => x.recipient === lone.boards[0]!.home.email)!, "email.bounced");
      KIND_HOOKS.chess_invite = realChessHook;
      const found = (await findUnappliedEndings(500)).filter((x) => x.id === loneRows.find((y) => y.recipient === lone.boards[0]!.home.email)!.id);
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({ kind: "chess_invite", refType: "fixture_seat", status: "bounced" });
    });

    it("rows of an OLDER stamp - even a delivered one - do not hold a newer stamp: its own dead row is reported, and the re-drive releases the seat", async () => {
      const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 1 });
      const b = r.boards[0]!;
      await open(r, OPENED);
      const colour = await colourOf(b.fixtureId, b.home.email);
      const [first] = await rowsForSeat(b.fixtureId, colour);
      await providerEvent(first!, "email.delivered"); // the old stamp's mail arrived (a delivered row is never replaced)
      const newer = new Date(OPENED.getTime() + MIN);
      const col = colour === "white" ? "white_emailed_at" : "black_emailed_at";
      await sql`update fixture_external_play set ${sql(col)} = ${newer} where fixture_id = ${b.fixtureId}`;
      mail.fail.add(b.home.email);
      const seen = wrapHook(() => true); // the process dies before the hook releases the seat
      expect(await resend(r, b.fixtureId, new Date(OPENED.getTime() + 2 * MIN))).toEqual({ emailed: 1, retrying: 0 });
      const fresh = (await rowsForSeat(b.fixtureId, colour)).find((x) => x.id !== first!.id)!;
      expect(fresh.status, "premise: the newer stamp's row ended badly").toBe("dead");
      expect(fresh.meta.stampedAt, "premise: it rides on the newer stamp").toBe(newer.toISOString());
      expect(await statusOf(first!.id), "premise: the older stamp's row is delivered, live").toBe("delivered");
      expect(seen, "premise: the hook ran and died").toEqual([fresh.id]);
      expect(stampOf(await bridgeOf(b.fixtureId), colour), "premise: nothing released the seat").not.toBeNull();

      expect((await findUnappliedEndings(500)).map((x) => x.id), "the older stamp's delivered row holds nothing of the newer stamp").toContain(fresh.id);
      KIND_HOOKS.chess_invite = realChessHook;
      await tick([]);
      expect(stampOf(await bridgeOf(b.fixtureId), colour), "the re-drive released it").toBeNull();
    });

    it("applied endings are excluded in SQL BEFORE the limit, so they cannot starve an unapplied one", async () => {
      const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 4 });
      for (const b of r.boards) mail.fail.add(b.home.email); // every home seat dies at once
      // The LAST board's hook dies (an unapplied ending, the newest); the first three are released by the real hook (applied, older).
      const last = r.boards[3]!;
      const seen = wrapHook((row) => row.refId.startsWith(`${last.fixtureId}:`));
      await open(r, OPENED);
      const homeRow = async (b: (typeof r.boards)[0]) => (await rowsForSeat(b.fixtureId, await colourOf(b.fixtureId, b.home.email)))[0]!;
      const applied = await Promise.all(r.boards.slice(0, 3).map(async (b) => (await homeRow(b)).id));
      const unapplied = (await homeRow(last)).id;
      expect(seen, "premise: the hook ran for every dead row").toHaveLength(4);
      for (const b of r.boards.slice(0, 3)) {
        expect(stampOf(await bridgeOf(b.fixtureId), await colourOf(b.fixtureId, b.home.email)), "premise: applied").toBeNull();
      }
      expect(stampOf(await bridgeOf(last.fixtureId), await colourOf(last.fixtureId, last.home.email)), "premise: the last is not").not.toBeNull();

      const everything = (await realChessHook.findUnapplied!(500)).map((x) => x.id);
      expect(everything, "the unapplied ending is reported").toContain(unapplied);
      for (const id of applied) expect(everything, `applied row ${id} is not reported`).not.toContain(id);
      // With room for ONE: never an applied row (they are excluded before the limit, so they cannot take the slot).
      const one = (await realChessHook.findUnapplied!(1)).map((x) => x.id);
      expect(one.length).toBeLessThanOrEqual(1);
      for (const id of applied) expect(one).not.toContain(id);
      expect(await findUnappliedEndings(0), "a limit of zero asks for nothing").toEqual([]);
    });
  });
});

// ===========================================================================
// The response contract.
// ===========================================================================

describe.skipIf(!HAS_DB)("the open's audit row and the response carry retrying", () => {
  it("the audit payload records invited, retrying and the skips", async () => {
    const r = await seedOnlineChessRound({ roundNo: 1, fixtures: 2 });
    const [a, b] = r.boards as [(typeof r.boards)[0], (typeof r.boards)[0]];
    mail.retry.add(a.home.email);
    mail.fail.add(b.home.email);
    await open(r, OPENED);
    const [event] = await auditPayloads(r.competitionId);
    expect(event).toMatchObject({
      type: "external_play.round_opened",
      invited: r.boards.length * SEATS_PER_BOARD - 1 - 1, // all seats, but a's retrying home and b's refused home
      retrying: 1,
      skipped: [{ fixtureId: b.fixtureId, reason: "send_failed" }],
    });
  });
});
