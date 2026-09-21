import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StageRail } from "../stage-rail";

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
};
const BADGE = <p data-testid="stage-unscheduled-count">3</p>;

describe("StageRail", () => {
  it("renders the three header controls with their testids", () => {
    const html = renderToStaticMarkup(
      <StageRail stage={stage} canEdit busy={null} fixtureCount={4} deletable
        onAct={() => {}} onDelete={() => {}} addingTo={null} onToggleAddMatch={() => {}}
        adhoc={false} courtTagsSlot={null} {...NEUTRAL} />,
    );
    expect(html).toContain('data-testid="stage-generate"');
    expect(html).toContain('data-testid="stage-complete"');
    expect(html).toContain('data-testid="stage-delete"');
  });

  it("renders nothing at all when the viewer cannot edit — even with a non-null badge slot", () => {
    const html = renderToStaticMarkup(
      <StageRail stage={stage} canEdit={false} busy={null} fixtureCount={4} deletable
        onAct={() => {}} onDelete={() => {}} addingTo={null} onToggleAddMatch={() => {}}
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
          onAct={() => {}} onDelete={() => {}} addingTo={null} onToggleAddMatch={() => {}}
          adhoc courtTagsSlot={null} {...NEUTRAL} />,
      ),
    );
    pin(
      "closed, with an unscheduled count — precisely when the CTA used to appear",
      renderToStaticMarkup(
        <StageRail stage={stage} canEdit busy={null} fixtureCount={4} deletable
          onAct={() => {}} onDelete={() => {}} addingTo={null} onToggleAddMatch={() => {}}
          adhoc courtTagsSlot={null} {...NEUTRAL} unscheduledBadgeSlot={BADGE} />,
      ),
    );
    pin(
      "phone sheet open, with an unscheduled count",
      renderToStaticMarkup(
        <StageRail stage={stage} canEdit busy={null} fixtureCount={4} deletable
          onAct={() => {}} onDelete={() => {}} addingTo={null} onToggleAddMatch={() => {}}
          adhoc courtTagsSlot={null} {...NEUTRAL} open unscheduledBadgeSlot={BADGE} />,
      ),
    );
  });

  it("renders the Add match control for an ad-hoc stage kind, and omits it for a kind not in ADHOC_STAGE_KINDS", () => {
    const adhocHtml = renderToStaticMarkup(
      <StageRail stage={stage} canEdit busy={null} fixtureCount={4} deletable
        onAct={() => {}} onDelete={() => {}} addingTo={null} onToggleAddMatch={() => {}}
        adhoc courtTagsSlot={null} {...NEUTRAL} />,
    );
    expect(adhocHtml).toContain('data-testid="stage-add-match"');

    const nonAdhocHtml = renderToStaticMarkup(
      <StageRail stage={stage} canEdit busy={null} fixtureCount={4} deletable
        onAct={() => {}} onDelete={() => {}} addingTo={null} onToggleAddMatch={() => {}}
        adhoc={false} courtTagsSlot={null} {...NEUTRAL} />,
    );
    expect(nonAdhocHtml).not.toContain('data-testid="stage-add-match"');
  });

  it("renders courtTagsSlot content where given", () => {
    const html = renderToStaticMarkup(
      <StageRail stage={stage} canEdit busy={null} fixtureCount={4} deletable
        onAct={() => {}} onDelete={() => {}} addingTo={null} onToggleAddMatch={() => {}}
        adhoc={false} courtTagsSlot={<i data-testid="ct-slot" />} {...NEUTRAL} />,
    );
    expect(html).toContain('data-testid="ct-slot"');
  });

  it("renders no pinned section at all — no badge — when unscheduledBadgeSlot is null", () => {
    const html = renderToStaticMarkup(
      <StageRail stage={stage} canEdit busy={null} fixtureCount={4} deletable
        onAct={() => {}} onDelete={() => {}} addingTo={null} onToggleAddMatch={() => {}}
        adhoc={false} courtTagsSlot={null} {...NEUTRAL} />,
    );
    expect(html).not.toContain('data-testid="stage-unscheduled-count"');
  });

  it("Swiss with zero fixtures labels Generate; with unseated shells labels Pair next", () => {
    const swiss = { id: "s1", name: "Swiss", kind: "swiss", seq: 1, status: "active" } as never;
    const empty = renderToStaticMarkup(
      <StageRail stage={swiss} canEdit busy={null} fixtureCount={0} deletable={false}
        onAct={() => {}} onDelete={() => {}} addingTo={null} onToggleAddMatch={() => {}}
        adhoc={false} courtTagsSlot={null} {...NEUTRAL} />,
    );
    expect(empty).toContain("Generate fixtures");
    expect(empty).not.toContain("Pair next round");

    const unseated = renderToStaticMarkup(
      <StageRail stage={swiss} canEdit busy={null} fixtureCount={8} deletable={false}
        onAct={() => {}} onDelete={() => {}} addingTo={null} onToggleAddMatch={() => {}}
        adhoc={false} courtTagsSlot={null} {...NEUTRAL} swissHasUnseated canUnpairSwiss={false} />,
    );
    expect(unseated).toContain("Pair next round");
    expect(unseated).not.toContain("Generate fixtures");
  });

  it("renders stage-unpair only when canUnpairSwiss is true on a swiss stage", () => {
    const swiss = { id: "s1", name: "Swiss", kind: "swiss", seq: 1, status: "active" } as never;
    const withUnpair = renderToStaticMarkup(
      <StageRail stage={swiss} canEdit busy={null} fixtureCount={4} deletable={false}
        onAct={() => {}} onDelete={() => {}} addingTo={null} onToggleAddMatch={() => {}}
        adhoc={false} courtTagsSlot={null} {...NEUTRAL} swissHasUnseated={false} canUnpairSwiss />,
    );
    expect(withUnpair).toContain('data-testid="stage-unpair"');

    const without = renderToStaticMarkup(
      <StageRail stage={swiss} canEdit busy={null} fixtureCount={4} deletable={false}
        onAct={() => {}} onDelete={() => {}} addingTo={null} onToggleAddMatch={() => {}}
        adhoc={false} courtTagsSlot={null} {...NEUTRAL} />,
    );
    expect(without).not.toContain('data-testid="stage-unpair"');
  });

  it("renders whatever unscheduledBadgeSlot element it is given, verbatim — the rail builds no badge markup of its own", () => {
    const html = renderToStaticMarkup(
      <StageRail stage={stage} canEdit busy={null} fixtureCount={4} deletable
        onAct={() => {}} onDelete={() => {}} addingTo={null} onToggleAddMatch={() => {}}
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
        onAct={() => {}} onDelete={() => {}} addingTo={null} onToggleAddMatch={() => {}}
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
