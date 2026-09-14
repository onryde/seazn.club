// Task 9 — the tap driver + generic adapter. Drives a FAKE page and a FAKE
// ledger transport, so this runs with no browser and no server; it proves
// the ORDER of operations and the GUARDS (FIFO poll verification, seq-anchored
// status judgement, no fallback POST, never-rejects) — never the real DOM,
// which only a live run (Task 10/13) can prove (AGENTS.md failure class 2).
//
// ---------------------------------------------------------------------------
// The fake models MAIN's pad (#782), not a convenient one (fix round 1)
// ---------------------------------------------------------------------------
// A fake that is correct by construction hides exactly the guards it should
// test (task-9-review.md Check 7), so every rule below is the product's own:
//  - per event, a tap is HELD or IMMEDIATE (`pad-host.tsx:1882-1889`); a held
//    tap first releases whatever was already held (`queue.ts:254`
//    `flushHeldBefore`); an immediate tap queues BEHIND a held one
//    (`use-pad-pipeline.ts:1216`).
//  - `pad-send-now` is attached only while something is held
//    (`pad-host.tsx:2504`); a `waitFor`/`click` on an unattached control
//    THROWS, as a real Playwright locator's does.
//  - a release commits everything it unblocks in ONE burst — the worst case
//    for status judgement, and a real one (a release POSTs back to back).
//  - a commit's row, `last_seq` and status land TOGETHER, on both reads
//    (`append-event.ts:333-371` is one transaction; `/state` is one select).
//    `lagReads` delays that whole commit by N ledger reads.
//  - status goes `in_play` only on `core.start` (`fixtureStatusFromFold`).
//  - a device (scorer) page cannot finalize (`scoring.ts:233-235`): a
//    finalize tapped there writes nothing.
import { readdirSync, readFileSync } from "node:fs";
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
import type { LedgerTransport } from "../ledger.ts";
import type { RawResult, Session } from "../http.ts";
import {
  GENERIC_TOLERATED_EXTRA_KEYS,
  genericAdapter,
  RESULT_TYPE,
  resultModeOf,
  SCORE_TYPE,
  SETTLE_TILE_ID,
} from "../drivers/adapters/generic.ts";

// Real source-of-truth imports — TEST-ONLY (bench production code never
// imports apps/web). Pins every mirrored constant EQUAL to the real module.
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
const ENTRANTS = { home: HOME_ID, away: AWAY_ID };

function refIdByKey(): Map<string, string> {
  return new Map([
    [HOME_REF, HOME_ID],
    [AWAY_REF, AWAY_ID],
  ]);
}

type PackEvent = { type: string; payload: unknown };

function stream(events: readonly PackEvent[]) {
  return { home: HOME_REF, away: AWAY_REF, events };
}

const START: PackEvent = { type: "core.start", payload: {} };
const scoreBy = (ref: string): PackEvent => ({ type: SCORE_TYPE, payload: { by: `@${ref}`, points: 1 } });
const SETTLE: PackEvent = { type: RESULT_TYPE, payload: {} };
const winBy = (ref: string): PackEvent => ({ type: RESULT_TYPE, payload: { winnerId: `@${ref}` } });

const SCORE_CFG = { resultMode: "score" };
const WIN_LOSS_CFG = { resultMode: "win_loss" };

/** Main's own hold rule for the generic skin: only a score-mode
 *  `generic.score` has a non-empty dock (generic.tsx `buildDock`), so only it
 *  is held. Everything else commits immediately. */
function mainCommitMode(events: readonly PackEvent[], cfg: unknown) {
  return (index: number): "held" | "immediate" =>
    resultModeOf(cfg) === "score" && events[index]!.type === SCORE_TYPE ? "held" : "immediate";
}

const START_SEL = selectorForTapStep({ kind: "testid", testid: START_MATCH_TESTID });
const SEND_NOW_SEL = selectorForTapStep({ kind: "testid", testid: SEND_NOW_TESTID });
const FINALIZE_SEL = selectorForTapStep({ kind: "testid", testid: FINALIZE_TESTID });

// ---------------------------------------------------------------------------
// The fake pad + ledger.
// ---------------------------------------------------------------------------
type Status = "scheduled" | "in_play" | "decided" | "finalized";

