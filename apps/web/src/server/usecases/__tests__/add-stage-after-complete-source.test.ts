// W5 follow-ups fix round 1 (review I2): Add stage after a source that has ALREADY finished saved a Top N its table could not
// supply - a complete six-entrant league asked for its top 8, a complete four-entrant knockout for its top 8. The stage was
// written, its Generate seeded it at once and was refused (the cut gate's RR_CUT_EXCEEDS_FIELD for a table, the engine's
// STAGE_NOT_READY "takes rank 5, but only 4 are available" for a knockout's placement table), and the desk read every
// STAGE_NOT_READY as "fixtures will generate when the previous stage completes" - for a stage that never fills. The save now asks
// what the completion would, and refuses by name, writing nothing; a source not yet complete is still the completion's to judge.
// The desk, for its part, says "later" only for the one wait it means (`previous_stage_incomplete`).
//
// Every scene runs the REAL door (`createStages`, behind POST /divisions/{id}/stages), real draws, real results through
// `scoreEvent` and the real completion. Expected numbers come from the scene: a league's table has one row per entrant, a
// knockout's placement table one row per entrant - never from the code under test.
// single-sport (generic): the refusal reads table sizes and the take, never a sport rule.
// Real Postgres required; skipped without DATABASE_URL.
import { afterAll, describe, expect, it, vi } from "vitest";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { ApiV1Error, apiV1 } from "@/lib/client-v1";
import { t } from "@/lib/i18n-runtime";
import type { Dict, Locale } from "@/lib/i18n-constants";
import enUi from "@/dictionaries/en/ui.json";
import esUi from "@/dictionaries/es/ui.json";
import frUi from "@/dictionaries/fr/ui.json";
import nlUi from "@/dictionaries/nl/ui.json";
import type { AuthCtx } from "@/server/api-v1/auth";
import { addStageErrorText, addStageWaitsForPrevious } from "@/components/v2/stages-panel";
import { POST as generatePOST } from "@/app/api/v1/stages/[id]/generate/route";
import { completeStage, createStages, generateStageFixtures } from "../stages";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { startDivision } from "../schedule";
import { post } from "./_groups-ko-scene";
import { seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

const authAs = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("@/server/api-v1/auth", async (orig) => ({
  ...(await orig<typeof import("@/server/api-v1/auth")>()),
  requireResourceAuth: async () => authAs.current,
}));

const UI: Record<Locale, Dict> = { en: enUi, es: esUi, fr: frUi, nl: nlUi } as never;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

type Kind = "league" | "knockout";

/** A division of `entrants` whose first stage is `kind`, drawn and started; with `complete`, every line decided (the lower seed
 *  wins) until the stage is complete through the real door. */
async function division(kind: Kind, entrants: number, complete: boolean): Promise<{ auth: AuthCtx; divId: string; srcId: string }> {
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "Add stage", visibility: "private", branding: {} });
  const [variant] = await sql<{ key: string; config: Record<string, unknown> }[]>`
    select key, config from sport_variants where sport_key = 'generic' and is_system order by key limit 1`;
  const div = await createDivision(auth, comp.id, { name: "Open", slug: "open", sport_key: "generic", variant_key: variant!.key, config: variant!.config } as never);
  await createEntrants(auth, div.id, Array.from({ length: entrants }, (_, i) => ({ kind: "individual" as const, display_name: `E${i + 1}`, seed: i + 1, members: [] })));
  const [src] = await createStages(auth, div.id, [{ seq: 1, kind, name: "First", config: kind === "league" ? { legs: 1 } : {} }] as never);
  await generateStageFixtures(auth, src!.id);
  await startDivision(auth, div.id);
  if (complete) {
    const seedOf = new Map((await sql<{ id: string; seed: number }[]>`select id, seed from entrants where division_id = ${div.id}`).map((e) => [e.id, e.seed]));
    // A knockout seats its later rounds as results land: decide what is playable until nothing is.
    for (let pass = 0; pass < 8; pass++) {
      const open = await sql<{ id: string; home_entrant_id: string; away_entrant_id: string }[]>`
        select id, home_entrant_id, away_entrant_id from fixtures
         where stage_id = ${src!.id} and status not in ('decided', 'forfeited', 'finalized', 'cancelled')
           and home_entrant_id is not null and away_entrant_id is not null`;
      if (open.length === 0) break;
      for (const f of open) {
        await post(auth, f.id, "core.start");
        const homeWins = seedOf.get(f.home_entrant_id)! < seedOf.get(f.away_entrant_id)!;
        await post(auth, f.id, "generic.result", homeWins ? { p1Score: 2, p2Score: 0 } : { p1Score: 0, p2Score: 2 });
      }
    }
    const [{ status }] = await sql<{ status: string }[]>`select status from stages where id = ${src!.id}`;
    if (status !== "complete") expect((await completeStage(auth, src!.id)).completed, "the premise: the source completed").toBe(true);
  }
  return { auth, divId: div.id, srcId: src!.id };
}

