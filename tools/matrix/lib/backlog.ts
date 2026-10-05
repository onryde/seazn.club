// W1d Task 22 (ruling 62, D19): the per-wave backlog section of the programme's _INDEX.md. The truth run's reds are a floor, not the
// whole backlog (design section 8: "the ❌ list becomes each wave's starting backlog"), so each numbered wave gets, from the committed
// baseline and never by hand: its gaps (id, title, case count, layers, example cases), the audit ids the baseline never drove, and the
// carries a wave owes (prose a person wrote, in catalogue/backlog-carries.json).
//
// Nothing here types a wave, a count or a table row. The waves are section 8's own rows (designWaves); a gap's wave and a case's
// layer are the triage's; an audit id's wave and outcome are the ledger's; and a carry hangs on an anchor gap, so it sits in the wave
// that gap routes to (routeOf) and every number it quotes is derived from the committed dispatch cut and the triage rules. A carry's
// prose is data, with {placeholders} that the derivation of its id fills; a carry with no derivation, a derivation with no carry, and
// a placeholder one side lacks are each refused, so nothing is dropped silently and nothing is printed as a guess.
//
// DB-free, like every tool: this reads files and folds them, nothing else. The writer is pure over `BacklogInput`; `loadBacklogInput`
// is the only function that reads.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { AUDIT_DIR, OUTCOMES, REPO_ROOT, buildLedger, parseVerdicts, readAudit, type Ledger, type LedgerEntry } from "./audit-ledger.ts";
import { redact } from "./redact.ts";
import { LAYERS } from "./results.ts";
import { CATALOGUE_DIR, isClean, loadCatalogue, parseTriage, routeOf, type GapRouting, type NewGaps, type TriageJson, type TriageRules } from "./triage.ts";

/** The committed baseline: the three layers' merged results, the dispatch cut, README, TRIAGE.md. */
export const DEFAULT_BASELINE = resolve(REPO_ROOT, "docs/superpowers/specs/2026-09-27-format-matrix-prompts/truth-runs/w1d-baseline");
/** The design of record: section 8 is the wave table the backlog is written per row of. */
export const DEFAULT_DESIGN = resolve(REPO_ROOT, "docs/superpowers/specs/2026-09-27-format-matrix-design.md");

// --- refusals ------------------------------------------------------------------------------------------------------------------

export const BACKLOG_REFUSALS = [
  // the writer, over its input
  "NoCases", "TriageInconsistent", "LedgerHasFindings", "DesignRowMissing", "UnknownWave", "NewGapUnbacked", "NewGapWaveDisagrees",
  "CarryUnknown", "CarryMissing", "CarryPlaceholder", "CarryWaveDisagrees", "CarrySourceMissing", "CarryEmpty", "CarryShapeUnknown",
  // the loader, over the files
  "TriageUnreadable", "TriageNotBaseline", "ShaNotBaseline", "BaselineUnreadable", "CatalogueUnreadable", "DesignUnreadable",
] as const;
export type BacklogRefusalName = (typeof BACKLOG_REFUSALS)[number];

/** Every way the backlog refuses to be written (exit 2, nothing written). Each is the Error's own `name`. */
export class BacklogRefused extends Error {
  constructor(name: BacklogRefusalName, message: string) {
    super(message);
    this.name = name;
  }
}

// --- the carries file ----------------------------------------------------------------------------------------------------------

const PLACEHOLDER = /\{([A-Za-z][A-Za-z0-9]*)\}/g;
const placeholdersOf = (text: string): Set<string> => new Set([...text.matchAll(PLACEHOLDER)].map((m) => m[1]));

const CarrySchema = z.strictObject({
  /** The derivation that fills this carry's placeholders (lib/backlog.ts DERIVERS). */
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "a kebab-case carry id"),
  title: z.string().min(1),
  /** The gap the carry hangs on: its wave is that gap's route, found and never typed. */
  anchor: z.string().regex(/^(?:[A-Z]{2}-[A-Z]+\d+|NEW-W1d-\d+)$/, "an audit gap id or a NEW- gap id"),
  text: z.string().min(1),
});
const CarriesSchema = z.strictObject({
  note: z.string().min(1).optional(),
  heading: z.string().min(1).refine((h) => h.includes("{sha}"), "the heading names the baseline: it carries {sha}"),
  intro: z.array(z.string().min(1)).min(1).refine((p) => p.some((x) => x.includes("{baseline}")), "the intro carries {baseline}: the paragraph naming the runs the section was written from"),
  carries: z.array(CarrySchema).min(1),
}).superRefine((v, ctx) => {
  const seen = new Set<string>();
  for (const c of v.carries) {
    if (seen.has(c.id)) ctx.addIssue({ code: "custom", path: ["carries"], message: `duplicate carry id ${c.id}` });
    seen.add(c.id);
  }
});
export type Carries = z.infer<typeof CarriesSchema>;
export const parseCarries = (json: unknown): Carries => CarriesSchema.parse(json);

