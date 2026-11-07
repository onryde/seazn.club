// GET /api/v1/device-link — the phone's Remote Scoring bootstrap (capture design §7.1), driven through the REAL handler with
// a REAL device-link bearer over a seeded badminton singles and doubles fixture and a football team sheet. Expected values
// are literals from the seed, never computed by the code under test. Real Postgres required (with `sync:sports` applied);
// skipped without DATABASE_URL.
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";

vi.stubEnv("DEVICE_LINK_KEK", randomBytes(32).toString("hex"));

const seam = vi.hoisted(() => ({ resolves: 0 }));
vi.mock("@/server/usecases/device-links", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/usecases/device-links")>();
  return {
    ...actual,
    resolveDeviceLinkToken: (token: string) => {
      seam.resolves++;
      return actual.resolveDeviceLinkToken(token);
    },
  };
});

import { sql } from "@/lib/db";
import { __setRateLimitCounterForTests } from "@/lib/rate-limit";
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
import { DeviceLinkBootstrap as DeviceLinkBootstrapSchema } from "@/server/api-v1/schemas";
import { GET as listCompetitions } from "../../competitions/route";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(() => vi.unstubAllEnvs());
afterEach(() => {
  vi.unstubAllEnvs();
  __setRateLimitCounterForTests(null);
});

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

type Member = { full_name: string; squad_number: number | null };
const NORTHGATE: Member[] = [
  { full_name: "Dan Moss", squad_number: 1 },
  { full_name: "Ade Okafor", squad_number: 9 },
  { full_name: "Ben Silva", squad_number: 10 },
  { full_name: "Cal Reyes", squad_number: null },
  { full_name: "Eve Hart", squad_number: 14 },
  { full_name: "Fay Lund", squad_number: null }, // the coach
];
const RIVERSIDE: Member[] = [
  { full_name: "Gus Pike", squad_number: 1 },
  { full_name: "Hal Ruiz", squad_number: 2 },
];

/** A started 11-a-side football league of two teams with squad numbers (S2-5 design §10): the phone's football and cricket
 *  pads read each lineup row's team-sheet fields off the bootstrap. Northgate's people are looked up by name in SQL, so no
 *  id comes from the code under test. */
async function seedFootball(auth: AuthCtx) {
  const suffix = randomUUID().slice(0, 6);
  const competition = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: `County Cup ${suffix}`,
    visibility: "private",
    branding: {},
  });
  const division = await createDivision(auth, competition.id, {
    name: "Open 11-a-side",
    sport_key: "football",
    variant_key: "11-a-side",
    config: {},
  });
  const entrants = await createEntrants(
    auth,
    division.id,
    [
      { display_name: "Northgate", members: NORTHGATE },
      { display_name: "Riverside", members: RIVERSIDE },
    ].map((t, i) => ({
      kind: "team" as const,
      display_name: t.display_name,
      seed: i + 1,
      members: t.members.map((m) => ({
        new_person: { full_name: m.full_name },
        squad_number: m.squad_number,
        is_captain: false,
        roles: [],
      })),
    })),
  );
  const [stage] = await createStages(auth, division.id, { seq: 1, kind: "league", name: "League", config: {} });
  await generateStageFixtures(auth, stage!.id);
  await startDivision(auth, division.id);
  const [fixture] = await sql<{ id: string; home_entrant_id: string; away_entrant_id: string }[]>`
    select id, home_entrant_id, away_entrant_id from fixtures where stage_id = ${stage!.id}`;
  const northgate = entrants.find((e) => e.display_name === "Northgate")!.id;
  const people = await sql<{ id: string; full_name: string }[]>`
    select p.id, p.full_name from entrant_members em join persons p on p.id = em.person_id where em.entrant_id = ${northgate}`;
  const id = (name: string) => people.find((p) => p.full_name === name)!.id;
  const link = await createDeviceLink(auth, fixture!.id, null);
  // Northgate's side of the fixture, by entrant id: the draw decides which seat it is.
  const side: "home" | "away" = fixture!.home_entrant_id === northgate ? "home" : "away";
  const other: "home" | "away" = side === "home" ? "away" : "home";
  return {
    fixture: fixture!,
    northgate,
    side,
    other,
    secret: link.secret,
    dan: id("Dan Moss"),
    ade: id("Ade Okafor"),
    cal: id("Cal Reyes"),
    eve: id("Eve Hart"),
    fay: id("Fay Lund"),
  };
}

