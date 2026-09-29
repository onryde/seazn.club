// The organiser, through the real UI (W1c Task 6, design §6.1). Every organiser
// ACTION goes through a page object (lib/browser/pages) — the first of each
// type always, later ones over HTTP (ruling 15; MixedLedger) — and each
// resolves on the product's own answer to the click (actAndAwait), so a
// refusal is the same RefusedCall HttpDriver throws (Review Focus 4). Reads and
// probes are HTTP: the scenario needs the data, and the page is judged against
// it (the standings tab, the public page), never the other way round.
//
// What it records beside the scenario's own checks (checks()):
//  - organiser-ui-path: the builder built the division (pass), or no organiser
//    control builds this row (fail, naming the owning wave — D7), or only a
//    catalog template does (abstain, → W1-driving);
//  - builder-posted-as-harness: what the builder posted against the harness's
//    own bodies for the row, path by path;
//  - ui-standings-match / ui-public-standings-match / ui-champion-shown: the
//    tables and the banner the pages draw, against the API;
//  - finalize-ledger-row: the ONE core.finalize the console's Finalize left
//    (ruling D: the row is compared, never the route);
//  - mixed-driver-coverage, then the case's Evidence checks.
//
// Every wait is derived from the product's constants (AGENTS class 20;
// browser-budget.test.ts scans this file for a flat timeout).
import type { LedgerRow } from "../../../bench/lib/ledger.ts";
import { API_ONLY_ROWS, type ApiOnlyRowKey, type StagePostBody } from "../catalogue.ts";
import { SLACK_MS, budgetMs } from "../browser/budget.ts";
import { createCompetitionUi } from "../browser/pages/competition.ts";
import { boundActions, navBudget, type DivisionWhere, type PageCtx } from "../browser/pages/ctx.ts";
import { createDivisionUi, type StageOut } from "../browser/pages/division-builder.ts";
import { addEntrantsUi, withdrawUi } from "../browser/pages/entrants.ts";
import { finalizeUi, forfeitUi } from "../browser/pages/fixture-console.ts";
import { startUi } from "../browser/pages/launch.ts";
import { readPublicUi } from "../browser/pages/public-division.ts";
import { openFixtureUi } from "../browser/pages/run-sheet.ts";
import { completeStageUi, generateUi } from "../browser/pages/stage-rail.ts";
import { readStandingsUi, type UiTable } from "../browser/pages/standings.ts";
import type { CheckResult } from "../results.ts";
import { assertion, type Item } from "../scenarios/assertions.ts";
import type { CaseSpec } from "../scenarios/types.ts";
import type { StreamEvent } from "../streams/types.ts";
import type { HttpDriver } from "./http-driver.ts";
import { MixedLedger, type ActionType, type PadPolicy } from "./mixed.ts";
import {
  DriverMisuse, OrgMismatch, RefusedCall, VisibilityDegraded,
  type CompetitionRef, type CompleteOut, type DivisionRef, type EntrantKind, type EntrantRow, type FixtureRow,
  type FixtureStateOut, type GenerateOut, type OrganiserDriver, type PostedEvent, type ProbeOutcome,
  type PublicStandingsOut, type StageRef, type StagesProbe, type StandingsOut, type StartOut, type WithdrawOut,
} from "./types.ts";

/** The sport → pad adapter table Task 7 fills; empty until then. */
export type PadRegistry = Readonly<Partial<Record<string, unknown>>>;
export const EMPTY_PADS: PadRegistry = Object.freeze({});

/** The page objects the driver clicks through; injectable so its tests need no browser. */
export interface BrowserPages {
  readonly createCompetitionUi: typeof createCompetitionUi;
  readonly createDivisionUi: typeof createDivisionUi;
  readonly addEntrantsUi: typeof addEntrantsUi;
  readonly withdrawUi: typeof withdrawUi;
  readonly startUi: typeof startUi;
  readonly generateUi: typeof generateUi;
  readonly completeStageUi: typeof completeStageUi;
  readonly openFixtureUi: typeof openFixtureUi;
  readonly forfeitUi: typeof forfeitUi;
  readonly finalizeUi: typeof finalizeUi;
  readonly readStandingsUi: typeof readStandingsUi;
  readonly readPublicUi: typeof readPublicUi;
}
export const REAL_PAGES: BrowserPages = Object.freeze({
  createCompetitionUi, createDivisionUi, addEntrantsUi, withdrawUi, startUi, generateUi,
  completeStageUi, openFixtureUi, forfeitUi, finalizeUi, readStandingsUi, readPublicUi,
});

