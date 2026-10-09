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
//
// ---------------------------------------------------------------------------
// Task 10 fix round 1 (R59) — the routes d-tiny's frozen streams need
// ---------------------------------------------------------------------------
//  - dock chips (`chip`, `offeredChip`) and `releaseHold`: the generic pad
//    amends a HELD half tap from its dock (see those `TapStep` variants).
//  - `text`: typing into a field — the console's reason prompt.
//  - organiser actions: an event the product's `isOrganiserOnlyEvent` names
//    (W2a T9) is mapped by `organiserStepsFor` (never an adapter) and tapped on
//    `organiserPage`,
//    after releasing whatever the pad holds; a stream a forfeit ends is judged
//    "forfeited" at its last event, not "decided" (`terminalStatusOf`).
// Payload equality, pack-order polling, never-rejects and the required
// transport are unchanged.
import { fetchFixtureLedger, fetchFixtureStatus, type LedgerRow, type LedgerTransport } from "../ledger.ts";
import { resolvePayloadRefs } from "../simulate.ts";
import type { Session } from "../http.ts";
// W2a T9 (bf49cd67e) put "what is the organiser's to author" in ONE product module that imports nothing — read by the
// server's refusal and the pad's tile filter. The driver reads the same predicate rather than a mirror of it: the
// "one copy, not two checked against each other" move `import.ts` made for IMPORT_CAPS (bench design §17.3). The
// mirror this replaces had silently lost `core.settle` and chess's forfeit results when T9 widened the rule.
import { isOrganiserOnlyEvent } from "../../../../apps/web/src/lib/organiser-only-events.ts";

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
  | { readonly kind: "half"; readonly side: "home" | "away" }
  /** Task 10 fix round 1 (R59(b)) — a hold-window dock chip, by its
   *  `DockChip.id`. REQUIRED: a chip that never attaches is a finding. */
  | { readonly kind: "chip"; readonly chipId: string }
  /** A dock chip tapped ONLY IF the open dock offers it. The generic pad
   *  offers a person chip only for a side with more than one on-field player
   *  and stamps a sole player into the tap itself (generic.tsx:324-327,
   *  :702-705); the driver cannot see squads, so it waits for the dock to be
   *  open (`pad-send-now`) and taps the chip if it is there. Skipping is never
   *  a pass on its own: the row is still compared exactly (R50(d)). */
  | { readonly kind: "offeredChip"; readonly chipId: string }
  /** Release whatever the pad holds (tap `pad-send-now` if it is mounted) and
   *  wait for that dock to unmount. A tap's dock renders AFTER the tap
   *  returns, so without this a chip step can land on the dock still on screen
   *  for the PREVIOUS hold — whose `mutateHeld` finds no held entry by that id
   *  and amends nothing (queue.ts `mutateHeld`, detail-dock.tsx `tapChip`). */
  | { readonly kind: "releaseHold" }
  /** Type into a text field, by testid (`fill`, which replaces its value). */
  | { readonly kind: "text"; readonly testid: string; readonly value: string };

/** `[data-tile-id]` — tile-grid.tsx:293. `[data-choice-option-id]` —
 *  guided-sheet.tsx:418. `[data-testid="pad-sheet-number"]` —
 *  guided-sheet.tsx:523. `[data-testid="pad-sheet-confirm"]` —
 *  guided-sheet.tsx:549. A bare `testid` kind is `[data-testid="…"]` verbatim
 *  (`score-start-match`, `pad-send-now`, `score-finalize`). `half` is
 *  `scorebug.tsx:342-343`'s own two attributes. A dock chip is
 *  `pad-dock-chip-<chip.id>` (detail-dock.tsx, fix round 1); `releaseHold`
 *  targets `pad-send-now`; `text` is its own testid. */
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
    case "chip":
    case "offeredChip":
      return `[data-testid="${DOCK_CHIP_TESTID_PREFIX}${step.chipId}"]`;
    case "releaseHold":
      return `[data-testid="${SEND_NOW_TESTID}"]`;
    case "text":
      return `[data-testid="${step.testid}"]`;
  }
}

