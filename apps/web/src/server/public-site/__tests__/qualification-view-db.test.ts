// buildQualificationView through its REAL producer (AGENTS.md #1, the inert
// seam): the snapshot, fixtures, stage meta and entrant statuses come from
// `getPublicDivision` on a real Postgres after real scoring writes and real
// withdrawals — not hand fixtures on both ends. Every scene cross-checks the
// builder's statuses against the engine run on a remaining count read
// INDEPENDENTLY from the `fixtures` table, and asserts a view exists at all,
// because the guards (snapshot lag, F1, F2) all fail closed: a real shape they
// misread shows up here as a null, never as a wrong status. Skipped without
// DATABASE_URL (same convention as public-stages-qualification-db.test.ts).
import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

// `unstable_cache` is a Next server-runtime API with no incrementalCache
// outside a real request — passthrough, never a memoising double.
vi.mock("next/cache", () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown) => fn,
  revalidateTag: vi.fn(),
}));

import { qualificationStatus, type QualStatus } from "@seazn/engine/competition";
import { SETTLE_METHODS } from "@seazn/engine/core";
import { builtinModules } from "@seazn/engine/sports";
import en from "@/dictionaries/en/public.json";
import { sql } from "@/lib/db";
import { plural, t, type TKey } from "@/lib/i18n-runtime";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "@/server/usecases/competitions";
import { createDivision } from "@/server/usecases/divisions";
import { createEntrants } from "@/server/usecases/entrants";
import { startDivision } from "@/server/usecases/schedule";
import { scoreEvent } from "@/server/usecases/scoring";
import { createStages, generateStageFixtures } from "@/server/usecases/stages";
import { withdrawEntrantCascade } from "@/server/usecases/withdrawal";
import { GENERIC_CONFIG, seedOrg } from "@/server/usecases/__tests__/_seed";
import { getPublicDivision } from "../data";
import { qualificationFixtures } from "../division-qualification";
import { embedDivisionData } from "@/server/embed-data";
import { listDivisionFixtures } from "@/server/usecases/fixtures";
import {
  buildQualificationView,
  divisionAwardAddsToLedger,
  divisionPointsBounds,
  stageQualMeta,
  type QualificationView,
} from "../qualification-view";

const HAS_DB = !!process.env.DATABASE_URL;

interface Rig {
  auth: AuthCtx;
  divisionId: string;
  stageId: string;
  slugs: [string, string, string];
  /** display name → entrant id */
  id: Record<string, string>;
}

async function rig(kind: "league" | "swiss" | "group", names: string[], rounds?: number): Promise<Rig> {
  const { auth } = await seedOrg("pro");
  const suffix = randomUUID().slice(0, 8);
  // Created private and then moved: `createCompetition` silently writes a
  // public competition over the plan cap as PRIVATE.
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: `QV ${suffix}`, visibility: "private", branding: {} });
  await sql`update competitions set visibility = 'public' where id = ${comp.id}`;
  const divSlug = `open-${suffix}`;
  const div = await createDivision(auth, comp.id, {
    name: "Open",
    slug: divSlug,
    sport_key: "generic",
    variant_key: "score",
    config: GENERIC_CONFIG,
  });
  const entrants = await createEntrants(
    auth,
    div.id,
    names.map((n, i) => ({ kind: "individual" as const, display_name: n, seed: i + 1, members: [] })),
  );
  // Groups send ONE per pool: with two, a half-folded pool of four would be
  // refused by F3 (cut ≥ rows) before F2 is ever asked.
  const take = kind === "group" ? { kind: "topNPerGroup", n: 1 } : { kind: "rankRange", from: 1, to: 2 };
  const [table] = await createStages(auth, div.id, [
    { seq: 1, kind, name: "Table", config: kind === "swiss" ? { rounds } : kind === "group" ? { pools: { count: 2 } } : {} },
    {
      seq: 2,
      kind: "knockout",
      name: "Finals",
      config: {},
      progression: { sources: [{ stage: "previous", take: [take] }], placement: "rank_order", timing: "on_complete" },
    },
  ] as never);
  if (kind !== "swiss") {
    await generateStageFixtures(auth, table!.id);
    await startDivision(auth, div.id);
  } else {
    await startDivision(auth, div.id);
    await generateStageFixtures(auth, table!.id); // seats round 1
  }
  const [{ slug: orgSlug }] = await sql<{ slug: string }[]>`select slug from organizations where id = ${auth.orgId}`;
  return {
    auth,
    divisionId: div.id,
    stageId: table!.id,
    slugs: [orgSlug, comp.slug, divSlug],
    id: Object.fromEntries(entrants.map((e, i) => [names[i]!, e.id])),
  };
}

