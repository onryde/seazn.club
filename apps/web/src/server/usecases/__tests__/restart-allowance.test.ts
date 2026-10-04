// W23 (capture QR v2 T6b, owner 2026-10-01): three free restarts per reuse window, ONE authority. Every case drives the
// REAL start path (createSession → admission → go-live → consumeForSession) on fake drivers and an injected clock, and
// asserts the CREDIT LEDGER — the consume rows — never the flag alone. The rule, as the owner wrote it:
//   - inside the reuse window opened by a consume that stands (the "anchor"), a restart that reaches video is free while
//     fewer than three such restarts have been counted since the anchor; the 4th pays at live and re-anchors (O4, ruled
//     YES 2026-10-01), so the 5th is free again;
//   - a restart that never reached video never counts; the same session (a phone swap, an ingest that drops and returns)
//     never counts twice;
//   - the limit never BLOCKS: past it the start is an ordinary paid start, refused only by the balance gate.
// Expected values come from that text (and FREE_RESTARTS_PER_WINDOW, pinned to it in credits.test.ts), never from
// `restartAllowance`. ONE SPORT (TEST-STRATEGY rule 6): the allowance never reads the sport.
import { randomBytes, randomUUID } from "node:crypto";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { STREAM_POLL_MS } from "@/lib/stream-session-view";
import { CREDIT_REUSE_HOURS, FREE_RESTARTS_PER_WINDOW } from "@/server/relay/config";
import { admit } from "@/server/relay/domain/session";
import { FakeIngest, FakeRunner } from "@/server/relay/fakes";
import { pairPresentPhone, rigUser, spendMonthlyStreamGrant } from "@/server/relay/__tests__/_session-rig";
import { grantCredits } from "../stream-credits";
import { type SessionDeps, createSession, currentSession, stopSession } from "../stream-sessions";
import { createStreamTarget } from "../stream-targets";
import { seedOrg, startedDivisionWithFixture } from "./_rig";

// `admit`, spied — a PASS-THROUGH — so the agreement case can read the waiver admission actually weighed.
vi.mock("@/server/relay/domain/session", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/relay/domain/session")>();
  return { ...real, admit: vi.fn(real.admit) };
});

const HAS_DB = !!process.env.DATABASE_URL;

// A KEK of this file's own (stream-sessions.test.ts precedent): CI supplies none, and every sealed destination, input
// and stream code would otherwise throw "RELAY_KEK is not set".
const savedKek = process.env.RELAY_KEK;
beforeAll(() => { process.env.RELAY_KEK = randomBytes(32).toString("hex"); });
afterAll(() => {
  if (savedKek === undefined) delete process.env.RELAY_KEK;
  else process.env.RELAY_KEK = savedKek;
});

/** A storage pool no plausible number of foreign reservations can exhaust (stream-sessions.test.ts's). */
const ROOMY_STORAGE_MINUTES = 100_000_000;
/** The fake phone connects this long after its input is made; `video()` ticks past it. */
const CONNECT_AFTER_MS = 1000;
/** Each `video()` read must be a FRESH provider read: past the connect delay AND past the coalesced read's max age
 *  (stream-sessions.ts COALESCED_SAMPLE_MAX_AGE_MS = 2 × STREAM_POLL_MS, B0), or a read soon after another one is
 *  answered from the earlier sample and never sees the phone arrive (or drop). */
const FRESH_READ_MS = Math.max(CONNECT_AFTER_MS, 2 * STREAM_POLL_MS) + 500;

