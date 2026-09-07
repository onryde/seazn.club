// Owner request (competition desk W3, on top of Option B) — the "Required
// court tags" collapsed summary row (248x16px, well under the 44px tap
// floor — the owner's own measurement) becomes a real button that opens a
// modal (`components/modal.tsx`, reused rather than a third bottom-sheet
// variant, breakpoint moved `sm:` -> `md:` INSIDE that file only — see its
// own comment for why the shared `.modal-overlay`/`.sheet-handle` classes
// were deliberately left alone).
//
// The regression this file exists to prevent, named explicitly in the
// brief: "court tags must stay VISIBLE to a viewer who cannot edit... a
// non-editing viewer must still see the current value — they simply get no
// button and no modal." `StageRail` already returns `null` for `!canEdit`;
// this component is the ONE place a non-editing viewer's read of a stage's
// court-tag requirement comes from (stages-panel.tsx's own `{!canEdit &&
// courtTagsEditor}` fallback, same "built once, one of two mutually
// exclusive spots" contract Ruling T3-A set for this exact element).
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import { msg } from "@/lib/messages";
import { StageCourtTagsEditor } from "@/components/v2/stages-panel";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

const net = vi.hoisted(() => ({ gets: [] as (() => Promise<unknown>)[] }));

vi.mock("@/lib/client-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-v1")>();
  return {
    ...actual,
    apiV1: (url: string) => {
      if (url.includes("/court-tags")) {
        const next = net.gets.shift();
        return next ? next() : Promise.resolve({});
      }
      return Promise.resolve({});
    },
  };
});

const STAGE_ID = "3d6c2e2a-0000-4000-8000-0000000000s1";
const EMPTY_VALUE = { stage_id: STAGE_ID, required_court_tags: [], rounds: [], available_round_roles: [] };

function toggle(island: { tree: () => ReactElement[] }) {
  const button = island.tree().find((el) => el.type === "button");
  (propsOf(button!).onClick as () => void)();
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("StageCourtTagsEditor — the trigger button (structural, editing viewer)", () => {
  it("is a real button, >= 44px (min-h-11), showing no value before first load", () => {
    const html = renderToStaticMarkup(
      <StageCourtTagsEditor stageId={STAGE_ID} canEdit suggestions={[]} msg={msg} />,
    );
    const tag = /<button[^>]*data-testid="stage-court-tags-trigger"[^>]*>/.exec(html);
    expect(tag, "trigger button not found").not.toBeNull();
    expect(tag![0]).toContain("min-h-11");
    // No modal content before the first open — SSR never runs the fetch
    // effect, so `loaded` is false and no summary/editor body exists yet.
    expect(html).not.toContain(msg("stagetags.desc"));
  });
});

describe("StageCourtTagsEditor — non-editing viewer gets no button and no modal", () => {
  it("renders no trigger button and no modal at all", () => {
    const html = renderToStaticMarkup(
      <StageCourtTagsEditor stageId={STAGE_ID} canEdit={false} suggestions={[]} msg={msg} />,
    );
    expect(html).not.toContain('data-testid="stage-court-tags-trigger"');
    expect(html).not.toContain('role="dialog"');
    // The wrapper testid — read by the mutually-exclusive-placement contract
    // in stages-panel.tsx — still renders either way.
    expect(html).toContain('data-testid="stage-court-tags"');
  });

  it("still shows the CURRENT VALUE once loaded — fetched on MOUNT, no click available to gate it on", async () => {
    net.gets.push(() => Promise.resolve({ ...EMPTY_VALUE, required_court_tags: ["indoor", "hard"] }));
    const island = renderIsland(StageCourtTagsEditor, {
      stageId: STAGE_ID,
      canEdit: false,
      suggestions: [],
      msg,
    });
    // No click — a non-editing viewer has no button to tap. The value must
    // still arrive.
    await flush();
    expect(island.text(), "current value did not load for a non-editing viewer").toContain("indoor, hard");
    expect(island.text()).toContain(msg("stagetags.title"));
    expect(island.text(), "no button/modal means no editor-body copy either").not.toContain(msg("stagetags.desc"));
  });
});

describe("StageCourtTagsEditor — editing viewer: click opens the modal, with the editor body untouched", () => {
  it("shows the label alone before first load, then the label + value once opened and loaded", async () => {
    net.gets.push(() => Promise.resolve({ ...EMPTY_VALUE, required_court_tags: ["clay"] }));
    const island = renderIsland(StageCourtTagsEditor, {
      stageId: STAGE_ID,
      canEdit: true,
      suggestions: [],
      msg,
    });
    expect(island.text()).toContain(msg("stagetags.title"));
    expect(island.text(), "value leaked before any load").not.toContain("clay");

    toggle(island); // open
    await flush();
    expect(island.text(), "trigger's own current-value readout did not update").toContain("clay");
    // The editor body — untouched behaviour, still there, still inside
    // whatever `open` now renders.
    expect(island.text()).toContain(msg("stagetags.desc"));
    expect(island.text()).toContain(msg("stagetags.rounds.heading"));
  });

  it("surfaces a load error the same way as before (loadError / error state, unchanged)", async () => {
    net.gets.push(() => Promise.reject(new Error("court-tags boom")));
    const island = renderIsland(StageCourtTagsEditor, {
      stageId: STAGE_ID,
      canEdit: true,
      suggestions: [],
      msg,
    });
    toggle(island);
    await flush();
    expect(island.text()).toContain("court-tags boom");
  });
});
