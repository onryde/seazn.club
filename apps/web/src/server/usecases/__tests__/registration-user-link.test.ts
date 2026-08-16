// #402 — the registrant's session, and the person it resolves to.
//
// Two halves, deliberately in one file because the second depends on what the
// first writes:
//
//  1. CAPTURE. `registrations.user_id` is written ONLY when the submitter is
//     signed in AND affirmed "I'm registering myself" AND left every guardian
//     field empty. Being signed in is never enough on its own — a guardian, a
//     spouse and a team captain are all signed in too, and inferring the link
//     would merge them into one person exactly as `contact_email` would
//     (persons-identity.test.ts pins that same harm in its email form).
//  2. RESOLVE. Given that link, `materialise` upserts into the PLAYER lane on
//     (org_id, user_id, 'player'), so one human entering two divisions gets one
//     persons row. Everything without a link keeps today's plain insert.
//
// Real Postgres required; skipped without DATABASE_URL.
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { deriveLinkUserId, putRegistrationSettings } from "../registrations";
import { seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

/** An unambiguous adult on any clock this suite will ever run on. Linking now
 *  REQUIRES a dob (#402 finding 5), so every "expect a link" case sends one. */
const ADULT_DOB = "1990-05-05";

/** Registration-open division. Deliberately a local copy of the helper in
 *  persons-identity.test.ts — the two suites stay independent. */
async function seedOpenDivision(
  auth: AuthCtx,
  entrantKind: "individual" | "team" = "individual",
): Promise<{ divisionId: string; orgSlug: string; compSlug: string }> {
  const [{ slug: orgSlug }] = await sql<{ slug: string }[]>`
    select slug from organizations where id = ${auth.orgId}`;
  const competition = await createCompetition(auth, {
    name: "Identity Cup " + randomUUID().slice(0, 6),
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
    eligibility: [],
  });
  await putRegistrationSettings(auth, division.id, {
    enabled: true,
    entrant_kind: entrantKind,
    fee_cents: 0,
    currency: "usd",
    form_fields: [],
    opens_at: null,
    closes_at: null,
    capacity: null,
    refund_lock_at: null,
  });
  return { divisionId: division.id, orgSlug, compSlug: competition.slug };
}

// The derivation is exported so the branches the outer 422s make unreachable can
// still be pinned. A minor's dob is guardian territory whether or not the
// guardian fields were filled in: `submitRegistration` refuses that submission
// outright today, but the link rule must not depend on that refusal staying
// where it is — the veto is the guarantee, the 422 is only the friendly error.
describe("deriveLinkUserId (#402 — the capture rule itself)", () => {
  const NOW = new Date("2026-08-04T12:00:00Z");
  const MINOR_DOB = "2016-09-11"; // 9 on NOW
  const base = {
    registering_self: false as boolean | undefined,
    guardian_name: null as string | null | undefined,
    guardian_consent: false,
    dob: null as string | null | undefined,
  };

  it("no session ⇒ null", () => {
    expect(deriveLinkUserId(null, { ...base, registering_self: true, dob: ADULT_DOB }, NOW))
      .toBeNull();
  });

  it("session but no affirmation ⇒ null", () => {
    expect(deriveLinkUserId("u1", { ...base, dob: ADULT_DOB }, NOW)).toBeNull();
  });

  it("session + affirmation + an ADULT dob ⇒ the session id", () => {
    expect(deriveLinkUserId("u1", { ...base, registering_self: true, dob: ADULT_DOB }, NOW))
      .toBe("u1");
  });

  it("guardian_name present ⇒ null", () => {
    expect(
      deriveLinkUserId(
        "u1",
        { ...base, registering_self: true, dob: ADULT_DOB, guardian_name: "Grace Guardian" },
        NOW,
      ),
    ).toBeNull();
  });

  it("guardian_consent true ⇒ null", () => {
    expect(
      deriveLinkUserId(
        "u1",
        { ...base, registering_self: true, dob: ADULT_DOB, guardian_consent: true },
        NOW,
      ),
    ).toBeNull();
  });

  it("NO dob ⇒ null — an unaged registrant may be anyone, including a child", () => {
    expect(deriveLinkUserId("u1", { ...base, registering_self: true, dob: null }, NOW)).toBeNull();
    expect(
      deriveLinkUserId("u1", { ...base, registering_self: true, dob: undefined }, NOW),
    ).toBeNull();
  });

  it("a MINOR's dob ⇒ null even with NO guardian fields at all", () => {
    expect(deriveLinkUserId("u1", { ...base, registering_self: true, dob: MINOR_DOB }, NOW))
      .toBeNull();
  });
});

// describe("registration session capture (#402)") DELETED (RS001 demolition,
// #588): all 7 tests drove `submitRegistration`'s own capture of the
// session's user_id onto the row it inserted. The column moved too
// (`registrations.user_id` → `registration_groups.user_id`, V364), but that
// is secondary — the write only ever happened INSIDE submitRegistration,
// which no longer exists. `deriveLinkUserId`, the pure decision function
// this capture step called, keeps its own full coverage above, unchanged.
// RS002/RS003 own re-wiring capture (and re-testing it) against the new
// group-shaped submit flow.

describe.skipIf(!HAS_DB)("organiser-side entry creation (#402)", () => {
  it("binds NO user_id to the person, even though the organiser is signed in", async () => {
    const { auth } = await seedOrg("pro");
    const div = await seedOpenDivision(auth);
    expect(auth.userId).toBeTruthy(); // the organiser IS a session, or this is vacuous

    // Structural, by design (spec §4): the session is resolved in the PUBLIC
    // route and passed inward, so no organiser-facing path can supply one. An
    // organiser adding an entry on someone's behalf must never bind their own
    // account to a player's identity — that is the same two-humans-one-person
    // corruption from the other end.
    const [entrant] = await createEntrants(auth, div.divisionId, [
      {
        kind: "individual",
        display_name: "Walk In",
        members: [{ new_person: { full_name: "Walk In" }, is_captain: false, roles: [] }],
        seed: null,
        team_id: null,
        copy_roster_from_entrant_id: null,
        badge_url: null,
      },
    ]);

    const people = await sql<{ user_id: string | null; lane: string }[]>`
      select p.user_id, p.lane from persons p
        join entrant_members em on em.person_id = p.id
       where em.entrant_id = ${entrant.id}`;
    expect(people).toHaveLength(1);
    expect(people[0].user_id).toBeNull();
    expect(people[0].lane).toBe("player");
    // …and the organiser's own account still holds no person in this org.
    const [{ n }] = await sql<{ n: string }[]>`
      select count(*)::text as n from persons
       where org_id = ${auth.orgId} and user_id = ${auth.userId}`;
    expect(Number(n)).toBe(0);
  });
});

// describe("person resolution by (org_id, user_id, 'player') (#402)")
// DELETED (RS001 demolition, #588): all 7 tests depended on TWO things that
// no longer hold. (1) submitRegistration's session capture — see the note
// above. (2) `resolvePlayerPerson`, the upsert-by-(org_id,user_id,'player')
// this whole describe block existed to pin, is no longer CALLED by
// `materialise`/`confirmRegistration` at all: `registration_players` carries
// no `user_id` for the new per-player-consent model to resolve against (see
// registrations.ts's `loadPlayers` and `resolvePlayerPerson` doc comments —
// "Orphaned by the RS001 registration demolition… Exported, not deleted:
// RS002/RS008 need this exact upsert once the claim flow supplies a real
// link"). Today `materialise` inserts a fresh, unlinked person on every
// confirm — seeding around problem (1) here would just prove problem (2) a
// test failure, not a passing regression pin. RS002/RS008 own re-wiring the
// resolve-on-confirm call and re-testing this file's whole premise once the
// claim flow supplies a real link.
