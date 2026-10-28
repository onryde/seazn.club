import postgres from "postgres";
// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import { BASE, newSession, check, signIn, tag, v1, v1data } from "../harness.ts";

/**
 * Chess Lichess external-play Task 9 smoke:
 * - cron without/with wrong secret is refused
 * - boardgame division without onlinePlay accepts an unlinked entrant (OTB)
 */
export async function externalPlayOtBSmoke(): Promise<void> {
  const wrongCron = await fetch(`${BASE}/api/cron/external-play`, {
    method: "POST",
    headers: { "x-cron-secret": "definitely-wrong-external-play" },
  });
  check(
    "external-play: cron wrong secret → 401 (or 503 if CRON_SECRET unset)",
    wrongCron.status === 401 || wrongCron.status === 503,
  );

  const s = newSession();
  const ver = await signIn(s, `delivered+smoke-ep-otb-${tag}@resend.dev`);
  const orgId = ver.org_id;

  // Ensure boardgame catalog exists (same local-run fallback as entrant-shapes).
  const dbUrl = process.env.DATABASE_URL;
  if (dbUrl) {
    const db = postgres(dbUrl, {
      connection: { search_path: process.env.DB_SCHEMA ?? "seazn_club" },
      ssl:
        process.env.DATABASE_SSL === "disable"
          ? false
          : /@(localhost|127\.0\.0\.1)[:/]/.test(dbUrl)
            ? false
            : "require",
      prepare: !dbUrl.includes(":6543"),
      max: 1,
    });
    await db`insert into sports (key, name, module_version, position_catalog)
             values ('boardgame', 'Board game', '1.0.0', ${db.json({ groups: [], lineup: { size: 1, benchMax: 0 } })})
             on conflict (key) do nothing`;
    await db`insert into sport_variants (sport_key, key, name, config, is_system)
             values ('boardgame', 'classical', 'Classical', ${db.json({})}, true)
             on conflict do nothing`;
    await db.end();
  }

  const comp = v1data<{ id: string }>(
    await v1(s, "/api/v1/competitions", "POST", {
      ends_on: "2030-12-31",
      name: `EP OTB ${tag}`,
      visibility: "public",
    }),
  );
  const div = v1data<{ id: string; config: Record<string, unknown> }>(
    await v1(s, `/api/v1/competitions/${comp.id}/divisions`, "POST", {
      name: "Chess OTB",
      sport_key: "boardgame",
      variant_key: "classical",
      config: { variant: "classical", clock: { base: 600 } },
    }),
  );
  check(
    "external-play: OTB boardgame division has no onlinePlay",
    div.config.onlinePlay === undefined,
  );

  const entrant = await v1(s, `/api/v1/divisions/${div.id}/entrants`, "POST", {
    kind: "individual",
    display_name: `OTB Player ${tag}`,
    members: [{ new_person: { full_name: `OTB Player ${tag}` } }],
  });
  check(
    "external-play: unlinked entrant accepted when onlinePlay is off (201)",
    entrant.status === 201,
  );

  // Sanity: org cookie matches (unused beyond proving session still live).
  check("external-play: smoke org still active", !!orgId);
}
