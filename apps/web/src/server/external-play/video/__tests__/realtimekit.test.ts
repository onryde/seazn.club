import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sql } from "@/lib/db";
import { seedOnlineChessFixture } from "@/server/usecases/__tests__/_external-play-seed";
import {
  RealtimeKitError,
  addParticipant,
  endMeeting,
  ensureMeeting,
  hasLiveVideoPublisher,
  realtimeKitConfigured,
} from "../realtimekit";

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
        fetch: stubFetch([{ status, body: echo }]).fetch,
        code: status === 404 ? "not_found" : status === 401 || status === 403 ? "unauthorized" : "unavailable",
      })),
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
    expect(checked).toBeGreaterThanOrEqual(9);
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

describe("hasLiveVideoPublisher", () => {
  const SESSION = "sess-1";
  const ME = "p-1"; // the participantId addParticipant returned
  const live = { status: 200, body: { success: true, data: { id: SESSION, status: "LIVE" } } };
  const ended = { status: 200, body: { success: true, data: { id: SESSION, status: "ENDED" } } };
  const noSession = { status: 404, body: { success: false, error: { code: 404, message: "no active session" } } };
  const participants = (rows: unknown[]) => ({
    status: 200,
    body: { success: true, data: { participants: rows } },
  });
  /** A session-participant row. `id` is RealtimeKit's per-CONNECTION id and
   *  `user_id` the persistent participant id addParticipant returned — the
   *  recorded payload has them as two different values (README beside it). */
  const row = (userId: string, leftAt: string | null, n = 0) => ({
    id: `conn-${userId}-${n}`,
    user_id: userId,
    custom_participant_id: "s",
    joined_at: "2026-10-01T12:00:00Z",
    left_at: leftAt,
  });

  it("sweeps every reachable state and reports the count", async () => {
    configure();
    const rec = RECORDED.data.participant;
    // Premise for the recorded-shape case: the per-connection id and the
    // persistent participant id really are different values.
    expect(rec.id, "premise: recorded row has distinct id and user_id").not.toBe(rec.user_id);
    const cases: { name: string; me?: string; responses: { status: number; body: unknown }[]; want: boolean }[] = [
      { name: "empty case: no active session at all", responses: [noSession], want: false },
      { name: "session exists but has ENDED", responses: [ended], want: false },
      { name: "live session, nobody in the participant list", responses: [live, participants([])], want: false },
      {
        name: "live session, our participant has never joined",
        responses: [live, participants([row("someone-else", null)])],
        want: false,
      },
      {
        name: "live session, our participant joined and LEFT",
        responses: [live, participants([row(ME, "2026-10-01T12:05:00Z")])],
        want: false,
      },
      {
        name: "live session, our participant is joined and present",
        responses: [live, participants([row(ME, null)])],
        want: true,
      },
      {
        name: "present row whose left_at key is ABSENT, not null",
        responses: [live, participants([{ id: "conn-x", user_id: ME, joined_at: "2026-10-01T12:00:00Z" }])],
        want: true,
      },
      {
        // Matching on the row's `id` (the brief's original predicate) would
        // never see this participant: that is a per-connection id.
        name: "recorded row shape: matched by user_id, present",
        me: rec.user_id,
        responses: [live, participants([{ ...rec, peer_report: undefined, left_at: null }])],
        want: true,
      },
      {
        name: "a row whose per-connection id equals our participantId but belongs to someone else",
        responses: [live, participants([{ ...row("someone-else", null), id: ME }])],
        want: false,
      },
      {
        name: "SEQUENCE: reloaded — old connection LEFT, new connection present",
        responses: [live, participants([row(ME, "2026-10-01T12:03:00Z", 1), row(ME, null, 2)])],
        want: true,
      },
      {
        name: "SEQUENCE: same rows, newest first",
        responses: [live, participants([row(ME, null, 2), row(ME, "2026-10-01T12:03:00Z", 1)])],
        want: true,
      },
      {
        name: "SEQUENCE: reloaded twice and finally left — every connection has left",
        responses: [
          live,
          participants([row(ME, "2026-10-01T12:03:00Z", 1), row(ME, "2026-10-01T12:09:00Z", 2)]),
        ],
        want: false,
      },
    ];
    let checked = 0;
    const outcomes = new Set<boolean>();
    for (const c of cases) {
      const stub = stubFetch(c.responses);
      const got = await hasLiveVideoPublisher(
        { meetingId: "mtg-1", participantId: c.me ?? ME },
        { fetch: stub.fetch },
      );
      expect(got, c.name).toBe(c.want);
      expect(stub.calls.length, `${c.name}: every scripted response was used`).toBe(c.responses.length);
      outcomes.add(got);
      checked += 1;
    }
    expect(checked, "anti-vacuity: every state the REST API can report").toBe(cases.length);
    expect(checked).toBeGreaterThanOrEqual(12);
    expect(outcomes.size, "a predicate that only ever answers one way proves nothing").toBe(2);
  });

  it("reads the active session, then that session's participants at the maximum page size", async () => {
    configure();
    const stub = stubFetch([live, participants([row(ME, null)])]);
    await hasLiveVideoPublisher({ meetingId: "mtg-1", participantId: ME }, { fetch: stub.fetch });
    expect(stub.calls.map((c) => `${c.method} ${c.url.split("/realtime/kit/app-1")[1]}`)).toEqual([
      "GET /meetings/mtg-1/active-session",
      // per_page defaults to 25 (OpenAPI); every reload adds a row, so ask for
      // the maximum, 200.
      `GET /sessions/${SESSION}/participants?per_page=200`,
    ]);
  });

  it("does not ask for the participant list at all when the session is not live", async () => {
    configure();
    const stub = stubFetch([ended]); // a second call throws
    expect(await hasLiveVideoPublisher({ meetingId: "mtg-1", participantId: ME }, { fetch: stub.fetch })).toBe(false);
    expect(stub.calls.length).toBe(1);
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
        responses: [live, { status: 404, body: { success: false } }],
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
        hasLiveVideoPublisher({ meetingId: "mtg-1", participantId: ME }, { fetch: stub.fetch }),
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
    const ok = stubFetch([live, participants(withMe)]);
    expect(await hasLiveVideoPublisher({ meetingId: "mtg-1", participantId: ME }, { fetch: ok.fetch })).toBe(true);
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
    await ensureMeeting(s.fixtureId, { fetch: create.fetch });
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
    // Order matters and so does this case: at T+20 with nobody present
    // there IS no session to kick, and skipping the PATCH would leave a
    // joinable meeting behind.
    configure();
    const stub = stubFetch([noActive, inactive]);
    await endMeeting(mtg("quiet"), { fetch: stub.fetch });
    expect(stub.calls.length).toBe(2);
    expect(stub.calls[1]?.method).toBe("PATCH");
  });

  it("SEQUENCE: ensure → end → ensure refuses (409) with no HTTP call", async () => {
    configure();
    const s = await seedFixture();
    const id = mtg("seq");
    await ensureMeeting(s.fixtureId, { fetch: stubFetch([{ status: 200, body: { success: true, data: { id } } }]).fetch });
    await endMeeting(id, { fetch: stubFetch([kicked, inactive]).fetch });
    const after = stubFetch([{ status: 200, body: { success: true, data: { id: mtg("seq-orphan") } } }]);
    await expect(ensureMeeting(s.fixtureId, { fetch: after.fetch })).rejects.toMatchObject({
      status: 409,
      code: "VIDEO_MEETING_ENDED",
    });
    expect(after.calls.length, "no billable meeting is created after teardown").toBe(0);
  });

  it("SEQUENCE: a second endMeeting is harmless and keeps the FIRST ended_at", async () => {
    configure();
    const s = await seedFixture();
    const id = mtg("twice");
    await ensureMeeting(s.fixtureId, { fetch: stubFetch([{ status: 200, body: { success: true, data: { id } } }]).fetch });
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

  it("a failed deactivate leaves the row UNSTAMPED, so the next sweep tries again", async () => {
    configure();
    const s = await seedFixture();
    const id = mtg("patch-fails");
    await ensureMeeting(s.fixtureId, { fetch: stubFetch([{ status: 200, body: { success: true, data: { id } } }]).fetch });
    const stub = stubFetch([kicked, { status: 500, body: { success: false } }]);
    await expect(endMeeting(id, { fetch: stub.fetch })).rejects.toMatchObject({ code: "unavailable" });
    expect(stub.calls.length, "premise: the PATCH was attempted").toBe(2);
    expect(await endedAt(id), "still joinable upstream, so not recorded as ended").toBeNull();
  });

  it("a kick that fails for any reason other than 404 throws before deactivating", async () => {
    configure();
    const s = await seedFixture();
    const id = mtg("kick-fails");
    await ensureMeeting(s.fixtureId, { fetch: stubFetch([{ status: 200, body: { success: true, data: { id } } }]).fetch });
    const stub = stubFetch([{ status: 500, body: { success: false } }, inactive]);
    await expect(endMeeting(id, { fetch: stub.fetch })).rejects.toMatchObject({ code: "unavailable" });
    expect(stub.calls.length).toBe(1);
    expect(await endedAt(id)).toBeNull();
  });

  it("an unconfigured process refuses before any call", async () => {
    configure({ CLOUDFLARE_API_TOKEN: "" });
    const stub = stubFetch([]);
    await expect(endMeeting(mtg("unconfigured"), { fetch: stub.fetch })).rejects.toMatchObject({
      code: "unconfigured",
    });
    expect(stub.calls.length).toBe(0);
  });
});
