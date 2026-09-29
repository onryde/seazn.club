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
import { useEffect, useRef } from "react";
import { dayKeyInTz } from "@seazn/engine/scheduling/tz";
import { useLocaleOrDefault, useMsg, useMsgPlural } from "@/components/i18n/dict-provider";
import { dayLabel, dayLabelLong } from "@/lib/day-label";
import { isResultMissing, isUnscheduledFixture } from "@/lib/division-phase";
import { isBye, type RunSheetBlock, type RunSheetFixture } from "@/lib/run-sheet-groups";
import type { FeedLabelPair } from "@/lib/schedule-board";
import type { Venue } from "@/components/v2/shared/court-multi-picker";
import { bracketRoundLabel } from "@/components/v2/stages-panel";
import type { MessageKey } from "@/lib/messages";
import { RunSheetRow } from "./run-sheet-row";
import type { StreamPanelContext } from "@/components/v2/fixture-stream-panel";

type Msg = (key: MessageKey, vars?: Record<string, string | number>) => string;

export type RunSheetFilter = "today" | "needs_result" | "unscheduled" | "all";

/** The bracket header needs the stage's NAME and KIND, neither of which
 *  `RunSheetStage` (run-sheet-groups.ts) carries — it is deliberately the
 *  narrow shape the grouping builder needs, not a display type. This panel
 *  already holds the richer `StageRow[]`, so that is what feeds this prop —
 *  never a second stage fetch. */
export type RunSheetStageInfo = { id: string; kind: string; name: string };

/** Everything one row test needs besides the filter: the stage filter (`null` = every stage), the venue zone,
 *  today's day key in it, the clock, and the division's `matchMinutes` (the "Needs result" grace). */
export type RunSheetKeepContext = {
  stageId: string | null;
  tz: string;
  today: string;
  nowMs: number;
  matchMinutes: number;
};

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
//
// The STAGE dimension (`stageId`) is checked FIRST, ahead of even `all` —
// it is a second, orthogonal axis a row must ALSO satisfy, not one more
// value of the `RunSheetFilter` ladder below it. A bye belonging to a
// stage the organiser has filtered away must not survive under "all"
// either, so this cannot reuse the `all`-wins-first ordering the TYPE
// filter uses for byes — it runs before that ladder even starts.
//
// Module scope and exported (D2, stream-credits walkthrough, 2026-09-29) so the division page's MOUNTING filter
// (`initialRunSheetFilter`, stages-panel.tsx) asks this same predicate whether a checkout-returned fixture's row is
// on the sheet, instead of restating the "Today" rule beside it.
export function runSheetKeeps(f: RunSheetFixture, filter: RunSheetFilter, ctx: RunSheetKeepContext): boolean {
  const { stageId, tz, today, nowMs, matchMinutes } = ctx;
  if (stageId !== null && f.stage_id !== stageId) return false;
  if (filter === "all") return true;
  if (isBye(f)) return false;
  if (filter === "needs_result")
    return isResultMissing({ status: f.status, scheduledAt: f.scheduled_at, matchMinutes }, nowMs);
  if (filter === "unscheduled") return isUnscheduledFixture({ status: f.status, scheduledAt: f.scheduled_at });
  // "today": only a TIMED fixture landing on today's venue-zone day counts.
  return f.scheduled_at !== null && dayKeyInTz(Date.parse(f.scheduled_at), tz) === today;
}

