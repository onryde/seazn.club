// BrowserDriver (W1c Task 6): the organiser's actions through the page objects,
// with a fake page-object module injected (no browser) and the http side a
// FakeLeagueDriver — or, where a read must answer a shape the league fake
// cannot (pools, a bracket, a ledger), a stub that refuses every call it was
// not given.
//
// Expected values come from the product's own text (the standings tab's
// TABLE_KINDS, champion.ts BRACKET_KINDS, the public page's revalidate, the
// two finalize paths), the design's wave table (§8), the catalog templates'
// JSON and the harness's catalogue bodies — never from browser-driver.ts.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { LedgerRow } from "../../bench/lib/ledger.ts";
import { FLOOR_MS, SLACK_MS, TAP_PACE_MS } from "../lib/browser/budget.ts";
import { Evidence, type EvidenceFs } from "../lib/browser/evidence.ts";
import { navBudget, type DivisionWhere, type PageCtx } from "../lib/browser/pages/ctx.ts";
import type { StageOut } from "../lib/browser/pages/division-builder.ts";
import { API_ONLY_ROWS, SPORT_KEYS, TEMPLATE_ROW_KEYS, stagesForRow, type RowKey } from "../lib/catalogue.ts";
import {
  BrowserDriver, EMPTY_PADS, FINALIZE_EVENT, ORGANISER_TABLE_KINDS, PUBLIC_BRACKET_KINDS, PUBLIC_REVALIDATE_S, PublicViewNeverFresh,
  compareTables, publicFreshnessMs, type BrowserPages, type Clock, type HttpSide, type PadRegistry,
} from "../lib/driver/browser-driver.ts";
import { DriverMisuse, OrgMismatch, RefusedCall, VisibilityDegraded, type FixtureRow, type OrganiserDriver, type StageRef } from "../lib/driver/types.ts";
import type { CheckResult } from "../lib/results.ts";
import type { CaseSpec } from "../lib/scenarios/types.ts";
import { FakeLeagueDriver } from "./fake-driver.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const src = (rel: string) => readFileSync(resolve(REPO, rel), "utf8");
const ORG_DIV_PAGE = "apps/web/src/app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/page.tsx";
const PUBLIC_DIV_PAGE = "apps/web/src/app/(public)/shared/[orgSlug]/[competitionSlug]/[divisionSlug]/page.tsx";
const ORG = "org-case";
const ORG_SLUG = "m-run-1";
/** What the fake product answers for slugs — deliberately NOT what the scenario asks for. */
const PRODUCT_COMP_SLUG = "matrix-product-slug";
const PRODUCT_DIV_SLUG = "d-product";

/** A `new Set(["a", "b"])` / `new Set([\n "a", ...])` literal's members, read from the product. */
function setLiteral(file: string, name: string): string[] {
  const m = new RegExp(`${name}[^=]*=\\s*new Set\\(\\[([^\\]]*)\\]`).exec(src(file));
  expect(m, `${file} no longer declares ${name}`).not.toBeNull();
  return [...m![1]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]!);
}

function memFs(): EvidenceFs {
  const files = new Map<string, Uint8Array>();
  return {
    mkdir: () => undefined,
    writeFile: (p, d) => { files.set(p, d); },
    readFile: (p) => { const d = files.get(p); if (d === undefined) throw new Error(`absent: ${p}`); return d; },
  };
}

const spec = (row: RowKey, sport = "generic", over: Partial<CaseSpec> = {}): CaseSpec =>
  ({ caseId: `${row}|${sport}|score|LIFECYCLE`, row, sport, variant: "default", scenario: "LIFECYCLE", canary: false, ...over });

/** The stages the product would answer for `row` built from the builder's own bodies. */
function builtFrom(row: RowKey, divisionId = "d1"): StageOut[] {
  return stagesForRow(row).map((b) => ({ id: `s${b.seq}`, division_id: divisionId, seq: b.seq, kind: b.kind, name: b.name, config: b.config, progression: b.progression, status: "pending" }));
}

interface FakePages { pages: BrowserPages; calls: string[]; args: Record<string, unknown[][]> }
function fakePages(over: Partial<BrowserPages> = {}): FakePages {
  const calls: string[] = [];
  const args: Record<string, unknown[][]> = {};
  const base: BrowserPages = {
    createCompetitionUi: async (_c, input) => ({ id: "c1", org_id: ORG, name: input.name, slug: PRODUCT_COMP_SLUG, visibility: "unlisted", status: "draft" }),
    createDivisionUi: async (_c, _slug, compId, input) => ({
      division: { id: "d1", competition_id: compId, name: input.name, slug: PRODUCT_DIV_SLUG, sport_key: input.sportKey, variant_key: input.variantKey, config: {}, status: "draft" },
      stages: builtFrom(input.row),
    }),
    addEntrantsUi: async (_c, _w, es) => es.map((e, i) => ({ id: `e${i + 1}`, display_name: e.displayName, seed: e.seed, status: "registered", kind: e.kind })),
    withdrawUi: async (_c, _w, e) => ({ entrant_id: e.id, status: "withdrawn", policy: "none", walkovers: 0, voided: 0, skipped_finalized: 0 }),
    startUi: async (_c, w) => ({ division_id: w.divisionId, status: "active", started: true, generated: 0 }),
    generateUi: async () => ({ created: 0, existing: 0, fixtures: [] }),
    completeStageUi: async () => ({ completed: true, events: [] }),
    openFixtureUi: async () => undefined,
    forfeitUi: async (_c, f) => [{ seq: 2, status: "forfeited", outcome: null, event_id: `${f.id}-2` }],
    finalizeUi: async (_c, id) => ({ seq: 3, status: "finalized", outcome: null, event_id: `${id}-3` }),
    readStandingsUi: async () => [],
    readPublicUi: async () => ({ tables: [], champion: null }),
  };
  const merged: Record<string, (...a: unknown[]) => unknown> = { ...base, ...over } as unknown as Record<string, (...a: unknown[]) => unknown>;
  const pages = Object.fromEntries(Object.entries(merged).map(([name, fn]) => [name, (...a: unknown[]) => {
    calls.push(name);
    (args[name] ??= []).push(a);
    return fn(...a);
  }])) as unknown as BrowserPages;
  return { pages, calls, args };
}

