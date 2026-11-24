// Push nudges, CS-4 (plan 2026-11-24 realtime push nudges, Tasks 13 and 14): an STG-LOCAL probe of the competition's
// division door and its PRIVATE `division:{id}` topics against a REAL Supabase socket — which CI's e2e (a stub project)
// does not have. It runs ONLY on the opt-in `probes` project (playwright.config.ts: every other project ignores
// e2e/probes/, and CI always names its --project), and it FAILS when its env is missing: a probe that skipped would report
// a green it never measured.
//
//   REALTIME_PROBE_COMPETITION  the id of a PUBLIC competition on that deployment whose org is entitled to `realtime`,
//                               with at least one division
//   REALTIME_PROBE_FIXTURE      (delivery test) the id of an UNPLAYED fixture (status `scheduled`, no result) in one of
//                               that competition's divisions
//   REALTIME_PROBE_API_KEY      (delivery test) an API key (`sc_…`) of that competition's org with the `manage` scope
//                               (PATCH /fixtures/:id, key-scopes.ts)
//   PLAYWRIGHT_BASE             the deployment (stg), as for every spec
//
//   cd apps/web && PLAYWRIGHT_BASE=https://stg.seazn.club REALTIME_PROBE_COMPETITION='<uuid>' \
//     REALTIME_PROBE_FIXTURE='<uuid>' REALTIME_PROBE_API_KEY='sc_…' \
//     npx playwright test --project=probes e2e/probes/realtime-nudge-division.spec.ts
//
// The delivery test WRITES: it re-saves the fixture's own `scheduled_at` through `PATCH /api/v1/fixtures/{id}`. Nothing
// moves (no court or time changes, so no official is emailed), but the write appends a `schedule_edited` step to the
// division's ledger (an Undo entry, from = to) and bumps its seq. Point it at a competition made for the purpose. It
// REFUSES any base that is not stg or local (`target-guard.ts`) unless REALTIME_PROBE_ALLOW_PROD=1 is set.
//
// No trace, video or screenshot (review m3): the project's `retain-on-failure` trace would keep the `sc_` Bearer header,
// and the door's token, in a local trace.zip after a failed run.
//
// What it proves and measures (Task 12 serves the token; Task 13's browser code joins with it; Task 14 publishes):
//   1. the door answers an anonymous spectator `private, no-store`, with exactly the reply's keys, an https url with no
//      query, and the token in no header;
//   2. the token joins EVERY `division:{id}` it names, PRIVATE, and each reaches SUBSCRIBED — the join times are logged;
//   3. the same token is REFUSED on a division it does not name (V556 keys on `division_ids`): CHANNEL_ERROR, the
//      server's refusal — not a timeout or a close, which would also be "not SUBSCRIBED" and prove nothing;
//   4. it is refused on a fixture, a Match Day and a capture topic too (a division token reads nothing outside its family);
//   5. DELIVERY (the Task 13/14 merge gate): a real division change — the app's own schedule write, so the SERVER's
//      `afterScheduleWrite` → `divisionMessages` → `broadcast` path publishes, never a hand-built broadcast — ARRIVES on the
//      private `division:{id}` channel joined with the door's token, within RECEIVE_BUDGET_MS; the latency is printed;
//   6. the negatives of the dual-publish window: an ANONYMOUS client (no token) is refused the private channel
//      (CHANNEL_ERROR), and a PUBLIC subscriber hears the change ONCE — the public message, never also the private twin
//      (CS-1a) — while the private subscriber hears it once too, the twin, never also the public message (CS-1b).
//
// Applies to another sport: N/A (no sport rules).
import { test, expect, request as pwRequest } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { createClient, type RealtimeChannel } from "@supabase/supabase-js";
import { probeWriteRefusal } from "./target-guard";

const COMPETITION = process.env.REALTIME_PROBE_COMPETITION;
const FIXTURE = process.env.REALTIME_PROBE_FIXTURE;
const API_KEY = process.env.REALTIME_PROBE_API_KEY;
/** The door's reply keys (`CompetitionRealtimeToken`, server/api-v1/schemas/public.ts). */
const REPLY_KEYS = ["apikey", "divisionIds", "expiresAt", "token", "url"];
const JOIN_BUDGET_MS = 10_000;
/** From the write's response to the nudge on the private channel. The design's push is "seconds, not a poll period"
 *  (the hub's poll is 15–60 s); 5 s leaves room for stg's cold paths and still fails a push that never comes. */
const RECEIVE_BUDGET_MS = 5_000;
/** After the first arrival, how long the probe keeps listening for a second copy on either channel. */
const SETTLE_MS = 3_000;

type Door = { token: string; divisionIds: string[]; expiresAt: number; url: string; apikey: string };
type Heard = { at: number; payload: { v?: number; reason?: string; at?: string } };

/** Join `topic` with the door's url and apikey: PRIVATE with `token` when one is given, else an anonymous client on the
 *  channel `private` names. Every `schedule_changed` broadcast it hears is pushed onto `heard`, with the time it arrived.
 *  Resolves with the terminal status and how long the join took. */
