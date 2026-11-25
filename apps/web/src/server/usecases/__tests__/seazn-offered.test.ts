// Seazn-hosted video, Phase 4 Task 33: the organisation's Seazn switch (V559, `org_stream_targets.offered` on the org's Seazn row).
// The owner's rulings (2026-11-23/24, ledger) are the expectations here, never the code under test:
//   - default ON; it gates only NEW Seazn picks and starts;
//   - off never stops a live Seazn stream, and Stop still works;
//   - off keeps every recording and replay playable, downloadable and deletable;
//   - off: a SAVED Seazn pick resolves to "pick a destination" (null); an unpicked fixture whose default was Seazn falls to the
//     org's next destination (today's LIVE-off rule);
//   - SEAZN_HOSTED_LIVE stays the master: LIVE off hides Seazn whatever the switch says.
// Every start goes through a REAL producer: the organiser's Go live (`createSession`), the phone's start (`postStart`) and the automatic
// start (a beat through `postBeat` → `maybeAutoStart`). The refusal code is the declaration's (`SEAZN_UNAVAILABLE`); the provider-call
// sets are the spec's (stream-sessions.seazn.test.ts states them the same way).
//
// ONE SPORT, on purpose (TEST-STRATEGY rule 6): the switch is a destination fact and reads no sport rule; every rig rides `generic`.
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/sentry", () => ({ captureError: vi.fn() }));

import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { SEAZN_UNAVAILABLE } from "@/lib/stream-destinations";
import { CaptureBeat } from "@/server/api-v1/capture-schemas";
import { CaptureRefusalError } from "@/server/api-v1/capture-http";
import { AUTO_START_RETRY_SECONDS } from "@/server/relay/config";
import type { RelayDrivers } from "@/server/relay/drivers";
import type { FakeIngest } from "@/server/relay/fakes";
import { createPlaybackTokenCache } from "@/server/video/cf-playback";
import { deleteSeaznReplay, seaznReplayDownload } from "@/server/video/organiser-replays";
import { FakeReplayHost } from "@/server/video/replay-fake";
import { seaznFixtureVideo } from "@/server/video/seazn-video";
import { movedReplays } from "@/server/video/__tests__/_seazn-replay-rig";
import { installSeaznEnv, live, seaznRig, stateOf, stopAndSettle, type SeaznRig } from "@/server/video/__tests__/_seazn-session-rig";
import { pairPresentPhone } from "@/server/relay/__tests__/_session-rig";
import { FakeYouTube } from "@/server/youtube/fake";
import { connect } from "@/server/youtube/__tests__/_connect-rig";
import { postBeat, postStart } from "../capture-phone";
import { fixtureStreamTarget, saveStreamSettings } from "../stream-codes";
import { type SessionDeps, createSession, heartbeat, tickSession } from "../stream-sessions";
import { listStreamTargets, seaznOfferOf, setSeaznOffered } from "../stream-targets";
import { captureRig, phoneId } from "./_capture-rig";

const HAS_DB = !!process.env.DATABASE_URL;
const SEC = 1000;
const MIN = 60 * SEC;
installSeaznEnv("seazn-offered");

/** Every relay port call in ORDER (`ingest.<method>` / `runner.<method>`): what a start asked of the provider. */
function traced(drivers: RelayDrivers): { drivers: RelayDrivers; calls: string[] } {
  const calls: string[] = [];
  const wrap = <T extends object>(port: T, name: string): T => new Proxy(port, {
    get(t, p) {
      const v = Reflect.get(t, p, t) as unknown;
      if (typeof v !== "function") return v;
      return (...args: unknown[]) => { calls.push(`${name}.${String(p)}`); return (v as (...a: unknown[]) => unknown).apply(t, args); };
    },
  });
  return { drivers: { ingest: wrap(drivers.ingest, "ingest"), runner: wrap(drivers.runner, "runner") }, calls };
}
/** The session rig (two started fixtures, a pasted YouTube key OLDER than the Seazn row so "Seazn first" is the rule's doing), with
 *  its provider calls traced. */
async function rig() {
  const r = await seaznRig();
  await sql`update org_stream_targets set created_at = now() - interval '5 hours' where id = ${r.pasted}`;
  const t = traced(r.deps.drivers);
  const deps: SessionDeps = { ...r.deps, drivers: t.drivers };
  return { ...r, deps, calls: t.calls };
}
type Rig = Awaited<ReturnType<typeof rig>>;

