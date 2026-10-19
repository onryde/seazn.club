// D16, design §5.6.7 - the deploy step that must run BEFORE V459: scripts/chess-end-shared-meetings.ts ends every shared
// RealtimeKit meeting whose row is still `ended_at is null`, so the delta that drops those rows orphans nothing.
//
// What is under test is the script as it is RUN: the pure sweep (`endSharedMeetings`), the vendor adapter it builds from the
// environment (`vendorFromEnv`), and the CLI (`node --experimental-strip-types`, real exit codes) against
//   - a database holding the PRE-V459 shape of the three video tables (the delta test's replica, _v459-old-shape.ts, in a
//     SCRATCH schema per test - no live table is touched and no live lock is taken), and
//   - the RealtimeKit fixture server (e2e/realtimekit-fixture-server.ts), the vendor the walkthroughs use.
// NEVER against stg or prod; there is no flag here that could point it there.
//
// The seam, not the pieces (AGENTS.md class 1): the delta's own guard RAISES while an unended shared row exists and names this
// script; the test runs the real delta file, lets it refuse, runs the script through its CLI, and runs the delta again.
// Expected values: the vendor sequence is the spec's own ("kick-all, then INACTIVE", §5.6.7) and the adapter's
// (`endMeeting`, realtimekit.ts) - the script is compared with it call for call, never with itself.
// Anti-vacuity: every loop reports how many rows it judged and zero is a failure.
// Single-sport reason: no sport is involved; this is a deploy step over video rows.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { connectionOptions, sql } from "@/lib/db";
import {
  REALTIMEKIT_FIXTURE_ENV,
  startRealtimeKitFixtureServer,
  type RealtimeKitFixtureServer,
} from "../../../../e2e/realtimekit-fixture-server";
import { addParticipant, endMeeting } from "../../external-play/video/realtimekit";
import {
  endSharedMeetings,
  exitCodeOf,
  vendorFromEnv,
  type Report,
  type Vendor,
} from "../../../../../../scripts/chess-end-shared-meetings.ts";
import { OLD_SHAPE, oldShapeStubs } from "./_v459-old-shape";

const HAS_DB = !!process.env.DATABASE_URL;
const REPO = join(import.meta.dirname, "..", "..", "..", "..", "..", "..");
const SCRIPT = join(REPO, "scripts", "chess-end-shared-meetings.ts");
const DELTA = join(REPO, "db", "migration", "deltas", "V459__video_meeting_per_player.sql");
const SECRET = REALTIMEKIT_FIXTURE_ENV.REALTIMEKIT_API_TOKEN;
// A spawn of node plus the postgres import is a second or two on a loaded machine; the CLI tests say so (AGENTS.md class 20:
// a flat timeout beside a derived cost is a latent red - this one is per CLI call, and the heaviest test makes three).
const CLI_MS = 30_000;

type Db = ReturnType<typeof postgres>;

