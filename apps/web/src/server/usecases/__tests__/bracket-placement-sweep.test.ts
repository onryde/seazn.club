// SCF fix round 1 (owner: "hope that all knockout stage have brackets"): every stage the engine builds as a bracket must come back from
// `bracketPlacement` as `card` or `page`, never `null`, once its fixtures exist - because a Bracket button on every bracket-type stage card
// (the owner's ask) has to open something. `bracketPlacement` returns `null` WITH fixtures when none of `twoSidedBracket`,
// `doubleElimBracket`, `pagePlayoffBracket` accepts the shape; that is a bracket-less bracket stage, and this sweep is what turns it red.
//
// REAL generators only (AGENTS.md class 1, TEST-STRATEGY): the stage usecases write the rows (`createStages` -> `generateStageFixtures`),
// the rows are READ BACK from Postgres (`round_no`, `seq_in_round`, exactly what the page hands the card), and only then asked. A hand-built
// `rowsOf(generator)` - what bracket-view.test.ts does - proves the generator's own numbering, not the writer's. The kinds are
// BRACKET_STAGE_KINDS and the templates are STAGE_TEMPLATES' own, filtered by that set: nothing here is a typed list of either. A template
// whose stages feed a bracket from an earlier stage is read twice: DAY ONE (the finals' TBD bracket, sized from the take, which every
// picker template flipped to - timing "setup") and SEEDED (the earlier stage played out, its proposal confirmed, the finals' slots filled).
//
// Real Postgres required; skipped without DATABASE_URL (the house convention of the sibling usecase suites).
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";
import type { AuthCtx } from "@/server/api-v1/auth";
import { bracketPlacement, type BracketPlacement } from "@/lib/bracket-view";
import { BRACKET_STAGE_KINDS } from "@/lib/run-sheet-groups";
import { STAGE_TEMPLATES, buildTemplateStages, type StageDraft, type TemplateKnobs } from "@/lib/format-templates";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { completeStage, computeSeedProposal, confirmSeedProposal, createStages, generateStageFixtures } from "../stages";
import { startDivision } from "../schedule";
import { scoreEvent } from "../scoring";

const HAS_DB = !!process.env.DATABASE_URL;

const GENERIC_CONFIG = { resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 }, progressScore: false };

async function seedOrg(): Promise<AuthCtx> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"Bps " + suffix}, ${"bps-" + suffix})
    returning id`;
  await setOrgPlan(orgId);
  await invalidateOrgEntitlements(orgId);
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('generic', 'Generic', '1.0.0', ${sql.json({ groups: [], lineup: { size: 1, benchMax: 0 } })})
    on conflict (key) do nothing`;
  await sql`
    insert into sport_variants (sport_key, key, name, config, is_system)
    values ('generic', 'score', 'Score', ${sql.json(GENERIC_CONFIG)}, true)
    on conflict do nothing`;
  return { orgId, via: "session", userId: null, role: "owner", keyId: null };
}

/** One division with `n` seeded individual entrants (seed i+1 = the i-th, so "lower seed wins" is a deterministic script). */
async function seedDivision(auth: AuthCtx, n: number) {
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "Bps Cup " + randomUUID().slice(0, 6), visibility: "private", branding: {} });
  const division = await createDivision(auth, comp.id, { name: "Open", slug: "open", sport_key: "generic", variant_key: "score", config: GENERIC_CONFIG });
  const entrants = await createEntrants(
    auth,
    division.id,
    Array.from({ length: n }, (_, i) => ({ kind: "individual" as const, display_name: `E${i + 1}`, seed: i + 1, members: [] })),
  );
  return { division, seedOf: new Map(entrants.map((e) => [e.id, e.seed ?? 99])) };
}

async function decide(auth: AuthCtx, fixtureId: string, hs: number, as_: number) {
  await scoreEvent(auth, fixtureId, { expected_seq: 0, type: "core.start", payload: {} });
  return scoreEvent(auth, fixtureId, { expected_seq: 1, type: "generic.result", payload: { p1Score: hs, p2Score: as_ } });
}

