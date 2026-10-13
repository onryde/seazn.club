import "server-only";
// WHO APPEARED IN A MATCH — the one rule behind a person's career match count (`careerMatchesByDivision`, which the
// career listing cards from) and the public player page's match lines (`readPlayerMatchSeeds`, then
// `composePlayerMatchLines`). W2b ruling 122 (owner "B", 2026-10-12) and its round-1 review: the two readers had each
// written the rule out, and had already drifted (the lines read a sheet for every entrant kind, the count for teams
// only; the count credited a bench row the lines dropped).
//
// THE RULE, per fixture, for one person — two halves, both here:
//  1. Relational (`appearanceSide`, SQL): the ONE side of the fixture the person stands on, or none.
//     - A sheet (`lineups`) row with `role = 'player'` on a side of the fixture. A coach or staff row never counts
//       (`core/lineup.ts` `SquadRole`).
//     - A TEAM side's roster stands in only where that side recorded no sheet for the fixture — a squad member the
//       sheet leaves out did not play — and only for members registered in the PLAYER lane (`persons.lane`, V356):
//       the roster row itself carries no player/coach role (`entrant_members.roles` is the sport's position-catalog
//       roles: captain, wicketkeeper). A player added after the fixture is credited with it, and one removed from the
//       roster is not: the roster stores no dates (ruling 122's accepted residue).
//     - An individual or pair side's roster always stands in, whatever its lane or any sheet says ("individual-entrant
//       sports are unchanged").
//     - Someone placed on both sides is read once, by precedence: a sheet's starting row, then a roster stand-in, then
//       a sheet's bench row; home before away.
//  2. The bench (`rowIsAppearance`): a bench row is a match played only by the owner's bench rule
//     (`benchRowIsAppearance`, 2026-09-16) — the cricket fold shows the person batted or bowled. The figures come from
//     the one fold both readers run (`foldFixtureFigures`): the lines through their per-fixture cache, the count
//     uncached inside the caller's transaction.
// Which of those matches were PLAYED at all (a walkover, an empty abandon) is the engine's, asked afterwards by both
// readers through `fixturesPlayedInStats`.
import type postgres from "postgres";
import {
  EngineError,
  resolveVoids,
  type EventEnvelope,
  type Lineup,
  type LineupPair,
  type LineupSlot,
} from "@seazn/engine/core";
import { deriveCricketScorecard, type CricketCfg, type CricketScorecard } from "@seazn/engine/sports/cricket";
import { loadFoldInputs } from "@/server/engine-db/fold";
import { log } from "@/server/logger";

/** Pooled `sql` or an open transaction (`postgres.TransactionSql` and `Sql` share `ISql`). */
type Queryable = postgres.ISql;

/** Run `fn` in a transaction of its own: a savepoint inside the caller's transaction, else a fresh transaction. */
async function ownTransaction<T>(db: Queryable, fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  const open = db as Partial<Pick<postgres.TransactionSql, "savepoint">>;
  if (typeof open.savepoint === "function") return (await open.savepoint(fn)) as T;
  return (await (db as postgres.Sql).begin(fn)) as T;
}

/**
 * The relational half of the rule, as the body of a LATERAL subquery: the one side of fixture `f` that person `p`
 * appeared on (`entrant_id`, and `slot` — the sheet's slot, null for a roster stand-in), or no row. The caller binds
 * `f` (a fixture row: `id`, `home_entrant_id`, `away_entrant_id`) and `p` (a `persons` row: `id`, `lane`) and joins
 * `lateral (${appearanceSide(q)}) mine on true`.
 */
export function appearanceSide(q: Queryable) {
  return q`
    select l.entrant_id, l.slot, case when l.slot = 'bench' then 2 else 0 end as precedence,
           l.entrant_id = f.home_entrant_id as is_home
    from lineups l
    where l.fixture_id = f.id and l.person_id = p.id and l.role = 'player'
      and l.entrant_id in (f.home_entrant_id, f.away_entrant_id)
    union all
    select em.entrant_id, null::text, 1, em.entrant_id = f.home_entrant_id
    from entrant_members em
    join entrants re on re.id = em.entrant_id
    where em.person_id = p.id
      and em.entrant_id in (f.home_entrant_id, f.away_entrant_id)
      and (re.kind <> 'team'
        or (p.lane = 'player'
          and not exists (select 1 from lineups dl where dl.fixture_id = f.id and dl.entrant_id = em.entrant_id)))
    order by precedence, is_home desc
    limit 1`;
}

