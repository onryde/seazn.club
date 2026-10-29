// YouTube Connect T8: the three v1 doors over the REAL handlers, the real session door (`requireOrgAuth`'s role lookup runs against real
// org_members rows; only `requireUser`, who is signed in, is faked, as target-route.test.ts does) and the real usecase and database.
//   POST  /orgs/{id}/youtube-connections                      the pick of a multi-channel grant
//   GET   /orgs/{id}/youtube-connections/pending/{pendingId}  the picker's channel list
//   PATCH /orgs/{id}/youtube-connections/{connectionId}       a connection's settings
//   DELETE /orgs/{id}/youtube-connections/{connectionId}      Disconnect (T18): revoke, purge, archive
// What this file owns is the WIRING and the ENVELOPES: status, code, who may call, the org in the URL, and that every code the wire
// answers is one the spec documents for that route. The use-case rules are connections.test.ts's.
//
// Sport: not applicable — connecting a YouTube channel is sport-agnostic.
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const authState = vi.hoisted(() => ({ userId: "" }));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requireUser: async () => ({ id: authState.userId }),
    getCurrentUser: async () => ({ id: authState.userId }),
    getActiveOrgId: async () => null,
  };
});
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
  headers: async () => new Headers(),
}));

import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { buildOpenApiDocument } from "@/server/api-v1/openapi";
import { matchKeyRoute, NEVER_KEY_ROUTES } from "@/server/api-v1/key-scopes";
import { createApiKey } from "@/server/usecases/api-keys";
import { streamingPageAccess, streamingPageOffer } from "@/server/stream-panel-context";
import { divisionRig } from "@/server/usecases/__tests__/_rig";
import { createStreamTarget, listStreamTargets } from "@/server/usecases/stream-targets";
import { hasLiveConnection } from "@/server/youtube/connections";
import { setYoutubeDriverForTest } from "@/server/youtube/driver";
import { revokeConnection } from "@/server/youtube/token-store";
import { GET as LIST } from "../../stream-targets/route";
import { DELETE as REMOVE_TARGET, PATCH as PATCH_TARGET } from "../../stream-targets/[targetId]/route";
import { GET as PENDING } from "../pending/[pendingId]/route";
import { DELETE as DISCONNECT, PATCH } from "../[connectionId]/route";
import { POST } from "../route";
import { channelId, colleague, connect, fake, grant, org } from "@/server/youtube/__tests__/_connect-rig";

const HAS_DB = !!process.env.DATABASE_URL;

const KEKS = ["YOUTUBE_TOKEN_KEK", "RELAY_KEK"] as const;
const savedKeks = Object.fromEntries(KEKS.map((k) => [k, process.env[k]]));
beforeAll(() => { for (const k of KEKS) process.env[k] = randomBytes(32).toString("hex"); });
afterAll(() => {
  for (const k of KEKS) {
    if (savedKeks[k] === undefined) delete process.env[k];
    else process.env[k] = savedKeks[k];
  }
});
afterEach(() => setYoutubeDriverForTest(null));

const OTHER_ORG_SENTENCE = "This channel is connected to another organisation on Seazn";

type Envelope = { ok: boolean; data?: Record<string, unknown>; error?: { code?: string; message: string } & Record<string, unknown> };
const json = async (res: Response): Promise<Envelope> => (await res.json()) as Envelope;

const signedInAs = (userId: string | null | undefined) => { authState.userId = userId ?? ""; };
const base = (orgId: string) => `http://localhost/api/v1/orgs/${orgId}/youtube-connections`;
const post = (orgId: string, body: unknown, headers: HeadersInit = {}) =>
  POST(new Request(base(orgId), { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }), { params: Promise.resolve({ id: orgId }) });
const pending = (orgId: string, pendingId: string, headers: HeadersInit = {}) =>
  PENDING(new Request(`${base(orgId)}/pending/${pendingId}`, { headers }), { params: Promise.resolve({ id: orgId, pendingId }) });
const patch = (orgId: string, connectionId: string, body: unknown, headers: HeadersInit = {}) =>
  PATCH(
    new Request(`${base(orgId)}/${connectionId}`, { method: "PATCH", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }),
    { params: Promise.resolve({ id: orgId, connectionId }) },
  );
const disconnectCall = (orgId: string, connectionId: string, headers: HeadersInit = {}) =>
  DISCONNECT(new Request(`${base(orgId)}/${connectionId}`, { method: "DELETE", headers }), { params: Promise.resolve({ id: orgId, connectionId }) });
const list = (orgId: string) => LIST(new Request(`http://localhost/api/v1/orgs/${orgId}/stream-targets`), { params: Promise.resolve({ id: orgId }) });

const connectionRow = async (id: string) =>
  (await sql<{ default_privacy: string; made_for_kids: boolean; status: string }[]>`select default_privacy, made_for_kids, status from org_youtube_connections where id = ${id}`)[0]!;
