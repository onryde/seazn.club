// v3/__tests__/refused-write.test.ts — R6 FIX PASS 3, GAP 1 (ship-blocker).
//
// FOUND BY DRIVING THE PRODUCT, NOT BY ANY SUITE. On a band-1 (free) org the
// ice-hockey pad offered the Penalty tile, the server answered
//
//     402 {"code":"PAYMENT_REQUIRED","feature":"scoring.match_timeline",…}
//
// the ledger kept only `core.start` — and the pad rendered the penalty AS
// RECORDED: ribbon "Penalty — Minor · Undo", two rows in Activity, an "ON ICE
// 3V5" strength chip, and a ticking 2:00 countdown, with no rejection banner
// anywhere. The scorer believed two penalties were on the sheet and that the
// side was short. Nothing was. In hockey the on-ice strength is MATCH STATE,
// not decoration, so this is a lying pad, not a cosmetic gap.
//
// ROOT CAUSE. `transport.ts`'s `appendEvent` classified exactly two non-2xx
// statuses — 409 -> `conflict`, 422 -> `rejected` — and let EVERY other one
// fall through to `{ kind: "network-error" }`. `pipeline.ts`'s `sendOne` turns
// that into `stayed-queued/network`; `use-pad-pipeline.ts` handles that branch
// with `setOffline(true); break`, which KEEPS the optimistic envelope in
// `pendingEnvelopes` and never sets `lastRejection`. So the whole 4xx
// client-error class — 400, 401, 402, 403, 404 — was treated as a flaky
// network, retried forever, and displayed as recorded forever.
//
// WHY A STATUS CLASS AND NOT AN ENTITLEMENT SPECIAL CASE. A refusal is a
// refusal. 402 is one instance; a 403 (device link revoked mid-match) and a
// 401 (session expired) had exactly the same symptom and were equally silent.
// What is genuinely transient is 5xx, a thrown fetch, and the two retry-after
// statuses (408/429) — those keep the queue, because retrying them is what the
// offline queue is FOR.
//
// HOW THIS TEST REFUSES. Through the real path, end to end, no scripted
// double: the real `sessionTransport` over an injected `fetch` that answers
// the POST with the ACTUAL 402 envelope captured from the running server; the
// real `usePadPipeline` hook; the real ice-hockey kernel doing the fold; and
// the pad's OWN four surfaces — `buildTopRibbon`, the activity rows, the
// strength chip off `summary.detail`, and `boxOf`'s countdown — read off the
// hook's live output. A fixture on both ends would only prove the fixture.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { EventEnvelope } from "@seazn/engine/core";
import { renderIsland } from "@/components/__tests__/_hook-harness";
import type { MsgFn } from "@/lib/scoring-vocab";
import { sessionTransport } from "../../transport";
import { usePadPipeline, type UsePadPipelineParams, type UsePadPipelineResult } from "../../use-pad-pipeline";
import { resolveModuleClient } from "../../module-client";
import { buildTopRibbon, rejectionText } from "../pad-host";
import type { ActivityEvent } from "../activity";
import { boxOf, eventTypesOf } from "../skins/period-shared";
import { icehockeySpec } from "../skins/icehockey";
import type { PadHostView } from "../types";
import { icehockey, lineupsFor, periodCfg, summaryOf, type PeriodStateLike } from "./_period-fold";

const identityMsg = ((key: string) => key) as MsgFn;
const tick = () => new Promise<void>((r) => setTimeout(r, 0));
const settle = async () => {
  for (let i = 0; i < 12; i++) await tick();
};

/** The exact 402 ENVELOPE the pad was handed when it lied, captured verbatim
 *  from the running server (`report-band1.json`). Its SHAPE is what this file
 *  is about: an ID-bearing English `message` the pad must never show, and the
 *  marketing `reason` beside it.
 *
 *  W1 (entitlements v18, 2026-09-02) — the FEATURE moved, the shape did not.
 *  The capture named `scoring.match_timeline`; V390 deleted that row and Task
 *  3 deleted its gate, so `scoreEvent` can no longer answer 402 for it at all
 *  and a fixture naming it would prove this pad against a refusal production
 *  cannot produce. `cricket.dls` is the ONE feature the scoring door still
 *  refuses on (`requiresDlsEntitlement`, scoring.ts), and its `reason` is the
 *  live `FEATURE_REASONS` sentence, so the envelope stays a real one. */
