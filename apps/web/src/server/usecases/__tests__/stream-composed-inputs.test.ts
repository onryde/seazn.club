// R2004 (compositor plan 2026-10-14; spec §5.3): a COMPOSED session publishes to its own Cloudflare input. The real
// provisioning usecase (createSession → startBroadcast → provisionSession → the `provisioned` effects), on the fakes and
// real Postgres. What this file proves:
//   1. a composed start makes TWO inputs — the camera (A) first, then the programme (B) — and the destination output
//      attaches to B, never A; the passthrough start is the one call and the one row it always was, its output on A;
//   2. every way the second create can fail leaves nothing behind: A is deleted at the provider, the session row goes,
//      the organiser reads 503 ingest_unavailable, no Machine is asked for;
//   3. a composed session's output is released from B when it ends, once;
//   4. storage (owner ruling 2026-10-18, option (a)): both inputs record, so a composed session reserves TWO full matches
//      while it runs and passthrough one; once ended, the camera's recording stays reserved until the sweep deletes it.
//
// ONE SPORT, on purpose (TEST-STRATEGY rule 6): nothing on these paths reads the sport — `_rig`'s generic division. The
// two MODES are what varies, and both appear in every claim that has a passthrough half.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { TARGET_UNREADABLE } from "@/lib/stream-destinations";
import { MAX_DURATION_MINUTES, RECORDING_RETENTION_DAYS } from "@/server/relay/config";
import { FakeIngest, FakeRecorder, FakeRunner } from "@/server/relay/fakes";
import type { IngestCreateSpec, ProviderCallRecorder } from "@/server/relay/ports";
import { pairPresentPhone, rigTarget, rigUser } from "@/server/relay/__tests__/_session-rig";
import { readTargetSecret } from "@/server/relay/secret-columns";
import { seedOrg, startedDivisionWithFixture } from "./_rig";
import { grantCredits } from "../stream-credits";
import { createStreamTarget } from "../stream-targets";
import { type SessionDeps, createSession, currentSession, heartbeat, reconcileSession, sessionFactsForJob, storageReservations, stopSession } from "../stream-sessions";

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

async function rig(opts: { recorder?: ProviderCallRecorder } = {}) {
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
  let now = Date.now();
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
    expect(row!.reserved_minutes, "the ruling: two recordings").toBe(COMPOSED_RECORDINGS * MAX_DURATION_MINUTES);
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
    expect(row!.reserved_minutes).toBe(PASSTHROUGH_RECORDINGS * MAX_DURATION_MINUTES);
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

describe.skipIf(!HAS_DB)("R2004: storage reservations (owner ruling 2026-10-18, option (a))", () => {
  /** This test's own sessions' reservations, read through the admission's own read — never the whole pool. */
  const mine = async (ids: string[], now: Date) =>
    (await storageReservations(sql, now)).filter((x) => ids.includes(x.sessionId)).sort((p, q) => ids.indexOf(p.sessionId) - ids.indexOf(q.sessionId));

  it("while running, composed reserves TWO matches and passthrough ONE; ended, composed keeps ONE (the camera's recording) until the sweep marks it deleted, passthrough none; and never past the retention horizon", async () => {
    const c = await rig();
    const p = await rig();
    const { sessionId: composed } = await c.start("composed");
    const { sessionId: passthrough } = await p.start("passthrough");
    const ids = [composed, passthrough];
    const at = c.deps.now();
    expect(await mine(ids, at)).toEqual([
      { sessionId: composed, minutes: COMPOSED_RECORDINGS * MAX_DURATION_MINUTES },
      { sessionId: passthrough, minutes: PASSTHROUGH_RECORDINGS * MAX_DURATION_MINUTES },
    ]);
    // Both end (the row state is the fact the reservation reads).
    await sql`update fixture_stream_sessions set state = 'completed', ended_at = ${at} where id in ${sql(ids)}`;
    expect(await mine(ids, at), "ended: the camera's recording is still on the account until it is deleted").toEqual([
      { sessionId: composed, minutes: MAX_DURATION_MINUTES },
    ]);
    // The sweep's mark releases it.
    await sql`update fixture_stream_inputs set recordings_deleted_at = ${at} where session_id = ${composed} and role = 'camera'`;
    expect(await mine(ids, at), "released only once the camera's recordings are deleted").toEqual([]);
    // The bound: unmarked, but past the retention horizon (retention has deleted the recordings by then) — released.
    await sql`update fixture_stream_inputs set recordings_deleted_at = null where session_id = ${composed} and role = 'camera'`;
    const horizon = new Date(at.getTime() + RECORDING_RETENTION_DAYS * 86_400_000);
    expect(await mine(ids, new Date(horizon.getTime() - 1000)), "still inside the horizon").toHaveLength(1);
    expect(await mine(ids, new Date(horizon.getTime() + 1000)), "past it: nothing reserved").toEqual([]);
  });

  it("the empty cases: a composed session that never got its camera input reserves nothing once ended; a FAILED composed session is ended too", async () => {
    const r = await rig();
    const { sessionId } = await r.start("composed");
    const at = r.deps.now();
    await sql`update fixture_stream_sessions set state = 'failed', fail_reason = 'machine_crash', ended_at = ${at} where id = ${sessionId}`;
    expect(await mine([sessionId], at), "failed is terminal: the camera's share stays").toEqual([{ sessionId, minutes: MAX_DURATION_MINUTES }]);
    await sql`update fixture_stream_inputs set ingest_input_id = null where session_id = ${sessionId} and role = 'camera'`;
    expect(await mine([sessionId], at), "no camera input at the provider: nothing recorded, nothing reserved").toEqual([]);
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
