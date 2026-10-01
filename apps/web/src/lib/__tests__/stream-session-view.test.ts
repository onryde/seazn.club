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
import { STREAM_PLATFORMS } from "@/lib/stream-destinations";
import { RELAY_PLAN_GATES } from "@/lib/stream-plan-gates";
import { messages } from "@/lib/messages";
import { v1 } from "@/server/api-v1/http";
import { StreamEndReason, StreamFailReason, StreamIngest, StreamOutput, StreamSessionState } from "@/server/api-v1/schemas";
import { DestinationNotAllowedError, TargetUnreadableError } from "@/server/usecases/stream-targets";
import {
  BEAT_STALE_SECONDS, CREATE_ERROR_CODES, OUTPUT_WARNING_AFTER_MS, CREATE_ERROR_KEYS, END_REASON_KEYS, FAIL_REASON_KEYS,
  INGEST_STATE_KEYS, STATE_PILL_KEYS, STREAM_POLL_MS, type CreateErrorCode, type PhoneTabState, type StreamSessionView,
  TARGET_REMOVED, createErrorCode, createErrorHolder, createErrorIsNotFound, createErrorText, d3Warning, destinationWarning, elapsedLabel, healthChips, outputElapsedMs, phoneNoSignal, phoneTabState, qrText,
} from "../stream-session-view";

const DICT_DIR = join(import.meta.dirname, "..", "..", "dictionaries");
const LOCALES = ["en", "es", "fr", "nl"] as const;
const dict = (l: string): Record<string, string> => JSON.parse(readFileSync(join(DICT_DIR, l, "ui.json"), "utf8"));
const msg = (k: string, vars: Record<string, string | number> = {}) =>
  Object.entries(vars).reduce((s, [n, v]) => s.replaceAll(`{${n}}`, String(v)), (messages as Record<string, string>)[k] ?? `MISSING:${k}`);
