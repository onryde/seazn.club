// Seazn-hosted video, Task 26: GET /api/v1/fixtures/{id}/replays/{replayId}/download — the organiser downloads one playable part of a
// fixture's Seazn replay, driven through its REAL handler over a real session (the organiser video route test's door pattern), over
// replay rows the REAL producers made (_seazn-replay-rig.ts), the replay fake installed as this process's driver. What is the ROUTE's
// own (the use case is organiser-replays.test.ts's):
//   - a playable part: 200, the host's own bytes, `video/mp4`, an `attachment` named for the match and the part, its length, and
//     `private, no-store`; never a redirect, and no header holds a token, a signed address or the host's video id;
//   - the body is the host's STREAM passed through, never buffered: the route answers while the host is still sending, and a
//     cancelled download cancels the host's stream;
//   - a processing part is 409 (the envelope, documented), a viewer 403, another organisation 404, an API key 403, signed out 401 —
//     each `private, no-store`, and the host is never asked.
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
// What reaches Sentry: v1() reports every answer of 500 and above, and nothing below (T26 re-review m1 b: a viewer who left is not an error).
const sentry = vi.hoisted(() => ({ captured: [] as unknown[] }));
vi.mock("@sentry/nextjs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@sentry/nextjs")>()),
  captureException: (e: unknown) => { sentry.captured.push(e); return "test-event-id"; },
}));

import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { replayFileName } from "@/lib/poster-file-name";
import { buildOpenApiDocument } from "@/server/api-v1/openapi";
import { rigUser } from "@/server/relay/__tests__/_session-rig";
import { createApiKey } from "@/server/usecases/api-keys";
import { startedDivisionWithFixture } from "@/server/usecases/__tests__/_rig";
import { makeUser, seedOrg } from "@/server/usecases/__tests__/_seed";
import { frozenMemberIds } from "@/server/usecases/entitlement-freeze";
import { setReplayDriverForTest } from "@/server/video/replay-driver";
import { FAKE_REPLAY_FILE, FakeReplayHost } from "@/server/video/replay-fake";
import { ReplayHostRefused } from "@/server/video/replay-ports";
import { BunnyReplayHost } from "@/server/video/replay-bunny";
import { FakeRecorder } from "@/server/relay/fakes";
import { SEAZN_REPLAY_CALL_TIMEOUT_MS, type BunnyConfig } from "@/server/relay/config";
import { movedReplays } from "@/server/video/__tests__/_seazn-replay-rig";
import { installSeaznEnv, seaznRigFor } from "@/server/video/__tests__/_seazn-session-rig";
import { GET } from "../route";

const HAS_DB = !!process.env.DATABASE_URL;
installSeaznEnv("seazn-replay-download-route-test");
afterEach(() => setReplayDriverForTest(null));

const BASE = "https://test.local/api/v1";
interface Envelope {
  ok: boolean;
  error?: { code?: string; message: string };
}

/** A signed-in OWNER of an org whose first fixture has two replay parts made by the real producers — part 1 playable, part 2 still
 *  processing — with the replay fake installed as the process's driver. */
async function organiser() {
  const { auth: owned } = await seedOrg("pro");
  authState.userId = owned.userId!;
  const started = await startedDivisionWithFixture(owned, { fixtures: 2 });
  const fixtures = started.fixtureIds as [string, string];
  const r = await seaznRigFor({ ...owned, userId: await rigUser() }, fixtures);
  const host = new FakeReplayHost();
  const m = await movedReplays(r, fixtures[0], host, { parts: 2, playable: [1] });
  setReplayDriverForTest(host);
  const [names] = await sql<{ home: string | null; away: string | null }[]>`
    select he.display_name as home, ae.display_name as away from fixtures f
      left join entrants he on he.id = f.home_entrant_id left join entrants ae on ae.id = f.away_entrant_id where f.id = ${fixtures[0]}`;
  return { host, ownerId: owned.userId!, orgId: owned.orgId, fixtures, playable: m.rows[0]!, processing: m.rows[1]!, names: names! };
}

/** Fake Bunny settings (never a real key): the adapter under test is the real one, over a fetch that is not. */
const BUNNY: BunnyConfig = {
  apiKey: "ZZ-api-key-download-route", readOnlyKey: "ZZ-read-only-download-route", tokenKey: "ZZ-token-key-download-route",
  libraryId: "424242", cdnHost: "vz-test0001.b-cdn.net",
};
const get = (fixtureId: string, replayId: string, headers: Record<string, string> = {}) =>
  GET(new Request(`${BASE}/fixtures/${fixtureId}/replays/${replayId}/download`, { method: "GET", headers }), { params: Promise.resolve({ id: fixtureId, replayId }) });
