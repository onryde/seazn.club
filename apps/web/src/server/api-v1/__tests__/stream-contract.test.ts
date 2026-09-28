// Streaming R1 wire contract (Task 9): the relay's schemas in schemas.ts, its
// five OpenAPI rows and its five key bans. Every expected value here comes from
// a declaration that is NOT the schema under test:
//  - the enum members from V410's CHECK lists (the table the rows live in) and
//    from the session domain (server/relay/domain), read at run time;
//  - the key bans from the design ("an API key can never start a stream or
//    read a destination", §9a Deny by default) applied to the ROUTES rows.
// Pure — no DB.
import { describe, expect, it } from "vitest";
import * as S from "../schemas";
import { CaptureQrV1 } from "@/lib/capture-qr";
import { buildOpenApiDocument, ROUTES } from "../openapi";
import { matchKeyRoute, NEVER_KEY_ROUTES } from "../key-scopes";
import { ACTIVE_STATES, TERMINAL_STATES, type FailReason } from "@/server/relay/domain/session";
import { MIGRATION } from "@/server/relay/__tests__/_stream-migration";

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

  it("StreamFailReason is exactly the domain's FailReason — ten, and never storage_exhausted (E5: a refusal with no row)", () => {
    // Keyed by the DOMAIN type: tsc refuses this literal if FailReason gains or loses a member, so the runtime
    // comparison below always compares the wire enum against the domain's current declaration.
    const domain: Record<FailReason, true> = {
      no_inbound_timeout: true, provision_timeout: true, admission_timeout: true, target_rejected: true, no_credits: true,
      machine_create_failed: true, machine_boot_timeout: true, machine_exit_nonzero: true, machine_oom: true, machine_crash: true,
    };
    expect(sorted(S.StreamFailReason.options)).toEqual(sorted(Object.keys(domain)));
    expect(S.StreamFailReason.options).toHaveLength(10);
    expect(S.StreamFailReason.options as readonly string[]).not.toContain("storage_exhausted");
    // A failed session carries no end reason: the two vocabularies never overlap.
    expect(S.StreamFailReason.options.filter((r) => (S.StreamEndReason.options as readonly string[]).includes(r))).toEqual([]);
  });

  it("the QR schema is RE-EXPORTED, never re-typed: schemas.ts's CaptureQrV1 IS lib/capture-qr.ts's", () => {
    expect(S.CaptureQrV1).toBe(CaptureQrV1);
    expect(S.StreamSessionCurrent.shape.qr.unwrap()).toBe(CaptureQrV1);
  });
});

describe("relay request schemas refuse what they must", () => {
  const target = { kind: "youtube", label: "Club", rtmpUrl: "rtmps://a.rtmps.youtube.com/live2", streamKey: "k" };

  it("CreateStreamTarget: an rtmp:// or rtmps:// ingest URL with a host AND a path — nothing else", () => {
    for (const rtmpUrl of ["rtmp://h/app", "rtmps://a.rtmps.youtube.com/live2", "rtmps://live.twitch.tv/app/sub"]) {
      expect(S.CreateStreamTarget.safeParse({ ...target, rtmpUrl }).success, rtmpUrl).toBe(true);
    }
    const refused = [
      "https://a.rtmps.youtube.com/live2", // not an ingest scheme
      "srt://live.cloudflare.com:778/x",   // the phone's leg, not a destination
      "rtmps://a.rtmps.youtube.com",       // no path
      "rtmps://a.rtmps.youtube.com/",      // empty path
      "rtmps:///live2",                    // no host
      "rtmp://h st/app",                   // whitespace in the host
      " rtmp://h/app",                     // leading space
      `rtmp://h/${"a".repeat(500)}`,       // over 500
    ];
    let checked = 0;
    for (const rtmpUrl of refused) {
      expect(S.CreateStreamTarget.safeParse({ ...target, rtmpUrl }).success, rtmpUrl).toBe(false);
      checked++;
    }
    expect(checked).toBe(refused.length);
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
      health: null, ingest: null, qr: null, balance: 3, startedAt: null, endedAt: null, replayUrl: null,
      target: { id: "t", kind: "youtube", label: "Club" }, fixtureDecided: false, endReason: null,
    };
    expect(S.StreamSessionCurrent.safeParse(current).success).toBe(true);
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
  it("ROUTES declares exactly the five relay operations (design §6.3 / §6.1)", () => {
    expect(streamRoutes.map((r) => keyForm(r.method, r.path)).sort()).toEqual([
      "GET /fixtures/:id/stream-sessions/current",
      "GET /orgs/:id/stream-targets",
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
});