interface FakeRow {
  readonly id: string;
  readonly seq: number;
  readonly type: string;
  readonly payload: unknown;
}

interface FakePad {
  readonly scorerPage: PadPage;
  readonly organiserPage: PadPage;
  /** Ordered: `goto …`, `viewport WxH`, `click <selector>`. */
  readonly scorerLog: string[];
  readonly organiserLog: string[];
  /** Every transport call, `${method} ${path}`. */
  readonly calls: string[];
  readonly ledger: LedgerTransport;
}

interface BuildFakePadOpts {
  events: readonly PackEvent[];
  /** Selector per event index, computed by the TEST from the real adapter. */
  selectors: readonly string[];
  /** Defaults to "immediate" for every index. */
  commitMode?: (index: number) => "held" | "immediate";
  /** Index whose commit flips status to "decided". Defaults to the last. */
  decidesAt?: number;
  recordedPayloadOverride?: ReadonlyMap<number, unknown>;
  recordedTypeOverride?: ReadonlyMap<number, string>;
  stayScheduledAfterStart?: boolean;
  initialStatus?: Status;
  neverDecides?: boolean;
  /** The tap resolves, but nothing is ever written server-side. */
  dropCommit?: ReadonlySet<number>;
  /** After this index's row, the server also writes a phantom duplicate. */
  extraRowAfter?: number;
  /** index -> ledger reads that pass before that commit lands. */
  lagReads?: ReadonlyMap<number, number>;
  /** Whether an ORGANISER-page finalize writes a row. Defaults to true. */
  finalizeCommits?: boolean;
  finalizeLag?: number;
  /** Selectors that never attach. */
  neverAttached?: ReadonlySet<string>;
  gotoThrows?: string;
  /** The hold's own HOLD_MS tick fires between the driver's presence check
   *  and its `pad-send-now` tap, unmounting the dock. */
  holdSelfReleasesAfterPresenceCheck?: boolean;
}