const connectionCount = async (orgId: string): Promise<number> =>
  (await sql<{ n: number }[]>`select count(*)::int as n from org_youtube_connections where org_id = ${orgId}`)[0]!.n;

// =====================================================================================================================================
describe.skipIf(!HAS_DB)("the pick: GET pending -> POST youtube-connections -> the Streaming page list", () => {
  it("a multi-channel grant: the picker's list is 200, the pick is 201 with the ids, and the stream-targets list then carries the channel's youtube block (no key hint, nothing holding it)", async () => {
    setYoutubeDriverForTest(fake);
    const o = await org();
    signedInAs(o.userId);
    const chs = [{ id: channelId(), title: "First FC" }, { id: channelId(), title: "Second FC" }];
    const p = await grant(o, { channels: chs, privacy: "public" });

    const picker = await pending(o.orgId, p.id);
    expect(picker.status).toBe(200);
    expect(await json(picker)).toMatchObject({ ok: true, data: { channels: chs } });

    const picked = await post(o.orgId, { pendingId: p.id, channelId: chs[1]!.id });
    expect(picked.status).toBe(201);
    const { connectionId, targetId, existing } = (await json(picked)).data as { connectionId: string; targetId: string; existing: boolean };
    expect(connectionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(existing, "the first pick of a channel is a NEW connection").toBe(false);

    const listed = (await json(await list(o.orgId))).data as unknown as Record<string, unknown>[];
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      id: targetId, kind: "youtube", label: "Second FC", keyHint: null, inUse: null, watchUrl: null,
      youtube: { connectionId, channelTitle: "Second FC", privacy: "public", madeForKids: false, status: "connected", liveState: "unknown", termsOutdated: false, openBroadcasts: 0 },
    });
    expect(fake.calls.filter((c) => c.method === "revoke"), "a pick revokes nothing").toEqual([]);

    // The sequence: the pick is spent; the same pick again and the picker are 404.
    expect((await post(o.orgId, { pendingId: p.id, channelId: chs[1]!.id })).status).toBe(404);
    expect((await pending(o.orgId, p.id)).status).toBe(404);
    expect(await connectionCount(o.orgId)).toBe(1);
  });

  it("picking a channel the org ALREADY has is 201 with existing true (same ids, the old settings kept); a channel it does not have is existing false - both off the wire, in one grant", async () => {
    setYoutubeDriverForTest(fake);
    const o = await org();
    signedInAs(o.userId);
    const first = await connect(o, { privacy: "public", madeForKids: true });
    const fresh = { id: channelId(), title: "Fresh FC" };
    const p = await grant(o, { channels: [first.channel, fresh], privacy: "private", madeForKids: false });

    const again = await post(o.orgId, { pendingId: p.id, channelId: first.channel.id });
    expect(again.status).toBe(201);
    expect((await json(again)).data).toEqual({ connectionId: first.connectionId, targetId: first.targetId, existing: true });
    expect(await connectionRow(first.connectionId), "the pick's private/not-for-kids choices did NOT overwrite the connection's").toMatchObject({ default_privacy: "public", made_for_kids: true });
    expect(await connectionCount(o.orgId)).toBe(1);

    const p2 = await grant(o, { channels: [fresh] });
    const created = await post(o.orgId, { pendingId: p2.id, channelId: fresh.id });
    expect(created.status).toBe(201);
    expect(((await json(created)).data as { existing: boolean }).existing).toBe(false);
    expect(await connectionCount(o.orgId)).toBe(2);
  });

  it("the refusals, each with its status and machine code: not offered 422, expired 410, another org 409 YOUTUBE_OTHER_ORG with the spec's sentence — and the grant survives the refused picks", async () => {
    setYoutubeDriverForTest(fake);
    const theirs = await org();
    const held = await connect(theirs);
    const o = await org();
    signedInAs(o.userId);
    const chs = [{ id: channelId(), title: "Free FC" }, held.channel];
    const p = await grant(o, { channels: chs });

    const notOffered = await post(o.orgId, { pendingId: p.id, channelId: channelId() });
    expect(notOffered.status).toBe(422);
    expect((await json(notOffered)).error).toMatchObject({ code: "YOUTUBE_CHANNEL_NOT_OFFERED" });

    const taken = await post(o.orgId, { pendingId: p.id, channelId: held.channel.id });
    expect(taken.status).toBe(409);
    expect((await json(taken)).error).toMatchObject({ code: "YOUTUBE_OTHER_ORG", message: OTHER_ORG_SENTENCE });
    expect(fake.calls.filter((c) => c.method === "revoke")).toEqual([]);
    expect(await connectionCount(o.orgId)).toBe(0);

    // The refused picks consumed nothing: the free channel of the same grant still connects.
    expect((await post(o.orgId, { pendingId: p.id, channelId: chs[0]!.id })).status).toBe(201);

    const old = await grant(o, { startedMinutesAgo: 11 });
    const expired = await post(o.orgId, { pendingId: old.id, channelId: old.channels[0]!.id });
    expect(expired.status).toBe(410);
    expect((await json(expired)).error).toMatchObject({ code: "YOUTUBE_PENDING_EXPIRED" });
    expect((await pending(o.orgId, old.id)).status, "the picker's list is 410 too").toBe(410);
  });

  it("every code the pick answers is documented on that route: the status is a response of the operation and the code is named in its summary (3 codes + 3 statuses)", () => {
    const doc = buildOpenApiDocument() as { paths: Record<string, Record<string, { summary: string; responses: Record<string, unknown> }>> };
    const op = doc.paths["/api/v1/orgs/{id}/youtube-connections"]!.post!;
    let checked = 0;
    for (const [status, code] of [["422", "YOUTUBE_CHANNEL_NOT_OFFERED"], ["409", "YOUTUBE_OTHER_ORG"], ["410", "YOUTUBE_PENDING_EXPIRED"]] as const) {
      expect(op.responses, `the pick documents ${status}`).toHaveProperty(status);
      expect(op.summary, `the pick's summary names ${code}`).toContain(code);
      checked++;
    }
    expect(op.summary, "the pick's summary says what the sentence says").toContain("connected to another organisation on Seazn");
    expect(checked).toBe(3);
    const picker = doc.paths["/api/v1/orgs/{id}/youtube-connections/pending/{pendingId}"]!.get!;
    expect(picker.responses).toHaveProperty("410");
    expect(picker.summary).toContain("YOUTUBE_PENDING_EXPIRED");
  });

  it("bodies: a non-uuid pendingId, a missing channelId, an empty channelId, an extra field and no body are each 400 VALIDATION and write nothing", async () => {
    const o = await org();
    signedInAs(o.userId);
    const p = await grant(o);
    const ch = p.channels[0]!.id;
    const bodies: unknown[] = [{ pendingId: "nope", channelId: ch }, { pendingId: p.id }, { pendingId: p.id, channelId: "" }, { pendingId: p.id, channelId: ch, orgId: o.orgId }, {}];
    let checked = 0;
    for (const b of bodies) {
      const res = await post(o.orgId, b);
      expect(res.status, JSON.stringify(b)).toBe(400);
      expect((await json(res)).error).toMatchObject({ code: "VALIDATION" });
      checked++;
    }
    expect(checked).toBe(5);
    expect(await connectionCount(o.orgId)).toBe(0);
    // The positive pair: the well-formed body of the same grant connects.
    expect((await post(o.orgId, { pendingId: p.id, channelId: ch })).status).toBe(201);
  });
});

