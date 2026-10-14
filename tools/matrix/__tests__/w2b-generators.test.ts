// W2b Task 2 (spec §5.6, §8.1; plan finding 10): the harness's generator breadth for forfeits. A walkover is posted
// BEFORE core.start (the phase guard refuses one after it, D3 R2); a retirement or disqualification AFTER core.start and
// some play (D3 R4); a double walkover is core.forfeit {by: "both", reason: "walkover"} in every sport, chess included
// (M7); and the harness observes `double_walkover` as itself, never as undecided. Expected values are the rule rows'
// (X-RS-1, X-DW-1) and D1's closed reason list, never read back from the generators.
import { FORFEIT_REASONS as ENGINE_FORFEIT_REASONS } from "@seazn/engine/core";
import { describe, expect, it } from "vitest";
import { SPORT_KEYS } from "../lib/catalogue.ts";
import { foldStream } from "../lib/fold.ts";
import { toObservedOutcome } from "../lib/observed.ts";
import { resolveSportCfg, sportModule, stageCfg, variantKeys } from "../lib/sport-cfg.ts";
import { ForfeitPostingRefused, forfeitPosting, generateStream, holdsPlay, partialPlay } from "../lib/streams/index.ts";
import { ALL_OUTCOMES, FORFEIT_REASONS, OutcomeUnreachable, START, outcomeLabel, type RequestedOutcome, type StreamRequest } from "../lib/streams/types.ts";
import { offlineBuilderDefault } from "../lib/variants.ts";
import { defaultLineupPair, makeEnvelope, onePlayEvent } from "@seazn/engine/testkit";

/** D1 (plan Decisions): the four reasons, typed here from the decision, never read from the code under test. */
const REASONS = ["walkover", "retired", "disqualified", "withdrew"] as const;

/** generateStream's real request shape (streams/types.ts StreamRequest): a sport, its resolved cfg, a stage kind and two
 *  entrant ids. The brief's `{ sportKey, cfg: {} }` is not a request: a sport generator reads its cfg (bestOf, set
 *  targets, overs), so each sport is asked under its builder-default variant, resolved by its own configSchema. */
const req = (sportKey: string, outcome: unknown): StreamRequest =>
  ({ sportKey, cfg: resolveSportCfg(sportKey, offlineBuilderDefault(sportKey)), stageKind: "league", home: "H", away: "A", outcome }) as StreamRequest;

