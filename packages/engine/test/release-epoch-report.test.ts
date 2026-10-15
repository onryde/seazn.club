// A release's engine-epoch report (packages/engine/scripts/release-epoch-report.ts): which sports a production release will lock out for
// older capture apps. The RULE is tested here as the pure function it is, over every sport of the registry; the loader of a table's source
// is exercised in-process on small sources; the CLI around them (git, refs, exit codes, the step summary) is spawned against real git
// history in release-epoch-report-cli.test.ts, and prod.yml's step in scripts/__tests__/prod-release-epoch-workflow.test.ts.
//
// Expected values come from the engine's own declarations (the real FOLD_EPOCH, the registry) and from the wording the owner approved on
// 2026-10-15, never from the report under test. Every sweep reports how many sports it visited and zero is a failure (TEST-STRATEGY 2).
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  annotationData,
  readTables,
  reportEpochChanges,
  summaryMarkdown,
  type Report,
  type ReportStatus,
  type SideRead,
} from "../scripts/release-epoch-report.ts";
import { FOLD_EPOCH } from "../src/sport/fold-epoch.ts";
import { builtinModules } from "../src/sports/index.ts";
import { forEachSport } from "../src/testkit/for-each-sport.ts";

const REFS = { from: "v1.0.7-beta", to: "v1.0.8-beta" } as const;
const table = (epochs: Record<string, number>, minors: Record<string, number> | null = null): SideRead => ({ kind: "table", tables: { epochs, minors } });
/** The real table, as a fresh mutable copy. */
const real = (): Record<string, number> => ({ ...FOLD_EPOCH });
const BASE = table(real());
const run = (from: SideRead, to: SideRead): Report => reportEpochChanges(from, to, REFS);
/** The line the owner approved for a raised epoch (2026-10-15). */
const raisedLine = (sport: string, a: number, b: number): string =>
  `${sport}: FOLD_EPOCH ${a} -> ${b} — capture apps older than this engine will be refused for ${sport} (426 ENGINE_OUTDATED)`;
const minorLine = (sport: string, a: number, b: number): string =>
  `${sport}: FOLD_MINOR ${a} -> ${b} — no app update needed (older capture apps are not refused for a minor change)`;
const withEpoch = (over: Record<string, number>): Record<string, number> => ({ ...real(), ...over });
const KEYS = Object.keys(FOLD_EPOCH);

describe("release-epoch-report: the fixture is the real registry's", () => {
  it("every registered sport has a FOLD_EPOCH entry, and the table names no other (a sweep over a different set would test nothing real)", () => {
    const visited = forEachSport(({ key }) => {
      expect(Object.hasOwn(FOLD_EPOCH, key), `FOLD_EPOCH.${key}`).toBe(true);
    });
    expect(visited).toBe(builtinModules.length);
    expect(KEYS.length).toBe(builtinModules.length);
    expect(KEYS.length).toBeGreaterThan(1);
  });
});

describe("release-epoch-report: nothing raised", () => {
  it("an unchanged table reports the number of sports compared and no sport locked out", () => {
    const r = run(BASE, BASE);
    expect(r.status).toBe("compared");
    expect(r.compared).toBe(KEYS.length);
    expect(r.raised).toEqual([]);
    expect(r.lowered).toEqual([]);
    expect(r.added).toEqual([]);
    expect(r.removed).toEqual([]);
    expect(r.minor).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.lines).toEqual([`${KEYS.length} sport(s) compared between ${REFS.from} and ${REFS.to}: 0 FOLD_EPOCH raised, 0 lowered, 0 FOLD_MINOR changed, 0 added, 0 removed`]);
  });

  it("every sport is compared, and the same epoch is never a bump (the comparison is strict)", () => {
    const visited = forEachSport(({ key }) => {
      const same = run(table(withEpoch({ [key]: 4 })), table(withEpoch({ [key]: 4 })));
      expect(same.raised, `${key}: 4 -> 4`).toEqual([]);
      expect(same.compared).toBe(KEYS.length);
    });
    expect(visited).toBe(builtinModules.length);
  });
});

