// RS006 fix wave finding #1 (MEDIUM) — entry-details.tsx's form_fields
// onChange handler used to build the WHOLE next `answers` object by
// spreading `entry.answers` (a RENDER-time prop closure) at the call site,
// then dispatch a single coarse action the reducer applied by REPLACING the
// entry's answers wholesale. Two onChange events firing off the SAME render
// (a React 18 transition, an autofill event, a future "clear all" control)
// both close over the SAME pre-first-write `entry`, so the second dispatch's
// payload silently drops whatever the first one wrote — no error, just a
// lost answer. cart.ts's own header already documents why REMOVE_PLAYER/
// UPDATE_PLAYER are fine-grained for exactly this reason; SET_ANSWERS was
// the one coarse action left.
//
// This suite exercises the REAL bug, not a reducer-only proxy for it: a
// pure `cartReducer` test cannot see this class of bug at all (the reducer
// was never wrong — REPLACE is a correct primitive for a correctly-built
// payload; the defect is entirely in what the CALLER built). So this
// captures entry-details.tsx's onChange handler off ONE render (matching
// "no intervening render"), fires it twice for different keys, and folds
// the dispatched actions through the real cartReducer the way
// register-stepper.tsx's own `dispatchCart` does (`setCart((prev) =>
// cartReducer(prev, action))` — sequential, against the reducer's own
// state, never a component closure).
//
// EntryDetails has no hooks of its own besides the mocked (non-hook) useT
// (register-stepper-interaction.test.tsx's own precedent for DivisionCard/
// EntryDetails), so it's called directly — no renderIsland, no jsdom (this
// workspace has none, _hook-harness.tsx's own header).
import { describe, expect, it, vi } from "vitest";
import { propsOf, walk } from "@/components/__tests__/_hook-harness";
import { cartReducer, type CartAction } from "../cart";
import { EntryDetails } from "../entry-details";
import { FormFields } from "../form-fields";
import { RosterTable } from "../roster-table";
import { EMPTY_CONTACT, EMPTY_ROSTER_PLAYER, type CartEntry, type CartState, type DivisionLike } from "../types";

vi.mock("@/components/i18n/dict-provider", () => ({
  useT: () => (key: string) => key,
}));

const DIVISION: DivisionLike = {
  division_id: "div-team",
  name: "Open Teams",
  entrant_kind: "team",
  category: null,
  age_min: null,
  age_max: null,
  requires_dob: false,
  requires_gender: false,
  allow_free_agents: true,
  open: true,
  closed_reason: null,
  capacity: null,
  remaining: null,
  taken: 0,
  opens_at: null,
  closes_at: null,
  fee_cents: 0,
  free_agent_fee_cents: null,
  currency: "USD",
  payment_method: "offline",
  form_fields: [
    { key: "shirt_size", label: "Shirt size", kind: "text", required: false },
    { key: "court_rules_ack", label: "Court rules acknowledged", kind: "checkbox", required: false },
  ],
};

function makeEntry(overrides: Partial<CartEntry> = {}): CartEntry {
  return {
    id: "e1",
    division_id: "div-team",
    entrant_kind: "team",
    team_name: null,
    partner_name: null,
    free_agent: false,
    players: [],
    answers: {},
    registering_self: false,
    self_player_index: null,
    ...overrides,
  };
}

/** Renders EntryDetails ONCE, captures whatever `dispatch` actions its
 *  form_fields onChange handler emits (no intervening render between
 *  onChange calls — the whole point of this suite), and folds them through
 *  the real reducer sequentially, exactly as `setCart(prev => cartReducer
 *  (prev, action))` does in register-stepper.tsx. */
function fireTwoAnswerChanges(entry: CartEntry): CartState {
  const actions: CartAction[] = [];
  const dispatch = (action: CartAction) => actions.push(action);

  const tree = walk(
    EntryDetails({
      entry,
      division: DIVISION,
      contact: EMPTY_CONTACT,
      isSelfEntry: false,
      selfPlayerIndex: null,
      seasonStartYear: 2026,
      dispatch,
      importText: "",
      onImportTextChange: () => {},
    }),
  );
  const formFieldsEl = tree.find((el) => el.type === FormFields);
  expect(formFieldsEl, "FormFields not found in EntryDetails' output").toBeTruthy();
  const onChange = propsOf(formFieldsEl!).onChange as (key: string, value: string | boolean) => void;

  // Both calls read the SAME closed-over `entry` (this is "no intervening
  // render" — EntryDetails was invoked exactly once above).
  onChange("shirt_size", "L");
  onChange("court_rules_ack", true);

  let state: CartState = { entries: [entry] };
  for (const action of actions) state = cartReducer(state, action);
  return state;
}

describe("EntryDetails' form_fields onChange -> cartReducer — no intervening render (fix wave finding #1)", () => {
  it("both answers survive when two different keys change before a re-render", () => {
    const state = fireTwoAnswerChanges(makeEntry({ answers: {} }));
    expect(state.entries[0]!.answers).toEqual({ shirt_size: "L", court_rules_ack: true });
  });

  it("still merges against PRE-EXISTING answers already on the entry (not just two fresh writes)", () => {
    const state = fireTwoAnswerChanges(makeEntry({ answers: { pre_existing: "kept" } }));
    expect(state.entries[0]!.answers).toEqual({
      pre_existing: "kept",
      shirt_size: "L",
      court_rules_ack: true,
    });
  });
});

