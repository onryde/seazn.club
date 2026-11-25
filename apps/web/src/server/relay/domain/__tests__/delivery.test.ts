// Task 46 (owner 2026-11-24, apply-rec) — domain/delivery.ts: the beat answer's delivery facts, from what the server STORES.
//
// The rules under test, typed from the brief and the contract (docs/contracts/capture-beat.v1.json, capture-schemas
// CaptureDelivery), never read off the code under test:
//   - the relay members (relayOutput, programmePhase, fps, kbps) come from the Machine's stored beat
//     (fixture_stream_sessions.last_heartbeat, written by usecases/stream-sessions/heartbeat.ts) while it is at most "3 relay
//     beats" old — config's RELAY_HEARTBEAT_INTERVAL_MS × 3 — and never from its final (stopped) beat;
//   - fps and kbps are the beat's fps and bitrateKbps rounded to whole numbers (the contract's prose);
//   - cameraIngest / programmeIngest come from the latest recorded Cloudflare live-input event for that input, its name without
//     `live_input.` (relay/cf-live-notification.ts lists the events);
//   - unknown or absent → the member is omitted, never null; a stored word outside the wire vocabulary is unknown.
// Pure: no DB, no clock (`now` is passed in). One sport on purpose: delivery reads no sport rule.
import { describe, expect, it } from "vitest";
import { CaptureDelivery } from "@/server/api-v1/capture-schemas";
import { PROGRAMME_PHASES } from "@/lib/relay-phase";
import type { CfLiveEvent } from "../../cf-live-notification";
import { DELIVERY_RELAY_FRESH_MS, RELAY_HEARTBEAT_INTERVAL_MS } from "../../config";
import { deliveryOf, type StoredDelivery } from "../delivery";

