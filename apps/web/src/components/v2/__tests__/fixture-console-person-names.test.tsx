// R7 / Task C, C5 (D-6) — the pad, the header and the pickers must render
// PEOPLE for an individual or pair entrant.
//
// `entrants.display_name` is a TEAM-sports concept: it is snapshotted at
// registration precisely so a later team rename cannot rewrite historical
// standings (`server/usecases/entrants.ts`). For a singles competitor or a
// doubles pair there is no team to snapshot, so that column holds whatever
// text the entry flow happened to put there — which is how a chess console
// came to say "Entry 3" above a board where two named people were playing.
//
// The people are already on the wire: `SideInfo.members` carries them, and
// `SideInfo.kind` is the entrant's own declared kind (`entrants.kind`,
// validated against the division's entrant model) — the authoritative answer
// to "is this entrant a pair", which `lineup-editor.tsx` already reads for
// exactly this reason rather than inferring it.
//
// The TEAM case is asserted too, and it is not a formality: a resolution
// that turned every entrant into a list of its players would pass all three
// individual/pair claims below while making football unreadable.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { entrantDisplayName } from "@/lib/entrant-name";
import { FixtureConsole } from "@/components/v2/fixture-console";
import type { EventIn, LiveState, MemberIn, SideInfo, SportInfo } from "@/components/v2/fixture-console";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

const sport: SportInfo = {
  key: "football",
  config: {},
  scorerLabel: "Referee",
  positionGroups: [],
  roles: [],
  lineupSize: 11,
  benchMax: 5,
};

function member(id: string, name: string): MemberIn {
  return {
    person_id: id,
    full_name: name,
    squad_number: null,
    default_position_key: null,
    is_captain: false,
    roles: [],
  };
}

const SINGLES: SideInfo = {
  id: "e-home",
  name: "Entry 3",
  kind: "individual",
  members: [member("p1", "Ada Okonkwo")],
  lineup: [],
};

const PAIR: SideInfo = {
  id: "e-away",
  name: "Entry 4",
  kind: "pair",
  members: [member("p2", "Bo Lindqvist"), member("p3", "Cy Mensah")],
  lineup: [
    { person_id: "p3", full_name: "Cy Mensah", slot: "starting", position_key: null, order_no: 1, roles: [], pair_order: 1 },
    { person_id: "p2", full_name: "Bo Lindqvist", slot: "starting", position_key: null, order_no: 2, roles: [], pair_order: 2 },
  ],
};

const TEAM: SideInfo = {
  id: "e-team",
  name: "Riverside FC",
  kind: "team",
  members: [member("p9", "Dee Rahman")],
  lineup: [],
};

const GOAL: EventIn = {
  id: "ev-1",
  seq: 1,
  type: "football.goal",
  payload: { by: "e-home" },
  recorded_at: "2026-08-30T10:05:00.000Z",
  recorded_by: null,
  voids_event_id: null,
  device_link_id: null,
};

function consoleHtml(home: SideInfo, away: SideInfo): string {
  const live: LiveState = {
    status: "in_play",
    last_seq: 1,
    summary: { headline: "1 — 0" },
    state: {},
    outcome: null,
  };
  return renderToStaticMarkup(
    <FixtureConsole
      fixture={{ id: "f1", status: "in_play", scheduled_at: null, venue_name: null, court_name: null, round_no: 1 }}
      sport={sport}
      home={home}
      away={away}
      initialState={live}
      initialEvents={[{ ...GOAL, payload: { by: home.id } }]}
      canEdit
      viewerPlan="community"
    />,
  );
}

describe("entrantDisplayName", () => {
  it("names the competitor for an individual entrant, not the entry label", () => {
    expect(entrantDisplayName(SINGLES)).toBe("Ada Okonkwo");
  });

  it("names BOTH players of a pair, in the lineup's declared serve order", () => {
    // `pair_order` is the doubles order the engine's own `LineupSlot.pairOrder`
    // carries — reading `members` order instead would print them the way the
    // roster happens to be sorted, which is not the pair's order.
    expect(entrantDisplayName(PAIR)).toBe("Cy Mensah / Bo Lindqvist");
  });

  it("leaves a TEAM entrant's snapshotted name alone", () => {
    expect(entrantDisplayName(TEAM)).toBe("Riverside FC");
  });

  it("falls back to the entrant's own name when the roster cannot answer", () => {
    // An individual entrant with no member yet, and a "pair" holding one
    // person: rendering an empty string, or half a pair, is worse than the
    // label the entry flow supplied.
    expect(entrantDisplayName({ ...SINGLES, members: [] })).toBe("Entry 3");
    expect(entrantDisplayName({ ...PAIR, members: [member("p2", "Bo Lindqvist")], lineup: [] })).toBe(
      "Entry 4",
    );
  });

  it("says nothing about an entrant whose kind is unknown", () => {
    // `kind` is optional on the wire (test fixtures and callers predate the
    // column). Absent means "assume the snapshot is right" — the safe half.
    expect(entrantDisplayName({ ...SINGLES, kind: undefined })).toBe("Entry 3");
  });
});

