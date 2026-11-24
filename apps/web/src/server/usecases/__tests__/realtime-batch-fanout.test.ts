// Realtime push-nudges T0.2 — ONE broadcast per schedule write and per score.
//
// Before: `afterScheduleWrite` sent one POST for its division and one per fixture it moved (N + 1 requests for N
// fixtures), and a score sent one for its fixture, one for its division and one per fixture it advanced a name into.
// Now each write hands its whole message list to ONE `broadcast()` call, which sends one POST per 100 messages: under the
// 50-fixture push cap, exactly one.
//
// What is counted is real. `@/lib/realtime` is NOT mocked here: `fetch` is a spy, the Supabase URL and service key are
// stubbed, and `REALTIME_PUBLISH` is unset (the repo's .env.local sets it), so every POST `broadcast()` really sends is one
// call of the spy. Only calls to the broadcast endpoint are counted.
//
// Expected values come from the rulings and the database, never from the module under test: the per-fixture push cap is
// the owner's 50 (R10d n2), the division events are the golden wire bodies' (`lib/__tests__/realtime-publish.test.ts`:
// `schedule_changed` for a schedule write, `state_changed` for a score), and the fixtures a score advanced a name into or a
// void emptied are read from the bracket's own links and lineups before and after the write.
//
// Sequence (TEST-STRATEGY): the empty case (a write that moved no fixture), a second write (a second POST, never merged
// into the first), after a void (the seats the void emptied ride the void's one POST), and another surface:
// `voidLineEvents` is NOT batched by this task (Task 10 batches it) and still sends one POST per publisher.
//
// The schedule half needs no database and always runs; the score, real-writer and void-lines halves need Postgres and
// skip without DATABASE_URL.
//
// Applies to another sport: N/A (no sport rules).
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const probe = vi.hoisted(() => ({
  /** When set, `invalidatePublicCache`'s one scope lookup answers no row (a fixture deleted mid-write). */
  blankLookup: false,
  blankHits: 0,
}));

// Every public literal-key DEL settles at once, so the pushes chained on it go out on the next tick. No real Redis.
vi.mock("@/lib/cache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/cache")>();
  return {
    ...actual,
    cacheDel: (...keys: string[]) =>
      keys.length > 0 && keys.every((key) => key.startsWith("pub:v1:")) ? Promise.resolve() : actual.cacheDel(...keys),
  };
});
// A passthrough. Armed by the scope-null case only: the one statement that reads the fixture's division, competition and
// org (`invalidatePublicCache`, scoring.ts) answers no row, exactly as it does when the fixture is gone.
vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  return {
    ...actual,
    // The third argument (`opts`: `privilegedPrelude` / `privilegedEpilogue`) passes through, armed or not.
    withTenant: (
      orgId: string,
      fn: Parameters<typeof actual.withTenant>[1],
      opts?: Parameters<typeof actual.withTenant>[2],
    ) =>
      actual.withTenant(
        orgId,
        (tx) => {
          if (!probe.blankLookup) return fn(tx);
          const handed = new Proxy(tx, {
            apply(target, thisArg, args: unknown[]) {
              const strings = args[0];
              if (Array.isArray(strings) && "raw" in strings && strings.join("").includes("c.org_id, c.discoverable")) {
                probe.blankHits += 1;
                return Promise.resolve([]);
              }
              return Reflect.apply(target, thisArg, args);
            },
          });
          return fn(handed);
        },
        opts,
      ),
  };
});
// A deciding score schedules a player-stats refresh, which (with no request scope) runs at once and pushes its own
// division `score`. That push is its own (`player-stats-refresh.test.ts`); this file counts the write's.
vi.mock("../player-stats-refresh", () => ({ schedulePlayerStatsRefresh: () => {} }));
vi.mock("@/lib/posthog-server", async (orig) => ({
  ...(await orig<typeof import("@/lib/posthog-server")>()),
  captureServer: vi.fn(),
}));

import { randomUUID } from "node:crypto";
import { builtinModules } from "@seazn/engine/sports";
import type { AnySportModule } from "@seazn/engine/sport";
import { sql } from "@/lib/db";
import { nudgesSettled } from "../stream-sessions/nudge";
import { afterScheduleWrite, moveFixture, startDivision } from "../schedule";
import { scoreEvent } from "../scoring";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages, generateStageFixtures } from "../stages";
import { withdrawEntrantCascade } from "../withdrawal";
import { voidLineEvents } from "../void-lines";
import { divisionRig, seedOrg as seedGenericOrg } from "./_rig";
import { GENERIC_CONFIG, seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

const SUPABASE = "https://rtn-batch.example.supabase.co";
const BROADCAST_URL = `${SUPABASE}/realtime/v1/api/broadcast`;
const DIVISION = "div-batch";
const COMPETITION = "comp-batch";

type WireMessage = { topic: string; event: string; payload: { reason: string }; private?: boolean };
/** What a test compares: the topic, event, reason and whether the message is private. */
type Shape = { topic: string; event: string; reason: string; private: boolean };

const fetchSpy = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
  void input;
  void init;
  return new Response(null, { status: 202 });
});

