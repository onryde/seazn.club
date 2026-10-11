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
import { propsOf, renderIsland, textOf } from "@/components/__tests__/_hook-harness";
import { foldMatch } from "@seazn/engine/core";
import { builtinModules } from "@seazn/engine/sports";
import { defaultLineupPair, makeEnvelope } from "@seazn/engine/testkit";

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
      canOrganise
      stageKind={null}
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
        canOrganise
        stageKind={null}
        viewerPlan="community"
      />,
    );
    expect(html).toContain("Ada Okonkwo");
    expect(html).not.toContain("Entry 3");
  });

  it("W2a: a chess tie-break's recorded score reaches the console's decided sentence (spec §5.5)", () => {
    const live: LiveState = {
      status: "decided",
      last_seq: 3,
      summary: { headline: "½ — ½", detail: { tiebreak: { rung: "rapid", score: "1½–½" } } },
      state: {},
      outcome: { kind: "win", winner: "e-home", method: "tiebreak_rapid" },
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
        canOrganise
        stageKind="knockout"
        viewerPlan="community"
      />,
    );
    // Fix round 1 (M1): the score is glued (a nowrap span) so it never splits across lines on a phone.
    expect(html).toContain('Ada Okonkwo won on rapid tie-break (<span class="whitespace-nowrap">1½–½</span>)');
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
describe("the forfeit dialog, opened (D-6)", () => {
  beforeEach(() => {
    // `ForfeitDialog`'s keydown trap registers on `document` the moment it mounts and there is no DOM in this workspace
    // (`environment: "node"`). Two no-ops (and no focused element) are the whole contract it needs; anything more would
    // be a second, silent implementation of the behaviour under test.
    vi.stubGlobal("document", {
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      activeElement: null,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // W2b Task 11: the dialog reads the module (its phase guard), so the console needs the pad's pin and a REAL folded
  // state — a started football match.
  const football = builtinModules.find((m) => m.key === "football")!;
  const CFG = football.configSchema.parse((football.variants as Record<string, unknown> | undefined)?.["11-a-side"] ?? {});
  const STARTED = foldMatch(football, CFG, defaultLineupPair(football.positions), [makeEnvelope(1, { type: "core.start", payload: {} })]);

  /** The real `<ForfeitDialog/>` element the console builds once Forfeit is clicked, re-mounted in the harness so its
   *  own `useState` can be driven. Found by function identity rather than by a test-only export: the console is its
   *  only caller. */
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
        state: STARTED,
        outcome: null,
      } satisfies LiveState,
      initialEvents: [GOAL],
      canEdit: true,
      canOrganise: true,
      stageKind: null,
      viewerPlan: "community",
      scorePadV2: {
        moduleVersion: football.version,
        resolvedConfig: CFG,
        initialEvents: [],
        entitlements: {},
        stageKind: null,
        identity: { recordedBy: "user-1", deviceLinkId: null },
      },
    });
    const isDialog = (e: ReactElement) => typeof e.type === "function" && (e.type as { name?: string }).name === "ForfeitDialog";
    expect(console_.tree().some(isDialog), "closed until Forfeit is clicked").toBe(false);
    const trigger = console_.tree().find((e) => e.type === "button" && propsOf(e)["data-testid"] === "score-forfeit");
    if (!trigger) throw new Error("score-forfeit not found in the console's tree");
    (propsOf(trigger).onClick as () => void)();
    const el = console_.tree().find(isDialog);
    if (!el) throw new Error("<ForfeitDialog/> not found after clicking Forfeit");
    return renderIsland(el.type as (props: unknown) => ReactNode, propsOf(el));
  }

  const byTestid = (island: ReturnType<typeof forfeitIsland>, id: string): ReactElement[] =>
    island.tree().filter((e) => propsOf(e)["data-testid"] === id);

  it("names the people on the side choices, never the entry label", () => {
    const island = forfeitIsland();
    const home = byTestid(island, "forfeit-who-home");
    const away = byTestid(island, "forfeit-who-away");
    expect(home).toHaveLength(1);
    expect(away).toHaveLength(1);
    const text = island.text();
    expect(text).toContain("Ada Okonkwo");
    expect(text).toContain("Cy Mensah / Bo Lindqvist");
    expect(text, "the entry label must not reach the dialog").not.toContain("Entry 3");
    expect(text).not.toContain("Entry 4");
  });

  it("names the people in the preview the organiser has to read and accept", () => {
    // The step that carries the consequence: who is credited what. A dialog that named Ada Okonkwo on the side choice
    // and "Entry 3" in the credited score would be R7/C review fix #3 again (the old prompt's title).
    const island = forfeitIsland();
    (propsOf(byTestid(island, "forfeit-who-home")[0]!).onClick as () => void)();
    (propsOf(byTestid(island, "forfeit-why-retired")[0]!).onChange as () => void)();
    const preview = byTestid(island, "forfeit-preview");
    expect(preview).toHaveLength(1);
    // FB-RT-1 (FDC Art. 28): the home side retired, the away side is credited the awarded 3-0.
    expect(textOf(preview[0]!)).toBe("Credited score: Ada Okonkwo 0–3 Cy Mensah / Bo Lindqvist");
  });
});
