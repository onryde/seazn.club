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
import { propsOf, textOf, walk } from "@/components/__tests__/_hook-harness";
import { cartReducer, type CartAction } from "../cart";
import { EntryDetails } from "../entry-details";
import { FormFields } from "../form-fields";
import { RosterTable } from "../roster-table";
import { EMPTY_CONTACT, EMPTY_ROSTER_PLAYER, type CartEntry, type CartState, type DivisionLike, type FormFieldDef } from "../types";

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
      orgName: "Test Org",
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
        orgName: "Test Org",
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
        orgName: "Test Org",
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

// ---------------------------------------------------------------------------
// Registration redesign B2 T9 — the contact's own row is read-only on Details ("That's you. Change it on the Contact step."), and
// ONLY when it truly is theirs. The row is the one the entry's self link resolves to (individual -> row 0, pair/team -> the pick) AND
// it carries the contact's own name: showing a lock and "That's you" on a row named something else would be a lie, and a locked row
// whose name drifted from the contact (details-seed.ts seeds blank rows only, so a rename after the first visit never reaches it)
// would be a dead end. The expectations are written per case below, never computed from the rule under test.
// ---------------------------------------------------------------------------

describe("EntryDetails — the contact's own row is read-only, and only when it really is the contact's (B2 T9)", () => {
  const CONTACT = { ...EMPTY_CONTACT, name: "Alex Test" };
  const row = (full_name: string) => ({ ...EMPTY_ROSTER_PLAYER, full_name });

  function render(entry: CartEntry, contact = CONTACT) {
    const tree = walk(
      EntryDetails({
        entry,
        division: DIVISION,
        contact,
        isSelfEntry: entry.registering_self,
        selfPlayerIndex: entry.self_player_index,
        seasonStartYear: 2026,
        orgName: "Test Org",
        dispatch: () => {},
        importText: "",
        onImportTextChange: () => {},
      }),
    );
    const rosterEl = tree.find((el) => el.type === RosterTable);
    expect(rosterEl, "the card renders the roster").toBeTruthy();
    // The consumer: the roster rendered from the props EntryDetails handed it (RosterTable is hookless, called directly).
    const cells = walk(RosterTable(propsOf(rosterEl!) as unknown as Parameters<typeof RosterTable>[0]));
    const nameInputs = cells
      .filter((el) => propsOf(el)["data-testid"] === "reg-roster-name")
      .sort((a, b) => Number(propsOf(a)["data-player-row"]) - Number(propsOf(b)["data-player-row"]));
    const notes = cells.filter((el) => propsOf(el).children === "register.details.you");
    return { rosterEl: rosterEl!, nameInputs, notes };
  }

  const CASES: {
    name: string;
    entry: CartEntry;
    contact?: typeof CONTACT;
    readOnlyRows: number[];
  }[] = [
    {
      name: "an individual registering themselves: row 0 is the contact's",
      entry: makeEntry({ entrant_kind: "individual", registering_self: true, players: [row("Alex Test")] }),
      readOnlyRows: [0],
    },
    {
      name: "the match ignores stray spaces on either side",
      entry: makeEntry({ entrant_kind: "individual", registering_self: true, players: [row("Alex Test  ")] }),
      contact: { ...CONTACT, name: "  Alex Test" },
      readOnlyRows: [0],
    },
    {
      name: "an individual NOT registering themselves who shares the contact's name is somebody else's row",
      entry: makeEntry({ entrant_kind: "individual", registering_self: false, players: [row("Alex Test")] }),
      readOnlyRows: [],
    },
    {
      name: "a row whose name is no longer the contact's (renamed on Contact after the seed) stays editable, with no 'That's you'",
      entry: makeEntry({ entrant_kind: "individual", registering_self: true, players: [row("Alx Test")] }),
      readOnlyRows: [],
    },
    {
      name: "a pair: only the picked row (Player 2) is the contact's",
      entry: makeEntry({
        entrant_kind: "pair",
        registering_self: true,
        self_player_index: 1,
        players: [row("Sam Reid"), row("Alex Test")],
      }),
      readOnlyRows: [1],
    },
    {
      name: "a pair with the pick on Player 1: Player 2 stays editable",
      entry: makeEntry({
        entrant_kind: "pair",
        registering_self: true,
        self_player_index: 0,
        players: [row("Alex Test"), row("Sam Reid")],
      }),
      readOnlyRows: [0],
    },
    {
      name: "a team whose captain has not picked their row yet locks nothing, even if a row carries their name",
      entry: makeEntry({ entrant_kind: "team", registering_self: true, self_player_index: null, players: [row("Alex Test")] }),
      readOnlyRows: [],
    },
    {
      name: "a team: the picked row is the contact's, the squad is not",
      entry: makeEntry({
        entrant_kind: "team",
        registering_self: true,
        self_player_index: 0,
        players: [row("Alex Test"), row("Bo Lin")],
      }),
      readOnlyRows: [0],
    },
    {
      name: "a solo sign-up has its own flow (the row may be someone else's): never locked",
      entry: makeEntry({ entrant_kind: "team", free_agent: true, registering_self: true, players: [row("Alex Test")] }),
      readOnlyRows: [],
    },
    {
      name: "a blank contact name never locks a blank row (the empty case)",
      entry: makeEntry({ entrant_kind: "individual", registering_self: true, players: [row("")] }),
      contact: { ...CONTACT, name: "" },
      readOnlyRows: [],
    },
  ];

  it.each(CASES)("$name", ({ entry, contact, readOnlyRows }) => {
    const { rosterEl, nameInputs, notes } = render(entry, contact);
    expect(nameInputs.length, "anti-vacuity: every row rendered its name input").toBe(entry.players.length);
    const locked = nameInputs.filter((el) => propsOf(el).readOnly === true).map((el) => Number(propsOf(el)["data-player-row"]));
    expect(locked).toEqual(readOnlyRows);
    expect(notes.length, "one 'That's you' note per locked row, none otherwise").toBe(readOnlyRows.length);
    expect(propsOf(rosterEl).contactRow ?? null, "the seam: the roster is told which row it is").toBe(readOnlyRows[0] ?? null);
    for (const el of nameInputs) {
      expect(propsOf(el)["data-testid"], "a locked row keeps the e2e hook").toBe("reg-roster-name");
    }
  });

  it("a locked row still has a name the registrant can read: the row's own value, and its note describes it", () => {
    const entry = makeEntry({ entrant_kind: "individual", registering_self: true, players: [row("Alex Test")] });
    const { nameInputs, notes } = render(entry);
    const input = nameInputs[0]!;
    expect(propsOf(input).value).toBe("Alex Test");
    expect(propsOf(input)["aria-describedby"], "the input is described by the note").toBe(propsOf(notes[0]!).id);
  });

  it("an editable row has no note to be described by", () => {
    const entry = makeEntry({ entrant_kind: "individual", registering_self: false, players: [row("")] });
    const { nameInputs } = render(entry);
    expect(propsOf(nameInputs[0]!)["aria-describedby"]).toBeUndefined();
    expect(propsOf(nameInputs[0]!).readOnly).not.toBe(true);
  });
});