/** `msg`'s twin over the es dictionary — T3's copy is the page's locale, never English. */
const ES = JSON.parse(readFileSync(join(DICT_DIR, "es", "ui.json"), "utf8")) as Record<string, string>;
const msgEs = (k: string, vars: Record<string, string | number> = {}) =>
  Object.entries(vars).reduce((s, [n, v]) => s.replaceAll(`{${n}}`, String(v)), ES[k] ?? `MISSING:${k}`);

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
  health: null, ingest: { state: "connected", protocol: "srt" }, output: null, qr: null, balance: 2,
  startedAt: "2026-09-14T12:00:00Z", endedAt: null, replayUrl: null,
  target: { id: "t", kind: "youtube", label: "Club" }, fixtureDecided: false, endReason: null, creditUsed: true, restartFree: false, ...over,
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
    // T3: `target_in_use` is named by `inUseText` (stream.inUse.*); its map entry is the ONE holder-less "elsewhere"
    // sentence, and the retired `stream.error.target_in_use` (a court, never a match) is named by nothing.
    for (const c of CREATE_ERROR_CODES) expect(CREATE_ERROR_KEYS[c], c).toBe(c === "target_in_use" ? "stream.error.target_in_use.unknown" : `stream.error.${c}`);
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

  it("no stream.* copy in any locale names LinkedIn (not an allowed destination)", () => {
    let checked = 0;
    for (const l of LOCALES) {
      for (const [k, v] of Object.entries(dict(l))) {
        if (!k.startsWith("stream.")) continue;
        expect(v, `${l} ${k}`).not.toMatch(/linkedin/i);
        checked++;
      }
    }
    expect(checked, "the stream.* sweep read nothing").toBeGreaterThan(LOCALES.length * 100);
  });

  it("M4: the unreadable-key copy offers the two remedies that WORK — replace the key, or (not a YouTube / Twitch destination) remove it — and names the creatable platforms in every locale; English never says to add it again", () => {
    const key = CREATE_ERROR_KEYS.target_unreadable;
    let named = 0;
    for (const l of LOCALES) {
      const text = dict(l)[key]!.toLowerCase();
      // Brand names are proper nouns, the same in every locale — derived from what create admits (D6).
      for (const p of STREAM_PLATFORMS) {
        expect(text, `${l}: names ${p}, the kinds that can be added`).toContain(p);
        named++;
      }
    }
    expect(named).toBe(LOCALES.length * STREAM_PLATFORMS.length);
    expect(dict("en")[key], "a legacy kind cannot be added again").not.toMatch(/add (it|the destination) again/i);
    expect(dict("en")[key]).toMatch(/replace the key/i);
    expect(dict("en")[key]).toMatch(/remove it/i);
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

  it("seven pill keys, in all four locales (T9a: §8a's stepper and its four step keys are gone — the Signal path replaced it)", () => {
    for (const [s, k] of Object.entries(STATE_PILL_KEYS)) expect(k, s).toBe(`stream.phone.state.${s}`);
    expect(inEveryLocale(Object.values(STATE_PILL_KEYS))).toBe(LOCALES.length * 7);
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
    // B2: the saved key will not open — the server's own class, both remedies.
    ["TARGET_UNREADABLE 422 (replace the key)", new TargetUnreadableError("replace_key"), "target_unreadable"],
    ["TARGET_UNREADABLE 422 (remove it)", new TargetUnreadableError("remove"), "target_unreadable"],
    ["PAYMENT_REQUIRED streaming.relay", new PaymentRequiredError(RELAY_PLAN_GATES.relay), "plan_lacks_relay"],
    ["PAYMENT_REQUIRED streaming.overlay", new PaymentRequiredError(RELAY_PLAN_GATES.overlay), "plan_lacks_relay"],
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
    const e = await wire(new PaymentRequiredError(RELAY_PLAN_GATES.relay));
    expect(e.code).toBe("PAYMENT_REQUIRED");
    expect(e.extra.feature_key).toBe(RELAY_PLAN_GATES.relay);
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
  });

  it("createErrorHolder reads extra.holder: the court and label when present; courtName null kept; a pre-T3 holder (no matchNo/href/state) reads live with no match; null for the index race, another code, or a malformed holder", async () => {
    // A holder with no `state` reads "live": the pre-T3 server refused only for a destination already on air, and its copy
    // said "already live" — that is what such a holder has always meant.
    expect(createErrorHolder(await wire(new HttpError(409, "in use", "target_in_use", { holder: { fixtureId: "f-2", courtName: "Court 3", label: "Club channel" } }))))
      .toEqual({ courtName: "Court 3", label: "Club channel", matchNo: null, href: null, state: "live" });
    expect(createErrorHolder(await wire(new HttpError(409, "in use", "target_in_use", { holder: { fixtureId: null, courtName: null, label: "Club channel" } }))))
      .toEqual({ courtName: null, label: "Club channel", matchNo: null, href: null, state: "live" });
    expect(createErrorHolder(await wire(new HttpError(409, "in use", "target_in_use", { holder: null })))).toBeNull();
    expect(createErrorHolder(await wire(new HttpError(409, "busy", "active_session", { holder: { courtName: "Court 3", label: "Club channel" } })))).toBeNull();
    expect(createErrorHolder(await wire(new HttpError(409, "in use", "target_in_use", { holder: { courtName: "Court 3" } })))).toBeNull();
    expect(createErrorHolder(new Error("boom"))).toBeNull();
  });

  it("createErrorText: target_in_use names the destination, the match and the court; without a match (or a holder) it says 'another match'; any other code is its map entry", () => {
    const named = createErrorText({ code: "target_in_use", holder: { courtName: "Court 3", label: "Club channel", matchNo: 4, href: "/x", state: "live" } }, msg);
    expect(named).toBe("Club channel is live on Match 4 · Court 3. Stop it there or pick another destination.");
    expect(named).toContain("Club channel");
    expect(named).toContain("Court 3");
    expect(named).not.toMatch(/[{}]/);
    expect(createErrorText({ code: "target_in_use", holder: { courtName: "Court 3", label: "Club channel", matchNo: null, href: null, state: "live" } }, msg)).toBe(msg("stream.error.target_in_use.unknown"));
    expect(createErrorText({ code: "target_in_use", holder: null }, msg)).toBe(msg("stream.error.target_in_use.unknown"));
    let checked = 0;
    for (const code of CREATE_ERROR_CODES) {
      if (code === "target_in_use") continue;
      expect(createErrorText({ code, holder: null }, msg), code).toBe(msg(CREATE_ERROR_KEYS[code]));
      checked++;
    }
    expect(checked).toBe(CREATE_ERROR_CODES.length - 1);
  });

});

