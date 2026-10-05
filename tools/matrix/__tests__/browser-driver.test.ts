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
import { selectorForTapStep } from "../../bench/lib/drivers/scorer.ts";
import type { LedgerRow } from "../../bench/lib/ledger.ts";
import { FLOOR_MS, SLACK_MS, TAP_PACE_MS } from "../lib/browser/budget.ts";
import { Evidence, type EvidenceFs } from "../lib/browser/evidence.ts";
import { navBudget, type DivisionWhere, type PageCtx } from "../lib/browser/pages/ctx.ts";
import type { StageOut } from "../lib/browser/pages/division-builder.ts";
import type { EntrantIn } from "../lib/browser/pages/entrants.ts";
import { API_ONLY_UI_WAVE } from "../lib/api-only-ui.ts";
import { API_ONLY_ROWS, SPORT_KEYS, TEMPLATE_ROW_KEYS, stagesForRow, type RowKey } from "../lib/catalogue.ts";
import {
  BrowserDriver, EMPTY_PADS, FINALIZE_EVENT, ORGANISER_TABLE_KINDS, OVERRIDE_ROUTE, PUBLIC_BRACKET_KINDS, PUBLIC_DATA_REVALIDATE_S, PUBLIC_REVALIDATE_S,
  compareTables, publicFreshnessMs, type BrowserPages, type Clock, type HttpSide, type PadRegistry, type Replay,
} from "../lib/driver/browser-driver.ts";
import { DriverMisuse, NoOrganiserPath, OrgMismatch, RefusedCall, SEEDING_FAILED_AFTER_COMMIT, VisibilityDegraded, type FixtureRow, type FixtureStateOut, type FromTemplateAnswer, type GenerateOut, type OrganiserDriver, type StageRef } from "../lib/driver/types.ts";
import { fieldSizeFor } from "../lib/field-size.ts";
import { builtAsPosted } from "../lib/scenarios/assertions.ts";
import { Recorder, TEMPLATE_ENDS_ON, playStage, setUpDivision } from "../lib/scenarios/common.ts";
import { resolveSportCfg } from "../lib/sport-cfg.ts";
import { noPadReason } from "../lib/pad-sports.ts";
import { CRICKET_FOLLOW_ON, CRICKET_MATCH_CLOSE, CRICKET_NO_CONTROL, CRICKET_SUMMARY, cricketPad } from "../lib/pads/cricket.ts";
import { genericPad } from "../lib/pads/generic.ts";
import { PAD_ADAPTERS } from "../lib/pads/index.ts";
import { replayEvents, type ReplayDeps, type ReplayResult } from "../lib/pads/replay.ts";
import type { StreamEvent } from "../lib/streams/types.ts";
import { findSecrets } from "../lib/redact.ts";
import type { CheckResult } from "../lib/results.ts";
import type { CaseSpec } from "../lib/scenarios/types.ts";
import { PAD_INNINGS_SET, padInningsPlanner } from "../lib/pad-innings-set.ts";
import { SCENARIOS } from "../lib/scenarios/index.ts";
import { offlineBuilderDefault } from "../lib/variants.ts";
import { FakeLeagueDriver, type FakeFixture } from "./fake-driver.ts";
import { modelPage, twoInningsModel } from "./pad-model.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const src = (rel: string) => readFileSync(resolve(REPO, rel), "utf8");
const ORG_DIV_PAGE = "apps/web/src/app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/page.tsx";
const PUBLIC_DIV_PAGE = "apps/web/src/app/(public)/shared/[orgSlug]/[competitionSlug]/[divisionSlug]/page.tsx";
const ORG = "org-case";
const ORG_SLUG = "m-run-1";
/** What the fake product answers for slugs — deliberately NOT what the scenario asks for. */
const PRODUCT_COMP_SLUG = "matrix-product-slug";
const PRODUCT_DIV_SLUG = "d-product";
/** Ruling 47 (_INDEX.md): the wave rule-override driving in the browser goes to, read from the index. */
function ruling47OverrideWave(): string {
  const index = src("docs/superpowers/specs/2026-09-27-format-matrix-prompts/_INDEX.md").replace(/\s+/g, " ");
  const w = /Rule-override driving in the browser \(`OVERRIDE_WAVE`[^)]*\) goes to \*\*(W[\w-]+)\*\*/.exec(index)?.[1];
  expect(w, "ruling 47 no longer names the wave rule-override driving goes to").toBeDefined();
  return w!;
}

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
    createFromTemplateUi: async () => { throw new Error("fake pages: createFromTemplateUi was not given (the test drives no card)"); },
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
    voidLastUi: async (_c, id) => ({ seq: 4, status: "in_play", outcome: null, event_id: `${id}-4` }),
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
  override ledger(_fixtureId: string, sinceSeq = 0): Promise<readonly LedgerRow[]> {
    this.log("ledger");
    return Promise.resolve(this.ledgerRows.filter((r) => r.seq > sinceSeq));
  }
}

