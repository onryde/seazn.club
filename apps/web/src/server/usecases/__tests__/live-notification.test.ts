// Task 27b: `recordLiveNotification`, a Cloudflare live-input notification recorded against the session whose input it names.
//
// The owner's ask (2026-11-22): record every connection drop the moment it happens, not only when a poll catches it. The stream
// tick polls an input every 1 min (prod) / 5 min (stg); a drop and a reconnect inside one gap left no trace. A notification is a
// RECORD, never a decision: the poll stays the decider (warming → live, the phone-lost ends) and D3's `since` is the poll's.
//
// Every session comes from the REAL producers (the organiser's Go live through createSession, the poll through currentSession,
// Stop), on the fake ingest (_seazn-lock-rig.ts). Expected values come from the sequence each test drives and from Cloudflare's
// own vocabulary (relay/cf-live-notification.ts's contract), never from the module under test.
// ONE SPORT, on purpose (TEST-STRATEGY rule 6): a live-input notification reads no sport rule; every rig rides `generic`.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/sentry", () => ({ captureError: vi.fn() }));

import { sql } from "@/lib/db";
import { STREAM_POLL_MS } from "@/lib/stream-session-view";
import { log } from "@/server/logger";
import type { IngestState } from "@/server/relay/ports";
import { pairPresentPhone } from "@/server/relay/__tests__/_session-rig";
import { createSession, currentSession, recordLiveNotification } from "../stream-sessions";
import { createStreamTarget } from "../stream-targets";
import { HAS_DB, type Rig, inputOf, installSeaznLockEnv, live, rig, stateOf, stopAndSettle } from "./_seazn-lock-rig";

installSeaznLockEnv();

type Note = { inputUid: string; event: string; word: IngestState; reason: string | null; at: Date | null };
const note = (inputUid: string, event: "connected" | "disconnected" | "errored", at: Date | null, reason: string | null = null): Note => ({
  inputUid, event: `live_input.${event}`, word: event === "errored" ? "unknown" : event, reason, at,
});

/** A passthrough session on its own destination, gone live through the real poll: the fake input connects 3 s after creation.
 *  `key` steers the fake destination (FakeIngest: `connecting-<ms>ms-…` reads connecting for <ms> after the input connects). */
async function passthroughLive(r: Rig, fixtureId: string, key = `yt-${randomUUID()}`): Promise<string> {
  const target = await createStreamTarget(r.auth, r.auth.orgId, { kind: "youtube", label: `Court ${randomUUID().slice(0, 6)}`, streamKey: key });
  await pairPresentPhone(fixtureId, { at: r.deps.now() });
  const { sessionId } = await createSession(r.auth, fixtureId, { mode: "passthrough", targetId: target.id }, r.deps);
  r.clock.now += 3_000;
  expect((await currentSession(r.auth, fixtureId, r.deps))!.state, "PREMISE: the poll took it live").toBe("live");
  return sessionId;
}
type EventRow = { seq: number; source: string; kind: string; from_state: string | null; to_state: string | null; occurred_at: Date; payload: Record<string, unknown> };
const ingestEvents = async (sid: string) => sql<EventRow[]>`
  select seq, source, kind, from_state, to_state, occurred_at, payload from fixture_stream_events where session_id = ${sid} and type = 'ingest_status' order by seq`;
type SampleRow = { source: string; ingest_state: string | null; ingest_reason: string | null; sampled_at: Date; raw: Record<string, unknown> };
const samplesOf = async (sid: string, source: string) => sql<SampleRow[]>`
  select source, ingest_state, ingest_reason, sampled_at, raw from fixture_stream_samples where session_id = ${sid} and source = ${source} order by id`;
/** Every row anywhere that names this input uid as a notification's — "nothing written" is this, zero. */
const notedAnywhere = async (uid: string) => {
  const [{ e }] = await sql<{ e: number }[]>`select count(*)::int as e from fixture_stream_events where payload->>'inputUid' = ${uid} and payload->>'via' = 'notification'`;
  const [{ s }] = await sql<{ s: number }[]>`select count(*)::int as s from fixture_stream_samples where source = 'notification' and raw->>'inputUid' = ${uid}`;
  return e + s;
};

