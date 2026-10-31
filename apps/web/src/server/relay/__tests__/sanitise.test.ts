// The sanitiser is an ALLOWLIST: a key it has not heard of does not survive,
// whatever its value. A denylist ("drop anything called password") misses the
// next secret; this misses nothing it was not told to keep. Pure — no DB.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { RelayHeartbeat } from "@/server/api-v1/schemas";
import { EVENT_PAYLOAD_MAX_STRING } from "../config";
import { ALLOWED_KEYS, pathTemplate, sanitise, scrubBeatText } from "../sanitise";
import { RUNNER_NONE } from "../domain/runner";
import { decide, eventRowsOf, type Command, type Session } from "../domain/session";

const SECRET = "sekrit-9f3a1c";
/** The fields R2 adds to the beat, typed from compositor spec 2026-10-14 §5.3 / C06 `HealthReport` / C07 `heartbeat_wire`,
 *  and the final beat's exit reason (owner scope addition 2026-10-15; C06 `ExitReason`). */
const R2_BEAT_FIELDS = ["programmePhase", "input", "output", "graphics", "inputKicks", "inputKickAlert", "pipelineRebuilds", "sinkSwaps", "rung", "scoreStale",
  "exitReason", "exitDetail",
  // R2007 PR B (overlay templates spec 2026-10-15 §4.3): which channel the overlay page reads its phase from.
  "phaseChannel"];
/** R4 S8 (sponsors spec 2026-10-27 §3.6.2): the compositor's overflow count rides the beat and is kept like any count. */
const R4_BEAT_FIELDS = ["airingsDropped"];
/** R4 S8, ruling R14: the declared beat fields NEVER kept in a sample's raw (nor in last_heartbeat). `airings` is up to 64
 *  proof-of-play items per beat; the server records them as sponsor airings instead (server/sponsors/airings.ts). */
const NOT_IN_RAW = ["airings"];
/** A hand-written vector of the relay-job.v1 contract (docs/contracts/fixtures/relay-job.v1). */
const contractFixture = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../../../../docs/contracts/fixtures/relay-job.v1", `${name}.json`), "utf8")) as Record<string, unknown>;

