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
    sourceReady: true,
    fixtures: FIXTURES,
    entrantNames: ENTRANT_NAMES,
    stageNames: STAGE_NAMES,
    departedEntrantIds: [],
    confirmedDrawReopens: false,
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

  it("renders nothing while the source stage hasn't completed (sourceReady=false)", () => {
    const html = renderToStaticMarkup(<ProgressionPanel {...baseProps({ proposal: null, sourceReady: false })} />);
    expect(html).toBe("");
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

describe("ProgressionPanel — a draft with NOBODY in it (review finding F1)", () => {
  // Reachable since departed qualifiers stopped being offered: withdraw every
  // qualifier of a small bracket and the slate is empty. What the organiser
  // was shown then was the ordinary draft branch — four column headers, zero
  // rows, and ONE control, Confirm — and pressing it burned the stage into
  // the terminal `confirmed` status with `filled: 0`, after which Recompute
  // 409s forever. The server refuses that now; this is the screen side of the
  // same fix, because a lone Confirm whose only outcome is a 422 is the same
  // dead end one step later.
  const emptyDraft: SeedProposal = {
    ...DRAFT,
    computed: { ...DRAFT.computed, qualifiers: [], ties: [] },
  };

  it("says what happened and offers Recompute — never a bare Confirm over an empty table", () => {
    const html = renderToStaticMarkup(<ProgressionPanel {...baseProps({ proposal: emptyDraft })} />);
    expect(html).toContain('data-progression-state="draft-empty"');
    expect(html).toContain("Nobody has qualified for this stage");
    // Anchored on the BUTTON, not on the word: `progression.noQualifiersLeft`
    // ends "...Recompute once the field is settled", so a bare
    // `toContain("Recompute")` is satisfied by the paragraph alone and stayed
    // green with the button deleted (re-review M1/N17b). A card that explains
    // the dead end without offering the way out of it is the defect F1 exists
    // to close.
    expect(html).toMatch(/<button[^>]*>\s*Recompute\s*<\/button>/);
    expect(html).not.toContain("Confirm proposal");
    expect(html).not.toContain("<table");
  });

  it("the control: ONE surviving qualifier is still an ordinary draft to confirm", () => {
    // The guard must key on an EMPTY slate, not on a short one — a draw that
    // lost somebody but still seats a survivor is exactly the F2 walkover
    // case, and it must stay confirmable.
    const shortDraft: SeedProposal = {
      ...DRAFT,
      computed: { ...DRAFT.computed, qualifiers: [DRAFT.computed.qualifiers[0]!], ties: [] },
    };
    const html = renderToStaticMarkup(<ProgressionPanel {...baseProps({ proposal: shortDraft })} />);
    expect(html).toContain('data-progression-state="draft"');
    expect(html).toContain("Confirm proposal");
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

// W4 B1b review M11 (controller ruling, fix round 1): since W4 T5 a confirmed draw is an undo barrier - Undo, Redo and
// Restore refuse to cross it (SEED_CONFIRM_NOT_UNDOABLE) and Recompute is refused for good. The organiser is told so
// BEFORE pressing Confirm, as the Swiss rounds dialog says its own barrier before Save (swiss-rounds-dialog.tsx), so the
// lock is never a surprise. The sentences are typed here (the ruling's), never read back from the panel.
//
// W4 B6a fix round 1 (review #1): the second sentence - "If a result it was drawn from is corrected before play starts, you
// can recompute it" - is true only where the SERVER reopens a confirmed draw: a correction inside a completed KNOCKOUT
// source (scoring.ts, W4 T14). A table source (groups, league, Swiss ...) is refused SEEDING_ALREADY_CONFIRMED for good, so
// there the panel says the first sentence alone. The panel's `confirmedDrawReopens` prop carries the page's verdict.
describe("ProgressionPanel - Confirm warns that a confirmed draw can't be undone (M11), and promises a recompute only where one exists", () => {
  const KEY = "progression.confirmFinal";
  const RECOMPUTE_KEY = "progression.confirmFinalRecompute";
  const UNDO = "Once confirmed, Undo can't take this draw back.";
  const RECOMPUTE = "If a result it was drawn from is corrected before play starts, you can recompute it.";
  const noTies: SeedProposal = { ...DRAFT, computed: { ...DRAFT.computed, ties: [] } };
  const WARN = /<p[^>]*data-testid="progression-confirm-final"[^>]*>([^<]*)<\/p>/;
  const said = (html: string) => html.match(WARN)?.[1]?.replaceAll("&#x27;", "'");

  it("the empty cases first: no proposal, a draft with nobody in it, a stale one and a confirmed one carry no warning (none has Confirm)", () => {
    const states: [string, SeedProposal | null][] = [
      ["no proposal", null],
      ["draft-empty", { ...DRAFT, computed: { ...DRAFT.computed, qualifiers: [], ties: [] } }],
      ["stale", { ...DRAFT, status: "stale" }],
      ["confirmed", { ...DRAFT, status: "confirmed" }],
    ];
    let checked = 0;
    for (const [what, proposal] of states) {
      for (const confirmedDrawReopens of [false, true]) {
        const html = renderToStaticMarkup(<ProgressionPanel {...baseProps({ proposal, confirmedDrawReopens })} />);
        expect(html, `${what}: premise, the card rendered`).not.toBe("");
        expect(html, `${what}: no Confirm`).not.toContain("Confirm proposal");
        expect(html, `${what}: no warning`).not.toContain('data-testid="progression-confirm-final"');
        checked++;
      }
    }
    expect(checked, "anti-vacuity: every Confirm-less state, both verdicts").toBe(8);
  });

  it("a table source (the draw can never be reopened): the first sentence ALONE - no recompute promise, whether Confirm is live or waiting on a tie", () => {
    let checked = 0;
    for (const proposal of [noTies, DRAFT]) {
      const html = renderToStaticMarkup(<ProgressionPanel {...baseProps({ proposal, confirmedDrawReopens: false })} />);
      expect(said(html), "the warning is the first sentence alone").toBe(UNDO);
      expect(html).not.toContain("recompute");
      expect(html.indexOf('data-testid="progression-confirm-final"'), "said before the Confirm button").toBeLessThan(
        html.search(/<button[^>]*>\s*Confirm proposal\s*<\/button>/),
      );
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("a knockout source (a corrected result reopens the draw before play): both sentences, in order, in the one warning", () => {
    let checked = 0;
    for (const proposal of [noTies, DRAFT]) {
      const html = renderToStaticMarkup(<ProgressionPanel {...baseProps({ proposal, confirmedDrawReopens: true })} />);
      expect(said(html), "the warning is both sentences").toBe(`${UNDO} ${RECOMPUTE}`);
      expect(html.indexOf('data-testid="progression-confirm-final"'), "said before the Confirm button").toBeLessThan(
        html.search(/<button[^>]*>\s*Confirm proposal\s*<\/button>/),
      );
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("is said in the reader's language: all four dictionaries carry both sentences, translated, and the panel renders each branch", async () => {
    const { DictProvider } = await import("@/components/i18n/dict-provider");
    const dicts = {
      en: (await import("@/dictionaries/en/ui.json")).default,
      es: (await import("@/dictionaries/es/ui.json")).default,
      fr: (await import("@/dictionaries/fr/ui.json")).default,
      nl: (await import("@/dictionaries/nl/ui.json")).default,
    } as unknown as Record<"en" | "es" | "fr" | "nl", Record<string, string>>;
    expect(dicts.en[KEY], "en is the ruling's first sentence").toBe(UNDO);
    expect(dicts.en[RECOMPUTE_KEY], "en is the ruling's second sentence").toBe(RECOMPUTE);
    let checked = 0;
    for (const [locale, dict] of Object.entries(dicts) as ["en" | "es" | "fr" | "nl", Record<string, string>][]) {
      for (const [key, english] of [[KEY, UNDO], [RECOMPUTE_KEY, RECOMPUTE]] as const) {
        const value = dict[key];
        expect(typeof value === "string" && value.trim() !== "", `${locale}/${key} is missing`).toBe(true);
        if (locale !== "en") expect(value, `${locale}/${key} copies the English`).not.toBe(english);
      }
      for (const reopens of [false, true]) {
        const html = renderToStaticMarkup(
          <DictProvider dict={dict as never} locale={locale}>
            <ProgressionPanel {...baseProps({ proposal: noTies, locale, confirmedDrawReopens: reopens })} />
          </DictProvider>,
        );
        const want = reopens ? `${dict[KEY]} ${dict[RECOMPUTE_KEY]}` : dict[KEY];
        expect(said(html), `${locale}, reopens=${reopens}: the panel renders its own dictionary's sentence(s)`).toBe(want);
        checked++;
      }
    }
    expect(checked, "anti-vacuity: four locales, both branches").toBe(8);
  });
});

// W4 app PR B, Task 8 (X-PL-5, X-PL-2): the plate's stage card, told where its field stands (`lib/plate-card-state.ts`).
describe("ProgressionPanel - the plate's card", () => {
  it("waiting: says it draws after round 2 and how many first matches are decided, with NO Compute button (the source is not complete)", () => {
    const html = renderToStaticMarkup(
      <ProgressionPanel {...baseProps({ sourceReady: false, plate: { state: "waiting", done: 2, total: 4 } })} />,
    );
    expect(html).toContain('data-progression-state="plate-waiting"');
    expect(html).toContain("Plate draws after round 2 — 2 of 4 first matches decided");
    expect(html).not.toContain("<button");
  });
  it("too small: names the outcome, no button", () => {
    const html = renderToStaticMarkup(<ProgressionPanel {...baseProps({ sourceReady: false, plate: { state: "too_small" } })} />);
    expect(html).toContain('data-progression-state="plate-too-small"');
    expect(html).toContain("Not enough first-match losers for a plate");
    expect(html).not.toContain("<button");
  });
  it("ready with no proposal: the ordinary empty card with Compute (the field is known though the main draw is not complete)", () => {
    const html = renderToStaticMarkup(<ProgressionPanel {...baseProps({ sourceReady: false, plate: { state: "ready" } })} />);
    expect(html).toContain('data-progression-state="empty"');
  });
  it("ready WITH a draft proposal: the ordinary draft card, the waiting copy is gone", () => {
    const html = renderToStaticMarkup(<ProgressionPanel {...baseProps({ proposal: DRAFT, plate: { state: "ready" } })} />);
    expect(html).toContain('data-progression-state="draft"');
    expect(html).not.toContain("plate-waiting");
  });
  it("a stage that is no plate (plate null) with its source not ready still renders nothing", () => {
    expect(renderToStaticMarkup(<ProgressionPanel {...baseProps({ sourceReady: false, plate: null })} />)).toBe("");
  });
  it("the copy exists in all four locales with the placeholders intact", async () => {
    for (const l of ["en", "es", "fr", "nl"]) {
      const ui = (await import(`@/dictionaries/${l}/ui.json`)).default as Record<string, string>;
      expect(ui["plate.drawsAfterRound2"], `${l}: drawsAfterRound2`).toMatch(/\{done\}.*\{total\}|\{total\}.*\{done\}/);
      expect(ui["plate.tooSmall"]?.length, `${l}: tooSmall`).toBeGreaterThan(10);
    }
  });
});
