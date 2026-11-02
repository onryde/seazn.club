// Match Day PB2 (owner 2026-11-02, "apply rec", option A): a billing-frozen competition still SCORES, and NOTHING ELSE the freeze
// guards moves with it. This is the behavioural witness for the guard sites that had none of their own — the schedule's writes
// (a move, its settings, an apply, publish, Start), entrants, a new stage, deleting a stage, the competition-wide apply, the
// competition AI preview — and for a few that had one elsewhere and cost nothing to sweep here too (a new division, a rename, a
// match's own format). The ledger of every site and its witness is freeze-guard-sites.test.ts.
//
// Each write is asked twice, through its REAL usecase against real Postgres:
//   - on a competition that is NOT frozen (its own seed): whatever it answers, it is never the freeze's 402 — so the refusal
//     below is the freeze, not the write;
//   - on a frozen one: the guard's own 402 (`competitions.max_active`), and nothing is written.
// Then the frozen competition's match scores (PB2's ruling, scoring-frozen-competition.test.ts proves the door itself).
//
// The freeze is the override pin (pool-nesting-tripwire.test.ts, registration-approval.test.ts): the org keeps Pro, so a write
// that also asks a Pro capability (the AI preview's `scheduling.ai`, the competition apply's `scheduling.multi_division`) reaches
// the freeze rather than a plan gate.
//
// ONE SPORT, on purpose (TEST-STRATEGY rule 6): no guard here reads the sport — each reads the competition's id.
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";

// The AI preview's own doors before the freeze: its PostHog flag (fail-open, but never a live call from a test) — and the model,
// present only to prove it is never reached (a preview that got past the freeze would spend a credit).
vi.mock("@/lib/posthog-server", () => ({ isServerFeatureEnabled: async () => true, captureServer: () => {} }));
vi.mock("@anthropic-ai/sdk", () => ({
  default: class Anthropic {
    messages = {
      parse: () => {
        throw new Error("the model was reached");
      },
    };
  },
}));

