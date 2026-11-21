// W5 B4 (stress F8; owner 2026-11-21, max entrants per format): a division too large to start is refused before it is built.
// Start drew every line of the first stage in one request, and a 200-entrant league (19,900 lines) took 196 s. Each format's max
// is the largest field whose first-stage draw fits the measured Start line budget (`lib/format-max-entrants.ts`), and the server
// refuses a field past it by name at every door that draws a first stage (Start, a Generate before it) and at the doors that set
// the format (stage create, a format change). A draw no field bounds (an americano's courts x rounds) is held to the budget by
// its exact count.
//
// Expected values come from the engine (`roundRobinFixtureCount`, `generateAmericano`) and the rulebook's snake deal (pool sizes
// differ by at most one), never from the gate under test. One sport: the gate is sport-agnostic (it reads the stage graph and the
// active roster, before any sport work), so badminton, as the W5 suites use.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { generateAmericano, roundRobinFixtureCount } from "@seazn/engine/scheduling";
import { sql } from "@/lib/db";
import { formatMaxEntrants, START_LINE_BUDGET } from "@/lib/format-max-entrants";
import { v1 } from "@/server/api-v1/http";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants, deleteEntrant } from "../entrants";
import { createPerson } from "../persons";
import { startDivision } from "../schedule";
import { createStages, generateStageFixtures } from "../stages";
import { patchSwissStage } from "../swiss-rounds-admin";
import { seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;
afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

const LEAGUE = { kind: "league", config: { legs: 1 } };
// Eight legs: the cheapest table whose max is a small field (the engine's count, pinned below), so a started-at-max case costs ~5,000
// lines rather than a 100-entrant roster's worth of sign-ups and a 4,950-line Start.
const LEAGUE_8 = { kind: "league", config: { legs: 8 } };
const FOUR_POOLS = { kind: "group", config: { legs: 1, pools: { count: 4 } } };

async function rig(entrants: number, stage?: { kind: string; config: Record<string, unknown> }, withPersons = false) {
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "F8 " + randomUUID().slice(0, 6), visibility: "private", branding: {} });
  const d = await createDivision(auth, comp.id, { name: "Open", slug: "f8-" + randomUUID().slice(0, 6), sport_key: "badminton", variant_key: "bwf", config: {} } as never);
  // The format first, then the sign-ups, as a division fills: the create door sees an empty field, and the draw doors the full one.
  const stageId = stage === undefined ? null : (await createStages(auth, d.id, { seq: 1, name: "Stage", progression: null, ...stage } as never))[0]!.id;
  // An americano rotates PLAYERS into pairs, so its entrants are linked to people (`americanoGen`).
  const member = async (name: string) =>
    withPersons ? [{ person_id: (await createPerson(auth, { full_name: name, consent: {}, dob: null, gender: null, external_ref: null } as never)).id, is_captain: false, roles: [], default_position_key: null, squad_number: null }] : [];
  await createEntrants(auth, d.id, (await Promise.all(Array.from({ length: entrants }, async (_, i) => ({ kind: "individual", display_name: `P${i + 1}`, seed: i + 1, members: await member(`P${i + 1}`) })))) as never);
  return { auth, divisionId: d.id, stageId };
}

/** The route's envelope for a usecase call: status, and the error body the client reads. */
async function routed(fn: () => Promise<unknown>) {
  const res = await v1(fn);
  const json = (await res.json()) as { error?: { code: string; message: string; max?: number; entrants?: number; lines?: number; budget?: number } };
  return { status: res.status, error: json.error };
}

const linesOf = async (divisionId: string) => Number((await sql<{ n: number }[]>`select count(*)::int as n from fixtures where division_id = ${divisionId}`)[0]!.n);
const statusOf = async (divisionId: string) => (await sql<{ status: string }[]>`select status from divisions where id = ${divisionId}`)[0]!.status;

describe("F8: the maxes these doors read are the engine's", () => {
  it("a league's max is the largest field whose round robin fits the budget; four pools' is where the snake-dealt pools do", () => {
    const league = formatMaxEntrants(LEAGUE)!;
    expect(roundRobinFixtureCount(league, 1)).toBeLessThanOrEqual(START_LINE_BUDGET);
    expect(roundRobinFixtureCount(league + 1, 1)).toBeGreaterThan(START_LINE_BUDGET);
    const pools = formatMaxEntrants(FOUR_POOLS)!;
    // The snake deal: four pools whose sizes differ by at most one.
    const dealt = (n: number) => [0, 1, 2, 3].map((i) => Math.floor(n / 4) + (i < n % 4 ? 1 : 0));
    const lines = (n: number) => dealt(n).reduce((sum, size) => sum + roundRobinFixtureCount(size, 1), 0);
    expect(lines(pools)).toBeLessThanOrEqual(START_LINE_BUDGET);
    expect(lines(pools + 1)).toBeGreaterThan(START_LINE_BUDGET);
  });
});

