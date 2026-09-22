// "Publish all" on the COMPETITION board — the banner, its predicate, and the
// one gate that covers the whole set.
//
// WHY THIS EXISTS. `public_fixtures_v` (V401) NULLs `scheduled_at`, `venue` and
// `court_label` for every fixture whose division is still at `status = 'setup'`.
// The only control that moved a division out of setup was the single-division
// Publish button, which renders only when `divisions.length === 1`. So a
// nine-division competition board showed the organiser real times, showed the
// public "Time TBD" for every match, and had no publish path and no symptom.
//
// There is no jsdom in this workspace (vitest `environment: "node"`), so this
// file works the two ways this repo works:
//   * the PURE rules (which divisions are unreleased, whether the banner shows
//     at all, how an outcome partitions) are exported functions, tested directly
//     — extracted precisely so the coverage can be honest rather than a render
//     test that cannot run;
//   * the banner's MARKUP through `renderToStaticMarkup` under a real
//     DictProvider, so the sentences asserted are the shipped ones;
//   * the WIRING through the shared hook harness, which drives production's own
//     `onClick` one level deep — the join between a press and what it POSTs.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DictProvider } from "@/components/i18n/dict-provider";
import type { Dict, Locale } from "@/lib/i18n-constants";
import en from "@/dictionaries/en/ui.json";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import type {
  BoardConflict,
  BoardDivision,
  BoardFixture,
  BoardStage,
  PublishAllDivisionResult,
  PublishAllOutcome,
} from "../types";

const nav = vi.hoisted(() => ({ refresh: vi.fn(), replace: vi.fn(), push: vi.fn(), search: "" }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: nav.refresh, replace: nav.replace, push: nav.push }),
  usePathname: () => "/o/acme/c/cup/schedule",
  useSearchParams: () => new URLSearchParams(nav.search),
}));

// `useLocale`/`usePlural` THROW outside a DictProvider and the harness has no
// provider tree; `useMsg` falls back to the real English catalog, which is the
// production path. Both stand-ins run the REAL runtime against the REAL
// catalog rather than returning a stub, so a missing key still shows up.
vi.mock("@/components/i18n/dict-provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/i18n/dict-provider")>();
  const { plural: pluralRuntime } = await import("@/lib/i18n-runtime");
  const { messages } = await import("@/lib/messages");
  return {
    ...actual,
    useLocale: () => "en" as const,
    usePlural:
      () =>
      (key: string, count: number, vars?: Record<string, string | number>) =>
        pluralRuntime(messages, key, count, "en", vars),
  };
});

vi.mock("@/lib/analytics", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/analytics")>();
  return { ...actual, track: vi.fn() };
});

/** Every POST the board made, and the answers queued for the publish-all one. */
const net = vi.hoisted(() => ({
  calls: [] as { url: string; method?: string; json?: unknown }[],
  publishAll: [] as unknown[],
}));

vi.mock("@/lib/client-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-v1")>();
  return {
    ...actual,
    apiV1: (url: string, options?: { method?: string; json?: unknown }) => {
      net.calls.push({ url, method: options?.method, json: options?.json });
      if (url.endsWith("/schedule/publish") && net.publishAll.length > 0) {
        return Promise.resolve(net.publishAll.shift());
      }
      return Promise.resolve({ conflicts: [] });
    },
  };
});

import { ScheduleBoard } from "../../schedule-board";
import { useBoardActions, type BoardActions } from "../use-board-actions";
import { ScheduleGateDialog } from "../schedule-gate-dialog";
import {
  UnreleasedBanner,
  partitionPublishOutcome,
  shouldShowUnreleasedBanner,
  unreleasedDivisions,
} from "../unreleased-banner";

const enDict = en as unknown as Dict;

/** React escapes `'`, `&`, `<` and `>` in text nodes, so a raw dictionary
 *  sentence containing an apostrophe is never a substring of the markup. */
const esc = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/'/g, "&#x27;");

const div = (id: string, name: string, status: string): BoardDivision => ({
  id,
  name,
  slug: id,
  status,
  seq: 1,
  schedule_locked: false,
});

// ---------------------------------------------------------------------------
// The rules, as exported functions. `environment: "node"` means a render-and-
// click test of these is impossible, so they live where they can be asserted.
// ---------------------------------------------------------------------------

describe("which divisions the public still cannot see times for", () => {
  it("is exactly the ones at status 'setup' — V401's own key", () => {
    const list = [
      div("d1", "Open", "setup"),
      div("d2", "Ladies", "scheduled"),
      div("d3", "Juniors", "setup"),
      div("d4", "Veterans", "active"),
      div("d5", "Plate", "completed"),
    ];
    expect(unreleasedDivisions(list, BOARD_FIXTURES).map((d) => d.id)).toEqual(["d1", "d3"]);
  });

  it("is empty when every division is past setup", () => {
    expect(
      unreleasedDivisions([div("d1", "Open", "scheduled"), div("d2", "L", "active")], BOARD_FIXTURES),
    ).toEqual([]);
  });
});