const NOW = new Date("2026-11-24T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);
/** A playing Machine's beat as heartbeat.ts stores it (RelayHeartbeat's own field names). */
const BEAT = { state: "playing", output: "connected", programmePhase: "live", fps: 29.97, bitrateKbps: 4500.4, input: "connected", inputKicks: 2 };
const FULL: StoredDelivery = { relayBeat: BEAT, relayBeatAt: ago(1000), cameraEvent: "live_input.connected", programmeEvent: "live_input.connected" };
const RELAY = ["relayOutput", "programmePhase", "fps", "kbps"] as const;
const INGEST = ["cameraIngest", "programmeIngest"] as const;
/** Cloudflare's documented events (cf-live-notification.ts), typed so a new one fails here until it is mapped. */
const CF_EVENTS: Record<CfLiveEvent, true> = { "live_input.connected": true, "live_input.disconnected": true, "live_input.errored": true };

let outputsChecked = 0;
/** Every output: a valid wire object, and no member null or undefined (omitted, never null). */
function wire(s: StoredDelivery, now = NOW) {
  const d = deliveryOf(s, now);
  expect(CaptureDelivery.parse(d)).toEqual(d);
  for (const [k, v] of Object.entries(d)) expect(v, `${k}: omitted, never null`).not.toBeNull();
  for (const v of Object.values(d)) expect(v).not.toBeUndefined();
  outputsChecked++;
  return d;
}

describe("deliveryOf — the beat answer's delivery facts (Task 46)", () => {
  it("a fresh playing beat and both Cloudflare inputs connected → all six members, each the stored fact (fps and kbps rounded)", () => {
    expect(wire(FULL)).toEqual({
      relayOutput: BEAT.output, programmePhase: BEAT.programmePhase, fps: Math.round(BEAT.fps), kbps: Math.round(BEAT.bitrateKbps),
      cameraIngest: "connected", programmeIngest: "connected",
    });
    // The Machine's other facts (input, inputKicks, state) never reach the wire: only the six members exist.
    expect(Object.keys(wire(FULL)).sort()).toEqual([...RELAY, ...INGEST].sort());
  });

  it("freshness is 3 relay beats (the brief): a beat exactly that old is told, a millisecond older is not — the Cloudflare members stay", () => {
    expect(DELIVERY_RELAY_FRESH_MS, "3 × the cadence the compositor is served").toBe(3 * RELAY_HEARTBEAT_INTERVAL_MS);
    const edge = wire({ ...FULL, relayBeatAt: ago(DELIVERY_RELAY_FRESH_MS) });
    for (const m of RELAY) expect(edge, `${m} at the edge`).toHaveProperty(m);
    const stale = wire({ ...FULL, relayBeatAt: ago(DELIVERY_RELAY_FRESH_MS + 1) });
    for (const m of RELAY) expect(stale, `${m} one ms past`).not.toHaveProperty(m);
    expect(stale).toEqual({ cameraIngest: "connected", programmeIngest: "connected" });
  });

  it("no stored beat (none yet, or no time stored) → only the Cloudflare members", () => {
    expect(wire({ ...FULL, relayBeat: null, relayBeatAt: null })).toEqual({ cameraIngest: "connected", programmeIngest: "connected" });
    expect(wire({ ...FULL, relayBeatAt: null })).toEqual({ cameraIngest: "connected", programmeIngest: "connected" });
    expect(wire({ ...FULL, relayBeat: null })).toEqual({ cameraIngest: "connected", programmeIngest: "connected" });
  });

  it("the Machine's FINAL beat (state stopped) is no relay fact, however fresh: it describes a process that has exited", () => {
    const final = wire({ ...FULL, relayBeat: { ...BEAT, state: "stopped", programmePhase: "final", exitReason: "restart" } });
    for (const m of RELAY) expect(final, m).not.toHaveProperty(m);
    // …while every other beat state the Machine sends is told.
    let told = 0;
    for (const state of ["starting", "playing", "stalled"]) {
      expect(wire({ ...FULL, relayBeat: { ...BEAT, state } }), state).toHaveProperty("relayOutput", BEAT.output);
      told++;
    }
    expect(told).toBe(3);
  });

  it("each relay field absent or null in the stored beat → only that member is omitted", () => {
    const FIELD: Record<(typeof RELAY)[number], keyof typeof BEAT> = { relayOutput: "output", programmePhase: "programmePhase", fps: "fps", kbps: "bitrateKbps" };
    let swept = 0;
    for (const m of RELAY) {
      for (const absent of [null, undefined]) {
        const beat: Record<string, unknown> = { ...BEAT, [FIELD[m]]: absent };
        if (absent === undefined) delete beat[FIELD[m]];
        const d = wire({ ...FULL, relayBeat: beat });
        expect(d, m).not.toHaveProperty(m);
        expect(Object.keys(d).sort(), m).toEqual([...RELAY, ...INGEST].filter((k) => k !== m).sort());
        swept++;
      }
    }
    expect(swept).toBe(RELAY.length * 2);
  });

  it("every stored word of the relay's own vocabularies is told verbatim; a word outside it (a newer compositor's) is unknown, so omitted", () => {
    let told = 0;
    for (const output of ["connecting", "connected", "backoff"]) {
      expect(wire({ ...FULL, relayBeat: { ...BEAT, output } }).relayOutput).toBe(output);
      told++;
    }
    for (const phase of PROGRAMME_PHASES) {
      expect(wire({ ...FULL, relayBeat: { ...BEAT, programmePhase: phase } }).programmePhase).toBe(phase);
      told++;
    }
    expect(told).toBe(3 + PROGRAMME_PHASES.length);
    expect(wire({ ...FULL, relayBeat: { ...BEAT, output: "draining" } })).not.toHaveProperty("relayOutput");
    expect(wire({ ...FULL, relayBeat: { ...BEAT, programmePhase: "intermission" } })).not.toHaveProperty("programmePhase");
    // Numbers: rounded half up to whole numbers; a non-number or a negative is unknown.
    expect(wire({ ...FULL, relayBeat: { ...BEAT, fps: 24.5, bitrateKbps: 0 } })).toMatchObject({ fps: 25, kbps: 0 });
    expect(wire({ ...FULL, relayBeat: { ...BEAT, fps: "30" } })).not.toHaveProperty("fps");
    expect(wire({ ...FULL, relayBeat: { ...BEAT, bitrateKbps: -1 } })).not.toHaveProperty("kbps");
    // A stored beat that is not an object at all is no relay fact.
    for (const odd of ["playing", 5, [BEAT]]) expect(wire({ ...FULL, relayBeat: odd }), JSON.stringify(odd)).toEqual({ cameraIngest: "connected", programmeIngest: "connected" });
  });

  it("each Cloudflare live-input event is told as its name without `live_input.`, per input; an unknown name or none is omitted", () => {
    let mapped = 0;
    for (const event of Object.keys(CF_EVENTS)) {
      const word = event.slice("live_input.".length);
      expect(wire({ ...FULL, cameraEvent: event, programmeEvent: null })).toEqual({ ...wire({ ...FULL, cameraEvent: null, programmeEvent: null }), cameraIngest: word });
      expect(wire({ ...FULL, cameraEvent: null, programmeEvent: event }).programmeIngest).toBe(word);
      mapped++;
    }
    expect(mapped).toBe(3);
    // The two inputs are read apart: a programme down with the camera connected is exactly the case the phone needs told.
    expect(wire({ ...FULL, programmeEvent: "live_input.disconnected" })).toMatchObject({ cameraIngest: "connected", programmeIngest: "disconnected" });
    expect(wire({ ...FULL, cameraEvent: "live_input.unknown_event" })).not.toHaveProperty("cameraIngest");
    expect(wire({ ...FULL, programmeEvent: "" })).not.toHaveProperty("programmeIngest");
  });

  it("nothing known → an empty object (the wire builder omits it, beat-answer.test.ts); the same facts give the same answer twice", () => {
    expect(wire({ relayBeat: null, relayBeatAt: null, cameraEvent: null, programmeEvent: null })).toEqual({});
    expect(wire(FULL)).toEqual(wire(FULL));
  });

  it("anti-vacuity: outputs were checked", () => {
    expect(outputsChecked).toBeGreaterThan(30);
  });
});
