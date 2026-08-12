// S9/#418 — the GET /persons/{id}/stats route's `?group=sport` wiring, as a
// REAL handler over a REAL scoped API key (never a mocked requireResourceAuth
// — see docs' own api-v1-route-tests recipe: mocking the auth door deletes
// the only thing a route test proves that a usecase test cannot, which here
// is that the QUERY STRING actually reaches the right usecase). Real
// Postgres required.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createApiKey } from "@/server/usecases/api-keys";
import { createCompetition } from "@/server/usecases/competitions";
import { createDivision } from "@/server/usecases/divisions";
import { createEntrants } from "@/server/usecases/entrants";
import { putLineup } from "@/server/usecases/fixtures";
import { createPerson } from "@/server/usecases/persons";
import { personStats } from "@/server/usecases/player-stats";
import { scoreEvent } from "@/server/usecases/scoring";
import { GET } from "../route";

import { setOrgPlan } from "@/lib/__tests__/_billing-group";
const HAS_DB = !!process.env.DATABASE_URL;

interface Envelope {
  ok: boolean;
  data?: Record<string, unknown>;
  error?: { code: string; message: string };
}

function keyedRequest(secret: string, path: string): Request {
  return new Request(`https://test.local/api/v1${path}`, {
    method: "GET",
    headers: { authorization: `Bearer ${secret}` },
  });
}

async function read(res: Response): Promise<{ status: number; body: Envelope }> {
  return { status: res.status, body: (await res.json()) as Envelope };
}