async function rig(opts: { credits: number }) {
  const seeded = await seedOrg();
  const auth = { ...seeded.auth, userId: await rigUser() };
  const { fixtureId } = await startedDivisionWithFixture(auth);
  for (const key of ["streaming.overlay", "streaming.relay"]) {
    await sql`insert into org_entitlement_overrides (org_id, feature_key, bool_value, reason) values (${auth.orgId}, ${key}, true, 'w23 unit')
              on conflict (org_id, feature_key) do update set bool_value = true`;
  }
  await invalidateOrgEntitlements(auth.orgId);
  if (opts.credits > 0) await grantCredits({ orgId: auth.orgId, delta: opts.credits, createdBy: await rigUser(), note: "unit", idempotencyKey: randomUUID() });
  await spendMonthlyStreamGrant(auth.orgId);   // the balance is exactly the pack credits granted above
  const target = await createStreamTarget(auth, auth.orgId, { kind: "youtube", label: "Club", streamKey: `k-${randomUUID().slice(0, 8)}` });
  let now = Date.now();
  const ingest = new FakeIngest({ clock: () => now, connectAfterMs: CONNECT_AFTER_MS });
  ingest.storage = { totalStorageMinutes: 0, totalStorageMinutesLimit: ROOMY_STORAGE_MINUTES, videoCount: 0 };
  const deps: SessionDeps = { drivers: { ingest, runner: new FakeRunner() }, now: () => new Date(now), appUrl: "http://app.test" };
  const tick = (ms: number) => { now += ms; };
  const consumes = async () => (await sql<{ n: number }[]>`
    select count(*)::int as n from org_stream_credits where org_id = ${auth.orgId} and reason = 'consume'`)[0]!.n;
  /** A Go live on the start's own clock, with the phone present (W5). */
  const start = async () => {
    await pairPresentPhone(fixtureId, { at: deps.now() });
    return (await createSession(auth, fixtureId, { mode: "passthrough", targetId: target.id }, deps)).sessionId;
  };
  /** The phone's video arrives: the next read takes the session live (and decides its credit). */
  const video = async () => {
    tick(FRESH_READ_MS);
    return (await currentSession(auth, fixtureId, deps))!;
  };
  const stop = async (sid: string) => stopSession(auth, fixtureId, sid, deps);
  const current = async () => (await currentSession(auth, fixtureId, deps))!;
  return { auth, fixtureId, target, ingest, deps, tick, consumes, start, video, stop, current };
}

