// W1c Task 13: parity — the HTTP and the browser verdicts compared per case.
// Ruling 37 gives both drivers one verdict pipeline, so parity is a diff of
// two results.json files.
//
// Pairing (controller ruling a). A browser case id is `<case id>@<width>`
// (layers.ts atWidth). The case's own width is stripped. An L2 case also names
// its ATOM in the scenario segment (swiss|badminton|bwf|R4a) where the HTTP run
// names the SCRIPT (…|R4), so the atom is mapped through the catalogue's own
// declaration, HARNESS_SCENARIO. A browser case whose scenario is neither an
// atom that HARNESS_SCENARIO maps nor a script it maps to cannot pair (an L2
// 🚫/░ atom, PADPROOF). It is a `missing` row, never dropped. Every browser
// width of one HTTP case is compared on its own.
//
// Per pair, the state is compared, then every check both sides ran, by verdict
// AND checked: a run that checked fewer items is not the same verdict. A check
// that one side ran and the other did not is a row, with one exception: a
// browser-only check (BROWSER_ONLY_PREFIXES) in the browser run is ignored. The
// HTTP driver never emits one, so a browser-only check in the HTTP run is
// itself a row: that run was mislabeled.
//
// The layer is never compared (ruling b). Ruling 39 labels a run by its width,
// and the committed walkthrough-a 320 legs, written before Task 12's fix, say
// L1 at 320.
//
// Finalize (controller ruling D) is compared by its recorded outcome — the
// state and the scenario's own checks — never by its route.
// `finalize-ledger-row` is the browser driver's proof that the console's
// Finalize left one core.finalize row. No HTTP case has one to compare, so it
// is browser-only.
import { HARNESS_SCENARIO } from "./scenario-catalogue.ts";
import type { AnyRunResults, CaseResult, CaseResultV2, CheckResult, DriverKind } from "./results.ts";

/** Check ids only the browser driver emits (lib/driver/browser-driver.ts,
 *  mixed.ts, lib/browser/evidence.ts, the PADPROOF scenario). A prefix, or a
 *  whole id. parity.test.ts proves each one covers an id the driver emits, and
 *  that every browser-only id the committed browser runs record is covered. */
export const BROWSER_ONLY_PREFIXES = ["ui-", "visual-", "no-horizontal-scroll", "mixed-", "builder-", "organiser-ui-path", "pad-", "finalize-ledger-row"] as const;
export const isBrowserOnly = (id: string): boolean => BROWSER_ONLY_PREFIXES.some((p) => id.startsWith(p));

export interface ParityRow { caseId: string; kind: "state" | "check" | "missing"; id: string | null; http: string; browser: string }
export interface ParityReport { compared: number; checks: number; diffs: ParityRow[] }

/** What a row says for the side that has no such case or check. */
export const ABSENT = "absent";

/** The http slot holds a browser run, or the browser slot an HTTP one (a v2 run
 *  predates the browser, so it is an HTTP run). */
export class WrongDriver extends Error {
  readonly slot: DriverKind;
  readonly got: DriverKind;
  constructor(slot: DriverKind, got: DriverKind) {
    super(`parity: the ${slot === "http" ? "first file must be the http run" : "second file must be the browser run"}, and it is a ${got} run`);
    this.name = "WrongDriver";
    this.slot = slot;
    this.got = got;
  }
}

/** A case id or a check id twice in one run: keyed by id, one of them would be
 *  dropped without a word. */
export class DuplicateId extends Error {
  readonly id: string;
  constructor(what: string, id: string) {
    super(`parity: ${what} '${id}' appears twice — the input cannot be compared`);
    this.name = "DuplicateId";
    this.id = id;
  }
}

/** A browser case whose id does not end in its own `@<width>`: its HTTP key
 *  cannot be read from it. */
