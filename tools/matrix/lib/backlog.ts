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
import { BaselineUnreadable, baselineOverrides, ruling70AppliesTo } from "./pr-sample.ts";
import { redact } from "./redact.ts";
import { GLYPH, LAYERS } from "./results.ts";
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

/** The intro placeholders the writer fills from the committed layers with what the ❌ count leaves out (T22 review m3): the ░ planned
 *  cases, the 🚫 cases with no organiser path, and the cells an override holds red that the committed run does not. */
const LEAVES_OUT = ["planned", "noPath", "overridden"] as const;

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
  intro: z.array(z.string().min(1)).min(1)
    .refine((p) => p.some((x) => x.includes("{baseline}")), "the intro carries {baseline}: the paragraph naming the runs the section was written from")
    .refine((p) => LEAVES_OUT.every((k) => p.some((x) => x.includes(`{${k}}`))), `the intro carries ${LEAVES_OUT.map((k) => `{${k}}`).join(", ")}: what the ❌ count leaves out (T22 review m3)`),
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

/** One case of a committed layer, as the backlog reads it. */
export interface BaselineCase { layer: string; caseId: string; state: string; reason: string }

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
  /** Every case of the three committed layers: where it ran, the state it ended in and (a 🚫) why. The cut is a subset of L3's. */
  cases: BaselineCase[];
  /** Owner ruling 70's cells: the `ruling70.ids` of catalogue/baseline.json, in its order, which is the list `judge regression` applies (and
   *  the weekly diff marks). Empty once the SW-H1 fix retires the block. The held set and its figure derive from THIS and the committed L3,
   *  never from the dispatch cut's state flips (PR-B review m3): the two are different sources and the judge reads this one. */
  ruling70: readonly string[];
  /** The design document's text: section 8 is read by designWaves. */
  design: string;
}

// --- cells -----------------------------------------------------------------------------------------------------------------------

/** A table cell: a bare pipe would end it, and a case id or an audit title can hold one. */
export const cell = (s: string): string => s.replaceAll("|", "\\|");
const code = (s: string): string => `\`${s}\``;
/** 1505 -> "1,505" (grouped by hand: the output must not depend on the host's locale data). */
const num = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
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
/** `waveOf` is every carry's wave, found from its anchor: deriveCarries fills it for ALL carries (and refuses one whose anchor routes to
 *  no wave of section 8) before any derivation runs, so a derivation that points at another carry may read it. */
interface DeriveCtx { input: BacklogInput; anchor: string; waveOf: ReadonlyMap<string, string> }
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

/** The triage rows of the named cases, or the refusal that one of them is keyed to nothing. */
function rowsOf(triage: TriageJson, ids: readonly string[], carry: string): TriageJson["rows"] {
  return ids.map((id) => {
    const row = triage.rows.find((r) => r.caseId === id);
    if (row === undefined) throw refuse("CarrySourceMissing", carry, `the triage keys ${id} to no gap`);
    return row;
  });
}

/** Owner ruling 70's cells (the list `judge regression` applies), and those of them the committed L3 does not have red: only `judge regression`
 *  holds those red, so the triage counts none of them. The list is baseline.json's, never the dispatch cut's flips (PR-B review m3). `label`
 *  names the reader in a refusal. */
function ruledCells(input: BacklogInput, label: string): { cells: readonly string[]; held: { id: string; state: string }[] } {
  const cells = input.ruling70;
  const l3 = new Map(input.cases.filter((c) => c.layer === "L3").map((c) => [c.caseId, c.state]));
  const held = cells.flatMap((id) => {
    const state = l3.get(id);
    if (state === undefined) throw refuse("CarrySourceMissing", label, `the committed L3 holds no case ${id}, which baseline.json's ruling70 lists`);
    return state === "red" ? [] : [{ id, state }];
  });
  return { cells, held };
}

