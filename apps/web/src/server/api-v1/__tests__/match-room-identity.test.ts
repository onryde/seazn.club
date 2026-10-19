// Who is calling a match-room route. The personal link decides WHOSE SEAT it is; since the owner's staging test of
// 2026-10-19 the identity also carries WHO IS LOOKING when the browser is signed in (`viewer`), so the room can tell the
// seat's own account from another. These are the routes' polls: the same decision the page makes (play/page.tsx), through
// the same helper. The comparison itself is the usecase's (external-play-room-account.test.ts).
import { beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  requireUser: vi.fn(),
}));
vi.mock("@/lib/auth", () => auth);

import { matchRoomIdentity } from "../match-room-identity";

const req = (query = "") => new Request(`https://seazn.test/api/v1/fixtures/f1/external-play/room${query}`);
const USER = { id: "u-bob", email: "bob@example.test", display_name: "Bob" };

beforeEach(() => {
  auth.getCurrentUser.mockReset().mockResolvedValue(null);
  auth.requireUser.mockReset().mockResolvedValue(USER);
});

describe("matchRoomIdentity", () => {
  it("a link, signed out: the token alone", async () => {
    expect(await matchRoomIdentity(req("?t=tok"))).toEqual({ kind: "token", token: "tok" });
    expect(auth.requireUser, "a link never demands a session").not.toHaveBeenCalled();
  });

  it("a link, signed in: the token AND the viewer - id to compare, the viewer's OWN email to show - nothing else of the user", async () => {
    auth.getCurrentUser.mockResolvedValue(USER);
    const id = await matchRoomIdentity(req("?t=tok"));
    expect(id).toEqual({ kind: "token", token: "tok", viewer: { userId: "u-bob", email: "bob@example.test" } });
    expect(Object.keys((id as { viewer: object }).viewer).sort()).toEqual(["email", "userId"]);
  });

  it("a link, the session read failing: signed out, never a 500 on a player's poll (fail-open, the room as it was)", async () => {
    auth.getCurrentUser.mockRejectedValue(new Error("session store down"));
    expect(await matchRoomIdentity(req("?t=tok"))).toEqual({ kind: "token", token: "tok" });
  });

  it("no link: the session is the identity, as before - and a missing one is the auth error, not a quiet anonymous", async () => {
    expect(await matchRoomIdentity(req())).toEqual({ kind: "session", userId: "u-bob" });
    auth.requireUser.mockRejectedValue(new Error("Not authenticated"));
    await expect(matchRoomIdentity(req())).rejects.toThrow("Not authenticated");
  });

  it("the sequence: the same link asked signed out, then signed in, then signed out - each answer is its own, nothing sticks", async () => {
    const seen: unknown[] = [];
    for (const user of [null, USER, null]) {
      auth.getCurrentUser.mockResolvedValue(user);
      seen.push(await matchRoomIdentity(req("?t=tok")));
    }
    expect(seen).toEqual([
      { kind: "token", token: "tok" },
      { kind: "token", token: "tok", viewer: { userId: "u-bob", email: "bob@example.test" } },
      { kind: "token", token: "tok" },
    ]);
  });
});
