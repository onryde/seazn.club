// R8 / register item #675 — AMENDING a row the hold window cut short.
//
// THE DEFECT R7 LEFT. The pad soft-commits: a tap enqueues immediately and the
// detail dock has `HOLD_MS` to enrich the payload before it drains. If nobody
// answers, the event submits with what it had. R7-42/F made that VISIBLE
// (`isPartialDockAnswer` + the amber "Partial" badge, activity.tsx) but the
// badge was a LABEL ONLY — the row's sole action was Void, so the attribution
// was gone with no way back.
//
// THE OWNER'S RULING (R8/#675). Tapping the badge reopens that event's own
// detail dock; the detail is APPENDED, never written back into the original
// event, so the ledger stays append-only and auditable.
//
// WHAT AN AMENDMENT ACTUALLY IS, AND WHY IT IS NOT A NEW EVENT TYPE. The
// engine has no "amend" event and this task is barred from inventing one.
// It does not need one: `core/events.ts` §4.1 already names the correction
// model in its own words — "Void back to the mistake, then re-append." So an
// amendment is a `core.void` of the original plus a re-append of the SAME
// event type carrying the completed payload. Two event types that already
// exist, no `z.strictObject` weakened, no engine change.
//
// THAT MODEL HAS A HARD LIMIT AND THIS FILE PINS IT. `resolveVoids` drops the
// original and the re-append lands at the TAIL, so the correction is only
// order-preserving when nothing the fold still applies sits after the target.
// Amend an older row and the replacement would be replayed out of sequence —
// in badminton that silently rewrites who served every rally since. Hence
// `canAmendRow`'s newest-folding-event condition, asserted below against the
// REAL fold rather than argued for in a comment.
//
// EVERY STATE HERE COMES OUT OF THE REAL FOLD, and every amended payload comes
// out of the REAL skin — `foldClient(badminton, ...)` over real envelopes and
// `buildDock(...)`'s own chip. A fixture on both ends would only prove the
// fixture (AGENTS.md, failure class 1).
import { describe, expect, it } from "vitest";
import type { EventEnvelope, Lineup, LineupPair } from "@seazn/engine/core";
import { initSquads } from "@seazn/engine/core";
import type { ModuleEvent } from "@seazn/engine/sport";
import { makeEnvelope } from "@seazn/engine/testkit";
import { badminton } from "@seazn/engine/sports/setbased";
import { foldClient } from "../../module-client";
import type { PadHostView } from "../types";
import { amendPlan, isPartialDockAnswer, runAmend } from "../pad-host";
import { enqueue, enqueueHeld, dropHeld, releaseHeld } from "../../queue";
import { memoryQueueStore, type QueueStore } from "../../queue-store";
import type { PendingEvent } from "../../types";
import { canAmendRow, isNewestFoldingEvent, partialBadge, type ActivityEvent } from "../activity";
import { RALLY_ENTITLEMENT, RALLY_TYPE, badmintonSkinV3, buildDock } from "../skins/badminton";
import type { TFn } from "../skins/badminton";

// ---------------------------------------------------------------------------
// Fixtures — badminton DOUBLES, the sport/format the P-5 ruling was written
// about ("a doubles rally opens the dock; if nobody answers within HOLD_MS
// the hold drains and the rally submits with `wonBy` only").
// ---------------------------------------------------------------------------

/** Echoes its input, vars included, so an assertion cannot pass by accident
 *  when a branch resolves the WRONG key (ribbon.test.ts's own lesson). */
const t: TFn = (key, vars) => (vars ? `${key}(${JSON.stringify(vars)})` : key);

const NAMES: Record<string, string> = {
  "H-first": "Home First",
  "H-second": "Home Second",
  "A-first": "Away First",
  "A-second": "Away Second",
};

/** `orderNo` runs the OTHER WAY from `pairOrder` on purpose — the trap
 *  `setbased/lineup.test.ts`'s own `pairSide` sets, so a reader that quietly
 *  sorts by `orderNo` names the wrong player and this file notices. */
