import { describe, expect, it } from "vitest";
import { BRACKET_KINDS, StageKind, foldMatch, outcomeOf, foldMatchWithStoppage } from "@seazn/engine/core";
import { boardgame } from "@seazn/engine/sports/boardgame"; // the "./sports/*" subpath export (engine package.json)
import { declaredCfgs, defaultLineupPair, forEachSport, makeEnvelope } from "@seazn/engine/testkit";
import { renderToStaticMarkup } from "react-dom/server";
import { NeedsDecisionBlock, SettleDialog, confirmBlocked, finalizeVisible, hasActiveAbandon, heldCause, needsDecision, type HeldCause } from "../needs-decision";
import en from "@/dictionaries/en/ui.json";

// W2a Task 11 (spec §5.5, UI-1 option A; controller ruling C12). The console's "Needs a decision" block shows iff the
// stage is a bracket kind AND the kernel's own `settleApplies` is true, fed the same facts. Pure predicates — the
// block's wiring is proven in a browser (e2e/bracket-finish.spec.ts), never here (apps/web vitest is node-env).

const plain = {}; // a module with no pending-decider hook
const start = { id: "e1", type: "core.start", voids_event_id: null };
const abandon = { id: "e2", type: "core.abandon", voids_event_id: null };
const voidOfAbandon = { id: "e3", type: "core.void", voids_event_id: "e2" };
const WIN = { kind: "win", winner: "a", loser: "b" };

/** A chess knockout fold: the bracket deciders the server merges in a bracket stage (`stageScopedCfg`), so a drawn
 *  game opens phase "tiebreak". Chess-only on purpose: boardgame is the one module declaring `awaitingDecider`. */
function chessKnockout(extra: (lineups: ReturnType<typeof defaultLineupPair>) => readonly { type: string; payload: unknown }[] = () => []) {
  const lineups = defaultLineupPair(boardgame.positions);
  const ko = boardgame.configSchema.parse({ ...boardgame.bracketDeciders!(boardgame.configSchema.parse({})) });
  const events = [
    makeEnvelope(1, { type: "core.start", payload: {} } as never),
    makeEnvelope(2, { type: "boardgame.result", payload: { winner: null, method: "agreement" } } as never),
    ...extra(lineups).map((e, i) => makeEnvelope(3 + i, e as never)),
  ];
  const folded = foldMatchWithStoppage(boardgame, ko, lineups, events);
  return { state: foldMatch(boardgame, ko, lineups, events), outcome: outcomeOf(boardgame, folded) };
}