const PAYMENT_REQUIRED_BODY = {
  ok: false,
  error: {
    code: "PAYMENT_REQUIRED",
    message: "Plan upgrade required: cricket.dls",
    feature: "cricket.dls",
    feature_key: "cricket.dls",
    reason: "DLS revised targets are a Pro feature — a manual umpire target still works.",
  },
  requestId: "e17a1a99-8fcf-4631-a75c-b0929991c19b",
};

const RAW_402_PROSE = PAYMENT_REQUIRED_BODY.error.message;

function fakeResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

const FIXTURE_ID = "fx-band1";
const CFG = periodCfg(icehockey);
const LINEUPS = lineupsFor(icehockey, CFG);
const TYPES = eventTypesOf(icehockeySpec);

/** The ledger the server really held: `core.start`, and nothing else. */
const START: EventEnvelope = {
  id: "srv-1",
  fixtureId: FIXTURE_ID,
  seq: 1,
  type: "core.start",
  payload: {},
  recordedAt: "2026-08-30T10:00:00.000Z",
  recordedBy: "user-1",
};

/**
 * The pad's whole read side, rebuilt from a live `usePadPipeline` result
 * exactly as `PadHostV3` builds it (pad-host.tsx: `activityEvents` from
 * `pipeline.events`, `view` from `pipeline.state`/`pipeline.summary`) — so a
 * regression here is a regression in what a scorer SEES, not in a hook field.
 */
function padSurfaces(result: UsePadPipelineResult) {
  const state = result.state as PeriodStateLike;
  const activityEvents: ActivityEvent[] = result.events.map((e) => ({
    id: e.id,
    seq: e.seq,
    type: e.type,
    payload: e.payload,
    voids: e.voids ?? null,
  }));
  const view = {
    cfg: CFG,
    state,
    summary: result.summary,
    phase: "live",
    band: 1,
    entitlements: {},
    personNames: {},
    squads: undefined,
    events: result.events,
    contextOverrides: {},
  } as unknown as PadHostView;
  const detail = (result.summary as { detail?: Record<string, unknown> } | null)?.detail ?? {};
  return {
    /** The top ribbon's line, or null with nothing recorded. */
    ribbon: buildTopRibbon(activityEvents, (id) => id, identityMsg, undefined),
    /** Every row the Activity panel would render. */
    activityTypes: activityEvents.map((e) => e.type),
    /** The scorebug strip's on-ice chip — kernel-owned, never pad-computed. */
    strength: detail.strength ?? null,
    /** Every countdown the box would tick. */
    box: boxOf(view),
    /** What the rejection banner shows, or null when it renders nothing. */
    banner: rejectionText(result.lastRejection, identityMsg),
    /** The pad's own fold — what survives on a reload. */
    suspensions: (state.suspensions ?? []) as unknown[],
  };
}

function mountPad(fetchFn: typeof fetch) {
  const params: UsePadPipelineParams = {
    fixtureId: FIXTURE_ID,
    module: resolveModuleClient("icehockey", icehockey.version),
    cfg: CFG,
    lineups: LINEUPS,
    identity: { recordedBy: "user-1", deviceLinkId: null },
    // THE REAL TRANSPORT. Its own status classification is the thing under
    // test; a scripted `PadTransport` double would hand the hook a verdict
    // this bug is precisely about getting wrong.
    transport: sessionTransport({ fetchFn }),
    initialEvents: [START],
    queueDbName: `refused-${Math.random()}`,
    auth: { kind: "session" },
    streamFetchFn: (async () => fakeResponse(200, { ok: true, data: { token: "t", channel: "c" } })) as unknown as typeof fetch,
    streamConnector: { connect: (p: { onStatus: (ok: boolean) => void }) => { p.onStatus(true); return { unsubscribe() {} }; } } as never,
  };
  let latest!: UsePadPipelineResult;
  function Probe(props: { onReady: (r: UsePadPipelineResult) => void }) {
    props.onReady(usePadPipeline(params));
    return null;
  }
  renderIsland(Probe, { onReady: (r: UsePadPipelineResult) => (latest = r) });
  return {
    get current() {
      return latest;
    },
  };
}

