// Capacity test 33 (spec §8.1, §5.7.2): ONE predicate. Nothing outside `lineLiveSql`, `stayLapsedSql`, `stayOpenSql`, `reservedSql`
// and the allow-listed stay upsert reads `queued_at`, `last_seen_at`, `last_gate`, `admitted_at` or `completing` (the five columns
// of §5.7.2) - so every place that asks "is this player in line?" asks the same question by construction - and the open-stay test
// (`served_at is null and ended_at is null`) is spelled in `stayOpenSql` and nowhere else.
//
// What it judges, over the production tree (comments blanked by the same lexer the video guards use, SQL taken from string and
// template literals):
//   1. THE READERS. Every read of a guarded column (a use that is not an assignment or an insert column) is counted per enclosing
//      top-level declaration. The set of declarations that read is EXACTLY the five allow-listed ones - the four fragments and
//      `upsertStay` (`stayOpenSql` counts: it is where the open test lives). A reader outside the list, or an allow-listed one
//      the scan no longer finds, fails.
//   2. THE RE-SPELLING. The open-stay test appears in no SQL outside `stayOpenSql`, in either order and with any alias.
//   3. THE CONSUMERS. Each fragment's uses are pinned per declaration: `lineLiveSql` by the gate's standing read, the door read,
//      the optional-yield read and the deadline protection (the nine consumers of `inLine` reach it through those and through
//      `boardPhase`); `reservedSql` by the standing read (the pool, the idle test, the own-row test) and the optional yield;
//      `stayOpenSql` outside the two fragments built on it by the standing read alone (the `completing` evaluation). The call
//      sites that reach `lineLiveSql` through `boardPhase`, and the other readers of the seat-line module, are pinned per file
//      and declaration, so a consumer gone, or a new one, fails and sends the author here.
//   4. NOTHING ELSE TOUCHES THE LEDGER. No other production file names `fixture_seat_line`, or a guarded column in SQL.
//
// The scanner is itself tested: it must pass the real seat-line.ts and fail six in-memory mutants of it, one per rule. Every count it
// judges is reported and zero is a failure. Single-sport reason: no sport is involved - these are source files.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { lex, productionSources } from "./_video-source-scan";

/** `apps/web/src`. */
const SRC = join(import.meta.dirname, "..", "..", "..");
const LINE_FILE = "server/external-play/seat-line.ts";

const GUARDED = ["queued_at", "last_seen_at", "last_gate", "admitted_at", "completing"] as const;
/** The allow-list: the four fragments and the upsert. */
const READERS = ["stayLapsedSql", "stayOpenSql", "lineLiveSql", "reservedSql", "upsertStay"] as const;
const FRAGMENTS = ["lineLiveSql", "reservedSql", "stayOpenSql", "stayLapsedSql"] as const;
type Fragment = (typeof FRAGMENTS)[number];

/** Where each fragment is used inside seat-line.ts, by declaration. The consumers of the lists in spec §5.7.2 hang off these. */
const FRAGMENT_USES: Record<Fragment, Record<string, number>> = {
  // inLine: 1 and 2 (the waiting-ahead count and the idle test's key-wide count: two statements in the standing read),
  // 3 (the door), 9 (the optional yield) directly; 4, 5, 7 and 8 through lineHoldsBoard (boardPhase).
  lineLiveSql: { readStanding: 2, ownStayInLine: 1, lineActive: 1, lineHoldsBoard: 1 },
  // The four consumers: the pool, the idle test, the own-row test (all in the standing read), and the optional yield.
  reservedSql: { readStanding: 3, lineActive: 1 },
  // Inside the two fragments built on it: one each. Outside them: the `completing` evaluation, the one.
  stayOpenSql: { lineLiveSql: 1, reservedSql: 1, readStanding: 1 },
  // The lapse clause: the open test, and the upsert's restart / silent / hold reads.
  stayLapsedSql: { stayOpenSql: 1, upsertStay: 3 },
};

/** The consumers outside seat-line.ts: every call of a seat-line reader, per file and declaration, and (for `boardPhase`) whether
 *  it is the create's `bothOnly` question. `consumer` names who it is in the spec's list. */
