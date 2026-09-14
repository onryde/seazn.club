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
// Re-pinned against the tree (the brief's own lines had drifted — AGENTS.md
// failure class 5, "the brief is a hypothesis"):
// ---------------------------------------------------------------------------
//  - `fetchFixtureLedger`/`fetchFixtureStatus`/`LedgerRow`/`LedgerTransport`
//    are `../ledger.ts:112,132,71,26` — `fetchFixtureStatus` returns
//    `{status, lastSeq}` (camelCase), not the wire's `last_seq`.
//  - `resolvePayloadRefs` is `../simulate.ts:177` — takes `(value,
//    refIdByKey, caller?)` and expects a `"@ref"` sigil on every string it
//    should resolve; a bare ref (no `@`) is returned unchanged, which is why
//    this file resolves `stream.home`/`stream.away` itself (they carry no
//    sigil at all — see `resolveEntrantRef` below) rather than routing them
//    through `resolvePayloadRefs`.
//  - `launchRegistrationBrowser`/`newOrganiserBrowserSession`/
//    `newAnonymousBrowserSession`/`closeRegistrationBrowserSession`
//    (`browser.ts:67,91,102,108`) are the REGISTRATION driver's session
//    lifecycle — this file does not call them. `PlayMatchInput` takes
//    already-open `scorerPage`/`organiserPage` handles; Task 10 (which does
//    own a real Playwright `Browser`) is the caller that mints and closes
//    those sessions, exactly as `register.ts` does today for the
//    registration flow. Importing the launch/session helpers here would
//    buy nothing (this file never opens or closes a browser) and would
//    couple a sport-blind driver to a registration-specific session shape.
//  - The brief's own `TapStep`/`TapAdapter` sketch has NO way to click a
//    scorebug half — Task 8's stable contract puts no testid on a half at
//    all (`data-role="v3-scorebug-half"][data-side="home"|"away"]`,
//    `scorebug.tsx:342-343`). Added a `{kind:"half"; side}` variant; see its
//    own doc below.
// ---------------------------------------------------------------------------
// Payload comparison — pack-key equality, not full deep-equality
// ---------------------------------------------------------------------------
// `generic.tsx`'s own `buildHalf` (:324-328) auto-stamps a `person` key onto
// a `generic.score` tap's payload whenever the tapped side has exactly one
// on-field player (the SOLE-SCORER auto-set) — a key the pack's own authored
// event never carries (a pack author has no reason to write `person` on an
// event whose side has only one possible scorer). A full deep-equal against
// the pack's payload would therefore red on every solo-player fixture for a
// reason that is not a defect. So `verifyFlushed` below pins EXACT equality
// on every key the PACK's OWN payload declares, and tolerates (never
// requires the ABSENCE of) extra keys the server/pad added — "pin exact
// equality on every pack key", per this task's own ruling. This is a
// deliberate asymmetry from a plain object-equality check, and it is
// recorded here (not silently) exactly because a subset match can also hide
// a REAL bug (a key the pack cares about, silently dropped) — which is why
// the check still walks every pack key rather than skipping the comparison
// altogether.
import {
  defaultLedgerTransport,
  fetchFixtureLedger,
  fetchFixtureStatus,
  type LedgerRow,
  type LedgerTransport,
} from "../ledger.ts";
import { resolvePayloadRefs } from "../simulate.ts";
import type { Session } from "../http.ts";

// ---------------------------------------------------------------------------
// Taps — the vocabulary a scorer's finger actually has. Every kind maps to
// exactly one selector (`selectorForTapStep`), so the driver and its tests
// share one definition of "what does this step click" rather than each
// re-deriving it.
// ---------------------------------------------------------------------------
export type TapStep =
  | { readonly kind: "tile"; readonly tileId: string }
  | { readonly kind: "choice"; readonly optionId: string }
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "confirm" }
  | { readonly kind: "testid"; readonly testid: string }
  /** A scorebug half — Task 8's contract gives halves no testid at all
   *  (`data-role="v3-scorebug-half"][data-side="…"]`, `scorebug.tsx:342-343`),
   *  so this is the one TapStep kind whose selector is NOT keyed by a stable
   *  id string the way every other kind's is. Not in the brief's own sketch
   *  (repin, AGENTS.md failure class 5) — a generic/football/etc. half tap
   *  has nothing else to click. */
  | { readonly kind: "half"; readonly side: "home" | "away" };

