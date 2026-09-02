import { describe, it, expect } from "vitest";
import {
  wicketLabel, extraLabel, sportLabel, swatchLabel,
  eventLabel, enumLabel, engineErrorLabel, scoringErrorText, positionLabel,
  padLabel, squadRoleLabel, squadProvenanceLabel, configLabel, playerStatLabel,
  decidedOutcomeText, shootoutScoreFromDetail, decidedOutcomeTemplates, renderDecidedOutcome,
  EVENT_KEY, ENUM_VOCAB, ENGINE_ERROR_KEY, POSITION_KEY, PAD_LABEL_KEYS,
  SCORING_VOCAB_KEYS, SPORT_KEY, type MsgFn,
} from "@/lib/scoring-vocab";
import { interpolate } from "@/lib/i18n-runtime";
import { buildRibbon, ribbonKeyFor, CORE_RIBBON_KEY } from "@/components/v2/scorepad/v3/ribbon";
import { builtinModules } from "@seazn/engine/sports";
import { CORE_EVENT_SCHEMAS, EngineErrorCode, matchPositionOf, SquadRole } from "@seazn/engine/core";
import { buildStream, defaultLineupPair } from "@seazn/engine/testkit";
import uiEn from "@/dictionaries/en/ui.json";
import uiEs from "@/dictionaries/es/ui.json";
import uiFr from "@/dictionaries/fr/ui.json";
import uiNl from "@/dictionaries/nl/ui.json";

// Stub translator: echoes the key so we can prove which key each helper looks up.
const echo: MsgFn = (k) => `«${k}»`;
// Real en lookup, to prove keys resolve against the actual dictionary.
const en: MsgFn = (k) => (uiEn as Record<string, string>)[k];

const LOCALES = {
  en: uiEn as Record<string, string>,
  es: uiEs as Record<string, string>,
  fr: uiFr as Record<string, string>,
  nl: uiNl as Record<string, string>,
};

describe("scoring-vocab label helpers", () => {
  it("maps closed-enum values to their key", () => {
    expect(wicketLabel("bowled", echo)).toBe("«wicket.bowled»");
    expect(extraLabel("legbye", echo)).toBe("«extra.legbye»");
    expect(sportLabel("boardgame", echo)).toBe("«sport.boardgame»");
  });

  it("resolves against the real en dictionary", () => {
    expect(sportLabel("boardgame", en)).toBe("Board game");
    expect(wicketLabel("runout", en)).toBe("Run out");
    expect(extraLabel("noball", en)).toBe("No-ball");
  });

  it("falls back to title-case for unknown values (never throws)", () => {
    expect(sportLabel("kabaddi", echo)).toBe("Kabaddi");
    expect(wicketLabel("mankad", echo)).toBe("Mankad");
  });

  it("swatchLabel keys off the palette hex, null-safe", () => {
    expect(swatchLabel("#0f766e", echo)).toBe("«swatch.Teal»");
    expect(swatchLabel("#0f766e", en)).toBe("Teal");
    expect(swatchLabel(null, echo)).toBeNull();
    expect(swatchLabel("#123456", echo)).toBeNull(); // not a palette swatch
  });

  it("every emitted key exists in ALL FOUR dictionaries (exhaustiveness)", () => {
    for (const [locale, dict] of Object.entries(LOCALES)) {
      for (const key of SCORING_VOCAB_KEYS) {
        // Dictionaries are FLAT dotted-key JSON — toHaveProperty checks the
        // literal key before it tries a path walk, so this is a flat lookup.
        expect(dict, `missing ${locale} key ${key}`).toHaveProperty(key);
      }
    }
  });
});

// ── Derived completeness (#427) ───────────────────────────────────────────────
// The expected sets are read from the engine's OWN declarations at test time,
// never hand-copied: a hand-copied list goes stale the moment a wave adds an
// event type, which is precisely the defect #427 exists to close. Add a type or
// an enum member in packages/engine and this suite reds until a label lands in
// all four dictionaries.

/** Every event type any shipped module declares in its fidelity tiers. */
function declaredEventTypes(): string[] {
  const out = new Set<string>();
  for (const m of builtinModules as unknown as EngineModule[]) {
    for (const tier of m.fidelityTiers ?? []) for (const t of tier.eventTypes) out.add(t);
    for (const t of Object.keys(m.eventSchemas ?? {})) out.add(t);
  }
  return [...out].sort();
}

/**
 * Every event type the engine will actually ACCEPT — the union of every
 * module's registered payload schemas.
 *
 * R8/WS-R round 2: `fidelityTiers` alone is the WRONG source, and it was the
 * one `declaredEventTypes()` used. Tiers are a fidelity BANDING of a subset,
 * not a module's declaration of what it accepts, and for three sports they
 * under-report — `setbased/kernel.ts:1816` builds a fixed six-key action map
 * (summary, timeout, sanction, sub, expedite, rally) for EVERY preset and
 * registers a schema for each, while each sport's `fidelityTiers` lists only
 * the ones it bands. Measured against the tree: tiers 63, eventSchemas 68,
 * the five extras being volleyball.expedite.start, badminton.expedite.start,
 * badminton.sub, badminton.timeout and tabletennis.sub. FOUR of those five
 * were live on the raw-type fallback ("badminton.sub recorded") and were
 * invisible to a tiers-derived gate. (The fifth, badminton.timeout, already
 * had four-locale copy — added opportunistically despite the tiers list not
 * naming it, which is its own evidence that tiers are not the declaration.)
 *
 * `eventSchemas` is what the engine accepts, which is the right bar for "no
 * raw internal type ever reaches a scorer". `declaredEventTypes()` takes the
 * UNION of both rather than swapping one source for the other, because the
 * field is OPTIONAL on `SportModule` (module.ts:501) and a module that omits
 * it must still be swept rather than vanish.
 *
 * What that omission actually does (corrected round 3 — this comment used to
 * say such a module would "degrade to its tiers", which undersells it): its
 * tier types would then sit in the derivation but in no module's
 * `eventSchemas`, so `assertNothingTheEngineAcceptsIsMissing`'s EXTRA
 * direction REDS and names them. A hard failure, not a silent degrade —
 * better behaviour than the old wording claimed, and worth stating accurately
 * so nobody removes the union expecting a soft fallback. All eleven shipped
 * modules populate the field today, and no module has a tier type absent from
 * its own schema registry.
 */
function engineAcceptedEventTypes(): string[] {
  const out = new Set<string>();
  for (const m of builtinModules as unknown as EngineModule[]) {
    for (const t of Object.keys(m.eventSchemas ?? {})) out.add(t);
  }
  return [...out].sort();
}

interface EngineModule {
  key: string;
  fidelityTiers?: readonly { eventTypes: readonly string[] }[];
  /** The union of the sport's event PAYLOADS (module.ts:481, required on
   *  SportModule) — what `declaredEnumMembers()` walks for enum options. */
  eventSchema?: unknown;
  /** The per-TYPE payload registry (module.ts:501, optional on SportModule) —
   *  the event types the engine will accept. A different field from
   *  `eventSchema` above, one character apart; do not conflate them. */
  eventSchemas?: Readonly<Record<string, unknown>>;
}

/**
 * Every sport key the engine actually ships (#S13) — the ONLY sport-key list
 * this repo maintains by hand is `builtinModules` itself
 * (`packages/engine/src/sports/index.ts`). `SportKey`/`SPORT_KEY` in
 * scoring-vocab.ts stay hand-written (see that file's #S13 comment for why
 * they can't be derived at the type level: `SportModule.key` is plain
 * `string`, not a literal), so this is what proves they never drift from the
 * engine's real list, in either direction.
 */