describe.skipIf(!HAS_DB)("F8: Start refuses a field past its format's max, by name, before it writes", () => {
  it("league at max + 1: 422 FORMAT_TOO_MANY_ENTRANTS with the max and the field; no line, the division unstarted", { timeout: 180_000 }, async () => {
    const max = formatMaxEntrants(LEAGUE)!;
    const r = await rig(max + 1, LEAGUE);
    const before = await statusOf(r.divisionId);
    const out = await routed(() => startDivision(r.auth, r.divisionId));
    expect(out.status).toBe(422);
    expect(out.error).toMatchObject({ code: "FORMAT_TOO_MANY_ENTRANTS", max, entrants: max + 1 });
    expect(out.error!.message).toContain(String(max));
    expect(out.error!.message, "no unfilled placeholder").not.toMatch(/\{\w+\}/);
    expect(await linesOf(r.divisionId)).toBe(0);
    expect(await statusOf(r.divisionId)).toBe(before);
  });

  it("league at max: starts, drawing the engine's round robin of the field", { timeout: 180_000 }, async () => {
    const max = formatMaxEntrants(LEAGUE)!;
    const r = await rig(max, LEAGUE);
    const out = await routed(() => startDivision(r.auth, r.divisionId));
    expect(out.status).toBe(200);
    expect(await linesOf(r.divisionId)).toBe(roundRobinFixtureCount(max, 1));
    expect(await statusOf(r.divisionId)).toBe("active");
  });

  it("four pools at max + 1: refused by the same name; at max: starts, its pools' lines landing exactly on the budget", { timeout: 180_000 }, async () => {
    const max = formatMaxEntrants(FOUR_POOLS)!;
    const over = await rig(max + 1, FOUR_POOLS);
    const refused = await routed(() => startDivision(over.auth, over.divisionId));
    expect(refused.status).toBe(422);
    expect(refused.error).toMatchObject({ code: "FORMAT_TOO_MANY_ENTRANTS", max, entrants: max + 1 });
    expect(await linesOf(over.divisionId)).toBe(0);

    const at = await rig(max, FOUR_POOLS);
    expect((await routed(() => startDivision(at.auth, at.divisionId))).status).toBe(200);
    const perPool = await sql<{ n: number }[]>`
      select count(distinct e.id)::int as n
        from fixtures f join lateral (values (f.home_entrant_id), (f.away_entrant_id)) e(id) on true
       where f.division_id = ${at.divisionId} and e.id is not null group by f.pool_id`;
    expect(perPool.map((p) => p.n).sort(), "the snake deal: sizes differ by at most one").toEqual([0, 1, 2, 3].map((i) => Math.floor(max / 4) + (i < max % 4 ? 1 : 0)).sort());
    const lines = await linesOf(at.divisionId);
    expect(lines).toBe(perPool.reduce((sum, p) => sum + roundRobinFixtureCount(p.n, 1), 0));
    // The case an exclusive bound gets wrong: this field's draw IS the budget.
    expect(lines).toBe(START_LINE_BUDGET);
  });

  it("a Generate before Start is the same door: league at max + 1 refused, nothing drawn", { timeout: 180_000 }, async () => {
    const max = formatMaxEntrants(LEAGUE)!;
    const r = await rig(max + 1, LEAGUE);
    const out = await routed(() => generateStageFixtures(r.auth, r.stageId!));
    expect(out.status).toBe(422);
    expect(out.error).toMatchObject({ code: "FORMAT_TOO_MANY_ENTRANTS", max, entrants: max + 1 });
    expect(await linesOf(r.divisionId)).toBe(0);
  });
});