describe.skipIf(!HAS_DB)("W23: three free restarts per reuse window — on the ledger", () => {
  it("BOUNDARY: a paid live, then three restarts that each reach video are free (no consume row added); the 4th pays at live; the paid 4th re-anchors, so the 5th is free again", async () => {
    const r = await rig({ credits: 3 });
    const s0 = await r.start();
    expect((await r.video()).state).toBe("live");
    expect(await r.consumes(), "the first live pays").toBe(1);
    await r.stop(s0);
    const paidAt: boolean[] = [];
    for (let restart = 1; restart <= FREE_RESTARTS_PER_WINDOW + 2; restart++) {
      const before = await r.consumes();
      const sid = await r.start();
      expect((await r.video()).state, `restart ${restart}`).toBe("live");
      paidAt.push((await r.consumes()) === before + 1);
      await r.stop(sid);
    }
    // W23's text: restarts 1..3 free, the 4th pays, the 5th (after the re-anchor) free.
    expect(paidAt).toEqual([false, false, false, true, false]);
    expect(await r.consumes()).toBe(2);
  });

  it("NO VIDEO: a restart stopped before its first ingest never counts — after three counted restarts and one without video, the next that reaches video is still the 4th and pays", async () => {
    const r = await rig({ credits: 3 });
    await r.stop(await r.start().then(async (sid) => { await r.video(); return sid; }));
    for (let i = 0; i < FREE_RESTARTS_PER_WINDOW; i++) {
      const sid = await r.start();
      await r.video();
      await r.stop(sid);
    }
    expect(await r.consumes(), "three counted restarts, all free").toBe(1);
    const dark = await r.start();
    await r.stop(dark);                           // stopped before any ingest: first_ingest_at stays null
    expect((await r.current()).restart, "the dark restart moved nothing").toMatchObject({ used: FREE_RESTARTS_PER_WINDOW, free: false });
    await r.start();
    await r.video();
    expect(await r.consumes(), "the next with video is the 4th: it pays").toBe(2);
  });

  it("SAME SESSION: a new phone taking the slot and an ingest that drops and returns on the live session never change `used`", async () => {
    const r = await rig({ credits: 2 });
    await r.stop(await r.start().then(async (sid) => { await r.video(); return sid; }));
    const sid = await r.start();
    await r.video();
    expect((await r.current()).restart, "one counted restart").toMatchObject({ used: 1, free: true });
    // A takeover (T4's shape, T8 builds it): the current pairing ends and another phone pairs on the SAME code.
    await sql`update fixture_stream_pairings set ended_at = now(), end_cause = 'replaced'
               where code_id = (select id from fixture_stream_codes where fixture_id = ${r.fixtureId} and ended_at is null) and ended_at is null`;
    await pairPresentPhone(r.fixtureId, { phone: `rig-takeover-${randomUUID()}`, at: r.deps.now() });
    // The ingest drops and returns on the same input.
    const [input] = await sql<{ ingest_input_id: string }[]>`select ingest_input_id from fixture_stream_inputs where session_id = ${sid}`;
    r.ingest.setState(input!.ingest_input_id, "disconnected");
    expect((await r.video()).ingest, "the drop was really read").toMatchObject({ state: "disconnected" });
    r.ingest.setState(input!.ingest_input_id, "connected");
    const after = await r.video();
    expect(after.id).toBe(sid);
    expect(after.restart, "still one").toMatchObject({ used: 1, free: true });
    expect(await r.consumes()).toBe(1);
  });

  it("NEVER BLOCKS: at the limit with a balance of 0 the Go live is the balance gate's ordinary 402 no_credits; with a balance of 1 the same Go live is admitted and pays", async () => {
    const r = await rig({ credits: 1 });
    await r.stop(await r.start().then(async (sid) => { await r.video(); return sid; }));
    for (let i = 0; i < FREE_RESTARTS_PER_WINDOW; i++) {
      const sid = await r.start();
      await r.video();
      await r.stop(sid);
    }
    expect(await r.consumes()).toBe(1);
    await expect(r.start()).rejects.toMatchObject({ status: 402, code: "no_credits" });
    await grantCredits({ orgId: r.auth.orgId, delta: 1, createdBy: await rigUser(), note: "unit", idempotencyKey: randomUUID() });
    await r.start();
    expect((await r.video()).state).toBe("live");
    expect(await r.consumes()).toBe(2);
  });

  it("AGREEMENT: at every step of the boundary sequence, admission's waiver, consumeForSession's decision, current.restart.free and the derived current.restartFree are all equal — five steps compared", async () => {
    const r = await rig({ credits: 3 });
    await r.stop(await r.start().then(async (sid) => { await r.video(); return sid; }));
    const spy = vi.mocked(admit);
    let compared = 0;
    const seen: boolean[] = [];
    for (let restart = 1; restart <= FREE_RESTARTS_PER_WINDOW + 2; restart++) {
      const view = await r.current();
      spy.mockClear();
      const before = await r.consumes();
      const sid = await r.start();
      const waived = spy.mock.calls.at(-1)![0].restartWithinReuseWindow;
      await r.video();
      const consumeFree = (await r.consumes()) === before;
      expect(view.restart, `restart ${restart}: a window is open`).not.toBeNull();
      const answers = { admission: waived, consume: consumeFree, restart: view.restart!.free, restartFree: view.restartFree };
      expect(new Set(Object.values(answers)).size, `restart ${restart}: ${JSON.stringify(answers)}`).toBe(1);
      seen.push(waived);
      compared++;
      await r.stop(sid);
    }
    expect(compared).toBe(5);
    expect(seen, "W23's text, step by step").toEqual([true, true, true, false, true]);
  });

  it("THE WINDOW CLOSES: CREDIT_REUSE_HOURS after the anchor, restart is null, restartFree false, and a Go live pays as today", async () => {
    const r = await rig({ credits: 2 });
    const s0 = await r.start();
    await r.video();
    await r.stop(s0);
    expect((await r.current()).restart, "open, nothing counted").toMatchObject({ windowOpen: true, used: 0, limit: FREE_RESTARTS_PER_WINDOW, free: true });
    r.tick(CREDIT_REUSE_HOURS * 3_600_000);
    const closed = await r.current();
    expect(closed.restart).toBeNull();
    expect(closed.restartFree).toBe(false);
    await r.start();
    await r.video();
    expect(await r.consumes()).toBe(2);
  });

  it("the EMPTY case: before any consume there is no window — restart null, restartFree false — and the first live pays", async () => {
    const r = await rig({ credits: 1 });
    const sid = await r.start();
    const warming = await r.current();
    expect(warming.restart).toBeNull();
    expect(warming.restartFree).toBe(false);
    await r.video();
    expect(await r.consumes()).toBe(1);
    await r.stop(sid);
  });
});

