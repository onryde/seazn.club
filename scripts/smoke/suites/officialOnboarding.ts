import postgres from "postgres";
// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import {
  BASE, type Session, newSession, call, check, signIn, tag, checkOutboxRow, html, v1, v1data,
} from "../harness.ts";

/** PROMPT-57/officials-unify official onboarding over real HTTP: create
 *  official → assign → invite (shared claim rail, officiating copy) → claim
 *  as a second user → the assignment shows in /me and on My Matches → accept
 *  → decline flags on the organiser read → blackout date set/clear → score
 *  straight through the fixture console, exactly like a scorer (no separate
 *  device-mint — accepted officials pass the score-write gate). The free
 *  path proves the portal has no plan gate: an invite mints on the ref's own
 *  auto-provisioned COMMUNITY org. */
export async function officialOnboardingSuite(
  admin: Session,
  orgId: string,
  orgSlug: string,
): Promise<void> {
  const refEmail = `delivered+ref_${tag}@resend.dev`;
  const ref = newSession();
  const refVer = await signIn(ref, refEmail);

  admin.cookies["seazn_org"] = orgId;
  const comp = await v1(admin, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
    name: `Whistle Cup ${tag}`,
    visibility: "public",
  });
  const compData = v1data<{ id: string; slug: string }>(comp);
  const div = await v1(admin, `/api/v1/competitions/${compData.id}/divisions`, "POST", {
    name: "Open",
    sport_key: "generic",
    variant_key: "score",
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
  });
  const divData = v1data<{ id: string; slug: string }>(div);
  await v1(admin, `/api/v1/divisions/${divData.id}/entrants`, "POST", [
    {
      kind: "individual",
      display_name: `Whistle A ${tag}`,
      seed: 1,
      members: [],
    },
    {
      kind: "individual",
      display_name: `Whistle B ${tag}`,
      seed: 2,
      members: [],
    },
    {
      kind: "individual",
      display_name: `Whistle C ${tag}`,
      seed: 3,
      members: [],
    },
    {
      kind: "individual",
      display_name: `Whistle D ${tag}`,
      seed: 4,
      members: [],
    },
  ]);
  const stage = await v1(admin, `/api/v1/divisions/${divData.id}/stages`, "POST", {
    seq: 1,
    kind: "league",
    name: "League",
  });
  const gen = await v1(
    admin,
    `/api/v1/stages/${v1data<{ id: string }>(stage).id}/generate`,
    "POST",
  );
  const fixtures = v1data<{ fixtures: { id: string }[] }>(gen).fixtures;
  await v1(admin, `/api/v1/divisions/${divData.id}/start`, "POST");
  // Future kickoff: the /me lane only lists today-or-later fixtures. Pinned
  // to 10:00 UTC so the busy-elsewhere probe's "+3 hours, same calendar day"
  // premise holds at any run time — a run after 21:00 UTC used to push the
  // busy fixture past midnight and silently suppress the warn chip.
  const kickoffDate = new Date(Date.now() + 7 * 86_400_000);
  kickoffDate.setUTCHours(10, 0, 0, 0);
  const kickoff = kickoffDate.toISOString();
  const onboardVenue = v1data<{ id: string }>(
    await v1(admin, `/api/v1/orgs/${orgId}/venues`, "POST", { name: `Whistle Venue ${tag}` }),
  );
  const onboardCourt = v1data<{ id: string }>(
    await v1(admin, `/api/v1/orgs/${orgId}/venues/${onboardVenue.id}/courts`, "POST", {
      name: "Court 9",
    }),
  );
  await v1(admin, `/api/v1/fixtures/${fixtures[0].id}`, "PATCH", {
    scheduled_at: kickoff,
    court_id: onboardCourt.id,
  });

  // Create + assign BEFORE the invite: the fresh assignment must be pending.
  const off = await v1(admin, "/api/v1/officials", "POST", {
    display_name: `Ria Ref ${tag}`,
    role_keys: ["referee"],
  });
  const offId = v1data<{ id: string }>(off).id;
  await v1(admin, `/api/v1/fixtures/${fixtures[0].id}/officials`, "PATCH", {
    set: [{ official_id: offId, role_key: "referee", locked: false }],
  });

  // Invite through the SHARED person-claim rail (pc_ token, officiating copy).
  const invite = await v1(admin, `/api/v1/officials/${offId}/invite`, "POST", {
    email: refEmail,
  });
  const claimUrl = v1data<{ claim_url: string }>(invite).claim_url ?? "";
  check(
    "off invite mints through the person-claim rail",
    invite.status === 201 && claimUrl.includes("/claim/pc_"),
  );
  const token = claimUrl.split("/claim/")[1];
  const claimPage = await fetch(`${BASE}/claim/${token}`);
  const claimHtml = await claimPage.text();
  check(
    "off claim page shows officiating copy",
    claimPage.status === 200 && claimHtml.includes("Claim your officiating profile"),
  );

  const accepted = (await call(ref, `/api/claims/${token}/accept`, "POST")) as {
    person_id?: string;
  };
  check("off claim links the official's login", !!accepted.person_id);

  // /me carries the assignment card (assert on the unique fixture label, not
  // dict copy — the /me DictProvider serialises every ui string into the HTML).
  const meRes = await fetch(`${BASE}/me`, {
    headers: {
      cookie: Object.entries(ref.cookies)
        .map(([k, v]) => `${k}=${v}`)
        .join("; "),
    },
  });
  const meHtml = await meRes.text();
  check(
    "off /me lists the assigned fixture",
    meRes.status === 200 && meHtml.includes(`Whistle A ${tag}`),
  );

  // Accept; then decline a second assignment with a reason → organiser flag.
  const acceptRes = await v1(
    ref,
    `/api/v1/me/fixtures/${fixtures[0].id}/officiating-response`,
    "PATCH",
    {
      response: "accepted",
    },
  );
  check(
    "off accept lands",
    acceptRes.status === 200 && v1data<{ response: string }>(acceptRes).response === "accepted",
  );
  await v1(admin, `/api/v1/fixtures/${fixtures[1].id}/officials`, "PATCH", {
    set: [{ official_id: offId, role_key: "referee", locked: false }],
  });
  // Email outbox, phase 3 wave 4: the invite above stamped the official's address, so this manual set is the first
  // assignment that can notify — one `official_assigned` row, ref (fixture, official) as `patchFixtureOfficials` names it.
  await checkOutboxRow("official_assigned", "fixture_official", `${fixtures[1].id}:${offId}`);
  await v1(ref, `/api/v1/me/fixtures/${fixtures[1].id}/officiating-response`, "PATCH", {
    response: "declined",
    decline_reason: "smoke clash",
  });
  const flagged = await v1(admin, `/api/v1/fixtures/${fixtures[1].id}`);
  const flaggedOfficials =
    v1data<{ officials: { response?: string; decline_reason?: string }[] }>(flagged).officials ??
    [];
  check(
    "off decline flags on the organiser read (no auto-reassign)",
    flaggedOfficials.length === 1 &&
      flaggedOfficials[0].response === "declined" &&
      flaggedOfficials[0].decline_reason === "smoke clash",
  );
  // accepted → declined is refused (ask the organiser)
  const illegal = await v1(
    ref,
    `/api/v1/me/fixtures/${fixtures[0].id}/officiating-response`,
    "PATCH",
    {
      response: "declined",
    },
  );
  check("off accepted assignment cannot be self-declined", illegal.status === 422);

  // Blackout date: set (upsert) then clear.
  const blackout = await v1(ref, "/api/v1/me/availability/officiating", "POST", {
    date: "2027-03-07",
    note: "away",
  });
  check("off blackout date saved", blackout.status === 201);
  const cleared = await v1(ref, "/api/v1/me/availability/officiating?date=2027-03-07", "DELETE");
  check("off blackout date cleared", cleared.status === 200);

  // Score this match: accepted officials score straight through the fixture
  // console — no separate device-mint (design v2 §A3; Tasks 1-4 wire
  // acceptedOfficialCovers through requireFixtureActor). The accepted assignment
  // also surfaces the fixture on /me, unioned in from fixture_officials.
  const mePage = await html(ref, "/me");
  check(
    "off accepted fixture reachable via /me",
    mePage.status === 200 && mePage.body.includes(`Whistle A ${tag}`),
  );
  const offState = await v1(ref, `/api/v1/fixtures/${fixtures[0].id}/state`);
  check("off accepted official reads fixture state (non-member door)", offState.status === 200);
  const offScore = await v1(ref, `/api/v1/fixtures/${fixtures[0].id}/events`, "POST", {
    expected_seq: v1data<{ last_seq: number }>(offState).last_seq,
    type: "generic.result",
    payload: { p1Score: 2, p2Score: 1 },
  });
  check("off accepted official scores via the fixture console API", offScore.status === 201);

  // Regression (officials-unify): the accepted official must open the fixture
  // CONSOLE PAGE itself, not just the score API — the /o layout previously
  // 404'd non-members (an accepted official is usually a non-member), so the
  // page-level door stayed shut even though the API passed.
  const offFixNo = v1data<{ fixture_no: number }>(
    await v1(admin, `/api/v1/fixtures/${fixtures[0].id}`),
  ).fixture_no;
  const offConsole = await html(
    ref,
    `/o/${orgSlug}/c/${compData.slug}/d/${divData.slug}/f/${offFixNo}`,
  );
  check(
    "off accepted official opens the fixture console PAGE (non-member layout door)",
    offConsole.status === 200 && offConsole.body.includes(`Whistle A ${tag}`),
  );

  // Pending-invite accept-by-id (v11.1 /me "Pending invites" card): officials
  // belong to multiple orgs — a SECOND invite for the same ref, accepted
  // without ever touching the emailed token (the claim id from the invite
  // response is enough; the session's verified email does the rest).
  const off2 = await v1(admin, "/api/v1/officials", "POST", {
    display_name: `Ria Ref Two ${tag}`,
    role_keys: ["referee"],
  });
  const off2Id = v1data<{ id: string }>(off2).id;
  const invite2 = await v1(admin, `/api/v1/officials/${off2Id}/invite`, "POST", {
    email: refEmail,
  });
  const claim2Id = v1data<{ id: string }>(invite2).id ?? "";
  check("off second org invite mints its own claim id", invite2.status === 201 && !!claim2Id);

  // wrong email gets the generic 404 — same as a bogus id, so a non-owner
  // can't even learn the claim exists (review fix 2026-07-17).
  const stranger = newSession();
  await signIn(stranger, `delivered+stranger_${tag}@resend.dev`);
  const wrongAccept = await v1(
    stranger,
    `/api/v1/me/officiating-claims/${claim2Id}/accept`,
    "POST",
  );
  const bogusAccept = await v1(
    stranger,
    `/api/v1/me/officiating-claims/${crypto.randomUUID()}/accept`,
    "POST",
  );
  check(
    "off accept-by-id refuses a non-matching email with the generic 404",
    wrongAccept.status === 404 && bogusAccept.status === 404,
  );

  const accept2 = await v1(ref, `/api/v1/me/officiating-claims/${claim2Id}/accept`, "POST");
  check("off accept-by-id links the second org without the emailed token", accept2.status === 200);
  await checkOfficialClaimed(off2Id, true);

  // Free path: the ref's own org is a fresh COMMUNITY org — the officiating
  // portal must have no plan gate on invite/claim.
  const freeOff = await v1(ref, "/api/v1/officials", "POST", {
    display_name: `Free Ref ${tag}`,
    role_keys: ["referee"],
  });
  const freeInvite = await v1(
    ref,
    `/api/v1/officials/${v1data<{ id: string }>(freeOff).id}/invite`,
    "POST",
    {
      email: `delivered+else_${tag}@resend.dev`,
    },
  );
  check(
    "off invite mints on a community org (portal is free)",
    refVer.has_org === true && freeInvite.status === 201,
  );

  // Cross-org "booked elsewhere" derived read (v11.1 follow-up): the SAME
  // claimed official (offId, this org) also holds a scheduled assignment in
  // a DIFFERENT org (the account's own first org from signup) — the schedule's
  // Officials tab must warn with a time, never the other org's identity.
  const myOrgs = (await call(admin, "/api/orgs")) as {
    id: string;
    slug: string;
  }[];
  const busyOrg = myOrgs.find((o) => o.id !== orgId)!;
  admin.cookies["seazn_org"] = busyOrg.id;
  const busyOff = await v1(admin, "/api/v1/officials", "POST", {
    display_name: `Ria Ref Busy ${tag}`,
    role_keys: ["referee"],
  });
  const busyOffId = v1data<{ id: string }>(busyOff).id;
  const busyInvite = await v1(admin, `/api/v1/officials/${busyOffId}/invite`, "POST", {
    email: refEmail,
  });
  const busyClaimId = v1data<{ id: string }>(busyInvite).id ?? "";
  await v1(ref, `/api/v1/me/officiating-claims/${busyClaimId}/accept`, "POST");

  const busyComp = await v1(admin, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
    name: `Busy Cup ${tag}`,
    visibility: "public",
  });
  const busyDiv = await v1(
    admin,
    `/api/v1/competitions/${v1data<{ id: string }>(busyComp).id}/divisions`,
    "POST",
    {
      name: "Open",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    },
  );
  const busyDivId = v1data<{ id: string }>(busyDiv).id;
  await v1(admin, `/api/v1/divisions/${busyDivId}/entrants`, "POST", [
    { kind: "individual", display_name: `Busy A ${tag}`, seed: 1, members: [] },
    { kind: "individual", display_name: `Busy B ${tag}`, seed: 2, members: [] },
  ]);
  const busyStage = await v1(admin, `/api/v1/divisions/${busyDivId}/stages`, "POST", {
    seq: 1,
    kind: "league",
    name: "League",
  });
  const busyGen = await v1(
    admin,
    `/api/v1/stages/${v1data<{ id: string }>(busyStage).id}/generate`,
    "POST",
  );
  const busyFixtures = v1data<{ fixtures: { id: string }[] }>(busyGen).fixtures;
  await v1(admin, `/api/v1/divisions/${busyDivId}/start`, "POST");
  // Same calendar day as this org's fixtures[0] kickoff, a few hours later —
  // the warning is a same-day match, not an exact-instant one.
  const busyKickoff = new Date(new Date(kickoff).getTime() + 3 * 3_600_000).toISOString();
  const busyVenue = v1data<{ id: string }>(
    await v1(admin, `/api/v1/orgs/${busyOrg.id}/venues`, "POST", { name: `Busy Venue ${tag}` }),
  );
  const busyCourt = v1data<{ id: string }>(
    await v1(admin, `/api/v1/orgs/${busyOrg.id}/venues/${busyVenue.id}/courts`, "POST", {
      name: "Court 5",
    }),
  );
  await v1(admin, `/api/v1/fixtures/${busyFixtures[0].id}`, "PATCH", {
    scheduled_at: busyKickoff,
    court_id: busyCourt.id,
  });
  await v1(admin, `/api/v1/fixtures/${busyFixtures[0].id}/officials`, "PATCH", {
    set: [{ official_id: busyOffId, role_key: "referee", locked: false }],
  });

  // Switch back to this org and read its own schedule Officials tab: offId
  // (the SAME claimed person, already assigned+accepted on fixtures[0]) is
  // flagged busy with a real time — the raw {time} template lives in the
  // page's embedded dict regardless, so only a substituted HH:MM counts.
  admin.cookies["seazn_org"] = orgId;
  const sched = await html(
    admin,
    `/o/${orgSlug}/c/${compData.slug}/d/${divData.slug}/schedule?tab=officials`,
  );
  check(
    "off booked-elsewhere warns with a real time, not the raw {time} template",
    sched.status === 200 && /booked elsewhere ·\s*\d{1,2}:\d{2}/.test(sched.body),
  );
  // The org switcher legitimately lists every org THIS admin belongs to
  // (including busyOrg) regardless of this feature — that's normal nav
  // chrome, not a leak. The real leak surface is the derived-read's own
  // data: the other org's COMPETITION/DIVISION never reaches this page.
  check(
    "off booked-elsewhere never leaks the other org's competition/division",
    !sched.body.includes(`Busy Cup ${tag}`) && !sched.body.includes(`Busy A ${tag}`),
  );
}

/** v11.1 pending-invite accept-by-id: confirm the official's person row
 *  actually got linked (not just a 200 on the accept call) — same ad-hoc
 *  connection convention as checkTermsStamp/setStaff. Keyless runs skip. */
async function checkOfficialClaimed(officialId: string, expected: boolean): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) return;
  const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  const sql = postgres(url, {
    connection: { search_path: process.env.DB_SCHEMA ?? "seazn_club" },
    ssl: process.env.DATABASE_SSL === "disable" ? false : isLocal ? false : "require",
    prepare: !url.includes(":6543"),
    max: 1,
  });
  try {
    const [row] = await sql<{ claimed: boolean }[]>`
      select (p.user_id is not null) as claimed
      from officials o join persons p on p.id = o.person_id
      where o.id = ${officialId}`;
    check(
      `off official ${officialId.slice(0, 8)} claimed=${expected}`,
      (row?.claimed ?? false) === expected,
    );
  } finally {
    await sql.end();
  }
}
