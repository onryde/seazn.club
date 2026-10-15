// W2c Task 15 (X-SR-7, owner P-1 "A") — the scoring pad's half of the rules version.
//
// A pad sends the version of the rules it folds under with every append; the server refuses a version that is not the
// match's (FIXTURE_RULES_CHANGED, 409) before any insert. Here, the pad side, through the real tap path wherever a
// transport is involved (`usePadPipeline` → `drainQueue`/`sendOne` → `pipeline.ts`'s body builder → the transport's
// POST), never a builder called on its own:
//  - the body carries the version the pad was loaded with, and NOTHING when it was loaded with none (the empty case);
//  - a queued tap keeps the version it was CAPTURED with — an offline replay after a reload never re-stamps it with
//    the new one (that would apply an old-rules tap under new rules: the thing X-SR-7 forbids);
//  - FIXTURE_RULES_CHANGED is a refusal (dropped, never resent), carrying the server's version;
//  - on that refusal, or on an ack that names a newer version, the pad reloads the rules (GET /rules), folds under
//    them, says so (`rulesChanged`), and its next tap carries the new version; any other refusal reloads nothing.
//
// Expected cfg values are the engine's own (`configSchema.parse`), never typed tables.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EventEnvelope } from "@seazn/engine/core";
import { resolvePositions } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
import { defaultLineupPair } from "@seazn/engine/testkit";
import { renderIsland } from "@/components/__tests__/_hook-harness";
import { resolveModuleClient } from "../module-client";
import type { AppendCallResult, AppendEventBody } from "../pipeline";
import type { QueueStore } from "../queue-store";
import {
  TERMINAL_CONFLICT_CODES,
  deviceLinkTransport,
  sessionTransport,
  type FixtureRulesResult,
  type FixtureStateResult,
  type PadTransport,
} from "../transport";
import type { LedgerSlotEvent, OwnIdentity } from "../types";
import { usePadPipeline, type UsePadPipelineParams, type UsePadPipelineResult } from "../use-pad-pipeline";

// One store per dbName across mounts, so a second mount reuses the first's queue the way a real reload keeps
// IndexedDB (use-pad-pipeline.test.tsx's own seam, same reason).
const queueStoreRegistry = vi.hoisted(() => new Map<string, QueueStore>());
vi.mock("../queue-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../queue-store")>();
  return {
    ...actual,
    indexedDbQueueStore: (dbName: string): QueueStore => {
      const existing = queueStoreRegistry.get(dbName);
      if (existing !== undefined) return existing;
      const fresh = actual.memoryQueueStore();
      queueStoreRegistry.set(dbName, fresh);
      return fresh;
    },
  };
});
beforeEach(() => queueStoreRegistry.clear());

const ME: OwnIdentity = { recordedBy: "user-1", deviceLinkId: "dl-1" };
const tick = () => new Promise<void>((r) => setTimeout(r, 0));
const settle = async () => {
  for (let i = 0; i < 20; i++) await tick();
};

// single-sport: badminton — the brief's P5 format (best of 3 → 5), and a kernel whose state carries the cfg it folded
// under, so "which rules is the pad folding" is read off the hook's own output.
const BADMINTON = builtinModules.find((m) => m.key === "badminton")!;
const badminton = resolveModuleClient("badminton", BADMINTON.version);
const CFG3 = badminton.configSchema.parse(BADMINTON.variants.short) as { bestOf: number };
const CFG5 = badminton.configSchema.parse({ ...BADMINTON.variants.short, bestOf: 5 }) as { bestOf: number };
const lineups = defaultLineupPair(resolvePositions(badminton, CFG3));
const START: EventEnvelope = {
  id: "e-1",
  fixtureId: "fx-1",
  seq: 1,
  type: "core.start",
  payload: {},
  recordedAt: "2026-10-15T00:00:01.000Z",
  recordedBy: "user-1",
};
const GAME = { home: 11, away: 5 };
const foldedBestOf = (r: UsePadPipelineResult) => (r.state as { cfg: { bestOf: number } }).cfg.bestOf;

const ok = (seq: number, rulesVersion?: number): AppendCallResult => ({
  kind: "ok",
  data: { seq, state_summary: null, outcome: null, status: "in_play", ...(rulesVersion === undefined ? {} : { rules_version: rulesVersion }) },
});
const rulesChangedRefusal = (rulesVersion: number): AppendCallResult => ({
  kind: "rejected",
  code: "FIXTURE_RULES_CHANGED",
  message: "changed",
  rulesVersion,
});

