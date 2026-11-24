// Seazn-hosted video, Phase 4 Task 38 (V558): the club's default Score style and Score timing reach the sessions a club starts.
// DB-backed, through the REAL writer (`saveOrgStreamDefaults`, as the route calls it), the REAL settings writer
// (`saveStreamSettings`), and every REAL start path — the organiser's Go live (`createSession`), the phone's own start
// (`postStart`) and the automatic start (a beat through `postBeat` → `maybeAutoStart`) — on FAKE drivers. The court's half is
// stream-auto-court.test.ts's (its rig starts a court session).
//
// The expectations are the OWNER's chain (ledger 454 / 504), typed here, never read from start.ts:
//   style:  the match's own choice, else the club's, else the sport's default (resolved by every reader, so a session with neither
//           stores no theme);
//   timing: the match's own, else the club's, else the default (3.1 s) — a match stream only; `0` is a real value at every link;
//   a session COPIES both at its start, so a change to the club's defaults (or a match's) never moves a running stream;
//   the club's defaults are the CLUB's: another org's session never reads them.
//
// Two sports on the DB rig (generic and cricket, whose own default style DIFFERS: bar against bug); the chain over EVERY sport
// is lib/__tests__/stream-settings.test.ts's, run through `forEachSport`.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { defaultTemplateFor } from "@/components/overlay/template-registry";
import { sql } from "@/lib/db";
import { effectiveDelayMs, effectiveTemplateId } from "@/lib/stream-settings";
import { CaptureBeat } from "@/server/api-v1/capture-schemas";
import type { StreamMode } from "@/server/api-v1/schemas";
import { RELAY_OVERLAY_DELAY_DEFAULT_MS, overlayDelayDefaultMs } from "@/server/relay/config";
import { getCode, postBeat, postStart } from "../capture-phone";
import { orgStreamDefaultsOf, saveOrgStreamDefaults } from "../org-stream-defaults";
import { saveStreamSettings } from "../stream-codes";
import { createSession, currentSession, sessionFactsForJob } from "../stream-sessions";
import { captureRig, phoneId, type CaptureRig } from "./_capture-rig";

vi.mock("@/lib/sentry", () => ({ captureError: vi.fn() }));

const HAS_DB = !!process.env.DATABASE_URL;

const ENV_KEYS = ["RELAY_KEK", "AUTH_SECRET", "OAUTH_BASE_URL", "NEXT_PUBLIC_BASE_URL", "STREAM_PLAYBACK_HOST", "STREAM_SRT_ENABLED", "RELAY_DRIVERS", "RELAY_IMAGE"] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const KEK = randomBytes(32).toString("hex");
function baseEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.RELAY_KEK = KEK;
  process.env.AUTH_SECRET = "stream-club-style-test-secret";
  process.env.RELAY_IMAGE = "registry.fly.io/seazn-relay:club-style-test";   // the deployment can run a composed session
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

const MATCH_DEFAULT = RELAY_OVERLAY_DELAY_DEFAULT_MS;
const sessionsOf = (fx: string) => sql<{ id: string; mode: StreamMode; start_cause: string; theme_id: string | null; overlay_delay_ms: number }[]>`
  select id, mode, start_cause, theme_id, overlay_delay_ms from fixture_stream_sessions where fixture_id = ${fx} order by created_at, id`;
/** The rig's fixture's sport, as its division says (never assumed). */
const sportOf = async (fx: string): Promise<string> =>
  (await sql<{ sport_key: string }[]>`select d.sport_key from fixtures f join divisions d on d.id = f.division_id where f.id = ${fx}`)[0]!.sport_key;

