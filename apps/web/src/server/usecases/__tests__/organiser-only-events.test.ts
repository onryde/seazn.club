// W2a Task 9 (spec §5.4.5, ruling 77 widened by owner ruling D-O1, X-ST-2): settle, forfeit, abandon — and every
// sport event that records a forfeit or walkover — are organiser-only on the server, per event × per authority.
//
// The sport half is DERIVED from the engine's own declarations, never typed here (fix round 1, review I-1). A
// vocabulary-free sweep applies every module event type × every enum value it declares — the schema's own enum
// fields and the enum fields its padSpec actions offer — under every cfg the sport declares (plus the bracket overlay
// its `bracketDeciders` adds), at the live states its own `arbitraryEvent` walk reaches. Each value is sent the way
// the pad pairs it (the padSpec action offering it, its side attribution named, then null, then omitted), the way
// the schema reads (sides named, then null), and inside the walk's own events of that type. Any value whose
// application ENDS the match without a played result (`award`, `no_result`) is flagged and must be gated or
// excluded with a named reason. The derived gated list — a value that decides the match as itself (the outcome
// names it as its method), as an award, or (a forfeit-vocabulary value) as a no_result — must equal
// lib/organiser-only-events.ts's table.
//
// Authorities are the AuthCtx shapes the real doors produce: a device link minted and resolved through
// `requireFixtureActor` (the dl_ door itself), session officials as `scorers.test.ts` seeds them (an accepted
// fixture_officials row), and the organiser shapes (owner, admin, a write-scoped API key).
import { randomBytes as kekBytes, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { buildPathObject, resolvePositions, type PadAction } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
import { buildWalk, declaredCfgs, defaultLineupPair, makeEnvelope } from "@seazn/engine/testkit";
import { sql } from "@/lib/db";
import {
  isOrganiserOnlyEvent,
  ORGANISER_ONLY,
  ORGANISER_ONLY_EVENT_TYPES,
  ORGANISER_ONLY_SPORT_EVENTS,
} from "@/lib/organiser-only-events";
import { requireFixtureActor, type AuthCtx } from "@/server/api-v1/auth";
import { seedBracket, type SeededBracket } from "@/server/engine-db/__tests__/helpers/seed-bracket";
import { createDeviceLink } from "@/server/usecases/device-links";
import { scoreEvent } from "@/server/usecases/scoring";
import { subjectToScorerCapabilityGates } from "@/server/usecases/scorers";

// Every mint seals (scorer sheets §4.1): a throwaway key of this file's own, never an ambient .env.local one.
vi.stubEnv("DEVICE_LINK_KEK", kekBytes(32).toString("hex"));

const HAS_DB = !!process.env.DATABASE_URL;

/** The core types ruling 77 names (rule row X-ST-2) — the RULING, not the constant under test, so a type dropped
 *  from `ORGANISER_ONLY_EVENT_TYPES` still has its rows here and reds the matrix. */
const RULED_CORE_TYPES = ["core.settle", "core.forfeit", "core.abandon"] as const;

afterAll(async () => {
  vi.unstubAllEnvs();
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

// ---------------------------------------------------------------------------------------------------------------
// The derivation (D-O1 item 2; fix round 1, review I-1).
type Def = Record<string, unknown>;
type Payload = Record<string, unknown>;
type AnyModule = (typeof builtinModules)[number];
const defOf = (s: unknown) => (s as { _zod?: { def?: Def } })?._zod?.def;
const WRAPPERS = new Set(["optional", "nullable", "default", "readonly", "prefault", "catch"]);
function unwrap(s: unknown): unknown {
  let x = s;
  while (WRAPPERS.has(defOf(x)?.type as string)) x = defOf(x)!.innerType;
  return x;
}
/** The words a rulebook uses for a match lost without (all of) its play. The sweep FLAGS an award or a no_result
 *  without it, but the vocabulary still FINDS one class on its own: a value that ends the match as a WIN under its
 *  own method. Boardgame's single forfeit folds to `win{method:"forfeit"}` (neither award nor no_result), so only this
 *  filter selects it for the gated list (review N2; the gap it leaves is `VOCABULARY_GAP`, beside `UNREACHED_TYPES`).
 *  It also decides whether a `no_result` a value produces is a forfeit (a double forfeit) or not. */
const FORFEIT_VOCABULARY = /forfeit|walkover|default|disqualif/i;
/** The side placeholders: the walk's lineups name the entrants "H" and "A" (`defaultLineupPair`); the DB rows swap
 *  in the seeded fixture's real entrant ids. */
const HOME = "H";

const clone = (p: unknown) => structuredClone(p) as Payload;
function setPath(p: Payload, path: string, v: unknown): void {
  const seg = path.split(".");
  let c = p;
  for (const k of seg.slice(0, -1)) {
    if (typeof c[k] !== "object" || c[k] === null) c[k] = {};
    c = c[k] as Payload;
  }
  c[seg.at(-1)!] = v;
}
function dropPath(p: Payload, path: string): void {
  const seg = path.split(".");
  let c: Payload | undefined = p;
  for (const k of seg.slice(0, -1)) c = c?.[k] as Payload | undefined;
  if (c) delete c[seg.at(-1)!];
}
const keyOf = (p: unknown) => JSON.stringify(p, (_k, v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort()) : v));

/** The schema's own reading: side keys (`by`, `winner`) named `side`, every other required key its first legal value. */
function schemaPayload(schema: unknown, side: string | null): Payload | null {
  const d = defOf(unwrap(schema));
  if (d?.type !== "object") return null;
  const out: Payload = {};
  for (const [k, v] of Object.entries(d.shape as Def)) {
    if (k === "by" || k === "winner") out[k] = side;
    else if (defOf(v)?.type === "optional") continue;
    else {
      const inner = defOf(unwrap(v))!;
      if (inner.type === "enum") out[k] = Object.values(inner.entries as object)[0];
      else if (inner.type === "number") out[k] = 0;
      else if (inner.type === "boolean") out[k] = false;
      else if (inner.type === "string") out[k] = "x";
    }
  }
  return out;
}
/** The pad's reading of one padSpec action: its required fields at their first legal value, its side attribution
 *  named (the scorer picked a side), its required people the side's own players. */
function actionPayload(a: PadAction, lineupPersons: readonly string[]): Payload {
  const entries: [string, unknown][] = [];
  for (const f of a.fields) {
    if (f.optional) continue;
    entries.push([f.path, f.kind === "enum" ? f.values[0] : f.kind === "number" ? f.min : false]);
  }
  let person = 0;
  for (const x of a.attribution) {
    if (x.kind === "side") entries.push([x.path, HOME]);
    else if (x.required) entries.push([x.path, lineupPersons[person++ % Math.max(1, lineupPersons.length)]]);
  }
  return buildPathObject(entries);
}

/** One swept item: an event type with one enum leaf at one value (or `#default` for a type with no enum leaf). */
interface Item {
  sport: string;
  type: string;
  path: string | null;
  value: string | null;
  applied: number;
  /** Payloads whose application ended the match without a played result (award, no_result). */
  decisive: Map<string, Payload>;
  /** Payloads whose application decided the match with this value as the outcome's method. */
  namesMethod: Map<string, Payload>;
  /** The witnesses (either kind) built the way the pad or the schema reads — the DB matrix posts these. */
  padWitness: Map<string, Payload>;
}
const SEEDS = [1, 2, 3, 4, 5];

const sweep = (() => {
  const items = new Map<string, Item>();
  let cfgs = 0;
  let variants = 0;
  let applications = 0;
  for (const m of builtinModules as readonly AnyModule[]) {
    const mm = m as unknown as {
      key: string;
      configSchema: { parse(v: unknown): unknown };
      bracketDeciders(cfg: unknown): Record<string, unknown>;
      padSpec?(cfg: unknown): { panels: readonly { actions: readonly PadAction[] }[] };
      eventSchemas?: Readonly<Record<string, { safeParse(v: unknown): { success: boolean; data?: unknown } }>>;
      init(cfg: unknown, l: unknown): unknown;
      apply(s: unknown, e: unknown): unknown;
      outcome(s: unknown): { kind: string; method?: string } | null;
    };
    const cfgList: unknown[] = [];
    for (const { cfg } of declaredCfgs(m as never)) {
      cfgList.push(cfg);
      const overlay = mm.bracketDeciders(cfg);
      if (Object.keys(overlay).length > 0) cfgList.push(mm.configSchema.parse({ ...(cfg as object), ...overlay }));
    }
    for (const cfg of cfgList) {
      cfgs++;
      const lineups = defaultLineupPair(resolvePositions(m as never, cfg as never));
      const persons = lineups.home.slots.map((s) => s.personId);
      const live: unknown[] = [];
      const fromWalk = new Map<string, { pre: unknown; payload: unknown }[]>();
      for (const seed of SEEDS) {
        const { events, states } = buildWalk(m as never, cfg as never, lineups, seed, 300);
        const all = [mm.init(cfg, lineups), ...states];
        for (const s of all) if (mm.outcome(s) === null) live.push(s);
        events.forEach((e, i) => {
          const list = fromWalk.get(e.type) ?? [];
          if (list.length < 8) list.push({ pre: all[i], payload: e.payload });
          fromWalk.set(e.type, list);
        });
      }
      const actions = mm.padSpec ? mm.padSpec(cfg).panels.flatMap((p) => p.actions) : [];
      for (const [type, schema] of Object.entries(mm.eventSchemas ?? {})) {
        const acts = actions.filter((a) => a.type === type);
        const shape = defOf(unwrap(schema))?.type === "object" ? (defOf(unwrap(schema))!.shape as Def) : {};
        const sidePaths = new Set(acts.flatMap((a) => a.attribution.filter((x) => x.kind === "side").map((x) => x.path)));
        for (const k of ["by", "winner"]) if (k in shape) sidePaths.add(k);
        // The enum leaves: the schema's top-level enum fields, and every enum field a padSpec action offers.
        const leaves = new Map<string, Set<string>>();
        for (const [f, v] of Object.entries(shape)) {
          const e = defOf(unwrap(v));
          if (e?.type === "enum") leaves.set(f, new Set(Object.values(e.entries as object) as string[]));
        }
        for (const a of acts) for (const f of a.fields) if (f.kind === "enum") f.values.forEach((x) => (leaves.get(f.path) ?? leaves.set(f.path, new Set()).get(f.path)!).add(x));
        /** A payload, then the same with every side null, then with every side omitted (a drawn result's shape). */
        const sides = (p: Payload): Payload[] => {
          if (sidePaths.size === 0) return [p];
          const asNull = clone(p);
          const omitted = clone(p);
          for (const sp of sidePaths) {
            setPath(asNull, sp, null);
            dropPath(omitted, sp);
          }
          return [p, asNull, omitted];
        };
        const run = (path: string | null, value: string | null) => {
          const id = `${type}${path === null ? "#default" : `.${path}=${value}`}`;
          const item = items.get(id) ?? { sport: m.key, type, path, value, applied: 0, decisive: new Map(), namesMethod: new Map(), padWitness: new Map() };
          items.set(id, item);
          const tries: { p: Payload; at: unknown[]; pad: boolean }[] = [];
          // The pad: only the actions that OFFER this value at this path (a decisive action never sends a drawn method).
          for (const a of acts) {
            if (path !== null && !a.fields.some((f) => f.kind === "enum" && f.path === path && f.values.includes(value!))) continue;
            const p = actionPayload(a, persons);
            if (path !== null) setPath(p, path, value);
            for (const v of sides(p)) tries.push({ p: v, at: live, pad: true });
          }
          const sp = schemaPayload(schema, HOME);
          if (sp) {
            if (path !== null) setPath(sp, path, value);
            for (const v of sides(sp)) tries.push({ p: v, at: live, pad: true });
          }
          for (const w of fromWalk.get(type) ?? []) {
            const p = clone(w.payload);
            if (path !== null) setPath(p, path, value);
            for (const v of sides(p)) tries.push({ p: v, at: [w.pre], pad: false });
          }
          for (const t of tries) {
            variants++;
            const parsed = schema.safeParse(t.p);
            if (!parsed.success) continue; // the server's validation refuses it before any fold
            for (const st of t.at) {
              let next: unknown;
              try {
                next = mm.apply(st, makeEnvelope(1000, { type, payload: parsed.data as Payload }));
              } catch {
                continue; // not legal in this state; another live state may accept it
              }
              applications++;
              item.applied++;
              const o = mm.outcome(next);
              if (o === null) continue;
              const decisive = o.kind === "award" || o.kind === "no_result";
              const names = value !== null && o.method === value;
              if (!decisive && !names) continue;
              if (decisive) item.decisive.set(keyOf(t.p), t.p);
              if (names) item.namesMethod.set(keyOf(t.p), t.p);
              if (t.pad) item.padWitness.set(keyOf(t.p), t.p);
              break;
            }
          }
        };
        if (leaves.size === 0) run(null, null);
        for (const [path, vals] of leaves) for (const v of vals) run(path, v);
      }
    }
  }
  return { items: [...items.values()], cfgs, variants, applications };
})();
const itemId = (i: Pick<Item, "type" | "path" | "value">) => `${i.type}${i.path === null ? "#default" : `.${i.path}=${i.value}`}`;

/** The forfeit-vocabulary values, with the verdict the fold gave them. */
const candidates = sweep.items
  .filter((i) => i.value !== null && FORFEIT_VOCABULARY.test(i.value))
  .map((i) => ({
    item: i,
    verdict: i.decisive.size > 0 || i.namesMethod.size > 0 ? ("forfeit" as const) : i.applied > 0 ? ("not-a-forfeit" as const) : ("unreached" as const),
  }));
const GATED_SPORT = candidates.filter((c) => c.verdict === "forfeit").map((c) => c.item);
const derivedTable = (() => {
  const table: Record<string, { field: string; values: string[] }> = {};
  for (const i of GATED_SPORT) (table[i.type] ??= { field: i.path!, values: [] }).values.push(i.value!);
  return table;
})();

/** A forfeit-vocabulary value the fold does NOT treat as a forfeit, and why (the T9 report's table, kept here). */
const NOT_A_FORFEIT: Readonly<Record<string, string>> = {
  "cricket.innings.close.reason=forfeited": "Law 15 innings forfeiture: one innings closes, the match goes on",
  "volleyball.sanction.level=disqualification": "a sanction is recorded; the module leaves the outcome null",
  "badminton.sanction.level=disqualification": "a sanction is recorded; the module leaves the outcome null",
  "tabletennis.sanction.level=disqualification": "a sanction is recorded; the module leaves the outcome null",
  "tennis.sanction.level=default": "a sanction is recorded; the module leaves the outcome null",
};
/** A value the sweep flags (it ends the match as an award or no_result) that is NOT gated, and why. None today. */
const SWEEP_EXCLUDED: Readonly<Record<string, string>> = {};
/** An event type the sweep never applied (every payload refused at every reached state), and why — the sweep's own
 *  blind spots, named so a change in reach is re-read rather than silently absorbed. The refusals are the engine's. */
const UNREACHED_TYPES: Readonly<Record<string, string>> = {
  "football.sub": "the incoming player must come off a bench; the testkit lineup fields starters only (\"is already on the field\")",
  "football.sinbin.end": "needs a running sin bin for the side; no reached state holds one",
  "football.shootout.kick": "shootout phase only; no walk reaches a shootout",
  "cricket.superover.ball": "super over only: no walk reaches one, no padSpec action offers it, and the schema-built payload fails validation",
  "cricket.followon": "only between the 2nd and 3rd innings with the follow-on lead; no walk reaches it",
  "cricket.player.line": "a scorecard line for a CLOSED innings that agrees with its totals; no reached state pairs them",
  "volleyball.expedite.start": "the module has no expedite system (refused in every state)",
  "badminton.timeout": "the module records no timeouts (refused in every state)",
  "badminton.sub": "the module records no substitutions (refused in every state)",
  "badminton.expedite.start": "the module has no expedite system (refused in every state)",
  "tabletennis.sub": "the module records no substitutions (refused in every state)",
  "icehockey.shootout.attempt": "shootout phase only; no walk reaches a shootout",
  "hockey.shootout.attempt": "shootout phase only; no walk reaches a shootout",
};

/** KNOWN GAP (review N2), the sweep's other blind spot beside `UNREACHED_TYPES`: a value that ends the match as a WIN
 *  under its own method is gated only when that method is in `FORFEIT_VOCABULARY`. A forfeit-like value spelled
 *  outside it ("no_show", "concede") that folds to a win would be neither flagged nor gated. So every value the sweep
 *  saw decide a match as itself is listed here, each read as a played result; a new one reds the test below and must
 *  be read — a forfeit joins the lib's table (and the vocabulary), a played result joins this list. */
const VOCABULARY_GAP: Readonly<Record<string, string>> = {
  "boardgame.result.method=adjudication": "an arbiter's ruling on a played game (FIDE Art. 5.2): a played result",
  "boardgame.result.method=agreement": "a DRAWN method; it decides as a win only in the schema shape that pairs it with a winner, which the engine accepts (W2b: tie winner to method)",
  "boardgame.result.method=checkmate": "a played result: the game was decided over the board",
  "boardgame.result.method=dead_position": "a DRAWN method; it decides as a win only in the schema shape that pairs it with a winner, which the engine accepts (W2b: tie winner to method)",
  "boardgame.result.method=fifty_move": "a DRAWN method; it decides as a win only in the schema shape that pairs it with a winner, which the engine accepts (W2b: tie winner to method)",
  "boardgame.result.method=illegal_move": "a played result: the arbiter's penalty for an illegal move in play",
  "boardgame.result.method=insufficient": "a DRAWN method; it decides as a win only in the schema shape that pairs it with a winner, which the engine accepts (W2b: tie winner to method)",
  "boardgame.result.method=repetition": "a DRAWN method; it decides as a win only in the schema shape that pairs it with a winner, which the engine accepts (W2b: tie winner to method)",
  "boardgame.result.method=resign": "a played result: the game was decided over the board",
  "boardgame.result.method=stalemate": "a DRAWN method; it decides as a win only in the schema shape that pairs it with a winner, which the engine accepts (W2b: tie winner to method)",
  "boardgame.result.method=time": "a played result: the flag fell in play",
};

describe("X-ST-2 / D-O1: the organiser-only set, and the sport events derived from the engine", () => {
  it("X-ST-2 empty case first: the core constant is exactly the three ruled types, and the set is that list", () => {
    expect([...ORGANISER_ONLY_EVENT_TYPES].sort()).toEqual([...RULED_CORE_TYPES].sort());
    expect([...ORGANISER_ONLY].sort()).toEqual([...ORGANISER_ONLY_EVENT_TYPES].sort());
    expect(ORGANISER_ONLY.has("core.finalize"), "finalize keeps its own, division-configurable gate").toBe(false);
  });

  it("D-O1: every module and enum field was walked, every candidate was classified, and at least one sport event is gated", () => {
    expect(new Set(sweep.items.map((i) => i.sport)).size, "every module swept").toBe(builtinModules.length);
    expect(builtinModules.length).toBeGreaterThan(0);
    expect(sweep.cfgs, "every declared cfg, and a bracket overlay where one exists").toBeGreaterThan(builtinModules.length);
    expect(sweep.items.length).toBeGreaterThan(0);
    expect(sweep.variants).toBeGreaterThan(sweep.items.length);
    expect(sweep.applications).toBeGreaterThan(0);
    expect(candidates.length).toBeGreaterThan(0);
    const unreached = candidates.filter((c) => c.verdict === "unreached").map((c) => itemId(c.item));
    expect(unreached, "a candidate no live state accepted cannot be classified").toEqual([]);
    expect(GATED_SPORT.length).toBeGreaterThan(0);
  });

  it("D-O1: lib/organiser-only-events.ts's sport table is EXACTLY the derived list", () => {
    const norm = (t: Readonly<Record<string, { readonly field: string; readonly values: readonly string[] }>>) =>
      Object.fromEntries(Object.entries(t).map(([k, v]) => [k, { field: v.field, values: [...v.values].sort() }]));
    // The lib's table names ONE field per type; a type gated on two would need a new table shape, not a silent pick.
    for (const type of Object.keys(derivedTable)) {
      expect(new Set(GATED_SPORT.filter((i) => i.type === type).map((i) => i.path)).size, type).toBe(1);
    }
    expect(norm(ORGANISER_ONLY_SPORT_EVENTS)).toEqual(norm(derivedTable));
  });

  it("D-O1: isOrganiserOnlyEvent — the empty and malformed cases are not organiser-only; every gated pair is; ordinary values are not", () => {
    expect(isOrganiserOnlyEvent("boardgame.result", undefined)).toBe(false);
    expect(isOrganiserOnlyEvent("boardgame.result", null)).toBe(false);
    expect(isOrganiserOnlyEvent("boardgame.result", "forfeit")).toBe(false);
    expect(isOrganiserOnlyEvent("boardgame.result", {})).toBe(false);
    expect(isOrganiserOnlyEvent("constructor", { method: "forfeit" })).toBe(false); // no prototype key is a table row
    expect(isOrganiserOnlyEvent("generic.result", { method: "forfeit" })).toBe(false);
    let checked = 0;
    for (const t of ORGANISER_ONLY_EVENT_TYPES) {
      expect(isOrganiserOnlyEvent(t, undefined), t).toBe(true);
      checked++;
    }
    for (const c of candidates) {
      const p: Payload = {};
      setPath(p, c.item.path!, c.item.value);
      expect(isOrganiserOnlyEvent(c.item.type, p), itemId(c.item)).toBe(c.verdict === "forfeit");
      checked++;
    }
    // Review I-1: every payload the fold decided as the forfeit — the pad's, the schema's, the walk's — is gated,
    // whichever side shape it carries (named, null, omitted).
    let witnesses = 0;
    for (const i of GATED_SPORT)
      for (const p of [...i.decisive.values(), ...i.namesMethod.values()]) {
        expect(isOrganiserOnlyEvent(i.type, p), `${itemId(i)} ${keyOf(p)}`).toBe(true);
        witnesses++;
      }
    expect(witnesses).toBeGreaterThanOrEqual(GATED_SPORT.length);
    // Ordinary values: every other value the sweep sent at a gated field (checkmate, agreement, …) is NOT gated.
    let ordinary = 0;
    for (const i of sweep.items) {
      const row = derivedTable[i.type];
      if (!row || i.path !== row.field || row.values.includes(i.value!)) continue;
      const p: Payload = {};
      setPath(p, i.path, i.value);
      expect(isOrganiserOnlyEvent(i.type, p), itemId(i)).toBe(false);
      ordinary++;
    }
    expect(ordinary, "ordinary values at a gated field").toBeGreaterThan(0);
    expect(checked).toBe(ORGANISER_ONLY_EVENT_TYPES.length + candidates.length);
  });

  it("I-1: the vocabulary-free sweep — every value that ends a match as an award or no_result is gated or excluded with a named reason", () => {
    const flagged = sweep.items.filter((i) => i.decisive.size > 0);
    expect(flagged.length, "zero flagged = the sweep saw nothing").toBeGreaterThan(0);
    let checked = 0;
    for (const i of flagged) {
      if (Object.hasOwn(SWEEP_EXCLUDED, itemId(i))) {
        checked++;
        continue;
      }
      for (const p of i.decisive.values()) expect(isOrganiserOnlyEvent(i.type, p), `${itemId(i)} ${keyOf(p)} ends the match unplayed`).toBe(true);
      checked++;
    }
    expect(checked).toBe(flagged.length);
    const flaggedIds = new Set(flagged.map(itemId));
    expect(Object.keys(SWEEP_EXCLUDED).filter((k) => !flaggedIds.has(k)), "a stale exclusion").toEqual([]);
    // The real double forfeit (the boardgame walk's own shape, and the pad's drawn action) is among them.
    const df = flagged.find((i) => i.type === "boardgame.result" && i.value === "double_forfeit");
    expect(df, "boardgame's double forfeit is flagged").toBeDefined();
    expect([...df!.decisive.values()]).toEqual(expect.arrayContaining([{ winner: null, method: "double_forfeit" }, { method: "double_forfeit" }]));
  });

  it("N2: every value outside the vocabulary that decides a match as itself (a win under its own method) is a named played result", () => {
    const decidesAsItself = sweep.items
      .filter((i) => i.value !== null && !FORFEIT_VOCABULARY.test(i.value) && i.namesMethod.size > 0)
      .map(itemId);
    expect(decidesAsItself.length, "the sweep saw decisive methods (zero = it saw nothing)").toBeGreaterThan(0);
    expect(decidesAsItself.sort()).toEqual(Object.keys(VOCABULARY_GAP).sort());
    // The class the vocabulary finds: boardgame's single forfeit decides as itself, with no award or no_result.
    const forfeit = GATED_SPORT.find((i) => i.type === "boardgame.result" && i.value === "forfeit");
    expect(forfeit, "the single forfeit is gated").toBeDefined();
    expect(forfeit!.decisive.size, "found by the vocabulary alone: it never ends the match as award/no_result").toBe(0);
    expect(forfeit!.namesMethod.size).toBeGreaterThan(0);
  });

  it("I-1: every forfeit-vocabulary value the fold does not treat as a forfeit carries a named reason, and no reason is stale", () => {
    const notForfeit = candidates.filter((c) => c.verdict === "not-a-forfeit").map((c) => itemId(c.item));
    expect(notForfeit.length).toBeGreaterThan(0);
    expect(notForfeit.sort()).toEqual(Object.keys(NOT_A_FORFEIT).sort());
  });

  it("I-1: every event type the sweep never applied is a named blind spot, and no blind spot is stale", () => {
    const types = new Map<string, number>();
    for (const i of sweep.items) types.set(i.type, (types.get(i.type) ?? 0) + i.applied);
    expect(types.size).toBeGreaterThan(0);
    const never = [...types].filter(([, n]) => n === 0).map(([t]) => t);
    expect(never.length, "the reached types outnumber the blind spots").toBeLessThan(types.size - never.length);
    expect(never.sort()).toEqual(Object.keys(UNREACHED_TYPES).sort());
  });

  it("I-1: the DB matrix posts every pad- and schema-shaped forfeit, the real double forfeit among them", () => {
    expect(SPORT_ROWS.length).toBeGreaterThanOrEqual(GATED_SPORT.length);
    const posted = SPORT_ROWS.map((r) => ({ type: r.type, payload: r.payload({ home: "HOME-ID", away: "AWAY-ID" }) }));
    expect(posted).toEqual(
      expect.arrayContaining([
        { type: "boardgame.result", payload: { winner: null, method: "double_forfeit" } },
        { type: "boardgame.result", payload: { method: "double_forfeit" } },
        { type: "boardgame.result", payload: { winner: "HOME-ID", method: "forfeit" } },
      ]),
    );
  });

  it("X-ST-2: the authority shapes split the way the ruling says (the predicate the server reads)", () => {
    const shape = (via: AuthCtx["via"], role: AuthCtx["role"]): AuthCtx => ({ orgId: "o", via, userId: null, role, keyId: null });
    expect(subjectToScorerCapabilityGates(shape("session", null))).toBe(true);
    expect(subjectToScorerCapabilityGates(shape("session", "viewer"))).toBe(true);
    expect(subjectToScorerCapabilityGates(shape("session", "owner"))).toBe(false);
    expect(subjectToScorerCapabilityGates(shape("session", "admin"))).toBe(false);
    expect(subjectToScorerCapabilityGates(shape("api_key", null))).toBe(false);
    // A device link's AuthCtx carries role null (api-v1/auth.ts), so the scorer predicate ALREADY selects it: the
    // gate's explicit `auth.via === "device_link"` clause is defence in depth (a mutant deleting it is equivalent
    // today), kept so a later change to the scorer predicate cannot open the device door.
    expect(subjectToScorerCapabilityGates(shape("device_link", null))).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The DB matrix (per gated row × per authority).
const seq = async (id: string) =>
  (await sql<{ s: number }[]>`select coalesce(max(seq), 0)::int as s from score_events where fixture_id = ${id}`)[0]!.s;
const fixtureStatus = async (id: string) => (await sql<{ status: string }[]>`select status from fixtures where id = ${id}`)[0]!.status;

async function makeUser(name: string): Promise<string> {
  const [{ id }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`${name}-${randomUUID().slice(0, 8)}@test.local`}, ${name}, true) returning id`;
  return id;
}
/** scorers.test.ts's acceptOfficial: a person → official → ACCEPTED assignment on this fixture. */
async function acceptOfficial(orgId: string, userId: string, fixtureId: string): Promise<void> {
  const [person] = await sql<{ id: string }[]>`
    insert into persons (org_id, full_name, user_id) values (${orgId}, 'Official', ${userId}) returning id`;
  const [official] = await sql<{ id: string }[]>`
    insert into officials (org_id, person_id, display_name, role_keys)
    values (${orgId}, ${person!.id}, 'Official', ${sql.json(["referee"])}) returning id`;
  await sql`insert into fixture_officials (org_id, fixture_id, official_id, role_key, response)
            values (${orgId}, ${fixtureId}, ${official!.id}, 'referee', 'accepted')`;
}

/** Refused: a device link; an accepted official with no org role; an org VIEWER who is also an accepted official.
 *  Allowed: owner, admin, and a write-scoped API key (an org credential, as for finalize and void). */
const REFUSED = ["device_link", "official", "viewer_official"] as const;
const ALLOWED = ["owner", "admin", "api_key"] as const;
type Who = (typeof REFUSED)[number] | (typeof ALLOWED)[number];

async function asAuthority(s: SeededBracket, fixtureId: string, who: Who): Promise<AuthCtx> {
  const base = { orgId: s.auth.orgId, keyId: null } as const;
  switch (who) {
    case "owner":
    case "admin": {
      const userId = await makeUser(who);
      await sql`insert into org_members (org_id, user_id, role) values (${s.auth.orgId}, ${userId}, ${who})`;
      return { ...base, via: "session", userId, role: who };
    }
    case "api_key":
      return { orgId: s.auth.orgId, via: "api_key", userId: null, role: null, keyId: randomUUID() };
    case "official": {
      const userId = await makeUser("official");
      await acceptOfficial(s.auth.orgId, userId, fixtureId);
      return { ...base, via: "session", userId, role: null };
    }
    case "viewer_official": {
      const userId = await makeUser("viewer");
      await sql`insert into org_members (org_id, user_id, role) values (${s.auth.orgId}, ${userId}, 'viewer')`;
      await acceptOfficial(s.auth.orgId, userId, fixtureId);
      return { ...base, via: "session", userId, role: "viewer" };
    }
    case "device_link": {
      // Minted by an editor session (issued_by), then resolved through the dl_ door — the producer's own AuthCtx.
      const ownerId = await makeUser("issuer");
      await sql`insert into org_members (org_id, user_id, role) values (${s.auth.orgId}, ${ownerId}, 'owner')`;
      const link = await createDeviceLink({ ...base, via: "session", userId: ownerId, role: "owner" }, fixtureId, "Court phone");
      const req = new Request("http://test.local/api/v1", { headers: { authorization: `Bearer ${link.secret}` } });
      const auth = await requireFixtureActor(req, fixtureId, "score");
      expect(auth.via, "the rig: a real device-link AuthCtx").toBe("device_link");
      return auth;
    }
  }
}

/** One gated row: a core type, or a derived sport (type, field, value). */
interface Gated { label: string; sport: string; type: string; payload: (f: { home: string; away: string }) => unknown; prep?: "abandon" }
const CORE_ROWS: Gated[] = RULED_CORE_TYPES.map((type) => ({
  label: type,
  sport: "generic",
  type,
  payload: (f) => {
    if (type === "core.settle") return { winner: f.home, method: "lot" };
    if (type === "core.forfeit") return { by: f.away, reason: "walkover" };
    return { reason: "rain" };
  },
  ...(type === "core.settle" ? { prep: "abandon" as const } : {}),
}));
/** Review I-1: every distinct witness the pad or the schema would send (named side, null side, omitted side), the
 *  walk's placeholder entrants swapped for the seeded fixture's. */
const forFixture = (p: unknown, f: { home: string; away: string }): unknown =>
  p === "H" ? f.home : p === "A" ? f.away : p && typeof p === "object" ? Object.fromEntries(Object.entries(p).map(([k, v]) => [k, forFixture(v, f)])) : p;
const SPORT_ROWS: Gated[] = GATED_SPORT.flatMap((i) =>
  [...i.padWitness.values()].map((w) => ({ label: `${itemId(i)} ${keyOf(w)}`, sport: i.sport, type: i.type, payload: (f: { home: string; away: string }) => forFixture(w, f) })),
);
const GATED: Gated[] = [...CORE_ROWS, ...SPORT_ROWS];

/** A started 2-draw knockout of `sport` (its first declared variant); for settle, abandoned first (X-ST-1). */
async function ready(row: Pick<Gated, "sport" | "prep">) {
  const m = builtinModules.find((x) => x.key === row.sport)!;
  const s = await seedBracket({ sport: row.sport, variant: Object.keys(m.variants)[0]!, stageKind: "knockout", entrants: 2 });
  const id = s.fixtureIds[0]!;
  await scoreEvent(s.auth, id, { expected_seq: 0, type: "core.start", payload: {} });
  if (row.prep === "abandon") await scoreEvent(s.auth, id, { expected_seq: 1, type: "core.abandon", payload: { reason: "rain" } });
  const [f] = await sql<{ home: string; away: string }[]>`
    select home_entrant_id as home, away_entrant_id as away from fixtures where id = ${id}`;
  return { s, id, f: f! };
}

describe.skipIf(!HAS_DB)("X-ST-2: organiser-only on the server, per gated row × per authority (ruling 77, D-O1)", () => {
  it("X-ST-2: every gated row is refused 403 for every non-organiser authority, and nothing is written", async () => {
    let checked = 0;
    for (const row of GATED)
      for (const who of REFUSED) {
        const { s, id, f } = await ready(row);
        const auth = await asAuthority(s, id, who);
        const before = await seq(id);
        const statusBefore = await fixtureStatus(id);
        await expect(
          scoreEvent(auth, id, { expected_seq: before, type: row.type, payload: row.payload(f) }),
          `${row.label} ${who}`,
        ).rejects.toMatchObject({ status: 403, message: expect.stringMatching(/^Only an organiser can /) });
        expect(await seq(id), `${row.label} ${who}`).toBe(before);
        expect(await fixtureStatus(id), `${row.label} ${who}`).toBe(statusBefore);
        checked++;
      }
    expect(SPORT_ROWS.length).toBeGreaterThan(0);
    expect(checked).toBe(GATED.length * REFUSED.length);
  });

  it("X-ST-2 defence in depth: a device-link credential is refused for every gated row even when its AuthCtx carries an organiser role", async () => {
    // No producer builds such a ctx today (requireFixtureActor gives a device link role null, which the scorer
    // predicate already selects). The gate names device links on its own so a later change to that predicate
    // cannot open the device door; this is the witness for that clause.
    let checked = 0;
    for (const row of GATED) {
      const { s, id, f } = await ready(row);
      const real = await asAuthority(s, id, "device_link");
      const promoted: AuthCtx = { ...real, role: "admin" };
      const before = await seq(id);
      await expect(
        scoreEvent(promoted, id, { expected_seq: before, type: row.type, payload: row.payload(f) }),
        row.label,
      ).rejects.toMatchObject({ status: 403, message: expect.stringMatching(/^Only an organiser can /) });
      expect(await seq(id), row.label).toBe(before);
      checked++;
    }
    expect(checked).toBe(GATED.length);
  });

  it("X-ST-2 positive pair: owner, admin and an API key are accepted for every gated row", async () => {
    let checked = 0;
    for (const row of GATED)
      for (const who of ALLOWED) {
        const { s, id, f } = await ready(row);
        const auth = await asAuthority(s, id, who);
        const out = await scoreEvent(auth, id, { expected_seq: await seq(id), type: row.type, payload: row.payload(f) });
        const [last] = await sql<{ type: string }[]>`select type from score_events where fixture_id = ${id} order by seq desc limit 1`;
        expect(last!.type, `${row.label} ${who}`).toBe(row.type);
        expect(out.seq, `${row.label} ${who}`).toBe(await seq(id));
        checked++;
      }
    expect(checked).toBe(GATED.length * ALLOWED.length);
  });

  it("X-ST-2 / D-O1: a chess result with an ORDINARY method still passes for every non-organiser authority (the payload arm is not type-wide)", async () => {
    // checkmate and resign (decisive) and agreement (a draw): methods the derivation did NOT gate.
    const ORDINARY = [
      { winner: "home", method: "checkmate" },
      { winner: "home", method: "resign" },
      { winner: null, method: "agreement" },
    ] as const;
    let checked = 0;
    for (const o of ORDINARY) {
      expect(isOrganiserOnlyEvent("boardgame.result", { method: o.method }), o.method).toBe(false);
      for (const who of REFUSED) {
        const { s, id, f } = await ready({ sport: "boardgame" });
        const auth = await asAuthority(s, id, who);
        const before = await seq(id);
        await scoreEvent(auth, id, { expected_seq: before, type: "boardgame.result", payload: { winner: o.winner === null ? null : f.home, method: o.method } });
        expect(await seq(id), `${o.method} ${who}`).toBe(before + 1);
        checked++;
      }
    }
    expect(checked).toBe(ORDINARY.length * REFUSED.length);
  });

  it("X-ST-2: the refused authorities can still score play — the check did not swallow the scorer or device path", async () => {
    let checked = 0;
    for (const who of REFUSED) {
      const s = await seedBracket({ sport: "generic", variant: "score", stageKind: "knockout", entrants: 2 });
      const id = s.fixtureIds[0]!;
      const auth = await asAuthority(s, id, who);
      await scoreEvent(auth, id, { expected_seq: 0, type: "core.start", payload: {} });
      const out = await scoreEvent(auth, id, { expected_seq: 1, type: "generic.result", payload: { p1Score: 2, p2Score: 1 } });
      expect(out.status, who).toBe("decided");
      checked++;
    }
    expect(checked).toBe(REFUSED.length);
  });

  it("X-ST-2: the authority is read from the request's AuthCtx — a demotion takes effect on the NEXT request, and the demoted caller is then refused", async () => {
    // A session's role is resolved once per request (requireFixtureActor → AuthCtx); scoreEvent never re-reads
    // org_members. Demoting an admin mid-flight therefore cannot change the request already holding its AuthCtx,
    // and the next request — resolved again, now as a viewer official — is refused.
    const { s, id } = await ready({ sport: "generic" });
    const admin = await asAuthority(s, id, "admin");
    await sql`update org_members set role = 'viewer' where org_id = ${s.auth.orgId} and user_id = ${admin.userId}`;
    await acceptOfficial(s.auth.orgId, admin.userId!, id);
    const demoted: AuthCtx = { ...admin, role: "viewer" };
    const before = await seq(id);
    await expect(scoreEvent(demoted, id, { expected_seq: before, type: "core.abandon", payload: { reason: "rain" } })).rejects.toMatchObject({ status: 403 });
    expect(await seq(id)).toBe(before);
    // The request that resolved BEFORE the demotion still carries admin: it is that request's authority.
    await scoreEvent(admin, id, { expected_seq: before, type: "core.abandon", payload: { reason: "rain" } });
    expect(await seq(id)).toBe(before + 1);
  });
});
