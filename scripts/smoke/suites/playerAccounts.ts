// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import { BASE, type Session, newSession, call, check, signIn, tag, v1, v1data } from "../harness.ts";

/** PROMPT-53 player accounts over real HTTP: invite → claim → RSVP →
 *  organiser grid chip → QR check-in → clean 409 on a second invite; the
 *  never-invited teammate stays untouched (no public card, "—" chip). The
 *  free path runs on the player's own auto-provisioned COMMUNITY org —
 *  claim invites must mint on every plan. */
export async function playerAccountsSuite(admin: Session, orgId: string): Promise<void> {
  const player = newSession();
  const playerVer = await signIn(player, `delivered+player_${tag}@resend.dev`);

  admin.cookies["seazn_org"] = orgId; // active-org cookie targets the v1 calls
  const orgs = (await call(admin, "/api/orgs")) as {
    id: string;
    slug: string;
  }[];
  const orgSlug = orgs.find((o) => o.id === orgId)!.slug;

  const comp = await v1(admin, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
    name: `Claim Cup ${tag}`,
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
  const pa = await v1(admin, "/api/v1/persons", "POST", {
    full_name: `Pat Claimer ${tag}`,
    consent: {},
  });
  const pb = await v1(admin, "/api/v1/persons", "POST", {
    full_name: `Uma Unclaimed ${tag}`,
    consent: {},
  });
  const personId = v1data<{ id: string }>(pa).id;
  const unclaimedId = v1data<{ id: string }>(pb).id;
  await v1(admin, `/api/v1/divisions/${divData.id}/entrants`, "POST", [
    {
      kind: "individual",
      display_name: "Pat",
      seed: 1,
      members: [{ person_id: personId }],
    },
    {
      kind: "individual",
      display_name: "Uma",
      seed: 2,
      members: [{ person_id: unclaimedId }],
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
  const fixture = v1data<{ fixtures: { id: string; fixture_no: number }[] }>(gen).fixtures[0];
  await v1(admin, `/api/v1/divisions/${divData.id}/start`, "POST");
  const fixturePath = `/o/${orgSlug}/c/${compData.slug}/d/${divData.slug}/f/${fixture.fixture_no}`;

  // Invite → claim (the claim_url IS the credential; shown once).
  const invite = await v1(admin, `/api/v1/persons/${personId}/claim-invites`, "POST", {
    email: `delivered+player_${tag}@resend.dev`,
  });
  const claimUrl = v1data<{ claim_url: string }>(invite).claim_url ?? "";
  check("pa claim invite minted", invite.status === 201 && claimUrl.includes("/claim/pc_"));
  const accepted = (await call(
    player,
    `/api/claims/${claimUrl.split("/claim/")[1]}/accept`,
    "POST",
  )) as {
    person_id?: string;
  };
  check("pa player claimed the profile", accepted.person_id === personId);

  // /me carries the fixture; RSVP out with a note.
  const mine = await v1(player, "/api/v1/me/fixtures");
  const upcoming = v1data<{ upcoming: { id: string }[] }>(mine).upcoming ?? [];
  check(
    "pa /me/fixtures lists the claimed fixture",
    upcoming.some((f) => f.id === fixture.id),
  );
  const rsvp = await v1(player, `/api/v1/me/fixtures/${fixture.id}/availability`, "PUT", {
    status: "out",
    note: "smoke note",
  });
  check("pa RSVP saved", rsvp.status === 200);

  // Organiser grid: ✗ chip with the note; unclaimed teammate shows "—".
  const gridRes = await fetch(`${BASE}${fixturePath}`, {
    headers: {
      cookie: Object.entries(admin.cookies)
        .map(([k, v]) => `${k}=${v}`)
        .join("; "),
    },
  });
  const html = await gridRes.text();
  check(
    "pa grid shows the unavailable chip",
    gridRes.status === 200 && html.includes("unavailable — smoke note"),
  );
  check("pa unclaimed teammate shows no-answer chip", html.includes("no availability answer"));

  // Competition desk (W1): the ledger row's data-phase attribute is a
  // derived fact, never stored — this competition has a started division
  // with a generated fixture, so its row must carry one of the four phases
  // (DivisionPhase: setting_up | scheduled | match_day | finished).
  const compHtml = await (
    await fetch(`${BASE}/o/${orgSlug}/c/${compData.slug}`, {
      headers: { cookie: Object.entries(admin.cookies).map(([k, v]) => `${k}=${v}`).join("; ") },
    })
  ).text();
  // Fix round B minor: the old regex matched ANY single `data-phase`
  // anywhere on the page — including the MASTHEAD's own competition-level
  // pill (which can legitimately carry `data-phase="in_play"`/"next", never
  // a division word) — so a zero-division competition would still pass a
  // check titled "per division". Anchored on the ledger row's own two
  // adjacent attributes (`division-ledger.tsx`'s literal JSX output order)
  // and the real `DivisionPhase` union, which never includes "in_play".
  check(
    "competition page carries a derived phase per division",
    /data-testid="desk-ledger-row" data-phase="(setting_up|scheduled|match_day|finished)"/.test(compHtml),
  );

  // QR check-in: organiser mints, player taps; presence keeps the RSVP.
  const link = await v1(admin, `/api/v1/fixtures/${fixture.id}/checkin-link`, "POST");
  const url = v1data<{ url: string }>(link).url ?? "";
  check("pa check-in link minted", link.status === 201 && url.includes("/checkin/"));
  const checkedIn = (await call(player, `/api/checkin/${url.split("/checkin/")[1]}`, "POST")) as {
    checked_in?: boolean;
    status?: string;
  };
  check(
    "pa QR check-in keeps the explicit RSVP",
    checkedIn.checked_in === true && checkedIn.status === "out",
  );

  // Unclaimed person untouched: no public card without consent.
  const card = await fetch(`${BASE}/shared/${orgSlug}/${compData.slug}/players/${unclaimedId}`);
  check("pa unclaimed person has no public card", card.status === 404);

  // Second invite on a claimed person fails clean.
  const again = await v1(admin, `/api/v1/persons/${personId}/claim-invites`, "POST", {
    email: `delivered+else_${tag}@resend.dev`,
  });
  check("pa second invite on a claimed person is a clean 409", again.status === 409);

  // Free path: the player's own org is a fresh COMMUNITY org — claim
  // invites must mint there too (all plans, no requireFeature gate).
  const freePerson = await v1(player, "/api/v1/persons", "POST", {
    full_name: `Free Player ${tag}`,
    consent: {},
  });
  const freeInvite = await v1(
    player,
    `/api/v1/persons/${v1data<{ id: string }>(freePerson).id}/claim-invites`,
    "POST",
    { email: `delivered+else_${tag}@resend.dev` },
  );
  check(
    "pa claim invite mints on a community org (no plan gate)",
    playerVer.has_org === true && freeInvite.status === 201,
  );
}