/** The HTTP side: every organiser call, plus the ledger read (HttpDriver.ledger). */
export type HttpSide = OrganiserDriver & Pick<HttpDriver, "ledger">;

export interface Clock { now(): number; sleep(ms: number): Promise<void> }
const REAL_CLOCK: Clock = { now: () => Date.now(), sleep: (ms) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }) };

/** `orgId`: the case org — the competition the UI creates must land there
 *  (OrgMismatch), as HttpDriver's `expectedOrgId`. `pages` and `clock` are
 *  seams for the unit suite. */
export interface BrowserDriverOptions {
  http: HttpSide;
  ctx: PageCtx;
  spec: CaseSpec;
  padPolicy: PadPolicy;
  pads: PadRegistry;
  orgId: string;
  pages?: BrowserPages;
  clock?: Clock;
}

/** D7 (plan; design §8's scopes): the wave that owns the organiser control each
 *  API-only row lacks. */
export const API_ONLY_UI_WAVE: Readonly<Record<ApiOnlyRowKey, string>> = Object.freeze({
  knockout_third_place: "W4", page_playoff_only: "W4", stepladder_only: "W4", group_only: "W5", group_group_ko: "W5",
});
/** The two API-only cells a catalog template does reach (template-card-<key>);
 *  W1c does not drive the gallery. */
export const TEMPLATE_ONLY_CELLS: Readonly<Record<string, string>> = Object.freeze({ "group_only|badminton": "box-league", "group_group_ko|cricket": "t20-super8" });
const TEMPLATE_DRIVING_WAVE = "W1-driving";

/** d/[divSlug]/page.tsx TABLE_KINDS (text-pinned): the organiser standings tab draws a table for these only. */
export const ORGANISER_TABLE_KINDS: ReadonlySet<string> = new Set(["league", "group", "swiss"]);
/** server/public-site/champion.ts BRACKET_KINDS (text-pinned): the public page draws these as a bracket, not a table. */
export const PUBLIC_BRACKET_KINDS: ReadonlySet<string> = new Set(["knockout", "double_elim", "stepladder", "page_playoff"]);
/** The public division page's `export const revalidate` (text-pinned): it may serve a render this old. */
export const PUBLIC_REVALIDATE_S = 30;
/** The ledger row both finalize paths append (fixture-console.tsx send, scoring.ts finalizeFixture; text-pinned). */
export const FINALIZE_EVENT = "core.finalize";
/** The completion event the scenario reads finalRanks from (common.ts finishStage). */
const STAGE_COMPLETED = "stage_completed";

/** How long the public view may take to show what the API already answers:
 *  one revalidate window, then the navigation that brings the fresh render. */
export function publicFreshnessMs(c: Pick<PageCtx, "holdMs">): number {
  return budgetMs({ base: PUBLIC_REVALIDATE_S * 1000 + navBudget(c), holdMs: c.holdMs });
}

/** Ruling C: the public page never matched the API within its freshness
 *  bound. A stale render is never a verdict, so this is a named refusal, not a
 *  mismatch; the last difference is named so a real one can be read. */
export class PublicViewNeverFresh extends Error {
  readonly attempts: number;
  readonly ms: number;
  constructor(attempts: number, ms: number, last: readonly string[]) {
    super(`browser: the public division page never matched the API within ${ms} ms (${attempts} read(s); it revalidates every ${PUBLIC_REVALIDATE_S} s) — a stale page is never a verdict; last difference: ${last.slice(0, 3).join("; ") || "(none recorded)"}`);
    this.name = "PublicViewNeverFresh";
    this.attempts = attempts;
    this.ms = ms;
  }
}

export interface NamedTable { label: string; rows: readonly { rank: number; name: string }[] }

const byRank = <R extends { rank: number }>(rows: readonly R[]): R[] => [...rows].sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99));
const orderOf = (rows: readonly { rank: number; name: string }[]) => rows.map((r) => `${r.rank} ${r.name}`).join(", ");
const namesOf = (rows: readonly { name: string }[]) => rows.map((r) => r.name).sort();

/** The page's tables against the API's. A table carries no pool identity on
 *  the page and no pool NAME over v1 (ruling E), so tables are paired by the
 *  product's own identity for a pool — its members: first an identical table,
 *  then one with the same members (an order difference, named), and what is
 *  left over on either side is named. The API's rows are compared in rank
 *  order, as StandingsTable sorts them. */
