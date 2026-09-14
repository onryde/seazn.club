// Task 9 — the tap driver + generic adapter. Drives a FAKE page and a FAKE
// ledger transport, so this runs with no browser and no server; it proves
// the ORDER of operations and the GUARDS (one-behind verification, status
// transitions, no fallback POST) — never the real DOM, which only a live
// run (Task 10/13) can prove (AGENTS.md failure class 2).
//
// The brief's own sketch test (`task-9-brief.md` step 1) is missing
// `stream.home`/`stream.away` and a `cfg` — both load-bearing for the real
// `TapAdapterContext` this driver builds (a half tap has to know which SIDE
// a resolved entrant id is), and its own `refIdByKey` only resolved one of
// the two entrants the adapter's `sideOf` compares against. Re-pinned here
// rather than copied verbatim (AGENTS.md failure class 5 — "the brief is a
// hypothesis").
import { describe, expect, it, vi } from "vitest";
import {
  FINALIZE_TESTID,
  playMatchByTaps,
  selectorForTapStep,
  SEND_NOW_TESTID,
  START_MATCH_TESTID,
  TAP_PACING_MS,
  type PadLocator,
  type PadPage,
  type PlayMatchInput,
  type TapAdapterContext,
} from "../drivers/scorer.ts";
import { resolvePayloadRefs } from "../simulate.ts";
import type { LedgerRow, LedgerTransport } from "../ledger.ts";
import type { RawResult, Session } from "../http.ts";
import { genericAdapter, RESULT_TYPE, SCORE_TYPE, SETTLE_TILE_ID, resultModeOf } from "../drivers/adapters/generic.ts";

// Real source-of-truth imports — TEST-ONLY (scorer.ts's own header: bench
// production code never imports apps/web; existing bench tests already do,
// e.g. board.test.ts/schedule.test.ts's own `../../../../apps/web/src/...`
// imports of api-v1/schemas.ts). Pins every mirrored constant/behaviour
// EQUAL to the real module, so a rename or a re-tune there reds this file
// instead of silently drifting (R39's own "restate, then prove equal to the
// source of truth" posture, generalised past just the pacing constant).
import { HUMAN_FASTEST_REPEAT_MS } from "../../../../apps/web/src/components/v2/scorepad/use-pad-pipeline.ts";
import {
  RESULT_TYPE as REAL_RESULT_TYPE,
  resultModeOf as realResultModeOf,
  SCORE_TYPE as REAL_SCORE_TYPE,
  SETTLE_TILE_ID as REAL_SETTLE_TILE_ID,
} from "../../../../apps/web/src/components/v2/scorepad/v3/skins/generic.tsx";

const HOME_REF = "e-home";
const AWAY_REF = "e-away";
const HOME_ID = "en-home";
const AWAY_ID = "en-away";

function refIdByKey(): Map<string, string> {
  return new Map([
    [HOME_REF, HOME_ID],
    [AWAY_REF, AWAY_ID],
  ]);
}

function stream(events: readonly { type: string; payload: unknown }[]) {
  return { home: HOME_REF, away: AWAY_REF, events };
}

const ENTRANTS = { home: HOME_ID, away: AWAY_ID };

// ---------------------------------------------------------------------------
// The fake pad + ledger. Models the REAL hold/flush semantics
// (`queue.ts`'s `flushHeldBefore`/`releaseHeld`) rather than returning
// canned responses keyed on call count — a scripted-by-call-count fake
// cannot tell "verified after the real flush" from "verified too early"
// apart, and this task's own mutant #4 (verification reordered) needs that
// distinction to be real. `selectors[i]` is the selector event `i` maps to
// — computed by the TEST from the real `genericAdapter` + `selectorForTapStep`,
// never guessed, so the harness is never a second copy of the adapter's own
// logic.
// ---------------------------------------------------------------------------
interface FakePad {
  readonly page: PadPage;
  readonly ledger: LedgerTransport;
  readonly clicks: string[];
  readonly calls: string[];
}