/** The league fake plus the ledger read HttpDriver adds (Task 6). */
class FakeHttp extends FakeLeagueDriver {
  ledgerRows: LedgerRow[] = [];
  ledger(_fixtureId: string, sinceSeq = 0): Promise<readonly LedgerRow[]> {
    this.log("ledger");
    return Promise.resolve(this.ledgerRows.filter((r) => r.seq > sinceSeq));
  }
}

type Stub = HttpSide & { calls: string[] };
const HTTP_METHODS = [
  "createCompetition", "createDivision", "getDivision", "postStages", "listStages", "addEntrants", "listEntrants", "start", "generate",
  "listFixtures", "fixtureState", "postStream", "forfeit", "withdraw", "completeStage", "rebuild", "standings", "publicStandings",
  "patchDivisionConfig", "replaceStagesProbe", "ledger",
] as const;
/** An http side that answers only what it was given and refuses the rest by name. */
function stubHttp(over: Partial<Record<(typeof HTTP_METHODS)[number], (...a: never[]) => Promise<unknown>>>): Stub {
  const calls: string[] = [];
  const out: Record<string, unknown> = { calls };
  for (const name of HTTP_METHODS) {
    out[name] = (...a: never[]) => {
      calls.push(name);
      const fn = over[name];
      return fn === undefined ? Promise.reject(new Error(`stub: ${name} was not expected`)) : fn(...a);
    };
  }
  Object.defineProperty(out, "callCount", { get: () => calls.length });
  return out as unknown as Stub;
}

function fakeClock(): Clock & { sleeps: number[]; t: number } {
  const c = { t: 0, sleeps: [] as number[], now: () => c.t, sleep: (ms: number) => { c.sleeps.push(ms); c.t += ms; return Promise.resolve(); } };
  return c;
}

interface Made { driver: BrowserDriver; pageCalls: string[]; pageArgs: Record<string, unknown[][]>; defaults: number[]; ctx: PageCtx }
function make<H extends HttpSide>(o: { http: H; spec?: CaseSpec; pages?: Partial<BrowserPages>; padPolicy?: "first" | "all"; pads?: PadRegistry; clock?: Clock }): Made & { http: H } {
  const fp = fakePages(o.pages);
  const defaults: number[] = [];
  const page = { setDefaultTimeout: (ms: number) => { defaults.push(ms); } };
  const ctx: PageCtx = { page: page as unknown as PageCtx["page"], base: "http://localhost:3999", orgSlug: ORG_SLUG, holdMs: 3000, evidence: new Evidence("/report", "case-1", memFs()) };
  const driver = new BrowserDriver({ http: o.http, ctx, spec: o.spec ?? spec("league"), padPolicy: o.padPolicy ?? "first", pads: o.pads ?? EMPTY_PADS, orgId: ORG, pages: fp.pages, clock: o.clock ?? fakeClock() });
  return { driver, http: o.http, pageCalls: fp.calls, pageArgs: fp.args, defaults, ctx };
}
const league = (o: { spec?: CaseSpec; pages?: Partial<BrowserPages>; padPolicy?: "first" | "all"; pads?: PadRegistry } = {}) => make({ ...o, http: new FakeHttp(ORG) });

/** The scenario's own first two calls (common.ts setUpDivision), with the slugs it asks for. */
async function built(d: OrganiserDriver, s: CaseSpec): Promise<{ compId: string; compSlug: string; divId: string; divSlug: string }> {
  const comp = await d.createCompetition({ name: `Matrix ${s.caseId}`, slug: "asked-slug" });
  const div = await d.createDivision(comp.id, { name: `Matrix ${s.sport}`, slug: "d", sportKey: s.sport, variantKey: s.variant, config: {} });
  return { compId: comp.id, compSlug: comp.slug, divId: div.id, divSlug: div.slug };
}

function only(d: BrowserDriver, id: string): CheckResult {
  const found = d.checks().filter((c) => c.id === id);
  expect(found, `checks with id ${id}`).toHaveLength(1);
  return found[0]!;
}
const has = (d: BrowserDriver, id: string) => d.checks().some((c) => c.id === id);

