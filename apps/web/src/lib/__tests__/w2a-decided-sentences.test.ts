import { describe, expect, it } from "vitest";
import { foldMatchWithStoppage, outcomeOf, SETTLE_METHODS, settledMethod, type EventEnvelope } from "@seazn/engine/core";
import type { ModuleEvent } from "@seazn/engine/sport";
import { boardgame, TIEBREAK_RUNGS } from "@seazn/engine/sports/boardgame";
import { defaultLineupPair, makeEnvelope } from "@seazn/engine/testkit";
import { interpolate } from "@/lib/i18n-runtime";
import type { MsgFn } from "@/lib/scoring-vocab";
import {
  decidedOutcomeTemplates,
  decidedOutcomeText,
  renderDecidedOutcome,
  tiebreakScoreFromDetail,
} from "@/lib/scoring-vocab";
import uiEn from "@/dictionaries/en/ui.json";
import uiEs from "@/dictionaries/es/ui.json";
import uiFr from "@/dictionaries/fr/ui.json";
import uiNl from "@/dictionaries/nl/ui.json";

// W2a Task 13 (spec §5.5, D5). A bracket fixture decided by an organiser's settle or a chess tie-break carries a
// method the public sentence had no copy for, so it fell back to the plain "{winner} won" — true, and silent about
// HOW. The method list is the engine's own (SETTLE_METHODS through settledMethod, TIEBREAK_RUNGS), never typed here.

const DICTS = { en: uiEn, fr: uiFr, es: uiEs, nl: uiNl } as unknown as Record<string, Record<string, string>>;
const LOCALES = Object.keys(DICTS);
const sayIn = (loc: string): MsgFn => (k, vars) => interpolate(DICTS[loc]![k] ?? k, vars);
const names = { A: "Ana", B: "Ben" };
const METHODS: readonly string[] = [...SETTLE_METHODS.map(settledMethod), ...TIEBREAK_RUNGS.map((r) => `tiebreak_${r}`)];

