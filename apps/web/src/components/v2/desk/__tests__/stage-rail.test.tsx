import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import en from "@/dictionaries/en/ui.json";
import type { SwissPairingMenu } from "@/lib/swiss-pairing-menu";
import { StageRail, SwissPairingMenuPanel, type StageRailProps } from "../stage-rail";

const stage = { id: "s1", name: "League", kind: "league", seq: 1, status: "active" } as never;

// Task 4 — every existing call site grows the required props.
// `unscheduledBadgeSlot: null` is a neutral default: a null slot means the
// pinned unscheduled section stays absent, so these pre-existing tests keep
// asserting exactly what they asserted before this task touched the file.
// Fix round 2 (Ruling T4-B): the rail no longer builds the badge itself
// from a count — it renders whatever `unscheduledBadgeSlot` element the
// panel hands it, same `courtTagsSlot` shape, so the panel can also mount
// that SAME element inline for a non-editing viewer.
//
// Task 10 grows the same set again (`open`/`onToggleOpen`), same convention:
// `open: false` is a neutral default — none of these tests exercise the
// phone sheet, so the fold stays closed and every assertion below keeps
// meaning exactly what it meant before this task touched the file.
//
// Owner ruling (round: "remove auto-schedule from the fixtures page") —
// `capacityBlocked` / `onAutoSchedule` are gone from StageRailProps
// entirely: the rail no longer renders any `stage-auto-schedule` /
// `stage-auto-schedule-blocked` element, ever. The two tests that existed
// solely to probe that CTA's blocked-reason rendering are deleted below
// (their whole subject no longer exists on this component), not weakened.
const NEUTRAL = {
  unscheduledBadgeSlot: null,
  open: false,
  onToggleOpen: () => {},
  swissHasUnseated: false,
  canUnpairSwiss: false,
  // Swiss round-1 pairing: `null` is "no menu" — every pre-existing test
  // below keeps asserting exactly what it did.
  swissPairingMenu: null,
};
const BADGE = <p data-testid="stage-unscheduled-count">3</p>;