// --- the dispatch cut ----------------------------------------------------------------------------------------------------------

/** What a derivation reads of a dispatch's case: its state, its reason text, and which checks failed. */
const CutCaseSchema = z.object({
  caseId: z.string().min(1),
  state: z.string().min(1),
  reason: z.string(),
  checks: z.array(z.object({ id: z.string().min(1), verdict: z.string().min(1) })),
});
const CutsSchema = z.object({
  ids: z.array(z.string().min(1)).min(1),
  dispatches: z.array(z.object({ n: z.number().int().positive(), cases: z.array(CutCaseSchema) })).length(3),
});
export type Cuts = z.infer<typeof CutsSchema>;
export const parseCuts = (json: unknown): Cuts => CutsSchema.parse(json);

// --- the input -----------------------------------------------------------------------------------------------------------------

export interface BacklogInput {
  /** The baseline's commit as the heading names it. */
  sha: string;
  triage: TriageJson;
  ledger: Ledger;
  newGaps: NewGaps;
  routing: GapRouting;
  rules: TriageRules;
  carries: Carries;
  /** The L3 cases whose state, failing set or reason differ between the three dispatches, each as every dispatch recorded it. */
  cuts: Cuts;
  /** Every case id of the committed L3 run (the cut is a subset). */
  l3CaseIds: string[];
  /** The design document's text: section 8 is read by designWaves. */
  design: string;
}

// --- cells -----------------------------------------------------------------------------------------------------------------------

/** A table cell: a bare pipe would end it, and a case id or an audit title can hold one. */
export const cell = (s: string): string => s.replaceAll("|", "\\|");
const code = (s: string): string => `\`${s}\``;
/** "a", "a and b", "a, b and c". */
const list = (items: readonly string[]): string => (items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`);
const table = (head: readonly string[], rows: readonly (readonly string[])[]): string[] => [
  `| ${head.join(" | ")} |`,
  `|${head.map(() => "---").join("|")}|`,
  ...rows.map((r) => `| ${r.join(" | ")} |`),
];

// --- examples --------------------------------------------------------------------------------------------------------------------

/** Up to `n` of a gap's cases: the first of each layer it spans (so no layer is left out while another has two), in layer order, then the
 *  rest in plan order. `rows` are in plan order. */
export function exampleCases(rows: readonly { caseId: string; layer: string }[], n = 5): string[] {
  const order: readonly string[] = LAYERS;
  const layers = [...new Set(rows.map((r) => r.layer))].sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const firsts = layers.map((l) => rows.find((r) => r.layer === l)!.caseId);
  const rest = rows.map((r) => r.caseId).filter((id) => !firsts.includes(id));
  return [...firsts, ...rest].slice(0, n);
}

/** A gap's example cases: its own, or (a gap with none of its own) the cases keyed elsewhere that also fail one of its checks. */
export function examplesOf(gap: { caseIds: readonly string[]; alsoCaseIds?: readonly string[] | undefined }, layerOf: ReadonlyMap<string, string>): string[] {
  const ids = gap.caseIds.length > 0 ? gap.caseIds : (gap.alsoCaseIds ?? []);
  return exampleCases(ids.map((caseId) => ({ caseId, layer: layerOf.get(caseId) ?? "" })));
}

// --- the design's wave rows -------------------------------------------------------------------------------------------------------

export interface DesignWave { id: string; name: string; scope: string }

/** Section 8's numbered waves (W2 on): `| **W<n> — <name>** … | <scope> | … |`. The done waves (W1a to W1d, W1-driving) are no backlog's:
 *  their heading is not `W<digits> — `. A document with no such table has none. */
export function designWaves(design: string): DesignWave[] {
  const at = design.search(/^## 8\. Waves$/m);
  if (at < 0) return [];
  const rest = design.slice(at + 4);
  const next = rest.search(/^## /m);
  const body = next < 0 ? rest : rest.slice(0, next);
  const out: DesignWave[] = [];
  for (const line of body.split("\n")) {
    const m = /^\| \*\*(W\d+) — ([^*]+)\*\*[^|]*\| ([^|]*) \|/.exec(line);
    if (m !== null) out.push({ id: m[1], name: m[2].trim(), scope: m[3].trim() });
  }
  return out;
}

const tokensOf = (s: string): string[] => s.toLowerCase().split(/[ _]+/).filter((t) => t !== "");
/** The words section 8 gives a wave for the formats it owns: its name's and its scope's comma-separated words. A scope that is a
 *  sentence is one long item that no format's name contains, so it names nothing. */
function itemsOf(w: DesignWave): string[] {
  return [...new Set([...w.name.split(", "), ...w.scope.split(", ")].map((s) => s.trim()).filter((s) => s !== ""))];
}

export interface Backing { row: string; kind: "named" | "family"; item: string }

/** How a wave's row backs a gap's format (T19 review m3): `named` when the row (less a trailing `_only`) is the item, or ends with it
 *  (`knockout_third_place` ends with `third place`); `family` when the item is a word inside the format's name and the format is in no
 *  row (§8: "gaps not listed go to the wave owning their format"). The most specific item wins across ALL waves (named before family,
 *  then the longer item), so `group_stepladder` is W5's by name and no wave's `stepladder` claims it. A row that nothing backs, or that
 *  a different wave backs better than the wave it was filed under, is refused by name. */
export function backingOf(row: string, waves: readonly DesignWave[], wave: string): Backing {
  const rt = tokensOf(row);
  const bare = rt[rt.length - 1] === "only" ? rt.slice(0, -1) : rt;
  const same = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);
  const contiguous = (hay: readonly string[], needle: readonly string[]): boolean => needle.length > 0 && hay.some((_, i) => same(hay.slice(i, i + needle.length), needle));
  const hits: { wave: string; kind: "named" | "family"; item: string; size: number }[] = [];
  for (const w of waves) {
    for (const item of itemsOf(w)) {
      const it = tokensOf(item);
      const named = same(bare, it) || (it.length < rt.length && same(rt.slice(rt.length - it.length), it));
      if (named) hits.push({ wave: w.id, kind: "named", item, size: it.length });
      else if (contiguous(rt, it)) hits.push({ wave: w.id, kind: "family", item, size: it.length });
    }
  }
  const score = (h: { kind: string; size: number }): number => (h.kind === "named" ? 1000 : 0) + h.size;
  if (hits.length === 0) throw new BacklogRefused("NewGapUnbacked", `no row of design section 8 names \`${row}\` or lists a format it belongs to: the wave it was filed under has nothing behind it`);
  const best = Math.max(...hits.map(score));
  const top = hits.filter((h) => score(h) === best);
  const mine = top.find((h) => h.wave === wave);
  if (mine === undefined) {
    throw new BacklogRefused("NewGapWaveDisagrees", `\`${row}\` is filed under ${wave}, and section 8 gives it to ${[...new Set(top.map((h) => h.wave))].join(" or ")} (${top[0].kind} \`${top[0].item}\`)`);
  }
  return { row, kind: mine.kind, item: mine.item };
}

