// safeNextPath decides where a freshly-authenticated user is sent. It had no
// test anywhere in the repo, and it was an open redirect: `startsWith("/") &&
// !startsWith("//")` reads a backslash as an ordinary character, while the URL
// parser normalises it to a slash in the authority position. `/\evil.com`
// therefore passed and resolved to `https://evil.com/`.
//
// Every rejection case below asserts the HAZARD as well as the verdict — what
// the string actually resolves to — so the file proves the trap is real rather
// than asserting a fix against a danger that may have stopped existing.
import { describe, expect, it } from "vitest";
import { safeNextPath } from "@/lib/auth";

const ORIGIN = "https://seazn.club";
const resolves = (p: string) => new URL(p, ORIGIN).origin;

describe("safeNextPath", () => {
  it("accepts ordinary internal paths, with query and fragment", () => {
    for (const ok of [
      "/dashboard",
      "/settings?tab=account&email_change=taken",
      "/o/my-org/c/spring/d/a1?tab=fixtures",
      "/join/abc123",
      "/",
    ]) {
      expect(resolves(ok), `${ok} is same-origin`).toBe(ORIGIN);
      expect(safeNextPath(ok), ok).toBe(ok);
    }
  });

  it("rejects a backslash authority — the open redirect this test exists for", () => {
    for (const evil of ["/\\evil.com", "/\\/evil.com", "/\\\\evil.com"]) {
      // The hazard, proven rather than asserted: these leave the origin.
      expect(resolves(evil), `${evil} escapes the origin`).not.toBe(ORIGIN);
      expect(
        safeNextPath(evil),
        `${evil} resolves to ${new URL(evil, ORIGIN).href} — it must never be a redirect target`,
      ).toBeNull();
    }
  });

  it("rejects protocol-relative and absolute URLs", () => {
    for (const evil of ["//evil.com", "//evil.com/path", "https://evil.com", "http://evil.com"]) {
      expect(safeNextPath(evil), evil).toBeNull();
    }
    // A same-origin ABSOLUTE url is still rejected: the contract is a path.
    expect(safeNextPath(`${ORIGIN}/dashboard`)).toBeNull();
  });

  it("rejects control characters, CR/LF included", () => {
    const cr = "/" + String.fromCharCode(13) + String.fromCharCode(10) + "X";
    for (const evil of [cr, "/x" + String.fromCharCode(0), "/x" + String.fromCharCode(9)]) {
      expect(safeNextPath(evil), JSON.stringify(evil)).toBeNull();
    }
  });

  it("rejects anything that is not a string, and relative paths", () => {
    for (const bad of [undefined, null, 42, {}, [], "dashboard", "../admin", ""]) {
      expect(safeNextPath(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});