// =====================================================================================================================================
describe.skipIf(!HAS_DB)("who may call, and whose rows they reach", () => {
  it("a viewer and a stranger cannot pick, read the picker or change settings; the owner can", async () => {
    const o = await org();
    const viewer = await colleague(o, "viewer");
    const stranger = await org();
    const c = await connect(o);
    const p = await grant(o);
    const calls: [string, () => Promise<Response>][] = [
      ["POST", () => post(o.orgId, { pendingId: p.id, channelId: p.channels[0]!.id })],
      ["GET pending", () => pending(o.orgId, p.id)],
      ["PATCH", () => patch(o.orgId, c.connectionId, { privacy: "public" })],
    ];
    let checked = 0;
    for (const [who, userId, expected] of [["viewer", viewer.userId, 403], ["stranger", stranger.userId, 401]] as const) {
      signedInAs(userId);
      for (const [door, call] of calls) {
        const res = await call();
        expect(res.status, `${who} ${door}`).toBe(expected);
        checked++;
      }
    }
    expect(checked, "anti-vacuity: refusals checked").toBe(6);
    expect(await connectionCount(o.orgId), "nothing was connected").toBe(1);
    expect((await connectionRow(c.connectionId)).default_privacy, "nothing was changed").toBe("unlisted");
    signedInAs(o.userId);
    expect((await patch(o.orgId, c.connectionId, { privacy: "public" })).status).toBe(200);
  });

  it("the three doors are explicit NEVER_KEY_ROUTES entries (default-deny alone would let a later, broader key rule shadow them), and no key rule matches any of them", () => {
    const orgId = "00000000-0000-4000-8000-000000000001";
    const doors = [
      ["POST", "/orgs/:id/youtube-connections", `/orgs/${orgId}/youtube-connections`],
      ["GET", "/orgs/:id/youtube-connections/pending/:pendingId", `/orgs/${orgId}/youtube-connections/pending/${orgId}`],
      ["PATCH", "/orgs/:id/youtube-connections/:connectionId", `/orgs/${orgId}/youtube-connections/${orgId}`],
    ] as const;
    for (const [method, pattern, path] of doors) {
      expect(NEVER_KEY_ROUTES, `${method} ${pattern}`).toContain(`${method} ${pattern}`);
      expect(matchKeyRoute(method, path), `${method} ${path}`).toBeNull();
    }
    expect(doors.length, "anti-vacuity: doors checked").toBe(3);
  });

  it("an API key — read, score or manage — is refused at ALL THREE doors (403, the route ban) and changes nothing", async () => {
    const o = await org();
    signedInAs(o.userId);
    for (const feature of ["api.access", "api.write"]) {
      await sql`
        insert into org_entitlement_overrides (org_id, feature_key, bool_value, reason)
        values (${o.orgId}, ${feature}, true, 'test')
        on conflict (org_id, feature_key) do update set bool_value = true`;
    }
    const c = await connect(o);
    const p = await grant(o);
    let doors = 0;
    for (const scope of ["read", "score", "manage"] as const) {
      const { secret } = await createApiKey(o.auth, { name: `key-${scope}`, scopes: [scope] });
      const bearer = { authorization: `Bearer ${secret}` };
      for (const [door, res] of [
        ["POST", await post(o.orgId, { pendingId: p.id, channelId: p.channels[0]!.id }, bearer)],
        ["GET pending", await pending(o.orgId, p.id, bearer)],
        ["PATCH", await patch(o.orgId, c.connectionId, { privacy: "public" }, bearer)],
      ] as const) {
        expect(res.status, `${scope} ${door}`).toBe(403);
        expect(((await json(res)).error?.message ?? ""), `${scope} ${door}`).toMatch(/^API keys cannot access this endpoint/);
        doors++;
      }
    }
    expect(doors, "anti-vacuity: key refusals checked").toBe(9);
    expect(await connectionCount(o.orgId)).toBe(1);
    expect((await connectionRow(c.connectionId)).default_privacy).toBe("unlisted");
  });

  it("org B cannot read the picker of, pick from, or change a connection of org A — 404 each, never a 403/409 that confirms the row — and org A's rows are unchanged", async () => {
    setYoutubeDriverForTest(fake);
    const a = await org();
    const b = await org();
    const c = await connect(a);
    const p = await grant(a);
    // One person who is a member of BOTH orgs: only the org in the URL can tell A's rows from B's.
    await sql`insert into org_members (org_id, user_id, role) values (${b.orgId}, ${a.userId}, 'owner')`;
    signedInAs(a.userId);
    const res = {
      picker: await pending(b.orgId, p.id),
      pick: await post(b.orgId, { pendingId: p.id, channelId: p.channels[0]!.id }),
      patch: await patch(b.orgId, c.connectionId, { privacy: "public", madeForKids: true }),
    };
    for (const [door, r] of Object.entries(res)) expect(r.status, door).toBe(404);
    expect(await connectionCount(b.orgId)).toBe(0);
    expect(await connectionRow(c.connectionId)).toMatchObject({ default_privacy: "unlisted", made_for_kids: false });
    // The positive pair: the same person addressing A's own URL succeeds on all three.
    expect((await pending(a.orgId, p.id)).status).toBe(200);
    expect((await patch(a.orgId, c.connectionId, { privacy: "public" })).status).toBe(200);
    expect((await post(a.orgId, { pendingId: p.id, channelId: p.channels[0]!.id })).status).toBe(201);
  });

  it("another person's pending grant, in the SAME org, is 404 at the picker and the pick", async () => {
    setYoutubeDriverForTest(fake);
    const o = await org();
    const mate = await colleague(o);
    const p = await grant(o);
    signedInAs(mate.userId);
    expect((await pending(o.orgId, p.id)).status).toBe(404);
    expect((await post(o.orgId, { pendingId: p.id, channelId: p.channels[0]!.id })).status).toBe(404);
    expect(await connectionCount(o.orgId)).toBe(0);
    signedInAs(o.userId);
    expect((await pending(o.orgId, p.id)).status).toBe(200);
  });

  it("malformed ids in the path are 404 (the house assertUuid), and an unknown connection is 404", async () => {
    const o = await org();
    signedInAs(o.userId);
    expect((await pending(o.orgId, "not-a-uuid")).status).toBe(404);
    expect((await patch(o.orgId, "not-a-uuid", { privacy: "public" })).status).toBe(404);
    expect((await patch(o.orgId, randomUUID(), { privacy: "public" })).status).toBe(404);
    expect((await pending("not-a-uuid", randomUUID())).status).toBe(404);
  });
});

