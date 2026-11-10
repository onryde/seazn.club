import "server-only";
// W4 app-A Task 13 (K9; rulebook RB4-V1…V5, RB4-E7; rules X-LL-1…X-LL-4): a departed qualifier's main-draw seat takes a
// LUCKY LOSER — the best loser below a knockout source's cut (lib/lucky-loser.ts orders them) — instead of walking the
// opponent over.
//
// Two moments, one pool:
//   - before the main draw is seated (the cut, `timing: "setup"` before its confirm): stage-seeding.ts `sourcesToTables`
//     puts the lucky loser in the departed qualifier's place in the source's table (`luckyLoserCut`), so the proposal
//     offers them in her seat;
//   - after it is seated: the withdrawal cascade (withdrawal.ts) asks `replaceDepartedQualifier` first, which seats the
//     lucky loser in her round-1 line while that line has not started (RB4-V2/V3, X-LE-9's one "started" predicate).
// Inside a round-2 line, after the line started, or with nobody eligible left, nothing happens here and the cascade
// walks the opponent over as it always did (RB4-V1, RB4-V3, RB4-E7).
import type postgres from "postgres";
import type { AuthCtx } from "@/server/api-v1/auth";
import { luckyLoserOrder, luckyLostBy, type LuckyCandidate } from "@/lib/lucky-loser";
import { swissDrawSeed } from "@/lib/swiss-draw";
import { bracketWinnerLoser } from "@/server/engine-db/competition";
import { log } from "@/server/logger";
import { DEPARTED_STATUSES } from "./entrants";
import { fixtureStartedSql } from "./fixture-started-sql";
import { resolveProgressionSource, sourceStandingsTables, type PoolTableRows } from "./stage-seeding";
import { lockSwissBoardAppends } from "./stages";

type Tx = postgres.TransactionSql;

/** The source kinds whose cut a lucky loser fills: a knockout's losers have a round to be ranked by (C2). */
export const LUCKY_LOSER_SOURCE_KINDS: ReadonlySet<string> = new Set(["knockout"]);

/** The width of a knockout source's rank cut: the deepest `rankRange` a destination takes from it, or null (it takes
 *  no ranks — ko_plate's Plate, a `firstLosses` (or a stored `roundLosers`) take). */
export function rankCutOf(take: readonly { kind: string; to?: unknown }[]): number | null {
  const ends = take.filter((t) => t.kind === "rankRange" && typeof t.to === "number").map((t) => t.to as number);
  return ends.length > 0 ? Math.max(...ends) : null;
}

interface LoserLine {
  round_no: number;
  third_place: boolean;
  outcome: unknown;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
}

/**
 * The lucky-loser candidates of a knockout source: every entrant a decided line of the stage knocked out, with the round
 * it happened in (C2), their seed and how they lost — less `qualifiers` (the source's top `cut`). Who has since LEFT is
 * still listed: the order is drawn over the cut's whole pool once, so a second vacancy takes the next of the SAME order
 * (a pool drawn again without the first lucky loser would shuffle differently); the caller skips the departed and the
 * already seated when it picks. A third-place line knocks nobody out; its winner reads half a round above its loser.
 */
export async function luckyLoserPool(tx: Tx, sourceStageId: string, qualifiers: ReadonlySet<string>): Promise<LuckyCandidate[]> {
  const lines = await tx<LoserLine[]>`
    select round_no, coalesce(third_place, false) as third_place, outcome, home_entrant_id, away_entrant_id
      from fixtures where stage_id = ${sourceStageId} and outcome is not null
     order by round_no, seq_in_round, id`;
  const out = new Map<string, Omit<LuckyCandidate, "seed">>();
  const thirdPlaceWinners: string[] = [];
  for (const line of lines) {
    const { winner, loser } = bracketWinnerLoser(line.outcome, line.home_entrant_id, line.away_entrant_id);
    if (line.third_place) {
      if (winner !== undefined) thirdPlaceWinners.push(winner);
      continue;
    }
    if (loser === undefined || out.has(loser)) continue;
    const lostBy = luckyLostBy(line.outcome);
    if (lostBy === null) continue;
    out.set(loser, { id: loser, eliminatedIn: line.round_no, lostBy });
  }
  for (const id of thirdPlaceWinners) {
    const c = out.get(id);
    if (c) out.set(id, { ...c, eliminatedIn: c.eliminatedIn + 0.5 });
  }
  const ids = [...out.keys()].filter((id) => !qualifiers.has(id));
  if (ids.length === 0) return [];
  const entrants = await tx<{ id: string; seed: number | null }[]>`select id, seed from entrants where id in ${tx(ids)}`;
  return entrants.map((e) => ({ ...out.get(e.id)!, seed: e.seed }));
}

/** The top `cut` of the source's final ranks (its placement snapshot, RB4-V4) — the qualifiers the cut named. */
export function qualifiersOfCut(pools: readonly PoolTableRows[], cut: number): Set<string> {
  return new Set(
    pools.flatMap((p) =>
      [...p.rows]
        .sort((a, b) => (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER))
        .slice(0, cut)
        .map((r) => r.entrantId),
    ),
  );
}

