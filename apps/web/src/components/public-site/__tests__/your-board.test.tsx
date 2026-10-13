// T16 (controller ruling 2026-10-12) — the public fixture page's "Your board"
// island: the page is ISR (one HTML for every viewer), so it can say nothing
// about who is looking. After hydration the island asks the lobby route
// (session only, `private, no-store`) and, for one of the two players, shows
// their board's state and the door into their room. Everyone else — anonymous,
// a stranger, another club's player — gets nothing.
//
//  - first paint: nothing at all, so the shared HTML never carries a room path;
//  - `loadYourBoard`: what reaches the network, and that every refusal or a
//    malformed answer reads as "nothing to show" (never a broken door);
//  - `YourBoardCard`: every lobby state, from the shared list, in four locales.
// The real route → island chain runs against the database in
// your-board-route.test.ts.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { t as tRuntime } from "@/lib/i18n-runtime";
import type { Dict } from "@/lib/i18n-constants";
import { ApiV1Error } from "@/lib/client-v1";
import { LOBBY_STATES, type ExternalPlayLobby } from "@/lib/external-play-lobby";

const LOCALES = ["en", "es", "fr", "nl"] as const;
type Loc = (typeof LOCALES)[number];
const DICTS = Object.fromEntries(
  LOCALES.map((l) => [l, JSON.parse(readFileSync(join(__dirname, "..", "..", "..", "dictionaries", l, "ui.json"), "utf8")) as Dict]),
) as Record<Loc, Dict>;
const current = vi.hoisted(() => ({ locale: "en" as string }));
vi.mock("@/components/i18n/dict-provider", () => ({
  useT: () => (key: string, vars?: Record<string, string | number>) => tRuntime(DICTS[current.locale as Loc], key, vars),
}));

const apiV1Mock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/client-v1", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  apiV1: apiV1Mock,
}));

import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import { YourBoard, YourBoardCard, loadYourBoard } from "../your-board";
import { SESSION_HINT_COOKIE } from "@/lib/session-hint";

const ROOM = "/shared/club/cup/open/fixtures/f1/play";
const answer = (state: ExternalPlayLobby["state"]): ExternalPlayLobby =>
  state === "online_chess_off" ? { state, roomPath: null } : { state, roomPath: ROOM, opensAt: null, deadline: null };
