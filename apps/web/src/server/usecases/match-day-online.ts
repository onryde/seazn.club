import "server-only";
// Match Day's online chess rounds (spec docs/superpowers/specs/2026-11-05-match-day-all-in-one-design.md section 4 and 5.2): the producer of
// `MatchDayView.online_rounds`, one row per (division, stage, round) the page shows. Read only.
//
// THE ROW SOURCE has two parts, so a round in play is never dropped for want of a view:
//   (a) per STAGE of an online division, its LATEST opened round (`roundOpensOfDivisions`: one statement for every online division of the
//       competition, the highest round of each stage taken in memory), read whole through the arbiter's own loader
//       (`loadArbiterRound`, flags counted): a row with `round` set, `view` the open-round reader's view of the same round (null when
//       the reader has none - an opened round whose windows closed), phase checkin or playing. An earlier opened round of the stage is
//       never a row: its held or flagged boards reach the page through `needs_decision` only.
//   (b) every `listOpenRounds` view still `paired` that is not (a)'s round: a row with `round` null, phase `before`.
//   A division that has not started is one row, `not_started`, on its first stage (its panel says to start it first).
// An (a) row is listed only while it is still the DAY'S, judged in memory from what this read already holds: it was opened inside its
// division's day (`divisionDays`: the venue zone, else the organisation's, else UTC), or a check-in window is open, or a board is starting
// or live, or the division holds any held or flagged board. A round over for days drops off.
//
// `needs_decision` (owner O2, 2026-11-17): `listNeedsOrganiserExternalPlay` and `listFlaggedExternalPlay` are THE source of held and flagged
// boards - for the division page's queue and for this read. No query of `fixture_external_play` or `fixture_play_flags` for "held" or
// "flagged" is written here (online-queue-one-source.test.ts reads this file and the page and refuses one). They give the ids; the boards are
// built by `loadBoardsByIds`, the arbiter's own composition (presence, camera and `joinable` ride every board - MD-R1). A cancelled board
// reaches the list only while it has an open flag (owner O1): the flagged lister's rule, and `loadBoardsByIds` holds the same line.
// Every held board carries WHY it is held (`hold_reason`, MD-R6/R8), in `round.boards` and in `needs_decision` alike, from the held
// lister's own reason - never a second read of the bridge row - and only on a board whose own state is `on_hold`; any other board carries null.
//
// Sealed tables (stage_round_opens, the bridge and the flags) are read on the module `sql` client, after the caller's competition
// auth, and never inside a tenant transaction: `getMatchDay` calls this beside its other reads, not within `withTenant`.
import { withTenant, sql } from "@/lib/db";
import { divisionScoringClosed } from "@/lib/division-phase";
import { openWindowBoards } from "@/lib/round-column";
import { latestOpenedRoundNos, onlineRoundKey, onlineRoundPhase } from "@/lib/match-day/online";
import type { MatchDayOnlineRound } from "@/lib/match-day/types";
import type { ArbiterBoard, ArbiterRound } from "@/lib/arbiter-view";
import type { OpenRoundView } from "@/lib/open-round";
import { resolveVenueTz } from "@/lib/tz";
import { log } from "@/server/logger";
import type { AuthCtx } from "@/server/api-v1/auth";
import { divisionPlaysOnline } from "@/server/external-play/online-play";
import { roundOpensOfDivisions } from "@/server/external-play/round-open";
import type { NeedsReason } from "@/server/external-play/types";
import { divisionDays, type DivisionDay } from "./match-day-call";
import { listDivisions, type DivisionRow } from "./divisions";
import { listFlaggedExternalPlay, loadArbiterRound, loadBoardsByIds } from "./external-play/arbiter";
import { onlineChessOffered } from "./external-play/online-chess-flag";
import { listOpenRounds } from "./external-play/open-round-view";
import { listNeedsOrganiserExternalPlay } from "./external-play/queue";

type StageRow = { id: string; division_id: string; name: string; seq: number };

/** The competition's online chess rounds, after the courts in the list (`MatchDayView.online_rounds`): divisions in competition order, and
 *  inside a division its stages and rounds in play order. Empty when the competition has no online division. */
