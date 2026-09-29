// The Phone tab's pure view model. Claims: the copy maps are TOTAL over their
// unions (derived from the zod enums and the destination validator's own
// list, never typed here — a new fail reason or refusal rule cannot ship
// without copy); every key each map names exists in all FOUR dictionaries;
// C6 — no health-line copy says "healthy"; the beat chip goes stale at 45 s
// exactly; a null view is idle (the empty case).
//
// Create refusals (lane D amendment D1) are read off a REAL ApiV1Error: each
// server error goes through the real v1 envelope (`v1()`, server/api-v1/http.ts)
// and the real client transport (`apiV1`, lib/client-v1.ts) — so the test sees
// exactly the `code` / `extra` split the Phone tab will, not a bare object
// shaped like the author's belief about the wire. That round trip is how D1's
// premise that a plan refusal carries `extra.reason: "plan_lacks_relay"` was
// found false: the envelope's `reason` is featureReason()'s human sentence, and
// the machine-readable discriminator is `extra.feature_key`.
//
// One sport, on purpose: nothing here reads a sport — the relay is
// sport-agnostic, and the view model takes no sport input at all.
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { HttpError, PaymentRequiredError } from "@/lib/errors";
import { ApiV1Error, apiV1 } from "@/lib/client-v1";
import { parseCaptureQr } from "@/lib/capture-qr";
import { DESTINATION_NOT_ALLOWED, DESTINATION_REFUSALS, STREAM_DESTINATION_HOSTS } from "@/lib/stream-destinations";
import { messages } from "@/lib/messages";
import { v1 } from "@/server/api-v1/http";
import { StreamEndReason, StreamFailReason, StreamIngest, StreamSessionState } from "@/server/api-v1/schemas";
import { DestinationNotAllowedError } from "@/server/usecases/stream-targets";
import {
  BEAT_STALE_SECONDS, CREATE_ERROR_CODES, CREATE_ERROR_KEYS, DESTINATION_REFUSAL_KEYS, END_REASON_KEYS, FAIL_REASON_KEYS,
  INGEST_STATE_KEYS, STATE_PILL_KEYS, STEP_KEYS, STREAM_POLL_MS, type CreateErrorCode, type PhoneTabState, type StreamSessionView,
  createErrorCode, createErrorHolder, createErrorText, elapsedLabel, healthChips, phoneTabState, qrText, stepFor, targetRefusalRule,
} from "../stream-session-view";

const DICT_DIR = join(import.meta.dirname, "..", "..", "dictionaries");
const LOCALES = ["en", "es", "fr", "nl"] as const;
const dict = (l: string): Record<string, string> => JSON.parse(readFileSync(join(DICT_DIR, l, "ui.json"), "utf8"));
const msg = (k: string, vars: Record<string, string | number> = {}) =>
  Object.entries(vars).reduce((s, [n, v]) => s.replaceAll(`{${n}}`, String(v)), (messages as Record<string, string>)[k] ?? `MISSING:${k}`);

/** Every key in all four locales; returns how many lookups it made (anti-vacuity: the caller asserts > 0). */
function inEveryLocale(keys: readonly string[]): number {
  let checked = 0;
  for (const l of LOCALES) {
    const d = dict(l);
    for (const k of keys) {
      expect(d[k], `${l} ${k}`).toBeTruthy();
      checked++;
    }
  }
  return checked;
}

const NOW = new Date("2026-09-14T12:10:00Z");
const view = (over: Partial<StreamSessionView> = {}): StreamSessionView => ({
  id: "s", fixtureId: "f", mode: "passthrough", state: "live", desiredState: "live", failReason: null,
  health: null, ingest: { state: "connected", protocol: "srt" }, qr: null, balance: 2,
  startedAt: "2026-09-14T12:00:00Z", endedAt: null, replayUrl: null,
  target: { id: "t", kind: "youtube", label: "Club" }, fixtureDecided: false, endReason: null, creditUsed: true, ...over,
});

/** A server error through the REAL v1 envelope and the REAL client transport — the ApiV1Error the Phone tab catches. */
async function wire(err: Error): Promise<ApiV1Error> {
  const res = await v1(async () => { throw err; });
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(res);
  try {
    await apiV1("/api/v1/fixtures/f-1/stream-sessions", { method: "POST", json: { mode: "passthrough", targetId: "t" } });
  } catch (caught) {
    expect(caught).toBeInstanceOf(ApiV1Error);
    return caught as ApiV1Error;
  } finally {
    fetchSpy.mockRestore();
  }
  throw new Error("apiV1 resolved on an error response");
}

