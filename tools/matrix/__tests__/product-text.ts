// Product rules the model's fake and its pins READ from the product's source
// instead of typing them (Task 13 fix round 1, ruling C-1): a product change
// moves the fake with it, and turns the model's pin red.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type * as TS from "typescript";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (p: string) => readFileSync(resolve(REPO, p), "utf8");

/** T8-R5 (I-R1), pure: the entrant_members primary key's name and the unique
 *  violation a second (entrant, person) member row raises, as Postgres words
 *  it. V213 declares the key with no `constraint <name>`, so Postgres names it
 *  `<table>_pkey` (within NAMEDATALEN − 1 = 63 bytes). Refused by name when
 *  V213's key is not that unnamed clause, or when any OTHER migration alters a
 *  constraint on the table, or mentions the derived name (an index rename) —
 *  the derived name would then not be the live one. `scanned` counts the other
 *  migrations read; none is refused (anti-vacuity). */
export function entrantMembersPkeyFrom(v213: string, others: readonly { path: string; text: string }[]): { name: string; violation: string; scanned: number } {
  const table = /create table if not exists (\w+) \(([\s\S]*?)\n\);/.exec(v213);
  if (table === null) throw new Error("product-text: V213 has no create table in the expected shape");
  const [, name0, body] = table;
  if (!/\n {2}primary key \(entrant_id, person_id\)\n$/.test(`${body}\n`) || /\bconstraint\s+\w+\s+primary\s+key\b/i.test(body)) throw new Error(`product-text: V213's ${name0} primary key is not the unnamed (entrant_id, person_id) clause`);
  const name = `${name0}_pkey`;
  if (name.length > 63) throw new Error(`product-text: ${name} exceeds 63 bytes — Postgres would truncate it`);
  if (others.length === 0) throw new Error(`product-text: no migration besides V213 was scanned for ${name0} constraint changes`);
  const alters = new RegExp(`alter\\s+table\\s+(?:if\\s+exists\\s+)?(?:only\\s+)?(?:public\\.)?${name0}\\b[^;]*`, "gi");
  for (const { path, text } of others) {
    const touched = [...text.matchAll(alters)].some(([stmt]) => /\b(?:constraint|primary\s+key|rename)\b/i.test(stmt)) || text.includes(name);
    if (touched) throw new Error(`product-text: ${path} changes ${name0}' constraints — the default ${name} may not be the live key name`);
  }
  return { name, violation: `duplicate key value violates unique constraint "${name}"`, scanned: others.length };
}

/** T8-R5 (I-R1): entrantMembersPkeyFrom over the repo's own migrations. */
export function entrantMembersPkeyText(): { name: string; violation: string; scanned: number } {
  const V213 = "db/migration/v2-engine/tables/V213__entrant_members.sql";
  const others = readdirSync(resolve(REPO, "db/migration"), { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".sql") && !f.endsWith("V213__entrant_members.sql"))
    .map((f) => ({ path: f, text: read(`db/migration/${f}`) }));
  return entrantMembersPkeyFrom(read(V213), others);
}

/** api-v1 http.ts statusCode(): the code an HttpError that carries none of its
 *  own reaches the wire with. */
export function wireCodeFor(status: number): string {
  const body = /\nfunction statusCode\(status: number\): string \{\n([\s\S]*?)\n\}\n/.exec(read("apps/web/src/server/api-v1/http.ts"))?.[1];
  if (body === undefined) throw new Error("product-text: http.ts statusCode() not found");
  for (const [, s, c] of body.matchAll(/case (\d{3}): return "([A-Z_]+)";/g)) if (Number(s) === status) return c;
  const fallback = /default: return status >= 500 \? "([A-Z_]+)" : "([A-Z_]+)";/.exec(body);
  if (fallback === null) throw new Error("product-text: http.ts statusCode() has no default arm in the expected shape");
  return status >= 500 ? fallback[1] : fallback[2];
}

