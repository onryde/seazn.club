// R2004 (compositor plan 2026-10-14; spec §5.3): a COMPOSED session publishes to its own Cloudflare input. The real
// provisioning usecase (createSession → startBroadcast → provisionSession → the `provisioned` effects), on the fakes and
// real Postgres. What this file proves:
//   1. a composed start makes TWO inputs — the camera (A) first, then the programme (B) — and the destination output
//      attaches to B, never A; the passthrough start is the one call and the one row it always was, its output on A;
//   2. every way the second create can fail leaves nothing behind: A is deleted at the provider, the session row goes,
//      the organiser reads 503 ingest_unavailable, no Machine is asked for;
//   3. a composed session's output is released from B when it ends, once;
//   4. storage (owner ruling 2026-10-18, option (a)): both inputs record, so a composed session makes TWO recordings while
//      it runs and passthrough one. Owner rulings 2026-10-26: a RUNNING session reserves, per recording, min(its booking,
//      ceil(minutes since it entered warming) + the 30-minute buffer) (E1); an ENDED composed session keeps only the
//      minutes its camera actually ran, rounded up and capped at the booking, until the sweep deletes the recording ("C").
//
// ONE SPORT, on purpose (TEST-STRATEGY rule 6): nothing on these paths reads the sport — `_rig`'s generic division. The
// two MODES are what varies, and both appear in every claim that has a passthrough half.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { TARGET_UNREADABLE } from "@/lib/stream-destinations";
import { FINALISATION_GRACE_SECONDS, MAX_DURATION_MINUTES, PROVISION_TIMEOUT_SECONDS, RECORDING_RETENTION_DAYS, RESERVATION_BUFFER_MINUTES, WARMING_TIMEOUT_MINUTES } from "@/server/relay/config";
import { RECORDINGS_PER_SESSION } from "@/server/relay/domain/credits";
import { FakeIngest, FakeRecorder, FakeRunner } from "@/server/relay/fakes";
import type { IngestCreateSpec, ProviderCallRecorder } from "@/server/relay/ports";
import { pairPresentPhone, rigTarget, rigUser } from "@/server/relay/__tests__/_session-rig";
import { readTargetSecret } from "@/server/relay/secret-columns";
import { seedOrg, startedDivisionWithFixture } from "./_rig";
import { grantCredits } from "../stream-credits";
import { createStreamTarget } from "../stream-targets";
import { ACTIVE_STATES, type SessionDeps, createSession, currentSession, heartbeat, reconcileSession, sessionFactsForJob, storageReservations, stopSession } from "../stream-sessions";

const sentry = vi.hoisted(() => ({ captureError: vi.fn() }));
vi.mock("@/lib/sentry", () => ({ captureError: sentry.captureError }));

// PR #1039 review m2: a switchable fault on ONE statement of the pooled `sql` (the route-cache.test.ts precedent for mocking
// @/lib/db), so a test can make the phone-input disable's camera read throw in the middle of a Stop. A pass-through while
// `match` is null — every other test in this file runs on the real pool.
const dbFault = vi.hoisted(() => ({ match: null as RegExp | null, hits: 0, err: new Error("injected: connection reset by peer") }));
vi.mock("@/lib/db", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/db")>();
  const sql = new Proxy(real.sql, {
    apply(target, thisArg, args: unknown[]) {
      const strings = args[0];
      if (dbFault.match && Array.isArray(strings) && dbFault.match.test(strings.join("?"))) {
        dbFault.hits++;
        return Promise.reject(dbFault.err);
      }
      return Reflect.apply(target as unknown as (...a: unknown[]) => unknown, thisArg, args);
    },
  });
  return { ...real, sql };
});

const HAS_DB = !!process.env.DATABASE_URL;

// The KEK and the compositor image of this file's own (stream-sessions.test.ts precedent), put back afterwards.
const savedKek = process.env.RELAY_KEK;
const savedImage = process.env.RELAY_IMAGE;
beforeAll(() => {
  process.env.RELAY_KEK = randomBytes(32).toString("hex");
  process.env.RELAY_IMAGE = "registry.fly.io/seazn-relay:composed-inputs-test";
});
afterAll(() => {
  if (savedKek === undefined) delete process.env.RELAY_KEK;
  else process.env.RELAY_KEK = savedKek;
  if (savedImage === undefined) delete process.env.RELAY_IMAGE;
  else process.env.RELAY_IMAGE = savedImage;
});

/** A pool no plausible number of foreign reservations exhausts (the pool is ONE account across the test database). */
const ROOMY_STORAGE_MINUTES = 100_000_000;
/** The ruling's numbers (owner, 2026-10-18, option (a)): recordings per session, typed here, never read from the helper. */
const COMPOSED_RECORDINGS = 2;
const PASSTHROUGH_RECORDINGS = 1;

type Mode = "composed" | "passthrough";

async function rig(opts: { recorder?: ProviderCallRecorder; clock?: number } = {}) {
  const seeded = await seedOrg();
  const auth = { ...seeded.auth, userId: await rigUser() };
  const { fixtureId } = await startedDivisionWithFixture(auth);
  for (const key of ["streaming.overlay", "streaming.relay"]) {
    await sql`insert into org_entitlement_overrides (org_id, feature_key, bool_value, reason) values (${auth.orgId}, ${key}, true, 'r2004 unit')
              on conflict (org_id, feature_key) do update set bool_value = true`;
  }
  await invalidateOrgEntitlements(auth.orgId);
  await grantCredits({ orgId: auth.orgId, delta: 2, createdBy: await rigUser(), note: "unit", idempotencyKey: randomUUID() });
  const streamKey = `dest-${randomUUID()}`;
  const target = await createStreamTarget(auth, auth.orgId, { kind: "youtube", label: "T", streamKey });
  let now = opts.clock ?? Date.now();
  const ingest = new FakeIngest({ clock: () => now, connectAfterMs: 10 * 60_000, ...(opts.recorder ? { recorder: opts.recorder } : {}) });
  ingest.storage = { totalStorageMinutes: 0, totalStorageMinutesLimit: ROOMY_STORAGE_MINUTES, videoCount: 0 };
  const runner = new FakeRunner(opts.recorder ? { recorder: opts.recorder } : {});
  const deps: SessionDeps = { drivers: { ingest, runner }, now: () => new Date(now), appUrl: "http://app.test" };
  await pairPresentPhone(fixtureId, { at: new Date(now) });
  const start = (mode: Mode, targetId = target.id) => createSession(auth, fixtureId, { mode, targetId }, deps);
  return { auth, fixtureId, target, streamKey, ingest, runner, deps, start, tick: (ms: number) => { now += ms; } };
}

async function inputs(sessionId: string) {
  return sql<{ role: string; slot: number; ingest_input_id: string | null; has_playback: boolean }[]>`
    select role, slot, ingest_input_id, (playback_srt_url is not null) as has_playback
      from fixture_stream_inputs where session_id = ${sessionId} order by role, slot`;
}
async function sessionRow(sessionId: string) {
  const [r] = await sql<{ ingest_input_uid: string | null; output_uid: string | null; reserved_minutes: number; overlay_delay_ms: number; state: string }[]>`
    select ingest_input_uid, output_uid, reserved_minutes, overlay_delay_ms, state from fixture_stream_sessions where id = ${sessionId}`;
  return r;
}
const destinationOf = async (orgId: string, targetId: string) =>
  (await sql.begin((tx) => readTargetSecret(tx, orgId, targetId))) as { url: string; streamKey: string };

