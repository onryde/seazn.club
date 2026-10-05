// Capture QR v2 §6.3.3 — domain/beat-answer.ts: the beat answer, first row that applies wins, and its wire shape.
// The seam: beatAnswer's core, put on the wire by wireBeatAnswer, parses with the REAL CaptureBeatAnswer union (R5,
// final, vendored by capture at 09e87aabd) for every state. Over's endReason comes through wireEndReason (T4b).
import { describe, expect, it } from "vitest";
import { CaptureBeatAnswer, CaptureStartedBy } from "@/server/api-v1/capture-schemas";
import { StreamFailReason } from "@/server/api-v1/schemas";
import { POLL_FAR_SECONDS, POLL_NEAR_SECONDS, POLL_STARTING_SECONDS } from "../../config";
import { type BeatAnswerCommon, type BeatAnswerCore, type BeatAnswerInput, beatAnswer, wireBeatAnswer } from "../beat-answer";
import { DB_END_REASONS, wireEndReason } from "../end-reason";
import type { ClaimOutcome } from "../pairing";
import type { FailReason } from "../session";
import type { SlotState } from "../slot";

const S = "11111111-1111-4111-8111-111111111111";
const X = "22222222-2222-4222-8222-222222222222";
const OPEN = { sid: S, startedBy: "organiser" as const };
const ENDED_X = { sid: X, endReason: "stopped" as const };
const SLOTS: readonly SlotState[] = ["empty", "paired", "starting", "armed", "live", "live_dead"];
const base: BeatAnswerInput = { claim: null, callerCurrent: true, namedEnded: null, slot: "paired", open: null };
const COMMON: BeatAnswerCommon = {
  label: "Home v Away", scheduledStart: 1_790_000_000, autoAllowed: false, destinationName: null, overlayUrl: null,
  pollSeconds: POLL_NEAR_SECONDS,
};
const taken: ClaimOutcome = { result: "taken", row: "T3" };
const refusedResume: ClaimOutcome = { result: "replaced", row: "T6" };
const accepted: ClaimOutcome = { result: "accept", row: "T1" };

describe("beatAnswer — §6.3.3, in precedence order", () => {
  it("row 1: a refused `new` claim (T3) → taken", () => {
    expect(beatAnswer({ ...base, claim: taken, callerCurrent: false, slot: "live", open: OPEN })).toEqual({ state: "taken" });
  });

  it("row 2: the caller is not current — a refused resume (T6), or no claim (T7) → replaced", () => {
    expect(beatAnswer({ ...base, claim: refusedResume, callerCurrent: false, slot: "live", open: OPEN })).toEqual({ state: "replaced" });
    expect(beatAnswer({ ...base, claim: null, callerCurrent: false, slot: "live", open: OPEN })).toEqual({ state: "replaced" });
  });

  it("row 3: the beat names an ended sid X → over X with its endReason, whatever has opened since", () => {
    expect(beatAnswer({ ...base, namedEnded: ENDED_X, slot: "armed", open: OPEN })).toEqual({ state: "over", sid: X, endReason: "stopped" });
  });

  it("row 4: slot empty or paired → waiting (not starting)", () => {
    expect(beatAnswer({ ...base, slot: "empty" })).toEqual({ state: "waiting", starting: false });
    expect(beatAnswer({ ...base, slot: "paired" })).toEqual({ state: "waiting", starting: false });
  });

  it("row 5: slot starting → waiting with starting: true", () => {
    expect(beatAnswer({ ...base, slot: "starting", open: OPEN })).toEqual({ state: "waiting", starting: true });
  });

  it("row 6: slot armed → go-live S with startedBy, for each startedBy", () => {
    for (const startedBy of CaptureStartedBy.options) {
      expect(beatAnswer({ ...base, slot: "armed", open: { sid: S, startedBy } }), startedBy).toEqual({ state: "go-live", sid: S, startedBy });
    }
  });

  it("row 7: slot live or live·dead → live S, with no startedBy", () => {
    expect(beatAnswer({ ...base, slot: "live", open: OPEN })).toEqual({ state: "live", sid: S });
    expect(beatAnswer({ ...base, slot: "live_dead", open: OPEN })).toEqual({ state: "live", sid: S });
  });
});

