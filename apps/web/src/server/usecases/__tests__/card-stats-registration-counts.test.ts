// RS004 W2b review finding 1: the competition overview's Registration pill
// derived its "total registered" count from `entrants`, and an `entrants`
// row only exists once an entry is MATERIALISED (registrations.ts's
// materialise(), called at submit for a free/auto/non-waitlisted entry, or
// at organiser approval otherwise). A paid entry awaiting manual approval,
// and every waitlisted entry, therefore read zero — undercounting exactly
// the registrations an organiser opens the hub to act on.
//
// `listDivisionCardStats`'s new `registered`/`awaiting_confirmation`
// columns count straight from `registrations.status` instead — still the
// SAME single query this page already runs (no second round trip). This
// file targets that query directly; the page's own arithmetic (summing
// per-division stats into the pill's badge props) is proven separately in
// c/[compSlug]/__tests__/registration-nav-entry-wiring.test.tsx against a
// mocked card-stats module. Real Postgres required; skipped without
// DATABASE_URL.
import { describe, expect, it, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { createEntrants } from "../entrants";
import { listDivisionCardStats } from "../card-stats";
import { seedOrg, asOwner, rig, seedRegistration } from "./_registration-fixtures";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

const SEED_SETTINGS = { fee_cents: 0, currency: "gbp", payment_method: "offline" as const };

describe.skipIf(!HAS_DB)(
  "card-stats: registered/awaiting_confirmation count from registrations.status, not entrants (W2b review finding 1)",
  () => {
    it("a manual-approval pending entry and a waitlisted entry are NOT zero — entrants alone (the pre-fix pill source) undercounts both", async () => {
      const { orgId, ownerId } = await seedOrg("pro");
      const owner = asOwner(orgId, ownerId);
      const { competition, division } = await rig(owner);

      // The one entry that reaches `entrants` under the OLD pill logic — an
      // organiser direct-add mirrors materialise()'s own effect on that
      // table (default status 'registered'); the query never joins entrants
      // back to registrations, so this row does not need to be the SAME
      // entry as the "confirmed" registration below to prove the count.
      await createEntrants(owner, division.id, [
        { kind: "individual", display_name: "Confirmed Entrant", seed: 1, members: [] },
      ]);

      await seedRegistration(competition.id, division.id, SEED_SETTINGS, {
        status: "confirmed",
        displayName: "Confirmed Entrant",
      });
      // Free entry under manual approval: materialise() has NOT run, so this
      // has no entrants row — exactly the "manual-approval pending entry"
      // finding 1's fixture calls for.
      await seedRegistration(competition.id, division.id, SEED_SETTINGS, {
        status: "pending",
        displayName: "Pending Entrant",
      });
      // Over capacity: also no entrants row yet.
      await seedRegistration(competition.id, division.id, SEED_SETTINGS, {
        status: "waitlisted",
        displayName: "Waitlisted Entrant",
      });

      const stats = await listDivisionCardStats(owner, competition.id);
      const s = stats.get(division.id);
      expect(s, JSON.stringify([...stats.entries()])).toBeTruthy();
      // The pre-fix pill value for this exact fixture — pinned so a
      // regression on the OLD field is visible too, not just the new one.
      expect(s!.entrants).toBe(1);
      expect(s!.registered).toBe(3);
      expect(s!.awaiting_confirmation).toBe(2);
    });

    it("a Stripe-paid entry awaiting manual approval counts as registered AND as awaiting confirmation — 'paid' is never treated as done, never as zero", async () => {
      const { orgId, ownerId } = await seedOrg("pro");
      const owner = asOwner(orgId, ownerId);
      const { competition, division } = await rig(owner);

      await seedRegistration(competition.id, division.id, SEED_SETTINGS, {
        status: "paid",
        displayName: "Paid Awaiting Approval",
      });

      const stats = await listDivisionCardStats(owner, competition.id);
      const s = stats.get(division.id)!;
      expect(s.entrants).toBe(0);
      expect(s.registered).toBe(1);
      expect(s.awaiting_confirmation).toBe(1);
    });

    it("never lets a terminal registration (rejected/withdrawn/expired) inflate the total", async () => {
      const { orgId, ownerId } = await seedOrg("pro");
      const owner = asOwner(orgId, ownerId);
      const { competition, division } = await rig(owner);

      await seedRegistration(competition.id, division.id, SEED_SETTINGS, {
        status: "confirmed",
        displayName: "Still Registered",
      });
      await seedRegistration(competition.id, division.id, SEED_SETTINGS, {
        status: "rejected",
        displayName: "Rejected",
      });
      await seedRegistration(competition.id, division.id, SEED_SETTINGS, {
        status: "withdrawn",
        displayName: "Withdrawn",
      });
      await seedRegistration(competition.id, division.id, SEED_SETTINGS, {
        status: "expired",
        displayName: "Expired " + randomUUID().slice(0, 6),
      });

      const stats = await listDivisionCardStats(owner, competition.id);
      const s = stats.get(division.id)!;
      expect(s.registered).toBe(1);
      expect(s.awaiting_confirmation).toBe(0);
    });
  },
);