type Site = { file: string; owner: string; fn: string; times: number; bothOnly?: boolean; consumer: string };
const SITES: readonly Site[] = [
  { file: "server/usecases/external-play/preflight.ts", owner: "seatPlayer", fn: "boardPhase", times: 1, bothOnly: false, consumer: "inLine 4: seat admission past the deadline" },
  { file: "server/usecases/external-play/preflight.ts", owner: "seatPlayer", fn: "lineActive", times: 1, consumer: "inLine 9: the optional yield" },
  { file: "server/usecases/external-play/preflight.ts", owner: "passTheLine", fn: "gateClaim", times: 1, consumer: "the gate (inLine 1 and 2, reservedSql 1 to 3)" },
  { file: "server/usecases/external-play/preflight.ts", owner: "passTheLine", fn: "answerBusy", times: 1, consumer: "the gate's one named refusal" },
  { file: "server/usecases/external-play/room.ts", owner: "viewerPhase", fn: "boardPhase", times: 1, bothOnly: false, consumer: "inLine 7: the room's phase, per viewer" },
  { file: "server/usecases/external-play/room.ts", owner: "claimRoomSeat", fn: "ownStayInLine", times: 1, consumer: "inLine 3: the door" },
  { file: "server/usecases/external-play/room.ts", owner: "claimRoomSeat", fn: "ownStayArrival", times: 1, consumer: "the check-in is dated at the stay's arrival" },
  { file: "server/usecases/external-play/room.ts", owner: "claimRoomSeat", fn: "endStay", times: 2, consumer: "a seat serves the stay; a camera no wait can fix ends it" },
  { file: "server/usecases/external-play/room.ts", owner: "queueDeferred", fn: "settleDeferral", times: 1, consumer: "a mid-claim deferral" },
  { file: "server/usecases/external-play/sweep.ts", owner: "noShow", fn: "boardPhase", times: 1, bothOnly: false, consumer: "inLine 5: noShow's skip" },
  { file: "server/usecases/external-play/sweep.ts", owner: "meetingIsDone", fn: "boardPhase", times: 1, bothOnly: false, consumer: "inLine 8: teardown" },
  // Consumer 6, the create's allowance, asks the SAME phase reader but with `bothOnly`: it rests on both check-ins counting and
  // does not read the line (the deviation recorded in the build report). Four call sites in three declarations of two files.
  { file: "server/usecases/external-play/sweep.ts", owner: "mintRetry", fn: "boardPhase", times: 1, bothOnly: true, consumer: "inLine 6: the create's allowance (mint retry)" },
  { file: "server/usecases/external-play/create-game.ts", owner: "createGameIfReady", fn: "boardPhase", times: 1, bothOnly: true, consumer: "inLine 6: the create's allowance" },
  { file: "server/usecases/external-play/create-game.ts", owner: "createAtDequeue", fn: "boardPhase", times: 1, bothOnly: true, consumer: "inLine 6: the create's allowance (dequeue)" },
];
/** The seat-line functions whose callers are pinned above. */
const SEAT_LINE_API = ["boardPhase", "lineActive", "gateClaim", "answerBusy", "ownStayInLine", "ownStayArrival", "endStay", "settleDeferral", "lineHoldsBoard"] as const;

// ─── The scanner ──────────────────────────────────────────────────────────────────────────────────────────────────────────

type Decl = { name: string; at: number };
function declarations(live: string): Decl[] {
  const out: Decl[] = [];
  for (const m of live.matchAll(/^(?:export\s+)?(?:async\s+)?(?:function|const|class|let)\s+(\w+)/gm)) out.push({ name: m[1]!, at: m.index! });
  return out;
}
const ownerAt = (decls: Decl[], offset: number): string => {
  let name = "<top>";
  for (const d of decls) {
    if (d.at <= offset) name = d.name;
    else break;
  }
  return name;
};
const lineOf = (src: string, offset: number) => src.slice(0, offset).split("\n").length;