describe("needsDecision = bracket kind AND the kernel's settleApplies (ruling C12; spec §5.5; finding 19)", () => {
  it("empty case first: nothing played, no events, in any kind, needs nothing", () => {
    let checked = 0;
    for (const k of StageKind.options) {
      expect(needsDecision(plain, { outcome: null, state: {}, stageKind: k, events: [] }), k).toBe(false);
      checked++;
    }
    expect(checked).toBe(StageKind.options.length);
    expect(checked).toBeGreaterThan(0);
  });

  it("empty case, every sport: a fresh, started knockout fixture needs nothing (forEachSport)", () => {
    let cfgs = 0;
    const visited = forEachSport(({ module }) => {
      for (const { name, cfg: base } of declaredCfgs(module as never)) {
        // The deciders the server merges into a bracket stage's cfg (stageScopedCfg) — what a knockout fold runs under.
        const cfg = module.configSchema.parse({ ...(base as object), ...(module.bracketDeciders?.(base as never) ?? {}) });
        const lineups = defaultLineupPair(module.positions);
        const events = [makeEnvelope(1, { type: "core.start", payload: {} } as never)];
        const folded = foldMatchWithStoppage(module, cfg as never, lineups, events);
        expect(needsDecision(module, { outcome: outcomeOf(module, folded), state: folded.state, stageKind: "knockout", events: [start] }), name).toBe(false);
        cfgs++;
      }
    });
    expect(visited).toBeGreaterThan(0);
    expect(cfgs).toBeGreaterThanOrEqual(visited);
  });

  it("a level outcome needs a decision in every bracket kind, and never outside brackets", () => {
    let checked = 0;
    let positives = 0;
    for (const outcome of [{ kind: "draw" }, { kind: "tie" }, { kind: "no_result" }]) {
      for (const k of StageKind.options) {
        const want = BRACKET_KINDS.has(k);
        expect(needsDecision(plain, { outcome, state: {}, stageKind: k, events: [start] }), `${outcome.kind} ${k}`).toBe(want);
        checked++;
        if (want) positives++;
      }
    }
    expect(checked).toBe(3 * StageKind.options.length);
    // Both answers are reached: a sweep whose every row says false would pass a `return false` body.
    expect(positives).toBe(3 * BRACKET_KINDS.size);
    expect(checked - positives).toBeGreaterThan(0);
  });

  it("an unknown or absent stage kind is never a bracket (a pre-W2a fixture with no stage)", () => {
    expect(needsDecision(plain, { outcome: { kind: "draw" }, state: {}, stageKind: null, events: [start] })).toBe(false);
    expect(needsDecision(plain, { outcome: { kind: "draw" }, state: {}, stageKind: "not-a-kind", events: [start] })).toBe(false);
  });

  it("finding 19: an ACTIVE scorer abandon with a null or level outcome needs a decision; with a win it does not", () => {
    expect(needsDecision(plain, { outcome: null, state: {}, stageKind: "knockout", events: [start, abandon] })).toBe(true);
    expect(needsDecision(plain, { outcome: { kind: "no_result" }, state: {}, stageKind: "knockout", events: [start, abandon] })).toBe(true);
    expect(needsDecision(plain, { outcome: WIN, state: {}, stageKind: "knockout", events: [start, abandon] })).toBe(false);
    // …and the same abandon in a league needs nothing: a league's abandoned match is void, not owed a settle.
    expect(needsDecision(plain, { outcome: null, state: {}, stageKind: "league", events: [start, abandon] })).toBe(false);
  });

  it("the generator's void (abandoned, outcome null, NO abandon event) and a voided abandon need nothing — the kernel would refuse the settle", () => {
    expect(hasActiveAbandon([])).toBe(false);
    expect(hasActiveAbandon([start])).toBe(false);
    expect(hasActiveAbandon([start, abandon])).toBe(true); // the positive pair
    expect(hasActiveAbandon([start, abandon, voidOfAbandon])).toBe(false);
    // A void of SOMETHING ELSE leaves the abandon active (the void must name this abandon).
    expect(hasActiveAbandon([start, abandon, { id: "e4", type: "core.void", voids_event_id: "e1" }])).toBe(true);
    expect(needsDecision(plain, { outcome: null, state: {}, stageKind: "knockout", events: [start] })).toBe(false);
    expect(needsDecision(plain, { outcome: null, state: {}, stageKind: "knockout", events: [start, abandon, voidOfAbandon] })).toBe(false);
  });

  it("C12: a chess knockout in phase tiebreak (status in_play, outcome null) needs a decision — lots is the organiser's settle", () => {
    const { state, outcome } = chessKnockout();
    expect((state as { phase: string }).phase).toBe("tiebreak");
    expect(outcome).toBeNull();
    expect(needsDecision(boardgame, { outcome, state, stageKind: "knockout", events: [start] })).toBe(true);
    expect(needsDecision(plain, { outcome, state, stageKind: "knockout", events: [start] })).toBe(false); // without the module's hook
  });

  it("D-C5: after the organiser's settle (phase still tiebreak, effective outcome a settled win) nothing more is needed", () => {
    const { state, outcome } = chessKnockout((lineups) => [{ type: "core.settle", payload: { winner: lineups.home.entrantId, method: "lot" } }]);
    expect((state as { phase: string }).phase).toBe("tiebreak"); // the module state is untouched by a settle
    expect(outcome).toMatchObject({ kind: "win", method: "settled_lot" });
    expect(needsDecision(boardgame, { outcome, state, stageKind: "knockout", events: [start] })).toBe(false);
  });

  it("decided (including a settled fixture) needs nothing", () => {
    expect(needsDecision(plain, { outcome: { ...WIN, method: "settled_lot" }, state: {}, stageKind: "knockout", events: [start, abandon] })).toBe(false);
  });

  it("confirmBlocked: blocked until a winner AND a method are chosen, and while sending (Review Focus 2)", () => {
    const rows: [string | null, string | null, boolean, boolean][] = [
      [null, null, false, true], ["a", null, false, true], [null, "lot", false, true], ["a", "lot", false, false], ["a", "lot", true, true],
    ];
    let checked = 0;
    for (const [winner, method, sending, blocked] of rows) {
      expect(confirmBlocked({ winner, method, sending }), JSON.stringify([winner, method, sending])).toBe(blocked);
      checked++;
    }
    expect(checked).toBe(5);
  });

  it("finalizeVisible: Finalize shows for a decided fixture and never while it is held (finding 27)", () => {
    expect(finalizeVisible({ decided: true, held: false })).toBe(true);
    expect(finalizeVisible({ decided: true, held: true })).toBe(false);
    expect(finalizeVisible({ decided: false, held: false })).toBe(false);
  });
});