// RS006 follow-up — the self picker is REQUIRED whenever it renders (an
// unresolved `self_player_index` blocks step 3's Next, validation.ts), but
// it had no error state of its own. "None of these" is its default and
// reads like a valid answer, so a registrant with a complete roster met a
// dead Next button, no field marked, and only a step-wide "fill in the
// missing details above" to go on. Silent abandonment the organiser never
// hears about.
describe("EntryDetails — the self-row picker says when it is the thing blocking Next", () => {
  function renderSelfEntry(selfPlayerIndex: number | null) {
    return walk(
      EntryDetails({
        entry: makeEntry({
          registering_self: true,
          self_player_index: selfPlayerIndex,
          players: [
            { ...EMPTY_ROSTER_PLAYER, full_name: "Priya Raman" },
            { ...EMPTY_ROSTER_PLAYER, full_name: "Arun Menon" },
          ],
        }),
        division: DIVISION,
        contact: EMPTY_CONTACT,
        isSelfEntry: true,
        selfPlayerIndex,
        seasonStartYear: 2026,
        dispatch: () => {},
        importText: "",
        onImportTextChange: () => {},
      }),
    );
  }

  const picker = (tree: ReturnType<typeof walk>) => tree.find((el) => propsOf(el).id === "reg-self-index-e1");
  const error = (tree: ReturnType<typeof walk>) => tree.find((el) => propsOf(el).id === "reg-self-index-e1-error");

  it("marks the picker invalid and renders an error beside it while no row is chosen", () => {
    const tree = renderSelfEntry(null);
    expect(picker(tree), "self picker not rendered").toBeTruthy();
    expect(propsOf(picker(tree)!)["aria-invalid"]).toBe(true);
    expect(error(tree), "no error rendered beside the picker").toBeTruthy();
    expect(propsOf(error(tree)!).role).toBe("alert");
  });

  it("points the picker at that error via aria-describedby, so it is announced with the control", () => {
    const tree = renderSelfEntry(null);
    expect(propsOf(picker(tree)!)["aria-describedby"]).toBe("reg-self-index-e1-error");
  });

  it("clears both the error and the invalid state once a row IS chosen", () => {
    const tree = renderSelfEntry(0);
    expect(picker(tree), "self picker not rendered").toBeTruthy();
    expect(propsOf(picker(tree)!)["aria-invalid"]).toBeUndefined();
    expect(propsOf(picker(tree)!)["aria-describedby"]).toBeUndefined();
    expect(error(tree)).toBeUndefined();
  });
});

// Polish wave P5 (H-1): the solo sign-up's card collected nothing ("nothing extra"), so the submit wrote no player and Assign could
// never place the person. The card now carries the solo player's one row - the same roster row a self-registration fills (name;
// dob/gender when the division asks) - and an edit there lands on that row through the real reducer.
describe("EntryDetails — a solo sign-up's card collects the player", () => {
  function renderSolo(division: DivisionLike, dispatch: (a: CartAction) => void = () => {}) {
    const entry = makeEntry({ free_agent: true, players: [{ ...EMPTY_ROSTER_PLAYER }] });
    const tree = walk(
      EntryDetails({
        entry,
        division,
        contact: EMPTY_CONTACT,
        isSelfEntry: false,
        selfPlayerIndex: null,
        seasonStartYear: 2026,
        dispatch,
        importText: "",
        onImportTextChange: () => {},
      }),
    );
    return { entry, tree, roster: tree.find((el) => el.type === RosterTable) };
  }

  it("renders the one-row roster with the division's dob/gender asks, beside the solo note", () => {
    const table: [boolean, boolean][] = [
      [false, false],
      [true, true],
    ];
    for (const [requires_dob, requires_gender] of table) {
      const { tree, roster } = renderSolo({ ...DIVISION, requires_dob, requires_gender });
      expect(roster, "the solo card renders the player's row").toBeTruthy();
      expect(propsOf(roster!)).toMatchObject({ requiresDob: requires_dob, requiresGender: requires_gender });
      expect(tree.some((el) => propsOf(el).children === "register.details.freeAgent.note"), "the solo note stays").toBe(true);
    }
    expect(table.length, "both division shapes checked").toBe(2);
  });

  // Polish wave sign-off V3: the note read "Nothing else needed for a solo sign-up" directly above the player row the card now asks
  // for (P5 H-1), and said "assign YOU" for a player who may be someone else (final fix m4). It now says only what happens next.
  it("the solo note never says nothing else is needed, and names the player, not the registrant (4 locales)", async () => {
    const dicts = {
      en: (await import("@/dictionaries/en/ui.json")).default,
      es: (await import("@/dictionaries/es/ui.json")).default,
      fr: (await import("@/dictionaries/fr/ui.json")).default,
      nl: (await import("@/dictionaries/nl/ui.json")).default,
    } as Record<string, Record<string, string>>;
    const notes = Object.entries(dicts).map(([locale, d]) => [locale, d["register.details.freeAgent.note"]] as const);
    for (const [locale, note] of notes) {
      expect(typeof note, `${locale}: the note exists`).toBe("string");
      expect(note, `${locale}: never "nothing else needed" above a field that asks for more`).not.toMatch(/nothing else|nada más|rien d'autre|verder niets/i);
    }
    expect(notes.length, "anti-vacuity").toBe(4);
    expect(dicts.en!["register.details.freeAgent.note"]).toBe("The organiser will place this player on a team once one has space.");
  });

  it("typing the player's name lands on the solo's one row (folded through the real reducer)", () => {
    const actions: CartAction[] = [];
    const { entry, roster } = renderSolo(DIVISION, (a) => actions.push(a));
    (propsOf(roster!).onUpdatePlayer as (i: number, patch: object) => void)(0, { full_name: "Priya Raman" });
    const state = actions.reduce<CartState>((st, a) => cartReducer(st, a), { entries: [entry] });
    expect(state.entries[0]!.players).toEqual([{ ...EMPTY_ROSTER_PLAYER, full_name: "Priya Raman" }]);
  });
});
