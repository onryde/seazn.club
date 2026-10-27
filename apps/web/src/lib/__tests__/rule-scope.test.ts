// W2c X-SR-1 / X-SR-2 — `lib/rule-scope.ts`: the web reads the engine's `ruleKeys` declaration (plan D2) and sorts the
// curated rule fields into the stage, match and points forms by the SCOPE the engine gives the keys they edit.
//
// Expected populations come from the registry and the engine's own helpers (`stageKeysFor`, `fixtureKeysFor`,
// `pointsKeysFor`, `checkFixtureOverride`) and from spec §4.1 Q5, never from rule-scope.ts.
import { describe, expect, it } from "vitest";
import { builtinModules } from "@seazn/engine/sports";
import { DRAW_KINDS, StageKind } from "@seazn/engine/core";
import {
  checkFixtureOverride, fixtureKeysFor, pointsKeysFor, ruleKeyOwning, stageDefaultsFor, stageKeysFor,
  type AnySportModule,
} from "@seazn/engine/sport";
import { SPORT_RULES } from "@/lib/match-rules";
import { ABANDON_LABELS, abandonOptions } from "@/lib/match-rules/shared";
import type { RuleField } from "@/lib/match-rules/types";
import {
  buildFragment, buildMatchFragment, fieldsWithin, matchFieldsFor, moduleFor, pointsFieldsFor, stageFieldsFor,
  type RuleContext,
} from "@/lib/rule-scope";

const mod = (key: string): AnySportModule => {
  const m = moduleFor(key);
  if (m === null) throw new Error(`no builtin ${key}`);
  return m;
};
const ice = (): RuleContext => ({ module: mod("icehockey"), stageKind: "knockout", variant: null });
const stage = { periods: { count: 3, minutes: 20 }, overtime: { kind: "sudden_death", minutes: 10, skaters: 3 }, shootout: { attempts: 5, suddenDeath: true } };
const keysOf = (fs: readonly RuleField[]): string[] => fs.map((f) => f.key);
/** `want` appear in `got`, in that order (other fields may sit between them): a later task that adds a stage field to a sport
 *  moves nothing here. */
const inOrder = (got: readonly string[], want: readonly string[]): void => {
  expect(got.filter((k) => want.includes(k))).toEqual([...want]);
};
const field = (key: string, edits: string[], build: RuleField["build"] = () => ({})): RuleField => ({ key, label: key, kind: "number", edits, build });

