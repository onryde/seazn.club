// Match Day C2 (spec 2026-10-31 §12 Phase C item 10) — the inert-seam rule for the ONE Points and Tie-breaks components where
// they edit the DIVISION: the Division rules strip (Fixtures tab) and the division builder. A body the component never sends,
// or a field nothing reads, would pass every unit test; so each case here drives the REAL component (the hook harness, its
// `apiV1` captured), hands what it sent to the REAL route schema and use case on a real database, and reads it back through
// the REAL consumer: `loadTableRules`, the one resolver "Use the division's order" (a stage's `tiebreakers: null`) reads.
//
// Expected values come from the engine (`defaultTiebreakers`, `validateCascade`, the sport's own points keys) and from what the
// test typed. Real Postgres; skipped without DATABASE_URL. Swept over two sports whose points keys differ (generic `w/d/l`,
// football `win/draw/loss`) and the sequence: edit, save, a second save back to the sport's order.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { ReactElement, ReactNode } from "react";
import { validateCascade } from "@seazn/engine/competition";
import type { AnySportModule, TiebreakerKey } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";

const { apiV1Mock } = vi.hoisted(() => ({ apiV1Mock: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/o/org/c/comp/d/new",
}));
vi.mock("@/components/i18n/dict-provider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/i18n/dict-provider")>()),
  useLocale: () => "en" as const,
}));
vi.mock("@/lib/client-v1", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/client-v1")>()),
  apiV1: apiV1Mock,
}));

