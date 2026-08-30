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

// RS008: inviteUnclaimedMembers is a fire-and-forget, post-commit side
// effect (registrations.ts's own doc comment) — mocked here so joinTeamEntry's
// WIRING (does it call this, with the right args, at the right times) is
// deterministic and provable without racing a detached promise. Everything
// else from "../registrations" (materialise, the auto-confirm path
// submitRegistrationGroup/teamRig rely on, etc.) stays REAL via
// importOriginal — same partial-mock convention the sibling ref-code mock
// above uses.
const inviteSweepMock = vi.hoisted(() => ({ fn: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../registrations", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../registrations")>();
  return {
    ...actual,
    inviteUnclaimedMembers: (...args: Parameters<typeof actual.inviteUnclaimedMembers>) =>
      inviteSweepMock.fn(...args),
  };
});

import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { LEGAL_VERSION } from "@/lib/legal";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { confirmRegistration } from "../registrations";
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
  inviteSweepMock.fn.mockClear();
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

  // RS007 #20b — every registering_self/self_player_index test above uses
  // `entrant_kind: "individual"`, where selfIndex always lands on the one
  // and only row. Nothing here previously proved the SAME grant reaches a
  // multi-row entry: a pair/team captain who typed a teammate's name in
  // too. Found via a real Stripe walkthrough (S2, money-matrix.spec.ts):
  // the captain paid the fee and still read "pending" on their own roster
  // row, because the entry that reached submitRegistrationGroup never
  // carried registering_self/self_player_index at all — an upstream (UI)
  // gap, not this usecase. This pins that the usecase's OWN half is
  // correct: GIVEN the explicit self-link, the captain's row is granted
  // (their consent is the cart's privacy_consent, given at submit) and the
  // untouched teammate's row is not.
  it("pair: the captain's own roster row is granted at submit via registering_self/self_player_index, even at a non-zero index — the partner they typed in stays pending", async () => {
    const { orgId, orgSlug, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);
    await seedSettings(division.id, { entrant_kind: "pair", fee_cents: 0 });

    const res = await submitRegistrationGroup(
      { orgSlug, compSlug: competition.slug },
      {
        contact: baseContact({ name: "Pair Captain", dob: "1990-01-01" }),
        privacy_consent: true,
        entries: [
          {
            division_id: division.id,
            entrant_kind: "pair",
            partner_name: "Pair Partner",
            registering_self: true,
            // Row 0 is the partner, row 1 is the captain — proves the grant
            // follows the EXPLICIT index, not a hidden "row 0 wins" default
            // (that default only ever applies to a solo `individual` entry).
            self_player_index: 1,
            players: [{ full_name: "Pair Partner" }, { full_name: "Pair Captain" }],
            answers: {},
          },
        ],
      },
    );

    expect(res.entries).toHaveLength(1);
    const rows = await sql<{ full_name: string; consent_status: string }[]>`
      select full_name, consent_status from registration_players
      where registration_id = ${res.entries[0]!.registration_id}
      order by full_name`;
    const captain = rows.find((r) => r.full_name === "Pair Captain");
    const partner = rows.find((r) => r.full_name === "Pair Partner");
    expect(captain?.consent_status).toBe("granted");
    expect(partner?.consent_status).toBe("pending");
  });

  it("pair: registering_self false (the default) leaves BOTH captain-entered rows pending, even when the contact's own name matches a roster row exactly — no name-similarity auto-claim", async () => {
    const { orgId, orgSlug, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);
    await seedSettings(division.id, { entrant_kind: "pair", fee_cents: 0 });

    const res = await submitRegistrationGroup(
      { orgSlug, compSlug: competition.slug },
      {
        // The contact's name is IDENTICAL to one of the roster rows below —
        // the only signal that may ever grant a row is the explicit
        // registering_self/self_player_index pair, never a name match.
        contact: baseContact({ name: "Pair Captain" }),
        privacy_consent: true,
        entries: [
          {
            division_id: division.id,
            entrant_kind: "pair",
            partner_name: "Pair Partner",
            players: [{ full_name: "Pair Partner" }, { full_name: "Pair Captain" }],
            answers: {},
          },
        ],
      },
    );

    expect(res.entries).toHaveLength(1);
    const rows = await sql<{ consent_status: string }[]>`
      select consent_status from registration_players where registration_id = ${res.entries[0]!.registration_id}`;
    expect(rows.every((r) => r.consent_status === "pending")).toBe(true);
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

  // #22 — registration_players.email exists on the table (V363) but nothing
  // wrote it before this. A captain-typed row keeps whatever it typed; the
  // self row falls back to the cart-level contact.email the same way it
  // already falls back to dob/gender (design §4 step 1: "collected once").
  it("#22: registration_players.email is persisted — a plain row keeps its own, the self row falls back to contact.email", async () => {
    const { orgId, orgSlug, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);
    await seedSettings(division.id, { entrant_kind: "pair", fee_cents: 0 });

    const res = await submitRegistrationGroup(
      { orgSlug, compSlug: competition.slug },
      {
        contact: baseContact({ name: "Email Captain", email: "captain@example.com", dob: "1990-01-01" }),
        privacy_consent: true,
        entries: [
          {
            division_id: division.id,
            entrant_kind: "pair",
            partner_name: "Partner",
            registering_self: true,
            self_player_index: 0,
            players: [
              { full_name: "Email Captain" }, // no email typed on the row itself
              { full_name: "Typed Partner", email: "partner-typed@example.com" },
            ],
            answers: {},
          },
        ],
      },
    );
    const rows = await sql<{ full_name: string; email: string | null }[]>`
      select full_name, email from registration_players
      where registration_id = ${res.entries[0]!.registration_id} order by full_name`;
    const captainRow = rows.find((r) => r.full_name === "Email Captain")!;
    const partnerRow = rows.find((r) => r.full_name === "Typed Partner")!;
    expect(captainRow.email).toBe("captain@example.com"); // fell back to contact.email
    expect(partnerRow.email).toBe("partner-typed@example.com"); // kept its own
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
      { join_code: entry.join_code!, player: { full_name: "New Joiner", dob: "1995-05-01" }, privacy_consent: true },
    );
    expect(res.consent_status).toBe("granted");
    const [row] = await sql<{ user_id: string | null; source: string; consent_status: string }[]>`
      select user_id, source, consent_status from registration_players where id = ${res.player_id}`;
    expect(row!.source).toBe("self_joined");
    expect(row!.consent_status).toBe("granted");
    expect(row!.user_id).toBe(sessionUserId);
  });

  it("#23: a join landing on an ALREADY-materialised entry still creates an entrant_members row", async () => {
    const { entry } = await teamRig();
    // teamRig's fee is 0 under auto-approval, so submitRegistrationGroup
    // already confirmed/materialised this entry before the join below ever
    // runs — materialise()'s own `if (reg.entrant_id) return` guard means it
    // will never revisit this registration to roster a player who joins
    // after. Before the #23 fix, the join below wrote registration_players
    // but no entrant_members row.
    const [{ entrant_id }] = await sql<{ entrant_id: string | null }[]>`
      select entrant_id from registrations where id = ${entry.registration_id}`;
    expect(entrant_id).not.toBeNull();

    const res = await joinTeamEntry(
      {},
      { join_code: entry.join_code!, player: { full_name: "Late Joiner" }, privacy_consent: true },
    );

    const [row] = await sql<{ person_id: string | null }[]>`
      select person_id from registration_players where id = ${res.player_id}`;
    expect(row!.person_id).not.toBeNull();

    const members = await sql<{ person_id: string }[]>`
      select person_id from entrant_members
       where entrant_id = ${entrant_id as string} and person_id = ${row!.person_id as string}`;
    expect(members).toHaveLength(1);
  });

  // RS008 — convergence points 1 & 3: joinTeamEntry's claim (UPDATE) branch
  // and its insert branch both fire the post-commit claim-invite sweep when
  // the entry they land on is ALREADY materialised (the exact condition
  // #23's own fix targets). A not-yet-materialised entry has nothing to
  // sweep yet — materialise() itself will trigger it later.
  describe("RS008: fires the claim-invite sweep after commit, only when already materialised", () => {
    it("insert branch: a fresh joiner on an already-materialised entry sweeps that entrant", async () => {
      const { orgId, entry } = await teamRig();
      const [{ entrant_id }] = await sql<{ entrant_id: string | null }[]>`
        select entrant_id from registrations where id = ${entry.registration_id}`;
      expect(entrant_id).not.toBeNull();

      await joinTeamEntry(
        {},
        { join_code: entry.join_code!, player: { full_name: "Sweep Joiner" }, privacy_consent: true },
      );

      expect(inviteSweepMock.fn).toHaveBeenCalledTimes(1);
      expect(inviteSweepMock.fn).toHaveBeenCalledWith(orgId, entrant_id);
    });

    it("claim branch: claiming a captain-entered slot on an already-materialised entry ALSO sweeps it", async () => {
      const { orgId, entry, players } = await rosterRig("team", ["Pending Slot"]);
      const [{ entrant_id }] = await sql<{ entrant_id: string | null }[]>`
        select entrant_id from registrations where id = ${entry.registration_id}`;
      expect(entrant_id).not.toBeNull();

      await joinTeamEntry(
        {},
        {
          join_code: entry.join_code!,
          player_id: players[0]!.id,
          player: { full_name: players[0]!.full_name },
          privacy_consent: true,
        },
      );

      expect(inviteSweepMock.fn).toHaveBeenCalledTimes(1);
      expect(inviteSweepMock.fn).toHaveBeenCalledWith(orgId, entrant_id);
    });

    it("a join onto an entry that has NEVER been materialised does not sweep yet", async () => {
      const { orgId, orgSlug, ownerId } = await seedOrg("pro");
      const owner = asOwner(orgId, ownerId);
      const { competition, division } = await rig(owner);
      // manual approval → submitRegistrationGroup never auto-confirms, even
      // though the fee is 0 — materialise() has not run for anyone yet.
      await seedSettings(division.id, { entrant_kind: "team", fee_cents: 0, approval: "manual" });
      const submitted = await submitRegistrationGroup(
        { orgSlug, compSlug: competition.slug },
        {
          contact: baseContact(),
          privacy_consent: true,
          entries: [
            {
              division_id: division.id,
              entrant_kind: "team",
              team_name: "Unmaterialised Team",
              players: [],
              answers: {},
            },
          ],
        },
      );
      const entry = submitted.entries[0]!;
      const [{ entrant_id }] = await sql<{ entrant_id: string | null }[]>`
        select entrant_id from registrations where id = ${entry.registration_id}`;
      expect(entrant_id).toBeNull();

      await joinTeamEntry(
        {},
        { join_code: entry.join_code!, player: { full_name: "Early Joiner" }, privacy_consent: true },
      );

      expect(inviteSweepMock.fn).not.toHaveBeenCalled();
    });
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
        privacy_consent: true,
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
    await joinTeamEntry(
      {},
      { join_code: entry.join_code!, player: { full_name: "First In" }, privacy_consent: true },
    );
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
  // Privacy consent (GDPR) — consent-asymmetry follow-up, 2026-08-28. Mirrors
  // submitRegistrationGroup's own "privacy consent (GDPR) is required" test
  // above (registration-submit.ts:547) — this suite owns the structural/
  // status-code coverage for the gate (join-consent.test.ts, this file's
  // sibling, owns the per-player DB-persistence angle: no stamp, no row
  // mutated). Both the insert AND claim branches are covered: a captain-
  // entered row's own consent was never collected either, so the claim
  // moment is exactly as much this player's first consent as a fresh
  // insert's is (joinTeamEntry's own doc comment).
  // ---------------------------------------------------------------------------

  it("privacy consent is required on the INSERT path — a refusal is rejected, not silently joined", async () => {
    const { entry } = await teamRig();
    await expect(
      joinTeamEntry(
        {},
        { join_code: entry.join_code!, player: { full_name: "No Consent" }, privacy_consent: false },
      ),
    ).rejects.toMatchObject({ status: 422 });
    expect(await countPlayers(entry.registration_id)).toBe(0);
  });

  it("privacy consent is required on the CLAIM path — a refusal is rejected, row stays pending", async () => {
    const { entry, players } = await rosterRig("team", ["Kid One"]);
    await expect(
      joinTeamEntry(
        {},
        {
          join_code: entry.join_code!,
          player_id: players[0]!.id,
          player: { full_name: "Kid One" },
          privacy_consent: false,
        },
      ),
    ).rejects.toMatchObject({ status: 422 });
    const [row] = await sql<{ consent_status: string }[]>`
      select consent_status from registration_players where id = ${players[0]!.id}`;
    expect(row!.consent_status).toBe("pending"); // never flipped, never claimed
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
        privacy_consent: true,
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

  // ---------------------------------------------------------------------------
  // RS007 review fix L2 — a claim may fill a blank or correct a value, NEVER
  // erase one. The join form renders dob/gender inputs only when
  // requires_dob/requires_gender (JoinForm's own props) — if an organiser
  // removes the division's age band or gender rule between the captain's
  // submit and the joiner's claim, `input.player.dob`/`.gender` arrive
  // undefined/null even though the captain already typed a real value in.
  // The CAS used to write `dob = ${input.player.dob ?? null}` unconditionally
  // — an absent input ERASED a stored value that findOrCreatePlayerPerson's
  // own dob rule (and any later youth handling) depends on.
  // ---------------------------------------------------------------------------

  it("a claim that omits dob/gender does NOT erase a value the captain already typed in (RS007 review fix L2)", async () => {
    const { entry, players } = await rosterRig("team", ["Kid One"]);
    // Simulate a captain-typed dob/gender already sitting on the row before
    // this claim — same end state whether it came from the original submit
    // or an earlier partial claim; the CAS below doesn't care which.
    await sql`
      update registration_players set dob = '2010-06-15', gender = 'm' where id = ${players[0]!.id}`;

    const res = await joinTeamEntry(
      {},
      {
        join_code: entry.join_code!,
        player_id: players[0]!.id,
        // Deliberately NO dob/gender — the requires_dob/requires_gender-gated
        // inputs a joiner's browser never rendered.
        player: { full_name: "Kid One" },
        privacy_consent: true,
      },
    );
    expect(res.consent_status).toBe("granted"); // the claim itself still succeeds

    const [row] = await sql<{ dob: string | null; gender: string | null }[]>`
      select dob, gender from registration_players where id = ${players[0]!.id}`;
    expect(row!.dob).toBe("2010-06-15"); // NOT erased
    expect(row!.gender).toBe("m"); // NOT erased
  });

  it("a claim CAN still fill a blank dob/gender (RS007 review fix L2) — coalesce must not turn into 'never overwrite'", async () => {
    const { entry, players } = await rosterRig("team", ["Kid One"]);
    // Starts blank (rosterRig seeds only full_name).
    const filled = await joinTeamEntry(
      {},
      {
        join_code: entry.join_code!,
        player_id: players[0]!.id,
        player: { full_name: "Kid One", dob: "1999-03-20", gender: "f" },
        privacy_consent: true,
      },
    );
    expect(filled.consent_status).toBe("granted");
    const [afterFill] = await sql<{ dob: string | null; gender: string | null }[]>`
      select dob, gender from registration_players where id = ${players[0]!.id}`;
    expect(afterFill!.dob).toBe("1999-03-20");
    expect(afterFill!.gender).toBe("f");
  });

  it("a claim CAN still correct a previously stored dob/gender when the joiner submits a different one (RS007 review fix L2)", async () => {
    const { entry, players } = await rosterRig("team", ["Kid One"]);
    // A captain-typed value already on the row — wrong, and the joiner
    // corrects it at claim time. Both dobs are comfortably adult (this test
    // is about which VALUE wins, not the separate minor/guardian gate).
    await sql`
      update registration_players set dob = '1985-06-15', gender = 'm' where id = ${players[0]!.id}`;

    const corrected = await joinTeamEntry(
      {},
      {
        join_code: entry.join_code!,
        player_id: players[0]!.id,
        player: { full_name: "Kid One", dob: "1990-08-22", gender: "f" },
        privacy_consent: true,
      },
    );
    expect(corrected.consent_status).toBe("granted");
    const [afterCorrect] = await sql<{ dob: string | null; gender: string | null }[]>`
      select dob, gender from registration_players where id = ${players[0]!.id}`;
    expect(afterCorrect!.dob).toBe("1990-08-22"); // the joiner's own value wins
    expect(afterCorrect!.gender).toBe("f");
  });

  // ---------------------------------------------------------------------------
  // #22 — reconcile a claim against the directory. `rosterRig` entries are
  // `fee_cents: 0` / `approval: "auto"`, so they materialise INLINE at
  // submit (registration-submit.ts's own "confirm INLINE" branch) — every
  // test below claims AFTER materialisation, exactly the S2 walkthrough
  // scenario #22 was written for: the captain-typed row already has a
  // dummy, anonymous person (and entrant_members row) from that submit-time
  // materialise() call, made with no consent behind it, before this player
  // ever claims anything.
  // ---------------------------------------------------------------------------

  async function personIdFor(playerRowId: string): Promise<string> {
    const [{ person_id }] = await sql<{ person_id: string | null }[]>`
      select person_id from registration_players where id = ${playerRowId}`;
    expect(person_id, "expected this row to already be materialised (a dummy person on it)").not.toBeNull();
    return person_id!;
  }

  async function entrantIdFor(registrationId: string): Promise<string> {
    const [{ entrant_id }] = await sql<{ entrant_id: string | null }[]>`
      select entrant_id from registrations where id = ${registrationId}`;
    expect(entrant_id).not.toBeNull();
    return entrant_id!;
  }

  it("#22: a claim whose email matches an EXISTING player-lane person repoints entrant_members off the dummy, onto that person", async () => {
    const { orgId, entry, players } = await rosterRig("pair", ["Pair Captain", "Pair Partner"]);
    const partner = players.find((p) => p.full_name === "Pair Partner")!;
    const dummyPersonId = await personIdFor(partner.id);
    const entrantId = await entrantIdFor(entry.registration_id);

    // A person who registered elsewhere in this SAME org, already carrying
    // this email — exactly the directory entry #22 exists to reuse instead
    // of minting a third duplicate.
    const [existing] = await sql<{ id: string }[]>`
      insert into persons (org_id, full_name, email, lane, consent)
      values (${orgId}, 'Pair Partner Elsewhere', 'partner@example.com', 'player', ${sql.json({ public_name: true } as never)})
      returning id`;

    const res = await joinTeamEntry(
      {},
      {
        join_code: entry.join_code!,
        player_id: partner.id,
        player: { full_name: "Pair Partner", email: "partner@example.com" },
        privacy_consent: true,
      },
    );
    expect(res.consent_status).toBe("granted");

    // The claimed row now points at the REAL person, not the dummy.
    const nowLinked = await personIdFor(partner.id);
    expect(nowLinked).toBe(existing.id);
    expect(nowLinked).not.toBe(dummyPersonId);

    // entrant_members has the SAME two rows as before (never grew, never
    // shrank) — the dummy's row was REPOINTED, not duplicated.
    const members = await sql<{ person_id: string }[]>`
      select person_id from entrant_members where entrant_id = ${entrantId}`;
    expect(members).toHaveLength(2);
    expect(members.map((m) => m.person_id)).toContain(existing.id);
    expect(members.map((m) => m.person_id)).not.toContain(dummyPersonId);

    // The dummy is left ORPHANED, not deleted or merged (#22: no
    // auto-merging of existing duplicates) — an organiser can still find
    // and #404-merge it if they choose to.
    const [stillExists] = await sql<{ id: string }[]>`select id from persons where id = ${dummyPersonId}`;
    expect(stillExists).toBeDefined();
  });

  it("#22: a claim with no directory match backfills the dummy person's own email instead of repointing", async () => {
    const { entry, players } = await rosterRig("pair", ["Pair Captain", "Pair Partner"]);
    const partner = players.find((p) => p.full_name === "Pair Partner")!;
    const dummyPersonId = await personIdFor(partner.id);
    const entrantId = await entrantIdFor(entry.registration_id);

    await joinTeamEntry(
      {},
      {
        join_code: entry.join_code!,
        player_id: partner.id,
        player: { full_name: "Pair Partner", email: "brand-new@example.com" },
        privacy_consent: true,
      },
    );

    // No existing match anywhere — the dummy person IS this human going
    // forward, unmoved, but the row's person_id is unchanged (still the
    // dummy) and the dummy now carries the email it was minted without.
    expect(await personIdFor(partner.id)).toBe(dummyPersonId);
    const members = await sql<{ person_id: string }[]>`
      select person_id from entrant_members where entrant_id = ${entrantId}`;
    expect(members.map((m) => m.person_id)).toContain(dummyPersonId);
    const [{ email }] = await sql<{ email: string | null }[]>`select email from persons where id = ${dummyPersonId}`;
    expect(email).toBe("brand-new@example.com");
  });

  it("#22: when the resolved person is ALREADY a member of this same entrant, the repoint is skipped and the claim still succeeds", async () => {
    const { orgId, entry, players } = await rosterRig("pair", ["Pair Captain", "Pair Partner"]);
    const captain = players.find((p) => p.full_name === "Pair Captain")!;
    const partner = players.find((p) => p.full_name === "Pair Partner")!;
    const entrantId = await entrantIdFor(entry.registration_id);
    const captainDummyBefore = await personIdFor(captain.id);
    const partnerDummyBefore = await personIdFor(partner.id);

    // The captain claims first — repoints the CAPTAIN's row onto a shared
    // inbox's existing person (a plausible real accident: a family email
    // typed for both halves of a junior pair).
    const sharedEmail = "shared-family-inbox@example.com";
    const [familyInbox] = await sql<{ id: string }[]>`
      insert into persons (org_id, full_name, email, lane, consent)
      values (${orgId}, 'Family Inbox', ${sharedEmail}, 'player', ${sql.json({ public_name: true } as never)})
      returning id`;
    await joinTeamEntry(
      {},
      {
        join_code: entry.join_code!,
        player_id: captain.id,
        player: { full_name: "Pair Captain", email: sharedEmail },
        privacy_consent: true,
      },
    );
    const sharedPersonId = await personIdFor(captain.id);
    // Pins the test's OWN precondition — without this, a build that skips
    // reconciliation entirely would still pass every assertion below (the
    // partner's dummy is untouched either way), making the test vacuous
    // against exactly the mutation it exists to catch.
    expect(sharedPersonId).toBe(familyInbox.id);
    expect(sharedPersonId).not.toBe(captainDummyBefore);

    // The partner ALSO claims with the SAME shared email — would resolve to
    // the SAME person the captain's row now points at. entrant_members'
    // primary key (entrant_id, person_id) forbids that person appearing
    // twice on one roster, so the repoint must be skipped, not crash the
    // claim (409/500) or silently duplicate the membership row.
    const res = await joinTeamEntry(
      {},
      {
        join_code: entry.join_code!,
        player_id: partner.id,
        player: { full_name: "Pair Partner", email: sharedEmail },
        privacy_consent: true,
      },
    );
    expect(res.consent_status).toBe("granted"); // the claim itself still succeeds

    // The partner's row keeps its OWN dummy — never repointed onto the
    // captain's person.
    expect(await personIdFor(partner.id)).toBe(partnerDummyBefore);
    const members = await sql<{ person_id: string }[]>`
      select person_id from entrant_members where entrant_id = ${entrantId}`;
    expect(members).toHaveLength(2); // still exactly one row per player, no duplicate
    expect(members.map((m) => m.person_id)).toContain(sharedPersonId);
    expect(members.map((m) => m.person_id)).toContain(partnerDummyBefore);
  });

  it("#22: a signed-in claimer also reconciles, via resolvePlayerPerson's own (org, user, lane) identity", async () => {
    const { orgId, orgSlug, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    const { competition, division: soloDivision } = await rig(owner);
    await seedSettings(soloDivision.id, { entrant_kind: "individual", fee_cents: 0 });
    const sessionUserId = await makeUser("reconciler");

    // Establishes the REAL linked person via the ordinary self-link path
    // (resolvePlayerPerson's own upsert) — a prior, unrelated registration
    // for the same signed-in human.
    const solo = await submitRegistrationGroup(
      { orgSlug, compSlug: competition.slug, sessionUserId },
      {
        contact: baseContact({ dob: "1990-01-01" }),
        privacy_consent: true,
        entries: [
          {
            division_id: soloDivision.id,
            entrant_kind: "individual",
            registering_self: true,
            self_player_index: 0,
            players: [{ full_name: "Reconciler Self" }],
            answers: {},
          },
        ],
      },
    );
    const [{ person_id: linkedPersonId }] = await sql<{ person_id: string | null }[]>`
      select person_id from registration_players where registration_id = ${solo.entries[0]!.registration_id}`;
    expect(linkedPersonId).not.toBeNull();

    const teamDivision = await createDivision(owner, competition.id, {
      name: "Team Div " + randomUUID().slice(0, 6),
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    });
    await seedSettings(teamDivision.id, { entrant_kind: "pair", fee_cents: 0 });
    const teamSubmit = await submitRegistrationGroup(
      { orgSlug, compSlug: competition.slug },
      {
        contact: baseContact(),
        privacy_consent: true,
        entries: [
          {
            division_id: teamDivision.id,
            entrant_kind: "pair",
            partner_name: "Reconciler Self",
            players: [{ full_name: "Reconciler Self" }, { full_name: "Other Half" }],
            answers: {},
          },
        ],
      },
    );
    const teamEntry = teamSubmit.entries[0]!;
    const [selfRow] = await sql<{ id: string; person_id: string | null }[]>`
      select id, person_id from registration_players
      where registration_id = ${teamEntry.registration_id} and full_name = 'Reconciler Self'`;
    const dummyPersonId = selfRow!.person_id;
    expect(dummyPersonId).not.toBe(linkedPersonId); // materialised independently — two different persons so far

    await joinTeamEntry(
      { sessionUserId },
      {
        join_code: teamEntry.join_code!,
        player_id: selfRow!.id,
        player: { full_name: "Reconciler Self", dob: "1990-01-01" },
        privacy_consent: true,
      },
    );

    const [{ person_id: afterClaim }] = await sql<{ person_id: string | null }[]>`
      select person_id from registration_players where id = ${selfRow!.id}`;
    expect(afterClaim).toBe(linkedPersonId); // repointed onto the ALREADY-linked account person
  });

  it("#22: a claim BEFORE its entry is materialised needs no repoint of its own — materialise() dedupes on the persisted email when it eventually runs", async () => {
    const { orgId, orgSlug, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);
    // manual approval: the entry stays `pending`, entrant_id null, until an
    // organiser confirms it — materialise() has NOT run yet when the claim
    // below happens.
    await seedSettings(division.id, { entrant_kind: "pair", fee_cents: 0, approval: "manual" });

    const submitted = await submitRegistrationGroup(
      { orgSlug, compSlug: competition.slug },
      {
        contact: baseContact(),
        privacy_consent: true,
        entries: [
          {
            division_id: division.id,
            entrant_kind: "pair",
            partner_name: "Partner",
            players: [{ full_name: "Pending Captain" }, { full_name: "Pending Partner" }],
            answers: {},
          },
        ],
      },
    );
    const entry = submitted.entries[0]!;
    expect(entry.status).toBe("pending");
    const [{ entrant_id: entrantIdBefore }] = await sql<{ entrant_id: string | null }[]>`
      select entrant_id from registrations where id = ${entry.registration_id}`;
    expect(entrantIdBefore).toBeNull(); // confirms materialise() has not run

    // A person who already exists in the directory with this email, from
    // some earlier, unrelated registration.
    const [existing] = await sql<{ id: string }[]>`
      insert into persons (org_id, full_name, email, lane, consent)
      values (${orgId}, 'Pending Partner Elsewhere', 'pending-partner@example.com', 'player', ${sql.json({ public_name: true } as never)})
      returning id`;

    const partnerRow = await sql<{ id: string }[]>`
      select id from registration_players where registration_id = ${entry.registration_id} and full_name = 'Pending Partner'`;
    await joinTeamEntry(
      {},
      {
        join_code: entry.join_code!,
        player_id: partnerRow[0]!.id,
        player: { full_name: "Pending Partner", email: "pending-partner@example.com" },
        privacy_consent: true,
      },
    );
    // No person exists to link to yet — joinTeamEntry's own reconciliation
    // is a no-op here (nothing in the `if (claimed.person_id)` branch can
    // run), by design: this is the case the brief calls "handled for free".
    const [{ person_id: personIdAfterClaim }] = await sql<{ person_id: string | null }[]>`
      select person_id from registration_players where id = ${partnerRow[0]!.id}`;
    expect(personIdAfterClaim).toBeNull();

    // The organiser confirms later — THIS is what runs materialise() for
    // the first time on this registration.
    const confirmed = await confirmRegistration(owner, entry.registration_id);
    expect(confirmed.entrant_id).not.toBeNull();

    const [{ person_id: personIdAfterMaterialise }] = await sql<{ person_id: string | null }[]>`
      select person_id from registration_players where id = ${partnerRow[0]!.id}`;
    // The email persisted at claim time reached materialise() through the
    // ordinary registration_players.email column — findOrCreatePlayerPerson
    // found the SAME pre-existing person, with no extra code needed for
    // this ordering.
    expect(personIdAfterMaterialise).toBe(existing.id);
    const members = await sql<{ person_id: string }[]>`
      select person_id from entrant_members where entrant_id = ${confirmed.entrant_id as string}`;
    expect(members.map((m) => m.person_id)).toContain(existing.id);
  });

  it("claiming an already-granted slot is a 409 conflict, not a duplicate", async () => {
    const { entry, players } = await rosterRig("team", ["Kid One"]);
    await joinTeamEntry(
      {},
      {
        join_code: entry.join_code!,
        player_id: players[0]!.id,
        player: { full_name: "Kid One" },
        privacy_consent: true,
      },
    );
    await expect(
      joinTeamEntry(
        {},
        {
          join_code: entry.join_code!,
          player_id: players[0]!.id,
          player: { full_name: "Kid One" },
          privacy_consent: true,
        },
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
        {
          join_code: b.entry.join_code!,
          player_id: a.players[0]!.id,
          player: { full_name: "A Kid" },
          privacy_consent: true,
        },
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
        privacy_consent: true,
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
        privacy_consent: true,
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
        {
          join_code: entry.join_code!,
          player_id: first.id,
          player: { full_name: first.full_name },
          privacy_consent: true,
        },
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
      // RS007 review fix M2 (2026-08-29): a 2026-08-27 revision made a
      // null-category division carrying ANY note also collect gender
      // defensively — but this note has nothing to do with gender, and
      // divisionEligibilityIssues never gated on gender for a null category
      // either way, so that made the public WHO step demand a field the API
      // never required. Ruling: a free-text note must never make a field
      // mandatory (requiresGender, registration-eligibility.ts — full
      // account there). Proves the wiring from divCtx.eligibility_note into
      // requiresGender no longer forces collection, not just the pure
      // function in isolation.
      expect(preview.requires_gender).toBe(false);
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
        {
          join_code: entry.join_code!,
          player_id: players[0]!.id,
          player: { full_name: players[0]!.full_name },
          privacy_consent: true,
        },
      );
      const preview = await previewJoinEntry(entry.join_code!);
      expect(preview.total_players).toBe(3);
      expect(preview.unclaimed_slots).toHaveLength(2);
    });

    // #24 — a captain-typed row's email can already match an existing,
    // opted-out person elsewhere in the org's directory (someone who played
    // before under a different registration and opted out via /me since).
    // The slot's OWN consent_status is still 'pending', but the person it
    // resolves to has already made their choice — the picker must not show
    // their real name just because this particular row hasn't been claimed.
    it("masks an unclaimed slot whose email already matches an opted-out person", async () => {
      const { orgId, entry, players } = await rosterRig("team", ["Ada Lovelace"]);
      const slot = players[0]!;
      await sql`
        insert into persons (org_id, full_name, email, consent, lane)
        values (${orgId}, 'Ada Lovelace', 'ada@example.com', ${sql.json({ public_name: false })}, 'player')`;
      await sql`update registration_players set email = 'ada@example.com' where id = ${slot.id}`;

      const preview = await previewJoinEntry(entry.join_code!);
      const slotPreview = preview.unclaimed_slots.find((s) => s.player_id === slot.id);
      expect(slotPreview?.full_name).toBe("Ada L.");
    });

    it("previews an unclaimed slot's raw name when its email matches nobody opted out", async () => {
      const { entry, players } = await rosterRig("team", ["Ada Lovelace"]);
      const slot = players[0]!;
      await sql`update registration_players set email = 'nobody-matches@example.com' where id = ${slot.id}`;

      const preview = await previewJoinEntry(entry.join_code!);
      const slotPreview = preview.unclaimed_slots.find((s) => s.player_id === slot.id);
      expect(slotPreview?.full_name).toBe("Ada Lovelace");
    });
  });
});

// RS007 finding #17 — a pair's display name used to compose roster row 0's
// real name with `entry.partner_name`, a value typed on a DIFFERENT step of
// the public stepper and never compared with the roster. The two could
// disagree permanently, and the join page shows the display name as its
// heading and the roster as its "Which one are you?" list — so the partner
// following their own invite link saw a heading naming someone who was not
// among the options they could pick.
describe.skipIf(!HAS_DB)("a pair's display name follows its ROSTER, not the entries-step field (#17)", () => {
  async function submitPair(
    partnerName: string | null,
    playerNames: string[],
  ): Promise<string> {
    const { orgId, orgSlug, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);
    await seedSettings(division.id, { entrant_kind: "pair", fee_cents: 0 });
    const submitted = await submitRegistrationGroup(
      { orgSlug, compSlug: competition.slug },
      {
        contact: baseContact(),
        privacy_consent: true,
        entries: [
          {
            division_id: division.id,
            entrant_kind: "pair",
            partner_name: partnerName,
            players: playerNames.map((full_name) => ({ full_name })),
            answers: {},
          } as SubmitGroupEntryInput,
        ],
      },
    );
    const [row] = await sql<{ display_name: string }[]>`
      select display_name from registrations where id = ${submitted.entries[0]!.registration_id}`;
    return row!.display_name;
  }

  it("names the two people actually on the roster, even when the partner field says someone else", async () => {
    expect(
      await submitPair("Bob Vance", ["Alice Byrne", "Robert Vance"]),
      "the roster is who is playing; the entries-step partner field is a convenience typed earlier",
    ).toBe("Alice Byrne & Robert Vance");
  });

  // Why the `partner_name` fallback in entryDisplayName cannot fire at
  // submit, pinned so a future schema change that CAN reach it is a
  // deliberate decision rather than a surprise: a pair is fixed at exactly
  // two players, and `full_name` is `z.string().min(1)`, so players[1] is
  // always present and always non-empty by the time a display name is
  // composed. The fallback stays as defence, not as live behaviour.
  it("refuses a pair with only one player, which is why the roster can always be trusted here", async () => {
    await expect(submitPair("Bob Vance", ["Alice Byrne"])).rejects.toThrow(
      /A pair entry needs exactly two players/,
    );
  });

  it("agrees with itself when both were filled from the same name", async () => {
    expect(await submitPair("Bob Vance", ["Alice Byrne", "Bob Vance"])).toBe("Alice Byrne & Bob Vance");
  });
});
