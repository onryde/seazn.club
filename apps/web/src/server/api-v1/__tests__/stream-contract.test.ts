// Streaming R1 wire contract (Task 9): the relay's schemas in schemas.ts, its
// five OpenAPI rows and its five key bans. Every expected value here comes from
// a declaration that is NOT the schema under test:
//  - the enum members from V410's CHECK lists (the table the rows live in) and
//    from the session domain (server/relay/domain), read at run time;
//  - the key bans from the design ("an API key can never start a stream or
//    read a destination", §9a Deny by default) applied to the ROUTES rows.
// Pure — no DB.
import { describe, expect, expectTypeOf, it } from "vitest";
import type { z } from "zod";
import * as S from "../schemas";
import { CaptureQrV1 } from "@/lib/capture-qr";
import { buildOpenApiDocument, ROUTES } from "../openapi";
import { matchKeyRoute, NEVER_KEY_ROUTES } from "../key-scopes";
import { ACTIVE_STATES, TERMINAL_STATES, type FailReason } from "@/server/relay/domain/session";
import { deltaText, lastCheckList, MIGRATION, STREAM_DELTA_COUNT, STREAM_DELTA_FILES } from "@/server/relay/__tests__/_stream-migration";
import {
  DESTINATION_LABEL_EMPTY, DESTINATION_NOT_ALLOWED, DESTINATION_REFUSALS, STREAM_DESTINATION_HOSTS, STREAM_KEY_EMPTY, STREAM_PLATFORMS,
  STREAM_PLATFORM_PRESETS, TARGET_UNREADABLE,
} from "@/lib/stream-destinations";

