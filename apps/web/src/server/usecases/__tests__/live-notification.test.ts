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
import { SAMPLES_PER_SESSION_CAP } from "@/server/relay/config";
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
  const [{ e }] = await sql<{ e: number }[]>`select count(*)::int as e from fixture_stream_events where payload->>'inputUid' = ${uid} and source = 'webhook'`;
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
      ["webhook", "observed", "connected", "disconnected", tDrop.getTime()],
      ["webhook", "observed", "disconnected", "connected", tBack.getTime()],
    ]);
    expect(added.map((e) => e.payload)).toEqual([
      { event: "live_input.disconnected", reason: null, role: "camera", inputUid: camera.uid },
      { event: "live_input.connected", reason: null, role: "camera", inputUid: camera.uid },
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

  it("Task 27b review I1, out of order: each notification chains from the input's word AS OF ITS OWN MOMENT — never a later notification's, never a poll sample read after it — and an earlier record is never rewritten", async () => {
    const r = await rig();
    const f = r.fixtureIds[0];
    const sid = await passthroughLive(r, f);
    const camera = await inputOf(sid, "camera");
    const t = r.deps.now().getTime();   // the go-live poll's sample: connected, at t
    const sinceBefore = (await currentSession(r.auth, f, r.deps))!.output?.since;
    expect(sinceBefore, "PREMISE: D3 has a since").toBeTruthy();
    const at = (s: number) => new Date(t + s * 1_000);
    const deliver = async (event: "connected" | "disconnected" | "errored", s: number) => {
      const out = await recordLiveNotification(note(camera.uid, event, at(s)), new Date());
      expect(out, `${event}@+${s}s`).toMatchObject({ outcome: "recorded", sessionId: sid });
      return (out as { from: string | null }).from;
    };
    // Each expected `from` is read off this timeline by hand: the newest word at or before the notification's moment.
    expect(await deliver("disconnected", 5), "@+5: the poll's word at t").toBe("connected");
    expect(await deliver("connected", 20), "@+20: the drop at +5").toBe("disconnected");
    expect(await deliver("disconnected", 10), "@+10, delivered after +20: the drop at +5, never the later +20").toBe("disconnected");
    expect(await deliver("connected", 3), "@+3, delivered late: the poll's word at t").toBe("connected");
    // +12: the newest by MOMENT at or before it is the drop at +10; the newest by ARRIVAL among those is the +3 connect.
    expect(await deliver("errored", 12), "@+12: the +10 drop (moment order, not arrival order)").toBe("disconnected");
    // The next poll lands at +60 (connected, no change against the last POLL sample, so no event of its own).
    r.clock.now = t + 60_000;
    await pairPresentPhone(f, { at: r.deps.now() });
    const after = (await currentSession(r.auth, f, r.deps))!;
    expect((await samplesOf(sid, "poll")).at(-1)!.sampled_at.getTime(), "PREMISE: a poll sample newer than what follows").toBe(t + 60_000);
    expect(await deliver("connected", 15), "@+15, delivered after the +60 poll: the +12 error, never the newer poll sample").toBe("unknown");
    // Six recorded, nothing deduped; the +20 connect keeps the `from` it was recorded with (the drop at +5) although the late
    // +10/+12/+15 arrivals now sit between: a record states what was known when it was written.
    const notes = (await ingestEvents(sid)).filter((e) => e.source === "webhook");
    expect(notes).toHaveLength(6);
    expect(notes.find((e) => e.occurred_at.getTime() === t + 20_000)!.from_state).toBe("disconnected");
    expect(await stateOf(sid)).toBe("live");
    expect(after.state).toBe("live");
    expect(after.output?.since, "D3's since is the poll's: untouched by six notifications").toBe(sinceBefore);
  });

  it("Task 27b review m2: a notification sample over the session's sample cap is `capped` and the session gets ONE `samples_capped` event (as a beat's does); the notification's own event is still written", async () => {
    const r = await rig();
    const sid = await passthroughLive(r, r.fixtureIds[0]);
    const camera = await inputOf(sid, "camera");
    const cappedEvents = async () => (await sql<{ n: number }[]>`
      select count(*)::int as n from fixture_stream_events where session_id = ${sid} and type = 'samples_capped'`)[0]!.n;
    // EMPTY CASE FIRST: under the cap, a notification writes its sample and no cap event.
    expect(await recordLiveNotification(note(camera.uid, "disconnected", new Date(r.clock.now + 1_000)), new Date())).toMatchObject({ sample: "written" });
    expect(await cappedEvents()).toBe(0);
    const [{ n: have }] = await sql<{ n: number }[]>`select count(*)::int as n from fixture_stream_samples where session_id = ${sid}`;
    await sql`insert into fixture_stream_samples (session_id, source, sampled_at)
              select ${sid}, 'heartbeat', now() from generate_series(1, ${SAMPLES_PER_SESSION_CAP - have}::int)`;
    let checked = 0;
    for (const s of [2, 3]) {
      expect(await recordLiveNotification(note(camera.uid, "connected", new Date(r.clock.now + s * 1_000)), new Date()), `+${s}s`)
        .toMatchObject({ outcome: "recorded", sample: "capped" });
      checked++;
    }
    expect(checked).toBe(2);
    expect(await cappedEvents(), "one cap event, not one per capped sample").toBe(1);
    const [cap] = await sql<{ source: string; kind: string; payload: unknown }[]>`
      select source, kind, payload from fixture_stream_events where session_id = ${sid} and type = 'samples_capped'`;
    expect(cap).toEqual({ source: "webhook", kind: "event", payload: { count: SAMPLES_PER_SESSION_CAP } });
    expect((await ingestEvents(sid)).filter((e) => e.source === "webhook"), "every notification's own event").toHaveLength(3);
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
