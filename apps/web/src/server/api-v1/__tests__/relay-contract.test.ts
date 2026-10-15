// The relay-job.v1 web↔compositor contract (compositor spec 2026-10-14 §5.3; R2002).
//
// docs/contracts/relay-job.v1.json is the cross-repo authority: the compositor vendors it byte for byte (C07). Its zod
// twins are RelayJobSession, RelayHeartbeat, RelayHeartbeatReply, RelayPhaseReply and RelayPhaseEndpoint (schemas.ts).
// This file pins:
//   * the file's sha256 — a change is a deliberate bump that moves the constant in the same commit, and C07 re-vendors;
//   * the BARE root: only $schema, $id, title, description and $defs {session, heartbeat, heartbeatReply, phaseReply,
//     phaseEndpoint} — no schema twin at the root (the one way this file differs from the capture contracts). C07
//     validates against #/$defs/<name>;
//   * parity, each $def ↔ z.toJSONSchema of its twin (both directions for the four strict shapes);
//   * every hand-written fixture: a named one is admitted, an `*-invalid-*` one refused — by the twin AND by the published
//     bytes under ajv; a `*-refused-*` one is admitted by the bytes and refused by the twin, on the overlayUrl `delay=`
//     rule the file states in prose (JSON Schema cannot state it);
//   * the composed sessions: overlayUrl carries exactly one `delay=` equal to overlayDelayMs (owner, 2026-10-15; C07
//     refuses a session where it is absent or differs), the output profiles of the compositor's Global Constraints, the
//     spec's heartbeat interval; the passthrough session carries none of the composed-only keys;
//   * the beat's vocabularies, typed here from the compositor's own declarations, against the file and the twin;
//   * optional-versus-null and absent-versus-zero for every field R2 adds to the beat;
//   * R2007 PR B: the programme phase's `final` (C06's final hold), the beat's phaseChannel, and the loopback phase
//     endpoint's reply and constants (overlay templates spec 2026-10-15 §4.3), typed here from the plan's declarations.
// Every sweep counts what it checked, and the counts are pinned: a skipped fixture, field or def fails the run.
//
// Pure — no DB. No sport: the relay is sport-agnostic, nothing on this contract reads one.
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import * as S from "../schemas";
import { PHASE_CHANNELS, PROGRAMME_PHASES, RELAY_PHASE_LONG_POLL_MAX_MS, RELAY_PHASE_PATH, RELAY_PHASE_PORT } from "@/lib/relay-phase";

type Json = Record<string, unknown>;
type Twin = z.ZodType;

const CONTRACTS = resolve(import.meta.dirname, "../../../../../../docs/contracts");
const FILE = "relay-job.v1.json";
const DIR = "relay-job.v1";
const FIXTURES = resolve(CONTRACTS, "fixtures", DIR);
const contractText = (): string => readFileSync(resolve(CONTRACTS, FILE), "utf8");
const contract = (): Json => JSON.parse(contractText()) as Json;
const fixture = (name: string): Json => JSON.parse(readFileSync(resolve(FIXTURES, `${name}.json`), "utf8")) as Json;
const parses = (twin: Twin, value: unknown): boolean => twin.safeParse(value).success;

/** `shasum -a 256 docs/contracts/relay-job.v1.json`. A contract change is a DELIBERATE bump: it moves this constant in
 *  the same commit, and the compositor re-vendors the file (C07's pin moves with it). */
const SHA256 = "b69867cbcd077cf187d9a75768db8ca0072552e80e5323eff39e0cdf8f178f74";

// ---------------------------------------------------------------------------------------------------------------
// The rulebook, typed from the compositor's declarations — never read off the twin.
// ---------------------------------------------------------------------------------------------------------------
/** Each $def and its twin, exactly. */
const DEFS: Record<string, Twin> = {
  session: S.RelayJobSession, heartbeat: S.RelayHeartbeat, heartbeatReply: S.RelayHeartbeatReply,
  // R2007 PR B: the compositor's loopback phase endpoint — its reply, and where it listens.
  phaseReply: S.RelayPhaseReply, phaseEndpoint: S.RelayPhaseEndpoint,
};
/** The shapes a reader must refuse an unknown key on (input mode publishes `additionalProperties: false` for each). */
const STRICT_DEFS = ["session", "heartbeat", "phaseReply", "phaseEndpoint"];
/** Spec §5.3's beat, as C07's `heartbeat_wire` writes the compositor's enums (C06 health.rs `BeatState`, `LinkStatus`,
 *  `GraphicsStatus`; C03 `ProgrammePhase`; C05 `Rung`): lower-case words, the rung in snake_case. */
const SPEC_BEAT: Record<string, string[]> = {
  state: ["starting", "playing", "stalled", "stopped"],
  // C03 `ProgrammePhase`, plus C06's final hold (overlay templates spec 2026-10-15 §4.2, §6 R2002 row; R2007 PR B):
  // `final` is sent during the hold AND on the final exit beat (owner ruling 2026-10-15).
  programmePhase: ["waiting", "live", "frozen", "reconnecting", "final"],
  input: ["connecting", "connected", "backoff"],
  output: ["connecting", "connected", "backoff"],
  graphics: ["starting", "ready", "restarting", "failed"],
  rung: ["full", "overlay_half_rate", "fast_preset"],
  // The final beat's why (owner scope addition 2026-10-15): C06 lifecycle.rs `ExitReason { Ended, Deadline, Signalled,
  // SessionGone, Refused, Fatal }`, snake_case on the wire.
  exitReason: ["ended", "deadline", "signalled", "session_gone", "refused", "fatal"],
  // Overlay templates spec 2026-10-15 §4.3 (D10): the page reads its phase from the compositor's loopback endpoint (A),
  // or from this beat through its data poll (B, `web`); R2005 reports which one is live.
  phaseChannel: ["loopback", "web"],
};
/** The plan's phase endpoint (compositor `_INDEX.md` 2026-10-15: "`127.0.0.1:7419` `GET /phase?after=<seq>`, long-poll
 *  ≤ 10 s"; spec §4.3 "held ≤ 10 s"). */
