// R2006 (owner ruling 2026-10-19, "Option C"): every start path streams the fixture's STORED mode — DB-backed, through
// the REAL settings writer (saveStreamSettings), the REAL claim and beat (postBeat), the phone's REAL start (postStart),
// the REAL automatic start (maybeAutoStart, fired by a beat) and the organiser's REAL Go live (createSession), all on
// FAKE drivers. "Composed available" is the deployment's own predicate (drivers.ts `composedUnavailable()`): RELAY_IMAGE
// set or unset, nothing mocked.
//
// Expected values come from the RULING, never from stream-codes.ts: "Score is the DEFAULT … 'Camera only' is a small
// secondary link … When composed is unavailable, Go live streams camera only … the organiser is never blocked."
//
// The sequence per path (TEST-STRATEGY: test the sequence): never chosen → Camera only → Add the score back, each a fresh
// fixture started once, plus the unavailable deployment with the score asked for. Two sports: the mode reads no sport.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { templatesForSport } from "@/components/overlay/template-registry";
import { sql, type Tx } from "@/lib/db";
import { CaptureBeat } from "@/server/api-v1/capture-schemas";
import type { CreateStreamSession, PutStreamSettings, StreamMode } from "@/server/api-v1/schemas";
import { RELAY_OVERLAY_DELAY_DEFAULT_MS } from "@/server/relay/config";
import { postBeat, postStart } from "../capture-phone";
import { markAutoStartBlocked, saveStreamSettings, startModeFor, streamPrefsOf, writeOverlayDelay, writeOverlayTemplate, writeStreamMode } from "../stream-codes";
import { createSession, currentSession, sessionFactsForJob } from "../stream-sessions";
import { captureRig, phoneId, type CaptureRig } from "./_capture-rig";
import { startedDivisionWithFixture } from "./_rig";

const sentry = vi.hoisted(() => ({ captureError: vi.fn() }));
vi.mock("@/lib/sentry", () => ({ captureError: sentry.captureError }));

const HAS_DB = !!process.env.DATABASE_URL;

