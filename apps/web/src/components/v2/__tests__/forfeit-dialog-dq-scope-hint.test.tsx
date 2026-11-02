// Ruling 258 (owner, 2026-11-02): the owner chose the reason "disqualified" in a match's forfeit dialog and the player was
// paired again in round 2 - that reason is an award on THIS match; removing a player from the event is Entrants'
// Disqualify. So the dialog says so, as one line under the reasons, and only while "disqualified" is the chosen reason.
//
// The hint depends on the dialog's own selection state, which `renderToStaticMarkup` can never reach (no clicks), so this
// drives the real dialog through `_hook-harness.tsx`'s `renderIsland`: the real `forfeit-who-*` and `forfeit-why-*`
// handlers, then reads the tree. Both directions are asserted: present only for the disqualification, absent for every
// other reason and before a reason is chosen, and gone again when the choice moves off it.
//
// The sweep is over the sport registry: which reasons a sport's dialog OFFERS comes from the engine's own admission
// (`forfeitAdmission`, through `forfeitDialogModel`), never a list typed here, and every sport is checked.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { foldMatch, type EventEnvelope } from "@seazn/engine/core";
import { builtinModules } from "@seazn/engine/sports";
import { defaultLineupPair, makeEnvelope, onePlayEvent } from "@seazn/engine/testkit";
import { ForfeitDialog, forfeitBaseState, forfeitDialogModel, forfeitPlayRecorded, type ForfeitWho } from "@/components/v2/forfeit-dialog";
import { propsOf, renderIsland, textOf } from "@/components/__tests__/_hook-harness";
import { LOCALES } from "@/lib/i18n-constants";
import { msg } from "@/lib/messages";
import { t } from "@/lib/i18n-runtime";
import en from "@/dictionaries/en/ui.json";
import es from "@/dictionaries/es/ui.json";
import fr from "@/dictionaries/fr/ui.json";
import nl from "@/dictionaries/nl/ui.json";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

const HINT = "forfeit-dq-scope-hint";
/** The sentence the ruling signs, typed here - never read back from the product. */
const SIGNED_EN = "This decides this match only. To remove the player from the event, use Disqualify in Entrants.";

