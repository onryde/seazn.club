// P9 review wave 3, finding #10: AiOfficialsReview's grid printed a raw
// court uuid. `OfficialsPlacement.court_label` carries a real `courts.id`
// since the P9 cutover (despite its legacy name — `resolveModelCourtLabels`
// rewrites it server-side before the response leaves), and neither
// OfficialsStep nor AiOfficialsReview ever resolved it through `courtNames`.
//
// Proves the wiring, not just the leaf component: a `courtNames` prop handed
// straight to AiOfficialsReview would pass even if AiConsole/OfficialsStep
// never threaded it through. `renderIsland` expands only ONE function
// component per call (see _hook-harness.tsx's own header — "hookless
// children" only), so each hop is proven by stepping down one level at a
// time: AiConsole run for real -> the OfficialsStep ELEMENT it renders
// (props only, mutation-checked below) -> OfficialsStep run for real -> the
// AiOfficialsReview ELEMENT it renders (props only, mutation-checked below)
// -> AiOfficialsReview rendered for real via plain SSR (it owns no
// `useState` — the grid needs no click to show), checked for the actual
// rendered text.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { propsOf, renderIsland, walk } from "@/components/__tests__/_hook-harness";
import type { AiOfficialsPlanResponse, AiPlanResponse } from "@/server/api-v1/schemas";

// AiConsole reads usePathname (breadcrumb/back-link wiring), which uses
// React's `use()` internally — unsupported by the hook-harness's fake
// dispatcher (_hook-harness.tsx's own header lists useState/useEffect/
// useMemo/useCallback/useRef/useReducer/useContext only). Same mock
// ai-console-officials-autorun.test.tsx and ai-console-gate-wiring.test.tsx
// already use for exactly this reason.
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  usePathname: () => "/o/riverside/divisions/d1",
}));

// #385: AiConsole/OfficialsStep read rung weights through this context, which
// the hook-harness cannot supply (no provider tree — see ai-console-officials-
// autorun.test.tsx's identical mock). Server-resolved defaults stand in.
vi.mock("../rung-config-provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../rung-config-provider")>();
  const { resolveRungConfig: resolve } = await import("@/lib/ai-rung");
  const config = resolve();
  return { ...actual, useRungConfig: () => config };
});

import { DictProvider } from "@/components/i18n/dict-provider";
import { RungConfigProvider } from "../rung-config-provider";
import { resolveRungConfig } from "@/lib/ai-rung";
import { AiConsole, OfficialsStep } from "../ai-console";
import { AiOfficialsReview } from "../ai-officials-review";
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

const SCHEDULE_PLAN = {
  proposal: [
    { fixture_id: "f0", scheduled_at: "2026-08-01T10:00:00.000Z", court_label: COURT_1 },
    { fixture_id: "f1", scheduled_at: "2026-08-01T11:00:00.000Z", court_label: COURT_2 },
  ],
  unschedulable: [],
  warnings: [],
  blocking: [],
  diff: { moved: [], placed: [], unscheduled: [], unchanged: [] },
  explanations: [],
  summary: "ok",
  assumptions: [],
  usage: { input_tokens: 0, output_tokens: 0, repair_rounds: 0 },
  repair: { engine: "none", solver_ran: false },
  officials_coverage: null,
} as unknown as AiPlanResponse;

function officialsPlan(over: Partial<AiOfficialsPlanResponse> = {}): AiOfficialsPlanResponse {
  return {
    assignments: [],
    conflicts: [],
    diff: { changed: [], unchanged: ["f0", "f1"], unfilled: [] },
    lazy_unfilled: [],
    explanations: [],
    summary: "drafted",
    usage: { input_tokens: 0, output_tokens: 0, repair_rounds: 0 },
    credits: 1,
    ...over,
  } as unknown as AiOfficialsPlanResponse;
}

const consoleProps: Parameters<typeof AiConsole>[0] = {
  divisionId: DIVISION,
  expectedSeq: 1,
  aiAllowed: true,
  currency: "usd",
  brief: {
    courts: [COURT_1, COURT_2],
    windows: 1,
    blackouts: 0,
    constraintsSet: false,
    movableFixtures: [],
    pinned: 0,
    entrants: [],
    activeEntrants: 0,
    officialsWithBlackout: 0,
  },
  fixtures: [],
  scheduleFrozen: false,
  onClose: () => {},
  courtNames: COURT_NAMES,
};