describe("sanitise — allowlist", () => {
  it("keeps an allowed key and drops an unknown one, whatever it holds", () => {
    expect(sanitise({ state: "live", passphrase: SECRET, streamKey: SECRET, token: SECRET })).toEqual({ state: "live" });
  });
  it("recurses into nested objects and arrays, with the same list", () => {
    const out = sanitise({ exit: { exitCode: 0, oomKilled: false, env: { RELAY_KEK: SECRET } }, outputs: [{ uid: "o1", streamKey: SECRET }] });
    expect(out).toEqual({ exit: { exitCode: 0, oomKilled: false }, outputs: [{ uid: "o1" }] });
    expect(JSON.stringify(out)).not.toContain(SECRET);
  });
  it("cuts every string at its first `?` — a URL keeps its path, never its query", () => {
    expect(sanitise({ url: `https://live.cloudflare.com/x/y?passphrase=${SECRET}&streamid=abc` })).toEqual({ url: "https://live.cloudflare.com/x/y" });
    expect(sanitise({ reason: `q?${SECRET}` })).toEqual({ reason: "q" });
  });
  it("caps a string at EVENT_PAYLOAD_MAX_STRING and an array at 50 (a stack trace cannot become a row)", () => {
    const long = "x".repeat(EVENT_PAYLOAD_MAX_STRING + 1);
    expect((sanitise({ reason: long }).reason as string).length).toBe(EVENT_PAYLOAD_MAX_STRING);
    expect((sanitise({ outputs: Array.from({ length: 60 }, () => ({ uid: "o" })) }).outputs as unknown[]).length).toBe(50);
  });
  it("stops at depth 4 and returns {} for a non-object (null, a string, a number)", () => {
    const deep = { exit: { exit: { exit: { exit: { exit: { exitCode: 1 } } } } } };
    expect(JSON.stringify(sanitise(deep))).not.toContain("exitCode");
    expect(sanitise(null)).toEqual({});
    expect(sanitise(SECRET)).toEqual({});
    expect(sanitise(42)).toEqual({});
  });
  it("every payload key the usecase's forced destroys write survives (a key the list lacks never reaches the ledger — `staleAttempt` did not, Task 10 → lane-close sweep)", () => {
    // The keys stream-sessions.ts hands forceDestroy at its three sites, typed here from those call sites.
    const written = { machineId: "m1", staleAttempt: 1, machineName: "relay-x-r1", reason: "sweep" };
    expect(sanitise(written)).toEqual(written);
    expect(Object.keys(written).filter((k) => !ALLOWED_KEYS.has(k))).toEqual([]);
  });
  it("R2003b: a counted crash's runner_transition payload survives WHOLE — `crashCount` included (the payload is the REAL eventRowsOf's, never a typed copy)", () => {
    const live: Session = { id: "s1", fixtureId: "f1", orgId: "o1", mode: "composed", state: "live", desiredState: "live", failReason: null, endReason: null,
      runner: { ...RUNNER_NONE, state: "playing", attempt: 1, name: "relay-s1-r1", machineId: "m1" }, runnerRetries: 0, createdAt: new Date(0), startedAt: new Date(0),
      endedAt: null, heartbeatAt: new Date(0), beatWindowAt: null, endingAt: null, maxDurationMinutes: 300, outputUid: null, startCause: "organiser", warmingAt: null };
    const c: Command = { type: "runner", trigger: { type: "callback_crashed" } };
    const [row] = eventRowsOf(live, decide(live, c, new Date(1)), c).filter((r) => r.kind === "runner_transition");
    expect(row!.payload, "premise: the step counted a crash").toHaveProperty("crashCount", 1);
    expect(sanitise(row!.payload)).toEqual(row!.payload);
    expect(Object.keys(row!.payload).filter((k) => !ALLOWED_KEYS.has(k))).toEqual([]);
  });
  it("Owed 67: a counted restart's runner_transition payload survives WHOLE — `restartsCounted` included (the payload is the REAL eventRowsOf's, never a typed copy)", () => {
    const live: Session = { id: "s1", fixtureId: "f1", orgId: "o1", mode: "composed", state: "live", desiredState: "live", failReason: null, endReason: null,
      runner: { ...RUNNER_NONE, state: "playing", attempt: 1, name: "relay-s1-r1", machineId: "m1" }, runnerRetries: 0, createdAt: new Date(0), startedAt: new Date(0),
      endedAt: null, heartbeatAt: new Date(0), beatWindowAt: null, endingAt: null, maxDurationMinutes: 300, outputUid: null, startCause: "organiser", warmingAt: null };
    const c: Command = { type: "runner", trigger: { type: "callback_restarted" } };
    const [row] = eventRowsOf(live, decide(live, c, new Date(1)), c).filter((r) => r.kind === "runner_transition");
    expect(row!.payload, "premise: the step counted a restart").toHaveProperty("restartsCounted", 1);
    expect(sanitise(row!.payload)).toEqual(row!.payload);
    expect(Object.keys(row!.payload).filter((k) => !ALLOWED_KEYS.has(k))).toEqual([]);
  });
  it("capture QR v2 T6: the create action's pairingId and startCause survive — the operator start is traceable to the pairing that made it", () => {
    const written = { pairingId: "6f1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d", startCause: "operator", mode: "passthrough", targetId: "t1" };
    expect(sanitise(written)).toEqual(written);
    expect(Object.keys(written).filter((k) => !ALLOWED_KEYS.has(k))).toEqual([]);
  });
  it("R2004 review m4: `role` is kept — a create_live_input effect's payload says which input it made (camera or programme)", () => {
    expect(sanitise({ slot: 0, role: "programme" })).toEqual({ slot: 0, role: "programme" });
    expect(ALLOWED_KEYS.has("role")).toBe(true);
  });
  it("the allowlist holds no key that names a credential (the list is the guard; this pins it) — every key, the R2 beat's thirteen included", () => {
    let checked = 0;
    for (const k of ALLOWED_KEYS) {
      expect(k).not.toMatch(/key|secret|pass|token|auth|cookie|env/i);
      checked++;
    }
    expect(checked, "anti-vacuity: the whole list was read").toBe(ALLOWED_KEYS.size);
    // R2002 enlarged the list: the pin above covers the new keys only if they are IN it.
    expect(R2_BEAT_FIELDS.filter((k) => !ALLOWED_KEYS.has(k))).toEqual([]);
    expect(R2_BEAT_FIELDS).toHaveLength(13);
  });

  // R2002: ruling 13 keeps "the whole body in raw (sanitised)", and C14, C15 and C17 read the R2 fields there over time.
  // The expected key set is the BEAT CONTRACT's (RelayHeartbeat's declared fields and the contract's own heartbeat-full
  // vector), never the allowlist: a beat field added without its allowlist entry reds here, not in a post-match review.
  // R4 S8 (ruling R14) names the ONE exception, NOT_IN_RAW, and the test after this one proves it is kept out.
  it("R2002: every field the relay heartbeat declares survives into a sample's raw — the contract's full beat, unchanged — but R14's named exclusion", () => {
    const declared = Object.keys(RelayHeartbeat.shape).sort();
    expect(NOT_IN_RAW.filter((k) => !declared.includes(k)), "every exclusion names a field the beat declares").toEqual([]);
    const kept = declared.filter((k) => !NOT_IN_RAW.includes(k));
    expect(kept.length).toBeGreaterThan(R2_BEAT_FIELDS.length);
    // heartbeat-full carries every kept field but the final beat's two, which heartbeat-final-fatal carries (review M6).
    const full = { ...contractFixture("heartbeat-full"), ...contractFixture("heartbeat-final-fatal") };
    expect(Object.keys(full).sort(), "premise: the two beats carry every kept field").toEqual(kept);
    expect(sanitise(full)).toEqual(full);
    let checked = 0;
    for (const k of kept) {
      expect(ALLOWED_KEYS.has(k), k).toBe(true);
      checked++;
    }
    expect(checked).toBe(kept.length);
    for (const k of [...R2_BEAT_FIELDS, ...R4_BEAT_FIELDS]) expect(kept, k).toContain(k);
  });

  // R4 S8 (ruling R14): 64 proof-of-play items a beat must never put in a sample row. The usecase strips the list before
  // either beat store (stream-sessions.ts `heartbeat`; its DB test reads both stores back), and the allowlist is the floor
  // under that strip: neither the list nor any key only an item carries survives, while the overflow count beside it does.
  it("R4 S8 (R14): the airing list never survives into a sample's raw — the contract's airing beat loses that list and nothing else; airingsDropped is kept", () => {
    const beat = contractFixture("heartbeat-airings");
    const items = beat.airings as Record<string, unknown>[];
    expect(items.length, "premise: the vector carries items").toBeGreaterThan(0);
    const out = sanitise(beat);
    expect(out, "the list is dropped").not.toHaveProperty("airings");
    expect(out).toEqual(Object.fromEntries(Object.entries(beat).filter(([k]) => !NOT_IN_RAW.includes(k))));
    expect(out).toHaveProperty("airingsDropped", beat.airingsDropped);
    for (const k of NOT_IN_RAW) expect(ALLOWED_KEYS.has(k), k).toBe(false);
    // No item key that only an airing carries is on the list, so the items could not survive under another container.
    const itemOnly = [...new Set(items.flatMap((i) => Object.keys(i)))].filter((k) => !["at"].includes(k));
    expect(itemOnly.sort()).toEqual(["breakKind", "cardId", "cutShort", "kind", "momentId", "source", "style"]);
    expect(itemOnly.filter((k) => ALLOWED_KEYS.has(k))).toEqual([]);
  });

  it("R2002: `input` is now a kept key, so a composed session's input under it keeps its protocol and bare url — never its stream id or passphrase", () => {
    const { input } = contractFixture("session-composed-720p") as { input: Record<string, unknown> };
    expect(input, "premise: the vector carries both credentials").toMatchObject({ streamId: expect.any(String), passphrase: expect.any(String) });
    const out = sanitise({ input, output: { width: 1280, height: 720 } });
    expect(out).toEqual({ input: { protocol: "srt", url: input.url }, output: { width: 1280, height: 720 } });
    expect(JSON.stringify(out)).not.toContain(input.streamId as string);
    expect(JSON.stringify(out)).not.toContain(input.passphrase as string);
  });
});

