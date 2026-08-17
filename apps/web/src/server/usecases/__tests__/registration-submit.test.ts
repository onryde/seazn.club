// RS002 W4 — submitRegistrationGroup (the cart) + joinTeamEntry (the join-a-
// team link). Design: docs/superpowers/specs/2026-08-16-registration-redesign-design.md
// §3/§4/§6. `submitRegistration` (single-entry) was deleted with RS001; this
// is its group-shaped replacement. Real Postgres required; skipped without
// DATABASE_URL.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

// A thin, always-installed wrapper around the REAL generateRefCode — most
// tests never touch `refCodeMock` and get byte-identical behaviour to the
// unmocked module. Two tests below deliberately drive it:
//  - `failOnCall`: throws on the Nth call (atomicity proof — a REAL
//    exception mid-transaction, not a test-only hook in production code).
//  - `fixedNextCalls`: a queue of values to return before falling back to
//    the real generator (collision-retry proof — forces a genuine 23505
//    instead of trusting the DB constraint alone).
const refCodeMock = vi.hoisted(() => ({
  failOnCall: null as number | null,
  callCount: 0,
  fixedNextCalls: [] as string[],
}));
vi.mock("@/lib/ref-code", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ref-code")>();
  return {
    ...actual,
    generateRefCode: () => {
      refCodeMock.callCount++;
      if (refCodeMock.failOnCall === refCodeMock.callCount) {
        throw new Error("forced mid-transaction failure");
      }
      if (refCodeMock.fixedNextCalls.length > 0) return refCodeMock.fixedNextCalls.shift()!;
      return actual.generateRefCode();
    },
  };
});

import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import {
  submitRegistrationGroup,
  joinTeamEntry,
  type SubmitGroupContact,
  type SubmitGroupInput,
} from "../registration-submit";
const HAS_DB = !!process.env.DATABASE_URL;

// ---------------------------------------------------------------------------
// Fixtures — same shape as registrations.test.ts's seedOrg/rig (not exported
// cross-file; this suite creates the whole submit-time state instead of
// seeding rows directly, since submitRegistrationGroup IS the thing under
// test).
// ---------------------------------------------------------------------------

async function makeUser(name: string): Promise<string> {
  const [{ id }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`${name}-${randomUUID().slice(0, 8)}@test.local`}, ${name}, true)
    returning id`;
  return id;
}

async function seedOrg(plan: "community" | "pro" = "pro"): Promise<{
  orgId: string;
  orgSlug: string;
  ownerId: string;
}> {
  const suffix = randomUUID().slice(0, 8);
  const ownerId = await makeUser("owner");
  const orgSlug = "sub-org-" + suffix;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by)
    values (${"Submit Org " + suffix}, ${orgSlug}, ${ownerId}) returning id`;
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${ownerId}, 'owner')`;
  if (plan !== "community") {
    const { setOrgPlan } = await import("@/lib/__tests__/_billing-group");
    await setOrgPlan(orgId, plan);
  }
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('generic', 'Generic', '1.0.0', ${sql.json({ groups: [], lineup: { size: 1, benchMax: 0 } })})
    on conflict (key) do nothing`;
  await sql`
    insert into sport_variants (sport_key, key, name, config, is_system)
    values ('generic', 'score', 'Score',
            ${sql.json({ resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 }, progressScore: false })},
            true)
    on conflict do nothing`;
  return { orgId, orgSlug, ownerId };
}

const asOwner = (orgId: string, userId: string): AuthCtx => ({
  orgId,
  via: "session",
  userId,
  role: "owner",
  keyId: null,
});

async function rig(
  owner: AuthCtx,
  opts: { startsOn?: string } = {},
): Promise<{ competition: { id: string; slug: string }; division: { id: string; slug: string } }> {
  const competition = await createCompetition(owner, {
    name: "Submit Cup " + randomUUID().slice(0, 6),
    visibility: "public",
    branding: {},
    starts_on: opts.startsOn ?? "2026-09-15",
    ends_on: "2026-09-20",
  });
  const division = await createDivision(owner, competition.id, {
    name: "Open",
    sport_key: "generic",
    variant_key: "score",
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    eligibility: [],
  });
  return { competition, division };
}

/** `registration_settings` needs `approval`/`allow_free_agents` (V364) that
 *  `putRegistrationSettings` does not yet write (RS004 territory) — direct
 *  SQL, matching the established fixture-seeding pattern for this schema. */
