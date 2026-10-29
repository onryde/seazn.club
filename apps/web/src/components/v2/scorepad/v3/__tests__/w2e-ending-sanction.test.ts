// W2e Task 30 (B2-1; D3, D13; rules X-SE-1, X-SE-3): a disqualifying sanction ends the match FROM THE PAD.
//
// What is proved here, and against what:
//   * the SHEET: the module's own sanction sheet (resolved through the real registry, `resolvePad`) adds a confirm step for
//     exactly the engine's declared end levels (`module.sanctionEnding.endLevels`) and for no other level;
//   * the PAIR: the confirm's payload goes through the host's own `endingPlanOf` and `runEnding` over a REAL queue store, and
//     the two queued events (sanction, then `core.forfeit{by, reason:"disqualified"}`) name the SAME side; the engine's strict
//     fold then admits both and decides the match for the other side;
//   * the PROMPT: the host's own `endingPromptOf` model and the REAL `PadHostV3` (server-rendered from `initialEvents`) open on
//     the ending prompt for a ledger whose last sanction ends the match, and offer "Record the ending" only to someone the
//     server's own predicate (`scorerMayForfeit(lastLiveEvent(...))`) lets record it;
//   * the AGREEMENT: the prompt is open exactly when the engine's strict fold refuses a probe with ENDING_SANCTION_PENDING.
//
// Expected values come from the engine's declarations (`sanctionEnding`, each module's own sanction ladder, `outcomeOf`) and
// from the spec's D13 text, never from the code under test. Every sweep reports how many items it checked and fails on zero.
//
// apps/web vitest is `environment: "node"`: a tap cannot be driven here. The wiring of the host's `send` and of the prompt's
// buttons is pinned by reading the source (the precedent of pad-host-band-storage.test.tsx) and is driven for real by
// e2e/scorepad-v3-ending-sanction.spec.ts.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type * as TS from "typescript";
import { describe, expect, it } from "vitest";
import {
  EngineError,
  foldMatchWithStoppage,
  lastLiveEvent,
  outcomeOf,
  pendingEndingSanction,
  matchEndFacts,
  scorerMayForfeit,
  type EventEnvelope,
  type LineupPair,
} from "@seazn/engine/core";
import type { AnySportModule, ModuleEvent } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
import { defaultLineupPair, makeEnvelope } from "@seazn/engine/testkit";
import { DictProvider } from "@/components/i18n/dict-provider";
import type { Dict } from "@/lib/i18n-constants";
import en from "@/dictionaries/en/ui.json";
import es from "@/dictionaries/es/ui.json";
import fr from "@/dictionaries/fr/ui.json";
import nl from "@/dictionaries/nl/ui.json";
import { foldClient } from "../../module-client";
import { enqueue, enqueueHeld, dropHeld } from "../../queue";
import { memoryQueueStore, type QueueStore } from "../../queue-store";
import type { PadTransport } from "../../transport";
import type { PendingEvent } from "../../types";
import { answerStep, currentStep, initialSheetState } from "../guided-sheet";
import { EndingPrompt } from "../ending-prompt";
import { PadHostV3, admitsTapWhileEndingPending, endingPlanOf, endingPromptOf, runEnding, sanctionRowOf } from "../pad-host";
import { resolvePad } from "../registry";
import type { ActivityEvent } from "../activity";
import type { GuidedSheetSpec, PadHostView, SheetChoiceStep } from "../types";
import { liveView } from "./_views";

// `typescript` through require, not import: vite's import analysis chokes on the 10 MB CJS bundle (the precedent is
// forfeit-vocabulary-scan.test.ts). The type side is a type-only import, erased before vite sees it.
const ts: typeof TS = createRequire(import.meta.url)("typescript");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Echoes its key and variables, so an assertion cannot pass by resolving the wrong key. */
const t = (key: string, vars?: Record<string, string | number>): string => (vars ? `${key}(${JSON.stringify(vars)})` : key);

type Side = "home" | "away";
const SIDES: readonly Side[] = ["home", "away"];
const ENTRANT: Record<Side, string> = { home: "H", away: "A" }; // `defaultLineupPair`'s own entrant ids
const OTHER: Record<Side, Side> = { home: "away", away: "home" };
const NAMES = { home: "Asha Rao", away: "Bo Lindqvist" } as const;

/** The sports whose declaration has an END level — the engine's own list, never a typed one. */
const DECLARING = builtinModules.filter((m) => (m.sanctionEnding?.endLevels.length ?? 0) > 0);
const decl = (m: AnySportModule) => m.sanctionEnding!;

/** A sport's scoring event for `side`: its own rally/point type and payload key, from the fold's own accepted shapes. */
function scoreEvent(m: AnySportModule, side: Side): ModuleEvent {
  return m.key === "tennis"
    ? ({ type: "tennis.point", payload: { by: ENTRANT[side] } } as ModuleEvent)
    : ({ type: `${m.key}.rally`, payload: { wonBy: ENTRANT[side] } } as ModuleEvent);
}

interface Rig {
  readonly module: AnySportModule;
  readonly cfg: unknown;
  readonly lineups: LineupPair;
}
const rigOf = (m: AnySportModule): Rig => ({ module: m, cfg: m.configSchema.parse({}), lineups: defaultLineupPair(m.positions) });

/** A ledger from `[type, payload, voidsSeq?]` rows; seq counts from 1, the target of a void is `e-<seq>` (`makeEnvelope`). */
function ledger(rows: readonly (readonly [string, unknown, number?])[]): EventEnvelope[] {
  return rows.map(([type, payload, voidsSeq], i) =>
    makeEnvelope(i + 1, { type, payload } as ModuleEvent, voidsSeq === undefined ? undefined : `e-${voidsSeq}`),
  );
}
const START = ["core.start", {}] as const;
const sanctionRow = (m: AnySportModule, side: Side, level: string) =>
  [decl(m).eventType, { by: ENTRANT[side], level }] as const;
// Two literal helpers, not one with a `reason` parameter: forfeit-vocabulary-scan reads every `core.forfeit` write's reason as a
// literal against FORFEIT_REASONS, and a variable would be a named exception to add there.
const forfeitRow = (side: Side) => ["core.forfeit", { by: ENTRANT[side], reason: "disqualified" }] as const;
const retiredForfeitRow = (side: Side) => ["core.forfeit", { by: ENTRANT[side], reason: "retired" }] as const;
const endLevelOf = (m: AnySportModule) => decl(m).endLevels[0]!;