const ENV_KEYS = ["RELAY_KEK", "AUTH_SECRET", "OAUTH_BASE_URL", "NEXT_PUBLIC_BASE_URL", "STREAM_PLAYBACK_HOST", "STREAM_SRT_ENABLED", "RELAY_DRIVERS", "RELAY_IMAGE"] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const KEK = randomBytes(32).toString("hex");
const IMAGE = "registry.fly.io/seazn-relay:start-mode-test";
function baseEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.RELAY_KEK = KEK;
  process.env.AUTH_SECRET = "stream-start-mode-test-secret";
}
beforeAll(baseEnv);
beforeEach(baseEnv);
afterAll(() => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

/** The deployment can (or cannot) run a composed session: the compositor image is configured, or not. */
const deployment = (composedAvailable: boolean) => {
  if (composedAvailable) process.env.RELAY_IMAGE = IMAGE;
  else delete process.env.RELAY_IMAGE;
};

function beatBody(r: CaptureRig, phone: string, over: Partial<CaptureBeat> = {}): CaptureBeat {
  return CaptureBeat.parse({
    code: r.code, slot: 0, phone, claim: null, device: null, sid: null, at: r.now().toISOString(), state: "paired",
    cause: null, notReady: null, startFailed: null, stopped: null, mode: "operator", transport: null, bitrateKbps: null,
    delivery: "unknown", deliveredLagS: null, audioOk: null, battery: null, thermal: null, dataUsedMB: null,
    appVersion: "stream-start-mode-test/1", ...over,
  });
}
const sessionsOf = (fx: string) => sql<{ id: string; mode: StreamMode; start_cause: string; theme_id: string | null; overlay_delay_ms: number }[]>`
  select id, mode, start_cause, theme_id, overlay_delay_ms from fixture_stream_sessions where fixture_id = ${fx} order by created_at, id`;

/** The organiser's preference writes, in order — each through the real PUT usecase. */
type Choice = { label: string; writes: PutStreamSettings[] };
const NEVER_CHOSEN: Choice = { label: "never chosen", writes: [] };
const CAMERA_ONLY: Choice = { label: "Camera only", writes: [{ streamMode: "passthrough" }] };
const SCORE_BACK: Choice = { label: "Camera only, then Add the score back", writes: [{ streamMode: "passthrough" }, { streamMode: "composed" }] };

/** The ruling's table: [the organiser's choice, the deployment can run composed, what the start streams]. */
const TABLE: [Choice, boolean, StreamMode][] = [
  [NEVER_CHOSEN, true, "composed"],
  [CAMERA_ONLY, true, "passthrough"],
  [SCORE_BACK, true, "composed"],
  [SCORE_BACK, false, "passthrough"],
  [NEVER_CHOSEN, false, "passthrough"],
];

async function chosen(r: CaptureRig, c: Choice): Promise<void> {
  for (const body of c.writes) await saveStreamSettings(r.auth, r.fixtureId, body);
}

/** The phone operator's own start (cause operator): the current phone with the rig's destination picked. */
async function phoneStart(sport: "generic" | "cricket", c: Choice): Promise<{ r: CaptureRig; sid: string }> {
  const r = await captureRig({ sport, credits: 3 });
  const A = phoneId("a");
  await postBeat(r.code, r.tok, beatBody(r, A, { claim: "new" }), r.deps, r.now());
  await saveStreamSettings(r.auth, r.fixtureId, { targetId: r.target.id });
  await chosen(r, c);
  const { sid } = await postStart(r.code, r.tok, { phone: A }, r.deps, r.now());
  return { r, sid };
}

/** The automatic start (cause automatic): the switch on, the match in play, and the automatic phone's next beat. */
async function autoStart(sport: "generic" | "cricket", c: Choice): Promise<{ r: CaptureRig; sid: string }> {
  const r = await captureRig({ sport, credits: 3, connectAfterMs: 10 * 60_000 });
  const A = phoneId("a");
  await postBeat(r.code, r.tok, beatBody(r, A, { claim: "new" }), r.deps, r.now());
  await saveStreamSettings(r.auth, r.fixtureId, { autoStream: true });
  await chosen(r, c);
  await sql`update fixtures set status = 'in_play' where id = ${r.fixtureId}`;
  await postBeat(r.code, r.tok, beatBody(r, A, { mode: "automatic" }), r.deps, r.now());
  const [s] = await sessionsOf(r.fixtureId);
  expect(s, "the automatic start fired").toBeDefined();
  return { r, sid: s!.id };
}

describe.skipIf(!HAS_DB)("R2006: the phone's own start and the automatic start stream the fixture's stored mode", () => {
  const paths: [string, typeof phoneStart, string][] = [
    ["the phone operator's start", phoneStart, "operator"],
    ["the automatic start", autoStart, "automatic"],
  ];
  let checked = 0;
  for (const [pathName, run, cause] of paths) {
    for (const [choice, available, want] of TABLE) {
      it(`${pathName}: ${choice.label} × composed ${available ? "available" : "unavailable"} → ${want}`, async () => {
        deployment(available);
        const { r, sid } = await run("generic", choice);
        const [s] = await sessionsOf(r.fixtureId);
        expect(s, "the start is never blocked").toMatchObject({ id: sid, mode: want, start_cause: cause });
        checked++;
      });
    }
  }
  it("another sport (cricket): the stored mode reads no sport — Camera only stays the camera, the default stays the score", async () => {
    deployment(true);
    const cam = await phoneStart("cricket", CAMERA_ONLY);
    expect((await sessionsOf(cam.r.fixtureId))[0]!.mode).toBe("passthrough");
    const def = await autoStart("cricket", NEVER_CHOSEN);
    expect((await sessionsOf(def.r.fixtureId))[0]!.mode).toBe("composed");
    checked += 2;
  });
  it("anti-vacuity: every row of the ruling's table ran on both paths", () => {
    expect(checked).toBe(paths.length * TABLE.length + 2);
  });
});

describe.skipIf(!HAS_DB)("R2006: startModeFor — the one stored-mode reader the two server-side paths share", () => {
  it("a fixture with NO settings row reads as never chosen: the score when available, the camera when not", async () => {
    const r = await captureRig();
    expect((await sql`select 1 from fixture_stream_settings where fixture_id = ${r.fixtureId}`).length, "PREMISE: no row").toBe(0);
    deployment(true);
    expect(await startModeFor(sql, r.fixtureId)).toBe("composed");
    deployment(false);
    expect(await startModeFor(sql, r.fixtureId)).toBe("passthrough");
  });
});

describe.skipIf(!HAS_DB)("R2006 PE2 at the usecase seam: the stored style and timing reach the composed Machine's overlayUrl", () => {
  it("a picked template and a 2.5 s override, then the organiser's composed Go live with NO themeId → the session copies both, and the job facts' overlayUrl carries template=bar and delay=2500", async () => {
    deployment(true);
    const r = await captureRig({ credits: 3, connectAfterMs: 10 * 60_000 });
    await saveStreamSettings(r.auth, r.fixtureId, { overlayTemplate: "bar", overlayDelayMs: 2500 });
    await r.pair(phoneId("a"));
    const { sessionId } = await createSession(r.auth, r.fixtureId, { mode: "composed", targetId: r.target.id }, r.deps);
    const [s] = await sessionsOf(r.fixtureId);
    expect(s).toMatchObject({ id: sessionId, mode: "composed", theme_id: "bar", overlay_delay_ms: 2500 });
    const facts = await sessionFactsForJob(sessionId, r.runner.created[0]!.jobToken, r.deps);
    const url = new URL(facts.overlayUrl!);
    expect(url.searchParams.get("template")).toBe("bar");
    expect(url.searchParams.getAll("delay")).toEqual(["2500"]);
  });

  it("a RESET timing (null) streams the server's default, and 0 streams 0 — the override is never read as 'unset'", async () => {
    deployment(true);
    let checked = 0;
    for (const [delay, want] of [[null, RELAY_OVERLAY_DELAY_DEFAULT_MS], [0, 0]] as const) {
      const r = await captureRig({ credits: 3, connectAfterMs: 10 * 60_000 });
      await saveStreamSettings(r.auth, r.fixtureId, { overlayDelayMs: 4000 });
      await saveStreamSettings(r.auth, r.fixtureId, { overlayDelayMs: delay });
      await r.pair(phoneId("a"));
      const { sessionId } = await createSession(r.auth, r.fixtureId, { mode: "composed", targetId: r.target.id }, r.deps);
      expect((await sessionsOf(r.fixtureId))[0]!.overlay_delay_ms, String(delay)).toBe(want);
      const facts = await sessionFactsForJob(sessionId, r.runner.created[0]!.jobToken, r.deps);
      expect(new URL(facts.overlayUrl!).searchParams.getAll("delay"), String(delay)).toEqual([String(want)]);
      checked++;
    }
    expect(checked).toBe(2);
  });
});

describe.skipIf(!HAS_DB)("PR #989 review m2: the organiser's Go live states the timing its panel showed, so it never races the timing's save", () => {
  it("the race: the stored timing is still 4 s (the 2.5 s save has not landed) and Go live names 2.5 s → the session streams 2.5 s; the save landing after moves the SETTINGS, never the running session", async () => {
    deployment(true);
    const r = await captureRig({ credits: 3, connectAfterMs: 10 * 60_000 });
    await saveStreamSettings(r.auth, r.fixtureId, { overlayDelayMs: 4000 });
    await r.pair(phoneId("a"));
    const { sessionId } = await createSession(r.auth, r.fixtureId, { mode: "composed", targetId: r.target.id, overlayDelayMs: 2500 }, r.deps);
    expect((await sessionsOf(r.fixtureId))[0]!.overlay_delay_ms, "the shown timing, not the stale stored one").toBe(2500);
    await saveStreamSettings(r.auth, r.fixtureId, { overlayDelayMs: 2500 }); // the PUT, landing after the POST
    expect((await sessionsOf(r.fixtureId))[0]!.overlay_delay_ms).toBe(2500);
    expect((await streamPrefsOf(r.auth.orgId, [r.fixtureId]))[r.fixtureId]?.overlayDelayMs, "the settings took the save").toBe(2500);
    const facts = await sessionFactsForJob(sessionId, r.runner.created[0]!.jobToken, r.deps);
    expect(new URL(facts.overlayUrl!).searchParams.getAll("delay"), "the Machine's overlay page delays by the same").toEqual(["2500"]);
  });

  it("each shape of the field against a stored 4 s: absent reads the stored, null is the server's default whatever is stored, 0 is a real 0, and passthrough keeps 0 whatever is named", async () => {
    deployment(true);
    const rows: [string, CreateStreamSession["mode"], number | null | undefined, number][] = [
      ["absent: the stored timing (the phone's start and the automatic start send none)", "composed", undefined, 4000],
      ["null: the server's default, never the stored 4 s", "composed", null, RELAY_OVERLAY_DELAY_DEFAULT_MS],
      ["0: a real override", "composed", 0, 0],
      ["passthrough: no compositor to delay", "passthrough", 2500, 0],
    ];
    expect(RELAY_OVERLAY_DELAY_DEFAULT_MS, "premise: the default differs from the stored 4 s").not.toBe(4000);
    let checked = 0;
    for (const [name, mode, overlayDelayMs, want] of rows) {
      const r = await captureRig({ credits: 3, connectAfterMs: 10 * 60_000 });
      await saveStreamSettings(r.auth, r.fixtureId, { overlayDelayMs: 4000 });
      await r.pair(phoneId("a"));
      const body = { mode, targetId: r.target.id, ...(overlayDelayMs === undefined ? {} : { overlayDelayMs }) };
      await createSession(r.auth, r.fixtureId, body, r.deps);
      expect((await sessionsOf(r.fixtureId))[0]!.overlay_delay_ms, name).toBe(want);
      checked++;
    }
    expect(checked).toBe(rows.length);
  });
});

describe.skipIf(!HAS_DB)("R2006: the panel reads — the stored preferences (streamPrefsOf) and a running session's own style and timing", () => {
  it("streamPrefsOf: one row per listed fixture of THIS org, as stored; a fixture with no row, or another org's, is left out; no ids reads nothing", async () => {
    const a = await captureRig();
    const b = await captureRig();
    const savedA = await saveStreamSettings(a.auth, a.fixtureId, { streamMode: "passthrough", overlayTemplate: "bar", overlayDelayMs: 0 });
    const savedB = await saveStreamSettings(b.auth, b.fixtureId, { streamMode: "composed" });
    const { fixtureId: none } = await startedDivisionWithFixture(a.auth);
    const got = await streamPrefsOf(a.auth.orgId, [a.fixtureId, b.fixtureId, none]);
    // Each read carries its row's revision: the same number the row's last answer carried (PR #989 confirm N1).
    expect(typeof savedA.revision, "PREMISE: the answer carries a revision").toBe("number");
    expect(got).toEqual({ [a.fixtureId]: { streamMode: "passthrough", overlayTemplate: "bar", overlayDelayMs: 0, revision: savedA.revision } });
    expect(await streamPrefsOf(b.auth.orgId, [b.fixtureId])).toEqual({ [b.fixtureId]: { streamMode: "composed", overlayTemplate: null, overlayDelayMs: null, revision: savedB.revision } });
    expect(await streamPrefsOf(a.auth.orgId, [])).toEqual({});
  });

  it("currentSession: a composed session carries ITS OWN copy of the style and timing (overlay) — unmoved by a later settings change; a camera session carries none", async () => {
    deployment(true);
    const r = await captureRig({ credits: 3, connectAfterMs: 10 * 60_000 });
    await saveStreamSettings(r.auth, r.fixtureId, { overlayTemplate: "bar", overlayDelayMs: 2500 });
    await r.pair(phoneId("a"));
    await createSession(r.auth, r.fixtureId, { mode: "composed", targetId: r.target.id }, r.deps);
    expect((await currentSession(r.auth, r.fixtureId, r.deps))?.overlay).toEqual({ themeId: "bar", delayMs: 2500 });
    await saveStreamSettings(r.auth, r.fixtureId, { overlayTemplate: "bug", overlayDelayMs: 0 });
    expect((await currentSession(r.auth, r.fixtureId, r.deps))?.overlay, "a running session never moves").toEqual({ themeId: "bar", delayMs: 2500 });

    const cam = await captureRig({ credits: 3, connectAfterMs: 10 * 60_000 });
    await saveStreamSettings(cam.auth, cam.fixtureId, { overlayTemplate: "bar", overlayDelayMs: 2500 });
    await cam.pair(phoneId("a"));
    await createSession(cam.auth, cam.fixtureId, { mode: "passthrough", targetId: cam.target.id }, cam.deps);
    expect((await currentSession(cam.auth, cam.fixtureId, cam.deps))?.overlay).toBeNull();
  });
});

describe.skipIf(!HAS_DB)("PR #989: the settings row's revision — a counter every writer bumps under the row lock (V466) — orders every read and answer", () => {
  /** The fixture's sport, read from its division (the writer checks the style against it), and two styles it offers. */
  const stylesOf = async (fixtureId: string): Promise<{ sportKey: string; styleA: string; styleB: string }> => {
    const [row] = await sql<{ sport_key: string }[]>`
      select d.sport_key from fixtures f join divisions d on d.id = f.division_id where f.id = ${fixtureId}`;
    const ids = templatesForSport(row!.sport_key).map((t) => t.id);
    expect(ids.length, `PREMISE: ${row!.sport_key} offers two styles`).toBeGreaterThanOrEqual(2);
    return { sportKey: row!.sport_key, styleA: ids[0]!, styleB: ids[1]! };
  };
  const revisionOf = async (fixtureId: string): Promise<number | null> => {
    const [row] = await sql<{ revision: number }[]>`select revision::float8 as revision from fixture_stream_settings where fixture_id = ${fixtureId}`;
    return row?.revision ?? null;
  };

  it("EVERY writer through the settings route answers a strictly higher revision — the pick, the switch, the mode, the style and the timing, an identical write included — and the page's read carries the latest", async () => {
    const r = await captureRig();
    const { styleA, styleB } = await stylesOf(r.fixtureId);
    // One body per writer saveStreamSettings drives, each twice (the identical second write is still a write).
    const bodies: { writer: string; body: PutStreamSettings }[] = [
      { writer: "writeAutoStream", body: { autoStream: true } },
      { writer: "writeAutoStream", body: { autoStream: true } },
      { writer: "writeStreamSettings (the pick)", body: { targetId: r.target.id } },
      { writer: "writeStreamSettings (the pick)", body: { targetId: r.target.id } },
      { writer: "writeStreamMode", body: { streamMode: "passthrough" } },
      { writer: "writeStreamMode", body: { streamMode: "passthrough" } },
      { writer: "writeOverlayTemplate", body: { overlayTemplate: styleA } },
      { writer: "writeOverlayTemplate", body: { overlayTemplate: styleA } },
      { writer: "writeOverlayTemplate", body: { overlayTemplate: styleB } },
      { writer: "writeOverlayDelay", body: { overlayDelayMs: 1500 } },
      { writer: "writeOverlayDelay", body: { overlayDelayMs: 1500 } },
      { writer: "writeStreamMode", body: { streamMode: null } },
    ];
    expect(await revisionOf(r.fixtureId), "the empty case first: no row, no revision").toBeNull();
    let prev = Number.NEGATIVE_INFINITY;
    const covered = new Set<string>();
    for (const { writer, body } of bodies) {
      const answer = await saveStreamSettings(r.auth, r.fixtureId, body);
      expect(typeof answer.revision, `${writer} ${JSON.stringify(body)}: a revision`).toBe("number");
      expect(answer.revision!, `${writer} ${JSON.stringify(body)} answers newer than the write before it`).toBeGreaterThan(prev);
      expect(await revisionOf(r.fixtureId), `${writer}: the answer is the row's revision`).toBe(answer.revision);
      prev = answer.revision!;
      covered.add(writer);
    }
    expect([...covered].sort(), "every writer the route drives was driven").toEqual(
      ["writeAutoStream", "writeOverlayDelay", "writeOverlayTemplate", "writeStreamMode", "writeStreamSettings (the pick)"]);
    expect((await streamPrefsOf(r.auth.orgId, [r.fixtureId]))[r.fixtureId]).toEqual({
      streamMode: null, overlayTemplate: styleB, overlayDelayMs: 1500, revision: prev,
    });
  });

  it("the A12 Stop stamp bumps the revision on its FIRST stamp only (a later Stop is a true no-op), and a row it creates starts above no row", async () => {
    const r = await captureRig();
    await markAutoStartBlocked(r.auth.orgId, r.fixtureId, new Date(), r.auth.userId);
    const created = await revisionOf(r.fixtureId);
    expect(created, "a row the Stop created has a revision").not.toBeNull();
    const before = (await saveStreamSettings(r.auth, r.fixtureId, { autoStream: true })).revision!;
    expect(before, "a later write lands above it").toBeGreaterThan(created!);
    const r2 = await captureRig();
    await saveStreamSettings(r2.auth, r2.fixtureId, { autoStream: true });
    const unstamped = (await revisionOf(r2.fixtureId))!;
    await markAutoStartBlocked(r2.auth.orgId, r2.fixtureId, new Date(), r2.auth.userId);
    const stamped = (await revisionOf(r2.fixtureId))!;
    expect(stamped, "the first Stop on an existing row bumps it").toBeGreaterThan(unstamped);
    await markAutoStartBlocked(r2.auth.orgId, r2.fixtureId, new Date(), r2.auth.userId);
    expect(await revisionOf(r2.fixtureId), "a second Stop writes nothing, so the revision stays").toBe(stamped);
  });

  // Two writers on ONE row, the second WAITING on the first's row lock: the waiter's bump is taken after the lock, so it
  // reads the holder's committed revision and lands above it. Swept over every preference writer (mode, style, timing).
  type Styles = Awaited<ReturnType<typeof stylesOf>>;
  /** Each preference writer, writing a value of its own — the holder's, then the waiter's (they differ, so both land). */
  const PREFERENCE_WRITERS: readonly {
    name: string;
    write: (tx: Tx, r: CaptureRig, st: Styles, turn: "holder" | "waiter") => Promise<void>;
  }[] = [
    { name: "writeStreamMode", write: (tx, r, _st, turn) =>
      writeStreamMode(tx, { orgId: r.auth.orgId, fixtureId: r.fixtureId, streamMode: turn === "holder" ? "passthrough" : "composed", updatedBy: r.auth.userId }) },
    { name: "writeOverlayTemplate", write: (tx, r, st, turn) =>
      writeOverlayTemplate(tx, { orgId: r.auth.orgId, fixtureId: r.fixtureId, sportKey: st.sportKey, overlayTemplate: turn === "holder" ? st.styleA : st.styleB, updatedBy: r.auth.userId }) },
    { name: "writeOverlayDelay", write: (tx, r, _st, turn) =>
      writeOverlayDelay(tx, { orgId: r.auth.orgId, fixtureId: r.fixtureId, overlayDelayMs: turn === "holder" ? 2000 : 3000, updatedBy: r.auth.userId }) },
  ];

  it("the lock sweep covers every preference writer (anti-vacuity: an empty table would run no case)", () => {
    expect(PREFERENCE_WRITERS.map((w) => w.name)).toEqual(["writeStreamMode", "writeOverlayTemplate", "writeOverlayDelay"]);
  });

  it.each(PREFERENCE_WRITERS.map((w) => [w.name, w] as const))("%s: a write that WAITED on another's row lock reads above it (the bump is taken under the lock)", async (_name, w) => {
    const r = await captureRig();
    const styles = await stylesOf(r.fixtureId);
    await saveStreamSettings(r.auth, r.fixtureId, { autoStream: false }); // the row exists: both writes take the update path
    let release!: () => void;
    const gate = new Promise<void>((res) => { release = res; });
    let held!: () => void;
    const holding = new Promise<void>((res) => { held = res; });
    let holderRevision = 0;
    // The holder writes and keeps its transaction (and the row lock) open until released.
    const holder = sql.begin(async (tx) => {
      await w.write(tx, r, styles, "holder");
      const [row] = await tx<{ revision: number }[]>`select revision::float8 as revision from fixture_stream_settings where fixture_id = ${r.fixtureId}`;
      holderRevision = row!.revision;
      held();
      await gate;
    });
    await holding;
    // The waiter, on its own connection: it names its backend so the test can SEE it wait on the lock.
    let waiterPid = 0;
    let waiterRevision = 0;
    let waiterStarted!: () => void;
    const started = new Promise<void>((res) => { waiterStarted = res; });
    const waiter = sql.begin(async (tx) => {
      const [me] = await tx<{ pid: number }[]>`select pg_backend_pid() as pid`;
      waiterPid = me!.pid;
      waiterStarted();
      await w.write(tx, r, styles, "waiter");
      const [row] = await tx<{ revision: number }[]>`select revision::float8 as revision from fixture_stream_settings where fixture_id = ${r.fixtureId}`;
      waiterRevision = row!.revision;
    });
    await started;
    let waited = false;
    for (let i = 0; i < 200 && !waited; i++) {
      const [a] = await sql<{ wait_event_type: string | null }[]>`select wait_event_type from pg_stat_activity where pid = ${waiterPid}`;
      waited = a?.wait_event_type === "Lock";
      if (!waited) await new Promise((res) => setTimeout(res, 10));
    }
    expect(waited, "PREMISE: the waiter blocked on the holder's row lock").toBe(true);
    release();
    await holder;
    await waiter;
    expect(waiterRevision, "the waiter's bump is taken after the lock: above the holder's").toBeGreaterThan(holderRevision);
    expect(await revisionOf(r.fixtureId), "and the row reads the waiter's").toBe(waiterRevision);
  });
});