interface SeatRow {
  id: string;
  stage_id: string;
  division_id: string;
  seq: number;
  progression: { sources?: { stage: unknown; take?: { kind: string; to?: unknown }[] }[] } | null;
  config: Record<string, unknown>;
}

/**
 * RB4-V2: `entrantId` is leaving. If they hold a seat in round 1 of a knockout fed by a knockout source's rank cut and
 * that line has not started (`fixtureStartedSql`: a score, live play, a result or a Match Day call — X-LE-9), the best
 * eligible loser of the source (`luckyLoserOrder` with the DESTINATION's draw seed, RB4-V5) takes the seat, and a stored
 * `config.qualified` names them in her place. Null when there is no such seat, the line has started, or nobody is
 * eligible (RB4-V3, RB4-E7): the caller walks the opponent over. The caller's transaction; this takes the division lock
 * and then the line's append lock (the house order, `division:` → `fixture:`).
 */
export async function replaceDepartedQualifier(
  tx: Tx,
  auth: AuthCtx,
  entrantId: string,
): Promise<{ replacedBy: string; fixtureId: string } | null> {
  const seats = await tx<SeatRow[]>`
    select f.id, f.stage_id, s.division_id, s.seq, s.progression, s.config
      from fixtures f join stages s on s.id = f.stage_id
     where (f.home_entrant_id = ${entrantId} or f.away_entrant_id = ${entrantId})
       and f.round_no = 1 and s.kind = 'knockout' and s.progression is not null
     order by s.seq, f.id`;
  for (const seat of seats) {
    const source = await knockoutRankSource(tx, seat);
    if (source === null) continue;
    await tx`select pg_advisory_xact_lock(hashtext(${"division:" + seat.division_id}))`;
    await lockSwissBoardAppends(tx, [seat.id]);
    const [line] = await tx<{ side: "home" | "away" | null; started: boolean }[]>`
      select case when f.home_entrant_id = ${entrantId} then 'home'
                  when f.away_entrant_id = ${entrantId} then 'away' end as side,
             ${fixtureStartedSql(tx, "f")} as started
        from fixtures f where f.id = ${seat.id}`;
    if (!line || line.side === null || line.started) return null;
    // The cut's whole pool in lucky-loser order (the destination's draw), then the first who is still in the field and
    // holds no seat of the destination yet (an earlier lucky loser does), never the entrant leaving.
    const order = luckyLoserOrder(
      await luckyLoserPool(tx, source.id, qualifiersOfCut(await sourceStandingsTables(tx, { id: source.id }), source.cut)),
      swissDrawSeed(seat.stage_id),
    );
    if (order.length === 0) return null;
    const blocked = await tx<{ id: string }[]>`
      select e.id from entrants e
       where e.id in ${tx(order)}
         and (e.status in ${tx([...DEPARTED_STATUSES])}
              or exists (select 1 from fixtures f where f.stage_id = ${seat.stage_id}
                           and e.id in (f.home_entrant_id, f.away_entrant_id)))`;
    const skip = new Set([entrantId, ...blocked.map((b) => b.id)]);
    const lucky = order.find((id) => !skip.has(id));
    if (lucky === undefined) return null;
    const [moved] = line.side === "home"
      ? await tx<{ id: string }[]>`update fixtures set home_entrant_id = ${lucky}
            where id = ${seat.id} and home_entrant_id = ${entrantId} and status = 'scheduled' and outcome is null returning id`
      : await tx<{ id: string }[]>`update fixtures set away_entrant_id = ${lucky}
            where id = ${seat.id} and away_entrant_id = ${entrantId} and status = 'scheduled' and outcome is null returning id`;
    if (!moved) return null;
    if (Array.isArray(seat.config.qualified)) {
      const qualified = (seat.config.qualified as unknown[]).map((id) => (id === entrantId ? lucky : id));
      await tx`update stages set config = config || ${tx.json({ qualified } as never)} where id = ${seat.stage_id}`;
    }
    log.info(
      { event: "lucky_loser_seated", orgId: auth.orgId, stageId: seat.stage_id, fixtureId: seat.id, departed: entrantId, luckyLoser: lucky },
      "lucky_loser_seated",
    );
    return { replacedBy: lucky, fixtureId: seat.id };
  }
  return null;
}

/** The knockout source whose rank cut seats `seat`'s stage (RB4-Q1) and the cut's width, or null — a table source (RB4-V6
 *  is the cut's, `cutEligiblePools`), a `firstLosses`/`roundLosers` take (the Plate), or a source that no longer resolves. */
async function knockoutRankSource(tx: Tx, seat: SeatRow): Promise<{ id: string; cut: number } | null> {
  for (const s of seat.progression?.sources ?? []) {
    const cut = rankCutOf(s.take ?? []);
    if (cut === null) continue;
    try {
      const source = await resolveProgressionSource(tx, { division_id: seat.division_id, seq: seat.seq }, s.stage as never);
      if (LUCKY_LOSER_SOURCE_KINDS.has(source.kind)) return { id: source.id, cut };
    } catch {
      // A source that no longer resolves feeds nobody.
    }
  }
  return null;
}