const refusalOf = (p: Promise<unknown>): Promise<unknown> => p.then(() => null, (e: unknown) => e);
const wire = (e: unknown) => (e instanceof HttpError ? { status: e.status, code: e.code } : e instanceof CaptureRefusalError ? { status: e.status, code: e.code } : e);
const sessionsOn = async (fixtureId: string) =>
  (await sql<{ id: string; destination_kind: string | null; target_id: string }[]>`
    select id, destination_kind, target_id from fixture_stream_sessions where fixture_id = ${fixtureId} order by created_at`);
const settingsRows = (fixtureId: string) => sql`select 1 from fixture_stream_settings where fixture_id = ${fixtureId}`;
const pickOf = (orgId: string, fixtureId: string) => fixtureStreamTarget(sql, { orgId, fixtureId });
const listedIds = async (r: Rig) => (await listStreamTargets(r.auth, r.auth.orgId)).map((t) => t.id);
const goLive = async (r: Rig, fixtureId: string, body: { mode: "passthrough" | "composed"; targetId: string }, deps: SessionDeps = r.deps) => {
  await pairPresentPhone(fixtureId, { at: deps.now() });
  return createSession(r.auth, fixtureId, body, deps);
};
const off = (r: { auth: Rig["auth"] }) => setSeaznOffered(r.auth, r.auth.orgId, false);
const on = (r: { auth: Rig["auth"] }) => setSeaznOffered(r.auth, r.auth.orgId, true);
/** Task 33 fix round 1 (m1): `deps` whose FIRST storage read runs `flip` before answering. For a Seazn start that read is the one
 *  provider call between `startBroadcast`'s early `isSeaznTarget` read and admission's target row lock (no probe and no YouTube prepare
 *  for Seazn), so `flip` commits a switch-off exactly inside the window the review named. `flipped()` is how many reads ran it. */
function flipAtStorageRead(deps: SessionDeps, flip: () => Promise<unknown>): { deps: SessionDeps; flipped: () => number } {
  let flipped = 0;
  const ingest = new Proxy(deps.drivers.ingest, {
    get(t, p) {
      const v = Reflect.get(t, p, t) as unknown;
      if (p !== "storageUsage" || typeof v !== "function") return v;
      return async (...args: unknown[]) => {
        if (flipped++ === 0) await flip();
        return (v as (...a: unknown[]) => unknown).apply(t, args);
      };
    },
  });
  return { deps: { ...deps, drivers: { ...deps.drivers, ingest } }, flipped: () => flipped };
}

describe.skipIf(!HAS_DB)("the org's Seazn switch: read and write (V559)", () => {
  it("default ON; off reads back off; a SECOND off is idempotent; on → off → on round-trips; another org's switch never moves", async () => {
    const a = await rig();
    const b = await rig();
    expect(await seaznOfferOf(a.auth.orgId), "default ON (owner ruling)").toEqual({ offered: true });
    expect(await off(a)).toEqual({ offered: false });
    expect(await seaznOfferOf(a.auth.orgId)).toEqual({ offered: false });
    const [before] = await sql<{ id: string; label: string }[]>`select id, label from org_stream_targets where org_id = ${a.auth.orgId} and kind = 'seazn'`;
    expect(await off(a), "the second off: the same answer").toEqual({ offered: false });
    const [after] = await sql<{ id: string; label: string }[]>`select id, label from org_stream_targets where org_id = ${a.auth.orgId} and kind = 'seazn'`;
    expect(after, "the second off changed nothing else on the row").toEqual(before);
    const seen: boolean[] = [];
    for (const v of [true, false, true]) {
      expect(await setSeaznOffered(a.auth, a.auth.orgId, v)).toEqual({ offered: v });
      seen.push((await seaznOfferOf(a.auth.orgId)).offered);
    }
    expect(seen).toEqual([true, false, true]);
    expect(await seaznOfferOf(b.auth.orgId), "another org's switch is its own").toEqual({ offered: true });
  });

  it("another org's id is 404 and leaves that org's switch alone; an org with no ACTIVE Seazn row is 404 for the read and the write", async () => {
    const a = await rig();
    const b = await rig();
    expect(wire(await refusalOf(setSeaznOffered(a.auth, b.auth.orgId, false)))).toMatchObject({ status: 404 });
    expect(await seaznOfferOf(b.auth.orgId)).toEqual({ offered: true });
    // No product path archives a Seazn row (it is refused 422 seazn_destination_fixed), so the case is made by hand and put back. Archived,
    // not deleted: V541's every-org sweep counts the row whatever its archive state, so a concurrent suite never sees an org without one.
    await sql`update org_stream_targets set archived_at = now() where org_id = ${a.auth.orgId} and kind = 'seazn'`;
    try {
      expect(wire(await refusalOf(seaznOfferOf(a.auth.orgId))), "read").toMatchObject({ status: 404 });
      expect(wire(await refusalOf(setSeaznOffered(a.auth, a.auth.orgId, false))), "write").toMatchObject({ status: 404 });
      const [row] = await sql<{ offered: boolean }[]>`select offered from org_stream_targets where org_id = ${a.auth.orgId} and kind = 'seazn'`;
      expect(row, "the refused write touched nothing").toEqual({ offered: true });
    } finally {
      await sql`update org_stream_targets set archived_at = null where org_id = ${a.auth.orgId} and kind = 'seazn'`;
    }
  });
});