/** `[data-tile-id]` — tile-grid.tsx:293. `[data-choice-option-id]` —
 *  guided-sheet.tsx:418. `[data-testid="pad-sheet-number"]` —
 *  guided-sheet.tsx:523 (the guided sheet shows one step at a time, so the
 *  testid is unambiguous whenever a number step is actually on screen).
 *  `[data-testid="pad-sheet-confirm"]` — guided-sheet.tsx:549. A bare
 *  `testid` kind is `[data-testid="…"]` verbatim — the chassis-level
 *  controls (`score-start-match`, `pad-send-now`, `score-finalize`) all take
 *  this shape. `half` is `scorebug.tsx:342-343`'s own two attributes. */
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

// ---------------------------------------------------------------------------
// The chassis-level testids every sport shares (Task 8's stable contract).
// Exported so an adapter (e.g. `adapters/generic.ts`'s own `core.start` ->
// button mapping) names the SAME string this file does, rather than a
// second copy that can drift.
// ---------------------------------------------------------------------------
export const START_MATCH_TESTID = "score-start-match";
export const SEND_NOW_TESTID = "pad-send-now";
export const FINALIZE_TESTID = "score-finalize";

/**
 * The pacing floor — R39. The brief says the driver IMPORTS
 * `HUMAN_FASTEST_REPEAT_MS` (`use-pad-pipeline.ts:351`), but that module is
 * `"use client"` React, and scripts/bench never imports from apps/web in
 * PRODUCTION code (only its own tests may — see `oracle.ts`/`pack-schema.ts`'s
 * existing precedent of citing apps/web by file:line comment rather than
 * importing it). So this constant is declared locally, and
 * `__tests__/scorer-driver.test.ts` imports the REAL `HUMAN_FASTEST_REPEAT_MS`
 * and asserts the two are equal — the same "restate, then prove equal to the
 * source of truth" posture `generic.tsx` itself takes for
 * `MAX_PLAUSIBLE_SCORE`/`MAX_TALLY_STEP`. A rename or a re-tune of the real
 * constant reds this test rather than silently drifting.
 *
 * `HUMAN_FASTEST_REPEAT_MS` (350) is deliberately ABOVE the guard's actual
 * window, `DOUBLE_SUBMIT_WINDOW_MS` (250, same file) — it is the floor the
 * window is held UNDER by a test there, not the window itself. Pacing at
 * this value therefore clears the real guard with margin, the same way a
 * human's fastest DELIBERATE repeat would.
 */
export const TAP_PACING_MS = 350;

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// The narrow Page/Locator surface this driver needs — same DI-for-
// testability shape every transport in this bench takes (`SimTransport`,
// `LedgerTransport`, `browser.ts`'s own poll-loop fetcher): exactly the
// primitives used, nothing else, so a fake needs no real Playwright object
// at all (design §9's own "browser drivers have no meaningful unit test"
// floor — this is that floor for THIS driver).
// ---------------------------------------------------------------------------
export interface PadLocator {
  click(): Promise<void>;
  fill(value: string): Promise<void>;
  waitFor(options?: { readonly state?: string }): Promise<void>;
  count(): Promise<number>;
}

export interface PadPage {
  locator(selector: string): PadLocator;
  goto(url: string): Promise<void>;
  setViewportSize(size: { readonly width: number; readonly height: number }): Promise<void>;
}

/** The organiser page's own `device-handover` control (and, on this
 *  fixture-console page, `score-finalize`) is `max-md:hidden` below Tailwind
 *  `md` (768) — AGENTS.md's phone-composition note. `score-finalize` is
 *  driven on the ORGANISER page (see this file's header on why), so this
 *  file sets a desktop-sized viewport there before touching it, rather than
 *  assuming Task 10's caller already did. */
export const ORGANISER_VIEWPORT = { width: 1280, height: 900 } as const;

