// Review walk-B m5 (2026-11-13, owner-approved 2026-11-15): a SOLO sign-up (a free agent, awaiting a team) promoted off the waitlist on a
// FREE division with AUTOMATIC approval becomes `confirmed` but seats nobody (`materialise` confirms it and returns), so the status page's
// headline reads "You're in the player pool" (`pool`, `awaitingTeamAssignment`). The promotion mail said "your place in <division> is
// confirmed" - two answers to one question. The mail now says the pool, for exactly the entries the page says it for.
//
// Every case is driven through its REAL producers: the public submit (a solo and a team), the organiser's waitlist move, the organiser's
// promote (`promoteFromWaitlist` -> `promoteWaitlistedRow` -> `notifyPromoted`), the queued body opened with the outbox's own `openBody`,
// and the status page's own `cartHeadline` over the real `groupById` view. Expected sentences come from the emails dictionary per
// locale, never typed here, and the page's answer is read from the real view-model, not restated.
//
// Sport: not applicable. The promotion mail does not vary by sport (spec, Test strategy 4); the axes that vary are the entrant (solo or
// team), the approval mode, the fee and the locale.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

const deliverMock = vi.hoisted(() => vi.fn());
vi.mock("@/server/email-outbox/transport", () => ({ deliver: deliverMock }));

