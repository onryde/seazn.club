// RS009 — what ONE person pays to enter a team division on their own.
//
// The defect, found before any RS009 code was written and confirmed against
// the shipped tree: `registration-submit.ts` computed
// `const feeCents = waitlisted ? 0 : live.fee_cents` with no solo-sign-up
// branch at all. On a team division `fee_cents` is a price PER TEAM, so a
// lone player entering a £60-per-team division was charged £60 — and once an
// organiser assigns them onto a team that also paid £60, the organiser has
// collected £120 for a single roster. Nobody chose that; it fell out of
// RS002/RS006, and no test could see it because charging the documented
// `fee_cents` looks correct from every angle except the registrant's.
//
// Owner ruling (2026-08-30): a nullable `free_agent_fee_cents`, where NULL
// means "no separate price, charge fee_cents" — i.e. exactly today's
// behaviour — so no existing division changes and no backfill is owed.
//
// The NULL-fallback test below is the one that matters most: it is the only
// thing standing between this change and a silent price change on every team
// division that already accepts solo sign-ups.
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { getRegistrationSettings, putRegistrationSettings } from "../registrations";
import { submitRegistrationGroup } from "../registration-submit";
import { seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

async function seedPaidTeamDivision(
  auth: AuthCtx,
  opts: { feeCents: number; freeAgentFeeCents?: number | null },
): Promise<{ divisionId: string; competitionId: string; orgSlug: string; compSlug: string }> {
  const competition = await createCompetition(auth, {
    name: "Fee Cup " + randomUUID().slice(0, 6),
    visibility: "public",
    branding: {},
    starts_on: "2026-09-15",
    ends_on: "2026-09-20",
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
    fee_cents: opts.feeCents,
    free_agent_fee_cents: opts.freeAgentFeeCents ?? null,
    allow_free_agents: true,
    payment_method: "offline",
    form_fields: [],
    opens_at: null,
    closes_at: null,
    capacity: null,
    refund_lock_at: null,
  });
  const [row] = await sql<{ org_slug: string; comp_slug: string }[]>`
    select o.slug as org_slug, c.slug as comp_slug
    from competitions c join organizations o on o.id = c.org_id
    where c.id = ${competition.id}`;
  return {
    divisionId: division.id,
    competitionId: competition.id,
    orgSlug: row.org_slug,
    compSlug: row.comp_slug,
  };
}

/** Submits one entry and returns what THAT ENTRY was charged.
 *  Reads `registrations.amount_cents` (the per-entry price) rather than the
 *  group's subtotal, so a future multi-entry cart cannot make this pass by
 *  accident. */
async function submitAndPrice(
  ctx: { orgSlug: string; compSlug: string; divisionId: string },
  entry: { free_agent: boolean; team_name?: string | null },
): Promise<number> {
  const res = await submitRegistrationGroup(
    { orgSlug: ctx.orgSlug, compSlug: ctx.compSlug },
    {
      contact: {
        name: "Contact " + randomUUID().slice(0, 5),
        email: `c-${randomUUID().slice(0, 8)}@test.local`,
      },
      privacy_consent: true,
      entries: [
        {
          division_id: ctx.divisionId,
          entrant_kind: "team",
          free_agent: entry.free_agent,
          team_name: entry.team_name ?? null,
          players: entry.free_agent ? [{ full_name: "Priya Raman" }] : [{ full_name: "Captain One" }],
          answers: {},
        },
      ],
    } as never,
  );
  const [row] = await sql<{ amount_cents: number }[]>`
    select amount_cents from registrations where group_id = ${res.group_id}`;
  return row.amount_cents;
}

describe.skipIf(!HAS_DB)("free_agent_fee_cents", () => {
  it("charges a solo sign-up its own price, not the whole team's", async () => {
    const { auth } = await seedOrg();
    const ctx = await seedPaidTeamDivision(auth, { feeCents: 6000, freeAgentFeeCents: 1000 });

    expect(await submitAndPrice(ctx, { free_agent: true })).toBe(1000);
  });

  it("still charges a TEAM entry the team price", async () => {
    // The other half: the new branch must not leak onto the entry it was
    // never about. Without this, setting free_agent_fee_cents could quietly
    // reprice every team in the division.
    const { auth } = await seedOrg();
    const ctx = await seedPaidTeamDivision(auth, { feeCents: 6000, freeAgentFeeCents: 1000 });

    expect(await submitAndPrice(ctx, { free_agent: false, team_name: "Team A" })).toBe(6000);
  });

  it("falls back to the team price when no separate price is set", async () => {
    // NULL means "no separate price", which is the default and therefore the
    // state of every division that exists. This asserts the change is inert
    // until an organiser opts in — the single most important test in the file.
    const { auth } = await seedOrg();
    const ctx = await seedPaidTeamDivision(auth, { feeCents: 6000, freeAgentFeeCents: null });

    expect(await submitAndPrice(ctx, { free_agent: true })).toBe(6000);
  });

  it("treats a zero price as free, not as unset", async () => {
    // 0 and NULL must not collapse into each other. An organiser who sets
    // "solo sign-ups are free" in a £60 division means free — falling back to
    // 6000 here would charge the full team fee to someone told it was free.
    const { auth } = await seedOrg();
    const ctx = await seedPaidTeamDivision(auth, { feeCents: 6000, freeAgentFeeCents: 0 });

    expect(await submitAndPrice(ctx, { free_agent: true })).toBe(0);
  });

  it("refuses a negative price", async () => {
    const { auth } = await seedOrg();
    const competition = await createCompetition(auth, {
      name: "Fee Cup " + randomUUID().slice(0, 6),
      visibility: "public",
      branding: {},
      starts_on: "2026-09-15",
      ends_on: "2026-09-20",
    });
    const division = await createDivision(auth, competition.id, {
      name: "Open " + randomUUID().slice(0, 6),
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    });

    await expect(
      putRegistrationSettings(auth, division.id, {
        enabled: true,
        entrant_kind: "team",
        fee_cents: 6000,
        free_agent_fee_cents: -1,
        allow_free_agents: true,
        form_fields: [],
        opens_at: null,
        closes_at: null,
        capacity: null,
        refund_lock_at: null,
      } as never),
    ).rejects.toThrow();
  });

  it("refuses a solo sign-up price on a division that does not take solo sign-ups", async () => {
    // A price for something the division does not offer is a setting that
    // reads as a promise. `allow_free_agents` is already rejected on a
    // non-team division; its price follows the same rule.
    const { auth } = await seedOrg();
    const competition = await createCompetition(auth, {
      name: "Fee Cup " + randomUUID().slice(0, 6),
      visibility: "public",
      branding: {},
      starts_on: "2026-09-15",
      ends_on: "2026-09-20",
    });
    const division = await createDivision(auth, competition.id, {
      name: "Open " + randomUUID().slice(0, 6),
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    });

    await expect(
      putRegistrationSettings(auth, division.id, {
        enabled: true,
        entrant_kind: "team",
        fee_cents: 6000,
        free_agent_fee_cents: 1000,
        allow_free_agents: false,
        form_fields: [],
        opens_at: null,
        closes_at: null,
        capacity: null,
        refund_lock_at: null,
      } as never),
    ).rejects.toThrow(/solo sign-up|free_agent/i);
  });

  it("reads back through the settings API so the panel can render it", async () => {
    const { auth } = await seedOrg();
    const ctx = await seedPaidTeamDivision(auth, { feeCents: 6000, freeAgentFeeCents: 1000 });

    const settings = await getRegistrationSettings(auth, ctx.divisionId);
    expect(settings.free_agent_fee_cents).toBe(1000);
  });

  // F20 — the `method === "stripe"` conjunct on the Stripe-minimum guard
  // (registrations.ts:1848) had no witness of its own: every prior case in
  // this file either goes through `seedPaidTeamDivision`'s "stripe" default
  // and hits the numeric half, or is offline with a legal fee. Deleting the
  // conjunct alone would make this reject — an offline division has no
  // Stripe minimum to enforce, so a sub-£1 solo fee must be accepted AND
  // actually charged.
  it("accepts a sub-100¢ solo fee on an OFFLINE division — the Stripe minimum does not apply", async () => {
    const { auth } = await seedOrg();
    const competition = await createCompetition(auth, {
      name: "Fee Cup " + randomUUID().slice(0, 6),
      visibility: "public",
      branding: {},
      starts_on: "2026-09-15",
      ends_on: "2026-09-20",
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
      fee_cents: 6000,
      free_agent_fee_cents: 50,
      allow_free_agents: true,
      payment_method: "offline",
      form_fields: [],
      opens_at: null,
      closes_at: null,
      capacity: null,
      refund_lock_at: null,
    } as never);

    const [row] = await sql<{ org_slug: string; comp_slug: string }[]>`
      select o.slug as org_slug, c.slug as comp_slug
      from competitions c join organizations o on o.id = c.org_id
      where c.id = ${competition.id}`;
    const ctx = {
      divisionId: division.id,
      competitionId: competition.id,
      orgSlug: row.org_slug,
      compSlug: row.comp_slug,
    };

    expect(await submitAndPrice(ctx, { free_agent: true })).toBe(50);
  });
});


describe.skipIf(!HAS_DB)("a FREE division's solo sign-up still reaches a placeable state", () => {
  // Caught by e2e, and only by e2e. `registration-submit.ts` excluded free
  // agents from the free/auto-approval inline confirm with the reason "there
  // is no team yet to materialise into" — correct BEFORE RS009, when
  // materialise would have minted a phantom one-person entrant for them.
  //
  // RS009 removed that reason: materialise now seats no entrant for a solo
  // sign-up and confirms them anyway. The exclusion outlived its
  // justification, so on a FREE division a solo sign-up sat at `pending`
  // forever — and RS009's own confirmed-or-paid guard then hid the Assign
  // control, making the whole feature unreachable on exactly the divisions
  // most likely to use it. Two individually-correct changes; the defect
  // lived in the gap between them.
  it("auto-confirms a solo sign-up on a free auto-approval division", async () => {
    const { auth } = await seedOrg();
    const ctx = await seedPaidTeamDivision(auth, { feeCents: 0, freeAgentFeeCents: null });

    const res = await submitRegistrationGroup(
      { orgSlug: ctx.orgSlug, compSlug: ctx.compSlug },
      {
        contact: { name: "Solo", email: `s-${randomUUID().slice(0, 8)}@test.local` },
        privacy_consent: true,
        entries: [
          {
            division_id: ctx.divisionId,
            entrant_kind: "team",
            free_agent: true,
            players: [{ full_name: "Priya Raman" }],
            answers: {},
          },
        ],
      } as never,
    );

    const [row] = await sql<{ status: string; entrant_id: string | null }[]>`
      select status, entrant_id from registrations where group_id = ${res.group_id}`;
    expect(row.status, "a free solo sign-up must not be stranded at pending").toBe("confirmed");
    // ...and still seats nobody: confirming is not the same as fielding.
    expect(row.entrant_id).toBeNull();
  });

  it("still auto-confirms an ordinary free team entry", async () => {
    const { auth } = await seedOrg();
    const ctx = await seedPaidTeamDivision(auth, { feeCents: 0, freeAgentFeeCents: null });

    const res = await submitRegistrationGroup(
      { orgSlug: ctx.orgSlug, compSlug: ctx.compSlug },
      {
        contact: { name: "Captain", email: `c-${randomUUID().slice(0, 8)}@test.local` },
        privacy_consent: true,
        entries: [
          {
            division_id: ctx.divisionId,
            entrant_kind: "team",
            team_name: "Team A",
            players: [{ full_name: "Captain One" }],
            answers: {},
          },
        ],
      } as never,
    );

    const [row] = await sql<{ status: string; entrant_id: string | null }[]>`
      select status, entrant_id from registrations where group_id = ${res.group_id}`;
    expect(row.status).toBe("confirmed");
    expect(row.entrant_id, "a real team still gets a real entrant").not.toBeNull();
  });
});
