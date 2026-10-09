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
import { join } from "node:path";
import { HttpError, PaymentRequiredError } from "@/lib/errors";
import { ApiV1Error, apiV1 } from "@/lib/client-v1";
import { STREAM_PLATFORMS } from "@/lib/stream-destinations";
import { RELAY_PLAN_GATES } from "@/lib/stream-plan-gates";
import { messages } from "@/lib/messages";
import { v1 } from "@/server/api-v1/http";
import { CaptureNotReady, CapturePhoneState } from "@/server/api-v1/capture-schemas";
import {
  StreamEndReason, StreamFailReason, StreamIngest, StreamLostCountdown, StreamOutput, StreamSessionState, type StreamPhone,
} from "@/server/api-v1/schemas";
import { DestinationNotAllowedError, TargetUnreadableError } from "@/server/usecases/stream-targets";
import {
  BEAT_STALE_SECONDS, COUNTDOWN_KEYS, CREATE_ERROR_CODES, OUTPUT_WARNING_AFTER_MS, CREATE_ERROR_KEYS, END_REASON_KEYS, FAIL_REASON_KEYS,
  INGEST_STATE_KEYS, READY_STATES, RECONNECT_REASON_KEYS, STATE_PILL_KEYS, STREAM_POLL_MS, type CreateErrorCode, type PhoneTabState,
  type ReadyState, type StreamSessionView,
  TARGET_REMOVED, canGoLive, countdownKey, createErrorCode, createErrorHolder, createErrorIsNotFound, createErrorText, d3Warning,
  destinationWarning, durationLabel, elapsedLabel, healthChips, outputElapsedMs, phoneNoSignal, phoneStrip, phoneTabState,
  readyStateOf, reconnectReasonOf, restartLine,
  AUTO_REFUSAL_KEYS, AUTO_REFUSAL_REMEDY, AUTO_WONT_START_KEY, HEALTH_KEYS, NOT_READY_KEYS, TAKEOVER_NOTICE_MS, autoOperatorHint, autoRefusalStrip, autoStopLine, autoSwitchNote,
  healthLine, phoneDetails, takeoverLineKey, takeoverNotice, type PhoneLinePart, type TakeoverAct,
  PRESENCE_WATCH_START, W5_REFUSAL_CODES, isW5Refusal, presenceAfterRefusal, readClearsW5, type CreateFailureCode, type PresenceWatch,
} from "../stream-session-view";
import fc from "fast-check";
import { AUTO_START_REFUSALS } from "@/server/relay/domain/auto-stream";
import { HEALTH_REASONS } from "@/server/relay/domain/health-reasons";

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
  health: null, ingest: { state: "connected", protocol: "srt" }, output: null, balance: 2,
  startedAt: "2026-09-14T12:00:00Z", endedAt: null, replayUrl: null,
  target: { id: "t", kind: "youtube", label: "Club" }, fixtureDecided: false, fixtureHeld: false, endReason: null, creditUsed: true, startCause: "organiser", restart: null, countdown: null, ...over,
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
    // Capture QR v2 W5 (carry): no phone paired on the code (no current pairing) — the refusal createSession throws (`refuse`).
    ["phone_not_paired 409", new HttpError(409, "no phone is paired on this match's stream code", "phone_not_paired"), "phone_not_paired"],
    // Owner ruling 2026-10-09 (Option 1): a phone IS paired but has gone silent — its own sentence, never the "scan" one.
    ["phone_not_responding 409", new HttpError(409, "the phone paired on this match's stream code is not responding", "phone_not_responding"), "phone_not_responding"],
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

  // Capture QR v2 PR-1 T1 removed the v1 contract and its fixtures (W4), and with them the case that round-tripped the
  // contract's own valid fixture through qrText. This pin rode in that case; it is the only one of the constant's value.
  it("STREAM_POLL_MS is 5 s — the organiser panel's poll cadence", () => {
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


// ---------------------------------------------------------------------------------------------------------------------
// Capture QR v2 §6.12 (T11): the Ready states, the phone strip, the paused reasons, the countdown copy, the restart line.
// Expected values come from §6.12's table and rulings (written out here) and from the schemas' own enums — never from
// stream-session-view.ts. ONE SPORT, on purpose: none of this reads a sport.
// ---------------------------------------------------------------------------------------------------------------------

type Phone = NonNullable<StreamPhone["phone"]>;
const phoneFacts = (over: Partial<Phone> = {}): Phone => ({
  present: true, silent: false, notResponding: false, model: "Pixel 8", appVersion: "capture/2", mode: "operator",
  state: "paired", notReady: null, notReadyShown: false, health: null, startFailed: null,
  lastBeatAt: "2026-09-14T12:09:50Z", elapsedMs: 10_000,
  beat: { battery: null, bitrateKbps: null, delivery: null, thermal: null, dataUsedMB: null }, farPoll: false, ...over,
});
const readModel = (over: Partial<StreamPhone> = {}): StreamPhone => ({
  code: { issuedAt: "2026-09-14T11:00:00Z", state: "active", endCause: null }, phone: phoneFacts(), destination: null,
  lastTakeover: null, auto: null, legacy: false, finished: false, session: null, ...over,
});
const SILENT = phoneFacts({ present: false, silent: true, elapsedMs: 90_000 });
const ENDED_CODE = { issuedAt: "2026-09-14T09:00:00Z", state: "ended" as const, endCause: "expired" as const };

describe("readyStateOf — §6.12's rows (T11)", () => {
  it("the EMPTY case first: no read model and no session → no_phone; a read with no phone → no_phone", () => {
    expect(readyStateOf(null, null)).toBe("no_phone");
    expect(readyStateOf(readModel({ phone: null }), null)).toBe("no_phone");
    expect(readyStateOf(readModel({ phone: null, code: null }), null), "no code yet either").toBe("no_phone");
  });

  it("every row of the table, each from its own inputs", () => {
    const rows: [string, StreamPhone | null, StreamSessionView | null, ReadyState][] = [
      ["paired: present", readModel(), null, "paired"],
      ["silent: paired but not answering (§6.9)", readModel({ phone: SILENT }), null, "silent"],
      ["code ended: finished + the code ended", readModel({ finished: true, code: ENDED_CODE }), null, "code_ended"],
      ["code ended: finished, no code ever", readModel({ finished: true, code: null, phone: null }), null, "code_ended"],
      ["finished but the code still FINISHING (inside the grace): not over", readModel({ finished: true, code: { ...ENDED_CODE, state: "finishing", endCause: null } }), null, "paired"],
      ["C5: a reverted result — not finished, the expired code still ended: Ready, not over", readModel({ code: ENDED_CODE, phone: null }), null, "no_phone"],
      ["a terminal session reads ended, whatever the phone", readModel({ phone: SILENT }), view({ state: "completed" }), "ended"],
      ["…and ended over a finished match too (the summary card first)", readModel({ finished: true, code: ENDED_CODE }), view({ state: "failed" }), "ended"],
      ["an open session reads its own state, whatever the phone", readModel({ phone: null }), view({ state: "live" }), "live"],
    ];
    let checked = 0;
    for (const [name, rm, session, want] of rows) {
      expect(readyStateOf(rm, session), name).toBe(want);
      checked++;
    }
    expect(checked).toBe(rows.length);
  });

  it("every session state the enum declares maps to waiting, live or ended — requested / provisioning / warming wait; live / ending are live", () => {
    const want: Record<string, ReadyState> = {
      requested: "waiting", provisioning: "waiting", warming: "waiting", live: "live", ending: "live", completed: "ended", failed: "ended",
    };
    let checked = 0;
    for (const state of StreamSessionState.options) {
      for (const rm of [null, readModel(), readModel({ phone: SILENT }), readModel({ phone: null })]) {
        expect(readyStateOf(rm, view({ state })), `${state}`).toBe(want[state]);
        checked++;
      }
    }
    expect(Object.keys(want).sort()).toEqual([...StreamSessionState.options].sort());
    expect(checked).toBe(StreamSessionState.options.length * 4);
  });

  it("Go live is enabled ONLY for paired — every state swept, exactly one admits it (mutant: enable it for silent → red)", () => {
    const admitted = READY_STATES.filter((s) => canGoLive(s));
    expect(admitted).toEqual(["paired"]);
    expect(READY_STATES).toHaveLength(7);
    expect(canGoLive("silent")).toBe(false);
    expect(canGoLive(readyStateOf(readModel({ phone: SILENT }), null))).toBe(false);
    expect(canGoLive(readyStateOf(readModel(), null)), "the positive pair").toBe(true);
  });
});

describe("reconnectReasonOf — §6.12's O5 mapping (T11)", () => {
  it("the EMPTY case first: no phone → null", () => {
    expect(reconnectReasonOf(null)).toBeNull();
  });

  it("every notReady value, then degraded and reconnecting (weak), then publishing (none) — 7 cases", () => {
    const cases: [string, Phone, string | null][] = [
      ...CaptureNotReady.options.map((n): [string, Phone, string] => [`notReady ${n}`, phoneFacts({ notReady: n, state: "publishing" }), n]),
      ["degraded", phoneFacts({ state: "degraded" }), "weak"],
      ["reconnecting", phoneFacts({ state: "reconnecting" }), "weak"],
      ["publishing", phoneFacts({ state: "publishing" }), null],
    ];
    let checked = 0;
    for (const [name, p, want] of cases) {
      expect(reconnectReasonOf(p), name).toBe(want);
      checked++;
    }
    expect(checked).toBe(7);
    // notReady outranks the state: a weak connection with the camera taken is "on a call".
    expect(reconnectReasonOf(phoneFacts({ notReady: "camera", state: "degraded" }))).toBe("camera");
  });

  it("the other phone states carry no reason — swept over CapturePhoneState", () => {
    let checked = 0;
    for (const state of CapturePhoneState.options) {
      const want = state === "degraded" || state === "reconnecting" ? "weak" : null;
      expect(reconnectReasonOf(phoneFacts({ state })), state).toBe(want);
      checked++;
    }
    expect(checked).toBe(CapturePhoneState.options.length);
  });

  it("each reason's copy is the spec's — the owner's camera sentence verbatim — in all four locales", () => {
    expect(Object.keys(RECONNECT_REASON_KEYS).sort()).toEqual(["camera", "held", "network", "sound", "weak"]);
    expect(msg(RECONNECT_REASON_KEYS.camera)).toBe("Phone is on a call — video paused");
    expect(msg(RECONNECT_REASON_KEYS.sound)).toBe("Phone's microphone is in use — video paused");
    expect(msg(RECONNECT_REASON_KEYS.network)).toBe("Phone has no network — video paused");
    expect(msg(RECONNECT_REASON_KEYS.held)).toBe("Phone is upright — turn it sideways");
    expect(msg(RECONNECT_REASON_KEYS.weak)).toBe("Phone's connection is weak — video paused");
    expect(inEveryLocale(Object.values(RECONNECT_REASON_KEYS))).toBe(5 * LOCALES.length);
  });
});

describe("the countdown copy and its durations (W24, T11)", () => {
  /** Every (kind, reason) the wire's union declares — read off the schema, so a new end cannot ship without copy. */
  const combos = StreamLostCountdown.options.flatMap((o) => {
    const reason = o.shape.reason as unknown as { options?: string[]; value?: string };
    return (reason.options ?? [reason.value!]).map((r) => [o.shape.kind.value, r] as const);
  });

  it("one key per (kind, reason) the union declares — 3 — each in all four locales, with the placeholders its kind needs", () => {
    expect(combos).toHaveLength(3);
    let checked = 0;
    for (const [kind, reason] of combos) {
      const key = countdownKey({ kind, reason, elapsedMs: 0, remainingMs: 0 } as never);
      expect(Object.values(COUNTDOWN_KEYS)).toContain(key);
      for (const l of LOCALES) {
        const text = dict(l)[key]!;
        expect(text, `${l} ${key}`).toBeTruthy();
        expect(text, `${l} ${key}: remaining`).toContain("{remaining}");
        if (kind === "live") expect(text, `${l} ${key}: elapsed`).toContain("{elapsed}");
        checked++;
      }
    }
    expect(checked).toBe(3 * LOCALES.length);
    expect(msg("stream.phone.countdown.live.phone_lost")).toBe("No video from the phone for {elapsed} — the stream ends in {remaining} if it doesn't come back.");
    expect(msg("stream.phone.countdown.warming.no_inbound_timeout")).toBe("No video from the phone yet — the stream is cancelled in {remaining} if it doesn't arrive.");
  });

  it("durationLabel is the locale's own short duration (the oracle: Intl.DurationFormat) — every locale, the boundaries, zero", () => {
    const DF = (Intl as unknown as { DurationFormat: new (l: string, o: object) => { format(d: object): string } }).DurationFormat;
    expect(typeof DF, "PREMISE: this Node has Intl.DurationFormat to judge by").toBe("function");
    const values = [0, 999, 1_000, 59_999, 60_000, 555_000, 740_000, 899_999, 3_600_000, 3_723_000];
    let checked = 0;
    for (const l of LOCALES) {
      for (const ms of values) {
        const total = Math.floor(ms / 1000);
        const parts = { hours: Math.floor(total / 3600), minutes: Math.floor((total % 3600) / 60), seconds: total % 60 };
        const want = total === 0
          ? new DF(l, { style: "short", secondsDisplay: "always" }).format({ seconds: 0 })
          : new DF(l, { style: "short" }).format(parts);
        expect(durationLabel(ms, l), `${l} ${ms}`).toBe(want);
        checked++;
      }
    }
    expect(checked).toBe(LOCALES.length * values.length);
    // The mockup's own figures, in English.
    expect(durationLabel(555_000, "en")).toBe("9 min, 15 sec");
    expect(durationLabel(160_000, "en")).toBe("2 min, 40 sec");
  });
});

describe("phoneStrip — the message under the chain (Option B rev 2, T11)", () => {
  const live = (over: Partial<StreamSessionView> = {}) => view({ state: "live", ingest: { state: "disconnected", protocol: "srt" }, ...over });

  it("the EMPTY case: no read model and no session → the pair-first line (slate, the phone icon)", () => {
    expect(phoneStrip(null, null)).toEqual({ tone: "slate", icon: "phone", lead: null, body: { key: "stream.phone.pairFirst" } });
  });

  it("each Ready row: no phone → pair first; silent → amber, open Capture; paired → the phone's model and mode (PR-2, Option A); ended and code-ended → no strip", () => {
    expect(phoneStrip(readModel({ phone: null }), null)).toMatchObject({ tone: "slate", icon: "phone", body: { key: "stream.phone.pairFirst" } });
    expect(phoneStrip(readModel({ phone: SILENT }), null)).toMatchObject({ tone: "amber", icon: "alert", body: { key: "stream.phone.silent" } });
    expect(phoneStrip(readModel(), null)).toEqual({
      tone: "slate", icon: "phone", lead: null, body: null, line: [{ kind: "model", text: "Pixel 8" }, { kind: "mode", mode: "operator" }],
    });
    expect(phoneStrip(readModel(), view({ state: "completed" }))).toBeNull();
    expect(phoneStrip(readModel({ finished: true, code: ENDED_CODE }), null)).toBeNull();
    expect(msg("stream.phone.pairFirst")).toBe("Pair a phone first: scan the code with Seazn Capture");
    expect(msg("stream.phone.silent")).toBe("The phone stopped checking in. Open Seazn Capture on it");
  });

  it("waiting: the lead alone, slate, before a countdown; with the warming countdown, amber and its reason's sentence over `remaining` — exactly as given", () => {
    const warming = view({ state: "warming", ingest: { state: "disconnected", protocol: "srt" } });
    expect(phoneStrip(readModel(), warming)).toEqual({ tone: "slate", icon: "clock", lead: "stream.phone.waitingVideo", body: null });
    const cd = { kind: "warming" as const, reason: "no_inbound_timeout" as const, elapsedMs: 45_000, remainingMs: 555_000 };
    expect(phoneStrip(readModel(), { ...warming, countdown: cd })).toEqual({
      tone: "amber", icon: "clock", lead: "stream.phone.waitingVideo",
      body: { key: "stream.phone.countdown.warming.no_inbound_timeout", elapsedMs: 45_000, remainingMs: 555_000 },
    });
    const lost = { ...cd, reason: "phone_lost" as const, remainingMs: 30_000 };
    expect(phoneStrip(readModel(), { ...warming, countdown: lost })?.body).toEqual({ key: "stream.phone.countdown.warming.phone_lost", elapsedMs: 45_000, remainingMs: 30_000 });
    expect(msg("stream.phone.waitingVideo")).toBe("Waiting for the phone's video");
  });

  it("live: the countdown when the server sends one (it outranks a stale reason); otherwise the O5 reason while the input is down; nothing while it is connected", () => {
    const cd = { kind: "live" as const, reason: "phone_lost" as const, elapsedMs: 160_000, remainingMs: 740_000 };
    const counting = phoneStrip(readModel({ phone: phoneFacts({ notReady: "camera" }) }), live({ countdown: cd }));
    expect(counting).toEqual({ tone: "amber", icon: "clock", lead: null, body: { key: "stream.phone.countdown.live.phone_lost", elapsedMs: 160_000, remainingMs: 740_000 } });
    // O5 (the brief's case): live, input not connected, the phone beating with notReady camera → the reason, NO countdown.
    const paused = phoneStrip(readModel({ phone: phoneFacts({ notReady: "camera" }) }), live());
    expect(paused).toEqual({ tone: "amber", icon: "pause", lead: null, body: { key: "stream.phone.paused.camera" } });
    expect(JSON.stringify(paused)).not.toMatch(/countdown/);
    expect(phoneStrip(readModel({ phone: phoneFacts({ state: "reconnecting" }) }), live())?.body).toEqual({ key: "stream.phone.paused.weak" });
    expect(phoneStrip(readModel({ phone: phoneFacts({ state: "publishing" }) }), live()), "down, but no reason and no countdown").toBeNull();
    // PR-2 (§7.4, Option A): with the input connected the strip is the phone-health line — never the O5 reason (raw notReady).
    expect(phoneStrip(readModel({ phone: phoneFacts({ notReady: "camera" }) }), live({ ingest: { state: "connected", protocol: "srt" } })), "the input is connected").toEqual({
      tone: "slate", icon: "phone", lead: null, body: null, line: [{ kind: "phone" }, { kind: "heard", elapsedMs: 10_000 }],
    });
    expect(phoneStrip(readModel({ phone: null }), live()), "no phone facts, no countdown").toBeNull();
  });

  it("C-1: a LEGACY session (no pairing) shows no strip at all, whatever it carries", () => {
    let checked = 0;
    for (const state of StreamSessionState.options) {
      expect(phoneStrip(readModel({ legacy: true, phone: null }), view({ state, ingest: { state: "disconnected", protocol: "srt" } })), state).toBeNull();
      checked++;
    }
    expect(checked).toBe(StreamSessionState.options.length);
  });

  it("the strip's own copy is in all four locales", () => {
    expect(inEveryLocale(["stream.phone.pairFirst", "stream.phone.silent", "stream.phone.waitingVideo", "stream.phone.pollFar", "stream.phone.matchOver"])).toBe(5 * LOCALES.length);
    expect(msg("stream.phone.pollFar")).toBe("The phone checks in every minute until 30 minutes before the match");
    expect(msg("stream.phone.matchOver")).toBe("This match is over. Its stream code has ended.");
  });
});

describe("restartLine — W23 (T11)", () => {
  it("the EMPTY case: no window → no line", () => {
    expect(restartLine(null)).toBeNull();
  });

  it("below the limit: emerald, the count only; at the limit: amber, with the credit suffix — the numbers are the server's", () => {
    expect(restartLine({ windowOpen: true, used: 1, limit: 3, free: true })).toEqual({ tone: "emerald", key: "stream.restart.used", vars: { used: 1, limit: 3 } });
    expect(restartLine({ windowOpen: true, used: 0, limit: 3, free: true })).toEqual({ tone: "emerald", key: "stream.restart.used", vars: { used: 0, limit: 3 } });
    expect(restartLine({ windowOpen: true, used: 3, limit: 3, free: false })).toEqual({ tone: "amber", key: "stream.restart.usedCredit", vars: { used: 3, limit: 3 } });
    expect(msg("stream.restart.used", { used: 1, limit: 3 })).toBe("Free restarts used (1 of 3)");
    expect(msg("stream.restart.usedCredit", { used: 3, limit: 3 })).toBe("Free restarts used (3 of 3) — this one uses 1 credit");
    expect(inEveryLocale(["stream.restart.used", "stream.restart.usedCredit"])).toBe(2 * LOCALES.length);
  });

  it("the retired 24-hour line is gone from every locale (carry: it was inaccurate under W23)", () => {
    let checked = 0;
    for (const l of LOCALES) {
      expect(Object.keys(dict(l)).filter((k) => /^stream\.phone\.restart/.test(k)), l).toEqual([]);
      checked++;
    }
    expect(checked).toBe(4);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// PR-2 (spec §7.1, §7.4, §7.5; the owner-approved mockup Option A): the phone-health line, the amber sentence, the
// not-ready line, the auto-start refusal, the takeover notice, the live read-only line and the Details data. Every verdict
// is the SERVER's (`phone.health`, `notReadyShown`, `auto.refusal`, `lastTakeover.elapsedMs`); the expected values are the
// spec's sentences and the domain's own declarations, never read back from stream-session-view.ts.
// ---------------------------------------------------------------------------------------------------------------------
describe("PR-2 §7.4 — the phone-health line, built from the read model only (FP14: a null reading is OMITTED)", () => {
  const withBeat = (beat: Partial<Phone["beat"]>, over: Partial<Phone> = {}) =>
    phoneFacts({ beat: { battery: null, bitrateKbps: null, delivery: null, thermal: null, dataUsedMB: null, ...beat }, ...over });

  it("the spec's line: Phone · battery · bitrate · heard — each part from its own reading, in that order", () => {
    expect(healthLine(withBeat({ battery: { percent: 78, charging: true, drainPctPerHour: null }, bitrateKbps: 2400 }, { elapsedMs: 4_000 }))).toEqual([
      { kind: "phone" }, { kind: "battery", percent: 78, charging: true }, { kind: "bitrate", kbps: 2400 }, { kind: "heard", elapsedMs: 4_000 },
    ]);
  });

  it("the EMPTY case (a Paired-phase beat: battery, thermal and bitrate all null): only Phone and heard — no zero invented", () => {
    const parts = healthLine(withBeat({}, { elapsedMs: 0 }));
    expect(parts).toEqual([{ kind: "phone" }, { kind: "heard", elapsedMs: 0 }]);
    expect(JSON.stringify(parts)).not.toMatch(/battery|bitrate|null/);
  });

  it("each reading omitted ALONE: no battery keeps the bitrate; no bitrate (a reconnect, the first reading) keeps the battery; a REAL 0 kbps is a reading and stays", () => {
    const rows: [string, Partial<Phone["beat"]>, PhoneLinePart["kind"][]][] = [
      ["no battery", { bitrateKbps: 1800 }, ["phone", "bitrate", "heard"]],
      ["no bitrate", { battery: { percent: 14, charging: false, drainPctPerHour: 9 } }, ["phone", "battery", "heard"]],
      ["a real zero bitrate", { bitrateKbps: 0 }, ["phone", "bitrate", "heard"]],
    ];
    let checked = 0;
    for (const [name, beat, kinds] of rows) {
      expect(healthLine(withBeat(beat)).map((p) => p.kind), name).toEqual(kinds);
      checked++;
    }
    expect(checked).toBe(rows.length);
  });
});

describe("PR-2 §7.4 — the strip under the chain (Option A: one line; an amber state turns it amber)", () => {
  const live = (over: Partial<StreamSessionView> = {}) => view({ state: "live", ingest: { state: "connected", protocol: "srt" }, ...over });
  const warming = (over: Partial<StreamSessionView> = {}) => view({ state: "warming", ingest: { state: "disconnected", protocol: "srt" }, ...over });
  const BAT = { percent: 14, charging: false, drainPctPerHour: null };

  it("the HEALTH_KEYS table is total over the domain's HEALTH_REASONS, and each key says the spec's sentence (en), in all four locales", () => {
    const SPEC: Record<string, string> = {
      not_responding: "Phone not responding · last heard 52 s ago",
      stalled: "Video isn't reaching Seazn from the phone",
      hot: "The phone is running hot",
      battery_low: "Phone battery low (14%) — plug it in",
    };
    expect(Object.keys(HEALTH_KEYS).sort()).toEqual([...HEALTH_REASONS].sort());
    let checked = 0;
    for (const r of HEALTH_REASONS) {
      expect(msg(HEALTH_KEYS[r], { s: 52, n: 14 }), r).toBe(SPEC[r]);
      checked++;
    }
    expect(checked).toBe(4);
    expect(inEveryLocale(Object.values(HEALTH_KEYS))).toBe(4 * LOCALES.length);
  });

  it("live, input connected: each reason the SERVER names turns the strip amber with its sentence; the line stays beneath (not for not-responding: its readings are stale)", () => {
    let checked = 0;
    for (const reason of HEALTH_REASONS) {
      const f = phoneFacts({ health: reason, elapsedMs: 52_000, beat: { battery: BAT, bitrateKbps: 2400, delivery: "ok", thermal: 1, dataUsedMB: 12 } });
      const strip = phoneStrip(readModel({ phone: f }), live())!;
      expect([strip.tone, strip.icon, strip.lead], reason).toEqual(["amber", "alert", HEALTH_KEYS[reason]]);
      if (reason === "not_responding") {
        expect(strip.leadVars, reason).toEqual({ s: 52 });
        expect(strip.line, `${reason}: no stale line`).toBeUndefined();
      } else {
        expect(strip.line?.map((p) => p.kind), reason).toEqual(["phone", "battery", "bitrate", "heard"]);
      }
      if (reason === "battery_low") expect(strip.leadVars, reason).toEqual({ n: 14 });
      checked++;
    }
    expect(checked).toBe(HEALTH_REASONS.length);
  });

  it("NEVER a client threshold: readings far past W9's limits with `health` null stay a slate line; `hot` from the server with a cool reading is still amber", () => {
    const scorching = phoneFacts({ health: null, beat: { battery: { percent: 2, charging: false, drainPctPerHour: 40 }, bitrateKbps: 100, delivery: "stalled", thermal: 6, dataUsedMB: 1 } });
    const slate = phoneStrip(readModel({ phone: scorching }), live())!;
    expect([slate.tone, slate.lead], "the server named nothing").toEqual(["slate", null]);
    const cool = phoneFacts({ health: "hot", beat: { battery: null, bitrateKbps: null, delivery: "ok", thermal: 0, dataUsedMB: null } });
    expect(phoneStrip(readModel({ phone: cool }), live())!.lead, "the server's word wins").toBe(HEALTH_KEYS.hot);
  });

  it("a battery_low verdict with no reading to name is still amber, with the sentence that names no number (a guard, not a zero)", () => {
    const strip = phoneStrip(readModel({ phone: phoneFacts({ health: "battery_low" }) }), live())!;
    expect([strip.tone, strip.lead, strip.leadVars]).toEqual(["amber", "stream.phone.health.batteryLowBare", undefined]);
    expect(msg("stream.phone.health.batteryLowBare")).toBe("Phone battery low — plug it in");
  });

  it("the countdown and the O5 pause still outrank the health line (the input is DOWN), and ending shows none", () => {
    const f = phoneFacts({ health: "hot", notReady: "camera" });
    const cd = { kind: "live" as const, reason: "phone_lost" as const, elapsedMs: 1, remainingMs: 2 };
    expect(phoneStrip(readModel({ phone: f }), live({ ingest: { state: "disconnected", protocol: "srt" }, countdown: cd }))?.body?.key).toBe("stream.phone.countdown.live.phone_lost");
    expect(phoneStrip(readModel({ phone: f }), live({ ingest: { state: "disconnected", protocol: "srt" } }))?.body?.key).toBe("stream.phone.paused.camera");
    expect(phoneStrip(readModel({ phone: f }), view({ state: "ending", ingest: { state: "connected", protocol: "srt" } }))).toBeNull();
  });

  it("the not-ready line: ONLY while `notReadyShown` — the raw `notReady` alone (a flap the server has not confirmed) leaves Waiting as it was", () => {
    const flap = phoneFacts({ notReady: "camera", notReadyShown: false, mode: "automatic" });
    expect(phoneStrip(readModel({ phone: flap }), warming())).toEqual({ tone: "slate", icon: "clock", lead: "stream.phone.waitingVideo", body: null });
    let checked = 0;
    for (const reason of CaptureNotReady.options) {
      const held = phoneFacts({ notReady: reason, notReadyShown: true, mode: "automatic" });
      expect(phoneStrip(readModel({ phone: held }), warming()), reason).toEqual({
        tone: "amber", icon: "alert", lead: "stream.phone.notReady.line", leadVars: { reason: NOT_READY_KEYS[reason] }, body: null,
        line: [{ kind: "mode", mode: "automatic" }, { kind: "model", text: "Pixel 8" }, { kind: "waiting" }],
      });
      checked++;
    }
    expect(checked).toBe(CaptureNotReady.options.length);
    // The clear: notReady back to null (the server's notReadyShown false with it) → Waiting again.
    expect(phoneStrip(readModel({ phone: phoneFacts() }), warming())?.lead).toBe("stream.phone.waitingVideo");
  });

  it("§7.4's not-ready words (the spec's, en), every reason the contract declares, in all four locales", () => {
    const SPEC: Record<string, string> = { camera: "camera", sound: "sound", network: "network", held: "turn the phone sideways" };
    let checked = 0;
    for (const r of CaptureNotReady.options) {
      expect(msg("stream.phone.notReady.line", { reason: msg(NOT_READY_KEYS[r]) }), r).toBe(`Phone not ready: ${SPEC[r]}`);
      checked++;
    }
    expect(checked).toBe(4);
    expect(inEveryLocale(["stream.phone.notReady.line", "stream.phone.startFailed", ...Object.values(NOT_READY_KEYS)])).toBe(6 * LOCALES.length);
  });

  it("Couldn't start on the phone (startFailed) outranks not-ready; with the warming countdown both keep it as the lead over the countdown's sentence; a LOST phone's countdown keeps today's strip", () => {
    const f = phoneFacts({ startFailed: "config", notReady: "sound", notReadyShown: true, mode: "operator", model: null });
    expect(phoneStrip(readModel({ phone: f }), warming())).toEqual({
      tone: "amber", icon: "alert", lead: "stream.phone.startFailed", body: null, line: [{ kind: "mode", mode: "operator" }, { kind: "waiting" }],
    });
    expect(msg("stream.phone.startFailed")).toBe("Couldn't start on the phone");
    const timeout = { kind: "warming" as const, reason: "no_inbound_timeout" as const, elapsedMs: 45_000, remainingMs: 555_000 };
    expect(phoneStrip(readModel({ phone: f }), warming({ countdown: timeout }))).toEqual({
      tone: "amber", icon: "alert", lead: "stream.phone.startFailed", body: { key: "stream.phone.countdown.warming.no_inbound_timeout", elapsedMs: 45_000, remainingMs: 555_000 },
    });
    const lost = { ...timeout, reason: "phone_lost" as const };
    expect(phoneStrip(readModel({ phone: f }), warming({ countdown: lost }))?.lead, "the lost phone's own strip").toBe("stream.phone.waitingVideo");
  });

  it("Ready, paired: the model and the mode, each omitted when null — both null is no strip (today's)", () => {
    const rows: [Partial<Phone>, PhoneLinePart[] | null][] = [
      [{ model: "Pixel 8", mode: "automatic" }, [{ kind: "model", text: "Pixel 8" }, { kind: "mode", mode: "automatic" }]],
      [{ model: null, mode: "operator" }, [{ kind: "mode", mode: "operator" }]],
      [{ model: "Pixel 8", mode: null }, [{ kind: "model", text: "Pixel 8" }]],
      [{ model: null, mode: null }, null],
    ];
    let checked = 0;
    for (const [over, line] of rows) {
      const strip = phoneStrip(readModel({ phone: phoneFacts(over) }), null);
      expect(strip === null ? null : strip.line, JSON.stringify(over)).toEqual(line);
      checked++;
    }
    expect(checked).toBe(4);
    expect(inEveryLocale(["stream.phone.mode.automatic", "stream.phone.mode.operator"])).toBe(2 * LOCALES.length);
    expect([msg("stream.phone.mode.automatic"), msg("stream.phone.mode.operator")]).toEqual(["Automatic", "Operator"]);
  });

  it("FP14: no pre-live strip reads battery, thermal or bitrate — Ready and Waiting are the same with the readings null or set (and a server `health` set pre-live changes nothing)", () => {
    const empty = { battery: null, bitrateKbps: null, delivery: null, thermal: null, dataUsedMB: null };
    const full = { battery: BAT, bitrateKbps: 2400, delivery: "stalled" as const, thermal: 5, dataUsedMB: 40 };
    const sessions: [string, StreamSessionView | null][] = [
      ["ready", null], ["requested", warming({ state: "requested" })], ["provisioning", warming({ state: "provisioning" })], ["warming", warming()],
    ];
    const phones: Partial<Phone>[] = [{}, { present: false, silent: true }, { notReady: "held", notReadyShown: true }, { startFailed: "start-error" }];
    let checked = 0;
    for (const [name, s] of sessions) for (const over of phones) {
      const a = phoneStrip(readModel({ phone: phoneFacts({ ...over, beat: empty, health: null }) }), s);
      const b = phoneStrip(readModel({ phone: phoneFacts({ ...over, beat: full, health: "battery_low" }) }), s);
      expect(b, `${name} ${JSON.stringify(over)}`).toEqual(a);
      checked++;
    }
    expect(checked).toBe(sessions.length * phones.length);
  });
});

describe("PR-2 §7.4 — the automatic start's refusal (served only while it could still fire — the server's gate)", () => {
  it("the tables are total over the domain's AUTO_START_REFUSALS; each reason reads the manual refusal's own sentence; the remedies are Buy credits and Manage destinations", () => {
    expect(Object.keys(AUTO_REFUSAL_KEYS).sort()).toEqual([...AUTO_START_REFUSALS].sort());
    const SPEC: Record<string, [string, "buy" | "manage" | undefined]> = {
      no_credit: ["You need a match credit to go live.", "buy"],
      no_destination: ["This match has no destination to stream to.", "manage"],
      not_entitled: ["Phone streaming isn't on your plan.", undefined],
      destination_in_use: ["That destination is already live on another match.", undefined],
      unavailable: ["The streaming service is unavailable. Try again in a minute.", undefined],
    };
    let checked = 0;
    for (const r of AUTO_START_REFUSALS) {
      const strip = autoRefusalStrip(readModel({ auto: { enabled: true, refusal: r, wontStart: null, stopApplies: null } }))!;
      expect([strip.tone, strip.lead, strip.remedy], r).toEqual(["amber", "stream.auto.refused", SPEC[r]![1]]);
      expect(msg(strip.lead!, { reason: msg((strip.leadVars as { reason: string }).reason) }), r).toBe(`Automatic start couldn't begin: ${SPEC[r]![0]}`);
      expect(AUTO_REFUSAL_REMEDY[r], r).toBe(SPEC[r]![1]);
      checked++;
    }
    expect(checked).toBe(AUTO_START_REFUSALS.length);
    // B7 review M-7: the exact count — the lead, the remedy and one distinct key per refusal, in every locale.
    const keys = ["stream.auto.refused", "stream.auto.buyCredits", ...new Set(Object.values(AUTO_REFUSAL_KEYS))];
    expect(keys.length, "one distinct reason key per refusal").toBe(2 + AUTO_START_REFUSALS.length);
    expect(inEveryLocale(keys)).toBe(7 * LOCALES.length);
  });

  // B7 review M-6: the reason follows "…couldn't begin:" mid-sentence — es/fr/nl open it in lower case; English reads the
  // manual refusal's own sentence. The manual keys are the source of truth for the words; only the first letter moves.
  it("each reason is the MANUAL refusal's sentence — verbatim in English, its first letter lowered in es/fr/nl (a mid-sentence clause); the lead reads naturally", () => {
    const MANUAL: Partial<Record<(typeof AUTO_START_REFUSALS)[number], string>> = {
      no_credit: "stream.error.no_credits",
      not_entitled: "stream.error.plan_lacks_relay",
      destination_in_use: "stream.error.target_in_use.unknown",
      unavailable: "stream.error.ingest_unavailable",
    };
    const lowerFirst = (x: string) => x.charAt(0).toLocaleLowerCase() + x.slice(1);
    let checked = 0;
    for (const l of LOCALES) {
      const d = dict(l);
      for (const r of AUTO_START_REFUSALS) {
        const reason = d[AUTO_REFUSAL_KEYS[r]]!;
        const manual = MANUAL[r];
        if (manual) expect(reason, `${l} ${r}`).toBe(l === "en" ? d[manual] : lowerFirst(d[manual]!));
        // Every reason: capitalised in English (its own sentence there), lower case elsewhere.
        const first = reason.charAt(0);
        expect(first === first.toLocaleLowerCase() && first !== first.toLocaleUpperCase(), `${l} ${r}: "${reason}"`).toBe(l !== "en");
        checked++;
      }
    }
    expect(checked).toBe(LOCALES.length * AUTO_START_REFUSALS.length);
    const lead = (l: string) => dict(l as (typeof LOCALES)[number])["stream.auto.refused"];
    expect([lead("es"), lead("fr"), lead("nl")]).toEqual([
      "No se pudo iniciar automáticamente: {reason}", "Impossible de démarrer automatiquement : {reason}", "Automatisch starten lukte niet: {reason}",
    ]);
  });

  it("the EMPTY cases: no read model, no settings row (`auto: null`), and a row with no refusal → no strip", () => {
    expect(autoRefusalStrip(null)).toBeNull();
    expect(autoRefusalStrip(readModel({ auto: null }))).toBeNull();
    expect(autoRefusalStrip(readModel({ auto: { enabled: true, refusal: null, wontStart: null, stopApplies: null } }))).toBeNull();
  });

  it("Ready, paired: the refusal takes the strip; silent keeps the phone's own strip; a session in flight shows none", () => {
    const auto = { enabled: true, refusal: "no_destination" as const, wontStart: null, stopApplies: null };
    expect(phoneStrip(readModel({ auto }), null)?.lead).toBe("stream.auto.refused");
    expect(phoneStrip(readModel({ auto, phone: SILENT }), null)?.body?.key).toBe("stream.phone.silent");
    expect(phoneStrip(readModel({ auto }), view({ state: "warming", ingest: { state: "disconnected", protocol: "srt" } }))?.lead).toBe("stream.phone.waitingVideo");
  });
});

describe("PR-2 §7.5 — the takeover notice: 30 min on the SERVER's clock, dismissable per takeover, naming Stop only live", () => {
  const AT = "2026-09-14T11:40:00.000Z";
  const took = (elapsedMs: number, model: string | null = "Pixel 8", at = AT) => readModel({ lastTakeover: { at, model, elapsedMs } });

  it("the window is §7.5's 30 minutes", () => {
    expect(TAKEOVER_NOTICE_MS).toBe(30 * 60_000);
  });

  it("the EMPTY case: no read model, no takeover → none", () => {
    expect(takeoverNotice(null, "idle", null)).toBeNull();
    expect(takeoverNotice(readModel(), "idle", null)).toBeNull();
  });

  it("the boundary on the server's elapsedMs: 0 and 29:59 shown, 30:00 and later not", () => {
    const rows: [number, boolean][] = [[0, true], [30 * 60_000 - 1_000, true], [30 * 60_000 - 1, true], [30 * 60_000, false], [31 * 60_000, false]];
    let checked = 0;
    for (const [ms, shown] of rows) {
      expect(takeoverNotice(took(ms), "idle", null) !== null, `${ms} ms`).toBe(shown);
      checked++;
    }
    expect(checked).toBe(rows.length);
  });

  // Owner ruling 2026-10-08 (B7 review M-2): the button to press BEFORE Revoke & reissue is the one the state shows —
  // Stop live, Cancel while the session waits, neither with no session.
  it("names Stop ONLY live, Cancel ONLY while waiting (provisioning, warming), neither otherwise — every tab state swept", () => {
    const WANT: Record<PhoneTabState, TakeoverAct> = {
      idle: null, provisioning: "cancel", warming: "cancel", live: "stop", ending: null, ended: null, failed: null,
    };
    const states = Object.keys(WANT) as PhoneTabState[];
    expect(states.sort(), "PREMISE: every tab state").toEqual(Object.keys(STATE_PILL_KEYS).sort());
    let checked = 0;
    for (const st of states) {
      expect(takeoverNotice(took(1_000), st, null)?.act, st).toBe(WANT[st]);
      checked++;
    }
    expect(checked).toBe(7);
  });

  it("the sentence each act picks: waiting names Cancel, live names Stop, ready names neither — with and without the model", () => {
    const rows: [TakeoverAct, boolean, string][] = [
      ["cancel", true, "The camera moved to another phone (Pixel 8) at 14:32. Not yours? Cancel the stream, then Revoke & reissue"],
      ["cancel", false, "The camera moved to another phone at 14:32. Not yours? Cancel the stream, then Revoke & reissue"],
      ["stop", true, "The camera moved to another phone (Pixel 8) at 14:32. Not yours? Stop the stream, then Revoke & reissue"],
      ["stop", false, "The camera moved to another phone at 14:32. Not yours? Stop the stream, then Revoke & reissue"],
      [null, true, "The camera moved to another phone (Pixel 8) at 14:32. Not yours? Revoke & reissue"],
      [null, false, "The camera moved to another phone at 14:32. Not yours? Revoke & reissue"],
    ];
    let checked = 0;
    for (const [act, withModel, want] of rows) {
      expect(msg(takeoverLineKey(act, withModel), { model: "Pixel 8", time: "14:32" }), `${act} ${withModel}`).toBe(want);
      checked++;
    }
    expect(checked).toBe(rows.length);
    // In every locale the waiting sentence names the panel's OWN Revoke & reissue label, and differs from the live one.
    for (const l of LOCALES) {
      const d = dict(l);
      for (const k of ["stream.takeover.lineWaiting", "stream.takeover.lineWaitingNoModel"]) {
        expect(d[k], `${l} ${k}`).toContain(d["stream.code.reissue"]);
        expect(d[k], `${l} ${k}`).not.toBe(d[k.replace("Waiting", "Live")]);
      }
    }
  });

  it("dismissed for THIS takeover's instant hides it; a NEW takeover (another instant) shows again; the model is carried as given (null too)", () => {
    expect(takeoverNotice(took(1_000), "idle", AT)).toBeNull();
    expect(takeoverNotice(took(1_000, "Galaxy S24", "2026-09-14T11:55:00.000Z"), "idle", AT)).toEqual({ at: "2026-09-14T11:55:00.000Z", model: "Galaxy S24", act: null });
    expect(takeoverNotice(took(1_000, null), "live", null)).toEqual({ at: AT, model: null, act: "stop" });
  });

  it("the copy: the spec's sentence with and without Stop, with and without a model, in all four locales", () => {
    expect(msg("stream.takeover.line", { model: "Pixel 8", time: "14:32" })).toBe("The camera moved to another phone (Pixel 8) at 14:32. Not yours? Revoke & reissue");
    expect(msg("stream.takeover.lineLive", { model: "Pixel 8", time: "14:32" })).toBe("The camera moved to another phone (Pixel 8) at 14:32. Not yours? Stop the stream, then Revoke & reissue");
    expect(msg("stream.takeover.lineNoModel", { time: "14:32" })).toBe("The camera moved to another phone at 14:32. Not yours? Revoke & reissue");
    expect(msg("stream.takeover.lineLiveNoModel", { time: "14:32" })).toBe("The camera moved to another phone at 14:32. Not yours? Stop the stream, then Revoke & reissue");
    expect(inEveryLocale([
      "stream.takeover.line", "stream.takeover.lineLive", "stream.takeover.lineNoModel", "stream.takeover.lineLiveNoModel",
      "stream.takeover.lineWaiting", "stream.takeover.lineWaitingNoModel", "stream.takeover.dismiss",
    ])).toBe(7 * LOCALES.length);
  });
});

describe("PR-2 §7.1 — Live's read-only line, and §7.4's Details data (owner ruling Q-D: Live/Ending only)", () => {
  const auto = (enabled: boolean, stopApplies: boolean | null = null) => ({ enabled, refusal: null, wontStart: null, stopApplies });

  // B7 review M-3: the line is the SERVER's `stopApplies` (the tick's own predicate: switch, phone mode AND the session
  // created before any result), never re-derived from the switch and the mode — a post-result broadcast has both on and
  // is never stopped, so the rows that matter are the ones where the two answers DIFFER.
  it("the line shows only LIVE and only on the server's stopApplies — the empty cases first; switch+mode on with stopApplies false (A15's post-result broadcast) hides it", () => {
    expect(autoStopLine(null, "live")).toBe(false);
    expect(autoStopLine(readModel({ auto: null }), "live"), "no settings row").toBe(false);
    const rows: [boolean, "automatic" | "operator" | null, boolean | null, PhoneTabState, boolean][] = [
      [true, "automatic", true, "live", true],
      [true, "automatic", false, "live", false],   // A15: the switch and the phone say yes, the server says the stop never applies
      [true, "automatic", null, "live", false],    // no open session on the server's side
      [true, "operator", true, "live", true],      // the server's word stands — the client does not second-guess it
      [false, "automatic", false, "live", false],
      [true, "automatic", true, "idle", false],
      [true, "automatic", true, "warming", false],
      [true, "automatic", true, "ending", false],
    ];
    let checked = 0;
    for (const [enabled, mode, applies, st, want] of rows) {
      expect(autoStopLine(readModel({ auto: auto(enabled, applies), phone: phoneFacts({ mode }) }), st), `${enabled} ${mode} ${applies} ${st}`).toBe(want);
      checked++;
    }
    expect(checked).toBe(rows.length);
  });

  // Owner-approved 2026-10-08: the operator hint under the switch.
  it("the operator hint: shown ONLY with the switch on and the paired phone in Operator — on+automatic, off+operator, no phone and no mode yet hide it", () => {
    const rows: [string, StreamPhone | null, boolean, boolean][] = [
      ["on + operator", readModel({ phone: phoneFacts({ mode: "operator" }) }), true, true],
      ["on + automatic", readModel({ phone: phoneFacts({ mode: "automatic" }) }), true, false],
      ["off + operator", readModel({ phone: phoneFacts({ mode: "operator" }) }), false, false],
      ["on, no phone", readModel({ phone: null }), true, false],
      ["on, no read model", null, true, false],
      ["on, no mode reported yet", readModel({ phone: phoneFacts({ mode: null }) }), true, false],
    ];
    let checked = 0;
    for (const [name, phone, on, want] of rows) {
      expect(autoOperatorHint(phone, on), name).toBe(want);
      checked++;
    }
    expect(checked).toBe(rows.length);
    expect(msg("stream.auto.operatorHint")).toBe("The phone is set to Operator, so it won't start on its own. Switch it to Automatic in the app.");
    expect(inEveryLocale(["stream.auto.operatorHint"])).toBe(LOCALES.length);
  });

  // Final review I-1 (owner, 2026-10-08, option A): the note under the switch. The copy is the owner's (the first approved,
  // the other two in its shape), pinned LITERALLY — never read back from the key table under test.
  it("final review I-1, the switch's note: while ON, a latch the server names (each of the three) — outranking the Operator hint; the Operator hint with none; nothing while off or with no read", () => {
    type Reason = "stopped" | "already_streamed" | "already_started";
    const rm = (wontStart: Reason | null, mode: "automatic" | "operator" | null) =>
      readModel({ auto: { enabled: true, refusal: null, wontStart, stopApplies: null }, phone: phoneFacts({ mode }) });
    const rows: [string, StreamPhone | null, boolean, ReturnType<typeof autoSwitchNote>][] = [
      ["on, stopped", rm("stopped", "automatic"), true, { kind: "wontStart", reason: "stopped" }],
      ["on, already_streamed", rm("already_streamed", "automatic"), true, { kind: "wontStart", reason: "already_streamed" }],
      ["on, already_started", rm("already_started", "automatic"), true, { kind: "wontStart", reason: "already_started" }],
      ["on, stopped + Operator: the latch outranks the hint", rm("stopped", "operator"), true, { kind: "wontStart", reason: "stopped" }],
      ["on, already_started + Operator", rm("already_started", "operator"), true, { kind: "wontStart", reason: "already_started" }],
      ["on, no latch + Operator", rm(null, "operator"), true, { kind: "operator" }],
      ["on, no latch, Automatic", rm(null, "automatic"), true, null],
      ["off, stopped (the switch as the panel shows it)", rm("stopped", "operator"), false, null],
      ["off, already_streamed", rm("already_streamed", "automatic"), false, null],
      ["on, no read model", null, true, null],
      ["on, no settings row", readModel({ auto: null, phone: phoneFacts({ mode: "automatic" }) }), true, null],
    ];
    let checked = 0;
    for (const [name, phone, on, want] of rows) {
      expect(autoSwitchNote(phone, on), name).toEqual(want);
      checked++;
    }
    expect(checked).toBe(rows.length);
    const OWNER: Record<Reason, string> = {
      stopped: "Automatic start is off for this match because the stream was stopped. Use Go live.",
      already_started: "Automatic start already ran for this match. Use Go live to start again.",
      already_streamed: "Automatic start is off for this match because a stream already ran. Use Go live.",
    };
    expect(Object.keys(AUTO_WONT_START_KEY).sort(), "every served latch has a line").toEqual(Object.keys(OWNER).sort());
    for (const [reason, text] of Object.entries(OWNER)) expect(msg(AUTO_WONT_START_KEY[reason as Reason]), reason).toBe(text);
    expect(inEveryLocale(Object.values(AUTO_WONT_START_KEY))).toBe(3 * LOCALES.length);
  });

  it("Details: data used and the app version, each OMITTED when null — and none at all without a phone", () => {
    expect(phoneDetails(null)).toEqual([]);
    expect(phoneDetails(readModel({ phone: null }))).toEqual([]);
    const f = (dataUsedMB: number | null, appVersion: string | null) =>
      readModel({ phone: phoneFacts({ appVersion, beat: { battery: null, bitrateKbps: null, delivery: null, thermal: null, dataUsedMB } }) });
    expect(phoneDetails(f(245.3, "1.4.0"))).toEqual([{ kind: "dataUsed", mb: 245.3 }, { kind: "appVersion", version: "1.4.0" }]);
    expect(phoneDetails(f(null, "1.4.0"))).toEqual([{ kind: "appVersion", version: "1.4.0" }]);
    expect(phoneDetails(f(0, null)), "a real 0 MB is a reading").toEqual([{ kind: "dataUsed", mb: 0 }]);
    expect(phoneDetails(f(null, null))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Owner ruling 2026-10-09 ("A"): a W5 refusal clears once the phone read flips to present
// ---------------------------------------------------------------------------------------------------------------------
/** The panel's glue, exactly as fixture-stream-panel.tsx wires the two helpers: a refusal sets the error and tells the
 *  watch; a read that LANDS asks `readClearsW5`, and a yes retires a W5 error (any other error stays). */
type Panel = { watch: PresenceWatch; error: CreateFailureCode | null };
const refuse = (p: Panel, code: CreateFailureCode, issued: number): Panel => ({ watch: presenceAfterRefusal(p.watch, code, issued), error: code });
const land = (p: Panel, seq: number, present: boolean): Panel => {
  const clear = readClearsW5(p.watch, { seq, present });
  return { watch: p.watch, error: clear && p.error !== null && isW5Refusal(p.error) ? null : p.error };
};

describe("owner ruling 2026-10-09 (A): a Go live refused for want of a phone clears when the phone read flips to present", () => {
  it("the W5 codes are exactly the two W5 answers, both console codes the tab tells apart", () => {
    expect([...W5_REFUSAL_CODES].sort()).toEqual(["phone_not_paired", "phone_not_responding"]);
    let checked = 0;
    for (const c of W5_REFUSAL_CODES) {
      expect(CREATE_ERROR_CODES as readonly string[], c).toContain(c);
      expect(isW5Refusal(c), c).toBe(true);
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("EMPTY first: nothing refused, nothing read — the start watch waits on no refusal, and a present read clears nothing", () => {
    expect(PRESENCE_WATCH_START).toEqual({ refusedAtRead: 0 });
    expect(land({ watch: PRESENCE_WATCH_START, error: null }, 1, true)).toEqual({ watch: { refusedAtRead: 0 }, error: null });
  });

  it("the sequence: error shown → the phone present → error gone → silent again → a later Go live's error shows again and stays while silent → present → gone", () => {
    let p: Panel = { watch: PRESENCE_WATCH_START, error: null };
    p = land(p, 1, true);                                   // the panel reads the phone present: Go live
    p = refuse(p, "phone_not_responding", 1);               // …it went quiet before the click
    expect(p.error, "error shown").toBe("phone_not_responding");
    p = land(p, 2, true);                                   // the organiser wakes it: the next read is present
    expect(p.error, "phone present → error gone").toBeNull();
    p = land(p, 3, false);                                  // silent again
    p = land(p, 4, true);                                   // the panel reads it present one more time
    p = refuse(p, "phone_not_responding", 4);               // and a LATER click is refused again
    expect(p.error, "the new error shows again").toBe("phone_not_responding");
    p = land(p, 5, false);
    p = land(p, 6, false);
    expect(p.error, "silent reads keep it — only a flip to present clears").toBe("phone_not_responding");
    p = land(p, 7, true);
    expect(p.error).toBeNull();
  });

  it("the never-paired answer clears the same way (a reissued code, then a phone scans it)", () => {
    let p: Panel = land({ watch: PRESENCE_WATCH_START, error: null }, 1, true);
    p = refuse(p, "phone_not_paired", 1);
    p = land(p, 2, false);                                  // the panel catches up: no phone on the new code
    expect(p.error).toBe("phone_not_paired");
    p = land(p, 3, true);                                   // a phone scans it
    expect(p.error).toBeNull();
  });

  it("a read ASKED before the refusal cannot answer it: it lands present after the click and the error stays; the next read asked after clears it", () => {
    let p: Panel = land({ watch: PRESENCE_WATCH_START, error: null }, 1, true);
    // read 2 was in flight when the click was refused (the refusal saw 2 issued)…
    p = refuse(p, "phone_not_paired", 2);
    p = land(p, 2, true);
    expect(p.error, "a stale present answer is not news about this click").toBe("phone_not_paired");
    expect(p.watch, "…and the watch still waits for a read sent after read 2").toEqual({ refusedAtRead: 2 });
    p = land(p, 3, true);
    expect(p.error).toBeNull();
  });

  it("every other refusal is untouched: the watch ignores it and a flip to present never clears it", () => {
    const others = CREATE_ERROR_CODES.filter((c) => !isW5Refusal(c));
    const all: CreateFailureCode[] = [...others, TARGET_REMOVED];
    let checked = 0;
    for (const code of all) {
      const before: PresenceWatch = { refusedAtRead: 0 };
      expect(presenceAfterRefusal(before, code, 5), code).toBe(before);
      let p: Panel = refuse({ watch: PRESENCE_WATCH_START, error: null }, code, 1);
      p = land(p, 2, true);
      expect(p.error, `${code} survives a flip to present`).toBe(code);
      checked++;
    }
    expect(checked, "anti-vacuity").toBe(CREATE_ERROR_CODES.length - 2 + 1);
  });

  it("property: over any interleaving of polls, answers and refusals, a W5 error is cleared exactly at the first PRESENT answer to a read asked after it — never earlier, never by a stale answer, never another code", () => {
    // The oracle never looks at the watch, nor at the helpers' own W5 list: it knows the owner's two codes and which read
    // was asked after the refusal.
    const W5 = new Set<string>(["phone_not_paired", "phone_not_responding"]);
    type Ev = { k: "ask" } | { k: "land"; present: boolean } | { k: "refuse"; code: CreateFailureCode };
    const code = fc.constantFrom<CreateFailureCode>(...CREATE_ERROR_CODES, TARGET_REMOVED);
    const ev: fc.Arbitrary<Ev> = fc.oneof(
      fc.constant<Ev>({ k: "ask" }),
      fc.boolean().map<Ev>((present) => ({ k: "land", present })),
      code.map<Ev>((c) => ({ k: "refuse", code: c })),
    );
    let clears = 0, staleKept = 0, steps = 0;
    fc.assert(
      fc.property(fc.array(ev, { maxLength: 40 }), (evs) => {
        let p: Panel = { watch: PRESENCE_WATCH_START, error: null };
        let asked = 0, newestLanded = 0;          // only the NEWEST read lands (phoneSeq); an older answer is dropped
        let oracle: { code: CreateFailureCode; at: number } | null = null;
        for (const e of evs) {
          steps++;
          if (e.k === "ask") { asked++; continue; }
          if (e.k === "refuse") { p = refuse(p, e.code, asked); oracle = { code: e.code, at: asked }; }
          else {
            if (asked === 0 || asked === newestLanded) continue;   // nothing in flight
            newestLanded = asked;
            const want = oracle !== null && W5.has(oracle.code) && asked > oracle.at && e.present ? null : (oracle?.code ?? null);
            if (oracle !== null && want === null && p.error !== null) clears++;
            if (oracle !== null && W5.has(oracle.code) && asked <= oracle.at && e.present) staleKept++;
            p = land(p, asked, e.present);
            if (want === null) oracle = null;
          }
          expect(p.error).toBe(oracle?.code ?? null);
        }
      }),
      { numRuns: 400, seed: 20261009 },
    );
    expect(steps, "anti-vacuity: steps driven").toBeGreaterThan(0);
    expect(clears, "anti-vacuity: some W5 errors were cleared").toBeGreaterThan(0);
    expect(staleKept, "anti-vacuity: some stale present answers landed over a W5 error").toBeGreaterThan(0);
  });
});