describe("StageRail", () => {
  it("renders the three header controls with their testids", () => {
    const html = renderToStaticMarkup(
      <StageRail stage={stage} canEdit busy={null} fixtureCount={4} deletable
        onAct={async () => true} onDelete={() => {}} addingTo={null} onToggleAddMatch={() => {}}
        adhoc={false} courtTagsSlot={null} {...NEUTRAL} />,
    );
    expect(html).toContain('data-testid="stage-generate"');
    expect(html).toContain('data-testid="stage-complete"');
    expect(html).toContain('data-testid="stage-delete"');
  });

  it("renders nothing at all when the viewer cannot edit — even with a non-null badge slot", () => {
    const html = renderToStaticMarkup(
      <StageRail stage={stage} canEdit={false} busy={null} fixtureCount={4} deletable
        onAct={async () => true} onDelete={() => {}} addingTo={null} onToggleAddMatch={() => {}}
        adhoc={false} courtTagsSlot={null} {...NEUTRAL} unscheduledBadgeSlot={BADGE} />,
    );
    expect(html).toBe("");
  });

  // The auto-schedule CTA left this page by owner ruling ("remove
  // auto-schedule from the fixtures page" — scheduling lives on the Schedule
  // page, which owns the full `AutoScheduleMode` flow). Nothing PINNED that
  // removal: after the props retired, `stage-auto-schedule` survived in this
  // repo only inside comments, so re-adding the button would have gone
  // unnoticed by every gate in the wave. This sweeps the states that used to
  // render it — an unscheduled count present is precisely when it appeared —
  // and each row asserts its POSITIVE pair first, so a rail that rendered
  // nothing cannot satisfy the absence for the wrong reason.
  it("never renders the retired auto-schedule CTA, in any state that used to show it", () => {
    const pin = (label: string, html: string) => {
      expect(html, `${label}: the rail rendered no controls at all`).toContain('data-testid="stage-generate"');
      // Bare substring, not `data-testid="..."`: this also catches the
      // `stage-auto-schedule-blocked` reason line that retired with it.
      expect(html, `${label}: the retired auto-schedule CTA is back`).not.toContain("stage-auto-schedule");
    };

    pin(
      "closed, no unscheduled work",
      renderToStaticMarkup(
        <StageRail stage={stage} canEdit busy={null} fixtureCount={4} deletable
          onAct={async () => true} onDelete={() => {}} addingTo={null} onToggleAddMatch={() => {}}
          adhoc courtTagsSlot={null} {...NEUTRAL} />,
      ),
    );
    pin(
      "closed, with an unscheduled count — precisely when the CTA used to appear",
      renderToStaticMarkup(
        <StageRail stage={stage} canEdit busy={null} fixtureCount={4} deletable
          onAct={async () => true} onDelete={() => {}} addingTo={null} onToggleAddMatch={() => {}}
          adhoc courtTagsSlot={null} {...NEUTRAL} unscheduledBadgeSlot={BADGE} />,
      ),
    );
    pin(
      "phone sheet open, with an unscheduled count",
      renderToStaticMarkup(
        <StageRail stage={stage} canEdit busy={null} fixtureCount={4} deletable
          onAct={async () => true} onDelete={() => {}} addingTo={null} onToggleAddMatch={() => {}}
          adhoc courtTagsSlot={null} {...NEUTRAL} open unscheduledBadgeSlot={BADGE} />,
      ),
    );
  });

  it("renders the Add match control for an ad-hoc stage kind, and omits it for a kind not in ADHOC_STAGE_KINDS", () => {
    const adhocHtml = renderToStaticMarkup(
      <StageRail stage={stage} canEdit busy={null} fixtureCount={4} deletable
        onAct={async () => true} onDelete={() => {}} addingTo={null} onToggleAddMatch={() => {}}
        adhoc courtTagsSlot={null} {...NEUTRAL} />,
    );
    expect(adhocHtml).toContain('data-testid="stage-add-match"');

    const nonAdhocHtml = renderToStaticMarkup(
      <StageRail stage={stage} canEdit busy={null} fixtureCount={4} deletable
        onAct={async () => true} onDelete={() => {}} addingTo={null} onToggleAddMatch={() => {}}
        adhoc={false} courtTagsSlot={null} {...NEUTRAL} />,
    );
    expect(nonAdhocHtml).not.toContain('data-testid="stage-add-match"');
  });

  // W3 RB3-15 A (X-SW-21, ruling 252): Swiss rounds are paired by the system, so a Swiss stage offers no Add match; the
  // rail says why in its place. `adhoc` is passed TRUE for the Swiss stage on purpose: the rail refuses on the KIND,
  // whatever the panel hands it (the panel's own set is pinned in stages-panel-swiss-pairing.test.tsx).
  it("a Swiss stage renders no stage-add-match trigger; a league stage does", () => {
    const row = (kind: string, status = "active") => ({ id: "s1", name: kind, kind, seq: 1, status }) as never;
    const render = (kind: string, extra: Partial<StageRailProps> = {}) =>
      renderToStaticMarkup(
        <StageRail stage={row(kind)} canEdit busy={null} fixtureCount={4} deletable
          onAct={async () => true} onDelete={() => {}} addingTo={null} onToggleAddMatch={() => {}}
          adhoc courtTagsSlot={null} {...NEUTRAL} {...extra} />,
      );
    const NOTE = 'data-testid="stage-swiss-adhoc-note"';
    const copy = en["swiss.refusal.SWISS_ADHOC_REFUSED"];
    expect(copy, "premise: the guidance copy exists").toBeTruthy();

    // Positive pair first: the league row renders the trigger and no Swiss note.
    const league = render("league");
    expect(league).toContain('data-testid="stage-add-match"');
    expect(league).not.toContain(NOTE);

    let checked = 0;
    for (const [label, html] of [
      ["Swiss, desktop row", render("swiss")],
      ["Swiss, phone sheet open", render("swiss", { open: true })],
      ["Swiss, Add match form state says open", render("swiss", { addingTo: "s1" })],
    ] as const) {
      // The rail still renders its controls, so the absence below is not a rail that rendered nothing.
      expect(html, `${label}: rail controls`).toContain('data-testid="stage-generate"');
      expect(html, `${label}: no Add match`).not.toContain('data-testid="stage-add-match"');
      expect(html, `${label}: the guidance line takes its place`).toContain(NOTE);
      expect(html, `${label}: in the reader's words`).toContain(copy);
      checked++;
    }
    expect(checked, "anti-vacuity: Swiss states rendered").toBe(3);

    // The note stands where the button would: a complete stage, or one with nothing generated, shows neither.
    // Each with its positive pair: the rail is still rendering.
    const complete = render("swiss", { stage: row("swiss", "complete") });
    expect(complete).toContain('data-testid="stage-delete"');
    expect(complete).not.toContain(NOTE);
    const empty = render("swiss", { fixtureCount: 0 });
    expect(empty).toContain('data-testid="stage-generate"');
    expect(empty).not.toContain(NOTE);
  });

  it("renders courtTagsSlot content where given", () => {
    const html = renderToStaticMarkup(
      <StageRail stage={stage} canEdit busy={null} fixtureCount={4} deletable
        onAct={async () => true} onDelete={() => {}} addingTo={null} onToggleAddMatch={() => {}}
        adhoc={false} courtTagsSlot={<i data-testid="ct-slot" />} {...NEUTRAL} />,
    );
    expect(html).toContain('data-testid="ct-slot"');
  });

  it("renders no pinned section at all — no badge — when unscheduledBadgeSlot is null", () => {
    const html = renderToStaticMarkup(
      <StageRail stage={stage} canEdit busy={null} fixtureCount={4} deletable
        onAct={async () => true} onDelete={() => {}} addingTo={null} onToggleAddMatch={() => {}}
        adhoc={false} courtTagsSlot={null} {...NEUTRAL} />,
    );
    expect(html).not.toContain('data-testid="stage-unscheduled-count"');
  });

  it("Swiss with zero fixtures labels Generate; with unseated shells labels Pair next", () => {
    const swiss = { id: "s1", name: "Swiss", kind: "swiss", seq: 1, status: "active" } as never;
    const empty = renderToStaticMarkup(
      <StageRail stage={swiss} canEdit busy={null} fixtureCount={0} deletable={false}
        onAct={async () => true} onDelete={() => {}} addingTo={null} onToggleAddMatch={() => {}}
        adhoc={false} courtTagsSlot={null} {...NEUTRAL} />,
    );
    expect(empty).toContain("Generate fixtures");
    expect(empty).not.toContain("Pair next round");

    const unseated = renderToStaticMarkup(
      <StageRail stage={swiss} canEdit busy={null} fixtureCount={8} deletable={false}
        onAct={async () => true} onDelete={() => {}} addingTo={null} onToggleAddMatch={() => {}}
        adhoc={false} courtTagsSlot={null} {...NEUTRAL} swissHasUnseated canUnpairSwiss={false} />,
    );
    expect(unseated).toContain("Pair next round");
    expect(unseated).not.toContain("Generate fixtures");
  });

  it("renders stage-unpair only when canUnpairSwiss is true on a swiss stage", () => {
    const swiss = { id: "s1", name: "Swiss", kind: "swiss", seq: 1, status: "active" } as never;
    const withUnpair = renderToStaticMarkup(
      <StageRail stage={swiss} canEdit busy={null} fixtureCount={4} deletable={false}
        onAct={async () => true} onDelete={() => {}} addingTo={null} onToggleAddMatch={() => {}}
        adhoc={false} courtTagsSlot={null} {...NEUTRAL} swissHasUnseated={false} canUnpairSwiss />,
    );
    expect(withUnpair).toContain('data-testid="stage-unpair"');

    const without = renderToStaticMarkup(
      <StageRail stage={swiss} canEdit busy={null} fixtureCount={4} deletable={false}
        onAct={async () => true} onDelete={() => {}} addingTo={null} onToggleAddMatch={() => {}}
        adhoc={false} courtTagsSlot={null} {...NEUTRAL} />,
    );
    expect(without).not.toContain('data-testid="stage-unpair"');
  });

  it("renders whatever unscheduledBadgeSlot element it is given, verbatim — the rail builds no badge markup of its own", () => {
    const html = renderToStaticMarkup(
      <StageRail stage={stage} canEdit busy={null} fixtureCount={4} deletable
        onAct={async () => true} onDelete={() => {}} addingTo={null} onToggleAddMatch={() => {}}
        adhoc={false} courtTagsSlot={null} {...NEUTRAL}
        unscheduledBadgeSlot={<p data-testid="stage-unscheduled-count" data-marker="from-panel">7</p>} />,
    );
    expect(html).toContain('data-marker="from-panel"');
    const match = /data-testid="stage-unscheduled-count"[^>]*>(\d+)</.exec(html);
    expect(match?.[1]).toBe("7");
  });
});

