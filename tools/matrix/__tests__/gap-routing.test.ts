// W1d Task 19 (ruling 63, D18): design §8's routing, transcribed id by id into catalogue/gap-routing.json, held against the design.
//
// The triage keys a red to a gap and the gap to the wave design §8 gives it; the ledger holds every verdict to the same route. A
// route nobody can check against the design is a typed table, so each route here carries its basis (a design line) and THIS file
// re-derives every wave from the design's own text — the table rows' wave cells and the ids their Carries cells name, with the
// shorthand §8 uses expanded (`SC-O1/SC-O2`, `ST-G3/G4/G5`, `FX-G8–G11`, the wildcards `SW-*`, `SH-*`, `SC-S*`) — and compares.
// Nothing here reads an expected value from the routing file or from triage.ts: the design file and the five audit files are the
// two oracles, and the counts (104 listed, 48 not) are hand-counted from the design's table, pinned beside the derived ones.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { AUDIT_DIR, readAudit } from "../lib/audit-ledger.ts";
import { CATALOGUE_DIR, loadCatalogue, routeOf, type GapRouting } from "../lib/triage.ts";
import { REPO } from "./committed-plans.ts";

const DESIGN = resolve(REPO, "docs/superpowers/specs/2026-09-27-format-matrix-design.md");

interface DesignRow { line: number; wave: string; text: string; carries: string }

/** The rows of design §8's table: the 1-based line, the wave of the first cell, the whole line, and the Carries cell. */
function designRows(file: string): DesignRow[] {
  const lines = readFileSync(file, "utf8").split("\n");
  const start = lines.findIndex((l) => /^## 8\. Waves\s*$/.test(l));
  expect(start, "design §8 heading").toBeGreaterThan(0);
  const rows: DesignRow[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i]!)) break;
    const m = /^\| \*\*(W\d+[a-z]?)\b/.exec(lines[i]!);
    if (m === null) continue;
    const cells = lines[i]!.split("|").slice(1, -1).map((c) => c.trim());
    expect(cells, `design line ${i + 1}: a wave row is wave | scope | carries`).toHaveLength(3);
    rows.push({ line: i + 1, wave: m[1]!, text: lines[i]!, carries: cells[2]! });
  }
  return rows;
}

const ID_TOKEN = /\b(SC|ST|FX|SW|SH)-([A-Z]?)(?:(\d+)(?:–[A-Z]?(\d+))?|\*)((?:\/(?:(?:SC|ST|FX|SW|SH)-)?[A-Z]\d+)*)/g;

/** The ids a Carries cell names: plain ids, ranges (`FX-G8–G11`), slash lists (`SC-O1/SC-O2`, `ST-G3/G4/G5`) as exact ids, and the
 *  wildcards (`SW-*`, `SC-S*`) as prefixes. A bare `H1`/`O8` with no prefix names nothing the audit can hold: it is not read. */
function named(carries: string): { exact: Set<string>; prefixes: Set<string> } {
  const exact = new Set<string>();
  const prefixes = new Set<string>();
  for (const m of carries.matchAll(ID_TOKEN)) {
    const [, prefix, letter, from, to, tail] = m;
    if (from === undefined) prefixes.add(`${prefix}-${letter}`);
    else for (let n = Number(from); n <= Number(to ?? from); n++) exact.add(`${prefix}-${letter}${n}`);
    for (const t of (tail ?? "").split("/").filter((x) => x !== "")) {
      const mm = /^(?:(SC|ST|FX|SW|SH)-)?([A-Z])(\d+)$/.exec(t)!;
      exact.add(`${mm[1] ?? prefix}-${mm[2]}${mm[3]}`);
    }
  }
  return { exact, prefixes };
}