function joinChannel(
  door: Door,
  topic: string,
  opts: { token?: string; private?: boolean; heard?: Heard[] } = { token: door.token, private: true },
): Promise<{ status: string; ms: number; channel: RealtimeChannel; close: () => Promise<void> }> {
  const client = createClient(door.url, door.apikey, { auth: { persistSession: false, autoRefreshToken: false } });
  if (opts.token !== undefined) client.realtime.setAuth(opts.token);
  const t0 = performance.now();
  return new Promise((resolve) => {
    const channel = client.channel(topic, { config: { private: opts.private === true } });
    if (opts.heard !== undefined) {
      const heard = opts.heard;
      channel.on("broadcast", { event: "schedule_changed" }, (message) => {
        heard.push({ at: performance.now(), payload: (message.payload ?? {}) as Heard["payload"] });
      });
    }
    const close = async () => {
      await client.removeAllChannels();
    };
    const timer = setTimeout(() => resolve({ status: "TIMED_OUT", ms: performance.now() - t0, channel, close }), JOIN_BUDGET_MS);
    channel.subscribe((status) => {
      if (status === "SUBSCRIBED" || status === "CHANNEL_ERROR" || status === "CLOSED") {
        clearTimeout(timer);
        resolve({ status, ms: performance.now() - t0, channel, close });
      }
    });
  });
}

