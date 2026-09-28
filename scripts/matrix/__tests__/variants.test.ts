// Config variants (design §5). State transitions and empty cases first
// (TEST-STRATEGY rule 1): an unknown sport, a field with no bound or option, a
// pair the editor cannot express, a validate that stops answering ok mid-run
// (R-PF3), and a second generation. Expected values come from the product's
// declarations (SPORT_RULES, buildRuleOverride, visibleRuleFields) and the
// engine's (module.variants, configSchema) — never read back from variants.ts.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SPORT_RULES, buildRuleOverride, visibleRuleFields, type RuleField } from "../../../apps/web/src/lib/match-rules.ts";
import { BUILDER_PREFERRED_VARIANT, ROW_KEYS, SPORT_KEYS, stagesForRow } from "../lib/catalogue.ts";
import { UnknownSport, resolveSportCfg, sportModule, variantKeys } from "../lib/sport-cfg.ts";
import { generateStream } from "../lib/streams/index.ts";
import { KNOWN_UNSUPPORTED } from "../lib/streams/known-unsupported.ts";
import type { StreamRequest } from "../lib/streams/types.ts";
import {
  FieldUnbounded, VariantGenerationStuck, buildSportVariants, buildVariant, factorsFor, levelsOf,
  offlineBuilderDefault, offlineVariantOrder, scorable, titleCase,
} from "../lib/variants.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const src = (p: string) => readFileSync(resolve(REPO, p), "utf8");
/** The body of a top-level `function <name>(…) {…}`, whitespace-normalised. */
function bodyOf(text: string, name: string): string {
  const at = text.indexOf(`function ${name}(`);
  if (at === -1) throw new Error(`no function ${name}`);
  let i = text.indexOf("{", text.indexOf(")", at));
  const start = i;
  for (let depth = 0; i < text.length; i++) {
    if (text[i] === "{") depth++;
    if (text[i] === "}" && --depth === 0) break;
  }
  return text.slice(start, i + 1).replace(/\s+/g, " ");
}
const ALL = SPORT_KEYS.map((s) => buildSportVariants(s)); // one generation for the file
/** The engine's own preset for a variant key — what the builder's blank field inherits. */
const presetCfg = (sport: string, preset: string) =>
  ((sportModule(sport).variants as Record<string, unknown>)[preset] ?? {}) as Record<string, unknown>;
const cp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

