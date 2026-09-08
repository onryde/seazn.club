"use client";

// P10 §4/Task 6: the board's live capacity precheck, read from the server
// (POST /api/v1/divisions/{id}/schedule/capacity — capacity-guard.ts's
// assessCapacityForDivision) instead of computed locally. The client
// computation this hook replaces (settings-panel.tsx's/stages-panel.tsx's
// own useMemo, calling capacityInputForFixtures + assessCapacity directly)
// could only ever OVERSTATE supply — no court calendars ever reached the
// browser, on purpose, since P9 (capacity-input.ts's own usableWindowsFor
// doc comment). This hook is the ONLY producer of a CapacityReport on the
// client: no capacityInputForFixtures/assessCapacity call exists anywhere
// near it. A local fallback computation — even one used only while a
// request is in flight — would be the placer/verifier fork wearing a
// different hat (design doc §4), so there is none: while a request is
// pending, this hook holds the PREVIOUS resolved report and marks it
// `stale` rather than inventing a number.
//
// `fixtures`/`config` mirror the server's CapacityPrecheckInput field-for-
// field (capacity-guard.ts), which itself mirrors CapacityFixtureInput/
// CapacityConfigInput (capacity-input.ts) minus `tz` and `courtCalendars` —
// both server-resolved, never client-supplied (see CapacityReportConfig's
// own comment below). Both existing call sites already build fixtures in
// this exact shape for their own (now-removed) local computation, so no
// second mapping step is needed on the client side of the wire either.
import { useEffect, useRef, useState } from "react";
import { apiV1 } from "@/lib/client-v1";
import type { CapacityFixtureInput, CapacityConfigInput } from "@/lib/capacity-input";
import { CAPACITY_PRECHECK_MAX_COURTS, CAPACITY_PRECHECK_MAX_FIXTURES } from "@/lib/capacity-bounds";
import type { CapacityReport } from "@seazn/engine/scheduling/capacity";

const DEBOUNCE_MS = 300;

/** The wire body's `config` shape (capacity-guard.ts's CapacityPrecheckInput):
 *  CapacityConfigInput minus the two fields only the server can ever supply.
 *  `tz` is never client-supplied — `settings.orgTz` is the governing clock
 *  (#397) and the server resolves it itself. `courtCalendars` is what the
 *  whole endpoint exists to add, and can only come from the DB. */
export type CapacityReportConfig = Omit<CapacityConfigInput, "tz" | "courtCalendars">;

export interface UseCapacityReportResult {
  /** The most recently RESOLVED report. Held across an in-flight refetch —
   *  never reset to null just because a new edit landed — so the card
   *  never blanks mid-edit (capacity-card.tsx's own `stale` prop reads
   *  this alongside it). Null before the first report has ever arrived, or
   *  whenever the current inputs have no bounded window to assess at all
   *  (matching capacityInputForFixtures's own null contract — see
   *  `hasAssessableWindow` below). */
  report: CapacityReport | null;
  /** True whenever `report` may no longer reflect the CURRENT
   *  `fixtures`/`config` — a debounced edit is pending, its request is in
   *  flight, or it failed and never got to resolve. False once the held
   *  report was itself computed from exactly these inputs. Derived at
   *  render time (not a separate state slot fed from the effect), so it
   *  flips the instant an edit lands — no need to wait for the debounce
   *  timer to even start. */
  stale: boolean;
  /** Review fix (Finding 1/2): true when the most recent fetch attempt for
   *  the CURRENT `fixtures`/`config` failed for a REAL reason — a superseded
   *  abort is never a failure, see `scheduleCapacityFetch`'s own AbortError
   *  branch — and its one retry also failed. `report` still holds the last
   *  known-good numbers (or null if none ever arrived); this is what tells a
   *  caller the check has actually STOPPED running rather than merely
   *  catching up. Callers must fail OPEN on this: a check that could not
   *  complete is not evidence of "impossible" (owner ruling — Solve is
   *  hard-blocked only on a genuinely fresh `impossible` verdict, never a
   *  stale guess; see stages-panel.tsx's `capacityGateBlocks`). */
  failed: boolean;
}

