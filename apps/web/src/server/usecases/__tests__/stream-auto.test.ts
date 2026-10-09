// Capture QR v2 PR-2 T4 (spec §7.2; W7, A4, A12, A16; plan R-1, R-3, FP1, FP7-FP13) — AUTOMATIC START: `maybeAutoStart`, its
// refusal mapper, `postBeat`'s step 6 and the organiser-Stop stamp in `stopSession`. DB-backed through the REAL beat
// (`postBeat`), the REAL switch (`saveStreamSettings`), the REAL organiser Go live and Stop (`createSession`, `stopSession`)
// and the ONE start path (`startBroadcast`) on FAKE drivers and the rig's tickable clock.
//
// Every expected value comes from a declaration: the conjunct and refusal lists (`AUTO_START_CONJUNCTS`,
// `AUTO_START_REFUSALS`), config.ts's constants, the contract's zod twin — never from stream-auto.ts. Each table counts the
// rows it ran and fails at zero. Each falsified conjunct is followed by its positive pair on the SAME rig (the one thing
// undone), so a rig that could never start would not pass for "refused".
//
// "Another sport": the predicate reads the fixture's status and nothing about the sport, so one case runs on the cricket rig.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { sql, type Tx } from "@/lib/db";
import { HttpError, PaymentRequiredError } from "@/lib/errors";
import { DESTINATION_NOT_ALLOWED, TARGET_UNREADABLE } from "@/lib/stream-destinations";
import { CaptureBeat, CaptureBeatAnswer } from "@/server/api-v1/capture-schemas";
import { rigUser, sessionOnTarget, spendMonthlyStreamGrant, pairPresentPhone } from "@/server/relay/__tests__/_session-rig";
import { AUTO_START_RETRY_SECONDS, WARMING_TIMEOUT_MINUTES } from "@/server/relay/config";
import { AUTO_START_CONJUNCTS, AUTO_START_REFUSALS, type AutoStartRefusal } from "@/server/relay/domain/auto-stream";
import { postBeat, postStart } from "../capture-phone";
import { fixtureStreamTarget, reissueStreamCode, saveStreamSettings } from "../stream-codes";
import { streamPhone } from "../stream-phone";
import { grantCredits } from "../stream-credits";
import { autoStartRefusalOf, maybeAutoStart } from "../stream-auto";
import { apply, createSession, startBroadcast, stopSession, tickSession } from "../stream-sessions";
import { captureRig, override, phoneId, type CaptureRig } from "./_capture-rig";
import { startedDivisionWithFixture } from "./_rig";

const sentry = vi.hoisted(() => ({ captureError: vi.fn() }));
vi.mock("@/lib/sentry", () => ({ captureError: sentry.captureError }));

const HAS_DB = !!process.env.DATABASE_URL;

