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
// Why ONE sport (the generic one) and not the registry: `bracketPlacement` reads three fields only - `id`, `round_no`, `seq_in_round`
// (`BracketFixtureRef`) - and the stage writer that numbers them is sport-blind (the bracket generators take entrants and the shape knobs,
// never a sport module). What varies a bracket's SHAPE is the field size and the knobs (third place, bracket reset, the take, the pool count),
// and those are swept explicitly below. A second sport would re-run the same writer over the same numbers.
//
// The count is printed (`bracket sweep: ...`) and asserted against what the sweep ENUMERATED: every bracket stage it asked about ends as a
// recorded case or a counted refusal, so a case cannot drop out silently. Each KNOWN refusal is tied to the cases it covers (label pattern
// and exact count), so one new refusing size or template fails here instead of hiding behind a pattern that happens to match.
//
// W4 T16 (X-SP-6): the stage create refuses a standalone stepladder or page playoff since ruling 269, but such stages STAND (stg held 11)
// and keep drawing a bracket, so the standalone sweep seeds those two kinds as the legacy row they now only can be
// (`_legacy-standalone-stage.ts`, pre-flight C5) and goes on asking the real generator about every size. The refusal itself is proven in
// standalone-stage-refusal.test.ts.
//
// W4 T24 (FX-G14's sweep half; premise 2: the allowlist stays): the SEEDED pass used to ask a Plate and a Qualifying + Main draw about two
// fields only (5 and 8). It now seeds every field the builder offers them - from each format's own bound (PLATE_MIN, QUALIFYING_MAIN_MIN: 4)
// to 19, then 33-35 - which crosses every bracket size (4, 8, 16, 32, 64) and every count of round-1 matches a bye-bearing bracket can have
// (1, 2 and 3 real matches in a bracket of 8, 16, 32 and 64: 5-7, 9-11, 17-19, 33-35; and 4 itself, two). Each field is counted (zero asked =
// failure) and the named ones - 5, 6, 7, 9, 17 - are asserted by name. What the Plate refuses is judged against the rule's arithmetic
// (`round1Matches`), field by field, and not against the usecase's own text.
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
import { PLATE_MIN, QUALIFYING_MAIN_MIN } from "@/lib/format-size-gates";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { completeStage, computeSeedProposal, confirmSeedProposal, generateStageFixtures } from "../stages";
import { startDivision } from "../schedule";
import { createStagesWithLegacy } from "./_legacy-standalone-stage";
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

/** Every field size a standalone bracket is asked at: 2..33 (the byes of every non-power-of-two, and 32 -> 33 crossing a round). */
const STANDALONE_SIZES = Array.from({ length: 32 }, (_, i) => i + 2);

/** W4 T24: the templates whose SEEDED pass is wide, and the smallest field each is offered - its own gate's constant (format-size-gates.ts),
 *  never a typed 4. Every other template keeps the two fields it always had (5 and 8). */
const WIDE_FROM: Readonly<Record<string, number>> = { ko_plate: PLATE_MIN, qualifying_main: QUALIFYING_MAIN_MIN };
/** The fields a wide template is seeded at: its bound..19 (bracket sizes 4, 8, 16 and every bye count between) then 33..35 (the same
 *  three byte counts again on a bracket of 64, past the point a round crosses). */
const wideFields = (from: number): number[] => [...Array.from({ length: 19 - from + 1 }, (_, i) => from + i), 33, 34, 35];
/** The fields the owner and the brief name: one real round-1 match (5), two (6), three (7) in a bracket of 8, and the same on 16 (9) and 32 (17). */
const NAMED_FIELDS = [5, 6, 7, 9, 17];
/** The cut sizes the seeded pass asks (a Plate's round-1 loser count; a Qualifying + Main draw's cut). */
const SEEDED_QS = [3, 4];
/** A single-elimination bracket of `n` rounds up to the next power of two P and plays n - P/2 lines of round 1 for real (the rest are byes;
 *  a power of two plays P/2) - the arithmetic of the rule, not a read of the generator. Each real line has one loser. */
const round1Matches = (n: number): number => n - 2 ** Math.ceil(Math.log2(n)) / 2;
/** The (n, q) a Plate cannot be seeded for until PR B's first-loss feed (owed: W4 PR B first-loss feed, FX-G14 close): the Plate takes the
 *  round-1 losers of the Main draw, q of them, and the Main draw plays fewer round-1 lines than that. */
