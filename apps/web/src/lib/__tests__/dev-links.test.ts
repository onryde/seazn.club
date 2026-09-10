// The rule that decides whether a sign-in link may cross the wire instead of
// only being emailed. Its whole point is the case that used to be wrong:
// production plus a FAILED send used to expose the link, and must not.
import { afterEach, describe, expect, it, vi } from "vitest";
import { mayExposeDevLink } from "../dev-links";

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const ORIGINAL_FLAG = process.env.AUTH_DEV_LINKS;

function setEnv(nodeEnv: string | undefined, flag: string | undefined): void {
  vi.stubEnv("NODE_ENV", nodeEnv ?? "");
  if (flag === undefined) delete process.env.AUTH_DEV_LINKS;
  else process.env.AUTH_DEV_LINKS = flag;
}

afterEach(() => {
  vi.unstubAllEnvs();
  if (ORIGINAL_FLAG === undefined) delete process.env.AUTH_DEV_LINKS;
  else process.env.AUTH_DEV_LINKS = ORIGINAL_FLAG;
  vi.stubEnv("NODE_ENV", ORIGINAL_NODE_ENV ?? "test");
  vi.unstubAllEnvs();
});

describe("mayExposeDevLink", () => {
  it("does NOT expose in production without the flag", () => {
    // The defect this replaces: production plus a failed send exposed a live
    // sign-in link for whatever address was posted. Delivery success is not an
    // input here at all any more, which is the fix — the old rule read
    // `!sent`, so a Resend outage opened the door.
    setEnv("production", undefined);
    expect(mayExposeDevLink()).toBe(false);
  });

  it("exposes in production ONLY when the flag is exactly \"1\"", () => {
    setEnv("production", "1");
    expect(mayExposeDevLink()).toBe(true);
  });

  it("treats \"0\" and \"false\" as OFF, not as a truthy string", () => {
    // A flag that cannot be turned off by writing the obvious thing is a flag
    // that gets left on. Both of these are truthy in JavaScript.
    setEnv("production", "0");
    expect(mayExposeDevLink()).toBe(false);
    setEnv("production", "false");
    expect(mayExposeDevLink()).toBe(false);
  });

  it("exposes in development with no configuration at all", () => {
    // Dev sign-in without an email inbox is the capability being preserved;
    // nobody should have to set anything to get it back.
    setEnv("development", undefined);
    expect(mayExposeDevLink()).toBe(true);
  });

  it("exposes under NODE_ENV=test, so unit and integration harnesses keep working", () => {
    setEnv("test", undefined);
    expect(mayExposeDevLink()).toBe(true);
  });

  it("does not expose in production even when the flag is set to something else", () => {
    setEnv("production", "yes");
    expect(mayExposeDevLink()).toBe(false);
  });
});
