// Quick match plan 3, Task 4 (pre-flight D8, B13; spec §7.7 as amended 2026-11-08): deleting an account lets go of its
// quick matches. Deletion is a SOFT delete on main (the users row is anonymised, never removed), so the FK's
// `on delete set null` never fires: the deletion itself has to release them, in its own transaction, while the real
// address is still known.
//   - every match the account saved expires again 7 days after its LAST ACTIVITY (C1), so friends with the link keep
//     scoring until then; and it is saveable again;
//   - the account's address leaves every match it was typed on, whoever saved it;
//   - another account's saved match is untouched, and a refused deletion releases nothing.
//
// Driven through the REAL DELETE /api/users/me (real createSession on a cookie jar, real requireUser), real Postgres,
// quick matches made by the real create and saved by the real save. Stand-ins: `next/headers`, the limiter, Stripe, the
// outbox transport (the deletion notice is mailed after commit), PostHog. The expected expiry is the row's own
// `last_activity_at` plus the spec's 7 days, typed here; the activity is set 2 days back first, so "now + 7 days" (the
// wrong rule) cannot pass.
//
// Sport: not applicable; the quick match is the rig's one sport (its header says why).
// Real Postgres required; skipped without DATABASE_URL.
import { randomBytes as kekBytes } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.stubEnv("DEVICE_LINK_KEK", kekBytes(32).toString("hex")); // every quick match create seals a home token

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
import { resolveQuickMatchToken } from "@/server/usecases/quick-match-home";
import { saveQuickMatchForUser } from "@/server/usecases/quick-match-save";
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