/** One person's match figures. Present in a fixture's map only for someone who
 *  batted or bowled in a main innings. */
export interface PersonFigures {
  batting: { runs: number; balls: number } | null;
  bowling: { wickets: number; runs: number } | null;
}

/** Every figure-bearing person in one fixture, keyed by person id. A plain
 *  object, not a Map: `unstable_cache` serialises its value, and a Map crosses
 *  that boundary as `{}`. */
export type FixtureFigures = Record<string, PersonFigures>;

/**
 * Is a BENCH row an appearance?
 *
 * OWNER RULING, 2026-09-16: a bench row counts only when the cricket fold shows
 * the person batted or bowled; a coach or staff row never counts (that half is
 * the `l.role = 'player'` filter in `appearanceSide`). The whole bench
 * policy lives in this one function. In cricket, figures mean a replacement or
 * a community sub rule brought the player properly on (Law 24 lets an ordinary
 * substitute field only); a bench player with no figures sat it out. Other
 * sports record no per-person figures, so nothing shows a bench
 * player came on — they are left out. A starting row and a roster stand-in are
 * never asked.
 *
 * Only a lineup event brings a bench player on. The scorecard fold reads the
 * kernel's `core.lineup.*` events (fix/cricket-scorecard-core-events), so a
 * bench player who came on and batted or bowled has figures and is listed
 * (the "BENCH (cricket): a bench player who came on and bowled" test).
 *
 * The `sportKey` test is belt-and-braces TODAY: no other sport produces
 * `figures`, so it changes no answer until one does.
 */
export function benchRowIsAppearance(sportKey: string, figures: PersonFigures | undefined): boolean {
  return sportKey === "cricket" && figures !== undefined;
}

/** The sports whose fold yields per-person figures the bench rule reads. Both readers fold only these. */
export function sportHasFigures(sportKey: string): boolean {
  return sportKey === "cricket";
}

/** The bench half of the rule: is this appearance row a match the person played? A sheet's starting row and a
 *  roster stand-in always are; a bench row by `benchRowIsAppearance`. */
export function rowIsAppearance(row: { slot: string | null; sportKey: string }, figures: PersonFigures | undefined): boolean {
  return row.slot !== "bench" || benchRowIsAppearance(row.sportKey, figures);
}

/** The person and everyone merged into them — the ids their figures may be recorded under, the person first. A merge
 *  flattens inbound tombstones onto the new survivor, so one hop is the invariant; the bounded walk is the belt to
 *  that, the same belt `player-stats.ts`'s `liveSurvivor` wears. */
export async function figurePeople(db: Queryable, personId: string): Promise<string[]> {
  const absorbed = await db<{ id: string }[]>`
    with recursive absorbed(id, depth) as (
      select id, 1 from persons where merged_into = ${personId}
      union all
      select p.id, a.depth + 1 from persons p join absorbed a on p.merged_into = a.id where a.depth < 16
    )
    select distinct id from absorbed`;
  return [personId, ...absorbed.map((row) => row.id)];
}

/** One appearance row the count found: the fixture, the sheet slot (null for a roster stand-in), its sport, and the
 *  person the row is about. */
export interface AppearanceRow {
  fixtureId: string;
  slot: string | null;
  sportKey: string;
  personId: string;
}

/**
 * The fixtures the count's rows are appearances in, by `rowIsAppearance` — the career count's half of the bench rule.
 * A bench row of a sport with figures is folded here (`foldFixtureFigures`, uncached: the count runs inside the
 * caller's transaction, or inside the public card's own cache entry); a fixture that cannot be folded gives no
 * figures, so its bench row is no appearance — the lines' answer for a fixture the engine refuses (a database error,
 * which the lines throw uncached, is logged here and drops the bench row from this count only).
 */
