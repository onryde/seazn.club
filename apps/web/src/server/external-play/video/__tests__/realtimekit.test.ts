import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sql } from "@/lib/db";
import { seedOnlineChessFixture } from "@/server/usecases/__tests__/_external-play-seed";
import {
  RealtimeKitDeferred,
  RealtimeKitError,
  addParticipant,
  endMeeting,
  ensureMeeting,
  fetchVideoOffCoverage,
  listMeetingSessions,
  listPeerIds,
  refreshParticipantToken,
  removeParticipant,
  seatCameraEvidence,
} from "../realtimekit";
import { RTK_BUDGET_BURST, budgetKey, takeRealtimeKitCall } from "../budget";

const ENV_KEYS = [
  "CLOUDFLARE_ACCOUNT_ID",
  "REALTIMEKIT_API_TOKEN",
  "REALTIMEKIT_APP_ID",
  "REALTIMEKIT_PLAYER_PRESET",
  "REALTIMEKIT_ARBITER_PRESET",
] as const;

function configure(overrides: Partial<Record<(typeof ENV_KEYS)[number], string>> = {}) {
  const full: Record<string, string> = {
    CLOUDFLARE_ACCOUNT_ID: "acct-1",
    REALTIMEKIT_API_TOKEN: "cf-token-do-not-leak-0123456789",
    REALTIMEKIT_APP_ID: "app-1",
    REALTIMEKIT_PLAYER_PRESET: "seazn_chess_player",
    REALTIMEKIT_ARBITER_PRESET: "seazn_chess_arbiter",
  };
  for (const k of ENV_KEYS) vi.stubEnv(k, overrides[k] ?? full[k]!);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

/** Whether this process is configured, as a PRODUCTION call finds out (`realtimeKitConfigured` had no runtime caller and
 *  was removed, final review M-4): every RealtimeKit call refuses `unconfigured` before any request, or makes its one
 *  request. */
async function configuredByAProductionCall(): Promise<boolean> {
  const stub = stubFetch([{ status: 200, body: { success: true, data: { token: "jwt-probe" } } }]);
  try {
    await refreshParticipantToken({ meetingId: "mtg-probe", participantId: "p-probe" }, { fetch: stub.fetch });
  } catch (e) {
    if ((e as RealtimeKitError).code === "unconfigured" && stub.calls.length === 0) return false;
    throw e;
  }
  expect(stub.calls.length, "a configured call makes its request").toBe(1);
  return true;
}

describe("the five required variables", () => {
  it("sweeps every combination of the five required variables and reports the count", async () => {
    let checked = 0;
    let configured = 0;
    // 2^5 — each variable present or empty. There is NO default for any of
    // them: the POC defaults its preset names, and a preset we did not
    // choose may permit turning the camera off, which is the only
    // enforcement the seat gate has (plan premise P-B2-6).
    for (let mask = 0; mask < 32; mask += 1) {
      const overrides: Record<string, string> = {};
      ENV_KEYS.forEach((k, i) => {
        if ((mask & (1 << i)) !== 0) overrides[k] = "";
      });
      configure(overrides as Partial<Record<(typeof ENV_KEYS)[number], string>>);
      const got = await configuredByAProductionCall();
      expect(got, `mask ${mask}`).toBe(mask === 0);
      if (got) configured += 1;
      checked += 1;
      vi.unstubAllEnvs();
    }
    expect(checked, "anti-vacuity: 2^5 combinations").toBe(32);
    expect(configured, "exactly one combination is fully configured").toBe(1);
  });
});

describe("the API token's name", () => {
  it("is REALTIMEKIT_API_TOKEN: the wrangler deploy secret CLOUDFLARE_API_TOKEN never configures RealtimeKit", async () => {
    // CLOUDFLARE_API_TOKEN is the GitHub Actions secret that deploys the cron
    // worker (prod.yml / stg.yml), with different scopes. One name per
    // credential, so a deploy token can never be pasted into runtime here.
    configure({ REALTIMEKIT_API_TOKEN: "" });
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "wrangler-deploy-token-0123456789");
    expect(await configuredByAProductionCall(), "the old name alone must not configure it").toBe(false);
    // Positive control: the right name, everything else equal, does.
    configure();
    expect(await configuredByAProductionCall()).toBe(true);
  });
});

describe("RealtimeKitError", () => {
  it("carries a status and a code", () => {
    const err = new RealtimeKitError(503, "unavailable", "upstream down");
    expect(err).toBeInstanceOf(Error);
    expect(err.status).toBe(503);
    expect(err.code).toBe("unavailable");
    expect(err.name).toBe("RealtimeKitError");
  });
});

const T = new Date("2026-10-01T12:10:00.000Z");
const seedFixture = () =>
  seedOnlineChessFixture({ onlinePlay: "lichess", divisionStarted: true, scheduledAt: T, linked: true });

/** `fixture_video_meetings.meeting_id` is UNIQUE across the table, and the test
 *  DB is reused between runs — so every meeting id a test stores carries this
 *  run's suffix, or the second run of this file reds on 23505. */
const RUN = randomUUID().slice(0, 8);
const mtg = (name: string) => `mtg-${name}-${RUN}`;

type StubCall = { url: string; method: string; headers: Headers; body: unknown };

/** A stub that answers one JSON body per call, in order, and records every
 *  request. Nothing here touches the network. */
function stubFetch(responses: { status: number; body?: unknown; text?: string }[]) {
  const calls: StubCall[] = [];
  const fn = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const next = responses[calls.length];
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    });
    if (!next) throw new Error(`unexpected RealtimeKit call #${calls.length}: ${String(url)}`);
    // `text` sends a raw, possibly non-JSON body (an HTML error page).
    return new Response(next.text ?? JSON.stringify(next.body), {
      status: next.status,
      headers: { "content-type": next.text === undefined ? "application/json" : "text/html" },
    });
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

describe.skipIf(!process.env.DATABASE_URL)("ensureMeeting", () => {
  it("creates a meeting on the first call and records it", async () => {
    configure();
    const s = await seedFixture();
    const id = mtg("first");
    const stub = stubFetch([{ status: 200, body: { success: true, data: { id } } }]);
    const ref = await ensureMeeting(s.fixtureId, "home", { fetch: stub.fetch });
    expect(ref).toEqual({ meetingId: id });
    expect(stub.calls.length).toBe(1);
    expect(stub.calls[0]?.url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/acct-1/realtime/kit/app-1/meetings",
    );
    expect(stub.calls[0]?.method).toBe("POST");
    expect(stub.calls[0]?.headers.get("authorization")).toBe(
      "Bearer cf-token-do-not-leak-0123456789",
    );
    const [row] = await sql<{ meeting_id: string; org_id: string; ended_at: Date | null }[]>`
      select meeting_id, org_id, ended_at from fixture_video_meetings where fixture_id = ${s.fixtureId}`;
    expect(row?.meeting_id).toBe(id);
    expect(row?.org_id, "the tenant policy needs it").toBe(s.orgId);
    expect(row?.ended_at).toBeNull();
  });

  it("is idempotent: a SECOND call makes no HTTP request at all", async () => {
    configure();
    const s = await seedFixture();
    const id = mtg("second");
    const first = stubFetch([{ status: 200, body: { success: true, data: { id } } }]);
    await ensureMeeting(s.fixtureId, "home", { fetch: first.fetch });
    const second = stubFetch([]); // any call throws
    const again = await ensureMeeting(s.fixtureId, "home", { fetch: second.fetch });
    expect(again).toEqual({ meetingId: id });
    expect(second.calls.length, "the stored meeting is reused").toBe(0);
  });

  it("loses a creation race gracefully: returns the winner's meeting and deactivates its own orphan", async () => {
    configure();
    const s = await seedFixture();
    const winner = mtg("winner");
    const orphan = mtg("orphan");
    // The competing row lands DURING our HTTP call — the real race, driven
    // by giving the stub itself database access rather than by adding a
    // test-only hook to production code.
    let created = false;
    const calls: { url: string; method: string; body: unknown }[] = [];
    const fetchFn = vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({
        url: String(url),
        method: init?.method ?? "GET",
        body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      });
      if (!created) {
        created = true;
        await sql`
          insert into fixture_video_meetings (fixture_id, side, org_id, meeting_id, home_entrant_id, away_entrant_id)
          values (${s.fixtureId}, 'home', ${s.orgId}, ${winner}, (select home_entrant_id from fixtures where id = ${s.fixtureId}), (select away_entrant_id from fixtures where id = ${s.fixtureId}))`;
        return new Response(JSON.stringify({ success: true, data: { id: orphan } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ success: true, data: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const ref = await ensureMeeting(s.fixtureId, "home", { fetch: fetchFn as unknown as typeof fetch });
    expect(ref, "the winner's meeting is what everyone must join").toEqual({ meetingId: winner });
    const [row] = await sql<{ meeting_id: string }[]>`
      select meeting_id from fixture_video_meetings where fixture_id = ${s.fixtureId}`;
    expect(row?.meeting_id).toBe(winner);
    // The orphan is a billable meeting nobody will ever join — deactivate it.
    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch?.url).toContain(`/meetings/${orphan}`);
    expect(patch?.body).toEqual({ status: "INACTIVE" });
  });

  it("an unconfigured process refuses rather than inventing a mock meeting", async () => {
    configure({ REALTIMEKIT_APP_ID: "" });
    const s = await seedFixture();
    const stub = stubFetch([]);
    await expect(ensureMeeting(s.fixtureId, "home", { fetch: stub.fetch })).rejects.toMatchObject({
      name: "RealtimeKitError",
      code: "unconfigured",
    });
    expect(stub.calls.length).toBe(0);
  });

  // fixture_id is the table's PRIMARY KEY, so an ended meeting still occupies
  // the fixture's only row. Without this refusal the insert below conflicts,
  // the "lost race" branch deactivates a brand-new billable meeting, and the
  // caller is handed the ENDED (INACTIVE, unjoinable) meeting as if it were
  // live. A fixture's meeting is torn down at the result or at the deadline (spec
  // §5.2); there is nothing left to join after that.
  it("after teardown: refuses with 409 and makes NO HTTP call (no billable orphan)", async () => {
    configure();
    const s = await seedFixture();
    const ended = mtg("ended");
    await sql`
      insert into fixture_video_meetings (fixture_id, side, org_id, meeting_id, ended_at, home_entrant_id, away_entrant_id)
      values (${s.fixtureId}, 'home', ${s.orgId}, ${ended}, now(), (select home_entrant_id from fixtures where id = ${s.fixtureId}), (select away_entrant_id from fixtures where id = ${s.fixtureId}))`;
    // Positive control: the stub WOULD hand out a fresh meeting if asked, so
    // the zero-call assertion below is a decision, not a stub that refused.
    const stub = stubFetch([
      { status: 200, body: { success: true, data: { id: mtg("would-be-orphan") } } },
      { status: 200, body: { success: true, data: {} } },
    ]);
    await expect(ensureMeeting(s.fixtureId, "home", { fetch: stub.fetch })).rejects.toMatchObject({
      status: 409,
      code: "VIDEO_MEETING_ENDED",
    });
    expect(stub.calls.length, "no meeting is created for an ended fixture").toBe(0);
  });

  it("a race whose winning row is already ENDED refuses too, after standing its own orphan down", async () => {
    configure();
    const s = await seedFixture();
    const orphan = mtg("orphan-2");
    let created = false;
    const calls: { method: string; url: string; body: unknown }[] = [];
    const fetchFn = vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({
        url: String(url),
        method: init?.method ?? "GET",
        body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      });
      if (!created) {
        created = true;
        // Created AND torn down while our POST was in flight.
        await sql`
          insert into fixture_video_meetings (fixture_id, side, org_id, meeting_id, ended_at, home_entrant_id, away_entrant_id)
          values (${s.fixtureId}, 'home', ${s.orgId}, ${mtg("ended-winner")}, now(), (select home_entrant_id from fixtures where id = ${s.fixtureId}), (select away_entrant_id from fixtures where id = ${s.fixtureId}))`;
        return new Response(JSON.stringify({ success: true, data: { id: orphan } }), { status: 200 });
      }
      return new Response(JSON.stringify({ success: true, data: {} }), { status: 200 });
    });
    await expect(
      ensureMeeting(s.fixtureId, "home", { fetch: fetchFn as unknown as typeof fetch }),
    ).rejects.toMatchObject({ status: 409, code: "VIDEO_MEETING_ENDED" });
    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch?.url, "our own meeting is still stood down").toContain(`/meetings/${orphan}`);
    expect(patch?.body).toEqual({ status: "INACTIVE" });
  });
});

