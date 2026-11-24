// Push nudges, CS-4 (plan 2026-11-24 realtime push nudges, Task 5): an STG-LOCAL probe of the capture phone's realtime
// channel against a REAL Supabase socket — which CI's e2e (a stub project) does not have. It runs ONLY on the opt-in `probes`
// project (playwright.config.ts: every other project ignores e2e/probes/, and CI always names its --project), and it FAILS
// when REALTIME_PROBE_QR is missing: a probe that skipped would report a green it never measured.
//
//   REALTIME_PROBE_QR     the paste text of a stream code minted ON THAT DEPLOYMENT for the purpose ({"v":2,"code",…,"tok"});
//                         the probe claims its slot with a fresh phone id, so never point it at a code a real phone holds
//   PLAYWRIGHT_BASE       the deployment (stg), as for every spec
//
//   cd apps/web && PLAYWRIGHT_BASE=https://stg.seazn.club REALTIME_PROBE_QR='{"v":2,…}' \
//     npx playwright test --project=probes e2e/probes/realtime-nudge-capture.spec.ts
//
// What it proves and measures (Task 5 serves the token; the nudge-arrival timing joins with the task that publishes):
//   1. the claim beat's answer carries `realtime`, exactly the published contract's keys, an https url with no query;
//   2. the token joins `realtime:{topic}` PRIVATE and reaches SUBSCRIBED — the join time is logged;
//   3. the same token is REFUSED on another pairing's topic (V554's policy keys on capture_pairing_id): CHANNEL_ERROR, the
//      server's refusal — not a timeout or a close, which would also be "not SUBSCRIBED" and prove nothing.
import { test, expect, request as pwRequest } from "@playwright/test";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient, type RealtimeChannel } from "@supabase/supabase-js";

const QR = process.env.REALTIME_PROBE_QR;
/** The beat answer's realtime keys, as the published contract declares them. */
const REALTIME_KEYS = Object.keys(
  (JSON.parse(readFileSync(join(import.meta.dirname, "../../../../docs/contracts/capture-beat.v1.json"), "utf8")) as {
    $defs: { answer: { oneOf: { properties: { realtime?: { properties: Record<string, unknown> } } }[] } };
  }).$defs.answer.oneOf[0]!.properties.realtime!.properties,
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

test.describe("CS-4 probe: the capture phone's realtime channel on a real socket", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("the claim's answer carries the channel; its token joins its own topic and is refused on another", async ({ baseURL }) => {
    expect(QR, "STG-local probe: set REALTIME_PROBE_QR (a code minted on PLAYWRIGHT_BASE for the purpose) — it never skips").toBeTruthy();
    const q = JSON.parse(QR!) as { v: number; code: string; slot: number; tok: string };
    const phone = await pwRequest.newContext({ baseURL });
    try {
      const res = await phone.post(`/api/v1/capture/codes/${q.code}/beats`, {
        headers: { Authorization: `Bearer ${q.tok}` },
        data: {
          code: q.code, slot: q.slot, phone: randomBytes(16).toString("hex"), claim: "new", device: { model: "CS-4 probe" }, sid: null,
          at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), state: "paired", cause: null, notReady: null, startFailed: null,
          stopped: null, mode: "operator", transport: null, bitrateKbps: null, delivery: "unknown", deliveredLagS: null, audioOk: null,
          battery: null, thermal: null, dataUsedMB: null, appVersion: "cs4-probe/1",
        },
      });
      expect(res.status(), await res.text()).toBe(200);
      const answer = (await res.json()) as { state: string; realtime?: Realtime };
      expect(answer.state).toBe("waiting");
      const rt = answer.realtime;
      expect(rt, "the deployment serves the channel").toBeDefined();
      expect(Object.keys(rt!).sort()).toEqual(REALTIME_KEYS);
      expect(rt!.url).toMatch(/^https:\/\/[^\s/?#@]+(\/[^\s?#]*)?$/);
      for (const { name, value } of res.headersArray()) expect(value.includes(rt!.token), `header ${name} carries the token`).toBe(false);

      const own = await joinChannel(rt!, rt!.topic);
      console.log(`CS-4 capture join: ${own.status} in ${Math.round(own.ms)} ms (${rt!.topic.slice(0, 16)}…)`);
      await own.close();
      expect(own.status, "the token joins its own topic").toBe("SUBSCRIBED");

      const other = await joinChannel(rt!, `capture:${randomUUID()}`);
      console.log(`CS-4 capture foreign join: ${other.status} in ${Math.round(other.ms)} ms`);
      await other.close();
      expect(other.status, "the token is refused on another pairing's topic — by the server, not a timeout").toBe("CHANNEL_ERROR");
    } finally {
      await phone.dispose();
    }
  });
});