describe("AiConsole threads courtNames into OfficialsStep (P9 review wave 3, finding #10, hop 1)", () => {
  it("the OfficialsStep element AiConsole renders carries the SAME courtNames it was given", () => {
    const island = renderIsland(AiConsole, consoleProps);
    const dispatchEl = walk(island.tree()).find((e) => typeof propsOf(e).dispatch === "function");
    expect(dispatchEl, "nothing rendered with a dispatch").toBeDefined();
    const dispatch = propsOf(dispatchEl!).dispatch as (a: Record<string, unknown>) => void;
    dispatch({ type: "RUN_DONE", plan: SCHEDULE_PLAN });
    dispatch({ type: "GOTO_STEP", step: "officials" });

    const step = walk(island.tree()).find((e) => typeof propsOf(e).onReplan === "function");
    expect(step, "OfficialsStep not rendered").toBeDefined();
    expect(propsOf(step!).courtNames).toBe(COURT_NAMES);
  });
});

describe("OfficialsStep threads courtNames into AiOfficialsReview (P9 review wave 3, finding #10, hop 2)", () => {
  it("the AiOfficialsReview element OfficialsStep renders carries the SAME courtNames it was given", () => {
    const stepProps: Parameters<typeof OfficialsStep>[0] = {
      state: { ...initialAiConsoleState, schedulePlan: SCHEDULE_PLAN, officialsPlan: officialsPlan() },
      dispatch: () => {},
      currency: "usd",
      fixtures: [],
      roster: [],
      policyRoles: ["referee"],
      hadPrior: false,
      busy: false,
      traceNonce: 0,
      wishes: [],
      onWishes: () => {},
      onReplan: () => {},
      onAdopt: () => {},
      onPulse: () => {},
      courtNames: COURT_NAMES,
    };
    const island = renderIsland(OfficialsStep, stepProps);
    const review = walk(island.tree()).find((e) => typeof propsOf(e).onAdopt === "function");
    expect(review, "AiOfficialsReview not rendered").toBeDefined();
    expect(propsOf(review!).courtNames).toBe(COURT_NAMES);
  });
});

describe("AiOfficialsReview renders resolved court names, never a raw uuid (P9 review wave 3, finding #10, behaviour)", () => {
  const placements = [
    { fixture_id: "f0", scheduled_at: "2026-08-01T10:00:00.000Z", court_label: COURT_1 },
    { fixture_id: "f1", scheduled_at: "2026-08-01T11:00:00.000Z", court_label: COURT_2 },
    { fixture_id: "f2", scheduled_at: "2026-08-01T12:00:00.000Z", court_label: "99999999-9999-4999-8999-999999999999" },
  ];

  function render(courtNames: Record<string, string>): string {
    const props: Parameters<typeof AiOfficialsReview>[0] = {
      plan: officialsPlan(),
      placements,
      quoteInput: { movableFixtures: 3, entrants: 0, courts: 2 },
      rung: null,
      onRung: () => {},
      currency: "usd",
      fixtures: [],
      roster: [],
      roles: ["referee"],
      hasPrior: false,
      busy: false,
      traceNonce: 0,
      error: null,
      instruction: "",
      adoptInstruction: "",
      onInstruction: () => {},
      wishes: [],
      onWishes: () => {},
      onReplan: () => {},
      onAdopt: () => {},
      onBack: () => {},
      onContinue: () => {},
      onPulse: () => {},
      courtNames,
    };
    return renderToStaticMarkup(
      <RungConfigProvider value={resolveRungConfig()}>
        <DictProvider dict={enDict} locale="en">
          <AiOfficialsReview {...props} />
        </DictProvider>
      </RungConfigProvider>,
    );
  }

  it("names two same-venue-colliding courts distinguishably, never their bare uuids", () => {
    const html = render(COURT_NAMES);
    expect(html).toContain("Court 1 (Riverside Centre)");
    expect(html).toContain("Court 1 (Downtown Hall)");
    expect(html).not.toContain(COURT_1);
    expect(html).not.toContain(COURT_2);
  });

  it("a court id with no courtNames entry degrades to the shared unknown-court string, never the raw id", () => {
    const html = render(COURT_NAMES);
    expect(html).toContain("Unknown court");
    expect(html).not.toContain("99999999-9999-4999-8999-999999999999");
  });

  it("an empty courtNames map (no venues loaded) degrades every row, never a raw uuid", () => {
    const html = render({});
    expect(html).not.toContain(COURT_1);
    expect(html).not.toContain(COURT_2);
    const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/;
    expect(html).not.toMatch(UUID_RE);
  });
});