// --- the carries' derivations -----------------------------------------------------------------------------------------------------

/** What a derivation hands back: the values of the carry's placeholders, and the waves its data is keyed in (each must be the anchor's). */
interface Derived { values: Record<string, string>; waves: string[] }
interface DeriveCtx { input: BacklogInput; anchor: string }
type Deriver = (ctx: DeriveCtx) => Derived;

const refuse = (name: BacklogRefusalName, id: string, why: string): BacklogRefused => new BacklogRefused(name, `carry ${id}: ${why}`);

const failingOf = (c: { checks: readonly { id: string; verdict: string }[] }): string => c.checks.filter((k) => k.verdict === "fail").map((k) => k.id).sort().join(",");
/** A cut id as every dispatch recorded it; a dispatch that does not hold it is a cut that is not whole. */
function perDispatch(cuts: Cuts, id: string, carry: string): Cuts["dispatches"][number]["cases"][number][] {
  return cuts.dispatches.map((d) => {
    const c = d.cases.find((x) => x.caseId === id);
    if (c === undefined) throw refuse("CarrySourceMissing", carry, `the dispatch cut holds ${id} in no case of dispatch ${d.n}`);
    return c;
  });
}
/** The triage group of a gap, or the refusal that its source is gone. */
function groupOf(triage: TriageJson, gap: string, carry: string): TriageJson["gaps"][number] {
  const g = triage.gaps.find((x) => x.gap === gap);
  if (g === undefined) throw refuse("CarrySourceMissing", carry, `the triage keys no case to ${gap}`);
  return g;
}

/** A mexicano R4 cell: the one family the intermittent-500 carry is about. */
const MEXICANO_R4 = /^mexicano\|[^|]+\|[^|]+\|R4$/;
/** A swiss_playoff R4 cell: the family whose reason flips between two classes while its state and failing set stay put. */
const SWISS_PLAYOFF_R4 = /^swiss_playoff\|[^|]+\|[^|]+\|R4$/;