beforeEach(() => {
  // The dialog registers its keydown trap on `document` in an effect (fixture-console-forfeit-hooks.test.tsx's stub).
  vi.stubGlobal("document", { addEventListener: () => {}, removeEventListener: () => {}, activeElement: null });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const byTestid = (tree: ReactElement[], testid: string) => tree.filter((e) => propsOf(e)["data-testid"] === testid);
const click = (el: ReactElement | undefined) => (propsOf(el!).onClick as () => void)();
const choose = (el: ReactElement | undefined) => (propsOf(el!).onChange as () => void)();

/** Where the match stands when the organiser opens the dialog: before Start, after a bare Start, after something is played
 *  (ruling 112/113 - which reasons a side is offered turns on exactly this). */
type Shape = "scheduled" | "started" | "played";
const START = makeEnvelope(1, { type: "core.start", payload: {} });

function openDialog(module: (typeof builtinModules)[number], shape: Shape) {
  const cfg = module.configSchema.parse(Object.values(module.variants)[0] ?? {});
  const lineups = defaultLineupPair(module.positions);
  let ledger: EventEnvelope[] = [];
  if (shape !== "scheduled") ledger = [START];
  if (shape === "played") {
    // The sport's own generator draws the played event - never a typed one.
    const play = onePlayEvent(module, cfg, lineups, [START]);
    if (play === null) return null;
    ledger = [START, play];
  }
  const state = ledger.length === 0 ? null : foldMatch(module, cfg, lineups, ledger);
  const rows = ledger.map((e) => ({ id: e.id, seq: e.seq, type: e.type, voids_event_id: e.voids ?? null }));
  const model = forfeitDialogModel(module, cfg, forfeitBaseState(module, cfg, state, lineups), {
    noNextMatch: false,
    playRecorded: forfeitPlayRecorded(rows, module),
  });
  const island = renderIsland(ForfeitDialog, {
    msg,
    model,
    home: { id: "h", name: "Home Side" },
    away: { id: "a", name: "Away Side" },
    forfeit: async () => ({ ok: true as const }),
    onClose: () => {},
    onRefused: () => {},
  });
  const tree = () => island.tree();
  const side = (w: ForfeitWho) => click(byTestid(tree(), `forfeit-who-${w}`)[0]);
  const reason = (r: string) => choose(byTestid(tree(), `forfeit-why-${r}`)[0]);
  const hint = () => byTestid(tree(), HINT);
  return { model, tree, side, reason, hint };
}

function open(module: (typeof builtinModules)[number], shape: Shape) {
  const d = openDialog(module, shape);
  if (d === null) throw new Error(`${module.key}: no ${shape} shape`);
  return d;
}

const generic = builtinModules.find((m) => m.key === "generic")!;

describe("the forfeit dialog says a disqualification reason decides this match only (ruling 258)", () => {
  it("generic: absent before a side, absent for the walkover, present for the disqualification, gone again when the choice moves", () => {
    // single-sport: the state sequence; the sport sweep below carries the registry.
    const d = open(generic, "started");
    expect(d.model.why("home"), "premise: after a bare Start the dialog offers the walkover beside the disqualification").toEqual(["walkover", "disqualified"]);

    expect(d.hint(), "no side chosen: no reasons, no hint").toHaveLength(0);
    d.side("home");
    expect(byTestid(d.tree(), "forfeit-why-disqualified"), "premise: the reasons are on screen").toHaveLength(1);
    expect(d.hint(), "a side chosen, no reason yet").toHaveLength(0);

    d.reason("walkover");
    expect(d.hint(), "the walkover is not a disqualification").toHaveLength(0);

    d.reason("disqualified");
    const shown = d.hint();
    expect(shown, "the disqualification names its scope").toHaveLength(1);
    expect(shown[0]!.type).toBe("p");
    expect(textOf(shown[0]!)).toBe(SIGNED_EN);
    expect(propsOf(byTestid(d.tree(), "forfeit-why-disqualified")[0]!).checked, "premise: the reason really is the chosen one").toBe(true);

    d.reason("walkover");
    expect(d.hint(), "moving the choice off the disqualification takes the hint with it").toHaveLength(0);

    // The sequence the other way: a side change keeps a reason the new side is also offered (pickForfeit), and the hint with it.
    d.reason("disqualified");
    expect(d.hint()).toHaveLength(1);
    d.side("away");
    expect(propsOf(byTestid(d.tree(), "forfeit-why-disqualified")[0]!).checked, "premise: the away side kept the reason").toBe(true);
    expect(d.hint(), "same reason, other side: still the scope line").toHaveLength(1);
  });

  it("after play (the retirement is on offer): the retirement shows no hint, the disqualification does", () => {
    // single-sport: generic is the one sport whose generator the hooks suite draws a played event from; the sweep below
    // covers the reasons every sport offers before play.
    const played = open(generic, "played");
    played.side("home");
    expect(played.model.why("home"), "premise: after play a side may retire or be disqualified").toEqual(["retired", "disqualified"]);
    played.reason("retired");
    expect(played.hint(), "the retirement decides this match too, and it is not a disqualification").toHaveLength(0);
    played.reason("disqualified");
    expect(played.hint()).toHaveLength(1);
  });

  it("every sport, in every match shape: the hint shows exactly while the disqualification is the chosen reason, for every reason the engine offers", () => {
    let sports = 0;
    let dialogs = 0;
    let withDq = 0;
    let reasonsChecked = 0;
    for (const m of builtinModules) {
      sports++;
      let shapes = 0;
      for (const shape of ["scheduled", "started", "played"] as const) {
        const d = openDialog(m, shape);
        if (d === null) continue; // the sport's generator draws no event after a bare Start: no "played" shape to open
        shapes++;
        dialogs++;
        for (const w of ["home", "away"] as const) {
          const offered = d.model.why(w);
          if (offered.length === 0) continue;
          d.side(w);
          for (const r of offered) {
            d.reason(r);
            expect(d.hint(), `${m.key} ${shape} ${w} ${r}`).toHaveLength(r === "disqualified" ? 1 : 0);
            reasonsChecked++;
          }
          if (offered.includes("disqualified")) withDq++;
        }
      }
      expect(shapes, `${m.key}: at least the scheduled and the started dialog open`).toBeGreaterThanOrEqual(2);
    }
    expect(sports, `sports checked: ${sports}`).toBe(builtinModules.length);
    expect(sports).toBeGreaterThan(1);
    expect(dialogs, `dialogs opened: ${dialogs}`).toBeGreaterThanOrEqual(sports * 2);
    expect(withDq, `sides offered the disqualification: ${withDq}`).toBeGreaterThan(sports);
    expect(reasonsChecked, `reasons checked: ${reasonsChecked}`).toBeGreaterThan(sports * 2);
  });

  it("the sentence ships in all four locales, none left on English, and names the Disqualify control in that locale's words", () => {
    expect((en as Record<string, string>)["forfeitDialog.dqScopeHint"]).toBe(SIGNED_EN);
    const dicts = { en, es, fr, nl } as Record<string, Record<string, string>>;
    const seen = LOCALES.map((l) => t(dicts[l]!, "forfeitDialog.dqScopeHint"));
    for (const [i, v] of seen.entries()) {
      expect(v, `${LOCALES[i]} is missing forfeitDialog.dqScopeHint`).toBeTruthy();
      expect(v, `${LOCALES[i]} renders the key itself`).not.toBe("forfeitDialog.dqScopeHint");
    }
    expect(new Set(seen).size, `two locales share the hint: ${JSON.stringify(seen)}`).toBe(LOCALES.length);
    // The line points at a control that exists: the row button's label is the word the hint tells the organiser to use.
    for (const l of LOCALES) {
      const word = dicts[l]!["entrants.row.disqualify"]!;
      expect(word, `${l}: the row control is worded`).toBeTruthy();
      expect(dicts[l]!["forfeitDialog.dqScopeHint"], `${l}: the hint names the control by its label`).toContain(word);
      expect(dicts[l]!["forfeitDialog.dqScopeHint"], `${l}: the hint names the Entrants tab by its label`).toContain(dicts[l]!["div.detail.tab.entrants"]!);
    }
  });
});
