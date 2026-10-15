// D16 (design §5.6.1 and §5.6.3) - the two source guards.
//
// 1. EVERY FIXTURE-KEYED REFERENCE TO A VIDEO TABLE NAMES THE SIDE. A board has a meeting per player, so a statement that
//    reaches `fixture_video_meetings`, `fixture_video_participants` or `fixture_video_guard_faults` by `fixture_id` alone lands
//    on both rows (or on the wrong one). The guard walks the production tree and judges each TABLE REFERENCE (a `from`, `join`,
//    `update`, `insert into` or `delete from`), not each statement: a key elsewhere in the same statement does not count for it.
//    A reference passes when its own predicate (or `on`, or insert column list) names `side`, or names `participant_id` (a
//    participants reference only: the vendor issues a participant id inside exactly one meeting, `unique (fixture_id,
//    participant_id)`). A reference reached by `meeting_id` or by a row's own primary key is not fixture-keyed and is not
//    counted. A BARE scan (no key at all - the sweep's `teardownCandidates` and `cameraCandidates`) does not count either, but
//    must SELECT `side` (or be identified by its own primary key), because the per-row consumer needs it.
//    The statements that mean BOTH sides on purpose are listed below with a reason; a listed entry that no longer matches
//    exactly that many references fails.
// 2. NOTHING BUT THE PILL READS THE CAMERA REPORT (§5.6.3). `camera_reported` and `camera_reported_at` are a player's browser's
//    word for the OPPONENT's presence pill; the seat gate, `camera_lost`, the evidence read and the teardown stay on vendor-side
//    sources. The columns are named in exactly two production files (the usecase that writes them and the snapshot composer
//    that reads them).
//
// Anti-vacuity (TEST-STRATEGY.md): every sweep reports what it checked and zero checked is a FAILURE; the scanner is itself
// tested on fixtures that must pass AND on their mutants that must fail; and the guards were mutated by hand (below).
// Single-sport reason: no sport is involved - these are SQL statements.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  applyAllowList,
  filesNamingCameraReport,
  lex,
  productionSources,
  scanSource,
  scanTree,
  tally,
  VIDEO_TABLES,
  type BothSides,
  type Judged,
  type Outcome,
} from "./_video-source-scan";

/** `apps/web/src`. */
const SRC = join(import.meta.dirname, "..", "..", "..");

// ─── The rule's own exemptions (§5.6.1) ──────────────────────────────────────────────────────────────────────────────

/** Statements that reach a video table by `fixture_id` and mean BOTH sides on purpose. Paths are under `src/server`. */
const BOTH_SIDES: readonly BothSides[] = [
  {
    file: "usecases/external-play/seated.ts",
    fn: "fixturesSeating",
    table: "fixture_video_participants",
    times: 1,
    reason: "a person with a player participant on EITHER side's meeting is seated on the board",
  },
  {
    file: "usecases/external-play/open-round.ts",
    fn: "openRound",
    table: "fixture_video_meetings",
    times: 2,
    reason: "a re-opened or re-armed board retires BOTH players' stale meetings (two deletes, each returning every row it took)",
  },
  {
    file: "external-play/video/realtimekit.ts",
    fn: "retireStaleMeeting",
    table: "fixture_video_meetings",
    times: 1,
    reason: "a re-pair makes EVERY row of the board stale at once: the select takes both, each room is ended, and each row is then deleted by its own meeting_id",
  },
  {
    file: "usecases/external-play/room-end.ts",
    fn: "endRoomAtResult",
    table: "fixture_video_meetings",
    times: 1,
    reason: "the game's end ends BOTH rooms: every unended row of the fixture, each in its own try",
  },
];

/** The only production files that may name a camera-report column. Paths under `src`. */
const CAMERA_REPORT_FILES = ["server/usecases/external-play/camera-report.ts", "server/usecases/external-play/room.ts"] as const;
/** The OpenAPI document and the schemas that build it describe the wire, not the column (§5.6.3). */
const WIRE_DESCRIBERS = ["server/api-v1/openapi.ts", "server/api-v1/schemas.ts"] as const;

