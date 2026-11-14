// Quick match plan 5, Task 4 (plan docs/superpowers/plans/2026-11-13-quick-match-5-league-knockout.md D2, D3, D5, P14-P16,
// Review Focus 1-5; spec docs/superpowers/specs/2026-11-12-quick-match-league-knockout-design.md §5, §6, §11, §12): a League +
// Knockout fills its knockout when the league ends, asks about a tie at the cut once, and keeps its league rules by stage.
//
// Every quick match is made by the real producer (`createQuickMatchAnyFormat` → the guarded create), every result by the real
// write path (`scoreEvent`, as the system user or as a pad's link through `requireFixtureActor`), so the advance under test is
// the one `scoring.ts`'s hook runs; every skip by the real usecase or the real skip route. The direct SQL below writes only what
// no guest path writes at that moment (a decision landing before the advance ran, a stale or malformed one), each named where
// it is made.
//
// Expected values come from the results each test made (chess: a resignation decides the game for the other side, the
// rulebook, so each winner is steered and counted), the rulebook's seeding (semi-finals 1st v 4th and 2nd v 3rd, the final
// 1st v 2nd), and the engine's own stored rows (the stored table's ranks, `stage_lots_draws.drawn_order`): never from the
// advance's own answer. Single-sport cases are chess for the steering; the last describe sweeps every offered sport.
//
// Real Postgres required; the cases skip without DATABASE_URL.
import { randomBytes as kekBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { StandingsRow } from "@seazn/engine/competition";
import { forEachSportAsync } from "@seazn/engine/testkit";

import { POST as postEvent } from "@/app/api/v1/fixtures/[id]/events/route";
import { POST as skipRoute } from "@/app/q/[token]/skip/[fixtureId]/route";
import { buildTemplateStages } from "@/lib/format-templates";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import offerJson from "@/lib/quick-match-offer.generated.json";
import { systemAuth } from "@/lib/quick-match-auth";
import { QUICK_MATCH_ERRORS } from "@/lib/quick-match-constants";
import { MUTATION_LIMIT, __setRateLimitCounterForTests } from "@/lib/rate-limit";
import { requireFixtureActor, type AuthCtx } from "@/server/api-v1/auth";
import { log } from "@/server/logger";
import { declaredVariant } from "@/server/engine-db/__tests__/helpers/seed-bracket";
import { CreateQuickMatch, CreateStage } from "@/server/api-v1/schemas";
import { createCompetition } from "../competitions";
import { ensureGuestDeviceLink } from "../device-links";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { addQuickMatchDecider } from "../quick-match-add";
import {
  advanceQuickMatch,
  afterQuickMatchScore,
  decideQuickMatchCut,
  loadLeagueCut,
} from "../quick-match-advance";
import type { CreatedQuickMatch } from "../quick-match-create";
import { tossThrough } from "../quick-match-cut";
import { hardDeleteQuickMatchCompetition } from "../quick-match-delete";
import { readQuickMatchHome, resolveQuickMatchToken, type QuickMatchRow } from "../quick-match-home";
import { putBackQuickMatchFixture, skipQuickMatchFixture } from "../quick-match-skip";
import { listQuickMatchSports } from "../quick-match-sports";
import { hashVisitorKey, mintVisitorKey } from "../quick-match-tokens";
import { startDivision } from "../schedule";
import { createStages, generateStageFixtures, getStandings } from "../stages";
import { createQuickMatchAnyFormat } from "./_quick-match-knockout";
import { playToDecided } from "./_quick-match-probe";
import { pairKey, playCircle, playWin } from "./_quick-match-results";
import { seedOrg } from "./_seed";

vi.stubEnv("DEVICE_LINK_KEK", kekBytes(32).toString("hex")); // every create and mint seals a secret (A15)
vi.mock("@/lib/posthog-server", async (orig) => ({
  ...(await orig<typeof import("@/lib/posthog-server")>()),
  captureServer: vi.fn(),
}));
// The real hook target behind a spy: the scoring hook's dynamic import lands on this module, so the spy counts every call
// `onDecided` makes (an organiser's score must make none). Every other export is the real one.
vi.mock("../quick-match-advance", async (orig) => {
  const real = await orig<typeof import("../quick-match-advance")>();
  return { ...real, afterQuickMatchScore: vi.fn(real.afterQuickMatchScore) };
});
const hookSpy = vi.mocked(afterQuickMatchScore);
// The real confirm behind a gate: Review Focus 2's case holds the first confirm until the second advance arrives at its own,
// so the two genuinely race at the one write that may fill the knockout. Disarmed, it is the real confirm.
const gate = vi.hoisted(() => ({ armed: 0, arrived: 0, release: null as null | (() => void), rejected: [] as string[] }));
vi.mock("../stages", async (orig) => {
  const real = await orig<typeof import("../stages")>();
  return {
    ...real,
    confirmSeedProposal: vi.fn(async (...args: Parameters<typeof real.confirmSeedProposal>) => {
      if (gate.armed > 0) {
        gate.arrived++;
        if (gate.arrived >= gate.armed) {
          gate.armed = 0;
          gate.release?.();
        } else {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 15_000);
            gate.release = () => {
              clearTimeout(timer);
              resolve();
            };
          });
        }
      }
      try {
        return await real.confirmSeedProposal(...args);
      } catch (err) {
        gate.rejected.push((err as { code?: string }).code ?? String(err));
        throw err;
      }
    }),
  };
});
// A write landing in the gap between a decision's (or an advance's) read and its own write: the read is `loadLeagueCut`'s
// transaction, recognised by what it returns. One-shot; `fired` says it ran (a gap case that never fires proves nothing).
const gap = vi.hoisted(() => ({ hook: null as null | (() => Promise<void>), fired: 0 }));
vi.mock("@/lib/db", async (orig) => {
  const actual = await orig<typeof import("@/lib/db")>();
  return {
    ...actual,
    withTenant: (async (...a: Parameters<typeof actual.withTenant>) => {
      const out = await actual.withTenant(...a);
      const isCutRead = out !== null && typeof out === "object" && "ko" in out && "raw" in out && "lines" in out;
      if (gap.hook && isCutRead) {
        const hook = gap.hook;
        gap.hook = null;
        gap.fired++;
        await hook();
      }
      return out;
    }) as typeof actual.withTenant,
  };
});

const HAS_DB = !!process.env.DATABASE_URL;
/** The sports a guest can make a League + Knockout of: those offered a knockout. Cricket is offered League only (C11 as
 *  amended 2026-11-14: a quick match plays no super over), so it is in the offer and not here. */
const OFFERED_SPORT_KEYS = [...new Set(offerJson.offered.filter((o) => o.knockoutAllowed).map((o) => o.sport_key))];
/** Its budget in its own cost driver (AGENTS.md class 20): a create, three results and an advance per sport. */
const SWEEP_TIMEOUT_MS = Math.max(60_000, OFFERED_SPORT_KEYS.length * 30_000);
let CHESS: { variant_key: string; kind: CreateQuickMatch["kind"] };

const created: string[] = [];

interface Line {
  id: string;
  round_no: number;
  seq_in_round: number;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  status: string;
  is_final: boolean;
}
interface Lk {
  out: CreatedQuickMatch;
  row: QuickMatchRow;
  leagueStageId: string;
  koStageId: string;
  /** Each side's entrant id by the name it was typed as. */
  id: Map<string, string>;
}

