// W2b Task 16, controller ruling R16-3 (Appendix A FB-AB-1, which HK-AB-1 and IH-AB-1 inherit; X-AB-1). Through the
// gate: a level award-policy abandon in a draw kind whose cfg refuses a draw (`supportsDraws` false — an overtime or a
// shootout is configured) is ACCEPTED with no result: status `abandoned`, no outcome, out of the table. It was refused
// 422 DRAW_NOT_ALLOWED (append-event.ts, the no-draw gate), so the organiser could not record the abandon at all — the
// truth run's AB-AWARD ice hockey cell. Where the cfg takes a draw, the level abandon is still a decided draw with the
// real score (the positive pair).
//
// Driven through `scoreEvent` (the console's write) on a division the usecases seed (`seedBracket`), so the gate, the
// status rule and the standings fold all run. The cases are the engine's own declarations — every declared variant of
// every module that keeps `abandonPolicy: "award"`, `supportsDraws`, `DRAW_KINDS` — never a typed list; each sweep
// counts what it judged, and zero is a failure.
import { afterAll, describe, expect, it } from "vitest";
import { DRAW_KINDS, type StageKind } from "@seazn/engine/core";
import { builtinModules } from "@seazn/engine/sports";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { scoreEvent } from "@/server/usecases/scoring";
import { getStandings } from "@/server/usecases/stages";
import { recomputeStandings } from "../competition";
import { seedBracket } from "./helpers/seed-bracket";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

type Mod = (typeof builtinModules)[number];
interface Case { m: Mod; variant: string; cfg: Record<string, unknown>; divisionConfig: Record<string, unknown> }
interface Row { status: string; outcome: { kind?: string; winner?: string; method?: string } | null; home_entrant_id: string; away_entrant_id: string }
interface StandingRow { entrantId: string; played: number; won: number; drawn: number; lost: number; points: number }

/** Every declared variant of every module that keeps the award policy (zod strips an undeclared key). */
const CASES: Case[] = builtinModules.flatMap((m) =>
  Object.entries(m.variants).flatMap(([variant, declared]) => {
    const divisionConfig = { ...(declared as Record<string, unknown>), abandonPolicy: "award" };
    const parsed = m.configSchema.safeParse(divisionConfig);
    return parsed.success && (parsed.data as { abandonPolicy?: unknown }).abandonPolicy === "award"
      ? [{ m, variant, cfg: parsed.data as Record<string, unknown>, divisionConfig }]
      : [];
  }),
);
const refuses = (c: Case, kind: StageKind) => !c.m.supportsDraws(c.cfg as never, kind);
const REFUSING = CASES.flatMap((c) => [...DRAW_KINDS].filter((k) => refuses(c, k)).map((kind) => ({ ...c, kind })));
const STANDING = CASES.filter((c) => !refuses(c, "league"));
/** A swiss stage must declare its rounds (assertSwissRoundsDeclared); 4 entrants seat every draw kind's round 1. */
const stageConfigOf = (kind: StageKind) => (kind === "swiss" ? { rounds: 2 } : {});

const rowOf = async (id: string) =>
  (await sql<Row[]>`select status, outcome, home_entrant_id, away_entrant_id from fixtures where id = ${id}`)[0]!;
const tip = async (id: string) =>
  (await sql<{ s: number }[]>`select coalesce(max(seq), 0)::int as s from score_events where fixture_id = ${id}`)[0]!.s;
const post = async (auth: AuthCtx, id: string, type: string, payload: unknown = {}) =>
  scoreEvent(auth, id, { expected_seq: await tip(id), type, payload } as never);
async function tableOf(auth: AuthCtx, stageId: string, ids: readonly string[]): Promise<StandingRow[]> {
  await recomputeStandings(auth.orgId, stageId);
  const rows = (await getStandings(auth, stageId)).rows as StandingRow[];
  return ids.map((id) => {
    const r = rows.find((x) => x.entrantId === id);
    if (r === undefined) throw new Error(`no standings row for ${id}`);
    return r;
  });
}
/** Seed one division of the case's sport/variant with the award policy, take its first seated fixture, and post a
 *  level stream — a goal each — then the abandon. */
