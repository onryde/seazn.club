// A division's fixture list has ONE order (T4 review, minor 3, 2026-09-27):
// round, match within the round, then the stage's seq, then the fixture's id.
//
// The public reads ordered by (round_no, seq_in_round) alone. Round 1 match 1
// of a league and round 1 match 1 of its knockout tie on that, and so do the
// pools' round 1 match 1 inside one group stage. Tied rows came back in
// whatever order the plan produced: physical row order when Postgres walks
// the (division_id, round_no, seq_in_round) index, a sort's order when it
// scans and sorts. `sortHubMatches` is stable, so for undated and same-time
// matches the hub list showed exactly that order, and a plan change (T4 moved
// plans) could swap a league R1M1 and a knockout R1M1 on the page.
//
// How the scene makes each key's loss visible without controlling where
// Postgres stores the rows (it cannot: on a used database the free-space map
// scatters even one INSERT's rows over part-full pages):
//   - stage seq: the later stage's fixture has the LOWEST id of all, so an
//     order that falls through to the id puts it first. Red on every plan.
//   - id: six pools' round 1 match 1 in one stage, written in DESCENDING id
//     order. Stored on one page they come back in that wrong order; scattered,
//     in some permutation that is id order only by a 1-in-720 chance. The
//     first test checks the scene did witness it, so that chance shows as a
//     red premise, never as a green that could not fail.
//
// The competition's "Live now" strip is the same question with a LIMIT: it
// shows 12 in-play matches ordered by start time, and when more than 12 share
// one start time, which 12 made the cut was the plan's choice. It ends on the
// fixture id now; the last block below pins that.
//
// Its scene cannot rely on write order alone. With 20 tied rows the sort keeps
// its input order, so the cut is the first 12 rows the plan reads, and that
// order is controlled only for some plans. An index walk on
// (division_id, round_no, seq_in_round) or on (division_id, fixture_no)
// follows keys the scene chooses. But a used database plans on
// (division_id, scheduled_at), where every row ties, so the plan reads heap
// order, as does a sequential scan. Heap order on a used table is a rotation:
// the first rows written fill the backend's current page at a HIGH block, and
// the rest go to free-space-map pages at LOWER blocks. With the ids written
// highest first, a first run of 8 or more rows put exactly the 12 lowest ids
// first. That happened in CI (PR #888, the "Smoke — DB + Redis suites" job).
// So the ids are written LOW, LOW, HIGH, LOW, HIGH, four times over: no run of
// more than two low ids exists, even read round the end, so no rotation, no
// reversal and no key-ordered walk can start with twelve of them. Shuffling
// whole pages can still do it only if the 20 rows sit on 15 or more pages,
// and in that case the premise test goes red instead of passing without
// proving anything.
//
// Real Postgres required; skipped without DATABASE_URL.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

vi.mock("next/cache", () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown) => fn,
  revalidateTag: vi.fn(),
  revalidatePath: vi.fn(),
}));

import { sql } from "@/lib/db";
import { embedDivisionData } from "@/server/embed-data";
import { createCompetition } from "@/server/usecases/competitions";
import { createDivision } from "@/server/usecases/divisions";
import { publicSchedule } from "@/server/usecases/public";
import { GENERIC_CONFIG, seedOrg } from "@/server/usecases/__tests__/_seed";
import { loadCompetitionHub } from "../competition-hub";
import {
  getPublicCompetition,
  getPublicDivision,
  readPublicCompetitionShell,
  readPublicDivisionDetail,
  type PublicDivision,
} from "../data";

const HAS_DB = !!process.env.DATABASE_URL;

/** A fresh uuid whose first byte is `prefix`, so the id order is chosen, not drawn. */
const idWithPrefix = (prefix: string) => prefix + randomUUID().slice(2);

const POOL_KEYS = ["A", "B", "C", "D", "E", "F"] as const;

let orgSlug: string;
let compSlug: string;
let division: PublicDivision;
/** The groups stage's round 1 match 1 rows, ascending id. */
let groupTies: string[];
/** In the order the loaders must return them. */
let expected: string[];