/** Mirrors capacityInputForFixtures's OWN null contract for `window` — this
 *  hook's config carries no `tz` to check (see CapacityReportConfig's own
 *  comment: the server always resolves and supplies that half), so only
 *  the window half applies here. This is not a second capacity
 *  COMPUTATION — no number is produced or guessed, it only recognises a
 *  request whose answer capacity-input.ts already guarantees is null
 *  before it is ever sent, the same way the removed client useMemo never
 *  called assessCapacity for an unbounded window either. Both bounds must
 *  be FINITE, not just defined: a window with only a start or only an end
 *  (`from: -Infinity`/`to: Infinity` — both call sites' own convention for
 *  "no boundary set") is exactly the state capacity-input.ts's own doc
 *  comment names as a real shipped crash on the old client path
 *  (`dayKeyInTz(-Infinity, tz)` throwing `RangeError: Invalid time
 *  value`); skipping the request here is a strictly safer default even
 *  though the server guards the same case on its own side too. */
function hasAssessableWindow(config: CapacityReportConfig): boolean {
  return (
    config.window !== undefined &&
    Number.isFinite(config.window.from) &&
    Number.isFinite(config.window.to)
  );
}

/**
 * The ONE predicate both hooks ask before scheduling anything: is this
 * request worth putting on the wire at all?
 *
 * Two reasons it may not be, and they are different in kind:
 *
 *  - No bounded window (`hasAssessableWindow` above) — the SERVER's answer
 *    would be `null` anyway, by `capacityInputForFixtures`' own null
 *    contract. Nothing is lost by not asking.
 *  - Over a size bound the server schema enforces
 *    (`CAPACITY_PRECHECK_MAX_COURTS`/`_FIXTURES`, capacity-input.ts) — the
 *    server would answer 400. Here something IS lost: the organiser gets no
 *    capacity numbers for a division that large. That is the deliberate
 *    trade. The alternative shipped behaviour was two guaranteed-400 POSTs
 *    per stage per debounced edit and a card frozen on "check failed", which
 *    gives the organiser no numbers EITHER, plus an error they cannot clear.
 *    Reading as "not assessable" (the `null` contract) at least renders as
 *    the honest absence of a check rather than a broken one, and — because
 *    `capacityGateBlocks` (stages-panel.tsx) blocks only on a genuinely
 *    fresh `impossible` verdict — it cannot wrongly disable Auto-schedule.
 *
 * Second-review finding 1 was this predicate existing in only ONE of the two
 * hooks that used to live here: `useCapacityReport` skipped an unassessable
 * window, the since-deleted `useCapacityReportsByStage` skipped only a
 * literally `null` request, and the by-stage path shipped the exact
 * 400/retry/400 loop described above. Two hooks answering the same question
 * two ways is the fork this repo keeps paying for; hence
 * one function, both callers.
 */
function isSendableRequest(
  fixtures: readonly CapacityFixtureInput[],
  config: CapacityReportConfig,
): boolean {
  return (
    hasAssessableWindow(config) &&
    config.courts.length <= CAPACITY_PRECHECK_MAX_COURTS &&
    fixtures.length <= CAPACITY_PRECHECK_MAX_FIXTURES
  );
}

/** A single content-based identity for "have the inputs actually changed",
 *  used instead of depending on `fixtures`/`config` BY REFERENCE. Both call
 *  sites build a fresh array/object on every render (no memoisation on
 *  their side), so a reference-keyed effect would refire — and reschedule
 *  the debounce timer — on every unrelated re-render, not just a real
 *  edit. JSON identity is enough here: both shapes are plain, small, and
 *  wire-serialisable by construction. */
function inputsKey(
  divisionId: string,
  fixtures: readonly CapacityFixtureInput[],
  config: CapacityReportConfig,
): string {
  return JSON.stringify({ divisionId, fixtures, config });
}

/** The debounce/abort core: schedule ONE debounced, abortable POST, call
 *  `onResolved` with the settled report. Returns a canceller (clears the
 *  timer AND aborts an in-flight request) — the caller decides when to invoke
 *  it (an effect's cleanup). It was factored out of `useCapacityReport` for a
 *  second, per-stage hook that has since been deleted with the CTA it fed;
 *  it stays factored out because that is where the retry/abort contract this
 *  file's header describes actually lives. Not exported: its only caller is
 *  in this file. */
/** One retry, after a short fixed backoff, before a REAL failure is
 *  declared — enough to ride out a one-off blip without turning into an
 *  endless retry loop against the endpoint (review Finding 1: a genuine
 *  failure used to be swallowed identically to a superseded abort, forever,
 *  with no retry and no way for the caller to ever learn about it). */
const RETRY_DELAY_MS = 500;