describe.skipIf(!HAS_DB)("off gates NEW picks and starts (LIVE on)", () => {
  it("the list and the picker: off leaves Seazn out and the unpicked default falls to the next destination; a SAVED Seazn pick resolves none; on again resolves it back", async () => {
    const r = await rig();
    const other = await rig();
    const [f1, f2] = r.fixtureIds;
    await saveStreamSettings(r.auth, f2, { targetId: r.seazn });
    expect(await listedIds(r), "on: Seazn first").toEqual([r.seazn, r.pasted]);
    expect(await pickOf(r.auth.orgId, f1), "on: the unpicked default is Seazn").toMatchObject({ id: r.seazn, source: "default" });
    await off(r);
    expect(await listedIds(r), "off: the list has no Seazn").toEqual([r.pasted]);
    expect(await pickOf(r.auth.orgId, f1), "off: the unpicked default is the next destination").toMatchObject({ id: r.pasted, source: "default" });
    expect(await pickOf(r.auth.orgId, f2), "off: a saved Seazn pick is 'pick a destination', never another one").toBeNull();
    const [kept] = await sql<{ target_chosen: boolean; target_id: string }[]>`select target_chosen, target_id from fixture_stream_settings where fixture_id = ${f2}`;
    expect(kept, "the pick itself is kept").toEqual({ target_chosen: true, target_id: r.seazn });
    expect((await listStreamTargets(other.auth, other.auth.orgId)).map((t) => t.id), "another org, still on, lists its Seazn first").toEqual([other.seazn, other.pasted]);
    await on(r);
    expect(await pickOf(r.auth.orgId, f2), "on again: the saved pick resolves back").toMatchObject({ id: r.seazn, source: "saved" });
    expect(await listedIds(r)).toEqual([r.seazn, r.pasted]);
  });

  it("PUT pick: off naming Seazn is 422 seazn_unavailable and writes nothing; a pasted pick still saves; on again the Seazn pick saves", async () => {
    const r = await rig();
    const [f1, f2] = r.fixtureIds;
    await off(r);
    expect(wire(await refusalOf(saveStreamSettings(r.auth, f1, { targetId: r.seazn })))).toEqual({ status: 422, code: SEAZN_UNAVAILABLE });
    expect(await settingsRows(f1), "nothing written").toHaveLength(0);
    expect(await saveStreamSettings(r.auth, f2, { targetId: r.pasted }), "the pasted pick saves").toMatchObject({ targetId: r.pasted });
    await on(r);
    expect(await saveStreamSettings(r.auth, f1, { targetId: r.seazn }), "on: the Seazn pick saves").toMatchObject({ targetId: r.seazn });
  });

  it("the organiser's Go live naming Seazn, off: 422 seazn_unavailable in both modes, zero provider calls, no row; on again the same start is admitted", async () => {
    const r = await rig();
    const [f1] = r.fixtureIds;
    await off(r);
    for (const mode of ["passthrough", "composed"] as const) {
      expect(wire(await refusalOf(goLive(r, f1, { mode, targetId: r.seazn }))), mode).toEqual({ status: 422, code: SEAZN_UNAVAILABLE });
    }
    expect(r.calls, "no provider call").toEqual([]);
    expect(await sessionsOn(f1), "no session row").toEqual([]);
    await on(r);
    await goLive(r, f1, { mode: "passthrough", targetId: r.seazn });
    expect((await sessionsOn(f1)).map((s) => s.destination_kind), "the positive pair: the switch was the refusal").toEqual(["seazn"]);
  });

  it("fix round 1 (m1): a switch-off that commits BETWEEN the start's early read and admission's row lock is refused there — 422 seazn_unavailable, no row, only the storage read asked; on again the same start is admitted", async () => {
    const r = await rig();
    const [f1] = r.fixtureIds;
    expect(await seaznOfferOf(r.auth.orgId), "PREMISE: the early read sees the switch on").toEqual({ offered: true });
    const raced = flipAtStorageRead(r.deps, () => off(r));
    expect(wire(await refusalOf(goLive(r, f1, { mode: "composed", targetId: r.seazn }, raced.deps)))).toEqual({ status: 422, code: SEAZN_UNAVAILABLE });
    expect(raced.flipped(), "PREMISE: the switch went off inside the window (once)").toBe(1);
    expect(await seaznOfferOf(r.auth.orgId), "PREMISE: the off committed").toEqual({ offered: false });
    expect(r.calls, "nothing asked of the provider past the storage read").toEqual(["ingest.storageUsage"]);
    expect(await sessionsOn(f1), "no session row").toEqual([]);
    await on(r);
    r.calls.length = 0;
    await goLive(r, f1, { mode: "composed", targetId: r.seazn });
    expect((await sessionsOn(f1)).map((s) => s.destination_kind), "the positive pair: on, the same start is admitted").toEqual(["seazn"]);
  });

  it("LIVE off is the master: offered true still hides Seazn from the list and the pick, and refuses the PUT and the start", async () => {
    const r = await rig();
    const [f1, f2] = r.fixtureIds;
    await saveStreamSettings(r.auth, f2, { targetId: r.seazn });
    vi.stubEnv("SEAZN_HOSTED_LIVE", "false");
    expect(await seaznOfferOf(r.auth.orgId), "PREMISE: the switch is on").toEqual({ offered: true });
    expect(await listedIds(r)).toEqual([r.pasted]);
    expect(await pickOf(r.auth.orgId, f1)).toMatchObject({ id: r.pasted, source: "default" });
    expect(await pickOf(r.auth.orgId, f2)).toBeNull();
    expect(wire(await refusalOf(saveStreamSettings(r.auth, f1, { targetId: r.seazn })))).toEqual({ status: 422, code: SEAZN_UNAVAILABLE });
    expect(wire(await refusalOf(goLive(r, f1, { mode: "composed", targetId: r.seazn })))).toEqual({ status: 422, code: SEAZN_UNAVAILABLE });
    expect(r.calls).toEqual([]);
  });

  it("regression (G1): off, a pasted-key start and a YouTube start make the provider calls they always made", async () => {
    const r = await rig();
    const [f1, f2] = r.fixtureIds;
    await off(r);
    await goLive(r, f1, { mode: "passthrough", targetId: r.pasted });
    expect(r.calls, "pasted passthrough (spec C9)").toEqual(["ingest.storageUsage", "ingest.createLiveInput", "ingest.addOutput"]);
    r.calls.length = 0;
    const yt = await connect({ auth: r.auth, orgId: r.auth.orgId, userId: r.auth.userId! });
    const fake = new FakeYouTube();
    await goLive(r, f2, { mode: "passthrough", targetId: yt.targetId }, { ...r.deps, youtube: fake });
    expect(r.calls, "YouTube passthrough").toEqual(["ingest.storageUsage", "ingest.createLiveInput", "ingest.addOutput"]);
    expect(fake.calls.filter((c) => c.method === "insertBroadcast"), "one broadcast prepared at YouTube").toHaveLength(1);
    expect((await sessionsOn(f2)).map((s) => s.destination_kind)).toEqual(["youtube"]);
  });
});