describe("an empty division is not a Publish all candidate (owner ruling, 2026-09-22)", () => {
  // Leaving `setup` is irreversible in effect — `public_fixtures_v` stops
  // redacting that division for ever, so a fixture added afterwards goes
  // public the moment it is placed, with no second publish. The server skips
  // an empty division; this count has to skip it too, or the banner promises
  // a release that never happens.
  const MIXED = [
    div("d1", "Open", "setup"), // has f1
    div("d7", "Brand new", "setup"), // built but never drawn — NO fixtures
    div("d2", "Ladies", "scheduled"),
  ];

  it("counts the populated setup division and not the empty one", () => {
    // The differential is the whole test: both are `setup`, so a rule that
    // still read status alone would return both and this would say ["d1","d7"].
    expect(unreleasedDivisions(MIXED, BOARD_FIXTURES).map((d) => d.id)).toEqual(["d1"]);
  });

  it("says so in the sentence — 1 of 3, not 2 of 3", () => {
    // The count an organiser reads has to be the number the server will
    // actually publish, or they go hunting for a candidate that never existed.
    expect(bannerMarkup(MIXED, null)).toContain(
      esc("1 of 3 divisions isn't released — the public still sees Time TBD on its matches."),
    );
  });

  it("does not render the banner at all when EVERY setup division is empty", () => {
    const allEmpty = [
      div("d7", "Brand new", "setup"),
      div("d8", "Also new", "setup"),
      div("d2", "Ladies", "scheduled"),
    ];
    // There is nothing Publish all could do here. A button that publishes
    // nothing is worse than no button: it reports a problem and then fails to
    // act on it, and the organiser cannot tell which of the two went wrong.
    expect(
      shouldShowUnreleasedBanner({
        single: null,
        canEdit: true,
        competitionId: "c1",
        divisions: allEmpty,
        fixtures: BOARD_FIXTURES,
      }),
    ).toBe(false);
  });

  it("still shows when at least one setup division is populated", () => {
    // The positive pair: without it, "returns false" passes on a predicate
    // that returns false for everything.
    expect(
      shouldShowUnreleasedBanner({
        single: null,
        canEdit: true,
        competitionId: "c1",
        divisions: MIXED,
        fixtures: BOARD_FIXTURES,
      }),
    ).toBe(true);
  });

  it("takes the button away from a board whose only setup division is emptied", () => {
    // Driven through the board, so the wiring is witnessed too: the call site
    // must hand `shouldShowUnreleasedBanner` the UNFILTERED board, and a
    // division with no fixtures must lose the banner rather than arm it.
    const island = renderIsland(
      ScheduleBoard,
      baseProps({
        divisions: [div("d7", "Brand new", "setup"), div("d2", "Ladies", "scheduled")],
      }),
    );
    expect(bannerOf(island.tree())).toBeUndefined();
  });
});

describe("whether the banner shows at all", () => {
  const COMP = [div("d1", "Open", "setup"), div("d2", "Ladies", "scheduled")];

  it("shows on a competition board carrying a setup division", () => {
    expect(
      shouldShowUnreleasedBanner({
        single: null,
        canEdit: true,
        competitionId: "c1",
        divisions: COMP,
        fixtures: BOARD_FIXTURES,
      }),
    ).toBe(true);
  });

  it("hides on a competition board where nothing is left in setup", () => {
    // THE assertion this surface exists to keep honest: the banner asserts a
    // customer-visible fact ("the public still sees Time TBD"). Shown over a
    // fully released competition it is simply false.
    const released = [div("d1", "Open", "scheduled"), div("d2", "Ladies", "active")];
    expect(
      shouldShowUnreleasedBanner({
        single: null,
        canEdit: true,
        competitionId: "c1",
        divisions: released,
        fixtures: BOARD_FIXTURES,
      }),
    ).toBe(false);
  });

  it("never shows on a single-division board, setup or not", () => {
    // That board has its own Publish button, immediately to hand. A second
    // control for the same act, two inches apart, is how an organiser learns to
    // distrust both.
    const one = [div("d1", "Open", "setup")];
    expect(
      shouldShowUnreleasedBanner({
        single: one[0] as BoardDivision,
        canEdit: true,
        competitionId: "c1",
        divisions: one,
        fixtures: BOARD_FIXTURES,
      }),
    ).toBe(false);
  });

  it("hides from a viewer who cannot edit", () => {
    expect(
      shouldShowUnreleasedBanner({
        single: null,
        canEdit: false,
        competitionId: "c1",
        divisions: COMP,
        fixtures: BOARD_FIXTURES,
      }),
    ).toBe(false);
  });

  it("hides when there is no competition id to POST to", () => {
    // A button that cannot act is worse than no button: it reports a problem
    // and then does nothing about it.
    expect(
      shouldShowUnreleasedBanner({
        single: null,
        canEdit: true,
        competitionId: undefined,
        divisions: COMP,
        fixtures: BOARD_FIXTURES,
      }),
    ).toBe(false);
  });
});