function pairSide(entrantId: string, first: string, second: string): Lineup {
  return {
    entrantId,
    slots: [
      { personId: second, slot: "starting", orderNo: 1, pairOrder: 2 },
      { personId: first, slot: "starting", orderNo: 2, pairOrder: 1 },
    ],
  };
}

const DOUBLES: LineupPair = {
  home: pairSide("H", "H-first", "H-second"),
  away: pairSide("A", "A-first", "A-second"),
};
const CFG = badminton.configSchema.parse({});

const ev = (seq: number, type: string, payload: unknown, voids?: string): EventEnvelope =>
  makeEnvelope(seq, { type, payload } as ModuleEvent, voids);

/** `core.start` first: `applyRally` refuses anything while the phase is "pre". */
function stream(...rest: readonly EventEnvelope[]): EventEnvelope[] {
  return [ev(0, "core.start", {}), ...rest];
}

function view(events: readonly EventEnvelope[]): PadHostView {
  return {
    cfg: CFG,
    state: foldClient(badminton, CFG, DOUBLES, events),
    summary: {},
    phase: "live",
    band: 3,
    entitlements: { [RALLY_ENTITLEMENT]: true },
    personNames: NAMES,
    squads: initSquads(DOUBLES),
    events,
    contextOverrides: {},
  };
}

const skin = badmintonSkinV3(t);

/** The ledger shape `ActivityPanel` reads, derived from the SAME envelopes the
 *  fold sees — never hand-typed beside them, or the two could disagree. */
const rows = (events: readonly EventEnvelope[]): ActivityEvent[] =>
  events.map((e) => ({ id: e.id, seq: e.seq, type: e.type, payload: e.payload, voids: e.voids ?? null }));

const OWN = new Set<string>();
const setBasedState = (v: PadHostView) => v.state as { persons?: Record<string, { points: number; serves: number }>; sets: { home: number; away: number }[] };

// The ledger the defect produces: one doubles rally, `wonBy` and nothing else.
const SETTLED_PAYLOAD = { wonBy: "H" };
const SETTLED = stream(ev(1, RALLY_TYPE, SETTLED_PAYLOAD));

/**
 * THE SCORER'S OWN CHIP, from the REAL producer. `buildDock` is the same
 * function `SkinDefV3.dock` is, so `chip.mutate` below is literally what a tap
 * on the reopened dock applies — never a `{scorer: "…"}` literal typed into
 * this file, which would prove only that this file can type a literal.
 */
function scorerChip(ledger: readonly EventEnvelope[], payload: Record<string, unknown>) {
  const spec = buildDock(RALLY_TYPE, view(ledger), t, payload);
  if (spec === null) throw new Error("the settled rally must still offer a dock — the whole defect is that it does");
  const chip = spec.chips.find((c) => c.id === "scorer:H-first");
  if (chip === undefined) {
    throw new Error(`no scorer chip for H-first; the dock offered ${spec.chips.map((c) => c.id).join(", ")}`);
  }
  return chip;
}

/**
 * The ledger AFTER the amendment — the whole seam, end to end, with no literal
 * standing in for any hop: `amendPlan` names the void target and the payload to
 * re-append, the skin's own dock chip completes that payload, and the result is
 * folded by the real engine below. `handleAmend` (pad-host.tsx) submits exactly
 * these two events in exactly this order.
 *
 * Because the void target and the re-appended payload BOTH come out of
 * `amendPlan`, a plan that named the wrong target or dropped the payload
 * arrives at the fold as a wrong match rather than as a comparison against a
 * literal that agrees with itself.
 */
function amendedLedger(base: readonly EventEnvelope[], eventId: string): EventEnvelope[] {
  const plan = amendPlan(eventId, base);
  if (plan === null) throw new Error(`amendPlan refused ${eventId}, which this ledger does carry`);
  return [
    ...base,
    ev(base.length, "core.void", { event_id: plan.voidId }, plan.voidId),
    ev(base.length + 1, plan.type, scorerChip(base, plan.payload).mutate(plan.payload)),
  ];
}

