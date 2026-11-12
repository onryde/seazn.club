// Polish wave P5, H-2 (walk 15, MED): an unpaid SOLO sign-up's panel row offered only Withdraw and Resend - no Send payment reminder,
// no Mark paid. The solo owed its own price (`free_agent_fee_cents`, RS009), but every money gate read the TEAM price
// (`registration_settings.fee_cents`): the panel's `division_fee_cents` (list.ts), and on the server Confirm, Mark paid, the reminder
// and Approve. So a solo in a free-for-teams division owing 5.00 could not be reminded or marked paid ("no entry fee") and could be
// CONFIRMED without paying, while a free solo in a paid-for-teams division was refused Mark paid's opposite: Approve stamped it
// "approved, payment still due" for a fee it never owed, and Confirm refused it as awaiting payment.
//
// The rule under test (RS009's own, as the submit path prices an entry): an entry's live price is `free_agent_fee_cents` for a solo
// sign-up when the organiser set one (NULL = no separate price, the team's), else `fee_cents`. Expected prices are written from that
// rule per row, never read back from the code under test.
//
// Recorded (H-2's second half): Assign stays paid-only. `assignSoloSignUp` refuses an entry that is not confirmed or paid ("assign is
// not a payment path"): placing an unpaid solo on a team would seat them on the team's confirm without their own fee ever being paid.
//
// Sport: generic - the price rule never reads the sport. Real Postgres required; skipped without DATABASE_URL.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

const deliverMock = vi.hoisted(() => vi.fn());
vi.mock("@/server/email-outbox/transport", () => ({ deliver: deliverMock }));