describe("design §8's routing (D:446-460), the committed gap-routing.json against the design's own text", () => {
  let rows: DesignRow[];
  let routing: GapRouting;
  let universe: string[];
  /** id -> the design row that lists it: by name or by a wildcard prefix. */
  let owner: Map<string, DesignRow>;
  /** The design tokens as the oracle read them, per row. */
  let tokens: Map<number, ReturnType<typeof named>>;

  beforeAll(() => {
    rows = designRows(DESIGN);
    routing = loadCatalogue(CATALOGUE_DIR).routing;
    const audit = readAudit(AUDIT_DIR);
    universe = [...audit.gaps, ...audit.umbrellas].map((g) => g.id);
    tokens = new Map(rows.map((r) => [r.line, named(r.carries)]));
    owner = new Map();
    for (const r of rows) {
      const t = tokens.get(r.line)!;
      for (const u of universe) {
        if (!t.exact.has(u) && ![...t.prefixes].some((p) => u.startsWith(p))) continue;
        const had = owner.get(u);
        // §8: "Each gap has exactly one owning wave" — an id two rows list under different waves is a design defect to report.
        expect(had === undefined || had.wave === r.wave, `${u} is listed by design line ${had?.line} (${had?.wave}) and ${r.line} (${r.wave})`).toBe(true);
        owner.set(u, had ?? r);
      }
    }
  });

  it("the design's table parses to its thirteen wave rows on the lines the brief cites, and the audit holds 152 rows (150 ids + SC's two umbrellas)", () => {
    expect(rows.map((r) => r.wave)).toEqual(["W1a", "W1b", "W1c", "W1d", "W2", "W3", "W4", "W5", "W6", "W7", "W8", "W9", "W10"]);
    expect(rows.map((r) => r.line)).toEqual([448, 449, 450, 451, 452, 453, 454, 455, 456, 457, 458, 459, 460]);
    expect(universe).toHaveLength(152);
  });

  it("the oracle reads the design's shorthand: each expansion is one hand-checked row", () => {
    const at = (line: number): ReturnType<typeof named> => tokens.get(line)!;
    // W2 (452): ranges and slash lists and a wildcard.
    expect(at(452).exact.has("SC-O1") && at(452).exact.has("SC-O2")).toBe(true);
    expect(at(452).prefixes).toEqual(new Set(["SC-S"]));
    expect([...at(452).exact].filter((id) => id.startsWith("SC-X")).sort()).toEqual(["SC-X1", "SC-X2", "SC-X3", "SC-X4"]);
    // W5 (455): the slash list names ten ST ids, with bare `G4` inheriting its prefix.
    expect([...at(455).exact].filter((id) => id.startsWith("ST-")).sort()).toEqual(["ST-G13", "ST-G14", "ST-G15", "ST-G20", "ST-G23", "ST-G24", "ST-G3", "ST-G4", "ST-G5", "ST-G6"]);
    // W7 (457): `FX-G8–G11` is four ids and `FX-G6` one.
    expect([...at(457).exact].sort()).toEqual(["FX-G10", "FX-G11", "FX-G6", "FX-G8", "FX-G9"]);
    // W3 (453): `SC-O7/SW-M8` crosses prefixes; `SW-*` is the wildcard.
    expect(at(453).exact.has("SC-O7") && at(453).exact.has("SW-M8")).toBe(true);
    expect(at(453).prefixes).toEqual(new Set(["SW-"]));
    expect(at(458).prefixes).toEqual(new Set(["SH-"]));
    expect(at(460).exact).toEqual(new Set(["ST-G22"]));
  });

  it("the design lists 104 audit rows by name or wildcard and leaves 48 to 'the wave owning their format/sport' (hand-counted from the table, then derived)", () => {
    // SC 22 (X1-X4, P1 P2 P4 P11, S1-S9, C3, O1 O2 O8 under W2; O7 under W3) + FX 15 + ST 18 + SW 29 + SH 20 = 104.
    const byPrefix = (p: string): number => [...owner.keys()].filter((id) => id.startsWith(`${p}-`)).length;
    expect({ SC: byPrefix("SC"), FX: byPrefix("FX"), ST: byPrefix("ST"), SW: byPrefix("SW"), SH: byPrefix("SH") }).toEqual({ SC: 22, FX: 15, ST: 18, SW: 29, SH: 20 });
    expect(owner.size).toBe(104);
    expect(universe.length - owner.size).toBe(48);
  });

  it("every route carries a basis, and every basis a route (the committed file is fully cited)", () => {
    expect(routing.basis, "gap-routing.json has a basis map").toBeDefined();
    expect(Object.keys(routing.basis!).sort()).toEqual(Object.keys(routing.routes).sort());
    expect(Object.keys(routing.routes)).toHaveLength(109);
  });

  it("each route re-derives from the design: a D:<line> basis is a row that LISTS the id at the route's wave; a scope basis is the row whose wave scope names the word, for an id the design does not list", () => {
    const basis = routing.basis!;
    let listed = 0;
    let scoped = 0;
    for (const [key, wave] of Object.entries(routing.routes)) {
      const b = basis[key]!;
      const d = /^D:(\d+)$/.exec(b);
      const s = /^scope:D:(\d+):(.+)$/.exec(b);
      expect(d !== null || s !== null, `${key}: ${b}`).toBe(true);
      const line = Number((d ?? s)![1]);
      const row = rows.find((r) => r.line === line);
      expect(row, `${key}: design line ${line} is no wave row`).toBeDefined();
      expect(row!.wave, `${key} is ${wave}, design line ${line} is ${row!.wave}`).toBe(wave);
      if (d !== null) {
        const t = tokens.get(line)!;
        const wild = key.endsWith("-*");
        // a wildcard key is a wildcard token of that row; an exact key is an exact id that row names
        // …and an exact key under a letter-narrowed wildcard (`SC-S*`) is covered by it: §8 lists those members by that token
        const partial = [...t.prefixes].some((p) => p.length > 3 && key.startsWith(p));
        expect(wild ? t.prefixes.has(key.slice(0, -1)) : t.exact.has(key) || partial, `${key} is not named on design line ${line}`).toBe(true);
        listed++;
      } else {
        const word = s![2]!;
        expect(row!.text.toLowerCase(), `${key}: design line ${line} never says "${word}"`).toContain(word.toLowerCase());
        expect(key.endsWith("-*"), `${key}: a scope basis is for one gap, not a wildcard`).toBe(false);
        expect(owner.has(key), `${key} IS listed by the design (line ${owner.get(key)?.line}): cite the line, not a scope`).toBe(false);
        scoped++;
      }
    }
    // 59 exact ids the design names (SC 22, FX 15, ST 18, SW-M8, SW-M9, SH-G1, SH-G7), its 2 wildcards, 48 unlisted.
    expect(listed).toBe(61);
    expect(scoped).toBe(48);
  });

  it("every one of the 152 rows is routed to the wave the design gives it: listed ids to their row's wave, the other 48 to an exact route of their own", () => {
    let listed = 0;
    let own = 0;
    for (const id of universe) {
      const route = routeOf(routing, id);
      expect(route, `${id} has no route`).not.toBeNull();
      const row = owner.get(id);
      if (row !== undefined) {
        expect(route, `${id}: design line ${row.line} says ${row.wave}`).toBe(row.wave);
        listed++;
      } else {
        expect(Object.hasOwn(routing.routes, id), `${id} is unlisted, so it owes an exact route citing its format or sport`).toBe(true);
        own++;
      }
    }
    expect(listed + own).toBe(universe.length);
    expect({ listed, own }).toEqual({ listed: 104, own: 48 });
  });

  it("every id the design names by NAME, or by a partial wildcard (SC-S*), has an exact route of its own (id by id); only a whole-prefix wildcard (SW-*, SH-*) is one row", () => {
    const byName = new Set<string>();
    for (const r of rows) {
      const t = tokens.get(r.line)!;
      for (const id of t.exact) if (universe.includes(id)) byName.add(id);
      // `SC-S*` is a letter-narrowed prefix of one audit family: its members are listed id by id; `SW-*` is a whole file's.
      for (const p of t.prefixes) if (p.length > 3) for (const u of universe) if (u.startsWith(p)) byName.add(u);
    }
    for (const id of byName) expect(Object.hasOwn(routing.routes, id), `${id} has no exact route`).toBe(true);
    // 51 ids named outright (SC 14, FX 15, ST 18, SW-M8, SW-M9, SH-G1, SH-G7) + SC-S1..S5 and S7..S9 from `SC-S*` (S6 is named too).
    expect(byName.size).toBe(59);
  });

  it("design §8's own phrases, read by hand: the root-cause owners and the ids that cross a prefix", () => {
    const want: Record<string, string> = {
      "SC-O1": "W2", "SC-O2": "W2", // "SC-O1/SC-O2 … the supportsDraws root cause, owned here"
      "SC-O7": "W3", "SW-M8": "W3", "SW-H1": "W3", // "byeScore SC-O7/SW-M8 owned here"
      "FX-G13": "W3", // "#840 + FX-G13 … owned here because W3 is the first wave to need Rebuild"
      "FX-G14": "W4", "ST-G7": "W4", "ST-G26": "W4",
      "ST-G5": "W5", "FX-G1": "W5",
      "FX-G3": "W6", "FX-G11": "W7", "SH-G7": "W8", "ST-G22": "W10",
      "SC-S6": "W2", "SC-C3": "W2", "SC-X3": "W2", "ST-G16": "W2", "ST-G10": "W2", "FX-G23": "W2", "SC-O8": "W2",
    };
    let checked = 0;
    for (const [id, wave] of Object.entries(want)) { expect(routeOf(routing, id), id).toBe(wave); checked++; }
    expect(checked).toBe(Object.keys(want).length);
  });
});
