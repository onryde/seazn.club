// Seazn-hosted video, Task 45 (B): a returning camera reaches the relay. Cloudflare's `live_input.connected` for a session's CAMERA
// input, when it is a RE-connection, raises the session's phone-live edge counter — the one field the relay already acts on to cut
// its reconnect back-off short (docs/contracts/relay-job.v1.json heartbeatReply `phoneLiveEdge`; the compositor's input_link
// `on_phone_live_edge` / `check_nudge`).
//
// Producer: Cloudflare's notification, through the REAL use case (`recordLiveNotification`) and once through the REAL webhook route
// with Cloudflare's body. The session, its inputs and its phone's history come from the real paths (`pairPresentPhone`,
// `createSession` composed, the phone's `postBeat`). Consumer: the relay's heartbeat (`heartbeat`), its reply parsed by the
// contract's zod twin AND validated against the published contract bytes with ajv, as the compositor vendors them. Nothing here
// writes the counter by hand.
//
// The rules, typed from the contract and the brief, never read back from the code:
//   - the first live is not an edge (contract: "the counter first appears at 0"), so an input's FIRST connect is not one either;
//   - a counter that does not exist (no phone has been live) is not created by Cloudflare;
//   - a second delivery of one notification changes nothing (a duplicate is no news);
//   - a re-connect with no disconnect recorded before it (Cloudflare taking a NEW publisher on a held input — stg 5e5403ce
//     09:55:31, recorded `connected` → `connected`) IS a return;
//   - a `connected` delivered after a LATER event of its input is stale, not an edge;
//   - the programme input's return is the relay's own output, nothing to nudge;
//   - an ending or ended session's relay is told to exit: nothing moves.
//
// The court half (a T37 per-match session) is in stream-auto-court-seazn.test.ts, on that file's court rig.
// ONE SPORT, on purpose (TEST-STRATEGY rule 6): neither a notification nor the relay's heartbeat reads a sport.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import type { z } from "zod";

vi.mock("@/lib/sentry", () => ({ captureError: vi.fn() }));

import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { CaptureBeat } from "@/server/api-v1/capture-schemas";
import { RelayHeartbeatReply } from "@/server/api-v1/schemas";
import type { IngestState } from "@/server/relay/ports";
import { setRelayDriversForTest } from "@/server/relay/drivers";
import { pairPresentPhone } from "@/server/relay/__tests__/_session-rig";
import { POST as webhookRoute } from "@/app/api/webhooks/cloudflare-stream-live/route";
import { postBeat } from "../capture-phone";
import { createSession, heartbeat, recordLiveNotification, stopSession } from "../stream-sessions";
import { captureRig, phoneId } from "./_capture-rig";

const HAS_DB = !!process.env.DATABASE_URL;

const ENV_KEYS = ["RELAY_KEK", "AUTH_SECRET", "OAUTH_BASE_URL", "NEXT_PUBLIC_BASE_URL", "STREAM_PLAYBACK_HOST", "STREAM_SRT_ENABLED", "RELAY_DRIVERS", "RELAY_IMAGE", "CLOUDFLARE_LIVE_WEBHOOK_SECRET"] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const KEK = randomBytes(32).toString("hex");
const WEBHOOK_SECRET = "ZZ-t45-camera-reconnect-secret";
function baseEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.RELAY_KEK = KEK;
  process.env.AUTH_SECRET = "camera-reconnect-nudge-test-secret";
  process.env.RELAY_IMAGE = "registry.fly.io/seazn-relay:camera-reconnect-nudge-test";
  process.env.CLOUDFLARE_LIVE_WEBHOOK_SECRET = WEBHOOK_SECRET;
}
beforeAll(baseEnv);
beforeEach(baseEnv);
afterEach(() => setRelayDriversForTest(null));
afterAll(() => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

type Beat = z.infer<typeof CaptureBeat>;
const SEC = 1000;
const NEVER = 3_600_000;

/** The published contract, as the compositor vendors it: ajv 2020-12, strict, formats asserted (relay-contract.test.ts's reading). */
const CONTRACT = resolve(import.meta.dirname, "../../../../../../docs/contracts/relay-job.v1.json");
const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);
ajv.addSchema(JSON.parse(readFileSync(CONTRACT, "utf8")));
const replyBytesValid = (reply: unknown): boolean => {
  const validate = ajv.getSchema("https://seazn.club/contracts/relay-job.v1.json#/$defs/heartbeatReply");
  expect(validate, "PREMISE: ajv resolves the heartbeatReply shape").toBeDefined();
  return validate!(reply) as boolean;
};