// =====================================================================================================================================
describe.skipIf(!HAS_DB)("PATCH a connection's settings", () => {
  it("200 with the connection's view; the change is stored; the list shows it", async () => {
    const o = await org();
    signedInAs(o.userId);
    const rovers = { id: channelId(), title: "Rovers TV" };
    const c = await connect(o, { channels: [rovers] });
    const res = await patch(o.orgId, c.connectionId, { privacy: "private", madeForKids: true });
    expect(res.status).toBe(200);
    expect((await json(res)).data).toEqual({
      connectionId: c.connectionId, channelId: rovers.id, channelTitle: "Rovers TV", privacy: "private", madeForKids: true, status: "connected",
      liveState: "unknown", termsOutdated: false, openBroadcasts: 0,
    });
    expect(await connectionRow(c.connectionId)).toMatchObject({ default_privacy: "private", made_for_kids: true });
    const listed = (await json(await list(o.orgId))).data as unknown as { youtube: { privacy: string } | null }[];
    expect(listed[0]!.youtube!.privacy).toBe("private");
    // A second identical call is the same 200.
    expect((await patch(o.orgId, c.connectionId, { privacy: "private", madeForKids: true })).status).toBe(200);
  });

  it("an empty body, an unknown privacy, a consent of false, a non-boolean made-for-kids and an unknown field are each 400 VALIDATION and change nothing (6 bodies)", async () => {
    const o = await org();
    signedInAs(o.userId);
    const c = await connect(o);
    const bodies: unknown[] = [{}, { privacy: "everyone" }, { consent: false }, { madeForKids: "yes" }, { channelTitle: "Hacked" }, { privacy: "public", consent: false }];
    let checked = 0;
    for (const b of bodies) {
      const res = await patch(o.orgId, c.connectionId, b);
      expect(res.status, JSON.stringify(b)).toBe(400);
      expect((await json(res)).error).toMatchObject({ code: "VALIDATION" });
      checked++;
    }
    expect(checked).toBe(6);
    expect(await connectionRow(c.connectionId)).toMatchObject({ default_privacy: "unlisted", made_for_kids: false });
  });

  it("a disconnected connection is 404", async () => {
    const o = await org();
    signedInAs(o.userId);
    const c = await connect(o);
    await sql.begin((tx) => revokeConnection(tx, o.orgId, c.connectionId));
    expect((await patch(o.orgId, c.connectionId, { privacy: "public" })).status).toBe(404);
  });
});

