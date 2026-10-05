// W1d Task 18 (ruling 63, D18): the triage. Every red of a run is keyed to exactly one audit gap id (or NEW-W1d-<n>) and
// that gap's owning wave, by a committed table of rules (catalogue/triage-rules.json) read against design §8's routing
// (catalogue/gap-routing.json). Four outcomes per red: one rule matches (a row), none (untriaged), two or more (ambiguous).
// A rule that routes a gap anywhere but where §8 puts it is misrouted — never re-route a gap §8 assigns — and a rule naming
// a gap the audit and new-gaps.json do not hold is unknown. The rules are judged whether or not a red matched them: a bad
// rule is bad today, not only when data finds it.
//
// DB-free like every tool: this module reads files and folds results.json, nothing else. W1-driving's 164 product reds,
// keyed today by its own P-rules, are re-keyed through `rekey` (Task 19 consumes it).
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { LAYERS, type CaseResult, type CaseState, type Layer } from "./results.ts";

const MATRIX = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** The committed rules, routing and new gaps (the verdicts file beside them belongs to the ledger). */
export const CATALOGUE_DIR = resolve(MATRIX, "catalogue");

export const TRIAGE_REFUSALS = [
  "NoRun", "NoCases", "EmptyLayer", "DuplicateLayer", "DuplicateCase", "LayerMismatch", "RunUnreadable", "RunNotV3", "CatalogueUnreadable", "RekeyMapEmpty", "RekeyMapUnreadable", "RekeyUnknownCase",
] as const;
export type TriageRefusalName = (typeof TRIAGE_REFUSALS)[number];

/** Every way the triage refuses to judge (exit 2, nothing written). Each is the Error's own `name`. */
export class TriageRefused extends Error {
  constructor(name: TriageRefusalName, message: string) {
    super(message);
    this.name = name;
  }
}

// --- the committed files ------------------------------------------------------------------------------------------------

const WAVE = z.string().regex(/^W\d+[a-z]?$/, "a wave id, W<n>");
/** An audit gap id (SW-H1, SC-O1, FX-G13) or a gap this wave found (NEW-W1d-<n>). */
const GAP_ID = /^(?:[A-Z]{2}-[A-Z]+\d+|NEW-W1d-\d+)$/;
const NEW_GAP_ID = /^NEW-W1d-\d+$/;

const RuleSchema = z.strictObject({
  id: z.string().min(1),
  match: z.strictObject({
    // A glob over `row|sport`: `*` stays inside its segment.
    cell: z.string().regex(/^[^|]+\|[^|]+$/, "row|sport").optional(),
    scenario: z.string().min(1).optional(),
    layer: z.enum(LAYERS).optional(),
    // A FAILING check's id.
    check: z.string().min(1).optional(),
    // A substring of the case's reason; never empty (the empty string is in every reason).
    reason: z.string().min(1).optional(),
  }).refine((m) => Object.values(m).some((v) => v !== undefined), "a rule matches on at least one of cell, scenario, layer, check, reason — an empty match is every red, and would hide each untriaged one"),
  gap: z.string().regex(GAP_ID, "an audit gap id or a NEW- gap id"),
  wave: WAVE,
  /** The W1-driving triage rule this one re-keys (P1..P7). */
  was: z.string().min(1).optional(),
  note: z.string().min(1),
});
export type Rule = z.infer<typeof RuleSchema>;

const TriageRulesSchema = z.strictObject({ rules: z.array(RuleSchema) }).superRefine((v, ctx) => {
  const seen = new Set<string>();
  for (const r of v.rules) {
    // Ambiguity is named by rule id: a repeated id would hide which of two rules fired.
    if (seen.has(r.id)) ctx.addIssue({ code: "custom", path: ["rules"], message: `duplicate rule id ${r.id}` });
    seen.add(r.id);
  }
});
export type TriageRules = z.infer<typeof TriageRulesSchema>;
export const parseRules = (json: unknown): TriageRules => TriageRulesSchema.parse(json);

