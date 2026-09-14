// The tap driver (B07a task 9) — a bench-side "scorer" who plays a match by
// TAPPING the real scoring pad in a browser, rather than posting events
// directly the way `simulate.ts` does. It is sport-BLIND: every sport fact
// (which control a given event maps to, what the fixture's cfg means) lives
// in a `TapAdapter` (`adapters/generic.ts` is the first one); this file only
// knows how to execute a `TapStep` against a `Page`-shaped object and how to
// check the SERVER's own ledger against what the pack meant.
//
// Task 10 wires this into the suite runner's `tap` play mode, against a REAL
// Playwright `Page` and a REAL `LedgerTransport`. This task proves the ORDER
// of operations and the GUARDS with a FAKE page and a FAKE transport (no
// browser, no server) — see `__tests__/scorer-driver.test.ts`.
//
// ---------------------------------------------------------------------------
// Fix round 1 (R50) — the rebase premise shift, closed
// ---------------------------------------------------------------------------
// The original design assumed every non-`core.start` tap is held and flushed
// by the NEXT tap. `origin/main` (#782) made that false: `v3/pad-host.tsx:
// 1882-1889` dispatches straight to `pipeline.submit` (IMMEDIATE) whenever
// `usesSoftCommit(dock)` is false (`:1232`), and an immediate tap made while
// something is held QUEUES BEHIND it (`use-pad-pipeline.ts:1216`'s drain
// breaks at a still-held front entry). Only `pad-send-now` releases a hold
// early, and it is mounted only while something is held (`pad-host.tsx:2504`).
//
// So the driver no longer cares whether a tap was held or immediate (R50(a)):
//  - it keeps a FIFO of tapped-but-unverified pack events and, after every
//    tap, runs a BOUNDED POLL of the ledger, consuming rows in pack order
//    against the FIFO head. A row beyond the FIFO is an "extra" finding; an
//    entry still unmatched at the final deadline is a "never landed" finding.
//  - `pad-send-now` is tapped only when a non-throwing presence check says it
//    is mounted (R50(b)).
//  - every tap and wait is wrapped, so a DOM/wait failure becomes a finding
//    and `playMatchByTaps` always RESOLVES with its taps and wall time
//    (R50(c)).
//
// ---------------------------------------------------------------------------
// Status is judged against the snapshot's OWN seq, never a lagging/leading read
// ---------------------------------------------------------------------------
// `GET /state` returns `fixtures.status` and `match_states.last_seq` from ONE
// select (`usecases/fixtures.ts` `getFixtureState`), and `append-event.ts`
// writes the score_events row, `match_states.last_seq` and `fixtures.status`
// in ONE transaction (`:333-371`). So a snapshot's `status` is exactly the
// status after the row at its `lastSeq` — and after no other row.
//
// That matters because rows arrive in BURSTS on a correct product: releasing
// a held score with the settle queued behind it lands both before the next
// read, and a status read taken "after the score row" already shows the
// settle's `decided`. Judging the score row from that read is a false
// "decided early". So a verified row's status rule is judged only by a
// snapshot whose `lastSeq` IS that row's seq. A row the tip had already moved
// past cannot be judged at all — that is recorded as an OBSERVATION (never
// silence), except for the LAST event's "decided" rule, which a correct
// product always leaves judgeable (nothing writes between the last event and
// finalize) and is therefore a FINDING when it is not.
//
// ---------------------------------------------------------------------------
// Re-pinned against the tree (AGENTS.md failure class 5):
// ---------------------------------------------------------------------------
//  - `fetchFixtureLedger`/`fetchFixtureStatus`/`LedgerRow`/`LedgerTransport`
//    are `../ledger.ts:112,132,71,26` — `fetchFixtureStatus` returns
//    `{status, lastSeq}` (camelCase), not the wire's `last_seq`.
//  - `resolvePayloadRefs` is `../simulate.ts:177` — it resolves only strings
//    carrying the `"@ref"` sigil, which is why `stream.home`/`stream.away`
//    (bare refs) go through `resolveEntrantRef` below instead.
//  - `browser.ts`'s launch/session helpers are the REGISTRATION driver's
//    lifecycle; this file takes already-open `scorerPage`/`organiserPage`
//    handles, and Task 10 (which owns a real `Browser`) mints and closes them.
//  - Task 8's contract gives a scorebug half no testid
//    (`[data-role="v3-scorebug-half"][data-side]`, `scorebug.tsx:342-343`), so
//    `TapStep` carries a `{kind:"half"; side}` variant the brief's sketch lacked.
//  - No HTTP-capable value is imported here (I4): the transport is REQUIRED on
//    `PlayMatchInput` (R50(f)). Task 10 imports the real one from `../ledger.ts`.
//
// ---------------------------------------------------------------------------
// Payload comparison — exact in BOTH directions (R50(d))
// ---------------------------------------------------------------------------
// Every key the PACK authored must deep-equal the recorded value, AND every
// key the SERVER recorded must be a pack key — unless the adapter's own named
// allowlist tolerates it for that event type (`TapAdapter.tolerableExtraKeys`;
// generic's is `GENERIC_TOLERATED_EXTRA_KEYS`, with its file:line evidence).
// A tolerated extra is recorded as an observation, never dropped silently.
import { fetchFixtureLedger, fetchFixtureStatus, type LedgerRow, type LedgerTransport } from "../ledger.ts";
import { resolvePayloadRefs } from "../simulate.ts";
import type { Session } from "../http.ts";

