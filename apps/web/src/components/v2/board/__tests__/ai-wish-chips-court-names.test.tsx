// P9 review wave 3, finding #11: the wish-chip "final_last" court picker
// rendered `config.courts` entries as both option value AND label — those
// are real courts.id uuids since the P9 cutover, so the dropdown (and the
// confirmed-wish pill) showed a raw id instead of a name.
//
// Proves the wiring, not just the leaf component: a `courtNames` prop handed
// straight to AiWishChips would pass even if AiConsole/BriefStep never
// threaded it through (BriefStep had NO courtNames param at all before this
// fix). `renderIsland` expands only ONE function component per call (see
// _hook-harness.tsx's own header — "hookless children" only), so the two
// hops are proven by stepping down: AiConsole run for real -> the BriefStep
// ELEMENT it renders (props only, mutation-checked below) -> BriefStep run
// for real -> the AiWishChips ELEMENT it renders (props only, mutation-
// checked below). The rendered-text half (does a real courtNames prop
// actually turn into a real name on screen) is proven separately by
// rendering AiWishChips for real: `renderToStaticMarkup` for the confirmed-
// wish pill (no click needed — `wishes` is a plain prop), and one
// `renderIsland` click (to open the "final_last" picker, WishPicker's own
// `useState`) followed by a real render of the WishPicker element React
// created (extracted via its `.type` — WishPicker is not exported, and does
// not need to be for this).
import { describe, expect, it, vi } from "vitest";
import type { ReactElement, ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { propsOf, renderIsland, walk } from "@/components/__tests__/_hook-harness";

vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  usePathname: () => "/o/riverside/divisions/d1",
}));

vi.mock("../rung-config-provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../rung-config-provider")>();
  const { resolveRungConfig: resolve } = await import("@/lib/ai-rung");
  const config = resolve();
  return { ...actual, useRungConfig: () => config };
});

// `usePlural` (used by BriefStep itself, not by AiWishChips) THROWS outside
// a <DictProvider> — the hook-harness (hop 1/2 below) has no provider tree.
// The `renderToStaticMarkup` behaviour tests below wrap in a REAL
// <DictProvider>, so `...actual` keeps everything but this real (same mock
// ai-console-gate-wiring.test.tsx / ai-console-officials-autorun.test.tsx use).
vi.mock("@/components/i18n/dict-provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/i18n/dict-provider")>();
  const { plural } = await import("@/lib/i18n-runtime");
  const { messages } = await import("@/lib/messages");
  return {
    ...actual,
    usePlural:
      () => (key: string, count: number, vars?: Record<string, string | number>) =>
        plural(messages, key, count, "en", vars),
  };
});

import { DictProvider } from "@/components/i18n/dict-provider";
import { RungConfigProvider } from "../rung-config-provider";
import { resolveRungConfig } from "@/lib/ai-rung";
import { AiConsole, BriefStep } from "../ai-console";
import { AiWishChips } from "../ai-wish-chips";
import { initialAiConsoleState } from "../ai-console-state";
import type { Dict } from "@/lib/i18n-constants";
import en from "@/dictionaries/en/ui.json";

const enDict = en as unknown as Dict;
const DIVISION = "00000000-0000-4000-8000-000000000001";

// Two DIFFERENT venues each naming a court "Court 1" — legal (P8's
// uniqueness is per-venue) — proving the two stay distinguishable rather
// than both rendering identical text.
const COURT_1 = "11111111-1111-4111-8111-111111111111";
const COURT_2 = "22222222-2222-4222-8222-222222222222";
const COURT_NAMES = {
  [COURT_1]: "Court 1 (Riverside Centre)",
  [COURT_2]: "Court 1 (Downtown Hall)",
};

const brief = {
  courts: [COURT_1, COURT_2],
  windows: 1,
  blackouts: 0,
  constraintsSet: false,
  movableFixtures: [{ id: "f1", scheduled_at: "2026-08-01T10:00:00.000Z", court_id: COURT_1 }],
  pinned: 0,
  entrants: [
    { id: "e1", name: "Team A" },
    { id: "e2", name: "Team B" },
  ],
  activeEntrants: 2,
  officialsWithBlackout: 0,
};

const preflight = {
  divisionId: DIVISION,
  courts: 2,
  windows: 1,
  blackouts: 0,
  constraintsSet: false,
  movable: 1,
  pinned: 0,
  officials: 0,
  officialsBlackout: 0,
  settingsHref: "/divisions/d1/schedule?tab=settings",
  officialsHref: "/divisions/d1/schedule?tab=officials",
};

const consoleProps: Parameters<typeof AiConsole>[0] = {
  divisionId: DIVISION,
  expectedSeq: 1,
  aiAllowed: true,
  currency: "usd",
  brief,
  fixtures: [],
  scheduleFrozen: false,
  onClose: () => {},
  courtNames: COURT_NAMES,
  viewerPlan: "community",
};