function declaredSportKeys(): string[] {
  return builtinModules.map((m) => m.key).sort();
}

/**
 * Walk a module's zod payload union and collect every enum's options, keyed by
 * the FIELD the enum sits on. Payload schemas carry no type discriminator (the
 * event type lives on the envelope), so the field name is the only stable
 * handle — and it is the right one: `kind.other` and `reason.other` are
 * different vocabulary, `color.red` is the same word wherever it appears.
 */
function walkEnums(
  schema: unknown, field: string, out: Map<string, Set<string>>, seen: Set<unknown>, depth = 0,
): void {
  if (!schema || typeof schema !== "object" || depth > 12 || seen.has(schema)) return;
  seen.add(schema);
  const s = schema as Record<string, unknown>;
  const def = (s._def ?? {}) as Record<string, unknown>;
  const kind = (def.type ?? def.typeName) as string | undefined;
  if (kind === "enum" || kind === "ZodEnum") {
    const opts = def.entries
      ? Object.keys(def.entries as object)
      : ((s.options ?? def.values ?? []) as string[]);
    if (!out.has(field)) out.set(field, new Set());
    for (const o of opts) out.get(field)!.add(String(o));
    return;
  }
  if (kind === "literal" || kind === "ZodLiteral") return;
  const shape = (typeof s.shape === "object" && s.shape) ||
    (typeof def.shape === "function" ? (def.shape as () => object)() : def.shape);
  if (shape && typeof shape === "object") {
    for (const [k, v] of Object.entries(shape)) walkEnums(v, k, out, seen, depth + 1);
    return;
  }
  for (const k of ["options", "innerType", "element", "valueType", "left", "right", "in", "out"]) {
    const v = def[k] ?? s[k];
    if (Array.isArray(v)) v.forEach((x) => walkEnums(x, field, out, seen, depth + 1));
    else if (v) walkEnums(v, field, out, seen, depth + 1);
  }
}

/** field name → every enum member the engine can put in it, across all sports. */
function declaredEnumMembers(): Map<string, Set<string>> {
  const all = new Map<string, Set<string>>();
  for (const m of builtinModules as unknown as EngineModule[]) {
    const out = new Map<string, Set<string>>();
    walkEnums(m.eventSchema, "<root>", out, new Set());
    for (const [f, members] of out) {
      if (!all.has(f)) all.set(f, new Set());
      for (const x of members) all.get(f)!.add(x);
    }
  }
  return all;
}

interface DrivableModule {
  key: string;
  positions: unknown;
  configSchema: { parse(value: unknown): unknown };
  init(cfg: unknown, lineups: unknown): unknown;
  apply(state: unknown, envelope: unknown): unknown;
  position?: (state: unknown) => unknown;
}

/**
 * Every position-segment key the projecting sports actually emit (W4a's
 * cross-sport match-position axis, `@seazn/engine/core` position.ts).
 *
 * Folded out of real generated streams, because there is nothing static to
 * read: a module builds its segments INSIDE `position(state)`, and which keys
 * appear depends on the state — a set-based sport only emits `points` while a
 * set is live, a period sport only emits `clock` once a stamp names the phase
 * it resolved to. A hand-copied list is the exact defect this file exists to
 * close, and it already bit once here: the wave's own summary named five keys
 * (`set`, `game`, `innings`, `over`, `board`) and missed three.
 */
function declaredPositionKeys(): { keys: Set<string>; projecting: number } {
  const keys = new Set<string>();
  let projecting = 0;
  for (const sport of builtinModules as unknown as DrivableModule[]) {
    if (sport.position === undefined) continue;
    projecting += 1;
    const cfg = sport.configSchema.parse({});
    const lineups = defaultLineupPair(sport.positions as never);
    for (const seed of [1, 7, 42]) {
      let state: unknown = sport.init(cfg, lineups);
      const collect = () => {
        const position = matchPositionOf(sport as never, state);
        for (const segment of position?.segments ?? []) keys.add(segment.key);
      };
      collect();
      for (const envelope of buildStream(sport as never, cfg as never, lineups, seed, 300)) {
        state = sport.apply(state, envelope);
        collect();
      }
    }
  }
  return { keys, projecting };
}

// ── PadSpec label keys (S7/#427) ─────────────────────────────────────────────
// S6 gave every pad panel and action a `labelKey: {key, label}`, and S7 added
// the same to the fields and attribution items a scorer would otherwise have
// to guess at. NONE of those keys existed in any dictionary: 164 of them, and
// what a scorer would have seen is the engine's baked English on every locale.
//
// DERIVED, never hand-copied — same rule as `declaredEventTypes()` above. The
// wrinkle is that `padSpec` is a function of cfg, so "every key this module can
// emit" is a property of its whole CFG SPACE, not of one call: cricket's super
// over needs `superOver: true` (which no named variant sets), its DLS panel
// needs `dls.enabled`, football's shoot-out panel needs a non-null `shootout`,
// and volleyball's substitution panel needs `records.substitutions`. So the
// space walked is: the default cfg, every named variant, and each of those with
// ONE cfg leaf overridden — booleans to both values, strings to every value any
// variant of that module uses for that leaf. Overrides are merged onto the
// PARSED cfg (never the sparse preset), because several nested cfg objects on
// this kernel family have required inner leaves and a partial override is
// simply rejected — which silently cost 40 keys on the first cut.

interface PadModule {
  key: string;
  variants?: Record<string, Record<string, unknown>>;
  configSchema?: { safeParse(value: unknown): { success: boolean; data?: unknown } };
  padSpec?: (cfg: unknown) => {
    panels: readonly {
      labelKey: { key: string; label: string };
      actions: readonly {
        labelKey: { key: string; label: string };
        fields: readonly { labelKey?: { key: string; label: string } }[];
        attribution: readonly { labelKey?: { key: string; label: string } }[];
      }[];
    }[];
  };
}

type Json = Record<string, unknown>;

function setPath(root: Json, path: string[], value: unknown): Json {
  let cursor = root;
  for (let i = 0; i < path.length - 1; i++) {
    const segment = path[i] as string;
    cursor[segment] = (cursor[segment] as Json | undefined) ?? {};
    cursor = cursor[segment] as Json;
  }
  cursor[path[path.length - 1] as string] = value;
  return root;
}

function deepMerge(base: Json, over: Json): Json {
  const out: Json = { ...base };
  for (const [k, v] of Object.entries(over)) {
    const existing = out[k];
    out[k] =
      v && typeof v === "object" && !Array.isArray(v) && existing && typeof existing === "object"
        ? deepMerge(existing as Json, v as Json)
        : v;
  }
  return out;
}

/** Dotted leaf path → every value worth trying there. Booleans always get
 *  BOTH, so a flag no shipped variant turns on is still explored. */
function cfgLeafValues(cfg: unknown, out: Map<string, Set<unknown>>, prefix: string[] = [], depth = 0): void {
  if (depth > 3 || !cfg || typeof cfg !== "object" || Array.isArray(cfg)) return;
  for (const [k, v] of Object.entries(cfg as Json)) {
    const path = [...prefix, k];
    const id = path.join(".");
    if (typeof v === "boolean") {
      if (!out.has(id)) out.set(id, new Set());
      out.get(id)!.add(true);
      out.get(id)!.add(false);
    } else if (typeof v === "string") {
      if (!out.has(id)) out.set(id, new Set());
      out.get(id)!.add(v);
    } else if (v && typeof v === "object" && !Array.isArray(v)) {
      cfgLeafValues(v, out, path, depth + 1);
    }
  }
}

