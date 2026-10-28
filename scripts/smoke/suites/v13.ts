import postgres from "postgres";
// W2a bracketFinishSuite: the settle method's outcome name and the chess tie-break rungs, read from the engine's own
// declarations rather than typed. Both entry points load under plain `node --experimental-strip-types` (probed).
// W2b walkoverCreditSuite: the closed award reasons (`AWARD_REASONS`) and two sports' declared cfgs — the games a
// badminton walkover credits and each game's target, hockey's `awardScore` — read the same way (probed too).
import { type EngineErrorCode } from "@seazn/engine/core";
// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import { BASE, type Session, newSession, cookieHeader, check, tag, html, v1, v1data, setPlan } from "../harness.ts";

// --- v13 real-competition fidelity (PROMPT-59/60/61/62/63/64/66) -----------
// Pro path on the given org; the free path flips the SAME org to community
// for the audit 402 (cheapest honest gate check) and flips back.
export async function v13Suite(admin: Session, proOrgId: string, proOrgSlug: string): Promise<void> {
  const comp = v1data<{ id: string; slug: string }>(
    await v1(admin, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
      name: `V13 Cup ${tag}`,
      visibility: "public",
    }),
  );

  // --- PROMPT-60: badge on create (echoed) + inline new-person members.
  const div = v1data<{ id: string; slug: string }>(
    await v1(admin, `/api/v1/competitions/${comp.id}/divisions`, "POST", {
      name: "Open",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    }),
  );
  const badged = await v1(admin, `/api/v1/divisions/${div.id}/entrants`, "POST", {
    kind: "team",
    display_name: `Mexico ${tag}`,
    badge_url: "https://flags.example/mex.png",
    members: [
      { new_person: { full_name: `Striker ${tag}` }, squad_number: 9 },
      { new_person: { full_name: `Keeper ${tag}` }, squad_number: 1 },
    ],
  });
  check("v13 entrant carries badge_url + inline members (201)", badged.status === 201);
  const badgedRow = v1data<
    { badge_url: string | null; id: string }[] | { badge_url: string | null; id: string }
  >(badged);
  const badgedOne = Array.isArray(badgedRow) ? badgedRow[0] : badgedRow;
  check(
    "v13 badge_url echoed on the created entrant",
    badgedOne.badge_url === "https://flags.example/mex.png",
  );
  // --- PROMPT-66: league stage takes an ad-hoc match; it scores + counts.
  const others: string[] = [];
  for (const name of ["B", "C", "D"]) {
    const row = await v1(admin, `/api/v1/divisions/${div.id}/entrants`, "POST", {
      kind: "team",
      display_name: `${name} ${tag}`,
    });
    const data = v1data<{ id: string }[] | { id: string }>(row);
    others.push(Array.isArray(data) ? data[0].id : data.id);
  }
  const league = await v1(admin, `/api/v1/divisions/${div.id}/stages`, "POST", {
    seq: 1,
    kind: "league",
    name: "League",
  });
  const leagueId = v1data<{ id: string }>(league).id;
  await v1(admin, `/api/v1/stages/${leagueId}/generate`, "POST");
  await v1(admin, `/api/v1/divisions/${div.id}/start`, "POST");
  const adhoc = await v1(admin, `/api/v1/stages/${leagueId}/fixtures`, "POST", {
    home_entrant_id: badgedOne.id,
    away_entrant_id: others[0],
  });
  check("v13 addFixture on a league stage (201)", adhoc.status === 201);
  const adhocId = v1data<{ fixture_id: string }>(adhoc).fixture_id;
  await v1(admin, `/api/v1/fixtures/${adhocId}/events`, "POST", {
    expected_seq: 0,
    type: "core.start",
    payload: {},
  });
  const adhocScore = await v1(admin, `/api/v1/fixtures/${adhocId}/events`, "POST", {
    expected_seq: 1,
    type: "generic.result",
    payload: { p1Score: 2, p2Score: 0 },
  });
  check("v13 ad-hoc match scores like any other", adhocScore.status === 201);

  // --- PROMPT-61: a knockout can't finalize level; PROMPT-62: bracket PDF.
  const kdiv = v1data<{ id: string; slug: string }>(
    await v1(admin, `/api/v1/competitions/${comp.id}/divisions`, "POST", {
      name: "Knockout",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    }),
  );
  for (const name of ["KA", "KB", "KC", "KD"]) {
    await v1(admin, `/api/v1/divisions/${kdiv.id}/entrants`, "POST", {
      kind: "team",
      display_name: `${name} ${tag}`,
    });
  }
  const ko = await v1(admin, `/api/v1/divisions/${kdiv.id}/stages`, "POST", {
    seq: 1,
    kind: "knockout",
    name: "KO",
  });
  const koId = v1data<{ id: string }>(ko).id;
  const kgen = await v1(admin, `/api/v1/stages/${koId}/generate`, "POST");
  const kf = v1data<{ fixtures: { id: string }[] }>(kgen).fixtures[0];
  await v1(admin, `/api/v1/divisions/${kdiv.id}/start`, "POST");
  await v1(admin, `/api/v1/fixtures/${kf.id}/events`, "POST", {
    expected_seq: 0,
    type: "core.start",
    payload: {},
  });
  const level = await v1(admin, `/api/v1/fixtures/${kf.id}/events`, "POST", {
    expected_seq: 1,
    type: "generic.result",
    payload: { p1Score: 1, p2Score: 1 },
  });
  // W2a GN-KO-1: generic is the one sport whose level result a bracket REFUSES (every other sport's is held
  // needs_decision) — 409 LEVEL_RESULT_IN_BRACKET since W2a; it was 422 DRAW_NOT_ALLOWED before.
  const levelCode: EngineErrorCode = "LEVEL_RESULT_IN_BRACKET";
  check(
    `v13 knockout refuses a level result (409 ${levelCode}; got ${level.status} ${level.json.error?.code})`,
    level.status === 409 && level.json.error?.code === levelCode,
  );
  const decided = await v1(admin, `/api/v1/fixtures/${kf.id}/events`, "POST", {
    expected_seq: 1,
    type: "generic.result",
    payload: { p1Score: 2, p2Score: 1 },
  });
  check("v13 decisive knockout result lands", decided.status === 201);

  const poster = await fetch(`${BASE}/api/v1/divisions/${kdiv.id}/exports/bracket?format=pdf`, {
    headers: { cookie: cookieHeader(admin) },
  });
  const posterBytes = Buffer.from(await poster.arrayBuffer());
  check(
    "v13 bracket poster exports a PDF",
    poster.status === 200 && posterBytes.subarray(0, 5).toString() === "%PDF-",
  );

  // --- PROMPT-63: audit trail — Pro 200 (verified + signature field), free 402.
  const audit = await v1(admin, `/api/v1/fixtures/${kf.id}/audit`, "GET");
  check("v13 audit trail downloads on Pro", audit.status === 200);
  const auditData = v1data<{ verified: boolean; head_hash: string | null; signature: unknown }>(audit);
  check("v13 audit chain verifies with a head hash", auditData.verified === true && auditData.head_hash !== null);
  check("v13 audit carries the signature field (null without a key, never absent)", "signature" in auditData);
  await setPlan(proOrgId, "community", admin);
  const gated = await v1(admin, `/api/v1/fixtures/${kf.id}/audit`, "GET");
  check("v13 audit is Pro-gated (402 on community)", gated.status === 402);
  await setPlan(proOrgId, "pro", admin);

  const keys = await fetch(`${BASE}/.well-known/seazn-audit-keys`);
  check("v13 audit verify keys are public", keys.status === 200);

  // --- PROMPT-64: no-login presentation mode renders for the public comp.
  const present = await html(newSession(), `/shared/${proOrgSlug}/${comp.slug}/present`);
  check(
    "v13 presentation mode renders without login",
    present.status === 200 && present.body.includes(`V13 Cup ${tag}`),
  );

  // --- entrant shapes (spec 2026-07-18): the sport presets the entrant shape,
  // Settings → Entrants overrides it per division, and the in-use guard blocks
  // narrowing kinds while a live entrant of that kind still exists.
  const esDbUrl = process.env.DATABASE_URL;
  if (esDbUrl) {
    // Local-run fallback (CI runs sync:sports): seed the board-game catalog so
    // the division create below resolves its sport + variant.
    const esDb = postgres(esDbUrl, {
      connection: { search_path: process.env.DB_SCHEMA ?? "seazn_club" },
      ssl:
        process.env.DATABASE_SSL === "disable"
          ? false
          : /@(localhost|127\.0\.0\.1)[:/]/.test(esDbUrl)
            ? false
            : "require",
      prepare: !esDbUrl.includes(":6543"),
      max: 1,
    });
    await esDb`insert into sports (key, name, module_version, position_catalog)
               values ('boardgame', 'Board game', '1.0.0', ${esDb.json({ groups: [], lineup: { size: 1, benchMax: 0 } })})
               on conflict (key) do nothing`;
    await esDb`insert into sport_variants (sport_key, key, name, config, is_system)
               values ('boardgame', 'classical', 'Classical', ${esDb.json({})}, true)
               on conflict do nothing`;
    await esDb.end();
  }

  // Board game presets individual-only (entrantModel kinds: ['individual']).
  const bgConfig = { colors: true };
  const bgDiv = v1data<{ id: string }>(
    await v1(admin, `/api/v1/competitions/${comp.id}/divisions`, "POST", {
      name: "Chess",
      sport_key: "boardgame",
      variant_key: "classical",
      config: bgConfig,
    }),
  );
  // A 2-person roster overflows the structural individual cap of 1.
  const esTooBig = await v1(admin, `/api/v1/divisions/${bgDiv.id}/entrants`, "POST", {
    kind: "individual",
    display_name: `Overflow ${tag}`,
    members: [
      { new_person: { full_name: `P1 ${tag}` } },
      { new_person: { full_name: `P2 ${tag}` } },
    ],
  });
  check(
    "entrant-shapes: 2-person individual rejected (422 ENTRANT_ROSTER_TOO_BIG)",
    esTooBig.status === 422 && esTooBig.json.error?.code === "ENTRANT_ROSTER_TOO_BIG",
  );
  // A single-person individual is exactly one seat — accepted, name echoed.
  const esSolo = await v1(admin, `/api/v1/divisions/${bgDiv.id}/entrants`, "POST", {
    kind: "individual",
    display_name: `Magnus ${tag}`,
    members: [{ new_person: { full_name: `Magnus ${tag}` } }],
  });
  check("entrant-shapes: single-person individual accepted (201)", esSolo.status === 201);
  const esSoloRow = v1data<{ display_name: string }[] | { display_name: string }>(esSolo);
  const esSoloOne = Array.isArray(esSoloRow) ? esSoloRow[0] : esSoloRow;
  check(
    "entrant-shapes: display_name echoed on the created individual",
    esSoloOne.display_name === `Magnus ${tag}`,
  );

  // Chess takes individual players only (owner ruling 2026-10-26): a team is refused with the one named code however
  // the kind is reached - as an entrant, as a division config override, as the registration entry type.
  const esTeamBlocked = await v1(admin, `/api/v1/divisions/${bgDiv.id}/entrants`, "POST", {
    kind: "team",
    display_name: `Squad ${tag}`,
  });
  check(
    "entrant-shapes: chess team entrant refused (422 CHESS_INDIVIDUAL_ONLY)",
    esTeamBlocked.status === 422 && esTeamBlocked.json.error?.code === "CHESS_INDIVIDUAL_ONLY",
  );
  // Settings -> Entrants override: widening a chess division to teams is refused too. The config is written
  // wholesale, so re-send the full config with the entrants block.
  const esWiden = await v1(admin, `/api/v1/divisions/${bgDiv.id}`, "PATCH", {
    config: {
      ...bgConfig,
      entrants: { kinds: ["individual", "team"], defaultKind: "individual" },
    },
  });
  check(
    "entrant-shapes: chess widening via config PATCH refused (422 CHESS_INDIVIDUAL_ONLY)",
    esWiden.status === 422 && esWiden.json.error?.code === "CHESS_INDIVIDUAL_ONLY",
  );
  const esRegTeam = await v1(admin, `/api/v1/divisions/${bgDiv.id}/registration-settings`, "PUT", {
    enabled: true,
    entrant_kind: "team",
  });
  check(
    "entrant-shapes: chess team registration refused (422 CHESS_INDIVIDUAL_ONLY)",
    esRegTeam.status === 422 && esRegTeam.json.error?.code === "CHESS_INDIVIDUAL_ONLY",
  );
  const esRegSolo = await v1(admin, `/api/v1/divisions/${bgDiv.id}/registration-settings`, "PUT", {
    enabled: true,
    entrant_kind: "individual",
  });
  check("entrant-shapes: chess individual registration accepted (200)", esRegSolo.status === 200);

  // Every other sport keeps the override: widen the kinds, enter a team, then the in-use guard blocks narrowing
  // while that team is live. `generic` declares no entrant model, so it takes every kind.
  const gConfig = { resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 }, progressScore: false };
  const gDiv = v1data<{ id: string }>(
    await v1(admin, `/api/v1/competitions/${comp.id}/divisions`, "POST", {
      name: "Shapes",
      sport_key: "generic",
      variant_key: "score",
      config: gConfig,
    }),
  );
  const gWiden = await v1(admin, `/api/v1/divisions/${gDiv.id}`, "PATCH", {
    config: { ...gConfig, entrants: { kinds: ["individual", "team"], defaultKind: "individual" } },
  });
  check("entrant-shapes: widening kinds via config PATCH on a team sport (200)", gWiden.status === 200);
  const gTeam = await v1(admin, `/api/v1/divisions/${gDiv.id}/entrants`, "POST", {
    kind: "team",
    display_name: `Squad ${tag}`,
  });
  check("entrant-shapes: team accepted on a team sport (201)", gTeam.status === 201);

  // Guard: narrowing kinds back to individual-only while that team entrant is
  // live is refused - organisers must withdraw it first.
  const gNarrow = await v1(admin, `/api/v1/divisions/${gDiv.id}`, "PATCH", {
    config: { ...gConfig, entrants: { kinds: ["individual"], defaultKind: "individual" } },
  });
  check(
    "entrant-shapes: narrowing under a live team refused (422 ENTRANT_KIND_IN_USE)",
    gNarrow.status === 422 && gNarrow.json.error?.code === "ENTRANT_KIND_IN_USE",
  );
}
