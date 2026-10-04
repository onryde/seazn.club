// Capture QR v2 §6.3.1 / §6.4 (T8a) — the phone's descriptor, `getCode`, DB-backed through the REAL code (minted by
// `ensureStreamCode`), the REAL organiser start (W5, the pre-pick) and FAKE drivers. Every expected value is read from
// its §6.4 SOURCE — the fixture and org rows, the four ui.json dictionaries, config.ts's declarations, the theme
// registry, the stored ingest values — never from the module under test.
//
// The §6.3.1 decision, one case per bullet: the latest session decides the shape; `cred` only to the phone that is the
// session's current phone; an ended session that reached warming answers its wire `endReason`; everything else waits.
// Then each field from its source, the R7 length fit, the 503s, the served counter and C1b both directions through the
// REAL reissue.
//
// "Another sport": the descriptor reads a sport in ONE place — the overlay theme a sport opens on (defaultThemeFor). The
// cricket case pins that row; nothing else here varies by sport, so the rest runs on the generic rig.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { sql } from "@/lib/db";
import { defaultThemeFor } from "@/components/overlay/theme-registry";
import { CaptureRefusalError } from "@/server/api-v1/capture-http";
import { CaptureDescriptor } from "@/server/api-v1/capture-schemas";
import { overlayKeyFor } from "@/server/overlay/overlay-key";
import {
  FAKE_PLAYBACK_HOST, HOLD_SLACK_SECONDS, INGEST_TIMEOUT_SECONDS, POLL_FAR_SECONDS, POLL_NEAR_SECONDS, POLL_STARTING_SECONDS,
  QR_PREFERRED_DEFAULT, SRT_LATENCY_MS, WARMING_TIMEOUT_MINUTES,
} from "@/server/relay/config";
import { readFirstInput } from "@/server/relay/secret-columns";
import { fitText, getCode, holdWindowFor } from "../capture-phone";
import { reissueStreamCode } from "../stream-codes";
import { captureRig, override, phoneId, type CaptureRig } from "./_capture-rig";

const HAS_DB = !!process.env.DATABASE_URL;

/** Every variable the descriptor reads. The suite runs with each in a KNOWN state, and restores them all. */
const ENV_KEYS = [
  "RELAY_KEK", "AUTH_SECRET", "OAUTH_BASE_URL", "NEXT_PUBLIC_BASE_URL", "STREAM_INGEST_HOST", "STREAM_PLAYBACK_HOST",
  "STREAM_SRT_ENABLED", "RELAY_DRIVERS",
] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const setEnv = (k: (typeof ENV_KEYS)[number], v: string | undefined) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
function baseEnv() {
  for (const k of ENV_KEYS) setEnv(k, undefined);
  setEnv("RELAY_KEK", KEK);
  setEnv("AUTH_SECRET", "capture-get-test-secret");
}
const KEK = randomBytes(32).toString("hex");
beforeAll(baseEnv);
beforeEach(baseEnv);
afterAll(() => { for (const k of ENV_KEYS) setEnv(k, saved[k]); });

const ORIGIN = "http://app.test";   // the rig's deps.appUrl: the origin when neither base-url variable is set

