// P9 pass 3b regression coverage — the "third placer path" fix
// (schedule-ai.ts's buildSchedulePack) and the inScope() court_id fix, both
// closed in this pass. Kept in a small, self-contained file rather than
// folded into schedule-ai-pack.test.ts: that suite's SETTINGS_CONFIG and
// golden `toMatchSnapshot()` predate the venues/courts cutover and need a
// supervised re-seed + re-record this pass does not attempt blind (real
// court uuids redact differently than the "Court 1"/"Court 2" labels the
// recorded snapshot was pinned against).
//
// Real Postgres required; skipped without DATABASE_URL.
import { afterAll, describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages, generateStageFixtures } from "../stages";
import { createVenue, createCourt } from "../venues";
import { buildSchedulePack, structuralCheck } from "../schedule-ai";
import type { AiSchedulePlan } from "../schedule-ai-prompt";
import { seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;
const NOW = Date.parse("2026-08-06T23:30:00Z");
const T0 = Date.parse("2026-08-01T09:00:00.000Z");
const MIN = 60_000;

const GENERIC_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

/** A fresh division with `entrants` round-robin players and its own venue,
 *  ready for `schedule_settings`/`required_court_tags` to be set by the
 *  caller. Nothing is scheduled yet. */
async function seedDivision(
  entrants: number,
): Promise<{ auth: AuthCtx; divisionId: string; venueId: string }> {
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Candidate Courts Cup",
    visibility: "public",
    branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name: "Open",
    slug: "open",
    sport_key: "generic",
    variant_key: "score",
    config: GENERIC_CONFIG,
    eligibility: [],
  });
  await createEntrants(
    auth,
    division.id,
    Array.from({ length: entrants }, (_, i) => ({
      kind: "individual" as const,
      display_name: `E${i + 1}`,
      seed: i + 1,
      members: [],
    })),
  );
  const venue = await createVenue(auth, { name: "Main venue", sort: 0 });
  return { auth, divisionId: division.id, venueId: venue.id };
}