const briefStepProps: Parameters<typeof BriefStep>[0] = {
  state: { ...initialAiConsoleState, instruction: "at most 2 matches a day" },
  dispatch: () => {},
  run: () => {},
  preview: () => {},
  busy: false,
  msg: ((key: string, vars?: Record<string, string | number>) => {
    const raw = (enDict as unknown as Record<string, string>)[key] ?? key;
    return vars ? raw.replace(/\{(\w+)\}/g, (m, n: string) => (n in vars ? String(vars[n]) : m)) : raw;
  }) as never,
  currency: "usd",
  brief: brief as never,
  preflight,
  wishes: [],
  onWishes: () => {},
  onFill: () => {},
  lastRun: null,
  scheduleFrozen: false,
  courtNames: COURT_NAMES,
};

describe("AiConsole threads courtNames into BriefStep (P9 review wave 3, finding #11, hop 1)", () => {
  it("the BriefStep element AiConsole renders (default step) carries the SAME courtNames it was given", () => {
    const island = renderIsland(AiConsole, consoleProps);
    const step = walk(island.tree()).find((e) => typeof propsOf(e).onFill === "function");
    expect(step, "BriefStep not rendered on the default step").toBeDefined();
    expect(propsOf(step!).courtNames).toBe(COURT_NAMES);
  });
});

describe("BriefStep threads courtNames into AiWishChips (P9 review wave 3, finding #11, hop 2)", () => {
  it("the AiWishChips element BriefStep renders carries the SAME courtNames it was given", () => {
    const island = renderIsland(BriefStep, briefStepProps);
    const chips = walk(island.tree()).find((e) => typeof propsOf(e).onChange === "function" && "courts" in propsOf(e));
    expect(chips, "AiWishChips not rendered").toBeDefined();
    expect(propsOf(chips!).courtNames).toBe(COURT_NAMES);
  });
});

describe("AiWishChips renders resolved court names, never a raw uuid (P9 review wave 3, finding #11, behaviour)", () => {
  const wishChipsProps: Parameters<typeof AiWishChips>[0] = {
    wishes: [],
    onChange: () => {},
    entrants: brief.entrants,
    courts: [COURT_1, COURT_2],
    courtNames: COURT_NAMES,
  };

  function wrap(node: ReactElement): string {
    return renderToStaticMarkup(
      <RungConfigProvider value={resolveRungConfig()}>
        <DictProvider dict={enDict} locale="en">
          {node}
        </DictProvider>
      </RungConfigProvider>,
    );
  }

  it("the final_last picker's <select> shows two same-named courts distinguishably, never their bare uuids", () => {
    const island = renderIsland(AiWishChips, wishChipsProps);
    // Every "add a wish" chip shares this button shape; find the one whose
    // click opens the final_last picker by driving each enabled chip in turn
    // (each closure sets `active` to ITS OWN kind — captured when `active`
    // was still null — so clicking a stale one is still correct) until the
    // rendered WishPicker reports kind === "final_last".
    const chipButtons = walk(island.tree()).filter(
      (e) => e.type === "button" && typeof propsOf(e).onClick === "function" && !propsOf(e).disabled,
    );
    let picker: ReactElement | undefined;
    for (const btn of chipButtons) {
      (propsOf(btn).onClick as () => void)();
      picker = walk(island.tree()).find((e) => typeof propsOf(e).onAdd === "function");
      if (picker && propsOf(picker).kind === "final_last") break;
    }
    expect(picker, "WishPicker for final_last never rendered").toBeDefined();
    expect(propsOf(picker!).kind).toBe("final_last");

    const WishPickerComponent = picker!.type as ComponentType<Record<string, unknown>>;
    const html = wrap(<WishPickerComponent {...propsOf(picker!)} />);
    expect(html).toContain(">Court 1 (Riverside Centre)</option>");
    expect(html).toContain(">Court 1 (Downtown Hall)</option>");
    expect(html).not.toContain(`>${COURT_1}</option>`);
    expect(html).not.toContain(`>${COURT_2}</option>`);
  });

  it("a confirmed final_last wish's pill shows the resolved name, never the raw uuid", () => {
    const html = wrap(
      <AiWishChips
        {...wishChipsProps}
        wishes={[{ kind: "final_last", court: COURT_1 }]}
      />,
    );
    expect(html).toContain("Court 1 (Riverside Centre)");
    expect(html).not.toContain(COURT_1);
  });

  it("a pill for a court id with no courtNames entry degrades to the shared unknown-court string, never the raw id", () => {
    const deleted = "99999999-9999-4999-8999-999999999999";
    const html = wrap(
      <AiWishChips {...wishChipsProps} wishes={[{ kind: "final_last", court: deleted }]} />,
    );
    expect(html).toContain("Unknown court");
    expect(html).not.toContain(deleted);
  });
});