describe("release-epoch-report: a raised epoch locks out older capture apps", () => {
  it("names exactly the one sport whose epoch rose, whichever sport it is (the registry swept)", () => {
    const visited = forEachSport(({ key }) => {
      const r = run(BASE, table(withEpoch({ [key]: 2 })));
      expect(r.status, key).toBe("compared");
      expect(r.raised, key).toEqual([{ sport: key, from: 1, to: 2 }]);
      expect(r.lowered, key).toEqual([]);
      expect(r.compared, key).toBe(KEYS.length);
      expect(r.lines[0], key).toBe(raisedLine(key, 1, 2));
      expect(r.warnings, key).toEqual([raisedLine(key, 1, 2)]);
    });
    expect(visited).toBe(builtinModules.length);
  });

  it("reports the from and to numbers it was given, not a step of one (1 -> 3, and 5 -> 6)", () => {
    expect(run(BASE, table(withEpoch({ football: 3 }))).lines[0]).toBe(raisedLine("football", 1, 3));
    expect(run(table(withEpoch({ tennis: 5 })), table(withEpoch({ tennis: 6 }))).lines[0]).toBe(raisedLine("tennis", 5, 6));
  });

  it("names every sport that rose, in alphabetical order whatever order either table lists them (the registry's own order is wave order)", () => {
    // tennis is listed BEFORE badminton on both sides, and the real table lists them the other way round
    const first = (epochs: Record<string, number>): Record<string, number> => ({ tennis: epochs.tennis!, badminton: epochs.badminton!, ...epochs });
    const r = run(table(first(real())), table(first(withEpoch({ tennis: 2, badminton: 2 }))));
    expect(Object.keys(first(real()))[0]).toBe("tennis");
    expect(r.raised.map((c) => c.sport)).toEqual(["badminton", "tennis"]);
    expect(r.lines.slice(0, 2)).toEqual([raisedLine("badminton", 1, 2), raisedLine("tennis", 1, 2)]);
    expect(r.warnings).toEqual([raisedLine("badminton", 1, 2), raisedLine("tennis", 1, 2)]);
    expect(r.lines.at(-1)).toContain("2 FOLD_EPOCH raised");
    // a sport that did not move is not named
    expect(r.lines.join("\n")).not.toContain("football:");
  });

  it("a rise in one sport leaves every other sport's line out, and a rise elsewhere does not hide it", () => {
    const r = run(table(withEpoch({ hockey: 2 })), table(withEpoch({ hockey: 2, icehockey: 2 })));
    expect(r.raised).toEqual([{ sport: "icehockey", from: 1, to: 2 }]);
    expect(r.lines).toHaveLength(2); // the one line and the tally
  });

  it("an epoch that FELL is reported as lowered and warned about, never as raised", () => {
    const r = run(table(withEpoch({ cricket: 3 })), table(withEpoch({ cricket: 2 })));
    expect(r.raised).toEqual([]);
    expect(r.lowered).toEqual([{ sport: "cricket", from: 3, to: 2 }]);
    expect(r.lines[0]).toBe("cricket: FOLD_EPOCH 3 -> 2 — LOWERED; an epoch only rises (fold-epoch:check refuses this)");
    expect(r.warnings).toEqual([r.lines[0]]);
    expect(r.lines.at(-1)).toContain("0 FOLD_EPOCH raised, 1 lowered");
  });
});