/** A chess League + Knockout, through the guarded create a guest's post reaches. */
async function chessLk(sides: string[], qualifiers: 2 | 4, plays: 1 | 2 = 1): Promise<Lk> {
  return lk({ sport_key: "boardgame", variant_key: CHESS.variant_key, kind: CHESS.kind, sides, qualifiers, plays });
}
/** A plain League, the format nothing here may move. */
async function plainLeague(sides: string[]): Promise<Lk> {
  return lk({ sport_key: "boardgame", variant_key: CHESS.variant_key, kind: CHESS.kind, sides, format: "league", qualifiers: null });
}
async function lk(over: Partial<CreateQuickMatch> & Pick<CreateQuickMatch, "sport_key" | "variant_key" | "kind" | "sides">): Promise<Lk> {
  const out = await createQuickMatchAnyFormat(
    CreateQuickMatch.parse({ name: `QM lk ${randomUUID().slice(0, 8)}`, format: "league_knockout", qualifiers: 2, ...over }),
    { visitorHash: hashVisitorKey(mintVisitorKey()) },
  );
  created.push(out.competitionId);
  const row = await resolveQuickMatchToken(out.token);
  if (!row) throw new Error(`precondition: quick match ${out.id} does not resolve`);
  const stages = await sql<{ id: string; kind: string }[]>`select id, kind from stages where division_id = ${out.divisionId} order by seq`;
  const lk = (over.format ?? "league_knockout") === "league_knockout";
  expect(stages.map((s) => s.kind), "premise: a League + Knockout is a league then a knockout (T3), a League one league")
    .toEqual(lk ? ["league", "knockout"] : ["league"]);
  const entrants = await sql<{ id: string; display_name: string }[]>`
    select id, display_name from entrants where division_id = ${out.divisionId}`;
  return { out, row, leagueStageId: stages[0]!.id, koStageId: stages[1]?.id ?? "", id: new Map(entrants.map((e) => [e.display_name, e.id])) };
}

async function linesOf(stageId: string): Promise<Line[]> {
  return sql<Line[]>`
    select id, round_no, seq_in_round, home_entrant_id, away_entrant_id, status, is_final
    from fixtures where stage_id = ${stageId} order by round_no, seq_in_round, id`;
}
/** The league lines between two named sides (two when each pair plays twice). */
async function between(m: Lk, a: string, b: string): Promise<Line[]> {
  const key = pairKey(m.id.get(a)!, m.id.get(b)!);
  const lines = (await linesOf(m.leagueStageId)).filter((f) => pairKey(f.home_entrant_id!, f.away_entrant_id!) === key);
  if (lines.length === 0) throw new Error(`precondition: no league line between ${a} and ${b}`);
  return lines;
}
/** `winner` beats `loser` on their `nth` line (0-based). */
async function beat(m: Lk, winner: string, loser: string, nth = 0, auth?: AuthCtx): Promise<void> {
  const line = (await between(m, winner, loser))[nth]!;
  await playWin(line.id, m.id.get(winner)!, auth);
}
/** The stored league table, best first: the engine's ranks as `standings_snapshots` holds them. */
async function tableOf(m: Lk): Promise<StandingsRow[]> {
  const rows = (await getStandings(systemAuth(), m.leagueStageId)).rows as StandingsRow[];
  return [...rows].sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity));
}
/** The knockout's first-round pairings (sorted within and between), null seats as null. */
async function firstRound(m: Lk): Promise<(string | null)[][]> {
  const lines = await linesOf(m.koStageId);
  const first = Math.min(...lines.map((l) => l.round_no));
  return lines
    .filter((l) => l.round_no === first)
    .map((l) => [l.home_entrant_id, l.away_entrant_id].sort((a, b) => String(a).localeCompare(String(b))))
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
}
const pairing = (...ids: string[]) => [...ids].sort();
const sortedPairs = (...pairs: string[][]) => pairs.map((p) => pairing(...p)).sort((a, b) => a[0]!.localeCompare(b[0]!));
async function koSeated(m: Lk): Promise<number> {
  return (await linesOf(m.koStageId)).reduce((n, l) => n + (l.home_entrant_id ? 1 : 0) + (l.away_entrant_id ? 1 : 0), 0);
}
async function proposalsOf(m: Lk): Promise<Record<string, number>> {
  const rows = await sql<{ status: string; n: number }[]>`
    select status, count(*)::int as n from stage_seed_proposals where stage_id = ${m.koStageId} group by status`;
  return Object.fromEntries(rows.map((r) => [r.status, r.n]));
}
async function seedConfirmedEvents(m: Lk): Promise<number> {
  const [r] = await sql<{ n: number }[]>`
    select count(*)::int as n from division_events where division_id = ${m.out.divisionId} and type = 'seed_confirmed'`;
  return r!.n;
}
async function stageStatus(stageId: string): Promise<string> {
  const [r] = await sql<{ status: string }[]>`select status from stages where id = ${stageId}`;
  return r!.status;
}
async function decisionOf(m: Lk): Promise<{ value: unknown; text: string | null }> {
  const [r] = await sql<{ value: unknown; text: string | null }[]>`
    select cut_decision as value, cut_decision::text as text from quick_matches where id = ${m.row.id}`;
  return r!;
}
async function writeDecision(m: Lk, value: unknown): Promise<void> {
  await sql`update quick_matches set cut_decision = ${sql.json(value as never)} where id = ${m.row.id}`;
}
/** The error a promise rejects with, or a failure when it resolves. */
async function refusalOf(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error("expected a refusal, and the call succeeded");
}
async function expectRefused(p: Promise<unknown>, status: number, code: string): Promise<void> {
  const err = await refusalOf(p);
  expect(err, String(err)).toBeInstanceOf(HttpError);
  expect({ status: (err as HttpError).status, code: (err as HttpError).code }).toEqual({ status, code });
}
/** A guest's pad on `fixtureId`: the link a Score tap mints, and the auth its bearer resolves to at the events route's door. */
async function padOf(row: QuickMatchRow, fixtureId: string): Promise<{ secret: string; auth: AuthCtx }> {
  const { secret } = await ensureGuestDeviceLink(row, fixtureId);
  const auth = await requireFixtureActor(
    new Request("http://test.local/api/v1", { headers: { authorization: `Bearer ${secret}` } }),
    fixtureId,
    "score",
  );
  return { secret, auth };
}
/** A post to the events route with the pad's bearer, exactly as the pad posts. */
async function padPost(fixtureId: string, secret: string, body: unknown): Promise<Response> {
  return postEvent(
    new Request(`http://test.local/api/v1/fixtures/${fixtureId}/events`, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: fixtureId }) },
  );
}
/** The `quick_match_advance_failed` lines a spy on the shared logger saw. */
const advanceFailures = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls.filter(([o]) => (o as { event?: string } | undefined)?.event === "quick_match_advance_failed");
/** The live league lot: the one unsuperseded draw completion stored for the league stage. */
async function lotOf(m: Lk): Promise<string[]> {
  const draws = await sql<{ drawn_order: string[] }[]>`
    select drawn_order from stage_lots_draws where stage_id = ${m.leagueStageId} and superseded_at is null`;
  expect(draws, "completion stored one lot for the one level class").toHaveLength(1);
  return draws[0]!.drawn_order;
}
async function ledgerTail(fixtureId: string): Promise<{ count: number; lastId: string; lastSeq: number }> {
  const rows = await sql<{ id: string; seq: number }[]>`select id, seq from score_events where fixture_id = ${fixtureId} order by seq`;
  return { count: rows.length, lastId: rows.at(-1)!.id, lastSeq: rows.at(-1)!.seq };
}

