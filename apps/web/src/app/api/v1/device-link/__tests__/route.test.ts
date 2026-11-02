// GET /api/v1/device-link — the phone's Remote Scoring bootstrap (capture design §7.1), driven through the REAL handler with
// a REAL device-link bearer over a seeded badminton singles and doubles fixture. Expected values are literals from the seed,
// never computed by the code under test. Real Postgres required (with `sync:sports` applied); skipped without DATABASE_URL.
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";

vi.stubEnv("DEVICE_LINK_KEK", randomBytes(32).toString("hex"));

import { sql } from "@/lib/db";
import { createCompetition } from "@/server/usecases/competitions";
import { createDivision } from "@/server/usecases/divisions";
import { createEntrants } from "@/server/usecases/entrants";
import { putLineup } from "@/server/usecases/fixtures";
import { createStages, generateStageFixtures } from "@/server/usecases/stages";
import { startDivision } from "@/server/usecases/schedule";
import { scoreEvent } from "@/server/usecases/scoring";
import { createDeviceLink } from "@/server/usecases/device-links";
import { seedOrg } from "@/server/usecases/__tests__/_seed";
import type { AuthCtx } from "@/server/api-v1/auth";
import { GET } from "../route";
import type { DeviceLinkBootstrap } from "@/server/usecases/device-link-bootstrap";
import { GET as listCompetitions } from "../../competitions/route";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(() => vi.unstubAllEnvs());
afterEach(() => vi.unstubAllEnvs());

type Roster = { display_name: string; members: string[] };

async function seedBadminton(
  auth: AuthCtx,
  kind: "individual" | "pair",
  sides: [Roster, Roster],
  opts: { start?: boolean } = {},
) {
  const suffix = randomUUID().slice(0, 6);
  const competition = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: `Spring Open ${suffix}`,
    visibility: "private",
    branding: {},
  });
  const division = await createDivision(auth, competition.id, {
    name: kind === "pair" ? "Doubles" : "Singles",
    sport_key: "badminton",
    variant_key: "bwf",
    config: {},
  });
  const entrants = await createEntrants(
    auth,
    division.id,
    sides.map((s, i) => ({
      kind,
      display_name: s.display_name,
      seed: i + 1,
      members: s.members.map((full_name) => ({ new_person: { full_name }, squad_number: null, is_captain: false, roles: [] })),
    })),
  );
  const [stage] = await createStages(auth, division.id, { seq: 1, kind: "league", name: "League", config: {} });
  await generateStageFixtures(auth, stage!.id);
  if (opts.start !== false) await startDivision(auth, division.id);
  const [fixture] = await sql<{ id: string; home_entrant_id: string; away_entrant_id: string }[]>`
    select id, home_entrant_id, away_entrant_id from fixtures where stage_id = ${stage!.id}`;
  const link = await createDeviceLink(auth, fixture!.id, null);
  return { competition, division, entrants, fixture: fixture!, secret: link.secret, linkId: link.id };
}

async function call(secret: string | null, scheme = "Bearer") {
  const headers: Record<string, string> = secret === null ? {} : { authorization: `${scheme} ${secret}` };
  const res = await GET(new Request("https://test.local/api/v1/device-link", { headers }));
  const body = (await res.json()) as { ok: boolean; data?: DeviceLinkBootstrap; error?: { code?: string }; requestId?: string };
  return { status: res.status, body, cacheControl: res.headers.get("cache-control") };
}