// =====================================================================================================================================
describe.skipIf(!HAS_DB)("the connected channel's destination row on the stream-target doors (the 422 the spec now documents)", () => {
  it("Rename, Replace key and Remove of an API-backed destination are 422 YOUTUBE_USE_DISCONNECT on the wire, where the pasted row beside it still renames; DELETE's spec documents that 422", async () => {
    const o = await org();
    signedInAs(o.userId);
    const c = await connect(o);
    const pasted = await createStreamTarget(o.auth, o.orgId, { kind: "youtube", label: "Court 1", streamKey: `key-${randomBytes(12).toString("hex")}` });
    const idCtx = (targetId: string) => ({ params: Promise.resolve({ id: o.orgId, targetId }) });
    const url = (targetId: string) => `http://localhost/api/v1/orgs/${o.orgId}/stream-targets/${targetId}`;
    const patchBody = (body: unknown) => new Request(url(c.targetId), { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

    const refusals = [
      await REMOVE_TARGET(new Request(url(c.targetId), { method: "DELETE" }), idCtx(c.targetId)),
      await PATCH_TARGET(patchBody({ label: "Renamed" }), idCtx(c.targetId)),
      await PATCH_TARGET(patchBody({ streamKey: `key-${randomBytes(12).toString("hex")}` }), idCtx(c.targetId)),
    ];
    for (const res of refusals) {
      expect(res.status).toBe(422);
      expect((await json(res)).error).toMatchObject({ code: "YOUTUBE_USE_DISCONNECT" });
    }
    expect(refusals).toHaveLength(3);
    // Still listed, still the channel's name; the pasted row is unaffected.
    expect((await json(await list(o.orgId))).data).toEqual(expect.arrayContaining([expect.objectContaining({ id: c.targetId, label: "Solo United" })]));
    const renamed = await PATCH_TARGET(
      new Request(url(pasted.id), { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ label: "Court 1 (renamed)" }) }),
      idCtx(pasted.id),
    );
    expect(renamed.status).toBe(200);

    const doc = buildOpenApiDocument() as {
      paths: Record<string, Record<string, { responses: Record<string, { content: { "application/json": { schema: { properties: { error: { properties: { code: { description?: string } } } } } } } }> }>>;
    };
    const del422 = doc.paths["/api/v1/orgs/{id}/stream-targets/{targetId}"]!.delete!.responses["422"]!;
    expect(del422.content["application/json"].schema.properties.error.properties.code.description).toContain("YOUTUBE_USE_DISCONNECT");
  });
});

