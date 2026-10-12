// W2b Task 14 fix round 1 (M-1; spec §5.4 rule 2; Appendix A FB-AB-1, HK-AB-1, IH-AB-1). A goal sport's award-policy
// abandon, folded by the server's own fold (`foldFrom`) and keyed by the server's own status rule
// (`fixtureStatusFromFold`): a LEVEL abandon in a bracket kind stays `abandoned` — the row W2a's recorded-abandon
// readers, the desk's awaits-settle path and `needs-decision.tsx` see — never `needs_decision`; in a draw kind it is a
// decided draw; a leader's abandon is decided in every kind; voiding the abandon resumes play. Expected statuses are
// spec §5.4's ordered rule; the stage kinds are the engine's own BRACKET_KINDS / DRAW_KINDS, never a typed list.
import { describe, expect, it } from "vitest";
import { BRACKET_KINDS, DRAW_KINDS } from "@seazn/engine/core";
import { resolvePositions } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
import { defaultLineupPair, makeEnvelope } from "@seazn/engine/testkit";
import { fixtureStatusFromFold } from "../append-event";
import { foldFrom } from "../fold";

type Mod = (typeof builtinModules)[number];
type Step = [type: string, payload?: unknown, voids?: string];

/** The module's cfg with `abandonPolicy` set, or null when the module does not declare the policy (zod strips it). */
function cfgWith(m: Mod, policy: "award" | "replay"): Record<string, unknown> | null {
  const base = m.configSchema.safeParse({}).success ? {} : (Object.values(m.variants)[0] as Record<string, unknown>);
  const parsed = m.configSchema.safeParse({ ...base, abandonPolicy: policy });
  if (!parsed.success) return null;
  const cfg = parsed.data as Record<string, unknown>;
  return cfg.abandonPolicy === policy ? cfg : null;
}

function statusOf(m: Mod, cfg: Record<string, unknown>, steps: Step[], kind: string) {
  const lineups = defaultLineupPair(resolvePositions(m as never, cfg as never));
  const envelopes = steps.map(([type, payload, voids], i) => makeEnvelope(i + 1, { type, payload: payload ?? {} } as never, voids));
  const f = foldFrom("fx", { sportKey: m.key, module: m as never, cfg, lineups, envelopes, stageKind: kind });
  return { outcome: f.outcome, status: fixtureStatusFromFold(f.outcome, f.active, kind), home: lineups.home.entrantId, away: lineups.away.entrantId };
}

/** The registry's award-policy sports — swept, never typed. */
const AWARD_SPORTS = builtinModules.filter((m) => cfgWith(m, "award") !== null);
const KINDS = [...BRACKET_KINDS, ...DRAW_KINDS];