describe.skipIf(!HAS_DB)("F8: the create door refuses a format the division's field is already past", () => {
  it("a league as the first stage of a field of max + 1: refused, no stage written; at max: created", { timeout: 120_000 }, async () => {
    const max = formatMaxEntrants(LEAGUE)!;
    const over = await rig(max + 1);
    const out = await routed(() => createStages(over.auth, over.divisionId, { seq: 1, name: "League", progression: null, ...LEAGUE } as never));
    expect(out.status).toBe(422);
    expect(out.error).toMatchObject({ code: "FORMAT_TOO_MANY_ENTRANTS", max, entrants: max + 1 });
    expect((await sql`select 1 from stages where division_id = ${over.divisionId}`).length).toBe(0);

    const at = await rig(max);
    expect((await routed(() => createStages(at.auth, at.divisionId, { seq: 1, name: "League", progression: null, ...LEAGUE } as never))).status).toBe(200);
  });

  it("a league added AFTER a knockout first stage is not asked: the format still starts with the knockout", { timeout: 120_000 }, async () => {
    const leagueMax = formatMaxEntrants(LEAGUE)!;
    const knockoutMax = formatMaxEntrants({ kind: "knockout", config: {} })!;
    expect(knockoutMax, "premise: the knockout takes the field the league cannot").toBeGreaterThan(leagueMax + 1);
    const r = await rig(leagueMax + 1, { kind: "knockout", config: {} });
    const out = await routed(() => createStages(r.auth, r.divisionId, { seq: 2, name: "Later league", progression: null, ...LEAGUE } as never));
    expect(out.status).toBe(200);
  });
});

describe.skipIf(!HAS_DB)("F8: a draw no field bounds is held to the budget by its exact count", () => {
  // Eight players on two courts: the engine's own americano rotation for `rounds`, counted, never courts x rounds typed here.
  const PLAYERS = Array.from({ length: 8 }, (_, i) => `p${i}`);
  const engineLines = (rounds: number) => generateAmericano(PLAYERS, { mode: "americano", courtCount: 2, rounds }).reduce((sum, r) => sum + r.matches.length, 0);
  /** The most rounds whose rotation fits the budget ("at"), or one more ("past"): doubled, then halved, on the engine's count. */
  const roundsTo = (target: "at" | "past") => {
    let lo = 1;
    let hi = 2;
    while (engineLines(hi) <= START_LINE_BUDGET) [lo, hi] = [hi, hi * 2];
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      if (engineLines(mid) <= START_LINE_BUDGET) lo = mid;
      else hi = mid;
    }
    return target === "at" ? lo : lo + 1;
  };

  it("past the budget: 422 DRAW_TOO_LARGE with the lines and the budget, nothing written; at it: drawn", { timeout: 180_000 }, async () => {
    expect(formatMaxEntrants({ kind: "americano", config: {} }), "premise: no field max bounds an americano").toBeNull();
    const past = roundsTo("past");
    const over = await rig(8, { kind: "americano", config: { mode: "americano", courtCount: 2, rounds: past } }, true);
    const out = await routed(() => generateStageFixtures(over.auth, over.stageId!));
    expect(out.status).toBe(422);
    expect(out.error).toMatchObject({ code: "DRAW_TOO_LARGE", lines: engineLines(past), budget: START_LINE_BUDGET });
    expect(out.error!.message, "no unfilled placeholder").not.toMatch(/\{\w+\}/);
    expect(await linesOf(over.divisionId)).toBe(0);

    const at = roundsTo("at");
    const ok = await rig(8, { kind: "americano", config: { mode: "americano", courtCount: 2, rounds: at } }, true);
    expect((await routed(() => generateStageFixtures(ok.auth, ok.stageId!))).status).toBe(200);
    expect(await linesOf(ok.divisionId)).toBe(engineLines(at));
  });
});

/** One more entrant through the organiser's own add (`createEntrants`): after Start that is the late-entry door, which places the
 *  newcomer's catch-up lines (`admitTableLateEntrant`, source "organiser"); before Start it only joins the field. */
async function addOne(r: { auth: Awaited<ReturnType<typeof rig>>["auth"]; divisionId: string }, name: string) {
  const [row] = (await createEntrants(r.auth, r.divisionId, [{ kind: "individual", display_name: name, seed: 999, members: [] }] as never)) as { id: string }[];
  return row!.id;
}