export class WidthSuffixMismatch extends Error {
  readonly caseId: string;
  constructor(caseId: string, width: number) {
    super(`parity: case '${caseId}' was run at ${width}, and its id does not end in '@${width}' — the input cannot be compared`);
    this.name = "WidthSuffixMismatch";
    this.caseId = caseId;
  }
}

type AnyCase = CaseResultV2 | CaseResult;
const driverOf = (r: AnyRunResults): DriverKind => (r.schemaVersion === 2 ? "http" : r.driver);
const widthOf = (c: AnyCase): number | null => ("width" in c ? c.width : null);

function refuseSlot(slot: DriverKind, r: AnyRunResults): void {
  const got = driverOf(r);
  if (got !== slot) throw new WrongDriver(slot, got);
}

function byId<T>(items: readonly T[], idOf: (t: T) => string, what: string): Map<string, T> {
  const out = new Map<string, T>();
  for (const t of items) {
    const id = idOf(t);
    if (out.has(id)) throw new DuplicateId(what, id);
    out.set(id, t);
  }
  return out;
}

/** `row|sport|variant|scenario[|…]`: slice.ts caseId and layers.ts l2CaseId. */
const SCENARIO_SEGMENT = 3;
const SCRIPTS: ReadonlySet<string> = new Set(Object.values(HARNESS_SCENARIO));

/** The HTTP case id a browser case pairs with, or why it has none. */
export function httpKeyOf(c: AnyCase): { key: string } | { unmapped: string } {
  const width = widthOf(c);
  const suffix = width === null ? "" : `@${width}`;
  if (width !== null && !c.caseId.endsWith(suffix)) throw new WidthSuffixMismatch(c.caseId, width);
  const segments = c.caseId.slice(0, c.caseId.length - suffix.length).split("|");
  const scenario = segments[SCENARIO_SEGMENT];
  if (scenario === undefined) return { unmapped: "no scenario segment in the case id, so no harness script" };
  if (Object.hasOwn(HARNESS_SCENARIO, scenario)) segments[SCENARIO_SEGMENT] = HARNESS_SCENARIO[scenario]!;
  else if (!SCRIPTS.has(scenario)) return { unmapped: `scenario '${scenario}' maps to no harness script (HARNESS_SCENARIO)` };
  return { key: segments.join("|") };
}

const fmt = (c: CheckResult): string => `${c.verdict}/${c.checked}`;

/** The checks of one pair: rows into `diffs`, and the number of common checks. */
function compareChecks(caseId: string, h: AnyCase, b: AnyCase, diffs: ParityRow[]): number {
  const hc = byId(h.checks, (c) => c.id, `check of http case ${h.caseId}`);
  const bc = byId(b.checks, (c) => c.id, `check of browser case ${b.caseId}`);
  let common = 0;
  for (const c of h.checks) {
    const other = bc.get(c.id);
    if (isBrowserOnly(c.id)) {
      diffs.push({ caseId, kind: "check", id: c.id, http: `${fmt(c)} — a browser-only check in the http run (mislabeled)`, browser: other === undefined ? ABSENT : fmt(other) });
      continue;
    }
    if (other === undefined) {
      diffs.push({ caseId, kind: "check", id: c.id, http: fmt(c), browser: ABSENT });
      continue;
    }
    common++;
    if (c.verdict !== other.verdict || c.checked !== other.checked) diffs.push({ caseId, kind: "check", id: c.id, http: fmt(c), browser: fmt(other) });
  }
  for (const c of b.checks) {
    if (!hc.has(c.id) && !isBrowserOnly(c.id)) diffs.push({ caseId, kind: "check", id: c.id, http: ABSENT, browser: fmt(c) });
  }
  return common;
}

/** Every browser case against the HTTP case it pairs with; then every HTTP
 *  case no browser case paired with. Rows are in that order. */