/** How many of the cases `keep` selects each layer holds, in layer order (a layer with none is left out). */
const perLayer = (cases: readonly BaselineCase[], keep: (c: BaselineCase) => boolean): { layer: string; n: number }[] =>
  LAYERS.map((layer) => ({ layer, n: cases.filter((c) => c.layer === layer && keep(c)).length })).filter((x) => x.n > 0);
/** "L2 1,505"; with more than one layer "L1 53 and L2 164, 217 in all"; "none" for no layer at all. */
function layerText(rows: readonly { layer: string; n: number }[]): string {
  if (rows.length === 0) return "none";
  const parts = list(rows.map((r) => `${r.layer} ${num(r.n)}`));
  return rows.length === 1 ? parts : `${parts}, ${num(rows.reduce((n, r) => n + r.n, 0))} in all`;
}
/** The wave a 🚫 case's own reason routes it to: the text before its first `: ` (`<wave>: no organiser path, ...`). */
const routedWave = (reason: string): string => reason.split(": ")[0];

/** A mexicano R4 cell: the one family the intermittent-500 carry is about. */
const MEXICANO_R4 = /^mexicano\|[^|]+\|[^|]+\|R4$/;
/** A swiss_playoff R4 cell: the family whose reason flips between two classes while its state and failing set stay put. */
const SWISS_PLAYOFF_R4 = /^swiss_playoff\|[^|]+\|[^|]+\|R4$/;

type ReasonClass = "SW-H1" | "stall" | null;
/** The swiss_playoff R4 cells of the dispatch cut that stay red with ONE failing set while their reason flips between the two classes, and
 *  each cell's class per dispatch. A cell that also changes its state or its failing set is no cell of this shape, and a reason of a third
 *  class is not printed as a guess: each is refused by name. `carry` is the reader named in a refusal. */
function swissFlips(cuts: Cuts, carry: string): { flips: string[]; classes: Map<string, ReasonClass[]> } {
  const classOf = (reason: string): ReasonClass => (/\(SW-H1\)|paired nobody/.test(reason) ? "SW-H1" : /did not complete/.test(reason) ? "stall" : null);
  const steady = cuts.ids.filter((id) => SWISS_PLAYOFF_R4.test(id));
  // The carry says these cells change only their reason: a cell that also changes its state or its failing set is no cell of it.
  for (const id of steady) {
    const cs = perDispatch(cuts, id, carry);
    if (!cs.every((c) => c.state === "red") || new Set(cs.map(failingOf)).size !== 1) {
      throw refuse("CarryShapeUnknown", carry, `${id} changes its state or its failing-check set between the dispatches: this carry describes cells that change only their reason`);
    }
  }
  const classes = new Map(steady.map((id) => [id, perDispatch(cuts, id, carry).map((c) => classOf(c.reason))]));
  const flips = steady.filter((id) => classes.get(id)!.includes("SW-H1") && classes.get(id)!.includes("stall"));
  if (flips.length === 0) throw refuse("CarryEmpty", carry, "no swiss_playoff R4 cell of the dispatch cut is red in every dispatch with one failing set and two reasons");
  for (const id of steady) {
    if (classes.get(id)!.includes(null)) throw refuse("CarryShapeUnknown", carry, `${id} has a reason that is neither the SW-H1 shape (paired nobody) nor the stall shape (did not complete): say which it is before the carry prints it`);
  }
  return { flips, classes };
}