// =====================================================================================================================================
describe.skipIf(!HAS_DB)("DELETE — Disconnect a channel (T18)", () => {
  const seed = (c: { token: string; channel: { id: string; title: string } }) =>
    fake.seedGrant({ refreshToken: c.token, channelId: c.channel.id, channelTitle: c.channel.title });
  const statusOf = async (id: string) => (await sql<{ status: string }[]>`select status from org_youtube_connections where id = ${id}`)[0]!.status;

  it("200 with what it did; the channel leaves the Streaming list; a second DELETE is 404 and revokes nothing more (the sequence)", async () => {
    setYoutubeDriverForTest(fake);
    const o = await org();
    signedInAs(o.userId);
    const c = await connect(o);
    seed(c);
    expect(((await json(await list(o.orgId))).data as unknown as unknown[]).length, "premise: listed").toBe(1);
    const revokes = () => fake.calls.filter((x) => x.method === "revoke").length;
    const before = revokes();

    const res = await disconnectCall(o.orgId, c.connectionId);
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.ok).toBe(true);
    expect(body.data).toEqual({ revokedAtGoogle: true, keysDeleted: 0, purged: { broadcasts: 0, streamUrlsCleared: 0 } });
    expect(revokes() - before, "revoked at Google once").toBe(1);
    expect(await statusOf(c.connectionId)).toBe("revoked");
    expect(((await json(await list(o.orgId))).data as unknown as unknown[]).length, "no longer listed").toBe(0);

    const again = await disconnectCall(o.orgId, c.connectionId);
    expect(again.status).toBe(404);
    expect(revokes() - before, "no second revoke").toBe(1);
  });

  it("an org that has LOST streaming (no overlay, no relay: its Streaming page is a 404) can still disconnect - the policy's door does not close with the plan", async () => {
    setYoutubeDriverForTest(fake);
    const o = await org();
    signedInAs(o.userId);
    const c = await connect(o);
    seed(c);
    for (const feature of ["streaming.overlay", "streaming.relay"]) {
      await sql`insert into org_entitlement_overrides (org_id, feature_key, bool_value, reason)
                values (${o.orgId}, ${feature}, false, 't18 route') on conflict (org_id, feature_key) do update set bool_value = false`;
    }
    await invalidateOrgEntitlements(o.orgId);
    expect(await streamingPageOffer(o.orgId), "premise: the org is not offered Streaming").toBe("not_entitled");

    expect((await disconnectCall(o.orgId, c.connectionId)).status).toBe(200);
    expect(await statusOf(c.connectionId)).toBe("revoked");
  });

  it("409 YOUTUBE_IN_USE on the wire when a match is using the channel - the envelope carries the code and the plain sentence, and nothing changed", async () => {
    setYoutubeDriverForTest(fake);
    const o = await org();
    signedInAs(o.userId);
    const c = await connect(o);
    seed(c);
    const d = await divisionRig(o.auth, { entrants: 2 });
    // SQL: a `bound` broadcast on a fixture with no session yet (the shape of Go live mid-admission). The end rule says "not due".
    await sql`insert into youtube_broadcasts (org_id, connection_id, fixture_id, title, privacy, state)
              values (${o.orgId}, ${c.connectionId}, ${d.fixtureIds[0]!}, 't18 route', 'unlisted', 'bound')`;
    const calls = fake.calls.length;

    const res = await disconnectCall(o.orgId, c.connectionId);
    expect(res.status).toBe(409);
    expect((await json(res)).error).toMatchObject({ code: "YOUTUBE_IN_USE", message: "A match is using this channel" });
    expect(await statusOf(c.connectionId), "nothing changed").toBe("connected");
    expect(fake.calls.length, "YouTube was asked nothing").toBe(calls);
    // the positive pair: with the broadcast gone the same call succeeds
    await sql`delete from youtube_broadcasts where connection_id = ${c.connectionId}`;
    expect((await disconnectCall(o.orgId, c.connectionId)).status).toBe(200);
  });

  it("a viewer is 403 and a stranger 401, each leaving the connection connected; an admin (an editor) and the owner can (anti-vacuity: 2 refusals + 2 successes)", async () => {
    setYoutubeDriverForTest(fake);
    const o = await org();
    const viewer = await colleague(o, "viewer");
    const admin = await colleague(o, "admin");
    const stranger = await org();
    const a = await connect(o);
    const b = await connect(o);
    seed(a);
    seed(b);
    let refused = 0;
    for (const [who, userId, expected] of [["viewer", viewer.userId, 403], ["stranger", stranger.userId, 401]] as const) {
      signedInAs(userId);
      expect((await disconnectCall(o.orgId, a.connectionId)).status, who).toBe(expected);
      refused++;
    }
    expect(await statusOf(a.connectionId), "nothing was disconnected").toBe("connected");
    let allowed = 0;
    for (const [userId, c] of [[admin.userId, a], [o.userId, b]] as const) {
      signedInAs(userId);
      expect((await disconnectCall(o.orgId, c.connectionId)).status).toBe(200);
      allowed++;
    }
    expect([refused, allowed], "anti-vacuity").toEqual([2, 2]);
  });

  it("the door is an explicit NEVER_KEY_ROUTES entry with no key rule matching it, and an API key — read, score or manage — is refused 403 and changes nothing (anti-vacuity: 3 keys)", async () => {
    const orgId = "00000000-0000-4000-8000-000000000001";
    expect(NEVER_KEY_ROUTES).toContain("DELETE /orgs/:id/youtube-connections/:connectionId");
    expect(matchKeyRoute("DELETE", `/orgs/${orgId}/youtube-connections/${orgId}`)).toBeNull();

    setYoutubeDriverForTest(fake);
    const o = await org();
    signedInAs(o.userId);
    for (const feature of ["api.access", "api.write"]) {
      await sql`
        insert into org_entitlement_overrides (org_id, feature_key, bool_value, reason)
        values (${o.orgId}, ${feature}, true, 'test')
        on conflict (org_id, feature_key) do update set bool_value = true`;
    }
    const c = await connect(o);
    seed(c);
    let refused = 0;
    for (const scope of ["read", "score", "manage"] as const) {
      const { secret } = await createApiKey(o.auth, { name: `key-${scope}`, scopes: [scope] });
      const res = await disconnectCall(o.orgId, c.connectionId, { authorization: `Bearer ${secret}` });
      expect(res.status, scope).toBe(403);
      expect((await json(res)).error?.message ?? "", scope).toMatch(/^API keys cannot access this endpoint/);
      refused++;
    }
    expect(refused).toBe(3);
    expect(await statusOf(c.connectionId)).toBe("connected");
  });

  it("org B cannot disconnect org A's connection - 404, never a 403/409 that confirms the row - and malformed or unknown ids are 404 (A's connection is unchanged, then A's own URL works)", async () => {
    setYoutubeDriverForTest(fake);
    const a = await org();
    const b = await org();
    const c = await connect(a);
    seed(c);
    await sql`insert into org_members (org_id, user_id, role) values (${b.orgId}, ${a.userId}, 'owner')`;   // one person in BOTH orgs
    signedInAs(a.userId);
    expect((await disconnectCall(b.orgId, c.connectionId)).status).toBe(404);
    expect((await disconnectCall(a.orgId, randomUUID())).status, "unknown").toBe(404);
    expect((await disconnectCall(a.orgId, "not-a-uuid")).status, "malformed connection id").toBe(404);
    expect((await disconnectCall("not-a-uuid", c.connectionId)).status, "malformed org id").toBe(404);
    expect(await statusOf(c.connectionId)).toBe("connected");
    expect((await disconnectCall(a.orgId, c.connectionId)).status).toBe(200);
  });

  it("the spec documents the door: DELETE is a response-typed operation whose 403, 404 and 409 are responses and whose summary names YOUTUBE_IN_USE, the revoke and the purge (4 facts)", () => {
    const doc = buildOpenApiDocument() as {
      paths: Record<string, Record<string, { summary: string; responses: Record<string, { content?: Record<string, { schema?: { properties?: Record<string, unknown> } }> }> }>>;
    };
    const op = doc.paths["/api/v1/orgs/{id}/youtube-connections/{connectionId}"]!.delete!;
    expect(op, "DELETE is documented").toBeDefined();
    let checked = 0;
    for (const status of ["403", "404", "409"]) { expect(op.responses, `DELETE documents ${status}`).toHaveProperty(status); checked++; }
    expect(op.summary).toContain("YOUTUBE_IN_USE"); checked++;
    expect(op.summary.toLowerCase()).toContain("revoke"); checked++;
    expect(op.summary.toLowerCase()).toContain("purge"); checked++;
    const ok = op.responses["200"]!.content!["application/json"]!.schema!;
    const dataProps = Object.keys(((ok.properties!.data as { properties: Record<string, unknown> }).properties));
    expect(dataProps.sort()).toEqual(["keysDeleted", "purged", "revokedAtGoogle"]);
    expect(checked).toBe(6);
  });
});