// F6, found by driving the product (2026-09-20): on a Swiss stage that had
// paired nothing, "Complete stage" was the filled PRIMARY and "Pair next round"
// the outline secondary beside it — the one action that ends the tournament with
// nothing played, dressed as the obvious next press.
//
// Every row below asserts BOTH buttons' variants, not just the one it is about:
// a rule that gave neither button the primary, or gave it to both, would satisfy
// a one-sided assertion. Hardcoding `pairingIsNext = true` reds the seated rows;
// `= false` reds the unpaired rows.
describe("StageRail — which action holds the filled primary", () => {
  const swiss = { id: "s1", name: "Swiss", kind: "swiss", seq: 1, status: "active" } as never;
  const league = { id: "s2", name: "League", kind: "league", seq: 1, status: "active" } as never;

  /** The variant class on a button, by testid: "primary", "ghost" or absent. */
  function variants(html: string) {
    const read = (testid: string) => {
      const el = new RegExp(`<button[^>]*data-testid="${testid}"[^>]*>`).exec(html)?.[0]
        ?? new RegExp(`<button[^>]*class="([^"]*)"[^>]*data-testid="${testid}"`).exec(html)?.[0];
      if (!el) return null;
      if (/\bbtn-primary\b/.test(el)) return "primary";
      if (/\bbtn-ghost\b/.test(el)) return "ghost";
      return "neither";
    };
    return { generate: read("stage-generate"), complete: read("stage-complete") };
  }

  const rail = (over: Record<string, unknown>) =>
    renderToStaticMarkup(
      <StageRail stage={swiss} canEdit busy={null} fixtureCount={6} deletable={false}
        onAct={async () => true} onDelete={() => {}} addingTo={null} onToggleAddMatch={() => {}}
        adhoc={false} courtTagsSlot={null} {...NEUTRAL} {...over} />,
    );

  it("premise: both buttons carry a variant class at all, so 'neither' is a real failure", () => {
    const v = variants(rail({ swissHasUnseated: true }));
    expect(v.generate).not.toBe("neither");
    expect(v.complete).not.toBe("neither");
  });

  it("gives it to Pair next round while a Swiss stage still has rounds unseated", () => {
    expect(variants(rail({ swissHasUnseated: true }))).toEqual({
      generate: "primary",
      complete: "ghost",
    });
  });

  it("moves it to Complete stage once the Swiss board is fully seated", () => {
    // Not "hide the primary" — with nothing left to pair, completing IS the
    // next step, so exactly one filled button either way.
    expect(variants(rail({ swissHasUnseated: false }))).toEqual({
      generate: "ghost",
      complete: "primary",
    });
  });

  it("gives it to Generate on any stage with no fixtures yet", () => {
    // `stage-complete` is not rendered at all without fixtures, so this row
    // asserts the generate side and the absence together.
    for (const stage of [swiss, league]) {
      const v = variants(rail({ stage, fixtureCount: 0, swissHasUnseated: false }));
      expect(v, (stage as { kind: string }).kind).toEqual({ generate: "primary", complete: null });
    }
  });

  it("gives it to Complete on a non-Swiss stage that has its fixtures", () => {
    // `swissHasUnseated` is meaningless off Swiss — a rule that read it
    // unguarded would hand a league's primary to Generate (i.e. regenerate).
    expect(variants(rail({ stage: league, swissHasUnseated: true }))).toEqual({
      generate: "ghost",
      complete: "primary",
    });
  });
});