describe("rule-scope — web reads the engine declaration (D2)", () => {
  it("X-SR-1 moduleFor finds every builtin and refuses an unknown key, an inherited one included", () => {
    let found = 0;
    for (const m of builtinModules) { expect(moduleFor(m.key)?.key).toBe(m.key); found++; }
    expect(found, "the registry swept").toBe(builtinModules.length);
    expect(found).toBeGreaterThan(0);
    for (const k of ["constructor", "toString", "__proto__", "nope", ""]) expect(moduleFor(k), k).toBeNull();
  });

  it("X-SR-1 the fields of every kind × variant cell are exactly the fields whose every edited key the engine offers there, in all three forms", () => {
    // Sound AND complete, against the engine's helpers (never rule-scope's own filter): a field is in a form iff each key
    // it edits is one of that form's keys for the cell. Counted per form: zero checked is a failure.
    let cells = 0;
    let pointsKeyCells = 0;
    const placed = { stage: 0, match: 0, points: 0 };
    for (const m of builtinModules)
      for (const kind of [null, ...StageKind.options])
        for (const variant of [null, ...Object.keys(m.variants)]) {
          const ctx: RuleContext = { module: m, stageKind: kind, variant };
          const forms = [
            ["stage", stageFieldsFor(ctx), new Set(stageKeysFor(m, kind, variant))],
            ["match", matchFieldsFor(ctx), new Set(fixtureKeysFor(m, kind, variant))],
            ["points", pointsFieldsFor(ctx), new Set(pointsKeysFor(m, kind, variant))],
          ] as const;
          for (const [form, got, keys] of forms) {
            const want = (SPORT_RULES[m.key] ?? []).filter((f) => f.edits.length > 0 && f.edits.every((k) => keys.has(k)));
            expect(keysOf(got), `${m.key}/${kind}/${variant} ${form}`).toEqual(keysOf(want));
            placed[form] += got.length;
          }
          if (pointsKeysFor(m, kind, variant).length > 0) pointsKeyCells++;
          cells++;
        }
    expect(cells).toBe(builtinModules.reduce((n, m) => n + (StageKind.options.length + 1) * (Object.keys(m.variants).length + 1), 0));
    expect(placed.stage, "stage fields placed").toBeGreaterThan(0);
    expect(placed.match, "match fields placed").toBeGreaterThan(0);
    // W2d PS-1: no field edits a points key since football's shoot-out pair retired (the stage's Points section owns them),
    // so the points arm places nothing — asserted, not assumed, over cells that DO declare points keys (the absence is a real
    // claim, not an empty key set). A points field added later reds here: restore the `> 0` guard with it.
    expect(pointsKeyCells, "cells declaring points keys").toBeGreaterThan(0);
    expect(placed.points, "points fields placed (none since W2d PS-1)").toBe(0);
  });

  it("X-SR-1 spec §4.1 Q5: each sport's match form is its match keys' editors, in table order (rows typed from the spec)", () => {
    const Q5_MATCH: Record<string, string[]> = {
      icehockey: ["periodMinutes", "overtimeMinutes", "shootoutAttempts"],
      hockey: ["quarterMinutes", "shootoutAttempts"],
      football: ["halfMinutes", "extraTime", "shootoutAttempts"],
      cricket: ["overs", "maxOversPerBowler"],
      carrom: ["gameTo", "maxBoards", "bestOf"],
      tennis: ["bestOf", "setType", "finalSet", "noAd", "tiebreakWinBy"],
      volleyball: ["bestOf", "setTo", "finalSetTo", "cap", "winBy"],
      badminton: ["bestOf", "setTo", "finalSetTo", "cap", "winBy"],
      tabletennis: ["bestOf", "setTo", "finalSetTo", "winBy"],
      boardgame: [],
      generic: [],
    };
    // Q5 names whose ENGINE key does not exist until a later task (football's attempts, Task 6): not expected before that
    // task adds the field, and pinned in place from the moment it does. Nothing here needs editing when it lands.
    const NOT_BEFORE: Record<string, string[]> = { football: ["shootoutAttempts"] };
    let sports = 0;
    let named = 0;
    for (const m of builtinModules) {
      expect(Object.hasOwn(Q5_MATCH, m.key), `${m.key} has a Q5 row`).toBe(true);
      const fielded = new Set(keysOf(SPORT_RULES[m.key] ?? []));
      const want = Q5_MATCH[m.key]!.filter((k) => !(NOT_BEFORE[m.key] ?? []).includes(k) || fielded.has(k));
      expect(keysOf(matchFieldsFor({ module: m, stageKind: null, variant: null })), m.key).toEqual(want);
      named += want.length;
      sports++;
    }
    expect(sports).toBe(builtinModules.length);
    expect(Object.keys(Q5_MATCH).length, "no Q5 row for a sport the registry lacks").toBe(builtinModules.length);
    expect(named, "the rows named fields").toBeGreaterThan(0);
  });

  it("X-SR-1 icehockey: the stage form is the match fields plus the stage-only editors (overtime on/off and skaters, the shoot-out on/off), points are not in it", () => {
    inOrder(keysOf(stageFieldsFor(ice())), ["periodMinutes", "overtime", "overtimeMinutes", "overtimeSkaters", "shootout", "shootoutAttempts"]);
    expect(keysOf(matchFieldsFor(ice()))).toEqual(["periodMinutes", "overtimeMinutes", "shootoutAttempts"]);
    // "Points are not in it": no stage field edits a points key the engine declares for this sport and stage. Ice hockey has no
    // points FIELD today (asserted last), so the loop is a guard for the day it gets one; the football test below carries the
    // positive case (a real points field kept out of the stage form).
    const ctx = ice();
    const pointsKeys = pointsKeysFor(ctx.module, ctx.stageKind, ctx.variant);
    const stageFields = stageFieldsFor(ctx);
    expect(pointsKeys.length, "icehockey declares points keys, so the absence below is a real claim").toBeGreaterThan(0);
    expect(stageFields.length, "the stage form is not empty").toBeGreaterThan(0);
    for (const f of stageFields) for (const k of f.edits) expect(pointsKeys, `${f.key} edits ${k}, a points key`).not.toContain(k);
    // No field edits an icehockey points key, so its points form is EMPTY and nothing can have leaked from it.
    expect(pointsFieldsFor(ctx)).toEqual([]);
  });

  it("X-SR-1 football: no field edits a points key (the shoot-out pair retired, W2d PS-1), so the points form is empty and the stage form holds no points key", () => {
    const ctx: RuleContext = { module: mod("football"), stageKind: "league", variant: null };
    const pointsKeys = pointsKeysFor(ctx.module, ctx.stageKind, ctx.variant);
    // The engine still declares football's table points (soBonus among them), so an empty points FORM is a real claim:
    // the stage's Points section edits them, never a match-rules field.
    expect(pointsKeys, "football declares points keys").toContain("points");
    // ...and its schema keeps `soBonus` while the retired pair no longer survives a parse.
    const parsed = ctx.module.configSchema.parse({ points: { win: 3, draw: 1, loss: 0, soBonus: 1, shootoutWin: 2, shootoutLoss: 1 } });
    expect((parsed as { points: Record<string, number> }).points).toEqual({ win: 3, draw: 1, loss: 0, soBonus: 1 });
    expect(pointsFieldsFor(ctx)).toEqual([]);
    const stageFields = stageFieldsFor(ctx);
    expect(stageFields.length, "the stage form is not empty").toBeGreaterThan(0);
    for (const f of stageFields) for (const k of f.edits) expect(pointsKeys, `${f.key} edits ${k}, a points key`).not.toContain(k);
    inOrder(keysOf(stageFieldsFor(ctx)), ["halfMinutes", "extraTime", "shootout", "teamSize", "maxSubs", "subWindows", "sinBinMinutes"]);
    // A sport whose points keys have no field yet answers an empty points form rather than a crash.
    expect(pointsFieldsFor({ module: mod("tennis"), stageKind: "league", variant: null })).toEqual([]);
  });

  it("X-SR-1 carrom tieBoard shows in table stages only (item 9), counted", () => {
    const carrom = mod("carrom");
    let shown = 0;
    for (const k of StageKind.options) {
      const has = stageFieldsFor({ module: carrom, stageKind: k, variant: null }).some((f) => f.key === "tieBoard");
      expect(has, k).toBe((DRAW_KINDS as ReadonlySet<string>).has(k));
      if (has) shown++;
    }
    expect(shown).toBe(DRAW_KINDS.size);
    expect(shown).toBeGreaterThan(0);
  });

  it("X-SR-1 cricket: the super over and DLS editors follow the variants the schema lets switch them on", () => {
    const cricket = mod("cricket");
    const offered = (variant: string) => keysOf(stageFieldsFor({ module: cricket, stageKind: "knockout", variant }));
    const on = Object.keys(cricket.variants).filter((v) => offered(v).includes("superOver"));
    const off = Object.keys(cricket.variants).filter((v) => !offered(v).includes("superOver"));
    expect(on.length, "variants offering the super over").toBeGreaterThan(0);
    expect(off.length, "variants refusing it (the test match)").toBeGreaterThan(0);
    for (const v of on) expect(offered(v), v).toContain("dls");
    for (const v of off) expect(offered(v), v).not.toContain("dls");
    // The division level (no variant) is never narrowed.
    expect(keysOf(stageFieldsFor({ module: cricket, stageKind: null, variant: null }))).toEqual(expect.arrayContaining(["superOver", "dls"]));
  });

  it("X-SR-1 a module the table does not hold, or one named like an inherited property, has no fields in any form", () => {
    const fake = { key: "constructor", ruleKeys: { x: { scope: "match" } }, variants: {} } as unknown as AnySportModule;
    const ctx: RuleContext = { module: fake, stageKind: null, variant: null };
    expect(stageFieldsFor(ctx)).toEqual([]);
    expect(matchFieldsFor(ctx)).toEqual([]);
    expect(pointsFieldsFor(ctx)).toEqual([]);
    expect(stageFieldsFor({ ...ctx, module: { ...fake, key: "no-such-sport" } as AnySportModule })).toEqual([]);
  });

  it("X-SR-1 fieldsWithin: a field with no edited key belongs to no form, and one key outside the set keeps a field out", () => {
    const a = field("a", ["x"]);
    const ab = field("ab", ["x", "y"]);
    const none = field("none", []);
    expect(keysOf(fieldsWithin([a, ab, none], ["x", "y"]))).toEqual(["a", "ab"]);
    expect(keysOf(fieldsWithin([a, ab, none], ["x"]))).toEqual(["a"]);
    expect(fieldsWithin([a, ab, none], [])).toEqual([]);
    expect(fieldsWithin([], ["x"])).toEqual([]);
  });
});

