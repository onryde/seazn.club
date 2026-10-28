// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import { BASE, type Session, cookieHeader, call, check, tag, v1, v1data, v1Multipart } from "../harness.ts";

/**
 * Exercise the Jul3 route families (PROMPT-21..28) over real HTTP so a broken
 * route/auth/envelope fails CI even when the usecase unit passes. Runs against
 * a Pro org (advanced features are entitlement-gated).
 */
export async function jul3Suite(admin: Session, orgId: string, orgSlug: string): Promise<void> {
  // Fresh competition + football division (football has the richest surface:
  // scorers, cards, MOTM, scoresheets).
  const comp = v1data<{ id: string; slug: string }>(
    await v1(admin, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
      name: `Jul3 Cup ${tag}`,
      visibility: "public",
    }),
  );

  // Public-page theming, pro path (public redesign): dashboard.theme lets
  // the brand color through the public view and the competition page inlines
  // the --ps-* accent override for its whole subtree.
  //
  // These four theme checks went RED under V396 and were left red on purpose:
  // badge removal became enterprise-only, and the colour rode the same key, so
  // a paying Pro org lost its palette. V397 gave the colour its own key rather
  // than editing these to match the defect. If they red again, the two keys
  // have been re-welded somewhere — start at server/public-site/data.ts,
  // public_competitions_v and server/slideshow-data.ts.
  await v1(admin, `/api/v1/competitions/${comp.id}`, "PATCH", {
    branding: { colors: { primary: "#0f766e" } },
  });
  const themedHtml = await (await fetch(`${BASE}/shared/${orgSlug}/${comp.slug}`)).text();
  check("pro public page carries the org accent theme", themedHtml.includes("--ps-accent:#0f766e"));
  const div = await v1(admin, `/api/v1/competitions/${comp.id}/divisions`, "POST", {
    name: "Open",
    sport_key: "generic",
    variant_key: "score",
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
  });
  const divId = v1data<{ id: string }>(div).id;

  // Slideshow theming, pro path: dashboard.theme tints the noticeboard
  // with the brand color via the same --ps-* resolver (orgBoardChrome).
  const proBoard = await fetch(`${BASE}/slideshow/divisions/${divId}`, {
    headers: { cookie: cookieHeader(admin) },
  });
  const proBoardHtml = await proBoard.text();
  check("pro slideshow renders", proBoard.status === 200);
  check("pro slideshow carries the org accent theme", proBoardHtml.includes("--ps-accent:#0f766e"));

  // Org default vs competition override (theme chain): an org-level color
  // themes the org landing; a competition with its own color still wins.
  await call(admin, `/api/orgs/${orgId}`, "PATCH", {
    branding: { colors: { primary: "#1d4ed8" } },
  });
  const orgLandingHtml = await (await fetch(`${BASE}/shared/${orgSlug}`)).text();
  check("pro org landing carries the org color", orgLandingHtml.includes("--ps-accent:#1d4ed8"));
  const overrideHtml = await (await fetch(`${BASE}/shared/${orgSlug}/${comp.slug}`)).text();
  check("competition color overrides the org color", overrideHtml.includes("--ps-accent:#0f766e"));

  // -- PROMPT-21: clubs + bulk import ------------------------------------
  const club = await v1(admin, "/api/v1/clubs", "POST", {
    name: `Acme ${tag}`,
    short_name: "ACM",
  });
  check("jul3 clubs create (Pro clubs.hierarchy)", club.status === 201);
  const clubs = await v1(admin, "/api/v1/clubs");
  check("jul3 clubs list", clubs.status === 200 && v1data<unknown[]>(clubs).length >= 1);

  const csv = [
    "Team,Player,Division",
    `Acme U12,Ada One,${v1data<{ slug: string }>(div).slug}`,
  ].join("\n");
  const form = new FormData();
  form.append("file", new Blob([csv], { type: "text/csv" }), "import.csv");
  const imp = await v1Multipart(admin, "/api/v1/imports", form);
  check(
    "jul3 import dry-run → plan",
    imp.status === 201 && Array.isArray(v1data<{ plan: { ops: unknown[] } }>(imp).plan.ops),
  );
  const importId = v1data<{ importId: string }>(imp).importId;
  const committed = await v1(admin, `/api/v1/imports/${importId}/commit`, "POST", undefined, {
    "Idempotency-Key": `smoke-${tag}`,
  });
  check(
    "jul3 import commit",
    committed.status === 201 && v1data<{ stats: { teams: number } }>(committed).stats.teams === 1,
  );

  // -- PROMPT-22: officials ---------------------------------------------
  const official = await v1(admin, "/api/v1/officials", "POST", {
    display_name: `Ref ${tag}`,
    role_keys: ["referee"],
  });
  check("jul3 officials create", official.status === 201);
  const officials = await v1(admin, "/api/v1/officials");
  check("jul3 officials list", officials.status === 200);

  // Build a scored-through division to exercise the rest.
  const entrants = v1data<{ id: string }[]>(
    await v1(
      admin,
      `/api/v1/divisions/${divId}/entrants`,
      "POST",
      ["A", "B", "C", "D"].map((n, i) => ({
        kind: "individual",
        display_name: n,
        seed: i + 1,
      })),
    ),
  );
  const stageId = v1data<{ id: string }>(
    await v1(admin, `/api/v1/divisions/${divId}/stages`, "POST", {
      seq: 1,
      kind: "league",
      name: "League",
    }),
  ).id;
  const fixtures = v1data<{ fixtures: { id: string }[] }>(
    await v1(admin, `/api/v1/stages/${stageId}/generate`, "POST"),
  ).fixtures;
  await v1(admin, `/api/v1/divisions/${divId}/start`, "POST");

  const officialId = v1data<{ id: string }[]>(officials)[0].id;
  // V290 moved officials.auto up to Pro Plus; V393 (entitlements v18 W2 T1)
  // brought it BACK to Pro when Pro Plus was deleted, and gave it to both pass
  // rungs as well. This suite runs on a plain Pro org, so the auto-propose path
  // succeeds here again. Rewritten rather than deleted: a 402 assertion on a
  // key the plan now grants is a paywall claim for a paywall that is gone, and
  // deleting it would leave the Pro path with no coverage at all.
  const auto = await v1(admin, `/api/v1/divisions/${divId}/officials/auto`, "POST", {
    policy: { roles: ["referee"] },
  });
  check(
    "jul3 officials auto is allowed on Pro (V393 brought it back off Pro Plus)",
    auto.status === 200,
  );
  const patchOff = await v1(admin, `/api/v1/fixtures/${fixtures[0].id}/officials`, "PATCH", {
    set: [{ official_id: officialId, role_key: "referee", locked: false }],
  });
  check("jul3 officials manual assign", patchOff.status === 200);

  // -- PROMPT-24: bulk shift + wait report ------------------------------
  const jul3Venue = v1data<{ id: string }>(
    await v1(admin, `/api/v1/orgs/${orgId}/venues`, "POST", { name: `Jul3 Venue ${tag}` }),
  );
  const jul3Court = v1data<{ id: string }>(
    await v1(admin, `/api/v1/orgs/${orgId}/venues/${jul3Venue.id}/courts`, "POST", { name: "C1" }),
  );
  await v1(admin, `/api/v1/fixtures/${fixtures[0].id}`, "PATCH", {
    scheduled_at: "2026-07-20T09:00:00.000Z",
    court_id: jul3Court.id,
  });
  const shift = await v1(admin, "/api/v1/schedule/shift", "POST", {
    division_id: divId,
    scope: { excludeLocked: true },
    delta_minutes: 15,
  });
  check("jul3 bulk shift", shift.status === 200 && v1data<{ shifted: number }>(shift).shifted >= 1);
  const report = await v1(admin, `/api/v1/divisions/${divId}/schedule/report`);
  check(
    "jul3 wait report",
    report.status === 200 && Array.isArray(v1data<{ perEntrant: unknown[] }>(report).perEntrant),
  );

  // -- PROMPT-23: undo/redo/history/checkpoints -------------------------
  const undo = await v1(admin, `/api/v1/divisions/${divId}/undo`, "POST", {});
  check(
    "jul3 undo appends inverse",
    undo.status === 200 && typeof v1data<{ watermark: number }>(undo).watermark === "number",
  );
  const redo = await v1(admin, `/api/v1/divisions/${divId}/redo`, "POST", {});
  check("jul3 redo", redo.status === 200);
  const cp = await v1(admin, `/api/v1/divisions/${divId}/checkpoints`, "POST", {
    label: `smoke ${tag}`,
  });
  check("jul3 checkpoint saved", cp.status === 201);
  const history = await v1(admin, `/api/v1/divisions/${divId}/history`);
  check(
    "jul3 history slice",
    history.status === 200 && Array.isArray(v1data<{ events: unknown[] }>(history).events),
  );

  // Decide every fixture for stats/standings/export.
  for (const f of fixtures) {
    const state = await v1(admin, `/api/v1/fixtures/${f.id}/state`);
    const seq = v1data<{ last_seq: number }>(state).last_seq;
    await v1(admin, `/api/v1/fixtures/${f.id}/events`, "POST", {
      expected_seq: seq,
      type: "generic.result",
      payload: { p1Score: 2, p2Score: 0 },
    });
  }

  // -- PROMPT-25: manual rank override ----------------------------------
  const override = await v1(admin, `/api/v1/stages/${stageId}/standings/override`, "POST", {
    rows: [
      { entrant_id: entrants[2].id, rank: 3, reason: "placement game" },
      { entrant_id: entrants[3].id, rank: 4, reason: "placement game" },
    ],
  });
  check("jul3 rank override (Pro tiebreakers.custom)", override.status === 200);

  // -- PROMPT-26: exports (PDF + XLSX bytes) ----------------------------
  const pdf = await fetch(`${BASE}/api/v1/divisions/${divId}/exports/timetable?format=pdf`, {
    headers: { cookie: cookieHeader(admin) },
  });
  const pdfBytes = Buffer.from(await pdf.arrayBuffer());
  check(
    "jul3 timetable PDF bytes",
    pdf.status === 200 && pdfBytes.subarray(0, 5).toString() === "%PDF-",
  );
  const xlsx = await fetch(`${BASE}/api/v1/divisions/${divId}/exports/participants?format=xlsx`, {
    headers: { cookie: cookieHeader(admin) },
  });
  check(
    "jul3 participants XLSX bytes",
    xlsx.status === 200 && (await xlsx.arrayBuffer()).byteLength > 500,
  );

  // -- PROMPT-27: player stats ------------------------------------------
  // Was "(Pro stats.player)" — the label predates W3-A (2026-09-06, V399),
  // which froze stats.player free on every plan; the org here is still Pro
  // (it grants it too, just no longer exclusively) so the assertion itself
  // is untouched.
  const stats = await v1(admin, `/api/v1/divisions/${divId}/stats/players`);
  check(
    "jul3 player stats leaderboard",
    stats.status === 200 && Array.isArray(v1data<{ rows: unknown[] }>(stats).rows),
  );

  // -- PROMPT-28: format extensions (triple RR + ladder challenge) ------
  const tripleComp = v1data<{ id: string }>(
    await v1(admin, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
      name: `Triple ${tag}`,
      visibility: "private",
    }),
  );
  const tripleDiv = v1data<{ id: string }>(
    await v1(admin, `/api/v1/competitions/${tripleComp.id}/divisions`, "POST", {
      name: "T",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    }),
  ).id;
  await v1(
    admin,
    `/api/v1/divisions/${tripleDiv}/entrants`,
    "POST",
    ["A", "B", "C", "D"].map((n, i) => ({
      kind: "individual",
      display_name: n,
      seed: i + 1,
    })),
  );
  const tripleStage = v1data<{ id: string }>(
    await v1(admin, `/api/v1/divisions/${tripleDiv}/stages`, "POST", {
      seq: 1,
      kind: "league",
      name: "Triple",
      config: { legs: 3 },
    }),
  ).id;
  const tripleGen = await v1(admin, `/api/v1/stages/${tripleStage}/generate`, "POST");
  check("jul3 triple RR = 18 fixtures", v1data<{ created: number }>(tripleGen).created === 18);

  // Ladder challenge (formats.advanced): a stage + an in-range challenge.
  const ladderStage = await v1(admin, `/api/v1/divisions/${tripleDiv}/stages`, "POST", {
    seq: 2,
    kind: "ladder",
    name: "Ladder",
    config: { challengeRange: 2 },
  });
  check("jul3 ladder stage (Pro formats.advanced)", ladderStage.status === 201);
}