// Swiss round-1 pairing (spec 2026-09-22-swiss-round-one-pairing, "UI — option
// A, split button"). Static markup only — this file has no DOM, so the OPEN
// menu is rendered through `SwissPairingMenuPanel` directly (the rail mounts
// exactly that component when its toggle is open), and the click/keyboard
// behaviour is pinned as pure functions in `swiss-pairing-menu.test.ts`.
describe("StageRail — the Pair next split button", () => {
  const swiss = { id: "s1", name: "Swiss", kind: "swiss", seq: 1, status: "active", config: {} } as never;
  const ROUND_ONE: SwissPairingMenu = {
    round: 1, choosable: true, defaultPairing: "fold", stored: "rank_adjacent", fieldSize: 10, seedsNumbered: true, unseededDrawn: false, seededAheadOfDraw: false,
  };
  const rail = (over: Record<string, unknown>) =>
    renderToStaticMarkup(
      <StageRail stage={swiss} canEdit busy={null} fixtureCount={10} deletable={false}
        onAct={async () => true} onDelete={() => {}} addingTo={null} onToggleAddMatch={() => {}}
        adhoc={false} courtTagsSlot={null} {...NEUTRAL} swissHasUnseated {...over} />,
    );
  const tag = (html: string, testid: string) =>
    new RegExp(`<button[^>]*data-testid="${testid}"[^>]*>`).exec(html)?.[0] ?? null;

  it("no menu ⇒ no toggle, and Generate keeps its own rounded corners", () => {
    const html = rail({ swissPairingMenu: null });
    expect(tag(html, "stage-generate")).not.toBeNull(); // positive pair first
    expect(html).not.toContain('data-testid="stage-pairing-toggle"');
    expect(tag(html, "stage-generate")).not.toMatch(/\brounded-r-none\b/);
  });

  it("a menu ⇒ a toggle that is a real disclosure: named, collapsed, pointing at the menu", () => {
    const html = rail({ swissPairingMenu: ROUND_ONE });
    const toggle = tag(html, "stage-pairing-toggle");
    expect(toggle).not.toBeNull();
    expect(toggle).toContain('aria-expanded="false"');
    expect(toggle).toContain('aria-controls="pairing-menu-s1"');
    expect(toggle).toContain(`aria-label="${en["schedule.pairing.toggle"]}"`);
    // 44px tap floor on both axes — this control has no text to give it width.
    expect(toggle).toMatch(/\bmin-h-11\b/);
    expect(toggle).toMatch(/\bmin-w-11\b/);
    // Closed until tapped: the menu is not in the markup at all.
    expect(html).not.toContain('data-testid="stage-pairing-menu"');
  });

  it("the toggle sits flush against Generate, in ONE wrapper — a split button, not two buttons", () => {
    const html = rail({ swissPairingMenu: ROUND_ONE });
    expect(html).toMatch(
      /<div class="flex[^"]*items-stretch[^"]*"><button[^>]*data-testid="stage-generate"[^>]*>[^<]*<\/button><button[^>]*data-testid="stage-pairing-toggle"/,
    );
    expect(tag(html, "stage-generate")).toMatch(/\brounded-r-none\b/);
    expect(tag(html, "stage-pairing-toggle")).toMatch(/\brounded-l-none\b/);
  });

  it("Generate keeps its testid and its label logic (review ruling R5)", () => {
    const html = rail({ swissPairingMenu: ROUND_ONE });
    expect(html).toContain(">Pair next round</button>");
  });

  it("the toggle is disabled while any stage action is in flight, like its neighbours", () => {
    expect(tag(rail({ swissPairingMenu: ROUND_ONE, busy: "s1" }), "stage-pairing-toggle")).toMatch(/\sdisabled=""/);
    expect(tag(rail({ swissPairingMenu: ROUND_ONE, busy: null }), "stage-pairing-toggle")).not.toMatch(/\sdisabled=""/);
  });

  it("the toggle wears Generate's variant — the filled primary while pairing is next", () => {
    expect(tag(rail({ swissPairingMenu: ROUND_ONE }), "stage-pairing-toggle")).toMatch(/\bbtn-primary\b/);
  });

  it("a completed stage renders no split button at all", () => {
    const html = rail({ swissPairingMenu: ROUND_ONE, stage: { ...(swiss as object), status: "complete" } });
    expect(html).not.toContain('data-testid="stage-generate"');
    expect(html).not.toContain('data-testid="stage-pairing-toggle"');
  });
});