import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import {
  confirmRegistration,
  groupById,
  listRegistrations,
  markRegistrationPaidOffline,
  putRegistrationSettings,
  sendPaymentReminder,
  waitlistRegistration,
} from "../registrations";
import { approveRegistration, promoteFromWaitlist } from "../registration-approval";
import { submitRegistrationGroup } from "../registration-submit";
import { stubOutboxEnv } from "./_invite-mail";
import { seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;
const ORIGIN = "https://solo-price.test";

beforeEach(() => {
  stubOutboxEnv();
  deliverMock.mockReset().mockResolvedValue({ ok: false, reason: "http", status: 503, errorName: "service_unavailable", detail: "later" });
});

interface Rig {
  auth: AuthCtx;
  divisionId: string;
  ctx: { orgSlug: string; compSlug: string };
}

async function rig(o: { teamFee: number; soloFee: number | null; approval: "auto" | "manual" }): Promise<Rig> {
  const { auth } = await seedOrg();
  const competition = await createCompetition(auth, {
    name: "Solo Price Cup " + randomUUID().slice(0, 6),
    visibility: "public",
    branding: {},
    starts_on: "2027-03-01",
    ends_on: "2027-03-05",
  });
  const division = await createDivision(auth, competition.id, {
    name: "Open " + randomUUID().slice(0, 6),
    sport_key: "generic",
    variant_key: "score",
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
  });
  await putRegistrationSettings(auth, division.id, {
    enabled: true,
    entrant_kind: "team",
    fee_cents: o.teamFee,
    free_agent_fee_cents: o.soloFee,
    allow_free_agents: true,
    payment_method: "offline",
    approval: o.approval,
    form_fields: [],
    opens_at: null,
    closes_at: null,
    capacity: null,
    refund_lock_at: null,
  });
  const [row] = await sql<{ org_slug: string; comp_slug: string }[]>`
    select o.slug as org_slug, c.slug as comp_slug from competitions c join organizations o on o.id = c.org_id
     where c.id = ${competition.id}`;
  return { auth, divisionId: division.id, ctx: { orgSlug: row!.org_slug, compSlug: row!.comp_slug } };
}

/** One entry through the REAL submit: a solo sign-up, or a team. Returns its id and what submit charged it. */
async function submit(r: Rig, freeAgent: boolean): Promise<{ id: string; amount: number; status: string; groupId: string; token: string }> {
  const res = await submitRegistrationGroup(r.ctx, {
    contact: { name: "Contact " + randomUUID().slice(0, 5), email: `sp-${randomUUID().slice(0, 8)}@test.local` },
    privacy_consent: true,
    entries: [
      {
        division_id: r.divisionId,
        entrant_kind: "team",
        free_agent: freeAgent,
        team_name: freeAgent ? null : "Team " + randomUUID().slice(0, 4),
        players: [{ full_name: freeAgent ? "Priya Solo" : "Captain One" }],
        answers: {},
      },
    ],
  } as never);
  const id = res.entries[0]!.registration_id;
  const [row] = await sql<{ amount_cents: number; status: string }[]>`select amount_cents, status from registrations where id = ${id}`;
  return { id, amount: row!.amount_cents, status: row!.status, groupId: res.group_id, token: res.access_token };
}

const reminderRows = async (regId: string) =>
  (await sql<{ n: number }[]>`select count(*)::int as n from email_outbox where kind = 'payment_reminder' and ref_id = ${regId}`)[0]!.n;

describe.skipIf(!HAS_DB)("a solo sign-up's money controls read the SOLO's own price (H-2)", () => {
  it("the panel row carries each entry's live price: the solo's own (NULL = the team's), the team's fee for a team - every price shape", async () => {
    const table: { teamFee: number; soloFee: number | null; soloPrice: number }[] = [
      { teamFee: 6000, soloFee: 500, soloPrice: 500 },
      { teamFee: 6000, soloFee: 0, soloPrice: 0 },
      { teamFee: 6000, soloFee: null, soloPrice: 6000 },
      { teamFee: 0, soloFee: 500, soloPrice: 500 },
    ];
    let checked = 0;
    for (const c of table) {
      const r = await rig({ teamFee: c.teamFee, soloFee: c.soloFee, approval: "manual" });
      const solo = await submit(r, true);
      const team = await submit(r, false);
      expect(solo.amount, `premise: submit charged the solo its own price (${JSON.stringify(c)})`).toBe(c.soloPrice);
      const rows = await listRegistrations(r.auth, r.divisionId, null);
      expect(rows.find((x) => x.id === solo.id)!.division_fee_cents, `solo ${JSON.stringify(c)}`).toBe(c.soloPrice);
      expect(rows.find((x) => x.id === team.id)!.division_fee_cents, `team ${JSON.stringify(c)}`).toBe(c.teamFee);
      checked += 1;
    }
    expect(checked, "anti-vacuity: every price shape").toBe(table.length);
  });

  it("a solo owing 5.00 in a FREE-for-teams division: the reminder goes out and Mark paid records it (both refused 'no entry fee' before); Confirm refuses it unpaid", async () => {
    const r = await rig({ teamFee: 0, soloFee: 500, approval: "auto" });
    const solo = await submit(r, true);
    expect(solo.status, "premise: it owes its fee").toBe("pending");

    // Confirm without payment is the waiver's door, not Confirm's: a solo that owes is refused like any entry that owes.
    await expect(confirmRegistration(r.auth, solo.id)).rejects.toMatchObject({ status: 422, message: expect.stringContaining("Awaiting payment") });

    await sendPaymentReminder(r.auth, solo.id, ORIGIN);
    expect(await reminderRows(solo.id), "one reminder queued").toBe(1);

    const marked = await markRegistrationPaidOffline(r.auth, solo.id);
    expect(marked.status).toBe("confirmed");
  });

  it("a solo owing 5.00 in a free-for-teams division (manual review): Approve records the approval with the fee due (W12) - it is never seated for free", async () => {
    const r = await rig({ teamFee: 0, soloFee: 500, approval: "manual" });
    const solo = await submit(r, true);
    const approved = await approveRegistration(r.auth, solo.id);
    expect(approved.status, "its own fee is still due").toBe("pending");
    expect(approved.approved_at).not.toBeNull();
    expect(approved.entrant_id, "nobody seated without the money").toBeNull();
    // Its payment then confirms it.
    expect((await markRegistrationPaidOffline(r.auth, solo.id)).status).toBe("confirmed");
  });

  it("a FREE solo in a paid-for-teams division (manual review): Approve confirms it at once - nothing is due; Mark paid and the reminder refuse 'no entry fee'", async () => {
    const r = await rig({ teamFee: 6000, soloFee: 0, approval: "manual" });
    const first = await submit(r, true);
    expect(first.status, "premise: free, waiting for the organiser").toBe("pending");
    expect(first.amount).toBe(0);

    await expect(markRegistrationPaidOffline(r.auth, first.id)).rejects.toMatchObject({ status: 422, message: expect.stringContaining("no entry fee") });
    await expect(sendPaymentReminder(r.auth, first.id, ORIGIN)).rejects.toMatchObject({ status: 422, message: expect.stringContaining("no entry fee") });
    expect(await reminderRows(first.id)).toBe(0);

    const approved = await approveRegistration(r.auth, first.id);
    expect(approved.status, "nothing owed: approved means confirmed, not 'payment still due'").toBe("confirmed");
    expect(approved.approved_at, "no fee-due approval stamp").toBeNull();

    // The other organiser door on the same shape: Confirm takes a free solo (it was refused "Awaiting payment" for the team's fee).
    const second = await submit(r, true);
    const confirmed = await confirmRegistration(r.auth, second.id);
    expect(confirmed.status).toBe("confirmed");
  });

  it("the positive pair: a TEAM entry in the same divisions still reads the team's fee at every gate", async () => {
    const paidTeams = await rig({ teamFee: 6000, soloFee: 0, approval: "auto" });
    const team = await submit(paidTeams, false);
    expect(team.status).toBe("pending");
    await expect(confirmRegistration(paidTeams.auth, team.id)).rejects.toMatchObject({ status: 422 });
    await sendPaymentReminder(paidTeams.auth, team.id, ORIGIN);
    expect(await reminderRows(team.id)).toBe(1);
    expect((await markRegistrationPaidOffline(paidTeams.auth, team.id)).status).toBe("confirmed");

    const freeTeams = await rig({ teamFee: 0, soloFee: 500, approval: "manual" });
    const freeTeam = await submit(freeTeams, false);
    await expect(markRegistrationPaidOffline(freeTeams.auth, freeTeam.id)).rejects.toMatchObject({ status: 422 });
    expect((await approveRegistration(freeTeams.auth, freeTeam.id)).status).toBe("confirmed");
  });

  // Final review m3: the promotion writer was the one money reader the H-2 sweep missed. `promoteWaitlistedRow` set the promoted entry's
  // fee from the TEAM price, and the status page quoted a waitlisted solo the team's fee as "what a promotion would charge". Reachable:
  // the organiser waitlists a pending solo (`waitlistRegistration` takes any pending entry), then promotes it.
  it("a waitlisted solo is quoted and promoted at its OWN price; a team in the same division at the team's (m3)", async () => {
    const r = await rig({ teamFee: 6000, soloFee: 500, approval: "manual" });
    const solo = await submit(r, true);
    const team = await submit(r, false);
    expect(solo.amount, "premise: submit charged the solo its own price").toBe(500);
    let checked = 0;
    for (const [entry, price] of [[solo, 500], [team, 6000]] as const) {
      await waitlistRegistration(r.auth, entry.id);
      const view = await groupById(entry.groupId, entry.token);
      expect(view.entries[0]!.fee_if_promoted_cents, `quoted on the status page (${price})`).toBe(price);
      const promoted = await promoteFromWaitlist(r.auth, r.divisionId, { registrationId: entry.id });
      expect(promoted?.id).toBe(entry.id);
      expect(promoted!.amount_cents, `charged on promotion (${price})`).toBe(price);
      expect(promoted!.status).toBe("pending");
      checked += 1;
    }
    expect(checked, "anti-vacuity: solo and team").toBe(2);
  });
});
