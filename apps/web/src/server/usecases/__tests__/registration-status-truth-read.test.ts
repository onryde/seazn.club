// Polish wave P3 (walkthrough W2, W6, W12): the status page said only "PENDING" and "Free" because the read model carried neither what a
// pending entry is WAITING ON nor the fee a waitlisted entry would owe on promotion. `buildGroupStatusView` (via `groupById`) now carries
// both per entry: `approval` (the entry's OWN division's review mode) and `fee_if_promoted_cents` (waitlisted entries only).
//
// Real Postgres required; skipped without DATABASE_URL (matches every sibling usecase suite in this directory).
import { describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import { groupById, putRegistrationSettings } from "@/server/usecases/registrations";
import { createDivision } from "../divisions";
import { asOwner, rig, seedOrg, seedRegistration, seedSecondEntry, SETTINGS_BASE } from "./_registration-fixtures";

const HAS_DB = !!process.env.DATABASE_URL;

async function offlineRig(over: { approval: "auto" | "manual"; feeCents: number }) {
  const { orgId, ownerId } = await seedOrg("pro");
  const owner = asOwner(orgId, ownerId);
  const { competition, division } = await rig(owner);
  const settings = await putRegistrationSettings(owner, division.id, {
    ...SETTINGS_BASE,
    fee_cents: over.feeCents,
    payment_method: "offline",
    approval: over.approval,
  });
  return { owner, competition, division, settings };
}

describe.skipIf(!HAS_DB)("the status read model carries what an entry is waiting on (polish wave P3)", () => {
  it("approval is the entry's own division's review mode, read at view time (a change shows on the next read)", async () => {
    const { owner, competition, division, settings } = await offlineRig({ approval: "manual", feeCents: 1500 });
    const seeded = await seedRegistration(competition.id, division.id, settings);
    const read = () => groupById(seeded.registration.group_id, seeded.access_token);

    expect((await read()).entries.map((e) => e.approval)).toEqual(["manual"]);
    await putRegistrationSettings(owner, division.id, { ...SETTINGS_BASE, fee_cents: 1500, payment_method: "offline", approval: "auto" });
    expect((await read()).entries.map((e) => e.approval)).toEqual(["auto"]);
  });

  it("a cart across two divisions reports each entry's OWN review mode", async () => {
    const a = await offlineRig({ approval: "manual", feeCents: 1500 });
    const seeded = await seedRegistration(a.competition.id, a.division.id, a.settings, { displayName: "Manual Division Entry" });
    // A second division in the same competition, reviewed automatically.
    const second = await createDivision(a.owner, a.competition.id, {
      name: "Auto Division",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    });
    const secondSettings = await putRegistrationSettings(a.owner, second.id, {
      ...SETTINGS_BASE,
      fee_cents: 500,
      payment_method: "offline",
      approval: "auto",
    });
    expect(secondSettings.approval, "premise: the second division is automatic").toBe("auto");
    await seedSecondEntry(seeded.registration.group_id, second.id, 500, "Auto Division Entry");

    const view = await groupById(seeded.registration.group_id, seeded.access_token);
    expect(view.entries.map((e) => [e.display_name, e.approval])).toEqual([
      ["Manual Division Entry", "manual"],
      ["Auto Division Entry", "auto"],
    ]);
  });

  it("fee_if_promoted_cents: a waitlisted entry carries the division's fee (what a promotion would set); every other entry carries null", async () => {
    const { competition, division, settings } = await offlineRig({ approval: "auto", feeCents: 1500 });
    const seeded = await seedRegistration(competition.id, division.id, settings, { status: "waitlisted", displayName: "Waiting" });
    await seedSecondEntry(seeded.registration.group_id, division.id, 1500, "Paying");
    await seedSecondEntry(seeded.registration.group_id, division.id, 1500, "Done", "confirmed");
    await seedSecondEntry(seeded.registration.group_id, division.id, 1500, "Gone", "withdrawn");

    const view = await groupById(seeded.registration.group_id, seeded.access_token);
    expect(view.entries.map((e) => [e.display_name, e.status, e.fee_if_promoted_cents])).toEqual([
      ["Waiting", "waitlisted", 1500],
      ["Paying", "pending", null],
      ["Done", "confirmed", null],
      ["Gone", "withdrawn", null],
    ]);
    // Anti-vacuity: the waitlisted entry's OWN stored fee is 0 (a promotion is what sets it), so the 1500 above came from the division.
    expect(view.entries[0]!.amount_cents).toBe(0);
  });

  it("a free division's waitlisted entry carries 0, not null (the fee is known: there is none)", async () => {
    const { competition, division, settings } = await offlineRig({ approval: "auto", feeCents: 0 });
    const seeded = await seedRegistration(competition.id, division.id, settings, { status: "waitlisted" });
    const view = await groupById(seeded.registration.group_id, seeded.access_token);
    expect(view.entries[0]!.fee_if_promoted_cents).toBe(0);
  });

  it("the fee follows the division's settings, not a snapshot: raise it and the next read quotes the new fee", async () => {
    const { owner, competition, division, settings } = await offlineRig({ approval: "auto", feeCents: 1500 });
    const seeded = await seedRegistration(competition.id, division.id, settings, { status: "waitlisted" });
    await putRegistrationSettings(owner, division.id, { ...SETTINGS_BASE, fee_cents: 2000, payment_method: "offline", approval: "auto" });
    const view = await groupById(seeded.registration.group_id, seeded.access_token);
    expect(view.entries[0]!.fee_if_promoted_cents).toBe(2000);
    // Not read from the cart row either: a stale group mirror cannot move it.
    await sql`update registration_groups set amount_cents = 99999 where id = ${seeded.registration.group_id}`;
    expect((await groupById(seeded.registration.group_id, seeded.access_token)).entries[0]!.fee_if_promoted_cents).toBe(2000);
  });
});