const PLAN_PHASE_ENDPOINT = { port: 7419, path: "/phase", longPollMaxMs: 10_000 };
/** The brief's rule for that port: unprivileged, and below Linux's default ephemeral range (32768–60999). */
const PRIVILEGED_MAX = 1023, EPHEMERAL_MIN = 32768;
/** The fields R2 adds to the beat (spec §5.3; C06 `HealthReport`; C07 `heartbeat_wire`). Every one optional and
 *  nullable: a compositor OMITS what it did not measure, never sends 0 (Global Constraints, "Heartbeat"). */
const ADDED = ["programmePhase", "input", "output", "graphics", "inputKicks", "inputKickAlert", "pipelineRebuilds", "sinkSwaps", "rung", "scoreStale",
  // owner scope addition 2026-10-15: the final beat carries the exit reason.
  "exitReason", "exitDetail",
  // R2007 PR B (overlay templates spec 2026-10-15 §4.3): the channel the overlay page reads its phase from.
  "phaseChannel"];
/** Owner scope addition 2026-10-15: "exitDetail: z.string().max(200)" — compositor-redacted human text. zod's max counts
 *  UTF-16 code units (JS string length). */
const EXIT_DETAIL_MAX = 200;
/** JSON Schema's maxLength counts CODE POINTS (RFC 8259 characters; ajv, and C07's validator). A code point is at most
 *  2 UTF-16 units (Unicode §3.9), so the bound under which ANY text fits zod's 200 units is 200 / 2. The file publishes
 *  that bound: it is never looser than the twin (review M1 — 150 emoji passed the file and 400'd on the server). */
const EXIT_DETAIL_FILE_MAX = EXIT_DETAIL_MAX / 2;
/** The final beat's fields (owner scope addition 2026-10-15), carried only with `state: "stopped"` (review M6). */
const EXIT_FIELDS = ["exitReason", "exitDetail"];
/** That rule in JSON Schema (confirm pass, minor 1: the file must not be looser than the twin): IF either exit field is
 *  present and not null, THEN state is "stopped". Typed here from the rule, never read off the generator. */
const STOPPED_ONLY = {
  if: {
    type: "object",
    anyOf: EXIT_FIELDS.map((f) => ({ type: "object", required: [f], properties: { [f]: { not: { type: "null" } } } })),
  },
  then: { type: "object", properties: { state: { const: "stopped" } } },
};
/** C06 `HealthReport`: `input_kicks: u32`, `pipeline_rebuilds: u64`, `sink_swaps: u64` — whole and non-negative. */
const COUNTERS = ["inputKicks", "pipelineRebuilds", "sinkSwaps"];
/** C06 `HealthReport`: `input_kick_alert: bool`, `score_stale: Option<bool>`. */
const FLAGS = ["inputKickAlert", "scoreStale"];
/** Global Constraints "Output" (compositor ADR 0005): 720p30 by default, 1080p30 behind a flag. */
const PROFILES: Record<string, Json> = {
  "720p": { width: 1280, height: 720, fps: 30, videoKbps: 4000 },
  "1080p": { width: 1920, height: 1080, fps: 30, videoKbps: 6000 },
};
/** Spec §5.3: "`heartbeatIntervalMs`: 5000". */
const SPEC_HEARTBEAT_INTERVAL_MS = 5000;
/** Spec §5.3: what a composed session adds to today's shape (R2004 serves them). `target` is in both modes. */
const COMPOSED_ONLY = ["input", "output", "heartbeatIntervalMs", "overlayUrl"];
/** R2004 decision 5: `${APP_URL}/overlay/fixtures/${fixtureId}?sid=${sessionId}&st=${pageToken}&host=compositor&delay=${overlayDelayMs}`. */
const OVERLAY_PATH = (fixtureId: string) => `/overlay/fixtures/${fixtureId}`;

/** Per fixture prefix: its $def, its twin and the exact count (never 0). First match wins. */
const ROUTES: [prefix: string, def: string, count: number][] = [
  ["session-", "session", 6],
  ["heartbeat-", "heartbeat", 9],
  ["reply-", "heartbeatReply", 2],
  // R2007 PR B: the compositor's loopback reply (never "reply-": that prefix is the web heartbeat's 200).
  ["phase-reply-", "phaseReply", 2],
];
/** The `*-refused-*` fixtures: admitted by the published bytes, refused by the twin on ONE field, each a one-field
 *  edit of `sibling`. The rule is the overlayUrl `delay=` agreement, which the file states in this field's prose. */
const REFUSED: Record<string, { def: string; sibling: string; field: string; issueAt: string[] }> = {
  "session-refused-delay-mismatch": { def: "session", sibling: "session-composed-720p", field: "overlayDelayMs", issueAt: ["overlayUrl"] },
  "session-refused-delay-absent": { def: "session", sibling: "session-composed-720p", field: "overlayUrl", issueAt: ["overlayUrl"] },
};