describe("BrowserDriver — the mixed path", () => {
  it("empty case first: a driver that did nothing pushes no check of its own, and its coverage and evidence are vacuous (checked 0 → fail)", () => {
    const { driver } = league();
    const cs = driver.checks();
    expect(cs.map((c) => c.id)).toEqual(["mixed-driver-coverage", "visual-evidence", "no-horizontal-scroll"]);
    expect(cs.map((c) => [c.verdict, c.checked])).toEqual([["fail", 0], ["fail", 0], ["fail", 0]]);
  });

  it("ruling F: the driver bounds its page's default action timeout to one step's budget in the constants, before any action", () => {
    const { defaults } = league();
    expect(defaults).toEqual([Math.max(FLOOR_MS, TAP_PACE_MS + SLACK_MS)]);
  });

  it("a refused UI action throws RefusedCall with the product's code, and the ledger records it as browser — the click happened (Review Focus 4)", async () => {
    const refusal = new RefusedCall("POST", "/api/v1/divisions/d1/start", 422, "SCHEDULE_BLOCKING_CONFLICTS", "blocking conflicts");
    const { driver, http } = league({ pages: { startUi: async () => { throw refusal; } } });
    const { divId } = await built(driver, spec("league"));
    const err = await driver.start(divId).catch((e: unknown) => e);
    expect(err).toBe(refusal);
    expect(err).toBeInstanceOf(RefusedCall);
    expect((err as RefusedCall).code).toBe("SCHEDULE_BLOCKING_CONFLICTS");
    expect(http.calls).not.toContain("start");
    // createCompetition, createDivision and start all ran in the browser.
    expect(only(driver, "mixed-driver-coverage")).toMatchObject({ verdict: "pass", checked: 3 });
    // The one browser run is on record, so the next start goes over http.
    await driver.start(divId).catch(() => undefined);
    expect(http.calls).toContain("start");
  });

  it("first call browser, second http: two generates reach generateUi once and the http side once — under policy all too (all widens only score)", async () => {
    for (const padPolicy of ["first", "all"] as const) {
      const { driver, http, pageCalls } = league({ padPolicy });
      await built(driver, spec("league"));
      await driver.generate("s1");
      await driver.generate("s1");
      expect(pageCalls.filter((c) => c === "generateUi"), padPolicy).toHaveLength(1);
      expect(http.calls.filter((c) => c === "generate"), padPolicy).toHaveLength(1);
    }
  });

  it("reads never touch the page: the eight reads and probes each reach the http side once, and record no action", async () => {
    const { driver, http, pageCalls } = league();
    const reads: [string, () => Promise<unknown>][] = [
      ["getDivision", () => driver.getDivision("d1")],
      ["listStages", () => driver.listStages("d1")],
      ["listEntrants", () => driver.listEntrants("d1")],
      ["listFixtures", () => driver.listFixtures("d1")],
      ["fixtureState", () => driver.fixtureState("f1")],
      ["rebuild", () => driver.rebuild("s1")],
      ["patchDivisionConfig", () => driver.patchDivisionConfig("d1", {})],
      ["replaceStagesProbe", () => driver.replaceStagesProbe("d1", stagesForRow("league"))],
    ];
    let checked = 0;
    for (const [name, call] of reads) {
      const before = http.calls.length;
      await call().catch(() => undefined);
      expect(http.calls.slice(before), name).toEqual([name]);
      checked++;
    }
    expect(checked).toBe(8);
    expect(pageCalls).toEqual([]);
    expect(only(driver, "mixed-driver-coverage").checked).toBe(0);
  });

  it("callCount counts the page actions and the http side's calls", async () => {
    const { driver, http, pageCalls } = league();
    await built(driver, spec("league"));
    await driver.generate("s1");
    await driver.generate("s1");
    expect(pageCalls).toEqual(["createCompetitionUi", "createDivisionUi", "generateUi"]);
    expect(http.callCount).toBe(1);
    expect(driver.callCount).toBe(4);
  });

  it("completeStage twice → DriverMisuse, as HttpDriver: the second never reaches the page or the http side", async () => {
    const { driver, http, pageCalls } = league();
    await built(driver, spec("league"));
    expect(await driver.completeStage("s1")).toEqual({ completed: true, events: [] });
    await expect(driver.completeStage("s1")).rejects.toThrow(DriverMisuse);
    expect(pageCalls.filter((c) => c === "completeStageUi")).toHaveLength(1);
    expect(http.calls).not.toContain("completeStage");
  });

  it("completeStage: a named 4xx refusal committed nothing and stays retryable (over http); an unknown ending is never repeated", async () => {
    const refused = league({ pages: { completeStageUi: async () => { throw new RefusedCall("POST", "/api/v1/stages/s1/complete", 409, "STAGE_NOT_READY", "not ready"); } } });
    await built(refused.driver, spec("league"));
    await expect(refused.driver.completeStage("s1")).rejects.toThrow(RefusedCall);
    await refused.driver.completeStage("s1");
    expect(refused.http.calls).toContain("completeStage");

    for (const thrown of [new RefusedCall("POST", "/api/v1/stages/s1/complete", 502, null, null), new Error("browser: no answer")]) {
      const unknown = league({ pages: { completeStageUi: async () => { throw thrown; } } });
      await built(unknown.driver, spec("league"));
      await expect(unknown.driver.completeStage("s1")).rejects.toBe(thrown);
      await expect(unknown.driver.completeStage("s1"), thrown.message).rejects.toThrow(DriverMisuse);
      expect(unknown.http.calls).not.toContain("completeStage");
    }
  });

  it("guards: an action on a competition, division, stage, entrant or fixture this driver never built is refused by name before any page is touched, and is not recorded", async () => {
    const { driver, pageCalls } = league();
    await expect(driver.start("d1"), "no division yet").rejects.toThrow(DriverMisuse);
    await expect(driver.createDivision("c-unknown", { name: "x", slug: "d", sportKey: "generic", variantKey: "default" })).rejects.toThrow(/c-unknown/);
    const { divId, compId } = await built(driver, spec("league"));
    await expect(driver.start("d-other")).rejects.toThrow(/d-other/);
    await expect(driver.addEntrants("d-other", [{ displayName: "A", seed: 1, kind: "individual" }])).rejects.toThrow(DriverMisuse);
    await expect(driver.generate("s-other")).rejects.toThrow(/s-other/);
    await expect(driver.completeStage("s-other")).rejects.toThrow(DriverMisuse);
    await expect(driver.withdraw("e-nobody")).rejects.toThrow(/e-nobody/);
    await expect(driver.forfeit("f-nobody", "e1", "walkover", "p")).rejects.toThrow(/f-nobody/);
    // The division the organiser builds cannot carry a rule override: refused, never silently dropped.
    const second = league();
    const c2 = await second.driver.createCompetition({ name: "x", slug: "asked" });
    await expect(second.driver.createDivision(c2.id, { name: "x", slug: "d", sportKey: "generic", variantKey: "default", config: { pointsToWin: 15 } })).rejects.toThrow(/override/);
    expect(second.pageCalls).toEqual(["createCompetitionUi"]);
    expect(compId).toBe("c1");
    expect(divId).toBe("d1");
    expect(pageCalls).toEqual(["createCompetitionUi", "createDivisionUi"]);
    // Nothing refused was recorded: only the two creates are on the ledger.
    expect(only(driver, "mixed-driver-coverage")).toMatchObject({ verdict: "pass", checked: 2 });
  });
});