const DERIVERS: Record<string, Deriver> = {
  // SC-P4: the ledger's own reading of the id the W2 prompt's trap 2 cites.
  "sc-p4-oracle": ({ input, anchor }) => {
    const e = input.ledger.entries.find((x) => x.id === anchor);
    if (e === undefined || e.outcome === null || e.evidence === null || e.wave === null) throw refuse("CarrySourceMissing", "sc-p4-oracle", `the ledger holds no outcome for ${anchor}`);
    return { values: { outcome: e.outcome, evidence: e.evidence }, waves: [e.wave] };
  },

  // Ruling 70: the cells whose STATE flips across the dispatches, and where the committed run keys SW-H1.
  "ruling-70": ({ input, anchor }) => {
    const cells = input.cuts.ids.filter((id) => new Set(perDispatch(input.cuts, id, "ruling-70").map((c) => c.state)).size > 1);
    if (cells.length === 0) throw refuse("CarryEmpty", "ruling-70", "no cell of the dispatch cut changes state between the dispatches: there is no ruling to carry");
    const g = groupOf(input.triage, anchor, "ruling-70");
    const held = g.caseIds.filter((id) => cells.includes(id));
    const keyed = `${g.caseIds.length} cases of the committed run (${list(g.caseIds.map(code))}), of which ${held.length === 0 ? "none is" : `${list(held.map(code))} ${held.length === 1 ? "is" : "are"}`} one of the ruling's cells`;
    return { values: { cells: list(cells.map(code)), keyed }, waves: [g.wave] };
  },

  // The recommendation is prose with no number to derive; it still hangs on its anchor.
  "p6-recommendation": () => ({ values: {}, waves: [] }),

  // swiss_playoff R4: red in every dispatch with one failing set, the reason flips between two classes.
  "swiss-playoff-reason-flip": ({ input }) => {
    const { cuts, triage } = input;
    const classOf = (reason: string): "SW-H1" | "stall" | null => (/\(SW-H1\)|paired nobody/.test(reason) ? "SW-H1" : /did not complete/.test(reason) ? "stall" : null);
    const steady = cuts.ids.filter((id) => SWISS_PLAYOFF_R4.test(id));
    // The carry says these cells change only their reason: a cell that also changes its state or its failing set is no cell of it.
    for (const id of steady) {
      const cs = perDispatch(cuts, id, "swiss-playoff-reason-flip");
      if (!cs.every((c) => c.state === "red") || new Set(cs.map(failingOf)).size !== 1) {
        throw refuse("CarryShapeUnknown", "swiss-playoff-reason-flip", `${id} changes its state or its failing-check set between the dispatches: this carry describes cells that change only their reason`);
      }
    }
    const classes = new Map(steady.map((id) => [id, perDispatch(cuts, id, "swiss-playoff-reason-flip").map((c) => classOf(c.reason))]));
    const flips = steady.filter((id) => classes.get(id)!.includes("SW-H1") && classes.get(id)!.includes("stall"));
    if (flips.length === 0) throw refuse("CarryEmpty", "swiss-playoff-reason-flip", "no swiss_playoff R4 cell of the dispatch cut is red in every dispatch with one failing set and two reasons");
    for (const id of steady) {
      if (classes.get(id)!.includes(null)) throw refuse("CarryShapeUnknown", "swiss-playoff-reason-flip", `${id} has a reason that is neither the SW-H1 shape (paired nobody) nor the stall shape (did not complete): say which it is before the carry prints it`);
    }
    const ns = cuts.dispatches.map((d) => d.n);
    const pattern = (id: string): string => classes.get(id)!.map((c, i) => `dispatch ${ns[i]} ${c}`).join(", ");
    const patterns = [...new Set(flips.map(pattern))];
    const flipsText = patterns.length === 1 ? patterns[0] : flips.map((id) => `${code(id)}: ${pattern(id)}`).join("; ");
    const keyed = list(flips.map((id) => {
      const row = triage.rows.find((r) => r.caseId === id);
      if (row === undefined) throw refuse("CarrySourceMissing", "swiss-playoff-reason-flip", `the triage keys ${id} to no gap`);
      return `${row.gap} (${code(id)})`;
    }));
    return { values: { cells: list(flips.map(code)), flips: flipsText, keyed, committed: String(ns[ns.length - 1]) }, waves: [] };
  },

  // ST-G5: the field the rule's note describes, from the note itself.
  "st-g5-pool-of-one": ({ input, anchor }) => {
    const g = groupOf(input.triage, anchor, "st-g5-pool-of-one");
    const rule = input.rules.rules.filter((r) => r.gap === anchor).find((r) => /(\d+) entrants snaked into (\d+) pools/.test(r.note) && /answers (\d{3}) ([A-Z][A-Z_]+)/.test(r.note));
    if (rule === undefined) throw refuse("CarrySourceMissing", "st-g5-pool-of-one", `no triage rule keyed to ${anchor} describes its field ("N entrants snaked into M pools") and the answer of /complete`);
    const scenario = rule.match.scenario;
    if (scenario === undefined) throw refuse("CarrySourceMissing", "st-g5-pool-of-one", `the rule ${rule.id} names no scenario`);
    const field = /(\d+) entrants snaked into (\d+) pools/.exec(rule.note)!;
    const answer = /answers (\d{3}) ([A-Z][A-Z_]+)/.exec(rule.note)!;
    return { values: { cases: String(g.caseIds.length), scenario, sports: String(new Set(g.caseIds.map((id) => id.split("|")[1])).size), entrants: field[1], pools: field[2], refusal: `${answer[1]} ${code(answer[2])}` }, waves: [g.wave] };
  },

  // Mexicano R4: how many of the cells flip their failing set, and how often each dispatch shows the 500.
  "mexicano-generate-500": ({ input }) => {
    const { cuts, triage, l3CaseIds } = input;
    const total = l3CaseIds.filter((id) => MEXICANO_R4.test(id));
    if (total.length === 0) throw refuse("CarryEmpty", "mexicano-generate-500", "the committed L3 holds no mexicano R4 cell");
    const flipped = cuts.ids.filter((id) => MEXICANO_R4.test(id) && new Set(perDispatch(cuts, id, "mexicano-generate-500").map(failingOf)).size > 1);
    if (flipped.length === 0) throw refuse("CarryEmpty", "mexicano-generate-500", "no mexicano R4 cell of the dispatch cut changes its failing-check set between the dispatches");
    const per = cuts.dispatches.map((d) => flipped.filter((id) => d.cases.find((c) => c.caseId === id)?.reason.includes("500 INTERNAL") === true).length);
    if (per.every((n) => n === 0)) throw refuse("CarryEmpty", "mexicano-generate-500", "no dispatch of the cut shows a 500 INTERNAL on a flipped cell: the carry would describe an error nobody saw");
    const rows = flipped.map((id) => {
      const row = triage.rows.find((r) => r.caseId === id);
      if (row === undefined) throw refuse("CarrySourceMissing", "mexicano-generate-500", `the triage keys ${id} to no gap`);
      return row;
    });
    const others = total.filter((id) => !flipped.includes(id));
    return {
      values: {
        flipped: String(flipped.length), total: String(total.length), per: list(per.map(String)), ns: list(cuts.dispatches.map((d) => String(d.n))),
        others: String(others.length), otherSports: list(others.map((id) => id.split("|")[1])), keyed: list([...new Set(rows.map((r) => r.gap))]),
      },
      waves: [...new Set(rows.map((r) => r.wave))],
    };
  },
};