function buildFakePad(opts: BuildFakePadOpts): FakePad {
  const scorerLog: string[] = [];
  const organiserLog: string[] = [];
  const calls: string[] = [];
  const rows: FakeRow[] = [];
  let status: Status = opts.initialStatus ?? "scheduled";
  let ledgerReads = 0;
  const inFlight: { dueAt: number; apply: () => void }[] = [];
  const decidesAt = opts.decidesAt ?? opts.events.length - 1;
  const commitModeOf = opts.commitMode ?? (() => "immediate" as const);
  let nextTapIndex = 0;
  let held: number | undefined;
  const queue: number[] = [];
  let selfReleaseArmed = false;

  function writeRow(type: string, payload: unknown, nextStatus: Status): void {
    rows.push({ id: `row-${rows.length + 1}`, seq: rows.length + 1, type, payload });
    status = nextStatus;
  }

  // Commits are sequential on the wire: one that is still in flight holds
  // back every later one, so a lagged commit can never be overtaken.
  function land(lag: number | undefined, apply: () => void): void {
    const lagged = lag !== undefined && lag > 0;
    if (!lagged && inFlight.length === 0) {
      apply();
      return;
    }
    const own = ledgerReads + (lagged ? lag + 1 : 0);
    const behind = inFlight.length > 0 ? inFlight[inFlight.length - 1]!.dueAt : 0;
    inFlight.push({ dueAt: Math.max(own, behind), apply });
  }

  function settleInFlight(): void {
    while (inFlight.length > 0 && inFlight[0]!.dueAt <= ledgerReads) inFlight.shift()!.apply();
  }

  function commitEvent(index: number): void {
    if (opts.dropCommit?.has(index)) return;
    const ev = opts.events[index]!;
    const resolved = resolvePayloadRefs(ev.payload, refIdByKey(), "fake pad");
    const recorded = opts.recordedPayloadOverride?.has(index) ? opts.recordedPayloadOverride.get(index) : resolved;
    land(opts.lagReads?.get(index), () => {
      let next = status;
      if (ev.type === "core.start" && !opts.stayScheduledAfterStart && status === "scheduled") next = "in_play";
      if (index === decidesAt && !opts.neverDecides) next = "decided";
      writeRow(opts.recordedTypeOverride?.get(index) ?? ev.type, recorded, next);
      if (opts.extraRowAfter === index) writeRow(ev.type, resolved, status);
    });
  }

  function runDrain(): void {
    while (queue.length > 0 && queue[0] !== held) commitEvent(queue.shift()!);
  }

  function release(): void {
    held = undefined;
    runDrain();
  }

  function tapEvent(index: number): void {
    if (commitModeOf(index) === "held") {
      if (held !== undefined) release(); // queue.ts:254 flushHeldBefore
      held = index;
    }
    queue.push(index);
    runDrain();
  }

  function attached(sel: string): boolean {
    if (sel === SEND_NOW_SEL) return held !== undefined;
    return !opts.neverAttached?.has(sel);
  }

  function makeLocator(sel: string, pageName: "scorer" | "organiser"): PadLocator {
    const log = pageName === "scorer" ? scorerLog : organiserLog;
    return {
      async click() {
        if (!attached(sel)) throw new Error(`fake pad: click on ${sel}, which is not attached`);
        log.push(`click ${sel}`);
        if (sel === SEND_NOW_SEL) {
          release();
          return;
        }
        if (sel === FINALIZE_SEL) {
          if (pageName === "organiser" && opts.finalizeCommits !== false) {
            land(opts.finalizeLag, () => writeRow("core.finalize", {}, "finalized"));
          }
          return;
        }
        if (opts.selectors[nextTapIndex] !== sel) {
          throw new Error(`fake pad: tap ${nextTapIndex} expected ${opts.selectors[nextTapIndex]}, got ${sel}`);
        }
        tapEvent(nextTapIndex);
        nextTapIndex += 1;
      },
      async fill(v: string) {
        log.push(`fill ${sel}=${v}`);
      },
      async waitFor() {
        if (sel === SEND_NOW_SEL && selfReleaseArmed) {
          selfReleaseArmed = false;
          release();
        }
        if (!attached(sel)) throw new Error(`fake pad: ${sel} never attached`);
      },
      async count() {
        const n = attached(sel) ? 1 : 0;
        if (sel === SEND_NOW_SEL && n === 1 && opts.holdSelfReleasesAfterPresenceCheck) selfReleaseArmed = true;
        return n;
      },
    };
  }

  const scorerPage: PadPage = {
    locator: (sel: string) => makeLocator(sel, "scorer"),
    async goto(url: string) {
      scorerLog.push(`goto ${url}`);
      if (opts.gotoThrows !== undefined) throw new Error(opts.gotoThrows);
      return null;
    },
    async setViewportSize(size) {
      scorerLog.push(`viewport ${size.width}x${size.height}`);
    },
  };

  const organiserPage: PadPage = {
    locator: (sel: string) => makeLocator(sel, "organiser"),
    async goto(url: string) {
      organiserLog.push(`goto ${url}`);
      return null;
    },
    async setViewportSize(size) {
      organiserLog.push(`viewport ${size.width}x${size.height}`);
    },
  };

  const ledger: LedgerTransport = {
    async raw(_base: string, _session: Session, path: string, method = "GET"): Promise<RawResult> {
      calls.push(`${method} ${path}`);
      if (path.endsWith("/state")) {
        settleInFlight();
        return { status: 200, json: { ok: true, data: { status, last_seq: rows.length } } } as RawResult;
      }
      ledgerReads += 1;
      settleInFlight();
      const since = Number(/since_seq=(\d+)/.exec(path)?.[1] ?? "0");
      return { status: 200, json: { ok: true, data: rows.filter((r) => r.seq > since) } } as RawResult;
    },
  };

  return { scorerPage, organiserPage, scorerLog, organiserLog, calls, ledger };
}

/** Selector per event, computed with the REAL adapter — the one place a
 *  selector is decided in this file. */