describe("BrowserDriver — creation, from the product's answers (ruling B)", () => {
  it("createCompetition answers the product's slug, never the one asked, and every later page object is pointed at the product's slugs", async () => {
    const { driver, pageArgs } = league();
    const b = await built(driver, spec("league"));
    expect(b).toEqual({ compId: "c1", compSlug: PRODUCT_COMP_SLUG, divId: "d1", divSlug: PRODUCT_DIV_SLUG });
    await driver.start("d1");
    const where = pageArgs.startUi![0]![1] as DivisionWhere;
    expect(where).toEqual({ compSlug: PRODUCT_COMP_SLUG, divSlug: PRODUCT_DIV_SLUG, divisionId: "d1" });
    // The builder was asked for the case's own row, in the product's competition.
    expect(pageArgs.createDivisionUi![0]!.slice(1, 3)).toEqual([PRODUCT_COMP_SLUG, "c1"]);
    expect((pageArgs.createDivisionUi![0]![3] as { row: string }).row).toBe("league");
  });

  it("the UI's competition is checked for its org and its applied visibility, as HttpDriver checks them; a refused one is no competition to build in", async () => {
    const elsewhere = league({ pages: { createCompetitionUi: async (_c, i) => ({ id: "c1", org_id: "org-previous-case", name: i.name, slug: "s", visibility: "unlisted", status: "draft" }) } });
    await expect(elsewhere.driver.createCompetition({ name: "x", slug: "asked" })).rejects.toThrow(OrgMismatch);
    await expect(elsewhere.driver.createDivision("c1", { name: "x", slug: "d", sportKey: "generic", variantKey: "default" })).rejects.toThrow(DriverMisuse);
    const degraded = league({ pages: { createCompetitionUi: async (_c, i) => ({ id: "c1", org_id: ORG, name: i.name, slug: "s", visibility: "private", status: "draft" }) } });
    await expect(degraded.driver.createCompetition({ name: "x", slug: "asked" })).rejects.toThrow(VisibilityDegraded);
  });

  it("builder output equal to the harness's bodies passes with checked = the stage count, and postStages answers the BUILT stages without posting", async () => {
    const bodies = stagesForRow("groups_ko");
    expect(bodies.length).toBeGreaterThan(1);
    const { driver, http } = league({ spec: spec("groups_ko") });
    const { divId } = await built(driver, spec("groups_ko"));
    const out = await driver.postStages(divId, bodies);
    expect(out.map((s) => [s.id, s.seq, s.kind])).toEqual(bodies.map((b) => [`s${b.seq}`, b.seq, b.kind]));
    expect(http.calls).not.toContain("postStages");
    expect(only(driver, "builder-posted-as-harness")).toMatchObject({ verdict: "pass", checked: bodies.length });
    expect(only(driver, "organiser-ui-path")).toMatchObject({ verdict: "pass", checked: 1 });
  });

  // The brief's example (bodies say legs 3, the builder posts 1) is a false
  // premise: the bodies ARE the builder's code (catalogue.ts builderStages →
  // buildTemplateStages), which overwrites every league stage's legs with the
  // legs knob (format-templates.ts buildTemplateStages), so both sides say
  // the same thing and this check cannot see triple_rr's hypothesis (W5 owns
  // it). The shape is kept: the builder posting a legs the bodies do not say.
  it("builder output that differs from the bodies in one config value fails naming the path, and postStages answers what the organiser really got", async () => {
    const bodies = stagesForRow("triple_rr");
    const harnessLegs = bodies[0]!.config.legs as number;
    const builtLegs = harnessLegs + 2;
    const { driver, http } = league({
      spec: spec("triple_rr"),
      pages: { createDivisionUi: async (_c, _s, compId, i) => ({
        division: { id: "d1", competition_id: compId, name: i.name, slug: PRODUCT_DIV_SLUG, sport_key: i.sportKey, variant_key: i.variantKey, config: {}, status: "draft" },
        stages: builtFrom("triple_rr").map((s) => ({ ...s, config: { ...s.config, legs: builtLegs } })),
      }) },
    });
    const { divId } = await built(driver, spec("triple_rr"));
    const out = await driver.postStages(divId, bodies);
    expect(out[0]!.config.legs).toBe(builtLegs);
    expect(http.calls).not.toContain("postStages");
    const c = only(driver, "builder-posted-as-harness");
    expect(c).toMatchObject({ verdict: "fail", checked: 1 });
    expect(c.evidence).toEqual([`stage[1].config.legs: built ${builtLegs}, harness ${harnessLegs}`]);
  });

  it("a stage the builder did not build, or built extra, is named by its seq", async () => {
    const bodies = stagesForRow("groups_ko");
    const { driver } = league({
      spec: spec("groups_ko"),
      pages: { createDivisionUi: async (_c, _s, compId, i) => ({
        division: { id: "d1", competition_id: compId, name: i.name, slug: PRODUCT_DIV_SLUG, sport_key: i.sportKey, variant_key: i.variantKey, config: {}, status: "draft" },
        stages: builtFrom("groups_ko").slice(0, 1),
      }) },
    });
    const { divId } = await built(driver, spec("groups_ko"));
    await driver.postStages(divId, bodies);
    const c = only(driver, "builder-posted-as-harness");
    expect(c).toMatchObject({ verdict: "fail", checked: bodies.length });
    expect(c.evidence).toEqual([`stage[2]: built (none), harness ${bodies[1]!.kind}`]);
  });

  it("the built stages answer ONE postStages: a second one is the harness's own post, over http", async () => {
    const { driver, http } = league();
    const { divId } = await built(driver, spec("league"));
    await driver.postStages(divId, stagesForRow("league"));
    await driver.postStages(divId, stagesForRow("league"));
    expect(http.calls).toEqual(["postStages"]);
  });
});