/** A `fetch` double that answers the POST with `status`/`body` and serves the
 *  two reads off the untouched one-event ledger — i.e. the server's honest
 *  answer: nothing was recorded. */
function refusingFetch(status: number, body: unknown) {
  const posts: string[] = [];
  const serverState = {
    status: "in_play",
    last_seq: 1,
    state: null,
    summary: null,
    outcome: null,
  };
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "POST") {
      posts.push(String(JSON.parse(String(init.body)).type));
      return fakeResponse(status, body);
    }
    if (url.includes("/state")) return fakeResponse(200, { ok: true, data: serverState });
    if (url.includes("/events")) {
      return fakeResponse(200, {
        ok: true,
        data: [
          {
            id: START.id,
            seq: START.seq,
            type: START.type,
            payload: START.payload,
            recorded_at: START.recordedAt,
            recorded_by: START.recordedBy,
            device_link_id: null,
            voids_event_id: null,
          },
        ],
      });
    }
    return fakeResponse(200, { ok: true, data: { token: "t", channel: "c" } });
  }) as unknown as typeof fetch;
  return { fn, posts };
}

// ---------------------------------------------------------------------------
// 1. THE REPRODUCTION. Drive the exact 402 the server sent, and demand that
//    every one of the four surfaces the walkthrough photographed is EMPTY.
// ---------------------------------------------------------------------------

