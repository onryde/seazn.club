// Phase 3 wave 1, T4: a chess invite is an ACCOUNT's mail. The round open writes each row with the player's user id
// (`recipient_user_id`), and the address is decided when the mail is SENT (email-outbox/recipient.ts): the account's address then,
// when no request can have left under the row's idempotency key (key-clean), the address the row was queued with otherwise (D2).
//
// The inert-seam rule (AGENTS.md class 1): everything here is driven through the REAL producer and consumer. `openRound` is the
// producer (it renders, stamps and queues the invite through `queueFixtureInvite`), `dispatchNow` (inside the open) and
// `runOutboxTick` are the consumers, and the real chess hook releases a seat. Only `transport.deliver` is replaced (the provider's
// answer is the test's), as every migrated external-play suite does (../../__tests__/_invite-mail.ts). Nothing here calls
// `enqueueEmail` or `resolveRecipient` directly: a fixture on both ends proves the fixture.
//
// Expected values: the address -> user id map is the SEED's (each linked player was created with an email and a user id), the
// provider's answers are the vendor's (429 is refused before a message is made, a 5xx may have made one), the colour of a seat is
// whatever the rows the open wrote say (the pairing decides it, not the test). Single-sport by construction: online play exists
// only for `boardgame` (`supportsOnlinePlay`).
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { FIRST_ATTEMPT_WINDOW_MS } from "@/server/email-outbox/constants";
import { runOutboxTick } from "@/server/email-outbox/worker";
import type { DeliverMessage } from "@/server/email-outbox/transport";
import { stubOutboxEnv, type InviteMail, type SentInvite } from "../../__tests__/_invite-mail";
import { seedOnlineChessRound, type SeedOnlineChessRoundResult, type SeedSide } from "../../__tests__/_external-play-seed";

const mail = vi.hoisted(() => ({
  sent: [] as SentInvite[],
  fail: new Set<string>(),
  retry: new Set<string>(),
  rateLimit: new Set<string>(),
}));
vi.mock("@/lib/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email")>();
  const h = await import("../../__tests__/_invite-mail");
  return { ...actual, externalPlayInviteEmail: h.renderInviteForTest };
});
vi.mock("@/server/email-outbox/transport", async () => {
  const h = await import("../../__tests__/_invite-mail");
  return { deliver: (msg: DeliverMessage) => h.deliverForTest(mail as InviteMail, msg) };
});

import { openRound } from "../open-round";
import { resendExternalPlayNotice } from "../invite";
import { STAMP_COLUMN, type Colour } from "../seat-stamp";

const HAS_DB = !!process.env.DATABASE_URL;
const ORIGIN = "https://seazn.test";

beforeEach(() => {
  mail.sent.length = 0;
  for (const set of [mail.fail, mail.retry, mail.rateLimit]) set.clear();
  stubOutboxEnv();
});
afterAll(async () => {
  if (HAS_DB) await sql.end({ timeout: 2 }).catch(() => undefined);
});

type Row = {
  id: string;
  ref_id: string;
  recipient: string;
  recipient_user_id: string | null;
  status: string;
  attempts: number;
  last_error: string | null;
};
/** Every chess-invite row of these boards, oldest first. */
const rowsOf = (fixtureIds: readonly string[]) =>
  sql<Row[]>`
    select id, ref_id, recipient, recipient_user_id, status, attempts, last_error
      from email_outbox
     where kind = 'chess_invite' and split_part(ref_id, ':', 1) = any(${fixtureIds as string[]}::text[])
     order by created_at, ref_id, id`;
const colourOfRow = (row: Row): Colour => (row.ref_id.endsWith(":white") ? "white" : "black");
const sidesOf = (r: SeedOnlineChessRoundResult): SeedSide[] => r.boards.flatMap((b) => [b.home, b.away]);
const fixtureIdsOf = (r: SeedOnlineChessRoundResult): string[] => r.boards.map((b) => b.fixtureId);

async function openedRound(fixtures: number, beforeOpen?: (r: SeedOnlineChessRoundResult) => void): Promise<SeedOnlineChessRoundResult> {
  const r = await seedOnlineChessRound({ fixtures });
  beforeOpen?.(r);
  const out = await openRound({ stageId: r.stageId, roundNo: r.roundNo, actorUserId: r.ownerUserId });
  expect(out, "premise: the real open stamped the round and invited it").toMatchObject({ opened: true });
  return r;
}

