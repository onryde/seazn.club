import "server-only";
// TBD-shape generation for a `timing: "setup"` progression (day-one fixtures).

import { randomUUID } from "node:crypto";
import { withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { EngineError } from "@seazn/engine/core";
import type { ProgressionSpec, SourceShape } from "@seazn/engine/competition";
import { pinStageTableRules } from "@/server/engine-db/table-rules";
import { BYE_SLOT_LABEL } from "@/lib/bye-line";
import type { AuthCtx } from "@/server/api-v1/auth";
import { courtNamesById } from "../schedule";
import { descriptorLabel, expandSources, placeDescriptors, resolveProgressionSource, sourceShapeOf, type SlotDescriptor, type SlotLabel } from "../stage-seeding";
import {
  STAGE_COLS,
  type Tx,
  type StageRow,
  type FixtureRow,
  type GenFixture,
  type ActiveEntrant,
  type GenerateWrite,
} from "./types";
import { POOL_KEYS, poolCount, generate } from "./generators";

// ---------------------------------------------------------------------------
// D4a (P5) / F2 — TBD-shape generation for a `timing: "setup"` progression.
// Runs at division setup time, independent of the source stage's
// completion; count/shape derive purely from the progression's take rules
// (@seazn/engine/competition). See generateStageFixtures'
// `timing === "setup"` short-circuit above.
// ---------------------------------------------------------------------------

// Persisted labels carry an internal `seed` alongside the rendered
// {key, params} — destinationSlotsBySeed() (read by both computeSeedProposal
// and confirmSeedProposal) is the only reader; renderers destructure
// {key, params} and ignore it (see the design's "Renderers receive
// {key, params}" — this is bookkeeping, not wire contract).
type StoredSlotLabel = SlotLabel & { seed: number };

type SeededGenFixture = GenFixture & {
  homeLabel?: StoredSlotLabel;
  awayLabel?: StoredSlotLabel;
  awardLabel?: StoredSlotLabel;
};

/** "slot:7" -> 7 — the synthetic entrant id generateProgressionSetupFixtures
 *  mints for placement seat i (1-based), and the only place that format is parsed. */
function seedOfSlotId(id: string): number {
  return Number(id.slice("slot:".length));
}

// F2 — the source-resolution/shape/validation helpers this file used to
// define privately now live in stage-seeding.ts (resolveProgressionSource,
// sourceShapeOf, validateStageProgression), imported at the top of this
// file, so createStages/replaceStages/templates.ts's instantiateTemplate
// share ONE implementation instead of two.

export async function generateProgressionSetupFixtures(auth: AuthCtx, stageId: string): Promise<GenerateWrite> {
  return withTenant(auth.orgId, (tx) => writeProgressionSetupFixtures(tx, stageId));
}

/** The body of a `timing: "setup"` Generate, in the caller's transaction. Idempotent over the rows it finds (keyed by
 *  `ext_key`), so an un-fill runs it to put a line's labels back (fed-seats.ts `unfillProposalSeats`, W4 T14). */
export async function writeProgressionSetupFixtures(tx: Tx, stageId: string): Promise<GenerateWrite> {
  const [stage] = await tx<StageRow[]>`
    select ${tx(STAGE_COLS)} from stages where id = ${stageId}`;
  if (!stage) throw new HttpError(404, "stage not found");
  await tx`select pg_advisory_xact_lock(hashtext(${"division:" + stage.division_id}))`;
  // `timing` is read by the CALLER (generateStageFixtures' pre-check) —
  // this function only ever runs for timing === "setup", so it is not
  // needed again here.
  const progression = stage.progression as unknown as ProgressionSpec;

  const shapes: SourceShape[] = [];
  for (const s of progression.sources) {
    const source = await resolveProgressionSource(tx, stage, s.stage);
    shapes.push(await sourceShapeOf(tx, source));
  }
  const pots = expandSources(progression.sources, (i) => shapes[i]!);
  // F3 round-3 review, Task 1 — `stage.kind` is THIS stage's own kind (the
  // progression's target), threaded through so placeDescriptors can refuse
  // an illegal snake-into-a-bracket-target combo (ruling 13) here too, not
  // just at createStages/replaceStages' save-time validateStageProgression
  // call — a `.setup` progression generates from a synthetic seed order
  // with no live standings, so this direct call is the day-one path ruling
  // 13's self-pairing draw actually reaches.
  const placed = placeDescriptors(pots, progression.placement, progression.map, stage.kind);
  if (placed.length < 2) {
    throw new EngineError("STAGE_NOT_READY", "this stage's progression rules produce fewer than 2 qualifiers", {
      stageId,
      count: placed.length,
    });
  }

  // P6 (F3 Task 3) verified: this map does NOT need sourceIndex-qualified
  // keys. It's keyed by the synthetic per-SEAT id `slot:${i+1}` (i = array
  // position in `placed`, already unique — never `descriptorKey`), so two
  // same-keyed descriptors from different sources (the multi-source
  // collision placeDescriptors now guards, progression.ts) already survive
  // here untouched: each gets its own seat regardless of what its
  // descriptor's key is. The actual fix for that collision lives entirely
  // in placeDescriptors (SEEDING_MAP_SOURCE_AMBIGUOUS) — see its doc
  // comment and _INDEX.md's P6 entry.
  const slotOf = new Map<string, SlotDescriptor>();
  const entrants: ActiveEntrant[] = placed.map((slot, i) => {
    const id = `slot:${i + 1}`;
    slotOf.set(id, slot.descriptor);
    return { id, seed: i + 1, swiss_first_round: null };
  });

  // Group-kind target (e.g. a "Super 8" round robin fed by group-stage
  // qualifiers): materialise ITS pools rows first, same as the plain path.
  const poolIds = new Map<string, string>();
  if (stage.kind === "group" && poolCount(stage.config) > 1) {
    const existingPools = await tx<{ id: string; key: string }[]>`
      select id, key from pools where stage_id = ${stageId}`;
    for (const pool of existingPools) poolIds.set(pool.key, pool.id);
    for (let i = 0; i < poolCount(stage.config); i++) {
      const key = POOL_KEYS[i];
      if (poolIds.has(key)) continue;
      const [row] = await tx<{ id: string }[]>`
        insert into pools (stage_id, key, name)
        values (${stageId}, ${key}, ${"Pool " + key}) returning id`;
      poolIds.set(key, row.id);
    }
  }

  const existing = await tx<{ id: string; ext_key: string | null }[]>`
    select id, ext_key from fixtures where stage_id = ${stageId}`;

  // A `timing: "setup"` progression generates off SYNTHETIC entrants —
  // score-dependent formats (swiss/americano/ladder) have no seed-order
  // shape to draw before results exist, same restriction the plain path
  // has; `generate()` covers every bracket/table kind that DOES have one.
  const gen: SeededGenFixture[] = generate(stage.kind, stage.config, entrants, poolIds);

  // F2a (P7 follow-up, 2026-08-14): the plain path's `group_too_few_entrants`
  // guard (:990-999) only fires when `gen.length === 0` — but a
  // `timing: "setup"` group stage's `entrants` here are the PLACED SEEDS, snake-distributed
  // into `pools.count` pools the same way the plain path distributes real
  // entrants. Too few seeds for the configured pool count doesn't
  // necessarily zero out `gen` overall — it can leave INDIVIDUAL pools with
  // 0 or 1 seed (roundRobinGen emits nothing for those) while OTHER pools
  // still generate fine, so `gen.length > 0`. Those stranded seeds never
  // appear as home/away/award in any `gen` entry, so they never get a
  // home_slot_label/away_slot_label written below — and because `newRows`
  // is keyed by ext_key and `generate()` is deterministic, a second call
  // reproduces the identical (still-partial) `gen` and inserts nothing new.
  // The only symptom is computeSeedProposal 422ing SEEDING_RULES_MISSING
  // forever ("regenerate them first" — advice that cannot work, see
  // destinationSlotsBySeed below). Catch the real condition — a placed seed
  // with nowhere to land — BEFORE any row is inserted, so the transaction
  // fails cleanly instead of committing a stage that can never be seeded.
  const referenced = new Set<string>();
  for (const g of gen) {
    if (typeof g.home === "string") referenced.add(g.home);
    if (typeof g.away === "string") referenced.add(g.away);
    if (typeof g.award === "string") referenced.add(g.award);
  }
  const stranded = entrants.filter((e) => !referenced.has(e.id));
  if (stranded.length > 0) {
    const groups = stage.kind === "group" ? poolCount(stage.config) : 1;
    const required = Math.max(2, groups * 2);
    throw new EngineError(
      "STAGE_NOT_READY",
      groups > 1
        ? `not enough qualifiers to fill ${groups} groups — each group needs at least 2 (have ${placed.length}, need ${required}); ${stranded.length} would never receive a fixture`
        : // Reaching here means fixtures WERE generated and some qualifier
          // still got none — a partial fill, never "no matches at all". Saying
          // the latter would repeat the unactionable-advice defect this guard
          // exists to remove. Unreachable today (with one pool stages.ts:655-656
          // runs a full-field round robin that strands nobody, and every bracket
          // generator places every seed or throws), so this is the shape a future
          // generator regression would surface through, not live copy.
          `${stranded.length} of ${placed.length} qualifiers would never receive a fixture`,
      {
        stageId,
        reason: "seeded_pool_too_few_qualifiers",
        groups,
        qualifiers: placed.length,
        required,
        stranded: stranded.length,
      },
    );
  }

  // Convert synthetic slot refs into labels. A bye AWARD line propagates
  // its label into the winner feed too (both resolve to the SAME
  // descriptor at confirm time) — see the third pass below. A bye seed
  // therefore legitimately owns TWO destination slots: the bye fixture's
  // own `home` slot (stamped right here) AND the winner-feed target's slot
  // (stamped by the third pass). destinationSlotsBySeed() returns every
  // slot for a given seed, and confirmSeedProposal fills all of them
  // through fillSlot — #554 fixed a bug where collapsing a seed's slots to
  // ONE (last-write-wins, no ORDER BY) silently stranded whichever slot
  // wasn't picked.
  //
  // The bye-line fixture itself cannot be auto-decided HERE the way a
  // live/registered-entrant bye is: there is no real entrant yet to record
  // the walkover for. It is written 'scheduled' like any other TBD slot and
  // decided at the moment its seat is filled — confirmSeedProposal's
  // `awardSeededByes` call, keyed off the `bracket.slot.bye` label stamped
  // below. Leaving it 'scheduled' after the fill is what shipped the defect
  // `progression-bye-is-decided.test.ts` pins: unplayable by construction
  // (one side is empty forever), so the stage never completes, and `isBye`
  // reads false, so it renders as an open match awaiting a draw.
  for (const g of gen) {
    if (typeof g.home === "string" && slotOf.has(g.home)) {
      g.homeLabel = { ...descriptorLabel(slotOf.get(g.home)!), seed: seedOfSlotId(g.home) };
      g.home = null;
    }
    if (typeof g.away === "string" && slotOf.has(g.away)) {
      g.awayLabel = { ...descriptorLabel(slotOf.get(g.away)!), seed: seedOfSlotId(g.away) };
      g.away = null;
    }
    if (typeof g.award === "string" && slotOf.has(g.award)) {
      g.awardLabel = g.homeLabel ?? { ...descriptorLabel(slotOf.get(g.award)!), seed: seedOfSlotId(g.award) };
    }
  }

  const byKey = new Map<string, string>();
  for (const f of existing) if (f.ext_key) byKey.set(f.ext_key, f.id);

  const newRows = gen
    .filter((g) => !byKey.has(g.extKey))
    .map((g) => ({
      id: randomUUID(),
      stage_id: stageId,
      division_id: stage.division_id,
      pool_id: g.poolId ?? null,
      round_no: g.roundNo,
      seq_in_round: g.seqInRound,
      home_entrant_id: null,
      away_entrant_id: null,
      ext_key: g.extKey,
      status: "scheduled",
      outcome: null,
      // F1: same role columns as the plain generateStageFixtures path —
      // seeded (placeholder) brackets must persist a role too, or the
      // day-one preview path F3 depends on renders with no role at all.
      lane: g.lane ?? null,
      is_final: g.isFinal === true,
      third_place: g.thirdPlace === true,
      conditional: g.conditional === true,
    }));
  if (newRows.length > 0) await tx`insert into fixtures ${tx(newRows)}`;
  for (const r of newRows) byKey.set(r.ext_key, r.id);
  const created = newRows.length;
  const createdIds = newRows.map((r) => r.id);

  // Labels via a direct per-row update with tx.json() (the pattern proven
  // everywhere else in this file, e.g. wireCrossFeeds/config writes) —
  // NOT folded into the bulk array-insert above: that helper's per-column
  // type inference binds a JSON.stringify'd JS string as `text`, and
  // Postgres has no implicit text->jsonb PARSE cast in that bound-
  // parameter context, so it lands double-encoded (a jsonb STRING
  // containing escaped JSON text, not the parsed object) — confirmed
  // empirically against this exact insert, not assumed.
  for (const g of gen) {
    const fixtureId = byKey.get(g.extKey);
    if (fixtureId === undefined) continue;
    // I1 (re-review, 2026-09-21) — `byKey` includes rows that ALREADY
    // exist, so this pass runs again on every re-Generate, over fixtures
    // that confirm has since filled and settled. Two guards, and they cover
    // different things:
    //   - `*_entrant_id is null`: a seated side carries no label at all
    //     (fillSlot nulls it), and writing the descriptor's TBD text back
    //     onto a real entrant's seat re-advertises a draw that has happened.
    //   - not already the BYE stamp: confirm marks a VACATED seat
    //     `bracket.slot.bye` and `awardSeededByes` settles the line off that
    //     marker. Reverting it to `slot.winner_group` un-settles the
    //     walkover — `isBye` goes false and the line reads as an ordinary
    //     match awaiting a draw again.
    if (g.homeLabel) {
      await tx`update fixtures set home_slot_label = ${tx.json(g.homeLabel as never)}
               where id = ${fixtureId} and home_entrant_id is null
                 and coalesce(home_slot_label->>'key', '') <> ${BYE_SLOT_LABEL.key}`;
    }
    if (g.awayLabel) {
      await tx`update fixtures set away_slot_label = ${tx.json(g.awayLabel as never)}
               where id = ${fixtureId} and away_entrant_id is null
                 and coalesce(away_slot_label->>'key', '') <> ${BYE_SLOT_LABEL.key}`;
    }
    // A bye's phantom side resolves to nobody, ever — padding the bracket
    // out to a power of two is the entire reason the seat exists. Without a
    // label there, resolveSlotLabel falls through to a generic TBD, which
    // tells the organiser to wait for an opponent who is not coming; the
    // plain (non-progression) path has stored `bracket.slot.bye` there since
    // the P5 review (`byeSlotLabel` at its own insert) and this is the same
    // store on the seeded path, so every renderer already going through
    // resolveSlotLabel picks it up for free.
    //
    // It is also the MARKER `awardSeededByes` reads at confirm time to tell
    // a walkover line apart from a slot still waiting on a feeder — which is
    // why it is stamped here, at the one place that knows `g.award`, rather
    // than re-derived later from a row shape that cannot distinguish them.
    //
    // Deliberately carries NO `seed`: destinationSlotsBySeed keys on that
    // field to decide which slots a qualifier fills, and this seat is not a
    // destination. Both sides are guarded rather than assuming the engine
    // always lands the award on `home` (buildSingleElim does today), same
    // symmetry the plain path keeps.
    if (g.award !== undefined) {
      if (g.home === null && !g.homeLabel) {
        await tx`update fixtures set home_slot_label = ${tx.json(BYE_SLOT_LABEL as never)} where id = ${fixtureId}`;
      }
      if (g.away === null && !g.awayLabel) {
        await tx`update fixtures set away_slot_label = ${tx.json(BYE_SLOT_LABEL as never)} where id = ${fixtureId}`;
      }
    }
  }

  // Feed wiring — identical shape to generateStageFixtures' second pass.
  const feedUpdates = { winner: [], loser: [] } as Record<
    "winner" | "loser",
    { source: string; target: string; slot: number }[]
  >;
  for (const g of gen) {
    const targetId = byKey.get(g.extKey);
    if (!targetId) continue;
    for (const [feed, slot] of [
      [g.homeFrom, 1],
      [g.awayFrom, 2],
    ] as const) {
      if (!feed) continue;
      const sourceId = byKey.get(feed.extKey);
      if (!sourceId) continue;
      feedUpdates[feed.side].push({ source: sourceId, target: targetId, slot });
    }
  }
  if (feedUpdates.winner.length > 0) {
    const u = feedUpdates.winner;
    await tx`
      update fixtures f
      set winner_to_fixture = v.target_id, winner_to_slot = v.slot
      from (select unnest(${u.map((x) => x.source)}::uuid[]) as source_id,
                   unnest(${u.map((x) => x.target)}::uuid[]) as target_id,
                   unnest(${u.map((x) => x.slot)}::int[])    as slot) v
      where f.id = v.source_id and f.winner_to_fixture is null`;
  }
  if (feedUpdates.loser.length > 0) {
    const u = feedUpdates.loser;
    await tx`
      update fixtures f
      set loser_to_fixture = v.target_id, loser_to_slot = v.slot
      from (select unnest(${u.map((x) => x.source)}::uuid[]) as source_id,
                   unnest(${u.map((x) => x.target)}::uuid[]) as target_id,
                   unnest(${u.map((x) => x.slot)}::int[])    as slot) v
      where f.id = v.source_id and f.loser_to_fixture is null`;
  }

  // Third pass — TBD-aware bye propagation: writes the SAME label into the
  // winner feed's slot instead of a real entrant id.
  const awardedLabelled = gen.filter((g) => g.awardLabel !== undefined && byKey.has(g.extKey));
  if (awardedLabelled.length > 0) {
    const sources = await tx<
      { id: string; winner_to_fixture: string | null; winner_to_slot: number | null }[]
    >`select id, winner_to_fixture, winner_to_slot from fixtures
      where id in ${tx(awardedLabelled.map((g) => byKey.get(g.extKey)!))}`;
    const srcOf = new Map(sources.map((s) => [s.id, s]));
    for (const g of awardedLabelled) {
      const source = srcOf.get(byKey.get(g.extKey)!);
      if (!source?.winner_to_fixture) continue;
      if (source.winner_to_slot === 1) {
        await tx`update fixtures set home_slot_label = ${tx.json(g.awardLabel as never)}
                 where id = ${source.winner_to_fixture} and home_entrant_id is null`;
      } else if (source.winner_to_slot === 2) {
        await tx`update fixtures set away_slot_label = ${tx.json(g.awardLabel as never)}
                 where id = ${source.winner_to_fixture} and away_entrant_id is null`;
      }
    }
  }

  if (stage.status === "pending") {
    await tx`update stages set status = 'active' where id = ${stageId}`;
    // W2d X-TB-2 (OC2): the table rules are fixed in the transaction that starts the stage.
    await pinStageTableRules(tx, stageId);
  }

  const fixtureRows = await tx<Omit<FixtureRow, "court_name">[]>`
    select f.id, f.stage_id, f.division_id, f.pool_id, f.round_no, f.seq_in_round, f.fixture_no,
           f.home_entrant_id, f.away_entrant_id, f.home_slot_label, f.away_slot_label,
           f.scheduled_at, f.venue, f.court_label, f.court_id,
           f.venue_id, ven.name as venue_name,
           f.officials, f.status, f.outcome, f.schedule_source, f.schedule_locked, f.created_at,
           f.ext_key, f.lane, f.is_final, f.third_place, f.conditional
    from fixtures f
    left join venues ven on ven.id = f.venue_id
    where f.stage_id = ${stageId} order by f.round_no, f.seq_in_round`;
  // #14: venue-qualified label (a bare joined `courts.name` can't tell two
  // same-named courts in different venues apart) — same fallback
  // convention as FixtureRow's own doc comment: fall back to the id
  // itself on a miss (should not happen; FK-restricted).
  const courtNames = await courtNamesById(tx);
  const fixtures = fixtureRows.map((f) => ({
    ...f,
    court_name: f.court_id !== null ? (courtNames.get(f.court_id) ?? f.court_id) : null,
  }));

  if (created > 0) {
    const [{ seq: last }] = await tx<{ seq: number }[]>`
      select coalesce(max(seq), 0)::int as seq from division_events
      where division_id = ${stage.division_id}`;
    await tx`
      insert into division_events (division_id, seq, type, payload)
      values (${stage.division_id}, ${last + 1}, 'fixtures_generated',
              ${tx.json({ stage_id: stageId, fixture_ids: createdIds } as never)})`;
    await tx`update divisions set seq = ${last + 1}, edit_watermark = null
             where id = ${stage.division_id}`;
  }
  const [division] = await tx<{ competition_id: string }[]>`
    select competition_id from divisions where id = ${stage.division_id}`;
  return {
    outcome: { created, existing: gen.length - created, fixtures },
    divisionId: stage.division_id,
    competitionId: division!.competition_id,
    kind: stage.kind,
  };
}