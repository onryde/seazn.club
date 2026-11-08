// Quick match plan 3, Task 4 (pre-flight D8, B13; spec §7.7 as amended 2026-11-08): deleting an account lets go of its
// quick matches. Deletion is a SOFT delete on main (the users row is anonymised, never removed), so the FK's
// `on delete set null` never fires: the deletion itself has to release them, in its own transaction, while the real
// address is still known.
//   - every match the account saved expires again 7 days after its LAST ACTIVITY (C1), so friends with the link keep
//     scoring until then; and it is saveable again;
//   - the account's address leaves every match it was typed on, whoever saved it;
//   - another account's saved match is untouched, and a refused deletion releases nothing;
//   - every quick match mail still QUEUED to the address (the link, the reminder) ends unsent (branch review B m4);
//   - and the whole lifecycle in one chain of real calls: sweep reminder → sign-in save → deletion → sweeps (m2).
//
// Driven through the REAL DELETE /api/users/me (real createSession on a cookie jar, real requireUser), real Postgres,
// quick matches made by the real create, saved by the real save and reminded by the real sweep (on its own `now`, the
// clock a test may pass it). Stand-ins: `next/headers`, the limiter, Stripe, the
// outbox transport (the deletion notice is mailed after commit), PostHog. The expected expiry is the row's own
// `last_activity_at` plus the spec's 7 days, typed here; the activity is set 2 days back first, so "now + 7 days" (the
// wrong rule) cannot pass.
//
// Sport: not applicable; the quick match is the rig's one sport (its header says why).
// Real Postgres required; skipped without DATABASE_URL.
import { randomBytes as kekBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.stubEnv("DEVICE_LINK_KEK", kekBytes(32).toString("hex")); // every quick match create seals a home token
vi.stubEnv("EMAIL_OUTBOX_KEK", kekBytes(32).toString("hex")); // a queued mail holds a sealed body, so "the end cleared it" can fail

vi.mock("@/lib/stripe", () => ({ getStripe: () => ({ subscriptions: { cancel: vi.fn(async () => ({})) } }) }));
vi.mock("@/lib/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rate-limit")>()),
  rateLimit: vi.fn(async () => {}),
}));
const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": "203.0.113.95" }),
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => void jar.set(name, value),
    delete: (name: string) => void jar.delete(name),
  }),
}));
vi.mock("@/server/email-outbox/transport", () => ({
  deliver: vi.fn(async () => ({ ok: true, providerId: "re_account_deletion_quick_match" })),
}));
vi.mock("@/lib/posthog-server", async (orig) => ({
  ...(await orig<typeof import("@/lib/posthog-server")>()),
  captureServer: vi.fn(async () => {}),
}));

import { sql } from "@/lib/db";
import { createSession } from "@/lib/auth";
import { createLoginLink } from "@/lib/login-link";
import { resolveOrCreateUser } from "@/lib/users";
import { POST as CONSUME } from "@/app/api/auth/magic-link/consume/route";
import { resolveQuickMatchToken } from "@/server/usecases/quick-match-home";
import { sweepQuickMatches, type QuickMatchSweepReport } from "@/server/usecases/quick-match-sweep";
import { saveQuickMatchForUser, saveQuickMatchesForVerifiedUser } from "@/server/usecases/quick-match-save";
import {
  addressFor,
  createTypedMatch,
  deleteMadeMatches,
  saveStateOf,
} from "@/server/usecases/__tests__/_quick-match-save-rig";
import { DELETE } from "../route";

const HAS_DB = !!process.env.DATABASE_URL;
const DAY_MS = 24 * 3600 * 1000;
/** C1: an unsaved quick match is kept this many days after its last activity. The spec's number, typed on purpose. */
const SPEC_EXPIRY_DAYS = 7;

