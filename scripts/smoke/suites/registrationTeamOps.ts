// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import { newSession, call, check, signIn, tag, smokeDb, v1, v1data } from "../harness.ts";

/**
 * RS010 — join-via-join_code and assign-solo-to-team, over real HTTP.
 * Football, not `generic` (every other registration suite in this file uses
 * `generic`'s {size:1, benchMax:0} lineup on purpose — it would already read
 * a captain-only team as "full" and refuse both a join and an assign before
 * either gets to run; confirmed by reading both position catalogs directly,
 * packages/engine/src/sports/{generic,football}/*.ts, and matches
 * assign-routes.test.ts's own reason for the same choice). Local-run
 * fallback seed only — CI's sync:sports already carries the real module.
 * Own fresh org; keyless-safe (fee_cents 0 throughout).
 */
export async function registrationTeamOpsSuite(): Promise<void> {
  const owner = newSession();
  const who = await signIn(owner, `delivered+regteam_${tag}@resend.dev`);
  const orgId = who.org_id;
  const orgs = (await call(owner, "/api/orgs")) as { id: string; slug: string }[];
  const orgSlug = orgs.find((o) => o.id === orgId)!.slug;

  const dbUrl = process.env.DATABASE_URL;
  if (dbUrl) {
    const db = smokeDb();
    try {
      await db`insert into sports (key, name, module_version, position_catalog)
               values ('football', 'Football', '1.0.0', ${db.json({ groups: [], lineup: { size: 11, benchMax: 12 } })})
               on conflict (key) do nothing`;
      await db`insert into sport_variants (sport_key, key, name, config, is_system)
               values ('football', 'default', 'Default', ${db.json({})}, true)
               on conflict do nothing`;
    } finally {
      await db.end();
    }
  }

  const comp = v1data<{ id: string; slug: string }>(
    await v1(owner, "/api/v1/competitions", "POST", {
      ends_on: "2030-12-31",
      name: `Team Ops Cup ${tag}`,
      visibility: "public",
    }),
  );
  const div = v1data<{ id: string }>(
    await v1(owner, `/api/v1/competitions/${comp.id}/divisions`, "POST", {
      name: "Team Ops",
      sport_key: "football",
      variant_key: "default",
      config: {},
    }),
  );
  const settingsRes = await v1(owner, `/api/v1/divisions/${div.id}/registration-settings`, "PUT", {
    enabled: true,
    entrant_kind: "team",
    fee_cents: 0,
    approval: "auto",
    allow_free_agents: true,
    form_fields: [],
  });
  check("team ops: team division with free agents allowed accepts registration settings", settingsRes.status === 200);

  type SubmitOut = {
    entries: { registration_id: string; status: string; join_code: string | null }[];
  };
  const submitTeam = async (label: string) =>
    v1data<SubmitOut>(
      await v1(newSession(), `/api/v1/public/orgs/${orgSlug}/competitions/${comp.slug}/register`, "POST", {
        contact: { name: `${label} Captain ${tag}`, email: `delivered+${label.toLowerCase()}cap_${tag}@resend.dev` },
        privacy_consent: true,
        entries: [
          {
            division_id: div.id,
            entrant_kind: "team",
            team_name: `${label} ${tag}`,
            players: [{ full_name: `${label} Captain ${tag}` }],
            answers: {},
          },
        ],
      }),
    );

  const teamA = await submitTeam("Alpha");
  const teamB = await submitTeam("Bravo");
  check(
    "team ops: a team entry confirms immediately (auto/free) and mints a join_code",
    teamA.entries[0]?.status === "confirmed" && !!teamA.entries[0]?.join_code,
  );
  const teamAId = teamA.entries[0].registration_id;
  const teamBId = teamB.entries[0].registration_id;
  const joinCode = teamA.entries[0].join_code!;

  const soloOut = v1data<SubmitOut>(
    await v1(newSession(), `/api/v1/public/orgs/${orgSlug}/competitions/${comp.slug}/register`, "POST", {
      contact: { name: `Solo Player ${tag}`, email: `delivered+soloplayer_${tag}@resend.dev` },
      privacy_consent: true,
      entries: [
        {
          division_id: div.id,
          entrant_kind: "team",
          free_agent: true,
          players: [{ full_name: `Solo Player ${tag}` }],
          answers: {},
        },
      ],
    }),
  );
  check(
    "team ops: a free-agent solo sign-up on an auto/free division confirms too — never held on a team slot",
    soloOut.entries[0]?.status === "confirmed",
  );
  const soloId = soloOut.entries[0].registration_id;

  // --- JOIN: a second player self-joins team A via its join_code ---
  type JoinOut = { registration_id: string; player_id: string; consent_status: string };
  const joined = await v1(
    newSession(),
    `/api/v1/public/orgs/${orgSlug}/competitions/${comp.slug}/register/join`,
    "POST",
    { join_code: joinCode, player: { full_name: `Joiner ${tag}` }, privacy_consent: true },
  );
  const joinedData = v1data<JoinOut>(joined);
  check(
    "team ops: joining via join_code succeeds and grants consent directly (this player typed it themselves)",
    joined.status === 201 && joinedData.registration_id === teamAId && joinedData.consent_status === "granted",
  );

  const confirmedRows = v1data<{ id: string; roster_count: number }[]>(
    await v1(owner, `/api/v1/divisions/${div.id}/registrations?status=confirmed`),
  );
  const teamARow = confirmedRows.find((r) => r.id === teamAId);
  check(
    "team ops: team A's roster grows from 1 (captain) to 2 once the joiner lands",
    teamARow?.roster_count === 2,
  );

  // --- ASSIGN: the organiser places the pooled solo sign-up onto team B ---
  type AssignOut = {
    registration_id: string;
    target_registration_id: string;
    target_display_name: string;
    roster_count: number;
  };
  const assigned = await v1(owner, `/api/v1/registrations/${soloId}/assign`, "POST", {
    target_registration_id: teamBId,
  });
  const assignedData = v1data<AssignOut>(assigned);
  check(
    "team ops: assign places the pooled solo sign-up onto team B, growing its roster to 2",
    assigned.status === 200 &&
      assignedData.target_registration_id === teamBId &&
      assignedData.target_display_name === `Bravo ${tag}` &&
      assignedData.roster_count === 2,
  );
}