// Rule 10: drawn {goLive, ingest, stop} sequences on ONE fixture. The model knows only W23's text: the first live pays
// (it anchors), every 4th counted restart after an anchor pays (and re-anchors), a session without video never counts,
// and a Go live over a running session is refused. The consume count is compared after EVERY step.
type Step = "goLive" | "ingest" | "stop";
interface Model { active: { video: boolean } | null; anchored: boolean; counted: number; paid: number; fourth: boolean }
function modelStep(m: Model, step: Step): { refused: boolean } {
  if (step === "goLive") {
    if (m.active) return { refused: true };
    m.active = { video: false };
  } else if (step === "ingest") {
    if (m.active && !m.active.video) {
      m.active.video = true;
      if (!m.anchored) { m.anchored = true; m.paid++; m.counted = 0; }
      else if (m.counted >= FREE_RESTARTS_PER_WINDOW) { m.paid++; m.counted = 0; m.fourth = true; }
      else m.counted++;
    }
  } else if (m.active) {
    m.active = null;
  }
  return { refused: false };
}

/** A session attempt: Go live, then (mostly) video, then (mostly) Stop — so a run of ≤ 6 attempts can reach a 4th
 *  restart. A 4th restart needs FIVE sessions with video and four stops: 14 steps at the least. */
const attempt = fc.tuple(
  fc.oneof({ arbitrary: fc.constant(true), weight: 5 }, { arbitrary: fc.constant(false), weight: 1 }),
  fc.oneof({ arbitrary: fc.constant(true), weight: 5 }, { arbitrary: fc.constant(false), weight: 1 }),
).map(([video, stop]): Step[] => ["goLive", ...(video ? ["ingest" as const] : []), ...(stop ? ["stop" as const] : [])]);
const sequence = fc.array(attempt, { minLength: 1, maxLength: 6 }).map((xs) => xs.flat().slice(0, 16));
const FOURTH: Step[] = ["goLive", "ingest", "stop", "goLive", "ingest", "stop", "goLive", "ingest", "stop", "goLive", "ingest", "stop", "goLive", "ingest"];

describe.skipIf(!HAS_DB)("W23 as a SEQUENCE (rule 10)", () => {
  it("no drawn {goLive, ingest, stop} sequence breaks W23: after every step the consume rows equal the model's paid count; some runs reach a 4th restart", async () => {
    let runs = 0;
    let steps = 0;
    let reachedFourth = 0;
    await fc.assert(fc.asyncProperty(sequence, async (seq) => {
      const r = await rig({ credits: 10 });
      const m: Model = { active: null, anchored: false, counted: 0, paid: 0, fourth: false };
      let live: string | null = null;
      for (const [i, step] of seq.entries()) {
        const { refused } = modelStep(m, step);
        if (step === "goLive") {
          const out = await r.start().then((sid) => ({ sid, err: null as unknown }), (err: unknown) => ({ sid: null, err }));
          if (refused) expect(out.err, `step ${i} goLive over a running session`).toMatchObject({ status: 409, code: "active_session" });
          else { expect(out.err, `step ${i} goLive`).toBeNull(); live = out.sid; }
        } else if (step === "ingest") {
          if (live) await r.video();
        } else if (live) {
          await r.stop(live);
          live = null;
        }
        expect(await r.consumes(), `step ${i} (${step}) of ${JSON.stringify(seq)}`).toBe(m.paid);
        steps++;
      }
      if (m.fourth) reachedFourth++;
      runs++;
    }), { numRuns: 12, seed: 20261001, examples: [[FOURTH]] });
    expect(runs).toBeGreaterThan(0);
    expect(steps).toBeGreaterThan(0);
    expect(reachedFourth, "runs that reached a 4th restart").toBeGreaterThan(0);
  });
});
