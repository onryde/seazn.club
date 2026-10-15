// W2c Task 16b (X-WO-1 part B) - the inert-seam census (AGENTS.md class 1) for the stage rule's walkover award.
//
// The award is an explicit fold INPUT (`FoldOptions.forfeitAward`), not part of the cfg, so a fold that forgets to offer it is
// silent: it compiles, every unit test of the fold is green, and the headline quietly goes back to the division's number
// while the table credits the rule's. So every production fold of a fixture's ledger is on a ledger below, a source scan pins
// the list, and each site is driven through its REAL entry with a rule that awards a score.
//
//   fold.ts `foldFrom`           offers - every read fold (rebuild, refreeze, replay, overlay, appearances, the format correction)
//   append-event.ts (3 folds)    the write fold offers; the two folds of `prior` (a finalize/level check) decide nothing a score changes
//   awarded-state.ts             offers - an award no event records (reached below by a rule written with raw SQL)
//   event-import.ts              does not: the dry run reads only "does it fold, does it decide", and the writer it feeds offers
//   components/v2/scorepad/module-client.ts   the pad's in-browser fold, a documented residual (see the report)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type { AnySportModule } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
import { sql } from "@/lib/db";
import { rebuildState } from "../rebuild";
import { fixtureRow, post } from "./helpers/w2b-rig";
import { createCompetition } from "@/server/usecases/competitions";
import { createDivision } from "@/server/usecases/divisions";
import { createEntrants } from "@/server/usecases/entrants";
import { createStages, generateStageFixtures } from "@/server/usecases/stages";
import { startDivision } from "@/server/usecases/schedule";
import { withdrawEntrantCascade } from "@/server/usecases/withdrawal";
import { seedOrg } from "@/server/usecases/__tests__/_seed";
import { seedDecidersScene } from "@/server/public-site/__tests__/_stage-rules-scene";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

const SRC = resolve(import.meta.dirname, "../../..");

/** Every non-test source file under apps/web/src. */
function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "__tests__" || name === "node_modules") continue;
      sources(full, out);
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

/** The argument text of every `foldMatchWithStoppage(` / `foldMatch(` call in a file (to its balanced closing paren). */
function foldCalls(text: string): string[] {
  const calls: string[] = [];
  const re = /\bfoldMatch(?:WithStoppage)?\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    // Skip the declaration of the function itself and imports/comments mentioning it.
    const before = text.slice(Math.max(0, m.index - 20), m.index);
    if (/function\s*$/.test(before)) continue;
    const lineStart = text.lastIndexOf("\n", m.index) + 1;
    if (/^\s*(\/\/|\*)/.test(text.slice(lineStart, m.index))) continue;
    let depth = 0;
    let i = m.index + m[0].length - 1;
    for (; i < text.length; i++) {
      if (text[i] === "(") depth++;
      else if (text[i] === ")" && --depth === 0) break;
    }
    calls.push(text.slice(m.index, i + 1));
  }
  return calls;
}

/** file (relative to apps/web/src) -> how many folds it makes and how many of them offer the stage rule's award. */
const LEDGER: Record<string, { folds: number; offering: number; why: string }> = {
  "server/engine-db/fold.ts": { folds: 1, offering: 1, why: "foldFrom: every read fold, from FoldInputs.forfeitAward" },
  "server/engine-db/append-event.ts": { folds: 3, offering: 1, why: "the write fold offers; the other two fold `prior` for the finalize/level checks" },
  "server/engine-db/awarded-state.ts": { folds: 1, offering: 1, why: "awardedMatchState" },
  "server/usecases/event-import.ts": { folds: 1, offering: 0, why: "the dry run: folds-and-decides only; the append it feeds offers" },
  "components/v2/scorepad/module-client.ts": { folds: 2, offering: 0, why: "the pad's in-browser fold (residual, see the report)" },
};

describe("every production fold of a fixture's ledger is on the ledger, and the ones that must offer the award do", () => {
  it("the source scan: exactly the ledger's files fold, with the ledger's counts", () => {
    const found: Record<string, { folds: number; offering: number }> = {};
    let scanned = 0;
    for (const file of sources(SRC)) {
      scanned++;
      const calls = foldCalls(readFileSync(file, "utf8"));
      if (calls.length === 0) continue;
      found[relative(SRC, file)] = { folds: calls.length, offering: calls.filter((c) => /forfeitAward/.test(c)).length };
    }
    expect(scanned, "source files scanned").toBeGreaterThan(500);
    expect(found).toEqual(Object.fromEntries(Object.entries(LEDGER).map(([f, v]) => [f, { folds: v.folds, offering: v.offering }])));
  });

  it("the ledger names a reason for every site that does not offer", () => {
    for (const [file, v] of Object.entries(LEDGER)) if (v.offering < v.folds) expect(v.why.length, file).toBeGreaterThan(20);
  });
});

const RULE_AWARD = [7, 1] as const;
const rule = (award: readonly [number, number] | null) => ({
  base: { win: 3, draw: 1, loss: 0 },
  bonuses: [],
  forfeit: { winnerPoints: 3, loserPoints: 0, ...(award === null ? {} : { awardScore: [award[0], award[1]] as [number, number] }) },
});
const linesOf = (summary: unknown): (string | null)[] =>
  ((summary as { perSide?: { line?: string }[] } | null)?.perSide ?? []).map((p) => p.line ?? null);

