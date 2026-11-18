// Registration defects item 1 (2026-11-18): an organiser's manual "Promote from waitlist" overfilled a division (driven: a division of
// 2 read "3 of 2 registered"), because `promoteOldestWaitlisted` trusts its caller that a place is free. Required behaviour:
//   - at or over the division's OWN capacity: refused 409 PROMOTE_OVER_CAPACITY unless the request confirms (`confirmOverCapacity`);
//   - at the PLAN's per-division entrant limit (getLimit, add-on bonus included; null = unlimited): refused 422 PROMOTE_PLAN_LIMIT,
//     confirmed or not;
//   - an AUTOMATIC promotion (a withdrawal freeing a place) is unchanged.
// Entries are seeded as rows in the statuses under test; the plan limit is read back from the entitlement resolver (`getLimit`) as the
// premise of each case, never typed into an expectation. Another sport: N/A - registration capacity is sport-agnostic (one generic
// division per test).
import { describe, expect, it } from "vitest";

import { sql } from "@/lib/db";
import { getLimit, invalidateOrgEntitlements } from "@/lib/entitlements";
import { walletIdFor } from "@/lib/credits";
import { PROMOTE_OVER_CAPACITY_CODE, PROMOTE_PLAN_LIMIT_CODE } from "@/lib/registration-promote";
import { approveRegistration, promoteFromWaitlist, withdrawRegistration } from "../registration-approval";
import {
  confirmRegistration,
  confirmRegistrationWaived,
  markRegistrationPaidOffline,
  putRegistrationSettings,
  type RegistrationRow,
} from "../registrations";
import { SETTINGS_BASE, asOwner, rig, seedOrg, seedRegistration } from "./_registration-fixtures";

const HAS_DB = !!process.env.DATABASE_URL;
const PLAN_KEY = "entrants.per_division.max";
const FEES = { fee_cents: 0, currency: "gbp", payment_method: "offline" as const };

async function setup(o: { capacity: number | null; planLimit?: number | null; approval?: "manual" | "auto" }) {
  const { orgId, ownerId } = await seedOrg("pro");
  const owner = asOwner(orgId, ownerId);
  const { competition, division } = await rig(owner);
  await putRegistrationSettings(owner, division.id, { ...SETTINGS_BASE, payment_method: "offline", fee_cents: 0, capacity: o.capacity });
  // Manual approval (the default): a promoted entry lands `pending` and holds a place, with no seat gate or entrant in the way of the
  // count. `approval: "auto"` is the other path (M4): a free promotion then CONFIRMS inline and seats an entrant.
  await sql`update registration_settings set approval = ${o.approval ?? "manual"} where division_id = ${division.id}`;
  if (o.planLimit !== undefined) {
    // The per-division limit lowered (or lifted) after capacity was saved: the production shape of a plan tighter than capacity.
    await sql`
      insert into org_entitlement_overrides (org_id, feature_key, int_value, reason)
      values (${orgId}, ${PLAN_KEY}, ${o.planLimit}, 'test - registration defects item 1')`;
    await invalidateOrgEntitlements(orgId);
  }
  const seed = async (status: RegistrationRow["status"], name: string, over: { freeAgent?: boolean } = {}) => {
    const { registration } = await seedRegistration(competition.id, division.id, FEES, { status, displayName: name });
    if (over.freeAgent) await sql`update registrations set free_agent = true where id = ${registration.id}`;
    return registration.id;
  };
  const fill = async (n: number, status: RegistrationRow["status"] = "confirmed") => {
    for (let i = 0; i < n; i++) await seed(status, `Holder ${i + 1}`);
  };
  const statusOf = async (id: string) => (await sql<{ status: string }[]>`select status from registrations where id = ${id}`)[0]!.status;
  const promotedEvents = async (id: string) =>
    (
      await sql<{ n: number }[]>`
        select count(*)::int as n from competition_events
        where type = 'registration.promoted' and payload->>'registration_id' = ${id}`
    )[0]!.n;
  const holders = async () =>
    (
      await sql<{ n: number }[]>`
        select count(*)::int as n from registrations
        where division_id = ${division.id} and status in ('pending','paid','confirmed') and free_agent = false`
    )[0]!.n;
  const planLimit = () => getLimit(orgId, PLAN_KEY, competition.id);
  return { orgId, owner, competition, division, seed, fill, statusOf, promotedEvents, holders, planLimit };
}