// ---------------------------------------------------------------------------
// Taps — the vocabulary a scorer's finger actually has. Every kind maps to
// exactly one selector (`selectorForTapStep`), so the driver and its tests
// share one definition of "what does this step click".
// ---------------------------------------------------------------------------
export type TapStep =
  | { readonly kind: "tile"; readonly tileId: string }
  | { readonly kind: "choice"; readonly optionId: string }
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "confirm" }
  | { readonly kind: "testid"; readonly testid: string }
  /** A scorebug half — Task 8's contract gives halves no testid at all
   *  (`data-role="v3-scorebug-half"][data-side="…"]`, `scorebug.tsx:342-343`). */
  | { readonly kind: "half"; readonly side: "home" | "away" };

/** `[data-tile-id]` — tile-grid.tsx:293. `[data-choice-option-id]` —
 *  guided-sheet.tsx:418. `[data-testid="pad-sheet-number"]` —
 *  guided-sheet.tsx:523. `[data-testid="pad-sheet-confirm"]` —
 *  guided-sheet.tsx:549. A bare `testid` kind is `[data-testid="…"]` verbatim
 *  (`score-start-match`, `pad-send-now`, `score-finalize`). `half` is
 *  `scorebug.tsx:342-343`'s own two attributes. */
export function selectorForTapStep(step: TapStep): string {
  switch (step.kind) {
    case "tile":
      return `[data-tile-id="${step.tileId}"]`;
    case "choice":
      return `[data-choice-option-id="${step.optionId}"]`;
    case "number":
      return '[data-testid="pad-sheet-number"]';
    case "confirm":
      return '[data-testid="pad-sheet-confirm"]';
    case "testid":
      return `[data-testid="${step.testid}"]`;
    case "half":
      return `[data-role="v3-scorebug-half"][data-side="${step.side}"]`;
  }
}

// The chassis-level testids every sport shares (Task 8's stable contract).
export const START_MATCH_TESTID = "score-start-match";
export const SEND_NOW_TESTID = "pad-send-now";
export const FINALIZE_TESTID = "score-finalize";

/**
 * The pacing floor — R39. Mirrors `HUMAN_FASTEST_REPEAT_MS`
 * (`use-pad-pipeline.ts:351`), which bench production code cannot import
 * (apps/web, `"use client"`); the test imports the real constant and pins
 * equality. It sits above `DOUBLE_SUBMIT_WINDOW_MS` (250, same file), so
 * pacing at it clears the product's double-submit guard with margin.
 */