type Row = {
  id: string;
  pool_id: string | null;
  round_no: number;
  status: string;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
};
const fixturesOf = (r: Rig) => sql<Row[]>`
  select id, pool_id, round_no, status, home_entrant_id, away_entrant_id from fixtures
  where stage_id = ${r.stageId} order by round_no, seq_in_round`;

/** Decide every seated, unplayed board of `round` (optionally only the first
 *  `limit` of them, only `poolId`'s, none seating `sitOut`); the higher seed
 *  (earlier in `names`) wins. */
async function playRound(
  r: Rig,
  round: number,
  names: string[],
  limit = Infinity,
  poolId?: string,
  sitOut?: string,
): Promise<void> {
  const order = names.map((n) => r.id[n]!);
  let played = 0;
  for (const f of await fixturesOf(r)) {
    if (f.round_no !== round || f.status !== "scheduled" || !f.home_entrant_id || !f.away_entrant_id) continue;
    if (poolId !== undefined && f.pool_id !== poolId) continue;
    if (sitOut !== undefined && (f.home_entrant_id === sitOut || f.away_entrant_id === sitOut)) continue;
    if (played++ >= limit) break;
    const homeWins = order.indexOf(f.home_entrant_id) < order.indexOf(f.away_entrant_id);
    await scoreEvent(r.auth, f.id, { expected_seq: 0, type: "core.start", payload: {} });
    await scoreEvent(r.auth, f.id, {
      expected_seq: 1,
      type: "generic.result",
      payload: homeWins ? { p1Score: 3, p2Score: 1 } : { p1Score: 1, p2Score: 3 },
    });
  }
}

/** A real walkover: `loser` forfeits its round-`round` match (core.forfeit) before it starts. W2b: the forfeit reason
 *  is one of the engine's FORFEIT_REASONS (the free-text "no-show" is refused), and a `walkover` is a pre-start
 *  forfeit (D3) — so no `core.start` precedes it. */
async function forfeitRound(r: Rig, round: number, loser: string): Promise<void> {
  const id = r.id[loser]!;
  const f = (await fixturesOf(r)).find((x) => x.round_no === round && (x.home_entrant_id === id || x.away_entrant_id === id))!;
  await scoreEvent(r.auth, f.id, { expected_seq: 0, type: "core.forfeit", payload: { by: id, reason: "walkover" } });
}

/** Decide every seated, unplayed board of `round` (only `poolId`'s) for the entrant `winnerOf` names. */
async function playRoundBy(r: Rig, round: number, winnerOf: (f: Row) => string, poolId: string | null): Promise<number> {
  let played = 0;
  for (const f of await fixturesOf(r)) {
    if (f.round_no !== round || f.status !== "scheduled" || !f.home_entrant_id || !f.away_entrant_id) continue;
    if (poolId !== null && f.pool_id !== poolId) continue;
    const homeWins = winnerOf(f) === f.home_entrant_id;
    await scoreEvent(r.auth, f.id, { expected_seq: 0, type: "core.start", payload: {} });
    await scoreEvent(r.auth, f.id, {
      expected_seq: 1,
      type: "generic.result",
      payload: homeWins ? { p1Score: 3, p2Score: 1 } : { p1Score: 1, p2Score: 3 },
    });
    played++;
  }
  expect(played, `round ${round} had boards to play`).toBeGreaterThan(0);
  return played;
}