type Stub = HttpSide & { calls: string[] };
const HTTP_METHODS = [
  "createCompetition", "createDivision", "getDivision", "postStages", "listStages", "addEntrants", "listEntrants", "start", "generate",
  "listFixtures", "fixtureState", "postStream", "forfeit", "withdraw", "completeStage", "rebuild", "standings", "publicStandings",
  "patchDivisionConfig", "replaceStagesProbe", "ledger", "entrantMembers", "putLineup", "setMembers", "createFromTemplate", "readBackTemplate",
  "voidLast", "scheduleFixtureNow", "divisionPhase",
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
function make<H extends HttpSide>(o: { http: H; spec?: CaseSpec; pages?: Partial<BrowserPages>; padPolicy?: "first" | "all"; pads?: PadRegistry; clock?: Clock; replay?: Replay; page?: object }): Made & { http: H } {
  const fp = fakePages(o.pages);
  const defaults: number[] = [];
  const page = { ...o.page, setDefaultTimeout: (ms: number) => { defaults.push(ms); } };
  const ctx: PageCtx = { page: page as unknown as PageCtx["page"], base: "http://localhost:3999", orgSlug: ORG_SLUG, holdMs: 3000, evidence: new Evidence("/report", "case-1", memFs()) };
  const driver = new BrowserDriver({ http: o.http, ctx, spec: o.spec ?? spec("league"), padPolicy: o.padPolicy ?? "first", pads: o.pads ?? EMPTY_PADS, orgId: ORG, pages: fp.pages, clock: o.clock ?? fakeClock(), ...(o.replay === undefined ? {} : { replay: o.replay }) });
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

  // O-1 (W1c Task 8 review, fix round 1): a case's first generate follows
  // Start, which for a league has seeded every fixture, so it creates nothing.
  // Sending only that call to the browser left generateUi's create-fixtures
  // branch never run live. generate now keeps the browser's turn until a
  // browser call CREATED fixtures.
  it("O-1: generate stays in the browser until a browser generate creates fixtures — the no-op after Start leaves the next in the browser; after a creating one, http — under policy all too", async () => {
    for (const padPolicy of ["first", "all"] as const) {
      const answers: GenerateOut[] = [
        { created: 0, existing: 2, fixtures: [] },
        { created: 1, existing: 2, fixtures: [{ fixture_no: 3 } as FixtureRow] },
      ];
      const { driver, http, pageCalls } = league({ padPolicy, pages: { generateUi: async () => answers.shift()! } });
      // The policy the driver was built with is the one it reports (read by the runner's wiring test).
      expect(driver.padPolicy).toBe(padPolicy);
      await built(driver, spec("league"));
      await driver.generate("s1"); // the no-op: browser
      expect(pageCalls.filter((c) => c === "generateUi"), padPolicy).toHaveLength(1);
      await driver.generate("s1"); // still browser: it creates one
      expect(pageCalls.filter((c) => c === "generateUi"), padPolicy).toHaveLength(2);
      await driver.generate("s1"); // the create path ran: http from here
      expect(pageCalls.filter((c) => c === "generateUi"), padPolicy).toHaveLength(2);
      expect(http.calls.filter((c) => c === "generate"), padPolicy).toHaveLength(1);
      expect(answers, padPolicy).toEqual([]);
      expect(only(driver, "mixed-driver-coverage").evidence, padPolicy).toEqual([expect.stringMatching(/^generate: .* ran in the browser — 1 of 2 browser call\(s\) created$/)]);
    }
  });

  it("O-1, the league's own shape: every generate a no-op keeps each in the browser, and coverage notes the create path never ran — still a pass", async () => {
    const { driver, http, pageCalls } = league();
    await built(driver, spec("league"));
    for (let i = 0; i < 3; i++) await driver.generate("s1");
    expect(pageCalls.filter((c) => c === "generateUi")).toHaveLength(3);
    expect(http.calls).not.toContain("generate");
    expect(only(driver, "mixed-driver-coverage")).toMatchObject({ verdict: "pass", checked: 3, evidence: [expect.stringMatching(/^generate: .* never ran in the browser — 3 browser call\(s\), none created/)] });
  });

  it("O-1: a browser generate the page refused created nothing — the next one is the browser's again", async () => {
    const refusal = new RefusedCall("POST", "/api/v1/stages/s1/generate", 409, "STAGE_LOCKED", "locked");
    let calls = 0;
    const { driver, http, pageCalls } = league({ pages: { generateUi: async () => { calls++; if (calls === 1) throw refusal; return { created: 2, existing: 0, fixtures: [{ fixture_no: 1 } as FixtureRow, { fixture_no: 2 } as FixtureRow] }; } } });
    await built(driver, spec("league"));
    await expect(driver.generate("s1")).rejects.toBe(refusal);
    await driver.generate("s1");
    await driver.generate("s1");
    expect(pageCalls.filter((c) => c === "generateUi")).toHaveLength(2);
    expect(http.calls.filter((c) => c === "generate")).toHaveLength(1);
  });

  // M-3 (fix round 1): addEntrantsUi returns [] at once for no entrants
  // (entrants.ts), so recording that as a browser run would pass coverage on a
  // type that never clicked and send every later add over http.
  it("an empty addEntrants is no click: the http side answers it unrecorded, and the next real add still takes the browser's turn", async () => {
    const { driver, http, pageCalls } = league();
    const b = await built(driver, spec("league"));
    expect(await driver.addEntrants(b.divId, [])).toEqual([]);
    expect(pageCalls.filter((c) => c === "addEntrantsUi")).toHaveLength(0);
    expect(http.calls.filter((c) => c === "addEntrants")).toHaveLength(1);
    // Nothing recorded: the ledger still counts only the two creates.
    expect(only(driver, "mixed-driver-coverage")).toMatchObject({ verdict: "pass", checked: 2 });
    // Second call, a real one: the page gets it.
    await driver.addEntrants(b.divId, [{ displayName: "Ann", seed: 1, kind: "individual" }]);
    expect(pageCalls.filter((c) => c === "addEntrantsUi")).toHaveLength(1);
    expect(only(driver, "mixed-driver-coverage")).toMatchObject({ verdict: "pass", checked: 3 });
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
    // A creating generate, so the second one is the http side's (O-1).
    const { driver, http, pageCalls } = league({ pages: { generateUi: async () => ({ created: 1, existing: 0, fixtures: [{ fixture_no: 1 } as FixtureRow] }) } });
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

  it("W1-driving T6 (FP-3): a 409 STAGE_COMPLETED_SEEDING_FAILED followed a COMMITTED completion, so it is never repeated (over the page or http)", async () => {
    const committed = league({ pages: { completeStageUi: async () => { throw new RefusedCall("POST", "/api/v1/stages/s1/complete", 409, SEEDING_FAILED_AFTER_COMMIT, "no TBD rows"); } } });
    await built(committed.driver, spec("league"));
    await expect(committed.driver.completeStage("s1")).rejects.toThrow(RefusedCall);
    await expect(committed.driver.completeStage("s1")).rejects.toThrow(DriverMisuse);
    expect(committed.pageCalls.filter((c) => c === "completeStageUi")).toHaveLength(1);
    expect(committed.http.calls).not.toContain("completeStage");
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
    // The division the organiser builds cannot carry a rule override: never silently dropped.
    // M-4 ruling (fix round 1): that is a cell with no path in this layer, owned by a wave —
    // a named NoOrganiserPath the runner records as 🚫, never an error red.
    const second = league();
    const c2 = await second.driver.createCompetition({ name: "x", slug: "asked" });
    const err = await second.driver.createDivision(c2.id, { name: "x", slug: "d", sportKey: "generic", variantKey: "default", config: { pointsToWin: 15 } }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NoOrganiserPath);
    expect(err).not.toBeInstanceOf(DriverMisuse);
    // Ruling 47 names the owning wave, and the wave thrown is the route's: the route and the
    // NoOrganiserPath literal (the guard reads a literal only, PF-3) are pinned together.
    expect(OVERRIDE_ROUTE.wave).toBe(ruling47OverrideWave());
    expect(err).toMatchObject({ wave: OVERRIDE_ROUTE.wave });
    expect((err as NoOrganiserPath).reason).toMatch(/rule override \(pointsToWin\)/);
    expect((err as NoOrganiserPath).reason).toContain(OVERRIDE_ROUTE.why);
    expect(second.pageCalls).toEqual(["createCompetitionUi"]);
    // Not recorded: createDivision was never invoked on either path.
    expect(only(second.driver, "mixed-driver-coverage")).toMatchObject({ verdict: "pass", checked: 1 });
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
  it("every API-only row × sport: created over http, organiser-ui-path fails naming the wave design §8 gives it, and coverage exempts createDivision — while the two template-only cells are refused by name unless the case carries its template (Task 13)", async () => {
    const scopes = designScopes();
    const cells = templateOnlyCells();
    expect(cells).toEqual({ "group_only|badminton": "box-league", "group_group_ko|cricket": "t20-super8" });
    let checked = 0;
    let refused = 0;
    for (const row of API_ONLY_ROWS) {
      const wave = waveFor(row, scopes);
      for (const sport of SPORT_KEYS) {
        const http = stubHttp({ createDivision: async (...a: never[]) => {
          const i = a[1] as { sportKey: string; variantKey: string };
          return { id: "d9", slug: "d-api", sportKey: i.sportKey, variantKey: i.variantKey, config: {} };
        } });
        const { driver, pageCalls } = make({ http, spec: spec(row, sport) });
        const tmpl = cells[`${row}|${sport}`];
        if (tmpl !== undefined) {
          // Ruling 47: the cell IS reachable — through its card, which only a case
          // carrying the template drives. Without it no organiser act is right, so
          // nothing is created, in the browser or over http.
          const e = await built(driver, spec(row, sport)).catch((x: unknown) => x);
          expect(e, `${row}|${sport}`).toBeInstanceOf(DriverMisuse);
          expect((e as Error).message).toContain(`catalog template ${tmpl}`);
          expect([pageCalls, http.calls], `${row}|${sport}`).toEqual([[], []]);
          expect(driver.checks().filter((c) => c.id === "organiser-ui-path"), `${row}|${sport}`).toEqual([]);
          refused++;
          checked++;
          continue;
        }
        const b = await built(driver, spec(row, sport));
        expect(b.divSlug).toBe("d-api");
        expect(pageCalls, `${row}|${sport}`).toEqual(["createCompetitionUi"]);
        expect(http.calls, `${row}|${sport}`).toEqual(["createDivision"]);
        expect(only(driver, "organiser-ui-path"), `${row}|${sport}`).toMatchObject({ verdict: "fail", checked: 1, evidence: [`no organiser control builds ${row} → ${wave}`] });
        // The exemption is the row's route (api-only-ui.ts): design §8's wave for the row.
        const route = API_ONLY_UI_WAVE[row];
        expect(route.wave, `${row}|${sport}`).toBe(wave);
        expect(only(driver, "mixed-driver-coverage"), `${row}|${sport}`).toMatchObject({ verdict: "pass", checked: 2, evidence: [`createDivision: exempt — → ${route.wave}: ${route.why}`] });
        // The http-built division is the one every later page object acts in.
        const bs = await driver.postStages("d9", stagesForRow(row)).catch((e: unknown) => e);
        expect(bs).toBeInstanceOf(Error);
        expect(http.calls.at(-1)).toBe("postStages");
        checked++;
      }
    }
    expect(checked).toBe(API_ONLY_ROWS.length * SPORT_KEYS.length);
    expect(checked).toBeGreaterThan(0);
    expect(refused).toBe(Object.keys(cells).length);
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
  // Ruling E: never pair by position. Both cases put each pool's table where a
  // positional pairing would meet the OTHER pool, so only a pairing by members
  // names these differences (found by mutation: the evidence was unpinned).
  it("pools are paired by their members, never by position: two reordered pools pair across positions, and swapped members leave both sides named", () => {
    const api = [{ label: "pool 1", rows: uiRows("Bob", "Ann").rows }, { label: "pool 2", rows: uiRows("Cat", "Dan").rows }];
    expect(compareTables(api, [uiRows("Dan", "Cat"), uiRows("Ann", "Bob")])).toEqual({
      ok: false, checked: 2, evidence: ["pool 1: page order 1 Ann, 2 Bob; API order 1 Bob, 2 Ann", "pool 2: page order 1 Dan, 2 Cat; API order 1 Cat, 2 Dan"],
    });
    expect(compareTables(api, [uiRows("Ann", "Cat"), uiRows("Bob", "Dan")])).toEqual({
      ok: false, checked: 2, evidence: [
        "pool 1: the page draws no table with its 2 entrant(s) (Ann, Bob)", "pool 2: the page draws no table with its 2 entrant(s) (Cat, Dan)",
        "page table #1 (Ann, Cat) matches no API table", "page table #2 (Bob, Dan) matches no API table",
      ],
    });
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

  // Ruling C, amended (fix round 1, I-1 + I-2): the public page may show an
  // older state for its own revalidate window PLUS the data cache under it
  // (getPublicDivision's unstable_cache): an ISR regeneration can read a data
  // entry one data window old. Both windows are read from the product here,
  // never from browser-driver.ts.
  const pageRevalidateS = (): number => {
    const m = /export const revalidate = (\d+);/.exec(src(PUBLIC_DIV_PAGE));
    expect(m, `${PUBLIC_DIV_PAGE} no longer declares its revalidate`).not.toBeNull();
    return Number(m![1]);
  };
  const DATA_TS = "apps/web/src/server/public-site/data.ts";
  const dataRevalidateS = (): number => {
    const text = src(DATA_TS);
    const m = /export const REVALIDATE_FAST = (\d+);/.exec(text);
    expect(m, `${DATA_TS} no longer declares REVALIDATE_FAST`).not.toBeNull();
    // The window is getPublicDivision's own: its unstable_cache revalidates on REVALIDATE_FAST.
    const fn = text.slice(text.indexOf("export async function getPublicDivision("));
    const body = fn.slice(0, fn.indexOf("\nexport "));
    expect(body.length, "getPublicDivision not found").toBeGreaterThan(0);
    expect(body).toMatch(/unstable_cache\(/);
    expect(body).toMatch(/revalidate: REVALIDATE_FAST,/);
    return Number(m![1]);
  };
  const productWindowMs = (holdMs: number) => Math.max(FLOOR_MS, (pageRevalidateS() + dataRevalidateS()) * 1000 + navBudget({ holdMs }) + SLACK_MS);

  it("the page's revalidate, its data cache's revalidate and the bracket kinds are the product's (text pins), and the freshness window is derived from both caches", () => {
    expect(PUBLIC_REVALIDATE_S).toBe(pageRevalidateS());
    expect(PUBLIC_DATA_REVALIDATE_S).toBe(dataRevalidateS());
    expect([...PUBLIC_BRACKET_KINDS].sort()).toEqual(setLiteral("apps/web/src/server/public-site/champion.ts", "BRACKET_KINDS").sort());
    let checked = 0;
    for (const holdMs of [500, 3000, 10_000, 60_000]) {
      expect(publicFreshnessMs({ holdMs }), String(holdMs)).toBe(productWindowMs(holdMs));
      checked++;
    }
    expect(checked).toBe(4);
    // Both layers count: the window is past the page's own revalidate plus a navigation.
    expect(publicFreshnessMs({ holdMs: 3000 })).toBeGreaterThan(pageRevalidateS() * 1000 + navBudget({ holdMs: 3000 }));
  });

  it("a stale page is read again, SLACK_MS apart, until it matches on the Nth read — the stale reads are never the verdict", async () => {
    const clock = fakeClock();
    let reads = 0;
    const { driver, pageCalls } = make({ http: pub(), clock, pages: { readPublicUi: async () => ({ tables: [++reads < 3 ? uiRows("Bob", "Ann") : uiRows("Ann", "Bob")], champion: null }) } });
    const b = await built(driver, spec("league"));
    const out = await driver.publicStandings(ref(b));
    expect(out.standings).toHaveLength(1);
    expect(pageCalls.filter((c) => c === "readPublicUi")).toHaveLength(3);
    expect(clock.sleeps).toEqual([SLACK_MS, SLACK_MS]);
    expect(only(driver, "ui-public-standings-match")).toMatchObject({ verdict: "pass", checked: 1 });
    expect(only(driver, "ui-public-standings-match").reason).toMatch(/on read 3/);
    expect(only(driver, "ui-champion-shown")).toMatchObject({ verdict: "abstain" });
    // A second public read is the data alone.
    await driver.publicStandings(ref(b));
    expect(pageCalls.filter((c) => c === "readPublicUi")).toHaveLength(3);
  });

  it("a page still different once the window has passed since the case's last write is a FAIL verdict naming the difference — never a throw — and the case keeps every other check", async () => {
    const clock = fakeClock();
    let reads = 0;
    const { driver } = make({ http: pub(), clock, pages: { readPublicUi: async () => { reads++; return { tables: [uiRows("Bob", "Ann")], champion: null }; } } });
    const b = await built(driver, spec("league"));
    const windowMs = productWindowMs(3000);
    // The case's last write was at t = 0 (built): the page is polled until a read STARTS at the window.
    const out = await driver.publicStandings(ref(b));
    expect(out.standings).toHaveLength(1);
    expect(clock.sleeps.length).toBe(Math.ceil(windowMs / SLACK_MS));
    expect(reads).toBe(clock.sleeps.length + 1);
    expect(clock.t).toBeGreaterThanOrEqual(windowMs);
    const c = only(driver, "ui-public-standings-match");
    expect(c).toMatchObject({ verdict: "fail", checked: 1 });
    expect(c.evidence).toEqual(["league stage 1: page order 1 Bob, 2 Ann; API order 1 Ann, 2 Bob"]);
    expect(c.reason).toMatch(new RegExp(`${clock.t} ms after the case's last write`));
    expect(c.reason).toMatch(new RegExp(`window ${windowMs} ms`));
    expect(c.reason).toMatch(/revalidate .*data cache/);
    expect(c.reason).toMatch(new RegExp(`read ${reads}×`));
    // Every other check survives the mismatch.
    const ids = driver.checks().map((k) => k.id);
    expect(ids).toEqual(expect.arrayContaining(["organiser-ui-path", "ui-public-standings-match", "ui-champion-shown", "mixed-driver-coverage", "visual-evidence"]));
    expect(only(driver, "organiser-ui-path").verdict).toBe("pass");
  });

  it("the window counts from the case's LAST write: long after it, one read decides; a fresh write restarts it", async () => {
    const windowMs = productWindowMs(3000);
    const stale = { readPublicUi: async () => ({ tables: [uiRows("Bob", "Ann")], champion: null }) };
    // Long after the last write: the first read is authoritative — no polling.
    const clockA = fakeClock();
    const a = make({ http: pub(), clock: clockA, pages: stale });
    const bA = await built(a.driver, spec("league"));
    clockA.t = windowMs;
    await a.driver.publicStandings(ref(bA));
    expect(clockA.sleeps).toEqual([]);
    expect(a.pageCalls.filter((c) => c === "readPublicUi")).toHaveLength(1);
    expect(only(a.driver, "ui-public-standings-match").verdict).toBe("fail");
    // A write at t = window restarts it: polled for a whole window again.
    const clockB = fakeClock();
    const bDrv = make({ http: pub(), clock: clockB, pages: stale });
    const bB = await built(bDrv.driver, spec("league"));
    clockB.t = windowMs;
    await bDrv.driver.generate("s1");
    await bDrv.driver.publicStandings(ref(bB));
    expect(clockB.sleeps.length).toBe(Math.ceil(windowMs / SLACK_MS));
    expect(only(bDrv.driver, "ui-public-standings-match").verdict).toBe("fail");
  });

  // M-7 (fix round 1): zero tables compared abstains only where no stage is a table kind.
  it("no table on either side abstains when every stage is a bracket, and FAILS as vacuous when a table stage has none", async () => {
    const ko = make({ http: pub({ kind: "knockout", standings: [] }), spec: spec("knockout") });
    const bKo = await built(ko.driver, spec("knockout"));
    await ko.driver.publicStandings(ref(bKo));
    expect(only(ko.driver, "ui-public-standings-match")).toMatchObject({ verdict: "abstain", checked: 0 });
    expect(only(ko.driver, "ui-public-standings-match").reason).toMatch(/knockout/);
    const lg = make({ http: pub({ standings: [] }) });
    const bLg = await built(lg.driver, spec("league"));
    await lg.driver.publicStandings(ref(bLg));
    expect(only(lg.driver, "ui-public-standings-match")).toMatchObject({ verdict: "fail", checked: 0 });
    expect(only(lg.driver, "ui-public-standings-match").reason).toMatch(/vacuous: .*league/);
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

  it("the champion: a banner still wrong after the window is a FAIL verdict naming both, and the case keeps its other checks; a completion with no finalRanks fails by name; a table stage abstains", async () => {
    const clock = fakeClock();
    const wrong = make({ http: pub({ kind: "knockout", standings: [] }), spec: spec("knockout"), clock, pages: {
      completeStageUi: async () => ({ completed: true, events: [{ type: "stage_completed", finalRanks: ["e2", "e1"] }] }),
      readPublicUi: async () => ({ tables: [], champion: "Ann" }),
    } });
    const b = await built(wrong.driver, spec("knockout"));
    await wrong.driver.completeStage("s1");
    const out = await wrong.driver.publicStandings(ref(b));
    expect(out.standings).toEqual([]);
    expect(clock.t).toBeGreaterThanOrEqual(productWindowMs(3000));
    const shown = only(wrong.driver, "ui-champion-shown");
    expect(shown).toMatchObject({ verdict: "fail", checked: 1 });
    expect(shown.evidence.join("\n")).toMatch(/the banner names Ann; want Bob/);
    expect(only(wrong.driver, "ui-public-standings-match")).toMatchObject({ verdict: "abstain", checked: 0 });
    expect(wrong.driver.checks().map((k) => k.id)).toEqual(expect.arrayContaining(["organiser-ui-path", "mixed-driver-coverage", "visual-evidence"]));

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

  it("no row, the wrong row, two rows, or the one row at another seq than the console answered each fail by name", async () => {
    const cases: [string, LedgerRow[], RegExp][] = [
      ["none", [], /f1: 0 ledger rows after seq 2/],
      ["wrong", [{ id: "r3", seq: 3, type: "core.start", payload: {} }], /f1: seq 3 is core\.start/],
      ["two", [{ id: "r3", seq: 3, type: FINALIZE_EVENT, payload: {} }, { id: "r4", seq: 4, type: FINALIZE_EVENT, payload: {} }], /f1: 2 ledger rows after seq 2/],
      // The console answered seq 3 (fakePages' finalizeUi); the ledger's only finalize is another append.
      ["elsewhere", [{ id: "r4", seq: 4, type: FINALIZE_EVENT, payload: {} }], /f1: the ledger's core\.finalize is seq 4, the console's answer seq 3/],
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

describe("BrowserDriver — the pad path (W1c Task 7)", () => {
  const PAD_FIXTURE = fixture("f1", "s1", null, 4);
  const DIV_CONFIG = { resultMode: "score", allowDraws: true };
  const DECIDED: FixtureStateOut = { status: "decided", last_seq: 3, outcome: { kind: "win", winner: "e1" } };
  const lrow = (seq: number, type: string, payload: unknown): LedgerRow => ({ id: `r${seq}`, seq, type, payload });
  const EVENTS: StreamEvent[] = [{ type: "core.start", payload: {} }, { type: "generic.result", payload: { p1Score: 3, p2Score: 1 } }];
  const STORED = [lrow(2, "core.start", {}), lrow(3, "generic.result", { p1Score: 3, p2Score: 1 })];
  const OK: ReplayResult = {
    rows: [
      { expected: EVENTS[0]!, stored: [STORED[0]!], verdict: "equal", note: null },
      { expected: EVENTS[1]!, stored: [STORED[1]!], verdict: "equal", note: null },
    ],
    stored: STORED,
    findings: [],
  };
  /** The http side the pad path reads: the fixture's row, its division's config, its state and ledger. */
  const padHttp = (o: { state?: FixtureStateOut; ledgerRows?: LedgerRow[] } = {}) => stubHttp({
    listFixtures: async () => [PAD_FIXTURE],
    getDivision: async () => ({ id: "d1", slug: PRODUCT_DIV_SLUG, sportKey: "generic", variantKey: "score", config: DIV_CONFIG }),
    fixtureState: async () => o.state ?? DECIDED,
    ledger: async (...a: never[]) => (o.ledgerRows ?? STORED).filter((r) => r.seq > (a[1] as number)),
    postStream: async () => [],
    listStages: async () => [stageRef("s1", 1, "league")],
    listEntrants: async () => ENTRANTS,
    publicStandings: async () => ({ division_id: "d1", standings: [{ stage_id: "s1", pool_id: null, rows: rows("e1", "e2") }] }),
  });
  /** A replay that records what it was handed and answers `result` (or `each` per call). */
  const fakeReplay = (result: ReplayResult | ((call: number, deps: ReplayDeps) => Promise<ReplayResult>)) => {
    const calls: Parameters<Replay>[] = [];
    const fn: Replay = async (...a) => {
      calls.push(a);
      return typeof result === "function" ? result(calls.length, a[4]) : result;
    };
    return { fn, calls };
  };
  const PADS = { generic: genericPad };

  it("postStream taps through the injected replay, then answers PostedEvents carrying `stored`, the seq and id from the rows, and status/outcome from one trailing fixtureState", async () => {
    const r = fakeReplay(OK);
    const { driver, http, pageArgs, pageCalls } = make({ http: padHttp(), pads: PADS, replay: r.fn });
    await built(driver, spec("league"));
    const posted = await driver.postStream("f1", EVENTS, "p");
    expect(posted).toEqual([
      { seq: 2, event_id: "r2", status: DECIDED.status, outcome: DECIDED.outcome, stored: { type: "core.start", payload: {} } },
      { seq: 3, event_id: "r3", status: DECIDED.status, outcome: DECIDED.outcome, stored: { type: "generic.result", payload: { p1Score: 3, p2Score: 1 } } },
    ]);
    // The replay got the page, the sport's adapter, the events, the division's cfg and the fixture's two seats.
    expect(r.calls).toHaveLength(1);
    const [page, adapter, events, ctx, deps] = r.calls[0]!;
    expect(page).toBeDefined();
    expect(adapter).toBe(genericPad);
    expect(events).toEqual(EVENTS);
    expect(ctx).toEqual({ cfg: DIV_CONFIG, entrants: { home: "e1", away: "e2" } });
    // Its deps are the server's: the tip is /state's last_seq, the ledger is this fixture's, the hold is the build's.
    expect(deps.holdMs).toBe(3000);
    expect(await deps.tip()).toBe(DECIDED.last_seq);
    expect((await deps.ledger(2)).map((x) => x.seq)).toEqual([3]);
    // The console was opened by the fixture's number first; nothing went over the events route.
    expect(pageArgs.openFixtureUi![0]![2]).toBe(4);
    expect(pageCalls).toContain("openFixtureUi");
    expect(http.calls).not.toContain("postStream");
    expect(only(driver, "pad-ledger-as-generated")).toMatchObject({ verdict: "pass", checked: 2 });
    expect(only(driver, "mixed-driver-coverage")).toMatchObject({ verdict: "pass" });
  });

  it("the pad path never finalizes: no Finalize tap, no finalize call — PADPROOF finalizes as its own step", async () => {
    const r = fakeReplay(OK);
    const { driver, http, pageCalls } = make({ http: padHttp(), pads: PADS, replay: r.fn });
    await built(driver, spec("league"));
    await driver.postStream("f1", EVENTS, "p");
    expect(r.calls).toHaveLength(1);
    expect(pageCalls).not.toContain("finalizeUi");
    expect(http.calls.filter((c) => c.includes("inalize"))).toEqual([]);
    expect(driver.checks().map((c) => c.id)).not.toContain("finalize-ledger-row");
  });

  it("a replay finding is a failing pad-ledger-as-generated naming the fixture and the event index; the rows the product did store are still answered", async () => {
    const partial: ReplayResult = {
      rows: [
        { expected: EVENTS[0]!, stored: [STORED[0]!], verdict: "equal", note: null },
        { expected: EVENTS[1]!, stored: [lrow(3, "generic.result", { p1Score: 3, p2Score: 2 })], verdict: "mismatch", note: "p2Score: stored 2, generated 1" },
      ],
      stored: [STORED[0]!, lrow(3, "generic.result", { p1Score: 3, p2Score: 2 })],
      findings: ["stopped after event 2 of 2: p2Score: stored 2, generated 1"],
    };
    const { driver } = make({ http: padHttp(), pads: PADS, replay: fakeReplay(partial).fn });
    await built(driver, spec("league"));
    const posted = await driver.postStream("f1", EVENTS, "p");
    expect(posted.map((p) => p.stored)).toEqual([{ type: "core.start", payload: {} }, { type: "generic.result", payload: { p1Score: 3, p2Score: 2 } }]);
    const c = only(driver, "pad-ledger-as-generated");
    expect(c).toMatchObject({ verdict: "fail", checked: 3 });
    expect(c.evidence).toEqual([
      "f1 event 2 of 2 (generic.result): mismatch — p2Score: stored 2, generated 1",
      "f1: stopped after event 2 of 2: p2Score: stored 2, generated 1",
    ]);
  });

  it("a replay that stored nothing answers no event and fails the check, never a vacuous pass", async () => {
    const none: ReplayResult = { rows: [], stored: [], findings: ["event 1 of 2 (core.start): no tap route — the adapter answered no steps"] };
    const { driver } = make({ http: padHttp(), pads: PADS, replay: fakeReplay(none).fn });
    await built(driver, spec("league"));
    expect(await driver.postStream("f1", EVENTS, "p")).toEqual([]);
    expect(only(driver, "pad-ledger-as-generated")).toMatchObject({ verdict: "fail", checked: 1, evidence: ["f1: event 1 of 2 (core.start): no tap route — the adapter answered no steps"] });
  });

  it("every pad write joins ONE check across fixtures; `first` sends only the first score to the pad, `all` sends every one", async () => {
    const first = fakeReplay(OK);
    const a = make({ http: padHttp(), pads: PADS, replay: first.fn, padPolicy: "first" });
    await built(a.driver, spec("league"));
    await a.driver.postStream("f1", EVENTS, "p");
    await a.driver.postStream("f1", EVENTS, "q");
    expect(first.calls).toHaveLength(1);
    expect(a.http.calls.filter((c) => c === "postStream")).toHaveLength(1);
    expect(only(a.driver, "pad-ledger-as-generated")).toMatchObject({ verdict: "pass", checked: 2 });

    const all = fakeReplay(OK);
    const b = make({ http: padHttp(), pads: PADS, replay: all.fn, padPolicy: "all" });
    await built(b.driver, spec("league"));
    await b.driver.postStream("f1", EVENTS, "p");
    await b.driver.postStream("f1", EVENTS, "q");
    expect(all.calls).toHaveLength(2);
    expect(b.http.calls).not.toContain("postStream");
    expect(only(b.driver, "pad-ledger-as-generated")).toMatchObject({ verdict: "pass", checked: 4 });
  });

  it("an empty stream has no pad act: it goes over http as before, and nothing is tapped", async () => {
    const r = fakeReplay(OK);
    const { driver, http } = make({ http: padHttp(), pads: PADS, replay: r.fn });
    await built(driver, spec("league"));
    expect(await driver.postStream("f1", [], "p")).toEqual([]);
    expect(r.calls).toEqual([]);
    expect(http.calls).toContain("postStream");
    expect(driver.checks().map((c) => c.id)).not.toContain("pad-ledger-as-generated");
  });

  describe("an event the pad has no control for (W1d item 16: cricket's follow-on and time-expiry draw)", () => {
    const START: StreamEvent = { type: "core.start", payload: {} };
    const INNINGS: StreamEvent = { type: CRICKET_SUMMARY, payload: { runs: 100, wickets: 10, legalBalls: 120 } };
    const BARRED = (type: string): StreamEvent[] => [START, INNINGS, { type, payload: {} }];
    const TAPPABLE: StreamEvent[] = [START, INNINGS];
    const CRICKET_PADS = { cricket: cricketPad };
    const cricketMade = (padPolicy: "first" | "all") => {
      const r = fakeReplay(OK);
      return { r, ...make({ http: padHttp(), spec: spec("league", "cricket"), pads: CRICKET_PADS, replay: r.fn, padPolicy }) };
    };

    it("a stream holding either event is scored over http whole, never half-tapped, exempt by the adapter's route; pad-route abstains ONCE naming the event and the wave", async () => {
      let checked = 0;
      for (const type of cricketPad.noControl!.eventTypes) {
        const { r, driver, http, pageCalls } = cricketMade("all");
        await built(driver, spec("league", "cricket"));
        await driver.postStream("f1", BARRED(type), "p");
        await driver.postStream("f1", BARRED(type), "q");
        expect(r.calls, type).toEqual([]);
        expect(pageCalls, type).not.toContain("openFixtureUi");
        expect(http.calls.filter((c) => c === "postStream"), type).toHaveLength(2);
        const route = only(driver, "pad-route");
        expect(route, type).toMatchObject({ verdict: "abstain", checked: 0 });
        expect(route.reason, type).toBe(`cricket: ${type} has no pad control → ${CRICKET_NO_CONTROL.wave} (${CRICKET_NO_CONTROL.why}); a stream holding it is scored over http`);
        expect(driver.checks().filter((c) => c.id === "pad-route"), type).toHaveLength(1);
        expect(driver.checks().map((c) => c.id), type).not.toContain("pad-ledger-as-generated");
        // Coverage: the exemption names the wave, so the case is not a red on a promise.
        expect(only(driver, "mixed-driver-coverage"), type).toMatchObject({ verdict: "pass" });
        expect(only(driver, "mixed-driver-coverage").evidence, type).toContain(`score: exempt — → ${CRICKET_NO_CONTROL.wave}: ${CRICKET_NO_CONTROL.why}`);
        checked++;
      }
      expect(checked).toBe(2);
    });

    it("the event is found wherever it stands in the stream — the generator's follow-on is in the MIDDLE (start, two innings, follow-on, an innings), the draw's time close LAST — and a stream without one is not barred", async () => {
      const positions: StreamEvent[][] = [
        [START, INNINGS, INNINGS, { type: CRICKET_FOLLOW_ON, payload: {} }, INNINGS],
        [START, INNINGS, INNINGS, INNINGS, INNINGS, { type: CRICKET_MATCH_CLOSE, payload: {} }],
        [{ type: CRICKET_FOLLOW_ON, payload: {} }, START, INNINGS],
      ];
      let checked = 0;
      for (const events of positions) {
        const { r, driver, http } = cricketMade("all");
        await built(driver, spec("league", "cricket"));
        await driver.postStream("f1", events, "p");
        expect(r.calls, events.map((e) => e.type).join(",")).toEqual([]);
        expect(http.calls.filter((c) => c === "postStream")).toHaveLength(1);
        checked++;
      }
      expect(checked).toBe(3);
      const { r, driver } = cricketMade("all");
      await built(driver, spec("league", "cricket"));
      await driver.postStream("f1", [START, INNINGS, INNINGS, INNINGS, INNINGS], "p");
      expect(r.calls).toHaveLength(1); // the same shape without a barred event is tapped
    });

    it("the exemption does not use up the pad's turn: under `first`, the next stream the pad CAN write runs on it, and the one after goes over http", async () => {
      const { r, driver, http } = cricketMade("first");
      await built(driver, spec("league", "cricket"));
      await driver.postStream("f1", BARRED(CRICKET_FOLLOW_ON), "p"); // http, exempt
      expect(r.calls).toHaveLength(0);
      await driver.postStream("f1", TAPPABLE, "q"); // the pad's turn
      expect(r.calls).toHaveLength(1);
      await driver.postStream("f1", TAPPABLE, "r"); // used up
      expect(r.calls).toHaveLength(1);
      expect(http.calls.filter((c) => c === "postStream")).toHaveLength(2);
      expect(only(driver, "pad-ledger-as-generated")).toMatchObject({ verdict: "pass", checked: 2 });
      expect(only(driver, "mixed-driver-coverage")).toMatchObject({ verdict: "pass" });
    });

    it("under `all` a tappable stream is tapped and a barred one is not, in either order; each pad write still joins the one check", async () => {
      const { r, driver, http } = cricketMade("all");
      await built(driver, spec("league", "cricket"));
      await driver.postStream("f1", TAPPABLE, "p");
      await driver.postStream("f1", BARRED(CRICKET_MATCH_CLOSE), "q");
      await driver.postStream("f1", TAPPABLE, "r");
      expect(r.calls).toHaveLength(2);
      expect(http.calls.filter((c) => c === "postStream")).toHaveLength(1);
      expect(only(driver, "pad-ledger-as-generated")).toMatchObject({ verdict: "pass", checked: 4 });
      expect(only(driver, "pad-route").verdict).toBe("abstain");
    });

    it("a sport whose adapter declares no noControl is tapped as before, whatever its events are (the guard reads the adapter's declaration, not the event's name)", async () => {
      const r = fakeReplay(OK);
      const { driver, http } = make({ http: padHttp(), pads: PADS, replay: r.fn, padPolicy: "all" });
      await built(driver, spec("league"));
      expect(genericPad.noControl).toBeUndefined();
      await driver.postStream("f1", BARRED(CRICKET_FOLLOW_ON), "p");
      expect(r.calls).toHaveLength(1);
      expect(http.calls).not.toContain("postStream");
      expect(driver.checks().map((c) => c.id)).not.toContain("pad-route");
    });
  });

  it("a sport with no adapter is not tapped: it goes over http, and pad-route abstains ONCE naming the task that owes it; coverage still reds score", async () => {
    const r = fakeReplay(OK);
    // Every catalogue sport has an adapter since W1c Task 11, so the registry here lacks cricket's.
    const pads = Object.fromEntries(Object.entries(PAD_ADAPTERS).filter(([k]) => k !== "cricket"));
    const { driver, http } = make({ http: padHttp(), spec: spec("league", "cricket"), pads, replay: r.fn });
    await built(driver, spec("league", "cricket"));
    await driver.postStream("f1", EVENTS, "p");
    await driver.postStream("f1", EVENTS, "q");
    expect(r.calls).toEqual([]);
    expect(http.calls.filter((c) => c === "postStream")).toHaveLength(2);
    expect(only(driver, "pad-route")).toMatchObject({ verdict: "abstain", checked: 0, reason: noPadReason("cricket") });
    expect(only(driver, "mixed-driver-coverage")).toMatchObject({ verdict: "fail", evidence: ["score: invoked 2×, never in the browser"] });
  });

  // W1d Task 12, item 8: the unseated-fixture guard, and what padCheck keeps.
  it("item 8: the unseated-fixture guard refuses by name — a fixture with either seat empty is never tapped, and nothing is recorded as the pad's", async () => {
    let checked = 0;
    for (const [seat, row] of [["home", { ...PAD_FIXTURE, home_entrant_id: null }], ["away", { ...PAD_FIXTURE, away_entrant_id: null }], ["both", { ...PAD_FIXTURE, home_entrant_id: null, away_entrant_id: null }]] as const) {
      const r = fakeReplay(OK);
      const http = stubHttp({
        listFixtures: async () => [row],
        getDivision: async () => ({ id: "d1", slug: PRODUCT_DIV_SLUG, sportKey: "generic", variantKey: "score", config: DIV_CONFIG }),
        listStages: async () => [stageRef("s1", 1, "league")],
      });
      const { driver, pageCalls } = make({ http, pads: PADS, replay: r.fn });
      await built(driver, spec("league"));
      const err = await driver.postStream("f1", EVENTS, "p").catch((e: unknown) => e);
      expect(err, seat).toBeInstanceOf(DriverMisuse);
      expect((err as Error).message, seat).toBe("browser: fixture f1 does not seat two entrants — the pad scores a seated fixture only");
      expect((err as Error).message).toContain("does not seat two entrants");
      expect(r.calls, `${seat}: the replay is never reached`).toEqual([]);
      expect(pageCalls, `${seat}: the console is never opened`).not.toContain("openFixtureUi");
      expect(driver.checks().map((c) => c.id), seat).not.toContain("pad-ledger-as-generated");
      checked++;
    }
    expect(checked).toBe(3);
  });

  it("item 8: the positive pair — a fixture seating two entrants IS tapped (the guard refuses the unseated one only)", async () => {
    const r = fakeReplay(OK);
    const { driver } = make({ http: padHttp(), pads: PADS, replay: r.fn });
    await built(driver, spec("league"));
    await driver.postStream("f1", EVENTS, "p");
    expect(r.calls).toHaveLength(1);
  });

  /** A replay result of `n` rows that each pass with a note (a fallback: the check keeps its note as evidence) — or fail. */
  const fallbackRows = (n: number, verdict: "fallback" | "mismatch" = "fallback"): ReplayResult => {
    const ev = (i: number): StreamEvent => ({ type: "generic.result", payload: { n: i } });
    return { rows: Array.from({ length: n }, (_x, i) => ({ expected: ev(i), stored: [lrow(i + 2, "generic.result", { n: i })], verdict, note: `why ${i + 1}` })), stored: [], findings: [] };
  };
  async function padEvidence(result: ReplayResult): Promise<CheckResult> {
    const { driver } = make({ http: padHttp(), pads: PADS, replay: fakeReplay(result).fn });
    await built(driver, spec("league"));
    await driver.postStream("f1", EVENTS, "p");
    return only(driver, "pad-ledger-as-generated");
  }

  it("item 8: padCheck lists 12 notes and then `+N more` — 14 notes → 12 lines + `+2 more`; 13 → `+1 more`; 12 or fewer → no more-line (the boundary, both sides)", async () => {
    let checked = 0;
    // The empty case first: nothing replayed is a vacuous fail with no evidence and no more-line.
    expect(await padEvidence({ rows: [], stored: [], findings: [] })).toMatchObject({ verdict: "fail", checked: 0, evidence: [] });
    for (const [n, more] of [[1, null], [11, null], [12, null], [13, "+1 more"], [14, "+2 more"], [30, "+18 more"]] as const) {
      // Passing rows: a fallback row passes and its note is kept, so n rows → n evidence notes.
      const c = await padEvidence(fallbackRows(n));
      expect(c.verdict, `${n} passing`).toBe("pass");
      const lines = c.evidence.filter((l) => !/^\+\d+ more$/.test(l));
      expect(lines, `${n}: the lines kept`).toHaveLength(Math.min(n, 12));
      expect(c.evidence.length, `${n}: lines plus the more-line`).toBe(Math.min(n, 12) + (more === null ? 0 : 1));
      expect(c.evidence.at(-1), `${n}: the last line`).toBe(more ?? lines.at(-1));
      // The 12 kept are the FIRST 12, in order — the cut never reorders.
      expect(lines.map((l) => l.replace(/^.*— /, "")), `${n}`).toEqual(Array.from({ length: Math.min(n, 12) }, (_x, i) => `why ${i + 1}`));
      checked++;
    }
    expect(checked).toBe(6);
  });

  it("item 8: the failing notes count toward the cut too — 13 failures and 2 passing notes → 12 failures then `+3 more`, and the verdict still names the first failure", async () => {
    const bad = fallbackRows(13, "mismatch");
    const good = fallbackRows(2);
    const c = await padEvidence({ rows: [...bad.rows, ...good.rows.map((r, i) => ({ ...r, expected: { type: "generic.result", payload: { n: 20 + i } } }))], stored: [], findings: [] });
    expect(c.verdict).toBe("fail");
    expect(c.evidence).toHaveLength(13);
    expect(c.evidence.at(-1)).toBe("+3 more");
    expect(c.evidence.slice(0, 12).every((l) => /: mismatch — why \d+$/.test(l))).toBe(true);
    expect(c.reason).toBe("f1 event 1 of 2 (generic.result): mismatch — why 1");
  });

  // 15a: the tap-wait timeout, through the real replay on a fake page.
  it("15a: a tap-wait timeout's message carries the last 5 tap timings — clickedAtMs from the CASE's start, waitedMs from the clock — redacted, and the ledger never advanced", async () => {
    const SECRET = ["postgres", "://", "matrix", ":", "pw0", "@", "db.invalid", "/m"].join("");
    const clock = fakeClock();
    clock.t = 5_000; // the driver is built mid-run: its timings are relative to ITS start, not the process's
    let locators = 0;
    let committed = 0; // each release of a hold writes the event's one row
    const page = {
      locator: (selector: string) => {
        const n = ++locators;
        return {
          click: async () => undefined,
          fill: async () => undefined,
          count: async () => { if (selector === selectorForTapStep({ kind: "releaseHold" })) committed++; return 0; },
          waitFor: async () => {
            if (n < 8) return;
            clock.t += FLOOR_MS;
            const e = new Error(`locator.waitFor: Timeout ${FLOOR_MS}ms exceeded. (DATABASE_URL=${SECRET})\nCall log:\n  - waiting for locator('[data-tile-id="t"]')`);
            e.name = "TimeoutError";
            throw e;
          },
        };
      },
      goto: async () => undefined,
      setViewportSize: async () => undefined,
    };
    // Two steps and a release per event: event 1 = taps 1-3, event 2 = taps 4-6, event 3 = taps 7-8 (its second step never attaches).
    const threeSteps: PadRegistry = { generic: { sport: "generic", emits: [], fallbacks: [], stepsFor: () => ["a", "b"].map((tileId) => ({ kind: "tile" as const, tileId })) } };
    // The ledger gains a row (seq 4, 5, ...) as each hold is released — and event 3 never gets to release.
    const http = stubHttp({
      listFixtures: async () => [PAD_FIXTURE],
      getDivision: async () => ({ id: "d1", slug: PRODUCT_DIV_SLUG, sportKey: "generic", variantKey: "score", config: DIV_CONFIG }),
      fixtureState: async () => DECIDED,
      ledger: async (...a: never[]) => Array.from({ length: committed }, (_x, i) => lrow(DECIDED.last_seq + 1 + i, "generic.result", {})).filter((r) => r.seq > (a[1] as number)),
      postStream: async () => [],
      listStages: async () => [stageRef("s1", 1, "league")],
    });
    const { driver } = make({ http, pads: threeSteps, clock, page });
    await built(driver, spec("league"));
    await driver.postStream("f1", [{ type: "generic.result", payload: {} }, { type: "generic.result", payload: {} }, { type: "generic.result", payload: {} }], "p");
    const c = only(driver, "pad-ledger-as-generated");
    expect(c.verdict).toBe("fail");
    const line = c.evidence.find((l) => l.startsWith("f1: stopped") && l.includes("TapWaitTimeout"))!;
    expect(line, `no TapWaitTimeout line in the evidence: ${JSON.stringify(c.evidence)}`).toBeDefined();
    expect(line, line).toMatch(/^f1: stopped after event 3 of 3: tap 2 of 3 \(tile\) failed: TapWaitTimeout: locator\.waitFor: Timeout 15000ms exceeded\. \(\[redacted\] — last taps: \[/);
    const timings = JSON.parse(/last taps: (\[.*\])$/.exec(line)![1]!) as Array<{ tap: number; clickedAtMs: number; ledgerSeenAtMs: number | null; waitedMs: number; budgetMs: number }>;
    // The ring is the last 5 of the 8 taps made; the timed-out tap is the last.
    expect(timings.map((t) => t.tap)).toEqual([4, 5, 6, 7, 8]);
    expect(timings.at(-1)).toMatchObject({ waitedMs: FLOOR_MS, budgetMs: FLOOR_MS });
    expect(timings.slice(0, -1).map((t) => t.waitedMs)).toEqual([0, 0, 0, 0]);
    // Relative to the driver's own start (the clock already read 5000 when it was built): a tap is paced TAP_PACE_MS
    // after the one before it, the release is not paced, and the first tap of the case reads 0.
    const P = TAP_PACE_MS;
    expect(timings.map((t) => t.clickedAtMs)).toEqual([2 * P, 3 * P, 3 * P, 4 * P, 5 * P]);
    // Event 2's taps (4-6) saw their row; event 3's (7, 8) never did.
    expect(timings.map((t) => t.ledgerSeenAtMs !== null)).toEqual([true, true, true, false, false]);
    // Redacted: the positive control is that the raw error line IS secret-shaped.
    expect(findSecrets(`locator.waitFor: Timeout ${FLOOR_MS}ms exceeded. (DATABASE_URL=${SECRET})`)).not.toEqual([]);
    expect(c.evidence.flatMap((l) => findSecrets(l))).toEqual([]);
    expect(line).not.toContain("db.invalid");
  });

  it("the pad write goes through the write stamp (carry N-1): a pad score at the window's end restarts the public page's freshness window", async () => {
    const windowMs = publicFreshnessMs({ holdMs: 3000 });
    const stale = { readPublicUi: async () => ({ tables: [uiRows("Bob", "Ann")], champion: null }) };
    const ref = (b: { compSlug: string; divSlug: string }) => ({ orgSlug: ORG_SLUG, competitionSlug: b.compSlug, divisionSlug: b.divSlug });
    // Control: no write after the build — one read decides.
    const clockA = fakeClock();
    const a = make({ http: padHttp(), pads: PADS, replay: fakeReplay(OK).fn, clock: clockA, pages: stale });
    const bA = await built(a.driver, spec("league"));
    clockA.t = windowMs;
    await a.driver.publicStandings(ref(bA));
    expect(clockA.sleeps).toEqual([]);
    // A pad score at t = window: the page is polled for a whole window again.
    const clockB = fakeClock();
    const b = make({ http: padHttp(), pads: PADS, replay: fakeReplay(OK).fn, clock: clockB, pages: stale });
    const bB = await built(b.driver, spec("league"));
    clockB.t = windowMs;
    await b.driver.postStream("f1", EVENTS, "p");
    await b.driver.publicStandings(ref(bB));
    expect(clockB.sleeps.length).toBe(Math.ceil(windowMs / SLACK_MS));
  });

  it("pictures: before and after every pad write, the second must differ; the mid-sheet picture once per case, at the first number step", async () => {
    let n = 0;
    const page = { evaluate: async () => ({ scrollWidth: 320, clientWidth: 320 }), screenshot: async () => new Uint8Array([++n]) };
    const replay = fakeReplay(async (_call, deps) => {
      for (const step of [{ kind: "tile", tileId: "setScore" }, { kind: "number", value: 21 }, { kind: "confirm" }, { kind: "number", value: 13 }] as const) await deps.onTap?.(0, step);
      return OK;
    });
    const { driver } = make({ http: padHttp(), pads: PADS, replay: replay.fn, padPolicy: "all", page });
    await built(driver, spec("league"));
    await driver.postStream("f1", EVENTS, "p");
    await driver.postStream("f1", EVENTS, "q");
    const v = only(driver, "visual-evidence");
    expect(v).toMatchObject({ verdict: "pass", checked: 5 });
    expect(v.reason).toMatch(/2 must-differ pair\(s\) differ/);
    expect(v.evidence.map((e) => e.split(":")[0])).toEqual(["08-pad-before", "08-pad-sheet", "08-pad-scored", "08-pad-before-2", "08-pad-scored-2"]);
  });
});

// Ruling 47 / D2 (W1-driving Task 3): the browser adds an entrant by name, so
// addEntrants keeps its browser coverage, and seeds the roster as HTTP
// filler. entrantMembers and putLineup are filler too. Transitions, the empty
// case first: an add with no members → an add with members → a later add (the
// http path, members inline) → the lineup calls.
describe("BrowserDriver — the roster seam is setup filler (ruling 47, W1-driving Task 3)", () => {
  const roster = (e: number) => [1, 2, 3].map((m) => ({ fullName: `Matrix Player ${e}.${m}`, squadNumber: m, isCaptain: m === 1 }));
  const teams = (withMembers: readonly boolean[], from = 1) => withMembers.map((w, i) => ({ displayName: `Matrix Team ${from + i}`, seed: from + i, kind: "team" as const, ...(w ? { members: roster(from + i) } : {}) }));
  /** The UI's add lands in the same fake product the http side reads, one row per input, as typed (entrants.ts addEntrantsUi). */
  const uiAdd = async (http: FakeHttp, divisionId: string, es: readonly EntrantIn[]) =>
    (await http.addEntrants(divisionId, es.map((e, i) => ({ displayName: e.displayName, seed: e.seed ?? i + 1, kind: e.kind })))).map((r, i) => ({ ...r, kind: es[i]!.kind }));
  const uiAddsTo = (http: FakeHttp): Partial<BrowserPages> => ({ addEntrantsUi: async (_c, w, es) => uiAdd(http, w.divisionId, es) });

  it("empty case first: a browser add without members seeds nothing — no setMembers, no filler", async () => {
    const http = new FakeHttp(ORG);
    const { driver } = make({ http, pages: uiAddsTo(http) });
    const b = await built(driver, spec("league"));
    await driver.addEntrants(b.divId, teams([false, false]));
    expect(http.calls).not.toContain("setMembers");
    expect(driver.fillers).toEqual({});
  });

  it("a browser add with members: the page gets names only, then setMembers over HTTP for each entrant that has members — filler, while addEntrants counts as the browser run", async () => {
    const http = new FakeHttp(ORG);
    const { driver, pageArgs } = make({ http, pages: uiAddsTo(http) });
    const b = await built(driver, spec("league"));
    const out = await driver.addEntrants(b.divId, teams([true, false, true]));
    expect(out.map((e) => e.display_name)).toEqual(["Matrix Team 1", "Matrix Team 2", "Matrix Team 3"]);
    // The page object was handed display names, seeds and kinds — no members.
    const handed = pageArgs.addEntrantsUi![0]![2] as Record<string, unknown>[];
    expect(handed.map((e) => Object.keys(e).sort())).toEqual([["displayName", "kind", "seed"], ["displayName", "kind", "seed"], ["displayName", "kind", "seed"]]);
    expect(http.calls.filter((c) => c === "setMembers")).toHaveLength(2);
    expect(await http.entrantMembers("e1")).toEqual([1, 2, 3].map((m) => ({ person_id: `p-e1-${m}`, squad_number: m, is_captain: m === 1 })));
    expect(await http.entrantMembers("e2")).toEqual([]);
    expect((await http.entrantMembers("e3")).length).toBe(3);
    expect(driver.fillers).toEqual({ setMembers: 2 });
    expect(only(driver, "mixed-driver-coverage")).toMatchObject({ verdict: "pass", checked: 3 });
  });

  it("a later add takes the http path: members ride inline on the create, and no filler is counted for it", async () => {
    const http = new FakeHttp(ORG);
    const { driver, pageCalls } = make({ http, pages: uiAddsTo(http) });
    const b = await built(driver, spec("league"));
    await driver.addEntrants(b.divId, teams([true]));
    await driver.addEntrants(b.divId, teams([true, true], 2));
    expect(pageCalls.filter((c) => c === "addEntrantsUi")).toHaveLength(1);
    expect(driver.fillers).toEqual({ setMembers: 1 });
    // The fake re-ids a bulk add from e1: the http add stored both rosters itself.
    expect((await http.entrantMembers("e1")).length).toBe(3);
    expect((await http.entrantMembers("e2")).length).toBe(3);
  });

  it("entrantMembers and putLineup never touch the page: each reaches HTTP once, is counted as filler, and coverage is exactly what it was", async () => {
    const http = new FakeHttp(ORG);
    const { driver, pageCalls } = make({ http, pages: uiAddsTo(http) });
    const b = await built(driver, spec("league"));
    await driver.addEntrants(b.divId, teams([true, true]));
    const f = http.seat(1, "e1", "e2");
    const coverage = only(driver, "mixed-driver-coverage");
    const pages = pageCalls.length;
    // I-1: the HTTP side's lineup check reaches the caller untouched. The
    // page built the division, so the fake product learns its sport here.
    await http.createDivision("c1", { name: "Matrix", slug: "d", sportKey: "football", variantKey: "11-a-side" });
    const real = http.putLineup.bind(http);
    const answered: unknown[] = [];
    http.putLineup = async (...a) => { const out = await real(...a); answered.push(out); return out; };
    const members = await driver.entrantMembers("e1");
    const check = await driver.putLineup(f.id, "e1", members.map((m, i) => ({ person_id: m.person_id, slot: "starting" as const, order_no: i + 1, roles: [] })));
    expect(answered).toHaveLength(1);
    expect(check).toEqual(answered[0]);
    expect(check).toMatchObject({ checked: true });
    expect(pageCalls.length).toBe(pages);
    expect(http.calls.filter((c) => c === "entrantMembers" || c === "putLineup")).toEqual(["entrantMembers", "putLineup"]);
    expect(http.lineups.get(`${f.id}|e1`)?.map((s) => s.person_id)).toEqual(["p-e1-1", "p-e1-2", "p-e1-3"]);
    expect(driver.fillers).toEqual({ setMembers: 2, entrantMembers: 1, putLineup: 1 });
    expect(only(driver, "mixed-driver-coverage")).toEqual(coverage);
  });

  it("W1-driving T6 (ruling 47): confirmSeedProposal and recomputeSeedProposal never touch the page — each reaches HTTP once, is counted as filler, and its answer or refusal passes through", async () => {
    const http = new FakeHttp(ORG);
    const { driver, pageCalls } = make({ http, pages: uiAddsTo(http) });
    await built(driver, spec("league"));
    const pages = pageCalls.length;
    const coverage = only(driver, "mixed-driver-coverage");
    const confirmed = { proposalId: "sp-2-1", filled: 4, fixtures: [] };
    const proposal = { id: "sp-2-2", status: "draft", qualifiers: [], ties: [] };
    const sent: unknown[] = [];
    http.confirmSeedProposal = async (stageId, body) => { http.log("confirmSeedProposal"); sent.push([stageId, body]); return confirmed; };
    http.recomputeSeedProposal = async (stageId) => { http.log("recomputeSeedProposal"); sent.push([stageId]); return proposal; };
    expect(await driver.confirmSeedProposal("s2", { proposalId: "sp-2-1" })).toBe(confirmed);
    expect(await driver.recomputeSeedProposal("s2")).toBe(proposal);
    expect(sent).toEqual([["s2", { proposalId: "sp-2-1" }], ["s2"]]);
    http.confirmSeedProposal = async () => { http.log("confirmSeedProposal"); throw new RefusedCall("POST", "/api/v1/stages/s2/seed-proposal/confirm", 409, "SEEDING_PROPOSAL_STALE", "stale"); };
    await expect(driver.confirmSeedProposal("s2", { proposalId: "sp-2-1" })).rejects.toMatchObject({ code: "SEEDING_PROPOSAL_STALE" });
    expect(pageCalls.length).toBe(pages);
    expect(http.calls.filter((c) => c.endsWith("SeedProposal"))).toEqual(["confirmSeedProposal", "recomputeSeedProposal", "confirmSeedProposal"]);
    expect(driver.fillers).toEqual({ confirmSeedProposal: 2, recomputeSeedProposal: 1 });
    expect(only(driver, "mixed-driver-coverage")).toEqual(coverage);
  });

  it("W1-driving T7 (ruling 47): a ladder challenge never touches the page — it reaches HTTP once per call, is counted as filler, and its answer or refusal passes through", async () => {
    const http = new FakeHttp(ORG);
    const { driver, pageCalls } = make({ http, pages: uiAddsTo(http) });
    await built(driver, spec("league"));
    const pages = pageCalls.length;
    const coverage = only(driver, "mixed-driver-coverage");
    const answer = { fixture_id: "f9", ladder_order: ["e1", "e2"] };
    const sent: unknown[] = [];
    http.challenge = async (stageId, challengerId, opponentId) => { http.log("challenge", stageId, challengerId, opponentId); sent.push([stageId, challengerId, opponentId]); return answer; };
    expect(await driver.challenge("s1", "e2", "e1")).toBe(answer);
    expect(sent).toEqual([["s1", "e2", "e1"]]);
    http.challenge = async () => { http.log("challenge"); throw new RefusedCall("POST", "/api/v1/stages/s1/challenges", 422, "LADDER_ENTRANT_WITHDRAWN", "withdrawn"); };
    await expect(driver.challenge("s1", "e2", "e1")).rejects.toMatchObject({ code: "LADDER_ENTRANT_WITHDRAWN" });
    expect(pageCalls.length).toBe(pages);
    expect(http.calls.filter((c) => c === "challenge")).toEqual(["challenge", "challenge"]);
    expect(driver.fillers).toEqual({ challenge: 2 });
    expect(only(driver, "mixed-driver-coverage")).toEqual(coverage);
  });

  it("W1-driving T8 (D9): the americano view never touches the page — it reaches HTTP once per call, is counted as filler, and its answer or refusal passes through", async () => {
    const http = new FakeHttp(ORG);
    const { driver, pageCalls } = make({ http, pages: uiAddsTo(http) });
    await built(driver, spec("league"));
    const pages = pageCalls.length;
    const coverage = only(driver, "mixed-driver-coverage");
    const answer = { mode: "americano" as const, rounds: [], leaderboard: [] };
    const sent: string[] = [];
    http.americanoView = async (stageId) => { http.log("americanoView", stageId); sent.push(stageId); return answer; };
    expect(await driver.americanoView("s1")).toBe(answer);
    expect(sent).toEqual(["s1"]);
    http.americanoView = async () => { http.log("americanoView"); throw new RefusedCall("GET", "/api/v1/stages/s1/americano", 422, "VALIDATION", "not an americano stage"); };
    await expect(driver.americanoView("s1")).rejects.toMatchObject({ status: 422 });
    expect(pageCalls.length).toBe(pages);
    expect(http.calls.filter((c) => c === "americanoView")).toEqual(["americanoView", "americanoView"]);
    expect(driver.fillers).toEqual({ americanoView: 2 });
    expect(only(driver, "mixed-driver-coverage")).toEqual(coverage);
  });

  it("a refused lineup is the product's RefusedCall, passed through, and still counted as the filler call it was", async () => {
    const http = new FakeHttp(ORG);
    const { driver } = make({ http, pages: uiAddsTo(http) });
    const b = await built(driver, spec("league"));
    await driver.addEntrants(b.divId, teams([true, true]));
    const f = http.seat(1, "e1", "e2");
    const e = await driver.putLineup(f.id, "e1", [{ person_id: "p-e2-1", slot: "starting", roles: [] }]).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(RefusedCall);
    expect((e as RefusedCall).status).toBe(422);
    expect(driver.fillers).toEqual({ setMembers: 2, putLineup: 1 });
  });

  it("guard: a UI answer that does not line up with the inputs is refused by name before any member is seeded", async () => {
    const http = new FakeHttp(ORG);
    const { driver } = make({ http, pages: { addEntrantsUi: async (_c, w, es) => (await uiAdd(http, w.divisionId, es)).reverse() } });
    const b = await built(driver, spec("league"));
    const e = await driver.addEntrants(b.divId, teams([true, true])).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(DriverMisuse);
    expect((e as Error).message).toMatch(/Matrix Team 1/);
    expect(http.calls).not.toContain("setMembers");
    expect(driver.fillers).toEqual({});
  });
});

// W1-driving Task 13 (ruling 47, D11): the two template-only cells are built
// through their gallery card — ONE organiser act creates the competition, the
// division and its stages, so both creation types run in the browser and no
// stage body is ever posted. The fake product's instantiation reads the
// catalog JSON itself (fake-driver.ts), never through lib/templates.ts.
describe("BrowserDriver — the template card path (W1-driving Task 13)", () => {
  const CATALOG = resolve(REPO, "apps/web/src/server/templates/catalog");
  const rawStages = (key: string) => (JSON.parse(readFileSync(join(CATALOG, `${key}.json`), "utf8")) as { divisions: { stages: { kind: string; groups?: number }[] }[] }).divisions[0]!.stages;
  const boxSpec = () => spec("group_only", "badminton", { variant: "short", template: "box-league", caseId: "group_only|badminton|short|LIFECYCLE" });
  /** The card, as the fake product answers it: the product instantiates, the page hands back its answer. */
  const cardOn = (http: FakeHttp, over: Partial<FromTemplateAnswer> = {}): Partial<BrowserPages> => ({
    createFromTemplateUi: async (_c, key) => ({ ...http.instantiateTemplate(key), ...over }),
  });
  const input = { name: "Matrix group_only|badminton|short|LIFECYCLE", endsOn: TEMPLATE_ENDS_ON };

  it("empty case first: a case with no template never drives a card — createFromTemplate is refused by name, nothing is created", async () => {
    const http = new FakeHttp(ORG);
    const { driver, pageCalls } = make({ http, spec: spec("league") });
    await expect(driver.createFromTemplate("box-league", input)).rejects.toBeInstanceOf(DriverMisuse);
    expect([pageCalls, http.calls]).toEqual([[], []]);
  });

  it("the browser path's read-back is handed the key the case ASKED for, not the one the card answered — so HttpDriver's templateKey guard holds on this path too (T13-R1 m-7)", async () => {
    const http = new FakeHttp(ORG);
    const { driver } = make({ http, spec: boxSpec(), pages: cardOn(http, { templateKey: "t20-super8" }) });
    await driver.createFromTemplate("box-league", input);
    expect(http.trace.filter((l) => l.startsWith("readBackTemplate"))).toEqual(["readBackTemplate box-league"]);
  });

  it("a template case calls createFromTemplateUi(\"box-league\"), records createCompetition AND createDivision as browser actions, never posts a stage, and has no organiser-ui-path check", async () => {
    const http = new FakeHttp(ORG);
    const { driver, pageCalls, pageArgs } = make({ http, spec: boxSpec(), pages: cardOn(http) });
    const out = await driver.createFromTemplate("box-league", input);
    expect(pageCalls).toEqual(["createFromTemplateUi"]);
    expect(pageArgs.createFromTemplateUi![0]!.slice(1)).toEqual(["box-league", input]);
    // The read-back is the http side's; the HTTP create never ran, and no stage was posted anywhere.
    expect(http.calls).toEqual(["instantiateTemplate", "readBackTemplate"]);
    expect({ sport: out.division.sportKey, variant: out.division.variantKey, kinds: out.stages.map((s) => s.kind) }).toEqual({ sport: "badminton", variant: "short", kinds: rawStages("box-league").map((s) => s.kind) });
    expect(only(driver, "mixed-driver-coverage")).toMatchObject({ verdict: "pass", checked: 2, evidence: [] });
    expect(driver.checks().filter((c) => c.id === "organiser-ui-path")).toEqual([]);
    // The division the card built is the one every later page object acts in.
    await driver.addEntrants(out.division.id, [{ displayName: "Matrix Player 1", seed: 1, kind: "individual" }]);
    expect(pageArgs.addEntrantsUi![0]![1]).toEqual({ compSlug: out.competition.slug, divSlug: out.division.slug, divisionId: out.division.id });
    await driver.postStages(out.division.id, stagesForRow("group_only")).catch(() => undefined);
    expect(http.calls.filter((c) => c === "postStages")).toEqual(["postStages"]); // only the explicit call above, over http
  });

  it("setUpDivision on the template case: the card, never postStages, the template's own 16 entrants, and life-built-as-posted judged against the catalog JSON", async () => {
    const http = new FakeHttp(ORG);
    const s = boxSpec();
    const { driver, pageCalls } = make({ http, spec: s, pages: { ...cardOn(http), addEntrantsUi: async (_c, w, es) => (await http.addEntrants(w.divisionId, es.map((e, i) => ({ displayName: e.displayName, seed: e.seed ?? i + 1, kind: e.kind })))).map((r, i) => ({ ...r, kind: es[i]!.kind })) } });
    const ctx = { driver, spec: s, orgSlug: ORG_SLUG, cfg: resolveSportCfg(s.sport, s.variant), tag: "t13", denied: [] };
    const setup = await setUpDivision(ctx, new Recorder(), fieldSizeFor(s.row, "LIFECYCLE", s.template));
    expect(pageCalls.filter((c) => c === "createFromTemplateUi" || c === "createCompetitionUi" || c === "createDivisionUi")).toEqual(["createFromTemplateUi"]);
    expect(http.calls).not.toContain("postStages");
    expect(http.calls).not.toContain("createCompetition");
    expect(http.calls).not.toContain("createDivision");
    // D11: the template's own field, read here from the catalog JSON.
    const field = (JSON.parse(readFileSync(join(CATALOG, "box-league.json"), "utf8")) as { divisions: { entrantCount: number }[] }).divisions[0]!.entrantCount;
    expect(setup.entrants.length).toBe(field);
    expect(setup.built.posted.entrants.length).toBe(field);
    // What was "posted" is the catalog's shape: sport, variant and every stage's kind and config.
    expect({ sport: setup.built.posted.sport, variant: setup.built.posted.variant, config: setup.built.posted.config }).toEqual({ sport: "badminton", variant: "short", config: {} });
    expect(setup.built.posted.stages.map((b) => ({ seq: b.seq, kind: b.kind, config: b.config }))).toEqual(rawStages("box-league").map((st, i) => ({ seq: i + 1, kind: st.kind, config: { pools: { count: st.groups } } })));
    // Judged with no fixture observed (the fake Start seats none): every item but the seating holds.
    const verdict = builtAsPosted(setup.built, { stages: [] } as never);
    expect(verdict.checked).toBeGreaterThan(field);
    expect(verdict.evidence.filter((e) => !/is seated in no fixture/.test(e))).toEqual([]);
    expect(only(driver, "mixed-driver-coverage")).toMatchObject({ verdict: "pass" });
  });

  it("the sequence: a second card in the same case goes over http (both types used their browser turn), recorded as http", async () => {
    const http = new FakeHttp(ORG);
    const { driver, pageCalls } = make({ http, spec: boxSpec(), pages: cardOn(http) });
    await driver.createFromTemplate("box-league", input);
    await driver.createFromTemplate("box-league", input);
    expect(pageCalls).toEqual(["createFromTemplateUi"]);
    expect(http.calls).toEqual(["instantiateTemplate", "readBackTemplate", "createFromTemplate"]);
    expect(only(driver, "mixed-driver-coverage")).toMatchObject({ verdict: "pass", checked: 2 });
  });

  it("guards, each by name: another template than the case's, a plain createCompetition on a template case, a createDivision after the card", async () => {
    const http = new FakeHttp(ORG);
    const { driver, pageCalls } = make({ http, spec: boxSpec(), pages: cardOn(http) });
    await expect(driver.createFromTemplate("t20-super8", input)).rejects.toThrow(/carries template box-league/);
    await expect(driver.createCompetition({ name: "x", slug: "x" })).rejects.toThrow(/created by its card/);
    expect(pageCalls).toEqual([]);
    const out = await driver.createFromTemplate("box-league", input);
    const e = await driver.createDivision(out.competition.id, { name: "x", slug: "d", sportKey: "badminton", variantKey: "short" }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(DriverMisuse);
    expect((e as Error).message).toContain("built through catalog template box-league");
    expect(http.calls.filter((c) => c === "createDivision")).toEqual([]);
  });

  it("the read-back's refusals pass through and register nothing: a competition in another org, a degraded visibility", async () => {
    for (const [what, err] of [["org", new OrgMismatch(ORG, "org-other")], ["visibility", new VisibilityDegraded("tmpl-box-league")]] as const) {
      const http = new FakeHttp(ORG);
      http.readBackTemplate = async () => { http.log("readBackTemplate"); throw err; };
      const { driver } = make({ http, spec: boxSpec(), pages: cardOn(http) });
      await expect(driver.createFromTemplate("box-league", input), what).rejects.toBe(err);
      const add = await driver.addEntrants("d1", [{ displayName: "Matrix Player 1", seed: 1, kind: "individual" }]).catch((x: unknown) => x);
      expect(add, what).toBeInstanceOf(DriverMisuse);
    }
  });

  it("the setup filler on the template path goes to HTTP and is counted as filler: setMembers, putLineup, confirmSeedProposal, challenge, americanoView — no page object, coverage untouched", async () => {
    const http = new FakeHttp(ORG);
    const row = (e: { displayName: string; seed: number; kind: "individual" | "team" | "pair" }, i: number) => ({ id: `e${i + 1}`, display_name: e.displayName, seed: e.seed, status: "registered", kind: e.kind });
    const { driver, pageCalls } = make({ http, spec: boxSpec(), pages: { ...cardOn(http), addEntrantsUi: async (_c, _w, es) => es.map((e, i) => row({ displayName: e.displayName, seed: e.seed ?? i + 1, kind: e.kind }, i)) } });
    http.setMembers = async () => { http.log("setMembers"); return []; };
    http.putLineup = async () => { http.log("putLineup"); return { checked: true, warnings: [] }; };
    http.confirmSeedProposal = async () => { http.log("confirmSeedProposal"); return { proposalId: "p", filled: 0, fixtures: [] }; };
    http.challenge = async () => { http.log("challenge"); return { fixture_id: "f", ladder_order: [] }; };
    http.americanoView = async () => { http.log("americanoView"); return { mode: "americano", rounds: [], leaderboard: [] }; };
    const out = await driver.createFromTemplate("box-league", input);
    // setMembers rides on a browser add with members (the roster seam, D2).
    await driver.addEntrants(out.division.id, [{ displayName: "Matrix Team 1", seed: 1, kind: "team", members: [{ fullName: "P", squadNumber: 1, isCaptain: true }] }]);
    const coverage = only(driver, "mixed-driver-coverage");
    const pages = pageCalls.length;
    await driver.putLineup("f1", "e1", [{ person_id: "p", slot: "starting", roles: [] }]);
    await driver.confirmSeedProposal(out.stages[0]!.id, { proposalId: "p" });
    await driver.challenge(out.stages[0]!.id, "e2", "e1");
    await driver.americanoView(out.stages[0]!.id);
    expect(driver.fillers).toEqual({ setMembers: 1, putLineup: 1, confirmSeedProposal: 1, challenge: 1, americanoView: 1 });
    expect(http.calls.filter((c) => ["setMembers", "putLineup", "confirmSeedProposal", "challenge", "americanoView"].includes(c))).toEqual(["setMembers", "putLineup", "confirmSeedProposal", "challenge", "americanoView"]);
    // No filler reached a page object: the only browser acts are the card and the add.
    expect(pageCalls).toEqual(["createFromTemplateUi", "addEntrantsUi"]);
    expect(pageCalls.length).toBe(pages);
    expect(only(driver, "mixed-driver-coverage")).toEqual(coverage);
    expect(coverage).toMatchObject({ verdict: "pass", checked: 3, evidence: [] });
  });
});

// W1d Task 12, fix round 1 (ruling T12-I1): the two-innings route shipped inert
// because no committed plan reached it. A seam is proven only by driving it
// through its REAL producer and consumer, so this plays what `--set pad-innings`
// PLANS — its own output, not a hand-built case — through the real scenario's
// own loop (setUpDivision, then playStage's decideFixture for every fixture),
// the real BrowserDriver, the real cricket adapter and the real replay, on a
// pad modelled on what Step 0 saw each cricket route write. The product behind
// them is the league fake, which folds every row the pad writes through the
// engine as the product does. Expected values: which streams the pad cannot
// write is the ADAPTER's declaration (noControl); how many innings a side bats
// is the ENGINE's cfg; the pad's turn is the SCENARIO's own padPolicy.
describe(`BrowserDriver — the case ${PAD_INNINGS_SET} plans, driven (W1d T12 fix round 1)`, () => {
  /** The fake product: the league fake, whose ledger is its fixtures' own events. */
  class PadProduct extends FakeHttp {
    override ledger(fixtureId: string, sinceSeq = 0): Promise<readonly LedgerRow[]> {
      this.log("ledger");
      return Promise.resolve(this.rowsOf(fixtureId).filter((r) => r.seq > sinceSeq));
    }
    rowsOf(fixtureId: string): LedgerRow[] {
      const f = this.fixtures.find((x) => x.id === fixtureId);
      if (f === undefined) throw new Error(`fake product: no fixture ${fixtureId}`);
      return f.events.map((e, i) => ({ id: `${fixtureId}-${i + 1}`, seq: i + 1, type: e.type, payload: e.payload }));
    }
  }

  it("the planned case is played to its end: the pad writes the first stream it CAN, every stream it cannot goes over http to W2, and the stream it wrote is four innings — the two-innings route", async () => {
    // The planner's own output, the way run.ts asks for it: the builder default is the variant it is handed.
    const planned = padInningsPlanner({}).plan(() => offlineBuilderDefault("cricket"));
    expect(planned).toHaveLength(1);
    const s = planned[0]!;
    expect(s.overrides).toBeUndefined(); // an override would be refused at createDivision (OVERRIDE_ROUTE, W2): no path, no pad
    const policy = SCENARIOS[s.scenario].padPolicy ?? "first";
    expect(policy).toBe("first"); // LIFECYCLE's: one pad stream a case, the rest http
    const cfg = resolveSportCfg(s.sport, s.variant) as { inningsPerSide: number };
    expect(cfg.inningsPerSide).toBe(2);

    const http = new PadProduct(ORG);
    let open: FakeFixture | null = null;
    const page = modelPage(async (taps) => {
      const f = open;
      if (f === null) throw new Error("the pad released a hold with no console opened");
      const rows = twoInningsModel({ cfg: http.cfg, entrants: { home: f.home_entrant_id!, away: f.away_entrant_id! } })(taps, http.rowsOf(f.id));
      if (rows.length > 0) await http.postStream(f.id, rows.map((r) => ({ type: r.type, payload: r.payload })), "pad");
    });
    const pages: Partial<BrowserPages> = {
      createDivisionUi: async (_c, _slug, compId, input) => {
        const ref = await http.createDivision(compId, { name: input.name, slug: PRODUCT_DIV_SLUG, sportKey: input.sportKey, variantKey: input.variantKey, config: {} });
        await http.postStages(ref.id, stagesForRow(input.row));
        return { division: { id: ref.id, competition_id: compId, name: input.name, slug: PRODUCT_DIV_SLUG, sport_key: input.sportKey, variant_key: input.variantKey, config: ref.config, status: "draft" }, stages: builtFrom(input.row, ref.id) };
      },
      // The UI's add lands in the same fake product the http side reads, one row per input, as typed (entrants.ts addEntrantsUi).
      addEntrantsUi: async (_c, w, es) => (await http.addEntrants(w.divisionId, es.map((e, i) => ({ displayName: e.displayName, seed: e.seed ?? i + 1, kind: e.kind })))).map((r, i) => ({ ...r, kind: es[i]!.kind })),
      startUi: async () => http.start(),
      generateUi: async () => http.generate(),
      openFixtureUi: async (_c, _w, no) => { open = http.fixtures.find((f) => f.fixture_no === no) ?? null; },
    };
    // The REAL replay, recording what the driver hands it: the stream the scenario generated (the ledger holds the pad's rows, not that).
    const handed: (readonly StreamEvent[])[] = [];
    const replay: Replay = (pg, adapter, events, ...rest) => { handed.push(events); return replayEvents(pg, adapter, events, ...rest); };
    const { driver, pageArgs } = make({ http, spec: s, pages, page, padPolicy: policy, pads: PAD_ADAPTERS, replay });
    const ctx = { driver, spec: s, orgSlug: ORG_SLUG, cfg: resolveSportCfg(s.sport, s.variant), tag: "t12", denied: [] };
    const rec = new Recorder();
    const setup = await setUpDivision(ctx, rec, fieldSizeFor(s.row, s.scenario));
    await playStage(ctx, rec, setup);

    // What the scenario decided, in the order it decided it: a stream is one the pad cannot write when it holds an event the adapter has no control for.
    const barred = new Set(cricketPad.noControl!.eventTypes);
    const streams = [...rec.streams.entries()].map(([id, events]) => ({ id, events, tappable: !events.some((e) => barred.has(e.type)) }));
    const tappable = streams.filter((x) => x.tappable);
    const cannot = streams.filter((x) => !x.tappable);
    console.info(`pad-innings: ${streams.length} fixture(s) decided, ${tappable.length} tappable, ${cannot.length} barred`);
    expect(streams.length).toBeGreaterThan(0);
    expect(streams.length).toBe(http.fixtures.length); // every fixture was decided, none skipped
    expect(cannot.length).toBeGreaterThan(0); // the test preset's win/home (follow-on) and draw (time close) streams are barred: the route to W2 ran
    expect(tappable.length).toBeGreaterThan(0); // …and the route this set exists for was reachable by the scenario's own outcomes

    // Under `first` the pad took exactly the first tappable stream, and nothing the pad cannot write was tapped.
    const padFixtureNos = (pageArgs.openFixtureUi ?? []).map((a) => a[2] as number);
    expect(padFixtureNos).toEqual([http.fixtures.find((f) => f.id === tappable[0]!.id)!.fixture_no]);
    expect([...rec.storedFixtures]).toEqual([tappable[0]!.id]);
    // Every other stream went over the events route, whole: the product holds the stream the scenario generated, event for event.
    let overHttp = 0;
    for (const x of streams.filter((y) => y.id !== tappable[0]!.id)) {
      expect(http.trace, x.id).toContain(`postStream ${x.id}`);
      expect(http.fixtures.find((f) => f.id === x.id)!.events.map((e) => e.type), x.id).toEqual(x.events.map((e) => e.type));
      overHttp++;
    }
    expect(overHttp).toBe(streams.length - 1);
    expect(overHttp).toBeGreaterThan(0);

    // The stream the driver handed the pad is the two-innings route: two innings a side, four summaries — by the engine's cfg, not by the adapter.
    expect(handed).toHaveLength(1);
    const wrote = handed[0]!;
    expect(wrote.some((e) => barred.has(e.type))).toBe(false);
    expect(wrote.filter((e) => e.type === CRICKET_SUMMARY)).toHaveLength(2 * cfg.inningsPerSide);
    // …and the product's own ledger holds what the pad tapped, over sheets, to the same result (judged below as generated).
    const padFixture = http.fixtures.find((f) => f.id === tappable[0]!.id)!;
    expect(padFixture.events.length).toBeGreaterThan(wrote.length); // an innings is many over sheets, however few summaries the stream has
    expect(padFixture.status).toBe("decided");

    // The case's checks: the pad stream is judged as generated (every event of it), the barred ones abstain naming W2, and coverage holds.
    expect(only(driver, "pad-ledger-as-generated")).toMatchObject({ verdict: "pass", checked: wrote.length });
    expect(only(driver, "pad-route")).toMatchObject({ verdict: "abstain", checked: 0 });
    expect(only(driver, "pad-route").reason).toContain(`→ ${CRICKET_NO_CONTROL.wave}`);
    expect(only(driver, "mixed-driver-coverage")).toMatchObject({ verdict: "pass" });
  }, 120_000);
});

// W1d Task 13, item 22: completeStage tells the page object where the stage sits in its division, and the LAST
// stage's completion is always the browser's. Without the second half the first half is an inert seam: the mixed
// ledger spends a type's browser turn on the first completion, so a multi-stage case's LAST stage (the knockout)
// completed over HTTP and its picture was never taken. The positions below are the division's own (stage seq),
// learned from whichever path built or listed it.
describe("BrowserDriver — completeStage names the stage's place and shoots the last stage (W1d Task 13, item 22)", () => {
  /** A division whose stages the harness posts and lists over HTTP (the league fake holds one stage). */
  class StagedHttp extends FakeHttp {
    stages: StageRef[] = [];
    override postStages(_d: string, bodies: readonly { seq: number; kind: string }[]): Promise<StageRef[]> {
      this.log("postStages");
      this.stages = bodies.map((b, i) => ({ id: `h${i + 1}`, seq: b.seq, kind: b.kind, config: {}, status: "pending" }));
      return Promise.resolve(this.stages.map((s) => ({ ...s })));
    }
    override listStages(): Promise<StageRef[]> { this.log("listStages"); return Promise.resolve(this.stages.map((s) => ({ ...s }))); }
  }
  const places = (pageArgs: Record<string, unknown[][]>) => (pageArgs.completeStageUi ?? []).map((a) => ({ stage: a[2], at: a[3] }));

  it("a two-stage division built by the builder: the group stage is stage 1 (not last), the knockout is stage 2 (last), and BOTH go through the page", async () => {
    const { driver, http, pageCalls, pageArgs } = league({ spec: spec("groups_ko") });
    await built(driver, spec("groups_ko"));
    expect(stagesForRow("groups_ko").map((b) => b.seq)).toEqual([1, 2]);
    await driver.completeStage("s1");
    await driver.completeStage("s2");
    expect(places(pageArgs)).toEqual([{ stage: "s1", at: { ordinal: 1, last: false } }, { stage: "s2", at: { ordinal: 2, last: true } }]);
    expect(pageCalls.filter((c) => c === "completeStageUi")).toHaveLength(2);
    expect(http.calls).not.toContain("completeStage");
    expect(only(driver, "mixed-driver-coverage")).toMatchObject({ verdict: "pass" });
  });

  it("a one-stage division is stage 1 and last, completed once through the page", async () => {
    const { driver, http, pageArgs } = league();
    await built(driver, spec("league"));
    await driver.completeStage("s1");
    expect(places(pageArgs)).toEqual([{ stage: "s1", at: { ordinal: 1, last: true } }]);
    expect(http.calls).not.toContain("completeStage");
  });

  it("three stages (a template's group, group, knockout): the first and the last are the browser's, the middle one is completed over http", async () => {
    const http = new FakeHttp(ORG);
    const s = spec("group_group_ko", "cricket", { variant: "t20", template: "t20-super8", caseId: "group_group_ko|cricket|t20|LIFECYCLE" });
    // The league fake holds one stage: the card's answer is the three-stage one, read back through a stub of the product's list.
    const three = [1, 2, 3].map((n) => ({ id: `t${n}`, seq: n, kind: n < 3 ? "group" : "knockout", config: {}, status: "pending" }));
    const { driver, pageArgs } = make({
      http: Object.assign(http, {
        readBackTemplate: () => Promise.resolve({
          competition: { id: "c1", slug: "t20", orgId: ORG },
          division: { id: "d1", slug: "main", sportKey: "cricket", variantKey: "t20", config: {} },
          stages: three,
        }),
      }),
      spec: s,
      pages: { createFromTemplateUi: async () => ({ competitionId: "c1", slug: "t20", visibility: "public", divisions: [{ id: "d1", stages: three.map((t) => ({ id: t.id, fixtureCount: 0 })) }], templateKey: "t20-super8", templateVersion: 1 }) },
    });
    await driver.createFromTemplate("t20-super8", { name: "Matrix", endsOn: TEMPLATE_ENDS_ON });
    await driver.completeStage("t1");
    await driver.completeStage("t2");
    await driver.completeStage("t3");
    expect(places(pageArgs)).toEqual([{ stage: "t1", at: { ordinal: 1, last: false } }, { stage: "t3", at: { ordinal: 3, last: true } }]);
    expect(http.calls.filter((c) => c === "completeStage")).toHaveLength(1);
  });

  it("a division the harness built over http: the places come from the stages it posted, and from the stages it listed", async () => {
    // An API-only row: its division is the harness's own, over http. Generic's `score` variant is a real one.
    const gk = spec("group_group_ko", "generic", { variant: "score", caseId: "group_group_ko|generic|score|LIFECYCLE" });
    const posted = new StagedHttp(ORG);
    const a = make({ http: posted, spec: gk });
    const { divId } = await built(a.driver, gk);
    await a.driver.postStages(divId, stagesForRow("group_group_ko"));
    await a.driver.completeStage("h1");
    await a.driver.completeStage("h3");
    expect(places(a.pageArgs)).toEqual([{ stage: "h1", at: { ordinal: 1, last: false } }, { stage: "h3", at: { ordinal: 3, last: true } }]);
    // Stages only LISTED: the fake product holds them, the driver learns them from the read.
    const listed = new StagedHttp(ORG);
    const b = make({ http: listed, spec: gk });
    const made = await built(b.driver, gk);
    // Listed in REVERSE seq order: a place is by seq, never by the order the stages were learned in.
    listed.stages = stagesForRow("group_group_ko").map((x, i) => ({ id: `l${i + 1}`, seq: x.seq, kind: x.kind, config: {}, status: "pending" })).reverse();
    expect((await b.driver.listStages(made.divId)).map((x) => x.id)).toEqual(["l3", "l2", "l1"]);
    await b.driver.completeStage("l3");
    expect(places(b.pageArgs)).toEqual([{ stage: "l3", at: { ordinal: 3, last: true } }]);
  });

  it("the stages of ANOTHER division the driver listed never move a stage's place", async () => {
    const http = new StagedHttp(ORG);
    const { driver, pageArgs } = make({ http, spec: spec("groups_ko") });
    await built(driver, spec("groups_ko"));
    // A later seq in some other division: if places were taken across divisions, s2 would stop being last.
    http.stages = [{ id: "x1", seq: 5, kind: "league", config: {}, status: "pending" }];
    await driver.listStages("d-elsewhere");
    await driver.completeStage("s1");
    await driver.completeStage("s2");
    expect(places(pageArgs)).toEqual([{ stage: "s1", at: { ordinal: 1, last: false } }, { stage: "s2", at: { ordinal: 2, last: true } }]);
  });

  it("a stage no division of this driver holds is still refused by name before any page is touched", async () => {
    const { driver, pageCalls } = league({ spec: spec("groups_ko") });
    await built(driver, spec("groups_ko"));
    await expect(driver.completeStage("no-such-stage")).rejects.toThrow(DriverMisuse);
    expect(pageCalls.filter((c) => c === "completeStageUi")).toEqual([]);
  });

  it("a last stage the page already had its turn at is not offered it again: a refused attempt retries over http, as for every type, and a repeat after a completion is still refused", async () => {
    const refusing = { completeStageUi: async (_c: unknown, _w: unknown, id: unknown): Promise<{ completed: boolean; events: never[] }> => {
      if (id === "s2") throw new RefusedCall("POST", "/api/v1/stages/s2/complete", 409, "STAGE_NOT_READY", "not ready");
      return { completed: true, events: [] };
    } };
    const { driver, http, pageCalls } = league({ spec: spec("groups_ko"), pages: refusing as Partial<BrowserPages> });
    await built(driver, spec("groups_ko"));
    await driver.completeStage("s1");
    await expect(driver.completeStage("s2")).rejects.toThrow(RefusedCall);
    expect(await driver.completeStage("s2")).toMatchObject({ completed: true });
    expect(pageCalls.filter((c) => c === "completeStageUi")).toHaveLength(2);
    expect(http.calls.filter((c) => c === "completeStage")).toHaveLength(1);
    await expect(driver.completeStage("s2")).rejects.toThrow(DriverMisuse);
  });
});


describe("BrowserDriver — Void last entry, the date filler and the rail's hooks (W1d Task 14, items 15c-15e)", () => {
  const ROW = (seq: number, type: string, payload: unknown = {}): LedgerRow => ({ id: `r${seq}`, seq, type, payload });
  const START_ROW = ROW(1, "core.start");
  const SUMMARY_ROW = ROW(2, "badminton.game.summary", { home: 21, away: 5 });
  const NOTE_ROW = ROW(3, "core.note", { text: "n" });
  /** A console http side: the ledger is a mutable list; `voidLastUi` (the fake page) appends what the console would. */
  function consoleHttp(initial: LedgerRow[]) {
    const rows = [...initial];
    const http = stubHttp({
      listFixtures: async () => [fixture("f1", "s1", null, 4)],
      ledger: async (...a: never[]) => rows.filter((r) => r.seq > (a[1] as number)),
      voidLast: async () => ({ voidedEventId: "http", voidedType: "http" }),
    });
    return { http, rows };
  }
  const voidRow = (rows: LedgerRow[], names: string) => rows.push(ROW(rows.length + 1, "core.void", { event_id: names }));

  it("the browser's first void is the console's: the ledger is read first, the console opened by number, the control tapped — and the answer is what the LEDGER shows the console voided", async () => {
    const { http, rows } = consoleHttp([START_ROW, SUMMARY_ROW]);
    const { driver, pageCalls, pageArgs } = make({ http, pages: { voidLastUi: async () => { voidRow(rows, "r2"); return { seq: 3, status: "in_play", outcome: null, event_id: "r3" }; } } });
    await built(driver, spec("league"));
    expect(await driver.voidLast("f1")).toEqual({ voidedEventId: "r2", voidedType: "badminton.game.summary" });
    expect(pageCalls.slice(-2)).toEqual(["openFixtureUi", "voidLastUi"]);
    expect(pageArgs.openFixtureUi![0]![2]).toBe(4);
    expect(pageArgs.voidLastUi![0]![1]).toBe("f1");
    expect(http.calls).not.toContain("voidLast");
    expect(only(driver, "mixed-driver-coverage")).toMatchObject({ verdict: "pass" });
  });

  it("the answer is the console's CHOICE, not the harness's rule: a console that voided the start answers the start, so the scenario can fail it", async () => {
    const { http, rows } = consoleHttp([START_ROW, SUMMARY_ROW]);
    const { driver } = make({ http, pages: { voidLastUi: async () => { voidRow(rows, "r1"); return { seq: 3, status: "in_play", outcome: null, event_id: "r3" }; } } });
    await built(driver, spec("league"));
    expect(await driver.voidLast("f1")).toEqual({ voidedEventId: "r1", voidedType: "core.start" });
  });

  it("only the first void is the browser's: the second, over http, is HttpDriver's (the type keeps its coverage once)", async () => {
    const { http, rows } = consoleHttp([START_ROW, SUMMARY_ROW]);
    const { driver, pageCalls } = make({ http, pages: { voidLastUi: async () => { voidRow(rows, "r2"); return { seq: 3, status: "in_play", outcome: null, event_id: "r3" }; } } });
    await built(driver, spec("league"));
    await driver.voidLast("f1");
    expect(await driver.voidLast("f1")).toEqual({ voidedEventId: "http", voidedType: "http" });
    expect(pageCalls.filter((c) => c === "voidLastUi")).toHaveLength(1);
    expect(http.calls.filter((c) => c === "voidLast")).toHaveLength(1);
  });

  it("nothing to void — an empty ledger, or every event already voided — is refused by name before any page is touched", async () => {
    for (const [name, initial] of [["empty", []], ["voided", [START_ROW, ROW(2, "core.void", { event_id: "r1" })]]] as const) {
      const { http } = consoleHttp([...initial]);
      const { driver, pageCalls } = make({ http });
      await built(driver, spec("league"));
      const before = pageCalls.length;
      await expect(driver.voidLast("f1"), name).rejects.toThrow(/nothing to void/);
      expect(pageCalls.length, name).toBe(before);
    }
  });

  it("a console that answered but left no core.void after the tip is refused by name — never read as a void", async () => {
    const cases: [string, (rows: LedgerRow[]) => void, RegExp][] = [
      ["no row", () => undefined, /left no core\.void/],
      ["another row", (rows) => { rows.push(ROW(rows.length + 1, "core.note", { text: "x" })); }, /left no core\.void/],
      ["two rows", (rows) => { voidRow(rows, "r2"); voidRow(rows, "r1"); }, /2 ledger row/],
      ["names nothing", (rows) => { rows.push(ROW(rows.length + 1, "core.void", {})); }, /names no event/],
      ["names a non-string", (rows) => { rows.push(ROW(rows.length + 1, "core.void", { event_id: 2 })); }, /names no event/],
      ["names an unknown event", (rows) => { voidRow(rows, "zzz"); }, /unknown event zzz/],
    ];
    for (const [name, write, want] of cases) {
      const { http, rows } = consoleHttp([START_ROW, SUMMARY_ROW]);
      const { driver } = make({ http, pages: { voidLastUi: async () => { write(rows); return { seq: 3, status: "in_play", outcome: null, event_id: "r3" }; } } });
      await built(driver, spec("league"));
      await expect(driver.voidLast("f1"), name).rejects.toThrow(want);
    }
  });

  it("a fixture in no division this driver built is refused by name, and the ledger read passes straight through to the http side", async () => {
    const { http } = consoleHttp([START_ROW, SUMMARY_ROW, NOTE_ROW]);
    const { driver } = make({ http });
    await expect(driver.voidLast("f1")).rejects.toThrow(/in no division this driver built/);
    expect((await driver.ledger!("f1", 1)).map((r) => r.seq)).toEqual([2, 3]);
    expect((await driver.ledger!("f1")).map((r) => r.seq)).toEqual([1, 2, 3]);
  });

  describe("scheduleFixtureNow is setup filler: http, counted by name, never an organiser action", () => {
    it("answers the product's own instant, counts the filler, records no action type, and a fixture of no known division is refused before any write", async () => {
      const http = stubHttp({ listFixtures: async () => [fixture("f1", "s1", null, 4)], scheduleFixtureNow: async () => ({ scheduledAt: "2031-01-02T03:04:05.000Z" }) });
      const { driver } = make({ http });
      await expect(driver.scheduleFixtureNow("f1")).rejects.toThrow(/in no division this driver built/);
      expect(http.calls).not.toContain("scheduleFixtureNow");
      await built(driver, spec("league"));
      expect(await driver.scheduleFixtureNow("f1")).toEqual({ scheduledAt: "2031-01-02T03:04:05.000Z" });
      expect(driver.fillers).toMatchObject({ scheduleFixtureNow: 1 });
      expect(only(driver, "mixed-driver-coverage").evidence.join("\n")).not.toMatch(/scheduleFixtureNow/);
    });
  });

  describe("the rail's hooks: the fold's branch (15d) and the run sheet's default filter (15c, D17)", () => {
    const seen = (filter: string, rows: number[], branch: "opened" | "unfolded" = "unfolded", width: number | null = 1280) =>
      ({ fold: { branch, width }, defaultFilter: { filter, rows } });
    /** A match-day http side: two fixtures, #4 and #7, dated now; the desk answers `phase`. */
    function dayHttp(phase: string) {
      const phases: unknown[][] = [];
      const http = stubHttp({
        listFixtures: async () => [fixture("f1", "s1", null, 7), fixture("f2", "s1", null, 4), fixture("f3", "s1", null, 9)],
        scheduleFixtureNow: async () => ({ scheduledAt: "2031-01-02T03:04:05.000Z" }),
        divisionPhase: async (...a: never[]) => { phases.push(a); return phase; },
      });
      return { http, phases };
    }
    const railPages = (visit: ReturnType<typeof seen>, got: unknown[] = []): Partial<BrowserPages> => ({
      generateUi: async (_c, _w, _id, hooks) => { got.push(hooks); await hooks?.onRail?.(visit); return { created: 0, existing: 0, fixtures: [] }; },
      completeStageUi: async (_c, _w, _id, _at, hooks) => { got.push(hooks); await hooks?.onRail?.(visit); return { completed: true, events: [] }; },
    });
    const matchDay = (extra: Partial<CaseSpec> = {}) => spec("league", "badminton", { matchDay: true, ...extra });

    it("fold-branch: the first rail visit is judged against the width — 1280 unfolded passes, 320 opened passes, 1280 opened and 320 unfolded fail — once per case", async () => {
      for (const [branch, width, verdict] of [["unfolded", 1280, "pass"], ["opened", 320, "pass"], ["opened", 1280, "fail"], ["unfolded", 320, "fail"], ["opened", 767, "pass"], ["unfolded", 768, "pass"]] as const) {
        const { http } = dayHttp("scheduled");
        const { driver } = make({ http, pages: railPages(seen("all", [], branch, width)) });
        await built(driver, spec("league"));
        await driver.generate("s1");
        await driver.generate("s1");
        expect(driver.checks().filter((c) => c.id === "fold-branch"), `${branch}@${width}`).toHaveLength(1);
        expect(only(driver, "fold-branch"), `${branch}@${width}`).toMatchObject({ verdict, checked: 1 });
      }
    });

    it("fold-branch: a page that reported no viewport is a failure of its own, and a driver whose rail was never visited records no fold-branch at all", async () => {
      const { http } = dayHttp("scheduled");
      const a = make({ http, pages: railPages(seen("all", [], "unfolded", null)) });
      await built(a.driver, spec("league"));
      await a.driver.generate("s1");
      expect(only(a.driver, "fold-branch")).toMatchObject({ verdict: "fail" });
      const b = make({ http: dayHttp("scheduled").http });
      await built(b.driver, spec("league"));
      expect(b.driver.checks().some((c) => c.id === "fold-branch")).toBe(false);
    });

    it("a non-match-day case never asks the rail for the default filter, and records no runsheet-today-default (and reads no phase)", async () => {
      const { http, phases } = dayHttp("scheduled");
      const got: unknown[] = [];
      const { driver } = make({ http, pages: railPages(seen("all", [1, 2]), got) });
      await built(driver, spec("league", "badminton"));
      await driver.generate("s1");
      expect((got[0] as { readDefaultFilter?: boolean }).readDefaultFilter).toBe(false);
      expect(driver.checks().some((c) => c.id === "runsheet-today-default")).toBe(false);
      expect(phases).toEqual([]);
    });

    it("a match-day case asks the FIRST rail visit for the default filter and only that one; the phase is read through the desk with the competition and division ids", async () => {
      const { http, phases } = dayHttp("match_day");
      const got: unknown[] = [];
      const { driver } = make({ http, spec: matchDay(), pages: railPages(seen("today", [4, 7]), got) });
      await built(driver, matchDay());
      await driver.scheduleFixtureNow("f1");
      await driver.scheduleFixtureNow("f2");
      await driver.generate("s1");
      await driver.generate("s1");
      expect(got.map((h) => (h as { readDefaultFilter: boolean }).readDefaultFilter)).toEqual([true, false]);
      expect(phases).toEqual([["c1", "d1"]]);
      expect(driver.checks().filter((c) => c.id === "runsheet-today-default")).toHaveLength(1);
    });

    it("match day: 'today' showing exactly the fixtures this driver dated passes (dated 7 then 4); 'all', a missing or an extra row, and no filter at all fail", async () => {
      const cases: [string, ReturnType<typeof seen> | { fold: { branch: "unfolded"; width: number }; defaultFilter: null }, string][] = [
        // The sheet's rows arrive sorted (readDefaultFilter); the driver's dated list is sorted by it too (7 was dated before 4).
        ["pass", seen("today", [4, 7]), "pass"],
        ["all", seen("all", [4, 7, 9]), "fail"],
        ["missing", seen("today", [4]), "fail"],
        ["extra", seen("today", [4, 7, 9]), "fail"],
        ["no filter", { fold: { branch: "unfolded", width: 1280 }, defaultFilter: null }, "fail"],
      ];
      for (const [name, visit, verdict] of cases) {
        const { http } = dayHttp("match_day");
        const { driver } = make({ http, spec: matchDay(), pages: railPages(visit as ReturnType<typeof seen>) });
        await built(driver, matchDay());
        await driver.scheduleFixtureNow("f1");
        await driver.scheduleFixtureNow("f2");
        await driver.generate("s1");
        expect(only(driver, "runsheet-today-default"), name).toMatchObject({ verdict, checked: expect.any(Number) });
        if (verdict === "pass") expect(only(driver, "runsheet-today-default").checked, name).toBeGreaterThan(0);
      }
    });

    it("the phase guard: a match-day case whose desk phase is not match_day fails even when the sheet opened on 'all' as it should for that phase (the today default was never in force)", async () => {
      for (const phase of ["setting_up", "scheduled", "finished"]) {
        const { http } = dayHttp(phase);
        const { driver } = make({ http, spec: matchDay(), pages: railPages(seen("all", [4, 7, 9])) });
        await built(driver, matchDay());
        await driver.scheduleFixtureNow("f1");
        await driver.generate("s1");
        const c = only(driver, "runsheet-today-default");
        expect(c.verdict, phase).toBe("fail");
        expect(c.evidence.join("\n"), phase).toContain(phase);
      }
    });

    it("a match-day case that dated no fixture fails (not an abstain), and the default is judged once whichever visit came first", async () => {
      const { http } = dayHttp("match_day");
      const { driver } = make({ http, spec: matchDay(), pages: railPages(seen("today", [])) });
      await built(driver, matchDay());
      await driver.generate("s1");
      expect(only(driver, "runsheet-today-default")).toMatchObject({ verdict: "fail" });
    });

    it("completeStage takes the same hooks (the first visit may be the completion's), its place and then its hooks", async () => {
      const { http } = dayHttp("scheduled");
      const got: unknown[] = [];
      const { driver, pageArgs } = make({ http, pages: railPages(seen("all", [], "unfolded", 1280), got) });
      await built(driver, spec("league"));
      await driver.completeStage("s1");
      expect(pageArgs.completeStageUi![0]![3]).toEqual({ ordinal: 1, last: true });
      expect(typeof (got[0] as { onRail: unknown }).onRail).toBe("function");
      expect(only(driver, "fold-branch")).toMatchObject({ verdict: "pass" });
    });
  });
});