afterEach(() => vi.restoreAllMocks());

describe("stream-session-view — the copy maps", () => {
  it("the fail-reason map is total over StreamFailReason — the five lifecycle reasons AND the two timed exits — one key each, in all four locales; the end-reason map likewise", () => {
    expect(Object.keys(FAIL_REASON_KEYS).sort()).toEqual([...StreamFailReason.options].sort());
    expect(Object.keys(END_REASON_KEYS).sort()).toEqual([...StreamEndReason.options].sort());
    // E5: no storage_exhausted copy in the FAILED map — nothing can select it.
    expect(Object.values(FAIL_REASON_KEYS)).not.toContain("stream.fail.storage_exhausted");
    // One sentence per reason, and the RIGHT one: each entry is the key the brief names for that member
    // (`stream.fail.<reason>`, `stream.phone.ended.reason.<reason>`) — totality alone cannot see two entries swapped.
    for (const r of StreamFailReason.options) expect(FAIL_REASON_KEYS[r], r).toBe(`stream.fail.${r}`);
    for (const r of StreamEndReason.options) expect(END_REASON_KEYS[r], r).toBe(`stream.phone.ended.reason.${r}`);
    expect(inEveryLocale([...Object.values(FAIL_REASON_KEYS), ...Object.values(END_REASON_KEYS)])).toBe(
      LOCALES.length * (StreamFailReason.options.length + StreamEndReason.options.length),
    );
  });

  it("the create-error map is total over CREATE_ERROR_CODES, one key each, plus the holder-less target_in_use variant, in all four locales", () => {
    expect(Object.keys(CREATE_ERROR_KEYS).sort()).toEqual([...CREATE_ERROR_CODES].sort());
    for (const c of CREATE_ERROR_CODES) expect(CREATE_ERROR_KEYS[c], c).toBe(`stream.error.${c}`);
    expect(inEveryLocale([...Object.values(CREATE_ERROR_KEYS), "stream.error.target_in_use.unknown"])).toBe(
      LOCALES.length * (CREATE_ERROR_CODES.length + 1),
    );
  });

  it("C6: the ingest-state copy is total over StreamIngest's state enum, names the state and never says healthy, in all four locales", () => {
    expect(Object.keys(INGEST_STATE_KEYS).sort()).toEqual([...StreamIngest.shape.state.options].sort());
    for (const s of StreamIngest.shape.state.options) expect(INGEST_STATE_KEYS[s], s).toBe(`stream.health.ingest.${s}`);
    let health = 0;
    for (const l of LOCALES) {
      const d = dict(l);
      for (const k of Object.values(INGEST_STATE_KEYS)) {
        expect(d[k], `${l} ${k}`).toBeTruthy();
        expect(d[k]!.toLowerCase()).not.toMatch(/health|saludable|sain|gezond/);
      }
      for (const [k, v] of Object.entries(d)) {
        if (!k.startsWith("stream.health.")) continue;
        expect(v.toLowerCase(), `${l} ${k}`).not.toMatch(/health/);
        health++;
      }
    }
    expect(health, "the stream.health.* sweep read nothing").toBeGreaterThanOrEqual(LOCALES.length * Object.keys(INGEST_STATE_KEYS).length);
  });

  it("D2: the destination-refusal map is total over the validator's own DESTINATION_REFUSALS, in all four locales; the host copy names every allowlisted provider, and no copy anywhere names LinkedIn", () => {
    expect(Object.keys(DESTINATION_REFUSAL_KEYS).sort()).toEqual([...DESTINATION_REFUSALS].sort());
    for (const r of DESTINATION_REFUSALS) expect(DESTINATION_REFUSAL_KEYS[r], r).toBe(`stream.target.refused.${r}`);
    expect(inEveryLocale(Object.values(DESTINATION_REFUSAL_KEYS))).toBe(LOCALES.length * DESTINATION_REFUSALS.length);
    // Brand names are proper nouns — the same in every locale. Derived from the allowlist, so a provider added there
    // without naming it here reds (lib/stream-destinations.ts: "the entry, its source, and the pinned count … move together").
    const providers = [...new Set(STREAM_DESTINATION_HOSTS.map((h) => h.provider.replace(/_/g, " ")))];
    expect(providers.length, "the allowlist names no providers").toBeGreaterThan(0);
    let named = 0;
    for (const l of LOCALES) {
      const host = dict(l)[DESTINATION_REFUSAL_KEYS.host]!.toLowerCase();
      for (const p of providers) {
        expect(host, `${l}: the host refusal does not name ${p}`).toContain(p);
        named++;
      }
      for (const [k, v] of Object.entries(dict(l))) if (k.startsWith("stream.")) expect(v, `${l} ${k}`).not.toMatch(/linkedin/i);
    }
    expect(named).toBe(LOCALES.length * providers.length);
  });
});

