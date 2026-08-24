// #622 review: GET success after a failed load must clear the stale
// load-failed banner. Fail → close → reopen → success left the form
// editable under the previous error because neither `loadError` nor
// `error` was reset on the happy path.
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import { msg } from "@/lib/messages";
import { StageCourtTagsEditor } from "@/components/v2/stages-panel";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

const net = vi.hoisted(() => ({
  gets: [] as (() => Promise<unknown>)[],
}));

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

function toggle(island: { tree: () => ReactElement[] }) {
  const button = island.tree().find((el) => el.type === "button");
  (propsOf(button!).onClick as () => void)();
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("StageCourtTagsEditor — load error does not stick after a later success", () => {
  beforeEach(() => {
    net.gets = [];
  });

  it("clears the load-failed banner when a later GET succeeds", async () => {
    net.gets.push(
      () => Promise.reject(new Error("load boom")),
      () =>
        Promise.resolve({
          stage_id: STAGE_ID,
          required_court_tags: ["indoor"],
          rounds: [],
          available_round_roles: ["plain_round_1"],
        }),
    );
    const island = renderIsland(StageCourtTagsEditor, {
      stageId: STAGE_ID,
      canEdit: true,
      suggestions: [],
      msg,
    });
    toggle(island);
    await flush();
    expect(island.text()).toContain("load boom");

    toggle(island); // close
    toggle(island); // reopen — second GET succeeds
    await flush();
    expect(island.text()).toContain(msg("stagetags.desc"));
    expect(island.text()).not.toContain("load boom");
  });
});