// ---------------------------------------------------------------------------------------------------------------
// Structural helpers (capture-contract.test.ts's, for the same reasons).
// ---------------------------------------------------------------------------------------------------------------
const PROSE = new Set(["$schema", "$id", "title", "description"]);
const unescapeSlashes = (pattern: string): string => pattern.replace(/(?<!\\)((?:\\\\)*)\\\//g, "$1/");
/** Drops the prose keys at every level (never a property NAMED like one), sorts `required` and `enum`. */
function normalise(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(normalise);
  if (node === null || typeof node !== "object") return node;
  const out: Json = {};
  for (const [k, v] of Object.entries(node as Json)) {
    if (PROSE.has(k)) continue;
    if (k === "properties") out[k] = Object.fromEntries(Object.entries(v as Json).map(([p, s]) => [p, normalise(s)]));
    else if ((k === "required" || k === "enum") && Array.isArray(v)) out[k] = [...(v as string[])].sort();
    else if (k === "pattern" && typeof v === "string") out[k] = unescapeSlashes(v);
    else out[k] = normalise(v);
  }
  return out;
}
/** z.toJSONSchema of a twin, its `$schema` dropped (a $def carries none; the file's root does). */
const zodJson = (twin: Twin, io: "output" | "input"): Json => {
  const out = { ...(z.toJSONSchema(twin, { target: "draft-2020-12", io }) as Json) };
  delete out.$schema;
  return out;
};
const defOf = (file: Json, name: string): Json => (file.$defs as Record<string, Json>)[name]!;
/** The ONE place the file deliberately differs from z.toJSONSchema (review M1): exitDetail's string bound, published in
 *  code points as EXIT_DETAIL_FILE_MAX. The twin's own bound is asserted first, so a change to it still fails parity. */
function asPublished(def: string, json: Json): Json {
  if (def !== "heartbeat") return json;
  const out = JSON.parse(JSON.stringify(json)) as Json;
  const strings = ((propOf(out, "exitDetail").anyOf as Json[] | undefined) ?? []).filter((b) => b.type === "string");
  expect(strings, "the twin publishes one string branch for exitDetail").toHaveLength(1);
  expect(strings[0]!.maxLength, "the twin's bound, in UTF-16 units").toBe(EXIT_DETAIL_MAX);
  strings[0]!.maxLength = EXIT_DETAIL_FILE_MAX;
  // …and the stopped-only rule (confirm pass, minor 1), which z.toJSONSchema cannot emit from a refinement.
  expect(out.if, "the twin publishes no if/then of its own").toBeUndefined();
  Object.assign(out, STOPPED_ONLY);
  return out;
}
const propOf = (node: Json, name: string): Json => (node.properties as Record<string, Json>)[name]!;
/** A node's closed values, sorted: its `enum`, its `const`, or its anyOf members' — `null` dropped. */
function enumOf(node: Json): string[] {
  const own = node.enum !== undefined ? (node.enum as unknown[]) : node.const !== undefined ? [node.const] : [];
  const members = ((node.anyOf as Json[] | undefined) ?? []).flatMap(enumOf);
  return [...own, ...members].filter((v) => v !== null).map(String).sort();
}
/** Whether a property node admits JSON null (zod's `.nullable()` publishes an anyOf with `{type: "null"}`). */
const admitsNull = (node: Json): boolean =>
  node.type === "null" || (Array.isArray(node.type) && node.type.includes("null")) || ((node.anyOf as Json[] | undefined) ?? []).some(admitsNull);

/** The published bytes as a validator sees them: ajv 2020-12, strict, formats ASSERTED (uuid, uri) — the stricter of
 *  the two readings a vendoring repo may take, so a fixture the file admits only with formats off fails. */
function fileValidator(): (def: string, value: unknown) => boolean {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  ajv.addSchema(contract());
  return (def, value) => {
    const validate = ajv.getSchema(`https://seazn.club/contracts/${FILE}#/$defs/${def}`);
    expect(validate, `${FILE}#/$defs/${def}: ajv resolves the shape`).toBeDefined();
    return validate!(value) as boolean;
  };
}
const fixtureNames = (): string[] =>
  readdirSync(FIXTURES).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -".json".length)).sort();