export const TAP_PACING_MS = 350;

/** How long one locator wait may take before it becomes a finding (R50(c))
 *  rather than an escaping Playwright `TimeoutError`. Every control waited on
 *  is either already mounted or presence-checked first (`pad-send-now`), so
 *  this only ever covers ordinary render latency — never a hold window. */
export const TAP_WAIT_TIMEOUT_MS = 5000;

/** The ledger poll's spacing and its two budgets: a short one after each tap
 *  (ordinary round-trip lag, without blocking on something genuinely held)
 *  and a longer one at the end, after `pad-send-now` has released whatever
 *  was held (R50(a)). Neither is sized to the build-time `HOLD_MS`: the
 *  driver never waits a hold out, it releases it. */
const LEDGER_POLL_INTERVAL_MS = 200;
const PER_TAP_POLL_ATTEMPTS = 3;
const FINAL_POLL_ATTEMPTS = 40;

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// The narrow Page/Locator surface this driver needs — a structural subset a
// real Playwright `Page` satisfies with NO cast (R50(g)), proved at compile
// time by `padpage-assignability.ts` (tsconfig.scripts.json excludes test
// files, so the proof cannot live in the test). `goto` is `Promise<unknown>`
// because a real `Page.goto()` resolves `Response | null` (I1).
// ---------------------------------------------------------------------------
export interface PadLocator {
  click(): Promise<void>;
  fill(value: string): Promise<void>;
  waitFor(options?: { readonly state?: "attached" | "detached" | "visible" | "hidden"; readonly timeout?: number }): Promise<void>;
  count(): Promise<number>;
}

export interface PadPage {
  locator(selector: string): PadLocator;
  goto(url: string): Promise<unknown>;
  setViewportSize(size: { readonly width: number; readonly height: number }): Promise<void>;
}

/** R50(h): finalize is tapped on the ORGANISER page at a viewport ≥768.
 *  `score-finalize` itself is NOT `max-md:hidden` (`fixture-console.tsx:
 *  1103-1106`; only the device hand-over is, `:849-853`) — the width is the
 *  ruling's requirement, not a fold workaround (m1). */
export const ORGANISER_VIEWPORT = { width: 1280, height: 900 } as const;

async function executeStep(page: PadPage, step: TapStep): Promise<void> {
  const locator = page.locator(selectorForTapStep(step));
  await locator.waitFor({ timeout: TAP_WAIT_TIMEOUT_MS });
  if (step.kind === "number") {
    await locator.fill(String(step.value));
    return;
  }
  await locator.click();
}

async function executeSteps(page: PadPage, steps: readonly TapStep[]): Promise<void> {
  for (const step of steps) await executeStep(page, step);
}

// ---------------------------------------------------------------------------
// The adapter contract. `stepsFor` receives the event with its payload
// ALREADY RESOLVED (the same resolved payload the ledger is compared
// against); `entrants` is likewise resolved.
// ---------------------------------------------------------------------------
export interface TapAdapterContext {
  /** The fixture's resolved sport config, opaque to this file. */
  readonly cfg: unknown;
  /** The two sides' real entrant ids, resolved from `stream.home`/`away`. */
  readonly entrants: { readonly home: string; readonly away: string };
}

export interface TapAdapter {
  readonly sport: string;
  /**
   * An event this adapter cannot map — including one the pad cannot author
   * in the fixture's mode (R50(e)) — MUST throw rather than fall back to a
   * substitute tap. The driver turns the throw into a finding and stops.
   */
  stepsFor(event: { readonly type: string; readonly payload: unknown }, ctx: TapAdapterContext): readonly TapStep[];
  /**
   * R50(d): the ONLY escape from exact bidirectional payload equality — keys
   * the pad legitimately adds to a committed row of this event type beyond
   * what the pack authored, each backed by file:line evidence in the adapter.
   * Every tolerated key is still recorded as an observation. Omitted ≡ `[]`.
   */
  tolerableExtraKeys?(eventType: string): readonly string[];
}