describe("W2b generator breadth (spec §5.6)", () => {
  it("D1: the harness's restated reason list is the engine's FORFEIT_REASONS, member for member and in order", () => {
    // The restatement exists so streams/types.ts stays type-only on the engine; this pin is what keeps it honest.
    expect([...FORFEIT_REASONS]).toEqual([...REASONS]);
    expect([...ENGINE_FORFEIT_REASONS]).toEqual([...REASONS]);
    expect(FORFEIT_REASONS.length).toBe(4);
  });

  it("empty case first: a walkover request before start posts no core.start", () => {
    const s = generateStream({ sportKey: "generic", cfg: {}, stageKind: "league", home: "H", away: "A", outcome: { kind: "forfeit", by: "away", reason: "walkover", at: "before_start" } });
    expect(s.map((e) => e.type)).toEqual(["core.forfeit"]);
  });

  it("X-RS-1 + rulings 113, 118: every sport builds a walkover before START and a disqualification after it; a retirement after START and some play — or, where the module declares its Start play (chess), after START alone; reasons from the closed list only", () => {
    let checked = 0;
    let refusedRetired = 0;
    let startIsPlayRetired = 0;
    for (const sportKey of SPORT_KEYS) {
      const pre = generateStream(req(sportKey, { kind: "forfeit", by: "away", reason: "walkover", at: "before_start" }));
      expect(pre[0]?.type, sportKey).toBe("core.forfeit");
      const dq = generateStream(req(sportKey, { kind: "forfeit", by: "home", reason: "disqualified", at: "after_start" }));
      expect(dq[0]?.type, sportKey).toBe("core.start");
      const posted = [...pre, ...dq];
      // Ruling 113: the engine's own witness decides whether a retirement is buildable — something played after START,
      // undecided (testkit onePlayEvent, drawn from the module's generator).
      const m = sportModule(sportKey);
      const enginePlays = onePlayEvent(m as never, req(sportKey, null).cfg, defaultLineupPair(m.positions), [makeEnvelope(1, { type: "core.start", payload: {} })]) !== null;
      const retire = () => generateStream(req(sportKey, { kind: "forfeit", by: "home", reason: "retired", at: "after_start" }));
      if (enginePlays) {
        const post = retire();
        expect(post[0]?.type, sportKey).toBe("core.start");
        expect(post.slice(1, -1).some((e) => !e.type.startsWith("core.")), `${sportKey}: a sport event is played before the retirement`).toBe(true);
        posted.push(...post);
      } else if (m.startIsPlay === true) {
        // Ruling 118: nothing to play short of the result, but the Start is play — START, then the retirement, which
        // the real engine records as the retiree's loss.
        const post = retire();
        expect(post.map((e) => e.type), sportKey).toEqual(["core.start", "core.forfeit"]);
        expect(foldStream(m, req(sportKey, null).cfg, "H", "A", post).outcome, `${sportKey}: the retirement decides`).toEqual({ kind: "award", winner: "A", loser: "H", reason: "retired" });
        posted.push(...post);
        startIsPlayRetired++;
      } else {
        expect(retire, `${sportKey}: nothing is played short of the result, so no retirement (ruling 113)`).toThrow(OutcomeUnreachable);
        expect(retire, sportKey).toThrow(/ruling 113/);
        refusedRetired++;
      }
      for (const e of posted.filter((x) => x.type === "core.forfeit")) expect(REASONS).toContain((e.payload as { reason: string }).reason);
      checked++;
    }
    expect(checked).toBe(11);
    // Ruling 118: chess, the one sport with nothing played short of its result, declares its Start play — so on the real
    // registry every sport retires and the refusal is reached by holdsPlay's own test below.
    expect([refusedRetired, startIsPlayRetired]).toEqual([0, 1]);
  });

  it("holdsPlay (rulings 113, 118): START alone is play only where the module declares it; a sport event after START always is; nothing is never — and every sport's partial play holds play for its own module", () => {
    const sportEvent = { type: "generic.score", payload: { by: "H", points: 1 } };
    const rows: [string, Parameters<typeof holdsPlay>[0], { startIsPlay?: boolean }, boolean][] = [
      ["nothing, no declaration", [], {}, false],
      ["nothing, Start is play", [], { startIsPlay: true }, false],
      ["START alone, no declaration (ruling 113)", [START], {}, false],
      ["START alone, Start is play (ruling 118)", [START], { startIsPlay: true }, true],
      ["START then a sport event", [START, sportEvent], {}, true],
      ["START then only kernel events", [START, { type: "core.note", payload: { text: "x" } }], {}, false],
    ];
    for (const [name, play, module, want] of rows) expect(holdsPlay(play, module), name).toBe(want);
    let swept = 0;
    for (const sportKey of SPORT_KEYS) {
      const play = partialPlay(req(sportKey, { kind: "forfeit", by: "home", reason: "retired", at: "after_start" }));
      expect(holdsPlay(play, sportModule(sportKey)), `${sportKey}: its partial play is play`).toBe(true);
      swept++;
    }
    expect([rows.length, swept]).toEqual([6, 11]);
  });

  it("X-RT-1: over EVERY variant of every sport, in a table and a bracket stage, the retirement's play leaves the match undecided — each sport's own scoring event for each side where it has two; START alone where it has none (chess, ruling 118)", () => {
    let built = 0;
    let refused = 0;
    const scoredBoth = new Set<string>();
    for (const sportKey of SPORT_KEYS) {
      for (const variant of variantKeys(sportKey)) {
        for (const stageKind of ["league", "knockout"] as const) {
          const cfg = stageCfg(sportKey, resolveSportCfg(sportKey, variant), stageKind, variant);
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

  it("forfeitPosting (M-2): on a scheduled fixture a walkover or double walkover WITH play, and a retirement or disqualification with NONE, are refused by name; each well-formed pair posts, and a fixture under way takes the forfeit bare", () => {
    // The rows: D3 R2 (a walkover is recorded before START) and D3 R4 (a retirement or disqualification after START and
    // some play), over each reason the harness posts and the double walkover. Play is generic's real partial play.
    const play = partialPlay(req("generic", { kind: "forfeit", by: "home", reason: "retired", at: "after_start" }));
    expect(play[0]?.type).toBe("core.start");
    const rows: [string, "walkover" | "retired" | "disqualified", boolean, RegExp | null][] = [
      ["H", "walkover", false, null], ["H", "walkover", true, /a walkover forfeit on a scheduled fixture is recorded before core\.start/],
      ["both", "walkover", false, null], ["both", "walkover", true, /a double walkover on a scheduled fixture is recorded before core\.start/],
      ["A", "retired", true, null], ["A", "retired", false, /a retired forfeit on a scheduled fixture is recorded after core\.start and some play, but none/],
      ["A", "disqualified", true, null], ["A", "disqualified", false, /a disqualified forfeit .* but none/],
    ];
    // START alone: the composition is the shape's (D3 R4: something after START), which a bare START meets for both
    // reasons. Whether a bare START is enough for a RETIREMENT is the sport's (ruling 113; ruling 118 for chess) —
    // generateStream judges it with the module (`holdsPlay`, below), never this sport-blind composition.
    const bare = play.slice(0, 1);
    for (const reason of ["disqualified", "retired"] as const) {
      expect(forfeitPosting("scheduled", { by: "A", reason }, bare).map((e) => e.type), `A ${reason} bare start`).toEqual(["core.start", "core.forfeit"]);
    }
    let checked = 0;
    for (const [by, reason, withPlay, refused] of rows) {
      const given = withPlay ? play : [];
      const post = () => forfeitPosting("scheduled", { by, reason }, given);
      if (refused === null) expect(post().map((e) => e.type), `${by} ${reason} play=${withPlay}`).toEqual([...given.map((e) => e.type), "core.forfeit"]);
      else {
        expect(post, `${by} ${reason} play=${withPlay}`).toThrow(ForfeitPostingRefused);
        expect(post, `${by} ${reason} play=${withPlay}`).toThrow(refused);
      }
      // Under way, the forfeit goes in bare whatever play was generated.
      expect(forfeitPosting("live", { by, reason }, given), `${by} ${reason} live`).toEqual([{ type: "core.forfeit", payload: { by, reason } }]);
      checked++;
    }
    expect(checked).toBe(8);
    expect(() => forfeitPosting("scheduled", { by: "A", reason: "retired" }, play.slice(1))).toThrow(/starts with core\.start, not/);
    // A request the rule refuses is refused by generateStream too, not posted.
    expect(() => generateStream(req("generic", { kind: "forfeit", by: "home", reason: "retired", at: "before_start" }))).toThrow(ForfeitPostingRefused);
    expect(() => generateStream(req("generic", { kind: "forfeit", by: "away", reason: "walkover", at: "after_start" }))).toThrow(ForfeitPostingRefused);
  });

  it("X-DW-1: the harness observes double_walkover as itself, never as undecided", () => {
    expect(toObservedOutcome({ kind: "double_walkover" })).toEqual({ kind: "double_walkover" });
    expect(toObservedOutcome({ kind: "award", winner: "a", loser: "b", reason: "retired" })).toEqual({ kind: "award", winner: "a", loser: "b", reason: "retired" });
    expect(toObservedOutcome({ kind: "award", winner: "a", loser: null, reason: "bye" })).toEqual({ kind: "award", winner: "a", loser: null, reason: "bye" });
  });
});
