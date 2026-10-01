"use client";

// One run-sheet row (Task 4, competition-desk W2): time spine cell, court +
// round, entrants + score/result + sub-line, ONE action. The action comes
// from `fixtureRowAction` and NOTHING else renders a second control for it —
// no chip stack, no second link — so the ladder that decides it cannot drift
// out of sync with what the row shows (the K3/M1 hand-copied-predicate
// defect this programme has already paid for twice). `isBye`/`outcomeText`
// are the same single authorities `stages-panel.tsx`'s (retired) FixtureLine
// used — reused here, never restated (R10/R13,
// docs/superpowers/specs/2026-09-02-competition-desk-prompts/_INDEX.md).
import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "@/components/ui/console-link";
import { ClientTime } from "@/components/client-time";
import { apiV1, ApiV1Error } from "@/lib/client-v1";
import { PLAYED_REFUSAL_CODE } from "@/lib/played-fixture-statuses";
import { useMsg } from "@/components/i18n/dict-provider";
import type { MessageKey } from "@/lib/messages";
import { DateTimeField } from "../shared/datetime-field";
import { resolveSlotLabel } from "@/lib/slot-label";
// `seatLabel` is SHARED with the bracket tree (`bracket-panel.tsx`): the tree
// renders directly above this list on ?tab=fixtures, so one composition point
// rather than one per surface — and one test then covers both seats here
// instead of needing a mirror case per side.
import { seatLabel, type FeedLabelPair } from "@/lib/schedule-board";
import { courtDisplayName } from "@/components/v2/board/types";
import { courtOptionsFor, type Venue } from "@/components/v2/shared/court-multi-picker";
import { canEditFixtureTime, fixtureRowAction, hasAssignedScorer, type RowAction } from "@/lib/fixture-row-action";
import { isBye, type RunSheetFixture } from "@/lib/run-sheet-groups";
import type { HoldState } from "@/server/relay/domain/session";
import { fixtureStatusLabel, outcomeText, VOID_STATUSES } from "@/components/v2/stages-panel";
import type { PatchFixture } from "@/server/api-v1/schemas";
// Both halves of the round trip resolve in `orgTz` (#448): `zonedDateTimeInput`
// seeds the field from an existing instant, `isoFromZonedDateTime` turns the
// typed wall clock back into one. Never `tz` — that is display-only.
import { zonedDateTimeInput, isoFromZonedDateTime } from "@/lib/zoned-datetime";

/** What the editor says when it has no better answer. Already translated in all
 *  four locales, and the destination for EVERY code this map does not name —
 *  the server's raw `err.message` must never reach the organiser. */
export const SCHEDULE_ERROR_FALLBACK_KEY = "schedule.error.failed" satisfies MessageKey;

/**
 * The inline editor's refusal copy: wire CODE -> organiser copy key.
 *
 * Before this, `patchSchedule`'s catch rendered `err.message` — the SERVER's
 * own English sentence — into a console that ships in en/es/fr/nl. Driving a
 * double-booked court through the editor put "schedule change hits a blocking
 * conflict" on screen verbatim (the `EngineError` raised by
 * `assertNoNewBlocking`, server/usecases/schedule.ts). The message is now never
 * read; only `ApiV1Error.code` is, which is a first-class readonly field on it
 * (lib/client-v1.ts) — the same branch six other v2 islands already make on
 * `PAYMENT_REQUIRED`.
 *
 * ONE code is mapped, because one is what this PATCH can raise that is both
 * reachable from this editor and distinct to an organiser. What was considered
 * and deliberately left to the fallback:
 *
 *   SEQ_CONFLICT   — unreachable HERE. `assertFreshSeq` returns immediately
 *                    when `expected_seq` is undefined (schedule.ts), and this
 *                    editor never sends one. `use-board-actions.ts`'s
 *                    `autoRun` does (Schedule page auto-schedule), and
 *                    handles it itself.
 *   the two 422s   — "the division schedule is locked" and "fixture is
 *                    <status> — decided fixtures are immutable" both arrive as
 *                    the GENERIC code "ERROR" (`statusCode(422)` in
 *                    server/api-v1/http.ts), so branching on it would label
 *                    every other 422 as a lock. A peer wave is adding a real
 *                    SCHEDULE_LOCKED code; this map leaves room for it rather
 *                    than guessing at the ambiguous one.
 *   PAYMENT_REQUIRED — reachable (a frozen competition, `assertNotFrozen`) and
 *                    its raw message is a wire string with a machine key in it
 *                    ("Plan upgrade required: competitions.max_active"), so the
 *                    fallback is already strictly better. Real copy for it
 *                    belongs with the <UpgradeGate> the sibling islands render,
 *                    which is a bigger piece of work than this fix.
 *   VALIDATION     — the Save button rejects an unparseable wall clock before
 *                    it can PATCH (`iso === null`), so a 400 needs a client bug
 *                    to reach, not an organiser action.
 *
 * SCHEDULE_CONFLICT itself covers four blocking families, not just a court
 * clash (`isBlockingConflict`: court double-booking, person overlap, session
 * window, direct-feed order) — hence copy that names the clash with the rest of
 * the schedule rather than the court alone.
 */