// ---------------------------------------------------------------------------
// Input/result.
// ---------------------------------------------------------------------------

/** The slice of a `PackStream` this driver needs — structurally compatible
 *  with a real `PackStream`, so Task 10 passes one straight through. */
export interface PlayMatchStream {
  readonly home: string;
  readonly away: string;
  readonly events: readonly { readonly type: string; readonly payload: unknown }[];
}

export interface PlayMatchInput {
  readonly scorerPage: PadPage;
  /** Where `score-finalize` is driven — `scoring.ts:233-235` refuses a
   *  `core.finalize` from a device link, so never the same page as
   *  `scorerPage` for a device-link run. */
  readonly organiserPage: PadPage;
  readonly deviceUrl: string;
  readonly fixtureId: string;
  readonly stream: PlayMatchStream;
  readonly adapter: TapAdapter;
  readonly refIdByKey: ReadonlyMap<string, string>;
  /** The ONE transport every HTTP read goes through (R40). REQUIRED, with no
   *  default (R50(f)): the driver never POSTs; every write is a side effect
   *  of a real tap. */
  readonly ledger: LedgerTransport;
  readonly base: string;
  readonly session: Session;
  /** The fixture's resolved sport config, forwarded to the adapter verbatim. */
  readonly cfg?: unknown;
  /** Test-only: a `sleep` that RECORDS rather than waits. */
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface PlayMatchResult {
  readonly fixtureId: string;
  readonly taps: number;
  readonly wallMs: number;
  readonly findings: readonly string[];
  /** Facts that are not defects but must never be silent: payload keys the
   *  adapter's allowlist tolerated (R50(d)), a status rule a burst made
   *  unjudgeable, a hold that released itself before `pad-send-now`. */
  readonly observations: readonly string[];
}

// Ref resolution for `stream.home`/`stream.away` — bare refs, no `@` sigil.
function resolveEntrantRef(ref: string, refIdByKey: ReadonlyMap<string, string>): string {
  const id = refIdByKey.get(ref);
  if (id === undefined) {
    throw new Error(`scorer: entrant ref "${ref}" resolved to no known id — check what seedSuite actually bound`);
  }
  return id;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Ledger comparison — see the header's "Payload comparison" note.
// ---------------------------------------------------------------------------
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === "object" && a !== null && typeof b === "object" && b !== null) {
    const ak = Object.keys(a);
    const br = b as Record<string, unknown>;
    return ak.length === Object.keys(br).length && ak.every((k) => deepEqual((a as Record<string, unknown>)[k], br[k]));
  }
  return false;
}

/** A non-object payload has no keys — normalised to `{}` on BOTH sides, so an
 *  object recorded against a bare pack payload is still caught (m3). */
function normalizeToRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

interface PayloadComparison {
  readonly mismatchKey?: string;
  readonly observations: readonly string[];
}

/** R50(d): exact in BOTH directions — see the header. */
function comparePayload(expected: unknown, actual: unknown, tolerable: readonly string[]): PayloadComparison {
  const expectedRecord = normalizeToRecord(expected);
  const actualRecord = normalizeToRecord(actual);
  const observations: string[] = [];
  for (const [key, value] of Object.entries(expectedRecord)) {
    if (!deepEqual(actualRecord[key], value)) return { mismatchKey: key, observations };
  }
  for (const key of Object.keys(actualRecord)) {
    if (Object.hasOwn(expectedRecord, key)) continue;
    if (tolerable.includes(key)) {
      observations.push(`tolerated extra key "${key}" = ${JSON.stringify(actualRecord[key])}`);
      continue;
    }
    return { mismatchKey: key, observations };
  }
  return { observations };
}

