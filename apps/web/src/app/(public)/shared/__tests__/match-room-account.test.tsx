// Owner staging test 2026-10-19: the match room page tells the room WHO IS LOOKING. A personal link works for whoever holds
// it, so the page reads the session beside the token and hands both to the room read (`viewer`); the server compares the
// viewer with the seat (external-play-room-account.test.ts) and the room paints the answer (room-account-cards.test.tsx).
// This drives the REAL page with its usecases doubled at the boundary, to prove the join between them:
//   - what identity the page asks with, for each of the four people who can open a link;
//   - the 409 "this seat has no Seazn account" becomes its calm card, headerless, with nothing else asked;
//   - the snapshot's `account` reaches the painted room - the prompt the owner saw is replaced, the rest is not.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const stub = vi.hoisted(() => ({
  readRoom: vi.fn(),
  roomGrantDowngraded: vi.fn(),
  user: null as { id: string; email: string } | null,
  userThrows: false,
}));
vi.mock("@/server/usecases/external-play/room", () => ({ readRoom: stub.readRoom, roomGrantDowngraded: stub.roomGrantDowngraded }));
vi.mock("@/lib/auth", () => ({
  getCurrentUser: async () => {
    if (stub.userThrows) throw new Error("session store down");
    return stub.user;
  },
}));
// The re-pair card refreshes the page by itself (RepairingRefresh), which needs a router; the rest of the module is real.
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("@/server/public-site/org-guard", () => ({ publicOrgOrNull: async () => ({ org: { default_locale: "en" }, competitions: [] }) }));

import MatchRoomPage from "../(kiosk)/[orgSlug]/[competitionSlug]/[divisionSlug]/fixtures/[fixtureId]/play/page";
import { RoomShell } from "@/components/public-site/match-room/room-shell";
import { HttpError } from "@/lib/errors";
import { ROOM_BEING_REPAIRED, ROOM_SEAT_NO_ACCOUNT, type RoomSnapshot } from "@/components/public-site/match-room/room-snapshot";

const PARAMS = { orgSlug: "org", competitionSlug: "comp", divisionSlug: "div", fixtureId: "f1" };
const FIXTURE = "/shared/org/comp/div/fixtures/f1";
const VIEWER = { id: "u-bob", email: "bob@example.test" };

const SNAP: RoomSnapshot = {
  fixtureId: "f1",
  serverNow: "2026-10-14T10:00:00.000Z",
  phase: "open",
  scheduledAt: null,
  roundOpenedAt: "2026-10-14T09:55:00.000Z",
  opensAt: "2026-10-14T09:55:00.000Z",
  deadline: "2026-10-14T10:15:00.000Z",
  links: { fixture: FIXTURE, standings: "/shared/org/comp/div" },
  meta: { divisionName: "Open", roundNo: 1, boardNo: 1, limitSeconds: 600, incrementSeconds: 5 },
  orgSlug: "org",
  you: { colour: "white", name: "Ada Okonkwo", checkedIn: false },
  opponent: { colour: "black", name: "Bo Lind", checkedIn: false },
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
const WRONG_SNAP: RoomSnapshot = { ...SNAP, account: { state: "wrong_account", viewerEmail: VIEWER.email } };

function elements(node: ReactNode, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) {
    for (const n of node) elements(n, out);
  } else if (isValidElement(node)) {
    out.push(node);
    elements((node.props as { children?: ReactNode }).children, out);
  }
  return out;
}
async function load(t: string | null) {
  return MatchRoomPage({ params: Promise.resolve(PARAMS), searchParams: Promise.resolve(t === null ? {} : { t }) });
}
const ids = (html: string) => [...html.matchAll(/data-testid="([^"]+)"/g)].map((m) => m[1]!);

beforeEach(() => {
  stub.user = null;
  stub.userThrows = false;
  stub.readRoom.mockReset().mockResolvedValue(SNAP);
  stub.roomGrantDowngraded.mockReset().mockResolvedValue(false);
});

describe("match room page - who is looking goes with the link", () => {
  it("the four people who can open it: a link signed out, a link signed in (the viewer rides along), a session; a session read that fails is signed out", async () => {
    const cases: { why: string; t: string | null; user: typeof stub.user; throws?: boolean; want: unknown }[] = [
      { why: "a link, signed out", t: "tok-1", user: null, want: { kind: "token", token: "tok-1" } },
      {
        why: "a link, signed in as someone",
        t: "tok-1",
        user: VIEWER,
        want: { kind: "token", token: "tok-1", viewer: { userId: VIEWER.id, email: VIEWER.email } },
      },
      { why: "a link, the session store down (fail-open: the room as it was)", t: "tok-1", user: VIEWER, throws: true, want: { kind: "token", token: "tok-1" } },
      { why: "no link, a session", t: null, user: VIEWER, want: { kind: "session", userId: VIEWER.id } },
    ];
    let checked = 0;
    for (const c of cases) {
      stub.user = c.user;
      stub.userThrows = c.throws === true;
      stub.readRoom.mockClear();
      await load(c.t);
      expect(stub.readRoom.mock.calls.map((a) => a[0]), c.why).toEqual([c.want]);
      checked += 1;
    }
    expect(checked).toBe(4);
  });

  it("no link and no session asks nothing and shows the room's one 'not available' card", async () => {
    const page = await load(null);
    expect(stub.readRoom).not.toHaveBeenCalled();
    expect(ids(renderToStaticMarkup(page as ReactElement))).toContain("room-state-unavailable");
  });
});