async function executeStep(page: PadPage, step: TapStep): Promise<void> {
  const locator = page.locator(selectorForTapStep(step));
  await locator.waitFor();
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
// The adapter contract. Sport-blind on this file's side: `stepsFor` receives
// the event with its payload ALREADY RESOLVED (refs substituted via
// `resolvePayloadRefs` — the SAME resolved payload this file compares the
// ledger against), so an adapter never needs `refIdByKey` itself. `entrants`
// is likewise resolved (real ids, not pack refs) — see `resolveEntrantRef`.
// ---------------------------------------------------------------------------
export interface TapAdapterContext {
  /** The fixture's resolved sport config (e.g. `GenericCfg`), opaque to this
   *  file — an adapter reads whatever shape its own sport needs. */
  readonly cfg: unknown;
  /** The two sides' real entrant ids, resolved from the pack's own
   *  `stream.home`/`stream.away` refs — what an event's resolved `by`/
   *  `winnerId` is compared against to pick a scorebug half. */
  readonly entrants: { readonly home: string; readonly away: string };
}

export interface TapAdapter {
  readonly sport: string;
  /**
   * `event.payload` is the pack's own payload with every `@ref` already
   * resolved to a real id (this file's own job, done once per event — see
   * `playMatchByTaps`). An event this adapter cannot map MUST throw rather
   * than fall back to some default or silently drop the tap — the driver
   * turns that throw into a `PlayMatchResult.finding` and stops (this
   * task's own ruling: "an event the adapter cannot map becomes a finding,
   * never a fallback").
   */
  stepsFor(event: { readonly type: string; readonly payload: unknown }, ctx: TapAdapterContext): readonly TapStep[];
}

// ---------------------------------------------------------------------------
// Input/result.
// ---------------------------------------------------------------------------

/** The slice of a `PackStream` this driver needs — `home`/`away` (plain pack
 *  refs, no `@` sigil — `pack-schema.ts:176-180`'s `PackRef`) plus the
 *  authored events. Structurally compatible with a real `PackStream`, so
 *  Task 10 can pass one straight through without a cast. */
export interface PlayMatchStream {
  readonly home: string;
  readonly away: string;
  readonly events: readonly { readonly type: string; readonly payload: unknown }[];
}

export interface PlayMatchInput {
  readonly scorerPage: PadPage;
  /** Where `score-finalize` is actually driven — `scoring.ts:233-235`
   *  refuses a `core.finalize` from a device link outright ("Finalizing
   *  needs an organiser or scorer account"), so this can never be the same
   *  page as `scorerPage` for a device-link run. */
  readonly organiserPage: PadPage;
  readonly deviceUrl: string;
  readonly fixtureId: string;
  readonly stream: PlayMatchStream;
  readonly adapter: TapAdapter;
  readonly refIdByKey: ReadonlyMap<string, string>;
  /** The ONE transport every HTTP read this driver makes goes through
   *  (R40) — both `fetchFixtureLedger` and `fetchFixtureStatus` take it as
   *  their own `transport` param. The driver never calls `raw()` directly
   *  and never POSTs anything itself; every write happens as a SIDE EFFECT
   *  of a real tap on `scorerPage`/`organiserPage`. A test can therefore
   *  prove "no fallback" by recording every call this object receives and
   *  asserting none of them is a non-GET. */
  readonly ledger: LedgerTransport;
  readonly base: string;
  readonly session: Session;
  /** The fixture's resolved sport config, forwarded to the adapter verbatim
   *  (`TapAdapterContext.cfg`). Optional — an adapter's own fail-safe
   *  default (mirroring the real module's) covers a caller that has not
   *  resolved one. */
  readonly cfg?: unknown;
  /** Test-only: a `sleep` that RECORDS rather than waits. Defaults to a real
   *  `setTimeout`-based sleep. */
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface PlayMatchResult {
  readonly fixtureId: string;
  readonly taps: number;
  readonly wallMs: number;
  readonly findings: readonly string[];
}

// ---------------------------------------------------------------------------
// Ref resolution for `stream.home`/`stream.away` — plain refs, no `@` sigil,
// so `resolvePayloadRefs` (which only ever resolves a STRING that starts
// with `@`) is the wrong tool here; this is the same lookup with the same
// "unresolved is a bug, not a maybe" posture (`simulate.ts:186-190`).
// ---------------------------------------------------------------------------
function resolveEntrantRef(ref: string, refIdByKey: ReadonlyMap<string, string>): string {
  const id = refIdByKey.get(ref);
  if (id === undefined) {
    throw new Error(`scorer: entrant ref "${ref}" resolved to no known id — check what seedSuite actually bound`);
  }
  return id;
}

// ---------------------------------------------------------------------------
// Ledger comparison — see this file's header "Payload comparison" note for
// why this is pack-key equality, not full deep-equality.
// ---------------------------------------------------------------------------
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === "object" && a !== null && typeof b === "object" && b !== null) {
    const ak = Object.keys(a);
    const br = b as Record<string, unknown>;
    return (
      ak.length === Object.keys(br).length &&
      ak.every((k) => deepEqual((a as Record<string, unknown>)[k], br[k]))
    );
  }
  return false;
}