import { propsOf, renderIsland, textOf, walk } from "@/components/__tests__/_hook-harness";
import { DivisionRulesStrip, expandRules, stripPropsOf } from "@/components/v2/__tests__/_rules-strip";
import { DivisionBuilder } from "@/components/v2/division-builder";
import { PointsEditor } from "@/components/v2/rules/points-editor";
import { TiebreaksEditor } from "@/components/v2/rules/tiebreaks-editor";
import uiEn from "@/dictionaries/en/ui.json";
import { sql } from "@/lib/db";
import { sportOptionsFrom } from "@/lib/sport-options";
import { CreateDivision, CreateStages, PatchDivision } from "@/server/api-v1/schemas";
import { loadTableRules } from "@/server/engine-db/table-rules";
import { createCompetition } from "../competitions";
import { createDivision, getDivision, patchDivision } from "../divisions";
import { putStageRules } from "../stage-rules";
import { createStages } from "../stages";
import { GENERIC_CONFIG, seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;
const UI = uiEn as Record<string, string>;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

beforeEach(() => {
  apiV1Mock.mockReset();
  apiV1Mock.mockImplementation(async () => ({}));
});

const mod = (key: string): AnySportModule => builtinModules.find((m) => m.key === key)! as AnySportModule;
/** The two sports swept: their points keys differ (generic `w`, football `win`), so a body built for one shape is caught. */
const SPORTS = [
  { sport: "generic", variant: "score", config: GENERIC_CONFIG as Record<string, unknown> },
  { sport: "football", variant: "11-a-side", config: {} as Record<string, unknown> },
] as const;

/** An order the division can hold that is NOT the sport's: the sport's first and last step (its primary measure, then lots).
 *  The engine is asked that it is a valid league cascade and that it differs from the default - both premises. */
function divisionOrder(m: AnySportModule, cfg: unknown): TiebreakerKey[] {
  const sportOrder = m.defaultTiebreakers("league", m.configSchema.parse(cfg));
  const order = [sportOrder[0]!, sportOrder[sportOrder.length - 1]!];
  expect(order, `${m.key}: premise, the order differs from the sport's`).not.toEqual(sportOrder);
  expect(validateCascade(order, { module: m, cfg: m.configSchema.parse(cfg), stageKind: "league", crossGroup: false }), `${m.key}: premise, a valid league order`).toEqual([]);
  return order;
}

const find = (tree: ReactElement[], type: unknown): ReactElement => {
  const el = tree.find((e) => e.type === type);
  if (el === undefined) throw new Error(`${String((type as { name?: string }).name)} not on screen`);
  return el;
};
const click = (tree: ReactElement[], testId: string): void => {
  const el = tree.find((e) => e.type === "button" && propsOf(e)["data-testid"] === testId);
  if (el === undefined) throw new Error(`no button ${testId} in: ${tree.map((n) => textOf(n)).join(" | ")}`);
  (propsOf(el).onClick as () => void)();
};
/** The last PATCH the island sent to `/api/v1/divisions/{id}`, as the route's own schema parses it. */
function sentPatch(divisionId: string) {
  const call = [...apiV1Mock.mock.calls].reverse().find(([url, opts]) => url === `/api/v1/divisions/${divisionId}` && (opts as { method?: string })?.method === "PATCH");
  if (call === undefined) throw new Error("the island sent no PATCH");
  return PatchDivision.parse((call[1] as { json: unknown }).json);
}

describe.skipIf(!HAS_DB)("Match Day C2: the Division rules strip's saves reach the stage that inherits them", () => {
  it("tie-breaks: an order edited and saved on the strip is what a stage on 'Use the division's order' resolves; 'Use the sport's order' saved after it brings the sport's back (two sports, counted)", async () => {
    let checked = 0;
    for (const s of SPORTS) {
      const m = mod(s.sport);
      const { auth } = await seedOrg("pro");
      const suffix = randomUUID().slice(0, 8);
      const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "C2 seam " + suffix, visibility: "private", branding: {} });
      const d = await createDivision(auth, comp.id, { name: "Open", slug: "open-" + suffix, sport_key: s.sport, variant_key: s.variant, config: s.config });
      const [stage] = await createStages(auth, d.id, { seq: 1, kind: "league", name: "Pool A", config: {}, progression: null });
      // The stage had its own order, then its card's "Use the division's order" - the field that clears is `tiebreakers: null`.
      const own = m.defaultTiebreakers("league", m.configSchema.parse(s.config));
      await putStageRules(auth, stage!.id, { tiebreakers: own });
      await putStageRules(auth, stage!.id, { tiebreakers: null });
      const before = await loadTableRules(sql, stage!.id);
      expect(before.sources.tiebreakers, `${s.sport}: premise, the stage inherits and the division keeps none`).toBe("sport");

      // The strip, as the page mounts it (the division's stored config and order, its table kinds).
      const row = await getDivision(auth, d.id);
      const island = renderIsland(
        DivisionRulesStrip,
        stripPropsOf({ division: { id: d.id, sport_key: s.sport, variant_key: row.variant_key, config: row.config as Record<string, unknown>, tiebreakers: row.tiebreakers } }),
        expandRules,
      );
      const order = divisionOrder(m, row.config);
      (propsOf(find(island.tree(), TiebreaksEditor)).onChange as (next: TiebreakerKey[] | null) => void)(order);
      click(island.tree(), "division-tiebreaks-save");
      await vi.waitFor(() => expect(apiV1Mock).toHaveBeenCalled());
      const body = sentPatch(d.id);
      expect(body, `${s.sport}: the strip sends the order, and only the order`).toEqual({ tiebreakers: order });
      await patchDivision(auth, d.id, body);
      const after = await loadTableRules(sql, stage!.id);
      expect(after.tiebreakers, `${s.sport}: the stage resolves the division's new order`).toEqual(order);
      expect(after.sources.tiebreakers).toBe("division");

      // Second save (the sequence): the page re-reads, the organiser picks "Use the sport's order", saves.
      apiV1Mock.mockClear();
      const reread = await getDivision(auth, d.id);
      expect(reread.tiebreakers, "premise: stored").toEqual(order);
      island.rerender(stripPropsOf({ division: { id: d.id, sport_key: s.sport, variant_key: reread.variant_key, config: reread.config as Record<string, unknown>, tiebreakers: reread.tiebreakers } }));
      // "Use the sport's order" is the order list's reset slot (a prop of the list, rendered beside its steps).
      const resets = island.tree().flatMap((e) => walk(propsOf(e).reset as ReactNode));
      click(resets, "division-tiebreaks-sport");
      click(island.tree(), "division-tiebreaks-save");
      await vi.waitFor(() => expect(apiV1Mock).toHaveBeenCalled());
      const back = sentPatch(d.id);
      expect(back).toEqual({ tiebreakers: null });
      await patchDivision(auth, d.id, back);
      const sportAgain = await loadTableRules(sql, stage!.id);
      expect(sportAgain.tiebreakers, `${s.sport}: the sport's order is back`).toEqual(m.defaultTiebreakers("league", m.configSchema.parse(reread.config)));
      expect(sportAgain.sources.tiebreakers).toBe("sport");
      checked++;
    }
    expect(checked, "sports swept").toBe(SPORTS.length);
  });

  it("points: a win box typed and saved on the strip is what an unpinned stage pays; the other points keys ride the save untouched (two sports, counted)", async () => {
    let checked = 0;
    for (const s of SPORTS) {
      const { auth } = await seedOrg("pro");
      const suffix = randomUUID().slice(0, 8);
      const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "C2 pts " + suffix, visibility: "private", branding: {} });
      const d = await createDivision(auth, comp.id, { name: "Open", slug: "open-" + suffix, sport_key: s.sport, variant_key: s.variant, config: s.config });
      const [stage] = await createStages(auth, d.id, { seq: 1, kind: "league", name: "Pool A", config: {}, progression: null });
      const row = await getDivision(auth, d.id);
      const storedPoints = (row.config as { points?: Record<string, number> }).points ?? {};
      const island = renderIsland(
        DivisionRulesStrip,
        stripPropsOf({ division: { id: d.id, sport_key: s.sport, variant_key: row.variant_key, config: row.config as Record<string, unknown>, tiebreakers: row.tiebreakers } }),
        expandRules,
      );
      const editor = find(island.tree(), PointsEditor);
      const value = propsOf(editor).value as Record<string, string>;
      const winKey = ["win", "w"].find((k) => Object.hasOwn(value, k));
      expect(winKey, `${s.sport}: premise, a win box`).toBeDefined();
      const typed = Number(value[winKey!]) + 2;
      (propsOf(editor).onChange as (next: Record<string, string>) => void)({ ...value, [winKey!]: String(typed) });
      click(island.tree(), "division-points-save");
      await vi.waitFor(() => expect(apiV1Mock).toHaveBeenCalled());
      const body = sentPatch(d.id);
      const sentPoints = (body.config as { points: Record<string, unknown> }).points;
      expect(sentPoints[winKey!], `${s.sport}: the typed win`).toBe(typed);
      for (const [k, v] of Object.entries(storedPoints)) if (k !== winKey) expect(sentPoints[k], `${s.sport}: ${k} rides untouched`).toBe(v);
      await patchDivision(auth, d.id, body);
      const rules = await loadTableRules(sql, stage!.id);
      expect(rules.points.win.regulation, `${s.sport}: the stage pays the typed win`).toBe(typed);
      checked++;
    }
    expect(checked, "sports swept").toBe(SPORTS.length);
  });
});

