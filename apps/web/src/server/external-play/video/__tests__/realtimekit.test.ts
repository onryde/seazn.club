import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sql } from "@/lib/db";
import { seedOnlineChessFixture } from "@/server/usecases/__tests__/_external-play-seed";
import { RealtimeKitError, ensureMeeting, realtimeKitConfigured } from "../realtimekit";

const ENV_KEYS = [
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_API_TOKEN",
  "REALTIMEKIT_APP_ID",
  "REALTIMEKIT_PLAYER_PRESET",
  "REALTIMEKIT_ARBITER_PRESET",
] as const;

function configure(overrides: Partial<Record<(typeof ENV_KEYS)[number], string>> = {}) {
  const full: Record<string, string> = {
    CLOUDFLARE_ACCOUNT_ID: "acct-1",
    CLOUDFLARE_API_TOKEN: "cf-token-do-not-leak-0123456789",
    REALTIMEKIT_APP_ID: "app-1",
    REALTIMEKIT_PLAYER_PRESET: "seazn_chess_player",
    REALTIMEKIT_ARBITER_PRESET: "seazn_chess_arbiter",
  };
  for (const k of ENV_KEYS) vi.stubEnv(k, overrides[k] ?? full[k]!);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("realtimeKitConfigured", () => {
  it("sweeps every combination of the five required variables and reports the count", () => {
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
      const got = realtimeKitConfigured();
      expect(got, `mask ${mask}`).toBe(mask === 0);
      if (got) configured += 1;
      checked += 1;
      vi.unstubAllEnvs();
    }
    expect(checked, "anti-vacuity: 2^5 combinations").toBe(32);
    expect(configured, "exactly one combination is fully configured").toBe(1);
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
function stubFetch(responses: { status: number; body: unknown }[]) {
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
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { "content-type": "application/json" },
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
    const ref = await ensureMeeting(s.fixtureId, { fetch: stub.fetch });
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
    await ensureMeeting(s.fixtureId, { fetch: first.fetch });
    const second = stubFetch([]); // any call throws
    const again = await ensureMeeting(s.fixtureId, { fetch: second.fetch });
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
          insert into fixture_video_meetings (fixture_id, org_id, meeting_id)
          values (${s.fixtureId}, ${s.orgId}, ${winner})`;
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
    const ref = await ensureMeeting(s.fixtureId, { fetch: fetchFn as unknown as typeof fetch });
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
    await expect(ensureMeeting(s.fixtureId, { fetch: stub.fetch })).rejects.toMatchObject({
      name: "RealtimeKitError",
      code: "unconfigured",
    });
    expect(stub.calls.length).toBe(0);
  });

  // fixture_id is the table's PRIMARY KEY, so an ended meeting still occupies
  // the fixture's only row. Without this refusal the insert below conflicts,
  // the "lost race" branch deactivates a brand-new billable meeting, and the
  // caller is handed the ENDED (INACTIVE, unjoinable) meeting as if it were
  // live. A fixture's meeting is torn down at the result or at T+20 (spec
  // §5.2); there is nothing left to join after that.
  it("after teardown: refuses with 409 and makes NO HTTP call (no billable orphan)", async () => {
    configure();
    const s = await seedFixture();
    const ended = mtg("ended");
    await sql`
      insert into fixture_video_meetings (fixture_id, org_id, meeting_id, ended_at)
      values (${s.fixtureId}, ${s.orgId}, ${ended}, now())`;
    // Positive control: the stub WOULD hand out a fresh meeting if asked, so
    // the zero-call assertion below is a decision, not a stub that refused.
    const stub = stubFetch([
      { status: 200, body: { success: true, data: { id: mtg("would-be-orphan") } } },
      { status: 200, body: { success: true, data: {} } },
    ]);
    await expect(ensureMeeting(s.fixtureId, { fetch: stub.fetch })).rejects.toMatchObject({
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
          insert into fixture_video_meetings (fixture_id, org_id, meeting_id, ended_at)
          values (${s.fixtureId}, ${s.orgId}, ${mtg("ended-winner")}, now())`;
        return new Response(JSON.stringify({ success: true, data: { id: orphan } }), { status: 200 });
      }
      return new Response(JSON.stringify({ success: true, data: {} }), { status: 200 });
    });
    await expect(
      ensureMeeting(s.fixtureId, { fetch: fetchFn as unknown as typeof fetch }),
    ).rejects.toMatchObject({ status: 409, code: "VIDEO_MEETING_ENDED" });
    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch?.url, "our own meeting is still stood down").toContain(`/meetings/${orphan}`);
    expect(patch?.body).toEqual({ status: "INACTIVE" });
  });
});