async function fixtureRow(fixtureId: string) {
  const [f] = await sql<{ fixture_no: number; status: string; scheduled_at: Date | null; home_entrant_id: string | null; away_entrant_id: string | null }[]>`
    select fixture_no, status, scheduled_at, home_entrant_id, away_entrant_id from fixtures where id = ${fixtureId}`;
  return f!;
}
async function setSides(fixtureId: string, a: string | null, b: string | null) {
  const f = await fixtureRow(fixtureId);
  for (const [col, id, name] of [["home", f.home_entrant_id, a], ["away", f.away_entrant_id, b]] as const) {
    if (name === null) {
      if (col === "home") await sql`update fixtures set home_entrant_id = null where id = ${fixtureId}`;
      else await sql`update fixtures set away_entrant_id = null where id = ${fixtureId}`;
    } else {
      await sql`update entrants set display_name = ${name} where id = ${id}`;
    }
  }
}
async function sessionRow(sid: string) {
  const [s] = await sql<{ state: string; warming_at: Date | null; created_at: Date; max_duration_minutes: number; credentials_served_count: number }[]>`
    select state, warming_at, created_at, max_duration_minutes, credentials_served_count from fixture_stream_sessions where id = ${sid}`;
  return s!;
}
async function inputUid(sid: string): Promise<string> {
  const [i] = await sql<{ ingest_input_id: string }[]>`select ingest_input_id from fixture_stream_inputs where session_id = ${sid} order by slot limit 1`;
  return i!.ingest_input_id;
}
/** Move a session to `state` (raw: only the READ is under test here). */
async function moveTo(sid: string, state: "requested" | "provisioning" | "live" | "ending" | "completed" | "failed", why: { end?: string | null; fail?: string | null; warmingAt?: null } = {}) {
  const warming = why.warmingAt === null ? sql`, warming_at = null` : sql``;
  if (state === "ending" || state === "completed") {
    await sql`update fixture_stream_sessions set state = ${state}, end_reason = ${why.end ?? null}, fail_reason = null,
              ended_at = ${state === "completed" ? sql`now()` : null}, ending_at = now() ${warming} where id = ${sid}`;
  } else if (state === "failed") {
    await sql`update fixture_stream_sessions set state = 'failed', fail_reason = ${why.fail ?? null}, end_reason = null, ended_at = now() ${warming} where id = ${sid}`;
  } else {
    await sql`update fixture_stream_sessions set state = ${state}, first_ingest_at = ${state === "live" ? sql`now()` : null} ${warming} where id = ${sid}`;
  }
}
const get = (r: CaptureRig, phone: string | null, code = r.code, tok = r.tok) => getCode(code, tok, { slot: 0, phone }, r.deps, r.now());
const refusal = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e);
const epochS = (d: Date) => Math.floor(d.getTime() / 1000);

/** The waiting fields every shape shares, from their §6.4 sources (rig defaults: generic, A v B, overlay on). */
async function expectedWaiting(r: CaptureRig, o: { label: string; pollSeconds: number; destinationName: string | null; scheduledStart?: number }) {
  const key = overlayKeyFor(r.fixtureId);
  return {
    code: r.code, label: o.label, venueTimezone: "UTC", pollSeconds: o.pollSeconds, autoAllowed: false,
    destinationName: o.destinationName,
    overlayUrl: `${ORIGIN}/overlay/fixtures/${r.fixtureId}?style=${defaultThemeFor("generic")}&key=${encodeURIComponent(key!)}`,
    heartbeatUrl: `${ORIGIN}/api/v1/capture/codes/${r.code}/beats`,
    startUrl: `${ORIGIN}/api/v1/capture/codes/${r.code}/start`,
    ...(o.scheduledStart !== undefined ? { scheduledStart: o.scheduledStart } : {}),
  };
}