describe.skipIf(!HAS_DB)("R2004: composed provisioning — two inputs, the output on the programme", () => {
  it("composed_creates_two_inputs_and_attaches_output_to_b: the camera then the programme, the output on B and none on A, B is the session's output input", async () => {
    const r = await rig();
    const spy = vi.spyOn(r.ingest, "createLiveInput");
    const { sessionId } = await r.start("composed");
    const specs = spy.mock.calls.map((c) => c[0]);
    expect(specs, "A first (the camera, no role — the passthrough call), then B").toStrictEqual([{ sessionId, slot: 0 }, { sessionId, slot: 0, role: "programme" }]);
    const made = await Promise.all(spy.mock.results.map((x) => x.value as ReturnType<FakeIngest["createLiveInput"]>));
    const [a, b] = made as [Awaited<ReturnType<FakeIngest["createLiveInput"]>>, Awaited<ReturnType<FakeIngest["createLiveInput"]>>];
    expect(await inputs(sessionId)).toEqual([
      { role: "camera", slot: 0, ingest_input_id: a.inputId, has_playback: true },
      { role: "programme", slot: 0, ingest_input_id: b.inputId, has_playback: false },
    ]);
    const dest = await destinationOf(r.auth.orgId, r.target.id);
    expect(r.ingest.outputsFor(b.inputId), "exactly one output, on B, to the destination").toEqual([dest]);
    expect(r.ingest.outputsFor(a.inputId), "none on A").toEqual([]);
    const row = await sessionRow(sessionId);
    expect(row!.ingest_input_uid, "the session's output input is B (its recording is the product)").toBe(b.inputId);
    expect(row!.output_uid).not.toBeNull();
    expect(row!.reserved_minutes, "the ruling: two recordings, each holding the buffer alone at admission (E1)").toBe(COMPOSED_RECORDINGS * RESERVATION_BUFFER_MINUTES);
    // The Machine was asked for, and nothing the runner was handed carries the destination's key (spec §5.3).
    expect(r.runner.created).toHaveLength(1);
    expect(JSON.stringify(r.runner.created[0]), "the destination key never reaches the Machine").not.toContain(r.streamKey);
    // The second call: the fixture is streaming, so a second start is refused and makes no third input.
    await expect(r.start("composed")).rejects.toMatchObject({ code: "active_session" });
    expect(spy, "no input made by the refused start").toHaveBeenCalledTimes(2);
    expect((await sql<{ n: number }[]>`select count(*)::int as n from fixture_stream_inputs where session_id = ${sessionId}`)[0]!.n).toBe(2);
    // Review m4: the ledger says WHICH input each create made — the role survives the payload allowlist.
    const creates = await sql<{ payload: Record<string, unknown> }[]>`
      select payload from fixture_stream_events where session_id = ${sessionId} and kind = 'effect' and type = 'create_live_input' order by seq`;
    expect(creates.map((c) => c.payload), "the camera's create, then the programme's, by role").toEqual([{ slot: 0 }, { slot: 0, role: "programme" }]);
  });

  it("passthrough_provisioning_is_unchanged: ONE create (the same call), ONE camera row with no playback stored, the output on A, one recording reserved", async () => {
    const r = await rig();
    const spy = vi.spyOn(r.ingest, "createLiveInput");
    const { sessionId } = await r.start("passthrough");
    expect(spy.mock.calls.map((c) => c[0])).toStrictEqual([{ sessionId, slot: 0 }]);
    const a = await (spy.mock.results[0]!.value as ReturnType<FakeIngest["createLiveInput"]>);
    expect(await inputs(sessionId)).toEqual([{ role: "camera", slot: 0, ingest_input_id: a.inputId, has_playback: false }]);
    expect(r.ingest.outputsFor(a.inputId), "the output is on A — the passthrough input").toEqual([await destinationOf(r.auth.orgId, r.target.id)]);
    const row = await sessionRow(sessionId);
    expect(row!.ingest_input_uid).toBe(a.inputId);
    expect(row!.reserved_minutes, "one recording's buffer at admission (E1)").toBe(PASSTHROUGH_RECORDINGS * RESERVATION_BUFFER_MINUTES);
    expect(row!.overlay_delay_ms, "the field is unused in this mode: the column default").toBe(0);
    expect(r.runner.created, "passthrough has no Machine").toHaveLength(0);
  });

  it("the programme create FAILS: 503 ingest_unavailable, A deleted at the provider, the session row gone, no Machine; a retry then starts cleanly (sequence)", async () => {
    const r = await rig();
    const real = r.ingest.createLiveInput.bind(r.ingest);
    const made: string[] = [];
    const spy = vi.spyOn(r.ingest, "createLiveInput").mockImplementation(async (spec: IngestCreateSpec) => {
      if (spec.role === "programme") throw Object.assign(new Error("provider 500"), { status: 500 });
      const c = await real(spec);
      made.push(c.inputId);
      return c;
    });
    const err = await r.start("composed").then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err).toMatchObject({ status: 503, code: "ingest_unavailable" });
    expect(made, "PREMISE: A was made before B was asked for").toHaveLength(1);
    expect(r.ingest.deletedInputs, "A is not left behind at the provider").toEqual(made);
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from fixture_stream_sessions where fixture_id = ${r.fixtureId}`;
    expect(n, "no session row").toBe(0);
    expect(r.runner.created, "no Machine").toHaveLength(0);
    // Sequence: the provider recovers; the next start makes both inputs and the output on B.
    spy.mockRestore();
    const { sessionId } = await r.start("composed");
    expect((await inputs(sessionId)).map((i) => i.role)).toEqual(["camera", "programme"]);
  });

  it("a camera input that comes back WITHOUT an SRT playback credential is refused the same way — A deleted, nothing kept, B never asked for: a composed session the compositor cannot read is not started", async () => {
    const r = await rig();
    const real = r.ingest.createLiveInput.bind(r.ingest);
    const spy = vi.spyOn(r.ingest, "createLiveInput").mockImplementation(async (spec: IngestCreateSpec) => ({ ...(await real(spec)), srtPlayback: null }));
    const err = await r.start("composed").then(() => null, (e: unknown) => e);
    expect(err).toMatchObject({ status: 503, code: "ingest_unavailable" });
    expect(spy, "B was never asked for").toHaveBeenCalledTimes(1);
    expect(r.ingest.deletedInputs).toHaveLength(1);
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from fixture_stream_sessions where fixture_id = ${r.fixtureId}`;
    expect(n).toBe(0);
    // The differential: passthrough never reads the playback credential, so the same provider answer starts it.
    const { sessionId } = await r.start("passthrough");
    expect((await inputs(sessionId)).map((i) => i.role)).toEqual(["camera"]);
  });

  it("the CAMERA create failing is the old failure: one create, nothing deleted (nothing was made), 503", async () => {
    const r = await rig();
    const spy = vi.spyOn(r.ingest, "createLiveInput").mockRejectedValueOnce(new Error("provider down"));
    await expect(r.start("composed")).rejects.toMatchObject({ status: 503, code: "ingest_unavailable" });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(r.ingest.deletedInputs).toEqual([]);
  });

  it("a composed session's output is released from B when it ends — once; A never held one", async () => {
    const r = await rig();
    const spy = vi.spyOn(r.ingest, "createLiveInput");
    const { sessionId } = await r.start("composed");
    const [, b] = await Promise.all(spy.mock.results.map((x) => x.value as ReturnType<FakeIngest["createLiveInput"]>));
    const remove = vi.spyOn(r.ingest, "removeOutput");
    const { output_uid } = (await sessionRow(sessionId))!;
    expect((await stopSession(r.auth, r.fixtureId, sessionId, r.deps)).state, "a composed stop flushes the Machine first").toBe("ending");
    expect(remove, "nothing released while the Machine is still flushing").not.toHaveBeenCalled();
    // The fake auto-destroys on the next observation: the organiser's poll observes it gone → completed.
    expect((await currentSession(r.auth, r.fixtureId, r.deps))!.state).toBe("completed");
    expect(remove.mock.calls.map((c) => [c[0], c[1]]), "removed from B, by its uid, once").toEqual([[b!.inputId, output_uid]]);
    // The second read of an ended session releases nothing again.
    await currentSession(r.auth, r.fixtureId, r.deps);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(r.ingest.liveOutputsTo(await destinationOf(r.auth.orgId, r.target.id)), "nothing simulcasts to the destination").toBe(0);
  });

  it("a composed session's PHONE input (A, the camera) is switched OFF when it ends — and only A: B, the programme the compositor publishes into, is never touched; nothing is switched while the Machine is still flushing (ending)", async () => {
    const r = await rig();
    const spy = vi.spyOn(r.ingest, "createLiveInput");
    const { sessionId } = await r.start("composed");
    const [a, b] = await Promise.all(spy.mock.results.map((x) => x.value as ReturnType<FakeIngest["createLiveInput"]>));
    const rows = await inputs(sessionId);
    expect(rows.map((x) => [x.role, x.ingest_input_id]), "premise: A is the camera row, B the programme row").toEqual([["camera", a!.inputId], ["programme", b!.inputId]]);
    // The trap this pins: on a composed session `ingest_input_uid` is B, the OUTPUT input — the camera is found by its role.
    expect((await sessionRow(sessionId))!.ingest_input_uid, "premise: the session's ingest_input_uid is B").toBe(b!.inputId);
    expect(a!.inputId).not.toBe(b!.inputId);

    expect((await stopSession(r.auth, r.fixtureId, sessionId, r.deps)).state).toBe("ending");
    expect(r.ingest.enabledCalls, "the compositor is still reading A while it flushes — nothing is switched yet").toEqual([]);
    expect((await currentSession(r.auth, r.fixtureId, r.deps))!.state).toBe("completed");
    expect(r.ingest.enabledCalls, "A, OFF, once — B never named").toEqual([{ inputId: a!.inputId, enabled: false }]);
    expect(r.ingest.isEnabled(a!.inputId)).toBe(false);
    expect(r.ingest.isEnabled(b!.inputId), "B is untouched").toBe(true);
    await currentSession(r.auth, r.fixtureId, r.deps);
    await stopSession(r.auth, r.fixtureId, sessionId, r.deps);
    expect(r.ingest.enabledCalls, "a second read and a second Stop switch nothing").toHaveLength(1);
  });

  it("SEVERAL camera inputs (PR #1039 m5): every camera slot of a composed session is switched OFF, in slot order, each told its own slot and role (so the adapter can re-send its name) — and the programme input B is never touched (mutant: `limit 1` → the second camera stays on)", async () => {
    const r = await rig();
    const created = vi.spyOn(r.ingest, "createLiveInput");
    const { sessionId } = await r.start("composed");
    const [a, b] = await Promise.all(created.mock.results.map((x) => x.value as ReturnType<FakeIngest["createLiveInput"]>));
    // A second camera slot: today's start inserts one, and a multi-camera session would have more.
    const a2 = await r.ingest.createLiveInput({ sessionId, slot: 1 });
    await sql`insert into fixture_stream_inputs (session_id, slot, ingest_input_id) values (${sessionId}, 1, ${a2.inputId})`;
    expect((await inputs(sessionId)).map((x) => [x.role, x.slot, x.ingest_input_id]), "premise: two cameras and the programme").toEqual([
      ["camera", 0, a!.inputId], ["camera", 1, a2.inputId], ["programme", 0, b!.inputId],
    ]);
    const switched = vi.spyOn(r.ingest, "setInputEnabled");
    await stopSession(r.auth, r.fixtureId, sessionId, r.deps);
    expect((await currentSession(r.auth, r.fixtureId, r.deps))!.state).toBe("completed");
    expect(r.ingest.enabledCalls, "both cameras OFF, in slot order, once each — B never named").toEqual([
      { inputId: a!.inputId, enabled: false }, { inputId: a2.inputId, enabled: false },
    ]);
    expect(switched.mock.calls.map((c) => c[2]), "each call carries the session, its slot and its role").toEqual([
      { sessionId, slot: 0, role: "camera" }, { sessionId, slot: 1, role: "camera" },
    ]);
    expect(r.ingest.isEnabled(a!.inputId) || r.ingest.isEnabled(a2.inputId), "no camera is left on").toBe(false);
    expect(r.ingest.isEnabled(b!.inputId), "B is untouched").toBe(true);
  });

  it("a READ failing inside the disable (PR #1039 m2) never fails the Stop or skips what follows it: the session completes, the replay still fills, and the fault is reported once as a database fault at stage `read` — not as a failed provider call, which nothing attempted", async () => {
    const r = await rig();
    const { sessionId } = await r.start("passthrough");
    r.tick(10 * 60_000 + 1000);
    expect((await currentSession(r.auth, r.fixtureId, r.deps))!.state, "premise: the phone connected and the session is live (so the Stop has a replay to fill)").toBe("live");
    sentry.captureError.mockClear();
    dbFault.hits = 0;
    dbFault.match = /select ingest_input_id as uid, slot from fixture_stream_inputs/;
    let stopped: Awaited<ReturnType<typeof stopSession>>;
    try {
      stopped = await stopSession(r.auth, r.fixtureId, sessionId, r.deps);
    } finally {
      dbFault.match = null;
    }
    expect(dbFault.hits, "the fault was reached — exactly the disable's camera read").toBe(1);
    expect(stopped).toMatchObject({ id: sessionId, state: "completed", endReason: "stopped" });
    expect(r.ingest.enabledCalls, "nothing was attempted").toEqual([]);
    const effects = (await sql<{ type: string; result: string }[]>`select type, result from fixture_stream_events where session_id = ${sessionId} and kind = 'effect' order by seq`).map((e) => `${e.type}:${e.result}`);
    expect(effects, "the effects after the disable's slot still ran").toEqual(expect.arrayContaining(["release_output:ok", "fill_replay:ok"]));
    expect(effects.some((e) => e.startsWith("disable_phone_input")), "no disable row: none was tried").toBe(false);
    const reports = sentry.captureError.mock.calls.filter(([, ctx]) => (ctx as { route?: string }).route?.startsWith("relay.disable_phone_input"));
    expect(reports).toHaveLength(1);
    expect(reports[0]![0]).toBe(dbFault.err);
    expect(reports[0]![1]).toMatchObject({ route: "relay.disable_phone_input_db", extra: { sessionId, stage: "read" } });
  });

  it("ADMISSION backstop, composed: a composed session whose end FAILED to release B's output holds its fixture — the next start is refused 409 active_session while the retry fails, and once it succeeds B's output is released (reason admission) and the start is admitted (mutant: restore the passthrough-only filter → admitted while the old output still simulcasts)", async () => {
    const r = await rig();
    const spy = vi.spyOn(r.ingest, "createLiveInput");
    const { sessionId: old } = await r.start("composed");
    const b = (await spy.mock.results[1]!.value) as Awaited<ReturnType<FakeIngest["createLiveInput"]>>;
    spy.mockRestore();
    const dest = await destinationOf(r.auth.orgId, r.target.id);
    let failing = true;
    const removeOutput = r.ingest.removeOutput.bind(r.ingest);
    const removed: [string, string][] = [];
    const flaky = Object.assign(Object.create(r.ingest) as FakeIngest, {
      async removeOutput(inputId: string, outputId: string) {
        removed.push([inputId, outputId]);
        if (failing) throw new Error("cloudflare remove output: HTTP 503");
        return removeOutput(inputId, outputId);
      },
    });
    const deps: SessionDeps = { ...r.deps, drivers: { ...r.deps.drivers, ingest: flaky } };
    await stopSession(r.auth, r.fixtureId, old, deps);
    expect((await currentSession(r.auth, r.fixtureId, deps))!.state).toBe("completed");
    const { output_uid } = (await sessionRow(old))!;
    expect(r.ingest.liveOutputsTo(dest), "premise: the failed release left B's output simulcasting").toBe(1);
    const refused = await createSession(r.auth, r.fixtureId, { mode: "composed", targetId: r.target.id }, deps).catch((e: unknown) => e);
    expect(refused).toMatchObject({ status: 409, code: "active_session", extra: { sessionId: old } });
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from fixture_stream_sessions where fixture_id = ${r.fixtureId}`;
    expect(n, "nothing created while it holds").toBe(1);
    failing = false;
    const { sessionId: next } = await createSession(r.auth, r.fixtureId, { mode: "composed", targetId: r.target.id }, deps);
    expect(next).not.toBe(old);
    expect(removed.every(([input, uid]) => input === b.inputId && uid === output_uid), "every attempt removed B's output from B").toBe(true);
    expect(removed.length, "the end's try, the refused start's retry, the admitted start's retry").toBe(3);
    expect(r.ingest.liveOutputsTo(dest), "the NEW session's output, alone").toBe(1);
  });

  it("facts refuse BY NAME a composed session whose stored programme or camera playback credential is missing — never a session served with a guessed credential", async () => {
    let checked = 0;
    for (const [missing, message] of [["programme", /no programme input credential/], ["playback", /no camera playback credential/]] as const) {
      const r = await rig();
      const { sessionId } = await r.start("composed");
      const token = r.runner.created[0]!.jobToken;
      await expect(sessionFactsForJob(sessionId, token, r.deps), `${missing}: premise — the facts serve before the wipe`).resolves.toMatchObject({ mode: "composed" });
      // The bare url alone: either half missing is a missing credential, and the sealed half is a stream column only
      // server/relay/** may name (enc-boundary r3).
      if (missing === "programme") await sql`update fixture_stream_inputs set ingest_rtmps_url = null where role = 'programme' and session_id = ${sessionId}`;
      else await sql`update fixture_stream_inputs set playback_srt_url = null where role = 'camera' and session_id = ${sessionId}`;
      await expect(sessionFactsForJob(sessionId, token, r.deps), missing).rejects.toThrow(message);
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("composed + an unreadable destination: 422 TARGET_UNREADABLE with ZERO provider calls — the pre-storage probe answers for composed exactly as for passthrough (M1)", async () => {
    let checked = 0;
    for (const mode of ["passthrough", "composed"] as const) {
      const rec = new FakeRecorder();
      const r = await rig({ recorder: rec });
      const targetId = await rigTarget(r.auth.orgId, "Unreadable", "youtube");   // an envelope that will not open
      const err = await r.start(mode, targetId).then(() => null, (e: unknown) => e);
      expect(err, mode).toMatchObject({ status: 422, code: TARGET_UNREADABLE });
      await new Promise((res) => setImmediate(res));
      expect(rec.calls.map((c) => c.operation), `${mode}: no provider call of any kind, storage included`).toEqual([]);
      checked++;
    }
    expect(checked).toBe(2);
  });
});

describe.skipIf(!HAS_DB)("R2004 + E1 + C: storage reservations (owner rulings 2026-10-18, 2026-10-26)", () => {
  const B = RESERVATION_BUFFER_MINUTES;
  const MAX = MAX_DURATION_MINUTES;
  const MODES = [["passthrough", PASSTHROUGH_RECORDINGS], ["composed", COMPOSED_RECORDINGS]] as const;
  const minutesAfter = (from: Date, minutes: number) => new Date(from.getTime() + minutes * 60_000);
  // Review I1 of PR #1041: an ended session's recordings are still FINALISING for the grace after `ended_at`. `pastGrace` is the
  // first moment (one second beyond it) where only the camera's share is left; `insideGrace` the last (one second before it).
  const GRACE_MS = FINALISATION_GRACE_SECONDS * 1000;
  const pastGrace = (ended: Date) => new Date(ended.getTime() + GRACE_MS + 1000);
  const insideGrace = (ended: Date) => new Date(ended.getTime() + GRACE_MS - 1000);

  /** This test's own sessions' reservations, read through the admission's own read — never the whole pool. */
  const mine = async (ids: string[], now: Date) =>
    (await storageReservations(sql, now)).filter((x) => ids.includes(x.sessionId)).sort((p, q) => ids.indexOf(p.sessionId) - ids.indexOf(q.sessionId));
  /** The one session's reservation minutes at `now`; null when it reserves nothing (absent from the read). */
  const minutesOf = async (id: string, now: Date) => (await mine([id], now))[0]?.minutes ?? null;
  /** The instant a started session entered warming — the start every rule here counts from. */
  const warmingAtOf = async (id: string) => (await sql<{ w: Date }[]>`select warming_at as w from fixture_stream_sessions where id = ${id}`)[0]!.w;
  /** Re-seat a session's timeline directly (the row state is the fact the reservation reads). */
  const timeline = (id: string, t: { state: string; warmingAt: Date | null; startedAt?: Date | null; endedAt?: Date | null }) =>
    sql`update fixture_stream_sessions set state = ${t.state}, warming_at = ${t.warmingAt}, started_at = ${t.startedAt ?? null}, ended_at = ${t.endedAt ?? null} where id = ${id}`;

  // Every session this describe makes is released from the pool afterwards: the ENDED rule keeps a camera's share until its
  // recordings are marked deleted, and a RUNNING one that a far-clock read stopped (`ending`, its Machine "flushing") keeps
  // counting at every later clock. The far-future tests below would leave both for the next test, or the next run, to find.
  const made: string[] = [];
  afterEach(async () => {
    if (made.length) {
      await sql`update fixture_stream_inputs set recordings_deleted_at = now() where session_id in ${sql(made)} and role = 'camera'`;
      await sql`update fixture_stream_sessions set state = 'completed', ended_at = coalesce(ended_at, now()) where id in ${sql(made)} and state in ${sql([...ACTIVE_STATES])}`;
    }
    made.length = 0;
  });
  const startMade = async (r: Awaited<ReturnType<typeof rig>>, mode: Mode) => {
    const { sessionId } = await r.start(mode);
    made.push(sessionId);
    return sessionId;
  };

  it("the ruling's recording counts (1 and 2) and the premises the cases rely on: a buffer smaller than the booking, a warming window longer than the cases tick", () => {
    expect(RECORDINGS_PER_SESSION).toEqual({ passthrough: PASSTHROUGH_RECORDINGS, composed: COMPOSED_RECORDINGS });
    expect(B * COMPOSED_RECORDINGS).toBeLessThan(MAX);
    expect(3, "the warming cases tick 3 minutes, inside the warming timeout").toBeLessThan(WARMING_TIMEOUT_MINUTES);
  });

  it("E1 — a RUNNING session reserves min(booking, ceil(minutes since warming) + buffer) per recording, in BOTH modes: the buffer alone at elapsed 0, a rolling figure while warming and live, capped at the booking, and nothing once the policy expires it", async () => {
    let checked = 0;
    for (const [mode, n] of MODES) {
      const r = await rig();
      const id = await startMade(r, mode);
      const w = await warmingAtOf(id);
      expect(w, `${mode}: PREMISE: createSession stamped warming_at`).toBeInstanceOf(Date);
      // Warming (inputs provisioned, phone may already be publishing): the start has begun, so the elapsed counts.
      expect(await minutesOf(id, w), `${mode} elapsed 0`).toBe(n * B);
      expect(await minutesOf(id, minutesAfter(w, 3)), `${mode} warming 3 min`).toBe(n * (3 + B));
      expect(await minutesOf(id, minutesAfter(w, 2.2)), `${mode} warming 2.2 min rounds UP`).toBe(n * (3 + B));
      // Live: the same start, whatever went live when.
      await timeline(id, { state: "live", warmingAt: w, startedAt: minutesAfter(w, 1) });
      expect(await minutesOf(id, minutesAfter(w, 47.3)), `${mode} live 47.3 min`).toBe(n * (48 + B));
      expect(await minutesOf(id, minutesAfter(w, 47)), `${mode} live exactly 47`).toBe(n * (47 + B));
      // The cap, per recording: the boundary row and both neighbours.
      expect(await minutesOf(id, minutesAfter(w, MAX - B - 1)), `${mode} one minute under the cap`).toBe(n * (MAX - 1));
      expect(await minutesOf(id, minutesAfter(w, MAX - B)), `${mode} at the cap`).toBe(n * MAX);
      expect(await minutesOf(id, minutesAfter(w, MAX - B + 1)), `${mode} past the cap, still running`).toBe(n * MAX);
      // Past the booking's wall clock (measured from started_at) the policy has ended it: it reserves nothing.
      expect(await minutesOf(id, minutesAfter(w, MAX + 5)), `${mode} expired by the wall clock`).toBeNull();
      // A session with no warming_at has not begun: the buffer only (the empty case), never the elapsed since its creation -
      // read minutes AFTER it was created, where "elapsed since creation" would be a different number (review m2).
      await timeline(id, { state: "provisioning", warmingAt: null });
      const [{ created }] = await sql<{ created: Date }[]>`select created_at as created from fixture_stream_sessions where id = ${id}`;
      expect(await minutesOf(id, created), `${mode} provisioning, no warming_at, at creation`).toBe(n * B);
      const nearTimeout = new Date(created.getTime() + (PROVISION_TIMEOUT_SECONDS - 60) * 1000);   // still inside the provision timeout, so still running
      expect(await minutesOf(id, nearTimeout), `${mode} provisioning, no warming_at, ${PROVISION_TIMEOUT_SECONDS - 60} s after creation`).toBe(n * B);
      checked += 13;
    }
    expect(checked, "anti-vacuity: 13 cases in each of two modes").toBe(26);
  });

  it("C — an ENDED composed session reserves the minutes its camera ran, rounded UP and capped at the booking: 6 -> 6, 59.2 -> 60, over the booking -> the booking; ended passthrough nothing; the same session re-read as it is re-dated (the sequence)", async () => {
    const r = await rig();
    const id = await startMade(r, "composed");
    const w = await warmingAtOf(id);
    let checked = 0;
    for (const [ran, want] of [[6, 6], [59.2, 60], [60, 60], [1, 1], [MAX - 1, MAX - 1], [MAX, MAX], [MAX + 1, MAX], [MAX * 2, MAX]] as const) {
      const ended = minutesAfter(w, ran);
      await timeline(id, { state: "completed", warmingAt: w, startedAt: w, endedAt: ended });
      // Read PAST the finalisation grace, where only the camera's share is left (the grace itself has its own test below).
      expect(await minutesOf(id, pastGrace(ended)), `ran ${ran} min`).toBe(want);
      checked++;
    }
    // A FAILED session is ended too, and keeps the same share.
    const failedAt = minutesAfter(w, 6);
    await sql`update fixture_stream_sessions set state = 'failed', fail_reason = 'machine_crash', ended_at = ${failedAt} where id = ${id}`;
    expect(await minutesOf(id, pastGrace(failedAt)), "failed after 6 min").toBe(6);
    checked++;
    // The booking is the session's OWN: a 90-minute booking that ran 100 minutes reserves 90.
    await sql`update fixture_stream_sessions set max_duration_minutes = 90, state = 'completed', fail_reason = null, ended_at = ${minutesAfter(w, 100)} where id = ${id}`;
    expect(await minutesOf(id, pastGrace(minutesAfter(w, 100))), "a 90-minute booking that ran 100").toBe(90);
    checked++;
    await sql`update fixture_stream_sessions set max_duration_minutes = ${MAX} where id = ${id}`;
    // The differential the old rule could not make: the answer moves with the span, not a constant.
    await timeline(id, { state: "completed", warmingAt: w, startedAt: w, endedAt: minutesAfter(w, 7) });
    const seven = await minutesOf(id, pastGrace(minutesAfter(w, 7)));
    await timeline(id, { state: "completed", warmingAt: w, startedAt: w, endedAt: minutesAfter(w, 8) });
    expect(await minutesOf(id, pastGrace(minutesAfter(w, 8))), "8 minutes holds more than 7").toBeGreaterThan(seven!);
    checked++;
    expect(checked, "anti-vacuity: eight spans, the failed end, the shorter booking, the differential").toBe(11);
  });

  it("C — a session that NEVER WARMED recorded nothing and reserves ZERO (review m3); a warmed one whose END is missing, or before its start, is the whole booking; and the release is unchanged — a deleted camera, no camera input at the provider, past the retention horizon: nothing", async () => {
    const r = await rig();
    const id = await startMade(r, "composed");
    const w = await warmingAtOf(id);
    const ended = minutesAfter(w, 6);
    // Never warmed (stopped or failed while provisioning): nothing was ever served a credential, so nothing recorded.
    await timeline(id, { state: "completed", warmingAt: null, startedAt: w, endedAt: ended });
    expect(await minutesOf(id, ended), "no start, inside the grace").toBeNull();
    expect(await minutesOf(id, pastGrace(ended)), "no start, past the grace").toBeNull();
    const [{ created }] = await sql<{ created: Date }[]>`select created_at as created from fixture_stream_sessions where id = ${id}`;
    await timeline(id, { state: "completed", warmingAt: w, startedAt: w, endedAt: null });
    expect(await minutesOf(id, minutesAfter(created, 1)), "no end (the horizon reads created_at)").toBe(MAX);
    await timeline(id, { state: "completed", warmingAt: ended, startedAt: ended, endedAt: w });
    expect(await minutesOf(id, pastGrace(w)), "an end before the start").toBe(MAX);
    // The release rules, unchanged by the amount.
    await timeline(id, { state: "completed", warmingAt: w, startedAt: w, endedAt: ended });
    expect(await minutesOf(id, pastGrace(ended)), "PREMISE: ended 6 minutes after warming").toBe(6);
    const horizon = minutesAfter(ended, RECORDING_RETENTION_DAYS * 24 * 60);
    expect(await minutesOf(id, new Date(horizon.getTime() - 1000)), "still inside the horizon").toBe(6);
    expect(await minutesOf(id, new Date(horizon.getTime() + 1000)), "past it: released").toBeNull();
    await sql`update fixture_stream_inputs set recordings_deleted_at = ${ended} where session_id = ${id} and role = 'camera'`;
    expect(await minutesOf(id, pastGrace(ended)), "released only once the camera's recordings are deleted — AFTER the delete").toBeNull();
    await sql`update fixture_stream_inputs set recordings_deleted_at = null where session_id = ${id} and role = 'camera'`;
    expect(await minutesOf(id, pastGrace(ended)), "unmarked again: held again (the sequence)").toBe(6);
    await sql`update fixture_stream_inputs set ingest_input_id = null where session_id = ${id} and role = 'camera'`;
    expect(await minutesOf(id, pastGrace(ended)), "no camera input at the provider: nothing recorded, nothing reserved").toBeNull();
  });

  it("I1 — an ended COMPOSED session keeps BOTH recordings' span while they finalise (the camera and the programme), the camera alone after the grace: just inside, exactly at, just after; and the camera's release does not end the programme's", async () => {
    const r = await rig();
    const id = await startMade(r, "composed");
    const w = await warmingAtOf(id);
    const ran = 23;
    const ended = minutesAfter(w, ran);
    await timeline(id, { state: "completed", warmingAt: w, startedAt: w, endedAt: ended });
    let checked = 0;
    expect(await minutesOf(id, ended), "the instant it ends").toBe(COMPOSED_RECORDINGS * ran); checked++;
    expect(await minutesOf(id, insideGrace(ended)), "one second inside the grace").toBe(COMPOSED_RECORDINGS * ran); checked++;
    expect(await minutesOf(id, new Date(ended.getTime() + GRACE_MS)), "exactly at the grace: closed, the programme is in Cloudflare's usage").toBe(ran); checked++;
    expect(await minutesOf(id, pastGrace(ended)), "one second after").toBe(ran); checked++;
    // The camera's release is its own: deleted inside the grace leaves the programme alone; deleted after it leaves nothing.
    await sql`update fixture_stream_inputs set recordings_deleted_at = ${ended} where session_id = ${id} and role = 'camera'`;
    expect(await minutesOf(id, insideGrace(ended)), "camera deleted, inside the grace: the programme alone").toBe(ran); checked++;
    expect(await minutesOf(id, pastGrace(ended)), "camera deleted, after the grace: nothing").toBeNull(); checked++;
    // A session that never warmed recorded nothing - inside the grace either.
    await timeline(id, { state: "completed", warmingAt: null, startedAt: null, endedAt: ended });
    expect(await minutesOf(id, ended), "never warmed, inside the grace").toBeNull(); checked++;
    expect(checked, "anti-vacuity: seven boundary reads").toBe(7);
  });

  it("I1 — an ended PASSTHROUGH session keeps its ONE recording's span while it finalises (the hole that predates the rolling rule), nothing after the grace: just inside, exactly at, just after", async () => {
    const p = await rig();
    const id = await startMade(p, "passthrough");
    const w = await warmingAtOf(id);
    expect(await minutesOf(id, w), "PREMISE: running, it reserved").toBe(PASSTHROUGH_RECORDINGS * B);
    const ran = 6;
    const ended = minutesAfter(w, ran);
    await timeline(id, { state: "completed", warmingAt: w, startedAt: w, endedAt: ended });
    expect(await minutesOf(id, ended), "the instant it ends").toBe(PASSTHROUGH_RECORDINGS * ran);
    expect(await minutesOf(id, insideGrace(ended)), "one second inside the grace").toBe(PASSTHROUGH_RECORDINGS * ran);
    expect(await minutesOf(id, new Date(ended.getTime() + GRACE_MS)), "exactly at the grace: closed, the recording is in Cloudflare's usage").toBeNull();
    expect(await minutesOf(id, pastGrace(ended)), "one second after: nothing, whatever it ran").toBeNull();
    // Never warmed: nothing recorded, so nothing to finalise.
    await timeline(id, { state: "completed", warmingAt: null, startedAt: null, endedAt: ended });
    expect(await minutesOf(id, ended), "never warmed, inside the grace").toBeNull();
  });

  // ---- Admission, end to end. Every row below is seated at a clock ~800 days out, far past every other file's rows (which the
  // policy has ended by then, or whose camera shares fall outside the retention horizon of this clock) — with one exception
  // the policy cannot end: a composed session whose Machine was told to stop is counted as `grace_expired` at ANY later
  // clock, so the rows other files leave behind (and are writing right now: vitest runs files in parallel on one database)
  // sit in the same pool. A test that pins the pool's EDGE therefore measures that foreign figure and adds it to its limit,
  // exactly as the C3 tests of stream-sessions.test.ts do (`foreignBaseline`; they jump 400 days, 800 keeps the two apart).
  // `afterEach` releases this describe's own rows so a later run cannot find them.
  const FAR_MS = () => Date.now() + 800 * 86_400_000;
  type Rig = Awaited<ReturnType<typeof rig>>;
  const STG_USAGE_MINUTES = 70.6;   // the owner's reading: Cloudflare's own usage; the columns hold ceil(70.6) = 71
  const STG_USED = Math.ceil(STG_USAGE_MINUTES);
  const STG_LIMIT = 1000;   // the pool's size (minutes)

  /** The reservations of every session that is NOT one of `ids` at `now`: the pool's foreign share. */
  const foreignMinutes = async (ids: string[], now: Date) =>
    (await storageReservations(sql, now)).filter((x) => !ids.includes(x.sessionId)).reduce((sum, x) => sum + x.minutes, 0);

  /** A composed start against a pool whose limit is `net` minutes beyond usage (70.6) and the foreign reservations measured just
   *  before. Resolves to the session id (recorded for `afterEach`) or the refusal. A refusal is trusted only when the foreign
   *  figure did not move across the attempt (a parallel file wrote a reservation between the read and the admission). */
  async function startAgainstPool(r: Rig, ids: string[], net: number): Promise<{ sessionId: string } | { refusal: unknown }> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const before = await foreignMinutes(ids, r.deps.now());
      r.ingest.storage = { totalStorageMinutes: STG_USAGE_MINUTES, totalStorageMinutesLimit: STG_USED + net + before, videoCount: 4 };
      const out = await r.start("composed").then((s) => ({ sessionId: s.sessionId }), (e: unknown) => ({ refusal: e }));
      if ("sessionId" in out) { made.push(out.sessionId); return out; }
      if (await foreignMinutes(ids, r.deps.now()) === before) return out;
    }
    throw new Error("the foreign reservations never settled across 5 attempts");
  }

  /** An ENDED composed session that ran `ran` minutes from `from`, on its own rig (its own fixture). */
  async function endedComposed(from: number, ran: number) {
    const r = await rig({ clock: from });
    const id = await startMade(r, "composed");
    const w = await warmingAtOf(id);
    const ended = minutesAfter(w, ran);
    await timeline(id, { state: "completed", warmingAt: w, startedAt: w, endedAt: ended });
    return { r, id, w, ended };
  }

  it("the OWNER'S STG CASE (2026-10-26): usage 70.6 of 1000, one ended composed session that ran 23 minutes and one that ran 6, nothing running — a new composed start is ADMITTED, holding the buffers, where the full-match reservation refused it", async () => {
    const far = FAR_MS();
    const a = await endedComposed(far, 23);
    const b = await endedComposed(a.ended.getTime(), 6);   // back to back: the second starts the minute the first ended
    // Read once their recordings have finalised (past the grace after the second ended): only the cameras' shares remain.
    expect(await mine([a.id, b.id], pastGrace(b.ended)), "PREMISE: the two ended sessions hold exactly the minutes they ran").toEqual([
      { sessionId: a.id, minutes: 23 }, { sessionId: b.id, minutes: 6 },
    ]);
    const n = await rig({ clock: pastGrace(b.ended).getTime() });
    const started = await startAgainstPool(n, [a.id, b.id], STG_LIMIT - STG_USED);
    expect(started, "a refusal is a red: the pool had room").toHaveProperty("sessionId");
    const sessionId = (started as { sessionId: string }).sessionId;
    const row = await sessionRow(sessionId);
    expect(row!.reserved_minutes, "admitted at the buffers").toBe(COMPOSED_RECORDINGS * B);
    expect(row!.state).toBe("warming");
    // The sequence: a THIRD start after the new one — the fixture is occupied, but the pool is not the reason.
    await expect(n.start("composed")).rejects.toMatchObject({ code: "active_session" });
  });

  it("the OWNER'S STG CASE with a RUNNING stream (E1): usage 70.6 of 1000 and one composed stream 10 minutes in — a second composed start (another fixture) is ADMITTED; the pool's edge sits exactly at the running stream's rolling figure plus the start's buffers", async () => {
    const far = FAR_MS();
    const first = await rig({ clock: far });
    const runningId = await startMade(first, "composed");
    const w = await warmingAtOf(runningId);
    const tenIn = minutesAfter(w, 10);
    await timeline(runningId, { state: "live", warmingAt: w, startedAt: minutesAfter(w, 1) });
    const held = COMPOSED_RECORDINGS * (10 + B);
    expect(await minutesOf(runningId, tenIn), "PREMISE: the running stream holds its rolling figure, not a match").toBe(held);
    const need = COMPOSED_RECORDINGS * B;
    const edge = held + need;   // the headroom beyond usage at which the start fits exactly
    expect(edge, "PREMISE: the running stream under the retired full-match rule (a match per recording) would not fit this pool").toBeLessThan(COMPOSED_RECORDINGS * MAX + need);
    const second = await rig({ clock: tenIn.getTime() });
    const refused = await startAgainstPool(second, [runningId], edge - 1);
    expect(refused, "one minute short of the rolling figure + the buffers").toMatchObject({ refusal: { status: 503, code: "storage_exhausted", extra: { headroomMinutes: need - 1 } } });
    const startedSecond = await startAgainstPool(second, [runningId], STG_LIMIT - STG_USED);
    expect(startedSecond, "the owner's pool (1000 minutes): admitted").toHaveProperty("sessionId");
    expect((await sessionRow((startedSecond as { sessionId: string }).sessionId))!.reserved_minutes, "admitted at the buffers").toBe(need);
    // The sequence: the running stream is still counted after the second began, and nothing in the pool reserves a match.
    expect(await minutesOf(runningId, tenIn)).toBe(held);
  });

  it("the pool's edge, where ONLY the ended rule decides: the same two ended sessions, a pool with exactly the composed start's buffers left is admitted, one minute less is refused 503 storage_exhausted carrying that headroom — and the full-match reservation would have refused the first", async () => {
    const far = FAR_MS();
    const a = await endedComposed(far, 23);
    const b = await endedComposed(a.ended.getTime(), 6);
    const need = COMPOSED_RECORDINGS * B;
    const ranTotal = 23 + 6;
    // headroom beyond usage = (what the two ended sessions hold) + (the start's reservation): the threshold exactly.
    const exact = ranTotal + need;
    expect(exact, "PREMISE: the old reservation (a match each) would not fit this pool at all").toBeLessThan(2 * MAX + need);
    const tight = await rig({ clock: pastGrace(b.ended).getTime() });   // past the grace: only the cameras' shares are left
    const refused = await startAgainstPool(tight, [a.id, b.id], exact - 1);
    expect(refused, "one minute short").toMatchObject({ refusal: { status: 503, code: "storage_exhausted", extra: { headroomMinutes: need - 1 } } });
    const started = await startAgainstPool(tight, [a.id, b.id], exact);
    expect(started, "exactly enough admits").toHaveProperty("sessionId");
    expect((await sessionRow((started as { sessionId: string }).sessionId))!.reserved_minutes, "admitted at the buffers").toBe(need);
  });

  it("I1 — the pool's edge INSIDE the finalisation grace: the next match starts the second the last one ends, and the programme that is still finalising is reserved too - the same pool that admits it past the grace refuses it inside", async () => {
    const far = FAR_MS();
    const a = await endedComposed(far, 23);
    const b = await endedComposed(a.ended.getTime(), 6);
    const need = COMPOSED_RECORDINGS * B;
    // At the instant b ends: a ended 6 minutes ago (past its grace, its camera alone: 23), b is finalising (both recordings: 2 x 6).
    const justEnded = new Date(b.ended.getTime() + 1000);
    expect(await mine([a.id, b.id], justEnded), "PREMISE: a is camera-only, b is finalising").toEqual([
      { sessionId: a.id, minutes: 23 }, { sessionId: b.id, minutes: COMPOSED_RECORDINGS * 6 },
    ]);
    const exactInside = 23 + COMPOSED_RECORDINGS * 6 + need;
    const exactAfter = 23 + 6 + need;
    expect(exactInside, "PREMISE: the grace is what moves the threshold").toBeGreaterThan(exactAfter);
    const quick = await rig({ clock: justEnded.getTime() });
    // A pool sized for the camera-only figure (what the pool would say PAST the grace) is refused while b is still finalising...
    const refused = await startAgainstPool(quick, [a.id, b.id], exactAfter);
    expect(refused, "sized for the post-grace figure: refused inside the grace").toMatchObject({ refusal: { status: 503, code: "storage_exhausted", extra: { headroomMinutes: need - (exactInside - exactAfter) } } });
    // ...and exactly the inside figure admits.
    const started = await startAgainstPool(quick, [a.id, b.id], exactInside);
    expect(started, "sized for the inside figure: admits").toHaveProperty("sessionId");
  });
});

// PR #981 review I3 (coordinator ruling, money): a start whose destination output cannot be added fails CLOSED. Before,
// the throw left the session warming with no destination — a composed one with its Machine booting — and the Machine's
// `playing` (or the phone's connection) then consumed a credit for a broadcast nobody could see.
describe.skipIf(!HAS_DB)("R2004 review I3: a failing addOutput fails the start closed, and a composed go-live without an output is never charged", () => {
  const consumes = async (sessionId: string) =>
    (await sql<{ n: number }[]>`select count(*)::int as n from org_stream_credits where session_id = ${sessionId} and reason = 'consume'`)[0]!.n;
  const routeReports = (route: string) => sentry.captureError.mock.calls.filter(([, c]) => (c as { route?: string }).route === route);

  it("addOutput THROWS, in BOTH modes: 503 ingest_unavailable, the session FAILED output_failed with no output, every input deleted, a composed Machine stopped and gone, no credit — and the retry, with the provider back, streams (mutant: the catch is removed → red)", async () => {
    let checked = 0;
    for (const mode of ["passthrough", "composed"] as const) {
      const r = await rig();
      const made = vi.spyOn(r.ingest, "createLiveInput");
      const add = vi.spyOn(r.ingest, "addOutput").mockRejectedValueOnce(new Error("cloudflare add output: HTTP 503"));
      sentry.captureError.mockClear();
      const err = await r.start(mode).catch((e: unknown) => e);
      expect(err, `${mode}: the organiser's error`).toBeInstanceOf(HttpError);
      expect(err, mode).toMatchObject({ status: 503, code: "ingest_unavailable" });
      expect(add, `${mode}: premise — the add was asked, once`).toHaveBeenCalledTimes(1);
      const [row] = await sql<{ id: string; state: string; fail_reason: string | null; output_uid: string | null; credit_ledger_id: string | null; started_at: Date | null; runner_state: string; machine_id: string | null }[]>`
        select id, state, fail_reason, output_uid, credit_ledger_id, started_at, runner_state, machine_id from fixture_stream_sessions where fixture_id = ${r.fixtureId}`;
      expect(row, `${mode}: the session is kept, FAILED`).toMatchObject({ state: "failed", fail_reason: "output_failed", output_uid: null, credit_ledger_id: null, started_at: null });
      const uids = await Promise.all(made.mock.results.map(async (x) => (await (x.value as ReturnType<FakeIngest["createLiveInput"]>)).inputId));
      expect(uids, `${mode}: premise — the inputs made`).toHaveLength(mode === "composed" ? 2 : 1);
      expect([...r.ingest.deletedInputs].sort(), `${mode}: every input deleted at the provider`).toEqual([...uids].sort());
      if (mode === "composed") {
        expect(r.runner.created, "premise: the Machine was created before the add").toHaveLength(1);
        expect(r.runner.stops.map((x) => x.runnerId), "the Machine is torn down").toEqual([row!.machine_id]);
        // The teardown finishes on the FAILED row (C27): the lazy reconcile observes the stopped Machine, then its absence.
        let looks = 0;
        for (; looks < 4; looks++) {
          const [now] = await sql<{ runner_state: string }[]>`select runner_state from fixture_stream_sessions where id = ${row!.id}`;
          if (now!.runner_state === "destroyed") break;
          await reconcileSession(row!.id, r.deps);
        }
        const [after] = await sql<{ runner_state: string; state: string }[]>`select runner_state, state from fixture_stream_sessions where id = ${row!.id}`;
        expect(after, `gone at the provider, recorded (after ${looks} looks)`).toMatchObject({ runner_state: "destroyed", state: "failed" });
        expect((await r.runner.list()).filter((m) => m.sessionId === row!.id), "no Machine of the session is listed").toEqual([]);
      } else {
        expect(r.runner.created, "passthrough asks for no Machine").toHaveLength(0);
      }
      expect(await consumes(row!.id), `${mode}: no credit`).toBe(0);
      expect(routeReports("relay.add_output"), `${mode}: reported once`).toHaveLength(1);
      // The second call: the provider is back (the one rejection is spent) — a fresh start streams, its output on the
      // mode's output input, and the failed session does not hold the fixture.
      made.mockClear();
      const { sessionId } = await r.start(mode);
      expect(sessionId).not.toBe(row!.id);
      const next = await sessionRow(sessionId);
      expect(next!.state, `${mode}: the retry is up`).not.toBe("failed");
      expect(next!.output_uid, `${mode}: and has its output`).not.toBeNull();
      checked++;
    }
    expect(checked, "anti-vacuity: both modes").toBe(2);
  });

  it("the went_live guard: a COMPOSED session that reaches playing with NO output_uid goes live UNCHARGED — logged and reported by name — while the same session with its output pays exactly once (mutant: the guard is removed → red)", async () => {
    let checked = 0;
    for (const withOutput of [true, false]) {
      const r = await rig();
      const { sessionId } = await r.start("composed");
      if (!withOutput) await sql`update fixture_stream_sessions set output_uid = null where id = ${sessionId}`;
      sentry.captureError.mockClear();
      await heartbeat(sessionId, r.runner.created[0]!.jobToken, { state: "playing" }, r.deps);
      const row = await sessionRow(sessionId);
      expect(row!.state, `output ${withOutput}: live either way`).toBe("live");
      expect(await consumes(sessionId), `output ${withOutput}`).toBe(withOutput ? 1 : 0);
      const reports = routeReports("relay.credits.went_live_without_output");
      expect(reports, `output ${withOutput}: reported only without`).toHaveLength(withOutput ? 0 : 1);
      if (!withOutput) expect(reports[0]![1]).toMatchObject({ extra: { sessionId, code: "composed_live_without_output" } });
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("the guard is composed-only: a PASSTHROUGH session goes live on the phone's connection and pays, whatever the output column says", async () => {
    const r = await rig();
    const { sessionId } = await r.start("passthrough");
    await sql`update fixture_stream_sessions set output_uid = null where id = ${sessionId}`;
    const [{ camera }] = await sql<{ camera: string }[]>`select ingest_input_id as camera from fixture_stream_inputs where session_id = ${sessionId} and role = 'camera'`;
    r.ingest.setState(camera, "connected");   // the phone's connection, as the provider reports it
    await currentSession(r.auth, r.fixtureId, r.deps);
    expect((await sessionRow(sessionId))!.state, "premise: live on the connection").toBe("live");
    expect(await consumes(sessionId)).toBe(1);
  });
});

// #981 follow-up (C07 review; coordinator decision): a composed session's facts carry `/overlay/fixtures/<fixtureId>`, so a
// session must never come to exist without its fixture. A create for a fixture that is gone is refused with the existing
// named shape — 404 "fixture not found" — whether the fixture was gone before the start or vanished while the start was
// weighing it (the insert reads the fixture it copies its facts from; it used to answer a bare TypeError 500 then).
describe.skipIf(!HAS_DB)("#981 follow-up: a start for a fixture that is gone is refused 404 fixture not found — no row, no input, no Machine, no credit", () => {
  const rowsFor = async (fixtureId: string) =>
    (await sql<{ n: number }[]>`select count(*)::int as n from fixture_stream_sessions where fixture_id = ${fixtureId}`)[0]!.n;

  it("the fixture deleted BEFORE the start, in both modes: the entry's 404, and the provider is asked nothing", async () => {
    let checked = 0;
    for (const mode of ["composed", "passthrough"] as const) {
      const r = await rig();
      const made = vi.spyOn(r.ingest, "createLiveInput");
      await sql`delete from fixtures where id = ${r.fixtureId}`;
      const err = await r.start(mode).catch((e: unknown) => e);
      expect(err, mode).toBeInstanceOf(HttpError);
      expect(err, mode).toMatchObject({ status: 404, message: "fixture not found" });
      expect(made, `${mode}: no input`).not.toHaveBeenCalled();
      expect(r.runner.created, `${mode}: no Machine`).toHaveLength(0);
      expect(await rowsFor(r.fixtureId), `${mode}: no row`).toBe(0);
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("the fixture deleted WHILE the start weighs it (during the storage read, after the entry's check): the same 404, never a TypeError 500 — no row, no input, no Machine (mutant: the insert's guard is removed → red)", async () => {
    let checked = 0;
    for (const mode of ["composed", "passthrough"] as const) {
      const r = await rig();
      const made = vi.spyOn(r.ingest, "createLiveInput");
      const read = r.ingest.storageUsage.bind(r.ingest);
      let deleted = 0;
      r.ingest.storageUsage = async () => {
        deleted += (await sql`delete from fixtures where id = ${r.fixtureId}`).count;
        return read();
      };
      const err = await r.start(mode).catch((e: unknown) => e);
      expect(deleted, `${mode}: premise — the fixture went during the start`).toBe(1);
      expect(err, `${mode}: ${String(err)}`).toBeInstanceOf(HttpError);
      expect(err, mode).toMatchObject({ status: 404, message: "fixture not found" });
      expect(made, `${mode}: no input`).not.toHaveBeenCalled();
      expect(r.runner.created, `${mode}: no Machine`).toHaveLength(0);
      expect(await rowsFor(r.fixtureId), `${mode}: no row`).toBe(0);
      checked++;
    }
    expect(checked).toBe(2);
  });
});
