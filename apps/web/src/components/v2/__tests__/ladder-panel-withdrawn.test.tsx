// The ladder's challenge pickers must not offer a player who has left.
//
// `config.ladder_order` is written ONCE from the live field and never pruned,
// and a withdrawal is a status flip that leaves the row in place — so the
// panel's `ranked` list (built straight off that order) kept offering her in
// both <select>s. `issueChallenge` refuses her with a 422
// LADDER_ENTRANT_WITHDRAWN either way; that refusal is the backstop for a
// ladder that changed between render and POST, not the primary UX. A control
// that offers a choice the server will reject is a dead end wearing a menu.
//
// The TABLE is deliberately NOT filtered: she keeps the rung she earned (that
// is why the guard is a read-time filter rather than a prune), so removing
// the row would read as "she lost her place". It is marked instead.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// No jsdom in this workspace, and no app router under renderToStaticMarkup —
// same stub progression-panel-render.test.tsx uses for the same reason.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

import { LadderPanel } from "@/components/v2/ladder-panel";

const ENTRANTS = { a: "Ana", b: "Bo", c: "Cai", d: "Dee" };
const ORDER = ["a", "b", "c", "d"];

function render(departedEntrantIds: string[], canEdit = true): string {
  return renderToStaticMarkup(
    <LadderPanel
      stageId="s1"
      order={ORDER}
      entrants={ENTRANTS}
      departedEntrantIds={departedEntrantIds}
      locale="en"
      canEdit={canEdit}
      viewerPlan={{ planKey: "pro", isOwner: true } as never}
    />,
  );
}

/** Every entrant id the markup offers as a picker choice. Anchored on `="` so
 *  a React-serialised `"$undefined"` cannot pass for a real value. */
function offeredIds(html: string): string[] {
  return [...html.matchAll(/<option value="([^"]*)"/g)].map((m) => m[1]!).filter((v) => v !== "");
}

describe("LadderPanel — a withdrawn player is not selectable", () => {
  it("offers every rung while nobody has left (the control case)", () => {
    const ids = offeredIds(render([]));
    // Two selects, so every id appears twice.
    expect(new Set(ids)).toEqual(new Set(ORDER));
    expect(ids).toHaveLength(ORDER.length * 2);
  });

  it("drops the departed player from BOTH pickers and keeps everyone else", () => {
    const ids = offeredIds(render(["c"]));
    expect(ids).not.toContain("c");
    // The positive half: the filter removed exactly one player, not the list.
    expect(new Set(ids)).toEqual(new Set(["a", "b", "d"]));
    expect(ids).toHaveLength(3 * 2);
  });

  it("still shows her in the ladder table, marked — the rung is hers if she comes back", () => {
    const html = render(["c"]);
    expect(html).toContain('data-ladder-withdrawn="c"');
    expect(html).toContain("Cai");
    // Nobody else is marked.
    expect([...html.matchAll(/data-ladder-withdrawn="([^"]*)"/g)].map((m) => m[1])).toEqual(["c"]);
  });

  it("marks nobody when nobody has left", () => {
    expect(render([])).not.toContain("data-ladder-withdrawn");
  });

  it("a departure does not renumber the rungs above or below her", () => {
    // Rank is the row's position in `order`, and `order` is untouched: Dee is
    // 4th with or without Cai in the field. A filter applied to the TABLE
    // would move her to 3rd, which is the promotion this panel must not do.
    const rows = (html: string): string[] =>
      [...html.matchAll(/<td[^>]*>(\d+)<\/td>/g)].map((m) => m[1]!);
    expect(rows(render([]))).toEqual(["1", "2", "3", "4"]);
    expect(rows(render(["c"]))).toEqual(["1", "2", "3", "4"]);
  });
});