export function compareTables(api: readonly NamedTable[], ui: readonly UiTable[]): { ok: boolean; checked: number; evidence: string[] } {
  const evidence: string[] = [];
  const left = ui.map((t, i) => ({ i, rows: t.rows, used: false }));
  const pending: NamedTable[] = [];
  for (const a of api) {
    const rows = byRank(a.rows);
    const same = left.find((u) => !u.used && orderOf(u.rows) === orderOf(rows));
    if (same !== undefined) same.used = true;
    else pending.push({ label: a.label, rows });
  }
  for (const a of pending) {
    const members = JSON.stringify(namesOf(a.rows));
    const pool = left.find((u) => !u.used && JSON.stringify(namesOf(u.rows)) === members);
    if (pool !== undefined) {
      pool.used = true;
      evidence.push(`${a.label}: page order ${orderOf(pool.rows)}; API order ${orderOf(a.rows)}`);
    } else {
      evidence.push(`${a.label}: the page draws no table with its ${a.rows.length} entrant(s) (${namesOf(a.rows).join(", ")})`);
    }
  }
  for (const u of left) if (!u.used) evidence.push(`page table #${u.i + 1} (${namesOf(u.rows).join(", ")}) matches no API table`);
  return { ok: evidence.length === 0, checked: Math.max(api.length, ui.length), evidence };
}

/** Key-sorted, undefined read as null: the shape both sides are compared in. */
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return Object.fromEntries(Object.keys(o).sort().map((k) => [k, sortKeys(o[k])]));
  }
  return v === undefined ? null : v;
}
const show = (v: unknown) => (v === undefined ? "(absent)" : JSON.stringify(v));
function diffPaths(path: string, a: unknown, b: unknown, out: string[]): void {
  if (JSON.stringify(a) === JSON.stringify(b)) return;
  const isObj = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === "object" && !Array.isArray(x);
  if (isObj(a) && isObj(b)) {
    for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) diffPaths(`${path}.${k}`, a[k], b[k], out);
    return;
  }
  out.push(`${path}: built ${show(a)}, harness ${show(b)}`);
}
type Comparable = { seq: number; kind: string; config?: unknown; progression?: unknown };
function bySeq(stages: readonly Comparable[], side: string, out: string[]): Map<number, { kind: string; config: unknown; progression: unknown }> {
  const m = new Map(stages.map((s) => [s.seq, { kind: s.kind, config: sortKeys(s.config ?? {}), progression: sortKeys(s.progression ?? null) }]));
  if (m.size !== stages.length) out.push(`${side}: two stages share a seq (${stages.map((s) => s.seq).join(", ")})`);
  return m;
}

/** What the builder posted against the harness's bodies for the same row:
 *  kind, config and progression by seq, keys sorted; ids, names and statuses
 *  are the product's and are not judged. */
export function builderVsHarness(built: readonly StageOut[], bodies: readonly StagePostBody[]): CheckResult {
  const evidence: string[] = [];
  const b = bySeq(built, "built", evidence);
  const h = bySeq(bodies, "harness", evidence);
  for (const seq of [...new Set([...b.keys(), ...h.keys()])].sort((x, y) => x - y)) {
    const x = b.get(seq);
    const y = h.get(seq);
    if (x === undefined || y === undefined) evidence.push(`stage[${seq}]: built ${x?.kind ?? "(none)"}, harness ${y?.kind ?? "(none)"}`);
    else diffPaths(`stage[${seq}]`, x, y, evidence);
  }
  const checked = Math.max(built.length, bodies.length);
  if (checked === 0) return { id: "builder-posted-as-harness", kind: "assertion", verdict: "fail", checked: 0, reason: "vacuous: neither the builder nor the harness has a stage (checked 0 is a failure)", evidence: [] };
  return evidence.length === 0
    ? { id: "builder-posted-as-harness", kind: "assertion", verdict: "pass", checked, reason: `${checked} stage(s) built exactly as the harness's bodies`, evidence: [] }
    : { id: "builder-posted-as-harness", kind: "assertion", verdict: "fail", checked, reason: `the builder posted other than the harness's bodies: ${evidence[0]}`, evidence };
}

const toStageRef = (s: StageOut): StageRef => ({ id: s.id, seq: s.seq, kind: s.kind, config: s.config, status: s.status });
const isApiOnly = (row: string): row is ApiOnlyRowKey => (API_ONLY_ROWS as readonly string[]).includes(row);
type ChampionWant = { kind: "abstain"; reason: string } | { kind: "fail"; note: string } | { kind: "name"; name: string };