/** A composed Go live on a fresh rig, after the fixture's own settings and the club's are written in that order. */
async function goLive(
  sport: "generic" | "cricket",
  o: { club?: { overlayTemplate?: string | null; overlayDelayMs?: number | null }; match?: { overlayTemplate?: string | null; overlayDelayMs?: number | null }; body?: { themeId?: string; overlayDelayMs?: number | null } },
): Promise<{ r: CaptureRig; sid: string; session: Awaited<ReturnType<typeof sessionsOf>>[number] }> {
  const r = await captureRig({ sport, credits: 3, connectAfterMs: 10 * 60_000 });
  if (o.club) await saveOrgStreamDefaults(r.auth, r.auth.orgId, o.club);
  if (o.match) await saveStreamSettings(r.auth, r.fixtureId, o.match);
  await r.pair(phoneId("a"));
  const { sessionId } = await createSession(r.auth, r.fixtureId, { mode: "composed", targetId: r.target.id, ...o.body }, r.deps);
  const [session] = await sessionsOf(r.fixtureId);
  expect(session, "premise: one composed session").toMatchObject({ id: sessionId, mode: "composed" });
  return { r, sid: sessionId, session: session! };
}

describe.skipIf(!HAS_DB)("the Score TIMING chain on a match stream: match ?? club ?? default (0 is real at every link)", () => {
  it("every link, through the organiser's Go live with the body absent (the phone's and the automatic start send none)", async () => {
    expect(MATCH_DEFAULT, "premise: the default is not any value below").not.toBe(4500);
    const rows: { name: string; club: number | null | undefined; match: number | null | undefined; want: number }[] = [
      { name: "neither set: the default", club: undefined, match: undefined, want: MATCH_DEFAULT },
      { name: "the club's timing reaches a match with none of its own", club: 4500, match: undefined, want: 4500 },
      { name: "the match's own beats the club's", club: 4500, match: 2500, want: 2500 },
      { name: "the match's own 0 beats the club's (0 is a real override, not 'unset')", club: 4500, match: 0, want: 0 },
      { name: "the club's 0 is a real value (not 'unset' → the default)", club: 0, match: undefined, want: 0 },
      { name: "the match's override cleared (null) falls back to the CLUB's, not the default", club: 4500, match: null, want: 4500 },
      { name: "the club's cleared (null) falls back to the default", club: null, match: undefined, want: MATCH_DEFAULT },
    ];
    let checked = 0;
    for (const row of rows) {
      const { r, sid } = await goLive("generic", {
        club: row.club === undefined ? undefined : { overlayDelayMs: row.club },
        match: row.match === undefined ? undefined : { overlayDelayMs: row.match },
      });
      const { session } = { session: (await sessionsOf(r.fixtureId))[0]! };
      expect(session.overlay_delay_ms, row.name).toBe(row.want);
      // The panel's own rule (lib/stream-settings.ts) names the same number: the display and the session cannot disagree.
      expect(effectiveDelayMs({ match: row.match ?? null, club: row.club ?? null, court: false, matchDefaultMs: MATCH_DEFAULT, courtDefaultMs: overlayDelayDefaultMs(true) }), `${row.name}: the panel's rule`).toBe(row.want);
      // …and the Machine's overlay page delays by the same.
      const facts = await sessionFactsForJob(sid, r.runner.created[0]!.jobToken, r.deps);
      expect(new URL(facts.overlayUrl!).searchParams.getAll("delay"), `${row.name}: the job facts`).toEqual([String(row.want)]);
      checked++;
    }
    expect(checked).toBe(rows.length);
  });

  it("each shape of the Go live body against a club 4.5 s and a stored 2.5 s: absent reads the stored, null the CLUB's (not the default), 0 a real 0, a number that number; passthrough keeps 0", async () => {
    const rows: { name: string; mode: "composed" | "passthrough"; body: number | null | undefined; want: number }[] = [
      { name: "absent: the match's stored timing", mode: "composed", body: undefined, want: 2500 },
      { name: "null: the club's timing, never the stored 2.5 s and never the default", mode: "composed", body: null, want: 4500 },
      { name: "0: a real 0", mode: "composed", body: 0, want: 0 },
      { name: "a number: that number", mode: "composed", body: 1200, want: 1200 },
      { name: "passthrough: no compositor to delay", mode: "passthrough", body: 1200, want: 0 },
    ];
    let checked = 0;
    for (const row of rows) {
      const r = await captureRig({ credits: 3, connectAfterMs: 10 * 60_000 });
      await saveOrgStreamDefaults(r.auth, r.auth.orgId, { overlayDelayMs: 4500 });
      await saveStreamSettings(r.auth, r.fixtureId, { overlayDelayMs: 2500 });
      await r.pair(phoneId("a"));
      await createSession(r.auth, r.fixtureId, { mode: row.mode, targetId: r.target.id, ...(row.body === undefined ? {} : { overlayDelayMs: row.body }) }, r.deps);
      expect((await sessionsOf(r.fixtureId))[0]!.overlay_delay_ms, row.name).toBe(row.want);
      checked++;
    }
    expect(checked).toBe(rows.length);
  });
});

