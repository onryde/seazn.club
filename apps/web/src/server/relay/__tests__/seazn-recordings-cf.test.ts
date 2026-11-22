// The stream tick's Seazn lock pass (`lockSeaznRecordings`, Task 13) driven through the REAL Cloudflare adapter: its two calls —
// the listing and the lock — share the tick's 8 s Seazn slice with the replay move, so each gives up at the move's 4 s call
// timeout (Task 24 review I3 follow-up and re-review N3, 2026-11-22). This suite lives outside server/usecases on purpose: a file
// there may not import an adapter (port-boundary.test.ts), and these cases exist to prove the pass and the adapter TOGETHER — the
// pass asks for the timeout, the adapter's own AbortSignal ends the call, and the pass counts it and marks nothing.
// ONE SPORT, on purpose (TEST-STRATEGY rule 6): the pass never reads a sport rule; every rig rides `generic`.
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/sentry", () => ({ captureError: vi.fn() }));

import { FINALISATION_GRACE_SECONDS } from "@/server/relay/config";
import { CloudflareIngest } from "@/server/relay/ingest-cf";
import { FakeRecorder } from "@/server/relay/fakes";
import {
  HAS_DB, SEC, ZERO, inputOf, installSeaznLockEnv, live, lockRows, pass, rig, stopAndSettle, vid,
} from "@/server/usecases/__tests__/_seazn-lock-rig";

installSeaznLockEnv();

describe.skipIf(!HAS_DB)("lockSeaznRecordings through the real Cloudflare adapter — the 4 s call timeout", () => {
  // Task 24 review I3 follow-up (2026-11-22): the lock pass shares the tick's 8 s Seazn slice with the replay move, so its listing
  // gives up at the move's 4 s call timeout (the ruling's literal, typed here) instead of undici's 300 s. Driven through the REAL
  // Cloudflare adapter on a fetch that never answers: the timeout's own signal is what ends it, the pass counts each hung listing
  // as a failure, and no input is marked. The same inputs, listed by an answering fake, ARE marked — so the hang is what held them.
  it("a hung listing gives up at the 4 s call timeout: each counts as one failure and no input is marked; listed by an answering provider, the same inputs are marked", async () => {
    const r = await rig();
    const sids: string[] = [];
    let ended = 0;
    for (const f of r.fixtureIds) {
      const sid = await live(r, f, r.seazn);
      ended = Math.max(ended, await stopAndSettle(r, f, sid));
      sids.push(sid);
    }
    const markAt = ended + FINALISATION_GRACE_SECONDS * SEC + SEC;
    const deadlines: AbortController[] = [];
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => { const c = new AbortController(); deadlines.push(c); return c.signal; });
    const recorder = new FakeRecorder();
    const fetchImpl = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      const signal = init?.signal;
      return new Promise<Response>((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true }));
    }) as unknown as typeof fetch;
    const hung = new CloudflareIngest({ fetchImpl, accountId: "acct", token: "tok-seazn-lock", recorder });
    try {
      const pending = pass(r, [r.auth.orgId], { now: markAt, deps: { ...r.deps, drivers: { ...r.deps.drivers, ingest: hung } } });
      let checked = 0;
      for (let k = 0; k < sids.length; k++) {
        await vi.waitFor(() => expect(deadlines, `listing ${k + 1} asked for its timeout`).toHaveLength(k + 1));
        expect(timeout).toHaveBeenLastCalledWith(4_000);
        deadlines[k]!.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
        checked++;
      }
      expect(checked, "hung listings").toBe(2);
      expect(await pending).toEqual({ ...ZERO, failed: 2 });
      await new Promise((res) => setTimeout(res, 0));   // the provider-call record is fire-and-forget
      expect(recorder.calls.map((c) => [c.operation, c.errorCode])).toEqual([["listInputVideos", "timeout"], ["listInputVideos", "timeout"]]);
      for (const sid of sids) expect((await inputOf(sid, "programme")).locked_at, `${sid}: never marked on a hung listing`).toBeNull();
    } finally {
      timeout.mockRestore();
    }
    expect(await pass(r, [r.auth.orgId], { now: markAt + 60 * SEC })).toEqual(ZERO);
    for (const sid of sids) expect((await inputOf(sid, "programme")).locked_at?.getTime(), `${sid}: marked once listed`).toBe(markAt + 60 * SEC);
  });

  // Task 24 re-review N3 (2026-11-22): the lock itself — the pass's other Cloudflare call — gives up at the same 4 s. Through the
  // REAL adapter: the listing answers with one finished recording, the lock's POST never answers, and only the timeout's own signal
  // ends it. One failure, nothing locked, the input unmarked.
  it("re-review N3: a hung LOCK (requireSignedVideo) gives up at the 4 s call timeout: one failure, the recording never locked and the input never marked", async () => {
    const r = await rig();
    const f = r.fixtureIds[0];
    const sid = await live(r, f, r.seazn);
    const ended = await stopAndSettle(r, f, sid);
    const prog = await inputOf(sid, "programme");
    const markAt = ended + FINALISATION_GRACE_SECONDS * SEC + SEC;
    const v = vid("hung-lock");
    const listing = { success: true, errors: [], result: [{
      uid: v, liveInput: prog.uid, created: new Date(ended - 60 * SEC).toISOString(), status: { state: "ready" }, duration: 120,
      input: { width: 1920, height: 1080 }, requireSignedURLs: false,
    }] };
    const deadlines: AbortController[] = [];
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => { const c = new AbortController(); deadlines.push(c); return c.signal; });
    const recorder = new FakeRecorder();
    const fetchImpl = vi.fn((url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes("live_input_id=")) return Promise.resolve(Response.json(listing));
      const signal = init?.signal;
      return new Promise<Response>((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true }));
    }) as unknown as typeof fetch;
    const hung = new CloudflareIngest({ fetchImpl, accountId: "acct", token: "tok-seazn-lock", recorder });
    try {
      const pending = pass(r, [r.auth.orgId], { now: markAt, deps: { ...r.deps, drivers: { ...r.deps.drivers, ingest: hung } } });
      // The listing's own deadline is [0]; the lock's is [1].
      await vi.waitFor(() => expect(deadlines, "the lock asked for its timeout").toHaveLength(2));
      expect(timeout.mock.calls.map(([ms]) => ms), "listing, then lock: both at the move's 4 s").toEqual([4_000, 4_000]);
      deadlines[1]!.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
      expect(await pending).toEqual({ ...ZERO, failed: 1 });
      await new Promise((res) => setTimeout(res, 0));   // the provider-call record is fire-and-forget
      expect(recorder.calls.map((c) => [c.operation, c.errorCode])).toEqual([["listInputVideos", null], ["requireSignedVideo", "timeout"]]);
      expect(await lockRows(prog.id), "never locked").toEqual([]);
      expect((await inputOf(sid, "programme")).locked_at, "never marked on a hung lock").toBeNull();
    } finally {
      timeout.mockRestore();
    }
  });
});