/** The quoted members of `<column> text … check (<column> in ('a','b'))` inside ONE table of V410. */
function checkList(table: string, column: string): string[] {
  const start = MIGRATION.indexOf(`create table ${table} (`);
  if (start === -1) return [];
  const body = MIGRATION.slice(start, MIGRATION.indexOf("\n);", start));
  const m = body.match(new RegExp(`\\n\\s*${column}\\s+text\\b[^\\n]*?check \\(${column} in \\(([^)]*)\\)\\)`));
  return m ? [...m[1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!) : [];
}

const sorted = (xs: readonly string[]) => [...xs].sort();

describe("relay wire enums equal their declarations", () => {
  const pairs: [string, readonly string[], string[]][] = [
    ["StreamMode ↔ fixture_stream_sessions.mode", S.StreamMode.options, checkList("fixture_stream_sessions", "mode")],
    ["StreamSessionState ↔ fixture_stream_sessions.state", S.StreamSessionState.options, checkList("fixture_stream_sessions", "state")],
    ["StreamSessionCurrent.desiredState ↔ fixture_stream_sessions.desired_state", S.StreamSessionCurrent.shape.desiredState.options, checkList("fixture_stream_sessions", "desired_state")],
    ["RelayHeartbeatReply.desiredState ↔ fixture_stream_sessions.desired_state", S.RelayHeartbeatReply.shape.desiredState.options, checkList("fixture_stream_sessions", "desired_state")],
    ["StreamEndReason ↔ fixture_stream_sessions.end_reason", S.StreamEndReason.options, checkList("fixture_stream_sessions", "end_reason")],
    ["StreamIngest.protocol ↔ fixture_stream_sessions.ingest_protocol", S.StreamIngest.shape.protocol.unwrap().options, checkList("fixture_stream_sessions", "ingest_protocol")],
    ["StreamTargetKind ↔ org_stream_targets.kind", S.StreamTargetKind.options, checkList("org_stream_targets", "kind")],
  ];

  it("each wire enum equals the V410 CHECK list of the column it is stored in", () => {
    let checked = 0;
    for (const [name, wire, declared] of pairs) {
      expect(declared.length, `${name}: the V410 list parsed empty`).toBeGreaterThan(0);
      expect(sorted(wire), name).toEqual(sorted(declared));
      checked++;
    }
    expect(checked, "pairs checked").toBe(pairs.length);
    expect(checked).toBeGreaterThan(0);
  });

  it("StreamSessionState is exactly the domain's active + terminal states", () => {
    const domain = [...ACTIVE_STATES, ...TERMINAL_STATES];
    expect(domain.length).toBeGreaterThan(0);
    expect(sorted(S.StreamSessionState.options)).toEqual(sorted(domain));
  });

  it("StreamFailReason is exactly the domain's FailReason — eleven, and never storage_exhausted (E5: a refusal with no row)", () => {
    // Keyed by the DOMAIN type: tsc refuses this literal if FailReason gains or loses a member, so the runtime
    // comparison below always compares the wire enum against the domain's current declaration.
    const domain: Record<FailReason, true> = {
      no_inbound_timeout: true, provision_timeout: true, admission_timeout: true, target_rejected: true, no_credits: true,
      machine_create_failed: true, machine_boot_timeout: true, machine_exit_nonzero: true, machine_oom: true, machine_crash: true,
      relay_disabled: true,
    };
    expect(sorted(S.StreamFailReason.options)).toEqual(sorted(Object.keys(domain)));
    expect(S.StreamFailReason.options).toHaveLength(11);
    expect(S.StreamFailReason.options as readonly string[]).not.toContain("storage_exhausted");
    // A failed session carries no end reason: the two vocabularies never overlap.
    expect(S.StreamFailReason.options.filter((r) => (S.StreamEndReason.options as readonly string[]).includes(r))).toEqual([]);
  });

  it("the QR schema is RE-EXPORTED, never re-typed: schemas.ts's CaptureQrV1 IS lib/capture-qr.ts's", () => {
    expect(S.CaptureQrV1).toBe(CaptureQrV1);
    expect(S.StreamSessionCurrent.shape.qr.unwrap()).toBe(CaptureQrV1);
  });

  it("the four inferred types the Task 9 brief promised are EXPORTED, each exactly its schema's z.infer (review minor 6)", () => {
    // Type-level, so tsc is the checker: in type position `S.X` names the exported TYPE, and with no `export type X`
    // tsc refuses this file ("refers to a value, but is being used as a type"). A type that drifted from its schema
    // fails toEqualTypeOf the same way.
    expectTypeOf<S.StreamEndReason>().toEqualTypeOf<z.infer<typeof S.StreamEndReason>>();
    expectTypeOf<S.StreamHealth>().toEqualTypeOf<z.infer<typeof S.StreamHealth>>();
    expectTypeOf<S.StreamIngest>().toEqualTypeOf<z.infer<typeof S.StreamIngest>>();
    expectTypeOf<S.RelayHeartbeatReply>().toEqualTypeOf<z.infer<typeof S.RelayHeartbeatReply>>();
    // The runtime twin: a value written against each exported type is one its schema accepts unchanged.
    const samples: [string, { parse(v: unknown): unknown }, unknown][] = [
      ["StreamEndReason", S.StreamEndReason, "max_duration" satisfies S.StreamEndReason],
      ["StreamHealth", S.StreamHealth, { fps: 30, bitrateKbps: null, lastBeatAt: null } satisfies S.StreamHealth],
      ["StreamIngest", S.StreamIngest, { state: "connected", protocol: "srt" } satisfies S.StreamIngest],
      ["RelayHeartbeatReply", S.RelayHeartbeatReply, { desiredState: "ending" } satisfies S.RelayHeartbeatReply],
    ];
    let checked = 0;
    for (const [name, schema, value] of samples) {
      expect(schema.parse(value), name).toEqual(value);
      checked++;
    }
    expect(checked).toBe(4);
  });
});

// Capture QR v2 T3 (A4): a CHECK list is the LAST declaration in version order across the stream
// fold, in either form — V410's inline unnamed column check, or a later `add constraint … check`.
// Every expectation below is read straight off ONE file's own `in (…)` list with a regex local to
// this test, never typed and never through lastCheckList itself.
describe("the stream delta fold — lastCheckList reads both CHECK forms, last definition wins (A4)", () => {
  const V410 = deltaText(410);
  const V430 = deltaText(430);
  const list = (m: RegExpMatchArray | null): string[] => (m ? [...m[1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!) : []);
  // V410 :175 and :307 — the inline unnamed form.
  const v410EndReasons = list(V410.match(/\n\s*end_reason\s+text null check \(end_reason in \(([^)]*)\)\)/));
  const v410Sources = list(V410.match(/\n\s*source\s+text not null check \(source in \(([^)]*)\)\)/));
  // V430 — the named form, under Postgres's default name for V410's inline check.
  const v430EndReasons = list(V430.match(/add constraint fixture_stream_sessions_end_reason_check\s+check \(end_reason in \(([^)]*)\)\)/));
  const v430Sources = list(V430.match(/add constraint fixture_stream_events_source_check\s+check \(source in \(([^)]*)\)\)/));

  it("anti-vacuity: the fold read files, V410 and V430 among them BY NAME, and each file's own list parsed non-empty", () => {
    expect(STREAM_DELTA_COUNT).toBeGreaterThan(0);
    expect(STREAM_DELTA_COUNT).toBe(STREAM_DELTA_FILES.length);
    expect(STREAM_DELTA_FILES).toContain("V410__stream_sessions.sql");
    expect(STREAM_DELTA_FILES).toContain("V430__capture_stream_codes.sql");
    expect(STREAM_DELTA_FILES.indexOf("V410__stream_sessions.sql")).toBeLessThan(STREAM_DELTA_FILES.indexOf("V430__capture_stream_codes.sql"));
    expect([v410EndReasons.length, v430EndReasons.length, v410Sources.length, v430Sources.length].every((n) => n > 0)).toBe(true);
  });

  it("ordering differential: V410 alone folds to V410's two end reasons; V410 then V430 folds to V430's five; the reverse order folds back to V410's", () => {
    expect(v410EndReasons).toHaveLength(2);
    expect(v430EndReasons).toHaveLength(5);
    expect(lastCheckList("fixture_stream_sessions", "end_reason", [V410])).toEqual(v410EndReasons);       // the INLINE form
    expect(lastCheckList("fixture_stream_sessions", "end_reason", [V430])).toEqual(v430EndReasons);       // the NAMED form
    expect(lastCheckList("fixture_stream_sessions", "end_reason", [V410, V430])).toEqual(v430EndReasons);
    expect(lastCheckList("fixture_stream_sessions", "end_reason", [V430, V410])).toEqual(v410EndReasons); // order decides
    expect(lastCheckList("fixture_stream_sessions", "end_reason")).toEqual(v430EndReasons);               // the whole fold
    // V430 keeps both of V410's reasons — it widens, never narrows.
    for (const r of v410EndReasons) expect(v430EndReasons).toContain(r);
  });

  it("fixture_stream_events.source: the folded list contains 'phone', V410's alone does not, and every V410 source is kept", () => {
    const folded = lastCheckList("fixture_stream_events", "source");
    expect(lastCheckList("fixture_stream_events", "source", [V410])).toEqual(v410Sources);
    expect(folded).toEqual(v430Sources);
    expect(folded).toContain("phone");
    expect(v410Sources).not.toContain("phone");
    expect([...folded].filter((x) => x !== "phone").sort()).toEqual([...v410Sources].sort());
  });

  it("the empty case: a column no folded file checks reads [], never a default", () => {
    expect(lastCheckList("fixture_stream_sessions", "no_such_column")).toEqual([]);
    expect(lastCheckList("no_such_table", "end_reason")).toEqual([]);
    expect(lastCheckList("fixture_stream_sessions", "end_reason", [])).toEqual([]);
  });
});