type Event = "connected" | "disconnected" | "errored";
const note = (inputUid: string, event: Event, at: Date) => ({
  inputUid, event: `live_input.${event}`, word: (event === "errored" ? "unknown" : event) as IngestState, reason: event === "errored" ? "ERR_GOP_OUT_OF_RANGE" : null, at,
});

/** A composed session (the only mode with a relay), its phone paired and beating through the real claim. The fake ingest never
 *  connects, so nothing but the steps below moves the session. */
async function composedRig() {
  const r = await captureRig({ credits: 1, connectAfterMs: NEVER });
  const phone = phoneId("cam");
  await pairPresentPhone(r.fixtureId, { phone, at: r.now() });
  const { sessionId: S } = await createSession(r.auth, r.fixtureId, { mode: "composed", targetId: r.target.id }, r.deps);
  const jobToken = r.runner.created[0]!.jobToken;
  const uidOf = async (role: "camera" | "programme") => {
    const [row] = await sql<{ ingest_input_id: string | null }[]>`
      select ingest_input_id from fixture_stream_inputs where session_id = ${S} and role = ${role}`;
    expect(row?.ingest_input_id, `PREMISE: the ${role} input was provisioned with a uid`).toBeTruthy();
    return row!.ingest_input_id!;
  };
  const self = {
    r, S, jobToken, camera: await uidOf("camera"), programme: await uidOf("programme"),
    /** Seconds after the rig's clock at creation, as a moment. */
    t0: r.now().getTime(),
    at(s: number) { return new Date(self.t0 + s * SEC); },
    async phoneBeat(state: Beat["state"]) {
      r.tick(5 * SEC);
      return postBeat(r.code, r.tok, CaptureBeat.parse({
        code: r.code, slot: 0, phone, claim: null, device: null, sid: S, at: r.now().toISOString(), state,
        cause: null, notReady: null, startFailed: null, stopped: null, mode: "operator", transport: null, bitrateKbps: null,
        delivery: "unknown", deliveredLagS: null, audioOk: null, battery: null, thermal: null, dataUsedMB: null,
        appVersion: "camera-reconnect-nudge-test/1",
      }), r.deps, r.now());
    },
    /** The relay's heartbeat reply: `phoneLiveEdge` (undefined when omitted), after checking the reply against both readings of the
     *  contract — the zod twin web serves with and the published bytes the compositor vendors. */
    async relayBeat(): Promise<number | null | undefined> {
      const reply = await heartbeat(S, jobToken, { state: "playing" }, r.deps);
      expect(RelayHeartbeatReply.safeParse(reply).success, JSON.stringify(reply)).toBe(true);
      expect(replyBytesValid(reply), `the published contract admits ${JSON.stringify(reply)}`).toBe(true);
      return (reply as { phoneLiveEdge?: number | null }).phoneLiveEdge;
    },
    async cf(input: "camera" | "programme", event: Event, s: number) {
      return recordLiveNotification(note(input === "camera" ? self.camera : self.programme, event, self.at(s)), new Date());
    },
  };
  return self;
}
const edgeOf = async (sid: string) =>
  (await sql<{ phone_live_edge: number | null }[]>`select phone_live_edge from fixture_stream_sessions where id = ${sid}`)[0]!.phone_live_edge;
const stateOf = async (sid: string) => (await sql<{ state: string }[]>`select state from fixture_stream_sessions where id = ${sid}`)[0]!.state;
const webhookRows = async (sid: string) => (await sql<{ n: number }[]>`
  select count(*)::int as n from fixture_stream_events where session_id = ${sid} and type = 'ingest_status' and source = 'webhook'`)[0]!.n;

