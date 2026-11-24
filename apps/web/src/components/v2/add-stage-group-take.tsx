"use client";
// Add stage after a stage of SEVERAL groups (owner Option C, 2026-11-24): the "Top N" select (one table) gives way to ONE count,
// "Qualify to the knockout: N", the same model as the division builder's Groups + Knockout ("Pools" + "Qualify to finals"). Below it a
// live line says what the count means - the split ("Top 2 per group and 2 best 3rd-placed", the builder's own `groupsKoTake`, its
// phrases `templates.detail.take.*`) and what knockout it makes (a whole round, or a bracket with byes).
//
// The counts offered are the ones the save door accepts (`groupTakeWorkingCounts`, the same predicate the server's
// `refuseGroupTakeShape` asks as the authority), so the form cannot submit a count the stage could never be drawn from. A count left
// out is said once, plainly. One DOM at every width: the control and its line wrap, nothing is duplicated for phones.
import { groupsKoTake } from "@/lib/format-templates";
import { groupTakeRefusal, groupTakeWorkingCounts } from "@/lib/group-take-refusal";
import { FORMAT_BOUNDS } from "@/lib/format-bounds";
import { seedingErrorMessage } from "@/lib/seeding-error";
import type { Locale } from "@/lib/i18n-constants";
import type { MessageKey } from "@/lib/messages";
import { takeRuleText } from "@/components/v2/template-gallery";

type Msg = (key: MessageKey, vars?: Record<string, string | number>) => string;

/** What the Add stage form needs to know of the stage it follows: a group stage of two or more pools, and how many are in the field
 *  (null when the page cannot tell: the counts are then bounded by the draw alone). */
export interface GroupSource {
  pools: number;
  entrants: number | null;
}

/** The counts the form offers, ascending. Empty when no count can be drawn from these groups (more groups than the draw takes). */
export function groupCountsFor(source: GroupSource, destKind: string): number[] {
  return groupTakeWorkingCounts(destKind, source.pools, source.entrants);
}

/** The count the form opens on: twice the groups (the top two of every group) when that is offered, else the offered count nearest 8. */
export function defaultGroupCount(counts: readonly number[], pools: number): number | null {
  if (counts.length === 0) return null;
  if (counts.includes(pools * 2)) return pools * 2;
  return [...counts].sort((a, b) => Math.abs(a - 8) - Math.abs(b - 8) || a - b)[0]!;
}

/** The bracket a knockout of `count` is drawn in: its size (the next power of two), the byes round one holds, and the round it opens
 *  on when whole (no byes). */
export function bracketOf(count: number): { size: number; byes: number; whole: boolean } {
  let size = 1;
  while (size < count) size *= 2;
  return { size, byes: size - count, whole: size === count };
}

/** The line under the count: "{count} go through: Top 2 per group and 2 best 3rd-placed." and, for a knockout, its round. */
export function groupTakeSummary(msg: Msg, o: { count: number; pools: number; destKind: string }): { take: string; round: string | null } {
  const rules = groupsKoTake(o.count, o.pools).map((rule) => takeRuleText(msg as never, rule as Parameters<typeof takeRuleText>[1]));
  const joined = rules.reduce((acc, text) => msg("templates.detail.take.and", { a: acc, b: text }));
  const take = msg("schedule.groupTake.derived", { count: o.count, take: joined });
  if (o.destKind !== "knockout") return { take, round: null };
  const { size, byes, whole } = bracketOf(o.count);
  if (!whole) return { take, round: msg("schedule.groupTake.byes", { size, byes }) };
  const name = size === 2 ? msg("bracket.round.final") : size === 4 ? msg("bracket.round.semi") : size === 8 ? msg("bracket.round.quarter") : msg("bracket.round.roundOf", { n: size });
  return { take, round: msg("schedule.groupTake.whole", { round: name }) };
}

export function GroupTakeField({
  msg,
  locale,
  source,
  destKind,
  counts,
  value,
  onChange,
}: {
  msg: Msg;
  locale: Locale;
  source: GroupSource;
  destKind: string;
  counts: readonly number[];
  /** The chosen count, one of `counts` (null when none is offered). */
  value: number | null;
  onChange: (count: number) => void;
}) {
  if (value === null) {
    // Nothing can be drawn from these groups: say why, in the dictionary's words, never an empty select.
    const why = groupTakeRefusal({ destKind, placement: "rank_order", pools: source.pools, take: groupsKoTake(FORMAT_BOUNDS.qualify.min, source.pools), entrants: source.entrants });
    return (
      <p data-testid="add-stage-group-none" role="alert" className="w-full min-w-0 basis-full text-sm text-red-600">
        {why === null ? msg("schedule.groupTake.none") : seedingErrorMessage(locale, why.code, msg("schedule.groupTake.none"), why.vars)}
      </p>
    );
  }
  const summary = groupTakeSummary(msg, { count: value, pools: source.pools, destKind });
  const lo = counts[0]!;
  const hi = counts[counts.length - 1]!;
  const omitted = hi - lo + 1 > counts.length;
  return (
    <>
      <label className="block">
        <span className="label">{msg("schedule.groupTake.label")}</span>
        {/* A select, like the Top N it replaces: it cannot hold a count outside its options, and the options are the counts the save
            door accepts. data-format-bound keeps the control under the same bounds sweep as every other qualify control. */}
        <select data-testid="add-stage-group-count" data-format-bound="qualify" value={value} onChange={(e) => onChange(Number(e.target.value))} className="select">
          {counts.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </label>
      <div data-testid="add-stage-group-summary" className="min-w-0 basis-full text-sm" aria-live="polite">
        <p data-testid="add-stage-group-take" className="min-w-0 break-words">
          {summary.take}
        </p>
        {summary.round !== null && (
          <p data-testid="add-stage-group-round" className="min-w-0 break-words text-slate-500">
            {summary.round}
          </p>
        )}
        {omitted && (
          <p data-testid="add-stage-group-omitted" className="min-w-0 break-words text-xs text-slate-500">
            {msg("schedule.groupTake.omitted")}
          </p>
        )}
      </div>
    </>
  );
}