/** key → the engine's own English, across every module and cfg. */
function declaredPadLabels(): Map<string, { label: string; sport: string }> {
  const found = new Map<string, { label: string; sport: string }>();
  // Named `sport`, not `module` — Next's `no-assign-module-variable` lint rule
  // fires on the latter even as a `for…of` binding.
  for (const sport of builtinModules as unknown as PadModule[]) {
    const { padSpec, configSchema } = sport;
    if (!padSpec || !configSchema) continue;
    const bases: Json[] = [{}, ...Object.values(sport.variants ?? {})];
    const leaves = new Map<string, Set<unknown>>();
    for (const base of bases) {
      const parsed = configSchema.safeParse({ ...base });
      if (parsed.success) cfgLeafValues(parsed.data, leaves);
    }
    const cfgs: Json[] = [...bases];
    for (const base of bases) {
      const parsed = configSchema.safeParse({ ...base });
      if (!parsed.success) continue;
      for (const [id, values] of leaves) {
        for (const value of values) {
          cfgs.push(deepMerge(parsed.data as Json, setPath({}, id.split("."), value)));
        }
      }
    }
    for (const raw of cfgs) {
      const parsed = configSchema.safeParse(raw);
      if (!parsed.success) continue; // not a cfg this module accepts — not padSpec's problem
      for (const panel of padSpec(parsed.data).panels) {
        const record = (l: { key: string; label: string }) => {
          if (!found.has(l.key)) found.set(l.key, { label: l.label, sport: sport.key });
        };
        record(panel.labelKey);
        for (const action of panel.actions) {
          record(action.labelKey);
          for (const field of action.fields) if (field.labelKey) record(field.labelKey);
          for (const item of action.attribution) if (item.labelKey) record(item.labelKey);
        }
      }
    }
  }
  return found;
}