/** The Add-stage form's own body (`addStageProgression`, stages-panel.tsx): a knockout taking ranks 1..topN of the previous stage. */
const addStageBody = (topN: number) => ({
  seq: 2,
  kind: "knockout",
  name: "Finals",
  config: {},
  progression: { sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: topN }] }], placement: "rank_order", timing: "on_complete" },
});

const refusalOf = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: unknown) => e as HttpError,
  );

const stagesOf = async (divId: string) => (await sql<{ seq: number }[]>`select seq from stages where division_id = ${divId} order by seq`).map((s) => s.seq);

describe.skipIf(!HAS_DB)("I2 Add stage after a finished source refuses a Top N its table cannot supply", () => {
  it("a complete six-entrant league asked for its top 8: refused RR_CUT_EXCEEDS_FIELD (8 of at most 6), nothing added", async () => {
    const d = await division("league", 6, true);
    const err = await refusalOf(createStages(d.auth, d.divId, addStageBody(8) as never));
    expect(err, "the add is refused").toBeInstanceOf(HttpError);
    expect(err!.status).toBe(422);
    expect(err!.code).toBe("RR_CUT_EXCEEDS_FIELD");
    expect(err!.extra).toMatchObject({ qualified: 8, max: 6 });
    expect(await stagesOf(d.divId), "nothing was added").toEqual([1]);
  });

  it("a complete four-entrant knockout asked for its top 8 (a whole-round cut): refused by name (8 of at most 4), nothing added", async () => {
    const d = await division("knockout", 4, true);
    const err = await refusalOf(createStages(d.auth, d.divId, addStageBody(8) as never));
    expect(err?.code, "the engine's shortfall, said by name").toBe("RR_CUT_EXCEEDS_FIELD");
    expect(err!.extra).toMatchObject({ qualified: 8, max: 4 });
    expect(await stagesOf(d.divId)).toEqual([1]);
  });

  // Round 2 (R2): the shortfall's `max` is what the take can still take from the table, not the table's row count. A take that does
  // not start at rank 1 asks only the ranks it names: ranks 3-8 of four entrants can seat ranks 3 and 4 (2), never "at most 4".
  // (Ranks 3-6 are no whole finishing band, so the save refuses them first as KO_CUT_NOT_WHOLE_ROUND - the takes below are the
  // band-aligned ones that reach the shortfall: 3-4 | 5-8 are the knockout's bands.) The expected `max` is the scene's own count - a rank is there iff it is no more than the entrants the knockout finished with.
  it("a take that does not start at rank 1 says what it CAN take: ranks 3-8, 2-8, 5-8 (and 1-8, which starts there) of a complete four-entrant knockout", async () => {
    const entrants = 4;
    const d = await division("knockout", entrants, true);
    let asked = 0;
    for (const [from, to] of [
      [3, 8],
      [2, 8],
      [5, 8],
      [1, 8],
    ] as const) {
      const body = {
        ...addStageBody(to),
        progression: { sources: [{ stage: "previous", take: [{ kind: "rankRange", from, to }] }], placement: "rank_order", timing: "on_complete" },
      };
      const ranks = Array.from({ length: to - from + 1 }, (_, i) => from + i);
      const err = await refusalOf(createStages(d.auth, d.divId, body as never));
      expect(err?.code, `ranks ${from}-${to}: refused by name`).toBe("RR_CUT_EXCEEDS_FIELD");
      expect(err!.extra, `ranks ${from}-${to}`).toMatchObject({ qualified: ranks.length, max: ranks.filter((r) => r <= entrants).length });
      asked += 1;
    }
    expect(asked, "anti-vacuity: four takes asked").toBe(4);
    expect(await stagesOf(d.divId), "nothing was added").toEqual([1]);
  });

  it("the sequence: a second Add stage after the refusal is refused the same way, and a Top N the table CAN supply then saves", async () => {
    const d = await division("league", 6, true);
    for (let attempt = 1; attempt <= 2; attempt++) {
      expect((await refusalOf(createStages(d.auth, d.divId, addStageBody(8) as never)))?.code, `attempt ${attempt}`).toBe("RR_CUT_EXCEEDS_FIELD");
    }
    const rows = await createStages(d.auth, d.divId, addStageBody(4) as never);
    expect(rows.map((s) => s.seq), "Top 4 of six saves").toEqual([2]);
    const gen = await generateStageFixtures(d.auth, rows[0]!.id);
    expect(gen.created, "and fills: a four-seat knockout has three lines").toBeGreaterThan(0);
  });

  it("positive pairs: the whole table (Top 6 of six, Top 4 of a four-knockout) saves; a Top 8 of a league NOT yet complete saves (the completion judges it)", async () => {
    let saved = 0;
    for (const [kind, n, topN, complete] of [
      ["league", 6, 6, true],
      ["knockout", 4, 4, true],
      ["league", 6, 8, false],
    ] as const) {
      const d = await division(kind, n, complete);
      const rows = await createStages(d.auth, d.divId, addStageBody(topN) as never);
      expect(rows.map((s) => s.seq), `${kind} of ${n}${complete ? " complete" : ""}: Top ${topN} saves`).toEqual([2]);
      saved += 1;
    }
    expect(saved, "anti-vacuity: three sources asked").toBe(3);
  });

  it("the desk says 'later' only for the wait it means: a source not yet complete answers previous_stage_incomplete on the wire; any other STAGE_NOT_READY is a refusal", async () => {
    const d = await division("league", 6, false);
    const [stage] = await createStages(d.auth, d.divId, addStageBody(4) as never);
    authAs.current = d.auth;
    const res = await generatePOST(new Request(`http://local/api/v1/stages/${stage!.id}/generate`, { method: "POST", body: "{}" }), {
      params: Promise.resolve({ id: stage!.id }),
    });
    expect(res.status).toBe(422);
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => res) as typeof fetch;
    const wire = await apiV1(`/api/v1/stages/${stage!.id}/generate`, { method: "POST", json: {} }).then(
      () => null,
      (e: unknown) => e,
    );
    globalThis.fetch = realFetch;
    expect(wire).toBeInstanceOf(ApiV1Error);
    expect((wire as ApiV1Error).code).toBe("STAGE_NOT_READY");
    expect(addStageWaitsForPrevious(wire), "the source is not complete: completion will seed it").toBe(true);

    // The engine's shortfall as the wire carries it (http.ts forwards no reason for it), and a refusal of another code.
    const shortfall = new ApiV1Error("the previous stage takes rank 5, but only 4 entrants are available", 422, "STAGE_NOT_READY");
    expect(addStageWaitsForPrevious(shortfall), "a STAGE_NOT_READY without the wait's reason is not a wait").toBe(false);
    const cut = new ApiV1Error("x", 422, "RR_CUT_EXCEEDS_FIELD", { qualified: 8, max: 6 });
    expect(addStageWaitsForPrevious(cut)).toBe(false);
    expect(addStageWaitsForPrevious(new Error("network"))).toBe(false);
    let locales = 0;
    for (const locale of ["en", "es", "fr", "nl"] as const) {
      const msg = (key: string, vars?: Record<string, string | number>) => t(UI[locale], key, vars);
      const line = addStageErrorText(cut, msg as never, locale);
      expect(line, `${locale}: the cut refusal in the reader's language`).toBe(t(UI[locale], "roundrobin.refusal.RR_CUT_EXCEEDS_FIELD", { qualified: 8, max: 6 }));
      const card = msg("schedule.notice.stageAddedRefused", { name: "Finals", reason: line });
      expect(card, `${locale}: the card names the stage and the refusal`).toContain("Finals");
      expect(card, `${locale}: no placeholder left`).not.toMatch(/\{(name|reason)\}/);
      expect(card, `${locale}: the key exists`).not.toBe("schedule.notice.stageAddedRefused");
      expect(msg("schedule.addStage.keepRefused"), `${locale}: the keep label exists`).not.toBe("schedule.addStage.keepRefused");
      locales += 1;
    }
    expect(locales, "anti-vacuity: four locales").toBe(4);
  });
});