function selectorsFor(events: readonly PackEvent[], cfg: unknown): string[] {
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
    scorerPage: pad.scorerPage,
    organiserPage: pad.organiserPage,
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

/** One match on a main-faithful fake: selectors from the real adapter, hold
 *  modes from main's own rule unless overridden. */
async function play(events: readonly PackEvent[], cfg: unknown, fake: Omit<BuildFakePadOpts, "events" | "selectors"> = {}, input: Partial<PlayMatchInput> = {}) {
  const pad = buildFakePad({ events, selectors: selectorsFor(events, cfg), commitMode: mainCommitMode(events, cfg), ...fake });
  const result = await playMatchByTaps(makeInput({ pad, stream: stream(events), cfg, ...input }));
  return { pad, result };
}

const joined = (lines: readonly string[]): string => lines.join("\n");

// ---------------------------------------------------------------------------
describe("playMatchByTaps — commits on main, held or immediate (C1, C2)", () => {
  it("win_loss: every tap commits immediately, pad-send-now is never mounted and never tapped — findings: []", async () => {
    const { pad, result } = await play([START, winBy(AWAY_REF)], WIN_LOSS_CFG);

    expect(joined(result.findings)).toBe("");
    expect(result.observations).toEqual([]);
    expect(result.taps).toBe(3); // start, half, finalize — NO send-now
    expect(pad.scorerLog).toContain(`click ${START_SEL}`);
    expect(pad.scorerLog).not.toContain(`click ${SEND_NOW_SEL}`);
    expect(pad.organiserLog).toContain(`click ${FINALIZE_SEL}`);
  });

  it("score mode: a held score flushed by the next held tap, then a settle queued behind the second hold, both released in ONE burst by pad-send-now — findings: []", async () => {
    const events = [START, scoreBy(HOME_REF), scoreBy(AWAY_REF), SETTLE];
    const { pad, result } = await play(events, SCORE_CFG);

    expect(joined(result.findings)).toBe("");
    expect(result.taps).toBe(6); // start, half, half, settle, send-now, finalize
    const settleSel = selectorsFor([SETTLE], SCORE_CFG)[0]!;
    expect(pad.scorerLog.indexOf(`click ${SEND_NOW_SEL}`)).toBeGreaterThan(pad.scorerLog.indexOf(`click ${settleSel}`));
    // The burst is visible, not silent: the second score's row landed with
    // the settle's, so no snapshot ever showed the fixture right after it.
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]).toMatch(/^event 2 \(generic\.score\): status not judged — its row \(seq 3\) landed together with a later one/);
  });

  it("a pack with no core.start expects \"scheduled\" (not \"in_play\") before its last event — findings: []", async () => {
    // fixtureStatusFromFold: in_play only once core.start is in the stream.
    const { result } = await play([scoreBy(HOME_REF), scoreBy(AWAY_REF), SETTLE], SCORE_CFG);

    expect(joined(result.findings)).toBe("");
  });

  it.each([
    ["win_loss, every commit one read late", [START, winBy(AWAY_REF)], WIN_LOSS_CFG, new Map([[0, 1], [1, 1]]), 1],
    ["score mode, every commit one read late", [START, scoreBy(HOME_REF), SETTLE], SCORE_CFG, new Map([[0, 1], [1, 1], [2, 1]]), 1],
    ["win_loss, the last commit ten reads late", [START, winBy(AWAY_REF)], WIN_LOSS_CFG, new Map([[1, 10]]), 0],
  ] as const)("%s — polled until it lands: no false gap, no false status red", async (_label, events, cfg, lagReads, finalizeLag) => {
    const { result } = await play(events, cfg, { lagReads, finalizeLag });

    expect(joined(result.findings)).toBe("");
  });

  it("reds when the server records an extra row nothing tapped for — and says the last event's \"decided\" could not be judged", async () => {
    const { result } = await play([START, winBy(AWAY_REF)], WIN_LOSS_CFG, { extraRowAfter: 1 });

    expect(result.findings).toContain('ledger: an extra row landed with nothing tapped left to expect it (type "generic.result", seq 3)');
    expect(result.findings).toContain(
      'status: could not judge "decided" at the last event — event 1 (generic.result) landed at seq 2, but the ledger tip had already moved on to seq 3',
    );
  });

  it("reds, and still resolves, when a tapped event's row never lands by the poll deadline", async () => {
    const { result } = await play([START, winBy(AWAY_REF)], WIN_LOSS_CFG, { dropCommit: new Set([1]) });

    expect(result.findings).toContain("ledger: event 1 (generic.result) never landed — gave up after the poll deadline");
  });

  it("reds, and still resolves without tapping, when a stream entrant ref resolves to no id", async () => {
    const events = [START, winBy(AWAY_REF)];
    const pad = buildFakePad({ events, selectors: selectorsFor(events, WIN_LOSS_CFG) });

    const result = await playMatchByTaps(
      makeInput({ pad, stream: stream(events), cfg: WIN_LOSS_CFG, refIdByKey: new Map([[HOME_REF, HOME_ID]]) }),
    );

    expect(result.findings).toEqual(['entrants: scorer: entrant ref "e-away" resolved to no known id — check what seedSuite actually bound']);
    expect(result.taps).toBe(0);
  });

  it("reds, and still resolves, when a mapped control never attaches mid-stream", async () => {
    const events = [START, winBy(AWAY_REF)];
    const halfSel = selectorsFor(events, WIN_LOSS_CFG)[1]!;
    const { result } = await play(events, WIN_LOSS_CFG, { neverAttached: new Set([halfSel]) });

    expect(result.findings).toEqual([`tap: event 1 (generic.result) failed — fake pad: ${halfSel} never attached`]);
    expect(result.taps).toBe(1);
  });

  it("taps pad-send-now's hold race correctly: a hold that releases itself before the tap is an observation, not a finding", async () => {
    const { result } = await play([START, scoreBy(HOME_REF), SETTLE], SCORE_CFG, { holdSelfReleasesAfterPresenceCheck: true });

    expect(joined(result.findings)).toBe("");
    expect(result.observations).toContain("pad-send-now: unmounted before the tap reached it — the hold released on its own");
  });

  it("never posts anything itself — every transport call is a GET, including across a send-now release (R40)", async () => {
    const { pad } = await play([START, scoreBy(HOME_REF), SETTLE], SCORE_CFG);

    expect(pad.calls.length).toBeGreaterThan(0);
    expect(pad.calls.filter((c) => !c.startsWith("GET "))).toEqual([]);
  });
});