// ── the phone's start and the automatic start (their real callers) ────────────────────────────────────────────────────────────
async function phoneRig() {
  const r = await captureRig({ credits: 3 });
  const [seazn] = await sql<{ id: string }[]>`select id from org_stream_targets where org_id = ${r.auth.orgId} and kind = 'seazn'`;
  await sql`update org_stream_targets set created_at = now() - interval '5 hours' where id = ${r.target.id}`;
  const t = traced(r.deps.drivers);
  r.deps.drivers = t.drivers;
  await sql`update fixtures set status = 'in_play' where id = ${r.fixtureId}`;
  return { ...r, seazn: seazn!.id, calls: t.calls };
}
type PhoneRig = Awaited<ReturnType<typeof phoneRig>>;
async function beat(r: PhoneRig, phone: string, over: Record<string, unknown> = {}) {
  return postBeat(r.code, r.tok, CaptureBeat.parse({
    code: r.code, slot: 0, phone, claim: null, device: null, sid: null, at: r.now().toISOString(), state: "paired",
    cause: null, notReady: null, startFailed: null, stopped: null, mode: "automatic", transport: null, bitrateKbps: null,
    delivery: "unknown", deliveredLagS: null, audioOk: null, battery: null, thermal: null, dataUsedMB: null,
    appVersion: "seazn-offered/1", ...over,
  }), r.deps, r.now());
}