export async function appearedFixtureIds(db: Queryable, rows: readonly AppearanceRow[]): Promise<Set<string>> {
  const appeared = new Set<string>();
  const folds = new Map<string, FixtureFigures | null>();
  for (const row of rows) {
    if (appeared.has(row.fixtureId)) continue;
    let figures: PersonFigures | undefined;
    if (row.slot === "bench" && sportHasFigures(row.sportKey)) {
      if (!folds.has(row.fixtureId)) {
        folds.set(
          row.fixtureId,
          await foldFixtureFigures(db, row.fixtureId).catch((err: unknown) => {
            log.warn(
              { fixtureId: row.fixtureId, err: err instanceof Error ? err.message : String(err) },
              "career count: could not fold a bench player's fixture, the bench row is no appearance this time",
            );
            return null;
          }),
        );
      }
      figures = figuresFor(folds.get(row.fixtureId)!, await figurePeople(db, row.personId));
    }
    if (rowIsAppearance(row, figures)) appeared.add(row.fixtureId);
  }
  return appeared;
}

/**
 * Every person's match figures off a scorecard the engine folded, summed over
 * every MAIN innings — so a two-innings match reads as the match's figures
 * rather than the first innings alone. Super-over innings are left out: a super
 * over is a tiebreak and its runs and wickets are not part of a player's match
 * figures. `isSuperOver` is the fold's own flag.
 */
export function figuresByPerson(card: CricketScorecard): FixtureFigures {
  // No prototype: a key is a person id and nothing else.
  const figures: FixtureFigures = Object.create(null);
  const of = (person: string): PersonFigures => (figures[person] ??= { batting: null, bowling: null });
  for (const innings of card.innings) {
    if (innings.isSuperOver) continue;
    for (const line of innings.batting) {
      const mine = of(line.person);
      mine.batting = { runs: (mine.batting?.runs ?? 0) + line.runs, balls: (mine.batting?.balls ?? 0) + line.balls };
    }
    for (const line of innings.bowling) {
      const mine = of(line.person);
      mine.bowling = {
        wickets: (mine.bowling?.wickets ?? 0) + line.wickets,
        runs: (mine.bowling?.runs ?? 0) + line.runs,
      };
    }
  }
  return figures;
}

/** The same person's figures under several ids (a survivor and everyone merged
 *  into them), summed. Undefined when none of the ids batted or bowled. */
export function figuresFor(all: FixtureFigures | null, people: readonly string[]): PersonFigures | undefined {
  if (all === null) return undefined;
  let sum: PersonFigures | undefined;
  for (const id of people) {
    if (!Object.hasOwn(all, id)) continue;
    const { batting, bowling } = all[id]!;
    const acc: PersonFigures = sum ?? { batting: null, bowling: null };
    if (batting) {
      acc.batting = { runs: (acc.batting?.runs ?? 0) + batting.runs, balls: (acc.batting?.balls ?? 0) + batting.balls };
    }
    if (bowling) {
      acc.bowling = {
        wickets: (acc.bowling?.wickets ?? 0) + bowling.wickets,
        runs: (acc.bowling?.runs ?? 0) + bowling.runs,
      };
    }
    sum = acc;
  }
  return sum;
}

/** A refusal FROM THE FOLD — the engine judged the config or the ledger. Zod is
 *  matched by name: the engine's schemas may come from another zod copy. */
function isFoldRefusal(err: unknown): boolean {
  return EngineError.is(err) || (err instanceof Error && err.name === "ZodError");
}

/**
 * The engine's scorecard for one fixture, reduced to per-person figures. The
 * config MUST be parsed — `loadFoldInputs` carries it raw, and the scorecard
 * fold throws on the raw value. The scorecard fold resolves voids itself now
 * (it rides `foldMatch`, which calls `resolveVoids`), and `resolveVoids` is
 * idempotent, so resolving the ledger first here is free; it stays so this
 * read and `loadMatchCentre` fold one stream. Its own transaction, opened and
 * closed here (a savepoint when the caller already holds one — the career count
 * runs inside `withTenant`): a statement Postgres refuses aborts this fixture's
 * transaction and no other's.
 *
 * Only the pure half sits inside the refusal guard. Everything that reads the
 * database — including `loadFoldInputs`' own refusals of a fixture it cannot
 * load (a missing entrant, an unknown module) — stays outside it and throws
 * uncached, as `admin-fixture-config.ts` treats the same failures.
 */