// --- the writer ------------------------------------------------------------------------------------------------------------------

interface WaveCarry { title: string; text: string }

/** Every carry's text with its placeholders filled, by the wave its anchor routes to. */
function deriveCarries(input: BacklogInput, waves: readonly DesignWave[]): Map<string, WaveCarry[]> {
  const ids = input.carries.carries.map((c) => c.id);
  for (const id of ids) if (!Object.hasOwn(DERIVERS, id)) throw new BacklogRefused("CarryUnknown", `carry ${id}: no derivation of lib/backlog.ts fills it`);
  for (const id of Object.keys(DERIVERS)) if (!ids.includes(id)) throw new BacklogRefused("CarryMissing", `carry ${id}: the derivation exists and backlog-carries.json holds no such carry`);
  const out = new Map<string, WaveCarry[]>();
  for (const c of input.carries.carries) {
    const wave = routeOf(input.routing, c.anchor);
    if (wave === null) throw refuse("CarryWaveDisagrees", c.id, `its anchor ${c.anchor} routes to no wave`);
    if (!waves.some((w) => w.id === wave)) throw refuse("UnknownWave", c.id, `its anchor ${c.anchor} routes to ${wave}, a wave section 8 has no backlog for`);
    const d = DERIVERS[c.id]({ input, anchor: c.anchor });
    const off = d.waves.filter((w) => w !== wave);
    if (off.length > 0) throw refuse("CarryWaveDisagrees", c.id, `its anchor ${c.anchor} routes to ${wave}, and the data it quotes is keyed in ${[...new Set(off)].join(", ")}`);
    const used = placeholdersOf(c.text);
    const have = new Set(Object.keys(d.values));
    const unfilled = [...used].filter((k) => !have.has(k));
    const unused = [...have].filter((k) => !used.has(k));
    if (unfilled.length > 0) throw refuse("CarryPlaceholder", c.id, `the text names {${unfilled.join("}, {")}}, which its derivation does not fill`);
    if (unused.length > 0) throw refuse("CarryPlaceholder", c.id, `its derivation fills {${unused.join("}, {")}}, which the text never uses`);
    const text = c.text.replace(PLACEHOLDER, (_m, k: string) => d.values[k]);
    out.set(wave, [...(out.get(wave) ?? []), { title: c.title, text }]);
  }
  return out;
}