describe.skipIf(!HAS_DB)("the Score STYLE chain: match ?? club ?? the sport's default — generic and cricket (whose own defaults differ)", () => {
  it("premise: the two sports' own defaults differ, so a club style can differ from the fall-through on one of them", () => {
    expect(defaultTemplateFor("generic")).not.toBe(defaultTemplateFor("cricket"));
  });

  for (const sport of ["generic", "cricket"] as const) {
    it(`${sport}: every link — the club's style reaches a match with none; the match's own wins; the match's cleared falls to the club's; neither stores NO theme (the sport's default resolves at every reader)`, async () => {
      const own = defaultTemplateFor(sport);
      const other = own === "bar" ? "bug" : "bar";
      const rows: { name: string; club: string | null | undefined; match: string | null | undefined; body?: string; want: string | null }[] = [
        { name: "neither set", club: undefined, match: undefined, want: null },
        { name: "the club's style reaches the match", club: other, match: undefined, want: other },
        { name: "the match's own style wins", club: other, match: own, want: own },
        { name: "the match's own cleared (null) falls to the club's", club: other, match: null, want: other },
        { name: "the club's cleared (null) falls to the sport's default", club: null, match: undefined, want: null },
        { name: "Go live's own themeId (the panel's pick, still saving) wins over the club's", club: other, match: undefined, body: own, want: own },
      ];
      let checked = 0;
      for (const row of rows) {
        const { r, sid, session } = await goLive(sport, {
          club: row.club === undefined ? undefined : { overlayTemplate: row.club },
          match: row.match === undefined ? undefined : { overlayTemplate: row.match },
          body: row.body === undefined ? undefined : { themeId: row.body },
        });
        expect(session.theme_id, `${sport}: ${row.name}`).toBe(row.want);
        // What every reader resolves, by the panel's own rule — the display and the session cannot disagree.
        const sportKey = await sportOf(r.fixtureId);
        const shown = effectiveTemplateId({ match: row.match === undefined ? row.body ?? null : row.match, club: row.club ?? null, sportKey });
        const facts = await sessionFactsForJob(sid, r.runner.created[0]!.jobToken, r.deps);
        expect(new URL(facts.overlayUrl!).searchParams.get("template"), `${sport}: ${row.name}: the Machine's overlay page`).toBe(shown);
        checked++;
      }
      expect(checked).toBe(rows.length);
    });
  }
});