describe("I1 (B4 review): a Go live whose destination was removed in Directory", () => {
  it("createErrorIsNotFound reads the 404 off the REAL wire — the archived-target and the fixture 404 both (D2 keeps the existing not-found shape, so the tab re-reads the list to tell them apart); every other refusal and a network error are not", async () => {
    const notFound: [string, Error][] = [
      ["an archived or foreign target (admit's target_not_found)", new HttpError(404, "stream target not found")],
      ["a fixture that is gone", new HttpError(404, "fixture not found")],
    ];
    let checked = 0;
    for (const [name, err] of notFound) {
      expect(createErrorIsNotFound(await wire(err)), name).toBe(true);
      checked++;
    }
    const others: [string, Error][] = [
      ["409 target_in_use", new HttpError(409, "in use", "target_in_use", { holder: null })],
      ["422 TARGET_UNREADABLE", new TargetUnreadableError("replace_key")],
      ["402 no_credits", new HttpError(402, "none", "no_credits")],
      ["403 FORBIDDEN", new HttpError(403, "a signed-in organiser is required")],
      ["500", new Error("boom")],
    ];
    for (const [name, err] of others) {
      expect(createErrorIsNotFound(await wire(err)), name).toBe(false);
      checked++;
    }
    expect(createErrorIsNotFound(new TypeError("Failed to fetch"))).toBe(false);
    expect(createErrorIsNotFound(null)).toBe(false);
    expect(createErrorIsNotFound({ status: "404" })).toBe(false);
    expect(checked).toBe(notFound.length + others.length);
  });

  it("the 'removed' refusal reads its own sentence — never the retry copy — in all four locales, with no placeholder left", () => {
    const text = createErrorText({ code: TARGET_REMOVED, holder: null }, msg);
    expect(text).toBe(msg("stream.error.target_removed"));
    expect(text).not.toBe(msg(CREATE_ERROR_KEYS.unknown));
    expect(text).not.toMatch(/MISSING|[{}]/);
    expect(inEveryLocale(["stream.error.target_removed"])).toBe(LOCALES.length);
  });
});