/** A scripted transport: appends answered in call order; GET /rules answered by `rules` (deferred when given one). */
function scripted(opts: { appends: AppendCallResult[]; rules?: () => Promise<FixtureRulesResult> }) {
  const appendCalls: AppendEventBody[] = [];
  const rulesCalls: string[] = [];
  let cursor = 0;
  const transport: PadTransport = {
    async appendEvent(_fixtureId, body) {
      appendCalls.push(body);
      const next = opts.appends[cursor++];
      if (!next) throw new Error(`scripted: no append answer left (call #${cursor})`);
      return next;
    },
    async listEventsSince(): Promise<LedgerSlotEvent[]> {
      return [];
    },
    async getLastSeq() {
      return 0;
    },
    async fetchState(): Promise<FixtureStateResult> {
      return { status: "in_play", last_seq: 0, state: null, summary: null, outcome: null };
    },
    async getRules(fixtureId) {
      rulesCalls.push(fixtureId);
      if (!opts.rules) throw new Error("scripted: GET /rules not expected");
      return opts.rules();
    },
  };
  return { transport, appendCalls, rulesCalls };
}

function params(overrides: Partial<UsePadPipelineParams>): UsePadPipelineParams {
  return {
    fixtureId: "fx-1",
    module: badminton,
    cfg: CFG3,
    lineups,
    identity: ME,
    transport: scripted({ appends: [] }).transport,
    initialEvents: [START],
    auth: { kind: "device_link", token: "dl_t" },
    // The live stream confirms synchronously and never polls (use-pad-pipeline.test.tsx's default double).
    streamFetchFn: (async () =>
      new Response(JSON.stringify({ ok: true, data: { token: "t", channel: "c" } }), { status: 200 })) as unknown as typeof fetch,
    streamConnector: { connect: (p) => (p.onStatus(true), { unsubscribe() {} }) },
    ...overrides,
  };
}

function mount(p: UsePadPipelineParams) {
  let latest!: UsePadPipelineResult;
  function Probe(props: { p: UsePadPipelineParams; onReady: (r: UsePadPipelineResult) => void }) {
    props.onReady(usePadPipeline(props.p));
    return null;
  }
  const island = renderIsland(Probe, { p, onReady: (r) => (latest = r) });
  return {
    get current() {
      return latest;
    },
    rerender: (next: UsePadPipelineParams) => island.rerender({ p: next, onReady: (r) => (latest = r) }),
    unmount: () => island.unmount(),
  };
}

/** A fetch double answering like the real API: v1 envelopes, the POST by `post`, every GET by `get`. */
function apiFetch(post: (body: Record<string, unknown>) => { status: number; body: unknown }) {
  const posts: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      posts.push({ url, headers: init.headers as Record<string, string>, body });
      const a = post(body);
      return new Response(JSON.stringify(a.body), { status: a.status });
    }
    if (url.endsWith("/state")) {
      return new Response(
        JSON.stringify({ ok: true, data: { status: "in_play", last_seq: 1, state: null, summary: null, outcome: null } }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({ ok: true, data: [] }), { status: 200 });
  }) as typeof fetch;
  return { fn, posts };
}