const rowsOf = (events: readonly EventEnvelope[]): ActivityEvent[] =>
  events.map((e) => ({ id: e.id, seq: e.seq, type: e.type, payload: e.payload, voids: e.voids ?? null }));

/** The fold a probe is judged by: the engine's own strict write path over the ledger, exactly the route's reading. */
function strictFold(rig: Rig, history: readonly EventEnvelope[], probe: EventEnvelope) {
  return foldMatchWithStoppage(rig.module, rig.cfg, rig.lineups, [...history, probe], { strictFromSeq: probe.seq });
}
const noteProbe = (seq: number) => makeEnvelope(seq, { type: "core.note", payload: { text: "probe" } } as ModuleEvent);

function refusedAsPending(rig: Rig, history: readonly EventEnvelope[]): boolean {
  try {
    strictFold(rig, history, noteProbe(history.length + 1));
    return false;
  } catch (err) {
    if (err instanceof EngineError && err.code === "ENDING_SANCTION_PENDING") return true;
    throw err;
  }
}

const SESSION = { ownEventIds: new Set<string>(), deviceLinkId: null } as const;
function promptFor(
  rig: Rig,
  events: readonly EventEnvelope[],
  o: { canOrganise?: boolean; own?: ReadonlySet<string>; deviceLinkId?: string | null } = {},
) {
  return endingPromptOf({
    module: rig.module,
    rows: rowsOf(events),
    state: foldClient(rig.module, rig.cfg, rig.lineups, events),
    canOrganise: o.canOrganise ?? false,
    ownEventIds: o.own ?? SESSION.ownEventIds,
    deviceLinkId: o.deviceLinkId === undefined ? SESSION.deviceLinkId : o.deviceLinkId,
    lineups: rig.lineups,
  });
}

/** The module's own sanction sheet for `side`, resolved through the REAL registry's skin. */
function sanctionSheetOf(rig: Rig, side: Side, events: readonly EventEnvelope[] = ledger([START])): { spec: GuidedSheetSpec; view: PadHostView } {
  const view = liveView(rig.module.key, { events: events.map((e) => ({ type: e.type, payload: e.payload, ...(e.voids ? { voids: e.voids } : {}) })), entrantNames: NAMES });
  const sheets = resolvePad(rig.module.key, t).sheets!(view);
  const found = Object.values(sheets).filter((s) => s.event === decl(rig.module).eventType);
  // One sheet per side records the sanction; the side is fixed by the tile, so the sheet's payload names it.
  const spec = found.find((s) => (s.buildPayload({ level: "x" }) as { by: string }).by === ENTRANT[side]);
  if (spec === undefined) throw new Error(`${rig.module.key}: no sanction sheet for ${side}`);
  return { spec, view };
}

/** Drive a sheet like the chassis does: the level step answers `level`, a person step the side's first player, a confirm
 *  step "confirmed". Returns the steps the scorer SAW (in order) and the completed event, or null when it did not complete. */
function driveSheet(spec: GuidedSheetSpec, side: Side, level: string) {
  let state = initialSheetState();
  const seen: { id: string; kind: string }[] = [];
  for (let guard = 0; guard < 12; guard++) {
    const step = currentStep(spec, state);
    if (step === null) break;
    seen.push({ id: step.id, kind: step.kind });
    const answer = step.id === "level" ? level : step.kind === "person" ? `${ENTRANT[side]}-p1` : step.kind === "confirm" ? "confirmed" : (step as SheetChoiceStep).options[0]!.id;
    const out = answerStep(spec, state, answer);
    if (out.done) return { seen, event: out.event };
    state = out.state;
  }
  return { seen, event: null };
}

/** `pad-host`'s `heldSubmit`/`submit` pair over a REAL queue store (the harness `partial-amend.test.ts` uses; its limit is
 *  stated there: it cannot reach the RESUME path, which use-pad-pipeline.test.tsx drives over the real hook). */
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

// ---------------------------------------------------------------------------
// The sheet and the pair
// ---------------------------------------------------------------------------

describe("W2e T30 — anti-vacuity: the sports this task covers", () => {
  it("the engine declares an END level for at least badminton and tennis, and each has a v3 skin with a sanction sheet per side", () => {
    const keys = DECLARING.map((m) => m.key);
    expect(keys).toEqual(expect.arrayContaining(["badminton", "tennis"]));
    let sheets = 0;
    for (const m of DECLARING) for (const side of SIDES) {
      expect(sanctionSheetOf(rigOf(m), side).spec.steps.length, `${m.key}/${side}`).toBeGreaterThan(0);
      sheets++;
    }
    expect(sheets).toBe(DECLARING.length * 2);
  });
});