// The chassis-level testids every sport shares (Task 8's stable contract).
export const START_MATCH_TESTID = "score-start-match";
export const SEND_NOW_TESTID = "pad-send-now";
export const FINALIZE_TESTID = "score-finalize";
/** Task 10 fix round 1 — every hold-window dock chip (detail-dock.tsx). */
export const DOCK_CHIP_TESTID_PREFIX = "pad-dock-chip-";
/** Task 10 fix round 1 — the console's forfeit: the toggle, then
 *  `score-forfeit-home|away` (fixture-console.tsx `ForfeitButton`), then the
 *  reason prompt's field and submit (`TextPromptDialog`). */
export const FORFEIT_TESTID = "score-forfeit";
export const FORFEIT_SIDE_TESTID_PREFIX = "score-forfeit-";
export const PROMPT_REASON_TESTID = "score-prompt-reason";
export const PROMPT_SUBMIT_TESTID = "score-prompt-submit";

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
  switch (step.kind) {
    case "releaseHold": {
      // `count()` never waits: nothing held is normal, and costs nothing.
      if ((await locator.count()) === 0) return;
      try {
        await locator.click();
      } catch (err) {
        // The hold can release ITSELF (its own HOLD_MS tick) between the
        // presence check and the tap — the dock is gone, which is the goal.
        if ((await locator.count()) > 0) throw err;
      }
      await locator.waitFor({ state: "detached", timeout: TAP_WAIT_TIMEOUT_MS });
      return;
    }
    case "offeredChip":
      await page.locator(selectorForTapStep({ kind: "releaseHold" })).waitFor({ timeout: TAP_WAIT_TIMEOUT_MS });
      if ((await locator.count()) > 0) await locator.click();
      return;
    case "number":
      await locator.waitFor({ timeout: TAP_WAIT_TIMEOUT_MS });
      await locator.fill(String(step.value));
      return;
    case "text":
      await locator.waitFor({ timeout: TAP_WAIT_TIMEOUT_MS });
      await locator.fill(step.value);
      return;
    default:
      await locator.waitFor({ timeout: TAP_WAIT_TIMEOUT_MS });
      await locator.click();
  }
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
// Organiser actions (Task 10 fix round 1, R59(c)).
// ---------------------------------------------------------------------------
// Some events are the ORGANISER's to author, never a scorer's: the pad filters
// them off every device by design. Which ones is the product's own predicate,
// `isOrganiserOnlyEvent(type, payload)` (`apps/web/src/lib/organiser-only-events.ts`,
// W2a T9 / ruling D-O1: core settle, forfeit and abandon, plus a sport result
// whose declared field records a forfeit) — imported above, never restated.
// Their mapping lives in this sport-blind file, not in an adapter, and every
// step runs on `organiserPage`; an organiser event the console route does not
// map yet is a named finding (`organiserStepsFor` throws), never a scorer tap.

const FORFEIT_PAYLOAD_KEYS: readonly string[] = ["by", "reason"];

/**
 * The console route for an organiser-only event. Only `core.forfeit` is
 * mapped: the Forfeit toggle, the forfeiting side's own "<name> forfeits"
 * button, the reason prompt (it opens pre-filled "walkover", so the pack's
 * reason is TYPED over it), and submit — which sends exactly
 * `core.forfeit {by, reason}` with the reason TRIMMED
 * (fixture-console.tsx `TextPromptDialog` onSubmit, `ForfeitButton` send).
 * A payload that route cannot produce throws, like an adapter's (R50(e)).
 */