const documented = (): string[] =>
  Object.keys(
    (buildOpenApiDocument() as { paths: Record<string, Record<string, { responses: Record<string, unknown> }>> }).paths["/api/v1/fixtures/{id}/replays/{replayId}/download"]!.get!.responses,
  );
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
  await sql`insert into org_entitlement_overrides (org_id, feature_key, bool_value, reason) values (${orgId}, ${key}, ${value}, 'replay download route')
            on conflict (org_id, feature_key) do update set bool_value = ${value}`;
  await invalidateOrgEntitlements(orgId);
}
const privateNoStore = (r: Response, label: string) => {
  expect(r.headers.get("cache-control"), label).toMatch(/(^|,\s*)no-store(\s*,|$)/);
  expect(r.headers.get("cache-control"), label).toMatch(/(^|,\s*)private(\s*,|$)/);
  expect((r.headers.get("vary") ?? "").toLowerCase().split(/\s*,\s*/), label).toEqual(expect.arrayContaining(["cookie", "authorization"]));
};

describe.skipIf(!HAS_DB)("GET …/fixtures/{id}/replays/{replayId}/download over HTTP", () => {
  it("review m1: the video host's CDN never sends its headers — the REAL Bunny adapter gives up at its 4 s and the route answers a clean 503 replay_host_unavailable, private, with no token, address, key or host video id; the failure is recorded `timeout` (on the fake clock: T26 re-review m1 c)", async () => {
    const o = await organiser();
    const cdn: { signal: AbortSignal | null; asked: () => void } = { signal: null, asked: () => {} };
    const asked = new Promise<void>((resolve) => { cdn.asked = resolve; });
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).startsWith("https://video.bunnycdn.com/")) {
        // The route's database work is done by now: the clock goes fake here, before the adapter sets its deadline for the CDN's
        // headers, so the 4 s are counted on it and the test waits for none of them.
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        return new Response(JSON.stringify({ guid: "g", status: 4, length: 60, availableResolutions: "720p" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      cdn.signal = init?.signal ?? null;
      cdn.asked();
      return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true }));
    }) as typeof fetch;
    const recorder = new FakeRecorder();
    const bunny = new BunnyReplayHost(BUNNY, { fetchImpl, recorder, videoOrigins: () => ["stg.seazn.club"] });
    setReplayDriverForTest(bunny);
    let res: Response;
    try {
      const pending = get(o.fixtures[0], o.playable.id);
      const answered = { done: false };
      void pending.then(() => { answered.done = true; }, () => { answered.done = true; });
      await asked;
      await vi.advanceTimersByTimeAsync(SEAZN_REPLAY_CALL_TIMEOUT_MS - 1);
      expect(answered.done, "a ms short of the adapter's deadline: still waiting").toBe(false);
      expect(cdn.signal?.aborted, "PREMISE: the CDN was asked, with a signal").toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      res = await pending;
    } finally {
      vi.useRealTimers();
    }
    expect(res.status).toBe(503);
    const raw = await res.text();
    expect((JSON.parse(raw) as Envelope).error?.code).toBe("replay_host_unavailable");
    privateNoStore(res, "503");
    expect(documented()).toContain("503");
    for (const piece of ["bcdn_token", "expires=", "b-cdn.net", BUNNY.apiKey, BUNNY.readOnlyKey, BUNNY.tokenKey, o.playable.bunny_video_id!]) expect(raw).not.toContain(piece);
    expect(cdn.signal?.aborted, "the CDN request was aborted, not left open").toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(recorder.calls.filter((c) => c.operation === "openDownload").map((c) => [c.status, c.errorCode])).toEqual([[null, "timeout"]]);
  });

  it("T26 re-review m1 (a, b): the viewer leaving before the host answers is 499 and never reaches Sentry; the host refusing our token or Referer is 500 replay_host_refused (documented), reported to Sentry, and never says try again", async () => {
    const o = await organiser();
    // EMPTY CASE FIRST: a download that starts reports nothing.
    sentry.captured.length = 0;
    const ok = await get(o.fixtures[0], o.playable.id);
    expect(ok.status).toBe(200);
    await ok.body?.cancel().catch(() => undefined);
    expect(sentry.captured).toEqual([]);

    const viewer = new AbortController();
    vi.spyOn(o.host, "openDownload").mockImplementationOnce(async () => {
      viewer.abort(new Error("the viewer left"));
      throw new Error("bunny openDownload: cancelled before a response (video x)");
    });
    const left = await GET(new Request(`${BASE}/fixtures/${o.fixtures[0]}/replays/${o.playable.id}/download`, { method: "GET", signal: viewer.signal }), { params: Promise.resolve({ id: o.fixtures[0], replayId: o.playable.id }) });
    expect([left.status, ((await left.json()) as Envelope).error?.code]).toEqual([499, "download_cancelled"]);
    privateNoStore(left, "499");
    expect(sentry.captured, "a viewer who left is not an error").toEqual([]);

    vi.spyOn(o.host, "openDownload").mockRejectedValueOnce(new ReplayHostRefused(403, "bunny openDownload: HTTP 403 (video x)"));
    const refused = await get(o.fixtures[0], o.playable.id);
    const body = (await refused.json()) as Envelope;
    expect([refused.status, body.error?.code]).toEqual([500, "replay_host_refused"]);
    expect(body.error?.message).not.toMatch(/try|again|moment|403|bunny/i);
    privateNoStore(refused, "500");
    expect(sentry.captured, "a configuration fault is reported").toHaveLength(1);
    expect(documented()).toContain("500");
  });

  it("review m1: the viewer's cancel reaches the host — the route hands the host its request's signal, and aborting the request aborts it", async () => {
    const o = await organiser();
    const open = vi.spyOn(o.host, "openDownload");
    const viewer = new AbortController();
    const res = await GET(new Request(`${BASE}/fixtures/${o.fixtures[0]}/replays/${o.playable.id}/download`, { method: "GET", signal: viewer.signal }), { params: Promise.resolve({ id: o.fixtures[0], replayId: o.playable.id }) });
    expect(res.status).toBe(200);
    // The fake's own signature takes no signal (its file is one closed chunk); the port's second argument is read off the call.
    const handed = (open.mock.calls[0] as unknown as [string, AbortSignal | undefined] | undefined)?.[1];
    expect(handed, "the host was given a signal").toBeInstanceOf(AbortSignal);
    expect(handed!.aborted, "PREMISE: not yet").toBe(false);
    viewer.abort();
    expect(handed!.aborted, "the viewer's cancel reached the host").toBe(true);
    await res.body?.cancel().catch(() => undefined);
  });

  it("a FROZEN admin seat (over quota, doc 10 §2.4) is 402 members.max, private, the host never asked — the door's write scope, which the use case's role check does not see; the owner of the same org downloads", async () => {
    const o = await organiser();
    const open = vi.spyOn(o.host, "openDownload");
    authState.userId = await frozenAdmin(o.orgId);
    const refused = await get(o.fixtures[0], o.playable.id);
    expect(refused.status).toBe(402);
    privateNoStore(refused, "frozen");
    expect(documented()).toContain("402");
    expect(open, "nothing opened for a frozen seat").not.toHaveBeenCalled();
    authState.userId = o.ownerId;
    const owner = await get(o.fixtures[0], o.playable.id);
    expect(owner.status).toBe(200);
    expect(new Uint8Array(await owner.arrayBuffer())).toEqual(FAKE_REPLAY_FILE);
  });

  it("EMPTY CASE FIRST: a part this fixture does not have is 404 (the envelope, `private, no-store`) and the host is never asked", async () => {
    const o = await organiser();
    const open = vi.spyOn(o.host, "openDownload");
    const res = await get(o.fixtures[0], randomUUID());
    expect(res.status).toBe(404);
    expect(((await res.json()) as Envelope).error?.message).toBe("replay not found");
    privateNoStore(res, "404");
    expect(open).not.toHaveBeenCalled();
    expect(documented()).toContain("404");
  });

  it("a playable part: 200, the host's own bytes as an mp4 attachment named for the match and the part, its length, `private, no-store`; no redirect, and no header carries a token, an address or the host's video id", async () => {
    const o = await organiser();
    const res = await get(o.fixtures[0], o.playable.id);
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("content-type")).toBe("video/mp4");
    expect(res.headers.get("content-disposition")).toBe(`attachment; filename="${replayFileName(o.names.home ?? "", o.names.away ?? "", 1)}"`);
    expect(res.headers.get("content-disposition"), "the brief's shape: <match>-part-<n>.mp4").toMatch(/^attachment; filename="seazn-[a-z0-9-]+-part-1\.mp4"$/);
    expect(res.headers.get("content-length")).toBe(String(FAKE_REPLAY_FILE.length));
    privateNoStore(res, "200");
    const headers = [...res.headers.entries()];
    expect(headers.length, "PREMISE: the headers were read").toBeGreaterThan(4);
    for (const [name, value] of headers) {
      expect(value, name).not.toMatch(/token|expires=|https?:|\.invalid/i);
      expect(value, name).not.toContain(o.playable.bunny_video_id!);
    }
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(FAKE_REPLAY_FILE);
  });

  it("the host's stream is passed through, never buffered: the route answers while the host is still sending, the bytes follow as the host sends them, and a cancelled download cancels the host's stream", async () => {
    const o = await organiser();
    const enc = new TextEncoder();
    let more!: () => void;
    const gate = new Promise<void>((res) => (more = res));
    let cancelled: unknown = "not cancelled";
    const sent: string[] = [];
    const host = (first: string) =>
      new ReadableStream<Uint8Array>({
        start(c) { c.enqueue(enc.encode(first)); sent.push(first); },
        async pull(c) { await gate; c.enqueue(enc.encode("-second")); sent.push("-second"); c.close(); },
        cancel(reason) { cancelled = reason ?? "cancelled"; },
      });
    const open = vi.spyOn(o.host, "openDownload");
    open.mockResolvedValueOnce({ body: host("first"), bytes: null, fileName: "ignored.mp4" });
    const timeout = <T>(p: Promise<T>) => Promise.race([p, new Promise<"timed out">((res) => setTimeout(() => res("timed out"), 3000))]);
    const res = await timeout(get(o.fixtures[0], o.playable.id));
    expect(res, "the route answered before the host finished sending").not.toBe("timed out");
    const r = res as Response;
    expect(r.status).toBe(200);
    expect(r.headers.get("content-length"), "no length when the host gives none").toBeNull();
    const reader = r.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value), "the first bytes, while the host holds the rest").toBe("first");
    expect(sent).toEqual(["first"]);
    more();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("-second");
    expect((await reader.read()).done).toBe(true);

    // A viewer who gives up: the cancel reaches the host's stream.
    open.mockResolvedValueOnce({ body: host("again"), bytes: null, fileName: "ignored.mp4" });
    const second = await get(o.fixtures[0], o.playable.id);
    await second.body!.cancel("viewer left");
    expect(cancelled).toBe("viewer left");
  });

  it("a part still processing is 409 replay_not_downloadable (the envelope, documented) and the host is never asked", async () => {
    const o = await organiser();
    const open = vi.spyOn(o.host, "openDownload");
    const res = await get(o.fixtures[0], o.processing.id);
    expect(res.status).toBe(409);
    expect(((await res.json()) as Envelope).error?.code).toBe("replay_not_downloadable");
    privateNoStore(res, "409");
    expect(open).not.toHaveBeenCalled();
    expect(documented()).toContain("409");
  });

  it("a viewer is 403 (an admin is served, the positive pair); another organisation's member, an unknown and a malformed fixture are 404; an API key is 403 at the door; signed out 401 — each `private, no-store`, and the host is never asked for a refusal", async () => {
    const o = await organiser();
    const stranger = await organiser();
    await override(o.orgId, "api.access", true);
    await override(o.orgId, "api.write", true);
    const { secret } = await createApiKey({ orgId: o.orgId, via: "session", userId: o.ownerId, role: "owner", keyId: null }, { name: `dl-${randomUUID().slice(0, 6)}`, scopes: ["manage"] });
    const open = vi.spyOn(o.host, "openDownload");
    const answers: [string, number, Response][] = [];
    authState.userId = await member(o.orgId, "viewer");
    answers.push(["viewer", 403, await get(o.fixtures[0], o.playable.id)]);
    authState.userId = stranger.ownerId;
    answers.push(["another organisation", 404, await get(o.fixtures[0], o.playable.id)]);
    answers.push(["an unknown fixture", 404, await get(randomUUID(), o.playable.id)]);
    answers.push(["a malformed fixture", 404, await get("f1", o.playable.id)]);
    authState.userId = o.ownerId;
    answers.push(["an API key", 403, await get(o.fixtures[0], o.playable.id, { authorization: `Bearer ${secret}` })]);
    authState.userId = "";
    answers.push(["signed out", 401, await get(o.fixtures[0], o.playable.id)]);
    let checked = 0;
    for (const [label, status, res] of answers) {
      expect(res.status, label).toBe(status);
      expect(res.headers.get("content-type"), label).toMatch(/json/);
      privateNoStore(res, label);
      expect(documented(), label).toContain(String(status));
      checked++;
    }
    expect(checked).toBe(6);
    expect(open, "nothing was opened for a refusal").not.toHaveBeenCalled();
    authState.userId = await member(o.orgId, "admin");
    const admin = await get(o.fixtures[0], o.playable.id);
    expect(admin.status).toBe(200);
    expect(new Uint8Array(await admin.arrayBuffer())).toEqual(FAKE_REPLAY_FILE);
  });
});
