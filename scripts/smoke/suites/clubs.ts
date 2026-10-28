// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import { newSession, check, signIn, tag, v1, v1data, setPlan } from "../harness.ts";

/** clubs-w1 (W1 §5): parent clubs group teams across divisions. The Pro path
 *  walks the whole /clubs/[id] hub lifecycle over HTTP — create a club, PATCH
 *  its profile (home ground), add a committee contact, create a *standalone*
 *  team, move it under the club, then replace its squad with a person created
 *  inline (the squad editor's quick-add). The free path proves the V319
 *  community cap: clubs.max = 5, so five clubs succeed and the sixth 402s with
 *  the `feature_key` the contextual <UpgradeGate> reads. Both run on their own
 *  fresh orgs (Pro flipped via setPlan, free stays community) so the suite is
 *  order-independent — the earlier suites downgrade the shared org2. */
export async function clubsSuite(): Promise<void> {
  // --- Pro path: the full club-hub lifecycle.
  const pro = newSession();
  const proVer = await signIn(pro, `delivered+clubpro_${tag}@resend.dev`);
  await setPlan(proVer.org_id, "pro", pro);

  const club = await v1(pro, "/api/v1/clubs", "POST", {
    name: `Riverside SC ${tag}`,
  });
  check("clubs pro: club created (201)", club.status === 201);
  const clubId = v1data<{ id: string }>(club).id;

  const patched = await v1(pro, `/api/v1/clubs/${clubId}`, "PATCH", {
    home_ground: "Riverside Park",
    website: "https://riverside.example",
  });
  check(
    "clubs pro: profile PATCH persists the home ground",
    patched.status === 200 &&
      v1data<{ home_ground: string | null }>(patched).home_ground === "Riverside Park",
  );

  const contact = await v1(pro, `/api/v1/clubs/${clubId}/contacts`, "POST", {
    role_key: "secretary",
    full_name: `Sam Secretary ${tag}`,
    email: `delivered+sam_${tag}@resend.dev`,
    is_primary: true,
  });
  check("clubs pro: committee contact added (201)", contact.status === 201);
  // The contact surfaces on the hub read (getClub feeds the Overview tab).
  const detail = await v1(pro, `/api/v1/clubs/${clubId}`);
  const contacts =
    v1data<{ contacts: { full_name: string; is_primary: boolean }[] }>(detail).contacts ?? [];
  check(
    "clubs pro: contact is primary on the hub read",
    contacts.some((c) => c.full_name === `Sam Secretary ${tag}` && c.is_primary),
  );

  // Standalone team (club_id omitted) — the directory ladder step 2 — then move
  // it under the club, exactly as the hub Teams-tab detach/attach does.
  const team = await v1(pro, "/api/v1/teams", "POST", {
    name: `Riverside U12 ${tag}`,
  });
  check(
    "clubs pro: standalone team created (no club)",
    team.status === 201 && v1data<{ club_id: string | null }>(team).club_id === null,
  );
  const teamId = v1data<{ id: string }>(team).id;
  const moved = await v1(pro, `/api/v1/teams/${teamId}`, "PATCH", {
    club_id: clubId,
  });
  check(
    "clubs pro: team moved under the club",
    moved.status === 200 && v1data<{ club_id: string | null }>(moved).club_id === clubId,
  );

  // Quick-add a person (squad editor inline create), then full-replace the squad.
  const person = await v1(pro, "/api/v1/persons", "POST", {
    full_name: `Quinn Quickadd ${tag}`,
  });
  check("clubs pro: quick-add person created (201)", person.status === 201);
  const personId = v1data<{ id: string }>(person).id;
  const squad = await v1(pro, `/api/v1/teams/${teamId}/squad`, "PUT", {
    members: [{ person_id: personId, squad_number: 7, is_captain: true }],
  });
  const members =
    v1data<{
      members: {
        person_id: string;
        is_captain: boolean;
        squad_number: number | null;
      }[];
    }>(squad).members ?? [];
  check(
    "clubs pro: squad saved with the quick-added captain (#7)",
    squad.status === 200 &&
      members.length === 1 &&
      members[0].person_id === personId &&
      members[0].is_captain === true &&
      members[0].squad_number === 7,
  );

  // Enroll the team → the entrant roster is a ONE-TIME snapshot of the squad;
  // later squad edits stay off the entry until the explicit roster/sync.
  const syncComp = await v1(pro, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
    name: `Sync Cup ${tag}`,
    visibility: "private",
  });
  const syncDiv = await v1(
    pro,
    `/api/v1/competitions/${v1data<{ id: string }>(syncComp).id}/divisions`,
    "POST",
    {
      name: "Sync Div",
      sport_key: "generic",
      variant_key: "score",
      config: {
        resultMode: "score",
        allowDraws: true,
        points: { w: 3, d: 1, l: 0 },
        progressScore: false,
      },
    },
  );
  const syncDivId = v1data<{ id: string }>(syncDiv).id;
  const enrolled = await v1(pro, `/api/v1/divisions/${syncDivId}/entrants`, "POST", [
    { kind: "team", team_id: teamId, members: [] },
  ]);
  const entrantId = v1data<{ id: string }[]>(enrolled)[0].id;
  const seeded = await v1(pro, `/api/v1/entrants/${entrantId}`);
  check(
    "clubs pro: enrollment seeded the roster from the squad (snapshot of 1)",
    enrolled.status === 201 && (v1data<{ members: unknown[] }>(seeded).members ?? []).length === 1,
  );

  const late = await v1(pro, "/api/v1/persons", "POST", {
    full_name: `Lena Late ${tag}`,
  });
  const lateId = v1data<{ id: string }>(late).id;
  await v1(pro, `/api/v1/teams/${teamId}/squad`, "PUT", {
    members: [
      { person_id: personId, squad_number: 7, is_captain: true },
      { person_id: lateId, squad_number: 9 },
    ],
  });
  const stale = await v1(pro, `/api/v1/entrants/${entrantId}`);
  check(
    "clubs pro: squad edit does NOT touch the enrolled roster (still 1)",
    (v1data<{ members: unknown[] }>(stale).members ?? []).length === 1,
  );
  const synced = await v1(pro, `/api/v1/entrants/${entrantId}/roster/sync`, "POST", {});
  check(
    "clubs pro: roster/sync replaces the entry roster with the current squad (2)",
    synced.status === 200 && (v1data<{ members: unknown[] }>(synced).members ?? []).length === 2,
  );
  const solo = await v1(pro, `/api/v1/divisions/${syncDivId}/entrants`, "POST", [
    { kind: "individual", display_name: `Solo ${tag}`, members: [] },
  ]);
  const soloSync = await v1(
    pro,
    `/api/v1/entrants/${v1data<{ id: string }[]>(solo)[0].id}/roster/sync`,
    "POST",
    {},
  );
  check("clubs pro: roster/sync on a team-less entrant 422s", soloSync.status === 422);

  // --- Free path: the tunable community clubs.max = 5 (V319 "free runs big").
  // Five clubs land, the sixth 402s with the feature key that drives the paywall.
  const free = newSession();
  await signIn(free, `delivered+clubfree_${tag}@resend.dev`);
  const freeClubs = [];
  for (let i = 1; i <= 5; i++) {
    freeClubs.push(await v1(free, "/api/v1/clubs", "POST", { name: `Free Club ${i} ${tag}` }));
  }
  check("clubs free: first five clubs allowed on community", freeClubs.every((r) => r.status === 201));
  const c6 = await v1(free, "/api/v1/clubs", "POST", {
    name: `Free Club Six ${tag}`,
  });
  check(
    "clubs free: sixth club 402s with the clubs.max feature key",
    c6.status === 402 &&
      (c6.json.error as { feature_key?: string } | undefined)?.feature_key === "clubs.max",
  );
}