const GapRoutingSchema = z.strictObject({
  note: z.string().min(1),
  // An exact audit id, or `<PREFIX>-*`; the value is the wave design §8 gives it.
  routes: z.record(z.string().regex(/^[A-Z]{2}-(?:[A-Z]+\d+|\*)$/, "an audit id or <PREFIX>-*"), WAVE),
});
export type GapRouting = z.infer<typeof GapRoutingSchema>;
export const parseRouting = (json: unknown): GapRouting => GapRoutingSchema.parse(json);

const NewGapsSchema = z.strictObject({
  gaps: z.array(z.strictObject({ id: z.string().regex(NEW_GAP_ID, "a NEW- gap id"), wave: WAVE, title: z.string().min(1), evidence: z.string().min(1) })),
}).superRefine((v, ctx) => {
  const seen = new Set<string>();
  for (const g of v.gaps) {
    if (seen.has(g.id)) ctx.addIssue({ code: "custom", path: ["gaps"], message: `duplicate gap id ${g.id}` });
    seen.add(g.id);
  }
});
export type NewGaps = z.infer<typeof NewGapsSchema>;
export const parseNewGaps = (json: unknown): NewGaps => NewGapsSchema.parse(json);

/** The wave design §8 gives a gap: its exact id, else its `<PREFIX>-*` wildcard (an exact id wins), else null. */
export function routeOf(routing: GapRouting, gap: string): string | null {
  if (Object.hasOwn(routing.routes, gap)) return routing.routes[gap];
  const wild = `${gap.split("-")[0]}-*`;
  return Object.hasOwn(routing.routes, wild) ? routing.routes[wild] : null;
}

const issuesOf = (e: z.ZodError): string => e.issues.slice(0, 3).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");

/** The three catalogue files the triage reads, each parsed by its schema or named as unreadable. */
export function loadCatalogue(dir: string): { rules: TriageRules; routing: GapRouting; newGaps: NewGaps } {
  const read = <T>(file: string, parse: (j: unknown) => T): T => {
    const path = join(dir, file);
    let json: unknown;
    try {
      json = JSON.parse(readFileSync(path, "utf8"));
    } catch (e) {
      throw new TriageRefused("CatalogueUnreadable", `${path}: ${e instanceof Error ? e.message : String(e)}`);
    }
    try {
      return parse(json);
    } catch (e) {
      if (e instanceof z.ZodError) throw new TriageRefused("CatalogueUnreadable", `${path}: ${issuesOf(e)}`);
      throw e;
    }
  };
  return { rules: read("triage-rules.json", parseRules), routing: read("gap-routing.json", parseRouting), newGaps: read("new-gaps.json", parseNewGaps) };
}

// --- triage ---------------------------------------------------------------------------------------------------------------

/** What the triage reads of a run: its layer and its cases. */
export interface TriageRun {
  readonly layer: Layer;
  readonly runId: string;
  readonly plan?: string | undefined;
  readonly cases: readonly CaseResult[];
}

export interface TriageRow { caseId: string; layer: Layer; gap: string; wave: string; rule: string; was?: string }
export interface Ambiguous { caseId: string; rules: string[] }
export interface Misrouted { rule: string; gap: string; wave: string; routed: string | null }
export interface UnknownGap { rule: string; gap: string }

export interface TriageResult {
  rows: TriageRow[];
  untriaged: string[];
  ambiguous: Ambiguous[];
  misrouted: Misrouted[];
  unknownGap: UnknownGap[];
  /** The reds read (anti-vacuity: a triage says how many it looked at). */
  checked: number;
  /** Every case of every run, red or not. */
  scanned: number;
  /** The case ids that passed (state works), in run order: the ledger checks a verdict's cited cases against them. */
  works: string[];
  /** Every case id of every run, for `rekey` to tell "not red" from "not there". Never written to triage.json. */
  seen: ReadonlySet<string>;
}

/** `*` stays inside a segment; every other character is a literal. */
function globToRegExp(cell: string): RegExp {
  const seg = (s: string): string => s.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^|]*");
  const [row, sport] = cell.split("|") as [string, string];
  return new RegExp(`^${seg(row)}\\|${seg(sport)}$`);
}

interface Matcher { rule: Rule; cell: RegExp | null }

function matches(m: Matcher, c: CaseResult, failing: ReadonlySet<string>): boolean {
  const { match } = m.rule;
  return (m.cell === null || m.cell.test(`${c.row}|${c.sport}`))
    && (match.scenario === undefined || c.scenario === match.scenario)
    && (match.layer === undefined || c.layer === match.layer)
    && (match.check === undefined || failing.has(match.check))
    && (match.reason === undefined || c.reason.includes(match.reason));
}