const DERIVERS: Record<string, Deriver> = {
  // SC-P4: the ledger's own reading of the id the W2 prompt's trap 2 cites.
  "sc-p4-oracle": ({ input, anchor }) => {
    const e = input.ledger.entries.find((x) => x.id === anchor);
    if (e === undefined || e.outcome === null || e.evidence === null || e.wave === null) throw refuse("CarrySourceMissing", "sc-p4-oracle", `the ledger holds no outcome for ${anchor}`);
    return { values: { outcome: e.outcome, evidence: e.evidence }, waves: [e.wave] };
  },

  // Ruling 70: the cells of baseline.json's list, where the committed run keys SW-H1, and which of them it holds red that the committed run
  // does not have red (T22 review m3; the list is the judge's, not the dispatch cut's flips: PR-B review m3).
  "ruling-70": ({ input, anchor }) => {
    const { cells, held } = ruledCells(input, "ruling-70");
    if (cells.length === 0) throw refuse("CarryEmpty", "ruling-70", "baseline.json carries no ruling70 list, so `judge regression` holds nothing: remove this carry with the block");
    const g = groupOf(input.triage, anchor, "ruling-70");
    const keyedCells = g.caseIds.filter((id) => cells.includes(id));
    const keyed = `${g.caseIds.length} cases of the committed run (${list(g.caseIds.map(code))}), of which ${keyedCells.length === 0 ? "none is" : `${list(keyedCells.map(code))} ${keyedCells.length === 1 ? "is" : "are"}`} one of the ruling's cells`;
    const many = held.length > 1;
    const rest = held.length === 0
      ? "Every cell of the ruling is red in the committed run."
      : `The ruling's other ${held.length} cell${many ? "s" : ""} (${list(held.map((h) => code(h.id)))}) ${many ? "are" : "is"} ${list([...new Set(held.map((h) => code(h.state)))])} in the committed run: the triage counts ${many ? "none of them" : "it nowhere"}, and only \`judge regression\` holds ${many ? "them" : "it"} red until the re-baseline.`;
    return { values: { cells: list(cells.map(code)), keyed, held: rest }, waves: [g.wave] };
  },

  // The recommendation is prose with no number to derive; it still hangs on its anchor.
  "p6-recommendation": () => ({ values: {}, waves: [] }),

  // swiss_playoff R4: red in every dispatch with one failing set, the reason flips between two classes.
  "swiss-playoff-reason-flip": ({ input }) => {
    const { cuts, triage } = input;
    const { flips, classes } = swissFlips(cuts, "swiss-playoff-reason-flip");
    const ns = cuts.dispatches.map((d) => d.n);
    const pattern = (id: string): string => classes.get(id)!.map((c, i) => `dispatch ${ns[i]} ${c}`).join(", ");
    const patterns = [...new Set(flips.map(pattern))];
    const flipsText = patterns.length === 1 ? patterns[0] : flips.map((id) => `${code(id)}: ${pattern(id)}`).join("; ");
    const keyed = list(rowsOf(triage, flips, "swiss-playoff-reason-flip").map((row) => `${row.gap} (${code(row.caseId)})`));
    return { values: { cells: list(flips.map(code)), flips: flipsText, keyed, committed: String(ns[ns.length - 1]) }, waves: [] };
  },

  // The same cells seen from the wave that owns the gaps the committed run keys them to (T22 review m8): a count of those gaps moves with
  // the dispatch, and the carry that explains it sits in another wave's section. The owner wave and the carry's title are the carry's own.
  "swiss-playoff-keyed-here": ({ input, waveOf }) => {
    const { flips } = swissFlips(input.cuts, "swiss-playoff-keyed-here");
    const rows = rowsOf(input.triage, flips, "swiss-playoff-keyed-here");
    // The carry this one points at is in the file: DERIVERS holds its id, and deriveCarries refuses (CarryMissing) a file without it
    // before any derivation runs (a test reaches that refusal).
    const flip = input.carries.carries.find((c) => c.id === "swiss-playoff-reason-flip")!;
    return {
      values: { keyed: list(rows.map((r) => `${r.gap} (${code(r.caseId)})`)), gaps: list([...new Set(rows.map((r) => r.gap))]), owner: waveOf.get(flip.id)!, flipTitle: flip.title },
      waves: rows.map((r) => r.wave),
    };
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
    const { cuts, triage } = input;
    const total = input.cases.filter((c) => c.layer === "L3" && MEXICANO_R4.test(c.caseId)).map((c) => c.caseId);
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

/** Every carry's text with its placeholders filled, by the wave its anchor routes to. Two passes: every carry's wave is found first (so a
 *  derivation may point at another carry's wave), then each is derived, in the order the file lists them. */
function deriveCarries(input: BacklogInput, waves: readonly DesignWave[]): Map<string, WaveCarry[]> {
  const ids = input.carries.carries.map((c) => c.id);
  for (const id of ids) if (!Object.hasOwn(DERIVERS, id)) throw new BacklogRefused("CarryUnknown", `carry ${id}: no derivation of lib/backlog.ts fills it`);
  for (const id of Object.keys(DERIVERS)) if (!ids.includes(id)) throw new BacklogRefused("CarryMissing", `carry ${id}: the derivation exists and backlog-carries.json holds no such carry`);
  const waveOf = new Map<string, string>();
  for (const c of input.carries.carries) {
    const wave = routeOf(input.routing, c.anchor);
    if (wave === null) throw refuse("CarryWaveDisagrees", c.id, `its anchor ${c.anchor} routes to no wave`);
    if (!waves.some((w) => w.id === wave)) throw refuse("UnknownWave", c.id, `its anchor ${c.anchor} routes to ${wave}, a wave section 8 has no backlog for`);
    waveOf.set(c.id, wave);
  }
  const out = new Map<string, WaveCarry[]>();
  for (const c of input.carries.carries) {
    const wave = waveOf.get(c.id)!;
    const d = DERIVERS[c.id]({ input, anchor: c.anchor, waveOf });
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
  if (triage.scanned === 0) throw new BacklogRefused("NoCases", "the triage scanned no case: reds out of nothing is no triage (vacuous)");
  if (input.cases.length === 0) throw new BacklogRefused("NoCases", "the baseline holds no case: what the ❌ count leaves out would read as zero (vacuous)");
  const rowGap = new Map(triage.rows.map((r) => [r.caseId, r.gap]));
  if (rowGap.size !== triage.rows.length) throw new BacklogRefused("TriageInconsistent", "a case is keyed in two rows of the triage");
  if (!isClean(triage)) throw new BacklogRefused("TriageInconsistent", "the triage is not clean (an untriaged, ambiguous, misrouted or unknown-gap red): its gaps are not every red");
  if (triage.checked !== triage.rows.length) throw new BacklogRefused("TriageInconsistent", `the triage says it checked ${triage.checked} reds and holds ${triage.rows.length} rows`);
  // T22 review m2: the totals the intro prints are the triage's own and are held to its rows, layer by layer, so a hand-edited or stale
  // triage.json cannot print "L1: 231 cases, 0 ❌" beside 209 keyed.
  for (const run of triage.runs) {
    const keyed = triage.rows.filter((r) => r.layer === run.layer).length;
    if (keyed !== run.reds) throw new BacklogRefused("TriageInconsistent", `the triage says its ${run.layer} run holds ${run.reds} ❌ and keys ${keyed} rows to it`);
  }
  const ran = new Set<string>(triage.runs.map((r) => r.layer));
  const orphan = triage.rows.find((r) => !ran.has(r.layer));
  if (orphan !== undefined) throw new BacklogRefused("TriageInconsistent", `${orphan.caseId} is a ${orphan.layer} case and the triage lists no ${orphan.layer} run`);
  const read = triage.runs.reduce((n, r) => n + r.cases, 0);
  if (read !== triage.scanned) throw new BacklogRefused("TriageInconsistent", `the triage's runs read ${read} cases and it says it scanned ${triage.scanned}`);
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
  const strayPath = input.cases.find((c) => c.state === "no_path" && !known.has(routedWave(c.reason)));
  if (strayPath !== undefined) {
    throw new BacklogRefused("UnknownWave", `${GLYPH.no_path} case ${strayPath.caseId} (${strayPath.layer}) names no wave of section 8 in its reason (${JSON.stringify(strayPath.reason.slice(0, 60))}): its count would drop out of every wave's line`);
  }
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

/** What the ❌ count leaves out (T22 review m3), each as the clause the intro prints, counted from the committed layers and never typed:
 *  the ░ planned cases, the 🚫 cases with no organiser path, and the cells owner ruling 70 holds red inside `judge regression` that the
 *  committed L3 has in another state. `judge regression` reads the L3 baseline ONLY (baselineL3Path), so its figure with the override is
 *  L3's own reds plus the held cells, never the all-layer count the triage keys (T22 fix round 2). The frame is prose in the carries
 *  file; this is the data. */
function leavesOut(input: BacklogInput): Record<(typeof LEAVES_OUT)[number], string> {
  const l3Reds = input.cases.filter((c) => c.layer === "L3" && c.state === "red").length;
  const { held } = ruledCells(input, "the intro (ruling 70's cells)");
  const many = held.length > 1;
  return {
    planned: layerText(perLayer(input.cases, (c) => c.state === "not_run")),
    noPath: layerText(perLayer(input.cases, (c) => c.state === "no_path")),
    overridden: held.length === 0
      ? "none"
      : `${list(held.map((h) => code(h.id)))} (${held.length} cell${many ? "s" : ""}, ${list([...new Set(held.map((h) => code(h.state)))])} in the committed L3); \`judge regression\` reads the L3 baseline only, so with ${many ? "them" : "it"} it holds ${num(l3Reds + held.length)} red cases, not the ${num(l3Reds)} of the committed L3`,
  };
}

/** The section, ending with one newline. Pure over its input; the text passes through redact() (the repo is public). */
export function renderBacklog(input: BacklogInput): string {
  const waves = designWaves(input.design);
  guard(input, waves);
  const { triage, ledger } = input;
  const designLines = new Map(input.newGaps.gaps.map((ng) => [ng.id, designRowLine(ng, input, waves)]));
  const carries = deriveCarries(input, waves);
  const layerOf = new Map(triage.rows.map((r) => [r.caseId, r.layer as string]));
  const fill = (s: string): string => s.replaceAll("{sha}", input.sha);

  const baseline = `The baseline is the merged run of each layer (${triage.runs.map((r) => `${r.layer} ${code(r.runId)}: ${num(r.cases)} cases, ${num(r.reds)} ❌`).join("; ")}). The triage read ${num(triage.scanned)} cases and keyed ${triage.rows.length} ❌ to ${triage.gaps.length} gaps; the ledger holds ${ledger.entries.length} audit ids, ${ledger.counts["not-exercised"]} of them \`not-exercised\`.`;
  const out: string[] = [`## ${fill(input.carries.heading)}`, ""];
  const introValues: Record<string, string> = { baseline, ...leavesOut(input) };
  const introUsed = new Set<string>();
  for (const p of input.carries.intro) {
    let text = p;
    for (const [k, v] of Object.entries(introValues)) {
      if (text.includes(`{${k}}`)) introUsed.add(k);
      text = text.replaceAll(`{${k}}`, v);
    }
    text = fill(text);
    const left = [...placeholdersOf(text)];
    if (left.length > 0) throw new BacklogRefused("CarryPlaceholder", `the intro names {${left.join("}, {")}}, which nothing fills`);
    out.push(text, "");
  }
  const dropped = LEAVES_OUT.filter((k) => !introUsed.has(k));
  if (dropped.length > 0) throw new BacklogRefused("CarryPlaceholder", `the intro never uses {${dropped.join("}, {")}}, which the layers fill: a count the section computed would not be printed`);

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
    const path = perLayer(input.cases, (c) => c.state === "no_path" && routedWave(c.reason) === w.id);
    const pathN = path.reduce((n, r) => n + r.n, 0);
    out.push(
      pathN === 0 ? `No ${GLYPH.no_path} case routes to ${w.id} by its own reason.`
        : pathN === 1 ? `${GLYPH.no_path} 1 planned case has no organiser path and routes to ${w.id} by its own reason (${layerText(path)}); the baseline never drove it, so it is in no table below.`
          : `${GLYPH.no_path} ${num(pathN)} planned cases have no organiser path and route to ${w.id} by their own reason (${layerText(path)}); the baseline never drove them, so they are in no table below.`,
      "",
    );
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

const HarnessRunSchema = z.object({
  harnessCommit: z.string().min(7),
  runId: z.string().min(1),
  cases: z.array(z.object({ caseId: z.string().min(1), state: z.string().min(1), reason: z.string().optional() })),
});

/** baseline.json's ruling-70 ids, read by the baseline's own reader (the one `judge regression` applies, which refuses a block written for another
 *  run or tag), and held to the L3 run this backlog counts: a list that does not qualify that run holds nothing there. Empty when the file
 *  carries no block (retired with the SW-H1 fix). */
function ruling70Of(catalogue: string, l3RunId: string): string[] {
  let block: ReturnType<typeof baselineOverrides>;
  try { block = baselineOverrides({ catalogue }); } catch (e) {
    if (e instanceof BaselineUnreadable) throw new BacklogRefused("BaselineUnreadable", e.message);
    throw e;
  }
  if (block === null) return [];
  if (!ruling70AppliesTo(block, l3RunId)) {
    throw new BacklogRefused("BaselineUnreadable", `baseline.json's ruling70 was written for workflow run ${block.workflowRun}, and the L3 this backlog counts is ${l3RunId}: the held figure would describe a hold the judge does not apply to it`);
  }
  return [...block.ids];
}

export interface LoadOptions { triage: string; sha: string; baseline?: string; design?: string; catalogue?: string }

/** Reads everything the writer needs, and holds it to the baseline it names: `sha` is the commit every layer's run records, EXACTLY (T22
 *  review m1: a prefix check let a typo past the recorded characters through) and the triage was written from those runs, its run ids and
 *  its per-layer case and red counts the baseline's own. */
export function loadBacklogInput(opts: LoadOptions): BacklogInput {
  const baseline = opts.baseline ?? DEFAULT_BASELINE;
  const catalogue = opts.catalogue ?? CATALOGUE_DIR;
  const triage = readJson("TriageUnreadable", opts.triage, parseTriage);
  const runs = LAYERS.map((layer) => ({ layer, run: readJson("BaselineUnreadable", join(baseline, layer, "results.json"), (j) => HarnessRunSchema.parse(j)) }));

  if (!/^[0-9a-f]{7,40}$/.test(opts.sha)) throw new BacklogRefused("ShaNotBaseline", `--sha ${opts.sha} is not a commit name (7 to 40 hex characters)`);
  for (const { layer, run } of runs) {
    if (opts.sha !== run.harnessCommit) {
      throw new BacklogRefused("ShaNotBaseline", `--sha ${opts.sha} is not the commit the baseline's ${layer} run was made at (${run.harnessCommit}): the heading names that commit exactly, not a longer or a shorter name of it`);
    }
  }
  for (const { layer, run } of runs) {
    const t = triage.runs.find((r) => r.layer === layer);
    if (t === undefined || t.runId !== run.runId) {
      throw new BacklogRefused("TriageNotBaseline", `the triage's ${layer} run is ${t?.runId ?? "missing"} and the baseline's is ${run.runId}: write the triage from the committed baseline`);
    }
    const reds = run.cases.filter((c) => c.state === "red").length;
    if (t.cases !== run.cases.length) throw new BacklogRefused("TriageNotBaseline", `the triage's ${layer} run read ${t.cases} cases and the baseline's holds ${run.cases.length}: write the triage from the committed baseline`);
    if (t.reds !== reds) throw new BacklogRefused("TriageNotBaseline", `the triage's ${layer} run holds ${t.reds} ❌ and the baseline's has ${reds} red: write the triage from the committed baseline`);
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
  const cases = runs.flatMap(({ layer, run }) => run.cases.map((c) => ({ layer, caseId: c.caseId, state: c.state, reason: c.reason ?? "" })));
  return { sha: opts.sha, triage, ledger, newGaps: cat.newGaps, routing: cat.routing, rules: cat.rules, carries, cuts, cases, ruling70: ruling70Of(catalogue, runs.find((r) => r.layer === "L3")!.run.runId), design: designText };
}