describe("W2e T30 — the module's own sanction sheet adds the confirm step for exactly the engine's end levels", () => {
  it("a level asks 'This ends the match' iff it is in module.sanctionEnding.endLevels — for every level of every declaring sport, both sides", () => {
    let checked = 0;
    let ends = 0;
    let others = 0;
    for (const m of DECLARING) {
      const rig = rigOf(m);
      for (const side of SIDES) {
        const { spec } = sanctionSheetOf(rig, side);
        const levelStep = spec.steps.find((s) => s.id === "level") as SheetChoiceStep;
        for (const option of levelStep.options) {
          const { seen, event } = driveSheet(spec, side, option.id);
          const confirm = seen.find((s) => s.kind === "confirm");
          const isEnd = decl(m).endLevels.includes(option.id);
          expect(confirm !== undefined, `${m.key}/${side}/${option.id}: a confirm step iff an end level`).toBe(isEnd);
          // The confirm step is the LAST thing the scorer sees: nothing is asked after the question "this ends the match".
          if (isEnd) expect(seen.at(-1)?.kind, `${m.key}/${option.id}`).toBe("confirm");
          expect(event, `${m.key}/${side}/${option.id}: the sheet completes`).not.toBeNull();
          expect(event!.type).toBe(decl(m).eventType);
          expect((event!.payload as { level: string }).level).toBe(option.id);
          checked++;
          if (isEnd) ends++;
          else others++;
        }
      }
    }
    expect(checked, "levels checked").toBeGreaterThan(0);
    expect(ends, "end levels seen").toBeGreaterThan(0);
    expect(others, "non-end levels seen").toBeGreaterThan(0);
  });

  it("the confirm step reads 'This ends the match: <side> loses' naming the SANCTIONED side (by name, else the side word)", () => {
    let checked = 0;
    for (const m of DECLARING) {
      const rig = rigOf(m);
      for (const side of SIDES) {
        const { spec } = sanctionSheetOf(rig, side);
        const confirm = spec.steps.find((s) => s.kind === "confirm");
        expect(confirm, `${m.key}/${side}`).toBeDefined();
        if (confirm?.kind !== "confirm") throw new Error("unreachable");
        // `echo t`: the key and its variables, so the right key AND the right name are both witnessed.
        expect(confirm.summary({ level: endLevelOf(m) })).toBe(`pad.sanction.endsMatch(${JSON.stringify({ side: NAMES[side] })})`);
        checked++;
      }
    }
    expect(checked).toBe(DECLARING.length * 2);
  });

  it("with no entrant name the summary falls back to the side word, never to an empty or undefined side", () => {
    const m = DECLARING[0]!;
    const rig = rigOf(m);
    const view = liveView(m.key, {});
    const spec = Object.values(resolvePad(m.key, t).sheets!(view)).find((s) => s.event === decl(m).eventType)!;
    const confirm = spec.steps.find((s) => s.kind === "confirm");
    if (confirm?.kind !== "confirm") throw new Error("no confirm step");
    expect(confirm.summary({ level: endLevelOf(m) })).toMatch(/^pad\.sanction\.endsMatch\(\{"side":"scorepad\.attribution\.(home|away)"\}\)$/);
    expect(rig.module.key).toBe(m.key);
  });
});

describe("W2e T30 — a disqualification confirm sends the sanction, then the forfeit, against the same side", () => {
  it("a disqualification confirm sends sanction then forfeit with the same side", async () => {
    let pairs = 0;
    for (const m of DECLARING) {
      const rig = rigOf(m);
      for (const side of SIDES) {
        const { spec } = sanctionSheetOf(rig, side);
        const { event } = driveSheet(spec, side, endLevelOf(m));
        const plan = endingPlanOf(m, event!.type, event!.payload);
        expect(plan, `${m.key}/${side}: the completed sheet is an ending`).not.toBeNull();

        const store = memoryQueueStore();
        const heldId = await runEnding(plan!, realQueueIo(store, 10_000));
        expect(heldId).not.toBeNull();
        const queued = await store.list();
        // THE TWO PAYLOADS, in order: the sanction the sheet built, then the forfeit naming the SAME entrant.
        expect(queued.map((e) => e.type), `${m.key}/${side}`).toEqual([decl(m).eventType, "core.forfeit"]);
        expect(queued[0]!.payload).toEqual(event!.payload);
        expect(queued[1]!.payload).toEqual({ by: ENTRANT[side], reason: "disqualified" });
        expect((queued[0]!.payload as { by: string }).by).toBe((queued[1]!.payload as { by: string }).by);
        // The sanction is the held one; the forfeit is bound to it (durable, cancellable: R8/#675's rule).
        expect(queued[0]!.heldUntil).toBeDefined();
        expect(queued[1]!.dropWith).toBe(queued[0]!.idempotencyKey);
        expect(queued[1]!.heldUntil, "the forfeit is not itself held").toBeUndefined();

        // THE ENGINE, strictly, over the very payloads the queue holds: both are admitted and the OTHER side wins.
        const events = ledger([START, ...queued.map((q) => [q.type, q.payload] as const)]);
        const folded = foldMatchWithStoppage(m, rig.cfg, rig.lineups, events, { strictFromSeq: 0 });
        expect(outcomeOf(m, folded), `${m.key}/${side}`).toEqual({
          kind: "award",
          winner: ENTRANT[OTHER[side]],
          loser: ENTRANT[side],
          reason: "disqualified",
        });
        pairs++;
      }
    }
    expect(pairs).toBe(DECLARING.length * 2);
  });

  it("anything that is not an end-level sanction of the declared event is not an ending (no plan)", () => {
    let checked = 0;
    for (const m of DECLARING) {
      const d = decl(m);
      const nonEnd = ["warning", "x-not-a-level"].filter((l) => !d.endLevels.includes(l));
      for (const level of nonEnd) {
        expect(endingPlanOf(m, d.eventType, { by: "H", level }), `${m.key}/${level}`).toBeNull();
        checked++;
      }
      expect(endingPlanOf(m, `${m.key}.rally`, { by: "H", level: d.endLevels[0] }), "another event type").toBeNull();
      expect(endingPlanOf(m, d.eventType, { level: d.endLevels[0] }), "no sanctioned side").toBeNull();
      expect(endingPlanOf(m, d.eventType, undefined), "no payload").toBeNull();
      checked += 3;
    }
    // A sport that declares nothing never has an ending.
    const undeclaring = builtinModules.filter((m) => m.sanctionEnding === undefined);
    expect(undeclaring.length).toBeGreaterThan(0);
    for (const m of undeclaring) expect(endingPlanOf(m, `${m.key}.sanction`, { by: "H", level: "disqualification" }), m.key).toBeNull();
    expect(checked).toBeGreaterThan(0);
  });

  it("a warning-level sanction sends one event and no prompt", async () => {
    let checked = 0;
    for (const m of DECLARING) {
      const rig = rigOf(m);
      for (const side of SIDES) {
        const { spec } = sanctionSheetOf(rig, side);
        const levelStep = spec.steps.find((s) => s.id === "level") as SheetChoiceStep;
        const warning = levelStep.options.map((o) => o.id).find((id) => !decl(m).endLevels.includes(id))!;
        const { seen, event } = driveSheet(spec, side, warning);
        expect(seen.some((s) => s.kind === "confirm")).toBe(false);
        expect(endingPlanOf(m, event!.type, event!.payload), `${m.key}/${warning}: a single ordinary event`).toBeNull();
        // The write is the ordinary one: the strict fold admits it, and the pad has nothing to ask afterwards.
        const history = ledger([START, [event!.type, event!.payload] as const]);
        expect(() => strictFold(rig, history, noteProbe(history.length + 1))).not.toThrow();
        expect(promptFor(rig, history), `${m.key}/${warning}`).toBeNull();
        checked++;
      }
    }
    expect(checked).toBe(DECLARING.length * 2);
  });

  it("take back inside the hold drops both queued events (queue level; the optimistic mirror is pinned over the real hook in use-pad-pipeline.test.tsx)", async () => {
    const m = DECLARING[0]!;
    const rig = rigOf(m);
    const { spec } = sanctionSheetOf(rig, "home");
    const { event } = driveSheet(spec, "home", endLevelOf(m));
    const store = memoryQueueStore();
    const heldId = await runEnding(endingPlanOf(m, event!.type, event!.payload)!, realQueueIo(store, 10_000));
    expect((await store.list()).length).toBe(2);
    expect(await dropHeld(store, heldId!)).toBe(true);
    expect(await store.list(), "the forfeit must not drain alone and end a match the scorer took back").toEqual([]);
  });

  it("a refused double-submit writes nothing at all (no forfeit without its sanction)", async () => {
    const m = DECLARING[0]!;
    const rig = rigOf(m);
    const { spec } = sanctionSheetOf(rig, "away");
    const { event } = driveSheet(spec, "away", endLevelOf(m));
    const store = memoryQueueStore();
    const io = realQueueIo(store, 10_000);
    const heldId = await runEnding(endingPlanOf(m, event!.type, event!.payload)!, { ...io, submitHeld: async () => null });
    expect(heldId).toBeNull();
    expect(await store.list()).toEqual([]);
  });

  it("assumption guard: no declaring skin offers a dock for its sanction, so sending it without `dispatch` skips nothing", () => {
    let checked = 0;
    for (const m of DECLARING) {
      const rig = rigOf(m);
      for (const side of SIDES) {
        const { view, spec } = sanctionSheetOf(rig, side);
        const { event } = driveSheet(spec, side, endLevelOf(m));
        expect(resolvePad(m.key, t).dock?.(event!.type, view, event!.payload as Record<string, unknown>) ?? null, `${m.key}/${side}`).toBeNull();
        checked++;
      }
    }
    expect(checked).toBe(DECLARING.length * 2);
  });
});

