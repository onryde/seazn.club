// The fakes are what CI runs the state machine against, so they are held to
// the port's CONTRACT here — not to convenience. Claims: the per-input status
// SHAPE (C5); the clock-derived connect fires at the boundary and not before;
// deleteInput leaks videos exactly like Cloudflare (C2 — the sweep must
// delete videos first, and a fake that tidied them would hide the leak);
// a scripted 409-once on deleteVideo; outputState rejects on a host that
// says so and is `ok` otherwise (positive pair).
import { describe, expect, it } from "vitest";
import { FAKE_CONNECTING_KEY_PREFIX, FAKE_CONNECT_AFTER_MS_DEFAULT, FAKE_REJECT_KEY_PREFIX, FakeIngest, FakeRecorder, FakeRunner, fakeRecoveringKey } from "../fakes";
import { DELETE_RECORDING_AFTER_DAYS, INGEST_TIMEOUT_SECONDS, HOLD_SLACK_SECONDS } from "../config";
import { pathTemplate } from "../sanitise";
import { machineNameFor } from "../domain/runner";
import { FlyApiError } from "../fly-client";
import { CREATE_REFUSED_STATUSES } from "../runner-fly";
import { RunnerCreateError, createFailureOf } from "../ports";
import { RelayJobInput } from "@/server/api-v1/schemas";