beforeAll(async () => {
  if (!HAS_DB) return;
  const chess = (await listQuickMatchSports()).find((s) => s.sport_key === "boardgame");
  if (!chess) throw new Error("premise: chess is offered for quick matches (run `npm run sync:sports`)");
  CHESS = { variant_key: chess.variants[0]!.variant_key, kind: chess.kinds.at(-1)! };
});

afterEach(() => {
  __setRateLimitCounterForTests(null);
  gap.hook = null;
  gate.armed = 0;
  gate.arrived = 0;
  gate.release = null;
});

afterAll(async () => {
  vi.unstubAllEnvs();
  if (!HAS_DB) return;
  for (const id of created) await hardDeleteQuickMatchCompetition(id).catch(() => undefined);
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("the advance: the knockout fills when the league ends (D2)", () => {
  it("1 + 7 + 11. no tie, 4 sides, semis: the LAST league result (through scoreEvent, the hook) fills 1v4 and 2v3 by the stored table; the league completes, one confirmed proposal; then the pad on a league match is refused RESULT_CARRIED_FORWARD for a void and for an append", async () => {
    const m = await chessLk(["W", "X", "Y", "Z"], 4);
    expect(await linesOf(m.leagueStageId), "premise: a round robin of 4 is 4·3/2 matches").toHaveLength(6);
    const ko = await linesOf(m.koStageId);
    expect(ko, "premise: two semi-finals and a final").toHaveLength(3);
    // The rulebook's strengths: W beats everyone, X beats Y and Z, Y beats Z. Wins 3, 2, 1, 0.
    const results: [string, string][] = [["W", "X"], ["W", "Y"], ["W", "Z"], ["X", "Y"], ["X", "Z"]];
    for (const [w, l] of results) await beat(m, w, l);
    expect(await advanceQuickMatch(m.row), "one league match left").toEqual({ state: "league" });
    expect(await koSeated(m), "nothing is seated before the league ends").toBe(0);
    // A KO line with no sides seated is refused Score (T3 review carry): the guest link's own SIDES_UNKNOWN.
    await expectRefused(ensureGuestDeviceLink(m.row, ko[0]!.id), 422, QUICK_MATCH_ERRORS.SIDES_UNKNOWN);

    // The last league match through a pad (its link minted while the match is open), so the pad's own event decides it.
    const [last] = await between(m, "Y", "Z");
    const pad = await padOf(m.row, last!.id);
    hookSpy.mockClear();
    await playWin(last!.id, m.id.get("Y")!, pad.auth);
    expect(hookSpy, "the scoring hook ran once per result (start + result)").toHaveBeenCalledTimes(1);
    expect(hookSpy).toHaveBeenCalledWith(m.out.divisionId);

    const table = (await tableOf(m)).map((r) => r.entrantId);
    expect(table, "premise: the stored table ranks by wins, 3-2-1-0").toEqual(["W", "X", "Y", "Z"].map((n) => m.id.get(n)!));
    expect(await firstRound(m), "semi-finals 1st v 4th and 2nd v 3rd").toEqual(sortedPairs([table[0]!, table[3]!], [table[1]!, table[2]!]));
    const final = (await linesOf(m.koStageId)).find((l) => l.is_final)!;
    expect([final.home_entrant_id, final.away_entrant_id], "the final waits for the semi-finals").toEqual([null, null]);
    expect(await stageStatus(m.leagueStageId), "D3: the league completes as the knockout fills").toBe("complete");
    expect(await proposalsOf(m)).toEqual({ confirmed: 1 });
    expect(await seedConfirmedEvents(m)).toBe(1);

    // Second call: idempotent, nothing moves.
    expect(await advanceQuickMatch(m.row)).toEqual({ state: "filled" });
    expect(await proposalsOf(m)).toEqual({ confirmed: 1 });
    expect(await seedConfirmedEvents(m)).toBe(1);

    // 7 + 11 (P16, Review Focus 5): the pad left open on that league match. Its void of the deciding event and any append are
    // refused, and its ledger does not move.
    const before = await ledgerTail(last!.id);
    const voided = await padPost(last!.id, pad.secret, { expected_seq: before.lastSeq, type: "core.void", payload: { event_id: before.lastId } });
    expect(voided.status, await voided.clone().text()).toBe(403);
    expect(await voided.text()).toContain("RESULT_CARRIED_FORWARD");
    const appended = await padPost(last!.id, pad.secret, {
      expected_seq: before.lastSeq,
      type: "boardgame.result",
      payload: { winner: m.id.get("Z"), method: "resign" },
    });
    expect(appended.status).toBe(403);
    expect(await appended.text()).toContain("RESULT_CARRIED_FORWARD");
    expect(await ledgerTail(last!.id), "nothing landed").toEqual(before);
  });

  it("2. League → Final, 3 sides: the final holds 1st and 2nd", async () => {
    const m = await chessLk(["A", "B", "C"], 2);
    for (const [w, l] of [["A", "B"], ["A", "C"], ["B", "C"]] as const) await beat(m, w, l);
    const table = (await tableOf(m)).map((r) => r.entrantId);
    expect(table, "premise: wins 2-1-0").toEqual(["A", "B", "C"].map((n) => m.id.get(n)!));
    expect(await firstRound(m)).toEqual([pairing(table[0]!, table[1]!)]);
    expect(await proposalsOf(m)).toEqual({ confirmed: 1 });
  });

  it("2b. a tie among sides who all go through (case 2): 4 sides, a circle among three who each beat the fourth, semis: filled at once, nobody asked, the level three seeded by the stored lot", async () => {
    const m = await chessLk(["A", "B", "C", "D"], 4);
    const ids = ["A", "B", "C"].map((n) => m.id.get(n)!).sort();
    const nameOf = new Map([...m.id].map(([n, id]) => [id, n]));
    // The circle over the sorted ids, then each beats D: every one of the three has two wins and one loss.
    for (const [w, l] of [[ids[0]!, ids[1]!], [ids[1]!, ids[2]!], [ids[2]!, ids[0]!]]) await beat(m, nameOf.get(w)!, nameOf.get(l)!);
    for (const n of ["A", "B", "C"]) await beat(m, n, "D");
    const draws = await sql<{ drawn_order: string[] }[]>`
      select drawn_order from stage_lots_draws where stage_id = ${m.leagueStageId} and superseded_at is null`;
    expect(draws, "completion stored the one lot for the one class").toHaveLength(1);
    const lot = draws[0]!.drawn_order;
    expect([...lot].sort()).toEqual(ids);
    const d = m.id.get("D")!;
    expect(await firstRound(m), "1st (the lot's first) v 4th (D), 2nd v 3rd by the lot").toEqual(sortedPairs([lot[0]!, d], [lot[1]!, lot[2]!]));
    expect(await decisionOf(m), "nobody was asked").toMatchObject({ value: null });
    expect(await proposalsOf(m)).toEqual({ confirmed: 1 });
  });
});

describe.skipIf(!HAS_DB)("a failed advance never fails the score (P6, D2)", () => {
  it("the hook rejects on the LAST league result: the pad's post through the real events route is still 201 with its result stored, the knockout stays empty, one quick_match_advance_failed line; the next advance fills it", async () => {
    const m = await chessLk(["A", "B", "C"], 2);
    await beat(m, "A", "B");
    await beat(m, "A", "C");
    const [last] = await between(m, "B", "C");
    const pad = await padOf(m.row, last!.id);
    const start = await padPost(last!.id, pad.secret, { expected_seq: 0, type: "core.start", payload: {} });
    expect(start.status, await start.clone().text()).toBe(201);
    const errors = vi.spyOn(log, "error");
    try {
      hookSpy.mockClear();
      hookSpy.mockRejectedValueOnce(new Error("the advance failed after the commit"));
      const res = await padPost(last!.id, pad.secret, {
        expected_seq: 1,
        type: "boardgame.result",
        payload: { winner: m.id.get("B"), method: "resign" },
      });
      expect(res.status, `the score stands whatever the advance does: ${await res.clone().text()}`).toBe(201);
      expect(hookSpy, "the hook ran (and failed) for this result").toHaveBeenCalledTimes(1);
      expect(advanceFailures(errors), "logged once, as the advance's own event").toHaveLength(1);
    } finally {
      errors.mockRestore();
    }
    const [row] = await sql<{ winner: string | null }[]>`select outcome->>'winner' as winner from fixtures where id = ${last!.id}`;
    expect(row!.winner, "the result is stored").toBe(m.id.get("B"));
    expect(await koSeated(m), "nothing filled: the failure left the knockout as it was").toBe(0);
    expect(await proposalsOf(m)).toEqual({});
    // Retryable: the next advance (a home load, another post) takes it from there. A wins 2, B 1, C 0.
    expect(await advanceQuickMatch(m.row)).toEqual({ state: "filled" });
    expect(await firstRound(m)).toEqual([pairing(m.id.get("A")!, m.id.get("B")!)]);
  });
});

describe.skipIf(!HAS_DB)("a tie at the cut: asked once, answered once (D5, §5, §11)", () => {
  /** §12's two-way tie: 3 sides, each pair Twice. P beats Q and R twice each; Q and R split: level for 2nd. */
  async function twiceTie(): Promise<Lk> {
    const m = await chessLk(["P", "Q", "R"], 2, 2);
    expect(await linesOf(m.leagueStageId), "premise: 3·2/2 pairs, each twice").toHaveLength(6);
    await beat(m, "P", "Q", 0);
    await beat(m, "P", "Q", 1);
    await beat(m, "P", "R", 0);
    await beat(m, "P", "R", 1);
    await beat(m, "Q", "R", 0);
    await beat(m, "R", "Q", 1);
    return m;
  }

  it("3 + 6. Twice, level for 2nd: the question (nothing filled, the league still active), then Pick the side the table put 3rd: the final holds 1st and the pick; a second answer is refused and the stored decision does not move", async () => {
    const m = await twiceTie();
    const table = await tableOf(m);
    expect(table[0]!.entrantId, "premise: four wins of four lead").toBe(m.id.get("P"));
    const q = m.id.get("Q")!;
    const r = m.id.get("R")!;
    expect(table.slice(1).every((row) => row.tieUnbroken === true), "premise: Q and R level on every step before the lot").toBe(true);
    const third = table[2]!.entrantId;

    const asked = await advanceQuickMatch(m.row);
    expect(asked.state).toBe("tie");
    expect(asked.state === "tie" && { ids: asked.tie.entrantIds, seats: asked.tie.seats, place: asked.tie.place }).toEqual({
      ids: [q, r].sort(),
      seats: 1,
      place: 2,
    });
    expect(await koSeated(m)).toBe(0);
    expect(await stageStatus(m.leagueStageId), "D3: the league stays open while the question is").toBe("active");
    expect(await proposalsOf(m), "nothing proposed yet").toEqual({});
    expect(await advanceQuickMatch(m.row), "a second call asks the same").toEqual(asked);

    expect(await decideQuickMatchCut(m.row, { how: "pick", entrantIds: [third] })).toEqual({ through: [third] });
    // Decided, not yet advanced (the route advances next): a second answer is already refused.
    await expectRefused(decideQuickMatchCut(m.row, { how: "toss" }), 422, QUICK_MATCH_ERRORS.ALREADY_DECIDED);
    expect(await advanceQuickMatch(m.row)).toEqual({ state: "filled" });
    expect(await firstRound(m), "1st and the side the guests picked, not the lot's").toEqual([pairing(m.id.get("P")!, third)]);
    const stored = await decisionOf(m);
    expect(stored.value).toMatchObject({ how: "pick", through: [third], tie: [q, r].sort() });

    // 6: after the fill, every second answer is refused, and the stored decision is byte-equal.
    await expectRefused(decideQuickMatchCut(m.row, { how: "toss" }), 422, QUICK_MATCH_ERRORS.ALREADY_DECIDED);
    await expectRefused(decideQuickMatchCut(m.row, { how: "pick", entrantIds: [table[1]!.entrantId] }), 422, QUICK_MATCH_ERRORS.ALREADY_DECIDED);
    expect((await decisionOf(m)).text).toBe(stored.text);
    expect(await proposalsOf(m)).toEqual({ confirmed: 1 });
  });

  it("4 + 5. a three-way tie under Once, top 2 (Review Focus 3): one question, pick 2 of 3; Toss sends through the stored lot's first two; the same answer on every read", async () => {
    const m = await chessLk(["Asha", "Ben", "Cleo"], 2);
    const ids = await playCircle(await linesOf(m.leagueStageId) as never);
    const asked = await advanceQuickMatch(m.row);
    expect(asked.state === "tie" && { ids: asked.tie.entrantIds, seats: asked.tie.seats, place: asked.tie.place, byLot: asked.tie.byLot })
      .toEqual({ ids, seats: 2, place: 1, byLot: true });

    const { through } = await decideQuickMatchCut(m.row, { how: "toss" });
    expect(await advanceQuickMatch(m.row)).toEqual({ state: "filled" });
    const draws = await sql<{ drawn_order: string[] }[]>`
      select drawn_order from stage_lots_draws where stage_id = ${m.leagueStageId} and superseded_at is null`;
    expect(draws).toHaveLength(1);
    const lot = draws[0]!.drawn_order;
    expect(through, "the toss revealed the stored lot (D5), no second draw").toEqual(lot.slice(0, 2));
    expect(await firstRound(m)).toEqual([pairing(lot[0]!, lot[1]!)]);

    // 5: the same result on a reload and another phone's read.
    const first = await loadLeagueCut(m.row);
    const second = await loadLeagueCut(m.row);
    expect(first?.decision).toMatchObject({ how: "toss", through: lot.slice(0, 2), tie: ids });
    expect(second?.decision).toEqual(first?.decision);
    expect(first?.filled).toBe(true);
  });

  it("a malformed or stale stored decision answers nothing (C3, §11): the question stands and the value is cleared; then a real answer writes", async () => {
    const m = await twiceTie();
    const q = m.id.get("Q")!;
    const r = m.id.get("R")!;
    for (const bad of [
      { how: "pick", through: [7], tie: [], at: "x" }, // malformed (V517 lets the shape through, not the ids)
      { how: "pick", through: [q], tie: [m.id.get("P")!, q].sort(), at: new Date().toISOString() }, // another class: stale
      { how: "toss", through: [q, r], tie: [q, r].sort(), at: new Date().toISOString() }, // too many through: no answer
    ]) {
      await writeDecision(m, bad);
      expect((await loadLeagueCut(m.row))?.decision, JSON.stringify(bad)).toBeNull();
      expect((await advanceQuickMatch(m.row)).state, JSON.stringify(bad)).toBe("tie");
      expect((await decisionOf(m)).value, "cleared").toBeNull();
    }
    // And the compare-and-set writes over a malformed value too (it never strands the question).
    await writeDecision(m, { how: "pick", through: [7], tie: [], at: "x" });
    expect(await decideQuickMatchCut(m.row, { how: "pick", entrantIds: [q] })).toEqual({ through: [q] });
    expect(await advanceQuickMatch(m.row)).toEqual({ state: "filled" });
    expect(await firstRound(m)).toEqual([pairing(m.id.get("P")!, q)]);
  });

  it("the decision's checks: Pick of the wrong count, an outsider or a side twice is PICK_INVALID; no tie, or a league not finished, is TIE_NOT_OPEN; a plain league has no question", async () => {
    const m = await twiceTie();
    const [p, q, r] = ["P", "Q", "R"].map((n) => m.id.get(n)!) as [string, string, string];
    for (const picks of [[], [q, r], [p], [q, q], [randomUUID()]]) {
      await expectRefused(decideQuickMatchCut(m.row, { how: "pick", entrantIds: picks }), 422, QUICK_MATCH_ERRORS.PICK_INVALID);
    }
    expect((await decisionOf(m)).value, "nothing written").toBeNull();

    const open = await chessLk(["A", "B", "C"], 2);
    await beat(open, "A", "B");
    await expectRefused(decideQuickMatchCut(open.row, { how: "toss" }), 422, QUICK_MATCH_ERRORS.TIE_NOT_OPEN);
    await beat(open, "A", "C");
    await beat(open, "B", "C");
    // Finished with no tie: the hook filled it, so the answer is "already decided" (the knockout is drawn).
    await expectRefused(decideQuickMatchCut(open.row, { how: "toss" }), 422, QUICK_MATCH_ERRORS.ALREADY_DECIDED);

    const plain = await plainLeague(["A", "B"]);
    await expectRefused(decideQuickMatchCut(plain.row, { how: "toss" }), 422, QUICK_MATCH_ERRORS.TIE_NOT_OPEN);
  });

  it("the first decision wins at the write itself (D5): an answer landing between a phone's read and its write leaves this phone ALREADY_DECIDED, and the first answer stands", async () => {
    const m = await twiceTie();
    const [q, r] = ["Q", "R"].map((n) => m.id.get(n)!) as [string, string];
    const first = { how: "pick", through: [r], tie: [q, r].sort(), at: new Date().toISOString() };
    gap.fired = 0;
    gap.hook = async () => writeDecision(m, first);
    await expectRefused(decideQuickMatchCut(m.row, { how: "pick", entrantIds: [q] }), 422, QUICK_MATCH_ERRORS.ALREADY_DECIDED);
    expect(gap.fired, "the other phone's answer landed in the gap").toBe(1);
    expect((await decisionOf(m)).value).toEqual(first);
  });

  it("the stale-decision clear is compare-and-clear: an answer written after the advance's read survives it", async () => {
    const m = await twiceTie();
    const [p, q, r] = ["P", "Q", "R"].map((n) => m.id.get(n)!) as [string, string, string];
    await writeDecision(m, { how: "pick", through: [q], tie: [p, q].sort(), at: new Date().toISOString() }); // stale
    const fresh = { how: "pick", through: [q], tie: [q, r].sort(), at: new Date().toISOString() };
    gap.fired = 0;
    gap.hook = async () => writeDecision(m, fresh);
    expect((await advanceQuickMatch(m.row)).state, "the read saw the stale one: the question stands").toBe("tie");
    expect(gap.fired).toBe(1);
    expect((await decisionOf(m)).value, "the fresh answer was not cleared").toEqual(fresh);
    expect(await advanceQuickMatch(m.row), "and the next pass fills from it").toEqual({ state: "filled" });
    expect(await firstRound(m)).toEqual([pairing(p, q)]);
  });

  it("9. a decision, then a league result voided through the pad before the advance ran (Review Focus 1): the league is open again (D3), the decision is dropped, the knockout stays empty; the replayed table decides", async () => {
    const m = await chessLk(["P", "Q", "R"], 2, 2);
    await beat(m, "P", "Q", 0);
    await beat(m, "P", "Q", 1);
    await beat(m, "P", "R", 0);
    await beat(m, "P", "R", 1);
    await beat(m, "Q", "R", 0);
    const [, split] = await between(m, "Q", "R");
    const pad = await padOf(m.row, split!.id);
    await playWin(split!.id, m.id.get("R")!, pad.auth);
    const [q, r] = ["Q", "R"].map((n) => m.id.get(n)!) as [string, string];
    expect((await advanceQuickMatch(m.row)).state, "premise: Q and R level for 2nd").toBe("tie");
    // Stand-in for an answer that landed before its advance ran: R was picked.
    await writeDecision(m, { how: "pick", through: [r], tie: [q, r].sort(), at: new Date().toISOString() });

    const tail = await ledgerTail(split!.id);
    const voided = await padPost(split!.id, pad.secret, { expected_seq: tail.lastSeq, type: "core.void", payload: { event_id: tail.lastId } });
    expect(voided.status, `D3: a league result is the guests' to change while the question is open: ${await voided.clone().text()}`).toBe(201);
    expect(await advanceQuickMatch(m.row)).toEqual({ state: "league" });
    expect((await decisionOf(m)).value, "§11: the pick not yet applied is dropped").toBeNull();
    expect(await koSeated(m)).toBe(0);
    expect(await proposalsOf(m)).toEqual({});
    expect(await stageStatus(m.leagueStageId)).toBe("active");

    // Replayed the other way: Q has both games over R, so Q is 2nd outright, and the dropped pick of R does not fill.
    await playWin(split!.id, q, pad.auth);
    expect(await firstRound(m), "the table that stands now decides, not the stale answer").toEqual([pairing(m.id.get("P")!, q)]);
  });

  it("9b. the league reopened with the SAME tie (a P–Q result voided through the pad: Q and R still level for 2nd): the answer is dropped because the league is no longer done (§11), not because the tie moved; replayed, the same question is asked again", async () => {
    const m = await chessLk(["P", "Q", "R"], 2, 2);
    const [p, q, r] = ["P", "Q", "R"].map((n) => m.id.get(n)!) as [string, string, string];
    const [, pq1] = await between(m, "P", "Q");
    const pad = await padOf(m.row, pq1!.id); // minted while the match is open
    await beat(m, "P", "Q", 0);
    await beat(m, "P", "R", 0);
    await beat(m, "P", "R", 1);
    await beat(m, "Q", "R", 0);
    await beat(m, "R", "Q", 1);
    await playWin(pq1!.id, p, pad.auth); // the last league result
    expect((await advanceQuickMatch(m.row)).state, "premise: Q and R level for 2nd").toBe("tie");
    // A real answer through the usecase; the void lands before anything advanced from it.
    expect(await decideQuickMatchCut(m.row, { how: "pick", entrantIds: [r] })).toEqual({ through: [r] });

    const tail = await ledgerTail(pq1!.id);
    const voided = await padPost(pq1!.id, pad.secret, { expected_seq: tail.lastSeq, type: "core.void", payload: { event_id: tail.lastId } });
    expect(voided.status, await voided.clone().text()).toBe(201);
    // The engine's own table: still P first, Q and R level on every step for 2nd, so the decision still names the open tie.
    const table = await tableOf(m);
    expect(table[0]!.entrantId).toBe(p);
    expect(table.slice(1).every((row) => row.tieUnbroken === true), "premise: the void kept the tie (P–Q only)").toBe(true);
    expect([table[1]!.entrantId, ...(table[1]!.tieBreak?.with ?? [])].sort(), "premise: the same class").toEqual([q, r].sort());
    // The void's own hook advanced: the league is not done, so the answer goes.
    expect((await decisionOf(m)).value, "§11: no question on a league that is not done").toBeNull();
    expect(await advanceQuickMatch(m.row)).toEqual({ state: "league" });
    expect(await koSeated(m)).toBe(0);
    expect(await stageStatus(m.leagueStageId)).toBe("active");

    // Replayed the same way: the same tie, asked again; the dropped pick does not fill.
    await playWin(pq1!.id, p, pad.auth);
    const asked = await advanceQuickMatch(m.row);
    expect(asked.state === "tie" && asked.tie.entrantIds).toEqual([q, r].sort());
    expect(await koSeated(m)).toBe(0);
    expect((await decisionOf(m)).value).toBeNull();
  });
});

describe.skipIf(!HAS_DB)("skips and the knockout (P14, D3)", () => {
  it("8. the last league match skipped through the REAL skip route fills the knockout (the route's advance); Put back is then refused LEAGUE_FINISHED, by the usecase and by the route", async () => {
    const m = await chessLk(["W", "X", "Y", "Z"], 2);
    for (const [w, l] of [["W", "X"], ["W", "Y"], ["W", "Z"], ["X", "Y"], ["X", "Z"]] as const) await beat(m, w, l);
    expect(await koSeated(m)).toBe(0);
    const [yz] = await between(m, "Y", "Z");
    const res = await skipRoute(new Request(`http://localhost/q/${m.out.token}/skip/${yz!.id}`, { method: "POST" }), {
      params: Promise.resolve({ token: m.out.token, fixtureId: yz!.id }),
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/q/${m.out.token}`);
    // W 2 wins... W 3, X 2, Y and Z 0 (level below the cut: nobody asked).
    expect(await firstRound(m)).toEqual([pairing(m.id.get("W")!, m.id.get("X")!)]);
    await expectRefused(putBackQuickMatchFixture(m.row, yz!.id), 422, QUICK_MATCH_ERRORS.LEAGUE_FINISHED);
    expect((await linesOf(m.leagueStageId)).find((l) => l.id === yz!.id)!.status, "still Not played").toBe("cancelled");
  });

  it("8b. every league match skipped, 3 sides, final: nothing played, all level in typing order with no lot drawn, so the question is Pick only (Toss is TIE_NOT_OPEN); the pick fills; Put back is refused", async () => {
    const m = await chessLk(["A", "B", "C"], 2);
    for (const l of await linesOf(m.leagueStageId)) expect(await skipQuickMatchFixture(m.row, l.id)).toEqual({ changed: true });
    const asked = await advanceQuickMatch(m.row);
    expect(asked.state === "tie" && { seats: asked.tie.seats, size: asked.tie.entrantIds.length, byLot: asked.tie.byLot })
      .toEqual({ seats: 2, size: 3, byLot: false });
    await expectRefused(decideQuickMatchCut(m.row, { how: "toss" }), 422, QUICK_MATCH_ERRORS.TIE_NOT_OPEN);
    expect((await decisionOf(m)).value).toBeNull();
    // A toss stored anyway (an old tab, a write that skipped the usecase's refusal): the right class, exactly `seats` of it,
    // the order the toss would send. It fails only `answers()`'s last clause (a toss needs a class the lot ordered), so the
    // advance must not fill from it: the question stays open and the stored toss is dropped (§11, review m1).
    if (asked.state !== "tie") throw new Error("premise: the advance asks");
    await writeDecision(m, { how: "toss", through: tossThrough(asked.tie), tie: asked.tie.entrantIds, at: new Date().toISOString() });
    expect((await decisionOf(m)).value, "premise: the toss is stored").toMatchObject({ how: "toss" });
    const again = await advanceQuickMatch(m.row);
    expect(again.state === "tie" && again.tie.entrantIds, "a toss on a class no lot ordered answers nothing").toEqual(asked.tie.entrantIds);
    expect((await decisionOf(m)).value, "the stored toss is cleared").toBeNull();
    expect(await koSeated(m), "nothing filled from it").toBe(0);
    // Pick the two the typing order would NOT seat by default (A, B): B and C.
    const [b, c] = ["B", "C"].map((n) => m.id.get(n)!) as [string, string];
    await decideQuickMatchCut(m.row, { how: "pick", entrantIds: [c, b] });
    expect(await advanceQuickMatch(m.row)).toEqual({ state: "filled" });
    expect(await firstRound(m)).toEqual([pairing(b, c)]);
    await expectRefused(putBackQuickMatchFixture(m.row, (await linesOf(m.leagueStageId))[0]!.id), 422, QUICK_MATCH_ERRORS.LEAGUE_FINISHED);
  });

  it("8c. every league match skipped, 4 sides, semis (case 2, all four through): filled at once in the stored table's order, nobody asked", async () => {
    const m = await chessLk(["A", "B", "C", "D"], 4);
    const lines = await linesOf(m.leagueStageId);
    for (const l of lines.slice(0, -1)) await skipQuickMatchFixture(m.row, l.id);
    expect(await advanceQuickMatch(m.row)).toEqual({ state: "league" });
    await skipQuickMatchFixture(m.row, lines.at(-1)!.id);
    expect(await advanceQuickMatch(m.row)).toEqual({ state: "filled" });
    const table = (await tableOf(m)).map((r) => r.entrantId);
    expect(await firstRound(m)).toEqual(sortedPairs([table[0]!, table[3]!], [table[1]!, table[2]!]));
    expect(await decisionOf(m)).toMatchObject({ value: null });
  });

  it("13. by stage: a knockout line is never skippable (NOT_SKIPPABLE, either way); a League + Knockout's league line is, and Put back works while its league is open, its knockout unplayed", async () => {
    const m = await chessLk(["A", "B", "C"], 2);
    const [final] = await linesOf(m.koStageId);
    await expectRefused(skipQuickMatchFixture(m.row, final!.id), 422, QUICK_MATCH_ERRORS.NOT_SKIPPABLE);
    await expectRefused(putBackQuickMatchFixture(m.row, final!.id), 422, QUICK_MATCH_ERRORS.NOT_SKIPPABLE);
    const [l1] = await linesOf(m.leagueStageId);
    expect(await skipQuickMatchFixture(m.row, l1!.id)).toEqual({ changed: true });
    expect(await putBackQuickMatchFixture(m.row, l1!.id)).toEqual({ changed: true, status: "scheduled" });
  });
});

describe.skipIf(!HAS_DB)("Add a match on a League + Knockout (P15, D3)", () => {
  it("12. lands on the LEAGUE stage while the league runs; refused LEAGUE_COMPLETE once every league match is done (nothing added); a plain finished league still takes one", async () => {
    const m = await chessLk(["A", "B", "C"], 2);
    const [a, b] = ["A", "B"].map((n) => m.id.get(n)!) as [string, string];
    const { fixtureId } = await addQuickMatchDecider(m.row, { home: a, away: b });
    const [added] = await sql<{ stage_id: string }[]>`select stage_id from fixtures where id = ${fixtureId}`;
    expect(added!.stage_id).toBe(m.leagueStageId);
    for (const l of await linesOf(m.leagueStageId)) await skipQuickMatchFixture(m.row, l.id);
    const count = (await linesOf(m.leagueStageId)).length;
    await expectRefused(addQuickMatchDecider(m.row, { home: a, away: b }), 422, QUICK_MATCH_ERRORS.LEAGUE_COMPLETE);
    expect((await linesOf(m.leagueStageId)).length).toBe(count);
    expect((await linesOf(m.koStageId)).length, "nothing lands on the knockout").toBe(1);

    const plain = await plainLeague(["A", "B"]);
    const [only] = await linesOf(plain.leagueStageId);
    await skipQuickMatchFixture(plain.row, only!.id);
    expect((await readQuickMatchHome(plain.row))?.finished, "premise: the plain league is finished").toBe(true);
    const sides = [...plain.id.values()];
    expect((await addQuickMatchDecider(plain.row, { home: sides[0]!, away: sides[1]! })).fixtureId).toEqual(expect.any(String));
  });
});

describe.skipIf(!HAS_DB)("two phones at once (Review Focus 2)", () => {
  it("10. two advances racing to fill the same knockout: both answer filled, ONE confirmed proposal, ONE seed_confirmed event, and the loser's refusal was a race the advance read as such", async () => {
    const m = await chessLk(["W", "X", "Y", "Z"], 2);
    for (const [w, l] of [["W", "X"], ["W", "Y"], ["W", "Z"], ["X", "Y"], ["X", "Z"]] as const) await beat(m, w, l);
    const [yz] = await between(m, "Y", "Z");
    // The usecase alone (no route): the league is done and nothing has advanced it yet.
    await skipQuickMatchFixture(m.row, yz!.id);
    expect(await koSeated(m)).toBe(0);
    gate.armed = 2;
    gate.arrived = 0;
    gate.rejected = [];
    const both = await Promise.all([advanceQuickMatch(m.row), advanceQuickMatch(m.row)]);
    expect(both).toEqual([{ state: "filled" }, { state: "filled" }]);
    expect(gate.arrived, "both advances reached the confirm").toBeGreaterThanOrEqual(2);
    expect(gate.rejected.length, `one confirm lost the race: ${gate.rejected.join(", ")}`).toBeGreaterThanOrEqual(1);
    expect(gate.rejected.every((c) => c === "SEEDING_ALREADY_CONFIRMED" || c === "SEEDING_PROPOSAL_STALE")).toBe(true);
    expect((await proposalsOf(m)).confirmed).toBe(1);
    expect(await seedConfirmedEvents(m)).toBe(1);
    expect(await firstRound(m)).toEqual([pairing(m.id.get("W")!, m.id.get("X")!)]);
  });
});

describe.skipIf(!HAS_DB)("two phones at once, nothing held (real Postgres, no gates)", () => {
  const ROUNDS = 3;

  it(`the last two league matches decided at once (two scoring hooks race to fill), ×${ROUNDS}: one confirmed proposal, one seed_confirmed, the final seated once, no advance failure`, async () => {
    const errors = vi.spyOn(log, "error");
    let rounds = 0;
    try {
      for (let i = 0; i < ROUNDS; i++) {
        const m = await chessLk(["W", "X", "Y", "Z"], 2);
        for (const [w, l] of [["W", "X"], ["W", "Y"], ["W", "Z"], ["X", "Y"]] as const) await beat(m, w, l);
        const [xz] = await between(m, "X", "Z");
        const [yz] = await between(m, "Y", "Z");
        await Promise.all([playWin(xz!.id, m.id.get("X")!), playWin(yz!.id, m.id.get("Y")!)]);
        // W 3 wins, X 2, Y 1, Z 0: the final is W v X.
        // The loser's computed draft may be left stale by the winner's compute; only one is ever confirmed.
        expect((await proposalsOf(m)).confirmed, `round ${i}`).toBe(1);
        expect(await seedConfirmedEvents(m), `round ${i}`).toBe(1);
        expect(await koSeated(m), `round ${i}: two seats, once`).toBe(2);
        expect(await firstRound(m), `round ${i}`).toEqual([pairing(m.id.get("W")!, m.id.get("X")!)]);
        rounds++;
      }
      expect(advanceFailures(errors), "a lost race is never logged as a failure").toEqual([]);
    } finally {
      errors.mockRestore();
    }
    expect(rounds).toBe(ROUNDS);
  });

  it(`Pick and Toss posted at once (each then advancing, as the routes do), ×${ROUNDS}: one answer stands, the other is ALREADY_DECIDED, and the final seats the answer that stood`, async () => {
    let rounds = 0;
    const outcomes = new Set<string>();
    for (let i = 0; i < ROUNDS; i++) {
      const m = await chessLk(["P", "Q", "R"], 2, 2);
      for (const [w, l, nth] of [["P", "Q", 0], ["P", "Q", 1], ["P", "R", 0], ["P", "R", 1], ["Q", "R", 0], ["R", "Q", 1]] as const) {
        await beat(m, w, l, nth);
      }
      const q = m.id.get("Q")!;
      const post = (input: Parameters<typeof decideQuickMatchCut>[1]) =>
        decideQuickMatchCut(m.row, input).then(async (out) => {
          await advanceQuickMatch(m.row);
          return { how: input.how, ...out };
        });
      const settled = await Promise.allSettled([post({ how: "pick", entrantIds: [q] }), post({ how: "toss" })]);
      const ok = settled.filter((s) => s.status === "fulfilled");
      const refused = settled.filter((s) => s.status === "rejected");
      expect(ok, `round ${i}: one answer stands`).toHaveLength(1);
      expect(refused).toHaveLength(1);
      const err = (refused[0] as PromiseRejectedResult).reason as HttpError;
      expect({ status: err.status, code: err.code }).toEqual({ status: 422, code: QUICK_MATCH_ERRORS.ALREADY_DECIDED });
      const won = (ok[0] as PromiseFulfilledResult<{ how: string; through: string[] }>).value;
      expect((await decisionOf(m)).value, "the stored answer is the one that stood").toMatchObject({ how: won.how, through: won.through });
      expect(await firstRound(m)).toEqual([pairing(m.id.get("P")!, won.through[0]!)]);
      expect(await proposalsOf(m)).toEqual({ confirmed: 1 });
      outcomes.add(won.how);
      rounds++;
    }
    expect(rounds).toBe(ROUNDS);
    console.info(`pick v toss race: winners ${[...outcomes].join(", ")} over ${rounds} rounds`);
  });
});

describe.skipIf(!HAS_DB)("nothing moves for anyone else (D2, P5)", () => {
  it("14. a plain League: the advance is plain and writes nothing; its scores reach the hook, which leaves it alone", async () => {
    const plain = await plainLeague(["A", "B", "C"]);
    hookSpy.mockClear();
    for (const l of await linesOf(plain.leagueStageId)) await playWin(l.id, l.home_entrant_id!);
    expect(hookSpy, "one hook call per result").toHaveBeenCalledTimes(3);
    expect(await advanceQuickMatch(plain.row)).toEqual({ state: "plain" });
    expect(await loadLeagueCut(plain.row)).toBeNull();
    const [p] = await sql<{ n: number }[]>`
      select count(*)::int as n from stage_seed_proposals where stage_id = ${plain.leagueStageId}`;
    expect(p!.n).toBe(0);
    expect((await sql<{ status: string }[]>`select status from stages where id = ${plain.leagueStageId}`)[0]!.status, "never completed by QM code").toBe("active");
    expect((await decisionOf(plain)).value).toBeNull();
  });

  it("an organiser's league → knockout (the same league_ko template): every league result scored, and the quick match hook is never asked; the league stays active and no proposal is drawn (auto_progress off)", async () => {
    const { auth } = await seedOrg("pro");
    const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: `Org LK ${randomUUID().slice(0, 6)}`, visibility: "private", branding: {} });
    const division = await createDivision(auth, comp.id, {
      name: "Open",
      slug: "open-" + randomUUID().slice(0, 6),
      sport_key: "badminton",
      variant_key: declaredVariant("badminton", "bwf"),
      config: {},
    });
    await createEntrants(auth, division.id, ["E1", "E2", "E3"].map((n, i) => ({ kind: "individual" as const, display_name: n, seed: i + 1, members: [] })));
    const stages: { id: string }[] = [];
    for (const [i, d] of buildTemplateStages("league_ko", { swissRounds: 5, poolCount: 2, legs: 1, qualified: 2 }).entries()) {
      const [s] = await createStages(auth, division.id, CreateStage.parse({ seq: i + 1, kind: d.kind, name: d.name, config: d.config, progression: d.progression }));
      stages.push(s!);
    }
    await startDivision(auth, division.id);
    await generateStageFixtures(auth, stages[1]!.id);
    const lines = await linesOf(stages[0]!.id);
    expect(lines, "premise: a round robin of 3").toHaveLength(3);
    hookSpy.mockClear();
    let decided = 0;
    for (const l of lines) {
      const played = await playToDecided(auth, l.id);
      expect(played.kind, JSON.stringify(played)).toBe("decided");
      decided++;
    }
    expect(decided).toBe(3);
    expect(hookSpy, "an organiser's score never asks the quick match hook").not.toHaveBeenCalled();
    expect(await stageStatus(stages[0]!.id)).toBe("active");
    const [p] = await sql<{ n: number }[]>`select count(*)::int as n from stage_seed_proposals where stage_id = ${stages[1]!.id}`;
    expect(p!.n, "nothing drawn for the organiser: the Complete button is theirs").toBe(0);
  }, 60_000);
});

describe.skipIf(!HAS_DB)("every offered sport asks its tie at the cut (one variant each)", () => {
  it("3 sides, League → Final, every league match decided the same way through the real write path: a circle, so every sport ASKS (P8: `seed` never breaks it); half answer by Toss (the stored lot's first two), half by Pick (the two the lot would not seat)", async () => {
    const offered = new Map((await listQuickMatchSports()).map((s) => [s.sport_key, s]));
    expect(OFFERED_SPORT_KEYS.length, "9 sports are offered a knockout").toBe(9);
    expect(offerJson.offered.some((o) => !o.knockoutAllowed), "premise: an offered sport is refused a knockout (cricket)").toBe(true);
    let checked = 0;
    let asked = 0;
    let tossed = 0;
    let picked = 0;
    const visited = await forEachSportAsync(async ({ key }) => {
      if (!OFFERED_SPORT_KEYS.includes(key)) return; // generic, and cricket (League only): no guest makes one
      const sport = offered.get(key);
      expect(sport, `${key}: the offer and the catalog agree`).toBeDefined();
      const m = await lk({ sport_key: key, variant_key: sport!.variants[0]!.variant_key, kind: sport!.kinds.at(-1)!, sides: ["Side A", "Side B", "Side C"] });
      const lines = await linesOf(m.leagueStageId);
      expect(lines, `${key}: a round robin of 3 is 3·2/2`).toHaveLength(3);
      // A circle: every side is at home exactly once, and the probe's walk decides every match the same way (the same side of
      // the line wins, by the same scoreline: chess's home side by resignation). Each side then has one win and one loss by
      // the same scoreline, so the rulebook leaves all three level on every step before the lot.
      expect(new Set(lines.map((l) => l.home_entrant_id)).size, `${key}: each side at home once`).toBe(3);
      const winners = new Set<string>();
      for (const l of lines) {
        if (key === "boardgame") {
          await playWin(l.id, l.home_entrant_id!); // chess: no rally walk; the away side resigns
        } else {
          const played = await playToDecided(systemAuth(), l.id);
          expect(played.kind, `${key}: ${JSON.stringify(played)}`).toBe("decided");
        }
        const [row] = await sql<{ winner: string | null }[]>`select outcome->>'winner' as winner from fixtures where id = ${l.id}`;
        expect(row!.winner, `${key}: ${l.id} has a winner`).toBeTruthy();
        winners.add(row!.winner!);
      }
      expect(winners.size, `${key}: premise, a circle (each side won exactly one)`).toBe(3);
      const table = await tableOf(m);
      expect(table.every((r) => r.tieUnbroken === true), `${key}: all three level on every step (no seed split, P8)`).toBe(true);
      expect(await koSeated(m), `${key}: a tie straddles the cut, so nothing filled`).toBe(0);
      const state = await advanceQuickMatch(m.row);
      expect(state.state, key).toBe("tie");
      asked++;
      const ids = table.map((r) => r.entrantId);
      let expected: string[];
      if (checked % 2 === 0) {
        const { through } = await decideQuickMatchCut(m.row, { how: "toss" });
        expect(await advanceQuickMatch(m.row), key).toEqual({ state: "filled" });
        const lot = await lotOf(m);
        expect([...lot].sort(), key).toEqual([...ids].sort());
        expect(through, `${key}: the toss revealed the stored lot's first two`).toEqual(lot.slice(0, 2));
        expected = lot.slice(0, 2);
        tossed++;
      } else {
        // The two the lot would NOT seat together: the live table's 2nd and 3rd (its order is the lot's).
        const chosen = [ids[1]!, ids[2]!];
        await decideQuickMatchCut(m.row, { how: "pick", entrantIds: chosen });
        expect(await advanceQuickMatch(m.row), key).toEqual({ state: "filled" });
        expected = chosen;
        picked++;
      }
      expect(await firstRound(m), key).toEqual([pairing(...expected)]);
      expect(await proposalsOf(m), key).toEqual({ confirmed: 1 });
      checked++;
      await hardDeleteQuickMatchCompetition(m.out.competitionId);
    });
    console.info(`quick match advance sweep: ${checked} offered sports (${asked} asked; ${tossed} toss, ${picked} pick), of ${visited} sport modules`);
    expect(visited).toBeGreaterThan(0);
    expect(checked, "zero checked is a failure").toBeGreaterThan(0);
    expect(checked, "every offered sport, once").toBe(OFFERED_SPORT_KEYS.length);
    expect(asked, "every circle is asked").toBe(checked);
    expect(tossed, "Toss taken").toBeGreaterThan(0);
    expect(picked, "Pick taken").toBeGreaterThan(0);
  }, SWEEP_TIMEOUT_MS);
});

describe.skipIf(!HAS_DB)("the decision's post limit", () => {
  it("answers first (qm-cut, MUTATION_LIMIT): a 429 with no code, one bucket for Toss and Pick, and nothing is read or written", async () => {
    const m = await chessLk(["A", "B", "C"], 2);
    const keys: string[] = [];
    __setRateLimitCounterForTests(async (k) => {
      keys.push(k);
      return k === `rl:qm-cut:${m.row.id}` ? { count: MUTATION_LIMIT.max + 1, ttlMs: 30_000 } : null;
    });
    for (const input of [{ how: "toss" as const }, { how: "pick" as const, entrantIds: [] }]) {
      const err = await refusalOf(decideQuickMatchCut(m.row, input));
      expect({ status: (err as HttpError).status, code: (err as HttpError).code }).toEqual({ status: 429, code: undefined });
    }
    expect(keys.filter((k) => k === `rl:qm-cut:${m.row.id}`)).toHaveLength(2);
    expect((await decisionOf(m)).value).toBeNull();
  });
});