describe("SwissPairingMenuPanel — the open menu", () => {
  const ROUND_ONE: SwissPairingMenu = {
    round: 1, choosable: true, defaultPairing: "fold", stored: "rank_adjacent", fieldSize: 10, seedsNumbered: true, unseededDrawn: false, seededAheadOfDraw: false,
  };
  const panel = (menu: SwissPairingMenu, pick: "fold" | "rank_adjacent" | null = null) =>
    renderToStaticMarkup(
      <SwissPairingMenuPanel stageId="s1" menu={menu} pick={pick} onPick={() => {}} onClose={() => {}} />,
    );
  const radios = (html: string) =>
    [...html.matchAll(/<(?:button|p)[^>]*role="radio"[^>]*>/g)].map((m) => ({
      testid: /data-testid="([^"]+)"/.exec(m[0])?.[1],
      checked: /aria-checked="([^"]+)"/.exec(m[0])?.[1],
      tabIndex: /tabindex="([^"]+)"/i.exec(m[0])?.[1],
    }));

  it("round 1 is a named radiogroup with the id the toggle controls", () => {
    const html = panel(ROUND_ONE);
    const group = /<div[^>]*role="radiogroup"[^>]*>/.exec(html)?.[0] ?? "";
    expect(group).toContain('id="pairing-menu-s1"');
    expect(group).toContain('data-testid="stage-pairing-menu"');
    expect(group).toContain('aria-label="Round 1 pairing"');
    expect(group).not.toContain("aria-disabled");
  });

  it("offers both modes, the default checked, with a roving tab stop on the checked one", () => {
    expect(radios(panel(ROUND_ONE))).toEqual([
      { testid: "stage-pairing-fold", checked: "true", tabIndex: "0" },
      { testid: "stage-pairing-rank_adjacent", checked: "false", tabIndex: "-1" },
    ]);
  });

  it("a pick moves the check (and the tab stop) off the default", () => {
    expect(radios(panel(ROUND_ONE, "rank_adjacent"))).toEqual([
      { testid: "stage-pairing-fold", checked: "false", tabIndex: "-1" },
      { testid: "stage-pairing-rank_adjacent", checked: "true", tabIndex: "0" },
    ]);
  });

  it("each option names its mode, marks the default, and shows its seed hint", () => {
    const html = panel(ROUND_ONE);
    expect(html).toContain("Top vs bottom (default)");
    expect(html).toContain("1v6, 2v7, 3v8…");
    expect(html).toContain("Neighbours");
    expect(html).toContain("1v2, 3v4, 5v6…");
  });

  it("R1: seeds that are not 1..N get the generic hints — no seed number anywhere", () => {
    const html = panel({ ...ROUND_ONE, seedsNumbered: false });
    expect(html).toContain(en["schedule.pairing.hintFoldGeneric"]);
    expect(html).toContain(en["schedule.pairing.hintAdjacentGeneric"]);
    expect(html).not.toMatch(/\d+v\d+/);
  });

  it("every option clears the 44px tap floor", () => {
    const options = [...panel(ROUND_ONE).matchAll(/<button[^>]*role="radio"[^>]*>/g)].map((m) => m[0]);
    expect(options).toHaveLength(2); // positive pair: an empty list would pass the loop vacuously
    for (const option of options) expect(option).toMatch(/\bmin-h-11\b/);
  });

  describe("round 2+ opens read-only (spec ruling 3)", () => {
    const LATER: SwissPairingMenu = {
      round: 2, choosable: false, defaultPairing: "rank_adjacent", stored: "rank_adjacent", fieldSize: 10, seedsNumbered: true, unseededDrawn: false, seededAheadOfDraw: false,
    };

    it("the group is aria-disabled and named for the round", () => {
      const group = /<div[^>]*role="radiogroup"[^>]*>/.exec(panel(LATER))?.[0] ?? "";
      expect(group).toContain('aria-disabled="true"');
      expect(group).toContain('aria-label="Round 2 pairing"');
    });

    it("shows the stage's mode checked and nothing checkable", () => {
      const html = panel(LATER);
      expect(radios(html)).toEqual([{ testid: "stage-pairing-readonly", checked: "true", tabIndex: undefined }]);
      expect(html).not.toContain('aria-checked="false"');
      expect(html).not.toMatch(/<button[^>]*role="radio"/);
      expect(html).toMatch(/data-testid="stage-pairing-readonly"[^>]*aria-disabled="true"|aria-disabled="true"[^>]*data-testid="stage-pairing-readonly"/);
    });

    it("names the Hammes mode for a rank_adjacent stage, the fold mode otherwise", () => {
      expect(panel(LATER)).toContain(en["schedule.pairing.laterAdjacent"]);
      expect(panel(LATER)).not.toContain(en["schedule.pairing.laterFold"]);
      const plain = panel({ ...LATER, defaultPairing: "fold", stored: "fold" });
      expect(plain).toContain(en["schedule.pairing.laterFold"]);
      expect(plain).not.toContain(en["schedule.pairing.laterAdjacent"]);
    });

    it("says why, in visible text — a phone has no hover", () => {
      const html = panel(LATER);
      expect(html).toMatch(/data-testid="stage-pairing-hint"[^>]*>Mode is chosen in round 1 only\.</);
    });

    it("prints no seed hint — the later rounds pair by standings, not seeds", () => {
      expect(panel(LATER)).not.toMatch(/\d+v\d+/);
    });
  });
});

