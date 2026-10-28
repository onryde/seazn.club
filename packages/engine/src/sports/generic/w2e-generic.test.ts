// W2e Task 12 (A1e-3, D6) — generic's `progressScore` key is deleted.
//
// The key was "stored for the PROMPT-15 cutover, no scoring effect inside the module": a v1 stepladder carry that nothing in
// the engine, the server or the pad ever read (generic/DOMAIN.md said so in its own row). Deleting it moves no fold: the
// MAJOR bump and the golden re-record exist because every recorded state embeds its config, and the config lost a key.
//
// Two things are proved here, and both are the kind a green golden cannot see:
// - the schema, the shipped variants and every declared config no longer carry the key (a registry sweep, counted);
// - a config recorded BEFORE W2e (the four shapes the generic golden held at BASE 2bd1ee5bd7, plus the Advanced-box value
//   `true` that the settings placeholder suggested) still parses, with the key stripped and everything else kept, and a
//   ledger folds to the SAME outcome, summary and standings delta whether the cfg is the parsed one or the stale raw one.
//   That second half is the deploy window: an older client's write and a not-yet-migrated stored row both reach the new
//   schema, and the stored rows lose the key in Task 13b's migration (D18), not in a legacy parse default.
//
// single-sport: the key belonged to generic alone; the registry sweep below is the "no other sport grew it" half.
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { foldMatch, type EventEnvelope, type FoldOptions } from "../../core/events.ts";
import type { LineupPair, StageCtx } from "../../core/types.ts";
import { declaredCfgs } from "../../testkit/declared-cfgs.ts";
import { makeEnvelope } from "../../testkit/helpers.ts";
import { builtinModules } from "../index.ts";
import { generic, type GenericCfg } from "./generic.ts";

const STRICT_ALL: FoldOptions = { strictFromSeq: 0 };
const REPLAY: FoldOptions = {};

const lineups: LineupPair = {
  home: { entrantId: "H", slots: [{ personId: "h1", slot: "starting", orderNo: 1 }] },
  away: { entrantId: "A", slots: [{ personId: "a1", slot: "starting", orderNo: 1 }] },
};
const ledger = (...specs: Array<[type: string, payload?: unknown]>): EventEnvelope[] =>
  specs.map(([type, payload], i) => makeEnvelope(i, { type, payload: payload ?? {} }));

/** Every key named `progressScore` anywhere in `value`, with its path. */
const progressScorePaths = (value: unknown, path = "$"): string[] => {
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => [
    ...(k === "progressScore" ? [`${path}.${k}`] : []),
    ...progressScorePaths(v, `${path}.${k}`),
  ]);
};

describe("D6 generic declares no progressScore", () => {
  it("D6 generic declares no progressScore: not in the schema, the variants or any declared config, in any sport", () => {
    let modules = 0;
    let configs = 0;
    for (const module of builtinModules) {
      const schema = z.toJSONSchema(module.configSchema, { io: "input", target: "draft-2020-12" });
      expect(progressScorePaths(schema), `${module.key} config schema`).toEqual([]);
      for (const [variant, preset] of Object.entries(module.variants)) {
        expect(progressScorePaths(preset), `${module.key} ${variant} preset`).toEqual([]);
      }
      for (const { name, cfg } of declaredCfgs(module)) {
        expect(progressScorePaths(cfg), `${module.key} ${name}`).toEqual([]);
        configs += 1;
      }
      modules += 1;
    }
    expect(modules, "the whole registry").toBe(builtinModules.length);
    expect(modules).toBeGreaterThan(0);
    expect(configs, "declared configs walked").toBeGreaterThanOrEqual(builtinModules.length);
    // The sweep reached generic's own declarations: its two shipped variants and the schema (the shape is the third).
    expect(Object.keys(generic.variants).sort()).toEqual(["score", "win_loss"]);
  });

  it("D6 generic declares no progressScore: a fresh parse of every shipped variant carries exactly the keys generic still declares", () => {
    // Read from the schema's own declaration, so a key added later moves this with it.
    const declared = Object.keys(z.toJSONSchema(generic.configSchema, { io: "input", target: "draft-2020-12" }).properties ?? {}).sort();
    expect(declared).toEqual(["abandonPolicy", "allowDraws", "points", "resultMode"]);
    for (const [name, preset] of Object.entries(generic.variants)) {
      const keys = Object.keys(generic.configSchema.parse(preset)).sort();
      // abandonPolicy is optional with no default, so a preset that does not set it parses without it.
      expect(keys, name).toEqual(["allowDraws", "points", "resultMode"]);
    }
  });
});

