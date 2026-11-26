// Seazn-hosted video, Phase 1 Task 17: GET /api/v1/fixtures/{id}/video — the ORGANISER's door to a fixture's Seazn video (Match Day's
// stream preview, `<SeaznVideoIsland endpoint="org">`), driven through its REAL handler over a real session (`requireResourceAuth`
// unmocked; only the cookie door is faked one layer down, the stream-phone route test's pattern) and the REAL read over the Seazn
// rig's real sessions. server/video/__tests__/seazn-video.test.ts proves the answer; this file proves what is the ROUTE's own:
//   - a member of the fixture's organisation reads it (a VIEWER too: Match Day opens read-only for one), the answer parsed through the
//     route's own schema, a live Seazn session signed, no token in any query and none anywhere but the signed address;
//   - it answers the organisation's own PRIVATE competition's fixture, which the public route answers empty;
//   - another organisation's member, and an id that names nothing, get a 404 whose body carries no address and no uid, and nothing is
//     signed for them (the signer is a spy over the real one);
//   - signed out is 401; an API key is refused at the DOOR (NEVER_KEY_ROUTES): a signed playback address is a bearer credential;
//   - EVERY answer is `private, no-store`, varying on Cookie and Authorization, and every status is a documented response.
// ONE SPORT, on purpose (TEST-STRATEGY rule 6): the route reads no sport rule; every rig rides `generic`.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

const authState = vi.hoisted(() => ({ userId: "" }));

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  const { AuthError } = await import("@/lib/errors");
  const user = async () => {
    if (authState.userId === "") throw new AuthError("Unauthorized");
    return { id: authState.userId };
  };
  return { ...actual, requireUser: user, getCurrentUser: async () => (authState.userId === "" ? null : { id: authState.userId }), getActiveOrgId: async () => null };
});

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
  headers: async () => new Headers(),
}));
vi.mock("@/lib/sentry", () => ({ captureError: vi.fn() }));
// The REAL signer, wrapped so a refused request can be seen not to have asked it.
vi.mock("@/server/video/cf-playback", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/video/cf-playback")>();
  return { ...actual, signLivePlayback: vi.fn(actual.signLivePlayback), signRecordingPlayback: vi.fn(actual.signRecordingPlayback) };
});

import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { buildOpenApiDocument } from "@/server/api-v1/openapi";
import { PublicFixtureVideo } from "@/server/api-v1/schemas";
import { rigUser } from "@/server/relay/__tests__/_session-rig";
import { createApiKey } from "@/server/usecases/api-keys";
import { startedDivisionWithFixture } from "@/server/usecases/__tests__/_rig";
import { makeUser, seedOrg } from "@/server/usecases/__tests__/_seed";
import { seaznFixtureVideo } from "@/server/video/seazn-video";
import { signLivePlayback, signRecordingPlayback } from "@/server/video/cf-playback";
import { installSeaznEnv, live, seaznRigFor, stopAndSettle } from "@/server/video/__tests__/_seazn-session-rig";
import { GET } from "../route";

const HAS_DB = !!process.env.DATABASE_URL;
installSeaznEnv("seazn-org-video-route-test");

const BASE = "https://test.local/api/v1";
/** The fake driver's playback host and the token's one-segment shape (cf-playback.ts, the plan's C1). */
/** W-LL: the live programme manifest carries Cloudflare's LL-HLS query while STREAM_PROGRAMME_LOW_LATENCY is on (the default); a recording's never does (seazn-video.test.ts pins that). */
const PLAY = /^https:\/\/playback\.fake\.invalid\/([^/?]+)\/manifest\/video\.m3u8(?:\?protocol=llhls)?$/;

interface Envelope<T = unknown> {
  ok: boolean;
  data?: T;
  error?: { code?: string; message: string; [k: string]: unknown };
}