describe("W2a public sentences (spec §5.5, D5): every method the engine declares has its own sentence, in every locale", () => {
  it("empty case first: no outcome renders nothing, and the method list read off the engine is not empty", () => {
    expect(renderDecidedOutcome(null, names, decidedOutcomeTemplates(sayIn("en")))).toBeNull();
    expect(renderDecidedOutcome(undefined, names, decidedOutcomeTemplates(sayIn("en")), null, "2–0")).toBeNull();
    expect(METHODS.length).toBe(SETTLE_METHODS.length + TIEBREAK_RUNGS.length);
    expect(METHODS.length).toBeGreaterThan(0);
  });

  it("each settle method and each tie-break rung renders a distinct, non-plain sentence naming the winner, in 4 locales", () => {
    let checked = 0;
    for (const loc of LOCALES) {
      const t = decidedOutcomeTemplates(sayIn(loc));
      const plain = renderDecidedOutcome({ kind: "win", winner: "A" }, names, t);
      const seen = new Set<string>();
      for (const method of METHODS) {
        const s = renderDecidedOutcome({ kind: "win", winner: "A", method }, names, t);
        expect(s, `${loc} ${method}`).toContain("Ana");
        expect(s, `${loc} ${method}`).not.toBe(plain); // the right answer differs from the fallback's constant
        expect(s, `${loc} ${method}`).not.toMatch(/settled_|tiebreak_|\{|fixture\.decidedBy/); // no raw token or key
        seen.add(s!);
        checked++;
      }
      expect(seen.size, loc).toBe(METHODS.length);
    }
    expect(checked).toBe(LOCALES.length * METHODS.length);
    expect(checked).toBe(4 * 6);
  });

  it("the tie-break score appears when recorded, and no score is invented when it is not", () => {
    const t = decidedOutcomeTemplates(sayIn("en"));
    const rapid = { kind: "win", winner: "A", method: "tiebreak_rapid" };
    expect(renderDecidedOutcome(rapid, names, t, null, "1½–½")).toBe("Ana won on rapid tie-break (1½–½)");
    expect(renderDecidedOutcome(rapid, names, t, null, null)).toBe("Ana won on rapid tie-break");
    expect(renderDecidedOutcome(rapid, names, t)).toBe("Ana won on rapid tie-break");
    expect(renderDecidedOutcome({ kind: "win", winner: "A", method: "tiebreak_blitz" }, names, t, null, "2–0")).toBe(
      "Ana won on blitz tie-break (2–0)",
    );
    expect(renderDecidedOutcome({ kind: "win", winner: "A", method: "settled_lot" }, names, t)).toBe("Ana advanced on lot");
    // A settle carries no score: a stray one is never printed on it.
    expect(renderDecidedOutcome({ kind: "win", winner: "A", method: "settled_lot" }, names, t, null, "2–0")).toBe("Ana advanced on lot");
    // Armageddon is one game, so it has no scored sentence; a score written to it through the API still reads cleanly.
    expect(renderDecidedOutcome({ kind: "win", winner: "A", method: "tiebreak_armageddon" }, names, t, null, "1–0")).toBe(
      "Ana won on Armageddon",
    );
  });

  it("decidedOutcomeText threads the tie-break score through the same templates", () => {
    const rapid = { kind: "win", winner: "A", method: "tiebreak_rapid" };
    expect(decidedOutcomeText(rapid, names, sayIn("en"), null, undefined, "1½–½")).toBe("Ana won on rapid tie-break (1½–½)");
    expect(decidedOutcomeText(rapid, names, sayIn("en"))).toBe("Ana won on rapid tie-break");
  });
});

describe("tiebreakScoreFromDetail — the score off the boardgame summary's own detail", () => {
  const lineups = defaultLineupPair(boardgame.positions);
  const cfg = boardgame.configSchema.parse({ tiebreak: true });
  const fold = (evs: readonly { type: string; payload: unknown }[]) => {
    const envs: EventEnvelope[] = evs.map((e, i) => makeEnvelope(i + 1, { type: e.type, payload: e.payload } as ModuleEvent));
    const f = foldMatchWithStoppage(boardgame, cfg, lineups, envs);
    return { outcome: outcomeOf(boardgame, f), summary: boardgame.summary(f.state) };
  };
  const DRAWN = [
    { type: "core.start", payload: {} },
    { type: "boardgame.result", payload: { winner: null, method: "agreement" } },
  ];

  it("empty and junk details read null — never an invented score", () => {
    for (const junk of [undefined, null, 7, "x", {}, { tiebreak: null }, { tiebreak: { score: 2 } }, { tiebreak: {} }]) {
      expect(tiebreakScoreFromDetail(junk), JSON.stringify(junk)).toBeNull();
    }
  });

  it("seam: a REAL fold — drawn, tie-break pending, then a scored rapid tie-break — reads into the sentence", () => {
    const pending = fold(DRAWN);
    expect(pending.outcome, "a drawn knockout game decides nobody yet").toBeNull();
    expect(tiebreakScoreFromDetail(pending.summary.detail)).toBeNull();

    const winner = lineups.away.entrantId;
    const decided = fold([...DRAWN, { type: "boardgame.tiebreak", payload: { rung: "rapid", winner, score: "1½–½" } }]);
    expect(decided.outcome).toMatchObject({ kind: "win", winner, method: "tiebreak_rapid" });
    const score = tiebreakScoreFromDetail(decided.summary.detail);
    expect(score).toBe("1½–½");
    const line = renderDecidedOutcome(
      decided.outcome,
      { [winner]: "Ben" },
      decidedOutcomeTemplates(sayIn("en")),
      null,
      score,
    );
    expect(line).toBe("Ben won on rapid tie-break (1½–½)");
    // The board stays level: the tie-break never rewrites the score.
    expect(decided.summary.headline).toBe(pending.summary.headline);
  });

  it("seam: a REAL settle by lot reads into its own sentence through outcomeOf", () => {
    const winner = lineups.home.entrantId;
    const settled = fold([
      ...DRAWN,
      { type: "core.settle", payload: { winner, method: "lot" } },
    ]);
    expect(settled.outcome).toMatchObject({ kind: "win", winner, method: settledMethod("lot") });
    expect(renderDecidedOutcome(settled.outcome, { [winner]: "Ana" }, decidedOutcomeTemplates(sayIn("en")))).toBe(
      "Ana advanced on lot",
    );
  });
});
