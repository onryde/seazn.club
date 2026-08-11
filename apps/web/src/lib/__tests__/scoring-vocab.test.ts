import { describe, it, expect } from "vitest";
import {
  wicketLabel, extraLabel, sportLabel, swatchLabel,
  eventLabel, enumLabel, engineErrorLabel, scoringErrorText, positionLabel,
  padLabel, squadRoleLabel, squadProvenanceLabel, configLabel, playerStatLabel,
  EVENT_KEY, ENUM_VOCAB, ENGINE_ERROR_KEY, POSITION_KEY, PAD_LABEL_KEYS,
  SCORING_VOCAB_KEYS, type MsgFn,
} from "@/lib/scoring-vocab";
import { builtinModules } from "@seazn/engine/sports";
import { EngineErrorCode, matchPositionOf, SquadRole } from "@seazn/engine/core";
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
  }
  return [...out].sort();
}

interface EngineModule {
  key: string;
  fidelityTiers?: readonly { eventTypes: readonly string[] }[];
  eventSchema?: unknown;
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
    for (const key of PAD_LABEL_KEYS) {
      expect([...declared.keys()], `PAD_LABEL_KEYS has "${key}", which no module emits`).toContain(key);
    }
  });

  it("resolves a pad label against the real en dictionary, and falls back to the engine's English", () => {
    expect(padLabel("pad.cricket.action.wicket", en, "Wicket")).toBe("Wicket");
    expect(padLabel("pad.cricket.action.wicket.field.incoming", en, "Incoming batter")).toBe("Incoming batter");
    expect(padLabel("pad.icehockey.action.shootoutAttempt", en, "GWS attempt")).toBe("GWS attempt");
    expect(padLabel("pad.cricket.action.wicket", echo, "Wicket")).toBe("«pad.cricket.action.wicket»");
    // Unknown key: the engine's own English, never a humanized token.
    expect(padLabel("pad.kabaddi.action.raid", echo, "Raid")).toBe("Raid");
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
