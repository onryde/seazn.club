import { describe, expect, it } from "vitest";
import { BRACKET_KINDS, DRAW_KINDS, FORFEIT_REASONS, StageKind, foldMatch, outcomeOf, foldMatchWithStoppage } from "@seazn/engine/core";
import { boardgame } from "@seazn/engine/sports/boardgame"; // the "./sports/*" subpath export (engine package.json)
import { declaredCfgs, defaultLineupPair, forEachSport, makeEnvelope } from "@seazn/engine/testkit";
import { renderToStaticMarkup } from "react-dom/server";
import { HeldNote, NeedsDecisionBlock, SettleDialog, abandonExpunged, confirmBlocked, finalizeVisible, hasActiveAbandon, heldBodyKey, heldCause, heldWaitingKey, inTableStage, needsDecision, type HeldCause } from "../needs-decision";
import en from "@/dictionaries/en/ui.json";
import es from "@/dictionaries/es/ui.json";
import fr from "@/dictionaries/fr/ui.json";
import nl from "@/dictionaries/nl/ui.json";

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

  it("P1 follow-up — empty case, every sport, every bracket kind: a SCHEDULED fixture (no match_states row, so getFixtureState serves state null) renders as needing nothing, never held and never a crash", () => {
    // The empty case above passes `state: {}` with a hook-less module; the page passes `match_states.state ?? null`
    // and the REAL module. A scheduled chess knockout read `null.phase` in boardgame's hook and crashed its console.
    let checked = 0;
    const visited = forEachSport(({ key, module }) => {
      for (const k of BRACKET_KINDS) {
        expect(needsDecision(module, { outcome: null, state: null, stageKind: k, events: [] }), `${key} ${k}`).toBe(false);
        checked++;
      }
    });
    expect(visited).toBeGreaterThan(0);
    expect(checked).toBe(visited * BRACKET_KINDS.size);
    // The positive pair: the same real module, on a drawn knockout game whose tie-break is owed, IS held.
    const pending = chessKnockout();
    expect(needsDecision(boardgame, { outcome: pending.outcome, state: pending.state, stageKind: "knockout", events: [start] })).toBe(true);
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
    // …and a TABLE stage's abandon that decided nobody IS held too (X-AB-5, the sweep below); a bracket's level
    // `no_result` is a held result, a table's is a result the standings credit.
    expect(needsDecision(plain, { outcome: { kind: "no_result" }, state: {}, stageKind: "league", events: [start, abandon] })).toBe(false);
  });

  it("I1 / X-AB-5: in EVERY table kind an active abandon that decided nobody needs a decision - the server's settle guard takes it, so the block must offer it (counted)", () => {
    // [name, outcome, events, expected]: the same rows the server's guard decides (abandon-swiss-settle.test.ts), read
    // through the console's predicate. A draw/win in a table is a RESULT; a voided abandon is no abandon; the generator's
    // void has no ledger; a withdrawal's expunge took the match out of the table.
    const expunge = { id: "e2", type: "core.abandon", voids_event_id: null, payload: { reason: "withdrew", expunge: true } };
    const rows: [string, unknown, readonly { id: string; type: string; voids_event_id: string | null; payload?: unknown }[], boolean][] = [
      ["abandoned, nobody decided", null, [start, abandon], true],
      ["abandoned, nobody decided, a payload without expunge", null, [start, { ...abandon, payload: { reason: "rain" } }], true],
      ["abandoned over a shared draw", { kind: "draw" }, [start, abandon], false],
      ["abandoned with a leader's win", WIN, [start, abandon], false],
      ["a played draw", { kind: "draw" }, [start], false],
      ["the generator's void (no ledger)", null, [start], false],
      ["a voided abandon", null, [start, abandon, voidOfAbandon], false],
      ["a withdrawal's expunge", null, [start, expunge], false],
    ];
    let checked = 0;
    let positives = 0;
    for (const kind of DRAW_KINDS)
      for (const [why, outcome, events, want] of rows) {
        expect(needsDecision(plain, { outcome, state: {}, stageKind: kind, events }), `${kind}: ${why}`).toBe(want);
        checked++;
        if (want) positives++;
      }
    expect(checked).toBe(DRAW_KINDS.size * rows.length);
    expect(positives, "both answers are reached").toBe(DRAW_KINDS.size * 2);
    // A fixture outside any stage reads as a table; an unknown kind too.
    expect(needsDecision(plain, { outcome: null, state: {}, stageKind: null, events: [start, abandon] })).toBe(true);
  });

  it("I1: the console's predicate IS the server's - the same engine function answers both (sequence: abandon, void, abandon again, settle)", () => {
    const again = { id: "e5", type: "core.abandon", voids_event_id: null };
    const sequence: [string, unknown, { id: string; type: string; voids_event_id: string | null }[], boolean][] = [
      ["started", null, [start], false],
      ["abandoned", null, [start, abandon], true],
      ["abandon undone", null, [start, abandon, voidOfAbandon], false],
      ["abandoned again", null, [start, abandon, voidOfAbandon, again], true],
      ["settled (effective outcome a win)", WIN, [start, abandon, voidOfAbandon, again, { id: "e6", type: "core.settle", voids_event_id: null }], false],
    ];
    for (const [why, outcome, events, want] of sequence)
      expect(needsDecision(plain, { outcome, state: {}, stageKind: "swiss", events }), why).toBe(want);
    expect(sequence.some(([, , , w]) => w) && sequence.some(([, , , w]) => !w)).toBe(true);
  });

  it("abandonExpunged reads the ACTIVE abandon's payload the way the fold does (expunge === true) and nothing else", () => {
    const ex = (extra: object = {}) => ({ id: "e2", type: "core.abandon", voids_event_id: null, payload: { reason: "withdrew", expunge: true, ...extra } });
    expect(abandonExpunged([])).toBe(false);
    expect(abandonExpunged([start, abandon])).toBe(false); // no payload at all
    expect(abandonExpunged([start, { ...abandon, payload: { reason: "rain" } }])).toBe(false);
    expect(abandonExpunged([start, ex()])).toBe(true); // the positive pair
    expect(abandonExpunged([start, ex({ expunge: "true" })]), "only the literal true").toBe(false);
    expect(abandonExpunged([start, ex(), voidOfAbandon]), "a voided expunge is gone").toBe(false);
    expect(abandonExpunged([start, { ...start, payload: { expunge: true } }]), "not an abandon").toBe(false);
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

describe("X-AB-5 table copy: a TABLE stage's held abandon speaks of the winner, not of who advances", () => {
  const msgEn = (k: string) => (en as Record<string, string>)[k] ?? k;
  const CAUSES: HeldCause[] = ["level", "abandoned", "tiebreak"];
  const html = (cause: HeldCause, table: boolean) =>
    renderToStaticMarkup(
      <NeedsDecisionBlock msg={msgEn as never} cause={cause} table={table} home={{ id: "h", name: "Riverside" }} away={{ id: "a", name: "Summit" }} busy={false} settle={async () => ({ ok: true })} />,
    );

  it("inTableStage is the complement of the bracket kinds, for every kind and for no stage at all (counted)", () => {
    let checked = 0;
    for (const k of StageKind.options) {
      expect(inTableStage(k), k).toBe(!BRACKET_KINDS.has(k));
      checked++;
    }
    expect(checked).toBe(BRACKET_KINDS.size + DRAW_KINDS.size);
    expect(inTableStage(null), "no stage").toBe(true);
  });

  it("only the abandoned cause changes in a table; a bracket keeps every sentence it had", () => {
    for (const cause of CAUSES) {
      expect(heldBodyKey(cause, false), `bracket body ${cause}`).toBe(cause === "abandoned" ? "score.needsDecision.body.abandoned" : cause === "level" ? "score.needsDecision.body" : "score.needsDecision.body.tiebreak");
      expect(heldWaitingKey(cause, false), `bracket waiting ${cause}`).toBe(cause === "tiebreak" ? "score.needsDecision.waiting.tiebreak" : "score.needsDecision.waiting");
    }
    expect(heldBodyKey("abandoned", true)).toBe("score.needsDecision.body.abandoned.table");
    expect(heldWaitingKey("abandoned", true)).toBe("score.needsDecision.waiting.table");
    // The causes a table never reaches fall back to the bracket sentence rather than to a missing key.
    expect(heldBodyKey("level", true)).toBe("score.needsDecision.body");
    expect(heldWaitingKey("tiebreak", true)).toBe("score.needsDecision.waiting.tiebreak");
  });

  it("the table block says the table sentence and the winner question; the bracket block says neither - markup, English", () => {
    const tableHtml = html("abandoned", true);
    const bracketHtml = html("abandoned", false);
    const apos = (t: string) => t.replace(/'/g, "&#x27;");
    expect(tableHtml).toContain(apos(en["score.needsDecision.body.abandoned.table"]!));
    expect(tableHtml).not.toContain(apos(en["score.needsDecision.body.abandoned"]!));
    expect(bracketHtml).toContain(apos(en["score.needsDecision.body.abandoned"]!));
    expect(bracketHtml).not.toContain(apos(en["score.needsDecision.body.abandoned.table"]!));
    // "choose who advances" has no meaning in a table
    expect(en["score.needsDecision.body.abandoned.table"]!.toLowerCase()).not.toContain("advance");
    expect(en["score.needsDecision.waiting.table"]!.toLowerCase()).not.toContain("advance");
  });

  it("the official's held line follows the stage: the table line in a table, the bracket line in a bracket", () => {
    const note = (table: boolean) => renderToStaticMarkup(<HeldNote msg={msgEn as never} cause="abandoned" table={table} />);
    expect(note(true)).toContain(en["score.needsDecision.waiting.table"]!.replace(/'/g, "&#x27;"));
    expect(note(true)).not.toContain(en["score.needsDecision.waiting"]!);
    expect(note(false)).toContain(en["score.needsDecision.waiting"]!);
    expect(note(false)).not.toContain(en["score.needsDecision.waiting.table"]!);
    expect(note(true)).toContain('data-cause="abandoned"');
  });

  it("the dialog asks who WON in a table and who ADVANCES in a bracket", () => {
    const dialog = (table: boolean) =>
      renderToStaticMarkup(
        <SettleDialog msg={msgEn as never} cause="abandoned" table={table} home={{ id: "h", name: "Riverside" }} away={{ id: "a", name: "Summit" }} busy={false} settle={async () => ({ ok: true })} onClose={() => {}} onRefused={() => {}} />,
      );
    expect(dialog(true)).toContain(en["score.needsDecision.whoWins"]!);
    expect(dialog(true)).not.toContain(en["score.needsDecision.whoAdvances"]!);
    expect(dialog(false)).toContain(en["score.needsDecision.whoAdvances"]!);
    expect(dialog(false)).not.toContain(en["score.needsDecision.whoWins"]!);
  });

  it("every locale carries the three new keys, translated (not the English string) and non-empty", () => {
    const keys = ["score.needsDecision.body.abandoned.table", "score.needsDecision.waiting.table", "score.needsDecision.whoWins"] as const;
    let checked = 0;
    for (const [loc, dict] of [["es", es], ["fr", fr], ["nl", nl]] as const)
      for (const k of keys) {
        const v = (dict as Record<string, string>)[k];
        expect(v, `${loc} ${k}`).toBeTruthy();
        expect(v, `${loc} ${k} must be translated`).not.toBe((en as Record<string, string>)[k]);
        checked++;
      }
    expect(checked).toBe(9);
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

// W2b Task 8 (merge notice D-R9; legacy rows only, PF-8a): a W2a withdrawal left a held line held, so its settle dialog
// offered the withdrawn entrant as a winner the server then refused (SETTLE_NOT_APPLICABLE withdrawn, C17). The dialog
// now offers only the sides still in the competition. New rows cannot reach it: a withdrawal walks a held line over.
describe("the settle dialog never offers a withdrawn entrant (D-R9)", () => {
  const dialog = (home: { id: string; name: string; withdrawn?: boolean }, away: { id: string; name: string; withdrawn?: boolean }, feedsNextMatch?: boolean) =>
    renderToStaticMarkup(
      <SettleDialog
        msg={(k) => (en as Record<string, string>)[k] ?? k}
        cause="level"
        home={home}
        away={away}
        feedsNextMatch={feedsNextMatch}
        busy={false}
        settle={async () => ({ ok: true })}
        onClose={() => {}}
        onRefused={() => {}}
      />,
    );
  const offered = (html: string) => [...html.matchAll(/data-testid="settle-winner-([^"]+)"/g)].map((m) => m[1]);

  it("D-R9: a withdrawn side is not a choice; the remaining side is — on either seat", () => {
    let checked = 0;
    for (const gone of ["h", "a"] as const) {
      const html = dialog({ id: "h", name: "Home", withdrawn: gone === "h" }, { id: "a", name: "Away", withdrawn: gone === "a" });
      expect(offered(html), `${gone} withdrawn`).toEqual([gone === "h" ? "a" : "h"]);
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("D-R9 positive pair: with nobody withdrawn (flag absent or false) both sides are offered, home first", () => {
    expect(offered(dialog({ id: "h", name: "Home" }, { id: "a", name: "Away" }))).toEqual(["h", "a"]);
    expect(offered(dialog({ id: "h", name: "Home", withdrawn: false }, { id: "a", name: "Away", withdrawn: false }))).toEqual(["h", "a"]);
  });

  // Loop-F review M-8: both sides withdrawn (a legacy row, PF-8a) left the dialog with an empty "Who advances?" — it
  // now says why there is no choice, and Confirm stays blocked (no winner can be chosen).
  it("M-8: both sides withdrawn — no choice is offered and the dialog says why; with one side left it says nothing", () => {
    const noChoice = (html: string) => /data-testid="settle-no-choice"[^>]*>([^<]*)</.exec(html)?.[1] ?? null;
    const both = dialog({ id: "h", name: "Home", withdrawn: true }, { id: "a", name: "Away", withdrawn: true });
    expect(offered(both)).toEqual([]);
    expect(noChoice(both)).toBe((en as Record<string, string>)["score.needsDecision.noChoice"]);
    expect(/data-testid="settle-confirm"[^>]*disabled=""/.test(both), "Confirm is blocked").toBe(true);
    let checked = 0;
    for (const gone of [null, "h", "a"] as const) {
      const html = dialog({ id: "h", name: "Home", withdrawn: gone === "h" }, { id: "a", name: "Away", withdrawn: gone === "a" });
      expect(noChoice(html), `${gone ?? "nobody"} withdrawn`).toBeNull();
      checked++;
    }
    expect(checked).toBe(3);
  });

  // Loop-F R-4, rewritten by Loop R M-12: the sentence names the way out in every locale — the route
  // withdrawal-w2b.test.ts "R-4" drives: void back into play, then a forfeit. It names the console's own controls by
  // their own labels: "Void last entry", "Forfeit…", and in the forfeit dialog "Both sides" (offered only while nothing
  // is played: a double walkover is a walkover, R2) or a side with the reason that fits, which after play is a
  // retirement or a disqualification (D3; PF-2 keeps the withdrawal the cascade's own). It once told the organiser to
  // record a disqualification that never happened, quoting the engine's raw value «disqualified» in es/fr/nl (the
  // dialog has said "Disqualification: …" since design audit 1.2) and naming a retirement ("abandono", "opgave") as the
  // forfeit in es/nl. Every label is read from the dictionary the dialog renders, never typed here; a reason label's
  // word is its noun, the part before the "Noun: gloss" colon.
  it("R-4 / M-12: the no-choice sentence names the console's real options by their own labels, in every locale", () => {
    const LOCALES: [string, Record<string, string>][] = [["en", en], ["es", es], ["fr", fr], ["nl", nl]];
    const noun = (label: string | undefined) => {
      expect(label, "the dialog's label exists").toBeTruthy();
      const at = label!.indexOf(":");
      expect(at, `"${label}" keeps its "Noun: gloss" form`).toBeGreaterThan(0);
      return label!.slice(0, at).trim();
    };
    const lines = new Set<string>();
    let labels = 0;
    let checked = 0;
    for (const [locale, dict] of LOCALES) {
      const line = dict["score.needsDecision.noChoice"]!;
      const owed = [
        dict["score.voidLast"]!.replace(/^[^\p{L}]+/u, ""), // the console's "⟲ Void last entry", without its glyph
        dict["score.forfeit"]!,
        dict["forfeitDialog.who.both"]!,
        noun(dict["forfeitDialog.reason.retired"]),
        noun(dict["forfeitDialog.reason.disqualified"]),
      ];
      for (const label of owed) {
        expect(label, `${locale}: a label to name`).toBeTruthy();
        expect(line.includes(label), `${locale}: names the control "${label}" by its own label`).toBe(true);
        labels++;
      }
      // No raw engine reason value: the dialog never shows one.
      for (const code of FORFEIT_REASONS) {
        expect(new RegExp(`\\b${code}\\b`, "u").test(line), `${locale}: no raw reason value "${code}"`).toBe(false);
      }
      lines.add(line);
      checked++;
    }
    expect(checked).toBe(4);
    expect(labels).toBe(4 * 5);
    expect(lines.size, "four translations, not one sentence copied").toBe(4);
  });

  // Loop-F tidy 2: on a line that feeds NO next match — a final, a grand final, a third-place line — the R-4 route would
  // award the title or the place to a side that has left ("nobody advances" is false there: the forfeit names a
  // winner). The dialog says so and offers no route: the place stays vacant (X-WD-4: a vacant title is W4's).
  it("tidy-2: on a line that feeds no next match the no-choice sentence names the vacancy and offers no forfeit; on one that does (or unknown) it names the R-4 route", () => {
    const noChoice = (html: string) => /data-testid="settle-no-choice"[^>]*>([^<]*)</.exec(html)?.[1] ?? null;
    const gone = [{ id: "h", name: "Home", withdrawn: true }, { id: "a", name: "Away", withdrawn: true }] as const;
    const EN = en as Record<string, string>;
    const unescape = (h: string | null) => h?.replace(/&#x27;/g, "'").replace(/&quot;/g, '"') ?? null;
    const cases: [boolean | undefined, string][] = [
      [false, EN["score.needsDecision.noChoice.place"]!],
      [true, EN["score.needsDecision.noChoice"]!],
      [undefined, EN["score.needsDecision.noChoice"]!],
    ];
    let checked = 0;
    for (const [feeds, want] of cases) {
      expect(want, `${String(feeds)}: the key exists`).toBeTruthy();
      expect(unescape(noChoice(dialog(gone[0], gone[1], feeds))), `feedsNextMatch ${String(feeds)}`).toBe(want);
      checked++;
    }
    expect(checked).toBe(cases.length);
    // With a side left, the line has a choice wherever it sits: no sentence at all (the M-8 negative pair, on a final).
    expect(noChoice(dialog({ id: "h", name: "Home" }, gone[1], false)), "one side left on a final: a choice, no sentence").toBeNull();
    const DQ: (typeof FORFEIT_REASONS)[number] = "disqualified";
    const LOCALES: [string, Record<string, string>][] = [["en", en], ["es", es], ["fr", fr], ["nl", nl]];
    const lines = new Set<string>();
    let locales = 0;
    for (const [locale, dict] of LOCALES) {
      const line = dict["score.needsDecision.noChoice.place"];
      expect(line, `${locale}: translated`).toBeTruthy();
      expect(line!.includes(DQ), `${locale}: offers no forfeit route on a line that decides a place`).toBe(false);
      expect(line, `${locale}: a different sentence from the R-4 route`).not.toBe(dict["score.needsDecision.noChoice"]);
      lines.add(line!);
      locales++;
    }
    expect(locales).toBe(4);
    expect(lines.size, "four translations, not one sentence copied").toBe(4);
  });
});
