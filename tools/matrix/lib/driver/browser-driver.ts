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
//    control builds this row (fail, naming the owning wave — D7). A
//    template-only cell has no such check: its case carries the template, and
//    the gallery card builds competition, division and stages in one act
//    (createFromTemplate, W1-driving Task 13, ruling 47);
//  - builder-posted-as-harness: what the builder posted against the harness's
//    own bodies for the row, path by path;
//  - ui-standings-match / ui-public-standings-match / ui-champion-shown: the
//    tables and the banner the pages draw, against the API. The public page
//    is re-read until it matches or its freshness window (its own revalidate
//    plus its data cache's) has passed since the case's last write; what still
//    differs then is a FAIL verdict (ruling C as amended, fix round 1);
//  - finalize-ledger-row: the ONE core.finalize the console's Finalize left
//    (ruling D: the row is compared, never the route);
//  - pad-ledger-as-generated (W1c Task 7): every event the pad scored, each
//    row it wrote compared with the generated event (pads/replay.ts), across
//    every fixture the case scored on the pad; pad-route abstains, naming the
//    W1c task that owes the adapter, when the case's sport has none;
//  - mixed-driver-coverage, then the case's Evidence checks.
//
// Every wait is derived from the product's constants (AGENTS class 20;
// browser-budget.test.ts scans this file for a flat timeout).
import type { LedgerRow } from "../../../bench/lib/ledger.ts";
import { API_ONLY_UI_WAVE, apiOnlyUiPath } from "../api-only-ui.ts";
import { API_ONLY_ROWS, type ApiOnlyRowKey, type StagePostBody } from "../catalogue.ts";
import { SLACK_MS, budgetMs } from "../browser/budget.ts";
import { createCompetitionUi, createFromTemplateUi } from "../browser/pages/competition.ts";
import { boundActions, navBudget, shoot, type DivisionWhere, type PageCtx } from "../browser/pages/ctx.ts";
import { createDivisionUi, type StageOut } from "../browser/pages/division-builder.ts";
import { addEntrantsUi, withdrawUi } from "../browser/pages/entrants.ts";
import { finalizeUi, forfeitUi } from "../browser/pages/fixture-console.ts";
import { startUi } from "../browser/pages/launch.ts";
import { readPublicUi } from "../browser/pages/public-division.ts";
import { openFixtureUi } from "../browser/pages/run-sheet.ts";
import { completeStageUi, generateUi } from "../browser/pages/stage-rail.ts";
import { readStandingsUi, type UiTable } from "../browser/pages/standings.ts";
import { noPadReason } from "../pad-sports.ts";
import { replayEvents, type ReplayResult } from "../pads/replay.ts";
import type { MatrixPadAdapter } from "../pads/types.ts";
import type { CheckResult } from "../results.ts";
import { routeTo, type Route } from "../routing.ts";
import { assertion, type Item } from "../scenarios/assertions.ts";
import type { CaseSpec } from "../scenarios/types.ts";
import type { StreamEvent } from "../streams/types.ts";
import type { HttpDriver } from "./http-driver.ts";
import { MixedLedger, type ActionType, type FillerName, type PadPolicy } from "./mixed.ts";
import {
  DriverMisuse, NoOrganiserPath, OrgMismatch, RefusedCall, SEEDING_FAILED_AFTER_COMMIT, VisibilityDegraded,
  type AmericanoViewOut, type ChallengeOut, type CompetitionRef, type CompleteOut, type DivisionRef, type EntrantInput, type EntrantMember, type EntrantRow, type FixtureRow,
  type FixtureStateOut, type FromTemplateOut, type GenerateOut, type LineupChecked, type LineupSlotWire, type OrganiserDriver, type PostedEvent, type ProbeOutcome,
  type PublicStandingsOut, type SeedConfirmOut, type SeedProposalOut, type StageRef, type StagesProbe, type StandingsOut, type StartOut, type WithdrawOut,
} from "./types.ts";

/** sport → pad adapter (pads/index.ts PAD_ADAPTERS). A sport without one is
 *  scored over HTTP, and its case says which task owes it (pad-route). */
export type PadRegistry = Readonly<Partial<Record<string, MatrixPadAdapter>>>;
export const EMPTY_PADS: PadRegistry = Object.freeze({});
/** The pad replay (pads/replay.ts replayEvents); a seam for the unit suite. */
export type Replay = typeof replayEvents;

