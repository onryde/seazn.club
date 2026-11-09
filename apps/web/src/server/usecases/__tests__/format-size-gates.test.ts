// W4 app-A Task 15 (FX-G14's gate half, QM-2; rules X-PL-1, X-QM-2, X-QM-3, X-QM-5): a format the field cannot play is refused
// up front and by name, at every door that draws it, off the stored stage GRAPH, so an API-built division is gated too. Before this
// a qualifying_main of three played its whole qualifying stage and then failed at Complete (qualifying-main-sizes.test.ts).
//
// Driven through the real doors on a real database. Expected values: the rulebook's numbers and the engine's own fold
// (`generateSingleElim`) over the ranks read by hand off the results; never the gate. Sports: the Start refusal sweeps the registry
// (a graph read has no sport in it, which is what the sweep proves); the rest run on badminton singles, whose fields they never read.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { generateSingleElim } from "@seazn/engine/scheduling";
import { effectiveEntrantModel } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { buildTemplateStages } from "@/lib/format-templates";
import type { AuthCtx } from "@/server/api-v1/auth";
import { CreateStage } from "@/server/api-v1/schemas";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { startDivision } from "../schedule";
import { validateStageProgression } from "../stage-seeding";
import { scoreEvent } from "../scoring";
import {
  completeStage,
  confirmSeedProposal,
  createStages,
  generateStageFixtures,
  getSeedProposal,
  rebuildStageFixtures,
  replaceStages,
} from "../stages";
import { withdrawEntrantCascade } from "../withdrawal";
import { seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

const KNOBS = { swissRounds: 5, poolCount: 2, legs: 1 };

interface Rig {
  auth: AuthCtx;
  divisionId: string;
  stageIds: string[];
  idOf: Map<string, string>;
  nameOf: Map<string, string>;
}

async function division(n: number, sport: { key: string; variant: string; kind: "individual" | "pair" | "team" } = { key: "badminton", variant: "bwf", kind: "individual" }) {
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "T15 " + randomUUID().slice(0, 6), visibility: "private", branding: {} });
  const div = await createDivision(auth, comp.id, { name: "Open", slug: "open-" + randomUUID().slice(0, 6), sport_key: sport.key, variant_key: sport.variant, config: {} });
  const made = await createEntrants(
    auth,
    div.id,
    Array.from({ length: n }, (_, i) => ({ kind: sport.kind, display_name: `E${i + 1}`, seed: i + 1, members: [] })) as never,
  );
  return { auth, divisionId: div.id, made };
}

async function addStages(auth: AuthCtx, divisionId: string, drafts: readonly { kind: string; name: string; config: unknown; progression: unknown }[]): Promise<string[]> {
  const ids: string[] = [];
  for (const [i, d] of drafts.entries()) {
    const [stage] = await createStages(auth, divisionId, CreateStage.parse({ seq: i + 1, kind: d.kind, name: d.name, config: d.config, progression: d.progression }));
    ids.push(stage!.id);
  }
  return ids;
}

async function rig(template: "ko_plate" | "qualifying_main", n: number, qualified = 4): Promise<Rig> {
  const { auth, divisionId, made } = await division(n);
  const stageIds = await addStages(auth, divisionId, buildTemplateStages(template, { ...KNOBS, qualified }));
  return {
    auth,
    divisionId,
    stageIds,
    idOf: new Map(made.map((e) => [e.display_name, e.id])),
    nameOf: new Map(made.map((e) => [e.id, e.display_name])),
  };
}

async function refusal(p: Promise<unknown>): Promise<HttpError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err, "the call was expected to be refused").toBeInstanceOf(HttpError);
  return err as HttpError;
}

const statusOf = async (divisionId: string) => (await sql<{ status: string }[]>`select status from divisions where id = ${divisionId}`)[0]!.status;
const lineCount = async (stageId: string) => (await sql<{ n: number }[]>`select count(*)::int as n from fixtures where stage_id = ${stageId}`)[0]!.n;

/** The refusal, by name, and nothing written behind it. */
async function expectRefusedAtStart(r: Rig, code: string, sentence: string): Promise<void> {
  const err = await refusal(startDivision(r.auth, r.divisionId));
  expect(err.code).toBe(code);
  expect(err.status).toBe(422);
  expect(err.message).toBe(sentence);
  expect(await statusOf(r.divisionId), "the division did not start").toBe("setup");
  expect(await lineCount(r.stageIds[0]!), "and Start generated nothing").toBe(0);
}