describe("X-SR-7 the remote pad's tap carries the rules version (the real tap path)", () => {
  it("carries the rules_version: a remote pad loaded at version 3 sends 3 on its POST, under its device-link token", async () => {
    const api = apiFetch(() => ({ status: 201, body: { ok: true, data: { seq: 2, state_summary: null, outcome: null, status: "in_play", event_id: "r-2", rules_version: 3 } } }));
    const pad = mount(params({ rulesVersion: 3, transport: deviceLinkTransport("dl_secret", { fetchFn: api.fn }) }));
    await pad.current.submit("badminton.game.summary", GAME);
    await settle();
    expect(api.posts.length, "the tap reached the wire").toBe(1);
    expect(api.posts[0]!.url).toBe("/api/v1/fixtures/fx-1/events");
    expect(api.posts[0]!.headers.Authorization).toBe("Bearer dl_secret");
    expect(api.posts[0]!.body).toMatchObject({ expected_seq: 1, type: "badminton.game.summary", rules_version: 3 });
    expect(pad.current.rulesChanged, "an ack at the pad's own version is no news").toBeNull();
  });

  it("the empty case: a pad loaded with no version sends no field at all (never checked)", async () => {
    const api = apiFetch(() => ({ status: 201, body: { ok: true, data: { seq: 2, state_summary: null, outcome: null, status: "in_play" } } }));
    const pad = mount(params({ transport: deviceLinkTransport("dl_secret", { fetchFn: api.fn }) }));
    await pad.current.submit("badminton.game.summary", GAME);
    await settle();
    expect(api.posts.length).toBe(1);
    expect(Object.hasOwn(api.posts[0]!.body, "rules_version"), "absent, not null, not 0").toBe(false);
  });

  it("a queued tap keeps the version it was captured with across a reload, and is refused, not re-stamped", async () => {
    // Mount 1, offline: the tap is queued at version 0.
    const offline = scripted({ appends: [{ kind: "network-error", message: "down" }] });
    const first = mount(params({ rulesVersion: 0, transport: offline.transport, queueDbName: "q-replay" }));
    await first.current.submit("badminton.game.summary", GAME);
    await settle();
    expect(first.current.queueDepth, "premise: queued").toBe(1);
    first.unmount();

    // The organiser corrects the match; the page reloads at version 1 with the corrected cfg; the queue resumes.
    const online = scripted({
      appends: [rulesChangedRefusal(1)],
      rules: async () => ({ cfg: CFG5, rules_version: 1, format_line: "Best of 5" }),
    });
    const second = mount(params({ rulesVersion: 1, cfg: CFG5, transport: online.transport, queueDbName: "q-replay" }));
    await settle();
    expect(online.appendCalls.length, "the queued tap was replayed once").toBe(1);
    expect(online.appendCalls[0]!.rules_version, "with the version it was captured under, never the new one").toBe(0);
    expect(second.current.queueDepth, "refused, so dropped — never resent under the new rules").toBe(0);
    expect(second.current.lastRejection?.code).toBe("FIXTURE_RULES_CHANGED");
    expect(online.appendCalls.length, "no resend").toBe(1);
  });
});

describe("X-SR-7 the transport classifies the refusal", () => {
  const refusal = (extra: Record<string, unknown>) =>
    (async () =>
      new Response(
        JSON.stringify({ ok: false, error: { code: "FIXTURE_RULES_CHANGED", message: "The organiser changed it", ...extra } }),
        { status: 409 },
      )) as unknown as typeof fetch;
  const body: AppendEventBody = { expected_seq: 1, type: "badminton.game.summary", payload: GAME, idempotency_key: "k", rules_version: 0 };

  it("FIXTURE_RULES_CHANGED is a refusal (never a renegotiable conflict), carrying the server's version", async () => {
    expect(TERMINAL_CONFLICT_CODES.has("FIXTURE_RULES_CHANGED")).toBe(true);
    const out = await sessionTransport({ fetchFn: refusal({ rules_version: 2, format: "Best of 5" }) }).appendEvent("fx-1", body);
    expect(out).toEqual({ kind: "rejected", code: "FIXTURE_RULES_CHANGED", message: "The organiser changed it", rulesVersion: 2 });
  });

  it("a malformed version is carried as nothing rather than a hole", async () => {
    for (const extra of [{}, { rules_version: "2" }, { rules_version: -1 }, { rules_version: 1.5 }]) {
      const out = await sessionTransport({ fetchFn: refusal(extra) }).appendEvent("fx-1", body);
      expect(out, JSON.stringify(extra)).toEqual({ kind: "rejected", code: "FIXTURE_RULES_CHANGED", message: "The organiser changed it" });
    }
  });

  it("GET /rules reads the cfg, the version and the format line through the device link", async () => {
    const seen: { url: string; auth: string | undefined }[] = [];
    const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(input), auth: (init?.headers as Record<string, string> | undefined)?.Authorization });
      return new Response(JSON.stringify({ ok: true, data: { cfg: CFG5, rules_version: 1, format_line: "Best of 5" } }), { status: 200 });
    }) as typeof fetch;
    await expect(deviceLinkTransport("dl_secret", { fetchFn: fn }).getRules!("fx-1")).resolves.toEqual({
      cfg: CFG5,
      rules_version: 1,
      format_line: "Best of 5",
    });
    expect(seen).toEqual([{ url: "/api/v1/fixtures/fx-1/rules", auth: "Bearer dl_secret" }]);
  });
});