/** Design §8's wave table, read from the design: each wave's scope terms. */
function designScopes(): Map<string, string[]> {
  const doc = src("docs/superpowers/specs/2026-09-27-format-matrix-design.md");
  const section = doc.slice(doc.indexOf("## 8. Waves"), doc.indexOf("## 9."));
  const rows = [...section.matchAll(/^\| \*\*(W\d+[a-z]?) — [^|]*\| ([^|]*)\|/gm)];
  expect(rows.length).toBeGreaterThanOrEqual(10);
  return new Map(rows.map((m) => [m[1]!, m[2]!.split(",").map((t) => t.trim())]));
}
/** D7 as the plan restates it: the stage shape that makes each API-only row. */
const API_ONLY_SHAPE: Readonly<Record<(typeof API_ONLY_ROWS)[number], string>> = {
  knockout_third_place: "third place", page_playoff_only: "page_playoff", stepladder_only: "stepladder", group_only: "group", group_group_ko: "group",
};
/** The wave whose §8 scope names the row's shape — exactly one must. */
function waveFor(row: (typeof API_ONLY_ROWS)[number], scopes: Map<string, string[]>): string {
  const owners = [...scopes].filter(([, terms]) => terms.includes(API_ONLY_SHAPE[row])).map(([w]) => w);
  expect(owners, `${row}: waves whose §8 scope names ${API_ONLY_SHAPE[row]}`).toHaveLength(1);
  return owners[0]!;
}

interface CatalogStage { kind: string; config?: Record<string, unknown>; [k: string]: unknown }
/** The (row, sport) cells a catalog template reaches although no builder row
 *  does, read from the catalog JSON: its stage kinds are the row's, and where a
 *  builder row shares those kinds, it also carries every config value that
 *  tells the API-only body apart from that row's (knockout_third_place's
 *  thirdPlace). */
function templateOnlyCells(): Record<string, string> {
  const dir = resolve(REPO, "apps/web/src/server/templates/catalog");
  const kinds = (xs: readonly { kind: string }[]) => JSON.stringify(xs.map((s) => s.kind));
  const out: Record<string, string> = {};
  let templates = 0;
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".json")).sort()) {
    const t = JSON.parse(readFileSync(join(dir, f), "utf8")) as { key: string; divisions: { sportKey: string; stages: CatalogStage[] }[] };
    templates++;
    for (const d of t.divisions) {
      for (const row of API_ONLY_ROWS) {
        const want = stagesForRow(row);
        if (kinds(d.stages) !== kinds(want)) continue;
        const twins = TEMPLATE_ROW_KEYS.filter((r) => kinds(stagesForRow(r)) === kinds(want));
        const tellsApart = twins.every((twin) => want.every((w, i) => {
          const other = stagesForRow(twin)[i]!.config;
          return Object.entries(w.config).every(([k, v]) => JSON.stringify(other[k]) === JSON.stringify(v)
            || JSON.stringify(d.stages[i]!.config?.[k] ?? d.stages[i]![k]) === JSON.stringify(v));
        }));
        if (tellsApart) out[`${row}|${d.sportKey}`] = t.key;
      }
    }
  }
  expect(templates).toBeGreaterThan(0);
  return out;
}

describe("BrowserDriver — API-only rows (D7)", () => {
  it("every API-only row × sport: created over http, organiser-ui-path fails naming the wave design §8 gives it, the two template-only cells abstain, and coverage exempts createDivision", async () => {
    const scopes = designScopes();
    const cells = templateOnlyCells();
    expect(cells).toEqual({ "group_only|badminton": "box-league", "group_group_ko|cricket": "t20-super8" });
    let checked = 0;
    let abstained = 0;
    for (const row of API_ONLY_ROWS) {
      const wave = waveFor(row, scopes);
      for (const sport of SPORT_KEYS) {
        const http = stubHttp({ createDivision: async (...a: never[]) => {
          const i = a[1] as { sportKey: string; variantKey: string };
          return { id: "d9", slug: "d-api", sportKey: i.sportKey, variantKey: i.variantKey, config: {} };
        } });
        const { driver, pageCalls } = make({ http, spec: spec(row, sport) });
        const b = await built(driver, spec(row, sport));
        expect(b.divSlug).toBe("d-api");
        expect(pageCalls, `${row}|${sport}`).toEqual(["createCompetitionUi"]);
        expect(http.calls, `${row}|${sport}`).toEqual(["createDivision"]);
        const ui = only(driver, "organiser-ui-path");
        const tmpl = cells[`${row}|${sport}`];
        if (tmpl === undefined) {
          expect(ui, `${row}|${sport}`).toMatchObject({ verdict: "fail", checked: 1, evidence: [`no organiser control builds ${row} → ${wave}`] });
        } else {
          expect(ui, `${row}|${sport}`).toMatchObject({ verdict: "abstain", checked: 0, reason: `reachable only through catalog template ${tmpl}; driving it → W1-driving` });
          abstained++;
        }
        const text = tmpl === undefined ? `no organiser control builds ${row} → ${wave}` : ui.reason;
        expect(only(driver, "mixed-driver-coverage"), `${row}|${sport}`).toMatchObject({ verdict: "pass", checked: 2, evidence: [`createDivision: exempt — ${text}`] });
        // The http-built division is the one every later page object acts in.
        const bs = await driver.postStages("d9", stagesForRow(row)).catch((e: unknown) => e);
        expect(bs).toBeInstanceOf(Error);
        expect(http.calls.at(-1)).toBe("postStages");
        checked++;
      }
    }
    expect(checked).toBe(API_ONLY_ROWS.length * SPORT_KEYS.length);
    expect(checked).toBeGreaterThan(0);
    expect(abstained).toBe(Object.keys(cells).length);
  });

  it("the §8 lookup has teeth: W4's scope names the knockout family's shapes and not the group's", () => {
    const scopes = designScopes();
    expect(scopes.get("W4")).toEqual(expect.arrayContaining(["third place", "page_playoff", "stepladder"]));
    expect(scopes.get("W4")).not.toContain("group");
    expect(scopes.get("W5")).toContain("group");
  });
});

// Standings: the http side answers the tables, and the page must draw them.
const ENTRANTS = [
  { id: "e1", display_name: "Ann", seed: 1, status: "registered" },
  { id: "e2", display_name: "Bob", seed: 2, status: "registered" },
  { id: "e3", display_name: "Cat", seed: 3, status: "registered" },
  { id: "e4", display_name: "Dan", seed: 4, status: "registered" },
];
const fixture = (id: string, stage: string, pool: string | null, no: number | null = 1): FixtureRow =>
  ({ id, stage_id: stage, pool_id: pool, round_no: 1, fixture_no: no, home_entrant_id: "e1", away_entrant_id: "e2", status: "scheduled", outcome: null });
