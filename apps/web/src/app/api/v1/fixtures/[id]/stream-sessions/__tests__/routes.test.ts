// Streaming R1 over HTTP: the three organiser routes (create / current / stop, design §6.3), driven through their REAL
// handlers over a real session (`requireResourceAuth` unmocked; only the cookie door is faked one layer down, the
// device-links route test's pattern). stream-sessions.test.ts proves the usecase; this file proves the ROUTES carry it:
//   - the envelope: 201 { sessionId }, the projection, the idempotent second stop, `null` when there is no session;
//   - every typed refusal reaches the WIRE with its machine-readable extra (lane C A21), and each extra the wire carries
//     is documented on that route × status in the OpenAPI spec (truthful envelopes);
//   - `?reveal=1` is the only thing that moves the reveal counters (a poll is not a reveal — De);
//   - the Machine is told to call back at THIS request's base URL (the create route's `defaultDeps(baseUrl(req))`);
//   - API keys are refused at the door on all three (NEVER_KEY_ROUTES — a money route), and it is THAT refusal, not the
//     usecase's own "signed-in organiser" 403 that shares its status.
//
// ONE SPORT, on purpose (TEST-STRATEGY rule 6): relay is sport-agnostic — nothing on these routes reads the sport — so
// every rig rides `_rig`'s `generic` division. Both MODES appear below.
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

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
import { baseUrl } from "@/lib/oauth";
import { destinationRefusal } from "@/lib/stream-destinations";
import { buildOpenApiDocument } from "@/server/api-v1/openapi";
import { StreamSessionCreated, StreamSessionCurrent } from "@/server/api-v1/schemas";
import { MAX_DURATION_MINUTES, RUNNER_OBSERVE_SLACK_SECONDS, RUNNER_STOP_GRACE_SECONDS } from "@/server/relay/config";
import { setRelayDriversForTest } from "@/server/relay/drivers";
import { FakeIngest, FakeRunner } from "@/server/relay/fakes";
import type { StorageUsage } from "@/server/relay/ports";
import { resealTargetDestination, rigUser } from "@/server/relay/__tests__/_session-rig";
import { createApiKey } from "@/server/usecases/api-keys";
import { grantCredits } from "@/server/usecases/stream-credits";
import { defaultDeps, heartbeat } from "@/server/usecases/stream-sessions";
import { createStreamTarget } from "@/server/usecases/stream-targets";
import { seedOrg } from "@/server/usecases/__tests__/_seed";
import { startedDivisionWithFixture } from "@/server/usecases/__tests__/_rig";
import { POST as createRoute } from "../route";
import { GET as currentRoute } from "../current/route";
import { POST as stopRoute } from "../[sid]/stop/route";

const HAS_DB = !!process.env.DATABASE_URL;
const BASE = "https://test.local/api/v1";
const YT = "rtmps://a.rtmps.youtube.com/live2";
/** A pool no plausible number of foreign reservations can exhaust — the pool is ONE account across the whole test
 *  database (Task 10 deviation 4); only the storage test sets its own. */
const ROOMY: StorageUsage = { totalStorageMinutes: 0, totalStorageMinutesLimit: 100_000_000, videoCount: 0 };

interface Envelope<T = unknown> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string; [k: string]: unknown };
  requestId?: string;
}

async function override(orgId: string, key: string, value: boolean) {
  await sql`insert into org_entitlement_overrides (org_id, feature_key, bool_value, reason) values (${orgId}, ${key}, ${value}, 'r1 routes')
            on conflict (org_id, feature_key) do update set bool_value = ${value}`;
  await invalidateOrgEntitlements(orgId);
}

