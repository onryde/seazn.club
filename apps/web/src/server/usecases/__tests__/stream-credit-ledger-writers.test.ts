// The match-credit ledger's writers and the one label that depends on them (Settings -> Credits -> Streaming, review I2).
// Pure: no database, no network — the TypeScript parser over the source tree. Two things are pinned here and neither is
// visible from the history reader's own tests:
//
//   1. THE NINE INSERT SITES. `org_stream_credits` is written from nine statements in stream-credits.ts. The history names a
//      row by its shape, so a tenth writer (or a renamed one) must fail HERE, by name, before it can ship a row the
//      classifier labels wrongly. The sites are held to `LEDGER_WRITER_SITES` (_ledger-writer-sites.ts — an oracle typed from
//      the writers' contract) in both directions, and no other production file may write the table at all.
//   2. WHAT "Refund: camera never connected" MEANS. The label is read off a refund row with no author and a session — a shape
//      the classifier cannot tell from any other author-less refund. It is honest because exactly ONE thing in production
//      writes such a row: `refundConsumeForSession`, called from exactly one place (the use-case's `refund_credit` effect
//      handler), and that effect is emitted by exactly one cell of the domain (`camera_never_live`). Each link is pinned,
//      and every scanner is itself tested on synthetic sources so an aliased import, a quoted table name or a namespace
//      access cannot walk past it.
//
// Mutant table (each run once by hand against a copy; see the PR):
//   W1 tenth site     add an `insert into org_stream_credits` to any function                  -> "the insert sites ARE the nine"
//   W2 renamed site   move a site's insert into a differently named function                   -> same test
//   W3 other file     write the table (insert / update / delete) from any other production file -> "no other production file writes"
//   W4 second caller  call refundConsumeForSession a second time, under any alias               -> "one caller, under any alias"
//   W5 re-export      re-export or namespace-access refundConsumeForSession                      -> same test
//   W6 caller guard   call it outside the `refund_credit` branch                                 -> same test
//   W7 second emitter emit { type: "refund_credit" } from another cell                           -> "one emitter"
//   W8 wrong cell     move the emission out of `case "camera_never_live"`                        -> same test
//   W9 scanner        loosen LEDGER_WRITE (drop the quote / schema / newline handling)           -> "the scanners see the evasions"
import { describe, expect, it } from "vitest";
import {
  LEDGER_WRITER_SITES, ledgerWrites, nameUses, parseSource, productionSourceFiles, readSource, refundEmissions,
} from "./_ledger-writer-sites";
import { STREAM_HISTORY_KINDS } from "../stream-credit-history";

const WRITER_FILE = "server/usecases/stream-credits.ts";
const SESSIONS_FILE = "server/usecases/stream-sessions.ts";
const DOMAIN_FILE = "server/relay/domain/session.ts";