// Review M2 (Task 4): the pick used to be cleared the moment Pair next was
// CLICKED, before the press settled — so a press that failed (a 5xx, a dropped
// connection, a paywall) lost the organiser's round-1 choice, and the retry
// quietly paired top-vs-bottom. The pick now outlives any press that does not
// land, and is cleared only by one that does (spec: "resets after every
// press" — every SUCCESSFUL one). `onAct` resolves true/false to say which.
//
// Driven through `renderIsland`, not static markup: this is a click, a pick,
// and a promise settling between two clicks. `walk` never calls a child
// component, so the open menu is `SwissPairingMenuPanel`'s ELEMENT and the pick
// is made through the `onPick` the rail handed it — the same function the
// radio's click calls.
describe("StageRail — a press that does not land keeps the pick (review M2)", () => {
  const swiss = { id: "s1", name: "Swiss", kind: "swiss", seq: 1, status: "active", config: {} } as never;
  const ROUND_ONE: SwissPairingMenu = {
    round: 1, choosable: true, defaultPairing: "fold", stored: "rank_adjacent", fieldSize: 10, seedsNumbered: true, unseededDrawn: false, seededAheadOfDraw: false,
  };
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  function mount() {
    const sent: unknown[] = [];
    let settle: (landed: boolean) => void = () => {
      throw new Error("no press in flight");
    };
    const props: StageRailProps = {
      stage: swiss, canEdit: true, busy: null, fixtureCount: 10, deletable: false,
      onAct: (_stageId, action, opts) => {
        sent.push({ action, opts });
        return new Promise<boolean>((resolve) => {
          settle = resolve;
        });
      },
      onDelete: () => {}, addingTo: null, onToggleAddMatch: () => {}, adhoc: false, courtTagsSlot: null,
      ...NEUTRAL, swissHasUnseated: true, swissPairingMenu: ROUND_ONE,
    };
    const island = renderIsland(StageRail, props);
    const byTestid = (testid: string) => {
      const el = island.tree().find((e) => propsOf(e)["data-testid"] === testid);
      if (!el) throw new Error(`no ${testid} in the rail`);
      return el;
    };
    const menu = () => island.tree().find((e) => e.type === SwissPairingMenuPanel);
    return {
      sent,
      settle: (landed: boolean) => settle(landed),
      click: (testid: string) => (propsOf(byTestid(testid)).onClick as () => void)(),
      pick: (mode: "fold" | "rank_adjacent") => {
        const open = menu();
        if (!open) throw new Error("the menu is not open");
        (propsOf(open).onPick as (m: string) => void)(mode);
      },
      menu,
    };
  }

  it("a failed press keeps the pick, so the retry sends it; the press that lands clears it", async () => {
    const rail = mount();
    rail.click("stage-pairing-toggle");
    rail.pick("rank_adjacent");
    expect(propsOf(rail.menu()!).pick).toBe("rank_adjacent"); // premise: the pick took

    rail.click("stage-generate");
    expect(rail.sent).toEqual([{ action: "generate", opts: { pairing: "rank_adjacent" } }]);
    rail.settle(false);
    await flush();
    // Still on screen, still Neighbours — what the organiser last saw.
    expect(rail.menu(), "a failed press closed the menu and dropped the pick").toBeDefined();
    expect(propsOf(rail.menu()!).pick).toBe("rank_adjacent");

    // The retry sends the SAME pick — not the default the old reset fell to.
    rail.click("stage-generate");
    expect(rail.sent[1]).toEqual({ action: "generate", opts: { pairing: "rank_adjacent" } });
    rail.settle(true);
    await flush();
    // Landed: the pick was for that press only.
    expect(rail.menu(), "a press that landed left the menu open").toBeUndefined();
    rail.click("stage-pairing-toggle");
    expect(propsOf(rail.menu()!).pick, "a press that landed kept the pick").toBeNull();
  });

  it("a pick is not cleared while the press is still in flight", () => {
    // The old code cleared at CLICK time — this is the moment that bug lived in.
    const rail = mount();
    rail.click("stage-pairing-toggle");
    rail.pick("rank_adjacent");
    rail.click("stage-generate");
    expect(rail.menu(), "the click closed the menu before the press settled").toBeDefined();
    expect(propsOf(rail.menu()!).pick).toBe("rank_adjacent");
  });
});