/** The guards the table's facts rest on, in the order they are checked (a vacuous or inconsistent input names itself before any table is
 *  written from it). */
function guard(input: BacklogInput, waves: readonly DesignWave[]): void {
  const { triage, ledger } = input;
  if (triage.rows.length === 0 || triage.gaps.length === 0) throw new BacklogRefused("NoCases", "the triage keyed no red: a backlog with no case would read as a clean baseline (vacuous)");
  const rowGap = new Map(triage.rows.map((r) => [r.caseId, r.gap]));
  if (rowGap.size !== triage.rows.length) throw new BacklogRefused("TriageInconsistent", "a case is keyed in two rows of the triage");
  if (!isClean(triage)) throw new BacklogRefused("TriageInconsistent", "the triage is not clean (an untriaged, ambiguous, misrouted or unknown-gap red): its gaps are not every red");
  if (triage.checked !== triage.rows.length) throw new BacklogRefused("TriageInconsistent", `the triage says it checked ${triage.checked} reds and holds ${triage.rows.length} rows`);
  const listed = triage.gaps.flatMap((g) => g.caseIds);
  const missing = [...rowGap.keys()].filter((id) => !listed.includes(id));
  const extra = listed.filter((id) => !rowGap.has(id));
  if (missing.length > 0 || extra.length > 0 || new Set(listed).size !== listed.length) {
    throw new BacklogRefused("TriageInconsistent", `the gaps' cases are not the rows' cases (${missing.length} row${missing.length === 1 ? "" : "s"} in no gap, ${extra.length} gap case${extra.length === 1 ? "" : "s"} in no row)`);
  }
  for (const g of triage.gaps) {
    const strayCase = g.caseIds.find((id) => rowGap.get(id) !== g.gap);
    if (strayCase !== undefined) throw new BacklogRefused("TriageInconsistent", `${strayCase} is listed under ${g.gap} and keyed to ${rowGap.get(strayCase)}`);
    const strayAlso = (g.alsoCaseIds ?? []).find((id) => !rowGap.has(id));
    if (strayAlso !== undefined) throw new BacklogRefused("TriageInconsistent", `${g.gap} lists ${strayAlso} as a co-failure and no row keys it`);
  }
  if (ledger.findings.length > 0) throw new BacklogRefused("LedgerHasFindings", `the ledger has ${ledger.findings.length} finding${ledger.findings.length === 1 ? "" : "s"} (an id with no outcome would drop out of every table): resolve them first`);
  if (waves.length === 0) throw new BacklogRefused("DesignRowMissing", "the design document has no section 8 wave table (numbered waves)");
  const known = new Set(waves.map((w) => w.id));
  const unknownGap = triage.gaps.find((g) => !known.has(g.wave));
  if (unknownGap !== undefined) throw new BacklogRefused("UnknownWave", `${unknownGap.gap} is keyed to ${unknownGap.wave}, a wave section 8 has no backlog for: its reds would be swallowed`);
  const unknownId = ledger.entries.find((e) => e.wave === null || !known.has(e.wave));
  if (unknownId !== undefined) throw new BacklogRefused("UnknownWave", `${unknownId.id} routes to ${unknownId.wave ?? "no wave"}, a wave section 8 has no backlog for: it would drop out of every table`);
}

/** The line a NEW gap owes (T19 review m3): its wave is a row of section 8, and which one, in the design's own words. */
function designRowLine(ng: NewGaps["gaps"][number], input: BacklogInput, waves: readonly DesignWave[]): string {
  const g = input.triage.gaps.find((x) => x.gap === ng.id);
  if (g === undefined) throw new BacklogRefused("NewGapUnbacked", `${ng.id} is in the NEW-gap catalogue and the triage keys no case to it: nothing shows which row backs it`);
  if (g.wave !== ng.wave) throw new BacklogRefused("NewGapWaveDisagrees", `${ng.id} is filed under ${ng.wave} in the catalogue and under ${g.wave} in the triage`);
  const row = (id: string): string => id.split("|")[0];
  const formats = [...new Set(g.caseIds.map(row))];
  if (formats.length === 0) throw new BacklogRefused("NewGapUnbacked", `${ng.id} has no case of its own: nothing shows which row backs it`);
  const wave = waves.find((w) => w.id === ng.wave)!;
  const parts = formats.map((f) => {
    const b = backingOf(f, waves, ng.wave);
    return b.kind === "named"
      ? `names ${code(b.item)} for ${code(b.row)}`
      : `does not name ${code(b.row)}, which reaches ${ng.wave} by section 8's clause that a gap not listed goes to the wave owning its format (the row lists ${code(b.item)})`;
  });
  return `- **${ng.id} (${ng.wave}): a design row backs the wave.** Section 8's row for ${ng.wave} (${wave.name}) ${parts.join("; ")}.`;
}

