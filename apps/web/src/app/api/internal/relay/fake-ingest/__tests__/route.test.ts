// Capture QR v2 T7 (§6.15, FP8): POST /api/internal/relay/fake-ingest/[inputId] — a walkthrough's control over the FAKE
// ingest, driving the EXISTING `FakeIngest.setState` (relay/fakes.ts). It exists only where a fake is honoured: 404 unless
// RELAY_DRIVERS=fake AND ENV_NAME ∈ {local, ci} (config.ts FAKE_DRIVER_ENV_NAMES). One case per refused combination, then
// the seam through its REAL consumer: the flip is read by the next tick (DB-backed, skipped without DATABASE_URL).
// Seazn Task 19: the same route also finishes a recording of an input (`{ recording: "ready" }`, `FakeIngest.addRecording`), the
// walkthrough's stand-in for Cloudflare's; its seam is the stream tick's Seazn lock pass, which must find and sign it.
import { afterEach, describe, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { STREAM_POLL_MS } from "@/lib/stream-session-view";
import { FAKE_DRIVER_ENV_NAMES } from "@/server/relay/config";
import { setRelayDriversForTest } from "@/server/relay/drivers";
import { FakeIngest, FakeRunner } from "@/server/relay/fakes";
import { pairPresentPhone, rigUser } from "@/server/relay/__tests__/_session-rig";
import { seedOrg, startedDivisionWithFixture } from "@/server/usecases/__tests__/_rig";
import { grantCredits } from "@/server/usecases/stream-credits";
import { createStreamTarget } from "@/server/usecases/stream-targets";
import { type SessionDeps, createSession, tickSession } from "@/server/usecases/stream-sessions";
import { SEAZN_PASS_BUDGET_MS, lockSeaznRecordings } from "@/server/usecases/seazn-recordings";
import { installSeaznEnvForDescribe, live, seaznRig, stopAndSettle } from "@/server/video/__tests__/_seazn-session-rig";
import { POST } from "../[inputId]/route";

vi.mock("@/lib/sentry", () => ({ captureError: vi.fn() }));

const HAS_DB = !!process.env.DATABASE_URL;

const call = (inputId: string, body: unknown) =>
  POST(new Request(`http://app.test/api/internal/relay/fake-ingest/${inputId}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
    { params: Promise.resolve({ inputId }) });

afterEach(() => {
  vi.unstubAllEnvs();
  setRelayDriversForTest(null);
});

describe("POST /api/internal/relay/fake-ingest/[inputId] — refused outside a fake on local/ci", () => {
  it("PREMISE: the honoured ENV_NAMEs are exactly local and ci (config.ts's own list)", () => {
    expect([...FAKE_DRIVER_ENV_NAMES].sort()).toEqual(["ci", "local"]);
  });

  // Each refused combination, and the setState spy proves nothing was flipped.
  const REFUSED: [string, string | undefined, string | undefined][] = [
    ["stg + fake", "fake", "stg"],
    ["prod + fake", "fake", "prod"],
    ["local + live", "live", "local"],
    ["ci + live", "live", "ci"],
    ["unset ENV_NAME + fake", "fake", undefined],
    ["local + unset RELAY_DRIVERS", undefined, "local"],
  ];
  for (const [name, drivers, envName] of REFUSED) {
    it(`404: ${name}`, async () => {
      vi.stubEnv("RELAY_DRIVERS", drivers ?? "");
      vi.stubEnv("ENV_NAME", envName ?? "");
      const fake = new FakeIngest();
      const { inputId } = await fake.createLiveInput({ sessionId: randomUUID(), slot: 0 } as Parameters<FakeIngest["createLiveInput"]>[0]);
      setRelayDriversForTest({ ingest: fake, runner: new FakeRunner() });
      const flip = vi.spyOn(fake, "setState");
      const record = vi.spyOn(fake, "addRecording");
      const res = await call(inputId, { state: "connected" });
      expect(res.status).toBe(404);
      expect(flip).not.toHaveBeenCalled();
      expect((await call(inputId, { recording: "ready" })).status, "the recording control is refused alike").toBe(404);
      expect(record).not.toHaveBeenCalled();
      expect(await fake.listInputVideos(inputId)).toEqual([]);
    });
  }

  it("with both set: an unknown input is 404 and a bad state is 400, neither flipping anything; a known one is flipped and answered", async () => {
    vi.stubEnv("RELAY_DRIVERS", "fake");
    vi.stubEnv("ENV_NAME", "ci");
    const fake = new FakeIngest({ connectAfterMs: 3_600_000 });
    const { inputId } = await fake.createLiveInput({ sessionId: randomUUID(), slot: 0 } as Parameters<FakeIngest["createLiveInput"]>[0]);
    setRelayDriversForTest({ ingest: fake, runner: new FakeRunner() });
    expect((await call("fake-in-0-nope", { state: "connected" })).status).toBe(404);
    expect((await call(inputId, { state: "streaming" })).status).toBe(400);
    expect((await call(inputId, {})).status).toBe(400);
    expect((await fake.inputStatus(inputId)).state, "nothing flipped yet").toBe("disconnected");
    const res = await call(inputId, { state: "connected" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, data: { inputId, state: "connected" } });
    expect((await fake.inputStatus(inputId)).state).toBe("connected");
  });

  it("Seazn Task 19, with both set: { recording: \"ready\" } finishes one recording of a known input and answers its id; an unknown input is 404, and a mixed or wrong body is 400, none of them adding a video", async () => {
    vi.stubEnv("RELAY_DRIVERS", "fake");
    vi.stubEnv("ENV_NAME", "local");
    const fake = new FakeIngest();
    const { inputId } = await fake.createLiveInput({ sessionId: randomUUID(), slot: 0, role: "programme" });
    setRelayDriversForTest({ ingest: fake, runner: new FakeRunner() });
    expect((await call("fake-in-0-nope", { recording: "ready" })).status).toBe(404);
    expect((await call(inputId, { recording: "inprogress" })).status).toBe(400);
    expect((await call(inputId, { recording: "ready", state: "connected" })).status, "one control per call").toBe(400);
    expect(await fake.listInputVideos(inputId), "EMPTY CASE FIRST: no refused call added a video").toEqual([]);
    const res = await call(inputId, { recording: "ready" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; data: { inputId: string; videoId: string } };
    expect(body.ok).toBe(true);
    expect(body.data.inputId).toBe(inputId);
    expect((await fake.listInputVideos(inputId)).map((v) => [v.videoId, v.state, v.signed]), "the answered id IS the video the fake now holds").toEqual([
      [body.data.videoId, "ready", false],
    ]);
    expect((await fake.inputStatus(inputId)).state, "the recording control leaves the input's state alone").toBe("disconnected");
  });
});

describe.skipIf(!HAS_DB)("the seam: the route's flip is what the NEXT TICK reads", () => {
  const savedKek = process.env.RELAY_KEK;
  afterEach(() => {
    if (savedKek === undefined) delete process.env.RELAY_KEK;
    else process.env.RELAY_KEK = savedKek;
  });

  it("a warming session whose fake would not connect for an hour goes live on the tick after the route flips it connected — and is read disconnected after a flip back", async () => {
    process.env.RELAY_KEK = randomBytes(32).toString("hex");
    vi.stubEnv("RELAY_DRIVERS", "fake");
    vi.stubEnv("ENV_NAME", "local");
    const seeded = await seedOrg();
    const auth = { ...seeded.auth, userId: await rigUser() };
    const { fixtureId } = await startedDivisionWithFixture(auth);
    await sql`insert into org_entitlement_overrides (org_id, feature_key, bool_value, reason) values (${auth.orgId}, 'streaming.relay', true, 't7 unit')
              on conflict (org_id, feature_key) do update set bool_value = true`;
    await invalidateOrgEntitlements(auth.orgId);
    await grantCredits({ orgId: auth.orgId, delta: 1, createdBy: await rigUser(), note: "unit", idempotencyKey: randomUUID() });
    const target = await createStreamTarget(auth, auth.orgId, { kind: "youtube", label: "T", streamKey: "k", watchUrl: "https://www.youtube.com/watch?v=fake" });
    let now = Date.now();
    const fake = new FakeIngest({ clock: () => now, connectAfterMs: 3_600_000 });
    fake.storage = { totalStorageMinutes: 0, totalStorageMinutesLimit: 100_000_000, videoCount: 0 };
    const drivers = { ingest: fake, runner: new FakeRunner() };
    setRelayDriversForTest(drivers);   // the route reaches the SAME fake the session's deps use, as a server's singleton does
    const deps: SessionDeps = { drivers, now: () => new Date(now), appUrl: "http://app.test" };
    await pairPresentPhone(fixtureId, { at: deps.now() });
    const { sessionId } = await createSession(auth, fixtureId, { mode: "passthrough", targetId: target.id }, deps);
    const [{ ingest_input_id: inputId }] = await sql<{ ingest_input_id: string }[]>`select ingest_input_id from fixture_stream_inputs where session_id = ${sessionId}`;
    expect((await tickSession(sessionId, deps, "beat")).session?.state, "PREMISE: not connected on its own").toBe("warming");
    expect((await call(inputId, { state: "connected" })).status).toBe(200);
    now += STREAM_POLL_MS;   // the next claim window
    const live = await tickSession(sessionId, deps, "beat");
    expect(live.session?.state).toBe("live");
    expect(live.ingestState?.state).toBe("connected");
    expect((await call(inputId, { state: "disconnected" })).status).toBe(200);
    now += STREAM_POLL_MS;
    expect((await tickSession(sessionId, deps, "beat")).ingestState?.state).toBe("disconnected");
  });
});

// Seazn Task 19: the recording the route finishes is what the stream tick's Seazn lock pass finds on the session's PROGRAMME input,
// locks (requireSignedVideo) and records in seazn_locked_videos — the row the public video route signs as the interim replay.
describe.skipIf(!HAS_DB)("the seam: the route's recording is what the Seazn lock pass locks", () => {
  installSeaznEnvForDescribe("fake-ingest-route");

  it("a stopped Seazn session's programme input: the lock pass finds nothing before the route's recording and locks it after", async () => {
    vi.stubEnv("RELAY_DRIVERS", "fake");
    vi.stubEnv("ENV_NAME", "ci");
    const r = await seaznRig();
    const ingest = r.deps.drivers.ingest as FakeIngest;
    setRelayDriversForTest(r.deps.drivers);   // the route reaches the SAME fake the session's deps use, as a server's singleton does
    const [fixtureId] = r.fixtureIds;
    const sid = await live(r, fixtureId, r.seazn);
    await stopAndSettle(r, fixtureId, sid);
    const inputs = await sql<{ id: string; uid: string }[]>`
      select id, ingest_input_id as uid from fixture_stream_inputs where session_id = ${sid} and role = 'programme'`;
    expect(inputs, "PREMISE: the composed Seazn session has one programme input").toHaveLength(1);
    const pass = () => lockSeaznRecordings(r.deps, { now: r.deps.now(), budgetMs: SEAZN_PASS_BUDGET_MS, orgIds: [r.auth.orgId] });
    expect((await pass()).locked, "EMPTY CASE FIRST: no recording yet, nothing locked").toBe(0);
    const res = await call(inputs[0]!.uid, { recording: "ready" });
    expect(res.status).toBe(200);
    const { videoId } = ((await res.json()) as { data: { videoId: string } }).data;
    expect(ingest.videoAccess(videoId), "PREMISE: the recording arrives unsigned (C3)").toBe(false);
    expect((await pass()).locked).toBe(1);
    expect(ingest.videoAccess(videoId), "locked: it now needs a signed token to play").toBe(true);
    const rows = await sql<{ input_row_id: string }[]>`select input_row_id from seazn_locked_videos where cf_video_id = ${videoId}`;
    expect(rows.map((x) => x.input_row_id), "one locked row, on the programme input").toEqual([inputs[0]!.id]);
  });
});
