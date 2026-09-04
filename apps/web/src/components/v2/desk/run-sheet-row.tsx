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
import { fixtureRowAction, type RowAction } from "@/lib/fixture-row-action";
import { isBye, type RunSheetFixture } from "@/lib/run-sheet-groups";
import { outcomeText, VOID_STATUSES } from "@/components/v2/stages-panel";
import type { PatchFixture } from "@/server/api-v1/schemas";
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
  // Fix round 3 (owner ruling): the ORG zone (`orgTz`, #448), never the
  // VENUE zone (`tz`) and never the browser's implicit zone —
  // `zoned-datetime.ts`'s own header already rules that a TYPED time is
  // governed by `orgTz`, matching every other write site in the repo. This
  // is a deliberate mismatch with the row's DISPLAY (`tz`, amendment 4): on
  // a division whose venue zone overrides the org's, an organiser typing
  // 15:00 sees the row redisplay a different wall-clock time after save —
  // accepted explicitly by the owner, made legible via the zone note next
  // to the field rather than "fixed" by changing the display (that trade
  // was ruled on, not left open).
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

  async function patchSchedule(json: PatchFixture) {
    setBusy(true);
    setError(null);
    try {
      await apiV1(`/api/v1/fixtures/${fixture.id}`, { method: "PATCH", json });
      setEditing(false);
      router.refresh();
      onRescheduled?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : msg("schedule.error.failed"));
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
              em-dash for a row with no time at all (the unscheduled group). */}
          <span className="w-14 shrink-0 font-mono text-sm tabular-nums text-slate-600">
            {fixture.scheduled_at ? <ClientTime value={fixture.scheduled_at} tz={tz} mode="time" /> : "—"}
            {fixture.status === "in_play" && (
              <span aria-hidden className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-amber-500 align-middle" />
            )}
          </span>
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
        <div className="mt-2 flex flex-col gap-1.5">
          {/* Fix round 3 (owner ruling, "make the mismatch legible"): the
              typed value is read/written in `orgTz`, not the `tz` the row
              displays in — on a division whose venue zone differs, the
              saved time redisplays differently. Named here so that reads
              as "this field uses a different clock", not as data loss. */}
          <p className="text-xs text-slate-500" data-testid="run-sheet-set-time-zone-note">
            {msg("runsheet.setTime.zoneNote", { tz: orgTz })}
          </p>
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
            {error && <span className="text-xs text-red-600">{error}</span>}
          </div>
        </div>
      )}
    </li>
  );
}