describe.skipIf(!HAS_DB)("a returning camera nudges the relay (Task 45)", () => {
  it("EMPTY CASE FIRST: no phone has been live, so there is no counter — a camera connect, drop and re-connect are each recorded and the reply still omits the field", async () => {
    const s = await composedRig();
    expect(await s.relayBeat(), "PREMISE: a fresh composed session has no counter").toBeUndefined();
    let checked = 0;
    for (const [event, sec] of [["connected", 1], ["disconnected", 2], ["connected", 3]] as const) {
      const out = await s.cf("camera", event, sec);
      expect(out, `${event}@+${sec}s`).toMatchObject({ outcome: "recorded", role: "camera" });
      expect(out, `${event}@+${sec}s raised nothing`).not.toHaveProperty("edge");
      checked++;
    }
    expect(checked).toBe(3);
    expect(await webhookRows(s.S), "every notification stored").toBe(3);
    expect(await edgeOf(s.S)).toBeNull();
    expect(await s.relayBeat(), "still omitted: Cloudflare never creates the counter").toBeUndefined();
  });

  it("the sequence: first connect no edge; two drops then a re-connect is ONE edge; its second delivery is a duplicate; a re-connect with no drop between (a new publisher) is another; every event stored, and the relay's reply serves each value", async () => {
    const s = await composedRig();
    await s.phoneBeat("publishing");
    expect(await s.relayBeat(), "PREMISE: the phone's first live sets the counter at 0").toBe(0);

    // [event, second, the counter the relay must read after it] — read off the rules in the header, by hand.
    const steps: [Event, number, number][] = [
      ["connected", 1, 0],      // the input's first connect: the session starting, not a return
      ["disconnected", 10, 0],  // the drop
      ["disconnected", 12, 0],  // a second drop: recorded, no edge (and never deduped away: another moment)
      ["connected", 20, 1],     // the return
      ["connected", 40, 2],     // stg 5e5403ce's shape: Cloudflare takes a NEW publisher on a held input, `connected` → `connected`
    ];
    const seen: number[] = [];
    for (const [event, sec, want] of steps) {
      const out = await s.cf("camera", event, sec);
      expect(out, `${event}@+${sec}s`).toMatchObject({ outcome: "recorded", role: "camera" });
      const reply = await s.relayBeat();
      expect(reply, `${event}@+${sec}s: the relay reads`).toBe(want);
      seen.push(reply as number);
    }
    expect(seen).toEqual([0, 0, 0, 1, 2]);
    expect(await webhookRows(s.S), "all five stored").toBe(5);

    // The +20 return delivered again (Cloudflare documents no delivery id; its natural key is the input, the event and the moment).
    expect(await s.cf("camera", "connected", 20)).toEqual({ outcome: "duplicate", sessionId: s.S });
    expect(await s.relayBeat(), "a duplicate is no news").toBe(2);
    expect(await webhookRows(s.S)).toBe(5);
    expect(await stateOf(s.S), "a nudge, never a decision: the session state is untouched").not.toMatch(/^(ending|completed|failed)$/);
  });

  it("stale and foreign: a re-connect delivered after a LATER event of its input is recorded but no edge; the programme input's return is never one", async () => {
    const s = await composedRig();
    await s.phoneBeat("publishing");
    expect(await s.cf("camera", "connected", 1)).not.toHaveProperty("edge");
    expect(await s.cf("camera", "disconnected", 30)).not.toHaveProperty("edge");
    // +20 arrives after the +30 drop: in the past the relay has moved through.
    expect(await s.cf("camera", "connected", 20), "late").toMatchObject({ outcome: "recorded", from: "connected" });
    expect(await s.relayBeat(), "the late connect is no edge").toBe(0);
    // The programme input connecting, dropping and coming back.
    for (const [event, sec] of [["connected", 2], ["disconnected", 3], ["connected", 4]] as const) {
      expect(await s.cf("programme", event, sec), `programme ${event}`).not.toHaveProperty("edge");
    }
    expect(await s.relayBeat(), "the programme is the relay's own output").toBe(0);
    // Control: the camera's next return, on time, is an edge (so the two above were refused by their rule, not by a dead path).
    expect(await s.cf("camera", "connected", 40)).toMatchObject({ outcome: "recorded", edge: 1 });
    expect(await s.relayBeat()).toBe(1);
  });

  it("the phone's own `publishing` after its outage may add one more: the counter only climbs, and the relay acts on each increase once", async () => {
    const s = await composedRig();
    await s.phoneBeat("publishing");
    await s.cf("camera", "connected", 1);
    await s.phoneBeat("reconnecting");
    await s.cf("camera", "disconnected", 12);
    expect(await s.cf("camera", "connected", 14)).toMatchObject({ edge: 1 });
    expect(await s.relayBeat(), "Cloudflare's return lands first").toBe(1);
    await s.phoneBeat("publishing");
    expect(await s.relayBeat(), "the phone's own edge on top").toBe(2);
  });

  it("an ending session, then an ended one: a camera re-connect is still recorded (the phone's history) and moves nothing; the relay is told to stop, then 410", async () => {
    const s = await composedRig();
    await s.phoneBeat("publishing");
    await s.cf("camera", "connected", 1);
    await s.cf("camera", "disconnected", 5);
    await stopSession(s.r.auth, s.r.fixtureId, s.S, s.r.deps);
    expect(await stateOf(s.S), "PREMISE: the Stop moved it to ending").toBe("ending");
    expect(await s.cf("camera", "connected", 9), "ending").toMatchObject({ outcome: "recorded" });
    expect(await s.cf("camera", "connected", 9)).toEqual({ outcome: "duplicate", sessionId: s.S });
    expect(await edgeOf(s.S)).toBe(0);
    await sql`update fixture_stream_sessions set state = 'completed', end_reason = 'stopped' where id = ${s.S}`;
    const out = await s.cf("camera", "connected", 15);
    expect(out, "completed").toMatchObject({ outcome: "recorded", sessionId: s.S });
    expect(out).not.toHaveProperty("edge");
    expect(await edgeOf(s.S)).toBe(0);
    expect(await webhookRows(s.S), "four stored, the duplicate not").toBe(4);
    await expect(heartbeat(s.S, s.jobToken, { state: "playing" }, s.r.deps)).rejects.toSatisfy((e) => e instanceof HttpError && e.status === 410);
  });

  it("through the route: Cloudflare's body for the camera's return, POSTed with the destination's secret, raises the value the relay's next reply carries", async () => {
    const s = await composedRig();
    setRelayDriversForTest({ ingest: s.r.ingest, runner: s.r.runner });
    await s.phoneBeat("publishing");
    const post = async (event: Event, sec: number) => {
      const updatedAt = s.at(sec).toISOString();
      const res = await webhookRoute(new Request("https://test.local/api/webhooks/cloudflare-stream-live", {
        method: "POST", headers: { "content-type": "application/json", "cf-webhook-auth": WEBHOOK_SECRET },
        body: JSON.stringify({
          name: "Seazn live inputs", text: `Input ID: ${s.camera}`,
          data: { notification_name: "Stream Live Input", input_id: s.camera, event_type: `live_input.${event}`, updated_at: updatedAt },
          ts: Math.floor(s.at(sec).getTime() / 1000),
        }),
      }));
      expect(res.status, `${event}@+${sec}s`).toBe(200);
      return res.json() as Promise<{ received?: boolean; outcome?: string }>;
    };
    expect(await post("connected", 1)).toEqual({ received: true, outcome: "recorded" });
    expect(await post("disconnected", 8)).toEqual({ received: true, outcome: "recorded" });
    expect(await s.relayBeat()).toBe(0);
    expect(await post("connected", 11)).toEqual({ received: true, outcome: "recorded" });
    expect(await s.relayBeat(), "the next reply carries the raise").toBe(1);
  });
});