describe("X-SR-7 the pad follows a correction", () => {
  it("on the refusal: the tap is dropped, the rules reloaded, the fold moves to them, the pad says so, and the next tap carries the new version", async () => {
    const t = scripted({
      appends: [rulesChangedRefusal(1), ok(2, 1)],
      rules: async () => ({ cfg: CFG5, rules_version: 1, format_line: "Best of 5" }),
    });
    const pad = mount(params({ rulesVersion: 0, transport: t.transport }));
    expect(foldedBestOf(pad.current), "premise: folding the loaded rules").toBe(CFG3.bestOf);
    expect(pad.current.rulesChanged, "the empty case: nothing changed yet").toBeNull();

    await pad.current.submit("badminton.game.summary", GAME);
    await settle();
    expect(t.appendCalls[0]!.rules_version).toBe(0);
    expect(pad.current.queueDepth, "dropped").toBe(0);
    expect(pad.current.lastRejection?.code, "said out loud: the tap was not recorded").toBe("FIXTURE_RULES_CHANGED");
    expect(t.rulesCalls).toEqual(["fx-1"]);
    expect(foldedBestOf(pad.current), "the fold moved to the corrected rules").toBe(CFG5.bestOf);
    expect(pad.current.cfg).toEqual(CFG5);
    expect(pad.current.rulesChanged).toEqual({ formatLine: "Best of 5", rulesVersion: 1 });

    // The second call: the scorer retakes the tap under the new rules.
    await pad.current.submit("badminton.game.summary", { home: 11, away: 6 });
    await settle();
    expect(t.appendCalls[1]!.rules_version, "the next tap carries the version it now folds under").toBe(1);
    expect(t.rulesCalls.length, "no second reload for an ack at the current version").toBe(1);
  });

  it("an ack naming a newer version (a pad that learnt it from a replayed answer) reloads too", async () => {
    const t = scripted({
      appends: [ok(2, 4)],
      rules: async () => ({ cfg: CFG5, rules_version: 4, format_line: null }),
    });
    const pad = mount(params({ rulesVersion: 3, transport: t.transport }));
    await pad.current.submit("badminton.game.summary", GAME);
    await settle();
    expect(t.rulesCalls).toEqual(["fx-1"]);
    expect(foldedBestOf(pad.current)).toBe(CFG5.bestOf);
    expect(pad.current.rulesChanged, "no line to say: the banner says the format changed, without one").toEqual({ formatLine: null, rulesVersion: 4 });
  });

  it("the negative pair: any other refusal reloads nothing, and the pad keeps its rules", async () => {
    const t = scripted({ appends: [{ kind: "rejected", code: "UNDO_NOOP", message: "nothing to undo" }] });
    const pad = mount(params({ rulesVersion: 0, transport: t.transport }));
    await pad.current.submit("badminton.game.summary", GAME);
    await settle();
    expect(pad.current.lastRejection?.code).toBe("UNDO_NOOP");
    expect(t.rulesCalls, "GET /rules never asked").toEqual([]);
    expect(pad.current.rulesChanged).toBeNull();
    expect(foldedBestOf(pad.current)).toBe(CFG3.bestOf);
  });

  it("two stale taps refused while the reload is in flight cost ONE reload", async () => {
    let release!: (r: FixtureRulesResult) => void;
    const gate = new Promise<FixtureRulesResult>((r) => (release = r));
    const t = scripted({ appends: [{ kind: "network-error", message: "down" }, rulesChangedRefusal(1), rulesChangedRefusal(1)], rules: () => gate });
    const pad = mount(params({ rulesVersion: 0, transport: t.transport }));
    await pad.current.submit("badminton.game.summary", GAME); // stays queued (offline)
    await settle();
    await pad.current.submit("badminton.game.summary", { home: 11, away: 7 }); // drains both: each is refused
    await settle();
    expect(t.appendCalls.map((b) => b.rules_version), "both carried the version they were captured with").toEqual([0, 0, 0]);
    expect(pad.current.queueDepth).toBe(0);
    release({ cfg: CFG5, rules_version: 1, format_line: "Best of 5" });
    await settle();
    expect(t.rulesCalls.length).toBe(1);
    expect(foldedBestOf(pad.current)).toBe(CFG5.bestOf);
  });

  it("the page's own reload wins: once the parent hands down the corrected rules, the pad folds the props again", async () => {
    const t = scripted({
      appends: [rulesChangedRefusal(1)],
      rules: async () => ({ cfg: CFG5, rules_version: 1, format_line: "Best of 5" }),
    });
    const pad = mount(params({ rulesVersion: 0, transport: t.transport }));
    await pad.current.submit("badminton.game.summary", GAME);
    await settle();
    expect(foldedBestOf(pad.current)).toBe(CFG5.bestOf);
    // A second correction, read by the page's own refresh (version 2, back to best of 3): the props are newer than the
    // reload, so they win.
    pad.rerender(params({ rulesVersion: 2, cfg: CFG3, transport: t.transport }));
    await settle();
    expect(foldedBestOf(pad.current)).toBe(CFG3.bestOf);
    expect(pad.current.cfg).toEqual(CFG3);
  });
});
