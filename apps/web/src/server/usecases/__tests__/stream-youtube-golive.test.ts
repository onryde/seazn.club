// YouTube Connect T11 (spec §6.1, §6.2, §6.3, §9.2; plan T11 with its post-T1, post-T2 and post-T3 amendments; R12): Go live
// on an API-backed destination streams into a broadcast the server prepared at YouTube. Admission prepares it (T10's
// `prepareYoutubeBroadcast`) after its own probe passes and before the storage read, the session insert names it
// (`youtube_broadcast_id`, `api_backed`), `attachPrepared` marks it live in the same transaction, and every throw between the
// prepare and the session's commit abandons it (`abandonPrepared`: deleted at YouTube, its row `failed`, never left upcoming).
// The session's Cloudflare output then carries the POOLED key the broadcast is bound to, never a key of the destination's own.
//
// Everything runs through the REAL start path (`createSession` → `startBroadcast`), the real prepare against a FakeYouTube,
// the real connect save (`_connect-rig`), FakeIngest and FakeRunner. Three seams are spied, each a pass-through unless a test
// steers it, and each test that steers one says why: `admit` (to refuse no_credits INSIDE the admission transaction only —
// nothing else re-reads the balance there), `prepareYoutubeBroadcast` (to hand the insert a mismatched answer, the guard's
// caller bug) and `abandonPrepared` (counted).
//
// Expected values are the spec's and Google's literals, typed here and never imported from the code under test:
//   - grace is 5 minutes after Stop (D4): a restart 4 minutes after Stop reuses the broadcast, 6 minutes after does not;
//   - "10 active streams allowed per channel" (support.google.com/youtube/answer/2474026, spec §3.1);
//   - spec §9.2 names SIX refusal codes; statuses 409, except youtube_limit_reached 429 and youtube_unavailable 503 (plan T10).
//
// Sport: not applicable — streaming is sport-agnostic (global-constraints "Test rules"); every rig rides `generic`.
// Secrets: a stream key is compared by FINGERPRINT (`fp`), so a failing assertion never prints one.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, randomBytes, randomUUID } from "node:crypto";

const sentry = vi.hoisted(() => ({ captureError: vi.fn() }));
vi.mock("@/lib/sentry", () => ({ captureError: sentry.captureError }));

/** `admit`, spied: a pass-through unless a test installs `override` (answering for one call, or null to pass through). */
const admitHook = vi.hoisted(() => ({ override: null as null | ((input: unknown) => unknown) }));
vi.mock("@/server/relay/domain/session", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/relay/domain/session")>();
  return {
    ...real,
    admit: vi.fn((input: Parameters<typeof real.admit>[0]) => (admitHook.override?.(input) as ReturnType<typeof real.admit> | null) ?? real.admit(input)),
  };
});

/** prepare, spied: a pass-through unless a test installs `answer` (what the next prepare answers instead of preparing). */
const prepareHook = vi.hoisted(() => ({ answer: null as null | (() => Promise<unknown>) }));
vi.mock("@/server/youtube/prepare", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/youtube/prepare")>();
  return {
    ...real,
    prepareYoutubeBroadcast: vi.fn((a: Parameters<typeof real.prepareYoutubeBroadcast>[0], port: Parameters<typeof real.prepareYoutubeBroadcast>[1]) => {
      const answer = prepareHook.answer;
      prepareHook.answer = null;
      return answer ? (answer() as ReturnType<typeof real.prepareYoutubeBroadcast>) : real.prepareYoutubeBroadcast(a, port);
    }),
    abandonPrepared: vi.fn(real.abandonPrepared),
  };
});

/** The consent text's version, stubbable: a connection ticked under version 1 reads OUTDATED once the stub says 2. */
const consent = vi.hoisted(() => ({ version: null as number | null }));
vi.mock("@/lib/youtube", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/youtube")>();
  return { ...real, get YOUTUBE_CONSENT_VERSION() { return consent.version ?? real.YOUTUBE_CONSENT_VERSION; } };
});

import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { ApiV1Error, apiV1 } from "@/lib/client-v1";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { STREAM_PLATFORM_PRESETS, TARGET_UNREADABLE } from "@/lib/stream-destinations";
import { CREATE_ERROR_KEYS, createErrorCode } from "@/lib/stream-session-view";
import { YOUTUBE_CONSENT_VERSION } from "@/lib/youtube";
import type { AuthCtx } from "@/server/api-v1/auth";
import { v1 } from "@/server/api-v1/http";
import { RelayJobSession } from "@/server/api-v1/schemas";
import { pairPresentPhone, rigTarget, rigUser, spendMonthlyStreamGrant } from "@/server/relay/__tests__/_session-rig";
import { ACTIVE_STATES } from "@/server/relay/domain/session";
import { FakeIngest, FakeRunner } from "@/server/relay/fakes";
import { archiveStreamTarget, readFirstInput } from "@/server/relay/secret-columns";
import { mintRelayToken } from "@/server/relay/tokens";
import { connect as connectChannel } from "@/server/youtube/__tests__/_connect-rig";
import { readEndFacts } from "@/server/youtube/end-rule";
import { FakeYouTube } from "@/server/youtube/fake";
import type { YoutubeErrorCode } from "@/server/youtube/port";
import { abandonPrepared, prepareYoutubeBroadcast, type Prepared } from "@/server/youtube/prepare";
import { divisionRig, seedOrg } from "./_rig";
import { grantCredits } from "../stream-credits";
import { createStreamTarget } from "../stream-targets";
import { createSession as organiserStart, currentSession, heartbeat, sessionFactsForJob, stopSession, type SessionDeps } from "../stream-sessions";