export class BrowserDriver implements OrganiserDriver {
  readonly #http: HttpSide;
  readonly #ctx: PageCtx;
  readonly #spec: CaseSpec;
  readonly #policy: PadPolicy;
  readonly #pads: PadRegistry;
  readonly #orgId: string;
  readonly #pages: BrowserPages;
  readonly #clock: Clock;
  readonly #ledger = new MixedLedger();
  readonly #checks: CheckResult[] = [];
  readonly #finalized: Item[] = [];
  /** competition id → the product's slug; only competitions whose org and visibility held. */
  readonly #competitions = new Map<string, string>();
  /** division id → where it lives, in the product's slugs. */
  readonly #wheres = new Map<string, DivisionWhere>();
  /** stage id → its division id. */
  readonly #stageDivision = new Map<string, string>();
  /** The builder's answer, until the harness's one postStages for that division consumes it. */
  #built: { divisionId: string; stages: StageOut[] } | null = null;
  #uiPathJudged = false;
  /** Stages completed, or whose complete ended unknown: never completed again (design §6.4). */
  readonly #completed = new Set<string>();
  /** stage id → the finalRanks its completion answered (null: none). */
  readonly #finalRanks = new Map<string, readonly string[] | null>();
  #uiCalls = 0;

  constructor(o: BrowserDriverOptions) {
    this.#http = o.http;
    this.#ctx = o.ctx;
    this.#spec = o.spec;
    this.#policy = o.padPolicy;
    this.#pads = o.pads;
    this.#orgId = o.orgId;
    this.#pages = o.pages ?? REAL_PAGES;
    this.#clock = o.clock ?? REAL_CLOCK;
    // Ruling F: every tap no page object bounds itself is one step's budget.
    boundActions(o.ctx.page, o.ctx);
  }

  get callCount(): number { return this.#uiCalls + this.#http.callCount; }

  checks(): CheckResult[] {
    const fin = this.#finalized.length === 0 ? [] : [assertion("finalize-ledger-row", this.#finalized)];
    return [...this.#checks, ...fin, this.#ledger.coverage(), ...this.#ctx.evidence.checks()];
  }

  #ui<T>(act: (p: BrowserPages) => Promise<T>): Promise<T> {
    this.#uiCalls++;
    return act(this.#pages);
  }

  #wants(a: ActionType): boolean { return this.#ledger.wantsBrowser(a, this.#policy); }

  #whereOf(divisionId: string): DivisionWhere {
    const w = this.#wheres.get(divisionId);
    if (w === undefined) throw new DriverMisuse(`browser: division ${divisionId} was not created by this driver — no page object can find it (known: ${[...this.#wheres.keys()].join(", ") || "none"})`);
    return w;
  }

  #whereOfStage(stageId: string): DivisionWhere {
    const d = this.#stageDivision.get(stageId);
    if (d === undefined) throw new DriverMisuse(`browser: stage ${stageId} belongs to no division this driver built or listed — its rail cannot be found`);
    return this.#whereOf(d);
  }

