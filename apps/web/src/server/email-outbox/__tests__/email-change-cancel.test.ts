// Phase 3 wave 3, T1 (plan P-W3-4): an email change ends the user's older queued confirmation with its own cancel reason.
//
// Spec §5: a new email-change request "ends the user's queued `email_change_confirmation` rows itself, using the cancel primitive in
// §7". `cancelQueuedEmails` refuses any reason not in `CANCELLED_REASONS` (the readers know only those words), so the request needs a
// word of its own. T2c's route is the producer that calls it; this file proves the word is accepted and what the row looks like after.
//
// Shape (copied from void-cancels-invites.test.ts's database cases): the older request's confirmation was committed by ITS request, so
// it is queued in one privileged transaction (`sql.begin`, org null, as account mail is) and ended in another, the newer request's.
// The pooled handle matches only rows with no organisation (cancel.ts G-7), which is exactly this row.
//
// Expected values are typed here, never read from the code under test: the reason is the plan's word (`email_change_superseded`), and
// what a cancelled row is (`expired`, `last_error` = the reason, no body) is the spec's §7. "Reads as voided" is the outbox's own
// reader (`latestStatusesOfRows`), which skips an `expired` row whose `last_error` is a cancel reason; its positive pair is the same
// read before the cancel, which answers `queued`.
//
// Sport: not applicable (account mail does not vary by sport).
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { stubOutboxEnv } from "@/server/usecases/__tests__/_invite-mail";
import {
  EMAIL_CHANGE_SUPERSEDED_REASON,
  cancelQueuedEmails,
  enqueueEmail,
  latestStatusesOfRows,
  type OutboxMessage,
} from "@/server/email-outbox";

const HAS_DB = !!process.env.DATABASE_URL;
const RUN = `ecc-${randomUUID().slice(0, 8)}`;

/** The plan's word (P-W3-4), typed here. */
const SUPERSEDED = "email_change_superseded";

/** Every user id this file used as a ref, so teardown finds its rows. */
const userIds: string[] = [];

beforeEach(() => stubOutboxEnv());
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
afterAll(async () => {
  if (!HAS_DB) return;
  await sql`delete from email_outbox where ref_type = 'user' and ref_id = any(${userIds}::text[])`;
  await sql.end({ timeout: 2 }).catch(() => undefined);
});

type Row = { status: string; last_error: string | null; has_body: boolean; has_lease: boolean; org_id: string | null };
const rowOf = async (id: string): Promise<Row> => {
  const [r] = await sql<Row[]>`
    select status, last_error, body_sealed is not null as has_body, lease_until is not null as has_lease, org_id
      from email_outbox where id = ${id}`;
  expect(r, `row ${id} exists`).toBeDefined();
  return r!;
};

/** An email-change confirmation to the new address, as the change-email route writes one: literal, transactional, no organisation. */
const confirmation = (userId: string): OutboxMessage => ({
  kind: "email_change_confirmation",
  refType: "user",
  refId: userId,
  orgId: null,
  to: `${RUN}-${randomUUID().slice(0, 8)}@x.test`,
  subject: "Confirm your new email address",
  html: "<a href='https://seazn.club/api/auth/confirm-email-change?token=SECRET-TOKEN'>Confirm</a>",
  text: "Confirm: https://seazn.club/api/auth/confirm-email-change?token=SECRET-TOKEN",
  transactional: true,
  expiresAt: new Date(Date.now() + 60 * 60_000),
});

describe("the email-change cancel reason (no database)", () => {
  it("is the plan's word, exported from the outbox's public surface", () => {
    expect(EMAIL_CHANGE_SUPERSEDED_REASON).toBe(SUPERSEDED);
  });
});

describe.skipIf(!HAS_DB)("an email change ends the user's older queued confirmation (spec §5, §7)", () => {
  it("an email-change confirmation can be cancelled with its own reason, and the row reads as voided", async () => {
    const userId = randomUUID();
    userIds.push(userId);
    const id = await sql.begin((tx) => enqueueEmail(tx, confirmation(userId)));
    const before = await rowOf(id);
    expect(before, "premise: the older confirmation is queued, with its body, and belongs to no organisation").toMatchObject({
      status: "queued",
      has_body: true,
      org_id: null,
    });
    expect((await latestStatusesOfRows([id])).get(id), "premise: before the cancel the reader answers the row as queued").toBe("queued");

    const ask = { kind: "email_change_confirmation" as const, refType: "user", refIds: [userId], reason: EMAIL_CHANGE_SUPERSEDED_REASON };
    const ended = await sql.begin((tx) => cancelQueuedEmails(tx, ask));

    expect(ended, "exactly the one queued confirmation was ended").toEqual([
      { id, kind: "email_change_confirmation", refType: "user", refId: userId, status: "expired", meta: {} },
    ]);
    expect(await rowOf(id), "the row as §7 leaves it: expired, the reason in last_error, no body, no lease").toEqual({
      status: "expired",
      last_error: SUPERSEDED,
      has_body: false,
      has_lease: false,
      org_id: null,
    });
    expect((await latestStatusesOfRows([id])).has(id), "the reader skips it: a voided row is not the user's mail any more").toBe(false);

    const again = await sql.begin((tx) => cancelQueuedEmails(tx, ask));
    expect(again, "a second call ends nothing: only queued rows are ended").toEqual([]);
  });
});