describe.skipIf(!HAS_DB)("fold.ts: a rebuild from the ledger re-reads the rule's award (the read folds offer it)", () => {
  it("football and generic: delete the stored state, rebuild it from the ledger - the summary is the rule's, as the write stored it; the twin is the division's", async () => {
    let checked = 0;
    for (const [sport, variant] of [["football", "11-a-side"], ["generic", "score"]] as const) {
      const run = async (award: readonly [number, number] | null) => {
        const s = await seedDecidersScene({ sportKey: sport, variantKey: variant, leaguePoints: rule(award), entrantKind: sport === "generic" ? "individual" : "team" });
        await startDivision(s.auth, s.divisionId);
        const f = await fixtureRow(s.leagueFixtureId);
        await post(s.auth, s.leagueFixtureId, "core.forfeit", { by: f.away_entrant_id, reason: "walkover" });
        const read = async () => (await sql<{ summary: unknown }[]>`select summary from match_states where fixture_id = ${s.leagueFixtureId}`)[0]?.summary;
        const written = await read();
        await sql`delete from match_states where fixture_id = ${s.leagueFixtureId}`;
        const rebuilt = await rebuildState(s.auth.orgId, s.leagueFixtureId);
        return { written, rebuilt: rebuilt!.summary, stored: await read() };
      };
      const withRule = await run(RULE_AWARD);
      const without = await run(null);
      expect(linesOf(withRule.written), `${sport}: the write fold stored the rule's number`).toEqual([String(RULE_AWARD[0]), String(RULE_AWARD[1])]);
      expect(withRule.rebuilt, `${sport}: the rebuilt summary is the written one`).toEqual(withRule.written);
      expect(withRule.stored).toEqual(withRule.written);
      expect(linesOf(without.written), `${sport}: the premise - without the award it is not the rule's`).not.toEqual(linesOf(withRule.written));
      expect(without.rebuilt).toEqual(without.written);
      checked++;
    }
    expect(checked).toBe(2);
  }, 300_000);
});

describe.skipIf(!HAS_DB)("awarded-state.ts: an award no event records folds under the rule's award too (a rule written with raw SQL - no door stores one on a bracket stage)", () => {
  /** F14 (eventless-award-rewrite.test.ts's rig): a knockout drawing from a frozen qualified list, its last qualifier withdrawn
   *  BEFORE Generate - her line generates as a walkover over two seated sides, its score written beside it. */
  async function f14(sport: string, variant: string, award: readonly [number, number] | null) {
    const m = builtinModules.find((x) => x.key === sport) as AnySportModule;
    const { auth } = await seedOrg("pro");
    const suffix = randomUUID().slice(0, 8);
    const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "16b " + suffix, visibility: "private", branding: {} });
    const division = await createDivision(auth, comp.id, { name: "Open", slug: "open-" + suffix, sport_key: sport, variant_key: variant, config: m.variants[variant] as Record<string, unknown> });
    const kind = m.entrantModel?.defaultKind ?? "individual";
    const entrants = await createEntrants(auth, division.id, Array.from({ length: 8 }, (_, i) => ({ kind, display_name: `E${i + 1}`, seed: i + 1, members: [] })));
    const [stage] = await createStages(auth, division.id, [{ seq: 1, kind: "knockout", name: "Finals", config: {} }]);
    // Raw SQL on purpose: a bracket stage has no table, so the points door refuses the rule (RULE_NOT_SETTABLE); the award
    // folds under whatever a stored rule says, which is what this proves.
    const points = award === null ? {} : { points: rule(award) };
    const n = await sql`update stages set config = config || ${sql.json({ qualified: entrants.map((e) => e.id), ...points } as never)} where id = ${stage!.id}`;
    expect(n.count, "rig: the stage config was written").toBe(1);
    const departed = entrants.at(-1)!.id;
    await withdrawEntrantCascade(auth, departed);
    await generateStageFixtures(auth, stage!.id);
    const rows = await sql<{ id: string; status: string; outcome: { kind?: string; winner?: string; loser?: string } | null }[]>`
      select id, status, outcome from fixtures where stage_id = ${stage!.id}`;
    const wo = rows.find((r) => r.status === "forfeited" && r.outcome?.kind === "award" && r.outcome.loser === departed);
    expect(wo, `${sport}: rig - the departed qualifier's line is a seated walkover`).toBeDefined();
    const [row] = await sql<{ summary: { perSide: { entrantId: string; line: string }[] } }[]>`select summary from match_states where fixture_id = ${wo!.id}`;
    expect(row, `${sport}: rig - its score is stored`).toBeDefined();
    const side = (id: string) => row!.summary.perSide.find((p) => p.entrantId === id)!.line;
    return { winnerLine: side(wo!.outcome!.winner!), loserLine: side(departed) };
  }

  it("football and generic: the walkover's stored score is the rule's award, the winner first; without a rule it is the division's", async () => {
    let checked = 0;
    for (const [sport, variant] of [["football", "11-a-side"], ["generic", "score"]] as const) {
      const withRule = await f14(sport, variant, RULE_AWARD);
      const without = await f14(sport, variant, null);
      expect([withRule.winnerLine, withRule.loserLine], `${sport}: the award no event records reads the rule's`).toEqual([String(RULE_AWARD[0]), String(RULE_AWARD[1])]);
      expect([without.winnerLine, without.loserLine], `${sport}: the premise - the division's reading is another number`).not.toEqual([String(RULE_AWARD[0]), String(RULE_AWARD[1])]);
      checked++;
    }
    expect(checked).toBe(2);
  }, 300_000);
});