describe("builder default variant, derived offline", () => {
  it("titleCase is sync-sports.ts's (text-pinned) and sync-sports names every system variant with it", () => {
    const sync = src("scripts/sync-sports.ts");
    expect(bodyOf(src("scripts/matrix/lib/variants.ts"), "titleCase")).toBe(bodyOf(sync, "titleCase"));
    expect(sync).toMatch(/values \(\$\{module\.key\}, \$\{variantKey\}, \$\{titleCase\(variantKey\)\}/);
  });
  it("empty case first: a sport with no variants is refused by name", () => {
    expect(() => offlineBuilderDefault("no-such-sport")).toThrow(UnknownSport);
    expect(() => offlineBuilderDefault("no-such-sport")).toThrow("'no-such-sport'");
  });
  it("sweeps the registry: the offline order is a permutation of the module's variants, ascending by titleCase name in codepoint order", () => {
    let n = 0;
    for (const s of SPORT_KEYS) {
      const order = offlineVariantOrder(s);
      expect([...order].sort(), s).toEqual([...variantKeys(s)].sort());
      for (let i = 1; i < order.length; i++) {
        expect(cp(titleCase(order[i - 1]!), titleCase(order[i]!)) <= 0, `${s}: ${order[i - 1]} before ${order[i]}`).toBe(true);
        n++;
      }
    }
    expect(n).toBeGreaterThan(0);
  });
  it("sweeps the registry: every sport's default is one of its own variants; the preferred ones win", () => {
    let n = 0;
    let preferred = 0;
    for (const s of SPORT_KEYS) {
      const d = offlineBuilderDefault(s);
      expect(variantKeys(s)).toContain(d);
      const pref = BUILDER_PREFERRED_VARIANT[s];
      if (pref !== undefined && variantKeys(s).includes(pref)) {
        expect(d).toBe(pref);
        preferred++;
      }
      n++;
    }
    expect(n).toBe(SPORT_KEYS.length);
    expect(preferred).toBeGreaterThan(0);
  });
  it("ruling 24's recorded defaults hold: volleyball → beach, chess (boardgame) → blitz", () => {
    expect(offlineBuilderDefault("volleyball")).toBe("beach");
    expect(offlineBuilderDefault("boardgame")).toBe("blitz");
  });
});

describe("boundary classes (from SPORT_RULES — the engine schema is unbounded)", () => {
  it("empty cases first: an unbounded number field and an option-less select are refused", () => {
    expect(() => levelsOf({ key: "x", label: "x", kind: "number", build: () => ({}) } as RuleField)).toThrow(FieldUnbounded);
    expect(() => levelsOf({ key: "x", label: "x", kind: "select", options: [], build: () => ({}) } as RuleField)).toThrow(FieldUnbounded);
  });
  it("every SPORT_RULES number field has min < max; interior is strictly between; blank is last", () => {
    let n = 0;
    for (const s of SPORT_KEYS) for (const f of SPORT_RULES[s] ?? []) {
      const ls = levelsOf(f);
      expect(ls.at(-1)).toEqual({ cls: "blank", raw: "" });
      if (f.kind === "number") {
        n++;
        expect(f.min! < f.max!, `${s}.${f.key}`).toBe(true);
        const mid = ls.find((l) => l.cls === "interior");
        if (mid !== undefined) expect(Number(mid.raw) > f.min! && Number(mid.raw) < f.max!).toBe(true);
      }
    }
    expect(n).toBeGreaterThan(0);
  });
  it("each level is the declared value: number min/max are SPORT_RULES' own; an interior exists whenever the range has room; selects list every option", () => {
    let n = 0;
    for (const s of SPORT_KEYS) for (const f of SPORT_RULES[s] ?? []) {
      const ls = levelsOf(f);
      const raw = (cls: string) => ls.find((l) => l.cls === cls)?.raw;
      if (f.kind === "number") {
        expect(raw("min"), `${s}.${f.key}`).toBe(String(f.min));
        expect(raw("max"), `${s}.${f.key}`).toBe(String(f.max));
        expect(raw("interior") !== undefined, `${s}.${f.key} interior`).toBe(f.max! - f.min! >= 2);
      } else if (f.kind === "select") {
        expect(ls.slice(0, -1).map((l) => l.raw), `${s}.${f.key}`).toEqual(f.options!.map((o) => o.value));
      } else {
        expect(ls.map((l) => l.raw), `${s}.${f.key}`).toEqual(["on", "off", ""]);
      }
      n++;
    }
    expect(n).toBeGreaterThan(0);
  });
});

describe("the pair-wise cover", () => {
  it("empty case first: a sport the registry does not declare is refused by name, before any SPORT_RULES lookup", () => {
    expect(() => buildSportVariants("no-such-sport")).toThrow(UnknownSport);
    // An inherited key is not a sport either (SPORT_RULES.constructor is Object's constructor).
    expect(() => buildSportVariants("constructor")).toThrow(UnknownSport);
  });
  it("sweeps all 11 sports in registry order (never sorted)", () => {
    expect(ALL.map((v) => v.sport)).toEqual([...SPORT_KEYS]);
    expect(ALL.length).toBe(11);
  });
  it("every pair of factor levels is covered by a case or listed uncoverable with a reason — counted independently", () => {
    let pairs = 0;
    for (const v of ALL) {
      const fs = factorsFor(v.sport);
      const label = (f: number, l: number) => `${fs[f]!.name}=${fs[f]!.levels[l]!.cls}`;
      const cls = (c: (typeof v.cases)[number], f: number) => (f === 0 ? c.row : f === 1 ? c.preset : c.classes[fs[f]!.name] ?? "blank");
      let own = 0;
      for (let i = 0; i < fs.length; i++) for (let j = i + 1; j < fs.length; j++)
        for (let a = 0; a < fs[i]!.levels.length; a++) for (let b = 0; b < fs[j]!.levels.length; b++) {
          pairs++;
          own++;
          const covered = v.cases.some((c) => cls(c, i) === fs[i]!.levels[a]!.cls && cls(c, j) === fs[j]!.levels[b]!.cls);
          const listed = v.uncoverable.some((u) => u.a === label(i, a) && u.b === label(j, b) && u.reason.length > 0);
          expect(covered || listed, `${v.sport}: ${label(i, a)} × ${label(j, b)}`).toBe(true);
          // Listed means NOT covered: a pair a case covers must not also be reported unreachable.
          expect(covered && listed, `${v.sport}: ${label(i, a)} × ${label(j, b)} both covered and listed`).toBe(false);
        }
      expect(v.pairs).toBe(own);
      expect(v.pairs).toBe(v.covered + v.uncoverable.length);
    }
    expect(pairs).toBeGreaterThan(0);
  });
  it("every case is valid for the engine and carries exactly what buildRuleOverride builds", () => {
    let n = 0;
    for (const v of ALL) for (const c of v.cases) {
      expect(() => resolveSportCfg(c.sport, c.preset, c.overrides)).not.toThrow();
      const again = buildVariant(c.sport, c.preset, c.values);
      expect(again.ok && again.overrides).toEqual(c.overrides);
      // Independently of buildVariant: the product's own builder over the
      // preset the blank fields inherit, as it crosses the wire (JSON). Strict:
      // football's lone shoot-out points field builds `undefined` delete
      // markers, which JSON drops and a loose toEqual would forgive.
      expect(c.overrides).toStrictEqual(JSON.parse(JSON.stringify(buildRuleOverride(c.sport, c.values, presetCfg(c.sport, c.preset)))));
      n++;
    }
    expect(n).toBeGreaterThan(0);
  });
  it("every case's values are what its classes declare in SPORT_RULES, and only for fields the editor shows", () => {
    let n = 0;
    for (const v of ALL) for (const c of v.cases) {
      const fields = SPORT_RULES[c.sport] ?? [];
      expect(Object.keys(c.classes).sort(), c.id).toEqual(fields.map((f) => f.key).sort());
      const shown = new Set(visibleRuleFields(c.sport, c.values, presetCfg(c.sport, c.preset)).map((f) => f.key));
      for (const f of fields) {
        const cls = c.classes[f.key]!;
        const raw = c.values[f.key];
        if (cls === "blank") { expect(raw, `${c.id} ${f.key}`).toBeUndefined(); continue; }
        expect(shown.has(f.key), `${c.id} ${f.key} is hidden by the editor`).toBe(true);
        if (cls === "min") expect(raw).toBe(String(f.min));
        else if (cls === "max") expect(raw).toBe(String(f.max));
        else if (cls === "interior") expect(Number(raw) > f.min! && Number(raw) < f.max!, `${c.id} ${f.key}=${raw}`).toBe(true);
        else if (cls === "on" || cls === "off") expect(raw).toBe(cls);
        else expect(`option:${raw}`).toBe(cls);
        n++;
      }
    }
    expect(n).toBeGreaterThan(0);
  });
  it("a value for a field the editor hides is never a case (badminton best-of-1 hides setTo)", () => {
    // single-sport: best-of-1's single points field is declared for the set sports; badminton is the pinned example.
    const b = ALL.find((v) => v.sport === "badminton")!;
    expect(b.uncoverable.some((u) => u.a.startsWith("bestOf=option:1") && u.b.startsWith("setTo=") && !u.b.endsWith("blank"))).toBe(true);
    expect(b.cases.some((c) => c.values.bestOf === "1" && (c.values.setTo ?? "") !== "")).toBe(false);
  });
  it("an uncoverable pair has no valid completion at all — the full cross product of the other factors, brute-forced (the listing never over-claims)", () => {
    // Row is never varied: validate takes (sport, preset, values) — the row cannot change its answer.
    // Two of today's pairs need TWO further levels (badminton preset=bwf × cap=min: best of 1 AND 11 points),
    // so a one-level search would list them wrongly; the brute force here has no depth.
    let judged = 0;
    let tried = 0;
    for (const v of ALL) {
      const fs = factorsFor(v.sport);
      const at = (label: string) => {
        const eq = label.indexOf("=");
        const f = fs.findIndex((x) => x.name === label.slice(0, eq));
        return [f, f < 0 ? -1 : fs[f]!.levels.findIndex((l) => l.cls === label.slice(eq + 1))] as const;
      };
      for (const u of v.uncoverable) {
        const [i, a] = at(u.a);
        const [j, b] = at(u.b);
        expect(i >= 0 && a >= 0 && j >= 0 && b >= 0, `${v.sport}: ${u.a} × ${u.b} names a real level`).toBe(true);
        const free: number[] = [];
        for (let k = 1; k < fs.length; k++) if (k !== i && k !== j) free.push(k);
        const lv = new Array<number>(fs.length).fill(0);
        lv[i] = a;
        lv[j] = b;
        for (;;) {
          const values: Record<string, string> = {};
          for (let f = 2; f < fs.length; f++) if (fs[f]!.levels[lv[f]!]!.raw !== "") values[fs[f]!.name] = fs[f]!.levels[lv[f]!]!.raw;
          const preset = fs[1]!.levels[lv[1]!]!.raw;
          expect(buildVariant(v.sport, preset, values).ok, `${v.sport}: ${u.a} × ${u.b} is valid under ${preset} ${JSON.stringify(values)}`).toBe(false);
          tried++;
          let x = 0; // odometer over the free factors
          while (x < free.length && ++lv[free[x]!]! === fs[free[x]!]!.levels.length) lv[free[x++]!] = 0;
          if (x === free.length) break;
        }
        judged++;
      }
    }
    expect(judged).toBeGreaterThan(0);
    expect(tried).toBeGreaterThan(judged);
  });
  it("a pair refused at every default but valid under two further levels is COVERED, not listed (badminton bwf × cap 15)", () => {
    // single-sport: the pinned depth-2 witness — bwf's 21-point sets refuse cap 15 unless best of 1 AND a points value ≤ 15 are both set.
    const b = ALL.find((v) => v.sport === "badminton")!;
    const cap = SPORT_RULES.badminton!.find((f) => f.key === "cap")!;
    expect(buildVariant("badminton", "bwf", { cap: String(cap.min) }).ok).toBe(false);
    expect(b.uncoverable.some((u) => u.a === "preset=bwf" && u.b === "cap=min")).toBe(false);
    const hit = b.cases.filter((c) => c.preset === "bwf" && c.classes.cap === "min");
    expect(hit.length).toBeGreaterThan(0);
    for (const c of hit) expect(c.values.bestOf, c.id).toBe("1");
  });
  it("deterministic: a second generation is identical", () => {
    expect(SPORT_KEYS.map((s) => buildSportVariants(s))).toEqual(ALL);
  });
  // Pre-flight ruling R-PF3. For a PURE validate both refusals are unreachable:
  // every field factor has a blank level and the preset factor has the default,
  // so each fill can re-choose the value the pair was already validated with.
  // The refusals guard a validate that is NOT a pure function of its inputs.
  // Reaching them therefore takes a stateful validate — one that answers ok for
  // a budget of calls and then refuses — and the budgets come from the
  // generator's call shape, not from its output:
  //   - pass 1 calls validate once per pair (P = Σ over factor pairs |Li|·|Lj|);
  //   - when all P pairs pass, the first uncovered pair is (row level 0,
  //     preset level 0), so the first completion tries every level of every
  //     field factor once (T1 = Σ over fields |Lk|) and then re-checks the
  //     complete case (call P + T1 + 1).
  // A wrong budget lands on the OTHER site, whose message differs, so the test
  // fails loudly rather than passing vacuously.
  const budgeted = (budget: number) => {
    let calls = 0;
    return (_s: string, _p: string, _v: Record<string, string>) =>
      ++calls <= budget ? ({ ok: true, overrides: {}, cfg: {} } as const) : ({ ok: false, reason: `refused call ${calls}` } as const);
  };
  const callShape = (sport: string) => {
    const L = factorsFor(sport).map((f) => f.levels.length);
    let P = 0;
    for (let i = 0; i < L.length; i++) for (let j = i + 1; j < L.length; j++) P += L[i]! * L[j]!;
    return { fields: factorsFor(sport).slice(2), P, T1: L.slice(2).reduce((a, b) => a + b, 0) };
  };
  it("a fill with no valid level is a named refusal naming the factor (registry sweep)", () => {
    let judged = 0;
    for (const s of SPORT_KEYS) {
      const { fields, P } = callShape(s);
      if (fields.length === 0) continue; // no field factor to fill: the complete-case test below covers this sport
      expect(() => buildSportVariants(s, { validate: budgeted(P) }), s).toThrow(VariantGenerationStuck);
      expect(() => buildSportVariants(s, { validate: budgeted(P) }), s).toThrow(`no valid level for '${fields[0]!.name}'`);
      judged++;
    }
    expect(judged).toBeGreaterThan(0);
  });
  it("a complete case that fails its re-check is a named refusal (registry sweep)", () => {
    let judged = 0;
    for (const s of SPORT_KEYS) {
      const { P, T1 } = callShape(s);
      expect(() => buildSportVariants(s, { validate: budgeted(P + T1) }), s).toThrow(VariantGenerationStuck);
      expect(() => buildSportVariants(s, { validate: budgeted(P + T1) }), s).toThrow("'(complete case)'");
      judged++;
    }
    expect(judged).toBe(SPORT_KEYS.length);
  });
  it("covers every row: each sport has a case on each of the 21 rows", () => {
    expect(ROW_KEYS.length).toBe(21);
    for (const v of ALL) expect(new Set(v.cases.map((c) => c.row)).size, v.sport).toBe(ROW_KEYS.length);
  });
  it("case ids are unique per sport and ordered", () => {
    let n = 0;
    for (const v of ALL) {
      expect(v.cases.map((c) => c.id), v.sport).toEqual(v.cases.map((_, i) => `${v.sport}#${String(i + 1).padStart(3, "0")}`));
      n += v.cases.length;
    }
    expect(n).toBeGreaterThan(0);
  });
});

describe("scorability (the generatability sweep)", () => {
  it("each sport's default preset with no override is scorable on every row", () => {
    let n = 0;
    for (const s of SPORT_KEYS) for (const row of ROW_KEYS) {
      expect(scorable({ id: "x", sport: s, row, preset: offlineBuilderDefault(s), classes: {}, values: {}, overrides: {}, scorable: null }), `${row}|${s}`).toBeNull();
      n++;
    }
    expect(n).toBe(ROW_KEYS.length * SPORT_KEYS.length);
  });
  it("an override the engine refuses is a reason, never null", () => {
    // single-sport: any schema-invalid override will do; cricket's playersPerSide is a declared integer.
    expect(scorable({ id: "x", sport: "cricket", row: "league", preset: "t20", classes: {}, values: {}, overrides: { playersPerSide: "eleven" }, scorable: null })).toMatch(/^cfg: /);
  });
  it("a declared generator gap (KNOWN_UNSUPPORTED win entries) is a reason naming the gap, never null", () => {
    // The committed gap list is the expected side: `${sport}:${variant}:${stageKind}:win-…`,
    // reached through a row whose FIRST stage has that kind.
    let judged = 0;
    for (const entry of KNOWN_UNSUPPORTED) {
      const [sport, preset, kind, outcome] = entry.split(":") as [string, string, string, string];
      if (!outcome.startsWith("win-")) continue;
      const row = ROW_KEYS.find((r) => stagesForRow(r)[0]!.kind === kind);
      expect(row, `${entry}: no row opens with a ${kind} stage`).toBeDefined();
      const reason = scorable({ id: "x", sport, row: row!, preset, classes: {}, values: {}, overrides: {}, scorable: null });
      expect(reason, entry).toMatch(/^win-home: GeneratorUnsupported: /);
      judged++;
    }
    expect(judged).toBeGreaterThan(0);
  });
  it("a stream whose fold is not the requested winner is a reason naming the side, never null (registry sweep)", () => {
    // The generator answers every request with the OTHER side's win: the fold then disagrees.
    let judged = 0;
    for (const s of SPORT_KEYS) {
      const swapped = (req: StreamRequest) =>
        generateStream({ ...req, outcome: { kind: "win", winner: req.outcome.kind === "win" && req.outcome.winner === "home" ? "away" : "home" } });
      const vc = { id: "x", sport: s, row: "league" as const, preset: offlineBuilderDefault(s), classes: {}, values: {}, overrides: {}, scorable: null };
      expect(scorable(vc, { generate: swapped }), s).toMatch(/^win-home: folded \{"kind":"win","winner":"matrix-away"/);
      judged++;
    }
    expect(judged).toBe(SPORT_KEYS.length);
  });
  it("every case records scorable = null or a reason naming the failed request, and each sport has at least one scorable case", () => {
    let n = 0;
    for (const v of ALL) {
      expect(v.cases.filter((c) => c.scorable === null).length, v.sport).toBeGreaterThan(0);
      for (const c of v.cases) {
        if (c.scorable !== null) expect(c.scorable, c.id).toMatch(/^(cfg|win-home|win-away): ./);
        n++;
      }
    }
    expect(n).toBeGreaterThan(0);
  });
});
