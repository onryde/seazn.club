// Destinations (design §6.1 org_stream_targets). The list NEVER carries the
// key; readTargetSecret (server/relay/secret-columns.ts) returns it decrypted,
// for its own org only (lane C ruling A4: three arguments), for the one request
// that hands it to the ingest port. The stored envelope is not the plaintext
// and does not contain it (smoke repeats this over HTTP). That byte read goes
// through _session-rig.ts's `targetEnvelope`: this file may not name the sealed
// column (ruling A9 — enc-boundary.test.ts keeps NO `__tests__` exemption).
//
// Sport-agnostic on purpose (TEST-STRATEGY rule 6): a destination is an ORG row
// with no sport, division or fixture; seedOrg's `generic` sport is never read
// here, so a registry sweep would run identical tests. The "another sport"
// question becomes "another destination KIND", swept below over the declared enum.
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// The route test drives the REAL handler over the REAL session door: only
// `requireUser` (who is signed in) is faked; `requireOrgAuth`'s own role lookup
// runs against a real `org_members` row (event-import-route.test.ts harness).
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
import { StreamTarget, StreamTargetKind } from "@/server/api-v1/schemas";
import { readTargetSecret } from "@/server/relay/secret-columns";
import { targetEnvelope } from "@/server/relay/__tests__/_session-rig";
import { GET, POST } from "@/app/api/v1/orgs/[id]/stream-targets/route";
import { createApiKey } from "../api-keys";
import { seedOrg } from "./_rig";
import { makeUser, seedOrg as seedSignedInOrg } from "./_seed";
import { createStreamTarget, listStreamTargets } from "../stream-targets";

const HAS_DB = !!process.env.DATABASE_URL;