// ─── The scanner, on fixtures ────────────────────────────────────────────────────────────────────────────────────────

/** Judges `body` as the SQL of one tagged template in a function. */
const judge = (body: string, fn = "f"): Judged[] => scanSource(`export async function ${fn}() {\n  return sql\`${body}\`;\n}\n`, "server/x.ts").judged;
const outcomes = (body: string): Outcome[] => judge(body).map((j) => j.outcome);

describe("the scanner judges each table reference by its OWN predicate", () => {
  it("a meetings reference: side passes, and the same statement without it fails (the mutant)", () => {
    expect(outcomes("select m.meeting_id from fixture_video_meetings m where m.fixture_id = ${x} and m.side = ${y}")).toEqual(["side"]);
    expect(outcomes("select m.meeting_id from fixture_video_meetings m where m.fixture_id = ${x}")).toEqual(["missing_side"]);
    expect(outcomes("select meeting_id from fixture_video_meetings where fixture_id = ${x} and side = ${y}")).toEqual(["side"]);
    expect(outcomes("select meeting_id from fixture_video_meetings where fixture_id = ${x}")).toEqual(["missing_side"]);
  });

  it("a join's own `on` is judged - and its `where` conjuncts that name its alias count for it", () => {
    expect(outcomes("select 1 from fixtures f join fixture_video_meetings m on m.fixture_id = f.id and m.side = ${s} where f.id = ${x}")).toEqual(["side"]);
    expect(outcomes("select 1 from fixtures f join fixture_video_meetings m on m.fixture_id = f.id where f.id = ${x}")).toEqual(["missing_side"]);
    expect(outcomes("select 1 from fixtures f join fixture_video_meetings m on m.fixture_id = f.id where m.side = ${s}")).toEqual(["side"]);
    expect(outcomes("select 1 from fixtures f left join fixture_video_meetings mh on mh.fixture_id = f.id and mh.side = 'home'")).toEqual(["side"]);
  });

  it("a key elsewhere in the same statement does not count for it: leaveAsArbiter's shape (participant_id on one table, fixture_id alone on the join)", () => {
    const stmt = (on: string) =>
      `select vp.id from fixture_video_participants vp join fixture_video_meetings m on ${on} where vp.fixture_id = \${f} and vp.participant_id = \${p} and vp.preset = 'arbiter'`;
    expect(outcomes(stmt("m.fixture_id = vp.fixture_id and m.side = vp.side"))).toEqual(["participant_id", "side"]);
    expect(outcomes(stmt("m.fixture_id = vp.fixture_id"))).toEqual(["participant_id", "missing_side"]);
  });

  it("another table's side does not count for this reference", () => {
    expect(outcomes("select 1 from fixture_video_meetings m join fixtures f on f.id = m.fixture_id where m.fixture_id = ${x} and f.side = ${s}")).toEqual(["missing_side"]);
    expect(outcomes("select 1 from fixture_video_meetings m, fixture_video_participants vp where m.fixture_id = ${x} and vp.side = ${s}")).toContain("missing_side");
  });

  it("a `side` that appears only inside a sub-select does not count for the reference around it", () => {
    expect(outcomes("select 1 from fixture_video_meetings m where m.fixture_id = ${x} and exists (select 1 from fixtures f where f.side = m.side)")).toEqual(["missing_side"]);
  });

  it("a sub-select's own reference is judged on its own (fixturesSeating's shape: the reference is fixture-keyed and names no side)", () => {
    const seated = "select f.id from fixtures f where exists (select 1 from fixture_video_participants vp where vp.fixture_id = f.id and vp.preset = 'player')";
    expect(outcomes(seated)).toEqual(["missing_side"]);
    expect(outcomes(seated.replace("vp.fixture_id = f.id", "vp.fixture_id = f.id and vp.side = 'home'"))).toEqual(["side"]);
  });

  it("participant_id is the exemption for PARTICIPANTS references only", () => {
    expect(outcomes("update fixture_video_participants set last_publisher_seen_at = ${t} where fixture_id = ${f} and participant_id = ${p}")).toEqual(["participant_id"]);
    expect(outcomes("update fixture_video_participants set removed_at = now() where fixture_id = ${f} and side = ${s} and participant_id = ${p}")).toEqual(["side"]);
    // The same two keys on a meetings or a guard-faults reference are not an exemption.
    expect(outcomes("update fixture_video_meetings set ended_at = now() where fixture_id = ${f} and participant_id = ${p}")).toEqual(["missing_side"]);
    expect(outcomes("select 1 from fixture_video_guard_faults where fixture_id = ${f} and participant_id = ${p}")).toEqual(["missing_side"]);
  });

  it("an insert is judged by its column list, and a participant_id column is no exemption", () => {
    expect(outcomes("insert into fixture_video_participants (fixture_id, side, person_id, preset, participant_id) values (${a}, ${b}, ${c}, 'player', ${d})")).toEqual(["side"]);
    expect(outcomes("insert into fixture_video_participants (fixture_id, person_id, preset, participant_id) values (${a}, ${c}, 'player', ${d})")).toEqual(["missing_side"]);
    expect(outcomes("insert into fixture_video_meetings (fixture_id, org_id, meeting_id) values (${a}, ${b}, ${c}) on conflict (fixture_id) do nothing")).toEqual(["missing_side"]);
    expect(outcomes("insert into fixture_video_meetings (fixture_id, side, org_id, meeting_id) values (${a}, ${s}, ${b}, ${c}) on conflict (fixture_id, side) do nothing")).toEqual(["side"]);
  });

  it("a delete by fixture is a both-sides reference (an allow-list candidate); by meeting_id it is not fixture-keyed", () => {
    expect(outcomes("delete from fixture_video_meetings where fixture_id in ${ids}")).toEqual(["missing_side"]);
    expect(outcomes("delete from fixture_video_meetings m using fixtures f where m.fixture_id = ${x} and f.id = m.fixture_id")).toEqual(["missing_side"]);
    expect(outcomes("delete from fixture_video_meetings where meeting_id = ${m}")).toEqual(["other_key"]);
  });

  it("a reference reached by meeting_id or by its own primary key is not fixture-keyed (not counted)", () => {
    expect(outcomes("update fixture_video_meetings set camera_evidence_at = ${t} where meeting_id = ${m}")).toEqual(["other_key"]);
    expect(outcomes("update fixture_video_participants set removed_at = ${t} where id = ${i} and removed_at is null")).toEqual(["other_key"]);
    expect(judge("update fixture_video_meetings set camera_evidence_at = ${t} where meeting_id = ${m}")[0]!.names.fixtureId).toBe(false);
  });

  it("a CTE: the statement keyed by meeting_id is not counted and the update that follows it is judged by its own where", () => {
    const stmt = (w: string) =>
      `with ended as (update fixture_video_meetings set ended_at = now() where meeting_id = \${m} and ended_at is null returning fixture_id, side) update fixture_video_participants vp set removed_at = now() from ended where ${w}`;
    expect(outcomes(stmt("vp.fixture_id = ended.fixture_id and vp.side = ended.side and vp.preset = 'arbiter'"))).toEqual(["other_key", "side"]);
    expect(outcomes(stmt("vp.fixture_id = ended.fixture_id and vp.preset = 'arbiter'"))).toEqual(["other_key", "missing_side"]);
  });

  it("a BARE scan does not count but must select side (or be identified by its primary key)", () => {
    expect(outcomes("select m.fixture_id, m.side, m.meeting_id from fixture_video_meetings m where m.ended_at is null")).toEqual(["bare_side"]);
    expect(outcomes("select m.fixture_id, m.meeting_id from fixture_video_meetings m where m.ended_at is null")).toEqual(["bare_no_side"]);
    expect(outcomes("select vp.id, vp.fixture_id from fixture_video_participants vp where vp.preset = 'arbiter' and vp.removed_at is null")).toEqual(["bare_pk"]);
    expect(outcomes("select vp.fixture_id, vp.participant_id from fixture_video_participants vp where vp.preset = 'arbiter'")).toEqual(["bare_no_side"]);
    expect(judge("select m.fixture_id, m.side from fixture_video_meetings m where m.ended_at is null")[0]!.names.fixtureId, "a bare scan is not counted").toBe(false);
  });

  it("a write with no recognisable key is a violation", () => {
    expect(outcomes("update fixture_video_meetings set ended_at = now() where ended_at is null")).toEqual(["unkeyed_write"]);
    expect(outcomes("delete from fixture_video_guard_faults where ended_at is not null")).toEqual(["unkeyed_write"]);
  });

  it("a mention that is none of the five reference shapes is UNCLASSIFIED, never skipped", () => {
    const one = (body: string) => scanSource(`export function f() { return sql\`${body}\`; }`, "server/x.ts");
    expect(one("lock table fixture_video_meetings in access exclusive mode").unclassified.map((u) => u.before)).toEqual(["lock table"]);
    expect(one("select 1 from fixtures f using fixture_video_meetings m").unclassified.length).toBe(1);
    expect(scanSource(`const T = "fixture_video_meetings";`, "server/x.ts").unclassified.length, "a plain string").toBe(1);
    // ... while a reference is not.
    expect(one("select 1 from fixture_video_meetings where fixture_id = ${a} and side = ${b}").unclassified).toEqual([]);
  });

  it("the enclosing top-level function is named, so an allow-list entry can say where it is", () => {
    expect(judge("delete from fixture_video_meetings where fixture_id = ${x}", "endEverything")[0]!.fn).toBe("endEverything");
    const nested = scanSource(
      "export async function outer() {\n  const inner = async () => {\n    return sql`delete from fixture_video_meetings where fixture_id = ${x}`;\n  };\n  return inner();\n}\n",
      "server/x.ts",
    );
    expect(nested.judged[0]!.fn, "the nearest column-0 function, not the inner arrow").toBe("outer");
  });
});

