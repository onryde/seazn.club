// v3/__tests__/hockey-goal-type.test.ts — W2d Task 18 (HK-TB-2, B3; PS-7d; owner option A, 2026-10-20).
//
// FIH ranks level teams on FIELD GOALS (GTR App. 3: every goal not from a penalty corner or a penalty stroke, own
// goals included), so the engine refuses an untyped `hockey.goal` on the write path by name (`GOAL_KIND_REQUIRED`).
// The pad therefore cannot soft-commit a hockey goal the moment it is tapped, the way it does every other dock: the
// tap opens a CHOICE dock (Field goal / Penalty corner / Penalty stroke, plus the existing Own goal flag), nothing is
// queued and no hold timer runs until one is chosen, and Cancel drops the tap. Ice hockey ranks on no goal type, so
// its goal soft-commits exactly as before and its kind chips stay optional enrichment.
//
// Everything here is folded through the REAL kernel (`_period-fold.ts`'s posture): the dock's own output goes back
// into `apply(..., { strict: true })`, the mode a live dispatch runs in. The expected answers come from the rule rows
// (`GOAL_TYPE_RANKS`) and the module's own cfg (`goalKinds`), never from the skin flag under test. The host's
// `dispatch` wiring itself is a browser fact — `e2e/scorepad-v3-hockey-goal-type.spec.ts` drives it; this file pins
// the pure decision it makes (`softCommitPlan`) and the renderer it mounts (`ChoiceDock`).
import { describe, expect, it, vi } from "vitest";
import { EngineError, initSquads, type CoreEv, type EventEnvelope } from "@seazn/engine/core";
import type { AnySportModule } from "@seazn/engine/sport";
import { makeEnvelope } from "@seazn/engine/testkit";
import { propsOf, renderIsland, textOf } from "@/components/__tests__/_hook-harness";
import { foldMatch } from "@seazn/engine/core";
import { canAmendRow, partialBadge, type ActivityEvent } from "../activity";
import { ChoiceDock, choiceController } from "../detail-dock";
import { admitsTap, amendPlan, dockFor, isPartialDockAnswer, softCommitPlan, takeBackAction } from "../pad-host";
import { hockeySkinV3, hockeySpec } from "../skins/hockey";
import { icehockeySkinV3, icehockeySpec } from "../skins/icehockey";
import type { PeriodSkinSpec } from "../skins/period-shared";
import type { DockChip, DockSpec, PadHostView, SkinDefV3, TileSpec } from "../types";
import {
  foldPeriod,
  hockey,
  icehockey,
  lineupsFor,
  periodCfg,
  shippedVariantCfgs,
  summaryOf,
  type PeriodStateLike,
} from "./_period-fold";

const T = (key: string, vars?: Record<string, string | number>): string =>
  vars === undefined ? key : `${key}(${Object.keys(vars).sort().join(",")})`;

/** The rule rows, by sport key: true where the federation's ranking reads a goal's type (HK-TB-2, FIH GTR App. 3).
 *  The same table the engine's own `sports/period/goal-kind-required.test.ts` reads; IIHF ranks on no goal type. */
const GOAL_TYPE_RANKS: Readonly<Record<string, true>> = { hockey: true };

interface Sport {
  readonly key: "hockey" | "icehockey";
  readonly module: AnySportModule;
  readonly skin: SkinDefV3<PadHostView>;
  readonly spec: PeriodSkinSpec;
}

const SPORTS: readonly Sport[] = [
  { key: "hockey", module: hockey as AnySportModule, skin: hockeySkinV3(T), spec: hockeySpec },
  { key: "icehockey", module: icehockey as AnySportModule, skin: icehockeySkinV3(T), spec: icehockeySpec },
];
const FIH = SPORTS[0]!;
const IIHF = SPORTS[1]!;

/** A view exactly as `pad-host.tsx` builds it (period-pair.test.ts's `viewFor`): the fold's own state and the module's
 *  own summary, the host's own squad fallback. */
function viewFor(sport: Sport, cfg: unknown, state: PeriodStateLike, band = 3): PadHostView {
  const squads = (state.squads ?? initSquads(lineupsFor(sport.module, cfg))) as PadHostView["squads"];
  const names: Record<string, string> = {};
  for (const side of ["home", "away"] as const) {
    for (const member of squads[side].members) names[member.personId] = `Name ${member.personId}`;
  }
  return {
    cfg,
    state,
    summary: summaryOf(sport.module, state),
    phase: "live",
    band: band as PadHostView["band"],
    entitlements: {},
    personNames: names,
    squads,
    events: [],
    contextOverrides: {},
    stageKind: null,
    canOrganise: true,
    entrantNames: {},
  };
}

