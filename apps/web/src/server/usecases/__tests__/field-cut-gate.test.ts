// W5 Task 12b (X-BD-8, RB5-E6): a cut larger than the field, or a best-Nth cut no pool can supply, is refused by name - at the pre-Start
// doors, at a `timing: "setup"` stage's Generate, and at resolve (the on_complete path), with the SAME numbers the builder refuses with
// (lib/__tests__/field-cut-gate.test.ts holds the pure rule, swept against the engine). Real Postgres; skipped without DATABASE_URL.
// The expected numbers are the rulebook's: a snake deals n entrants into pools of floor(n/p) or one more, and (RB5-U7, ruling 286; W5 app
// PR B T4, K16) a pool shorter than the nth supplies no best-Nth candidate, so 7 into 3 pools (3, 2 and 2) supply ONE best 3rd: every
// winner and two best 3rds (5 of 7) is refused, every winner and one best 3rd draws. (Under 9.x every pool had to hold the nth, so 7
// into 4 + 3 refused a best 4th; it now resolves - the 4-pool supplies it - lib/__tests__/field-cut-gate.test.ts K16.)
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { builtinModules } from "@seazn/engine/sports";
import { entrantKindCap } from "@seazn/engine/sport";
import type { SourceShape, SourceTables, StandingsRow, TakeRule } from "@seazn/engine/competition";
import { sql, withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { appendEvent } from "@/server/engine-db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { startDivision } from "../schedule";
import { completeStage, computeSeedProposal, createStages, generateStageFixtures, rebuildStageFixtures } from "../stages";
import { withdrawEntrantCascade } from "../withdrawal";
import { refuseCutBeyondTables } from "../stages/cut-gate";
import { refuseFormatTooSmall } from "../stages";
import { cutEligiblePools } from "../stage-seeding";
import { GENERIC_CONFIG, seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

interface SportPick { key: string; variant: string; kind: "individual" | "pair" | "team" }
const BADMINTON: SportPick = { key: "badminton", variant: "bwf", kind: "individual" };
/** The second sport, from the engine's own declarations: its default entrant kind and first variant. */
const FOOTBALL: SportPick = (() => {
  const m = builtinModules.find((x) => x.key === "football");
  const variant = m === undefined ? undefined : Object.keys(m.variants)[0];
  if (m === undefined || variant === undefined) throw new Error("the engine declares no football module");
  return { key: m.key, variant, kind: (m.entrantModel?.defaultKind ?? "team") as SportPick["kind"] };
})();
const GENERIC: SportPick = { key: "generic", variant: "score", kind: "individual" };

function entrantInput(kind: SportPick["kind"], name: string, seed: number) {
  const seats = Math.min(2, entrantKindCap(kind));
  return {
    kind, display_name: name, seed,
    members: Array.from({ length: seats }, (_, i) => ({ new_person: { full_name: `${name} m${i + 1} ${randomUUID().slice(0, 4)}` }, is_captain: false, roles: [] })),
  };
}

type StageInput = Parameters<typeof createStages>[2];

/** A division of `n` seeded entrants with `stages` created (nothing generated). Stage ids come back in seq order. */
async function rig(n: number, stages: StageInput, sport: SportPick) {
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "W5 T12b " + randomUUID().slice(0, 6), visibility: "private", branding: {} });
  const division = await createDivision(auth, comp.id, { name: "Open", slug: "open-" + randomUUID().slice(0, 6), sport_key: sport.key, variant_key: sport.variant, config: sport.key === "generic" ? GENERIC_CONFIG : {} });
  const made = await createEntrants(auth, division.id, Array.from({ length: n }, (_, i) => entrantInput(sport.kind, `P${i + 1}`, i + 1)));
  const created = await createStages(auth, division.id, stages);
  return { auth, divisionId: division.id, stageIds: [...created].sort((a, b) => a.seq - b.seq).map((s) => s.id), entrantIds: made.map((e) => e.id) };
}

// The engine's TakeRule is wider than the stored schema's (it also names `picks` and `firstLosses`); every rule used here is in both.
const cut = (take: TakeRule[], timing: "setup" | "on_complete") => ({ sources: [{ stage: "previous" as const, take: take as never }], placement: "rank_order" as const, timing });
const LEAGUE_KO = (take: TakeRule[], timing: "setup" | "on_complete" = "setup"): StageInput => [
  { seq: 1, kind: "league", name: "League", config: { legs: 1 }, progression: null },
  { seq: 2, kind: "knockout", name: "Finals", config: {}, progression: cut(take, timing) },
];
const GROUPS_KO = (pools: number, take: TakeRule[], timing: "setup" | "on_complete" = "setup"): StageInput => [
  { seq: 1, kind: "group", name: "Groups", config: { legs: 1, pools: { count: pools } }, progression: null },
  { seq: 2, kind: "knockout", name: "Finals", config: {}, progression: cut(take, timing) },
];

