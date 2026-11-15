import { afterEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "@/proxy";

const get = (path: string, headers: Record<string, string> = { host: "seazn.club" }) =>
  proxy(new NextRequest(`http://localhost:3000${path}`, { headers }));
const PATHS = ["/", "/pricing", "/dashboard", "/api/v1/ping"];

const prev = process.env.OAUTH_BASE_URL;
afterEach(() => {
  if (prev === undefined) delete process.env.OAUTH_BASE_URL;
  else process.env.OAUTH_BASE_URL = prev;
});

describe("staging noindex header (decided by the configured origin)", () => {
  it.each(PATHS)("a staging origin serves %s noindex", (path) => {
    process.env.OAUTH_BASE_URL = "https://stg.seazn.club";
    expect(get(path).headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });

  it.each(PATHS)("production origin %s is NOT noindexed (positive pair)", (path) => {
    process.env.OAUTH_BASE_URL = "https://seazn.club";
    expect(get(path).headers.get("x-robots-tag")).toBeNull();
  });

  it("a forged x-forwarded-host / host naming staging cannot noindex a production response", () => {
    process.env.OAUTH_BASE_URL = "https://seazn.club";
    for (const path of PATHS) {
      expect(get(path, { host: "stg.seazn.club", "x-forwarded-host": "stg.seazn.club" }).headers.get("x-robots-tag"), path).toBeNull();
    }
  });
});