describe.skipIf(!HAS_DB)("Match Day C2: what the builder's Format tab saves round-trips into the Division rules strip", () => {
  it("football: a typed win and a typed order are POSTed, stored, read by the stage on create, and open in the strip as typed", async () => {
    // single-sport: the builder round trip is sport-blind past the points keys, which the strip seam above sweeps.
    const m = mod("football");
    const RAW = m.variants as Record<string, Record<string, unknown>>;
    const rows = Object.keys(RAW).map((key) => ({ sport_key: "football", key, name: key, is_system: true, config: RAW[key]! }));
    const h = renderIsland(DivisionBuilder, {
      competitionId: "c1",
      orgSlug: "org",
      compSlug: "comp",
      sports: sportOptionsFrom([{ key: "football", name: "Football" }], rows),
      constraintsAllowed: true,
      archivedSlotsExplainRefusal: false,
      viewerPlan: "community",
    });
    const points = find(h.tree(), PointsEditor);
    expect(propsOf(points).scope, "premise: the Format tab's Points is the division's").toBe("division");
    const value = propsOf(points).value as Record<string, string>;
    expect(Object.hasOwn(value, "win"), "premise: football keeps a win box").toBe(true);
    const typedWin = Number(value.win) + 2;
    (propsOf(points).onChange as (next: Record<string, string>) => void)({ ...value, win: String(typedWin) });
    // The order is asked of the engine against the config the builder's editor holds (the picked variant's).
    const cfgNow = propsOf(find(h.tree(), TiebreaksEditor)).divisionConfig;
    const order = divisionOrder(m, cfgNow);
    (propsOf(find(h.tree(), TiebreaksEditor)).onChange as (next: TiebreakerKey[] | null) => void)(order);

    // Name -> Scheduling tab -> Create, as the organiser does; the two POSTs captured.
    apiV1Mock.mockImplementation(async (url: string) => (String(url).endsWith("/divisions") ? { id: "d1", slug: "open" } : {}));
    const nameInput = h.tree().find((e) => e.type === "input" && propsOf(e).placeholder === UI["wizard.divisionNamePlaceholder"]);
    (propsOf(nameInput!).onChange as (e: unknown) => void)({ target: { value: "Open" } });
    const button = (label: string) => h.tree().find((e) => e.type === "button" && textOf(e).trim() === label)!;
    (propsOf(button(UI["wizard.tab.scheduling"]!)).onClick as () => void)();
    (propsOf(button(UI["wizard.create"]!)).onClick as () => void)();
    await vi.waitFor(() => expect(apiV1Mock.mock.calls.some(([url]) => String(url).endsWith("/stages"))).toBe(true));
    const divisionBody = apiV1Mock.mock.calls.find(([url]) => String(url).endsWith("/divisions"))![1] as { json: unknown };
    const stagesBody = apiV1Mock.mock.calls.find(([url]) => String(url).endsWith("/stages"))![1] as { json: unknown };

    // The same bodies through the routes' schemas and use cases, on a real database.
    const { auth } = await seedOrg("pro");
    const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "C2 builder " + randomUUID().slice(0, 8), visibility: "private", branding: {} });
    const d = await createDivision(auth, comp.id, CreateDivision.parse(divisionBody.json));
    const stages = await createStages(auth, d.id, CreateStages.parse(stagesBody.json));
    const table = stages.find((st) => ["league", "group", "swiss", "americano"].includes(st.kind));
    expect(table, "premise: the builder's draft keeps a table stage").toBeDefined();
    const rules = await loadTableRules(sql, table!.id);
    expect(rules.tiebreakers, "the stage on the division's order plays the builder's").toEqual(order);
    expect(rules.sources.tiebreakers).toBe("division");
    expect(rules.points.win.regulation, "and pays the builder's win").toBe(typedWin);

    // The page then mounts the strip from what was stored: it opens on what the builder typed.
    const row = await getDivision(auth, d.id);
    const strip = renderIsland(
      DivisionRulesStrip,
      stripPropsOf({ division: { id: d.id, sport_key: "football", variant_key: row.variant_key, config: row.config as Record<string, unknown>, tiebreakers: row.tiebreakers } }),
      expandRules,
    );
    expect((propsOf(find(strip.tree(), PointsEditor)).value as Record<string, string>).win, "the strip's win box").toBe(String(typedWin));
    expect(propsOf(find(strip.tree(), TiebreaksEditor)).value, "the strip's order").toEqual(order);
    expect(propsOf(find(strip.tree(), TiebreaksEditor)).stored, "stored, so nothing to save").toEqual(order);
    expect(strip.tree().some((e) => propsOf(e)["data-testid"] === "division-tiebreaks-save"), "untouched: no Save").toBe(false);
  });
});