const SQLISH = /\b(select|insert\s+into|update|delete\s+from|from|where|set)\b/i;
const OPEN_TEST = [/\b(?:\w+\.)?served_at\s+is\s+null\s+and\s+(?:\w+\.)?ended_at\s+is\s+null\b/i, /\b(?:\w+\.)?ended_at\s+is\s+null\s+and\s+(?:\w+\.)?served_at\s+is\s+null\b/i];

type Use = { column: string; owner: string; line: number };
export type FileScan = {
  /** Reads of a guarded column (not an assignment, not an insert column), per use. */
  reads: Use[];
  writes: Use[];
  /** Spellings of the open-stay test. */
  openTests: { owner: string; line: number }[];
  /** Whether any SQL names the ledger. */
  namesLedger: boolean;
  /** Uses of each fragment, by declaration (definitions excluded). */
  fragmentUses: Record<Fragment, Record<string, number>>;
  /** Calls of the seat-line API, by declaration. */
  calls: { fn: string; owner: string; bothOnly: boolean }[];
  guardedMentionsInSql: Use[];
};

/** `sqlOnly`: judge only string and template literals that look like SQL (for files that are NOT the ledger's owner, where a plain
 *  message may carry a word such as `completing`); the owner file is judged in full, since its fragments are bare clauses. */