async function load(
  r: Rig,
  poolId: string | null = null,
): Promise<{
  view: QualificationView | null;
  rows: { entrantId: string; points: number; played: number; metrics: Record<string, number> }[];
  statuses: Record<string, string>;
}> {
  const data = (await getPublicDivision(...r.slugs))!;
  expect(data).not.toBeNull();
  const stage = data.stages.find((s) => s.id === r.stageId)!;
  const snap = data.standings.find((s) => s.stage_id === r.stageId && s.pool_id === poolId);
  const module_ = builtinModules.find((m) => m.key === data.division.sport_key);
  const statuses = Object.fromEntries(data.entrants.map((e) => [e.id, e.status]));
  // W2d Task 9 (carry 5): the stage's table rules as the real read carries them (`PublicStage.table_rules`, the one
  // loader's) — its order, its rule in force and the outcomes it reaches — never the division's raw cfg re-read here.
  const rules = stage.table_rules;
  expect(rules, "the public read carries the stage's table rules").toBeTruthy();
  const view = buildQualificationView({
    stage: { id: stage.id, kind: stage.kind, meta: { ...stageQualMeta(stage), tablePointsRule: rules!.points } },
    poolId,
    rows: snap?.rows ?? [],
    // W2c X-PT-1: the played facts as the public surfaces read them (one read of the forfeit-shaped ledgers).
    fixtures: await qualificationFixtures(data.fixtures, module_, data.stages),
    entrantStatuses: statuses,
    bounds: null,
    reachable: new Set(rules!.reachable),
    primary: rules!.primary,
    awardAddsToLedger: divisionAwardAddsToLedger(module_, data.division.config),
    cascade: rules!.tiebreakers,
    entrantNames: Object.fromEntries(data.entrants.map((e) => [e.id, e.display_name])),
    msg: (k: TKey, v?: Record<string, string | number>) => t(en, k, v),
    plural: (k: string, n: number, v?: Record<string, string | number>) => plural(en, k, n, "en", v),
  });
  return { view, rows: snap?.rows ?? [], statuses };
}

/** The engine on the same snapshot, with remaining read straight from the
 *  fixtures table — NOT through the builder's own derivation. */
async function engineStatuses(
  r: Rig,
  rows: { entrantId: string; points: number }[],
  statuses: Record<string, string>,
  remaining: (id: string, fixtures: Row[]) => number,
  cut = 2,
): Promise<Map<string, QualStatus | null>> {
  const fixtures = await fixturesOf(r);
  expect(rows.length).toBeGreaterThan(0);
  const active = (id: string) => statuses[id] === "registered" || statuses[id] === "confirmed";
  const res = qualificationStatus({
    rows: rows.map((x) => ({ entrantId: x.entrantId, points: x.points, active: active(x.entrantId) })),
    remaining: new Map(rows.map((x) => [x.entrantId, remaining(x.entrantId, fixtures)])),
    perMatch: divisionPointsBounds(builtinModules.find((m) => m.key === "generic"), GENERIC_CONFIG)!,
    cut,
    anyPlayed: true,
    complete: false,
  })!;
  return new Map(rows.map((x) => [x.entrantId, res.get(x.entrantId)?.status ?? null]));
}
const leagueLeft = (id: string, fx: Row[]) =>
  fx.filter((f) => (f.status === "scheduled" || f.status === "in_play") && (f.home_entrant_id === id || f.away_entrant_id === id)).length;

function expectSameStatuses(view: QualificationView, engine: Map<string, QualStatus | null>): void {
  for (const [id, s] of engine) {
    if (s === null) expect(view.rows[id], id).toBeUndefined();
    else expect(view.rows[id]?.status, id).toBe(s.kind);
  }
}

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

const FOUR = ["Ann", "Ben", "Cat", "Dan"];

