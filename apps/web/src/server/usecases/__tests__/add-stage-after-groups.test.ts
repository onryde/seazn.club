// W5 follow-ups A2 (owner "apply rec", 2026-11-22): Add stage after a multi-pool group stage posts a `rankRange` take (Top N of
// ONE table). The engine reads that take from the sole pool or the pool keyed "" (`rankRangeSource`), and a group of two or more
// pools has neither, so the stage was created, its Generate answered 422 STAGE_NOT_READY `no pool "overall"`, and the page said
// "Stage added - fixtures will generate when the previous stage completes" - which never happens. The save is now refused by name
// (SEEDING_TOP_N_ACROSS_GROUPS) and writes nothing. A group-aware Add stage (a per-group count, owner Option C 2026-11-24) is `add-stage-group-take.test.ts`.
//
// Every scene runs the REAL door (`createStages`, the usecase behind POST /divisions/{id}/stages), a real snake draw, real results
// through `scoreEvent` and the real completion. The positive pairs prove the guard is about the TAKE across several tables: a
// `topNPerGroup` take from the same groups, and a `rankRange` from a one-pool group or a league, still save.
// single-sport (generic): the refusal reads only the source's pool count and the take's kind, never a sport rule.
// Real Postgres required; skipped without DATABASE_URL.
import { afterAll, describe, expect, it, vi } from "vitest";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { ApiV1Error, apiV1 } from "@/lib/client-v1";
import { t } from "@/lib/i18n-runtime";
import type { Dict, Locale } from "@/lib/i18n-constants";
import enErr from "@/dictionaries/en/errors.json";
import esErr from "@/dictionaries/es/errors.json";
import frErr from "@/dictionaries/fr/errors.json";
import nlErr from "@/dictionaries/nl/errors.json";
import enUi from "@/dictionaries/en/ui.json";
import esUi from "@/dictionaries/es/ui.json";
import frUi from "@/dictionaries/fr/ui.json";
import nlUi from "@/dictionaries/nl/ui.json";
import type { AuthCtx } from "@/server/api-v1/auth";
import { addStageErrorText } from "@/components/v2/stages-panel";
import { POST } from "@/app/api/v1/divisions/[id]/stages/route";
import { completeStage, createStages, generateStageFixtures } from "../stages";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { startDivision } from "../schedule";
import { post } from "./_groups-ko-scene";
import { seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

// The route's auth door answers with the scene's own org (the session cookie is not what is under test); everything after it is real.
const authAs = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("@/server/api-v1/auth", async (orig) => ({
  ...(await orig<typeof import("@/server/api-v1/auth")>()),
  requireResourceAuth: async () => authAs.current,
}));

const ERRORS: Record<Locale, Dict> = { en: enErr, es: esErr, fr: frErr, nl: nlErr } as never;
const UI: Record<Locale, Dict> = { en: enUi, es: esUi, fr: frUi, nl: nlUi } as never;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

type Source = { kind: "group"; pools: number } | { kind: "league" };

/** A division whose first stage is `source`, drawn and started; with `complete`, every line decided (the lower seed wins) and
 *  the stage completed through the real door. */
async function division(source: Source, complete: boolean): Promise<{ auth: AuthCtx; divId: string; srcId: string }> {
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "Add stage", visibility: "private", branding: {} });
  const [variant] = await sql<{ key: string; config: Record<string, unknown> }[]>`
    select key, config from sport_variants where sport_key = 'generic' and is_system order by key limit 1`;
  const div = await createDivision(auth, comp.id, { name: "Open", slug: "open", sport_key: "generic", variant_key: variant!.key, config: variant!.config } as never);
  await createEntrants(auth, div.id, Array.from({ length: 8 }, (_, i) => ({ kind: "individual" as const, display_name: `E${i + 1}`, seed: i + 1, members: [] })));
  const config = source.kind === "group" ? { legs: 1, pools: { count: source.pools } } : { legs: 1 };
  const [src] = await createStages(auth, div.id, [{ seq: 1, kind: source.kind, name: "Groups", config }] as never);
  await generateStageFixtures(auth, src!.id);
  await startDivision(auth, div.id);
  if (complete) {
    const seedOf = new Map((await sql<{ id: string; seed: number }[]>`select id, seed from entrants where division_id = ${div.id}`).map((e) => [e.id, e.seed]));
    const fx = await sql<{ id: string; home_entrant_id: string; away_entrant_id: string }[]>`
      select id, home_entrant_id, away_entrant_id from fixtures where stage_id = ${src!.id}`;
    expect(fx.length, "the premise: the source has lines").toBeGreaterThan(0);
    for (const f of fx) {
      await post(auth, f.id, "core.start");
      const homeWins = seedOf.get(f.home_entrant_id)! < seedOf.get(f.away_entrant_id)!;
      await post(auth, f.id, "generic.result", homeWins ? { p1Score: 2, p2Score: 0 } : { p1Score: 0, p2Score: 2 });
    }
    expect((await completeStage(auth, src!.id)).completed, "the premise: the source completed").toBe(true);
  }
  return { auth, divId: div.id, srcId: src!.id };
}

/** The Add-stage form's own body (`addStageProgression`, stages-panel.tsx): a knockout taking ranks 1..topN of the previous stage. */
const addStageBody = (take: unknown[]) => ({
  seq: 2,
  kind: "knockout",
  name: "Finals",
  config: {},
  progression: { sources: [{ stage: "previous", take }], placement: "rank_order", timing: "on_complete" },
});
const TOP_4 = [{ kind: "rankRange", from: 1, to: 4 }];

const refusalOf = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: unknown) => e as HttpError,
  );