export function organiserStepsFor(
  event: { readonly type: string; readonly payload: unknown },
  ctx: TapAdapterContext,
): readonly TapStep[] {
  if (event.type !== "core.forfeit") {
    throw new Error(`no console mapping for event type "${event.type}" — only core.forfeit's console route is mapped`);
  }
  const p =
    typeof event.payload === "object" && event.payload !== null && !Array.isArray(event.payload)
      ? (event.payload as Record<string, unknown>)
      : {};
  const unknown = Object.keys(p).filter((key) => !FORFEIT_PAYLOAD_KEYS.includes(key));
  if (unknown.length > 0) {
    throw new Error(`core.forfeit payload has unknown key(s) ${unknown.join(", ")} — the console sends exactly {by, reason}`);
  }
  if (typeof p.reason !== "string" || p.reason.trim().length === 0) {
    throw new Error("core.forfeit needs a non-empty reason — the console's prompt sends nothing for an empty one");
  }
  if (p.reason !== p.reason.trim()) {
    throw new Error(`core.forfeit reason ${JSON.stringify(p.reason)} is not authorable — the console's prompt trims what it sends`);
  }
  const side = p.by === ctx.entrants.home ? "home" : p.by === ctx.entrants.away ? "away" : undefined;
  if (side === undefined) {
    throw new Error(
      `core.forfeit by "${String(p.by)}" matches neither home ("${ctx.entrants.home}") nor away ("${ctx.entrants.away}")`,
    );
  }
  return [
    { kind: "testid", testid: FORFEIT_TESTID },
    { kind: "testid", testid: `${FORFEIT_SIDE_TESTID_PREFIX}${side}` },
    { kind: "text", testid: PROMPT_REASON_TESTID, value: p.reason },
    { kind: "testid", testid: PROMPT_SUBMIT_TESTID },
  ];
}

/** The status a finished stream leaves the fixture in — `fixtureStatusFromFold`
 *  (append-event.ts:119-129): abandoned first, then forfeited over decided. */
