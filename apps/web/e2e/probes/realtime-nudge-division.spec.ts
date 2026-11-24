// Push nudges, CS-4 (plan 2026-11-24 realtime push nudges, Task 13): an STG-LOCAL probe of the competition's division
// door and its PRIVATE `division:{id}` topics against a REAL Supabase socket — which CI's e2e (a stub project) does not
// have. It runs ONLY on the opt-in `probes` project (playwright.config.ts: every other project ignores e2e/probes/, and
// CI always names its --project), and it FAILS when REALTIME_PROBE_COMPETITION is missing: a probe that skipped would
// report a green it never measured.
//
//   REALTIME_PROBE_COMPETITION  the id of a PUBLIC competition on that deployment whose org is entitled to `realtime`,
//                               with at least one division; the probe only READS (the door, as an anonymous spectator,
//                               and the joins), so any such competition is safe to point it at
//   PLAYWRIGHT_BASE             the deployment (stg), as for every spec
//
//   cd apps/web && PLAYWRIGHT_BASE=https://stg.seazn.club REALTIME_PROBE_COMPETITION='<uuid>' \
//     npx playwright test --project=probes e2e/probes/realtime-nudge-division.spec.ts
//
// What it proves and measures (Task 12 serves the token; Task 13's browser code joins with it):
//   1. the door answers an anonymous spectator `private, no-store`, with exactly the reply's keys, an https url with no
//      query, and the token in no header;
//   2. the token joins EVERY `division:{id}` it names, PRIVATE, and each reaches SUBSCRIBED — the join times are logged;
//   3. the same token is REFUSED on a division it does not name (V556 keys on `division_ids`): CHANNEL_ERROR, the
//      server's refusal — not a timeout or a close, which would also be "not SUBSCRIBED" and prove nothing;
//   4. it is refused on a fixture, a Match Day and a capture topic too (a division token reads nothing outside its family).
//
// Applies to another sport: N/A (no sport rules).
import { test, expect, request as pwRequest } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { createClient, type RealtimeChannel } from "@supabase/supabase-js";

const COMPETITION = process.env.REALTIME_PROBE_COMPETITION;
/** The door's reply keys (`CompetitionRealtimeToken`, server/api-v1/schemas/public.ts). */
const REPLY_KEYS = ["apikey", "divisionIds", "expiresAt", "token", "url"];
const JOIN_BUDGET_MS = 10_000;

type Door = { token: string; divisionIds: string[]; expiresAt: number; url: string; apikey: string };

/** Join `topic` private with the door's token; resolves with the terminal status and how long it took. */
function joinChannel(door: Door, topic: string): Promise<{ status: string; ms: number; channel: RealtimeChannel; close: () => Promise<void> }> {
  const client = createClient(door.url, door.apikey, { auth: { persistSession: false, autoRefreshToken: false } });
  client.realtime.setAuth(door.token);
  const t0 = performance.now();
  return new Promise((resolve) => {
    const channel = client.channel(topic, { config: { private: true } });
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

test.describe("CS-4 probe: the competition's division door and private division topics on a real socket", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("the door's token joins every division it names, private, and is refused everywhere else", async ({ baseURL }) => {
    expect(COMPETITION, "STG-local probe: set REALTIME_PROBE_COMPETITION (a public, realtime-entitled competition id) — it never skips").toBeTruthy();
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
    } finally {
      await spectator.dispose();
    }
  });
});