describe("release-epoch-report: sports added and removed", () => {
  it("lists a sport added at the target with its epoch, and does not warn", () => {
    const r = run(BASE, table({ ...real(), curling: 1 }));
    expect(r.added).toEqual([{ sport: "curling", epoch: 1 }]);
    expect(r.removed).toEqual([]);
    expect(r.lines[0]).toBe("curling: sport added (FOLD_EPOCH 1)");
    expect(r.compared).toBe(KEYS.length); // the new sport is not compared with anything
    expect(r.warnings).toEqual([]);
  });

  it("lists a sport removed at the target with the epoch it had, every sport swept", () => {
    const visited = forEachSport(({ key }) => {
      const without = real();
      delete without[key];
      const r = run(BASE, table(without));
      expect(r.removed, key).toEqual([{ sport: key, epoch: 1 }]);
      expect(r.added, key).toEqual([]);
      expect(r.lines[0], key).toBe(`${key}: sport removed (was FOLD_EPOCH 1)`);
      expect(r.compared, key).toBe(KEYS.length - 1);
      expect(r.status, key).toBe("compared");
    });
    expect(visited).toBe(builtinModules.length);
  });

  it("reports an addition, a removal and a rise together, each under its own count", () => {
    const to = withEpoch({ volleyball: 2, curling: 1 });
    delete to.carrom;
    const r = run(BASE, table(to));
    expect(r.raised.map((c) => c.sport)).toEqual(["volleyball"]);
    expect(r.added.map((a) => a.sport)).toEqual(["curling"]);
    expect(r.removed.map((a) => a.sport)).toEqual(["carrom"]);
    expect(r.lines.at(-1)).toBe(`${KEYS.length - 1} sport(s) compared between ${REFS.from} and ${REFS.to}: 1 FOLD_EPOCH raised, 0 lowered, 0 FOLD_MINOR changed, 1 added, 1 removed`);
  });

  it("looks a sport up by its OWN key: Object.prototype names are not sports present on the other side", () => {
    // a plain `table[name]` answers "constructor" with a function, which is neither undefined nor a number
    const only = (names: string[]) => table(Object.fromEntries(names.map((n) => [n, 1])));
    const r = run(only(["constructor", "football"]), only(["toString", "football"]));
    expect(r.removed).toEqual([{ sport: "constructor", epoch: 1 }]);
    expect(r.added).toEqual([{ sport: "toString", epoch: 1 }]);
    expect(r.compared).toBe(1);
    expect(r.raised).toEqual([]);
    expect(r.lowered).toEqual([]);
  });
});

describe("release-epoch-report: FOLD_MINOR is information, never a lock-out", () => {
  it("a minor-only change is listed as 'no app update needed' and is not a warning", () => {
    const r = run(table(real(), { football: 0 }), table(real(), { football: 1 }));
    expect(r.status).toBe("compared");
    expect(r.raised).toEqual([]);
    expect(r.minor).toEqual([{ sport: "football", from: 0, to: 1 }]);
    expect(r.lines[0]).toBe(minorLine("football", 0, 1));
    expect(r.warnings).toEqual([]);
    expect(r.lines.at(-1)).toContain("0 FOLD_EPOCH raised, 0 lowered, 1 FOLD_MINOR changed");
  });

  it("a sport absent from a table that declares FOLD_MINOR has minor 0 (the guard's reading of a table before FOLD_MINOR)", () => {
    const r = run(table(real(), {}), table(real(), { tennis: 2 }));
    expect(r.minor).toEqual([{ sport: "tennis", from: 0, to: 2 }]);
  });

  it("FOLD_MINOR at the target only reads the baseline's minors as 0", () => {
    const r = run(BASE, table(real(), { badminton: 3, football: 0 }));
    expect(r.minor).toEqual([{ sport: "badminton", from: 0, to: 3 }]);
    expect(r.lines[0]).toBe(minorLine("badminton", 0, 3));
  });

  it("FOLD_MINOR at the baseline only reads the target's minors as 0", () => {
    const r = run(table(real(), { hockey: 4 }), BASE);
    expect(r.minor).toEqual([{ sport: "hockey", from: 4, to: 0 }]);
  });

  it("FOLD_MINOR at neither ref reports no minor change, and the same minors at both report none either", () => {
    expect(run(BASE, BASE).minor).toEqual([]);
    expect(run(table(real(), { football: 2 }), table(real(), { football: 2 })).minor).toEqual([]);
  });

  it("a major rise and a minor change in the same sport are both reported, the warning only for the major", () => {
    const r = run(table(real(), { icehockey: 1 }), table(withEpoch({ icehockey: 2 }), { icehockey: 0 }));
    expect(r.raised).toEqual([{ sport: "icehockey", from: 1, to: 2 }]);
    expect(r.minor).toEqual([{ sport: "icehockey", from: 1, to: 0 }]);
    expect(r.warnings).toEqual([raisedLine("icehockey", 1, 2)]);
  });

  it("does not report a minor for a sport that is only on one side", () => {
    const to = real();
    delete to.generic;
    const r = run(table(real(), { generic: 5 }), table(to, {}));
    expect(r.minor).toEqual([]);
    expect(r.removed).toEqual([{ sport: "generic", epoch: 1 }]);
  });
});