describe("rule-scope — buildMatchFragment (X-SR-2: a match overrides only match keys)", () => {
  it("X-SR-2 empty values → {}; blank entries → {}", () => {
    expect(buildMatchFragment(ice(), {}, stage)).toEqual({});
    expect(buildMatchFragment(ice(), { periodMinutes: "", overtimeMinutes: "", shootoutAttempts: "" }, stage)).toEqual({});
  });

  it("X-SR-2 a field whose build writes the leaf is read at its edited path (periodMinutes keeps the stage's period count)", () => {
    expect(buildMatchFragment(ice(), { periodMinutes: "15" }, stage)).toEqual({ periods: { count: 3, minutes: 15 } });
  });

  it("X-SR-2 deep-sets a sub-field (whose build writes nothing) on the stage object", () => {
    expect(buildMatchFragment(ice(), { overtimeMinutes: "5" }, stage)).toEqual({ overtime: { kind: "sudden_death", minutes: 5, skaters: 3 } });
  });

  it("X-SR-2 writes nothing under a stage decider that is off", () => {
    expect(buildMatchFragment(ice(), { overtimeMinutes: "5" }, { ...stage, overtime: null })).toEqual({});
    expect(buildMatchFragment(ice(), { shootoutAttempts: "3" }, { ...stage, shootout: null })).toEqual({});
    // The negative's pair: the same call against a stage that carries the decider writes it.
    expect(buildMatchFragment(ice(), { shootoutAttempts: "3" }, stage)).toEqual({ shootout: { attempts: 3, suddenDeath: true } });
  });

  it("X-SR-2 two fields under one object compose, not overwrite each other", () => {
    expect(buildMatchFragment(ice(), { overtimeMinutes: "5", periodMinutes: "12", shootoutAttempts: "4" }, stage)).toEqual({
      overtime: { kind: "sudden_death", minutes: 5, skaters: 3 },
      periods: { count: 3, minutes: 12 },
      shootout: { attempts: 4, suddenDeath: true },
    });
  });

  it("X-SR-2 another sport: tennis noAd keeps the stage's other game leaves, and 'off' is a value, not a blank", () => {
    const t: RuleContext = { module: mod("tennis"), stageKind: "league", variant: null };
    expect(buildMatchFragment(t, { noAd: "on" }, { game: { noAd: false, other: 1 } })).toEqual({ game: { noAd: true, other: 1 } });
    expect(buildMatchFragment(t, { noAd: "off" }, { game: { noAd: true, other: 1 } })).toEqual({ game: { noAd: false, other: 1 } });
  });

  it("X-SR-2 a top-level key is the built value itself (football halfMinutes), and a stage-only field is never read", () => {
    const f: RuleContext = { module: mod("football"), stageKind: "knockout", variant: null };
    expect(buildMatchFragment(f, { halfMinutes: "30" }, {})).toEqual({ halfMinutes: 30 });
    expect(buildMatchFragment(f, { teamSize: "9", shootout: "on", maxSubs: "3" }, {})).toEqual({});
  });

  it("X-SR-2 a second call is the same answer, and the stage object is never changed or shared", () => {
    const base = { game: { noAd: false, other: { deep: 1 } } };
    const snapshot = structuredClone(base);
    const t: RuleContext = { module: mod("tennis"), stageKind: "league", variant: null };
    const first = buildMatchFragment(t, { noAd: "on" }, base);
    expect(buildMatchFragment(t, { noAd: "on" }, base)).toEqual(first);
    expect(base, "the stage object is untouched").toEqual(snapshot);
    (first.game as { other: { deep: number } }).other.deep = 99;
    expect(base.game.other.deep, "the fragment shares no object with the stage").toBe(1);
  });

  it("X-SR-2 buildFragment: a three-deep path, two edits under one object, and a leaf the build does not carry", () => {
    const deep = field("deep", ["a.b.c"], () => ({ a: { b: { c: 7 } } }));
    expect(buildFragment([deep], { deep: "1" }, { a: { b: { c: 1, keep: 2 }, other: 3 } })).toEqual({ a: { b: { c: 7, keep: 2 }, other: 3 } });
    expect(buildFragment([deep], { deep: "1" }, { a: { b: null } })).toEqual({ a: { b: { c: 7 } } });
    const two = field("two", ["o.x", "o.y"], () => ({ o: { x: 1, y: 2 } }));
    expect(buildFragment([two], { two: "1" }, { o: { x: 0, y: 0, z: 9 } })).toEqual({ o: { x: 1, y: 2, z: 9 } });
    const missing = field("missing", ["o.q"], () => ({ o: { x: 1 } }));
    expect(buildFragment([missing], { missing: "1" }, { o: { q: 5 } }), "a path the build does not write is skipped").toEqual({});
    expect(buildFragment([deep], { deep: "1" }, { a: 5 }), "a non-object stage value is skipped").toEqual({});
    expect(buildFragment([deep], { deep: "1" }, {}), "an absent stage value is skipped").toEqual({});
  });

  it("X-SR-2 the SEAM: a fragment built from every match field of every sport is judged by the engine's own override check", () => {
    // The producer is buildMatchFragment, the consumer the engine's checkFixtureOverride. A fixture on both ends would
    // prove the fixture; here the stage is the engine's own parsed preset plus its knockout defaults.
    const probes = (f: RuleField): string[] =>
      f.kind === "select" ? (f.options ?? []).map((o) => o.value) : f.kind === "bool" ? ["on", "off"] : [String(f.min ?? 1)];
    let sports = 0;
    let judged = 0;
    let accepted = 0;
    let boundedRefusals = 0;
    for (const m of builtinModules) {
      const variant = Object.keys(m.variants)[0]!;
      const parsed = m.configSchema.safeParse({ ...m.variants[variant], ...stageDefaultsFor(m, "knockout", variant) });
      expect(parsed.success, `${m.key}/${variant}: the stage parses`).toBe(true);
      const resolved = parsed.data as Record<string, unknown>;
      const ctx: RuleContext = { module: m, stageKind: "knockout", variant };
      const fields = matchFieldsFor(ctx);
      if (fields.length === 0) continue;
      sports++;
      for (const f of fields)
        for (const v of probes(f)) {
          const fragment = buildMatchFragment(ctx, { [f.key]: v }, resolved);
          const verdict = checkFixtureOverride(m, "knockout", variant, resolved, fragment);
          judged++;
          if (verdict.ok) { accepted++; continue; }
          // The only honest refusal is a decider bound: a match may switch a decider off or shorten it, never switch it on.
          expect(verdict.code, `${m.key}.${f.key}=${v}: ${verdict.reason}`).toBe("RULE_NOT_SETTABLE");
          expect(ruleKeyOwning(m, verdict.path.split("."))?.fact.matchBound, `${m.key}.${f.key}=${v} refused at ${verdict.path}`).toBeDefined();
          boundedRefusals++;
        }
    }
    expect(sports, "sports with a match form: every one but generic and boardgame, which declare no match key").toBe(builtinModules.length - 2);
    expect(judged).toBeGreaterThan(0);
    expect(accepted, "the check accepted fragments from the web").toBeGreaterThan(0);
    expect(accepted + boundedRefusals).toBe(judged);
  });
  // Fix round 1, I3. The engine's override check judges a fragment against the stage's rules; it does not parse the
  // CONFIG that results. A fragment can pass the check and still lay a config the sport's schema refuses (a carrom game
  // shortened below the stage's queen cap, a cricket innings shorter than its bowler limit, a set-sport cap under the set
  // target). The producer here is buildMatchFragment, the consumer the schema the fold parses with.
  // These are KNOWN cross-field refusals, pinned exactly: a new one must be read and added, a fixed one removed. Whether the
  // match form should write the companion key (carrom's queenCapAt) is a Task 14 decision; this test does not change the
  // fragment, it states what the fragment does today.
  const KNOWN_SEAM_REFUSALS: Record<string, string> = {
    "cricket/t20/overs/1": "maxOversPerBowler exceeds the innings length | minOversForResult exceeds the innings length",
    "cricket/t20/maxOversPerBowler/50": "maxOversPerBowler exceeds the innings length",
    "cricket/odi/overs/1": "maxOversPerBowler exceeds the innings length | minOversForResult exceeds the innings length",
    "cricket/hundred/overs/1": "maxOversPerBowler exceeds the innings length | minOversForResult exceeds the innings length",
    "cricket/hundred/maxOversPerBowler/50": "maxOversPerBowler exceeds the innings length",
    "carrom/icf/gameTo/5": "queenCapAt must not exceed gameTo",
    "carrom/club-29/gameTo/5": "queenCapAt must not exceed gameTo",
    "volleyball/indoor/cap/15": "cap must be ≥ the set target",
    "volleyball/beach/cap/15": "cap must be ≥ the set target",
    "badminton/bwf/cap/15": "cap must be ≥ the set target",
    "badminton/short/setTo/30": "cap must be ≥ the set target",
    "badminton/short/finalSetTo/30": "cap must be ≥ the set target",
  };
  it("X-SR-2 the SEAM, schema half: the stage config with a built fragment laid on it parses, bar the pinned cross-field refusals", () => {
    const probes = (f: RuleField): string[] =>
      f.kind === "select" ? (f.options ?? []).map((o) => o.value)
      : f.kind === "bool" ? ["on", "off"]
      : [String(f.min ?? 1), ...(f.max === undefined ? [] : [String(f.max)])];
    const refused: Record<string, string> = {};
    let judged = 0;
    let parsed = 0;
    let sports = 0;
    for (const m of builtinModules) {
      const ctxFor = (variant: string): RuleContext => ({ module: m, stageKind: "knockout", variant });
      if (matchFieldsFor(ctxFor(Object.keys(m.variants)[0]!)).length === 0) continue;
      sports++;
      for (const variant of Object.keys(m.variants)) {
        const stageParse = m.configSchema.safeParse({ ...m.variants[variant], ...stageDefaultsFor(m, "knockout", variant) });
        expect(stageParse.success, `${m.key}/${variant}: the stage parses`).toBe(true);
        const resolved = stageParse.data as Record<string, unknown>;
        const ctx = ctxFor(variant);
        for (const f of matchFieldsFor(ctx))
          for (const v of probes(f)) {
            const fragment = buildMatchFragment(ctx, { [f.key]: v }, resolved);
            judged++;
            const r = m.configSchema.safeParse({ ...resolved, ...fragment });
            if (r.success) { parsed++; continue; }
            expect(r.error.issues.every((i) => i.code === "custom"), `${m.key}/${variant}/${f.key}=${v}: ${JSON.stringify(r.error.issues)}`).toBe(true);
            refused[`${m.key}/${variant}/${f.key}/${v}`] = r.error.issues.map((i) => i.message).join(" | ");
          }
      }
    }
    expect(sports, "sports with a match form: every one but generic and boardgame, which declare no match key").toBe(builtinModules.length - 2);
    expect(judged).toBeGreaterThan(0);
    expect(parsed, "fragments that parse").toBeGreaterThan(0);
    expect(refused).toEqual(KNOWN_SEAM_REFUSALS);
  });
});