describe.skipIf(!HAS_DB)("off: the phone's start and the automatic start", () => {
  it("the PHONE start on a saved Seazn pick, off: 409 no_destination, zero provider calls, no row; on again it starts on Seazn", async () => {
    const r = await phoneRig();
    const phone = phoneId("p");
    await beat(r, phone, { claim: "new", mode: "operator" });
    await saveStreamSettings(r.auth, r.fixtureId, { targetId: r.seazn });
    await off(r);
    expect(wire(await refusalOf(postStart(r.code, r.tok, { phone }, r.deps, r.now())))).toEqual({ status: 409, code: "no_destination" });
    expect(r.calls, "no provider call").toEqual([]);
    expect(await sessionsOn(r.fixtureId)).toEqual([]);
    await on(r);
    await postStart(r.code, r.tok, { phone }, r.deps, r.now());
    expect((await sessionsOn(r.fixtureId)).map((s) => s.destination_kind)).toEqual(["seazn"]);
  });

  it("the AUTOMATIC start, off: a saved Seazn pick is refused no_destination with no row; an UNPICKED fixture starts on the next destination", async () => {
    const saved = await phoneRig();
    const phone = phoneId("a");
    await beat(saved, phone, { claim: "new", mode: "operator" });
    await saveStreamSettings(saved.auth, saved.fixtureId, { autoStream: true, targetId: saved.seazn });
    await off(saved);
    await beat(saved, phone);
    const [refused] = await sql<{ auto_start_refusal: string | null }[]>`select auto_start_refusal from fixture_stream_settings where fixture_id = ${saved.fixtureId}`;
    expect(refused!.auto_start_refusal, "the automatic start ran and was refused").toBe("no_destination");
    expect(await sessionsOn(saved.fixtureId)).toEqual([]);
    expect(saved.calls).toEqual([]);
    // Fix round 1 (m3), the positive pair: on again, the next retry (after the spacing) starts on Seazn and clears the stored refusal —
    // nothing latches the refusal across the switch.
    await on(saved);
    saved.tick(AUTO_START_RETRY_SECONDS * SEC);
    await beat(saved, phone);
    expect((await sessionsOn(saved.fixtureId)).map((s) => s.destination_kind), "on again: the retry starts on Seazn").toEqual(["seazn"]);
    const [cleared] = await sql<{ auto_start_refusal: string | null }[]>`select auto_start_refusal from fixture_stream_settings where fixture_id = ${saved.fixtureId}`;
    expect(cleared!.auto_start_refusal, "the stored refusal is cleared by the start").toBeNull();

    const unpicked = await phoneRig();
    const phone2 = phoneId("b");
    await beat(unpicked, phone2, { claim: "new", mode: "operator" });
    await saveStreamSettings(unpicked.auth, unpicked.fixtureId, { autoStream: true });
    expect(await pickOf(unpicked.auth.orgId, unpicked.fixtureId), "PREMISE: on, the unpicked default is Seazn").toMatchObject({ id: unpicked.seazn });
    await off(unpicked);
    unpicked.tick(AUTO_START_RETRY_SECONDS * SEC);
    await beat(unpicked, phone2);
    expect(await sessionsOn(unpicked.fixtureId), "the next destination, the pasted key").toEqual([
      expect.objectContaining({ destination_kind: "youtube", target_id: unpicked.target.id }),
    ]);
  });
});