export function triage(runs: readonly TriageRun[], rules: TriageRules, routing: GapRouting, ledger: readonly { readonly id: string }[], newGaps: NewGaps): TriageResult {
  if (runs.length === 0) throw new TriageRefused("NoRun", "no run given — nothing to triage");
  const layers = new Map<Layer, string>();
  const owner = new Map<string, string>();
  let scanned = 0;
  for (const run of runs) {
    const first = layers.get(run.layer);
    if (first !== undefined) throw new TriageRefused("DuplicateLayer", `two runs of layer ${run.layer} (${first} and ${run.runId}) — the triage reads one run per layer`);
    layers.set(run.layer, run.runId);
    for (const c of run.cases) {
      if (c.layer !== run.layer) throw new TriageRefused("LayerMismatch", `case ${c.caseId} says layer ${c.layer} but sits in the ${run.layer} run ${run.runId}`);
      const at = owner.get(c.caseId);
      if (at !== undefined) throw new TriageRefused("DuplicateCase", `case ${c.caseId} is in two runs (${at} and ${run.runId}) — a case id names one case`);
      owner.set(c.caseId, run.runId);
      scanned++;
    }
  }
  if (scanned === 0) throw new TriageRefused("NoCases", "the runs hold no case at all — nothing to triage (vacuous)");
  // N1: `scanned` is the sum over the layers, so a layer that read nothing hides behind its neighbours' cases. Each layer given
  // holds a case; the first that does not is named, so a triage of "three layers" never reads two.
  for (const run of runs) {
    if (run.cases.length === 0) throw new TriageRefused("EmptyLayer", `the ${run.layer} run ${run.runId} holds no case — a layer that read nothing is no triage of it (vacuous)`);
  }

  // The rules, judged against the routing whether or not a red matched them.
  const known = new Set(ledger.map((g) => g.id));
  const newWave = new Map(newGaps.gaps.map((g) => [g.id, g.wave]));
  const misrouted: Misrouted[] = [];
  const unknownGap: UnknownGap[] = [];
  for (const r of rules.rules) {
    const isNew = NEW_GAP_ID.test(r.gap);
    if (isNew ? !newWave.has(r.gap) : !known.has(r.gap)) { unknownGap.push({ rule: r.id, gap: r.gap }); continue; }
    const routed = isNew ? (newWave.get(r.gap) ?? null) : routeOf(routing, r.gap);
    if (routed !== r.wave) misrouted.push({ rule: r.id, gap: r.gap, wave: r.wave, routed });
  }

  const matchers: Matcher[] = rules.rules.map((rule) => ({ rule, cell: rule.match.cell === undefined ? null : globToRegExp(rule.match.cell) }));
  const rows: TriageRow[] = [];
  const untriaged: string[] = [];
  const ambiguous: Ambiguous[] = [];
  const works: string[] = [];
  let checked = 0;
  for (const run of runs) {
    for (const c of run.cases) {
      if (c.state === "works") works.push(c.caseId);
      if (c.state !== "red") continue;
      checked++;
      const failing = new Set(c.checks.filter((k) => k.verdict === "fail").map((k) => k.id));
      const hit = matchers.filter((m) => matches(m, c, failing));
      if (hit.length === 0) untriaged.push(c.caseId);
      else if (hit.length > 1) ambiguous.push({ caseId: c.caseId, rules: hit.map((m) => m.rule.id) });
      else {
        const r = hit[0].rule;
        rows.push({ caseId: c.caseId, layer: run.layer, gap: r.gap, wave: r.wave, rule: r.id, ...(r.was === undefined ? {} : { was: r.was }) });
      }
    }
  }
  return { rows, untriaged, ambiguous, misrouted, unknownGap, checked, scanned, works, seen: new Set(owner.keys()) };
}

/** Every red keyed, no rule misrouted, none naming an unknown gap. */
export function isClean(r: { readonly untriaged: readonly unknown[]; readonly ambiguous: readonly unknown[]; readonly misrouted: readonly unknown[]; readonly unknownGap: readonly unknown[] }): boolean {
  return r.untriaged.length === 0 && r.ambiguous.length === 0 && r.misrouted.length === 0 && r.unknownGap.length === 0;
}