const plateUnfilled = (fields: readonly number[]): Array<{ n: number; q: number }> =>
  fields.flatMap((n) => SEEDED_QS.filter((q) => round1Matches(n) < q).map((q) => ({ n, q })));
const PLATE_FIELDS = wideFields(WIDE_FROM.ko_plate!);
const PLATE_UNFILLED = plateUnfilled(PLATE_FIELDS);
const PLATE_UNFILLED_FIELDS = [...new Set(PLATE_UNFILLED.map((u) => u.n))];

/** A refusal is the usecase saying no to an impossible request, not a stage that lost its bracket. Each known one is tied to the cases it
 *  covers - a label pattern AND an exact count - so a new refusing size or template fails instead of matching a loose regex. */
const KNOWN_REFUSALS: Array<{ re: RegExp; expected: number; why: string }> = [
  {
    re: /^page_playoff n=\d+: generate page_playoff refused \(page playoffs need exactly 4 entrants, got \d+\)$/,
    expected: STANDALONE_SIZES.filter((n) => n !== 4).length,
    why: "a standalone page playoff (since X-SP-6 a legacy row only, seeded as one) is the fixed four-team tree: every size but 4",
  },
  {
    re: /^swiss_(playoff|knockout) n=2 q=\d+ pools=\d+ third=(true|false): generate swiss refused \(That is more rounds than this field can pair\.\)$/,
    expected: 3,
    why: "a Swiss feeder asked for more rounds than two entrants can play (swiss_playoff q=4; swiss_knockout q=2 with and without third place)",
  },
  {
    re: new RegExp(`^ko_plate n=(${PLATE_UNFILLED_FIELDS.join("|")}) q=[34] third=false: seeding knockout from knockout refused \\(bracket round 1 has no loser at position \\d+ \\(found \\d+\\)\\)$`),
    expected: PLATE_UNFILLED.length,
    why: "owed: W4 PR B first-loss feed (FX-G14 close) - a Plate asked for the round-1 loser at a position the Main draw does not play: fewer real round-1 matches than the q losers it takes (fields 4-7, 9-11, 17-19 and 33-35: at q=3 where there are fewer than 3, at q=4 where there are fewer than 4)",
  },
  {
    re: /^ko_plate n=2 q=\d+ pools=\d+ third=(true|false): generate knockout refused \(Knockout \+ Plate needs at least 4 entrants\.\)$/,
    expected: 2,
    why: "X-PL-1: Knockout + Plate is refused below 4; the sweep's one field under the bound is 2, with and without third place",
  },
  {
    re: /^qualifying_main n=\d+ q=(3( pools=\d+)? third=false|[56]( pools=\d+)? third=(true|false)): createStages refused \(From a knockout, qualify a whole round: 1, 2, 4, 8 …\)$/,
    expected: 16 + wideFields(WIDE_FROM.qualifying_main!).length,
    why: "X-QM-2 (RB4-Q2): a cut of 1-5 or 1-6 from a knockout ends inside a finishing band, and so does 1-3 unless the source plays a third-place match. Day one 16 (n=4 at q=3; n=9, 17 and 33 at q=3 and, with and without third place, q=5 and 6) and seeded one per wide field (q=3 without third place, 19 fields)",
  },
];