/** Northgate's team sheet: Dan GK starting 1 captain; Ade FW starting 2; Cal starting 3 (no number); Eve bench 4; Fay
 *  starting 5 as the coach. Ben is on the roster and not on the sheet. */
async function putNorthgateSheet(auth: AuthCtx, s: Awaited<ReturnType<typeof seedFootball>>) {
  const row = (person_id: string, slot: "starting" | "bench", order_no: number, extra: Record<string, unknown> = {}) => ({
    person_id, slot, position_key: null, order_no, roles: [], ...extra,
  });
  await putLineup(auth, s.fixture.id, s.northgate, {
    slots: [
      row(s.dan, "starting", 1, { position_key: "GK", roles: ["captain"] }),
      row(s.ade, "starting", 2, { position_key: "FW" }),
      row(s.cal, "starting", 3),
      row(s.eve, "bench", 4),
      row(s.fay, "starting", 5, { role: "coach" }),
    ],
  } as never);
}

async function call(secret: string | null, scheme = "Bearer", ip?: string) {
  const headers: Record<string, string> = secret === null ? {} : { authorization: `${scheme} ${secret}` };
  if (ip) headers["x-forwarded-for"] = ip;
  const res = await GET(new Request("https://test.local/api/v1/device-link", { headers }));
  const body = (await res.json()) as { ok: boolean; data?: DeviceLinkBootstrap; error?: { code?: string }; requestId?: string };
  return { status: res.status, body, cacheControl: res.headers.get("cache-control"), retryAfter: res.headers.get("retry-after") };
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
    // S2-5 §10: the rows carry the team sheet too, and pair_order rides unchanged beside it.
    const pairRow = (person_id: string, n: number) => ({
      person_id, pair_order: n, slot: "starting", position_key: null, order_no: n, role: "player", roles: [], squad_number: null,
    });
    expect(after.sides.home!.lineup).toEqual([pairRow(b!.person_id, 1), pairRow(a!.person_id, 2)]);
  });

  it("carries every lineup row's team-sheet fields, starters then bench, as readLineup orders them", async () => {
    const { auth } = await seedOrg();
    const s = await seedFootball(auth);
    await putNorthgateSheet(auth, s);
    const r = await call(s.secret);
    expect(r.status).toBe(200);
    const north = r.body.data!.sides[s.side]!;
    expect(north.entrant_id).toBe(s.northgate);
    expect(north.lineup).toEqual([
      { person_id: s.dan, pair_order: null, slot: "starting", position_key: "GK", order_no: 1, role: "player", roles: ["captain"], squad_number: 1 },
      { person_id: s.ade, pair_order: null, slot: "starting", position_key: "FW", order_no: 2, role: "player", roles: [], squad_number: 9 },
      { person_id: s.cal, pair_order: null, slot: "starting", position_key: null, order_no: 3, role: "player", roles: [], squad_number: null },
      { person_id: s.eve, pair_order: null, slot: "bench", position_key: null, order_no: 4, role: "player", roles: [], squad_number: 14 },
      { person_id: s.fay, pair_order: null, slot: "starting", position_key: null, order_no: 5, role: "coach", roles: [], squad_number: null },
    ]);
  });

  it("a side with no team sheet is an empty lineup beside one that has one", async () => {
    const { auth } = await seedOrg();
    const s = await seedFootball(auth);
    await putNorthgateSheet(auth, s);
    const d = (await call(s.secret)).body.data!;
    expect(d.sides[s.other]!.name).toBe("Riverside");
    expect(d.sides[s.other]!.lineup).toEqual([]);
    expect(d.sides[s.side]!.lineup.length).toBe(5);
  });

  it("answers exactly the published schema: parsing the body through DeviceLinkBootstrap strips nothing", async () => {
    const { auth } = await seedOrg();
    const s = await seedFootball(auth);
    await putNorthgateSheet(auth, s);
    const d = (await call(s.secret)).body.data!;
    expect(d.sides[s.side]!.lineup.length, "premise: the sheet is on the side").toBe(5);
    // z.object strips undeclared keys, so a field the usecase sends and the schema omits reds here.
    expect(DeviceLinkBootstrapSchema.parse(d)).toEqual(d);
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

  it("names nothing from another org's fixture: a link for A answers A's literals only", async () => {
    const one = await seedOrg();
    const a = await seedBadminton(one.auth, "individual", [
      { display_name: "Alpha One", members: ["Alpha One"] },
      { display_name: "Alpha Two", members: ["Alpha Two"] },
    ]);
    const two = await seedOrg();
    const b = await seedBadminton(two.auth, "pair", [
      { display_name: "Bravo One / Bravo Two", members: ["Bravo One", "Bravo Two"] },
      { display_name: "Bravo Three / Bravo Four", members: ["Bravo Three", "Bravo Four"] },
    ]);
    const d = (await call(a.secret)).body.data!;
    expect(d.fixture_id).toBe(a.fixture.id);
    expect(d.fixture_id).not.toBe(b.fixture.id);
    expect(d.names.division).toBe("Singles");
    const text = JSON.stringify(d);
    expect(text).not.toContain("Bravo");
    expect(text).not.toContain(b.fixture.id);
    expect(text).not.toContain(b.linkId);
    expect(["Alpha One", "Alpha Two"]).toContain(d.sides.home!.name);
    // and B's link names only B
    const e = (await call(b.secret)).body.data!;
    expect(e.fixture_id).toBe(b.fixture.id);
    expect(JSON.stringify(e)).not.toContain("Alpha");
  });
});