/** The first pack payload key whose server-recorded value disagrees, or
 *  `undefined` if every pack key matches (extra server-only keys allowed —
 *  see the header note). A non-object pack payload has no keys to pin, so
 *  it is not a mismatch on its own (the `type` check next to every call site
 *  of this function already covers a bare/empty payload). */
function firstPackKeyMismatch(expected: unknown, actual: unknown): string | undefined {
  if (typeof expected !== "object" || expected === null) return undefined;
  const actualRecord = typeof actual === "object" && actual !== null ? (actual as Record<string, unknown>) : undefined;
  for (const [key, value] of Object.entries(expected as Record<string, unknown>)) {
    if (actualRecord === undefined || !deepEqual(actualRecord[key], value)) return key;
  }
  return undefined;
}

async function verifyFlushed(
  input: PlayMatchInput,
  expected: { readonly type: string; readonly payload: unknown },
  sinceSeq: number,
  findings: string[],
  label: string,
): Promise<number> {
  const rows: readonly LedgerRow[] = await fetchFixtureLedger(
    input.base,
    input.session,
    input.fixtureId,
    sinceSeq,
    input.ledger,
  );
  if (rows.length !== 1) {
    findings.push(`ledger: expected exactly one new row for ${label}, got ${rows.length}`);
    return rows.length > 0 ? rows[rows.length - 1].seq : sinceSeq;
  }
  const row = rows[0];
  if (row.type !== expected.type) {
    findings.push(`ledger: ${label} — type mismatch: the pack meant "${expected.type}", the server recorded "${row.type}"`);
  }
  const badKey = firstPackKeyMismatch(expected.payload, row.payload);
  if (badKey !== undefined) {
    const wanted = JSON.stringify((expected.payload as Record<string, unknown>)[badKey]);
    const got = JSON.stringify((row.payload as Record<string, unknown> | undefined)?.[badKey]);
    findings.push(`ledger: ${label} — payload key "${badKey}" mismatch: the pack meant ${wanted}, the server recorded ${got}`);
  }
  return row.seq;
}

// ---------------------------------------------------------------------------
// The loop.
// ---------------------------------------------------------------------------

/**
 * Plays one fixture's stream by tapping the real pad, verifying every
 * commit against the ledger, and asserting the fixture's status transitions
 * along the way. See this file's header for the payload-comparison ruling
 * and the R39 pacing note.
 *
 * THE ONE-BEHIND RULE (this task's own ruling): a held tap is flushed by the
 * NEXT tap (`queue.ts:353`'s `flushHeldBefore`, fired synchronously inside
 * `enqueueHeld`), so this driver verifies event N's ledger row only once
 * event N+1 has been tapped (which is what actually sends it) — never right
 * after tapping N itself, which would read the ledger before the row can
 * possibly exist. The LAST event has no "next tap" to flush it, so it is
 * flushed explicitly via `pad-send-now` and verified immediately after.
 * `core.start` is a DIFFERENT kind of action — a plain immediate POST
 * (`device-score-pad.tsx`'s own `send()`), never held — so it is verified
 * right after its own tap, with no one-behind delay.
 */