describe.skipIf(!HAS_DB)("promoteFromWaitlist - the organiser's room check (registration defects item 1)", () => {
  it("under capacity: promotes with no confirmation", async () => {
    const t = await setup({ capacity: 3, planLimit: null });
    await t.fill(2);
    const waiting = await t.seed("waitlisted", "Waiting");
    const promoted = await promoteFromWaitlist(t.owner, t.division.id, { registrationId: waiting });
    expect(promoted!.status).toBe("pending");
    expect(await t.holders()).toBe(3);
    expect(await t.promotedEvents(waiting)).toBe(1);
  });

  it("at capacity, no confirmation: refused 409 and NOTHING is written", async () => {
    const t = await setup({ capacity: 2, planLimit: null });
    await t.fill(2);
    const waiting = await t.seed("waitlisted", "Waiting");
    await expect(promoteFromWaitlist(t.owner, t.division.id, { registrationId: waiting })).rejects.toMatchObject({
      status: 409,
      code: PROMOTE_OVER_CAPACITY_CODE,
      extra: { capacity: 2, taken: 2 },
    });
    expect(await t.statusOf(waiting), "the refused entry is still waitlisted").toBe("waitlisted");
    expect(await t.promotedEvents(waiting), "no promoted ledger row").toBe(0);
    expect(await t.holders()).toBe(2);
  });

  it("at capacity, WITH confirmation: promotes (the organiser chose to overfill)", async () => {
    const t = await setup({ capacity: 2, planLimit: null });
    await t.fill(2);
    const waiting = await t.seed("waitlisted", "Waiting");
    const promoted = await promoteFromWaitlist(t.owner, t.division.id, { registrationId: waiting, confirmOverCapacity: true });
    expect(promoted!.status).toBe("pending");
    expect(await t.holders(), "the division is now over its capacity, on purpose").toBe(3);
    expect(await t.promotedEvents(waiting)).toBe(1);
  });

  it("already OVER capacity (a prior confirmed overfill): refused without confirmation, allowed with it", async () => {
    const t = await setup({ capacity: 1, planLimit: null });
    await t.fill(3);
    const waiting = await t.seed("waitlisted", "Waiting");
    await expect(promoteFromWaitlist(t.owner, t.division.id, { registrationId: waiting })).rejects.toMatchObject({ status: 409 });
    expect(await t.statusOf(waiting)).toBe("waitlisted");
    await promoteFromWaitlist(t.owner, t.division.id, { registrationId: waiting, confirmOverCapacity: true });
    expect(await t.holders()).toBe(4);
  });

  it("at the PLAN limit: refused 422 even WITH confirmation, and the message states the limit read from the entitlement", async () => {
    const t = await setup({ capacity: 10, planLimit: 2 });
    const limit = await t.planLimit();
    expect(limit, "premise: the resolver reads the plan limit as the row says").toBe(2);
    await t.fill(limit!);
    const waiting = await t.seed("waitlisted", "Waiting");
    const err = await promoteFromWaitlist(t.owner, t.division.id, { registrationId: waiting, confirmOverCapacity: true }).catch((e) => e);
    expect(err).toMatchObject({ status: 422, code: PROMOTE_PLAN_LIMIT_CODE, extra: { limit, taken: limit } });
    expect(String(err.message)).toContain(String(limit));
    expect(await t.statusOf(waiting)).toBe("waitlisted");
    expect(await t.promotedEvents(waiting)).toBe(0);
    // ...and without the confirmation the PLAN is what answers, not the capacity prompt (capacity 10 is nowhere near full).
    await expect(promoteFromWaitlist(t.owner, t.division.id, { registrationId: waiting })).rejects.toMatchObject({
      status: 422,
      code: PROMOTE_PLAN_LIMIT_CODE,
    });
  });

  it("the plan limit counts the add-on bonus getLimit adds (a size pack lifts it, so the promotion passes at the BASE)", async () => {
    const t = await setup({ capacity: null, planLimit: 2 });
    const walletId = await walletIdFor(t.orgId);
    await sql`
      insert into org_addons (wallet_id, target_org_id, target_competition_id, feature_key, delta_each, qty, status)
      values (${walletId}, ${t.orgId}, ${t.competition.id}, ${PLAN_KEY}, 1, 1, 'active')`;
    const limit = await t.planLimit();
    expect(limit, "premise: base 2 plus the pack's 1").toBe(3);
    await t.fill(2);
    const waiting = await t.seed("waitlisted", "Waiting");
    expect((await promoteFromWaitlist(t.owner, t.division.id, { registrationId: waiting }))!.status).toBe("pending");
    // The third place is the last the bonus buys: one more is refused.
    const more = await t.seed("waitlisted", "One too many");
    await expect(promoteFromWaitlist(t.owner, t.division.id, { registrationId: more })).rejects.toMatchObject({
      status: 422,
      code: PROMOTE_PLAN_LIMIT_CODE,
    });
  });

  it("blank capacity under a finite plan: the plan alone binds (never 'uncapped')", async () => {
    const t = await setup({ capacity: null, planLimit: 2 });
    const limit = (await t.planLimit())!;
    await t.fill(limit - 1);
    const first = await t.seed("waitlisted", "First waiting");
    expect((await promoteFromWaitlist(t.owner, t.division.id, { registrationId: first }))!.status).toBe("pending");
    const second = await t.seed("waitlisted", "Second waiting");
    await expect(promoteFromWaitlist(t.owner, t.division.id, { registrationId: second })).rejects.toMatchObject({
      status: 422,
      code: PROMOTE_PLAN_LIMIT_CODE,
    });
    expect(await t.holders(), "the plan limit was never exceeded").toBe(limit);
  });

  it("an UNLIMITED plan and blank capacity: nothing caps the promotion, however full", async () => {
    const t = await setup({ capacity: null, planLimit: null });
    expect(await t.planLimit(), "premise: unlimited").toBeNull();
    await t.fill(6);
    const waiting = await t.seed("waitlisted", "Waiting");
    expect((await promoteFromWaitlist(t.owner, t.division.id, { registrationId: waiting }))!.status).toBe("pending");
    expect(await t.holders()).toBe(7);
  });

  it("an unlimited plan does not lift the DIVISION's own capacity: still needs the confirmation", async () => {
    const t = await setup({ capacity: 1, planLimit: null });
    await t.fill(1);
    const waiting = await t.seed("waitlisted", "Waiting");
    await expect(promoteFromWaitlist(t.owner, t.division.id, { registrationId: waiting })).rejects.toMatchObject({
      status: 409,
      code: PROMOTE_OVER_CAPACITY_CODE,
    });
  });

  it("sequence: a second promote right after the first - a replay of the same entry is a no-op, a different one is refused", async () => {
    const t = await setup({ capacity: 2, planLimit: null });
    await t.fill(1);
    const a = await t.seed("waitlisted", "A");
    const b = await t.seed("waitlisted", "B");
    expect((await promoteFromWaitlist(t.owner, t.division.id, { registrationId: a }))!.status).toBe("pending");
    expect(await t.holders(), "the first promotion filled the division").toBe(2);
    // Replay of the SAME entry: it already holds its place, so there is nothing to confirm and nothing to promote.
    const replay = await promoteFromWaitlist(t.owner, t.division.id, { registrationId: a });
    expect(replay!.status).toBe("pending");
    expect(await t.promotedEvents(a), "still one promotion, not two").toBe(1);
    // A DIFFERENT entry now meets a full division.
    await expect(promoteFromWaitlist(t.owner, t.division.id, { registrationId: b })).rejects.toMatchObject({ status: 409 });
    expect(await t.statusOf(b)).toBe("waitlisted");
    await promoteFromWaitlist(t.owner, t.division.id, { registrationId: b, confirmOverCapacity: true });
    expect(await t.holders()).toBe(3);
  });

  it("concurrency: two promotions racing for the last place - exactly one passes, the other is refused", async () => {
    const t = await setup({ capacity: 2, planLimit: null });
    await t.fill(1);
    const a = await t.seed("waitlisted", "A");
    const b = await t.seed("waitlisted", "B");
    const results = await Promise.allSettled([
      promoteFromWaitlist(t.owner, t.division.id, { registrationId: a }),
      promoteFromWaitlist(t.owner, t.division.id, { registrationId: b }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(await t.holders(), "capacity 2 was not exceeded").toBe(2);
  });

  it("a solo sign-up (free_agent) holds no TEAM place: it does not fill the division", async () => {
    const t = await setup({ capacity: 1, planLimit: null });
    const solo = await t.seed("confirmed", "Solo", { freeAgent: true });
    expect(await t.holders(), "premise: the solo is not a team place").toBe(0);
    const waiting = await t.seed("waitlisted", "Team waiting");
    expect((await promoteFromWaitlist(t.owner, t.division.id, { registrationId: waiting }))!.status).toBe("pending");
    expect(await t.statusOf(solo)).toBe("confirmed");
    // ...and the team entry now DOES fill it: the next one needs the confirmation.
    const next = await t.seed("waitlisted", "Next");
    await expect(promoteFromWaitlist(t.owner, t.division.id, { registrationId: next })).rejects.toMatchObject({ status: 409 });
  });

  it("promoting a waitlisted SOLO takes no team place, so a full division does not stop it", async () => {
    const t = await setup({ capacity: 1, planLimit: null });
    await t.fill(1);
    const waitingSolo = await t.seed("waitlisted", "Waiting solo", { freeAgent: true });
    expect((await promoteFromWaitlist(t.owner, t.division.id, { registrationId: waitingSolo }))!.id).toBe(waitingSolo);
    expect(await t.holders(), "no team place was taken").toBe(1);
  });

  it("withdrawn, rejected and expired entries free their place: they are not counted", async () => {
    const t = await setup({ capacity: 1, planLimit: null });
    await t.seed("withdrawn", "Gone");
    await t.seed("rejected", "No");
    await t.seed("expired", "Late");
    expect(await t.holders(), "premise: nothing holds a place").toBe(0);
    const waiting = await t.seed("waitlisted", "Waiting");
    expect((await promoteFromWaitlist(t.owner, t.division.id, { registrationId: waiting }))!.status).toBe("pending");
  });

  it("oldest-first (no id) is guarded the same way - and an EMPTY queue on a full division is still 'nobody', not a refusal", async () => {
    const t = await setup({ capacity: 1, planLimit: null });
    await t.fill(1);
    expect(await promoteFromWaitlist(t.owner, t.division.id), "empty queue: null, not over-capacity").toBeNull();
    const waiting = await t.seed("waitlisted", "Waiting");
    await expect(promoteFromWaitlist(t.owner, t.division.id)).rejects.toMatchObject({ status: 409, code: PROMOTE_OVER_CAPACITY_CODE });
    expect(await t.statusOf(waiting)).toBe("waitlisted");
    expect((await promoteFromWaitlist(t.owner, t.division.id, { confirmOverCapacity: true }))!.id).toBe(waiting);
  });

  it("AUTOMATIC promotion is unchanged: a withdrawal on a full division still promotes the next in line with no confirmation", async () => {
    const t = await setup({ capacity: 1, planLimit: null });
    const holder = await t.seed("confirmed", "Holder");
    const waiting = await t.seed("waitlisted", "Waiting");
    await withdrawRegistration(t.owner, holder);
    expect(await t.statusOf(holder)).toBe("withdrawn");
    expect(await t.statusOf(waiting), "the freed place went to the head of the queue").toBe("pending");
    expect(await t.holders(), "still within capacity").toBe(1);
  });

  it("no registration_settings row at all (empty input): no capacity to confirm, but the plan limit still refuses", async () => {
    const { orgId, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);
    await sql`
      insert into org_entitlement_overrides (org_id, feature_key, int_value, reason)
      values (${orgId}, ${PLAN_KEY}, 1, 'test - registration defects item 1')`;
    await invalidateOrgEntitlements(orgId);
    expect(await getLimit(orgId, PLAN_KEY, competition.id), "premise: the plan limit is the row's").toBe(1);
    const first = await seedRegistration(competition.id, division.id, FEES, { status: "waitlisted", displayName: "Bare 1" });
    expect((await promoteFromWaitlist(owner, division.id, { registrationId: first.registration.id }))!.status).toBe("pending");
    const second = await seedRegistration(competition.id, division.id, FEES, { status: "waitlisted", displayName: "Bare 2" });
    await expect(promoteFromWaitlist(owner, division.id, { registrationId: second.registration.id })).rejects.toMatchObject({
      status: 422,
      code: PROMOTE_PLAN_LIMIT_CODE,
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Fix round 1, I1: the OTHER doors from outside a place-holding status into one. `confirmRegistration` and `confirmRegistrationWaived`
// (POST /registrations/{id}/confirm and /waive) both accept a `waitlisted` entry and seat it; before the guard they did so on a full
// division with no check at all (reachable through the API, no console button). Same rule as Promote: the division's own capacity needs
// the confirmation, the plan limit never lifts.
// ---------------------------------------------------------------------------------------------------------------------------------
const DOORS = [
  ["confirmRegistration", confirmRegistration],
  ["confirmRegistrationWaived", confirmRegistrationWaived],
] as const;

describe.skipIf(!HAS_DB)("confirm / waive of a waitlisted entry - the same room check as Promote (fix round 1 I1)", () => {
  for (const [name, door] of DOORS) {
    it(`${name}: under capacity seats the entry with no confirmation`, async () => {
      const t = await setup({ capacity: 3, planLimit: null });
      await t.fill(2);
      const waiting = await t.seed("waitlisted", "Waiting");
      expect((await door(t.owner, waiting)).status).toBe("confirmed");
      expect(await t.holders()).toBe(3);
    });

    it(`${name}: at capacity, no confirmation: refused 409 PROMOTE_OVER_CAPACITY and nothing is written`, async () => {
      const t = await setup({ capacity: 2, planLimit: null });
      await t.fill(2);
      const waiting = await t.seed("waitlisted", "Waiting");
      await expect(door(t.owner, waiting)).rejects.toMatchObject({
        status: 409,
        code: PROMOTE_OVER_CAPACITY_CODE,
        extra: { capacity: 2, taken: 2 },
      });
      expect(await t.statusOf(waiting)).toBe("waitlisted");
      expect(await t.holders()).toBe(2);
      const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from registrations where id = ${waiting} and entrant_id is not null`;
      expect(n, "no entrant was seated").toBe(0);
    });

    it(`${name}: at capacity WITH confirmation seats it (the organiser chose to overfill)`, async () => {
      const t = await setup({ capacity: 2, planLimit: null });
      await t.fill(2);
      const waiting = await t.seed("waitlisted", "Waiting");
      expect((await door(t.owner, waiting, { confirmOverCapacity: true })).status).toBe("confirmed");
      expect(await t.holders()).toBe(3);
    });

    it(`${name}: at the PLAN limit refused 422 PROMOTE_PLAN_LIMIT even with confirmation`, async () => {
      const t = await setup({ capacity: 10, planLimit: 2 });
      const limit = (await t.planLimit())!;
      await t.fill(limit);
      const waiting = await t.seed("waitlisted", "Waiting");
      await expect(door(t.owner, waiting, { confirmOverCapacity: true })).rejects.toMatchObject({
        status: 422,
        code: PROMOTE_PLAN_LIMIT_CODE,
        extra: { limit, taken: limit },
      });
      expect(await t.statusOf(waiting)).toBe("waitlisted");
    });

    it(`${name}: a waitlisted SOLO takes no team place, so a full division does not stop it`, async () => {
      const t = await setup({ capacity: 1, planLimit: null });
      await t.fill(1);
      const solo = await t.seed("waitlisted", "Solo", { freeAgent: true });
      expect((await door(t.owner, solo)).status).toBe("confirmed");
      expect(await t.holders()).toBe(1);
    });

    it(`${name}: a PENDING entry already holds its place, so confirming it on a full division needs no confirmation`, async () => {
      const t = await setup({ capacity: 1, planLimit: null });
      const pending = await t.seed("pending", "Pending holder");
      expect(await t.holders(), "premise: the division is full by this very entry").toBe(1);
      expect((await door(t.owner, pending)).status).toBe("confirmed");
    });

    it(`${name}: sequence - the second call after a refusal and a confirmed retry is an idempotent no-op`, async () => {
      const t = await setup({ capacity: 1, planLimit: null });
      await t.fill(1);
      const waiting = await t.seed("waitlisted", "Waiting");
      await expect(door(t.owner, waiting)).rejects.toMatchObject({ status: 409 });
      await door(t.owner, waiting, { confirmOverCapacity: true });
      expect((await door(t.owner, waiting)).status, "already confirmed: no second refusal").toBe("confirmed");
      expect(await t.holders()).toBe(2);
    });
  }

  it("confirmRegistration: an EXPIRED entry is not a holder either - confirming it again is a new place, guarded the same way", async () => {
    const t = await setup({ capacity: 1, planLimit: null });
    await t.fill(1);
    const expired = await t.seed("expired", "Late");
    await expect(confirmRegistration(t.owner, expired)).rejects.toMatchObject({ status: 409, code: PROMOTE_OVER_CAPACITY_CODE });
    expect(await t.statusOf(expired)).toBe("expired");
    expect((await confirmRegistration(t.owner, expired, { confirmOverCapacity: true })).status).toBe("confirmed");
  });

  it("the doors that never reached a waitlisted entry stay shut: approve and mark-paid refuse it", async () => {
    const t = await setup({ capacity: 1, planLimit: null });
    await t.fill(1);
    const waiting = await t.seed("waitlisted", "Waiting");
    await expect(approveRegistration(t.owner, waiting)).rejects.toMatchObject({ status: 422 });
    await expect(markRegistrationPaidOffline(t.owner, waiting)).rejects.toMatchObject({ status: 422 });
    expect(await t.statusOf(waiting)).toBe("waitlisted");
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Fix round 1, M1: the oldest-first path and the explicit-id path agree on a SOLO. A solo sign-up takes no team place, so promoting one
// is never refused for a full division; the guard judges the entry that would actually be promoted, not "is any team waiting".
// ---------------------------------------------------------------------------------------------------------------------------------
describe.skipIf(!HAS_DB)("oldest-first promotion judges the entry it would promote (fix round 1 M1)", () => {
  it("a SOLO-ONLY queue on a full division: oldest-first promotes it, exactly as the explicit-id path does", async () => {
    const t = await setup({ capacity: 1, planLimit: null });
    await t.fill(1);
    const solo = await t.seed("waitlisted", "Solo", { freeAgent: true });
    const viaId = await promoteFromWaitlist(t.owner, t.division.id, { registrationId: solo });
    expect(viaId!.id, "premise: the explicit-id path allows a solo").toBe(solo);
    // Same shape again for the oldest-first path.
    const solo2 = await t.seed("waitlisted", "Solo 2", { freeAgent: true });
    const viaOldest = await promoteFromWaitlist(t.owner, t.division.id);
    expect(viaOldest!.id).toBe(solo2);
    expect(await t.holders(), "no team place was taken").toBe(1);
  });

  it("a queue whose HEAD is a solo and whose second is a team: oldest-first promotes the solo with no confirmation, the team stays waiting", async () => {
    const t = await setup({ capacity: 1, planLimit: null });
    await t.fill(1);
    const solo = await t.seed("waitlisted", "Solo first", { freeAgent: true });
    const team = await t.seed("waitlisted", "Team second");
    expect((await promoteFromWaitlist(t.owner, t.division.id))!.id).toBe(solo);
    expect(await t.statusOf(team)).toBe("waitlisted");
    // The team is the head now: a full division refuses it.
    await expect(promoteFromWaitlist(t.owner, t.division.id)).rejects.toMatchObject({ status: 409, code: PROMOTE_OVER_CAPACITY_CODE });
  });

  it("a queue whose HEAD is a team on a full division: oldest-first still refuses", async () => {
    const t = await setup({ capacity: 1, planLimit: null });
    await t.fill(1);
    const team = await t.seed("waitlisted", "Team first");
    await t.seed("waitlisted", "Solo second", { freeAgent: true });
    await expect(promoteFromWaitlist(t.owner, t.division.id)).rejects.toMatchObject({ status: 409 });
    expect(await t.statusOf(team)).toBe("waitlisted");
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Fix round 1, M4: every case above is manual approval (a promotion lands `pending`). The AUTO path confirms a free promotion inline and
// seats an entrant; the count must hold there too.
// ---------------------------------------------------------------------------------------------------------------------------------
describe.skipIf(!HAS_DB)("promotion on an AUTO-approval division confirms inline and is counted the same (fix round 1 M4)", () => {
  it("under capacity: promotes straight to confirmed", async () => {
    const t = await setup({ capacity: 3, planLimit: null, approval: "auto" });
    await t.fill(2);
    const waiting = await t.seed("waitlisted", "Waiting");
    expect((await promoteFromWaitlist(t.owner, t.division.id, { registrationId: waiting }))!.status).toBe("confirmed");
    expect(await t.holders()).toBe(3);
  });

  it("at capacity: refused without confirmation (nothing seated), confirmed with it, and the next one is refused again", async () => {
    const t = await setup({ capacity: 2, planLimit: null, approval: "auto" });
    await t.fill(2);
    const a = await t.seed("waitlisted", "A");
    await expect(promoteFromWaitlist(t.owner, t.division.id, { registrationId: a })).rejects.toMatchObject({ status: 409 });
    expect(await t.statusOf(a)).toBe("waitlisted");
    expect((await promoteFromWaitlist(t.owner, t.division.id, { registrationId: a, confirmOverCapacity: true }))!.status).toBe("confirmed");
    expect(await t.holders()).toBe(3);
    const b = await t.seed("waitlisted", "B");
    await expect(promoteFromWaitlist(t.owner, t.division.id, { registrationId: b })).rejects.toMatchObject({ status: 409, extra: { taken: 3 } });
  });

  // The OLDEST-FIRST default (no id) on an auto-approval division takes the seat-gate branch of `promoteOldestWaitlisted`, a different
  // call site of the room check from the manual-approval one above.
  it("oldest-first at capacity: a team head is refused without confirmation, then promoted (confirmed) with it", async () => {
    const t = await setup({ capacity: 2, planLimit: null, approval: "auto" });
    await t.fill(2);
    const head = await t.seed("waitlisted", "Head");
    await expect(promoteFromWaitlist(t.owner, t.division.id, {})).rejects.toMatchObject({ status: 409, code: PROMOTE_OVER_CAPACITY_CODE });
    expect(await t.statusOf(head)).toBe("waitlisted");
    expect((await promoteFromWaitlist(t.owner, t.division.id, { confirmOverCapacity: true }))!.id).toBe(head);
    expect(await t.statusOf(head)).toBe("confirmed");
  });

  it("oldest-first at capacity: a SOLO head takes no place, so it is promoted unrefused", async () => {
    const t = await setup({ capacity: 2, planLimit: null, approval: "auto" });
    await t.fill(2);
    const solo = await t.seed("waitlisted", "Solo", { freeAgent: true });
    expect((await promoteFromWaitlist(t.owner, t.division.id, {}))!.id).toBe(solo);
    expect(await t.statusOf(solo)).toBe("confirmed");
  });

  it("at the plan limit: refused 422 even confirmed", async () => {
    const t = await setup({ capacity: null, planLimit: 2, approval: "auto" });
    await t.fill(2);
    const a = await t.seed("waitlisted", "A");
    await expect(promoteFromWaitlist(t.owner, t.division.id, { registrationId: a, confirmOverCapacity: true })).rejects.toMatchObject({
      status: 422,
      code: PROMOTE_PLAN_LIMIT_CODE,
    });
  });
});