// =====================================================================================================================================
// The disconnect-only Streaming page (T18; DP III): the predicate, the listing and the nav's question, over the REAL database.
describe.skipIf(!HAS_DB)("the disconnect-only Streaming page (T18) - the real predicate and listing", () => {
  const seed = (c: { token: string; channel: { id: string; title: string } }) =>
    fake.seedGrant({ refreshToken: c.token, channelId: c.channel.id, channelTitle: c.channel.title });
  const loseStreaming = async (orgId: string) => {
    for (const feature of ["streaming.overlay", "streaming.relay"]) {
      await sql`insert into org_entitlement_overrides (org_id, feature_key, bool_value, reason)
                values (${orgId}, ${feature}, false, 't18 access') on conflict (org_id, feature_key) do update set bool_value = false`;
    }
    await invalidateOrgEntitlements(orgId);
  };

  it("hasLiveConnection: false for an org that never connected, true with a connection (any live status), false again once it is disconnected - and another org's connection never counts (the sequence)", async () => {
    setYoutubeDriverForTest(fake);
    const o = await org();
    const other = await org();
    signedInAs(o.userId);
    expect(await hasLiveConnection(o.orgId), "the empty case").toBe(false);
    const oc = await connect(other);
    seed(oc);
    expect(await hasLiveConnection(o.orgId), "another org's connection is not ours").toBe(false);
    const c = await connect(o);
    seed(c);
    expect(await hasLiveConnection(o.orgId)).toBe(true);
    await sql`update org_youtube_connections set status = 'reconnect_needed' where id = ${c.connectionId}`;
    expect(await hasLiveConnection(o.orgId), "a connection that needs a reconnect is still live (it can be disconnected)").toBe(true);
    await sql`update org_youtube_connections set status = 'connected' where id = ${c.connectionId}`;
    expect((await disconnectCall(o.orgId, c.connectionId)).status).toBe(200);
    expect(await hasLiveConnection(o.orgId), "disconnected: nothing left to disconnect").toBe(false);
    expect(await hasLiveConnection(other.orgId), "the other org is unaffected").toBe(true);
  });

  it("streamingPageAccess: an offered org gets the full page; one that lost streaming gets the disconnect-only page ONLY as an editor with a connection; everyone else keeps the 404 (anti-vacuity: 7 cells)", async () => {
    setYoutubeDriverForTest(fake);
    const o = await org();
    const c = await connect(o);
    seed(c);
    let cells = 0;
    expect(await streamingPageOffer(o.orgId), "premise: offered").toBe("offered");
    for (const canEdit of [true, false]) { expect(await streamingPageAccess(o.orgId, canEdit), `offered, canEdit=${canEdit}`).toBe("full"); cells++; }

    await loseStreaming(o.orgId);
    expect(await streamingPageOffer(o.orgId), "premise: the org lost streaming").toBe("not_entitled");
    expect(await streamingPageAccess(o.orgId, true), "editor + connection").toBe("disconnect_only"); cells++;
    expect(await streamingPageAccess(o.orgId, false), "a viewer cannot disconnect").toBe("none"); cells++;

    signedInAs(o.userId);
    expect((await disconnectCall(o.orgId, c.connectionId)).status).toBe(200);
    expect(await streamingPageAccess(o.orgId, true), "editor, nothing left to disconnect").toBe("none"); cells++;

    const bare = await org();
    await loseStreaming(bare.orgId);
    expect(await streamingPageAccess(bare.orgId, true), "editor, never connected").toBe("none"); cells++;
    expect(await streamingPageAccess(bare.orgId, false)).toBe("none"); cells++;
    expect(cells).toBe(7);
  });

  it("listStreamTargets({ channelsOnly }) lists the connected channels and NOTHING else: no pasted destination, no key hint read, no holder - and the unrestricted list still lists both", async () => {
    setYoutubeDriverForTest(fake);
    const o = await org();
    signedInAs(o.userId);
    const c = await connect(o);
    seed(c);
    await createStreamTarget(o.auth, o.orgId, { kind: "youtube", label: "Pasted club key", streamKey: `pk-${randomUUID()}` });
    const full = await listStreamTargets(o.auth, o.orgId);
    expect(full.map((t) => t.youtube === null ? "pasted" : "channel").sort(), "premise: both kinds exist").toEqual(["channel", "pasted"]);
    expect(full.find((t) => t.youtube === null)!.keyHint, "premise: the full list reads the pasted key's hint").not.toBeNull();

    const channels = await listStreamTargets(o.auth, o.orgId, { channelsOnly: true });
    expect(channels).toHaveLength(1);
    expect(channels[0]!.youtube).toMatchObject({ connectionId: c.connectionId, status: "connected" });
    expect(channels[0]!.keyHint, "no key hint is read").toBeNull();
    expect(channels[0]!.inUse).toBeNull();
    expect(channels.some((t) => t.label === "Pasted club key"), "no pasted destination").toBe(false);

    // "No pasted key is read" is observable: with the sealing KEK gone, the full list cannot open the pasted key and fails loudly, while
    // the channels-only list - the page an org keeps after a downgrade - does not touch it and still answers.
    const kek = process.env.RELAY_KEK;
    delete process.env.RELAY_KEK;
    try {
      await expect(listStreamTargets(o.auth, o.orgId), "premise: the full list needs the KEK").rejects.toThrow();
      expect((await listStreamTargets(o.auth, o.orgId, { channelsOnly: true })).map((t) => t.youtube?.connectionId)).toEqual([c.connectionId]);
    } finally {
      process.env.RELAY_KEK = kek;
    }

    // The empty case, and the sequence: after a disconnect the channel is gone from this list too.
    expect((await disconnectCall(o.orgId, c.connectionId)).status).toBe(200);
    expect(await listStreamTargets(o.auth, o.orgId, { channelsOnly: true }), "nothing left").toEqual([]);
    expect((await listStreamTargets(o.auth, o.orgId)).map((t) => t.label), "the pasted destination is untouched").toEqual(["Pasted club key"]);
  });
});
