// The run sheet's stream mount (Stream Overlay W1, task 6).
//
// The gate is `canEdit && stream.entitled` and BOTH conjuncts are mutated
// separately here: two guards covering for each other are each untested
// (AGENTS.md class 3). The row is driven with `renderIsland` rather than
// `renderToStaticMarkup` because the expander is behind `useState` — a static
// render can see the toggle but never what it opens.
import { describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderIsland, propsOf } from "@/components/__tests__/_hook-harness";
import { RunSheetRow } from "@/components/v2/desk/run-sheet-row";
import {
  FixtureStreamPanel,
  FixtureStreamToggle,
  type StreamPanelContext,
} from "@/components/v2/fixture-stream-panel";
import { isBye, type RunSheetFixture } from "@/lib/run-sheet-groups";

// The fixture stream panel (imported through the run sheet) reads the checkout-return URL and strips it (G5).
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(""),
}));

const TZ = "Europe/London";
// DELIBERATELY different from `tz`. The row carries both zones and hands the
// panel the VENUE one; with the two equal, a mutant that passes `orgTz`
// instead would look identical (AGENTS.md class 7 — one sample is not a
// parity sweep).
const ORG_TZ = "UTC";
const NOW_MS = Date.UTC(2026, 8, 10, 12, 0, 0);
const ENTRANTS = { e1: "Alpha", e2: "Bravo" };

function fx(o: Partial<RunSheetFixture> = {}): RunSheetFixture {
  return {
    id: "f1",
    stage_id: "s1",
    fixture_no: 1,
    round_no: 1,
    seq_in_round: 1,
    scheduled_at: "2026-09-10T14:00:00.000Z",
    status: "scheduled",
    court_name: null,
    court_id: null,
    venue_name: null,
    officials: [],
    outcome: null,
    home_entrant_id: "e1",
    away_entrant_id: "e2",
    home_slot_label: null,
    away_slot_label: null,
    lane: null,
    is_final: false,
    third_place: false,
    conditional: false,
    ext_key: null,
    ...o,
  };
}

function ctx(o: Partial<StreamPanelContext> = {}): StreamPanelContext {
  return {
    entitled: true,
    relayEntitled: false,
    relayDisabled: false,
    sportKey: "football",
    overlayDict: {},
    orgId: "o-1",
    streamBalance: 0,
    streamSplit: null,
    monthlyAllowance: 0,
    currency: "gbp",
    ...o,
  };
}

function row(options: { canEdit?: boolean; stream?: StreamPanelContext; fixture?: RunSheetFixture } = {}) {
  return renderIsland(RunSheetRow, {
    fixture: options.fixture ?? fx(),
    href: "/f/1",
    tz: TZ,
    orgTz: ORG_TZ,
    nowMs: NOW_MS,
    canEdit: options.canEdit ?? true,
    entrantNames: ENTRANTS,
    stream: options.stream ?? ctx(),
  });
}

const find = (tree: ReactElement[], type: unknown): ReactElement | undefined =>
  tree.find((el) => el.type === type);

/** The POSITIVE pair for every "absent" assertion below: without it a blank
 *  render would satisfy all four negative cases. */
function expectRowRendered(tree: ReactElement[]): void {
  expect(
    tree.some((el) => propsOf(el)["data-testid"] === "run-sheet-edit-time" || propsOf(el).href === "/f/1"),
    "the row itself did not render, so every negative assertion below is vacuous",
  ).toBe(true);
}