describe("scoring-vocab covers every PadSpec label key the engine declares (#427)", () => {
  const declared = declaredPadLabels();

  it("the cfg-space walk reaches the keys only an off-default cfg can produce", () => {
    // Vacuity guard, and the one that matters most here: an enumeration that
    // only walked the default cfg + named variants returns 123 keys and looks
    // healthy. Pin by name the five that are reachable ONLY through a cfg leaf
    // no shipped variant sets — if the walk regresses to presets-only, these go
    // missing and the dictionary silently loses coverage instead of reding.
    expect(declared.size).toBeGreaterThanOrEqual(164);
    for (const key of [
      "pad.cricket.action.superOverBall", // needs superOver: true
      "pad.cricket.panel.dls", // needs dls.enabled: true
      "pad.football.panel.shootout", // needs a non-null shootout cfg
      "pad.generic.panel.draw", // needs allowDraws: true
      "pad.badminton.action.timeout", // needs records.timeouts: true (BWF has none by default)
    ]) {
      expect([...declared.keys()], `cfg-space walk never produced "${key}"`).toContain(key);
    }
    // Every one of the eleven modules declares a spec, so no sport is silently
    // absent from the coverage loop below.
    expect(new Set([...declared.values()].map((v) => v.sport)).size).toBe(11);
  });

  it("every key the engine can emit is declared here AND in all four dictionaries", () => {
    for (const [key, { label, sport }] of declared) {
      expect(PAD_LABEL_KEYS, `${sport}: no PAD_LABEL_KEYS entry for "${key}" ("${label}")`).toContain(key);
      for (const [locale, dict] of Object.entries(LOCALES)) {
        expect(dict, `missing ${locale} copy for pad label "${key}" ("${label}")`).toHaveProperty(key);
      }
    }
  });

  it("declares no key the engine cannot emit (the list does not rot the other way)", () => {
    // R2/task C — `pad.<sport>.ribbon.<suffix>` (ribbon.ts's own
    // ribbonKeyFor()) is a SECOND, legitimate PAD_LABEL_KEYS membership
    // category alongside engine-declared PadSpec labels: app-authored
    // ribbon prose for an event, gated on THIS SET (buildRibbon checks
    // membership before calling padLabel — R1's own design, ribbon.ts's
    // header), never a PadSpec labelKey the engine emits. `declaredPadLabels`
    // above walks ONLY panel/action/field/attribution labelKeys, so a ribbon
    // key can never appear there by construction — exempted here rather than
    // widening `declared` to synthesize entries the engine never actually
    // declares, which would make the OTHER two exhaustiveness tests in this
    // block lie about what "declared" means.
    //
    // R4/tennis — `pad.<sport>.scorebug.<...>.hint` is a THIRD such category,
    // for the identical reason: `ScorebugHalf.hintKey` (tap model S) is
    // resolved through this SAME `padLabel()` gate (scorebug.tsx), but it is
    // a v3-chassis-only concept no `padSpec(cfg)` panel/action/field ever
    // declares — cricket and football are both tap model T and never needed
    // one. Tennis is the first skin tap model S actually ships on.
    const isRibbonKey = /^pad\.[a-z]+\.ribbon\./;
    const isScorebugHintKey = /^pad\.[a-z]+\.scorebug\..*\.hint$/;
    for (const key of PAD_LABEL_KEYS) {
      if (isRibbonKey.test(key) || isScorebugHintKey.test(key)) continue;
      expect([...declared.keys()], `PAD_LABEL_KEYS has "${key}", which no module emits`).toContain(key);
    }
  });

  // R8/WS-R — v3 ribbon copy for EVERY sport, derived from the engine's own
  // declarations. `buildRibbon` (v3/ribbon.ts) gates its per-sport lookup on
  // PAD_LABEL_KEYS membership BEFORE calling padLabel, so a missing entry —
  // or an entry with no copy in one of the four locales — degrades SILENTLY
  // to the generic `pad.ribbon.fallback` ("{event} recorded"), printing a raw
  // internal type to a scorer with nothing failing. The test above cannot
  // catch it: ribbon keys are exempt there by construction, since no module
  // DECLARES one.
  //
  // Nothing is hand-copied here, and there is deliberately NO allow-list. The
  // event types come from the engine's own fidelity tiers
  // (`declaredEventTypes`) and the key from `ribbonKeyFor` — the SAME
  // function buildRibbon calls, so the `pad.<sport>.ribbon.<rest-of-type>`
  // convention is read off the code rather than restated. Add an event type
  // in packages/engine and this reds until its ribbon copy lands in all four
  // dictionaries.
  //
  // This pair was FOOTBALL-ONLY until R8/WS-R, on an explicit premise written
  // in this very comment: that cricket "deliberately registers ribbon copy
  // for 8 of its 16 declared types and leaves the 'More'-sheet remainder on
  // the graceful fallback". The premise was false twice over. The count was
  // wrong (the engine declares 15 cricket types, not 16), and — the part that
  // mattered — the fallback is NOT graceful: it prints the raw internal type.
  // Seven cricket types were live on it, so a scorer taking the new ball read
  // "cricket.newball recorded" in the ribbon and in the activity row. Those
  // seven (followon, interruption, match.close, newball, player.line,
  // powerplay, revise) are covered now, which leaves ZERO exemptions across
  // all eleven shipped sports — so this gate carries no exemption mechanism
  // at all, on purpose. If one ever looks necessary, the type is uncovered:
  // cover it.
  //
  // All three assertions below COLLECT their misses and compare the whole
  // list to `[]`, rather than asserting inside the loop. A per-iteration
  // assertion stops at the first gap, so a wave that leaves seven types
  // uncovered reads as one — the failure message has to show the true size of
  // the hole, or the next session fixes one key and re-greens on the rest.

  /** The sport prefix of an event type — the same first-segment split
   *  `ribbonKeyFor` itself makes on the way to `pad.<sport>.ribbon.<rest>`. */
  const sportOf = (type: string): string => type.split(".")[0];

  /**
   * Vacuity guard, DERIVED rather than a magic total. An empty or half-loaded
   * derivation satisfies every loop below, so something has to prove the
   * derivation is real — but a hard-coded count (the old `toHaveLength(9)`)
   * only ever proves one sport's arithmetic and needs bumping forever.
   * Asserting that the sport prefixes PRESENT in `declaredEventTypes()` are
   * exactly `declaredSportKeys()` proves both halves at once: the derivation
   * is non-empty, AND every sport the engine ships is actually inside the
   * sweep. A new sport module reds this the day it lands.
   */
  function assertEverySportIsSwept(types: readonly string[]): void {
    expect([...new Set(types.map(sportOf))].sort(), "declaredEventTypes() does not span every shipped sport").toEqual(
      declaredSportKeys(),
    );
    assertNothingTheEngineAcceptsIsMissing(types);
  }

  /**
   * The SECOND vacuity guard, and the one round 1 needed and did not have.
   *
   * The prefix-set guard above proves every SPORT is present. It does not
   * prove every TYPE is: it passed identically at 63 types and at 68, because
   * the five it was missing all belonged to sports that were already in the
   * set by way of their other types. A partial derivation is the more
   * dangerous shape than an empty one — it under-reports instead of zeroing,
   * so every dependent assertion stays GREEN while the defect ships. That is
   * exactly what happened: four raw-type leaks (volleyball.expedite.start,
   * badminton.expedite.start, badminton.sub, tabletennis.sub) sat outside a
   * green gate.
   *
   * So compare against every type the engine registers a payload schema for.
   * Both directions are named, and each means something different. MISSING =
   * the derivation under-reports and the sweep has a blind spot (the
   * `fidelityTiers` regression). EXTRA = a module lost its `eventSchemas`
   * registry and is carried by its tiers alone.
   *
   * CAVEAT, because this reads as broader cover than it is: while
   * `declaredEventTypes()` keeps its `eventSchemas` line, `derived` is a
   * SUPERSET of `accepted` by construction, so `missing` is structurally
   * always `[]`. This is therefore NOT an independent cross-check of the
   * enumeration. Its real and only job is catching a REPOINT of that
   * derivation — someone "simplifying" it back to `fidelityTiers` alone —
   * which is exactly the regression that shipped four raw-type leaks, and
   * which the M5 mutant confirms it catches. Read it as a repoint tripwire,
   * not as proof the enumeration is complete.
   *
   * Asserted as two separate arrays, not one object: vitest elides a
   * composite to `...(5)` and the message would carry neither the count nor
   * the names — the failure that made this test necessary would report as a
   * shrug. Same rule as the three assertions above (see :116-120).
   */
  function assertNothingTheEngineAcceptsIsMissing(types: readonly string[]): void {
    const derived = new Set(types);
    const accepted = engineAcceptedEventTypes();
    const missing = accepted.filter((t) => !derived.has(t));
    const extra = [...derived].filter((t) => !accepted.includes(t)).sort();
    expect(
      missing,
      `${missing.length} type(s) the engine accepts are MISSING from the enumeration ` +
        `(${accepted.length} schema-registered) — has declaredEventTypes() been repointed at fidelityTiers?`,
    ).toEqual([]);
    expect(
      extra,
      `${extra.length} enumerated type(s) are in NO module's eventSchemas — has a module lost its registry?`,
    ).toEqual([]);
  }

  /**
   * A real locale dictionary behind an interpolating `MsgFn`, using the
   * shipped `interpolate()`. Deliberately the real JSON and not a stub: a
   * fixture on BOTH ends of `buildRibbon` would only prove the fixture. A key
   * with no copy resolves to the empty string rather than `undefined`, so a
   * dictionary hole surfaces as the assertion it belongs to (an empty ribbon)
   * instead of a TypeError halfway down the loop.
   */
  function msgFnFor(locale: keyof typeof LOCALES): MsgFn {
    return (key, vars) => interpolate(LOCALES[locale][key] ?? "", vars);
  }

  it("registers four-locale ribbon copy for every event type the engine declares, in every sport", () => {
    const types = declaredEventTypes();
    assertEverySportIsSwept(types);
    const missing: string[] = [];
    for (const type of types) {
      const key = ribbonKeyFor(type);
      if (!(PAD_LABEL_KEYS as readonly string[]).includes(key)) missing.push(`${type}: no PAD_LABEL_KEYS entry for "${key}"`);
      for (const [locale, dict] of Object.entries(LOCALES)) {
        if (dict[key] === undefined) missing.push(`${type}: no ${locale} copy for "${key}"`);
      }
    }
    expect(missing, `${missing.length} ribbon gap(s) — a scorer reads the raw internal type for these`).toEqual([]);
  });

  // …and the registrations above actually CHANGE what a scorer reads. The
  // membership half would still pass if buildRibbon's own gate regressed, so
  // this half drives the REAL builder against the REAL en dictionary: every
  // declared event must render its own registered sentence, and must NEVER
  // render the generic `pad.ribbon.fallback` — "cricket.newball recorded" and
  // "football.goal recorded" are the exact strings this gate exists to keep
  // off a scorer's screen.
  it("renders each sport's own ribbon sentence, never the raw-event-type fallback", () => {
    const t = msgFnFor("en");
    const types = declaredEventTypes();
    assertEverySportIsSwept(types);
    const wrong: string[] = [];
    for (const type of types) {
      const { text } = buildRibbon(type, {}, () => "", t);
      if (text.includes(type)) wrong.push(`${type} fell through to the generic fallback: "${text}"`);
      else if (text !== LOCALES.en[ribbonKeyFor(type)]) wrong.push(`${type} did not resolve to its own copy: "${text}"`);
    }
    expect(wrong, `${wrong.length} event type(s) do not render their own ribbon sentence`).toEqual([]);
  });

  // The leak this wave closed has a SHAPE of its own, wider than the two
  // assertions above: a dot-joined internal identifier reaching a scorer's
  // eye. `text.includes(type)` catches the fallback rendering *this* type;
  // this catches any dotted internal token at all — a fallback keyed on a
  // neighbouring type, a half-interpolated key, a translator who pasted the
  // key instead of prose. Run across all four locales because the fallback is
  // locale-independent: the raw type is the same leak in Spanish. Real
  // dictionaries + the real `buildRibbon`, per the same rule as above.
  // R8/WS-R (scope extension) — a copy defect in the same event's OTHER
  // surface. `event.cricket.player.line` read "Batting order" / "Orden de
  // bateo" / "Ordre de batte" / "Slagvolgorde" in all four locales, naming a
  // concept the event does not carry: the engine declares `CricketPlayerLine`
  // as a per-player innings SCORECARD LINE — `z.strictObject({ innings,
  // person, batting {runs, balls, out}, bowling {legalBalls, runs, wickets} })`
  // (packages/engine/src/sports/cricket/cricket.ts:304). Nothing in the
  // payload is an order.
  //
  // This is live, not legacy: `eventLabel` (scoring-vocab.ts) → `describeEvent`'s
  // single `badge` (event-copy.ts:89) → `activity.tsx:47`, so it is the badge a
  // scorer reads on that row of the v3 Activity panel — the same row whose
  // sentence is `pad.cricket.ribbon.player.line`. No test pinned the old
  // string, which is why it survived (checked before changing it: the only
  // "Batting order" in the tree outside the dictionaries is prose about a
  // real order — a different concept, correctly named. Round 3 correction:
  // there are TWO such occurrences, not one, and the symbol is
  // `SquadMember.orderNo` (packages/engine/src/core/lineup.ts:56-61), not
  // `LineupEntry.order`, which does not exist — `LineupEntry` is a
  // core.lineup.* payload, an unrelated type. The second occurrence is
  // design/v2/04-sport-scoring-specs.md:160, which spells the same field
  // `LineupSlot.order_no`.)
  //
  // Pinned two ways, neither a frozen full string. The order-word check
  // witnesses THIS defect and reds on a straight revert; the badge/sentence
  // agreement is the half that cannot rot silently, because the two strings
  // render on the SAME row — move one and the other must move with it.
  it("names cricket.player.line for what the engine declares — a scorecard line, not a batting order", () => {
    const ORDER_WORD = /order|orden|ordre|volgorde/i;
    const disagreements: string[] = [];
    for (const [locale, dict] of Object.entries(LOCALES)) {
      const badge = dict[EVENT_KEY["cricket.player.line"]];
      const sentence = dict[ribbonKeyFor("cricket.player.line")];
      if (badge === undefined || sentence === undefined) {
        disagreements.push(`${locale}: badge=${badge} sentence=${sentence}`);
        continue;
      }
      if (ORDER_WORD.test(badge)) disagreements.push(`${locale}: badge "${badge}" still names an ORDER`);
      if (!sentence.startsWith(badge)) {
        disagreements.push(`${locale}: badge "${badge}" and ribbon "${sentence}" disagree on the same row`);
      }
    }
    expect(disagreements, "cricket.player.line copy does not match the payload the engine declares").toEqual([]);
  });

  const DOTTED_INTERNAL_TOKEN = /[a-z][a-z0-9]*\.[a-z][a-z0-9]*/;

  // R8/WS-R round 3 — the `core.*` namespace, which every assertion above
  // misses BY CONSTRUCTION and which round 2's header wrongly claimed was
  // covered.
  //
  // `core.*` events are kernel-owned: no sport module declares them, so they
  // appear in neither `fidelityTiers` nor any `module.eventSchemas`, and
  // `declaredEventTypes()` is sport-prefixed. `assertEverySportIsSwept` pins
  // the prefix set to the eleven module keys, so a `core.` prefix could not
  // join the sweep even if something added it — it would FAIL the guard. They
  // reach a scorer through a different door: `buildRibbon` checks
  // `CORE_RIBBON_KEY` (v3/ribbon.ts) FIRST, before the per-sport lookup.
  //
  // That map is maintained BY HAND, which is the whole risk. All 14 entries
  // are mapped and translated today, so there is no live leak — but a future
  // `core.x` with no entry falls to `pad.ribbon.fallback` and reproduces D1
  // verbatim: "core.start recorded", the string a 320px screenshot caught.
  // Same defect class as the seven cricket types this wave fixed, one
  // namespace over, and invisible to every gate above.
  //
  // Derived from the engine's own `CORE_EVENT_SCHEMAS`
  // (packages/engine/src/core/events.ts:82) — never a hand-copied list, for
  // the same reason as everywhere else in this file. Both directions matter:
  // a MISSING entry is the D1 leak; an ORPHAN entry is a map that outlived
  // the type it served, which is how a hand-maintained map rots quietly.
  it("maps every core.* event type the engine declares, with four-locale copy", () => {
    const coreTypes = Object.keys(CORE_EVENT_SCHEMAS).sort();
    // Vacuity guards, both derived: an empty registry satisfies every loop
    // below, and a non-core key here would mean this sweep is pointed at the
    // wrong registry entirely.
    expect(coreTypes, "CORE_EVENT_SCHEMAS is empty").not.toHaveLength(0);
    expect(coreTypes.filter((t) => !t.startsWith("core.")), "non-core key in CORE_EVENT_SCHEMAS").toEqual([]);

    const gaps: string[] = [];
    for (const type of coreTypes) {
      const key = CORE_RIBBON_KEY[type];
      if (key === undefined) {
        gaps.push(`${type}: no CORE_RIBBON_KEY entry — falls to the raw-type fallback`);
        continue;
      }
      for (const [locale, dict] of Object.entries(LOCALES)) {
        if (dict[key] === undefined) gaps.push(`${type}: no ${locale} copy for "${key}"`);
      }
    }
    const orphans = Object.keys(CORE_RIBBON_KEY).filter((t) => !coreTypes.includes(t)).sort();
    // Two assertions, not one object, for the reason spelled out on
    // `assertNothingTheEngineAcceptsIsMissing` above: vitest elides a
    // composite and the message must carry the size of the hole itself.
    expect(
      gaps,
      `${gaps.length} core type(s) would print a raw internal type to a scorer ` +
        `(of ${coreTypes.length} the engine declares) — the D1 defect, reopened`,
    ).toEqual([]);
    expect(
      orphans,
      `${orphans.length} CORE_RIBBON_KEY entr(y/ies) map a type the engine no longer declares`,
    ).toEqual([]);
  });

  // …and the behavioural half, for the same reason the sport pair has one:
  // membership in CORE_RIBBON_KEY would still pass if buildRibbon stopped
  // consulting it. Real dictionaries, real builder, all four locales.
  it("renders every core.* event's own sentence, never the raw-event-type fallback", () => {
    const coreTypes = Object.keys(CORE_EVENT_SCHEMAS).sort();
    expect(coreTypes, "CORE_EVENT_SCHEMAS is empty").not.toHaveLength(0);
    const leaked: string[] = [];
    for (const locale of Object.keys(LOCALES) as (keyof typeof LOCALES)[]) {
      const t = msgFnFor(locale);
      for (const type of coreTypes) {
        const { text } = buildRibbon(type, {}, () => "", t);
        if (text === "") leaked.push(`${locale}/${type} rendered nothing`);
        else if (text.includes(type)) leaked.push(`${locale}/${type} fell through to the fallback: "${text}"`);
        else if (DOTTED_INTERNAL_TOKEN.test(text)) leaked.push(`${locale}/${type} printed an identifier: "${text}"`);
      }
    }
    expect(leaked, `${leaked.length} core ribbon line(s) show a scorer an internal identifier`).toEqual([]);
  });


  it("never prints a dot-joined internal identifier to a scorer, in any of the four locales", () => {
    const types = declaredEventTypes();
    assertEverySportIsSwept(types);
    const leaked: string[] = [];
    for (const locale of Object.keys(LOCALES) as (keyof typeof LOCALES)[]) {
      const t = msgFnFor(locale);
      for (const type of types) {
        const { text } = buildRibbon(type, {}, () => "", t);
        if (text === "") leaked.push(`${locale}/${type} rendered nothing`);
        else if (DOTTED_INTERNAL_TOKEN.test(text)) leaked.push(`${locale}/${type} printed an internal identifier: "${text}"`);
      }
    }
    expect(leaked, `${leaked.length} ribbon line(s) show a scorer an internal identifier`).toEqual([]);
  });

  it("resolves a pad label against the real en dictionary, and falls back to the engine's English", () => {
    expect(padLabel("pad.cricket.action.wicket", en, "Wicket")).toBe("Wicket");
    expect(padLabel("pad.cricket.action.wicket.field.incoming", en, "Incoming batter")).toBe("Incoming batter");
    expect(padLabel("pad.icehockey.action.shootoutAttempt", en, "GWS attempt")).toBe("GWS attempt");
    expect(padLabel("pad.cricket.action.wicket", echo, "Wicket")).toBe("«pad.cricket.action.wicket»");
    // Unknown key: the engine's own English, never a humanized token.
    expect(padLabel("pad.kabaddi.action.raid", echo, "Raid")).toBe("Raid");
  });

  it("threads an optional vars object through to the translator, additively (R1 chassis Task 11, Ruling G)", () => {
    // padLabel's own MsgFn originally took no vars, so a per-sport
    // interpolating sentence (e.g. v3/ribbon.ts's future "FOUR · Kannan ·
    // through covers", design spec §2.2) could never reach the translator
    // through this path. No real pad.<sport>.ribbon.* key is registered
    // yet (v3/ribbon.ts's own header comment: R1 ships the fallback path
    // only), so this proves the plumbing end to end against an existing
    // per-sport PAD_LABEL_KEYS entry instead — padLabel routes every
    // registered key through the same code, whatever its own suffix.
    const withVars: MsgFn = (key, vars) => (vars ? `${key}::${JSON.stringify(vars)}` : `${key}::novars`);
    expect(padLabel("pad.cricket.action.wicket", withVars, "Wicket", { scorer: "Kannan" })).toBe(
      'pad.cricket.action.wicket::{"scorer":"Kannan"}',
    );
    // Existing callers never pass a 4th argument — the no-vars path is
    // untouched by the widening.
    expect(padLabel("pad.cricket.action.wicket", withVars, "Wicket")).toBe("pad.cricket.action.wicket::novars");
    // An unregistered key still falls back to engineLabel and never
    // reaches the translator at all, vars or not.
    expect(padLabel("pad.kabaddi.action.raid", withVars, "Raid", { x: 1 })).toBe("Raid");
  });

  it("translates rather than copying English — every locale differs from en somewhere", () => {
    // A locale file filled by copy-paste would pass every assertion above.
    // Pin that each locale really carries its own copy for these keys.
    for (const locale of ["es", "fr", "nl"] as const) {
      const differing = PAD_LABEL_KEYS.filter(
        (k) => LOCALES[locale][k] !== undefined && LOCALES[locale][k] !== LOCALES.en[k],
      );
      expect(differing.length, `${locale} copied en for all but ${differing.length} pad keys`).toBeGreaterThan(100);
    }
  });
});