describe("the scanners see the evasions (W9) — each run on a synthetic source", () => {
  const writes = (src: string) => ledgerWrites(parseSource("x.ts", src)).map((w) => w.verb);

  it("a ledger write is found however it is spelled — case, newlines, quotes, a schema, update/delete, sql.unsafe, an expression", () => {
    const spellings: [string, string][] = [
      ["tagged template", "const f = () => sql`insert into org_stream_credits (a) values (1)`;"],
      ["upper case", "const f = () => sql`INSERT INTO ORG_STREAM_CREDITS (a) values (1)`;"],
      ["newline between the words", "const f = () => sql`insert\n  into\n   org_stream_credits (a) values (1)`;"],
      ["quoted table", 'const f = () => sql`insert into "org_stream_credits" (a) values (1)`;'],
      ["schema qualified", "const f = () => sql`insert into public.org_stream_credits (a) values (1)`;"],
      ["quoted schema", 'const f = () => sql`insert into "seazn_club"."org_stream_credits" (a) values (1)`;'],
      ["update", "const f = () => sql`update org_stream_credits set delta = 0`;"],
      ["delete", "const f = () => sql`delete from org_stream_credits where true`;"],
      ["truncate", "const f = () => sql`truncate table org_stream_credits`;"],
      ["a plain string handed to unsafe", 'const f = () => sql.unsafe("insert into org_stream_credits (a) values (1)");'],
      ["with a ${} expression in it", "const f = (n: number) => sql`insert into org_stream_credits (a) values (${n})`;"],
      ["inside a CTE", "const f = () => sql`with x as (insert into org_stream_credits (a) values (1) returning id) select * from x`;"],
    ];
    let checked = 0;
    for (const [name, src] of spellings) {
      expect(writes(src), name).toHaveLength(1);
      checked += 1;
    }
    expect(checked, "anti-vacuity: every spelling was judged").toBe(spellings.length);
  });

  it("a READ, a mention in a comment, another table, and a different ledger are not writes", () => {
    const quiet = [
      "const f = () => sql`select * from org_stream_credits where org_id = 1`;",
      "// insert into org_stream_credits is what stream-credits.ts does\nconst f = 1;",
      "/* update org_stream_credits */ const f = 1;",
      "const f = () => sql`insert into staff_audit_log (a) values (1)`;",
      "const f = () => sql`insert into org_credits (a) values (1)`;",
      "const f = () => sql`insert into org_stream_credits_archive (a) values (1)`;".replace("org_stream_credits_archive", "org_stream_credit_notes"),
    ];
    let checked = 0;
    for (const src of quiet) {
      expect(writes(src), src).toEqual([]);
      checked += 1;
    }
    expect(checked).toBe(quiet.length);
  });

  it("the enclosing function is the nearest NAMED one — a callback inside a transaction is not a name", () => {
    const sf = parseSource("x.ts", "export async function outer() { return sql.begin(async (tx) => { await tx`insert into org_stream_credits (a) values (1)`; }); }");
    expect(ledgerWrites(sf).map((w) => w.fn)).toEqual(["outer"]);
    const sf2 = parseSource("x.ts", "const arrow = async () => { await sql`insert into org_stream_credits (a) values (1)`; };");
    expect(ledgerWrites(sf2).map((w) => w.fn)).toEqual(["arrow"]);
  });

  it("a refund-function use is classified however it is imported — aliased, namespaced, re-exported, passed as a value, dynamically keyed", () => {
    const uses = (src: string) => nameUses(parseSource("x.ts", src), "refundConsumeForSession");
    const kinds = (src: string) => uses(src).map((u) => u.kind);
    // the honest shape
    expect(kinds('import { refundConsumeForSession } from "./a"; function g() { if (x) { refundConsumeForSession(1); } }')).toEqual(["import", "call"]);
    // an ALIAS is followed: its calls are calls, its other uses are not
    expect(kinds('import { refundConsumeForSession as r } from "./a"; function g() { r(1); r(2); }')).toEqual(["import", "call", "call"]);
    expect(kinds('import { refundConsumeForSession as r } from "./a"; const keep = r;')).toEqual(["import", "other"]);
    expect(kinds('import { refundConsumeForSession as r } from "./a"; run(r);')).toEqual(["import", "other"]);
    // evasions that name the function without importing it
    expect(kinds('import * as m from "./a"; m.refundConsumeForSession(1);')).toEqual(["other"]);
    expect(kinds('import * as m from "./a"; m["refundConsumeForSession"](1);')).toEqual(["other"]);
    expect(kinds('const { refundConsumeForSession: r } = await import("./a"); r(1);')).toEqual(["other"]);
    expect(kinds('export { refundConsumeForSession } from "./a";')).toEqual(["other"]);
    expect(kinds('export { refundConsumeForSession as other } from "./a";')).toEqual(["other"]);
    // the definition
    expect(kinds("export async function refundConsumeForSession() { return 1; }")).toEqual(["definition"]);
    // the `if` a call sits under is reported
    expect(uses('import { refundConsumeForSession } from "./a"; function g() { if (fx.some((e) => e.type === "refund_credit")) { refundConsumeForSession(1); } }')
      .find((u) => u.kind === "call")?.underIf).toContain('"refund_credit"');
    expect(uses('import { refundConsumeForSession } from "./a"; function g() { refundConsumeForSession(1); }').find((u) => u.kind === "call")?.underIf).toBeNull();
  });

  it("an emission of the refund effect is found with its case — and an event row that merely names the type is not one", () => {
    const sf = parseSource("x.ts", `
      function decide(c) {
        switch (c) {
          case "camera_never_live": { return { effects: [{ type: "refund_credit" }] }; }
          case "other": return { effects: [{ ...base, type: "refund_credit" }] };
        }
        const stray = { type: "refund_credit" };
        recordEvent(tx, { sessionId, type: "refund_credit", result: null });
        recordEvent(tx, { sessionId, orgId, type: "refund_credit" });
        return { effects: [{ type: "consume_credit" }] };
      }`);
    expect(refundEmissions(sf).map((e) => e.caseLabel)).toEqual(['"camera_never_live"', '"other"', null]);
  });
});

