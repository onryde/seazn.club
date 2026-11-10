// W4 app-A T26c (owner 2026-11-09: "if gaps found, add the sweep test in this PR"; placeholder-placement-audit.md G1/G3):
// for every format the division builder offers, are the matches GENERATED and PLACED? Every in-scope STAGE_TEMPLATES
// entry, at fields 3, 5 and 8, with and without a third-place match where the template draws a knockout, is built through
// the builder's own door (`formatStagesFor` at `openingKnobs(n)`), created (`createStages`), generated stage by stage
// (`generateStageFixtures`, the Generate press), then auto-placed stage by stage (`autoSchedule` BUILD + `applySchedule`,
// the Schedule tab's Auto-schedule) over two courts. Then, read back from Postgres:
//
//   (a) GENERATED — each stage's rows are what the ENGINE declares for that field: a bracket's ext_keys equal the engine
//       generator's own fixture ids for that size (root: the field; fed: the take's size, `expandTake`), a league's count
//       is `roundRobinFixtureCount`, a Swiss draws every round at once (rounds x ceil(n/2), one bye shell a round on an
//       odd field - rulebook W3 §4).
//   (b) PLACED — a line nobody plays holds NO time and NO court; every other line holds BOTH (G3: time AND court, never
//       `holdsSlot`'s OR). "Nobody plays it" is judged from the ENGINE's bracket, never the product's `isByeLine`: a bye
//       line (`award`), and a line structurally fated to be one - a seat whose only feeder can never produce an entrant
//       (the loser of a bye line, of a fated bye, or the winner of a line with both seats dead). A Swiss bye shell is the
//       one bye the engine does not draw; it is read with the product's `isByeLine` and its COUNT held to the rulebook's.
//
// Scope (owner 2026-11-09, T26c brief's SCOPE RULING): double_elim belongs to W6 and americano / mexicano / ladder to W7;
// each is excluded BY KEY with its wave named, and the exclusion's size is pinned so a new template cannot slip into it.
// A `retired` template is left out by the product's own flag. Combos the builder's size gate refuses (`stageGraphSizeGate`)
// are not placed - the server's own refusal is asserted to be the gate's named code instead: a root knockout a field of 3
// cannot fill (ko_plate, qualifying_main) and a page playoff fed by fewer entrants than its size (group_playoffs,
// swiss_playoff - T26c fix round 1, I1: its "Rank 4" seat could never be filled, yet it got a court and a time).
//
// Owed (by name): a knockout drawn at 3 WITH a third-place match - the root knockout at n=3, and a fed knockout taking a
// Top 3 (league_ko, groups_ko, swiss_knockout at n=3) - puts its third-place line on the timetable although one of its
// seats is the bye semi's loser, which never exists (G1, knockout half). Third place is W4 app PR B's; the sweep holds the
// exact list so PR B's fix turns it red here. G1's double-elimination half is W6's (W6-double-elim.md, "Carried from W4").
//
// Two sports, one per entrant kind the registry DECLARES as a default (a team sport and an individual one - different
// scoring, different entrant model), each the registry's first that is offered every in-scope template. The placement
// reads no sport field (schedule/ never reads the module); two sports prove that rather than assume it.
//
// BUILD runs as the product runs it, solver or not. Locally, without PLACEMENT_SERVICE_HOST, it falls back to greedy
// (day-one-fixtures-survive-build.test.ts explains the logged solveBuild failure). On CI this file runs in
// smoke-db-usecases, which starts the real CP-SAT placement service (ci.yml "Start the placement service"), so there the
// solver places what it accepts; measured 2026-11-09 with the service up, it refuses a request holding a seatless shell
// (INVALID_REQUEST "neither entrant_indices nor person_indices") and BUILD falls back to greedy for that stage. The
// verdicts read what was placed, never which placer placed it, so they hold under both.
//
// The rest between a player's matches is the settings' own default (`perEntrantMinRest` 0, ScheduleConfig in api-v1/schemas/scheduling.ts).
// A rest above 0 is OUT OF SCOPE here, pending engine 6.0.1 (the finding routed in task-26c-report.md: with a rest of 30,
// BUILD leaves every line fed by an undecided line unplaced - blocking `warn.order` H6 "starts inside feeder's rest" -
// 4 of a bracket of 8's 7 lines placed, which also hides G1, since the owed third-place lines are fed lines). Add those
// cases when that release lands, not before.
//
// Real Postgres required; skipped without DATABASE_URL (the house convention of the sibling usecase suites).
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { builtinModules } from "@seazn/engine/sports";
import { effectiveEntrantModel, type AnySportModule } from "@seazn/engine/sport";
import { expandTake, type TakeRule } from "@seazn/engine/competition";
import {
  generatePagePlayoff,
  generateSingleElim,
  generateStepladder,
  roundRobinFixtureCount,
  type GeneratedBracket,
} from "@seazn/engine/scheduling";
import { sql } from "@/lib/db";
import { isByeLine, type ByeLineRow } from "@/lib/bye-line";
import { STAGE_TEMPLATES, templatesForSport, type StageDraft } from "@/lib/format-templates";
import { stageGraphSizeGate } from "@/lib/format-size-gates";
import { formatKnobsShown, formatStagesFor } from "@/lib/division-builder/format-choice";
import { openingKnobs } from "@/lib/division-builder/model";
import { engineEntrantKinds } from "@/lib/__tests__/_engine-entrant-kinds";
import type { AuthCtx } from "@/server/api-v1/auth";
import type { CreateStages } from "@/server/api-v1/schemas";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { applySchedule, autoSchedule, putScheduleSettings } from "../schedule";
import { createStages, generateStageFixtures } from "../stages";
import { createCourt, createVenue } from "../venues";
import { seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

// ─── What is enumerated ────────────────────────────────────────────────────────────────────────────────────────────────

/** Out of this sweep by owner ruling (2026-11-09), each with the wave that owes its placement proof. */
const EXCLUDED: Readonly<Record<string, string>> = {
  double_elim: "W6 (double elimination): G1's losers-bracket half - a line fed by a bye line's loser is placed like a match (W6-double-elim.md)",
  americano: "W7 (americano / mexicano / ladder): placement proof owed - americano takes the league's path",
  mexicano: "W7 (americano / mexicano / ladder): placement proof owed - one round a press, placed per round",
  ladder: "W7 (americano / mexicano / ladder): placement proof owed - its rows come from challenges, none at Generate",
};
/** How many keys the exclusion holds. A fifth key is a ruling, not an edit: this pin is what makes it one. */
const EXCLUDED_COUNT = 4;

const IN_SCOPE = STAGE_TEMPLATES.filter((t) => t.retired !== true && !(t.key in EXCLUDED)).map((t) => t.key);

/** The fields: a bye semi (3), byes in round 1 (5), no byes (8). */
const FIELDS = [3, 5, 8] as const;

/** G1, knockout half - owed to W4 app PR B (third place is PR B's). A knockout drawn at 3 with a third-place match: the
 *  third-place line's home seat is the loser of the bye semi, which never exists, yet the line holds a time and a court.
 *  Root: `knockout` at n=3. Fed (a Top 3 out of 3, see `topNFor`): every template whose finals knockout reads the Top N. */
const OWED_PR_B_TEMPLATES = ["knockout", "league_ko", "groups_ko", "swiss_knockout"] as const;
const OWED_PR_B_WHY = "owed: W4 app PR B (third place) - G1 knockout half: a third-place line fed by a bye semi's loser is placed like a match";

/** The Top N the builder sends: its opening knob (4, `openingKnobs`) where the box is shown and the field fills it, else
 *  the whole field - an organiser with 3 entrants takes a Top 3, so the finals' bracket has a bye exactly as a root
 *  bracket of 3 does. A template that shows no box is sent the templates' own 4 by `formatStagesFor` whatever is passed. */
function topNFor(template: string, n: number): number {
  const opening = openingKnobs(n).qualified;
  return formatKnobsShown(template).secondStage ? Math.min(opening, n) : opening;
}

/** The stage drafts the builder posts for `template` at a field of `n`, optionally with a third-place match on every
 *  knockout stage (the knob exists on the knockout kind only). */
function draftsFor(template: string, n: number, third: boolean): StageDraft[] {
  const drafts = formatStagesFor(template, { ...openingKnobs(n), qualified: topNFor(template, n), standingsCarry: "none" });
  return third ? drafts.map((d) => (d.kind === "knockout" ? { ...d, config: { ...d.config, thirdPlace: true } } : d)) : drafts;
}

/** Whether a template draws any knockout stage (so third place is a variant of it). */
const drawsKnockout = (template: string): boolean => draftsFor(template, 8, false).some((d) => d.kind === "knockout");

/** The in-scope templates that end in a page playoff, read from the drafts the builder posts. */
const PAGE_PLAYOFF_TEMPLATES = IN_SCOPE.filter((t) => draftsFor(t, 8, false).some((d) => d.kind === "page_playoff")).sort();

/** The page playoff's size as the ENGINE declares it: the one field `generatePagePlayoff` draws, seating every entrant.
 *  It exports no constant, so the generator is asked; "exactly one size" is a guard, not an assumption. */
function enginePagePlayoffSize(): number {
  const accepted: number[] = [];
  for (let k = 0; k <= 16; k++) {
    const entrants = Array.from({ length: k }, (_, i) => `e${i + 1}`);
    let bracket: GeneratedBracket;
    try {
      bracket = generatePagePlayoff({ entrants, seeds: new Map(entrants.map((e, i) => [e, i + 1])) });
    } catch {
      continue;
    }
    const seated = new Set(bracket.fixtures.flatMap((f) => [f.home, f.away]).filter((e) => e !== undefined));
    if (seated.size !== k) throw new Error(`generatePagePlayoff(${k}) seats ${seated.size} of ${k}`);
    accepted.push(k);
  }
  if (accepted.length !== 1) throw new Error(`generatePagePlayoff draws ${accepted.length} sizes in 0..16 (${accepted.join(", ")}), not one`);
  return accepted[0]!;
}

interface SportPick {
  key: string;
  variant: string;
  kind: "team" | "individual" | "pair";
}

/** One sport per entrant kind the registry declares as a DEFAULT, each the registry's first offered every in-scope template. */
function sportsByDefaultKind(): SportPick[] {
  const modelOf = (m: AnySportModule) => effectiveEntrantModel(m.entrantModel ?? null, null);
  const kinds = [...new Set(builtinModules.map((m) => modelOf(m as AnySportModule).defaultKind))];
  return kinds.map((kind) => {
    const m = builtinModules.find(
      (x) =>
        modelOf(x as AnySportModule).defaultKind === kind &&
        IN_SCOPE.every((t) => templatesForSport(x.key, engineEntrantKinds(x.key)).some((o) => o.key === t)),
    );
    if (m === undefined) throw new Error(`no sport defaulting to '${kind}' is offered every in-scope template`);
    const variant = Object.keys(m.variants)[0];
    if (variant === undefined) throw new Error(`sport ${m.key} declares no variant`);
    return { key: m.key, variant, kind };
  });
}
const SPORTS = sportsByDefaultKind();

// ─── The oracle: what the ENGINE says each line is ─────────────────────────────────────────────────────────────────────

/** `match` is played; `bye` is the engine's own bye line (`award`); `fated_bye` has exactly one seat no entrant can ever
 *  reach; `dead` has two. Only `match` is ever placed. */
type LineFate = "match" | "bye" | "fated_bye" | "dead";

/** Every line of `bracket` and its fate, from the engine's own fixtures and feed edges only. EMPTY CASE FIRST: an empty
 *  bracket has no lines. A seat is DEAD when it has no entrant and its feeder cannot produce one: the loser of anything but
 *  a played match (a bye, a fated bye and a dead line have no loser), or the winner of a dead line. */
function bracketFates(bracket: GeneratedBracket): Map<string, LineFate> {
  const fates = new Map<string, LineFate>();
  if (bracket.fixtures.length === 0) return fates;
  const byId = new Map(bracket.fixtures.map((f) => [f.id, f]));
  const fateOf = (id: string): LineFate => {
    const known = fates.get(id);
    if (known !== undefined) return known;
    const f = byId.get(id);
    if (f === undefined) throw new Error(`bracket feed names a line it does not draw: ${id}`);
    const seatDead = (entrant: string | undefined, from: { fixtureId: string; side: "winner" | "loser" } | undefined): boolean => {
      if (entrant !== undefined) return false;
      if (from === undefined) return true;
      const source = fateOf(from.fixtureId);
      return from.side === "winner" ? source === "dead" : source !== "match";
    };
    const dead = f.award !== undefined ? -1 : [seatDead(f.home, f.homeFrom), seatDead(f.away, f.awayFrom)].filter(Boolean).length;
    const fate: LineFate = dead === -1 ? "bye" : dead === 0 ? "match" : dead === 1 ? "fated_bye" : "dead";
    fates.set(id, fate);
    return fate;
  };
  for (const f of bracket.fixtures) fateOf(f.id);
  return fates;
}

/** The engine's bracket for a stage of `kind` drawn over `k` seeded entrants (`config` read for the third-place match).
 *  "Cannot happen" for a kind this sweep's scope does not draw - so it throws. */
function engineBracket(kind: string, k: number, config: Record<string, unknown>): GeneratedBracket {
  const entrants = Array.from({ length: k }, (_, i) => `e${i + 1}`);
  const seeds = new Map(entrants.map((e, i) => [e, i + 1]));
  if (kind === "knockout") return generateSingleElim({ entrants, seeds, thirdPlace: config.thirdPlace === true });
  if (kind === "stepladder") return generateStepladder({ entrants, seeds });
  if (kind === "page_playoff") return generatePagePlayoff({ entrants, seeds });
  throw new Error(`engineBracket: '${kind}' is no bracket kind an in-scope template draws`);
}

const BRACKET_KINDS = new Set(["knockout", "stepladder", "page_playoff"]);
const TABLE_KINDS = new Set(["league", "group", "swiss"]);

/** The field a stage is drawn at: the division's for a root stage, else the size of its take (the engine's expansion of
 *  the rules over the source's shape - its pool keys, from the source's own config). */
function fieldOf(drafts: readonly StageDraft[], at: number, n: number): number {
  const stage = drafts[at]!;
  if (stage.progression === null) return n;
  const source = drafts[at - 1];
  if (source === undefined) throw new Error(`stage ${stage.name} draws from a previous stage that does not exist`);
  const pools = source.kind === "group" ? Number((source.config.pools as { count?: unknown } | undefined)?.count ?? 1) : 0;
  const shape = { poolKeys: Array.from({ length: pools }, (_, i) => String.fromCharCode(65 + i)) };
  return stage.progression.sources.reduce((sum, s) => sum + expandTake(s.take as TakeRule[], shape).flat().length, 0);
}

/** Snake-distributed pool sizes for `n` over `count` pools (each pool takes one per wave): the arithmetic of the draw. */
const poolSizes = (n: number, count: number): number[] =>
  Array.from({ length: count }, (_, i) => Math.floor(n / count) + (i < n % count ? 1 : 0));

// ─── The rig ───────────────────────────────────────────────────────────────────────────────────────────────────────────

interface Row extends ByeLineRow {
  id: string;
  stage_id: string;
  round_no: number;
  scheduled_at: Date | null;
  court_id: string | null;
}

interface Checked {
  label: string;
  template: string;
  sport: string;
  rows: number;
  /** Lines that hold a time AND a court. */
  placed: number;
  /** Lines that hold neither (byes, fated byes, dead lines). */
  off: number;
  /** Of `off`, the engine's fated byes and dead lines (not its plain byes) - kept off the timetable. A fated line that IS
   *  placed is not counted here: it is a problem (today exactly the owed third-place lines, see the verdict). */
  fated: number;
}

/** A division of `n` seeded entrants of the sport's default kind, two courts and saved settings (the stages are the caller's). */
async function rig(sport: SportPick, n: number) {
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: `Placement sweep ${randomUUID().slice(0, 6)}`,
    visibility: "private",
    branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name: "Open",
    slug: "open-" + randomUUID().slice(0, 6),
    sport_key: sport.key,
    variant_key: sport.variant,
    config: {},
  });
  await createEntrants(
    auth,
    division.id,
    Array.from({ length: n }, (_, i) => ({ kind: sport.kind, display_name: `E${i + 1}`, seed: i + 1, members: [] })),
  );
  const venue = await createVenue(auth, { name: "Main venue", sort: 0 });
  const courts = [
    await createCourt(auth, venue.id, { name: "Court 1", sort: 0, tags: [] }),
    await createCourt(auth, venue.id, { name: "Court 2", sort: 1, tags: [] }),
  ].map((c) => c.id);
  await putScheduleSettings(auth, division.id, {
    config: {
      startAt: "2030-08-01T09:00:00.000Z",
      matchMinutes: 30,
      gapMinutes: 0,
      courts,
      perEntrantMinRest: 0,
      blackouts: [],
      sessionWindows: [],
    },
    tz: "UTC",
  });
  return { auth, divisionId: division.id };
}

