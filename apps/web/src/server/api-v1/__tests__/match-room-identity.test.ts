// Who is calling a match-room route. The personal link decides WHOSE SEAT it is; since the owner's staging test of
// 2026-10-19 the identity also carries WHO IS LOOKING when the browser is signed in (`viewer`), so the room can tell the
// seat's own account from another. These are the routes' polls: the same decision the page makes (play/page.tsx), through
// the same helper. The comparison itself is the usecase's (external-play-room-account.test.ts).
//
// The viewer is read ONLY where a snapshot is built - GET and POST room (review m1, PR #986): act, camera, camera-report,
// camera-fault and clock-zero answer no snapshot, so they never pay the session lookup.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

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
    expect(await matchRoomIdentity(req("?t=tok"), { viewer: true })).toEqual({ kind: "token", token: "tok" });
    expect(auth.requireUser, "a link never demands a session").not.toHaveBeenCalled();
  });

  it("a link, signed in: the token AND the viewer - id to compare, the viewer's OWN email to show - nothing else of the user", async () => {
    auth.getCurrentUser.mockResolvedValue(USER);
    const id = await matchRoomIdentity(req("?t=tok"), { viewer: true });
    expect(id).toEqual({ kind: "token", token: "tok", viewer: { userId: "u-bob", email: "bob@example.test" } });
    expect(Object.keys((id as { viewer: object }).viewer).sort()).toEqual(["email", "userId"]);
  });

  it("a link, the session read failing: signed out, never a 500 on a player's poll (fail-open, the room as it was)", async () => {
    auth.getCurrentUser.mockRejectedValue(new Error("session store down"));
    expect(await matchRoomIdentity(req("?t=tok"), { viewer: true })).toEqual({ kind: "token", token: "tok" });
  });

  it("m1: a route that builds no snapshot asks for no viewer - the session is not read at all, signed in or not (the positive: asked, it is)", async () => {
    auth.getCurrentUser.mockResolvedValue(USER);
    expect(await matchRoomIdentity(req("?t=tok"))).toEqual({ kind: "token", token: "tok" });
    expect(await matchRoomIdentity(req("?t=tok"), { viewer: false })).toEqual({ kind: "token", token: "tok" });
    expect(auth.getCurrentUser, "never looked").not.toHaveBeenCalled();
    expect(await matchRoomIdentity(req("?t=tok"), { viewer: true })).toMatchObject({ viewer: { userId: "u-bob" } });
    expect(auth.getCurrentUser).toHaveBeenCalledTimes(1);
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
      seen.push(await matchRoomIdentity(req("?t=tok"), { viewer: true }));
    }
    expect(seen).toEqual([
      { kind: "token", token: "tok" },
      { kind: "token", token: "tok", viewer: { userId: "u-bob", email: "bob@example.test" } },
      { kind: "token", token: "tok" },
    ]);
  });
});

// The seam, read where it is used: which route files ask for the viewer. Only the two that BUILD a snapshot (GET and POST
// room) may; a sixth route copying the call with the option, or one of these five gaining it, is a lookup on every poll.
describe("m1: who asks for the viewer", () => {
  const ROOT = join(process.cwd(), "src/app/api/v1/fixtures/[id]/external-play/room");
  const routes = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? routes(join(dir, e.name)) : e.name === "route.ts" ? [join(dir, e.name)] : []));

  it("exactly GET and POST in room/route.ts pass { viewer: true }; every other match-room route calls it bare", () => {
    const files = routes(ROOT);
    const askers: Record<string, number> = {};
    const bare: Record<string, number> = {};
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      const rel = f.slice(ROOT.length + 1);
      const withViewer = (src.match(/matchRoomIdentity\(req,\s*\{\s*viewer:\s*true\s*\}\)/g) ?? []).length;
      const all = (src.match(/matchRoomIdentity\(/g) ?? []).length;
      if (withViewer > 0) askers[rel] = withViewer;
      if (all - withViewer > 0) bare[rel] = all - withViewer;
    }
    expect(Object.keys({ ...askers, ...bare }).length, "anti-vacuity: every route that resolves an identity was scanned").toBeGreaterThanOrEqual(6);
    expect(askers).toEqual({ "route.ts": 2 });
    expect(Object.keys(bare).sort(), "the five that build no snapshot").toEqual(
      ["act/route.ts", "camera-fault/route.ts", "camera-report/route.ts", "camera/route.ts", "clock-zero/route.ts"],
    );
  });
});