describe("release-epoch-report: when nothing can be compared, it says so and distinguishes why", () => {
  it("a baseline without the table is one line, no warning, and the status says no baseline", () => {
    const r = run({ kind: "absent" }, BASE);
    expect(r.status).toBe("no-baseline");
    expect(r.lines).toEqual([`no FOLD_EPOCH at ${REFS.from}; nothing to compare`]);
    expect(r.warnings).toEqual([]);
    expect(r.compared).toBe(0);
    expect(r.raised).toEqual([]);
  });

  it("the baseline is judged first: a missing baseline wins over a broken target", () => {
    expect(run({ kind: "absent" }, { kind: "unparseable", reason: "x" }).status).toBe("no-baseline");
    expect(run({ kind: "unparseable", reason: "x" }, { kind: "absent" }).status).toBe("unparseable");
  });

  it("a target without the table is its own status, and a warning (a release that drops every epoch is not silent)", () => {
    const r = run(BASE, { kind: "absent" });
    expect(r.status).toBe("no-target");
    expect(r.lines).toEqual([`no FOLD_EPOCH at ${REFS.to}; nothing to compare`]);
    expect(r.warnings).toEqual(r.lines);
  });

  it("a table that cannot be parsed is a warning naming the ref and the reason, on either side, and its own status", () => {
    const bad: SideRead = { kind: "unparseable", reason: "FOLD_EPOCH.football is 0" };
    const onBaseline = run(bad, BASE);
    expect(onBaseline.status).toBe("unparseable");
    expect(onBaseline.lines).toEqual([`FOLD_EPOCH at ${REFS.from} could not be parsed (FOLD_EPOCH.football is 0); nothing to compare`]);
    expect(onBaseline.warnings).toEqual(onBaseline.lines);
    const onTarget = run(BASE, bad);
    expect(onTarget.status).toBe("unparseable");
    expect(onTarget.lines).toEqual([`FOLD_EPOCH at ${REFS.to} could not be parsed (FOLD_EPOCH.football is 0); nothing to compare`]);
    expect(onTarget.warnings).toEqual(onTarget.lines);
    expect(onTarget.compared).toBe(0);
  });

  it("a ref git cannot read is a warning naming the ref and the reason, on either side, and its own status", () => {
    const bad: SideRead = { kind: "unreadable", reason: "not a commit" };
    const onBaseline = run(bad, BASE);
    expect(onBaseline.status).toBe("unreadable");
    expect(onBaseline.lines).toEqual([`could not read FOLD_EPOCH at ${REFS.from}: not a commit; nothing to compare`]);
    expect(onBaseline.warnings).toEqual(onBaseline.lines);
    expect(run(BASE, bad).lines).toEqual([`could not read FOLD_EPOCH at ${REFS.to}: not a commit; nothing to compare`]);
  });

  it("two tables with no sport in common compared NOTHING, which is a failure status and a warning, not a clean pass", () => {
    const r = run(table({ football: 1 }), table({ curling: 1 }));
    expect(r.status).toBe("nothing-compared");
    expect(r.compared).toBe(0);
    expect(r.lines).toContain(`no sport appears in FOLD_EPOCH at both ${REFS.from} and ${REFS.to}; nothing to compare`);
    expect(r.warnings).toEqual([`no sport appears in FOLD_EPOCH at both ${REFS.from} and ${REFS.to}; nothing to compare`]);
    // what it did see is still listed
    expect(r.added).toEqual([{ sport: "curling", epoch: 1 }]);
    expect(r.removed).toEqual([{ sport: "football", epoch: 1 }]);
  });

  it("two empty tables compared nothing either (the empty case answers 'nothing compared', not 'no change')", () => {
    const r = run(table({}), table({}));
    expect(r.status).toBe("nothing-compared");
    expect(r.compared).toBe(0);
    expect(r.warnings).toHaveLength(1);
  });

  it("the six statuses are six different values, and only a comparison that compared something is 'compared'", () => {
    const seen = new Map<ReportStatus, number>();
    const note = (r: Report) => seen.set(r.status, (seen.get(r.status) ?? 0) + 1);
    note(run(BASE, BASE));
    note(run({ kind: "absent" }, BASE));
    note(run(BASE, { kind: "absent" }));
    note(run({ kind: "unreadable", reason: "r" }, BASE));
    note(run({ kind: "unparseable", reason: "r" }, BASE));
    note(run(table({}), table({})));
    expect([...seen.keys()].sort()).toEqual(["compared", "no-baseline", "no-target", "nothing-compared", "unparseable", "unreadable"]);
    for (const [, n] of seen) expect(n).toBe(1);
  });
});