/** A signed-in OWNER of an org with two started fixtures, the Seazn rig on both (relay entitlements, credits, a phone each). */
async function organiser() {
  const { auth: owned } = await seedOrg("pro");
  authState.userId = owned.userId!;
  const started = await startedDivisionWithFixture(owned, { fixtures: 2 });
  const r = await seaznRigFor({ ...owned, userId: await rigUser() }, started.fixtureIds as [string, string]);
  return { r, ownerId: owned.userId!, orgId: owned.orgId, fixtures: started.fixtureIds as [string, string] };
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const get = (fixtureId: string, headers: Record<string, string> = {}) =>
  GET(new Request(`${BASE}/fixtures/${fixtureId}/video`, { method: "GET", headers }), params(fixtureId));
async function read<T>(res: Response): Promise<{ status: number; body: Envelope<T>; raw: string }> {
  const raw = await res.clone().text();
  return { status: res.status, body: (await res.json()) as Envelope<T>, raw };
}
const documented = (): string[] =>
  Object.keys(
    (buildOpenApiDocument() as { paths: Record<string, Record<string, { responses: Record<string, unknown> }>> }).paths["/api/v1/fixtures/{id}/video"]!.get!.responses,
  );
async function member(orgId: string, role: "admin" | "viewer"): Promise<string> {
  const u = await makeUser(role);
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${u.id}, ${role})`;
  return u.id;
}
async function override(orgId: string, key: string, value: boolean) {
  await sql`insert into org_entitlement_overrides (org_id, feature_key, bool_value, reason) values (${orgId}, ${key}, ${value}, 'org video route')
            on conflict (org_id, feature_key) do update set bool_value = ${value}`;
  await invalidateOrgEntitlements(orgId);
}

describe.skipIf(!HAS_DB)("GET …/fixtures/{id}/video over HTTP (the organiser's door)", () => {
  it("EMPTY CASE FIRST: a member reads a fixture with no session: 200 {live: null, replay: []}, and nothing was signed", async () => {
    const o = await organiser();
    vi.mocked(signLivePlayback).mockClear();
    const res = await read<PublicFixtureVideo>(await get(o.fixtures[0]));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, data: { live: null, replay: [], session: null } });
    expect(signLivePlayback, "no session, no live uid, nothing to sign").not.toHaveBeenCalled();
  });

  it("a live Seazn session: 200, the route's own schema, the live address signed for THIS fixture's programme input, with no query string and no token outside the address", async () => {
    const o = await organiser();
    const sid = await live(o.r, o.fixtures[0], o.r.seazn);
    const [input] = await sql<{ ingest_input_id: string }[]>`select ingest_input_id from fixture_stream_inputs where session_id = ${sid} and role = 'programme' order by slot limit 1`;
    expect(input?.ingest_input_id, "PREMISE: the producer gave the session a programme input").toBeTruthy();
    const res = await read<PublicFixtureVideo>(await get(o.fixtures[0]));
    expect(res.status).toBe(200);
    const data = PublicFixtureVideo.parse(res.body.data);
    expect(data).toEqual(res.body.data);
    const m = PLAY.exec(data.live!.src);
    expect(m, "the live address is a Cloudflare-shaped manifest address with the token as ONE path segment").not.toBeNull();
    expect(m![1], "the token names this programme input (the fake mints fake.<uid>.<exp>)").toContain(input!.ingest_input_id);
    expect(data.live!.src).not.toMatch(/[?#]/);
    // The token appears once in the body: inside the address, and nowhere else (no field of its own, no echo).
    expect(res.raw.split(m![1]!).length - 1, "the token is in the address only").toBe(1);
    expect(data.replay).toEqual([]);
    // The fixture beside it, with no session, is still empty: the answer is the PATH's fixture's.
    expect((await read<PublicFixtureVideo>(await get(o.fixtures[1]))).body.data).toEqual({ live: null, replay: [], session: null });
    expect(data.session, "the live answer names its session: live, and it went live").toEqual({ state: "live", wentLive: true });
  });

  it("the organisation's own PRIVATE competition: the organiser's door answers the live, the public door answers nothing", async () => {
    const o = await organiser();
    await live(o.r, o.fixtures[0], o.r.seazn);
    await sql`update competitions set visibility = 'private' where id = (select d.competition_id from fixtures f join divisions d on d.id = f.division_id where f.id = ${o.fixtures[0]})`;
    const organiserSees = await read<PublicFixtureVideo>(await get(o.fixtures[0]));
    expect(organiserSees.body.data?.live, "the organiser's door").not.toBeNull();
    expect(await seaznFixtureVideo(o.fixtures[0], new Date()), "PREMISE: the public read answers nothing for a private competition").toEqual({ live: null, replay: [], session: null });
  });

  it("a stopped Seazn session no longer shows a live (ended)", async () => {
    const o = await organiser();
    const sid = await live(o.r, o.fixtures[0], o.r.seazn);
    expect((await read<PublicFixtureVideo>(await get(o.fixtures[0]))).body.data?.live).not.toBeNull();
    await stopAndSettle(o.r, o.fixtures[0], sid);
    expect((await read<PublicFixtureVideo>(await get(o.fixtures[0]))).body.data, "stopped: no live, the session ended").toEqual({ live: null, replay: [], session: { state: "completed", wentLive: true } });
  });

  it("a VIEWER of the fixture's own organisation reads it (Match Day opens read-only for one); an ADMIN does too", async () => {
    const o = await organiser();
    await live(o.r, o.fixtures[0], o.r.seazn);
    for (const role of ["viewer", "admin"] as const) {
      authState.userId = await member(o.orgId, role);
      const res = await read<PublicFixtureVideo>(await get(o.fixtures[0]));
      expect(res.status, role).toBe(200);
      expect(res.body.data?.live, role).not.toBeNull();
    }
  });

  it("ANOTHER organisation's member gets a 404 with no address and no uid in the body, and nothing is signed for them; the owner is still served (the positive pair)", async () => {
    const a = await organiser();
    const sid = await live(a.r, a.fixtures[0], a.r.seazn);
    const [input] = await sql<{ ingest_input_id: string }[]>`select ingest_input_id from fixture_stream_inputs where session_id = ${sid} and role = 'programme' limit 1`;
    const b = await organiser();
    authState.userId = b.ownerId;
    vi.mocked(signLivePlayback).mockClear();
    vi.mocked(signRecordingPlayback).mockClear();
    const refused = await read(await get(a.fixtures[0]));
    expect(refused.status).toBe(404);
    expect(refused.body.ok).toBe(false);
    expect(refused.raw).not.toContain("playback.fake.invalid");
    expect(refused.raw).not.toContain(input!.ingest_input_id);
    expect(refused.raw).not.toContain(a.fixtures[0]);
    expect(signLivePlayback, "nothing is signed for a stranger").not.toHaveBeenCalled();
    expect(signRecordingPlayback).not.toHaveBeenCalled();
    expect(documented()).toContain("404");
    authState.userId = a.ownerId;
    expect((await read<PublicFixtureVideo>(await get(a.fixtures[0]))).body.data?.live).not.toBeNull();
  });

  it("an id that names nothing, and one that is not a uuid: 404 — the same answer as another organisation's fixture", async () => {
    const o = await organiser();
    await live(o.r, o.fixtures[0], o.r.seazn);
    const stranger = await organiser();
    authState.userId = stranger.ownerId;
    const answers = [await get(randomUUID()), await get("f1"), await get("1' or '1'='1"), await get(o.fixtures[0])];
    const seen: { status: number; message: string | undefined }[] = [];
    for (const res of answers) {
      const { status, body } = await read(res);
      seen.push({ status, message: body.error?.message });
    }
    expect(seen.map((s) => s.status)).toEqual([404, 404, 404, 404]);
    expect(new Set(seen.map((s) => s.message)).size, "one message for all four: the answer is not an oracle for which ids exist").toBe(1);
  });

  it("signed out is 401, and nothing is signed", async () => {
    const o = await organiser();
    await live(o.r, o.fixtures[0], o.r.seazn);
    authState.userId = "";
    vi.mocked(signLivePlayback).mockClear();
    const res = await read(await get(o.fixtures[0]));
    expect(res.status).toBe(401);
    expect(res.raw).not.toContain("playback.fake.invalid");
    expect(signLivePlayback).not.toHaveBeenCalled();
    expect(documented()).toContain("401");
  });

  it("an API key with every scope is refused at the DOOR (NEVER_KEY_ROUTES): a signed playback address is a bearer credential; the owner's session reaches the same route", async () => {
    const o = await organiser();
    await live(o.r, o.fixtures[0], o.r.seazn);
    await override(o.orgId, "api.access", true);
    await override(o.orgId, "api.write", true);
    const { secret } = await createApiKey({ orgId: o.orgId, via: "session", userId: o.ownerId, role: "owner", keyId: null }, { name: `video-${randomUUID().slice(0, 6)}`, scopes: ["manage"] });
    vi.mocked(signLivePlayback).mockClear();
    const refused = await read(await get(o.fixtures[0], { authorization: `Bearer ${secret}` }));
    expect(refused.status).toBe(403);
    expect(refused.body.error?.message).toMatch(/cannot access this endpoint/);
    expect(refused.raw).not.toContain("playback.fake.invalid");
    expect(signLivePlayback).not.toHaveBeenCalled();
    expect(documented()).toContain("403");
    authState.userId = o.ownerId;
    expect((await get(o.fixtures[0])).status).toBe(200);
  });

  it("EVERY answer — the 200 and each refusal — is `private, no-store` and varies on Cookie and Authorization", async () => {
    const o = await organiser();
    await live(o.r, o.fixtures[0], o.r.seazn);
    const stranger = await organiser();
    authState.userId = o.ownerId;
    const answers: [string, Response][] = [["200", await get(o.fixtures[0])]];
    authState.userId = stranger.ownerId;
    answers.push(["other organisation 404", await get(o.fixtures[0])]);
    answers.push(["unknown id 404", await get(randomUUID())]);
    authState.userId = "";
    answers.push(["signed out 401", await get(o.fixtures[0])]);
    expect(answers.map(([, r]) => r.status)).toEqual([200, 404, 404, 401]);
    let checked = 0;
    for (const [label, r] of answers) {
      expect(r.headers.get("cache-control"), label).toMatch(/(^|,\s*)no-store(\s*,|$)/);
      expect(r.headers.get("cache-control"), label).toMatch(/(^|,\s*)private(\s*,|$)/);
      expect((r.headers.get("vary") ?? "").toLowerCase().split(/\s*,\s*/), label).toEqual(expect.arrayContaining(["cookie", "authorization"]));
      checked++;
    }
    expect(checked).toBe(4);
  });
});
