"use client";

// The fixtures tab's run sheet (Task 4, competition-desk W2): a division-wide
// list on a time spine — day groups merged across every non-bracket stage,
// each bracket stage kept as its own round-sectioned block, one "Not yet
// scheduled" group last (owner rulings A2/3, `docs/superpowers/specs/
// 2026-09-02-competition-desk-prompts/_INDEX.md`). Fed by `buildRunSheet`
// (`@/lib/run-sheet-groups`) — this component only RENDERS its blocks, it
// never re-derives grouping, and it never restates `fixtureRowAction`'s
// ladder. It no longer CALLS it either: the two counted filters ask
// `division-phase.ts` (W1's ledger, and the same authority the "Needs you"
// panel is built from) for the FACT, permission-blind, instead of reading a
// row's offered action. See the block above `keep` for the two defects that
// coupling produced.
import { useEffect, useState } from "react";
import { dayKeyInTz } from "@seazn/engine/scheduling/tz";
import { useMsg, useMsgPlural } from "@/components/i18n/dict-provider";
import { isResultMissing, isUnscheduledFixture } from "@/lib/division-phase";
import { isBye, type RunSheetBlock, type RunSheetFixture } from "@/lib/run-sheet-groups";
import { bracketRoundLabel } from "@/components/v2/stages-panel";
import type { MessageKey } from "@/lib/messages";
import { RunSheetRow } from "./run-sheet-row";

type Msg = (key: MessageKey, vars?: Record<string, string | number>) => string;

export type RunSheetFilter = "today" | "needs_result" | "unscheduled" | "all";

/** The bracket header needs the stage's NAME and KIND, neither of which
 *  `RunSheetStage` (run-sheet-groups.ts) carries — it is deliberately the
 *  narrow shape the grouping builder needs, not a display type. This panel
 *  already holds the richer `StageRow[]`, so that is what feeds this prop —
 *  never a second stage fetch. */
export type RunSheetStageInfo = { id: string; kind: string; name: string };

