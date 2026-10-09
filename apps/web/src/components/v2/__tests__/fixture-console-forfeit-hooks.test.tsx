// B07a Task 10 fix round 1 (R59(c)) — stable hooks on the organiser's forfeit
// controls. `core.forfeit` is authority-only on the scorer pad by design
// (`AUTHORITY_ONLY_EVENT_TYPES`, v3/pad-host.tsx), so the bench's tap driver
// authors it where the product does: the fixture console's Forfeit toggle, the
// per-side "<name> forfeits" button, and the reason prompt behind it. All four
// were findable only by translated text.
//
// Same identity discipline as `scorepad/v3/__tests__/tap-hooks.test.tsx`: a
// hook is proven to sit on the RIGHT control, never merely to exist. The menu
// and the prompt only render after a click, which `renderToStaticMarkup` can
// never show, so this file uses `_hook-harness.tsx`'s `renderIsland` — the
// FixtureConsole island set-up is `fixture-console-undo-pad-events.test.tsx`'s
// own. The per-side test goes one step further than text: it invokes the
// prompt's own `onSubmit` and asserts WHICH entrant the send names, so a hook
// pair swapped between the two buttons fails even though both still render.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import { FixtureConsole } from "@/components/v2/fixture-console";
import type { EventIn, SideInfo, SportInfo } from "@/components/v2/fixture-console";
import { propsOf, renderIsland, textOf, type Props } from "@/components/__tests__/_hook-harness";
import { messages } from "@/lib/messages";
import { t as tRuntime } from "@/lib/i18n-runtime";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

vi.mock("@/lib/client-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-v1")>();
  return {
    ...actual,
    apiV1: vi.fn((url: string) => {
      if (url.includes("/events")) return Promise.resolve([] as EventIn[]);
      return Promise.resolve({ status: "in_play", last_seq: 1, summary: null, state: {}, outcome: null });
    }),
  };
});

const sport: SportInfo = {
  key: "generic",
  config: {},
  scorerLabel: "Scorer",
  positionGroups: [],
  roles: [],
  lineupSize: 0,
  benchMax: 0,
};

const HOME: SideInfo = { id: "home-1", name: "Riverside FC", members: [], lineup: [] };
const AWAY: SideInfo = { id: "away-1", name: "Summit Athletic", members: [], lineup: [] };

function baseProps() {
  return {
    fixture: { id: "f1", status: "in_play", scheduled_at: null, venue_name: null, court_name: null, round_no: 1 },
    sport,
    home: HOME,
    away: AWAY,
    initialState: { status: "in_play", last_seq: 1, summary: null, state: {}, outcome: null },
    initialEvents: [] as EventIn[],
    canEdit: true,
    canOrganise: true,
    stageKind: null,
    viewerPlan: "community" as const,
  };
}

type Component = (props: Props) => ReactNode;

/** The console's own `<ForfeitButton …/>` element — the only child it hands
 *  `padSyncing` AND `send` (fixture-console.tsx's match-actions section). */
function forfeitButtonElement(): ReactElement {
  const island = renderIsland(FixtureConsole, baseProps());
  const el = island.tree().find((e) => typeof e.type === "function" && propsOf(e).padSyncing !== undefined && propsOf(e).send !== undefined);
  if (el === undefined) throw new Error("<ForfeitButton/> not found in an in_play console");
  return el;
}

function buttonsWith(tree: ReactElement[], testid: string): ReactElement[] {
  return tree.filter((e) => e.type === "button" && propsOf(e)["data-testid"] === testid);
}

/** The reason prompt element the menu opens (`TextPromptDialog`). */
function promptElement(tree: ReactElement[]): ReactElement {
  const el = tree.find((e) => typeof e.type === "function" && propsOf(e).initialValue !== undefined && propsOf(e).onSubmit !== undefined);
  if (el === undefined) throw new Error("the forfeit reason prompt did not open");
  return el;
}

beforeEach(() => {
  vi.useFakeTimers();
  // The open menu and the prompt each register a document listener in an effect.
  vi.stubGlobal("document", { addEventListener: () => {}, removeEventListener: () => {} });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("fixture console: the organiser's forfeit controls carry stable hooks", () => {
  it.each([
    ["home", HOME, AWAY],
    ["away", AWAY, HOME],
  ] as const)(
    "score-forfeit opens the menu, and score-forfeit-%s names ITS OWN side and forfeits ITS OWN entrant",
    (sideKey, own, other) => {
      const el = forfeitButtonElement();
      const send = vi.fn(async () => true);
      const island = renderIsland(el.type as Component, { ...propsOf(el), send });

      const toggles = buttonsWith(island.tree(), "score-forfeit");
      expect(toggles, 'exactly one <button data-testid="score-forfeit">').toHaveLength(1);
      expect(textOf(toggles[0]!)).toContain(tRuntime(messages, "score.forfeit"));
      expect(buttonsWith(island.tree(), `score-forfeit-${sideKey}`), "the per-side buttons exist only once the menu is open").toHaveLength(0);

      (propsOf(toggles[0]!).onClick as () => void)();
      const sideButtons = buttonsWith(island.tree(), `score-forfeit-${sideKey}`);
      expect(sideButtons, `exactly one <button data-testid="score-forfeit-${sideKey}">`).toHaveLength(1);
      expect(textOf(sideButtons[0]!)).toContain(own.name);
      expect(textOf(sideButtons[0]!)).not.toContain(other.name);

      (propsOf(sideButtons[0]!).onClick as () => void)();
      (propsOf(promptElement(island.tree())).onSubmit as (reason: string) => void)("retired hurt");
      expect(send).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledWith("core.forfeit", { by: own.id, reason: "retired hurt" });
    },
  );

  it("the reason prompt's hooks sit on the real reason field and the real submit button, never Cancel", () => {
    const el = forfeitButtonElement();
    const island = renderIsland(el.type as Component, { ...propsOf(el), send: vi.fn(async () => true) });
    (propsOf(buttonsWith(island.tree(), "score-forfeit")[0]!).onClick as () => void)();
    (propsOf(buttonsWith(island.tree(), "score-forfeit-away")[0]!).onClick as () => void)();
    const prompt = promptElement(island.tree());

    const dialog = renderIsland(prompt.type as Component, propsOf(prompt));
    const tree = dialog.tree();
    const reason = tree.filter((e) => propsOf(e)["data-testid"] === "score-prompt-reason");
    expect(reason, 'exactly one element with data-testid="score-prompt-reason"').toHaveLength(1);
    expect(reason[0]!.type).toBe("input");
    expect(propsOf(reason[0]!).name).toBe("reason");
    expect(propsOf(reason[0]!).type).toBe("text");

    const submit = buttonsWith(tree, "score-prompt-submit");
    expect(submit, 'exactly one <button data-testid="score-prompt-submit">').toHaveLength(1);
    expect(propsOf(submit[0]!).type).toBe("submit");
    expect(textOf(submit[0]!)).toContain(tRuntime(messages, "editor.apply"));
    expect(textOf(submit[0]!)).not.toContain(tRuntime(messages, "editor.cancel"));
  });
});
