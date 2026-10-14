import { describe, expect, it } from "vitest";
import {
  LICHESS_OAUTH_NEXT_COOKIE,
  LICHESS_OAUTH_STATE_COOKIE,
  OAUTH_STATE_COOKIE,
} from "@/lib/oauth";

describe("Lichess OAuth cookies", () => {
  it("uses dedicated cookies so Google login cannot steal Lichess state", () => {
    expect(LICHESS_OAUTH_STATE_COOKIE).not.toBe(OAUTH_STATE_COOKIE);
    expect(LICHESS_OAUTH_NEXT_COOKIE).not.toBe("seazn_oauth_next");
    expect(LICHESS_OAUTH_STATE_COOKIE).toBe("seazn_lichess_oauth_state");
    expect(LICHESS_OAUTH_NEXT_COOKIE).toBe("seazn_lichess_oauth_next");
  });
});