/** A signed-in owner of a fresh org with one saved YouTube destination, the relay entitlements, and `credits` credits. */
async function organiser(opts: { credits?: number; overlay?: boolean; relay?: boolean; fixtures?: 1 | 2; storage?: StorageUsage } = {}) {
  const { auth } = await seedOrg("pro");
  authState.userId = auth.userId!;
  const d = await startedDivisionWithFixture(auth, opts.fixtures === 2 ? { fixtures: 2 } : {});
  await override(auth.orgId, "streaming.overlay", opts.overlay ?? true);
  await override(auth.orgId, "streaming.relay", opts.relay ?? true);
  const credits = opts.credits ?? 1;
  if (credits > 0) await grantCredits({ orgId: auth.orgId, delta: credits, createdBy: await rigUser(), note: "unit", idempotencyKey: randomUUID() });
  const target = await createStreamTarget(auth, auth.orgId, { kind: "youtube", label: "Club", rtmpUrl: YT, streamKey: `k-${randomUUID().slice(0, 8)}` });
  // The fake ingest never connects inside a test, so a passthrough session stays `warming` (its QR on show).
  const ingest = new FakeIngest({ connectAfterMs: 10 * 60_000 });
  ingest.storage = opts.storage ?? ROOMY;
  const runner = new FakeRunner();
  setRelayDriversForTest({ ingest, runner });
  return { auth, fixtureId: d.fixtureId, fixtureIds: d.fixtureIds, target, ingest, runner };
}

function request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
}
async function read<T = unknown>(res: Response): Promise<{ status: number; body: Envelope<T> }> {
  return { status: res.status, body: (await res.json()) as Envelope<T> };
}
const create = async (fixtureId: string, body: unknown, headers?: Record<string, string>) =>
  read<{ sessionId: string }>(await createRoute(request("POST", `/fixtures/${fixtureId}/stream-sessions`, body, headers), { params: Promise.resolve({ id: fixtureId }) }));
const current = async (fixtureId: string, query = "", headers?: Record<string, string>) =>
  read<StreamSessionCurrent | null>(await currentRoute(request("GET", `/fixtures/${fixtureId}/stream-sessions/current${query}`, undefined, headers), { params: Promise.resolve({ id: fixtureId }) }));
const stop = async (fixtureId: string, sid: string, headers?: Record<string, string>) =>
  read<StreamSessionCurrent>(await stopRoute(request("POST", `/fixtures/${fixtureId}/stream-sessions/${sid}/stop`, undefined, headers), { params: Promise.resolve({ id: fixtureId, sid }) }));