describe("stream-session-view — state, step and pill", () => {
  it("state → phone-tab state, over EVERY session state the enum declares; the empty case (no session) is idle; every pill is reached", () => {
    // The design's table (plan Task 13 §"Produces"), enumerated rather than sampled.
    const TABLE: Record<(typeof StreamSessionState.options)[number], PhoneTabState> = {
      requested: "provisioning", provisioning: "provisioning", warming: "warming", live: "live",
      ending: "ending", completed: "ended", failed: "failed",
    };
    expect(Object.keys(TABLE).sort(), "the table covers the enum").toEqual([...StreamSessionState.options].sort());
    expect(phoneTabState(null)).toBe("idle");
    const reached = new Set<PhoneTabState>(["idle"]);
    for (const s of StreamSessionState.options) {
      expect(phoneTabState(view({ state: s })), s).toBe(TABLE[s]);
      reached.add(phoneTabState(view({ state: s })));
    }
    expect([...reached].sort(), "every pill key is reachable, and nothing reaches a state without a pill").toEqual(Object.keys(STATE_PILL_KEYS).sort());
  });

  it("step per state; four step keys and seven pill keys, in all four locales", () => {
    expect((["idle", "provisioning", "warming", "live", "ending", "ended", "failed"] as const).map(stepFor)).toEqual([1, 2, 2, 3, 3, 4, 4]);
    expect(STEP_KEYS).toEqual([1, 2, 3, 4].map((n) => `stream.phone.step${n}`));
    for (const [s, k] of Object.entries(STATE_PILL_KEYS)) expect(k, s).toBe(`stream.phone.state.${s}`);
    expect(inEveryLocale([...STEP_KEYS, ...Object.values(STATE_PILL_KEYS)])).toBe(LOCALES.length * (4 + 7));
  });
});