async function seed(): Promise<{ secret: string; personId: string; divisionId: string }> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"Route " + suffix}, ${"route-" + suffix})
    returning id`;
  await setOrgPlan(orgId, "pro"); // grants BOTH api.access and stats.player
  await invalidateOrgEntitlements(orgId);
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('football', 'Football', '1.0.0', ${sql.json({ groups: [], lineup: { size: 1, benchMax: 0 } })})
    on conflict (key) do nothing`;
  await sql`
    insert into sport_variants (sport_key, key, name, config, is_system)
    values ('football', 'default', 'Default', ${sql.json({})}, true)
    on conflict do nothing`;
  const auth: AuthCtx = { orgId, via: "session", userId: null, role: "owner", keyId: null };
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Route Cup " + suffix,
    visibility: "public",
    branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name: "Open",
    slug: "open",
    sport_key: "football",
    variant_key: "default",
    config: {},
    eligibility: [],
  });
  const person = await createPerson(auth, {
    full_name: "Route Player",
    consent: {},
    dob: null,
    gender: null,
    external_ref: null,
  });
  const opponent = await createPerson(auth, {
    full_name: "Route Opponent",
    consent: {},
    dob: null,
    gender: null,
    external_ref: null,
  });
  const [mine, theirs] = await createEntrants(auth, division.id, [
    {
      kind: "team",
      display_name: "Squad",
      seed: 1,
      members: [{ person_id: person.id, squad_number: null, is_captain: false, roles: [], default_position_key: null }],
    } as never,
    {
      kind: "team",
      display_name: "Opponent Squad",
      seed: 2,
      members: [{ person_id: opponent.id, squad_number: null, is_captain: false, roles: [], default_position_key: null }],
    } as never,
  ]);
  await sql`
    insert into stages (division_id, seq, kind, name) values (${division.id}, 1, 'league', 'League')`;
  const [{ id: stageId }] = await sql<{ id: string }[]>`
    select id from stages where division_id = ${division.id}`;
  await sql`update divisions set status = 'active' where id = ${division.id}`;
  const [{ id: fixtureId }] = await sql<{ id: string }[]>`
    insert into fixtures (stage_id, division_id, round_no, seq_in_round, home_entrant_id, away_entrant_id, status)
    values (${stageId}, ${division.id}, 1, 1, ${mine!.id}, ${theirs!.id}, 'scheduled')
    returning id`;
  await putLineup(auth, fixtureId, mine!.id, {
    slots: [{ person_id: person.id, slot: "starting" as const, position_key: null, order_no: 1, roles: [] }],
  });
  await putLineup(auth, fixtureId, theirs!.id, {
    slots: [{ person_id: opponent.id, slot: "starting" as const, position_key: null, order_no: 1, roles: [] }],
  });
  await scoreEvent(auth, fixtureId, { expected_seq: 0, type: "core.start", payload: {} });
  // 3 goals — a real, recompute-stable ledger so both the ?group=sport path
  // (reads the snapshot as-is) and the plain per-division path (recomputes
  // on every read) report the SAME numbers. Each squad here has one player,
  // so no valid teammate exists to credit an assist — goals only.
  for (let seq = 1; seq <= 3; seq += 1) {
    await scoreEvent(auth, fixtureId, {
      expected_seq: seq,
      type: "football.goal",
      payload: { by: mine!.id, scorer: person.id },
    });
  }
  // personCareerStats (the ?group=sport path) deliberately never recomputes
  // — it only reads whatever a division read already produced. Force that
  // FIRST recompute here, exactly like production's first real read of this
  // division would, so player_stat_snapshots has a row for ?group=sport to
  // find; the "no group param" test below re-reads it (and recomputes
  // again, harmlessly, since nothing changed) through the route itself.
  await personStats(auth, person.id);
  const { secret } = await createApiKey(auth, { name: "reader", scopes: ["read"] });
  return { secret, personId: person.id, divisionId: division.id };
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("GET /persons/{id}/stats — ?group=sport wiring (S9/#418)", () => {
  it("?group=sport returns the career rollup shape (sports[]), summed via the real usecase", async () => {
    const { secret, personId } = await seed();
    const { status, body } = await read(
      await GET(keyedRequest(secret, `/persons/${personId}/stats?group=sport`), {
        params: Promise.resolve({ id: personId }),
      }),
    );
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    const sports = body.data!.sports as { sport_key: string; metrics: { key: string; value: number }[] }[];
    expect(sports).toBeDefined();
    expect(body.data!.divisions).toBeUndefined(); // NOT the per-division shape
    const football = sports.find((s) => s.sport_key === "football")!;
    expect(football.metrics.find((m) => m.key === "goals")?.value).toBe(3);
  });

  it("no group param keeps today's per-division shape byte-for-byte", async () => {
    const { secret, personId, divisionId } = await seed();
    const { status, body } = await read(
      await GET(keyedRequest(secret, `/persons/${personId}/stats`), {
        params: Promise.resolve({ id: personId }),
      }),
    );
    expect(status).toBe(200);
    const divisions = body.data!.divisions as { division_id: string; stats: Record<string, number> }[];
    expect(divisions).toBeDefined();
    expect(body.data!.sports).toBeUndefined(); // NOT the career shape
    expect(divisions[0]!.division_id).toBe(divisionId);
    expect(divisions[0]!.stats.goals).toBe(3);
  });

  it("an unrecognised group value falls back to the per-division shape — 200, never a 400", async () => {
    const { secret, personId } = await seed();
    const { status, body } = await read(
      await GET(keyedRequest(secret, `/persons/${personId}/stats?group=bogus`), {
        params: Promise.resolve({ id: personId }),
      }),
    );
    expect(status).toBe(200);
    expect(body.data!.divisions).toBeDefined();
    expect(body.data!.sports).toBeUndefined();
  });

  it("division_id still filters normally alongside no group param (existing behaviour untouched)", async () => {
    const { secret, personId, divisionId } = await seed();
    const { body } = await read(
      await GET(keyedRequest(secret, `/persons/${personId}/stats?division_id=${divisionId}`), {
        params: Promise.resolve({ id: personId }),
      }),
    );
    const divisions = body.data!.divisions as { division_id: string }[];
    expect(divisions).toHaveLength(1);
    expect(divisions[0]!.division_id).toBe(divisionId);
  });
});