async function seedSettings(
  divisionId: string,
  over: Partial<{
    enabled: boolean;
    entrant_kind: "team" | "individual" | "pair";
    fee_cents: number;
    capacity: number | null;
    payment_method: "offline" | "stripe";
    approval: "auto" | "manual";
    allow_free_agents: boolean;
    opens_at: string | null;
    closes_at: string | null;
    form_fields: unknown[];
  }> = {},
): Promise<void> {
  await sql`
    insert into registration_settings
      (division_id, enabled, entrant_kind, fee_cents, capacity, payment_method,
       approval, allow_free_agents, opens_at, closes_at, form_fields)
    values (
      ${divisionId}, ${over.enabled ?? true}, ${over.entrant_kind ?? "individual"},
      ${over.fee_cents ?? 0}, ${over.capacity ?? null}, ${over.payment_method ?? "offline"},
      ${over.approval ?? "auto"}, ${over.allow_free_agents ?? false},
      ${over.opens_at ?? null}, ${over.closes_at ?? null},
      ${sql.json((over.form_fields ?? []) as never)}
    )
    on conflict (division_id) do update set
      enabled = excluded.enabled, entrant_kind = excluded.entrant_kind,
      fee_cents = excluded.fee_cents, capacity = excluded.capacity,
      payment_method = excluded.payment_method, approval = excluded.approval,
      allow_free_agents = excluded.allow_free_agents,
      opens_at = excluded.opens_at, closes_at = excluded.closes_at,
      form_fields = excluded.form_fields`;
}

async function setDivisionEligibility(
  divisionId: string,
  over: { category?: string | null; age_min?: number | null; age_max?: number | null; eligibility?: unknown[] } = {},
): Promise<void> {
  await sql`
    update divisions set
      category = ${over.category ?? null},
      age_min = ${over.age_min ?? null},
      age_max = ${over.age_max ?? null},
      eligibility = ${sql.json((over.eligibility ?? []) as never)}
    where id = ${divisionId}`;
}

function baseContact(over: Partial<SubmitGroupContact> = {}): SubmitGroupContact {
  return { name: "Alex Rep", email: `rep-${randomUUID().slice(0, 8)}@test.local`, ...over };
}

beforeEach(() => {
  refCodeMock.failOnCall = null;
  refCodeMock.callCount = 0;
  refCodeMock.fixedNextCalls = [];
});