describe("playMatchByTaps — status, judged per verified row", () => {
  it("reds a decided-early fixture, judged on the snapshot of the row that decided it", async () => {
    // Event 1's row lands when event 2's held tap flushes it; event 2 is still
    // held, so the snapshot's tip IS event 1's row.
    const { result } = await play([START, scoreBy(HOME_REF), scoreBy(AWAY_REF)], SCORE_CFG, { decidesAt: 1 });

    expect(result.findings).toContain('status: the fixture was already "decided" right after event 1 (generic.score) landed — decided early');
  });

  it("reds a fixture that never leaves scheduled — after core.start AND before the last event", async () => {
    const { result } = await play([START, scoreBy(HOME_REF), scoreBy(AWAY_REF)], SCORE_CFG, { stayScheduledAfterStart: true });

    expect(result.findings).toContain('status: expected "in_play" after core.start, got "scheduled"');
    expect(result.findings).toContain(
      'status: expected "in_play" before the last event, got "scheduled" right after event 1 (generic.score) landed',
    );
  });

  it('reds when the fixture is not "scheduled" before the very first tap', async () => {
    const { result } = await play([START, scoreBy(HOME_REF)], SCORE_CFG, { initialStatus: "in_play" });

    expect(result.findings).toContain('status: expected "scheduled" before the first tap, got "in_play"');
  });

  it('reds when the fixture never reaches "decided" right after the last event lands', async () => {
    const { result } = await play([START, scoreBy(HOME_REF)], SCORE_CFG, { neverDecides: true });

    expect(result.findings).toContain('status: expected "decided" exactly at the last event, got "in_play"');
  });
});