describe("the relay-job.v1 contract (docs/contracts/relay-job.v1.json)", () => {
  it("is checksummed (the cross-repo drift gate), and it is the only relay contract, with one fixture directory", () => {
    expect(createHash("sha256").update(contractText()).digest("hex")).toBe(SHA256);
    expect(readdirSync(CONTRACTS).filter((f) => f.startsWith("relay-"))).toEqual([FILE]);
    expect(readdirSync(resolve(CONTRACTS, "fixtures")).filter((f) => f.startsWith("relay-"))).toEqual([DIR]);
  });

  it("the root is BARE — $schema, $id, title, description and $defs {session, heartbeat, heartbeatReply, phaseReply, phaseEndpoint}; no schema twin at the root", () => {
    const file = contract();
    expect(Object.keys(file).sort()).toEqual(["$defs", "$id", "$schema", "description", "title"]);
    expect(file.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(file.$id).toBe(`https://seazn.club/contracts/${FILE}`);
    expect(Object.keys(file.$defs as Json).sort()).toEqual(Object.keys(DEFS).sort());
    // Every def describes itself, and so does the root: the prose is the half of the contract JSON Schema cannot state.
    let described = 0;
    for (const name of Object.keys(DEFS)) {
      expect(typeof defOf(file, name).description, name).toBe("string");
      described++;
    }
    expect(described).toBe(5);
    expect(typeof file.description).toBe("string");
  });

  it("parity: each $def equals z.toJSONSchema of its twin; the four strict shapes in BOTH directions (a stripping object differs in input mode)", () => {
    const file = contract();
    let checked = 0;
    for (const [name, twin] of Object.entries(DEFS)) {
      expect(normalise(defOf(file, name)), `${name} (output)`).toEqual(normalise(asPublished(name, zodJson(twin, "output"))));
      checked++;
    }
    // The beat (a request) and the session (a response C07 refuses to improvise on) are STRICT: input mode publishes
    // `additionalProperties: false` only for a strict object, so equality there proves the twin refuses unknown keys.
    // The reply is the web's own output (it never parses one), so output mode is its wire shape.
    for (const name of STRICT_DEFS) {
      expect(normalise(defOf(file, name)), `${name} (input)`).toEqual(normalise(asPublished(name, zodJson(DEFS[name]!, "input"))));
      expect(defOf(file, name).additionalProperties, `${name} is closed`).toBe(false);
      checked++;
    }
    expect(checked).toBe(5 + 4);
  });

  it("fixtures: a named one is admitted, an `*-invalid-*` one refused — by the twin AND the published bytes under ajv; a `*-refused-*` one only by the twin — counted per shape", () => {
    const fileAdmits = fileValidator();
    const names = fixtureNames();
    const counted: Record<string, number> = {};
    let refusedSeen = 0;
    for (const name of names) {
      const route = ROUTES.find(([prefix]) => name.startsWith(prefix));
      expect(route, `${name}: no $def routes this fixture`).toBeDefined();
      const [prefix, def] = route!;
      const kind = name.slice(prefix.length);
      const value = fixture(name);
      const twin = DEFS[def]!;
      if (kind.startsWith("invalid-")) {
        expect(parses(twin, value), `${name}: the twin refuses it`).toBe(false);
        expect(fileAdmits(def, value), `${name}: the file refuses it`).toBe(false);
      } else if (kind.startsWith("refused-")) {
        expect(name in REFUSED, `${name}: a refused-* fixture is listed in REFUSED`).toBe(true);
        expect(parses(twin, value), `${name}: the twin refuses it`).toBe(false);
        expect(fileAdmits(def, value), `${name}: the file states this rule in prose only, so ajv admits it`).toBe(true);
        refusedSeen++;
      } else {
        const result = twin.safeParse(value);
        expect(result.success, `${name}: the twin admits it — ${JSON.stringify(result.error?.issues)}`).toBe(true);
        expect(fileAdmits(def, value), `${name}: the file admits it`).toBe(true);
      }
      counted[prefix] = (counted[prefix] ?? 0) + 1;
    }
    let total = 0;
    for (const [prefix, , count] of ROUTES) {
      expect(counted[prefix] ?? 0, `${prefix}*: fixtures checked`).toBe(count);
      total += count;
    }
    expect(names.length, "every fixture was routed").toBe(total);
    expect(total).toBe(19);
    // Every REFUSED entry names a fixture that exists and was swept (a stale entry would excuse nothing, silently).
    expect(refusedSeen).toBe(Object.keys(REFUSED).length);
    expect(refusedSeen).toBe(2);
  });

  it("the brief's nine fixtures exist by name, and the README states the absent-versus-zero convention", () => {
    const named = [
      "session-passthrough", "session-composed-720p", "session-composed-1080p", "heartbeat-minimal", "heartbeat-full",
      "heartbeat-zero-is-a-measurement", "heartbeat-invalid-unknown-field", "reply-live", "reply-ending",
    ];
    let found = 0;
    for (const name of named) {
      expect(existsSync(resolve(FIXTURES, `${name}.json`)), name).toBe(true);
      found++;
    }
    expect(found).toBe(9);
    // The owner's scope addition (2026-10-15): the final fatal beat, and an exit reason outside C06's vocabulary.
    for (const name of ["heartbeat-final-fatal", "heartbeat-invalid-exit-reason", "heartbeat-invalid-exit-while-playing"]) expect(existsSync(resolve(FIXTURES, `${name}.json`)), name).toBe(true);
    expect(fixture("heartbeat-final-fatal")).toEqual({ state: "stopped", exitReason: "fatal", exitDetail: "programme start failed: cefsrc not found" });
    expect(fixture("heartbeat-invalid-exit-reason")).toMatchObject({ exitReason: "crashed" });
    // R2007 PR B's four, by name and content: the final hold on the primary channel; a channel outside the two words (a
    // one-field edit of the hold, so its refusal is that field's alone); the loopback reply in `final`, and one with a
    // key the strict reply refuses.
    let r2007 = 0;
    for (const name of ["heartbeat-final-hold", "heartbeat-invalid-phase-channel", "phase-reply-final", "phase-reply-invalid-unknown-field"]) {
      expect(existsSync(resolve(FIXTURES, `${name}.json`)), name).toBe(true);
      r2007++;
    }
    expect(r2007).toBe(4);
    expect(fixture("heartbeat-final-hold")).toEqual({ state: "playing", programmePhase: "final", phaseChannel: "loopback" });
    expect(fixture("heartbeat-invalid-phase-channel")).toEqual({ ...fixture("heartbeat-final-hold"), phaseChannel: "wifi" });
    expect(fixture("phase-reply-final")).toEqual({ phase: "final", seq: 5 });
    expect(Object.keys(fixture("phase-reply-invalid-unknown-field")).filter((k) => !(k in fixture("phase-reply-final"))), "one key the reply does not declare").toHaveLength(1);
    const readme = readFileSync(resolve(FIXTURES, "README.md"), "utf8");
    expect(readme).toContain("a present 0 is a measured zero");
    expect(readme).toContain("never sent as 0");
  });

  it("the overlayUrl `delay=` rule: every composed session carries exactly one, equal to overlayDelayMs; each refused vector breaks it ONE way and the twin names that field alone; the file states the rule", () => {
    let composed = 0;
    for (const name of fixtureNames().filter((n) => n.startsWith("session-composed-"))) {
      const s = fixture(name);
      const delays = new URL(s.overlayUrl as string).searchParams.getAll("delay");
      expect(delays, `${name}: exactly one delay=`).toHaveLength(1);
      expect(delays[0], `${name}: delay= is overlayDelayMs`).toBe(String(s.overlayDelayMs));
      composed++;
    }
    expect(composed).toBe(2);
    // Two delays that DIFFER across the fixtures, so the rule cannot be met by one constant written into both.
    expect(fixture("session-composed-720p").overlayDelayMs).not.toBe(fixture("session-composed-1080p").overlayDelayMs);

    let refused = 0;
    for (const [name, { def, sibling, field, issueAt }] of Object.entries(REFUSED)) {
      const bad = fixture(name), good = fixture(sibling);
      const twin = DEFS[def]!;
      const differing = [...new Set([...Object.keys(bad), ...Object.keys(good)])].filter((k) => JSON.stringify(bad[k]) !== JSON.stringify(good[k]));
      expect(differing, `${name}: premise — differs from ${sibling} in ${field} alone`).toEqual([field]);
      expect(parses(twin, good), `${name}: premise — ${sibling} parses`).toBe(true);
      const result = twin.safeParse(bad);
      expect(result.success, `${name}: the twin refuses it`).toBe(false);
      // Exactly the rule's issues, at the rule's fields: the refusal is that rule, not some other guard.
      expect(result.error?.issues.map((i) => i.path.join(".")), name).toEqual(issueAt);
      refused++;
    }
    expect(refused).toBe(2);
    // A repeated delay= is refused too, even when one copy agrees: two authorities in one URL are not one.
    const twice = { ...fixture("session-composed-720p") };
    twice.overlayUrl = `${twice.overlayUrl as string}&delay=${twice.overlayDelayMs as number}`;
    expect(parses(S.RelayJobSession, twice), "delay= twice").toBe(false);
    // The positive pair on the same edit path: the untouched sibling parses, and 0 is a real delay (never "unset").
    const zero: Json = { ...fixture("session-composed-720p"), overlayDelayMs: 0 };
    zero.overlayUrl = (zero.overlayUrl as string).replace(/delay=\d+$/, "delay=0");
    expect(new URL(zero.overlayUrl as string).searchParams.get("delay")).toBe("0");
    expect(parses(S.RelayJobSession, zero), "delay=0 with overlayDelayMs 0").toBe(true);

    const prose = propOf(defOf(contract(), "session"), "overlayUrl").description as string;
    expect(prose).toContain("delay=");
    expect(prose).toContain("exactly once");
    expect(propOf(defOf(contract(), "session"), "overlayDelayMs").description as string).toContain("must agree");
  });

  it("the composed sessions: every composed-only key, the Global Constraints' output profile, the spec's heartbeat interval and R2004's overlay URL; the passthrough session carries none of them", () => {
    let checked = 0;
    for (const [profile, want] of Object.entries(PROFILES)) {
      const s = fixture(`session-composed-${profile}`);
      expect(s.mode).toBe("composed");
      for (const key of COMPOSED_ONLY) expect(s, `${profile}: ${key}`).toHaveProperty(key);
      expect(s.output, `${profile}: output`).toEqual(want);
      expect(s.heartbeatIntervalMs).toBe(SPEC_HEARTBEAT_INTERVAL_MS);
      expect((s.input as Json).protocol).toBe("srt");
      const url = new URL(s.overlayUrl as string);
      expect(url.pathname).toBe(OVERLAY_PATH(s.fixtureId as string));
      expect(url.searchParams.get("sid")).toBe(s.sessionId);
      expect(url.searchParams.get("st")).toBe(s.pageToken);
      expect(url.searchParams.get("host")).toBe("compositor");
      checked++;
    }
    expect(checked).toBe(2);
    const p = fixture("session-passthrough");
    expect(p.mode).toBe("passthrough");
    let absent = 0;
    for (const key of COMPOSED_ONLY) {
      expect(p, `passthrough: ${key}`).not.toHaveProperty(key);
      absent++;
    }
    expect(absent).toBe(COMPOSED_ONLY.length);
    // The positive pair: the passthrough session IS a session — the twin and the file admit it.
    expect(parses(S.RelayJobSession, p)).toBe(true);
  });

  it("the beat's closed vocabularies equal the compositor's declarations, in the file AND the twin (each word admitted, an outsider refused)", () => {
    const beat = defOf(contract(), "heartbeat");
    let words = 0;
    for (const [field, spec] of Object.entries(SPEC_BEAT)) {
      expect(enumOf(propOf(beat, field)), `${field}: the file`).toEqual([...spec].sort());
      for (const word of spec) {
        const body = field === "state" ? { state: word } : { state: EXIT_FIELDS.includes(field) ? "stopped" : "playing", [field]: word };
        expect(parses(S.RelayHeartbeat, body), `${field}=${word}`).toBe(true);
        words++;
      }
      const outsider = field === "state" ? { state: "healthy" } : { state: EXIT_FIELDS.includes(field) ? "stopped" : "playing", [field]: "Live" };
      expect(parses(S.RelayHeartbeat, outsider), `${field}: an outsider`).toBe(false);
    }
    expect(words).toBe(4 + 5 + 3 + 3 + 4 + 3 + 6 + 2);
  });

  it("optional-versus-null and absent-versus-zero: each field R2 adds is optional and nullable (file and twin); counters are whole and non-negative, a present 0 admitted; only `state` is required", () => {
    const beat = defOf(contract(), "heartbeat");
    expect(beat.required).toEqual(["state"]);
    let checked = 0;
    for (const field of ADDED) {
      const node = propOf(beat, field);
      expect(node, `${field}: declared in the file`).toBeDefined();
      expect(admitsNull(node), `${field}: the file admits null`).toBe(true);
      expect(parses(S.RelayHeartbeat, { state: "playing", [field]: null }), `${field}: the twin admits null`).toBe(true);
      checked++;
    }
    expect(checked).toBe(13);
    // exitDetail's bound: the twin's 200 UTF-16 units, the file's 100 code points (review M1). Each refuses one past its
    // own bound, and a longer one is refused, never cut by the server.
    const fileAdmits = fileValidator();
    const at = (text: string) => ({ state: "stopped", exitReason: "fatal", exitDetail: text });
    expect(propOf(beat, "exitDetail").anyOf, "the file states its bound").toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "string", maxLength: EXIT_DETAIL_FILE_MAX })]));
    expect(parses(S.RelayHeartbeat, at("x".repeat(EXIT_DETAIL_MAX))), "the twin: 200 units").toBe(true);
    expect(parses(S.RelayHeartbeat, at("x".repeat(EXIT_DETAIL_MAX + 1))), "the twin: 201 units").toBe(false);
    expect(fileAdmits("heartbeat", at("x".repeat(EXIT_DETAIL_FILE_MAX))), "the file: 100 characters").toBe(true);
    expect(fileAdmits("heartbeat", at("x".repeat(EXIT_DETAIL_FILE_MAX + 1))), "the file: 101 characters").toBe(false);
    const prose = propOf(beat, "exitDetail").description as string;
    expect(prose).toContain("200 UTF-16 code units");
    expect(prose).toContain(`${EXIT_DETAIL_FILE_MAX} characters`);
    let counters = 0;
    for (const field of COUNTERS) {
      // 0 is a measured zero: admitted. A negative or fractional count measured nothing real: refused.
      expect(parses(S.RelayHeartbeat, { state: "playing", [field]: 0 }), `${field}=0`).toBe(true);
      expect(parses(S.RelayHeartbeat, { state: "playing", [field]: 7 }), `${field}=7`).toBe(true);
      expect(parses(S.RelayHeartbeat, { state: "playing", [field]: -1 }), `${field}=-1`).toBe(false);
      expect(parses(S.RelayHeartbeat, { state: "playing", [field]: 1.5 }), `${field}=1.5`).toBe(false);
      counters++;
    }
    expect(counters).toBe(3);
    let flags = 0;
    for (const field of FLAGS) {
      expect(parses(S.RelayHeartbeat, { state: "playing", [field]: false }), `${field}=false`).toBe(true);
      expect(parses(S.RelayHeartbeat, { state: "playing", [field]: "true" }), `${field}="true"`).toBe(false);
      flags++;
    }
    expect(flags).toBe(2);
    // The two beat fixtures that document the convention say what they claim: the minimal beat carries `state` and
    // nothing else, and the zero beat carries fps as a PRESENT 0.
    expect(Object.keys(fixture("heartbeat-minimal"))).toEqual(["state"]);
    const zero = fixture("heartbeat-zero-is-a-measurement");
    expect(zero).toHaveProperty("fps", 0);
    // heartbeat-full carries every field the twin declares but the final beat's two; heartbeat-final-fatal carries those
    // (review M6). Between them the route tests round-trip every declared field.
    const declared = Object.keys(S.RelayHeartbeat.shape).sort();
    expect(Object.keys(fixture("heartbeat-full")).sort()).toEqual(declared.filter((k) => !EXIT_FIELDS.includes(k)));
    expect(Object.keys(fixture("heartbeat-final-fatal")).sort()).toEqual(["state", ...EXIT_FIELDS].sort());
  });

  it("review M1: the file is never looser than the twin on exitDetail — 150 emoji are refused by BOTH, 100 admitted by both, and every text the file admits the twin admits (counted)", () => {
    const fileAdmits = fileValidator();
    const at = (text: string) => ({ state: "stopped", exitReason: "fatal", exitDetail: text });
    const emoji = "\u{1F3C6}";   // one code point, two UTF-16 units
    expect([...emoji]).toHaveLength(1);
    expect(emoji).toHaveLength(2);
    // The reviewer's case: 150 code points (under a code-point 200) but 300 units — refused by both, never split.
    expect(parses(S.RelayHeartbeat, at(emoji.repeat(150))), "the twin: 150 emoji").toBe(false);
    expect(fileAdmits("heartbeat", at(emoji.repeat(150))), "the file: 150 emoji").toBe(false);
    // The positive pair: 100 emoji = 100 code points = 200 units, admitted by both.
    expect(parses(S.RelayHeartbeat, at(emoji.repeat(100))), "the twin: 100 emoji").toBe(true);
    expect(fileAdmits("heartbeat", at(emoji.repeat(100))), "the file: 100 emoji").toBe(true);
    // The sweep: ASCII, astral and mixed texts either side of both bounds. The file admitting one the twin refuses is
    // the defect (a C07-valid final beat that 400s); the reverse is the deliberate margin.
    const texts: string[] = [];
    for (const n of [0, 1, 99, 100, 101, 150, 199, 200, 201]) {
      texts.push("x".repeat(n), emoji.repeat(n), (emoji + "x").repeat(Math.ceil(n / 2)).slice(0, n));
    }
    let fileAdmitted = 0;
    for (const text of texts) {
      if (fileAdmits("heartbeat", at(text))) {
        expect(parses(S.RelayHeartbeat, at(text)), `file-admitted text of ${text.length} units`).toBe(true);
        fileAdmitted++;
      }
    }
    expect(texts).toHaveLength(27);
    expect(fileAdmitted, "anti-vacuity: the file admitted some of them").toBeGreaterThan(0);
    expect(fileAdmitted, "and refused some").toBeLessThan(texts.length);
  });

  it("review M6: an exit reason or detail rides only on a STOPPED beat — every other state refuses either field (at that field), in the twin AND the file; null is no report", () => {
    const fileAdmits = fileValidator();
    let refused = 0;
    for (const state of SPEC_BEAT.state!.filter((w) => w !== "stopped")) {
      for (const field of EXIT_FIELDS) {
        const value = field === "exitReason" ? "fatal" : "programme start failed";
        const result = S.RelayHeartbeat.safeParse({ state, [field]: value });
        expect(result.success, `${state} + ${field}`).toBe(false);
        expect(result.error?.issues.map((i) => i.path.join(".")), `${state} + ${field}`).toEqual([field]);
        expect(fileAdmits("heartbeat", { state, [field]: value }), `the file: ${state} + ${field}`).toBe(false);
        refused++;
      }
      // null is "not reported" (the field is nullish), never an exit report.
      expect(parses(S.RelayHeartbeat, { state, exitReason: null, exitDetail: null }), `${state} + nulls`).toBe(true);
      expect(fileAdmits("heartbeat", { state, exitReason: null, exitDetail: null }), `the file: ${state} + nulls`).toBe(true);
      expect(fileAdmits("heartbeat", { state }), `the file: ${state} alone`).toBe(true);
    }
    expect(refused).toBe(3 * 2);
    // The positive pair: the same fields on a stopped beat, together and apart — the twin and the file.
    let admitted = 0;
    for (const beat of [{ state: "stopped", exitReason: "ended" }, { state: "stopped", exitDetail: "drained" }, { state: "stopped" }, { state: "stopped", exitReason: "fatal", exitDetail: "x" }]) {
      expect(parses(S.RelayHeartbeat, beat), JSON.stringify(beat)).toBe(true);
      expect(fileAdmits("heartbeat", beat), `the file: ${JSON.stringify(beat)}`).toBe(true);
      admitted++;
    }
    expect(admitted).toBe(4);
    expect(propOf(defOf(contract(), "heartbeat"), "exitReason").description as string).toContain("only with `state: \"stopped\"`");
  });

  it("the composed input's url is bare (srt://host:port): a stream id or passphrase in its query is refused by the twin and the file", () => {
    const bad = fixture("session-invalid-input-url-query");
    const good = fixture("session-composed-720p");
    expect(Object.keys(bad).filter((k) => JSON.stringify(bad[k]) !== JSON.stringify(good[k])), "premise — differs in input alone").toEqual(["input"]);
    expect((bad.input as Json).url as string).toContain("?");
    const result = S.RelayJobSession.safeParse(bad);
    expect(result.error?.issues.map((i) => i.path.join(".")), "refused on input.url alone").toEqual(["input.url"]);
  });
});

