// W3 app-B Task 4 (SW-H1 on the desk; X-SW-3, rulebook-W3 §3.3): what the desk says when Pair next is refused
// SWISS_NO_LEGAL_PAIRING — the reason-specific sentence and the recovery it offers. `noPairingNotice` is pure: the wire
// details in (`{ round, reason, field, finishAfter, canFinish }`, the five fields `swissGen` sends), the dictionary keys,
// their parameters and the offered actions out. The expected sentences are the rulebook's (§3.3): the wording each reason
// names, and the recovery clause ("finish the Swiss after round {finishAfter}", "change the number of rounds").
//
// The reasons are the ENGINE's own union (`SwissRefusalReason`) read through an exhaustive Record: a sixth reason added to
// the engine reds `tsc` here until it is classified, and the count is asserted so the sweep cannot shrink to nothing.
// Anti-vacuity: every loop reports what it checked.
import { describe, expect, it } from "vitest";
import type { SwissRefusalReason } from "@seazn/engine/scheduling/swiss";
import en from "@/dictionaries/en/ui.json";
import es from "@/dictionaries/es/ui.json";
import fr from "@/dictionaries/fr/ui.json";
import nl from "@/dictionaries/nl/ui.json";
import type { MessageKey } from "@/lib/messages";
import { noPairingDetailsOf, noPairingFinishPlan, noPairingNotice, noPairingText, NO_PAIRING_ACTION_KEY, type NoPairingDetails } from "../swiss-no-pairing";
import { swissRefusalText } from "../swiss-refusal-text";

/** What each reason's sentence says, from rulebook §3.3 (the words a reader tells the reasons apart by). */
const REASON_WORDS: Record<SwissRefusalReason, string> = {
  rematch: "would repeat a match already played",
  colour: "would break the colour limits",
  no_bye_candidate: "every player has already had the bye",
  search_limit: "could not be paired in time",
  field_too_small: "needs at least two players",
};
const REASONS = Object.keys(REASON_WORDS) as SwissRefusalReason[];

const EN = en as unknown as Record<string, string>;
const fill = (s: string, vars?: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_m, k: string) => String(vars?.[k]));
/** `useMsg()`'s shape, over the English dictionary; a missing key is an error here, so "the key exists" is asserted too. */
const msgEn = (key: MessageKey, vars?: Record<string, string | number>): string => {
  const raw = EN[key];
  if (raw === undefined) throw new Error(`en/ui.json has no ${key}`);
  return fill(raw, vars);
};

const details = (over: Partial<NoPairingDetails> = {}): NoPairingDetails => ({
  round: 4,
  reason: "rematch",
  field: 6,
  finishAfter: 3,
  canFinish: true,
  ...over,
});

