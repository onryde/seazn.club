import postgres from "postgres";
// Engine-split 1f (D31): the fold epoch a native client sends on a score write, read off the engine rather than typed. Loads under
// plain `node --experimental-strip-types` (probed).
import { foldEpochOf } from "@seazn/engine/sport";
// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import {
  BASE, type Session, newSession, cookieHeader, raw, check, tag, insertEntitlementOverride, html, v1, v1data,
} from "../harness.ts";

/**
 * Exercise the whole /api/v1 lifecycle over real HTTP (PROMPT-11 §7):
 * auth'd CRUD, generate, scoring append + concurrency + void, public reads,
 * API-key auth and the 402 entitlement gate.
 */
export async function v1Suite(admin: Session, orgId: string, orgSlug: string): Promise<void> {
  // The division needs the sport catalog; seed the generic sport directly when
  // we have DB access (CI runs sync:sports, so this is a local-run fallback).
  const dbUrl = process.env.DATABASE_URL;
  const db = dbUrl
    ? postgres(dbUrl, {
        connection: { search_path: process.env.DB_SCHEMA ?? "seazn_club" },
        ssl:
          process.env.DATABASE_SSL === "disable"
            ? false
            : /@(localhost|127\.0\.0\.1)[:/]/.test(dbUrl)
              ? false
              : "require",
        prepare: !dbUrl.includes(":6543"),
        max: 1,
      })
    : null;
  const genericConfig = {
    resultMode: "score",
    allowDraws: true,
    points: { w: 3, d: 1, l: 0 },
    progressScore: false,
  };
  if (db) {
    await db`insert into sports (key, name, module_version, position_catalog)
             values ('generic', 'Generic', '1.0.0', ${db.json({ groups: [], lineup: { size: 1, benchMax: 0 } })})
             on conflict (key) do nothing`;
    await db`insert into sport_variants (sport_key, key, name, config, is_system)
             values ('generic', 'score', 'Score', ${db.json(genericConfig)}, true)
             on conflict do nothing`;
  }

  // CRUD happy path: competition → division → entrants (bulk) → stage → generate.
  const comp = await v1(admin, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
    name: `V1 Cup ${tag}`,
    visibility: "public",
  });
  check(
    "v1 create competition → 201 + envelope",
    comp.status === 201 && comp.json.ok === true && !!comp.json.requestId,
  );
  const compId = v1data<{ id: string; slug: string }>(comp).id;
  const compSlug = v1data<{ id: string; slug: string }>(comp).slug;

  const list = await v1(admin, "/api/v1/competitions?limit=1");
  check(
    "v1 list paginates",
    list.status === 200 && Array.isArray(v1data<{ items: unknown[] }>(list).items),
  );

  const div = await v1(admin, `/api/v1/competitions/${compId}/divisions`, "POST", {
    name: "Open",
    sport_key: "generic",
    variant_key: "score",
    // The 'score' preset is partial; the module schema requires the rest.
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
  });
  check(
    "v1 create division pins module version",
    div.status === 201 && !!v1data<{ module_version: string }>(div).module_version,
  );
  const divId = v1data<{ id: string; slug: string }>(div).id;
  const divSlug = v1data<{ id: string; slug: string }>(div).slug;

  const entrants = await v1(
    admin,
    `/api/v1/divisions/${divId}/entrants`,
    "POST",
    ["A", "B", "C", "D"].map((n, i) => ({
      kind: "individual",
      display_name: n,
      seed: i + 1,
    })),
  );
  check(
    "v1 bulk entrants registered",
    entrants.status === 201 && v1data<unknown[]>(entrants).length === 4,
  );

  const stage = await v1(admin, `/api/v1/divisions/${divId}/stages`, "POST", {
    seq: 1,
    kind: "league",
    name: "League",
  });
  const stageId = v1data<{ id: string }>(stage).id;

  const gen1 = await v1(admin, `/api/v1/stages/${stageId}/generate`, "POST");
  const gen2 = await v1(admin, `/api/v1/stages/${stageId}/generate`, "POST");
  check("v1 generate creates 6 RR fixtures", v1data<{ created: number }>(gen1).created === 6);
  check(
    "v1 generate is idempotent",
    v1data<{ created: number; existing: number }>(gen2).created === 0,
  );
  const fixtures = v1data<{ fixtures: { id: string }[] }>(gen1).fixtures;

  // --- PROMPT-30: slug console routes ---
  // The "legacy /divisions/[id] 301s to the slug chain" check went with the
  // route it tested (deleted 2026-08-06). It is deliberately NOT replaced by a
  // 404 probe: that would pin a URL we have decided not to serve.
  const consolePage = await html(admin, `/o/${orgSlug}/c/${compSlug}/d/${divSlug}`);
  check("console division page serves on slug URL", consolePage.status === 200);
  const fixturePage = await html(admin, `/o/${orgSlug}/c/${compSlug}/d/${divSlug}/f/1`);
  check("fixture ordinal page serves (/f/1)", fixturePage.status === 200);

  // Phone composition (spec 2026-09-02-scorepad-v3-phone-composition §6.3):
  // anchored on `="` — React serialises an omitted prop as "$undefined", so a
  // bare data-role probe would pass in both states.
  check(
    "fixture console: phone match-details toggle is in the markup",
    fixturePage.status === 200 && fixturePage.body.includes('data-role="match-details-toggle"'),
  );
  // Review fix (final wave, MINOR 6): `!desktop || phone` is an implication,
  // not the real invariant — it passes vacuously on any page where hand-over
  // is not offered at all (desktop absent makes it true regardless of
  // phone), and it never catches "phone present, desktop absent" either.
  // One `canHandOver` predicate now drives both copies, so the real
  // invariant is that their presence is EQUAL — both rendered, or neither.
  const deviceHandoverDesktop = fixturePage.body.includes('data-role="device-handover"');
  const deviceHandoverPhone = fixturePage.body.includes('data-role="device-handover-phone"');
  check(
    "fixture console: phone hand-over icon ships beside the desktop button (both present, or both absent)",
    deviceHandoverDesktop === deviceHandoverPhone,
  );
  // Spec 2026-09-30 §2: Stream now has a desktop button and a phone strip icon, driven by ONE mount — equal presence.
  // The smoke admin is an owner on an entitled org (V426: every plan grants streaming.overlay), so both must be HERE:
  // equality alone would pass on a page that dropped both.
  const streamDesktop = fixturePage.body.includes('data-role="fixture-stream"');
  const streamPhone = fixturePage.body.includes('data-role="fixture-stream-phone"');
  check("fixture console: the Stream button and its phone icon both ship on an organiser's fixture page", streamDesktop && streamPhone);

  // Scheduling console (doc 12, PROMPT-17): scoring is closed until the
  // explicit start; auto pass proposes without persisting; start opens scoring.
  const fx = fixtures[0].id;
  const early = await v1(admin, `/api/v1/fixtures/${fx}/events`, "POST", {
    expected_seq: 0,
    type: "core.start",
    payload: {},
  });
  check(
    "v1 scoring before start → 422 WRONG_PHASE",
    early.status === 422 && early.json.error?.code === "WRONG_PHASE",
  );
  // No explicit schedule-settings PUT for this division — relies on the
  // "empty configured list falls back to the org's non-archived courts"
  // default, so two real courts just need to EXIST in the org before the
  // auto call, not be wired into this division's own config.
  const v1Venue = v1data<{ id: string }>(
    await v1(admin, `/api/v1/orgs/${orgId}/venues`, "POST", { name: `v1 Venue ${tag}` }),
  );
  const v1Court1 = v1data<{ id: string }>(
    await v1(admin, `/api/v1/orgs/${orgId}/venues/${v1Venue.id}/courts`, "POST", { name: "Court 1" }),
  );
  const v1Court9 = v1data<{ id: string }>(
    await v1(admin, `/api/v1/orgs/${orgId}/venues/${v1Venue.id}/courts`, "POST", { name: "Court 9" }),
  );
  const auto = await v1(admin, `/api/v1/stages/${stageId}/schedule/auto`, "POST", {});
  check(
    "v1 schedule/auto proposes all fixtures",
    v1data<{ assignments: unknown[] }>(auto).assignments.length === 6,
  );

  // --- #399 W4: blocking is DELTA-based ------------------------------------
  // Persist the proposal, then prove both halves of the rule against the live
  // API: a move that INTRODUCES a person double-booking is refused, and the
  // board it left behind is still editable.
  {
    const assignments = v1data<
      { assignments: { fixture_id: string; scheduled_at: string; court_id: string }[] }
    >(auto).assignments;
    const applyRes = await v1(admin, `/api/v1/stages/${stageId}/schedule/apply`, "POST", {
      assignments: assignments.map((a) => ({
        fixture_id: a.fixture_id,
        scheduled_at: a.scheduled_at,
        court_id: a.court_id,
      })),
      // "auto", not "manual": a manual apply is board editing and needs the Pro
      // `scheduling.board` key, and this section runs on a community org.
      source: "auto",
    });
    check(
      "v1 W4: the clean proposal applies with nothing blocking",
      applyRes.status === 200 &&
        v1data<{ conflicts: { blocking: boolean }[] }>(applyRes).conflicts.every(
          (c) => !c.blocking,
        ),
    );
    // Four entrants, one round robin. Round 1's two fixtures cover all four
    // entrants, so ANY later-round fixture shares an entrant with each of them.
    // The auto pass emits in round order, so [0] and [2] are always such a pair.
    // Same instant, DIFFERENT court — the only defect is the human. Whichever
    // of the two real courts the solver put the anchor on, the OTHER one is
    // what proves this — not a hardcoded id that might collide with it.
    const anchor = assignments[0];
    const sharer = assignments[2];
    const otherCourtId = anchor.court_id === v1Court1.id ? v1Court9.id : v1Court1.id;
    const clash = await v1(admin, `/api/v1/fixtures/${sharer.fixture_id}`, "PATCH", {
      scheduled_at: anchor.scheduled_at,
      court_id: otherCourtId,
    });
    check(
      "v1 W4: a move that introduces a clash → 409 SCHEDULE_CONFLICT",
      clash.status === 409 && clash.json.error?.code === "SCHEDULE_CONFLICT",
    );
    check(
      "v1 W4: the refusal names the rule the AI prompt teaches",
      (clash.json.error?.conflicts ?? []).some((c) => !!c.rule && c.blocking === true),
    );
    // And the board still moves: the refusal was about the change, not the board.
    //
    // P9: this used to move the card to `court_label: "Court 9"` — a free-text
    // label for a court that was not on the board at all, so it could never
    // clash. Courts are entities now and a fixture can only sit on a real one,
    // so the edit has to be made non-clashing HONESTLY: same court, a slot an
    // hour past the last thing the solver placed, which nothing else occupies.
    // An hour past the last slot was the first attempt and it 409s too — it
    // lands outside the competition window. The edit that is clash-free BY
    // CONSTRUCTION is unplacing the card: `PatchFixture.court_id` is nullable
    // (schemas.ts), a tray card occupies no slot, and the point of the check
    // is only that the board still accepts a change after refusing one.
    const legal = await v1(admin, `/api/v1/fixtures/${sharer.fixture_id}`, "PATCH", {
      court_id: null,
    });
    check("v1 W4: an unrelated edit on the same board still applies", legal.status === 200);
  }

  // --- #230 item 2 follow-up: START runs the publish gate -------------------
  // Publish validates the board; start did not, so an organiser refused at
  // Publish could simply press Start and the same broken timetable went live
  // with scoring open on it. Starting now publishes, under the same validation.
  //
  // The blocking board is made by moving the competition's WINDOW off the
  // board rather than by moving a card onto another: a card-level clash is
  // refused at the PATCH by the delta gate, so it can never be created through
  // the API. Every card is then outside the window — `warn.window`, which IS
  // blocking despite the `warn.` prefix (`isBlockingConflict`).
  {
    const windowed = {
      startAt: "2030-01-01T09:00:00.000Z",
      endAt: "2030-01-02T23:00:00.000Z",
      matchMinutes: 30,
      gapMinutes: 0,
      courts: [v1Court1.id, v1Court9.id],
      perEntrantMinRest: 0,
      blackouts: [],
      sessionWindows: [],
    };
    await v1(admin, `/api/v1/divisions/${divId}/schedule-settings`, "PUT", { config: windowed });
    const blockedStart = await v1(admin, `/api/v1/divisions/${divId}/start`, "POST");
    check(
      "v1 start on a blocking board → 422 SCHEDULE_BLOCKING_CONFLICTS",
      blockedStart.status === 422 &&
        blockedStart.json.error?.code === "SCHEDULE_BLOCKING_CONFLICTS",
    );
    // Refused, not half-done: the status assertion is the one a gate that
    // throws AFTER flipping the division would fail.
    check(
      "v1 the refused start left the division in setup",
      v1data<{ status: string }>(await v1(admin, `/api/v1/divisions/${divId}`)).status === "setup",
    );
    // Put the window back so the start below is the one this section always ran.
    await v1(admin, `/api/v1/divisions/${divId}/schedule-settings`, "PUT", {
      config: { ...windowed, startAt: null, endAt: null },
    });
  }

  const startRes = await v1(admin, `/api/v1/divisions/${divId}/start`, "POST");
  check("v1 division start → active", v1data<{ status: string }>(startRes).status === "active");

  // Scoring: append, optimistic-concurrency 409 (parallel scorers), void.
  // Engine-split 1f (D31): this append carries the server's own fold epoch for the fixture's sport (generic here), the way a
  // native client's does; an epoch the schema refuses (0) is a 400 at the door and writes nothing — the race below still
  // finds expected_seq 1 free.
  const badEpoch = await v1(admin, `/api/v1/fixtures/${fx}/events`, "POST", {
    expected_seq: 0,
    type: "core.start",
    payload: {},
    engine_epoch: 0,
  });
  check(
    "v1 scoring: engine_epoch 0 → 400 VALIDATION, nothing written",
    badEpoch.status === 400 && badEpoch.json.error?.code === "VALIDATION",
  );
  const started = await v1(admin, `/api/v1/fixtures/${fx}/events`, "POST", {
    expected_seq: 0,
    type: "core.start",
    payload: {},
    engine_epoch: foldEpochOf("generic"),
  });
  check(
    "v1 scoring append (engine_epoch = the server's fold epoch) → 201 with seq",
    started.status === 201 && v1data<{ seq: number }>(started).seq === 1,
  );

  const race = await Promise.all([
    v1(admin, `/api/v1/fixtures/${fx}/events`, "POST", {
      expected_seq: 1,
      type: "core.note",
      payload: { text: "a" },
    }),
    v1(admin, `/api/v1/fixtures/${fx}/events`, "POST", {
      expected_seq: 1,
      type: "core.note",
      payload: { text: "b" },
    }),
  ]);
  const won = race.filter((r) => r.status === 201);
  const lost = race.filter((r) => r.status === 409);
  check("v1 parallel scorers: one 201, one 409", won.length === 1 && lost.length === 1);
  check("v1 409 carries current_seq", lost[0]?.json.error?.current_seq === 2);
  check("v1 409 code is SEQ_CONFLICT", lost[0]?.json.error?.code === "SEQ_CONFLICT");

  // Losing scorer resyncs from its seq and replays.
  const resync = await v1(admin, `/api/v1/fixtures/${fx}/events?since_seq=1`);
  check(
    "v1 events since_seq resyncs",
    resync.status === 200 && v1data<unknown[]>(resync).length === 1,
  );

  // Undo: void the note through the same path.
  const events = v1data<{ id: string; seq: number }[]>(
    await v1(admin, `/api/v1/fixtures/${fx}/events`),
  );
  const note = events.find((e) => e.seq === 2);
  const voided = await v1(admin, `/api/v1/fixtures/${fx}/events`, "POST", {
    expected_seq: 2,
    type: "core.void",
    payload: { event_id: note?.id },
  });
  check(
    "v1 undo via core.void",
    voided.status === 201 && v1data<{ seq: number }>(voided).seq === 3,
  );

  // Decide every fixture, read authed standings, then the public dashboard.
  for (const f of fixtures) {
    const state = await v1(admin, `/api/v1/fixtures/${f.id}/state`);
    const seq = v1data<{ last_seq: number }>(state).last_seq;
    await v1(admin, `/api/v1/fixtures/${f.id}/events`, "POST", {
      expected_seq: seq,
      type: "generic.result",
      payload: { p1Score: 2, p2Score: 0 },
    });
  }
  const standings = await v1(admin, `/api/v1/stages/${stageId}/standings`);
  check("v1 standings ranked", v1data<{ rows: unknown[] }>(standings).rows.length === 4);

  const anon = newSession();
  const pubStandings = await v1(
    anon,
    `/api/v1/public/orgs/${orgSlug}/competitions/${compSlug}/divisions/${divSlug}/standings`,
  );
  // Flaked once in CI (2026-07-13, 404) with no body in the log — keep the
  // response visible so a recurrence is diagnosable.
  if (pubStandings.status !== 200) {
    console.log(
      "public standings response:",
      pubStandings.status,
      JSON.stringify(pubStandings.json),
    );
  }
  check(
    "v1 public standings (no auth)",
    pubStandings.status === 200 && pubStandings.json.ok === true,
  );
  check(
    "v1 public reads are cacheable",
    (pubStandings.headers.get("cache-control") ?? "").includes("s-maxage"),
  );
  const pubComp = await v1(anon, `/api/v1/public/orgs/${orgSlug}/competitions/${compSlug}`);
  check(
    "v1 public competition lists divisions",
    v1data<{ divisions: unknown[] }>(pubComp).divisions.length === 1,
  );

  // Public-page theming, free path (public redesign): the branding write is
  // accepted, but the public view empties it for orgs without
  // `dashboard.theme` (V397 — the key was `dashboard.branding` until W2 T17
  // split badge removal off it) — the page must NOT carry the --ps-* accent
  // override.
  const branded = await v1(admin, `/api/v1/competitions/${compId}`, "PATCH", {
    branding: { colors: { primary: "#0f766e" } },
  });
  check("v1 branding patch accepted", branded.status === 200);
  const freePage = await fetch(`${BASE}/shared/${orgSlug}/${compSlug}`);
  const freeHtml = await freePage.text();
  check(
    "public competition page renders (community)",
    freePage.status === 200 && freeHtml.includes("V1 Cup"),
  );
  check("community public page keeps default theme", !freeHtml.includes("--ps-accent:#0f766e"));
  // Slideshow shares the courtside theme layer, gated the same way: on
  // Community the board must keep the default violet, not the brand color.
  const freeBoard = await fetch(`${BASE}/slideshow/divisions/${divId}`, {
    headers: { cookie: cookieHeader(admin) },
  });
  const freeBoardHtml = await freeBoard.text();
  check("community slideshow renders", freeBoard.status === 200);
  check("community slideshow keeps default theme", !freeBoardHtml.includes("--ps-accent:#0f766e"));
  // Org-level brand color: the write lands on any plan, but the public org
  // landing ignores it without dashboard.theme.
  const orgBrand = await raw(admin, `/api/orgs/${orgId}`, "PATCH", {
    branding: { colors: { primary: "#0f766e" } },
  });
  check("org branding patch accepted", orgBrand.status === 200);
  const freeOrgHtml = await (await fetch(`${BASE}/shared/${orgSlug}`)).text();
  check("community org landing keeps default theme", !freeOrgHtml.includes("--ps-accent:#0f766e"));

  // Entitlement gate: community org → 402; Pro override → key works via Bearer.
  const denied = await v1(admin, `/api/v1/orgs/${orgId}/api-keys`, "POST", {
    name: "ci",
    scopes: ["read"],
  });
  check(
    "v1 API keys 402-gated on api.access",
    denied.status === 402 && denied.json.error?.code === "PAYMENT_REQUIRED",
  );

  if (db) {
    await insertEntitlementOverride(admin, orgId, "api.access", true);
    const minted = await v1(admin, `/api/v1/orgs/${orgId}/api-keys`, "POST", { name: "ci", scopes: ["read"] });
    const secret = v1data<{ id: string; secret: string }>(minted).secret;
    check("v1 API key minted once (sc_)", minted.status === 201 && secret.startsWith("sc_"));

    const keyed = await v1(newSession(), "/api/v1/competitions", "GET", undefined, {
      Authorization: `Bearer ${secret}`,
    });
    check("v1 Bearer key authenticates reads", keyed.status === 200 && keyed.json.ok === true);
    const keyedWrite = await v1(
      newSession(),
      "/api/v1/competitions",
      "POST",
      { ends_on: "2030-12-31", name: "Nope" },
      {
        Authorization: `Bearer ${secret}`,
      },
    );
    check("v1 read-scoped key cannot write", keyedWrite.status === 403);

    const keyId = v1data<{ id: string }>(minted).id;
    await v1(admin, `/api/v1/orgs/${orgId}/api-keys/${keyId}`, "DELETE");
    const revoked = await v1(newSession(), "/api/v1/competitions", "GET", undefined, {
      Authorization: `Bearer ${secret}`,
    });
    check("v1 revoked key stops authenticating", revoked.status === 401);
    await db.end();
  } else {
    console.log("v1 API-key positive path skipped (DATABASE_URL not set)");
  }

  // Spec is served and matches the implemented surface.
  const spec = (await fetch(BASE + "/api/v1/openapi.json").then((r) => r.json())) as {
    openapi: string;
    paths: Record<string, unknown>;
  };
  check(
    "v1 openapi served",
    spec.openapi === "3.1.0" && !!spec.paths["/api/v1/fixtures/{id}/events"],
  );
}