const stageRef = (id: string, seq: number, kind: string): StageRef => ({ id, seq, kind, config: {}, status: "active" });
const rows = (...ids: string[]) => ids.map((entrantId, i) => ({ entrantId, rank: i + 1 }));
const uiRows = (...names: string[]) => ({ rows: names.map((name, i) => ({ rank: i + 1, name })) });

/** A group stage with two pools: p1 = Ann, Bob; p2 = Cat, Dan. */
function groupHttp(): Stub {
  return stubHttp({
    listStages: async () => [stageRef("s1", 1, "group")],
    listEntrants: async () => ENTRANTS,
    listFixtures: async () => [fixture("f1", "s1", "p1"), fixture("f2", "s1", "p2", 2)],
    standings: async (...a: never[]) => {
      const pool = a[1] as string | null;
      return { stage_id: "s1", pool_id: pool, rows: pool === "p1" ? rows("e2", "e1") : rows("e3", "e4") };
    },
  });
}

describe("BrowserDriver — the organiser standings tab", () => {
  it("every table the page draws matches the API table with the same members, whatever order the page draws the pools in (ruling E)", async () => {
    const { driver, http, pageCalls } = make({ http: groupHttp(), spec: spec("groups_ko"), pages: { readStandingsUi: async () => [uiRows("Cat", "Dan"), uiRows("Bob", "Ann")] } });
    await built(driver, spec("groups_ko"));
    const out = await driver.standings("s1", "p1");
    expect(out.rows).toEqual(rows("e2", "e1"));
    expect(pageCalls.filter((c) => c === "readStandingsUi")).toHaveLength(1);
    expect(only(driver, "ui-standings-match")).toMatchObject({ verdict: "pass", checked: 2 });
    // The second read is the data alone: no page, no second check.
    const before = pageCalls.length;
    await driver.standings("s1", "p2");
    expect(pageCalls.length).toBe(before);
    expect(http.calls.filter((c) => c === "standings").length).toBeGreaterThanOrEqual(3);
    expect(only(driver, "mixed-driver-coverage").evidence).toEqual([]);
  });

  it("a different order inside a pool, a pool the page does not draw, or a table the API has no pool for each fail by name", async () => {
    const cases: [string, ReturnType<typeof uiRows>[], RegExp][] = [
      ["order", [uiRows("Ann", "Bob"), uiRows("Cat", "Dan")], /page order 1 Ann, 2 Bob; API order 1 Bob, 2 Ann/],
      ["missing", [uiRows("Bob", "Ann")], /the page draws no table with its 2 entrant\(s\) \(Cat, Dan\)/],
      ["extra", [uiRows("Bob", "Ann"), uiRows("Cat", "Dan"), uiRows("Ann", "Cat")], /page table #3 \(Ann, Cat\) matches no API table/],
    ];
    for (const [name, ui, want] of cases) {
      const { driver } = make({ http: groupHttp(), spec: spec("groups_ko"), pages: { readStandingsUi: async () => ui } });
      await built(driver, spec("groups_ko"));
      await driver.standings("s1", "p1");
      const c = only(driver, "ui-standings-match");
      expect(c.verdict, name).toBe("fail");
      expect(c.evidence.join("\n"), name).toMatch(want);
    }
  });

  it("a division with no table stage: no table on the page abstains naming the kind (false premise 2); a table there anyway fails", async () => {
    const ko = () => stubHttp({
      listStages: async () => [stageRef("s1", 1, "knockout")],
      listEntrants: async () => ENTRANTS,
      listFixtures: async () => [fixture("f1", "s1", null)],
      standings: async () => ({ stage_id: "s1", pool_id: null, rows: rows("e1", "e2") }),
    });
    const none = make({ http: ko(), spec: spec("knockout") });
    await built(none.driver, spec("knockout"));
    await none.driver.standings("s1", null);
    expect(only(none.driver, "ui-standings-match")).toMatchObject({ verdict: "abstain", checked: 0, reason: "no organiser table for knockout" });
    const drawn = make({ http: ko(), spec: spec("knockout"), pages: { readStandingsUi: async () => [uiRows("Ann", "Bob")] } });
    await built(drawn.driver, spec("knockout"));
    await drawn.driver.standings("s1", null);
    expect(only(drawn.driver, "ui-standings-match").verdict).toBe("fail");
  });

  it("the table kinds are the organiser page's own TABLE_KINDS (text pin)", () => {
    expect([...ORGANISER_TABLE_KINDS].sort()).toEqual(setLiteral(ORG_DIV_PAGE, "TABLE_KINDS").sort());
    expect(ORGANISER_TABLE_KINDS.size).toBeGreaterThan(0);
  });
});

describe("compareTables — pairing by the product's own identity, pool membership", () => {
  it("two tables with the same members are judged as a multiset: either pairing agrees, and a real difference still reds", () => {
    const api = [{ label: "a", rows: uiRows("Ann", "Bob").rows }, { label: "b", rows: uiRows("Bob", "Ann").rows }];
    expect(compareTables(api, [uiRows("Bob", "Ann"), uiRows("Ann", "Bob")])).toMatchObject({ ok: true, checked: 2 });
    expect(compareTables(api, [uiRows("Ann", "Bob"), uiRows("Ann", "Bob")]).ok).toBe(false);
  });
  it("empty case: nothing on either side is nothing checked", () => {
    expect(compareTables([], [])).toEqual({ ok: true, checked: 0, evidence: [] });
  });
  it("rows are compared in the page's rank order: the API's rows sorted by rank as StandingsTable sorts them (public-site/standings-table.tsx, which both pages draw)", () => {
    const api = [{ label: "a", rows: [{ rank: 2, name: "Bob" }, { rank: 1, name: "Ann" }] }];
    expect(compareTables(api, [uiRows("Ann", "Bob")]).ok).toBe(true);
    expect(src("apps/web/src/components/public-site/standings-table.tsx")).toContain("(a.rank ?? 99) - (b.rank ?? 99)");
  });
});

describe("BrowserDriver — the public view (ruling C)", () => {
  const pub = (o: { kind?: string; standings?: { stage_id: string; pool_id: string | null; rows: { entrantId: string; rank: number }[] }[] } = {}) => stubHttp({
    listStages: async () => [stageRef("s1", 1, o.kind ?? "league")],
    listEntrants: async () => ENTRANTS,
    publicStandings: async () => ({ division_id: "d1", standings: o.standings ?? [{ stage_id: "s1", pool_id: null, rows: rows("e1", "e2") }] }),
  });
  const ref = (b: { compSlug: string; divSlug: string }) => ({ orgSlug: ORG_SLUG, competitionSlug: b.compSlug, divisionSlug: b.divSlug });

  it("the page's revalidate, the bracket kinds and the deadline are the product's (text pins), and the deadline is derived from them", () => {
    const m = /export const revalidate = (\d+);/.exec(src(PUBLIC_DIV_PAGE));
    expect(m).not.toBeNull();
    expect(PUBLIC_REVALIDATE_S).toBe(Number(m![1]));
    expect([...PUBLIC_BRACKET_KINDS].sort()).toEqual(setLiteral("apps/web/src/server/public-site/champion.ts", "BRACKET_KINDS").sort());
    for (const holdMs of [500, 3000, 10_000]) expect(publicFreshnessMs({ holdMs })).toBe(Math.max(FLOOR_MS, Number(m![1]) * 1000 + navBudget({ holdMs })));
  });

  it("a stale page is read again, SLACK_MS apart, until it matches — the stale read is never the verdict", async () => {
    const clock = fakeClock();
    let reads = 0;
    const { driver, pageCalls } = make({ http: pub(), clock, pages: { readPublicUi: async () => ({ tables: [++reads === 1 ? uiRows("Bob", "Ann") : uiRows("Ann", "Bob")], champion: null }) } });
    const b = await built(driver, spec("league"));
    const out = await driver.publicStandings(ref(b));
    expect(out.standings).toHaveLength(1);
    expect(pageCalls.filter((c) => c === "readPublicUi")).toHaveLength(2);
    expect(clock.sleeps).toEqual([SLACK_MS]);
    expect(only(driver, "ui-public-standings-match")).toMatchObject({ verdict: "pass", checked: 1 });
    expect(only(driver, "ui-champion-shown")).toMatchObject({ verdict: "abstain" });
    // A second public read is the data alone.
    await driver.publicStandings(ref(b));
    expect(pageCalls.filter((c) => c === "readPublicUi")).toHaveLength(2);
  });

  it("a page that never matches within the deadline is a NAMED refusal, not a mismatch verdict, and names what still differed", async () => {
    const clock = fakeClock();
    let reads = 0;
    const { driver, ctx } = make({ http: pub(), clock, pages: { readPublicUi: async () => { reads++; clock.t += 1000; return { tables: [uiRows("Bob", "Ann")], champion: null }; } } });
    const b = await built(driver, spec("league"));
    const err = await driver.publicStandings(ref(b)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PublicViewNeverFresh);
    const e = err as PublicViewNeverFresh;
    expect(e.ms).toBe(publicFreshnessMs(ctx));
    expect(e.attempts).toBe(reads);
    expect(reads * (1000 + SLACK_MS)).toBeGreaterThanOrEqual(e.ms);
    expect(e.message).toMatch(/page order 1 Bob, 2 Ann; API order 1 Ann, 2 Bob/);
    expect(has(driver, "ui-public-standings-match")).toBe(false);
  });

  it("a guard: the public ref must be this driver's org and the product's own slugs", async () => {
    const { driver } = make({ http: pub() });
    const b = await built(driver, spec("league"));
    await expect(driver.publicStandings({ ...ref(b), orgSlug: "another-org" })).rejects.toThrow(DriverMisuse);
    await expect(driver.publicStandings({ orgSlug: ORG_SLUG, competitionSlug: "asked-slug", divisionSlug: "d" })).rejects.toThrow(DriverMisuse);
  });

  it("the champion: after this case completed its bracket stage, the banner must name finalRanks[0]; before completion it abstains", async () => {
    const complete = { completed: true, events: [{ type: "stage_completed", finalRanks: ["e2", "e1"] }] };
    const clock = fakeClock();
    let reads = 0;
    const crowned = make({ http: pub({ kind: "knockout", standings: [] }), spec: spec("knockout"), clock, pages: {
      completeStageUi: async () => complete,
      readPublicUi: async () => ({ tables: [], champion: ++reads === 1 ? null : "Bob" }),
    } });
    const b = await built(crowned.driver, spec("knockout"));
    await crowned.driver.completeStage("s1");
    await crowned.driver.publicStandings(ref(b));
    expect(only(crowned.driver, "ui-champion-shown")).toMatchObject({ verdict: "pass", checked: 1 });
    expect(reads).toBe(2);
    expect(only(crowned.driver, "ui-public-standings-match")).toMatchObject({ verdict: "abstain", checked: 0 });

    const early = make({ http: pub({ kind: "knockout", standings: [] }), spec: spec("knockout"), pages: { readPublicUi: async () => ({ tables: [], champion: null }) } });
    const b2 = await built(early.driver, spec("knockout"));
    await early.driver.publicStandings(ref(b2));
    expect(only(early.driver, "ui-champion-shown")).toMatchObject({ verdict: "abstain", checked: 0 });
  });

  it("the champion: a wrong banner never becomes the verdict (named refusal); a completion with no finalRanks fails by name; a table stage abstains", async () => {
    const wrong = make({ http: pub({ kind: "knockout", standings: [] }), spec: spec("knockout"), pages: {
      completeStageUi: async () => ({ completed: true, events: [{ type: "stage_completed", finalRanks: ["e2", "e1"] }] }),
      readPublicUi: async () => ({ tables: [], champion: "Ann" }),
    } });
    const b = await built(wrong.driver, spec("knockout"));
    await wrong.driver.completeStage("s1");
    await expect(wrong.driver.publicStandings(ref(b))).rejects.toThrow(/banner names Ann; want Bob/);

    const noRanks = make({ http: pub({ kind: "knockout", standings: [] }), spec: spec("knockout"), pages: { completeStageUi: async () => ({ completed: true, events: [] }) } });
    const b2 = await built(noRanks.driver, spec("knockout"));
    await noRanks.driver.completeStage("s1");
    await noRanks.driver.publicStandings(ref(b2));
    expect(only(noRanks.driver, "ui-champion-shown")).toMatchObject({ verdict: "fail", checked: 1 });

    const table = make({ http: pub(), pages: { readPublicUi: async () => ({ tables: [uiRows("Ann", "Bob")], champion: "Ann" }) } });
    const b3 = await built(table.driver, spec("league"));
    await table.driver.completeStage("s1");
    await table.driver.publicStandings(ref(b3));
    expect(only(table.driver, "ui-champion-shown")).toMatchObject({ verdict: "abstain", checked: 0 });
  });
});

describe("BrowserDriver — forfeit and finalize on the console", () => {
  const consoleHttp = (ledgerRows: LedgerRow[], no: number | null = 4) => {
    let state = 0;
    return stubHttp({
      listFixtures: async () => [fixture("f1", "s1", null, no)],
      fixtureState: async () => (state++ === 0 ? { status: "decided", last_seq: 2, outcome: null } : { status: "finalized", last_seq: 3, outcome: null }),
      ledger: async (...a: never[]) => ledgerRows.filter((r) => r.seq > (a[1] as number)),
    });
  };

  it("finalize taps the console and proves the ledger row it left: ONE core.finalize after the tip — the row HttpDriver's route leaves too (ruling D)", async () => {
    const http = consoleHttp([{ id: "r3", seq: 3, type: FINALIZE_EVENT, payload: {} }]);
    const { driver, pageArgs } = make({ http });
    await built(driver, spec("league"));
    expect(await driver.finalize("f1")).toEqual({ status: "finalized", last_seq: 3, outcome: null });
    expect(pageArgs.openFixtureUi![0]![2]).toBe(4);
    expect(only(driver, "finalize-ledger-row")).toMatchObject({ verdict: "pass", checked: 1 });
    // Both paths append the same row: the console's Finalize and the route's usecase.
    expect(src("apps/web/src/components/v2/fixture-console.tsx")).toContain(`send("${FINALIZE_EVENT}", {})`);
    const usecase = src("apps/web/src/server/usecases/scoring.ts");
    expect(usecase.slice(usecase.indexOf("export async function finalizeFixture"))).toMatch(new RegExp(`type: "${FINALIZE_EVENT.replace(".", "\\.")}"`));
  });

  it("no row, the wrong row, or two rows after the tip each fail by name", async () => {
    const cases: [string, LedgerRow[], RegExp][] = [
      ["none", [], /f1: 0 ledger rows after seq 2/],
      ["wrong", [{ id: "r3", seq: 3, type: "core.start", payload: {} }], /f1: seq 3 is core\.start/],
      ["two", [{ id: "r3", seq: 3, type: FINALIZE_EVENT, payload: {} }, { id: "r4", seq: 4, type: FINALIZE_EVENT, payload: {} }], /f1: 2 ledger rows after seq 2/],
    ];
    for (const [name, ledgerRows, want] of cases) {
      const { driver } = make({ http: consoleHttp(ledgerRows) });
      await built(driver, spec("league"));
      await driver.finalize("f1");
      const c = only(driver, "finalize-ledger-row");
      expect(c.verdict, name).toBe("fail");
      expect(c.evidence.join("\n"), name).toMatch(want);
    }
  });

  it("forfeit opens the fixture's console by its number and answers the console's events; a fixture with no number is refused by name", async () => {
    const { driver, pageArgs, pageCalls } = make({ http: consoleHttp([]) });
    await built(driver, spec("league"));
    const posted = await driver.forfeit("f1", "e2", "walkover", "p");
    expect(posted.map((p) => p.status)).toEqual(["forfeited"]);
    expect(pageArgs.openFixtureUi![0]![2]).toBe(4);
    expect(pageArgs.forfeitUi![0]!.slice(2)).toEqual(["e2", "walkover"]);
    expect(pageCalls.slice(-2)).toEqual(["openFixtureUi", "forfeitUi"]);
    const unnumbered = make({ http: consoleHttp([], null) });
    await built(unnumbered.driver, spec("league"));
    await expect(unnumbered.driver.forfeit("f1", "e2", "walkover", "p")).rejects.toThrow(/no fixture number/);
    await expect(unnumbered.driver.finalize("f1")).rejects.toThrow(/no fixture number/);
  });

  it("withdraw finds the entrant's display name over http and withdraws it on the page", async () => {
    const http = stubHttp({ listEntrants: async () => ENTRANTS });
    const { driver, pageArgs } = make({ http });
    await built(driver, spec("league"));
    await driver.withdraw("e3");
    expect(pageArgs.withdrawUi![0]![2]).toEqual({ id: "e3", displayName: "Cat" });
  });
});

describe("BrowserDriver — the pad branch (Task 7 fills it)", () => {
  it("a sport with a pad under a browser-wanting policy is refused by name until Task 7; without a pad the score goes over http, and coverage reds score by name", async () => {
    const padded = league({ pads: { generic: {} } });
    await expect(padded.driver.postStream("f1", [], "p")).rejects.toThrow(/Task 7/);
    expect(padded.http.calls).not.toContain("postStream");

    const bare = make({ http: stubHttp({ postStream: async () => [] }) });
    expect(await bare.driver.postStream("f1", [], "p")).toEqual([]);
    expect(bare.http.calls).toEqual(["postStream"]);
    expect(only(bare.driver, "mixed-driver-coverage")).toMatchObject({ verdict: "fail", checked: 1, evidence: ["score: invoked 1×, never in the browser"] });
  });
});