async function sessionsOn(fixtureId: string): Promise<number> {
  const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from fixture_stream_sessions where fixture_id = ${fixtureId}`;
  return n;
}

/** Puts `fixtureId` on a court named `name` at a venue of `orgId` (the stream-sessions I1 rig's seeding). */
async function onCourt(orgId: string, fixtureId: string, name: string): Promise<void> {
  const [v] = await sql<{ id: string }[]>`insert into venues (org_id, name, address) values (${orgId}, 'Main Arena', '12 Court Road') returning id`;
  const [c] = await sql<{ id: string }[]>`insert into courts (venue_id, org_id, name) values (${v!.id}, ${orgId}, ${name}) returning id`;
  await sql`update fixtures set court_id = ${c!.id} where id = ${fixtureId}`;
}

afterEach(() => setRelayDriversForTest(null));
afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("POST/GET …/stream-sessions over HTTP", () => {
  it("EMPTY: a fixture with no session answers current 200 with data null — never a default object", async () => {
    const o = await organiser();
    const r = await current(o.fixtureId);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, data: null });
    expect("data" in r.body).toBe(true);
  });

  it("create → 201 { sessionId }; current → that session's projection; a SECOND create → 409 active_session carrying the running session's id", async () => {
    const o = await organiser();
    const made = await create(o.fixtureId, { mode: "passthrough", targetId: o.target.id });
    expect(made.status).toBe(201);
    const { sessionId } = StreamSessionCreated.parse(made.body.data);
    const cur = await current(o.fixtureId);
    expect(cur.status).toBe(200);
    const projection = StreamSessionCurrent.parse(cur.body.data);
    expect(projection).toMatchObject({ id: sessionId, fixtureId: o.fixtureId, mode: "passthrough", state: "warming", desiredState: "live" });
    const again = await create(o.fixtureId, { mode: "passthrough", targetId: o.target.id });
    expect(again.status).toBe(409);
    expect(again.body.error).toMatchObject({ code: "active_session", sessionId });
    expect(await sessionsOn(o.fixtureId), "the refused second create wrote no row").toBe(1);
  });

  it("stop → 200 the projection (passthrough completes at once, end reason stopped), its action row names the signed-in organiser; a SECOND stop is the same answer and writes nothing; after it a new create is admitted", async () => {
    const o = await organiser();
    const { sessionId } = (await create(o.fixtureId, { mode: "passthrough", targetId: o.target.id })).body.data!;
    const first = await stop(o.fixtureId, sessionId);
    expect(first.status).toBe(200);
    expect(StreamSessionCurrent.parse(first.body.data)).toMatchObject({ id: sessionId, state: "completed", endReason: "stopped" });
    const actions = await sql<{ actor_user_id: string | null }[]>`
      select actor_user_id from fixture_stream_events where session_id = ${sessionId} and kind = 'action' and type = 'stop'`;
    expect(actions).toEqual([{ actor_user_id: authState.userId }]);
    const [{ n: eventsBefore }] = await sql<{ n: number }[]>`select count(*)::int as n from fixture_stream_events where session_id = ${sessionId}`;
    const second = await stop(o.fixtureId, sessionId);
    expect(second.status).toBe(200);
    expect(second.body.data).toEqual(first.body.data);
    const [{ n: eventsAfter }] = await sql<{ n: number }[]>`select count(*)::int as n from fixture_stream_events where session_id = ${sessionId}`;
    expect(eventsAfter, "the second stop wrote no history row").toBe(eventsBefore);
    // After the stop: the fixture may stream again, and current follows the NEW session.
    const restart = await create(o.fixtureId, { mode: "passthrough", targetId: o.target.id });
    expect(restart.status).toBe(201);
    expect(restart.body.data!.sessionId).not.toBe(sessionId);
    expect((await current(o.fixtureId)).body.data).toMatchObject({ id: restart.body.data!.sessionId, state: "warming" });
  });

  it("composed over HTTP: the Machine is told to call back at THIS request's base URL, and a stop answers desiredState ending (the Machine learns it from its next beat)", async () => {
    const o = await organiser();
    const req = request("POST", `/fixtures/${o.fixtureId}/stream-sessions`, { mode: "composed", targetId: o.target.id });
    const made = await read<{ sessionId: string }>(await createRoute(req, { params: Promise.resolve({ id: o.fixtureId }) }));
    expect(made.status).toBe(201);
    expect(o.runner.created).toHaveLength(1);
    expect(o.runner.created[0]).toMatchObject({ sessionId: made.body.data!.sessionId, appUrl: baseUrl(req) });
    const stopped = await stop(o.fixtureId, made.body.data!.sessionId);
    expect(stopped.status).toBe(200);
    expect(stopped.body.data).toMatchObject({ mode: "composed", desiredState: "ending" });
    // The organiser's next poll looks at the Machine; the SIGINT'd Machine exited clean and is gone (the fake
    // auto-destroys a requested stop, as both R0 soaks did), so the session completes as STOPPED. Completing it here
    // also keeps this suite from leaving an `ending` row with a stop mark behind — the expiry policy counts one as a
    // storage reservation at any later instant, which moves a concurrently running pool test's measured baseline
    // (stream-sessions.test.ts's C3 + B).
    const after = await current(o.fixtureId);
    expect(after.body.data).toMatchObject({ id: made.body.data!.sessionId, state: "completed", endReason: "stopped", failReason: null });
  });

  it("?reveal=1 — and nothing else — moves the reveal counters: a poll serves the QR without counting a reveal (De)", async () => {
    const o = await organiser();
    const { sessionId } = (await create(o.fixtureId, { mode: "passthrough", targetId: o.target.id })).body.data!;
    const reveals = async () => (await sql<{ n: number }[]>`select credentials_reveal_count as n from fixture_stream_sessions where id = ${sessionId}`)[0]!.n;
    const steps: [string, number][] = [["", 0], ["", 0], ["?reveal=1", 1], ["?reveal=true", 1], ["?reveal=0", 1], ["", 1], ["?reveal=1", 2]];
    let checked = 0;
    for (const [query, expected] of steps) {
      const r = await current(o.fixtureId, query);
      expect(r.status, query).toBe(200);
      expect(r.body.data!.qr, `${query}: the QR is served while warming`).not.toBeNull();
      expect(await reveals(), `after GET current${query}`).toBe(expected);
      checked += 1;
    }
    expect(checked).toBe(steps.length);
  });

  it("A21: every typed refusal reaches the wire WITH its extra, and every extra on the wire is documented on that route × status in the OpenAPI spec", async () => {
    const seen: { label: string; status: number; error: Record<string, unknown> }[] = [];
    const refuse = async (label: string, fixtureId: string, body: unknown, status: number) => {
      const r = await create(fixtureId, body, undefined);
      expect(r.status, label).toBe(status);
      expect(r.body.ok, label).toBe(false);
      seen.push({ label, status, error: r.body.error! });
      return r.body.error!;
    };

    // 402 no_credits — the organiser has the relay but no credit; `featureKey` names what to buy.
    const broke = await organiser({ credits: 0 });
    expect(await refuse("no_credits", broke.fixtureId, { mode: "passthrough", targetId: broke.target.id }, 402))
      .toMatchObject({ code: "no_credits", featureKey: "streaming.relay" });

    // 402 plan — no overlay tier at all: the paywall's shape (feature_key + a human reason).
    const plan = await organiser({ overlay: false, relay: false });
    expect(await refuse("plan_lacks_overlay", plan.fixtureId, { mode: "passthrough", targetId: plan.target.id }, 402))
      .toMatchObject({ code: "PAYMENT_REQUIRED", feature_key: "streaming.overlay" });

    // 503 storage_exhausted — the headroom on the wire is the one the admission RECORDED (its own snapshot row),
    // and it is below the session's declared maximum, which is the rule that refused it.
    const used = 500_000 + Math.floor(Math.random() * 400_000);
    const full = await organiser({ storage: { totalStorageMinutes: used, totalStorageMinutesLimit: used + 1, videoCount: 1 } });
    const storage = await refuse("storage_exhausted", full.fixtureId, { mode: "passthrough", targetId: full.target.id }, 503);
    const [snap] = await sql<{ headroom_minutes: number }[]>`
      select headroom_minutes from stream_storage_snapshots
       where source = 'admission' and session_id is null and used_minutes = ${used} and limit_minutes = ${used + 1}
       order by taken_at desc limit 1`;
    expect(snap, "the refused admission recorded its measurement").toBeDefined();
    expect(storage).toMatchObject({ code: "storage_exhausted", headroomMinutes: snap!.headroom_minutes });
    expect(storage.headroomMinutes as number).toBeLessThan(MAX_DURATION_MINUTES);
    expect(await sessionsOn(full.fixtureId)).toBe(0);

    // 409 active_session — `sessionId` is the running one (the second-call test pins its value; here: presence + shape).
    const busy = await organiser();
    const first = (await create(busy.fixtureId, { mode: "passthrough", targetId: busy.target.id })).body.data!.sessionId;
    expect(await refuse("active_session", busy.fixtureId, { mode: "passthrough", targetId: busy.target.id }, 409))
      .toMatchObject({ code: "active_session", sessionId: first });

    // 409 target_in_use — the destination is held by ANOTHER fixture's ACTIVE session. `holder` names that fixture, its
    // court and the destination's own label — each compared with what THIS test seeded, never with the usecase's output.
    const shared = await organiser({ fixtures: 2 });
    const holderFixture = shared.fixtureIds[0]!;
    const court = `Court ${randomUUID().slice(0, 4)}`;
    await onCourt(shared.auth.orgId, holderFixture, court);
    expect((await create(holderFixture, { mode: "passthrough", targetId: shared.target.id })).status).toBe(201);
    const inUse = await refuse("target_in_use", shared.fixtureIds[1]!, { mode: "passthrough", targetId: shared.target.id }, 409);
    expect(inUse).toMatchObject({ code: "target_in_use", holder: { fixtureId: holderFixture, courtName: court, label: shared.target.label } });
    expect(String(inUse.message)).toContain(court);

    // 422 DESTINATION_NOT_ALLOWED — A20: a SAVED destination the allowlist no longer admits is refused at the start,
    // with the rule the ONE validator names for that url (lib/stream-destinations.ts), never the url itself.
    const stale = await organiser();
    const retired = "rtmps://ingest.retired-provider.example:443/live";
    await resealTargetDestination(stale.target.id, { url: retired, streamKey: "k" });
    const rule = destinationRefusal(retired);
    expect(rule, "the fixture url must be one the allowlist refuses").not.toBeNull();
    const dest = await refuse("DESTINATION_NOT_ALLOWED", stale.fixtureId, { mode: "passthrough", targetId: stale.target.id }, 422);
    expect(dest).toMatchObject({ code: "DESTINATION_NOT_ALLOWED", rule });
    expect(JSON.stringify(dest)).not.toContain("retired-provider");
    expect(await sessionsOn(stale.fixtureId)).toBe(0);

    // Truthful envelopes: every extra key the wire carried is a documented property of that route × status.
    const doc = buildOpenApiDocument() as {
      paths: Record<string, Record<string, { responses: Record<string, { content: { "application/json": { schema: { properties: { error: { properties?: Record<string, unknown> } } } } } }> }>>;
    };
    const op = doc.paths["/api/v1/fixtures/{id}/stream-sessions"]!.post!;
    let extrasChecked = 0;
    for (const s of seen) {
      const documented = (op.responses[String(s.status)]?.content["application/json"].schema.properties.error.properties ?? {}) as Record<string, { properties?: Record<string, unknown> }>;
      for (const [key, value] of Object.entries(s.error)) {
        if (key === "code" || key === "message") continue;
        expect(documented, `${s.label} (${s.status}) carries \`${key}\` on the wire; the spec must document it`).toHaveProperty(key);
        extrasChecked += 1;
        // One level down: an OBJECT extra (target_in_use's `holder`) documents each of its own keys too.
        if (value !== null && typeof value === "object" && !Array.isArray(value)) {
          for (const inner of Object.keys(value)) {
            expect(documented[key]!.properties ?? {}, `${s.label}: \`${key}.${inner}\` is on the wire; the spec must document it`).toHaveProperty(inner);
            extrasChecked += 1;
          }
        }
      }
    }
    expect(seen.map((s) => s.label)).toEqual(["no_credits", "plan_lacks_overlay", "storage_exhausted", "active_session", "target_in_use", "DESTINATION_NOT_ALLOWED"]);
    expect(extrasChecked, "anti-vacuity: the refusals above carry extras").toBeGreaterThanOrEqual(10);
  });

  // Task 10's I1 path, over HTTP: ANOTHER fixture's ENDED composed session whose Machine the provider still lists (its
  // forced destroy never confirmed) holds the destination. B's admission tries that destroy; while it keeps failing the
  // start is 409 target_in_use, and the wire names the holder exactly as the active-holder refusal does.
  it("I1 over HTTP: a failed destroy of another fixture's orphan Machine refuses 409 target_in_use WITH the holder on the wire, and nothing is created", async () => {
    const o = await organiser({ fixtures: 2, credits: 2 });   // A spends one; the admitted positive pair at the end, the other
    const [a, b] = [o.fixtureIds[0]!, o.fixtureIds[1]!];
    const court = `Court ${randomUUID().slice(0, 4)}`;
    await onCourt(o.auth.orgId, a, court);
    const old = (await create(a, { mode: "composed", targetId: o.target.id })).body.data!.sessionId;
    await heartbeat(old, o.runner.created[0]!.jobToken, { state: "playing" }, defaultDeps("http://app.test"));
    const [{ machine_id: machine }] = await sql<{ machine_id: string }[]>`select machine_id from fixture_stream_sessions where id = ${old}`;
    // Seeded as Task 10's I1 test seeds it: a stop past grace + slack, so the next look completes the row.
    await sql`update fixture_stream_sessions set state = 'ending', desired_state = 'ending', end_reason = 'stopped', ending_at = now(), runner_state = 'stopping',
                  runner_stop_requested_at = now() - make_interval(secs => ${RUNNER_STOP_GRACE_SECONDS + RUNNER_OBSERVE_SLACK_SECONDS + 1}) where id = ${old}`;
    const failing = Object.assign(Object.create(o.runner) as FakeRunner, {
      async destroy() { throw Object.assign(new Error("fake destroy failed"), { status: 503 }); },
    });
    setRelayDriversForTest({ ingest: o.ingest, runner: failing });
    expect((await current(a)).status).toBeGreaterThanOrEqual(500);   // the organiser's poll completes A; its forced destroy fails
    expect((await sql<{ state: string }[]>`select state from fixture_stream_sessions where id = ${old}`)[0]!.state).toBe("completed");
    expect((await o.runner.list()).map((m) => m.runnerId)).toContain(machine);
    const refused = await create(b, { mode: "passthrough", targetId: o.target.id });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatchObject({ code: "target_in_use", holder: { fixtureId: a, courtName: court, label: o.target.label } });
    expect(await sessionsOn(b)).toBe(0);
    // The positive pair: once the provider confirms the orphan's destroy, the same start is admitted.
    setRelayDriversForTest({ ingest: o.ingest, runner: o.runner });
    expect((await create(b, { mode: "passthrough", targetId: o.target.id })).status).toBe(201);
  });

  it("create: an empty body, a non-JSON body and an unknown field are 400 VALIDATION, and no row is written", async () => {
    const o = await organiser();
    const cases: [string, unknown][] = [
      ["an empty object", {}],
      ["not JSON", "not json"],
      ["an unknown field (the schema is strict)", { mode: "passthrough", targetId: o.target.id, credits: 99 }],
      ["an unknown mode", { mode: "screencast", targetId: o.target.id }],
    ];
    for (const [label, body] of cases) {
      const r = await create(o.fixtureId, body);
      expect(r.status, label).toBe(400);
      expect(r.body.error?.code, label).toBe("VALIDATION");
    }
    expect(await sessionsOn(o.fixtureId)).toBe(0);
    // The positive pair: the same organiser, a well-formed body.
    expect((await create(o.fixtureId, { mode: "passthrough", targetId: o.target.id })).status).toBe(201);
  });

  it("stop: a malformed sid is 404 before any lookup, and a session stopped through ANOTHER fixture's path is 404 and keeps running", async () => {
    const o = await organiser({ fixtures: 2 });
    expect((await stop(o.fixtureId, "not-a-uuid")).body.error).toMatchObject({ code: "NOT_FOUND" });
    const { sessionId } = (await create(o.fixtureIds[0]!, { mode: "passthrough", targetId: o.target.id })).body.data!;
    const wrongPath = await stop(o.fixtureIds[1]!, sessionId);
    expect(wrongPath.status).toBe(404);
    expect((await current(o.fixtureIds[0]!)).body.data).toMatchObject({ id: sessionId, state: "warming", desiredState: "live" });
  });

  it("API keys are refused AT THE DOOR on all three routes — the key ban, not the usecase's own 403 — and nothing is written", async () => {
    const o = await organiser();
    // Unblock the key surface itself, so the ONLY thing left to refuse is the route ban.
    await override(o.auth.orgId, "api.access", true);
    await override(o.auth.orgId, "api.write", true);
    const { secret } = await createApiKey(o.auth, { name: `relay-${randomUUID().slice(0, 6)}`, scopes: ["manage"] });
    const bearer = { authorization: `Bearer ${secret}` };
    const calls: [string, () => Promise<{ status: number; body: Envelope }>][] = [
      ["create", () => create(o.fixtureId, { mode: "passthrough", targetId: o.target.id }, bearer)],
      ["current", () => current(o.fixtureId, "?reveal=1", bearer)],
      ["stop", () => stop(o.fixtureId, randomUUID(), bearer)],
    ];
    let checked = 0;
    for (const [label, call] of calls) {
      const r = await call();
      expect(r.status, label).toBe(403);
      // WHICH 403: the allowlist's, never the create usecase's "signed-in organiser" guard that shares the status.
      expect(r.body.error?.message, label).toMatch(/cannot access this endpoint/);
      expect(r.body.error?.message, label).not.toMatch(/signed-in organiser/);
      checked += 1;
    }
    expect(checked).toBe(calls.length);
    expect(await sessionsOn(o.fixtureId)).toBe(0);
    // The positive pair: the same org's signed-in owner reaches the same door.
    expect((await create(o.fixtureId, { mode: "passthrough", targetId: o.target.id })).status).toBe(201);
  });
});