beforeAll(async () => {
  if (!HAS_DB) return;
  const { auth } = await seedOrg("pro");
  const [org] = await sql<{ slug: string }[]>`select slug from organizations where id = ${auth.orgId}`;
  const competition = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Order Cup " + randomUUID().slice(0, 6),
    visibility: "public",
    branding: {},
  });
  const div = await createDivision(auth, competition.id, {
    name: "Order",
    slug: "order",
    sport_key: "generic",
    variant_key: "score",
    config: GENERIC_CONFIG,
  });
  const [groups] = await sql<{ id: string }[]>`
    insert into stages (division_id, org_id, seq, kind, name, config)
    values (${div.id}, ${auth.orgId}, 1, 'group', 'Groups', ${sql.json({ pools: { count: POOL_KEYS.length } })})
    returning id`;
  const [finals] = await sql<{ id: string }[]>`
    insert into stages (division_id, org_id, seq, kind, name)
    values (${div.id}, ${auth.orgId}, 2, 'knockout', 'Finals')
    returning id`;
  const pools = await sql<{ id: string; key: string }[]>`
    insert into pools ${sql(POOL_KEYS.map((key) => ({ stage_id: groups!.id, org_id: auth.orgId, key, name: `Group ${key}` })))}
    returning id, key`;
  const poolId = (key: string) => pools.find((p) => p.key === key)!.id;

  // The knockout's round 1 match 1 has the lowest id of all.
  const finalR1 = idWithPrefix("00");
  groupTies = POOL_KEYS.map((_, i) => idWithPrefix(`${i + 1}0`));
  const groupR2 = idWithPrefix("f0");
  const rows = [
    { id: finalR1, stage: finals!.id, pool: null, round: 1, seq: 1 },
    // Highest id first.
    ...POOL_KEYS.map((key, i) => ({ id: groupTies[i]!, stage: groups!.id, pool: poolId(key), round: 1, seq: 1 })).reverse(),
    { id: groupR2, stage: groups!.id, pool: poolId("A"), round: 2, seq: 1 },
  ];
  await sql`
    insert into fixtures ${sql(
      rows.map((r, i) => ({
        id: r.id,
        stage_id: r.stage,
        division_id: div.id,
        org_id: auth.orgId,
        pool_id: r.pool,
        round_no: r.round,
        seq_in_round: r.seq,
        fixture_no: i + 1,
      })),
    )}`;
  expected = [...groupTies, finalR1, groupR2];

  orgSlug = org!.slug;
  compSlug = competition.slug;
  const shell = await getPublicCompetition(orgSlug, compSlug);
  division = shell!.divisions.find((d) => d.slug === "order")!;
}, 60_000);

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("a division's fixtures: round, match, stage seq, id", () => {
  it("without the tiebreak, no plan returns this scene's ties in order (so the checks below can fail)", async () => {
    const plans: Record<string, string[]> = {
      default: [],
      "index walk": ["enable_sort", "enable_bitmapscan", "enable_seqscan"],
      "scan and sort": ["enable_indexscan", "enable_bitmapscan", "enable_indexonlyscan"],
    };
    for (const [name, off] of Object.entries(plans)) {
      const ids = await sql.begin(async (tx) => {
        for (const s of off) await tx.unsafe(`set local ${s} = off`);
        return (
          await tx<{ id: string }[]>`
            select v.id from public_fixtures_v v
            where v.division_id = ${division.id}
            order by v.round_no, v.seq_in_round`
        ).map((r) => r.id);
      });
      expect(ids.toSorted(), name).toEqual(expected.toSorted());
      // The pools' ties are out of id order: dropping the id key is visible.
      expect(ids.filter((id) => groupTies.includes(id)), name).not.toEqual(groupTies);
      expect(ids, name).not.toEqual(expected);
    }
  });

  it("readPublicDivisionDetail, concurrent and sequential", async () => {
    expect((await readPublicDivisionDetail(division)).fixtures.map((f) => f.id)).toEqual(expected);
    expect((await readPublicDivisionDetail(division, { sequential: true })).fixtures.map((f) => f.id)).toEqual(expected);
  });

  it("getPublicDivision", async () => {
    expect((await getPublicDivision(orgSlug, compSlug, "order"))!.fixtures.map((f) => f.id)).toEqual(expected);
  });

  it("embedDivisionData", async () => {
    const embed = await embedDivisionData(division.id);
    if (!embed.ok) throw new Error(`embed not served: ${embed.reason}`);
    expect(embed.data.fixtures.map((f) => f.id)).toEqual(expected);
  });

  it("the API v1 public schedule", async () => {
    const doc = (await publicSchedule(orgSlug, compSlug, "order")) as { fixtures: { id: string }[] };
    expect(doc.fixtures.map((f) => f.id)).toEqual(expected);
  });

  it("the competition hub's match list, on the rebuild and the page path: undated ties keep that order through sortHubMatches", async () => {
    for (const uncached of [true, false]) {
      const doc = await loadCompetitionHub(orgSlug, compSlug, new Date(), { uncached });
      const matches = doc!.matches.filter((m) => m.divisionId === division.id);
      // Premise: all of them are undated and in one bucket, so only the input order decides.
      expect(new Set(matches.map((m) => `${m.bucket}:${m.scheduledAt}`)).size).toBe(1);
      expect(matches.map((m) => m.fixtureId), `uncached=${uncached}`).toEqual(expected);
    }
  });
});