const HAS_DB = !!process.env.DATABASE_URL;

// ---- spec and Google literals -------------------------------------------------------------------------------------------
const GRACE_MINUTES = 5;
const CHANNEL_STREAM_CAP = 10;
const STATUS_OF: Record<string, number> = {
  youtube_reconnect_needed: 409, youtube_live_not_enabled: 409, youtube_live_blocked: 409,
  youtube_limit_reached: 429, youtube_channel_busy: 409, youtube_unavailable: 503,
};
/** §9.2: the six refusal codes a Go live on a YouTube destination can meet. */
const REFUSAL_CODE_COUNT = 6;
const OPEN = ["created", "bound", "reserved", "live"];

const MIN = 60_000;
/** A storage pool no plausible number of foreign reservations can exhaust (stream-sessions.test.ts's ROOMY_STORAGE_MINUTES). */
const ROOMY_STORAGE_MINUTES = 100_000_000;

// ---- KEKs and the composed image (stream-sessions.test.ts precedent: CI supplies none of them) --------------------------
const ENV = ["RELAY_KEK", "YOUTUBE_TOKEN_KEK", "RELAY_IMAGE"] as const;
const savedEnv = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
beforeAll(() => {
  process.env.RELAY_KEK = randomBytes(32).toString("hex");
  process.env.YOUTUBE_TOKEN_KEK = randomBytes(32).toString("hex");
  process.env.RELAY_IMAGE = "registry.fly.io/seazn-relay:t11-test";
});
afterAll(() => {
  for (const k of ENV) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});
beforeEach(() => {
  sentry.captureError.mockClear();
  vi.mocked(prepareYoutubeBroadcast).mockClear();
  vi.mocked(abandonPrepared).mockClear();
});
afterEach(() => {
  admitHook.override = null;
  prepareHook.answer = null;
  consent.version = null;
});

/** A stream destination's fingerprint: equal destinations, equal prints; the key itself never reaches a failure message. */
const fp = (t: { url: string; streamKey: string }) => createHash("sha256").update(`${t.url}\n${t.streamKey}`).digest("hex").slice(0, 12);

// ---- the world ----------------------------------------------------------------------------------------------------------
type Mode = "passthrough" | "composed";
interface World {
  auth: AuthCtx; orgId: string; fixtures: string[]; targetId: string; connectionId: string;
  fake: FakeYouTube; ingest: FakeIngest; runner: FakeRunner; deps: SessionDeps; tick(ms: number): void;
  /** Every key YouTube handed out (`insertStream`), in order — the producer side of "the pooled key". */
  issued: { url: string; streamKey: string }[];
  /** Every Cloudflare output asked for, in order. */
  outputs: { inputId: string; target: { url: string; streamKey: string } }[];
  /** Cloudflare inputs created. */
  inputs: () => number;
}

async function override(orgId: string, key: string, value: boolean) {
  await sql`insert into org_entitlement_overrides (org_id, feature_key, bool_value, reason)
            values (${orgId}, ${key}, ${value}, 't11 unit')
            on conflict (org_id, feature_key) do update set bool_value = ${value}`;
  await invalidateOrgEntitlements(orgId);
}

/** An org with the relay, `fixtures` fixtures each with a present phone, `credits` match credits, and a channel connected
 *  through the real save (its connection and its API destination). Its own FakeYouTube, so every count is this test's. */
