// The public Schedule's ROUND groups, in play order - one authority for the round view of `components/public-site/schedule.tsx`
// and for the by-round paging of a big schedule (W5 follow-ups C, `schedule-paging.ts`), so a folded round's header and the round
// the small schedule's round view draws are the same group, named the same way. Pure and client-safe.
import type { PublicFixture } from "@/server/public-site/data";

/** A fixture's round NAME as the round view heads it: the public round namer's label, or its round number when the caller has
 *  none for it. */
export const roundNameOf = (f: Pick<PublicFixture, "id" | "round_no">, roundLabels: Record<string, string>) =>
  roundLabels[f.id] ?? String(f.round_no);

/** N1g g1 (review-n1f I1) — every round name that more than one STAGE of the division produces (a knockout and its plate both
 *  ending in a "Final"). The round view names the stage in front of exactly these headings.
 *
 *  Pass the division's WHOLE fixture list. Whether a name is shared is a fact about the division, not about what is on screen:
 *  decided over the entrant-filtered list, a spectator filtered to a plate finalist saw a bare "Final" — reading as THE final —
 *  and the heading changed identity as the filter changed. Stages are counted, not fixtures: a name repeated inside one stage is
 *  not shared. */
export function sharedRoundNames(
  fixtures: readonly Pick<PublicFixture, "id" | "stage_id" | "round_no">[],
  roundLabels: Record<string, string>,
): Set<string> {
  const stagesByName = new Map<string, Set<string>>();
  for (const f of fixtures) {
    const name = roundNameOf(f, roundLabels);
    const stages = stagesByName.get(name) ?? new Set<string>();
    stages.add(f.stage_id);
    stagesByName.set(name, stages);
  }
  return new Set([...stagesByName].filter(([, stages]) => stages.size > 1).map(([name]) => name));
}

export interface ScheduleRoundGroup<F> {
  /** `JSON.stringify([stage_id, round name])` - stable for a division, and the key a folded round is loaded by. */
  key: string;
  /** The heading: the round name, with the stage in front when another stage names a round the same. */
  label: string;
  stageId: string;
  /** The round number of the group's first fixture (every fixture of a group shares its stage and round name). */
  roundNo: number;
  /** The group's fixtures in play order. */
  fixtures: F[];
}

/**
 * Round view (N1d d5, N1e e1): one group per round NAME within a stage, in play order. Groups are opened walking the fixtures by
 * the stage's seq, then (round_no, seq_in_round), so each lands at its stage's place and its earliest match whatever order the
 * caller passed. `round_no` restarts in every stage: without the stage first, a league's rounds interleaved with the knockout it
 * feeds, and two stages' "Round 1" merged into one group. A stage missing from `stageOrder` sorts after every stage present.
 * `shared` is `sharedRoundNames` over the division's WHOLE list (N1f f2, N1g g1).
 */
export function scheduleRoundGroups<F extends Pick<PublicFixture, "id" | "stage_id" | "round_no" | "seq_in_round">>(
  fixtures: readonly F[],
  a: {
    roundLabels: Record<string, string>;
    stageOrder: Record<string, number>;
    stageNames: Record<string, string>;
    shared: ReadonlySet<string>;
  },
): ScheduleRoundGroup<F>[] {
  const stageRank = (f: F) => a.stageOrder[f.stage_id] ?? Number.POSITIVE_INFINITY;
  const inPlayOrder = [...fixtures].sort(
    (x, y) => stageRank(x) - stageRank(y) || x.round_no - y.round_no || x.seq_in_round - y.seq_in_round,
  );
  const groups = new Map<string, ScheduleRoundGroup<F>>();
  for (const f of inPlayOrder) {
    const name = roundNameOf(f, a.roundLabels);
    const key = JSON.stringify([f.stage_id, name]);
    let g = groups.get(key);
    if (g === undefined) {
      // No name for the stage means nothing to tell them apart WITH, so the round name goes out alone rather than with a
      // dangling separator.
      const stageName = a.shared.has(name) ? a.stageNames[f.stage_id] : undefined;
      g = { key, label: stageName ? `${stageName} · ${name}` : name, stageId: f.stage_id, roundNo: f.round_no, fixtures: [] };
      groups.set(key, g);
    }
    g.fixtures.push(f);
  }
  return [...groups.values()];
}