function terminalStatusOf(events: readonly { readonly type: string }[]): string {
  if (events.some((event) => event.type === "core.abandon")) return "abandoned";
  return events.some((event) => event.type === "core.forfeit") ? "forfeited" : "decided";
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
   *  `scorerPage` for a device-link run. Every organiser-only action
   *  (`isOrganiserOnlyEvent`, fix round 1; W2a T9) is driven here too. */
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
  /** Rows still on the server strictly after `core.finalize` was verified —
   *  never judged (nothing past finalize is asserted), but never SILENT
   *  either (NB4): once the finalize row lands, nothing else polls, so
   *  without this a trailing row is simply never read again. `undefined`
   *  only for a caller that builds a `PlayMatchResult` itself without ever
   *  calling this function (`tap-play.ts`'s pre-flight early-exits, before
   *  any scoring starts) — "not measured", never "zero". */
  readonly unreadRowsAfterFinalize?: number;
  /** R86 — this fixture's own scorer-context capture, renamed to a
   *  watchable name (`tap-play.ts`'s `tapVideoFileName`/`tapTraceFileName`)
   *  once the scorer context closes. Set only by `tap-play.ts`'s own
   *  `createTapPlayer` (this driver never touches a browser context
   *  directly); absent when capture was off, or before the context closed. */
  readonly videoPath?: string;
  readonly tracePath?: string;
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

/** A tolerated extra key still opens at ONE derived shape, never any value:
 *  every entry in `TapAdapter.tolerableExtraKeys` names a person id the pad
 *  itself stamps, and the pad's own "named" check
 *  (`generic.tsx:701`, `typeof payload?.person === "string" && payload.person
 *  .length > 0`) treats a person as present only for a non-empty string. A
 *  numeric, empty, or object value at a tolerated key is not a plausible id
 *  the pad could have stamped, so it must red rather than pass as a silent
 *  observation (AGENTS.md class 19 — pin what a tolerated key opens AT, not
 *  just that the name is on the allowlist). */
function isPlausibleTolerableValue(value: unknown): boolean {
  return typeof value === "string" && value.length > 0;
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
    if (tolerable.includes(key) && isPlausibleTolerableValue(actualRecord[key])) {
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
  /** `expected` is `terminalStatusOf(stream)` — "decided", or "forfeited" for
   *  a stream a forfeit ends (fix round 1). */
  | { readonly kind: "decided_at_last"; readonly expected: string }
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
      if (status !== rule.expected) findings.push(`status: expected "${rule.expected}" exactly at the last event, got "${status}"`);
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
  const rule = row.entry.statusRule;
  if (rule.kind === "decided_at_last") {
    v.findings.push(
      `status: could not judge "${rule.expected}" at the last event — ${label} landed at seq ${row.seq}, but the ledger tip had already moved on to seq ${tip}`,
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
  let unreadRowsAfterFinalize = 0;

  async function tap(page: PadPage, steps: readonly TapStep[], releaseHoldFirstOn?: PadPage): Promise<void> {
    // R39 — pace every tap after the first like a deliberate human repeat.
    if (tappedBefore) await sleep(TAP_PACING_MS);
    tappedBefore = true;
    if (releaseHoldFirstOn !== undefined) await executeStep(releaseHoldFirstOn, { kind: "releaseHold" });
    await executeSteps(page, steps);
    taps += 1;
  }

  function finish(): PlayMatchResult {
    return {
      fixtureId: input.fixtureId,
      taps,
      wallMs: Math.round(performance.now() - start),
      findings,
      observations,
      unreadRowsAfterFinalize,
    };
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
    const terminalStatus = terminalStatusOf(events);
    let startTapped = false;
    for (let i = 0; i < events.length; i += 1) {
      const event = events[i];
      const resolved = { type: event.type, payload: resolvePayloadRefs(event.payload, input.refIdByKey, "scorer") };
      const organiserAction = isOrganiserOnlyEvent(resolved.type, resolved.payload);

      let steps: readonly TapStep[];
      try {
        steps = organiserAction ? organiserStepsFor(resolved, ctx) : input.adapter.stepsFor(resolved, ctx);
      } catch (err) {
        findings.push(
          organiserAction
            ? `organiser: cannot map event ${i} (${event.type}) to a console action — ${messageOf(err)}`
            : `adapter: cannot map event ${i} (${event.type}) to a tap — ${messageOf(err)}`,
        );
        return finish();
      }

      try {
        // R59(c) — an organiser-only event is authored on the CONSOLE. Whatever
        // the pad still holds is released first, or the organiser's row would
        // land ahead of it and the ledger would no longer be in pack order.
        if (organiserAction) await tap(input.organiserPage, steps, input.scorerPage);
        else await tap(input.scorerPage, steps);
      } catch (err) {
        findings.push(`tap: event ${i} (${event.type}) failed — ${messageOf(err)}`);
        return finish();
      }

      if (event.type === "core.start") startTapped = true;
      const statusRule: StatusRule =
        event.type === "core.start"
          ? { kind: "in_play_after_start" }
          : i === events.length - 1
            ? { kind: "decided_at_last", expected: terminalStatus }
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

    // NB4 — `drainPending` stops reading the instant its FIFO empties, so once
    // `core.finalize` lands nothing ever polls again: a row that lands after
    // it would otherwise be swallowed with no finding and no observation,
    // ever. One bounded read past the current anchor closes that — never
    // judged (nothing past finalize is asserted), but never silent either.
    const trailing = await fetchFixtureLedger(input.base, input.session, input.fixtureId, v.seq, input.ledger);
    unreadRowsAfterFinalize = trailing.length;
    if (trailing.length > 0) {
      const first = trailing[0];
      findings.push(
        `ledger: ${trailing.length} row(s) landed after core.finalize was verified and were never read — the bench stops ` +
          `polling once finalize lands (first unread: type "${first.type}", seq ${first.seq})`,
      );
    }

    return finish();
  } catch (err) {
    // R50(c) — the last-resort net for a failure nothing above anticipated
    // (`goto`, a ledger refusal mid-poll): "never rejects" has to hold anyway.
    findings.push(`driver: unexpected failure — ${messageOf(err)}`);
    return finish();
  }
}
