// Push nudges, CS-4 (plan 2026-11-24 realtime push nudges, Task 9): an STG-LOCAL probe of the Match Day code's realtime channel
// against a REAL Supabase socket — which CI's e2e (a stub project) does not have. It runs ONLY on the opt-in `probes` project
// (playwright.config.ts: every other project ignores e2e/probes/, and CI always names its --project), and it FAILS when
// REALTIME_PROBE_MD is missing: a probe that skipped would report a green it never measured.
//
//   REALTIME_PROBE_MD     a Match Day code's credential (`md_…`) minted ON THAT DEPLOYMENT for the purpose, open today; the probe
//                         only READS with it (the door, and the join), so it is safe against a code a real phone holds
//   PLAYWRIGHT_BASE       the deployment (stg), as for every spec
//
//   cd apps/web && PLAYWRIGHT_BASE=https://stg.seazn.club REALTIME_PROBE_MD='md_…' \
//     npx playwright test --project=probes e2e/probes/realtime-nudge-match-day.spec.ts
//
// What it proves and measures (Task 9 serves the token; the nudge-arrival timing joins with the task that publishes):
//   1. the door's answer carries exactly the published contract's keys, an https url with no query, and `private, no-store`;
//   2. the token joins `realtime:{topic}` PRIVATE and reaches SUBSCRIBED — the join time is logged;
//   3. the same token is REFUSED on another code's topic (V555's policy keys on md_code_id): CHANNEL_ERROR, the server's refusal —
//      not a timeout or a close, which would also be "not SUBSCRIBED" and prove nothing;
//   4. it is refused on a capture and a division topic too (a Match Day token reads nothing outside its own family).
import { test, expect, request as pwRequest } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient, type RealtimeChannel } from "@supabase/supabase-js";

const CREDENTIAL = process.env.REALTIME_PROBE_MD;
/** The door's keys, as the published contract declares them. */
const REALTIME_KEYS = Object.keys(
  (JSON.parse(readFileSync(join(import.meta.dirname, "../../../../docs/contracts/capture-matchday-realtime.v1.json"), "utf8")) as {
    properties: Record<string, unknown>;
  }).properties,
).sort();
const JOIN_BUDGET_MS = 10_000;

type Realtime = { url: string; apikey: string; topic: string; token: string; expiresAt: number };

/** Join `topic` private with `token`; resolves with the terminal status and how long it took. */
function joinChannel(rt: Realtime, topic: string): Promise<{ status: string; ms: number; channel: RealtimeChannel; close: () => Promise<void> }> {
  const client = createClient(rt.url, rt.apikey, { auth: { persistSession: false, autoRefreshToken: false } });
  client.realtime.setAuth(rt.token);
  const t0 = performance.now();
  return new Promise((resolve) => {
    const channel = client.channel(topic, { config: { private: true } });
    const close = async () => { await client.removeAllChannels(); };
    const timer = setTimeout(() => resolve({ status: "TIMED_OUT", ms: performance.now() - t0, channel, close }), JOIN_BUDGET_MS);
    channel.subscribe((status) => {
      if (status === "SUBSCRIBED" || status === "CHANNEL_ERROR" || status === "CLOSED") {
        clearTimeout(timer);
        resolve({ status, ms: performance.now() - t0, channel, close });
      }
    });
  });
}

test.describe("CS-4 probe: the Match Day code's realtime channel on a real socket", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("the door's answer carries the channel; its token joins its own topic and is refused on every other", async ({ baseURL }) => {
    expect(CREDENTIAL, "STG-local probe: set REALTIME_PROBE_MD (an md_ code minted on PLAYWRIGHT_BASE, open today) — it never skips").toBeTruthy();
    const phone = await pwRequest.newContext({ baseURL });
    try {
      const res = await phone.get("/api/v1/match-day-code/realtime-token", { headers: { Authorization: `Bearer ${CREDENTIAL}` } });
      expect(res.status(), await res.text()).toBe(200);
      expect(res.headers()["cache-control"]).toBe("private, no-store");
      const rt = ((await res.json()) as { data: Realtime }).data;
      expect(Object.keys(rt).sort()).toEqual(REALTIME_KEYS);
      expect(rt.url).toMatch(/^https:\/\/[^\s/?#@]+(\/[^\s?#]*)?$/);
      expect(rt.topic).toMatch(/^match-day:[0-9a-f-]{36}$/);
      for (const { name, value } of res.headersArray()) expect(value.includes(rt.token), `header ${name} carries the token`).toBe(false);

      const own = await joinChannel(rt, rt.topic);
      console.log(`CS-4 match-day join: ${own.status} in ${Math.round(own.ms)} ms (${rt.topic.slice(0, 20)}…)`);
      await own.close();
      expect(own.status, "the token joins its own topic").toBe("SUBSCRIBED");

      for (const foreign of [`match-day:${randomUUID()}`, `capture:${randomUUID()}`, `division:${randomUUID()}`]) {
        const other = await joinChannel(rt, foreign);
        console.log(`CS-4 match-day foreign join (${foreign.split(":")[0]}): ${other.status} in ${Math.round(other.ms)} ms`);
        await other.close();
        expect(other.status, `the token is refused on ${foreign.split(":")[0]} — by the server, not a timeout`).toBe("CHANNEL_ERROR");
      }
    } finally {
      await phone.dispose();
    }
  });
});
