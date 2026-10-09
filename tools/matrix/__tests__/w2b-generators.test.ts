// W2b Task 2 (spec §5.6, §8.1; plan finding 10): the harness's generator breadth for forfeits. A walkover is posted
// BEFORE core.start (the phase guard refuses one after it, D3 R2); a retirement or disqualification AFTER core.start and
// some play (D3 R4); a double walkover is core.forfeit {by: "both", reason: "walkover"} in every sport, chess included
// (M7); and the harness observes `double_walkover` as itself, never as undecided. Expected values are the rule rows'
// (X-RS-1, X-DW-1) and D1's closed reason list, never read back from the generators.
import { describe, expect, it } from "vitest";
import { SPORT_KEYS } from "../lib/catalogue.ts";
import { foldStream } from "../lib/fold.ts";
import { toObservedOutcome } from "../lib/observed.ts";
import { resolveSportCfg, sportModule, stageCfg, variantKeys } from "../lib/sport-cfg.ts";
import { generateStream } from "../lib/streams/index.ts";
import { ALL_OUTCOMES, OutcomeUnreachable, outcomeLabel, type RequestedOutcome, type StreamRequest } from "../lib/streams/types.ts";
import { offlineBuilderDefault } from "../lib/variants.ts";

/** D1 (plan Decisions): the four reasons, typed here from the decision, never read from the code under test. */
const REASONS = ["walkover", "retired", "disqualified", "withdrew"] as const;

/** generateStream's real request shape (streams/types.ts StreamRequest): a sport, its resolved cfg, a stage kind and two
 *  entrant ids. The brief's `{ sportKey, cfg: {} }` is not a request: a sport generator reads its cfg (bestOf, set
 *  targets, overs), so each sport is asked under its builder-default variant, resolved by its own configSchema. */
const req = (sportKey: string, outcome: unknown): StreamRequest =>
  ({ sportKey, cfg: resolveSportCfg(sportKey, offlineBuilderDefault(sportKey)), stageKind: "league", home: "H", away: "A", outcome }) as StreamRequest;