describe("award-policy abandon status through the server fold (spec §5.4 rule 2; FB-AB-1, HK-AB-1, IH-AB-1)", () => {
  it("the registry's award-policy sports are exactly the three the rows name, and both stage-kind halves are non-empty", () => {
    // The rulebook names football (FB-AB-1), hockey (HK-AB-1) and ice hockey (IH-AB-1); a fourth sport gaining the
    // policy owes its own row before this sweep may pass.
    expect(AWARD_SPORTS.map((m) => m.key).sort()).toEqual(["football", "hockey", "icehockey"]);
    expect([BRACKET_KINDS.size > 0, DRAW_KINDS.size > 0]).toEqual([true, true]);
  });

  it("empty case first: a started match with nothing else is in_play in every kind, for every award-policy sport", () => {
    let checked = 0;
    for (const m of AWARD_SPORTS) {
      for (const kind of KINDS) {
        const r = statusOf(m, cfgWith(m, "award")!, [["core.start"]], kind);
        expect([r.outcome, r.status], `${m.key} ${kind}`).toEqual([null, "in_play"]);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0); // anti-vacuity: an empty registry sweep is a failure
    expect(checked).toBe(AWARD_SPORTS.length * KINDS.length);
  });

  // R16-3 (W2b Task 16): FB-AB-1's draw is a draw-kind result only where the cfg takes a draw at all. Where it refuses
  // one (`supportsDraws` false: ice hockey's default configures overtime and a shootout), the level abandon folds to no
  // result and is `abandoned` in every kind - out of the table, as X-AB-1 has it. Which half a sport's default lands in
  // is its own declaration, never typed here.
  it("FB-AB-1 / HK-AB-1 / IH-AB-1: a level award-policy abandon is abandoned in every bracket kind (not needs_decision); in every draw kind a decided draw where the cfg takes one, abandoned with no result where it refuses one (R16-3)", () => {
    let abandoned = 0;
    let decided = 0;
    let refused = 0;
    for (const m of AWARD_SPORTS) {
      const goal = `${m.key}.goal`;
      const stands = m.supportsDraws(cfgWith(m, "award")! as never, "league");
      for (const kind of KINDS) {
        const probe = statusOf(m, cfgWith(m, "award")!, [["core.start"]], kind);
        const r = statusOf(
          m,
          cfgWith(m, "award")!,
          [["core.start"], [goal, { by: probe.home }], [goal, { by: probe.away }], ["core.abandon", { reason: "floodlights" }]],
          kind,
        );
        // Where the cfg takes a draw the fold DID reach a level result — rule 2's level half, not its null half, is what
        // is under test; where it refuses one, the fold has no result (R16-3) and rule 2's null half holds it.
        expect(r.outcome, `${m.key} ${kind} outcome`).toEqual(stands ? { kind: "draw" } : null);
        expect(r.status, `${m.key} ${kind}`).toBe(BRACKET_KINDS.has(kind) || !stands ? "abandoned" : "decided");
        expect(r.status, `${m.key} ${kind}`).not.toBe("needs_decision");
        if (!stands) refused++;
        if (r.status === "abandoned") abandoned++;
        else decided++;
      }
    }
    expect(abandoned * decided * refused).toBeGreaterThan(0); // both halves of rule 2 vs rule 5 reached, and R16-3's
    const standing = AWARD_SPORTS.filter((m) => m.supportsDraws(cfgWith(m, "award")! as never, "league")).length;
    expect([abandoned, decided]).toEqual([AWARD_SPORTS.length * BRACKET_KINDS.size + (AWARD_SPORTS.length - standing) * DRAW_KINDS.size, standing * DRAW_KINDS.size]);
  });

  it("FB-AB-1 / HK-AB-1 / IH-AB-1: a leader's award-policy abandon is decided in every kind, bracket and draw alike", () => {
    let checked = 0;
    for (const m of AWARD_SPORTS) {
      const goal = `${m.key}.goal`;
      for (const kind of KINDS) {
        const probe = statusOf(m, cfgWith(m, "award")!, [["core.start"]], kind);
        const r = statusOf(
          m,
          cfgWith(m, "award")!,
          [["core.start"], [goal, { by: probe.home }], [goal, { by: probe.home }], [goal, { by: probe.away }], ["core.abandon", { reason: "floodlights" }]],
          kind,
        );
        expect([r.outcome, r.status], `${m.key} ${kind}`).toEqual([
          { kind: "win", winner: probe.home, loser: probe.away, method: "abandoned" },
          "decided",
        ]);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0); // anti-vacuity: an empty registry sweep is a failure
    expect(checked).toBe(AWARD_SPORTS.length * KINDS.length);
  });

  it("sequence: voiding the level abandon resumes play (in_play) in every kind; the replay policy's level abandon has no result and is abandoned in every kind", () => {
    let resumed = 0;
    let replay = 0;
    for (const m of AWARD_SPORTS) {
      const goal = `${m.key}.goal`;
      for (const kind of KINDS) {
        const probe = statusOf(m, cfgWith(m, "award")!, [["core.start"]], kind);
        const level: Step[] = [["core.start"], [goal, { by: probe.home }], [goal, { by: probe.away }], ["core.abandon", { reason: "floodlights" }]];
        const voided = statusOf(m, cfgWith(m, "award")!, [...level, ["core.void", {}, `e-${level.length}`]], kind);
        expect([voided.outcome, voided.status], `${m.key} ${kind} voided`).toEqual([null, "in_play"]);
        resumed++;
        const r = statusOf(m, cfgWith(m, "replay")!, level, kind);
        expect([r.outcome, r.status], `${m.key} ${kind} replay`).toEqual([null, "abandoned"]);
        replay++;
      }
    }
    expect(resumed * replay).toBeGreaterThan(0);
    expect([resumed, replay]).toEqual([AWARD_SPORTS.length * KINDS.length, AWARD_SPORTS.length * KINDS.length]);
  });
});