describe("pathTemplate — a template, never a URL", () => {
  it("drops origin and query, replaces each given id with {id}, any residual uuid with {uuid}, any residual long-hex segment (a Fly machine id, a Cloudflare uid) with {id}", () => {
    const sid = "6f1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
    expect(pathTemplate(`https://api.machines.dev/v1/apps/relay/machines/abc123?x=${SECRET}`, ["abc123"])).toBe("/v1/apps/relay/machines/{id}");
    expect(pathTemplate(`/accounts/acct9/stream/live_inputs/in77/outputs`, ["acct9", "in77"])).toBe("/accounts/{id}/stream/live_inputs/{id}/outputs");
    expect(pathTemplate(`/x/${sid}/y`, [])).toBe("/x/{uuid}/y");
    expect(pathTemplate(`/v1/apps/relay/machines/3d8d9e4b1234ab/stop`, [])).toBe("/v1/apps/relay/machines/{id}/stop");
    expect(pathTemplate(`/stream/live_inputs/0123456789abcdef0123456789abcdef`, [])).toBe("/stream/live_inputs/{id}");
    // A short word that happens to be hex is NOT an id (the empty/short case): "cafe" stays.
    expect(pathTemplate(`/apps/cafe/machines`, [])).toBe("/apps/cafe/machines");
  });
  it("an empty id never matches (the empty case: '' would replace every position)", () => {
    expect(pathTemplate("/a/b", [""])).toBe("/a/b");
    // "/a/b" alone cannot witness the guard: it has no `//` and no trailing `/` for '' to hit, so it
    // passes with `if (!id) continue` deleted. These two can — unguarded, a trailing slash collapses
    // the whole path to "{id}" and a `//` becomes "/{id}/".
    expect(pathTemplate("/a/b/", [""])).toBe("/a/b/");
    expect(pathTemplate("/a//b", [""])).toBe("/a//b");
  });
});