describe("target_in_use names the match (spec §3.3, §5.5)", () => {
  // Every case runs BOTH real functions in production order — createErrorHolder on the raw wire error, then
  // createErrorText on what it returned (fixture-stream-panel.tsx `setCreateError` and the create-error render).
  const holderOf = async (holder: unknown) => createErrorHolder(await wire(new HttpError(409, "in use", "target_in_use", { holder })));
  const textOf = async (holder: unknown, m = msg) => createErrorText({ code: "target_in_use", holder: await holderOf(holder) }, m);

  it("live + court: '{label} is live on Match {n} · {court}. …' in the page's locale", async () => {
    const h = { label: "Club YouTube", matchNo: 7, courtName: "Court 2", href: "/o/a/c/b/d/c/f/7", state: "live", fixtureId: "f" };
    expect(await textOf(h)).toBe("Club YouTube is live on Match 7 · Court 2. Stop it there or pick another destination.");
    // The match is the locale's own breadcrumb.match, never a server string (plan premise 10).
    const es = await textOf(h, msgEs);
    expect(es).toContain(msgEs("breadcrumb.match", { no: 7 }));
    expect(es).not.toContain("Match 7");
    expect(es).not.toMatch(/MISSING|[{}]/);
  });
  it("waiting, no court: the match alone, from breadcrumb.match", async () => {
    const h = { label: "Tw", matchNo: 3, courtName: null, href: "/x", state: "waiting", fixtureId: "f" };
    expect(await textOf(h)).toBe("Tw is waiting for a phone on Match 3. Stop it there or pick another destination.");
  });
  it("a holder whose fixture was deleted (matchNo null) reads the ONE 'elsewhere' key, never 'Match null'", async () => {
    const text = await textOf({ label: "Tw", matchNo: null, courtName: null, href: null, state: "live", fixtureId: null });
    expect(text).toBe(msg("stream.error.target_in_use.unknown"));
    expect(text).not.toMatch(/null|undefined|[{}]/);
  });
  it("the index-race holder:null reads the same 'elsewhere' key", async () => {
    expect(await textOf(null)).toBe(msg("stream.error.target_in_use.unknown"));
  });
  it("every new key exists in all four locales, and the retired key exists in none", () => {
    const keys = ["stream.inUse.live", "stream.inUse.waiting", "stream.inUse.matchCourt", "stream.inUse.open"];
    let checked = 0;
    for (const loc of ["en", "es", "fr", "nl"]) {
      const d = JSON.parse(readFileSync(join(DICT_DIR, loc, "ui.json"), "utf8")) as Record<string, string>;
      for (const k of keys) { expect(d[k], `${loc} ${k}`).toBeTruthy(); checked++; }
      expect(d["stream.error.target_in_use"], `${loc} retired key`).toBeUndefined();
    }
    expect(checked).toBe(4 * keys.length);
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

describe("D3 — the destination warning (spec §5.6)", () => {
  type Out = { state: string; since: string; elapsedMs: number } | null;
  const view = (state: string, output: Out) => ({ state, output }) as never;
  const since = new Date("2026-09-30T12:00:00Z");
  /** The output as the SERVER answers it: `since` and the elapsed it measured on ITS clock (B2 fix round M6). */
  const out = (state: string, elapsedMs: number) => ({ state, since: since.toISOString(), elapsedMs });
  // The non-ok words come from the wire schema's own enum, so a new output state cannot ship without this sweep seeing it.
  const NON_OK = StreamOutput.shape.state.options.filter((s) => s !== "ok");
  afterEach(() => { vi.useRealTimers(); });
  it("the owner's number: 30 s", () => {
    expect(OUTPUT_WARNING_AFTER_MS).toBe(30_000);
  });
  it("fires at exactly OUTPUT_WARNING_AFTER_MS of server-measured elapsed, not one millisecond before, for every non-ok state", () => {
    let checked = 0;
    for (const s of NON_OK) {
      expect(destinationWarning(view("live", out(s, OUTPUT_WARNING_AFTER_MS - 1))), s).toBe(false);
      expect(destinationWarning(view("live", out(s, OUTPUT_WARNING_AFTER_MS))), s).toBe(true);
      checked++;
    }
    expect(checked).toBe(3);
  });
  it("never while output is ok, never outside live, never without output", () => {
    const late = OUTPUT_WARNING_AFTER_MS * 10;
    expect(destinationWarning(view("live", out("ok", late)))).toBe(false);
    let checked = 0;
    for (const st of StreamSessionState.options.filter((x) => x !== "live")) {
      expect(destinationWarning(view(st, out("connecting", late))), st).toBe(false);
      checked++;
    }
    expect(checked, "every state but live").toBe(StreamSessionState.options.length - 1);
    expect(destinationWarning(view("live", null))).toBe(false);
    // The positive pair of the loop above, on the same inputs: live itself does warn.
    expect(destinationWarning(view("live", out("connecting", late)))).toBe(true);
  });
  it("outputElapsedMs is the server's number, verbatim; null when there is no output to time", () => {
    expect(outputElapsedMs(view("live", out("connecting", 1234)))).toBe(1234);
    expect(outputElapsedMs(view("live", null)), "no output, nothing to time").toBeNull();
  });
  it("M6: the BROWSER clock is never consulted — ten minutes ahead of the server it does not warn early, ten minutes behind it does not warn late", () => {
    const skew = 10 * 60_000;
    let checked = 0;
    for (const browserOffset of [skew, -skew]) {
      // The server measured `elapsed` at `since + elapsed`; the browser's clock reads that instant plus its own skew.
      for (const [elapsed, warns] of [[0, false], [OUTPUT_WARNING_AFTER_MS - 1, false], [OUTPUT_WARNING_AFTER_MS, true]] as const) {
        vi.useFakeTimers({ now: since.getTime() + elapsed + browserOffset });
        try {
          expect(destinationWarning(view("live", out("connecting", elapsed))), `browser ${browserOffset > 0 ? "ahead" : "behind"}, server elapsed ${elapsed}`).toBe(warns);
          expect(outputElapsedMs(view("live", out("connecting", elapsed)))).toBe(elapsed);
        } finally {
          vi.useRealTimers();   // a failed expect must not leak fake timers into the rest of the file
        }
        checked++;
      }
    }
    expect(checked).toBe(6);
  });
});

// I-1 (owner 2026-10-01, option a) — WHICH D3 box. The 30 s hold still decides WHETHER a box shows (live, the
// destination not ok for OUTPUT_WARNING_AFTER_MS of server time — `destinationWarning`, pinned above). The PHONE decides
// which: no signal from the phone → a box that points at the phone ("Seazn isn't getting video from the phone"), no
// Directory link; the phone sending → the stream-key box. "No signal" is the Signal path's own word (§3.2): an ingest
// read that is not `connected`. A NULL ingest decides nothing (the N1 rule), so it is not "no signal".
// Every expected value below is that ruling, transcribed — never read back from `d3Warning`.
describe("I-1 — which D3 box: phone first (owner 2026-10-01, option a)", () => {
  type IngestWord = (typeof StreamIngest.shape.state.options)[number];
  type OutputWord = (typeof StreamOutput.shape.state.options)[number];
  type Box = "phone" | "destination" | null;
  const W = OUTPUT_WARNING_AFTER_MS;
  const since = "2026-09-30T12:00:00.000Z";
  const v = (state: string, ingest: IngestWord | null, output: OutputWord | null, elapsedMs = 0) =>
    ({
      state,
      ingest: ingest ? { state: ingest, protocol: ingest === "connected" ? "srt" : null } : null,
      output: output ? { state: output, since, elapsedMs } : null,
    }) as never;
  /** The ruling as a function of its inputs — the oracle for the sweep. */
  const ruling = (state: string, ingest: IngestWord | null, output: OutputWord | null, elapsedMs: number): Box => {
    if (state !== "live" || output === null || output === "ok" || elapsedMs < W) return null;
    return ingest !== null && ingest !== "connected" ? "phone" : "destination";
  };

  it("the empty case: no view, no box", () => {
    expect(d3Warning(null)).toBeNull();
  });

  it("phone ok or no signal × destination ok / connecting / rejected / unknown, past the hold — the ruling's table, row by row", () => {
    const rows: [IngestWord, OutputWord, Box][] = [
      ["connected", "ok", null],
      ["connected", "connecting", "destination"],
      ["connected", "rejected", "destination"],
      ["connected", "unknown", "destination"],
      ["disconnected", "ok", null],
      ["disconnected", "connecting", "phone"],
      ["disconnected", "rejected", "phone"],
      ["disconnected", "unknown", "phone"],
      // Cloudflare's own "unknown" ingest (a 404 on the input) is not "connected" either: the chain says No signal.
      ["unknown", "ok", null],
      ["unknown", "connecting", "phone"],
      ["unknown", "rejected", "phone"],
      ["unknown", "unknown", "phone"],
    ];
    let checked = 0;
    for (const [ingest, output, box] of rows) {
      expect(d3Warning(v("live", ingest, output, W)), `phone ${ingest} × destination ${output}`).toBe(box);
      checked++;
    }
    expect(checked).toBe(StreamIngest.shape.state.options.length * StreamOutput.shape.state.options.length);
    expect(rows.filter((r) => r[2] === "phone").length, "the phone box was reached").toBeGreaterThan(0);
    expect(rows.filter((r) => r[2] === "destination").length, "the key box was reached").toBeGreaterThan(0);
  });

  it("under the hold: no box at all, whatever the phone says — the hold is unchanged", () => {
    let checked = 0;
    for (const ingest of StreamIngest.shape.state.options) for (const output of StreamOutput.shape.state.options) {
      expect(d3Warning(v("live", ingest, output, W - 1)), `${ingest} × ${output}`).toBeNull();
      checked++;
    }
    expect(checked).toBe(12);
  });

  // The chain's N1 rule: a null ingest decides nothing, so it is not no-signal. (The server never answers this shape — a
  // failed read nulls ingest AND output together, stream-sessions.ts — so it is the rule's case, not a failed read's.)
  it("the N1 rule: a null ingest beside an output is not no-signal — past the hold it is the key box", () => {
    expect(d3Warning(v("live", null, "connecting", W))).toBe("destination");
  });

  // n-1 (B5 re-review 2): `phoneNoSignal` is exported and its `state === "live"` check survived a mutant, because both
  // of today's callers ask it only while live. Asked directly: no signal is a LIVE judgment, for every other state.
  it("phoneNoSignal: only while live — a disconnected or unknown phone in any other state is not no-signal; live, it is; a connected or null ingest never is", () => {
    let checked = 0;
    for (const state of StreamSessionState.options) for (const ingest of StreamIngest.shape.state.options) {
      const want = state === "live" && ingest !== "connected";   // the ruling: §3.2's "No signal" is a live row
      expect(phoneNoSignal(v(state, ingest, null)), `${state} · ${ingest}`).toBe(want);
      checked++;
    }
    expect(checked).toBe(StreamSessionState.options.length * StreamIngest.shape.state.options.length);
    expect(phoneNoSignal(v("warming", "disconnected", null)), "warming with the phone not yet sending: not 'no signal'").toBe(false);
    expect(phoneNoSignal(v("live", "disconnected", null)), "the positive twin").toBe(true);
    expect(phoneNoSignal(v("live", null, "connecting")), "N1: a null ingest decides nothing").toBe(false);
  });

  it("the whole input space: every state × ingest (none included) × output (none included) × either side of the line", () => {
    const ingests: (IngestWord | null)[] = [null, ...StreamIngest.shape.state.options];
    const outputs: (OutputWord | null)[] = [null, ...StreamOutput.shape.state.options];
    let checked = 0;
    const seen = { phone: 0, destination: 0, none: 0 };
    for (const state of StreamSessionState.options) for (const ingest of ingests) for (const output of outputs) for (const ms of [0, W - 1, W, 10 * W]) {
      const want = ruling(state, ingest, output, ms);
      expect(d3Warning(v(state, ingest, output, ms)), `${state} · ${ingest} · ${output} · ${ms}`).toBe(want);
      seen[want ?? "none"]++;
      checked++;
    }
    expect(checked).toBe(StreamSessionState.options.length * ingests.length * outputs.length * 4);
    expect(seen.phone, "phone rows swept").toBeGreaterThan(0);
    expect(seen.destination, "key rows swept").toBeGreaterThan(0);
  });

  // I-2a (controller ruling 2026-10-01): the SERVER restarts the hold when the phone returns — `since` is clamped to the
  // phone's latest reconnect, and that is pinned on the server's own clock in stream-sessions.test.ts ("I-2a SEQUENCE").
  // These two feed `d3Warning` the elapsed the server answers at each step, so they are named for what they assert: the
  // box the tab draws from the server's numbers. They do not, and cannot, witness the clock.
  it("the box for each answer of a drop-and-return sequence, as the server times it: the phone silent past the hold → the phone box; back while the destination still dials, the hold restarted → none until 30 s after the return, then the key box; receiving → none", () => {
    const steps: [string, ReturnType<typeof v>, Box][] = [
      ["live, receiving", v("live", "connected", "ok", 0), null],
      ["the phone drops: inside the hold", v("live", "disconnected", "unknown", 5_000), null],
      ["30 s without the destination receiving, the phone still silent", v("live", "disconnected", "unknown", W), "phone"],
      ["still silent", v("live", "disconnected", "connecting", W + 10_000), "phone"],
      ["the phone returns; the server's hold restarts there", v("live", "connected", "connecting", 0), null],
      ["29.999 s after the return, still dialling", v("live", "connected", "connecting", W - 1), null],
      ["30 s after the return, still dialling", v("live", "connected", "connecting", W), "destination"],
      ["the destination receives", v("live", "connected", "ok", 0), null],
    ];
    const got = steps.map(([, view]) => d3Warning(view));
    expect(got).toEqual(steps.map(([, , box]) => box));
    expect(steps).toHaveLength(8);
  });

  it("…and the answers for a phone that returns INSIDE the hold: none on the drop, none on the return (the hold restarted), none at return+29.999 s, the key box at return+30 s", () => {
    const got = [
      d3Warning(v("live", "disconnected", "unknown", 5_000)),
      d3Warning(v("live", "connected", "connecting", 0)),
      d3Warning(v("live", "connected", "connecting", W - 1)),
      d3Warning(v("live", "connected", "connecting", W)),
    ];
    expect(got).toEqual([null, null, null, "destination"]);
  });
});