async function place(auth: AuthCtx, stageId: string): Promise<void> {
  const build = await autoSchedule(auth, stageId, { only_unlocked: false, mode: "build" });
  await applySchedule(auth, stageId, {
    assignments: build.assignments.map((a) => ({ fixture_id: a.fixture_id, scheduled_at: a.scheduled_at, court_id: a.court_id })),
    source: "auto",
  });
}

const slotOf = (r: Row): string => `time=${r.scheduled_at !== null} court=${r.court_id !== null}`;

describe.skipIf(!HAS_DB)("every in-scope format template is generated as the engine draws it and placed: matches on the timetable, byes off it", () => {
  const checked: Checked[] = [];
  /** Every placement or generation fault, as one line each (`label / stage: what`). */
  const problems: string[] = [];
  /** Combos the builder's size gate refuses, with the code the server's own Generate refused with. */
  const gated: Array<{ label: string; gate: string; server: string | null }> = [];
  let enumerated = 0;

  async function runCombo(template: string, sport: SportPick, n: number, third: boolean): Promise<void> {
    const drafts = draftsFor(template, n, third);
    const label = `${template} ${sport.key} n=${n} q=${topNFor(template, n)} third=${third}`;
    enumerated++;
    const { auth, divisionId } = await rig(sport, n);
    const stages = await createStages(auth, divisionId, drafts.map((d, i) => ({ ...d, seq: i + 1 })) as CreateStages);
    const gate = stageGraphSizeGate(drafts, n);
    if (gate !== null) {
      // The builder shows this card disabled; the server's own Generate must refuse it by the same name.
      let server: string | null = null;
      try {
        await generateStageFixtures(auth, stages[0]!.id);
      } catch (e) {
        server = (e as { code?: string }).code ?? `(no code) ${(e as Error).message}`;
      }
      gated.push({ label, gate: gate.code, server });
      return;
    }
    for (const s of stages) await generateStageFixtures(auth, s.id);
    for (const s of stages) await place(auth, s.id);

    const rows = await sql<Row[]>`
      select id, stage_id, round_no, ext_key, status, outcome, home_entrant_id, away_entrant_id, home_slot_label,
             away_slot_label, scheduled_at, court_id
        from fixtures where division_id = ${divisionId}`;
    const result: Checked = { label, template, sport: sport.key, rows: rows.length, placed: 0, off: 0, fated: 0 };
    const judge = (stageName: string, r: Row, playable: boolean, fate: string) => {
      const both = r.scheduled_at !== null && r.court_id !== null;
      const neither = r.scheduled_at === null && r.court_id === null;
      if (playable && both) result.placed++;
      else if (!playable && neither) result.off++;
      else if (playable) problems.push(`${label} / ${stageName}: ${r.ext_key ?? r.id} (${fate}) is played but holds ${slotOf(r)}`);
      else problems.push(`${label} / ${stageName}: ${r.ext_key ?? r.id} (${fate}) is never played but holds ${slotOf(r)}`);
    };

    for (const [at, stage] of stages.entries()) {
      const draft = drafts[at]!;
      const mine = rows.filter((r) => r.stage_id === stage.id);
      const k = fieldOf(drafts, at, n);
      if (BRACKET_KINDS.has(draft.kind)) {
        const fates = bracketFates(engineBracket(draft.kind, k, draft.config));
        const drawn = mine.map((r) => r.ext_key ?? `(no ext_key) ${r.id}`).sort();
        if (JSON.stringify(drawn) !== JSON.stringify([...fates.keys()].sort())) {
          problems.push(`${label} / ${draft.name}: drew [${drawn.join(", ")}], the engine draws [${[...fates.keys()].sort().join(", ")}] at ${k}`);
          continue;
        }
        for (const r of mine) {
          const fate = fates.get(r.ext_key!)!;
          judge(draft.name, r, fate === "match", fate);
          if ((fate === "fated_bye" || fate === "dead") && r.scheduled_at === null && r.court_id === null) result.fated++;
        }
      } else if (TABLE_KINDS.has(draft.kind)) {
        const legs = Number(draft.config.legs ?? 1);
        if (draft.kind === "swiss") {
          // Rulebook W3 §4: every round drawn at once, floor(n/2) boards and one bye shell a round on an odd field.
          const rounds = Number(draft.config.rounds);
          const byes = mine.filter((r) => isByeLine(r));
          if (mine.length !== rounds * Math.ceil(k / 2) || byes.length !== rounds * (k % 2)) {
            problems.push(`${label} / ${draft.name}: ${mine.length} rows (${byes.length} byes), the rule draws ${rounds * Math.ceil(k / 2)} (${rounds * (k % 2)} byes) for ${rounds} rounds of ${k}`);
          }
          for (const r of mine) judge(draft.name, r, !isByeLine(r), isByeLine(r) ? "swiss bye" : "swiss board");
        } else {
          // A round robin's odd-field bye is a sit-out, never a row: every row is a match.
          const sizes = draft.kind === "group" ? poolSizes(k, Number((draft.config.pools as { count: number }).count)) : [k];
          const expected = sizes.reduce((sum, size) => sum + (size < 2 ? 0 : roundRobinFixtureCount(size, legs)), 0);
          if (mine.length !== expected) problems.push(`${label} / ${draft.name}: ${mine.length} rows, the engine draws ${expected} (pools ${sizes.join("+")})`);
          for (const r of mine) judge(draft.name, r, true, draft.kind);
        }
      } else {
        throw new Error(`${label}: stage kind '${draft.kind}' is in no kind set this sweep reads - an in-scope template grew a kind`);
      }
    }
    checked.push(result);
  }

  for (const template of IN_SCOPE) {
    it(`${template}: every field (3, 5, 8), with and without third place where it draws a knockout, in every sport picked`, async () => {
      for (const sport of SPORTS) {
        for (const n of FIELDS) {
          for (const third of drawsKnockout(template) ? [false, true] : [false]) await runCombo(template, sport, n, third);
        }
      }
    }, 600_000);
  }

  it("the verdicts: every match placed with a time AND a court, every bye off the timetable, gates refused by name, owed lines exactly the named ones", () => {
    const by = (key: (c: Checked) => string) =>
      [...new Set(checked.map(key))].sort().map((k) => {
        const cs = checked.filter((c) => key(c) === k);
        const sum = (f: (c: Checked) => number) => cs.reduce((s, c) => s + f(c), 0);
        return `${k}: combos=${cs.length} rows=${sum((c) => c.rows)} placed=${sum((c) => c.placed)} off=${sum((c) => c.off)} fated=${sum((c) => c.fated)}`;
      });
    console.info(`placement sweep: ${checked.length} combos checked + ${gated.length} gated = ${enumerated} enumerated\n  ${by((c) => c.template).join("\n  ")}`);
    if (problems.length > 0) console.info(`placement sweep problems (${problems.length}):\n  ${problems.join("\n  ")}`);

    // Anti-vacuity: every combo asked ends as a checked placement or a counted refusal, and there were some of each.
    expect(checked.length + gated.length, "every enumerated combo was checked or refused by the size gate").toBe(enumerated);
    const expectedCombos = IN_SCOPE.reduce((sum, t) => sum + SPORTS.length * FIELDS.length * (drawsKnockout(t) ? 2 : 1), 0);
    expect(enumerated, "the combos enumerated are every (template, sport, field, third place) the declarations name").toBe(expectedCombos);
    expect(checked.length, "combos checked").toBeGreaterThan(0);

    // Every in-scope template placed something - no format is skipped by having nothing to place.
    for (const t of IN_SCOPE) {
      const placed = checked.filter((c) => c.template === t).reduce((s, c) => s + c.placed, 0);
      expect(placed, `${t}: lines placed with a time and a court`).toBeGreaterThan(0);
    }
    // Byes were kept off (root byes, Swiss bye shells, fed byes).
    expect(checked.reduce((s, c) => s + c.off, 0), "lines kept off the timetable").toBeGreaterThan(0);
    // Fated lines kept OFF, per template: none today. The only fated lines the sweep draws are the owed third-place lines
    // (G1, below), and those are placed, so they are problems, not `fated`. PR B's fix keeps them off: that moves them here
    // and turns this pin red for exactly the owed templates, beside the owed list - both are updated together, by design.
    const fatedBy = (t: string) => checked.filter((c) => c.template === t).reduce((s, c) => s + c.fated, 0);
    expect(Object.fromEntries(IN_SCOPE.map((t) => [t, fatedBy(t)])), "fated lines kept off the timetable, per template").toEqual(
      Object.fromEntries(IN_SCOPE.map((t) => [t, 0])),
    );

    // The size gate, each combo refused by the server's Generate under the gate's own code: the templates whose root
    // knockout a field of 3 cannot fill (X-PL-1, X-QM-5), and the templates ending in a page playoff at every field below
    // the page playoff's size as the engine draws it (T26c I1).
    const pageSize = enginePagePlayoffSize();
    const belowPage = FIELDS.filter((n) => n < pageSize);
    expect(PAGE_PLAYOFF_TEMPLATES, "the in-scope templates ending in a page playoff").toEqual(["group_playoffs", "swiss_playoff"]);
    expect(belowPage.length, "anti-vacuity: a swept field lies below the page playoff's size").toBeGreaterThan(0);
    expect(gated.map((g) => g.label).sort(), "the combos the builder's size gate refuses").toEqual(
      SPORTS.flatMap((s) => [
        ...["ko_plate", "qualifying_main"].flatMap((t) => [false, true].map((third) => `${t} ${s.key} n=3 q=4 third=${third}`)),
        ...PAGE_PLAYOFF_TEMPLATES.flatMap((t) => belowPage.map((n) => `${t} ${s.key} n=${n} q=${topNFor(t, n)} third=false`)),
      ]).sort(),
    );
    for (const g of gated) expect(g.server, `${g.label}: the server refuses as the builder's gate does`).toBe(g.gate);
    expect(new Set(gated.map((g) => g.gate)), "every named gate reached").toEqual(
      new Set(["KO_PLATE_TOO_FEW", "QUALIFYING_MAIN_TOO_FEW", "PAGE_PLAYOFF_TOO_FEW"]),
    );

    // G1 knockout half, owed to PR B BY NAME: exactly the third-place line of each named template at n=3 with third place,
    // in every sport - one more, one fewer or one moved is red here.
    const owed = SPORTS.flatMap((s) =>
      OWED_PR_B_TEMPLATES.map((t) => {
        const stage = draftsFor(t, 3, true).find((d) => d.kind === "knockout")!.name;
        return `${t} ${s.key} n=3 q=${topNFor(t, 3)} third=true / ${stage}: se-3p (fated_bye) is never played but holds time=true court=true`;
      }),
    ).sort();
    // One assertion over both halves, so a red shows the whole list: the owed lines, and every fault outside them.
    expect(
      { owed: problems.filter((p) => owed.includes(p)).sort(), outside: problems.filter((p) => !owed.includes(p)) },
      `${OWED_PR_B_WHY}; anything outside that list is a placement or generation fault`,
    ).toEqual({ owed, outside: [] });
  });
});