const entriesOf = (ledger: Ledger, wave: string): LedgerEntry[] => ledger.entries.filter((e) => e.wave === wave);

/** The section, ending with one newline. Pure over its input; the text passes through redact() (the repo is public). */
export function renderBacklog(input: BacklogInput): string {
  const waves = designWaves(input.design);
  guard(input, waves);
  const { triage, ledger } = input;
  const designLines = new Map(input.newGaps.gaps.map((ng) => [ng.id, designRowLine(ng, input, waves)]));
  const carries = deriveCarries(input, waves);
  const layerOf = new Map(triage.rows.map((r) => [r.caseId, r.layer as string]));
  const fill = (s: string): string => s.replaceAll("{sha}", input.sha);

  const baseline = `The baseline is the merged run of each layer (${triage.runs.map((r) => `${r.layer} ${code(r.runId)}: ${r.cases} cases, ${r.reds} ❌`).join("; ")}). The triage read ${triage.scanned} cases and keyed ${triage.rows.length} ❌ to ${triage.gaps.length} gaps; the ledger holds ${ledger.entries.length} audit ids, ${ledger.counts["not-exercised"]} of them \`not-exercised\`.`;
  const out: string[] = [`## ${fill(input.carries.heading)}`, ""];
  for (const p of input.carries.intro) {
    const text = fill(p.replaceAll("{baseline}", baseline));
    const left = [...placeholdersOf(text)];
    if (left.length > 0) throw new BacklogRefused("CarryPlaceholder", `the intro names {${left.join("}, {")}}, which nothing fills`);
    out.push(text, "");
  }

  const gapsOf = (wave: string): TriageJson["gaps"] => triage.gaps.filter((g) => g.wave === wave);
  const redsOf = (wave: string): number => gapsOf(wave).reduce((n, g) => n + g.caseIds.length, 0);
  out.push(...table(
    ["wave", "name", "gaps", "❌ cases", "audit ids", ...OUTCOMES],
    waves.map((w) => {
      const mine = entriesOf(ledger, w.id);
      return [w.id, cell(w.name), String(gapsOf(w.id).length), String(redsOf(w.id)), String(mine.length), ...OUTCOMES.map((o) => String(mine.filter((e) => e.outcome === o).length))];
    }),
  ), "");

  for (const w of waves) {
    const mine = entriesOf(ledger, w.id);
    const gaps = gapsOf(w.id);
    out.push(`### ${w.id} — ${w.name}`, "");
    out.push(mine.length === 0 ? `No audit id routes to ${w.id}.` : `The ledger holds ${mine.length} audit ids for ${w.id}: ${OUTCOMES.map((o) => `${mine.filter((e) => e.outcome === o).length} ${o}`).join(", ")}.`, "");
    if (gaps.length === 0) out.push(`No ❌ case of the baseline is keyed to ${w.id}.`, "");
    else {
      out.push(...table(
        ["gap", "title", "cases", "layers", "examples"],
        gaps.map((g) => [
          cell(g.gap), cell(g.title), g.alsoCaseIds === undefined ? String(g.caseIds.length) : `${g.caseIds.length} (+${g.alsoCaseIds.length} also)`,
          g.layers.join(", "), examplesOf(g, layerOf).map((id) => code(cell(id))).join(", "),
        ]),
      ), "");
    }
    const ne = mine.filter((e) => e.outcome === "not-exercised");
    if (ne.length === 0) out.push(`None of ${w.id}'s audit ids is \`not-exercised\`.`, "");
    else out.push(`Audit ids no baseline case drives (\`not-exercised\`, ${ne.length}): each is owed a scenario before ${w.id} can close it.`, "", ...table(["id", "severity", "title"], ne.map((e) => [cell(e.id), cell(e.severity), cell(e.title)])), "");
    const notes = [
      ...input.newGaps.gaps.filter((ng) => ng.wave === w.id).map((ng) => designLines.get(ng.id)!),
      ...(carries.get(w.id) ?? []).map((c) => `- **${c.title}** — ${c.text}`),
    ];
    if (notes.length > 0) out.push(...notes, "");
  }
  return redact(`${out.slice(0, out[out.length - 1] === "" ? -1 : undefined).join("\n")}\n`);
}

