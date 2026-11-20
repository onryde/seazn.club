import "server-only";
// Seed proposals (`timing: "setup"`): compute, read and confirm the cross-stage
// fill.

import { withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { type ComparisonBasis, type ProgressionSpec, type SourceShape, type SourceTables } from "@seazn/engine/competition";
import { resolveStoredProgression } from "../stored-progression";
import { BYE_SLOT_LABEL } from "@/lib/bye-line";
import type { AuthCtx } from "@/server/api-v1/auth";
import { log } from "@/server/logger";
import { afterScheduleWrite, validateSchedule, courtNamesById } from "../schedule";
import { departedLoseBestNth, descriptorKey, destinationSlotsBySeed, sourcesToTables, persistCrossGroupDraws, standingsHash, poolTableRowsAcrossSources, type SlotDescriptor } from "../stage-seeding";
import { refuseCutBeyondTables } from "./cut-gate";
import { STAGE_COLS, type StageRow, type FixtureRow, type Tx } from "./types";
import { fireStageRevalidate, refoldStageTable, departedEntrantIds } from "./helpers";
import { fillSlot, resolveBracketSeats } from "./bracket-seats";
import { knockoutRefusal } from "../knockout-refusal";
import { writeProgressionSetupFixtures } from "./setup-fixtures";
import { isFirstLossProgression, reseedPlateQualifiers } from "../plate-field";
import { drawAcrossPools, preBumpBestNthDraft, type CrossPoolRefused } from "./cross-pool-draw";
import { answerTies, type AnsweredTie } from "@/lib/cross-pool-ties";
import {
  nonRealCarrySource,
  carrySourceRefusal,
  buildCarryDeltas,
  insertStandingsCarriedEvent,
} from "./carry-over";

// ---------------------------------------------------------------------------
// D4a (P5) — seed proposals: propose + confirm cross-stage fill. See
// stage-seeding.ts for the pure shape/placement/tie-detection logic this
// wraps with DB reads (standings, TBD fixtures) and the fillSlot write.
// ---------------------------------------------------------------------------

// F2 — standingsHash/destinationSlotsBySeed (and sourcesToTables, which
// wraps the source-standings read this file used to call directly) moved
// to stage-seeding.ts (unchanged bodies), imported at the top of this file.

export interface SeedProposalOut {
  id: string;
  stageId: string;
  status: "draft" | "confirmed" | "stale";
  computed: {
    qualifiers: {
      rank: number;
      source: { stageId: string; group?: string; rank: number };
      entrantId: string;
      destinationSlot: string;
      /** W5 app PR B T4 (engine 10 `ResolvedProgressionEntry.pool`): the source pool's key, group_rank and best_nth entries. */
      pool?: string;
      /** W5 app PR B T4 (RB5-U1/U3, X-UP-3): a best_nth entry's comparison basis - what the source's Standings footnote says
       *  (`loadUnequalBasis`). Replaced with the slot by every re-proposal (a stale draft's basis is never read). */
      basis?: ComparisonBasis;
    }[];
    ties: { slots: string[]; entrantIds: string[]; reason: string }[];
    standingsHash: string;
    /** W4 T8 (RB4-E5/T4): a plate configured with a third-place match whose field gave under two real semi-finals - drawn without it. */
    thirdPlaceDropped?: true;
    /** W5 app PR B T5 (FX-G5, ruling 281): the seats were drawn across the source's pools with this stored draw seed
     *  (`drawAcrossPools`); the stage card shows it (R24 pick 18 A). Absent: not a pooled field, nothing drawn. */
    crossPoolDraw?: { seed: number; refused?: CrossPoolRefused };
  };
}

/** F3 round-3 review, Task 2 (MAJOR) — engine `descriptorKey` renders
 *  `best_nth` as `best:${position}`, deliberately dropping `nth` (it is also
 *  the `seeded_map.source` wire vocabulary, which stays narrow on purpose —
 *  see progression.ts's own doc comment; NOT widened here). Two bestNth take
 *  rules on the SAME source at the same position but a DIFFERENT nth (e.g.
 *  `{nth:3,count:2}` and `{nth:4,count:2}`, both producing positions 1,2)
 *  therefore collide on that bare key within one source index — a `Map`
 *  keyed by it silently keeps whichever qualifier was inserted LAST. This
 *  local, wider key folds `nth` in for `best_nth` only (every other
 *  descriptor kind is unaffected — `descriptorKey` already fully determines
 *  them); used on BOTH the seedOfKey build and the tie-lookup read below so
 *  the two sides can never drift apart. */
function seedProposalKey(sourceIndex: number, d: SlotDescriptor): string {
  const base = d.kind === "best_nth" ? `best:${d.nth}:${d.position}` : descriptorKey(d);
  return `${sourceIndex}:${base}`;
}

/**
 * Compute (or recompute) a DRAFT seed proposal for a `timing: "setup"`
 * stage (design's API contract: POST /stages/{id}/seed-proposal). Never
 * fills anything — propose + confirm, owner ruling. At most one 'draft' row
 * per stage (DB partial unique index backs this too): any existing draft is
 * marked 'stale' first.
 *
 * Errors: 422 SEEDING_RULES_MISSING (no progression, or its rules can't
 * resolve against this stage's generated TBD fixtures — generate them
 * first); 409 SEEDING_SOURCE_INCOMPLETE (a source stage not complete, or has
 * no standings yet); 409 SEEDING_ALREADY_CONFIRMED (this stage's slots are
 * already filled — recompute is refused, not just a no-op, so the caller
 * doesn't mistake a stale draft for something actionable); 422
 * SEEDING_CARRY_SOURCE_INVALID (F6 — `carry` set against a source that offers
 * a downstream stage a finishing order rather than a points table, i.e. any
 * kind outside REAL_TABLE_KINDS).
 */
export async function computeSeedProposal(
  auth: AuthCtx,
  stageId: string,
  /** B3 fix wave (m-6): a re-proposal the system makes after a source moved (`seed-stale.ts`), never the organiser's Recompute.
   *  When the live draft already names the SAME slate (qualifiers, ties, the third-place note) - only the standings it was read
   *  from moved, as on each intermediate write of a correction - that draft is refreshed in place (its `standingsHash`, so the
   *  confirm's freshness check reads it current) instead of being staled for an identical new row. */
  opts: { refreshSameSlate?: boolean } = {},
): Promise<SeedProposalOut> {
  return withTenant(auth.orgId, async (tx) => {
    const [stage] = await tx<StageRow[]>`select ${tx(STAGE_COLS)} from stages where id = ${stageId}`;
    if (!stage) throw new HttpError(404, "stage not found");
    if (!stage.progression) {
      throw new HttpError(422, "this stage has no seeding rules declared", "SEEDING_RULES_MISSING");
    }
    const progression = stage.progression as unknown as ProgressionSpec;

    await tx`select pg_advisory_xact_lock(hashtext(${"division:" + stage.division_id}))`;

    const [confirmed] = await tx<{ id: string }[]>`
      select id from stage_seed_proposals where stage_id = ${stageId} and status = 'confirmed' limit 1`;
    if (confirmed) {
      throw new HttpError(
        409,
        "this stage's slots are already filled from a confirmed proposal",
        "SEEDING_ALREADY_CONFIRMED",
      );
    }

    // sourcesToTables resolves EVERY named source (Decision 4 — genuinely
    // multi-source, though no writer in this session emits a multi-source
    // `timing:"setup"` progression), requiring each complete before reading
    // its standings — same 409 SEEDING_SOURCE_INCOMPLETE contract this
    // function has always had, generalised from one source to N.
    const { shapes, tables, resolved } = await sourcesToTables(tx, stage, progression.sources);

    // F6 (#625) — carry-over refuses a source that offers only a finishing
    // order, raised at PROPOSE rather than only where carry is applied. Before this,
    // the refusal existed on the `timing:"on_complete"` path alone
    // (seedNextStage), so a setup-timing organiser was handed a draft they
    // could confirm into a stage whose carry could never be honoured. `carry`
    // is an apps/web/DB-orchestration concept the engine's pure
    // ProgressionSpec has no notion of — hence the cast, same as
    // seedNextStage's own widened read. Shared refusal sentence, deliberately
    // NOT a shared throw: see nonRealCarrySource's comment for why this side
    // is an HttpError and that side an EngineError.
    const carryMode = (progression as { carry?: string }).carry ?? "none";
    if (carryMode !== "none") {
      const nonReal = nonRealCarrySource(resolved);
      if (nonReal) {
        throw new HttpError(422, carrySourceRefusal(nonReal.kind), "SEEDING_CARRY_SOURCE_INVALID", {
          stageId: nonReal.id,
          kind: nonReal.kind,
          carry: carryMode,
        });
      }
    }
    // W5 T12b (X-BD-8, RB5-E6): a cut the finished tables cannot supply is refused by name before the engine resolves it.
    refuseCutBeyondTables(progression.sources, shapes, tables, resolved);
    // A2 (round-4 review) — `stage` here IS the progression's own target
    // (computeSeedProposal proposes seeds INTO it), so `stage.kind` is the
    // real targetKind ruling 13's snake/bracket-target guard needs to fire
    // on this resolution path too, not just at createStages' save-time
    // validateStageProgression call.
    const resolvedProgression = resolveStoredProgression(
      progression,
      shapes,
      departedLoseBestNth(tables, resolved, await departedEntrantIds(tx, stage.division_id)),
      stage.kind,
      resolved.map((r) => r.kind),
    );
    const { ties, newLotsDraws } = resolvedProgression;
    // W4 T8 (X-PL-5, X-SD-11): a plate has no lines until its field is known; this is where they are drawn, at the field's size
    // (`sourcesToTables` above has already refused a field still open). Then its seeds are the main draw's, on the fold.
    const firstLossPlate = isFirstLossProgression(progression);
    // X-PL-2: under two first-match losers there is no bracket to draw; `maybeProposePlate` completes the plate by name instead,
    // and a direct propose is refused by name rather than writing an empty draw.
    if (firstLossPlate && resolvedProgression.qualifiers.length < 2) throw knockoutRefusal("PLATE_FIELD_TOO_SMALL");
    if (firstLossPlate) await writeProgressionSetupFixtures(tx, stageId, { checkSeats: true });
    const resolvedSeats = firstLossPlate ? await reseedPlateQualifiers(tx, stage, resolvedProgression.qualifiers) : resolvedProgression.qualifiers;
    // W5 app PR B T5 (FX-G5): a knockout fed from two or more pools seats round one across the pools, its level runs drawn with the
    // stage's stored seed (`drawAcrossPools`; null - today's seats - for any other field). Over the FULL slate, before the departed
    // filter below, so the drawn geometry is the one the TBD lines hold.
    const crossPool = firstLossPlate ? null : await drawAcrossPools(tx, stage, progression, resolvedSeats, tables);
    const qualifiers = crossPool?.qualifiers ?? resolvedSeats;
    // W2d T12 (spec §5.9): stored under the division lock held above, so a re-proposal seats the same draw.
    await persistCrossGroupDraws(tx, resolved, newLotsDraws);

    const slotBySeed = await destinationSlotsBySeed(tx, stageId);
    if (slotBySeed.size === 0) {
      throw new HttpError(
        422,
        "this stage has no generated TBD fixtures yet — generate its fixtures first",
        "SEEDING_RULES_MISSING",
        { stageId },
      );
    }
    // P6 (F3 review item 1, RESOLVED) — was keyed by bare descriptorKey,
    // colliding across two sources that emit the same descriptor (trivially:
    // two rankRange sources, or two group_rank sources sharing a pool letter
    // — the default pool naming). The Map construction's last-write-wins
    // meant a tie flagged on one source's slot could resolve to a DIFFERENT
    // source's slot instead — the rightful qualifier silently dropped there
    // while the real tie's slot kept the engine's unconfirmed default pick,
    // exactly the "a tie is FLAGGED, never silently ordered" invariant
    // confirmSeedProposal's own tie-resolution check below exists to uphold.
    // Keyed by `${sourceIndex}:${descriptorKey}` instead, now that
    // `ProgressionTieFlag.descriptors` carries sourceIndex (widened to
    // SourcedSlot — progression.ts). Reachable today: createStages/
    // replaceStages persist a multi-source `setup` progression with no
    // progression-aware gate (format-gates.ts checks the stage kind only —
    // V471 freed byes/cross_feeds/placements); progression-multi-source.test.ts
    // exercises it end to end.
    //
    // F3 round-3 review, Task 2 — that alone still collides for two bestNth
    // rules on the SAME source at the same position but a different nth
    // (descriptorKey's `best:${position}` drops `nth`); seedProposalKey folds
    // `nth` in for best_nth so this map (and the tie lookup below) can tell
    // them apart. See its own doc comment.
    const seedOfKey = new Map(qualifiers.map((q) => [seedProposalKey(q.sourceIndex, q.descriptor), q.seed] as const));

    const resolvedQualifiers = qualifiers.map((q) => ({
      rank: q.seed,
      source: {
        stageId: resolved[q.sourceIndex]!.id,
        ...(q.descriptor.kind === "group_rank" ? { group: q.descriptor.pool } : {}),
        rank: q.rank,
      },
      entrantId: q.entrantId,
      // Wire contract: ONE slot, for display (design's "Renderers receive
      // {key,params}" convention extends here — first of the deterministic,
      // order-by-id list). A bye seed's OTHER slot isn't dropped — it's
      // filled too at confirm time via a fresh destinationSlotsBySeed() call
      // keyed off this same `rank`; see confirmSeedProposal.
      destinationSlot: slotBySeed.get(q.seed)?.[0] ?? "",
      // W5 app PR B T4 (X-UP-3): the engine's own pool and comparison basis ride the slot; the Standings footnote reads them.
      ...(q.pool !== undefined ? { pool: q.pool } : {}),
      ...(q.basis !== undefined ? { basis: q.basis } : {}),
    }));
    // Integrity check over the FULL resolved slate, BEFORE the departed
    // filter below: it asks whether the generated TBD fixtures still match
    // the seeding rules, and filtering first would let a departed
    // qualifier's missing slot pass unnoticed (and, if every qualifier had
    // departed, would hand `some()` an empty array to answer `false` to).
    if (resolvedQualifiers.some((q) => q.destinationSlot === "")) {
      throw new HttpError(
        422,
        "this stage's generated TBD fixtures don't match its current seeding rules — regenerate them first",
        "SEEDING_RULES_MISSING",
        { stageId },
      );
    }
    // A qualifier who has left the field is never OFFERED. Progression
    // resolves over the standings tables, which deliberately still carry her
    // (see departedEntrantIds) — so without this an organiser is shown, and
    // pre-ticked into, a bracket seat for someone who has withdrawn.
    //
    // Except from a SWISS source (W3 T15 Carry A, controller ruling 2026-11-02), a LEAGUE or GROUP source (W4 T13,
    // RB4-V6) or a KNOCKOUT source (W4 T13, RB4-V2: the lucky loser in her rank): `sourcesToTables` has already taken
    // her out of its tables, so the cut above was read without her and the next eligible entrant holds her place — a tie
    // at the new boundary is flagged like any other. Only a shortfall (nobody eligible left) still reaches her here. From
    // any other source:
    // her SEAT is left empty rather than closed up: nobody is promoted into
    // the vacancy (owner decision pending for a group or league cut — W4/W5), so every surviving qualifier
    // keeps the seed and destination slot the engine gave her and the
    // bracket simply gets smaller. This is the offer only — the binding
    // refusal is confirmSeedProposal's, which also covers the `edits[]` and
    // `tiePicks[]` routes this filter cannot see, and a draft computed
    // BEFORE a withdrawal (a withdrawal does not change the frozen standings
    // snapshot, so it does not stale the draft).
    const departed = await departedEntrantIds(tx, stage.division_id);
    const computedQualifiers = resolvedQualifiers.filter((q) => !departed.has(q.entrantId));
    const survivingSlots = new Set(computedQualifiers.map((q) => q.destinationSlot));
    const computedTies = ties
      .map((t) => ({
        slots: t.descriptors
          .map((sourced) => {
            // seedProposalKey on the read side too (Task 2) — must match the
            // build side above exactly, or a best_nth tie resolves to whichever
            // OTHER same-position/different-nth qualifier happened to be
            // inserted last.
            const seed = seedOfKey.get(seedProposalKey(sourced.sourceIndex, sourced.descriptor));
            return (seed !== undefined ? slotBySeed.get(seed)?.[0] : undefined) ?? descriptorKey(sourced.descriptor);
          })
          // A tied slot whose qualifier has departed is no longer offered
          // above, so leaving it in the tie would demand an edit for a seat
          // that has no candidate left — and any candidate the organiser
          // picked would then be double-assigned (she already holds her own
          // slot), which is a dead end, not a refusal. `seedOfKey` is still
          // built from the FULL slate, so the SURVIVING slots in a tie still
          // resolve to their real slot ids rather than the descriptorKey
          // fallback.
          .filter((slot) => survivingSlots.has(slot)),
        entrantIds: t.entrantIds.filter((id) => !departed.has(id)),
        reason: t.reason,
      }))
      // Fewer than two candidates left is no longer an ambiguity to resolve,
      // so dropping it is not the "silently ordered tie" the design forbids
      // — there is nothing left to order. A tie with no surviving slots is
      // likewise nothing to ask about.
      .filter((t) => t.slots.length > 0 && t.entrantIds.length > 1);

    const computed = {
      qualifiers: computedQualifiers,
      ties: computedTies,
      standingsHash: standingsHash(poolTableRowsAcrossSources(tables)),
      // RB4-E5/T4: the plate asked for a third-place match and its field gave under two real semi-finals, so it was drawn without.
      ...(firstLossPlate && stage.config.thirdPlace === true && resolvedProgression.qualifiers.length < 4 ? { thirdPlaceDropped: true as const } : {}),
      ...(crossPool !== null ? { crossPoolDraw: { seed: crossPool.seed, ...(crossPool.refused !== undefined ? { refused: crossPool.refused } : {}) } } : {}),
    };

    if (opts.refreshSameSlate) {
      const [draft] = await tx<{ id: string; computed: SeedProposalOut["computed"] }[]>`
        select id, computed from stage_seed_proposals where stage_id = ${stageId} and status = 'draft'
         order by created_at desc, id limit 1`;
      if (draft !== undefined && sameSlate(draft.computed, computed)) {
        await tx`update stage_seed_proposals set computed = ${tx.json(computed as never)} where id = ${draft.id}`;
        return { id: draft.id, stageId, status: "draft", computed };
      }
    }
    await tx`update stage_seed_proposals set status = 'stale' where stage_id = ${stageId} and status = 'draft'`;
    const [row] = await tx<{ id: string }[]>`
      insert into stage_seed_proposals (org_id, stage_id, computed, status)
      values (${auth.orgId}, ${stageId}, ${tx.json(computed as never)}, 'draft')
      returning id`;

    return { id: row!.id, stageId, status: "draft", computed };
  });
}

/** B3 m-6: do two proposals offer the same slate? Everything the organiser confirms - who sits where, the ties to resolve, the
 *  third-place note - compared key-order-blind (a stored jsonb reads its keys back in its own order); the hash is left out. */
function sameSlate(a: SeedProposalOut["computed"], b: SeedProposalOut["computed"]): boolean {
  return stableJson({ ...a, standingsHash: undefined }) === stableJson({ ...b, standingsHash: undefined });
}

function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

/**
 * Read-only: the latest seed proposal for `stageId` (any status —
 * draft/confirmed/stale), or null if none has been computed yet (P6/D4b task
 * B ruling — see docs/superpowers/plans/2026-08-13-p6-progression-ui-plan.md
 * "There is no read path for a proposal"). `stage_seed_proposals` is
 * otherwise touched only inside compute/confirm/stale-marking; a panel that
 * renders on page load must not POST to discover its own state (recompute
 * marks prior drafts stale and inserts a row — a real side effect). This
 * function issues one `select`, nothing else — never call computeSeedProposal
 * from here to paper over a null.
 *
 * Consumed by the division page (server component) and handed to
 * ProgressionPanel as a prop; fresh state after a recompute or confirm comes
 * from `router.refresh()`, not a re-call of this function reacting to state.
 */
export async function getSeedProposal(auth: AuthCtx, stageId: string): Promise<SeedProposalOut | null> {
  return withTenant(auth.orgId, async (tx) => {
    const [row] = await tx<
      { id: string; stage_id: string; status: SeedProposalOut["status"]; computed: SeedProposalOut["computed"] }[]
    >`
      select id, stage_id, status, computed from stage_seed_proposals
      where stage_id = ${stageId}
      order by created_at desc, id desc
      limit 1`;
    if (!row) return null;
    return { id: row.id, stageId: row.stage_id, status: row.status, computed: row.computed };
  });
}

/** F11: thrown inside the confirm transaction for a pre-bump best-Nth draft; caught outside it, where the re-proposal runs. */
class PreBumpDraft extends Error {}

type DraftTie = SeedProposalOut["computed"]["ties"][number];

/** W5 app PR B D-B2-1: the draft's ties this confirm answers, each as a RANKING of its entrants (best first). A `tiePicks` entry
 *  names its tie by the tie's slot set (as the resolution check reads it; the last pick for a set wins, as when picks were placed
 *  seat by seat) and its `order` is the ranking. The desk answers through `edits[]` (progression-panel.tsx): edits that fill every
 *  seat of a tie no pick answers rank whoever sits in the draft's better seat first, then the tie's unseated entrants. */
function tieAnswers(
  computed: SeedProposalOut["computed"],
  input: { edits?: { destinationSlot: string; entrantId: string }[]; tiePicks?: { slots: string[]; order: string[] }[] },
): { tie: DraftTie; ranking: string[] }[] {
  const setOf = (slots: readonly string[]) => [...slots].sort().join(",");
  const rankOf = new Map(computed.qualifiers.map((q) => [q.destinationSlot, q.rank] as const));
  const editOf = new Map((input.edits ?? []).map((e) => [e.destinationSlot, e.entrantId] as const));
  return computed.ties.flatMap((tie) => {
    const pick = (input.tiePicks ?? []).filter((p) => setOf(p.slots) === setOf(tie.slots)).at(-1);
    if (pick !== undefined) return [{ tie, ranking: pick.order }];
    if (!tie.slots.every((s) => editOf.has(s))) return [];
    const seated = [...tie.slots].sort((a, b) => (rankOf.get(a) ?? 0) - (rankOf.get(b) ?? 0)).map((s) => editOf.get(s)!);
    return [{ tie, ranking: [...seated, ...tie.entrantIds.filter((id) => !seated.includes(id))] }];
  });
}

/** W5 app PR B D-B2-1: round one re-drawn over the picked slate, as wire slot -> entrant. The resolver's slate is read again from
 *  the same tables (the freshness check above has proved them the draft's); each answered tie's seats - the seeds its descriptors
 *  hold, best first - go to its ranking's first entrants, in order, no longer `tied` to each other (the organiser ordered them;
 *  the stored seed does not reshuffle them). Then the same draw, with the draft's stored seed. A slate the draw cannot separate is
 *  the draw's named 422; a draft the tables no longer reproduce is stale; a ranking that does not fill the tie leaves it unresolved. */
async function redrawAnsweredTies(
  tx: Tx,
  stage: StageRow,
  progression: ProgressionSpec,
  src: { shapes: SourceShape[]; tables: SourceTables[]; resolved: { id: string; kind: string }[] },
  computed: SeedProposalOut["computed"],
  answers: readonly { tie: DraftTie; ranking: readonly string[] }[],
  seed: number,
): Promise<Map<string, string>> {
  const departed = await departedEntrantIds(tx, stage.division_id);
  const { qualifiers, ties } = resolveStoredProgression(
    progression,
    src.shapes,
    departedLoseBestNth(src.tables, src.resolved, departed),
    stage.kind,
    src.resolved.map((r) => r.kind),
  );
  const stale = () => new HttpError(409, "standings changed since this proposal was computed — recompute it first", "SEEDING_PROPOSAL_STALE");
  const sameSet = (a: readonly string[], b: readonly string[]) => [...a].sort().join(",") === [...b].sort().join(",");
  // The draft's slate and ties, read again: anything else is a draft these tables no longer make.
  if (!sameSet(qualifiers.map((q) => q.entrantId), computed.qualifiers.map((q) => q.entrantId))) throw stale();
  const slate = [...qualifiers].sort((a, b) => a.seed - b.seed);
  const atKey = new Map(slate.map((q, i) => [seedProposalKey(q.sourceIndex, q.descriptor), i] as const));
  const answered: AnsweredTie[] = [];
  for (const { tie, ranking } of answers) {
    const flag = ties.find((t) => sameSet(t.entrantIds, tie.entrantIds));
    if (flag === undefined) throw stale();
    const seats = flag.descriptors.map((d) => atKey.get(seedProposalKey(d.sourceIndex, d.descriptor))).filter((i): i is number => i !== undefined);
    if (seats.length !== tie.slots.length) throw stale();
    answered.push({ members: tie.entrantIds, seats, ranking });
  }
  const picked = answerTies(slate, answered, (seat, entrantId) => src.tables[seat.sourceIndex]?.pools.find((p) => p.rows.some((r) => r.entrantId === entrantId))?.pool);
  if ("unresolved" in picked) {
    const { tie } = answers[picked.unresolved]!;
    throw new HttpError(422, "a tie pick must rank the tied entrants, at least one per tied slot", "SEEDING_TIE_UNRESOLVED", { slots: tie.slots, entrantIds: tie.entrantIds });
  }
  const out = await drawAcrossPools(tx, stage, progression, picked.slate, src.tables, { seed });
  // The draft was drawn across these pools, so its picked slate is too; null would seat it undrawn.
  if (out === null) throw new Error(`seed proposal ${stage.id}: a slate drawn across pools no longer draws`);
  if (out.refused !== undefined) {
    throw new HttpError(422, "no ordering of the qualifiers keeps pool-mates apart in round one", out.refused.code, out.refused.vars);
  }
  const slotsBySeed = await destinationSlotsBySeed(tx, stage.id);
  const seats = new Map<string, string>();
  for (const q of out.qualifiers) {
    const slot = slotsBySeed.get(q.seed)?.[0];
    if (slot === undefined) {
      throw new HttpError(422, "this stage's generated TBD fixtures don't match its current seeding rules — regenerate them first", "SEEDING_RULES_MISSING", { stageId: stage.id });
    }
    seats.set(slot, q.entrantId);
  }
  return seats;
}

export interface ConfirmSeedProposalOut {
  proposalId: string;
  filled: number;
  fixtures: FixtureRow[];
}

/**
 * Confirm a draft seed proposal (design's Fill algorithm, verbatim):
 * 1. freshness (standingsHash) — else 409 stale.
 * 2. apply edits + tiePicks over `computed` -> final slot map.
 * 3. validate: bijection destinationSlot<->entrant, entrant ∈ division, no
 *    slot already filled.
 * 4. single transaction: fill via fillSlot (the SAME pathway intra-bracket
 *    advancement uses — D4a/P5 scope item 3), mark the proposal confirmed.
 * 5. post-commit: re-run schedule validation, pino `stage_seeded`.
 */
export async function confirmSeedProposal(
  auth: AuthCtx,
  stageId: string,
  input: {
    proposalId: string;
    edits?: { destinationSlot: string; entrantId: string }[];
    tiePicks?: { slots: string[]; order: string[] }[];
  },
): Promise<ConfirmSeedProposalOut> {
  const committed = await withTenant(auth.orgId, async (tx) => {
    const [stage] = await tx<StageRow[]>`select ${tx(STAGE_COLS)} from stages where id = ${stageId}`;
    if (!stage) throw new HttpError(404, "stage not found");
    if (!stage.progression) throw new HttpError(422, "this stage has no seeding rules declared", "SEEDING_RULES_MISSING");
    const progression = stage.progression as unknown as ProgressionSpec;

    await tx`select pg_advisory_xact_lock(hashtext(${"division:" + stage.division_id}))`;

    const [proposal] = await tx<{ id: string; status: string; computed: SeedProposalOut["computed"] }[]>`
      select id, status, computed from stage_seed_proposals where id = ${input.proposalId} and stage_id = ${stageId}`;
    if (!proposal) throw new HttpError(404, "seed proposal not found");
    if (proposal.status === "confirmed") {
      throw new HttpError(
        409,
        "this stage's slots are already filled from a confirmed proposal",
        "SEEDING_ALREADY_CONFIRMED",
      );
    }
    if (proposal.status === "stale") {
      throw new HttpError(409, "standings changed since this proposal was computed — recompute it first", "SEEDING_PROPOSAL_STALE");
    }
    // W5 app PR B D-B2-1: on a draft drawn across pools, the ties this confirm answers (a pick, or the edits that fill a tie's
    // seats) re-draw round one below; none answered, the draft's own draw stands.
    const drawn = proposal.computed.crossPoolDraw;
    const answers = drawn === undefined ? [] : tieAnswers(proposal.computed, input);
    // W5 app PR B T5 (RB5-D4, RB5-D10; K22): a draft whose cross-pool draw was refused is never confirmed - same-pool round one
    // is not seated silently. Named, with the numbers the card's band shows. A tie answered here changes the slate, so its re-draw
    // decides instead (D-B2-1).
    const refused = drawn?.refused;
    if (refused !== undefined && answers.length === 0) {
      throw new HttpError(422, "no ordering of the qualifiers keeps pool-mates apart in round one", refused.code, refused.vars);
    }

    // Step 1 — freshness. A standings override could have landed between the
    // draft's compute and this request; re-derive the hash rather than trust
    // the row's status alone.
    const { shapes, tables, resolved } = await sourcesToTables(tx, stage, progression.sources);
    if (standingsHash(poolTableRowsAcrossSources(tables)) !== proposal.computed.standingsHash) {
      await tx`update stage_seed_proposals set status = 'stale' where id = ${proposal.id}`;
      throw new HttpError(409, "standings changed since this proposal was computed — recompute it first", "SEEDING_PROPOSAL_STALE");
    }
    // W5 app PR B T5 (F11, Review Focus 4): a 9.x draft over unequal pools with a best-Nth seat and no basis is re-proposed, never
    // confirmed (below, outside this transaction, which holds the division lock the re-proposal takes).
    if (preBumpBestNthDraft(progression, resolved.map((r) => r.id), tables, proposal.computed.qualifiers)) throw new PreBumpDraft();

    // Step 2 — apply edits + tiePicks over the computed slate.
    const bySlot = new Map(proposal.computed.qualifiers.map((q) => [q.destinationSlot, q.entrantId] as const));
    for (const edit of input.edits ?? []) {
      if (!bySlot.has(edit.destinationSlot)) {
        throw new HttpError(
          422,
          `edit references a slot this proposal doesn't have: ${edit.destinationSlot}`,
          "SEEDING_EDIT_UNKNOWN_SLOT",
        );
      }
      bySlot.set(edit.destinationSlot, edit.entrantId);
    }
    // Every flagged tie must be resolved by an edit or a tiePick covering
    // every one of its slots — never silently confirmed on the engine's
    // deterministic (seed/id) fallback (design: "a tie is FLAGGED, never
    // silently ordered").
    const editedSlots = new Set((input.edits ?? []).map((e) => e.destinationSlot));
    const pickedGroups = new Set((input.tiePicks ?? []).map((p) => [...p.slots].sort().join(",")));
    for (const tie of proposal.computed.ties) {
      const coveredByEdit = tie.slots.every((slot) => editedSlots.has(slot));
      const coveredByPick = pickedGroups.has([...tie.slots].sort().join(","));
      if (!coveredByEdit && !coveredByPick) {
        throw new HttpError(
          422,
          "a flagged tie is not resolved — supply an edit or a tiePick for every tied slot",
          "SEEDING_TIE_UNRESOLVED",
          { slots: tie.slots, entrantIds: tie.entrantIds },
        );
      }
    }
    if (drawn !== undefined && answers.length > 0) {
      // D-B2-1 (ruling, controller under the owner's standing "apply rec"): a pick fixes the ORDER of the tied entrants, then the
      // draw re-runs over the picked slate with the draft's stored seed - placing the pick seat by seat over the DRAWN slate
      // re-seated pool-mates against each other (live matrix F4: carrom, badminton). A picked slate the draw cannot separate is
      // refused by name, like every refused draw. Edits outside a tie stay the organiser's own seats, placed over the new draw.
      const redrawn = await redrawAnsweredTies(tx, stage, progression, { shapes, tables, resolved }, proposal.computed, answers, drawn.seed);
      const tiedSlots = new Set(proposal.computed.ties.flatMap((t) => t.slots));
      bySlot.clear();
      for (const [slot, entrantId] of redrawn) bySlot.set(slot, entrantId);
      for (const edit of input.edits ?? []) if (!tiedSlots.has(edit.destinationSlot)) bySlot.set(edit.destinationSlot, edit.entrantId);
    } else {
      for (const pick of input.tiePicks ?? []) {
        pick.slots.forEach((slot, i) => {
          const entrantId = pick.order[i];
          if (entrantId) bySlot.set(slot, entrantId);
        });
      }
    }

    // Step 3 — validate: bijection destinationSlot<->entrant, entrant ∈
    // division, no slot already filled.
    const finalSlots = [...bySlot.entries()];
    const entrantIds = finalSlots.map(([, id]) => id);
    if (new Set(entrantIds).size !== entrantIds.length) {
      throw new HttpError(422, "the same entrant is assigned to more than one slot", "SEEDING_SLOT_DOUBLE_ASSIGNED");
    }
    const known = await tx<{ id: string }[]>`
      select id from entrants where id in ${tx(entrantIds)} and division_id = ${stage.division_id}`;
    if (known.length !== new Set(entrantIds).size) {
      throw new HttpError(422, "a qualifier does not belong to this division", "SEEDING_ENTRANT_FOREIGN");
    }
    // ...and belongs to the FIELD, not merely to the division. A withdrawal
    // is a status flip, so a departed entrant is still `known` above — and
    // progression resolves over standings tables that deliberately still
    // carry her (see departedEntrantIds). This is the binding refusal: it
    // sits on the id set that is about to be FILLED, so it covers the
    // computed slate, an `edits[]` override and a `tiePicks[]` order alike,
    // and it catches a draft computed before the withdrawal (which the
    // freshness check above cannot see — a withdrawal leaves the frozen
    // standings snapshot, and therefore standingsHash, untouched).
    //
    // A refusal, not a silent drop: the organiser is told who has gone so
    // they can recompute, rather than discovering a short bracket later.
    // Deliberately NOT paired with a prune of the proposal row — an entrant
    // can be un-withdrawn (patchEntrant), and a recompute then offers her
    // again.
    const departed = await departedEntrantIds(tx, stage.division_id);
    const departedQualifiers = [...new Set(entrantIds)].filter((id) => departed.has(id));
    if (departedQualifiers.length > 0) {
      throw new HttpError(
        422,
        "a qualifier has withdrawn from this division — recompute the proposal",
        "SEEDING_ENTRANT_WITHDRAWN",
        { entrantIds: departedQualifiers },
      );
    }
    // #554 — a bye seed owns TWO destination slots (its own bye fixture's
    // slot AND the winner-feed target's slot), but the wire-level
    // `destinationSlot` above names only one of them (computeSeedProposal's
    // single-slot display convention — see its comment). Expand every wire
    // slot into every slot sharing its seed so BOTH get filled, through the
    // SAME fillSlot pathway used everywhere else (D4a/P5 scope item 3), not
    // a second one. Re-derive fresh rather than trust the draft's persisted
    // `computed` (which, by the same wire convention, only ever recorded one
    // slot per seed) — `rank` on each persisted qualifier IS the seed
    // destinationSlotsBySeed keys on, so this is an exact re-lookup, not a
    // re-derivation of the proposal itself.
    const seedByWireSlot = new Map(proposal.computed.qualifiers.map((q) => [q.destinationSlot, q.rank] as const));
    const freshSlotsBySeed = await destinationSlotsBySeed(tx, stageId);
    const expandedSlots = new Map<string, string>();
    for (const [wireSlot, entrantId] of finalSlots) {
      const seed = seedByWireSlot.get(wireSlot);
      const siblings = seed !== undefined ? freshSlotsBySeed.get(seed) : undefined;
      for (const slot of siblings && siblings.length > 0 ? siblings : [wireSlot]) {
        expandedSlots.set(slot, entrantId);
      }
    }
    const expandedEntries = [...expandedSlots.entries()];

    // F1 (review finding, 2026-09-21) — a proposal with NOTHING left to fill
    // must not be confirmable. Before the departed-qualifier filter,
    // `computed.qualifiers` was never empty for a resolvable progression; it
    // can be now (withdraw every qualifier of a small bracket), and the draft
    // panel's only control is Confirm. Pressing it used to succeed with
    // `filled: 0` and flip the proposal to the TERMINAL `confirmed` state —
    // after which Recompute 409s SEEDING_ALREADY_CONFIRMED forever, including
    // after un-withdrawing everybody, leaving a knockout final at
    // `{home: null, away: null, scheduled}` with no way back through the
    // product. Refusing here leaves the row `draft`, so a recompute still
    // works: that is the whole point, and a refusal that also confirmed would
    // be the same trap with extra steps.
    if (expandedEntries.length === 0) {
      throw new HttpError(
        422,
        "nobody is left to seed into this stage — recompute the proposal once the field is settled",
        "SEEDING_NOTHING_TO_FILL",
      );
    }

    const fixtureIds = [...new Set(expandedEntries.map(([slot]) => slot.split(":")[0] as string))];
    const fixtureRows = await tx<{ id: string; home_entrant_id: string | null; away_entrant_id: string | null }[]>`
      select id, home_entrant_id, away_entrant_id from fixtures
      where id in ${tx(fixtureIds)} and stage_id = ${stageId}`;
    const fixtureById = new Map(fixtureRows.map((f) => [f.id, f]));
    for (const [slot] of expandedEntries) {
      const [fixtureId, side] = slot.split(":");
      const fixture = fixtureId ? fixtureById.get(fixtureId) : undefined;
      if (!fixture) {
        throw new HttpError(422, `destinationSlot names a fixture outside this stage: ${slot}`, "SEEDING_SLOT_FOREIGN_FIXTURE");
      }
      const already = side === "home" ? fixture.home_entrant_id : fixture.away_entrant_id;
      if (already !== null) {
        throw new HttpError(409, `slot ${slot} is already filled`, "SEEDING_FIXTURES_ALREADY_FILLED");
      }
    }

    // Step 4 — single transaction: fill through fillSlot, mark confirmed.
    const filledFixtureIds = new Set<string>();
    for (const [slot, entrantId] of expandedEntries) {
      const [fixtureId, side] = slot.split(":");
      const filledId = await fillSlot(tx, fixtureId as string, side === "home" ? 1 : 2, entrantId);
      if (filledId !== null) filledFixtureIds.add(filledId);
    }
    // F2 (review finding, 2026-09-21) — the seeds this bracket PUBLISHED that
    // no qualifier is going to fill. The entrant who would have taken one has
    // left the field, and nobody is promoted into a vacancy (owner ruling
    // 2026-09-21), so the slot stays empty — but it kept its
    // `slot.winner_group` label, and a line with one real entrant, one
    // labelled-TBD side and a null outcome is EXACTLY an ordinary match
    // awaiting a draw. Driven on a real division it rendered
    // "Winner of Group A vs Driver 2 — Awaiting draw", counted in
    // "1 to schedule", forever: `isBye` (lib/run-sheet-groups) needs
    // `outcome.kind === "award"`, which nothing was ever going to write.
    //
    // Stamping the vacated side as a BYE hands it to `awardSeededByes` just
    // below — already in this transaction, and written for this exact shape —
    // which awards the walkover to whoever IS in the line. That delivers the
    // owner's ruling (the opponent advances; nobody is promoted) through the
    // path that already exists, rather than a second one.
    //
    // Keyed on the SLOT, not on "which entrant departed": a slot the fill
    // loop did not touch is vacated whatever the reason. Guarded on the seat
    // still being null so a partial re-confirm cannot relabel a filled side.
    //
    // RETRACTION (2026-09-21, re-review). The first round of this work
    // reported the `!expandedSlots.has(slot)` filter as independently
    // load-bearing, on the reasoning that it "protects a slot expanded but
    // silently unfilled". That is FALSE and is withdrawn: the
    // `SEEDING_FIXTURES_ALREADY_FILLED` check above refuses the whole confirm
    // if any expanded slot is non-null BEFORE this loop runs, so every one of
    // them is null going in and filled coming out — the `*_entrant_id is null`
    // predicate below refuses exactly the rows the filter would. Each guard
    // alone is an equivalent mutant (verified: neither kills a test on its
    // own). What makes the filter load-bearing is the doubly-vacated branch
    // just above, which VOIDS a line — drop the filter and every seeded line
    // looks doubly vacated and the whole bracket is abandoned. Dropping both
    // guards together relabels a seated qualifier as a bye, which
    // "a FULL slate stamps no bye anywhere" in vacated-seat-advancement
    // catches. Recorded because a wrong reason that survives is worse than an
    // uncovered line: the next reader would trust this filter to be doing
    // something it is not.
    //
    // NOT symmetrical with the `on_complete` path's own answer
    // (`walkoverDepartedQualifiers`), which seats the departed qualifier and
    // records a TWO-SIDED forfeit. There the published draw — `config.qualified`,
    // frozen at the previous stage's completion — NAMES her, so her line is a
    // match that was drawn and then conceded. Here the draw is published AT
    // confirm time and does not name her at all, so the line is a bye: the
    // bracket is simply short a player. The difference shows up in the
    // standings (a forfeit is a played match, a bye is a sit-out); if the
    // owner wants one shape for both, this is the place to change.
    const vacatedSlots = [...freshSlotsBySeed.values()].flat().filter((slot) => !expandedSlots.has(slot));
    // ...unless BOTH published seats of a line vacated, which is reachable
    // whenever enough of the bottom of the draw leaves (seeds 4 and 5 of an
    // eight-slot bracket are each other's opponent). Stamping two byes there
    // leaves a `scheduled` fixture with nobody in it that `awardSeededByes`
    // cannot settle — it needs one real seat — so it would sit on the run
    // sheet as a playable match forever. Same owner ruling as the generation
    // path (re-review C2): a walkover needs a LIVE RECIPIENT, and where there
    // is none the line is VOID and advances nobody. `abandoned` is the void's
    // value in this column; see the insert in generateStageFixturesWrite.
    const vacatedSides = new Map<string, Set<string>>();
    for (const slot of vacatedSlots) {
      const [fixtureId, side] = slot.split(":");
      const sides = vacatedSides.get(fixtureId as string) ?? new Set<string>();
      sides.add(side as string);
      vacatedSides.set(fixtureId as string, sides);
    }
    for (const [fixtureId, sides] of vacatedSides) {
      if (sides.size < 2) continue;
      const [voidedRow] = await tx<{ id: string }[]>`
        update fixtures set status = 'abandoned'
        where id = ${fixtureId} and stage_id = ${stageId}
          and home_entrant_id is null and away_entrant_id is null
          and status = 'scheduled' and outcome is null
        returning id`;
      if (voidedRow) filledFixtureIds.add(voidedRow.id);
    }
    for (const slot of vacatedSlots) {
      const [fixtureId, side] = slot.split(":");
      if ((vacatedSides.get(fixtureId as string)?.size ?? 0) >= 2) continue;
      if (side === "home") {
        await tx`update fixtures set home_slot_label = ${tx.json(BYE_SLOT_LABEL as never)}
                 where id = ${fixtureId} and stage_id = ${stageId} and home_entrant_id is null`;
      } else {
        await tx`update fixtures set away_slot_label = ${tx.json(BYE_SLOT_LABEL as never)}
                 where id = ${fixtureId} and stage_id = ${stageId} and away_entrant_id is null`;
      }
    }

    // A bye seat just became a real entrant's, so the walkover the plain path
    // bakes at generation time can finally be recorded — see awardSeededByes.
    // AFTER the fills, in the SAME transaction: it reads the entrant ids they
    // just wrote. The decided lines join `filledFixtureIds` so the post-commit
    // publish below drops and re-pushes them too — their match centre now
    // shows a settled walkover rather than a fixture waiting on a draw.
    // A bye seat just became a real entrant's, so the walkover the plain path
    // bakes at generation time can finally be recorded, its winner advanced,
    // and any seat whose feeder just turned out to be permanently dead settled
    // behind it — all of it through `resolveBracketSeats`, the ONE cascade.
    // AFTER the fills, in the SAME transaction: it reads the entrant ids they
    // just wrote. The lines it settles join `filledFixtureIds` so the
    // post-commit publish below drops and re-pushes them too — their match
    // centre now shows a settled walkover rather than a fixture waiting on a
    // draw.
    for (const id of await resolveBracketSeats(tx, stageId)) filledFixtureIds.add(id);
    const [division] = await tx<{ competition_id: string }[]>`
      select competition_id from divisions where id = ${stage.division_id}`;
    await tx`update stage_seed_proposals set status = 'confirmed', confirmed_at = now() where id = ${proposal.id}`;

    const carryMode = (progression as { carry?: "none" | "points" | "full" }).carry ?? "none";
    if (carryMode !== "none") {
      // Belt beside propose-time guard — stale drafts from before Task 2 may
      // still reach confirm; re-check against the same freshness-verified
      // `resolved` sourcesToTables just read for the hash.
      const nonReal = nonRealCarrySource(resolved);
      if (nonReal) {
        throw new HttpError(422, carrySourceRefusal(nonReal.kind), "SEEDING_CARRY_SOURCE_INVALID", {
          stageId: nonReal.id,
          kind: nonReal.kind,
          carry: carryMode,
        });
      }
      const entrants = [...new Set(expandedEntries.map(([, id]) => id))];
      const carriedDeltas = buildCarryDeltas(tables, entrants, carryMode);
      // Server-side merge (design §T2) — see seedNextStage's write.
      await tx`
        update stages set config = config || ${tx.json({ carry_deltas: carriedDeltas } as never)}
        where id = ${stageId}`;
      const [{ seq: last }] = await tx<{ seq: number }[]>`
        select coalesce(max(seq), 0)::int as seq from division_events
        where division_id = ${stage.division_id}`;
      const nextSeq = last + 1;
      await insertStandingsCarriedEvent(tx, stage.division_id, nextSeq, {
        stageId,
        from: resolved[resolved.length - 1]!.id,
        mode: carryMode,
        entrants,
      });
      await tx`update divisions set seq = ${nextSeq} where id = ${stage.division_id}`;
    }

    // W4 T5 (K1): the confirm is an undo barrier. Its fills went through `fillSlot`, which no ledger step records, so an
    // Undo after it inverted the step BEFORE it — this bracket's own day-one generation — and deleted the seeded draw.
    // One `seed_confirmed` row, LAST (after any carry event) and under the `division:` lock taken above: Undo, Redo and
    // Restore refuse to step across it by name (history.ts `UNDO_BARRIER_TYPES`). Its writer moves the division's token
    // and never the watermark.
    const { appendUndoBarrierRow } = await import("../swiss-late-entry");
    await appendUndoBarrierRow(
      tx,
      stage.division_id,
      "seed_confirmed",
      {
        stage_id: stageId,
        proposal_id: proposal.id,
        source: "organiser",
        // W4 app PR B (C1/C12): the field this confirm DREW, in seed order - the bracket's drawn roster. A seat a later
        // withdrawal empties and stamps dead keeps no entrant id on the fixture, so completion reads who was drawn from here
        // (`bracketRosterAndSeeds`): a withdrawn stepladder seed is ranked at the rung she was due to enter (X-SP-4) instead of
        // vanishing from the ranks.
        entrants: [...new Map(finalSlots.map(([slot, entrantId]) => [entrantId, seedByWireSlot.get(slot) ?? Number.MAX_SAFE_INTEGER] as const)).entries()]
          .sort((a, b) => a[1] - b[1])
          .map(([entrantId]) => entrantId),
      },
      auth.userId,
    );

    const fixturesRaw = await tx<Omit<FixtureRow, "court_name">[]>`
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
    const fixtures = fixturesRaw.map((f) => ({
      ...f,
      court_name: f.court_id !== null ? (courtNames.get(f.court_id) ?? f.court_id) : null,
    }));
    return {
      filled: expandedEntries.length,
      fixtures,
      divisionId: stage.division_id,
      competitionId: division!.competition_id,
      filledFixtureIds: [...filledFixtureIds],
      kind: stage.kind,
    };
  }).catch(async (e: unknown) => {
    if (!(e instanceof PreBumpDraft)) throw e;
    const fresh = await computeSeedProposal(auth, stageId);
    throw new HttpError(409, "this draft was made before the unequal-pool comparison changed; it was re-proposed - review the new draft", "SEEDING_PROPOSAL_STALE", {
      reproposed: fresh.id,
    });
  });

  log.info(
    { event: "stage_seeded", stageId, proposalId: input.proposalId, edits: input.edits?.length ?? 0 },
    "stage_seeded",
  );
  // W2d concern 2 (review I3): the seats are filled — a `timing: "setup"` table stage's table exists from here, LEVEL,
  // the same way the generate writes one (its placeholders had none to show, the generate's RULING).
  await refoldStageTable(auth.orgId, { id: stageId, kind: committed.kind }, "skip");
  await fireStageRevalidate(auth.orgId, stageId);
  // R10g (review-r10f G1): the confirm names entrants into the bracket, and the
  // hub and each filled fixture's match centre show those names. So after the
  // commit, ONE `afterScheduleWrite` drops the hub key plus exactly the
  // fixtures this write filled (from fillSlot's own `returning id`), pushes the
  // division once that DEL settles, then pushes each filled fixture (capped,
  // same contract as every schedule write). A refused confirm throws out of
  // the transaction above and never reaches this line, so it sends nothing.
  afterScheduleWrite(committed.divisionId, committed.competitionId, "schedule", committed.filledFixtureIds);

  // Step 5 — post-commit: re-run schedule validation so newly-real person
  // clashes surface as warnings, run not blocked (design's Fill algorithm;
  // crossPersonClash already skips TBD slots — usecases/schedule/
  // peopleOf()). Best-effort: a validation hiccup must not undo a fill that
  // already committed.
  try {
    await validateSchedule(auth, committed.divisionId);
  } catch {
    // best-effort, see above
  }

  return { proposalId: input.proposalId, filled: committed.filled, fixtures: committed.fixtures };
}