// ---------------------------------------------------------------------------
// submitRegistrationGroup
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("submitRegistrationGroup", () => {
  it("happy path: a free, auto-approval individual entry confirms immediately", async () => {
    const { orgId, orgSlug, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);
    await seedSettings(division.id, { entrant_kind: "individual", fee_cents: 0 });

    const res = await submitRegistrationGroup(
      { orgSlug, compSlug: competition.slug },
      {
        contact: baseContact(),
        privacy_consent: true,
        entries: [
          {
            division_id: division.id,
            entrant_kind: "individual",
            players: [{ full_name: "Solo Player" }],
            answers: {},
          },
        ],
      },
    );

    expect(res.entries).toHaveLength(1);
    expect(res.entries[0]!.status).toBe("confirmed");
    expect(res.access_token).toEqual(expect.any(String));
    const [row] = await sql<{ entrant_id: string | null; status: string }[]>`
      select entrant_id, status from registrations where id = ${res.entries[0]!.registration_id}`;
    expect(row!.status).toBe("confirmed");
    expect(row!.entrant_id).not.toBeNull();
  });

  it("privacy consent (GDPR) is required — a submission without it is refused", async () => {
    const { orgId, orgSlug, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);
    await seedSettings(division.id, { entrant_kind: "individual", fee_cents: 0 });

    const input: SubmitGroupInput = {
      contact: baseContact(),
      privacy_consent: false,
      entries: [
        { division_id: division.id, entrant_kind: "individual", players: [{ full_name: "No Consent" }], answers: {} },
      ],
    };
    await expect(
      submitRegistrationGroup({ orgSlug, compSlug: competition.slug }, input),
    ).rejects.toMatchObject({ status: 422 });

    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from registration_groups where competition_id = ${competition.id}`;
    expect(n).toBe(0);
  });

  it("manual-approval division holds pending even when free and under capacity; auto division still confirms", async () => {
    const { orgId, orgSlug, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);
    await seedSettings(division.id, { entrant_kind: "individual", fee_cents: 0, approval: "manual" });

    const res = await submitRegistrationGroup(
      { orgSlug, compSlug: competition.slug },
      {
        contact: baseContact(),
        privacy_consent: true,
        entries: [
          { division_id: division.id, entrant_kind: "individual", players: [{ full_name: "Waits For Review" }], answers: {} },
        ],
      },
    );
    expect(res.entries[0]!.status).toBe("pending");
    const [row] = await sql<{ entrant_id: string | null }[]>`
      select entrant_id from registrations where id = ${res.entries[0]!.registration_id}`;
    expect(row!.entrant_id).toBeNull();
  });

  it("mixed division rejects an all-male roster; accepts m+f; x rows block nothing", async () => {
    const { orgId, orgSlug, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);
    await seedSettings(division.id, { entrant_kind: "team", fee_cents: 0 });
    await setDivisionEligibility(division.id, { category: "mixed" });

    const allMale: SubmitGroupInput = {
      contact: baseContact(),
      privacy_consent: true,
      entries: [
        {
          division_id: division.id,
          entrant_kind: "team",
          team_name: "All Male",
          players: [
            { full_name: "M One", gender: "m" },
            { full_name: "M Two", gender: "m" },
          ],
          answers: {},
        },
      ],
    };
    await expect(
      submitRegistrationGroup({ orgSlug, compSlug: competition.slug }, allMale),
    ).rejects.toMatchObject({ status: 422 });

    const mixedOk = await submitRegistrationGroup(
      { orgSlug, compSlug: competition.slug },
      {
        contact: baseContact(),
        privacy_consent: true,
        entries: [
          {
            division_id: division.id,
            entrant_kind: "team",
            team_name: "Balanced",
            players: [
              { full_name: "M One", gender: "m" },
              { full_name: "F One", gender: "f" },
              { full_name: "X One", gender: "x" },
            ],
            answers: {},
          },
        ],
      },
    );
    expect(mixedOk.entries[0]!.status).not.toBe("waitlisted");

    // An all-x-plus-one-gender roster still fails: x counts toward NEITHER
    // side of the mixed rule (it never itself blocks, but it never SATISFIES
    // the "needs at least one of each" rule either).
    const xPlusMaleOnly: SubmitGroupInput = {
      contact: baseContact(),
      privacy_consent: true,
      entries: [
        {
          division_id: division.id,
          entrant_kind: "team",
          team_name: "X Plus Male",
          players: [
            { full_name: "M One", gender: "m" },
            { full_name: "X One", gender: "x" },
          ],
          answers: {},
        },
      ],
    };
    await expect(
      submitRegistrationGroup({ orgSlug, compSlug: competition.slug }, xPlusMaleOnly),
    ).rejects.toMatchObject({ status: 422 });
  });

  it("age band: an over/under player yields a per-player issue naming the row index", async () => {
    const { orgId, orgSlug, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner, { startsOn: "2026-09-15" });
    await seedSettings(division.id, { entrant_kind: "team", fee_cents: 0 });
    await setDivisionEligibility(division.id, { age_min: 10, age_max: 15 });

    const input: SubmitGroupInput = {
      contact: baseContact(),
      privacy_consent: true,
      entries: [
        {
          division_id: division.id,
          entrant_kind: "team",
          team_name: "Age Band",
          players: [
            { full_name: "In Band", dob: "2014-01-01" }, // 12 on 2026 cutoff
            { full_name: "Too Old", dob: "1990-01-01" }, // row 2
          ],
          answers: {},
        },
      ],
    };
    try {
      await submitRegistrationGroup({ orgSlug, compSlug: competition.slug }, input);
      throw new Error("expected a 422");
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      const he = err as HttpError;
      expect(he.status).toBe(422);
      expect(he.message).toContain("Player 2");
      const violations = he.extra?.violations as { playerIndex?: number; code: string }[] | undefined;
      expect(violations?.some((v) => v.playerIndex === 2 && v.code === "AGE_TOO_OLD")).toBe(true);
    }
  });

  it("the self player row carries user_id when registering_self and the session is an adult with a dob; not otherwise", async () => {
    const { orgId, orgSlug, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);
    await seedSettings(division.id, { entrant_kind: "individual", fee_cents: 0 });
    const sessionUserId = await makeUser("selfplayer");

    const adultSelf = await submitRegistrationGroup(
      { orgSlug, compSlug: competition.slug, sessionUserId },
      {
        contact: baseContact({ dob: "1990-01-01" }),
        privacy_consent: true,
        entries: [
          {
            division_id: division.id,
            entrant_kind: "individual",
            registering_self: true,
            self_player_index: 0,
            players: [{ full_name: "Alex Rep" }],
            answers: {},
          },
        ],
      },
    );
    const [linkedRow] = await sql<{ user_id: string | null }[]>`
      select user_id from registration_players where registration_id = ${adultSelf.entries[0]!.registration_id}`;
    expect(linkedRow!.user_id).toBe(sessionUserId);

    // Not registering_self -> no link, even though signed in and an adult.
    // (A second division in the SAME competition — rig() would mint a fresh
    // competition, and this cart's ctx is scoped to the first one.)
    const division2 = await createDivision(owner, competition.id, {
      name: "Second",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
      eligibility: [],
    });
    await seedSettings(division2.id, { entrant_kind: "individual", fee_cents: 0 });
    const notSelf = await submitRegistrationGroup(
      { orgSlug, compSlug: competition.slug, sessionUserId },
      {
        contact: baseContact({ dob: "1990-01-01" }),
        privacy_consent: true,
        entries: [
          {
            division_id: division2.id,
            entrant_kind: "individual",
            registering_self: false,
            players: [{ full_name: "Someone Else" }],
            answers: {},
          },
        ],
      },
    );
    const [unlinkedRow] = await sql<{ user_id: string | null }[]>`
      select user_id from registration_players where registration_id = ${notSelf.entries[0]!.registration_id}`;
    expect(unlinkedRow!.user_id).toBeNull();
  });

  it("cart of 3 with 1 waitlisted: group amount_cents charges 2; the waitlisted entry's own amount_cents is 0", async () => {
    const { orgId, orgSlug, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);
    // capacity 2: two entries fit, the third waitlists.
    await seedSettings(division.id, { entrant_kind: "individual", fee_cents: 500, capacity: 2 });

    const res = await submitRegistrationGroup(
      { orgSlug, compSlug: competition.slug },
      {
        contact: baseContact(),
        privacy_consent: true,
        entries: [
          { division_id: division.id, entrant_kind: "individual", players: [{ full_name: "P1" }], answers: {} },
          { division_id: division.id, entrant_kind: "individual", players: [{ full_name: "P2" }], answers: {} },
          { division_id: division.id, entrant_kind: "individual", players: [{ full_name: "P3" }], answers: {} },
        ],
      },
    );

    const waitlisted = res.entries.filter((e) => e.status === "waitlisted");
    const notWaitlisted = res.entries.filter((e) => e.status !== "waitlisted");
    expect(waitlisted).toHaveLength(1);
    expect(notWaitlisted).toHaveLength(2);
    // NOTE (deviation, recorded — see final report): the brief's acceptance
    // text says the waitlisted entry's own amount_cents "reflects its fee"
    // (nonzero). That conflicts with THREE independent precedents: old
    // submitRegistration's insert (`waitlisted ? 0 : fee`),
    // promoteOldestWaitlisted's snapshot-at-promotion design, and the
    // documented fixture-seeding invariant ("Waitlisted rows must hold
    // amount_cents=0"). Implemented amount_cents=0 for a waitlisted entry,
    // matching the 3-source precedent.
    expect(waitlisted[0]!.amount_cents).toBe(0);
    expect(notWaitlisted.every((e) => e.amount_cents === 500)).toBe(true);
    expect(res.amount_cents).toBe(1000); // 2 * 500, waitlisted contributes 0

    const [group] = await sql<{ amount_cents: number }[]>`
      select amount_cents from registration_groups where id = ${res.group_id}`;
    expect(group!.amount_cents).toBe(1000);
  });

  it("group insert snapshots organizations.currency; a later org-currency change leaves existing groups untouched", async () => {
    const { orgId, orgSlug, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    await sql`update organizations set currency = 'eur' where id = ${orgId}`;
    const { competition, division } = await rig(owner);
    await seedSettings(division.id, { entrant_kind: "individual", fee_cents: 0 });

    const res = await submitRegistrationGroup(
      { orgSlug, compSlug: competition.slug },
      {
        contact: baseContact(),
        privacy_consent: true,
        entries: [
          { division_id: division.id, entrant_kind: "individual", players: [{ full_name: "Euro Payer" }], answers: {} },
        ],
      },
    );
    expect(res.currency).toBe("eur");

    await sql`update organizations set currency = 'usd' where id = ${orgId}`;
    const [group] = await sql<{ currency: string }[]>`
      select currency from registration_groups where id = ${res.group_id}`;
    expect(group!.currency).toBe("eur"); // untouched by the later org change
  });

  it("group insert is atomic: a forced failure mid-transaction leaves nothing persisted", async () => {
    const { orgId, orgSlug, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);
    await seedSettings(division.id, { entrant_kind: "team", fee_cents: 0, approval: "auto" });

    // Call order inside submitRegistrationGroup: 1 = the group's own
    // ref_code, 2 = entry 1's join_code (team), 3 = entry 2's join_code.
    // Entry 1 fully commits (and, being free+auto, materialises an entrant)
    // BEFORE entry 2's join_code mint throws — the strongest available proof
    // that a mid-transaction failure unwinds EVERYTHING, not just the row
    // that failed.
    refCodeMock.failOnCall = 3;

    await expect(
      submitRegistrationGroup(
        { orgSlug, compSlug: competition.slug },
        {
          contact: baseContact(),
          privacy_consent: true,
          entries: [
            {
              division_id: division.id,
              entrant_kind: "team",
              team_name: "Team One",
              players: [{ full_name: "P1" }],
              answers: {},
            },
            {
              division_id: division.id,
              entrant_kind: "team",
              team_name: "Team Two",
              players: [{ full_name: "P2" }],
              answers: {},
            },
          ],
        },
      ),
    ).rejects.toThrow("forced mid-transaction failure");

    const [{ n: groups }] = await sql<{ n: number }[]>`
      select count(*)::int as n from registration_groups where competition_id = ${competition.id}`;
    expect(groups).toBe(0);
    const [{ n: regs }] = await sql<{ n: number }[]>`
      select count(*)::int as n from registrations where division_id = ${division.id}`;
    expect(regs).toBe(0);
    const [{ n: players }] = await sql<{ n: number }[]>`
      select count(*)::int as n from registration_players rp
      join registrations r on r.id = rp.registration_id where r.division_id = ${division.id}`;
    expect(players).toBe(0);
    const [{ n: entrants }] = await sql<{ n: number }[]>`
      select count(*)::int as n from entrants where division_id = ${division.id}`;
    expect(entrants).toBe(0);
  });

  it("join_code is generated for team entries only, and retries past a real collision to stay globally unique", async () => {
    const { orgId, orgSlug, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);
    await seedSettings(division.id, { entrant_kind: "team", fee_cents: 0 });
    const soloDivision = await createDivision(owner, competition.id, {
      name: "Solo",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
      eligibility: [],
    });
    await seedSettings(soloDivision.id, { entrant_kind: "individual", fee_cents: 0 });

    const first = await submitRegistrationGroup(
      { orgSlug, compSlug: competition.slug },
      {
        contact: baseContact(),
        privacy_consent: true,
        entries: [
          {
            division_id: division.id,
            entrant_kind: "team",
            team_name: "Team First",
            players: [{ full_name: "P1" }],
            answers: {},
          },
          {
            division_id: soloDivision.id,
            entrant_kind: "individual",
            players: [{ full_name: "Solo" }],
            answers: {},
          },
        ],
      },
    );
    const teamEntry = first.entries.find((e) => e.division_id === division.id)!;
    const soloEntry = first.entries.find((e) => e.division_id === soloDivision.id)!;
    expect(teamEntry.join_code).toEqual(expect.any(String));
    expect(soloEntry.join_code).toBeNull();

    // Force call 2 (this next submit's own group ref_code is call 1; its
    // team entry's join_code is call 2) to collide with the FIRST team's
    // already-committed join_code — a real 23505 on
    // registrations_join_code_key, not a hoped-for one.
    refCodeMock.fixedNextCalls = [`FAKE-REF-${randomUUID().slice(0, 6)}`, teamEntry.join_code!];
    const second = await submitRegistrationGroup(
      { orgSlug, compSlug: competition.slug },
      {
        contact: baseContact(),
        privacy_consent: true,
        entries: [
          {
            division_id: division.id,
            entrant_kind: "team",
            team_name: "Team Second",
            players: [{ full_name: "P2" }],
            answers: {},
          },
        ],
      },
    );
    const secondCode = second.entries[0]!.join_code;
    expect(secondCode).toEqual(expect.any(String));
    expect(secondCode).not.toBe(teamEntry.join_code);
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from registrations where join_code = ${secondCode}`;
    expect(n).toBe(1);
  });
});