describe("relay request schemas refuse what they must", () => {
  const target = { kind: "youtube", label: "Club", streamKey: "k" };

  it("CreateStreamTarget (D6): the kind is exactly STREAM_PLATFORMS and the body carries NO ingest url — the server fills it from the platform's preset", () => {
    // Every kind the one platform list declares parses; every stored kind outside it (the legacy rows a Directory
    // still lists) is refused at create; an `rtmpUrl` field is refused by the strict schema, never silently dropped.
    let checked = 0;
    for (const kind of STREAM_PLATFORMS) {
      expect(S.CreateStreamTarget.safeParse({ ...target, kind }).success, kind).toBe(true);
      checked++;
    }
    const legacy = S.StreamTargetKind.options.filter((k) => !(STREAM_PLATFORMS as readonly string[]).includes(k));
    for (const kind of legacy) {
      expect(S.CreateStreamTarget.safeParse({ ...target, kind }).success, kind).toBe(false);
      checked++;
    }
    expect(legacy.length).toBeGreaterThan(0);
    expect(checked).toBe(S.StreamTargetKind.options.length);
    expect(S.CreateStreamTarget.safeParse({ ...target, rtmpUrl: STREAM_PLATFORM_PRESETS.youtube }).success).toBe(false);
    const missing: Record<string, unknown> = { ...target };
    delete missing.kind;
    expect(S.CreateStreamTarget.safeParse(missing).success).toBe(false);
  });

  it("CreateStreamTarget: strict, bounded label and key, the one watch-link allowlist", () => {
    expect(S.CreateStreamTarget.safeParse(target).success).toBe(true);
    expect(S.CreateStreamTarget.safeParse({ ...target, stream_key: "k" }).success).toBe(false);
    expect(S.CreateStreamTarget.safeParse({ ...target, label: "" }).success).toBe(false);
    expect(S.CreateStreamTarget.safeParse({ ...target, label: "l".repeat(80) }).success).toBe(true);
    expect(S.CreateStreamTarget.safeParse({ ...target, label: "l".repeat(81) }).success).toBe(false);
    expect(S.CreateStreamTarget.safeParse({ ...target, streamKey: "" }).success).toBe(false);
    expect(S.CreateStreamTarget.safeParse({ ...target, streamKey: "s".repeat(200) }).success).toBe(true);
    expect(S.CreateStreamTarget.safeParse({ ...target, streamKey: "s".repeat(201) }).success).toBe(false);
    expect(S.CreateStreamTarget.safeParse({ ...target, kind: "vimeo" }).success).toBe(false);
    expect(S.CreateStreamTarget.safeParse({ ...target, watchUrl: "https://evil.example/watch" }).success).toBe(false);
    expect(S.CreateStreamTarget.parse({ ...target, watchUrl: "https://www.twitch.tv/club" }).watchUrl).toBe("https://www.twitch.tv/club");
    expect(S.CreateStreamTarget.parse({ ...target, watchUrl: "" }).watchUrl).toBeNull();
  });

  it("CreateStreamSession: strict, a uuid target, a bounded theme", () => {
    const ok = { mode: "passthrough", targetId: "3f1c2a9e-8b7d-4c61-9f0a-2d5e6b7c8a91" };
    expect(S.CreateStreamSession.safeParse(ok).success).toBe(true);
    expect(S.CreateStreamSession.safeParse({ ...ok, mode: "composed", themeId: "t".repeat(40) }).success).toBe(true);
    expect(S.CreateStreamSession.safeParse({ ...ok, themeId: "t".repeat(41) }).success).toBe(false);
    expect(S.CreateStreamSession.safeParse({ ...ok, themeId: "" }).success).toBe(false);
    expect(S.CreateStreamSession.safeParse({ ...ok, targetId: "not-a-uuid" }).success).toBe(false);
    expect(S.CreateStreamSession.safeParse({ ...ok, fixtureId: ok.targetId }).success).toBe(false);
    expect(S.CreateStreamSession.safeParse({}).success).toBe(false);
  });

  it("RelayHeartbeat: the minimal beat passes, every A29 encoder fact is optional, nothing unknown rides along", () => {
    expect(S.RelayHeartbeat.safeParse({ state: "starting" }).success).toBe(true);
    const full = {
      state: "playing", videoState: "running", fps: 30, bitrateKbps: 4500, egressBytes: 1_000_000, measuredLatencyMs: 900,
      droppedFrames: 0, encoderSpeed: 1.0, cpuPct: 55.5, memMb: 310,
    };
    expect(S.RelayHeartbeat.safeParse(full).success).toBe(true);
    // A5: exit facts are NOT the heartbeat's to carry — strict refuses them rather than dropping them silently.
    expect(S.RelayHeartbeat.safeParse({ state: "stopped", lastExit: { code: 1 } }).success).toBe(false);
    for (const [field, value] of [["fps", -1], ["bitrateKbps", -1], ["egressBytes", 1.5], ["droppedFrames", 0.5], ["cpuPct", -0.1], ["memMb", -1]] as const) {
      expect(S.RelayHeartbeat.safeParse({ state: "playing", [field]: value }).success, `${field}=${value}`).toBe(false);
    }
    expect(S.RelayHeartbeat.safeParse({ state: "healthy" }).success).toBe(false);
    expect(S.RelayHeartbeat.safeParse({}).success).toBe(false);
  });

  it("StreamSessionCurrent is strict, and its qr is the v1 payload or null — never a default object", () => {
    const current = {
      id: "s", fixtureId: "f", mode: "passthrough", state: "warming", desiredState: "live", failReason: null,
      health: null, ingest: null, output: null, qr: null, balance: 3, startedAt: null, endedAt: null, replayUrl: null,
      target: { id: "t", kind: "youtube", label: "Club" }, fixtureDecided: false, endReason: null, creditUsed: false,
      restartFree: false,
    };
    expect(S.StreamSessionCurrent.safeParse(current).success).toBe(true);
    // T4 D3: output is REQUIRED (null, or {state, since, elapsedMs}) — an absent field would read as "nothing to warn about".
    const withoutOutput: Record<string, unknown> = { ...current };
    delete withoutOutput.output;
    expect(S.StreamSessionCurrent.safeParse(withoutOutput).success).toBe(false);
    expect(S.StreamSessionCurrent.safeParse({ ...current, output: {} }).success).toBe(false);
    expect(S.StreamSessionCurrent.safeParse({ ...current, output: { state: "healthy", since: "2026-09-30T12:00:00Z", elapsedMs: 0 } }).success).toBe(false);
    // B2 fix round M6: the server's elapsed is REQUIRED — the client judges D3 on it, never on its own clock — and it is a
    // whole, non-negative number of milliseconds.
    expect(S.StreamSessionCurrent.safeParse({ ...current, output: { state: "connecting", since: "2026-09-30T12:00:00Z" } }).success, "no elapsedMs").toBe(false);
    expect(S.StreamSessionCurrent.safeParse({ ...current, output: { state: "connecting", since: "2026-09-30T12:00:00Z", elapsedMs: -1 } }).success, "negative").toBe(false);
    expect(S.StreamSessionCurrent.safeParse({ ...current, output: { state: "connecting", since: "2026-09-30T12:00:00Z", elapsedMs: 1.5 } }).success, "fractional").toBe(false);
    let outputStates = 0;
    for (const state of ["ok", "connecting", "rejected", "unknown"] as const) {   // ports.ts OutputState, the wire's source
      expect(S.StreamSessionCurrent.safeParse({ ...current, output: { state, since: "2026-09-30T12:00:00Z", elapsedMs: 0 } }).success, state).toBe(true);
      outputStates++;
    }
    expect(outputStates).toBe(S.StreamOutput.shape.state.options.length);
    // D3: creditUsed is REQUIRED and a boolean — an absent field must not read as "no credit used" on the client.
    const withoutCreditUsed: Record<string, unknown> = { ...current };
    delete withoutCreditUsed.creditUsed;
    expect(S.StreamSessionCurrent.safeParse(withoutCreditUsed).success).toBe(false);
    expect(S.StreamSessionCurrent.safeParse({ ...current, creditUsed: 1 }).success).toBe(false);
    // I-1: restartFree likewise — an absent field would read as "not free" and force the chooser on a free restart.
    const withoutRestartFree: Record<string, unknown> = { ...current };
    delete withoutRestartFree.restartFree;
    expect(S.StreamSessionCurrent.safeParse(withoutRestartFree).success).toBe(false);
    expect(S.StreamSessionCurrent.safeParse({ ...current, restartFree: "yes" }).success).toBe(false);
    expect(S.StreamSessionCurrent.safeParse({ ...current, restartFree: true }).success, "the positive pair").toBe(true);
    expect(S.StreamSessionCurrent.safeParse({ ...current, streamKey: "k" }).success).toBe(false);
    expect(S.StreamSessionCurrent.safeParse({ ...current, qr: {} }).success).toBe(false);
    expect(S.StreamSessionCurrent.safeParse({ ...current, failReason: "storage_exhausted" }).success).toBe(false);
    expect(S.StreamSessionCurrent.safeParse({ ...current, balance: 1.5 }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Deny by default (§9a): an API key can never start a stream or read a destination.
// ---------------------------------------------------------------------------

/** OpenAPI `{id}` template → the key table's `:id` form. */
const keyForm = (method: string, path: string) => `${method.toUpperCase()} ${path.replace(/\{([^}]+)\}/g, ":$1")}`;
const STREAM_ROUTE = /\/(stream-sessions|stream-targets)(\/|$)/;
const streamRoutes = ROUTES.filter((r) => STREAM_ROUTE.test(r.path));

describe("the relay's routes are never key-reachable", () => {
  it("ROUTES declares exactly the SEVEN relay operations (design §6.3 / §6.1; spec §5.2 adds rename/replace + remove)", () => {
    expect(streamRoutes.map((r) => keyForm(r.method, r.path)).sort()).toEqual([
      "DELETE /orgs/:id/stream-targets/:targetId",
      "GET /fixtures/:id/stream-sessions/current",
      "GET /orgs/:id/stream-targets",
      "PATCH /orgs/:id/stream-targets/:targetId",
      "POST /fixtures/:id/stream-sessions",
      "POST /fixtures/:id/stream-sessions/:sid/stop",
      "POST /orgs/:id/stream-targets",
    ]);
  });

  it("every relay operation is an explicit NEVER_KEY_ROUTES entry AND resolves to no key rule on a concrete path", () => {
    let checked = 0;
    for (const r of streamRoutes) {
      const entry = keyForm(r.method, r.path);
      // Explicit, not merely unlisted: default-deny alone is reopened by the first broader rule someone adds in the
      // same slot (key-scopes.ts's shadowing note) — the ban list is matched FIRST, whatever else the table says.
      expect(NEVER_KEY_ROUTES, entry).toContain(entry);
      const concrete = `/api/v1${r.path.replace(/\{[^}]+\}/g, "3f1c2a9e-8b7d-4c61-9f0a-2d5e6b7c8a91")}`;
      expect(matchKeyRoute(r.method, concrete), `${r.method.toUpperCase()} ${concrete}`).toBeNull();
      checked++;
    }
    expect(checked, "relay routes checked").toBeGreaterThan(0);
    expect(checked).toBe(streamRoutes.length);
  });

  it("the published developer spec carries none of them; the full spec carries all of them (the positive pair)", () => {
    const published = buildOpenApiDocument({ published: true }) as { paths: Record<string, Record<string, unknown>> };
    const full = buildOpenApiDocument() as { paths: Record<string, Record<string, unknown>> };
    let checked = 0;
    for (const r of streamRoutes) {
      const path = `/api/v1${r.path}`;
      expect(full.paths[path]?.[r.method], `full spec lacks ${r.method} ${path}`).toBeDefined();
      expect(published.paths[path]?.[r.method], `published spec leaks ${r.method} ${path}`).toBeUndefined();
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });

  // A18: the refusal's `rule` is a real wire field (HttpError `extra`), so the spec documents it — SCOPED to this
  // route's 422 (ERROR_SCHEMA_OVERRIDES), never folded into the shared envelope (openapi-coverage.test.ts's rule).
  it("POST stream-targets documents 422 DESTINATION_NOT_ALLOWED and its `rule` enum; no other route's 422 gains `rule`", () => {
    type ErrorProps = { properties?: Record<string, { enum?: string[] }> };
    type Doc = {
      paths: Record<string, Record<string, { summary?: string; responses: Record<string, { content: { "application/json": { schema: { properties: { error: ErrorProps } } } } }> }>>;
    };
    const doc = buildOpenApiDocument() as Doc;
    const op = doc.paths["/api/v1/orgs/{id}/stream-targets"]!.post!;
    expect(op.summary).toContain("DESTINATION_NOT_ALLOWED");
    // D6: the summary names exactly the platforms a destination can be CREATED on (STREAM_PLATFORMS) — every other
    // allowlisted provider is a host a stored legacy row may still name, never one this route offers — and LinkedIn
    // (dropped in R1) nowhere.
    const displayName: Record<string, string> = {
      youtube: "YouTube", facebook: "Facebook", twitch: "Twitch", kick: "Kick",
      vimeo: "Vimeo", restream: "Restream", cloudflare_stream: "Cloudflare Stream",
    };
    let named = 0;
    let offered = 0;
    for (const provider of new Set(STREAM_DESTINATION_HOSTS.map((e) => e.provider))) {
      expect(displayName[provider], `no display name for ${provider}`).toBeDefined();
      if ((STREAM_PLATFORMS as readonly string[]).includes(provider)) {
        expect(op.summary).toContain(displayName[provider]);
        offered++;
      } else {
        expect(op.summary, provider).not.toContain(displayName[provider]);
      }
      named++;
    }
    expect(named).toBe(7);
    expect(offered).toBe(STREAM_PLATFORMS.length);
    expect(op.summary).not.toMatch(/linkedin/i);
    const err422 = op.responses["422"]!.content["application/json"].schema.properties.error;
    expect(Object.keys(err422.properties ?? {}).sort()).toEqual(["code", "current_seq", "message", "rule"]);
    expect([...(err422.properties!.rule!.enum ?? [])].sort()).toEqual([...DESTINATION_REFUSALS].sort());
    // Task 11 (A20): starting a session RE-CHECKS the saved destination and refuses with the same typed 422, so that
    // route's 422 documents the same `rule` — the ONE other route whose 422 is DESTINATION_NOT_ALLOWED. Named, not
    // pattern-matched, so a third route gaining `rule` still reds below.
    const sessionErr422 = doc.paths["/api/v1/fixtures/{id}/stream-sessions"]!.post!.responses["422"]!.content["application/json"].schema.properties.error;
    expect([...(sessionErr422.properties!.rule!.enum ?? [])].sort()).toEqual([...DESTINATION_REFUSALS].sort());
    // T2b: Replace key re-checks the platform's preset through the same validator (replaceTargetKey's `undialable`), so
    // PATCH's 422 documents the same `rule` — the THIRD named route; DELETE has no 422 at all.
    const patchErr422 = doc.paths["/api/v1/orgs/{id}/stream-targets/{targetId}"]!.patch!.responses["422"]!.content["application/json"].schema.properties.error;
    expect([...(patchErr422.properties!.rule!.enum ?? [])].sort()).toEqual([...DESTINATION_REFUSALS].sort());
    const refusesDestinations = new Set([
      "post /api/v1/orgs/{id}/stream-targets", "post /api/v1/fixtures/{id}/stream-sessions", "patch /api/v1/orgs/{id}/stream-targets/{targetId}",
    ]);
    let others = 0;
    for (const [path, ops] of Object.entries(doc.paths)) {
      for (const [method, o] of Object.entries(ops)) {
        if (refusesDestinations.has(`${method} ${path}`)) continue;
        const e = o.responses["422"]?.content["application/json"].schema.properties.error;
        if (!e) continue;
        expect(Object.keys(e.properties ?? {}), `${method} ${path}`).not.toContain("rule");
        others++;
      }
    }
    expect(others, "other routes with a 422 checked").toBeGreaterThan(0);
  });

  // N1/N2 (B1 review): every 422 these routes answer carries a machine code (lib/stream-destinations.ts), and the spec
  // names each one — in the route's summary AND on its 422's `code`. Which route throws which is the usecases' own
  // (stream-targets.ts create/patch, stream-sessions.ts createSession); DELETE has no 422 at all.
  it("N1/N2: each stream route's coded 422s are named in its summary and on its 422 `code`; DELETE documents no 422", () => {
    type Doc = {
      paths: Record<string, Record<string, { summary?: string; responses: Record<string, { content: { "application/json": { schema: { properties: { error: { properties: { code: { description?: string } } } } } } } }> }>>;
    };
    const doc = buildOpenApiDocument() as Doc;
    const CODED_422: [string, string, string[]][] = [
      ["/api/v1/orgs/{id}/stream-targets", "post", [DESTINATION_NOT_ALLOWED, STREAM_KEY_EMPTY, DESTINATION_LABEL_EMPTY]],
      ["/api/v1/orgs/{id}/stream-targets/{targetId}", "patch", [DESTINATION_NOT_ALLOWED, STREAM_KEY_EMPTY, DESTINATION_LABEL_EMPTY, TARGET_UNREADABLE]],
      ["/api/v1/fixtures/{id}/stream-sessions", "post", [DESTINATION_NOT_ALLOWED, TARGET_UNREADABLE]],
    ];
    let checked = 0;
    for (const [path, method, codes] of CODED_422) {
      const op = doc.paths[path]![method]!;
      const codeDoc = op.responses["422"]!.content["application/json"].schema.properties.error.properties.code.description ?? "";
      for (const code of codes) {
        expect(op.summary, `${method} ${path} summary names ${code}`).toContain(code);
        expect(codeDoc, `${method} ${path} 422 code names ${code}`).toContain(code);
        checked++;
      }
    }
    expect(checked).toBe(9);
    expect(doc.paths["/api/v1/orgs/{id}/stream-targets/{targetId}"]!.delete!.responses["422"]).toBeUndefined();
    // The negative twin: a code a route never answers is not named on it — Go live never refuses a blank key or name.
    const goLive = doc.paths["/api/v1/fixtures/{id}/stream-sessions"]!.post!;
    for (const never of [STREAM_KEY_EMPTY, DESTINATION_LABEL_EMPTY]) expect(goLive.summary, never).not.toContain(never);
  });

  // Task 11 follow-up (controller ruling): a start refused `target_in_use` names the fixture holding the destination —
  // `holder: { fixtureId, courtName, label }`, or null when the index race gives no holder to name. It is a wire field,
  // so the create route's 409 documents it (next to active_session's `sessionId`), SCOPED to that route.
  it("POST stream-sessions documents 409 `sessionId` and `holder { fixtureId, href, matchNo, courtName, label, state }`; the Directory's PATCH/DELETE 409 document TARGET_IN_USE's `holder`, and PATCH alone DESTINATION_DUPLICATE's `other`; no other route's 409 gains `holder`", () => {
    type Prop = { type?: string | string[]; properties?: Record<string, Prop> };
    type Doc = { paths: Record<string, Record<string, { responses: Record<string, { content: { "application/json": { schema: { properties: { error: Prop } } } } }> }>> };
    const doc = buildOpenApiDocument() as Doc;
    const err409 = doc.paths["/api/v1/fixtures/{id}/stream-sessions"]!.post!.responses["409"]!.content["application/json"].schema.properties.error;
    expect(Object.keys(err409.properties ?? {}).sort()).toEqual(["code", "current_seq", "holder", "message", "sessionId"]);
    const holder = err409.properties!.holder!;
    expect(holder.type, "holder is nullable (the race-loser refusal has no holder to name)").toEqual(["object", "null"]);
    // T3 (spec §5.5): Go live's holder is the SAME shape as the Directory's (stream-target-holders.ts wireHolder) — the
    // match's number, page and hold state beside the court and label.
    expect(Object.keys(holder.properties ?? {}).sort()).toEqual(["courtName", "fixtureId", "href", "label", "matchNo", "state"]);
    // T2b (spec §5.2): Replace key and Remove refuse TARGET_IN_USE naming the holder (the list's holder shape plus the
    // destination's label — stream-target-holders.ts wireHolder), and Replace key ALONE refuses DESTINATION_DUPLICATE
    // naming the other destination. M1 (B1 review): Remove never sends `other` (removeStreamTarget throws only
    // TARGET_IN_USE or 404), so its 409 must not document it. Named routes, each with its exact key set.
    const targetPath = "/api/v1/orgs/{id}/stream-targets/{targetId}";
    const directory409: Record<"patch" | "delete", string[]> = {
      patch: ["code", "current_seq", "holder", "message", "other"],
      delete: ["code", "current_seq", "holder", "message"],
    };
    let directory = 0;
    for (const method of ["patch", "delete"] as const) {
      const e = doc.paths[targetPath]![method]!.responses["409"]!.content["application/json"].schema.properties.error;
      expect(Object.keys(e.properties ?? {}).sort(), method).toEqual(directory409[method]);
      expect(Object.keys(e.properties!.holder!.properties ?? {}).sort(), method).toEqual(["courtName", "fixtureId", "href", "label", "matchNo", "state"]);
      if (method === "patch") expect(Object.keys(e.properties!.other!.properties ?? {}).sort(), method).toEqual(["id", "label"]);
      directory++;
    }
    expect(directory).toBe(2);
    // M4 (B1 review): a create that loses the destination race twice is StreamTargetVanishedError — a 409 "try again"
    // on the wire, so POST documents a 409 (the plain envelope: no holder, no other).
    const post409 = doc.paths["/api/v1/orgs/{id}/stream-targets"]!.post!.responses["409"]?.content["application/json"].schema.properties.error;
    expect(Object.keys(post409?.properties ?? {}).sort(), "POST stream-targets documents 409").toEqual(["code", "current_seq", "message"]);
    const documentsHolder = new Set(["post /api/v1/fixtures/{id}/stream-sessions", `patch ${targetPath}`, `delete ${targetPath}`]);
    let others = 0;
    for (const [path, ops] of Object.entries(doc.paths)) {
      for (const [method, o] of Object.entries(ops)) {
        if (documentsHolder.has(`${method} ${path}`)) continue;
        const e = o.responses["409"]?.content["application/json"].schema.properties.error;
        if (!e) continue;
        expect(Object.keys(e.properties ?? {}), `${method} ${path}`).not.toContain("holder");
        others++;
      }
    }
    expect(others, "other routes with a 409 checked").toBeGreaterThan(0);
  });
});