export function scheduleErrorKey(err: unknown): MessageKey {
  if (err instanceof ApiV1Error && err.code === "SCHEDULE_CONFLICT") {
    return "schedule.error.conflict";
  }
  // A start taken back leaves the row `scheduled`, so the editor opens on it;
  // the server refuses the move because the match holds a result.
  if (err instanceof ApiV1Error && err.code === PLAYED_REFUSAL_CODE) {
    return "schedule.error.played";
  }
  return SCHEDULE_ERROR_FALLBACK_KEY;
}

export function RunSheetRow({
  fixture,
  href,
  tz,
  orgTz,
  nowMs,
  canEdit,
  entrantNames,
  courtNames,
  venues,
  boardSlotOptions,
  onRescheduled,
  stageName,
  streamState,
  feedLabels,
}: {
  fixture: RunSheetFixture;
  href: string;
  /** The VENUE zone (`scheduleSettings.tz`) — the time cell's DISPLAY and
   *  `fixtureRowAction`'s "scheduled today" rule both key off it. */
  tz: string;
  /** The ORG zone (`resolveVenueTz(null, org.timezone)`, #448) — the zone
   *  the inline "Set time" editor reads and writes in (fix round 3, owner
   *  ruling). Distinct from `tz`: a typed value is governed by `orgTz`,
   *  never `settings.tz`, matching every other write site in the repo
   *  (`move-panel.tsx`, `settings-panel.tsx`, the board) — `tz` stays
   *  display-only. Threaded down from `StagesPanel`'s own `orgTz` prop
   *  (`page.tsx`'s `resolveVenueTz(null, page.org.timezone)`); never
   *  re-derived here — one authority per fact. */
  orgTz: string;
  nowMs: number;
  canEdit: boolean;
  entrantNames: Record<string, string>;
  courtNames?: Record<string, string>;
  /** Org venues with nested courts (`listVenues` shape), for the inline
   *  editor's court picker (ruling R35). Defaults to `[]`, which renders the
   *  picker with only "Unassigned" — the same posture `StagesPanel`'s own
   *  `venues` prop already takes, so a caller that never carried venues keeps
   *  working unchanged. */
  venues?: readonly Venue[];
  /** Board slots for the inline "Set time" field — `undefined` lets
   *  `DateTimeField` fall back to quarter hours, same as everywhere else. */
  boardSlotOptions?: string[];
  /** Fired after a "Set time" save lands, so the sheet can offer the same
   *  notice+undo affordance the rest of the panel already does. */
  onRescheduled?: () => void;
  /** F3 (W2 walkthrough gate 1): the unscheduled and settled groups merge
   *  every stage into one list with nothing on the row identifying which
   *  stage a fixture belongs to — two same-named "Round 1 · Bravo vs Echo"
   *  rows from different stages were indistinguishable. `RunSheet` passes
   *  this only for those two blocks, and only when the division has more
   *  than one stage (single-stage divisions gain no noise); day and bracket
   *  blocks never pass it — a day header/bracket section already identifies
   *  its stage. */
  stageName?: string | null;
  /** Spec 2026-09-30 §2 (T6) — this fixture's stream session as a person reads it, when one is up (`openStreamStates`,
   *  read by the division page for the PAGE-level organiser). The row shows a chip linking to the fixture page with
   *  `?stream=open`: the division's path to Stop. Deliberately NOT gated on this row's `canEdit`, which is `editable`
   *  (false on a billing-frozen page) — the chip replaced the frozen page's stop probes, so it must show there. The
   *  organiser gate is the page's: a viewer is never handed a state. */
  streamState?: HoldState;
  /** Feeder labels for seats no result has filled yet, keyed by fixture id —
   *  `feedLabels()`'s output (lib/schedule-board.ts), the SAME builder and the
   *  SAME `{key, params}` vocabulary the schedule board reads.
   *
   *  Why the row needs this at all: `home_slot_label`/`away_slot_label` are
   *  the persisted authority, but the SETUP progression path deliberately
   *  leaves a sibling-fed seat NULL (`generateProgressionSetupFixtures`
   *  stamps a label only for a synthetic seed ref and for `bracket.slot.bye`
   *  — `stageOwesDraw`/`awaitsSeedDraw` read "no label ⇒ sibling-fed" for
   *  `timing: "setup"` stages, so stamping one there would break the draw
   *  ledger). The result was a draw list whose semi-finals and final read
   *  "TBD vs TBD" while the schedule board, which derives the same seats from
   *  the feed EDGES, read "Winner of R1·1 vs Winner of R1·2".
   *
   *  Optional, so a caller that never carried it keeps today's TBD fallback.
   *  Never a substitute for the stored label — see the precedence at `home`
   *  below. */
  feedLabels?: Record<string, FeedLabelPair>;
}) {
  const msg = useMsg();
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  // The typed value. Seeded EMPTY here and re-seeded from the STORED instant
  // every time the editor opens — `toggleEditor` below is the authority, and
  // its doc carries the whole argument. Nothing else may set this from
  // `fixture.scheduled_at`: seeding it at mount was the adjudicated defect,
  // because mount happens once while `editing` toggles many times.
  //
  // The read itself was restored in fix round 5 and is genuinely reachable
  // now. Round 4 deleted it correctly — the only door was the `set_time`
  // action, which `fixtureRowAction` offers ONLY for `scheduledAt === null`,
  // so the truthy branch could never run and no mutation of it could go red.
  // It was dead *because of a gap*, the owner ruled that gap a regression,
  // and the time cell below is the door that reaches it.
  //
  // The zone is `orgTz` (#448), never the `tz` the row DISPLAYS in — the
  // same asymmetry the Save handler documents, and not self-cancelling: a
  // `tz` read would look right on screen while round-tripping an instant
  // fourteen hours from the one shown. Pinned by a value test on a
  // `tz !== orgTz` division, mutation-proven.
  const [when, setWhen] = useState("");
  // The selected court, "" for unassigned. Ruling R35 restores per-fixture
  // court assignment, which `FixtureLine` carried (`main:stages-panel.tsx:1619`)
  // and the W2 rewrite dropped without a ruling, leaving the schedule board as
  // the only way to correct a court.
  //
  // Seeded EMPTY here and re-seeded from the STORED court every time the editor
  // opens — exactly like `when` above, and for exactly the same adjudicated
  // reason: mount happens once while `editing` toggles many times, so a
  // mount-time seed shows a court the organiser picked and then cancelled.
  // `toggleEditor` is the one authority for both.
  const [courtId, setCourtId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // R7(a)/(b): a bye is structural, never schedulable, never actionable —
  // rendered exactly as FixtureLine's own (retired) bye branch did.
  //
  // Swiss Pair sits the award on the bye shell (`forfeited` + outcome.award).
  // Showing only "{name} has a bye" hid that the sit-out was already decided
  // — Gus looked awarded after the points fix, then Finn's R2 bye looked like
  // a bare sit-out again. `isBye` requires an award outcome, so always pair
  // the bye label with the walkover result (`schedule.outcome.wonWo`).
  if (isBye(fixture)) {
    const who = fixture.home_entrant_id ?? fixture.away_entrant_id;
    const name = entrantNames[who ?? ""] ?? "?";
    const awarded = outcomeText(msg, fixture.outcome, entrantNames);
    return (
      <li className="px-4 py-2 text-sm text-slate-500 italic" data-testid="run-sheet-bye">
        {msg("schedule.round", { n: fixture.round_no })} · {msg("schedule.bye", { name })}
        {awarded ? ` · ${awarded}` : null}
      </li>
    );
  }

  // C3: `hasOfficials` derived here, at fixtureRowAction's own call site —
  // the function takes it as a boolean input, it does not derive it itself.
  //
  // `hasAssignedScorer`, never `officials.length > 0` (max-effort review,
  // finding 8): the `fixtures.officials` cache keeps DECLINED appointments,
  // so a length test reads "fully staffed" on the exact fixture whose scorer
  // has just said no. The whole argument lives on that function.
  const hasOfficials = hasAssignedScorer(fixture.officials);
  // F5 (W2 walkthrough gate 1): computed once, fed to BOTH the ladder (so the
  // action can never invite scoring/assigning a scorer for a match nobody has
  // named yet) and the sub-line below (so the label and the action can never
  // disagree about which fixtures are still undrawn).
  const awaitingDraw = fixture.home_entrant_id === null || fixture.away_entrant_id === null;
  const action: RowAction = fixtureRowAction({
    status: fixture.status,
    scheduledAt: fixture.scheduled_at,
    hasOfficials,
    canEdit,
    tz,
    nowMs,
    awaitingDraw,
  });

  // C3: copied verbatim from FixtureLine's own derivation — never reinvented.
  //
  // Step 1 is here and here only: a FILLED seat is the entrant's NAME, and
  // nothing else may answer. Steps 2 and 3 — stored label, then feed edge —
  // are `seatLabel()` in lib/schedule-board.ts, SHARED with the bracket tree
  // that renders directly above this list, with the reasoning for that order
  // (and the live bye collision that depends on it) stated there once.
  // A seat with no stored label and no feeder reaches neither and keeps the
  // localized "schedule.tbd" fallback, exactly as before.
  const feed = feedLabels?.[fixture.id];
  const home = fixture.home_entrant_id
    ? (entrantNames[fixture.home_entrant_id] ?? "?")
    : resolveSlotLabel(seatLabel(fixture.home_slot_label, feed, "home"), msg, "schedule.tbd");
  const away = fixture.away_entrant_id
    ? (entrantNames[fixture.away_entrant_id] ?? "?")
    : resolveSlotLabel(seatLabel(fixture.away_slot_label, feed, "away"), msg, "schedule.tbd");
  const decided = outcomeText(msg, fixture.outcome, entrantNames);
  const courtLabel = courtDisplayName(fixture, courtNames) ?? fixture.venue_name;
  // R35: the inline editor's court options. `courtLabel` is the resolved,
  // venue-qualified name this row already prints, so an archived court carried
  // as its own option reads exactly as it does in the row above it.
  const courtOptions = courtOptionsFor(venues ?? [], fixture.court_id, courtLabel);

  // C4/R12: voided fixtures keep FixtureLine's strike-through — the ACTION
  // (routed to "result" by Task 2's ladder) is right, but a cancelled match
  // that reads like an ordinary played one at a glance is the "two
  // contradicting facts in one row" class this wave exists to remove.
  const voided = VOID_STATUSES.has(fixture.status);

  // The sub-line: ONE computed string, ONE guard below.
  //
  // Max-effort review, finding 6. The precedence rule used to be encoded three
  // times — here, in the render guard, and again inside it — and the voided arm
  // was UNSATISFIABLE: the guard read `(decided && !voided) || subLine`, whose
  // first disjunct is false by construction for a voided fixture, while
  // `subLine` could only be truthy for `awaitingDraw` or `assign_scorer`,
  // neither of which a settled fixture reaches. So a cancelled, abandoned or
  // forfeited row rendered struck through with no reason and no result: three
  // outcomes collapsed into one indistinguishable row, and nothing at all for a
  // screen reader, since `line-through` is not announced. Collapsing the rule to
  // a single value that already IS the string to print removes the dead branch
  // by construction.
  //
  // Priority:
  //  - VOIDED: the reason first (`fixtureStatusLabel`, the sub-line source the
  //    design of record names), then the outcome if one was recorded — a
  //    forfeit has a winner and it was being computed and discarded.
  //  - a settled result IS the fact worth showing, on its own (a status word
  //    beside "Alpha won" is the row noise this wave exists to cut).
  //  - otherwise an unresolved entrant ("Awaiting draw") is the more
  //    fundamental blocker than "no scorer yet" — an organiser cannot assign a
  //    scorer to a match that doesn't know who is playing yet.
  //    (`awaitingDraw` computed once, above, alongside `action` — see there.)
  const subLine: string | null = voided
    ? [fixtureStatusLabel(msg, fixture.status), decided].filter((p): p is string => Boolean(p)).join(" · ")
    : decided !== null
      ? decided
      : awaitingDraw
        ? msg("runsheet.sub.awaitingDraw")
        : action.kind === "assign_scorer"
          ? msg("runsheet.sub.noScorer")
          : null;

  // Task 9 (A3, "two deliberate lines"): the stage/court/round meta text, as a
  // plain string rather than the three-ternary JSX below — computed ONCE so
  // the desktop meta line and the phone line-2 text below read the SAME
  // value instead of restating the interpolation twice. Always non-empty:
  // `schedule.round` has no guard, unlike the two optional prefixes.
  const metaLine = `${stageName ? `${stageName} · ` : ""}${courtLabel ? `${courtLabel} · ` : ""}${msg("schedule.round", { n: fixture.round_no })}`;
  // Below `md`, W2's gate photographed THREE reflowed lines at 320 (meta,
  // name, then either the result sub-line or the action pill on its own —
  // four when a fixture actually carried one). Two deliberate lines instead:
  // line 1 is time + entrants (unchanged below), line 2 folds the meta text
  // and the result sub-line into ONE string that sits beside the one action,
  // right-aligned — never a THIRD phone-only line for the result. Desktop is
  // untouched: `metaLine` and `subLine` keep rendering as their own separate
  // paragraphs there (see the `hidden md:block` pair below); this combined
  // string is read ONLY by the `md:hidden` line-2 paragraph further down.
  const phoneLineTwo = subLine !== null && subLine !== "" ? `${metaLine} · ${subLine}` : metaLine;

  /**
   * THE ONLY DOOR into the editor, and the one place `when` is seeded.
   *
   * Adjudicated fix. `when` used to be seeded by `useState`'s initializer,
   * which runs ONCE per mount — but the editor opens and closes many times
   * inside one mount, and Cancel was `setEditing(false)` and nothing else. So
   * an organiser could open the editor, type 16:45, press Cancel, reopen, and
   * be shown 16:45 on a fixture still stored at 09:00: the field and the time
   * cell in the same row stating different times, with one confirming tap on
   * Save committing the edit they had explicitly abandoned. Clearing the date
   * half and cancelling produced the same lie inverted — a blank field, Save
   * disabled, on a fixture that has a time. A stale 422 message survived the
   * same way. Only a full page reload reseeded it.
   *
   * Round 4 set this risk aside as unreachable, and was right then: nothing
   * could reopen the editor on a fixture that already had a time. Round 5's
   * time-cell affordance is what reaches it.
   *
   * Reseeding on OPEN rather than resetting on Cancel is deliberate — it also
   * covers every other way the editor can close (a successful save, a future
   * Escape handler) and picks up a `scheduled_at` that changed underneath
   * since the last open. `orgTz`, never `tz`: see the Save handler.
   *
   * The seed is UNCONDITIONAL — `scheduled_at === null` seeds "" rather than
   * leaving the last typed value in place. A reseed that fires only on a
   * non-empty stored value passes the "typed then cancelled" case and fails
   * its inverse (clear the date, cancel, reopen: the field must show the
   * stored time again, not the blank the organiser abandoned), which is why
   * the e2e asserts both directions.
   */
  function toggleEditor(): void {
    const opening = !editing;
    if (opening) {
      setWhen(fixture.scheduled_at ? zonedDateTimeInput(fixture.scheduled_at, orgTz) : "");
      // R35: the court is reseeded on the same door, unconditionally, for the
      // same reason the time is — "picked Court 3, cancelled, reopened" must
      // show the STORED court, not the abandoned choice.
      setCourtId(fixture.court_id ?? "");
      setError(null);
    }
    setEditing(opening);
  }

  /** Returns whether the write landed, so a caller can reset local state
   *  only on success — clearing `when` on a FAILED unschedule would leave
   *  the field empty next to a fixture that still has its time. */
  async function patchSchedule(json: PatchFixture): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      await apiV1(`/api/v1/fixtures/${fixture.id}`, { method: "PATCH", json });
      setEditing(false);
      router.refresh();
      onRescheduled?.();
      return true;
    } catch (err) {
      // `err.message` is deliberately NOT read: it is the server's own English
      // sentence, and this console ships in four locales. See
      // `scheduleErrorKey` for what is mapped and what is not.
      setError(msg(scheduleErrorKey(err)));
      return false;
    } finally {
      setBusy(false);
    }
  }

  const actionLabel =
    action.kind === "open_pad"
      ? msg("runsheet.action.openPad")
      : action.kind === "assign_scorer"
        ? msg("runsheet.action.assignScorer")
        : action.kind === "score"
          ? msg("runsheet.action.score")
          : action.kind === "result"
            ? msg("runsheet.action.result")
            : action.kind === "set_time"
              ? msg("runsheet.action.setTime")
              : msg("runsheet.action.view");

  return (
    <li data-fixture-no={fixture.fixture_no} className="px-4 py-2">
      {/* Same two-tier responsive shape `FixtureLine` used (fix-ui audit
          03-console-division.md): stacked below `md` so the action never
          collides with the entrant names on a narrow screen, one row again
          at `md:` via `md:contents` on the action's own wrapper. `min-w-0`
          on the WHOLE ancestor chain down to the truncated spans — a
          missing one put 106px of horizontal overflow on the page at
          320-390, visible only with a realistic entrant name.
          W3 Task 8 (ruling 15): this used to switch at `sm:` (640), while
          the ledger switches at `md:` (768) — at 768 the ledger was already
          a card while this row was already a desktop row. Unified on `md:`
          so the whole desk agrees on where "phone" ends.
          W3 Task 9 (A3): below `md` this used to reflow into three lines
          (meta, name, action) — four when a result or "no scorer" sub-line
          also rendered. Now exactly two: line 1 (this first `md:contents`
          div) is time + entrants; line 2 (the second one, below) is the
          combined meta/sub-line text beside the one action, right-aligned.
          One DOM, branched — `md:` above keeps the original three-paragraph
          stack (`hidden md:block` on the meta and sub-line paragraphs);
          `max-md` below shows only the `md:hidden` combined line instead. */}
      <div className="flex min-w-0 flex-col gap-2 md:flex-row md:flex-wrap md:items-center md:gap-3">
        <div data-row-line="1" className="flex min-w-0 items-center gap-3 md:contents">
          {/* Time spine cell — mono/tabular so the column lines up; an
              em-dash for a row with no time at all (the unscheduled group).
              Fix round 5 (owner ruling): when the time is EDITABLE the cell
              itself is the affordance — clicking the displayed time opens
              the same inline editor "Set time" opens. The action column keeps
              exactly one control, which is this row's design premise, and
              `fixtureRowAction`'s ladder needs no new branch.
              `canEditFixtureTime` owns the three conditions (see its doc);
              in particular a non-`scheduled` fixture is NOT offered it,
              because `moveFixture` 422s that outright and an editor that
              cannot save is a dead end, not a feature. */}
          {canEditFixtureTime({ status: fixture.status, scheduledAt: fixture.scheduled_at, canEdit }) ? (
            // A real <button>, not a click handler on a <span>: it has to be
            // keyboard-reachable and carry an accessible name of its own
            // ("14:30" alone says nothing about what clicking does). `min-h-11`
            // because a 20px line of text is not a tap target — and `-my-1`
            // so the taller hit area does not push every row's rhythm out.
            // The dotted underline is not decoration: a bare time with no
            // affordance signal is reachable and undiscoverable, which is the
            // failure mode this programme keeps paying for.
            <button
              type="button"
              data-testid="run-sheet-edit-time"
              aria-label={msg("schedule.editTime")}
              title={msg("schedule.editTime")}
              aria-expanded={editing}
              onClick={toggleEditor}
              className="-my-1 flex min-h-11 w-14 shrink-0 items-center font-mono text-sm tabular-nums text-slate-600 underline decoration-slate-300 decoration-dotted underline-offset-4 hover:text-purple-700 hover:decoration-purple-500 md:order-first"
            >
              <ClientTime value={fixture.scheduled_at} tz={tz} mode="time" hourCycle="h23" />
            </button>
          ) : (
            <span className="w-14 shrink-0 font-mono text-sm tabular-nums text-slate-600 md:order-first">
              {fixture.scheduled_at ? <ClientTime value={fixture.scheduled_at} tz={tz} mode="time" hourCycle="h23" /> : "—"}
              {fixture.status === "in_play" && (
                <span aria-hidden className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-amber-500 align-middle" />
              )}
            </span>
          )}
          <div className="min-w-0 flex-1">
            {/* Task 9: desktop-only now — `phoneLineTwo` below carries this
                same text (combined with the result sub-line) on phone, so
                printing it here too would be the row's THIRD line again. */}
            <p className="hidden min-w-0 truncate text-xs text-slate-500 md:block">{metaLine}</p>
            {/* IMPORTANT 2 (fix round 1): the ONE-action rule governs the
                action CONTROL, not the row's own identity link — `FixtureLine`
                had both. An unscheduled row's single action is "Set time" (a
                `<button>`, not a navigation), which otherwise left it with NO
                route to its own fixture console at all. */}
            <Link
              href={href}
              className={`block min-w-0 truncate text-sm font-medium hover:text-purple-700 ${voided ? "text-slate-500 line-through" : "text-slate-800"}`}
            >
              {home}
              {/* slate-500, not slate-400. `#94a3b8` on white measures ~2.9:1
                  — below the 4.5:1 AA floor for body text — and axe reports it
                  at SERIOUS impact. Found by the scoped axe scan fix round 5
                  added to `run-sheet.spec.ts` (mobile.spec.ts's own sweep
                  covers `?tab=standings` and has never covered this tab), on
                  its first run. Pre-existing: this span is unchanged from the
                  original Task 4 commit, and `FixtureLine` carried the
                  identical one before it. slate-500 (`#64748b`, ~4.8:1) is the
                  lightest step that clears AA and keeps `vs` quieter than the
                  entrant names it separates — the same remedy `move-panel.tsx`
                  already applied to its own contrast finding. */}
              <span className="mx-1.5 text-slate-500">{msg("schedule.vs")}</span>
              {away}
            </Link>
            {/* Task 9: `hidden md:block`, same reasoning as the meta line
                above — `phoneLineTwo` is the phone's copy of this text. */}
            {subLine !== null && subLine !== "" && (
              <p className="hidden min-w-0 truncate text-xs text-slate-500 md:block">{subLine}</p>
            )}
          </div>
        </div>
        {/* Line 2 on phone (Task 9, A3): the meta/sub-line text, left, beside
            the one action, right-aligned — `justify-between` on one flex
            row. `md:contents` unwraps this wrapper at `md:` and up exactly
            as it always did, so the desktop composition (this whole div
            reduced to just the action control, a flex item of the outer
            row) is byte-for-byte what it was before this task; the
            `md:hidden` paragraph below simply renders `display:none` there
            and takes no space. `min-w-0` down to the truncated paragraph,
            same discipline the entrant column above already carries. */}
        {/* B3 re-review N-1: `max-md:flex-wrap` — at 320 the French waiting chip ("En attente du téléphone") plus the
            action pass line 2 by 16 px; the action wraps under the chip instead of squeezing past the row's edge. */}
        <div data-row-line="2" className="flex min-w-0 items-center justify-between gap-2 max-md:flex-wrap md:contents">
          <p className="min-w-0 flex-1 truncate text-xs text-slate-500 md:hidden">{phoneLineTwo}</p>
          {/* Spec 2026-09-30 §2 (T6): the stream panel lives on the fixture page; a session that is up shows HERE as a
              chip — "● Live" or "● Waiting for phone" — linking to that page with the panel open. At every fixture
              status: a stream outlives the whistle. 44 px tall on phones (the tap floor).
              B3 fix round 1 (owner decision, option a): on phones it sits on THIS line, beside the row action, so
              line 1 carries the entrant names in full. One DOM, no twin — at ≥768 both line wrappers are
              `md:contents`, and `md:order-first` here and on the time cell puts it back between the time and the
              names, the desktop row exactly as it was. */}
          {streamState && (
            <Link
              href={`${href}?stream=open`}
              data-testid="run-sheet-stream-chip"
              data-state={streamState}
              // Minor 11 (B3 fix round 1): several rows can carry a "Live" link — the name says WHICH match, its
              // visible words first (label in name).
              aria-label={msg(streamState === "live" ? "runsheet.stream.liveName" : "runsheet.stream.waitingName", {
                match: `${home} ${msg("schedule.vs")} ${away}`,
              })}
              className="inline-flex shrink-0 items-center gap-1 rounded-full border border-slate-200 px-2 py-0.5 text-xs font-medium text-slate-700 hover:bg-slate-50 max-md:min-h-11 md:order-first"
            >
              <span aria-hidden className={`inline-block h-1.5 w-1.5 rounded-full ${streamState === "live" ? "bg-red-600" : "bg-amber-500"}`} />
              {msg(streamState === "live" ? "runsheet.stream.live" : "runsheet.stream.waiting")}
            </Link>
          )}
          {/* The ONE action — a plain link for every kind except `set_time`,
              which toggles the inline editor below (≥44px either way). `max-md:ml-auto`: when line 2 wraps (N-1)
              the action keeps the right edge it has on one line. */}
          <div className="flex flex-wrap items-center gap-2 max-md:ml-auto md:contents">
            {action.kind === "set_time" ? (
              <button
                type="button"
                data-row-action="set_time"
                disabled={busy}
                onClick={toggleEditor}
                className="btn btn-primary min-h-11 shrink-0 px-3 text-xs"
              >
                {actionLabel}
              </button>
            ) : (
              <Link
                href={href}
                data-row-action={action.kind}
                className="btn btn-ghost min-h-11 shrink-0 px-3 text-xs"
              >
                {actionLabel}
              </Link>
            )}
          </div>
        </div>
      </div>
      {editing && (
        // `max-w-sm` caps the EDITOR, not the field. `DateTimeSplitField` is
        // `w-full` (its own file says why: a container-query box cannot size
        // itself from content), so without a cap the date/time pair would
        // stretch the whole card width on a desktop row — ~1050px of date
        // input for a value that needs ~230. Capping from outside composes
        // with that width instead of competing with it, and it is the ONLY
        // thing here that touches the field's size: delete the `w-full` and
        // this editor goes back to a 0px box whatever this class says.
        <div data-testid="run-sheet-set-time-editor" className="mt-2 flex max-w-sm flex-col gap-1.5">
          {/* Fix round 3 (owner ruling, "make the mismatch legible"): the
              typed value is written in `orgTz`, not the `tz` the row
              displays in — on a division whose venue zone differs, the
              saved time redisplays at a different wall-clock hour.
              Fix round 4: rendered ONLY when the two zones actually
              disagree, and it now names BOTH — round 3's version said which
              zone the input accepts but never that the row redisplays in a
              different one, which is the whole confusion, and it printed on
              every division including the majority where there is nothing to
              disambiguate. A note that fires when it has nothing to say
              trains organisers to stop reading it. */}
          {orgTz !== tz && (
            <p className="text-xs text-slate-500" data-testid="run-sheet-set-time-zone-note">
              {msg("runsheet.setTime.zoneNote", { orgTz, tz })}
            </p>
          )}
          <div className="flex flex-wrap items-end gap-2">
            <DateTimeField
              kind="datetime-local"
              label={msg("schedule.field.when")}
              value={when}
              onChange={setWhen}
              options={boardSlotOptions}
            />
            {/* R35 (owner ruling) — per-fixture court assignment, restored
                INSIDE this editor rather than as a second row-level control,
                which is what keeps the one-action rule intact. Same shape
                `FixtureLine` carried (`main:stages-panel.tsx:1677`): a plain
                single-select with one `<optgroup>` per venue, built from the
                SAME `courtGroups` piece `CourtMultiPicker` uses rather than a
                second court-picker implementation. One fixture has exactly one
                court, so the multi-select's ordering machinery has nothing to
                do; and because each optgroup names its venue, the option text
                needs no venue qualifier of its own.

                Offers every ACTIVE org court, not just the division's
                configured subset — a manual per-fixture override is not the
                auto-scheduler — plus, when it applies, the court this fixture
                already sits on even if that court has since been archived
                (`courtOptionsFor`, whose doc carries that argument). */}
            <label className="block">
              <span className="label">{msg("schedule.field.court")}</span>
              <select
                data-testid="fixture-court-select"
                value={courtId}
                onChange={(e) => setCourtId(e.target.value)}
                disabled={busy}
                // `.input`'s own padding loses to `px-2 py-1 text-xs` under
                // Tailwind's utilities layer (S13/#422 W11). `min-h-11` survives
                // it, and is the tap-target floor.
                className="input min-h-11 w-48 px-2 py-1 text-xs"
              >
                <option value="">{msg("board.unassigned")}</option>
                {courtOptions.current !== null && (
                  <option value={courtOptions.current.id}>{courtOptions.current.name}</option>
                )}
                {courtOptions.groups.map(({ venue, courts }) => (
                  <optgroup key={venue.id} label={venue.name}>
                    {courts.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </label>
            <button
              type="button"
              disabled={busy || when === ""}
              onClick={() => {
                // Fix round 3 (owner ruling): `when` is a bare
                // "YYYY-MM-DDTHH:MM" wall clock with no zone of its own —
                // resolve it in the ORG zone (`orgTz`, #448), never `tz`
                // (display-only) and never `new Date(when)`'s implicit
                // browser zone.
                const iso = isoFromZonedDateTime(when, orgTz);
                if (iso === null) {
                  setError(msg("schedule.error.failed"));
                  return;
                }
                // R35: time AND court in ONE patch, which is what the design
                // says this tab keeps PATCHing ("time/court", §W2) and what
                // `FixtureLine`'s own Save did.
                //
                // `venue_id` is deliberately NOT sent, unlike FixtureLine's
                // version. `moveFixture` DERIVES it from `courts.venue_id` and
                // never reads `patch.venue_id` (schedule.ts:3069 — "intentionally
                // never read"), so sending it is a second authority for a fact
                // the server owns, and FixtureLine only sent it to keep an
                // optimistic local row in step. This row has no optimistic
                // update: it calls `router.refresh()`.
                void patchSchedule({ scheduled_at: iso, court_id: courtId === "" ? null : courtId });
              }}
              className="btn btn-primary min-h-11 px-3 py-1.5 text-xs"
            >
              {busy ? msg("schedule.saving") : msg("schedule.save")}
            </button>
            <button
              type="button"
              className="btn btn-ghost min-h-11 px-3 py-1.5 text-xs"
              onClick={() => setEditing(false)}
            >
              {msg("schedule.cancel")}
            </button>
            {/* Fix round 5 (owner ruling): "clear this time" lives INSIDE the
                editor rather than as a second row-level control — that
                recovers the retired `schedule.unschedule` capability without
                giving the row two competing buttons. Rendered only when
                there is a time to clear: opened from an unscheduled row's
                "Set time" it would be a no-op button, which is the "an empty
                cell is not information" defect wearing a control's clothes.
                `.btn btn-ghost` rather than the bare text button FixtureLine
                used — `.btn`'s disabled utilities are not inherited by a bare
                button, so a disabled bare one still looks live. */}
            {fixture.scheduled_at !== null && (
              <button
                type="button"
                data-testid="run-sheet-clear-time"
                disabled={busy}
                onClick={() => {
                  void patchSchedule({ scheduled_at: null }).then((ok) => {
                    // Only on success: a cleared field beside a fixture that
                    // still holds its time is a lie the next open would tell.
                    if (ok) setWhen("");
                  });
                }}
                className="btn btn-ghost min-h-11 px-3 py-1.5 text-xs text-slate-500 hover:text-red-600"
              >
                {msg("schedule.unschedule")}
              </button>
            )}
            {error && (
              <span data-testid="run-sheet-editor-error" className="text-xs text-red-600">
                {error}
              </span>
            )}
          </div>
        </div>
      )}
    </li>
  );
}
