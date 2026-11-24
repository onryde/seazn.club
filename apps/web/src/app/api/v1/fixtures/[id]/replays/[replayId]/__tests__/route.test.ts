// Seazn-hosted video, Task 26: DELETE /api/v1/fixtures/{id}/replays/{replayId} — the organiser deletes one part of a fixture's Seazn
// replay, driven through its REAL handler over a real session (`requireResourceAuth` unmocked; only the cookie door is faked one layer
// down, the organiser video route test's pattern), over replay rows the REAL producers made (_seazn-replay-rig.ts) and the replay fake
// installed as this process's driver. server/video/__tests__/organiser-replays.test.ts proves the delete itself (the row, the
// transaction, the move's cleanup); this file proves what is the ROUTE's own:
//   - the editor deletes: 200 `{ deleted: true }` under the published schema, and the public read no longer lists the part; a second
//     delete answers the same and removes nothing more;
//   - the host's remove throwing still answers 200 (the row is deleted; the move's cleanup retries);
//   - a viewer is 403 and an admin is served; an API key is refused at the DOOR (NEVER_KEY_ROUTES); signed out is 401;
//   - another organisation's member, an unknown and a malformed id are 404, with no id of the part in the body;
//   - every answer is `private, no-store`, varying on Cookie and Authorization, and every status is a documented response.
// ONE SPORT, on purpose (TEST-STRATEGY rule 6): the route reads no sport rule; every rig rides `generic`.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

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

import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { buildOpenApiDocument } from "@/server/api-v1/openapi";
import { SeaznReplayDeleted } from "@/server/api-v1/schemas";
import { rigUser } from "@/server/relay/__tests__/_session-rig";
import { createApiKey } from "@/server/usecases/api-keys";
import { startedDivisionWithFixture } from "@/server/usecases/__tests__/_rig";
import { makeUser, seedOrg } from "@/server/usecases/__tests__/_seed";
import { frozenMemberIds } from "@/server/usecases/entitlement-freeze";
import { createPlaybackTokenCache } from "@/server/video/cf-playback";
import { setReplayDriverForTest } from "@/server/video/replay-driver";
import { FakeReplayHost } from "@/server/video/replay-fake";
import { seaznFixtureVideo } from "@/server/video/seazn-video";
import { movedReplays, replayRowsOf } from "@/server/video/__tests__/_seazn-replay-rig";
import { installSeaznEnv, seaznRigFor } from "@/server/video/__tests__/_seazn-session-rig";
import { DELETE } from "../route";

const HAS_DB = !!process.env.DATABASE_URL;
installSeaznEnv("seazn-replay-delete-route-test");
afterEach(() => setReplayDriverForTest(null));

const BASE = "https://test.local/api/v1";
interface Envelope<T = unknown> {
  ok: boolean;
  data?: T;
  error?: { code?: string; message: string };
}

/** A signed-in OWNER of an org with two started fixtures, one playable replay part on the first (the real producers), and the replay
 *  fake installed as the process's driver — the host the route removes from. */
async function organiser() {
  const { auth: owned } = await seedOrg("pro");
  authState.userId = owned.userId!;
  const started = await startedDivisionWithFixture(owned, { fixtures: 2 });
  const fixtures = started.fixtureIds as [string, string];
  const r = await seaznRigFor({ ...owned, userId: await rigUser() }, fixtures);
  const host = new FakeReplayHost();
  const m = await movedReplays(r, fixtures[0], host);
  setReplayDriverForTest(host);
  return { r, host, m, ownerId: owned.userId!, orgId: owned.orgId, fixtures, part: m.rows[0]! };
}

const del = (fixtureId: string, replayId: string, headers: Record<string, string> = {}) =>
  DELETE(new Request(`${BASE}/fixtures/${fixtureId}/replays/${replayId}`, { method: "DELETE", headers }), { params: Promise.resolve({ id: fixtureId, replayId }) });