import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { PaymentRequiredError } from "@/lib/errors";
import { CreateStage } from "@/server/api-v1/schemas";
import { seedBracket, type SeededBracket } from "@/server/engine-db/__tests__/helpers/seed-bracket";
import { applyCompetitionSchedule } from "../competition-schedule-apply";
import { patchCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { frozenCompetitionIds } from "../entitlement-freeze";
import { writeFixtureRulesOverride } from "../fixture-rules";
import { previewScheduleAi } from "../schedule-ai-preview";
import { applySchedule, getScheduleSettings, moveFixture, publishSchedule, putScheduleSettings, startDivision } from "../schedule";
import { scoreEvent } from "../scoring";
import { createStages, deleteStage } from "../stages";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

const seed = () => seedBracket({ sport: "badminton", variant: "bwf", stageKind: "knockout", entrants: 4 });

/** Every guarded write, as the site it reaches (`file#function`, the ledger's key) and a call against `s`'s own ids. Deleting the
 *  stage is LAST: on the unfrozen seed it really deletes, and the writes before it need the stage. */
function writes(s: SeededBracket): Array<[site: string, attempt: () => Promise<unknown>]> {
  const fixtureId = s.fixtureIds[0]!;
  return [
    ["schedule.ts#moveFixture", () => moveFixture(s.auth, fixtureId, { scheduled_at: "2030-06-01T10:00:00.000Z" })],
    [
      "schedule.ts#putScheduleSettings",
      async () => putScheduleSettings(s.auth, s.divisionId, { config: (await getScheduleSettings(s.auth, s.divisionId)).config }),
    ],
    [
      "schedule.ts#applySchedule",
      () =>
        applySchedule(s.auth, s.stageId, {
          source: "auto",
          assignments: [{ fixture_id: fixtureId, scheduled_at: "2030-06-01T10:00:00.000Z", court_id: randomUUID() }],
        }),
    ],
    ["schedule.ts#publishSchedule", () => publishSchedule(s.auth, s.divisionId)],
    ["schedule.ts#startDivision", () => startDivision(s.auth, s.divisionId)],
    ["entrants.ts#createEntrants", () => createEntrants(s.auth, s.divisionId, [{ kind: "individual", display_name: "Late Entry", members: [] }])],
    [
      "stages.ts#insertStageBatch",
      () => createStages(s.auth, s.divisionId, CreateStage.parse({ seq: 2, kind: "knockout", name: "Plate", config: {} })),
    ],
    [
      "competition-schedule-apply.ts#applyCompetitionSchedule",
      () => applyCompetitionSchedule(s.auth, s.competitionId, { source: "ai", divisions: [{ division_id: s.divisionId, expected_seq: 0, assignments: [] }] }),
    ],
    [
      "schedule-ai-preview.ts#resolveCompetitionScope",
      () =>
        previewScheduleAi(s.auth, { kind: "competition", id: s.competitionId }, {
          instruction: "Finish by six",
          division_ids: [s.divisionId, randomUUID()],
        }),
    ],
    [
      "divisions.ts#createDivision",
      () =>
        createDivision(s.auth, s.competitionId, {
          name: "Plate",
          slug: "plate-" + randomUUID().slice(0, 8),
          sport_key: "badminton",
          variant_key: "bwf",
          config: {},
        }),
    ],
    ["competitions.ts#patchCompetition", () => patchCompetition(s.auth, s.competitionId, { name: "Renamed Cup" })],
    ["fixture-rules.ts#writeFixtureRulesOverride", () => writeFixtureRulesOverride(s.auth, [fixtureId], { bestOf: 5 })],
    ["stages.ts#deleteStage", () => deleteStage(s.auth, s.stageId)],
  ];
}

/** The freeze's own refusal: a PaymentRequiredError naming the active-competition ceiling — never a plan gate that shares 402. */
const isFreeze = (e: unknown): boolean => e instanceof PaymentRequiredError && e.featureKey === "competitions.max_active";

/** What the writes above would change, read straight off the rows. */
async function snapshot(s: SeededBracket) {
  const [row] = await sql<
    { name: string; divisions: number; stages: number; entrants: number; scheduled: string | null; division_status: string; overrides: number }[]
  >`
    select c.name,
           (select count(*)::int from divisions d where d.competition_id = c.id) as divisions,
           (select count(*)::int from stages s where s.division_id = ${s.divisionId}) as stages,
           (select count(*)::int from entrants e where e.division_id = ${s.divisionId}) as entrants,
           (select f.scheduled_at::text from fixtures f where f.id = ${s.fixtureIds[0]!}) as scheduled,
           (select d.status from divisions d where d.id = ${s.divisionId}) as division_status,
           (select count(*)::int from fixtures f where f.division_id = ${s.divisionId} and f.rules_override is not null) as overrides
      from competitions c where c.id = ${s.competitionId}`;
  return row!;
}

describe.skipIf(!HAS_DB)("PB2 — every write the billing freeze guards still answers its 402, while the same competition scores", () => {
  it("EMPTY CASE FIRST: on a competition that is NOT frozen, no guarded write answers the freeze's 402", async () => {
    const u = await seed();
    expect([...(await frozenCompetitionIds(u.auth.orgId))], "premise: nothing frozen").toEqual([]);
    let checked = 0;
    for (const [site, attempt] of writes(u)) {
      const outcome = await attempt().then(
        () => null,
        (e: unknown) => e,
      );
      expect(isFreeze(outcome), `${site}: ${String(outcome)}`).toBe(false);
      checked++;
    }
    expect(checked, "anti-vacuity: writes checked").toBe(writes(u).length);
    expect(checked).toBeGreaterThan(0);
  }, 120_000);

  it("frozen: each write is refused with the freeze's own 402 and writes nothing; the competition's match still scores", async () => {
    const s = await seed();
    await sql`
      insert into org_entitlement_overrides (org_id, feature_key, int_value)
      values (${s.auth.orgId}, 'competitions.max_active', 0)
      on conflict (org_id, feature_key) do update set int_value = 0, bool_value = null`;
    await invalidateOrgEntitlements(s.auth.orgId);
    expect([...(await frozenCompetitionIds(s.auth.orgId))], "premise: exactly this competition is frozen").toEqual([s.competitionId]);

    const before = await snapshot(s);
    let refused = 0;
    for (const [site, attempt] of writes(s)) {
      const err = await attempt().then(
        () => new Error(`${site}: accepted on a frozen competition`),
        (e: unknown) => e,
      );
      expect(isFreeze(err), `${site}: ${String(err)}`).toBe(true);
      expect((err as PaymentRequiredError).status, site).toBe(402);
      refused++;
    }
    expect(refused, "anti-vacuity: refusals checked").toBe(writes(s).length);
    expect(await snapshot(s), "a refused write wrote nothing").toEqual(before);

    // PB2: the one write a frozen competition keeps.
    const started = await scoreEvent(s.auth, s.fixtureIds[0]!, { expected_seq: 0, type: "core.start", payload: {} });
    expect(started.seq).toBe(1);
  }, 120_000);
});
