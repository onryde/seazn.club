import { afterEach, describe, expect, it, vi } from "vitest";
import { siteOrigin } from "@/lib/site-origin";

describe("siteOrigin", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("prefers OAUTH_BASE_URL and strips a trailing slash", () => {
    vi.stubEnv("OAUTH_BASE_URL", "https://stg.seazn.club/");
    vi.stubEnv("NEXT_PUBLIC_BASE_URL", "https://other.example");
    expect(siteOrigin()).toBe("https://stg.seazn.club");
  });

  it("falls back to NEXT_PUBLIC_BASE_URL", () => {
    vi.stubEnv("OAUTH_BASE_URL", "");
    vi.stubEnv("NEXT_PUBLIC_BASE_URL", "https://stg.seazn.club");
    expect(siteOrigin()).toBe("https://stg.seazn.club");
  });

  it("defaults to the production domain when nothing is set", () => {
    vi.stubEnv("OAUTH_BASE_URL", "");
    vi.stubEnv("NEXT_PUBLIC_BASE_URL", "");
    expect(siteOrigin()).toBe("https://seazn.club");
  });
});