/** The page objects the driver clicks through; injectable so its tests need no browser. */
export interface BrowserPages {
  readonly createCompetitionUi: typeof createCompetitionUi;
  readonly createFromTemplateUi: typeof createFromTemplateUi;
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
  createCompetitionUi, createFromTemplateUi, createDivisionUi, addEntrantsUi, withdrawUi, startUi, generateUi,
  completeStageUi, openFixtureUi, forfeitUi, finalizeUi, readStandingsUi, readPublicUi,
});

/** The HTTP side: every organiser call, plus the ledger read (HttpDriver.ledger),
 *  the roster filler the entrants tab cannot do (HttpDriver.setMembers) and the
 *  read-back of what a template card built (HttpDriver.readBackTemplate). */
export type HttpSide = OrganiserDriver & Pick<HttpDriver, "ledger" | "setMembers" | "readBackTemplate">;

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
  replay?: Replay;
}

/** d/[divSlug]/page.tsx TABLE_KINDS (text-pinned): the organiser standings tab draws a table for these only. */
export const ORGANISER_TABLE_KINDS: ReadonlySet<string> = new Set(["league", "group", "swiss"]);
/** server/public-site/champion.ts BRACKET_KINDS (text-pinned): the public page draws these as a bracket, not a table. */
export const PUBLIC_BRACKET_KINDS: ReadonlySet<string> = new Set(["knockout", "double_elim", "stepladder", "page_playoff"]);
/** The public division page's `export const revalidate` (text-pinned): it may serve a render this old. */
export const PUBLIC_REVALIDATE_S = 30;
/** server/public-site/data.ts REVALIDATE_FAST, getPublicDivision's unstable_cache
 *  window (text-pinned; data.ts is server runtime, never imported here): a
 *  regeneration of the page may read a data entry this old. */
export const PUBLIC_DATA_REVALIDATE_S = 30;
/** The rules editor, not the builder, carries a division's match-rules
 *  override (M-4 ruling, fix round 1). Ruling 47: driving it in the browser
 *  goes to W2, which owns the editor fixes under ruling 33. The
 *  NoOrganiserPath below spells the wave as a literal (the Q-A guard reads a
 *  literal only, PF-3); browser-driver.test.ts pins the two together. */
export const OVERRIDE_ROUTE = routeTo("W2", "the rules editor is not driven in the browser; its wave owns the editor fixes (rulings 33, 47)");
/** The ledger row both finalize paths append (fixture-console.tsx send, scoring.ts finalizeFixture; text-pinned). */
export const FINALIZE_EVENT = "core.finalize";
/** The completion event the scenario reads finalRanks from (common.ts finishStage). */
const STAGE_COMPLETED = "stage_completed";

/** Ruling C (amended, fix round 1): how long after the case's last write the
 *  public page may still show an older state. The page's own ISR window, plus
 *  the data cache under it (a regeneration can read a data entry one data
 *  window old), plus the navigation that brings the render and one
 *  regeneration's slack. Past it, a difference is the product's. */
export function publicFreshnessMs(c: Pick<PageCtx, "holdMs">): number {
  return budgetMs({ base: (PUBLIC_REVALIDATE_S + PUBLIC_DATA_REVALIDATE_S) * 1000 + navBudget(c) + SLACK_MS, holdMs: c.holdMs });
}
const FRESHNESS_LAYERS = `the page's revalidate ${PUBLIC_REVALIDATE_S} s + its data cache's ${PUBLIC_DATA_REVALIDATE_S} s + a navigation`;

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

/** One item per event the replay judged, then one per finding (why it
 *  stopped), each naming the fixture and the event's index. */
export function padItems(fixtureId: string, total: number, r: ReplayResult): Item[] {
  const ok = new Set(["equal", "tolerated", "fallback"]);
  return [
    ...r.rows.map((row, i) => ({
      ok: ok.has(row.verdict),
      note: `${fixtureId} event ${i + 1} of ${total} (${row.expected.type}): ${row.verdict}${row.note === null ? "" : ` — ${row.note}`}`,
    })),
    ...r.findings.map((f) => ({ ok: false, note: `${fixtureId}: ${f}` })),
  ];
}

/** `pad-ledger-as-generated`: the case's pad rows, all fixtures together.
 *  Zero items fails (R25). A tolerated or fallback row passes, and its note
 *  is kept as evidence after any failure: an observation, never silent. */
