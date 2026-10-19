// T16 fix round 1, R2 — the proxy keeps the readable signed-in hint in step with the HttpOnly session for sessions
// minted before the hint existed (or a hint left behind by an expired session) — but ONLY on pages that are not ISR/CDN
// cacheable: a Set-Cookie on /shared or /embed would ride a cached, shared response. The hint carries no authority.
import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "@/proxy";
import { SESSION_HINT_COOKIE } from "@/lib/session-hint";

const page = (path: string, cookie: string) =>
  proxy(new NextRequest(`http://localhost:3000${path}`, { headers: { host: "seazn.club", ...(cookie ? { cookie } : {}) } }));
const hintSet = (res: Response) => res.headers.getSetCookie().filter((c) => c.startsWith(`${SESSION_HINT_COOKIE}=`));

describe("proxy: the signed-in hint", () => {
  it("the empty case first: no session, no hint — nothing is set anywhere", () => {
    for (const path of ["/me", "/o/club", "/shared/club/cup"]) expect(hintSet(page(path, "")), path).toEqual([]);
  });

  it("a session with no hint, on an app page: the hint is set — readable, '1', site-wide", () => {
    const [c, ...more] = hintSet(page("/me", "seazn_session=tok"));
    expect(more).toEqual([]);
    expect(c).toMatch(new RegExp(`^${SESSION_HINT_COOKIE}=1;`));
    expect(c).toMatch(/Path=\//);
    expect(c).not.toMatch(/HttpOnly/i);
  });

  it("a hint with no session, on an app page: the hint is cleared", () => {
    const [c] = hintSet(page("/o/club", `${SESSION_HINT_COOKIE}=1`));
    expect(c).toMatch(new RegExp(`^${SESSION_HINT_COOKIE}=;`));
  });

  it("already in step (both, or neither): nothing set", () => {
    expect(hintSet(page("/me", `seazn_session=tok; ${SESSION_HINT_COOKIE}=1`))).toEqual([]);
  });

  it("a cacheable public page NEVER carries a Set-Cookie for it, whatever the cookies say", () => {
    let checked = 0;
    for (const path of ["/shared/club/cup/open/fixtures/f1", "/embed/club/cup"]) {
      for (const cookie of ["seazn_session=tok", `${SESSION_HINT_COOKIE}=1`]) {
        expect(page(path, cookie).headers.getSetCookie(), `${path} ${cookie}`).toEqual([]);
        checked += 1;
      }
    }
    expect(checked).toBe(4);
  });
});
