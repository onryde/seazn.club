// The fakes are what CI runs the state machine against, so they are held to
// the port's CONTRACT here — not to convenience. Claims: the per-input status
// SHAPE (C5); the clock-derived connect fires at the boundary and not before;
// deleteInput leaks videos exactly like Cloudflare (C2 — the sweep must
// delete videos first, and a fake that tidied them would hide the leak);
// a scripted 409-once on deleteVideo; outputState rejects on a host that
// says so and is `ok` otherwise (positive pair).
import { describe, expect, it } from "vitest";
import { FAKE_CONNECT_AFTER_MS_DEFAULT, FakeIngest, FakeRecorder, FakeRunner } from "../fakes";
import { DELETE_RECORDING_AFTER_DAYS, INGEST_TIMEOUT_SECONDS, HOLD_SLACK_SECONDS } from "../config";
import { pathTemplate } from "../sanitise";
import { machineNameFor } from "../domain/runner";
import { FlyApiError } from "../fly-client";
import { CREATE_REFUSED_STATUSES, createFailedFrom } from "../runner-fly";

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

  it("capabilities come from config.ts, SRT hold unmeasured (C8)", () => {
    const fake = new FakeIngest();
    expect(fake.capabilities).toEqual({
      timeoutSeconds: INGEST_TIMEOUT_SECONDS,
      deleteRecordingAfterDays: DELETE_RECORDING_AFTER_DAYS,
      holdWindowSeconds: { rtmps: INGEST_TIMEOUT_SECONDS + HOLD_SLACK_SECONDS, srt: null },
    });
  });
});

describe("FakeRunner", () => {
  it("create records the spec and destroy is idempotent", async () => {
    const runner = new FakeRunner();
    const spec = {
      sessionId: "s1", attempt: 1, jobToken: "t", appUrl: "http://app",
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
      sessionId: "s1", attempt: 1, jobToken: "t", appUrl: "http://app",
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

  it("the stop sequence on the fake: stop records SIGINT + grace, observe reads stopped with exit 0 / requestedStop, then auto-destroyed; a lost Machine reads its exit", async () => {
    const runner = new FakeRunner();
    const spec = { sessionId: "s1", attempt: 1, jobToken: "t", appUrl: "http://app", guest: { cpus: 4, memoryMb: 8192, cpuClass: "dedicated" as const }, region: "lhr", deadlineAt: new Date(0) };
    const h = await runner.create(spec);
    expect(await runner.observe(h.runnerId)).toEqual({ state: "running", exit: null });
    await runner.stop(h.runnerId, { signal: "SIGINT", timeoutSeconds: 10 });
    expect(runner.stops).toEqual([{ runnerId: h.runnerId, signal: "SIGINT", timeoutSeconds: 10 }]);
    expect(await runner.observe(h.runnerId)).toEqual({ state: "stopped", exit: { exitCode: 0, oomKilled: false, requestedStop: true } });
    expect((await runner.observe(h.runnerId)).state).toBe("destroyed"); // auto_destroy, as both R0 soaks did
    expect(await runner.list()).toEqual([]);
    const crashed = await runner.create({ ...spec, sessionId: "s2" });
    runner.setObserved(crashed.runnerId, "failed", { exitCode: 137, oomKilled: true, requestedStop: false });
    expect(await runner.observe(crashed.runnerId)).toEqual({ state: "failed", exit: { exitCode: 137, oomKilled: true, requestedStop: false } });
    expect(await runner.observe("never-created")).toEqual({ state: "destroyed", exit: null });   // the port: NEVER EXISTED = destroyed, exit null
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
    expect(await runner.observe(exited.runnerId)).toEqual({ state: "destroyed", exit: { exitCode: 3, oomKilled: false, requestedStop: false } });
    // Lane-A minors, Task 3 review m2: `stop` on a runner the fake never knew is a
    // no-op that still records, and the observe after it is unchanged. Hunt mutant E
    // survived on this; the port declares stop idempotent for an absent runner.
    await runner.stop("never-created", { signal: "SIGINT", timeoutSeconds: 10 });
    expect(runner.stops.at(-1)).toEqual({ runnerId: "never-created", signal: "SIGINT", timeoutSeconds: 10 });
    expect(await runner.observe("never-created")).toEqual({ state: "destroyed", exit: null });
    runner.failNextCreate(true);
    await expect(runner.create({ ...spec, sessionId: "s3" })).rejects.toMatchObject({ retryable: true });
    expect((await runner.create({ ...spec, sessionId: "s4" })).runnerId).toMatch(/^fake-machine-/);   // ONE create fails, not every one after
  });

  it("A3: failNextCreate chooses the PROOF — a status throws a real FlyApiError that the REAL createFailedFrom reads as made-nothing (a refusal status, or retryable) or unknown (anything else); a boolean throws a plain error, always unknown; no failure leaves a Machine listed", async () => {
    const runner = new FakeRunner();
    const spec = { sessionId: "s1", attempt: 1, jobToken: "t", appUrl: "http://app", guest: { cpus: 4, memoryMb: 8192, cpuClass: "dedicated" as const }, region: "lhr", deadlineAt: new Date(0) };
    const classify = async (proof: Parameters<FakeRunner["failNextCreate"]>[0]) => {
      runner.failNextCreate(proof);
      const err = await runner.create(spec).then(() => null, (e: unknown) => e);
      expect(err, JSON.stringify(proof)).not.toBeNull();
      return { isFly: err instanceof FlyApiError, trigger: createFailedFrom(err) };
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
    const spec = { sessionId: "s1", attempt: 1, jobToken: "t", appUrl: "http://app", guest: { cpus: 4, memoryMb: 8192, cpuClass: "dedicated" as const }, region: "lhr", deadlineAt: new Date(0) };
    const a = await runner.create(spec);
    const b = await runner.create({ ...spec, sessionId: "s2", attempt: 2 });
    runner.addOrphan("fake-machine-orphan", null);
    // T5-a: the NAME is the attempt identity Task 10 matches on — pinned by value (a fake that named every Machine r1 would pass a presence check).
    expect((await runner.list()).map((r) => [r.runnerId, r.sessionId, r.name])).toEqual([[a.runnerId, "s1", "relay-s1-r1"], [b.runnerId, "s2", "relay-s2-r2"], ["fake-machine-orphan", null, null]]);
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
    const h = await runner.create({ sessionId: "s1", attempt: 1, jobToken: "t", appUrl: "http://localhost", guest: { cpus: 1, memoryMb: 256, cpuClass: "shared" }, region: "lhr", deadlineAt: new Date(0) });
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
    await ingest.addOutput(inputId, { url: "rtmps://a.rtmps.youtube.com/live2", streamKey: "k" });
    await ingest.outputState(inputId);
    await ingest.storageUsage();
    await ingest.listVideos({ createdBefore: new Date(1) });
    await ingest.deleteVideo("vid-a");
    await ingest.deleteInput(inputId);
    const { runnerId } = await runner.create({ sessionId: "s1", attempt: 1, jobToken: "t", appUrl: "http://localhost", guest: { cpus: 1, memoryMb: 256, cpuClass: "shared" }, region: "lhr", deadlineAt: new Date(0) });
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