// --- triage.json ------------------------------------------------------------------------------------------------------------

const TriageJsonSchema = z.strictObject({
  version: z.literal(1),
  runs: z.array(z.strictObject({ layer: z.enum(LAYERS), runId: z.string().min(1), plan: z.string().nullable(), cases: z.number().int().nonnegative(), reds: z.number().int().nonnegative() })),
  scanned: z.number().int().nonnegative(),
  checked: z.number().int().nonnegative(),
  rows: z.array(z.strictObject({ caseId: z.string().min(1), layer: z.enum(LAYERS), gap: z.string().regex(GAP_ID), wave: WAVE, rule: z.string().min(1), was: z.string().min(1).optional() })),
  untriaged: z.array(z.string().min(1)),
  ambiguous: z.array(z.strictObject({ caseId: z.string().min(1), rules: z.array(z.string().min(1)).min(2) })),
  misrouted: z.array(z.strictObject({ rule: z.string().min(1), gap: z.string().min(1), wave: WAVE, routed: WAVE.nullable() })),
  unknownGap: z.array(z.strictObject({ rule: z.string().min(1), gap: z.string().min(1) })),
  /** The case ids that passed: the ledger's evidence for "exercised, not reproduced". */
  works: z.array(z.string().min(1)),
  /** The rows grouped by gap (Task 22 writes the per-wave backlog tables from this, never by hand). */
  gaps: z.array(z.strictObject({ gap: z.string().regex(GAP_ID), wave: WAVE, title: z.string(), layers: z.array(z.enum(LAYERS)).min(1), caseIds: z.array(z.string().min(1)).min(1) })),
});
export type TriageJson = z.infer<typeof TriageJsonSchema>;
export const parseTriage = (json: unknown): TriageJson => TriageJsonSchema.parse(json);

/** `W<n>` as a number, so W10 sorts after W9. */
const waveNo = (w: string): number => Number(/^W(\d+)/.exec(w)?.[1] ?? 0);

export function triageJson(r: TriageResult, runs: readonly TriageRun[], titles: ReadonlyMap<string, string>): TriageJson {
  const byGap = new Map<string, TriageRow[]>();
  for (const row of r.rows) byGap.set(row.gap, [...(byGap.get(row.gap) ?? []), row]);
  const gaps = [...byGap].map(([gap, rows]) => ({
    gap, wave: rows[0].wave, title: titles.get(gap) ?? "",
    layers: LAYERS.filter((l) => rows.some((x) => x.layer === l)), caseIds: rows.map((x) => x.caseId),
  })).sort((a, b) => waveNo(a.wave) - waveNo(b.wave) || (a.gap < b.gap ? -1 : a.gap > b.gap ? 1 : 0));
  return {
    version: 1,
    runs: runs.map((run) => ({ layer: run.layer, runId: run.runId, plan: run.plan ?? null, cases: run.cases.length, reds: run.cases.filter((c) => c.state === "red").length })),
    scanned: r.scanned, checked: r.checked, rows: r.rows, untriaged: r.untriaged, ambiguous: r.ambiguous, misrouted: r.misrouted, unknownGap: r.unknownGap, works: r.works, gaps,
  };
}

// --- rekey ---------------------------------------------------------------------------------------------------------------------

export interface RekeyRow {
  caseId: string;
  /** W1-driving's own key for it: P1..P7. */
  was: string;
  /** The gap the new triage gave it; null when it has none (see `why`). */
  now: string | null;
  why?: "not-red" | "untriaged" | "ambiguous" | "not-in-baseline";
  /** The rule that keyed it and the P-rule that rule says it re-keys, when the rule says one: `was` is checked against it. */
  rule?: string;
  ruleWas?: string;
}

/** Each case the P-rule map keys, with the gap the new triage gave it. A case with no gap says why: it is not red in the
 *  baseline, it is red and untriaged or ambiguous, or the baseline does not hold it at all. */