async function levelAbandon(c: Case, kind: StageKind) {
  const s = await seedBracket({ sport: c.m.key, variant: c.variant, stageKind: kind, entrants: 4, divisionConfig: c.divisionConfig, stageConfig: stageConfigOf(kind) });
  const id = s.fixtureIds[0]!;
  const { home_entrant_id: home, away_entrant_id: away } = await rowOf(id);
  await post(s.auth, id, "core.start");
  await post(s.auth, id, `${c.m.key}.goal`, { by: home });
  await post(s.auth, id, `${c.m.key}.goal`, { by: away });
  await post(s.auth, id, "core.abandon", { reason: "floodlights" });
  return { s, id, home, away };
}

describe.runIf(HAS_DB)("R16-3: a level award-policy abandon where the stage refuses a draw (FB-AB-1, X-AB-1)", () => {
  it("the sweep is not vacuous: draw-refusing and draw-taking cases both exist, and the truth run's cell (ice hockey's iihf, a league) is one", () => {
    console.info(`R16-3: ${REFUSING.length} draw-refusing cases (${REFUSING.map((r) => `${r.m.key}/${r.variant} ${r.kind}`).join(", ")}); ${STANDING.length} draw-taking cfgs`);
    expect(REFUSING.length).toBeGreaterThan(0);
    expect(STANDING.length).toBeGreaterThan(0);
    expect(REFUSING.map((r) => `${r.m.key}/${r.variant} ${r.kind}`)).toContain("icehockey/iihf league");
  });

  it("accepted with no result in every draw kind: status abandoned, no outcome, and both sides out of the table", async () => {
    let checked = 0;
    for (const c of REFUSING) {
      const name = `${c.m.key}/${c.variant} ${c.kind}`;
      const { s, id, home, away } = await levelAbandon(c, c.kind);
      const r = await rowOf(id);
      expect({ status: r.status, outcome: r.outcome }, name).toEqual({ status: "abandoned", outcome: null });
      const table = await tableOf(s.auth, s.stageId, [home, away]);
      expect(table.map((t) => [t.played, t.won, t.drawn, t.lost, t.points]), `${name}: out of the table`).toEqual([[0, 0, 0, 0, 0], [0, 0, 0, 0, 0]]);
      checked++;
    }
    expect(checked).toBe(REFUSING.length);
    expect(checked).toBeGreaterThan(0);
  }, 240_000);

  it("the sequence, where draws are refused: void the abandon (play resumes), score again, abandon with a leader — a decided win the table credits", async () => {
    let checked = 0;
    for (const c of REFUSING.filter((r) => r.kind === "league")) {
      const name = `${c.m.key}/${c.variant}`;
      const { s, id, home, away } = await levelAbandon(c, "league");
      const [abandon] = await sql<{ id: string }[]>`select id from score_events where fixture_id = ${id} and type = 'core.abandon'`;
      await post(s.auth, id, "core.void", { event_id: abandon!.id }); // the console's undo of the abandon
      expect((await rowOf(id)).status, `${name}: voided`).toBe("in_play");
      await post(s.auth, id, `${c.m.key}.goal`, { by: home });
      await post(s.auth, id, "core.abandon", { reason: "floodlights" });
      const r = await rowOf(id);
      expect({ status: r.status, outcome: r.outcome }, name).toEqual({ status: "decided", outcome: { kind: "win", winner: home, loser: away, method: "abandoned" } });
      const [h, a] = await tableOf(s.auth, s.stageId, [home, away]);
      expect([h!.played, h!.won, a!.played, a!.lost], `${name}: the leader's win counts`).toEqual([1, 1, 1, 1]);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  }, 120_000);

  it("the positive pair: where the cfg takes a draw, the level abandon is a decided draw with the real score, credited as one", async () => {
    let checked = 0;
    for (const c of STANDING) {
      const name = `${c.m.key}/${c.variant}`;
      const { s, id, home, away } = await levelAbandon(c, "league");
      const r = await rowOf(id);
      expect({ status: r.status, outcome: r.outcome }, name).toEqual({ status: "decided", outcome: { kind: "draw" } });
      const draw = (c.cfg as { points: { draw: number } }).points.draw;
      const table = await tableOf(s.auth, s.stageId, [home, away]);
      expect(table.map((t) => [t.played, t.drawn, t.points]), `${name}: a draw in the table`).toEqual([[1, 1, draw], [1, 1, draw]]);
      checked++;
    }
    expect(checked).toBe(STANDING.length);
    expect(checked).toBeGreaterThan(0);
  }, 240_000);
});