describe.skipIf(!HAS_DB)("F8: only a STARTED division's passes are exempt (B4 review I-2, m-1)", () => {
  it("premise: an eight-leg league's max is the engine's - the largest field whose 8 legs fit the budget", () => {
    const max = formatMaxEntrants(LEAGUE_8)!;
    expect(roundRobinFixtureCount(max, 8)).toBeLessThanOrEqual(START_LINE_BUDGET);
    expect(roundRobinFixtureCount(max + 1, 8)).toBeGreaterThan(START_LINE_BUDGET);
    expect(max, "a small field, so the cases below stay cheap").toBeLessThan(64);
  });

  // I-2: the exemption that keeps a running event alive. A started table that grew past its max (here by the organiser's late add)
  // is reconciled, never refused for its size - a Swiss's next Pair rides the same condition (`existing.length === 0 || not
  // started`, generate-tx.ts); a 666-entrant Swiss with a decided round 1 is too costly for this suite, the league is its witness.
  it("a league started at its max takes a late add, and a Generate on the running table is never FORMAT_TOO_MANY_ENTRANTS", { timeout: 240_000 }, async () => {
    const max = formatMaxEntrants(LEAGUE_8)!;
    const r = await rig(max, LEAGUE_8);
    expect((await routed(() => startDivision(r.auth, r.divisionId))).status).toBe(200);
    expect(await linesOf(r.divisionId)).toBe(roundRobinFixtureCount(max, 8));

    // The late add is accepted and placed: the newcomer's eight legs against everyone, the field now one past the max.
    const late = await addOne(r, "Late");
    expect(await linesOf(r.divisionId), "the catch-up lines: the table of max + 1").toBe(roundRobinFixtureCount(max + 1, 8));
    const [{ n: field }] = await sql<{ n: number }[]>`select count(*)::int as n from entrants where division_id = ${r.divisionId} and status in ('registered','confirmed')`;
    expect(field, "premise: the running field is past the format's max").toBe(max + 1);
    expect((await sql`select 1 from fixtures where division_id = ${r.divisionId} and (home_entrant_id = ${late} or away_entrant_id = ${late})`).length).toBe(8 * max);

    // Generate on the running table: the named no-op (nobody waiting), never a refusal for the field's size.
    const gen = await routed(() => generateStageFixtures(r.auth, r.stageId!));
    expect(gen.error?.code, "never refused for its size once started").not.toBe("FORMAT_TOO_MANY_ENTRANTS");
    expect(gen.status).toBe(200);
    expect(await linesOf(r.divisionId), "nothing redrawn").toBe(roundRobinFixtureCount(max + 1, 8));
  });

  // m-1: a stage drawn BEFORE Start is still unstarted. The division page disables Start for a field past the max (launch-actions.tsx);
  // the server agrees, for a reconcile as for a first draw - and withdrawals back under the max let it start. The draw is an EVEN field
  // one under the max, and two sign-ups keep it even: a pool that is odd, or flips parity, is redrawn from scratch (`roundRobinShape`,
  // a first draw, which the gate always asked), so only an even-to-even arrival reaches the in-place PATCH - the path this case exists
  // for (premise below: the max is odd, so max - 1 and max + 1 are both even).
  it("drawn before Start under its max, then two sign-ups past it: Generate and Start refused by name, the draw untouched; back under it starts", { timeout: 240_000 }, async () => {
    const max = formatMaxEntrants(LEAGUE_8)!;
    expect(max % 2, "premise: the max is odd, so max - 1 and max + 1 are both even (the patch path)").toBe(1);
    const r = await rig(max - 1, LEAGUE_8);
    expect((await routed(() => generateStageFixtures(r.auth, r.stageId!))).status).toBe(200);
    const drawn = roundRobinFixtureCount(max - 1, 8);
    expect(await linesOf(r.divisionId)).toBe(drawn);

    const extra = [await addOne(r, "One more"), await addOne(r, "Two more")];
    const unstarted = await statusOf(r.divisionId);
    const regen = await routed(() => generateStageFixtures(r.auth, r.stageId!));
    expect(regen.status).toBe(422);
    expect(regen.error).toMatchObject({ code: "FORMAT_TOO_MANY_ENTRANTS", max, entrants: max + 1 });
    const start = await routed(() => startDivision(r.auth, r.divisionId));
    expect(start.status).toBe(422);
    expect(start.error).toMatchObject({ code: "FORMAT_TOO_MANY_ENTRANTS", max, entrants: max + 1 });
    expect(await linesOf(r.divisionId), "the draw untouched").toBe(drawn);
    expect(await statusOf(r.divisionId), "still unstarted").toBe(unstarted);

    // The sequence: the sign-ups leave, the field is the drawn one again, and Start goes through on the same draw.
    for (const id of extra) await deleteEntrant(r.auth, id);
    expect((await routed(() => startDivision(r.auth, r.divisionId))).status).toBe(200);
    expect(await statusOf(r.divisionId)).toBe("active");
    expect(await linesOf(r.divisionId)).toBe(drawn);
  });
});