async function world(o: { fixtures?: number; credits?: number } = {}): Promise<World> {
  const seeded = await seedOrg();
  const auth = { ...seeded.auth, userId: await rigUser() };
  const n = o.fixtures ?? 1;
  let entrants = 2;
  while ((entrants * (entrants - 1)) / 2 < n) entrants++;
  const d = await divisionRig(auth, { entrants });
  if (d.fixtureIds.length < n) throw new Error(`rig made ${d.fixtureIds.length} fixtures, the test needs ${n}`);
  await override(auth.orgId, "streaming.overlay", true);
  await override(auth.orgId, "streaming.relay", true);
  const fixtures = d.fixtureIds.slice(0, n);
  for (const f of fixtures) await pairPresentPhone(f);
  await grantCredits({ orgId: auth.orgId, delta: o.credits ?? 1, createdBy: await rigUser(), note: "t11", idempotencyKey: randomUUID() });
  await spendMonthlyStreamGrant(auth.orgId);
  const c = await connectChannel({ auth, orgId: auth.orgId, userId: auth.userId });

  let now = Date.now();
  const ingest = new FakeIngest({ clock: () => now, connectAfterMs: 3000 });
  ingest.storage = { totalStorageMinutes: 0, totalStorageMinutesLimit: ROOMY_STORAGE_MINUTES, videoCount: 0 };
  const outputs: World["outputs"] = [];
  const addOutput = ingest.addOutput.bind(ingest);
  ingest.addOutput = async (inputId, target, meta) => {
    outputs.push({ inputId, target: { url: target.url, streamKey: target.streamKey } });
    return addOutput(inputId, target, meta);
  };
  let made = 0;
  const createLiveInput = ingest.createLiveInput.bind(ingest);
  ingest.createLiveInput = async (spec) => { made++; return createLiveInput(spec); };
  const runner = new FakeRunner();
  const fake = new FakeYouTube({ now: () => new Date(now) });
  const issued: World["issued"] = [];
  const insertStream = fake.insertStream.bind(fake);
  fake.insertStream = async (at, a) => {
    const s = await insertStream(at, a);
    issued.push({ url: s.ingest.url, streamKey: s.ingest.streamKey });
    return s;
  };
  const deps: SessionDeps = { drivers: { ingest, runner }, now: () => new Date(now), appUrl: "http://app.test", youtube: fake };
  return {
    auth, orgId: auth.orgId, fixtures, targetId: c.targetId, connectionId: c.connectionId, fake, ingest, runner, deps,
    tick: (ms) => { now += ms; }, issued, outputs, inputs: () => made,
  };
}

/** The organiser's Go live, on the start's own clock (W5 needs the phone present at it). */
async function goLive(w: World, fixtureId: string, mode: Mode = "passthrough", targetId = w.targetId, deps = w.deps) {
  await pairPresentPhone(fixtureId, { at: deps.now() });
  return organiserStart(w.auth, fixtureId, { mode, targetId }, deps);
}
/** The refusal a Go live rejects with, or a failure when it resolves. */
async function refusalOf(p: Promise<unknown>): Promise<unknown> {
  return p.then(() => { throw new Error("expected Go live to be refused, it was admitted"); }, (e: unknown) => e);
}

interface SessionRow {
  id: string; state: string; api_backed: boolean; youtube_broadcast_id: string | null; ended_at: Date | null; mode: string;
}
const sessionRow = async (id: string): Promise<SessionRow> =>
  (await sql<SessionRow[]>`select id, state, api_backed, youtube_broadcast_id, ended_at, mode from fixture_stream_sessions where id = ${id}`)[0]!;
const sessionsOn = async (fixtureId: string) =>
  (await sql<{ n: number }[]>`select count(*)::int as n from fixture_stream_sessions where fixture_id = ${fixtureId}`)[0]!.n;
interface BroadcastRow { id: string; state: string; key_id: string | null; yt_broadcast_id: string | null; last_session_id: string | null; last_error_code: string | null }
const broadcastRow = async (id: string): Promise<BroadcastRow> =>
  (await sql<BroadcastRow[]>`select id, state, key_id, yt_broadcast_id, last_session_id, last_error_code from youtube_broadcasts where id = ${id}`)[0]!;
const broadcastsOf = (fixtureId: string) =>
  sql<BroadcastRow[]>`
    select id, state, key_id, yt_broadcast_id, last_session_id, last_error_code from youtube_broadcasts
     where fixture_id = ${fixtureId} order by created_at, id`;
const openOn = async (fixtureId: string) => (await broadcastsOf(fixtureId)).filter((b) => OPEN.includes(b.state)).length;
const ledger = async (orgId: string) =>
  (await sql<{ n: number; net: number }[]>`select count(*)::int as n, coalesce(sum(delta), 0)::int as net from org_stream_credits where org_id = ${orgId}`)[0]!;
const callsOf = (f: FakeYouTube, method: string) => f.calls.filter((c) => c.method === method).length;

/** Live: passthrough, the fake ingest connects 3 s after its input was made; composed, the Machine reports playing. */
async function reachLive(w: World, fixtureId: string, sid: string, mode: Mode): Promise<void> {
  if (mode === "passthrough") w.tick(3000);
  else await heartbeat(sid, w.runner.created.at(-1)!.jobToken, { state: "playing" }, w.deps);
  expect((await currentSession(w.auth, fixtureId, w.deps))!.state, "premise: the session went live").toBe("live");
}
/** Stop, carried to COMPLETED: passthrough completes on the stop itself; composed exits its Machine, observed by a poll. */
async function stopToEnd(w: World, fixtureId: string, sid: string, mode: Mode): Promise<void> {
  await stopSession(w.auth, fixtureId, sid, w.deps);
  if (mode === "composed") {
    const created = w.runner.created.find((c) => c.sessionId === sid)!;
    await heartbeat(sid, created.jobToken, { state: "stopped" }, w.deps);
    await currentSession(w.auth, fixtureId, w.deps);
  }
  expect((await sessionRow(sid)).state, "premise: the Stop carried the session to its end").toBe("completed");
}

