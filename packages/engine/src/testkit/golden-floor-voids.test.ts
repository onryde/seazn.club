// Every recorded `core.void`, swept (GF-1 review finding 5).
//
// The floor records a void; this proves what a void MEANS in each recorded stream, so a corpus that quietly stopped
// meaning it (a void that strikes nothing, one that strikes the wrong event, one whose absence changes nothing) cannot
// satisfy the floor on presence alone. For each recorded void:
//   A  = the fold of the whole ledger
//   B  = the fold of the ledger WITHOUT the target and the void (the target had never been recorded)
//   C  = the fold of the ledger WITHOUT the void alone (the target stands)
// A must equal B in every observable field, and C must differ from A in at least one (or be refused outright, a ledger the
// write path would not accept). A void that fails the first strikes the wrong thing; one that fails the second is decoration.
//
// "Observable" is the kernel's own reading: module state, the effective outcome, the open stoppage, the squads, the
// settlement, the expunge flag, a level withdrawal, and whether an abandon is in force (probed by the refusal the kernel gives
// a forfeit while one is). The facts that name the event that opened them are read in the numbering of the ledger as recorded.
import { describe, expect, it } from "vitest";
import { EngineError } from "../core/errors.ts";
import { foldMatchWithStoppage, outcomeOf } from "../core/events.ts";
import type { LineupPair } from "../core/types.ts";
import { resolvePositions } from "../sport/catalog.ts";
import type { AnySportModule } from "../sport/module.ts";
import { builtinModules } from "../sports/index.ts";
import { forEachSport } from "./for-each-sport.ts";
import { readCorpus, type GoldenEvent } from "./golden.ts";
import { defaultLineupPair, makeEnvelope } from "./helpers.ts";

/** The ledger without `drop` (indices), the surviving voids renumbered to where their targets now sit; null when a
 *  surviving void points at a dropped event. `original[i]` is where event `i` of the result stood in `events`. */
function without(events: readonly GoldenEvent[], drop: ReadonlySet<number>): { events: GoldenEvent[]; original: number[] } | null {
  const place = new Map<number, number>();
  let next = 0;
  events.forEach((_, i) => {
    if (!drop.has(i)) place.set(i, next++);
  });
  const out: GoldenEvent[] = [];
  const original: number[] = [];
  for (let i = 0; i < events.length; i++) {
    if (drop.has(i)) continue;
    const event = events[i]!;
    original.push(i);
    if (event.voids === undefined) {
      out.push(event);
      continue;
    }
    const to = place.get(Number(event.voids.slice(2)));
    if (to === undefined) return null;
    out.push({ ...event, voids: `e-${to}` });
  }
  return { events: out, original };
}

interface Reading {
  readonly fold: string;
  readonly abandonInForce: boolean;
}

/** Everything the kernel reads of a ledger, or null when the strict write path refuses it. The kernel facts that NAME the event that
 *  opened them (a stoppage, a settlement, a level withdrawal: `eventId: "e-<index>"`) are read in the numbering of `original`, the
 *  ledger the comparison started from: a ledger that never recorded an earlier event numbers the same event differently, and that
 *  is not a difference in what the match says. */
function read(module: AnySportModule, cfg: unknown, lineups: LineupPair, events: readonly GoldenEvent[], original?: readonly number[]): Reading | null {
  const envelopes = (list: readonly GoldenEvent[]) => list.map((e, i) => makeEnvelope(i, e, e.voids));
  const inOriginal = (key: string, value: unknown): unknown => {
    if (key !== "eventId" || typeof value !== "string" || original === undefined) return value;
    const at = original[Number(value.slice(2))];
    return at === undefined ? value : `e-${at}`;
  };
  try {
    const folded = foldMatchWithStoppage(module as never, cfg as never, lineups, envelopes(events), { strictFromSeq: 0 });
    const fold = JSON.stringify(
      {
        state: folded.state,
        stoppage: folded.stoppage,
        squads: folded.squads,
        settlement: folded.settlement,
        expunged: folded.expunged,
        levelWithdrawal: folded.levelWithdrawal,
        effective: outcomeOf(module as never, folded as never),
      },
      inOriginal,
    );
    let abandonInForce = false;
    try {
      const probe: GoldenEvent = { type: "core.forfeit", payload: { by: lineups.home.entrantId, reason: "retired" } };
      foldMatchWithStoppage(module as never, cfg as never, lineups, envelopes([...events, probe]), { strictFromSeq: 0 });
    } catch (error) {
      abandonInForce = error instanceof EngineError && error.code === "ABANDONED_SETTLE_OR_VOID";
    }
    return { fold, abandonInForce };
  } catch {
    return null;
  }
}

const same = (a: Reading | null, b: Reading | null): boolean => a !== null && b !== null && a.fold === b.fold && a.abandonInForce === b.abandonInForce;

type Reader = typeof read;

/** What is wrong with the void at index `v` of `events`, by name; [] when it means what it says. */
function voidFailures(module: AnySportModule, cfg: unknown, lineups: LineupPair, events: readonly GoldenEvent[], v: number, reader: Reader = read): string[] {
  const t = Number(events[v]!.voids!.slice(2));
  const struck = without(events, new Set([t, v]));
  const standing = without(events, new Set([v]));
  if (struck === null || standing === null) return ["a later event points at the struck event or at the void"];
  const whole = reader(module, cfg, lineups, events);
  if (whole === null) return ["the recorded ledger is refused by the strict write path"];
  const out: string[] = [];
  const b = reader(module, cfg, lineups, struck.events, struck.original);
  if (b === null) out.push("the ledger minus target and void is refused");
  else if (!same(whole, b)) out.push("striking the target is not the same as never recording it");
  if (same(whole, reader(module, cfg, lineups, standing.events, standing.original))) out.push(`the target ${events[t]!.type} left standing changes nothing: the void is decoration`);
  return out;
}