describe("release-epoch-report: what is written for GitHub", () => {
  it("escapes a workflow command's data: percent, carriage return and newline", () => {
    expect(annotationData("a%b\r\nc")).toBe("a%25b%0D%0Ac");
    expect(annotationData("plain — text -> ok")).toBe("plain — text -> ok");
  });

  it("the step summary is a heading naming both refs and one bullet per report line", () => {
    const md = summaryMarkdown(run(BASE, table(withEpoch({ football: 2 }))), REFS);
    const lines = md.split("\n");
    expect(lines[0]).toBe(`### Engine fold epoch: ${REFS.from} -> ${REFS.to}`);
    expect(lines[1]).toBe("");
    expect(lines[2]).toBe(`- ${raisedLine("football", 1, 2)}`);
    expect(lines[3]).toMatch(/^- \d+ sport\(s\) compared between /);
    expect(md.endsWith("\n")).toBe(true);
  });

  it("the step summary is escaped as HTML, since a ref name or an error message is arbitrary text", () => {
    const md = summaryMarkdown(run({ kind: "unparseable", reason: "<script>&x" }, BASE), { from: "a<b", to: "c" });
    expect(md).toContain("a&lt;b");
    expect(md).toContain("(&lt;script>&amp;x)");
    expect(md).not.toContain("<script");
    expect(md).not.toContain("a<b");
  });
});

