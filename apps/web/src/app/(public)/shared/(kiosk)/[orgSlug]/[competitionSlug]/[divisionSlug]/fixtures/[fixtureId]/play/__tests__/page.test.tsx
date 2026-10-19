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
import { LICHESS_FLASH_CODES } from "@/lib/lichess-link";

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
async function render(t?: string | string[], params = PARAMS, lichess?: string | string[]) {
  const searchParams = { ...(t === undefined ? {} : { t }), ...(lichess === undefined ? {} : { lichess }) };
  const el = await MatchRoomPage({ params: Promise.resolve(params), searchParams: Promise.resolve(searchParams) });
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

  it("a ?t= link reads THAT player's room — a session never decides whose seat it is — and the shell gets the snapshot, the token and its own path", async () => {
    room.readRoom.mockResolvedValue(SNAP);
    // Signed out: the session is looked at ONLY to learn who is looking (the wrong-account card, 2026-10-19) - nobody here.
    const els = await render("tok.en/1");
    expect(room.readRoom).toHaveBeenCalledWith({ kind: "token", token: "tok.en/1" }, "f1");
    expect(auth.getCurrentUser, "asked once, for the viewer").toHaveBeenCalledTimes(1);
    const shell = find(els, RoomShell)!;
    expect(shell.props).toEqual({ initial: SNAP, token: "tok.en/1", selfPath: "/shared/org/comp/div/fixtures/f1/play?t=tok.en%2F1", grantRefused: false });
    expect((find(els, DictProvider)!.props as { locale: string }).locale, "the org's language").toBe("nl");

    // Signed in as SOMEONE ELSE: the link still names the seat - the other account is only the viewer riding along, and
    // the room is the same (the token, the path), so nothing about the seat moved to the session.
    room.readRoom.mockClear();
    auth.getCurrentUser.mockResolvedValue({ id: "u-other", email: "other@example.test" });
    const signedIn = await render("tok.en/1");
    expect(room.readRoom).toHaveBeenCalledWith(
      { kind: "token", token: "tok.en/1", viewer: { userId: "u-other", email: "other@example.test" } },
      "f1",
    );
    expect(find(signedIn, RoomShell)!.props).toEqual(shell.props);
  });

  // Owner staging test 2026-10-19: the Lichess link's callback lands on `…/play?t=…&lichess=<code>` and the room never
  // read the outcome. The page reads it the way /me and settings do - through the shared narrowing - and hands the shell
  // the code; the personal link the shell re-links with (selfPath) never carries it.
  it("?lichess=<code> is read through the shared narrowing and handed to the shell; selfPath stays the personal link alone", async () => {
    room.readRoom.mockResolvedValue(SNAP);
    let checked = 0;
    for (const code of LICHESS_FLASH_CODES) {
      const shell = find(await render("tok", PARAMS, code), RoomShell)!;
      expect((shell.props as { lichessFlash?: unknown }).lichessFlash, code).toBe(code);
      expect((shell.props as { selfPath: string }).selfPath, `${code}: no stale outcome in the re-link's way back`).toBe("/shared/org/comp/div/fixtures/f1/play?t=tok");
      checked++;
    }
    expect(checked, "anti-vacuity: every code the flow reports").toBe(LICHESS_FLASH_CODES.length);
  });

  // Owner requirement (2026-10-19): the already_linked message shows neither the Lichess username nor anything of the other
  // Seazn account. The page takes the CODE from the address and nothing else of the outcome: any other parameter a link
  // might carry (a name, an email, an id) is not read, so it cannot reach the shell.
  it("only the code reaches the shell: a username, email or id riding the address is not forwarded", async () => {
    room.readRoom.mockResolvedValue(SNAP);
    const el = await MatchRoomPage({
      params: Promise.resolve(PARAMS),
      searchParams: Promise.resolve({
        t: "tok",
        lichess: "already_linked",
        username: "ada_plays",
        lichess_username: "ada_plays",
        email: "mallory@other.example",
        other_account: "u-other-9",
      } as never),
    });
    const shell = find(walk(el), RoomShell)!;
    expect(Object.keys(shell.props as object).sort()).toEqual(["grantRefused", "initial", "lichessFlash", "selfPath", "token"]);
    expect((shell.props as { lichessFlash: unknown }).lichessFlash).toBe("already_linked");
    expect(JSON.stringify(shell.props)).not.toMatch(/ada_plays|mallory|u-other-9/i);
  });

  it("the empty case: no ?lichess=, a hand-typed one, or a repeated one is no outcome (the shell is handed none)", async () => {
    room.readRoom.mockResolvedValue(SNAP);
    let checked = 0;
    for (const v of [undefined, "", "Linked", "already_linked ", "<script>", ["already_linked", "linked"]]) {
      const shell = find(await render("tok", PARAMS, v), RoomShell)!;
      expect((shell.props as { lichessFlash?: unknown }).lichessFlash ?? null, JSON.stringify(v)).toBeNull();
      checked++;
    }
    expect(checked).toBe(6);
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
      opponentCamera: null,
      ownParticipantId: null,
      frozen: null,
      canAct: false,
      otherAccount: null,
      account: { state: "ok" },
      onlineChessOff: false,
      boardClosed: false,
      creation: null,
      game: null,
      held: false,
      result: null,
      watchUrl: null,
      heldUntil: null,
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