/** Generate, decide every decidable row (the lower seed wins), generate again (later rounds / the next Swiss round), until nothing is left. */
async function playOut(auth: AuthCtx, stageId: string, seedOf: Map<string, number>): Promise<void> {
  for (let guard = 0; guard < 60; guard++) {
    await generateStageFixtures(auth, stageId).catch(() => undefined);
    const rows = await sql<{ id: string; home_entrant_id: string | null; away_entrant_id: string | null; status: string }[]>`
      select id, home_entrant_id, away_entrant_id, status from fixtures where stage_id = ${stageId}`;
    const decidable = rows.filter((f) => f.home_entrant_id && f.away_entrant_id && !["decided", "finalized", "bye"].includes(f.status));
    if (decidable.length === 0) return;
    for (const f of decidable) {
      const homeWins = (seedOf.get(f.home_entrant_id!) ?? 99) < (seedOf.get(f.away_entrant_id!) ?? 99);
      await decide(auth, f.id, homeWins ? 2 : 0, homeWins ? 0 : 2);
    }
  }
  throw new Error(`playOut(${stageId}): did not converge`);
}

interface Seen {
  label: string;
  phase: "day-one" | "seeded";
  kind: string;
  rows: number;
  placement: BracketPlacement;
}

/** What the page hands the card for one stage: the persisted rows' bracket fields, read back. */
async function placementOf(stageId: string, kind: string): Promise<{ rows: number; placement: BracketPlacement }> {
  const rows = await sql<{ id: string; round_no: number; seq_in_round: number }[]>`
    select id, round_no, seq_in_round from fixtures where stage_id = ${stageId} order by round_no, seq_in_round`;
  return { rows: rows.length, placement: bracketPlacement(kind, rows) };
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

const KNOBS = (q: number, over: Partial<TemplateKnobs> = {}): TemplateKnobs => ({ qualified: q, swissRounds: 3, poolCount: 2, legs: 1, ...over });

/** The bracket-type templates, FROM the catalogue: every non-retired template with a stage whose kind is a bracket kind. */
const BRACKET_TEMPLATES = STAGE_TEMPLATES.filter((t) => !t.retired && t.build(KNOBS(4)).some((s) => BRACKET_STAGE_KINDS.has(s.kind)));
/** Whether a knob changes what a template builds (so a knob is only varied where it exists - the declaration, not a list of keys). */
const reads = (t: (typeof STAGE_TEMPLATES)[number], a: TemplateKnobs, b: TemplateKnobs): boolean => JSON.stringify(t.build(a)) !== JSON.stringify(t.build(b));
const usesQualified = (t: (typeof STAGE_TEMPLATES)[number]) => reads(t, KNOBS(3), KNOBS(5));
const usesPools = (t: (typeof STAGE_TEMPLATES)[number]) => reads(t, KNOBS(4, { poolCount: 2 }), KNOBS(4, { poolCount: 3 }));

/** Third-place on every knockout stage of a template (the knob exists on the knockout kind only). */
const withThirdPlace = (drafts: StageDraft[]): StageDraft[] => drafts.map((d) => (d.kind === "knockout" ? { ...d, config: { ...d.config, thirdPlace: true } } : d));

describe.skipIf(!HAS_DB)("every bracket-type stage the engine builds has a bracket to show (card or page), once its fixtures exist", () => {
  const seen: Seen[] = [];
  const refused: string[] = [];

  /** Create `drafts` as the division's stages, generate them in order, and record every bracket-kind stage's placement. */
  async function dayOne(label: string, n: number, drafts: StageDraft[]) {
    const auth = await seedOrg();
    const { division, seedOf } = await seedDivision(auth, n);
    let stages;
    try {
      stages = await createStages(auth, division.id, drafts.map((d, i) => ({ seq: i + 1, kind: d.kind, name: d.name, config: d.config, ...(d.progression ? { progression: d.progression } : {}) })) as never);
    } catch (e) {
      refused.push(`${label}: createStages refused (${(e as Error).message})`);
      return null;
    }
    const stageIds = stages.map((s) => s.id);
    for (const [i, id] of stageIds.entries()) {
      try {
        await generateStageFixtures(auth, id);
      } catch (e) {
        refused.push(`${label}: generate ${drafts[i]!.kind} refused (${(e as Error).message})`);
        continue;
      }
      if (BRACKET_STAGE_KINDS.has(drafts[i]!.kind)) {
        const got = await placementOf(id, drafts[i]!.kind);
        seen.push({ label: `${label} / ${drafts[i]!.name}`, phase: "day-one", kind: drafts[i]!.kind, ...got });
      }
    }
    return { auth, divisionId: division.id, stageIds, seedOf };
  }

  /** Play each stage out in turn, complete it, seed the next from it, and record the bracket stages the seeding filled. */
  async function seeded(label: string, n: number, drafts: StageDraft[]) {
    const ctx = await dayOne(label, n, drafts);
    if (!ctx) return;
    const { auth, divisionId, stageIds, seedOf } = ctx;
    try {
      await startDivision(auth, divisionId);
    } catch (e) {
      refused.push(`${label}: startDivision refused (${(e as Error).message})`);
      return;
    }
    for (let i = 0; i + 1 < stageIds.length; i++) {
      const next = drafts[i + 1]!;
      if (!next.progression) continue;
      try {
        await playOut(auth, stageIds[i]!, seedOf);
        await completeStage(auth, stageIds[i]!);
        const proposal = await computeSeedProposal(auth, stageIds[i + 1]!);
        const ties = proposal.computed.ties.map((t) => ({ slots: t.slots, order: [...t.entrantIds].sort((a, b) => (seedOf.get(a) ?? 99) - (seedOf.get(b) ?? 99)) }));
        await confirmSeedProposal(auth, stageIds[i + 1]!, { proposalId: proposal.id, ...(ties.length > 0 ? { tiePicks: ties } : {}) });
      } catch (e) {
        refused.push(`${label}: seeding ${drafts[i + 1]!.kind} from ${drafts[i]!.kind} refused (${(e as Error).message})`);
        return;
      }
      if (BRACKET_STAGE_KINDS.has(next.kind)) {
        const got = await placementOf(stageIds[i + 1]!, next.kind);
        seen.push({ label: `${label} / ${next.name}`, phase: "seeded", kind: next.kind, ...got });
      }
    }
  }

  it("standalone kinds, every field size 2..33 (byes, non-powers of two), with and without the third-place match / bracket reset", async () => {
    // One draft per bracket KIND (the set's own members) and per knob variant the kind has; the knobs are the stage usecase's own config keys.
    const variants = [...BRACKET_STAGE_KINDS].flatMap((kind): Array<[string, StageDraft]> => {
      const bare: StageDraft = { kind, name: kind, config: {}, progression: null };
      if (kind === "knockout") return [[kind, bare], [`${kind}+3rd`, { ...bare, config: { thirdPlace: true } }]];
      if (kind === "double_elim") return [[kind, bare], [`${kind}+reset`, { ...bare, config: { bracketReset: true } }]];
      return [[kind, bare]];
    });
    for (const [name, draft] of variants) {
      for (let n = 2; n <= 33; n++) await dayOne(`${name} n=${n}`, n, [draft]);
    }
    expect(seen.length, "anti-vacuity: standalone cases recorded").toBeGreaterThan(100);
  }, 600_000);

  it("every bracket template, day one (the finals' TBD bracket, sized from the take): a spread of field sizes, every qualifier count and pool count it reads", async () => {
    // What decides the finals' shape is the take (q) and the third-place knob, not the feeder's size, so the fields are a spread - the
    // smallest legal, odd and even, a power of two plus one, and the largest - while q takes every value the picker offers.
    const FIELDS = [2, 4, 9, 17, 33];
    const QS = [2, 3, 4, 5, 6, 8, 16];
    for (const t of BRACKET_TEMPLATES) {
      for (const n of FIELDS) {
        for (const q of usesQualified(t) ? QS.filter((x) => x <= n) : [4]) {
          for (const pools of usesPools(t) ? [2, 3, 4].filter((p) => p <= Math.floor(n / 2)) : [2]) {
            const base = buildTemplateStages(t.key, KNOBS(q, { poolCount: pools }));
            // The third-place knob exists on the knockout kind only: a template with none has one variant, not two.
            for (const third of base.some((d) => d.kind === "knockout") ? [false, true] : [false]) {
              await dayOne(`${t.key} n=${n} q=${q} pools=${pools} third=${third}`, n, third ? withThirdPlace(base) : base);
            }
          }
        }
      }
    }
    expect(seen.length, "anti-vacuity: template cases recorded").toBeGreaterThan(300);
  }, 900_000);

  it("every bracket template that a stage feeds, SEEDED: the earlier stage played out, completed, its proposal confirmed - then the finals' bracket", async () => {
    // Small fields only: playing a 24-entrant league out is a thousand writes and teaches nothing the day-one sweep did not (the shapes are
    // the same code). 5 has a bye in every single-elimination round it feeds; 8 does not; both a pool split and an uneven one are reached.
    for (const t of BRACKET_TEMPLATES) {
      if (!t.build(KNOBS(4)).some((s) => s.progression !== null)) continue;
      for (const n of [5, 8]) {
        for (const q of usesQualified(t) ? [3, 4] : [4]) {
          for (const third of n === 8 ? [false, true] : [false]) {
            const base = buildTemplateStages(t.key, KNOBS(q));
            await seeded(`${t.key} n=${n} q=${q} third=${third}`, n, third ? withThirdPlace(base) : base);
          }
        }
      }
    }
    expect(seen.filter((s) => s.phase === "seeded").length, "anti-vacuity: seeded cases recorded").toBeGreaterThan(20);
  }, 900_000);

  it("no bracket stage came back without a bracket; every kind, template, placement and phase was reached; every refusal is a known one", () => {
    const nulls = seen.filter((c) => c.placement === null);
    expect(
      nulls.map((c) => `${c.phase}: ${c.label} (${c.kind}, ${c.rows} rows)`),
      "bracket stages with fixtures that bracketPlacement draws nowhere - a Bracket button on them would open nothing",
    ).toEqual([]);

    // Anti-vacuity: the sweep asked about real fixtures, of every kind and template the declarations name, in both phases.
    expect(seen.length, "cases checked").toBeGreaterThan(500);
    expect(seen.filter((c) => c.rows === 0), "a stage with no fixtures is null by design - the sweep must never have asked about one").toEqual([]);
    for (const kind of BRACKET_STAGE_KINDS) expect(seen.some((c) => c.kind === kind), `kind ${kind} was checked`).toBe(true);
    for (const t of BRACKET_TEMPLATES) expect(seen.some((c) => c.phase === "day-one" && c.label.startsWith(`${t.key} `)), `template ${t.key} was checked day one`).toBe(true);
    for (const t of BRACKET_TEMPLATES.filter((x) => x.build(KNOBS(4)).some((st) => st.progression !== null))) {
      expect(seen.some((c) => c.phase === "seeded" && c.label.startsWith(`${t.key} `)), `template ${t.key} was checked after its earlier stage seeded it`).toBe(true);
    }
    expect(new Set(seen.map((c) => c.placement)), "both placements are reached (card and page)").toEqual(new Set(["card", "page"]));
    expect(BRACKET_TEMPLATES.length, "the owner's ten bracket templates are all in the catalogue").toBeGreaterThanOrEqual(10);

    // A refusal is the usecase saying no to an impossible request, not a stage that lost its bracket. Only these three are known; anything
    // else is a new refusal that someone has to read.
    const KNOWN: Array<[RegExp, string]> = [
      [/page playoffs need exactly 4 entrants/, "a standalone page playoff is the fixed four-team tree"],
      [/more rounds than this field can pair/, "a Swiss asked for more rounds than a tiny field can play"],
      [/has no loser at position/, "a Plate asked for more round-1 losers than a bye-padded Main draw has real matches (ko_plate, n=5, q=3)"],
    ];
    const unknown = refused.filter((r) => !KNOWN.some(([re]) => re.test(r)));
    expect(unknown, "refusals nobody has read").toEqual([]);
  });
});