/** Every problem with a list of refusals: a rule that covered the wrong number of cases, and a refusal no rule has read. Empty = clean. */
function auditRefusals(refused: readonly string[]): { problems: string[] } {
  const problems: string[] = [];
  for (const k of KNOWN_REFUSALS) {
    const got = refused.filter((r) => k.re.test(r)).length;
    if (got !== k.expected) problems.push(`known refusal "${k.why}" covered ${got} cases, expected ${k.expected}`);
  }
  for (const r of refused) if (!KNOWN_REFUSALS.some((k) => k.re.test(r))) problems.push(`unread refusal: ${r}`);
  return { problems };
}

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
  /** Every bracket stage the sweep asked about (about to generate / about to seed), and how many of those the usecase refused. */
  let enumerated = 0;
  let refusedBracket = 0;
  /** W4 T24: every (wide template, field, q, third) the seeded pass asked, so a field cannot drop out of the widened sweep unnoticed. */
  const wideAsked: Array<{ key: string; n: number; q: number; third: boolean }> = [];

  /** Create `drafts` as the division's stages, generate them in order, and record every bracket-kind stage's placement. */
  async function dayOne(label: string, n: number, drafts: StageDraft[]) {
    const auth = await seedOrg();
    const { division, seedOf } = await seedDivision(auth, n);
    let stages;
    try {
      stages = await createStagesWithLegacy(auth, division.id, drafts.map((d, i) => ({ seq: i + 1, kind: d.kind, name: d.name, config: d.config, ...(d.progression ? { progression: d.progression } : {}) })) as never);
    } catch (e) {
      refused.push(`${label}: createStages refused (${(e as Error).message})`);
      return null;
    }
    const stageIds = stages.map((s) => s.id);
    for (const [i, id] of stageIds.entries()) {
      const isBracket = BRACKET_STAGE_KINDS.has(drafts[i]!.kind);
      if (isBracket) enumerated++;
      try {
        await generateStageFixtures(auth, id);
      } catch (e) {
        refused.push(`${label}: generate ${drafts[i]!.kind} refused (${(e as Error).message})`);
        if (isBracket) refusedBracket++;
        continue;
      }
      if (isBracket) {
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
      const nextIsBracket = BRACKET_STAGE_KINDS.has(next.kind);
      if (nextIsBracket) enumerated++;
      try {
        await playOut(auth, stageIds[i]!, seedOf);
        await completeStage(auth, stageIds[i]!);
        const proposal = await computeSeedProposal(auth, stageIds[i + 1]!);
        const ties = proposal.computed.ties.map((t) => ({ slots: t.slots, order: [...t.entrantIds].sort((a, b) => (seedOf.get(a) ?? 99) - (seedOf.get(b) ?? 99)) }));
        await confirmSeedProposal(auth, stageIds[i + 1]!, { proposalId: proposal.id, ...(ties.length > 0 ? { tiePicks: ties } : {}) });
      } catch (e) {
        refused.push(`${label}: seeding ${drafts[i + 1]!.kind} from ${drafts[i]!.kind} refused (${(e as Error).message})`);
        if (nextIsBracket) refusedBracket++;
        return;
      }
      if (nextIsBracket) {
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
      for (const n of STANDALONE_SIZES) await dayOne(`${name} n=${n}`, n, [draft]);
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
      const from = WIDE_FROM[t.key];
      for (const n of from === undefined ? [5, 8] : wideFields(from)) {
        for (const q of usesQualified(t) ? SEEDED_QS : [4]) {
          for (const third of n === 8 ? [false, true] : [false]) {
            const base = buildTemplateStages(t.key, KNOBS(q));
            if (from !== undefined) wideAsked.push({ key: t.key, n, q, third });
            await seeded(`${t.key} n=${n} q=${q} third=${third}`, n, third ? withThirdPlace(base) : base);
          }
        }
      }
    }
    expect(seen.filter((s) => s.phase === "seeded").length, "anti-vacuity: seeded cases recorded").toBeGreaterThan(20);
    // W4 T24: the widened pass asked every field of every wide template (counted - zero asked is a failure), the named ones included.
    for (const [key, from] of Object.entries(WIDE_FROM)) {
      expect(BRACKET_TEMPLATES.some((t) => t.key === key), `${key} is a bracket template with a progression`).toBe(true);
      const asked = [...new Set(wideAsked.filter((a) => a.key === key).map((a) => a.n))].sort((a, b) => a - b);
      expect(asked, `${key}: the fields the seeded pass asked`).toEqual(wideFields(from));
      expect(asked.length, `${key}: counted`).toBe(19 - from + 1 + 3);
      for (const n of NAMED_FIELDS) expect(asked, `${key}: the named field ${n}`).toContain(n);
      expect(wideAsked.filter((a) => a.key === key).length, `${key}: every (field, q, third) asked`).toBe(asked.length * SEEDED_QS.length + SEEDED_QS.length);
    }
  }, 900_000);

  it("no bracket stage came back without a bracket; every kind, template, placement and phase was reached; every refusal is a known one", () => {
    const by = (key: (c: Seen) => string) => JSON.stringify(Object.fromEntries([...new Set(seen.map(key))].sort().map((k) => [k, seen.filter((c) => key(c) === k).length])));
    const report = `bracket sweep: ${seen.length} cases checked (by kind ${by((c) => c.kind)}; by placement ${by((c) => String(c.placement))}; by phase ${by((c) => c.phase)}), ${refusedBracket} bracket stages refused, ${enumerated} enumerated`;
    console.info(report);
    expect(seen.length + refusedBracket, `every enumerated bracket stage is a recorded case or a counted refusal - ${report}`).toBe(enumerated);
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

    // W4 T24: what the widened seeded pass MET, field by field, against the rule's arithmetic (round1Matches), never against the usecase's own text.
    for (const n of wideFields(WIDE_FROM.ko_plate!)) {
      for (const q of SEEDED_QS) {
        const label = `ko_plate n=${n} q=${q} third=false`;
        const refusedHere = refused.some((r) => r.startsWith(`${label}: seeding knockout from knockout refused`));
        const recordedHere = seen.some((c) => c.phase === "seeded" && c.label === `${label} / Plate`);
        const owed = PLATE_UNFILLED.some((u) => u.n === n && u.q === q);
        expect(refusedHere, `${label}: refused iff the Main draw plays fewer than ${q} round-1 matches (${round1Matches(n)} here)`).toBe(owed);
        expect(recordedHere, `${label}: the Plate is drawn iff it was not refused`).toBe(!owed);
      }
    }
    expect(PLATE_UNFILLED.length, "the named fields refuse at the builder's cut (4), which is where the rule bites").toBeGreaterThan(0);
    for (const n of NAMED_FIELDS) expect(PLATE_UNFILLED.some((u) => u.n === n && u.q === 4), `ko_plate n=${n} is owed at q=4`).toBe(true);
    for (const n of wideFields(WIDE_FROM.qualifying_main!)) {
      expect(seen.some((c) => c.phase === "seeded" && c.label === `qualifying_main n=${n} q=4 third=false / Main draw`), `qualifying_main n=${n} q=4: the Main draw is drawn`).toBe(true);
      expect(refused.some((r) => r.startsWith(`qualifying_main n=${n} q=3 third=false: createStages refused`)), `qualifying_main n=${n} q=3 without a third-place match: a cut of 1-3 is no whole band`).toBe(true);
    }

    // A refusal is the usecase saying no to an impossible request, not a stage that lost its bracket (see `auditRefusals`).
    const audit = auditRefusals(refused);
    expect(audit.problems, `refusals: ${refused.length} read`).toEqual([]);
    expect(refused.length, "anti-vacuity: the sweep did meet refusals (the three known ones)").toBeGreaterThan(0);
  });
});