const REST_WARNING: BoardConflict = {
  fixture_id: "f1",
  code: "warn.rest",
  blocking: false,
  details: { kind: "entrant_below_rest", entrant_ids: ["e1"] },
} as unknown as BoardConflict;

const COURT_CLASH: BoardConflict = {
  fixture_id: "f1",
  code: "conflict.court",
  blocking: true,
  details: { kind: "court_double_booking", court: "Court 1", other_fixture_id: "f2" },
} as unknown as BoardConflict;

const PUBLISHED: PublishAllDivisionResult = { division_id: "d1", name: "Open", published: true };
const NEEDS_ACK: PublishAllDivisionResult = {
  division_id: "d2",
  name: "Ladies Doubles Championship Division",
  published: false,
  refusal: { code: "SCHEDULE_UNACKNOWLEDGED_WARNINGS", blocking: false, conflicts: [REST_WARNING] },
};
const BLOCKED: PublishAllDivisionResult = {
  division_id: "d3",
  name: "Juniors",
  published: false,
  refusal: { code: "SCHEDULE_BLOCKING_CONFLICTS", blocking: true, conflicts: [COURT_CLASH] },
};

describe("how an outcome partitions", () => {
  it("splits published / awaiting acknowledgement / blocked", () => {
    const p = partitionPublishOutcome([PUBLISHED, NEEDS_ACK, BLOCKED]);
    expect(p.published.map((r) => r.division_id)).toEqual(["d1"]);
    expect(p.needsAck.map((r) => r.division_id)).toEqual(["d2"]);
    expect(p.blocked.map((r) => r.division_id)).toEqual(["d3"]);
  });

  it("puts an unpublished division with NO refusal in blocked, never in needsAck", () => {
    // `needsAck` decides whether an override is OFFERED. Only a refusal the
    // server itself marked non-blocking can be cleared by re-sending with
    // `acknowledge_warnings: true`; anything else offered a way through would
    // be a promise nothing can keep — the same asymmetry the single-division
    // gate dialog is built around.
    const odd: PublishAllDivisionResult = { division_id: "d9", name: "Odd", published: false };
    const p = partitionPublishOutcome([odd]);
    expect(p.needsAck).toEqual([]);
    expect(p.blocked.map((r) => r.division_id)).toEqual(["d9"]);
  });
});

// ---------------------------------------------------------------------------
// The banner's own markup, under a real provider.
// ---------------------------------------------------------------------------

/** One fixture per division that any test needs to count as POPULATED. Since
 *  the 2026-09-22 ruling an empty `setup` division is not a Publish all
 *  candidate, so "which divisions have a fixture here" is now load-bearing in
 *  this file rather than incidental scenery. `f1` is the one every conflict
 *  fixture points at; the others exist only to make their division non-empty. */
const fixture = (id: string, divisionId: string): BoardFixture =>
  ({
    id,
    division_id: divisionId,
    home_entrant_id: "e1",
    away_entrant_id: "e2",
    scheduled_at: "2026-08-01T09:00:00.000Z",
    court_label: "Court 1",
    status: "scheduled",
    schedule_locked: false,
  }) as unknown as BoardFixture;

const BOARD_FIXTURES: BoardFixture[] = [
  fixture("f1", "d1"),
  fixture("f2", "d2"),
  fixture("f3", "d3"),
];

function bannerMarkup(divisions: BoardDivision[], outcome: PublishAllOutcome | null): string {
  return renderToStaticMarkup(
    <DictProvider locale={"en" as Locale} dict={enDict}>
      <UnreleasedBanner
        divisions={divisions}
        outcome={outcome}
        busy={false}
        onPublishAll={() => undefined}
        board={BOARD_FIXTURES}
        entrantNames={{ e1: "Alpha", e2: "Bravo" }}
        feedLabels={{}}
      />
    </DictProvider>,
  );
}

const NINE = [
  div("d1", "Open", "setup"),
  div("d2", "Ladies Doubles Championship Division", "setup"),
  div("d3", "Juniors", "setup"),
  ...["d4", "d5", "d6", "d7", "d8", "d9"].map((id) => div(id, id.toUpperCase(), "scheduled")),
];