describe("playMatchByTaps — payload equality, exact in both directions (I2, m3)", () => {
  it("reds when the server recorded a different event TYPE than the taps meant", async () => {
    const { result } = await play([START, winBy(AWAY_REF)], WIN_LOSS_CFG, { recordedTypeOverride: new Map([[1, "generic.void"]]) });

    expect(result.findings).toContain(
      'ledger: event 1 (generic.result) — type mismatch: the pack meant "generic.result", the server recorded "generic.void"',
    );
  });

  it("reds when the server recorded a different value than the taps meant", async () => {
    const { pad, result } = await play([START, scoreBy(HOME_REF)], SCORE_CFG, {
      recordedPayloadOverride: new Map([[1, { by: AWAY_ID, points: 1 }]]),
    });

    expect(result.findings).toContain(
      'ledger: event 1 (generic.score) — payload key "by" mismatch: the pack meant "en-home", the server recorded "en-away"',
    );
    expect(pad.calls.filter((c) => !c.startsWith("GET "))).toEqual([]);
  });

  it('reds an untolerated extra key on an EMPTY pack payload (the settle tile\'s {} recorded as {isDraw:true})', async () => {
    const { result } = await play([START, SETTLE], SCORE_CFG, { recordedPayloadOverride: new Map([[1, { isDraw: true }]]) });

    expect(result.findings).toContain(
      'ledger: event 1 (generic.result) — payload key "isDraw" mismatch: the pack meant undefined, the server recorded true',
    );
  });

  it("records the allowlisted extra (person on generic.score) as an observation, never a finding and never silence", async () => {
    const { result } = await play([START, scoreBy(HOME_REF)], SCORE_CFG, {
      recordedPayloadOverride: new Map([[1, { by: HOME_ID, points: 1, person: "p-solo" }]]),
    });

    expect(joined(result.findings)).toBe("");
    expect(result.observations).toEqual(['event 1 (generic.score): tolerated extra key "person" = "p-solo"']);
  });

  it("reds the same person key on an event type the allowlist does not name (generic.result)", async () => {
    const { result } = await play([START, winBy(AWAY_REF)], WIN_LOSS_CFG, {
      recordedPayloadOverride: new Map([[1, { winnerId: AWAY_ID, person: "p-solo" }]]),
    });

    expect(result.findings).toContain(
      'ledger: event 1 (generic.result) — payload key "person" mismatch: the pack meant undefined, the server recorded "p-solo"',
    );
    expect(result.observations).toEqual([]);
  });
});

describe("playMatchByTaps — the adapter never substitutes a tap (I3, R50(e))", () => {
  it("reds, and taps no half, when generic.score is authored under win_loss", async () => {
    const events = [START, scoreBy(HOME_REF)];
    const pad = buildFakePad({ events, selectors: [START_SEL, "UNUSED"] });

    const result = await playMatchByTaps(makeInput({ pad, stream: stream(events), cfg: WIN_LOSS_CFG }));

    expect(joined(result.findings)).toMatch(/^adapter: cannot map event 1 \(generic\.score\) to a tap — .*not tappable under win_loss mode/);
    expect(pad.scorerLog.some((c) => c.includes("v3-scorebug-half"))).toBe(false);
  });

  it("reds, never silently maps, an event the adapter cannot map (a dock-chip amendment)", async () => {
    const events = [START, { type: SCORE_TYPE, payload: { by: `@${HOME_REF}`, points: 2 } }];
    const pad = buildFakePad({ events, selectors: [START_SEL, "UNUSED"] });

    const result = await playMatchByTaps(makeInput({ pad, stream: stream(events), cfg: SCORE_CFG }));

    expect(joined(result.findings)).toMatch(/^adapter: cannot map event 1 \(generic\.score\) to a tap — .*not a plain one-point half tap/);
  });
});