describe("X-SW-3 noPairingNotice: the refusal's sentence and its recovery", () => {
  it("X-SW-3 every refusal reason has its sentence and its recovery; round 1 offers no finish", () => {
    expect(REASONS, "the engine declares five reasons").toHaveLength(5);
    let checked = 0;
    // The empty case first: round 1 has nothing to finish (finishAfter 0), so rounds only and no sentence about Finish.
    for (const reason of REASONS) {
      const notice = noPairingNotice(details({ round: 1, reason, field: 2, finishAfter: 0, canFinish: false }));
      expect(notice.actions, `round 1, ${reason}: rounds only`).toEqual(["rounds"]);
      const text = noPairingText(notice, msgEn);
      expect(text, `round 1, ${reason}: names the round and the reason`).toContain("Round 1");
      expect(text, `round 1, ${reason}`).toContain(REASON_WORDS[reason]);
      expect(text, `round 1, ${reason}: no finish clause`).not.toMatch(/finish/i);
      expect(text, `round 1, ${reason}: still says the number of rounds can change`).toContain("change the number of rounds");
      checked++;
    }
    // Round 4 after three complete rounds: Finish after round 3 is the way out, beside Change rounds.
    for (const reason of REASONS) {
      const notice = noPairingNotice(details({ reason }));
      expect(notice.actions, `round 4, ${reason}: finish, then rounds`).toEqual(["finish", "rounds"]);
      const text = noPairingText(notice, msgEn);
      expect(text, `round 4, ${reason}`).toContain("Round 4");
      expect(text, `round 4, ${reason}`).toContain(REASON_WORDS[reason]);
      expect(text, `round 4, ${reason}: Finish after round 3`).toContain("finish the Swiss after round 3");
      expect(text, `round 4, ${reason}: and the number of rounds`).toContain("change the number of rounds");
      expect(notice.params, `round 4, ${reason}`).toMatchObject({ round: 4, finishAfter: 3 });
      checked++;
    }
    expect(checked, "five reasons at round 1 and at round 4").toBe(REASONS.length * 2);
  });

  it("X-SW-3 the five reasons read as five different sentences (a reason cannot collapse onto another's)", () => {
    const sentences = REASONS.map((reason) => noPairingText(noPairingNotice(details({ reason })), msgEn));
    expect(new Set(sentences).size, `distinct sentences: ${JSON.stringify(sentences)}`).toBe(REASONS.length);
    expect(new Set(REASONS.map((reason) => noPairingNotice(details({ reason })).key)).size, "five lead keys").toBe(REASONS.length);
  });

  it("X-SW-3 Finish needs both a finished round and canFinish: the server's answer decides, finishAfter alone never offers it", () => {
    let checked = 0;
    for (const reason of REASONS) {
      // canFinish false with rounds behind it (the Swiss is over, or a finished round was reopened): no Finish offered.
      const over = noPairingNotice(details({ reason, finishAfter: 3, canFinish: false }));
      expect(over.actions, `${reason}: canFinish false`).toEqual(["rounds"]);
      expect(noPairingText(over, msgEn), `${reason}: canFinish false says no finish`).not.toMatch(/finish/i);
      // canFinish true with nothing finished is a contradiction the server never sends; the desk still offers no button.
      const none = noPairingNotice(details({ reason, finishAfter: 0, canFinish: true }));
      expect(none.actions, `${reason}: finishAfter 0`).toEqual(["rounds"]);
      // The pair: the same reason with both true offers it.
      expect(noPairingNotice(details({ reason, finishAfter: 3, canFinish: true })).actions, `${reason}: both true`).toContain("finish");
      checked++;
    }
    expect(checked).toBe(REASONS.length);
  });

  it("X-SW-3 a round count that is locked offers no Change rounds, and the sentence stops promising it", () => {
    let checked = 0;
    for (const reason of REASONS) {
      const locked = noPairingNotice(details({ reason }), { roundsEditable: false });
      expect(locked.actions, `${reason}: started stage`).toEqual(["finish"]);
      const text = noPairingText(locked, msgEn);
      expect(text, `${reason}`).toContain("finish the Swiss after round 3");
      expect(text, `${reason}: no promise of changing the rounds`).not.toContain("change the number of rounds");
      // Locked and nothing to finish: no action at all, and the sentence is the reason alone.
      const bare = noPairingNotice(details({ reason, finishAfter: 0, canFinish: false }), { roundsEditable: false });
      expect(bare.actions, `${reason}: nothing offered`).toEqual([]);
      expect(bare.tail, `${reason}: no recovery sentence`).toBeNull();
      expect(noPairingText(bare, msgEn), `${reason}`).toContain(REASON_WORDS[reason]);
      checked++;
    }
    expect(checked).toBe(REASONS.length);
  });

  it("X-SW-3 the Finish label names the round it finishes after, and the keys exist in all four locales with the same placeholders", () => {
    const keys = new Set<MessageKey>([NO_PAIRING_ACTION_KEY.finish, NO_PAIRING_ACTION_KEY.rounds]);
    for (const reason of REASONS) {
      for (const finishAfter of [0, 3]) {
        for (const canFinish of [false, true]) {
          for (const roundsEditable of [false, true]) {
            const n = noPairingNotice(details({ reason, finishAfter, canFinish }), { roundsEditable });
            keys.add(n.key);
            if (n.tail !== null) keys.add(n.tail);
          }
        }
      }
    }
    expect(msgEn(NO_PAIRING_ACTION_KEY.finish, { n: 3 }), "the button").toBe("Finish after round 3");
    expect(msgEn(NO_PAIRING_ACTION_KEY.rounds), "the button").toBe("Change rounds");
    // 5 lead sentences + 3 tails + 2 labels.
    expect(keys.size, "keys the notice can use").toBe(10);
    const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    let checked = 0;
    for (const key of keys) {
      for (const [locale, dict] of Object.entries({ en, es, fr, nl }) as [string, Record<string, string>][]) {
        const value = dict[key];
        expect(typeof value, `${locale} has ${key}`).toBe("string");
        expect(value!.length, `${locale} ${key} is not empty`).toBeGreaterThan(0);
        expect(placeholders(value!), `${locale} ${key} keeps the placeholders`).toEqual(placeholders(EN[key]!));
        checked++;
      }
    }
    expect(checked, "10 keys x 4 locales").toBe(40);
  });
});