/** The counts the CLI prints: gaps, ❌ cases, not-exercised ids and the waves written. */
export function summaryOf(input: BacklogInput): { gaps: number; cases: number; notExercised: number; waves: number } {
  return { gaps: input.triage.gaps.length, cases: input.triage.rows.length, notExercised: input.ledger.counts["not-exercised"], waves: designWaves(input.design).length };
}

// --- the loader ------------------------------------------------------------------------------------------------------------------

type ReadName = "TriageUnreadable" | "BaselineUnreadable" | "CatalogueUnreadable" | "DesignUnreadable";

/** A JSON file, parsed by its schema: unreadable, not JSON and schema-refused are each named. */
function readJson<T>(name: ReadName, file: string, parse: (json: unknown) => T): T {
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new BacklogRefused(name, `${file}: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    return parse(json);
  } catch (e) {
    const why = e instanceof z.ZodError ? e.issues.slice(0, 3).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ") : String(e);
    throw new BacklogRefused(name, `${file}: the file's schema refuses it: ${why}`);
  }
}

/** A repo-relative path's text, or null when the repo has no such file. */
function repoReader(repo: string): (rel: string) => string | null {
  return (rel) => {
    try {
      return readFileSync(join(repo, rel), "utf8");
    } catch (e) {
      if (e instanceof Error && "code" in e && (e.code === "ENOENT" || e.code === "EISDIR" || e.code === "ENOTDIR")) return null;
      throw e;
    }
  };
}

const HarnessRunSchema = z.object({ harnessCommit: z.string().min(7), runId: z.string().min(1), cases: z.array(z.object({ caseId: z.string().min(1) })) });

export interface LoadOptions { triage: string; sha: string; baseline?: string; design?: string; catalogue?: string }

/** Reads everything the writer needs, and holds it to the baseline it names: `sha` is that commit (the layers' harness commit is a
 *  prefix of it, so it is at least as long) and the triage was written from those runs. */
export function loadBacklogInput(opts: LoadOptions): BacklogInput {
  const baseline = opts.baseline ?? DEFAULT_BASELINE;
  const catalogue = opts.catalogue ?? CATALOGUE_DIR;
  const triage = readJson("TriageUnreadable", opts.triage, parseTriage);
  const runs = LAYERS.map((layer) => ({ layer, run: readJson("BaselineUnreadable", join(baseline, layer, "results.json"), (j) => HarnessRunSchema.parse(j)) }));

  if (!/^[0-9a-f]{7,40}$/.test(opts.sha)) throw new BacklogRefused("ShaNotBaseline", `--sha ${opts.sha} is not a commit name (7 to 40 hex characters)`);
  for (const { layer, run } of runs) {
    if (!opts.sha.startsWith(run.harnessCommit)) {
      throw new BacklogRefused("ShaNotBaseline", `--sha ${opts.sha} is not the commit the baseline's ${layer} run was made at (${run.harnessCommit})`);
    }
  }
  for (const { layer, run } of runs) {
    const t = triage.runs.find((r) => r.layer === layer);
    if (t === undefined || t.runId !== run.runId) {
      throw new BacklogRefused("TriageNotBaseline", `the triage's ${layer} run is ${t?.runId ?? "missing"} and the baseline's is ${run.runId}: write the triage from the committed baseline`);
    }
  }

  const cat = loadCatalogue(catalogue);
  const verdicts = readJson("CatalogueUnreadable", join(catalogue, "audit-verdicts.json"), parseVerdicts).verdicts;
  const carries = readJson("CatalogueUnreadable", join(catalogue, "backlog-carries.json"), parseCarries);
  const audit = readAudit(AUDIT_DIR);
  const ledger = buildLedger({ gaps: audit.gaps, umbrellas: audit.umbrellas, routing: cat.routing, triage, verdicts, readFile: repoReader(REPO_ROOT) });
  const cuts = readJson("BaselineUnreadable", join(baseline, "dispatch-cuts.json"), parseCuts);
  const design = opts.design ?? DEFAULT_DESIGN;
  let designText: string;
  try {
    designText = readFileSync(design, "utf8");
  } catch (e) {
    throw new BacklogRefused("DesignUnreadable", `${design}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const l3 = runs.find((r) => r.layer === "L3")!.run;
  return { sha: opts.sha, triage, ledger, newGaps: cat.newGaps, routing: cat.routing, rules: cat.rules, carries, cuts, l3CaseIds: l3.cases.map((c) => c.caseId), design: designText };
}