describe("G0-g — who holds the slot is answered first", () => {
  it("a refused `new` carrying an ended `stopped` → taken, never over X", () => {
    expect(beatAnswer({ ...base, claim: taken, callerCurrent: false, namedEnded: ENDED_X, slot: "live", open: OPEN })).toEqual({ state: "taken" });
  });

  it("a refused `resume` → replaced, even naming an ended X", () => {
    expect(beatAnswer({ ...base, claim: refusedResume, callerCurrent: false, namedEnded: ENDED_X, slot: "paired" })).toEqual({ state: "replaced" });
  });

  it("no claim and not current → replaced", () => {
    expect(beatAnswer({ ...base, callerCurrent: false, slot: "armed", open: OPEN })).toEqual({ state: "replaced" });
  });

  it("current, naming an ended X → over X (T21: the operator's own `ended` beat is judged current)", () => {
    expect(beatAnswer({ ...base, claim: accepted, namedEnded: ENDED_X, slot: "live", open: OPEN })).toEqual({ state: "over", sid: X, endReason: "stopped" });
  });

  it("ordering differential: NOT current and naming an ended X is replaced — rows 2 and 3 swapped would say over X", () => {
    const a = beatAnswer({ ...base, callerCurrent: false, namedEnded: ENDED_X, slot: "paired" });
    expect(a).toEqual({ state: "replaced" });
    expect(a).not.toEqual({ state: "over", sid: X, endReason: "stopped" });
  });
});

describe("beatAnswer refuses an input that contradicts itself", () => {
  it("a claim outcome and callerCurrent must agree: accept/takeover/none ⇒ current, taken/replaced ⇒ not current", () => {
    expect(() => beatAnswer({ ...base, claim: accepted, callerCurrent: false })).toThrow(/callerCurrent/);
    expect(() => beatAnswer({ ...base, claim: { result: "takeover", row: "T2" }, callerCurrent: false })).toThrow(/callerCurrent/);
    expect(() => beatAnswer({ ...base, claim: taken, callerCurrent: true })).toThrow(/callerCurrent/);
    expect(() => beatAnswer({ ...base, claim: refusedResume, callerCurrent: true })).toThrow(/callerCurrent/);
  });

  it("a slot state with no §6.3.3 row (a future SlotState) is refused by name, never answered by a fallthrough", () => {
    expect(() => beatAnswer({ ...base, slot: "ghost" as SlotState })).toThrow(/no §6.3.3 row/);
  });

  it("an armed or live slot with no open session has no sid to answer with", () => {
    for (const slot of ["armed", "live", "live_dead"] as const) expect(() => beatAnswer({ ...base, slot, open: null }), slot).toThrow(/open/);
  });
});