// Ruling D-H3 (fix round 1): the block's sentence names WHY the match is held — a level result, an abandon that decided
// nobody, or a drawn chess game whose tie-break is still owed — instead of one sentence ("can't end level") that was
// false for the other two. The cause is read from the same facts `needsDecision` reads, real folds where a sport has one.
describe("heldCause and the block's sentence (ruling D-H3)", () => {
  const LEVEL = { kind: "draw" };
  const body = (cause: HeldCause) =>
    renderToStaticMarkup(
      <NeedsDecisionBlock
        msg={(k) => (en as Record<string, string>)[k] ?? k}
        cause={cause}
        home={{ id: "h", name: "Riverside" }}
        away={{ id: "a", name: "Summit" }}
        busy={false}
        settle={async () => ({ ok: true })}
      />,
    );

  it("each held shape names its own cause; an abandon wins over the outcome it left behind", () => {
    const { outcome: pending } = chessKnockout();
    expect(pending, "a drawn chess knockout game owes its tie-break: no outcome yet").toBeNull();
    const rows: [string, Parameters<typeof heldCause>[0], HeldCause][] = [
      ["a level result", { outcome: LEVEL, events: [start] }, "level"],
      ["an abandon that decided nobody (outcome null)", { outcome: null, events: [start, abandon] }, "abandoned"],
      ["an abandon over a level outcome", { outcome: LEVEL, events: [start, abandon] }, "abandoned"],
      ["a chess tie-break still owed (the real fold)", { outcome: pending, events: [start] }, "tiebreak"],
      ["a VOIDED abandon in a tie-break", { outcome: null, events: [start, abandon, voidOfAbandon] }, "tiebreak"],
    ];
    let checked = 0;
    for (const [why, facts, cause] of rows) {
      expect(heldCause(facts), why).toBe(cause);
      checked++;
    }
    expect(checked).toBe(5);
  });

  it("the block says the cause's own sentence, and only that one", () => {
    const sentences: Record<HeldCause, string> = {
      level: en["score.needsDecision.body"]!,
      abandoned: en["score.needsDecision.body.abandoned"]!,
      tiebreak: en["score.needsDecision.body.tiebreak"]!,
    };
    expect(new Set(Object.values(sentences)).size, "three different sentences").toBe(3);
    let checked = 0;
    for (const [cause, sentence] of Object.entries(sentences) as [HeldCause, string][]) {
      const html = body(cause);
      expect(html, cause).toContain(sentence.replace(/'/g, "&#x27;"));
      for (const other of Object.values(sentences).filter((s) => s !== sentence)) {
        expect(html, `${cause} must not say another cause's sentence`).not.toContain(other.replace(/'/g, "&#x27;"));
      }
      checked++;
    }
    expect(checked).toBe(3);
  });
});

// Fix round 1 (M12): at ≥640 the dialog's two winner buttons sit side by side, and the names were `truncate` — two long
// entrant names ("Riverside Chess Club Juniors A" v "Summit Knights Academy Second XI") lost their tails, the one
// thing the organiser is choosing between. They wrap now; the button grows to fit.
describe("the settle dialog never truncates a name (M12)", () => {
  const LONG = { home: "Riverside Chess Club Juniors A", away: "Summit Knights Academy Second XI" };
  it("each winner button carries its whole name, wrapping — no truncate, no ellipsis", () => {
    const html = renderToStaticMarkup(
      <SettleDialog
        msg={(k) => (en as Record<string, string>)[k] ?? k}
        cause="level"
        home={{ id: "h", name: LONG.home }}
        away={{ id: "a", name: LONG.away }}
        busy={false}
        settle={async () => ({ ok: true })}
        onClose={() => {}}
        onRefused={() => {}}
      />,
    );
    let checked = 0;
    for (const [id, name] of [["h", LONG.home], ["a", LONG.away]] as const) {
      const button = new RegExp(`<button[^>]*data-testid="settle-winner-${id}"[^>]*>(.*?)</button>`).exec(html);
      expect(button, id).not.toBeNull();
      expect(button![1], id).toContain(name);
      expect(button![1], `${id}: the name must wrap, not truncate`).not.toMatch(/\btruncate\b/);
      expect(button![1], `${id}: and break a long word rather than overflow`).toMatch(/\bbreak-words\b/);
      checked++;
    }
    expect(checked).toBe(2);
  });
});