export function scanFile(src: string, sqlOnly = false): FileScan {
  const { live, chunks } = lex(src);
  const decls = declarations(live);
  const scan: FileScan = {
    reads: [],
    writes: [],
    openTests: [],
    namesLedger: false,
    fragmentUses: { lineLiveSql: {}, reservedSql: {}, stayOpenSql: {}, stayLapsedSql: {} },
    calls: [],
    guardedMentionsInSql: [],
  };
  for (const ch of chunks) {
    if (sqlOnly && !SQLISH.test(ch.text)) continue;
    const owner = ownerAt(decls, ch.offset);
    const line = lineOf(src, ch.offset);
    if (/\bfixture_seat_line\b/.test(ch.text)) scan.namesLedger = true;
    if (OPEN_TEST.some((re) => re.test(ch.text))) scan.openTests.push({ owner, line });
    // The columns of an insert: the first parenthesised list after `insert into <table> [as x]`.
    let insertList: [number, number] | null = null;
    const ins = /insert\s+into\s+\w+(?:\s+as\s+\w+)?\s*\(/i.exec(ch.text);
    if (ins) {
      const open = ins.index + ins[0].length - 1;
      const close = ch.text.indexOf(")", open);
      insertList = [open, close < 0 ? ch.text.length : close];
    }
    for (const col of GUARDED) {
      for (const m of ch.text.matchAll(new RegExp(`(^|[^\\w.])${col}(?![\\w])`, "g"))) {
        const at = m.index! + m[1]!.length;
        const after = ch.text.slice(at + col.length);
        const use = { column: col, owner, line };
        scan.guardedMentionsInSql.push(use);
        const assigned = /^\s*=(?!=)/.test(after);
        const inInsertList = insertList !== null && at > insertList[0] && at < insertList[1];
        (assigned || inInsertList ? scan.writes : scan.reads).push(use);
      }
      // An alias-qualified use (`l.queued_at`) is always a read: it is on the right of something, never a set target.
      for (const m of ch.text.matchAll(new RegExp(`\\b\\w+\\.${col}\\b`, "g"))) {
        void m;
        const use = { column: col, owner, line };
        scan.guardedMentionsInSql.push(use);
        scan.reads.push(use);
      }
    }
  }
  for (const f of FRAGMENTS) {
    for (const m of live.matchAll(new RegExp(`(?<!function\\s)\\b${f}\\(`, "g"))) {
      const owner = ownerAt(decls, m.index!);
      scan.fragmentUses[f][owner] = (scan.fragmentUses[f][owner] ?? 0) + 1;
    }
  }
  for (const fn of SEAT_LINE_API) {
    for (const m of live.matchAll(new RegExp(`(?<!function\\s)(?<![.\\w])${fn}\\(`, "g"))) {
      const owner = ownerAt(decls, m.index!);
      // The call's argument text: up to the matching close paren.
      let depth = 0;
      let end = m.index! + fn.length;
      for (let i = end; i < live.length; i += 1) {
        if (live[i] === "(") depth += 1;
        else if (live[i] === ")") {
          depth -= 1;
          if (depth === 0) {
            end = i;
            break;
          }
        }
      }
      scan.calls.push({ fn, owner, bothOnly: /\bbothOnly\s*:\s*true\b/.test(live.slice(m.index!, end)) });
    }
  }
  return scan;
}

/** Everything wrong with `seat-line.ts` (the one file that owns the ledger), as readable lines; empty means it passes. */
export function judgeLineFile(scan: FileScan, allow: readonly string[] = READERS): string[] {
  const bad: string[] = [];
  const allowed = new Set(allow);
  for (const u of scan.reads) if (!allowed.has(u.owner)) bad.push(`read of ${u.column} in ${u.owner} (line ${u.line}) outside the allow-list`);
  for (const t of scan.openTests) if (t.owner !== "stayOpenSql") bad.push(`the open-stay test is re-spelled in ${t.owner} (line ${t.line})`);
  const readers = new Set([...scan.reads.map((u) => u.owner), ...scan.openTests.map((t) => t.owner)]);
  for (const r of allow) if (!readers.has(r)) bad.push(`allow-listed reader ${r} was not found reading`);
  for (const f of FRAGMENTS) {
    const want = FRAGMENT_USES[f];
    const got = scan.fragmentUses[f];
    for (const [owner, n] of Object.entries(want)) if ((got[owner] ?? 0) !== n) bad.push(`${f} used ${got[owner] ?? 0}x in ${owner}, expected ${n}`);
    for (const owner of Object.keys(got)) if (!(owner in want)) bad.push(`${f} used in ${owner}, which is not a pinned consumer`);
  }
  return bad;
}

/** The pinned call sites against what one file's scan found. */
function callBadness(file: string, scan: FileScan): string[] {
  const bad: string[] = [];
  const mine = SITES.filter((s) => s.file === file);
  for (const s of mine) {
    const n = scan.calls.filter((c) => c.fn === s.fn && c.owner === s.owner && (s.bothOnly === undefined || c.bothOnly === s.bothOnly)).length;
    if (n !== s.times) bad.push(`${s.fn}(${s.bothOnly ? "bothOnly" : ""}) in ${s.owner}: ${n}x, expected ${s.times} [${s.consumer}]`);
  }
  for (const c of scan.calls) {
    if (!mine.some((s) => s.fn === c.fn && s.owner === c.owner)) bad.push(`${c.fn}( in ${c.owner} of ${file} is not a pinned consumer`);
  }
  return bad;
}

const read = (file: string) => readFileSync(join(SRC, file), "utf8");

/** Names of the ledger a module OTHER than seat-line.ts must not carry, found in its code (comments removed). `completing` is an
 *  ordinary English word and identifier elsewhere, so it is covered by the other three rules: a query cannot read that column
 *  without naming the table, one of the other four columns, or importing a fragment. */
function namesOfTheLedger(src: string): string[] {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:\w])\/\/[^\n]*/g, "$1");
  const found: string[] = [];
  for (const name of ["fixture_seat_line", "queued_at", "last_seen_at", "last_gate", "admitted_at", ...READERS]) {
    if (new RegExp(`\\b${name}\\b`).test(code)) found.push(name);
  }
  return found;
}