  #register(divisionId: string, compSlug: string, divSlug: string): void {
    this.#wheres.set(divisionId, { compSlug, divSlug, divisionId });
  }

  async #names(divisionId: string): Promise<Map<string, string>> {
    return new Map((await this.#http.listEntrants(divisionId)).map((e) => [e.id, e.display_name]));
  }

  async #findFixture(fixtureId: string): Promise<{ where: DivisionWhere; row: FixtureRow; no: number }> {
    for (const where of this.#wheres.values()) {
      const row = (await this.#http.listFixtures(where.divisionId)).find((f) => f.id === fixtureId);
      if (row === undefined) continue;
      if (row.fixture_no === null) throw new DriverMisuse(`browser: fixture ${fixtureId} has no fixture number — the run sheet opens a console by its number`);
      return { where, row, no: row.fixture_no };
    }
    throw new DriverMisuse(`browser: fixture ${fixtureId} is in no division this driver built — the run sheet cannot find its row`);
  }

  async createCompetition(input: { name: string; slug: string }): Promise<CompetitionRef> {
    if (!this.#wants("createCompetition")) {
      this.#ledger.record("createCompetition", "http");
      const ref = await this.#http.createCompetition(input);
      this.#competitions.set(ref.id, ref.slug);
      return ref;
    }
    this.#ledger.record("createCompetition", "browser");
    // The wizard takes no slug: the product picks it, and the answer is the one authority.
    const c = await this.#ui((p) => p.createCompetitionUi(this.#ctx, { name: input.name }));
    // The same refusals HttpDriver makes (http-driver.ts createCompetition).
    if (c.org_id !== this.#orgId) throw new OrgMismatch(this.#orgId, c.org_id);
    if (c.visibility !== "unlisted") throw new VisibilityDegraded(c.slug);
    this.#competitions.set(c.id, c.slug);
    return { id: c.id, slug: c.slug, orgId: c.org_id };
  }

  /** D7: an API-only row has no organiser control; the text names who owns it. */
  #judgeApiOnlyPath(row: ApiOnlyRowKey): string {
    const cell = `${row}|${this.#spec.sport}`;
    const template = Object.prototype.hasOwnProperty.call(TEMPLATE_ONLY_CELLS, cell) ? TEMPLATE_ONLY_CELLS[cell] : null;
    const text = template === null
      ? `no organiser control builds ${row} → ${API_ONLY_UI_WAVE[row]}`
      : `reachable only through catalog template ${template}; driving it → ${TEMPLATE_DRIVING_WAVE}`;
    if (!this.#uiPathJudged) {
      this.#uiPathJudged = true;
      this.#checks.push(template === null ? assertion("organiser-ui-path", [{ ok: false, note: text }]) : assertion("organiser-ui-path", [], text));
    }
    return text;
  }

  async createDivision(competitionId: string, input: { name: string; slug: string; sportKey: string; variantKey: string; config?: Record<string, unknown> }): Promise<DivisionRef> {
    const compSlug = this.#competitions.get(competitionId);
    if (compSlug === undefined) throw new DriverMisuse(`browser: competition ${competitionId} was not created by this driver, or was refused — there is no slug to build a division in`);
    const row = this.#spec.row;
    const apiOnly = isApiOnly(row);
    if (apiOnly || !this.#wants("createDivision")) {
      this.#ledger.record("createDivision", "http");
      if (apiOnly) this.#ledger.exempt("createDivision", this.#judgeApiOnlyPath(row));
      const ref = await this.#http.createDivision(competitionId, input);
      this.#register(ref.id, compSlug, ref.slug);
      return ref;
    }
    const override = Object.keys(input.config ?? {});
    if (override.length > 0) throw new DriverMisuse(`browser: the division builder cannot carry a rule override (${override.join(", ")}) — an override case has no organiser path to build it here`);
    this.#ledger.record("createDivision", "browser");
    const { division, stages } = await this.#ui((p) => p.createDivisionUi(this.#ctx, compSlug, competitionId,
      { name: input.name, sportKey: input.sportKey, variantKey: input.variantKey, row }));
    this.#register(division.id, compSlug, division.slug);
    for (const s of stages) this.#stageDivision.set(s.id, division.id);
    this.#built = { divisionId: division.id, stages };
    if (!this.#uiPathJudged) {
      this.#uiPathJudged = true;
      this.#checks.push(assertion("organiser-ui-path", [{ ok: true, note: `the division builder built ${row}` }]));
    }
    return { id: division.id, slug: division.slug, sportKey: division.sport_key, variantKey: division.variant_key, config: division.config ?? {} };
  }

  getDivision(divisionId: string): Promise<DivisionRef> { return this.#http.getDivision(divisionId); }

  /** The builder already posted its stages: the harness's post for that
   *  division is judged against them and answered with what the organiser
   *  really got. Any other post is the harness's own, over HTTP. */
  async postStages(divisionId: string, stages: readonly StagePostBody[]): Promise<StageRef[]> {
    const b = this.#built;
    if (b !== null && b.divisionId === divisionId) {
      this.#built = null;
      this.#checks.push(builderVsHarness(b.stages, stages));
      return b.stages.map(toStageRef);
    }
    const out = await this.#http.postStages(divisionId, stages);
    for (const s of out) this.#stageDivision.set(s.id, divisionId);
    return out;
  }

  async listStages(divisionId: string): Promise<StageRef[]> {
    const out = await this.#http.listStages(divisionId);
    for (const s of out) this.#stageDivision.set(s.id, divisionId);
    return out;
  }

  async addEntrants(divisionId: string, entrants: readonly { displayName: string; seed: number; kind: EntrantKind }[]): Promise<EntrantRow[]> {
    if (!this.#wants("addEntrants")) {
      this.#ledger.record("addEntrants", "http");
      return this.#http.addEntrants(divisionId, entrants);
    }
    const where = this.#whereOf(divisionId);
    this.#ledger.record("addEntrants", "browser");
    return this.#ui((p) => p.addEntrantsUi(this.#ctx, where, entrants.map((e) => ({ displayName: e.displayName, seed: e.seed, kind: e.kind }))));
  }

  listEntrants(divisionId: string): Promise<EntrantRow[]> { return this.#http.listEntrants(divisionId); }

  async start(divisionId: string): Promise<StartOut> {
    if (!this.#wants("start")) {
      this.#ledger.record("start", "http");
      return this.#http.start(divisionId);
    }
    const where = this.#whereOf(divisionId);
    this.#ledger.record("start", "browser");
    return this.#ui((p) => p.startUi(this.#ctx, where));
  }

  async generate(stageId: string): Promise<GenerateOut> {
    if (!this.#wants("generate")) {
      this.#ledger.record("generate", "http");
      return this.#http.generate(stageId);
    }
    const where = this.#whereOfStage(stageId);
    this.#ledger.record("generate", "browser");
    return this.#ui((p) => p.generateUi(this.#ctx, where, stageId));
  }

  listFixtures(divisionId: string): Promise<FixtureRow[]> { return this.#http.listFixtures(divisionId); }
  fixtureState(fixtureId: string): Promise<FixtureStateOut> { return this.#http.fixtureState(fixtureId); }

  /** The pad path is Task 7's: until then a sport with a pad, under a policy
   *  that wants the browser, is refused by name rather than scored over HTTP
   *  and counted as covered. */
  async postStream(fixtureId: string, events: readonly StreamEvent[], idempotencyPrefix: string): Promise<PostedEvent[]> {
    if (this.#wants("score") && Object.prototype.hasOwnProperty.call(this.#pads, this.#spec.sport)) {
      throw new DriverMisuse(`browser: the ${this.#spec.sport} pad path lands in Task 7 — this driver cannot score it yet`);
    }
    this.#ledger.record("score", "http");
    return this.#http.postStream(fixtureId, events, idempotencyPrefix);
  }

  async forfeit(fixtureId: string, byEntrantId: string, reason: "walkover" | "retired hurt", idempotencyPrefix: string): Promise<PostedEvent[]> {
    if (!this.#wants("forfeit")) {
      this.#ledger.record("forfeit", "http");
      return this.#http.forfeit(fixtureId, byEntrantId, reason, idempotencyPrefix);
    }
    const { where, row, no } = await this.#findFixture(fixtureId);
    this.#ledger.record("forfeit", "browser");
    await this.#ui((p) => p.openFixtureUi(this.#ctx, where, no));
    return this.#ui((p) => p.forfeitUi(this.#ctx, row, byEntrantId, reason));
  }

  async withdraw(entrantId: string): Promise<WithdrawOut> {
    if (!this.#wants("withdraw")) {
      this.#ledger.record("withdraw", "http");
      return this.#http.withdraw(entrantId);
    }
    for (const where of this.#wheres.values()) {
      const e = (await this.#http.listEntrants(where.divisionId)).find((x) => x.id === entrantId);
      if (e === undefined) continue;
      this.#ledger.record("withdraw", "browser");
      return this.#ui((p) => p.withdrawUi(this.#ctx, where, { id: e.id, displayName: e.display_name }));
    }
    throw new DriverMisuse(`browser: entrant ${entrantId} is in no division this driver built — the entrants tab cannot find its row`);
  }

  async completeStage(stageId: string): Promise<CompleteOut> {
    if (this.#completed.has(stageId)) {
      throw new DriverMisuse(`browser: stage ${stageId} already completed, or its complete ended unknown — /complete is never repeated (design §6.4)`);
    }
    const where = this.#wants("completeStage") ? this.#whereOfStage(stageId) : null;
    this.#ledger.record("completeStage", where === null ? "http" : "browser");
    let out: CompleteOut;
    try {
      out = where === null ? await this.#http.completeStage(stageId) : await this.#ui((p) => p.completeStageUi(this.#ctx, where, stageId));
    } catch (e) {
      // As HttpDriver: a named 4xx committed nothing and stays retryable; any
      // other ending may follow a committed completion, so it is never repeated.
      if (!(e instanceof RefusedCall && e.status < 500)) this.#completed.add(stageId);
      throw e;
    }
    if (out.completed) {
      this.#completed.add(stageId);
      this.#finalRanks.set(stageId, out.events.find((ev) => ev.type === STAGE_COMPLETED)?.finalRanks ?? null);
    }
    return out;
  }

  rebuild(stageId: string): Promise<void> { return this.#http.rebuild(stageId); }

  /** The API's tables for every stage the organiser tab draws (TABLE_KINDS):
   *  one per pool its fixtures sit in, or the stage's own when they sit in none. */
  async #organiserTables(divisionId: string): Promise<{ kinds: string[]; tables: NamedTable[] | null }> {
    const stages = [...await this.listStages(divisionId)].sort((a, b) => a.seq - b.seq);
    const kinds = [...new Set(stages.map((s) => s.kind))];
    const drawn = stages.filter((s) => ORGANISER_TABLE_KINDS.has(s.kind));
    if (drawn.length === 0) return { kinds, tables: null };
    const fixtures = await this.#http.listFixtures(divisionId);
    const names = await this.#names(divisionId);
    const tables: NamedTable[] = [];
    for (const s of drawn) {
      const pools = [...new Set(fixtures.filter((f) => f.stage_id === s.id).map((f) => f.pool_id))];
      for (const pool of pools.length > 0 ? pools : [null]) {
        const t = await this.#http.standings(s.id, pool);
        tables.push({ label: `${s.kind} stage ${s.seq}${pool === null ? "" : ` pool ${pool}`}`, rows: t.rows.map((r) => ({ rank: r.rank, name: names.get(r.entrantId) ?? r.entrantId })) });
      }
    }
    return { kinds, tables };
  }

  async standings(stageId: string, poolId: string | null): Promise<StandingsOut> {
    const where = this.#wants("standingsView") ? this.#whereOfStage(stageId) : null;
    const out = await this.#http.standings(stageId, poolId);
    this.#ledger.record("standingsView", where === null ? "http" : "browser");
    if (where === null) return out;
    const ui = await this.#ui((p) => p.readStandingsUi(this.#ctx, where));
    const api = await this.#organiserTables(where.divisionId);
    if (api.tables === null) {
      const kinds = api.kinds.join(", ") || "a division with no stage";
      this.#checks.push(ui.length === 0
        ? assertion("ui-standings-match", [], `no organiser table for ${kinds}`)
        : assertion("ui-standings-match", [{ ok: false, note: `the page draws ${ui.length} table(s) for ${kinds}, which the organiser tab draws no table for` }]));
      return out;
    }
    const r = compareTables(api.tables, ui);
    this.#checks.push(r.checked === 0
      ? { id: "ui-standings-match", kind: "assertion", verdict: "fail", checked: 0, reason: "vacuous: a table stage, and no table on either side (checked 0 is a failure)", evidence: [] }
      : { id: "ui-standings-match", kind: "assertion", verdict: r.ok ? "pass" : "fail", checked: r.checked, reason: r.ok ? `${r.checked} table(s) drawn as the API ranks them` : r.evidence[0], evidence: r.evidence });
    return out;
  }

  #whereOfRef(ref: { orgSlug: string; competitionSlug: string; divisionSlug: string }): DivisionWhere {
    const w = [...this.#wheres.values()].find((x) => x.compSlug === ref.competitionSlug && x.divSlug === ref.divisionSlug);
    if (ref.orgSlug !== this.#ctx.orgSlug || w === undefined) {
      throw new DriverMisuse(`browser: public ref ${ref.orgSlug}/${ref.competitionSlug}/${ref.divisionSlug} is not a division this driver built in ${this.#ctx.orgSlug} — the page would read another division than the API`);
    }
    return w;
  }

  /** Who the public banner must crown: a bracket's champion is finalRanks[0]
   *  of its completion (champion.ts crowns a bracket by its final); a table
   *  stage's banner is proven by its table. */
  #championWant(stages: readonly StageRef[], names: ReadonlyMap<string, string>): ChampionWant {
    const decisive = [...stages].sort((a, b) => b.seq - a.seq)[0];
    if (decisive === undefined) return { kind: "abstain", reason: "the division has no stage" };
    if (!PUBLIC_BRACKET_KINDS.has(decisive.kind)) return { kind: "abstain", reason: `the decisive stage is a ${decisive.kind} — its table is the proof` };
    if (!this.#finalRanks.has(decisive.id)) return { kind: "abstain", reason: `the decisive ${decisive.kind} stage was not completed by this case` };
    const ranks = this.#finalRanks.get(decisive.id);
    if (ranks === null || ranks === undefined || ranks.length === 0) return { kind: "fail", note: `the decisive ${decisive.kind} stage completed with no finalRanks — nothing names its champion` };
    return { kind: "name", name: names.get(ranks[0]) ?? ranks[0] };
  }

  async publicStandings(ref: { orgSlug: string; competitionSlug: string; divisionSlug: string }): Promise<PublicStandingsOut> {
    const where = this.#wants("publicView") ? this.#whereOfRef(ref) : null;
    const out = await this.#http.publicStandings(ref);
    this.#ledger.record("publicView", where === null ? "http" : "browser");
    if (where !== null) await this.#judgePublic(where, out);
    return out;
  }

  /** Ruling C: the page is read until it matches, within publicFreshnessMs;
   *  a stale render is never judged. */
  async #judgePublic(where: DivisionWhere, out: PublicStandingsOut): Promise<void> {
    const stages = await this.listStages(where.divisionId);
    const names = await this.#names(where.divisionId);
    const stage = new Map(stages.map((s) => [s.id, s]));
    const api: NamedTable[] = out.standings
      .filter((s) => !PUBLIC_BRACKET_KINDS.has(stage.get(s.stage_id)?.kind ?? ""))
      .map((s) => ({
        label: `${stage.get(s.stage_id)?.kind ?? "unknown"} stage ${stage.get(s.stage_id)?.seq ?? s.stage_id}${s.pool_id === null ? "" : ` pool ${s.pool_id}`}`,
        rows: s.rows.map((r) => ({ rank: r.rank, name: names.get(r.entrantId) ?? r.entrantId })),
      }));
    const want = this.#championWant(stages, names);
    const deadline = publicFreshnessMs(this.#ctx);
    const t0 = this.#clock.now();
    for (let attempts = 1; ; attempts++) {
      const view = await this.#ui((p) => p.readPublicUi(this.#ctx, where));
      const tables = compareTables(api, view.tables);
      const crowned = want.kind !== "name" || view.champion === want.name;
      if (tables.ok && crowned) {
        const bracketsOnly = [...new Set(stages.map((s) => s.kind))].join(", ") || "no stage";
        this.#checks.push(tables.checked === 0
          ? assertion("ui-public-standings-match", [], `no table to compare: the API publishes none and the page draws none (${bracketsOnly})`)
          : { id: "ui-public-standings-match", kind: "assertion", verdict: "pass", checked: tables.checked, reason: `${tables.checked} table(s) drawn as the API ranks them, on read ${attempts}`, evidence: [] });
        this.#checks.push(want.kind === "abstain" ? assertion("ui-champion-shown", [], want.reason)
          : want.kind === "fail" ? assertion("ui-champion-shown", [{ ok: false, note: want.note }])
          : assertion("ui-champion-shown", [{ ok: true, note: `the banner names ${want.name}` }]));
        return;
      }
      const last = [...tables.evidence, ...(crowned ? [] : [`champion: the banner names ${view.champion ?? "nobody"}; want ${(want as { name: string }).name}`])];
      if (this.#clock.now() - t0 >= deadline) throw new PublicViewNeverFresh(attempts, deadline, last);
      await this.#clock.sleep(SLACK_MS);
    }
  }

  patchDivisionConfig(divisionId: string, config: Record<string, unknown>): Promise<ProbeOutcome> { return this.#http.patchDivisionConfig(divisionId, config); }
  replaceStagesProbe(divisionId: string, stages: readonly StagePostBody[]): Promise<StagesProbe> { return this.#http.replaceStagesProbe(divisionId, stages); }

  /** Finalize is always the console's (not an ACTION_TYPES entry): the tap,
   *  then the ledger row it left after the tip it was read at — exactly one,
   *  a core.finalize, at the seq the console's answer names (ruling D). */
  async finalize(fixtureId: string): Promise<FixtureStateOut> {
    const { where, no } = await this.#findFixture(fixtureId);
    const tip = (await this.#http.fixtureState(fixtureId)).last_seq;
    await this.#ui((p) => p.openFixtureUi(this.#ctx, where, no));
    const posted = await this.#ui((p) => p.finalizeUi(this.#ctx, fixtureId));
    const rows: readonly LedgerRow[] = await this.#http.ledger(fixtureId, tip);
    const row = rows[0];
    this.#finalized.push(rows.length !== 1 || row === undefined
      ? { ok: false, note: `${fixtureId}: ${rows.length} ledger rows after seq ${tip}, want exactly one ${FINALIZE_EVENT}` }
      : row.type !== FINALIZE_EVENT
        ? { ok: false, note: `${fixtureId}: seq ${row.seq} is ${row.type}, not ${FINALIZE_EVENT}` }
        : row.seq !== posted.seq
          ? { ok: false, note: `${fixtureId}: the ledger's ${FINALIZE_EVENT} is seq ${row.seq}, the console's answer seq ${posted.seq}` }
          : { ok: true, note: `${fixtureId}: seq ${row.seq} ${FINALIZE_EVENT}` });
    return this.#http.fixtureState(fixtureId);
  }
}