// B2 T9 — the organiser's questions: an "Optional" tag on the ones that may be skipped, none on the required ones, and a heading
// that names who is asking. No questions, no heading.
describe("FormFields / EntryDetails — organiser questions (B2 T9)", () => {
  const FIELDS: FormFieldDef[] = [
    { key: "shirt", label: "Shirt size", kind: "text", required: false },
    { key: "diet", label: "Dietary needs", kind: "select", options: ["None", "Vegetarian"], required: true },
    { key: "ack", label: "Court rules acknowledged", kind: "checkbox", required: false },
    { key: "emergency", label: "Emergency contact", kind: "text", required: true },
    { key: "waiver", label: "Waiver accepted", kind: "checkbox", required: true },
    { key: "pick", label: "Preferred slot", kind: "select", options: ["AM", "PM"], required: false },
  ];

  function renderFields(fields: readonly FormFieldDef[]) {
    return walk(FormFields({ fields, answers: {}, onChange: () => {}, entryId: "e1", orgName: "Test Org" }));
  }
  /** The label a field is announced by: `label[for]` for a text/select, the wrapping label for a checkbox. */
  function labelOf(tree: ReturnType<typeof walk>, f: FormFieldDef) {
    const labels = tree.filter((el) => el.type === "label");
    return f.kind === "checkbox"
      ? labels.find((l) => textOf(l).includes(f.label))
      : labels.find((l) => propsOf(l).htmlFor === `reg-field-e1-${f.key}`);
  }

  it("an optional question carries the Optional tag and a required one does not (every kind)", () => {
    const tree = renderFields(FIELDS);
    let tagged = 0;
    let untagged = 0;
    for (const f of FIELDS) {
      const label = labelOf(tree, f);
      expect(label, `no label found for ${f.key}`).toBeTruthy();
      const hasTag = textOf(label!).includes("register.field.optional");
      expect(hasTag, `${f.key} (${f.kind}, required=${f.required})`).toBe(!f.required);
      if (hasTag) tagged++;
      else untagged++;
    }
    expect(tagged, "anti-vacuity: the fixture has optional questions").toBe(FIELDS.filter((f) => !f.required).length);
    expect(untagged, "anti-vacuity: and required ones").toBe(FIELDS.filter((f) => f.required).length);
    expect(tagged).toBeGreaterThan(0);
    expect(untagged).toBeGreaterThan(0);
  });

  it("the questions sit under a heading that names the organiser", () => {
    const tree = renderFields(FIELDS);
    const headings = tree.filter((el) => el.type === "h4");
    expect(headings).toHaveLength(1);
    expect(textOf(headings[0]!)).toBe("register.details.questionsFrom");
    expect(tree.some((el) => textOf(el) === "register.section.questions"), "the old generic heading is gone").toBe(false);
  });

  function renderCard(form_fields: FormFieldDef[]) {
    return walk(
      EntryDetails({
        entry: makeEntry(),
        division: { ...DIVISION, form_fields },
        contact: EMPTY_CONTACT,
        isSelfEntry: false,
        selfPlayerIndex: null,
        seasonStartYear: 2026,
        orgName: "Test Org",
        dispatch: () => {},
        importText: "",
        onImportTextChange: () => {},
      }),
    );
  }

  it("the card hands FormFields the organiser's name (the heading's {org})", () => {
    const el = renderCard(FIELDS).find((e) => e.type === FormFields);
    expect(el, "FormFields rendered").toBeTruthy();
    expect(propsOf(el!).orgName).toBe("Test Org");
  });

  it("zero organiser questions render no Questions heading at all (the empty case)", () => {
    const tree = renderCard([]);
    expect(tree.some((e) => e.type === FormFields), "no questions block").toBe(false);
    expect(renderFields([]), "and FormFields itself renders nothing for an empty list, heading included").toHaveLength(0);
    // Its positive pair, so the absence above is the card's choice and not a card that renders no headings at all.
    expect(renderCard(FIELDS).filter((e) => e.type === FormFields)).toHaveLength(1);
    expect(tree.some((e) => e.type === "h3"), "the card's own title is there either way").toBe(true);
  });
});