// ---------------------------------------------------------------------------
// The FIFO poll (R50(a)) and the seq-anchored status judgement.
// ---------------------------------------------------------------------------

/** What the fixture's status must be in the snapshot taken right after THIS
 *  entry's row. Before the last event the expected status is the engine's
 *  own rule, not a constant: `fixtureStatusFromFold` (append-event.ts) says
 *  `in_play` only once `core.start` is in the stream and `scheduled` until
 *  then — a pack typed in after the fact never starts, and must not red for
 *  it. `none` is for `core.finalize`, whose row is verified (I6) but whose
 *  status transition this task does not assert. */
type StatusRule =
  | { readonly kind: "in_play_after_start" }
  | { readonly kind: "live_before_last"; readonly expected: "in_play" | "scheduled" }
  | { readonly kind: "decided_at_last" }
  | { readonly kind: "none" };

interface PendingVerification {
  readonly index: number;
  readonly resolved: { readonly type: string; readonly payload: unknown };
  readonly statusRule: StatusRule;
  readonly tolerableExtraKeys: readonly string[];
}

/** A row verified by one ledger read, judged against that read's snapshot. */
interface LandedRow {
  readonly seq: number;
  readonly entry: PendingVerification;
}

interface Verification {
  readonly pending: PendingVerification[];
  /** The ledger anchor: the seq of the last row this driver has READ. */
  seq: number;
  readonly findings: string[];
  readonly observations: string[];
}

function labelOf(entry: PendingVerification): string {
  return `event ${entry.index} (${entry.resolved.type})`;
}

function applyStatusRule(entry: PendingVerification, status: string, findings: string[]): void {
  const rule = entry.statusRule;
  switch (rule.kind) {
    case "in_play_after_start":
      if (status !== "in_play") findings.push(`status: expected "in_play" after core.start, got "${status}"`);
      return;
    case "live_before_last":
      if (status === "decided") {
        findings.push(`status: the fixture was already "decided" right after ${labelOf(entry)} landed — decided early`);
      } else if (status !== rule.expected) {
        findings.push(`status: expected "${rule.expected}" before the last event, got "${status}" right after ${labelOf(entry)} landed`);
      }
      return;
    case "decided_at_last":
      if (status !== "decided") findings.push(`status: expected "decided" exactly at the last event, got "${status}"`);
      return;
    case "none":
      return;
  }
}

/** The tip moved past this row before any snapshot showed the state right
 *  after it. Never silent: an observation for an intermediate row (a burst
 *  on a correct product does this), a finding for the last event. */
function recordUnjudgeable(row: LandedRow, tip: number, v: Verification): void {
  const label = labelOf(row.entry);
  if (row.entry.statusRule.kind === "decided_at_last") {
    v.findings.push(
      `status: could not judge "decided" at the last event — ${label} landed at seq ${row.seq}, but the ledger tip had already moved on to seq ${tip}`,
    );
    return;
  }
  v.observations.push(
    `${label}: status not judged — its row (seq ${row.seq}) landed together with a later one, so no snapshot showed the fixture right after it (tip seq ${tip})`,
  );
}

/**
 * Judges the rows ONE ledger read verified against ONE snapshot taken right
 * after it. Only the row at the snapshot's own tip can be judged; every
 * earlier row in the read is unjudgeable (see the header). The snapshot is
 * never older than the read, so no row is ever ahead of the tip.
 */
async function judgeLanded(input: PlayMatchInput, v: Verification, landed: readonly LandedRow[]): Promise<void> {
  const snapshot = await fetchFixtureStatus(input.base, input.session, input.fixtureId, input.ledger);
  for (const row of landed) {
    if (row.seq === snapshot.lastSeq) applyStatusRule(row.entry, snapshot.status, v.findings);
    else recordUnjudgeable(row, snapshot.lastSeq, v);
  }
}