describe("W2b generator breadth (spec §5.6)", () => {
  it("empty case first: a walkover request before start posts no core.start", () => {
    const s = generateStream({ sportKey: "generic", cfg: {}, stageKind: "league", home: "H", away: "A", outcome: { kind: "forfeit", by: "away", reason: "walkover", at: "before_start" } });
    expect(s.map((e) => e.type)).toEqual(["core.forfeit"]);
  });

  it("X-RS-1: every sport builds a walkover before START and a retirement after START, with reasons from the closed list only", () => {
    let checked = 0;
    for (const sportKey of SPORT_KEYS) {
      const pre = generateStream(req(sportKey, { kind: "forfeit", by: "away", reason: "walkover", at: "before_start" }));
      expect(pre[0]?.type, sportKey).toBe("core.forfeit");
      const post = generateStream(req(sportKey, { kind: "forfeit", by: "home", reason: "retired", at: "after_start" }));
      expect(post[0]?.type, sportKey).toBe("core.start");
      // single-sport exemption inside the sweep: chess has no scoring event short of its result (boardgame's
      // eventSchemas: result, pairing, tiebreak — the game IS its result), so its retirement is START then the forfeit.
      if (sportKey === "boardgame") expect(post.map((e) => e.type), sportKey).toEqual(["core.start", "core.forfeit"]);
      else expect(post.length, `${sportKey}: at least one scoring event before the retirement`).toBeGreaterThan(2);
      for (const e of [...pre, ...post].filter((x) => x.type === "core.forfeit")) expect(REASONS).toContain((e.payload as { reason: string }).reason);
      checked++;
    }
    expect(checked).toBe(11);
  });

  it("X-RT-1: over EVERY variant of every sport, in a table and a bracket stage, the retirement's play leaves the match undecided — each sport's own scoring event for each side where it has two, none where it has none (chess)", () => {
    let built = 0;
    let refused = 0;
    const scoredBoth = new Set<string>();
    for (const sportKey of SPORT_KEYS) {
      for (const variant of variantKeys(sportKey)) {
        for (const stageKind of ["league", "knockout"] as const) {
          const cfg = stageCfg(sportKey, resolveSportCfg(sportKey, variant), stageKind);
          try {
            const s = generateStream({ sportKey, cfg, stageKind, home: "H", away: "A", outcome: { kind: "forfeit", by: "home", reason: "retired", at: "after_start" } });
            // The fold the product runs: START, the play, the forfeit, and only the forfeit decides (D2: an award to the other side).
            const played = s.slice(0, -1);
            expect(foldStream(sportModule(sportKey), cfg, "H", "A", played).outcome, `${sportKey}/${variant}/${stageKind}: decided before the retirement`).toBeNull();
            const names = (id: string) => played.slice(1).some((e) => JSON.stringify(e.payload).includes(`"${id}"`));
            const sides = new Set(["H", "A"].filter(names));
            if (sides.size === 2) scoredBoth.add(sportKey);
            built++;
          } catch (e) {
            // A refusal is named, never a crash: a variant whose partial play would decide (OutcomeUnreachable).
            expect(e, `${sportKey}/${variant}/${stageKind}`).toBeInstanceOf(OutcomeUnreachable);
            refused++;
          }
        }
      }
    }
    expect(built).toBeGreaterThan(0);
    process.stdout.write(`X-RT-1 partial play: ${built} built, ${refused} refused by name, both sides scored in ${scoredBoth.size} sports\n`);
    // Every sport but chess (no scoring event short of its result) and cricket (HOME bats first: its partial names no
    // entrant id — the innings order does) credits both sides by entrant id.
    expect([...scoredBoth].sort()).toEqual(SPORT_KEYS.filter((k) => k !== "boardgame" && k !== "cricket").sort());
  });

  it("X-DW-1: every sport builds a double walkover as core.forfeit {by: both, reason: walkover}, chess included (M7)", () => {
    let checked = 0;
    for (const sportKey of SPORT_KEYS) {
      const s = generateStream(req(sportKey, { kind: "double_walkover" }));
      expect(s, sportKey).toEqual([{ type: "core.forfeit", payload: { by: "both", reason: "walkover" } }]);
      checked++;
    }
    expect(checked).toBe(11);
  });

  it("labels: W1's two forfeit labels are byte-identical (committed case ids), and every (side, reason, phase) request and the double walkover has its own", () => {
    expect(outcomeLabel({ kind: "forfeit", by: "away", reason: "walkover", at: "before_start" })).toBe("forfeit-away-walkover");
    expect(outcomeLabel({ kind: "forfeit", by: "home", reason: "retired", at: "after_start" })).toBe("forfeit-home-retired");
    const fresh: RequestedOutcome[] = [{ kind: "double_walkover" }];
    for (const by of ["home", "away"] as const) for (const reason of REASONS) for (const at of ["before_start", "after_start"] as const) fresh.push({ kind: "forfeit", by, reason, at });
    expect(fresh.length).toBe(1 + 2 * REASONS.length * 2);
    const labels = [...ALL_OUTCOMES.filter((o) => o.kind !== "forfeit"), ...fresh].map(outcomeLabel);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("X-DW-1: the harness observes double_walkover as itself, never as undecided", () => {
    expect(toObservedOutcome({ kind: "double_walkover" })).toEqual({ kind: "double_walkover" });
    expect(toObservedOutcome({ kind: "award", winner: "a", loser: "b", reason: "retired" })).toEqual({ kind: "award", winner: "a", loser: "b", reason: "retired" });
    expect(toObservedOutcome({ kind: "award", winner: "a", loser: null, reason: "bye" })).toEqual({ kind: "award", winner: "a", loser: null, reason: "bye" });
  });
});