/** A fixed-window counter the limiter reads instead of Redis (the suite's own seam): count per key, a 1 s TTL. */
function counterSeam() {
  const counts = new Map<string, number>();
  __setRateLimitCounterForTests(async (key) => {
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    return { count: n, ttlMs: 1000 };
  });
  return counts;
}

describe.skipIf(!HAS_DB)("GET /api/v1/device-link is metered", () => {
  it("the 11th read in a second by one link is 429 RATE_LIMITED with Retry-After; the 10th is not", async () => {
    const { auth } = await seedOrg();
    const s = await seedBadminton(auth, "individual", [
      { display_name: "Asha Rao", members: ["Asha Rao"] },
      { display_name: "Bo Lin", members: ["Bo Lin"] },
    ]);
    counterSeam();
    for (let i = 1; i <= 10; i++) expect((await call(s.secret, "Bearer", "198.51.100.7")).status, `read ${i}`).toBe(200);
    const eleventh = await call(s.secret, "Bearer", "198.51.100.7");
    expect(eleventh.status).toBe(429);
    expect(eleventh.body.error?.code).toBe("RATE_LIMITED");
    expect(eleventh.retryAfter).toBe("1");
    // another link is not spent by this one
    const other = await seedBadminton(auth, "individual", [
      { display_name: "Cy Dunn", members: ["Cy Dunn"] },
      { display_name: "Di Park", members: ["Di Park"] },
    ]);
    expect((await call(other.secret, "Bearer", "198.51.100.7")).status).toBe(200);
  });

  it("a flood of unknown tokens from one IP is 429 before the link is looked up (no database read)", async () => {
    counterSeam();
    seam.resolves = 0;
    for (let i = 1; i <= 300; i++) {
      const r = await call("dl_" + randomBytes(16).toString("base64url"), "Bearer", "203.0.113.9");
      expect(r.status, `guess ${i}`).toBe(401);
    }
    expect(seam.resolves).toBe(300);
    const over = await call("dl_" + randomBytes(16).toString("base64url"), "Bearer", "203.0.113.9");
    expect(over.status).toBe(429);
    expect(over.body.error?.code).toBe("RATE_LIMITED");
    expect(seam.resolves, "the refused guess never reached the resolver").toBe(300);
    // a different address is untouched
    expect((await call("dl_" + randomBytes(16).toString("base64url"), "Bearer", "203.0.113.10")).status).toBe(401);
  });
});