// The oracle, without a database: the engine's brackets at the fields the rule names, against the rule's own arithmetic.
describe("the sweep's line-fate oracle (no database)", () => {
  const fatesAt = (k: number, thirdPlace = false) => bracketFates(engineBracket("knockout", k, { thirdPlace }));
  const count = (m: Map<string, LineFate>, fate: LineFate) => [...m.values()].filter((f) => f === fate).length;

  it("byes: a knockout of k pads to the next power of two P, and P - k lines are byes", () => {
    let asked = 0;
    for (let k = 2; k <= 33; k++) {
      expect(count(fatesAt(k), "bye"), `k=${k}`).toBe(2 ** Math.ceil(Math.log2(k)) - k);
      asked++;
    }
    expect(asked, "anti-vacuity").toBe(32);
  });

  it("a third-place match fed by a bye semi's loser is fated to be a bye (3 with third place); a field whose semis are both played has none", () => {
    expect(fatesAt(3, true).get("se-3p")).toBe("fated_bye"); // the bye semi has no loser
    expect(fatesAt(4, true).get("se-3p")).toBe("match");
    expect(fatesAt(5, true).get("se-3p")).toBe("match"); // both semis are played (byes are round 1's)
    expect(count(fatesAt(3, true), "fated_bye")).toBe(1);
    expect(count(fatesAt(8, true), "fated_bye") + count(fatesAt(8, true), "bye") + count(fatesAt(8, true), "dead")).toBe(0);
  });

  it("the empty bracket has no lines; a line fed by a dead line's winner is dead, by its loser dead too", () => {
    expect(bracketFates({ fixtures: [], rounds: 0 }).size).toBe(0);
    const fates = bracketFates({
      rounds: 2,
      fixtures: [
        { id: "a", round: 0, home: "x", award: "x" },
        { id: "b", round: 0, home: "y", award: "y" },
        { id: "c", round: 1, homeFrom: { fixtureId: "a", side: "loser" }, awayFrom: { fixtureId: "b", side: "loser" } },
        { id: "d", round: 2, homeFrom: { fixtureId: "c", side: "winner" }, awayFrom: { fixtureId: "a", side: "winner" } },
        { id: "e", round: 2, homeFrom: { fixtureId: "c", side: "loser" }, awayFrom: { fixtureId: "b", side: "winner" } },
      ],
    });
    expect(Object.fromEntries(fates)).toEqual({ a: "bye", b: "bye", c: "dead", d: "fated_bye", e: "fated_bye" });
  });

  it("the scope: every excluded key is a live template, the exclusion holds exactly its pinned count, the catalogue its pinned size", () => {
    for (const key of Object.keys(EXCLUDED)) {
      const t = STAGE_TEMPLATES.find((x) => x.key === key);
      expect(t, `${key} is a STAGE_TEMPLATES entry`).toBeDefined();
      expect(t!.retired, `${key} is offered (not retired), so its exclusion is a ruling`).toBeUndefined();
    }
    expect(Object.keys(EXCLUDED), "the excluded keys").toHaveLength(EXCLUDED_COUNT);
    // The catalogue's size, as a literal (16, retired included): a template added or removed is a scope decision this
    // sweep must take, not one it absorbs into IN_SCOPE unseen.
    expect(STAGE_TEMPLATES.map((t) => t.key), "the STAGE_TEMPLATES catalogue, retired included").toHaveLength(16);
    expect(IN_SCOPE.length, "anti-vacuity: templates in scope").toBeGreaterThan(0);
    expect(SPORTS.length, "two or more sports (one per declared default entrant kind)").toBeGreaterThanOrEqual(2);
    expect(new Set(SPORTS.map((s) => s.kind)).size, "the sports differ in entrant model").toBe(SPORTS.length);
  });
});