describe.skipIf(!HAS_DB)("Live now: which 12 in-play matches show when more share a start time", () => {
  const LIVE = 20;
  const SHOWN = 12;
  let liveOrgSlug: string;
  let liveCompSlug: string;
  let liveCompetitionId: string;
  /** Every in-play fixture, ascending id. */
  let live: string[];

  beforeAll(async () => {
    if (!HAS_DB) return;
    const { auth } = await seedOrg("pro");
    const [org] = await sql<{ slug: string }[]>`select slug from organizations where id = ${auth.orgId}`;
    const competition = await createCompetition(auth, {
      ends_on: "2030-12-31",
      name: "Live Cup " + randomUUID().slice(0, 6),
      visibility: "public",
      branding: {},
    });
    const div = await createDivision(auth, competition.id, {
      name: "Live",
      slug: "live",
      sport_key: "generic",
      variant_key: "score",
      config: GENERIC_CONFIG,
    });
    const [stage] = await sql<{ id: string }[]>`
      insert into stages (division_id, org_id, seq, kind, name)
      values (${div.id}, ${auth.orgId}, 1, 'league', 'League')
      returning id`;
    live = Array.from({ length: LIVE }, (_, i) => idWithPrefix((i + 1).toString(16).padStart(2, "0")));
    const low = live.slice(0, SHOWN);
    const high = live.slice(SHOWN);
    // LOW, LOW, HIGH, LOW, HIGH, four times: 12 low and 8 high, and never
    // more than two low ids in a row, even round the end. The match number and
    // fixture number follow this write order, so the key-ordered index walks
    // interleave the ids too. All the rows share one start time.
    const written = [0, 1, 2, 3].flatMap((g) => [low[3 * g]!, low[3 * g + 1]!, high[2 * g]!, low[3 * g + 2]!, high[2 * g + 1]!]);
    const startsAt = new Date(Date.UTC(2030, 5, 1, 10));
    await sql`
      insert into fixtures ${sql(
        written.map((id, i) => ({
          id,
          stage_id: stage!.id,
          division_id: div.id,
          org_id: auth.orgId,
          round_no: 1,
          seq_in_round: i + 1,
          fixture_no: i + 1,
          status: "in_play",
          scheduled_at: startsAt,
        })),
      )}`;
    liveOrgSlug = org!.slug;
    liveCompSlug = competition.slug;
    liveCompetitionId = competition.id;
  }, 60_000);

  it("without the id tiebreak, the cut is not the lowest ids (so the check below can fail)", async () => {
    const lowest = new Set(live.slice(0, SHOWN));
    const plans: Record<string, string[]> = {
      default: [],
      "scan and sort": ["enable_indexscan", "enable_bitmapscan", "enable_indexonlyscan"],
    };
    for (const [name, off] of Object.entries(plans)) {
      const ids = await sql.begin(async (tx) => {
        for (const s of off) await tx.unsafe(`set local ${s} = off`);
        // readPublicCompetitionShell's liveNow query without its last sort
        // key. It keeps the same select list, because summary and last_seq keep
        // the view's match_states join in the plan.
        return (
          await tx<{ id: string }[]>`
            select f.id, f.division_id, f.stage_id, f.pool_id, f.round_no,
                   f.seq_in_round, f.home_entrant_id, f.away_entrant_id,
                   f.home_slot_label, f.away_slot_label,
                   f.scheduled_at, f.status, f.outcome,
                   f.summary, f.last_seq,
                   f.lane, f.is_final, f.third_place, f.conditional
            from public_fixtures_v f
            join public_divisions_v d on d.id = f.division_id
            where d.competition_id = ${liveCompetitionId} and f.status = 'in_play'
            order by f.scheduled_at nulls last limit 12`
        ).map((r) => r.id);
      });
      expect(ids, name).toHaveLength(SHOWN);
      expect(ids.every((id) => lowest.has(id)), name).toBe(false);
    }
  });

  it("the shell's liveNow is the lowest 12 ids, in id order", async () => {
    const shell = await readPublicCompetitionShell(liveOrgSlug, liveCompSlug);
    expect(shell!.liveNow.map((f) => f.id)).toEqual(live.slice(0, SHOWN));
  });
});