/** Every POST sent to the broadcast endpoint, as the messages each one carried, in send order. */
function posts(): Shape[][] {
  return fetchSpy.mock.calls
    .filter(([input]) => String(input) === BROADCAST_URL)
    .map(([, init]) => {
      expect(init?.method, "a broadcast is a POST").toBe("POST");
      const { messages } = JSON.parse(String(init?.body)) as { messages: WireMessage[] };
      return messages.map((m) => ({ topic: m.topic, event: m.event, reason: m.payload.reason, private: m.private === true }));
    });
}

const divisionSchedule = (id: string, reason: string): Shape => ({
  topic: `division:${id}`, event: "schedule_changed", reason, private: false,
});
const divisionScore = (id: string): Shape => ({ topic: `division:${id}`, event: "state_changed", reason: "score", private: false });
const fixtureMsg = (id: string, reason: "event" | "schedule"): Shape => ({
  topic: `fixture:${id}`, event: "state_changed", reason, private: true,
});

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
/** The DEL settles at once; a macrotask later every push chained on it has been sent. A schedule write's push first makes the one
 *  pooled read of its courts' phones (T1.5, bounded and best-effort), so the pushes in flight are awaited too: under load that read
 *  outlasts the 30 ms, and the write's POST would land in the NEXT step's count. */
const settled = async () => {
  await sleep(30);
  await nudgesSettled();
};

beforeEach(() => {
  fetchSpy.mockClear();
  probe.blankLookup = false;
  probe.blankHits = 0;
  vi.stubGlobal("fetch", fetchSpy);
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", SUPABASE);
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role");
  vi.stubEnv("REALTIME_PUBLISH", undefined);
});

