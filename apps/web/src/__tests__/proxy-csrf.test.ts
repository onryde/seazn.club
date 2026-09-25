// proxy.ts's CSRF Origin check on mutating /api/** calls. The scorer-sheet
// print is a POST that MINTS scoring links, and it sits under /api/v1 for
// exactly this check (scorer sheets P13): a third-party page must not be able
// to make a logged-in organiser's browser print — and so mint — links. No
// other suite drove this branch.
import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "@/proxy";

const PRINT = "/api/v1/competitions/c1/exports/scorer-sheets";
const post = (path: string, headers: Record<string, string>) =>
  new NextRequest(`http://localhost:3000${path}`, { method: "POST", headers: { host: "seazn.club", ...headers } });

describe("proxy: a mutating /api call from another origin is refused", () => {
  it("a scorer-sheet print from a foreign origin → 403, never reaching the route", async () => {
    const res = proxy(post(PRINT, { origin: "https://evil.example" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ok: false, error: "Forbidden" });
  });

  it("an unparseable Origin → 403", () => {
    expect(proxy(post(PRINT, { origin: "not a url" })).status).toBe(403);
  });

  it("the app's own origin passes through to the route", () => {
    const res = proxy(post(PRINT, { origin: "https://seazn.club" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });

  it("a GET is never Origin-checked (a safe method)", () => {
    const res = proxy(new NextRequest(`http://localhost:3000${PRINT}`, { headers: { host: "seazn.club", origin: "https://evil.example" } }));
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });
});
