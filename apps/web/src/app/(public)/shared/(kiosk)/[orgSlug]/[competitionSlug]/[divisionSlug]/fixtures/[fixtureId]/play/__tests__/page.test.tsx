// T14 — the match-room page: who the visitor is (a `?t=` personal link wins,
// else the session), what the first snapshot is (the SAME usecase the GET
// route serves), and what a visitor who is not one of the two players sees
// (the one "not available" card — never a 500, never a hint which). The
// shell's own behaviour is the match-room suite's; this file proves the gate.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { HttpError } from "@/lib/errors";
import type { RoomSnapshot } from "@/components/public-site/match-room/room-snapshot";

const room = vi.hoisted(() => ({ readRoom: vi.fn(), roomGrantDowngraded: vi.fn() }));
vi.mock("@/server/usecases/external-play/room", () => ({ readRoom: room.readRoom, roomGrantDowngraded: room.roomGrantDowngraded }));
const auth = vi.hoisted(() => ({ getCurrentUser: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getCurrentUser: auth.getCurrentUser }));
const org = vi.hoisted(() => ({ publicOrgOrNull: vi.fn() }));
vi.mock("@/server/public-site/org-guard", () => ({ publicOrgOrNull: org.publicOrgOrNull }));
const nav = vi.hoisted(() => ({
  redirect: vi.fn((to: string) => {
    throw new Error(`CALLED_REDIRECT:${to}`);
  }),
}));
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  redirect: nav.redirect,
  // I2: the re-pair card's page re-asker (RepairingRefresh) reads the router; never called in a static render.
  useRouter: () => ({ refresh: vi.fn() }),
}));

import MatchRoomPage, { dynamic, generateMetadata } from "../page";
import { RoomShell } from "@/components/public-site/match-room/room-shell";
import { RoomHeaderless, RoomRepairingHeaderless } from "@/components/public-site/match-room/room-unavailable";
import { RepairingRefresh } from "@/components/public-site/match-room/room-repairing-refresh";
import NL from "@/dictionaries/nl/ui.json";
import { DictProvider } from "@/components/i18n/dict-provider";

const PARAMS = { orgSlug: "org", competitionSlug: "comp", divisionSlug: "div", fixtureId: "f1" };
const SNAP = { fixtureId: "f1", links: { fixture: "/shared/org/comp/div/fixtures/f1", standings: "/shared/org/comp/div" } };

function walk(node: ReactNode, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) {
    for (const n of node) walk(n, out);
    return out;
  }
  if (!isValidElement(node)) return out;
  out.push(node);
  walk((node.props as { children?: ReactNode }).children, out);
  return out;
}
async function render(t?: string | string[], params = PARAMS) {
  const el = await MatchRoomPage({ params: Promise.resolve(params), searchParams: Promise.resolve(t === undefined ? {} : { t }) });
  return walk(el);
}
const find = (els: ReactElement[], type: unknown) => els.find((e) => e.type === type);

beforeEach(() => {
  vi.clearAllMocks();
  room.readRoom.mockReset();
  // An intact grant unless a test says otherwise (P10: Lichess is asked once per load).
  room.roomGrantDowngraded.mockReset().mockResolvedValue(false);
  auth.getCurrentUser.mockReset();
  org.publicOrgOrNull.mockResolvedValue({ org: { default_locale: "nl" } });
});