describe("the lexer reads TypeScript the way the guard needs", () => {
  it("a mention in a comment is not a reference, and a template nested in an expression is a chunk of its own", () => {
    const src = [
      "// select 1 from fixture_video_meetings where fixture_id = 1",
      "/* delete from fixture_video_participants where fixture_id = 1 */",
      "export async function f() {",
      "  return sql`select 1 from fixtures ${x ? sql`and exists (select 1 from fixture_video_guard_faults where fixture_id = ${a} and side = ${b})` : sql``}`;",
      "}",
    ].join("\n");
    const r = scanSource(src, "server/x.ts");
    expect(r.mentionsPlain, "only the nested chunk's mention is live").toBe(1);
    expect(r.judged.map((j) => [j.table, j.outcome])).toEqual([["fixture_video_guard_faults", "side"]]);
  });

  it("a regex literal holding a quote or a backtick does not derail it, and a division is not a regex", () => {
    const src = [
      "const a = /[`'\"]/g;",
      "const b = (x + 1) / 2 / 3;",
      "export async function f() {",
      "  const re = x.replace(/`/g, ''); // a backtick in a regex",
      "  return sql`delete from fixture_video_meetings where fixture_id = ${a}`;",
      "}",
    ].join("\n");
    const r = scanSource(src, "server/x.ts");
    expect(r.judged.map((j) => j.outcome)).toEqual(["missing_side"]);
    expect(r.mentionsPlain).toBe(r.mentionsTokenized);
  });

  it("offsets survive: `live` has the source's length and line breaks, so a reference's line is real", () => {
    const src = "// a comment\nconst x = 1; /* two\nlines */\nexport async function f() {\n  return sql`\n    delete from fixture_video_meetings where fixture_id = ${a}`;\n}\n";
    expect(lex(src).live.length).toBe(src.length);
    expect(lex(src).live.split("\n").length).toBe(src.split("\n").length);
    expect(scanSource(src, "server/x.ts").judged[0]!.line).toBe(6);
  });

  it("a mention outside every string is a DISAGREEMENT between the plain count and the tokenized count, never skipped", () => {
    const inCode = scanSource("const fixture_video_meetings = 1;", "server/x.ts");
    expect([inCode.mentionsPlain, inCode.mentionsTokenized, inCode.mentionsInCode]).toEqual([1, 0, 1]);
    const inRegex = scanSource("const re = /fixture_video_participants/;", "server/x.ts");
    expect([inRegex.mentionsPlain, inRegex.mentionsTokenized]).toEqual([1, 0]);
    const inString = scanSource("const t = sql`select 1 from fixture_video_guard_faults where fixture_id = ${a} and side = ${b}`;", "server/x.ts");
    expect([inString.mentionsPlain, inString.mentionsTokenized, inString.mentionsInCode], "a reference in a string agrees").toEqual([1, 1, 0]);
  });

  it("an unterminated template, string or comment is an error, not a silent end of the file", () => {
    expect(() => lex("const a = `abc")).toThrow(/unterminated template/);
    expect(() => lex("const a = 'abc\n';")).toThrow(/unterminated string/);
    expect(() => lex("/* abc")).toThrow(/unterminated comment/);
  });

  it("the plain count of mentions and the tokenized count agree on a statement of every shape (counted)", () => {
    const src = [
      "export async function f() {",
      "  await sql`select 1 from fixture_video_meetings m join fixture_video_participants p on p.fixture_id = m.fixture_id and p.side = m.side where m.fixture_id = ${a} and m.side = ${b}`;",
      "  await sql`insert into fixture_video_guard_faults (fixture_id, side) values (${a}, ${b})`;",
      "  await sql`update fixture_video_meetings set ended_at = now() where meeting_id = ${m}`;",
      "}",
    ].join("\n");
    const r = scanSource(src, "server/x.ts");
    expect(r.mentionsPlain).toBe(4);
    expect(r.mentionsTokenized).toBe(4);
    expect(r.judged.length, "anti-vacuity: four references judged").toBe(4);
  });
});