const fixtureCount = async (stageId: string) => {
  const [{ f }] = await sql<{ f: string }[]>`select count(*)::text as f from fixtures where stage_id = ${stageId}`;
  return Number(f);
};

async function refusal(promise: Promise<unknown>): Promise<HttpError> {
  try {
    await promise;
  } catch (e) {
    if (e instanceof HttpError) return e;
    throw e;
  }
  throw new Error("expected the call to be refused, but it resolved");
}

describe.skipIf(!HAS_DB)("X-BD-8 setup path: a cut the roster cannot supply is refused by name, and nothing is written (both sports)", () => {
  // differential: today this Generate drew placeholder lines for a top 8 of 6, and the engine met the cut only at Complete.
  it("X-BD-8 setup path: league + knockout, a top 8 of 6 is refused naming 6, writes nothing; a top 6 of 6 draws", async () => {
    let checked = 0;
    for (const sport of [BADMINTON, FOOTBALL]) {
      const r = await rig(6, LEAGUE_KO([{ kind: "rankRange", from: 1, to: 8 }]), sport);
      const err = await refusal(generateStageFixtures(r.auth, r.stageIds[1]!));
      expect(err.status, sport.key).toBe(422);
      expect(err.code, sport.key).toBe("RR_CUT_EXCEEDS_FIELD");
      expect(err.extra, sport.key).toMatchObject({ qualified: 8, max: 6, reason: "cut_exceeds_field", stageId: r.stageIds[1] });
      expect(err.message, sport.key).toBe("8 can't qualify from this field: it can supply at most 6.");
      expect(await fixtureCount(r.stageIds[1]!), `${sport.key}: nothing written`).toBe(0);

      // The pin: a cut equal to the field draws.
      const ok = await rig(6, LEAGUE_KO([{ kind: "rankRange", from: 1, to: 6 }]), sport);
      const out = await generateStageFixtures(ok.auth, ok.stageIds[1]!);
      expect(out.created, `${sport.key}: a cut equal to the field draws`).toBeGreaterThan(0);
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("X-BD-8 setup path: groups + knockout, a best-Nth cut the pools cannot supply is refused naming 3 (7 into 3 + 2 + 2), and one best 3rd draws", async () => {
    let checked = 0;
    for (const sport of [BADMINTON, FOOTBALL]) {
      // Every pool's winner and the two best 3rds: only the 3-pool has a 3rd (RB5-U7), so the pot of two cannot fill.
      const take: TakeRule[] = [{ kind: "topNPerGroup", n: 1 }, { kind: "bestNth", nth: 3, count: 2, normaliseUnequalPools: true }];
      const r = await rig(7, GROUPS_KO(3, take), sport);
      const err = await refusal(generateStageFixtures(r.auth, r.stageIds[1]!));
      expect(err.code, sport.key).toBe("RR_CUT_EXCEEDS_FIELD");
      expect(err.extra, sport.key).toMatchObject({ qualified: 5, max: 3, reason: "bestnth_unsuppliable" });
      expect(await fixtureCount(r.stageIds[1]!), sport.key).toBe(0);

      // differential (K16): under 9.x the two 2-pools refused any best 3rd; RB5-U7 leaves them out and the 3-pool supplies one.
      const ok = await rig(7, GROUPS_KO(3, [{ kind: "topNPerGroup", n: 1 }, { kind: "bestNth", nth: 3, count: 1, normaliseUnequalPools: true }]), sport);
      expect((await generateStageFixtures(ok.auth, ok.stageIds[1]!)).created, `${sport.key}: every winner and one best 3rd draws`).toBeGreaterThan(0);
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("X-BD-8 Start refuses the same graph before it writes (the pre-Start door), and the refusal goes with the cut", async () => {
    const r = await rig(6, LEAGUE_KO([{ kind: "rankRange", from: 1, to: 8 }]), BADMINTON);
    const err = await refusal(startDivision(r.auth, r.divisionId));
    expect(err.code).toBe("RR_CUT_EXCEEDS_FIELD");
    expect(err.extra).toMatchObject({ qualified: 8, max: 6 });
    const [{ s }] = await sql<{ s: string }[]>`select status as s from divisions where id = ${r.divisionId}`;
    expect(s, "the division did not start").not.toBe("active");
    expect(await fixtureCount(r.stageIds[0]!), "and the first stage was not drawn").toBe(0);
  });

  it("X-BD-8 after Start the Generate is not this gate's: a withdrawal is the table's to settle", async () => {
    // Pre-Start only, as `refuseFormatTooSmall`'s knockout doors are. The division is active here (set directly: Start would refuse).
    const r = await rig(6, LEAGUE_KO([{ kind: "rankRange", from: 1, to: 8 }]), BADMINTON);
    await sql`update divisions set status = 'active' where id = ${r.divisionId}`;
    const out = await generateStageFixtures(r.auth, r.stageIds[1]!);
    expect(out.created).toBeGreaterThan(0);
  });
});

describe.skipIf(!HAS_DB)("X-BD-8 the gate holds before Start only: Rebuild is refused on a cut over the field, and allowed after a withdrawal once the division runs", () => {
  // differential (review I2): the cut half sat inside `refuseFormatTooSmall`, which Rebuild asks unconditionally, so after Start a withdrawal
  // (a Top 6 of 6, now 5 on the roster) made Rebuild refuse "6 can't qualify from this field". After Start the table settles it (B3: departed rows stay).
  it("X-BD-8 before Start: Rebuild of the root league is refused naming 6 (a Top 8 of 6), and the stage is untouched", async () => {
    const r = await rig(6, LEAGUE_KO([{ kind: "rankRange", from: 1, to: 8 }]), BADMINTON);
    await generateStageFixtures(r.auth, r.stageIds[0]!);
    const before = await fixtureCount(r.stageIds[0]!);
    expect(before, "premise: the league is drawn").toBeGreaterThan(0);
    const err = await refusal(rebuildStageFixtures(r.auth, r.stageIds[0]!));
    expect(err.code).toBe("RR_CUT_EXCEEDS_FIELD");
    expect(err.extra).toMatchObject({ qualified: 8, max: 6 });
    expect(await fixtureCount(r.stageIds[0]!)).toBe(before);
  });

  it("X-BD-8 after Start, with a withdrawal that leaves the roster under the cut: Rebuild is allowed (a Top 6 of 6, one leaves)", async () => {
    const r = await rig(6, LEAGUE_KO([{ kind: "rankRange", from: 1, to: 6 }]), BADMINTON);
    expect((await startDivision(r.auth, r.divisionId)).started).toBe(true);
    await withdrawEntrantCascade(r.auth, r.entrantIds[5]!);
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from entrants where division_id = ${r.divisionId} and status in ('registered', 'confirmed')`;
    expect(n, "premise: the roster is now 5, under the cut of 6").toBe(5);
    // The door every pre-draw call asks: it answers, where it refused this field naming 6 before the fix. (Rebuild itself then refuses for the
    // withdrawal's own recorded walkover - a different, older rule - so the door is asked directly as well as through Rebuild.)
    await withTenant(r.auth.orgId, (tx) => refuseFormatTooSmall(tx, r.divisionId));
    const err = await refusal(rebuildStageFixtures(r.auth, r.stageIds[0]!));
    expect(err.code, "Rebuild's refusal, if any, is not the cut's").not.toBe("RR_CUT_EXCEEDS_FIELD");
  });
});

/** Decide every fixture of a stage: the lower seed wins (generic score). */
async function decideAll(auth: AuthCtx, stageId: string): Promise<void> {
  const rows = await sql<{ id: string; h: number; a: number }[]>`
    select f.id, eh.seed as h, ea.seed as a from fixtures f
      join entrants eh on eh.id = f.home_entrant_id join entrants ea on ea.id = f.away_entrant_id
     where f.stage_id = ${stageId}`;
  for (const f of rows) {
    await appendEvent(auth.orgId, f.id, 0, { type: "core.start", payload: {} });
    await appendEvent(auth.orgId, f.id, 1, { type: "generic.result", payload: f.h < f.a ? { p1Score: 2, p2Score: 0 } : { p1Score: 0, p2Score: 2 } });
  }
}

// Generic scoring only: writing a result is sport-specific, and the gate reads tables and counts, never a sport (the setup-path
// tests above run both sports).
describe.skipIf(!HAS_DB)("X-BD-8 on_complete path: refused by name where the engine's refusal was swallowed", () => {
  // differential: today the engine's STAGE_NOT_READY ("pool B takes rank 4, but only 3 entrants are available") is caught best-effort
  // by completeStage, so the stage completed, nothing was seeded, and nobody was told.
  it("X-BD-8 on_complete path: the SAVE door now refuses the unsuppliable cut by name first (7 into 3 pools: every winner + two best 3rds), writing nothing", async () => {
    const take: TakeRule[] = [{ kind: "topNPerGroup", n: 1 }, { kind: "bestNth", nth: 3, count: 2, normaliseUnequalPools: true }];
    const err = await refusal(rig(7, GROUPS_KO(3, take, "on_complete"), GENERIC));
    expect(err.status).toBe(422);
    expect(err.code).toBe("RR_CUT_EXCEEDS_FIELD");
    // The save door names what the Add stage form's own split can fill, not the cut's raw supply (3): 7 into 3 + 2 + 2 hold three
    // winners and three runners-up, so four through (every winner + the best runner-up) is the nearest count below 5 the form offers.
    expect(err.extra).toMatchObject({ qualified: 5, max: 4, reason: "bestnth_unsuppliable" });
  });

  it("X-BD-8 on_complete path: refused by name on the desk, never swallowed; the completion stands", async () => {
    // 7 into 3 pools (3, 2, 2); the next stage asks on completion for every winner and the two best 3rds: one pool has a 3rd. The save
    // door refuses that cut (the test above), so the stage is saved with a cut the field supplies and its progression is then written
    // past the door - a row stored before the door existed, the shape the resolve backstop is for.
    const take: TakeRule[] = [{ kind: "topNPerGroup", n: 1 }, { kind: "bestNth", nth: 3, count: 2, normaliseUnequalPools: true }];
    const r = await rig(7, GROUPS_KO(3, [{ kind: "topNPerGroup", n: 1 }], "on_complete"), GENERIC);
    await sql`update stages set progression = ${sql.json(cut(take, "on_complete") as never)} where id = ${r.stageIds[1]!}`;
    await generateStageFixtures(r.auth, r.stageIds[0]!);
    await decideAll(r.auth, r.stageIds[0]!);
    const err = await refusal(completeStage(r.auth, r.stageIds[0]!));
    expect(err.status).toBe(422);
    expect(err.code).toBe("RR_CUT_EXCEEDS_FIELD");
    expect(err.extra).toMatchObject({ qualified: 5, max: 3, reason: "bestnth_unsuppliable", stageId: r.stageIds[0] });
    const [{ s }] = await sql<{ s: string }[]>`select status as s from stages where id = ${r.stageIds[0]}`;
    expect(s, "the stage's own completion committed before the seeding was tried").toBe("complete");
    const [{ q }] = await sql<{ q: unknown }[]>`select config->'qualified' as q from stages where id = ${r.stageIds[1]}`;
    expect(q, "nothing was seeded").toBeNull();
  });

  it("X-BD-8 on_complete path: a cut the tables supply completes and seeds (the pair of the refusal)", async () => {
    const r = await rig(7, GROUPS_KO(2, [{ kind: "topNPerGroup", n: 3 }], "on_complete"), GENERIC);
    await generateStageFixtures(r.auth, r.stageIds[0]!);
    await decideAll(r.auth, r.stageIds[0]!);
    const out = await completeStage(r.auth, r.stageIds[0]!);
    expect(out.completed).toBe(true);
    const [{ q }] = await sql<{ q: string[] | null }[]>`select config->'qualified' as q from stages where id = ${r.stageIds[1]}`;
    expect(q?.length, "six qualifiers seeded").toBe(6);
  });

  it("X-BD-8 the setup-timing proposal refuses the same shortfall by name (the resolve backstop)", async () => {
    // A division already running (a stage-2 Generate after Start is not gated), so the shortfall reaches the proposal.
    const r = await rig(7, GROUPS_KO(3, [{ kind: "topNPerGroup", n: 1 }, { kind: "bestNth", nth: 3, count: 2, normaliseUnequalPools: true }]), GENERIC);
    await sql`update divisions set status = 'active' where id = ${r.divisionId}`;
    await generateStageFixtures(r.auth, r.stageIds[1]!);
    await generateStageFixtures(r.auth, r.stageIds[0]!);
    await decideAll(r.auth, r.stageIds[0]!);
    // Complete wraps a proposal failure as "completed, but the next stage's seeding could not be prepared" (the stage stands); the
    // proposal itself, asked directly, says why by name.
    // B4 fix wave (12b m1): the wrap carries the cause by name and its numbers, so the desk can say the cut's own sentence.
    // differential: today the wrap's extra is {stageId, nextStageId} only, and the desk shows the server's English.
    const wrapped = await refusal(completeStage(r.auth, r.stageIds[0]!));
    expect(wrapped.code).toBe("STAGE_COMPLETED_SEEDING_FAILED");
    expect(wrapped.extra).toMatchObject({ cause: "RR_CUT_EXCEEDS_FIELD", qualified: 5, max: 3, stageId: r.stageIds[0], nextStageId: r.stageIds[1] });
    const err = await refusal(computeSeedProposal(r.auth, r.stageIds[1]!));
    expect(err.code).toBe("RR_CUT_EXCEEDS_FIELD");
    expect(err.extra).toMatchObject({ qualified: 5, max: 3, reason: "bestnth_unsuppliable" });
  });
});

describe("X-BD-8 the resolve check reads the table as it finished: a departed entrant keeps her row, so a withdrawal never shrinks the supply", () => {
  const row = (entrantId: string, rank: number): StandingsRow => ({ entrantId, played: 3, won: 0, drawn: 0, lost: 0, points: 0, metrics: {}, rank });
  const tableOf = (kind: string, sizes: number[]): { tables: SourceTables; shapes: SourceShape; kind: string } => ({
    kind,
    shapes: { poolKeys: kind === "group" ? sizes.map((_, i) => "ABCD"[i]!) : [] },
    tables: { pools: sizes.map((n, p) => ({ pool: kind === "group" ? "ABCD"[p]! : "", rows: Array.from({ length: n }, (_, i) => row(`e${p}-${i + 1}`, i + 1)) })) },
  });

  it("every table kind x a departed entrant: the cut of the table's size passes, one more is refused naming the size", () => {
    let checked = 0;
    for (const kind of ["league", "swiss", "group"]) {
      const sizes = kind === "group" ? [4, 4] : [8];
      const src = tableOf(kind, sizes);
      const departed = new Set([src.tables.pools[0]!.rows[1]!.entrantId]);
      const after = { pools: cutEligiblePools(kind, src.tables.pools, departed) };
      const take = (to: number): TakeRule[] => (kind === "group" ? [{ kind: "topNPerGroup", n: to / 2 }] : [{ kind: "rankRange", from: 1, to }]);
      expect(() => refuseCutBeyondTables([{ stage: "previous", take: take(8) }], [src.shapes], [after], [{ id: "s", kind }]), `${kind}: 8 of 8 with a departed row`).not.toThrow();
      const over: TakeRule[] = kind === "group" ? [{ kind: "topNPerGroup", n: 5 }] : [{ kind: "rankRange", from: 1, to: 9 }];
      try {
        refuseCutBeyondTables([{ stage: "previous", take: over }], [src.shapes], [after], [{ id: "s", kind }]);
        throw new Error(`${kind}: expected a refusal`);
      } catch (e) {
        expect(e, kind).toBeInstanceOf(HttpError);
        expect((e as HttpError).code).toBe("RR_CUT_EXCEEDS_FIELD");
        expect((e as HttpError).extra, kind).toMatchObject({ max: 8 });
      }
      checked++;
    }
    expect(checked).toBe(3);
  });

  it("a knockout, a ladder and an americano source are not this gate's (their cut is their own rule), and a pool the snapshot lacks holds none", () => {
    let checked = 0;
    for (const kind of ["knockout", "double_elim", "ladder", "americano"]) {
      const src = tableOf("league", [2]);
      expect(() => refuseCutBeyondTables([{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 9 }] }], [src.shapes], [src.tables], [{ id: "s", kind }]), kind).not.toThrow();
      checked++;
    }
    expect(checked).toBe(4);
    // Three pools by shape, two snapshots: the missing pool holds none, so not even the first wave (every pool's winner) can be supplied.
    const two = tableOf("group", [3, 3]);
    expect(() =>
      refuseCutBeyondTables([{ stage: "previous", take: [{ kind: "topNPerGroup", n: 1 }] }], [{ poolKeys: ["A", "B", "C"] }], [two.tables], [{ id: "s", kind: "group" }]),
    ).toThrow(/3 can't qualify from this field: it can supply at most 0\./);
  });
});
