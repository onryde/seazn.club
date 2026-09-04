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
import { apiV1 } from "@/lib/client-v1";
import { useMsg } from "@/components/i18n/dict-provider";
import { DateTimeField } from "../shared/datetime-field";
import { resolveSlotLabel } from "@/lib/slot-label";
import { courtDisplayName } from "@/components/v2/board/types";
import { canEditFixtureTime, fixtureRowAction, type RowAction } from "@/lib/fixture-row-action";
import { isBye, type RunSheetFixture } from "@/lib/run-sheet-groups";
import { outcomeText, VOID_STATUSES } from "@/components/v2/stages-panel";
import type { PatchFixture } from "@/server/api-v1/schemas";
// Both halves of the round trip resolve in `orgTz` (#448): `zonedDateTimeInput`
// seeds the field from an existing instant, `isoFromZonedDateTime` turns the
// typed wall clock back into one. Never `tz` — that is display-only.
import { zonedDateTimeInput, isoFromZonedDateTime } from "@/lib/zoned-datetime";

export function RunSheetRow({
  fixture,
  href,
  tz,
  orgTz,
  nowMs,
  canEdit,
  entrantNames,
  courtNames,
  boardSlotOptions,
  onRescheduled,
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
  /** Board slots for the inline "Set time" field — `undefined` lets
   *  `DateTimeField` fall back to quarter hours, same as everywhere else. */
  boardSlotOptions?: string[];
  /** Fired after a "Set time" save lands, so the sheet can offer the same
   *  notice+undo affordance the rest of the panel already does. */
  onRescheduled?: () => void;
}) {
  const msg = useMsg();
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  // RESTORED in fix round 5, and now genuinely reachable.
  //
  // Round 4 deleted this read, correctly: the only door into the editor was
  // the `set_time` action, which `fixtureRowAction` offers ONLY for
  // `scheduledAt === null`, so the truthy branch could never run and no
  // mutation of it could go red. It was dead *because of a gap* — the owner
  // has since ruled that gap a regression (pre-W2 the row carried
  // `schedule.editTime`; nothing took it over), and the time cell below is
  // now an affordance for an already-scheduled row. That revives this read
  // as live, observable state.
  //
  // The zone is `orgTz` (#448), never the `tz` the row DISPLAYS in — the
  // same asymmetry the Save handler documents. It is not self-cancelling: a
  // `tz` read would look right on screen while round-tripping an instant an
  // hour (or fourteen) away from the one shown. Pinned by a value test on a
  // `tz !== orgTz` division, mutation-proven — the test that could not exist
  // before this round.
  const [when, setWhen] = useState(fixture.scheduled_at ? zonedDateTimeInput(fixture.scheduled_at, orgTz) : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // R7(a)/(b): a bye is structural, never schedulable, never actionable —
  // rendered exactly as FixtureLine's own (retired) bye branch did.
  if (isBye(fixture)) {
    const who = fixture.home_entrant_id ?? fixture.away_entrant_id;
    return (
      <li className="px-4 py-2 text-sm text-slate-500 italic">
        {msg("schedule.round", { n: fixture.round_no })} ·{" "}
        {msg("schedule.bye", { name: entrantNames[who ?? ""] ?? "?" })}
      </li>
    );
  }

  // C3: `hasOfficials` derived here, at fixtureRowAction's own call site —
  // the function takes it as a boolean input, it does not derive it itself.
  const hasOfficials = fixture.officials.length > 0;
  const action: RowAction = fixtureRowAction({
    status: fixture.status,
    scheduledAt: fixture.scheduled_at,
    hasOfficials,
    canEdit,
    tz,
    nowMs,
  });

  // C3: copied verbatim from FixtureLine's own derivation — never reinvented.
  const home = fixture.home_entrant_id
    ? (entrantNames[fixture.home_entrant_id] ?? "?")
    : resolveSlotLabel(fixture.home_slot_label ?? null, msg, "schedule.tbd");
  const away = fixture.away_entrant_id
    ? (entrantNames[fixture.away_entrant_id] ?? "?")
    : resolveSlotLabel(fixture.away_slot_label ?? null, msg, "schedule.tbd");
  const decided = outcomeText(msg, fixture.outcome, entrantNames);
  const courtLabel = courtDisplayName(fixture, courtNames) ?? fixture.venue_name;

  // C4/R12: voided fixtures keep FixtureLine's strike-through — the ACTION
  // (routed to "result" by Task 2's ladder) is right, but a cancelled match
  // that reads like an ordinary played one at a glance is the "two
  // contradicting facts in one row" class this wave exists to remove.
  const voided = VOID_STATUSES.has(fixture.status);

  // Sub-line priority: a settled result IS the fact worth showing (no extra
  // line); otherwise an unresolved entrant ("Awaiting draw") is the more
  // fundamental blocker than "no scorer yet" — an organiser cannot assign a
  // scorer to a match that doesn't know who is playing yet.
  const awaitingDraw = fixture.home_entrant_id === null || fixture.away_entrant_id === null;
  const subLine =
    decided !== null && !voided
      ? null
      : awaitingDraw
        ? msg("runsheet.sub.awaitingDraw")
        : action.kind === "assign_scorer"
          ? msg("runsheet.sub.noScorer")
          : null;

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
      setError(err instanceof Error ? err.message : msg("schedule.error.failed"));
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
          03-console-division.md): stacked below `sm` so the action never
          collides with the entrant names on a narrow screen, one row again
          at `sm:` via `sm:contents` on the action's own wrapper. `min-w-0`
          on the WHOLE ancestor chain down to the truncated spans — a
          missing one put 106px of horizontal overflow on the page at
          320-390, visible only with a realistic entrant name. */}
      <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-3">
        <div className="flex min-w-0 items-center gap-3 sm:contents">
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
              onClick={() => setEditing((e) => !e)}
              className="-my-1 flex min-h-11 w-14 shrink-0 items-center font-mono text-sm tabular-nums text-slate-600 underline decoration-slate-300 decoration-dotted underline-offset-4 hover:text-purple-700 hover:decoration-purple-500"
            >
              <ClientTime value={fixture.scheduled_at} tz={tz} mode="time" />
            </button>
          ) : (
            <span className="w-14 shrink-0 font-mono text-sm tabular-nums text-slate-600">
              {fixture.scheduled_at ? <ClientTime value={fixture.scheduled_at} tz={tz} mode="time" /> : "—"}
              {fixture.status === "in_play" && (
                <span aria-hidden className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-amber-500 align-middle" />
              )}
            </span>
          )}
          <div className="min-w-0 flex-1">
            <p className="min-w-0 truncate text-xs text-slate-500">
              {courtLabel ? `${courtLabel} · ` : ""}
              {msg("schedule.round", { n: fixture.round_no })}
            </p>
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
              <span className="mx-1.5 text-slate-400">{msg("schedule.vs")}</span>
              {away}
            </Link>
            {((decided && !voided) || subLine) && (
              <p className="min-w-0 truncate text-xs text-slate-500">{voided ? subLine : (decided ?? subLine)}</p>
            )}
          </div>
        </div>
        {/* The ONE action — a plain link for every kind except `set_time`,
            which toggles the inline editor below (≥44px either way). Its own
            row on mobile so it never collides with the entrant names above. */}
        <div className="flex flex-wrap items-center gap-2 sm:contents">
          {action.kind === "set_time" ? (
            <button
              type="button"
              data-row-action="set_time"
              disabled={busy}
              onClick={() => setEditing((e) => !e)}
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
                void patchSchedule({ scheduled_at: iso });
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
            {error && <span className="text-xs text-red-600">{error}</span>}
          </div>
        </div>
      )}
    </li>
  );
}