export function compareRuns(http: AnyRunResults, browser: AnyRunResults): ParityReport {
  refuseSlot("http", http);
  refuseSlot("browser", browser);
  const httpCases = byId<AnyCase>(http.cases, (c) => c.caseId, "http case");
  byId<AnyCase>(browser.cases, (c) => c.caseId, "browser case");
  const paired = new Set<string>();
  const diffs: ParityRow[] = [];
  let compared = 0;
  let checks = 0;
  for (const b of browser.cases) {
    const key = httpKeyOf(b);
    if ("unmapped" in key) {
      diffs.push({ caseId: b.caseId, kind: "missing", id: null, http: ABSENT, browser: `${b.state} — ${key.unmapped}` });
      continue;
    }
    const h = httpCases.get(key.key);
    if (h === undefined) {
      diffs.push({ caseId: b.caseId, kind: "missing", id: null, http: ABSENT, browser: b.state });
      continue;
    }
    paired.add(h.caseId);
    compared++;
    if (h.state !== b.state) diffs.push({ caseId: b.caseId, kind: "state", id: null, http: h.state, browser: b.state });
    checks += compareChecks(b.caseId, h, b, diffs);
  }
  for (const h of http.cases) {
    if (!paired.has(h.caseId)) diffs.push({ caseId: h.caseId, kind: "missing", id: null, http: h.state, browser: ABSENT });
  }
  return { compared, checks, diffs };
}

/** 0 only for ≥1 case compared, ≥1 common check and no row. Nothing compared
 *  is never parity (R13, R25): an empty pair of runs has no difference. */
export function parityVerdict(r: ParityReport): { code: 0 | 1; line: string } {
  if (r.compared === 0) return { code: 1, line: "NOT PARITY: compared 0 cases — the two runs share no case, and nothing compared is never parity" };
  if (r.checks === 0) return { code: 1, line: "NOT PARITY: 0 common checks — the compared cases share no check (vacuous)" };
  if (r.diffs.length > 0) return { code: 1, line: `NOT PARITY: ${r.diffs.length} difference(s)` };
  return { code: 0, line: "PARITY" };
}

export const headerLine = (r: ParityReport): string => `compared ${r.compared} cases, ${r.checks} common checks, ${r.diffs.length} differences`;

/** A table cell: a case id's pipes escaped, and never a line break. */
const cell = (s: string): string => s.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");

const SECTIONS: readonly { kind: ParityRow["kind"]; heading: string; head: readonly string[]; row: (d: ParityRow) => readonly string[] }[] = [
  { kind: "state", heading: "State differences", head: ["case", "http", "browser"], row: (d) => [d.caseId, d.http, d.browser] },
  { kind: "check", heading: "Check differences", head: ["case", "check", "http", "browser"], row: (d) => [d.caseId, d.id ?? "", d.http, d.browser] },
  { kind: "missing", heading: "Missing cases", head: ["case", "http", "browser"], row: (d) => [d.caseId, d.http, d.browser] },
];
const line = (cells: readonly string[]): string => `| ${cells.map(cell).join(" | ")} |`;

/** parity.md: the header line, the verdict, then one section per diff kind. */
export function renderParity(r: ParityReport, runs: { http: string; browser: string }): string {
  const out = [
    `# Parity: ${cell(runs.http)} (http) vs ${cell(runs.browser)} (browser)`,
    "",
    headerLine(r),
    "",
    `**Verdict:** ${parityVerdict(r).line}`,
    "",
    `Browser-only checks (ignored in the browser run; a difference in the http run): ${BROWSER_ONLY_PREFIXES.map((p) => `\`${p}\``).join(", ")}.`,
  ];
  for (const s of SECTIONS) {
    const rows = r.diffs.filter((d) => d.kind === s.kind);
    out.push("", `## ${s.heading} (${rows.length})`, "");
    if (rows.length === 0) out.push("None.");
    else out.push(line(s.head), line(s.head.map(() => "---")), ...rows.map((d) => line(s.row(d))));
  }
  return `${out.join("\n")}\n`;
}