export interface RosterLockText {
  /** divisions.status values that lock the roster. */
  statuses: string[];
  /** Stage kinds that keep a started roster open. */
  openKinds: string[];
  status: number;
  /** The HttpError's own code, or null (none: the wire carries wireCode). */
  code: string | null;
  /** What a client reads: the code, or http.ts's generic one for the status. */
  wireCode: string;
  message: string;
}

/** entrants.ts createEntrants: a started tournament's entrant list is locked
 *  unless one of its stages is an open-window format. */
export function rosterLockText(): RosterLockText {
  const src = read("apps/web/src/server/usecases/entrants.ts");
  const m = /\n\s*if \(((?:division\.status === "[a-z_]+"(?: \|\| )?)+)\) \{\s*const \[openFormat\] = await tx`[\s\S]*?kind in \(([^)]*)\)[\s\S]*?if \(!openFormat\) \{\s*throw new HttpError\(\s*(\d{3}),\s*"([^"]*)",?\s*(?:("[A-Z_]+"|[A-Za-z_]\w*),?\s*)?\);/.exec(src);
  if (m === null) throw new Error("product-text: entrants.ts roster lock not found in the expected shape — re-read it and update the model's ROSTER_LOCK");
  const statuses = [...m[1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]);
  const openKinds = [...m[2].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
  const status = Number(m[3]);
  const arg = m[5];
  let code: string | null = null;
  if (arg !== undefined) {
    if (arg.startsWith("\"")) code = arg.slice(1, -1);
    else {
      const def = new RegExp(`\\bconst ${arg} = "([A-Z_]+)"`).exec(src);
      if (def === null) throw new Error(`product-text: the roster lock's code ${arg} is not a string constant in entrants.ts — resolve it`);
      code = def[1];
    }
  }
  return { statuses, openKinds, status, code, wireCode: code ?? wireCodeFor(status), message: m[4] };
}

/** schedule.ts roundRobinStageIds: the stage kinds the product generates as a
 *  round robin — the ones #879's positional reconcile can duplicate. */
export function roundRobinKindsText(): string[] {
  const m = /export async function roundRobinStageIds\([\s\S]*?kind in \(([^)]*)\)/.exec(read("apps/web/src/server/usecases/schedule.ts"));
  if (m === null) throw new Error("product-text: schedule.ts roundRobinStageIds not found");
  return [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
}

/** withdrawal.ts REASON: the reason every cascade event carries. */
export function withdrawalReason(): string {
  const r = /\nconst REASON = "([^"]+)";/.exec(read("apps/web/src/server/usecases/withdrawal.ts"));
  if (r === null) throw new Error("product-text: withdrawal.ts REASON not found");
  return r[1];
}

/** lib/table-withdrawal.ts WITHDRAWAL_PENDING_STATUSES: the fixtures a
 *  withdrawal's cascade still acts on. */
export function withdrawalPendingText(): string[] {
  const m = /\nexport const WITHDRAWAL_PENDING_STATUSES: ReadonlySet<string> = new Set\(\[([^\]]*)\]\);/.exec(read("apps/web/src/lib/table-withdrawal.ts"));
  if (m === null) throw new Error("product-text: table-withdrawal.ts WITHDRAWAL_PENDING_STATUSES not found in the expected shape");
  const out = [...m[1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]);
  if (out.length === 0) throw new Error("product-text: table-withdrawal.ts WITHDRAWAL_PENDING_STATUSES names no status");
  return out;
}

/** usecases/fixture-results-sql.ts fixtureHasResultSql's status clause, pure: the statuses a rebuild (and history) treat as
 *  PLAYED. Refused by name when the clause is not in the expected shape or names no status. */