describe("the banner says how many, and what it costs the public", () => {
  it("carries BOTH counts and the consequence in one interpolated sentence", () => {
    const html = bannerMarkup(NINE, null);
    // The count is CHOSEN by the component from `divisions` — nothing hands it
    // a number — so this witnesses the banner counting, not a prop echoing.
    expect(html).toContain(
      esc("3 of 9 divisions aren't released — the public still sees Time TBD on their matches."),
    );
    expect(html).toContain('data-testid="board-publish-all"');
    expect(html).toContain(enDict["board.publishAll.cta"] as string);
  });

  it("uses the singular sentence for exactly one unreleased division", () => {
    const one = [div("d1", "Open", "setup"), div("d2", "Ladies", "scheduled")];
    expect(bannerMarkup(one, null)).toContain(
      esc("1 of 2 divisions isn't released — the public still sees Time TBD on its matches."),
    );
  });

  it("shows no outcome block before a call has been made", () => {
    expect(bannerMarkup(NINE, null)).not.toContain('data-testid="board-publish-all-outcome"');
  });
});

describe("after a call, the banner reports what did NOT go live", () => {
  const OUTCOME: PublishAllOutcome = {
    published: 1,
    needs_acknowledgement: 1,
    blocked: 1,
    results: [PUBLISHED, NEEDS_ACK, BLOCKED],
  };

  it("names each division, says which kind of refusal, and gives a blocked one its reasons", () => {
    const html = bannerMarkup(NINE, OUTCOME);

    expect(html).toContain('data-testid="board-publish-all-outcome"');
    expect(html).toContain("Published 1 division.");
    expect(html).toContain(enDict["board.publishAll.remainingTitle"] as string);

    // Both unpublished divisions, each named, each carrying the state that says
    // whether there is a way through.
    expect(html).toContain('data-division-id="d2"');
    expect(html).toContain('data-state="needs_ack"');
    expect(html).toContain("Ladies Doubles Championship Division");
    expect(html).toContain(enDict["board.publishAll.needsAck"] as string);

    expect(html).toContain('data-division-id="d3"');
    expect(html).toContain('data-state="blocked"');
    expect(html).toContain(enDict["board.publishAll.blocked"] as string);

    // "Blocked" alone sends the organiser hunting. The REASONS come through the
    // gate dialog's own renderer, so a code reads identically in both places.
    expect(html).toContain('data-testid="board-publish-all-conflict"');
    expect(html).toContain('data-code="conflict.court"');
    expect(html).toContain('data-blocking="yes"');
    expect(html).toContain(esc(enDict["board.conflictHelp.conflict.court"] as string));
    // …and the row names the FIXTURE, not a uuid.
    expect(html).toContain("Alpha vs Bravo");
  });

  it("does NOT print conflict rows under a division that merely needs acknowledging", () => {
    // Those conflicts belong in the dialog the organiser is about to answer.
    // Printing them twice makes the banner the louder of the two and buries the
    // question being asked.
    const html = bannerMarkup(NINE, {
      published: 0,
      needs_acknowledgement: 1,
      blocked: 0,
      results: [NEEDS_ACK],
    });
    expect(html).toContain('data-state="needs_ack"');
    expect(html).not.toContain('data-code="warn.rest"');
    expect(html).toContain(enDict["board.publishAll.publishedNone"] as string);
  });

  it("keeps a 40-character division name inside a truncating, min-w-0 chain", () => {
    // A long real division name is exactly what puts horizontal scroll on a
    // 320px page, and `truncate` does nothing without `min-w-0` on the whole
    // ancestor chain — not just on the span.
    expect((NEEDS_ACK.name as string).length).toBeGreaterThanOrEqual(35);
    const html = bannerMarkup(NINE, OUTCOME);
    expect(html).toContain('class="min-w-0 truncate text-xs font-semibold text-slate-800"');
    expect(html).toContain('class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1"');
    expect(html).toContain('class="min-w-0 rounded-lg border border-amber-200 bg-white/70 p-2"');
    expect(html).toContain('data-testid="board-publish-all-outcome" class="w-full min-w-0 space-y-2"');
  });

  it("gives the phone a full-width, 44px-tall press and never a second DOM", () => {
    const html = bannerMarkup(NINE, null);
    // One DOM branched: `max-md:*` only, no phone-only tree.
    expect(html).toContain("max-md:w-full");
    expect(html).toContain("min-h-11");
  });
});

// ---------------------------------------------------------------------------
// The board's wiring: what a press POSTs, and the ONE gate for the whole set.
// ---------------------------------------------------------------------------

const STAGES: BoardStage[] = [
  { id: "s1", division_id: "d1", name: "Round robin", kind: "round_robin", seq: 1, status: "draft" },
  { id: "s2", division_id: "d2", name: "Round robin", kind: "round_robin", seq: 1, status: "draft" },
] as unknown as BoardStage[];