describe("the allow-list", () => {
  const one = (fn: string, times: number): BothSides => ({ file: "x.ts", fn, table: "fixture_video_meetings", times, reason: "test" });
  const refs = (...fns: string[]): Judged[] => fns.flatMap((fn) => judge("delete from fixture_video_meetings where fixture_id = ${a}", fn)).map((j) => ({ ...j, file: "server/x.ts" }));

  it("takes exactly the references it lists and leaves the rest as violations", () => {
    const v = applyAllowList(refs("a", "b"), [one("a", 1)]);
    expect(v.allowed.map((j) => j.fn)).toEqual(["a"]);
    expect(v.violations.map((j) => j.fn)).toEqual(["b"]);
    expect(v.stale).toEqual([]);
  });

  it("an entry that matches nothing is STALE, and so is one that matches a different number of references", () => {
    expect(applyAllowList(refs("a"), [one("a", 1), one("gone", 1)]).stale.map((s) => [s.entry.fn, s.found])).toEqual([["gone", 0]]);
    expect(applyAllowList(refs("a", "a"), [one("a", 1)]).stale.map((s) => [s.entry.fn, s.found]), "a second both-sides statement in the same function").toEqual([["a", 2]]);
    expect(applyAllowList(refs("a"), [one("a", 2)]).stale.map((s) => [s.entry.fn, s.found]), "one fewer than listed").toEqual([["a", 1]]);
  });

  it("an entry whose statement now names a side is STALE (it no longer needs the exemption)", () => {
    const fixed = judge("delete from fixture_video_meetings where fixture_id = ${a} and side = ${b}", "a").map((j) => ({ ...j, file: "server/x.ts" }));
    expect(applyAllowList(fixed, [one("a", 1)]).stale.map((s) => s.found)).toEqual([0]);
  });
});