describe.skipIf(!HAS_DB)("a session COPIES the club's defaults at its start: a later change never moves a running stream; the next stream takes the new value", () => {
  it("club 'bar' + 4.5 s, a session started; the club moves to 'bug' + 0 s mid-session → the running session is unchanged (row, currentSession and job facts)", async () => {
    const { r, sid } = await goLive("generic", { club: { overlayTemplate: "bar", overlayDelayMs: 4500 } });
    expect((await currentSession(r.auth, r.fixtureId, r.deps))?.overlay).toEqual({ themeId: "bar", delayMs: 4500 });
    const moved = await saveOrgStreamDefaults(r.auth, r.auth.orgId, { overlayTemplate: "bug", overlayDelayMs: 0 });
    expect(moved, "premise: the club's defaults moved").toMatchObject({ overlayTemplate: "bug", overlayDelayMs: 0 });
    expect((await currentSession(r.auth, r.fixtureId, r.deps))?.overlay, "the running session never moves").toEqual({ themeId: "bar", delayMs: 4500 });
    expect((await sessionsOf(r.fixtureId))[0], "the row").toMatchObject({ theme_id: "bar", overlay_delay_ms: 4500 });
    const facts = await sessionFactsForJob(sid, r.runner.created[0]!.jobToken, r.deps);
    expect(new URL(facts.overlayUrl!).searchParams.get("template")).toBe("bar");
    expect(new URL(facts.overlayUrl!).searchParams.getAll("delay")).toEqual(["4500"]);
  });

  it("the same org's NEXT stream takes the new defaults (stop the first, start again on the same fixture)", async () => {
    const r = await captureRig({ credits: 3, connectAfterMs: 10 * 60_000 });
    await saveOrgStreamDefaults(r.auth, r.auth.orgId, { overlayTemplate: "bar", overlayDelayMs: 4500 });
    await r.pair(phoneId("a"));
    const first = await createSession(r.auth, r.fixtureId, { mode: "composed", targetId: r.target.id }, r.deps);
    await sql`update fixture_stream_sessions set state = 'completed', end_reason = 'stopped', ended_at = now() where id = ${first.sessionId}`;
    await saveOrgStreamDefaults(r.auth, r.auth.orgId, { overlayTemplate: "bug", overlayDelayMs: 0 });
    await r.pair(phoneId("b"));
    await createSession(r.auth, r.fixtureId, { mode: "composed", targetId: r.target.id }, r.deps);
    const rows = await sessionsOf(r.fixtureId);
    expect(rows.map((s) => [s.theme_id, s.overlay_delay_ms]), "first the old defaults, then the new").toEqual([["bar", 4500], ["bug", 0]]);
  });
});

describe.skipIf(!HAS_DB)("the club's defaults are the CLUB's: another org's session never reads them", () => {
  it("org A sets 'bar' + 4.5 s; org B's session on the same day carries neither; org B's own defaults reach B alone", async () => {
    const a = await captureRig({ credits: 3, connectAfterMs: 10 * 60_000 });
    const b = await captureRig({ credits: 3, connectAfterMs: 10 * 60_000 });
    expect(a.auth.orgId, "premise: two orgs").not.toBe(b.auth.orgId);
    await saveOrgStreamDefaults(a.auth, a.auth.orgId, { overlayTemplate: "bar", overlayDelayMs: 4500 });
    await b.pair(phoneId("b"));
    await createSession(b.auth, b.fixtureId, { mode: "composed", targetId: b.target.id }, b.deps);
    expect((await sessionsOf(b.fixtureId))[0], "B carries nothing of A's").toMatchObject({ theme_id: null, overlay_delay_ms: MATCH_DEFAULT });
    await saveOrgStreamDefaults(b.auth, b.auth.orgId, { overlayDelayMs: 1000 });
    expect((await orgStreamDefaultsOf(a.auth.orgId)).overlayDelayMs, "…and B's save did not touch A's row").toBe(4500);
  });
});