// A KEK of this file's own (secret-columns.test.ts precedent): the developer's is put back afterwards, or removed
// when there was none — never assigned `undefined`, which Node stores as the string "undefined". Never printed.
const savedKek = process.env.RELAY_KEK;
beforeAll(() => { process.env.RELAY_KEK = randomBytes(32).toString("hex"); });
afterAll(async () => {
  if (savedKek === undefined) delete process.env.RELAY_KEK;
  else process.env.RELAY_KEK = savedKek;
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

/** A stream key nobody else holds, so a substring scan cannot match by accident. */
const key = (): string => "sk-" + randomBytes(24).toString("hex");

/** crypto.ts's envelope header (1 + IV + wrapped DEK + tag + IV + tag = 89 bytes): anything not longer than it
 *  carries no ciphertext at all, and an empty envelope "holds no plaintext" vacuously. */
const ENVELOPE_HEADER = 89;

describe.skipIf(!HAS_DB)("stream targets — the usecase", () => {
  it("create → list shows kind/label/watchUrl and never the key; the secret reads back decrypted for its org; the stored envelope holds neither the key nor the url", async () => {
    const { auth } = await seedOrg();
    const streamKey = key();
    const rtmpUrl = "rtmps://a.rtmps.youtube.com/live2";
    const made = await createStreamTarget(auth, auth.orgId, {
      kind: "youtube", label: "Club channel", rtmpUrl, streamKey,
      watchUrl: "https://www.youtube.com/watch?v=abc123",
    });
    expect(made).toMatchObject({ kind: "youtube", label: "Club channel", watchUrl: "https://www.youtube.com/watch?v=abc123" });
    // Exactly the wire shape (the schema's own keys) — there is no field a key could ride in, not merely an absent value.
    expect(Object.keys(made).sort()).toEqual(Object.keys(StreamTarget.shape).sort());
    expect(StreamTarget.parse(made)).toEqual(made);
    expect(JSON.stringify(made)).not.toContain(streamKey);
    const list = await listStreamTargets(auth, auth.orgId);
    expect(list.map((t) => t.id)).toEqual([made.id]);
    expect(JSON.stringify(list)).not.toContain(streamKey);
    // At rest FIRST — before any decrypting read, so a plaintext write reds HERE and not on the read's own throw.
    const envelope = await targetEnvelope(made.id);
    expect(envelope.length).toBeGreaterThan(ENVELOPE_HEADER);
    expect(envelope.includes(Buffer.from(streamKey, "utf8")), "the envelope holds the stream key").toBe(false);
    expect(envelope.includes(Buffer.from(rtmpUrl, "utf8")), "the envelope holds the ingest url").toBe(false);
    // The negative's positive pair: the key IS stored — the one reader hands it back.
    const secret = await sql.begin((tx) => readTargetSecret(tx, auth.orgId, made.id));
    expect(secret).toEqual({ url: rtmpUrl, streamKey });
    // createdAt is the row's own timestamp, not the clock of the caller.
    const [row] = await sql<{ created_at: Date }[]>`select created_at from org_stream_targets where id = ${made.id}`;
    expect(made.createdAt).toBe(row!.created_at.toISOString());
  });

  it("a watchUrl off the R16 allowlist is refused (422) and writes nothing; omitted and blank both store null — the VALIDATED value, never the raw one", async () => {
    const { auth } = await seedOrg();
    const base = { kind: "custom_rtmp" as const, label: "x", rtmpUrl: "rtmp://live.restream.io/live", streamKey: "k" };
    await expect(createStreamTarget(auth, auth.orgId, { ...base, watchUrl: "https://evil.example/watch" }))
      .rejects.toMatchObject({ status: 422 });
    // A lookalike that CONTAINS an allowed host is not one (exact-host rule, lib/stream-url.ts).
    await expect(createStreamTarget(auth, auth.orgId, { ...base, watchUrl: "https://www.youtube.com.evil.example/watch" }))
      .rejects.toMatchObject({ status: 422 });
    expect(await listStreamTargets(auth, auth.orgId)).toEqual([]);
    const omitted = await createStreamTarget(auth, auth.orgId, { ...base, label: "omitted" });
    expect(omitted.watchUrl).toBeNull();
    // "" is what the allowlist NORMALISES to null. Storing the raw "" instead would break V410's
    // `watch_url like 'https://%'` — so this case differs between the validated and the raw value.
    const blank = await createStreamTarget(auth, auth.orgId, { ...base, label: "blank", watchUrl: "" });
    expect(blank.watchUrl).toBeNull();
    const stored = await sql<{ id: string; watch_url: string | null }[]>`
      select id, watch_url from org_stream_targets where org_id = ${auth.orgId} order by created_at`;
    expect(stored).toEqual([{ id: omitted.id, watch_url: null }, { id: blank.id, watch_url: null }]);
  });

  it("A18: an rtmpUrl off the destination allowlist is refused 422 DESTINATION_NOT_ALLOWED + its rule, BEFORE anything is sealed or written — twice over, then an allowlisted one lands", async () => {
    const { auth } = await seedOrg();
    const streamKey = key();
    // Expected rules are A18's categories, typed here — not read back from the validator.
    const cases: [string, string][] = [
      ["rtmp://localhost/live", "host"],
      ["rtmp://127.0.0.1/live", "ip_literal"],
      ["rtmp://[::1]/live", "ip_literal"],
      ["rtmp://top1.nearest.of.seazn-relay.internal/live", "host"],
      ["rtmp://seazn-relay.flycast/live", "host"],
      ["rtmps://evilyoutube.com/live2", "host"],
      ["rtmps://user:pw@a.rtmps.youtube.com/live2", "userinfo"],
      ["http://a.rtmp.youtube.com/live2", "scheme"],
      ["rtmps://a.rtmps.youtube.com:1936/live2", "port"],
      ["rtmps://a.rtmps.youtube.com", "path"],
      ["", "scheme"],
    ];
    let checked = 0;
    // Second call: the same refusal twice is refused twice — no state makes the second one pass.
    for (const round of [1, 2]) {
      for (const [rtmpUrl, rule] of cases) {
        const err = await createStreamTarget(auth, auth.orgId, { kind: "custom_rtmp", label: `r${round}`, rtmpUrl, streamKey }).then(
          () => null,
          (e: unknown) => e as { status?: number; code?: string; extra?: Record<string, unknown>; message?: string },
        );
        expect(err, `${round} ${rtmpUrl}`).toMatchObject({ status: 422, code: "DESTINATION_NOT_ALLOWED", extra: { rule } });
        // The message is a sentence about the rule — never the URL, which can carry the key in its path.
        if (rtmpUrl !== "") expect(err!.message).not.toContain(rtmpUrl);
        expect(err!.message).not.toContain(streamKey);
        checked++;
      }
    }
    expect(checked).toBe(22);
    const [row] = await sql<{ n: number }[]>`select count(*)::int as n from org_stream_targets where org_id = ${auth.orgId}`;
    expect(row!.n).toBe(0);
    // The positive pair: the same org, key and door accept a listed host.
    const made = await createStreamTarget(auth, auth.orgId, { kind: "youtube", label: "ok", rtmpUrl: "rtmp://a.rtmp.youtube.com/live2", streamKey });
    expect((await listStreamTargets(auth, auth.orgId)).map((t) => t.id)).toEqual([made.id]);
  });

  it("tenancy: B's list never shows A's target, and a caller authenticated for B cannot list or create under A's id (404, nothing written anywhere)", async () => {
    const a = await seedOrg();
    const b = await seedOrg();
    expect(b.auth.orgId).not.toBe(a.auth.orgId);
    const made = await createStreamTarget(a.auth, a.auth.orgId, { kind: "twitch", label: "A", rtmpUrl: "rtmp://live-jfk.twitch.tv/app", streamKey: key() });
    expect((await listStreamTargets(a.auth, a.auth.orgId)).map((t) => t.id)).toEqual([made.id]);   // the positive pair
    expect(await listStreamTargets(b.auth, b.auth.orgId)).toEqual([]);
    await expect(listStreamTargets(b.auth, a.auth.orgId)).rejects.toMatchObject({ status: 404 });
    await expect(
      createStreamTarget(b.auth, a.auth.orgId, { kind: "twitch", label: "B into A", rtmpUrl: "rtmp://live-jfk.twitch.tv/app", streamKey: key() }),
    ).rejects.toMatchObject({ status: 404 });
    expect((await listStreamTargets(a.auth, a.auth.orgId)).map((t) => t.id)).toEqual([made.id]);
    expect(await listStreamTargets(b.auth, b.auth.orgId)).toEqual([]);
  });

  it("second call: a second create is a second destination — both listed in creation order, each secret reads back its OWN key", async () => {
    const { auth } = await seedOrg();
    const [k1, k2] = [key(), key()];
    const same = { kind: "youtube" as const, label: "Main", rtmpUrl: "rtmps://a.rtmps.youtube.com/live2" };
    const first = await createStreamTarget(auth, auth.orgId, { ...same, streamKey: k1 });
    const second = await createStreamTarget(auth, auth.orgId, { ...same, streamKey: k2 });
    expect(second.id).not.toBe(first.id);
    // The list projection is exactly what create returned, in creation order.
    expect(await listStreamTargets(auth, auth.orgId)).toEqual([first, second]);
    const keys = await sql.begin(async (tx) => [
      (await readTargetSecret(tx, auth.orgId, first.id)).streamKey,
      (await readTargetSecret(tx, auth.orgId, second.id)).streamKey,
    ]);
    expect(keys).toEqual([k1, k2]);
  });

  it("empty first, then every declared kind: a fresh org lists []; each StreamTargetKind member is accepted by the table and round-trips", async () => {
    const { auth } = await seedOrg();
    expect(await listStreamTargets(auth, auth.orgId)).toEqual([]);
    let checked = 0;
    for (const kind of StreamTargetKind.options) {
      const t = await createStreamTarget(auth, auth.orgId, { kind, label: `dest ${kind}`, rtmpUrl: "rtmps://live.cloudflare.com:443/live/", streamKey: key() });
      expect(t.kind).toBe(kind);
      checked++;
    }
    expect(checked, "kinds checked").toBeGreaterThan(0);
    expect(checked).toBe(StreamTargetKind.options.length);
    expect((await listStreamTargets(auth, auth.orgId)).map((t) => t.kind)).toEqual([...StreamTargetKind.options]);
  });
});

// ---------------------------------------------------------------------------
// The route: parse → authorize → delegate, over the real handler.
// ---------------------------------------------------------------------------

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const post = (orgId: string, body: unknown, headers: HeadersInit = {}) =>
  POST(
    new Request(`http://localhost/api/v1/orgs/${orgId}/stream-targets`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
    ctx(orgId),
  );
const get = (orgId: string, headers: HeadersInit = {}) =>
  GET(new Request(`http://localhost/api/v1/orgs/${orgId}/stream-targets`, { headers }), ctx(orgId));

/** A signed-in owner of a fresh org (real users + org_members rows). */
async function organiser() {
  const { auth } = await seedSignedInOrg("pro");
  authState.userId = auth.userId!;
  return auth;
}

describe.skipIf(!HAS_DB)("/api/v1/orgs/{id}/stream-targets — the route", () => {
  it("a signed-in organiser POSTs (201, the wire shape, no key) and GETs it back; a bad body is 400 and writes nothing", async () => {
    const auth = await organiser();
    const streamKey = key();
    const bad = await post(auth.orgId, { kind: "youtube", label: "x", rtmpUrl: 42, streamKey });
    expect(bad.status).toBe(400);
    const unknownField = await post(auth.orgId, { kind: "youtube", label: "x", rtmpUrl: "rtmps://a.rtmps.youtube.com/live2", streamKey, stream_key: streamKey });
    expect(unknownField.status).toBe(400);
    expect(await listStreamTargets(auth, auth.orgId)).toEqual([]);

    const res = await post(auth.orgId, { kind: "youtube", label: "Club", rtmpUrl: "rtmps://a.rtmps.youtube.com/live2", streamKey, watchUrl: "https://youtu.be/abc" });
    expect(res.status).toBe(201);
    const text = await res.text();
    expect(text).not.toContain(streamKey);
    const created = StreamTarget.parse(JSON.parse(text).data);
    expect(created).toMatchObject({ kind: "youtube", label: "Club", watchUrl: "https://youtu.be/abc" });

    const listed = await get(auth.orgId);
    expect(listed.status).toBe(200);
    const listText = await listed.text();
    expect(listText).not.toContain(streamKey);
    expect(JSON.parse(listText).data).toEqual([created]);
  });

  it("A18: an off-list destination is 422 DESTINATION_NOT_ALLOWED with its rule, over the real route — the reply echoes neither the URL nor the key, and nothing is written", async () => {
    const auth = await organiser();
    const streamKey = key();
    const cases: [string, string][] = [
      ["rtmp://seazn-relay.internal:1935/live", "host"],
      ["rtmps://169.254.169.254/latest", "ip_literal"],
      ["rtmps://a.rtmps.youtube.com.evil.io/live2", "host"],
      ["https://not-an-ingest.example/app", "scheme"],
    ];
    let checked = 0;
    for (const [rtmpUrl, rule] of cases) {
      const res = await post(auth.orgId, { kind: "custom_rtmp", label: "x", rtmpUrl, streamKey });
      expect(res.status, rtmpUrl).toBe(422);
      const text = await res.text();
      const body = JSON.parse(text);
      expect(body.error, rtmpUrl).toMatchObject({ code: "DESTINATION_NOT_ALLOWED", rule });
      expect(text).not.toContain(rtmpUrl);
      expect(text).not.toContain(streamKey);
      checked++;
    }
    expect(checked).toBe(4);
    expect(await listStreamTargets(auth, auth.orgId)).toEqual([]);
    // The positive pair on the same org and door: an allowlisted destination is created.
    const ok = await post(auth.orgId, { kind: "custom_rtmp", label: "Restream", rtmpUrl: "rtmp://live.restream.io/live", streamKey });
    expect(ok.status).toBe(201);
    expect((await listStreamTargets(auth, auth.orgId)).map((t) => t.label)).toEqual(["Restream"]);
  });

  it("roles: a viewer (READ_ROLES, not EDITOR_ROLES) lists the destinations but cannot add one (403, nothing written)", async () => {
    const owner = await organiser();
    const made = await createStreamTarget(owner, owner.orgId, { kind: "facebook", label: "FB", rtmpUrl: "rtmps://live-api-s.facebook.com:443/rtmp/", streamKey: key() });
    const viewer = await makeUser("viewer");
    await sql`insert into org_members (org_id, user_id, role) values (${owner.orgId}, ${viewer.id}, 'viewer')`;
    authState.userId = viewer.id;
    const listed = await get(owner.orgId);
    expect(listed.status).toBe(200);
    expect((await listed.json()).data.map((t: { id: string }) => t.id)).toEqual([made.id]);
    const refused = await post(owner.orgId, { kind: "facebook", label: "viewer's", rtmpUrl: "rtmps://live-api-s.facebook.com:443/rtmp/", streamKey: key() });
    expect(refused.status).toBe(403);
    expect((await listStreamTargets(owner, owner.orgId)).map((t) => t.id)).toEqual([made.id]);
  });

  // What this proves is the DOOR: no key reaches either handler. Which list refuses it (default-deny vs the explicit
  // NEVER_KEY_ROUTES entry) is proved by key-scopes.test.ts's classification walk and stream-contract.test.ts.
  it("an API key — even a manage-scoped one — is refused at BOTH doors (403) and writes nothing", async () => {
    const auth = await organiser();
    // Unblock the key surface itself, so the ONLY thing left to refuse is the route ban.
    for (const feature of ["api.access", "api.write"]) {
      await sql`
        insert into org_entitlement_overrides (org_id, feature_key, bool_value, reason)
        values (${auth.orgId}, ${feature}, true, 'test')
        on conflict (org_id, feature_key) do update set bool_value = true`;
    }
    const { secret } = await createApiKey(auth, { name: "integration", scopes: ["manage"] });
    const bearer = { authorization: `Bearer ${secret}` };
    const keyedPost = await post(auth.orgId, { kind: "kick", label: "k", rtmpUrl: "rtmps://fa723fc1b171.global-contribute.live-video.net:443/app", streamKey: key() }, bearer);
    expect(keyedPost.status).toBe(403);
    const keyedGet = await get(auth.orgId, bearer);
    expect(keyedGet.status).toBe(403);
    // The accepted twin: the same org's session reaches the same doors.
    expect((await get(auth.orgId)).status).toBe(200);
    expect(await listStreamTargets(auth, auth.orgId)).toEqual([]);
  });
});