let fx: RealtimeKitFixtureServer;
beforeAll(async () => {
  fx = await startRealtimeKitFixtureServer(0);
});
afterAll(async () => {
  await fx.close();
  await sql.end({ timeout: 2 }).catch(() => undefined);
});
beforeEach(() => {
  fx.reset();
  for (const [k, v] of Object.entries(REALTIMEKIT_FIXTURE_ENV)) vi.stubEnv(k, v);
  vi.stubEnv("REALTIMEKIT_BASE_URL", fx.url);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

// ─── The scratch world ──────────────────────────────────────────────────────────────────────────────────────────────

type Scratch = { db: Db; name: string; orgId: string; personId: string };
const scratches: Scratch[] = [];

/** A fresh schema holding the PRE-V459 shape (and stubs for what its keys point at), with its own one-connection client whose
 *  search path is that schema alone - which is also what `DB_SCHEMA=<name>` gives the CLI. */
async function scratch(): Promise<Scratch> {
  const url = process.env.DATABASE_URL!;
  const [{ live }] = await sql<{ live: string }[]>`select current_schema() as live`;
  const name = `v459s_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  await sql.unsafe(`create schema "${name}"`);
  const db = postgres(url, { max: 1, ssl: connectionOptions(url).ssl, connection: { search_path: name } });
  const s: Scratch = { db, name, orgId: randomUUID(), personId: randomUUID() };
  scratches.push(s);
  await db.unsafe(oldShapeStubs(live, { fixtureIds: [], orgId: s.orgId, personId: s.personId }));
  await db.unsafe(OLD_SHAPE);
  return s;
}

afterEach(async () => {
  while (scratches.length > 0) {
    const s = scratches.pop()!;
    await s.db.end({ timeout: 2 }).catch(() => undefined);
    await sql.unsafe(`drop schema if exists "${s.name}" cascade`);
  }
});

/** A meeting at the vendor, as `ensureMeeting` makes one (POST /meetings). */
async function vendorMeeting(): Promise<string> {
  const res = await fetch(`${fx.url}${fx.kitPath}/meetings`, {
    method: "POST",
    headers: { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" },
    body: JSON.stringify({ title: "seazn-end-shared-meetings" }),
  });
  const body = (await res.json()) as { success: boolean; data: { id: string } };
  expect(body.success, "premise: the fixture made a meeting").toBe(true);
  return body.data.id;
}

type Seeded = { fixtureId: string; meetingId: string; playerParticipant: string; arbiterRowId: string; playerRowId: string };

/** One SHARED pre-V459 board: a meeting row (unended unless `ended`), a player and an arbiter in it at the vendor and in the
 *  database, the player live in the room when `live`. */
async function shared(s: Scratch, o: { ended?: boolean; live?: boolean } = {}): Promise<Seeded> {
  const { db } = s;
  const fixtureId = randomUUID();
  await db`insert into fixtures (id, home_entrant_id, away_entrant_id) values (${fixtureId}, ${randomUUID()}, ${randomUUID()})`;
  const meetingId = await vendorMeeting();
  await db`
    insert into fixture_video_meetings (fixture_id, org_id, meeting_id, home_entrant_id, away_entrant_id, ended_at)
    select ${fixtureId}, ${s.orgId}, ${meetingId}, home_entrant_id, away_entrant_id, ${o.ended ? new Date(Date.now() - 600_000) : null}
      from fixtures where id = ${fixtureId}`;
  const player = await addParticipant({ meetingId, subject: s.personId, preset: "player" });
  const arbiter = await addParticipant({ meetingId, subject: randomUUID(), preset: "arbiter" });
  const [pr] = await db<{ id: string }[]>`
    insert into fixture_video_participants (fixture_id, person_id, preset, participant_id)
    values (${fixtureId}, ${s.personId}, 'player', ${player.participantId}) returning id`;
  const [ar] = await db<{ id: string }[]>`
    insert into fixture_video_participants (fixture_id, preset, participant_id)
    values (${fixtureId}, 'arbiter', ${arbiter.participantId}) returning id`;
  if (o.live) fx.setLivePublisher(player.participantId, true);
  return { fixtureId, meetingId, playerParticipant: player.participantId, arbiterRowId: ar!.id, playerRowId: pr!.id };
}

const endedAt = async (s: Scratch, fixtureId: string): Promise<Date | null> =>
  (await s.db<{ at: Date | null }[]>`select ended_at as at from fixture_video_meetings where fixture_id = ${fixtureId}`)[0]!.at;
const removedAt = async (s: Scratch, rowId: string): Promise<Date | null> =>
  (await s.db<{ at: Date | null }[]>`select removed_at as at from fixture_video_participants where id = ${rowId}`)[0]!.at;

/** The vendor, from the environment the test stubbed - the way the CLI builds its own. */
function realVendor(): Vendor {
  const built = vendorFromEnv({ ...REALTIMEKIT_FIXTURE_ENV, REALTIMEKIT_BASE_URL: fx.url });
  if (!("vendor" in built)) throw new Error("premise: the fixture environment is complete");
  return built.vendor;
}

// ─── The CLI ────────────────────────────────────────────────────────────────────────────────────────────────────────

type Cli = { code: number; out: string };
function cli(s: Scratch | null, args: string[] = [], env: Record<string, string | undefined> = {}): Promise<Cli> {
  // The child gets a clean environment, NOT the runner's (a stray DATABASE_URL must not reach the script): Next's global ProcessEnv
  // wants NODE_ENV, which a child env does not need, hence the cast.
  const childEnv = {} as NodeJS.ProcessEnv;
  childEnv.PATH = process.env.PATH ?? "";
  const put = (k: string, v: string | undefined) => {
    if (v !== undefined) childEnv[k] = v;
  };
  put("DATABASE_URL", process.env.DATABASE_URL);
  put("DATABASE_SSL", process.env.DATABASE_SSL);
  if (s) put("DB_SCHEMA", s.name);
  for (const [k, v] of Object.entries({ ...REALTIMEKIT_FIXTURE_ENV, REALTIMEKIT_BASE_URL: fx.url })) put(k, v);
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete childEnv[k];
    else childEnv[k] = v;
  }
  return new Promise((resolve) => {
    execFile(process.execPath, ["--experimental-strip-types", "--no-warnings", SCRIPT, ...args], { env: childEnv, cwd: REPO }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : -1) : 0;
      resolve({ code, out: `${stdout}\n${stderr}` });
    });
  });
}

const count = (out: string, label: string): number => {
  const m = new RegExp(`^${label}: (\\d+)`, "m").exec(out);
  if (!m) throw new Error(`no "${label}" line in the script's output:\n${out}`);
  return Number(m[1]);
};

describe.skipIf(!HAS_DB)("scripts/chess-end-shared-meetings.ts (V459's deploy step, §5.6.7)", () => {
  it("the script file is where the delta's guard message says it is", () => {
    expect(existsSync(SCRIPT)).toBe(true);
    expect(readFileSync(DELTA, "utf8"), "the delta names the script by its repo path").toContain("scripts/chess-end-shared-meetings.ts");
  });

  describe("the sweep, against the RealtimeKit fixture", () => {
    it("EMPTY case first: no unended shared meeting - found 0, nothing called, clean exit", async () => {
      const s = await scratch();
      // An ENDED row must not count as work either (the empty set of UNENDED rows, not of rows).
      await shared(s, { ended: true });
      fx.calls.length = 0;
      const r = await endSharedMeetings(s.db, realVendor());
      expect(r).toMatchObject({ found: 0, ended: 0, gone: 0, failed: 0, refused: false });
      expect(fx.calls, "no vendor call for no work").toEqual([]);
      expect(exitCodeOf(r)).toBe(0);
    });

    it("ends every unended meeting - kick-all then INACTIVE, each - and ONLY those; the stamps follow; players are untouched", async () => {
      const s = await scratch();
      const live = await shared(s, { live: true });
      const quiet = await shared(s); // nobody in the room: kick-all answers 404 and the deactivate must still happen
      const third = await shared(s, { live: true });
      const alreadyEnded = await shared(s, { ended: true, live: true });
      const endedStamp = await endedAt(s, alreadyEnded.fixtureId);
      expect(fx.liveParticipantIds().length, "premise: three players are live in rooms").toBe(3);
      fx.calls.length = 0;

      const r = await endSharedMeetings(s.db, realVendor());
      expect(r).toMatchObject({ found: 3, ended: 3, gone: 0, failed: 0, refused: false });
      expect(exitCodeOf(r)).toBe(0);

      // The vendor, per meeting: exactly the two calls of the spec, in its order, and none for the row that was already ended.
      let judged = 0;
      for (const m of [live, quiet, third]) {
        const calls = fx.calls.filter((c) => c.path.startsWith(`/meetings/${m.meetingId}`));
        expect(calls.map((c) => c.route), m.meetingId).toEqual(["POST /meetings/:id/active-session/kick-all", "PATCH /meetings/:id"]);
        expect(fx.meetingStatus(m.meetingId), "deactivated: nobody can join it").toBe("INACTIVE");
        expect(fx.sessions(m.meetingId).every((x) => x.status === "ENDED"), "its session is over").toBe(true);
        expect(await endedAt(s, m.fixtureId), "the row says so").not.toBeNull();
        expect(await removedAt(s, m.arbiterRowId), "the arbiter's watch ended with the room").not.toBeNull();
        expect(await removedAt(s, m.playerRowId), "a player's row has no removed_at to stamp").toBeNull();
        judged += 1;
      }
      expect(judged, "anti-vacuity: three meetings judged").toBe(3);
      expect(fx.calls.length, "six calls in all: nothing for the ended row").toBe(6);
      expect(fx.calls.some((c) => c.path.includes(alreadyEnded.meetingId))).toBe(false);
      expect(fx.meetingStatus(alreadyEnded.meetingId), "an ended row's meeting is not this script's to touch").toBe("ACTIVE");
      expect(await endedAt(s, alreadyEnded.fixtureId), "and its stamp is unchanged").toEqual(endedStamp);
      expect(await removedAt(s, alreadyEnded.arbiterRowId)).toBeNull();
      expect(fx.liveParticipantIds(), "only the already-ended room's player is still live").toEqual([alreadyEnded.playerParticipant]);
    });

    it("SECOND run: idempotent - nothing found, nothing called, stamps unchanged", async () => {
      const s = await scratch();
      const a = await shared(s, { live: true });
      const b = await shared(s);
      expect((await endSharedMeetings(s.db, realVendor())).ended).toBe(2);
      const stamps = [await endedAt(s, a.fixtureId), await endedAt(s, b.fixtureId)];
      fx.calls.length = 0;
      const again = await endSharedMeetings(s.db, realVendor());
      expect(again).toMatchObject({ found: 0, ended: 0, failed: 0 });
      expect(fx.calls).toEqual([]);
      expect([await endedAt(s, a.fixtureId), await endedAt(s, b.fixtureId)], "a repeat keeps the first teardown time").toEqual(stamps);
    });

    it("a meeting the vendor no longer has is already ended: stamped and counted as gone (else the guard refuses for ever)", async () => {
      const s = await scratch();
      // Seeded by hand: `shared` mints participants at the vendor, which a meeting the vendor lacks refuses.
      const fixtureId = randomUUID();
      const meetingId = `never-at-the-vendor-${randomUUID()}`;
      await s.db`insert into fixtures (id, home_entrant_id, away_entrant_id) values (${fixtureId}, ${randomUUID()}, ${randomUUID()})`;
      await s.db`
        insert into fixture_video_meetings (fixture_id, org_id, meeting_id, home_entrant_id, away_entrant_id)
        select ${fixtureId}, ${s.orgId}, ${meetingId}, home_entrant_id, away_entrant_id from fixtures where id = ${fixtureId}`;
      const r = await endSharedMeetings(s.db, realVendor());
      expect(r).toMatchObject({ found: 1, ended: 1, gone: 1, failed: 0 });
      expect(await endedAt(s, fixtureId)).not.toBeNull();
    });

    it("a vendor outage fails the row, leaves it UNENDED for the retry, and the retry ends it", async () => {
      const s = await scratch();
      const a = await shared(s, { live: true });
      const b = await shared(s, { live: true });
      fx.setUnavailable(true);
      const down = await endSharedMeetings(s.db, realVendor());
      expect(down).toMatchObject({ found: 2, ended: 0, failed: 2 });
      expect(exitCodeOf(down), "a deploy must stop on a failure").toBe(1);
      expect(down.failures.map((f) => f.meetingId).sort()).toEqual([a.meetingId, b.meetingId].sort());
      expect(await endedAt(s, a.fixtureId), "never stamped ahead of the vendor").toBeNull();
      expect(await endedAt(s, b.fixtureId)).toBeNull();
      expect(await removedAt(s, a.arbiterRowId)).toBeNull();
      fx.setUnavailable(false);
      const retry = await endSharedMeetings(s.db, realVendor());
      expect(retry).toMatchObject({ found: 2, ended: 2, failed: 0 });
      expect(fx.liveParticipantIds(), "and everyone is out").toEqual([]);
    });

    it("one row failing does not stop the rest: each row has its own try (3 rows, the middle one throws)", async () => {
      const s = await scratch();
      const rows = [await shared(s), await shared(s), await shared(s)];
      const order: string[] = [];
      const flaky: Vendor = {
        async endMeeting(id) {
          order.push(id);
          if (id === rows[1]!.meetingId) throw new Error("RealtimeKit PATCH /meetings failed with 429");
          return { gone: false };
        },
      };
      const lines: string[] = [];
      const r = await endSharedMeetings(s.db, flaky, { log: (l) => lines.push(l) });
      expect(order, "every row was tried, once, in creation order").toEqual(rows.map((x) => x.meetingId));
      expect(r).toMatchObject({ found: 3, ended: 2, failed: 1 });
      expect(r.failures).toEqual([{ meetingId: rows[1]!.meetingId, fixtureId: rows[1]!.fixtureId, message: "RealtimeKit PATCH /meetings failed with 429" }]);
      expect(await endedAt(s, rows[0]!.fixtureId)).not.toBeNull();
      expect(await endedAt(s, rows[1]!.fixtureId), "the failed one stays unended").toBeNull();
      expect(await endedAt(s, rows[2]!.fixtureId), "and the one after it was still ended").not.toBeNull();
      expect(lines.filter((l) => l.startsWith("FAILED")).length).toBe(1);
      expect(lines.filter((l) => l.startsWith("ENDED")).length).toBe(2);
    });

    it("a row someone else stamped while the vendor call was in flight keeps ITS first stamp (a repeat never moves a teardown time)", async () => {
      const s = await scratch();
      const a = await shared(s);
      const first = new Date(Date.now() - 3_600_000);
      const racing: Vendor = {
        async endMeeting() {
          await s.db`update fixture_video_meetings set ended_at = ${first} where fixture_id = ${a.fixtureId}`;
          return { gone: false };
        },
      };
      const r = await endSharedMeetings(s.db, racing);
      expect(r).toMatchObject({ found: 1, ended: 1, failed: 0 });
      expect(await endedAt(s, a.fixtureId)).toEqual(first);
      expect(await removedAt(s, a.arbiterRowId), "the arbiter's watch still ends with the room").not.toBeNull();
    });

    it("a DRY run lists the rows and calls and writes nothing", async () => {
      const s = await scratch();
      const a = await shared(s, { live: true });
      const b = await shared(s);
      fx.calls.length = 0;
      const lines: string[] = [];
      const r = await endSharedMeetings(s.db, realVendor(), { dryRun: true, log: (l) => lines.push(l) });
      expect(r).toMatchObject({ found: 2, ended: 0, failed: 0, dryRun: true });
      expect(fx.calls, "no vendor call").toEqual([]);
      expect(lines.filter((l) => l.startsWith("WOULD END")).length).toBe(2);
      expect(await endedAt(s, a.fixtureId)).toBeNull();
      expect(await endedAt(s, b.fixtureId)).toBeNull();
    });

    it("REFUSES once V459 is applied: a row is then one player's live room, and ending 'every unended row' would end games", async () => {
      const s = await scratch();
      await s.db.unsafe(readFileSync(DELTA, "utf8")); // empty table: the guard passes and the delta lands
      const fixtureId = randomUUID();
      await s.db`insert into fixtures (id, home_entrant_id, away_entrant_id) values (${fixtureId}, ${randomUUID()}, ${randomUUID()})`;
      await s.db`
        insert into fixture_video_meetings (fixture_id, side, org_id, meeting_id, home_entrant_id, away_entrant_id)
        select ${fixtureId}, 'home', ${s.orgId}, ${await vendorMeeting()}, home_entrant_id, away_entrant_id from fixtures where id = ${fixtureId}`;
      fx.calls.length = 0;
      const lines: string[] = [];
      const r = await endSharedMeetings(s.db, realVendor(), { log: (l) => lines.push(l) });
      expect(r).toMatchObject({ found: 0, ended: 0, refused: true });
      expect(exitCodeOf(r), "a refusal is not a clean run").toBe(1);
      expect(fx.calls, "the live room was not touched").toEqual([]);
      expect(await endedAt(s, fixtureId)).toBeNull();
      expect(lines.join("\n")).toContain("REFUSED");
      const viaCli = await cli(s);
      expect(viaCli.code).toBe(1);
      expect(fx.calls, "nor by the CLI").toEqual([]);
    }, CLI_MS);
  });

  describe("the vendor adapter the script builds (compared with the app's own endMeeting)", () => {
    const withoutIds = (calls: typeof fx.calls, id: string) =>
      calls.map((c) => ({ route: c.route, body: c.body, path: c.path.replace(id, "<id>") }));

    it("makes the SAME calls as endMeeting, in the same order, for a live room and for a quiet one - and leaves the same state", async () => {
      let judged = 0;
      for (const live of [true, false]) {
        const s = await scratch();
        const viaScript = await shared(s, { live });
        const viaApp = await shared(s, { live });
        fx.calls.length = 0;
        await realVendor().endMeeting(viaScript.meetingId);
        const scriptCalls = withoutIds(fx.calls, viaScript.meetingId);
        fx.calls.length = 0;
        await endMeeting(viaApp.meetingId);
        const appCalls = withoutIds(fx.calls, viaApp.meetingId);
        expect(scriptCalls, `live=${live}`).toEqual(appCalls);
        expect(scriptCalls.map((c) => c.route), "and they are the spec's two").toEqual([
          "POST /meetings/:id/active-session/kick-all",
          "PATCH /meetings/:id",
        ]);
        expect(scriptCalls[1]!.body, "the deactivate").toEqual({ status: "INACTIVE" });
        expect(fx.meetingStatus(viaScript.meetingId)).toBe(fx.meetingStatus(viaApp.meetingId));
        expect(fx.sessions(viaScript.meetingId).map((x) => x.status)).toEqual(fx.sessions(viaApp.meetingId).map((x) => x.status));
        judged += 1;
      }
      expect(judged, "anti-vacuity: both rooms judged").toBe(2);
    });

    // The injected fetch answers per route; the adapter must read RealtimeKit's answers the way endMeeting does.
    const ENV = { CLOUDFLARE_ACCOUNT_ID: "acc", REALTIMEKIT_API_TOKEN: "SECRET-TOKEN-VALUE", REALTIMEKIT_APP_ID: "app", REALTIMEKIT_BASE_URL: "http://rtk.invalid/" };
    const RTK_404 = { success: false, error: { code: 404, message: "nope" } };
    const reply = (status: number, body: unknown = {}) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
    function stubbed(kick: Response | Error, off: Response | Error) {
      const seen: { method: string; url: string }[] = [];
      const doFetch = (async (url: string | URL | Request, init?: RequestInit) => {
        seen.push({ method: init?.method ?? "GET", url: String(url) });
        const answer = seen.length === 1 ? kick : off;
        if (answer instanceof Error) throw answer;
        return answer;
      }) as typeof fetch;
      const built = vendorFromEnv(ENV, doFetch);
      if (!("vendor" in built)) throw new Error("premise: complete env");
      return { vendor: built.vendor, seen };
    }

    it("the kick-all's 404 (nobody in the room) is NOT a failure; the deactivate decides", async () => {
      const t = stubbed(reply(404, RTK_404), reply(200, { success: true, data: {} }));
      expect(await t.vendor.endMeeting("m")).toEqual({ gone: false });
      expect(t.seen.map((x) => x.method)).toEqual(["POST", "PATCH"]);
    });

    it("a kick-all that fails any other way fails the row WITHOUT deactivating (a joinable room must not be reported ended)", async () => {
      const t = stubbed(reply(500), reply(200, { success: true, data: {} }));
      await expect(t.vendor.endMeeting("m")).rejects.toThrow(/kick-all failed with 500/);
      expect(t.seen.length, "the PATCH was never made").toBe(1);
    });

    it("the deactivate's RealtimeKit not-found means gone; any other 404 (a proxy page, a gateway no-route) is an unreadable answer, not 'gone'", async () => {
      expect(await stubbed(reply(200), reply(404, RTK_404)).vendor.endMeeting("m")).toEqual({ gone: true });
      let judged = 0;
      for (const body of ["<html>404</html>", { success: false, errors: [{ code: 7003 }] }, { success: true }, ""]) {
        const t = stubbed(reply(200), reply(404, body));
        await expect(t.vendor.endMeeting("m"), JSON.stringify(body)).rejects.toThrow(/PATCH \/meetings\/m failed with 404/);
        judged += 1;
      }
      expect(judged, "anti-vacuity: four unreadable 404s").toBe(4);
    });

    it("401, 403, 429 and 5xx on the deactivate all fail the row (none is 'gone'); a transport error fails it too", async () => {
      let judged = 0;
      for (const status of [401, 403, 429, 500, 503]) {
        await expect(stubbed(reply(200), reply(status)).vendor.endMeeting("m"), String(status)).rejects.toThrow(new RegExp(`failed with ${status}`));
        judged += 1;
      }
      await expect(stubbed(reply(200), new Error("connect ECONNREFUSED http://user:pw@rtk.invalid")).vendor.endMeeting("m")).rejects.toThrow(/did not complete/);
      expect(judged, "anti-vacuity: five statuses").toBe(5);
    });

    it("no failure message carries the API token, a URL, or a response body (these reach a deploy log)", async () => {
      const attempts: Promise<unknown>[] = [
        stubbed(reply(500, "SECRET-TOKEN-VALUE echoed"), reply(200)).vendor.endMeeting("m"),
        stubbed(reply(200), reply(503, { echo: "SECRET-TOKEN-VALUE" })).vendor.endMeeting("m"),
        stubbed(reply(200), reply(404, "SECRET-TOKEN-VALUE")).vendor.endMeeting("m"),
        stubbed(new Error("ECONNREFUSED http://user:SECRET-TOKEN-VALUE@rtk.invalid"), reply(200)).vendor.endMeeting("m"),
      ];
      const messages = (await Promise.allSettled(attempts)).map((r) => (r.status === "rejected" ? String((r.reason as Error).message) : "FULFILLED"));
      expect(messages.length).toBe(4);
      for (const m of messages) {
        expect(m).not.toBe("FULFILLED");
        expect(m).not.toContain("SECRET-TOKEN-VALUE");
        expect(m).not.toMatch(/https?:\/\//);
      }
    });

    it("a meeting id is path-encoded, and the base's trailing slash does not double", async () => {
      const t = stubbed(reply(200), reply(200));
      await t.vendor.endMeeting("a/b c");
      expect(t.seen.map((x) => x.url)).toEqual([
        "http://rtk.invalid/accounts/acc/realtime/kit/app/meetings/a%2Fb%20c/active-session/kick-all",
        "http://rtk.invalid/accounts/acc/realtime/kit/app/meetings/a%2Fb%20c",
      ]);
    });

    it("names what is missing from the environment - names only, never values", () => {
      let judged = 0;
      for (const [env, missing] of [
        [{}, ["CLOUDFLARE_ACCOUNT_ID", "REALTIMEKIT_API_TOKEN", "REALTIMEKIT_APP_ID"]],
        [{ CLOUDFLARE_ACCOUNT_ID: "x", REALTIMEKIT_APP_ID: "y" }, ["REALTIMEKIT_API_TOKEN"]],
        [{ CLOUDFLARE_ACCOUNT_ID: "", REALTIMEKIT_API_TOKEN: "t", REALTIMEKIT_APP_ID: "y" }, ["CLOUDFLARE_ACCOUNT_ID"]],
      ] as const) {
        const got = vendorFromEnv({ ...env });
        expect("missing" in got ? got.missing : null).toEqual(missing);
        judged += 1;
      }
      expect(judged).toBe(3);
    });

    it("exitCodeOf: 0 for clean and for nothing to do; 1 for a failure and for a refusal", () => {
      const base: Report = { found: 0, ended: 0, gone: 0, failed: 0, failures: [], refused: false, dryRun: false };
      expect(exitCodeOf(base)).toBe(0);
      expect(exitCodeOf({ ...base, found: 2, ended: 2 })).toBe(0);
      expect(exitCodeOf({ ...base, found: 2, ended: 1, failed: 1 })).toBe(1);
      expect(exitCodeOf({ ...base, refused: true })).toBe(1);
    });
  });

  describe("the CLI, as a deploy runs it", () => {
    it("ends the rooms, prints how many it found, ended and failed, and exits 0 - and a second run exits 0 having found none", async () => {
      const s = await scratch();
      const rooms = [await shared(s, { live: true }), await shared(s), await shared(s, { live: true })];
      fx.calls.length = 0;
      const first = await cli(s);
      expect(first.code, first.out).toBe(0);
      expect(count(first.out, "Unended shared meetings found")).toBe(3);
      expect(count(first.out, "Ended")).toBe(3);
      expect(count(first.out, "Failed")).toBe(0);
      let judged = 0;
      for (const r of rooms) {
        expect(fx.meetingStatus(r.meetingId)).toBe("INACTIVE");
        expect(await endedAt(s, r.fixtureId)).not.toBeNull();
        judged += 1;
      }
      expect(judged).toBe(3);
      fx.calls.length = 0;
      const second = await cli(s);
      expect(second.code, second.out).toBe(0);
      expect(count(second.out, "Unended shared meetings found")).toBe(0);
      expect(fx.calls, "safe to run twice: the second run calls nothing").toEqual([]);
    }, CLI_MS);

    it("EMPTY database: found 0, exit 0", async () => {
      const s = await scratch();
      const r = await cli(s);
      expect(r.code, r.out).toBe(0);
      expect(count(r.out, "Unended shared meetings found")).toBe(0);
    }, CLI_MS);

    it("a vendor outage: exit 1, the counts say failed, nothing is stamped, no secret is printed; after the outage it exits 0", async () => {
      const s = await scratch();
      const rooms = [await shared(s, { live: true }), await shared(s)];
      fx.setUnavailable(true);
      const down = await cli(s);
      expect(down.code, down.out).toBe(1);
      expect(count(down.out, "Failed")).toBe(2);
      expect(count(down.out, "Ended")).toBe(0);
      expect(down.out).not.toContain(SECRET);
      for (const r of rooms) expect(await endedAt(s, r.fixtureId), "unended: V459 will keep refusing, as it should").toBeNull();
      fx.setUnavailable(false);
      const up = await cli(s);
      expect(up.code, up.out).toBe(0);
      expect(count(up.out, "Ended")).toBe(2);
      expect(fx.liveParticipantIds()).toEqual([]);
    }, CLI_MS);

    it("--dry-run lists and ends nothing, and needs no RealtimeKit credentials", async () => {
      const s = await scratch();
      const a = await shared(s, { live: true });
      fx.calls.length = 0;
      const r = await cli(s, ["--dry-run"], { CLOUDFLARE_ACCOUNT_ID: undefined, REALTIMEKIT_API_TOKEN: undefined, REALTIMEKIT_APP_ID: undefined });
      expect(r.code, r.out).toBe(0);
      expect(r.out).toContain(`WOULD END: fixture=${a.fixtureId} meeting=${a.meetingId}`);
      expect(count(r.out, "Unended shared meetings found")).toBe(1);
      expect(fx.calls).toEqual([]);
      expect(await endedAt(s, a.fixtureId)).toBeNull();
    }, CLI_MS);

    it("cannot start without DATABASE_URL or without credentials (exit 2), saying which - and touches nothing", async () => {
      const s = await scratch();
      const a = await shared(s);
      fx.calls.length = 0;
      const noDb = await cli(s, [], { DATABASE_URL: undefined });
      expect(noDb.code).toBe(2);
      expect(noDb.out).toContain("DATABASE_URL");
      const noToken = await cli(s, [], { REALTIMEKIT_API_TOKEN: undefined });
      expect(noToken.code).toBe(2);
      expect(noToken.out).toContain("REALTIMEKIT_API_TOKEN");
      expect(noToken.out).not.toContain(SECRET);
      expect(fx.calls).toEqual([]);
      expect(await endedAt(s, a.fixtureId)).toBeNull();
    }, CLI_MS);
  });

  describe("the seam with the delta: the guard refuses, the script clears it, the delta lands", () => {
    it("V459 raises while an unended shared row exists (naming this script), loses nothing; after the script it applies and the rows go", async () => {
      const s = await scratch();
      const rooms = [await shared(s, { live: true }), await shared(s), await shared(s, { ended: true })];
      const delta = readFileSync(DELTA, "utf8");

      const refused = await s.db.unsafe(delta).then(() => null, (e: Error & { code?: string }) => e);
      expect(refused, "the guard raised").not.toBeNull();
      expect(refused!.message).toContain("scripts/chess-end-shared-meetings.ts");
      expect(refused!.message).toContain("2 shared video meeting(s)"); // the two UNENDED rows; the ended one is not counted
      const [{ n }] = await s.db<{ n: number }[]>`select count(*)::int as n from fixture_video_meetings`;
      expect(n, "and nothing was dropped").toBe(3);

      const run = await cli(s);
      expect(run.code, run.out).toBe(0);
      expect(count(run.out, "Ended")).toBe(2);
      expect(rooms.filter((r) => fx.meetingStatus(r.meetingId) === "INACTIVE").length, "two of three are ended at the vendor").toBe(2);

      await s.db.unsafe(delta); // resolves: the guard is satisfied
      const [{ cols }] = await s.db<{ cols: number }[]>`
        select count(*)::int as cols from information_schema.columns
         where table_schema = current_schema() and table_name = 'fixture_video_meetings' and column_name = 'side'`;
      expect(cols, "the delta landed").toBe(1);
      const [{ left }] = await s.db<{ left: number }[]>`select count(*)::int as left from fixture_video_meetings`;
      expect(left, "greenfield: the shared rows are gone").toBe(0);
    }, CLI_MS);
  });
});
