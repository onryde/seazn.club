import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "@/proxy";

const get = (path: string, host: string) => proxy(new NextRequest(`http://localhost:3000${path}`, { headers: { host } }));

describe("staging noindex header", () => {
  // Marketing rewrite, an app page and an API call: every return path of the proxy.
  it.each(["/", "/pricing", "/dashboard", "/api/v1/ping"])("stg.seazn.club %s is served noindex", (path) => {
    expect(get(path, "stg.seazn.club").headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });

  it.each(["/", "/pricing", "/dashboard"])("seazn.club %s is NOT noindexed (positive pair)", (path) => {
    expect(get(path, "seazn.club").headers.get("x-robots-tag")).toBeNull();
  });
});