// W3 T10 (X-SW-12; owner pick: option A, the rail's "More" menu). "Add late player" is offered on a ROOT Swiss stage
// once round 1 is paired, in a started division, until the stage is finished (controller ruling 2). It stays at the last
// round: the add is refused there by name (SWISS_NO_ROUND_LEFT), which is the organiser's answer, not a missing button.
// Before Start the ordinary add applies, so it is hidden there. The gate is the rail's own (`swissLateEntryOffered`),
// fed the facts the panel holds; the expected answers are the ruling's, typed here, never read back from the gate.
describe("StageRail — Add late player in the More menu (W3 T10)", () => {
  const HREF = "/o/acme/c/champs/d/open?tab=entrants#add-entrant";
  type Row = {
    name: string;
    stage: Record<string, unknown>;
    divisionStatus: string;
    roundSeated: boolean;
    offered: boolean;
  };
  const swiss = (over: Record<string, unknown> = {}) => ({
    id: "s1", name: "Swiss", kind: "swiss", seq: 1, status: "active", progression: null, config: { rounds: 5 }, ...over,
  });
  const ROWS: Row[] = [
    { name: "a started Swiss stage, round 1 paired", stage: swiss(), divisionStatus: "active", roundSeated: true, offered: true },
    { name: "a started Swiss at its last round (the add is refused there by name)", stage: swiss({ config: { rounds: 1 } }), divisionStatus: "active", roundSeated: true, offered: true },
    { name: "a setup Swiss stage, nothing paired", stage: swiss({ status: "pending" }), divisionStatus: "setup", roundSeated: false, offered: false },
    { name: "a Swiss paired before Start (the ordinary add applies)", stage: swiss({ status: "pending" }), divisionStatus: "scheduled", roundSeated: true, offered: false },
    { name: "a started Swiss with round 1 not yet paired", stage: swiss(), divisionStatus: "active", roundSeated: false, offered: false },
    { name: "a finished Swiss stage", stage: swiss({ status: "complete" }), divisionStatus: "active", roundSeated: true, offered: false },
    { name: "a Swiss fed by an earlier stage", stage: swiss({ progression: { from: "s0", top: 8 } }), divisionStatus: "active", roundSeated: true, offered: false },
    { name: "a league stage", stage: swiss({ kind: "league", name: "League" }), divisionStatus: "active", roundSeated: true, offered: false },
  ];
  const render = (r: Row) =>
    renderToStaticMarkup(
      <StageRail stage={r.stage as never} canEdit busy={null} fixtureCount={10} deletable={false}
        onAct={async () => true} onDelete={() => {}} addingTo={null} onToggleAddMatch={() => {}}
        adhoc={false} courtTagsSlot={null} {...NEUTRAL}
        lateEntry={{ divisionStatus: r.divisionStatus, roundSeated: r.roundSeated, href: HREF }} />,
    );

  it("a started Swiss stage renders add-late-player; a setup stage and a league stage do not", () => {
    let checked = 0;
    for (const r of ROWS) {
      const html = render(r);
      // Positive pair first: the rail rendered at all (its phone trigger renders in every state, a finished stage too),
      // so an absence below is the gate's, not an empty rail.
      expect(html, `${r.name}: the rail rendered nothing`).toContain('data-testid="stage-rail-trigger"');
      if (r.offered) {
        expect(html, r.name).toContain('data-testid="stage-more"');
        expect(html, r.name).toContain('data-testid="stage-more-menu"');
        expect(html, r.name).toContain('data-testid="stage-add-late-player"');
        expect(html, `${r.name}: it goes to the Entrants tab's add form`).toContain(`href="${HREF}"`);
        expect(html, r.name).toContain(en["stage.more.addLatePlayer"]);
      } else {
        expect(html, r.name).not.toContain('data-testid="stage-more"');
        expect(html, r.name).not.toContain("stage-add-late-player");
      }
      checked++;
    }
    expect(checked, "anti-vacuity: every row rendered").toBe(ROWS.length);
    expect(ROWS.filter((r) => r.offered).length, "both answers are in the table").toBeGreaterThan(0);
    expect(ROWS.filter((r) => !r.offered).length).toBeGreaterThan(0);
  });

  it("is absent with no lateEntry facts at all (every other caller of the rail)", () => {
    const html = renderToStaticMarkup(
      <StageRail stage={swiss() as never} canEdit busy={null} fixtureCount={10} deletable={false}
        onAct={async () => true} onDelete={() => {}} addingTo={null} onToggleAddMatch={() => {}}
        adhoc={false} courtTagsSlot={null} {...NEUTRAL} />,
    );
    expect(html).toContain('data-testid="stage-generate"');
    expect(html).not.toContain('data-testid="stage-more"');
  });

  it("opens folded: the menu is in the DOM but hidden, and More says it is collapsed; one press opens it, a second closes it", () => {
    const html = render(ROWS[0]!);
    expect(html).toMatch(/data-testid="stage-more"[^>]*aria-expanded="false"|aria-expanded="false"[^>]*data-testid="stage-more"/);
    expect(html).toMatch(/<div[^>]*data-testid="stage-more-menu"[^>]*hidden=""|<div[^>]*hidden=""[^>]*data-testid="stage-more-menu"/);

    const island = renderIsland(StageRail, {
      stage: swiss() as never, canEdit: true, busy: null, fixtureCount: 10, deletable: false,
      onAct: async () => true, onDelete: () => {}, addingTo: null, onToggleAddMatch: () => {}, adhoc: false, courtTagsSlot: null,
      ...NEUTRAL, lateEntry: { divisionStatus: "active", roundSeated: true, href: HREF },
    });
    const byTestid = (testid: string) => {
      const el = island.tree().find((e) => propsOf(e)["data-testid"] === testid);
      if (!el) throw new Error(`no ${testid} in the rail`);
      return el;
    };
    expect(propsOf(byTestid("stage-more")).hidden ?? false).toBe(false);
    expect(propsOf(byTestid("stage-more-menu")).hidden).toBe(true);
    (propsOf(byTestid("stage-more")).onClick as () => void)();
    expect(propsOf(byTestid("stage-more"))["aria-expanded"]).toBe(true);
    expect(propsOf(byTestid("stage-more-menu")).hidden).toBe(false);
    (propsOf(byTestid("stage-more")).onClick as () => void)();
    expect(propsOf(byTestid("stage-more-menu")).hidden).toBe(true);
  });
});