/** How many notes the check keeps (W1d item 8: it used to cut there silently). */
export const PAD_EVIDENCE_NOTES = 12;
function padCheck(items: readonly Item[]): CheckResult {
  const c = assertion("pad-ledger-as-generated", items);
  // The failing notes first, then the passing ones worth keeping — counted
  // from the items themselves, since `assertion` has already cut the failures.
  const all = [...items.filter((i) => !i.ok).map((i) => i.note), ...items.filter((i) => i.ok && !/: equal$/.test(i.note)).map((i) => i.note)];
  const more = all.length - PAD_EVIDENCE_NOTES;
  return { ...c, evidence: more > 0 ? [...all.slice(0, PAD_EVIDENCE_NOTES), `+${more} more`] : all };
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
  readonly #replay: Replay;
  /** The clock's reading when the driver was built: the zero of the replay's tap timings. */
  readonly #startedAt: number;
  readonly #ledger = new MixedLedger();
  readonly #checks: CheckResult[] = [];
  readonly #finalized: Item[] = [];
  /** Every pad-scored row compared, and every replay finding, across the case's fixtures (null: the pad never scored). */
  #padItems: Item[] | null = null;
  #padRouteJudged = false;
  #sheetShot = false;
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
  /** When the case's last write settled (either path; null before any): the
   *  public page's freshness window runs from here (ruling C, amended). */
  #lastWriteAt: number | null = null;

  constructor(o: BrowserDriverOptions) {
    this.#http = o.http;
    this.#ctx = o.ctx;
    this.#spec = o.spec;
    this.#policy = o.padPolicy;
    this.#pads = o.pads;
    this.#orgId = o.orgId;
    this.#pages = o.pages ?? REAL_PAGES;
    this.#clock = o.clock ?? REAL_CLOCK;
    this.#replay = o.replay ?? replayEvents;
    // 15a: the tap timings read the case's clock, from the case's own start.
    this.#startedAt = this.#clock.now();
    // Ruling F: every tap no page object bounds itself is one step's budget.
    boundActions(o.ctx.page, o.ctx);
  }

  get callCount(): number { return this.#uiCalls + this.#http.callCount; }

  /** The policy this driver was built with (the runner's wiring is proven by it). */
  get padPolicy(): PadPolicy { return this.#policy; }
  /** The case this driver was built for (the same proof, carry N-2). */
  get spec(): CaseSpec { return this.#spec; }
  /** The pad registry the score path reads (the same proof, Tasks 9–11 carry (c)). */
  get pads(): PadRegistry { return this.#pads; }

  /** A write, on either path. Its time is taken when it SETTLES — answered,
   *  refused or unknown, the latest moment it could have committed — and the
   *  public page's freshness window restarts there. */
  async #write<T>(act: () => Promise<T>): Promise<T> {
    try {
      return await act();
    } finally {
      this.#lastWriteAt = this.#clock.now();
    }
  }

  checks(): CheckResult[] {
    const pad = this.#padItems === null ? [] : [padCheck(this.#padItems)];
    const fin = this.#finalized.length === 0 ? [] : [assertion("finalize-ledger-row", this.#finalized)];
    return [...this.#checks, ...pad, ...fin, this.#ledger.coverage(), ...this.#ctx.evidence.checks()];
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

  /** The cell's catalog template when the case is on one of the two
   *  template-only cells (api-only-ui.ts), else null. */
  #templateReaching(): string | null {
    const row = this.#spec.row;
    if (!isApiOnly(row)) return null;
    const path = apiOnlyUiPath(row, this.#spec.sport);
    return path.reachable ? path.template : null;
  }

  async createCompetition(input: { name: string; slug: string }): Promise<CompetitionRef> {
    // W1-driving Task 13: a template case's competition is its card's, and a
    // template-only cell without its template has no right organiser act (the
    // blank wizard + builder cannot build the row). Refused before anything lands.
    if (this.#spec.template !== undefined) {
      throw new DriverMisuse(`browser: case ${this.#spec.caseId} carries catalog template ${this.#spec.template} — its competition is created by its card (createFromTemplate), never the blank wizard`);
    }
    const reaching = this.#templateReaching();
    if (reaching !== null) {
      throw new DriverMisuse(`browser: ${this.#spec.row}|${this.#spec.sport} is built through catalog template ${reaching} — plan the case with that template (CaseSpec.template, --set w1-driving-l1) so it sets up through the card`);
    }
    if (!this.#wants("createCompetition")) {
      this.#ledger.record("createCompetition", "http");
      const ref = await this.#write(() => this.#http.createCompetition(input));
      this.#competitions.set(ref.id, ref.slug);
      return ref;
    }
    this.#ledger.record("createCompetition", "browser");
    // The wizard takes no slug: the product picks it, and the answer is the one authority.
    const c = await this.#write(() => this.#ui((p) => p.createCompetitionUi(this.#ctx, { name: input.name })));
    // The same refusals HttpDriver makes (http-driver.ts createCompetition).
    if (c.org_id !== this.#orgId) throw new OrgMismatch(this.#orgId, c.org_id);
    if (c.visibility !== "unlisted") throw new VisibilityDegraded(c.slug);
    this.#competitions.set(c.id, c.slug);
    return { id: c.id, slug: c.slug, orgId: c.org_id };
  }

  /** W1-driving Task 13 (ruling 47): the template case's ONE organiser act —
   *  the gallery card builds the competition, the division and its stages,
   *  so createCompetition AND createDivision are recorded on the path it took
   *  (the browser while either still owes its turn, else over http), and no
   *  stage is ever posted. The product's answer is read back over http (org,
   *  visibility, division, stages — HttpDriver.readBackTemplate); only what
   *  held is registered for the page objects. */
  async createFromTemplate(key: string, input: { name: string; endsOn: string }): Promise<FromTemplateOut> {
    if (this.#spec.template !== key) {
      throw new DriverMisuse(`browser: case ${this.#spec.caseId} carries template ${this.#spec.template ?? "none"}; createFromTemplate(${key}) would build another shape under its name`);
    }
    let out: FromTemplateOut;
    if (this.#wants("createCompetition") || this.#wants("createDivision")) {
      this.#ledger.record("createCompetition", "browser");
      this.#ledger.record("createDivision", "browser");
      const answer = await this.#write(() => this.#ui((p) => p.createFromTemplateUi(this.#ctx, key, input)));
      out = await this.#http.readBackTemplate(answer, key);
    } else {
      this.#ledger.record("createCompetition", "http");
      this.#ledger.record("createDivision", "http");
      out = await this.#write(() => this.#http.createFromTemplate(key, input));
    }
    this.#competitions.set(out.competition.id, out.competition.slug);
    this.#register(out.division.id, out.competition.slug, out.division.slug);
    for (const s of out.stages) this.#stageDivision.set(s.id, out.division.id);
    return out;
  }

  /** D7: an API-only row has no organiser control; the text names who owns it
   *  (api-only-ui.ts, the one authority the layer planner reads too). Answers
   *  the row's route, which the mixed ledger's exemption carries. A
   *  template-only cell never gets here by a planned path (createCompetition
   *  refuses it without its template, and a template case's division is its
   *  card's), so reaching it is refused by name. */
  #judgeApiOnlyPath(row: ApiOnlyRowKey): Route {
    const path = apiOnlyUiPath(row, this.#spec.sport);
    if (path.reachable) {
      throw new DriverMisuse(`browser: ${row}|${this.#spec.sport} is ${path.reason} — its division is the card's (createFromTemplate), never a createDivision`);
    }
    if (!this.#uiPathJudged) {
      this.#uiPathJudged = true;
      this.#checks.push(assertion("organiser-ui-path", [{ ok: false, note: `${path.reason} → ${path.wave}` }]));
    }
    return API_ONLY_UI_WAVE[row];
  }

  async createDivision(competitionId: string, input: { name: string; slug: string; sportKey: string; variantKey: string; config?: Record<string, unknown> }): Promise<DivisionRef> {
    const compSlug = this.#competitions.get(competitionId);
    if (compSlug === undefined) throw new DriverMisuse(`browser: competition ${competitionId} was not created by this driver, or was refused — there is no slug to build a division in`);
    const row = this.#spec.row;
    const apiOnly = isApiOnly(row);
    if (apiOnly || !this.#wants("createDivision")) {
      // Judged first: a refused path records no invocation.
      const route = apiOnly ? this.#judgeApiOnlyPath(row) : null;
      this.#ledger.record("createDivision", "http");
      if (route !== null) this.#ledger.exempt("createDivision", route);
      const ref = await this.#write(() => this.#http.createDivision(competitionId, input));
      this.#register(ref.id, compSlug, ref.slug);
      return ref;
    }
    const override = Object.keys(input.config ?? {});
    // M-4 ruling: a cell with no path in this layer (🚫, owned by a wave), never an error red.
    if (override.length > 0) {
      throw new NoOrganiserPath("W2", `the division builder takes no rule override (${override.join(", ")}); ${OVERRIDE_ROUTE.why}`);
    }
    this.#ledger.record("createDivision", "browser");
    const { division, stages } = await this.#write(() => this.#ui((p) => p.createDivisionUi(this.#ctx, compSlug, competitionId,
      { name: input.name, sportKey: input.sportKey, variantKey: input.variantKey, row })));
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
    const out = await this.#write(() => this.#http.postStages(divisionId, stages));
    for (const s of out) this.#stageDivision.set(s.id, divisionId);
    return out;
  }

  async listStages(divisionId: string): Promise<StageRef[]> {
    const out = await this.#http.listStages(divisionId);
    for (const s of out) this.#stageDivision.set(s.id, divisionId);
    return out;
  }

  /** The http path sends members inline (HttpDriver.addEntrants). The
   *  browser path adds each entrant by name through the entrants tab, so the
   *  type keeps its browser coverage, then seeds every roster it was given as
   *  HTTP filler (D2, ruling 47). */
  async addEntrants(divisionId: string, entrants: readonly EntrantInput[]): Promise<EntrantRow[]> {
    // M-6: an empty add has no organiser act to drive — no click, no ledger row;
    // the API answers it as it would any other caller.
    if (entrants.length === 0) return this.#http.addEntrants(divisionId, entrants);
    if (!this.#wants("addEntrants")) {
      this.#ledger.record("addEntrants", "http");
      return this.#write(() => this.#http.addEntrants(divisionId, entrants));
    }
    const where = this.#whereOf(divisionId);
    this.#ledger.record("addEntrants", "browser");
    const rows = await this.#write(() => this.#ui((p) => p.addEntrantsUi(this.#ctx, where, entrants.map((e) => ({ displayName: e.displayName, seed: e.seed, kind: e.kind })))));
    await this.#seedRosters(entrants, rows);
    return rows;
  }

  /** Each input with members gets its roster over HTTP (setMembers: persons,
   *  then one PATCH), counted as filler. The tab answers one row per input,
   *  in order, each as typed (entrants.ts addEntrantsUi) — that pairing is
   *  what puts a roster on the right entrant, so a row that does not line up
   *  is refused by name before any roster is seeded. */
  async #seedRosters(inputs: readonly EntrantInput[], rows: readonly EntrantRow[]): Promise<void> {
    if (!inputs.some((e) => (e.members?.length ?? 0) > 0)) return;
    if (rows.length !== inputs.length || inputs.some((e, i) => rows[i]?.display_name !== e.displayName)) {
      throw new DriverMisuse(`browser: the entrants tab answered ${rows.map((r) => r.display_name).join(", ") || "no entrant"} for ${inputs.map((e) => e.displayName).join(", ")} — a roster would land on the wrong entrant`);
    }
    for (const [i, e] of inputs.entries()) {
      const members = e.members;
      if (members === undefined || members.length === 0) continue;
      const id = rows[i].id;
      this.#ledger.filler("setMembers");
      await this.#write(() => this.#http.setMembers(id, members));
    }
  }

  listEntrants(divisionId: string): Promise<EntrantRow[]> { return this.#http.listEntrants(divisionId); }

  /** Filler (ruling 47): a read, always HTTP. */
  entrantMembers(entrantId: string): Promise<EntrantMember[]> {
    this.#ledger.filler("entrantMembers");
    return this.#http.entrantMembers(entrantId);
  }

  /** Filler (ruling 47): always HTTP, and a write; the product's lineup
   *  check is returned untouched. */
  putLineup(fixtureId: string, entrantId: string, slots: readonly LineupSlotWire[]): Promise<LineupChecked> {
    this.#ledger.filler("putLineup");
    return this.#write(() => this.#http.putLineup(fixtureId, entrantId, slots));
  }

  /** Filler (ruling 47, W1-driving Task 6): the seed advance is always HTTP,
   *  and a write; the product's answer or refusal passes through untouched. */
  confirmSeedProposal(stageId: string, body: { proposalId: string; tiePicks?: readonly { slots: readonly string[]; order: readonly string[] }[] }): Promise<SeedConfirmOut> {
    this.#ledger.filler("confirmSeedProposal");
    return this.#write(() => this.#http.confirmSeedProposal(stageId, body));
  }

  /** Filler (ruling 47, W1-driving Task 6): a recompute is a write too (it
   *  stales the previous draft). */
  recomputeSeedProposal(stageId: string): Promise<SeedProposalOut> {
    this.#ledger.filler("recomputeSeedProposal");
    return this.#write(() => this.#http.recomputeSeedProposal(stageId));
  }

  /** Filler (ruling 47, W1-driving Task 7): a ladder challenge is always
   *  HTTP, and a write (it inserts the challenge's fixture); the product's
   *  answer or refusal passes through untouched. */
  challenge(stageId: string, challengerId: string, opponentId: string): Promise<ChallengeOut> {
    this.#ledger.filler("challenge");
    return this.#write(() => this.#http.challenge(stageId, challengerId, opponentId));
  }

  /** Filler (ruling 47, W1-driving Task 8): the americano read model is a
   *  read, always HTTP; the product's answer or refusal passes through. */
  americanoView(stageId: string): Promise<AmericanoViewOut> {
    this.#ledger.filler("americanoView");
    return this.#http.americanoView(stageId);
  }

  /** The setup filler this driver ran, by name (mixed.ts FILLER). */
  get fillers(): Readonly<Partial<Record<FillerName, number>>> { return this.#ledger.fillers(); }

  async start(divisionId: string): Promise<StartOut> {
    if (!this.#wants("start")) {
      this.#ledger.record("start", "http");
      return this.#write(() => this.#http.start(divisionId));
    }
    const where = this.#whereOf(divisionId);
    this.#ledger.record("start", "browser");
    return this.#write(() => this.#ui((p) => p.startUi(this.#ctx, where)));
  }

  async generate(stageId: string): Promise<GenerateOut> {
    if (!this.#wants("generate")) {
      this.#ledger.record("generate", "http");
      return this.#write(() => this.#http.generate(stageId));
    }
    const where = this.#whereOfStage(stageId);
    this.#ledger.record("generate", "browser");
    const out = await this.#write(() => this.#ui((p) => p.generateUi(this.#ctx, where, stageId)));
    // O-1: generate keeps the browser's turn until one of its calls here has
    // created fixtures, so generateUi's create branch runs live, not only its no-op.
    this.#ledger.created("generate", out.created);
    return out;
  }

  listFixtures(divisionId: string): Promise<FixtureRow[]> { return this.#http.listFixtures(divisionId); }
  fixtureState(fixtureId: string): Promise<FixtureStateOut> { return this.#http.fixtureState(fixtureId); }

  /** A score the policy sends to the browser is tapped on the fixture's own
   *  pad (W1c Task 7) and answered from the ledger rows the taps wrote. A
   *  sport with no adapter is scored over HTTP, its case says which task owes
   *  the adapter (pad-route), and it is never exempt, so coverage reds score
   *  by name rather than a case going green on a promise. An empty stream has
   *  no act to drive, so it takes the HTTP path, as it always did.
   *
   *  The one exemption (W1d item 16): an adapter that declares `noControl`
   *  names event types its pad has no addressable control for (cricket's
   *  follow-on and time-expiry draw). A stream holding ANY of them is scored
   *  over HTTP whole — never half-tapped — and `score` is exempt through the
   *  adapter's own route to the wave that owes the control, with one pad-route
   *  abstain naming the event and that wave. An http score does not use the
   *  browser's turn, so under `first` the next stream the pad CAN write still
   *  runs on it. A sport with an adapter and no such stream is never exempt. */
  async postStream(fixtureId: string, events: readonly StreamEvent[], idempotencyPrefix: string): Promise<PostedEvent[]> {
    const wanted = events.length > 0 && this.#wants("score");
    const sport = this.#spec.sport;
    const pad = wanted && Object.prototype.hasOwnProperty.call(this.#pads, sport) ? this.#pads[sport] : undefined;
    // W1d item 16: an event the pad has no control for cannot be tapped, and a
    // stream holding one is not half-tapped either — it goes over http whole,
    // exempt by the adapter's route to the wave that owes the control, and the
    // browser's turn is NOT used up (an http score does not use it): the next
    // fixture whose stream the pad can write still runs on it.
    const noControl = pad?.noControl;
    const barred = noControl?.eventTypes.find((t) => events.some((e) => e.type === t));
    if (pad !== undefined && barred === undefined) {
      this.#ledger.record("score", "browser");
      return this.#write(() => this.#ui(() => this.#padStream(pad, fixtureId, events)));
    }
    if (noControl !== undefined && barred !== undefined) {
      const route = noControl.route;
      this.#ledger.exempt("score", route);
      if (!this.#padRouteJudged) {
        this.#padRouteJudged = true;
        this.#checks.push(assertion("pad-route", [], `${sport}: ${barred} has no pad control → ${route.wave} (${route.why}); a stream holding it is scored over http`));
      }
    } else if (wanted && !this.#padRouteJudged) {
      this.#padRouteJudged = true;
      this.#checks.push(assertion("pad-route", [], noPadReason(sport)));
    }
    this.#ledger.record("score", "http");
    return this.#write(() => this.#http.postStream(fixtureId, events, idempotencyPrefix));
  }

  /** One fixture scored on its pad. The console is opened by the fixture's
   *  number, the replay taps each event and reads back the rows it wrote after
   *  the server's tip, and every row the product then holds is answered as a
   *  PostedEvent carrying `stored`, so the scenario folds what the product
   *  stored. It never finalizes; PADPROOF finalizes as its own step. */
  async #padStream(pad: MatrixPadAdapter, fixtureId: string, events: readonly StreamEvent[]): Promise<PostedEvent[]> {
    const { where, row, no } = await this.#findFixture(fixtureId);
    const home = row.home_entrant_id;
    const away = row.away_entrant_id;
    if (home === null || away === null) throw new DriverMisuse(`browser: fixture ${fixtureId} does not seat two entrants — the pad scores a seated fixture only`);
    const cfg = (await this.#http.getDivision(where.divisionId)).config;
    await this.#pages.openFixtureUi(this.#ctx, where, no);
    const before = await shoot(this.#ctx, "08-pad-before");
    const result = await this.#replay(this.#ctx.page, pad, events, { cfg, entrants: { home, away } }, {
      ledger: (since) => this.#http.ledger(fixtureId, since),
      tip: async () => (await this.#http.fixtureState(fixtureId)).last_seq,
      sleep: (ms) => this.#clock.sleep(ms),
      now: () => this.#clock.now() - this.#startedAt,
      holdMs: this.#ctx.holdMs,
      // The case's one mid-sheet picture: the first number step it ever types.
      onTap: async (_i, step) => {
        if (this.#sheetShot || step.kind !== "number") return;
        this.#sheetShot = true;
        await shoot(this.#ctx, "08-pad-sheet");
      },
    });
    await shoot(this.#ctx, "08-pad-scored", before);
    (this.#padItems ??= []).push(...padItems(fixtureId, events.length, result));
    if (result.stored.length === 0) return [];
    const state = await this.#http.fixtureState(fixtureId);
    return result.stored.map((r) => ({ seq: r.seq, event_id: r.id, status: state.status, outcome: state.outcome, stored: { type: r.type, payload: r.payload } }));
  }

  async forfeit(fixtureId: string, byEntrantId: string, reason: "walkover" | "retired hurt", idempotencyPrefix: string): Promise<PostedEvent[]> {
    if (!this.#wants("forfeit")) {
      this.#ledger.record("forfeit", "http");
      return this.#write(() => this.#http.forfeit(fixtureId, byEntrantId, reason, idempotencyPrefix));
    }
    const { where, row, no } = await this.#findFixture(fixtureId);
    this.#ledger.record("forfeit", "browser");
    await this.#ui((p) => p.openFixtureUi(this.#ctx, where, no));
    return this.#write(() => this.#ui((p) => p.forfeitUi(this.#ctx, row, byEntrantId, reason)));
  }

  async withdraw(entrantId: string): Promise<WithdrawOut> {
    if (!this.#wants("withdraw")) {
      this.#ledger.record("withdraw", "http");
      return this.#write(() => this.#http.withdraw(entrantId));
    }
    for (const where of this.#wheres.values()) {
      const e = (await this.#http.listEntrants(where.divisionId)).find((x) => x.id === entrantId);
      if (e === undefined) continue;
      this.#ledger.record("withdraw", "browser");
      return this.#write(() => this.#ui((p) => p.withdrawUi(this.#ctx, where, { id: e.id, displayName: e.display_name })));
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
      out = await this.#write(() => where === null ? this.#http.completeStage(stageId) : this.#ui((p) => p.completeStageUi(this.#ctx, where, stageId)));
    } catch (e) {
      // As HttpDriver: a named 4xx committed nothing and stays retryable; any
      // other ending may follow a committed completion, so it is never repeated
      // — and STAGE_COMPLETED_SEEDING_FAILED says it DID commit (W1-driving T6, FP-3).
      if (!(e instanceof RefusedCall && e.status < 500 && e.code !== SEEDING_FAILED_AFTER_COMMIT)) this.#completed.add(stageId);
      throw e;
    }
    if (out.completed) {
      this.#completed.add(stageId);
      this.#finalRanks.set(stageId, out.events.find((ev) => ev.type === STAGE_COMPLETED)?.finalRanks ?? null);
    }
    return out;
  }

  rebuild(stageId: string): Promise<void> { return this.#write(() => this.#http.rebuild(stageId)); }

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
    // api.tables is non-empty here (#organiserTables answers null for no drawn
    // stage, and one table per drawn stage at least), so r.checked ≥ 1: a
    // missing page table is a fail row of compareTables, never a vacuous pass.
    const r = compareTables(api.tables, ui);
    this.#checks.push({ id: "ui-standings-match", kind: "assertion", verdict: r.ok ? "pass" : "fail", checked: r.checked, reason: r.ok ? `${r.checked} table(s) drawn as the API ranks them` : r.evidence[0], evidence: r.evidence });
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

  /** Ruling C, amended (fix round 1, I-1 + I-2): the page is read, SLACK_MS
   *  apart, until it matches the API or a read STARTS a whole freshness window
   *  after the case's last write — a render that late can no longer be a cache
   *  serving an older state, so whatever it still shows is the verdict: a FAIL
   *  recorded here, never a throw, so the case keeps every other check. */
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
    const kinds = [...new Set(stages.map((s) => s.kind))];
    const tableKinds = kinds.filter((k) => !PUBLIC_BRACKET_KINDS.has(k));
    const window = publicFreshnessMs(this.#ctx);
    const since = this.#lastWriteAt ?? this.#clock.now();
    for (let reads = 1; ; reads++) {
      const startedAt = this.#clock.now();
      const view = await this.#ui((p) => p.readPublicUi(this.#ctx, where));
      const tables = compareTables(api, view.tables);
      const crowned = want.kind !== "name" || view.champion === want.name;
      const elapsed = startedAt - since;
      if (!(tables.ok && crowned) && elapsed < window) {
        await this.#clock.sleep(SLACK_MS);
        continue;
      }
      const late = `${elapsed} ms after the case's last write (window ${window} ms: ${FRESHNESS_LAYERS}), read ${reads}×`;
      // M-7: nothing compared abstains only where no stage publishes a table;
      // a table stage with no table compared is vacuous, and vacuous is a fail.
      this.#checks.push(tables.checked === 0
        ? tableKinds.length === 0
          ? assertion("ui-public-standings-match", [], `no table to compare: every stage is a bracket (${kinds.join(", ") || "no stage"})`)
          : { id: "ui-public-standings-match", kind: "assertion", verdict: "fail", checked: 0, reason: `vacuous: a table stage (${tableKinds.join(", ")}) and no table compared (checked 0 is a failure)`, evidence: [] }
        : tables.ok
          ? { id: "ui-public-standings-match", kind: "assertion", verdict: "pass", checked: tables.checked, reason: `${tables.checked} table(s) drawn as the API ranks them, on read ${reads}`, evidence: [] }
          : { id: "ui-public-standings-match", kind: "assertion", verdict: "fail", checked: tables.checked, reason: `the public page still differs from the API ${late}: ${tables.evidence[0]}`, evidence: tables.evidence });
      this.#checks.push(want.kind === "abstain" ? assertion("ui-champion-shown", [], want.reason)
        : want.kind === "fail" ? assertion("ui-champion-shown", [{ ok: false, note: want.note }])
        : crowned ? assertion("ui-champion-shown", [{ ok: true, note: `the banner names ${want.name}` }])
        : assertion("ui-champion-shown", [{ ok: false, note: `the banner names ${view.champion ?? "nobody"}; want ${want.name} — still ${late}` }]));
      return;
    }
  }

  // Probes are writes too: an accepted one changes what the public page must show.
  patchDivisionConfig(divisionId: string, config: Record<string, unknown>): Promise<ProbeOutcome> { return this.#write(() => this.#http.patchDivisionConfig(divisionId, config)); }
  replaceStagesProbe(divisionId: string, stages: readonly StagePostBody[]): Promise<StagesProbe> { return this.#write(() => this.#http.replaceStagesProbe(divisionId, stages)); }

  /** Finalize is always the console's (not an ACTION_TYPES entry): the tap,
   *  then the ledger row it left after the tip it was read at — exactly one,
   *  a core.finalize, at the seq the console's answer names (ruling D). */
  async finalize(fixtureId: string): Promise<FixtureStateOut> {
    const { where, no } = await this.#findFixture(fixtureId);
    const tip = (await this.#http.fixtureState(fixtureId)).last_seq;
    await this.#ui((p) => p.openFixtureUi(this.#ctx, where, no));
    const posted = await this.#write(() => this.#ui((p) => p.finalizeUi(this.#ctx, fixtureId)));
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