export function RunSheet({
  blocks,
  stages,
  tz,
  orgTz,
  nowMs,
  matchMinutes,
  entrantNames,
  courtNames,
  venues,
  canEdit,
  hrefFor,
  filter,
  onFilter,
  stageId,
  onStageFilter,
  boardSlotOptions,
  onRescheduled,
  stream,
  feedLabels,
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
  /** Org venues with nested courts — threaded straight through to each row's
   *  inline editor for R35's per-fixture court picker. This component never
   *  reads them itself. */
  venues?: readonly Venue[];
  canEdit: boolean;
  hrefFor: (fixture: RunSheetFixture) => string;
  filter: RunSheetFilter;
  onFilter: (filter: RunSheetFilter) => void;
  /** Owner-approved "Option 2" (competition desk W3, on top of Option B) —
   *  a SECOND, ORTHOGONAL filter dimension: which stage's fixtures to show,
   *  or `null` for every stage. Deliberately not folded into
   *  `RunSheetFilter` (that union stays exactly `"today" | "needs_result" |
   *  "unscheduled" | "all"`) — a stage id is not one more value of "what
   *  kind of row", it is a second axis a row must ALSO satisfy, and a
   *  fixture can be BOTH "needs_result" and "in stage X" at once. Set from
   *  each stage card's "View N fixtures" control (stages-panel.tsx); its
   *  own clear affordance lives in the chip row below (`run-sheet-stage-
   *  filter`), per owner ruling — the chip row is where a person looks to
   *  clear a filter, not a separate, easier-to-miss control. */
  stageId: string | null;
  onStageFilter: (stageId: string | null) => void;
  boardSlotOptions?: string[];
  onRescheduled?: () => void;
  /** Stream Overlay W1 — threaded straight through to each row's stream
   *  panel, exactly as `venues` and `orgTz` above are. This component never
   *  reads it. */
  stream?: StreamPanelContext;
  /** Feeder labels for unfilled bracket seats, keyed by fixture id —
   *  `feedLabels()`'s output (lib/schedule-board.ts). Threaded straight
   *  through to every `RunSheetRow` below and never read here, exactly as
   *  `venues`/`orgTz`/`stream` are.
   *
   *  Built by the PANEL, not here, and deliberately: the map must be derived
   *  from the division's WHOLE fixture list, and `blocks` is already a
   *  filtered, grouped view of it (ruling R7(c) drops an untimed plain-league
   *  bye from the sheet entirely). Deriving it from `blocks` would make a
   *  seat's label depend on whether its feeder happened to survive grouping. */
  feedLabels?: Record<string, FeedLabelPair>;
}) {
  const msg = useMsg();
  const msgPlural = useMsgPlural();
  // The APP's active locale, for every date this sheet formats (finding 13).
  // `useLocaleOrDefault` rather than `useLocale` for the same reason `useMsg` is
  // used above: these islands are rendered bare, with no provider, in this
  // repo's component tests, and the throwing hook reddens them.
  const locale = useLocaleOrDefault();

  // Review finding m2, CLOSED (W4). The offset used to be the literal
  // `top-[86px]` — 56 plus a day header height ASSUMED to be 30px at one
  // line. `DayHeading` prints date + venue + count, so at 320 with a real
  // venue name it wraps to two lines and the bracket header then overlapped
  // the very header it was supposed to stack under. The height is now
  // MEASURED into `--desk-day-h` and consumed through `calc()`, so the
  // stacking follows whatever the day header actually is.
  //
  // The inline value below is the pre-hydration and no-JS fallback, and it
  // is deliberately the OLD constant: before the effect runs, the sheet
  // behaves exactly as it shipped rather than collapsing to a shared slot.
  const sheetRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = sheetRef.current;
    if (!root) return;
    const heads = () => [...root.querySelectorAll<HTMLElement>("[data-run-sheet-day]")];
    const measure = () => {
      // The TALLEST day header, not the first: at 320 one day's venue clause
      // can wrap while another's does not, and the offset has to clear the
      // worst case or it under-shoots on exactly the day that needed it.
      const tallest = heads().reduce((max, el) => Math.max(max, el.getBoundingClientRect().height), 0);
      root.style.setProperty("--desk-day-h", `${Math.round(tallest)}px`);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    for (const el of heads()) ro.observe(el);
    return () => ro.disconnect();
  }, [blocks]);

  // Empty division (spec, "Error and empty states"): no header, nothing —
  // the stage rail (Task 5) is the whole story until then.
  if (blocks.length === 0) return null;

  const stageById = new Map(stages.map((s) => [s.id, s] as const));
  const today = dayKeyInTz(nowMs, tz);

  // Ruling C-3 (controller, real-data reproduction): the day header and a
  // bracket round header both stick at the SAME `top: 56px` offset. Under
  // block flow they cannot occupy that offset at the identical instant —
  // a day header's own stuck window is bounded by its own `<section>`'s
  // box, and it provably releases before the next section's header ever
  // reaches 56px (verified live: the release point tracks the day
  // section's own bottom edge exactly, not some larger ancestor, across
  // four different day/bracket size ratios) — but the day header IS a
  // long-lived, genuinely "wider grouping" element next to a bracket
  // round's own, and the owner wants them stacked deliberately rather than
  // reasoned about as merely non-colliding. When this sheet has at least
  // one day block, every bracket round header gets pushed DOWN by exactly
  // the day header's own height (`top-14` + 30px = `top-[86px]`), so if a
  // day header and a bracket header are ever both visible near the top of
  // the viewport, they stack (day above, bracket below) instead of sharing
  // a slot — belt-and-braces on top of the structural guarantee above.
  // A division with NO day block (single bracket stage, the common case)
  // keeps its round headers at the ordinary `top-14` — there is no day
  // header for them to stack under, and reserving the extra height
  // unconditionally would open an empty band under nav for no reason.
  const hasDayBlock = blocks.some((b) => b.kind === "day");


  // F3 (W2 walkthrough gate 1): only the unscheduled/settled groups need a
  // stage name — day and bracket blocks already identify their own stage in
  // their header. Gated on more than one stage per the finding's own
  // counter-argument ("show it only when the division has more than one
  // stage... single-stage divisions gain no noise").
  const stageNameFor = (f: RunSheetFixture): string | null =>
    stages.length > 1 ? (stageById.get(f.stage_id)?.name ?? null) : null;

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

  // The row test lives at module scope (`runSheetKeeps`, above) — its filter semantics and ORDER are documented there.
  const keep = (f: RunSheetFixture): boolean => runSheetKeeps(f, filter, { stageId, tz, today, nowMs, matchMinutes });

  // Filter counts read over EVERY block's fixtures, unfiltered — a filter's
  // own count must not shrink just because it is the one currently selected.
  // They DO narrow to `stageId` when a stage filter is active — same
  // reasoning as `keep` above: the count an organiser sees on "Needs
  // result" while filtered to one stage should be that stage's own count,
  // matching what clicking it would actually show, not the whole
  // division's.
  let needsResultCount = 0;
  let unscheduledCount = 0;
  for (const block of blocks) {
    for (const f of fixturesOf(block)) {
      if (stageId !== null && f.stage_id !== stageId) continue;
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
            // F4 (W2 walkthrough gate 1): `nav.tsx`'s own header is
            // `sticky top-0 z-20` over an `h-14` (56px) bar. This header used
            // to stick at the SAME `top-0`, one z-layer below — so once
            // scrolled to the natural "day header pinned" position, this
            // header sat entirely BEHIND nav (never visible while doing its
            // job) and every control in the strip it should have been
            // showing hit-tested to nav's own logo instead. `top-14` sticks
            // this header just below nav's own height, never under it.
            className="sticky top-14 z-10 border-y border-slate-300 bg-slate-200 px-4 py-1.5 text-xs font-semibold uppercase tracking-wide text-slate-600"
          >
            <DayHeading
              dayKey={block.dayKey}
              venueLabel={venueLabel}
              count={rows.length}
              locale={locale}
              msgPlural={msgPlural}
            />
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
                venues={venues}
                boardSlotOptions={boardSlotOptions}
                onRescheduled={onRescheduled}
                stream={stream}
                feedLabels={feedLabels}
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
        // Fix (controller ruling C-1, pre-existing from W2 — see the
        // `run-sheet` div's own comment for the full argument): NO
        // `overflow-hidden` here either. This section's sticky round
        // headers need their SCROLLING ancestor to be the actual page, and
        // this section — like the outer div — never scrolls internally,
        // so any `overflow` value here that is not `visible` pins every
        // header 56px into whichever row happens to occupy that band,
        // permanently, rather than tracking the viewport. `rounded-2xl`
        // alone (no clip) still rounds this section's OWN border/shadow —
        // that rendering does not depend on overflow at all. The one thing
        // overflow-hidden WAS doing here — stopping the first round
        // header's `bg-slate-50` from squaring off past this section's own
        // rounded top corner — moves onto that header directly, below
        // (`rounded-t-2xl`, first round only — every other round header
        // sits well inside the section's flat area and was never at risk).
        <section key={block.stageId} data-run-sheet-block="bracket" className="card">
          {roundsWithRows.map((r, i) => {
            // R34 — the round's calendar date, the one thing a bracket row's
            // `HH:mm`-only time cell cannot say. `null` on an untimed round, so
            // the header simply reads as it did before.
            const dates = roundDateLabel(r.fixtures, tz, locale);
            return (
            <div key={r.round}>
              {/* F4 — same nav-collision fix as the day header above.
                  `rounded-t-2xl` on the FIRST round only (see the section's
                  own comment above) — replaces the clipping
                  `overflow-hidden` used to do for this one corner.
                  Ruling C-3 — this header stacks BELOW the day header
                  rather than sharing `top-14` with it, whenever the sheet
                  also has a day block. The offset is `56px + the measured
                  day-header height` (`--desk-day-h`, set on the sheet root
                  above); with no day block the sheet publishes `0px` and
                  this resolves to plain `top-14`, so one expression covers
                  both cases and there is no class to keep in Tailwind's
                  scanner. Review finding m2 is what retired the old
                  `top-[86px]` literal — see the effect's comment. */}
              <header
                style={{ top: "calc(3.5rem + var(--desk-day-h, 0px))" }}
                className={`sticky z-10 border-b border-slate-100 bg-slate-50 px-4 py-2 ${i === 0 ? "rounded-t-2xl" : ""}`}
              >
                <h4 className="text-xs font-medium uppercase tracking-wide text-slate-500">
                  {stage ? `${stage.name} — ` : ""}
                  {bracketRoundLabel(msg, stage?.kind ?? "knockout", r.round, allStageFixtures)}
                  {dates !== null && (
                    <span data-run-sheet-round-dates className="ml-1.5 font-normal normal-case text-slate-500">
                      · {dates}
                    </span>
                  )}
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
                    venues={venues}
                    boardSlotOptions={boardSlotOptions}
                    onRescheduled={onRescheduled}
                    stream={stream}
                    feedLabels={feedLabels}
                  />
                ))}
              </ul>
            </div>
            );
          })}
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
                venues={venues}
                boardSlotOptions={boardSlotOptions}
                onRescheduled={onRescheduled}
                stream={stream}
                feedLabels={feedLabels}
                stageName={stageNameFor(f)}
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
                venues={venues}
                boardSlotOptions={boardSlotOptions}
                onRescheduled={onRescheduled}
                stream={stream}
                feedLabels={feedLabels}
                stageName={stageNameFor(f)}
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
    // Fix (competition desk W3, controller ruling C-1) — `overflow-hidden`
    // REMOVED. This is pre-existing from W2 (`run-sheet.tsx` has zero
    // commits in `origin/main..HEAD` before this fix; W3 did not introduce
    // it), but fixing the sticky group headers below means touching it.
    //
    // `overflow: hidden` on ANY ancestor makes that ancestor the CONTAINING
    // BLOCK a `position: sticky` descendant sticks to — not the viewport,
    // regardless of whether that ancestor ever actually scrolls. This div
    // (and the bracket `<section>` below) never scroll internally — the
    // PAGE does — so a sticky child inside either one just sat at a fixed
    // `top: 56px` offset from ITS OWN box, permanently, never tracking the
    // page's scroll position at all. Measured: at `scrollY = 0`, a bracket
    // round header already sat 56px into its section, overlapping a row by
    // 33px — not "about to stick", already wrong, at rest.
    //
    // It was there for ONE reason: clipping a child's square-cornered
    // background so it cannot bleed past this div's own `rounded-2xl`
    // corners. The only child with a background that could ever sit AT
    // those corners is the FIRST/LAST rendered thing — and the first is
    // UNCONDITIONALLY the filter bar just below (`border-b`, no `bg-*`,
    // transparent — nothing to clip at the top edge, ever, regardless of
    // which block kind renders first beneath it), and the last is always
    // either a `<li>` row (`run-sheet-row.tsx`, no background of its own)
    // or a bracket `<section>` that already carries its own `rounded-2xl`
    // (so it has no square corner to bleed in the first place). Nothing
    // else in this tree sits flush against this div's own edges, so
    // dropping the clip here is not a compromise — it costs nothing this
    // render actually produces. See the bracket `<section>` below for the
    // one place that DID need a replacement (`rounded-t-2xl` on the first
    // round header specifically, not blanket clipping).
    <div data-testid="run-sheet" className="card">
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
          {/* Owner-approved "Option 2" — the stage filter's own clear
              affordance, in the SAME chip row the four type filters live
              in (owner ruling: "the existing chip row is where a person
              will look to clear it, so make the active stage filter
              legible there rather than hidden"). Mounted only while a
              stage filter is active — never a permanent, mostly-inert chip.
              Its own visible text carries the accessible name (stage name,
              user-typed — never grammatically combined with a verb that
              would need to agree with it, R13/W3's own standing rule); the
              `sr-only` span appends "Clear filter" so a screen reader's
              announcement reads as an action, not just a label. */}
          {stageId !== null && (
            <button
              type="button"
              data-testid="run-sheet-stage-filter"
              onClick={() => onStageFilter(null)}
              className="flex min-h-11 items-center gap-1.5 rounded-full bg-purple-100 px-3 text-xs font-medium text-purple-800 hover:bg-purple-200"
            >
              <span>
                {msg("runsheet.stageFilter.label")}: {stageById.get(stageId)?.name ?? stageId}
              </span>
              <span aria-hidden="true">✕</span>
              <span className="sr-only">{msg("runsheet.stageFilter.clearAria")}</span>
            </button>
          )}
        </div>
        <div className="flex-1" />
        <p className="text-xs text-slate-500" data-testid="tz-caption">
          {msg("schedule.tz.caption", { tz })}
        </p>
      </div>

      {renderedBlocks.length > 0 ? (
        // Owner request — the sheet's internal blocks (day groups, bracket
        // sections, unscheduled, settled) get real separation instead of
        // sitting edge to edge: the SAME `space-y-6` (24px) rhythm the stage
        // cards above already use, not a third value invented for this one
        // spot. Tailwind's `space-y-*` is pure `margin-top` on every child
        // but the first — no positioning/overflow side effect, so it cannot
        // reopen ruling C-1 (the sticky headers' containing-block fix) on
        // its own; verified live (scroll sweep, both coarse and fine
        // granularity) that the sticky handoffs below still land cleanly
        // after this change — see the task report.
        // Review finding m1 — the arbitrary variant is the whole fix for the
        // one case the `overflow-hidden` removal above got wrong. That
        // argument said the last rendered thing is "always either a `<li>`
        // row (no background of its own) or a bracket `<section>` that
        // already carries its own `rounded-2xl`". There is a third: the NOW
        // rule is a `<li>` WITH a background (`bg-lime-50`, square corners,
        // run-sheet.tsx's `NowRule`), and `filteredNowIndex` returns
        // `rows.length` — i.e. the rule renders LAST inside its `<ul>` —
        // whenever no fixture in the day is still ahead. End of a match day
        // on a fully-scheduled division (nothing unscheduled, nothing
        // settled-untimed, so the day block really is the last block) put a
        // lime bar squarely over the card's own rounded bottom corners.
        //
        // Scoped, deliberately, with `>section:last-child`: a NOW rule that
        // ends a day block with LATER days still to come must stay square,
        // or a rounded lime bar appears in the middle of the sheet. That is
        // why this is a CSS descendant rule on the last block rather than a
        // `last:` utility on `NowRule` itself, which cannot tell the two
        // apart.
        <div
          ref={sheetRef}
          style={{ "--desk-day-h": hasDayBlock ? "30px" : "0px" } as React.CSSProperties}
          className="space-y-6 [&>section:last-child>ul>li:last-child]:rounded-b-2xl"
        >
          {renderedBlocks}
        </div>
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
          {/* Owner-approved "Option 2" — also clears the STAGE filter, not
              just the type filter: gated on either being active, so a page
              filtered to one stage with `filter === "all"` (an empty
              combination — that stage genuinely has no fixtures matching
              nothing else, edge case) still gets a working way back, and
              clicking it clears both dimensions at once rather than
              leaving the organiser one tap short of the unfiltered
              sheet. */}
          {(filter !== "all" || stageId !== null) && (
            <button
              type="button"
              data-testid="run-sheet-empty-show-all"
              onClick={() => {
                onFilter("all");
                onStageFilter(null);
              }}
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
  venues?: readonly Venue[];
  boardSlotOptions?: string[];
  onRescheduled?: () => void;
  stream?: StreamPanelContext;
  /** Declared here only so it survives `...rest` into `RunSheetRow` — this
   *  wrapper reads nothing off it (same posture as `stream`/`venues`). */
  feedLabels?: Record<string, FeedLabelPair>;
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

/**
 * The sticky day heading, built from the day KEY directly (already the
 * resolved venue-zone calendar day, so no second zone conversion at display
 * time).
 *
 * Max-effort review, finding 13. This used to call
 * `toLocaleDateString([], …)` inside a `useEffect`, and BOTH halves of that
 * were wrong:
 *
 *  - `[]` means "the runtime's default locale" — the viewer's own browser, not
 *    the application's active one. The largest string on a fully French console
 *    read "Saturday 5 September" for an en-US viewer and "9月5日土曜日" for a
 *    ja-JP one. `lib/day-label.ts` exists to prevent exactly this and its
 *    header records the previous instance ("Fri 10 Jul" inside a French page).
 *  - the effect existed only because an implicit locale is NOT hydration-safe.
 *    An EXPLICIT one is, which is why `schedule-board.tsx` renders the same
 *    call inline with no client gate — so the date is now in the first paint
 *    instead of appearing after mount, and the `react-hooks/set-state-in-effect`
 *    warning goes with it.
 *
 * `dayLabelLong` keeps the long form this header was designed at; `dayLabel`
 * (short) is what the bracket round headers use, where space is tighter.
 */
function DayHeading({
  dayKey,
  venueLabel,
  count,
  locale,
  msgPlural,
}: {
  dayKey: string;
  venueLabel: string | null;
  count: number;
  /** The APP's active locale (`useLocaleOrDefault`), threaded from `RunSheet` —
   *  never the runtime default, and never re-read here. */
  locale: string;
  msgPlural: (key: string, count: number, vars?: Record<string, string | number>) => string;
}) {
  let weekday = dayKey;
  try {
    weekday = dayLabelLong(dayKey, locale);
  } catch {
    /* a malformed key falls back to the key itself, as before */
  }
  const parts = [weekday || dayKey, venueLabel, msgPlural("runsheet.day.fixtures", count)].filter(
    (p): p is string => Boolean(p),
  );
  return <>{parts.join(" · ")}</>;
}

/**
 * The calendar date a bracket round is played on — "Sun 6 Sep", or a range when
 * the round spans days. Ruling R34.
 *
 * A bracket fixture's date was NOWHERE on the tab: rows print `HH:mm` only, and
 * only `kind: "day"` blocks carry a date header, which bracket stages never
 * produce. So a knockout Final three weeks out showed a clock time and nothing
 * else, on precisely the formats where a single fixture's date matters most.
 * The retired `round-dates` bar carried this fact and owner ruling A2 kept the
 * round sections, so this is a restoration into a container that already exists.
 *
 * Derived from the rows this header actually sits above (post-filter), so it can
 * never describe a day the organiser cannot see. Bucketed with `dayKeyInTz` in
 * the VENUE zone — the same clock the rest of the sheet groups and prints by
 * (amendment 4), never a second one. `null` when the round has no timed fixture
 * at all: a header that fires with nothing to say is the "an empty cell is not
 * information" defect wearing a date's clothes.
 */
function roundDateLabel(fixtures: readonly RunSheetFixture[], tz: string, locale: string): string | null {
  const keys = fixtures
    .filter((f) => f.scheduled_at !== null)
    .map((f) => dayKeyInTz(Date.parse(f.scheduled_at!), tz))
    .sort();
  const first = keys[0];
  const last = keys[keys.length - 1];
  if (first === undefined || last === undefined) return null;
  return first === last ? dayLabel(first, locale) : `${dayLabel(first, locale)} – ${dayLabel(last, locale)}`;
}