import { sql } from "@/lib/db";
import { getDictionary, t } from "@/lib/i18n";
import { LOCALES } from "@/lib/i18n-constants";
import type { AuthCtx } from "@/server/api-v1/auth";
import { openBody } from "@/server/email-outbox/seal";
import { cartHeadline } from "@/app/(public)/live/[orgSlug]/[competitionSlug]/register/status/view-model";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { groupById, putRegistrationSettings, waitlistRegistration } from "../registrations";
import { promoteFromWaitlist } from "../registration-approval";
import { submitRegistrationGroup } from "../registration-submit";
import { stubOutboxEnv } from "./_invite-mail";
import { seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;
const made = { orgIds: [] as string[] };

afterAll(async () => {
  if (!HAS_DB) return;
  await sql`delete from email_outbox where org_id = any(${made.orgIds}::uuid[])`;
  await sql.end({ timeout: 2 }).catch(() => undefined);
});

beforeEach(() => {
  stubOutboxEnv();
  // The provider answers 503: a row stays `queued` and keeps its sealed body, which is what these tests read.
  deliverMock.mockReset().mockResolvedValue({ ok: false, reason: "http", status: 503, errorName: "service_unavailable", detail: "later" });
});

interface Rig {
  auth: AuthCtx;
  divisionId: string;
  divisionName: string;
  competitionName: string;
  ctx: { orgSlug: string; compSlug: string };
  /** The division's registration settings through the REAL organiser door, with the rig's fees and this approval mode. */
  setApproval: (approval: "auto" | "manual") => Promise<void>;
}

async function rig(o: { teamFee: number; soloFee: number | null; approval: "auto" | "manual" }): Promise<Rig> {
  const { auth } = await seedOrg();
  made.orgIds.push(auth.orgId);
  const competition = await createCompetition(auth, {
    name: "Pool Cup " + randomUUID().slice(0, 6),
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
  const setApproval = async (approval: "auto" | "manual") => {
    await putRegistrationSettings(auth, division.id, {
      enabled: true,
      entrant_kind: "team",
      fee_cents: o.teamFee,
      free_agent_fee_cents: o.soloFee,
      allow_free_agents: true,
      payment_method: "offline",
      approval,
      form_fields: [],
      opens_at: null,
      closes_at: null,
      capacity: null,
      refund_lock_at: null,
    });
  };
  await setApproval(o.approval);
  const [row] = await sql<{ org_slug: string; comp_slug: string }[]>`
    select o.slug as org_slug, c.slug as comp_slug from competitions c join organizations o on o.id = c.org_id
     where c.id = ${competition.id}`;
  return { auth, divisionId: division.id, divisionName: division.name, competitionName: competition.name, ctx: { orgSlug: row!.org_slug, compSlug: row!.comp_slug }, setApproval };
}

/** One entry through the REAL submit (a solo sign-up or a team), then the organiser's real move to the waitlist and real promotion.
 *  `approvalAtPromotion`: the organiser changes the division's approval mode between the move and the promotion. A solo never waitlists at
 *  submit, and a FREE entry on automatic approval confirms at submit, so a free-and-automatic promotion is only reachable this way
 *  (the entry was pending under manual approval, the organiser moved it to the waitlist, then switched the division to automatic). */
async function promoted(r: Rig, o: { solo: boolean; locale: string; approvalAtPromotion?: "auto" | "manual" }) {
  const res = await submitRegistrationGroup(r.ctx, {
    contact: { name: "Contact " + randomUUID().slice(0, 5), email: `pm-${randomUUID().slice(0, 8)}@test.local` },
    locale: o.locale,
    privacy_consent: true,
    entries: [
      {
        division_id: r.divisionId,
        entrant_kind: "team",
        free_agent: o.solo,
        team_name: o.solo ? null : "Team " + randomUUID().slice(0, 4),
        players: [{ full_name: o.solo ? "Priya Solo" : "Captain One" }],
        answers: {},
      },
    ],
  } as never);
  const id = res.entries[0]!.registration_id;
  await waitlistRegistration(r.auth, id);
  if (o.approvalAtPromotion) await r.setApproval(o.approvalAtPromotion);
  const row = await promoteFromWaitlist(r.auth, r.divisionId, { registrationId: id });
  expect(row?.id, "premise: the organiser's promote took this entry").toBe(id);
  return { id, status: row!.status, groupId: res.group_id, token: res.access_token };
}

/** The promotion mail's visible words (html) and plain text: queued after the promotion's response, so poll for the row. */
async function promotionMail(regId: string): Promise<{ html: string; text: string }> {
  let sealed: Uint8Array | null = null;
  await vi.waitFor(
    async () => {
      const [row] = await sql<{ body_sealed: Uint8Array | null }[]>`
        select body_sealed from email_outbox where kind = 'registration_promoted' and ref_type = 'registration' and ref_id = ${regId}`;
      if (!row?.body_sealed) throw new Error("the promotion mail is not queued yet");
      sealed = row.body_sealed;
    },
    { timeout: 10_000, interval: 50 },
  );
  const { html, text } = await openBody(sealed!);
  return { html: html.replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " "), text };
}

/** What the status page puts at the top of this cart, read off the real view with the page's own headline rule. */
async function pageHeadline(p: { groupId: string; token: string }) {
  const view = await groupById(p.groupId, p.token);
  return cartHeadline(view.entries, view);
}

describe.skipIf(!HAS_DB)("a solo promotion's mail agrees with the status page about the player pool (review walk-B m5, DB)", () => {
  it.each(LOCALES)("%s: a free solo on automatic approval is confirmed and unplaced: the page says the pool and so does the mail, never 'confirmed'", async (locale) => {
    const dict = await getDictionary(locale, "emails");
    const r = await rig({ teamFee: 0, soloFee: null, approval: "manual" });
    const solo = await promoted(r, { solo: true, locale, approvalAtPromotion: "auto" });
    expect(solo.status, "premise: a free promotion on automatic approval confirms the solo").toBe("confirmed");
    expect(await pageHeadline(solo), "premise: the page reads the pool for it").toBe("pool");

    const pool = t(dict, "registrationPromoted.pool");
    const confirmed = t(dict, "registrationPromoted.confirmed", { divisionName: r.divisionName });
    expect(pool, `${locale}: the pool sentence exists in this locale`).not.toBe("registrationPromoted.pool");
    const mail = await promotionMail(solo.id);
    expect(mail.text, "the plain text states the pool").toContain(pool);
    expect(mail.html, "the html states the pool").toContain(pool);
    expect(mail.text, "never 'confirmed'").not.toContain(confirmed);
    expect(mail.html, "never 'confirmed' (html)").not.toContain(confirmed);
  });

  // The other half of the same rule, in the same division shape: a TEAM promoted the same way IS seated, the page says so ("in"), and its
  // mail keeps the confirmed sentence naming the division - the fix must not reach it.
  it("a free TEAM on automatic approval is seated: the page says 'in' and the mail keeps its confirmed sentence, never the pool", async () => {
    const dict = await getDictionary("en", "emails");
    const r = await rig({ teamFee: 0, soloFee: null, approval: "manual" });
    const team = await promoted(r, { solo: false, locale: "en", approvalAtPromotion: "auto" });
    expect(team.status, "premise: the team is confirmed").toBe("confirmed");
    expect(await pageHeadline(team), "premise: the page reads 'in' for a seated team").toBe("in");

    const confirmed = t(dict, "registrationPromoted.confirmed", { divisionName: r.divisionName });
    const mail = await promotionMail(team.id);
    expect(confirmed, "premise: the sentence names the division").toContain(r.divisionName);
    expect(mail.text).toContain(confirmed);
    expect(mail.text, "the pool is never said of a seated team").not.toContain(t(dict, "registrationPromoted.pool"));
  });

  // A solo that is NOT confirmed is not in the pool yet: manual approval leaves the free promotion pending the organiser, a fee leaves
  // it pending the money. Neither mail reads the pool - the page's own `pool` headline needs `confirmed`.
  it("a solo that the promotion leaves PENDING (manual approval, or a fee owed) is not told it is in the pool", async () => {
    const dict = await getDictionary("en", "emails");
    const pool = t(dict, "registrationPromoted.pool");
    const confirmed = (divisionName: string) => t(dict, "registrationPromoted.confirmed", { divisionName });
    let checked = 0;

    const manual = await rig({ teamFee: 0, soloFee: null, approval: "manual" });
    const waiting = await promoted(manual, { solo: true, locale: "en" });
    expect(waiting.status, "premise: manual approval leaves the free solo pending").toBe("pending");
    expect(await pageHeadline(waiting), "premise: the page reads 'received'").toBe("received");
    const waitingMail = await promotionMail(waiting.id);
    expect(waitingMail.text, "the organiser will confirm").toContain(t(dict, "registrationPromoted.noPayment"));
    expect(waitingMail.text).not.toContain(pool);
    expect(waitingMail.text).not.toContain(confirmed(manual.divisionName));
    checked += 1;

    const owing = await rig({ teamFee: 0, soloFee: 500, approval: "auto" });
    const owes = await promoted(owing, { solo: true, locale: "en" });
    expect(owes.status, "premise: the solo owes its own fee, so it is pending").toBe("pending");
    const owesMail = await promotionMail(owes.id);
    expect(owesMail.text, "the fee is what the mail is about").toContain(t(dict, "registrationPromoted.textFee", { amount: "" }));
    expect(owesMail.text, "the solo's own price, 5.00").toMatch(/5\.00/);
    expect(owesMail.text).not.toContain(pool);
    expect(owesMail.text).not.toContain(confirmed(owing.divisionName));
    checked += 1;

    expect(checked, "anti-vacuity: both pending shapes were judged").toBe(2);
  });
});