export async function readOnlineRounds(
  auth: AuthCtx,
  competitionId: string,
  now: Date,
  /** The competition's live divisions when the caller already reads them (`getMatchDay` does, beside this): one list per poll, not two. */
  listed?: Promise<readonly DivisionRow[]> | readonly DivisionRow[],
): Promise<MatchDayOnlineRound[]> {
  const divisions = (await (listed ?? listDivisions(auth, competitionId))).filter((d) => divisionPlaysOnline(d));
  if (divisions.length === 0) return [];
  // The club's answer, once for the whole competition (a remote call kept 60 s, `onlineChessOffered`).
  const offered = await onlineChessOffered(auth);
  const ids = divisions.map((d) => d.id);
  const { days, tzs, stages } = await withTenant(auth.orgId, async (tx) => {
    const [org] = await tx<{ timezone: string | null }[]>`select timezone from organizations where id = ${auth.orgId}`;
    const orgTz = org?.timezone ?? null;
    const days = await divisionDays(tx, orgTz, now, tx`d.id = any(${ids}::uuid[])`);
    const settings = await tx<{ division_id: string; tz: string | null }[]>`
      select division_id, tz from schedule_settings where division_id = any(${ids}::uuid[])`;
    const tzs = new Map(divisions.map((d) => [d.id, resolveVenueTz(settings.find((s) => s.division_id === d.id)?.tz ?? null, orgTz)]));
    const stages = await tx<StageRow[]>`
      select id, division_id, name, seq from stages where division_id = any(${ids}::uuid[]) order by division_id, seq, id`;
    return { days: new Map(days.map((x) => [x.division_id, x])), tzs, stages };
  });
  // The sealed read, once for every online division: which (stage, round) have been opened, and when.
  const opens = await roundOpensOfDivisions(sql, ids);
  const perDivision = await Promise.all(
    divisions.map((d) =>
      rowsOfDivision(auth, d, {
        now,
        offered,
        tz: tzs.get(d.id)!,
        day: days.get(d.id)!,
        stages: stages.filter((s) => s.division_id === d.id),
        opens,
      }),
    ),
  );
  return perDivision.flat();
}

type DivisionCtx = {
  now: Date;
  offered: boolean;
  tz: string;
  day: DivisionDay;
  stages: readonly StageRow[];
  opens: Awaited<ReturnType<typeof roundOpensOfDivisions>>;
};

/** The latest opened round of each of the division's stages (stage order), from the one read of every open. "Latest" is
 *  `latestOpenedRoundNos`' word, the very one the competition desk's re-open asks (MD-R22): a round it names is a row listed here. */
function latestOpened(ctx: DivisionCtx): { stage: StageRow; roundNo: number; openedAt: Date }[] {
  const latest = latestOpenedRoundNos(ctx.opens.keys());
  const out: { stage: StageRow; roundNo: number; openedAt: Date }[] = [];
  for (const stage of ctx.stages) {
    const roundNo = latest.get(stage.id);
    if (roundNo === undefined) continue;
    // The round number was read out of `ctx.opens`' own keys, and `parseOnlineRoundKey` is `onlineRoundKey`'s pinned inverse: its open is there.
    out.push({ stage, roundNo, openedAt: ctx.opens.get(onlineRoundKey(stage.id, roundNo))!.roundOpenedAt });
  }
  return out;
}

