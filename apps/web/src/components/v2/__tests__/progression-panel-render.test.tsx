// ProgressionPanel — static structural rendering (renderToStaticMarkup; this
// workspace has no jsdom — see component-ui-i18n memory). Covers the states
// that are pure functions of PROPS at initial mount (empty/stale/confirmed/
// canEdit), which renderToStaticMarkup proves without needing interaction.
//
// The REGRESSION this file exists for (P6/D4b task B acceptance criteria):
// "a stale proposal surfaces the banner rather than silently confirming" —
// proved structurally below, not just by a disabled attribute: the stale
// branch renders NO confirm button at all.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

import { ProgressionPanel, type ProgressionPanelProps, type SeedProposal } from "@/components/v2/progression-panel";

const ENTRANT_NAMES = { e1: "Alice", e2: "Bob", e3: "Carol" };
const STAGE_NAMES = { grp: "Groups" };
const FIXTURES = [
  {
    id: "f1",
    home_slot_label: { key: "slot.winner_group", params: { g: "A" } },
    away_slot_label: { key: "slot.winner_group", params: { g: "B" } },
  },
];

function baseProps(overrides: Partial<ProgressionPanelProps> = {}): ProgressionPanelProps {
  return {
    stageId: "ko1",
    stageName: "Knockout",
    proposal: null,
    fixtures: FIXTURES,
    entrantNames: ENTRANT_NAMES,
    stageNames: STAGE_NAMES,
    locale: "en",
    canEdit: true,
    ...overrides,
  };
}

const DRAFT: SeedProposal = {
  id: "p1",
  stageId: "ko1",
  status: "draft",
  computed: {
    qualifiers: [
      { rank: 1, source: { stageId: "grp", group: "A", rank: 1 }, entrantId: "e1", destinationSlot: "f1:home" },
      { rank: 2, source: { stageId: "grp", group: "B", rank: 1 }, entrantId: "e3", destinationSlot: "f1:away" },
    ],
    ties: [{ slots: ["f1:home"], entrantIds: ["e1", "e2"], reason: "seed" }],
    standingsHash: "h1",
  },
};

describe("ProgressionPanel — canEdit gate", () => {
  it("renders nothing for a viewer (canEdit=false), regardless of proposal state", () => {
    const html = renderToStaticMarkup(<ProgressionPanel {...baseProps({ canEdit: false, proposal: DRAFT })} />);
    expect(html).toBe("");
  });
});

describe("ProgressionPanel — no proposal yet", () => {
  it("shows the empty-state copy and a Compute CTA, no table", () => {
    const html = renderToStaticMarkup(<ProgressionPanel {...baseProps({ proposal: null })} />);
    expect(html).toContain('data-progression-state="empty"');
    expect(html).toContain("No proposal yet for this stage.");
    expect(html).toContain("Compute proposal");
    expect(html).not.toContain("<table");
  });
});

describe("ProgressionPanel — stale proposal (regression: banner, never a silent confirm)", () => {
  const stale: SeedProposal = { ...DRAFT, status: "stale" };

  it("surfaces the stale banner", () => {
    const html = renderToStaticMarkup(<ProgressionPanel {...baseProps({ proposal: stale })} />);
    expect(html).toContain('data-progression-state="stale"');
    expect(html).toContain("Standings changed since this proposal was computed");
  });

  it("renders NO confirm affordance at all — not just disabled, structurally absent", () => {
    const html = renderToStaticMarkup(<ProgressionPanel {...baseProps({ proposal: stale })} />);
    expect(html).not.toContain("Confirm proposal");
    expect(html).not.toContain("<table");
    expect(html).not.toContain("<select");
  });

  it("offers Recompute instead", () => {
    const html = renderToStaticMarkup(<ProgressionPanel {...baseProps({ proposal: stale })} />);
    expect(html).toContain("Recompute");
  });
});

describe("ProgressionPanel — already confirmed", () => {
  const confirmed: SeedProposal = { ...DRAFT, status: "confirmed" };

  it("shows the confirmed note and NO mutating controls", () => {
    const html = renderToStaticMarkup(<ProgressionPanel {...baseProps({ proposal: confirmed })} />);
    expect(html).toContain('data-progression-state="confirmed"');
    // No apostrophe in this clause — React escapes "'" to "&#x27;" in markup
    // (component-ui-i18n memory), so the full sentence is never a raw substring.
    expect(html).toContain("were filled from a confirmed proposal.");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("<select");
  });
});

describe("ProgressionPanel — draft table structure", () => {
  it("the wide table scrolls in its OWN container, never the page (overflow-x-auto)", () => {
    const html = renderToStaticMarkup(<ProgressionPanel {...baseProps({ proposal: DRAFT })} />);
    expect(html).toMatch(/class="overflow-x-auto"[^>]*>\s*<table/);
  });

  it("a TIED row is visually flagged via data-progression-tied=\"true\" — anchored on '=\"', not a bare probe (React serialises an omitted prop as \"$undefined\")", () => {
    const html = renderToStaticMarkup(<ProgressionPanel {...baseProps({ proposal: DRAFT })} />);
    expect(html).toContain('data-progression-tied="true"');
    // The non-tied row (f1:away) must NOT also read as tied.
    expect(html).toMatch(/data-progression-row="f1:away"[^>]*data-progression-tied="false"/);
    expect(html).toContain("Tied — choose who fills this slot");
  });

  it("the tied row's select is touch-friendly (min-h-11) and offers a blank placeholder, never pre-selecting the engine's provisional pick", () => {
    const html = renderToStaticMarkup(<ProgressionPanel {...baseProps({ proposal: DRAFT })} />);
    expect(html).toMatch(/<select[^>]*class="select min-h-11[^"]*"[^>]*>/);
    expect(html).toContain("Choose an entrant…");
  });

  it("destination-slot text resolves through the REAL slot-label dictionary — 'Winner of Group A', never a raw slot.* key or hardcoded 'TBD'", () => {
    const html = renderToStaticMarkup(<ProgressionPanel {...baseProps({ proposal: DRAFT })} />);
    expect(html).toContain("Winner of Group A");
    expect(html).toContain("Winner of Group B");
    expect(html).not.toContain("slot.winner_group");
  });

  it("the source column names the standings origin, distinct from the destination-slot column", () => {
    const html = renderToStaticMarkup(<ProgressionPanel {...baseProps({ proposal: DRAFT })} />);
    expect(html).toContain("Groups");
    expect(html).toMatch(/Pool A.*rank 1|rank 1.*Pool A/);
  });

  it("Confirm starts disabled (anchored on the real disabled=\"\" attribute, not the CSS class every button carries)", () => {
    const html = renderToStaticMarkup(<ProgressionPanel {...baseProps({ proposal: DRAFT })} />);
    expect(html).toMatch(/Confirm proposal<\/button>/);
    const btnMatch = html.match(/<button[^>]*>\s*Confirm proposal\s*<\/button>/);
    expect(btnMatch).toBeTruthy();
    expect(btnMatch![0]).toMatch(/disabled=""/);
  });

  it("a proposal with ZERO ties starts with Confirm enabled — no disabled=\"\" attribute at all", () => {
    const noTies: SeedProposal = { ...DRAFT, computed: { ...DRAFT.computed, ties: [] } };
    const html = renderToStaticMarkup(<ProgressionPanel {...baseProps({ proposal: noTies })} />);
    const btnMatch = html.match(/<button[^>]*>\s*Confirm proposal\s*<\/button>/);
    expect(btnMatch![0]).not.toMatch(/disabled=""/);
  });
});