export function fixtureResultStatusesFrom(text: string): string[] {
  const m = /\$\{f\}\.status in \(([^)]*)\)\s*or \(\$\{f\}\.status = 'abandoned'/.exec(text);
  if (m === null) throw new Error("product-text: fixture-results-sql.ts fixtureHasResultSql has no status clause in the expected shape");
  const out = [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
  if (out.length === 0) throw new Error("product-text: fixture-results-sql.ts fixtureHasResultSql's status clause names no status");
  return out;
}

/** fixtureResultStatusesFrom over the repo's own file. */
export function fixtureResultStatusesText(): string[] {
  return fixtureResultStatusesFrom(read("apps/web/src/server/usecases/fixture-results-sql.ts"));
}

/** The fixture-status enum of api-v1's fixture schema, pure. Two shapes, both the product's: the status list declared once
 *  (`FIXTURE_STATUSES` in lib/fixture-status.ts, loop F Task 7) with the schema reading it by name, or - before that - the
 *  list inline in the schema's `status: z.enum([...])` beside "forfeited". Refused by name when a declaration exists but
 *  the schema does not read it, or when no shape is found. */
export function fixtureStatusesFrom(schemas: string, declaration: string | null): string[] {
  if (declaration !== null) {
    if (!/\n {2}status: z\.enum\(FIXTURE_STATUSES\),/.test(schemas)) throw new Error("product-text: lib/fixture-status.ts declares FIXTURE_STATUSES but api-v1 schemas.ts does not read it as the fixture status enum");
    const d = /export const FIXTURE_STATUSES = \[([^\]]*)\] as const;/.exec(declaration);
    if (d === null) throw new Error("product-text: lib/fixture-status.ts FIXTURE_STATUSES not found in the expected shape");
    const names = [...d[1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]);
    if (names.length === 0 || names.length !== d[1].split(",").filter((x) => x.trim() !== "").length) throw new Error("product-text: lib/fixture-status.ts FIXTURE_STATUSES has an entry this reader cannot read");
    return names;
  }
  const enums = [...schemas.matchAll(/status: z\.enum\(\[([^\]]*"forfeited"[^\]]*)\]\)/g)];
  if (enums.length !== 1) throw new Error(`product-text: api-v1 schemas.ts has ${enums.length} inline fixture status enums (exactly 1 expected)`);
  const names = [...enums[0][1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]);
  if (names.length !== enums[0][1].split(",").length) throw new Error("product-text: api-v1 schemas.ts fixture status enum has an entry this reader cannot read");
  return names;
}

/** fixtureStatusesFrom over the repo's own files. */
export function fixtureStatusesText(): string[] {
  const decl = resolve(REPO, "apps/web/src/lib/fixture-status.ts");
  return fixtureStatusesFrom(read("apps/web/src/server/api-v1/schemas.ts"), existsSync(decl) ? readFileSync(decl, "utf8") : null);
}

export interface NextMatchText {
  status: number;
  /** The HttpError's code, resolved through fed-seats.ts's import. */
  code: string;
  /** The one fixture status fed-seats.ts hasStarted reads as not started. */
  notStarted: string;
  /** fed-seats.ts isCascadeWalkover: the walkover the system awarded (this
   *  status, this outcome kind, no live event) is reset, never refused. */
  cascade: { status: string; outcomeKind: string };
  /** planRelease refuses only `!reset && hasStarted(t)`, `reset` being isCascadeWalkover(t). */
  resetExempt: boolean;
  /** append-event.ts calls releaseFedSeats at the top level of the append:
   *  every event, a void included, is judged. */
  everyAppend: boolean;
  /** next-match-started.ts nextMatchStartedMessage, for a label. */
  message: (label: string) => string;
  /** Where the refusal names the fed match on the wire (W1b carry c): the
   *  HttpError's extra `{ [key]: ref }`, whose `ref` is boardRef's over the fed
   *  node with `[idField]: t.id`, which api-v1 http.ts spreads into `error` —
   *  so `error[key][idField]` is the fed fixture's id. */
  wire: { key: string; idField: string };
}

/** fed-seats.ts planRelease (ruling RR-1): a write that takes back a knockout
 *  decision whose next match has started is refused by name. */
