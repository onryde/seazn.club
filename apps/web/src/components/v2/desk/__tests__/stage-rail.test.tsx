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
    round: 1, choosable: true, defaultPairing: "fold", stored: "rank_adjacent", fieldSize: 10, seedsNumbered: true,
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
    round: 1, choosable: true, defaultPairing: "fold", stored: "rank_adjacent", fieldSize: 10, seedsNumbered: true,
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
      round: 2, choosable: false, defaultPairing: "rank_adjacent", stored: "rank_adjacent", fieldSize: 10, seedsNumbered: true,
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
    round: 1, choosable: true, defaultPairing: "fold", stored: "rank_adjacent", fieldSize: 10, seedsNumbered: true,
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