describe("golden floor — every recorded void means what it says (swept, counted)", () => {
  it("each recorded void: the ledger folds as if the target had never been recorded, and differs from the ledger with the target standing", () => {
    const perSport = new Map<string, { sport: number; kernel: number }>();
    let swept = 0;
    forEachSport(({ module, key }) => {
      const corpus = readCorpus(key);
      for (const stream of corpus.streams) {
        const cfg = module.configSchema.parse(corpus.configs[stream.config]) as unknown;
        const lineups = stream.lineups ?? defaultLineupPair(resolvePositions(module, cfg));
        stream.events.forEach((event, v) => {
          if (event.type !== "core.void") return;
          const target = stream.events[Number(event.voids!.slice(2))]!;
          expect(voidFailures(module, cfg, lineups, stream.events, v), `${key} ${stream.config}#${stream.seed} void@${v}->${target.type}`).toEqual([]);
          const row = perSport.get(key) ?? { sport: 0, kernel: 0 };
          if (target.type.startsWith("core.")) row.kernel++;
          else row.sport++;
          perSport.set(key, row);
          swept++;
        });
      }
    });
    // anti-vacuity: every sport swept a void of a sport event AND of a kernel event
    expect(perSport.size).toBe(builtinModules.length);
    for (const [key, row] of perSport) {
      expect(row.sport, `${key}: voids of sport events swept`).toBeGreaterThan(0);
      expect(row.kernel, `${key}: voids of kernel events swept`).toBeGreaterThanOrEqual(2);
    }
    expect(swept).toBeGreaterThanOrEqual(builtinModules.length * 4);
  });

  it("the check has teeth: a void of an inert event is named decoration, and a reader that ignores voids is named", () => {
    const module = builtinModules.find((m) => m.key === "football")!;
    const corpus = readCorpus("football");
    const cfg = module.configSchema.parse(corpus.configs.default) as unknown;
    const lineups = defaultLineupPair(resolvePositions(module, cfg));
    // a note folds as `return state` in every module: striking one moves nothing the kernel reads
    const inert: GoldenEvent[] = [
      { type: "core.start", payload: {} },
      { type: "core.note", payload: { text: "ball changed" } },
      { type: "core.void", payload: {}, voids: "e-1" },
    ];
    expect(voidFailures(module, cfg, lineups, inert, 2)).toEqual([expect.stringMatching(/core\.note left standing changes nothing: the void is decoration/)]);
    // the same shape over a goal is honest
    const goal = { type: "football.goal", payload: { side: "home" } } as GoldenEvent;
    const real = corpus.streams.flatMap((s) => s.events).find((e) => e.type === "football.goal");
    expect(real, "a recorded goal to borrow").toBeDefined();
    const honest: GoldenEvent[] = [{ type: "core.start", payload: {} }, { ...goal, payload: real!.payload }, { type: "core.void", payload: {}, voids: "e-1" }];
    expect(voidFailures(module, cfg, lineups, honest, 2)).toEqual([]);
    // an open stoppage names the event that opened it (`e-<index>`), and striking an earlier goal moves that event: the same
    // stoppage in a ledger that never recorded the goal sits two places earlier. The ids are compared where the events ARE.
    const suspend: GoldenEvent = { type: "core.suspend", payload: { reason: "floodlight failure" } };
    const renumbered: GoldenEvent[] = [{ type: "core.start", payload: {} }, { ...goal, payload: real!.payload }, { type: "core.void", payload: {}, voids: "e-1" }, suspend];
    expect(voidFailures(module, cfg, lineups, renumbered, 2), "the stoppage opened by e-3 is the one e-1 opens once the goal and its void are gone").toEqual([]);
    // and a settlement likewise (the story the settle stream tells, shifted by an earlier struck event)
    const settled: GoldenEvent[] = [
      { type: "core.start", payload: {} },
      { ...goal, payload: real!.payload },
      { type: "core.void", payload: {}, voids: "e-1" },
      { type: "core.abandon", payload: { reason: "rain" } },
      { type: "core.settle", payload: { winner: lineups.home.entrantId, method: "organiser" } },
      { type: "core.void", payload: {}, voids: "e-4" },
    ];
    expect(voidFailures(module, cfg, lineups, settled, 5), "a struck settle leaves the abandoned match it found").toEqual([]);
    // an engine whose void strikes nothing: a reader that folds without resolving voids
    const blind: Reader = (m, c, l, events) => read(m, c, l, events.filter((e) => e.type !== "core.void"));
    // (it also finds the void decoration: with voids ignored, "target standing" and "whole ledger" are one fold)
    const blindFailures = voidFailures(module, cfg, lineups, honest, 2, blind);
    expect(blindFailures).toHaveLength(2);
    expect(blindFailures).toContainEqual(expect.stringMatching(/striking the target is not the same as never recording it/));
    expect(blindFailures).toContainEqual(expect.stringMatching(/the void is decoration/));
  });
});