/**
 * Bounded poll of `since_seq=v.seq`, consuming rows in pack order against the
 * FIFO head. The anchor advances past every row read, matched or not (an
 * extra row still moves it, or it would be re-reported on every later read).
 * A transport failure propagates to the caller's catch (R50(c)).
 */
async function drainPending(
  input: PlayMatchInput,
  v: Verification,
  attempts: number,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  for (let attempt = 0; attempt < attempts && v.pending.length > 0; attempt += 1) {
    if (attempt > 0) await sleep(LEDGER_POLL_INTERVAL_MS);
    const rows: readonly LedgerRow[] = await fetchFixtureLedger(input.base, input.session, input.fixtureId, v.seq, input.ledger);
    const landed: LandedRow[] = [];
    for (const row of rows) {
      v.seq = row.seq;
      const head = v.pending.shift();
      if (head === undefined) {
        v.findings.push(`ledger: an extra row landed with nothing tapped left to expect it (type "${row.type}", seq ${row.seq})`);
        continue;
      }
      const label = labelOf(head);
      if (row.type !== head.resolved.type) {
        v.findings.push(`ledger: ${label} — type mismatch: the pack meant "${head.resolved.type}", the server recorded "${row.type}"`);
      }
      const cmp = comparePayload(head.resolved.payload, row.payload, head.tolerableExtraKeys);
      if (cmp.mismatchKey !== undefined) {
        const wanted = JSON.stringify(normalizeToRecord(head.resolved.payload)[cmp.mismatchKey]);
        const got = JSON.stringify(normalizeToRecord(row.payload)[cmp.mismatchKey]);
        v.findings.push(`ledger: ${label} — payload key "${cmp.mismatchKey}" mismatch: the pack meant ${wanted}, the server recorded ${got}`);
      }
      for (const observation of cmp.observations) v.observations.push(`${label}: ${observation}`);
      if (head.statusRule.kind !== "none") landed.push({ seq: row.seq, entry: head });
    }
    if (landed.length > 0) await judgeLanded(input, v, landed);
  }
}

// ---------------------------------------------------------------------------
// The loop.
// ---------------------------------------------------------------------------

/**
 * Plays one fixture's stream by tapping the real pad, verifying every commit
 * against the ledger (R50(a)) and judging status per verified row. Never
 * rejects (R50(c)).
 */