// ---------------------------------------------------------------------------
// The prompt model
// ---------------------------------------------------------------------------

describe("W2e T30 — the ending prompt model", () => {
  /** Ledger shapes and what each must read. `where` is the sanction row's seq. */
  const FLOWS = (m: AnySportModule, side: Side) => {
    const S = sanctionRow(m, side, endLevelOf(m));
    const warn = sanctionRow(m, side, "warning");
    return [
      { name: "sanction alone", rows: [START, S], pending: true, soleSanctionSeq: 2 },
      { name: "sanction then its ending", rows: [START, S, forfeitRow(side)], pending: false },
      { name: "sanction then the OTHER side's forfeit (match decided either way)", rows: [START, S, retiredForfeitRow(OTHER[side])], pending: false },
      { name: "sanction voided", rows: [START, S, ["core.void", { event_id: "e-2" }, 2] as const], pending: false },
      { name: "ending voided: pending again", rows: [START, S, forfeitRow(side), ["core.void", { event_id: "e-3" }, 3] as const], pending: true, soleSanctionSeq: 2 },
      { name: "sanction voided while the ending stands: match stays ended", rows: [START, S, forfeitRow(side), ["core.void", { event_id: "e-2" }, 2] as const], pending: false },
      { name: "ending voided, then the sanction: play resumes", rows: [START, S, forfeitRow(side), ["core.void", { event_id: "e-3" }, 3] as const, ["core.void", { event_id: "e-2" }, 2] as const], pending: false },
      { name: "abandoned", rows: [START, S, ["core.abandon", { reason: "rain" }] as const], pending: false },
      { name: "a warning is never pending", rows: [START, warn], pending: false },
      { name: "a voided card, then a fresh one: the fresh one is the row to void", rows: [START, S, ["core.void", { event_id: "e-2" }, 2] as const, S], pending: true, soleSanctionSeq: 4 },
      { name: "pre-W2e in-progress ledger (rallies after the card)", rows: [START, S, [scoreEvent(m, OTHER[side]).type, scoreEvent(m, OTHER[side]).payload] as const, [scoreEvent(m, side).type, scoreEvent(m, side).payload] as const], pending: true, soleSanctionSeq: 2 },
    ];
  };

  it("the prompt is open exactly when the engine's strict fold refuses a probe with ENDING_SANCTION_PENDING (one definition of 'pending')", () => {
    let flows = 0;
    let open = 0;
    let closed = 0;
    for (const m of DECLARING) {
      const rig = rigOf(m);
      for (const side of SIDES) {
        for (const flow of FLOWS(m, side)) {
          const events = ledger(flow.rows as never);
          const model = promptFor(rig, events, { canOrganise: true });
          const refused = refusedAsPending(rig, events);
          expect(model !== null, `${m.key}/${side}/${flow.name}: prompt vs the fold's refusal`).toBe(refused);
          expect(refused, `${m.key}/${side}/${flow.name}: against the flow's own declared state`).toBe(flow.pending);
          flows++;
          if (refused) open++;
          else closed++;
        }
      }
    }
    expect(flows).toBe(DECLARING.length * 2 * 11);
    expect(open).toBeGreaterThan(0);
    expect(closed).toBeGreaterThan(0);
  });

  it("names the sanctioned entrant and level, and the live row to void", () => {
    let checked = 0;
    for (const m of DECLARING) {
      const rig = rigOf(m);
      for (const side of SIDES) {
        for (const flow of FLOWS(m, side)) {
          if (!flow.pending) continue;
          const model = promptFor(rig, ledger(flow.rows as never), { canOrganise: true })!;
          expect(model.by, `${m.key}/${flow.name}`).toBe(ENTRANT[side]);
          expect(model.side).toBe(side);
          expect(model.level).toBe(endLevelOf(m));
          expect(model.sanctionId, `${m.key}/${flow.name}`).toBe(`e-${flow.soleSanctionSeq}`);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("agrees with the engine's own reader (pendingEndingSanction + matchEndFacts) on every flow", () => {
    let checked = 0;
    for (const m of DECLARING) {
      const rig = rigOf(m);
      for (const side of SIDES) {
        for (const flow of FLOWS(m, side)) {
          const events = ledger(flow.rows as never);
          const state = foldClient(rig.module, rig.cfg, rig.lineups, events);
          const engine = pendingEndingSanction(m, events, matchEndFacts(m, { state, settlement: null }, events));
          const model = promptFor(rig, events, { canOrganise: true });
          expect(model === null ? null : { by: model.by, level: model.level }, `${m.key}/${flow.name}`).toEqual(engine);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("'Record the ending' is for someone the server lets record it: the organiser, or a scorer whose last live event IS the sanction (D13)", () => {
    let recordable = 0;
    let barred = 0;
    for (const m of DECLARING) {
      const rig = rigOf(m);
      for (const side of SIDES) {
        const S = sanctionRow(m, side, endLevelOf(m));
        const cases = [
          { name: "sanction alone", rows: [START, S], scorer: true },
          { name: "ending voided (re-confirm)", rows: [START, S, forfeitRow(side), ["core.void", { event_id: "e-3" }, 3] as const], scorer: true },
          { name: "a rally after the card (pre-W2e)", rows: [START, S, [scoreEvent(m, side).type, scoreEvent(m, side).payload] as const], scorer: false },
          { name: "a note after the card (pre-W2e)", rows: [START, S, ["core.note", { text: "x" }] as const], scorer: false },
        ];
        for (const c of cases) {
          const events = ledger(c.rows as never);
          // The server's own predicate, on the ledger the route reads, for the forfeit this prompt would send.
          const serverSaysScorerMay = scorerMayForfeit(m, lastLiveEvent(events), { by: ENTRANT[side], reason: "disqualified" });
          expect(serverSaysScorerMay, `${m.key}/${c.name}: the D13 table`).toBe(c.scorer);
          const scorer = promptFor(rig, events, { canOrganise: false })!;
          expect(scorer.canRecord, `${m.key}/${side}/${c.name}: scorer`).toBe(c.scorer);
          expect(promptFor(rig, events, { canOrganise: true })!.canRecord, `${m.key}/${side}/${c.name}: organiser`).toBe(true);
          if (c.scorer) recordable++;
          else barred++;
        }
      }
    }
    expect(recordable).toBeGreaterThan(0);
    expect(barred).toBeGreaterThan(0);
  });

  it("'Void the sanction' follows the pad's one void rule: a device link may void only its own rows, the console any", () => {
    const m = DECLARING[0]!;
    const rig = rigOf(m);
    const events = ledger([START, sanctionRow(m, "home", endLevelOf(m))]);
    expect(promptFor(rig, events, { deviceLinkId: null })!.canVoid, "console").toBe(true);
    expect(promptFor(rig, events, { deviceLinkId: "dl-1", own: new Set(["e-2"]) })!.canVoid, "device link, own row").toBe(true);
    expect(promptFor(rig, events, { deviceLinkId: "dl-1", own: new Set() })!.canVoid, "device link, someone else's row").toBe(false);
  });

  it("a sport that declares no ending never has a prompt", () => {
    const m = builtinModules.find((x) => x.sanctionEnding === undefined)!;
    const rig = rigOf(m);
    expect(promptFor(rig, ledger([START]), { canOrganise: true })).toBeNull();
  });
});

describe("W2e T30 fix round 1 (M-2, M-3) — the prompt's two assumptions are guards, not fallbacks", () => {
  it("M-2: `sanctionRowOf` finds the latest LIVE row of the pending side and level, and refuses loudly when there is none", () => {
    let swept = 0;
    for (const m of DECLARING) {
      const level = endLevelOf(m);
      const eventType = decl(m).eventType;
      const pending = { by: ENTRANT.home, level };
      const events = ledger([START, sanctionRow(m, "home", level), sanctionRow(m, "home", level)]);
      // Two live rows of the same side and level: the LATEST is the one to void.
      expect(sanctionRowOf(eventType, pending, rowsOf(events)).id, `${m.key}: the latest live row`).toBe("e-3");
      // The latest voided: the earlier live one.
      const voided = ledger([START, sanctionRow(m, "home", level), sanctionRow(m, "home", level), ["core.void", { event_id: "e-3" }, 3] as const]);
      expect(sanctionRowOf(eventType, pending, rowsOf(voided)).id, `${m.key}: skips a voided row`).toBe("e-2");
      // No row at all, a voided-only row, another side's row and another level's row: each is a broken invariant (the engine
      // said an ending is pending for THIS side and level, so a live row carrying them must exist) and a plain error, never null.
      for (const [name, rows] of [
        ["an empty ledger", ledger([START])],
        ["only a voided row", ledger([START, sanctionRow(m, "home", level), ["core.void", { event_id: "e-2" }, 2] as const])],
        ["only the other side's row", ledger([START, sanctionRow(m, "away", level)])],
        ["only another level's row", ledger([START, sanctionRow(m, "home", "warning")])],
      ] as const) {
        expect(() => sanctionRowOf(eventType, pending, rowsOf(rows)), `${m.key}: ${name}`).toThrow(/no live .* row for the pending ending/);
        swept++;
      }
    }
    expect(swept).toBe(DECLARING.length * 4);
  });

  it("M-3: a sanction whose `by` is neither lineup's entrant is refused loudly — never read as the away side", () => {
    let swept = 0;
    for (const m of DECLARING) {
      const rig = rigOf(m);
      const stranger = [decl(m).eventType, { by: "NOT-A-LINEUP-ENTRANT", level: endLevelOf(m) }] as const;
      const events = ledger([START, stranger]);
      // The engine reads it as pending (it only needs a live end-level sanction)...
      expect(pendingEndingSanction(m, rowsOf(events), { decided: false, abandonActive: false }), `${m.key}: the engine reads it as pending`).not.toBeNull();
      // ...and the pad refuses to name a side for it. (The client fold itself refuses a stranger, `unknown entrant`, and the
      // pipeline then keeps its last good state: the model is handed that state here directly, the one way to reach its guard.)
      const state = foldClient(rig.module, rig.cfg, rig.lineups, ledger([START]));
      expect(
        () =>
          endingPromptOf({ module: rig.module, rows: rowsOf(events), state, canOrganise: true, ownEventIds: new Set(), deviceLinkId: null, lineups: rig.lineups }),
        m.key,
      ).toThrow(/neither lineup/);
      // The positive pair: the same ledger shape against each real side names that side.
      for (const side of SIDES) {
        expect(promptFor(rig, ledger([START, sanctionRow(m, side, endLevelOf(m))]), { canOrganise: true })?.side, `${m.key}/${side}`).toBe(side);
      }
      swept++;
    }
    expect(swept).toBe(DECLARING.length);
  });
});

describe("W2e T30 — admitsTapWhileEndingPending (the modal shape of T18's admitsTap)", () => {
  it("admits a tap only when no ending is pending", () => {
    expect(admitsTapWhileEndingPending(null)).toBe(true);
    expect(admitsTapWhileEndingPending({ by: "H", level: "disqualification" })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The REAL host
// ---------------------------------------------------------------------------

const noTransport: PadTransport = {
  async appendEvent() {
    throw new Error("w2e-ending-sanction.test: a server render sends nothing");
  },
  async listEventsSince() {
    return [];
  },
  async getLastSeq() {
    return 0;
  },
  async fetchState() {
    return { status: "in_play", last_seq: 0, state: null, summary: null, outcome: null };
  },
};

function renderHost(rig: Rig, events: readonly EventEnvelope[], o: { canOrganise: boolean; deviceLinkId?: string | null }): string {
  const skin = resolvePad(rig.module.key, (key, vars) => en_t(key, vars));
  return renderToStaticMarkup(
    createElement(
      DictProvider,
      // `children` is the third argument (react/no-children-prop); the cast is only for the type of the props bag.
      { dict: en as unknown as Dict, locale: "en" } as ComponentProps<typeof DictProvider>,
      createElement(PadHostV3, {
        module: rig.module,
        cfg: rig.cfg,
        stageKind: null,
        canOrganise: o.canOrganise,
        entrantNames: NAMES,
        fixtureId: "fx-w2e-t30",
        lineups: rig.lineups,
        identity: { recordedBy: "user-1", deviceLinkId: o.deviceLinkId ?? null },
        transport: noTransport,
        entitlements: {},
        initialEvents: events,
        queueDbName: "w2e-t30-ssr",
        skin,
        auth: { kind: "session" },
      }),
    ),
  );
}
/** A real translator over the English dictionary, so the markup carries the words a person reads. */
function en_t(key: string, vars?: Record<string, string | number>): string {
  const raw = (en as Record<string, string>)[key] ?? key;
  return vars ? raw.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? `{${k}}`)) : raw;
}

describe("W2e T30 — the pad opens on the ending prompt for a ledger whose last sanction ends the match", () => {
  it("pad opens on the ending prompt for a ledger whose last sanction ends the match", () => {
    let hosts = 0;
    for (const m of DECLARING) {
      const rig = rigOf(m);
      for (const side of SIDES) {
        const events = ledger([START, sanctionRow(m, side, endLevelOf(m))]);
        const html = renderHost(rig, events, { canOrganise: true });
        expect(html, `${m.key}/${side}`).toContain('data-testid="pad-ending-pending"');
        // The question names the sanctioned side by name, and the two answers are both there.
        expect(html).toContain(NAMES[side]);
        expect(html).toContain('data-testid="pad-ending-record"');
        expect(html).toContain('data-testid="pad-ending-void"');
        // The pad is not a dead grid under a prompt: the scoring board and its dock are not offered while it is open.
        expect(html, `${m.key}/${side}: no scoring tiles under the prompt`).not.toContain('data-role="v3-tiles"');
        hosts++;
      }
    }
    expect(hosts).toBe(DECLARING.length * 2);
  });

  it("the pre-W2e in-progress ledger (rallies after the card) opens on the prompt too — not a wedged queue", () => {
    let hosts = 0;
    for (const m of DECLARING) {
      const rig = rigOf(m);
      const rally = scoreEvent(m, "home");
      const events = ledger([START, sanctionRow(m, "away", endLevelOf(m)), [rally.type, rally.payload] as const]);
      expect(renderHost(rig, events, { canOrganise: false })).toContain('data-testid="pad-ending-pending"');
      hosts++;
    }
    expect(hosts).toBe(DECLARING.length);
  });

  it("a legacy 403 never reaches the scorer raw: where the server would refuse the scorer's forfeit, the prompt does not offer 'Record the ending'", () => {
    let hosts = 0;
    for (const m of DECLARING) {
      const rig = rigOf(m);
      const rally = scoreEvent(m, "home");
      const legacy = ledger([START, sanctionRow(m, "away", endLevelOf(m)), [rally.type, rally.payload] as const]);
      // The server's answer for this scorer (T2's route): the last live event is a rally, so the forfeit is a 403.
      expect(scorerMayForfeit(m, lastLiveEvent(legacy), { by: "A", reason: "disqualified" })).toBe(false);
      const scorerHtml = renderHost(rig, legacy, { canOrganise: false, deviceLinkId: "dl-1" });
      expect(scorerHtml, `${m.key}: scorer`).toContain('data-testid="pad-ending-pending"');
      expect(scorerHtml, `${m.key}: scorer is not offered the ending`).not.toContain('data-testid="pad-ending-record"');
      // ...and is told, in the localized copy, who can resolve it — never the server's English 403.
      expect(scorerHtml).toContain(en_t("pad.ending.body.neither"));
      expect(scorerHtml).not.toContain("Only an organiser can record a walkover");
      // The organiser, for whom the same forfeit is allowed, is offered it.
      expect(renderHost(rig, legacy, { canOrganise: true }), `${m.key}: organiser`).toContain('data-testid="pad-ending-record"');
      hosts++;
    }
    expect(hosts).toBe(DECLARING.length);
  });

  it("no prompt for a finished, abandoned, voided or warning-only ledger, and the board is still there (the positive pair)", () => {
    let hosts = 0;
    for (const m of DECLARING) {
      const rig = rigOf(m);
      const S = sanctionRow(m, "home", endLevelOf(m));
      const quiet = [
        ledger([START, S, forfeitRow("home")]),
        ledger([START, S, ["core.abandon", { reason: "rain" }] as const]),
        ledger([START, S, ["core.void", { event_id: "e-2" }, 2] as const]),
        ledger([START, sanctionRow(m, "home", "warning")]),
        ledger([START]),
      ];
      for (const events of quiet) {
        const html = renderHost(rig, events, { canOrganise: true });
        expect(html, `${m.key}: ${events.map((e) => e.type).join(",")}`).not.toContain('data-testid="pad-ending-pending"');
        hosts++;
      }
      // The live, un-sanctioned pad still offers its board.
      expect(renderHost(rig, ledger([START]), { canOrganise: true })).toContain('data-role="v3-tiles"');
    }
    expect(hosts).toBe(DECLARING.length * 5);
  });

  /** The sport's own scorebug hint lines ("Tap to award the rally"), read off the dictionary's declared keys. */
  const hintTextsOf = (m: AnySportModule): string[] =>
    Object.entries(en as Record<string, string>)
      .filter(([key]) => new RegExp(`^pad\\.${m.key}\\.scorebug\\..*hint$`).test(key))
      .map(([, text]) => text);

  it("I-1: under the prompt the scorebug stops inviting taps (no hint, inert halves); a quiet ledger's scorebug still does (the positive pair)", () => {
    let hosts = 0;
    for (const m of DECLARING) {
      const rig = rigOf(m);
      const hints = hintTextsOf(m);
      expect(hints.length, `${m.key}: the dictionary declares scorebug hint lines to look for`).toBeGreaterThan(0);

      // Quiet: the halves are tappable buttons, carry their hint and are not inert.
      const quiet = renderHost(rig, ledger([START]), { canOrganise: true });
      expect(hints.some((h) => quiet.includes(h)), `${m.key}: a live scorebug shows its hint`).toBe(true);
      expect(quiet, `${m.key}: and is not inert`).not.toContain("data-scorebug-inert");
      expect(quiet).not.toContain("cursor-default");

      for (const o of [{ canOrganise: true }, { canOrganise: false, deviceLinkId: "dl-1" }]) {
        const html = renderHost(rig, ledger([START, sanctionRow(m, "home", endLevelOf(m))]), o);
        const label = `${m.key}/${o.canOrganise ? "organiser" : "scorer"}`;
        expect(html, `${label}: the prompt is up`).toContain('data-testid="pad-ending-pending"');
        // The two halves, each inert...
        expect(html.match(/data-scorebug-inert="true"/g)?.length, `${label}: both halves are inert`).toBe(2);
        expect(html.match(/aria-disabled="true"/g)?.length, `${label}: and say so to assistive tech`).toBe(2);
        // ...and nothing on the page still invites a score tap.
        for (const hint of hints) expect(html, `${label}: "${hint}" is gone`).not.toContain(hint);
        expect(html, `${label}: no hover wash on a half that does nothing`).not.toContain("pad-half");
        hosts++;
      }
    }
    expect(hosts).toBe(DECLARING.length * 2);
  });

  it("a scorer who may record the ending (the sanction is the last live event) is offered it, and may void only their own row", () => {
    let hosts = 0;
    for (const m of DECLARING) {
      const rig = rigOf(m);
      const events = ledger([START, sanctionRow(m, "home", endLevelOf(m))]);
      const html = renderHost(rig, events, { canOrganise: false, deviceLinkId: "dl-1" });
      expect(html).toContain('data-testid="pad-ending-record"');
      // After a reload a device link's `ownEventIds` is empty: it cannot void this row, so it is not offered the void.
      expect(html).not.toContain('data-testid="pad-ending-void"');
      expect(html).toContain(en_t("pad.ending.body.recordOnly"));
      hosts++;
    }
    expect(hosts).toBe(DECLARING.length);
  });
});

describe("W2e T30 — the host wires the pair, the modal and the buttons (source seams; a tap cannot be driven in node)", () => {
  const src = readFileSync(resolve(__dirname, "../pad-host.tsx"), "utf8");

  it("a completed sheet sends its event through the ending path, bypassing createSkinDispatch the way runAmend does", () => {
    expect(src).toMatch(/onComplete=\{\(event\) => \{\s*setOpenSheet\(null\);\s*send\(event\.type, event\.payload, \{ endsMatchOnConfirm: true \}\);/);
    // In `send`: only a SHEET completion may become an ending, and it runs the pair instead of `dispatch`.
    const send = src.slice(src.indexOf("const send = useCallback("), src.indexOf("const cancelQuestion = useCallback("));
    expect(send).toContain("opts?.endsMatchOnConfirm === true ? endingPlanOf(props.module, type, stamped) : null");
    expect(send).toMatch(/void sendEnding\(plan\)/);
    expect(send).toContain("admitsTapWhileEndingPending(endingPrompt)");
    // The modal check comes BEFORE anything is stamped or sent.
    expect(send.indexOf("admitsTapWhileEndingPending(endingPrompt)")).toBeLessThan(send.indexOf("stampFor("));
  });

  it("'Record the ending' sends core.forfeit{by, reason: disqualified} for the PENDING sanction; 'Void the sanction' voids that row", () => {
    expect(src).toMatch(/pipeline\.submit\("core\.forfeit", \{ by: endingPrompt\.by, reason: "disqualified" \}\)/);
    expect(src).toMatch(/handleUndo\(endingPrompt\.sanctionId\)/);
    expect(src).toMatch(/<EndingPrompt\b/);
    expect(src).toContain('data-role="v3-ending"');
  });

  /** The arrow function a `const <name> = useCallback(<arrow>, [deps])` declares, found with the TypeScript parser (so a
   *  comment, a string or a rename of a neighbour cannot satisfy it). */
  function callbackOf(name: string): { body: TS.Block; deps: string[] } {
    const file = ts.createSourceFile("pad-host.tsx", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let found: { body: TS.Block; deps: string[] } | null = null;
    const visit = (node: TS.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.initializer !== undefined && ts.isCallExpression(node.initializer)) {
        const [fn, deps] = node.initializer.arguments;
        if (fn !== undefined && ts.isArrowFunction(fn) && ts.isBlock(fn.body) && deps !== undefined && ts.isArrayLiteralExpression(deps)) {
          found = { body: fn.body, deps: deps.elements.map((e) => e.getText(file)) };
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
    if (found === null) throw new Error(`pad-host.tsx: no \`const ${name} = useCallback(<arrow>, [deps])\``);
    return found;
  }

  it("I-1: `send` and `handleOpenSheet` each open on the ending guard — refuse with the blocked banner and return — before anything is opened or sent", () => {
    let pinned = 0;
    for (const [name, firstEffect] of [
      ["send", "stampFor"],
      ["handleOpenSheet", "resolveSheet"],
    ] as const) {
      const { body, deps } = callbackOf(name);
      const first = body.statements.find((st) => !ts.isEmptyStatement(st));
      expect(first && ts.isIfStatement(first), `${name}: the guard is the callback's first statement`).toBe(true);
      const guard = first as TS.IfStatement;
      expect(guard.expression.getText(), `${name}: asks the modal predicate`).toBe("!admitsTapWhileEndingPending(endingPrompt)");
      const then = guard.thenStatement;
      expect(ts.isBlock(then), `${name}: the guard's body is a block`).toBe(true);
      const effects = (then as TS.Block).statements.map((st) => st.getText());
      expect(effects, `${name}: says why, then stops`).toEqual(['setDispatchRefusal(msg("pad.ending.blocked"));', "return;"]);
      // The guard precedes the first thing the callback does for a tap.
      const at = body.getText().indexOf(firstEffect);
      expect(at, `${name}: still calls ${firstEffect}`).toBeGreaterThan(0);
      expect(guard.getEnd() - body.getStart(), `${name}: the guard comes before ${firstEffect}`).toBeLessThan(at);
      // A callback that does not list the prompt as a dependency reads a stale one.
      expect(deps, `${name}: re-created when the prompt changes`).toContain("endingPrompt");
      pinned++;
    }
    expect(pinned).toBe(2);
  });

  /** The `async function <name>` the host declares, found with the TypeScript parser. */
  function functionOf(name: string): TS.Block {
    const file = ts.createSourceFile("pad-host.tsx", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let found: TS.Block | null = null;
    const visit = (node: TS.Node): void => {
      if (ts.isFunctionDeclaration(node) && node.name?.text === name && node.body !== undefined) found = node.body;
      ts.forEachChild(node, visit);
    };
    visit(file);
    if (found === null) throw new Error(`pad-host.tsx: no \`function ${name}\``);
    return found;
  }

  it("T30 N1: the prompt's two answers each clear the stale 'record the ending or void the sanction first' banner before they act", () => {
    // The banner is `dispatchRefusal`; `pad.ending.blocked` sets it when a tap is refused under the prompt. Neither answer
    // used to clear it, so the red sentence outlived the answer that resolved it (the e2e re-confirm step saw it stay).
    let pinned = 0;
    for (const name of ["recordEnding", "voidSanction"] as const) {
      const body = functionOf(name);
      const first = body.statements.find((st) => !ts.isEmptyStatement(st));
      expect(first?.getText(), `${name}: clears the refusal first, ahead of the guard and the try`).toBe("setDispatchRefusal(null);");
      // And it is the CLEAR that comes first, not the only mention: a failure of the answer still says so afterwards.
      expect(body.getText(), `${name}: a failed answer still sets its own refusal`).toMatch(/setDispatchRefusal\(msg\("scorepad\.rejection\.fallback"\)\)/);
      pinned++;
    }
    expect(pinned).toBe(2);
  });

  it("the board, dock, swap and sheets are not rendered while an ending is pending", () => {
    const tiles = src.indexOf('<div data-role="v3-tiles">');
    expect(tiles).toBeGreaterThan(0);
    expect(src.slice(src.lastIndexOf("{", tiles - 1) - 40, tiles)).toContain("endingPrompt === null");
  });
});

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

describe("W2e T30 fix round 1 (M-7) — the prompt's phone/desktop boundary is `md`, like the rest of the pad (AGENTS.md \"One DOM\")", () => {
  it("buttons stack and fill the width below `md` and sit in a row from `md`; no `sm:` boundary is left", () => {
    let rendered = 0;
    for (const [canRecord, canVoid] of [[true, true], [true, false], [false, true]] as const) {
      const html = renderToStaticMarkup(
        createElement(EndingPrompt, { sideName: "Asha", canRecord, canVoid, busy: false, onRecord: () => {}, onVoid: () => {}, t: en_t }),
      );
      const buttons = html.match(/<button\b[^>]*>/g) ?? [];
      expect(buttons.length, `record ${canRecord}, void ${canVoid}`).toBe((canRecord ? 1 : 0) + (canVoid ? 1 : 0));
      for (const b of buttons) expect(b, "a button fills the phone width").toMatch(/\bmax-md:w-full\b/);
      expect(html).toMatch(/\bmd:flex-row\b/);
      expect(html, "no `sm:` / `max-sm:` utility").not.toMatch(/(^|[\s"])(max-)?sm:/);
      rendered++;
    }
    expect(rendered).toBe(3);
  });
});

describe("W2e T30 — the copy is in all four locales, with its variables intact", () => {
  const LOCALES = { en, es, fr, nl } as Record<string, Record<string, string>>;
  const KEYS = {
    "pad.sanction.confirm.title": [],
    "pad.sanction.endsMatch": ["side"],
    "pad.ending.title": ["side"],
    "pad.ending.body.both": [],
    "pad.ending.body.recordOnly": [],
    "pad.ending.body.voidOnly": [],
    "pad.ending.body.neither": [],
    "pad.ending.record": [],
    "pad.ending.void": [],
    "pad.ending.blocked": [],
  } as const;

  it("every key is present, non-empty and carries exactly its variables in en, es, fr and nl; the locales differ from English", () => {
    let checked = 0;
    for (const [locale, dict] of Object.entries(LOCALES)) {
      for (const [key, vars] of Object.entries(KEYS)) {
        const text = dict[key];
        expect(typeof text === "string" && text.length > 0, `${locale}:${key}`).toBe(true);
        expect([...text!.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort(), `${locale}:${key}`).toEqual([...vars].sort());
        if (locale !== "en") expect(text, `${locale}:${key} is translated, not copied`).not.toBe(en[key as keyof typeof en]);
        checked++;
      }
    }
    expect(checked).toBe(4 * Object.keys(KEYS).length);
  });

  it("the English confirm sentence is the one the owner approved: 'This ends the match: <side> loses'", () => {
    expect(en["pad.sanction.endsMatch" as keyof typeof en]).toBe("This ends the match: {side} loses");
    expect(en["pad.ending.record" as keyof typeof en]).toBe("Record the ending");
    expect(en["pad.ending.void" as keyof typeof en]).toBe("Void the sanction");
  });
});