describe("rule-scope — abandonOptions (D9)", () => {
  const fake = (o: string[]) => ({ key: "fake", abandonOptions: o }) as unknown as AnySportModule;

  it("reads the module's own list through ABANDON_LABELS, in its order; empty stays empty; an unmapped value throws", () => {
    expect(abandonOptions(fake(["q4_stands", "replay"])).map((x) => x.value)).toEqual(["q4_stands", "replay"]);
    expect(abandonOptions(fake([]))).toEqual([]);
    expect(() => abandonOptions(fake(["nope"]))).toThrow();
  });

  it("a module that declares no list offers none; an inherited property name is unmapped, not a label", () => {
    expect(abandonOptions({ key: "bare" } as unknown as AnySportModule)).toEqual([]);
    expect(() => abandonOptions(fake(["constructor"]))).toThrow();
    expect(() => abandonOptions(fake(["toString"]))).toThrow();
  });

  it("each option carries its table label, and the table names exactly the four policies (D9) with distinct non-empty labels", () => {
    expect(Object.keys(ABANDON_LABELS).sort()).toEqual(["award", "q4_stands", "replay", "share"]);
    const opts = abandonOptions(fake(["replay", "award", "q4_stands", "share"]));
    expect(opts.map((o) => o.label)).toEqual([ABANDON_LABELS.replay, ABANDON_LABELS.award, ABANDON_LABELS.q4_stands, ABANDON_LABELS.share]);
    expect(new Set(opts.map((o) => o.label)).size, "distinct labels").toBe(4);
    for (const o of opts) expect(o.label.length, o.value).toBeGreaterThan(0);
  });
});