describe.skipIf(!HAS_DB)("the phone's own start and the automatic start take the club's defaults too (the stored-settings paths, no body)", () => {
  function beatBody(r: CaptureRig, phone: string, over: Partial<CaptureBeat> = {}): CaptureBeat {
    return CaptureBeat.parse({
      code: r.code, slot: 0, phone, claim: null, device: null, sid: null, at: r.now().toISOString(), state: "paired",
      cause: null, notReady: null, startFailed: null, stopped: null, mode: "operator", transport: null, bitrateKbps: null,
      delivery: "unknown", deliveredLagS: null, audioOk: null, battery: null, thermal: null, dataUsedMB: null,
      appVersion: "stream-club-style-test/1", ...over,
    });
  }
  it("the phone operator's start: club 'bar' + 4.5 s, the match sets nothing → the session copies both; with the match's own 2.5 s → 2.5 s and the club's style", async () => {
    let checked = 0;
    for (const matchDelay of [undefined, 2500] as const) {
      const r = await captureRig({ credits: 3 });
      const A = phoneId("a");
      await postBeat(r.code, r.tok, beatBody(r, A, { claim: "new" }), r.deps, r.now());
      await saveStreamSettings(r.auth, r.fixtureId, { targetId: r.target.id, ...(matchDelay === undefined ? {} : { overlayDelayMs: matchDelay }) });
      await saveOrgStreamDefaults(r.auth, r.auth.orgId, { overlayTemplate: "bar", overlayDelayMs: 4500 });
      await postStart(r.code, r.tok, { phone: A }, r.deps, r.now());
      expect((await sessionsOf(r.fixtureId))[0], `match ${matchDelay}`).toMatchObject({ mode: "composed", start_cause: "operator", theme_id: "bar", overlay_delay_ms: matchDelay ?? 4500 });
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("the automatic start: club 'bar' + 4.5 s → the session copies both", async () => {
    const r = await captureRig({ credits: 3, connectAfterMs: 10 * 60_000 });
    const A = phoneId("a");
    await postBeat(r.code, r.tok, beatBody(r, A, { claim: "new" }), r.deps, r.now());
    await saveStreamSettings(r.auth, r.fixtureId, { autoStream: true });
    await saveOrgStreamDefaults(r.auth, r.auth.orgId, { overlayTemplate: "bar", overlayDelayMs: 4500 });
    await sql`update fixtures set status = 'in_play' where id = ${r.fixtureId}`;
    await postBeat(r.code, r.tok, beatBody(r, A, { mode: "automatic" }), r.deps, r.now());
    const [s] = await sessionsOf(r.fixtureId);
    expect(s, "the automatic start fired").toMatchObject({ mode: "composed", start_cause: "automatic", theme_id: "bar", overlay_delay_ms: 4500 });
  });
});

describe.skipIf(!HAS_DB)("the phone's descriptor overlayUrl (the page the phone's own view opens) follows the same chain: session's copy ?? match's ?? club's ?? the sport's default", () => {
  it("cricket (own default 'bar'): club 'bug' reaches a match with none; the match's own 'bar' wins over it; a cleared club falls to the sport's default; a session's own copy still wins", async () => {
    const r = await captureRig({ sport: "cricket" });
    const styleOf = async (phone: string | null = null) => new URL((await getCode(r.code, r.tok, { slot: 0, phone }, r.deps, r.now())).overlayUrl!).searchParams.get("style");
    expect(await styleOf(), "nothing set: cricket's default").toBe(defaultTemplateFor("cricket"));
    await saveOrgStreamDefaults(r.auth, r.auth.orgId, { overlayTemplate: "bug" });
    expect(await styleOf(), "the club's style reaches a match with none").toBe("bug");
    await saveStreamSettings(r.auth, r.fixtureId, { overlayTemplate: "bar" });
    expect(await styleOf(), "the match's own wins over the club's").toBe("bar");
    await saveStreamSettings(r.auth, r.fixtureId, { overlayTemplate: null });
    expect(await styleOf(), "the match's cleared: the club's again").toBe("bug");
    await saveOrgStreamDefaults(r.auth, r.auth.orgId, { overlayTemplate: null });
    expect(await styleOf(), "the club's cleared: the sport's default").toBe(defaultTemplateFor("cricket"));
    await saveOrgStreamDefaults(r.auth, r.auth.orgId, { overlayTemplate: "bug" });
    const mine = phoneId("mine");
    const sid = await r.start(mine);
    await sql`update fixture_stream_sessions set theme_id = 'bar' where id = ${sid}`;
    expect(await styleOf(mine), "a running session's own copy wins over the club's").toBe("bar");
  });
});