describe("the console renders people, not entry labels (D-6)", () => {
  it("uses the resolved names in the scoreline header", () => {
    const html = consoleHtml(SINGLES, PAIR);
    expect(html).toContain("Ada Okonkwo");
    expect(html).toContain("Cy Mensah / Bo Lindqvist");
    expect(html, "the entry label must not survive anywhere on the page").not.toContain("Entry 3");
    expect(html).not.toContain("Entry 4");
  });

  it("uses them to say who WON, once the pad has unmounted", () => {
    // `decidedOutcomeText` reads the same entrant name map the ledger does,
    // and on a decided fixture it is the console's only statement of the
    // result (the pad unmounts). Before this a singles final read
    // "Entry 3 wins".
    //
    // NOT asserted on a ledger ROW, and the reason is a premise this task
    // was given that turned out to be false: `buildRibbon` never resolves an
    // entrant at all — its base sentence comes from the event TYPE, and the
    // only names in a row come from a skin's `activityDetail`, which reads
    // PERSONS. A football goal's `by` (an entrant id) reaches no caption.
    const live: LiveState = {
      status: "decided",
      last_seq: 1,
      summary: { headline: "1 — 0" },
      state: {},
      outcome: { kind: "win", winner: "e-home" },
    };
    const html = renderToStaticMarkup(
      <FixtureConsole
        fixture={{ id: "f1", status: "decided", scheduled_at: null, venue_name: null, court_name: null, round_no: 1 }}
        sport={sport}
        home={SINGLES}
        away={PAIR}
        initialState={live}
        initialEvents={[GOAL]}
        canEdit
        viewerPlan="community"
      />,
    );
    expect(html).toContain("Ada Okonkwo");
    expect(html).not.toContain("Entry 3");
  });

  it("still shows a football team by its team name", () => {
    const html = consoleHtml(TEAM, { ...TEAM, id: "e-team2", name: "Summit Athletic" });
    expect(html).toContain("Riverside FC");
    expect(html).toContain("Summit Athletic");
    expect(html, "a team must not become a list of its players").not.toContain("Dee Rahman");
  });
});

// R7 / Task C review fix #3 — THE FORFEIT PICKER, ACTUALLY OPENED.
//
// The case this replaces was named "uses them in the forfeit picker" and
// asserted `not.toContain("Entry")` over `renderToStaticMarkup`. The dropdown
// is behind `useState(false)` and never renders there, so the assertion only
// restated the scoreline claim above it: reverting `entrantDisplayName(s)` to
// `s.name` inside `ForfeitButton` left it GREEN. A test that survives the
// mutation it exists to catch reports a safety it does not provide.
//
// So: drive the real control. `_hook-harness` supplies React's dispatcher, so
// the picker can be OPENED and the sentence a user reads can be asserted —
// including the confirmation dialog behind it, which turned out to still be
// naming the entry label.
describe("the forfeit picker, opened (D-6)", () => {
  beforeEach(() => {
    // `ForfeitButton`'s outside-click effect runs the moment the menu opens
    // and there is no DOM in this workspace (`environment: "node"`). Two
    // no-ops are the whole contract it needs; anything more would be a
    // second, silent implementation of the behaviour under test.
    vi.stubGlobal("document", {
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** The real `<ForfeitButton/>` element the console builds, re-mounted in the
   *  harness so its own `useState` can be driven. Found by function identity
   *  rather than exported for the test: the console is its only caller, and
   *  widening the module's surface to reach it would be the test changing the
   *  product. */
  function forfeitIsland() {
    const console_ = renderIsland(FixtureConsole, {
      fixture: { id: "f1", status: "in_play", scheduled_at: null, venue_name: null, court_name: null, round_no: 1 },
      sport,
      home: SINGLES,
      away: PAIR,
      initialState: {
        status: "in_play",
        last_seq: 1,
        summary: { headline: "1 — 0" },
        state: {},
        outcome: null,
      } satisfies LiveState,
      initialEvents: [GOAL],
      canEdit: true,
      viewerPlan: "community",
    });
    const el = console_
      .tree()
      .find((e) => typeof e.type === "function" && (e.type as { name?: string }).name === "ForfeitButton");
    if (!el) throw new Error("<ForfeitButton/> not found in the console's tree");
    return renderIsland(el.type as (props: unknown) => ReactNode, propsOf(el));
  }

  function buttons(island: ReturnType<typeof forfeitIsland>): ReactElement[] {
    return island.tree().filter((e) => e.type === "button");
  }

  it("names the people once the menu is open, never the entry label", () => {
    const island = forfeitIsland();

    // Closed: one control, the trigger — proves the click below is what
    // reveals the labels, so the assertions cannot be reading the header.
    expect(buttons(island)).toHaveLength(1);
    (propsOf(buttons(island)[0]!).onClick as () => void)();

    const open = buttons(island);
    expect(open, "the trigger plus one row per side").toHaveLength(3);
    const text = island.text();
    expect(text).toContain("Ada Okonkwo forfeits");
    expect(text).toContain("Cy Mensah / Bo Lindqvist forfeits");
    expect(text, "the entry label must not reach the picker").not.toContain("Entry 3");
    expect(text).not.toContain("Entry 4");
  });

  it("names the person in the confirmation the organiser has to read and accept", () => {
    // The step AFTER the picker, and the one that carries the consequence:
    // "Reason {name} forfeits:". It was still reading `forfeitPrompt.name`,
    // so a console that had named Ada Okonkwo everywhere else asked the
    // organiser to confirm a forfeit for "Entry 3".
    const island = forfeitIsland();
    (propsOf(buttons(island)[0]!).onClick as () => void)();
    (propsOf(buttons(island)[1]!).onClick as () => void)();

    const dialog = island
      .tree()
      .find((e) => typeof e.type === "function" && (e.type as { name?: string }).name === "TextPromptDialog");
    if (!dialog) throw new Error("<TextPromptDialog/> not found after picking a side");
    expect(propsOf(dialog).title).toBe("Reason Ada Okonkwo forfeits:");
  });
});