// ─── D16 (§5.6.1): a meeting per PLAYER — (fixture, side) ────────────────────────────────────────────────────────────
describe.skipIf(!process.env.DATABASE_URL)("ensureMeeting, per player (D16)", () => {
  const SIDES = ["home", "away"] as const;
  const created = (id: string) => ({ status: 200, body: { success: true, data: { id } } });
  const rowsOf = async (fixtureId: string) =>
    sql<{ side: string; meeting_id: string; ended_at: Date | null }[]>`
      select side, meeting_id, ended_at from fixture_video_meetings where fixture_id = ${fixtureId} order by side`;

  it("each side's first call makes ITS OWN meeting: two vendor creates, two rows, two distinct ids, the side in the vendor title — counted per side", async () => {
    configure();
    const s = await seedFixture();
    const ids = new Map<string, string>();
    let checked = 0;
    for (const side of SIDES) {
      const id = mtg(`own-${side}`);
      const stub = stubFetch([created(id)]);
      expect(await ensureMeeting(s.fixtureId, side, { fetch: stub.fetch }), side).toEqual({ meetingId: id });
      expect(stub.calls.length, `${side}: exactly one create`).toBe(1);
      expect(stub.calls[0]!.body, `${side}: the title names the fixture and the side`).toEqual({ title: `seazn-fixture-${s.fixtureId}-${side}` });
      ids.set(side, id);
      checked += 1;
    }
    expect(checked, "anti-vacuity: both sides").toBe(SIDES.length);
    expect(new Set(ids.values()).size, "two different vendor rooms").toBe(2);
    const rows = await rowsOf(s.fixtureId);
    expect(Object.fromEntries(rows.map((r) => [r.side, r.meeting_id])), "each side's row holds its own vendor room").toEqual(Object.fromEntries(ids));
  });

  it("SEQUENCE: a second call on EACH side makes no HTTP request, and the other side's meeting is never handed out in its place", async () => {
    configure();
    const s = await seedFixture();
    const idOf = { home: mtg("seq-home"), away: mtg("seq-away") };
    for (const side of SIDES) await ensureMeeting(s.fixtureId, side, { fetch: stubFetch([created(idOf[side])]).fetch });
    let checked = 0;
    for (const side of SIDES) {
      const none = stubFetch([]);
      expect(await ensureMeeting(s.fixtureId, side, { fetch: none.fetch }), side).toEqual({ meetingId: idOf[side] });
      expect(none.calls.length, `${side}: the stored meeting is reused`).toBe(0);
      checked += 1;
    }
    expect(checked).toBe(SIDES.length);
    expect((await rowsOf(s.fixtureId)).length, "still two rows").toBe(2);
  });

  it("a side whose meeting has ENDED stays ended (409) and the other side is untouched: it still joins, and a side with no row still creates — counted", async () => {
    configure();
    const s = await seedFixture();
    const homeId = mtg("half-home");
    const awayId = mtg("half-away");
    await ensureMeeting(s.fixtureId, "home", { fetch: stubFetch([created(homeId)]).fetch });
    await ensureMeeting(s.fixtureId, "away", { fetch: stubFetch([created(awayId)]).fetch });
    await sql`update fixture_video_meetings set ended_at = now() where fixture_id = ${s.fixtureId} and side = 'home'`;
    const refused = stubFetch([created(mtg("half-orphan")), { status: 200, body: { success: true, data: {} } }]);
    await expect(ensureMeeting(s.fixtureId, "home", { fetch: refused.fetch })).rejects.toMatchObject({ status: 409, code: "VIDEO_MEETING_ENDED" });
    expect(refused.calls.length, "the ended side makes no vendor call").toBe(0);
    const none = stubFetch([]);
    expect(await ensureMeeting(s.fixtureId, "away", { fetch: none.fetch }), "the live side is unaffected").toEqual({ meetingId: awayId });
    expect(none.calls.length).toBe(0);
    // And the pair of the half-ended board: a fixture with only 'home' on file creates 'away' on its first call.
    const t = await seedFixture();
    await ensureMeeting(t.fixtureId, "home", { fetch: stubFetch([created(mtg("only-home"))]).fetch });
    await sql`update fixture_video_meetings set ended_at = now() where fixture_id = ${t.fixtureId}`;
    const fresh = stubFetch([created(mtg("late-away"))]);
    expect(await ensureMeeting(t.fixtureId, "away", { fetch: fresh.fetch }), "an ended home does not block away").toEqual({ meetingId: mtg("late-away") });
    expect(fresh.calls.length).toBe(1);
  });

  it("loses a creation race on ONE side: returns that side's winner, stands its own orphan down, and leaves the other side's row alone", async () => {
    configure();
    const s = await seedFixture();
    const homeId = mtg("race-home");
    await ensureMeeting(s.fixtureId, "home", { fetch: stubFetch([created(homeId)]).fetch });
    const winner = mtg("race-away-winner");
    const orphan = mtg("race-away-orphan");
    let raced = false;
    const calls: { method: string; url: string; body: unknown }[] = [];
    const fetchFn = vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ method: init?.method ?? "GET", url: String(url), body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
      if (!raced) {
        raced = true;
        await sql`
          insert into fixture_video_meetings (fixture_id, side, org_id, meeting_id, home_entrant_id, away_entrant_id)
          values (${s.fixtureId}, 'away', ${s.orgId}, ${winner}, (select home_entrant_id from fixtures where id = ${s.fixtureId}), (select away_entrant_id from fixtures where id = ${s.fixtureId}))`;
        return new Response(JSON.stringify(created(orphan).body), { status: 200 });
      }
      return new Response(JSON.stringify({ success: true, data: {} }), { status: 200 });
    });
    const ref = await ensureMeeting(s.fixtureId, "away", { fetch: fetchFn as unknown as typeof fetch });
    expect(ref, "the away winner, never home's meeting").toEqual({ meetingId: winner });
    expect(calls.find((c) => c.method === "PATCH")?.url).toContain(`/meetings/${orphan}`);
    expect((await rowsOf(s.fixtureId)).map((r) => [r.side, r.meeting_id])).toEqual([["away", winner], ["home", homeId]]);
  });

  it("a re-pair retires EVERY stale row of the board and ends each room at the vendor, not just the first; the asking side then gets a fresh meeting", async () => {
    configure();
    const s = await seedFixture();
    const idOf = { home: mtg("stale-home"), away: mtg("stale-away") };
    for (const side of SIDES) await ensureMeeting(s.fixtureId, side, { fetch: stubFetch([created(idOf[side])]).fetch });
    // Both rows were made for another pair: the stamp names the home entrant on both sides.
    await sql`update fixture_video_meetings m set away_entrant_id = f.home_entrant_id from fixtures f where f.id = m.fixture_id and m.fixture_id = ${s.fixtureId}`;
    const fresh = mtg("stale-fresh");
    const stub = stubFetch([
      { status: 200, body: { success: true, data: { action: "kick" } } }, { status: 200, body: { success: true, data: {} } },
      { status: 200, body: { success: true, data: { action: "kick" } } }, { status: 200, body: { success: true, data: {} } },
      created(fresh),
    ]);
    expect(await ensureMeeting(s.fixtureId, "away", { fetch: stub.fetch })).toEqual({ meetingId: fresh });
    const route = (u: string) => u.split("/realtime/kit/app-1")[1];
    const ended = stub.calls.filter((c) => c.method === "PATCH").map((c) => route(c.url));
    expect(new Set(ended), "both stale rooms were ended at the vendor").toEqual(new Set([`/meetings/${idOf.home}`, `/meetings/${idOf.away}`]));
    expect(stub.calls.filter((c) => c.url.endsWith("/kick-all")).length, "each room kicked").toBe(2);
    expect((await rowsOf(s.fixtureId)).map((r) => [r.side, r.meeting_id]), "only the asking side was remade; home re-seats on its own first arrival").toEqual([["away", fresh]]);
  });

  it("a re-pair retires the OTHER side's stale room even when the asking side has no row yet (R3-1 unchanged): the newcomer's first claim ends the stayer's old room", async () => {
    configure();
    const s = await seedFixture();
    const stayerRoom = mtg("stayer-old-home");
    await ensureMeeting(s.fixtureId, "home", { fetch: stubFetch([created(stayerRoom)]).fetch });
    // The board is re-paired: the stayer's room was made for the OLD pair (the stamp no longer matches the fixture), and the
    // newcomer arrives on the OTHER side, where nothing is on file.
    await sql`update fixture_video_meetings m set away_entrant_id = f.home_entrant_id from fixtures f where f.id = m.fixture_id and m.fixture_id = ${s.fixtureId}`;
    expect((await rowsOf(s.fixtureId)).map((r) => r.side), "premise: only the stayer's side is on file").toEqual(["home"]);
    const fresh = mtg("newcomer-fresh");
    const stub = stubFetch([
      { status: 200, body: { success: true, data: { action: "kick" } } }, { status: 200, body: { success: true, data: {} } },
      created(fresh),
    ]);
    expect(await ensureMeeting(s.fixtureId, "away", { fetch: stub.fetch })).toEqual({ meetingId: fresh });
    const route = (u: string) => u.split("/realtime/kit/app-1")[1];
    expect(stub.calls.filter((c) => c.method === "PATCH").map((c) => route(c.url)), "the stayer's stale room was ended at the vendor").toEqual([`/meetings/${stayerRoom}`]);
    expect(stub.calls.filter((c) => c.url.endsWith("/kick-all")).length, "…and kicked").toBe(1);
    expect((await rowsOf(s.fixtureId)).map((r) => [r.side, r.meeting_id]), "only the newcomer's own room is on file").toEqual([["away", fresh]]);
    // The pair: with nothing stale (the same board, both sides current) the first claim of the other side retires nothing.
    const t = await seedFixture();
    const keep = mtg("keep-home");
    await ensureMeeting(t.fixtureId, "home", { fetch: stubFetch([created(keep)]).fetch });
    const calm = stubFetch([created(mtg("calm-away"))]);
    await ensureMeeting(t.fixtureId, "away", { fetch: calm.fetch });
    expect(calm.calls.map((c) => c.method), "no stale room, so the claim only creates").toEqual(["POST"]);
    expect((await rowsOf(t.fixtureId)).map((r) => r.side), "and the current room is untouched").toEqual(["away", "home"]);
  });

  // D16 review G1: retire used to DELETE the row and only then end the room at the vendor, so a deferred or failed end left an
  // ACTIVE room (the old pair's tokens still live in it) that nothing tracked. Now the room is ended FIRST and the row goes
  // only after the end has succeeded; a refusal keeps the row (the sweep and the next claim retry it) and fails the claim, as the
  // create that would have followed it would have failed too.
  describe("G1: a stale room is ended at the vendor BEFORE its row is deleted", () => {
    const staleHome = async (name: string) => {
      const s = await seedFixture();
      const room = mtg(name);
      await ensureMeeting(s.fixtureId, "home", { fetch: stubFetch([created(room)]).fetch });
      // The board was re-paired: the home room was made for the OLD pair; the newcomer arrives on away, where nothing is on file.
      await sql`update fixture_video_meetings m set away_entrant_id = f.home_entrant_id from fixtures f where f.id = m.fixture_id and m.fixture_id = ${s.fixtureId}`;
      expect((await rowsOf(s.fixtureId)).map((r) => r.side), "premise: only the stayer's stale row is on file").toEqual(["home"]);
      return { s, room };
    };
    /** A vendor that answers every call 200 except a PATCH on a room in `patchFails` (503) or `patchGone` (RealtimeKit's own not-found). */
    const vendor = (
      fresh: string,
      patchFails: ReadonlySet<string> = new Set(),
      patchGone: ReadonlySet<string> = new Set(),
      patchRefused: ReadonlySet<string> = new Set(),
    ) => {
      const calls: { method: string; path: string }[] = [];
      const fn = vi.fn(async (url: string | URL, init?: RequestInit) => {
        const path = String(url).split("/realtime/kit/app-1")[1]!;
        const method = init?.method ?? "GET";
        calls.push({ method, path });
        if (method === "PATCH" && patchFails.has(path.replace("/meetings/", ""))) return new Response("{}", { status: 503 });
        if (method === "PATCH" && patchRefused.has(path.replace("/meetings/", ""))) return new Response("{}", { status: 401 });
        if (method === "PATCH" && patchGone.has(path.replace("/meetings/", ""))) {
          return new Response(JSON.stringify({ success: false, error: { code: 404, message: "Meeting not found" } }), { status: 404 });
        }
        if (method === "POST" && path === "/meetings") return new Response(JSON.stringify(created(fresh).body), { status: 200 });
        return new Response(JSON.stringify({ success: true, data: {} }), { status: 200 });
      });
      return { fetch: fn as unknown as typeof fetch, calls };
    };
    const ends = (calls: { method: string; path: string }[]) => calls.filter((c) => c.method === "PATCH").map((c) => c.path.replace("/meetings/", ""));

    it("a FAILED end keeps the row (unended, still tracked) and fails the claim: no new meeting is made; the next claim ends the room, deletes the row, and creates", async () => {
      configure();
      const { s, room } = await staleHome("g1-fail-home");
      const fresh = mtg("g1-fail-fresh");
      const down = vendor(fresh, new Set([room]));
      await expect(ensureMeeting(s.fixtureId, "away", { fetch: down.fetch })).rejects.toMatchObject({ name: "RealtimeKitError", code: "unavailable" });
      expect(ends(down.calls), "the end was tried").toEqual([room]);
      expect(down.calls.some((c) => c.method === "POST" && c.path === "/meetings"), "and no new room was made on top of it").toBe(false);
      const kept = await rowsOf(s.fixtureId);
      expect(kept.map((r) => [r.side, r.meeting_id, r.ended_at]), "the row survives, unended: the room is still ACTIVE upstream and still tracked").toEqual([["home", room, null]]);
      // The pair: the vendor back, the same claim ends the room, deletes the row, and creates.
      const up = vendor(fresh);
      expect(await ensureMeeting(s.fixtureId, "away", { fetch: up.fetch })).toEqual({ meetingId: fresh });
      expect(ends(up.calls)).toEqual([room]);
      expect((await rowsOf(s.fixtureId)).map((r) => [r.side, r.meeting_id]), "only after the end succeeded did the row go").toEqual([["away", fresh]]);
    });

    it("a DEFERRED end (the platform's call budget is spent) makes no request, keeps the row, and fails the claim as a deferral - never as a failure; with the budget back it goes through", async () => {
      configure();
      const { s, room } = await staleHome("g1-defer-home");
      const fresh = mtg("g1-defer-fresh");
      const spent = vendor(fresh);
      await expect(ensureMeeting(s.fixtureId, "away", { fetch: spent.fetch, budget: async () => false })).rejects.toBeInstanceOf(RealtimeKitDeferred);
      expect(spent.calls, "no request was made").toEqual([]);
      expect((await rowsOf(s.fixtureId)).map((r) => [r.side, r.meeting_id, r.ended_at]), "the row survives").toEqual([["home", room, null]]);
      const back = vendor(fresh);
      expect(await ensureMeeting(s.fixtureId, "away", { fetch: back.fetch, budget: async () => true })).toEqual({ meetingId: fresh });
      expect(ends(back.calls)).toEqual([room]);
      expect((await rowsOf(s.fixtureId)).map((r) => [r.side, r.meeting_id])).toEqual([["away", fresh]]);
    });

    it("two stale rows, ONE end fails: the room that ended is deleted, the one that did not is kept - each row on its own outcome - and the claim fails", async () => {
      configure();
      const s = await seedFixture();
      const idOf = { home: mtg("g1-two-home"), away: mtg("g1-two-away") };
      for (const side of SIDES) await ensureMeeting(s.fixtureId, side, { fetch: stubFetch([created(idOf[side])]).fetch });
      await sql`update fixture_video_meetings m set away_entrant_id = f.home_entrant_id from fixtures f where f.id = m.fixture_id and m.fixture_id = ${s.fixtureId}`;
      const fresh = mtg("g1-two-fresh");
      const v = vendor(fresh, new Set([idOf.away]));
      await expect(ensureMeeting(s.fixtureId, "away", { fetch: v.fetch })).rejects.toMatchObject({ code: "unavailable" });
      expect(new Set(ends(v.calls)), "both ends were tried: a failure on one does not skip the other").toEqual(new Set([idOf.home, idOf.away]));
      expect((await rowsOf(s.fixtureId)).map((r) => [r.side, r.meeting_id, r.ended_at]), "home's room ended, so its row is gone; away's did not, so its row stays").toEqual([["away", idOf.away, null]]);
    });

    it("two stale rows and BOTH ends fail: both rows are kept, and the claim fails with the FIRST refusal (side order), not the last", async () => {
      configure();
      const s = await seedFixture();
      const idOf = { home: mtg("g1-both-home"), away: mtg("g1-both-away") };
      for (const side of SIDES) await ensureMeeting(s.fixtureId, side, { fetch: stubFetch([created(idOf[side])]).fetch });
      await sql`update fixture_video_meetings m set away_entrant_id = f.home_entrant_id from fixtures f where f.id = m.fixture_id and m.fixture_id = ${s.fixtureId}`;
      // away is tried first (side order) and is refused as `unavailable`; home is tried second and is refused as `unauthorized`.
      const v = vendor(mtg("g1-both-fresh"), new Set([idOf.away]), new Set(), new Set([idOf.home]));
      await expect(ensureMeeting(s.fixtureId, "away", { fetch: v.fetch })).rejects.toMatchObject({ code: "unavailable" });
      expect(new Set(ends(v.calls)), "both were tried").toEqual(new Set([idOf.home, idOf.away]));
      expect((await rowsOf(s.fixtureId)).map((r) => r.side), "both rows kept: neither room is known to be ended").toEqual(["away", "home"]);
    });

    it("a stale row whose room is already ENDED needs no vendor call: its row is deleted and the claim goes on", async () => {
      configure();
      const { s, room } = await staleHome("g1-ended-home");
      await sql`update fixture_video_meetings set ended_at = now() where meeting_id = ${room}`;
      const fresh = mtg("g1-ended-fresh");
      const v = vendor(fresh);
      expect(await ensureMeeting(s.fixtureId, "away", { fetch: v.fetch })).toEqual({ meetingId: fresh });
      expect(v.calls.map((c) => `${c.method} ${c.path}`), "only the create: the ended room is not asked again").toEqual(["POST /meetings"]);
      expect((await rowsOf(s.fixtureId)).map((r) => [r.side, r.meeting_id])).toEqual([["away", fresh]]);
    });

    it("a room RealtimeKit itself says is not there (its documented not-found) is already gone: the row is deleted and the claim goes on", async () => {
      configure();
      const { s, room } = await staleHome("g1-gone-home");
      const fresh = mtg("g1-gone-fresh");
      const v = vendor(fresh, new Set(), new Set([room]));
      expect(await ensureMeeting(s.fixtureId, "away", { fetch: v.fetch })).toEqual({ meetingId: fresh });
      expect((await rowsOf(s.fixtureId)).map((r) => [r.side, r.meeting_id])).toEqual([["away", fresh]]);
    });
  });
});