describe("scoring-vocab covers what the engine declares", () => {
  // Vacuity guards. A derivation that silently returns nothing — a zod internals
  // change, a renamed field — would make every assertion below pass while
  // proving nothing, so pin the shape of the derived sets first.
  it("the derivation actually reaches the engine's declarations", () => {
    const types = declaredEventTypes();
    expect(types.length).toBeGreaterThanOrEqual(55);
    expect(types).toContain("tabletennis.expedite.start");
    expect(types).toContain("tennis.interruption");
    expect(types).toContain("football.sinbin.start");
    expect(types).toContain("hockey.suspension.end");

    const enums = declaredEnumMembers();
    expect([...enums.keys()].sort()).toEqual(
      // S4 (#428) — `offence` joined this list: FootballPenalty.offence, the
      // Law 12 offence that conceded the kick.
      ["color", "elected", "kind", "level", "method", "offence", "outcome", "phase", "reason", "receiverSide"],
    );
    // W4a's own additions, one per sport that grew an enum.
    expect([...(enums.get("method") ?? [])]).toEqual(
      expect.arrayContaining(["repetition", "fifty_move", "dead_position", "illegal_move"]),
    );
    expect([...(enums.get("kind") ?? [])]).toEqual(
      expect.arrayContaining(["medical", "toilet", "heat", "other"]),
    );
    expect([...enums.values()].reduce((n, s) => n + s.size, 0)).toBeGreaterThanOrEqual(85);

    expect(EngineErrorCode.options.length).toBeGreaterThanOrEqual(17);
    expect(EngineErrorCode.options).toEqual(
      expect.arrayContaining([
        "NON_MONOTONIC_TIME", "UNKNOWN_PHASE", "EXPEDITE_WRONG_WINNER", "SUB_WINDOW_EXCEEDED",
      ]),
    );

    // Vacuity guard for the sport-key derivation below: a fold that silently
    // returned nothing would make the equality check that follows pass over
    // two empty arrays.
    const sportKeys = declaredSportKeys();
    expect(sportKeys.length).toBeGreaterThanOrEqual(11);
    expect(sportKeys).toContain("cricket");
    expect(sportKeys).toContain("icehockey");
  });

  // #S13 — `SportKey`/`SPORT_KEY` (scoring-vocab.ts) used to be an independent
  // eleven-member union nothing pinned to the engine. `SportModule.key` is
  // declared plain `string`, not a literal (`packages/engine/src/sport/
  // module.ts`), so there is no type-level trick that derives a literal union
  // from `builtinModules` without editing all eleven modules' own object
  // literals — out of scope here. This is the runtime pin instead: exactly
  // the engine's key set, no more (a stale extra `SPORT_KEY` entry) and no
  // fewer (a sport the engine ships with no label).
  it("SPORT_KEY carries exactly the engine's sport keys — none missing, none stale", () => {
    expect(Object.keys(SPORT_KEY).sort()).toEqual(declaredSportKeys());
  });

  it("the position derivation reaches every projecting sport", () => {
    // Vacuity guard. A fold that produced nothing — a renamed member, a stream
    // generator that stops at seq 0 — would make the coverage loop below pass
    // over an empty set. Pin the shape, and pin by name the three keys the
    // wave's hand-written summary of this axis left out.
    const { keys, projecting } = declaredPositionKeys();
    expect(projecting).toBe(9); // boardgame and generic honestly abstain
    expect(keys.size).toBeGreaterThanOrEqual(8);
    for (const key of ["set", "game", "innings", "over", "board", "points", "period", "clock"]) {
      expect(keys, `stream fold never emitted position key "${key}"`).toContain(key);
    }
  });

  it("labels every position segment key the engine emits", () => {
    for (const key of declaredPositionKeys().keys) {
      expect(POSITION_KEY, `no label for position segment key "${key}"`).toHaveProperty([key]);
    }
  });

  it("resolves position copy against the real en dictionary, and falls back", () => {
    expect(positionLabel("over", en)).toBe("Over");
    expect(positionLabel("clock", en)).toBe("Clock");
    expect(positionLabel("board", echo)).toBe("«scoring.position.board»");
    // Unknown key: the engine's own English label wins over a humanized token.
    expect(positionLabel("frame", echo, "Frame")).toBe("Frame");
    expect(positionLabel("half_inning", echo)).toBe("Half inning");
  });

  it("exports the vocabulary maps the coverage assertions read", () => {
    // Vite resolves a missing named export to `undefined`, so a coverage loop
    // over an absent map is vacuously green. Prove the maps exist first.
    expect(EVENT_KEY).toBeTypeOf("object");
    expect(ENUM_VOCAB).toBeTypeOf("object");
    expect(ENGINE_ERROR_KEY).toBeTypeOf("object");
    expect(POSITION_KEY).toBeTypeOf("object");
    expect(positionLabel).toBeTypeOf("function");
    expect(eventLabel).toBeTypeOf("function");
    expect(enumLabel).toBeTypeOf("function");
    expect(engineErrorLabel).toBeTypeOf("function");
  });

  it("labels every event type the engine declares", () => {
    for (const type of declaredEventTypes()) {
      expect(EVENT_KEY, `no label for event type ${type}`).toHaveProperty([type]);
    }
  });

  it("labels every enum member the engine declares", () => {
    for (const [field, members] of declaredEnumMembers()) {
      const maps = ENUM_VOCAB[field];
      expect(maps, `no vocabulary bound for enum field "${field}"`).toBeDefined();
      for (const member of members) {
        const covered = maps.some((m) => Object.prototype.hasOwnProperty.call(m, member));
        expect(covered, `no label for ${field} member "${member}"`).toBe(true);
      }
    }
  });

  it("labels every engine error code (they reach the scorer's screen)", () => {
    for (const code of EngineErrorCode.options) {
      expect(ENGINE_ERROR_KEY, `no copy for EngineErrorCode ${code}`).toHaveProperty([code]);
    }
  });

  it("resolves the new W4a vocabulary against the real en dictionary", () => {
    expect(eventLabel("tabletennis.expedite.start", en)).toBe("Expedite system");
    expect(eventLabel("tennis.interruption", en)).toBe("Interruption");
    expect(enumLabel("method", "fifty_move", en)).toBe("Fifty-move rule");
    expect(enumLabel("kind", "toilet", en)).toBe("Toilet break");
    expect(engineErrorLabel("EXPEDITE_WRONG_WINNER", en)).toBe(
      "Under the expedite system the receiver wins that rally. Check who won it.",
    );
  });

  it("resolves the new S5 (#431) vocabulary against the real en dictionary", () => {
    expect(eventLabel("tennis.game.award", en)).toBe("Game award");
    expect(engineErrorLabel("GAME_AWARD_DURING_TIEBREAK", en)).toBe(
      "A game can't be awarded during a tie-break — the tie-break itself is the deciding game.",
    );
  });

  it("falls back rather than throwing on vocabulary it does not know", () => {
    expect(eventLabel("kabaddi.raid", echo)).toBe("Raid");
    expect(enumLabel("kind", "mankad", echo)).toBe("Mankad");
    expect(enumLabel("nosuchfield", "x", echo)).toBe("X");
  });

  // S3/W4b (#426)'s two lineup enums. Unlike the pad keys above these ARE
  // closed TS unions, so the Record<Enum, MessageKey> maps in scoring-vocab.ts
  // are compiler-forced: adding a member to `SquadRole` or `SquadProvenance`
  // in the engine fails `tsc` on that file until copy exists. This block is
  // the runtime half — that the mapped keys resolve, in all four locales.
  it("labels every SquadRole the engine declares", () => {
    expect(SquadRole.options).toEqual(["player", "coach", "staff"]);
    for (const role of SquadRole.options) {
      expect(squadRoleLabel(role, echo)).toBe(`«squadRole.${role}»`);
      for (const [locale, dict] of Object.entries(LOCALES)) {
        expect(dict, `${locale} squadRole.${role}`).toHaveProperty(`squadRole.${role}`);
      }
    }
    expect(squadRoleLabel("player", en)).toBe("Player");
    expect(squadRoleLabel("staff", en)).toBe("Team staff");
    expect(squadRoleLabel("mascot", echo)).toBe("Mascot"); // never throws
  });

  it("labels both lineup provenances, and they do not read the same", () => {
    // `named` vs `added` is the whole point of the field (a team-sheet member
    // vs a mid-fixture call-up), so identical copy would defeat it.
    for (const provenance of ["named", "added"] as const) {
      expect(squadProvenanceLabel(provenance, echo)).toBe(`«squadProvenance.${provenance}»`);
      for (const [locale, dict] of Object.entries(LOCALES)) {
        expect(dict, `${locale} squadProvenance.${provenance}`).toHaveProperty(
          `squadProvenance.${provenance}`,
        );
      }
    }
    for (const [locale, dict] of Object.entries(LOCALES)) {
      const m: MsgFn = (k) => dict[k];
      expect(
        squadProvenanceLabel("named", m),
        `${locale}: named and added read identically`,
      ).not.toBe(squadProvenanceLabel("added", m));
    }
  });

  // #431 item 8 — `generic.score.points` (the per-person running tally) and
  // `GenericCfg.points` (the win/draw/loss table) "are different things" and
  // shared one word. `configLabel` is scoring-vocab's handle on the cfg one;
  // it reuses the copy `division-settings.tsx` already draws over that exact
  // object rather than minting a second string for one concept.
  it("disambiguates generic's two `points`, in all four locales", () => {
    expect(configLabel("points", echo)).toBe("«divset.standingsPoints»");
    expect(configLabel("points", en)).toBe("Standings points");
    expect(playerStatLabel("generic", "points", en)).toBe("Points");
    for (const [locale, dict] of Object.entries(LOCALES)) {
      const m: MsgFn = (k) => dict[k];
      const cfg = configLabel("points", m) ?? "";
      const stat = playerStatLabel("generic", "points", m);
      expect(cfg, `${locale}: cfg points has no copy`).not.toBe("");
      expect(cfg, `${locale}: the tally and the points table read identically`).not.toBe(stat);
      // The cfg one carries a qualifier the bare stat column does not — a
      // regression that re-copied "Points" into it would pass a bare !==.
      expect(cfg.length, `${locale}: cfg points is not qualified`).toBeGreaterThan(stat.length);
    }
  });

  it("returns null for a cfg knob this app has no copy for (never a humanized token)", () => {
    // `Cfg.reviews.perInnings` is the live example: declared in the engine,
    // rendered nowhere in apps/web (S7 grepped), so it gets no label rather
    // than an organiser being shown "Perinnings".
    expect(configLabel("perInnings", echo)).toBeNull();
    expect(configLabel("nosuchknob", echo)).toBeNull();
  });
});