export function rekey(
  w1drv: { readonly cases: readonly { readonly caseId: string; readonly state: CaseState }[] },
  pMap: Readonly<Record<string, string>>,
  result: Pick<TriageResult, "rows" | "untriaged" | "ambiguous" | "seen">,
): RekeyRow[] {
  const keys = Object.keys(pMap).sort();
  if (keys.length === 0) throw new TriageRefused("RekeyMapEmpty", "the P-rule map maps no case — nothing to re-key (vacuous)");
  const have = new Set(w1drv.cases.map((c) => c.caseId));
  for (const k of keys) {
    if (!have.has(k)) throw new TriageRefused("RekeyUnknownCase", `${k} is not a case of the keyed results — a stale or mistyped map`);
  }
  const rowOf = new Map(result.rows.map((x) => [x.caseId, x]));
  const untriaged = new Set(result.untriaged);
  const ambiguous = new Set(result.ambiguous.map((x) => x.caseId));
  return keys.map((caseId): RekeyRow => {
    const was = pMap[caseId];
    const keyed = rowOf.get(caseId);
    if (keyed !== undefined) return { caseId, was, now: keyed.gap, ...(keyed.was === undefined ? {} : { rule: keyed.rule, ruleWas: keyed.was }) };
    const why = untriaged.has(caseId) ? "untriaged" : ambiguous.has(caseId) ? "ambiguous" : result.seen.has(caseId) ? "not-red" : "not-in-baseline";
    return { caseId, was, now: null, why };
  });
}

/** The rows whose keying rule says it re-keys a P-rule: the rule's `was` is checked against the map. A rule with no `was`, and a
 *  case with no gap, have nothing to check. */
export const wasChecked = (rows: readonly RekeyRow[]): number => rows.filter((x) => x.ruleWas !== undefined).length;

/** Those whose rule's `was` is not the P-rule the map gives the case: one of the two is wrong, and the link is free text. */
export const wasConflicts = (rows: readonly RekeyRow[]): RekeyRow[] => rows.filter((x) => x.ruleWas !== undefined && x.ruleWas !== x.was);

/** W1-driving's reds that the map does not key: a gap in the map is seen, not assumed away. */
export function unkeyedReds(w1drv: { readonly cases: readonly { readonly caseId: string; readonly state: CaseState }[] }, pMap: Readonly<Record<string, string>>): string[] {
  return w1drv.cases.filter((c) => c.state === "red" && !Object.hasOwn(pMap, c.caseId)).map((c) => c.caseId);
}

// --- the pages --------------------------------------------------------------------------------------------------------------------

