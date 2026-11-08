// Quick match plan 3, Task 4: saving (spec docs/superpowers/specs/2026-11-03-quick-match-design.md §7.7 as amended
// 2026-11-08, C3, C9, C13; pre-flight D3, D9, D10, D13, B19). Two ways in, one save:
//   - `saveQuickMatchesForVerifiedUser(userId)`: on any verified sign-in, every unsaved, unexpired match typed with the
//     account's address (case-folded) becomes the account's. Never past the route: a failure is logged and answered 0.
//   - `saveQuickMatchForUser(userId, id)`: the Save button's one match, whoever presses it (C3), with four answers:
//     saved, already_yours, taken (someone else's: refused, unchanged), gone (no row, or expired and not yet swept).
// A save clears the expiry, marks the reminder as spent, ends a queued reminder, and sends one `quick_match_saved` event.
//
// Every quick match is made by the real producer (`createQuickMatch`, via `_quick-match-save-rig.ts`), with the address
// typed on it. The few direct UPDATEs below are states the clock or another plan produces (an expired, unswept row; a
// reminder already sent; an unverified or deleted account), each named where it is made. Expected values come from the
// spec (§7.7: saver set, expiry cleared; C3; D13), never from the code under test.
//
// One sport (see the rig's header): a save reads only the `quick_matches` row.
//
// THE REMINDER'S CANCEL (D9) is witnessed twice. At its seam: the cancel is wrapped below, every call recorded with the
// tenant its handle runs as and passed to the real `cancelQueuedEmails`. And on the outbox row itself (plan 3 Task 1 added
// `quick_match_reminder` to OUTBOX_KINDS and to the kind CHECK, V493): a queued reminder is written by the real writer, the
// way the expiry sweep (plan 3 Task 2) will write it, the match is saved by each path, and the row is read back ended.
//
// THE BY-EMAIL LOOKUP'S INDEX (V493 `quick_matches_unsaved_email_idx`, plan 3 Amend T1 [B20]): the save runs on every
// verified sign-in, site-wide. The planner is asked, inside the save's own transaction and for its own statement, to use the
// index (sequential scans off), and the transaction's own index statistics say whether it did, and that it read the one
// address rather than every unsaved one (under RLS, `lower(email) = $1` can only walk the index; V493's header says why).
//
// Real Postgres required; skipped without DATABASE_URL.
import { randomBytes as kekBytes, randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.stubEnv("DEVICE_LINK_KEK", kekBytes(32).toString("hex")); // every create seals a home token
vi.stubEnv("EMAIL_OUTBOX_KEK", kekBytes(32).toString("hex")); // a queued mail holds a sealed body, so "the cancel cleared it" can fail

const ph = vi.hoisted(() => ({ capture: vi.fn<(args: unknown) => Promise<void>>(async () => {}) }));
vi.mock("@/lib/posthog-server", async (orig) => ({
  ...(await orig<typeof import("@/lib/posthog-server")>()),
  captureServer: ph.capture,
}));
// The after-response window: every `deferred(fn)` is captured, not run, until the test runs it (`savedEvents`).
const after = vi.hoisted(() => ({ tasks: [] as Array<() => unknown> }));
vi.mock("@/lib/deferred", () => ({ deferred: (fn: () => unknown) => void after.tasks.push(fn) }));
const logs = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock("@/server/logger", () => ({
  log: { error: logs.error, warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

type CancelArgs = {
  kind: string;
  refType: string;
  refIds: readonly string[];
  reason: string;
};
const cancel = vi.hoisted(() => ({
  calls: [] as (CancelArgs & { org: string | null })[],
  fail: false,
}));
vi.mock("@/server/email-outbox/cancel", async (orig) => {
  const actual = await orig<typeof import("@/server/email-outbox/cancel")>();
  return {
    ...actual,
    cancelQueuedEmails: async (...args: Parameters<typeof actual.cancelQueuedEmails>) => {
      if (cancel.fail) throw new Error("armed: the cancel failed");
      const [tx, a] = args;
      // The handle's tenant, read on the handle itself: `withTenant` sets it; the pool has none (cancel.ts G-7).
      const [{ org }] = await tx<{ org: string | null }[]>`select current_org_id()::text as org`;
      cancel.calls.push({
        kind: a.kind,
        refType: a.refType,
        refIds: [...a.refIds].sort(),
        reason: a.reason,
        org,
      });
      return actual.cancelQueuedEmails(...args);
    },
  };
});
// The index probe: when armed, the save's own tenant transaction plans with sequential scans off, and reads back, on that same
// transaction, how often it scanned the by-email index and how many index entries those scans returned; then, as the yardstick,
// how many entries a lookup of the one address alone returns on that same transaction (an index holds an entry per row VERSION
// until vacuum, so "one" is not a constant: the yardstick counts the address's own). Disarmed, `withTenant` is the real one.
const plan = vi.hoisted(() => ({
  armed: false,
  address: "",
  scans: null as number | null,
  entries: null as number | null,
  yardstick: null as number | null,
}));
vi.mock("@/lib/db", async (orig) => {
  const actual = await orig<typeof import("@/lib/db")>();
  const withTenant: typeof actual.withTenant = (orgId, fn, opts) =>
    actual.withTenant(
      orgId,
      async (tx) => {
        if (!plan.armed) return fn(tx);
        await tx`set local enable_seqscan = off`;
        const out = await fn(tx);
        // This transaction's own use of the index (null when there is no such index): Postgres counts an index's scans and the
        // entries they returned per transaction (pg_stat_get_xact_numscans / _tuples_returned), synchronously, so no other
        // suite's work can reach the numbers.
        const read = async () =>
          (
            await tx<{ n: number | null; e: number | null }[]>`
              select pg_stat_get_xact_numscans(to_regclass('quick_matches_unsaved_email_idx'))::int as n,
                     pg_stat_get_xact_tuples_returned(to_regclass('quick_matches_unsaved_email_idx'))::int as e`
          )[0];
        const r = await read();
        plan.scans = r?.n ?? null;
        plan.entries = r?.e ?? null;
        await tx`select 1 from quick_matches where email_lower = lower(${plan.address}) and saved_by_user_id is null`;
        const after = await read();
        plan.yardstick = after?.e != null && r?.e != null ? after.e - r.e : null;
        return out;
      },
      opts,
    );
  return { ...actual, withTenant };
});

import { sql } from "@/lib/db";
import { QUICK_MATCH_SYSTEM_ORG_ID } from "@/lib/quick-match-constants";
import { KIND_HOOKS } from "@/server/email-outbox/hooks";
import { enqueueEmail, expiryWithin } from "@/server/email-outbox/enqueue";
import { QUICK_MATCH_OUTBOX_REF_TYPE } from "../quick-match-delete";
import { saveQuickMatchForUser, saveQuickMatchesForVerifiedUser } from "../quick-match-save";
import { addressFor, createTypedMatch, deleteMadeMatches, saveStateOf } from "./_quick-match-save-rig";

const HAS_DB = !!process.env.DATABASE_URL;
/** The spec's words (plan 3 Amend T4 [D9, D10]), typed here so a rename in the code reds this file. */
const REMINDER_KIND = "quick_match_reminder";
const SAVED_REASON = "quick_match_saved";
const SAVED_EVENT = "quick_match_saved";

const users: string[] = [];

/** An account with this address. `verified` is the column the sign-in doors set (B19). */
async function account(email: string, o: { verified?: boolean; deleted?: boolean } = {}): Promise<string> {
  const [{ id }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified, deleted_at)
    values (${email}, 'QM saver', ${o.verified ?? true}, ${o.deleted ? new Date() : null}) returning id`;
  users.push(id);
  return id;
}
const someone = () => account(addressFor("someone"));

/** The clock's state: past its expiry, not yet reached by the sweep (D13). */
const expire = (id: string) => sql`update quick_matches set expires_at = now() - interval '1 minute' where id = ${id}`;

/** The address columns of one row, read on the pool: the typed `email` and V493's generated `email_lower` beside it. */
const addressOf = async (id: string): Promise<{ email: string | null; email_lower: string | null }> => {
  const [r] = await sql<{ email: string | null; email_lower: string | null }[]>`
    select email, email_lower from quick_matches where id = ${id}`;
  if (!r) throw new Error(`precondition: quick match ${id} has a row`);
  return r;
};
/** Branch review B m9 (controller, PO rec 2026-11-08): a saved match forgets the address typed on it; the saver is known now. */
const FORGOTTEN = { email: null, email_lower: null };

/** The `quick_match_saved` events sent so far, the after-response window not run. */
const sentSoFar = () =>
  ph.capture.mock.calls
    .map((c) => c[0] as { event: string; properties?: { quick_match_id?: string } })
    .filter((e) => e.event === SAVED_EVENT);
/** The `quick_match_saved` events sent once the after-response window has run. */
const savedEvents = async () => {
  for (const task of after.tasks.splice(0)) await task();
  return sentSoFar();
};

beforeEach(() => {
  ph.capture.mockClear();
  after.tasks = [];
  logs.error.mockClear();
  cancel.calls = [];
  cancel.fail = false;
});

afterAll(async () => {
  if (!HAS_DB) return;
  await deleteMadeMatches();
  if (users.length > 0) await sql`delete from users where id = any(${users}::uuid[])`;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)(
  "saveQuickMatchesForVerifiedUser: a verified sign-in keeps the matches typed with its address",
  () => {
    it("Review Focus 4: two matches on one address, one already saved by someone else — only the unsaved one is saved", async () => {
      const email = addressFor("rf4");
      const mine = await createTypedMatch(email);
      const theirs = await createTypedMatch(email);
      const other = await someone();
      expect(await saveQuickMatchForUser(other, theirs.id), "premise: someone else pressed Save on the second").toBe(
        "saved",
      );
      const user = await account(email);

      expect(await saveQuickMatchesForVerifiedUser(user)).toEqual({
        savedByEmail: 1,
      });

      const a = await saveStateOf(mine.id);
      expect([a.saved_by_user_id, a.expires_at], "saved, and no longer expiring (§7.7)").toEqual([user, null]);
      expect((await saveStateOf(theirs.id)).saved_by_user_id, "the other keeps its saver").toBe(other);
    });

    it("matches the address case-folded (§7.7): typed in capitals, signed in lower case", async () => {
      const email = addressFor("case");
      const typed = await createTypedMatch(email.toUpperCase());
      expect((await saveStateOf(typed.id)).email, "premise: the row holds the capitals the guest typed").toBe(
        email.toUpperCase(),
      );
      const user = await account(email);

      expect(await saveQuickMatchesForVerifiedUser(user)).toEqual({
        savedByEmail: 1,
      });
      expect((await saveStateOf(typed.id)).saved_by_user_id).toBe(user);
    });

    it("Review Focus 5: no match on the address answers 0 and errors nothing; another address's match is untouched", async () => {
      const elsewhere = await createTypedMatch(addressFor("elsewhere"));
      const user = await account(addressFor("nomatch"));

      expect(await saveQuickMatchesForVerifiedUser(user)).toEqual({
        savedByEmail: 0,
      });
      expect((await saveStateOf(elsewhere.id)).saved_by_user_id).toBeNull();
      expect(logs.error).not.toHaveBeenCalled();
      expect(await savedEvents()).toEqual([]);
    });

    it("B19: an UNVERIFIED account saves nothing; the same account, once verified, saves it", async () => {
      const email = addressFor("unverified");
      const typed = await createTypedMatch(email);
      const user = await account(email, { verified: false });

      expect(await saveQuickMatchesForVerifiedUser(user)).toEqual({
        savedByEmail: 0,
      });
      expect((await saveStateOf(typed.id)).saved_by_user_id).toBeNull();

      await sql`update users set email_verified = true where id = ${user}`;
      expect(await saveQuickMatchesForVerifiedUser(user), "positive pair: verified, the same row is saved").toEqual({
        savedByEmail: 1,
      });
      expect((await saveStateOf(typed.id)).saved_by_user_id).toBe(user);
    });

    it("a deleted account saves nothing, even when the row carries its address", async () => {
      const email = addressFor("deleted");
      const typed = await createTypedMatch(email);
      const user = await account(email, { deleted: true });

      expect(await saveQuickMatchesForVerifiedUser(user)).toEqual({
        savedByEmail: 0,
      });
      expect((await saveStateOf(typed.id)).saved_by_user_id).toBeNull();
    });

    it("D13: an expired match the sweep has not reached stays unsaved and expired; an alive one on the same address is saved", async () => {
      const email = addressFor("expired");
      const dead = await createTypedMatch(email);
      const alive = await createTypedMatch(email);
      await expire(dead.id);
      const deadBefore = await saveStateOf(dead.id);
      const user = await account(email);

      expect(await saveQuickMatchesForVerifiedUser(user)).toEqual({
        savedByEmail: 1,
      });

      expect(await saveStateOf(dead.id), "never revived: not saved, its expiry untouched").toEqual(deadBefore);
      expect((await saveStateOf(alive.id)).saved_by_user_id).toBe(user);
    });

    it("the saved shape: no expiry, the reminder marked spent; a reminder already sent keeps its time", async () => {
      const email = addressFor("shape");
      const fresh = await createTypedMatch(email);
      const reminded = await createTypedMatch(email);
      const sentAt = new Date("2026-11-01T10:00:00Z");
      await sql`update quick_matches set reminder_sent_at = ${sentAt} where id = ${reminded.id}`; // the reminder already went out
      expect((await saveStateOf(fresh.id)).reminder_sent_at, "premise: a fresh match has had no reminder").toBeNull();
      const user = await account(email);

      expect(await saveQuickMatchesForVerifiedUser(user)).toEqual({
        savedByEmail: 2,
      });

      const f = await saveStateOf(fresh.id);
      expect(f.expires_at).toBeNull();
      expect(f.reminder_sent_at, "a saved match is never reminded (C2)").not.toBeNull();
      expect((await saveStateOf(reminded.id)).reminder_sent_at).toEqual(sentAt);
      // m9: the address the guest typed goes with the save, and the generated lower-case copy follows it.
      expect(await addressOf(fresh.id), "a saved match holds no address").toEqual(FORGOTTEN);
      expect(await addressOf(reminded.id)).toEqual(FORGOTTEN);
    });

    it("m9 in sequence: the save forgets the address, and a later match typed with it is still found by the next sign-in", async () => {
      const email = addressFor("forget");
      const first = await createTypedMatch(email.toUpperCase());
      expect(await addressOf(first.id), "premise: the row holds the address as typed, and its folded copy").toEqual({
        email: email.toUpperCase(),
        email_lower: email.toLowerCase(),
      });
      const user = await account(email);
      expect(await saveQuickMatchesForVerifiedUser(user)).toEqual({ savedByEmail: 1 });
      expect(await addressOf(first.id)).toEqual(FORGOTTEN);

      // The by-email path keys on the UNSAVED rows' address: a match typed with it afterwards is found and saved too.
      const second = await createTypedMatch(email);
      expect(await saveQuickMatchesForVerifiedUser(user)).toEqual({ savedByEmail: 1 });
      expect((await saveStateOf(second.id)).saved_by_user_id).toBe(user);
      expect(await addressOf(second.id)).toEqual(FORGOTTEN);
      // And the first stays the account's, its expiry still cleared.
      expect((await saveStateOf(first.id)).saved_by_user_id).toBe(user);
      expect((await saveStateOf(first.id)).expires_at).toBeNull();
    });

    it("a second sign-in saves nothing more and changes nothing (idempotent)", async () => {
      const email = addressFor("again");
      const typed = await createTypedMatch(email);
      const user = await account(email);
      expect(await saveQuickMatchesForVerifiedUser(user)).toEqual({
        savedByEmail: 1,
      });
      const first = await saveStateOf(typed.id);
      expect(await savedEvents(), "the first sign-in's one event").toHaveLength(1);
      ph.capture.mockClear();

      expect(await saveQuickMatchesForVerifiedUser(user)).toEqual({
        savedByEmail: 0,
      });
      expect(await saveStateOf(typed.id)).toEqual(first);
      expect(await savedEvents(), "no second event").toEqual([]);
    });

    it("a failing save never throws past the sign-in: logged, answered 0, nothing half-saved; the next sign-in saves it", async () => {
      const email = addressFor("fails");
      const typed = await createTypedMatch(email);
      const user = await account(email);
      cancel.fail = true;

      expect(await saveQuickMatchesForVerifiedUser(user)).toEqual({
        savedByEmail: 0,
      });
      expect(logs.error).toHaveBeenCalledTimes(1);
      expect((await saveStateOf(typed.id)).saved_by_user_id, "the save and its cancel are one transaction").toBeNull();
      expect(await savedEvents()).toEqual([]);

      cancel.fail = false;
      expect(await saveQuickMatchesForVerifiedUser(user)).toEqual({
        savedByEmail: 1,
      });
    });
  },
);

describe.skipIf(!HAS_DB)("saveQuickMatchForUser: the Save button's one match (C3)", () => {
  it("saves a match with no address typed for whoever presses; a second press is already_yours and changes nothing", async () => {
    const typed = await createTypedMatch(null);
    const user = await someone();

    expect(await saveQuickMatchForUser(user, typed.id)).toBe("saved");
    const first = await saveStateOf(typed.id);
    expect([first.saved_by_user_id, first.expires_at]).toEqual([user, null]);

    expect(await saveQuickMatchForUser(user, typed.id)).toBe("already_yours");
    expect(await saveStateOf(typed.id)).toEqual(first);
  });

  it("taken: another account's match is refused and keeps its saver", async () => {
    const typed = await createTypedMatch(addressFor("taken"));
    const saver = await someone();
    const late = await someone();
    expect(await saveQuickMatchForUser(saver, typed.id)).toBe("saved");
    const before = await saveStateOf(typed.id);

    expect(await saveQuickMatchForUser(late, typed.id)).toBe("taken");
    expect(await saveStateOf(typed.id)).toEqual(before);
  });

  it("saves a match typed with somebody else's address: the button needs no address (C3)", async () => {
    const typed = await createTypedMatch(addressFor("not-mine"));
    const presser = await someone();

    expect(await saveQuickMatchForUser(presser, typed.id)).toBe("saved");
    expect((await saveStateOf(typed.id)).saved_by_user_id).toBe(presser);
    // m9: the stranger's address is not kept on a match its presser now holds.
    expect(await addressOf(typed.id)).toEqual(FORGOTTEN);
  });

  it("gone: an expired match the sweep has not reached is never revived (D13)", async () => {
    const typed = await createTypedMatch(null);
    await expire(typed.id);
    const before = await saveStateOf(typed.id);
    const user = await someone();

    expect(await saveQuickMatchForUser(user, typed.id)).toBe("gone");
    expect(await saveStateOf(typed.id)).toEqual(before);
  });

  it("gone: no such match, and an id that is not a uuid, answer gone without a database error", async () => {
    const user = await someone();
    expect(await saveQuickMatchForUser(user, randomUUID())).toBe("gone");
    expect(await saveQuickMatchForUser(user, "not-a-uuid")).toBe("gone");
  });

  it("after the by-email save, the button on the same match answers already_yours", async () => {
    const email = addressFor("sequence");
    const typed = await createTypedMatch(email);
    const user = await account(email);
    expect(await saveQuickMatchesForVerifiedUser(user)).toEqual({
      savedByEmail: 1,
    });

    expect(await saveQuickMatchForUser(user, typed.id)).toBe("already_yours");
  });
});

describe.skipIf(!HAS_DB)("a save ends the match's queued reminder (D9), on the system org's tenant", () => {
  it("the by-email save cancels the reminder of every match it saved, once, with quick_match_saved, as the system org", async () => {
    const email = addressFor("cancel-email");
    const a = await createTypedMatch(email);
    const b = await createTypedMatch(email);
    const user = await account(email);

    await saveQuickMatchesForVerifiedUser(user);

    expect(cancel.calls).toEqual([
      {
        kind: REMINDER_KIND,
        refType: QUICK_MATCH_OUTBOX_REF_TYPE,
        refIds: [a.id, b.id].sort(),
        reason: SAVED_REASON,
        org: QUICK_MATCH_SYSTEM_ORG_ID,
      },
    ]);
  });

  it("the button's save cancels that one match's reminder, as the system org", async () => {
    const typed = await createTypedMatch(null);
    const user = await someone();

    expect(await saveQuickMatchForUser(user, typed.id)).toBe("saved");

    expect(cancel.calls).toEqual([
      {
        kind: REMINDER_KIND,
        refType: QUICK_MATCH_OUTBOX_REF_TYPE,
        refIds: [typed.id],
        reason: SAVED_REASON,
        org: QUICK_MATCH_SYSTEM_ORG_ID,
      },
    ]);
  });

  it("taken, gone and already_yours cancel nothing", async () => {
    const typed = await createTypedMatch(null);
    const saver = await someone();
    expect(await saveQuickMatchForUser(saver, typed.id)).toBe("saved");
    cancel.calls = [];

    expect(await saveQuickMatchForUser(saver, typed.id)).toBe("already_yours");
    expect(await saveQuickMatchForUser(await someone(), typed.id)).toBe("taken");
    expect(await saveQuickMatchForUser(saver, randomUUID())).toBe("gone");
    expect(cancel.calls).toEqual([]);
  });

  /** A queued reminder about `quickMatchId`, written by the real writer as the expiry sweep (plan 3 Task 2) writes it: the
   *  privileged pool, the system org's row (the tenant insert policy refuses an org-less one), the ref by the match's id. */
  async function queueReminder(quickMatchId: string, to: string): Promise<string> {
    const [row] = await sql<{ expires_at: Date }[]>`select expires_at from quick_matches where id = ${quickMatchId}`;
    return enqueueEmail(sql, {
      kind: REMINDER_KIND,
      refType: QUICK_MATCH_OUTBOX_REF_TYPE,
      refId: quickMatchId,
      orgId: QUICK_MATCH_SYSTEM_ORG_ID,
      to,
      subject: "QM save test reminder",
      html: "<p>reminder</p>",
      text: "reminder",
      transactional: false,
      expiresAt: expiryWithin(row!.expires_at),
    });
  }
  type MailState = { kind: string; status: string; last_error: string | null; cleared: boolean };
  const mailState = async (id: string): Promise<MailState> => {
    const [r] = await sql<MailState[]>`
      select kind, status, last_error, body_sealed is null as cleared from email_outbox where id = ${id}`;
    if (!r) throw new Error(`precondition: outbox row ${id} exists`);
    return r;
  };
  /** The link mail the create queued for this match (rig creates with an email queue one, plan 3 Task 1). */
  const linkMailOf = async (quickMatchId: string): Promise<string> => {
    const rows = await sql<{ id: string }[]>`
      select id from email_outbox where ref_type = ${QUICK_MATCH_OUTBOX_REF_TYPE} and ref_id = ${quickMatchId} and kind = 'quick_match_link'`;
    expect(rows, "premise: the create queued its one link mail").toHaveLength(1);
    return rows[0]!.id;
  };

  it("on the outbox row: the by-email save ends each saved match's queued reminder with quick_match_saved; the link mail and another match's reminder stay queued", async () => {
    const email = addressFor("row-email");
    const a = await createTypedMatch(email);
    const b = await createTypedMatch(email);
    const other = await createTypedMatch(addressFor("row-other"));
    const ra = await queueReminder(a.id, email);
    const rb = await queueReminder(b.id, email);
    const rOther = await queueReminder(other.id, addressFor("row-other-to"));
    const link = await linkMailOf(a.id);
    for (const id of [ra, rb, rOther, link]) {
      expect(await mailState(id), "premise: queued, with a body").toMatchObject({ status: "queued", cleared: false });
    }
    const user = await account(email);

    expect(await saveQuickMatchesForVerifiedUser(user)).toEqual({ savedByEmail: 2 });

    const ended: MailState = { kind: REMINDER_KIND, status: "expired", last_error: SAVED_REASON, cleared: true };
    expect(await mailState(ra)).toEqual(ended);
    expect(await mailState(rb)).toEqual(ended);
    expect((await mailState(rOther)).status, "another match's reminder is not this save's").toBe("queued");
    expect((await mailState(link)).status, "only the reminder kind is ended: the link mail stays").toBe("queued");
  });

  it("on the outbox row: the button's save ends that match's queued reminder; a second press ends nothing more", async () => {
    const typed = await createTypedMatch(addressFor("row-button"));
    const reminder = await queueReminder(typed.id, addressFor("row-button-to"));
    expect(await mailState(reminder), "premise: queued, with a body").toMatchObject({ status: "queued", cleared: false });
    const user = await someone();

    expect(await saveQuickMatchForUser(user, typed.id)).toBe("saved");
    const after = await mailState(reminder);
    expect(after).toEqual({ kind: REMINDER_KIND, status: "expired", last_error: SAVED_REASON, cleared: true });

    expect(await saveQuickMatchForUser(user, typed.id)).toBe("already_yours");
    expect(await mailState(reminder)).toEqual(after);
  });

  it("taken and gone end no reminder on the outbox row", async () => {
    const typed = await createTypedMatch(null);
    const saver = await someone();
    expect(await saveQuickMatchForUser(saver, typed.id)).toBe("saved");
    // A reminder queued after the save (the shape a race would leave): a refused press must not touch it.
    const late = await queueReminder(typed.id, addressFor("row-late"));
    expect(await saveQuickMatchForUser(await someone(), typed.id)).toBe("taken");

    const expired = await createTypedMatch(null);
    const reminder = await queueReminder(expired.id, addressFor("row-gone"));
    await expire(expired.id);
    expect(await saveQuickMatchForUser(saver, expired.id)).toBe("gone");

    expect((await mailState(late)).status).toBe("queued");
    expect((await mailState(reminder)).status).toBe("queued");
  });

  it("a reminder the save ends needs no hook run after it (the save drops cancelQueuedEmails' rows): the kind declares none", () => {
    // cancelQueuedEmails returns the rows it ended so a caller can run `afterEndedBadly` after its commit (cancel.ts). The save
    // drops them (quick-match-save.ts saveInTx) on this premise: nothing waits on a reminder's outcome, so the kind has no
    // ended-badly hook and no re-drive. A kind that gains one must also gain the call after the save's commit.
    expect(KIND_HOOKS[REMINDER_KIND], "the kind is registered").toBeDefined();
    expect(KIND_HOOKS[REMINDER_KIND].onEndedBadly, "no ended-badly hook for the reminder").toBeUndefined();
    expect(KIND_HOOKS[REMINDER_KIND].findUnapplied, "and no re-drive").toBeUndefined();
  });
});

describe.skipIf(!HAS_DB)("the by-email lookup is indexed (V493 quick_matches_unsaved_email_idx, plan 3 Amend T1 [B20])", () => {
  it("the save's own statement looks its address up in the index: that address's entries only, not a walk of every unsaved address", async () => {
    // With sequential scans off, a WHERE that cannot be an index condition (under RLS, `lower(email) = $1`) still uses the partial
    // index as a whole walk (its predicate holds), reading every unsaved address. A second unsaved address makes that walk read
    // more entries than a lookup of the one address alone; the lookup on email_lower reads exactly as many.
    const email = addressFor("index");
    const typed = await createTypedMatch(email);
    const bystander = await createTypedMatch(addressFor("index-bystander"));
    const user = await account(email);
    plan.scans = null;
    plan.entries = null;
    plan.yardstick = null;
    plan.address = email;
    plan.armed = true;
    try {
      expect(await saveQuickMatchesForVerifiedUser(user)).toEqual({ savedByEmail: 1 });
    } finally {
      plan.armed = false;
    }
    expect((await saveStateOf(typed.id)).saved_by_user_id, "premise: the probed save really saved").toBe(user);
    expect((await saveStateOf(bystander.id)).saved_by_user_id, "premise: the bystander is still unsaved, so in the index").toBeNull();
    expect(plan.scans, "the index exists and the save's WHERE can use it").not.toBeNull();
    expect(plan.scans!, "the save's lookup went through the index").toBeGreaterThan(0);
    expect(plan.yardstick!, "the yardstick lookup read the address's own entries").toBeGreaterThan(0);
    expect(plan.entries, "and read the one address's entries, as a lookup of it alone does: no other address's").toBe(plan.yardstick);
  });
});

describe.skipIf(!HAS_DB)(
  "one quick_match_saved event per saved match (D10), on the system org, carrying no address",
  () => {
    it("by email: one event per row, via email; by the button: one, via button; a refusal sends none", async () => {
      const email = addressFor("events");
      const a = await createTypedMatch(email);
      const b = await createTypedMatch(email);
      const user = await account(email);
      expect(await savedEvents(), "premise: the creates' own tail work ran, no save event in it").toEqual([]);
      await saveQuickMatchesForVerifiedUser(user);
      expect(sentSoFar(), "the sign-in returns before any event is sent").toEqual([]);
      expect(after.tasks, "one deferral carries both events").toHaveLength(1);

      const byEmail = await savedEvents();
      expect(byEmail.map((e) => e.properties?.quick_match_id).sort()).toEqual([a.id, b.id].sort());
      for (const e of byEmail) {
        expect(e).toEqual({
          event: SAVED_EVENT,
          distinctId: user,
          orgId: QUICK_MATCH_SYSTEM_ORG_ID,
          properties: { quick_match_id: expect.any(String), via: "email" },
        });
      }

      ph.capture.mockClear();
      const pressed = await createTypedMatch(null);
      expect(await savedEvents(), "premise: the create's own tail work ran").toEqual([]);
      expect(await saveQuickMatchForUser(user, pressed.id)).toBe("saved");
      expect([sentSoFar(), after.tasks.length], "the button answers before its event is sent").toEqual([[], 1]);
      expect(await savedEvents()).toEqual([
        {
          event: SAVED_EVENT,
          distinctId: user,
          orgId: QUICK_MATCH_SYSTEM_ORG_ID,
          properties: { quick_match_id: pressed.id, via: "button" },
        },
      ]);

      ph.capture.mockClear();
      expect(await saveQuickMatchForUser(await someone(), pressed.id)).toBe("taken");
      expect(await savedEvents()).toEqual([]);
    });
  },
);