// R2007 PR B (overlay templates spec 2026-10-15 §6, R2002 row): the compositor reports `final` during the final hold
// (C06) and on the final exit beat (owner ruling 2026-10-15); the page reports which phase channel is live (§4.3).
describe("R2007 PR B: the programme phase gains `final`, the beat carries its phase channel, and the loopback endpoint is published", () => {
  it("lib/relay-phase declares exactly the plan's phases and channels — and every phase parses inside RelayHeartbeat, in the twin AND the file (counted); `paused` is refused by both", () => {
    expect([...PROGRAMME_PHASES], "the phases, in the compositor's order").toEqual(SPEC_BEAT.programmePhase);
    expect([...PHASE_CHANNELS]).toEqual(SPEC_BEAT.phaseChannel);
    const fileAdmits = fileValidator();
    let phases = 0;
    for (const phase of PROGRAMME_PHASES) {
      expect(parses(S.RelayHeartbeat, { state: "playing", programmePhase: phase }), `the twin: ${phase}`).toBe(true);
      expect(fileAdmits("heartbeat", { state: "playing", programmePhase: phase }), `the file: ${phase}`).toBe(true);
      phases++;
    }
    console.log(`phases checked: ${phases}`);
    expect(phases, "anti-vacuity: zero phases checked is a failure").toBeGreaterThan(0);
    expect(phases).toBe(5);
    // An unknown phase is still refused, by both — `final` widened the enum, it did not open it.
    for (const outsider of ["paused", "Final", "ending"]) {
      expect(parses(S.RelayHeartbeat, { state: "playing", programmePhase: outsider }), `the twin: ${outsider}`).toBe(false);
      expect(fileAdmits("heartbeat", { state: "playing", programmePhase: outsider }), `the file: ${outsider}`).toBe(false);
    }
    // The owner's case: the final EXIT beat, still in `final`, carrying its reason — admitted, so the reason is not lost.
    const exitBeat = { state: "stopped", programmePhase: "final", phaseChannel: "loopback", exitReason: "ended" };
    expect(parses(S.RelayHeartbeat, exitBeat), "the twin: the final exit beat").toBe(true);
    expect(fileAdmits("heartbeat", exitBeat), "the file: the final exit beat").toBe(true);
    // The prose names the hold, so a reader learns what `final` means from the file.
    expect(propOf(defOf(contract(), "heartbeat"), "programmePhase").description as string).toContain("`final`");
    expect(propOf(defOf(contract(), "heartbeat"), "programmePhase").description as string).toContain("final hold");
  });

  it("phaseChannel takes only its two words: each admitted, `wifi` (heartbeat-invalid-phase-channel) refused at phaseChannel alone; a beat from a compositor built before R2007 PR B (no `final`, no phaseChannel) still validates", () => {
    const fileAdmits = fileValidator();
    let channels = 0;
    for (const phaseChannel of PHASE_CHANNELS) {
      expect(parses(S.RelayHeartbeat, { state: "playing", phaseChannel }), `the twin: ${phaseChannel}`).toBe(true);
      expect(fileAdmits("heartbeat", { state: "playing", phaseChannel }), `the file: ${phaseChannel}`).toBe(true);
      channels++;
    }
    expect(channels).toBe(2);
    const bad = fixture("heartbeat-invalid-phase-channel");
    const result = S.RelayHeartbeat.safeParse(bad);
    expect(result.error?.issues.map((i) => i.path.join(".")), "refused on phaseChannel alone").toEqual(["phaseChannel"]);
    expect(fileAdmits("heartbeat", bad), "the file refuses it").toBe(false);
    // The positive pair on the same edit: the hold it was cut from is admitted by both.
    expect(parses(S.RelayHeartbeat, fixture("heartbeat-final-hold"))).toBe(true);
    expect(fileAdmits("heartbeat", fixture("heartbeat-final-hold"))).toBe(true);
    // Backward compatible: what an older compositor sends — no phaseChannel key, a pre-`final` phase — is admitted.
    let old = 0;
    for (const beat of [fixture("heartbeat-minimal"), { state: "playing", programmePhase: "live" }, { state: "stopped", exitReason: "fatal" }]) {
      expect(beat, "premise: no phaseChannel key").not.toHaveProperty("phaseChannel");
      expect(parses(S.RelayHeartbeat, beat), JSON.stringify(beat)).toBe(true);
      expect(fileAdmits("heartbeat", beat), `the file: ${JSON.stringify(beat)}`).toBe(true);
      old++;
    }
    expect(old).toBe(3);
  });

  it("$defs.phaseEndpoint publishes the plan's port, path and long-poll bound as consts equal to lib/relay-phase's; the port is unprivileged and below the ephemeral range; any other value is refused", () => {
    expect({ port: RELAY_PHASE_PORT, path: RELAY_PHASE_PATH, longPollMaxMs: RELAY_PHASE_LONG_POLL_MAX_MS }, "lib/relay-phase").toEqual(PLAN_PHASE_ENDPOINT);
    expect(RELAY_PHASE_PORT).toBeGreaterThan(PRIVILEGED_MAX);
    expect(RELAY_PHASE_PORT).toBeLessThan(EPHEMERAL_MIN);
    const endpoint = defOf(contract(), "phaseEndpoint");
    expect(propOf(endpoint, "port").const, "the committed contract's port").toBe(RELAY_PHASE_PORT);
    expect(propOf(endpoint, "path").const).toBe(RELAY_PHASE_PATH);
    expect(propOf(endpoint, "longPollMaxMs").const).toBe(RELAY_PHASE_LONG_POLL_MAX_MS);
    expect([...(endpoint.required as string[])].sort()).toEqual(Object.keys(PLAN_PHASE_ENDPOINT).sort());
    const fileAdmits = fileValidator();
    expect(parses(S.RelayPhaseEndpoint, PLAN_PHASE_ENDPOINT), "the twin admits the plan's endpoint").toBe(true);
    expect(fileAdmits("phaseEndpoint", PLAN_PHASE_ENDPOINT), "the file admits it").toBe(true);
    // Each field one off, refused by both: a const, not a range.
    let refused = 0;
    for (const off of [{ port: 7420 }, { path: "/phase/" }, { longPollMaxMs: 10_001 }]) {
      const value = { ...PLAN_PHASE_ENDPOINT, ...off };
      expect(parses(S.RelayPhaseEndpoint, value), `the twin: ${JSON.stringify(off)}`).toBe(false);
      expect(fileAdmits("phaseEndpoint", value), `the file: ${JSON.stringify(off)}`).toBe(false);
      refused++;
    }
    expect(refused).toBe(3);
  });

  it("$defs.phaseReply: `{ phase, seq }`, strict — every phase admitted (counted), seq whole and non-negative, an unknown key or phase refused, by the twin AND the file", () => {
    const fileAdmits = fileValidator();
    let phases = 0;
    for (const phase of SPEC_BEAT.programmePhase!) {
      expect(parses(S.RelayPhaseReply, { phase, seq: 0 }), `the twin: ${phase}`).toBe(true);
      expect(fileAdmits("phaseReply", { phase, seq: 0 }), `the file: ${phase}`).toBe(true);
      phases++;
    }
    expect(phases).toBe(5);
    let refused = 0;
    for (const bad of [{ phase: "paused", seq: 1 }, { phase: "final", seq: -1 }, { phase: "final", seq: 1.5 }, { phase: "final" }, { seq: 1 }, fixture("phase-reply-invalid-unknown-field")]) {
      expect(parses(S.RelayPhaseReply, bad), `the twin: ${JSON.stringify(bad)}`).toBe(false);
      expect(fileAdmits("phaseReply", bad), `the file: ${JSON.stringify(bad)}`).toBe(false);
      refused++;
    }
    expect(refused).toBe(6);
    expect(defOf(contract(), "phaseReply").description as string).toContain("?after=");
  });
});