export function RunSheet({
  blocks,
  stages,
  tz,
  orgTz,
  nowMs,
  matchMinutes,
  entrantNames,
  courtNames,
  canEdit,
  hrefFor,
  filter,
  onFilter,
  boardSlotOptions,
  onRescheduled,
}: {
  blocks: RunSheetBlock[];
  stages: RunSheetStageInfo[];
  /** The VENUE zone (`scheduleSettings.tz`), amendment 4 — one zone per
   *  fixture, for both bucketing and printing. */
  tz: string;
  /** The ORG zone (#448) — passed straight through to `RunSheetRow`'s
   *  inline "Set time" editor (fix round 3, owner ruling: a typed time is
   *  governed by `orgTz`, never `tz`). This component never reads it
   *  itself; it only threads it down, so the row stays the ONE place that
   *  actually resolves a zone against a typed value. */
  orgTz: string;
  nowMs: number;
  /** The division's own `schedule_settings.config.matchMinutes`, already
   *  resolved against `defaultMatchMinutes()` by the page (one derivation,
   *  server-side — `ScheduleConfig` lives under `@/server` and a client
   *  component that imports it breaks the build). It is the GRACE in the
   *  "Needs result" predicate: a match is not overdue while it is still
   *  being played. Required rather than defaulted, deliberately — a default
   *  here would be a second authority for a number the page already owns,
   *  and the chip would silently disagree with the "Needs you" panel. */
  matchMinutes: number;
  entrantNames: Record<string, string>;
  courtNames?: Record<string, string>;
  canEdit: boolean;
  hrefFor: (fixture: RunSheetFixture) => string;
  filter: RunSheetFilter;
  onFilter: (filter: RunSheetFilter) => void;
  boardSlotOptions?: string[];
  onRescheduled?: () => void;
}) {
  const msg = useMsg();
  const msgPlural = useMsgPlural();

  // Empty division (spec, "Error and empty states"): no header, nothing —
  // the stage rail (Task 5) is the whole story until then.
  if (blocks.length === 0) return null;

  const stageById = new Map(stages.map((s) => [s.id, s] as const));
  const today = dayKeyInTz(nowMs, tz);

  // The two counted filters are FACTS about a fixture, asked of the one
  // module that owns them (`division-phase.ts`, W1's ledger) rather than
  // re-derived here. Both used to come off `fixtureRowAction`'s ladder, and
  // both were wrong for it (max-effort review, findings 1 and 2):
  //
  //  - `set_time` is returned only when `canEdit`, so a read-only viewer —
  //    or an owner on a FROZEN competition — was shown "Unscheduled 0" above
  //    a list of unscheduled fixtures, and clicking the chip asserted
  //    absence ("No fixtures match…") where there was only inaccessibility.
  //    A display filter's membership is never a write permission's business.
  //  - `open_pad` is returned only for `in_play`, which is DISJOINT from
  //    `result_missing` (that one requires `scheduled`). The organiser's
  //    end-of-day backlog — the thing this chip exists for — read zero,
  //    while a match still being played was counted as owing its result.
  //
  // `fixtureRowAction` is still the ONE authority for what a ROW OFFERS; it
  // is simply not the authority for what a fixture IS. Each row asks it for
  // itself (`RunSheetRow`), and this component no longer restates it at all.
  const isUnscheduled = (f: RunSheetFixture) =>
    isUnscheduledFixture({ status: f.status, scheduledAt: f.scheduled_at });
  const needsResult = (f: RunSheetFixture) =>
    isResultMissing({ status: f.status, scheduledAt: f.scheduled_at, matchMinutes }, nowMs);

  // Filter semantics (spec): "Today" / "Needs result" / "Unscheduled" / "All".
  //
  // A bye is never actionable (R7a) and is never work, so it survives only the
  // unfiltered view. Max-effort review, finding 14: the bye short-circuit used
  // to be `filter === "all" || isBye(f)`, i.e. it ran BEFORE any filter test, so
  // a bye was retained under EVERY filter — `buildRunSheet` enforced R7(a) on
  // the grouping side and this predicate undid it on the rendering side. A
  // knockout with four round-1 byes, filtered to "Unscheduled", rendered a
  // "Round 1" header and four italic ghost rows under a chip reading 0, because
  // the COUNTS at `:131` already skip byes. Ruling R7(a), quoted at
  // run-sheet-groups.ts:11-12: byes "never enter the unscheduled group and never
  // carry an action" — taken literally here, which is also the only reading
  // under which the chip and the rows beneath it can agree.
  //
  // ORDER is the whole fix: `all` still wins, so a bracket round never hides the
  // bye that explains its missing fourth fixture; every work filter now drops it.
  const keep = (f: RunSheetFixture): boolean => {
    if (filter === "all") return true;
    if (isBye(f)) return false;
    if (filter === "needs_result") return needsResult(f);
    if (filter === "unscheduled") return isUnscheduled(f);
    // "today": only a TIMED fixture landing on today's venue-zone day counts.
    return f.scheduled_at !== null && dayKeyInTz(Date.parse(f.scheduled_at), tz) === today;
  };

  // Filter counts read over EVERY block's fixtures, unfiltered — a filter's
  // own count must not shrink just because it is the one currently selected.
  let needsResultCount = 0;
  let unscheduledCount = 0;
  for (const block of blocks) {
    for (const f of fixturesOf(block)) {
      if (isBye(f)) continue;
      if (needsResult(f)) needsResultCount++;
      if (isUnscheduled(f)) unscheduledCount++;
    }
  }

  const filters: { value: RunSheetFilter; label: string; count?: number }[] = [
    { value: "today", label: msg("runsheet.filter.today") },
    { value: "needs_result", label: msg("runsheet.filter.needsResult"), count: needsResultCount },
    { value: "unscheduled", label: msg("runsheet.filter.unscheduled"), count: unscheduledCount },
    { value: "all", label: msg("runsheet.filter.all") },
  ];

  function renderBlock(block: RunSheetBlock): React.ReactElement | null {
    if (block.kind === "day") {
      const rows = block.fixtures.filter(keep);
      if (rows.length === 0) return null;
      const venueNames = new Set(rows.map((f) => f.venue_name).filter((v): v is string => v !== null));
      const venueLabel = venueNames.size === 1 ? [...venueNames][0] : null;
      const nowIndex = filteredNowIndex(block, rows, nowMs);
      return (
        <section key={block.dayKey}>
          <h3
            data-run-sheet-day={block.dayKey}
            className="sticky top-0 z-10 border-y border-slate-300 bg-slate-200 px-4 py-1.5 text-xs font-semibold uppercase tracking-wide text-slate-600"
          >
            <DayHeading dayKey={block.dayKey} venueLabel={venueLabel} count={rows.length} msgPlural={msgPlural} />
          </h3>
          <ul className="divide-y divide-slate-100">
            {rows.map((f, i) => (
              <RowWithNow
                key={f.id}
                fixture={f}
                showNow={nowIndex === i}
                msg={msg}
                hrefFor={hrefFor}
                tz={tz}
                orgTz={orgTz}
                nowMs={nowMs}
                canEdit={canEdit}
                entrantNames={entrantNames}
                courtNames={courtNames}
                boardSlotOptions={boardSlotOptions}
                onRescheduled={onRescheduled}
              />
            ))}
            {nowIndex === rows.length && <NowRule msg={msg} />}
          </ul>
        </section>
      );
    }

    if (block.kind === "bracket") {
      const stage = stageById.get(block.stageId);
      const allStageFixtures = block.rounds.flatMap((r) => r.fixtures);
      const roundsWithRows = block.rounds
        .map((r) => ({ round: r.round, fixtures: r.fixtures.filter(keep) }))
        .filter((r) => r.fixtures.length > 0);
      if (roundsWithRows.length === 0) return null;
      return (
        <section key={block.stageId} data-run-sheet-block="bracket" className="card overflow-hidden">
          {roundsWithRows.map((r) => (
            <div key={r.round}>
              <header className="sticky top-0 z-10 border-b border-slate-100 bg-slate-50 px-4 py-2">
                <h4 className="text-xs font-medium uppercase tracking-wide text-slate-500">
                  {stage ? `${stage.name} — ` : ""}
                  {bracketRoundLabel(msg, stage?.kind ?? "knockout", r.round, allStageFixtures)}
                </h4>
              </header>
              <ul className="divide-y divide-slate-50">
                {r.fixtures.map((f) => (
                  <RunSheetRow
                    key={f.id}
                    fixture={f}
                    href={hrefFor(f)}
                    tz={tz}
                    orgTz={orgTz}
                    nowMs={nowMs}
                    canEdit={canEdit}
                    entrantNames={entrantNames}
                    courtNames={courtNames}
                    boardSlotOptions={boardSlotOptions}
                    onRescheduled={onRescheduled}
                  />
                ))}
              </ul>
            </div>
          ))}
        </section>
      );
    }

    if (block.kind === "unscheduled") {
      // Display-only (owner ruling B1): the auto-schedule CTA and its
      // capacity-blocked reason live on the rail (Task 5), not here.
      const rows = block.fixtures.filter(keep);
      if (rows.length === 0) return null;
      return (
        <section key="unscheduled" data-run-sheet-block="unscheduled">
          <h3 className="border-y border-slate-300 bg-slate-200 px-4 py-1.5 text-xs font-semibold uppercase tracking-wide text-slate-600">
            {msg("runsheet.unscheduled.title")}
          </h3>
          <ul className="divide-y divide-slate-100">
            {rows.map((f) => (
              <RunSheetRow
                key={f.id}
                fixture={f}
                href={hrefFor(f)}
                tz={tz}
                orgTz={orgTz}
                nowMs={nowMs}
                canEdit={canEdit}
                entrantNames={entrantNames}
                courtNames={courtNames}
                boardSlotOptions={boardSlotOptions}
                onRescheduled={onRescheduled}
              />
            ))}
          </ul>
        </section>
      );
    }

    if (block.kind === "settled") {
      // A decided/finalized/voided NON-bracket fixture with no recorded time
      // (fix round 1, controller ruling): kept visible, terminal, ordered
      // after "unscheduled" so a played match never reads as work still to
      // do. Each row's own action is already "Result" (`fixtureRowAction`'s
      // SETTLED branch fires regardless of `scheduled_at`) and its sub-line
      // already carries the score (`outcomeText`) — `RunSheetRow` needs no
      // change to render this correctly, only a home to render it IN.
      const rows = block.fixtures.filter(keep);
      if (rows.length === 0) return null;
      return (
        <section key="settled" data-run-sheet-block="settled">
          <h3 className="border-y border-slate-300 bg-slate-200 px-4 py-1.5 text-xs font-semibold uppercase tracking-wide text-slate-600">
            {msg("runsheet.settled.title")}
          </h3>
          <ul className="divide-y divide-slate-100">
            {rows.map((f) => (
              <RunSheetRow
                key={f.id}
                fixture={f}
                href={hrefFor(f)}
                tz={tz}
                orgTz={orgTz}
                nowMs={nowMs}
                canEdit={canEdit}
                entrantNames={entrantNames}
                courtNames={courtNames}
                boardSlotOptions={boardSlotOptions}
                onRescheduled={onRescheduled}
              />
            ))}
          </ul>
        </section>
      );
    }

    // Fix round 2 ("also, cheap"): the fall-through used to be unguarded —
    // "settled" fell out of an `if`/`if`/`if`/else chain, so a FIFTH block
    // kind added later would have silently rendered under the "Played, not
    // scheduled" heading instead of failing loudly. `block` is `never` here
    // if every kind above is handled; the assignment is a compile-time
    // exhaustiveness check, and the runtime branch fails loudly rather than
    // rendering the wrong thing for a kind nothing above recognises.
    const exhaustive: never = block;
    console.error("RunSheet: unrecognised block kind", exhaustive);
    return null;
  }

  const renderedBlocks = blocks.map(renderBlock).filter((node): node is React.ReactElement => node !== null);

  return (
    <div data-testid="run-sheet" className="card overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 px-4 py-3">
        <div data-testid="run-sheet-filter" className="flex flex-wrap gap-1.5">
          {filters.map((f) => (
            <button
              key={f.value}
              type="button"
              data-filter={f.value}
              aria-pressed={filter === f.value}
              onClick={() => onFilter(f.value)}
              className={`min-h-11 rounded-full px-3 text-xs font-medium ${
                filter === f.value ? "bg-purple-100 text-purple-800" : "bg-slate-100 text-slate-600 hover:bg-slate-200"
              }`}
            >
              {f.label}
              {f.count !== undefined && <span className="ml-1 text-slate-500">{f.count}</span>}
            </button>
          ))}
        </div>
        <div className="flex-1" />
        <p className="text-xs text-slate-500" data-testid="tz-caption">
          {msg("schedule.tz.caption", { tz })}
        </p>
      </div>

      {renderedBlocks.length > 0 ? (
        renderedBlocks
      ) : (
        // Fix round 1, CRITICAL 1: every block existed but the ACTIVE FILTER
        // reduced every one of them to zero rows — the same vacuous shape
        // amendment 3 already paid for one level up ("the empty set answers
        // no to every question and lands on whatever the default is"). The
        // default filter is "today" on a match day, so an organiser opening
        // the desk before any of today's fixtures exist (or after they've
        // all been filtered away) got a filter bar, a tz caption, and a
        // blank page below it — the flagship surface reading as broken on
        // the one day it exists for. `blocks.length === 0` (the whole
        // division has no fixtures at all) is the SEPARATE early return
        // above this function and never reaches here — that case renders
        // nothing at all, by spec ("the stage rail alone... no run sheet
        // header").
        <div data-testid="run-sheet-empty" className="px-4 py-10 text-center">
          <p className="text-sm text-slate-500">
            {msg("runsheet.emptyFilter.message", {
              filter: filters.find((f) => f.value === filter)?.label ?? filter,
            })}
          </p>
          {filter !== "all" && (
            <button
              type="button"
              data-testid="run-sheet-empty-show-all"
              onClick={() => onFilter("all")}
              className="btn btn-ghost mt-3 min-h-11 px-3 text-xs"
            >
              {msg("runsheet.filter.all")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Every fixture a block carries, whatever shape it stores them in — day and
 *  unscheduled blocks flat, bracket blocks per round. Used only for the
 *  filter COUNTS, which read every block once regardless of kind. */
function fixturesOf(block: RunSheetBlock): RunSheetFixture[] {
  return block.kind === "bracket" ? block.rounds.flatMap((r) => r.fixtures) : block.fixtures;
}

/** `block.nowIndex` (run-sheet-groups.ts) indexes the UNFILTERED day array.
 *  A filter can drop rows before it, so the position is re-derived over the
 *  FILTERED array using the same rule buildRunSheet applied: the first row
 *  after `nowMs`, or "after every row" when none remain. `null` means this
 *  day was never today at all — filtering cannot turn a non-today block into
 *  one that carries the NOW rule. */
function filteredNowIndex(
  block: { nowIndex: number | null },
  rows: RunSheetFixture[],
  nowMs: number,
): number | null {
  if (block.nowIndex === null) return null;
  const first = rows.findIndex((f) => f.scheduled_at !== null && Date.parse(f.scheduled_at) > nowMs);
  return first === -1 ? rows.length : first;
}

function RowWithNow({
  fixture,
  showNow,
  msg,
  hrefFor,
  ...rest
}: {
  fixture: RunSheetFixture;
  showNow: boolean;
  msg: Msg;
  hrefFor: (fixture: RunSheetFixture) => string;
  tz: string;
  orgTz: string;
  nowMs: number;
  canEdit: boolean;
  entrantNames: Record<string, string>;
  courtNames?: Record<string, string>;
  boardSlotOptions?: string[];
  onRescheduled?: () => void;
}) {
  return (
    <>
      {showNow && <NowRule msg={msg} />}
      <RunSheetRow fixture={fixture} href={hrefFor(fixture)} {...rest} />
    </>
  );
}

/** The NOW rule — lime, at most one per sheet (only on today's day block, at
 *  the position `nowIndex`/`filteredNowIndex` compute). */
function NowRule({ msg }: { msg: Msg }) {
  return (
    <li
      data-testid="run-sheet-now"
      aria-hidden
      className="flex items-center gap-2 bg-lime-50 px-4 py-1 text-[11px] font-semibold tracking-wide text-lime-700 uppercase"
    >
      <span className="h-1.5 w-1.5 rounded-full bg-lime-500" />
      {msg("runsheet.now")}
    </li>
  );
}

/** Hydration-safe day heading: blank until mount (locale-formatted date, same
 *  posture as `ClientTime`/`ClientDateRange`), built from the day KEY
 *  directly (already the resolved venue-zone calendar day — formatting it
 *  with `timeZone: "UTC"` off a UTC-midday instant avoids a second,
 *  redundant zone conversion at display time). */
function DayHeading({
  dayKey,
  venueLabel,
  count,
  msgPlural,
}: {
  dayKey: string;
  venueLabel: string | null;
  count: number;
  msgPlural: (key: string, count: number, vars?: Record<string, string | number>) => string;
}) {
  const [weekday, setWeekday] = useState("");
  useEffect(() => {
    const [y, m, d] = dayKey.split("-").map(Number);
    if (y === undefined || m === undefined || d === undefined) return;
    const date = new Date(Date.UTC(y, m - 1, d, 12));
    try {
      setWeekday(date.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }));
    } catch {
      setWeekday(dayKey);
    }
  }, [dayKey]);
  const parts = [weekday || dayKey, venueLabel, msgPlural("runsheet.day.fixtures", count)].filter(
    (p): p is string => Boolean(p),
  );
  return <>{parts.join(" · ")}</>;
}