describe("FakeIngest", () => {
  it("createLiveInput returns both credential shapes and no webRTC (C1/R-A, C10)", async () => {
    const fake = new FakeIngest();
    const creds = await fake.createLiveInput({ sessionId: "s1", slot: 0 });
    expect(creds.inputId).toMatch(/^fake-in-/);
    expect(creds.srt.url).toMatch(/^srt:\/\//);
    // Task 3 carry C1 (Task 2 ruling, 2026-09-16): Cloudflare returns a BARE
    // srt:// URL — streamId and passphrase ride as separate fields, never in a
    // query string. Pinned by value: a fake that folded the secrets into the URL
    // would hide the query-strip that Task 2's storage applies.
    expect(creds.srt.url).toBe("srt://fake.ingest.invalid:778");
    expect(creds.srt.streamId.length).toBeGreaterThan(0);
    expect(creds.srt.passphrase.length).toBeGreaterThan(0);
    expect(creds.rtmps.url).toMatch(/^rtmps:\/\//);
    expect(creds.rtmps.streamKey.length).toBeGreaterThan(0);
    expect("webRTC" in creds).toBe(false);
  });

  // R2004 (fakes first): the composed session's two new port facts. The compositor reads the camera over SRT PLAYBACK, so
  // the create returns Cloudflare's `srtPlayback` beside the ingest pair — a credential of its own, shaped like the
  // contract's `input` (bare srt:// url, the secrets as fields). And the sweep deletes the camera's recordings by INPUT
  // (owner ruling 2026-10-18, option (a)), so the fake lists one input's videos and no other's.
  it("R2004: createLiveInput returns the SRT PLAYBACK credential, its own and bare; a programme input is a second credential on the same slot; listInputVideos lists ONE input's recordings", async () => {
    const fake = new FakeIngest();
    const camera = await fake.createLiveInput({ sessionId: "s1", slot: 0 });
    const programme = await fake.createLiveInput({ sessionId: "s1", slot: 0, role: "programme" });
    const play = camera.srtPlayback;
    expect(play, "the camera's playback credential").not.toBeNull();
    expect(play!.url).toBe("srt://fake.ingest.invalid:778");   // bare, by value (the ingest url's rule)
    expect(play!.streamId, "playback is its own credential, never the ingest one").not.toBe(camera.srt.streamId);
    expect(play!.passphrase).not.toBe(camera.srt.passphrase);
    expect(RelayJobInput.safeParse({ protocol: "srt", ...play }).success, "the contract's input accepts it").toBe(true);
    // The programme input: same session, same slot, a different input and different credentials.
    expect(programme.inputId).not.toBe(camera.inputId);
    expect(programme.srt.streamId).not.toBe(camera.srt.streamId);
    expect(programme.srtPlayback!.streamId).not.toBe(play!.streamId);
    // The listing is per input: each input's own, nothing unattributed, and the empty case.
    const at = "2026-09-01T00:00:00Z";
    fake.addVideo({ videoId: "v-cam", inputId: camera.inputId, createdAt: at, inProgress: false });
    fake.addVideo({ videoId: "v-prog", inputId: programme.inputId, createdAt: at, inProgress: true });
    fake.addVideo({ videoId: "v-none", inputId: null, createdAt: at, inProgress: false });
    expect((await fake.listInputVideos(camera.inputId)).map((v) => v.videoId)).toEqual(["v-cam"]);
    expect((await fake.listInputVideos(programme.inputId)).map((v) => [v.videoId, v.inProgress])).toEqual([["v-prog", true]]);
    expect(await fake.listInputVideos("fake-in-0-none")).toEqual([]);
    // The second call, after a delete: the deleted recording is gone from its input's listing, the other input keeps its own.
    expect(await fake.deleteVideo("v-cam")).toBe("deleted");
    expect(await fake.listInputVideos(camera.inputId)).toEqual([]);
    expect((await fake.listInputVideos(programme.inputId)).map((v) => v.videoId)).toEqual(["v-prog"]);
    // Review I2: at most ONE page — the instance's declared listVideosPageLimit, as the real listing's `limit` bounds it.
    for (const id of ["v-cam-1", "v-cam-2", "v-cam-3"]) fake.addVideo({ videoId: id, inputId: camera.inputId, createdAt: at, inProgress: false });
    const small = Object.assign(Object.create(fake) as FakeIngest, { capabilities: { ...fake.capabilities, listVideosPageLimit: 2 } });
    expect((await small.listInputVideos(camera.inputId)).map((v) => v.videoId), "a full page of 2, the third withheld").toEqual(["v-cam-1", "v-cam-2"]);
    expect(await fake.listInputVideos(camera.inputId), "the fake's own page holds all three").toHaveLength(3);
  });

  // Seazn Task 36: the held create the provisioning tests settle by hand. Read back here so they can trust it: a held create
  // makes nothing (no input, no provider call) until it is answered, a failed one never makes anything, `whenHeld` wakes on the
  // n-th ask and not before, and the order the test answers in is the order the creates settle in.
  it("Seazn Task 36: holdCreates — a held create makes nothing until answered; a failed one makes nothing; whenHeld wakes on the n-th ask; the test picks the settle order", async () => {
    const recorder = new FakeRecorder();
    const fake = new FakeIngest({ recorder });
    const flush = () => new Promise<void>((res) => setImmediate(res));
    const settled: string[] = [];
    const track = <T,>(p: Promise<T>, name: string) => { p.then(() => settled.push(name), () => settled.push(`${name}:failed`)); return p; };
    // The empty case: nothing asked, so a wait for one is still waiting after a flush.
    fake.holdCreates();
    let wokeForTwo = false;
    void fake.whenHeld(2).then(() => { wokeForTwo = true; });
    const camera = track(fake.createLiveInput({ sessionId: "s1", slot: 0 }), "camera");
    await flush();
    expect([fake.heldCreates.length, settled, wokeForTwo], "one asked, none answered, the wait for two still waiting").toEqual([1, [], false]);
    const programme = track(fake.createLiveInput({ sessionId: "s1", slot: 0, role: "programme" }), "programme");
    await fake.whenHeld(2);
    await fake.whenHeld(1);   // already met: answers at once
    expect(wokeForTwo).toBe(true);
    expect(fake.heldCreates.map((h) => h.spec.role ?? "camera"), "both asked, in order").toEqual(["camera", "programme"]);
    await flush();
    expect([settled, recorder.calls], "neither answered: nothing settled, no provider call recorded").toEqual([[], []]);
    // The test answers the PROGRAMME first: it settles first, and only then is its input made.
    fake.heldCreates[1]!.answer();
    const made = await programme;
    expect(settled).toEqual(["programme"]);
    expect(fake.isEnabled(made.inputId), "the answered create made its input").toBe(true);
    const refusal = Object.assign(new Error("provider 500"), { status: 500 });
    fake.heldCreates[0]!.fail(refusal);
    await expect(camera).rejects.toBe(refusal);
    await flush();
    expect(settled).toEqual(["programme", "camera:failed"]);
    expect(recorder.calls.map((c) => [c.operation, c.subjectId]), "ONE create recorded — the answered one; the failed one made nothing").toEqual([["createLiveInput", made.inputId]]);
  });

  // Seazn Task 13: the fake's token, its per-video lock, and the seeded listing that stands in for C6 (a listing that answers
  // another input's recording). Each control is read back here so the usecase tests can trust it.
  it("Seazn Task 13: a token reads fake.<uid>.<exp seconds>[.dl]; requireSignedVideo signs a video it holds and answers absent for one it does not; a seeded listing answers another input's video under ITS OWN inputId", async () => {
    const fake = new FakeIngest();
    const exp = new Date("2026-11-21T11:00:00.900Z");
    const expS = Math.floor(Date.parse("2026-11-21T11:00:00Z") / 1000);
    expect(await fake.playbackToken("in-1", { expiresAt: exp })).toBe(`fake.in-1.${expS}`);
    expect(await fake.playbackToken("v-1", { expiresAt: exp, downloadable: true })).toBe(`fake.v-1.${expS}.dl`);
    const at = "2026-09-01T00:00:00Z";
    fake.addVideo({ videoId: "v-mine", inputId: "in-1", createdAt: at, inProgress: true });
    fake.addVideo({ videoId: "v-theirs", inputId: "in-2", createdAt: at, inProgress: false });
    expect([fake.videoAccess("v-mine"), fake.videoAccess("v-theirs")]).toEqual([false, false]);
    const deleteAt = new Date("2026-12-22T15:30:00.000Z");
    expect(await fake.requireSignedVideo("v-mine", { deleteAt })).toBe("set");
    expect([fake.videoAccess("v-mine"), fake.videoAccess("v-theirs")], "only the named video").toEqual([true, false]);
    expect(await fake.requireSignedVideo("v-never", { deleteAt: new Date(deleteAt.getTime() + 1_000) })).toBe("absent");
    expect(fake.signedVideoCalls).toEqual(["v-mine", "v-never"]);
    // Phase 1 review I3: the deletion each edit sent, in step with the calls.
    expect(fake.signedVideoDeleteAts.map((d) => d.toISOString())).toEqual(["2026-12-22T15:30:00.000Z", "2026-12-22T15:30:01.000Z"]);
    expect(() => fake.videoAccess("v-never"), "an unknown video is the test's mistake").toThrow(/unknown video/);
    // The listing reads the video's own flag, and a recording that finishes can read unsigned again (C3 at ready).
    expect((await fake.listInputVideos("in-1")).map((v) => [v.videoId, v.signed])).toEqual([["v-mine", true]]);
    fake.updateVideo("v-mine", { inProgress: false, state: "ready", signed: false });
    expect((await fake.listInputVideos("in-1")).map((v) => [v.videoId, v.state, v.signed])).toEqual([["v-mine", "ready", false]]);
    // C6: seeded, in-1's listing also answers in-2's video, which still names in-2.
    fake.seedInputListing("in-1", ["v-theirs", "v-mine"]);   // naming the input's own recording in the seed does not list it twice
    expect((await fake.listInputVideos("in-1")).map((v) => [v.videoId, v.inputId])).toEqual([["v-mine", "in-1"], ["v-theirs", "in-2"]]);
    expect((await fake.listInputVideos("in-2")).map((v) => v.videoId), "the seed changes only the input it names").toEqual(["v-theirs"]);
  });

  // Seazn Task 24: the fake's `createDownload` — ready by default for a video it holds, a scripted sequence when a test needs the
  // download to take a while, and Cloudflare's 404 (a throw) for a video it does not hold. Every call is kept, in order.
  it("Seazn Task 24: createDownload answers ready for a held video, follows a script (inprogress then ready), throws for an unknown one, and keeps every call", async () => {
    const fake = new FakeIngest();
    fake.addVideo({ videoId: "v-a", inputId: "in-1", createdAt: "2026-09-01T00:00:00Z", inProgress: false });
    fake.addVideo({ videoId: "v-b", inputId: "in-1", createdAt: "2026-09-01T00:00:00Z", inProgress: false });
    expect(await fake.createDownload("v-a")).toBe("ready");
    fake.scriptDownload("v-b", ["inprogress", "inprogress"]);
    expect([await fake.createDownload("v-b"), await fake.createDownload("v-b"), await fake.createDownload("v-b")], "the script, then ready").toEqual(["inprogress", "inprogress", "ready"]);
    await expect(fake.createDownload("v-never")).rejects.toThrow(/v-never/);
    expect(fake.downloadCalls).toEqual(["v-a", "v-b", "v-b", "v-b", "v-never"]);
    // The download goes with the video: a deleted video has none to make.
    await fake.deleteVideo("v-a");
    await expect(fake.createDownload("v-a")).rejects.toThrow(/v-a/);
  });

  // Seazn Task 19: the walkthrough's stand-in for Cloudflare finishing a recording of an input. A test control like addVideo:
  // it adds a FINISHED, UNSIGNED recording (C3's measured default) of the named input and records no provider call.
  it("Seazn Task 19: addRecording adds a finished, unsigned recording of a known input, each with its own id, and refuses an unknown input", async () => {
    const rec = new FakeRecorder();
    const fake = new FakeIngest({ clock: () => Date.parse("2026-11-21T12:00:00Z"), recorder: rec });
    const { inputId } = await fake.createLiveInput({ sessionId: "s1", slot: 0, role: "programme" });
    const other = (await fake.createLiveInput({ sessionId: "s2", slot: 0 })).inputId;
    await new Promise((r) => setImmediate(r));
    const before = rec.calls.length;
    expect(await fake.listInputVideos(inputId), "EMPTY CASE FIRST: a new input holds no recording").toEqual([]);
    const first = fake.addRecording(inputId);
    const second = fake.addRecording(inputId);
    expect(second, "two recordings of one input are two videos").not.toBe(first);
    const listed = await fake.listInputVideos(inputId);
    expect(listed.map((v) => [v.videoId, v.inputId, v.inProgress, v.state, v.signed])).toEqual([
      [first, inputId, false, "ready", false],
      [second, inputId, false, "ready", false],
    ]);
    expect(listed[0]!.createdAt, "made on the fake's own clock").toBe("2026-11-21T12:00:00.000Z");
    expect(await fake.listInputVideos(other), "only the named input's listing").toEqual([]);
    expect(() => fake.addRecording("fake-in-0-nope"), "an unknown input is the caller's mistake").toThrow(/unknown input/);
    // A recording outlives its input (C2): a deleted input still gets one, as Cloudflare finishes it after the input goes.
    await fake.deleteInput(other);
    expect(fake.videoAccess(fake.addRecording(other))).toBe(false);
    await new Promise((r) => setImmediate(r));
    expect(rec.calls.slice(before).map((c) => c.operation), "a control, not a provider call: only the listings and the delete").toEqual([
      "listInputVideos", "listInputVideos", "listInputVideos", "deleteInput",
    ]);
  });

  it("inputStatus has the per-input GET's shape and flips at connectAfterMs exactly", async () => {
    let now = 1_000_000;
    const fake = new FakeIngest({ clock: () => now, connectAfterMs: 3000 });
    const { inputId } = await fake.createLiveInput({ sessionId: "s1", slot: 0 });
    now += 2999;
    const before = await fake.inputStatus(inputId);
    expect(Object.keys(before).sort()).toEqual(["enteredAt", "lastSeenAt", "protocol", "reason", "state"]);
    expect(before.state).toBe("disconnected");
    expect(before.reason).toBe("waiting_for_input");   // Dh: the field Task 10 writes to every sample's ingest_reason
    now += 1;
    const at = await fake.inputStatus(inputId);
    expect(at.state).toBe("connected");
    expect(at.protocol).toBe("srt");
    expect(at.enteredAt).not.toBeNull();
    expect(at.reason).toBe("live_input_connected");   // Dh positive twin: a CONNECTED sample carries a reason too
  });

  it("an unknown input id derived from a timestamp still answers (server mode survives a restart)", async () => {
    const fake = new FakeIngest({ clock: () => 50_000, connectAfterMs: 3000 });
    expect((await fake.inputStatus("fake-in-40000-abc")).state).toBe("connected");
    expect((await fake.inputStatus("fake-in-48000-abc")).state).toBe("disconnected");
    expect((await fake.inputStatus("not-a-fake-id")).state).toBe("unknown");
  });

  // Lane-A minors, Task 3 review m3: `Number(process.env.FAKE_INGEST_CONNECT_AFTER_MS)`
  // took whatever it was given. An EMPTY or whitespace value became 0 — an instant
  // connect, so a server-mode e2e that meant to watch warming would see live at once.
  // A non-numeric one became NaN, and `enteredAt` is computed UNCONDITIONALLY from it,
  // so `new Date(NaN).toISOString()` threw RangeError on EVERY poll of a live input:
  // a 500 per heartbeat, not the "never connects" the report expected. Parsed strictly
  // and refused loudly instead, exactly as `relayDriverMode()` refuses a junk
  // RELAY_DRIVERS — a fake driver's env is still an operator-facing switch.
  it("FAKE_INGEST_CONNECT_AFTER_MS is parsed STRICTLY: junk and empty are refused at construction, never silently 0 or NaN", async () => {
    const keep = process.env.FAKE_INGEST_CONNECT_AFTER_MS;
    try {
      for (const bad of ["", "   ", "soon", "3s", "-1", "1.5", "NaN"]) {
        process.env.FAKE_INGEST_CONNECT_AFTER_MS = bad;
        expect(() => new FakeIngest(), JSON.stringify(bad)).toThrow(/FAKE_INGEST_CONNECT_AFTER_MS/);
      }
      // The positive twin, and the two ends that must still work: a good value is
      // taken, and 0 is a LEGITIMATE setting (connect immediately) rather than the
      // accident the empty string used to produce.
      process.env.FAKE_INGEST_CONNECT_AFTER_MS = "7000";
      const at7 = new FakeIngest({ clock: () => 6999 });
      const { inputId } = await at7.createLiveInput({ sessionId: "s1", slot: 0 });
      expect((await at7.inputStatus(inputId)).state).toBe("disconnected");
      process.env.FAKE_INGEST_CONNECT_AFTER_MS = "0";
      const now = new FakeIngest({ clock: () => 0 });
      const zero = await now.createLiveInput({ sessionId: "s1", slot: 0 });
      expect((await now.inputStatus(zero.inputId)).state).toBe("connected");
      // Unset falls back to the declared default, not to 0.
      delete process.env.FAKE_INGEST_CONNECT_AFTER_MS;
      const dflt = new FakeIngest({ clock: () => FAKE_CONNECT_AFTER_MS_DEFAULT - 1 });
      const d = await dflt.createLiveInput({ sessionId: "s1", slot: 0 });
      expect((await dflt.inputStatus(d.inputId)).state).toBe("disconnected");
    } finally {
      if (keep === undefined) delete process.env.FAKE_INGEST_CONNECT_AFTER_MS;
      else process.env.FAKE_INGEST_CONNECT_AFTER_MS = keep;
    }
  });

  it("setState overrides the clock (the scripted mode unit tests drive)", async () => {
    const fake = new FakeIngest({ clock: () => 0, connectAfterMs: 3000 });
    const { inputId } = await fake.createLiveInput({ sessionId: "s1", slot: 0 });
    fake.setState(inputId, "connected");
    expect((await fake.inputStatus(inputId)).state).toBe("connected");
    fake.setState(inputId, "disconnected");
    expect((await fake.inputStatus(inputId)).state).toBe("disconnected");
  });

  it("deleteInput does NOT delete the input's videos (mirrors the C2 leak)", async () => {
    const fake = new FakeIngest();
    const { inputId } = await fake.createLiveInput({ sessionId: "s1", slot: 0 });
    fake.addVideo({ videoId: "v1", inputId, createdAt: new Date(0).toISOString(), inProgress: false });
    await fake.deleteInput(inputId);
    expect(fake.deletedInputs).toEqual([inputId]);
    expect(await fake.listVideos({ createdBefore: new Date() })).toHaveLength(1);
    expect((await fake.inputStatus(inputId)).state).toBe("unknown");
  });

  it("deleteVideo honours a scripted in_progress once, then deletes", async () => {
    const fake = new FakeIngest();
    fake.addVideo({ videoId: "v1", inputId: null, createdAt: new Date(0).toISOString(), inProgress: true });
    fake.scriptDeleteVideo("v1", ["in_progress"]);
    expect(await fake.deleteVideo("v1")).toBe("in_progress");
    expect(await fake.deleteVideo("v1")).toBe("deleted");
    expect(await fake.deleteVideo("v1")).toBe("absent");
    expect(fake.deletedVideos).toEqual(["v1"]);
  });

  it("outputState: rejected when the target host says reject, ok otherwise; addOutput hands back the output uid (Dg)", async () => {
    const fake = new FakeIngest();
    const a = await fake.createLiveInput({ sessionId: "s1", slot: 0 });
    expect(await fake.outputState(a.inputId)).toBe("unknown");   // no output yet: neither ok nor rejected
    const outA = await fake.addOutput(a.inputId, { url: "rtmps://reject.example/live", streamKey: "k" });
    expect(outA).toMatch(/^fake-out-/);   // Dg: what Task 10 persists as sessions.output_uid
    expect(await fake.outputState(a.inputId)).toBe("rejected");
    const b = await fake.createLiveInput({ sessionId: "s2", slot: 0 });
    const outB = await fake.addOutput(b.inputId, { url: "rtmps://a.rtmps.youtube.com/live2", streamKey: "k" });
    expect(outB).not.toBe(outA);          // one uid per output, not a constant
    expect(await fake.outputState(b.inputId)).toBe("ok");
    expect(fake.outputsFor(b.inputId)).toHaveLength(1);
  });

  it("outputState: a stream KEY starting with FAKE_REJECT_KEY_PREFIX is rejected on an allowlisted url, and the SAME url with another key is ok (D6: the url is a server preset, so the key is what a walkthrough can steer)", async () => {
    const fake = new FakeIngest();
    const url = "rtmp://a.rtmp.youtube.com/live2";
    const bad = await fake.createLiveInput({ sessionId: "s1", slot: 0 });
    await fake.addOutput(bad.inputId, { url, streamKey: `${FAKE_REJECT_KEY_PREFIX}abc123` });
    expect(await fake.outputState(bad.inputId)).toBe("rejected");
    const good = await fake.createLiveInput({ sessionId: "s2", slot: 0 });
    await fake.addOutput(good.inputId, { url, streamKey: "abc123" });
    expect(await fake.outputState(good.inputId)).toBe("ok");
    // The prefix is a PREFIX: the same letters later in a key do not reject.
    const inner = await fake.createLiveInput({ sessionId: "s3", slot: 0 });
    await fake.addOutput(inner.inputId, { url, streamKey: `abc-${FAKE_REJECT_KEY_PREFIX}` });
    expect(await fake.outputState(inner.inputId)).toBe("ok");
  });

  it("C1: removeOutput takes exactly that output off its input — a repeat (Cloudflare's 404) resolves and changes nothing; the LIVE count per input and per destination only counts outputs on inputs that still exist", async () => {
    const fake = new FakeIngest();
    const dest = { url: "rtmps://a.rtmps.youtube.com/live2", streamKey: "k" };
    const other = { url: "rtmps://a.rtmps.youtube.com/live2", streamKey: "other" };
    expect(fake.liveOutputsTo(dest)).toBe(0);                          // the empty case
    const a = await fake.createLiveInput({ sessionId: "s1", slot: 0 });
    const outA1 = await fake.addOutput(a.inputId, dest);
    const outA2 = await fake.addOutput(a.inputId, other);
    const b = await fake.createLiveInput({ sessionId: "s2", slot: 0 });
    await fake.addOutput(b.inputId, dest);
    expect([fake.liveOutputCount(a.inputId), fake.liveOutputCount(b.inputId), fake.liveOutputsTo(dest)]).toEqual([2, 1, 2]);
    await fake.removeOutput(a.inputId, outA1);
    expect(fake.outputsFor(a.inputId)).toEqual([other]);              // the named one, not its neighbour
    expect([fake.liveOutputCount(a.inputId), fake.liveOutputsTo(dest)]).toEqual([1, 1]);
    await expect(fake.removeOutput(a.inputId, outA1)).resolves.toBeUndefined();   // already gone: success, idempotent
    await expect(fake.removeOutput("fake-in-unknown", "fake-out-x")).resolves.toBeUndefined();
    expect(fake.liveOutputCount(a.inputId)).toBe(1);
    expect(fake.removedOutputs).toEqual([outA1, outA1, "fake-out-x"]);   // every call is visible to a test
    await fake.deleteInput(b.inputId);                                 // Cloudflare drops an input's outputs with it
    expect([fake.liveOutputCount(b.inputId), fake.liveOutputsTo(dest)]).toEqual([0, 0]);
    expect(fake.liveOutputsTo(other)).toBe(1);
    void outA2;
  });

  it("setInputEnabled: an input starts enabled; DISABLING it rejects the phone — even one scripted `connected`, even one the clock would connect — and re-enabling lets it back; a repeat is harmless; an input that is gone is Cloudflare's 404 (success to a disable, a refusal to an enable); every call is visible", async () => {
    let now = 0;
    const fake = new FakeIngest({ clock: () => now, connectAfterMs: 1000 });
    const a = await fake.createLiveInput({ sessionId: "s1", slot: 0 });
    const b = await fake.createLiveInput({ sessionId: "s2", slot: 0 });
    expect([fake.isEnabled(a.inputId), fake.isEnabled(b.inputId)], "a new input is enabled — Cloudflare's default").toEqual([true, true]);
    expect(fake.enabledCalls, "the empty case: nothing has been asked yet").toEqual([]);
    fake.setState(a.inputId, "connected");                      // scripted: a phone is pushing to A
    now = 1000;                                                 // the clock connects B (no scripted state)
    expect([(await fake.inputStatus(a.inputId)).state, (await fake.inputStatus(b.inputId)).state], "the positive pair: both phones are connected before the switch").toEqual(["connected", "connected"]);

    await fake.setInputEnabled(a.inputId, false);
    expect(fake.isEnabled(a.inputId)).toBe(false);
    expect(fake.isEnabled(b.inputId), "B is not A: disabling one input leaves its neighbour alone").toBe(true);
    expect((await fake.inputStatus(a.inputId)).state, "a disabled input rejects the connection it was holding").toBe("disconnected");
    expect((await fake.inputStatus(a.inputId)).protocol).toBeNull();
    expect((await fake.inputStatus(b.inputId)).state, "and B still carries its phone").toBe("connected");

    await fake.setInputEnabled(a.inputId, false);               // a second disable: harmless
    expect(fake.isEnabled(a.inputId)).toBe(false);
    await fake.setInputEnabled(a.inputId, true);
    expect(fake.isEnabled(a.inputId)).toBe(true);
    expect((await fake.inputStatus(a.inputId)).state, "re-enabled: the phone that never stopped pushing is back").toBe("connected");
    await fake.setInputEnabled(a.inputId, true);                // enabling an enabled input is fine

    await fake.deleteInput(b.inputId);
    await expect(fake.setInputEnabled(b.inputId, false), "a deleted input: a disable is idempotent success").resolves.toBeUndefined();
    await expect(fake.setInputEnabled("fake-in-unknown", false), "an input this fake never made: the same 404").resolves.toBeUndefined();
    await expect(fake.setInputEnabled(b.inputId, true), "…but an enable of a gone input is refused, loudly").rejects.toThrow(/gone|unknown/);
    await expect(fake.setInputEnabled("fake-in-unknown", true)).rejects.toThrow(/gone|unknown/);
    expect(fake.isEnabled(b.inputId), "a deleted input accepts nothing").toBe(false);

    expect(fake.enabledCalls).toEqual([
      { inputId: a.inputId, enabled: false }, { inputId: a.inputId, enabled: false }, { inputId: a.inputId, enabled: true }, { inputId: a.inputId, enabled: true },
      { inputId: b.inputId, enabled: false }, { inputId: "fake-in-unknown", enabled: false }, { inputId: b.inputId, enabled: true }, { inputId: "fake-in-unknown", enabled: true },
    ]);
  });

  // Seazn-hosted video (Task 12, G5): the fake keeps each input's signing as the adapter sends it — so a usecase test can read
  // what the programme input was CREATED with — and refuses what the adapter refuses: a programme switch that does not name its
  // access. A fake laxer than the adapter would let a DB test pass what production throws.
  it("Task 12: the fake keeps each input's access (the Seazn programme's signed settings; null for the camera and an external programme) and refuses a programme switch with no `access` key before recording anything; a switch re-sends the access it names", async () => {
    const port = new FakeRecorder();
    const fake = new FakeIngest({ recorder: port });
    const signed: { signed: true; allowedOrigins: string[] } = { signed: true, allowedOrigins: ["seazn.club"] };
    const cam = await fake.createLiveInput({ sessionId: "s1", slot: 0 });
    const prog = await fake.createLiveInput({ sessionId: "s1", slot: 0, role: "programme", access: signed });
    const ext = await fake.createLiveInput({ sessionId: "s2", slot: 0, role: "programme" });
    expect(fake.inputAccess(prog.inputId)).toEqual({ signed: true, allowedOrigins: ["seazn.club"] });
    expect(fake.inputAccess(cam.inputId), "the camera stays unsigned").toBeNull();
    expect(fake.inputAccess(ext.inputId), "an external destination's programme input is unsigned").toBeNull();
    expect(() => fake.inputAccess("fake-in-unknown"), "an input the fake never made is a test bug, never a quiet null").toThrow(/unknown/);

    await new Promise((r) => setImmediate(r));
    const recorded = port.calls.length;
    await expect(fake.setInputEnabled(prog.inputId, false, { sessionId: "s1", slot: 0, role: "programme" })).rejects.toThrow(/without its access/);
    // review m1: `access: undefined` (a select that omitted the column) is refused the same way.
    await expect(fake.setInputEnabled(prog.inputId, false, { sessionId: "s1", slot: 0, role: "programme", access: undefined })).rejects.toThrow(/without its access/);
    await new Promise((r) => setImmediate(r));
    expect(port.calls.length, "refused before any call is recorded").toBe(recorded);
    expect(fake.enabledCalls, "…or counted").toEqual([]);
    expect(fake.isEnabled(prog.inputId), "…or applied").toBe(true);

    await fake.setInputEnabled(prog.inputId, false, { sessionId: "s1", slot: 0, role: "programme", access: signed });
    expect([fake.isEnabled(prog.inputId), fake.inputAccess(prog.inputId)], "C8: re-sending the signing keeps it").toEqual([false, signed]);
    // The update re-sends the WHOLE recording (ingest-cf.ts), so what it names is what the input then holds. A re-send without the
    // signing is not measured; the fake takes the pessimistic reading, so a test that downgrades an input sees it.
    await fake.setInputEnabled(prog.inputId, true, { sessionId: "s1", slot: 0, role: "programme", access: null });
    expect(fake.inputAccess(prog.inputId)).toBeNull();
    await fake.setInputEnabled(cam.inputId, false, { sessionId: "s1", slot: 0, role: "camera" });   // port-effects.ts's own call
    expect([fake.isEnabled(cam.inputId), fake.inputAccess(cam.inputId)]).toEqual([false, null]);
  });

  it("listVideos carries Cloudflare's recording facts, and a LIVE recording reads unknown — never a finalised-looking zero (Dd)", async () => {
    const fake = new FakeIngest();
    // The live row deliberately PASSES numbers: the fake must drop them. A fake
    // that stored them would hand Task 12 a live video that looks finalised,
    // which is precisely what Cloudflare's -1/0 placeholders do if stored raw.
    fake.addVideo({ videoId: "v-live", inputId: "in-1", createdAt: new Date(0).toISOString(), inProgress: true, durationSeconds: 99, sizeBytes: 99 });
    fake.addVideo({ videoId: "v-done", inputId: "in-1", createdAt: new Date(0).toISOString(), inProgress: false, durationSeconds: 61, sizeBytes: 734_003_200, width: 1280, height: 720 });
    const [live, done] = await fake.listVideos({ createdBefore: new Date(1) });
    expect(live).toEqual({
      videoId: "v-live", inputId: "in-1", createdAt: new Date(0).toISOString(), inProgress: true,
      durationSeconds: null, sizeBytes: null, width: null, height: null, state: "live-inprogress", errorReasonCode: null,
      signed: false,   // Seazn Task 13: unless a test says otherwise, a recording reads unsigned (C3's measured default)
    });
    expect(done).toMatchObject({ durationSeconds: 61, sizeBytes: 734_003_200, width: 1280, height: 720, state: "ready", errorReasonCode: null });
    // `createdBefore` is STRICT (`<`, not `<=`) — a FAKE CONVENTION, pinned so both
    // sides of the port agree, and nothing more. Lane-A minors, Task 3 review m5:
    // this used to be justified as "not yet old enough for the retention sweep",
    // which is wrong twice over — the sweep lists with `createdBefore: now` and
    // applies retention itself, and Cloudflare's own `end` parameter is inclusive
    // or exclusive by a measurement nobody has taken (a Task 17 live-watch item).
    expect(await fake.listVideos({ createdBefore: new Date(0) })).toEqual([]);
  });

  it("storageUsage reads the mutable `storage` control, raw (C3 — headroom is the usecase's arithmetic)", async () => {
    const fake = new FakeIngest();
    fake.storage = { totalStorageMinutes: 940, totalStorageMinutesLimit: 1000, videoCount: 12 };
    expect(await fake.storageUsage()).toEqual({ totalStorageMinutes: 940, totalStorageMinutesLimit: 1000, videoCount: 12 });
    fake.storage.totalStorageMinutes = 999;   // mutated in place, read live — not snapshotted
    expect((await fake.storageUsage()).totalStorageMinutes).toBe(999);
  });

  it("capabilities come from config.ts, SRT hold unmeasured (C8); the listing page size is the REAL adapter's, so the sweep's full-page rule (A13) runs against the fake exactly as it does against Cloudflare (m2)", () => {
    const fake = new FakeIngest();
    expect(fake.capabilities).toEqual({
      timeoutSeconds: INGEST_TIMEOUT_SECONDS,
      deleteRecordingAfterDays: DELETE_RECORDING_AFTER_DAYS,
      holdWindowSeconds: { rtmps: INGEST_TIMEOUT_SECONDS + HOLD_SLACK_SECONDS, srt: null },
      listVideosPageLimit: 1000,   // a literal, as ingest-cf.test.ts pins it: never the constant supplying both sides
    });
  });
});

describe("FakeRunner", () => {
  it("create records the spec and destroy is idempotent", async () => {
    const runner = new FakeRunner();
    const spec = {
      sessionId: "s1", attempt: 1, environment: "local", jobToken: "t", appUrl: "http://app",
      guest: { cpus: 4, memoryMb: 8192, cpuClass: "dedicated" as const }, region: "lhr", deadlineAt: new Date(0),
    };
    const h = await runner.create(spec);
    expect(h.runnerId).toMatch(/^fake-machine-/);
    // Lane-A minors, Task 3 review m8: the title says "records the spec" and the
    // assertion was `toHaveLength(1)` — satisfied by recording ANY object, including
    // an empty one. Task 10's rigs read `created[0].jobToken`, `.deadlineAt` and
    // `.attempt` off this array, so what it holds is the point, not how many.
    expect(runner.created).toEqual([spec]);
    // …and it is a COPY: the fake clones the spec and its guest, so a caller
    // mutating what it passed cannot rewrite the ledger after the fact.
    expect(runner.created[0]).not.toBe(spec);
    expect(runner.created[0]!.guest).not.toBe(spec.guest);
    await runner.destroy(h.runnerId);
    await runner.destroy(h.runnerId);
    await runner.destroy("never-existed");
    expect(runner.destroyed).toEqual([h.runnerId, h.runnerId, "never-existed"]);
  });

  // Whole-branch review I6. PARITY with the real adapter: runner-fly.test.ts's "create is idempotent per session
  // through the client" and "T5-c (SAFETY): a 409 already_exists ADOPTS the Machine the refusal names" both assert
  // that a repeated create for one (sessionId, attempt) yields the SAME Machine. The fake is what Tasks 10 and 12
  // test their retry and orphan matching against, so it owes the same contract.
  it("I6: create is idempotent per (sessionId, attempt) — a repeat returns the SAME runnerId and leaves ONE live Machine under that name; a real retry (attempt + 1) still gets its own, and a different session's never collides", async () => {
    const runner = new FakeRunner();
    const spec = {
      sessionId: "s1", attempt: 1, environment: "local", jobToken: "t", appUrl: "http://app",
      guest: { cpus: 4, memoryMb: 8192, cpuClass: "dedicated" as const }, region: "lhr", deadlineAt: new Date(0),
    };
    const first = await runner.create(spec);
    const again = await runner.create({ ...spec });
    expect(again.runnerId).toBe(first.runnerId);
    // The attempt really was made twice — the fake records both calls, exactly as the real adapter POSTs and is 409'd.
    expect(runner.created).toHaveLength(2);
    // ONE live Machine under `relay-s1-r1`: `list()` is the sweep's source and T5-a matches on session AND name, so
    // two entries sharing one name is the defect this row exists for.
    const listed = await runner.list();
    expect(listed.filter((m) => m.name === machineNameFor("s1", 1))).toHaveLength(1);
    // The negative pairs: the ONE retry is a DIFFERENT Machine, and so is another session's first attempt.
    const retry = await runner.create({ ...spec, attempt: 2 });
    const other = await runner.create({ ...spec, sessionId: "s2" });
    expect(retry.runnerId).not.toBe(first.runnerId);
    expect(other.runnerId).not.toBe(first.runnerId);
    expect(new Set((await runner.list()).map((m) => m.runnerId)).size).toBe(3);
    // …and a name freed by a destroy is creatable again (Fly ALLOWS a destroyed Machine's name to be reused), so the
    // guard is keyed on what is ALIVE and does not turn into a permanent lock.
    await runner.destroy(first.runnerId);
    const replacement = await runner.create({ ...spec });
    expect(replacement.runnerId).not.toBe(first.runnerId);
  });

  // Seazn Task 36b: the runner's create held the way the ingest's is (T36), so a test sees the Machine and the inputs in flight at
  // once. Read back here so the provisioning tests can trust it: a held create makes nothing (no Machine, no listing, no recorded
  // call) until answered, a failed one makes nothing, `whenHeld` wakes on the n-th ask and not before, the held spec is the one a
  // test reads the job token from, a failure armed with `failNextCreate` is thrown when the held create is answered, and
  // `holdCreates(false)` returns every LATER create to answering at once.
  it("Seazn Task 36b: FakeRunner.holdCreates — a held create makes nothing until answered; a failed one makes nothing; whenHeld wakes on the n-th ask; the held spec is readable; an armed failure is thrown on answer", async () => {
    const recorder = new FakeRecorder();
    const runner = new FakeRunner({ recorder });
    const spec = { sessionId: "s1", attempt: 1, environment: "local", jobToken: "tok-1", appUrl: "http://app", guest: { cpus: 4, memoryMb: 8192, cpuClass: "dedicated" as const }, region: "lhr", deadlineAt: new Date(0) };
    const flush = () => new Promise<void>((res) => setImmediate(res));
    const settled: string[] = [];
    const track = <T,>(p: Promise<T>, name: string) => { p.then(() => settled.push(name), () => settled.push(`${name}:failed`)); return p; };
    // The empty case: nothing asked, so a wait for one is still waiting after a flush.
    runner.holdCreates();
    let woke = false;
    void runner.whenHeld(1).then(() => { woke = true; });
    await flush();
    expect([runner.heldCreates.length, woke], "nothing asked, the wait still waiting").toEqual([0, false]);
    const first = track(runner.create(spec), "first");
    await runner.whenHeld(1);
    expect(woke).toBe(true);
    expect(runner.heldCreates.map((h) => h.spec.jobToken), "the held spec is the one the create was asked with").toEqual(["tok-1"]);
    await flush();
    const creates = () => recorder.calls.filter((c) => c.operation === "createMachine");
    expect([settled, runner.created, await runner.list(), creates()], "asked, not answered: nothing settled, no Machine, no create recorded").toEqual([[], [], [], []]);
    runner.heldCreates[0]!.answer();
    const made = await first;
    expect(made.runnerId).toMatch(/^fake-machine-/);
    expect([runner.created.length, creates().length, (await runner.list()).map((m) => m.runnerId)]).toEqual([1, 1, [made.runnerId]]);
    // A failed one makes nothing, and what it rejects with is what the test gave.
    const refusal = Object.assign(new Error("provider 500"), { status: 500 });
    const second = track(runner.create({ ...spec, sessionId: "s2" }), "second");
    await runner.whenHeld(2);
    runner.heldCreates[1]!.fail(refusal);
    await expect(second).rejects.toBe(refusal);
    expect([runner.created.length, (await runner.list()).length], "the failed create made nothing").toEqual([1, 1]);
    // An armed failure is thrown by the create's own body, so it is thrown when the held create is ANSWERED (not when asked).
    runner.failNextCreate({ status: 422, retryable: false });
    const third = track(runner.create({ ...spec, sessionId: "s3" }), "third");
    await runner.whenHeld(3);
    await flush();
    expect(settled, "the armed failure waits for the answer").toEqual(["first", "second:failed"]);
    runner.heldCreates[2]!.answer();
    await expect(third).rejects.toBeInstanceOf(RunnerCreateError);
    // holdCreates(false): every later create answers at once, and nothing more is held.
    runner.holdCreates(false);
    const fourth = await runner.create({ ...spec, sessionId: "s4" });
    expect(fourth.runnerId).toMatch(/^fake-machine-/);
    expect(runner.heldCreates, "the later create was never held").toHaveLength(3);
  });

  it("the stop sequence on the fake: stop records SIGINT + grace, observe reads stopped with exit 0 / requestedStop, then auto-destroyed; a lost Machine reads its exit", async () => {
    const runner = new FakeRunner();
    const spec = { sessionId: "s1", attempt: 1, environment: "local", jobToken: "t", appUrl: "http://app", guest: { cpus: 4, memoryMb: 8192, cpuClass: "dedicated" as const }, region: "lhr", deadlineAt: new Date(0) };
    const h = await runner.create(spec);
    expect(await runner.observe(h.runnerId)).toEqual({ state: "running", exit: null, restarting: false, restartingSince: null, restartCount: null, exitAt: null, exitRestarted: null });
    await runner.stop(h.runnerId, { signal: "SIGINT", timeoutSeconds: 10 });
    expect(runner.stops).toEqual([{ runnerId: h.runnerId, signal: "SIGINT", timeoutSeconds: 10 }]);
    expect(await runner.observe(h.runnerId)).toEqual({ state: "stopped", exit: { exitCode: 0, oomKilled: false, requestedStop: true }, restarting: false, restartingSince: null, restartCount: null, exitAt: null, exitRestarted: null });
    expect((await runner.observe(h.runnerId)).state).toBe("destroyed"); // auto_destroy, as both R0 soaks did
    expect(await runner.list()).toEqual([]);
    const crashed = await runner.create({ ...spec, sessionId: "s2" });
    runner.setObserved(crashed.runnerId, "failed", { exitCode: 137, oomKilled: true, requestedStop: false });
    expect(await runner.observe(crashed.runnerId)).toEqual({ state: "failed", exit: { exitCode: 137, oomKilled: true, requestedStop: false }, restarting: false, restartingSince: null, restartCount: null, exitAt: null, exitRestarted: null });
    expect(await runner.observe("never-created")).toEqual({ state: "destroyed", exit: null, restarting: false, restartingSince: null, restartCount: null, exitAt: null, exitRestarted: null });   // the port: NEVER EXISTED = destroyed, exit null
    // Lane-A minors, Task 3 review m1: the OTHER absent case — a Machine the
    // provider knew and has now destroyed — keeps its exit, and that is the branch
    // the fake models on purpose. It is what the real adapter does: C1 measured that
    // a destroyed Fly Machine still answers GET 200 with its events readable, and
    // only a 404 (an id that never existed) yields `exit: null`. Unpinned, hunt
    // mutant D survived; pinned here with BOTH sides, because a fake that dropped
    // the exit would let Task 10 read `machine_crash` where the real path reads
    // `machine_exit_nonzero`.
    const exited = await runner.create({ ...spec, sessionId: "s_exit" });
    runner.setObserved(exited.runnerId, "stopped", { exitCode: 3, oomKilled: false, requestedStop: false });
    await runner.destroy(exited.runnerId);
    expect(await runner.observe(exited.runnerId)).toEqual({ state: "destroyed", exit: { exitCode: 3, oomKilled: false, requestedStop: false }, restarting: false, restartingSince: null, restartCount: null, exitAt: null, exitRestarted: null });
    // Lane-A minors, Task 3 review m2: `stop` on a runner the fake never knew is a
    // no-op that still records, and the observe after it is unchanged. Hunt mutant E
    // survived on this; the port declares stop idempotent for an absent runner.
    await runner.stop("never-created", { signal: "SIGINT", timeoutSeconds: 10 });
    expect(runner.stops.at(-1)).toEqual({ runnerId: "never-created", signal: "SIGINT", timeoutSeconds: 10 });
    expect(await runner.observe("never-created")).toEqual({ state: "destroyed", exit: null, restarting: false, restartingSince: null, restartCount: null, exitAt: null, exitRestarted: null });
    // F-007: the fake reports what the Fly adapter reports — a restart in flight, and the UNRECORDED stop (restarting
    // null) as its own answer, not as a restart with no instant (which the domain would wait out differently)
    const restarting = await runner.create({ ...spec, sessionId: "s_restart" });
    const since = new Date(1_000);
    runner.setObserved(restarting.runnerId, "stopped", { exitCode: 1, oomKilled: false, requestedStop: false }, { since, count: 1 });
    // R2003b: a restarting exit's instant IS its identity (`exitAt`), exactly as runner-fly.ts reports it
    expect(await runner.observe(restarting.runnerId)).toEqual({ state: "stopped", exit: { exitCode: 1, oomKilled: false, requestedStop: false }, restarting: true, restartingSince: since, restartCount: 1, exitAt: since, exitRestarted: true });
    // …and a FINAL exit (Fly will not restart it) carries the instant it is given — through a destroy too
    const gaveUp = await runner.create({ ...spec, sessionId: "s_final" });
    const finalAt = new Date(2_000);
    runner.setObserved(gaveUp.runnerId, "stopped", { exitCode: 1, oomKilled: false, requestedStop: false }, undefined, finalAt);
    expect(await runner.observe(gaveUp.runnerId)).toMatchObject({ state: "stopped", restarting: false, exitAt: finalAt });
    runner.setObserved(gaveUp.runnerId, "destroyed", { exitCode: 1, oomKilled: false, requestedStop: false }, undefined, finalAt);
    expect(await runner.observe(gaveUp.runnerId)).toMatchObject({ state: "destroyed", exitAt: finalAt });
    // R2003b review m2: Fly's final exit as F-007 MEASURED it (M1, M3: restart_count 2 after 3 crashes, restarting false),
    // on a stopped Machine and on the destroyed one auto_destroy leaves. The destroyed read keeps the count.
    const CRASH = { exitCode: 1, oomKilled: false, requestedStop: false };
    for (const state of ["stopped", "destroyed"] as const) {
      const m = await runner.create({ ...spec, sessionId: `s_final_${state}` });
      runner.setObserved(m.runnerId, state, CRASH, { final: 2 }, finalAt);
      expect(await runner.observe(m.runnerId), state).toEqual({ state, exit: CRASH, restarting: false, restartingSince: null, restartCount: 2, exitAt: finalAt, exitRestarted: false });
    }
    // R2003b review I2: a restart that COMPLETED — the Machine reads running again, its newest exit the crash Fly restarted
    const back = await runner.create({ ...spec, sessionId: "s_back" });
    runner.setObserved(back.runnerId, "running", CRASH, { restarted: 1 }, since);
    expect(await runner.observe(back.runnerId)).toEqual({ state: "running", exit: CRASH, restarting: false, restartingSince: null, restartCount: 1, exitAt: since, exitRestarted: true });
    runner.setObserved(restarting.runnerId, "stopped", null, "unrecorded");
    expect(await runner.observe(restarting.runnerId)).toEqual({ state: "stopped", exit: null, restarting: null, restartingSince: null, restartCount: null, exitAt: null, exitRestarted: null });
    runner.failNextCreate(true);
    await expect(runner.create({ ...spec, sessionId: "s3" })).rejects.toMatchObject({ retryable: true });
    expect((await runner.create({ ...spec, sessionId: "s4" })).runnerId).toMatch(/^fake-machine-/);   // ONE create fails, not every one after
  });

  // A23 (lane C, OWNER 2026-09-28): the fake throws the PORT's failure, exactly as FlyRunner does — a real FlyApiError
  // passed through the REAL adapter mapping (`runnerCreateErrorFrom`), so the A3 proofs are still decided by the code
  // production runs, and the usecase reads them through the port alone (`createFailureOf`).
  it("A3/A23: failNextCreate chooses the PROOF — a status throws the port's RunnerCreateError, mapped from a real FlyApiError by the REAL adapter mapping: made-nothing (a refusal status, or retryable) or unknown (anything else); a boolean throws a plain error, which the port reads as unknown; no failure leaves a Machine listed", async () => {
    const runner = new FakeRunner();
    const spec = { sessionId: "s1", attempt: 1, environment: "local", jobToken: "t", appUrl: "http://app", guest: { cpus: 4, memoryMb: 8192, cpuClass: "dedicated" as const }, region: "lhr", deadlineAt: new Date(0) };
    const classify = async (proof: Parameters<FakeRunner["failNextCreate"]>[0]) => {
      runner.failNextCreate(proof);
      const err = await runner.create(spec).then(() => null, (e: unknown) => e);
      expect(err, JSON.stringify(proof)).not.toBeNull();
      const isFly = err instanceof RunnerCreateError && err.cause instanceof FlyApiError;
      return { isFly, trigger: { type: "create_failed", ...createFailureOf(err) } };
    };
    // The expectations are the A3 ruling's words (refused outright / retryable-with-absence ⇒ made nothing; no provider
    // answer ⇒ unknown), swept over the adapter's own refusal list rather than one sample status.
    let refusals = 0;
    for (const status of CREATE_REFUSED_STATUSES) {
      expect(await classify({ status, retryable: false }), String(status)).toEqual({ isFly: true, trigger: { type: "create_failed", retryable: false, outcomeUnknown: false } });
      refusals++;
    }
    expect(refusals, "the refusal sweep checked nothing").toBeGreaterThan(0);
    expect(await classify({ status: 503, retryable: true })).toEqual({ isFly: true, trigger: { type: "create_failed", retryable: true, outcomeUnknown: false } });
    expect(await classify({ status: 500, retryable: false })).toEqual({ isFly: true, trigger: { type: "create_failed", retryable: false, outcomeUnknown: true } });
    expect(await classify({ status: null, retryable: false })).toEqual({ isFly: true, trigger: { type: "create_failed", retryable: false, outcomeUnknown: true } });
    for (const legacy of [true, false]) {
      expect(await classify(legacy), String(legacy)).toEqual({ isFly: false, trigger: { type: "create_failed", retryable: false, outcomeUnknown: true } });
    }
    expect(await runner.list()).toEqual([]);                                   // a failed create made nothing in the fake either
    expect((await runner.create(spec)).runnerId).toMatch(/^fake-machine-/);  // …and the proof is spent: the next create lands
  });

  it("list shows what still exists, with the session AND the attempt-carrying name each was created with; destroyed ones drop out; an orphan can be planted, nameless", async () => {
    const runner = new FakeRunner();
    const spec = { sessionId: "s1", attempt: 1, environment: "stg", jobToken: "t", appUrl: "http://app", guest: { cpus: 4, memoryMb: 8192, cpuClass: "dedicated" as const }, region: "lhr", deadlineAt: new Date(0) };
    const a = await runner.create(spec);
    const b = await runner.create({ ...spec, sessionId: "s2", attempt: 2, environment: "prod" });
    runner.addOrphan("fake-machine-orphan", null, null);
    // T5-a: the NAME is the attempt identity Task 10 matches on — pinned by value (a fake that named every Machine r1 would pass a presence check).
    // I1: the ENVIRONMENT each was created with comes back as it went in (the real adapter's metadata round trip); a planted
    // orphan carries whatever the test says, here none.
    expect((await runner.list()).map((r) => [r.runnerId, r.sessionId, r.name, r.environment])).toEqual([[a.runnerId, "s1", "relay-s1-r1", "stg"], [b.runnerId, "s2", "relay-s2-r2", "prod"], ["fake-machine-orphan", null, null, null]]);
    expect(runner.listSettleMs).toBe(0);                                          // a fake lists consistently…
    expect(new FakeRunner({ listSettleMs: 25 }).listSettleMs).toBe(25);           // …unless a test asks it not to
    await runner.destroy(a.runnerId);
    expect((await runner.list()).map((r) => r.runnerId)).toEqual([b.runnerId, "fake-machine-orphan"]);
  });
});

describe("the provider-call recorder seam (ruling 13)", () => {
  it("every fake call is recorded through the injected recorder with a raw URL the recorder templates, and a throwing recorder never fails the call", async () => {
    const rec = new FakeRecorder();
    const ingest = new FakeIngest({ clock: () => 0, recorder: rec });
    const runner = new FakeRunner({ recorder: rec });
    const creds = await ingest.createLiveInput({ sessionId: "s1", slot: 0 });
    await ingest.inputStatus(creds.inputId);
    const h = await runner.create({ sessionId: "s1", attempt: 1, environment: "local", jobToken: "t", appUrl: "http://localhost", guest: { cpus: 1, memoryMb: 256, cpuClass: "shared" }, region: "lhr", deadlineAt: new Date(0) });
    await runner.stop(h.runnerId, { signal: "SIGINT", timeoutSeconds: 10 });
    await new Promise((r) => setImmediate(r));   // the record is a microtask behind the call
    expect(rec.calls.map((c) => [c.provider, c.operation, c.method])).toEqual([
      ["cloudflare", "createLiveInput", "POST"], ["cloudflare", "inputStatus", "GET"], ["fly", "createMachine", "POST"], ["fly", "stopMachine", "POST"],
    ]);
    expect(rec.calls[1]!.url).toContain(creds.inputId);           // raw here — the recorder (telemetry.ts) templates it
    expect(rec.calls[1]!.ids).toContain(creds.inputId);           // and is told what to template
    expect(rec.calls[2]!.sessionId).toBe("s1");
    expect(rec.calls[3]!.subjectId).toBe(h.runnerId);
    // The record is DEFERRED, so a throw that escapes its `.catch` never fails the call — it surfaces as an
    // unhandled rejection instead. `.resolves` alone cannot see that; this listener can. (Measured: without it,
    // vitest exits 1 on that mutant while its JSON report still reads success:true, 0 failed.)
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => { unhandled.push(e); };
    process.on("unhandledRejection", onUnhandled);
    try {
      rec.failNext();
      await expect(ingest.inputStatus(creds.inputId)).resolves.toBeTruthy();   // the call survives its recorder
      await new Promise((r) => setImmediate(r));
      rec.failNext();
      await expect(runner.observe(h.runnerId)).resolves.toBeTruthy();         // on both fakes
      await new Promise((r) => setImmediate(r));
      expect(rec.calls).toHaveLength(4);   // …and the recorder really THREW both times (those rows are missing) — else the lines above prove nothing
      await ingest.inputStatus(creds.inputId);
      await new Promise((r) => setImmediate(r));
      expect(rec.calls).toHaveLength(5);   // failNext is one-shot
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    expect(unhandled).toEqual([]);
  });

  it("EVERY port method records exactly one call, and each raw URL reduces (the recorder's own pathTemplate) to the path the real adapter calls, with no id left in it", async () => {
    const rec = new FakeRecorder();
    const ingest = new FakeIngest({ clock: () => 0, recorder: rec });
    const runner = new FakeRunner({ recorder: rec });
    const { inputId } = await ingest.createLiveInput({ sessionId: "s1", slot: 0 });
    ingest.addVideo({ videoId: "vid-a", inputId, createdAt: new Date(0).toISOString(), inProgress: false });
    await ingest.inputStatus(inputId);
    const out = await ingest.addOutput(inputId, { url: "rtmps://a.rtmps.youtube.com/live2", streamKey: "k" });
    await ingest.outputState(inputId);
    await ingest.removeOutput(inputId, out);
    await ingest.setInputEnabled(inputId, false);
    await ingest.storageUsage();
    await ingest.listVideos({ createdBefore: new Date(1) });
    await ingest.deleteVideo("vid-a");
    await ingest.deleteInput(inputId);
    const { runnerId } = await runner.create({ sessionId: "s1", attempt: 1, environment: "local", jobToken: "t", appUrl: "http://localhost", guest: { cpus: 1, memoryMb: 256, cpuClass: "shared" }, region: "lhr", deadlineAt: new Date(0) });
    await runner.observe(runnerId);
    await runner.list();
    await runner.stop(runnerId, { signal: "SIGINT", timeoutSeconds: 10 });
    await runner.destroy(runnerId);
    await new Promise((r) => setImmediate(r));
    const cf = "/client/v4/accounts/{id}/stream";   // Task 4: CLOUDFLARE_STREAM_BASE + /<account>/stream
    const fly = "/v1/apps/{id}/machines";           // Task 5A: FLY_MACHINES_BASE + /apps/<app>/machines
    expect(rec.calls.map((c) => [c.provider, c.operation, c.method, pathTemplate(c.url, c.ids), c.subjectId ?? null, c.sessionId ?? null])).toEqual([
      ["cloudflare", "createLiveInput", "POST", `${cf}/live_inputs`, inputId, "s1"],
      ["cloudflare", "inputStatus", "GET", `${cf}/live_inputs/{id}`, inputId, null],
      ["cloudflare", "addOutput", "POST", `${cf}/live_inputs/{id}/outputs`, inputId, null],
      ["cloudflare", "outputState", "GET", `${cf}/live_inputs/{id}/outputs`, inputId, null],
      ["cloudflare", "removeOutput", "DELETE", `${cf}/live_inputs/{id}/outputs/{id}`, out, null],   // C1: about the OUTPUT
      ["cloudflare", "setInputEnabled", "PUT", `${cf}/live_inputs/{id}`, inputId, null],            // about the INPUT it switches
      ["cloudflare", "storageUsage", "GET", `${cf}/storage-usage`, null, null],
      ["cloudflare", "listVideos", "GET", cf, null, null],
      ["cloudflare", "deleteVideo", "DELETE", `${cf}/{id}`, "vid-a", null],
      ["cloudflare", "deleteInput", "DELETE", `${cf}/live_inputs/{id}`, inputId, null],
      ["fly", "createMachine", "POST", fly, null, "s1"],
      ["fly", "getMachine", "GET", `${fly}/{id}`, runnerId, null],
      ["fly", "listMachines", "GET", fly, null, null],
      ["fly", "stopMachine", "POST", `${fly}/{id}/stop`, runnerId, null],
      ["fly", "destroyMachine", "DELETE", `${fly}/{id}`, runnerId, null],
    ]);
    expect(new Set(rec.calls.map((c) => `${c.status}/${c.latencyMs}/${c.attempt}`))).toEqual(new Set(["200/0/1"]));
  });
});

describe("T4 — the fake's output state and session ids (spec §5.6 D3, §5.7)", () => {
  const flush = () => new Promise((r) => setImmediate(r));

  it("the five per-session calls record their session id on the provider-call row, exactly as the real adapter does", async () => {
    const rec = new FakeRecorder();
    const ingest = new FakeIngest({ clock: () => 0, recorder: rec });
    const { inputId } = await ingest.createLiveInput({ sessionId: "s1", slot: 0 });
    const out = await ingest.addOutput(inputId, { url: "rtmps://a.rtmps.youtube.com/live2", streamKey: "k" }, { sessionId: "sess-9" });
    let checked = 0;
    for (const [op, run] of [
      ["inputStatus", () => ingest.inputStatus(inputId, { sessionId: "sess-9" })],
      ["addOutput", () => ingest.addOutput(inputId, { url: "rtmps://a.rtmps.youtube.com/live2", streamKey: "k2" }, { sessionId: "sess-9" })],
      ["outputState", () => ingest.outputState(inputId, { sessionId: "sess-9" })],
      ["removeOutput", () => ingest.removeOutput(inputId, out, { sessionId: "sess-9" })],
      ["setInputEnabled", () => ingest.setInputEnabled(inputId, false, { sessionId: "sess-9" })],
    ] as const) {
      await run();
      await flush();
      expect(rec.calls.at(-1), op).toMatchObject({ operation: op, sessionId: "sess-9" });
      checked++;
    }
    expect(checked).toBe(5);
  });

  it(`a key starting with FAKE_CONNECTING_KEY_PREFIX reads unknown before the input connects and connecting after — never ok — and reads nothing else to decide`, async () => {
    let now = 0;
    const rec = new FakeRecorder();
    const ingest = new FakeIngest({ clock: () => now, connectAfterMs: 3000, recorder: rec });
    const { inputId } = await ingest.createLiveInput({ sessionId: "s1", slot: 0 });
    await ingest.addOutput(inputId, { url: "rtmps://a.rtmps.youtube.com/live2", streamKey: `${FAKE_CONNECTING_KEY_PREFIX}abc` });
    await flush();
    const before = rec.calls.length;
    expect(await ingest.outputState(inputId)).toBe("unknown");
    now = 3000;   // exactly connectAfterMs: inputStatus's own boundary (connected at >=)
    expect(await ingest.outputState(inputId)).toBe("connecting");
    await flush();
    expect(rec.calls.slice(before).map((c) => c.operation), "no hidden inputStatus").toEqual(["outputState", "outputState"]);
    // The positive pair: an ordinary key on a connected input is ok.
    const plain = await ingest.createLiveInput({ sessionId: "s2", slot: 0 });
    await ingest.addOutput(plain.inputId, { url: "rtmps://a.rtmps.youtube.com/live2", streamKey: "plain" });
    now = 6000;
    expect(await ingest.outputState(plain.inputId)).toBe("ok");
  });

  it("T9a (D3 walkthrough): a RECOVERING connecting key reads unknown before the connect, connecting for its duration after it, then ok — at exactly that duration, not one ms before", async () => {
    let now = 0;
    const ingest = new FakeIngest({ clock: () => now, connectAfterMs: 3000 });
    const { inputId } = await ingest.createLiveInput({ sessionId: "s1", slot: 0 });
    const key = fakeRecoveringKey(45_000, "abc");
    expect(key.startsWith(FAKE_CONNECTING_KEY_PREFIX), "still a connecting key — the same family the fake already reads").toBe(true);
    await ingest.addOutput(inputId, { url: "rtmps://a.rtmps.youtube.com/live2", streamKey: key });
    const at = async (ms: number) => { now = ms; return ingest.outputState(inputId); };
    const seen: [number, string][] = [];
    for (const ms of [0, 2999, 3000, 3000 + 45_000 - 1, 3000 + 45_000, 3000 + 90_000]) seen.push([ms, await at(ms)]);
    expect(seen).toEqual([
      [0, "unknown"], [2999, "unknown"],                       // before the input connects: Cloudflare reports nothing
      [3000, "connecting"], [3000 + 45_000 - 1, "connecting"], // the destination not receiving, for N s after the connect
      [3000 + 45_000, "ok"], [3000 + 90_000, "ok"],             // then it receives, and stays receiving
    ]);
    // A plain connecting key (no duration) never recovers — the existing contract, unchanged.
    const forever = await ingest.createLiveInput({ sessionId: "s2", slot: 0 });
    await ingest.addOutput(forever.inputId, { url: "rtmps://a.rtmps.youtube.com/live2", streamKey: `${FAKE_CONNECTING_KEY_PREFIX}def` });
    now = 3000 + 10 * 45_000;
    expect(await ingest.outputState(forever.inputId)).toBe("connecting");
    // A malformed duration is refused at the key's making, never silently read as "forever".
    for (const bad of [-1, 1.5, Number.NaN]) expect(() => fakeRecoveringKey(bad, "x"), String(bad)).toThrow();
  });
});