/** LAZY, memoized — deliberately not a module-level constant. Built at import
 *  time, a fixture that throws (because the code under test stopped producing a
 *  usable plan) takes the whole FILE down: vitest then reports
 *  `numTotalTests: 0`, which reads as "every mutant survived" rather than as a
 *  kill. Behind a call, the same breakage arrives as failing assertions with a
 *  total that never moves. */
let amendedMemo: EventEnvelope[] | null = null;
const AMENDED = (): EventEnvelope[] => (amendedMemo ??= amendedLedger(SETTLED, "e-1"));

// ---------------------------------------------------------------------------
// The defect this task closes
// ---------------------------------------------------------------------------

describe("the row the hold window cut short", () => {
  it("is marked partial — the state R7 could label but not repair", () => {
    expect(isPartialDockAnswer(skin, RALLY_TYPE, SETTLED_PAYLOAD, view(SETTLED))).toBe(true);
  });

  it("credits NOBODY in the folded state: the attribution really is lost, not merely unlabelled", () => {
    expect(setBasedState(view(SETTLED)).persons?.["H-first"]).toBeUndefined();
  });

  it("offers the amend affordance on the badge", () => {
    const all = rows(SETTLED);
    const target = all[1]!;
    expect(canAmendRow(target, all, OWN, null, null, true, true)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The amendment — driven through the real skin AND the real fold
// ---------------------------------------------------------------------------

describe("amending it", () => {
  it("puts the attribution into the DERIVED state, which is where a stat is actually read from", () => {
    expect(setBasedState(view(AMENDED())).persons?.["H-first"]).toEqual({ points: 1, serves: 0 });
  });

  it("does NOT double-count the rally: the score is exactly what it was before the amendment", () => {
    expect(setBasedState(view(AMENDED())).sets).toEqual(setBasedState(view(SETTLED)).sets);
  });

  it("clears the badge, because isPartialDockAnswer re-runs against the amended payload", () => {
    const amended = AMENDED()[3]!;
    expect(isPartialDockAnswer(skin, amended.type, amended.payload as Record<string, unknown>, view(AMENDED()))).toBe(
      false,
    );
  });

  it("never rewrites the original event — it stays in the ledger, voided, byte-identical", () => {
    expect(AMENDED()[1]).toEqual(SETTLED[1]);
    expect(AMENDED()[1]!.payload).toEqual({ wonBy: "H" });
  });

  it("stops offering amend on the superseded row: a voided row is not an incomplete record", () => {
    const all = rows(AMENDED());
    const original = all[1]!;
    // `partial` is passed false by the panel for a voided row (see the badge's
    // own `!voided &&` guard) — but even handed `true`, the row must refuse.
    expect(canAmendRow(original, all, OWN, null, null, true, true)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The engine's own limit on this correction model (`core/events.ts` §4.1)
// ---------------------------------------------------------------------------

describe("only the newest folding event may be amended", () => {
  // Two rallies; the FIRST is the partial one. Voiding it and re-appending at
  // the tail would replay it after the second — a different match.
  const LATER = stream(ev(1, RALLY_TYPE, SETTLED_PAYLOAD), ev(2, RALLY_TYPE, { wonBy: "A" }));

  it("refuses a partial row that something the fold still applies sits after", () => {
    const all = rows(LATER);
    expect(isPartialDockAnswer(skin, RALLY_TYPE, SETTLED_PAYLOAD, view(LATER))).toBe(true);
    expect(canAmendRow(all[1]!, all, OWN, null, null, true, true)).toBe(false);
  });

  it("PROVES why: re-appending a non-tail correction folds a different match", () => {
    // Exactly what `canAmendRow` refuses to let a scorer do, built anyway.
    const outOfOrder = amendedLedger(LATER, "e-1");
    // Same points, but the server is the last rally's winner — and the last
    // rally is no longer the same side. The fold silently disagrees with the
    // match that was played.
    expect(setBasedState(view(outOfOrder)).sets).toEqual(setBasedState(view(LATER)).sets);
    expect(view(outOfOrder).state).not.toEqual(view(LATER).state);
  });

  it("still refuses once the later row is itself voided ONLY if it still folds", () => {
    // Void the later rally: the partial row becomes the newest folding event
    // again, and the amend re-opens.
    const all = rows([...LATER, ev(3, "core.void", {}, "e-2")]);
    expect(canAmendRow(all[1]!, all, OWN, null, null, true, true)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isNewestFoldingEvent — the rule on its own
// ---------------------------------------------------------------------------

describe("isNewestFoldingEvent", () => {
  const all = rows([...SETTLED, ev(2, "core.void", {}, "e-1")]);

  it("skips the core.void rows themselves — a void is not a folding event", () => {
    expect(isNewestFoldingEvent(all[2]!, all)).toBe(false);
  });

  it("skips a voided row and answers with the newest SURVIVING one", () => {
    expect(isNewestFoldingEvent(all[1]!, all)).toBe(false);
    expect(isNewestFoldingEvent(all[0]!, all)).toBe(true);
  });

  it("is false for an empty ledger's phantom row", () => {
    expect(isNewestFoldingEvent(all[0]!, [])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// canAmendRow — every gate, one at a time (two guards covering for each
// other are each untested; AGENTS.md failure class 3)
// ---------------------------------------------------------------------------

describe("canAmendRow gates", () => {
  const all = rows(SETTLED);
  const target = all[1]!;

  it("is false when the host wired no amend handler", () => {
    expect(canAmendRow(target, all, OWN, null, null, false, true)).toBe(false);
  });

  it("is false when the row is not partial — a complete row has nothing to amend", () => {
    expect(canAmendRow(target, all, OWN, null, null, true, false)).toBe(false);
  });

  it("is false for the row whose HOLD window is still open — its dock is already on screen", () => {
    // Not hypothetical: `submitHeld` writes its entry into `pendingEnvelopes`
    // at once (use-pad-pipeline.ts), so a just-tapped event is ALREADY a row
    // here — unvoided, owned, newest, and partial until a chip is tapped, which
    // is every other condition this function checks. Without the `heldEventId`
    // term the badge offered "amend" beside the very dock that is open for it,
    // and taking it would have voided a client-fabricated id the server has
    // never seen. Found by reading how `pipeline.events` is composed, not by a
    // failing test — hence this one.
    expect(canAmendRow(target, all, OWN, null, target.id, true, true)).toBe(false);
    expect(canAmendRow(target, all, OWN, null, "some-other-hold", true, true)).toBe(true);
  });

  it("is false on a device link that did not record the row: amend voids, and a device link may only void its own", () => {
    expect(canAmendRow(target, all, OWN, "device-1", null, true, true)).toBe(false);
    expect(canAmendRow(target, all, new Set([target.id]), "device-1", null, true, true)).toBe(true);
  });

  it("is false for a core.* type the void allowlist excludes — the amend voids the original", () => {
    // A ledger of core.start ALONE, so core.start IS the newest folding event
    // and the allowlist is the only thing left that can refuse. Judged against
    // the two-row ledger instead, `isNewestFoldingEvent` refuses first and this
    // assertion passes with the allowlist term deleted — two guards covering
    // for each other, and the mutation sweep for this task caught exactly that.
    const only = rows(stream());
    expect(isNewestFoldingEvent(only[0]!, only)).toBe(true);
    expect(canAmendRow(only[0]!, only, OWN, null, null, true, true)).toBe(false);
  });

  it("a voided row is never the newest folding event — the implication `canAmendRow` leans on instead of restating", () => {
    const amended = rows(AMENDED());
    for (const row of amended) {
      const voided = amended.some((v) => v.voids === row.id);
      if (voided) expect(isNewestFoldingEvent(row, amended)).toBe(false);
    }
    // …and the case that makes the loop above non-vacuous.
    expect(amended.some((r) => amended.some((v) => v.voids === r.id))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// partialBadge — what the row actually RENDERS, decided outside the JSX
// ---------------------------------------------------------------------------

/** The panel's own `isPartial` prop, wired to the REAL predicate over the REAL
 *  skin — the same closure `pad-host.tsx` builds. Takes the ledger so the view
 *  it judges against is the one the row belongs to. */
const partialOf = (events: readonly EventEnvelope[]) => {
  const v = view(events);
  return (eventType: string, payload: Record<string, unknown>) => isPartialDockAnswer(skin, eventType, payload, v);
};

describe("partialBadge", () => {
  it("offers the amend CONTROL on the row the hold window cut short", () => {
    const all = rows(SETTLED);
    expect(partialBadge(all[1]!, all, OWN, null, null, true, partialOf(SETTLED))).toBe("amend");
  });

  it("falls back to the R7 LABEL where the amendment is unavailable — the console, which wires no handler", () => {
    const all = rows(SETTLED);
    expect(partialBadge(all[1]!, all, OWN, null, null, false, partialOf(SETTLED))).toBe("label");
  });

  it("falls back to the LABEL on a partial row a later rally now sits after", () => {
    const later = stream(ev(1, RALLY_TYPE, SETTLED_PAYLOAD), ev(2, RALLY_TYPE, { wonBy: "A" }));
    const all = rows(later);
    expect(partialBadge(all[1]!, all, OWN, null, null, true, partialOf(later))).toBe("label");
  });

  it("shows NOTHING on the superseded row after an amendment — a retracted record is not an incomplete one", () => {
    const all = rows(AMENDED());
    // The original's payload is still `{wonBy}` and still reads partial…
    expect(partialOf(AMENDED())(all[1]!.type, all[1]!.payload as Record<string, unknown>)).toBe(true);
    // …but the row it belongs to has been voided, so the badge is gone.
    expect(partialBadge(all[1]!, all, OWN, null, null, true, partialOf(AMENDED()))).toBe("none");
  });

  it("shows NOTHING on the completed row that replaced it", () => {
    const all = rows(AMENDED());
    expect(partialBadge(all[3]!, all, OWN, null, null, true, partialOf(AMENDED()))).toBe("none");
  });

  it("falls back to the LABEL while that row's own hold window is still open", () => {
    const all = rows(SETTLED);
    expect(partialBadge(all[1]!, all, OWN, null, all[1]!.id, true, partialOf(SETTLED))).toBe("label");
  });

  it("shows NOTHING when the panel is mounted with no isPartial resolver at all", () => {
    const all = rows(SETTLED);
    expect(partialBadge(all[1]!, all, OWN, null, null, true, undefined)).toBe("none");
  });
});

describe("partialBadge — mutation proof (the voided suppression is load-bearing)", () => {
  it("a version that judges the payload WITHOUT the voided check disagrees on the superseded row", () => {
    const all = rows(AMENDED());
    const original = all[1]!;
    const payloadOnly = partialOf(AMENDED())(original.type, original.payload as Record<string, unknown>);
    expect(payloadOnly).toBe(true); // what the mutant would render
    expect(partialBadge(original, all, OWN, null, null, true, partialOf(AMENDED()))).toBe("none"); // what the real one renders
  });
});

// ---------------------------------------------------------------------------
// amendPlan — the void+re-append pair the host submits
// ---------------------------------------------------------------------------

describe("amendPlan", () => {
  it("names the original as the void target and re-appends its own type and payload VERBATIM", () => {
    expect(amendPlan("e-1", SETTLED)).toEqual({ voidId: "e-1", type: RALLY_TYPE, payload: { wonBy: "H" } });
  });

  it("re-appends the payload including any `at` stamp, so the correction keeps the ORIGINAL game time", () => {
    const stamped = stream(ev(1, RALLY_TYPE, { wonBy: "H", at: { period: "S1", elapsed: 120 } }));
    expect(amendPlan("e-1", stamped)?.payload).toEqual({ wonBy: "H", at: { period: "S1", elapsed: 120 } });
  });

  it("is null for an id the ledger does not carry", () => {
    expect(amendPlan("nope", SETTLED)).toBeNull();
  });

  it("is null for a core.void row — a void is not itself voidable (engine: resolveVoids)", () => {
    expect(amendPlan("e-2", [...SETTLED, ev(2, "core.void", {}, "e-1")])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// runAmend — the CRITICAL from fix round 1, driven over a REAL queue
// ---------------------------------------------------------------------------
//
// WHAT THIS BLOCK IS FOR. Round 1 shipped the void as a SIBLING of the held
// replacement. The drain could not reorder them, but the void sat parked and
// live while the replacement spent a whole hold window in a DROPPABLE state —
// and the pad offers the control that drops it (`ribbonUndoTarget` always
// offers take-back on a held tap; the row's own Void routes to the same place).
// One ordinary tap and the void drained ALONE: the original struck through with
// nothing in its place, the score down a point, the pad deleting the very event
// the scorer opened the amend to repair.
//
// So this drives `runAmend` against the REAL `queue.ts` primitives over a REAL
// `memoryQueueStore` — never a mock of them. The three states below are the
// whole invariant, and the second one is the defect.
//
// It also closes the round's other IMPORTANT: the submit ORDER used to be
// pinned ONLY by the e2e, and `e2e.yml` runs on push to `main`, so a PR carried
// no signal on it at all — a reviewer flipped the order and the whole suite
// stayed green. The release case below reads `store.list()` and fails.
describe("runAmend — the void is a consequence of the replacement surviving", () => {
  const PLAN = { voidId: "e-1", type: RALLY_TYPE, payload: { wonBy: "H" } };

  /**
   * `pad-host`'s `heldSubmit`/`submit` pair, wired to the real queue.
   *
   * KNOWN LIMIT OF THIS HARNESS, stated so nobody over-trusts what it proves.
   * The queue PRIMITIVES below are the real ones, so the binding semantics
   * genuinely are tested — but the wiring around them is a hand-written MIRROR
   * of `use-pad-pipeline.ts`, and a mirror agrees with itself. It is
   * structurally incapable of reaching the RESUME path (a fresh mount adopting
   * a queue left in IndexedDB), which is exactly where the round-2 duplicate-
   * point defect lived: this file was fully green while a reload mid-hold sent
   * the replacement and dropped the void. That case is pinned in
   * `__tests__/use-pad-pipeline.test.tsx`, over the REAL hook, and it belongs
   * there rather than here. Do not add a resume case to this mirror.
   */
  function realQueueIo(store: QueueStore, holdMs: number) {
    let n = 0;
    const pending = (type: string, payload: unknown): PendingEvent => ({
      localId: `l-${++n}`,
      idempotencyKey: `k-${n}`,
      type,
      payload,
      expectedSeq: n,
      createdAt: new Date(0).toISOString(),
      attempts: 0,
    });
    return {
      submitHeld: async (type: string, payload: unknown) => {
        const event = pending(type, payload);
        await enqueueHeld(store, event, holdMs, () => {});
        return { heldId: event.idempotencyKey, heldUntil: Date.now() + holdMs };
      },
      submit: async (type: string, payload: unknown, opts?: { dropWith?: string }) => {
        await enqueue(store, { ...pending(type, payload), ...(opts?.dropWith === undefined ? {} : { dropWith: opts.dropWith }) });
      },
    };
  }

  const typesIn = async (store: QueueStore) => (await store.list()).map((e) => e.type);

  it("queues the replacement AND its void immediately, bound by a DURABLE marker", async () => {
    const store = memoryQueueStore();
    const heldId = await runAmend(PLAN, realQueueIo(store, 10_000));
    expect(heldId).not.toBeNull();
    // Both entries exist from the moment the amendment opens — this is the
    // DURABLE half. A reload mid-hold finds them both and resumes them in
    // order; a design that waited for the release (round 2) lost the void to a
    // reload and doubled the point.
    expect(await typesIn(store)).toEqual([RALLY_TYPE, "core.void"]);
    const queued = await store.list();
    expect(queued[1]?.payload, "the void names the original").toEqual({ event_id: "e-1" });
    expect(
      queued[1]?.dropWith,
      "and it is BOUND to the replacement — a plain sibling is what round 1 shipped, and a take-back stranded it",
    ).toBe(heldId);
    expect(queued[0]?.dropWith, "the replacement itself is bound to nothing").toBeUndefined();
  });

  it("THE CRITICAL: dropping the replacement mid-hold cascades to its void — the original event survives intact", async () => {
    const store = memoryQueueStore();
    const heldId = await runAmend(PLAN, realQueueIo(store, 10_000));
    // Exactly what `handleUndo` does inside the hold window: `decideUndo`
    // returns {kind:"drop"} and `dropHeldSubmission` calls this.
    expect(await dropHeld(store, heldId as string), "the replacement must really be droppable").toBe(true);
    // This is the CANCELLABLE half, and it is the whole reason `dropWith` is a
    // field rather than a plain queued sibling: a void left behind here drains
    // alone and DELETES a scored event the scorer never asked to lose.
    expect(await typesIn(store)).toEqual([]);
  });

  it("releasing it — Send now, or the hold's own tick — leaves the void BEHIND it, never in front", async () => {
    const store = memoryQueueStore();
    const heldId = await runAmend(PLAN, realQueueIo(store, 10_000));
    await releaseHeld(store, heldId as string);
    // Order is unchanged by the release: `peekInOrder` stops at a held entry,
    // so the void can never ack before the replacement and no reader ever sees
    // the original gone with nothing in its place (the score-dip fix).
    expect(await typesIn(store)).toEqual([RALLY_TYPE, "core.void"]);
    const queued = await store.list();
    expect(queued[0]?.heldUntil, "and the replacement is no longer held").toBeUndefined();
  });

  it("a replacement the double-submit guard refuses enqueues nothing at all — no orphan void", async () => {
    const store = memoryQueueStore();
    // `submitHeld` returning null is the pipeline's own refusal path, and the
    // round-1 code fired the void straight past it.
    const heldId = await runAmend(PLAN, {
      submitHeld: async () => null,
      submit: async (type, payload) => {
        await enqueue(store, {
          localId: "x",
          idempotencyKey: "x",
          type,
          payload,
          expectedSeq: 0,
          createdAt: new Date(0).toISOString(),
          attempts: 0,
        });
      },
    });
    expect(heldId).toBeNull();
    expect(await typesIn(store), "nothing was held, so nothing may be voided").toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The console keeps its label (fix round 1, controller ruling)
// ---------------------------------------------------------------------------

describe("partialBadge on a surface with no amendment — the organiser console", () => {
  // `fixture-console.tsx` mounts this panel outside any pad and passes
  // `isPartial` but no `onAmend`, i.e. `amendEnabled: false`.
  const CONSOLE = { amendEnabled: false } as const;

  it("keeps the R7 label on a VOIDED partial row, which the pad suppresses", () => {
    const all = rows(AMENDED());
    const original = all[1]!;
    // Same row, same ledger, two surfaces, two answers — and both are right.
    expect(
      partialBadge(original, all, OWN, null, null, true, partialOf(AMENDED())),
      "on the pad it was just superseded by the row below it",
    ).toBe("none");
    expect(
      partialBadge(original, all, OWN, null, null, CONSOLE.amendEnabled, partialOf(AMENDED())),
      "on the console nothing could have amended it, so R7's label must stand",
    ).toBe("label");
  });

  it("still says nothing about a row that was never partial", () => {
    const all = rows(AMENDED());
    expect(partialBadge(all[3]!, all, OWN, null, null, CONSOLE.amendEnabled, partialOf(AMENDED()))).toBe("none");
  });
});