/** The strict write verdict BY NAME — `phaseVerdict` folds every refusal but WRONG_PHASE into "other", which cannot
 *  tell this task's refusal from any other. `null` = accepted. */
function writeCode(module: AnySportModule, state: PeriodStateLike, type: string, payload: Record<string, unknown>): string | null {
  const envelope = makeEnvelope(999, { type, payload }) as EventEnvelope<never | CoreEv>;
  try {
    (module as { apply(s: unknown, e: unknown, ctx: unknown): unknown }).apply(state, envelope, { strict: true });
    return null;
  } catch (error) {
    if (error instanceof EngineError) return error.code;
    throw error;
  }
}

function goalTile(sport: Sport, view: PadHostView, side: "home" | "away" = "home"): { type: string; payload: Record<string, unknown> } {
  const tile = sport.skin.tiles(view).find((t2: TileSpec) => t2.id === `goal-${side}`);
  if (tile === undefined || !("event" in tile.action)) throw new Error(`${sport.key}: no goal-${side} tile`);
  return { type: tile.action.event.type, payload: tile.action.event.payload as Record<string, unknown> };
}

/** What the choice dock must offer, from the cfg alone: every kind the cfg declares except `og`, in the cfg's own
 *  order, then the Own goal FLAG when the cfg declares `og` (it moves the goal to the other side, so it keeps the
 *  existing flag control rather than becoming a fourth pill). */
function expectedChoiceIds(cfg: unknown): string[] {
  const kinds = (cfg as { goalKinds: string[] }).goalKinds;
  return [...kinds.filter((k) => k !== "og").map((k) => `kind:${k}`), ...(kinds.includes("og") ? ["ownGoal"] : [])];
}

describe("W2d T18 — the skin's goalKindRequired mirror is the engine's refusal, and the rule row's", () => {
  it("each period skin declares the choice exactly where a strict untyped goal is refused GOAL_KIND_REQUIRED", () => {
    let checked = 0;
    for (const sport of SPORTS) {
      // The skin declares what the rule row says…
      expect(sport.spec.rules.goalKindRequired, `${sport.key}: rule row vs skin`).toBe(GOAL_TYPE_RANKS[sport.key] === true);
      for (const { variant, cfg } of shippedVariantCfgs(sport.module)) {
        const state = foldPeriod(sport.module, cfg, [["core.start"]]);
        // …and the engine refuses exactly there (a mirror owes a test that reads the real module).
        const code = writeCode(sport.module, state, `${sport.key}.goal`, { by: "H" });
        expect(code === "GOAL_KIND_REQUIRED", `${sport.key}/${variant}: engine vs skin`).toBe(sport.spec.rules.goalKindRequired);
        checked++;
      }
    }
    expect(checked, "no shipped variant was folded").toBeGreaterThanOrEqual(2);
  });
});