describe("the nine ledger writers", () => {
  const writerSource = readSource(WRITER_FILE);
  const found = ledgerWrites(parseSource(WRITER_FILE, writerSource));

  it("the insert sites ARE the nine in the registry — each named, each found once, nothing else (W1, W2)", () => {
    expect(found.length, "anti-vacuity: the scan found the writers at all").toBeGreaterThan(0);
    expect(found.every((w) => w.verb === "insert into"), "stream-credits.ts only INSERTS: the ledger is append-only").toBe(true);
    const claimed = new Map<string, number>();
    const unaccounted: string[] = [];
    for (const w of found) {
      const hits = LEDGER_WRITER_SITES.filter((s) => s.fn === w.fn && w.raw.includes(s.needle));
      if (hits.length !== 1) unaccounted.push(`${WRITER_FILE}:${w.line} in ${w.fn}() matches ${hits.length} registry sites`);
      for (const h of hits) claimed.set(h.key, (claimed.get(h.key) ?? 0) + 1);
    }
    expect(unaccounted, "an insert site the registry does not name exactly once").toEqual([]);
    expect([...claimed.entries()].filter(([, n]) => n !== 1), "a registry site found more than once").toEqual([]);
    expect([...claimed.keys()].sort(), "a registry site no insert matches").toEqual(LEDGER_WRITER_SITES.map((s) => s.key).sort());
    expect(found, "nine statements write the ledger").toHaveLength(9);
    expect(LEDGER_WRITER_SITES).toHaveLength(9);
  });

  it("the registry's own keys, functions and needles are distinct — a site cannot hide behind another's name", () => {
    expect(new Set(LEDGER_WRITER_SITES.map((s) => s.key)).size).toBe(LEDGER_WRITER_SITES.length);
    const pairs = LEDGER_WRITER_SITES.map((s) => `${s.fn}|${s.needle}`);
    expect(new Set(pairs).size).toBe(pairs.length);
    // within one function, no needle contains another's (the sites of rollMonthlyLocked tell apart)
    for (const a of LEDGER_WRITER_SITES) {
      for (const b of LEDGER_WRITER_SITES) {
        if (a !== b && a.fn === b.fn) expect(a.needle.includes(b.needle) || b.needle.includes(a.needle), `${a.key} / ${b.key}`).toBe(false);
      }
    }
  });

  it("no other production file writes the table — insert, update, delete, truncate, merge or copy (W3)", () => {
    const files = productionSourceFiles();
    expect(files.length, "the scan walked the source tree").toBeGreaterThan(200);
    expect(files, "…and it included the writer").toContain(WRITER_FILE);
    const strangers: string[] = [];
    let scanned = 0;
    for (const f of files) {
      if (f === WRITER_FILE) continue;
      scanned += 1;
      for (const w of ledgerWrites(parseSource(f, readSource(f)))) strangers.push(`${f}:${w.line} ${w.verb} in ${w.fn}()`);
    }
    expect(scanned).toBe(files.length - 1);
    expect(strangers).toEqual([]);
  });

  it("every history kind but `other` is some writer's, and every writer's kinds are real — no kind is orphaned, none invented", () => {
    const declared = new Set<string>(STREAM_HISTORY_KINDS);
    const written = new Set<string>(LEDGER_WRITER_SITES.flatMap((s) => s.kinds));
    for (const k of written) expect(declared.has(k), `registry names kind ${k}`).toBe(true);
    expect([...declared].filter((k) => k !== "other" && !written.has(k)), "a kind no writer produces").toEqual([]);
    expect(written.has("other"), "no writer is expected to land on the unmapped door").toBe(false);
  });
});

describe("what \"Refund: camera never connected\" means, pinned at the domain and at the one handler", () => {
  const files = productionSourceFiles();

  it("one emitter: { type: \"refund_credit\" } is built in exactly one place — the camera_never_live cell of the domain (W7, W8)", () => {
    const emissions: { file: string; caseLabel: string | null; line: number }[] = [];
    for (const f of files) {
      const text = readSource(f);
      if (!text.includes("refund_credit")) continue;
      for (const e of refundEmissions(parseSource(f, text))) emissions.push({ file: f, ...e });
    }
    expect(emissions.map((e) => `${e.file} case ${e.caseLabel}`)).toEqual([`${DOMAIN_FILE} case "camera_never_live"`]);
  });

  it("one caller, under any alias: refundConsumeForSession is imported by the use-case alone, called once, under the refund_credit branch (W4, W5, W6)", () => {
    const report: Record<string, string[]> = {};
    let scanned = 0;
    for (const f of files) {
      const text = readSource(f);
      scanned += 1;
      if (!text.includes("refundConsumeForSession")) continue;
      const used = nameUses(parseSource(f, text), "refundConsumeForSession").map((u) => `${u.kind}${u.local && u.local !== "refundConsumeForSession" ? `(as ${u.local})` : ""}`);
      if (used.length > 0) report[f] = used;   // a mention in a comment is not a use (the parser sees no node)
    }
    expect(scanned, "the scan walked the source tree").toBe(files.length);
    // the definition (the writer), and the one importer
    expect(Object.keys(report).sort()).toEqual([WRITER_FILE, SESSIONS_FILE].sort());
    expect(report[WRITER_FILE], "the writer defines it and uses it nowhere itself").toEqual(["definition"]);
    const uses = nameUses(parseSource(SESSIONS_FILE, readSource(SESSIONS_FILE)), "refundConsumeForSession");
    expect(uses.filter((u) => u.kind === "import"), "one import").toHaveLength(1);
    expect(uses.filter((u) => u.kind === "other"), "no re-export, no namespace or dynamic access, no use as a value").toEqual([]);
    const calls = uses.filter((u) => u.kind === "call");
    expect(calls, "one call").toHaveLength(1);
    expect(calls[0]!.underIf, "…under the effect handler's own condition").toMatch(/\.some\(\(\w+\)\s*=>\s*\w+\.type\s*===\s*"refund_credit"\)/);
  });
});