export async function playMatchByTaps(input: PlayMatchInput): Promise<PlayMatchResult> {
  const sleep = input.sleep ?? realSleep;
  const findings: string[] = [];
  const observations: string[] = [];
  const start = performance.now();
  let taps = 0;
  let tappedBefore = false;

  async function tap(page: PadPage, steps: readonly TapStep[]): Promise<void> {
    // R39 — pace every tap after the first like a deliberate human repeat.
    if (tappedBefore) await sleep(TAP_PACING_MS);
    tappedBefore = true;
    await executeSteps(page, steps);
    taps += 1;
  }

  function finish(): PlayMatchResult {
    return { fixtureId: input.fixtureId, taps, wallMs: Math.round(performance.now() - start), findings, observations };
  }

  try {
    await input.scorerPage.goto(input.deviceUrl);
    await input.organiserPage.setViewportSize(ORGANISER_VIEWPORT);

    let entrants: { home: string; away: string };
    try {
      entrants = {
        home: resolveEntrantRef(input.stream.home, input.refIdByKey),
        away: resolveEntrantRef(input.stream.away, input.refIdByKey),
      };
    } catch (err) {
      findings.push(`entrants: ${messageOf(err)}`);
      return finish();
    }
    const ctx: TapAdapterContext = { cfg: input.cfg, entrants };

    const initial = await fetchFixtureStatus(input.base, input.session, input.fixtureId, input.ledger);
    if (initial.status !== "scheduled") {
      findings.push(`status: expected "scheduled" before the first tap, got "${initial.status}"`);
    }
    const v: Verification = { pending: [], seq: initial.lastSeq, findings, observations };

    const events = input.stream.events;
    let startTapped = false;
    for (let i = 0; i < events.length; i += 1) {
      const event = events[i];
      const resolved = { type: event.type, payload: resolvePayloadRefs(event.payload, input.refIdByKey, "scorer") };

      let steps: readonly TapStep[];
      try {
        steps = input.adapter.stepsFor(resolved, ctx);
      } catch (err) {
        findings.push(`adapter: cannot map event ${i} (${event.type}) to a tap — ${messageOf(err)}`);
        return finish();
      }

      try {
        await tap(input.scorerPage, steps);
      } catch (err) {
        findings.push(`tap: event ${i} (${event.type}) failed — ${messageOf(err)}`);
        return finish();
      }

      if (event.type === "core.start") startTapped = true;
      const statusRule: StatusRule =
        event.type === "core.start"
          ? { kind: "in_play_after_start" }
          : i === events.length - 1
            ? { kind: "decided_at_last" }
            : { kind: "live_before_last", expected: startTapped ? "in_play" : "scheduled" };
      v.pending.push({ index: i, resolved, statusRule, tolerableExtraKeys: input.adapter.tolerableExtraKeys?.(event.type) ?? [] });

      await drainPending(input, v, PER_TAP_POLL_ATTEMPTS, sleep);
    }

    // R50(b) — tap `pad-send-now` only when a presence check says it is
    // mounted. `count()` never waits for the control (unlike `waitFor`), so
    // an absent dock costs nothing and is normal while nothing is held.
    const sendNow = selectorForTapStep({ kind: "testid", testid: SEND_NOW_TESTID });
    if ((await input.scorerPage.locator(sendNow).count()) > 0) {
      try {
        await tap(input.scorerPage, [{ kind: "testid", testid: SEND_NOW_TESTID }]);
      } catch (err) {
        // The hold can release ITSELF (its own HOLD_MS tick) between the
        // presence check and the tap, unmounting the dock — correct product
        // behaviour, and the final poll below still verifies every row.
        const stillMounted = (await input.scorerPage.locator(sendNow).count()) > 0;
        if (stillMounted) findings.push(`tap: pad-send-now failed — ${messageOf(err)}`);
        else observations.push("pad-send-now: unmounted before the tap reached it — the hold released on its own");
      }
    }

    // Final bounded drain: whatever `pad-send-now` released, or whatever was
    // still in flight. Anything left at the deadline is a real gap.
    await drainPending(input, v, FINAL_POLL_ATTEMPTS, sleep);
    for (const left of v.pending) {
      findings.push(`ledger: ${labelOf(left)} never landed — gave up after the poll deadline`);
    }
    v.pending.length = 0;

    // `core.finalize` is refused from a device link — driven on the ORGANISER
    // page (`scoring.ts:233-235`) at a viewport ≥768 (R50(h)), and its own row
    // is ledger-verified (I6): `fixture-console.tsx:1105` sends it as `{}`.
    try {
      await tap(input.organiserPage, [{ kind: "testid", testid: FINALIZE_TESTID }]);
    } catch (err) {
      findings.push(`tap: score-finalize failed — ${messageOf(err)}`);
      return finish();
    }
    v.pending.push({ index: events.length, resolved: { type: "core.finalize", payload: {} }, statusRule: { kind: "none" }, tolerableExtraKeys: [] });
    await drainPending(input, v, FINAL_POLL_ATTEMPTS, sleep);
    if (v.pending.length > 0) {
      findings.push(`ledger: expected a "core.finalize" row after tapping score-finalize, none landed`);
    }

    return finish();
  } catch (err) {
    // R50(c) — the last-resort net for a failure nothing above anticipated
    // (`goto`, a ledger refusal mid-poll): "never rejects" has to hold anyway.
    findings.push(`driver: unexpected failure — ${messageOf(err)}`);
    return finish();
  }
}