describe("stream-session-view — create refusals off the real wire (D1)", () => {
  // The rulebook: D1's mapping, one row per refusal createSession produces (server/usecases/stream-sessions.ts
  // `refuse` :944-954, `targetInUse` :935-941, the index race :1078, the saved-target re-check :1027-1031, the ingest
  // refusal :1095, the actor/fixture guards :950/:967), plus the codes D1 names as "anything else".
  const ROWS: [string, Error, CreateErrorCode][] = [
    ["no_credits 402", new HttpError(402, "This organisation has no match credits", "no_credits", { featureKey: "streaming.relay" }), "no_credits"],
    ["overlay_required 409", new HttpError(409, "phone streaming needs the overlay tier", "overlay_required"), "overlay_required"],
    ["active_session 409", new HttpError(409, "a session is already running for this fixture", "active_session", { sessionId: "s-1" }), "active_session"],
    ["storage_exhausted 503", new HttpError(503, "recording storage is exhausted", "storage_exhausted", { headroomMinutes: 12 }), "storage_exhausted"],
    ["ingest_unavailable 503", new HttpError(503, "the ingest service is unavailable", "ingest_unavailable"), "ingest_unavailable"],
    ["target_in_use 409, a holder with a court", new HttpError(409, "in use", "target_in_use", { holder: { fixtureId: "f-2", courtName: "Court 3", label: "Club channel" } }), "target_in_use"],
    ["target_in_use 409, the index race (holder null)", new HttpError(409, "in use", "target_in_use", { holder: null }), "target_in_use"],
    // m4 (Task 13 review): the server's OWN refusal class (stream-targets.ts), not an HttpError shaped like it.
    ["DESTINATION_NOT_ALLOWED 422", new DestinationNotAllowedError("host"), "destination_not_allowed"],
    ["PAYMENT_REQUIRED streaming.relay", new PaymentRequiredError("streaming.relay"), "plan_lacks_relay"],
    ["PAYMENT_REQUIRED streaming.overlay", new PaymentRequiredError("streaming.overlay"), "plan_lacks_relay"],
    ["PAYMENT_REQUIRED, an unrelated feature", new PaymentRequiredError("formats.double_elim"), "unknown"],
    ["NOT_FOUND 404 (target_not_found)", new HttpError(404, "stream target not found"), "unknown"],
    ["FORBIDDEN 403 (no signed-in user)", new HttpError(403, "a signed-in organiser is required"), "unknown"],
    ["a code the union does not name", new HttpError(409, "session is not running", "not_active"), "unknown"],
    ["a code that is an Object.prototype key", new HttpError(409, "prototype", "constructor"), "unknown"],
    ["an unhandled server error (500 INTERNAL)", new Error("boom"), "unknown"],
  ];

  it("every row maps to its D1 code, and every CreateErrorCode is produced by at least one row (no dead map entry)", async () => {
    const produced = new Set<CreateErrorCode>();
    let checked = 0;
    for (const [name, err, expected] of ROWS) {
      const got = createErrorCode(await wire(err));
      expect(got, name).toBe(expected);
      produced.add(got);
      checked++;
    }
    expect(checked).toBe(ROWS.length);
    expect([...produced].sort()).toEqual([...CREATE_ERROR_CODES].sort());
  });

  it("the plan refusal's machine-readable field is feature_key — the envelope's reason is a sentence, never 'plan_lacks_relay' (D1's premise, measured)", async () => {
    const e = await wire(new PaymentRequiredError("streaming.relay"));
    expect(e.code).toBe("PAYMENT_REQUIRED");
    expect(e.extra.feature_key).toBe("streaming.relay");
    expect(e.extra.reason).not.toBe("plan_lacks_relay");
    expect(typeof e.extra.reason).toBe("string");
  });

  it("errors that never reached the server are unknown: a network TypeError, an AbortError, a string, null", () => {
    expect(createErrorCode(new TypeError("Failed to fetch"))).toBe("unknown");
    expect(createErrorCode(new DOMException("aborted", "AbortError"))).toBe("unknown");
    expect(createErrorCode("no_credits")).toBe("unknown");
    expect(createErrorCode(null)).toBe("unknown");
  });

  it("m6: an error with a code but NO extra is read as an empty extra — never a TypeError out of the reader", () => {
    // Both rows reach `wireError`'s `extra` guard: without it `w.extra` is undefined and the property read throws.
    expect(createErrorCode(Object.assign(new Error("x"), { code: "PAYMENT_REQUIRED" }))).toBe("unknown");
    expect(createErrorHolder({ code: "target_in_use" })).toBeNull();
    expect(targetRefusalRule({ code: DESTINATION_NOT_ALLOWED })).toBeNull();
  });

  it("createErrorHolder reads extra.holder: the court and label when present; courtName null kept; null for the index race, another code, or a malformed holder", async () => {
    expect(createErrorHolder(await wire(new HttpError(409, "in use", "target_in_use", { holder: { fixtureId: "f-2", courtName: "Court 3", label: "Club channel" } }))))
      .toEqual({ courtName: "Court 3", label: "Club channel" });
    expect(createErrorHolder(await wire(new HttpError(409, "in use", "target_in_use", { holder: { fixtureId: null, courtName: null, label: "Club channel" } }))))
      .toEqual({ courtName: null, label: "Club channel" });
    expect(createErrorHolder(await wire(new HttpError(409, "in use", "target_in_use", { holder: null })))).toBeNull();
    expect(createErrorHolder(await wire(new HttpError(409, "busy", "active_session", { holder: { courtName: "Court 3", label: "Club channel" } })))).toBeNull();
    expect(createErrorHolder(await wire(new HttpError(409, "in use", "target_in_use", { holder: { courtName: "Court 3" } })))).toBeNull();
    expect(createErrorHolder(new Error("boom"))).toBeNull();
  });

  it("createErrorText: target_in_use names the destination and the court; without a court (or a holder) it says 'another match'; any other code is its map entry", () => {
    const named = createErrorText({ code: "target_in_use", holder: { courtName: "Court 3", label: "Club channel" } }, msg);
    expect(named).toBe(msg("stream.error.target_in_use", { destination: "Club channel", court: "Court 3" }));
    expect(named).toContain("Club channel");
    expect(named).toContain("Court 3");
    expect(named).not.toMatch(/[{}]/);
    expect(createErrorText({ code: "target_in_use", holder: { courtName: null, label: "Club channel" } }, msg)).toBe(msg("stream.error.target_in_use.unknown"));
    expect(createErrorText({ code: "target_in_use", holder: null }, msg)).toBe(msg("stream.error.target_in_use.unknown"));
    let checked = 0;
    for (const code of CREATE_ERROR_CODES) {
      if (code === "target_in_use") continue;
      expect(createErrorText({ code, holder: null }, msg), code).toBe(msg(CREATE_ERROR_KEYS[code]));
      checked++;
    }
    expect(checked).toBe(CREATE_ERROR_CODES.length - 1);
  });

  it("D2: targetRefusalRule reads extra.rule off a DESTINATION_NOT_ALLOWED, for every rule the validator declares; an unknown rule, another code, or a non-server error is null", async () => {
    let checked = 0;
    for (const rule of DESTINATION_REFUSALS) {
      expect(targetRefusalRule(await wire(new HttpError(422, "refused", DESTINATION_NOT_ALLOWED, { rule }))), rule).toBe(rule);
      checked++;
    }
    expect(checked).toBe(DESTINATION_REFUSALS.length);
    expect(targetRefusalRule(await wire(new HttpError(422, "refused", DESTINATION_NOT_ALLOWED, { rule: "banana" })))).toBeNull();
    expect(targetRefusalRule(await wire(new HttpError(422, "refused", DESTINATION_NOT_ALLOWED, { rule: "toString" })))).toBeNull();
    expect(targetRefusalRule(await wire(new HttpError(422, "bad key", "ERROR", { rule: "host" })))).toBeNull();
    expect(targetRefusalRule(new Error("boom"))).toBeNull();
  });
});