describe("the stream toggle's gate — each conjunct on its own", () => {
  it("canEdit AND entitled: the toggle is there", () => {
    const tree = row().tree();
    expectRowRendered(tree);
    expect(find(tree, FixtureStreamToggle)).toBeDefined();
  });

  it("entitled but NOT canEdit: no toggle", () => {
    const tree = row({ canEdit: false }).tree();
    expectRowRendered(tree);
    expect(find(tree, FixtureStreamToggle)).toBeUndefined();
    expect(find(tree, FixtureStreamPanel)).toBeUndefined();
  });

  it("canEdit but NOT entitled: no toggle and NEVER an upsell", () => {
    const tree = row({ stream: ctx({ entitled: false }) }).tree();
    expectRowRendered(tree);
    expect(find(tree, FixtureStreamToggle)).toBeUndefined();
    expect(find(tree, FixtureStreamPanel)).toBeUndefined();
  });

  it("no stream context at all (a caller that never threaded it): no toggle", () => {
    const island = renderIsland(RunSheetRow, {
      fixture: fx(),
      href: "/f/1",
      tz: TZ,
      orgTz: ORG_TZ,
      nowMs: NOW_MS,
      canEdit: true,
      entrantNames: ENTRANTS,
    });
    expectRowRendered(island.tree());
    expect(find(island.tree(), FixtureStreamToggle)).toBeUndefined();
  });
});

describe("what the toggle opens", () => {
  it("is closed at first, and opening it mounts the panel on THIS fixture", () => {
    const island = row();
    expect(find(island.tree(), FixtureStreamPanel), "the panel must not mount closed").toBeUndefined();
    const toggle = find(island.tree(), FixtureStreamToggle)!;
    expect(propsOf(toggle).open).toBe(false);
    // The row's one line for the checkout return (owner ruling 4): the toggle is told WHICH fixture it is, so a
    // `?stream=open&fixture=<id>` URL opens this row and no other.
    expect(propsOf(toggle).fixtureId).toBe("f1");
    (propsOf(toggle).onToggle as () => void)();
    const panel = find(island.tree(), FixtureStreamPanel);
    expect(panel, "opening the toggle did not mount the panel").toBeDefined();
    expect(propsOf(find(island.tree(), FixtureStreamToggle)!).open).toBe(true);
    expect((propsOf(panel!).fixture as { id: string }).id).toBe("f1");
    expect(propsOf(panel!).tz, "the VENUE zone, the one the row prints in").toBe(TZ);
    expect(propsOf(panel!).tz, "never the ORG zone").not.toBe(ORG_TZ);
    expect(propsOf(panel!).entrantNames).toBe(ENTRANTS);
    expect((propsOf(panel!).stream as StreamPanelContext).sportKey).toBe("football");
  });

  it("closing it again unmounts the panel, so nothing polls behind a shut row", () => {
    const island = row();
    (propsOf(find(island.tree(), FixtureStreamToggle)!).onToggle as () => void)();
    (propsOf(find(island.tree(), FixtureStreamToggle)!).onToggle as () => void)();
    expect(find(island.tree(), FixtureStreamPanel)).toBeUndefined();
  });
});

describe("every fixture status, not just the schedulable ones", () => {
  // Owner Q6 ("Agree"): a club pastes the replay link after the final whistle,
  // so the toggle is NOT gated on `canEditFixtureTime`, which hides the row's
  // time editor by status.
  it.each(["scheduled", "in_play", "decided", "finalized", "cancelled", "abandoned"])(
    "%s carries the toggle",
    (status) => {
      const tree = row({ fixture: fx({ status }) }).tree();
      expectRowRendered(tree);
      expect(find(tree, FixtureStreamToggle), `${status} lost the toggle`).toBeDefined();
    },
  );

  it("a BYE never carries one — it is structural, never broadcast", () => {
    // `isBye` is an AWARD outcome with one side empty, not merely an empty
    // side (run-sheet-groups.ts) — a fixture missing only an entrant id is an
    // ordinary undrawn row and DOES keep its toggle.
    const bye = fx({ away_entrant_id: null, status: "decided", outcome: { kind: "award" } });
    expect(isBye(bye), "premise: this fixture really is a bye").toBe(true);
    expect(find(row({ fixture: bye }).tree(), FixtureStreamToggle)).toBeUndefined();
    expect(
      find(row({ fixture: fx({ away_entrant_id: null }) }).tree(), FixtureStreamToggle),
      "an undrawn side is not a bye",
    ).toBeDefined();
  });
});