describe.skipIf(!HAS_DB)("submitRegistrationGroup — capacity race (genuine concurrency)", () => {
  it("two concurrent submits racing the last slot: exactly one confirmed, one waitlisted", async () => {
    const { orgId, orgSlug, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);
    await seedSettings(division.id, { entrant_kind: "individual", fee_cents: 0, capacity: 1 });

    const ctx = { orgSlug, compSlug: competition.slug };
    const inputFor = (name: string): SubmitGroupInput => ({
      contact: baseContact({ name }),
      privacy_consent: true,
      entries: [
        { division_id: division.id, entrant_kind: "individual", players: [{ full_name: name }], answers: {} },
      ],
    });

    // The interleave is FORCED, not hoped for (same technique as
    // billing-group-move.test.ts's "an attach racing a detach" — holding
    // `for update` on the row from a transaction of our own makes both
    // racers queue at a point we choose, rather than betting on Promise.all
    // scheduling luck). With the capacity lock in submitRegistrationGroup,
    // both racers queue BEHIND this held lock and each sees fresh state once
    // it is released; without that lock they'd both already have read the
    // pre-race count by the time this releases, and both would land pending.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const holder = sql.begin(async (tx) => {
      await tx`select 1 from registration_settings where division_id = ${division.id} for update`;
      await held;
    });
    await new Promise((r) => setTimeout(r, 100));

    const racing = Promise.all([submitRegistrationGroup(ctx, inputFor("Racer A")), submitRegistrationGroup(ctx, inputFor("Racer B"))]);
    // Long enough for both to have reached their own first statement.
    await new Promise((r) => setTimeout(r, 400));
    release();
    await holder;
    const [a, b] = await racing;

    const statuses = [a.entries[0]!.status, b.entries[0]!.status].sort();
    expect(statuses).toEqual(["confirmed", "waitlisted"]);
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from registrations
      where division_id = ${division.id} and status in ('pending','confirmed')`;
    expect(n).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// joinTeamEntry
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("joinTeamEntry", () => {
  // generic's lineup is { size: 1, benchMax: 0 } -> squad cap 1. The team is
  // seeded with ZERO captain-entered players (submitRegistrationGroup allows
  // an empty team roster on purpose — a captain can create the entry and
  // share the join link before typing anyone in) so each test controls
  // exactly how many join calls it makes before hitting that cap.
  async function teamRig() {
    const { orgId, orgSlug, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);
    await seedSettings(division.id, { entrant_kind: "team", fee_cents: 0 });
    const submitted = await submitRegistrationGroup(
      { orgSlug, compSlug: competition.slug },
      {
        contact: baseContact(),
        privacy_consent: true,
        entries: [
          {
            division_id: division.id,
            entrant_kind: "team",
            team_name: "Joinable Team",
            players: [],
            answers: {},
          },
        ],
      },
    );
    return { orgId, orgSlug, competition, division, entry: submitted.entries[0]! };
  }

  it("happy path: an adult player joins via the code and is linked when signed in", async () => {
    const { entry } = await teamRig();
    const sessionUserId = await makeUser("joiner");
    const res = await joinTeamEntry(
      { sessionUserId },
      { join_code: entry.join_code!, player: { full_name: "New Joiner", dob: "1995-05-01" } },
    );
    expect(res.consent_status).toBe("granted");
    const [row] = await sql<{ user_id: string | null; source: string; consent_status: string }[]>`
      select user_id, source, consent_status from registration_players where id = ${res.player_id}`;
    expect(row!.source).toBe("self_joined");
    expect(row!.consent_status).toBe("granted");
    expect(row!.user_id).toBe(sessionUserId);
  });

  it("full-roster rejection: joining is refused once the sport's squad cap is reached", async () => {
    const { entry } = await teamRig();
    // Fills the cap (1) — must succeed before the cap can be proven.
    await joinTeamEntry({}, { join_code: entry.join_code!, player: { full_name: "First In" } });
    await expect(
      joinTeamEntry({}, { join_code: entry.join_code!, player: { full_name: "One Too Many" } }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it("dead/unknown code rejection", async () => {
    await expect(
      joinTeamEntry({}, { join_code: "SZ-0000-0000", player: { full_name: "Nobody" } }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("withdrawn-entry rejection", async () => {
    const { entry } = await teamRig();
    await sql`update registrations set status = 'withdrawn' where id = ${entry.registration_id}`;
    await expect(
      joinTeamEntry({}, { join_code: entry.join_code!, player: { full_name: "Too Late" } }),
    ).rejects.toMatchObject({ status: 422 });
  });
});