describe("playMatchByTaps — finalize on the organiser page, verified (I5, I6, R50(h))", () => {
  it("sets a >=768 viewport on the ORGANISER page, then finalizes there, and verifies the core.finalize row", async () => {
    const { pad, result } = await play([START, winBy(AWAY_REF)], WIN_LOSS_CFG);

    expect(joined(result.findings)).toBe("");
    const viewportAt = pad.organiserLog.findIndex((l) => l.startsWith("viewport "));
    const finalizeAt = pad.organiserLog.indexOf(`click ${FINALIZE_SEL}`);
    expect(viewportAt).toBeGreaterThanOrEqual(0);
    expect(finalizeAt).toBeGreaterThan(viewportAt);
    const width = Number(/^viewport (\d+)x\d+$/.exec(pad.organiserLog[viewportAt]!)?.[1]);
    expect(width).toBeGreaterThanOrEqual(768);
    expect(pad.scorerLog.filter((l) => l.startsWith("viewport ") || l === `click ${FINALIZE_SEL}`)).toEqual([]);
  });

  it("reds when score-finalize is tapped but no core.finalize row ever lands", async () => {
    const { result } = await play([START, winBy(AWAY_REF)], WIN_LOSS_CFG, { finalizeCommits: false });

    expect(result.findings).toEqual(['ledger: expected a "core.finalize" row after tapping score-finalize, none landed']);
  });

  it("reds, and still resolves, when score-finalize never attaches", async () => {
    const { result } = await play([START, winBy(AWAY_REF)], WIN_LOSS_CFG, { neverAttached: new Set([FINALIZE_SEL]) });

    expect(result.findings).toEqual([`tap: score-finalize failed — fake pad: ${FINALIZE_SEL} never attached`]);
    expect(result.taps).toBe(2);
  });

  it("reds, and still resolves, even when scorerPage.goto itself throws (the last-resort net)", async () => {
    const pad = buildFakePad({ events: [], selectors: [], gotoThrows: "device link is dead" });

    const result = await playMatchByTaps(makeInput({ pad, stream: stream([]) }));

    expect(result.findings).toEqual(["driver: unexpected failure — device link is dead"]);
    expect(result.fixtureId).toBe("f1");
    expect(result.taps).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// R39 pacing — pin the COUNT (m2), not just "at least one".
// ---------------------------------------------------------------------------
describe("TAP_PACING_MS", () => {
  it("paces every tap after the first, exactly taps-1 times, at the product's own pacing constant", async () => {
    const sleepCalls: number[] = [];
    const sleep = vi.fn(async (ms: number) => {
      sleepCalls.push(ms);
    });

    const { result } = await play([START, winBy(AWAY_REF)], WIN_LOSS_CFG, {}, { sleep });

    expect(result.taps).toBe(3);
    expect(sleepCalls).toEqual([TAP_PACING_MS, TAP_PACING_MS]);
  });

  it("is exactly equal to the product's HUMAN_FASTEST_REPEAT_MS", () => {
    expect(TAP_PACING_MS).toBe(HUMAN_FASTEST_REPEAT_MS);
  });
});

// ---------------------------------------------------------------------------
// I4 / R50(f): no HTTP-capable value is reachable from the driver's own files.
// A source scan, so an unused import is caught too, not just a call site. The
// load-bearing check is the VALUE-import allowlist: nothing the bench can POST
// with (defaultLedgerTransport, defaultSimTransport, http.ts's raw, simulate's
// stream runner) can be used without importing it. Comments are stripped
// before the token scan, so prose that NAMES a forbidden symbol is fine.
// ---------------------------------------------------------------------------
describe("no HTTP-capable bypass is reachable from the tap driver's files (I4)", () => {
  const drivers = new URL("../drivers/", import.meta.url);
  const adapterFiles = readdirSync(new URL("adapters/", drivers)).filter((f) => f.endsWith(".ts")).map((f) => `adapters/${f}`);

  /** Every value a file may import, per module. Type-only specifiers are always allowed. */
  const VALUE_IMPORTS: Record<string, Record<string, readonly string[]>> = {
    "scorer.ts": { "../ledger.ts": ["fetchFixtureLedger", "fetchFixtureStatus"], "../simulate.ts": ["resolvePayloadRefs"] },
    "padpage-assignability.ts": {},
    "adapters/generic.ts": { "../scorer.ts": ["START_MATCH_TESTID"] },
  };

  function stripComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  }

  function valueImportsOf(src: string): { from: string; names: string[] }[] {
    const code = stripComments(src);
    const statements = code.match(/^import\b[\s\S]*?;/gm) ?? [];
    return statements.map((statement) => {
      const m = /^import\s+(type\s+)?([\s\S]*?)\s+from\s+"([^"]+)";$/.exec(statement);
      if (m === null) return { from: `UNPARSED: ${statement}`, names: ["*"] };
      if (m[1] !== undefined) return { from: m[3]!, names: [] };
      const braces = /^\{([\s\S]*)\}$/.exec(m[2]!.trim());
      if (braces === null) return { from: m[3]!, names: [m[2]!.trim()] }; // default / namespace import
      const names = braces[1]!
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0 && !s.startsWith("type "));
      return { from: m[3]!, names };
    });
  }

  it("covers every adapter file on disk (a new adapter must join the allowlist)", () => {
    expect(adapterFiles.length).toBeGreaterThan(0);
    expect(Object.keys(VALUE_IMPORTS).filter((k) => k.startsWith("adapters/")).sort()).toEqual([...adapterFiles].sort());
  });

  it.each(Object.keys(VALUE_IMPORTS))("%s imports only allowlisted values", (file) => {
    const src = readFileSync(new URL(file, drivers), "utf8");
    const allowed = VALUE_IMPORTS[file]!;
    const offending = valueImportsOf(src).flatMap(({ from, names }) =>
      names.filter((name) => !(allowed[from] ?? []).includes(name)).map((name) => `${name} from ${from}`),
    );
    expect(offending).toEqual([]);
  });

  it.each(Object.keys(VALUE_IMPORTS))("%s names no HTTP-capable global or bench transport in code", (file) => {
    const code = stripComments(readFileSync(new URL(file, drivers), "utf8"));
    const forbidden = [
      /\bfetch\s*\(/,
      /\braw\s*\(/,
      /node:https?/,
      /\bimport\s*\(/,
      /\brequire\s*\(/,
      /defaultLedgerTransport|defaultSimTransport|simulateDivisionStreams/,
      /XMLHttpRequest|WebSocket|EventSource/,
    ];
    expect(forbidden.filter((re) => re.test(code)).map(String)).toEqual([]);
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

  it("maps a plain generic.score half tap by side (score mode)", () => {
    const steps = genericAdapter.stepsFor({ type: SCORE_TYPE, payload: { by: HOME_ID, points: 1 } }, { cfg: SCORE_CFG, entrants: ENTRANTS });
    expect(steps).toEqual([{ kind: "half", side: "home" }]);
  });

  it("throws (I3): generic.score is not tappable under win_loss — the half there commits generic.result", () => {
    expect(() =>
      genericAdapter.stepsFor({ type: SCORE_TYPE, payload: { by: HOME_ID, points: 1 } }, { cfg: WIN_LOSS_CFG, entrants: ENTRANTS }),
    ).toThrow(/not tappable under win_loss mode/);
  });

  it("CAUTION: win_loss maps generic.result to a half tap, NEVER the settle tile", () => {
    const steps = genericAdapter.stepsFor({ type: RESULT_TYPE, payload: { winnerId: AWAY_ID } }, { cfg: WIN_LOSS_CFG, entrants: ENTRANTS });
    expect(steps).toEqual([{ kind: "half", side: "away" }]);
  });

  it("throws (R50(e)): win_loss has no settle tile, so an empty generic.result is not authorable there", () => {
    expect(() => genericAdapter.stepsFor({ type: RESULT_TYPE, payload: {} }, { cfg: WIN_LOSS_CFG, entrants: ENTRANTS })).toThrow(
      /not a plain winnerId half tap/,
    );
  });

  it("score mode maps an EMPTY generic.result to the settle tile", () => {
    const steps = genericAdapter.stepsFor({ type: RESULT_TYPE, payload: {} }, { cfg: SCORE_CFG, entrants: ENTRANTS });
    expect(steps).toEqual([{ kind: "tile", tileId: SETTLE_TILE_ID }]);
  });

  it("throws (never maps) an unrecognised event type", () => {
    expect(() => genericAdapter.stepsFor({ type: "core.forfeit", payload: {} }, { cfg: undefined, entrants: ENTRANTS })).toThrow(/no tap mapping/);
  });

  it("throws (never maps) a dock-chip amendment on generic.score", () => {
    expect(() =>
      genericAdapter.stepsFor({ type: SCORE_TYPE, payload: { by: HOME_ID, points: 2 } }, { cfg: SCORE_CFG, entrants: ENTRANTS }),
    ).toThrow(/not a plain one-point half tap/);
  });

  it("throws (never maps) a typed final score on score-mode generic.result", () => {
    expect(() =>
      genericAdapter.stepsFor({ type: RESULT_TYPE, payload: { p1Score: 3, p2Score: 1 } }, { cfg: undefined, entrants: ENTRANTS }),
    ).toThrow(/typed final score/);
  });

  it("R50(d): the allowlist is ONE constant naming exactly person on generic.score, and the adapter reads it", () => {
    expect([...GENERIC_TOLERATED_EXTRA_KEYS]).toEqual([[SCORE_TYPE, ["person"]]]);
    expect(genericAdapter.tolerableExtraKeys?.(SCORE_TYPE)).toEqual(["person"]);
    expect(genericAdapter.tolerableExtraKeys?.(RESULT_TYPE)).toEqual([]);
    expect(genericAdapter.tolerableExtraKeys?.("core.start")).toEqual([]);
  });
});