describe.skipIf(!HAS_DB)("getCode — the §6.3.1 decision", () => {
  it("EMPTY: no session ever → the waiting shape, with a phone and without; every field from its source; scheduledStart OMITTED while scheduled_at is null", async () => {
    const r = await captureRig();
    await setSides(r.fixtureId, "Alpha", "Bravo");
    const f = await fixtureRow(r.fixtureId);
    expect(f.status, "PREMISE: a started fixture, not in play").toBe("scheduled");
    expect(f.scheduled_at, "PREMISE: no scheduled_at — the far cadence").toBeNull();
    const want = { state: "waiting", ...(await expectedWaiting(r, { label: "Alpha v Bravo", pollSeconds: POLL_FAR_SECONDS, destinationName: null })) };
    let checked = 0;
    for (const phone of [phoneId("x"), null]) {
      const body = await get(r, phone);
      expect(body).toEqual(want);
      expect(Object.hasOwn(body, "scheduledStart"), "omitted, never null (§6.4)").toBe(false);
      expect(CaptureDescriptor.parse(body)).toEqual(body);
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("an OPEN warming session: its own phone gets the session shape WITH cred (the stored values); another phone the same shape with cred ABSENT; no phone → waiting", async () => {
    const r = await captureRig();
    const mine = phoneId("mine");
    const sid = await r.start(mine);
    const s = await sessionRow(sid);
    expect(s.state, "PREMISE: the real start left it warming").toBe("warming");
    const stored = await sql.begin((tx) => readFirstInput(tx, sid));
    const withCred = await get(r, mine);
    expect(withCred.state).toBe("warming");
    expect(withCred).toMatchObject({
      sid, preferred: QR_PREFERRED_DEFAULT,
      cred: {
        srt: { url: stored!.srt!.url, streamId: stored!.srt!.streamId, passphrase: stored!.srt!.passphrase, latencyMs: SRT_LATENCY_MS },
        rtmps: { url: stored!.rtmps!.url, streamKey: stored!.rtmps!.streamKey },
      },
    });
    expect(CaptureDescriptor.parse(withCred)).toEqual(withCred);
    const other = await get(r, phoneId("other"));
    expect(other.state).toBe("warming");
    expect(Object.hasOwn(other, "cred"), "absent — not null — for a phone that is not the session's").toBe(false);
    const rest: Record<string, unknown> = { ...withCred };
    delete rest.cred;
    expect(other).toEqual(rest);
    expect((await get(r, null)).state).toBe("waiting");
  });

  it("live and ending: the session shape; ending carries the wire endReason, live none; cred to the session's phone only", async () => {
    const r = await captureRig();
    const mine = phoneId("mine");
    const sid = await r.start(mine);
    await moveTo(sid, "live");
    const live = await get(r, mine);
    expect(live).toMatchObject({ state: "live", sid });
    expect(Object.hasOwn(live, "cred")).toBe(true);
    expect(Object.hasOwn(live, "endReason")).toBe(false);
    await moveTo(sid, "ending", { end: "stopped" });
    const ending = await get(r, mine);
    expect(ending).toMatchObject({ state: "ending", sid, endReason: "stopped" });
    expect(Object.hasOwn(ending, "cred")).toBe(true);
    expect(Object.hasOwn(await get(r, phoneId("other")), "cred")).toBe(false);
    for (const b of [live, ending]) expect(CaptureDescriptor.parse(b)).toEqual(b);
  });

  it("ENDED after warming: completed and failed carry the wire endReason (§6.8.4) and NEVER cred, even to the session's phone; a completed row with no reason is `failed` (R11)", async () => {
    const cases: { move: Parameters<typeof moveTo>; wire: string }[] = [
      { move: ["", "completed", { end: "operator_stopped" }], wire: "stopped" },
      { move: ["", "completed", { end: "max_duration" }], wire: "max_duration" },
      { move: ["", "completed", { end: null }], wire: "failed" },
      { move: ["", "failed", { fail: "no_inbound_timeout" }], wire: "no_inbound_timeout" },
      { move: ["", "failed", { fail: "machine_oom" }], wire: "failed" },
    ];
    let checked = 0;
    for (const c of cases) {
      const r = await captureRig();
      const mine = phoneId("mine");
      const sid = await r.start(mine);
      await moveTo(sid, c.move[1], c.move[2]);
      const body = await get(r, mine);
      expect(body, JSON.stringify(c.move[2])).toMatchObject({ state: c.move[1], sid, endReason: c.wire });
      expect(Object.hasOwn(body, "cred")).toBe(false);
      expect(CaptureDescriptor.parse(body)).toEqual(body);
      checked++;
    }
    expect(checked).toBe(cases.length);
  });

  it("ended BEFORE warming, requested and provisioning → the waiting shape; requested/provisioning answer POLL_STARTING_SECONDS", async () => {
    let checked = 0;
    for (const [state, poll] of [["requested", POLL_STARTING_SECONDS], ["provisioning", POLL_STARTING_SECONDS]] as const) {
      const r = await captureRig();
      const mine = phoneId("mine");
      const sid = await r.start(mine);
      await moveTo(sid, state, { warmingAt: null });
      const body = await get(r, mine);
      expect(body, state).toMatchObject({ state: "waiting", pollSeconds: poll });
      expect(CaptureDescriptor.parse(body)).toEqual(body);
      checked++;
    }
    const r = await captureRig();
    const mine = phoneId("mine");
    const sid = await r.start(mine);
    await moveTo(sid, "failed", { fail: "provision_timeout", warmingAt: null });
    const body = await get(r, mine);
    expect(body).toMatchObject({ state: "waiting", pollSeconds: POLL_FAR_SECONDS });
    expect(Object.hasOwn(body, "sid")).toBe(false);
    checked++;
    expect(checked).toBe(3);
  });

  it("NO phone → the waiting shape in EVERY case (swept over every session state the decision distinguishes)", async () => {
    const moves: (Parameters<typeof moveTo>[1] | "none" | "warming" | "pre-warming")[] = ["none", "requested", "provisioning", "warming", "live", "ending", "completed", "failed", "pre-warming"];
    let checked = 0;
    for (const m of moves) {
      const r = await captureRig();
      if (m !== "none") {
        const sid = await r.start(phoneId("mine"));
        if (m === "pre-warming") await moveTo(sid, "failed", { fail: "provision_timeout", warmingAt: null });
        else if (m === "ending" || m === "completed") await moveTo(sid, m, { end: "stopped" });
        else if (m === "failed") await moveTo(sid, m, { fail: "no_inbound_timeout" });
        else if (m !== "warming") await moveTo(sid, m);
      }
      expect((await get(r, null)).state, m).toBe("waiting");
      checked++;
    }
    expect(checked).toBe(moves.length);
  });

  it("credentials_served_count moves by exactly 1 when cred is in the body, and by 0 for another phone or no phone", async () => {
    const r = await captureRig();
    const mine = phoneId("mine");
    const sid = await r.start(mine);
    const count = async () => (await sessionRow(sid)).credentials_served_count;
    const steps: { phone: string | null; delta: number }[] = [
      { phone: mine, delta: 1 }, { phone: phoneId("other"), delta: 0 }, { phone: null, delta: 0 }, { phone: mine, delta: 1 },
    ];
    for (const s of steps) {
      const before = await count();
      const body = await get(r, s.phone);
      expect(Object.hasOwn(body, "cred")).toBe(s.delta === 1);
      expect(await count(), String(s.phone)).toBe(before + s.delta);
    }
    expect(steps.length).toBe(4);
  });
});

describe.skipIf(!HAS_DB)("getCode — each field from its §6.4 source", () => {
  it("label: a TBD side → breadcrumb.match in the ORG's default_locale (W25), read from each locale's ui.json, with the fixture's number", async () => {
    let checked = 0;
    for (const locale of ["en", "es", "fr", "nl"] as const) {
      const r = await captureRig();
      await sql`update organizations set default_locale = ${locale} where id = ${r.auth.orgId}`;
      await setSides(r.fixtureId, null, "Bravo");
      const dict = JSON.parse(readFileSync(resolve(import.meta.dirname, `../../../dictionaries/${locale}/ui.json`), "utf8")) as Record<string, string>;
      const template = dict["breadcrumb.match"];
      expect(template, `PREMISE: ${locale} has breadcrumb.match`).toMatch(/\{no\}/);
      const want = template!.replace("{no}", String((await fixtureRow(r.fixtureId)).fixture_no));
      expect((await get(r, null)).label, locale).toBe(want);
      checked++;
    }
    expect(checked).toBe(4);
  });

  it("venueTimezone: the V305 lane — division override, else the org's timezone, else UTC", async () => {
    const r = await captureRig();
    expect((await get(r, null)).venueTimezone).toBe("UTC");
    await sql`update organizations set timezone = 'Europe/Paris' where id = ${r.auth.orgId}`;
    expect((await get(r, null)).venueTimezone).toBe("Europe/Paris");
    const [{ division_id }] = await sql<{ division_id: string }[]>`select division_id from fixtures where id = ${r.fixtureId}`;
    await sql`insert into schedule_settings (division_id, org_id, tz) values (${division_id}, ${r.auth.orgId}, 'Asia/Kolkata')
              on conflict (division_id) do update set tz = excluded.tz`;
    expect((await get(r, null)).venueTimezone).toBe("Asia/Kolkata");
  });

  it("scheduledStart: the fixture's scheduled_at as epoch seconds; inside the near window the cadence is POLL_NEAR_SECONDS", async () => {
    const r = await captureRig();
    const at = new Date(Math.floor(r.now().getTime() / 1000) * 1000 + 10 * 60_000);   // 10 min ahead, a whole second
    await sql`update fixtures set scheduled_at = ${at} where id = ${r.fixtureId}`;
    const body = await get(r, null);
    expect(body).toMatchObject({ scheduledStart: epochS(at), pollSeconds: POLL_NEAR_SECONDS });
  });

  it("overlayUrl: filled only with streaming.overlay (W18); without AUTH_SECRET it carries no key and scoreUpdates is polled; the session's theme_id wins over the sport default", async () => {
    const r = await captureRig();
    const mine = phoneId("mine");
    const sid = await r.start(mine);
    const key = overlayKeyFor(r.fixtureId)!;
    const on = await get(r, mine);
    expect(on).toMatchObject({ overlayUrl: `${ORIGIN}/overlay/fixtures/${r.fixtureId}?style=${defaultThemeFor("generic")}&key=${encodeURIComponent(key)}`, scoreUpdates: "realtime" });
    await sql`update fixture_stream_sessions set theme_id = 'bar' where id = ${sid}`;
    expect((await get(r, mine)).overlayUrl).toBe(`${ORIGIN}/overlay/fixtures/${r.fixtureId}?style=bar&key=${encodeURIComponent(key)}`);
    setEnv("AUTH_SECRET", undefined);
    expect(await get(r, mine)).toMatchObject({ overlayUrl: `${ORIGIN}/overlay/fixtures/${r.fixtureId}?style=bar`, scoreUpdates: "polled" });
    setEnv("AUTH_SECRET", "capture-get-test-secret");
    await override(r.auth.orgId, "streaming.overlay", false);
    const off = await get(r, mine);
    expect(off).toMatchObject({ overlayUrl: null, scoreUpdates: "polled" });
    expect((await get(r, null)).overlayUrl).toBeNull();
  });

  it("ANOTHER SPORT: a cricket fixture's overlay opens on cricket's own theme (defaultThemeFor), not the generic one", async () => {
    expect(defaultThemeFor("cricket"), "PREMISE: the two sports open on different themes").not.toBe(defaultThemeFor("generic"));
    const r = await captureRig({ sport: "cricket" });
    expect((await get(r, null)).overlayUrl).toBe(`${ORIGIN}/overlay/fixtures/${r.fixtureId}?style=${defaultThemeFor("cricket")}&key=${encodeURIComponent(overlayKeyFor(r.fixtureId)!)}`);
  });

  it("origin: OAUTH_BASE_URL, else NEXT_PUBLIC_BASE_URL, else deps.appUrl — never the request's host", async () => {
    const r = await captureRig();
    setEnv("NEXT_PUBLIC_BASE_URL", "https://public.example/");
    expect((await get(r, null)).heartbeatUrl).toBe(`https://public.example/api/v1/capture/codes/${r.code}/beats`);
    setEnv("OAUTH_BASE_URL", "https://oauth.example");
    const body = await get(r, null);
    expect(body).toMatchObject({ heartbeatUrl: `https://oauth.example/api/v1/capture/codes/${r.code}/beats`, startUrl: `https://oauth.example/api/v1/capture/codes/${r.code}/start` });
    expect(body.overlayUrl!.startsWith(`https://oauth.example/overlay/fixtures/${r.fixtureId}?`)).toBe(true);
  });

  it("playbackUrl: https://{host}/{ingest input uid}/manifest/video.m3u8 with NO query — the fake's host locally, the environment's when set", async () => {
    const r = await captureRig();
    const mine = phoneId("mine");
    const sid = await r.start(mine);
    const uid = await inputUid(sid);
    const local = await get(r, mine);
    expect(local).toMatchObject({ playbackUrl: `https://${FAKE_PLAYBACK_HOST}/${uid}/manifest/video.m3u8` });
    if (local.state === "waiting") throw new Error("PREMISE: session shape");
    expect(new URL(local.playbackUrl).search).toBe("");
    setEnv("STREAM_PLAYBACK_HOST", "customer-test.cloudflarestream.com");
    expect((await get(r, mine))).toMatchObject({ playbackUrl: `https://customer-test.cloudflarestream.com/${uid}/manifest/video.m3u8` });
  });

  it("holdWindowSeconds: rtmps from the capability, srt = INGEST_TIMEOUT_SECONDS + HOLD_SLACK_SECONDS (never the capability's null); both within 1..999", async () => {
    const r = await captureRig();
    const mine = phoneId("mine");
    await r.start(mine);
    expect(r.ingest.capabilities.holdWindowSeconds.srt, "PREMISE: SRT's hold is unmeasured (A17, FP13)").toBeNull();
    const body = await get(r, mine);
    const want = { rtmps: r.ingest.capabilities.holdWindowSeconds.rtmps, srt: INGEST_TIMEOUT_SECONDS + HOLD_SLACK_SECONDS };
    expect(body).toMatchObject({ holdWindowSeconds: want });
    for (const v of Object.values(want)) { expect(v).toBeGreaterThanOrEqual(1); expect(v).toBeLessThanOrEqual(999); }
  });

  it("maxDurationMinutes is the session's own; warmingDeadline = (warming_at ?? created_at) + WARMING_TIMEOUT_MINUTES (A8), a null warming_at included", async () => {
    const r = await captureRig();
    const mine = phoneId("mine");
    const sid = await r.start(mine);
    const anchor = new Date(Math.floor(r.now().getTime() / 1000) * 1000 - 30_000);
    await sql`update fixture_stream_sessions set warming_at = ${anchor}, max_duration_minutes = 123 where id = ${sid}`;
    expect(await get(r, mine)).toMatchObject({ maxDurationMinutes: 123, warmingDeadline: epochS(anchor) + WARMING_TIMEOUT_MINUTES * 60 });
    const created = new Date(Math.floor(r.now().getTime() / 1000) * 1000 - 90_000);
    await sql`update fixture_stream_sessions set warming_at = null, created_at = ${created} where id = ${sid}`;
    expect(await get(r, mine)).toMatchObject({ warmingDeadline: epochS(created) + WARMING_TIMEOUT_MINUTES * 60 });
  });

  it("destinationName: the pre-picked target's label; null when there is none or it is archived (T36)", async () => {
    const r = await captureRig({ targetLabel: "Court One Feed" });
    expect((await get(r, null)).destinationName, "no pre-pick yet").toBeNull();
    const sid = await r.start(phoneId("mine"));
    expect((await get(r, null)).destinationName, "the Go live saved the pre-pick").toBe("Court One Feed");
    await moveTo(sid, "completed", { end: "stopped" });
    await sql`update org_stream_targets set archived_at = now() where id = ${r.target.id}`;
    expect((await get(r, null)).destinationName).toBeNull();
  });
});

describe.skipIf(!HAS_DB)("getCode — the R7 length fit (contract maxima 200 and 80)", () => {
  const LABEL_MAX = (CaptureDescriptor.options[0].shape.label.maxLength)!;
  const DEST_MAX = (CaptureDescriptor.options[0].shape.destinationName.unwrap().maxLength)!;

  it("PREMISE: the maxima are the contract's 200 and 80", () => {
    expect([LABEL_MAX, DEST_MAX]).toEqual([200, 80]);
  });

  it("two 200-character names → a label of exactly LABEL_MAX ending in ONE ellipsis; a label of exactly LABEL_MAX is sent whole", async () => {
    const r = await captureRig();
    await setSides(r.fixtureId, "a".repeat(LABEL_MAX), "b".repeat(LABEL_MAX));
    const long = (await get(r, null)).label;
    expect(long.length).toBe(LABEL_MAX);
    expect(long.endsWith("…")).toBe(true);
    expect(long.split("…").length - 1).toBe(1);
    expect(long.startsWith("a".repeat(LABEL_MAX - 1))).toBe(true);
    // The positive pair: "{A} v {B}" exactly LABEL_MAX long.
    const a = "c".repeat(100), b = "d".repeat(LABEL_MAX - 100 - " v ".length);
    await setSides(r.fixtureId, a, b);
    const exact = await get(r, null);
    expect(exact.label).toBe(`${a} v ${b}`);
    expect(exact.label.length).toBe(LABEL_MAX);
    expect(exact.label.includes("…")).toBe(false);
  });

  it("an emoji (a surrogate pair) straddling the cut is never split, and the body still parses", async () => {
    const r = await captureRig();
    // The pair occupies units LABEL_MAX-2 and LABEL_MAX-1, so a naive cut at LABEL_MAX-1 would keep its high half.
    const name = "e".repeat(LABEL_MAX - 2) + "😀" + "tail";
    await setSides(r.fixtureId, name, "x");
    const body = await get(r, null);
    expect(body.label.length).toBeLessThanOrEqual(LABEL_MAX);
    expect(body.label.endsWith("…")).toBe(true);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(body.label), "no lone high surrogate").toBe(false);
    expect(CaptureDescriptor.parse(body)).toEqual(body);
  });

  it("a legacy 81-character target label (no DB CHECK) → destinationName of exactly DEST_MAX ending in ONE ellipsis", async () => {
    const r = await captureRig();
    await r.start(phoneId("mine"));
    await sql`update org_stream_targets set label = ${"L".repeat(DEST_MAX + 1)} where id = ${r.target.id}`;
    const body = await get(r, null);
    expect(body.destinationName!.length).toBe(DEST_MAX);
    expect(body.destinationName!.endsWith("…")).toBe(true);
    expect(CaptureDescriptor.parse(body)).toEqual(body);
  });
});

describe.skipIf(!HAS_DB)("getCode — refusals and the deployment's settings", () => {
  it("a REAL-driver deployment without STREAM_PLAYBACK_HOST: the session shape is 503 unavailable (playback_unconfigured); the waiting shape still answers", async () => {
    const r = await captureRig();
    const mine = phoneId("mine");
    await r.start(mine);
    setEnv("RELAY_DRIVERS", "live");
    const err = await refusal(get(r, mine));
    expect(err).toBeInstanceOf(CaptureRefusalError);
    expect(err).toMatchObject({ status: 503, code: "unavailable" });
    expect((err as Error).message).toMatch(/playback_unconfigured/);
    expect((await get(r, null)).state, "the positive pair: no playback is needed to wait").toBe("waiting");
  });

  it("STREAM_INGEST_HOST over Cloudflare's stored values: RTMPS rewritten, SRT unchanged (W21); over a foreign host: 503 unavailable (ingest_host_unexpected)", async () => {
    const r = await captureRig();
    const mine = phoneId("mine");
    const sid = await r.start(mine);
    setEnv("STREAM_INGEST_HOST", "live.test.seazn.club");
    const err = await refusal(get(r, mine));   // the fake's own host is foreign once a host is configured
    expect(err).toMatchObject({ status: 503, code: "unavailable" });
    expect((err as Error).message).toMatch(/ingest_host_unexpected/);
    await sql`update fixture_stream_inputs set ingest_rtmps_url = 'rtmps://live.cloudflare.com:443/live/', ingest_srt_url = 'srt://live.cloudflare.com:778' where session_id = ${sid}`;
    const body = await get(r, mine);
    expect(body).toMatchObject({ cred: { rtmps: { url: "rtmps://live.test.seazn.club:443/live/" }, srt: { url: "srt://live.cloudflare.com:778" } } });
  });

  it("STREAM_SRT_ENABLED=false (A18): cred.srt is null and preferred is rtmps; unset is SRT on (W21)", async () => {
    const r = await captureRig();
    const mine = phoneId("mine");
    await r.start(mine);
    expect(await get(r, mine)).toMatchObject({ preferred: QR_PREFERRED_DEFAULT });
    setEnv("STREAM_SRT_ENABLED", "false");
    const body = await get(r, mine);
    expect(body).toMatchObject({ preferred: "rtmps", cred: { srt: null } });
    expect(CaptureDescriptor.parse(body)).toEqual(body);
  });

  it("a session whose stored ingest credential is missing is 503 unavailable — never a cred-less answer that tells its own phone to re-claim", async () => {
    const r = await captureRig();
    const mine = phoneId("mine");
    const sid = await r.start(mine);
    await sql`update fixture_stream_inputs set ingest_rtmps_url = null where session_id = ${sid}`;
    expect(await refusal(get(r, mine))).toMatchObject({ status: 503, code: "unavailable" });
  });

  it("C1b/C3 through the REAL reissue: the ended code still serves its open session's phone (with cred); another phone and no phone are 401; once the session ends, 401", async () => {
    const r = await captureRig();
    const mine = phoneId("mine");
    const sid = await r.start(mine);
    const fresh = await reissueStreamCode(r.auth, r.fixtureId);
    expect(fresh.qr.code, "PREMISE: a new code").not.toBe(r.code);
    const served = await get(r, mine);
    expect(served).toMatchObject({ state: "warming", sid });
    expect(Object.hasOwn(served, "cred")).toBe(true);
    for (const phone of [phoneId("other"), null]) {
      expect(await refusal(get(r, phone)), String(phone)).toMatchObject({ status: 401, code: "code_ended" });
    }
    // The new code serves anyone holding its tok — its waiting fields name the NEW code.
    expect((await get(r, null, fresh.qr.code, fresh.qr.tok))).toMatchObject({ state: "waiting", code: fresh.qr.code });
    await moveTo(sid, "completed", { end: "stopped" });
    expect(await refusal(get(r, mine)), "the session ended: nothing left to serve").toMatchObject({ status: 401, code: "code_ended" });
  });

  it("a malformed code → 404 not_a_stream_code; a wrong tok → 401 code_ended; slot 1 → 422 invalid (T41)", async () => {
    const r = await captureRig();
    expect(await refusal(getCode("NOT-A-CODE!", r.tok, { slot: 0, phone: null }, r.deps, r.now()))).toMatchObject({ status: 404, code: "not_a_stream_code" });
    expect(await refusal(getCode(r.code, "wrong-tok", { slot: 0, phone: null }, r.deps, r.now()))).toMatchObject({ status: 401, code: "code_ended" });
    expect(await refusal(getCode(r.code, r.tok, { slot: 1, phone: null }, r.deps, r.now()))).toMatchObject({ status: 422, code: "invalid" });
  });
});

describe("the two pure guards the descriptor builder owns", () => {
  it("holdWindowFor refuses a capability outside the contract's 1..999 by name (capture request d) — the positive pair is the fake's 183", () => {
    expect(holdWindowFor({ rtmps: INGEST_TIMEOUT_SECONDS + HOLD_SLACK_SECONDS, srt: null })).toEqual({ srt: INGEST_TIMEOUT_SECONDS + HOLD_SLACK_SECONDS, rtmps: INGEST_TIMEOUT_SECONDS + HOLD_SLACK_SECONDS });
    let refused = 0;
    for (const rtmps of [1000, 0, 1.5]) {
      expect(() => holdWindowFor({ rtmps, srt: null }), String(rtmps)).toThrow(/holdWindowSeconds\.rtmps/);
      refused++;
    }
    expect(refused).toBe(3);
  });

  it("fitText: within max unchanged (the empty string too); over max exactly max units with one ellipsis; max < 1 refused", () => {
    expect(fitText("", 5)).toBe("");
    expect(fitText("abcde", 5)).toBe("abcde");
    expect(fitText("abcdef", 5)).toBe("abcd…");
    expect(fitText("abc😀", 4)).toBe("abc…");   // the pair would straddle the cut: dropped whole, never split
    expect(fitText("ab😀cd", 4)).toBe("ab…");
    expect(() => fitText("abc", 0)).toThrow(RangeError);
  });
});
