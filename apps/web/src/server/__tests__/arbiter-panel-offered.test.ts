// `arbiterPanelOffered` - the ONE statement of when the Arbiter Panel answers (server/arbiter-panel-offered.ts). The arbiter page
// 404s on it and the division page's Fixtures tab offers the panel on it, so the two can never disagree about a division. This
// suite is the function's own; each page's wiring is `arbiter/__tests__/page.test.tsx` and
// `d/[divSlug]/__tests__/arbiter-entry-link.test.tsx`.
//
// Expected values come from the rule as the spec states it (canEdit AND the division plays online AND the caller's own cheap
// condition AND the club is offered online chess; online play exists only for the `boardgame` sport), never from the function.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { forEachSport } from "@seazn/engine/testkit";
import type { AuthCtx } from "@/server/api-v1/auth";

const flag = vi.hoisted(() => ({ offered: vi.fn() }));
vi.mock("@/server/usecases/external-play", () => ({ onlineChessOffered: flag.offered }));

import { arbiterPanelOffered } from "../arbiter-panel-offered";

const AUTH = { orgId: "org-1", userId: "user-1" } as unknown as AuthCtx;
const LICHESS = { onlinePlay: "lichess" };

beforeEach(() => {
  flag.offered.mockReset().mockResolvedValue(true);
});

describe("arbiterPanelOffered", () => {
  it("the empty case first: a viewer on a chess division playing online is not offered the panel, and the flag is never asked", async () => {
    expect(await arbiterPanelOffered(AUTH, { canEdit: false, sport_key: "boardgame", config: LICHESS })).toBe(false);
    expect(flag.offered).not.toHaveBeenCalled();
    // The positive pair: the same division for an editor.
    expect(await arbiterPanelOffered(AUTH, { canEdit: true, sport_key: "boardgame", config: LICHESS })).toBe(true);
    expect(flag.offered).toHaveBeenCalledTimes(1);
  });

  it("every sport in the registry: only the chess sport is ever offered the panel, and the flag is asked for it alone", async () => {
    // The registry's own order (forEachSport refuses an empty registry); the awaits run below because its body must be synchronous.
    const keys: string[] = [];
    const visited = forEachSport(({ key }) => void keys.push(key));
    expect(visited, "anti-vacuity: the registry is not empty, and every sport was collected").toBe(keys.length);
    expect(keys.length).toBeGreaterThan(0);
    const offered: string[] = [];
    for (const key of keys) {
      flag.offered.mockClear();
      const answer = await arbiterPanelOffered(AUTH, { canEdit: true, sport_key: key, config: LICHESS });
      // Online play exists only for `boardgame` (the spec's rule); a stored onlinePlay on any other sport is not a reason to offer it.
      expect(answer, key).toBe(key === "boardgame");
      expect(flag.offered.mock.calls.length, `${key}: the flag is asked only where every part before it said yes`).toBe(key === "boardgame" ? 1 : 0);
      if (answer) offered.push(key);
    }
    expect(keys, "premise: the chess sport is in the registry (so the positive case ran)").toContain("boardgame");
    expect(offered, "exactly one sport is offered").toEqual(["boardgame"]);
  });

  it("the whole table: canEdit x onlinePlay x the caller's condition x the flag - offered only when all four hold, the flag asked only when the first three do", async () => {
    const configs: [string, unknown, boolean][] = [
      ["lichess", { onlinePlay: "lichess" }, true],
      ["off", { onlinePlay: "off" }, false],
      ["absent", {}, false],
      ["null config", null, false],
      ["an unknown mode", { onlinePlay: "LICHESS" }, false],
    ];
    let cells = 0;
    let offeredCells = 0;
    for (const canEdit of [true, false]) {
      for (const [label, config, plays] of configs) {
        for (const before of [true, false]) {
          for (const flagAnswer of [true, false]) {
            flag.offered.mockReset().mockResolvedValue(flagAnswer);
            const answer = await arbiterPanelOffered(AUTH, { canEdit, sport_key: "boardgame", config }, () => before);
            const cheap = canEdit && plays && before;
            const name = `canEdit=${canEdit} onlinePlay=${label} before=${before} flag=${flagAnswer}`;
            expect(answer, name).toBe(cheap && flagAnswer);
            expect(flag.offered.mock.calls.length, `${name}: flag asked?`).toBe(cheap ? 1 : 0);
            cells++;
            if (answer) offeredCells++;
          }
        }
      }
    }
    expect(cells, "anti-vacuity: every cell ran").toBe(2 * 5 * 2 * 2);
    expect(offeredCells, "exactly one cell offers the panel").toBe(1);
  });

  it("cheapest first: the caller's condition is not even evaluated when a static part already said no, and it runs BEFORE the flag", async () => {
    const before = vi.fn(() => true);
    await arbiterPanelOffered(AUTH, { canEdit: false, sport_key: "boardgame", config: LICHESS }, before);
    await arbiterPanelOffered(AUTH, { canEdit: true, sport_key: "generic", config: LICHESS }, before);
    await arbiterPanelOffered(AUTH, { canEdit: true, sport_key: "boardgame", config: { onlinePlay: "off" } }, before);
    expect(before, "no static part passed, so the caller's condition was not asked").not.toHaveBeenCalled();

    expect(await arbiterPanelOffered(AUTH, { canEdit: true, sport_key: "boardgame", config: LICHESS }, before)).toBe(true);
    expect(before).toHaveBeenCalledTimes(1);
    expect(before.mock.invocationCallOrder[0]!, "the caller's cheap condition before the remote flag").toBeLessThan(flag.offered.mock.invocationCallOrder[0]!);
  });

  it("the flag is asked once, for the page's own auth, and its answer is the answer", async () => {
    flag.offered.mockResolvedValue(false);
    expect(await arbiterPanelOffered(AUTH, { canEdit: true, sport_key: "boardgame", config: LICHESS })).toBe(false);
    expect(flag.offered).toHaveBeenCalledTimes(1);
    expect(flag.offered).toHaveBeenCalledWith(AUTH);
  });
});