describe("D6 a recorded generic config with progressScore parses without it and folds a ledger raw", () => {
  // The configs the generic golden recorded at BASE (win_loss, score, drawable: `progressScore: false` last), the two
  // shipped variants as the old engine served them, and the Advanced-box value the settings placeholder suggested.
  const RECORDED: Array<{ name: string; raw: Record<string, unknown> }> = [
    { name: "golden win_loss", raw: { resultMode: "win_loss", allowDraws: false, points: { w: 3, d: 1, l: 0 }, progressScore: false } },
    { name: "golden score", raw: { resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 }, progressScore: false } },
    { name: "golden drawable", raw: { resultMode: "win_loss", allowDraws: true, points: { w: 3, d: 1, l: 0 }, progressScore: false } },
    { name: "advanced box true", raw: { resultMode: "score", allowDraws: true, points: { w: 2, d: 1, l: 0 }, progressScore: true } },
    { name: "with abandonPolicy", raw: { resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 }, progressScore: false, abandonPolicy: "share" } },
  ];

  it("D6 a recorded generic config with progressScore parses without it: the key is gone and the rest is kept", () => {
    let read = 0;
    for (const { name, raw } of RECORDED) {
      const parsed = generic.configSchema.safeParse(raw);
      expect(parsed.success, name).toBe(true);
      const { progressScore: _dropped, ...rest } = raw;
      expect(parsed.data, `${name}: everything but the key is kept`).toEqual(rest);
      expect(progressScorePaths(parsed.data), name).toEqual([]);
      // A second call: parsing the parsed output is a no-op.
      expect(generic.configSchema.parse(parsed.data), `${name}: idempotent`).toEqual(rest);
      read += 1;
    }
    expect(read).toBe(RECORDED.length);
    expect(read).toBeGreaterThan(0);
  });

  it("D6 a recorded generic config with progressScore: the strip is not a way in — a config short of its required keys is still refused", () => {
    // Stripping must not make an otherwise invalid config valid: the empty case is `{ progressScore }` alone.
    for (const raw of [{ progressScore: true }, { progressScore: false, points: { w: 3, d: 1, l: 0 } }]) {
      expect(generic.configSchema.safeParse(raw).success, JSON.stringify(raw)).toBe(false);
    }
    // And an invalid VALUE under the dead key is no longer judged at all: the key is not read, so it cannot refuse.
    const odd = generic.configSchema.safeParse({ resultMode: "score", allowDraws: true, progressScore: "not a boolean" });
    expect(odd.success, "an unread key cannot refuse a config").toBe(true);
  });

  it("D6 a recorded generic config with progressScore folds a ledger raw: the parsed cfg and the stale raw cfg decide alike", () => {
    // [config name, ledger, outcome the module's own semantics give it (generic.test.ts and spec 04 §8)]
    const CASES: Array<{ cfg: string; events: EventEnvelope[]; outcome: unknown }> = [
      {
        cfg: "golden win_loss",
        events: ledger(["generic.result", { winnerId: "H" }]),
        outcome: { kind: "win", winner: "H", loser: "A", method: "regulation" },
      },
      {
        cfg: "golden score",
        events: ledger(["core.start"], ["generic.result", { p1Score: 1, p2Score: 3 }]),
        outcome: { kind: "win", winner: "A", loser: "H", method: "regulation" },
      },
      { cfg: "golden drawable", events: ledger(["generic.result", { isDraw: true }]), outcome: { kind: "draw" } },
      {
        cfg: "advanced box true",
        events: ledger(["core.start"], ["generic.result", { p1Score: 2, p2Score: 2 }]),
        outcome: { kind: "draw" },
      },
    ];
    const ctx: StageCtx = { kind: "league" };
    let folded = 0;
    for (const { cfg: name, events, outcome } of CASES) {
      const raw = RECORDED.find((r) => r.name === name)!.raw;
      const parsed: GenericCfg = generic.configSchema.parse(raw);
      for (const [label, options] of [["strict", STRICT_ALL], ["replay", REPLAY]] as const) {
        const parsedState = foldMatch(generic, parsed, lineups, events, options);
        // The stale cfg handed to the fold WITHOUT a parse, as a not-yet-migrated stored row would be.
        const rawState = foldMatch(generic, raw as unknown as GenericCfg, lineups, events, options);
        const parsedOutcome = generic.outcome(parsedState);
        const rawOutcome = generic.outcome(rawState);
        expect(parsedOutcome, `${name} ${label}`).toEqual(outcome);
        expect(rawOutcome, `${name} ${label}: the stale key decides nothing`).toEqual(outcome);
        expect(generic.summary(rawState), `${name} ${label}: summary`).toEqual(generic.summary(parsedState));
        expect(generic.standingsDelta(rawOutcome!, raw as unknown as GenericCfg, ctx, rawState), `${name} ${label}: delta`).toEqual(
          generic.standingsDelta(parsedOutcome!, parsed, ctx, parsedState),
        );
        // The parsed fold carries no copy of the key into the state (the reason the golden's states moved).
        expect(progressScorePaths(parsedState), `${name} ${label}: no key in the folded state`).toEqual([]);
        folded += 1;
      }
    }
    expect(folded, "ledgers folded").toBe(CASES.length * 2);
    expect(folded).toBeGreaterThan(0);
  });
});