const stagesOf = async (divId: string) => (await sql<{ seq: number }[]>`select seq from stages where division_id = ${divId} order by seq`).map((s) => s.seq);

describe.skipIf(!HAS_DB)("A2 Add stage after a multi-pool group refuses by name instead of promising fixtures", () => {
  it("after the groups completed: a Top N take from two groups is refused SEEDING_TOP_N_ACROSS_GROUPS and nothing is added", async () => {
    const d = await division({ kind: "group", pools: 2 }, true);
    const [{ n: pools }] = await sql<{ n: number }[]>`select count(*)::int as n from pools where stage_id = ${d.srcId}`;
    expect(pools, "the premise: the source drew two pools").toBe(2);
    const err = await refusalOf(createStages(d.auth, d.divId, addStageBody(TOP_4) as never));
    expect(err, "the add is refused").toBeInstanceOf(HttpError);
    expect(err!.status).toBe(422);
    expect(err!.code).toBe("SEEDING_TOP_N_ACROSS_GROUPS");
    expect(err!.extra, "names the pool count the copy shows").toMatchObject({ pools: 2 });
    expect(await stagesOf(d.divId), "nothing was added").toEqual([1]);
  });

  it("through the wire: POST /divisions/{id}/stages answers 422 by name, and the Add stage form says the dictionary's refusal in each locale - never the server's English", async () => {
    const d = await division({ kind: "group", pools: 2 }, true);
    authAs.current = d.auth;
    const res = await POST(new Request(`http://local/api/v1/divisions/${d.divId}/stages`, { method: "POST", body: JSON.stringify(addStageBody(TOP_4)) }), {
      params: Promise.resolve({ id: d.divId }),
    });
    expect(res.status).toBe(422);
    // The client's own parse of that reply (`apiV1`), fed the route's Response.
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => res) as typeof fetch;
    const err = await apiV1(`/api/v1/divisions/${d.divId}/stages`, { method: "POST", json: {} }).then(
      () => null,
      (e: unknown) => e,
    );
    globalThis.fetch = realFetch;
    expect(err).toBeInstanceOf(ApiV1Error);
    const wire = err as ApiV1Error;
    expect(wire.code).toBe("SEEDING_TOP_N_ACROSS_GROUPS");
    let locales = 0;
    for (const locale of ["en", "es", "fr", "nl"] as const) {
      const msg = (key: string, vars?: Record<string, string | number>) => t(UI[locale], key, vars);
      const line = addStageErrorText(wire, msg as never, locale);
      expect(line, `${locale}: the dictionary's refusal, with the pool count`).toBe(t(ERRORS[locale], "seeding.SEEDING_TOP_N_ACROSS_GROUPS", { pools: 2 }));
      expect(line, `${locale}: the count is filled`).toContain("2");
      expect(line, `${locale}: no placeholder left`).not.toContain("{pools}");
      expect(line, `${locale}: never the server's English`).not.toBe(wire.message);
      locales += 1;
    }
    expect(locales, "anti-vacuity: four locales").toBe(4);
    expect(await stagesOf(d.divId), "nothing was added").toEqual([1]);
  });

  it("before the groups are drawn: the same take saved with the groups in one batch is refused too (the shape comes from the config)", async () => {
    const { auth } = await seedOrg("pro");
    const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "Batch", visibility: "private", branding: {} });
    const [variant] = await sql<{ key: string; config: Record<string, unknown> }[]>`
      select key, config from sport_variants where sport_key = 'generic' and is_system order by key limit 1`;
    const div = await createDivision(auth, comp.id, { name: "Open", slug: "open", sport_key: "generic", variant_key: variant!.key, config: variant!.config } as never);
    const err = await refusalOf(
      createStages(auth, div.id, [{ seq: 1, kind: "group", name: "Groups", config: { legs: 1, pools: { count: 3 } } }, addStageBody(TOP_4)] as never),
    );
    expect(err?.code).toBe("SEEDING_TOP_N_ACROSS_GROUPS");
    expect(err!.extra).toMatchObject({ pools: 3 });
    expect(await stagesOf(div.id), "the whole batch rolled back").toEqual([]);
  });

  it("a second Add stage after the refusal is refused the same way (the refusal left nothing behind to change the answer)", async () => {
    const d = await division({ kind: "group", pools: 2 }, true);
    for (let attempt = 1; attempt <= 2; attempt++) {
      const err = await refusalOf(createStages(d.auth, d.divId, addStageBody(TOP_4) as never));
      expect(err?.code, `attempt ${attempt}`).toBe("SEEDING_TOP_N_ACROSS_GROUPS");
    }
    expect(await stagesOf(d.divId)).toEqual([1]);
  });

  it("positive pairs: a per-group take from the same groups, and a Top N from a one-pool group or a league, still save", async () => {
    const groups = await division({ kind: "group", pools: 2 }, true);
    const perGroup = await createStages(groups.auth, groups.divId, addStageBody([{ kind: "topNPerGroup", n: 2 }]) as never);
    expect(perGroup.map((s) => s.seq), "topNPerGroup from two groups saves").toEqual([2]);
    let saved = 0;
    for (const source of [{ kind: "group", pools: 1 }, { kind: "league" }] as const) {
      const d = await division(source, true);
      const rows = await createStages(d.auth, d.divId, addStageBody(TOP_4) as never);
      expect(rows.map((s) => s.seq), `${source.kind} ${"pools" in source ? source.pools : ""}: Top 4 saves`).toEqual([2]);
      saved += 1;
    }
    expect(saved, "anti-vacuity: both single-table sources were asked").toBe(2);
  });
});