describe.skipIf(!HAS_DB)("YouTube Connect T11 — Go live streams into the prepared broadcast", () => {
  it("EMPTY CASE FIRST: a PASTED destination's Go live writes api_backed false and no broadcast id, makes no youtube_broadcasts row and asks YouTube nothing; its output carries the destination's own key", async () => {
    const w = await world();
    const pastedKey = `pasted-${randomUUID()}`;
    const pasted = await createStreamTarget(w.auth, w.orgId, { kind: "youtube", label: "Pasted", streamKey: pastedKey });
    const { sessionId } = await goLive(w, w.fixtures[0]!, "passthrough", pasted.id);
    expect(await sessionRow(sessionId)).toMatchObject({ api_backed: false, youtube_broadcast_id: null, state: "warming" });
    expect(await broadcastsOf(w.fixtures[0]!)).toEqual([]);
    expect(w.fake.calls, "YouTube was asked nothing").toEqual([]);
    expect(w.issued).toEqual([]);
    expect(w.outputs).toHaveLength(1);
    expect(fp(w.outputs[0]!.target), "the destination's own saved key (D6: the platform preset's url)").toBe(fp({ url: STREAM_PLATFORM_PRESETS.youtube, streamKey: pastedKey }));
  });

  for (const mode of ["passthrough", "composed"] as const) {   // §9.2: both
    it(`${mode}: Go live on an API row → the session names the broadcast it streams into (api_backed), the broadcast is live with the session, and FakeIngest.addOutput got the POOLED {url, streamKey} YouTube issued — never a key of the destination's own`, async () => {
      const w = await world();
      const f = w.fixtures[0]!;
      const { sessionId } = await goLive(w, f, mode);
      const s = await sessionRow(sessionId);
      const [b, ...more] = await broadcastsOf(f);
      expect(more, "one broadcast for the fixture").toEqual([]);
      expect(s).toMatchObject({ api_backed: true, youtube_broadcast_id: b!.id, state: "warming", mode });
      expect(b).toMatchObject({ state: "live", last_session_id: sessionId });
      expect(b!.key_id, "bound to a pooled key").not.toBeNull();
      expect(callsOf(w.fake, "insertBroadcast")).toBe(1);
      expect(callsOf(w.fake, "bind")).toBe(1);
      expect(w.issued, "one key issued by YouTube").toHaveLength(1);
      expect(w.outputs, "exactly one Cloudflare output").toHaveLength(1);
      expect(fp(w.outputs[0]!.target), "the output carries the key YouTube issued for the broadcast").toBe(fp(w.issued[0]!));
      const outputInput = await sql.begin((tx) => readFirstInput(tx, sessionId, mode === "composed" ? "programme" : "camera"));
      expect(w.outputs[0]!.inputId, `the output sits on the session's ${mode === "composed" ? "programme" : "camera"} input`).toBe(outputInput!.ingestInputId);
      expect(vi.mocked(abandonPrepared), "nothing abandoned on an admitted Go live").not.toHaveBeenCalled();
    });

    it(`${mode}: Go live → Stop → Go live 4 min later (inside the ${GRACE_MINUTES}-min grace) → the SAME broadcast on both sessions, the same key, exactly ONE insertBroadcast; the end rule sees the first session through the real insert (T13 seam)`, async () => {
      const w = await world({ credits: 2 });
      const f = w.fixtures[0]!;
      const first = await goLive(w, f, mode);
      await reachLive(w, f, first.sessionId, mode);
      await stopToEnd(w, f, first.sessionId, mode);
      const s1 = await sessionRow(first.sessionId);
      expect(s1.youtube_broadcast_id).not.toBeNull();
      // T13's inert-seam guard: the session row carries the broadcast id FROM THE INSERT, so the end rule's read finds THIS
      // session — S is its ended_at — through a session the real start path made, not a fixture-built one.
      const facts = await sql.begin((tx) => readEndFacts(tx, s1.youtube_broadcast_id!));
      expect(facts.activeSessionOnBroadcast).toBe(false);
      expect(facts.latestEndedAt?.getTime(), "S = the stopped session's ended_at").toBe(s1.ended_at!.getTime());

      w.tick(4 * MIN);
      const second = await goLive(w, f, mode);
      const s2 = await sessionRow(second.sessionId);
      expect(s2.youtube_broadcast_id, "the restart continues the same video").toBe(s1.youtube_broadcast_id);
      expect(callsOf(w.fake, "insertBroadcast"), "exactly one broadcast made at YouTube").toBe(1);
      expect(w.issued, "and one key").toHaveLength(1);
      expect(w.outputs.map((o) => fp(o.target)), "both outputs carry that one pooled key").toEqual([fp(w.issued[0]!), fp(w.issued[0]!)]);
      expect(await broadcastRow(s1.youtube_broadcast_id!)).toMatchObject({ state: "live", last_session_id: second.sessionId });
      expect(vi.mocked(abandonPrepared)).not.toHaveBeenCalled();
    });
  }

  it(`passthrough: Stop → Go live 6 min later (past the ${GRACE_MINUTES}-min grace) → a NEW broadcast on a NEW key; the old one is claimed for its end (the right answer differs from an off-by-one)`, async () => {
    const w = await world({ credits: 2 });
    const f = w.fixtures[0]!;
    const first = await goLive(w, f);
    await reachLive(w, f, first.sessionId, "passthrough");
    await stopToEnd(w, f, first.sessionId, "passthrough");
    w.tick(6 * MIN);
    const second = await goLive(w, f);
    const [b1, b2] = [(await sessionRow(first.sessionId)).youtube_broadcast_id!, (await sessionRow(second.sessionId)).youtube_broadcast_id!];
    expect(b2).not.toBe(b1);
    expect(callsOf(w.fake, "insertBroadcast")).toBe(2);
    expect((await broadcastRow(b1)).state, "claimed for the end step").toBe("ending");
    expect(w.issued, "the first key is still held by the ending broadcast, so a second one is grown").toHaveLength(2);
    expect(fp(w.outputs.at(-1)!.target)).toBe(fp(w.issued[1]!));
    expect(fp(w.outputs.at(-1)!.target)).not.toBe(fp(w.issued[0]!));
  });

  it("each refusal code: refused with that code and status, credit ledger rows unchanged, addOutput calls 0, no open broadcast, no Cloudflare input created, nothing abandoned (prepare refused before handing anything over) — checked === 6", async () => {
    // Five come from YouTube (a bind refused after the broadcast WAS made, so "no open broadcast" is not vacuous); the sixth is
    // the pool's own: ten keys in use on ten open broadcasts.
    const VIA_PORT: YoutubeErrorCode[] = ["youtube_reconnect_needed", "youtube_live_not_enabled", "youtube_live_blocked", "youtube_limit_reached", "youtube_unavailable"];
    const seen = new Set<string>();
    for (const code of [...VIA_PORT, "youtube_channel_busy"]) {
      const busy = code === "youtube_channel_busy";
      const w = await world({ fixtures: busy ? CHANNEL_STREAM_CAP + 1 : 1 });
      const f = w.fixtures.at(-1)!;
      if (busy) {
        // The ten, through prepare itself (the producer of open broadcasts and pooled keys).
        for (const other of w.fixtures.slice(0, CHANNEL_STREAM_CAP)) await prepareYoutubeBroadcast({ orgId: w.orgId, fixtureId: other, targetId: w.targetId, now: w.deps.now() }, w.fake);
        expect(w.issued, "premise: the channel's ten keys are all in use").toHaveLength(CHANNEL_STREAM_CAP);
      } else {
        w.fake.failNext("bind", code as YoutubeErrorCode);
      }
      vi.mocked(abandonPrepared).mockClear();
      const atYouTube = w.fake.broadcastsCount();
      const before = await ledger(w.orgId);
      const err = await refusalOf(goLive(w, f));
      expect(err, code).toBeInstanceOf(HttpError);
      expect(err, code).toMatchObject({ status: STATUS_OF[code], code, extra: { connectionId: w.connectionId } });
      expect(await ledger(w.orgId), `${code}: the credit ledger is unchanged`).toEqual(before);
      expect(w.outputs, `${code}: no Cloudflare output`).toEqual([]);
      expect(w.inputs(), `${code}: no Cloudflare input`).toBe(0);
      expect(await openOn(f), `${code}: no open broadcast on the fixture`).toBe(0);
      expect(w.fake.broadcastsCount(), `${code}: nothing left at YouTube for the refused attempt`).toBe(atYouTube);
      expect(await sessionsOn(f), `${code}: no session`).toBe(0);
      expect(vi.mocked(abandonPrepared), `${code}: prepare refused, so nothing was handed over to abandon`).not.toHaveBeenCalled();
      if (!busy) expect(callsOf(w.fake, "insertBroadcast"), `${code}: premise — the broadcast was made before the refusal`).toBe(1);
      seen.add(code);
    }
    expect(seen.size).toBe(REFUSAL_CODE_COUNT);
  });

  it("a refusal from YouTube is followed by a Go live that streams (the sequence): a transient bind refusal, then the retry is admitted into a fresh broadcast", async () => {
    const w = await world();
    const f = w.fixtures[0]!;
    w.fake.failNext("bind", "youtube_unavailable");
    expect(await refusalOf(goLive(w, f))).toMatchObject({ status: 503, code: "youtube_unavailable" });
    const { sessionId } = await goLive(w, f);
    const s = await sessionRow(sessionId);
    expect(s).toMatchObject({ api_backed: true, state: "warming" });
    expect((await broadcastsOf(f)).map((b) => b.state), "the refused one failed, the retry's is live").toEqual(["failed", "live"]);
    expect(w.outputs).toHaveLength(1);
  });

  it("admission refused AFTER the broadcast was created — no_credits forced inside the transaction, storage exhausted, and the destination removed mid-flight — each: abandonPrepared once, deleteBroadcast called, the row 'failed' (admission_refused), no session, no Cloudflare input; then the next Go live streams (checked === 3)", async () => {
    const CASES = ["no_credits", "storage_exhausted", "target_removed"] as const;
    let checked = 0;
    for (const which of CASES) {
      const w = await world();
      const f = w.fixtures[0]!;
      const storageUsage = w.ingest.storageUsage.bind(w.ingest);
      let measured = false;
      w.ingest.storageUsage = async () => {
        measured = true;
        // Removed while prepare ran: Remove takes the same row lock admission takes next, and wins.
        if (which === "target_removed") await sql.begin((tx) => archiveStreamTarget(tx, w.orgId, w.targetId));
        return storageUsage();
      };
      // The balance is read once, before the probe — nothing else re-reads it inside the transaction, so the refusal is forced
      // on the one `admit` that follows the storage read (the admission's own verdict).
      if (which === "no_credits") admitHook.override = () => (measured ? { ok: false, refusal: "no_credits" } : null);
      if (which === "storage_exhausted") w.ingest.storage = { totalStorageMinutes: 500, totalStorageMinutesLimit: 500, videoCount: 1 };
      vi.mocked(abandonPrepared).mockClear();
      const err = await refusalOf(goLive(w, f));
      const expected = { no_credits: { status: 402, code: "no_credits" }, storage_exhausted: { status: 503, code: "storage_exhausted" }, target_removed: { status: 404 } }[which];
      expect(err, which).toMatchObject(expected);
      expect(vi.mocked(abandonPrepared), which).toHaveBeenCalledTimes(1);
      const p = vi.mocked(abandonPrepared).mock.calls[0]![0] as Prepared;
      expect(p.reused, which).toBe(false);
      expect(callsOf(w.fake, "deleteBroadcast"), `${which}: deleted at YouTube`).toBe(1);
      expect(w.fake.broadcastsCount(), `${which}: nothing left at YouTube`).toBe(0);
      expect(await broadcastRow(p.broadcastId), which).toMatchObject({ state: "failed", last_error_code: "admission_refused" });
      expect(await sessionsOn(f), `${which}: no session`).toBe(0);
      expect(w.inputs(), `${which}: no Cloudflare input`).toBe(0);
      expect(w.outputs, which).toEqual([]);
      if (which !== "target_removed") {
        // The sequence: the cause gone, the next Go live is admitted into a NEW broadcast (the failed row is not open).
        admitHook.override = null;
        w.ingest.storage = { totalStorageMinutes: 0, totalStorageMinutesLimit: ROOMY_STORAGE_MINUTES, videoCount: 0 };
        const { sessionId } = await goLive(w, f);
        const s = await sessionRow(sessionId);
        expect(s.youtube_broadcast_id, which).not.toBe(p.broadcastId);
        expect((await broadcastRow(s.youtube_broadcast_id!)).state, which).toBe("live");
      }
      checked++;
    }
    expect(checked).toBe(CASES.length);
  });

  it("storageUsage() throws after prepare → the broadcast is deleted at YouTube and its row 'failed', not left for the orphan sweep (R12); the Cloudflare fault itself is what the organiser's start rejects with", async () => {
    const w = await world();
    const f = w.fixtures[0]!;
    const fault = new Error("cloudflare storage read failed");
    w.ingest.storageUsage = async () => { throw fault; };
    const err = await refusalOf(goLive(w, f));
    expect(err).toBe(fault);
    expect(vi.mocked(abandonPrepared)).toHaveBeenCalledTimes(1);
    const [b] = await broadcastsOf(f);
    expect(b).toMatchObject({ state: "failed", last_error_code: "admission_refused" });
    expect(callsOf(w.fake, "deleteBroadcast")).toBe(1);
    expect(w.fake.broadcastsCount()).toBe(0);
    expect(await sessionsOn(f)).toBe(0);
  });

  it("a pooled key that will not open (RELAY_KEK changed after it was sealed) is 503 youtube_unavailable for the API row — abandoned, and NEVER the pasted key's 'replace the key' copy on the wire; positive pair: a pasted key that will not open IS that copy", async () => {
    const w = await world();
    const f = w.fixtures[0]!;
    const storageUsage = w.ingest.storageUsage.bind(w.ingest);
    const kek = process.env.RELAY_KEK;
    w.ingest.storageUsage = async () => {
      process.env.RELAY_KEK = randomBytes(32).toString("hex");   // a VALID key, not the one the pool was sealed under
      return storageUsage();
    };
    let err: unknown;
    try {
      err = await refusalOf(goLive(w, f));
    } finally {
      process.env.RELAY_KEK = kek;
    }
    expect(err).toMatchObject({ status: 503, code: "youtube_unavailable", extra: { connectionId: w.connectionId } });
    expect(vi.mocked(abandonPrepared)).toHaveBeenCalledTimes(1);
    expect(callsOf(w.fake, "deleteBroadcast")).toBe(1);
    expect(await sessionsOn(f)).toBe(0);
    const onWire = async (e: unknown) => {
      const res = await v1(async () => { throw e; });
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(res);
      const wired = await apiV1(`/api/v1/fixtures/${f}/stream-sessions`, { method: "POST", json: { mode: "passthrough", targetId: w.targetId } })
        .catch((x: unknown) => x)
        .finally(() => fetchSpy.mockRestore());
      expect(wired).toBeInstanceOf(ApiV1Error);
      return CREATE_ERROR_KEYS[createErrorCode(wired)];
    };
    expect((err as HttpError).code).not.toBe(TARGET_UNREADABLE);
    expect(await onWire(err), "the API row's refusal is not the replace-key copy").not.toBe(CREATE_ERROR_KEYS.target_unreadable);

    const unreadable = await rigTarget(w.orgId, "Unreadable", "youtube");   // a pasted row whose envelope will not open
    const pastedErr = await refusalOf(goLive(w, f, "passthrough", unreadable));
    expect(pastedErr).toMatchObject({ status: 422, code: TARGET_UNREADABLE });
    expect(await onWire(pastedErr), "positive pair: the pasted row's IS the replace-key copy").toBe(CREATE_ERROR_KEYS.target_unreadable);
  });

  it(`an 11th concurrent Go live on one channel → 409 youtube_channel_busy: ${CHANNEL_STREAM_CAP} matches stream at once on ${CHANNEL_STREAM_CAP} keys, the 11th is charged nothing and gets no Cloudflare output`, async () => {
    const w = await world({ fixtures: CHANNEL_STREAM_CAP + 1 });
    const live: string[] = [];
    for (const f of w.fixtures.slice(0, CHANNEL_STREAM_CAP)) live.push((await goLive(w, f)).sessionId);
    const keys = new Set<string>();
    for (const sid of live) keys.add((await broadcastRow((await sessionRow(sid)).youtube_broadcast_id!)).key_id!);
    expect(keys.size, "every match on its own key").toBe(CHANNEL_STREAM_CAP);
    expect(w.outputs).toHaveLength(CHANNEL_STREAM_CAP);
    const inputsBefore = w.inputs();
    const before = await ledger(w.orgId);
    const eleventh = w.fixtures[CHANNEL_STREAM_CAP]!;
    expect(await refusalOf(goLive(w, eleventh))).toMatchObject({ status: 409, code: "youtube_channel_busy" });
    expect(await ledger(w.orgId)).toEqual(before);
    expect(w.outputs, "no Cloudflare output for the 11th").toHaveLength(CHANNEL_STREAM_CAP);
    expect(w.inputs()).toBe(inputsBefore);
    expect(await sessionsOn(eleventh)).toBe(0);
    expect(callsOf(w.fake, "insertBroadcast")).toBe(CHANNEL_STREAM_CAP);
  });

  it("consent outdated (the consent text's version stubbed to 2, the connection ticked under 1) → Go live still succeeds (§6.1 step 5: consent is asked again at the next connect, never at Go live)", async () => {
    const w = await world();
    const [c] = await sql<{ consent_version: number }[]>`select consent_version from org_youtube_connections where id = ${w.connectionId}`;
    consent.version = c!.consent_version + 1;
    expect(YOUTUBE_CONSENT_VERSION, "premise: the stub is in force").toBe(c!.consent_version + 1);
    const { sessionId } = await goLive(w, w.fixtures[0]!);
    expect(await sessionRow(sessionId)).toMatchObject({ api_backed: true, state: "warming" });
    expect(w.outputs).toHaveLength(1);
  });

  it("two fixtures live at once on ONE API target → both admitted (no target_in_use), each on its own key; and two STARTS AT ONCE are both admitted too (api_backed is written by the insert, so the per-target index never sees them — no 23505 → target_in_use holder:null)", async () => {
    const w = await world({ fixtures: 4 });
    const [a, b, c, d] = w.fixtures as [string, string, string, string];
    const one = await goLive(w, a);
    const two = await goLive(w, b);
    for (const sid of [one.sessionId, two.sessionId]) expect(ACTIVE_STATES).toContain((await sessionRow(sid)).state);
    const keysOf = async (sids: string[]) => Promise.all(sids.map(async (sid) => (await broadcastRow((await sessionRow(sid)).youtube_broadcast_id!)).key_id));
    const seq = await keysOf([one.sessionId, two.sessionId]);
    expect(new Set(seq).size, "two keys").toBe(2);
    expect(new Set(w.outputs.map((o) => fp(o.target))).size, "two different keys reached Cloudflare").toBe(2);

    await pairPresentPhone(c, { at: w.deps.now() });
    await pairPresentPhone(d, { at: w.deps.now() });
    const both = await Promise.allSettled([organiserStart(w.auth, c, { mode: "passthrough", targetId: w.targetId }, w.deps), organiserStart(w.auth, d, { mode: "passthrough", targetId: w.targetId }, w.deps)]);
    const refused = both.flatMap((r) => (r.status === "rejected" ? [(r.reason as { code?: string; message?: string }).code ?? String(r.reason)] : []));
    expect(refused, "concurrent starts on one API target: none refused").toEqual([]);
    const made = both.map((r) => (r as PromiseFulfilledResult<{ sessionId: string }>).value.sessionId);
    expect(new Set(await keysOf(made)).size).toBe(2);
    expect(new Set([...seq, ...(await keysOf(made))]).size, "four matches, four keys").toBe(4);
  });

  it("a PASTED target: two fixtures → the second is still target_in_use (positive pair of the API row's concurrency)", async () => {
    const w = await world({ fixtures: 2 });
    const [a, b] = w.fixtures as [string, string];
    const pasted = await createStreamTarget(w.auth, w.orgId, { kind: "youtube", label: "Pasted", streamKey: `pasted-${randomUUID()}` });
    await goLive(w, a, "passthrough", pasted.id);
    expect(await refusalOf(goLive(w, b, "passthrough", pasted.id))).toMatchObject({ status: 409, code: "target_in_use" });
    expect(await sessionsOn(b)).toBe(0);
  });

  it("sessionFactsForJob on a passthrough API session answers target = the pooled key (the relay-job contract's shape, unchanged)", async () => {
    const w = await world();
    const { sessionId } = await goLive(w, w.fixtures[0]!);
    const token = await mintRelayToken({ sid: sessionId, scope: "relay-job", expiresAt: new Date(Date.now() + 10 * MIN) });
    const facts = await sessionFactsForJob(sessionId, token, w.deps);
    expect(() => RelayJobSession.parse(facts), "the strict contract shape").not.toThrow();
    expect(facts.mode).toBe("passthrough");
    expect(fp(facts.target), "the pooled key YouTube issued").toBe(fp(w.issued[0]!));
  });

  it("guard: an API-backed target that reaches the session insert with no prepared broadcast is refused BY NAME — no session, no Cloudflare input; and a pasted target that reaches it WITH one is refused by name too, abandoning it", async () => {
    const w = await world({ fixtures: 2 });
    const [a, b] = w.fixtures as [string, string];
    prepareHook.answer = async () => null;   // the caller bug: prepare said "pasted" for an API row
    const err = await refusalOf(goLive(w, a));
    expect(err).not.toBeInstanceOf(HttpError);
    expect((err as Error).message).toMatch(/API-backed destination reached the session insert with no prepared broadcast/);
    expect(await sessionsOn(a)).toBe(0);
    expect(w.inputs()).toBe(0);

    const pasted = await createStreamTarget(w.auth, w.orgId, { kind: "youtube", label: "Pasted", streamKey: `pasted-${randomUUID()}` });
    const stray: Prepared = { broadcastId: randomUUID(), reused: false, keyId: randomUUID() };
    prepareHook.answer = async () => stray;   // the converse caller bug: prepare answered a broadcast for a pasted row
    const err2 = await refusalOf(goLive(w, b, "passthrough", pasted.id));
    expect(err2).not.toBeInstanceOf(HttpError);
    expect((err2 as Error).message).toMatch(/pasted destination reached the session insert with a prepared broadcast/);
    expect(await sessionsOn(b)).toBe(0);
    expect(vi.mocked(abandonPrepared), "what was handed over is abandoned").toHaveBeenCalledWith(stray, w.fake);

    // Positive pair: the same fixture, prepare left alone → admitted.
    const { sessionId } = await goLive(w, a);
    expect((await sessionRow(sessionId)).api_backed).toBe(true);
  });

  it("apply() never touches youtube_broadcasts: a Stop leaves the broadcast row byte-identical — every column AND its row version (xmin) (§6.3)", async () => {
    let checked = 0;
    for (const mode of ["passthrough", "composed"] as const) {
      const w = await world();
      const f = w.fixtures[0]!;
      const { sessionId } = await goLive(w, f, mode);
      await reachLive(w, f, sessionId, mode);
      const bid = (await sessionRow(sessionId)).youtube_broadcast_id!;
      const snap = async () => (await sql<{ row: string; xmin: string }[]>`select to_jsonb(b)::text as row, b.xmin::text as xmin from youtube_broadcasts b where b.id = ${bid}`)[0];
      const before = await snap();
      await stopToEnd(w, f, sessionId, mode);
      expect(await snap(), mode).toEqual(before);
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("post-T1: an UPDATE that leaves a broadcast id on a session with api_backed false is refused by broadcast_implies_api_backed", async () => {
    const w = await world();
    const { sessionId } = await goLive(w, w.fixtures[0]!);
    expect((await sessionRow(sessionId)).youtube_broadcast_id, "premise: the session names its broadcast").not.toBeNull();
    const err = await sql`update fixture_stream_sessions set api_backed = false where id = ${sessionId}`.then(() => null, (e: unknown) => e);
    expect(err).toMatchObject({ code: "23514", constraint_name: "fixture_stream_sessions_broadcast_implies_api_backed" });
    expect((await sessionRow(sessionId)).api_backed).toBe(true);
  });
});