async function setCourts(divisionId: string, courtIds: string[]): Promise<void> {
  await sql`
    insert into schedule_settings (division_id, config, tz, updated_at)
    values (
      ${divisionId},
      ${sql.json({
        startAt: "2026-08-01T09:00:00.000Z",
        matchMinutes: 30,
        gapMinutes: 0,
        courts: courtIds,
        perEntrantMinRest: 0,
        blackouts: [],
        sessionWindows: [{ from: "2026-08-01T09:00:00.000Z", to: "2026-08-01T22:00:00.000Z" }],
      })},
      ${"Europe/London"},
      now()
    )
    on conflict (division_id) do update set config = excluded.config, tz = excluded.tz`;
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("buildSchedulePack routes courts through resolveCandidateCourts (P9 pass 3b)", () => {
  it("never places on an archived court or one missing a required tag", async () => {
    const { auth, divisionId, venueId } = await seedDivision(6);
    const good = await createCourt(auth, venueId, { name: "Grass 1", sort: 0, tags: ["grass"] });
    const archived = await createCourt(auth, venueId, { name: "Grass 2", sort: 1, tags: ["grass"] });
    await sql`update courts set archived_at = now() where id = ${archived.id}`;
    const wrongTag = await createCourt(auth, venueId, { name: "Clay 1", sort: 2, tags: ["clay"] });

    await setCourts(divisionId, [good.id, archived.id, wrongTag.id]);
    await sql`update divisions set required_court_tags = ${sql.array(["grass"])} where id = ${divisionId}`;
    // seedDivision only seeds entrants — nothing is movable until a stage
    // actually generates fixtures for them (same two calls the inScope()
    // describe block below already makes). Without this the division has
    // ZERO fixtures, `pack.draft` is trivially empty and this test cannot
    // tell "correctly filtered courts" apart from "nothing to place at all".
    const [stage] = await createStages(auth, divisionId, { seq: 1, kind: "league", name: "League", config: {} });
    await generateStageFixtures(auth, stage!.id);

    const { pack } = await buildSchedulePack(auth, divisionId, {
      now: NOW,
      mode: "generate",
      instruction: "Fill the day.",
    });

    // The candidate set the model is shown and the draft placer may choose
    // from excludes both — resolveCandidateCourts, not the raw configured list.
    expect(pack.settings.courts).toEqual([good.id]);
    expect(pack.settings.courts).not.toContain(archived.id);
    expect(pack.settings.courts).not.toContain(wrongTag.id);
    // …and the greedy draft actually placed fixtures, all on the one legal court.
    const placed = pack.draft.filter((d) => d.scheduled_at !== null);
    expect(placed.length).toBeGreaterThan(0);
    for (const d of placed) expect(d.court_label).toBe(good.id);
  });

  it("empties settings.courts rather than falling back to the unfiltered configured list", async () => {
    // buildSchedulePack has no guardNoMatchingCourt of its own (unlike
    // autoSchedule's build-time precheck) — this pins the actual behaviour
    // when a division's whole candidate set is filtered out: the draft
    // placer is left with zero courts to choose from and places nothing, it
    // does NOT silently widen back to the tag-mismatched configured court.
    const { auth, divisionId, venueId } = await seedDivision(4);
    const wrongTag = await createCourt(auth, venueId, { name: "Clay 1", sort: 0, tags: ["clay"] });
    await setCourts(divisionId, [wrongTag.id]);
    await sql`update divisions set required_court_tags = ${sql.array(["grass"])} where id = ${divisionId}`;
    // Same fixture-generation gap as the test above — without real movable
    // fixtures, "the draft placed nothing" is true whether or not the courts
    // fallback is buggy, which would leave a real widening-back regression
    // undetected.
    const [stage] = await createStages(auth, divisionId, { seq: 1, kind: "league", name: "League", config: {} });
    await generateStageFixtures(auth, stage!.id);

    const { pack } = await buildSchedulePack(auth, divisionId, {
      now: NOW,
      mode: "generate",
      instruction: "x",
    });
    expect(pack.settings.courts).toEqual([]);
    expect(pack.draft.every((d) => d.scheduled_at === null)).toBe(true);
  });
});

describe.skipIf(!HAS_DB)("inScope() matches a repair scope's courts on court_id (P9 pass 3b)", () => {
  it("keeps a fixture in scope by its real court_id even though its frozen court_label disagrees", async () => {
    const { auth, divisionId, venueId } = await seedDivision(4);
    const target = await createCourt(auth, venueId, { name: "Target Court", sort: 0, tags: [] });
    const other = await createCourt(auth, venueId, { name: "Other Court", sort: 1, tags: [] });
    await setCourts(divisionId, [target.id, other.id]);

    const [stage] = await createStages(auth, divisionId, { seq: 1, kind: "league", name: "League", config: {} });
    const { fixtures } = await generateStageFixtures(auth, stage!.id);
    const ordered = [...fixtures].sort(
      (a, b) => a.round_no - b.round_no || a.seq_in_round - b.seq_in_round,
    );

    // f0's court_id is the REAL, current identity (target); its frozen
    // court_label is stamped to something that would never match a scope on
    // `target.id` if inScope() were still reading the legacy column — the
    // exact bug this pass closes.
    await sql`
      update fixtures set scheduled_at = ${new Date(T0).toISOString()},
        court_id = ${target.id}, court_label = 'Stale Legacy Label'
      where id = ${ordered[0]!.id}`;
    // f1 sits on the OTHER real court — must be excluded from a scope on
    // `target.id` regardless of what its (irrelevant) court_label says.
    await sql`
      update fixtures set scheduled_at = ${new Date(T0 + 60 * MIN).toISOString()},
        court_id = ${other.id}, court_label = 'Target Court'
      where id = ${ordered[1]!.id}`;

    const { pack, movableIds } = await buildSchedulePack(auth, divisionId, {
      now: NOW,
      mode: "repair",
      instruction: "Court 1 only",
      scope: { courts: [target.id] },
    });

    // f0: real court_id matches the scope -> stays movable, in scope.
    expect(movableIds.has(ordered[0]!.id)).toBe(true);
    // f1: real court_id does NOT match the scope, whatever its court_label
    // says -> scoped out, and therefore a fixed obstacle instead.
    expect(movableIds.has(ordered[1]!.id)).toBe(false);
    expect(pack.fixtures.obstacles.some((o) => o.court === other.id)).toBe(true);
  });
});

// P9 (stage court tags): buildSchedulePack used to resolve ONE division-wide
// candidateCourtIds and stop — a stage's own required_court_tags was invisible
// to the model, unlike autoSchedule (schedule.ts) which unions the stage's own
// tags in. This mirrors validateScheduleIn's identical fix (review finding
// #11) on the verify side.
describe.skipIf(!HAS_DB)(
  "buildSchedulePack resolves candidate courts PER STAGE, not just per division",
  () => {
    it("narrows PackFixture.courts to a stage's own required-tag set; a stage with no tags of its own carries no courts key at all", async () => {
      const { auth, divisionId, venueId } = await seedDivision(4);
      const courtA = await createCourt(auth, venueId, { name: "Court A", sort: 0, tags: [] });
      const courtB = await createCourt(auth, venueId, { name: "Court B", sort: 1, tags: [] });
      const courtC = await createCourt(auth, venueId, { name: "Court C", sort: 2, tags: ["special"] });
      await setCourts(divisionId, [courtA.id, courtB.id, courtC.id]);
      // division.required_court_tags stays at its column default ('{}') —
      // every one of A/B/C qualifies division-wide.

      const [s1, s2] = await createStages(auth, divisionId, [
        { seq: 1, kind: "league", name: "S1", config: {} },
        { seq: 2, kind: "league", name: "S2", config: {} },
      ]);
      // S1 requires a tag only C carries. S2 is left at the column default
      // ('{}') on purpose — the common case this pass must not disturb.
      await sql`update stages set required_court_tags = ${sql.array(["special"])} where id = ${s1!.id}`;
      await generateStageFixtures(auth, s1!.id);
      await generateStageFixtures(auth, s2!.id);

      const { pack } = await buildSchedulePack(auth, divisionId, {
        now: NOW,
        mode: "generate",
        instruction: "x",
      });

      // Division-wide set is unchanged by this pass — all three courts.
      expect([...pack.settings.courts].sort()).toEqual([courtA.id, courtB.id, courtC.id].sort());

      const s1FixtureIds = new Set(
        Object.entries(pack.stageIds)
          .filter(([, sid]) => sid === s1!.id)
          .map(([fid]) => fid),
      );
      const s2FixtureIds = new Set(
        Object.entries(pack.stageIds)
          .filter(([, sid]) => sid === s2!.id)
          .map(([fid]) => fid),
      );
      // Sanity: both stages actually produced movable fixtures, or the
      // assertions below would pass vacuously over empty sets.
      expect(s1FixtureIds.size).toBeGreaterThan(0);
      expect(s2FixtureIds.size).toBeGreaterThan(0);

      for (const f of pack.fixtures.movable) {
        if (s1FixtureIds.has(f.id)) {
          expect(f.courts).toEqual([courtC.id]);
        } else if (s2FixtureIds.has(f.id)) {
          // Absent, not `[]` and not the full division set — S2's own union
          // equals the division-only tags, so buildSchedulePack must reuse
          // candidateCourtIds rather than stamping a (redundant) narrower key.
          expect("courts" in f).toBe(false);
        }
      }
    });

    it("structuralCheck rejects a plan that places a stage-narrowed fixture on a court outside that stage's own set, even though the court is in the division-wide settings.courts", async () => {
      const { auth, divisionId, venueId } = await seedDivision(4);
      const courtA = await createCourt(auth, venueId, { name: "Court A", sort: 0, tags: [] });
      const courtB = await createCourt(auth, venueId, { name: "Court B", sort: 1, tags: [] });
      const courtC = await createCourt(auth, venueId, { name: "Court C", sort: 2, tags: ["special"] });
      await setCourts(divisionId, [courtA.id, courtB.id, courtC.id]);

      const [s1] = await createStages(auth, divisionId, { seq: 1, kind: "league", name: "S1", config: {} });
      await sql`update stages set required_court_tags = ${sql.array(["special"])} where id = ${s1!.id}`;
      await generateStageFixtures(auth, s1!.id);

      const { pack } = await buildSchedulePack(auth, divisionId, {
        now: NOW,
        mode: "generate",
        instruction: "x",
      });

      const s1FixtureId = Object.keys(pack.stageIds).find((fid) => pack.stageIds[fid] === s1!.id);
      expect(s1FixtureId).toBeDefined();
      const s1Fixture = pack.fixtures.movable.find((f) => f.id === s1FixtureId)!;
      // Sanity on both sides of the bug this closes: A is a real
      // division-wide candidate...
      expect(pack.settings.courts).toContain(courtA.id);
      // ...but not in S1's own narrower set (only C carries "special").
      expect(s1Fixture.courts).toEqual([courtC.id]);

      // A deliberately minimal movableIds (just the one fixture under test) —
      // isolates the court-narrowing check from the unrelated "every movable
      // fixture must appear in the plan" rule, which a single-assignment plan
      // would otherwise trip for every OTHER S1 fixture and mask the real
      // assertion behind the wrong failure reason.
      const plan: AiSchedulePlan = {
        assignments: [
          { fixture_id: s1FixtureId!, scheduled_at: "2026-08-10T09:00:00+00:00", court_label: courtA.id },
        ],
        unschedulable: [],
        explanations: [],
        summary: "x",
      };
      const note = structuralCheck(plan, new Set([s1FixtureId!]), pack);
      expect(note).not.toBeNull();
    });
  },
);