const SETTINGS = {
  tz: "Europe/London",
  orgTz: "Europe/London",
  division_id: "d1",
  config: {
    startAt: "2026-08-01T09:00:00.000Z",
    endAt: "2026-08-01T18:00:00.000Z",
    matchMinutes: 60,
    gapMinutes: 0,
    courts: ["Court 1", "Court 2"],
    perEntrantMinRest: 0,
    blackouts: [],
    sessionWindows: [],
  },
} as unknown as Parameters<typeof ScheduleBoard>[0]["settings"];

type BoardProps = Parameters<typeof ScheduleBoard>[0];

/** The joint console's per-division quote inputs — a DIFFERENT shape from the
 *  board's own `settings` prop, and the one `competition.divisionSettings`
 *  actually takes. */
const DIV_SETTINGS = { courts: ["Court 1", "Court 2"], tz: "Europe/London" };

const baseProps = (over: Partial<BoardProps> = {}): BoardProps =>
  ({
    divisions: [div("d1", "Open", "setup"), div("d2", "Ladies", "scheduled")],
    stages: STAGES,
    fixtures: BOARD_FIXTURES,
    entrantNames: { e1: "Alpha", e2: "Bravo" },
    activeEntrantCounts: { d1: 2, d2: 2 },
    feedLabels: {},
    settings: SETTINGS,
    canEdit: true,
    constraintsAllowed: true,
    canManage: true,
    aiAllowed: true,
    currency: "usd",
    competitionStart: "2026-08-01",
    competitionEnd: "2026-08-02",
    officialsWithBlackout: 0,
    competition: { id: "c1", divisionSettings: { d1: DIV_SETTINGS, d2: DIV_SETTINGS } },
    ...over,
  }) as unknown as BoardProps;