describe("scoringErrorText keeps engine English off the scorer's screen", () => {
  // The pads used to do `setError(err.message)`, which rendered the engine's
  // own English EngineError.message verbatim in every locale — the API
  // serialises it into the error envelope and ApiV1Error carries it through.
  const fr: MsgFn = (k) => (uiFr as Record<string, string>)[k];

  it("prefers localized copy for an engine code over the raw English message", () => {
    expect(
      scoringErrorText("EXPEDITE_WRONG_WINNER", "expedite: receiver wins", fr, "device.failed"),
    ).toBe(uiFr["engineError.EXPEDITE_WRONG_WINNER"]);
    expect(
      scoringErrorText("SUB_WINDOW_EXCEEDED", "sub window exceeded", fr, "device.failed"),
    ).toBe(uiFr["engineError.SUB_WINDOW_EXCEEDED"]);
    expect(
      scoringErrorText("GAME_AWARD_DURING_TIEBREAK", "game award during tiebreak", fr, "device.failed"),
    ).toBe(uiFr["engineError.GAME_AWARD_DURING_TIEBREAK"]);
    expect(scoringErrorText("NON_MONOTONIC_TIME", "at precedes high-water mark", fr, "device.failed"))
      .not.toContain("high-water");
  });

  it("keeps the raw message for a non-engine failure, and the fallback for none", () => {
    expect(scoringErrorText("RATE_LIMITED", "Slow down", fr, "device.failed")).toBe("Slow down");
    expect(scoringErrorText(null, null, fr, "device.failed")).toBe(uiFr["device.failed"]);
    expect(scoringErrorText("UNKNOWN", "", fr, "device.failed")).toBe(uiFr["device.failed"]);
  });
});

