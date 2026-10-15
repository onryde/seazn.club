// W2b Loop R I-1 (controller ruling: reader tolerance, NO data write — ruling 112's no-migration stance holds). The
// kernels before W2b stored a walkover as `{kind: "award", winner, method: "walkover"}` — no `loser`, no `reason`;
// football and the period kernel (hockey, ice hockey) added the awarded `score` and wrote it into the state's `goals`
// (merge-base 55ac34d5d, each kernel's `applyForfeit`). `fixtures.outcome` and `match_states` keep that shape until a
// refold, and the table reads the STORED outcome — production's one walkover (069dbf22, badminton) and staging's
// (d26fca49, football) are such rows. Read as a bye, they lost their credited sets and games (badminton 2-0/42-0 became
// 0-0) and their "w/o".
//
// Through the product's own doors: a division the usecases seed, the walkover recorded by the console's write
// (`scoreEvent`), its stored row then put back into the pre-W2b shape — exactly what a refold-less production row holds —
// and the table recomputed. The expected table is the SAME walkover's, as W2b stores it (the engine's own declaration of
// what a walkover credits); the expected tag is the dictionary's. Every sport whose kernel stored an award is swept;
// chess stored none (its forfeit was a `boardgame.result` card), and that is counted.
import { afterAll, describe, expect, it, vi } from "vitest";
import { builtinModules } from "@seazn/engine/sports";
import { sql } from "@/lib/db";
import { bracketForfeitWords } from "@/lib/bracket-forfeit-words";
import { forfeitCopyOf } from "@/lib/forfeit-tag";
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
import { omit } from "@/lib/omit";

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

/** Chess stored no award before W2b. Football and the period kernel stored the awarded score, into `goals` too. */
const NO_PRE_W2B_AWARD = new Set(["boardgame"]);
const SCORED = new Set(["football", "hockey", "icehockey"]);
const SPORTS = builtinModules.filter((m) => !NO_PRE_W2B_AWARD.has(m.key));

interface Row { status: string; outcome: Record<string, unknown> | null; home_entrant_id: string; away_entrant_id: string }
const rowOf = async (id: string) =>
  (await sql<Row[]>`select status, outcome, home_entrant_id, away_entrant_id from fixtures where id = ${id}`)[0]!;
const tip = async (id: string) =>
  (await sql<{ s: number }[]>`select coalesce(max(seq), 0)::int as s from score_events where fixture_id = ${id}`)[0]!.s;
async function table(auth: AuthCtx, stageId: string, ids: readonly string[]) {
  await recomputeStandings(auth.orgId, stageId);
  const rows = (await getStandings(auth, stageId)).rows as unknown as Record<string, unknown>[];
  return ids.map((id) => {
    const r = rows.find((x) => x.entrantId === id);
    if (r === undefined) throw new Error(`no standings row for ${id}`);
    return omit(r, "rank");
  });
}

describe.runIf(HAS_DB)("Loop R I-1: a walkover stored before W2b ranks and reads as the walkover it was", () => {
  it("every sport that stored an award: the table credits the walkover's sets, games and goals, and the public reads w/o, naming the side that did not show", async () => {
    const en = (key: string, vars?: Record<string, string>) => t(pubEn as unknown as Dict, key, vars);
    const copy = forfeitCopyOf((k) => en(k));
    const n = { sports: 0, credited: 0 };
    for (const m of SPORTS) {
      const variant = Object.keys(m.variants)[0]!;
      const s = await seedBracket({ sport: m.key, variant, stageKind: "league", entrants: 4 });
      const id = s.fixtureIds[0]!;
      const { home_entrant_id: home, away_entrant_id: away } = await rowOf(id);
      await scoreEvent(s.auth, id, { expected_seq: await tip(id), type: "core.forfeit", payload: { by: away, reason: "walkover" } } as never);
      const typed = await rowOf(id);
      expect(typed.outcome, `${m.key}: premise — W2b stores the typed walkover`).toEqual({ kind: "award", winner: home, loser: away, reason: "walkover" });
      const want = await table(s.auth, s.stageId, [home, away]);

      // The pre-W2b stored row: outcome and state as the old `applyForfeit` left them (no refold since).
      const cfg = m.configSchema.parse(m.variants[variant]) as { awardScore?: { goals: number } };
      const score = SCORED.has(m.key) ? { home: cfg.awardScore!.goals, away: 0 } : undefined;
      const legacy = { kind: "award", winner: home, ...(score === undefined ? {} : { score }), method: "walkover" };
      await sql`update fixtures set outcome = ${sql.json(legacy)} where id = ${id}`;
      await sql`
        update match_states
        set state = state || ${sql.json({ outcome: legacy, ...(score === undefined ? {} : { goals: score }) })}::jsonb
        where fixture_id = ${id}`;
      expect((await rowOf(id)).outcome, `${m.key}: premise — the stored row is the pre-W2b shape`).toEqual(legacy);

      const read = await table(s.auth, s.stageId, [home, away]);
      expect(read, `${m.key}: the stored pre-W2b walkover ranks as the typed one`).toEqual(want);
      // Anti-vacuity: the credit the bye reading dropped is really in the table (a won match, and a credited score
      // wherever the sport credits one).
      expect([want[0]!.won, want[1]!.lost], `${m.key}: a won walkover`).toEqual([1, 1]);
      const metrics = want[0]!.metrics as Record<string, number> | undefined;
      if (metrics !== undefined && Object.values(metrics).some((v) => v > 0)) n.credited++;

      // The public reads: the division's schedule and bracket words, and the hub card.
      await sql`update competitions set visibility = 'public' where id = ${s.competitionId}`;
      const [slugs] = await sql<{ org: string; comp: string; div: string }[]>`
        select o.slug as org, c.slug as comp, d.slug as div from divisions d
        join competitions c on c.id = d.competition_id join organizations o on o.id = c.org_id where d.id = ${s.divisionId}`;
      const detail = (await getPublicDivision(slugs!.org, slugs!.comp, slugs!.div))!;
      const names = { [home]: "HOME", [away]: "AWAY" };
      const words = bracketForfeitWords(detail.fixtures, names, copy).get(id);
      expect(words?.tag, `${m.key}: the schedule/bracket tag`).toBe(en("forfeit.tag.walkover"));
      expect(words?.sentence, `${m.key}: the sentence names the side that did not show`).toContain("AWAY");
      const hub = (await loadCompetitionHub(slugs!.org, slugs!.comp))!;
      expect(hub.matches.find((x) => x.fixtureId === id)?.forfeit?.tag, `${m.key}: the hub card`).toBe(en("forfeit.tag.walkover"));
      n.sports++;
    }
    expect(n.sports, "every sport whose kernel stored an award").toBe(builtinModules.length - NO_PRE_W2B_AWARD.size);
    // badminton, volleyball, tabletennis, tennis, carrom (sets), football, hockey, ice hockey (goals), cricket (balls).
    expect(n.credited, "sports whose walkover credits a score").toBeGreaterThanOrEqual(8);
    expect(en("forfeit.tag.walkover")).toBe("w/o");
  }, 300_000);
});
