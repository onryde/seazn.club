// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import { newSession, call, check, signIn, tag, smokeDb, v1, v1data } from "../harness.ts";

/**
 * RS010 — restores gapSuite's dropped #402 self-link/dedup block, plus the
 * consent opt-out mask, over real HTTP.
 *
 * Unit-level coverage for the #402 headline claim ITSELF still exists and is
 * thorough — checked before writing this, contrary to this task's own "may
 * have been gutted" flag:
 * apps/web/src/server/usecases/__tests__/registration-user-link.test.ts:240
 * ("THE headline: one signed-in registrant, two divisions ⇒ ONE persons row,
 * linked"). That test calls `seedPlayerEntry`/`confirmRegistration` directly
 * — it never touches the public register ROUTE, so it proves nothing about
 * whether that route actually reads the session cookie and threads
 * `sessionUserId` through (`getCurrentUser()` in
 * .../register/route.ts). This suite is that HTTP-wiring proof, layered on
 * top of already-solid unit coverage, not a gap-fill for a missing one.
 *
 * Reuses `delivered+selflink_${tag}@resend.dev` — already present, orphaned, in
 * cleanup()'s emails array with a #402/gapSuite comment naming exactly this
 * suite's shape.
 */
export async function registrationSelfLinkAndConsentSuite(): Promise<void> {
  const owner = newSession();
  const who = await signIn(owner, `delivered+regself_${tag}@resend.dev`);
  const orgId = who.org_id;
  const orgs = (await call(owner, "/api/orgs")) as { id: string; slug: string }[];
  const orgSlug = orgs.find((o) => o.id === orgId)!.slug;

  const genericConfig = {
    resultMode: "score",
    allowDraws: true,
    points: { w: 3, d: 1, l: 0 },
    progressScore: false,
  };
  const dbUrl = process.env.DATABASE_URL;
  if (dbUrl) {
    const db = smokeDb();
    try {
      await db`insert into sports (key, name, module_version, position_catalog)
               values ('generic', 'Generic', '1.0.0', ${db.json({ groups: [], lineup: { size: 1, benchMax: 0 } })})
               on conflict (key) do nothing`;
      await db`insert into sport_variants (sport_key, key, name, config, is_system)
               values ('generic', 'score', 'Score', ${db.json(genericConfig)}, true)
               on conflict do nothing`;
    } finally {
      await db.end();
    }
  }

  const comp = v1data<{ id: string; slug: string }>(
    await v1(owner, "/api/v1/competitions", "POST", {
      ends_on: "2030-12-31",
      name: `Self Link Cup ${tag}`,
      visibility: "public",
    }),
  );
  const divA = v1data<{ id: string; slug: string }>(
    await v1(owner, `/api/v1/competitions/${comp.id}/divisions`, "POST", {
      name: "Singles",
      sport_key: "generic",
      variant_key: "score",
      config: genericConfig,
    }),
  );
  const divB = v1data<{ id: string }>(
    await v1(owner, `/api/v1/competitions/${comp.id}/divisions`, "POST", {
      name: "Doubles Feeder",
      sport_key: "generic",
      variant_key: "score",
      config: genericConfig,
    }),
  );
  for (const d of [divA, divB]) {
    const set = await v1(owner, `/api/v1/divisions/${d.id}/registration-settings`, "PUT", {
      enabled: true,
      entrant_kind: "individual",
      fee_cents: 0,
      approval: "auto",
      form_fields: [],
    });
    check(`self-link: division ${d.id.slice(0, 8)} accepts registration settings`, set.status === 200);
  }

  const registrant = newSession();
  await signIn(registrant, `delivered+selflink_${tag}@resend.dev`);
  const fullName = `Selflink Player ${tag}`;
  const dob = "1990-01-01"; // adult — deriveLinkUserId refuses a minor regardless of affirmation

  type SubmitOut = { entries: { registration_id: string; status: string }[] };
  const submitSelf = async (divisionId: string) =>
    v1data<SubmitOut>(
      await v1(
        registrant,
        `/api/v1/public/orgs/${orgSlug}/competitions/${comp.slug}/register`,
        "POST",
        {
          contact: { name: fullName, email: `delivered+selflink_${tag}@resend.dev`, dob },
          privacy_consent: true,
          entries: [
            {
              division_id: divisionId,
              entrant_kind: "individual",
              players: [{ full_name: fullName, dob }],
              answers: {},
              registering_self: true,
              self_player_index: 0,
            },
          ],
        },
      ),
    );

  const subA = await submitSelf(divA.id);
  const subB = await submitSelf(divB.id);
  check(
    "self-link: both self-registrations confirm immediately (auto/free)",
    subA.entries[0]?.status === "confirmed" && subB.entries[0]?.status === "confirmed",
  );

  const myPersons = v1data<{ id: string; full_name: string }[]>(
    await v1(registrant, "/api/v1/me/persons"),
  );
  check(
    "self-link (#402): one signed-in registrant across two divisions resolves to ONE persons row, not two",
    myPersons.length === 1 && myPersons[0].full_name === fullName,
  );
  const personId = myPersons[0].id;

  type PublicEntrantsOut = { entrants: { display_name: string }[] };
  const divAEntrantsUrl =
    `/api/v1/public/orgs/${orgSlug}/competitions/${comp.slug}/divisions/${divA.slug}/entrants`;

  // --- Baseline: no opt-out yet, the public entrant list shows the FULL name ---
  const beforeEntrants = v1data<PublicEntrantsOut>(await v1(newSession(), divAEntrantsUrl));
  check(
    "consent: before any opt-out, the public entrant list shows the registrant's FULL name",
    beforeEntrants.entrants.some((e) => e.display_name === fullName),
  );

  // --- Opt out, then prove the mask on the SAME public surface ---
  type ConsentOut = { consent: { public_name?: boolean } };
  const patched = await v1(registrant, `/api/v1/me/persons/${personId}/consent`, "PATCH", {
    public_name: false,
  });
  check(
    "consent: PATCH /me/persons/:id/consent {public_name:false} records the opt-out",
    patched.status === 200 && v1data<ConsentOut>(patched).consent.public_name === false,
  );

  // Mirrors lib/name-display.ts's own maskOne exactly: first word + " " +
  // last word's first letter + "." — derived from the SAME fullName this
  // suite submitted, not a hand-typed guess, so a future change to that
  // format moves this assertion with it.
  const parts = fullName.trim().split(/\s+/);
  const expectedMasked = `${parts[0]} ${parts[parts.length - 1].slice(0, 1)}.`;
  const afterEntrants = v1data<PublicEntrantsOut>(await v1(newSession(), divAEntrantsUrl));
  check(
    `consent: after opting out, the SAME public entrant list masks the name to "${expectedMasked}" — not the full name`,
    afterEntrants.entrants.some((e) => e.display_name === expectedMasked) &&
      !afterEntrants.entrants.some((e) => e.display_name === fullName),
  );
}