// The audit itself, without a database: it must accept exactly the refusals the real sweep meets today and reject each way they can drift.
describe("the sweep's refusal audit (no database)", () => {
  const PP = (n: number) => `page_playoff n=${n}: generate page_playoff refused (page playoffs need exactly 4 entrants, got ${n})`;
  const SW = (name: string, q: number, third: boolean) => `${name} n=2 q=${q} pools=2 third=${third}: generate swiss refused (That is more rounds than this field can pair.)`;
  // The Plate asks for the loser at the position after the last real round-1 line, and finds as many as the Main draw plays.
  const PL = (n: number, q: number) => `ko_plate n=${n} q=${q} third=false: seeding knockout from knockout refused (bracket round 1 has no loser at position ${round1Matches(n) + 1} (found ${round1Matches(n)}))`;
  const SMALL_PLATE = (third: boolean) => `ko_plate n=2 q=2 pools=2 third=${third}: generate knockout refused (Knockout + Plate needs at least 4 entrants.)`;
  const CUT = (n: number, q: number, third: boolean, pools = " pools=2") => `qualifying_main n=${n} q=${q}${pools} third=${third}: createStages refused (From a knockout, qualify a whole round: 1, 2, 4, 8 …)`;
  const THIRDS = [false, true];
  // A cut of 1-3 is no whole band unless the source plays a third-place match (then it is), so q=3 refuses without one only.
  const CUTS = [
    CUT(4, 3, false),
    ...[9, 17, 33].flatMap((n) => [CUT(n, 3, false), ...[5, 6].flatMap((q) => THIRDS.map((t) => CUT(n, q, t)))]),
    ...wideFields(WIDE_FROM.qualifying_main!).map((n) => CUT(n, 3, false, "")),
  ];
  const today = (): string[] => [
    ...STANDALONE_SIZES.filter((n) => n !== 4).map(PP),
    SW("swiss_playoff", 4, false),
    SW("swiss_knockout", 2, false),
    SW("swiss_knockout", 2, true),
    ...PLATE_UNFILLED.map(({ n, q }) => PL(n, q)),
    ...THIRDS.map(SMALL_PLATE),
    ...CUTS,
  ];

  it("accepts exactly what the sweep meets today (93 refusals: 31 + 3 + 22 + 2 + 35)", () => {
    // 22 Plate refusals: 13 fields at q=4 (4-7, 9-11, 17-19, 33-35) and 9 at q=3 (4-6, 9-10, 17-18, 33-34); 35 cuts: 16 day one + 19 seeded.
    expect(PLATE_UNFILLED.length).toBe(22);
    expect(PLATE_UNFILLED_FIELDS).toEqual([4, 5, 6, 7, 9, 10, 11, 17, 18, 19, 33, 34, 35]);
    expect(CUTS.length).toBe(35);
    expect(today().length).toBe(93);
    expect(auditRefusals(today()).problems).toEqual([]);
  });

  it("rejects every way the refusals can drift: a new size, a new template, a different size of the same refusal, one fewer, an unread text", () => {
    const cases: Array<[string, string[]]> = [
      ["page_playoff n=4 refused too (the valid size)", [...today(), PP(4)]],
      ["one page_playoff size no longer refuses", today().filter((r) => r !== PP(7))],
      ["a Swiss refusal at a size the rule does not name", [...today(), SW("swiss_knockout", 2, true).replace("n=2", "n=3")]],
      ["a fourth Swiss refusal", [...today(), SW("swiss_playoff", 2, true)]],
      ["a Plate refusal at a field whose Main draw plays enough round-1 matches (8 plays 4)", [...today(), PL(8, 4)]],
      ["one Plate field no longer refuses (7 plays 3 round-1 matches, under the builder's 4)", today().filter((r) => r !== PL(7, 4))],
      ["the Plate refusal MOVED to another size (same count, so only the label pattern can see it)", [...today().filter((r) => r !== PL(5, 3)), PL(8, 3)]],
      ["a Swiss refusal MOVED to another template (same count)", [...today().filter((r) => r !== SW("swiss_playoff", 4, false)), SW("swiss_other", 4, false)]],
      ["the Plate refusal at another q", [...today().filter((r) => r !== PL(5, 4)), PL(5, 5)]],
      ["a refusal text nobody has read", [...today(), "ko_plate n=8 q=4 third=false: seeding knockout from knockout refused (something new)"]],
      ["the plate refused at a field the bound allows", [...today(), SMALL_PLATE(false).replace("n=2", "n=4")]],
      ["one small plate no longer refused", today().filter((r) => r !== SMALL_PLATE(true))],
      ["a whole-round cut refused (q=4 is one)", [...today().filter((r) => r !== CUT(9, 3, false)), CUT(9, 4, false)]],
      ["a cut of 1-3 refused where the source plays a third-place match (it is whole there)", [...today().filter((r) => r !== CUT(9, 3, false)), CUT(9, 3, true)]],
      ["another template refused for its cut", [...today(), CUT(9, 3, false).replace("qualifying_main", "ko_plate")]],
      ["a wide field's seeded cut no longer refused (q=3 without a third-place match is no whole band)", today().filter((r) => r !== CUT(12, 3, false, ""))],
      ["a seeded cut refused WITH a third-place match (a cut of 1-3 is whole there)", [...today().filter((r) => r !== CUT(12, 3, false, "")), CUT(12, 3, true, "")]],
    ];
    let rejected = 0;
    for (const [what, list] of cases) {
      expect(auditRefusals(list).problems.length, what).toBeGreaterThan(0);
      rejected++;
    }
    expect(rejected, "anti-vacuity: every drift reached").toBe(cases.length);
  });
});