export async function playMatchByTaps(input: PlayMatchInput): Promise<PlayMatchResult> {
  const sleep = input.sleep ?? realSleep;
  const findings: string[] = [];
  const start = performance.now();
  let taps = 0;
  let tappedBefore = false;

  async function tap(page: PadPage, steps: readonly TapStep[]): Promise<void> {
    // R39 — pace every tap after the first like a deliberate human repeat,
    // so the product's own double-submit guard never eats one of ours.
    if (tappedBefore) await sleep(TAP_PACING_MS);
    tappedBefore = true;
    await executeSteps(page, steps);
    taps += 1;
  }

  function finish(): PlayMatchResult {
    return {
      fixtureId: input.fixtureId,
      taps,
      wallMs: Math.round(performance.now() - start),
      findings,
    };
  }

  await input.scorerPage.goto(input.deviceUrl);
  await input.organiserPage.setViewportSize(ORGANISER_VIEWPORT);

  const entrants = {
    home: resolveEntrantRef(input.stream.home, input.refIdByKey),
    away: resolveEntrantRef(input.stream.away, input.refIdByKey),
  };
  const ctx: TapAdapterContext = { cfg: input.cfg, entrants };

  const initial = await fetchFixtureStatus(input.base, input.session, input.fixtureId, input.ledger);
  if (initial.status !== "scheduled") {
    findings.push(`status: expected "scheduled" before the first tap, got "${initial.status}"`);
  }
  let lastSeq = initial.lastSeq;

  const events = input.stream.events;
  let pendingHeld: { readonly index: number; readonly resolved: { type: string; payload: unknown } } | undefined;

  for (let i = 0; i < events.length; i += 1) {
    const event = events[i];
    const resolvedPayload = resolvePayloadRefs(event.payload, input.refIdByKey, "scorer");
    const resolved = { type: event.type, payload: resolvedPayload };

    let steps: readonly TapStep[];
    try {
      steps = input.adapter.stepsFor(resolved, ctx);
    } catch (err) {
      findings.push(
        `adapter: cannot map event ${i} (${event.type}) to a tap — ${err instanceof Error ? err.message : String(err)}`,
      );
      return finish();
    }

    if (event.type === "core.start") {
      await tap(input.scorerPage, steps);
      lastSeq = await verifyFlushed(input, resolved, lastSeq, findings, `event ${i} (core.start)`);
      const status = await fetchFixtureStatus(input.base, input.session, input.fixtureId, input.ledger);
      if (status.status !== "in_play") {
        findings.push(`status: expected "in_play" after core.start, got "${status.status}"`);
      }
      continue;
    }

    const isLast = i === events.length - 1;

    // Tapping THIS event flushes whatever was held before it
    // (`flushHeldBefore`, fired synchronously inside the real `enqueueHeld`).
    await tap(input.scorerPage, steps);

    if (pendingHeld !== undefined) {
      lastSeq = await verifyFlushed(
        input,
        pendingHeld.resolved,
        lastSeq,
        findings,
        `event ${pendingHeld.index} (${pendingHeld.resolved.type})`,
      );
      pendingHeld = undefined;
    }

    if (!isLast) {
      pendingHeld = { index: i, resolved };
      continue;
    }

    // The last event is now HELD (not yet sent) — assert the fixture has not
    // already decided from an earlier event (a decided-early fixture is a
    // real defect, never a silent skip).
    const preFlush = await fetchFixtureStatus(input.base, input.session, input.fixtureId, input.ledger);
    if (preFlush.status === "decided") {
      findings.push(
        `status: the fixture was already "decided" before its last event (${resolved.type}) was even flushed — decided early`,
      );
    } else if (preFlush.status !== "in_play") {
      findings.push(`status: expected "in_play" before the last event, got "${preFlush.status}"`);
    }

    await tap(input.scorerPage, [{ kind: "testid", testid: SEND_NOW_TESTID }]);
    lastSeq = await verifyFlushed(input, resolved, lastSeq, findings, `event ${i} (${resolved.type}, last)`);

    const decided = await fetchFixtureStatus(input.base, input.session, input.fixtureId, input.ledger);
    if (decided.status !== "decided") {
      findings.push(`status: expected "decided" exactly at the last event, got "${decided.status}"`);
    }
  }

  // `core.finalize` is refused from a device link — driven on the ORGANISER
  // page, after every event has landed and been verified (this task's own
  // "one behind" ruling: "the last event is flushed with pad-send-now, then
  // verified, then score-finalize").
  await tap(input.organiserPage, [{ kind: "testid", testid: FINALIZE_TESTID }]);

  return finish();
}

// Re-exported so a caller that only has `scripts/bench/lib/drivers/scorer.ts`
// in scope can still reach the real transport without a second import path.
export { defaultLedgerTransport };
