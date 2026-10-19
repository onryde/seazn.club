// Who is looking at a personal-link room (room-viewer.ts). Fail-open by design - a session read that throws is a signed-out
// viewer, never a 500 on a player's poll - but never SILENT (review m3, PR #986): a store that is down for every poll would
// otherwise turn every wrong-account card into the Lichess prompt with nothing in the logs. The line names no token and
// no address: the session read's own error text can carry either.
import { beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ getCurrentUser: vi.fn() }));
vi.mock("@/lib/auth", () => auth);
const logger = vi.hoisted(() => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@/server/logger", () => logger);

import { roomViewer } from "../external-play/room-viewer";

const USER = { id: "u-bob", email: "bob@example.test", display_name: "Bob" };
const TOKEN = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1LWJvYiJ9.c2lnbmF0dXJl";

beforeEach(() => {
  auth.getCurrentUser.mockReset();
  logger.log.warn.mockReset();
  logger.log.error.mockReset();
  logger.log.info.mockReset();
});

describe("roomViewer", () => {
  it("the empty case: nobody signed in is null, and says nothing", async () => {
    auth.getCurrentUser.mockResolvedValue(null);
    expect(await roomViewer()).toBeNull();
    expect(logger.log.warn).not.toHaveBeenCalled();
  });

  it("a signed-in user is the id and the viewer's OWN email, nothing else, and says nothing", async () => {
    auth.getCurrentUser.mockResolvedValue(USER);
    expect(await roomViewer()).toEqual({ userId: "u-bob", email: "bob@example.test" });
    expect(logger.log.warn).not.toHaveBeenCalled();
  });

  it("m3: a failing session read is a signed-out viewer AND a warn line - through the repo's logger, naming no token or address", async () => {
    // The error text is what could leak: a driver or a verifier that echoes the value it choked on.
    auth.getCurrentUser.mockRejectedValue(new Error(`jwt malformed: ${TOKEN} for ${USER.email}`));
    expect(await roomViewer()).toBeNull();
    expect(logger.log.warn, "exactly one warn").toHaveBeenCalledTimes(1);
    expect(logger.log.error).not.toHaveBeenCalled();
    const logged = JSON.stringify(logger.log.warn.mock.calls[0]);
    expect(logged, "the line is about the room's viewer").toMatch(/viewer/i);
    for (const secret of [TOKEN, USER.email, "bob@", "eyJ", "u-bob"]) {
      expect(logged, `no "${secret}" in the line`).not.toContain(secret);
    }
  });

  it("the sequence: a failure, then a good read, then a failure - each outcome its own, one line per failure", async () => {
    auth.getCurrentUser.mockRejectedValueOnce(new Error("down")).mockResolvedValueOnce(USER).mockRejectedValueOnce("not even an Error");
    expect(await roomViewer()).toBeNull();
    expect(await roomViewer()).toEqual({ userId: "u-bob", email: "bob@example.test" });
    expect(await roomViewer(), "a non-Error rejection is handled too").toBeNull();
    expect(logger.log.warn).toHaveBeenCalledTimes(2);
  });
});