describe("addParticipant", () => {
  it("maps the player preset, sends the subject as the custom id, and returns id + token", async () => {
    configure();
    const stub = stubFetch([
      { status: 201, body: { success: true, data: { id: "p-1", token: "jwt-participant-1" } } },
    ]);
    const out = await addParticipant(
      { meetingId: "mtg-1", subject: "person-abc", preset: "player" },
      { fetch: stub.fetch },
    );
    expect(out).toEqual({ participantId: "p-1", authToken: "jwt-participant-1" });
    expect(Object.keys(out).sort(), "exactly the two declared keys").toEqual([
      "authToken",
      "participantId",
    ]);
    expect(stub.calls[0]?.url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/acct-1/realtime/kit/app-1/meetings/mtg-1/participants",
    );
    expect(stub.calls[0]?.method).toBe("POST");
    expect(stub.calls[0]?.body).toEqual({
      custom_participant_id: "person-abc",
      preset_name: "seazn_chess_player",
    });
  });

  it("maps the arbiter preset to its own env value, never the player's", async () => {
    configure();
    const stub = stubFetch([
      { status: 201, body: { success: true, data: { id: "p-2", token: "jwt-participant-2" } } },
    ]);
    await addParticipant(
      { meetingId: "mtg-1", subject: "person-arb", preset: "arbiter" },
      { fetch: stub.fetch },
    );
    expect((stub.calls[0]?.body as { preset_name: string }).preset_name).toBe("seazn_chess_arbiter");
  });

  it("sweeps both presets and reports the count", async () => {
    configure();
    const presets: ("player" | "arbiter")[] = ["player", "arbiter"];
    const seen = new Set<string>();
    let checked = 0;
    for (const preset of presets) {
      const stub = stubFetch([
        { status: 201, body: { success: true, data: { id: `p-${preset}`, token: `jwt-${preset}` } } },
      ]);
      await addParticipant({ meetingId: "mtg-1", subject: "s", preset }, { fetch: stub.fetch });
      seen.add((stub.calls[0]?.body as { preset_name: string }).preset_name);
      checked += 1;
    }
    expect(checked, "anti-vacuity: every preset in the union").toBe(2);
    expect(seen.size, "the two presets must not collapse onto one value").toBe(2);
  });

  it("never puts an auth token into an error message or a log line, on ANY failure branch", async () => {
    configure();
    const API_TOKEN = "cf-token-do-not-leak-0123456789";
    const PARTICIPANT_TOKEN = "jwt-participant-do-not-leak-98765";
    // Positive control first, so the negatives below cannot be vacuous.
    expect(API_TOKEN.length, "premise: the token is a real, long string").toBeGreaterThan(20);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    // A RealtimeKit failure body that ECHOES both tokens back at us — the
    // shape that turns a naive `JSON.stringify(body)` message into a leak.
    const echo = {
      success: false,
      error: { message: `bad token ${API_TOKEN}`, echoed: PARTICIPANT_TOKEN },
    };
    // One case per throw site in the request helper. A single 401 is NOT
    // enough: the credentials branch throws before the body is read, so a
    // leak added to the generic non-ok branch survived a 401-only test
    // (measured — the brief's own Step 13 mutant stayed green).
    const cases: { name: string; fetch: typeof fetch; code: string }[] = [
      ...[400, 401, 403, 404, 429, 500, 502].map((status) => ({
        name: `HTTP ${status}`,
        // RealtimeKit's error shape carries the status as error.code — a 404
        // in that shape is its "not found"; the body is read on that branch.
        fetch: stubFetch([{ status, body: { ...echo, error: { ...echo.error, code: status } } }]).fetch,
        code: status === 404 ? "not_found" : status === 401 || status === 403 ? "unauthorized" : "unavailable",
      })),
      {
        name: "HTTP 404 that is NOT RealtimeKit's shape, echoing the token",
        fetch: stubFetch([{ status: 404, body: { success: false, errors: [{ message: `bad token ${API_TOKEN}` }] } }]).fetch,
        code: "unavailable",
      },
      {
        name: "HTTP 200 whose unreadable body echoes the token",
        fetch: stubFetch([{ status: 200, text: `<html>${API_TOKEN} ${PARTICIPANT_TOKEN}</html>` }]).fetch,
        code: "unavailable",
      },
      {
        name: "HTTP 200 with no data, echoing the token elsewhere",
        fetch: stubFetch([{ status: 200, body: { success: true, note: `${API_TOKEN} ${PARTICIPANT_TOKEN}` } }]).fetch,
        code: "unavailable",
      },
      {
        name: "HTTP 200 with success:false",
        fetch: stubFetch([{ status: 200, body: echo }]).fetch,
        code: "unavailable",
      },
      {
        name: "transport failure whose error text echoes the token",
        fetch: (async () => {
          throw new Error(`connect ECONNRESET ${API_TOKEN} ${PARTICIPANT_TOKEN}`);
        }) as unknown as typeof fetch,
        code: "unavailable",
      },
    ];
    let checked = 0;
    const codes = new Set<string>();
    for (const c of cases) {
      let caught: unknown;
      try {
        await addParticipant(
          { meetingId: "mtg-1", subject: "person-abc", preset: "player" },
          { fetch: c.fetch },
        );
      } catch (err) {
        caught = err;
      }
      expect(caught, `${c.name}: premise — it did throw`).toBeInstanceOf(RealtimeKitError);
      const err = caught as RealtimeKitError;
      expect(err.code, c.name).toBe(c.code);
      codes.add(err.code);
      // Positive control: the message is informative about WHAT failed.
      expect(err.message, c.name).toContain("participants");
      // The negatives.
      expect(err.message, c.name).not.toContain(API_TOKEN);
      expect(err.message, c.name).not.toContain(PARTICIPANT_TOKEN);
      expect(err.stack ?? "", c.name).not.toContain(API_TOKEN);
      expect(err.stack ?? "", c.name).not.toContain(PARTICIPANT_TOKEN);
      expect(JSON.stringify(err), c.name).not.toContain(API_TOKEN);
      checked += 1;
    }
    expect(checked, "anti-vacuity: every failure branch").toBe(cases.length);
    expect(checked).toBeGreaterThanOrEqual(12);
    expect([...codes].sort(), "every non-config error code was reached").toEqual([
      "not_found",
      "unauthorized",
      "unavailable",
    ]);
    const logged = [...errSpy.mock.calls, ...warnSpy.mock.calls, ...logSpy.mock.calls]
      .flat()
      .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
      .join("\n");
    expect(logged).not.toContain(API_TOKEN);
    expect(logged).not.toContain(PARTICIPANT_TOKEN);
    errSpy.mockRestore();
    warnSpy.mockRestore();
    logSpy.mockRestore();
  });

  it("a response with no token is a 502, not a participant with an empty token", async () => {
    configure();
    const stub = stubFetch([{ status: 201, body: { success: true, data: { id: "p-3" } } }]);
    await expect(
      addParticipant({ meetingId: "mtg-1", subject: "s", preset: "player" }, { fetch: stub.fetch }),
    ).rejects.toMatchObject({ name: "RealtimeKitError", status: 502 });
  });
});

describe("refreshParticipantToken", () => {
  // A returning player keeps ONE participant (so peer discovery stays on one
  // user_id) and gets a regenerated token for it. Measured 2026-10-09
  // (rtk-token-regen.log): the regenerated token is a different JWT and the
  // earlier one keeps working.
  it("POSTs to the participant's token endpoint and returns the same participant with the new token", async () => {
    configure();
    const stub = stubFetch([{ status: 200, body: { success: true, data: { token: "jwt-regenerated-2" } } }]);
    const out = await refreshParticipantToken({ meetingId: "mtg/1", participantId: "p 1" }, { fetch: stub.fetch });
    expect(out).toEqual({ participantId: "p 1", authToken: "jwt-regenerated-2" });
    expect(stub.calls.length).toBe(1);
    expect(stub.calls[0]?.method).toBe("POST");
    expect(stub.calls[0]?.url, "both ids are path-encoded").toBe(
      "https://api.cloudflare.com/client/v4/accounts/acct-1/realtime/kit/app-1/meetings/mtg%2F1/participants/p%201/token",
    );
    expect(stub.calls[0]?.headers.get("authorization")).toBe("Bearer cf-token-do-not-leak-0123456789");
  });

  it("a response with no token (or an empty one) is a 502, never a participant with an empty token", async () => {
    configure();
    let checked = 0;
    for (const data of [{}, { token: "" }, { token: 42 }]) {
      const stub = stubFetch([{ status: 200, body: { success: true, data } }]);
      await expect(
        refreshParticipantToken({ meetingId: "mtg-1", participantId: "p-1" }, { fetch: stub.fetch }),
        JSON.stringify(data),
      ).rejects.toMatchObject({ name: "RealtimeKitError", status: 502, code: "unavailable" });
      checked += 1;
    }
    expect(checked, "anti-vacuity: three tokenless shapes").toBe(3);
  });

  it("RealtimeKit's own 404 (participant gone) is not_found; an outage is unavailable", async () => {
    configure();
    const gone = stubFetch([{ status: 404, body: { success: false, error: { code: 404, message: "no such participant" } } }]);
    await expect(
      refreshParticipantToken({ meetingId: "mtg-1", participantId: "p-1" }, { fetch: gone.fetch }),
    ).rejects.toMatchObject({ name: "RealtimeKitError", status: 404, code: "not_found" });
    const down = stubFetch([{ status: 503, body: { success: false } }]);
    await expect(
      refreshParticipantToken({ meetingId: "mtg-1", participantId: "p-1" }, { fetch: down.fetch }),
    ).rejects.toMatchObject({ name: "RealtimeKitError", status: 503, code: "unavailable" });
  });

  it("an unconfigured process refuses before any call", async () => {
    configure({ REALTIMEKIT_API_TOKEN: "" });
    const stub = stubFetch([]);
    await expect(
      refreshParticipantToken({ meetingId: "mtg-1", participantId: "p-1" }, { fetch: stub.fetch }),
    ).rejects.toMatchObject({ name: "RealtimeKitError", code: "unconfigured" });
    expect(stub.calls.length).toBe(0);
  });
});

/** The recorded peer report (addendum 3). Its `participant` object has the
 *  same schema as a row of GET /sessions/{id}/participants (OpenAPI: id,
 *  user_id, custom_participant_id, joined_at, left_at, duration, ...). */
const RECORDED = JSON.parse(
  readFileSync(join(__dirname, "../../__fixtures__/realtimekit/peer-report-recorded.json"), "utf8"),
) as {
  data: {
    participant: {
      id: string;
      user_id: string;
      custom_participant_id: string;
      joined_at: string;
      left_at: string | null;
      duration: number;
      peer_report: {
        metadata: { events: { name: string; timestamp: string }[] };
        quality: {
          video_producer: { timestamp: string }[];
          video_producer_cumulative: { issues: { no_video_fraction: number } };
        };
      };
    };
  };
};