describe("release-epoch-report: reading a table's source", () => {
  let scratch = "";
  beforeEach(() => { scratch = mkdtempSync(join(tmpdir(), "release-epoch-report-test-")); });
  afterEach(() => { rmSync(scratch, { recursive: true, force: true }); });
  const kindOf = async (source: string) => (await readTables(source)).kind;
  const reasonOf = async (source: string): Promise<string> => {
    const side = await readTables(source);
    if (side.kind !== "unparseable") throw new Error(`expected unparseable, got ${side.kind}`);
    return side.reason;
  };

  it("reads a table written the way src/sport/fold-epoch.ts writes it (frozen, `as const satisfies`), and no FOLD_MINOR is null minors", async () => {
    const side = await readTables(`export const FOLD_EPOCH = Object.freeze({ football: 1, cricket: 2 } as const satisfies Readonly<Record<string, number>>);\nexport type T = keyof typeof FOLD_EPOCH;\n`);
    expect(side).toEqual({ kind: "table", tables: { epochs: { football: 1, cricket: 2 }, minors: null } });
  });

  it("reads the real table: one epoch per registered sport", async () => {
    const side = await readTables(readFileSync(new URL("../src/sport/fold-epoch.ts", import.meta.url), "utf8"));
    expect(side.kind).toBe("table");
    if (side.kind !== "table") return;
    expect(Object.keys(side.tables.epochs).sort()).toEqual([...KEYS].sort());
    for (const k of KEYS) expect(side.tables.epochs[k], k).toBe((FOLD_EPOCH as Record<string, number>)[k]);
    expect(KEYS.length).toBe(builtinModules.length);
  });

  it("reads FOLD_MINOR when the file declares one, with 0 a valid minor", async () => {
    const side = await readTables(`export const FOLD_EPOCH = { a: 1, b: 1 };\nexport const FOLD_MINOR = { a: 0, b: 3 };\n`);
    expect(side).toEqual({ kind: "table", tables: { epochs: { a: 1, b: 1 }, minors: { a: 0, b: 3 } } });
  });

  it("a source that does not load is unparseable, with the reason, in one line", async () => {
    const r = await reasonOf(`export const FOLD_EPOCH = {{{ \n second line`);
    expect(r).toMatch(/^does not load: /);
    expect(r).not.toContain("\n");
  });

  it("a source whose relative import cannot resolve is unparseable (the table must import nothing)", async () => {
    expect(await reasonOf(`import { x } from "./nowhere.ts";\nexport const FOLD_EPOCH = { a: x };\n`)).toMatch(/^does not load: /);
  });

  it("a file with no FOLD_EPOCH object export is unparseable", async () => {
    expect(await reasonOf(`export const OTHER = { a: 1 };\n`)).toBe("it has no FOLD_EPOCH object export");
    expect(await reasonOf(`export const FOLD_EPOCH = [1, 2];\n`)).toBe("it has no FOLD_EPOCH object export");
    expect(await reasonOf(`export const FOLD_EPOCH = null;\n`)).toBe("it has no FOLD_EPOCH object export");
    expect(await reasonOf(`export const FOLD_EPOCH = 3;\n`)).toBe("it has no FOLD_EPOCH object export");
  });

  it("a table that declares no sport is unparseable: an empty table guards nothing", async () => {
    expect(await reasonOf(`export const FOLD_EPOCH = {};\n`)).toBe("it declares no sport");
  });

  it("an epoch that is not a positive integer is unparseable, naming the sport and the value", async () => {
    for (const bad of ["0", "-1", "1.5", "NaN", "Infinity", '"1"', "null", "true"]) {
      expect(await reasonOf(`export const FOLD_EPOCH = { football: 1, tennis: ${bad} };\n`), bad).toBe(`FOLD_EPOCH.tennis is ${bad}, and an epoch is a positive integer`);
    }
  });

  it("a FOLD_MINOR that is not an object of non-negative integers is unparseable, naming the sport and the value", async () => {
    for (const bad of ["null", "[]", "3", '"x"']) {
      expect(await reasonOf(`export const FOLD_EPOCH = { a: 1 };\nexport const FOLD_MINOR = ${bad};\n`), bad).toBe("FOLD_MINOR is not an object");
    }
    for (const bad of ["-1", "1.5", "NaN", '"0"', "undefined"]) {
      expect(await reasonOf(`export const FOLD_EPOCH = { a: 1 };\nexport const FOLD_MINOR = { a: ${bad} };\n`), bad).toMatch(/^FOLD_MINOR\.a is .*, and a minor is a non-negative integer$/);
    }
  });

  it("never throws for a source it cannot read, and it leaves no temporary directory behind", async () => {
    const before = process.env.TMPDIR;
    const tmp = join(scratch, "tmp");
    mkdirSync(tmp);
    process.env.TMPDIR = tmp;
    try {
      expect(await kindOf(`export const FOLD_EPOCH = { a: 1 };\n`)).toBe("table");
      expect(await kindOf(`export const FOLD_EPOCH = ;\n`)).toBe("unparseable");
      expect(readdirSync(tmp)).toEqual([]);
    } finally {
      if (before === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = before;
    }
  });
});