describe("X-SW-3 noPairingDetailsOf: the wire body is read, never trusted", () => {
  const wire = { round: 4, reason: "rematch", field: 6, finishAfter: 3, canFinish: true };
  it("X-SW-3 the five fields parse; any one missing or mistyped parses to null (the desk then shows the generic sentence)", () => {
    expect(noPairingDetailsOf(wire)).toEqual(wire);
    let checked = 0;
    for (const key of Object.keys(wire)) {
      const without = Object.fromEntries(Object.entries(wire).filter(([k]) => k !== key));
      expect(noPairingDetailsOf(without), `${key} missing`).toBeNull();
      checked++;
    }
    for (const bad of [
      { ...wire, reason: "bogus" },
      { ...wire, round: 0 },
      { ...wire, round: "4" },
      { ...wire, field: -1 },
      { ...wire, finishAfter: 1.5 },
      { ...wire, canFinish: "true" },
    ]) {
      expect(noPairingDetailsOf(bad), JSON.stringify(bad)).toBeNull();
      checked++;
    }
    expect(noPairingDetailsOf(undefined)).toBeNull();
    expect(noPairingDetailsOf(null)).toBeNull();
    expect(noPairingDetailsOf("rematch")).toBeNull();
    expect(checked, "five missing + six mistyped").toBe(11);
  });

  it("X-SW-3 every reason the engine declares parses", () => {
    let checked = 0;
    for (const reason of REASONS) {
      expect(noPairingDetailsOf({ ...wire, reason })?.reason, reason).toBe(reason);
      checked++;
    }
    expect(checked).toBe(5);
  });
});

describe("X-SW-26 noPairingFinishPlan: the plan Finish confirms, or none", () => {
  it("X-SW-26 the plan is finish-after-k of the stored N; no plan when the server, the round or the count does not support it", () => {
    let checked = 0;
    expect(noPairingFinishPlan(details(), 5), "round 4 of 5, three rounds behind it").toEqual({ after: 3, rounds: 5 });
    checked++;
    expect(noPairingFinishPlan(details({ finishAfter: 3 }), 3), "every round played: after equals N").toEqual({ after: 3, rounds: 3 });
    checked++;
    // Each way Finish is not on offer — one condition off at a time, so each guard is the only thing that says no.
    for (const [label, d, rounds] of [
      ["the server says it cannot (the Swiss is over)", details({ canFinish: false }), 5],
      ["nothing finished yet", details({ finishAfter: 0, canFinish: true }), 5],
      ["no round count read", details(), undefined],
      ["a count below the round it would end at", details({ finishAfter: 3 }), 2],
      ["a count that is not an integer", details(), 4.5],
      ["a count sent as a string", details(), "5"],
    ] as [string, NoPairingDetails, unknown][]) {
      expect(noPairingFinishPlan(d, rounds), label).toBeNull();
      checked++;
    }
    expect(checked, "two plans + six refusals").toBe(8);
  });
});

describe("X-SW-3 swissRefusalText says the reason on every door that says a Swiss refusal", () => {
  const plural = () => {
    throw new Error("no plural expected");
  };
  it("X-SW-3 SWISS_NO_LEGAL_PAIRING with its details is the reason's sentence; without them, the generic one", () => {
    let checked = 0;
    for (const reason of REASONS) {
      const said = swissRefusalText("SWISS_NO_LEGAL_PAIRING", { ...details({ reason }) }, msgEn, plural);
      expect(said, reason).toContain(REASON_WORDS[reason]);
      expect(said, reason).not.toBe(EN["swiss.refusal.SWISS_NO_LEGAL_PAIRING"]);
      checked++;
    }
    expect(swissRefusalText("SWISS_NO_LEGAL_PAIRING", undefined, msgEn, plural), "no details").toBe(EN["swiss.refusal.SWISS_NO_LEGAL_PAIRING"]);
    expect(swissRefusalText("SWISS_NO_LEGAL_PAIRING", { reason: "bogus" }, msgEn, plural), "unreadable details").toBe(
      EN["swiss.refusal.SWISS_NO_LEGAL_PAIRING"],
    );
    expect(checked).toBe(5);
  });
});