describe("one predicate: the check-in line's ledger has one reader (test 33)", () => {
  const lineSrc = read(LINE_FILE);
  const lineScan = scanFile(lineSrc);

  it("seat-line.ts: the guarded columns are READ by exactly the five allow-listed declarations (4 fragments + the upsert), and the open-stay test is spelled once", () => {
    const readers = new Set([...lineScan.reads.map((u) => u.owner), ...lineScan.openTests.map((t) => t.owner)]);
    expect([...readers].sort(), "the readers found").toEqual([...READERS].sort());
    expect(readers.size, "readers found: the four fragments and the upsert").toBe(5);
    expect(lineScan.reads.length, "anti-vacuity: reads scanned").toBeGreaterThan(10);
    expect(lineScan.writes.length, "anti-vacuity: writes scanned (assignments and the insert's columns)").toBeGreaterThan(4);
    expect(lineScan.openTests, "the open-stay test is in stayOpenSql only").toEqual([expect.objectContaining({ owner: "stayOpenSql" })]);
    expect(judgeLineFile(lineScan)).toEqual([]);
  });

  it("seat-line.ts: the consumers of the fragments are the pinned ones - lineLiveSql 5 uses in 4 declarations, reservedSql 4 in 2 (the four consumers), stayOpenSql outside its two fragments 1 (the completing evaluation)", () => {
    const uses = (f: Fragment) => Object.values(lineScan.fragmentUses[f]).reduce((a, b) => a + b, 0);
    expect(uses("lineLiveSql"), "lineLiveSql uses").toBe(5);
    expect(Object.keys(lineScan.fragmentUses.lineLiveSql).sort()).toEqual(["lineActive", "lineHoldsBoard", "ownStayInLine", "readStanding"]);
    expect(uses("reservedSql"), "reservedSql consumers: the pool, the idle test, the own-row test, the optional yield").toBe(4);
    const outside = Object.entries(lineScan.fragmentUses.stayOpenSql).filter(([o]) => o !== "lineLiveSql" && o !== "reservedSql");
    expect(outside, "stayOpenSql outside the two fragments built on it: the completing evaluation").toEqual([["readStanding", 1]]);
  });

  it("the other consumers: every call of a seat-line reader outside it is pinned per file and declaration - the nine consumers of inLine map to concrete call sites (count reported)", () => {
    const files = [...new Set(SITES.map((s) => s.file))];
    let calls = 0;
    const bad: string[] = [];
    for (const file of files) {
      const scan = scanFile(read(file));
      calls += scan.calls.length;
      bad.push(...callBadness(file, scan));
    }
    expect(files.length, "files with pinned sites").toBe(4);
    expect(calls, "calls found in them").toBeGreaterThanOrEqual(SITES.reduce((n, s) => n + s.times, 0));
    expect(bad).toEqual([]);
    // The nine, by name: each is reached through a pinned site or through a fragment use above.
    const nine = SITES.filter((s) => s.consumer.startsWith("inLine")).map((s) => s.consumer.split(":")[0]);
    expect([...new Set(nine)].sort(), "consumers 3 to 9 are call sites; 1 and 2 are the standing read's fragment uses, pinned above").toEqual(["inLine 3", "inLine 4", "inLine 5", "inLine 6", "inLine 7", "inLine 8", "inLine 9"]);
    expect(Object.keys(FRAGMENT_USES.lineLiveSql).length + Object.keys(FRAGMENT_USES.reservedSql).length, "declarations that use the line fragments").toBeGreaterThan(0);
  });

  it("no other production file names the ledger, a guarded column, or a fragment (comments aside): the ledger can only be read through seat-line.ts's own exports (production files scanned reported)", () => {
    const files = productionSources(SRC).filter((f) => f !== LINE_FILE);
    expect(files.length, "anti-vacuity: production files scanned").toBeGreaterThan(500);
    const offenders: string[] = [];
    for (const file of files) {
      for (const hit of namesOfTheLedger(read(file))) offenders.push(`${file}: ${hit}`);
    }
    expect(offenders).toEqual([]);
  });

  it("the other-files rule can fail: a planted ledger name, guarded column or fragment import is found, and a comment that merely mentions one is not", () => {
    expect(namesOfTheLedger("const q = sql`select 1 from fixture_seat_line`;")).toEqual(["fixture_seat_line"]);
    expect(namesOfTheLedger("sql`where l.queued_at is not null`")).toEqual(["queued_at"]);
    expect(namesOfTheLedger("import { lineLiveSql } from '@/server/external-play/seat-line';")).toEqual(["lineLiveSql"]);
    expect(namesOfTheLedger("// the door reads lineLiveSql and queued_at\n/* fixture_seat_line */\nconst x = 1;")).toEqual([]);
  });

  describe("the scanner can fail (each mutant is seat-line.ts with one rule broken, in memory)", () => {
    const mutants: { name: string; from: string; to: string; allow?: readonly string[]; expectBad: RegExp }[] = [
      {
        name: "a raw last_seen_at read added to a consumer (the door)",
        from: "${lineLiveSql(now)}) as in_line",
        to: "${lineLiveSql(now)} and l.last_seen_at is not null) as in_line",
        expectBad: /read of last_seen_at in ownStayInLine/,
      },
      {
        name: "the upsert's allow-list entry deleted (the upsert is then a forbidden reader)",
        from: "",
        to: "",
        allow: READERS.filter((r) => r !== "upsertStay"),
        expectBad: /read of \w+ in upsertStay/,
      },
      {
        name: "a raw admitted_at read added to the gate",
        from: "update fixture_seat_line set completing = true where fixture_id = ${a.fixtureId} and person_id = ${a.otherPersonId}",
        to: "update fixture_seat_line set completing = true where fixture_id = ${a.fixtureId} and person_id = ${a.otherPersonId} and admitted_at is null",
        expectBad: /read of admitted_at in gateClaim/,
      },
      {
        name: "the open-stay test re-spelled in the completing evaluation",
        from: "l.person_id = ${a.otherPersonId} and ${stayOpenSql(nowSql)})",
        to: "l.person_id = ${a.otherPersonId} and l.served_at is null and l.ended_at is null)",
        expectBad: /the open-stay test is re-spelled in readStanding/,
      },
      {
        name: "the door made a raw column read",
        from: "and ${lineLiveSql(now)}) as in_line",
        to: "and l.queued_at is not null) as in_line",
        expectBad: /read of queued_at in ownStayInLine/,
      },
      {
        name: "a consumer gone: the optional yield no longer asks for a live admitted stay",
        from: " or exists (select 1 from fixture_seat_line l where l.budget_key = ${a.budgetKey} and ${reservedSql(now)} is not null)) as active",
        to: ") as active",
        expectBad: /reservedSql used 0x in lineActive, expected 1/,
      },
    ];
    it("passes the real file and fails every mutant, with the reason (6 mutants, all applied)", () => {
      expect(judgeLineFile(lineScan), "premise: the real file passes").toEqual([]);
      let applied = 0;
      for (const m of mutants) {
        let mutated = lineSrc;
        if (m.from !== "") {
          expect(lineSrc.includes(m.from), `${m.name}: the text to mutate exists exactly once`).toBe(true);
          expect(lineSrc.split(m.from).length - 1, `${m.name}: exactly once`).toBe(1);
          mutated = lineSrc.replace(m.from, m.to);
          expect(mutated, `${m.name}: the mutation changed the source`).not.toBe(lineSrc);
        }
        const bad = judgeLineFile(scanFile(mutated), m.allow);
        expect(bad.length, `${m.name}: the guard reports something`).toBeGreaterThan(0);
        expect(bad.join("\n"), m.name).toMatch(m.expectBad);
        applied += 1;
      }
      expect(applied, "mutants applied").toBe(mutants.length);
    });

    it("a consumer outside seat-line.ts is pinned too: the create's allowance losing bothOnly, and a new caller, both fail the call table", () => {
      const file = "server/usecases/external-play/create-game.ts";
      const src = read(file);
      expect(callBadness(file, scanFile(src)), "premise: the real file passes").toEqual([]);
      const lost = src.replace(/bothOnly:\s*true/, "bothOnly: false");
      expect(lost, "the mutation changed the source").not.toBe(src);
      expect(callBadness(file, scanFile(lost)).join("\n")).toMatch(/boardPhase\(bothOnly\) in (createGameIfReady|createAtDequeue): 0x, expected 1/);
      const extra = src + "\nasync function newReader() { return boardPhase(new Date(), { fixtureId: 'f', anchor: null as never }, { personId: null, facts: { own: false, both: false } }); }\n";
      expect(callBadness(file, scanFile(extra)).join("\n")).toMatch(/boardPhase\( in newReader of .* is not a pinned consumer/);
    });
  });
});