describe("seatCameraEvidence: presence first (the reads the seat gate rests on)", () => {
  const SESSION = "sess-1";
  const ME = "p-1"; // the participantId addParticipant returned
  const live = { status: 200, body: { success: true, data: { id: SESSION, status: "LIVE" } } };
  const ended = { status: 200, body: { success: true, data: { id: SESSION, status: "ENDED" } } };
  const noSession = { status: 404, body: { success: false, error: { code: 404, message: "no active session" } } };
  const participants = (rows: unknown[]) => ({
    status: 200,
    body: { success: true, data: { participants: rows } },
  });
  /** A session-participant row. `id` is the SESSION PARTICIPANT id and
   *  `user_id` the participant id addParticipant returned — measured as two
   *  different values (README beside the fixture; 7dde4a246). */
  /** Its one peer is `peer-<userId>-<n>`, LEFT with the row (measured shape: `peer_events[]` with `event_name`,
   *  `peer_id`, `created_at` — T17B q2-live-parts-bothon). */
  const row = (userId: string, leftAt: string | null, n = 0) => ({
    id: `conn-${userId}-${n}`,
    user_id: userId,
    custom_participant_id: "s",
    joined_at: "2026-10-01T12:00:00Z",
    left_at: leftAt,
    peer_events: [
      { event_name: "PEER_JOINING", peer_id: `peer-${userId}-${n}`, created_at: "2026-10-01T12:00:00Z" },
      ...(leftAt === null ? [] : [{ event_name: "PEER_LEAVING", peer_id: `peer-${userId}-${n}`, created_at: leftAt }]),
    ],
  });
  /** The measured camera-ON peer's report (evidence t17b-peer-reports-live.json, "on"). */
  const cameraOn = {
    status: 200,
    body: {
      success: true,
      data: {
        participant: {
          peer_report: {
            metadata: {
              events: [
                { name: "audio_off", timestamp: "2026-10-01T12:00:00Z" },
                { name: "video_on", timestamp: "2026-10-01T12:00:00Z" },
                { name: "media_permission", metadata: { device_type: "VIDEO", permission: "ACCEPTED" }, timestamp: "2026-10-01T12:00:00Z" },
                { name: "precall_begin", timestamp: "2026-10-01T12:00:00Z" },
              ],
            },
          },
        },
      },
    },
  };
  const reportPeer = (url: string) => url.split("/sessions/peer-report/")[1] ?? null;

  it("sweeps every reachable state and reports the count", async () => {
    configure();
    const rec = RECORDED.data.participant;
    // Premise for the recorded-shape case: the session participant id and the
    // persistent participant id really are different values.
    expect(rec.id, "premise: recorded row has distinct id and user_id").not.toBe(rec.user_id);
    // `peer`: the peer whose report a present participant is judged on — the current one, never a peer that left.
    const cases: { name: string; me?: string; responses: { status: number; body: unknown }[]; want: "absent" | "on"; peer?: string }[] = [
      { name: "empty case: no active session at all", responses: [noSession], want: "absent" },
      { name: "session exists but has ENDED", responses: [ended], want: "absent" },
      { name: "live session, nobody in the participant list", responses: [live, participants([])], want: "absent" },
      {
        name: "live session, our participant has never joined",
        responses: [live, participants([row("someone-else", null)])],
        want: "absent",
      },
      {
        name: "live session, our participant joined and LEFT",
        responses: [live, participants([row(ME, "2026-10-01T12:05:00Z")])],
        want: "absent",
      },
      {
        name: "live session, our participant is joined and present",
        responses: [live, participants([row(ME, null)]), cameraOn],
        want: "on",
        peer: `peer-${ME}-0`,
      },
      {
        name: "present row whose left_at key is ABSENT, not null",
        responses: [live, participants([{ id: "conn-x", user_id: ME, joined_at: "2026-10-01T12:00:00Z", peer_events: row(ME, null).peer_events }]), cameraOn],
        want: "on",
        peer: `peer-${ME}-0`,
      },
      {
        // Matching on the row's `id` (the brief's original predicate) would
        // never see this participant: that is the session participant id.
        name: "recorded row shape: matched by user_id, present",
        me: rec.user_id,
        responses: [live, participants([{ ...rec, peer_report: undefined, left_at: null, peer_events: row(rec.user_id, null).peer_events }]), cameraOn],
        want: "on",
        peer: `peer-${rec.user_id}-0`,
      },
      {
        name: "a row whose session participant id equals our participantId but belongs to someone else",
        responses: [live, participants([{ ...row("someone-else", null), id: ME }])],
        want: "absent",
      },
      {
        name: "SEQUENCE: reloaded — old connection LEFT, new connection present",
        responses: [live, participants([row(ME, "2026-10-01T12:03:00Z", 1), row(ME, null, 2)]), cameraOn],
        want: "on",
        peer: `peer-${ME}-2`,
      },
      {
        name: "SEQUENCE: same rows, newest first",
        responses: [live, participants([row(ME, null, 2), row(ME, "2026-10-01T12:03:00Z", 1)]), cameraOn],
        want: "on",
        peer: `peer-${ME}-2`,
      },
      {
        name: "SEQUENCE: reloaded twice and finally left — every connection has left",
        responses: [
          live,
          participants([row(ME, "2026-10-01T12:03:00Z", 1), row(ME, "2026-10-01T12:09:00Z", 2)]),
        ],
        want: "absent",
      },
    ];
    let checked = 0;
    const outcomes = new Set<string>();
    for (const c of cases) {
      const stub = stubFetch(c.responses);
      const got = await seatCameraEvidence({ meetingId: "mtg-1", participantId: c.me ?? ME }, { fetch: stub.fetch });
      expect(got.state, c.name).toBe(c.want);
      expect(stub.calls.length, `${c.name}: every scripted response was used`).toBe(c.responses.length);
      expect(reportPeer(stub.calls.at(-1)!.url), `${c.name}: the peer judged`).toBe(c.peer ?? null);
      outcomes.add(got.state);
      checked += 1;
    }
    expect(checked, "anti-vacuity: every state the REST API can report").toBe(cases.length);
    expect(checked).toBeGreaterThanOrEqual(12);
    expect(outcomes.size, "a predicate that only ever answers one way proves nothing").toBe(2);
  });

  it("reads the active session, then that session's participants WITH their peer events at the maximum page size, then the current peer's report", async () => {
    configure();
    const stub = stubFetch([live, participants([row(ME, null)]), cameraOn]);
    await seatCameraEvidence({ meetingId: "mtg-1", participantId: ME }, { fetch: stub.fetch });
    expect(stub.calls.map((c) => `${c.method} ${c.url.split("/realtime/kit/app-1")[1]}`)).toEqual([
      "GET /meetings/mtg-1/active-session",
      // per_page defaults to 25 (OpenAPI); ask for the maximum, 200. The peer
      // events name the peers — the only ids the peer report takes.
      `GET /sessions/${SESSION}/participants?include_peer_events=true&per_page=200`,
      `GET /sessions/peer-report/peer-${ME}-0`,
    ]);
  });

  it("does not ask for the participant list at all when the session is not live", async () => {
    configure();
    const stub = stubFetch([ended]); // a second call throws
    expect((await seatCameraEvidence({ meetingId: "mtg-1", participantId: ME }, { fetch: stub.fetch })).state).toBe("absent");
    expect(stub.calls.length).toBe(1);
  });

  it("an UNREADABLE answer is never 'not live': only exact ENDED or RealtimeKit's own 404 are", async () => {
    // OpenAPI (realtime/kit active-session): 200 carries data.status in the
    // CLOSED enum LIVE | ENDED; 404 "Active Session is not found for the given
    // meetingId" carries { success: false, error: { code, message } }, both
    // required. Anything else is a body we cannot read, and under Required a
    // false here refuses the seat as "camera off" (addendum 5, D11).
    configure();
    const answerable = participants([row(ME, null)]);
    const cases: { name: string; first: { status: number; body?: unknown; text?: string }; message: RegExp }[] = [
      { name: "an HTML 200", first: { status: 200, text: "<html><body>502 Bad Gateway</body></html>" }, message: /unreadable/ },
      { name: "data: null", first: { status: 200, body: { success: true, data: null } }, message: /no data/ },
      { name: "an empty object", first: { status: 200, body: {} }, message: /no data/ },
      { name: "lowercase 'live'", first: { status: 200, body: { data: { id: SESSION, status: "live" } } }, message: /status/ },
      { name: "status missing", first: { status: 200, body: { success: true, data: { id: SESSION } } }, message: /status/ },
      { name: "a status outside the enum", first: { status: 200, body: { success: true, data: { id: SESSION, status: "PAUSED" } } }, message: /status/ },
      {
        // Cloudflare's own envelope for an unroutable path: errors[], not error.
        name: "a 404 that is not RealtimeKit's answer (gateway 7003, could not route)",
        first: {
          status: 404,
          body: {
            success: false,
            errors: [{ code: 7003, message: "Could not route to /accounts/acct-1/realtime/kit/app-1/meetings/mtg-1/active-session, perhaps your object identifier is invalid?" }],
            messages: [],
            result: null,
          },
        },
        message: /404/,
      },
      {
        name: "a 404 that is not RealtimeKit's answer (gateway 7000, no route for that URI)",
        first: { status: 404, body: { success: false, errors: [{ code: 7000, message: "No route for that URI" }], messages: [], result: null } },
        message: /404/,
      },
      {
        // Extra fields are tolerated, but a gateway no-route code is always
        // an outage, whatever else the body carries.
        name: "RealtimeKit's envelope that ALSO carries gateway 7003",
        first: { status: 404, body: { success: false, error: { code: 404, message: "x" }, errors: [{ code: 7003, message: "Could not route" }] } },
        message: /404/,
      },
      {
        name: "RealtimeKit's envelope that ALSO carries gateway 7000",
        first: { status: 404, body: { success: false, error: { code: 404, message: "x" }, errors: [{ code: 7000, message: "No route for that URI" }] } },
        message: /404/,
      },
      { name: "a 404 without success:false", first: { status: 404, body: { error: { code: 404, message: "x" } } }, message: /404/ },
      { name: "a 404 whose success is the STRING 'false'", first: { status: 404, body: { success: "false", error: { code: 404 } } }, message: /404/ },
      { name: "a 404 whose error.code is not 404", first: { status: 404, body: { success: false, error: { code: "NOT_FOUND", message: "x" } } }, message: /404/ },
      { name: "a 404 whose error is null", first: { status: 404, body: { success: false, error: null } }, message: /404/ },
      { name: "a 404 whose JSON body is null", first: { status: 404, body: null }, message: /404/ },
      { name: "an HTML 404", first: { status: 404, text: "<html>Not Found</html>" }, message: /404/ },
      { name: "an empty 404", first: { status: 404, text: "" }, message: /404/ },
    ];
    let checked = 0;
    for (const c of cases) {
      const stub = stubFetch([c.first, answerable]);
      await expect(
        seatCameraEvidence({ meetingId: "mtg-1", participantId: ME }, { fetch: stub.fetch }),
        c.name,
      ).rejects.toMatchObject({ name: "RealtimeKitError", code: "unavailable", message: expect.stringMatching(c.message) });
      checked += 1;
    }
    expect(checked, "anti-vacuity").toBe(cases.length);
    expect(checked).toBeGreaterThanOrEqual(17);
    // Positive controls: the two answers that DO mean "not live".
    expect((await seatCameraEvidence({ meetingId: "mtg-1", participantId: ME }, { fetch: stubFetch([noSession]).fetch })).state).toBe("absent");
    expect((await seatCameraEvidence({ meetingId: "mtg-1", participantId: ME }, { fetch: stubFetch([ended]).fetch })).state).toBe("absent");
  });

  it("RealtimeKit's 'no session yet' 404 is read by its envelope, not by the exact typing of its code", async () => {
    // No live session is the NORMAL state before the first player joins, and
    // the T8 seat gate asks in the same request that creates the participant:
    // every Required fixture's first claim meets this 404. Measured: an ended
    // meeting answers HTTP 404 (progress.md); the body is still unrecorded.
    // So the predicate is the envelope — status 404, JSON, success === false,
    // Number(error.code) === 404 — with extra fields and a string code allowed.
    configure();
    const answerable = participants([row(ME, null)]);
    const cases: { name: string; body: unknown }[] = [
      { name: "the documented shape", body: { success: false, error: { code: 404, message: "Active Session is not found for the given meetingId" } } },
      { name: "a STRING code", body: { success: false, error: { code: "404", message: "Active Session is not found for the given meetingId" } } },
      {
        name: "extra fields everywhere",
        body: { success: false, error: { code: 404, message: "x", details: { meetingId: "mtg-1" } }, message: "top-level", request_id: "r-1" },
      },
      { name: "a string code with extra fields", body: { success: false, error: { code: "404", message: "x", hint: "join first" }, meta: {} } },
      { name: "no message", body: { success: false, error: { code: 404 } } },
      { name: "an EMPTY errors[] beside RealtimeKit's error", body: { success: false, error: { code: 404, message: "x" }, errors: [] } },
      {
        name: "an errors[] entry that is not a gateway no-route code",
        body: { success: false, error: { code: 404, message: "x" }, errors: [{ code: 404, message: "x" }] },
      },
    ];
    let checked = 0;
    for (const c of cases) {
      // The second response would answer present if the code went on to ask.
      const stub = stubFetch([{ status: 404, body: c.body }, answerable]);
      expect((await seatCameraEvidence({ meetingId: "mtg-1", participantId: ME }, { fetch: stub.fetch })).state, c.name).toBe("absent");
      expect(stub.calls.length, `${c.name}: answered from the 404 alone`).toBe(1);
      checked += 1;
    }
    expect(checked, "anti-vacuity").toBe(cases.length);
    expect(checked).toBeGreaterThanOrEqual(7);
  });

  it("an upstream outage or a malformed answer is NEVER silently a false", async () => {
    // A false here would read as "camera off" and refuse a seat on a
    // division that is otherwise fine; D11's organiser override is the
    // intended answer to an outage, and it can only be offered if the
    // outage surfaces as an error.
    const fullPage = Array.from({ length: 200 }, (_, i) => row(`other-${i}`, null));
    const cases: { name: string; responses: { status: number; body: unknown }[]; code: string; unconfigured?: boolean }[] = [
      { name: "active-session 500", responses: [{ status: 500, body: { success: false } }], code: "unavailable" },
      { name: "active-session 401", responses: [{ status: 401, body: { success: false } }], code: "unauthorized" },
      {
        name: "active-session 200 with success:false",
        responses: [{ status: 200, body: { success: false } }],
        code: "unavailable",
      },
      {
        // The second response would answer TRUE if the code went on to ask,
        // so this case cannot pass by running out of scripted answers.
        name: "LIVE session with no id",
        responses: [
          { status: 200, body: { success: true, data: { status: "LIVE" } } },
          participants([row(ME, null)]),
        ],
        code: "unavailable",
      },
      { name: "participants 500", responses: [live, { status: 500, body: { success: false } }], code: "unavailable" },
      {
        name: "participants 404 (the session vanished between the two reads)",
        responses: [live, { status: 404, body: { success: false, error: { code: 404, message: "session not found" } } }],
        code: "not_found",
      },
      {
        name: "participants payload without a participants array",
        responses: [live, { status: 200, body: { success: true, data: { rows: [] } } }],
        code: "unavailable",
      },
      {
        name: "a FULL page (200 rows) with no match — the answer may be on page 2",
        responses: [live, participants(fullPage)],
        code: "unavailable",
      },
      { name: "unconfigured process", responses: [], code: "unconfigured", unconfigured: true },
    ];
    let checked = 0;
    for (const c of cases) {
      vi.unstubAllEnvs();
      configure(c.unconfigured ? { REALTIMEKIT_PLAYER_PRESET: "" } : {});
      const stub = stubFetch(c.responses);
      await expect(
        seatCameraEvidence({ meetingId: "mtg-1", participantId: ME }, { fetch: stub.fetch }),
        c.name,
      ).rejects.toMatchObject({ name: "RealtimeKitError", code: c.code });
      checked += 1;
    }
    expect(checked, "anti-vacuity: every failure shape").toBe(cases.length);
    expect(checked).toBeGreaterThanOrEqual(9);
    // Positive control for the full-page case: the same 200 rows WITH our
    // live row among them answer true, so the refusal above is about not
    // finding us on a full page, not about page size itself.
    configure();
    const withMe = [...fullPage.slice(0, 199), row(ME, null)];
    const ok = stubFetch([live, participants(withMe), cameraOn]);
    expect((await seatCameraEvidence({ meetingId: "mtg-1", participantId: ME }, { fetch: ok.fetch })).state).toBe("on");
  });

  // ─── T17B fix 2 (D2): the current peer's camera ─────────────────────────
  //
  // Expected states come from the ruling (ACCEPTED + latest video_on seats;
  // DENIED is blocked; ACCEPTED then video_off is off; no evidence is
  // starting) and the SDK's own permission values (web-core 2.0.2: ACCEPTED,
  // DENIED, SYSTEM_DENIED, COULD_NOT_START, …) — never from the adapter.
  const T0 = "2026-10-01T12:00:00.000Z";
  const T1 = "2026-10-01T12:00:05.000Z";
  const perm = (permission: string, device_type = "VIDEO", timestamp = T0) => ({ name: "media_permission", metadata: { device_type, permission }, timestamp });
  const ev = (name: string, timestamp = T0) => ({ name, timestamp });
  const report = (events: unknown) => ({ status: 200, body: { success: true, data: { participant: { peer_report: { metadata: { events } } } } } });

  it("the camera on the current peer's report, swept: every state the ruling names, and the edges that tell them apart", async () => {
    configure();
    const cases: { name: string; report: { status: number; body: unknown }; want: string }[] = [
      { name: "the measured honest camera: ACCEPTED, video_on, no producer samples", report: cameraOn, want: "on" },
      { name: "the measured DENIED peer: video_on, DENIED, video_off at one instant", report: report([ev("audio_off"), ev("video_on"), perm("DENIED"), ev("video_off"), ev("precall_begin")]), want: "blocked" },
      { name: "SYSTEM_DENIED (an OS privacy setting) is a refusal too", report: report([ev("video_on"), perm("SYSTEM_DENIED")]), want: "blocked" },
      { name: "DENIED anywhere for VIDEO wins, even beside a later ACCEPTED", report: report([perm("DENIED"), ev("video_on", T1), perm("ACCEPTED", "VIDEO", T1)]), want: "blocked" },
      { name: "an AUDIO denial is not the camera's", report: report([ev("video_on"), perm("ACCEPTED"), perm("DENIED", "AUDIO")]), want: "on" },
      { name: "ACCEPTED, then video_off", report: report([ev("video_on"), perm("ACCEPTED"), ev("video_off", T1)]), want: "off" },
      { name: "ACCEPTED, off, then back on: the latest wins", report: report([ev("video_on"), perm("ACCEPTED"), ev("video_off", T1), ev("video_on", "2026-10-01T12:00:09.000Z")]), want: "on" },
      // Ordered by timestamp, not by position: a batch uploaded out of order still reads its latest.
      { name: "a later video_off listed BEFORE an earlier video_on", report: report([ev("video_off", T1), perm("ACCEPTED"), ev("video_on", T0)]), want: "off" },
      // Ties keep the report's own order (the SDK logs a join's events at one millisecond).
      { name: "video_on then video_off at the same instant", report: report([perm("ACCEPTED"), ev("video_on"), ev("video_off")]), want: "off" },
      { name: "video_on with NO permission yet (the prompt unanswered) is intent, not proof", report: report([ev("audio_off"), ev("video_on"), ev("precall_begin")]), want: "starting" },
      { name: "ACCEPTED but no on/off event yet", report: report([perm("ACCEPTED")]), want: "starting" },
      { name: "a camera that could not start (busy device)", report: report([ev("video_on"), perm("COULD_NOT_START"), ev("video_off")]), want: "starting" },
      { name: "empty case: no events at all", report: report([]), want: "starting" },
      { name: "a report with no metadata yet", report: { status: 200, body: { success: true, data: { participant: { peer_report: null } } } }, want: "starting" },
      { name: "RealtimeKit's own 'no peer event exists' 404 (measured body)", report: { status: 404, body: { success: false, error: { code: 404, message: "No peer event exists for id x" } } }, want: "starting" },
      { name: "a peer-report 503", report: { status: 503, body: { success: false } }, want: "unreadable" },
      { name: "a 404 that is not RealtimeKit's (an HTML page)", report: { status: 404, body: "<html>" }, want: "unreadable" },
      { name: "events is not a list", report: report({ video_on: true }), want: "unreadable" },
      { name: "an event with no name", report: report([{ timestamp: T0 }]), want: "unreadable" },
      { name: "an event whose timestamp is not a date", report: report([perm("ACCEPTED"), ev("video_on", "yesterday")]), want: "unreadable" },
      { name: "no participant in the report", report: { status: 200, body: { success: true, data: { peer_report: {} } } }, want: "unreadable" },
    ];
    let checked = 0;
    const seen = new Set<string>();
    for (const c of cases) {
      const stub = stubFetch([live, participants([row(ME, null)]), c.report]);
      const got = await seatCameraEvidence({ meetingId: "mtg-1", participantId: ME }, { fetch: stub.fetch });
      expect(got.state, c.name).toBe(c.want);
      // Every present answer carries the current peer's join, which the seat's wait runs from.
      expect("since" in got && got.since.toISOString(), `${c.name}: since`).toBe(T0);
      if (got.state === "unreadable") expect(got.error, c.name).toBeInstanceOf(RealtimeKitError);
      seen.add(got.state);
      checked += 1;
    }
    expect(checked, "anti-vacuity").toBe(cases.length);
    expect([...seen].sort(), "every present state is reached").toEqual(["blocked", "off", "on", "starting", "unreadable"]);
  });

  it("the CURRENT peer: the latest PEER_JOINING with no PEER_LEAVING, across the participant's present rows — swept", async () => {
    configure();
    const joining = (peer: string, at: string) => ({ event_name: "PEER_JOINING", peer_id: peer, created_at: at });
    const leaving = (peer: string, at: string) => ({ event_name: "PEER_LEAVING", peer_id: peer, created_at: at });
    const mine = (peerEvents: unknown) => ({ id: "conn-me", user_id: ME, joined_at: T0, left_at: null, peer_events: peerEvents });
    const cases: { name: string; rows: unknown[]; peer: string | null; want?: string }[] = [
      // MEASURED (T17B): a reload is a new peer under the SAME row.
      { name: "a reload under one row: the old peer left, the new one judged", rows: [mine([joining("old", T0), leaving("old", T1), joining("new", "2026-10-01T12:00:06.000Z")])], peer: "new" },
      { name: "two tabs open: the later join is judged", rows: [mine([joining("a", T0), joining("b", T1)])], peer: "b" },
      { name: "two tabs, listed newest first", rows: [mine([joining("b", T1), joining("a", T0)])], peer: "b" },
      { name: "the later tab closed: the earlier, still open, is judged", rows: [mine([joining("a", T0), joining("b", T1), leaving("b", "2026-10-01T12:00:07.000Z")])], peer: "a" },
      { name: "every peer has left though the row lags: absent, no report asked", rows: [mine([joining("a", T0), leaving("a", T1)])], peer: null, want: "absent" },
      { name: "a present row with no peer events at all: absent", rows: [mine([])], peer: null, want: "absent" },
      { name: "another participant's newer peer is never mine", rows: [mine([joining("a", T0)]), { id: "conn-x", user_id: "someone-else", left_at: null, peer_events: [joining("z", T1)] }], peer: "a" },
      { name: "unknown event names are ignored", rows: [mine([{ event_name: "PEER_CREATED", peer_id: "q", created_at: T1 }, joining("a", T0)])], peer: "a" },
    ];
    let checked = 0;
    for (const c of cases) {
      const responses = [live, participants(c.rows), ...(c.peer === null ? [] : [cameraOn])];
      const stub = stubFetch(responses);
      const got = await seatCameraEvidence({ meetingId: "mtg-1", participantId: ME }, { fetch: stub.fetch });
      expect(got.state, c.name).toBe(c.want ?? "on");
      expect(stub.calls.length, `${c.name}: every scripted response was used`).toBe(responses.length);
      expect(reportPeer(stub.calls.at(-1)!.url), `${c.name}: the peer judged`).toBe(c.peer);
      checked += 1;
    }
    expect(checked, "anti-vacuity").toBe(cases.length);
  });

  it("peer events we cannot read THROW (an outage, never 'camera off') — swept", async () => {
    configure();
    const mine = (peerEvents: unknown) => ({ id: "conn-me", user_id: ME, joined_at: T0, left_at: null, peer_events: peerEvents });
    const cases: { name: string; rows: unknown[] }[] = [
      { name: "peer_events missing", rows: [{ id: "conn-me", user_id: ME, left_at: null }] },
      { name: "peer_events not a list", rows: [mine({ PEER_JOINING: "p" })] },
      { name: "an event without a peer_id", rows: [mine([{ event_name: "PEER_JOINING", created_at: T0 }])] },
      { name: "a PEER_JOINING without a date", rows: [mine([{ event_name: "PEER_JOINING", peer_id: "p", created_at: "soon" }])] },
    ];
    let checked = 0;
    for (const c of cases) {
      const stub = stubFetch([live, participants(c.rows), cameraOn]);
      await expect(seatCameraEvidence({ meetingId: "mtg-1", participantId: ME }, { fetch: stub.fetch }), c.name).rejects.toMatchObject({
        name: "RealtimeKitError",
        code: "unavailable",
      });
      expect(stub.calls.length, `${c.name}: no report asked`).toBe(2);
      checked += 1;
    }
    expect(checked, "anti-vacuity").toBe(cases.length);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("endMeeting", () => {
  const kicked = { status: 200, body: { success: true, data: { action: "kick", kicked_participants_count: 2 } } };
  const noActive = { status: 404, body: { success: false, error: { code: 404, message: "no active session" } } };
  const inactive = { status: 200, body: { success: true, data: { status: "INACTIVE" } } };
  const endedAt = async (meetingId: string) => {
    const [r] = await sql<{ ended_at: Date | null }[]>`
      select ended_at from fixture_video_meetings where meeting_id = ${meetingId}`;
    return r?.ended_at ?? null;
  };
  const route = (url: string) => url.split("/realtime/kit/app-1")[1];

  it("kicks everyone out and THEN deactivates the meeting, in that order", async () => {
    configure();
    const s = await seedFixture();
    const id = mtg("end");
    const create = stubFetch([{ status: 200, body: { success: true, data: { id } } }]);
    await ensureMeeting(s.fixtureId, "home", { fetch: create.fetch });
    expect(await endedAt(id), "premise: a fresh meeting is not ended").toBeNull();
    const stub = stubFetch([kicked, inactive]);
    await endMeeting(id, { fetch: stub.fetch });
    expect(stub.calls.map((c) => `${c.method} ${route(c.url)}`)).toEqual([
      `POST /meetings/${id}/active-session/kick-all`,
      `PATCH /meetings/${id}`,
    ]);
    expect(stub.calls[1]?.body).toEqual({ status: "INACTIVE" });
    expect(await endedAt(id), "the row is stamped so ensureMeeting will not reuse it").not.toBeNull();
  });

  it("no active session is not a failure: the deactivate still happens", async () => {
    // Order matters and so does this case: at the deadline with nobody present
    // there IS no session to kick, and skipping the PATCH would leave a
    // joinable meeting behind.
    configure();
    const stub = stubFetch([noActive, inactive]);
    await endMeeting(mtg("quiet"), { fetch: stub.fetch });
    expect(stub.calls.length).toBe(2);
    expect(stub.calls[1]?.method).toBe("PATCH");
  });

  it("a kick-all 404 in ANY shape means nothing to kick: the deactivate still happens and the row is stamped", async () => {
    // OpenAPI documents NO 404 for kick-all, so its body shape is unknowable
    // until recorded. Reading a non-documented one as an outage wedged
    // teardown on the ordinary quiet-room path: the PATCH never went, the
    // meeting stayed joinable, the row was never stamped and every sweep
    // retried and threw again (re-review N1). The PATCH that follows travels
    // the same path prefix and is the proof of teardown.
    configure();
    const cases: { name: string; kick: { status: number; body?: unknown; text?: string } }[] = [
      { name: "the active-session 404 shape", kick: noActive },
      {
        name: "Cloudflare's gateway envelope (errors[], code 7003)",
        kick: { status: 404, body: { success: false, errors: [{ code: 7003, message: "Could not route" }], messages: [], result: null } },
      },
      { name: "a string error.code", kick: { status: 404, body: { success: false, error: { code: "404", message: "no active session" } } } },
      { name: "an HTML 404", kick: { status: 404, text: "<html>Not Found</html>" } },
      { name: "an empty 404", kick: { status: 404, text: "" } },
    ];
    let checked = 0;
    for (const c of cases) {
      const s = await seedFixture();
      const id = mtg(`kick404-${checked}`);
      await ensureMeeting(s.fixtureId, "home", { fetch: stubFetch([{ status: 200, body: { success: true, data: { id } } }]).fetch });
      expect(await endedAt(id), `${c.name}: premise — a fresh meeting is not ended`).toBeNull();
      const stub = stubFetch([c.kick, inactive]);
      await endMeeting(id, { fetch: stub.fetch });
      expect(stub.calls.map((x) => `${x.method} ${route(x.url)}`), c.name).toEqual([
        `POST /meetings/${id}/active-session/kick-all`,
        `PATCH /meetings/${id}`,
      ]);
      expect(stub.calls[1]?.body, c.name).toEqual({ status: "INACTIVE" });
      expect(await endedAt(id), c.name).not.toBeNull();
      checked += 1;
    }
    expect(checked, "anti-vacuity").toBe(cases.length);
    expect(checked).toBeGreaterThanOrEqual(5);
  });

  it("after a tolerated kick 404 the PATCH is the proof: any PATCH failure throws and leaves the row UNSTAMPED", async () => {
    // A routing or proxy 404 would fail the PATCH too, so tolerating the
    // kick's 404 cannot turn an outage into a recorded teardown.
    configure();
    const gateway404 = { status: 404, body: { success: false, errors: [{ code: 7003, message: "Could not route" }], messages: [], result: null } };
    const cases: { name: string; patch: { status: number; body?: unknown; text?: string }; code: string }[] = [
      { name: "the PATCH 404s through the gateway too", patch: gateway404, code: "unavailable" },
      {
        name: "the PATCH 404s in RealtimeKit's own shape",
        patch: { status: 404, body: { success: false, error: { code: 404, message: "meeting not found" } } },
        code: "not_found",
      },
      { name: "the PATCH 500s", patch: { status: 500, body: { success: false } }, code: "unavailable" },
      { name: "the PATCH answers an HTML 200", patch: { status: 200, text: "<html>ok</html>" }, code: "unavailable" },
    ];
    let checked = 0;
    for (const c of cases) {
      const s = await seedFixture();
      const id = mtg(`patch-proof-${checked}`);
      await ensureMeeting(s.fixtureId, "home", { fetch: stubFetch([{ status: 200, body: { success: true, data: { id } } }]).fetch });
      const stub = stubFetch([gateway404, c.patch]);
      await expect(endMeeting(id, { fetch: stub.fetch }), c.name).rejects.toMatchObject({
        name: "RealtimeKitError",
        code: c.code,
      });
      expect(stub.calls.map((x) => x.method), `${c.name}: premise — the PATCH was attempted`).toEqual(["POST", "PATCH"]);
      expect(await endedAt(id), c.name).toBeNull();
      checked += 1;
    }
    expect(checked, "anti-vacuity").toBe(cases.length);
    expect(checked).toBeGreaterThanOrEqual(4);
  });

  it("SEQUENCE: ensure → end → ensure refuses (409) with no HTTP call", async () => {
    configure();
    const s = await seedFixture();
    const id = mtg("seq");
    await ensureMeeting(s.fixtureId, "home", { fetch: stubFetch([{ status: 200, body: { success: true, data: { id } } }]).fetch });
    await endMeeting(id, { fetch: stubFetch([kicked, inactive]).fetch });
    const after = stubFetch([{ status: 200, body: { success: true, data: { id: mtg("seq-orphan") } } }]);
    await expect(ensureMeeting(s.fixtureId, "home", { fetch: after.fetch })).rejects.toMatchObject({
      status: 409,
      code: "VIDEO_MEETING_ENDED",
    });
    expect(after.calls.length, "no billable meeting is created after teardown").toBe(0);
  });

  it("SEQUENCE: a second endMeeting is harmless and keeps the FIRST ended_at", async () => {
    configure();
    const s = await seedFixture();
    const id = mtg("twice");
    await ensureMeeting(s.fixtureId, "home", { fetch: stubFetch([{ status: 200, body: { success: true, data: { id } } }]).fetch });
    await endMeeting(id, { fetch: stubFetch([kicked, inactive]).fetch });
    const first = await endedAt(id);
    expect(first, "premise: the first call stamped the row").not.toBeNull();
    await new Promise((r) => setTimeout(r, 15));
    // Second time round the session is gone: the kick 404s, the PATCH repeats.
    const again = stubFetch([noActive, inactive]);
    await endMeeting(id, { fetch: again.fetch });
    expect(again.calls.length).toBe(2);
    expect((await endedAt(id))?.getTime(), "teardown time is when it FIRST ended").toBe(first?.getTime());
  });

  it("I2: the room's arbiter watches end with it — a player row, a watch already ended and another room's watch untouched; a second call moves nothing", async () => {
    configure();
    const s = await seedFixture();
    const other = await seedFixture();
    const id = mtg("arb");
    const otherId = mtg("arb-other");
    await ensureMeeting(s.fixtureId, "home", { fetch: stubFetch([{ status: 200, body: { success: true, data: { id } } }]).fetch });
    await ensureMeeting(other.fixtureId, "home", { fetch: stubFetch([{ status: 200, body: { success: true, data: { id: otherId } } }]).fetch });
    const earlier = new Date(Date.now() - 60 * 60_000);
    await sql`insert into fixture_video_participants (fixture_id, side, person_id, preset, participant_id, removed_at) values
      (${s.fixtureId}, 'home', null, 'arbiter', 'a-open-1', null),
      (${s.fixtureId}, 'home', null, 'arbiter', 'a-open-2', null),
      (${s.fixtureId}, 'home', null, 'arbiter', 'a-done', ${earlier}),
      (${other.fixtureId}, 'home', null, 'arbiter', 'a-elsewhere', null)`;
    await sql`insert into fixture_video_participants (fixture_id, side, person_id, preset, participant_id)
              values (${s.fixtureId}, 'home', ${s.home.personId}, 'player', 'p-home')`;
    const removedAt = async () =>
      Object.fromEntries(
        (
          await sql<{ participant_id: string; removed_at: Date | null }[]>`
            select participant_id, removed_at from fixture_video_participants
             where fixture_id in (${s.fixtureId}, ${other.fixtureId})`
        ).map((r) => [r.participant_id, r.removed_at?.getTime() ?? null]),
      );
    await endMeeting(id, { fetch: stubFetch([kicked, inactive]).fetch });
    const after = await removedAt();
    const ended = (await endedAt(id))!.getTime();
    expect(after).toEqual({
      "a-open-1": ended,
      "a-open-2": ended,
      "a-done": earlier.getTime(),
      "a-elsewhere": null,
      "p-home": null,
    });
    await endMeeting(id, { fetch: stubFetch([noActive, inactive]).fetch });
    expect(await removedAt(), "a repeat keeps the first stamps").toEqual(after);
  });

  it("D16: ending one player's meeting stamps only the arbiter watches of THAT side; the other side's watch and its meeting are untouched", async () => {
    configure();
    const s = await seedFixture();
    const homeId = mtg("end-home");
    const awayId = mtg("end-away");
    await ensureMeeting(s.fixtureId, "home", { fetch: stubFetch([{ status: 200, body: { success: true, data: { id: homeId } } }]).fetch });
    await ensureMeeting(s.fixtureId, "away", { fetch: stubFetch([{ status: 200, body: { success: true, data: { id: awayId } } }]).fetch });
    await sql`insert into fixture_video_participants (fixture_id, side, person_id, preset, participant_id) values
      (${s.fixtureId}, 'home', null, 'arbiter', 'a-on-home'),
      (${s.fixtureId}, 'away', null, 'arbiter', 'a-on-away')`;
    const removed = async () =>
      Object.fromEntries(
        (await sql<{ participant_id: string; removed_at: Date | null }[]>`
          select participant_id, removed_at from fixture_video_participants where fixture_id = ${s.fixtureId}`).map((r) => [r.participant_id, r.removed_at !== null]),
      );
    await endMeeting(homeId, { fetch: stubFetch([kicked, inactive]).fetch });
    expect(await removed(), "only the home watch ended").toEqual({ "a-on-home": true, "a-on-away": false });
    expect(await endedAt(homeId), "home's meeting ended").not.toBeNull();
    expect(await endedAt(awayId), "away's meeting is still live").toBeNull();
    await endMeeting(awayId, { fetch: stubFetch([kicked, inactive]).fetch });
    expect(await removed(), "the pair: ending away ends its own watch").toEqual({ "a-on-home": true, "a-on-away": true });
  });

  it("I2: a failed deactivate stamps no arbiter watch removed — the meeting is still joinable", async () => {
    configure();
    const s = await seedFixture();
    const id = mtg("arb-patch-fails");
    await ensureMeeting(s.fixtureId, "home", { fetch: stubFetch([{ status: 200, body: { success: true, data: { id } } }]).fetch });
    await sql`insert into fixture_video_participants (fixture_id, side, person_id, preset, participant_id)
              values (${s.fixtureId}, 'home', null, 'arbiter', 'a-still')`;
    await expect(endMeeting(id, { fetch: stubFetch([kicked, { status: 500, body: { success: false } }]).fetch })).rejects.toMatchObject({
      code: "unavailable",
    });
    const [row] = await sql<{ removed_at: Date | null }[]>`
      select removed_at from fixture_video_participants where fixture_id = ${s.fixtureId} and participant_id = 'a-still'`;
    expect(row!.removed_at).toBeNull();
  });

  it("a failed deactivate leaves the row UNSTAMPED, so the next sweep tries again", async () => {
    configure();
    const s = await seedFixture();
    const id = mtg("patch-fails");
    await ensureMeeting(s.fixtureId, "home", { fetch: stubFetch([{ status: 200, body: { success: true, data: { id } } }]).fetch });
    const stub = stubFetch([kicked, { status: 500, body: { success: false } }]);
    await expect(endMeeting(id, { fetch: stub.fetch })).rejects.toMatchObject({ code: "unavailable" });
    expect(stub.calls.length, "premise: the PATCH was attempted").toBe(2);
    expect(await endedAt(id), "still joinable upstream, so not recorded as ended").toBeNull();
  });

  it("a kick that fails for any reason other than 404 throws before deactivating", async () => {
    configure();
    const s = await seedFixture();
    const id = mtg("kick-fails");
    await ensureMeeting(s.fixtureId, "home", { fetch: stubFetch([{ status: 200, body: { success: true, data: { id } } }]).fetch });
    const stub = stubFetch([{ status: 500, body: { success: false } }, inactive]);
    await expect(endMeeting(id, { fetch: stub.fetch })).rejects.toMatchObject({ code: "unavailable" });
    expect(stub.calls.length).toBe(1);
    expect(await endedAt(id)).toBeNull();
  });

  it("an unconfigured process refuses before any call", async () => {
    configure({ REALTIMEKIT_API_TOKEN: "" });
    const stub = stubFetch([]);
    await expect(endMeeting(mtg("unconfigured"), { fetch: stub.fetch })).rejects.toMatchObject({
      code: "unconfigured",
    });
    expect(stub.calls.length).toBe(0);
  });
});

// T15 fix round 1, I2: an arbiter's access must not outlive the panel or the
// organiser's role. RealtimeKit tokens last 100 days and a refresh does not
// revoke the old one (measured 2026-10-09), so the SERVER removes the
// participant: kicked from the live session, then deleted, so its token can
// never re-join. Whether the kick disconnects a joined client is T17's to
// measure against the real SDK; here, the calls and their failure handling.
describe("removeParticipant", () => {
  const kicked = { status: 200, body: { success: true, data: { action: "kick", participants: [] } } };
  const deleted = { status: 200, body: { success: true, data: { created_at: "2026-10-12T19:00:00Z", custom_participant_id: "u-1", preset_id: "p-1", updated_at: "2026-10-12T19:00:00Z" } } };
  const rtkNotFound = { status: 404, body: { success: false, error: { code: 404, message: "No user found with id x" } } };
  const gateway404 = { status: 404, body: { success: false, errors: [{ code: 7003, message: "Could not route" }], messages: [], result: null } };
  const route = (url: string) => url.split("/realtime/kit/app-1")[1];
  const PID = "813432c7-3c5a-45e2-9acf-eef7061c7584";

  it("kicks THAT participant from the live session, then deletes it — in that order, by its id", async () => {
    configure();
    const stub = stubFetch([kicked, deleted]);
    await removeParticipant({ meetingId: "m-1", participantId: PID }, { fetch: stub.fetch });
    expect(stub.calls.map((c) => `${c.method} ${route(c.url)}`)).toEqual([
      `POST /meetings/m-1/active-session/kick`,
      `DELETE /meetings/m-1/participants/${PID}`,
    ]);
    // participant_ids is the add-participant id (a session row's user_id).
    expect(stub.calls[0]?.body).toEqual({ participant_ids: [PID] });
    expect(stub.calls[1]?.body).toBeUndefined();
  });

  it("a kick 404 in ANY shape is nothing to kick (no live session, or not in it): the delete still happens", async () => {
    configure();
    const cases: { name: string; kick: { status: number; body?: unknown; text?: string } }[] = [
      { name: "the documented 404 (no participant found)", kick: rtkNotFound },
      { name: "the gateway envelope", kick: gateway404 },
      { name: "an HTML 404", kick: { status: 404, text: "<html>Not Found</html>" } },
    ];
    let checked = 0;
    for (const c of cases) {
      const stub = stubFetch([c.kick, deleted]);
      await removeParticipant({ meetingId: "m-2", participantId: PID }, { fetch: stub.fetch });
      expect(stub.calls.map((x) => x.method), c.name).toEqual(["POST", "DELETE"]);
      checked++;
    }
    expect(checked, "anti-vacuity").toBe(cases.length);
  });

  it("a participant already deleted (RealtimeKit's own not-found) is removed: resolves", async () => {
    configure();
    const stub = stubFetch([rtkNotFound, rtkNotFound]);
    await expect(removeParticipant({ meetingId: "m-3", participantId: PID }, { fetch: stub.fetch })).resolves.toBeUndefined();
    expect(stub.calls.length).toBe(2);
  });

  it("the delete is the proof: any other delete failure THROWS — the caller keeps the row and retries", async () => {
    configure();
    const cases: { name: string; del: { status: number; body?: unknown; text?: string }; code: string }[] = [
      { name: "a gateway 404 on the delete", del: gateway404, code: "unavailable" },
      { name: "a 500", del: { status: 500, body: { success: false, error: { code: 500, message: "x" } } }, code: "unavailable" },
      { name: "an HTML 200", del: { status: 200, text: "<html>ok</html>" }, code: "unavailable" },
      { name: "our credentials refused", del: { status: 401, body: { success: false } }, code: "unauthorized" },
    ];
    let checked = 0;
    for (const c of cases) {
      const stub = stubFetch([kicked, c.del]);
      await expect(removeParticipant({ meetingId: "m-4", participantId: PID }, { fetch: stub.fetch }), c.name).rejects.toMatchObject({
        name: "RealtimeKitError",
        code: c.code,
      });
      checked++;
    }
    expect(checked, "anti-vacuity").toBe(cases.length);
  });

  it("a kick that fails for any reason other than 404 throws BEFORE the delete", async () => {
    configure();
    const stub = stubFetch([{ status: 500, body: { success: false } }, deleted]);
    await expect(removeParticipant({ meetingId: "m-5", participantId: PID }, { fetch: stub.fetch })).rejects.toMatchObject({ code: "unavailable" });
    expect(stub.calls.length).toBe(1);
  });

  it("an unconfigured process refuses before any call", async () => {
    configure({ REALTIMEKIT_API_TOKEN: "" });
    const stub = stubFetch([]);
    await expect(removeParticipant({ meetingId: "m-6", participantId: PID }, { fetch: stub.fetch })).rejects.toMatchObject({ code: "unconfigured" });
    expect(stub.calls.length).toBe(0);
  });
});

describe("fetchVideoOffCoverage", () => {
  // The peer id is the SDK's `meeting.self.id` / a peer_events peer_id —
  // NOT the participant id (Cloudflare FAQ: a participant id 404s here).
  const PEER = "c4736b31-83f6-42d0-a18b-019f498fb347"; // the spike's peer id (rtk-peer-report.log)

  it("END TO END: the recorded response through the real fetch path into the real parser", async () => {
    configure();
    const stub = stubFetch([{ status: 200, body: RECORDED }]);
    const got = await fetchVideoOffCoverage(PEER, { fetch: stub.fetch });
    expect(stub.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET https://api.cloudflare.com/client/v4/accounts/acct-1/realtime/kit/app-1/sessions/peer-report/${PEER}`,
    ]);
    if (got.incomplete) throw new Error("premise: the recorded report is final");
    // Driver log: ONE gap 18:09:11 -> 18:12:20 (189 s), n=51.
    expect(got.sampleCount).toBe(51);
    expect(got.offIntervals.map((i) => [i.from.slice(0, 19), i.to.slice(0, 19), Math.round(i.seconds)])).toEqual([
      ["2026-10-09T18:09:11", "2026-10-09T18:12:20", 189],
    ]);
    expect(got.offIntervals[0]?.confirmedByEvents).toBe(true);
  });

  it("returns ONLY the coverage — no raw report field leaves the adapter", async () => {
    // The unredacted report carries IP, device and browser metadata; what a
    // caller stores or shows must be the coverage and nothing else.
    configure();
    const p = RECORDED.data.participant;
    const raw = [p.user_id, p.custom_participant_id, p.id, "spike-white", "web-core"];
    expect(JSON.stringify(RECORDED), "premise: the raw identifiers ARE in the response").toContain(raw[0]!);
    const got = await fetchVideoOffCoverage(PEER, { fetch: stubFetch([{ status: 200, body: RECORDED }]).fetch });
    const out = JSON.stringify(got);
    let checked = 0;
    for (const value of raw) {
      expect(out, value).not.toContain(value);
      checked += 1;
    }
    expect(checked, "anti-vacuity").toBe(raw.length);
    expect(Object.keys(got).sort()).toEqual([
      "cadenceSeconds",
      "coveredSeconds",
      "eventOffSeconds",
      "incomplete",
      // The connection's own span (T13, C1): two timestamps, so a match can
      // union a reload's and a rejoin's connections. No identity in them.
      "joinedAt",
      "leftAt",
      "offIntervals",
      "offSeconds",
      "sampleCount",
    ]);
  });

  it("SEQUENCE: frozen during the session ⇒ incomplete; after leave ⇒ final", async () => {
    configure();
    const frozen = structuredClone(RECORDED);
    frozen.data.participant.peer_report.quality.video_producer =
      frozen.data.participant.peer_report.quality.video_producer.slice(0, 1);
    frozen.data.participant.left_at = null;
    frozen.data.participant.duration = 0;
    const stub = stubFetch([
      { status: 200, body: frozen },
      { status: 200, body: RECORDED },
    ]);
    expect(await fetchVideoOffCoverage(PEER, { fetch: stub.fetch })).toEqual({
      incomplete: true,
      reason: "not_left",
      sampleCount: 1,
    });
    const second = await fetchVideoOffCoverage(PEER, { fetch: stub.fetch });
    expect(second.incomplete).toBe(false);
  });

  it("a 404 (e.g. a participant id passed instead of a peer id) throws not_found", async () => {
    configure();
    const stub = stubFetch([
      { status: 404, body: { success: false, error: { code: 404, message: "No peer event exists for id x" } } },
    ]);
    await expect(fetchVideoOffCoverage("participant-not-peer", { fetch: stub.fetch })).rejects.toMatchObject({
      name: "RealtimeKitError",
      code: "not_found",
    });
  });

  it("an unconfigured process refuses before any call", async () => {
    configure({ REALTIMEKIT_APP_ID: "" });
    const stub = stubFetch([]);
    await expect(fetchVideoOffCoverage(PEER, { fetch: stub.fetch })).rejects.toMatchObject({
      code: "unconfigured",
    });
    expect(stub.calls.length).toBe(0);
  });
});

describe("listPeerIds", () => {
  // MEASURED 2026-10-09 by the controller on the spike's ended session
  // (rtk-peer-report.log tail, commit 7dde4a246):
  //   GET /sessions/{sid}/participants?include_peer_events=true → one row:
  //   id = session participant id (= the report's participant.id), user_id =
  //   the add-participant id, and peer_events PEER_JOINING / PEER_LEAVING whose
  //   peer_id is the driver's self.id — the key the peer report takes. The
  //   row's id is NOT a peer id, whatever the OpenAPI wording says.
  const SID = "561b3ee9-fba7-4b9f-9f78-f467ab8fe695"; // driver log sessionId
  const PEER = "c4736b31-83f6-42d0-a18b-019f498fb347"; // driver log selfId
  const rec = RECORDED.data.participant;
  const peerEvents = (rowId: string, peer: string) => [
    { event_name: "PEER_JOINING", peer_id: peer, participant_id: rowId, session_id: SID },
    { event_name: "PEER_LEAVING", peer_id: peer, participant_id: rowId, session_id: SID },
  ];
  const measuredRow = {
    id: rec.id,
    user_id: rec.user_id,
    custom_participant_id: rec.custom_participant_id,
    joined_at: rec.joined_at,
    left_at: rec.left_at,
    peer_events: peerEvents(rec.id, PEER),
  };
  const list = (rows: unknown[]) => ({ status: 200, body: { success: true, data: { participants: rows } } });

  it("MEASURED shape: returns the peer id from peer_events, never the row's id", async () => {
    configure();
    expect(rec.id, "premise: the row id is not the peer id").not.toBe(PEER);
    const stub = stubFetch([list([measuredRow])]);
    const got = await listPeerIds(SID, rec.user_id, { fetch: stub.fetch });
    expect(got).toEqual([PEER]);
    expect(got).not.toContain(rec.id);
    expect(stub.calls.map((c) => `${c.method} ${c.url.split("/realtime/kit/app-1")[1]}`)).toEqual([
      `GET /sessions/${SID}/participants?include_peer_events=true&per_page=200`,
    ]);
  });

  it("sweeps the well-formed shapes and reports the count", async () => {
    configure();
    const ME = rec.user_id;
    const cases: { name: string; rows: unknown[]; want: string[] }[] = [
      { name: "EMPTY: nobody in the session", rows: [], want: [] },
      {
        name: "our participant never joined (only someone else's row)",
        rows: [{ id: "row-x", user_id: "someone-else", peer_events: peerEvents("row-x", "peer-x") }],
        want: [],
      },
      {
        name: "SEQUENCE: reloaded as a NEW row — both peers, in order, and nobody else's",
        rows: [
          { id: "row-1", user_id: ME, peer_events: peerEvents("row-1", "peer-1") },
          { id: "row-x", user_id: "someone-else", peer_events: peerEvents("row-x", "peer-x") },
          { id: "row-2", user_id: ME, peer_events: peerEvents("row-2", "peer-2") },
        ],
        want: ["peer-1", "peer-2"],
      },
      {
        name: "SEQUENCE: reloaded within the SAME row — both peers, each once",
        rows: [{ id: "row-1", user_id: ME, peer_events: [...peerEvents("row-1", "peer-1"), ...peerEvents("row-1", "peer-2")] }],
        want: ["peer-1", "peer-2"],
      },
      {
        name: "our row with no peer events yet",
        rows: [{ id: "row-1", user_id: ME, peer_events: [] }],
        want: [],
      },
    ];
    let checked = 0;
    for (const c of cases) {
      const got = await listPeerIds(SID, ME, { fetch: stubFetch([list(c.rows)]).fetch });
      expect(got, c.name).toEqual(c.want);
      checked += 1;
    }
    expect(checked, "anti-vacuity").toBe(cases.length);
    expect(checked).toBeGreaterThanOrEqual(5);
  });

  it("END TO END: the discovered peer id is the one the peer report is fetched by", async () => {
    configure();
    const [peer] = await listPeerIds(SID, rec.user_id, { fetch: stubFetch([list([measuredRow])]).fetch });
    const report = stubFetch([{ status: 200, body: RECORDED }]);
    const got = await fetchVideoOffCoverage(peer!, { fetch: report.fetch });
    expect(report.calls[0]?.url.endsWith(`/sessions/peer-report/${PEER}`)).toBe(true);
    if (got.incomplete) throw new Error("premise: the recorded report is final");
    // Driver log: ONE gap 18:09:11 -> 18:12:20 (189 s).
    expect(got.offIntervals.map((i) => Math.round(i.seconds))).toEqual([189]);
  });

  it("fails CLOSED on a body it cannot read — never a short peer list", async () => {
    configure();
    const ME = rec.user_id;
    const full = Array.from({ length: 200 }, (_, i) => ({ id: `r-${i}`, user_id: `other-${i}`, peer_events: [] }));
    const cases: { name: string; first: { status: number; body?: unknown; text?: string }; code: string }[] = [
      { name: "an HTML 200", first: { status: 200, text: "<html>oops</html>" }, code: "unavailable" },
      { name: "no participants list", first: { status: 200, body: { success: true, data: {} } }, code: "unavailable" },
      { name: "a row that is not an object", first: list([measuredRow, "row"]), code: "unavailable" },
      { name: "a row with no user_id (it might be ours)", first: list([{ id: "row-1", peer_events: [] }]), code: "unavailable" },
      { name: "OUR row without peer_events", first: list([{ id: "row-1", user_id: ME }]), code: "unavailable" },
      { name: "OUR row with peer_events not a list", first: list([{ id: "row-1", user_id: ME, peer_events: {} }]), code: "unavailable" },
      {
        name: "OUR peer event without a peer_id",
        first: list([{ id: "row-1", user_id: ME, peer_events: [{ event_name: "PEER_JOINING" }] }]),
        code: "unavailable",
      },
      {
        name: "OUR peer event with an empty peer_id",
        first: list([{ id: "row-1", user_id: ME, peer_events: [{ event_name: "PEER_JOINING", peer_id: "" }] }]),
        code: "unavailable",
      },
      { name: "a FULL page (200 rows): more of our peers may be on page 2", first: list(full), code: "unavailable" },
      {
        name: "RealtimeKit's own 404 (no such session)",
        first: { status: 404, body: { success: false, error: { code: 404, message: "session not found" } } },
        code: "not_found",
      },
    ];
    let checked = 0;
    for (const c of cases) {
      await expect(listPeerIds(SID, ME, { fetch: stubFetch([c.first]).fetch }), c.name).rejects.toMatchObject({
        name: "RealtimeKitError",
        code: c.code,
      });
      checked += 1;
    }
    expect(checked, "anti-vacuity").toBe(cases.length);
    expect(checked).toBeGreaterThanOrEqual(10);
    // Positive control for the full page: 199 rows plus ours is complete.
    const almost = [...full.slice(0, 198), measuredRow];
    expect(await listPeerIds(SID, ME, { fetch: stubFetch([list(almost)]).fetch })).toEqual([PEER]);
  });

  it("refuses empty ids before any call — an empty user id would read as 'never joined'", async () => {
    configure();
    let checked = 0;
    for (const [sid, uid] of [["", rec.user_id], [SID, ""]] as const) {
      const stub = stubFetch([list([measuredRow])]);
      await expect(listPeerIds(sid, uid, { fetch: stub.fetch })).rejects.toThrow(/session id and a participant user id/);
      expect(stub.calls.length).toBe(0);
      checked += 1;
    }
    expect(checked).toBe(2);
  });

  it("an unconfigured process refuses before any call", async () => {
    configure({ REALTIMEKIT_API_TOKEN: "" });
    const stub = stubFetch([]);
    await expect(listPeerIds(SID, rec.user_id, { fetch: stub.fetch })).rejects.toMatchObject({ code: "unconfigured" });
    expect(stub.calls.length).toBe(0);
  });
});

describe("listMeetingSessions", () => {
  // Every session a meeting ever had (T13, controller ruling C1): a REJOIN
  // after everyone left opens a NEW session, so one meeting's camera evidence
  // can span several. Shape from Cloudflare's published API reference
  // ("Fetch all sessions of an App": GET /sessions, `associated_id` = the
  // meeting id, `data.sessions[]` with id / associated_id / status LIVE|ENDED
  // / started_at / ended_at). NOT measured live — T17 owes that.
  const M = "mtg-7f3c";
  const session = (o: { id: string; meeting?: string; status?: string; started?: string; ended?: string | null }) => ({
    id: o.id,
    associated_id: o.meeting ?? M,
    status: o.status ?? "ENDED",
    started_at: o.started ?? "2026-10-11T10:00:00.000Z",
    ...(o.ended === null ? {} : { ended_at: o.ended ?? "2026-10-11T10:30:00.000Z" }),
  });
  /** The OpenAPI envelope: `paging.total_count` beside `data` (review M5) —
   *  the count of every session the query matched, on every page. */
  const page = (rows: unknown[], total: unknown = rows.length) => ({
    status: 200,
    body: { success: true, data: { sessions: rows }, paging: { total_count: total, start_offset: 0, end_offset: rows.length } },
  });

  it("returns this meeting's sessions in the API's order, asked by associated_id", async () => {
    configure();
    const stub = stubFetch([
      page([
        session({ id: "s-1", started: "2026-10-11T10:00:00.000Z", ended: "2026-10-11T10:20:00.000Z" }),
        session({ id: "s-2", status: "LIVE", started: "2026-10-11T10:21:00.000Z", ended: null }),
      ]),
    ]);
    expect(await listMeetingSessions(M, { fetch: stub.fetch })).toEqual([
      { id: "s-1", status: "ENDED", startedAt: "2026-10-11T10:00:00.000Z", endedAt: "2026-10-11T10:20:00.000Z" },
      { id: "s-2", status: "LIVE", startedAt: "2026-10-11T10:21:00.000Z", endedAt: null },
    ]);
    expect(stub.calls.map((c) => `${c.method} ${c.url.split("/realtime/kit/app-1")[1]}`)).toEqual([
      `GET /sessions?associated_id=${M}&per_page=100`,
    ]);
  });

  it("EMPTY: a meeting nobody ever joined has no sessions", async () => {
    configure();
    expect(await listMeetingSessions(M, { fetch: stubFetch([page([])]).fetch })).toEqual([]);
  });

  it("keeps only THIS meeting's sessions, whatever the filter returned", async () => {
    configure();
    const stub = stubFetch([page([session({ id: "s-other", meeting: "mtg-other" }), session({ id: "s-1" })])]);
    expect((await listMeetingSessions(M, { fetch: stub.fetch })).map((x) => x.id)).toEqual(["s-1"]);
  });

  it("fails CLOSED on a body it cannot read — never a short session list", async () => {
    configure();
    const full = Array.from({ length: 100 }, (_, i) => session({ id: `s-${i}` }));
    const cases: { name: string; first: { status: number; body?: unknown; text?: string }; code: string }[] = [
      { name: "an HTML 200", first: { status: 200, text: "<html>oops</html>" }, code: "unavailable" },
      { name: "no sessions list", first: { status: 200, body: { success: true, data: {} } }, code: "unavailable" },
      { name: "a row that is not an object", first: page([session({ id: "s-1" }), "row"]), code: "unavailable" },
      { name: "a row with no associated_id (it might be ours)", first: page([{ ...session({ id: "s-1" }), associated_id: undefined }]), code: "unavailable" },
      { name: "OUR row with no id", first: page([{ ...session({ id: "s-1" }), id: "" }]), code: "unavailable" },
      { name: "OUR row with a status outside LIVE | ENDED", first: page([session({ id: "s-1", status: "PAUSED" })]), code: "unavailable" },
      { name: "OUR row with no started_at", first: page([{ ...session({ id: "s-1" }), started_at: undefined }]), code: "unavailable" },
      { name: "OUR row with an ended_at that is not a date", first: page([session({ id: "s-1", ended: "later" })]), code: "unavailable" },
      // Review M5: completeness is the envelope's own count, never a guess.
      { name: "no paging at all", first: { status: 200, body: { success: true, data: { sessions: [session({ id: "s-1" })] } } }, code: "unavailable" },
      { name: "a total_count that is not a count", first: page([session({ id: "s-1" })], "1"), code: "unavailable" },
      { name: "a negative total_count", first: page([], -1), code: "unavailable" },
      { name: "MORE sessions than the page holds (a server cap under per_page)", first: page(full.slice(0, 40), 41), code: "unavailable" },
      { name: "a full page with more behind it", first: page(full, 101), code: "unavailable" },
      { name: "FEWER sessions than the page holds (an envelope that contradicts itself)", first: page(full.slice(0, 3), 2), code: "unavailable" },
      {
        name: "RealtimeKit's own 404 — never read as 'no sessions'",
        first: { status: 404, body: { success: false, error: { code: 404, message: "not found" } } },
        code: "not_found",
      },
    ];
    let checked = 0;
    for (const c of cases) {
      await expect(listMeetingSessions(M, { fetch: stubFetch([c.first]).fetch }), c.name).rejects.toMatchObject({
        name: "RealtimeKitError",
        code: c.code,
      });
      checked += 1;
    }
    expect(checked, "anti-vacuity").toBe(cases.length);
    // Positive controls: a page whose count says it is the whole list — a
    // short one, and a FULL one (the count, not the page size, decides).
    expect((await listMeetingSessions(M, { fetch: stubFetch([page(full.slice(0, 40))]).fetch })).length).toBe(40);
    expect((await listMeetingSessions(M, { fetch: stubFetch([page(full)]).fetch })).length).toBe(100);
  });

  it("refuses an empty meeting id, and an unconfigured process, before any call", async () => {
    configure();
    const stub = stubFetch([page([])]);
    await expect(listMeetingSessions("", { fetch: stub.fetch })).rejects.toThrow(/meeting id/);
    configure({ REALTIMEKIT_API_TOKEN: "" });
    await expect(listMeetingSessions(M, { fetch: stub.fetch })).rejects.toMatchObject({ code: "unconfigured" });
    expect(stub.calls.length).toBe(0);
  });
});

// ─── D21: the platform-wide call budget (T17B fix 2, review I2) ──────────────────────────────────────────────
// The vendor allows 1,200 calls per five minutes for the whole account and refuses EVERY call for five minutes past
// it. Every request this adapter makes spends a token first (budget.ts); over budget the request is NOT made and the
// caller is told `deferred` — a RealtimeKitError subtype every caller can still catch as "video, not now", and one
// that a caller can tell from an outage and from a camera that is off.
describe("the call budget (D21): every vendor request spends a token first, and a refused one is never made", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  const DEFAULT_KEY = budgetKey("https://api.cloudflare.com/client/v4", "acct-1");
  const refuse = vi.fn(async () => false);
  const live = { status: 200, body: { success: true, data: { id: "sess-b", status: "LIVE" } } };
  const peerRow = {
    id: "conn-1",
    user_id: "p-b",
    joined_at: "2026-10-01T12:00:00Z",
    left_at: null,
    peer_events: [{ event_name: "PEER_JOINING", peer_id: "peer-b", created_at: "2026-10-01T12:00:00Z" }],
  };
  const participantsOf = (rows: unknown[]) => ({ status: 200, body: { success: true, data: { participants: rows } } });

  /** Every adapter entry that reaches the vendor, with the OK answer its first request wants. */
  const ENTRIES: { name: string; ok: { status: number; body: unknown }[]; run: (deps: { fetch: typeof fetch; budget?: () => Promise<boolean> }) => Promise<unknown> }[] = [
    {
      name: "addParticipant",
      ok: [{ status: 201, body: { success: true, data: { id: "p-b", token: "t" } } }],
      run: (d) => addParticipant({ meetingId: "mtg-b", subject: "person-b", preset: "player" }, d),
    },
    {
      name: "refreshParticipantToken",
      ok: [{ status: 200, body: { success: true, data: { token: "t2" } } }],
      run: (d) => refreshParticipantToken({ meetingId: "mtg-b", participantId: "p-b" }, d),
    },
    {
      name: "removeParticipant",
      ok: [
        { status: 200, body: { success: true, data: {} } },
        { status: 200, body: { success: true, data: {} } },
      ],
      run: (d) => removeParticipant({ meetingId: "mtg-b", participantId: "p-b" }, d),
    },
    {
      name: "seatCameraEvidence",
      ok: [live, participantsOf([]),],
      run: (d) => seatCameraEvidence({ meetingId: "mtg-b", participantId: "p-b" }, d),
    },
    {
      name: "fetchVideoOffCoverage",
      ok: [{ status: 200, body: { success: true, data: { participant: { joined_at: "2026-10-01T12:00:00Z", left_at: "2026-10-01T12:30:00Z", peer_report: { metadata: { events: [] }, quality: { video_producer: [] } } } } } }],
      run: (d) => fetchVideoOffCoverage("peer-b", d).catch((e) => { if (e instanceof RealtimeKitDeferred) throw e; return "answered"; }),
    },
    {
      name: "listPeerIds",
      ok: [participantsOf([peerRow])],
      run: (d) => listPeerIds("sess-b", "p-b", d),
    },
    {
      name: "listMeetingSessions",
      ok: [{ status: 200, body: { success: true, data: { sessions: [] }, paging: { total_count: 0 } } }],
      run: (d) => listMeetingSessions("mtg-b", d),
    },
    {
      name: "endMeeting",
      ok: [
        { status: 200, body: { success: true, data: {} } },
        { status: 200, body: { success: true, data: {} } },
      ],
      run: (d) => endMeeting(mtg("budget-end"), d).catch((e) => { if (e instanceof RealtimeKitDeferred) throw e; return "answered"; }),
    },
  ];

  it("sweep: a refused request is never made — RealtimeKitDeferred (still a RealtimeKitError), code `deferred`, zero requests — and the same call, granted, is made", async () => {
    configure();
    let checked = 0;
    for (const e of ENTRIES) {
      const refused = stubFetch(e.ok);
      const budget = vi.fn(async () => false);
      const err = await e.run({ fetch: refused.fetch, budget }).then(() => null, (x: unknown) => x);
      expect(err, `${e.name}: a refused budget defers`).toBeInstanceOf(RealtimeKitDeferred);
      expect(err, `${e.name}: and stays catchable as the vendor's family`).toBeInstanceOf(RealtimeKitError);
      expect((err as RealtimeKitError).code, e.name).toBe("deferred");
      expect(refused.calls.length, `${e.name}: NO request made`).toBe(0);
      expect(budget, `${e.name}: asked exactly once, before the first request`).toHaveBeenCalledTimes(1);
      // The positive pair: a granted budget makes the request, and spends one token per request.
      const granted = stubFetch(e.ok);
      const spend = vi.fn(async () => true);
      await e.run({ fetch: granted.fetch, budget: spend });
      expect(granted.calls.length, `${e.name}: granted, it is made`).toBeGreaterThan(0);
      expect(spend, `${e.name}: one token per request`).toHaveBeenCalledTimes(granted.calls.length);
      checked += 1;
    }
    expect(checked, "anti-vacuity: every entry").toBe(ENTRIES.length);
  });

  it.skipIf(!process.env.DATABASE_URL)("ensureMeeting defers its create and writes no meeting row; the retry, granted, makes the meeting", async () => {
    configure();
    const s = await seedFixture();
    const stub = stubFetch([{ status: 200, body: { success: true, data: { id: mtg("budget-ens") } } }]);
    await expect(ensureMeeting(s.fixtureId, "home", { fetch: stub.fetch, budget: refuse })).rejects.toBeInstanceOf(RealtimeKitDeferred);
    expect(stub.calls.length).toBe(0);
    const [none] = await sql`select 1 from fixture_video_meetings where fixture_id = ${s.fixtureId}`;
    expect(none, "a deferral leaves no row").toBeUndefined();
    const ref = await ensureMeeting(s.fixtureId, "home", { fetch: stub.fetch, budget: async () => true });
    expect(ref).toEqual({ meetingId: mtg("budget-ens") });
  });

  it.skipIf(!process.env.DATABASE_URL)("endMeeting deferred leaves the row UNENDED, so the sweep's teardown retries it", async () => {
    configure();
    const s = await seedFixture();
    const id = mtg("budget-end2");
    await ensureMeeting(s.fixtureId, "home", { fetch: stubFetch([{ status: 200, body: { success: true, data: { id } } }]).fetch, budget: async () => true });
    const stub = stubFetch([]);
    await expect(endMeeting(id, { fetch: stub.fetch, budget: refuse })).rejects.toBeInstanceOf(RealtimeKitDeferred);
    const [row] = await sql<{ ended_at: Date | null }[]>`select ended_at from fixture_video_meetings where fixture_id = ${s.fixtureId}`;
    expect(row?.ended_at, "not ended").toBeNull();
  });

  it("a deferral on the THIRD request (the peer report) is rethrown — never folded into `unreadable`, which the seat would wait out and then call an outage", async () => {
    configure();
    const stub = stubFetch([live, participantsOf([peerRow])]);
    let n = 0;
    const budget = async () => ++n <= 2; // active-session and participants granted; the peer report refused
    await expect(seatCameraEvidence({ meetingId: "mtg-b", participantId: "p-b" }, { fetch: stub.fetch, budget })).rejects.toBeInstanceOf(RealtimeKitDeferred);
    expect(stub.calls.length, "the two granted requests were made; the refused one was not").toBe(2);
    // The positive pair: a vendor that FAILS the same read is `unreadable` — the distinction is the point.
    const failing = stubFetch([live, participantsOf([peerRow]), { status: 503, body: {} }]);
    const got = await seatCameraEvidence({ meetingId: "mtg-b", participantId: "p-b" }, { fetch: failing.fetch, budget: async () => true });
    expect(got.state).toBe("unreadable");
  });

  it("the spender is asked with the vendor host + account key, before the request, once per request", async () => {
    configure();
    const keys: string[] = [];
    const order: string[] = [];
    const stub = stubFetch([live, participantsOf([peerRow]), { status: 200, body: { success: true, data: { participant: { peer_report: { metadata: { events: [] } } } } } }]);
    const wrapped = (async (...a: Parameters<typeof fetch>) => {
      order.push("request");
      return (stub.fetch as unknown as (...x: Parameters<typeof fetch>) => ReturnType<typeof fetch>)(...a);
    }) as typeof fetch;
    await seatCameraEvidence({ meetingId: "mtg-b", participantId: "p-b" }, {
      fetch: wrapped,
      budget: async (k: string) => {
        keys.push(k);
        order.push("spend");
        return true;
      },
    } as never);
    expect(keys, "three requests, three spends, one bucket").toEqual([DEFAULT_KEY, DEFAULT_KEY, DEFAULT_KEY]);
    expect(order, "each spend precedes its request").toEqual(["spend", "request", "spend", "request", "spend", "request"]);
  });

  it("a deferral message names no secret and no body, like every adapter failure", async () => {
    configure();
    const err = (await refreshParticipantToken({ meetingId: "mtg-b", participantId: "p-b" }, { fetch: stubFetch([]).fetch, budget: refuse }).catch((e) => e)) as RealtimeKitDeferred;
    expect(err.message).not.toContain("cf-token-do-not-leak-0123456789");
    expect(err.status).toBe(429);
    expect(err.name).toBe("RealtimeKitDeferred");
  });

  describe.skipIf(!process.env.DATABASE_URL)("the PRODUCTION path (no fetch, no budget passed): metered by the real database bucket", () => {
    /** The real Cloudflare base URL (REALTIMEKIT_BASE_URL unset) on an account id no other test or run shares, so this
     *  drains nobody else's bucket and nobody else's drains it. */
    function onTheVendor() {
      configure();
      vi.stubEnv("REALTIMEKIT_BASE_URL", undefined);
      const account = `acct-budget-${randomUUID()}`;
      vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", account);
      return budgetKey("https://api.cloudflare.com/client/v4", account);
    }
    const okBody = () => new Response(JSON.stringify({ success: true, data: { token: "t" } }), { status: 200, headers: { "content-type": "application/json" } });
    const args = { meetingId: "mtg-b", participantId: "p-b" };

    it("global fetch stubbed, the real bucket drained: the request is never made; before it was drained, it was — and cost one token", async () => {
      const key = onTheVendor();
      try {
        const calls: string[] = [];
        vi.stubGlobal("fetch", async (url: string | URL) => {
          calls.push(String(url));
          return okBody();
        });
        await refreshParticipantToken(args, {});
        expect(calls.length, "a fresh bucket lets the request through").toBe(1);
        expect(calls[0]!.startsWith("https://api.cloudflare.com/client/v4/")).toBe(true);
        const [row] = await sql<{ tokens: number }[]>`select tokens from realtimekit_call_budget where key = ${key}`;
        expect(row!.tokens, "the request cost one token").toBeLessThan(RTK_BUDGET_BURST);
        expect(row!.tokens).toBeGreaterThan(RTK_BUDGET_BURST - 2);
        let drained = 0;
        while (await takeRealtimeKitCall(key)) drained += 1;
        expect(drained, "anti-vacuity: there was something to drain").toBeGreaterThan(RTK_BUDGET_BURST - 5);
        await expect(refreshParticipantToken(args, {})).rejects.toBeInstanceOf(RealtimeKitDeferred);
        expect(calls.length, "the refused request never reached the network").toBe(1);
      } finally {
        await sql`delete from realtimekit_call_budget where key = ${key}`;
      }
    });

    it("a caller-supplied fetch (a test double) on Cloudflare's own base spends nothing either — the bucket for it is never made", async () => {
      const key = onTheVendor();
      const stub = stubFetch([{ status: 200, body: { success: true, data: { token: "t" } } }]);
      await refreshParticipantToken(args, { fetch: stub.fetch });
      expect(stub.calls.length).toBe(1);
      expect(await sql`select key from realtimekit_call_budget where key = ${key}`, "no token taken, no bucket made").toHaveLength(0);
    });

    it("a base URL that is NOT Cloudflare's (a fixture, a proxy) spends no account's budget — the bucket for it is never made", async () => {
      configure();
      const base = `http://127.0.0.1:${40_000 + Math.floor(Math.random() * 20_000)}`;
      vi.stubEnv("REALTIMEKIT_BASE_URL", base);
      let calls = 0;
      vi.stubGlobal("fetch", async () => {
        calls += 1;
        return okBody();
      });
      await refreshParticipantToken(args, {});
      await refreshParticipantToken(args, { baseUrl: `${base}/other` });
      expect(calls, "both requests were made").toBe(2);
      const rows = await sql`select key from realtimekit_call_budget where key like ${base + "%"}`;
      expect(rows.length, "and neither spent a token").toBe(0);
    });

    // D22: the load test (and a deployment that reaches the real account through a forwarding proxy) needs the budget ON
    // for a base that is not Cloudflare's. REALTIMEKIT_METER_ANY_BASE=1 says so; the bucket is keyed by that base + account.
    describe("REALTIMEKIT_METER_ANY_BASE=1: a non-Cloudflare base is metered like the vendor (D22)", () => {
      const freshBase = () => `http://127.0.0.1:${40_000 + Math.floor(Math.random() * 20_000)}`;
      it.skipIf(!process.env.DATABASE_URL)("on: each request takes a token from the bucket of THAT base and account; a drained bucket defers WITHOUT making the request - off: no bucket at all", async () => {
        let checked = 0;
        for (const on of [false, true]) {
          configure();
          const base = freshBase();
          vi.stubEnv("REALTIMEKIT_BASE_URL", base);
          vi.stubEnv("REALTIMEKIT_METER_ANY_BASE", on ? "1" : "");
          let calls = 0;
          vi.stubGlobal("fetch", async () => {
            calls += 1;
            return okBody();
          });
          const key = budgetKey(base, "acct-1");
          try {
            await refreshParticipantToken(args, {});
            await refreshParticipantToken(args, {});
            expect(calls, `${on ? "on" : "off"}: both requests were made`).toBe(2);
            const [row] = await sql<{ tokens: number }[]>`select tokens from realtimekit_call_budget where key = ${key}`;
            if (!on) {
              expect(row, "off: the bucket is never made").toBeUndefined();
            } else {
              expect(row?.tokens, "on: two tokens spent from a full bucket").toBeCloseTo(RTK_BUDGET_BURST - 2, 0);
              // Drained, and stamped an hour AHEAD so no refill lands before the assertion.
              await sql`update realtimekit_call_budget set tokens = 0, refilled_at = now() + interval '1 hour' where key = ${key}`;
              await expect(refreshParticipantToken(args, {})).rejects.toBeInstanceOf(RealtimeKitDeferred);
              expect(calls, "on, drained: the request was NOT made").toBe(2);
            }
            checked += 1;
          } finally {
            await sql`delete from realtimekit_call_budget where key = ${key}`;
          }
        }
        expect(checked, "anti-vacuity").toBe(2);
      });

      it.skipIf(!process.env.DATABASE_URL)("any value but 1 leaves it off (an unset, empty, 'true', 'yes', '0' or '01' flag meters nothing: no bucket is made for the base)", async () => {
        let checked = 0;
        for (const value of ["", "0", "true", "yes", "01", " 1"]) {
          configure();
          const base = freshBase();
          vi.stubEnv("REALTIMEKIT_BASE_URL", base);
          vi.stubEnv("REALTIMEKIT_METER_ANY_BASE", value);
          let calls = 0;
          vi.stubGlobal("fetch", async () => {
            calls += 1;
            return okBody();
          });
          await refreshParticipantToken(args, {});
          expect(calls, `"${value}": the request was made`).toBe(1);
          const rows = await sql`select 1 from realtimekit_call_budget where key = ${budgetKey(base, "acct-1")}`;
          expect(rows.length, `"${value}": not metered - a metered call would have made the bucket`).toBe(0);
          checked += 1;
        }
        expect(checked).toBe(6);
      });
    });

    it("the same non-Cloudflare base, with a budget PASSED (a load test, a suite proving the refusal), is metered like the vendor", async () => {
      configure();
      vi.stubEnv("REALTIMEKIT_BASE_URL", "http://127.0.0.1:41999");
      vi.stubGlobal("fetch", async () => okBody());
      await expect(refreshParticipantToken(args, { budget: refuse })).rejects.toBeInstanceOf(RealtimeKitDeferred);
    });

    // D21-fix m1: the gate (`base === Cloudflare's`) FAILS OPEN - a forwarding proxy in front of the real account, or a
    // misspelt URL, is not metered and nothing said so. Production now warns, once per process, naming the base.
    describe("an unmetered base in production says so, once (m1)", () => {
      const PROXY = "http://proxy.example.test:8080";
      /** A fresh adapter (the once-flag is module state) and the logger IT logs to. */
      async function freshAdapter() {
        vi.resetModules();
        const { log } = await import("@/server/logger");
        const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
        const adapter = await import("../realtimekit");
        return { warn, adapter };
      }
      const unmeteredWarnings = (warn: { mock: { calls: unknown[][] } }) => warn.mock.calls.filter((c) => /does not meter/.test(String(c[1])));

      it("production, a base that is not Cloudflare's, the real fetch: ONE warning naming the base, however many calls follow - and never the token", async () => {
        configure();
        vi.stubEnv("NODE_ENV", "production");
        vi.stubEnv("REALTIMEKIT_BASE_URL", PROXY);
        vi.stubGlobal("fetch", async () => okBody());
        const { warn, adapter } = await freshAdapter();
        for (let i = 0; i < 3; i += 1) await adapter.refreshParticipantToken(args, {});
        const warnings = unmeteredWarnings(warn);
        expect(warnings, "once per process").toHaveLength(1);
        expect(warnings[0]![0], "the origin, under the name it is: not the URL").toEqual({ origin: PROXY });
        expect(JSON.stringify(warn.mock.calls), "no credential in the log").not.toContain("cf-token-do-not-leak");
      });

      // D21-fix N2: a base URL can carry credentials (https://user:secret@host) and a path; the log gets the ORIGIN only.
      it("a base URL with credentials and a path: the warning names the origin and neither the userinfo nor the path - and an unreadable base is named as such, never echoed", async () => {
        let checked = 0;
        for (const [base, origin] of [
          ["http://proxy-user:s3cr3t-pw@proxy.example.test:8080/rtk/prefix", "http://proxy.example.test:8080"],
          ["not a url but s3cr3t-pw is in it", "(unreadable)"],
        ] as const) {
          configure();
          vi.stubEnv("NODE_ENV", "production");
          vi.stubEnv("REALTIMEKIT_BASE_URL", base);
          vi.stubGlobal("fetch", async () => okBody());
          const { warn, adapter } = await freshAdapter();
          await adapter.refreshParticipantToken(args, {}).catch(() => undefined);
          const warnings = unmeteredWarnings(warn);
          expect(warnings, `${origin}: warned once`).toHaveLength(1);
          expect(warnings[0]![0]).toEqual({ origin });
          const logged = JSON.stringify(warn.mock.calls);
          for (const secret of ["proxy-user", "s3cr3t-pw", "/rtk/prefix"]) expect(logged, `${origin}: ${secret} is not in the log`).not.toContain(secret);
          checked += 1;
        }
        expect(checked, "anti-vacuity").toBe(2);
      });

      it("not in production (a test, a dev machine): silent - a fixture is the point there", async () => {
        configure();
        vi.stubEnv("NODE_ENV", "test");
        vi.stubEnv("REALTIMEKIT_BASE_URL", PROXY);
        vi.stubGlobal("fetch", async () => okBody());
        const { warn, adapter } = await freshAdapter();
        await adapter.refreshParticipantToken(args, {});
        expect(unmeteredWarnings(warn)).toHaveLength(0);
      });

      it.skipIf(!process.env.DATABASE_URL)("production, a non-Cloudflare base the operator chose to METER (REALTIMEKIT_METER_ANY_BASE=1): silent - there is no gap to warn about", async () => {
        configure();
        vi.stubEnv("NODE_ENV", "production");
        vi.stubEnv("REALTIMEKIT_BASE_URL", PROXY);
        vi.stubEnv("REALTIMEKIT_METER_ANY_BASE", "1");
        vi.stubGlobal("fetch", async () => okBody());
        const { warn, adapter } = await freshAdapter();
        const key = budgetKey(PROXY, "acct-1");
        try {
          await adapter.refreshParticipantToken(args, {});
          const [row] = await sql<{ tokens: number }[]>`select tokens from realtimekit_call_budget where key = ${key}`;
          expect(row?.tokens, "premise: the call was metered (a bucket was made for the base)").toBeLessThan(RTK_BUDGET_BURST);
          expect(unmeteredWarnings(warn)).toHaveLength(0);
        } finally {
          // Not `sql.end()`: lib/db keeps one client for the process, and the test below still needs it.
          await sql`delete from realtimekit_call_budget where key = ${key}`;
        }
      });

      it("production with a caller's own fetch or budget (a suite, a load test that chose it): silent", async () => {
        configure();
        vi.stubEnv("NODE_ENV", "production");
        vi.stubEnv("REALTIMEKIT_BASE_URL", PROXY);
        const { warn, adapter } = await freshAdapter();
        const stub = stubFetch([{ status: 200, body: { success: true, data: { token: "t" } } }]);
        await adapter.refreshParticipantToken(args, { fetch: stub.fetch });
        vi.stubGlobal("fetch", async () => okBody());
        await adapter.refreshParticipantToken(args, { budget: async () => true });
        expect(unmeteredWarnings(warn)).toHaveLength(0);
      });

      it.skipIf(!process.env.DATABASE_URL)("production on Cloudflare's own base (metered): silent - the warning is about the GAP, not about production", async () => {
        const key = onTheVendor();
        vi.stubEnv("NODE_ENV", "production");
        vi.stubGlobal("fetch", async () => okBody());
        const { warn, adapter } = await freshAdapter();
        try {
          await adapter.refreshParticipantToken(args, {});
          expect(unmeteredWarnings(warn)).toHaveLength(0);
        } finally {
          await sql`delete from realtimekit_call_budget where key = ${key}`;
          const fresh = await import("@/lib/db");
          await fresh.sql.end({ timeout: 1 });
        }
      });
    });
  });
});