function buildFakePad(opts: {
  events: readonly { type: string; payload: unknown }[];
  selectors: readonly string[];
  /** Index whose commit flips status to "decided". Defaults to the last
   *  event — override to model a decided-EARLY defect. */
  decidesAt?: number;
  /** Override the payload actually recorded for one event index — models
   *  the server disagreeing with what the tap meant. */
  recordedPayloadOverride?: ReadonlyMap<number, unknown>;
  /** Models a product bug: core.start commits but status never leaves
   *  "scheduled". */
  stayScheduledAfterStart?: boolean;
  /** Models the fixture already being past "scheduled" before the driver
   *  ever taps anything — e.g. reused/mis-seeded fixture state. */
  initialStatus?: "scheduled" | "in_play" | "decided";
  /** Models a product bug: the last event's own row lands, but the
   *  fixture's status never flips to "decided" (stuck in_play forever). */
  neverDecides?: boolean;
}): FakePad {
  const clicks: string[] = [];
  const calls: string[] = [];
  const rows: LedgerRow[] = [];
  let seq = 0;
  let heldIndex: number | undefined;
  let status: "scheduled" | "in_play" | "decided" = opts.initialStatus ?? "scheduled";
  const decidesAt = opts.decidesAt ?? opts.events.length - 1;
  const selToIndex = new Map(opts.selectors.map((s, i) => [s, i] as const));

  function commit(index: number): void {
    seq += 1;
    const ev = opts.events[index]!;
    // The SERVER stores resolved ids, never the pack's own `@ref` sigil — a
    // real ledger row never carries "@e-home". Mirrors what the driver
    // itself resolves the pack payload to, so the happy path's committed
    // row actually equals what the driver expects, and a deliberate
    // mismatch is expressed via `recordedPayloadOverride` instead.
    const resolvedPayload = resolvePayloadRefs(ev.payload, refIdByKey(), "fake pad");
    const payload = opts.recordedPayloadOverride?.get(index) ?? resolvedPayload;
    rows.push({ id: `row-${seq}`, seq, type: ev.type, payload });
    if (index === decidesAt && !opts.neverDecides) status = "decided";
  }

  function makeLocator(sel: string): PadLocator {
    return {
      async click() {
        clicks.push(`click ${sel}`);
        if (sel === `[data-testid="${START_MATCH_TESTID}"]`) {
          commit(0);
          if (status !== "decided" && !opts.stayScheduledAfterStart) status = "in_play";
          return;
        }
        if (sel === `[data-testid="${SEND_NOW_TESTID}"]`) {
          if (heldIndex !== undefined) {
            commit(heldIndex);
            heldIndex = undefined;
          }
          return;
        }
        if (sel === `[data-testid="${FINALIZE_TESTID}"]`) return;
        const index = selToIndex.get(sel);
        if (index === undefined) throw new Error(`fake pad: unexpected selector ${sel}`);
        if (heldIndex !== undefined) commit(heldIndex);
        heldIndex = index;
      },
      async fill(v: string) {
        clicks.push(`fill ${sel}=${v}`);
      },
      async waitFor() {},
      async count() {
        return 1;
      },
    };
  }

  const page: PadPage = {
    locator: (sel: string) => makeLocator(sel),
    async goto(url: string) {
      clicks.push(`goto ${url}`);
    },
    async setViewportSize() {
      /* no-op */
    },
  };

  const ledger: LedgerTransport = {
    async raw(_base: string, _session: Session, path: string, method = "GET"): Promise<RawResult> {
      calls.push(`${method} ${path}`);
      if (path.includes("/state")) {
        return { status: 200, json: { ok: true, data: { status, last_seq: seq } } };
      }
      const m = /since_seq=(\d+)/.exec(path);
      const since = m ? Number(m[1]) : 0;
      const data = rows.filter((r) => r.seq > since);
      return { status: 200, json: { ok: true, data } };
    },
  };

  return { page, ledger, clicks, calls };
}

/** Selector per event, computed with the REAL adapter — `core.start` maps
 *  via `genericAdapter` too, so this is the one and only place a selector
 *  is decided anywhere in this file. */
function selectorsFor(events: readonly { type: string; payload: unknown }[], cfg: unknown): string[] {
  const ctx: TapAdapterContext = { cfg, entrants: ENTRANTS };
  return events.map((e) => {
    const resolved = { type: e.type, payload: resolvePayloadRefs(e.payload, refIdByKey(), "test") };
    const steps = genericAdapter.stepsFor(resolved, ctx);
    expect(steps.length, `test setup: ${e.type} must map to exactly one step`).toBe(1);
    return selectorForTapStep(steps[0]!);
  });
}