export async function foldFixtureFigures(db: Queryable, fixtureId: string): Promise<FixtureFigures | null> {
  return (await ownTransaction(db, async (tx) => {
    const inputs = await loadFoldInputs(tx, fixtureId);
    if (inputs === null) return null;
    const { lineups, unresolved } = await asRecorded(tx, inputs.lineups, inputs.envelopes);
    try {
      const cfg = inputs.module.configSchema.parse(inputs.cfg) as CricketCfg;
      return figuresByPerson(deriveCricketScorecard({ events: resolveVoids(inputs.envelopes), cfg, lineups }));
    } catch (err) {
      // A refusal is cached as no figures — but not while the ledger names a
      // merged person this read could not seat: that refusal is this reader's
      // gap, not the fixture's, and is thrown (uncached) to be tried again.
      if (!isFoldRefusal(err) || unresolved.length > 0) throw err;
      log.warn(
        { fixtureId, err: err instanceof Error ? err.message : String(err) },
        "player matches: the engine refused this cricket fixture's config or ledger, cached as no figures",
      );
      return null;
    }
  })) as FixtureFigures | null;
}

/**
 * The lineup pair as the LEDGER knows it.
 *
 * A merge repoints a lineup row to the survivor — and, where both people were
 * on the same sheet, DELETES the absorbed person's row — while every recorded
 * event keeps naming the id it was recorded under. Folding the repointed sheet
 * would refuse the first ball an absorbed id faced or bowled. So every merged
 * id the ledger names gets a slot of its own on its survivor's side:
 *  - the survivor's slot stays the survivor's when the ledger names the
 *    survivor too; otherwise the first absorbed id takes it over;
 *  - each further id is APPENDED to that side (next `orderNo`, same slot kind
 *    and role), so no other player's place in the batting order moves.
 * The figures come out keyed by each recorded id, and the read-time merge in
 * `completePlayerMatchLines` sums them for the survivor.
 *
 * `unresolved`: merged ids the ledger names whose survivor is on neither sheet
 * — nothing to seat them beside. A refusal with any of those is not cached.
 */
const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

async function asRecorded(
  tx: postgres.TransactionSql,
  lineups: LineupPair,
  envelopes: readonly EventEnvelope[],
): Promise<{ lineups: LineupPair; unresolved: string[] }> {
  const recorded = JSON.stringify(envelopes.map((envelope) => envelope.payload));
  const named = [...new Set((recorded.match(UUID_PATTERN) ?? []).map((id) => id.toLowerCase()))];
  if (named.length === 0) return { lineups, unresolved: [] };
  const merged = await tx<{ id: string; merged_into: string }[]>`
    select id, merged_into from persons where id in ${tx(named)} and merged_into is not null`;
  if (merged.length === 0) return { lineups, unresolved: [] };

  const absorbedBySurvivor = new Map<string, string[]>();
  for (const { id, merged_into } of merged) {
    absorbedBySurvivor.set(merged_into, [...(absorbedBySurvivor.get(merged_into) ?? []), id]);
  }
  const seated = new Set<string>();
  const seat = (lineup: Lineup): Lineup => {
    let lastOrderNo = Math.max(0, ...lineup.slots.map((slot) => slot.orderNo));
    const slots: LineupSlot[] = [];
    const appended: LineupSlot[] = [];
    for (const slot of lineup.slots) {
      const absorbed = (absorbedBySurvivor.get(slot.personId) ?? []).filter((id) => !seated.has(id));
      if (absorbed.length === 0) {
        slots.push(slot);
        continue;
      }
      for (const id of absorbed) seated.add(id);
      const ids = named.includes(slot.personId) ? [slot.personId, ...absorbed] : absorbed;
      slots.push({ ...slot, personId: ids[0]! });
      for (const id of ids.slice(1)) {
        lastOrderNo += 1;
        appended.push({ personId: id, slot: slot.slot, orderNo: lastOrderNo, ...(slot.role ? { role: slot.role } : {}) });
      }
    }
    return { ...lineup, slots: [...slots, ...appended] };
  };
  return {
    lineups: { home: seat(lineups.home), away: seat(lineups.away) },
    unresolved: merged.map((row) => row.id).filter((id) => !seated.has(id)),
  };
}