// R3.5/Task G — a decided fixture's own MatchOutcome (kind/winner/loser/method)
// reached both the public fixture page and the organiser console as data and
// had nothing rendering it: a reader had to decode "1 — 1 (3–0 pens)" for
// themselves. ONE function composes the sentence for both surfaces so they
// cannot drift on which methods get a clause and which fall back to plain.
describe("decidedOutcomeText — a decided fixture names the winner and, where mapped, the method", () => {
  const winnerName = "Riverside FC";
  const names: Record<string, string> = { W: winnerName, L: "Oakdale United" };
  // A real interpolating en lookup (unlike the module-level `en` stub above,
  // which ignores `vars` entirely) — proves the ACTUAL dictionary template
  // reads correctly with real values substituted in, not just that the right
  // key was selected.
  const say: MsgFn = (k, vars) => interpolate((uiEn as Record<string, string>)[k] ?? k, vars);

  it("F18: shootout — names the winner and the penalty score", () => {
    expect(
      decidedOutcomeText({ kind: "win", winner: "W", method: "shootout" }, names, say, { home: 3, away: 0 }),
    ).toBe("Riverside FC won 3–0 on penalties");
  });

  it("C23: super_over — names the winner, no score in the sentence", () => {
    expect(decidedOutcomeText({ kind: "win", winner: "W", method: "super_over" }, names, say)).toBe(
      "Riverside FC won on the super over",
    );
  });

  it("C13: boundary_count — names the winner", () => {
    expect(decidedOutcomeText({ kind: "win", winner: "W", method: "boundary_count" }, names, say)).toBe(
      "Riverside FC won on boundary count",
    );
  });

  it("extra_time — names the winner", () => {
    expect(decidedOutcomeText({ kind: "win", winner: "W", method: "extra_time" }, names, say)).toBe(
      "Riverside FC won after extra time",
    );
  });

  it("an unmapped method (cricket's dls/innings, football's regulation) falls back to the plain sentence, never the raw token", () => {
    expect(decidedOutcomeText({ kind: "win", winner: "W", method: "dls" }, names, say)).toBe("Riverside FC won");
    expect(decidedOutcomeText({ kind: "win", winner: "W", method: "innings" }, names, say)).toBe("Riverside FC won");
    expect(decidedOutcomeText({ kind: "win", winner: "W", method: "regulation" }, names, say)).toBe(
      "Riverside FC won",
    );
    expect(decidedOutcomeText({ kind: "win", winner: "W", method: "dls" }, names, say)).not.toContain("dls");
  });

  it("an absent method also falls back to the plain sentence", () => {
    expect(decidedOutcomeText({ kind: "win", winner: "W" }, names, say)).toBe("Riverside FC won");
  });

  it("C14/C15: tie — 'Match tied', no name resolution needed", () => {
    expect(decidedOutcomeText({ kind: "tie" }, names, say)).toBe("Match tied");
  });

  it("draw / no_result / no outcome at all: null — nothing this task was asked to describe", () => {
    expect(decidedOutcomeText({ kind: "draw" }, names, say)).toBeNull();
    expect(decidedOutcomeText({ kind: "no_result" }, names, say)).toBeNull();
    expect(decidedOutcomeText(null, names, say)).toBeNull();
    expect(decidedOutcomeText(undefined, names, say)).toBeNull();
  });

  it("an award (forfeit/DQ) win gets the plain sentence too — it always carries a winner, never a method", () => {
    expect(decidedOutcomeText({ kind: "award", winner: "W" }, names, say)).toBe("Riverside FC won");
  });

  it("resolves the winner id through entrantNames, falling back to the raw id when unmapped", () => {
    expect(
      decidedOutcomeText({ kind: "win", winner: "ghost-id", method: "shootout" }, names, say, { home: 1, away: 0 }),
    ).toBe("ghost-id won 1–0 on penalties");
  });

  it("F8 (R3.5 review): shootout with no resolvable score still says 'on penalties' — the method must survive a missing tally, never fall to the bare plain sentence", () => {
    expect(decidedOutcomeText({ kind: "win", winner: "W", method: "shootout" }, names, say)).toBe(
      "Riverside FC won on penalties",
    );
  });
});