// ─── 1. The real tree ────────────────────────────────────────────────────────────────────────────────────────────────

describe("every fixture-keyed reference to a video table names the side (§5.6.1)", () => {
  const tree = scanTree(SRC);
  const judged = tree.withTables.flatMap((s) => s.judged);
  const verdict = applyAllowList(judged, BOTH_SIDES);
  const t = tally(judged, verdict.allowed);
  const where = (j: Judged) => `${j.file}:${j.line} (${j.fn}) ${j.kind} ${j.table} -> ${j.outcome}`;

  it("scanned the production tree, and saw every kind of reference (anti-vacuity)", () => {
    // Reported: the checked count and the passes on each key.
    console.info(
      `[source guard 5.6.1] files walked ${tree.files}, files naming a video table ${tree.withTables.length}, references ${t.references}; ` +
        `fixture-keyed (counted) ${t.counted}: passed on side ${t.side}, on participant_id ${t.participantId} (only on it: ${t.participantIdOnly}), both-sides allow-listed ${t.allowed}; ` +
        `not fixture-keyed ${t.otherKey}; bare scans selecting side/pk ${t.bare}; per table ${JSON.stringify(t.perTable)}`,
    );
    expect(tree.files, "the walk found the production tree").toBeGreaterThan(500);
    expect(tree.withTables.length, "files naming a video table").toBeGreaterThan(0);
    expect(t.counted, "zero checked is a failure").toBeGreaterThan(0);
    expect(t.side, "zero passed on `side` is a guard gone vacuous on it").toBeGreaterThan(0);
    expect(t.participantId, "zero passed on `participant_id` is a guard gone vacuous on it").toBeGreaterThan(0);
    expect(t.participantIdOnly, "the exemption is in use").toBeGreaterThan(0);
    expect(t.otherKey, "references reached by meeting_id or a primary key were seen").toBeGreaterThan(0);
    expect(t.bare, "bare scans were seen (the sweep's candidates)").toBeGreaterThan(0);
    for (const table of VIDEO_TABLES) expect(t.perTable[table], `${table} has references`).toBeGreaterThan(0);
  });

  it("the lexer saw every mention the text has, and nothing is unclassified or outside a string", () => {
    const off = tree.withTables.filter((s) => s.mentionsPlain !== s.mentionsTokenized).map((s) => `${s.file}: ${s.mentionsPlain} plain, ${s.mentionsTokenized} tokenized`);
    expect(off, "a mention the scanner did not see").toEqual([]);
    expect(tree.withTables.flatMap((s) => s.unclassified.map((u) => `${u.file}:${u.line} ${u.table} after "${u.before}"`)), "a mention that is not a reference").toEqual([]);
    expect(tree.withTables.filter((s) => s.mentionsInCode > 0).map((s) => s.file), "a table name in code outside a string").toEqual([]);
  });

  it("every fixture-keyed reference names the side, or participant_id (participants), or is on the both-sides list", () => {
    expect(verdict.violations.map(where)).toEqual([]);
  });

  it("every both-sides entry still matches exactly the references it lists", () => {
    expect(verdict.stale.map((s) => `${s.entry.file} ${s.entry.fn} ${s.entry.table}: listed ${s.entry.times}, found ${s.found}`)).toEqual([]);
    expect(verdict.allowed.length, "the list took references (anti-vacuity)").toBe(BOTH_SIDES.reduce((n, e) => n + e.times, 0));
  });

  it("every bare scan that is not a violation selects `side` or is identified by its primary key", () => {
    const bare = judged.filter((j) => j.outcome === "bare_side" || j.outcome === "bare_pk");
    const functions = new Set(bare.map((j) => j.fn));
    // The two the spec names: the sweep's teardown and camera candidates.
    expect([...functions].filter((f) => f === "teardownCandidates" || f === "cameraCandidates").sort()).toEqual(["cameraCandidates", "teardownCandidates"]);
    expect(bare.every((j) => j.outcome === "bare_side" || (j.outcome === "bare_pk" && j.table !== "fixture_video_meetings"))).toBe(true);
  });
});