const users: string[] = [];
async function account(email: string): Promise<string> {
  const [{ id }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified) values (${email}, 'QM leaver', true) returning id`;
  users.push(id);
  return id;
}

/** Delete `userId`'s account through the real route, signed in on the jar. */
async function deleteAccount(userId: string, confirm = "DELETE"): Promise<number> {
  jar.clear();
  await createSession(userId);
  const res = await DELETE(
    new Request("http://test.local/api/users/me", { method: "DELETE", body: JSON.stringify({ confirm }) }),
  );
  await res.text();
  return res.status;
}

/** The account deletion's reason on a row it ends (email-outbox/account-deletion.ts ACCOUNT_DELETED_REASON), typed here. */
const DELETED_REASON = "account_deleted";
/** The base the sweep builds the reminder's links on (the route passes `baseUrl(req)`). */
const BASE = "https://qm-account-deletion.test";
/** The sweep's clock 6.5 days on: a fresh match (7 days, C1) is then inside its reminder's 24 hours (C2) and not yet past it. */
const remindClock = () => new Date(Date.now() + 6.5 * DAY_MS);

type Mail = { kind: string; status: string; last_error: string | null; cleared: boolean };
/** Every outbox row about one quick match (its free-text ref, V470), by kind then age. */
const mailOf = (quickMatchId: string) => sql<Mail[]>`
  select kind, status, last_error, body_sealed is null as cleared from email_outbox
   where ref_type = 'quick_match' and ref_id = ${quickMatchId} order by kind, created_at, id`;
const QUEUED = { status: "queued", last_error: null, cleared: false };
const ENDED_BY_DELETION = { status: "expired", last_error: DELETED_REASON, cleared: true };

const ZERO: QuickMatchSweepReport = { checked: 0, rearmed: 0, reminded: 0, expired: 0, orphans: 0, failed: 0, deferred: 0 };

beforeAll(async () => {
  // The sign-in's landing imports these lazily; loaded once here, as the sign-in door suite does (auth/__tests__/_verify-link.ts).
  if (!HAS_DB) return;
  await import("@/server/usecases/me");
  await import("@/lib/activation");
});
beforeEach(() => jar.clear());
afterAll(async () => {
  if (!HAS_DB) return;
  await deleteMadeMatches();
  if (users.length > 0) {
    await sql`delete from organizations where created_by = any(${users}::uuid[])`;
    await sql`delete from subscriptions where owner_user_id = any(${users}::uuid[])`;
    await sql`delete from users where id = any(${users}::uuid[])`;
  }
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("DELETE /api/users/me lets go of the account's quick matches (D8)", () => {
  it("re-arms what it saved from the last activity, removes its address everywhere, and leaves another's match alone", async () => {
    const email = addressFor("leaver");
    const leaver = await account(email);
    const stranger = await account(addressFor("stranger"));
    const other = await account(addressFor("other"));

    const kept = await createTypedMatch(null);
    expect(await saveQuickMatchForUser(leaver, kept.id)).toBe("saved");
    await sql`update quick_matches set last_activity_at = now() - interval '2 days' where id = ${kept.id}`;
    const typedOnly = await createTypedMatch(email.toUpperCase()); // typed with the address, in capitals, unsaved
    const typedSavedByStranger = await createTypedMatch(email);
    expect(await saveQuickMatchForUser(stranger, typedSavedByStranger.id)).toBe("saved");
    const othersMatch = await createTypedMatch(addressFor("others-address"));
    expect(await saveQuickMatchForUser(other, othersMatch.id)).toBe("saved");
    const othersBefore = await saveStateOf(othersMatch.id);
    expect((await saveStateOf(kept.id)).reminder_sent_at, "premise: the save marked its reminder sent").not.toBeNull();

    expect(await deleteAccount(leaver)).toBe(200);

    const k = await saveStateOf(kept.id);
    expect(k.saved_by_user_id, "no longer the deleted account's").toBeNull();
    expect(k.expires_at?.getTime(), "7 days after its last activity (C1)").toBe(
      k.last_activity_at.getTime() + SPEC_EXPIRY_DAYS * DAY_MS,
    );
    expect(k.reminder_sent_at, "released, it can get its reminder again").toBeNull();
    expect(await resolveQuickMatchToken(kept.token), "friends with the link can still open it").not.toBeNull();

    const t = await saveStateOf(typedOnly.id);
    expect([t.email, t.saved_by_user_id], "the address is gone; nothing else changed").toEqual([null, null]);
    const s = await saveStateOf(typedSavedByStranger.id);
    expect([s.email, s.saved_by_user_id], "the address is gone, the stranger keeps it").toEqual([null, stranger]);
    expect(s.reminder_sent_at, "the stranger's save still holds its reminder off").not.toBeNull();
    expect(await saveStateOf(othersMatch.id), "another account's match is untouched").toEqual(othersBefore);

    // In sequence: the released match is anybody's to save again.
    expect(await saveQuickMatchForUser(other, kept.id)).toBe("saved");
  });

  it("m9: a match saved by the sign-in holds no address, and the deletion still releases it (by its saver, not its address)", async () => {
    const email = addressFor("forgotten");
    const leaver = await account(email);
    const typed = await createTypedMatch(email);
    expect(await saveQuickMatchesForVerifiedUser(leaver)).toEqual({ savedByEmail: 1 });
    await sql`update quick_matches set last_activity_at = now() - interval '2 days' where id = ${typed.id}`;
    const saved = await saveStateOf(typed.id);
    expect([saved.saved_by_user_id, saved.email], "premise: saved by the leaver, and its address already forgotten").toEqual([
      leaver,
      null,
    ]);

    expect(await deleteAccount(leaver)).toBe(200);

    const r = await saveStateOf(typed.id);
    expect(r.saved_by_user_id, "released: found by its saver, with no address left to find it by").toBeNull();
    expect(r.expires_at?.getTime(), "7 days after its last activity (C1)").toBe(r.last_activity_at.getTime() + SPEC_EXPIRY_DAYS * DAY_MS);
    expect(r.reminder_sent_at).toBeNull();
    expect(await resolveQuickMatchToken(typed.token), "alive for friends with the link").not.toBeNull();
  });

  it("m4: every quick match mail still queued to the address ends unsent (link and reminder, case-folded, whoever holds the match); another address's stays", async () => {
    const email = addressFor("m4");
    const leaver = await account(email);
    const typed = await createTypedMatch(email.toUpperCase()); // typed in capitals: its link mail is queued to them
    const other = await createTypedMatch(addressFor("m4-other"));
    // A match typed with the address and saved by a stranger: the save forgot the address (m9), its link mail did not.
    const keptByStranger = await createTypedMatch(email);
    expect(await saveQuickMatchForUser(await account(addressFor("m4-stranger")), keptByStranger.id)).toBe("saved");
    // The real sweep queues the two unsaved matches' reminders.
    expect(await sweepQuickMatches({ baseUrl: BASE, now: remindClock(), onlyIds: [typed.id, other.id, keptByStranger.id] })).toMatchObject({
      reminded: 2,
      failed: 0,
    });
    const link = (m: Mail) => m.kind === "quick_match_link";
    expect(await mailOf(typed.id), "premise: its link and its reminder are queued").toEqual([
      { kind: "quick_match_link", ...QUEUED },
      { kind: "quick_match_reminder", ...QUEUED },
    ]);
    expect((await mailOf(keptByStranger.id)).filter(link), "premise: the stranger's match's link mail is queued").toEqual([
      { kind: "quick_match_link", ...QUEUED },
    ]);
    const othersBefore = await mailOf(other.id);
    expect(othersBefore, "premise: another address's link and reminder are queued").toEqual([
      { kind: "quick_match_link", ...QUEUED },
      { kind: "quick_match_reminder", ...QUEUED },
    ]);

    expect(await deleteAccount(leaver)).toBe(200);

    expect(await mailOf(typed.id), "ended on the outbox's own path, with the deletion's reason, body gone").toEqual([
      { kind: "quick_match_link", ...ENDED_BY_DELETION },
      { kind: "quick_match_reminder", ...ENDED_BY_DELETION },
    ]);
    expect((await mailOf(keptByStranger.id)).filter(link), "found by the address it is queued to, not the match's").toEqual([
      { kind: "quick_match_link", ...ENDED_BY_DELETION },
    ]);
    expect(await mailOf(other.id), "another address's mail is not this deletion's").toEqual(othersBefore);
  });

  it("m2, the lifecycle in one chain of REAL calls: the sweep reminds, the sign-in saves, the deletion releases, the sweeps judge again", async () => {
    // No row and no SQL write is made by hand from here: the match by the real create, the account by the real passwordless
    // sign-up (`resolveOrCreateUser`, unverified), the reminder by the real sweep on its own clock, the save by the real
    // magic-link door, the release by the real DELETE. SQL below only reads.
    const email = addressFor("chain");
    const typed = await createTypedMatch(email);
    const created = await saveStateOf(typed.id);
    expect(await mailOf(typed.id), "the create queued its link mail").toEqual([{ kind: "quick_match_link", ...QUEUED }]);

    // 1. The sweep, 6.5 days on: inside the reminder's 24 hours (C2), not yet past the 7 days (C1). ONE reminder.
    const clock = remindClock();
    expect(await sweepQuickMatches({ baseUrl: BASE, now: clock, onlyIds: [typed.id] })).toEqual({ ...ZERO, checked: 1, reminded: 1 });
    expect(await saveStateOf(typed.id), "claimed: the stamp is the run's clock; nothing else moved").toEqual({
      ...created,
      reminder_sent_at: clock,
    });
    expect(await mailOf(typed.id)).toEqual([
      { kind: "quick_match_link", ...QUEUED },
      { kind: "quick_match_reminder", ...QUEUED },
    ]);

    // 2. The person signs up and signs in through the magic link: the door saves the match typed with the address.
    const userId = await resolveOrCreateUser(email);
    if (!userId) throw new Error("precondition: the passwordless sign-up made an account");
    users.push(userId);
    const signIn = await CONSUME(
      new Request("http://test.local/api/auth/magic-link/consume", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: await createLoginLink(userId) }),
      }),
    );
    expect(signIn.status, await signIn.clone().text()).toBe(200);
    expect(await saveStateOf(typed.id), "saved: no expiry, no address (m9), the reminder's stamp kept").toEqual({
      ...created,
      saved_by_user_id: userId,
      email: null,
      expires_at: null,
      reminder_sent_at: clock,
    });
    expect(await mailOf(typed.id), "the save ended the queued reminder (D9); the link mail is not a reminder").toEqual([
      { kind: "quick_match_link", ...QUEUED },
      { kind: "quick_match_reminder", status: "expired", last_error: "quick_match_saved", cleared: true },
    ]);

    // 3. The account is deleted: the match is released, and the mail still queued to the address ends (m4).
    expect(await deleteAccount(userId)).toBe(200);
    const released = await saveStateOf(typed.id);
    expect(released, "released: unsaved, 7 days after its last activity (C1), the reminder owed again, still no address").toEqual({
      ...created,
      expires_at: new Date(created.last_activity_at.getTime() + SPEC_EXPIRY_DAYS * DAY_MS),
      email: null,
      saved_by_user_id: null,
      reminder_sent_at: null,
    });
    expect(await mailOf(typed.id)).toEqual([
      { kind: "quick_match_link", ...ENDED_BY_DELETION },
      { kind: "quick_match_reminder", status: "expired", last_error: "quick_match_saved", cleared: true },
    ]);
    expect(await resolveQuickMatchToken(typed.token), "friends with the link can still open it").not.toBeNull();

    // 4. The sweep again, on the same clock: alive, and no address left to remind (m9), so nothing is queued.
    expect(await sweepQuickMatches({ baseUrl: BASE, now: clock, onlyIds: [typed.id] })).toEqual({ ...ZERO, checked: 1 });
    expect(await saveStateOf(typed.id)).toEqual(released);
    expect(await mailOf(typed.id), "no second reminder").toHaveLength(2);

    // 5. And once the released expiry has passed, the sweep deletes it with its mail (§7.8).
    const past = new Date(released.expires_at!.getTime() + 60_000);
    expect(await sweepQuickMatches({ baseUrl: BASE, now: past, onlyIds: [typed.id] })).toEqual({ ...ZERO, checked: 1, expired: 1 });
    expect(await sql`select 1 from quick_matches where id = ${typed.id}`).toHaveLength(0);
    expect(await mailOf(typed.id)).toHaveLength(0);
  });

  it("a refused deletion (no confirmation) releases nothing", async () => {
    const email = addressFor("stays");
    const stays = await account(email);
    const kept = await createTypedMatch(email);
    expect(await saveQuickMatchForUser(stays, kept.id)).toBe("saved");
    const before = await saveStateOf(kept.id);

    expect(await deleteAccount(stays, "nope")).toBe(400);

    expect(await saveStateOf(kept.id)).toEqual(before);
  });
});