function makeInput(overrides: Partial<PlayMatchInput> & { pad: FakePad }): PlayMatchInput {
  const { pad, ...rest } = overrides;
  return {
    scorerPage: pad.page,
    organiserPage: pad.page,
    deviceUrl: "http://x/score/s3cret",
    fixtureId: "f1",
    stream: stream([]),
    adapter: genericAdapter,
    refIdByKey: refIdByKey(),
    ledger: pad.ledger,
    base: "http://x",
    session: { cookies: {} },
    sleep: async () => {},
    ...rest,
  };
}

// ---------------------------------------------------------------------------
// The happy path (brief's own sketch, re-pinned with real home/away refs).
// ---------------------------------------------------------------------------
describe("playMatchByTaps", () => {
  it("starts the match, taps each event, flushes the last and finalizes", async () => {
    const events = [
      { type: "core.start", payload: {} },
      { type: SCORE_TYPE, payload: { by: `@${HOME_REF}`, points: 1 } },
    ];
    const selectors = selectorsFor(events, undefined);
    const pad = buildFakePad({ events, selectors });

    const result = await playMatchByTaps(makeInput({ pad, stream: stream(events) }));

    expect(result.findings).toEqual([]);
    expect(result.fixtureId).toBe("f1");
    expect(result.taps).toBe(4); // start, half, send-now, finalize
    expect(pad.clicks).toContain(`click [data-testid="${START_MATCH_TESTID}"]`);
    expect(pad.clicks).toContain(`click [data-testid="${SEND_NOW_TESTID}"]`);
    expect(pad.clicks).toContain(`click [data-testid="${FINALIZE_TESTID}"]`);
    expect(pad.clicks.indexOf(`click [data-testid="${FINALIZE_TESTID}"]`)).toBeGreaterThan(
      pad.clicks.indexOf(`click [data-testid="${SEND_NOW_TESTID}"]`),
    );
    // R40 — no fallback: every read goes through the ONE injected transport,
    // and this driver never posts anything itself.
    expect(pad.calls.some((c) => !c.startsWith("GET "))).toBe(false);
  });

  it("verifies a held tap only once the NEXT tap flushes it (one behind)", async () => {
    const events = [
      { type: "core.start", payload: {} },
      { type: SCORE_TYPE, payload: { by: `@${HOME_REF}`, points: 1 } }, // not last — stays held
      { type: SCORE_TYPE, payload: { by: `@${AWAY_REF}`, points: 1 } }, // last — explicit flush
    ];
    const selectors = selectorsFor(events, undefined);
    const pad = buildFakePad({ events, selectors });

    const result = await playMatchByTaps(makeInput({ pad, stream: stream(events) }));

    expect(result.findings).toEqual([]);
    expect(result.taps).toBe(5); // start, half#1, half#2, send-now, finalize
  });

  it("reds when the server recorded a different payload than the taps meant", async () => {
    const events = [
      { type: "core.start", payload: {} },
      { type: SCORE_TYPE, payload: { by: `@${HOME_REF}`, points: 1 } },
    ];
    const selectors = selectorsFor(events, undefined);
    const pad = buildFakePad({
      events,
      selectors,
      recordedPayloadOverride: new Map([[1, { by: AWAY_ID, points: 1 }]]),
    });

    const result = await playMatchByTaps(makeInput({ pad, stream: stream(events) }));

    expect(result.findings.join(" ")).toContain("ledger");
    // R40 — a mismatch must never trigger a POST fallback either.
    expect(pad.calls.some((c) => !c.startsWith("GET "))).toBe(false);
  });

  it("reds when the fixture is decided before the stream's last event", async () => {
    const events = [
      { type: "core.start", payload: {} },
      { type: SCORE_TYPE, payload: { by: `@${HOME_REF}`, points: 1 } },
      { type: SCORE_TYPE, payload: { by: `@${AWAY_REF}`, points: 1 } },
    ];
    const selectors = selectorsFor(events, undefined);
    // decidesAt: 1 — the FIRST scoring event, not the (real) last one at
    // index 2. Committing it (which happens when event 2 is tapped and
    // flushes it) flips status to "decided" before event 2 has been sent.
    const pad = buildFakePad({ events, selectors, decidesAt: 1 });

    const result = await playMatchByTaps(makeInput({ pad, stream: stream(events) }));

    expect(result.findings.join(" ")).toContain("decided");
  });

  it("reds when the fixture is not \"scheduled\" before the very first tap", async () => {
    const events = [
      { type: "core.start", payload: {} },
      { type: SCORE_TYPE, payload: { by: `@${HOME_REF}`, points: 1 } },
    ];
    const selectors = selectorsFor(events, undefined);
    const pad = buildFakePad({ events, selectors, initialStatus: "in_play" });

    const result = await playMatchByTaps(makeInput({ pad, stream: stream(events) }));

    expect(result.findings.some((f) => f.includes('"scheduled" before the first tap'))).toBe(true);
  });

  it("reds when the fixture never reaches \"decided\" right after the last event is flushed", async () => {
    const events = [
      { type: "core.start", payload: {} },
      { type: SCORE_TYPE, payload: { by: `@${HOME_REF}`, points: 1 } },
    ];
    const selectors = selectorsFor(events, undefined);
    const pad = buildFakePad({ events, selectors, neverDecides: true });

    const result = await playMatchByTaps(makeInput({ pad, stream: stream(events) }));

    expect(result.findings.some((f) => f.includes('"decided" exactly at the last event'))).toBe(true);
  });

  it("reds when the fixture never leaves scheduled after core.start", async () => {
    const events = [
      { type: "core.start", payload: {} },
      { type: SCORE_TYPE, payload: { by: `@${HOME_REF}`, points: 1 } },
    ];
    const selectors = selectorsFor(events, undefined);
    const pad = buildFakePad({ events, selectors, stayScheduledAfterStart: true });

    const result = await playMatchByTaps(makeInput({ pad, stream: stream(events) }));

    expect(result.findings.some((f) => f.includes('"in_play" after core.start'))).toBe(true);
  });

  it("never posts an event itself — no fallback (R40)", async () => {
    const events = [
      { type: "core.start", payload: {} },
      { type: SCORE_TYPE, payload: { by: `@${HOME_REF}`, points: 1 } },
    ];
    const selectors = selectorsFor(events, undefined);
    const pad = buildFakePad({ events, selectors });

    await playMatchByTaps(makeInput({ pad, stream: stream(events) }));

    const posts = pad.calls.filter((c) => !c.startsWith("GET "));
    expect(posts).toEqual([]);
  });

  it("reds, never silently maps, an event the adapter cannot map", async () => {
    const events = [
      { type: "core.start", payload: {} },
      // points:2 is a dock-chip amendment — out of this task's adapter
      // scope (adapters/generic.ts's own header), so it must throw rather
      // than being mapped to some default tap.
      { type: SCORE_TYPE, payload: { by: `@${HOME_REF}`, points: 2 } },
    ];
    // Only event 0 is mappable — build the pad with a selector array wide
    // enough that index 1 is simply never looked up (the driver never
    // reaches a tap for an event whose adapter call threw).
    const selectors = [selectorsFor([events[0]!], undefined)[0]!, "UNUSED"];
    const pad = buildFakePad({ events, selectors });

    const result = await playMatchByTaps(makeInput({ pad, stream: stream(events) }));

    expect(result.findings.some((f) => f.includes("adapter") && f.includes("cannot map"))).toBe(true);
  });

  it("paces every tap after the first using the product's own pacing constant", async () => {
    const events = [
      { type: "core.start", payload: {} },
      { type: SCORE_TYPE, payload: { by: `@${HOME_REF}`, points: 1 } },
      { type: SCORE_TYPE, payload: { by: `@${AWAY_REF}`, points: 1 } },
    ];
    const selectors = selectorsFor(events, undefined);
    const pad = buildFakePad({ events, selectors });
    const sleepCalls: number[] = [];
    const sleep = vi.fn(async (ms: number) => {
      sleepCalls.push(ms);
    });

    await playMatchByTaps(makeInput({ pad, stream: stream(events), sleep }));

    expect(sleepCalls.length).toBeGreaterThan(0);
    expect(sleepCalls.every((ms) => ms === TAP_PACING_MS)).toBe(true);
    expect(TAP_PACING_MS).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// R39 — the pacing constant must equal the product's own, or a rename/
// re-tune there silently drifts.
// ---------------------------------------------------------------------------
describe("TAP_PACING_MS mirrors the product's own HUMAN_FASTEST_REPEAT_MS", () => {
  it("is exactly equal", () => {
    expect(TAP_PACING_MS).toBe(HUMAN_FASTEST_REPEAT_MS);
  });
});

// ---------------------------------------------------------------------------
// The generic adapter, pinned against the real generic.tsx.
// ---------------------------------------------------------------------------
describe("genericAdapter mirrors generic.tsx", () => {
  it("SCORE_TYPE/RESULT_TYPE/SETTLE_TILE_ID equal the real module's", () => {
    expect(SCORE_TYPE).toBe(REAL_SCORE_TYPE);
    expect(RESULT_TYPE).toBe(REAL_RESULT_TYPE);
    expect(SETTLE_TILE_ID).toBe(REAL_SETTLE_TILE_ID);
  });

  // The REAL `resultModeOf` (generic.tsx:168-170) takes an already-
  // normalised `GenericCfgShape` — it is only ever called via `cfgOf(view)`,
  // which normalises first — so it throws on a bare `undefined`/`null`
  // (`cfg.resultMode` with no guard). This adapter's own local mirror is
  // defensive (it normalises `cfg` itself, since `TapAdapterContext.cfg` is
  // `unknown`), which is DELIBERATELY wider than the real function's own
  // contract, not a divergence from it — proved by comparing against the
  // SAME normalised shape the real one actually receives in production.
  it.each([[{}], [{ resultMode: "score" }], [{ resultMode: "win_loss" }], [{ resultMode: "bogus" }]] as const)(
    "resultModeOf(%o) matches the real resultModeOf",
    (cfg) => {
      expect(resultModeOf(cfg)).toBe(realResultModeOf(cfg));
    },
  );

  it("is defensive where the real function is not: undefined/null still resolve to 'score'", () => {
    expect(resultModeOf(undefined)).toBe("score");
    expect(resultModeOf(null)).toBe("score");
  });

  it("maps core.start to the start-match button", () => {
    const steps = genericAdapter.stepsFor({ type: "core.start", payload: {} }, { cfg: undefined, entrants: ENTRANTS });
    expect(steps).toEqual([{ kind: "testid", testid: START_MATCH_TESTID }]);
  });

  it("maps a plain generic.score half tap by side", () => {
    const steps = genericAdapter.stepsFor(
      { type: SCORE_TYPE, payload: { by: HOME_ID, points: 1 } },
      { cfg: undefined, entrants: ENTRANTS },
    );
    expect(steps).toEqual([{ kind: "half", side: "home" }]);
  });

  it("CAUTION: win_loss maps generic.result to a half tap, NEVER the settle tile", () => {
    const steps = genericAdapter.stepsFor(
      { type: RESULT_TYPE, payload: { winnerId: AWAY_ID } },
      { cfg: { resultMode: "win_loss" }, entrants: ENTRANTS },
    );
    expect(steps).toEqual([{ kind: "half", side: "away" }]);
  });

  it("score mode maps an EMPTY generic.result to the settle tile", () => {
    const steps = genericAdapter.stepsFor(
      { type: RESULT_TYPE, payload: {} },
      { cfg: { resultMode: "score" }, entrants: ENTRANTS },
    );
    expect(steps).toEqual([{ kind: "tile", tileId: SETTLE_TILE_ID }]);
  });

  it("throws (never maps) an unrecognised event type", () => {
    expect(() =>
      genericAdapter.stepsFor({ type: "core.forfeit", payload: {} }, { cfg: undefined, entrants: ENTRANTS }),
    ).toThrow(/no tap mapping/);
  });

  it("throws (never maps) a dock-chip amendment on generic.score", () => {
    expect(() =>
      genericAdapter.stepsFor(
        { type: SCORE_TYPE, payload: { by: HOME_ID, points: 2 } },
        { cfg: undefined, entrants: ENTRANTS },
      ),
    ).toThrow();
  });

  it("throws (never maps) a typed final score on score-mode generic.result", () => {
    expect(() =>
      genericAdapter.stepsFor(
        { type: RESULT_TYPE, payload: { p1Score: 3, p2Score: 1 } },
        { cfg: undefined, entrants: ENTRANTS },
      ),
    ).toThrow();
  });
});