describe.skipIf(!HAS_DB)("buildQualificationView on real reads (getPublicDivision)", () => {
  it("empty case first: a started league with nothing played shows no status", async () => {
    const r = await rig("league", FOUR);
    expect((await load(r)).view).toBeNull();
  });

  it("league → Finals (top 2), two rounds of three played: a view, and the engine's statuses", async () => {
    const r = await rig("league", FOUR);
    await playRound(r, 1, FOUR);
    await playRound(r, 2, FOUR);
    const { view, rows, statuses } = await load(r);
    expect(view).not.toBeNull();
    expect(view!.table.cutIndex).toBe(2);
    expect(view!.table.label).toBe("Top 2 go through to Finals · 1 round left");
    expect(Object.keys(view!.rows).sort()).toEqual(Object.values(r.id).sort());
    expectSameStatuses(view!, await engineStatuses(r, rows, statuses, leagueLeft));
  });

  it("league with two REAL walkovers: the what-if reads the snapshot's own metric keys and leaves walkovers out of the average match", async () => {
    // Review fix round 1. r1: Ann and Cat forfeit (core.forfeit) to Dan and
    // Ben; r2: Dan beats Ben 3–1, Cat beats Ann 3–1. Dan 6 (+2), Cat 3 (+2),
    // Ben 3 (−2), Ann 0 (−2); r3 Ann–Ben, Cat–Dan to play.
    const r = await rig("league", FOUR);
    await forfeitRound(r, 1, "Ann");
    await forfeitRound(r, 1, "Cat");
    await playRound(r, 2, ["Dan", "Cat", "Ben", "Ann"]);
    // The premise: a real walkover is `forfeited` with an `award` outcome and
    // pays its points on NO ledger — Dan's goals are one match's worth.
    const wo = await sql<{ status: string; kind: string }[]>`
      select status, outcome->>'kind' as kind from fixtures where stage_id = ${r.stageId} and round_no = 1`;
    expect(wo).toEqual([
      { status: "forfeited", kind: "award" },
      { status: "forfeited", kind: "award" },
    ]);
    const { view, rows, statuses } = await load(r);
    const dan = rows.find((x) => x.entrantId === r.id.Dan!)!;
    expect(dan.played).toBe(2);
    expect(dan.metrics).toMatchObject({ for: 3, against: 1, diff: 2 });
    expect(view).not.toBeNull();
    expectSameStatuses(view!, await engineStatuses(r, rows, statuses, leagueLeft));
    // Dan is Win and in; a loss ties Ben (−2) on points. Margin −3 over ONE
    // real match of 4 goals is a target; with the walkover counted as a
    // second match the average halves and it would read "safe" instead.
    const d = view!.rows[r.id.Dan!]!;
    expect(d.label).toBe("Win and in");
    expect(d.ifYouLose).toBe("If you lose your next match, you'll need other results to go your way.");
    expect(d.whatIf).toBe(
      "If you finish level on points with Ben, difference decides: lose your next match by no more than 3 to finish ahead.",
    );
    expect(d.whatIfAssumption).toBe("Assumes Ben's figures stay the same and your next match is an average one.");
    // Real `diff` values, as the table prints them.
    expect(view!.rows[r.id.Cat!]!.whatIf).toBe("If you finish level on points with Ben, difference decides. Now: you +2, Ben -2.");
    expect(view!.rows[r.id.Ann!]!.ifYouLose).toBe("If you lose your next match, you're out.");
  });

  it("Swiss of five: round 1's real bye counts as the bye entrant's round (two left for everyone)", async () => {
    const FIVE = [...FOUR, "Eve"];
    const r = await rig("swiss", FIVE, 3);
    const fx = await fixturesOf(r);
    const byeRow = fx.find((f) => f.round_no === 1 && (f.home_entrant_id === null) !== (f.away_entrant_id === null));
    expect(byeRow?.status).toBe("forfeited");
    await playRound(r, 1, FIVE);
    const { view, rows, statuses } = await load(r);
    expect(view).not.toBeNull();
    // Rounds left = 3 − 1 for all five, the bye entrant included.
    expectSameStatuses(view!, await engineStatuses(r, rows, statuses, () => 2));
    expect(view!.table.label).toBe("Top 2 go through to Finals · 2 rounds left");

    // P2: seat round 2 (pairings out, nothing played). Seated is not played:
    // still two rounds left for everyone.
    await generateStageFixtures(r.auth, r.stageId);
    const seated = await fixturesOf(r);
    expect(seated.filter((f) => f.round_no === 2 && f.home_entrant_id !== null && f.away_entrant_id !== null).length).toBe(2);
    const after = await load(r);
    expect(after.view).not.toBeNull();
    expectSameStatuses(after.view!, await engineStatuses(r, after.rows, after.statuses, () => 2));
    expect(after.view!.table.label).toBe("Top 2 go through to Finals · 2 rounds left");
  });

  it("F2 on a real pooled stage: a pool member the snapshot has not folded yet hides that pool's status", async () => {
    const EIGHT = [...FOUR, "Eve", "Fay", "Gus", "Hal"];
    const r = await rig("group", EIGHT);
    const pools = [...new Set((await fixturesOf(r)).map((f) => f.pool_id))].filter((p): p is string => p !== null).sort();
    expect(pools.length).toBe(2);
    const pool = pools[0]!;
    // One match in the pool: two members have results, two have none yet.
    await playRound(r, 1, EIGHT, 1, pool);
    const partial = await load(r, pool);
    const members = new Set(
      (await fixturesOf(r)).filter((f) => f.pool_id === pool).flatMap((f) => [f.home_entrant_id, f.away_entrant_id]),
    );
    members.delete(null);
    expect(members.size).toBe(4);
    // The premise the guard exists for: the pooled snapshot folds only
    // members with results.
    expect(partial.rows.length).toBeLessThan(members.size);
    expect(partial.view).toBeNull();
    // The rest of the round: every member has a result, the snapshot has all
    // four, and the pool shows — with the engine's statuses on two left each.
    await playRound(r, 1, EIGHT, Infinity, pool);
    const full = await load(r, pool);
    expect(full.rows.length).toBe(4);
    expect(full.view).not.toBeNull();
    expect(full.view!.table.label).toBe("First place goes through to Finals · 2 rounds left");
    expectSameStatuses(full.view!, await engineStatuses(r, full.rows, full.statuses, leagueLeft, 1));
  });

  it("F2 on a real pooled stage: a leaver the snapshot FOLDED shows the pool (expunge cascade); a status-only leaver it never folded hides it", async () => {
    // Review fix rounds 1–2. Two real ways a pool member leaves before playing:
    const EIGHT = [...FOUR, "Eve", "Fay", "Gus", "Hal"];
    const scene = async () => {
      const r = await rig("group", EIGHT);
      const pool = [...new Set((await fixturesOf(r)).map((f) => f.pool_id))].filter((p): p is string => p !== null).sort()[0]!;
      const seated = [...new Set((await fixturesOf(r)).filter((f) => f.pool_id === pool).flatMap((f) => [f.home_entrant_id, f.away_entrant_id]))];
      const leaver = seated.filter((id): id is string => id !== null)[0]!;
      return { r, pool, leaver, others: seated.filter((id): id is string => id !== null && id !== leaver).sort() };
    };

    // (a) the organiser's withdrawal (withdrawEntrantCascade): nothing played,
    // so expunge. W2b (plan D5, PF-4): it abandons every leaver fixture with
    // `core.abandon{reason:"withdrew", expunge:true}` and NO outcome (before
    // W2b: a no_result the snapshot folded at 0), so the pooled snapshot does
    // not fold the leaver at all — and her lines are dead, so nothing of hers
    // is still to come and the pool resolves (unlike (b) below).
    const a = await scene();
    expect((await withdrawEntrantCascade(a.r.auth, a.leaver)).policy).toBe("expunge");
    await playRound(a.r, 1, EIGHT, Infinity, a.pool);
    await playRound(a.r, 2, EIGHT, Infinity, a.pool);
    const cascaded = await load(a.r, a.pool);
    const leaverFx = (await fixturesOf(a.r)).filter((f) => f.home_entrant_id === a.leaver || f.away_entrant_id === a.leaver);
    expect(leaverFx.map((f) => f.status)).toEqual(["abandoned", "abandoned", "abandoned"]);
    const outcomes = await sql<{ outcome: unknown }[]>`select outcome from fixtures where id in ${sql(leaverFx.map((f) => f.id))}`;
    expect(outcomes.map((f) => f.outcome), "D5: an expunge records no outcome").toEqual([null, null, null]);
    // Loop-F I-2: both public reads carry the expunge — getPublicDivision (the division page and the hub) and the
    // embed's own read — true on exactly her three lines, false on every other fixture of the division.
    const hers = new Set(leaverFx.map((f) => f.id));
    const flagged = (fx: readonly { id: string; expunged?: boolean }[]) => fx.filter((f) => f.expunged === true).map((f) => f.id).sort();
    const page = (await getPublicDivision(...a.r.slugs))!;
    expect(page.fixtures.length, "the page read has the division's fixtures").toBeGreaterThan(hers.size);
    expect(flagged(page.fixtures), "page read").toEqual([...hers].sort());
    expect(page.fixtures.every((f) => typeof f.expunged === "boolean"), "page read: every row says").toBe(true);
    const embed = await embedDivisionData(a.r.divisionId);
    if (!embed.ok) throw new Error(`rig: the embed is not served (${embed.reason})`);
    expect(flagged(embed.data.fixtures), "embed read").toEqual([...hers].sort());
    // …and the console's (the organiser's standings tab builds the same view from listDivisionFixtures).
    expect(flagged(await listDivisionFixtures(a.r.auth, a.r.divisionId)), "console read").toEqual([...hers].sort());
    expect(cascaded.rows.map((x) => x.entrantId).sort()).toEqual(a.others);
    expect(cascaded.view).not.toBeNull();
    expect(cascaded.view!.rows[a.leaver]).toBeUndefined();
    expect(cascaded.view!.table.label).toBe("First place goes through to Finals · 1 round left");
    expectSameStatuses(cascaded.view!, await engineStatuses(a.r, cascaded.rows, cascaded.statuses, leagueLeft, 1));

    // (b) a registrant's self-cancel (registrations.ts) moves ONLY the entrant
    // status: the leaver's fixtures stay scheduled with no result, so the
    // pooled snapshot never folds it. Its place is kept and its carry-over
    // folds in with any later result (an organiser forfeit: the cascade will
    // not run on an already-withdrawn entrant), so its points are unknown and
    // the pool fails closed (owner-accepted, fix round 2).
    const b = await scene();
    await sql`update entrants set status = 'withdrawn' where id = ${b.leaver}`;
    await playRound(b.r, 1, EIGHT, Infinity, b.pool, b.leaver);
    await playRound(b.r, 2, EIGHT, Infinity, b.pool, b.leaver);
    const selfCancel = await load(b.r, b.pool);
    expect(selfCancel.statuses[b.leaver]).toBe("withdrawn");
    expect(selfCancel.rows.map((x) => x.entrantId).sort()).toEqual(b.others);
    expect((await fixturesOf(b.r)).filter((f) => f.home_entrant_id === b.leaver || f.away_entrant_id === b.leaver).map((f) => f.status)).toEqual([
      "scheduled",
      "scheduled",
      "scheduled",
    ]);
    expect(selfCancel.view).toBeNull();
  });

  it("F1 award mode through the real cascade: the leaver gets no status, the rest do, walkovers counted", async () => {
    const r = await rig("league", FOUR);
    await playRound(r, 1, FOUR);
    await playRound(r, 2, FOUR);
    const out = await withdrawEntrantCascade(r.auth, r.id.Ann!);
    expect(out.policy).toBe("walkover");
    const { view, rows, statuses } = await load(r);
    expect(view).not.toBeNull();
    expect(view!.rows[r.id.Ann!]).toBeUndefined();
    expectSameStatuses(view!, await engineStatuses(r, rows, statuses, leagueLeft));
  });

  // W2c X-AB-5 / N2 (post-merge item), through the REAL producers: a scorer's plain abandon (core.start, core.abandon) is
  // stored `abandoned` with no outcome - the same row a generator's void is - and only its ledger says the desk holds it.
  // The public table reads the completion predicate over the fixture rows `getPublicDivision`/the embed/the console hand
  // it, so the flag must travel on all three. Expected statuses are the ENGINE's, with the remaining count read from the
  // `fixtures` table and the ledger by raw SQL here - not through the builder's derivation.
  const heldIds = async (r: Rig): Promise<Set<string>> =>
    new Set(
      (
        await sql<{ id: string }[]>`
        select f.id from fixtures f where f.stage_id = ${r.stageId} and f.status = 'abandoned'
          and exists (select 1 from score_events a where a.fixture_id = f.id and a.type = 'core.abandon'
            and coalesce(a.payload ->> 'expunge', 'false') <> 'true'
            and not exists (select 1 from score_events v where v.fixture_id = a.fixture_id and v.voids_event_id = a.id))`
      ).map((x) => x.id),
    );
  const SETTLE_BY_ORGANISER = SETTLE_METHODS.find((m) => m === "organiser")!;
  const evAt = async (id: string) => (await sql<{ s: number }[]>`select coalesce(max(seq), 0)::int as s from score_events where fixture_id = ${id}`)[0]!.s;
  const post = async (r: Rig, id: string, type: string, payload: unknown = {}) =>
    scoreEvent(r.auth, id, { expected_seq: await evAt(id), type, payload } as never);

  const DECIDED = ["through", "out"];
  for (const kind of ["league", "group"] as const) {
    it(`${kind}: a plain abandon is HELD - the table decides nobody by it; the settle decides them (real rows, real ledger)`, async () => {
      const NAMES = kind === "league" ? FOUR : [...FOUR, "Eve", "Fay", "Gus", "Hal"];
      const r = await rig(kind, NAMES);
      const pool = kind === "group" ? [...new Set((await fixturesOf(r)).map((f) => f.pool_id))].filter((p): p is string => p !== null).sort()[0]! : null;
      const cut = kind === "group" ? 1 : 2;
      // A scene where the last round's top board is what the table hangs on: the table's four are P, Q (round 3's board
      // that will be abandoned) and R, S (the other). P wins both its earlier matches; Q beats S and loses to R - so
      // before round 3 P has 6, Q and R 3, S 0, and P-Q decides the top places (the shape of `open4` in the builder's tests).
      const r3 = (await fixturesOf(r)).filter((f) => f.round_no === 3 && (pool === null || f.pool_id === pool));
      expect(r3.length, "round 3 has two boards in the table").toBe(2);
      const board = r3[0]!;
      const [P, Q, R] = [board.home_entrant_id!, board.away_entrant_id!, r3[1]!.home_entrant_id!];
      const winnerOf = (f: Row): string => {
        const seated = [f.home_entrant_id, f.away_entrant_id];
        if (seated.includes(P)) return P;
        return seated.includes(Q) && seated.includes(R) ? R : Q;
      };
      await playRoundBy(r, 1, winnerOf, pool);
      await playRoundBy(r, 2, winnerOf, pool);

      const open = (f: Row) => f.status === "scheduled" || f.status === "in_play";
      const left = (counts: (f: Row) => boolean) => (id: string, fx: Row[]) =>
        fx.filter((f) => counts(f) && (pool === null || f.pool_id === pool) && (f.home_entrant_id === id || f.away_entrant_id === id)).length;
      const kindOf = (m: Map<string, QualStatus | null>, id: string) => m.get(id)?.kind;
      // The entrants the engine decides when the board is gone (the void reading the old code gave) and does not decide
      // while it is still to come. Before the abandon the board is scheduled, which IS the held reading.
      const pre = await load(r, pool);
      const heldPre = await engineStatuses(r, pre.rows, pre.statuses, left(open), cut);
      const gonePre = await engineStatuses(r, pre.rows, pre.statuses, left((f) => open(f) && f.id !== board.id), cut);
      const affected = [...heldPre.keys()].filter((id) => DECIDED.includes(kindOf(gonePre, id)!) && !DECIDED.includes(kindOf(heldPre, id)!));
      expect(affected.length, `${kind}: somebody's fate hangs on the board (read as void it would decide them)`).toBeGreaterThan(0);

      await post(r, board.id, "core.start");
      await post(r, board.id, "core.abandon", { reason: "rain" });
      expect((await fixturesOf(r)).find((f) => f.id === board.id)!.status, "the rig recorded the abandon").toBe("abandoned");
      const held = await heldIds(r);
      expect([...held], "the ledger says it is held").toEqual([board.id]);

      // The flag travels on every public read - page, embed, console - true on exactly the held board, a boolean on every row.
      const page = (await getPublicDivision(...r.slugs))!;
      const embed = await embedDivisionData(r.divisionId);
      if (!embed.ok) throw new Error(`rig: the embed is not served (${embed.reason})`);
      for (const [where, fixtures] of [
        ["page", page.fixtures],
        ["embed", embed.data.fixtures],
        ["console", await listDivisionFixtures(r.auth, r.divisionId)],
      ] as const) {
        expect(fixtures.length, `${where}: the division's fixtures`).toBeGreaterThan(2);
        expect(fixtures.every((f) => typeof f.has_active_abandon === "boolean"), `${where}: every row says`).toBe(true);
        expect(fixtures.filter((f) => f.has_active_abandon === true).map((f) => f.id), `${where}: held`).toEqual([board.id]);
      }

      const { view, rows, statuses } = await load(r, pool);
      expect(view, "a view exists: the table is still open").not.toBeNull();
      const heldReading = await engineStatuses(r, rows, statuses, left((f) => open(f) || held.has(f.id)), cut);
      const voidReading = await engineStatuses(r, rows, statuses, left(open), cut);
      expectSameStatuses(view!, heldReading);
      expect(affected.length).toBeGreaterThan(0);
      for (const id of affected) {
        expect(DECIDED, `${id}: the void reading would decide them`).toContain(kindOf(voidReading, id));
        expect(DECIDED, `${id}: the held match leaves them undecided`).not.toContain(view!.rows[id]!.status);
      }

      // The settle turns it into a result (P wins): the match is decided and the table decides again.
      await post(r, board.id, "core.settle", { winner: P, method: SETTLE_BY_ORGANISER });
      expect((await fixturesOf(r)).find((f) => f.id === board.id)!.status, "the settle decided it").toBe("decided");
      expect([...(await heldIds(r))], "nothing is held any more").toEqual([]);
      const after = await load(r, pool);
      expect(after.view).not.toBeNull();
      expectSameStatuses(after.view!, await engineStatuses(r, after.rows, after.statuses, left(open), cut));
      expect(Object.values(after.view!.rows).filter((x) => DECIDED.includes(x.status)).length, "the settled table decides somebody").toBeGreaterThan(0);
    });
  }

  it("F1 expunge: a status flip under 50% played hides the table; the real expunge cascade (nothing left to void) does not", async () => {
    const flip = await rig("league", FOUR);
    await playRound(flip, 1, FOUR);
    await sql`update entrants set status = 'withdrawn' where id = ${flip.id.Ann!}`;
    expect((await load(flip)).view).toBeNull();

    const cascade = await rig("league", FOUR);
    await playRound(cascade, 1, FOUR);
    const out = await withdrawEntrantCascade(cascade.auth, cascade.id.Ann!);
    expect(out.policy).toBe("expunge");
    const { view, rows, statuses } = await load(cascade);
    expect(view).not.toBeNull();
    expect(view!.rows[cascade.id.Ann!]).toBeUndefined();
    expectSameStatuses(view!, await engineStatuses(cascade, rows, statuses, leagueLeft));
  });
});