// ─── 2. The camera report ────────────────────────────────────────────────────────────────────────────────────────────

describe("nothing but the pill reads the camera report (§5.6.3)", () => {
  it("the two columns are named in exactly the usecase that writes them and the composer that reads them", () => {
    const r = filesNamingCameraReport(SRC, WIRE_DESCRIBERS);
    console.info(`[source guard 5.6.3] files scanned ${r.scanned}; naming a camera-report column: ${JSON.stringify(r.named)}; lexer fallbacks ${r.lexFailures.length}`);
    expect(r.scanned, "zero scanned is a failure").toBeGreaterThan(500);
    expect(r.named, "a file that reads the report outside the two").toEqual([...CAMERA_REPORT_FILES].sort());
  });

  it("each allowed file really names a column, and each excluded file exists (a rename cannot pass by finding nothing)", () => {
    const named = filesNamingCameraReport(SRC, []).named;
    for (const f of CAMERA_REPORT_FILES) expect(named, `${f} names a camera-report column`).toContain(f);
    const present = new Set(productionSources(SRC));
    for (const f of WIRE_DESCRIBERS) expect(present.has(f), `${f} exists`).toBe(true);
  });

  const tmp = mkdtempSync(join(tmpdir(), "camera-report-guard-"));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));
  const put = (rel: string, body: string) => {
    const full = join(tmp, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body);
  };

  it("on a tree of its own: a third file naming a column is found, and tests, generated files, comments and the wire describers are not", () => {
    put("usecases/writes.ts", "export const q = sql`update p set camera_reported = ${s}, camera_reported_at = ${t}`;");
    put("usecases/reads.ts", "export const q = sql`select camera_reported_at from p`;");
    put("usecases/seat-gate.ts", "export const q = sql`select camera_reported from fixture_video_participants where fixture_id = ${f}`;"); // the mutant
    put("usecases/comment-only.ts", "// the seat gate never reads camera_reported\n/* camera_reported_at either */\nexport const x = 1;");
    put("usecases/__tests__/seed.ts", "export const q = 'camera_reported';");
    put("usecases/x.test.ts", "export const q = 'camera_reported';");
    put("generated/types.ts", "export type T = { camera_reported: string };");
    put("api/openapi.ts", "export const d = { camera_reported: 1 };");
    put("api/schemas.ts", "export const s = { camera_reported_at: 1 };");
    const r = filesNamingCameraReport(tmp, ["api/openapi.ts", "api/schemas.ts"]);
    expect(r.named).toEqual(["usecases/reads.ts", "usecases/seat-gate.ts", "usecases/writes.ts"]);
    expect(r.scanned, "tests and the generated directory are not scanned, the excluded files are not scanned either").toBe(4);
  });

  it("a file the lexer cannot read is searched whole (stricter, never looser)", () => {
    put("odd/unterminated.ts", "const a = `never closed ... camera_reported");
    const r = filesNamingCameraReport(tmp, ["api/openapi.ts", "api/schemas.ts"]);
    expect(r.lexFailures).toEqual(["odd/unterminated.ts"]);
    expect(r.named).toContain("odd/unterminated.ts");
  });
});