afterEach(async () => {
  // A push still in flight lands on THIS test's spy, never the next one's.
  await settled();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

const ids = (n: number, tag = "fx") => Array.from({ length: n }, (_, i) => `${tag}-${i}`);

describe("afterScheduleWrite sends ONE broadcast: the division and every fixture it moved, in one POST", () => {
  // [fixtures moved, reason]. 50 is the owner's per-fixture push cap (R10d n2), written here, never read back.
  it.each([
    [1, "schedule"],
    [50, "publish"],
  ] as const)("%i moved fixture(s), a %s write: exactly ONE POST, carrying the division message and one per fixture", async (n, reason) => {
    const moved = ids(n);
    afterScheduleWrite(DIVISION, COMPETITION, reason, moved);
    await settled();
    const sent = posts();
    expect(sent, `one POST for ${n} fixtures and their division (before T0.2: ${n + 1})`).toHaveLength(1);
    expect(sent[0], "anti-vacuity: the POST carried every message").toHaveLength(n + 1);
    expect(sent[0]).toEqual([divisionSchedule(DIVISION, reason), ...moved.map((id) => fixtureMsg(id, "schedule"))]);
  });

  it("51 moved fixtures (past the cap): ONE POST with the division message only", async () => {
    afterScheduleWrite(DIVISION, COMPETITION, "start", ids(51));
    await settled();
    expect(posts()).toEqual([[divisionSchedule(DIVISION, "start")]]);
  });

  it("the empty case, a write that moved no fixture: ONE POST with the division message", async () => {
    afterScheduleWrite(DIVISION, COMPETITION, "publish", []);
    await settled();
    expect(posts()).toEqual([[divisionSchedule(DIVISION, "publish")]]);
  });

  it("`fixturePushes: false` (a quick match's create): ONE POST with the division message only", async () => {
    afterScheduleWrite(DIVISION, COMPETITION, "start", ids(3), { fixturePushes: false });
    await settled();
    expect(posts()).toEqual([[divisionSchedule(DIVISION, "start")]]);
  });

  it("a second write sends a second POST of its own, never merged into the first", async () => {
    afterScheduleWrite(DIVISION, COMPETITION, "schedule", ["fx-a"]);
    await settled();
    afterScheduleWrite("div-other", COMPETITION, "publish", ["fx-b", "fx-c"]);
    await settled();
    expect(posts()).toEqual([
      [divisionSchedule(DIVISION, "schedule"), fixtureMsg("fx-a", "schedule")],
      [divisionSchedule("div-other", "publish"), fixtureMsg("fx-b", "schedule"), fixtureMsg("fx-c", "schedule")],
    ]);
  });
});

interface BracketRow {
  id: string;
  home: string | null;
  away: string | null;
  winner_to: string | null;
  loser_to: string | null;
}

/** A started double-elimination bracket of four on a Pro org: deciding a first-round fixture names its winner into the
 *  winners' bracket AND drops its loser into the losers' bracket — two fixtures advanced into by one score. */
async function doubleElimRig() {
  const { auth } = await seedOrg("pro");
  const competition = await createCompetition(auth, {
    ends_on: "2030-12-31", name: "Batch Cup " + randomUUID().slice(0, 6), visibility: "public", branding: {},
  });
  const division = await createDivision(auth, competition.id, {
    name: "Open", sport_key: "generic", variant_key: "score", config: GENERIC_CONFIG,
  });
  await createEntrants(auth, division.id, ["A", "B", "C", "D"].map((name, i) => ({
    kind: "individual" as const, display_name: name, seed: i + 1, members: [],
  })));
  const [stage] = await createStages(auth, division.id, { seq: 1, kind: "double_elim", name: "Bracket", config: {} });
  await generateStageFixtures(auth, stage!.id);
  await startDivision(auth, division.id);
  const fixtures = await sql<BracketRow[]>`
    select id, home_entrant_id as home, away_entrant_id as away,
           winner_to_fixture as winner_to, loser_to_fixture as loser_to
    from fixtures where stage_id = ${stage!.id} order by ext_key`;
  return { auth, divisionId: division.id, fixtures };
}

/** Every fixture of the division, as `id -> home|away`. */
async function lineups(divisionId: string): Promise<Map<string, string>> {
  const rows = await sql<{ id: string; home: string | null; away: string | null }[]>`
    select id, home_entrant_id as home, away_entrant_id as away from fixtures where division_id = ${divisionId}`;
  return new Map(rows.map((row) => [row.id, `${row.home ?? "-"}|${row.away ?? "-"}`]));
}
const changedSeats = (before: Map<string, string>, after: Map<string, string>) =>
  [...after].filter(([id, seats]) => before.get(id) !== seats).map(([id]) => id).sort();

describe.skipIf(!HAS_DB)("a score sends ONE broadcast: its fixture, its division and every fixture it advanced into", () => {
  it("start, decide (two fixtures advanced into), void: one POST each, and the decide's carries 4 messages", async () => {
    const rig = await doubleElimRig();
    const first = rig.fixtures.find((f) => f.home !== null && f.away !== null && f.winner_to !== null && f.loser_to !== null);
    expect(first, "premise: a double-elimination first round feeds a winners' AND a losers' fixture").toBeDefined();
    const fed = [first!.winner_to!, first!.loser_to!].sort();
    await settled();

    // 1. A start advances nobody: the fixture and its division, in one POST.
    fetchSpy.mockClear();
    await scoreEvent(rig.auth, first!.id, { expected_seq: 0, type: "core.start", payload: {} });
    await settled();
    expect(posts()).toEqual([[fixtureMsg(first!.id, "event"), divisionScore(rig.divisionId)]]);

    // 2. The decision names the winner up and drops the loser down: the second score's own ONE POST, 4 messages.
    fetchSpy.mockClear();
    const beforeDecide = await lineups(rig.divisionId);
    await scoreEvent(rig.auth, first!.id, {
      expected_seq: 1, type: "generic.result", payload: { p1Score: 2, p2Score: 0 },
    });
    const advanced = changedSeats(beforeDecide, await lineups(rig.divisionId));
    expect(advanced, "the winner went up and the loser dropped, into the fixtures the bracket links name").toEqual(fed);
    await settled();
    const decided = posts();
    expect(decided, "one POST for the score (before T0.2: 4)").toHaveLength(1);
    expect(decided[0], "anti-vacuity: 4 messages").toHaveLength(4);
    expect(decided[0]!.slice(0, 2), "the scored fixture first, then its division").toEqual([
      fixtureMsg(first!.id, "event"),
      divisionScore(rig.divisionId),
    ]);
    expect([...decided[0]!.slice(2)].sort((a, b) => a.topic.localeCompare(b.topic)), "then one per advanced-into fixture")
      .toEqual(fed.map((id) => fixtureMsg(id, "schedule")).sort((a, b) => a.topic.localeCompare(b.topic)));

    // 3. After a void: the decision is erased and the names it advanced are taken back. The seats the void emptied ride
    //    the void's own ONE POST.
    const [decider] = await sql<{ id: string; seq: number }[]>`
      select id, seq from score_events where fixture_id = ${first!.id} and type = 'generic.result'`;
    fetchSpy.mockClear();
    const beforeVoid = await lineups(rig.divisionId);
    await scoreEvent(rig.auth, first!.id, {
      expected_seq: decider!.seq, type: "core.void", payload: { event_id: decider!.id },
    });
    const emptied = changedSeats(beforeVoid, await lineups(rig.divisionId));
    expect(emptied.length, "anti-vacuity: the void emptied a seat it had filled").toBeGreaterThan(0);
    await settled();
    const voided = posts();
    expect(voided, "one POST for the void").toHaveLength(1);
    expect(voided[0]).toHaveLength(2 + emptied.length);
    expect(voided[0]!.slice(0, 2)).toEqual([fixtureMsg(first!.id, "event"), divisionScore(rig.divisionId)]);
    expect(voided[0]!.slice(2).map((m) => m.topic).sort()).toEqual(emptied.map((id) => `fixture:${id}`));
    expect(new Set(voided[0]!.slice(2).map((m) => m.reason))).toEqual(new Set(["schedule"]));
  }, 120_000);

  it("a score whose fixture's scope lookup finds no row: ONE POST with the fixture message only", async () => {
    const { auth } = await seedGenericOrg();
    const rig = await divisionRig(auth, { entrants: 2 });
    const fixtureId = rig.fixtureIds[0]!;
    await settled();
    fetchSpy.mockClear();
    probe.blankLookup = true;
    await scoreEvent(auth, fixtureId, { expected_seq: 0, type: "core.start", payload: {} });
    probe.blankLookup = false;
    expect(probe.blankHits, "anti-vacuity: the scope lookup was really answered with no row").toBe(1);
    await settled();
    expect(posts()).toEqual([[fixtureMsg(fixtureId, "event")]]);
  }, 120_000);
});

describe.skipIf(!HAS_DB)("a real schedule writer reaches the one broadcast", () => {
  it("moveFixture: ONE POST, the division then the moved fixture", async () => {
    const { auth } = await seedGenericOrg();
    const rig = await divisionRig(auth, { entrants: 3 });
    await settled();
    fetchSpy.mockClear();
    await moveFixture(auth, rig.fixtureIds[0]!, { scheduled_at: "2030-06-01T10:00:00.000Z" });
    await settled();
    expect(posts()).toEqual([[divisionSchedule(rig.divisionId, "schedule"), fixtureMsg(rig.fixtureIds[0]!, "schedule")]]);
  }, 120_000);
});

// Another surface. `voidLineEvents` (a Reinstate's batch of voids) still publishes through the per-message publishers:
// one POST per line and one for the division. Task 10 batches it; until then this pins that T0.2 left it alone.
describe.skipIf(!HAS_DB)("voidLineEvents is untouched by T0.2: still one POST per publisher", () => {
  const moduleOf = (key: string): AnySportModule => builtinModules.find((m) => m.key === key) as AnySportModule;

  it("two voided lines: three POSTs, one message each — each line's fixture, and the division", async () => {
    const { auth } = await seedOrg("pro");
    const comp = await createCompetition(auth, {
      ends_on: "2030-12-31", name: "T02 " + randomUUID().slice(0, 6), visibility: "private", branding: {},
    });
    const d = await createDivision(auth, comp.id, {
      name: "Open", slug: "t02-" + randomUUID().slice(0, 6), sport_key: "badminton",
      variant_key: Object.keys(moduleOf("badminton").variants)[0]!, config: {},
    });
    const es = await createEntrants(auth, d.id, Array.from({ length: 4 }, (_, i) => ({
      kind: "individual" as const, display_name: `P${i + 1}`, seed: i + 1, members: [],
    })) as never);
    const [stage] = await createStages(auth, d.id, { seq: 1, kind: "league", name: "Table", config: { legs: 1 }, progression: null });
    await startDivision(auth, d.id);
    const leaver = es[0]!.id;
    await withdrawEntrantCascade(auth, leaver);
    const abandons = await sql<{ fixture_id: string; id: string }[]>`
      select e.fixture_id, e.id from score_events e join fixtures f on f.id = e.fixture_id
      where f.stage_id = ${stage!.id} and e.type = 'core.abandon' order by e.fixture_id`;
    expect(abandons.length, "premise: the expunge abandoned every line of hers (n - 1 = 3)").toBe(3);
    const two = abandons.slice(0, 2);
    await settled();

    fetchSpy.mockClear();
    const written = await voidLineEvents(auth, d.id, two.map((a) => ({ fixtureId: a.fixture_id, eventId: a.id })), {
      writer: "withdrawal_cascade",
    });
    expect(written.sort(), "anti-vacuity: both voids were written").toEqual(two.map((a) => a.fixture_id).sort());
    await settled();
    const sent = posts();
    expect(sent, "one POST per publisher: two lines and the division").toHaveLength(3);
    for (const post of sent) expect(post, "each POST carries one message").toHaveLength(1);
    const byTopic = (a: Shape, b: Shape) => a.topic.localeCompare(b.topic);
    expect(sent.flat().sort(byTopic)).toEqual(
      [divisionScore(d.id), ...two.map((a) => fixtureMsg(a.fixture_id, "event"))].sort(byTopic),
    );
  }, 120_000);
});