// B4 review m-9: the DRAW_TOO_LARGE backstop lived in `generateStageFixturesTx` alone, and two other doors mint a stage's lines in
// one request: a `timing: "setup"` later stage's placeholder draw (setup-fixtures.ts) and a Swiss's rounds edit after Start (every
// added round's shells, swiss-rounds-admin.ts). Both are bounded in the builder and Settings (Top N <= 32, rounds <= 15) and
// reachable past the budget over the API. Each case is refused one past the budget and drawn one under it, with the line count
// from the engine (`roundRobinFixtureCount`) or the rulebook (W3 §4: ceil(n/2) shells a round), never from the code under test.
// (A late entrant's catch-up lines are at most legs x field per request - 8 x 35 at the eight-leg max - and an Add a round is one
// round's ceil(n/2): neither can reach the budget from a field Start admitted, so they carry no backstop.)
describe.skipIf(!HAS_DB)("F8: every door that draws a stage in one request holds the budget (B4 review m-9)", () => {
  const groupsThenLeague = (perPool: number) => [
    { seq: 1, kind: "group", name: "Groups", config: { legs: 1, pools: { count: 8 } }, progression: null },
    {
      seq: 2, kind: "league", name: "Final league", config: { legs: 2 },
      progression: { sources: [{ stage: "previous", take: [{ kind: "topNPerGroup", n: perPool }] }], placement: "rank_order", timing: "setup" },
    },
  ];

  it("a setup league's placeholder draw past the budget is DRAW_TOO_LARGE, nothing written; one under it draws every line", { timeout: 240_000 }, async () => {
    // 72 into 8 pools of 9: the top 9 of each is 72 seats (72 x 71 = 5,112 lines over two legs); the top 8 is 64 (4,032).
    const over = roundRobinFixtureCount(72, 2);
    const under = roundRobinFixtureCount(64, 2);
    expect(over, "premise: 72 seats over two legs pass the budget").toBeGreaterThan(START_LINE_BUDGET);
    expect(under, "premise: 64 seats over two legs fit it").toBeLessThanOrEqual(START_LINE_BUDGET);
    let checked = 0;
    for (const [perPool, lines] of [[9, over], [8, under]] as const) {
      const r = await rig(72);
      const ids = (await createStages(r.auth, r.divisionId, groupsThenLeague(perPool) as never)).sort((a, b) => a.seq - b.seq).map((x) => x.id);
      const out = await routed(() => generateStageFixtures(r.auth, ids[1]!));
      const written = Number((await sql<{ n: number }[]>`select count(*)::int as n from fixtures where stage_id = ${ids[1]!}`)[0]!.n);
      if (lines > START_LINE_BUDGET) {
        expect(out.status, `top ${perPool}: refused`).toBe(422);
        expect(out.error).toMatchObject({ code: "DRAW_TOO_LARGE", lines, budget: START_LINE_BUDGET });
        expect(written, `top ${perPool}: nothing written`).toBe(0);
      } else {
        expect(out.status, `top ${perPool}: drawn`).toBe(200);
        expect(written, `top ${perPool}: every placeholder line`).toBe(lines);
      }
      checked++;
    }
    expect(checked, "anti-vacuity: one past the budget, one under").toBe(2);
  });

  it("a Swiss's rounds edit after Start whose new shells pass the budget is DRAW_TOO_LARGE, nothing written; one round fewer goes through", { timeout: 240_000 }, async () => {
    // 101 entrants: 51 shells a round (50 boards and the bye). Rounds 1 -> 100 adds 99 rounds (5,049 shells); 1 -> 99 adds 98 (4,998).
    const n = 101;
    const perRound = Math.ceil(n / 2);
    expect(99 * perRound, "premise: 99 added rounds pass the budget").toBeGreaterThan(START_LINE_BUDGET);
    expect(98 * perRound, "premise: 98 fit it").toBeLessThanOrEqual(START_LINE_BUDGET);
    let checked = 0;
    for (const to of [100, 99]) {
      const r = await rig(n, { kind: "swiss", config: { rounds: 1 } });
      expect((await routed(() => startDivision(r.auth, r.divisionId))).status).toBe(200);
      expect(await linesOf(r.divisionId), "Start mints round 1's shells").toBe(perRound);
      const out = await routed(() => patchSwissStage(r.auth, r.stageId!, { rounds: to }));
      const added = (to - 1) * perRound;
      if (added > START_LINE_BUDGET) {
        expect(out.status, `1 -> ${to}: refused`).toBe(422);
        expect(out.error).toMatchObject({ code: "DRAW_TOO_LARGE", lines: added, budget: START_LINE_BUDGET });
        expect(await linesOf(r.divisionId), `1 -> ${to}: nothing written`).toBe(perRound);
      } else {
        expect(out.status, `1 -> ${to}: ${JSON.stringify(out.error)}`).toBe(200);
        expect(await linesOf(r.divisionId), `1 -> ${to}: every round's shells`).toBe(to * perRound);
      }
      checked++;
    }
    expect(checked, "anti-vacuity: one past the budget, one under").toBe(2);
  });
});