describe.skipIf(!HAS_DB)("GET /api/v1/device-link", () => {
  it("answers a singles fixture, field for field, in the v1 envelope", async () => {
    const { auth } = await seedOrg();
    const s = await seedBadminton(auth, "individual", [
      { display_name: "Asha Rao", members: ["Asha Rao"] },
      { display_name: "Bo Lin", members: ["Bo Lin"] },
    ]);
    const r = await call(s.secret);
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(typeof r.body.requestId).toBe("string");
    expect(r.cacheControl).toBe("no-store");
    const d = r.body.data!;
    expect(d.fixture_id).toBe(s.fixture.id);
    expect(d.link_id).toBe(s.linkId);
    expect(d.sport_key).toBe("badminton");
    expect(typeof d.module_version).toBe("string");
    expect(d.rules_version).toBe(0);
    expect(d.engine_epoch_required).toBe(2);
    expect(d.screen).toBe("confirm");
    expect(d.view_only_reason).toBeNull();
    expect(d.names.competition).toMatch(/^Spring Open /);
    expect(d.names.division).toBe("Singles");
    expect(d.names.round_label).toBe("Round 1");
    expect(typeof d.names.ref).toBe("string");
    expect(d.state).toEqual({ status: "scheduled", last_seq: 0 });
    expect(d.cfg).toBeTypeOf("object");
    expect(d.cfg).not.toBeNull();
    const home = s.entrants.find((e) => e.id === s.fixture.home_entrant_id)!.display_name;
    const side = d.sides.home!;
    expect(side.entrant_id).toBe(s.fixture.home_entrant_id);
    expect(side.name).toBe(home);
    expect(side.kind).toBe("individual");
    expect(side.members.map((m) => m.full_name)).toEqual([home]);
    expect(side.members[0].person_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(side.lineup).toEqual([]);
    expect(["Asha Rao", "Bo Lin"]).toContain(d.sides.away!.name);
    expect(d.sides.away!.name).not.toBe(home);
  });

  it("answers a doubles fixture with both players per side, in lineup order once one is saved", async () => {
    const { auth } = await seedOrg();
    const s = await seedBadminton(auth, "pair", [
      { display_name: "Asha Rao / Cy Dunn", members: ["Asha Rao", "Cy Dunn"] },
      { display_name: "Bo Lin / Di Park", members: ["Bo Lin", "Di Park"] },
    ]);
    const first = (await call(s.secret)).body.data!;
    expect(first.screen).toBe("confirm");
    expect(first.names.division).toBe("Doubles");
    for (const key of ["home", "away"] as const) {
      expect(first.sides[key]!.kind).toBe("pair");
      expect(first.sides[key]!.members).toHaveLength(2);
      expect(first.sides[key]!.lineup).toEqual([]);
    }
    const homeNames = first.sides.home!.members.map((m) => m.full_name);
    expect(["Asha Rao,Cy Dunn", "Bo Lin,Di Park"]).toContain(homeNames.join(","));
    // Save the pair in reversed order: the bootstrap carries the lineup's pair_order, the roster order is unchanged.
    const [a, b] = first.sides.home!.members;
    const slot = (personId: string, pairOrder: number) => ({
      person_id: personId, slot: "starting" as const, position_key: null, order_no: pairOrder, roles: [], role: null, pair_order: pairOrder,
    });
    await putLineup(auth, s.fixture.id, s.fixture.home_entrant_id, { slots: [slot(b!.person_id, 1), slot(a!.person_id, 2)] } as never);
    const after = (await call(s.secret)).body.data!;
    const order = new Map(after.sides.home!.lineup.map((l) => [l.person_id, l.pair_order]));
    expect(order.get(b!.person_id)).toBe(1);
    expect(order.get(a!.person_id)).toBe(2);
    expect(after.sides.home!.members.map((m) => m.full_name)).toEqual(homeNames);
  });

  it("names the screen by scanScreen: division not started, then pad with the ledger's seq once play begins", async () => {
    const { auth } = await seedOrg();
    const s = await seedBadminton(
      auth,
      "individual",
      [
        { display_name: "Asha Rao", members: ["Asha Rao"] },
        { display_name: "Bo Lin", members: ["Bo Lin"] },
      ],
      { start: false },
    );
    expect((await call(s.secret)).body.data!.screen).toBe("division_not_started");
    await startDivision(auth, s.division.id);
    expect((await call(s.secret)).body.data!.screen).toBe("confirm");
    await scoreEvent(auth, s.fixture.id, { expected_seq: 0, type: "core.start", payload: {} });
    const d = (await call(s.secret)).body.data!;
    expect(d.screen).toBe("pad");
    expect(d.state).toEqual({ status: "in_play", last_seq: 1 });
  });

  it("view-only carries its reason: a cancelled match", async () => {
    const { auth } = await seedOrg();
    const s = await seedBadminton(auth, "individual", [
      { display_name: "Asha Rao", members: ["Asha Rao"] },
      { display_name: "Bo Lin", members: ["Bo Lin"] },
    ]);
    await sql`update fixtures set status = 'cancelled' where id = ${s.fixture.id}`;
    const d = (await call(s.secret)).body.data!;
    expect(d.screen).toBe("view_only");
    expect(d.view_only_reason).toBe("cancelled");
  });

  it("reports the EFFECTIVE epoch floor a 426 would, so an override moves both", async () => {
    const { auth } = await seedOrg();
    const s = await seedBadminton(auth, "individual", [
      { display_name: "Asha Rao", members: ["Asha Rao"] },
      { display_name: "Bo Lin", members: ["Bo Lin"] },
    ]);
    vi.stubEnv("ENGINE_EPOCH_FLOOR_OVERRIDE", "badminton=1");
    expect((await call(s.secret)).body.data!.engine_epoch_required).toBe(1);
  });

  it("refuses revoked, expired and unknown links with 401 and their codes", async () => {
    const { auth } = await seedOrg();
    const s = await seedBadminton(auth, "individual", [
      { display_name: "Asha Rao", members: ["Asha Rao"] },
      { display_name: "Bo Lin", members: ["Bo Lin"] },
    ]);
    const unknown = await call("dl_" + randomBytes(32).toString("base64url"));
    expect(unknown.status).toBe(401);
    expect(unknown.body.error?.code).toBe("LINK_INVALID");

    await sql`update device_links set expires_at = now() - interval '1 hour' where id = ${s.linkId}`;
    const expired = await call(s.secret);
    expect(expired.status).toBe(401);
    expect(expired.body.error?.code).toBe("LINK_EXPIRED");

    await sql`update device_links set expires_at = null, revoked_at = now() where id = ${s.linkId}`;
    const revoked = await call(s.secret);
    expect(revoked.status).toBe(401);
    expect(revoked.body.error?.code).toBe("LINK_REVOKED");
  });

  it("answers nothing without a dl_ bearer: none, another scheme, or an API key shape", async () => {
    for (const r of [await call(null), await call("dl_x", "Basic"), await call("sc_live_abc")]) {
      expect(r.status).toBe(401);
      expect(r.body.error?.code).toBe("LINK_INVALID");
    }
  });

  it("opens this one route and not the door: the same dl_ bearer is 403 on another v1 route", async () => {
    const { auth } = await seedOrg();
    const s = await seedBadminton(auth, "individual", [
      { display_name: "Asha Rao", members: ["Asha Rao"] },
      { display_name: "Bo Lin", members: ["Bo Lin"] },
    ]);
    expect((await call(s.secret)).status).toBe(200);
    const res = await listCompetitions(
      new Request("https://test.local/api/v1/competitions", { headers: { authorization: `Bearer ${s.secret}` } }),
    );
    expect(res.status).toBe(403);
  });
});
