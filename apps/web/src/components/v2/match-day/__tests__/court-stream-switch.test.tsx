// The Stream switch, driven (court stream spec 2026-11-14 §5.2; web plan Task 12, review W-C I-1, M-1, M-2). apps/web vitest is
// `environment: "node"`, so the click is driven through `renderIsland` with the v1 transport doubled: what the PUT was handed, what
// the switch shows once it is refused, and that it follows the board again once the board has answered.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderIsland, propsOf } from "@/components/__tests__/_hook-harness";
import en from "@/dictionaries/en/ui.json";
import type { Dict } from "@/lib/i18n-constants";
import { ApiV1Error } from "@/lib/client-v1";
import type { SwitchSpec } from "@/lib/match-day/court-stream";
import { CourtStreamSwitch } from "../court-stream-switch";
import type { MatchDayCtx } from "../court-focus";

const apiV1 = vi.fn<(url: string, options?: { method?: string; json?: unknown }) => Promise<unknown>>(async () => ({}));
vi.mock("@/lib/client-v1", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/client-v1")>()),
  apiV1: (url: string, options?: { method?: string; json?: unknown }) => apiV1(url, options),
}));

const ctx = { dict: en as Dict } as MatchDayCtx;
const fixture = { id: "f-1", home: "Zara Khan", away: "Ella Brooks" };
const off: SwitchSpec = { on: false, lock: null };
const on: SwitchSpec = { on: true, lock: null };

type Props = Parameters<typeof CourtStreamSwitch>[0];
const props = (spec: SwitchSpec, o: Partial<Props> = {}): Props => ({
  ctx, fixture, spec, onChanged: vi.fn(), onRefused: vi.fn(), ...o,
});

const find = (tree: ReactElement[], id: string) => tree.find((el) => propsOf(el)["data-testid"] === id);
const checked = (tree: ReactElement[]) => propsOf(find(tree, "md-cs-switch")!)["aria-checked"];
const click = async (island: { tree: () => ReactElement[] }) => {
  (propsOf(find(island.tree(), "md-cs-switch")!).onClick as () => void)();
  // The handler is `void turn()`: let its awaited PUT and the state it sets settle, the way the browser's task queue would.
  await vi.waitFor(() => expect(propsOf(find(island.tree(), "md-cs-switch")!).disabled).toBe(false));
};

beforeEach(() => {
  apiV1.mockReset().mockResolvedValue({});
});

describe("a refused turn", () => {
  it("puts the switch back where it was (409 has_own_stream_code on a row the refresh keeps), says why in the row and to the court's notice", async () => {
    apiV1.mockRejectedValue(new ApiV1Error("own", 409, "has_own_stream_code"));
    const p = props(off);
    const island = renderIsland(CourtStreamSwitch, p);
    expect(checked(island.tree())).toBe(false);
    await click(island);
    expect(apiV1).toHaveBeenCalledWith("/api/v1/fixtures/f-1/court-stream", { method: "PUT", json: { on: true } });
    expect(checked(island.tree()), "refused: not left showing ON").toBe(false);
    expect(propsOf(find(island.tree(), "md-cs-switch-failed")!).children).toBe("This match has its own stream code");
    expect(p.onRefused).toHaveBeenCalledWith("This match has its own stream code");
    expect(p.onChanged).not.toHaveBeenCalled();
  });
});

describe("a saved turn", () => {
  it("shows the choice at once and follows the board once the board answers: another desk turning it off shows on the next refresh", async () => {
    const p = props(off);
    const island = renderIsland(CourtStreamSwitch, p);
    await click(island);
    expect(p.onChanged).toHaveBeenCalledTimes(1);
    expect(checked(island.tree()), "before the board has answered").toBe(true);
    island.rerender({ ...p, spec: on }); // the refresh: the board agrees
    expect(checked(island.tree())).toBe(true);
    island.rerender({ ...p, spec: off }); // another desk turned it off
    expect(checked(island.tree()), "the server's value, not the organiser's old choice").toBe(false);
    island.rerender({ ...p, spec: on }); // and on again
    expect(checked(island.tree())).toBe(true);
  });
});

describe("what a screen reader hears", () => {
  it("each switch is named with its match; the lock's reason is its description only, never in the name", () => {
    const free = renderIsland(CourtStreamSwitch, props(off));
    expect(propsOf(find(free.tree(), "md-cs-switch")!)["aria-label"]).toBe("Stream: Zara Khan v Ella Brooks");
    const other = renderIsland(CourtStreamSwitch, props(off, { fixture: { id: "f-2", home: "Isha Rao", away: "Lily Chen" } }));
    expect(propsOf(find(other.tree(), "md-cs-switch")!)["aria-label"]).toBe("Stream: Isha Rao v Lily Chen");

    const locked = renderIsland(CourtStreamSwitch, props({ on: false, lock: "own_code" }));
    const btn = propsOf(find(locked.tree(), "md-cs-switch")!);
    expect(btn["aria-label"]).toBe("Stream: Zara Khan v Ella Brooks");
    expect(btn["aria-describedby"]).toBe(propsOf(find(locked.tree(), "md-cs-switch-reason")!).id);
    expect(propsOf(find(locked.tree(), "md-cs-switch-reason")!).children).toBe("This match has its own stream code");
  });

  it("the row's refusal line is not a live region: the court's notice is the one announcement", async () => {
    apiV1.mockRejectedValue(new ApiV1Error("own", 409, "has_own_stream_code"));
    const island = renderIsland(CourtStreamSwitch, props(off));
    await click(island);
    const line = propsOf(find(island.tree(), "md-cs-switch-failed")!);
    expect(line.role).toBeUndefined();
    expect(line["aria-live"]).toBeUndefined();
  });
});
