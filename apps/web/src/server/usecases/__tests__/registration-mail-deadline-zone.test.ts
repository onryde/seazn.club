// Polish wave P3 (walkthrough W4): the status page wrote a pay-by deadline "14 Nov 2026, 11:15 UTC" and the mails "Fri, 14 Nov, 11:15 UTC"
// (UTC always, no year). The mails now write the status page's spelling in the ORG's zone. The template half is in
// lib/__tests__/email-builders.test.ts; this file drives the two REAL producers that feed it (`buildCartMail`, `paymentReminderMessage`) and
// renders their own output, so a producer that stopped naming the zone (the seam going inert) fails here although the template is green.
//
// Real Postgres required; skipped without DATABASE_URL (matches every sibling usecase suite in this directory).
import { describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import { registrationEmail } from "@/lib/email";
import { fmtPublicDeadline } from "@/lib/format";
import { openBody } from "@/server/email-outbox/seal";
import { divisionCtx } from "../registrations/lookups";
import { buildCartMail, paymentReminderMessage } from "../registrations/mail";
import { notifyPromoted, promoteWaitlistedRow } from "../registrations";
import { stubOutboxEnv } from "./_invite-mail";
import { stripeRig, seedRegistration, loadWithGroup } from "./_registration-fixtures";

const HAS_DB = !!process.env.DATABASE_URL;

async function cardCart(timezone: string | null) {
  const rig = await stripeRig({ feeCents: 1500 });
  await sql`update organizations set timezone = ${timezone} where id = ${rig.orgId}`;
  const seeded = await seedRegistration(rig.competition.id, rig.division.id, rig.settings, { displayName: "Zone Team" });
  const [g] = await sql<{ expires_at: Date }[]>`select expires_at from registration_groups where id = ${seeded.registration.group_id}`;
  if (!g?.expires_at) throw new Error("premise: a card cart carries a pay window");
  return { seeded, deadline: g.expires_at };
}

describe.skipIf(!HAS_DB)("registration mails write the pay-by deadline in the org's zone (polish wave P3, W4)", () => {
  it("the cart confirmation: buildCartMail names the zone and the rendered mail prints it; UTC when the org set none", async () => {
    let checked = 0;
    for (const zone of ["Asia/Kolkata", "Europe/London", null]) {
      const { seeded, deadline } = await cardCart(zone);
      const mail = await buildCartMail(seeded.registration.group_id, "https://test.local", seeded.access_token);
      expect(mail, `${zone}: the cart builds`).not.toBeNull();
      expect(mail!.args.timeZone).toBe(zone ?? "UTC");
      expect(mail!.args.payPageUrl, "premise: a card cart still owing a fee carries the Pay button, so it names the deadline").not.toBeNull();
      const content = await registrationEmail(mail!.args, mail!.locale);
      // Expected value: the shared formatter on the instant the DATABASE holds, in the zone the test set (never the producer's own output).
      const want = fmtPublicDeadline("en", zone ?? "UTC", deadline);
      expect(want, "premise: the expected spelling is non-empty").not.toBe("");
      expect(content.html, `${zone}`).toContain(want);
      expect(content.text, `${zone}`).toContain(want);
      checked += 1;
    }
    expect(checked).toBe(3);
  });

  it("two zones give two different strings (a producer that always said one zone cannot pass both)", async () => {
    const a = await cardCart("Asia/Kolkata");
    const b = await cardCart("America/Los_Angeles");
    const mailA = await buildCartMail(a.seeded.registration.group_id, "https://test.local", a.seeded.access_token);
    const mailB = await buildCartMail(b.seeded.registration.group_id, "https://test.local", b.seeded.access_token);
    const htmlA = (await registrationEmail(mailA!.args, mailA!.locale)).html;
    const htmlB = (await registrationEmail(mailB!.args, mailB!.locale)).html;
    // Each cart's deadline is its own (now + 48h, seeded a moment apart): compare each mail with ITS OWN instant in ITS zone, and
    // require that the other zone's rendering of that same instant is a different string, so the zone alone decides the text.
    const wantA = fmtPublicDeadline("en", "Asia/Kolkata", a.deadline);
    const wantB = fmtPublicDeadline("en", "America/Los_Angeles", b.deadline);
    expect(htmlA).toContain(wantA);
    expect(htmlB).toContain(wantB);
    expect(fmtPublicDeadline("en", "UTC", a.deadline), "premise: the zone changes the text").not.toBe(wantA);
    expect(htmlA).not.toContain(fmtPublicDeadline("en", "UTC", a.deadline));
    expect(htmlB).not.toContain(fmtPublicDeadline("en", "UTC", b.deadline));
  });

  it("the payment reminder: paymentReminderMessage names the zone and the rendered mail prints it", async () => {
    let checked = 0;
    for (const zone of ["Asia/Kolkata", null]) {
      const { seeded, deadline } = await cardCart(zone);
      const reg = seeded.registration;
      const ctx = await divisionCtx(sql, reg.division_id);
      const message = await paymentReminderMessage(reg, ctx, {
        feeCents: reg.amount_cents,
        paymentInstructions: null,
        method: "card",
        payPageUrl: "https://test.local/r/pay/" + "T".repeat(43),
        payDeadline: deadline,
      });
      const want = fmtPublicDeadline("en", zone ?? "UTC", deadline);
      expect(message.html, `${zone}`).toContain(want);
      expect(message.text, `${zone}`).toContain(want);
      checked += 1;
    }
    expect(checked).toBe(2);
  });

  // The third deadline mail. The template half is in email-builders.test.ts; this drives the REAL producer (`notifyPromoted`), reads the
  // sealed outbox body it queued, and compares it with the instant the DATABASE holds for THIS entry's own pay window.
  it("the promotion mail: notifyPromoted names the zone and the queued body prints it; two zones, two strings", async () => {
    stubOutboxEnv();
    let checked = 0;
    const seen = new Set<string>();
    for (const zone of ["Asia/Kolkata", "America/Los_Angeles", null]) {
      const rig = await stripeRig({ capacity: 1, feeCents: 1500 });
      await sql`update organizations set timezone = ${zone} where id = ${rig.orgId}`;
      await seedRegistration(rig.competition.id, rig.division.id, rig.settings, { displayName: "Holder", contactEmail: "holder@test.local" });
      const waiting = await seedRegistration(rig.competition.id, rig.division.id, rig.settings, {
        displayName: "Wait Lister",
        contactEmail: "wait@test.local",
        status: "waitlisted",
      });
      const promoted = await sql.begin((tx) => promoteWaitlistedRow(tx, waiting.registration.id, waiting.registration.group_id, rig.settings));
      const row = await loadWithGroup(promoted!.id);
      if (!row.promotion_expires_at) throw new Error("premise: a fee-bearing promotion carries its own pay window");
      const ctx = await divisionCtx(sql, rig.division.id);
      await notifyPromoted(row, ctx, rig.settings, "https://test.local", { firstAttempt: "worker" });

      const [outbox] = await sql<{ body_sealed: Uint8Array | null }[]>`
        select body_sealed from email_outbox where kind = 'registration_promoted' and ref_id = ${row.id}`;
      expect(outbox?.body_sealed, `${zone}: the promotion mail was queued with its body`).toBeTruthy();
      const content = await openBody(outbox!.body_sealed!);
      const want = fmtPublicDeadline("en", zone ?? "UTC", row.promotion_expires_at);
      expect(want, "premise: the expected spelling is non-empty").not.toBe("");
      expect(content.html, `${zone}`).toContain(want);
      expect(content.text, `${zone}`).toContain(want);
      seen.add(want.replace(/^.*, /, ""));
      checked += 1;
    }
    expect(checked).toBe(3);
    expect(seen.size, "premise: the three zones print three different clock readings").toBe(3);
  });
});