describe("stream-session-view — health, elapsed, the paste code", () => {
  it("health chips: the ingest state for passthrough; fps/Mbps/beat with a heartbeat; the beat is stale at 45 s, not 44", () => {
    expect(healthChips(view(), msg, NOW, "en").map((c) => c.text)).toEqual([msg("stream.health.ingest.connected")]);
    const fresh = view({ health: { fps: 30, bitrateKbps: 2900, lastBeatAt: new Date(NOW.getTime() - 44_000).toISOString() } });
    const chips = healthChips(fresh, msg, NOW, "en");
    expect(chips.map((c) => c.text)).toEqual([msg("stream.health.ingest.connected"), msg("stream.health.fps", { n: 30 }), msg("stream.health.bitrate", { n: "2.9" }), msg("stream.health.beat", { s: 44 })]);
    expect(chips[3]!.stale).toBe(false);
    const stale = view({ health: { fps: 30, bitrateKbps: 2900, lastBeatAt: new Date(NOW.getTime() - BEAT_STALE_SECONDS * 1000).toISOString() } });
    expect(healthChips(stale, msg, NOW, "en")[3]!.stale).toBe(true);
  });

  it("health chips, the empty and edge cases: no ingest read → 'unknown'; a composed session has no ingest chip; no beat yet → its OWN copy, stale; a beat stamped ahead of this clock reads 0 s, never negative", () => {
    expect(healthChips(view({ ingest: null }), msg, NOW, "en").map((c) => c.text)).toEqual([msg("stream.health.ingest.unknown")]);
    expect(healthChips(view({ ingest: { state: "disconnected", protocol: null } }), msg, NOW, "en").map((c) => c.text)).toEqual([msg("stream.health.ingest.disconnected")]);
    // Composed: the server never reads the ingest for it (stream-sessions.ts currentSession), so "unknown" would be a
    // permanent false alarm — the heartbeat chips alone describe the relay.
    const composed = healthChips(view({ mode: "composed", ingest: null, health: { fps: 25, bitrateKbps: 4000, lastBeatAt: NOW.toISOString() } }), msg, NOW, "en");
    expect(composed.map((c) => c.text)).toEqual([msg("stream.health.fps", { n: 25 }), msg("stream.health.bitrate", { n: "4.0" }), msg("stream.health.beat", { s: 0 })]);
    expect(healthChips(view({ mode: "composed", ingest: null }), msg, NOW, "en")).toEqual([]);
    // m1 (Task 13 review): a heartbeat that carried no beat is "no beat yet" — never "beat 0 s ago", which claims a beat
    // arrived this very second — and it is still stale (amber): the relay has said nothing about its liveness.
    const noBeat = healthChips(view({ health: { fps: 30, bitrateKbps: 2900, lastBeatAt: null } }), msg, NOW, "en");
    expect(noBeat.at(-1)).toEqual({ text: msg("stream.health.beat.none"), stale: true });
    expect(noBeat.at(-1)!.text, "the no-beat copy is not the zero-seconds sentence").not.toBe(msg("stream.health.beat", { s: 0 }));
    const skewed = healthChips(view({ health: { fps: 30, bitrateKbps: 2900, lastBeatAt: new Date(NOW.getTime() + 3_000).toISOString() } }), msg, NOW, "en");
    expect(skewed.at(-1)).toEqual({ text: msg("stream.health.beat", { s: 0 }), stale: false });
  });

  it("m1: a heartbeat field the relay did not send is ABSENT — never a false '0 fps' / '0.0 Mbps' — each omitted on its own, the others kept", () => {
    const beat = new Date(NOW.getTime() - 4_000).toISOString();
    const texts = (health: { fps: number | null; bitrateKbps: number | null; lastBeatAt: string | null }) =>
      healthChips(view({ health }), msg, NOW, "en").map((c) => c.text);
    const ingest = msg("stream.health.ingest.connected");
    const fps = msg("stream.health.fps", { n: 30 });
    const mbps = msg("stream.health.bitrate", { n: "2.9" });
    const beat4 = msg("stream.health.beat", { s: 4 });
    // The positive pair first: every field present renders every chip.
    expect(texts({ fps: 30, bitrateKbps: 2900, lastBeatAt: beat })).toEqual([ingest, fps, mbps, beat4]);
    expect(texts({ fps: null, bitrateKbps: 2900, lastBeatAt: beat })).toEqual([ingest, mbps, beat4]);
    expect(texts({ fps: 30, bitrateKbps: null, lastBeatAt: beat })).toEqual([ingest, fps, beat4]);
    expect(texts({ fps: null, bitrateKbps: null, lastBeatAt: null })).toEqual([ingest, msg("stream.health.beat.none")]);
    // A genuine zero is a reading, not an absence: 0 fps from a frozen camera must still show.
    expect(texts({ fps: 0, bitrateKbps: 0, lastBeatAt: beat })).toEqual([ingest, msg("stream.health.fps", { n: 0 }), msg("stream.health.bitrate", { n: "0.0" }), beat4]);
    for (const l of LOCALES) expect(dict(l)["stream.health.beat.none"], `${l} stream.health.beat.none`).toBeTruthy();
  });

  it("m2: the bitrate is formatted in the ACTIVE locale — a decimal comma in es/fr/nl, a point in en (2900 kbps)", () => {
    // The rulebook is CLDR's decimal separator for each locale, typed here — never re-derived through the code's own
    // formatter, which would pass with any separator at all.
    const EXPECTED: Record<(typeof LOCALES)[number], string> = { en: "2.9", es: "2,9", fr: "2,9", nl: "2,9" };
    const live = view({ health: { fps: 30, bitrateKbps: 2900, lastBeatAt: NOW.toISOString() } });
    let checked = 0;
    for (const l of LOCALES) {
      const bitrate = healthChips(live, msg, NOW, l)[2]!;
      expect(bitrate.text, l).toBe(msg("stream.health.bitrate", { n: EXPECTED[l] }));
      checked++;
    }
    expect(checked).toBe(LOCALES.length);
  });

  it("elapsed: m:ss under an hour, h:mm:ss from the hour; no start (or a start ahead of this clock) is 0:00", () => {
    expect(elapsedLabel("2026-09-14T12:00:00Z", NOW)).toBe("10:00");
    expect(elapsedLabel("2026-09-14T11:10:01Z", NOW)).toBe("59:59");
    expect(elapsedLabel("2026-09-14T11:10:00Z", NOW)).toBe("1:00:00");
    expect(elapsedLabel("2026-09-14T10:58:30Z", NOW)).toBe("1:11:30");
    expect(elapsedLabel(null, NOW)).toBe("0:00");
    expect(elapsedLabel("2026-09-14T12:10:05Z", NOW)).toBe("0:00");
  });

  it("the paste code IS the QR payload: the contract's own valid fixture round-trips through qrText and the phone's parser", () => {
    const fixture = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../../../docs/contracts/fixtures/capture-qr.v1/valid.json"), "utf8"));
    const text = qrText(fixture);
    expect(JSON.parse(text)).toEqual(fixture);
    expect(parseCaptureQr(JSON.parse(text), NOW)).toEqual({ ok: true, payload: fixture });
    expect(STREAM_POLL_MS).toBe(5000);
  });
});
