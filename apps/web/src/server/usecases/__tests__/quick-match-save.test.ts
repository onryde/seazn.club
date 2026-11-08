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
// THE REMINDER'S CANCEL (D9) is witnessed at its seam, not on an outbox row: the reminder kind (`quick_match_reminder`)
// does not exist yet. Plan 3 Task 1 adds it to OUTBOX_KINDS and to the database's kind CHECK, which refuses the row until
// then. So the cancel is wrapped below: every call is recorded with the tenant its handle runs as, and passed to the real
// `cancelQueuedEmails`. The tripwire at the end reds the day Task 1 adds the kind, and then owes the outbox-row read.
//
// Real Postgres required; skipped without DATABASE_URL.
import { randomBytes as kekBytes, randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.stubEnv("DEVICE_LINK_KEK", kekBytes(32).toString("hex")); // every create seals a home token

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

import { sql } from "@/lib/db";
import { QUICK_MATCH_SYSTEM_ORG_ID } from "@/lib/quick-match-constants";
import { OUTBOX_KINDS } from "@/server/email-outbox/constants";
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

  it("TRIPWIRE (owed to plan 3 Task 1): the reminder kind is not in the outbox vocabulary yet", () => {
    // When this reds, Task 1 has added `quick_match_reminder`: replace this case with the outbox-row read the brief owes
    // (enqueue a queued reminder for a match by its ref, save it by each path, read the row back `expired` with
    // last_error = quick_match_saved), and drop the cast in quick-match-save.ts. task-4-report.md, carry C1.
    expect((OUTBOX_KINDS as readonly string[]).includes(REMINDER_KIND)).toBe(false);
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