function scheduleCapacityFetch(
  divisionId: string,
  fixtures: readonly CapacityFixtureInput[],
  config: CapacityReportConfig,
  onResolved: (report: CapacityReport | null) => void,
  /** Fires once, only after a REAL failure's one retry has also failed —
   *  never for a superseded abort. See `UseCapacityReportResult.failed`'s
   *  own doc comment for what the caller must do with it (fail OPEN). */
  onFailed: () => void,
): () => void {
  const controller = new AbortController();
  let retryTimer: ReturnType<typeof setTimeout> | undefined;

  const attempt = (retriesLeft: number) => {
    apiV1<CapacityReport | null>(`/api/v1/divisions/${divisionId}/schedule/capacity`, {
      method: "POST",
      json: { fixtures, config },
      signal: controller.signal,
    })
      .then(onResolved)
      .catch((err: unknown) => {
        // A newer edit superseded this request (the caller's own cleanup
        // aborted it) — routine, not a failure: stay silent exactly as
        // before, `onResolved`/`onFailed` are both simply never called, so
        // the caller's held report/resolvedKey are left exactly as they
        // were. Anything else is a REAL failure (500, network drop, a 4xx
        // schema rejection) — one retry rides out a blip; if that fails
        // too, `onFailed` fires so the caller can surface a distinct
        // "couldn't check" state instead of an indefinite "Updating…".
        if (err instanceof Error && err.name === "AbortError") return;
        if (retriesLeft > 0) {
          retryTimer = setTimeout(() => attempt(retriesLeft - 1), RETRY_DELAY_MS);
          return;
        }
        // Client-side fetch-failure logging convention in this repo (e.g.
        // org-payment-instructions.tsx) — a plain, bracket-tagged
        // console.error. `src/lib/sentry.ts` is `server-only` and cannot be
        // imported from this "use client" hook.
        console.error("[capacity] report fetch failed", err);
        onFailed();
      });
  };

  const timer = setTimeout(() => attempt(1), DEBOUNCE_MS);
  return () => {
    clearTimeout(timer);
    clearTimeout(retryTimer);
    controller.abort();
  };
}

export function useCapacityReport(
  divisionId: string,
  fixtures: readonly CapacityFixtureInput[],
  config: CapacityReportConfig,
): UseCapacityReportResult {
  const [report, setReport] = useState<CapacityReport | null>(null);
  // Which inputs-key's fetch most recently RESOLVED. A real `useState`
  // slot, not a ref: render reads it below (via `stale`), and reading a
  // ref's `.current` during render is the exact `react-hooks/refs` defect
  // this hook must not have — a value read from a ref during render does
  // not itself trigger a re-render when it changes, so the derived value
  // can go stale until something else happens to re-render the caller.
  const [resolvedKey, setResolvedKey] = useState<string | null>(null);
  // Which inputs-key's fetch most recently FAILED for real (retries
  // exhausted) — same rationale as `resolvedKey` above. Compared against
  // the live `key` below exactly like `resolvedKey` is, so a later edit
  // (a new key) clears the failed read without this ever needing an
  // explicit reset.
  const [failedKey, setFailedKey] = useState<string | null>(null);
  const assessable = isSendableRequest(fixtures, config);
  const key = inputsKey(divisionId, fixtures, config);

  useEffect(() => {
    // Nothing to assess — see hasAssessableWindow's own doc comment. No
    // fetch, no timer: the masked return below already answers `null`.
    if (!assessable) return;

    return scheduleCapacityFetch(
      divisionId,
      fixtures,
      config,
      // `report` before `resolvedKey`: same-tick state updates land in one
      // React batch so this never actually splits into two renders, but
      // nothing here should DEPEND on that — if it ever did split, the
      // transient render must read as still-stale-with-fresh-data, never
      // fresh-with-stale-data.
      (data) => {
        setReport(data);
        setResolvedKey(key);
      },
      () => setFailedKey(key),
    );
    // fixtures/config are captured by `key` in the dependency array below
    // (see inputsKey's own comment) — depending on them directly would
    // refire this effect every render even with no real edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, assessable, divisionId]);

  if (!assessable) return { report: null, stale: false, failed: false };
  return { report, stale: resolvedKey !== key, failed: failedKey === key };
}

// `useCapacityReportsByStage` and its `CapacityRequest` type lived here and
// were DELETED with the desk W4 follow-ups. Their only consumer was the
// fixtures page's Auto-schedule CTA, which desk W3 removed (scheduling lives
// on the Schedule page — owner ruling); the two `stages-panel.tsx` helpers
// that built this hook's requests went with that PR, leaving the hook itself
// exported, commented as if live, and called by nothing but its own tests.
// `useCapacityReport` (singular) above is untouched and still feeds
// `board/capacity-card.tsx`. `git log` has the implementation if the
// per-stage pre-check is ever wanted on the Schedule page.