const localStore = new Map<string, string>();
vi.stubGlobal("window", {
  localStorage: {
    getItem: (k: string) => localStore.get(k) ?? null,
    setItem: (k: string, v: string) => void localStore.set(k, v),
  },
  matchMedia: () => ({ matches: false }),
  get location() {
    return { search: nav.search };
  },
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const bannerOf = (tree: ReactElement[]): ReactElement | undefined =>
  tree.find((node) => node.type === UnreleasedBanner);

const bannerProps = (tree: ReactElement[]) => {
  const el = bannerOf(tree);
  if (!el) throw new Error("the unreleased banner is not mounted on the board");
  return propsOf(el) as {
    onPublishAll: () => void;
    outcome: PublishAllOutcome | null;
    divisions: BoardDivision[];
  };
};

const gateProps = (tree: ReactElement[]) => {
  const el = tree.find((node) => node.type === ScheduleGateDialog);
  if (!el) throw new Error("the gate dialog is not mounted on the board");
  return propsOf(el) as {
    gate: { kind: string; action: string; conflicts: BoardConflict[] } | null;
    divisionNames?: string[];
    onConfirm: () => void;
  };
};

const publishAllCalls = () => net.calls.filter((c) => c.url.endsWith("/schedule/publish"));

beforeEach(() => {
  net.calls.length = 0;
  net.publishAll.length = 0;
  nav.refresh.mockClear();
});

describe("the competition board mounts the banner, and only there", () => {
  it("mounts it when a division is still in setup", () => {
    const island = renderIsland(ScheduleBoard, baseProps());
    expect(bannerOf(island.tree())).toBeDefined();
    // It is handed EVERY division, not a pre-filtered list — the count is the
    // banner's own to make.
    expect(bannerProps(island.tree()).divisions).toHaveLength(2);
  });

  it("does not mount it when every division is past setup", () => {
    const island = renderIsland(
      ScheduleBoard,
      baseProps({ divisions: [div("d1", "Open", "scheduled"), div("d2", "Ladies", "active")] }),
    );
    expect(bannerOf(island.tree())).toBeUndefined();
  });

  it("does not mount it on a single-division board", () => {
    const island = renderIsland(
      ScheduleBoard,
      baseProps({
        divisions: [div("d1", "Open", "setup")],
        competition: { id: "c1", divisionSettings: { d1: DIV_SETTINGS } },
      }),
    );
    expect(bannerOf(island.tree())).toBeUndefined();
  });
});

describe("pressing Publish all", () => {
  it("POSTs the competition endpoint ONCE, with no body", async () => {
    net.publishAll.push({ published: 2, needs_acknowledgement: 0, blocked: 0, results: [PUBLISHED] });
    const island = renderIsland(ScheduleBoard, baseProps());

    bannerProps(island.tree()).onPublishAll();
    await flush();

    // One call for the whole competition — never one per division, which is the
    // loop this endpoint exists to replace.
    expect(publishAllCalls()).toHaveLength(1);
    expect(publishAllCalls()[0]!.url).toBe("/api/v1/competitions/c1/schedule/publish");
    expect(publishAllCalls()[0]!.method).toBe("POST");
    expect(publishAllCalls()[0]!.json).toBeUndefined();
    // Something moved, so the RSC props are re-read.
    expect(nav.refresh).toHaveBeenCalled();
  });

  it("hands the answer back to the banner to report", async () => {
    const outcome = {
      published: 1,
      needs_acknowledgement: 0,
      blocked: 1,
      results: [PUBLISHED, BLOCKED],
    };
    net.publishAll.push(outcome);
    const island = renderIsland(ScheduleBoard, baseProps());

    bannerProps(island.tree()).onPublishAll();
    await flush();

    expect(bannerProps(island.tree()).outcome).toEqual(outcome);
  });

  it("opens NO dialog when nothing is merely awaiting acknowledgement", async () => {
    // A blocking refusal has no way through, so a confirm sheet would be a
    // question with no answer. The banner's own report is the whole story.
    net.publishAll.push({ published: 0, needs_acknowledgement: 0, blocked: 1, results: [BLOCKED] });
    const island = renderIsland(ScheduleBoard, baseProps());

    bannerProps(island.tree()).onPublishAll();
    await flush();

    expect(gateProps(island.tree()).gate).toBeNull();
    expect(publishAllCalls()).toHaveLength(1);
    // Nothing published, so nothing to re-read.
    expect(nav.refresh).not.toHaveBeenCalled();
  });
});

describe("the organiser is told what happened even when the banner goes away", () => {
  // REVIEW FINDING 1. On the common path every candidate publishes, the hook
  // refreshes, the refreshed `divisions` carry no `setup` row, the visibility
  // predicate goes false and the banner unmounts — taking any report rendered
  // INSIDE it with it. Nothing else said a word. Neither the original harness
  // tests (which never re-rendered with refreshed props) nor the e2e (which
  // always leaves one division blocked, so the banner survives) could see it.
  const ALL_CLEAN = {
    published: 2,
    needs_acknowledgement: 0,
    blocked: 0,
    results: [
      PUBLISHED,
      { division_id: "d2", name: "Ladies", published: true } as PublishAllDivisionResult,
    ],
  };

  it("sets a notice carrying the published count, which outlives the banner", async () => {
    net.publishAll.push(ALL_CLEAN);
    const island = renderIsland(ScheduleBoard, baseProps());

    bannerProps(island.tree()).onPublishAll();
    await flush();

    // The RSC comes back with nothing left in setup — the real consequence of
    // the publish, and exactly what `router.refresh()` produces.
    island.rerender(
      baseProps({ divisions: [div("d1", "Open", "scheduled"), div("d2", "Ladies", "scheduled")] }),
    );

    expect(bannerOf(island.tree()), "the banner should be gone once nothing is unreleased").toBeUndefined();
    // …and the organiser is STILL told, in the board's own confirmation
    // channel, how many divisions went live and what that means.
    expect(island.text()).toContain(
      "Published 2 divisions — their matches are now on the public dashboard and .ics feeds.",
    );
  });

  it("says nothing when the call published nothing — the banner explains that itself", async () => {
    // A notice reading "Published 0 divisions" would be a green confirmation of
    // a failure. The banner survives this path and carries the reasons.
    net.publishAll.push({ published: 0, needs_acknowledgement: 0, blocked: 1, results: [BLOCKED] });
    const island = renderIsland(ScheduleBoard, baseProps());

    bannerProps(island.tree()).onPublishAll();
    await flush();

    expect(island.text()).not.toContain("are now on the public dashboard");
    expect(bannerOf(island.tree())).toBeDefined();
  });
});

describe("the report goes stale the moment the board changes under it", () => {
  // REVIEW FINDING 4. The outcome is a receipt for the board that produced it.
  // Left standing, it went on naming a division as blocked after the organiser
  // had fixed the very clash it was reporting, with no way for the panel to
  // know. It therefore lives in the hook beside `notice`/`error`/`lastRun`,
  // and EVERY action's preamble clears it.
  //
  // Driven against the hook directly rather than through the board, because
  // the thing being pinned is one line in each of seven preambles — a
  // board-level test could only ever reach the two or three of those that have
  // a control the harness can find, and would leave the rest decoration.
  function Sink(_: { actions: BoardActions }) {
    return null;
  }
  function ActionsProbe({ divisions, fixtures }: { divisions: BoardDivision[]; fixtures: BoardFixture[] }) {
    const actions = useBoardActions(divisions, fixtures, {}, {}, true);
    return <Sink actions={actions} />;
  }
  const actionsOf = (tree: ReactElement[]): BoardActions => {
    const el = tree.find((n) => n.type === Sink);
    if (!el) throw new Error("no Sink rendered");
    return (propsOf(el) as { actions: BoardActions }).actions;
  };

  const PARTIAL = {
    published: 1,
    needs_acknowledgement: 0,
    blocked: 1,
    results: [PUBLISHED, BLOCKED],
  };

  /** Every write an organiser has on this board. One line per preamble. */
  const WRITES: [string, (a: BoardActions) => Promise<unknown>][] = [
    ["moveCard", (a) => a.moveCard("f1", "2026-08-01T11:00:00.000Z", null)],
    ["togglePin", (a) => a.togglePin(BOARD_FIXTURES[0] as BoardFixture)],
    ["autoRun", (a) => a.autoRun("s1", "d1", true)],
    ["act", (a) => a.act("/api/v1/divisions/d1/publish-schedule", "done")],
    ["shiftDay", (a) => a.shiftDay("2026-08-01", 15)],
    ["swapCourts", (a) => a.swapCourts("2026-08-01", "Court 1", "Court 2")],
    // `publishAll`'s own preamble clears too, but it then REPLACES the report
    // rather than leaving it empty, so "becomes null" is the wrong assertion
    // for it — "becomes the new answer" is, and the acknowledgement test above
    // already pins that (`outcome!.published` moves 1 -> 3).
  ];

  it.each(WRITES)("%s clears the previous publish-all report", async (_name, write) => {
    net.publishAll.push(PARTIAL);
    const island = renderIsland(ActionsProbe, {
      divisions: [div("d1", "Open", "setup"), div("d2", "Ladies", "scheduled")],
      fixtures: BOARD_FIXTURES,
    });

    await actionsOf(island.tree()).publishAll("c1");
    await flush();
    expect(actionsOf(island.tree()).publishAllOutcome, "the report should be on screen first").not.toBeNull();

    // The outcome is cleared in the PREAMBLE, so this holds whether the write
    // lands or fails — which is the point: a board the organiser has touched
    // can no longer be described by yesterday's report.
    await write(actionsOf(island.tree())).catch(() => undefined);
    await flush();

    expect(actionsOf(island.tree()).publishAllOutcome).toBeNull();
  });
});

describe("one gate for the whole set", () => {
  const TWO_WARNED = {
    published: 1,
    needs_acknowledgement: 2,
    blocked: 0,
    results: [
      PUBLISHED,
      NEEDS_ACK,
      {
        division_id: "d4",
        name: "Veterans",
        published: false,
        refusal: {
          code: "SCHEDULE_UNACKNOWLEDGED_WARNINGS",
          blocking: false,
          conflicts: [REST_WARNING],
        },
      } as PublishAllDivisionResult,
    ],
  };

  it("opens ONE warnings dialog naming every affected division", async () => {
    net.publishAll.push(TWO_WARNED);
    const island = renderIsland(ScheduleBoard, baseProps());

    bannerProps(island.tree()).onPublishAll();
    await flush();

    const opened = gateProps(island.tree());
    expect(opened.gate).toMatchObject({ kind: "warnings", action: "publish" });
    // Named, both of them — the existing body sentence says "the schedule" and
    // names nothing, so without this an organiser acknowledging two of nine
    // divisions could not tell which two they were agreeing to.
    expect(opened.divisionNames).toEqual(["Ladies Doubles Championship Division", "Veterans"]);
    // The conflicts of BOTH, in one list, so the dialog can show what is being
    // acknowledged rather than a bare count.
    expect(opened.gate!.conflicts).toHaveLength(2);
  });

  it("re-POSTs the SAME competition endpoint once with acknowledge_warnings", async () => {
    net.publishAll.push(TWO_WARNED, {
      published: 3,
      needs_acknowledgement: 0,
      blocked: 0,
      results: [PUBLISHED],
    });
    const island = renderIsland(ScheduleBoard, baseProps());

    bannerProps(island.tree()).onPublishAll();
    await flush();
    gateProps(island.tree()).onConfirm();
    await flush();

    // TWO calls total — not one per acknowledged division.
    expect(publishAllCalls()).toHaveLength(2);
    expect(publishAllCalls()[1]!.url).toBe("/api/v1/competitions/c1/schedule/publish");
    expect(publishAllCalls()[1]!.json).toStrictEqual({ acknowledge_warnings: true });
    // Accepted this time, so the dialog closes and the banner reports the new
    // answer rather than the stale one.
    expect(gateProps(island.tree()).gate).toBeNull();
    expect(bannerProps(island.tree()).outcome!.published).toBe(3);
  });

  it("does not re-open the identical dialog after an acknowledgement", async () => {
    // The single-division gate DOES re-open on a second refusal, because that
    // one can be a different, blocking refusal the organiser has not seen. Here
    // every outcome is already written into the banner's report, so re-opening
    // would be the same sheet with no new information, once per press, for ever.
    net.publishAll.push(TWO_WARNED, TWO_WARNED);
    const island = renderIsland(ScheduleBoard, baseProps());

    bannerProps(island.tree()).onPublishAll();
    await flush();
    gateProps(island.tree()).onConfirm();
    await flush();

    expect(gateProps(island.tree()).gate).toBeNull();
    expect(publishAllCalls()).toHaveLength(2);
  });

  it("leaves the single-division gate's own props untouched", async () => {
    // `divisionNames` must be absent on the division-scoped path, or the
    // dialog grows a line naming one division to an organiser who pressed a
    // button that already names it.
    const island = renderIsland(ScheduleBoard, baseProps());
    expect(gateProps(island.tree()).divisionNames).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The dialog end of that prop. Passing `divisionNames` proves the board SENDS
// the names; only rendering the dialog proves an organiser ever READS them —
// the inert-seam class, where a prop is declared, typed and wired and nothing
// downstream consumes it.
// ---------------------------------------------------------------------------

describe("the gate dialog names the divisions a competition-wide acknowledgement covers", () => {
  const gate = { kind: "warnings" as const, action: "publish" as const, conflicts: [REST_WARNING] };

  const dialog = (divisionNames?: string[]) =>
    renderToStaticMarkup(
      <DictProvider locale={"en" as Locale} dict={enDict}>
        <ScheduleGateDialog
          gate={gate}
          board={BOARD_FIXTURES}
          entrantNames={{ e1: "Alpha", e2: "Bravo" }}
          feedLabels={{}}
          onConfirm={() => undefined}
          onDismiss={() => undefined}
          divisionNames={divisionNames}
        />
      </DictProvider>,
    );

  it("prints the names beneath the body sentence, which is reused unchanged", () => {
    const html = dialog(["Ladies Doubles Championship Division", "Veterans"]);
    expect(html).toContain('data-testid="board-gate-divisions"');
    // The prefix, from the dictionary — not a hand-typed sentence.
    expect(html).toContain("Divisions with warnings:");
    expect(html).toContain("Ladies Doubles Championship Division");
    expect(html).toContain("Veterans");
    // The existing gate copy is REUSED, not replaced: adding a competition
    // variant of a sentence that still reads correctly is how two dictionaries
    // of near-identical copy start.
    expect(html).toContain(enDict["board.gate.warnBodyPublish"] as string);
    expect(html).toContain(enDict["board.gate.warnTitlePublish"] as string);
  });

  it("prints nothing at all on the single-division path", () => {
    // Byte-identical to the dialog before this prop existed.
    expect(dialog(undefined)).not.toContain('data-testid="board-gate-divisions"');
    expect(dialog([])).not.toContain('data-testid="board-gate-divisions"');
  });
});

describe("the publish-all copy exists in every locale", () => {
  const KEYS = [
    "board.publishAll.headline.one",
    "board.publishAll.headline.other",
    "board.publishAll.cta",
    "board.publishAll.publishedCount.one",
    "board.publishAll.publishedCount.other",
    "board.publishAll.publishedNone",
    "board.publishAll.remainingTitle",
    "board.publishAll.blocked",
    "board.publishAll.needsAck",
    "board.publishAll.gateDivisions",
  ];

  it.each(["es", "fr", "nl"])("%s carries all ten keys, translated", async (locale) => {
    const dict = (await import(`@/dictionaries/${locale}/ui.json`)).default as Record<
      string,
      string
    >;
    for (const key of KEYS) {
      // Flat dotted-key lookup — `toHaveProperty` matches the literal key
      // before attempting a path walk, and these files are flat.
      expect(dict, `${locale} is missing ${key}`).toHaveProperty(key);
      expect(dict[key], `${locale} left ${key} as English`).not.toBe(enDict[key]);
    }
  });

  it("keeps the interpolation placeholders in every locale", async () => {
    for (const locale of ["en", "es", "fr", "nl"]) {
      const dict = (await import(`@/dictionaries/${locale}/ui.json`)).default as Record<
        string,
        string
      >;
      // A translation that drops `{total}` silently prints a sentence with one
      // number where the organiser needs two.
      for (const key of ["board.publishAll.headline.one", "board.publishAll.headline.other"]) {
        expect(dict[key], `${locale}/${key}`).toContain("{count}");
        expect(dict[key], `${locale}/${key}`).toContain("{total}");
      }
      expect(dict["board.publishAll.gateDivisions"], locale).toContain("{names}");
    }
  });
});