/** A table cell: GFM splits on `|` even inside a code span, and a newline ends the row. */
const cell = (s: string): string => s.replace(/\r?\n/g, " ").replace(/\|/g, "\\|");
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** The problems of a triage, one line each (TRIAGE.md's "Problems" and stdout say them in these words). */
export function problemLines(r: Pick<TriageResult, "untriaged" | "ambiguous" | "misrouted" | "unknownGap">): string[] {
  return [
    ...r.untriaged.map((id) => `untriaged: \`${id}\``),
    ...r.ambiguous.map((a) => `ambiguous: \`${a.caseId}\` matches ${a.rules.join(", ")}`),
    ...r.misrouted.map((m) => `misrouted: ${m.rule} routes ${m.gap} to ${m.wave}, design §8 ${m.routed === null ? "gives it no route" : `says ${m.routed}`}`),
    ...r.unknownGap.map((u) => `unknown gap: ${u.rule} names ${u.gap}, which is in neither the audit ledger nor new-gaps.json`),
  ];
}

/** TRIAGE.md: per wave (numerically), per gap, the case list. */
export function renderTriage(r: TriageResult, titles: ReadonlyMap<string, string>): string {
  const clean = isClean(r);
  const lines: string[] = [`# Triage — ${plural(r.checked, "red")} of ${plural(r.scanned, "case")} (ruling 63)`, ""];
  if (!clean) {
    lines.push(`**NOT CLEAN — ${r.untriaged.length} untriaged, ${r.ambiguous.length} ambiguous, ${r.misrouted.length} misrouted rule(s), ${r.unknownGap.length} rule(s) naming an unknown gap. Fix the rules and re-run: this page is a partial triage.**`, "");
    lines.push("## Problems", "", ...problemLines(r).map((l) => `- ${l}`), "");
  }
  const waves = [...new Set(r.rows.map((x) => x.wave))].sort((a, b) => waveNo(a) - waveNo(b) || (a < b ? -1 : 1));
  lines.push("| wave | gaps | reds |", "|---|---|---|");
  for (const w of waves) {
    const rows = r.rows.filter((x) => x.wave === w);
    lines.push(`| ${w} | ${new Set(rows.map((x) => x.gap)).size} | ${rows.length} |`);
  }
  lines.push("");
  for (const w of waves) {
    const rows = r.rows.filter((x) => x.wave === w);
    const gaps = [...new Set(rows.map((x) => x.gap))].sort();
    lines.push(`## ${w} — ${plural(rows.length, "red")} in ${plural(gaps.length, "gap")}`, "");
    for (const g of gaps) {
      const own = rows.filter((x) => x.gap === g);
      const title = titles.get(g);
      lines.push(`### ${g}${title === undefined || title === "" ? "" : ` — ${title}`}`, "", `${plural(own.length, "case")}; layers ${LAYERS.filter((l) => own.some((x) => x.layer === l)).join(", ")}`, "");
      for (const x of own) lines.push(`- \`${x.caseId}\` (${x.rule}${x.was === undefined ? "" : `, was ${x.was}`})`);
      lines.push("");
    }
  }
  return `${lines.join("\n")}\n`;
}

const WHY: Readonly<Record<NonNullable<RekeyRow["why"]>, string>> = {
  "not-red": "not red in the baseline",
  untriaged: "red in the baseline, untriaged",
  ambiguous: "red in the baseline, ambiguous",
  "not-in-baseline": "not in the baseline",
};

/** REKEY.md: a count per (P-rule, new gap), then every case, then the reds the map does not key. */
export function renderRekey(rows: readonly RekeyRow[], result: Pick<TriageResult, "rows">, unkeyed: readonly string[]): string {
  const waveOf = new Map(result.rows.map((x) => [x.caseId, x.wave]));
  const label = (x: RekeyRow): string => (x.now ?? WHY[x.why ?? "not-red"]);
  const wave = (x: RekeyRow): string => (x.now === null ? "—" : (waveOf.get(x.caseId) ?? "—"));
  const keyed = rows.filter((x) => x.now !== null).length;
  const lines: string[] = [
    "# Re-keying the P-rule reds (ruling 63)", "",
    `${plural(rows.length, "mapped case")} keyed by a P-rule: ${keyed} now carry a gap, ${rows.length - keyed} do not.`,
    `The \`was\` of each rule that keyed a case was checked against the map on ${plural(wasChecked(rows), "case")}: ${wasConflicts(rows).length} disagree.`, "",
    ...(wasConflicts(rows).length === 0 ? [] : [
      "## Rules whose `was` disagrees with the map", "",
      ...wasConflicts(rows).map((x) => `- \`${x.caseId}\`: the map says ${x.was}, rule ${x.rule} says ${x.ruleWas}`), "",
    ]),
    "## By P-rule and gap", "", "| P-rule | now | wave | cases |", "|---|---|---|---|",
  ];
  const groups = new Map<string, { was: string; label: string; wave: string; n: number }>();
  for (const x of rows) {
    const k = `${x.was}\u0000${label(x)}\u0000${wave(x)}`;
    const g = groups.get(k) ?? { was: x.was, label: label(x), wave: wave(x), n: 0 };
    g.n++;
    groups.set(k, g);
  }
  for (const g of [...groups.values()].sort((a, b) => (a.was < b.was ? -1 : a.was > b.was ? 1 : a.label < b.label ? -1 : a.label > b.label ? 1 : 0))) lines.push(`| ${cell(g.was)} | ${cell(g.label)} | ${g.wave} | ${g.n} |`);
  lines.push("", "## Every case", "", "| case | P-rule | now | wave |", "|---|---|---|---|");
  for (const x of rows) lines.push(`| \`${cell(x.caseId)}\` | ${cell(x.was)} | ${cell(label(x))} | ${wave(x)} |`);
  lines.push("", "## Reds the map does not key", "", `Reds the map does not key: ${unkeyed.length}`, "");
  for (const id of unkeyed) lines.push(`- \`${id}\``);
  return `${lines.join("\n")}\n`;
}
