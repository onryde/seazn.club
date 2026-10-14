// Final review P10: the match room page asks Lichess ONCE, as it loads, whether the player's grant still plays, and
// hands the answer to the room, which shows the re-link screen at once. This drives the REAL page with its two
// usecases doubled at their boundary, finds the RoomShell it renders and reads the prop — then paints that very
// element, so the seam is proven through its consumer too (the relink card on the markup), not a fixture of it.
import { describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const stub = vi.hoisted(() => ({
  readRoom: vi.fn(),
  roomGrantDowngraded: vi.fn(),
  user: null as { id: string } | null,
}));
vi.mock("@/server/usecases/external-play/room", () => ({ readRoom: stub.readRoom, roomGrantDowngraded: stub.roomGrantDowngraded }));
vi.mock("@/lib/auth", () => ({ getCurrentUser: async () => stub.user }));
vi.mock("@/server/public-site/org-guard", () => ({ publicOrgOrNull: async () => ({ org: { default_locale: "en" }, competitions: [] }) }));

import MatchRoomPage from "../(kiosk)/[orgSlug]/[competitionSlug]/[divisionSlug]/fixtures/[fixtureId]/play/page";
import { RoomShell } from "@/components/public-site/match-room/room-shell";
import { HttpError } from "@/lib/errors";
import type { RoomSnapshot } from "@/components/public-site/match-room/room-snapshot";

const PARAMS = { orgSlug: "org", competitionSlug: "comp", divisionSlug: "div", fixtureId: "f1" };

/** A check-in snapshot: the window open, no game. */
const SNAP: RoomSnapshot = {
  fixtureId: "f1",
  serverNow: "2026-10-14T10:00:00.000Z",
  phase: "open",
  scheduledAt: null,
  roundOpenedAt: "2026-10-14T09:55:00.000Z",
  opensAt: "2026-10-14T09:55:00.000Z",
  deadline: "2026-10-14T10:15:00.000Z",
  links: { fixture: "/shared/org/comp/div/fixtures/f1", standings: "/shared/org/comp/div" },
  meta: { divisionName: "Open", roundNo: 1, boardNo: 1, limitSeconds: 600, incrementSeconds: 5 },
  orgSlug: "org",
  you: { colour: "white", name: "Ada", checkedIn: false },
  opponent: { colour: "black", name: "Bo", checkedIn: false },
  cameraPolicy: "off",
  opponentPresence: null,
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

/** Every element in a server component's returned tree, depth first (props.children followed). */
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
  const page = await MatchRoomPage({ params: Promise.resolve(PARAMS), searchParams: Promise.resolve(t === null ? {} : { t }) });
  const shells = elements(page).filter((e) => e.type === RoomShell);
  expect(shells, "the page renders one room").toHaveLength(1);
  return { page, shell: shells[0]! as ReactElement<{ grantRefused?: boolean }> };
}

describe("match room page — Lichess's word on the grant, once per load (P10)", () => {
  it("asks once with the page's identity, hands the answer to the room, and the room shows the re-link card on it", async () => {
    let checked = 0;
    for (const [identity, t] of [
      [{ kind: "token", token: "tok-1" }, "tok-1"],
      [{ kind: "session", userId: "u-1" }, null],
    ] as const) {
      stub.user = t === null ? { id: "u-1" } : null;
      for (const answer of [true, false]) {
        stub.readRoom.mockReset().mockResolvedValue(SNAP);
        stub.roomGrantDowngraded.mockReset().mockResolvedValue(answer);
        const { page, shell } = await load(t);
        expect(stub.roomGrantDowngraded.mock.calls, `${identity.kind}`).toEqual([[identity, "f1"]]);
        expect(shell.props.grantRefused, `${identity.kind} ${answer}`).toBe(answer);
        // The consumer: the same element, painted.
        const html = renderToStaticMarkup(page as ReactElement);
        expect(html.includes('data-testid="room-state-relink"'), `${identity.kind} ${answer}: the re-link card`).toBe(answer);
        expect(html.includes('data-testid="room-checkin"'), `${identity.kind} ${answer}: the check-in`).toBe(!answer);
        checked += 1;
      }
    }
    expect(checked).toBe(4);
  });

  it("a room that is not the viewer's (404) asks Lichess nothing", async () => {
    stub.user = null;
    stub.readRoom.mockReset().mockRejectedValue(new HttpError(404, "no", "NOT_FOUND"));
    stub.roomGrantDowngraded.mockReset().mockResolvedValue(true);
    const page = await MatchRoomPage({ params: Promise.resolve(PARAMS), searchParams: Promise.resolve({ t: "tok-x" }) });
    expect(elements(page).some((e) => e.type === RoomShell)).toBe(false);
    expect(stub.roomGrantDowngraded).not.toHaveBeenCalled();
  });
});