// Review Q3 (defence in depth): the compositor redacts exitDetail before it sends it, and the server scrubs it again
// before EITHER store keeps it — the session's own secrets, anything JWT-shaped (every relay token is a JWT, and a
// fragment of one is still a credential), and everything from the first `?` (the cut samples.raw already made).
describe("scrubBeatText (R2002 review Q3)", () => {
  const JWT = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzaWQiOiJhYmMiLCJzY29wZSI6InJlbGF5LWpvYiJ9.c2lnbmF0dXJlLXBsYWNlaG9sZGVy";
  it("the empty case and a clean text are unchanged", () => {
    expect(scrubBeatText("", ["opaque-secret-0123456789"])).toBe("");
    expect(scrubBeatText("programme start failed: cefsrc not found", ["opaque-secret-0123456789"])).toBe("programme start failed: cefsrc not found");
    expect(scrubBeatText("no secrets given", [])).toBe("no secrets given");
  });
  it("redacts each named secret wherever it appears — even one that is not JWT-shaped", () => {
    const secret = "opaque-secret-0123456789";
    expect(scrubBeatText(`auth ${secret} refused; retried with ${secret}`, [secret])).toBe("auth [redacted] refused; retried with [redacted]");
  });
  it("a named JWT secret is redacted whole AND by each of its three parts — a signature-only fragment (not JWT-shaped) cannot survive", () => {
    const [header, payload, signature] = JWT.split(".") as [string, string, string];
    expect(signature, "premise: the signature alone is not JWT-shaped").not.toMatch(/^eyJ/);
    expect(scrubBeatText(`signature ${signature} rejected`, [JWT])).toBe("signature [redacted] rejected");
    // Each part on its own, and the whole token as ONE redaction (never three).
    let checked = 0;
    for (const part of [header, payload, signature]) {
      expect(scrubBeatText(`<${part}>`, [JWT]), part).toBe("<[redacted]>");
      checked++;
    }
    expect(checked).toBe(3);
    expect(scrubBeatText(`token ${JWT} end`, [JWT])).toBe("token [redacted] end");
    // The differential: with no secret named, the signature survives (it is the named secret's parts that catch it).
    expect(scrubBeatText(`signature ${signature} rejected`, [])).toBe(`signature ${signature} rejected`);
  });

  it("redacts a whole JWT, and a JWT FRAGMENT (a header and a cut payload) — no secret named", () => {
    expect(scrubBeatText(`token ${JWT} expired`, [])).toBe("token [redacted] expired");
    const fragment = JWT.slice(0, 60);
    expect(fragment.split(".")).toHaveLength(2);
    expect(scrubBeatText(`bad bearer ${fragment}`, [])).toBe("bad bearer [redacted]");
  });
  it("cuts at the first `?` — after redacting, so a secret before it is still redacted", () => {
    expect(scrubBeatText(`GET https://relay.example.test/v1/x?st=${JWT}&host=compositor failed`, [])).toBe("GET https://relay.example.test/v1/x");
    expect(scrubBeatText(`with ${JWT} at /a?b=1`, [])).toBe("with [redacted] at /a");
  });
  // R2004 review m1: a composed Machine also HOLDS the programme input's stream key and the camera's SRT playback
  // passphrase and stream id — and an RTMP(S) URL carries its key as the path segment after /live/ (Cloudflare) or
  // /live2/ (YouTube), which no secret list can know in advance.
  it("R2004 m1: cuts everything after the first /live/ — Cloudflare's RTMPS key path — and after /live2/ — YouTube's", () => {
    expect(scrubBeatText("publish to rtmps://live.cloudflare.com:443/live/9f3a1c0b7e2d4a6f8c1b3d5e7f9a0b2cka1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6 failed: EOF", []))
      .toBe("publish to rtmps://live.cloudflare.com:443/live/");
    expect(scrubBeatText("sink rtmp://a.rtmp.youtube.com/live2/abcd-efgh-ijkl-mnop-qrst refused", [])).toBe("sink rtmp://a.rtmp.youtube.com/live2/");
    // The FIRST of the two wins, whichever it is.
    expect(scrubBeatText("a /live2/k1 then /live/k2", [])).toBe("a /live2/");
    expect(scrubBeatText("a /live/k1 then /live2/k2", [])).toBe("a /live/");
    // The differential: a path that only LOOKS like one is left alone.
    expect(scrubBeatText("the /lives/ and /livestream/ pages", [])).toBe("the /lives/ and /livestream/ pages");
  });
  it("R2004 m1: redacts each composed credential the handler names — the programme stream key, the camera's SRT passphrase, its stream id — each one alone", () => {
    const KEY = "2c1b0a9f8e7d6c5b4a3f2e1d0c9b8a7fk9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3";
    const PASSPHRASE = "pp-4f3e2d1c0b9a8f7e6d5c";
    const STREAM_ID = "#!::r=fc0a8dc887b16759bfd9ad922230a014,m=request";
    let checked = 0;
    for (const [name, secret] of [["programme key", KEY], ["passphrase", PASSPHRASE], ["stream id", STREAM_ID]] as const) {
      const text = `srt read failed (${secret}) after 3 tries`;
      expect(scrubBeatText(text, ["job-token-not-here", KEY, PASSPHRASE, STREAM_ID]), name).toBe("srt read failed ([redacted]) after 3 tries");
      expect(scrubBeatText(text, ["job-token-not-here"]), `${name}: unnamed, it survives`).toBe(text);
      checked++;
    }
    expect(checked).toBe(3);
  });
  it("never lengthens a text (both stores keep the same text, under the beat's own bound), and is idempotent", () => {
    const secret = "opaque-secret-0123456789";
    const cases = [`x ${secret}`, `y ${JWT}`, `z ${JWT.slice(0, 11)}`, "short eyJabc", "plain", `/p?q=${secret}`, "rtmps://h/live/k", "rtmp://h/live2/k /live/j"];
    let checked = 0;
    for (const text of cases) {
      const once = scrubBeatText(text, [secret]);
      expect(once.length, text).toBeLessThanOrEqual(text.length);
      expect(scrubBeatText(once, [secret]), text).toBe(once);
      expect(sanitise({ exitDetail: once }), "samples.raw keeps it as is").toEqual({ exitDetail: once });
      checked++;
    }
    expect(checked).toBe(cases.length);
    // A too-short "secret" is never used as a pattern: it would redact ordinary words.
    expect(scrubBeatText("the end", ["e"])).toBe("the end");
  });
});