describe("match room page - a seat tied to no Seazn account (409 ROOM_SEAT_NO_ACCOUNT)", () => {
  it("is its own calm card - headerless, no room, and Lichess is never asked about a grant that does not exist", async () => {
    stub.user = VIEWER;
    stub.readRoom.mockRejectedValue(new HttpError(409, "no account", ROOM_SEAT_NO_ACCOUNT));
    const page = await load("tok-1");
    expect(elements(page).some((e) => e.type === RoomShell), "no room to run").toBe(false);
    expect(stub.roomGrantDowngraded).not.toHaveBeenCalled();
    const html = renderToStaticMarkup(page as ReactElement);
    expect(ids(html)).toEqual(expect.arrayContaining(["match-room", "room-state-no-account", "room-back-to-fixture"]));
    expect(html).toContain(`href="${FIXTURE}"`);
    for (const id of ["room-state-unavailable", "room-state-relink", "room-relink", "room-switch-account"]) expect(ids(html), id).not.toContain(id);
    expect(html).not.toContain("/api/auth/lichess");
  });

  it("only that exact 409: the re-pair 409 stays the re-pair card, a plain 404 stays 'not available', anything else is a real fault", async () => {
    stub.readRoom.mockRejectedValueOnce(new HttpError(409, "repair", ROOM_BEING_REPAIRED));
    expect(ids(renderToStaticMarkup((await load("tok-1")) as ReactElement))).toContain("room-state-repairing");
    stub.readRoom.mockRejectedValueOnce(new HttpError(404, "no", "NOT_FOUND"));
    expect(ids(renderToStaticMarkup((await load("tok-1")) as ReactElement))).toContain("room-state-unavailable");
    stub.readRoom.mockRejectedValueOnce(new HttpError(409, "other", "SOMETHING_ELSE"));
    await expect(load("tok-1")).rejects.toMatchObject({ code: "SOMETHING_ELSE" });
  });
});

describe("match room page - the snapshot's account reaches the painted room", () => {
  it("the Lichess prompt the owner saw is replaced for a mismatched viewer - and kept for everyone else (the pair)", async () => {
    stub.roomGrantDowngraded.mockResolvedValue(true); // the page's own word that the grant needs re-linking: card 8
    let checked = 0;
    for (const [why, snap, want, gone] of [
      ["another account", WRONG_SNAP, "room-state-wrong-account", "room-state-relink"],
      ["the seat's own account (or signed out)", SNAP, "room-state-relink", "room-state-wrong-account"],
    ] as const) {
      stub.readRoom.mockResolvedValue(snap);
      stub.user = snap === WRONG_SNAP ? VIEWER : null;
      const html = renderToStaticMarkup((await load("tok-1")) as ReactElement);
      expect(ids(html), `${why}: ${want}`).toContain(want);
      expect(ids(html), `${why}: no ${gone}`).not.toContain(gone);
      checked += 1;
    }
    expect(checked).toBe(2);
  });

  it("the room is otherwise the same for a mismatched viewer: the check-in shows when nothing asked for a link", async () => {
    stub.readRoom.mockResolvedValue(WRONG_SNAP);
    stub.user = VIEWER;
    const html = renderToStaticMarkup((await load("tok-1")) as ReactElement);
    expect(ids(html)).toContain("room-checkin");
    expect(ids(html)).not.toContain("room-state-wrong-account");
  });

  it("Switch account signs back in to this very page - path AND the personal link", async () => {
    stub.readRoom.mockResolvedValue(WRONG_SNAP);
    stub.roomGrantDowngraded.mockResolvedValue(true);
    stub.user = VIEWER;
    const page = await load("tok+/=1");
    const shells = elements(page).filter((e) => e.type === RoomShell) as ReactElement<{ selfPath: string }>[];
    expect(shells).toHaveLength(1);
    expect(shells[0]!.props.selfPath).toBe(`${FIXTURE}/play?t=${encodeURIComponent("tok+/=1")}`);
  });
});