/** The door, as an anonymous spectator, with its reply checked. */
async function openDoor(baseURL: string | undefined): Promise<Door> {
  const spectator = await pwRequest.newContext({ baseURL });
  try {
    const res = await spectator.get(`/api/v1/public/competitions/${COMPETITION}/realtime-token`);
    expect(res.status(), await res.text()).toBe(200);
    expect(res.headers()["cache-control"]).toBe("private, no-store");
    const door = ((await res.json()) as { data: Door }).data;
    expect(Object.keys(door).sort()).toEqual(REPLY_KEYS);
    expect(door.url).toMatch(/^https:\/\/[^\s/?#@]+(\/[^\s?#]*)?$/);
    for (const { name, value } of res.headersArray()) expect(value.includes(door.token), `header ${name} carries the token`).toBe(false);
    expect(door.divisionIds.length, "the competition has divisions").toBeGreaterThan(0);
    expect(door.expiresAt * 1000 - Date.now()).toBeGreaterThan(50 * 60_000);
    return door;
  } finally {
    await spectator.dispose();
  }
}

/** Polls `done` every 25 ms until it holds or `budgetMs` passes; resolves with whether it held. */
async function within(budgetMs: number, done: () => boolean): Promise<boolean> {
  const end = performance.now() + budgetMs;
  while (!done() && performance.now() < end) await new Promise((resolve) => setTimeout(resolve, 25));
  return done();
}

// No trace, video or screenshot (Task 14 review m3): the project's `retain-on-failure` trace would keep this probe's
// Bearer credential and realtime token in a local trace.zip after a failed run. Top level: these options force a new
// worker, which Playwright refuses inside a describe.
test.use({ trace: "off", video: "off", screenshot: "off" });

test.describe("CS-4 probe: the competition's division door and private division topics on a real socket", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("the door's token joins every division it names, private, and is refused everywhere else", async ({ baseURL }) => {
    expect(COMPETITION, "STG-local probe: set REALTIME_PROBE_COMPETITION (a public, realtime-entitled competition id) — it never skips").toBeTruthy();
    const door = await openDoor(baseURL);

    let joined = 0;
    for (const id of door.divisionIds) {
      const own = await joinChannel(door, `division:${id}`);
      console.log(`CS-4 division join: ${own.status} in ${Math.round(own.ms)} ms (division:${id.slice(0, 8)}…)`);
      await own.close();
      expect(own.status, `the token joins division:${id}`).toBe("SUBSCRIBED");
      joined += 1;
    }
    expect(joined, "anti-vacuity: every named division was joined").toBe(door.divisionIds.length);

    for (const foreign of [`division:${randomUUID()}`, `fixture:${randomUUID()}`, `match-day:${randomUUID()}`, `capture:${randomUUID()}`]) {
      const other = await joinChannel(door, foreign);
      console.log(`CS-4 division foreign join (${foreign.split(":")[0]}): ${other.status} in ${Math.round(other.ms)} ms`);
      await other.close();
      expect(other.status, `the token is refused on ${foreign.split(":")[0]} — by the server, not a timeout`).toBe("CHANNEL_ERROR");
    }
  });

  test("a real division change ARRIVES on the private channel, once; a public subscriber hears the public message only", async ({ baseURL }) => {
    expect(COMPETITION, "STG-local probe: set REALTIME_PROBE_COMPETITION — it never skips").toBeTruthy();
    expect(FIXTURE, "STG-local probe: set REALTIME_PROBE_FIXTURE (an unplayed fixture of that competition) — it never skips").toBeTruthy();
    expect(API_KEY, "STG-local probe: set REALTIME_PROBE_API_KEY (an sc_ key of that org, manage scope) — it never skips").toBeTruthy();
    // This test writes. It refuses prod and every other non-stg, non-local base, before it reads or writes anything.
    const refusal = probeWriteRefusal(baseURL, process.env.REALTIME_PROBE_ALLOW_PROD);
    if (refusal !== null) throw new Error(`CS-4 probe refused: ${refusal}`);
    const door = await openDoor(baseURL);
    const organiser = await pwRequest.newContext({ baseURL, extraHTTPHeaders: { Authorization: `Bearer ${API_KEY}` } });
    const closers: Array<() => Promise<void>> = [];
    try {
      // The fixture, read through the same key: its division must be one the door named, and it must be movable.
      const read = await organiser.get(`/api/v1/fixtures/${FIXTURE}`);
      expect(read.status(), await read.text()).toBe(200);
      const fixture = ((await read.json()) as { data: { division_id: string; scheduled_at: string | null; status: string } }).data;
      expect(door.divisionIds, "the fixture's division is one the door's token names").toContain(fixture.division_id);
      expect(fixture.status, "REALTIME_PROBE_FIXTURE must be unplayed (a decided fixture refuses a schedule write)").toBe("scheduled");
      const topic = `division:${fixture.division_id}`;

      // The negative first: an anonymous client — the anon key, no token — is refused the private channel by the server.
      const anonPrivate = await joinChannel(door, topic, { private: true });
      closers.push(anonPrivate.close);
      console.log(`CS-4 anonymous private join: ${anonPrivate.status} in ${Math.round(anonPrivate.ms)} ms`);
      expect(anonPrivate.status, "an anonymous client is refused the PRIVATE division channel — by the server, not a timeout").toBe("CHANNEL_ERROR");

      // The two listeners: the door's token on the private channel (a Task 13 page), and an anonymous PUBLIC subscriber
      // (an old tab). Both are SUBSCRIBED before the write is sent, so neither can miss it by joining late.
      const privateHeard: Heard[] = [];
      const publicHeard: Heard[] = [];
      const privateSub = await joinChannel(door, topic, { token: door.token, private: true, heard: privateHeard });
      closers.push(privateSub.close);
      const publicSub = await joinChannel(door, topic, { private: false, heard: publicHeard });
      closers.push(publicSub.close);
      console.log(`CS-4 delivery joins: private ${privateSub.status} in ${Math.round(privateSub.ms)} ms, public ${publicSub.status} in ${Math.round(publicSub.ms)} ms`);
      expect(privateSub.status, "the door's token joins the fixture's division, private").toBe("SUBSCRIBED");
      expect(publicSub.status, "an anonymous public subscriber joins the division's public channel").toBe("SUBSCRIBED");

      // The write: the fixture's own `scheduled_at`, re-saved through the app's real API (moveFixture → afterScheduleWrite).
      const sentAt = performance.now();
      const sentWall = Date.now();
      const write = await organiser.patch(`/api/v1/fixtures/${FIXTURE}`, { data: { scheduled_at: fixture.scheduled_at } });
      const answeredAt = performance.now();
      expect(write.status(), await write.text()).toBe(200);

      // Only this write's push counts: a `schedule` reason, stamped no earlier than a minute before the request (the
      // server's clock against this machine's; a push from an earlier write would be older still).
      const ours = (heard: Heard[]) => heard.filter((h) => h.payload.reason === "schedule" && (h.payload.v ?? 0) >= sentWall - 60_000);
      const arrived = await within(RECEIVE_BUDGET_MS, () => ours(privateHeard).length > 0);
      const first = ours(privateHeard)[0];
      console.log(
        arrived && first
          ? `CS-4 DELIVERY: private division nudge in ${Math.round(first.at - answeredAt)} ms after the write answered ` +
              `(${Math.round(first.at - sentAt)} ms after it was sent; the write itself took ${Math.round(answeredAt - sentAt)} ms)`
          : `CS-4 DELIVERY: NOTHING on the private channel within ${RECEIVE_BUDGET_MS} ms of the write's answer`,
      );
      expect(arrived, `the private division channel heard the write's schedule_changed within ${RECEIVE_BUDGET_MS} ms`).toBe(true);

      // Then listen on for a second copy on either side.
      await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
      const privateCopies = ours(privateHeard);
      const publicCopies = ours(publicHeard);
      console.log(`CS-4 copies after ${SETTLE_MS} ms: private ${privateCopies.length}, public ${publicCopies.length}`);
      expect(privateCopies.length, "the private subscriber hears ONE copy — the twin, never also the public message (CS-1b)").toBe(1);
      expect(publicCopies.length, "the public subscriber hears ONE copy — the public message, never also the private twin (CS-1a)").toBe(1);
      expect(publicCopies[0]!.payload, "both copies are the same publish: one payload, twinned").toEqual(privateCopies[0]!.payload);
    } finally {
      for (const close of closers) await close();
      await organiser.dispose();
    }
  });
});