describe.skipIf(!HAS_DB)("fix round 1: the automatic start racing a switch-off", () => {
  it("(m1 + m2) the switch goes off after the automatic start resolved its saved Seazn pick but before admission's lock: refused under the lock and STORED as no_destination (the organiser's to fix), never `unavailable`; no row", async () => {
    const r = await phoneRig();
    const phone = phoneId("r");
    await beat(r, phone, { claim: "new", mode: "operator" });
    await saveStreamSettings(r.auth, r.fixtureId, { autoStream: true, targetId: r.seazn });
    expect(await pickOf(r.auth.orgId, r.fixtureId), "PREMISE: on, the pick resolves to Seazn").toMatchObject({ id: r.seazn });
    const raced = flipAtStorageRead(r.deps, () => off(r));
    r.deps = raced.deps;
    await beat(r, phone);
    expect(raced.flipped(), "PREMISE: the switch went off inside the window (once)").toBe(1);
    const [row] = await sql<{ auto_start_refusal: string | null; auto_started_at: Date | null }[]>`
      select auto_start_refusal, auto_started_at from fixture_stream_settings where fixture_id = ${r.fixtureId}`;
    expect(row, "refused by the lock-time read, stored as the organiser's to fix").toEqual({ auto_start_refusal: "no_destination", auto_started_at: null });
    expect(await sessionsOn(r.fixtureId), "no session row").toEqual([]);
    expect(r.calls, "nothing asked of the provider past the storage read").toEqual(["ingest.storageUsage"]);
  });
});

describe.skipIf(!HAS_DB)("off never touches what already exists", () => {
  it("a LIVE Seazn session keeps running after the switch goes off — the public player stays, a tick and a beat keep it live — and Stop ends it normally", async () => {
    const r: SeaznRig = await seaznRig();
    const [, f2] = r.fixtureIds;
    const sid = await live(r, f2, r.seazn);
    const ingest = r.deps.drivers.ingest as FakeIngest;
    const read = () => seaznFixtureVideo(f2, r.deps.now(), { ingest, tokenCache: createPlaybackTokenCache() });
    expect((await read()).live, "PREMISE: the public page plays it").not.toBeNull();
    await off(r);
    await tickSession(sid, r.deps, "poll");
    const spec = r.runner.created.find((c) => c.sessionId === sid)!;
    await heartbeat(sid, spec.jobToken, { state: "playing" }, r.deps);
    expect(await stateOf(sid), "still live").toBe("live");
    expect((await read()).live, "the public player is still there").not.toBeNull();
    await stopAndSettle(r, f2, sid);
  });

  it("replays stay: off, the public read lists the same parts, Download hands over the file and Delete removes a part", async () => {
    const r = await seaznRig();
    const [f1] = r.fixtureIds;
    const host = new FakeReplayHost();
    const m = await movedReplays(r, f1, host, { parts: 2 });
    const ingest = r.deps.drivers.ingest as FakeIngest;
    const at = new Date(m.t0 + 16 * MIN);
    const parts = async () => (await seaznFixtureVideo(f1, at, { ingest, tokenCache: createPlaybackTokenCache(), replay: host })).replay.map((p) => p.partNo);
    expect(await parts(), "PREMISE: two parts are listed").toEqual([1, 2]);
    await off(r);
    expect(await parts(), "off: the same parts").toEqual([1, 2]);
    const file = await seaznReplayDownload(r.auth, f1, m.rows[0]!.id, { replay: host });
    expect(file.fileName).toMatch(/part-1\.mp4$/);
    await file.body.cancel();
    expect(await deleteSeaznReplay(r.auth, f1, m.rows[1]!.id, { replay: host })).toEqual({ deleted: true });
    expect(await parts(), "the deleted part left").toEqual([1]);
    expect(await seaznOfferOf(r.auth.orgId), "PREMISE: the switch stayed off throughout").toEqual({ offered: false });
  });
});