export function nextMatchStartedText(): NextMatchText {
  const fed = read("apps/web/src/server/engine-db/fed-seats.ts");
  const thrown = /\n\s*if \(!reset && hasStarted\(t\)\) \{\s*const ref = await boardRef\(tx, t\);\s*throw new HttpError\((\d{3}), nextMatchStartedMessage\([^;]*?\), ([A-Z_]+), \{ (\w+): ref \}\);/.exec(fed);
  if (thrown === null) throw new Error("product-text: fed-seats.ts NEXT_MATCH_STARTED refusal not found in the expected shape — re-read it and update the model's NEXT_MATCH_LOCK");
  // The fed match's id inside that ref: boardRef's own field over the node it is given.
  const idField = /\nasync function boardRef\(tx: Tx, t: Node\): Promise<NextMatchRef> \{[\s\S]*?\n\s*const ref: NextMatchRef = \{ (\w+): t\.id,/.exec(fed)?.[1];
  if (idField === undefined) throw new Error("product-text: fed-seats.ts boardRef no longer names the fed fixture's id as `<field>: t.id` — re-read it and update nextMatchFixtureId");
  // api-v1 http.ts: an HttpError's extra is spread into the envelope's `error`, beside code and message.
  const http = read("apps/web/src/server/api-v1/http.ts");
  const spreads = /\n\s*const body: ErrorBody = \{ ok: false, error: \{ code, message, \.\.\.extra \}, requestId \};/.test(http)
    && /\n\s*if \(err instanceof HttpError\) \{[\s\S]*?return errorResponse\(\s*requestId,\s*err\.status,\s*err\.code \?\? statusCode\(err\.status\),\s*err\.message,\s*err\.extra,(?:\s*err\.headers,?)?\s*\);/.test(http);
  if (!spreads) throw new Error("product-text: api-v1 http.ts no longer spreads an HttpError's extra into `error` — re-read it and update the driver's RefusedCall.extra");
  const from = new RegExp(`import \\{[^}]*\\b${thrown[2]}\\b[^}]*\\} from "@/([^"]+)";`).exec(fed);
  if (from === null) throw new Error(`product-text: fed-seats.ts does not import ${thrown[2]} from an @/ module — resolve it`);
  const lib = read(`apps/web/src/${from[1]}.ts`);
  const code = new RegExp(`\\bexport const ${thrown[2]} = "([A-Z_]+)";`).exec(lib)?.[1];
  if (code === undefined) throw new Error(`product-text: ${thrown[2]} is not a string constant in ${from[1]}.ts`);
  const started = /\nfunction hasStarted\(t: Node\): boolean \{\s*return t\.status !== "([a-z_]+)" \|\| t\.outcome !== null \|\| t\.live_events > 0;\s*\}/.exec(fed);
  if (started === null) throw new Error("product-text: fed-seats.ts hasStarted is not the three-term rule the model mirrors — re-read it");
  const cascade = /\nfunction isCascadeWalkover\(t: Node\): boolean \{\s*return t\.status === "([a-z_]+)" && \(t\.outcome as \{ kind\?: string \} \| null\)\?\.kind === "([a-z_]+)" && t\.live_events === 0;\s*\}/.exec(fed);
  if (cascade === null) throw new Error("product-text: fed-seats.ts isCascadeWalkover is not the three-term exemption the model mirrors — re-read it");
  const resetExempt = /\n\s*const reset = isCascadeWalkover\(t\);\s*if \(!reset && hasStarted\(t\)\) \{/.test(fed);
  const everyAppend = /\n {2}const \w+ = await releaseFedSeats\(tx, fixtureId, fixture\.outcome, outcome\);/.test(read("apps/web/src/server/engine-db/append-event.ts"));
  const template = /\nexport function nextMatchStartedMessage\(label: string\): string \{\s*return `([^`]*)`;\s*\}/.exec(lib)?.[1];
  if (template === undefined) throw new Error(`product-text: ${from[1]}.ts nextMatchStartedMessage not found`);
  return { status: Number(thrown[1]), code, notStarted: started[1], cascade: { status: cascade[1], outcomeKind: cascade[2] }, resetExempt, everyAppend, message: (label) => template.replace("${label}", label), wire: { key: thrown[3], idField } };
}

/** stages.ts bracketToGen: the round_no the product stores for an engine
 *  bracket fixture — its lane's offset (a multiple of the lane depth), plus
 *  the engine's 0-based round, plus one. */
export function bracketRoundNoText(): (lane: string | undefined, round: number, laneDepth: number) => number {
  const body = /\nfunction bracketToGen\(bracket: GeneratedBracket, laneDepth: number\): GenFixture\[\] \{([\s\S]*?)\n\}\n/.exec(read("apps/web/src/server/usecases/stages.ts"))?.[1];
  const offset = body === undefined ? null : /const laneOffset = \(f: BracketFixtureGen\): number =>\s*f\.bracket === "LB" \? laneDepth : f\.bracket === "GF" \? laneDepth \* (\d+) : 0;/.exec(body);
  if (body === undefined || offset === null || !body.includes("const roundNo = laneOffset(f) + f.round + 1;")) {
    throw new Error("product-text: stages.ts bracketToGen's round_no is not lane offset + round + 1 — re-read it and re-check the model's later-round rule");
  }
  const gf = Number(offset[1]);
  return (lane, round, laneDepth) => (lane === "LB" ? laneDepth : lane === "GF" ? laneDepth * gf : 0) + round + 1;
}

/** stages.ts: the two product facts I2's structural terminal keys rest on
 *  (W1-driving Task 9 m-1, scenarios/terminal-finals.ts). Every bracket row's
 *  ext_key is the engine fixture id (bracketToGen `extKey: f.id`), and
 *  generate() lays out page_playoff, double_elim and stepladder with the
 *  engine's own generator — double elim's reset read as `cfg.<key> === true`.
 *  Returns the kinds found and that config key; throws by name otherwise.
 *  `src` is stages.ts's text (a parameter so a test can feed a variant). */
export function structuralBracketFrom(src: string): { kinds: string[]; resetKey: string } {
  const body = /\nfunction bracketToGen\(bracket: GeneratedBracket, laneDepth: number\): GenFixture\[\] \{([\s\S]*?)\n\}\n/.exec(src)?.[1];
  if (body === undefined || !/\n\s*extKey: f\.id,\n/.test(body)) {
    throw new Error("product-text: stages.ts bracketToGen no longer stores the engine fixture id as ext_key — I2's terminal final keys would match no row");
  }
  const kinds: string[] = [];
  let resetKey: string | null = null;
  for (const [kind, gen] of [["page_playoff", "generatePagePlayoff"], ["double_elim", "generateDoubleElim"], ["stepladder", "generateStepladder"]] as const) {
    const m = new RegExp(`case "${kind}": \\{\\s*const bracket = ${gen}\\(\\{ entrants: ids, seeds(?:, bracketReset: cfg\\.(\\w+) === true)? \\}\\);\\s*return bracketToGen\\(bracket, bracket\\.rounds\\);`).exec(src);
    if (m === null) throw new Error(`product-text: stages.ts generate() no longer lays out ${kind} with ${gen} through bracketToGen — re-read it`);
    if (kind === "double_elim") {
      if (m[1] === undefined) throw new Error("product-text: stages.ts generate() no longer reads double elim's bracket reset from the stage config — re-read it");
      resetKey = m[1];
    }
    kinds.push(kind);
  }
  if (resetKey === null) throw new Error("product-text: no double_elim arm was read — the reset key is unknown");
  return { kinds, resetKey };
}
export const structuralBracketText = () => structuralBracketFrom(read("apps/web/src/server/usecases/stages.ts"));

/** The literal words of every `throw new X(…)` in a product source file: each
 *  string argument, and a template's literal pieces (its head and the text
 *  after each substitution, which splits them). A committed regression `match`
 *  is pinned to these, so it quotes what the product really throws (final
 *  batch FB-3). `typescript` loads through require, and only when called: vite's
 *  transform chokes on its CJS bundle, and the model's fake imports this file. */
export function thrownWords(path: string): string[] {
  const ts = createRequire(import.meta.url)("typescript") as typeof TS;
  const sf = ts.createSourceFile(path, read(path), ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  const visit = (n: TS.Node): void => {
    if (ts.isThrowStatement(n) && ts.isNewExpression(n.expression)) {
      for (const a of n.expression.arguments ?? []) {
        if (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a)) out.push(a.text);
        else if (ts.isTemplateExpression(a)) out.push(a.head.text, ...a.templateSpans.map((span) => span.literal.text));
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  if (out.length === 0) throw new Error(`product-text: ${path} throws no literal words — a vacuous pin`);
  return out;
}

/** A `new Set([...])` literal's string members, refused when empty. */
function setMembers(m: RegExpExecArray | null, what: string): string[] {
  if (m === null) throw new Error(`product-text: ${what} not found in the expected shape — re-read it`);
  const out = [...m[1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]);
  if (out.length === 0) throw new Error(`product-text: ${what} names no member`);
  return out;
}

/** withdrawal.ts TABLE_KINDS: the kinds the withdrawal module treats as a
 *  table (its OWN copy — engine-db/competition.ts's includes americano, this
 *  one does not). W1-driving T7, false premise 16. */
export function withdrawalTableKindsText(): string[] {
  return setMembers(/\nconst TABLE_KINDS = new Set\(\[([^\]]*)\]\);/.exec(read("apps/web/src/server/usecases/withdrawal.ts")), "withdrawal.ts TABLE_KINDS");
}

/** stages.ts BRACKET_WALKOVER_KINDS: the bracket kinds whose withdrawal
 *  forfeits each pending line to the opponent (W1-driving T7). */
export function bracketWalkoverKindsText(): string[] {
  return setMembers(/\nexport const BRACKET_WALKOVER_KINDS: ReadonlySet<string> = new Set\(\[([\s\S]*?)\]\);/.exec(read("apps/web/src/server/usecases/stages.ts")), "stages.ts BRACKET_WALKOVER_KINDS");
}

/** stages.ts departedEntrantIds: the entrant statuses that have LEFT the
 *  field — a challenge naming one is LADDER_ENTRANT_WITHDRAWN, and the live
 *  ladder is the raw order without them (W1-driving T7). */
export function departedStatusesText(): string[] {
  const m = /\nasync function departedEntrantIds\(tx: Tx, divisionId: string\): Promise<Set<string>> \{[\s\S]*?status in \(([^)]*)\)/.exec(read("apps/web/src/server/usecases/stages.ts"));
  if (m === null) throw new Error("product-text: stages.ts departedEntrantIds not found in the expected shape — re-read it");
  const out = [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
  if (out.length === 0) throw new Error("product-text: stages.ts departedEntrantIds names no status");
  return out;
}

export interface LadderText {
  /** DEFAULT_LADDER_CHALLENGE_RANGE: the reach when the stage config names none. */
  defaultRange: number;
  /** issueChallenge's LADDER_* refusal codes, in source order. */
  codes: string[];
  /** The entrant statuses the first challenge's ladder_order is written from. */
  fieldStatuses: string[];
}

/** stages.ts issueChallenge (W1-driving T7, D8): what FakeLadderDriver
 *  mirrors, read from the product's text. */
export function ladderText(): LadderText {
  const src = read("apps/web/src/server/usecases/stages.ts");
  const range = /\nexport const DEFAULT_LADDER_CHALLENGE_RANGE = (\d+);/.exec(src);
  if (range === null) throw new Error("product-text: stages.ts DEFAULT_LADDER_CHALLENGE_RANGE not found");
  const body = /\nexport async function issueChallenge\([\s\S]*?\n\}\n/.exec(src)?.[0];
  if (body === undefined) throw new Error("product-text: stages.ts issueChallenge not found");
  const codes = [...new Set([...body.matchAll(/"(LADDER_[A-Z_]+)"/g)].map((x) => x[1]))];
  if (codes.length === 0) throw new Error("product-text: stages.ts issueChallenge throws no LADDER_* code");
  const field = /where division_id = \$\{stage\.division_id\} and status in \(([^)]*)\)\s*order by seed nulls last/.exec(body);
  if (field === null) throw new Error("product-text: issueChallenge's ladder_order initialisation is not the seed-ordered field read the fake mirrors — re-read it");
  return { defaultRange: Number(range[1]), codes, fieldStatuses: [...field[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]) };
}