const ENV_KEYS = ["RELAY_KEK", "AUTH_SECRET", "OAUTH_BASE_URL", "NEXT_PUBLIC_BASE_URL", "STREAM_INGEST_HOST", "STREAM_PLAYBACK_HOST", "STREAM_SRT_ENABLED", "RELAY_DRIVERS"] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const KEK = randomBytes(32).toString("hex");
function baseEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.RELAY_KEK = KEK;
  process.env.AUTH_SECRET = "stream-auto-test-secret";
}
beforeAll(baseEnv);
beforeEach(() => { baseEnv(); sentry.captureError.mockClear(); });
afterAll(() => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

type Beat = ReturnType<typeof CaptureBeat.parse>;
const SEC = 1000;
/** The fake's connect delay for a rig that must never reach live on its own. */
const NEVER = 3_600_000;

/** A valid beat at the rig's clock. The default mode is `automatic`: every beat in this file is the AUTOMATIC phone's. */
function body(r: CaptureRig, phone: string, over: Partial<Beat> = {}): Beat {
  return CaptureBeat.parse({
    code: r.code, slot: 0, phone, claim: null, device: null, sid: null, at: r.now().toISOString(), state: "paired",
    cause: null, notReady: null, startFailed: null, stopped: null, mode: "automatic", transport: null, bitrateKbps: null,
    delivery: "unknown", deliveredLagS: null, audioOk: null, battery: null, thermal: null, dataUsedMB: null,
    appVersion: "stream-auto-test/1", ...over,
  });
}
let answersChecked = 0;
async function beat(r: CaptureRig, phone: string, over: Partial<Beat> = {}, via: { code: string; tok: string } = r) {
  const a = await postBeat(via.code, via.tok, body(r, phone, { code: via.code, ...over }), r.deps, r.now());
  expect(CaptureBeatAnswer.parse(a)).toEqual(a);
  answersChecked++;
  return a;
}

type SRow = {
  auto_stream: boolean; auto_started_at: Date | null; auto_start_session_id: string | null; auto_start_blocked_at: Date | null;
  auto_start_attempted_at: Date | null; auto_start_refusal: string | null; target_chosen: boolean; target_id: string | null;
};
const settingsOf = async (fx: string): Promise<SRow | null> => (await sql<SRow[]>`
  select auto_stream, auto_started_at, auto_start_session_id, auto_start_blocked_at, auto_start_attempted_at, auto_start_refusal,
         target_chosen, target_id
    from fixture_stream_settings where fixture_id = ${fx}`)[0] ?? null;
type SessRow = {
  id: string; state: string; start_cause: string; created_by: string; pairing_id: string | null; code_id: string | null; target_id: string;
  first_ingest_at: Date | null; end_reason: string | null;
};
const sessionsOf = (fx: string) => sql<SessRow[]>`
  select id, state, start_cause, created_by, pairing_id, code_id, target_id, first_ingest_at, end_reason
    from fixture_stream_sessions where fixture_id = ${fx} order by created_at, id`;
const autoSessionsOf = async (fx: string) => (await sessionsOf(fx)).filter((s) => s.start_cause === "automatic");
const setStatus = (fx: string, status: string) => sql`update fixtures set status = ${status} where id = ${fx}`;
const issuerOf = async (fx: string) => (await sql<{ issued_by: string }[]>`
  select issued_by from fixture_stream_codes where fixture_id = ${fx} and ended_at is null`)[0]!.issued_by;
const pairingIdOf = async (r: CaptureRig, phone: string) => (await sql<{ id: string }[]>`
  select p.id from fixture_stream_pairings p join fixture_stream_codes c on c.id = p.code_id
   where c.fixture_id = ${r.fixtureId} and p.phone = ${phone} and p.ended_at is null`)[0]!.id;
const actionRow = async (sid: string, type: string) => (await sql<{ source: string; actor_user_id: string | null }[]>`
  select source, actor_user_id from fixture_stream_events where session_id = ${sid} and kind = 'action' and type = ${type} order by seq`);
/** A session ended by a path that is NOT an organiser Stop (so it stamps nothing), left terminal. */
async function endBySweep(r: CaptureRig, sid: string): Promise<void> {
  await apply(sid, { type: "stop", reason: "phone_lost" }, r.deps);
  await sql`update fixture_stream_sessions set state = 'completed', ended_at = coalesce(ended_at, now()) where id = ${sid} and state = 'ending'`;
  expect((await sessionsOf(r.fixtureId)).find((s) => s.id === sid)!.state, "PREMISE: the session is terminal").toBe("completed");
}

/** Waits (bounded) until at least `n` backends are queued on a row lock running a statement that matches `pattern`. */
async function waitForLockWaiters(pattern: string, n: number): Promise<number> {
  const deadline = Date.now() + 15_000;
  let waiting = 0;
  while (Date.now() < deadline) {
    waiting = (await sql<{ n: number }[]>`
      select count(*)::int as n from pg_stat_activity
       where wait_event_type = 'Lock' and query ilike ${pattern} and pid <> pg_backend_pid()`)[0]!.n;
    if (waiting >= n) break;
    await new Promise((res) => setTimeout(res, 25));
  }
  return waiting;
}
/** Holds `lock` (a statement that takes a row lock) in a transaction, runs `queue` (which starts work that will block on
 *  it) and `whileHeld` (after `waiters` backends are parked behind it), then COMMITS what `whileHeld` wrote. Returns what
 *  `queue` started, settled. */
async function parked<T>(
  lock: (tx: Tx) => Promise<unknown>, queue: () => Promise<T>[], pattern: string, whileHeld: (tx: Tx) => Promise<void>,
): Promise<T[]> {
  let taken!: () => void;
  const lockTaken = new Promise<void>((res) => { taken = res; });
  let go!: () => void;
  const proceed = new Promise<void>((res) => { go = res; });
  const holder = sql.begin(async (tx) => {
    await lock(tx);
    taken();
    await proceed;
    await whileHeld(tx);
  });
  await lockTaken;
  const started = queue();
  const waiting = await waitForLockWaiters(pattern, started.length);
  go();   // always released, so a missed premise fails the test instead of hanging the file
  await holder;
  const settled = await Promise.all(started);
  expect(waiting, "PREMISE: every queued backend was parked behind the held row lock").toBeGreaterThanOrEqual(started.length);
  return settled;
}
const CLAIM_WAITER = "%set auto_start_attempted_at = $1%";
const SESSION_LOCK_WAITER = "%from fixture_stream_sessions where id = $1 for update%";

/** The rig every auto start case begins from: credits, a paired phone on its operator-mode claim, the switch ON, the match
 *  in play. Nothing is falsified. */
async function autoRig(opts: Parameters<typeof captureRig>[0] = {}) {
  const r = await captureRig({ credits: 3, connectAfterMs: NEVER, ...opts });
  const phone = phoneId("a");
  await beat(r, phone, { claim: "new", mode: "operator" });
  await saveStreamSettings(r.auth, r.fixtureId, { autoStream: true });
  await setStatus(r.fixtureId, "in_play");
  return { r, phone };
}

// ---------------------------------------------------------------------------------------------------------------------
describe("autoStartRefusalOf — the mapper from startBroadcast's refusals to the column's codes (pure)", () => {
  const rows: [string, unknown, AutoStartRefusal | "already_running"][] = [
    ["plan_lacks_overlay", new PaymentRequiredError("streaming.overlay"), "not_entitled"],
    ["plan_lacks_relay", new PaymentRequiredError("streaming.relay"), "not_entitled"],
    ["overlay_required", new HttpError(409, "x", "overlay_required"), "not_entitled"],
    ["no_credits", new HttpError(402, "x", "no_credits", { featureKey: "streaming.relay" }), "no_credit"],
    ["target_in_use keeps the spec's own word", new HttpError(409, "x", "target_in_use", { holder: null }), "destination_in_use"],
    ["DESTINATION_NOT_ALLOWED", new HttpError(422, "x", DESTINATION_NOT_ALLOWED), "no_destination"],
    ["TARGET_UNREADABLE", new HttpError(422, "x", TARGET_UNREADABLE), "no_destination"],
    ["the code-less 404 stream target not found", new HttpError(404, "stream target not found"), "no_destination"],
    ["storage_exhausted", new HttpError(503, "x", "storage_exhausted", { headroomMinutes: 0 }), "unavailable"],
    ["ingest_unavailable", new HttpError(503, "x", "ingest_unavailable"), "unavailable"],
    ["active_session is not a refusal", new HttpError(409, "x", "active_session", { sessionId: randomUUID() }), "already_running"],
  ];
  it.each(rows)("%s", (_name, err, want) => {
    expect(autoStartRefusalOf(err)).toBe(want);
  });

  it("every code the column admits is reachable from some startBroadcast refusal (5 of AUTO_START_REFUSALS), and nothing else is stored", () => {
    const reached = new Set(rows.map(([, err]) => autoStartRefusalOf(err)).filter((x) => x !== "already_running"));
    expect([...reached].sort()).toEqual([...AUTO_START_REFUSALS].sort());
    expect(reached.size).toBe(5);
  });

  it("an assumption made a guard: neither W5 answer — phone_not_paired, nor phone_not_responding (owner ruling 2026-10-09) — can reach an auto start (it passes phone: \"present\") — each refused by name, never mapped", () => {
    let checked = 0;
    for (const code of ["phone_not_paired", "phone_not_responding"]) {
      expect(() => autoStartRefusalOf(new HttpError(409, "x", code)), code).toThrow(new RegExp(`answered ${code} to an automatic start`));
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("anything else is a bug: null (the caller rethrows it)", () => {
    let checked = 0;
    for (const err of [new Error("boom"), new HttpError(500, "x"), new HttpError(409, "x", "something_new"), new HttpError(404, "fixture not found"), "a string", null]) {
      expect(autoStartRefusalOf(err)).toBeNull();
      checked++;
    }
    expect(checked).toBe(6);
  });
});

describe("the tunable is read at the call site (AGENTS.md #20)", () => {
  // The walkthrough shortens these two through tunable(); a raw constant at a call site would silently ignore it.
  const SRC = resolve(import.meta.dirname, "..");
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  // The auto STOP call site (stream-sessions.ts) is guarded the same way in stream-auto-stop.test.ts.
  it.each([
    ["stream-auto.ts", "AUTO_START_RETRY_SECONDS"],
  ])("%s reads %s only through tunable(NAME, NAME)", (file, name) => {
    const code = strip(readFileSync(resolve(SRC, file), "utf8")).split("\n").filter((l) => !/^\s*(import|\}\s*from)\b/.test(l)).join("\n");
    const viaTunable = new RegExp(`tunable\\(\\s*"${name}"\\s*,\\s*${name}\\s*\\)`, "g");
    expect([...code.matchAll(viaTunable)].length, `${file} has a tunable("${name}", ${name}) call`).toBeGreaterThan(0);
    const rest = code.replace(viaTunable, "");
    expect(rest.match(new RegExp(`\\b${name}\\b`)), `${file} uses ${name} outside tunable()`).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe.skipIf(!HAS_DB)("automatic start — fires on the paired phone's beat (test 1)", () => {
  it("the FIRST beat after in_play starts ONE automatic session: start_cause, the domain's action row, the code's issuer as the actor, the columns stamped, and the beat is answered go-live startedBy automatic", async () => {
    const { r, phone } = await autoRig();
    expect(await autoSessionsOf(r.fixtureId), "PREMISE: nothing before the beat").toHaveLength(0);
    const before = await settingsOf(r.fixtureId);
    expect(before).toMatchObject({ auto_stream: true, auto_started_at: null, auto_start_attempted_at: null, target_chosen: false });
    const answer = await beat(r, phone);
    const sessions = await sessionsOf(r.fixtureId);
    expect(sessions).toHaveLength(1);
    const s = sessions[0]!;
    expect(s).toMatchObject({ start_cause: "automatic", pairing_id: await pairingIdOf(r, phone), target_id: r.target.id });
    expect(s.created_by, "attributed to the stream code's issuer (FP10)").toBe(await issuerOf(r.fixtureId));
    expect(await actionRow(s.id, "create")).toEqual([{ source: "domain", actor_user_id: s.created_by }]);
    const after = (await settingsOf(r.fixtureId))!;
    expect(after.auto_start_session_id).toBe(s.id);
    expect(after.auto_started_at?.getTime()).toBe(r.now().getTime());
    expect(after.auto_start_attempted_at?.getTime()).toBe(r.now().getTime());
    expect(after.auto_start_refusal).toBeNull();
    expect(answer).toMatchObject({ state: "go-live", sid: s.id, startedBy: "automatic", autoAllowed: true });
  });

  it("R-1: an automatic start never sets or clears target_chosen — a fixture with no pick keeps resolving the org default, a fixture with a pick keeps that pick", async () => {
    const none = await autoRig();
    await beat(none.r, none.phone);
    expect((await autoSessionsOf(none.r.fixtureId))).toHaveLength(1);
    expect(await settingsOf(none.r.fixtureId)).toMatchObject({ target_chosen: false, target_id: null });
    expect((await fixtureStreamTarget(sql, { orgId: none.r.auth.orgId, fixtureId: none.r.fixtureId }))?.id).toBe(none.r.target.id);

    const picked = await autoRig();
    await saveStreamSettings(picked.r.auth, picked.r.fixtureId, { targetId: picked.r.target.id });
    await beat(picked.r, picked.phone);
    expect((await autoSessionsOf(picked.r.fixtureId))).toHaveLength(1);
    expect(await settingsOf(picked.r.fixtureId)).toMatchObject({ target_chosen: true, target_id: picked.r.target.id });
  });

  it("another sport (cricket): the start fires identically — the predicate reads the fixture's status and no sport", async () => {
    const { r, phone } = await autoRig({ sport: "cricket" });
    const answer = await beat(r, phone);
    expect(await autoSessionsOf(r.fixtureId)).toHaveLength(1);
    expect(answer).toMatchObject({ state: "go-live", startedBy: "automatic" });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe.skipIf(!HAS_DB)("automatic start — the predicate through the use-case (test 2): each conjunct falsified alone", () => {
  type Ctx = { r: CaptureRig; phone: string };
  type Row = {
    conjunct: string;
    /** Falsifies the ONE conjunct (state or the beat's own mode). */
    falsify: (c: Ctx) => Promise<void>;
    over?: Partial<Beat>;
    /** Undoes it so the positive pair on the same rig can start. */
    restore: (c: Ctx) => Promise<void>;
  };
  const rows: Row[] = [
    { conjunct: "switch_on", falsify: ({ r }) => saveStreamSettings(r.auth, r.fixtureId, { autoStream: false }).then(() => undefined), restore: ({ r }) => saveStreamSettings(r.auth, r.fixtureId, { autoStream: true }).then(() => undefined) },
    { conjunct: "phone_automatic", falsify: async () => undefined, over: { mode: "operator" }, restore: async () => undefined },
    { conjunct: "in_play", falsify: ({ r }) => setStatus(r.fixtureId, "scheduled").then(() => undefined), restore: ({ r }) => setStatus(r.fixtureId, "in_play").then(() => undefined) },
    { conjunct: "in_play", falsify: ({ r }) => setStatus(r.fixtureId, "decided").then(() => undefined), restore: ({ r }) => setStatus(r.fixtureId, "in_play").then(() => undefined) },
    {
      conjunct: "no_open_session",
      falsify: async ({ r }) => { await createSession(r.auth, r.fixtureId, { mode: "passthrough", targetId: r.target.id }, r.deps); },
      restore: async ({ r }) => { await sql`update fixture_stream_sessions set state = 'completed', ended_at = now() where fixture_id = ${r.fixtureId}`; },
    },
    {
      conjunct: "not_yet_started",
      falsify: ({ r }) => sql`update fixture_stream_settings set auto_started_at = ${r.now()} where fixture_id = ${r.fixtureId}`.then(() => undefined),
      restore: ({ r }) => sql`update fixture_stream_settings set auto_started_at = null where fixture_id = ${r.fixtureId}`.then(() => undefined),
    },
    {
      conjunct: "not_blocked",
      falsify: ({ r }) => sql`update fixture_stream_settings set auto_start_blocked_at = ${r.now()} where fixture_id = ${r.fixtureId}`.then(() => undefined),
      restore: ({ r }) => sql`update fixture_stream_settings set auto_start_blocked_at = null where fixture_id = ${r.fixtureId}`.then(() => undefined),
    },
    {
      conjunct: "no_broadcast_ran",
      falsify: async ({ r }) => {
        const prior = await sessionOnTarget(r.auth.orgId, r.fixtureId, r.target.id, "completed");
        await sql`update fixture_stream_sessions set first_ingest_at = now() where id = ${prior}`;
      },
      restore: ({ r }) => sql`update fixture_stream_sessions set first_ingest_at = null where fixture_id = ${r.fixtureId}`.then(() => undefined),
    },
    {
      conjunct: "retry_spacing",
      // 59 s ago, derived from the declared spacing: one second short of it.
      falsify: ({ r }) => sql`update fixture_stream_settings set auto_start_attempted_at = ${new Date(r.now().getTime() - (AUTO_START_RETRY_SECONDS - 1) * SEC)} where fixture_id = ${r.fixtureId}`.then(() => undefined),
      restore: async ({ r }) => { r.tick(SEC); },   // exactly the spacing: due
    },
  ];

  it("each conjunct, falsified alone, starts nothing and claims nothing — and the same rig, with it undone, starts exactly one", async () => {
    let checked = 0;
    for (const row of rows) {
      const { r, phone } = await autoRig();
      const c = { r, phone };
      await row.falsify(c);
      const attemptedBefore = (await settingsOf(r.fixtureId))?.auto_start_attempted_at?.getTime() ?? null;
      const sessionsBefore = (await sessionsOf(r.fixtureId)).length;
      await beat(r, phone, row.over ?? {});
      expect(await autoSessionsOf(r.fixtureId), `${row.conjunct} falsified: no automatic session`).toHaveLength(0);
      expect((await sessionsOf(r.fixtureId)).length, `${row.conjunct}: nothing else started`).toBe(sessionsBefore);
      expect((await settingsOf(r.fixtureId))?.auto_start_attempted_at?.getTime() ?? null, `${row.conjunct}: no claim was made`).toBe(attemptedBefore);
      await row.restore(c);
      await beat(r, phone);
      expect(await autoSessionsOf(r.fixtureId), `${row.conjunct} restored: the positive pair starts`).toHaveLength(1);
      checked++;
    }
    expect(checked).toBe(rows.length);
    expect(checked).toBe(9);
  });

  it("phone_present, falsified through the use-case's own read of the pairing (an arriving beat is always present, so the beat cannot show it): a now past the silence window starts nothing, the beat's own now starts one", async () => {
    const { r, phone } = await autoRig();
    const a = { orgId: r.auth.orgId, fixtureId: r.fixtureId, pairingId: await pairingIdOf(r, phone), phoneMode: "automatic" as const };
    const farLater = new Date(r.now().getTime() + 3_600_000);
    expect(await maybeAutoStart(a, r.deps, farLater)).toEqual({ fired: false, why: "not_due" });
    expect(await autoSessionsOf(r.fixtureId)).toHaveLength(0);
    expect((await settingsOf(r.fixtureId))!.auto_start_attempted_at).toBeNull();
    const ok = await maybeAutoStart(a, r.deps, r.now());
    expect(ok).toMatchObject({ fired: true });
    expect(await autoSessionsOf(r.fixtureId)).toHaveLength(1);
  });

  it("the table covers EVERY conjunct the predicate declares (9 of AUTO_START_CONJUNCTS: eight here, phone_present above)", () => {
    const declared = AUTO_START_CONJUNCTS.map((c) => c.name).sort();
    const covered = [...new Set([...rows.map((x) => x.conjunct), "phone_present"])].sort();
    expect(covered).toEqual(declared);
    expect(declared).toHaveLength(9);
  });

  it("the empty case: a fixture with NO settings row is not due, and the beat writes no row (the switch was never touched)", async () => {
    const r = await captureRig({ credits: 3, connectAfterMs: NEVER });
    const phone = phoneId("a");
    await beat(r, phone, { claim: "new" });
    await setStatus(r.fixtureId, "in_play");
    expect(await settingsOf(r.fixtureId), "PREMISE: no settings row").toBeNull();
    await beat(r, phone);
    expect(await autoSessionsOf(r.fixtureId)).toHaveLength(0);
    expect(await settingsOf(r.fixtureId)).toBeNull();
    const direct = await maybeAutoStart({ orgId: r.auth.orgId, fixtureId: r.fixtureId, pairingId: await pairingIdOf(r, phone), phoneMode: "automatic" }, r.deps, r.now());
    expect(direct).toEqual({ fired: false, why: "not_due" });
  });

  it("a pairing on ANOTHER fixture's code is never due: nothing read of it is trusted and nothing is started or written for either fixture", async () => {
    const mine = await autoRig();
    const theirs = await autoRig();
    const foreign = await pairingIdOf(theirs.r, theirs.phone);
    const res = await maybeAutoStart({ orgId: mine.r.auth.orgId, fixtureId: mine.r.fixtureId, pairingId: foreign, phoneMode: "automatic" }, mine.r.deps, mine.r.now());
    expect(res).toEqual({ fired: false, why: "not_due" });
    expect(await sessionsOf(mine.r.fixtureId)).toHaveLength(0);
    expect(await sessionsOf(theirs.r.fixtureId)).toHaveLength(0);
    expect((await settingsOf(mine.r.fixtureId))!.auto_start_attempted_at).toBeNull();
  });

  it("a beat from a phone that is NOT the slot's current one starts nothing and reports nothing (it is answered replaced)", async () => {
    const { r } = await autoRig();
    const intruder = phoneId("b");
    const answer = await beat(r, intruder, { mode: "automatic" });
    expect(answer.state).toBe("replaced");
    expect(await sessionsOf(r.fixtureId)).toHaveLength(0);
    expect(sentry.captureError, "no error: the step is skipped, not failed").not.toHaveBeenCalled();
    expect((await settingsOf(r.fixtureId))!.auto_start_attempted_at).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe.skipIf(!HAS_DB)("automatic start — once per match, never after an organiser Stop (test 3, A12, A16)", () => {
  it("a second and a third beat after the start create nothing and move nothing", async () => {
    const { r, phone } = await autoRig();
    await beat(r, phone);
    const first = (await settingsOf(r.fixtureId))!;
    expect(first.auto_started_at).not.toBeNull();
    r.tick(5 * SEC);
    await beat(r, phone);
    r.tick(5 * SEC);
    await beat(r, phone);
    expect(await sessionsOf(r.fixtureId)).toHaveLength(1);
    const later = (await settingsOf(r.fixtureId))!;
    expect(later.auto_started_at?.getTime()).toBe(first.auto_started_at!.getTime());
    expect(later.auto_start_attempted_at?.getTime()).toBe(first.auto_start_attempted_at!.getTime());
  });

  it("A12 through the REAL stopSession: an organiser's Stop of a broadcast she started by hand stamps the block, and the next beat starts nothing — while the SAME rig ended by a non-organiser path (the control) does start", async () => {
    // The stamp is isolated from `auto_started_at` (which also blocks): the session here was started by the ORGANISER.
    const blocked = await autoRig();
    const sid = await blocked.r.start(blocked.phone);
    await beat(blocked.r, blocked.phone);   // the open session: nothing to start
    expect(await autoSessionsOf(blocked.r.fixtureId)).toHaveLength(0);
    await stopSession(blocked.r.auth, blocked.r.fixtureId, sid, blocked.r.deps);
    const s = (await sessionsOf(blocked.r.fixtureId)).find((x) => x.id === sid)!;
    expect(["ending", "completed"], s.state).toContain(s.state);
    expect((await settingsOf(blocked.r.fixtureId))!.auto_start_blocked_at?.getTime(), "the Stop's stamp").toBe(blocked.r.now().getTime());
    await sql`update fixture_stream_sessions set state = 'completed', ended_at = coalesce(ended_at, now()) where id = ${sid}`;
    await beat(blocked.r, blocked.phone);
    expect(await autoSessionsOf(blocked.r.fixtureId), "a Stop turns auto start off for the match").toHaveLength(0);
    // Manual Go live is ALWAYS allowed.
    const again = await createSession(blocked.r.auth, blocked.r.fixtureId, { mode: "passthrough", targetId: blocked.r.target.id }, blocked.r.deps);
    expect((await sessionsOf(blocked.r.fixtureId)).find((x) => x.id === again.sessionId)).toMatchObject({ start_cause: "organiser" });

    const control = await autoRig();
    const sid2 = await control.r.start(control.phone);
    await endBySweep(control.r, sid2);
    await beat(control.r, control.phone);
    expect(await autoSessionsOf(control.r.fixtureId), "the control: without the Stop's stamp the start fires").toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe.skipIf(!HAS_DB)("automatic start — a late pairing (test 4, A16)", () => {
  it("the match already in play and the phone pairs AFTER: its first beat — the claim itself — starts the broadcast", async () => {
    const r = await captureRig({ credits: 3, connectAfterMs: NEVER });
    await saveStreamSettings(r.auth, r.fixtureId, { autoStream: true });
    await setStatus(r.fixtureId, "in_play");
    const phone = phoneId("late");
    const answer = await beat(r, phone, { claim: "new" });
    expect(await autoSessionsOf(r.fixtureId)).toHaveLength(1);
    expect(answer).toMatchObject({ state: "go-live", startedBy: "automatic" });
  });

  it("…but a broadcast that already received ingest means the match has had its start: the late pairing starts nothing (anySessionHadIngest), and the same pairing with no such session does", async () => {
    const withIngest = await captureRig({ credits: 3, connectAfterMs: NEVER });
    await saveStreamSettings(withIngest.auth, withIngest.fixtureId, { autoStream: true });
    await setStatus(withIngest.fixtureId, "in_play");
    const prior = await sessionOnTarget(withIngest.auth.orgId, withIngest.fixtureId, withIngest.target.id, "completed");
    await sql`update fixture_stream_sessions set first_ingest_at = now() where id = ${prior}`;
    await beat(withIngest, phoneId("late"), { claim: "new" });
    expect(await autoSessionsOf(withIngest.fixtureId)).toHaveLength(0);

    const none = await captureRig({ credits: 3, connectAfterMs: NEVER });
    await saveStreamSettings(none.auth, none.fixtureId, { autoStream: true });
    await setStatus(none.fixtureId, "in_play");
    const ended = await sessionOnTarget(none.auth.orgId, none.fixtureId, none.target.id, "completed");   // ran, but never received ingest
    expect((await sessionsOf(none.fixtureId)).find((x) => x.id === ended)!.first_ingest_at).toBeNull();
    await beat(none, phoneId("late"), { claim: "new" });
    expect(await autoSessionsOf(none.fixtureId)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe.skipIf(!HAS_DB)("automatic start — a refusal stores its code and never the start (test 5)", () => {
  const scenarios: Record<AutoStartRefusal, { credits?: number; arrange: (r: CaptureRig) => Promise<void> }> = {
    no_credit: { credits: 0, arrange: async (r) => { await spendMonthlyStreamGrant(r.auth.orgId); } },
    not_entitled: { arrange: async (r) => { await override(r.auth.orgId, "streaming.relay", false); } },
    no_destination: { arrange: async (r) => { await sql`update org_stream_targets set archived_at = now() where id = ${r.target.id}`; } },
    destination_in_use: {
      arrange: async (r) => {
        const other = (await startedDivisionWithFixture(r.auth)).fixtureId;
        await pairPresentPhone(other, { at: r.now() });
        await createSession(r.auth, other, { mode: "passthrough", targetId: r.target.id }, r.deps);
      },
    },
    unavailable: { arrange: async (r) => { r.ingest.storage = { totalStorageMinutes: 1000, totalStorageMinutesLimit: 1000, videoCount: 0 }; } },
  };

  it("each code AUTO_START_REFUSALS declares: attempted_at stamped, auto_start_refusal = the code, auto_started_at stays NULL, no session row for this fixture, and the beat still answers", async () => {
    let reached = 0;
    for (const code of AUTO_START_REFUSALS) {
      const sc = scenarios[code];
      const { r, phone } = await autoRig({ credits: sc.credits ?? 3 });
      await sc.arrange(r);
      const answer = await beat(r, phone);
      const s = (await settingsOf(r.fixtureId))!;
      expect(s.auto_start_refusal, code).toBe(code);
      expect(s.auto_start_attempted_at?.getTime(), `${code}: the attempt is stamped`).toBe(r.now().getTime());
      expect(s.auto_started_at, `${code}: a refusal never stamps auto_started_at`).toBeNull();
      expect(s.auto_start_session_id).toBeNull();
      expect(await autoSessionsOf(r.fixtureId), code).toHaveLength(0);
      expect((await sessionsOf(r.fixtureId)), `${code}: no row for this fixture`).toHaveLength(0);
      expect(answer.state, `${code}: the beat is still answered`).toBe("waiting");
      reached++;
    }
    expect(reached).toBe(AUTO_START_REFUSALS.length);
    expect(reached).toBe(5);
  });
});

describe.skipIf(!HAS_DB)("automatic start — retry spacing, then success clears the refusal (test 6)", () => {
  it("a no_credit refusal is not retried 59 s later (zero extra attempts: attempted_at unchanged, no provider read); at 60 s after the credit is granted it starts, clears the refusal and stamps started_at", async () => {
    const { r, phone } = await autoRig({ credits: 0 });
    await spendMonthlyStreamGrant(r.auth.orgId);
    const reads = vi.spyOn(r.ingest, "storageUsage");
    await beat(r, phone);
    const t0 = r.now().getTime();
    expect(await settingsOf(r.fixtureId)).toMatchObject({ auto_start_refusal: "no_credit", auto_started_at: null });
    expect(reads.mock.calls.length, "PREMISE: an attempt reaches the storage read").toBe(1);

    r.tick((AUTO_START_RETRY_SECONDS - 1) * SEC);
    await beat(r, phone);
    const mid = (await settingsOf(r.fixtureId))!;
    expect(mid.auto_start_attempted_at?.getTime(), "no second attempt").toBe(t0);
    expect(mid.auto_start_refusal).toBe("no_credit");
    expect(reads.mock.calls.length).toBe(1);

    await grantCredits({ orgId: r.auth.orgId, delta: 1, createdBy: await rigUser(), note: "retry", idempotencyKey: randomUUID() });
    r.tick(SEC);   // exactly AUTO_START_RETRY_SECONDS after the attempt
    expect(r.now().getTime() - t0).toBe(AUTO_START_RETRY_SECONDS * SEC);
    await beat(r, phone);
    const done = (await settingsOf(r.fixtureId))!;
    expect(done.auto_start_refusal, "success clears the refusal").toBeNull();
    expect(done.auto_started_at?.getTime()).toBe(r.now().getTime());
    expect(await autoSessionsOf(r.fixtureId)).toHaveLength(1);
  });

  it("the override is honoured at the call site: with the walkthrough's shortened spacing the retry fires at that spacing, not 60 s (ENV_NAME=ci)", async () => {
    vi.stubEnv("ENV_NAME", "ci");
    vi.stubEnv("AUTO_START_RETRY_SECONDS", "5");
    try {
      const { r, phone } = await autoRig({ credits: 0 });
      await spendMonthlyStreamGrant(r.auth.orgId);
      await beat(r, phone);
      expect((await settingsOf(r.fixtureId))!.auto_start_refusal).toBe("no_credit");
      await grantCredits({ orgId: r.auth.orgId, delta: 1, createdBy: await rigUser(), note: "retry", idempotencyKey: randomUUID() });
      r.tick(4 * SEC);
      await beat(r, phone);
      expect(await autoSessionsOf(r.fixtureId), "4 s: still inside the shortened spacing").toHaveLength(0);
      r.tick(SEC);
      await beat(r, phone);
      expect(await autoSessionsOf(r.fixtureId), "5 s: due").toHaveLength(1);
      expect(5, "the override is shorter than the declared spacing").toBeLessThan(AUTO_START_RETRY_SECONDS);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe.skipIf(!HAS_DB)("automatic start — races (test 7, Review Focus 3)", () => {
  it("two postBeat calls started together create exactly one session and one claim", async () => {
    const { r, phone } = await autoRig();
    await Promise.all([beat(r, phone), beat(r, phone)]);
    expect(await autoSessionsOf(r.fixtureId)).toHaveLength(1);
    expect(await sessionsOf(r.fixtureId)).toHaveLength(1);
  });

  it("the claim is what makes it atomic: two starters parked on the settings row both pass the predicate, and exactly ONE fires — the other is claim_lost (without the claim both would reach startBroadcast and the loser would be already_running)", async () => {
    const { r, phone } = await autoRig();
    const a = { orgId: r.auth.orgId, fixtureId: r.fixtureId, pairingId: await pairingIdOf(r, phone), phoneMode: "automatic" as const };
    const results = await parked(
      (tx) => tx`select 1 from fixture_stream_settings where fixture_id = ${r.fixtureId} for update`,
      () => [maybeAutoStart(a, r.deps, r.now()), maybeAutoStart(a, r.deps, r.now())], CLAIM_WAITER,
      async () => undefined,
    );
    expect(results.filter((x) => x.fired).length, JSON.stringify(results)).toBe(1);
    expect(results.filter((x) => !x.fired && x.why === "claim_lost").length, JSON.stringify(results)).toBe(1);
    expect(await autoSessionsOf(r.fixtureId)).toHaveLength(1);
  });

  it("the claim re-checks, atomically, what the facts read saw: a switch-off, a start, a Stop's block or another beat's attempt that lands AFTER the read and BEFORE the claim loses the claim — and a harmless write in the same window does not (4 conditions + the control)", async () => {
    const changes: [string, (tx: Tx, fx: string, now: Date) => Promise<unknown>, "lost" | "fires"][] = [
      ["auto_stream turned off", (tx, fx) => tx`update fixture_stream_settings set auto_stream = false where fixture_id = ${fx}`, "lost"],
      ["auto_started_at stamped", (tx, fx, now) => tx`update fixture_stream_settings set auto_started_at = ${now} where fixture_id = ${fx}`, "lost"],
      ["auto_start_blocked_at stamped (an organiser Stop)", (tx, fx, now) => tx`update fixture_stream_settings set auto_start_blocked_at = ${now} where fixture_id = ${fx}`, "lost"],
      ["auto_start_attempted_at stamped (another beat's claim)", (tx, fx, now) => tx`update fixture_stream_settings set auto_start_attempted_at = ${now} where fixture_id = ${fx}`, "lost"],
      ["control: an unrelated column", (tx, fx) => tx`update fixture_stream_settings set updated_at = now() where fixture_id = ${fx}`, "fires"],
    ];
    let checked = 0;
    for (const [name, change, want] of changes) {
      const { r, phone } = await autoRig();
      const a = { orgId: r.auth.orgId, fixtureId: r.fixtureId, pairingId: await pairingIdOf(r, phone), phoneMode: "automatic" as const };
      const [result] = await parked(
        (tx) => tx`select 1 from fixture_stream_settings where fixture_id = ${r.fixtureId} for update`,
        () => [maybeAutoStart(a, r.deps, r.now())], CLAIM_WAITER,
        async (tx) => { await change(tx, r.fixtureId, r.now()); },
      );
      if (want === "lost") {
        expect(result, name).toEqual({ fired: false, why: "claim_lost" });
        expect(await autoSessionsOf(r.fixtureId), name).toHaveLength(0);
      } else {
        expect(result, name).toMatchObject({ fired: true });
        expect(await autoSessionsOf(r.fixtureId), name).toHaveLength(1);
      }
      checked++;
    }
    expect(checked).toBe(changes.length);
  });

  it("an organiser's Go live that lands between the beat's predicate and its admission leaves ONE open session — the auto start's active_session is already_running, never a refusal", async () => {
    const { r, phone } = await autoRig();
    const real = r.ingest.storageUsage.bind(r.ingest);
    let raced = false;
    vi.spyOn(r.ingest, "storageUsage").mockImplementation(async () => {
      if (!raced) {
        raced = true;
        await createSession(r.auth, r.fixtureId, { mode: "passthrough", targetId: r.target.id }, r.deps);
      }
      return real();
    });
    const answer = await beat(r, phone);
    expect(raced, "PREMISE: the organiser's start landed inside the auto start").toBe(true);
    const sessions = await sessionsOf(r.fixtureId);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ start_cause: "organiser" });
    expect(await settingsOf(r.fixtureId)).toMatchObject({ auto_start_refusal: null, auto_started_at: null, auto_start_session_id: null });
    expect(answer).toMatchObject({ state: "go-live", startedBy: "organiser" });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe.skipIf(!HAS_DB)("automatic start — beats that must not start one (test 8, FP10) — each guard alone", () => {
  it("the operator's `ended` beat with nothing to stop starts nothing (the `ended` guard alone: no stop is decided here); the next ordinary beat does", async () => {
    const { r, phone } = await autoRig();
    await beat(r, phone, { state: "ended", endReason: "operator-stopped" });
    expect(await autoSessionsOf(r.fixtureId)).toHaveLength(0);
    expect((await settingsOf(r.fixtureId))!.auto_start_attempted_at, "no claim either").toBeNull();
    await beat(r, phone);
    expect(await autoSessionsOf(r.fixtureId)).toHaveLength(1);
  });

  it("a beat that STOPS a session (`stopped: X`, state paired — not `ended`) starts nothing: the stop-decided guard alone; once it has stopped, the next beat does start (the broadcast never ran)", async () => {
    const { r, phone } = await autoRig();
    const x = await r.start(phone);   // an organiser broadcast, never connected
    const answer = await beat(r, phone, { stopped: x });
    expect(answer).toMatchObject({ state: "over", sid: x });
    expect((await sessionsOf(r.fixtureId)).find((s) => s.id === x)!.end_reason).toBe("operator_stopped");
    expect(await autoSessionsOf(r.fixtureId), "the stopping beat started nothing").toHaveLength(0);
    await beat(r, phone);
    expect(await autoSessionsOf(r.fixtureId), "the next beat is an ordinary one").toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe.skipIf(!HAS_DB)("automatic start — the actor (test 9, FP10/C-2)", () => {
  it("a beat from the holder on a REISSUED code attributes the start to that pairing's own code issuer, not to the code the beat names", async () => {
    const { r, phone } = await autoRig();
    const code1Issuer = await issuerOf(r.fixtureId);
    const sid = await r.start(phone);   // an organiser broadcast on the phone's pairing (on code 1); it never connects
    const second = { ...r.auth, userId: await rigUser() };
    const fresh = await reissueStreamCode(second, r.fixtureId);
    expect(await issuerOf(r.fixtureId), "PREMISE: the new code has another issuer").toBe(second.userId);
    expect(second.userId).not.toBe(code1Issuer);
    // The warming window passes with no ingest; the holder's next beat — on the NEW code's URL, naming its sid — ticks
    // the session out (warming timeout) and the auto start is due within that same beat.
    r.tick((WARMING_TIMEOUT_MINUTES + 1) * 60 * SEC);
    await beat(r, phone, { sid, state: "armed" }, { code: fresh.qr.code, tok: fresh.qr.tok });
    const old = (await sessionsOf(r.fixtureId)).find((s) => s.id === sid)!;
    expect(["failed", "completed", "ending"], `PREMISE: the beat's tick closed the organiser's session (${old.state})`).toContain(old.state);
    const auto = await autoSessionsOf(r.fixtureId);
    expect(auto, "the start fired on the holder's beat").toHaveLength(1);
    expect(auto[0]!.created_by).toBe(code1Issuer);
    expect(auto[0]!.created_by).not.toBe(second.userId);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe.skipIf(!HAS_DB)("automatic start — isolation and the mode flip (tests 10, 11)", () => {
  it("startBroadcast throwing something unmapped: the beat still answers, the error is reported, attempted_at is stamped (retry in 60 s), nothing else is written", async () => {
    const { r, phone } = await autoRig();
    vi.spyOn(r.ingest, "storageUsage").mockRejectedValueOnce(new Error("provider exploded"));
    const answer = await beat(r, phone);
    expect(answer.state).toBe("waiting");
    expect(sentry.captureError).toHaveBeenCalledTimes(1);
    expect(sentry.captureError.mock.calls[0]![1]).toMatchObject({ route: "capture.beat.auto_start", orgId: r.auth.orgId });
    expect(await settingsOf(r.fixtureId)).toMatchObject({ auto_start_attempted_at: r.now(), auto_start_refusal: null, auto_started_at: null });
    expect(await sessionsOf(r.fixtureId)).toHaveLength(0);
    r.tick(AUTO_START_RETRY_SECONDS * SEC);
    await beat(r, phone);
    expect(await autoSessionsOf(r.fixtureId), "the retry at the declared spacing starts").toHaveLength(1);
  });

  // B4 fix round (controller ruling 3): the stored code belongs to the attempt that wrote it. An attempt that ends WITHOUT a
  // refusal (an unmapped error, or an organiser's start that won the race) must not leave the earlier attempt's code beside its own
  // newer `auto_start_attempted_at` — the organiser read would pair a stale code with a fresh time. Cleared where the attempt
  // ends, never in the claim itself (that would blank the strip while every retry is still in flight).
  it("an attempt that ends with NO refusal clears the earlier attempt's code — an unmapped error and an already_running alike — and the organiser read serves no stale code for it", async () => {
    let checked = 0;
    for (const how of ["unmapped error", "already_running"] as const) {
      const { r, phone } = await autoRig({ credits: 0 });
      await spendMonthlyStreamGrant(r.auth.orgId);
      await beat(r, phone);
      expect((await settingsOf(r.fixtureId))!.auto_start_refusal, `${how}: PREMISE — the first attempt stored no_credit`).toBe("no_credit");
      expect((await streamPhone(r.auth, r.fixtureId, { now: r.now })).auto, `${how}: PREMISE — the read serves it`).toMatchObject({ refusal: "no_credit" });
      await grantCredits({ orgId: r.auth.orgId, delta: 1, createdBy: await rigUser(), note: "retry", idempotencyKey: randomUUID() });
      r.tick(AUTO_START_RETRY_SECONDS * SEC);
      if (how === "unmapped error") {
        vi.spyOn(r.ingest, "storageUsage").mockRejectedValueOnce(new Error("provider exploded"));
      } else {
        const real = r.ingest.storageUsage.bind(r.ingest);
        let raced = false;
        vi.spyOn(r.ingest, "storageUsage").mockImplementation(async () => {
          if (!raced) {
            raced = true;
            await createSession(r.auth, r.fixtureId, { mode: "passthrough", targetId: r.target.id }, r.deps);
          }
          return real();
        });
      }
      await beat(r, phone);
      const after = (await settingsOf(r.fixtureId))!;
      expect(after.auto_start_attempted_at?.getTime(), `${how}: the attempt is stamped`).toBe(r.now().getTime());
      expect(after.auto_start_refusal, `${how}: the earlier attempt's code is cleared`).toBeNull();
      expect(after.auto_started_at, `${how}: and nothing was started by it`).toBeNull();
      const read = (await streamPhone(r.auth, r.fixtureId, { now: r.now })).auto!;
      expect(read.refusal, `${how}: the read pairs no stale code with the newer attempt`).toBeNull();
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("FP13: a beat that flips mode to operator stops auto start at once (it reads the arriving beat); flipping back starts on that beat", async () => {
    const { r, phone } = await autoRig();
    await setStatus(r.fixtureId, "scheduled");
    await beat(r, phone);   // stored mode: automatic
    await setStatus(r.fixtureId, "in_play");
    await beat(r, phone, { mode: "operator" });
    expect(await autoSessionsOf(r.fixtureId)).toHaveLength(0);
    await beat(r, phone, { mode: "automatic" });
    expect(await autoSessionsOf(r.fixtureId)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe.skipIf(!HAS_DB)("the organiser-Stop stamp (test 12, R-3, FP9, FP12) — through the REAL stopSession", () => {
  /** A broadcast started with NO settings row (the phone's own start reads the default and writes none). */
  async function phoneStarted() {
    const r = await captureRig({ credits: 3, connectAfterMs: NEVER });
    const phone = phoneId("a");
    await beat(r, phone, { claim: "new", mode: "operator" });
    const { sid } = await postStart(r.code, r.tok, { phone }, r.deps, r.now());
    expect(await settingsOf(r.fixtureId), "PREMISE: no settings row").toBeNull();
    return { r, phone, sid };
  }

  it("a Stop of a running session stamps auto_start_blocked_at and CREATES the row when none existed — the fixture still resolves the org default destination (FP1)", async () => {
    const { r, sid } = await phoneStarted();
    await stopSession(r.auth, r.fixtureId, sid, r.deps);
    const s = (await settingsOf(r.fixtureId))!;
    expect(s.auto_start_blocked_at?.getTime()).toBe(r.now().getTime());
    expect(s).toMatchObject({ auto_stream: false, target_chosen: false, target_id: null });
    expect((await fixtureStreamTarget(sql, { orgId: r.auth.orgId, fixtureId: r.fixtureId }))?.id).toBe(r.target.id);
  });

  it("each exit of stopSession and each path that is NOT an organiser's Stop: the non-terminal exits stamp, the others stamp nothing (6 rows)", async () => {
    const results: Record<string, boolean> = {};
    const stamped = async (fx: string) => (await settingsOf(fx))?.auto_start_blocked_at != null;

    // (a) the ordinary running stop — covered above; here the second tap on an `ending` one, then relay_disabled.
    {
      const { r, sid } = await phoneStarted();
      await sql`update fixture_stream_sessions set state = 'ending', end_reason = 'phone_lost', ending_at = now(), desired_state = 'ending' where id = ${sid}`;
      await stopSession(r.auth, r.fixtureId, sid, r.deps);
      results.ending_repeat = await stamped(r.fixtureId);
    }
    {
      const { r, sid } = await phoneStarted();
      const off = { ...r.deps, drivers: { ...r.deps.drivers, disabled: true as const } };
      await stopSession(r.auth, r.fixtureId, sid, off);
      expect((await sessionsOf(r.fixtureId)).find((s) => s.id === sid)!.state, "PREMISE: relay_disabled ended it").toBe("failed");
      results.relay_disabled = await stamped(r.fixtureId);
    }
    // A terminal session: a repeated tap is idempotent and records nothing.
    {
      const { r, sid } = await phoneStarted();
      await endBySweep(r, sid);
      await stopSession(r.auth, r.fixtureId, sid, r.deps);
      results.terminal = await stamped(r.fixtureId);
    }
    // 409 not_active: the fixture has since started another session.
    {
      const { r, phone, sid } = await phoneStarted();
      await endBySweep(r, sid);
      await beat(r, phone);
      await postStart(r.code, r.tok, { phone }, r.deps, r.now());
      await expect(stopSession(r.auth, r.fixtureId, sid, r.deps)).rejects.toMatchObject({ status: 409, code: "not_active" });
      results.not_active = await stamped(r.fixtureId);
    }
    // A tick's phone_lost end is the system's decision, not the organiser's.
    {
      const { r, sid } = await phoneStarted();
      r.tick((Math.max(60, 60 + 30) + 1) * SEC);
      await tickSession(sid, r.deps, "sweep");
      expect((await sessionsOf(r.fixtureId)).find((s) => s.id === sid)!.end_reason, "PREMISE: the tick ended it").toBe("phone_lost");
      results.tick_phone_lost = await stamped(r.fixtureId);
    }
    // A stop the PHONE decided (`stopped: X`) is not an organiser's.
    {
      const { r, phone, sid } = await phoneStarted();
      await beat(r, phone, { stopped: sid });
      expect((await sessionsOf(r.fixtureId)).find((s) => s.id === sid)!.end_reason).toBe("operator_stopped");
      results.phone_stopped = await stamped(r.fixtureId);
    }
    expect(results).toEqual({
      ending_repeat: true, relay_disabled: true, terminal: false, not_active: false, tick_phone_lost: false, phone_stopped: false,
    });
    expect(Object.keys(results)).toHaveLength(6);
  });

  it("a session that finished between stopSession's read and its lock is not an organiser's Stop — nothing is stamped (the LOCKED row decides, on the apply path and on the repeated-tap path)", async () => {
    let checked = 0;
    for (const via of ["apply", "ending"] as const) {
      const { r, sid } = await phoneStarted();
      if (via === "ending") {
        await sql`update fixture_stream_sessions set state = 'ending', end_reason = 'phone_lost', ending_at = now(), desired_state = 'ending' where id = ${sid}`;
      }
      const [out] = await parked(
        (tx) => tx`select 1 from fixture_stream_sessions where id = ${sid} for update`,
        () => [stopSession(r.auth, r.fixtureId, sid, r.deps).then(() => "answered" as const)], SESSION_LOCK_WAITER,
        async (tx) => {
          await tx`update fixture_stream_sessions set state = 'completed', end_reason = ${via === "ending" ? "phone_lost" : null}, ended_at = now() where id = ${sid}`;
        },
      );
      expect(out, via).toBe("answered");
      expect(await settingsOf(r.fixtureId), `${via}: a finished session's tap is not a Stop`).toBeNull();
      expect((await sessionsOf(r.fixtureId)).find((x) => x.id === sid)!.state).toBe("completed");
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("the stamp commits or rolls back WITH the stop: a stop the database refuses leaves no stamp and an open session; the same Stop then succeeds and stamps", async () => {
    const { r, sid } = await phoneStarted();
    const fn = `rig_refuse_end_${randomBytes(4).toString("hex")}`;
    await sql.unsafe(`create function ${fn}() returns trigger language plpgsql as $$ begin raise exception 'rig: the stop is refused'; end $$`);
    await sql.unsafe(`create trigger ${fn} before update on fixture_stream_sessions for each row
                        when (new.fixture_id = '${r.fixtureId}' and new.state = 'ending') execute function ${fn}()`);
    try {
      await expect(stopSession(r.auth, r.fixtureId, sid, r.deps)).rejects.toThrow(/the stop is refused/);
      expect(await settingsOf(r.fixtureId), "no stamp survives a refused stop").toBeNull();
      expect((await sessionsOf(r.fixtureId)).find((s) => s.id === sid)!.state, "still open").not.toMatch(/ending|completed|failed/);
    } finally {
      await sql.unsafe(`drop trigger if exists ${fn} on fixture_stream_sessions`);
      await sql.unsafe(`drop function if exists ${fn}()`);
    }
    await stopSession(r.auth, r.fixtureId, sid, r.deps);
    expect((await settingsOf(r.fixtureId))!.auto_start_blocked_at).not.toBeNull();
  });

  it("a stamp that FAILS is reported and the Stop proceeds (a live broadcast must stop); with the cause gone the next Stop stamps", async () => {
    const { r, phone, sid } = await phoneStarted();
    const fn = `rig_refuse_stamp_${randomBytes(4).toString("hex")}`;
    await sql.unsafe(`create function ${fn}() returns trigger language plpgsql as $$ begin raise exception 'rig: the stamp is refused'; end $$`);
    await sql.unsafe(`create trigger ${fn} before insert or update on fixture_stream_settings for each row
                        when (new.fixture_id = '${r.fixtureId}' and new.auto_start_blocked_at is not null) execute function ${fn}()`);
    try {
      await stopSession(r.auth, r.fixtureId, sid, r.deps);
      const s = (await sessionsOf(r.fixtureId)).find((x) => x.id === sid)!;
      expect(["ending", "completed"], "the Stop went through").toContain(s.state);
      expect(s.end_reason).toBe("stopped");
      expect(await settingsOf(r.fixtureId)).toBeNull();
      expect(sentry.captureError).toHaveBeenCalledTimes(1);
      expect(sentry.captureError.mock.calls[0]![1]).toMatchObject({ orgId: r.auth.orgId });
    } finally {
      await sql.unsafe(`drop trigger if exists ${fn} on fixture_stream_settings`);
      await sql.unsafe(`drop function if exists ${fn}()`);
    }
    await sql`update fixture_stream_sessions set state = 'completed', ended_at = coalesce(ended_at, now()) where id = ${sid}`;
    await beat(r, phone);
    const sid2 = (await postStart(r.code, r.tok, { phone }, r.deps, r.now())).sid;
    await stopSession(r.auth, r.fixtureId, sid2, r.deps);
    expect((await settingsOf(r.fixtureId))!.auto_start_blocked_at).not.toBeNull();
  });
});

// A direct start with the guard the brief names: an automatic start rides the pairing's issuer (startBroadcast's own guard).
describe.skipIf(!HAS_DB)("startBroadcast refuses an automatic start attributed to anyone but the pairing's code issuer (the guard test 9 relies on)", () => {
  it("the issuer starts; another user is refused by name with nothing written", async () => {
    const { r, phone } = await autoRig();
    const pairingId = await pairingIdOf(r, phone);
    const other = await rigUser();
    await expect(startBroadcast({ userId: other, orgId: r.auth.orgId, source: "auto", pairingId }, r.fixtureId, { targetId: r.target.id, startCause: "automatic", phone: "present" }, r.deps))
      .rejects.toThrow(/attributed to its stream code's issuer/);
    expect(await sessionsOf(r.fixtureId)).toHaveLength(0);
    const issuer = await issuerOf(r.fixtureId);
    const ok = await startBroadcast({ userId: issuer, orgId: r.auth.orgId, source: "auto", pairingId }, r.fixtureId, { targetId: r.target.id, startCause: "automatic", phone: "present", autoStartedAt: r.now() }, r.deps);
    expect((await sessionsOf(r.fixtureId)).find((s) => s.id === ok.sessionId)).toMatchObject({ start_cause: "automatic", created_by: issuer });
  });
});

// Final review m-1: "once per match" rests on `auto_started_at`. It was stamped in a statement of its own AFTER
// startBroadcast's transaction committed, so a failure (or a dead process) between the two left an automatic session with
// no stamp, and once that session ended without video the next beat past the retry spacing started a SECOND one. The stamp
// now commits WITH the session row: neither exists without the other, in either direction.
describe.skipIf(!HAS_DB)("final review m-1 — the automatic start's stamp commits with its session, never apart", () => {
  it("a failure INSIDE the start transaction after the session insert (the stamp refused): no session row, no input, no stamp — and the retry after the spacing starts ONE session that carries the stamp", async () => {
    const { r, phone } = await autoRig();
    // Injected where the stamp is written: a constraint scoped to THIS fixture's settings row (no other suite is touched).
    const name = `stream_auto_m1_${r.fixtureId.replace(/-/g, "")}`;
    await sql.unsafe(`alter table fixture_stream_settings add constraint ${name} check (fixture_id <> '${r.fixtureId}' or auto_started_at is null) not valid`);
    let answer: Awaited<ReturnType<typeof beat>>;
    try {
      answer = await beat(r, phone);
    } finally {
      await sql.unsafe(`alter table fixture_stream_settings drop constraint ${name}`);
    }
    expect(sentry.captureError, "PREMISE: the injected failure was reached and reported").toHaveBeenCalledTimes(1);
    expect(String(sentry.captureError.mock.calls[0]![0]), "PREMISE: it is the injected one").toMatch(new RegExp(name));
    expect(await sessionsOf(r.fixtureId), "no session row survives a stamp that failed").toHaveLength(0);
    expect(answer.state, "so the beat answers waiting, never go-live on an unstamped session").toBe("waiting");
    expect((await sql<{ n: number }[]>`
      select count(*)::int as n from fixture_stream_inputs i join fixture_stream_sessions s on s.id = i.session_id
       where s.fixture_id = ${r.fixtureId}`)[0]!.n, "no input either").toBe(0);
    expect(await settingsOf(r.fixtureId)).toMatchObject({ auto_started_at: null, auto_start_session_id: null, auto_start_attempted_at: r.now() });
    // The positive pair on the SAME rig, the injection undone: the retry at the declared spacing starts, stamped with its own id.
    r.tick(AUTO_START_RETRY_SECONDS * SEC);
    await beat(r, phone);
    const auto = await autoSessionsOf(r.fixtureId);
    expect(auto, "the retry starts ONE session").toHaveLength(1);
    expect(await settingsOf(r.fixtureId)).toMatchObject({ auto_started_at: r.now(), auto_start_session_id: auto[0]!.id });
  });

  it("the reverse — a start whose provisioning fails deletes its session AND its stamp: no stamp outlives its session, the refusal is stored, and the retry after the spacing still starts (the stamp does not block it)", async () => {
    const { r, phone } = await autoRig();
    vi.spyOn(r.ingest, "createLiveInput").mockRejectedValueOnce(new Error("provider down"));
    const answer = await beat(r, phone);
    expect(answer.state, "the beat still answers").toBe("waiting");
    expect(r.ingest.createLiveInput, "PREMISE: provisioning was reached (the session row was written first)").toHaveBeenCalledTimes(1);
    expect(await sessionsOf(r.fixtureId), "the failed provisioning removed its session").toHaveLength(0);
    expect(await settingsOf(r.fixtureId)).toMatchObject({ auto_started_at: null, auto_start_session_id: null, auto_start_refusal: "unavailable" });
    r.tick(AUTO_START_RETRY_SECONDS * SEC);
    await beat(r, phone);
    const auto = await autoSessionsOf(r.fixtureId);
    expect(auto, "the retry starts ONE session").toHaveLength(1);
    expect(await settingsOf(r.fixtureId)).toMatchObject({ auto_started_at: r.now(), auto_start_session_id: auto[0]!.id, auto_start_refusal: null });
  });

  it("an assumption made a guard: an automatic start without its stamp instant, or a non-automatic start with one, is refused by name before anything is written", async () => {
    const { r, phone } = await autoRig();
    const pairingId = await pairingIdOf(r, phone);
    const issuer = await issuerOf(r.fixtureId);
    const cases: [string, Parameters<typeof startBroadcast>[0], Parameters<typeof startBroadcast>[2]][] = [
      ["auto, no instant", { userId: issuer, orgId: r.auth.orgId, source: "auto", pairingId }, { targetId: r.target.id, startCause: "automatic", phone: "present" }],
      ["phone, an instant", { userId: issuer, orgId: r.auth.orgId, source: "phone", pairingId }, { targetId: r.target.id, startCause: "operator", phone: "present", autoStartedAt: r.now() }],
    ];
    let checked = 0;
    for (const [label, actor, opts] of cases) {
      await expect(startBroadcast(actor, r.fixtureId, opts, r.deps), label).rejects.toThrow(/startBroadcast: .*auto_started_at/);
      checked++;
    }
    expect(checked).toBe(2);
    expect(await sessionsOf(r.fixtureId)).toHaveLength(0);
    expect((await settingsOf(r.fixtureId))!.auto_started_at).toBeNull();
  });
});

describe("anti-vacuity", () => {
  it("the file drove real answers", () => {
    if (!HAS_DB) return;
    expect(answersChecked).toBeGreaterThan(0);
  });
});