describe("W2d T18 — hockey: the goal tap opens a choice, and nothing is queued until one is made", () => {
  it("every shipped variant, every band: the goal tile's dock is a CHOICE of the cfg's kinds, Field goal first, plus the Own goal flag", () => {
    let checked = 0;
    for (const { variant, cfg } of shippedVariantCfgs(FIH.module)) {
      const state = foldPeriod(FIH.module, cfg, [["core.start"]]);
      for (const band of [0, 1, 2, 3] as const) {
        const view = viewFor(FIH, cfg, state, band);
        for (const side of ["home", "away"] as const) {
          const tap = goalTile(FIH, view, side);
          const dock = dockFor(FIH.skin, tap.type, view, tap.payload);
          expect(dock, `${variant}/b${band}/${side}`).not.toBeNull();
          expect(dock!.requires, `${variant}/b${band}/${side}`).toBe("kind");
          expect(dock!.chips.map((c) => c.id), `${variant}/b${band}/${side}`).toEqual(expectedChoiceIds(cfg));
          // FIH's own default kind is the first answer offered (owner option A: "Field goal" is the first chip).
          expect(dock!.chips[0]!.id).toBe("kind:fg");
          expect(dock!.title).toBe("pad.hockey.dock.goal.kind.title");
          expect(softCommitPlan(dock, tap.payload), `${variant}/b${band}/${side}`).toBe("choose");
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThanOrEqual(8);
  });

  it("the bare tap is refused GOAL_KIND_REQUIRED, and each choice completes it into a goal the strict write path takes", () => {
    let chips = 0;
    for (const { variant, cfg } of shippedVariantCfgs(FIH.module)) {
      const state = foldPeriod(FIH.module, cfg, [["core.start"]]);
      const view = viewFor(FIH, cfg, state);
      const tap = goalTile(FIH, view);
      // Why the choice exists: the tap alone is the write the engine refuses.
      expect(writeCode(FIH.module, state, tap.type, tap.payload), variant).toBe("GOAL_KIND_REQUIRED");
      const dock = dockFor(FIH.skin, tap.type, view, tap.payload)!;
      for (const chip of dock.chips) {
        const chosen = chip.mutate(tap.payload);
        expect(typeof chosen.kind, `${variant}/${chip.id}: the choice set no kind`).toBe("string");
        expect(writeCode(FIH.module, state, tap.type, chosen), `${variant}/${chip.id}`).toBeNull();
        // The choice is made: re-planning the completed payload never asks again.
        expect(softCommitPlan(dockFor(FIH.skin, tap.type, view, chosen), chosen), `${variant}/${chip.id}`).not.toBe("choose");
        chips++;
      }
    }
    expect(chips).toBeGreaterThanOrEqual(4);
  });

  it("Own goal credits the OTHER side (FIH Rule 9.12) — the flag the dock already had, now one of the answers", () => {
    const cfg = periodCfg(FIH.module);
    const view = viewFor(FIH, cfg, foldPeriod(FIH.module, cfg, [["core.start"]]));
    const tap = goalTile(FIH, view, "home");
    const own = dockFor(FIH.skin, tap.type, view, tap.payload)!.chips.find((c) => c.id === "ownGoal")!;
    expect(own.kind).toBe("flag");
    const after = foldPeriod(FIH.module, cfg, [["core.start"], [tap.type, own.mutate(tap.payload)]]);
    expect(after.goals).toEqual({ home: 0, away: 1 });
  });

  it("after the choice the dock is the ordinary enrichment dock: no kind or own-goal chip again, the scorer at band 3, and it HOLDS", () => {
    const cfg = periodCfg(FIH.module);
    const state = foldPeriod(FIH.module, cfg, [["core.start"]]);
    let checked = 0;
    for (const band of [0, 1, 2, 3] as const) {
      const view = viewFor(FIH, cfg, state, band);
      const tap = goalTile(FIH, view);
      for (const chip of dockFor(FIH.skin, tap.type, view, tap.payload)!.chips) {
        const chosen = chip.mutate(tap.payload);
        const next = dockFor(FIH.skin, tap.type, view, chosen)!;
        expect(next.requires, `b${band}/${chip.id}`).toBeUndefined();
        expect(next.chips.filter((c) => c.id.startsWith("kind:") || c.id === "ownGoal").map((c) => c.id), `b${band}/${chip.id}`).toEqual([]);
        // The scorer is band 2+ (the same band gate the dock always had).
        expect(next.chips.some((c) => c.id.startsWith("person:")), `b${band}/${chip.id}`).toBe(band >= 2);
        expect(softCommitPlan(next, chosen), `b${band}/${chip.id}`).toBe("hold");
        // Every enrichment chip on the typed goal still folds strictly.
        for (const extra of next.chips) {
          expect(writeCode(FIH.module, state, tap.type, extra.mutate(chosen)), `b${band}/${chip.id}+${extra.id}`).toBeNull();
        }
        checked++;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(16);
  });

  it("the sequence: a second goal tap asks again — one goal's type never licenses the next", () => {
    const cfg = periodCfg(FIH.module);
    const first = goalTile(FIH, viewFor(FIH, cfg, foldPeriod(FIH.module, cfg, [["core.start"]])));
    const afterOne = foldPeriod(FIH.module, cfg, [["core.start"], [first.type, { ...first.payload, kind: "pc" }]]);
    expect(afterOne.goals).toEqual({ home: 1, away: 0 });
    const view = viewFor(FIH, cfg, afterOne);
    const second = goalTile(FIH, view, "away");
    expect(softCommitPlan(dockFor(FIH.skin, second.type, view, second.payload), second.payload)).toBe("choose");
    expect(writeCode(FIH.module, afterOne, second.type, second.payload)).toBe("GOAL_KIND_REQUIRED");
  });
});

describe("W2d T18 — ice hockey (IIHF) never asks: its goal type stays optional", () => {
  it("every shipped variant: the untyped goal holds as before, its kind chips are the cfg's minus fg and og, and the fold takes it", () => {
    let checked = 0;
    for (const { variant, cfg } of shippedVariantCfgs(IIHF.module)) {
      const state = foldPeriod(IIHF.module, cfg, [["core.start"]]);
      const view = viewFor(IIHF, cfg, state);
      const tap = goalTile(IIHF, view);
      const dock = dockFor(IIHF.skin, tap.type, view, tap.payload)!;
      expect(dock.requires, variant).toBeUndefined();
      expect(softCommitPlan(dock, tap.payload), variant).toBe("hold");
      const kinds = (cfg as { goalKinds: string[] }).goalKinds.filter((k) => k !== "fg" && k !== "og");
      expect(dock.chips.filter((c) => c.id.startsWith("kind:")).map((c) => c.id.slice(5)), variant).toEqual(kinds);
      expect(writeCode(IIHF.module, state, tap.type, tap.payload), variant).toBeNull();
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });
});

describe("W2d T18 — softCommitPlan, the one decision the host's dispatch makes", () => {
  const sets = (key: string, value: unknown): DockChip => ({ id: `${key}:${String(value)}`, label: "k", mutate: (p) => ({ ...p, [key]: value }) });

  it("no dock or an empty one sends; a dock with chips holds; an unmet requirement chooses; a met one holds", () => {
    expect(softCommitPlan(null, { by: "H" })).toBe("send");
    expect(softCommitPlan({ title: "t", chips: [] }, { by: "H" })).toBe("send");
    expect(softCommitPlan({ title: "t", chips: [sets("person", "p1")] }, { by: "H" })).toBe("hold");
    const choice: DockSpec = { title: "t", chips: [sets("kind", "fg")], requires: "kind" };
    expect(softCommitPlan(choice, { by: "H" })).toBe("choose");
    expect(softCommitPlan(choice, undefined)).toBe("choose");
    expect(softCommitPlan(choice, { by: "H", kind: "fg" })).toBe("hold");
  });

  it("a requirement no chip can answer is a skin defect, refused by name — never a dock the scorer cannot leave", () => {
    const trapped: DockSpec = { title: "t", chips: [sets("person", "p1")], requires: "kind" };
    expect(() => softCommitPlan(trapped, { by: "H" })).toThrow(/requires "kind".*no chip/);
    expect(() => softCommitPlan({ title: "t", chips: [], requires: "kind" }, { by: "H" })).toThrow(/requires "kind".*no chip/);
  });
});

describe("W2d T18 — the partial label reads the answers the TYPED goal's dock offers", () => {
  it("hockey: a typed goal with its scorer named is complete; without one at band 3 it is partial", () => {
    const cfg = periodCfg(FIH.module);
    const view = viewFor(FIH, cfg, foldPeriod(FIH.module, cfg, [["core.start"]]));
    const tap = goalTile(FIH, view);
    const scorer = view.squads.home.members.find((m) => m.onField)!.personId;
    expect(isPartialDockAnswer(FIH.skin, tap.type, { ...tap.payload, kind: "fg", person: scorer }, view)).toBe(false);
    expect(isPartialDockAnswer(FIH.skin, tap.type, { ...tap.payload, kind: "fg" }, view)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Fix round 1, I1 + m1 — a goal recorded BEFORE the requirement existed. A hockey match in progress at the deploy
// holds untyped goals; the read path folds them (B3: an untyped goal is a field goal) and the pad must show them as
// the ordinary goals they are. Marking one Partial offered the amendment, whose re-append is the ORIGINAL payload
// verbatim (`amendPlan`) — an untyped goal the strict write path now refuses, while its bound void survived the
// refusal. Driven through the pad's own chain: the real fold of a ledger that holds the legacy goal, the real skin
// (`isPartialDockAnswer`), the ledger panel's own badge and amend gates (`partialBadge`, `canAmendRow`), and the
// amendment's own plan folded the way `append-event.ts` appends it (`strictFromSeq` = the candidate).
// ---------------------------------------------------------------------------

describe("W2d T18 fix round 1 (I1, m1) — a legacy untyped hockey goal in the ledger is an ordinary goal on the pad", () => {
  /** The ledger as the pad's activity panel holds it, from real envelopes. */
  const rowsOf = (envelopes: readonly EventEnvelope[]): ActivityEvent[] =>
    envelopes.map((e) => ({ id: e.id, seq: e.seq, type: e.type, payload: e.payload, voids: e.voids ?? null }));
  /** The append the server makes: the whole stream, strict from the candidate only (`append-event.ts`). */
  const appendCode = (cfg: unknown, envelopes: readonly EventEnvelope[]): string | null => {
    try {
      foldMatch(FIH.module as never, cfg as never, lineupsFor(FIH.module, cfg), envelopes as never, { strictFromSeq: envelopes.length - 1 });
      return null;
    } catch (error) {
      if (error instanceof EngineError) return error.code;
      throw error;
    }
  };

  it("with or without its scorer, at every band: no Partial badge and no amendment — and the verbatim re-append it would have made IS the refused write", () => {
    const cfg = periodCfg(FIH.module);
    let checked = 0;
    for (const band of [0, 1, 2, 3] as const) {
      const atStart = viewFor(FIH, cfg, foldPeriod(FIH.module, cfg, [["core.start"]]), band);
      const scorer = atStart.squads.home.members.find((m) => m.onField)!.personId;
      for (const legacy of [{ by: "H" }, { by: "H", person: scorer }]) {
        const ledger = [makeEnvelope(0, { type: "core.start", payload: {} }), makeEnvelope(1, { type: "hockey.goal", payload: legacy })];
        // The read path folds it, and it is a goal.
        const state = foldPeriod(FIH.module, cfg, [["core.start"], ["hockey.goal", legacy]]);
        expect(state.goals, `b${band}`).toEqual({ home: 1, away: 0 });
        const view = viewFor(FIH, cfg, state, band);
        const isPartial = (type: string, payload: Record<string, unknown>) => isPartialDockAnswer(FIH.skin, type, payload, view);
        const rows = rowsOf(ledger);
        const own = new Set(rows.map((r) => r.id));
        const goal = rows[1]!;
        const label = `b${band}/${JSON.stringify(legacy)}`;
        expect(isPartial(goal.type, legacy), label).toBe(false);
        expect(partialBadge(goal, rows, own, null, null, true, isPartial), label).toBe("none");
        expect(canAmendRow(goal, rows, own, null, null, true, isPartial(goal.type, legacy)), label).toBe(false);
        // Why it must stay closed: the amendment's own plan re-appends this payload verbatim, behind its void, and
        // the server refuses exactly that re-append while the void alone would land.
        const plan = amendPlan(goal.id, ledger)!;
        const voided = [...ledger, makeEnvelope(2, { type: "core.void", payload: { event_id: plan.voidId } }, plan.voidId)];
        expect(appendCode(cfg, voided), `${label}: the void alone is accepted`).toBeNull();
        expect(appendCode(cfg, [...voided, makeEnvelope(3, { type: plan.type, payload: plan.payload })]), label).toBe("GOAL_KIND_REQUIRED");
        checked++;
      }
    }
    expect(checked).toBe(8);
  });

  it("the positive pair: a TYPED goal missing its scorer at band 3 is still Partial and amendable, and its amendment lands under strict", () => {
    const cfg = periodCfg(FIH.module);
    const typed = { by: "H", kind: "pc" };
    const ledger = [makeEnvelope(0, { type: "core.start", payload: {} }), makeEnvelope(1, { type: "hockey.goal", payload: typed })];
    const view = viewFor(FIH, cfg, foldPeriod(FIH.module, cfg, [["core.start"], ["hockey.goal", typed]]), 3);
    const isPartial = (type: string, payload: Record<string, unknown>) => isPartialDockAnswer(FIH.skin, type, payload, view);
    const rows = rowsOf(ledger);
    const own = new Set(rows.map((r) => r.id));
    expect(isPartial("hockey.goal", typed)).toBe(true);
    expect(partialBadge(rows[1]!, rows, own, null, null, true, isPartial)).not.toBe("none");
    expect(canAmendRow(rows[1]!, rows, own, null, null, true, true)).toBe(true);
    const plan = amendPlan(rows[1]!.id, ledger)!;
    const scorerChip = dockFor(FIH.skin, plan.type, view, plan.payload)!.chips.find((c) => c.id.startsWith("person:"))!;
    const voided = [...ledger, makeEnvelope(2, { type: "core.void", payload: { event_id: plan.voidId } }, plan.voidId)];
    // Both the answered and the unanswered (drained) re-append are typed, so both land.
    expect(appendCode(cfg, [...voided, makeEnvelope(3, { type: plan.type, payload: scorerChip.mutate(plan.payload) })])).toBeNull();
    expect(appendCode(cfg, [...voided, makeEnvelope(3, { type: plan.type, payload: plan.payload })])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Fix round 1, m2 + m3 — what the pad's other controls do while the question is open. Owner option A: nothing is
// queued until a type is chosen, and Cancel is the ONE way to drop the goal. So the question is MODAL: another tap is
// not recorded and the pad says so (the house "that tap did not stick" banner), the question stays open, and "Take
// back" — the scorer's habit for undoing the last tap — takes back the question, never the goal before it. Driven as
// SEQUENCES over the host's own decisions (`admitsTap`, `takeBackAction`, `softCommitPlan`) with the real skin's
// tiles and docks; the host's wiring of them is the browser's (`e2e/scorepad-v3-hockey-goal-type.spec.ts`).
// ---------------------------------------------------------------------------

describe("W2d T18 fix round 1 (m2, m3) — the open question is modal: Take back cancels it, another tap is refused, Cancel is the only drop", () => {
  /** The host's state, modelled exactly as `pad-host.tsx` keeps it: the open question, the queue, the recorded log. */
  interface Host {
    question: { type: string; payload: Record<string, unknown> } | null;
    queued: { type: string; payload: Record<string, unknown> }[];
    refused: number;
  }
  const cfg = periodCfg(FIH.module);
  const view = viewFor(FIH, cfg, foldPeriod(FIH.module, cfg, [["core.start"], ["hockey.goal", { by: "H", kind: "pc" }]]));
  /** The prior goal the ribbon's Take back would void — a stand-in for `ribbonUndoTarget`'s own answer. */
  const PRIOR = { kind: "void", eventId: "e-1" } as const;
  const tap = (host: Host, type: string, payload: Record<string, unknown>): void => {
    if (!admitsTap(host.question !== null)) {
      host.refused++;
      return;
    }
    const plan = softCommitPlan(dockFor(FIH.skin, type, view, payload), payload);
    if (plan === "choose") host.question = { type, payload };
    else host.queued.push({ type, payload });
  };
  const answer = (host: Host, chipId: string): void => {
    const q = host.question!;
    const chip = dockFor(FIH.skin, q.type, view, q.payload)!.chips.find((c) => c.id === chipId)!;
    host.question = null;
    const payload = chip.mutate(q.payload);
    expect(softCommitPlan(dockFor(FIH.skin, q.type, view, payload), payload), "the answer is never asked again").not.toBe("choose");
    host.queued.push({ type: q.type, payload });
  };
  const goal = goalTile(FIH, view, "away");
  const advance = FIH.skin.tiles(view).find((t2: TileSpec) => t2.id === "advance");

  it("m2: Take back while the question is open cancels the QUESTION — the goal before it is not voided — and with no question open it is the ordinary undo", () => {
    const host: Host = { question: null, queued: [], refused: 0 };
    expect(takeBackAction(host.question !== null, PRIOR), "no question: Take back undoes the last recorded event").toEqual({ kind: "undo", target: PRIOR });
    tap(host, goal.type, goal.payload);
    expect(host.question, "the goal tap asks").not.toBeNull();
    const action = takeBackAction(host.question !== null, PRIOR);
    expect(action, "an open question: Take back takes back the question").toEqual({ kind: "cancel-question" });
    host.question = null;
    expect(host.queued, "nothing was ever queued, and the prior goal was not touched").toEqual([]);
    // With nothing left to undo, an open question still offers Take back (it cancels the question).
    tap(host, goal.type, goal.payload);
    expect(takeBackAction(host.question !== null, null)).toEqual({ kind: "cancel-question" });
    expect(takeBackAction(false, null), "nothing open, nothing to undo: no control").toBeNull();
  });

  it("m3: a second tap while the question is open is refused (not recorded, and said so) and the question survives; answered, the goal lands and the next tap is taken", () => {
    if (advance === undefined || !("event" in advance.action)) throw new Error("premise: hockey's advance tile dispatches an event directly");
    const advanceEvent = advance.action.event as { type: string; payload: Record<string, unknown> };
    const host: Host = { question: null, queued: [], refused: 0 };
    tap(host, goal.type, goal.payload);
    tap(host, advanceEvent.type, advanceEvent.payload);
    tap(host, goal.type, { ...goal.payload, by: "H" });
    expect(host.refused, "both taps were refused while the question was open").toBe(2);
    expect(host.question, "the question is still the first goal's — never replaced, never dropped").toEqual({ type: goal.type, payload: goal.payload });
    expect(host.queued).toEqual([]);
    answer(host, "kind:stroke");
    expect(host.queued).toEqual([{ type: goal.type, payload: { ...goal.payload, kind: "stroke" } }]);
    tap(host, advanceEvent.type, advanceEvent.payload);
    expect(host.refused, "with the question answered, the next tap is taken").toBe(2);
    expect(host.queued.map((q) => q.type)).toEqual([goal.type, advanceEvent.type]);
    expect(admitsTap(false)).toBe(true);
    expect(admitsTap(true)).toBe(false);
  });
});

describe("W2d T18 — ChoiceDock: the renderer for an answer the event cannot be sent without", () => {
  const chip = (id: string, kind?: "flag"): DockChip => ({ id, label: `k.${id}`, ...(kind ? { kind } : {}), mutate: (p) => ({ ...p, kind: id }) });
  const spec: DockSpec = { title: "What kind of goal?", chips: [chip("kind:fg"), chip("kind:pc"), chip("ownGoal", "flag")], requires: "kind" };
  const t = (key: string) => `T:${key}`;

  it("renders the question and every answer, NO countdown and NO send-now control, and a Cancel that sends nothing", () => {
    const onChoose = vi.fn();
    const onCancel = vi.fn();
    const island = renderIsland(ChoiceDock, { spec, t, onChoose, onCancel });
    const buttons = island.tree().filter((el) => el.type === "button");
    const ids = buttons.map((el) => String(propsOf(el)["data-testid"] ?? ""));
    expect(ids).toEqual(["pad-dock-chip-kind:fg", "pad-dock-chip-kind:pc", "pad-dock-chip-ownGoal", "pad-dock-cancel"]);
    const text = island.text();
    expect(text).toContain("What kind of goal?");
    expect(text).toContain("T:pad.dock.choice.hint");
    expect(text, "a choice has no hold window to count down").not.toContain("pad.dock.clears");
    expect(ids, "the X means SEND NOW elsewhere; here nothing is held to send").not.toContain("pad-send-now");
    const cancel = buttons.find((el) => propsOf(el)["data-testid"] === "pad-dock-cancel")!;
    expect(textOf(cancel)).toBe("T:pad.dock.choice.cancel");
    (propsOf(cancel).onClick as () => void)();
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onChoose).not.toHaveBeenCalled();
  });

  it("a chip tap hands that chip to onChoose exactly once — a double tap, or a second answer, cannot queue two goals", () => {
    const onChoose = vi.fn();
    const island = renderIsland(ChoiceDock, { spec, t, onChoose, onCancel: vi.fn() });
    const press = (id: string) => {
      const button = island.tree().find((el) => el.type === "button" && propsOf(el)["data-testid"] === `pad-dock-chip-${id}`)!;
      // A chosen chip renders inert (no handler, `dockChipButton`), exactly as a browser click on it does nothing.
      const onClick = propsOf(button).onClick as (() => void) | undefined;
      if (onClick !== undefined) onClick();
      return onClick !== undefined;
    };
    expect(press("kind:pc")).toBe(true);
    expect(press("kind:pc"), "the chosen chip still takes taps").toBe(false);
    // A DIFFERENT answer is live on screen, so only the claim stands between it and a second goal.
    expect(press("kind:fg")).toBe(true);
    expect(onChoose).toHaveBeenCalledTimes(1);
    expect((onChoose.mock.calls[0]![0] as DockChip).id).toBe("kind:pc");
  });

  it("choiceController claims SYNCHRONOUSLY: two taps fired back to back without a render between them choose once", () => {
    const controller = choiceController();
    expect(controller.claim("kind:fg", spec)?.id).toBe("kind:fg");
    expect(controller.claim("kind:pc", spec)).toBeNull();
    expect(controller.claim("kind:fg", spec)).toBeNull();
    // An unknown id never claims: the real answer that follows still lands.
    const second = choiceController();
    expect(second.claim("nope", spec)).toBeNull();
    expect(second.claim("ownGoal", spec)?.id).toBe("ownGoal");
  });
});
