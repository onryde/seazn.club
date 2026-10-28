// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import {
  BASE, type Session, newSession, cookieHeader, raw, call, check, signIn, tag, html, v1, v1data, printScorerSheets,
  orgDayOf,
} from "../harness.ts";
import { scorerSheetsSuite } from "./scorerSheets.ts";

/** Printing ensures a device link per match, so the sheet carries the device
 *  links' Community gate. The match is timed first: an empty day is refused
 *  422 before the gate is ever asked, which would pass a bare "not 200" for
 *  the wrong reason. */
async function scorerSheetsCommunityCheck(free: Session, competitionId: string, fixtureId: string): Promise<void> {
  const when = "2026-10-03T12:00:00.000Z";
  const timed = await v1(free, `/api/v1/fixtures/${fixtureId}`, "PATCH", { scheduled_at: when });
  const print = await printScorerSheets(
    free,
    competitionId,
    await orgDayOf(free, competitionId, when),
    new URL(BASE).origin,
  );
  const body = (await print.json().catch(() => ({}))) as { error?: { code?: string } };
  check(
    "scorer sheets Pro-gated (402 PAYMENT_REQUIRED on community, a match on the day)",
    timed.status === 200 && print.status === 402 && body.error?.code === "PAYMENT_REQUIRED",
  );
}