async function read<T>(res: Response): Promise<{ status: number; body: Envelope<T>; raw: string }> {
  const raw = await res.clone().text();
  return { status: res.status, body: (await res.json()) as Envelope<T>, raw };
}
const documented = (): string[] =>
  Object.keys(
    (buildOpenApiDocument() as { paths: Record<string, Record<string, { responses: Record<string, unknown> }>> }).paths["/api/v1/fixtures/{id}/replays/{replayId}"]!.delete!.responses,
  );
const stateOf = async (id: string) => (await sql<{ state: string }[]>`select state from fixture_video_replays where id = ${id}`)[0]!.state;
const publicParts = async (o: Awaited<ReturnType<typeof organiser>>) =>
  (await seaznFixtureVideo(o.fixtures[0], new Date(o.m.t0 + 16 * 60_000), { ingest: o.m.replayDeps.ingest, tokenCache: createPlaybackTokenCache(), replay: o.host })).replay.map((p) => p.partNo);
async function member(orgId: string, role: "admin" | "viewer"): Promise<string> {
  const u = await makeUser(role);
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${u.id}, ${role})`;
  return u.id;
}
/** Over-quota seats (doc 10 §2.4): the org's `members.max` overridden to 1, which the owner's own seat fills, so an ADMIN's seat is
 *  read-only until the owner frees seats. Checked with the engine's own `frozenMemberIds`, so a changed freeze rule fails HERE, loudly,
 *  instead of leaving a test that freezes nobody. This is what the door's `write` scope adds over the use case's role check (an admin
 *  is an editor either way). */
async function frozenAdmin(orgId: string): Promise<string> {
  await sql`insert into org_entitlement_overrides (org_id, feature_key, int_value, reason) values (${orgId}, 'members.max', 1, 'frozen seat')
            on conflict (org_id, feature_key) do update set int_value = 1`;
  await invalidateOrgEntitlements(orgId);
  const admin = await member(orgId, "admin");
  expect((await frozenMemberIds(orgId)).has(admin), "PREMISE: the admin's seat is frozen").toBe(true);
  return admin;
}
async function override(orgId: string, key: string, value: boolean) {
  await sql`insert into org_entitlement_overrides (org_id, feature_key, bool_value, reason) values (${orgId}, ${key}, ${value}, 'replay delete route')
            on conflict (org_id, feature_key) do update set bool_value = ${value}`;
  await invalidateOrgEntitlements(orgId);
}

describe.skipIf(!HAS_DB)("DELETE …/fixtures/{id}/replays/{replayId} over HTTP", () => {
  it("EMPTY CASE FIRST: the owner names a part this fixture does not have — the other fixture's, a random id, not a uuid — 404 replay not found, and the part stays", async () => {
    const o = await organiser();
    const remove = vi.spyOn(o.host, "remove");
    const seen: { status: number; message?: string }[] = [];
    for (const [f, id] of [[o.fixtures[1], o.part.id], [o.fixtures[0], randomUUID()], [o.fixtures[0], "p1"]] as const) {
      const { status, body } = await read(await del(f, id));
      seen.push({ status, message: body.error?.message });
    }
    expect(seen).toEqual([0, 1, 2].map(() => ({ status: 404, message: "replay not found" })));
    expect(remove).not.toHaveBeenCalled();
    expect(await stateOf(o.part.id)).toBe("playable");
    expect(documented()).toContain("404");
  });

  it("the owner deletes a playable part: 200 { deleted: true } under the published schema, the copy removed, the public read no longer lists it; a second delete answers the same and removes nothing", async () => {
    const o = await organiser();
    expect(await publicParts(o), "PREMISE: the public read lists the part").toEqual([1]);
    const remove = vi.spyOn(o.host, "remove");
    const first = await read<unknown>(await del(o.fixtures[0], o.part.id));
    expect(first.status).toBe(200);
    expect(first.body.ok).toBe(true);
    expect(first.body.data).toEqual({ deleted: true });
    expect(SeaznReplayDeleted.parse(first.body.data)).toEqual({ deleted: true });
    expect(await stateOf(o.part.id)).toBe("deleted");
    expect(remove.mock.calls).toEqual([[o.part.bunny_video_id]]);
    expect(await publicParts(o)).toEqual([]);
    const again = await read<unknown>(await del(o.fixtures[0], o.part.id));
    expect([again.status, again.body.data]).toEqual([200, { deleted: true }]);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(documented()).toContain("200");
  });

  it("the host's remove throwing still answers 200: the row is deleted and the public read drops it; the move's cleanup removes the copy", async () => {
    const o = await organiser();
    vi.spyOn(o.host, "remove").mockRejectedValueOnce(new Error("replay host remove: HTTP 503"));
    const res = await read(await del(o.fixtures[0], o.part.id));
    expect([res.status, res.body.data]).toEqual([200, { deleted: true }]);
    expect(await stateOf(o.part.id)).toBe("deleted");
    expect(o.host.videoIds(), "PREMISE: the copy survived the refusal").toContain(o.part.bunny_video_id);
    expect(await publicParts(o)).toEqual([]);
    await o.m.move(o.m.t0 + 16 * 60_000);
    expect(o.host.videoIds(), "the cleanup removed it").not.toContain(o.part.bunny_video_id);
    expect((await replayRowsOf(o.fixtures[0]))[0]?.bunny_video_id).toBeNull();
  });

  it("a VIEWER of the fixture's own organisation is 403 and the part stays; an ADMIN deletes it (the positive pair)", async () => {
    const o = await organiser();
    authState.userId = await member(o.orgId, "viewer");
    const refused = await read(await del(o.fixtures[0], o.part.id));
    expect(refused.status).toBe(403);
    expect(await stateOf(o.part.id)).toBe("playable");
    expect(documented()).toContain("403");
    authState.userId = await member(o.orgId, "admin");
    expect((await del(o.fixtures[0], o.part.id)).status).toBe(200);
    expect(await stateOf(o.part.id)).toBe("deleted");
  });

  it("a FROZEN admin seat (over quota, doc 10 §2.4) is read-only: 402 members.max and the part stays — the door's write scope, which the use case's role check does not see; the owner of the same org then deletes it", async () => {
    const o = await organiser();
    authState.userId = await frozenAdmin(o.orgId);
    const refused = await read(await del(o.fixtures[0], o.part.id));
    expect(refused.status).toBe(402);
    expect(refused.body.error?.message).toBe("Plan upgrade required: members.max");
    expect(documented()).toContain("402");
    expect(await stateOf(o.part.id)).toBe("playable");
    expect(o.host.videoIds(), "nothing removed from the host").toContain(o.part.bunny_video_id);
    authState.userId = o.ownerId;
    expect((await del(o.fixtures[0], o.part.id)).status, "the owner (never frozen)").toBe(200);
    expect(await stateOf(o.part.id)).toBe("deleted");
  });

  // Task 33d (T31b review m3): the fixture page hides Delete and Download from a member whose seat is paused — `frozenMemberIds(org)
  // .has(user)`, the page's own read — and the route stays the guard. In ONE over-quota org (members.max 2: the owner's seat plus one,
  // doc 10 §2.4), the seat the page hides the actions from is exactly the seat this route refuses: the paused admin is 402 and the part
  // stays; the admin who keeps the seat and the owner (never paused) are served. Two admins so the hide is shown to be per SEAT, never
  // per org.
  it("Task 33d: in one over-quota org the page's paused seat is exactly the seat the route refuses — the paused admin 402 (the part stays), the admin who keeps a seat and the owner served", async () => {
    const o = await organiser();
    await sql`insert into org_entitlement_overrides (org_id, feature_key, int_value, reason) values (${o.orgId}, 'members.max', 2, 'task 33d')
              on conflict (org_id, feature_key) do update set int_value = 2`;
    await invalidateOrgEntitlements(o.orgId);
    const admins = [await member(o.orgId, "admin"), await member(o.orgId, "admin")];
    const frozen = await frozenMemberIds(o.orgId);
    const paused = (userId: string) => frozen.has(userId);
    // Two seats for an owner and two admins: the owner keeps hers, ONE admin keeps the other, one is paused.
    expect(admins.filter(paused), "PREMISE: exactly one admin is paused").toHaveLength(1);
    expect(paused(o.ownerId), "PREMISE: the owner is never paused").toBe(false);
    const [pausedAdmin] = admins.filter(paused);
    const [seatedAdmin] = admins.filter((a) => !paused(a));
    authState.userId = pausedAdmin!;
    const refused = await read(await del(o.fixtures[0], o.part.id));
    expect([refused.status, refused.body.error?.message], "the paused seat: 402").toEqual([402, "Plan upgrade required: members.max"]);
    expect(await stateOf(o.part.id), "and the part stays").toBe("playable");
    authState.userId = seatedAdmin!;
    expect((await del(o.fixtures[0], o.part.id)).status, "the admin who keeps a seat: served").toBe(200);
    expect(await stateOf(o.part.id)).toBe("deleted");
    authState.userId = o.ownerId;
    expect((await del(o.fixtures[0], o.part.id)).status, "the owner: served (already deleted answers the same)").toBe(200);
  });

  it("ANOTHER organisation's member, an unknown fixture and a malformed one: the same 404 fixture not found, no id of the part in the body, the part untouched", async () => {
    const a = await organiser();
    const b = await organiser();
    authState.userId = b.ownerId;
    const answers = [await del(a.fixtures[0], a.part.id), await del(randomUUID(), a.part.id), await del("f1", a.part.id)];
    const seen: { status: number; message?: string }[] = [];
    for (const res of answers) {
      const r = await read(res);
      expect(r.raw).not.toContain(a.part.id);
      expect(r.raw).not.toContain(a.part.bunny_video_id!);
      seen.push({ status: r.status, message: r.body.error?.message });
    }
    expect(seen).toEqual([0, 1, 2].map(() => ({ status: 404, message: "fixture not found" })));
    expect(await stateOf(a.part.id)).toBe("playable");
  });

  it("signed out is 401; an API key with every scope is refused at the DOOR (NEVER_KEY_ROUTES); the part stays, and the owner's session still deletes it", async () => {
    const o = await organiser();
    authState.userId = "";
    expect((await read(await del(o.fixtures[0], o.part.id))).status).toBe(401);
    expect(documented()).toContain("401");
    await override(o.orgId, "api.access", true);
    await override(o.orgId, "api.write", true);
    const { secret } = await createApiKey({ orgId: o.orgId, via: "session", userId: o.ownerId, role: "owner", keyId: null }, { name: `replay-${randomUUID().slice(0, 6)}`, scopes: ["manage"] });
    const keyed = await read(await del(o.fixtures[0], o.part.id, { authorization: `Bearer ${secret}` }));
    expect(keyed.status).toBe(403);
    expect(keyed.body.error?.message).toMatch(/cannot access this endpoint/);
    expect(await stateOf(o.part.id)).toBe("playable");
    authState.userId = o.ownerId;
    expect((await del(o.fixtures[0], o.part.id)).status).toBe(200);
  });

  it("EVERY answer — the 200 and each refusal — is `private, no-store` and varies on Cookie and Authorization", async () => {
    const o = await organiser();
    const stranger = await organiser();
    const answers: [string, Response][] = [];
    authState.userId = stranger.ownerId;
    answers.push(["other organisation 404", await del(o.fixtures[0], o.part.id)]);
    authState.userId = o.ownerId;
    answers.push(["unknown part 404", await del(o.fixtures[0], randomUUID())]);
    answers.push(["200", await del(o.fixtures[0], o.part.id)]);
    authState.userId = "";
    answers.push(["signed out 401", await del(o.fixtures[0], o.part.id)]);
    expect(answers.map(([, r]) => r.status)).toEqual([404, 404, 200, 401]);
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