async function rowsOfDivision(auth: AuthCtx, d: DivisionRow, ctx: DivisionCtx): Promise<MatchDayOnlineRound[]> {
  const common = { division_id: d.id, division_name: d.name, division_slug: d.slug, offered: ctx.offered, tz: ctx.tz };
  if (divisionScoringClosed(d.status)) {
    // Not started: nothing is paired to open yet. The first stage names the row; a division with no stage has nothing to name.
    const first = ctx.stages[0];
    if (first === undefined) return [];
    return [{ ...common, ...rowShell(first, 1), multi_stage: false, phase: "not_started", view: null, round: null, needs_decision: [], own_boards: 0 }];
  }

  // O2: the held and flagged boards come from the two listers, read beside the rest.
  const latest = latestOpened(ctx);
  const [views, held, flagged, rounds] = await Promise.all([
    listOpenRounds(auth, d.id, { now: ctx.now }),
    listNeedsOrganiserExternalPlay(auth, d.id),
    listFlaggedExternalPlay(auth, d.id),
    Promise.all(latest.map((l) => loadArbiterRound(auth, d.id, { round: { stageId: l.stage.id, roundNo: l.roundNo }, now: ctx.now, flags: "count" }))),
  ]);
  const reasonOf = new Map<string, NeedsReason>(held.map((h) => [h.fixtureId, h.reason]));
  const heldOpen = held.filter((h) => !h.seated);
  const decisionIds = new Set([...heldOpen.map((h) => h.fixtureId), ...flagged.boards.map((b) => b.fixtureId)]);
  const nowMs = ctx.now.getTime();

  // (a): each stage's latest opened round, while it is the day's.
  type Opened = { stage: StageRow; roundNo: number; round: ArbiterRound; view: OpenRoundView | null };
  const opened: Opened[] = [];
  latest.forEach((l, i) => {
    const round = rounds[i];
    if (round === null || round === undefined) return;
    const view = views.find((v) => v.stageId === l.stage.id && v.roundNo === l.roundNo) ?? null;
    const today = l.openedAt.getTime() >= ctx.day.from.getTime() && l.openedAt.getTime() < ctx.day.to.getTime();
    const moving = openWindowBoards(round.boards, nowMs).length > 0 || round.boards.some((b) => b.state.kind === "starting" || b.state.kind === "live");
    if (today || moving || decisionIds.size > 0) opened.push({ stage: l.stage, roundNo: l.roundNo, round, view });
  });
  const inRound = new Set(rounds.flatMap((r) => (r === null ? [] : r.boards.map((b) => b.fixtureId))));
  const openedKeys = new Set(latest.map((l) => onlineRoundKey(l.stage.id, l.roundNo)));

  const rows: { stage: StageRow; roundNo: number; row: MatchDayOnlineRound }[] = opened.map((o) => ({
    stage: o.stage,
    roundNo: o.roundNo,
    row: {
      ...common,
      ...rowShell(o.stage, o.roundNo),
      multi_stage: false,
      phase: onlineRoundPhase({ view: o.view, round: o.round, phase: "playing" }, null),
      view: o.view,
      round: { ...o.round, boards: o.round.boards.map((b) => stamped(b, reasonOf)) },
      needs_decision: [],
      own_boards: o.round.ownBoards,
    },
  }));
  // (b): a paired round not opened yet. A view in state `open` is (a)'s round or nothing.
  for (const v of views) {
    if (v.state !== "paired" || openedKeys.has(onlineRoundKey(v.stageId, v.roundNo))) continue;
    const stage = ctx.stages.find((s) => s.id === v.stageId);
    if (stage === undefined) continue;
    rows.push({
      stage,
      roundNo: v.roundNo,
      row: { ...common, ...rowShell(stage, v.roundNo), multi_stage: false, phase: "before", view: v, round: null, needs_decision: [], own_boards: 0 },
    });
  }
  rows.sort((a, b) => a.stage.seq - b.stage.seq || a.roundNo - b.roundNo);
  const out = rows.map((r) => r.row);

  // The held and flagged boards the rounds above do not hold, on the division's first row (the page lists them once).
  const first = out[0];
  if (first === undefined) {
    // Held or flagged boards with no round row to hang them on: no product writer makes a held board without opening its round, so
    // this is a board the page cannot place. Said, not shown under a made-up round.
    if (decisionIds.size > 0) {
      log.warn({ divisionId: d.id, fixtureIds: [...decisionIds] }, "match-day: held or flagged online boards with no round row to list them under; left out");
    }
  } else {
    first.needs_decision = (await loadBoardsByIds(auth, d.id, [...decisionIds].filter((id) => !inRound.has(id)), { now: ctx.now, flags: "count" })).map((b) =>
      stamped(b, reasonOf),
    );
    // The viewer's own boards no list shows: the listed round's (the loader's count, in its own row) and the held boards of earlier rounds
    // the viewer plays on. A board that is only FLAGGED in an earlier round and the viewer's own is in no count and in no list: the flagged
    // list gives a count, not ids, and a count cannot be told from the listed round's own boards. A round is told apart by its stage's ID
    // (names are not unique), the way `key` spells it.
    const roundsOwn = new Set(rounds.flatMap((r, i) => (r === null ? [] : [onlineRoundKey(latest[i]!.stage.id, latest[i]!.roundNo)])));
    first.own_boards += held.filter((h) => h.seated && (h.roundNo === null || !roundsOwn.has(onlineRoundKey(h.stageId, h.roundNo)))).length;
  }
  const multi = out.length > 1;
  return out.map((r) => ({ ...r, multi_stage: multi }));
}

const rowShell = (stage: StageRow, roundNo: number) => ({
  key: onlineRoundKey(stage.id, roundNo),
  stage_id: stage.id,
  stage_name: stage.name,
  round_no: roundNo,
});

/** A board of either list with its hold reason: the held lister's own word for a board that IS on hold, null for any other. The lister
 *  and the board are read a moment apart, so a hold settled in between would otherwise carry a reason on a board that reads live: the
 *  stamp follows the board's own state (`on_hold`), and the reason is the lister's word for why. */
function stamped<B extends ArbiterBoard>(b: B, reasonOf: ReadonlyMap<string, NeedsReason>): B & { hold_reason: NeedsReason | null } {
  return { ...b, hold_reason: b.state.kind === "on_hold" ? (reasonOf.get(b.fixtureId) ?? null) : null };
}

