// T16 — the "Your board" island against its REAL producer: `loadYourBoard`
// through the real `apiV1` client, `fetch` routed to the REAL lobby route
// handler, which reads the real usecase on the database. Who gets a door is
// decided once (the room's read); this proves the island renders exactly that
// answer and nothing for anyone else — and that with the club's flag off a
// board whose game exists still gets its door (finishing play is never gated,
// T20) while one with no game gets the plain off state.
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AuthError } from "@/lib/errors";

const authState = vi.hoisted(() => ({ userId: "" }));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requireUser: async () => {
      if (!authState.userId) throw new AuthError("Not authenticated");
      return { id: authState.userId };
    },
    getCurrentUser: async () => (authState.userId ? { id: authState.userId } : null),
  };
});
const flag = vi.hoisted(() => ({ on: true }));
vi.mock("@/lib/posthog-server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/posthog-server")>();
  return { ...actual, isServerFeatureEnabled: vi.fn(async () => flag.on) };
});
vi.mock("@/components/i18n/dict-provider", () => ({ useT: () => (key: string) => key }));

import { sql } from "@/lib/db";
import * as lobbyRoute from "@/app/api/v1/fixtures/[id]/external-play/lobby/route";
import { makeUser } from "@/server/usecases/__tests__/_seed";
import { seedOnlineChessFixture, type SeedOnlineChessFixtureResult } from "@/server/usecases/__tests__/_external-play-seed";
import { forgetOnlineChessFlagCache } from "@/server/usecases/external-play/online-chess-flag";
import { YourBoardCard, loadYourBoard } from "../your-board";

const HAS_DB = !!process.env.DATABASE_URL;
const OPENED = new Date(Date.now() - 2 * 60_000);

beforeEach(() => {
  authState.userId = "";
  flag.on = true;
  // Every request the island makes goes to the real route handler, as the browser's would.
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const id = /\/fixtures\/([^/]+)\/external-play\/lobby$/.exec(url)?.[1];
    if (!id) throw new Error(`unexpected request ${url}`);
    return lobbyRoute.GET(new Request(`https://test.local${url}`, init), { params: Promise.resolve({ id: decodeURIComponent(id) }) });
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  forgetOnlineChessFlagCache();
});
afterAll(async () => {
  if (HAS_DB) await sql.end({ timeout: 2 }).catch(() => undefined);
});

const seed = () =>
  seedOnlineChessFixture({ onlinePlay: "lichess", divisionStarted: true, scheduledAt: OPENED, roundOpenedAt: OPENED, linked: true });
const island = async (fixtureId: string) => {
  const view = await loadYourBoard(fixtureId);
  return { view, html: view === null ? "" : renderToStaticMarkup(<YourBoardCard view={view} />) };
};
/** Labelled SQL: the room's create writes this row; here it stands for "a game exists". */
const gameOnFile = (s: SeedOnlineChessFixtureResult) => sql`
  insert into fixture_external_play
    (fixture_id, org_id, status, scheduled_at_basis, challenge_id, white_side, white_lichess_id, black_lichess_id)
  values (${s.fixtureId}, ${s.orgId}, 'live', ${OPENED}, ${`gm-${randomUUID().slice(0, 12)}`}, 'home', ${s.home.lichessId}, ${s.away.lichessId})`;

describe.skipIf(!HAS_DB)("Your board ← the real lobby route", () => {
  it("each player gets the door to THEIR room; anonymous and a stranger get nothing", async () => {
    const s = await seed();
    const stranger = await makeUser("your-board-stranger");
    const cells: [string, string, boolean][] = [
      ["home player", s.home.userId, true],
      ["away player", s.away.userId, true],
      ["anonymous", "", false],
      ["stranger", stranger.id, false],
    ];
    let checked = 0;
    for (const [label, userId, door] of cells) {
      authState.userId = userId;
      const { view, html } = await island(s.fixtureId);
      if (door) {
        expect(view?.state, label).toBe("check_in");
        expect(html, label).toMatch(new RegExp(`data-testid="your-board-link"[^>]*href="[^"]*/fixtures/${s.fixtureId}/play"|href="[^"]*/fixtures/${s.fixtureId}/play"[^>]*data-testid="your-board-link"`));
      } else {
        expect(view, label).toBeNull();
        expect(html, label).toBe("");
      }
      checked += 1;
    }
    expect(checked, "anti-vacuity: viewers checked").toBe(cells.length);
  });

  it("flag off: no game ⇒ the plain off state, no door; a game on file ⇒ the door (finishing play is never gated)", async () => {
    const s = await seed();
    authState.userId = s.home.userId;
    vi.stubEnv("ONLINE_CHESS_ALWAYS", undefined);
    flag.on = false;
    forgetOnlineChessFlagCache();
    const off = await island(s.fixtureId);
    expect(off.view).toEqual({ state: "online_chess_off", roomPath: null });
    expect(off.html).toContain('data-state="online_chess_off"');
    expect(off.html).not.toContain("<a");

    await gameOnFile(s);
    const on = await island(s.fixtureId);
    expect(on.view?.state).toBe("playing");
    expect(on.html).toContain('data-testid="your-board-link"');
  });
});
