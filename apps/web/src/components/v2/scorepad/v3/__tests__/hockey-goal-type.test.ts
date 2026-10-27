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
import { ChoiceDock, choiceController } from "../detail-dock";
import { dockFor, isPartialDockAnswer, softCommitPlan } from "../pad-host";
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
      expect(sport.spec.goalKindRequired === true, `${sport.key}: rule row vs skin`).toBe(GOAL_TYPE_RANKS[sport.key] === true);
      for (const { variant, cfg } of shippedVariantCfgs(sport.module)) {
        const state = foldPeriod(sport.module, cfg, [["core.start"]]);
        // …and the engine refuses exactly there (a mirror owes a test that reads the real module).
        const code = writeCode(sport.module, state, `${sport.key}.goal`, { by: "H" });
        expect(code === "GOAL_KIND_REQUIRED", `${sport.key}/${variant}: engine vs skin`).toBe(sport.spec.goalKindRequired === true);
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
  it("hockey: a typed goal with its scorer named is complete; without one at band 3 it is partial; an untyped (legacy) one is partial", () => {
    const cfg = periodCfg(FIH.module);
    const view = viewFor(FIH, cfg, foldPeriod(FIH.module, cfg, [["core.start"]]));
    const tap = goalTile(FIH, view);
    const scorer = view.squads.home.members.find((m) => m.onField)!.personId;
    expect(isPartialDockAnswer(FIH.skin, tap.type, { ...tap.payload, kind: "fg", person: scorer }, view)).toBe(false);
    expect(isPartialDockAnswer(FIH.skin, tap.type, { ...tap.payload, kind: "fg" }, view)).toBe(true);
    expect(isPartialDockAnswer(FIH.skin, tap.type, { ...tap.payload, person: scorer }, view)).toBe(true);
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