describe.runIf(HAS_DB)("W4 T15 format gates (FX-G14 gate half, QM-2)", () => {
  describe("X-PL-1 Knockout + Plate", () => {
    const PLATE = "Knockout + Plate needs at least 4 entrants.";

    for (const n of [2, 3]) {
      it(`X-PL-1 Knockout + Plate below 4 entrants is refused by the server by name: Start, Generate and Rebuild at n=${n}`, async () => {
        const r = await rig("ko_plate", n);
        await expectRefusedAtStart(r, "KO_PLATE_TOO_FEW", PLATE);
        const atGenerate = await refusal(generateStageFixtures(r.auth, r.stageIds[0]!));
        expect(atGenerate.code).toBe("KO_PLATE_TOO_FEW");
        expect(atGenerate.message).toBe(PLATE);
        expect(await lineCount(r.stageIds[0]!), "Generate drew nothing").toBe(0);
        expect((await refusal(rebuildStageFixtures(r.auth, r.stageIds[0]!))).code).toBe("KO_PLATE_TOO_FEW");
        // A second press answers the same, and the refusal left nothing behind that changes it.
        expect((await refusal(startDivision(r.auth, r.divisionId))).code).toBe("KO_PLATE_TOO_FEW");
      }, 120_000);
    }

    it("X-PL-1 Knockout + Plate is offered from 4: n=4 starts and draws", async () => {
      const r = await rig("ko_plate", 4);
      const out = await startDivision(r.auth, r.divisionId);
      expect(out.started).toBe(true);
      expect(await statusOf(r.divisionId)).toBe("active");
      expect(await lineCount(r.stageIds[0]!), "three lines of a four-player bracket").toBe(3);
    }, 120_000);

    it("X-PL-1 Knockout + Plate counts a CONFIRMED entrant: a field of 4, all confirmed, starts (the count is registered and confirmed alike)", async () => {
      const r = await rig("ko_plate", 4);
      await sql`update entrants set status = 'confirmed' where division_id = ${r.divisionId}`;
      const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from entrants where division_id = ${r.divisionId} and status = 'confirmed'`;
      expect(n, "premise: all four are confirmed and none registered").toBe(4);
      expect((await startDivision(r.auth, r.divisionId)).started).toBe(true);
      expect(await statusOf(r.divisionId)).toBe("active");
      // The mixed field is the same field: two registered and two confirmed is four.
      const mixed = await rig("ko_plate", 4);
      await sql`update entrants set status = 'confirmed' where division_id = ${mixed.divisionId} and seed in (1, 2)`;
      expect((await startDivision(mixed.auth, mixed.divisionId)).started).toBe(true);
    }, 120_000);

    it("the plate's own Generate is not gated: its source is what is sized, and day-one TBD lines cost nothing", async () => {
      const r = await rig("ko_plate", 3);
      await expect(generateStageFixtures(r.auth, r.stageIds[1]!)).resolves.toBeTruthy();
    }, 120_000);

    it("a field that fell below 4 before Start: refused, and the same division starts once it is back at 4 (sequence)", async () => {
      const r = await rig("ko_plate", 4);
      await generateStageFixtures(r.auth, r.stageIds[0]!);
      await withdrawEntrantCascade(r.auth, r.idOf.get("E4")!);
      const err = await refusal(startDivision(r.auth, r.divisionId));
      expect(err.code, "the departed one does not count").toBe("KO_PLATE_TOO_FEW");
      expect((await refusal(generateStageFixtures(r.auth, r.stageIds[0]!))).code, "Update draw neither").toBe("KO_PLATE_TOO_FEW");
      await createEntrants(r.auth, r.divisionId, [{ kind: "individual", display_name: "E5", seed: 5, members: [] }] as never);
      await generateStageFixtures(r.auth, r.stageIds[0]!);
      expect((await startDivision(r.auth, r.divisionId)).started).toBe(true);
    }, 120_000);

    it("D11, Start's own door: a plate added after the root was drawn on 3 is refused at Start, the draw left as it was", async () => {
      // Start reaches Generate only for an undrawn root or a roster that moved, so this is the one path to its own pre-flight.
      const { auth, divisionId } = await division(3);
      const [main] = await createStages(auth, divisionId, [{ seq: 1, kind: "knockout", name: "Main", config: {} }]);
      await generateStageFixtures(auth, main!.id);
      const drawn = await lineCount(main!.id);
      expect(drawn, "premise: the root is drawn, with no plate to size it").toBeGreaterThan(0);
      await createStages(
        auth,
        divisionId,
        CreateStage.parse({
          seq: 2,
          kind: "knockout",
          name: "Plate",
          config: {},
          progression: { sources: [{ stage: "previous", take: [{ kind: "roundLosers", round: 1, count: 2 }] }], placement: "rank_order", timing: "setup" },
        }),
      );
      expect((await refusal(startDivision(auth, divisionId))).code).toBe("KO_PLATE_TOO_FEW");
      expect(await statusOf(divisionId), "the division did not start").toBe("setup");
      expect(await lineCount(main!.id), "and the draw is untouched").toBe(drawn);
    }, 120_000);

    it("a withdrawal AFTER Start is the bracket's, not this gate's: Start stays a no-op and a Generate is not refused for size; Rebuild is, since it draws again", async () => {
      const r = await rig("ko_plate", 4);
      await startDivision(r.auth, r.divisionId);
      await withdrawEntrantCascade(r.auth, r.idOf.get("E4")!);
      expect((await startDivision(r.auth, r.divisionId)).started, "an active division's Start is a no-op, never refused").toBe(false);
      const generated = await generateStageFixtures(r.auth, r.stageIds[0]!).then(
        () => null,
        (e: unknown) => e,
      );
      expect((generated as HttpError | null)?.code, "a drawn, started bracket is never reshaped by the size gate").not.toBe("KO_PLATE_TOO_FEW");
      expect((await refusal(rebuildStageFixtures(r.auth, r.stageIds[0]!))).code).toBe("KO_PLATE_TOO_FEW");
    }, 120_000);

    it("an active division whose root has no lines yet is drawn from nothing, so it is gated (a format change after Start)", async () => {
      const r = await rig("ko_plate", 3);
      await sql`update divisions set status = 'active' where id = ${r.divisionId}`;
      expect((await refusal(generateStageFixtures(r.auth, r.stageIds[0]!))).code).toBe("KO_PLATE_TOO_FEW");
    }, 120_000);

    it("reads the stored graph: an API-built plate naming its source by id is gated", async () => {
      const { auth, divisionId } = await division(3);
      const [main] = await createStages(auth, divisionId, [{ seq: 1, kind: "knockout", name: "Main", config: {} }]);
      await createStages(
        auth,
        divisionId,
        CreateStage.parse({
          seq: 2,
          kind: "knockout",
          name: "Plate",
          config: {},
          progression: { sources: [{ stage: { stageId: main!.id }, take: [{ kind: "roundLosers", round: 1, count: 2 }] }], placement: "rank_order", timing: "setup" },
        }),
      );
      expect((await refusal(startDivision(auth, divisionId))).code).toBe("KO_PLATE_TOO_FEW");
    }, 120_000);

    it("the Start refusal sweeps the registry: every sport, the same name", async () => {
      let swept = 0;
      for (const m of builtinModules) {
        const variant = Object.keys(m.variants)[0];
        if (variant === undefined) continue;
        const kind = effectiveEntrantModel(m.entrantModel ?? null, null).defaultKind;
        const { auth, divisionId } = await division(3, { key: m.key, variant, kind: kind as "individual" });
        await addStages(auth, divisionId, buildTemplateStages("ko_plate", { ...KNOBS, qualified: 4 }));
        expect((await refusal(startDivision(auth, divisionId))).code, m.key).toBe("KO_PLATE_TOO_FEW");
        swept++;
      }
      expect(swept, "anti-vacuity: the registry was read").toBeGreaterThanOrEqual(builtinModules.length - 1);
    }, 300_000);
  });

  describe("X-QM-5 qualifying_main", () => {
    const TOO_FEW = "Qualifying + Main draw needs at least 4 entrants.";

    for (const n of [2, 3]) {
      it(`X-QM-5 qualifying_main below its bound is refused by name: Start and Generate at n=${n}`, async () => {
        const r = await rig("qualifying_main", n);
        await expectRefusedAtStart(r, "QUALIFYING_MAIN_TOO_FEW", TOO_FEW);
        const atGenerate = await refusal(generateStageFixtures(r.auth, r.stageIds[0]!));
        expect(atGenerate.code).toBe("QUALIFYING_MAIN_TOO_FEW");
        expect(atGenerate.message).toBe(TOO_FEW);
        expect(atGenerate.extra, "the bound rides on the envelope for the screen's sentence").toMatchObject({ min: 4 });
      }, 120_000);
    }

    it("the bound follows the cut: q = 8 is refused at 7 naming 8, q = 2 starts at 3", async () => {
      const eight = await rig("qualifying_main", 7, 8);
      const err = await refusal(startDivision(eight.auth, eight.divisionId));
      expect(err.code).toBe("QUALIFYING_MAIN_TOO_FEW");
      expect(err.message).toBe("Qualifying + Main draw needs at least 8 entrants.");
      const two = await rig("qualifying_main", 3, 2);
      expect((await startDivision(two.auth, two.divisionId)).started).toBe(true);
    }, 120_000);
  });

  describe("X-QM-2 a knockout source's cut must cover whole finishing bands (RB4-Q2)", () => {
    const cutFrom = (to: number) => ({ sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to }] }], placement: "rank_order", timing: "setup" });
    const SENTENCE = "From a knockout, qualify a whole round: 1, 2, 4, 8 …";

    async function create(sourceKind: "knockout" | "league", to: number) {
      const { auth, divisionId } = await division(16);
      await createStages(auth, divisionId, [{ seq: 1, kind: sourceKind, name: "Source", config: {} }]);
      return createStages(auth, divisionId, CreateStage.parse({ seq: 2, kind: "knockout", name: "Main", config: {}, progression: cutFrom(to) }));
    }

    for (const width of [3, 5, 6]) {
      it(`X-QM-2 refuses a cut of ${width} from a knockout source, and stores nothing`, async () => {
        const { auth, divisionId } = await division(16);
        await createStages(auth, divisionId, [{ seq: 1, kind: "knockout", name: "Source", config: {} }]);
        const err = await refusal(createStages(auth, divisionId, CreateStage.parse({ seq: 2, kind: "knockout", name: "Main", config: {}, progression: cutFrom(width) })));
        expect(err.code).toBe("KO_CUT_NOT_WHOLE_ROUND");
        expect(err.status).toBe(422);
        expect(err.message).toBe(SENTENCE);
        const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from stages where division_id = ${divisionId}`;
        expect(n, "the refused stage is not there").toBe(1);
      }, 60_000);
    }

    for (const width of [2, 4, 8]) {
      it(`X-QM-2 accepts a cut of ${width} from a knockout source`, async () => {
        expect((await create("knockout", width)).length).toBe(1);
      }, 60_000);
    }

    it("X-QM-2 accepts a cut of 1 from a knockout source: the winner, beside another source's (a single source of one is the engine's own refusal)", async () => {
      const { auth, divisionId } = await division(16);
      const [a] = await createStages(auth, divisionId, [{ seq: 1, kind: "knockout", name: "A", config: {} }]);
      const [b] = await createStages(auth, divisionId, [{ seq: 2, kind: "knockout", name: "B", config: {} }]);
      const made = await createStages(
        auth,
        divisionId,
        CreateStage.parse({
          seq: 3,
          kind: "knockout",
          name: "Champions",
          config: {},
          progression: {
            sources: [
              { stage: { stageId: a!.id }, take: [{ kind: "rankRange", from: 1, to: 1 }] },
              { stage: { stageId: b!.id }, take: [{ kind: "rankRange", from: 1, to: 1 }] },
            ],
            placement: "rank_order",
            timing: "setup",
          },
        }),
      );
      expect(made.length).toBe(1);
    }, 60_000);

    // The finishing bands, written out (rulebook RB4-Q2, ruling 273): 1st, 2nd, 3rd-4th (shared), 5th-8th, 9th-16th ...; with a
    // third-place match 3rd and 4th are places of their own. Every case here is the hand-read verdict, never the predicate's.
    type Take = { from: number; to: number };
    const rules = (takes: Take[]) => ({ sources: [{ stage: "previous", take: takes.map((t) => ({ kind: "rankRange", ...t })) }], placement: "rank_order", timing: "setup" });
    async function createCut(takes: Take[], sourceConfig: Record<string, unknown> = {}) {
      const { auth, divisionId } = await division(16);
      await createStages(auth, divisionId, [{ seq: 1, kind: "knockout", name: "Source", config: sourceConfig }]);
      const made = await createStages(auth, divisionId, CreateStage.parse({ seq: 2, kind: "knockout", name: "Main", config: {}, progression: rules(takes) })).then(
        (rows) => ({ rows }),
        (e: unknown) => ({ err: e }),
      );
      const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from stages where division_id = ${divisionId}`;
      return { made, stages: n };
    }
    // [label, takes, source plays a third-place match, whole]. One rank rule takes at least two (the engine's own floor, a lone
    // winner is SEEDING_RULES_MISSING), so a single place rides beside another rule.
    const CUTS: [string, Take[], boolean, boolean][] = [
      ["1-2", [{ from: 1, to: 2 }], false, true],
      ["1-4", [{ from: 1, to: 4 }], false, true],
      ["2-4", [{ from: 2, to: 4 }], false, true],
      ["3-4", [{ from: 3, to: 4 }], false, true],
      ["3-8", [{ from: 3, to: 8 }], false, true],
      ["5-8", [{ from: 5, to: 8 }], false, true],
      ["1-2 + 3-4: two bands that join", [{ from: 1, to: 2 }, { from: 3, to: 4 }], false, true],
      ["2-3: starts on 2nd, ends inside the shared 3rd-4th", [{ from: 2, to: 3 }], false, false],
      ["4-5: starts inside 3rd-4th, ends inside 5th-8th", [{ from: 4, to: 5 }], false, false],
      ["1-3", [{ from: 1, to: 3 }], false, false],
      ["5-6", [{ from: 5, to: 6 }], false, false],
      ["1-1 + 3-3: 3-3 is half of a shared place, judged alone", [{ from: 1, to: 1 }, { from: 3, to: 3 }], false, false],
      ["1-1 + 4-4", [{ from: 1, to: 1 }, { from: 4, to: 4 }], false, false],
      ["1-3 with a third-place match", [{ from: 1, to: 3 }], true, true],
      ["2-3 with a third-place match", [{ from: 2, to: 3 }], true, true],
      ["1-1 + 3-3 with a third-place match", [{ from: 1, to: 1 }, { from: 3, to: 3 }], true, true],
      ["1-1 + 4-4 with a third-place match", [{ from: 1, to: 1 }, { from: 4, to: 4 }], true, true],
      ["4-8 with a third-place match", [{ from: 4, to: 8 }], true, true],
      ["4-5 with a third-place match", [{ from: 4, to: 5 }], true, false],
      ["5-6 with a third-place match", [{ from: 5, to: 6 }], true, false],
      ["1-5 with a third-place match", [{ from: 1, to: 5 }], true, false],
    ];

    it("X-QM-2 the cut must start on a finishing band's first place and end on a band's last: a table through createStages, by the source's third-place setting", async () => {
      let whole = 0;
      let refused = 0;
      for (const [label, takes, playoff, expected] of CUTS) {
        const { made, stages } = await createCut(takes, playoff ? { thirdPlace: true } : {});
        if (expected) {
          expect("rows" in made, `${label}: accepted`).toBe(true);
          expect(stages, `${label}: the stage is there`).toBe(2);
          whole++;
        } else {
          const err = "err" in made ? made.err : null;
          expect(err, `${label}: refused`).toBeInstanceOf(HttpError);
          expect((err as HttpError).code, label).toBe("KO_CUT_NOT_WHOLE_ROUND");
          expect((err as HttpError).status).toBe(422);
          expect((err as HttpError).message).toBe(SENTENCE);
          expect(stages, `${label}: and stores nothing`).toBe(1);
          refused++;
        }
      }
      expect(whole + refused, "anti-vacuity: every case ran").toBe(21);
      expect(refused, "and both verdicts were met: 12 whole, 9 not").toBe(9);
    }, 300_000);

    it("the refusal names the rule it stopped at: the cut's own from, to and width", async () => {
      const { made } = await createCut([{ from: 1, to: 2 }, { from: 4, to: 5 }]);
      const err = "err" in made ? (made.err as HttpError) : null;
      expect(err?.code).toBe("KO_CUT_NOT_WHOLE_ROUND");
      expect(err?.extra).toMatchObject({ from: 4, to: 5, width: 2 });
    }, 60_000);

    it("the third-place setting is read off the source STAGE, not the stage being saved: a playoff on the new stage does not unlock 1-3", async () => {
      const { auth, divisionId } = await division(16);
      await createStages(auth, divisionId, [{ seq: 1, kind: "knockout", name: "Source", config: {} }]);
      const err = await refusal(createStages(auth, divisionId, CreateStage.parse({ seq: 2, kind: "knockout", name: "Main", config: { thirdPlace: true }, progression: cutFrom(3) })));
      expect(err.code).toBe("KO_CUT_NOT_WHOLE_ROUND");
    }, 60_000);

    it("the third-place setting is read off a PRESET source too (instantiateTemplate hands the sibling row's {kind, config} over, no stage id)", async () => {
      // No catalog template sets a playoff today, so this is the one place the preset branch is reached with the setting on. A
      // preset source needs no read, so the transaction is never touched.
      const spec = { sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 3 }] }], placement: "rank_order", timing: "setup" } as never;
      const target = { division_id: randomUUID(), seq: 2, kind: "knockout" };
      const tx = {} as never;
      await expect(validateStageProgression(tx, target, spec, [{ kind: "knockout", config: { thirdPlace: true } }])).resolves.toBeUndefined();
      const err = await refusal(validateStageProgression(tx, target, spec, [{ kind: "knockout", config: {} }]));
      expect(err.code).toBe("KO_CUT_NOT_WHOLE_ROUND");
      expect((await refusal(validateStageProgression(tx, target, spec, [{ kind: "knockout", config: { thirdPlace: false } }]))).code, "false is no playoff").toBe("KO_CUT_NOT_WHOLE_ROUND");
    }, 60_000);

    it("a table source still takes 3: a table ranks everyone", async () => {
      expect((await create("league", 3)).length).toBe(1);
    }, 60_000);

    it("a plate's roundLosers take is no rank cut: a count of 3 from a knockout stands", async () => {
      const { auth, divisionId } = await division(16);
      await createStages(auth, divisionId, [{ seq: 1, kind: "knockout", name: "Source", config: {} }]);
      const made = await createStages(
        auth,
        divisionId,
        CreateStage.parse({ seq: 2, kind: "knockout", name: "Plate", config: {}, progression: { sources: [{ stage: "previous", take: [{ kind: "roundLosers", round: 1, count: 3 }] }], placement: "rank_order", timing: "setup" } }),
      );
      expect(made.length).toBe(1);
    }, 60_000);

    it("the format PUT door refuses it too, and leaves the stored stages as they were", async () => {
      const { auth, divisionId } = await division(16);
      await createStages(auth, divisionId, [{ seq: 1, kind: "league", name: "League", config: {} }]);
      const before = await sql`select id, kind from stages where division_id = ${divisionId} order by seq`;
      const err = await refusal(
        replaceStages(auth, divisionId, [
          { seq: 1, kind: "knockout", name: "Source", config: {}, progression: null },
          { seq: 2, kind: "knockout", name: "Main", config: {}, progression: cutFrom(3) },
        ] as never),
      );
      expect(err.code).toBe("KO_CUT_NOT_WHOLE_ROUND");
      expect(await sql`select id, kind from stages where division_id = ${divisionId} order by seq`).toEqual(before);
    }, 60_000);

    it("a stored cut that predates the rule keeps running: Start and Generate do not re-judge it (save time only)", async () => {
      const r = await rig("qualifying_main", 8, 4);
      await sql`update stages set progression = ${sql.json(cutFrom(3) as never)} where id = ${r.stageIds[1]!}`;
      expect((await startDivision(r.auth, r.divisionId)).started).toBe(true);
      await expect(generateStageFixtures(r.auth, r.stageIds[1]!)).resolves.toBeTruthy();
    }, 120_000);
  });

  describe("X-QM-3", () => {
    it("X-QM-3 qualifiers are seeded into the main draw by qualifying rank on the fold", async () => {
      // Eight players, an upset run: E5 beats E4, E1 and E2, the favourite wins every other line. Read by hand: the final E5 v E2,
      // so E5 first and E2 second; the semi-final losers rank by seed (RB4-Q1), E1 third and E3 fourth. E5's entrant seed is 5 and
      // her draw seed is 1, so a draw on the entrant seed cannot pass.
      const r = await rig("qualifying_main", 8);
      await startDivision(r.auth, r.divisionId);
      await generateStageFixtures(r.auth, r.stageIds[1]!);
      const num = (id: string) => Number(r.nameOf.get(id)!.slice(1));
      for (let guard = 0; guard < 10; guard++) {
        const open = await sql<{ id: string; home_entrant_id: string; away_entrant_id: string }[]>`
          select id, home_entrant_id, away_entrant_id from fixtures
           where stage_id = ${r.stageIds[0]!} and home_entrant_id is not null and away_entrant_id is not null and status = 'scheduled'`;
        if (open.length === 0) break;
        for (const f of open) {
          const fav = [f.home_entrant_id, f.away_entrant_id].find((id) => r.nameOf.get(id) === "E5") ?? (num(f.home_entrant_id) < num(f.away_entrant_id) ? f.home_entrant_id : f.away_entrant_id);
          const post = async (type: string, payload: Record<string, unknown> = {}) => {
            const [{ n }] = await sql<{ n: number }[]>`select coalesce(max(seq), 0)::int as n from score_events where fixture_id = ${f.id}`;
            await scoreEvent(r.auth, f.id, { expected_seq: n, type, payload });
          };
          await post("core.start");
          const homeWins = fav === f.home_entrant_id;
          for (let g = 0; g < 2; g++) await post("badminton.game.summary", homeWins ? { home: 21, away: 10 } : { home: 10, away: 21 });
        }
      }
      expect((await completeStage(r.auth, r.stageIds[0]!)).completed).toBe(true);
      const proposal = await getSeedProposal(r.auth, r.stageIds[1]!);
      await confirmSeedProposal(r.auth, r.stageIds[1]!, { proposalId: proposal!.id });

      const ranks = ["E5", "E2", "E1", "E3"];
      const [{ config }] = await sql<{ config: { qualified?: string[] } }[]>`select config from stages where id = ${r.stageIds[1]!}`;
      const lines = await sql<{ home_entrant_id: string; away_entrant_id: string }[]>`
        select home_entrant_id, away_entrant_id from fixtures where stage_id = ${r.stageIds[1]!} and round_no = 1 order by seq_in_round, id`;
      // The engine's own fold for four, fed the ranks in order: draw seed i holds qualifying rank i.
      const fold = generateSingleElim({ entrants: ranks, seeds: new Map(ranks.map((name, i) => [name, i + 1])) })
        .fixtures.filter((f) => f.home !== undefined && f.away !== undefined)
        .map((f) => [f.home!, f.away!].sort());
      expect(fold.length, "anti-vacuity: the engine's fold has two lines for four").toBe(2);
      expect(lines.map((l) => [r.nameOf.get(l.home_entrant_id)!, r.nameOf.get(l.away_entrant_id)!].sort()).sort()).toEqual([...fold].sort());
      expect(lines.map((l) => [r.nameOf.get(l.home_entrant_id)!, r.nameOf.get(l.away_entrant_id)!].sort()).sort(), "read by hand: 1 v 4, 2 v 3").toEqual([["E3", "E5"], ["E1", "E2"]].sort());
      // Exact seats, in line order: the pairs alone cannot tell rank 1 from rank 4 (1 v 4 is 4 v 1 reversed).
      const seats = generateSingleElim({ entrants: ranks, seeds: new Map(ranks.map((name, i) => [name, i + 1])) })
        .fixtures.filter((f) => f.home !== undefined && f.away !== undefined)
        .map((f) => [f.home!, f.away!]);
      expect(lines.map((l) => [r.nameOf.get(l.home_entrant_id)!, r.nameOf.get(l.away_entrant_id)!]), "seed 1 where the engine puts seed 1").toEqual(seats);
      if (config.qualified !== undefined) expect(config.qualified.map((id) => r.nameOf.get(id))).toEqual(ranks);
    }, 300_000);
  });
});
