// The org-path hrefs for Streaming and Directory (owner, 2026-11-18).
import { describe, expect, it } from "vitest";
import { orgSlugFromPath } from "@/lib/org-scope";
import { routes } from "@/lib/routes";
import { streamingHref, youtubeLanding } from "@/lib/youtube";

describe("orgSlugFromPath", () => {
  it("reads the slug from any /o/{slug}/... path", () => {
    expect(orgSlugFromPath("/o/riverside")).toBe("riverside");
    expect(orgSlugFromPath("/o/riverside/c/spring/match-day")).toBe("riverside");
  });
  it("is null off an org path, empty or missing", () => {
    for (const p of ["/streaming", "/directory", "/", "", null, undefined, "/orgs/new", "/other/o/x"]) expect(orgSlugFromPath(p), String(p)).toBeNull();
  });
});

describe("hrefs", () => {
  it("builds the org's pages", () => {
    expect(routes.orgStreaming("riverside")).toBe("/o/riverside/streaming");
    expect(routes.orgDirectory("riverside", "venues")).toBe("/o/riverside/directory?tab=venues");
    expect(routes.orgDirectory("riverside")).toBe("/o/riverside/directory");
  });
  it("streamingHref falls back to the legacy path only when no org is known", () => {
    expect(streamingHref("riverside")).toBe("/o/riverside/streaming");
    expect(streamingHref(null)).toBe("/streaming");
    expect(streamingHref("riverside", "?disconnected=1")).toBe("/o/riverside/streaming?disconnected=1");
  });
  it("the connect landing returns to the org that started it", () => {
    expect(youtubeLanding("pick", "p-1", "riverside")).toBe("/o/riverside/streaming?youtube=pick&pending=p-1");
    expect(youtubeLanding("expired")).toBe("/streaming?youtube=expired");
  });
});