describe("a refused write is never rendered as recorded (R6 fix pass 3, gap 1)", () => {
  it("the 402 the running server actually sent leaves no ribbon, no activity row, no strength change and no countdown", async () => {
    const { fn, posts } = refusingFetch(402, PAYMENT_REQUIRED_BODY);
    const pad = mountPad(fn);
    await settle();

    const before = padSurfaces(pad.current);
    expect(before.activityTypes).toEqual(["core.start"]);

    await pad.current.submit(TYPES.suspStart, { by: "H", class: "minor" });
    await settle();

    // The write really was attempted through the real transport.
    expect(posts).toContain(TYPES.suspStart);

    const after = padSurfaces(pad.current);

    // (a) NO ACTIVITY ROW. The walkthrough saw two "Penalty — Minor" rows.
    expect(after.activityTypes).toEqual(["core.start"]);
    expect(after.activityTypes).not.toContain(TYPES.suspStart);

    // (b) NO RIBBON. The walkthrough saw "Penalty — Minor · Undo".
    expect(after.ribbon?.text ?? null).toBe(before.ribbon?.text ?? null);

    // (c) NO STRENGTH CHANGE. The walkthrough saw "ON ICE 3V5" — match state,
    //     wrong, on the one chip a scorer reads without thinking.
    expect(after.strength).toEqual(before.strength);

    // (d) NO COUNTDOWN. The walkthrough saw "BACK ON MINOR" ticking from 2:00.
    expect(after.box).toEqual([]);

    // …and nothing is in the fold, so a reload shows the same thing the pad
    // does right now. That equality is the whole point: the pad and the
    // server had drifted apart with no way for the scorer to tell.
    expect(after.suspensions).toEqual([]);
  });

  it("the refusal is VISIBLE, in the pad's own voice, never the server's ID-bearing English", async () => {
    const { fn } = refusingFetch(402, PAYMENT_REQUIRED_BODY);
    const pad = mountPad(fn);
    await settle();
    await pad.current.submit(TYPES.suspStart, { by: "H", class: "minor" });
    await settle();

    const { banner } = padSurfaces(pad.current);
    // Something is on screen at all — the walkthrough found NOTHING.
    expect(banner).not.toBeNull();
    // …and it is a message key this pad owns, not the server's prose.
    expect(banner).not.toBe(RAW_402_PROSE);
    expect(banner).not.toContain("cricket.dls");
    expect(banner).toMatch(/^scorepad\./);
  });

  it("stops calling the pad offline — the device is online; the server said no", async () => {
    const { fn } = refusingFetch(402, PAYMENT_REQUIRED_BODY);
    const pad = mountPad(fn);
    await settle();
    await pad.current.submit(TYPES.suspStart, { by: "H", class: "minor" });
    await settle();

    expect(pad.current.offline).toBe(false);
    // The queue is not holding a write that can never land.
    expect(pad.current.queueDepth).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 2. NOT AN ENTITLEMENT SPECIAL CASE. Every 4xx the server can answer this
//    endpoint with (http.ts `statusCode`) had the identical silent symptom.
// ---------------------------------------------------------------------------

describe("every permanent refusal rolls back, not just the entitlement one", () => {
  const CASES: readonly { status: number; code: string; note: string }[] = [
    { status: 400, code: "VALIDATION", note: "a payload the route schema refused" },
    { status: 401, code: "UNAUTHENTICATED", note: "the session expired mid-match" },
    { status: 402, code: "PAYMENT_REQUIRED", note: "the band-1 entitlement gate" },
    { status: 403, code: "FORBIDDEN", note: "a device link revoked mid-match" },
    { status: 404, code: "NOT_FOUND", note: "the fixture was deleted under the pad" },
  ];

  for (const { status, code, note } of CASES) {
    it(`${status} ${code} (${note}) is rolled back and surfaced`, async () => {
      const { fn } = refusingFetch(status, { ok: false, error: { code, message: `raw ${code} prose` } });
      const pad = mountPad(fn);
      await settle();
      await pad.current.submit(TYPES.suspStart, { by: "H", class: "minor" });
      await settle();

      const after = padSurfaces(pad.current);
      expect(after.activityTypes).toEqual(["core.start"]);
      expect(after.box).toEqual([]);
      expect(after.suspensions).toEqual([]);
      expect(after.banner).not.toBeNull();
      expect(after.banner).not.toBe(`raw ${code} prose`);
      expect(pad.current.offline).toBe(false);
    });
  }
});

// ---------------------------------------------------------------------------
// 3. THE OTHER DIRECTION. A genuinely transient failure must STILL keep the
//    scorer's action — that is what the offline queue exists for, and a fix
//    that rolled everything back would be a worse bug than the one it fixed.
// ---------------------------------------------------------------------------

describe("a transient failure still keeps the action queued and the optimistic fold showing", () => {
  for (const status of [500, 502, 429, 408] as const) {
    it(`${status} keeps the write queued and the pad showing it`, async () => {
      const { fn } = refusingFetch(status, { ok: false, error: { code: "INTERNAL", message: "boom" } });
      const pad = mountPad(fn);
      await settle();
      await pad.current.submit(TYPES.suspStart, { by: "H", class: "minor" });
      await settle();

      const after = padSurfaces(pad.current);
      // Still on screen — the scorer's tap is not lost.
      expect(after.activityTypes).toContain(TYPES.suspStart);
      expect(after.box.length).toBeGreaterThan(0);
      // …and still queued, so a later drain sends it.
      expect(pad.current.queueDepth).toBeGreaterThan(0);
      expect(pad.current.lastRejection).toBeNull();
    });
  }
});

// ---------------------------------------------------------------------------
// 4. A 409 IS NEITHER. It renegotiates — the append/replay protocol's own
//    path — and this fix must not have swallowed it into the permanent class.
// ---------------------------------------------------------------------------

describe("409 still renegotiates rather than being refused outright", () => {
  it("a conflict is not turned into a permanent rejection", async () => {
    let firstPost = true;
    const posts: string[] = [];
    const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST") {
        posts.push(String(JSON.parse(String(init.body)).expected_seq));
        if (firstPost) {
          firstPost = false;
          return fakeResponse(409, { ok: false, error: { code: "SEQ_CONFLICT", message: "stale", current_seq: 4 } });
        }
        return fakeResponse(201, {
          ok: true,
          data: { seq: 5, state_summary: { headline: "0-0" }, outcome: null, status: "in_play" },
        });
      }
      if (url.includes("/state")) {
        return fakeResponse(200, { ok: true, data: { status: "in_play", last_seq: 4, state: null, summary: null, outcome: null } });
      }
      if (url.includes("/events")) {
        // A FOREIGN row already sitting in the slot this write aimed at
        // (`targetSeqFor(expected_seq)` = expected_seq + 1 = 2) — which is
        // what makes `resolveConflict` return `renegotiate` rather than
        // `indeterminate`. Another official scored while this pad was typing.
        return fakeResponse(200, {
          ok: true,
          data: [
            {
              id: "srv-2",
              seq: 2,
              type: "icehockey.goal",
              payload: { by: "A" },
              recorded_at: "2026-08-30T10:01:00.000Z",
              recorded_by: "someone-else",
              device_link_id: null,
              voids_event_id: null,
            },
          ],
        });
      }
      return fakeResponse(200, { ok: true, data: { token: "t", channel: "c" } });
    }) as unknown as typeof fetch;

    const pad = mountPad(fn);
    await settle();
    await pad.current.submit(TYPES.suspStart, { by: "H", class: "minor" });
    await settle();

    // Two POSTs — the original expected_seq and the renegotiated one.
    expect(posts.length).toBe(2);
    expect(posts[1]).not.toBe(posts[0]);
    expect(pad.current.lastRejection).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 5. THE SUMMARY THE WALKTHROUGH READ. `summaryOf` on the untouched ledger is
//    the honest answer; the pad must agree with it after a refusal. Pinned
//    against the REAL kernel so a preset change moves this with it.
// ---------------------------------------------------------------------------

describe("after a refusal the pad's fold equals the server's own", () => {
  it("matches foldMatch over the ledger the server actually kept", async () => {
    const { fn } = refusingFetch(402, PAYMENT_REQUIRED_BODY);
    const pad = mountPad(fn);
    await settle();
    await pad.current.submit(TYPES.suspStart, { by: "H", class: "minor" });
    await settle();

    const honest = summaryOf(icehockey, pad.current.state as PeriodStateLike);
    expect(pad.current.summary).toEqual(honest);
    expect((pad.current.state as PeriodStateLike).suspensions ?? []).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 6. THE BANNER IS A LIVE REGION. Caught by this task's own mutation sweep:
//    deleting `role="alert"` from the rejection banner left all 130 tests
//    green, which by this repo's own rule means the attribute was decoration.
//
//    It is not. Since the fix, the optimistic ribbon/row/chip/countdown are
//    all rolled back, so this banner is the ONLY evidence the tap happened —
//    and it materialises mid-match, on a screen a scorer is not looking at.
//    A bare <p> appearing in the DOM is announced to nobody.
//
//    Pinned at source: `apps/web` vitest is `environment: "node"` and the
//    banner is one branch deep inside `PadHostV3`'s render, so rendering it
//    would mean standing up the whole pipeline. The PAIRING is what is
//    asserted — `role` and `data-role` on the SAME element — never the mere
//    presence of the string somewhere in an 80KB file, which would pass with
//    the attribute sitting on any unrelated node.
// ---------------------------------------------------------------------------

describe("the rejection banner announces itself", () => {
  /** The opening tag that carries `data-role="v3-rejection"`, with `//` line
   *  comments stripped first — the surrounding JSDoc contains a literal `<p>`
   *  that would otherwise derail the scan. */
  function rejectionOpeningTag(): string {
    const src = readFileSync(
      join(process.cwd(), "src/components/v2/scorepad/v3/pad-host.tsx"),
      "utf8",
    ).replace(/^\s*\/\/.*$/gm, "");
    const marker = src.indexOf('data-role="v3-rejection"');
    expect(marker, "the rejection banner is gone entirely").toBeGreaterThan(-1);
    const open = src.lastIndexOf("<", marker);
    const close = src.indexOf(">", marker);
    expect(open).toBeGreaterThan(-1);
    expect(close).toBeGreaterThan(open);
    return src.slice(open, close + 1);
  }

  it("the element carrying data-role=v3-rejection is itself the live region", () => {
    const tag = rejectionOpeningTag();
    expect(tag).toContain('data-role="v3-rejection"');
    expect(tag, "the refusal banner is not announced — see this block's header").toContain('role="alert"');
  });

  it("the scan really is scoped to one element, not the whole file", () => {
    // Guards the guard: if `rejectionOpeningTag` ever returned the file, the
    // assertion above would pass on any stray `role="alert"` anywhere.
    const tag = rejectionOpeningTag();
    expect(tag.length).toBeLessThan(400);
    expect(tag.startsWith("<")).toBe(true);
    expect(tag.endsWith(">")).toBe(true);
  });
});