/** The player's account moves to a new address; returns it. */
async function moveAccount(side: SeedSide): Promise<string> {
  const next = `moved-${randomUUID().slice(0, 8)}@test.local`;
  await sql`update users set email = ${next} where id = ${side.userId}`;
  return next;
}
/** The request that wrote these rows is done with them: older than the first-attempt window, and due now. */
async function dueForTheWorker(ids: readonly string[]): Promise<void> {
  await sql`
    update email_outbox
       set created_at = created_at - make_interval(secs => ${FIRST_ATTEMPT_WINDOW_MS / 1000 + 60}),
           next_attempt_at = now() - interval '1 second'
     where id = any(${ids as string[]}::uuid[]) and status = 'queued'`;
}
const tick = (ids: readonly string[]) => runOutboxTick({ onlyIds: [...ids], sleep: async () => undefined });
const bridgeStamp = async (fixtureId: string, colour: Colour): Promise<Date | null> => {
  const [b] = await sql<Record<string, Date | null>[]>`
    select white_emailed_at, black_emailed_at from fixture_external_play where fixture_id = ${fixtureId}`;
  return b![STAMP_COLUMN[colour]] ?? null;
};

describe.skipIf(!HAS_DB)("a round open's invites are an account's mail (T4)", () => {
  it("an opened round's invites carry the player's user id", async () => {
    const r = await openedRound(2);
    // The seed's own map: every linked player was created with this address and this user id.
    const userOf = new Map(sidesOf(r).map((s) => [s.email.toLowerCase(), s.userId]));
    expect(userOf.size, "premise: four distinct players").toBe(4);

    const rows = await rowsOf(fixtureIdsOf(r));
    let checked = 0;
    for (const row of rows) {
      expect(userOf.has(row.recipient.toLowerCase()), `premise: ${row.ref_id} was addressed to a seeded player`).toBe(true);
      expect(row.recipient_user_id, `${row.ref_id} names its player's account`).toBe(userOf.get(row.recipient.toLowerCase()));
      checked += 1;
    }
    expect(checked, "anti-vacuity: every row of the open was judged").toBe(rows.length);
    expect(checked, "one row per seat, two seats a board").toBe(2 * r.boards.length);
    expect(checked).toBeGreaterThanOrEqual(2);
  });

  it("F3: an invite queued before an email change goes to the NEW address when the open's attempt was a 429 (key-clean)", async () => {
    const r = await openedRound(1, (seeded) => {
      for (const s of sidesOf(seeded)) mail.rateLimit.add(s.email);
    });
    const rows = await rowsOf(fixtureIdsOf(r));
    expect(rows, "premise: both seats were invited").toHaveLength(2);
    expect(rows.every((x) => x.status === "queued"), "premise: the open sent nothing").toBe(true);
    expect(
      rows.filter((x) => x.attempts === 1 && x.last_error === "http 429 rate_limit_exceeded"),
      "premise: the open's first attempt was a 429 and recorded as one (the other seat was never tried)",
    ).toHaveLength(1);
    expect(mail.sent, "premise: the provider accepted nothing").toHaveLength(0);

    mail.rateLimit.clear();
    const moved = new Map<string, string>();
    for (const s of sidesOf(r)) moved.set(s.email.toLowerCase(), await moveAccount(s));
    await dueForTheWorker(rows.map((x) => x.id));
    await tick(rows.map((x) => x.id));

    // Both rows (the 429'd one and the never-tried one) are clean, so both follow the account.
    expect(mail.sent.map((m) => m.to).sort()).toEqual([...moved.values()].sort());
    const after = await rowsOf(fixtureIdsOf(r));
    for (const row of after) {
      expect(row.status).toBe("sent");
      expect(row.recipient, "the row's address was rewritten to the account's").toBe(moved.get(rows.find((x) => x.id === row.id)!.recipient.toLowerCase()));
    }
  });

  it("D2: after a 503 first attempt the OLD address is kept, even though the account moved", async () => {
    const r = await openedRound(1, (seeded) => {
      for (const s of sidesOf(seeded)) mail.retry.add(s.email);
    });
    const rows = await rowsOf(fixtureIdsOf(r));
    expect(rows).toHaveLength(2);
    expect(
      rows.every((x) => x.status === "queued" && x.attempts === 1 && x.last_error === "http 503 service_unavailable"),
      "premise: both open attempts were a 503, which may have created a message at Resend",
    ).toBe(true);
    const before = new Map(rows.map((x) => [x.id, x.recipient]));

    mail.retry.clear();
    for (const s of sidesOf(r)) await moveAccount(s);
    await dueForTheWorker(rows.map((x) => x.id));
    await tick(rows.map((x) => x.id));

    expect(mail.sent.map((m) => m.to).sort(), "both mails went where the first request did").toEqual([...before.values()].sort());
    for (const row of await rowsOf(fixtureIdsOf(r))) {
      expect(row.status).toBe("sent");
      expect(row.recipient, "the row is not rewritten").toBe(before.get(row.id));
    }
  });

  it("a resend after an email change replaces the old row (by the account), so the player is not mailed twice", async () => {
    const r = await openedRound(1, (seeded) => {
      for (const s of sidesOf(seeded)) mail.retry.add(s.email);
    });
    const first = await rowsOf(fixtureIdsOf(r));
    expect(first, "premise: both seats have a queued invite at the old address").toHaveLength(2);
    const home = r.boards[0]!.home;
    const next = await moveAccount(home);

    const out = await resendExternalPlayNotice(r.owner, r.boards[0]!.fixtureId, ORIGIN);
    expect(out.emailed + out.retrying, "premise: the resend wrote new invites").toBeGreaterThan(0);

    const rows = await rowsOf(fixtureIdsOf(r));
    const forHome = rows.filter((x) => x.recipient_user_id === home.userId);
    const live = forHome.filter((x) => x.status !== "replaced");
    expect(live, "one live row for the player").toHaveLength(1);
    expect(live[0]!.recipient, "... and it is at the new address").toBe(next);
    const stale = forHome.filter((x) => x.status === "replaced");
    expect(stale, "the invite at the old address was replaced, not left to be mailed too").toHaveLength(1);
    expect(stale[0]!.recipient.toLowerCase()).toBe(home.email.toLowerCase());
  });

  it("a deleted player's invite releases the seat: the row ends expired / account_deleted and the bridge's stamp is cleared (the hook ran)", async () => {
    const r = await openedRound(1, (seeded) => {
      for (const s of sidesOf(seeded)) mail.retry.add(s.email);
    });
    const fixtureId = r.boards[0]!.fixtureId;
    const rows = await rowsOf([fixtureId]);
    expect(rows).toHaveLength(2);
    const home = r.boards[0]!.home;
    const away = r.boards[0]!.away;
    const homeRow = rows.find((x) => x.recipient.toLowerCase() === home.email.toLowerCase())!;
    const awayRow = rows.find((x) => x.recipient.toLowerCase() === away.email.toLowerCase())!;
    const homeColour = colourOfRow(homeRow);
    const awayColour = colourOfRow(awayRow);
    expect(homeColour, "premise: the two players sit on different seats").not.toBe(awayColour);
    expect(await bridgeStamp(fixtureId, homeColour), "premise: the open stamped the deleted player's seat").not.toBeNull();

    mail.retry.clear();
    await sql`update users set deleted_at = now() where id = ${home.userId}`;
    await dueForTheWorker(rows.map((x) => x.id));
    await tick(rows.map((x) => x.id));

    const [ended] = await sql<{ status: string; last_error: string | null; recipient: string }[]>`
      select status, last_error, recipient from email_outbox where id = ${homeRow.id}`;
    expect([ended!.status, ended!.last_error]).toEqual(["expired", "account_deleted"]);
    expect(ended!.recipient, "the old address is scrubbed from the row").toBe(`deleted-${home.userId}@deleted.invalid`);
    expect(mail.sent.map((m) => m.to), "nobody mailed the deleted player; the other player's invite went out").toEqual([away.email]);
    expect(await bridgeStamp(fixtureId, homeColour), "the chess hook released the seat the invite could not reach").toBeNull();
    expect(await bridgeStamp(fixtureId, awayColour), "the other seat keeps its stamp: its mail went out").not.toBeNull();

    // The sequence: a second tick has nothing left to do.
    mail.sent.length = 0;
    await tick(rows.map((x) => x.id));
    expect(mail.sent).toHaveLength(0);
  });
});