const s = (loc: Loc, key: string) => String(DICTS[loc][key]);
const esc = (x: string) => x.replaceAll("&", "&amp;").replaceAll("'", "&#x27;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

describe("Your board — first paint", () => {
  it("the empty case first: the server-rendered island is EMPTY — no room path in the shared (ISR) HTML", () => {
    const h = renderToStaticMarkup(<YourBoard fixtureId="f1" />);
    expect(h).toBe("");
    expect(h).not.toContain('="/shared/');
  });
});

describe("loadYourBoard — what reaches the network, and what a refusal reads as", () => {
  it("asks the lobby route for THIS fixture (encoded), never from a cache", async () => {
    const get = vi.fn(async () => answer("check_in"));
    expect(await loadYourBoard("f 1", get)).toEqual(answer("check_in"));
    expect(get).toHaveBeenCalledWith("/api/v1/fixtures/f%201/external-play/lobby", { cache: "no-store" });
  });

  it("anonymous (401), a stranger (404), a server fault, a network failure: nothing to show", async () => {
    const refusals: [string, unknown][] = [
      ["anonymous", new ApiV1Error("Not authenticated", 401, "UNAUTHENTICATED")],
      ["stranger", new ApiV1Error("This match room could not be found", 404, "NOT_FOUND")],
      ["server", new ApiV1Error("boom", 500, "INTERNAL")],
      ["network", new TypeError("fetch failed")],
    ];
    let checked = 0;
    for (const [label, err] of refusals) {
      expect(await loadYourBoard("f1", vi.fn(async () => Promise.reject(err))), label).toBeNull();
      checked += 1;
    }
    expect(checked).toBe(refusals.length);
  });

  it("a malformed answer is a guard, not an assumption: an unknown state, or a door that is not our room, shows nothing", async () => {
    const bad: unknown[] = [
      { state: "teleport", roomPath: ROOM, opensAt: null, deadline: null },
      { state: "check_in", roomPath: "https://lichess.org/abc", opensAt: null, deadline: null },
      { state: "check_in", roomPath: null, opensAt: null, deadline: null },
      { state: "online_chess_off", roomPath: ROOM },
      null,
    ];
    let checked = 0;
    for (const body of bad) {
      expect(await loadYourBoard("f1", vi.fn(async () => body)), JSON.stringify(body)).toBeNull();
      checked += 1;
    }
    expect(checked).toBe(bad.length);
  });
});

describe("YourBoardCard — every lobby state", () => {
  const card = (a: ExternalPlayLobby, loc: Loc = "en") => {
    current.locale = loc;
    return renderToStaticMarkup(<YourBoardCard view={a} />);
  };

  it("each state names itself; every state but 'off' opens the player's own room, and only that", () => {
    let checked = 0;
    for (const state of LOBBY_STATES) {
      const h = card(answer(state));
      expect(h, state).toContain(`data-testid="your-board" data-state="${state}"`);
      expect(h, state).toContain(esc(s("en", `externalPlay.yourBoard.state.${state}`)));
      if (state === "online_chess_off") {
        expect(h, `${state}: a plain state, no door`).not.toContain("<a");
      } else {
        expect(h, state).toMatch(new RegExp(`<a[^>]*data-testid="your-board-link"[^>]*href="${ROOM}"|<a[^>]*href="${ROOM}"[^>]*data-testid="your-board-link"`));
        expect(h, state).toContain(esc(s("en", "externalPlay.yourBoard.cta")));
        expect(h, `${state}: never a Lichess link`).not.toContain("lichess.org");
      }
      checked += 1;
    }
    expect(checked, "anti-vacuity: every lobby state").toBe(LOBBY_STATES.length);
  });

  it("every state's sentence exists in all four locales, each in its own words", () => {
    let checked = 0;
    for (const state of LOBBY_STATES) {
      for (const loc of LOCALES) {
        const key = `externalPlay.yourBoard.state.${state}`;
        expect(typeof DICTS[loc][key] === "string" && s(loc, key).trim().length > 0, `${loc} ${key}`).toBe(true);
        if (loc !== "en") expect(s(loc, key), `${loc} ${key}`).not.toBe(s("en", key));
        expect(card(answer(state), loc), `${loc} ${state}`).toContain(esc(s(loc, key)));
        checked += 1;
      }
    }
    expect(checked).toBe(LOBBY_STATES.length * LOCALES.length);
  });
});

describe("YourBoard — after hydration, and across a navigation", () => {
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  // The island asks only a browser that says someone is signed in (R2); every island case below is that browser.
  beforeEach(() => void vi.stubGlobal("document", { cookie: `${SESSION_HINT_COOKIE}=1` }));
  afterEach(() => void vi.unstubAllGlobals());
  /** The lobby's answers, each released by hand, so the ORDER they land in is the test's. */
  function lobby() {
    const pending = new Map<string, (v: unknown) => void>();
    apiV1Mock.mockReset();
    apiV1Mock.mockImplementation(
      (url: string) => new Promise((resolve) => pending.set(/fixtures\/([^/]+)\//.exec(url)![1]!, resolve)),
    );
    return async (fixtureId: string, state: ExternalPlayLobby["state"]) => {
      const room = `/shared/club/cup/open/fixtures/${fixtureId}/play`;
      pending.get(fixtureId)!(state === "online_chess_off" ? { state, roomPath: null } : { state, roomPath: room, opensAt: null, deadline: null });
      await flush();
    };
  }
  const cards = (island: { tree: () => ReactElement[] }) =>
    island.tree().filter((el) => el.type === YourBoardCard).map((el) => propsOf(el).view as ExternalPlayLobby);

  // T16 fix round 1, R2: without the signed-in hint the island asks NOTHING — an anonymous viewer would only be refused.
  it("R2: no signed-in hint ⇒ no lobby call at all and nothing drawn; the hint ⇒ the call", async () => {
    lobby();
    vi.stubGlobal("document", { cookie: "seazn_locale=fr" });
    const anon = renderIsland(YourBoard, { fixtureId: "f1" });
    await flush();
    expect(apiV1Mock, "anonymous: no request").not.toHaveBeenCalled();
    expect(cards(anon)).toEqual([]);
    vi.stubGlobal("document", { cookie: `seazn_locale=fr; ${SESSION_HINT_COOKIE}=1` });
    renderIsland(YourBoard, { fixtureId: "f1" });
    await flush();
    expect(apiV1Mock.mock.calls.map((c) => c[0])).toEqual(["/api/v1/fixtures/f1/external-play/lobby"]);
  });

  it("draws nothing until the lobby answers, then the player's own board", async () => {
    const answer = lobby();
    current.locale = "en";
    const island = renderIsland(YourBoard, { fixtureId: "f1" });
    await flush();
    expect(cards(island), "before the answer").toEqual([]);
    await answer("f1", "check_in");
    expect(cards(island).map((v) => [v.state, v.roomPath])).toEqual([["check_in", "/shared/club/cup/open/fixtures/f1/play"]]);
  });

  it("a navigation to another fixture never shows the previous fixture's door while its own is on the way", async () => {
    const answer = lobby();
    const island = renderIsland(YourBoard, { fixtureId: "f1" });
    await flush();
    await answer("f1", "check_in");
    expect(cards(island)).toHaveLength(1);
    island.rerender({ fixtureId: "f2" });
    await flush();
    expect(cards(island), "f2's page, f2's answer not in yet").toEqual([]);
    await answer("f2", "playing");
    expect(cards(island).map((v) => v.roomPath)).toEqual(["/shared/club/cup/open/fixtures/f2/play"]);
  });

  it("a late answer for the fixture left behind does not overwrite the current one", async () => {
    const answer = lobby();
    const island = renderIsland(YourBoard, { fixtureId: "f1" });
    await flush();
    island.rerender({ fixtureId: "f2" });
    await flush();
    await answer("f2", "playing");
    await answer("f1", "check_in"); // lands last
    expect(cards(island).map((v) => [v.state, v.roomPath])).toEqual([["playing", "/shared/club/cup/open/fixtures/f2/play"]]);
  });
});
