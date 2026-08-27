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
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { LEGAL_VERSION } from "@/lib/legal";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import {
  submitRegistrationGroup,
  joinTeamEntry,
  previewJoinEntry,
  type SubmitGroupContact,
  type SubmitGroupEntryInput,
  type SubmitGroupEntryResult,
  type SubmitGroupInput,
} from "../registration-submit";
const HAS_DB = !!process.env.DATABASE_URL;

/**
 * Poll `pg_locks` for genuinely blocked waiters instead of a fixed sleep
 * (review MAJOR 5 — same technique as `slug-race.test.ts`'s
 * `waitForBlockedInsert`, generalised to a caller-chosen count since this
 * file's capacity race needs TWO simultaneous waiters, not one). A sleep
 * "long enough" is a guess; this waits for the actual fact.
 */
async function waitForBlockedLocks(count: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const [row] = await sql<{ n: number }[]>`select count(*)::int as n from pg_locks where not granted`;
    if (row!.n >= count) return;
    if (Date.now() > deadline) {
      throw new Error(`only ${row!.n}/${count} blocked locks appeared — race not staged`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

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
  over: { category?: string | null; age_min?: number | null; age_max?: number | null } = {},
): Promise<void> {
  await sql`
    update divisions set
      category = ${over.category ?? null},
      age_min = ${over.age_min ?? null},
      age_max = ${over.age_max ?? null}
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
    const [group] = await sql<{ privacy_consent_at: Date | null; privacy_consent_version: string | null }[]>`
      select privacy_consent_at, privacy_consent_version from registration_groups where id = ${res.group_id}`;
    expect(group!.privacy_consent_at).not.toBeNull();
    expect(group!.privacy_consent_version).toBe(LEGAL_VERSION);
  });

  it("media consent, when given, stamps media_consent_at/media_consent_version the same way privacy_consent does", async () => {
    const { orgId, orgSlug, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);
    await seedSettings(division.id, { entrant_kind: "individual", fee_cents: 0 });

    const res = await submitRegistrationGroup(
      { orgSlug, compSlug: competition.slug },
      {
        contact: baseContact(),
        privacy_consent: true,
        media_consent: true,
        entries: [
          { division_id: division.id, entrant_kind: "individual", players: [{ full_name: "Media Yes" }], answers: {} },
        ],
      },
    );

    const [group] = await sql<{ media_consent_at: Date | null; media_consent_version: string | null }[]>`
      select media_consent_at, media_consent_version from registration_groups where id = ${res.group_id}`;
    expect(group!.media_consent_at).not.toBeNull();
    expect(group!.media_consent_version).toBe(LEGAL_VERSION);
  });

  it("media consent, when omitted, leaves media_consent_at/media_consent_version null and never blocks submit", async () => {
    const { orgId, orgSlug, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);
    await seedSettings(division.id, { entrant_kind: "individual", fee_cents: 0 });

    const res = await submitRegistrationGroup(
      { orgSlug, compSlug: competition.slug },
      {
        contact: baseContact(),
        privacy_consent: true,
        // media_consent intentionally omitted — optional, must never block submit.
        entries: [
          { division_id: division.id, entrant_kind: "individual", players: [{ full_name: "No Media" }], answers: {} },
        ],
      },
    );

    expect(res.entries[0]!.status).toBe("confirmed");
    const [group] = await sql<{ media_consent_at: Date | null; media_consent_version: string | null }[]>`
      select media_consent_at, media_consent_version from registration_groups where id = ${res.group_id}`;
    expect(group!.media_consent_at).toBeNull();
    expect(group!.media_consent_version).toBeNull();
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

  it("guardian consent is required when the contact is a minor registering themselves", async () => {
    const { orgId, orgSlug, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);
    await seedSettings(division.id, { entrant_kind: "individual", fee_cents: 0 });

    const minorEntry: SubmitGroupEntryInput = {
      division_id: division.id,
      entrant_kind: "individual",
      registering_self: true,
      self_player_index: 0,
      players: [{ full_name: "Young Player" }],
      answers: {},
    };
    // No guardian fields -> refused.
    await expect(
      submitRegistrationGroup(
        { orgSlug, compSlug: competition.slug },
        { contact: baseContact({ dob: "2015-01-01" }), privacy_consent: true, entries: [minorEntry] },
      ),
    ).rejects.toMatchObject({ status: 422 });

    // With guardian name + consent -> accepted, and the self row records
    // 'granted' (submit-time consent), not 'guardian' — the design's
    // guardian gate is about WHO may submit for a minor, not the player
    // row's own consent_status, which materialise/claim semantics elsewhere
    // in `registrations.ts` already treat uniformly for captain-entered rows.
    const res = await submitRegistrationGroup(
      { orgSlug, compSlug: competition.slug },
      {
        contact: baseContact({ dob: "2015-01-01", guardian_name: "A Guardian", guardian_consent: true }),
        privacy_consent: true,
        entries: [minorEntry],
      },
    );
    expect(res.entries).toHaveLength(1);
    const [row] = await sql<{ guardian_name: string | null; consent_status: string }[]>`
      select guardian_name, consent_status from registration_players
      where registration_id = ${res.entries[0]!.registration_id}`;
    expect(row!.guardian_name).toBe("A Guardian");
    expect(row!.consent_status).toBe("granted");
  });

  it("guardian consent bypass fix: a MINOR dob typed directly onto the self roster row is caught even when contact.dob is an ADULT", async () => {
    const { orgId, orgSlug, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);
    await seedSettings(division.id, { entrant_kind: "individual", fee_cents: 0 });

    // The roster row's OWN dob is a minor's — this must win over the adult
    // contact.dob for the guardian gate, the same `p.dob ?? contact.dob`
    // fallback the persisted player row itself gets (~line 412-416).
    // roster-table.tsx renders this row's dob as a plain editable
    // <input type="date"> with no readOnly/disabled, so a real registrant
    // can type exactly this.
    const entry: SubmitGroupEntryInput = {
      division_id: division.id,
      entrant_kind: "individual",
      registering_self: true,
      self_player_index: 0,
      players: [{ full_name: "Self Row", dob: "2015-01-01" }],
      answers: {},
    };

    await expect(
      submitRegistrationGroup(
        { orgSlug, compSlug: competition.slug },
        { contact: baseContact({ dob: "1990-01-01" }), privacy_consent: true, entries: [entry] },
      ),
    ).rejects.toMatchObject({ status: 422 });

    // Nothing persisted — same "refused submissions leave no trace" proof
    // the privacy-consent test above uses.
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from registration_groups where competition_id = ${competition.id}`;
    expect(n).toBe(0);
  });

  it("an entry's declared entrant_kind must match the division's configured kind (review MINOR: entrant_kind mismatch)", async () => {
    const { orgId, orgSlug, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);
    await seedSettings(division.id, { entrant_kind: "team", fee_cents: 0 });

    await expect(
      submitRegistrationGroup(
        { orgSlug, compSlug: competition.slug },
        {
          contact: baseContact(),
          privacy_consent: true,
          entries: [
            {
              division_id: division.id,
              entrant_kind: "individual", // division is configured "team"
              players: [{ full_name: "Wrong Kind" }],
              answers: {},
            },
          ],
        },
      ),
    ).rejects.toMatchObject({ status: 422 });

    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from registration_groups where competition_id = ${competition.id}`;
    expect(n).toBe(0);
  });

  it("free_agent is only accepted when the division's allow_free_agents is on", async () => {
    const { orgId, orgSlug, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);
    await seedSettings(division.id, { entrant_kind: "team", fee_cents: 0, allow_free_agents: false });

    await expect(
      submitRegistrationGroup(
        { orgSlug, compSlug: competition.slug },
        {
          contact: baseContact(),
          privacy_consent: true,
          entries: [
            { division_id: division.id, entrant_kind: "team", free_agent: true, players: [{ full_name: "Floater" }], answers: {} },
          ],
        },
      ),
    ).rejects.toMatchObject({ status: 422 });

    await seedSettings(division.id, { entrant_kind: "team", fee_cents: 0, allow_free_agents: true });
    const res = await submitRegistrationGroup(
      { orgSlug, compSlug: competition.slug },
      {
        contact: baseContact(),
        privacy_consent: true,
        entries: [
          { division_id: division.id, entrant_kind: "team", free_agent: true, players: [{ full_name: "Floater" }], answers: {} },
        ],
      },
    );
    expect(res.entries[0]!.free_agent).toBe(true);
    // Never auto-materialised, even free + auto-approval — no team to attach
    // an entrant to yet (design §5; RS009 owns assignment).
    expect(res.entries[0]!.status).toBe("pending");
    const [row] = await sql<{ entrant_id: string | null }[]>`
      select entrant_id from registrations where id = ${res.entries[0]!.registration_id}`;
    expect(row!.entrant_id).toBeNull();
    // A free agent is `entrant_kind: "team"` at the division level but is
    // NOT a roster to grow (review MAJOR 4) — no join_code, even though
    // every other team entry gets one.
    expect(res.entries[0]!.join_code).toBeNull();
  });

  it("joinTeamEntry refuses a free-agent entry, even if one somehow carried a join_code", async () => {
    const { orgId, orgSlug, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);
    await seedSettings(division.id, { entrant_kind: "team", fee_cents: 0, allow_free_agents: true });
    const res = await submitRegistrationGroup(
      { orgSlug, compSlug: competition.slug },
      {
        contact: baseContact(),
        privacy_consent: true,
        entries: [
          { division_id: division.id, entrant_kind: "team", free_agent: true, players: [{ full_name: "Floater" }], answers: {} },
        ],
      },
    );
    // Defense in depth: submitRegistrationGroup never mints a join_code for
    // a free agent (asserted above) — force one directly to prove
    // joinTeamEntry ALSO refuses it, not just that the code path is
    // unreachable through normal submit.
    const forcedCode = "SZ-FORCED-" + randomUUID().slice(0, 8); // unique per run — join_code is globally unique
    await sql`update registrations set join_code = ${forcedCode} where id = ${res.entries[0]!.registration_id}`;
    await expect(
      joinTeamEntry({}, { join_code: forcedCode, player: { full_name: "Trying To Join" } }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it("a cart mixing payment methods across divisions is refused at validation time (review MAJOR 1)", async () => {
    const { orgId, orgSlug, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    await sql`update organizations set stripe_charges_enabled = true where id = ${orgId}`;
    const { competition, division: stripeDivision } = await rig(owner);
    await seedSettings(stripeDivision.id, { entrant_kind: "individual", fee_cents: 1000, payment_method: "stripe" });
    const offlineDivision = await createDivision(owner, competition.id, {
      name: "Offline Side",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    });
    await seedSettings(offlineDivision.id, { entrant_kind: "individual", fee_cents: 500, payment_method: "offline" });

    await expect(
      submitRegistrationGroup(
        { orgSlug, compSlug: competition.slug },
        {
          contact: baseContact(),
          privacy_consent: true,
          entries: [
            { division_id: stripeDivision.id, entrant_kind: "individual", players: [{ full_name: "Card Payer" }], answers: {} },
            { division_id: offlineDivision.id, entrant_kind: "individual", players: [{ full_name: "Cash Payer" }], answers: {} },
          ],
        },
      ),
    ).rejects.toMatchObject({ status: 422 });

    // Rejected at VALIDATION time — before any transaction opens, so nothing
    // was written at all (not even the group).
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from registration_groups where competition_id = ${competition.id}`;
    expect(n).toBe(0);

    // A cart entirely within ONE payment method (even a free entry alongside
    // it — fee_cents=0 imposes no method constraint) is unaffected.
    await seedSettings(offlineDivision.id, { entrant_kind: "individual", fee_cents: 0, payment_method: "offline" });
    const ok = await submitRegistrationGroup(
      { orgSlug, compSlug: competition.slug },
      {
        contact: baseContact(),
        privacy_consent: true,
        entries: [
          { division_id: stripeDivision.id, entrant_kind: "individual", players: [{ full_name: "Card Payer" }], answers: {} },
          { division_id: offlineDivision.id, entrant_kind: "individual", players: [{ full_name: "Free Rider" }], answers: {} },
        ],
      },
    );
    expect(ok.entries).toHaveLength(2);
  });

  it("a stripe-fee division 503s when Connect isn't live, and 402s when registration.paid is revoked", async () => {
    const { orgId, orgSlug, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);
    await seedSettings(division.id, { entrant_kind: "individual", fee_cents: 1000, payment_method: "stripe" });
    const input: SubmitGroupInput = {
      contact: baseContact(),
      privacy_consent: true,
      entries: [
        { division_id: division.id, entrant_kind: "individual", players: [{ full_name: "Card Payer" }], answers: {} },
      ],
    };

    // Connect never went live (stripe_charges_enabled defaults false) -> 503,
    // never reaching the entitlement check.
    await expect(
      submitRegistrationGroup({ orgSlug, compSlug: competition.slug }, input),
    ).rejects.toMatchObject({ status: 503 });

    // Connect live, but registration.paid explicitly revoked -> 402.
    await sql`update organizations set stripe_charges_enabled = true where id = ${orgId}`;
    await sql`
      insert into org_entitlement_overrides (org_id, feature_key, bool_value)
      values (${orgId}, 'registration.paid', false)`;
    await invalidateOrgEntitlements(orgId);
    await expect(
      submitRegistrationGroup({ orgSlug, compSlug: competition.slug }, input),
    ).rejects.toMatchObject({ status: 402 });
  });

  it("a uniform-stripe cart works when Connect is live and registration.paid is granted", async () => {
    const { orgId, orgSlug, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    await sql`update organizations set stripe_charges_enabled = true where id = ${orgId}`;
    const { competition, division } = await rig(owner);
    await seedSettings(division.id, { entrant_kind: "individual", fee_cents: 1000, payment_method: "stripe" });

    const res = await submitRegistrationGroup(
      { orgSlug, compSlug: competition.slug },
      {
        contact: baseContact(),
        privacy_consent: true,
        entries: [
          { division_id: division.id, entrant_kind: "individual", players: [{ full_name: "Card Payer" }], answers: {} },
        ],
      },
    );
    // Fee due -> never auto-confirmed; the group needs its payment method +
    // a pay-by window.
    expect(res.entries[0]!.status).toBe("pending");
    expect(res.amount_cents).toBe(1000);
    const [group] = await sql<{ payment_method: string | null; expires_at: Date | null }[]>`
      select payment_method, expires_at from registration_groups where id = ${res.group_id}`;
    expect(group!.payment_method).toBe("stripe");
    expect(group!.expires_at).not.toBeNull();
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

  // RS006: the cart-wide "at most one self entry" cap was removed from the
  // schema — this proves the usecase/persons layer the brief's analysis
  // rested on actually behaves as claimed, against a real DB rather than
  // trusting the reading: deriveLinkUserId is per-entry (no cart-wide
  // state), and resolvePlayerPerson's on-conflict upsert on (org_id,
  // user_id, 'player') means a SECOND self-linked entry for the same
  // session resolves to the SAME persons row instead of erroring or
  // duplicating.
  it("two self-linked entries in ONE cart both link the session user, and resolve to ONE persons row", async () => {
    const { orgId, orgSlug, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);
    await seedSettings(division.id, { entrant_kind: "individual", fee_cents: 0 });
    const division2 = await createDivision(owner, competition.id, {
      name: "Second",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    });
    await seedSettings(division2.id, { entrant_kind: "individual", fee_cents: 0 });
    const sessionUserId = await makeUser("multiself");

    const res = await submitRegistrationGroup(
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
            players: [{ full_name: "Multi Self" }],
            answers: {},
          },
          {
            division_id: division2.id,
            entrant_kind: "individual",
            registering_self: true,
            self_player_index: 0,
            players: [{ full_name: "Multi Self" }],
            answers: {},
          },
        ],
      },
    );

    expect(res.entries).toHaveLength(2);
    expect(res.entries.every((e) => e.status === "confirmed")).toBe(true);

    const linkedRows = await sql<{ user_id: string | null }[]>`
      select user_id from registration_players
       where registration_id in (${res.entries[0]!.registration_id}, ${res.entries[1]!.registration_id})`;
    expect(linkedRows).toHaveLength(2);
    expect(linkedRows.every((r) => r.user_id === sessionUserId)).toBe(true);

    const persons = await sql<{ id: string }[]>`
      select id from persons where org_id = ${orgId} and user_id = ${sessionUserId} and lane = 'player'`;
    expect(persons).toHaveLength(1);

    const regs = await sql<{ entrant_id: string | null }[]>`
      select entrant_id from registrations
       where id in (${res.entries[0]!.registration_id}, ${res.entries[1]!.registration_id})`;
    expect(regs.every((r) => r.entrant_id !== null)).toBe(true);
    const members = await sql<{ person_id: string }[]>`
      select person_id from entrant_members
       where entrant_id in (${regs[0]!.entrant_id as string}, ${regs[1]!.entrant_id as string})`;
    expect(members).toHaveLength(2);
    expect(members[0]!.person_id).toBe(members[1]!.person_id);
    expect(members[0]!.person_id).toBe(persons[0]!.id);
  });

  it("links the self row's OWN dob when the contact never repeated one at cart level (review MINOR 6)", async () => {
    const { orgId, orgSlug, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);
    await seedSettings(division.id, { entrant_kind: "individual", fee_cents: 0 });
    const sessionUserId = await makeUser("explicitdob");

    const res = await submitRegistrationGroup(
      { orgSlug, compSlug: competition.slug, sessionUserId },
      {
        contact: baseContact({ dob: null }), // cart-level dob left blank
        privacy_consent: true,
        entries: [
          {
            division_id: division.id,
            entrant_kind: "individual",
            registering_self: true,
            self_player_index: 0,
            // The row itself carries an explicit adult dob.
            players: [{ full_name: "Explicit Dob", dob: "1990-01-01" }],
            answers: {},
          },
        ],
      },
    );
    const [row] = await sql<{ user_id: string | null }[]>`
      select user_id from registration_players where registration_id = ${res.entries[0]!.registration_id}`;
    expect(row!.user_id).toBe(sessionUserId);
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

  it("the PLAN cap folds into hardCap — a low plan limit drives the waitlist under a high division capacity (review MINOR: plan-cap folding)", async () => {
    const { orgId, orgSlug, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);
    // Division capacity is generous (10) — the PLAN must be what binds.
    await seedSettings(division.id, { entrant_kind: "individual", fee_cents: 0, capacity: 10 });
    await sql`
      insert into org_entitlement_overrides (org_id, feature_key, int_value, reason)
      values (${orgId}, 'entrants.per_division.max', 1, 'test — plan-cap-folding coverage')`;
    await invalidateOrgEntitlements(orgId);

    const res = await submitRegistrationGroup(
      { orgSlug, compSlug: competition.slug },
      {
        contact: baseContact(),
        privacy_consent: true,
        entries: [
          { division_id: division.id, entrant_kind: "individual", players: [{ full_name: "P1" }], answers: {} },
          { division_id: division.id, entrant_kind: "individual", players: [{ full_name: "P2" }], answers: {} },
        ],
      },
    );
    expect(res.entries[0]!.status).not.toBe("waitlisted"); // taken=0 < plan limit 1
    expect(res.entries[1]!.status).toBe("waitlisted"); // taken=1 >= plan limit 1, well under division.capacity=10
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

  it("join_code is generated for team (and pair) entries only, and retries past a real collision to stay globally unique", async () => {
    const { orgId, orgSlug, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);
    await seedSettings(division.id, { entrant_kind: "team", fee_cents: 0 });
    const soloDivision = await createDivision(owner, competition.id, {
      name: "Solo",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
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

    // The interleave is FORCED, not hoped for (same underlying mechanism as
    // billing-group-move.test.ts's "an attach racing a detach" — holding
    // `for update` on the row from a transaction of our own makes both
    // racers queue at a point we choose). The STAGING is polled, not slept
    // (review MAJOR 5, matching slug-race.test.ts's `waitForBlockedInsert`):
    // a fixed sleep "long enough for both to have reached their own first
    // statement" can pass against broken code on a lucky interleaving; this
    // waits for the actual fact — `staged` confirms the holder itself has
    // the lock (its own `for update` only resolves once granted), and
    // `waitForBlockedLocks(2)` confirms BOTH racers are genuinely parked on
    // it before release.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let staged!: () => void;
    const isStaged = new Promise<void>((r) => (staged = r));
    const holder = sql.begin(async (tx) => {
      await tx`select 1 from registration_settings where division_id = ${division.id} for update`;
      staged();
      await held;
    });
    await isStaged;

    const racing = Promise.all([submitRegistrationGroup(ctx, inputFor("Racer A")), submitRegistrationGroup(ctx, inputFor("Racer B"))]);
    await waitForBlockedLocks(2);
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

  it("stale settings: a fee change staged between the pre-read and the lock is honoured, not the pre-read snapshot (review MAJOR 3)", async () => {
    const { orgId, orgSlug, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);
    await seedSettings(division.id, { entrant_kind: "individual", fee_cents: 1000, capacity: 5 });

    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let staged!: () => void;
    const isStaged = new Promise<void>((r) => (staged = r));
    // The price change happens INSIDE the holder's own transaction, after it
    // already holds the lock — writing a row your OWN transaction already
    // holds `for update` on is instant (no contention). Issuing the UPDATE
    // from a SEPARATE connection instead would itself block behind the very
    // lock this test releases only later — a self-deadlock in the test, not
    // production; caught by running this exact test standalone and watching
    // it hang past the wait budget instead of failing on an assertion.
    const holder = sql.begin(async (tx) => {
      await tx`select 1 from registration_settings where division_id = ${division.id} for update`;
      await tx`update registration_settings set fee_cents = 2500 where division_id = ${division.id}`;
      staged();
      await held;
    });
    await isStaged;

    const pending = submitRegistrationGroup(
      { orgSlug, compSlug: competition.slug },
      {
        contact: baseContact(),
        privacy_consent: true,
        entries: [
          { division_id: division.id, entrant_kind: "individual", players: [{ full_name: "Late Price" }], answers: {} },
        ],
      },
    );
    // The organiser's price change above is UNCOMMITTED and invisible to
    // anyone until the holder commits — parked here confirms
    // submitRegistrationGroup's own `for update` is genuinely queued behind
    // it, not racing ahead to read the pre-change value some other way.
    // `registration_settings_capacity_check` (capacity > 0) rules out
    // proving the SAME point via capacity directly (0 is not a legal value,
    // and any positive number still admits an empty division), so fee is the
    // cleanest observable dimension; `capacity`/`payment_method`/`approval`
    // are read from this exact same live-locked row by the exact same query
    // (see `liveSettingsById` in registration-submit.ts), not a separate
    // path, so this one proof stands for all four.
    await waitForBlockedLocks(1);
    release();
    await holder;
    const res = await pending;

    expect(res.entries[0]!.status).toBe("pending"); // still under capacity
    expect(res.entries[0]!.amount_cents).toBe(2500); // the LIVE fee, never the stale pre-read's 1000
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

  /** Seeds an entry (`team` or `pair`) WITH named captain-entered players —
   *  `teamRig` above deliberately seeds zero so each existing test controls
   *  its own cap math; the claim-path and pair tests below need real rows
   *  to claim, so this is a second, parallel fixture rather than a change
   *  to `teamRig` (every existing test above depends on its zero-roster
   *  starting point). Returns the player rows so a test can pick one by id
   *  without hand-deriving it. */
  async function rosterRig(
    entrantKind: "team" | "pair",
    playerNames: string[],
  ): Promise<{
    orgId: string;
    orgSlug: string;
    competition: { id: string; slug: string };
    division: { id: string; slug: string };
    entry: SubmitGroupEntryResult;
    players: { id: string; full_name: string }[];
  }> {
    const { orgId, orgSlug, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);
    await seedSettings(division.id, { entrant_kind: entrantKind, fee_cents: 0 });
    const entryInput: SubmitGroupEntryInput =
      entrantKind === "pair"
        ? {
            division_id: division.id,
            entrant_kind: "pair",
            partner_name: "Partner",
            players: playerNames.map((full_name) => ({ full_name })),
            answers: {},
          }
        : {
            division_id: division.id,
            entrant_kind: "team",
            team_name: "Rosterful Team",
            players: playerNames.map((full_name) => ({ full_name })),
            answers: {},
          };
    const submitted = await submitRegistrationGroup(
      { orgSlug, compSlug: competition.slug },
      { contact: baseContact(), privacy_consent: true, entries: [entryInput] },
    );
    const entry = submitted.entries[0]!;
    const players = await sql<{ id: string; full_name: string }[]>`
      select id, full_name from registration_players
      where registration_id = ${entry.registration_id} order by full_name`;
    return { orgId, orgSlug, competition, division, entry, players };
  }

  async function countPlayers(registrationId: string): Promise<number> {
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from registration_players where registration_id = ${registrationId}`;
    return n;
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

  it("a minor joiner needs guardian consent; consent_status records 'guardian'", async () => {
    const { entry } = await teamRig();
    await expect(
      joinTeamEntry({}, { join_code: entry.join_code!, player: { full_name: "Young Joiner", dob: "2015-01-01" } }),
    ).rejects.toMatchObject({ status: 422 });

    const res = await joinTeamEntry(
      {},
      {
        join_code: entry.join_code!,
        player: { full_name: "Young Joiner", dob: "2015-01-01" },
        guardian_name: "A Guardian",
        guardian_consent: true,
      },
    );
    expect(res.consent_status).toBe("guardian");
    const [row] = await sql<{ guardian_name: string | null; user_id: string | null }[]>`
      select guardian_name, user_id from registration_players where id = ${res.player_id}`;
    expect(row!.guardian_name).toBe("A Guardian");
    // Never linked to an account, even if the joiner happened to be signed
    // in — the same adult-only rule deriveLinkUserId enforces for submit.
    expect(row!.user_id).toBeNull();
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

  it("rejected-entry rejection (review MINOR: dead-entry guard, 'rejected' branch)", async () => {
    const { entry } = await teamRig();
    await sql`update registrations set status = 'rejected' where id = ${entry.registration_id}`;
    await expect(
      joinTeamEntry({}, { join_code: entry.join_code!, player: { full_name: "Too Late" } }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it("expired-entry rejection (review MINOR: dead-entry guard, 'expired' branch)", async () => {
    const { entry } = await teamRig();
    await sql`update registrations set status = 'expired' where id = ${entry.registration_id}`;
    await expect(
      joinTeamEntry({}, { join_code: entry.join_code!, player: { full_name: "Too Late" } }),
    ).rejects.toMatchObject({ status: 422 });
  });

  // ---------------------------------------------------------------------------
  // Claim path — a captain-entered row is UPDATED in place, never duplicated
  // (RS007 "found while using the shipped RS006 flow", 2026-08-27: this was
  // previously always an INSERT, which double-counted the roster and left
  // the original row's consent pending forever).
  // ---------------------------------------------------------------------------

  it("a captain-entered player CLAIMS their existing row — flips to granted, roster count unchanged", async () => {
    const { entry, players } = await rosterRig("team", ["Kid One"]);
    expect(await countPlayers(entry.registration_id)).toBe(1);

    const res = await joinTeamEntry(
      {},
      {
        join_code: entry.join_code!,
        player_id: players[0]!.id,
        player: { full_name: "Kid One", dob: "1995-05-01" },
      },
    );
    expect(res.player_id).toBe(players[0]!.id);
    expect(res.consent_status).toBe("granted");
    // THE regression this task exists to fix: claiming must never insert.
    expect(await countPlayers(entry.registration_id)).toBe(1);

    const [row] = await sql<{ consent_status: string; source: string; dob: string | null }[]>`
      select consent_status, source, dob from registration_players where id = ${players[0]!.id}`;
    expect(row!.consent_status).toBe("granted");
    expect(row!.source).toBe("captain_entered"); // provenance unchanged by a claim
    expect(row!.dob).toBe("1995-05-01");
  });

  it("claiming an already-granted slot is a 409 conflict, not a duplicate", async () => {
    const { entry, players } = await rosterRig("team", ["Kid One"]);
    await joinTeamEntry(
      {},
      { join_code: entry.join_code!, player_id: players[0]!.id, player: { full_name: "Kid One" } },
    );
    await expect(
      joinTeamEntry(
        {},
        { join_code: entry.join_code!, player_id: players[0]!.id, player: { full_name: "Kid One" } },
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(await countPlayers(entry.registration_id)).toBe(1);
  });

  it("claiming a slot that belongs to a DIFFERENT entry is rejected and writes nothing", async () => {
    const a = await rosterRig("team", ["A Kid"]);
    const b = await rosterRig("team", ["B Kid"]);
    await expect(
      joinTeamEntry(
        {},
        { join_code: b.entry.join_code!, player_id: a.players[0]!.id, player: { full_name: "A Kid" } },
      ),
    ).rejects.toMatchObject({ status: 404 });
    const [row] = await sql<{ consent_status: string }[]>`
      select consent_status from registration_players where id = ${a.players[0]!.id}`;
    expect(row!.consent_status).toBe("pending");
  });

  it("guardian consent works on the CLAIM branch for a minor and records guardian_name", async () => {
    const { entry, players } = await rosterRig("team", ["Young Kid"]);
    await expect(
      joinTeamEntry(
        {},
        {
          join_code: entry.join_code!,
          player_id: players[0]!.id,
          player: { full_name: "Young Kid", dob: "2015-01-01" },
        },
      ),
    ).rejects.toMatchObject({ status: 422 });

    const res = await joinTeamEntry(
      {},
      {
        join_code: entry.join_code!,
        player_id: players[0]!.id,
        player: { full_name: "Young Kid", dob: "2015-01-01" },
        guardian_name: "A Guardian",
        guardian_consent: true,
      },
    );
    expect(res.consent_status).toBe("guardian");
    const [row] = await sql<{ guardian_name: string | null; consent_status: string }[]>`
      select guardian_name, consent_status from registration_players where id = ${players[0]!.id}`;
    expect(row!.guardian_name).toBe("A Guardian");
    expect(row!.consent_status).toBe("guardian");
    expect(await countPlayers(entry.registration_id)).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // Pair widening — `pair` entries now mint a join_code too (previously only
  // `team` did), but a pair's roster is fixed at exactly two: the code exists
  // only so the partner can CLAIM their already-typed-in row, never to grow it.
  // ---------------------------------------------------------------------------

  it("a pair entry now mints a join_code at submit (previously null)", async () => {
    const { entry } = await rosterRig("pair", ["Captain P", "Partner P"]);
    expect(entry.join_code).toEqual(expect.any(String));
  });

  it("a pair partner claims their slot — granted, still exactly two rows", async () => {
    const { entry, players } = await rosterRig("pair", ["Captain P", "Partner P"]);
    expect(players).toHaveLength(2);
    const partner = players.find((p) => p.full_name === "Partner P")!;

    const res = await joinTeamEntry(
      {},
      {
        join_code: entry.join_code!,
        player_id: partner.id,
        player: { full_name: "Partner P", dob: "1994-01-01" },
      },
    );
    expect(res.consent_status).toBe("granted");
    expect(await countPlayers(entry.registration_id)).toBe(2);
  });

  it("a pair refuses the add-a-new-person path — roster is fixed at two, claim only", async () => {
    const { entry } = await rosterRig("pair", ["Captain P", "Partner P"]);
    await expect(
      joinTeamEntry({}, { join_code: entry.join_code!, player: { full_name: "Third Wheel" } }),
    ).rejects.toMatchObject({ status: 422 });
    expect(await countPlayers(entry.registration_id)).toBe(2);
  });

  describe("previewJoinEntry", () => {
    it("lists only unclaimed slots and hides claimed ones", async () => {
      const { entry, players } = await rosterRig("team", ["Kid One", "Kid Two"]);
      const first = players[0]!;
      await joinTeamEntry(
        {},
        { join_code: entry.join_code!, player_id: first.id, player: { full_name: first.full_name } },
      );
      const preview = await previewJoinEntry(entry.join_code!);
      expect(preview.unclaimed_slots.map((s) => s.player_id)).toEqual(
        players.filter((p) => p.id !== first.id).map((p) => p.id),
      );
    });

    it("returns entry/division/competition/org context and the entry's display name", async () => {
      const { entry, competition, orgSlug } = await rosterRig("team", []);
      const preview = await previewJoinEntry(entry.join_code!);
      expect(preview.registration_id).toBe(entry.registration_id);
      expect(preview.display_name).toBe("Rosterful Team");
      expect(preview.division_name).toBe("Open");
      expect(preview.competition_slug).toBe(competition.slug);
      expect(preview.org_slug).toBe(orgSlug);
    });

    it("unknown code returns a 404-shape", async () => {
      await expect(previewJoinEntry("SZ-DEAD-CODE")).rejects.toMatchObject({ status: 404 });
    });

    it("a withdrawn entry's join link previews as a 404-shape too", async () => {
      const { entry } = await rosterRig("team", []);
      await sql`update registrations set status = 'withdrawn' where id = ${entry.registration_id}`;
      await expect(previewJoinEntry(entry.join_code!)).rejects.toMatchObject({ status: 404 });
    });

    it("allow_new_player is false for a pair and true for a team under cap", async () => {
      const pair = await rosterRig("pair", ["A", "B"]);
      expect((await previewJoinEntry(pair.entry.join_code!)).allow_new_player).toBe(false);

      const team = await rosterRig("team", []);
      // generic sport's lineup cap is 1 (seedOrg) and this team has 0 rows.
      expect((await previewJoinEntry(team.entry.join_code!)).allow_new_player).toBe(true);
    });

    it("allow_new_player is false once the roster is at the sport's cap", async () => {
      const team = await rosterRig("team", ["Only Slot"]); // fills the cap of 1
      expect((await previewJoinEntry(team.entry.join_code!)).allow_new_player).toBe(false);
    });

    // RS007 (public join page) — the picker's WHO-equivalent fields must
    // collect exactly what joinTeamEntry's own eligibility gate below will
    // need, never more (same reasoning as publicRegistrationInfo's own
    // requires_dob/requires_gender on PublicDivisionInfo — reused here via
    // the SAME @/lib/registration-rules predicates, not a second evaluator).
    it("requires_dob/requires_gender mirror the division's own eligibility columns", async () => {
      const { division, entry } = await rosterRig("team", []);
      await sql`update divisions set age_min = 18, category = 'mens' where id = ${division.id}`;
      const preview = await previewJoinEntry(entry.join_code!);
      expect(preview.requires_dob).toBe(true);
      expect(preview.requires_gender).toBe(true);
    });

    it("requires_dob/requires_gender are both false for a fully open division", async () => {
      const { entry } = await rosterRig("team", []);
      const preview = await previewJoinEntry(entry.join_code!);
      expect(preview.requires_dob).toBe(false);
      expect(preview.requires_gender).toBe(false);
    });

    // RS007/V380 defect #3 — the wizard's custom rule was written and shown
    // nowhere. eligibility_note is now surfaced here too, alongside the
    // main register page's DivisionCard, so a joiner sees the same notice a
    // fresh entrant would.
    it("surfaces the division's eligibility_note", async () => {
      const { division, entry } = await rosterRig("team", []);
      await sql`update divisions set eligibility_note = 'School-registered students only' where id = ${division.id}`;
      const preview = await previewJoinEntry(entry.join_code!);
      expect(preview.eligibility_note).toBe("School-registered students only");
    });

    it("eligibility_note is null when the division has none set", async () => {
      const { entry } = await rosterRig("team", []);
      const preview = await previewJoinEntry(entry.join_code!);
      expect(preview.eligibility_note).toBeNull();
    });

    // The join page's success state shows a fill meter ("2 of 4 confirmed")
    // computed client-side from total_players/unclaimed_slots with no second
    // round-trip — it needs the WHOLE roster size, not just what's pending.
    it("total_players counts the WHOLE roster, not just the unclaimed slots", async () => {
      const { entry, players } = await rosterRig("team", ["Kid One", "Kid Two", "Kid Three"]);
      await joinTeamEntry(
        {},
        { join_code: entry.join_code!, player_id: players[0]!.id, player: { full_name: players[0]!.full_name } },
      );
      const preview = await previewJoinEntry(entry.join_code!);
      expect(preview.total_players).toBe(3);
      expect(preview.unclaimed_slots).toHaveLength(2);
    });
  });
});