// W3 T12 Phase 2 (X-SW-17; owner pick B) — where the rail MOUNTS the rounds chip and "Add a round" (their own behaviour is
// pinned in swiss-rounds-dialog.test.tsx): the chip first on the action row, before Pair next; "Add a round" inside the
// More menu, after Add late player; neither without the panel's `swissRounds` (every other kind of stage).
describe("StageRail — the rounds chip and Add a round (W3 T12 Phase 2)", () => {
  const HREF = "/o/acme/c/champs/d/open?tab=entrants#add-entrant";
  const swiss = { id: "s1", name: "Swiss", kind: "swiss", seq: 1, status: "active", progression: null, config: { rounds: 3 } };
  const rounds = (started: boolean) => ({
    control: {
      started,
      rounds: 3,
      chess: false,
      field: 6,
      addRound: { canAddRound: true, refusal: null, field: 6, hardMax: 5 },
    },
    fixtures: [],
    onSave: async () => null,
    onAddRound: async () => null,
  });
  const render = (swissRounds: ReturnType<typeof rounds> | undefined) =>
    renderToStaticMarkup(
      <StageRail stage={swiss as never} canEdit busy={null} fixtureCount={9} deletable={false}
        onAct={async () => true} onDelete={() => {}} addingTo={null} onToggleAddMatch={() => {}}
        adhoc={false} courtTagsSlot={null} {...NEUTRAL} swissHasUnseated
        lateEntry={{ divisionStatus: "active", roundSeated: true, href: HREF }}
        {...(swissRounds ? { swissRounds } : {})} />,
    );

  it("the chip opens the action row, before Pair next; absent without the panel's swissRounds", () => {
    const html = render(rounds(false));
    const chip = html.indexOf('data-testid="stage-rounds"');
    const generate = html.indexOf('data-testid="stage-generate"');
    expect(chip, "the chip rendered").toBeGreaterThan(-1);
    expect(generate, "Pair next rendered").toBeGreaterThan(-1);
    expect(chip, "first on the row").toBeLessThan(generate);
    expect(html).toContain(en["stage.rounds.chip"].replace("{n}", "3"));
    expect(render(undefined), "no swissRounds, no chip").not.toContain('data-testid="stage-rounds"');
    expect(render(undefined)).toContain('data-testid="stage-generate"');
  });

  it("Add a round sits in the More menu after Add late player once the stage has started; not before", () => {
    const html = render(rounds(true));
    const menu = html.indexOf('data-testid="stage-more-menu"');
    const late = html.indexOf('data-testid="stage-add-late-player"');
    const add = html.indexOf('data-testid="stage-add-round"');
    expect(menu).toBeGreaterThan(-1);
    expect(late, "Add late player is in the menu").toBeGreaterThan(menu);
    expect(add, "Add a round follows it").toBeGreaterThan(late);
    expect(html).toContain(en["stage.more.addRound"]);
    expect(render(rounds(false)), "before the first start the dialog edits the count").not.toContain("stage-add-round");
    expect(render(rounds(false))).toContain('data-testid="stage-add-late-player"');
  });
});