export async function gapSuite(admin: Session, org1Id: string, proOrgId: string): Promise<void> {
  // A dedicated started division in the Pro org for device links + officials.
  const comp = await v1(admin, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
    name: `Gap Cup ${tag}`,
  });
  const compId = v1data<{ id: string }>(comp).id;
  const div = await v1(admin, `/api/v1/competitions/${compId}/divisions`, "POST", {
    name: "Gap",
    sport_key: "generic",
    variant_key: "score",
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
  });
  const divId = v1data<{ id: string }>(div).id;
  await v1(
    admin,
    `/api/v1/divisions/${divId}/entrants`,
    "POST",
    ["GA", "GB", "GC", "GD"].map((n, i) => ({
      kind: "individual",
      display_name: n,
      seed: i + 1,
    })),
  );
  const stage = await v1(admin, `/api/v1/divisions/${divId}/stages`, "POST", {
    seq: 1,
    kind: "league",
    name: "League",
  });
  const gen = await v1(
    admin,
    `/api/v1/stages/${v1data<{ id: string }>(stage).id}/generate`,
    "POST",
  );
  const fixtureId = v1data<{ fixtures: { id: string }[] }>(gen).fixtures[0].id;
  await v1(admin, `/api/v1/divisions/${divId}/start`, "POST");

  // --- Device links (Pro): mint once, token opens the scoring door alone ---
  const dl = await v1(admin, `/api/v1/fixtures/${fixtureId}/device-links`, "POST", {
    label: "Court 1",
  });
  const dlSecret = v1data<{ secret: string }>(dl).secret ?? "";
  check("gap device link minted (dl_)", dl.status === 201 && dlSecret.startsWith("dl_"));

  // Saved lineups must reach the account-less pad: /score/[token] once
  // rendered `lineup: []`, so fixture-console saves never showed courtside.
  // Runs before the scoring event below — lineups lock once in_play. The
  // name lands in the pad payload twice (roster prop + lineup prop); the
  // roster alone would make a bare includes() pass even without the fix.
  const fx0 = v1data<{ home_entrant_id: string }>(
    await v1(admin, `/api/v1/fixtures/${fixtureId}`, "GET"),
  );
  const padPerson = v1data<{ id: string }>(
    await v1(admin, "/api/v1/persons", "POST", {
      full_name: `Pad Lineup ${tag}`,
    }),
  );
  await v1(admin, `/api/v1/entrants/${fx0.home_entrant_id}`, "PATCH", {
    members: [{ person_id: padPerson.id }],
  });
  const luPut = await v1(
    admin,
    `/api/v1/fixtures/${fixtureId}/lineups/${fx0.home_entrant_id}`,
    "PUT",
    { slots: [{ person_id: padPerson.id, slot: "starting", order_no: 1 }] },
  );
  check("gap lineup saved while scheduled", luPut.status === 200);
  const luPadHtml = await (await fetch(`${BASE}/score/${dlSecret}`)).text();
  const luHits = luPadHtml.split(`Pad Lineup ${tag}`).length - 1;
  check("gap device pad carries the saved lineup (roster + lineup props)", luHits >= 2);
  const bare = newSession(); // no cookies — the token is the credential
  const dlState = await v1(bare, `/api/v1/fixtures/${fixtureId}/state`, "GET", undefined, {
    Authorization: `Bearer ${dlSecret}`,
  });
  const dlSeq = v1data<{ last_seq: number }>(dlState).last_seq;
  const dlEvent = await v1(
    bare,
    `/api/v1/fixtures/${fixtureId}/events`,
    "POST",
    {
      expected_seq: dlSeq,
      type: "generic.result",
      payload: { p1Score: 2, p2Score: 1 },
    },
    { Authorization: `Bearer ${dlSecret}` },
  );
  check("gap device-link bearer can score", dlEvent.status === 201);

  // …and ONLY its own fixture. A dl_ token is minted for one fixture; a
  // sibling in the same division must be refused at the door. Pin 403 AND the
  // message: a bare non-200 also passes for an expired link, a stale seq or a
  // malformed payload, none of which is the ownership refusal. This is the
  // difference between "scoring detail is free" and "open scoring", and smoke
  // is the only gate that sees it before a merge (e2e runs on push to main).
  const dlOtherFixtureId = v1data<{ fixtures: { id: string }[] }>(gen).fixtures[1].id;
  const dlOtherBefore = v1data<{ last_seq: number }>(
    await v1(admin, `/api/v1/fixtures/${dlOtherFixtureId}/state`),
  ).last_seq;
  const dlCross = await v1(
    bare,
    `/api/v1/fixtures/${dlOtherFixtureId}/events`,
    "POST",
    { expected_seq: dlOtherBefore, type: "generic.result", payload: { p1Score: 9, p2Score: 0 } },
    { Authorization: `Bearer ${dlSecret}` },
  );
  const dlOtherAfter = v1data<{ last_seq: number }>(
    await v1(admin, `/api/v1/fixtures/${dlOtherFixtureId}/state`),
  ).last_seq;
  check(
    "gap device-link bearer refused on a fixture it does not own (403, message, nothing written)",
    dlCross.status === 403 &&
      dlCross.json.error?.message === "This device link is for a different fixture" &&
      dlOtherAfter === dlOtherBefore,
  );
  // The pad page wears the org brand (chain set by jul3Suite: org #1d4ed8);
  // Gap Cup has no competition color, so the org default shows through.
  const padHtml = await (await fetch(`${BASE}/score/${dlSecret}`)).text();
  check("gap device pad carries the org theme", padHtml.includes("--ps-accent:#1d4ed8"));

  // --- Scorer sheets (Pro): the printed day, over the real route ---
  await scorerSheetsSuite(admin);

  // --- Free official scores fixture[1]: assign → claim → accept → /me → score ---
  const gapFixture2Id = v1data<{ fixtures: { id: string }[] }>(gen).fixtures[1].id;
  const gapOfficial = v1data<{ id: string }>(
    await v1(admin, "/api/v1/officials", "POST", {
      display_name: `Gap Ref ${tag}`,
      role_keys: ["referee"],
    }),
  );
  await v1(admin, `/api/v1/fixtures/${gapFixture2Id}/officials`, "PATCH", {
    set: [{ official_id: gapOfficial.id, role_key: "referee", locked: false }],
  });
  const gapOffEmail = `delivered+gap_official_${tag}@resend.dev`;
  const gapOffSession = newSession();
  await signIn(gapOffSession, gapOffEmail);
  const gapOffInvite = await v1(admin, `/api/v1/officials/${gapOfficial.id}/invite`, "POST", {
    email: gapOffEmail,
  });
  const gapOffToken =
    (v1data<{ claim_url: string }>(gapOffInvite).claim_url ?? "").split("/claim/")[1] ?? "";
  await call(gapOffSession, `/api/claims/${gapOffToken}/accept`, "POST");
  const gapOffAccept = await v1(
    gapOffSession,
    `/api/v1/me/fixtures/${gapFixture2Id}/officiating-response`,
    "PATCH",
    { response: "accepted" },
  );
  check("gap official accept lands", gapOffAccept.status === 200);
  const gapMe = await html(gapOffSession, "/me");
  check("gap accepted official sees duty on /me", gapMe.status === 200);
  const gapOffState = await v1(gapOffSession, `/api/v1/fixtures/${gapFixture2Id}/state`);
  const gapOffScore = await v1(gapOffSession, `/api/v1/fixtures/${gapFixture2Id}/events`, "POST", {
    expected_seq: v1data<{ last_seq: number }>(gapOffState).last_seq,
    type: "generic.result",
    payload: { p1Score: 1, p2Score: 0 },
  });
  check("gap free official scores via fixture console API", gapOffScore.status === 201);

  // --- Discovery: public + discoverable (started division passes the quality
  // floor); discoverable without public visibility is rejected ---
  const pub = await v1(admin, `/api/v1/competitions/${compId}`, "PATCH", {
    visibility: "public",
  });
  check("gap competition made public", pub.status === 200);
  // Published as well: a draft is listed nowhere, Discover included (owner
  // decision 2026-09-27, V419). After the division start above, which would
  // otherwise promote a published competition to `live`.
  const disc = await v1(admin, `/api/v1/competitions/${compId}`, "PATCH", {
    status: "published",
    discoverable: true,
    discovery: { country: "GB" },
  });
  check("gap discoverable set", disc.status === 200);
  const discovery = await v1(
    bare,
    `/api/v1/public/discovery?q=${encodeURIComponent(`Gap Cup ${tag}`)}`,
  );
  check(
    "gap discovery lists the competition",
    discovery.status === 200 &&
      v1data<{ items: { name: string }[] }>(discovery).items.some(
        (i) => i.name === `Gap Cup ${tag}`,
      ),
  );
  const privComp = await v1(admin, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
    name: `Gap Hidden ${tag}`,
    visibility: "private",
  });
  const badDisc = await v1(
    admin,
    `/api/v1/competitions/${v1data<{ id: string }>(privComp).id}`,
    "PATCH",
    {
      discoverable: true,
    },
  );
  check("gap discoverable requires public (422)", badDisc.status === 422);

  // --- Public registration: open free signup → pending + access token →
  // organiser confirm materialises an entrant --- RS001 deleted the public
  // submit endpoint this drove (POST .../register); "pending + tokened",
  // "confirmed", and "confirmed registration is an entrant" all needed a
  // submitted row, so all three are gone with it. registration-settings
  // still PUTs successfully.
  const regSettings = await v1(admin, `/api/v1/divisions/${divId}/registration-settings`, "PUT", {
    enabled: true,
    entrant_kind: "individual",
    capacity: 10,
    fee_cents: 0,
    currency: "gbp",
    form_fields: [],
  });
  check("gap registration opened", regSettings.status === 200);

  // --- #402: a SIGNED-IN registrant who affirms "I'm registering myself" is
  // ONE person across every division they enter; the same account registering
  // a child under guardian consent stays a SEPARATE person — REMOVED by
  // RS001. Every check in this block (self-link across two divisions, the
  // undated-affirmation 400, one-person resolution, the guardian's separate
  // person, the me/persons dedup) submitted through the same deleted public
  // endpoint, so none of it can run until RS006/RS007 restore an entry
  // point. This is a bigger loss than the other registration coverage this
  // sweep removed: registration-user-link.test.ts's DB-backed SESSION-CAPTURE
  // tests went with `submitRegistration`, which owned the capture, and RS002/
  // RS003 owe them back. The person-RESOLUTION half is still covered — those
  // tests were restored against `registration_players.user_id`, so confirm
  // still proves it links and dedupes a person. What has no equivalent here is
  // the end-to-end path from a public submit to that link.

  // --- Free paths on a fresh community owner: device links 402, offline
  // entry fees allowed without Stripe ---
  const free = newSession();
  await signIn(free, `delivered+free_${tag}@resend.dev`);
  const fComp = await v1(free, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
    name: `Free Gap ${tag}`,
  });
  const fDiv = await v1(
    free,
    `/api/v1/competitions/${v1data<{ id: string }>(fComp).id}/divisions`,
    "POST",
    {
      name: "Free",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    },
  );
  const fDivId = v1data<{ id: string }>(fDiv).id;
  await v1(free, `/api/v1/divisions/${fDivId}/entrants`, "POST", [
    { kind: "individual", display_name: "F1", seed: 1 },
    { kind: "individual", display_name: "F2", seed: 2 },
  ]);
  const fStage = await v1(free, `/api/v1/divisions/${fDivId}/stages`, "POST", {
    seq: 1,
    kind: "league",
    name: "League",
  });
  const fGen = await v1(
    free,
    `/api/v1/stages/${v1data<{ id: string }>(fStage).id}/generate`,
    "POST",
  );
  const fFixture = v1data<{ fixtures: { id: string }[] }>(fGen).fixtures[0].id;
  const fDl = await v1(free, `/api/v1/fixtures/${fFixture}/device-links`, "POST", { label: "X" });
  check(
    "gap device links Pro-gated (402 on community)",
    fDl.status === 402 && fDl.json.error?.code === "PAYMENT_REQUIRED",
  );
  await scorerSheetsCommunityCheck(free, v1data<{ id: string }>(fComp).id, fFixture);
  const fFee = await v1(free, `/api/v1/divisions/${fDivId}/registration-settings`, "PUT", {
    enabled: true,
    entrant_kind: "individual",
    fee_cents: 500,
    currency: "gbp",
    form_fields: [],
  });
  check("gap offline entry fee allowed on community", fFee.status === 200);

  // Matchday documents (v12 PR1, Task 9): same export renders a valid PDF on
  // a community org — tables upgrade for every plan, only the masthead/
  // sponsor chrome differs (a visual difference the Task 18 gallery proves,
  // not a byte-level one).
  const freeDocPdf = await fetch(
    `${BASE}/api/v1/divisions/${fDivId}/exports/timetable?format=pdf`,
    {
      headers: { cookie: cookieHeader(free) },
    },
  );
  const freeDocPdfBytes = Buffer.from(await freeDocPdf.arrayBuffer());
  check(
    "exports timetable PDF renders a valid plain PDF (free)",
    freeDocPdf.status === 200 &&
      (freeDocPdf.headers.get("content-type") ?? "").includes("application/pdf") &&
      freeDocPdfBytes.subarray(0, 5).toString() === "%PDF-" &&
      freeDocPdfBytes.byteLength > 1024,
  );

  // --- Ownership transfer on org1 (owner + the invited members): away & back ---
  const members = (await call(admin, `/api/orgs/${org1Id}/members`)) as {
    user_id: string;
    email: string;
    role: string;
  }[];
  const owner = members.find((m) => m.role === "owner")!;
  const target = members.find((m) => m.role !== "owner")!;
  await call(admin, `/api/orgs/${org1Id}/transfer-owner`, "POST", {
    new_owner_id: target.user_id,
  });
  const mid = (await call(admin, `/api/orgs/${org1Id}/members`)) as {
    user_id: string;
    role: string;
  }[];
  check(
    "gap ownership transferred",
    mid.find((m) => m.user_id === target.user_id)?.role === "owner" &&
      mid.find((m) => m.user_id === owner.user_id)?.role === "admin",
  );
  // The old owner is admin now — the NEW owner must hand it back. Their
  // session belongs to viewer/member users created earlier; sign the target
  // user in fresh (same passwordless door).
  const targetSession = newSession();
  await signIn(targetSession, target.email);
  await raw(targetSession, "/api/orgs/active", "POST", { org_id: org1Id });
  await call(targetSession, `/api/orgs/${org1Id}/transfer-owner`, "POST", {
    new_owner_id: owner.user_id,
  });
  const after = (await call(admin, `/api/orgs/${org1Id}/members`)) as {
    user_id: string;
    role: string;
  }[];
  check("gap ownership restored", after.find((m) => m.user_id === owner.user_id)?.role === "owner");

  // --- Account: display-name edit + GDPR export ---
  const renamedMe = await raw(admin, "/api/users/me", "PATCH", {
    display_name: `Gap Admin ${tag}`,
  });
  check("gap display name updated", renamedMe.status === 200);
  const exported = await fetch(`${BASE}/api/users/me/export`, {
    headers: { cookie: cookieHeader(admin) },
  });
  check("gap account export downloads", exported.status === 200);

  // --- Downgrade → freeze (destructive; keep last). org2 has no Stripe
  // subscription, so the in-app downgrade applies immediately; over-quota
  // competitions freeze (least-recently-active first) while the rest stay
  // writable. ---
  await raw(admin, "/api/orgs/active", "POST", { org_id: proOrgId });
  const down = await raw(admin, "/api/billing/downgrade", "POST", {});
  check("gap in-app downgrade to community", down.status === 200);
  const list = await v1(admin, "/api/v1/competitions?limit=50");
  const comps = v1data<{ items: { id: string }[] } | { id: string }[]>(list);
  const ids = (Array.isArray(comps) ? comps : comps.items).map((c) => c.id);
  const probes = await Promise.all(
    ids.map((id) =>
      v1(admin, `/api/v1/competitions/${id}`, "PATCH", {
        description: "probe",
      }),
    ),
  );
  const blocked = probes.filter((p) => p.status === 402).length;
  const writable = probes.filter((p) => p.status === 200).length;
  check("gap downgrade freezes over-quota competitions", blocked >= 1);
  // Branding read-gates follow the plan down: the pad sheds the org theme.
  const downPadHtml = await (await fetch(`${BASE}/score/${dlSecret}`)).text();
  check("gap downgraded pad drops the org theme", !downPadHtml.includes("--ps-accent:#1d4ed8"));
  check("gap in-quota competitions stay writable", writable >= 1);
}