describe.skipIf(!HAS_DB)("recordLiveNotification — a Cloudflare live-input notification, recorded (Task 27b)", () => {
  it("EMPTY CASE FIRST: an input no session here owns (another environment's on the shared account, a deleted session's) is `unknown_input`, and nothing is written anywhere", async () => {
    const uid = `cf-${randomUUID().replace(/-/g, "")}`;
    let checked = 0;
    for (const event of ["connected", "disconnected", "errored"] as const) {
      expect(await recordLiveNotification(note(uid, event, new Date()), new Date()), event).toEqual({ outcome: "unknown_input" });
      checked++;
    }
    expect(checked).toBe(3);
    expect(await notedAnywhere(uid)).toBe(0);
  });

  it("a drop and a reconnect between two polls leave their trace — one observed ingest_status event and one `notification` sample each, chained from the last known word — and the next poll neither decides on them nor records a change of its own", async () => {
    const r = await rig();
    const f = r.fixtureIds[0];
    const sid = await passthroughLive(r, f);
    const camera = await inputOf(sid, "camera");
    const tPoll = r.deps.now();
    const before = await ingestEvents(sid);
    expect(before.at(-1)?.to_state, "PREMISE: the poll's last word is connected").toBe("connected");
    const tDrop = new Date(tPoll.getTime() + 10_000);
    const tBack = new Date(tPoll.getTime() + 20_000);

    expect(await recordLiveNotification(note(camera.uid, "disconnected", tDrop), new Date()))
      .toEqual({ outcome: "recorded", sessionId: sid, role: "camera", from: "connected", sample: "written" });
    expect(await recordLiveNotification(note(camera.uid, "connected", tBack), new Date()))
      .toEqual({ outcome: "recorded", sessionId: sid, role: "camera", from: "disconnected", sample: "written" });

    const added = (await ingestEvents(sid)).slice(before.length);
    expect(added.map((e) => [e.source, e.kind, e.from_state, e.to_state, e.occurred_at.getTime()])).toEqual([
      ["ingest", "observed", "connected", "disconnected", tDrop.getTime()],
      ["ingest", "observed", "disconnected", "connected", tBack.getTime()],
    ]);
    expect(added.map((e) => e.payload)).toEqual([
      { via: "notification", event: "live_input.disconnected", reason: null, role: "camera", inputUid: camera.uid },
      { via: "notification", event: "live_input.connected", reason: null, role: "camera", inputUid: camera.uid },
    ]);
    expect((await samplesOf(sid, "notification")).map((s) => [s.ingest_state, s.ingest_reason, s.sampled_at.getTime(), s.raw.event])).toEqual([
      ["disconnected", null, tDrop.getTime(), "live_input.disconnected"],
      ["connected", null, tBack.getTime(), "live_input.connected"],
    ]);
    expect(await stateOf(sid), "a record: the session is untouched").toBe("live");

    // The next poll, a minute on (prod's cadence): its word is still connected, so its change check (against the last POLL
    // sample) records nothing, and its own sample is a poll's.
    const polls = (await samplesOf(sid, "poll")).length;
    r.clock.now = tPoll.getTime() + 60_000;
    await pairPresentPhone(f, { at: r.deps.now() });
    expect((await currentSession(r.auth, f, r.deps))!.state).toBe("live");
    expect((await ingestEvents(sid)).length, "no event of the poll's own: nothing changed between ITS readings").toBe(before.length + 2);
    expect((await samplesOf(sid, "poll")).length, "the poll still samples").toBe(polls + 1);
  });

  it("D3: the destination's `since` is the poll's alone — a drop and a reconnect noted inside an `ok` run neither split nor restart it", async () => {
    const r = await rig();
    const f = r.fixtureIds[0];
    // The destination reads connecting for 5 s after the input connects, then ok: the ok run starts AFTER live_at, so a since
    // that fell back to live_at is told apart from the right one.
    const sid = await passthroughLive(r, f, `connecting-5000ms-${randomUUID()}`);
    const first = (await currentSession(r.auth, f, r.deps))!;
    expect(first.output?.state, "PREMISE: connecting at live").toBe("connecting");
    r.clock.now += STREAM_POLL_MS;
    await pairPresentPhone(f, { at: r.deps.now() });
    const tOk = r.deps.now();
    const ok = (await currentSession(r.auth, f, r.deps))!;
    expect(ok.output, "PREMISE: the ok run began at this poll, after live").toMatchObject({ state: "ok", since: tOk.toISOString() });
    expect(new Date(ok.output!.since).getTime()).toBeGreaterThan(new Date(first.output!.since).getTime());

    const camera = await inputOf(sid, "camera");
    await recordLiveNotification(note(camera.uid, "disconnected", new Date(tOk.getTime() + 1_000)), new Date());
    await recordLiveNotification(note(camera.uid, "connected", new Date(tOk.getTime() + 2_000)), new Date());
    r.clock.now += STREAM_POLL_MS;
    await pairPresentPhone(f, { at: r.deps.now() });
    const after = (await currentSession(r.auth, f, r.deps))!;
    expect(after.output, "the run is unbroken: same word, same since, elapsed on the poll's clock").toEqual({ state: "ok", since: tOk.toISOString(), elapsedMs: STREAM_POLL_MS });
    expect(after.state).toBe("live");
  });

  it("D3, a non-ok word: a reconnect noted between two polls never clamps the not-receiving clock, and a drop noted before the poll's own never starts it", async () => {
    // (a) A destination that never accepts (a plain connecting key): its clock runs from live, and a phone reconnect only the
    // notification saw is not the poll's reconnect.
    const r = await rig();
    const fa = r.fixtureIds[0];
    const a = await passthroughLive(r, fa, `connecting-${randomUUID()}`);
    const tLive = r.deps.now();
    const at0 = (await currentSession(r.auth, fa, r.deps))!.output;
    expect(at0, "PREMISE: connecting since live").toMatchObject({ state: "connecting", since: tLive.toISOString() });
    const camA = await inputOf(a, "camera");
    await recordLiveNotification(note(camA.uid, "disconnected", new Date(tLive.getTime() + 1_000)), new Date());
    await recordLiveNotification(note(camA.uid, "connected", new Date(tLive.getTime() + 2_000)), new Date());
    r.clock.now += STREAM_POLL_MS;
    await pairPresentPhone(fa, { at: r.deps.now() });
    expect((await currentSession(r.auth, fa, r.deps))!.output, "the clock still runs from live").toEqual({ state: "connecting", since: tLive.toISOString(), elapsedMs: STREAM_POLL_MS });

    // (b) An ok run, a drop the notification saw first, then the poll's own reading of it: the not-receiving clock starts at the
    // poll's reading, never at the notification's.
    const fb = r.fixtureIds[1];
    const b = await passthroughLive(r, fb, `connecting-5000ms-${randomUUID()}`);
    r.clock.now += STREAM_POLL_MS;
    await pairPresentPhone(fb, { at: r.deps.now() });
    expect((await currentSession(r.auth, fb, r.deps))!.output?.state, "PREMISE: ok").toBe("ok");
    const tOk = r.deps.now();
    const camB = await inputOf(b, "camera");
    await recordLiveNotification(note(camB.uid, "disconnected", new Date(tOk.getTime() + 1_000)), new Date());
    r.ingest.setState(camB.uid, "disconnected");
    r.clock.now += STREAM_POLL_MS;
    await pairPresentPhone(fb, { at: r.deps.now() });
    const tPollDrop = r.deps.now();
    const dropped = (await currentSession(r.auth, fb, r.deps))!;
    expect(dropped.output?.state, "PREMISE: the poll read the drop as not receiving").not.toBe("ok");
    expect(dropped.output?.since, "the poll's own reading starts the clock").toBe(tPollDrop.toISOString());
    expect([await stateOf(a), await stateOf(b)]).toEqual(["live", "live"]);
  });

  it("an errored input reads `unknown` with Cloudflare's code as the reason, on the event and the sample", async () => {
    const r = await rig();
    const sid = await passthroughLive(r, r.fixtureIds[0]);
    const camera = await inputOf(sid, "camera");
    const at = new Date(r.clock.now + 5_000);
    expect(await recordLiveNotification(note(camera.uid, "errored", at, "ERR_GOP_OUT_OF_RANGE"), new Date()))
      .toMatchObject({ outcome: "recorded", from: "connected" });
    const [e] = (await ingestEvents(sid)).slice(-1);
    expect([e!.from_state, e!.to_state, e!.payload.reason, e!.payload.event]).toEqual(["connected", "unknown", "ERR_GOP_OUT_OF_RANGE", "live_input.errored"]);
    const [s] = (await samplesOf(sid, "notification"));
    expect([s!.ingest_state, s!.ingest_reason]).toEqual(["unknown", "ERR_GOP_OUT_OF_RANGE"]);
  });

  it("a second delivery of one notification (same input, event and moment) is a `duplicate` that writes nothing; the same event at another moment, and another event at the same moment, are each recorded", async () => {
    const r = await rig();
    const sid = await passthroughLive(r, r.fixtureIds[0]);
    const camera = await inputOf(sid, "camera");
    const at = new Date(r.clock.now + 5_000);
    const drop = note(camera.uid, "disconnected", at);
    expect(await recordLiveNotification(drop, new Date())).toMatchObject({ outcome: "recorded" });
    const counts = async () => [(await ingestEvents(sid)).length, (await samplesOf(sid, "notification")).length];
    const once = await counts();
    expect(await recordLiveNotification(drop, new Date()), "the second delivery").toEqual({ outcome: "duplicate", sessionId: sid });
    expect(await recordLiveNotification({ ...drop }, new Date(Date.now() + 60_000)), "a third, later").toEqual({ outcome: "duplicate", sessionId: sid });
    expect(await counts(), "nothing more written").toEqual(once);
    expect(await recordLiveNotification(note(camera.uid, "disconnected", new Date(at.getTime() + 1)), new Date()), "1 ms later").toMatchObject({ outcome: "recorded" });
    expect(await recordLiveNotification(note(camera.uid, "connected", at), new Date()), "another event, same moment").toMatchObject({ outcome: "recorded" });
    expect(await counts()).toEqual([once[0]! + 2, once[1]! + 2]);
  });

  it("a notification with no moment is recorded at the time it arrived", async () => {
    const r = await rig();
    const sid = await passthroughLive(r, r.fixtureIds[0]);
    const camera = await inputOf(sid, "camera");
    const arrived = new Date(r.clock.now + 7_000);
    expect(await recordLiveNotification(note(camera.uid, "disconnected", null), arrived)).toMatchObject({ outcome: "recorded" });
    const [e] = (await ingestEvents(sid)).slice(-1);
    expect(e!.occurred_at.getTime()).toBe(arrived.getTime());
  });

  it("a composed session: each input keeps its OWN chain — the programme's first word comes from nothing, its second from its first; the camera's is never the programme's (no poll reads a composed session's inputs)", async () => {
    const r = await rig();
    const sid = await live(r, r.fixtureIds[0], r.seazn);
    const programme = await inputOf(sid, "programme");
    const camera = await inputOf(sid, "camera");
    const t = r.clock.now;
    expect(await recordLiveNotification(note(programme.uid, "connected", new Date(t + 1_000)), new Date())).toMatchObject({ outcome: "recorded", role: "programme", from: null });
    expect(await recordLiveNotification(note(programme.uid, "disconnected", new Date(t + 2_000)), new Date())).toMatchObject({ outcome: "recorded", role: "programme", from: "connected" });
    expect(await recordLiveNotification(note(camera.uid, "disconnected", new Date(t + 3_000)), new Date())).toMatchObject({ outcome: "recorded", role: "camera", from: null });
    expect(await recordLiveNotification(note(programme.uid, "connected", new Date(t + 4_000)), new Date())).toMatchObject({ outcome: "recorded", role: "programme", from: "disconnected" });
    expect(await stateOf(sid)).toBe("live");
  });

  it("after Stop: the phone's disconnect is recorded against the ended session, which stays completed", async () => {
    const r = await rig();
    const f = r.fixtureIds[0];
    const sid = await passthroughLive(r, f);
    const camera = await inputOf(sid, "camera");
    await stopAndSettle(r, f, sid);
    expect(await recordLiveNotification(note(camera.uid, "disconnected", new Date(r.clock.now + 1_000)), new Date())).toMatchObject({ outcome: "recorded", sessionId: sid });
    expect(await stateOf(sid)).toBe("completed");
  });

  it("guard: an input uid two input rows name is a record nothing can place — refused by name, nothing written", async () => {
    const r = await rig();
    const a = await passthroughLive(r, r.fixtureIds[0]);
    const b = await passthroughLive(r, r.fixtureIds[1]);
    const uid = (await inputOf(a, "camera")).uid;
    await sql`insert into fixture_stream_inputs (session_id, slot, role, ingest_input_id) values (${b}, 7, 'camera', ${uid})`;
    const errors = vi.spyOn(log, "error");
    try {
      expect(await recordLiveNotification(note(uid, "disconnected", new Date(r.clock.now + 1_000)), new Date())).toEqual({ outcome: "ambiguous_input" });
      expect(await notedAnywhere(uid)).toBe(0);
      expect(errors.mock.calls.some(([, msg]) => typeof msg === "string" && /more than one input row/.test(msg)), "logged by name").toBe(true);
    } finally {
      errors.mockRestore();
    }
  });
});