// R3.5/Task O — the public fixture page's decided sentence has to update on a
// LIVE poll, not only on the next full page render, and the client polling
// island has no dictionary to call `m()` against (see live-score-no-i18n).
// `decidedOutcomeText` is split into a template half (needs `m`, runs once
// server-side) and an interpolation half (`renderDecidedOutcome`, pure — no
// `MsgFn`, safe for a client island) so the client can substitute a live
// `outcome` into pre-localized copy without a second, hand-kept vocabulary.
describe("decidedOutcomeTemplates / renderDecidedOutcome — the server/client split (R3.5/Task O)", () => {
  const winnerName = "Riverside FC";
  const names: Record<string, string> = { W: winnerName, L: "Oakdale United" };
  const say: MsgFn = (k, vars) => interpolate((uiEn as Record<string, string>)[k] ?? k, vars);
  const templates = decidedOutcomeTemplates(say);

  it("carries a template for every method DECIDED_METHOD_KEY maps, plus the tie, plain and shootoutPlain fallbacks — never blank", () => {
    for (const method of ["shootout", "super_over", "boundary_count", "extra_time"]) {
      expect(templates.byMethod[method], `byMethod.${method}`).toBeTruthy();
    }
    expect(templates.tie).toBeTruthy();
    expect(templates.plain).toBeTruthy();
    // F8 (R3.5 review) — shootout's own score-less fallback, checked
    // separately from `byMethod`: it is a sibling field, not a method entry.
    expect(templates.shootoutPlain).toBeTruthy();
  });

  it("renderDecidedOutcome reproduces decidedOutcomeText's own sentence for every mapped method — one vocabulary, not two", () => {
    for (const method of ["shootout", "super_over", "boundary_count", "extra_time"]) {
      const outcome = { kind: "win", winner: "W", method };
      const score = method === "shootout" ? { home: 3, away: 0 } : undefined;
      expect(renderDecidedOutcome(outcome, names, templates, score)).toBe(
        decidedOutcomeText(outcome, names, say, score),
      );
    }
  });

  it("an unmapped method (cricket's dls) renders the plain fallback template, never blank or the raw token", () => {
    const rendered = renderDecidedOutcome({ kind: "win", winner: "W", method: "dls" }, names, templates, null);
    expect(rendered).toBe("Riverside FC won");
    expect(rendered).not.toContain("dls");
  });

  it("a method the server has never heard of at all still falls back to plain — the client cannot need a string the server did not send", () => {
    expect(
      renderDecidedOutcome({ kind: "win", winner: "W", method: "some_future_method" }, names, templates, null),
    ).toBe("Riverside FC won");
  });

  it("tie, draw, and no-outcome match decidedOutcomeText's own branches", () => {
    expect(renderDecidedOutcome({ kind: "tie" }, names, templates)).toBe("Match tied");
    expect(renderDecidedOutcome({ kind: "draw" }, names, templates)).toBeNull();
    expect(renderDecidedOutcome(null, names, templates)).toBeNull();
  });

  it("F8 (R3.5 review): shootout with no resolvable score renders shootoutPlain, matching decidedOutcomeText — not the bare plain sentence", () => {
    expect(renderDecidedOutcome({ kind: "win", winner: "W", method: "shootout" }, names, templates)).toBe(
      "Riverside FC won on penalties",
    );
  });

  it("F8 (R3.5 review): a byMethod entry missing for shootout still falls back to plain (defensive — a caller-assembled templates object need not be complete)", () => {
    const partial = { ...templates, byMethod: {} };
    expect(
      renderDecidedOutcome({ kind: "win", winner: "W", method: "shootout" }, names, partial, { home: 3, away: 0 }),
    ).toBe("Riverside FC won on penalties");
  });
});

describe("shootoutScoreFromDetail — narrows ScoreSummary.detail without an engine import", () => {
  it("reads football's { shootout: { home, away } } shape (summary(), R3.5/Task H)", () => {
    expect(shootoutScoreFromDetail({ periods: [], shootout: { home: 3, away: 0 } })).toEqual({
      home: 3,
      away: 0,
    });
  });

  it("null for detail with no shootout key (every non-shootout decision)", () => {
    expect(shootoutScoreFromDetail({ periods: [] })).toBeNull();
  });

  it("null for null/undefined/non-object detail, and for a malformed shootout shape", () => {
    expect(shootoutScoreFromDetail(null)).toBeNull();
    expect(shootoutScoreFromDetail(undefined)).toBeNull();
    expect(shootoutScoreFromDetail("nope")).toBeNull();
    expect(shootoutScoreFromDetail({ shootout: { home: "3", away: 0 } })).toBeNull();
  });
});
