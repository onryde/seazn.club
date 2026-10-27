// W2b Task 16, ruling R16-3, owner-confirmed by ruling 117 (Appendix A HK-AB-1 and IH-AB-1, which ruling 117 amends;
// FB-AB-1, which they inherit; X-AB-1). Through the
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
import { afterAll, describe, expect, it, vi } from "vitest";
import { DRAW_KINDS, type StageKind } from "@seazn/engine/core";
import { builtinModules } from "@seazn/engine/sports";
import { sql } from "@/lib/db";
import { bracketForfeitWords } from "@/lib/bracket-forfeit-words";
import { ABANDONED_BARE_KEY, forfeitCopyOf } from "@/lib/forfeit-tag";
import type { Dict } from "@/lib/i18n-constants";
import { t } from "@/lib/i18n-runtime";
import pubEn from "@/dictionaries/en/public.json";
import type { AuthCtx } from "@/server/api-v1/auth";
import { loadCompetitionHub } from "@/server/public-site/competition-hub";
import { getPublicDivision } from "@/server/public-site/data";
import { scoreEvent } from "@/server/usecases/scoring";
import { getStandings } from "@/server/usecases/stages";
import { recomputeStandings } from "../competition";
import { seedBracket } from "./helpers/seed-bracket";

// The public reads below go through `unstable_cache`, a Next server-runtime API with no incrementalCache outside a real
// request: a passthrough, never a memoising double (competition-hub-db.test.ts's own reason).
vi.mock("next/cache", () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown) => fn,
  revalidateTag: vi.fn(),
  revalidatePath: vi.fn(),
}));

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
/** A side's goal. FIH hockey refuses an untyped goal on the write path (W2d T18, HK-TB-2: GOAL_KIND_REQUIRED), so its
 *  goals here are field goals — what the table counts an untyped goal as anyway (B3); every other sport's is side-only. */
const goal = (m: Mod, by: string) => (m.key === "hockey" ? { by, kind: "fg" } : { by });
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
  await post(s.auth, id, `${c.m.key}.goal`, goal(c.m, home));
  await post(s.auth, id, `${c.m.key}.goal`, goal(c.m, away));
  await post(s.auth, id, "core.abandon", { reason: "floodlights" });
  return { s, id, home, away };
}

describe.runIf(HAS_DB)("R16-3, ruling 117: a level award-policy abandon where the stage refuses a draw (HK-AB-1, IH-AB-1; FB-AB-1, X-AB-1)", () => {
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
      await post(s.auth, id, `${c.m.key}.goal`, goal(c.m, home));
      await post(s.auth, id, "core.abandon", { reason: "floodlights" });
      const r = await rowOf(id);
      expect({ status: r.status, outcome: r.outcome }, name).toEqual({ status: "decided", outcome: { kind: "win", winner: home, loser: away, method: "abandoned" } });
      const [h, a] = await tableOf(s.auth, s.stageId, [home, away]);
      expect([h!.played, h!.won, a!.played, a!.lost], `${name}: the leader's win counts`).toEqual([1, 1, 1, 1]);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  }, 120_000);

  // T16 review m3 (X-AB-1): the abandon that decided nobody is still an abandon on the public surfaces, with its reason.
  // R16-3 turned a no-draw cfg's level BRACKET abandon from a (tagged) draw into no result, and the public lost its
  // "Abandoned (reason)": `forfeitTag(null)` read nothing. Through the console's write and the public's own reads — the
  // division read (`getPublicDivision`, whose `abandon_reason` the schedule and the bracket word through
  // `bracketForfeitWords`) and the hub card (`loadCompetitionHub`) — for every refusing cfg (a second sport included),
  // in a draw kind and a bracket kind. The copy is the dictionary's, never the reader's. Then the sequence: voiding the
  // abandon takes the tag away (play resumes).
  it("T16 review m3: the public reads it as abandoned with its reason — schedule and bracket words, and the hub card; a void takes it away", async () => {
    const en = (key: string, vars?: Record<string, string>) => t(pubEn as unknown as Dict, key, vars);
    const want = { kind: "abandoned", tag: en("forfeit.tag.abandoned"), sentence: en(ABANDONED_BARE_KEY, { reason: "floodlights" }) };
    expect(want.sentence, "premise: the bare sentence names the reason").toContain("floodlights");
    const copy = forfeitCopyOf((k) => en(k));
    const cfgs = [...new Map(REFUSING.map((r) => [`${r.m.key}/${r.variant}`, r])).values()];
    const sports = new Set(cfgs.map((c) => c.m.key));
    let checked = 0;
    for (const c of cfgs) {
      for (const kind of ["league", "knockout"] as const) {
        const name = `${c.m.key}/${c.variant} ${kind}`;
        const { s, id } = await levelAbandon(c, kind);
        expect(await rowOf(id), `${name}: premise, no result`).toMatchObject({ status: "abandoned", outcome: null });
        await sql`update competitions set visibility = 'public' where id = ${s.competitionId}`;
        const [slugs] = await sql<{ org: string; comp: string; div: string }[]>`
          select o.slug as org, c.slug as comp, d.slug as div from divisions d
          join competitions c on c.id = d.competition_id join organizations o on o.id = c.org_id where d.id = ${s.divisionId}`;
        const detail = (await getPublicDivision(slugs!.org, slugs!.comp, slugs!.div))!;
        expect(detail.fixtures.find((f) => f.id === id)?.abandon_reason, `${name}: the division read`).toBe("floodlights");
        const words = bracketForfeitWords(detail.fixtures, {}, copy);
        expect(words.get(id), `${name}: schedule and bracket`).toEqual(want);
        // The positive pair: no other fixture of the division (each scheduled, no outcome) carries a tag.
        expect([...words.keys()], `${name}: only the abandoned fixture`).toEqual([id]);
        const hub = (await loadCompetitionHub(slugs!.org, slugs!.comp))!;
        expect(hub.matches.find((m) => m.fixtureId === id)?.forfeit, `${name}: the hub card`).toEqual(want);
        // The sequence: the console's undo of the abandon. Play resumes, and the public reads no abandon.
        const [abandon] = await sql<{ id: string }[]>`select id from score_events where fixture_id = ${id} and type = 'core.abandon'`;
        await post(s.auth, id, "core.void", { event_id: abandon!.id });
        const after = (await getPublicDivision(slugs!.org, slugs!.comp, slugs!.div))!;
        expect(after.fixtures.find((f) => f.id === id)?.abandon_reason ?? null, `${name}: voided`).toBeNull();
        expect(bracketForfeitWords(after.fixtures, {}, copy).get(id), `${name}: voided, no tag`).toBeUndefined();
        checked++;
      }
    }
    expect(checked).toBe(cfgs.length * 2);
    expect([...sports].sort(), "a second sport is swept").toEqual(expect.arrayContaining(["hockey", "icehockey"]));
  }, 240_000);

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
