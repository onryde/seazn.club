// T15 — the arbiter page (/o/{org}/c/{comp}/d/{div}/arbiter): organisers
// only, an online chess division only, and the panel gets the round the
// loader read for THIS division plus the board asked for in `?fixture=`.
// The page never joins a meeting itself: tokens are fetched by the arbiter's
// own browser, after mount (spec §10), so nothing secret is in the HTML.
//
// Same scaffold as the division page's tests: no jsdom, the async server
// component called directly, its returned tree read.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement } from "react";

const pageAuth = vi.hoisted(() => ({ requireDivisionPage: vi.fn() }));
const division = vi.hoisted(() => ({ sport_key: "boardgame", config: { onlinePlay: "lichess" } as Record<string, unknown> | null }));
const usecases = vi.hoisted(() => ({ loadArbiterRound: vi.fn(), arbiterRequestedRound: vi.fn(), joinAsArbiter: vi.fn() }));

vi.mock("@/server/page-auth", () => pageAuth);
vi.mock("@/server/usecases/divisions", () => ({
  getDivision: vi.fn(async () => ({ id: "div-1", sport_key: division.sport_key, config: division.config })),
}));
vi.mock("@/server/usecases/external-play", () => usecases);

import ArbiterPage from "../page";
import { ArbiterPanel } from "@/components/v2/arbiter-panel";

const PAGE = { auth: { orgId: "org-1", userId: "user-1", role: "owner", via: "session" }, canEdit: true, division: { id: "div-1" } };
const ROUND = { stageId: "st", stageName: "Open", roundNo: 2, timeControl: "10+5", boards: [], ownBoards: 0, current: true };
const render = (search: Record<string, string | string[] | undefined> = {}) =>
  ArbiterPage({
    params: Promise.resolve({ orgSlug: "org", compSlug: "comp", divSlug: "div" }),
    searchParams: Promise.resolve(search),
  });
const notFound = (p: Promise<unknown>) => expect(p).rejects.toMatchObject({ digest: expect.stringContaining("404") });

beforeEach(() => {
  division.sport_key = "boardgame";
  division.config = { onlinePlay: "lichess" };
  pageAuth.requireDivisionPage.mockReset().mockResolvedValue(PAGE);
  usecases.loadArbiterRound.mockReset().mockResolvedValue(ROUND);
  usecases.arbiterRequestedRound.mockReset().mockResolvedValue({ kind: "round", stageId: "st", roundNo: 1 });
  usecases.joinAsArbiter.mockReset();
});

describe("the arbiter page", () => {
  it("an organiser on an online chess division: the panel, the asked-for board's OWN round (I3), that board", async () => {
    const tree = (await render({ fixture: "fx-9" })) as ReactElement;
    expect(isValidElement(tree)).toBe(true);
    expect(tree.type).toBe(ArbiterPanel);
    expect(tree.props).toEqual({ round: ROUND, requested: null, slugs: { org: "org", comp: "comp", div: "div" }, initialFixtureId: "fx-9" });
    expect(usecases.arbiterRequestedRound).toHaveBeenCalledWith(PAGE.auth, "div-1", "fx-9");
    expect(usecases.loadArbiterRound).toHaveBeenCalledWith(PAGE.auth, "div-1", { round: { stageId: "st", roundNo: 1 } });
    expect(pageAuth.requireDivisionPage).toHaveBeenCalledWith("org", "comp", "div", { tail: "/arbiter" });
    expect(usecases.joinAsArbiter, "no token is minted for the HTML").not.toHaveBeenCalled();
  });

  it("no ?fixture= (or a repeated one) opens on the panel's default board; no round open is still the panel", async () => {
    usecases.loadArbiterRound.mockResolvedValue(null);
    let checked = 0;
    for (const search of [{}, { fixture: ["a", "b"] }]) {
      const tree = (await render(search)) as ReactElement<{ initialFixtureId: unknown; round: unknown; requested: unknown }>;
      expect(tree.props.initialFixtureId).toBeNull();
      expect(tree.props.round).toBeNull();
      expect(tree.props.requested).toBeNull();
      expect(usecases.loadArbiterRound).toHaveBeenLastCalledWith(PAGE.auth, "div-1", {});
      checked++;
    }
    expect(checked).toBe(2);
    expect(usecases.arbiterRequestedRound, "nothing asked for").not.toHaveBeenCalled();
  });

  it("I3: a board that is not here (or is the viewer's own) is SAID so — no round loaded, so no other board can open", async () => {
    let checked = 0;
    for (const kind of ["unavailable", "own"] as const) {
      usecases.loadArbiterRound.mockClear();
      usecases.arbiterRequestedRound.mockResolvedValue({ kind });
      const tree = (await render({ fixture: "fx-gone" })) as ReactElement<{ initialFixtureId: unknown; round: unknown; requested: unknown }>;
      expect(tree.props.requested, kind).toBe(kind);
      expect(tree.props.round, kind).toBeNull();
      expect(tree.props.initialFixtureId).toBe("fx-gone");
      expect(usecases.loadArbiterRound, kind).not.toHaveBeenCalled();
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("404 for a viewer, for a division that does not play online, and for another sport — the loader never asked", async () => {
    const cases: [string, () => void][] = [
      ["viewer", () => pageAuth.requireDivisionPage.mockResolvedValue({ ...PAGE, canEdit: false })],
      ["over the board", () => (division.config = { variant: "classical" })],
      ["no config", () => (division.config = null)],
      ["another sport", () => (division.sport_key = "generic")],
    ];
    let checked = 0;
    for (const [label, arm] of cases) {
      division.sport_key = "boardgame";
      division.config = { onlinePlay: "lichess" };
      pageAuth.requireDivisionPage.mockResolvedValue(PAGE);
      arm();
      await notFound(render());
      expect(usecases.loadArbiterRound, label).not.toHaveBeenCalled();
      checked++;
    }
    expect(checked).toBe(4);
  });
});
