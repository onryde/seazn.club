// YouTube Connect T8: the three v1 doors over the REAL handlers, the real session door (`requireOrgAuth`'s role lookup runs against real
// org_members rows; only `requireUser`, who is signed in, is faked, as target-route.test.ts does) and the real usecase and database.
//   POST  /orgs/{id}/youtube-connections                      the pick of a multi-channel grant
//   GET   /orgs/{id}/youtube-connections/pending/{pendingId}  the picker's channel list
//   PATCH /orgs/{id}/youtube-connections/{connectionId}       a connection's settings
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
import { buildOpenApiDocument } from "@/server/api-v1/openapi";
import { matchKeyRoute, NEVER_KEY_ROUTES } from "@/server/api-v1/key-scopes";
import { createApiKey } from "@/server/usecases/api-keys";
import { createStreamTarget } from "@/server/usecases/stream-targets";
import { setYoutubeDriverForTest } from "@/server/youtube/driver";
import { revokeConnection } from "@/server/youtube/token-store";
import { GET as LIST } from "../../stream-targets/route";
import { DELETE as REMOVE_TARGET, PATCH as PATCH_TARGET } from "../../stream-targets/[targetId]/route";
import { GET as PENDING } from "../pending/[pendingId]/route";
import { PATCH } from "../[connectionId]/route";
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