describe("the wire (R5): wireBeatAnswer(beatAnswer(…)) parses with the real CaptureBeatAnswer, for every state", () => {
  const BRANCH_KEYS = new Map(CaptureBeatAnswer.options.map((o) => [o.shape.state.value, Object.keys(o.shape).sort()]));
  const COMMON_KEYS = Object.keys(COMMON).sort();

  // I-1 (B3 review). The sweep used to drop every throw into an unbounded `refused` bucket, so a guard that refused a
  // VALID input (a 500 on the beat right after a takeover) stayed green. Now each input's fate is decided first, from
  // the two declared refusals, and the code must agree input by input: refused iff a rule says so, by that rule's name.
  //   - §5.5's claim outcomes say who is current AFTER the claim: accept / takeover / none leave the caller current,
  //     taken / replaced do not. A caller that contradicts its own claim is refused (/contradicts callerCurrent/).
  //   - §5.4: armed, live and live_dead are derived FROM an open session, so §6.3.3 rows 6–7 answer with its sid; with
  //     no open session they are refused (/needs the open session/). Rows 1–3 answer before the slot is read
  //     (G0-g: who holds the slot first), so they never reach this refusal.
  // Typed from the spec, never imported from beat-answer.ts.
  const CURRENT_AFTER_RULE: Record<ClaimOutcome["result"], boolean> = { accept: true, takeover: true, none: true, taken: false, replaced: false };
  const OPEN_SLOTS: readonly SlotState[] = ["armed", "live", "live_dead"];
  /** §5.5's declared (row, result) pairs, and no claim at all. */
  const CLAIMS: readonly (ClaimOutcome | null)[] = [
    null,
    { result: "accept", row: "T1" }, { result: "takeover", row: "T2" }, { result: "taken", row: "T3" }, { result: "takeover", row: "T4" },
    { result: "accept", row: "T5" }, { result: "replaced", row: "T6" }, { result: "replaced", row: "T7" }, { result: "none", row: "T8" },
  ];
  const OPENS = [null, ...CaptureStartedBy.options.map((startedBy) => ({ sid: S, startedBy }))];
  const refusalOf = (i: BeatAnswerInput): RegExp | null => {
    if (i.claim !== null && CURRENT_AFTER_RULE[i.claim.result] !== i.callerCurrent) return /contradicts callerCurrent/;
    const answeredBeforeTheSlot = i.claim?.result === "taken" || !i.callerCurrent || i.namedEnded !== null;
    if (!answeredBeforeTheSlot && OPEN_SLOTS.includes(i.slot) && i.open === null) return /needs the open session/;
    return null;
  };

  it("every input is answered or refused exactly as the declared rules say — refused by NAME, and every answer is a valid wire answer; all six states are reached", () => {
    const reached = new Map<string, number>();
    const tally = { parsed: 0, contradiction: 0, open: 0 };
    const expected = { parsed: 0, contradiction: 0, open: 0 };
    let takeoversAnswered = 0;
    for (const claim of CLAIMS) {
      for (const callerCurrent of [true, false]) {
        for (const namedEnded of [null, ENDED_X]) {
          for (const slot of SLOTS) {
            for (const open of OPENS) {
              const input: BeatAnswerInput = { claim, callerCurrent, namedEnded, slot, open };
              const label = JSON.stringify(input);
              const rule = refusalOf(input);
              expected[rule === null ? "parsed" : rule.source.startsWith("contradicts") ? "contradiction" : "open"]++;
              if (rule !== null) {
                expect(() => beatAnswer(input), label).toThrow(rule);
                tally[rule.source.startsWith("contradicts") ? "contradiction" : "open"]++;
                continue;
              }
              let core: BeatAnswerCore;
              try { core = beatAnswer(input); } catch (e) { throw new Error(`refused an input no rule refuses: ${label} — ${String(e)}`); }
              const wire = wireBeatAnswer(core, COMMON);
              const r = CaptureBeatAnswer.safeParse(wire);
              expect(r.success, `${JSON.stringify(core)} → ${JSON.stringify(r.error?.issues)}`).toBe(true);
              // Exactly the branch's keys: sid / startedBy / endReason appear where the matrix says and nowhere else,
              // and the common fields ride on EVERY 2xx, replaced and taken included (ask 1). `device` is PR-2's.
              expect(Object.keys(wire).sort(), wire.state).toEqual(BRANCH_KEYS.get(wire.state)!.filter((k) => k !== "device"));
              for (const k of COMMON_KEYS) expect(wire, `${wire.state} carries ${k}`).toHaveProperty(k);
              // go-live carries the open session's own startedBy, for every CaptureStartedBy option.
              if (wire.state === "go-live") expect(wire.startedBy, label).toBe(open!.startedBy);
              if (claim?.result === "takeover") takeoversAnswered++;
              reached.set(wire.state, (reached.get(wire.state) ?? 0) + 1);
              tally.parsed++;
            }
          }
        }
      }
    }
    const total = CLAIMS.length * 2 * 2 * SLOTS.length * OPENS.length;
    expect(tally).toEqual(expected);
    expect(tally.parsed + tally.contradiction + tally.open).toBe(total);
    // Anti-vacuity: each fate is non-empty, and the takeover claims are among the answered.
    expect(expected.parsed).toBeGreaterThan(0);
    expect(expected.contradiction).toBeGreaterThan(0);
    expect(expected.open).toBeGreaterThan(0);
    expect(takeoversAnswered).toBeGreaterThan(0);
    expect([...reached.keys()].sort()).toEqual([...BRANCH_KEYS.keys()].sort());
  });

  it("the beat right after a takeover is answered (§5.5 T2, T4): armed → go-live S with its startedBy; live_dead → live S", () => {
    let checked = 0;
    for (const open of OPENS.filter((o) => o !== null)) {
      const t2 = wireBeatAnswer(beatAnswer({ ...base, claim: { result: "takeover", row: "T2" }, callerCurrent: true, slot: "armed", open }), COMMON);
      expect(t2).toEqual({ state: "go-live", sid: S, startedBy: open.startedBy, ...COMMON });
      expect(CaptureBeatAnswer.safeParse(t2).success).toBe(true);
      const t4 = wireBeatAnswer(beatAnswer({ ...base, claim: { result: "takeover", row: "T4" }, callerCurrent: true, slot: "live_dead", open }), COMMON);
      expect(t4).toEqual({ state: "live", sid: S, ...COMMON });
      expect(CaptureBeatAnswer.safeParse(t4).success).toBe(true);
      checked++;
    }
    expect(checked).toBe(CaptureStartedBy.options.length);
  });

  it("live never carries startedBy; go-live always does; over always carries endReason", () => {
    const live = wireBeatAnswer(beatAnswer({ ...base, slot: "live", open: OPEN }), COMMON);
    expect(live).not.toHaveProperty("startedBy");
    expect(wireBeatAnswer(beatAnswer({ ...base, slot: "armed", open: OPEN }), COMMON)).toHaveProperty("startedBy", "organiser");
    expect(wireBeatAnswer(beatAnswer({ ...base, namedEnded: ENDED_X }), COMMON)).toHaveProperty("endReason", "stopped");
  });

  it("over X parses for EVERY wire end reason a terminal row can map to — DB end reasons, fail reasons, and R11's null row", () => {
    const rows = [
      ...DB_END_REASONS.map((endReason) => ({ endReason, failReason: null })),
      ...(StreamFailReason.options as readonly FailReason[]).map((failReason) => ({ endReason: null, failReason })),
      { endReason: null, failReason: null },
    ];
    let checked = 0;
    for (const row of rows) {
      const wire = wireBeatAnswer(beatAnswer({ ...base, namedEnded: { sid: X, endReason: wireEndReason(row) } }), COMMON);
      expect(CaptureBeatAnswer.safeParse(wire).success, JSON.stringify(row)).toBe(true);
      checked++;
    }
    expect(checked).toBe(DB_END_REASONS.length + StreamFailReason.options.length + 1);
  });

  it("row 5's cadence: a starting answer carries POLL_STARTING_SECONDS whatever the caller computed; others carry the caller's", () => {
    expect(wireBeatAnswer({ state: "waiting", starting: true }, { ...COMMON, pollSeconds: POLL_FAR_SECONDS }).pollSeconds).toBe(POLL_STARTING_SECONDS);
    expect(wireBeatAnswer({ state: "waiting", starting: false }, { ...COMMON, pollSeconds: POLL_FAR_SECONDS }).pollSeconds).toBe(POLL_FAR_SECONDS);
    expect(wireBeatAnswer({ state: "live", sid: S }, COMMON).pollSeconds).toBe(POLL_NEAR_SECONDS);
  });

  it("a caller object with extra keys never leaks onto the strict wire", () => {
    const wide = { ...COMMON, venueTimezone: "Europe/London", code: "abcdefghjkmn" } as BeatAnswerCommon;
    expect(CaptureBeatAnswer.safeParse(wireBeatAnswer({ state: "replaced" }, wide)).success).toBe(true);
  });
});