describe("match-room page", () => {
  it("is dynamic, never indexed, never sends the personal link on as a Referer, and titles itself in the org's language", async () => {
    expect(dynamic).toBe("force-dynamic");
    const meta = await generateMetadata({ params: Promise.resolve(PARAMS) });
    expect(meta.robots).toEqual({ index: false, follow: false });
    expect(meta.referrer).toBe("no-referrer");
    expect([meta.title, meta.description]).toEqual(["Jouw bord", "Speel je online schaakpartij voor deze wedstrijd."]);
    expect(room.readRoom, "the head never reads the room (it never names the players)").not.toHaveBeenCalled();
  });

  it("a ?t= link reads THAT player's room — the session is not even consulted — and the shell gets the snapshot, the token and its own path", async () => {
    room.readRoom.mockResolvedValue(SNAP);
    const els = await render("tok.en/1");
    expect(room.readRoom).toHaveBeenCalledWith({ kind: "token", token: "tok.en/1" }, "f1");
    expect(auth.getCurrentUser).not.toHaveBeenCalled();
    const shell = find(els, RoomShell)!;
    expect(shell.props).toEqual({ initial: SNAP, token: "tok.en/1", selfPath: "/shared/org/comp/div/fixtures/f1/play?t=tok.en%2F1", grantRefused: false });
    expect((find(els, DictProvider)!.props as { locale: string }).locale, "the org's language").toBe("nl");
  });

  it("no link: the session reads its own seat", async () => {
    auth.getCurrentUser.mockResolvedValue({ id: "u1" });
    room.readRoom.mockResolvedValue(SNAP);
    const els = await render();
    expect(room.readRoom).toHaveBeenCalledWith({ kind: "session", userId: "u1" }, "f1");
    expect((find(els, RoomShell)!.props as { token: unknown; selfPath: string })).toMatchObject({ token: null, selfPath: "/shared/org/comp/div/fixtures/f1/play" });
  });

  it("the empty case: no link and no session ⇒ the not-available card, and no room is read", async () => {
    auth.getCurrentUser.mockResolvedValue(null);
    const els = await render();
    expect(room.readRoom).not.toHaveBeenCalled();
    expect(room.roomGrantDowngraded, "no identity, nobody to ask Lichess about").not.toHaveBeenCalled();
    expect(find(els, RoomShell)).toBeUndefined();
    expect((find(els, RoomHeaderless)!.props as { fixtureHref: string }).fixtureHref).toBe("/shared/org/comp/div/fixtures/f1");
  });

  it("a link or session the room refuses (404) is the same not-available card", async () => {
    room.readRoom.mockRejectedValue(new HttpError(404, "This match room could not be found", "NOT_FOUND"));
    const els = await render("bad");
    expect(find(els, RoomShell)).toBeUndefined();
    expect(find(els, RoomHeaderless)).toBeDefined();
    expect(room.roomGrantDowngraded, "a refused room asks Lichess nothing").not.toHaveBeenCalled();
  });

  it("final re-review 4, I2: a page loaded inside a re-pair gap (409) is the re-pair card, headerless — never card 7's 'it may belong to other players' — with the page re-asker; never the error boundary; any OTHER 409 is a fault", async () => {
    room.readRoom.mockRejectedValue(new HttpError(409, "This board is being re-paired", "ROOM_BEING_REPAIRED"));
    const page = await MatchRoomPage({ params: Promise.resolve(PARAMS), searchParams: Promise.resolve({ t: "tok" }) });
    const els = walk(page);
    expect(find(els, RoomShell)).toBeUndefined();
    expect(find(els, RoomHeaderless), "never card 7").toBeUndefined();
    expect(find(els, RoomRepairingHeaderless), "the re-pair card").toBeDefined();
    expect(find(walk(RoomRepairingHeaderless({ t: (k) => k })), RepairingRefresh), "and the page re-asker").toBeDefined();
    const html = renderToStaticMarkup(page as ReactElement);
    expect(html).toContain('data-screen="repairing"');
    expect(html, "in the org's language").toContain(NL["externalPlay.room.state.repairing.title"]);
    expect(html).not.toContain(NL["externalPlay.room.state.unavailable.body"]);
    expect(html).not.toContain(NL["externalPlay.room.state.unavailable.title"]);
    expect(room.roomGrantDowngraded, "nothing asked of Lichess").not.toHaveBeenCalled();
    // The positive pair: the room's 404 is card 7, and re-asks nothing.
    room.readRoom.mockRejectedValue(new HttpError(404, "This match room could not be found", "NOT_FOUND"));
    const gone = await MatchRoomPage({ params: Promise.resolve(PARAMS), searchParams: Promise.resolve({ t: "tok" }) });
    expect(find(walk(gone), RoomHeaderless)).toBeDefined();
    expect(renderToStaticMarkup(gone as ReactElement)).toContain(NL["externalPlay.room.state.unavailable.body"]);
    room.readRoom.mockRejectedValue(new HttpError(409, "conflict", "SOMETHING_ELSE"));
    await expect(render("tok")).rejects.toMatchObject({ status: 409, code: "SOMETHING_ELSE" });
  });

  it("P10: a grant Lichess says no longer plays opens the room on the re-link screen; an intact grant opens it on check-in", async () => {
    // A check-in snapshot (window open, no game), complete enough for the shell to paint.
    const full: RoomSnapshot = {
      fixtureId: "f1",
      serverNow: "2026-10-14T10:00:00.000Z",
      phase: "open",
      scheduledAt: null,
      roundOpenedAt: "2026-10-14T09:55:00.000Z",
      opensAt: "2026-10-14T09:55:00.000Z",
      deadline: "2026-10-14T10:15:00.000Z",
      links: SNAP.links,
      meta: { divisionName: "Open", roundNo: 1, boardNo: 1, limitSeconds: 600, incrementSeconds: 5 },
      orgSlug: "org",
      you: { colour: "white", name: "Ada", checkedIn: false },
      opponent: { colour: "black", name: "Bo", checkedIn: false },
      cameraPolicy: "off",
      opponentPresence: null,
      ownParticipantId: null,
      frozen: null,
      canAct: false,
      otherAccount: null,
      onlineChessOff: false,
      creation: null,
      game: null,
      held: false,
      result: null,
      watchUrl: null,
      realtime: null,
    };
    let checked = 0;
    for (const downgraded of [true, false]) {
      room.readRoom.mockReset().mockResolvedValue(full);
      room.roomGrantDowngraded.mockReset().mockResolvedValue(downgraded);
      const page = await MatchRoomPage({ params: Promise.resolve(PARAMS), searchParams: Promise.resolve({ t: "tok" }) });
      expect(room.roomGrantDowngraded.mock.calls, "asked once, with the page's own identity").toEqual([[{ kind: "token", token: "tok" }, "f1"]]);
      expect((find(walk(page), RoomShell)!.props as { grantRefused: boolean }).grantRefused).toBe(downgraded);
      const html = renderToStaticMarkup(page as ReactElement);
      expect(html.includes('data-testid="room-state-relink"'), `downgraded=${downgraded}: the re-link screen`).toBe(downgraded);
      expect(html.includes('data-testid="room-checkin"'), `downgraded=${downgraded}: check-in`).toBe(!downgraded);
      checked += 1;
    }
    expect(checked).toBe(2);
  });

  it("any OTHER failure is a real fault — it reaches the error boundary, never the friendly card", async () => {
    room.readRoom.mockRejectedValue(new Error("connection refused"));
    await expect(render("tok")).rejects.toThrow("connection refused");
    room.readRoom.mockRejectedValue(new HttpError(500, "boom"));
    await expect(render("tok")).rejects.toThrow("boom");
  });

  it("a repeated ?t= (an array) is no link at all — never the first or last of them", async () => {
    auth.getCurrentUser.mockResolvedValue(null);
    await render(["a", "b"]);
    expect(room.readRoom).not.toHaveBeenCalled();
  });

  it("stale slugs (a renamed competition) land on the canonical room, the personal link kept", async () => {
    room.readRoom.mockResolvedValue({ ...SNAP, links: { fixture: "/shared/org/new-comp/div/fixtures/f1", standings: "/x" } });
    await expect(render("tok")).rejects.toThrow("CALLED_REDIRECT:/shared/org/new-comp/div/fixtures/f1/play?t=tok");
    room.readRoom.mockResolvedValue(SNAP);
    await render("tok");
    expect(nav.redirect, "the canonical path never redirects").toHaveBeenCalledTimes(1);
  });
});
